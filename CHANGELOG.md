# Changelog

All notable changes to Claude Code UI Patch are documented here. This project follows [Semantic Versioning](https://semver.org).

## Supported versions

| Claude Code | UI Patch |
| ----------- | -------- |
| 2.1.201+    | 1.2.x    |

## 1.2.3

- Redesign the control panel: a card-style layout with icons on the header, section
  headings, and status banner, a version pill, and a real sliding switch (pill + thumb)
  replacing the plain On/Off button.
- Replace the ▼/▲ spinner buttons for font-size knobs with a plain single-line number
  input, matching the compact single-line layout the Chat Enhancement Features
  checkboxes already use.
- The bottom action row (Restore Last Applied / Open VS Code Settings / Reload Window /
  Factory Reset) is now four uniform buttons instead of a mix of buttons and bare links;
  Reload Window highlights as a warning-colored button only while a reload is actually
  pending.

## 1.2.2

- Add an Activity Bar icon for Claude Code UI Patch, opening the same control surface as
  a sidebar view (`registerWebviewViewProvider`) instead of only a floating editor tab.
  The rendering/message-handling logic is now shared between the editor-tab panel
  (`PatchPanel`, still opened via the Command Palette or status-bar click) and the new
  sidebar view (`PatchSidebarView`) through a common base class.

## 1.2.1

- Remove `claudeCodeUiPatch.chatEnhancements`. The chat enhancement pack (Reply, Search,
  DateTime, and the rest) is now always injected — there is no master on/off switch, only
  the per-feature `claudeCodeUiPatch.feature.<id>` settings from 1.2.0.
- The panel's two sections (**Chat Panel or Tab**, **Plan Mode Markdown Preview**) now lay
  out side-by-side in a 2-column grid instead of one long vertical list, and the Chat
  Enhancement Features checkboxes sit at the top of the first column (a 2-column grid of
  their own on a wide-enough panel) instead of requiring a scroll to reach.

## 1.2.0

- Add `claudeCodeUiPatch.chatEnhancements`: a pack of 15 chat-webview features — Reply on
  selection, Chat Search (Ctrl+F), message date/time stamps with day separators, an
  AskUserQuestion Markdown/newline render fix, a distinct style for your own messages,
  restyled blockquote/tool-interrupt callouts, per-message Copy (Markdown/HTML) + timestamp,
  a Copy button on every fenced code block, an outline panel, chat export
  (Markdown/HTML/clipboard), jump-to-first/latest, collapse the AskUserQuestion dialog,
  auto-continue on a stream-error banner, composer draft autosave, and jump between your own
  messages. Injected as one CSP-safe inline script block (default off; requires a window
  reload after enabling).
- Add one `claudeCodeUiPatch.feature.<id>` boolean per chat-enhancement feature (15 settings)
  to turn it on/off; the panel grows a **Chat Enhancement Features** section with one
  checkbox per feature as the single control surface (checking/unchecking re-patches
  immediately; takes effect on the next window reload, like every other patch setting).
- Add `claudeCodeUiPatch.chatHideUsageWarning`: permanently hide the "You've used X% of your
  weekly limit" usage banner and its "View usage" link, instead of it reappearing after each
  dismissal.

## 1.1.2

- Retire the `Claude Code UI Patch: Restore Font Sizes` command. Use the panel's **Factory Reset** button instead, which reverts every setting (not just font sizes) to Claude Code's native values.
- Panel polish: the "Reload Window" link is always a badge now (green when everything is applied, yellow when a reload is pending), so it no longer changes size between states. "Restore Last Applied" recedes to a quiet outline when there is nothing to revert, and turns solid green only while a reload is pending.
- Panel header: the target version reads as a light "Patching: " followed by a clay-colored "Claude Code v…" rather than a filled badge, and the status line is now a full-width banner (green when applied, yellow when a reload is due or the version is unsupported) rather than tinted text.

## 1.1.1

- Fix `claudeCodeUiPatch.chatShowMoreAndLessAlign`: pinning the "Show more" button no longer enlarges the message box vertically when it appears on hover. It keeps its native absolute positioning (only the horizontal anchor is forced) instead of being dropped into normal flow, which had added the button's height to the box.

## 1.1.0

- Add `claudeCodeUiPatch.chatHistoryFontSize`: a font size for the agent responses only, private to Claude Code. The input box, interface, your own messages, and other chat extensions stay on the shared native `chat.fontSize`. `0` follows `chat.fontSize`. Replaces the panel's native `chat.fontSize` knob.
- Add `claudeCodeUiPatch.chatHistoryFontFamily`: a font family for the agent responses only. The interface and input box stay in the native UI font, which also keeps the input caret aligned.
- Add `claudeCodeUiPatch.chatCodeInlineFontSize`: size chat inline code separately from fenced blocks. `0` follows `chatCodeblockFontSize`.
- Add `claudeCodeUiPatch.chatPermissionCodeMatchChatCodeblock`: match the permission command block to the tool input block size (`0.85em` instead of `0.9em`).
- Add `claudeCodeUiPatch.chatShowMoreAndLessAlign`: pin the chat "Show more" and "Show less" buttons to `left` or `right`. Empty follows the native (drifting) position.
- Add `claudeCodeUiPatch.planPreviewFontFamily`: a font family for the Plan Mode preview panel.
- Add `claudeCodeUiPatch.planPreviewCodeInlineFontSize`: size plan-preview inline code separately from fenced blocks. `0` follows `planPreviewCodeblockFontSize`.
- Add `claudeCodeUiPatch.planPreviewCommentInputRows`: the select-and-comment box height in rows. `0` follows the native height (about 3).
- Unify the setting descriptions into a concise, consistent style.
- Highlight the panel's Reload Window link while a reload is pending.

## 1.0.3

- Improve README

## 1.0.2

- Include `claudeCodeUiPatch.effortSyncFix`

## 1.0.1

- Include example UI Patch configuration panel figures

## 1.0.0

Initial release. Adds settings that reach font sizes and a few behaviors Claude Code otherwise pins, by editing the installed extension's bundled files in place and reverting cleanly on demand.

### Highlights

- **Chat panel/tab:** code-block font size, plus the Edit-diff card's font size, its line-number gutter, and light/dark theme sync (the latter two as on/off toggles). The native `chat.fontSize` is surfaced alongside them.
- **Plan-mode Markdown preview:** font sizes for the rendered text, code, selected-text quote, comment input, and comment badge.
- **Status bar + panel:** hover the status bar for current values; open the panel for `▼`/`▲` sizing, On/Off toggles, per-knob sync dots, and Discard / Restore.
- **Resilient:** native values are captured per Claude Code version, and settings are re-applied after a Claude Code update reverts the patch.

### Commands

- `Claude Code UI Patch: Open Panel`
- `Claude Code UI Patch: Restore Font Sizes`
