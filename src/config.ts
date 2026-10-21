import * as vscode from "vscode";
import { t } from "./i18n";

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
  autonomousMode: boolean;
  reviewer: boolean;
  commandTimeoutMs: number;
}

const TOKEN_KEY = "syntaxcoder.apiToken";
// Token z SecretStorage (pęk kluczy systemu); getConfig jest synchroniczne, więc trzymamy kopię.
let token: string | undefined;

export async function loadApiToken(secrets: vscode.SecretStorage): Promise<void> {
  token = (await secrets.get(TOKEN_KEY)) || undefined;
}

export async function storeApiToken(secrets: vscode.SecretStorage, value: string | undefined): Promise<void> {
  const v = value?.trim();
  if (v && /\s/.test(v)) {
    throw new Error(t("tokenInvalid"));
  }
  if (v) {
    await secrets.store(TOKEN_KEY, v);
  } else {
    await secrets.delete(TOKEN_KEY);
  }
  token = v || undefined;
}

export function hasApiToken(): boolean {
  return Boolean(token);
}

export function isTokenKey(key: string): boolean {
  return key === TOKEN_KEY;
}

export function getConfig(): SyntaxCoderConfig {
  const c = vscode.workspace.getConfiguration("syntaxcoder");
  const parsed = parseHostPort(c.get<string>("host", "127.0.0.1"), c.get<number>("port", 1234));
  // Schemat wpisany w hoście (https://…) wygrywa z przełącznikiem.
  const https = parsed.https ?? c.get<boolean>("https", false);
  const urlHost = parsed.host.includes(":") ? `[${parsed.host}]` : parsed.host;
  return {
    host: parsed.host,
    port: parsed.port,
    https,
    baseUrl: `${https ? "https" : "http"}://${urlHost}:${parsed.port}/v1`,
    apiKey: token ?? c.get<string>("apiKey", "lm-studio"),
    model: c.get<string>("model", "").trim(),
    temperature: c.get<number>("temperature", 0.3),
    maxTokens: c.get<number>("maxTokens", 4096),
    autoApproveWrites: c.get<boolean>("autoApproveWrites", false),
    autoApproveTerminal: c.get<boolean>("autoApproveTerminal", false),
    autonomousMode: c.get<boolean>("autonomousMode", false),
    reviewer: c.get<boolean>("reviewer", false),
    commandTimeoutMs: c.get<number>("commandTimeoutMs", 60000),
  };
}

export function parseHostPort(
  rawHost: string,
  rawPort: number
): { host: string; port: number; https?: boolean } {
  let host = (rawHost || "127.0.0.1").trim();
  const scheme = host.match(/^(https?):\/\//i)?.[1].toLowerCase();
  host = host.replace(/^https?:\/\//i, "");
  host = host.replace(/\/.*$/, "");
  // https:// bez portu w adresie = 443, jak za typowym reverse proxy.
  let port = scheme === "https" ? 443 : Number.isFinite(rawPort) && rawPort > 0 ? Math.floor(rawPort) : 1234;

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
  return scheme ? { host, port, https: scheme === "https" } : { host, port };
}

export async function saveConnection(rawHost: string, rawPort: number, https: boolean): Promise<SyntaxCoderConfig> {
  const parsed = parseHostPort(rawHost, rawPort);
  const c = vscode.workspace.getConfiguration("syntaxcoder");
  await c.update("host", parsed.host, vscode.ConfigurationTarget.Global);
  await c.update("port", parsed.port, vscode.ConfigurationTarget.Global);
  await c.update("https", parsed.https ?? https, vscode.ConfigurationTarget.Global);
  return getConfig();
}

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}