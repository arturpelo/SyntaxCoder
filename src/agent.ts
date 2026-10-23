import * as vscode from "vscode";
import { getConfig, workspaceRoot } from "./config";
import { streamChat, type ChatMessage, type ToolCall, type ToolDef } from "./lmStudio";
import { t } from "./i18n";
import { executeTool, isProtectedWrite, needsApproval, TOOL_DEFS, type ToolResult } from "./tools";

export interface AgentHost {
  post(msg: Record<string, unknown>): void;
  waitApproval(id: string, kind: "write" | "terminal", name: string, args: string): Promise<boolean>;
}

export const ABORTED = "aborted";
const MAX_TURNS = 24;
const MAX_FIX_ROUNDS = 4;
// Ile razy szturchamy model, który powtarza te same wywołania z tym samym wynikiem, zanim przerwiemy.
const MAX_NUDGES = 2;
const REPEAT_NUDGE =
  "You repeated a tool call you already made and got the same result. Repeating it will not help. " +
  "Read the error again, check the current file contents, and try a different approach. " +
  "If the task is really blocked, stop calling tools and explain exactly what blocks it.";
const NO_CHANGE_NUDGE =
  "You changed nothing, so the reviewer's gaps are still there. Use the tools to fix them now, " +
  "or explain exactly why a gap cannot be fixed.";
const PLAN_NUDGE =
  "You did not save a plan. If the request needs changes, save the plan with update_plan now. " +
  "If it is only a question, do not call tools and say in one sentence that no plan is needed.";
const READ_TOOLS = TOOL_DEFS.filter((t) => needsApproval(t.function.name) === null);
// Recenzent tylko czyta: bez zapisu, komend i otwierania edytora.
const REVIEW_TOOLS = READ_TOOLS.filter((t) => t.function.name !== "open_file");

export type PlanStatus = "pending" | "in_progress" | "done";
export interface PlanStep {
  step: string;
  status: PlanStatus;
}
const PLAN_STATUSES: PlanStatus[] = ["pending", "in_progress", "done"];
const MAX_PLAN_STEPS = 30;

// update_plan nie dotyka plików: plan żyje w rozmowie, a czat pokazuje go jako listę kroków.
const PLAN_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "update_plan",
    description:
      "Save the task plan. The user sees it as a checklist. Send the whole list every time you change a status or a step.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              step: { type: "string", description: "One concrete step: which file and what changes" },
              status: { type: "string", enum: PLAN_STATUSES },
            },
            required: ["step", "status"],
          },
        },
      },
      required: ["steps"],
    },
  },
};

// planner = tryb planu: tylko odczyt i update_plan, zmiany trafiają do planu.
type Who = "agent" | "planner" | "reviewer";
const TOOLS: Record<Who, ToolDef[]> = {
  agent: [...TOOL_DEFS, PLAN_TOOL],
  planner: [...READ_TOOLS, PLAN_TOOL],
  reviewer: REVIEW_TOOLS,
};
// Odpowiedź dla modelu, który bez prawa zapisu sięga po zapis albo komendę.
const READ_ONLY: Partial<Record<Who, string>> = {
  planner: "Plan mode: you can only read. Put this change in the plan with update_plan.",
  reviewer: "The reviewer can only read.",
};

const PLAN_MODE_RULES = [
  "",
  "PLAN MODE is on. It overrides the rules above: do not change files and do not run commands.",
  "- Read the code the request is about with the read-only tools.",
  "- Save the plan with update_plan: concrete steps (which file, what changes), all with status pending.",
  "- Then reply with a short summary of the plan and the questions the user must decide.",
  "- The user approves the plan or asks for changes. For changes, save the new plan with update_plan.",
  "- If the request is only a question, answer it without a plan.",
];

export function buildSystemPrompt(planMode = false): string {
  const root = workspaceRoot() ?? "(no folder open)";
  const editors = vscode.window.visibleTextEditors
    .map((e) => vscode.workspace.asRelativePath(e.document.uri))
    .slice(0, 8);
  return [
    "You are SyntaxCoder, a coding assistant in VS Code connected to a model in LM Studio.",
    "Work as an agent: first look at the code with tools, then change files and run commands.",
    "",
    `Workspace: ${root}`,
    editors.length ? `Open files: ${editors.join(", ")}` : "No open files.",
    "",
    "Rules:",
    "- Use tools instead of guessing file contents.",
    "- Create files with write_file (it also creates missing parent folders).",
    "- Create empty folders with create_dir.",
    "- Change existing files with edit_file (unique old_string).",
    "- Move files and folders with move_path and delete them with delete_path (not rm/mv commands).",
    "- After code changes, check errors with get_diagnostics; run tests / the build when it makes sense.",
    "- For a task with several steps, keep a plan with update_plan: mark a step in_progress before you start it and done when it is finished. Skip it for small tasks and questions.",
    "- Do not leave the workspace.",
    "- Reply in the user's language. Be concrete, no filler.",
    "- When the task is done, briefly summarize what you did.",
    ...(planMode ? PLAN_MODE_RULES : []),
  ].join("\n");
}

