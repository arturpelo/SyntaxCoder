import * as vscode from "vscode";

export interface SyntaxCoderConfig {
  host: string;
  port: number;
  https: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  autoApproveWrites: boolean;
  autoApproveTerminal: boolean;
  commandTimeoutMs: number;
}

export function getConfig(): SyntaxCoderConfig {
  const c = vscode.workspace.getConfiguration("syntaxcoder");
  const parsed = parseHostPort(c.get<string>("host", "127.0.0.1"), c.get<number>("port", 1234));
  const https = c.get<boolean>("https", false);
  const proto = https ? "https" : "http";
  return {
    host: parsed.host,
    port: parsed.port,
    https,
    baseUrl: `${proto}://${parsed.host}:${parsed.port}/v1`,
    apiKey: c.get<string>("apiKey", "lm-studio"),
    model: c.get<string>("model", "").trim(),
    temperature: c.get<number>("temperature", 0.3),
    maxTokens: c.get<number>("maxTokens", 4096),
    autoApproveWrites: c.get<boolean>("autoApproveWrites", false),
    autoApproveTerminal: c.get<boolean>("autoApproveTerminal", false),
    commandTimeoutMs: c.get<number>("commandTimeoutMs", 60000),
  };
}

export function parseHostPort(rawHost: string, rawPort: number): { host: string; port: number } {
  let host = (rawHost || "127.0.0.1").trim();
  host = host.replace(/^https?:\/\//i, "");
  host = host.replace(/\/.*$/, "");
  let port = Number.isFinite(rawPort) && rawPort > 0 ? Math.floor(rawPort) : 1234;

  const v6 = host.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) {
    host = v6[1];
    if (v6[2]) {
      port = Number(v6[2]);
    }
  } else if (host.includes(":") && !host.includes("::")) {
    const idx = host.lastIndexOf(":");
    const maybePort = host.slice(idx + 1);
    if (/^\d+$/.test(maybePort)) {
      port = Number(maybePort);
      host = host.slice(0, idx);
    }
  }

  host = host.replace(/^\[/, "").replace(/\]$/, "") || "127.0.0.1";
  if (port < 1 || port > 65535) {
    port = 1234;
  }
  return { host, port };
}

export async function saveConnection(rawHost: string, rawPort: number): Promise<SyntaxCoderConfig> {
  const { host, port } = parseHostPort(rawHost, rawPort);
  const c = vscode.workspace.getConfiguration("syntaxcoder");
  await c.update("host", host, vscode.ConfigurationTarget.Global);
  await c.update("port", port, vscode.ConfigurationTarget.Global);
  return getConfig();
}

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
