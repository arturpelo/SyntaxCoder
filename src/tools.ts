import * as fs from "fs/promises";
import { realpathSync } from "fs";
import * as path from "path";
import { spawn } from "child_process";
import * as vscode from "vscode";
import { getConfig, workspaceRoot } from "./config";
import type { ToolDef } from "./lmStudio";

const SKIP = new Set([
  "node_modules",
  ".git",
  "out",
  "dist",
  ".vscode-test",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".cache",
  ".turbo",
  ".DS_Store",
  ".idea",
  ".gradle",
  ".terraform",
  ".yarn",
  ".pnpm-store",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".svelte-kit",
  ".nuxt",
  ".angular",
  ".parcel-cache",
  ".svn",
  ".hg",
]);
// Pliki z sekretami: grep ani read_file ich nie czytają, żeby klucze nie trafiały do modelu.
const SECRET = /^(\.env(\..+)?|\.npmrc|\.pypirc|\.netrc|.+\.(pem|key|p12|pfx))$/i;
const SECRET_OK = /\.(example|sample|template|dist)$/i;
const MAX_READ = 400_000;
const MAX_LIST = 400;
const MAX_OUT = 80_000;

export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the workspace. Use offset/limit for large files (1-based lines).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to workspace root" },
          offset: { type: "integer", description: "Start line (1-based)" },
          limit: { type: "integer", description: "Number of lines" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a new file (including missing parent folders) or overwrite an existing file. Prefer edit_file for small changes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_dir",
      description: "Create a folder (and parent folders) in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to workspace root" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace an exact unique substring in a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_path",
      description: "Move or rename a file or folder inside the workspace. Fails if the target exists.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Source path relative to workspace root" },
          to: { type: "string", description: "Target path relative to workspace root" },
        },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_path",
      description: "Delete a file or folder (recursively) in the workspace. It goes to the system trash when possible.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to workspace root" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and folders in a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory relative to workspace. Empty = root." },
          recursive: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files by glob-like pattern, e.g. **/*.ts or src/**/*.json",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "Search root, default workspace" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with a regular expression.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string", description: "Optional file filter, e.g. *.ts" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command in the workspace (build, tests, scripts). Output is captured and also shown in the SyntaxCoder output panel.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string", description: "Working directory relative to workspace" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_diagnostics",
      description:
        "Get errors and warnings from the VS Code Problems panel (compiler, linter). Covers files the language servers have analyzed, usually open files. Use after editing code.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional file or folder filter relative to workspace" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_file",
      description: "Open a file in the VS Code editor.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
];

export function needsApproval(name: string): "write" | "terminal" | null {
  if (["write_file", "edit_file", "create_dir", "move_path", "delete_path"].includes(name)) {
    return "write";
  }
  if (name === "run_command") {
    return "terminal";
  }
  return null;
}

export interface ToolResult {
  ok: boolean;
  text: string;
}

// Narzędzia zwracają tekst przy sukcesie i rzucają błąd przy porażce.
export async function executeTool(name: string, rawArgs: string): Promise<ToolResult> {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return { ok: false, text: `Invalid JSON arguments: ${rawArgs}` };
  }
  try {
    return { ok: true, text: await runTool(name, args) };
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) };
  }
}

async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "read_file":
      return await readFile(str(args.path), num(args.offset), num(args.limit));
    case "write_file":
      return await writeFile(str(args.path), str(args.content));
    case "create_dir":
      return await createDir(str(args.path));
    case "edit_file":
      return await editFile(str(args.path), str(args.old_string), str(args.new_string));
    case "move_path":
      return await movePath(str(args.from), str(args.to));
    case "delete_path":
      return await deletePath(str(args.path));
    case "get_diagnostics":
      return getDiagnostics(str(args.path));
    case "list_dir":
      return await listDir(str(args.path) || ".", Boolean(args.recursive));
    case "glob":
      return await globFiles(str(args.pattern), str(args.path) || ".");
    case "grep":
      return await grep(str(args.pattern), str(args.path) || ".", str(args.glob));
    case "run_command":
      return await runCommand(str(args.command), str(args.cwd) || ".");
    case "open_file":
      return await openFile(str(args.path));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function requireRoot(): string {
  const root = workspaceRoot();
  if (!root) {
    throw new Error("Open a folder in VS Code (File → Open Folder) to work with files.");
  }
  return root;
}