function parsePlan(rawArgs: string): PlanStep[] {
  const steps = (JSON.parse(rawArgs) as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_PLAN_STEPS) {
    throw new Error(`steps must be a list of 1-${MAX_PLAN_STEPS} items.`);
  }
  return steps.map((s: { step?: unknown; status?: unknown } | null) => {
    const step = typeof s?.step === "string" ? s.step.trim() : "";
    if (!step) {
      throw new Error("Every step needs a non-empty step text.");
    }
    return { step: step.slice(0, 300), status: PLAN_STATUSES.find((v) => v === s?.status) ?? "pending" };
  });
}

// Polecenie po kliknięciu „Wykonaj plan”. Recenzent dostaje je jako prośbę użytkownika, więc sprawdza każdy krok.
export function approvedPlanPrompt(plan: PlanStep[]): string {
  return [
    "The user approved this plan. Carry it out now, step by step.",
    "Before each step mark it in_progress with update_plan, and mark it done when it is finished.",
    "If a step turns out wrong or impossible, change the plan with update_plan and say why.",
    "",
    "Plan:",
    ...plan.map((s, i) => `${i + 1}. ${s.step}`),
  ].join("\n");
}

function reviewerPrompt(): string {
  const root = workspaceRoot() ?? "(no folder open)";
  return [
    "You are the reviewer in SyntaxCoder. You check whether the agent really did the user's task.",
    `Workspace: ${root}`,
    "",
    "Rules:",
    "- You only have read-only tools. Do not trust the agent's summary: open the files the task is about and check their contents.",
    "- Check every requirement from the request separately. Use get_diagnostics for changed code.",
    "- Do not judge style or things the user did not ask for.",
    "- Be brief and reply in the user's language.",
    "- If something is missing, list it: the file and what exactly is missing.",
    "- The last line MUST be exactly: VERDICT: OK or VERDICT: FAIL",
  ].join("\n");
}

