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

## Chat-Enhancement Features Architecture

The 15 chat-webview behavior features (Reply, Search, DateTime, AskQuestion, UserStyle, Blockquote, CopyButtons, CodeBlock, Toc, Export, Scroll, AskCollapse, AutoContinue, DraftSave, UserNav — one `behaviorFeatures.<id>.ts` file each, registered into `behaviorFeatures.ts`'s registry) are fundamentally different from every `PATCH_POINT`/`TOGGLE_POINT`/`INJECT_POINT` in `patcher.ts`: those swap an *existing* hardcoded value already in the bundle, whereas a chat-enhancement feature adds *new* client-side behavior that doesn't exist in the stock bundle at all.

- **Always injected — there is NO master on/off switch.** An earlier `claudeCodeUiPatch.chatEnhancements` setting was removed per explicit user feedback ("doim on bo'ladi" — always on); do not re-add a master toggle. Internally the injection still rides the existing `TOGGLE_POINTS`/`TogglePoint` machinery (its apply/restore/idempotency logic is reused as-is) via a `chatEnhancements` entry, but `patcher.ts`'s `ALWAYS_ON_TOGGLES` set forces `readToggles()` to report it `true` unconditionally, and `discard()`/`restore()` skip writing it to any setting — so Factory Reset and Restore Last Applied can never turn the whole pack off. The **only** per-feature control is each feature's own `claudeCodeUiPatch.feature.<id>` boolean.
- **Injection is ONE marker-tagged inline `<script nonce>` + one CSS block** (`behaviorInject.ts`), never separate asset files with their own `<script src>` tags. The chat webview's CSP is `script-src 'nonce-${u}'` only (no `unsafe-inline`, no external `src` without that exact nonce) — a new feature's JS must ship inside the already-nonced inline block, anchored right after the existing `index.js` module-script chain, before `</body>`.
- **No nested iframe in this target.** Unlike the Antigravity IDE build this was ported from (which needed frame-hunting to reach the real chat DOM), this VS Code webview panel renders `<div id="root">` directly in the same document the injected script runs in — `behaviorBootstrap.ts`'s bootstrap is deliberately simplified (no `reachableDocs()`/`frameDoc()`), since `document` already *is* the chat document.
- **The VS Code settings panel is the ONE control surface for per-feature on/off — never an in-chat UI element.** Each feature has a `claudeCodeUiPatch.feature.<id>` setting, rendered as a real checkbox in the panel's "Chat Enhancement Features" grid (`panel.ts`); checking/unchecking re-patches immediately and takes effect on the next window reload, exactly like every other patch setting. An earlier iteration added an in-chat "⚙ gear" toggle panel (a ported `featuretoggle` feature) — this was explicitly rejected and removed; do not re-add an in-chat toggle control.
- **The panel lays out its content in a responsive 3-column CSS grid** (`.section-grid` of `.section-col`s), not one long vertical list: **column 1** is the 15 feature checkboxes alone (a self-contained `.feature-grid.feature-grid-1col` — single-column here since the outer grid already narrows it), **column 2** is the "Chat Panel or Tab" knobs (font sizes/toggles), **column 3** is "Plan Mode Markdown Preview". Auto-fit wraps down to 2, then 1, column(s) in a narrower window. This uses the panel's full available width instead of a long vertical scroll; keep this 3-column shape (features / Chat Panel or Tab / Plan Mode) when adding new panel rows — do not re-merge the features grid back into a knob section (that broke it once already: it was spliced onto a "chatEnhancements" row that got removed, silently dropping all 15 checkboxes).
- **Every claude-webview change is tested only against a disposable scratch copy** of the real installed `anthropic.claude-code-*-win32-x64` extension (never the user's live `~/.vscode/extensions/` install) — copy it into the session's `.claude/{title}/Tests/` scratch area first.
