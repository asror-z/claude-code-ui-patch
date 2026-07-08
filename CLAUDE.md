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
