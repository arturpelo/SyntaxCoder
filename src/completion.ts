import * as vscode from "vscode";
import { getConfig } from "./config";
import { t } from "./i18n";
import { complete, resolveModel } from "./lmStudio";
import { isSecretFile } from "./tools";

// Tyle tekstu wokół kursora idzie do modelu: dość na kontekst, mało na czas odpowiedzi.
// Początek okna przesuwa się skokami co WINDOW_STEP linii, a nie z każdym klawiszem:
// stały początek promptu pozwala LM Studio użyć zapamiętanego przetworzenia (prompt cache).
const PREFIX_LINES = 80;
const WINDOW_STEP = 40;
const PREFIX_CHARS = 8000;
const SUFFIX_CHARS = 1500;
const DEBOUNCE_MS = 300;
const TIMEOUT_MS = 15_000;
const MAX_TOKENS = 128;

// Tokeny FIM (fill-in-the-middle) zależą od rodziny modelu; ostatni wpis (Qwen-Coder) jest domyślny.
const FIM: { match: RegExp; prompt: (pre: string, suf: string) => string; stop: string[] }[] = [
  {
    match: /deepseek/i,
    prompt: (pre, suf) => `<｜fim▁begin｜>${pre}<｜fim▁hole｜>${suf}<｜fim▁end｜>`,
    stop: ["<｜end▁of▁sentence｜>", "<｜fim▁begin｜>"],
  },
  {
    match: /starcoder/i,
    prompt: (pre, suf) => `<fim_prefix>${pre}<fim_suffix>${suf}<fim_middle>`,
    stop: ["<|endoftext|>", "<file_sep>", "<fim_prefix>"],
  },
  {
    match: /code-?llama/i,
    prompt: (pre, suf) => `<PRE> ${pre} <SUF>${suf} <MID>`,
    stop: ["<EOT>"],
  },
  {
    match: /(?:)/,
    prompt: (pre, suf) => `<|fim_prefix|>${pre}<|fim_suffix|>${suf}<|fim_middle|>`,
    stop: ["<|endoftext|>", "<|fim_pad|>", "<|file_sep|>", "<|im_end|>"],
  },
];

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private lastError = "";

  async provideInlineCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    _ctx: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const cfg = getConfig();
    // Pliki z sekretami nie idą do modelu, tak jak w read_file.
    if (!cfg.inlineCompletions || isSecretFile(doc.fileName)) {
      return undefined;
    }
    // Czekamy na przerwę w pisaniu; kolejny klawisz anuluje to wywołanie.
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS));
    if (token.isCancellationRequested) {
      return undefined;
    }

    const startLine = Math.max(0, Math.floor(pos.line / WINDOW_STEP) * WINDOW_STEP - PREFIX_LINES);
    // Bardzo długie linie (np. pliki zminifikowane) tnie twardy limit, kosztem prompt cache.
    const prefix = doc.getText(new vscode.Range(new vscode.Position(startLine, 0), pos)).slice(-PREFIX_CHARS);
    const suffix = doc.getText(new vscode.Range(pos, doc.positionAt(doc.offsetAt(pos) + SUFFIX_CHARS)));
    const abort = new AbortController();
    const sub = token.onCancellationRequested(() => abort.abort());
    try {
      const model = cfg.completionModel || (await resolveModel());
      const fim = FIM.find((f) => f.match.test(model)) ?? FIM[FIM.length - 1];
      const raw = await complete({
        model,
        prompt: fim.prompt(prefix, suffix),
        stop: fim.stop,
        maxTokens: MAX_TOKENS,
        temperature: 0.2,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
      this.lastError = "";
      const text = trimToSuffix(raw, suffix);
      if (!text.trim() || token.isCancellationRequested) {
        return undefined;
      }
      // Model często domyka to, co już stoi za kursorem (np. „)”); wtedy podpowiedź zastępuje resztę linii.
      const line = doc.lineAt(pos);
      const rest = line.text.slice(pos.character).trim();
      const end = rest && text.endsWith(rest) ? line.range.end : pos;
      return [new vscode.InlineCompletionItem(text, new vscode.Range(pos, end))];
    } catch (err) {
      if (!token.isCancellationRequested) {
        this.report(err);
      }
      return undefined;
    } finally {
      sub.dispose();
    }
  }

  // Ten sam błąd pokazujemy raz, a nie przy każdym klawiszu; po udanej podpowiedzi znów można.
  private report(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== this.lastError) {
      this.lastError = message;
      void vscode.window.showWarningMessage(t("hintsFailed", message));
    }
  }
}

// Model często dopisuje też linię, która już stoi za kursorem; ucinamy od niej.
function trimToSuffix(text: string, suffix: string): string {
  // Pierwsza linia sufiksu to reszta bieżącej linii; porównujemy pełne linie z wcięciem.
  const next = suffix.split("\n").slice(1).find((l) => l.trim())?.trimEnd();
  const lines = text.split("\n");
  const cut = next ? lines.findIndex((l, i) => i > 0 && l.trimEnd() === next) : -1;
  return (cut > 0 ? lines.slice(0, cut).join("\n") : text).trimEnd();
}
