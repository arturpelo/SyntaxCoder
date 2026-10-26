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
// Zapas na cały blok z zagnieżdżeniami; zwykle strumień kończy się wcześniej, na domknięciu bloku.
const TIMEOUT_MS = 20_000;
const MAX_TOKENS = 512;
// Tyle tekstu przed zapamiętaną podpowiedzią musi się zgadzać, żeby uznać, że to to samo miejsce.
const ANCHOR_CHARS = 200;
// Jak w Copilocie: w środku linii pytamy tylko, gdy za kursorem stoją same spacje i nawiasy zamykające.
const REST_OK = /^[\s)\]}>;,'"`]*$/;
// Python: te nagłówki ciągną blok dalej, a nie zaczynają nowego.
const CONTINUES = /^(elif|else|except|finally|case)\b/;
// Komentarz liniowy według języka; domyślnie // razem z blokowym /* */ (C, C++, JS, TS, Java, Go, Rust…).
const LINE_COMMENT: Record<string, string> = {
  python: "#",
  ruby: "#",
  shellscript: "#",
  perl: "#",
  r: "#",
  yaml: "#",
  toml: "#",
  makefile: "#",
  dockerfile: "#",
  powershell: "#",
  coffeescript: "#",
  elixir: "#",
  julia: "#",
  nim: "#",
  lua: "--",
  sql: "--",
  haskell: "--",
};

// Składnia do liczenia bloków: znacznik komentarza i, w Pythonie, tekst przed kursorem w tej linii (wcięcie).
interface Syntax {
  comment: string;
  head?: string;
}
// Kontekst z innych plików (jak w Copilocie): z każdego otwartego pliku w tym samym języku
// najbardziej podobne okno SNIPPET_LINES linii do QUERY_LINES linii przed kursorem.
const SNIPPET_LINES = 60;
const SNIPPET_STEP = 30;
const QUERY_LINES = 30;
const MAX_SNIPPETS = 3;
const SNIPPETS_CHARS = 3000;
const MIN_SIMILARITY = 0.1;
const MAX_FILE_CHARS = 500_000;
// Języki, których pliki widzą się nawzajem (np. nagłówek .h i plik .cpp).
const FAMILY: Record<string, string> = {
  c: "c",
  cpp: "c",
  "cuda-cpp": "c",
  javascript: "js",
  javascriptreact: "js",
  typescript: "js",
  typescriptreact: "js",
};

interface Context {
  repo: string;
  path: string;
  files: { path: string; text: string }[];
}

