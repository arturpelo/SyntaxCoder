import * as vscode from "vscode";
import { getConfig, workspaceRoot } from "./config";
import { streamChat, type ChatMessage, type ToolCall } from "./lmStudio";
import { executeTool, needsApproval, TOOL_DEFS } from "./tools";

export interface AgentHost {
  post(msg: Record<string, unknown>): void;
  waitApproval(id: string, kind: "write" | "terminal", name: string, args: string): Promise<boolean>;
}

const MAX_TURNS = 16;

export function buildSystemPrompt(): string {
  const root = workspaceRoot() ?? "(brak otwartego folderu)";
  const editors = vscode.window.visibleTextEditors
    .map((e) => vscode.workspace.asRelativePath(e.document.uri))
    .slice(0, 8);
  return [
    "Jesteś SyntaxCoder — asystent programisty w VS Code, podłączony do modelu w LM Studio.",
    "Pracujesz jak Claude Code: najpierw oglądasz kod narzędziami, potem zmieniasz pliki i uruchamiasz komendy.",
    "",
    `Workspace: ${root}`,
    editors.length ? `Otwarte pliki: ${editors.join(", ")}` : "Brak otwartych plików.",
    "",
    "Zasady:",
    "- Używaj narzędzi zamiast zgadywać zawartość plików.",
    "- Twórz pliki narzędziem write_file (zakłada też brakujące foldery nadrzędne).",
    "- Twórz puste foldery narzędziem create_dir.",
    "- Do istniejących plików używaj edit_file (unikalny old_string).",
    "- Po zmianach kodu uruchamiaj testy / kompilację gdy to ma sens.",
    "- Nie wychodź poza workspace.",
    "- Odpowiadaj językiem użytkownika. Bądź konkretny, bez zbędnego wstępu.",
    "- Gdy zadanie jest skończone, krótko podsumuj co zrobiłeś.",
  ].join("\n");
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

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (opts.signal.aborted) {
      throw new Error("Zatrzymano");
    }

    const { message } = await streamChat({
      messages,
      tools: TOOL_DEFS,
      signal: opts.signal,
      onDelta: (ev) => {
        if (ev.content) {
          opts.host.post({ type: "assistantDelta", text: ev.content });
        }
        if (ev.reasoning) {
          opts.host.post({ type: "reasoningDelta", text: ev.reasoning });
        }
      },
    });

    messages.push(message);
    const calls = (message as { tool_calls?: ToolCall[] }).tool_calls ?? [];
    if (!calls.length) {
      opts.host.post({ type: "assistantDone" });
      return messages.filter((m) => m.role !== "system");
    }

    if (message.content) {
      opts.host.post({ type: "assistantDone" });
    }

    for (const call of calls) {
      if (opts.signal.aborted) {
        throw new Error("Zatrzymano");
      }
      const name = call.function.name;
      const args = call.function.arguments || "{}";
      const kind = needsApproval(name);
      const cfg = getConfig();
      let allowed = true;
      if (kind === "write" && !cfg.autoApproveWrites) {
        allowed = await opts.host.waitApproval(call.id, kind, name, args);
      } else if (kind === "terminal" && !cfg.autoApproveTerminal) {
        allowed = await opts.host.waitApproval(call.id, kind, name, args);
      }

      opts.host.post({ type: "toolStart", id: call.id, name, args });
      let result: string;
      if (!allowed) {
        result = "Użytkownik odrzucił tę operację.";
      } else {
        result = await executeTool(name, args);
      }
      opts.host.post({
        type: "toolResult",
        id: call.id,
        name,
        ok: allowed && !result.startsWith("Unknown") && !/^Nie |^Invalid|^TIMEOUT|^Ścieżka/.test(result),
        preview: result.slice(0, 1200),
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  opts.host.post({
    type: "error",
    message: "Zbyt wiele rund narzędzi. Spróbuj węższego polecenia.",
  });
  return messages.filter((m) => m.role !== "system");
}
