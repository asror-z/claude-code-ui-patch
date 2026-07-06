# Changelog

All notable changes to Claude Code UI Patch are documented here. This project follows [Semantic Versioning](https://semver.org).

## Supported versions

| Claude Code | UI Patch |
| ----------- | -------- |
| 2.1.201+    | 1.1.x    |

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