// Tokeny FIM (fill-in-the-middle) zależą od rodziny modelu; ostatni wpis (Qwen-Coder) jest domyślny.
// Kontekst z innych plików dostaje tylko Qwen, w swoim formacie repozytorium (<|repo_name|>, <|file_sep|>).
const FIM: { match: RegExp; prompt: (pre: string, suf: string, ctx: Context) => string; stop: string[] }[] = [
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
    prompt: (pre, suf, ctx) =>
      `<|repo_name|>${ctx.repo}\n` +
      ctx.files.map((f) => `<|file_sep|>${f.path}\n${f.text}\n`).join("") +
      `<|file_sep|>${ctx.path}\n<|fim_prefix|>${pre}<|fim_suffix|>${suf}<|fim_middle|>`,
    stop: ["<|endoftext|>", "<|fim_pad|>", "<|file_sep|>", "<|im_end|>"],
  },
];

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private lastError = "";
  // Ostatnia podpowiedź: gdzie się zaczyna, co proponuje i tekst tuż przed nią (anchor).
  private last?: { uri: string; start: number; anchor: string; text: string };
  // Fragmenty innych plików liczymy raz na blok WINDOW_STEP linii: stały początek promptu = prompt cache.
  private snippets?: { key: string; files: Context["files"] };

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
    const line = doc.lineAt(pos);
    if (!REST_OK.test(line.text.slice(pos.character))) {
      return undefined;
    }
    // Piszesz dokładnie to, co już podpowiedzieliśmy: reszta od razu, bez nowego zapytania.
    const ahead = this.ahead(doc, pos);
    if (ahead) {
      return [item(doc, pos, ahead)];
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
    // Komentarze zależą od języka; w Pythonie blok wyznacza wcięcie, więc liczy się też tekst przed kursorem.
    const syntax: Syntax = {
      comment: LINE_COMMENT[doc.languageId] ?? "//",
      head: doc.languageId === "python" ? line.text.slice(0, pos.character) : undefined,
    };
    const abort = new AbortController();
    const sub = token.onCancellationRequested(() => abort.abort());
    try {
      const model = cfg.completionModel || (await resolveModel());
      const fim = FIM.find((f) => f.match.test(model)) ?? FIM[FIM.length - 1];
      const ctx: Context = {
        repo: vscode.workspace.name ?? "workspace",
        path: vscode.workspace.asRelativePath(doc.uri),
        files: this.similar(doc, pos, startLine),
      };
      const res = await complete({
        model,
        prompt: fim.prompt(prefix, suffix, ctx),
        stop: fim.stop,
        maxTokens: MAX_TOKENS,
        temperature: 0.2,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(TIMEOUT_MS)]),
        done: (text) => blockEnd(text, syntax, false).end !== undefined,
      });
      this.lastError = "";
      // Urwane limitem tokenów: ostatnia linia może być niepełna.
      const raw = res.truncated ? res.text.slice(0, res.text.lastIndexOf("\n") + 1) : res.text;
      const text = wholeBlocks(trimToSuffix(raw, suffix), syntax);
      if (!text.trim() || isJunk(text, suffix) || token.isCancellationRequested) {
        return undefined;
      }
      const start = doc.offsetAt(pos);
      this.last = { uri: doc.uri.toString(), start, anchor: anchorAt(doc, start), text };
      return [item(doc, pos, text)];
    } catch (err) {
      if (!token.isCancellationRequested) {
        this.report(err);
      }
      return undefined;
    } finally {
      sub.dispose();
    }
  }

  // Reszta ostatniej podpowiedzi, jeśli od jej początku wpisano dokładnie jej początek.
  private ahead(doc: vscode.TextDocument, pos: vscode.Position): string | undefined {
    const last = this.last;
    const offset = doc.offsetAt(pos);
    if (!last || last.uri !== doc.uri.toString() || offset < last.start) {
      return undefined;
    }
    const typed = doc.getText(new vscode.Range(doc.positionAt(last.start), pos));
    if (!last.text.startsWith(typed) || typed.length >= last.text.length || anchorAt(doc, last.start) !== last.anchor) {
      return undefined;
    }
    return last.text.slice(typed.length);
  }

  // Najbardziej podobne fragmenty innych otwartych plików w tym samym języku (bez plików z sekretami),
  // w stałej kolejności. Liczone od nowa dopiero po zmianie bloku linii albo innych plików.
  private similar(doc: vscode.TextDocument, pos: vscode.Position, startLine: number): Context["files"] {
    const family = (id: string) => FAMILY[id] ?? id;
    const self = doc.uri.toString();
    const others = vscode.workspace.textDocuments.filter(
      (d) =>
        d.uri.toString() !== self &&
        d.uri.scheme === "file" &&
        family(d.languageId) === family(doc.languageId) &&
        !isSecretFile(d.fileName)
    );
    const key = [self, startLine, ...others.map((d) => `${d.uri.toString()}@${d.version}`)].join("|");
    if (this.snippets?.key === key) {
      return this.snippets.files;
    }
    const query = words(doc.getText(new vscode.Range(new vscode.Position(Math.max(0, pos.line - QUERY_LINES), 0), pos)));
    const found: { score: number; path: string; text: string }[] = [];
    for (const other of others) {
      const text = other.getText();
      if (text.length > MAX_FILE_CHARS) {
        continue;
      }
      const lines = text.split("\n");
      let best = { score: 0, from: 0 };
      for (let from = 0; from < lines.length; from += SNIPPET_STEP) {
        const score = jaccard(query, words(lines.slice(from, from + SNIPPET_LINES).join("\n")));
        if (score > best.score) {
          best = { score, from };
        }
      }
      if (best.score >= MIN_SIMILARITY) {
        const path = vscode.workspace.asRelativePath(other.uri);
        found.push({ score: best.score, path, text: lines.slice(best.from, best.from + SNIPPET_LINES).join("\n") });
      }
    }
    const files: Context["files"] = [];
    let budget = SNIPPETS_CHARS;
    for (const f of found.sort((a, b) => b.score - a.score).slice(0, MAX_SNIPPETS)) {
      // Okno z długimi liniami skracamy od końca, żeby zmieściło się w budżecie.
      const lines = f.text.split("\n");
      while (lines.length && lines.join("\n").length > budget) {
        lines.pop();
      }
      if (!lines.length) {
        break;
      }
      const text = lines.join("\n");
      budget -= text.length;
      files.push({ path: f.path, text });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    this.snippets = { key, files };
    return files;
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

function words(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_]\w+/g));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let common = 0;
  for (const w of a) {
    if (b.has(w)) {
      common++;
    }
  }
  const all = a.size + b.size - common;
  return all ? common / all : 0;
}