function isInside(root: string, abs: string): boolean {
  const r = path.relative(root, abs);
  return r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r);
}

// Prawdziwa ścieżka najbliższego istniejącego przodka + reszta (plik może jeszcze nie istnieć).
function realExisting(p: string): string {
  for (let cur = p; ; ) {
    try {
      return path.join(realpathSync.native(cur), path.relative(cur, p));
    } catch {
      const up = path.dirname(cur);
      if (up === cur) {
        return p;
      }
      cur = up;
    }
  }
}

export function resolveInWorkspace(rel: string): string {
  const root = requireRoot();
  const cleaned = rel.replace(/\\/g, "/");
  const abs = path.resolve(root, cleaned);
  // Drugi test po rozwinięciu dowiązań: symlink/junction w repo nie wyprowadzi poza workspace.
  if (!isInside(root, abs) || !isInside(realExisting(root), realExisting(abs))) {
    throw new Error(`Path outside the workspace: ${rel}`);
  }
  return abs;
}

// Zapis tu daje wykonanie kodu bez pytania o terminal (hooki gita, zadania i ustawienia VS Code),
// więc takie zmiany zawsze wymagają zgody, nawet przy autoApproveWrites.
const PROTECTED_DIRS = new Set([".git", ".vscode", ".devcontainer", ".husky"]);

export function isProtectedWrite(rawArgs: string): boolean {
  const root = workspaceRoot();
  if (!root) {
    return false;
  }
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
  } catch {
    return true;
  }
  return [args.path, args.from, args.to].some((p) => {
    if (typeof p !== "string") {
      return false;
    }
    const first = path.relative(root, path.resolve(root, p.replace(/\\/g, "/"))).split(path.sep)[0];
    return PROTECTED_DIRS.has(first.toLowerCase());
  });
}

export function isSecretFile(abs: string): boolean {
  const name = path.basename(abs);
  return SECRET.test(name) && !SECRET_OK.test(name);
}

async function readFile(rel: string, offset?: number, limit?: number): Promise<string> {
  const abs = resolveInWorkspace(rel);
  if (isSecretFile(abs)) {
    throw new Error(`${rel} holds secrets and is not sent to the model. Ask the user for the values you need.`);
  }
  const buf = await fs.readFile(abs);
  if (buf.length > MAX_READ * 4) {
    throw new Error(`File too large (${buf.length} B). Read it in parts (offset/limit).`);
  }
  let text = buf.toString("utf8");
  if (text.includes("\u0000")) {
    throw new Error("This looks like a binary file — not reading it.");
  }
  const lines = text.split(/\r?\n/);
  if (offset || limit) {
    const start = Math.max(1, offset ?? 1);
    const end = limit ? start + limit - 1 : lines.length;
    const slice = lines.slice(start - 1, end);
    text = slice.map((l, i) => `${String(start + i).padStart(5)}|${l}`).join("\n");
    return `${rel} lines ${start}-${Math.min(end, lines.length)} / ${lines.length}\n${text}`;
  }
  if (text.length > MAX_READ) {
    text = text.slice(0, MAX_READ) + "\n… [truncated]";
  }
  return `${rel} (${lines.length} lines)\n${text}`;
}

async function createDir(rel: string): Promise<string> {
  if (!rel.trim() || rel.trim() === ".") {
    throw new Error("Give a folder path relative to the workspace.");
  }
  const abs = resolveInWorkspace(rel);
  await fs.mkdir(abs, { recursive: true });
  return `Created folder ${rel.replace(/\\/g, "/")}`;
}

