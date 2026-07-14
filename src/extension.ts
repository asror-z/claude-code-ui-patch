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
  //
  // deactivate() is DELIBERATELY a no-op — it does NOT revert the on-disk
  // patch. An earlier version called Patcher.restoreFilesOnly()
  // unconditionally here, on the theory that this would clean up after an
  // uninstall/disable the user never confirmed via the panel's own
  // Enable/Disable toggle. In practice this made the whole extension
  // unstable: deactivate() fires identically for an ORDINARY window reload
  // and for a genuine uninstall — VS Code's own API gives no way to tell
  // them apart (confirmed against microsoft/vscode#110034, still open as of
  // this writing) — so every single reload reverted the patch to native,
  // and whatever activated next had to re-apply it from scratch. A
  // screenshot or check taken in the narrow window between that revert and
  // the next re-apply looked like "the patch keeps failing," when nothing
  // was actually broken — the revert itself was the bug.
  //
  // This mirrors this extension's own v2.0.24, which never had a
  // revert-on-deactivate at all and was rock-solid specifically because of
  // that: the patch is written once (on activation, gated on
  // smartsClaudeManager.patchEnabled — see patcher.ts's Patcher
  // constructor/applyOnActivation()) and is never silently touched again
  // except through an explicit user action — the top-of-panel Enable/
  // Disable toggle, or Factory Reset — both of which call
  // Patcher.restore()/enable() directly and trigger their own reload.
  //
  // The accepted tradeoff: a user who uninstalls/disables this extension
  // WITHOUT first using the panel's toggle leaves the patched bytes on
  // Claude Code's disk until either (a) they reinstall and toggle it off
  // themselves, or (b) Claude Code's own next auto-update overwrites its
  // extension.js/index.css natively anyway, which happens routinely.
}