function anchorAt(doc: vscode.TextDocument, offset: number): string {
  return doc.getText(new vscode.Range(doc.positionAt(Math.max(0, offset - ANCHOR_CHARS)), doc.positionAt(offset)));
}

// Model często domyka to, co już stoi za kursorem (np. „)”); wtedy podpowiedź zastępuje resztę linii.
function item(doc: vscode.TextDocument, pos: vscode.Position, text: string): vscode.InlineCompletionItem {
  const line = doc.lineAt(pos);
  const rest = line.text.slice(pos.character).trim();
  const end = rest && text.endsWith(rest) ? line.range.end : pos;
  return new vscode.InlineCompletionItem(text, new vscode.Range(pos, end));
}

// Model często dopisuje też linię, która już stoi za kursorem; ucinamy od niej.
function trimToSuffix(text: string, suffix: string): string {
  // Pierwsza linia sufiksu to reszta bieżącej linii; porównujemy pełne linie z wcięciem.
  const next = suffix.split("\n").slice(1).find((l) => l.trim())?.trimEnd();
  const lines = text.split("\n");
  const cut = next ? lines.findIndex((l, i) => i > 0 && l.trimEnd() === next) : -1;
  return (cut > 0 ? lines.slice(0, cut).join("\n") : text).trimEnd();
}

// Śmieci jak w Copilocie: dokładnie to, co już stoi za kursorem, albo powtarzana linia lub fraza.
function isJunk(text: string, suffix: string): boolean {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  if (flat(suffix).startsWith(flat(text))) {
    return true;
  }
  // Same nawiasy (np. „}” przy zamykaniu zagnieżdżonych bloków) mogą się powtarzać.
  const lines = text.split("\n").map((l) => l.trim());
  if (lines.some((l, i) => /\w/.test(l) && l === lines[i + 1] && l === lines[i + 2])) {
    return true;
  }
  return /\b(\w[^\n]{2,}?)\1{3,}/.test(text);
}

// Podpowiedź kończy się na domkniętym bloku, jak w Copilocie, i nigdy nie zostawia otwartego bloku.
function wholeBlocks(text: string, syntax: Syntax): string {
  const { end, safe } = blockEnd(text, syntax, true);
  let out = text.slice(0, end ?? safe).trimEnd();
  // Python: nagłówek bez ciała na końcu (np. „for x in y:”) odpada.
  while (syntax.head !== undefined && out && isHeader(out.slice(out.lastIndexOf("\n") + 1))) {
    out = out.slice(0, Math.max(0, out.lastIndexOf("\n"))).trimEnd();
  }
  return out;
}

// end: koniec pierwszego domkniętego bloku (nawiasy, a w Pythonie też wcięcia).
// safe: koniec ostatniej linii bez otwartych nawiasów.
// final: tekst jest kompletny; w trakcie strumienia ostatnia linia może być jeszcze niepełna.
function blockEnd(text: string, syntax: Syntax, final: boolean): { end?: number; safe: number } {
  const scan = scanBlocks(text, syntax.comment);
  const indent = syntax.head === undefined ? undefined : indentBlockEnd(text, syntax.head, final, scan.balanced);
  const ends = [scan.blockEnd, indent].filter((e): e is number => e !== undefined);
  return { end: ends.length ? Math.min(...ends) : undefined, safe: scan.safeEnd };
}