async function writeFile(rel: string, content: string): Promise<string> {
  const abs = resolveInWorkspace(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
  if (doc) {
    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(doc.uri, full, content);
    await vscode.workspace.applyEdit(edit);
  }
  return `Wrote ${rel} (${content.length} chars)`;
}

async function editFile(rel: string, oldStr: string, newStr: string): Promise<string> {
  const abs = resolveInWorkspace(rel);
  const current = await fs.readFile(abs, "utf8");
  const count = current.split(oldStr).length - 1;
  if (count === 0) {
    throw new Error(`old_string not found in ${rel}. Read the file again.`);
  }
  if (count > 1) {
    throw new Error(`old_string occurs ${count} times. Give a more unique fragment.`);
  }
  // Funkcja zamiast tekstu: "$&", "$1" itp. w new_string trafiają do pliku dosłownie.
  const next = current.replace(oldStr, () => newStr);
  await fs.writeFile(abs, next, "utf8");
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
  if (doc) {
    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(doc.uri, full, next);
    await vscode.workspace.applyEdit(edit);
  }
  return `Edited ${rel}`;
}

async function exists(abs: string): Promise<boolean> {
  return fs.stat(abs).then(
    () => true,
    () => false
  );
}

async function movePath(fromRel: string, toRel: string): Promise<string> {
  const from = resolveInWorkspace(fromRel);
  const to = resolveInWorkspace(toRel);
  if (from === requireRoot()) {
    throw new Error("Will not move the workspace root.");
  }
  if (!(await exists(from))) {
    throw new Error(`${fromRel} does not exist.`);
  }
  if (await exists(to)) {
    throw new Error(`Will not move: ${toRel} already exists.`);
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  // workspace.fs.rename: działa między dyskami i aktualizuje otwarte edytory.
  await vscode.workspace.fs.rename(vscode.Uri.file(from), vscode.Uri.file(to), { overwrite: false });
  return `Moved ${fromRel} → ${toRel}`;
}

async function deletePath(rel: string): Promise<string> {
  const abs = resolveInWorkspace(rel);
  if (abs === requireRoot()) {
    throw new Error("Will not delete the workspace root.");
  }
  if (!(await exists(abs))) {
    throw new Error(`${rel} does not exist.`);
  }
  const uri = vscode.Uri.file(abs);
  try {
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
  } catch {
    // Brak kosza (np. zdalny system plików) — usuń na stałe.
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
  }
  return `Deleted ${rel}`;
}

const SEVERITY = ["error", "warning", "info", "hint"];

function getDiagnostics(rel: string): string {
  const root = requireRoot();
  const filter = rel && rel !== "." ? resolveInWorkspace(rel) : root;
  const lines: string[] = [];
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    const file = uri.fsPath;
    if (uri.scheme !== "file" || (file !== filter && !file.startsWith(filter + path.sep))) {
      continue;
    }
    const p = path.relative(root, file).replace(/\\/g, "/");
    for (const d of diags) {
      if (d.severity === vscode.DiagnosticSeverity.Hint) {
        continue;
      }
      const src = d.source ? ` [${d.source}]` : "";
      lines.push(`${p}:${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY[d.severity]}: ${d.message}${src}`);
    }
  }
  if (!lines.length) {
    return "No errors or warnings (for analyzed files).";
  }
  return lines.slice(0, 200).join("\n") + (lines.length > 200 ? `\n… [+${lines.length - 200}]` : "");
}

async function listDir(rel: string, recursive: boolean): Promise<string> {
  const abs = resolveInWorkspace(rel);
  const items: string[] = [];
  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (items.length >= MAX_LIST) {
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (SKIP.has(e.name)) {
        continue;
      }
      const p = path.join(prefix, e.name).replace(/\\/g, "/");
      items.push(e.isDirectory() ? `${p}/` : p);
      if (recursive && e.isDirectory() && depth < 6) {
        await walk(path.join(dir, e.name), p, depth + 1);
      }
      if (items.length >= MAX_LIST) {
        items.push("… [truncated]");
        return;
      }
    }
  }
  await walk(abs, rel === "." ? "" : rel.replace(/\\/g, "/"), 0);
  return items.length ? items.join("\n") : "(empty folder)";
}

