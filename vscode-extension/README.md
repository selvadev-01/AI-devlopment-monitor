# AI Dev Monitor

Live 3D view of what Claude Code is doing in your project, inside VS Code.

- **Status bar**: shows Claude's current action (Read, Edit, Testing…). Click it to open the monitor.
- **AI Dev Monitor: Open Monitor**: opens the Neural / Galaxy 3D view beside your editor.
- **AI Dev Monitor: Show This Workspace**: switches the view to the open folder.
- **AI Dev Monitor: Open in Browser**: opens the same view in your browser.

The extension starts the monitor server on `127.0.0.1:7777` when VS Code starts. If a server is already running there, it reuses that one. Events come from Claude Code hooks; install them from the main project with `npm run hooks:install`.

Settings: `aiDevMonitor.port` (default 7777) and `aiDevMonitor.autoStart` (default on).