// Nawiasy otwarte w samej podpowiedzi; napisy i komentarze pomijamy.
// blockEnd: koniec linii, w której zamknął się pierwszy wieloliniowy blok { } albo blok, w którym stoi kursor.
// safeEnd: koniec ostatniej linii bez otwartych nawiasów; dalej podpowiedź urwałaby blok w połowie.
// balanced: końce linii (indeksy "\n"), po których nie ma otwartych nawiasów.
function scanBlocks(text: string, comment: string): { blockEnd?: number; safeEnd: number; balanced: Set<number> } {
  const stack: number[] = []; // linia, w której otwarto nawias
  const balanced = new Set<number>();
  let line = 0;
  let closedBlock = false;
  let blockEnd: number | undefined;
  let safeEnd = 0;
  let cutShort = false; // tekst kończy się w środku napisu albo komentarza
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") {
      if (!stack.length) {
        balanced.add(i);
        safeEnd = i;
        if (closedBlock && blockEnd === undefined) {
          blockEnd = i;
        }
      }
      line++;
    } else if (text.startsWith(comment, i)) {
      const nl = text.indexOf("\n", i);
      if (nl < 0) {
        break;
      }
      i = nl - 1;
    } else if (comment === "//" && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) {
        cutShort = true;
        break;
      }
      line += newlines(text.slice(i, end));
      i = end + 1;
    } else if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      // Potrójne cudzysłowy (Python, Kotlin, Java, C#): napis może mieć wiele linii.
      const end = text.indexOf(text.slice(i, i + 3), i + 3);
      if (end < 0) {
        cutShort = true;
        break;
      }
      line += newlines(text.slice(i, end));
      i = end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      // Napis w " i ' kończy się najpóźniej z linią (np. apostrof w tekście); ` może mieć wiele linii.
      let j = i + 1;
      while (j < text.length && text[j] !== c && (c === "`" || text[j] !== "\n")) {
        j += text[j] === "\\" ? 2 : 1;
      }
      if (j >= text.length) {
        cutShort = true;
        break;
      }
      if (text[j] === "\n") {
        i = j - 1;
        continue;
      }
      line += newlines(text.slice(i, j));
      i = j;
    } else if ("([{".includes(c)) {
      stack.push(line);
    } else if (")]}".includes(c)) {
      const top = stack.pop();
      if (c === "}" && (top === undefined || top < line)) {
        closedBlock = true;
      }
    }
  }
  return { blockEnd, safeEnd: cutShort || stack.length ? safeEnd : text.length, balanced };
}

// Python: blok wyznacza wcięcie. Podpowiedź kończy się przed linią, która wychodzi z bloku kursora
// albo kończy pierwszy pełny blok (nagłówek z „:” i jego ciało). Liczą się tylko linie poza nawiasami.
function indentBlockEnd(text: string, head: string, final: boolean, balanced: Set<number>): number | undefined {
  const lines = text.split("\n");
  const base = indentOf(head + lines[0]);
  let header = isHeader(head + lines[0]) ? base : undefined; // nagłówek czekający na ciało
  let block: number | undefined; // wcięcie nagłówka pierwszego bloku z ciałem
  let nl = lines[0].length; // indeks "\n" przed linią i
  const count = final ? lines.length : lines.length - 1;
  for (let i = 1; i < count; i++) {
    const l = lines[i];
    if (l.trim() && balanced.has(nl)) {
      const ind = indentOf(l);
      if (ind < base || (block !== undefined && ind <= block && !CONTINUES.test(l.trimStart()))) {
        return nl;
      }
      if (block === undefined) {
        if (header !== undefined && ind > header) {
          block = header;
        } else {
          header = isHeader(l) ? ind : undefined;
        }
      }
    }
    nl += l.length + 1;
  }
  return undefined;
}

function isHeader(line: string): boolean {
  return line.replace(/#.*$/, "").trimEnd().endsWith(":");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function newlines(s: string): number {
  return s.split("\n").length - 1;
}