function globToRegExp(pattern: string): RegExp {
  const norm = pattern.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === "*" && norm[i + 1] === "*") {
      re += ".*";
      i++;
      if (norm[i + 1] === "/") {
        i++;
        re += "/?";
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, "i");
}

async function globFiles(pattern: string, rel: string): Promise<string> {
  const abs = resolveInWorkspace(rel);
  const rx = globToRegExp(pattern);
  const hits: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    if (hits.length >= MAX_LIST) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) {
        continue;
      }
      const p = (prefix ? `${prefix}/` : "") + e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, p);
      } else if (rx.test(p) || rx.test(e.name)) {
        hits.push(p);
      }
    }
  }
  await walk(abs, rel === "." ? "" : rel.replace(/\\/g, "/"));
  return hits.length ? hits.join("\n") : "No matches";
}

async function grep(pattern: string, rel: string, fileGlob: string): Promise<string> {
  let rx: RegExp;
  try {
    rx = new RegExp(pattern, "i");
  } catch {
    throw new Error("Invalid regular expression");
  }
  const fileRx = fileGlob ? globToRegExp(fileGlob) : null;
  const abs = resolveInWorkspace(rel);
  const hits: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    if (hits.length >= 200) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) {
        continue;
      }
      const p = (prefix ? `${prefix}/` : "") + e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, p);
        continue;
      }
      if ((fileRx && !fileRx.test(p) && !fileRx.test(e.name)) || isSecretFile(e.name)) {
        continue;
      }
      let text: string;
      try {
        const buf = await fs.readFile(full);
        if (buf.length > 1_000_000 || buf.includes(0)) {
          continue;
        }
        text = buf.toString("utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (rx.test(lines[i])) {
          hits.push(`${p}:${i + 1}:${lines[i].slice(0, 240)}`);
          if (hits.length >= 200) {
            hits.push("… [truncated]");
            return;
          }
        }
      }
    }
  }
  await walk(abs, rel === "." ? "" : rel.replace(/\\/g, "/"));
  return hits.length ? hits.join("\n") : "No matches";
}

let output: vscode.OutputChannel | undefined;

// Komenda działa raz (spawn); panel Output tylko pokazuje jej wyjście.
function ensureOutput(): vscode.OutputChannel {
  output ??= vscode.window.createOutputChannel("SyntaxCoder");
  return output;
}

async function runCommand(command: string, cwdRel: string): Promise<string> {
  if (!command.trim()) {
    throw new Error("Empty command");
  }
  const cwd = resolveInWorkspace(cwdRel);
  const log = ensureOutput();
  log.show(true);
  log.appendLine(`$ ${command}`);

  const timeout = getConfig().commandTimeoutMs;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      // shell: true na Windows: kill() zabija tylko cmd.exe, a właściwy proces działa dalej.
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill();
      }
      reject(new Error(trimOut(`TIMEOUT after ${timeout}ms\n${out}${err}`)));
    }, timeout);
    // Do modelu idzie najwyżej MAX_OUT znaków, więc nie trzymamy w pamięci więcej.
    child.stdout?.on("data", (d: Buffer) => {
      if (out.length <= MAX_OUT) {
        out += d.toString();
      }
      log.append(d.toString());
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (err.length <= MAX_OUT) {
        err += d.toString();
      }
      log.append(d.toString());
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      log.appendLine(`[exit ${code}]`);
      const text = trimOut(`exit ${code}\n${out}${err ? `\nstderr:\n${err}` : ""}`);
      if (code === 0) {
        resolve(text);
      } else {
        reject(new Error(text));
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function trimOut(s: string): string {
  if (s.length <= MAX_OUT) {
    return s.trim() || "(no output)";
  }
  return s.slice(0, MAX_OUT) + "\n… [truncated]";
}

async function openFile(rel: string): Promise<string> {
  const abs = resolveInWorkspace(rel);
  const doc = await vscode.workspace.openTextDocument(abs);
  await vscode.window.showTextDocument(doc, { preview: false });
  return `Opened ${rel}`;
}
