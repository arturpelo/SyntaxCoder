import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { approvedPlanPrompt, runAgent, type PlanStep } from "./agent";
import { checkServer, listModels, ModelMissingError, type ChatMessage } from "./lmStudio";
import { getConfig, hasApiToken, saveConnection, storeApiToken } from "./config";
import { ABORTED } from "./agent";
import { lang, languageSetting, setLanguageOverride, strings, t } from "./i18n";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "syntaxcoder.chat";
  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private abort?: AbortController;
  private approvals = new Map<string, (ok: boolean) => void>();
  // Plan z trybu planu, który czeka na „Wykonaj plan”.
  private plan?: PlanStep[];
  private pendingText?: string;
  private pendingCfg = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("syntaxcoder.language")) {
          setLanguageOverride(undefined); // ustawienie jest znów źródłem prawdy
          if (this.view) {
            this.pushL10n();
          }
        }
        if (this.view && e.affectsConfiguration("syntaxcoder")) {
          void this.pushStatus();
        }
      })
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const { webview } = webviewView;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webview.html = this.html(webview);

    webview.onDidReceiveMessage(async (msg: {
      type: string;
      text?: string;
      id?: string;
      host?: string;
      port?: number;
      token?: string;
      https?: boolean;
      key?: string;
      value?: boolean | string;
    }) => {
      // Błąd w obsłudze wiadomości ma być widoczny w czacie, a nie ginąć po cichu.
      try {
        switch (msg.type) {
          case "ready":
            this.pushL10n();
            await this.pushStatus();
            if (this.pendingCfg) {
              this.pendingCfg = false;
              this.post({ type: "toggleCfg" });
            }
            if (this.pendingText) {
              const t = this.pendingText;
              this.pendingText = undefined;
              await this.chat(t);
            }
            break;
          case "chat":
            if (msg.text) {
              await this.chat(msg.text);
            }
            break;
          case "stop":
            this.abort?.abort();
            break;
          case "executePlan":
            // Przycisk ze starej karty (np. po nowej wiadomości) nie ma już planu do wykonania.
            if (this.plan) {
              await this.chat(t("planRun"), this.plan);
            }
            break;
          case "newChat":
            this.newChat();
            break;
          case "approve":
            this.approvals.get(msg.id ?? "")?.(true);
            break;
          case "deny":
            this.approvals.get(msg.id ?? "")?.(false);
            break;
          case "pickModel":
            // Zmiana modelu odświeża status przez onDidChangeConfiguration.
            await pickModel();
            break;
          case "setLanguage": {
            // Najpierw UI (działa od razu), potem zapis; nieudany zapis nie blokuje zmiany.
            const value = String(msg.value ?? "auto");
            setLanguageOverride(value);
            this.pushL10n();
            try {
              await vscode.workspace
                .getConfiguration("syntaxcoder")
                .update("language", value, vscode.ConfigurationTarget.Global);
            } catch (err) {
              void vscode.window.showWarningMessage(
                t("langNotSaved", err instanceof Error ? err.message : String(err))
              );
            }
            break;
          }
          case "setFlag":
            if (isFlag(msg.key)) {
              await setFlag(msg.key, Boolean(msg.value));
            }
            this.post({ type: "flags", ...flags() });
            break;
          case "saveConnection": {
            // Token najpierw, żeby sprawdzenie nowego adresu szło już z nim. Puste pole = token bez zmian.
            if (msg.token?.trim()) {
              await storeApiToken(this.context.secrets, msg.token);
            }
            const before = getConfig().baseUrl;
            // Nowy adres odświeża status przez onDidChangeConfiguration; ten sam trzeba sprawdzić ręcznie.
            if ((await saveConnection(msg.host ?? "", Number(msg.port) || 1234, Boolean(msg.https))).baseUrl === before) {
              await this.pushStatus();
            }
            break;
          }
          case "clearToken":
            await storeApiToken(this.context.secrets, undefined);
            await this.pushStatus();
            break;
        }
      } catch (err) {
        this.post({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  newChat(): void {
    this.abort?.abort();
    this.history = [];
    this.plan = undefined;
    this.post({ type: "cleared" });
  }

  stop(): void {
    this.abort?.abort();
  }

  async toggleConnection(): Promise<void> {
    if (!this.view) {
      this.pendingCfg = true;
      await vscode.commands.executeCommand("syntaxcoder.openChat");
      return;
    }
    this.post({ type: "toggleCfg" });
  }

  async addContext(text: string): Promise<void> {
    if (!this.view) {
      this.pendingText = text;
      await vscode.commands.executeCommand("syntaxcoder.openChat");
      return;
    }
    await vscode.commands.executeCommand("syntaxcoder.openChat");
    this.post({ type: "prefill", text });
  }

  // approved: plan zatwierdzony przyciskiem; agent go wykonuje, zamiast planować od nowa.
  private async chat(userText: string, approved?: PlanStep[]): Promise<void> {
    if (this.abort) {
      this.post({ type: "error", message: t("busyWait") });
      return;
    }
    // Każda nowa wiadomość zamyka plan czekający na zgodę; poprawki do planu tworzą nowy.
    this.plan = undefined;
    this.post({ type: "user", text: userText });
    this.post({ type: "busy", value: true });
    this.abort = new AbortController();
    try {
      const res = await runAgent({
        history: this.history,
        userText: approved ? approvedPlanPrompt(approved) : userText,
        planMode: !approved && getConfig().planMode,
        signal: this.abort.signal,
        host: {
          post: (m) => this.post(m),
          waitApproval: (id, kind, name, args) => this.waitApproval(id, kind, name, args),
        },
      });
      this.history = res.history;
      this.plan = res.plan;
      if (res.plan) {
        this.post({ type: "planReady" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== ABORTED && !this.abort.signal.aborted) {
        this.post({ type: "error", message });
      } else {
        this.post({ type: "error", message: t("stopped") });
      }
    } finally {
      this.abort = undefined;
      this.post({ type: "busy", value: false });
      await this.pushStatus();
    }
  }

  private waitApproval(
    id: string,
    kind: "write" | "terminal",
    name: string,
    args: string
  ): Promise<boolean> {
    this.post({ type: "toolPending", id, kind, name, args });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(id);
        resolve(false);
      }, 5 * 60_000);
      this.approvals.set(id, (ok) => {
        clearTimeout(timer);
        this.approvals.delete(id);
        resolve(ok);
      });
    });
  }

  private pushL10n(): void {
    this.post({ type: "l10n", lang: lang(), setting: languageSetting(), strings: strings() });
  }

  private post(msg: Record<string, unknown>): void {
    void this.view?.webview.postMessage(msg);
  }

  async refreshStatus(): Promise<void> {
    if (this.view) {
      await this.pushStatus();
    }
  }

  private async pushStatus(): Promise<void> {
    const cfg = getConfig();
    let model = cfg.model;
    let connected = false;
    let error = "";
    let reachable = false;
    this.post({ type: "checking" });
    try {
      model = await checkServer();
      connected = reachable = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      reachable = err instanceof ModelMissingError;
    }
    this.post({
      type: "status",
      connected,
      reachable,
      model: model || "—",
      host: cfg.host,
      port: cfg.port,
      https: cfg.https,
      baseUrl: cfg.baseUrl,
      error,
      hasToken: hasApiToken(),
      ...flags(),
    });
  }

  private html(webview: vscode.Webview): string {
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "chat.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "chat.js"));
    const nonce = randomBytes(16).toString("hex");
    const s = strings();
    // Teksty od razu w HTML; po zmianie języka chat.js podmienia je przez data-i18n*.
    const tx = (k: keyof typeof s) => `data-i18n="${k}">${esc(s[k])}`;
    const attr = (name: string, k: keyof typeof s) => `${name}="${esc(s[k])}" data-i18n-${name}="${k}"`;
    const opt = (v: string, label: string) => `<option value="${v}">${label}</option>`;
    return `<!DOCTYPE html>
<html lang="${lang()}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${css}" />
</head>
<body>
  <section id="cfg" hidden>
    <div class="cfg-head">
      <strong ${tx("cfgTitle")}</strong>
      <button id="cfgClose" class="icon-btn ghost" ${attr("title", "close")} ${attr("aria-label", "close")}>✕</button>
    </div>
    <div class="cfg-row">
      <label class="grow"><span ${tx("host")}</span>
        <input id="host" type="text" spellcheck="false" placeholder="192.168.1.20 / https://lm.example.com" />
      </label>
      <label class="port"><span ${tx("port")}</span>
        <input id="port" type="number" min="1" max="65535" placeholder="1234" />
      </label>
      <label class="check" ${attr("title", "httpsTitle")}><input id="https" type="checkbox" /><span>HTTPS</span></label>
    </div>
    <div class="cfg-row">
      <label class="grow"><span ${tx("token")}</span>
        <input id="token" type="password" autocomplete="off" spellcheck="false" ${attr("placeholder", "tokenPlaceholder")} />
      </label>
      <button id="clearToken" class="ghost" hidden ${tx("clearToken")}</button>
    </div>
    <div class="cfg-row">
      <button id="saveCfg" ${tx("save")}</button>
      <span id="cfgHint" class="hint"></span>
    </div>
    <div class="cfg-row">
      <label class="grow"><span ${tx("language")}</span>
        <select id="lang">
          <option value="auto" ${tx("langAuto")}</option>
          ${opt("en", "English")}${opt("de", "Deutsch")}${opt("fr", "Français")}${opt("pl", "Polski")}
        </select>
      </label>
      <button id="applyLang" disabled ${tx("apply")}</button>
    </div>
  </section>
  <main id="log" aria-live="polite"></main>
  <footer id="composer">
    <div class="box">
      <textarea id="input" rows="1" ${attr("placeholder", "placeholder")} ${attr("title", "keysHint")}></textarea>
      <div class="bar">
        <button id="modelBtn" class="chip">
          <span id="dot" class="dot off"></span><span id="modelName" ${tx("connecting")}</span>
        </button>
        <button id="stop" class="icon-btn stop" hidden ${attr("title", "stop")} ${attr("aria-label", "stop")}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor"/></svg>
        </button>
        <button id="send" class="icon-btn" ${attr("title", "send")} ${attr("aria-label", "send")}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="bar flags">
        <button class="chip switch" data-flag="autonomousMode" role="switch" aria-checked="false" ${attr("title", "autoTitle")}>
          <span class="track"><span class="knob"></span></span><span ${tx("auto")}</span>
        </button>
        <button class="chip switch" data-flag="reviewer" role="switch" aria-checked="false" ${attr("title", "reviewerTitle")}>
          <span class="track"><span class="knob"></span></span><span ${tx("reviewer")}</span>
        </button>
        <button class="chip switch" data-flag="planMode" role="switch" aria-checked="false" ${attr("title", "planTitle")}>
          <span class="track"><span class="knob"></span></span><span ${tx("plan")}</span>
        </button>
        <button class="chip switch" data-flag="inlineCompletions" role="switch" aria-checked="false" ${attr("title", "hintsTitle")}>
          <span class="track"><span class="knob"></span></span><span ${tx("hints")}</span>
        </button>
      </div>
    </div>
  </footer>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

export async function pickModel(): Promise<void> {
  try {
    const models = await listModels();
    if (!models.length) {
      void vscode.window.showWarningMessage(t("noModels"));
      return;
    }
    const picked = await vscode.window.showQuickPick(models, { placeHolder: t("pickModel") });
    if (picked) {
      await vscode.workspace
        .getConfiguration("syntaxcoder")
        .update("model", picked, vscode.ConfigurationTarget.Global);
    }
  } catch (err) {
    void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
  }
}

// Przełączniki przy polu wiadomości; każdy to ustawienie boolean o tej samej nazwie.
const FLAGS = ["autonomousMode", "reviewer", "planMode", "inlineCompletions"] as const;
type Flag = (typeof FLAGS)[number];

function isFlag(key: string | undefined): key is Flag {
  return (FLAGS as readonly (string | undefined)[]).includes(key);
}

function flags(): Record<Flag, boolean> {
  const cfg = getConfig();
  return Object.fromEntries(FLAGS.map((k) => [k, cfg[k]])) as Record<Flag, boolean>;
}

async function setFlag(key: Flag, on: boolean): Promise<void> {
  if (key === "autonomousMode" && on) {
    const button = t("autoConfirmButton");
    const ok = await vscode.window.showWarningMessage(
      t("autoConfirm"),
      { modal: true, detail: t("autoConfirmDetail") },
      button
    );
    if (ok !== button) {
      return;
    }
  }
  // Zawsze ustawienia użytkownika: zgody mają scope "application", repo ich nie nadpisze.
  await vscode.workspace.getConfiguration("syntaxcoder").update(key, on, vscode.ConfigurationTarget.Global);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
