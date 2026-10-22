import * as vscode from "vscode";
import { getConfig, workspaceRoot } from "./config";
import { streamChat, type ChatMessage, type ToolCall } from "./lmStudio";
import { t } from "./i18n";
import { executeTool, isProtectedWrite, needsApproval, TOOL_DEFS } from "./tools";

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
// Recenzent tylko czyta: bez zapisu, komend i otwierania edytora.
const REVIEW_TOOLS = TOOL_DEFS.filter(
  (t) => needsApproval(t.function.name) === null && t.function.name !== "open_file"
);

type Who = "agent" | "reviewer";

export function buildSystemPrompt(): string {
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
    "- Do not leave the workspace.",
    "- Reply in the user's language. Be concrete, no filler.",
    "- When the task is done, briefly summarize what you did.",
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
): Promise<{ finished: boolean; changes: string[] }> {
  const changes: string[] = [];
  // Wywołanie + wynik: ten sam klucz drugi raz = model kręci się w miejscu.
  const seen = new Set<string>();
  let nudges = 0;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (opts.signal.aborted) {
      throw new Error(ABORTED);
    }

    const { message } = await streamChat({
      messages,
      tools: who === "reviewer" ? REVIEW_TOOLS : TOOL_DEFS,
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
      return { finished: true, changes };
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
      const kind = needsApproval(name);
      const cfg = getConfig();
      let allowed = true;
      if (who === "reviewer" && kind) {
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
      const result = allowed
        ? await executeTool(name, args)
        : { ok: false, text: who === "reviewer" ? "The reviewer can only read." : "The user rejected this operation." };
      if (result.ok && kind) {
        changes.push(`${name} ${args.slice(0, 400)}`);
      }
      opts.host.post({ type: "toolResult", id: call.id, name, ok: result.ok, preview: result.text.slice(0, 1200) });
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
        return { finished: false, changes };
      }
      nudges++;
      messages.push({ role: "user", content: REPEAT_NUDGE });
    }
  }

  opts.host.post({
    type: "error",
    message: t("tooManyRounds"),
  });
  return { finished: false, changes };
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
  signal: AbortSignal;
  host: AgentHost;
}): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    ...opts.history,
    { role: "user", content: opts.userText },
  ];

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
  return messages.filter((m) => m.role !== "system");

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
