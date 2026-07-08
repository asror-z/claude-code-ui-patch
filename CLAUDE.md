# Claude Code UI Patch — Project Requirements

VS Code extension that patches the Claude Code chat webview with UI enhancements.

## Debug Launch (F5) Must Pin the Workspace Folder Explicitly

`.vscode/launch.json`'s "Run Extension" config must always include the project's own folder as an explicit positional element in `args`, listed *before* `--extensionDevelopmentPath=`:

```json
"args": [
    "${workspaceFolder}",
    "--extensionDevelopmentPath=${workspaceFolder}"
]
```

Without the bare `${workspaceFolder}` positional arg, VS Code's Extension Development Host does not receive an explicit workspace to open, so it falls back to restoring `windowsState.lastPluginDevelopmentHostWindow.folder` from `%APPDATA%\Code\User\globalStorage\storage.json` — whatever folder the Extension Development Host happened to open last, which can be an unrelated project. This is a VS Code internal, not a bug in this project; the fix is confirmed working. Full diagnostic methodology (inspecting `storage.json`/`state.vscdb`, general launch.json/tasks.json troubleshooting for VS Code extensions) is owned by the `smarts-app-vscode` skill — invoke it for any future "F5 opened the wrong folder" or extension debug-launch issue, in this project or any other.

## Chat-Enhancement Features Architecture (`claudeCodeUiPatch.chatEnhancements`)

The 15 chat-webview behavior features (Reply, Search, DateTime, AskQuestion, UserStyle, Blockquote, CopyButtons, CodeBlock, Toc, Export, Scroll, AskCollapse, AutoContinue, DraftSave, UserNav — one `behaviorFeatures.<id>.ts` file each, registered into `behaviorFeatures.ts`'s registry) are fundamentally different from every `PATCH_POINT`/`TOGGLE_POINT`/`INJECT_POINT` in `patcher.ts`: those swap an *existing* hardcoded value already in the bundle, whereas a chat-enhancement feature adds *new* client-side behavior that doesn't exist in the stock bundle at all.

- **Injection is ONE marker-tagged inline `<script nonce>` + one CSS block** (`behaviorInject.ts`), never separate asset files with their own `<script src>` tags. The chat webview's CSP is `script-src 'nonce-${u}'` only (no `unsafe-inline`, no external `src` without that exact nonce) — a new feature's JS must ship inside the already-nonced inline block, anchored right after the existing `index.js` module-script chain, before `</body>`.
- **No nested iframe in this target.** Unlike the Antigravity IDE build this was ported from (which needed frame-hunting to reach the real chat DOM), this VS Code webview panel renders `<div id="root">` directly in the same document the injected script runs in — `behaviorBootstrap.ts`'s bootstrap is deliberately simplified (no `reachableDocs()`/`frameDoc()`), since `document` already *is* the chat document.
- **The VS Code settings panel is the ONE control surface for per-feature on/off — never an in-chat UI element.** Each feature has a `claudeCodeUiPatch.feature.<id>` setting, rendered as a real checkbox in the panel's "Chat Enhancement Features" section (`panel.ts`); checking/unchecking re-patches immediately and takes effect on the next window reload, exactly like every other patch setting. An earlier iteration added an in-chat "⚙ gear" toggle panel (a ported `featuretoggle` feature) — this was explicitly rejected and removed; do not re-add an in-chat toggle control.
- **Every claude-webview change is tested only against a disposable scratch copy** of the real installed `anthropic.claude-code-*-win32-x64` extension (never the user's live `~/.vscode/extensions/` install) — copy it into the session's `.claude/{title}/Tests/` scratch area first.
