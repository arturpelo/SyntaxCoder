import * as vscode from "vscode";
import { ChatViewProvider, pickModel } from "./chatView";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("syntaxcoder.openChat", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.syntaxcoder");
      await vscode.commands.executeCommand("syntaxcoder.chat.focus");
    }),
    vscode.commands.registerCommand("syntaxcoder.newChat", () => provider.newChat()),
    vscode.commands.registerCommand("syntaxcoder.stop", () => provider.stop()),
    vscode.commands.registerCommand("syntaxcoder.pickModel", () => pickModel()),
    vscode.commands.registerCommand("syntaxcoder.addSelection", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) {
        return;
      }
      const rel = vscode.workspace.asRelativePath(ed.document.uri);
      const start = ed.selection.start.line + 1;
      const end = ed.selection.end.line + 1;
      const snippet = ed.document.getText(ed.selection);
      await vscode.commands.executeCommand("syntaxcoder.openChat");
      await provider.addContext(
        `Zaznaczenie z ${rel} (linie ${start}–${end}):\n\`\`\`\n${snippet}\n\`\`\`\n\n`
      );
    })
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80);
  status.text = "$(hubot) SyntaxCoder";
  status.tooltip = "Otwórz czat SyntaxCoder";
  status.command = "syntaxcoder.openChat";
  status.show();
  context.subscriptions.push(status);
}

export function deactivate(): void {}
