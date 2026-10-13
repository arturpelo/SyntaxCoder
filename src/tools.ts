import * as fs from "fs/promises";
import * as path from "path";
import { spawn } from "child_process";
import * as vscode from "vscode";
import { getConfig, workspaceRoot } from "./config";
import type { ToolDef } from "./lmStudio";

const SKIP = new Set(["node_modules", ".git", "out", "dist", ".vscode-test"]);
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
        "Run a shell command in the workspace (build, tests, scripts). Output is captured and also shown in the SyntaxCoder terminal.",
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
  if (name === "write_file" || name === "edit_file" || name === "create_dir") {
    return "write";
  }
  if (name === "run_command") {
    return "terminal";
  }
  return null;
}

export async function executeTool(name: string, rawArgs: string): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return `Invalid JSON arguments: ${rawArgs}`;
  }

  try {
    switch (name) {
      case "read_file":
        return await readFile(str(args.path), num(args.offset), num(args.limit));
      case "write_file":
        return await writeFile(str(args.path), str(args.content));
      case "create_dir":
        return await createDir(str(args.path));
      case "edit_file":
        return await editFile(str(args.path), str(args.old_string), str(args.new_string));
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
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
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
    throw new Error("Otwórz folder w VS Code (File → Open Folder), żeby pracować z plikami.");
  }
  return root;
}

export function resolveInWorkspace(rel: string): string {
  const root = requireRoot();
  const cleaned = rel.replace(/\\/g, "/");
  const abs = path.resolve(root, cleaned);
  const relToRoot = path.relative(root, abs);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    throw new Error(`Ścieżka poza workspace: ${rel}`);
  }
  return abs;
}

async function readFile(rel: string, offset?: number, limit?: number): Promise<string> {
  const abs = resolveInWorkspace(rel);
  const buf = await fs.readFile(abs);
  if (buf.length > MAX_READ * 4) {
    return `Plik za duży (${buf.length} B). Czytaj fragmentami (offset/limit).`;
  }
  let text = buf.toString("utf8");
  if (text.includes("\u0000")) {
    return "To wygląda na plik binarny — nie odczytuję.";
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
    return "Podaj ścieżkę folderu względem workspace.";
  }
  const abs = resolveInWorkspace(rel);
  await fs.mkdir(abs, { recursive: true });
  return `Utworzono folder ${rel.replace(/\\/g, "/")}`;
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
  return `Zapisano ${rel} (${content.length} znaków)`;
}

async function editFile(rel: string, oldStr: string, newStr: string): Promise<string> {
  const abs = resolveInWorkspace(rel);
  const current = await fs.readFile(abs, "utf8");
  const count = current.split(oldStr).length - 1;
  if (count === 0) {
    return `Nie znaleziono old_string w ${rel}. Przeczytaj plik ponownie.`;
  }
  if (count > 1) {
    return `old_string występuje ${count} razy. Podaj bardziej unikalny fragment.`;
  }
  const next = current.replace(oldStr, newStr);
  await fs.writeFile(abs, next, "utf8");
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
  if (doc) {
    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(doc.uri, full, next);
    await vscode.workspace.applyEdit(edit);
  }
  return `Zmieniono ${rel}`;
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
      if (SKIP.has(e.name) || e.name.startsWith(".")) {
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
  return items.length ? items.join("\n") : "(pusty katalog)";
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
      if (SKIP.has(e.name) || e.name.startsWith(".")) {
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
  return hits.length ? hits.join("\n") : "Brak dopasowań";
}

async function grep(pattern: string, rel: string, fileGlob: string): Promise<string> {
  let rx: RegExp;
  try {
    rx = new RegExp(pattern, "i");
  } catch {
    return "Niepoprawne wyrażenie regularne";
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
      if (SKIP.has(e.name) || e.name.startsWith(".")) {
        continue;
      }
      const p = (prefix ? `${prefix}/` : "") + e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, p);
        continue;
      }
      if (fileRx && !fileRx.test(p) && !fileRx.test(e.name)) {
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
  return hits.length ? hits.join("\n") : "Brak dopasowań";
}

let agentTerminal: vscode.Terminal | undefined;

function ensureTerminal(): vscode.Terminal {
  if (!agentTerminal || agentTerminal.exitStatus) {
    agentTerminal = vscode.window.createTerminal({ name: "SyntaxCoder" });
  }
  return agentTerminal;
}

async function runCommand(command: string, cwdRel: string): Promise<string> {
  if (!command.trim()) {
    return "Pusta komenda";
  }
  const cwd = resolveInWorkspace(cwdRel);
  const term = ensureTerminal();
  term.show(true);
  term.sendText(command, true);

  const timeout = getConfig().commandTimeoutMs;
  return await new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(trimOut(`TIMEOUT po ${timeout}ms\n${out}${err}`));
    }, timeout);
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(trimOut(`exit ${code}\n${out}${err ? `\nstderr:\n${err}` : ""}`));
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve(e.message);
    });
  });
}

function trimOut(s: string): string {
  if (s.length <= MAX_OUT) {
    return s.trim() || "(brak wyjścia)";
  }
  return s.slice(0, MAX_OUT) + "\n… [truncated]";
}

async function openFile(rel: string): Promise<string> {
  const abs = resolveInWorkspace(rel);
  const doc = await vscode.workspace.openTextDocument(abs);
  await vscode.window.showTextDocument(doc, { preview: false });
  return `Otwarto ${rel}`;
}
