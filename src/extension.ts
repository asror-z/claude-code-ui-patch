import * as vscode from "vscode";
import { Patcher, migrateLegacyKeys, migrateNamespaceRename } from "./patcher";
import { StatusBar } from "./statusBar";
import { PatchPanel, PatchSidebarView } from "./panel";

// Held so deactivate() can revert the on-disk patch even when the user never
// clicked the panel's "Fully Disable Patch" button first — see deactivate().
let activePatcher: Patcher | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // v2.0.0 renamed the whole extension (claudeCodeUiPatch -> smartsClaudeManager) —
  // move every setting a user may have under the OLD namespace first, so an
  // upgrading install keeps its values instead of silently reverting to defaults.
  await migrateNamespaceRename();
  // Move any pre-rename chatDiff* settings to chatDiffCard* before the Patcher
  // reads them, so a rebuild after the rename keeps the user's values.
  await migrateLegacyKeys();
  const patcher = new Patcher(context);
  activePatcher = patcher;
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
  // Disposables registered in activate() are cleaned up by VS Code. This
  // extension ALSO edits Claude Code's own extension.js/index.css bytes on
  // disk (see patcher.ts) — a change that outlives the VS Code process, unlike
  // a normal subscription. If the user uninstalls or disables this extension
  // without first clicking the panel's "Fully Disable Patch" button, those
  // patched files were previously left behind permanently: Claude Code kept
  // loading the patched bundle even with this extension gone, because nothing
  // ever reverted it. restoreFilesOnly() is the synchronous, side-effect-free
  // half of Patcher.restore() (no settings/config writes, safe to call with
  // deactivate()'s very limited teardown time budget) — it reverts the
  // on-disk bytes so Claude Code loads its native, unpatched bundle again.
  activePatcher?.restoreFilesOnly();
  activePatcher = undefined;
}
