import * as vscode from "vscode";
import { Patcher, migrateLegacyKeys, migrateNamespaceRename } from "./patcher";
import { StatusBar } from "./statusBar";
import { PatchPanel, PatchSidebarView } from "./panel";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // v2.0.0 renamed the whole extension (claudeCodeUiPatch -> smartsClaudeManager) —
  // move every setting a user may have under the OLD namespace first, so an
  // upgrading install keeps its values instead of silently reverting to defaults.
  await migrateNamespaceRename();
  // Move any pre-rename chatDiff* settings to chatDiffCard* before the Patcher
  // reads them, so a rebuild after the rename keeps the user's values.
  await migrateLegacyKeys();
  const patcher = new Patcher(context);
  const statusBar = new StatusBar(patcher);
  const sidebarView = new PatchSidebarView(patcher);

  context.subscriptions.push(
    statusBar,
    ...patcher.register(),
    vscode.commands.registerCommand("smartsClaudeManager.panel", () =>
      PatchPanel.show(patcher)
    ),
    vscode.window.registerWebviewViewProvider(PatchSidebarView.viewId, sidebarView)
  );
}

export function deactivate(): void {
  // Disposables registered in activate() are cleaned up by VS Code.
}