// Jedna pętla model → narzędzia → model. Zwraca wykonane zmiany (zapis, komendy).
async function loop(
  messages: ChatMessage[],
  who: Who,
  opts: { signal: AbortSignal; host: AgentHost }
): Promise<{ finished: boolean; changes: string[]; plan?: PlanStep[] }> {
  const changes: string[] = [];
  let plan: PlanStep[] | undefined;
  // Wywołanie + wynik: ten sam klucz drugi raz = model kręci się w miejscu.
  const seen = new Set<string>();
  let nudges = 0;
  // Plan nie dostaje karty narzędzia: czat pokazuje go jako listę kroków.
  const savePlan = (args: string): ToolResult => {
    try {
      plan = parsePlan(args);
    } catch (err) {
      return { ok: false, text: `Plan not saved: ${err instanceof Error ? err.message : String(err)}` };
    }
    opts.host.post({ type: "plan", steps: plan });
    return { ok: true, text: "Plan saved." };
  };
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (opts.signal.aborted) {
      throw new Error(ABORTED);
    }

    const { message } = await streamChat({
      messages,
      tools: TOOLS[who],
      signal: opts.signal,
      onDelta: (ev) => {
        if (ev.content) {
          opts.host.post({ type: "assistantDelta", text: ev.content, who });
        }
        if (ev.reasoning) {
          opts.host.post({ type: "reasoningDelta", text: ev.reasoning, who });
        }
      },
    });

    messages.push(message);
    const calls = (message as { tool_calls?: ToolCall[] }).tool_calls ?? [];
    if (!calls.length) {
      opts.host.post({ type: "assistantDone" });
      return { finished: true, changes, plan };
    }

    if (message.content) {
      opts.host.post({ type: "assistantDone" });
    }

    let repeated = true;
    for (const call of calls) {
      if (opts.signal.aborted) {
        throw new Error(ABORTED);
      }
      const name = call.function.name;
      const args = call.function.arguments || "{}";
      let result: ToolResult;
      if (name === PLAN_TOOL.function.name && TOOLS[who].includes(PLAN_TOOL)) {
        result = savePlan(args);
      } else {
        const kind = needsApproval(name);
        const readOnly = READ_ONLY[who];
        const cfg = getConfig();
        let allowed = true;
        if (readOnly && kind) {
          allowed = false;
        } else if (!cfg.autonomousMode) {
          // W trybie autonomicznym wszystkie operacje są automatycznie zatwierdzane
          if (kind === "write" && (!cfg.autoApproveWrites || isProtectedWrite(args))) {
            allowed = await opts.host.waitApproval(call.id, kind, name, args);
          } else if (kind === "terminal" && !cfg.autoApproveTerminal) {
            allowed = await opts.host.waitApproval(call.id, kind, name, args);
          }
        }

        opts.host.post({ type: "toolStart", id: call.id, name, args });
        result = allowed
          ? await executeTool(name, args)
          : { ok: false, text: readOnly ?? "The user rejected this operation." };
        if (result.ok && kind) {
          changes.push(`${name} ${args.slice(0, 400)}`);
        }
        opts.host.post({ type: "toolResult", id: call.id, name, ok: result.ok, preview: result.text.slice(0, 1200) });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result.text });
      const key = `${name}\u0000${args}\u0000${result.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        repeated = false;
      }
    }

    if (repeated) {
      if (nudges >= MAX_NUDGES) {
        opts.host.post({ type: "error", message: t("agentStuck") });
        return { finished: false, changes, plan };
      }
      nudges++;
      messages.push({ role: "user", content: REPEAT_NUDGE });
    }
  }

  opts.host.post({
    type: "error",
    message: t("tooManyRounds"),
  });
  return { finished: false, changes, plan };
}

function lastText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.content) {
      return m.content;
    }
  }
  return "";
}

export function parseVerdict(text: string): "ok" | "fail" | "unknown" {
  const all = [...text.matchAll(/VERDICT:\s*\**\s*(OK|FAIL)\b/gi)];
  if (!all.length) {
    return "unknown";
  }
  return all[all.length - 1][1].toUpperCase() === "OK" ? "ok" : "fail";
}

async function review(
  userText: string,
  changes: string[],
  agentSummary: string,
  opts: { signal: AbortSignal; host: AgentHost }
): Promise<{ verdict: "ok" | "fail" | "unknown"; text: string }> {
  const messages: ChatMessage[] = [
    { role: "system", content: reviewerPrompt() },
    {
      role: "user",
      content: [
        "User request:",
        userText,
        "",
        "Changes made by the agent (tool + arguments):",
        ...changes.map((c) => `- ${c}`),
        "",
        "Agent's last answer:",
        agentSummary || "(none)",
        "",
        "Check in the files whether the request was done.",
      ].join("\n"),
    },
  ];
  const res = await loop(messages, "reviewer", opts);
  const text = lastText(messages);
  return { verdict: res.finished ? parseVerdict(text) : "unknown", text };
}

export async function runAgent(opts: {
  history: ChatMessage[];
  userText: string;
  planMode: boolean;
  signal: AbortSignal;
  host: AgentHost;
}): Promise<{ history: ChatMessage[]; plan?: PlanStep[] }> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(opts.planMode) },
    ...opts.history,
    { role: "user", content: opts.userText },
  ];

  // Tryb planu nic nie zmienia, więc bez recenzji; zapisany plan czeka na zgodę użytkownika.
  if (opts.planMode) {
    let planned = await loop(messages, "planner", opts);
    // Model, który opisał plan tylko tekstem, dostaje jedno przypomnienie o update_plan.
    if (planned.finished && !planned.plan) {
      messages.push({ role: "user", content: PLAN_NUDGE });
      planned = await loop(messages, "planner", opts);
    }
    return { history: messages.filter((m) => m.role !== "system"), plan: planned.plan };
  }

  let res = await loop(messages, "agent", opts);
  const changes = [...res.changes];

  // Recenzja tylko gdy agent coś zmienił; pytania bez zmian jej nie potrzebują.
  // Błąd lub Stop w recenzji nie kasuje skończonej pracy: historia wraca do ostatniego pełnego stanu.
  let safe = messages.length;
  if (getConfig().reviewer && res.finished && changes.length) {
    try {
      await reviewRounds();
    } catch (err) {
      messages.length = safe;
      opts.host.post({
        type: "error",
        message: opts.signal.aborted
          ? t("reviewStopped")
          : t("reviewFailed", err instanceof Error ? err.message : String(err)),
      });
    }
  }
  return { history: messages.filter((m) => m.role !== "system") };

  async function reviewRounds(): Promise<void> {
    for (let round = 1; ; round++) {
      opts.host.post({ type: "reviewStart", round });
      const r = await review(opts.userText, changes, lastText(messages), opts);
      const fixing = r.verdict === "fail" && round <= MAX_FIX_ROUNDS;
      opts.host.post({ type: "reviewEnd", verdict: r.verdict, round, fixing, maxRounds: MAX_FIX_ROUNDS });
      if (!fixing) {
        break;
      }
      messages.push({
        role: "user",
        content: `The reviewer checked the files and found gaps:\n${r.text}\n\nFix only these gaps. Do not change what already works.`,
      });
      res = await loop(messages, "agent", opts);
      changes.push(...res.changes);
      // Agent skończył bez żadnej zmiany: jeden szturchaniec, zanim recenzent znów powie FAIL.
      if (res.finished && !res.changes.length) {
        messages.push({ role: "user", content: NO_CHANGE_NUDGE });
        res = await loop(messages, "agent", opts);
        changes.push(...res.changes);
      }
      if (!res.finished) {
        break;
      }
      safe = messages.length;
    }
  }
}
