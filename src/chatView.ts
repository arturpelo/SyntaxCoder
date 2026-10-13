import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { runAgent } from "./agent";
import { listModels, resolveModel, type ChatMessage } from "./lmStudio";
import { getConfig, saveConnection } from "./config";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "syntaxcoder.chat";
  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private abort?: AbortController;
  private approvals = new Map<string, (ok: boolean) => void>();
  private pendingText?: string;

  constructor(private readonly context: vscode.ExtensionContext) {}

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
    }) => {
      switch (msg.type) {
        case "ready":
          await this.pushStatus();
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
          await pickModel();
          await this.pushStatus();
          break;
        case "saveConnection":
          await saveConnection(msg.host ?? "", Number(msg.port) || 1234);
          await this.pushStatus();
          break;
      }
    });
  }

  newChat(): void {
    this.abort?.abort();
    this.history = [];
    this.post({ type: "cleared" });
  }

  stop(): void {
    this.abort?.abort();
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

  private async chat(userText: string): Promise<void> {
    if (this.abort) {
      this.post({ type: "error", message: "Poczekaj aż skończy się poprzednia odpowiedź, albo zatrzymaj." });
      return;
    }
    this.post({ type: "user", text: userText });
    this.post({ type: "busy", value: true });
    this.abort = new AbortController();
    try {
      this.history = await runAgent({
        history: this.history,
        userText,
        signal: this.abort.signal,
        host: {
          post: (m) => this.post(m),
          waitApproval: (id, kind, name, args) => this.waitApproval(id, kind, name, args),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== "Zatrzymano" && !this.abort.signal.aborted) {
        this.post({ type: "error", message });
      } else {
        this.post({ type: "error", message: "Zatrzymano." });
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

  private post(msg: Record<string, unknown>): void {
    void this.view?.webview.postMessage(msg);
  }

  private async pushStatus(): Promise<void> {
    const cfg = getConfig();
    let model = cfg.model;
    let connected = false;
    try {
      model = await resolveModel();
      connected = true;
    } catch {
      connected = false;
    }
    this.post({
      type: "status",
      connected,
      model: model || "—",
      host: cfg.host,
      port: cfg.port,
      baseUrl: cfg.baseUrl,
    });
  }

  private html(webview: vscode.Webview): string {
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "chat.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "chat.js"));
    const nonce = randomBytes(16).toString("hex");
    return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${css}" />
</head>
<body>
  <header>
    <div>
      <strong>SyntaxCoder</strong>
      <span id="status" class="pill off">LM Studio</span>
    </div>
    <div class="hdr-actions">
      <button id="cfgBtn" class="ghost" title="Adres i port LM Studio">Połączenie</button>
      <button id="modelBtn" title="Wybierz model">model</button>
    </div>
  </header>
  <section id="cfg" hidden>
    <label>Adres hosta
      <input id="host" type="text" spellcheck="false" placeholder="127.0.0.1 albo 192.168.1.20" />
    </label>
    <label>Port
      <input id="port" type="number" min="1" max="65535" placeholder="1234" />
    </label>
    <button id="saveCfg">Zapisz i sprawdź</button>
    <p id="cfgHint" class="hint"></p>
  </section>
  <div id="log"></div>
  <div id="composer">
    <textarea id="input" rows="3" placeholder="Napisz co zrobić w projekcie… (Enter wyślij, Shift+Enter nowa linia)"></textarea>
    <div class="row">
      <button id="stop" hidden>Stop</button>
      <button id="send">Wyślij</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

export async function pickModel(): Promise<void> {
  try {
    const models = await listModels();
    if (!models.length) {
      void vscode.window.showWarningMessage("LM Studio nie zwraca modeli. Załaduj model na serwerze.");
      return;
    }
    const picked = await vscode.window.showQuickPick(models, { placeHolder: "Model LM Studio" });
    if (picked) {
      await vscode.workspace
        .getConfiguration("syntaxcoder")
        .update("model", picked, vscode.ConfigurationTarget.Global);
    }
  } catch (err) {
    void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
  }
}
