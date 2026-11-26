# AI Dev Monitor

Live 3D view of what Claude Code is doing in your project. Every Read, Edit, new file,
test run and subagent shows up as an animation, in one of two themes:

| Neural | Galaxy |
|---|---|
| ![Neural](docs/neural.webp) | ![Galaxy](docs/galaxy.webp) |

- **Neural**: files are neurons and imports are connections. An edit sends pulses to every file that depends on it, so you can see the impact of a change.
- **Galaxy**: modules are star systems and files are planets. Claude is a ship that scans (Read), builds (Edit) and forms new planets (Write).

Switch themes with the toggle in the top bar or press `T`. Press `F` to go back to the overview, and double-click a node to focus it.

## Textures

| Neural close-up | Galaxy |
|---|---|
| ![Neural close-up](docs/neural-closeup.webp) | ![Galaxy textured](docs/galaxy-textured.webp) |

The surface textures in [web/textures/](web/textures/) (about 1 MB) were generated locally with ComfyUI (Z-Image Turbo), cropped, and made to wrap seamlessly around a sphere:

- **Galaxy**: six planet surfaces (gas giant, rocky, ice, lava, ocean, desert), chosen per file and lightly tinted with the module colour. Planets also get a drifting cloud layer, a soft day/night terminator, an atmosphere rim in the module colour, procedural rings on some planets, and a Milky Way panorama behind the scene.
- **Neural**: an electron-microscopy membrane texture on each neuron body, with a translucent rim, and a fluorescence-microscopy bokeh panorama. Halos fade as the camera gets close, so the membrane detail shows.

To restyle, replace a `.jpg` in `web/textures/` with an image of the same name. Planet maps must be 2:1 equirectangular, and the left and right edges must match.

## Session replay

![Replay timeline](docs/replay.webp)

The bar under the 3D view replays any recorded session:

- Pick a session from the dropdown. Sessions come from the event log and are labelled with project, start time, event count and first prompt.
- Use ▶/⏸ (or `Space`) to play and pause, and `1×`/`2×`/`4×`/`8×` to change speed. Drag the track or press `←`/`→` (±5 s) to seek.
- Markers on the track are coloured by event kind. Tall markers are test results and new files. Hover the track to see what happened at that moment.
- Idle gaps longer than 3 s are compressed, so a long session plays back quickly.
- Seeking rebuilds the exact state at that moment: changed files, new files, failing tests and the 3D colours. Files created during the session are hidden until their create event.
- Live events that arrive during a replay are counted on the button (`LIVE · 3 new`). Click **LIVE** (or press `Esc`) to return to the live view.

## Quick start

```bash
npm install
npm start            # opens the monitor on http://localhost:7777
npm run demo         # in a second terminal: plays a scripted session, no Claude needed
```

## Connect Claude Code

The monitor gets its events from Claude Code hooks. To install them:

```bash
npm run hooks:install                            # all projects  (~/.claude/settings.json)
node scripts/install-hooks.js --project D:/my-app   # one project (.claude/settings.local.json)
npm run hooks:uninstall                          # remove them again
```

The installer writes a `.bak` backup before it changes the settings file. Start a new Claude Code session after installing.

Keep `npm start` running. The monitor follows whichever project Claude is working in.
Each hook is a small Node script, [hooks/send-event.js](hooks/send-event.js). It has a timeout of under a second, always exits 0 and prints nothing, so Claude is never slowed down or blocked, even when the monitor is off.

## VS Code extension

```bash
npm run ext:install   # bundles server + web into a .vsix (dist/) and installs it with the code CLI
```

Once installed, the extension starts the monitor server inside VS Code, so you don't need `npm start`. If a monitor is already running on the port, it reuses that one, and if that server stops, it takes over the port.

- **Status bar**: shows what Claude is doing right now, for example `Edit users.ts` or `Tests: 1 failed`. Click it to open the 3D panel beside your editor.
- **Commands**: `AI Dev Monitor: Open Monitor`, `Show This Workspace`, `Open in Browser`.
- **Settings**: `aiDevMonitor.port` (default 7777) and `aiDevMonitor.autoStart` (default on).

## Subagents

![Subagents](docs/subagents.webp)

Claude Code adds `agent_id` and `agent_type` to every tool call made inside a subagent. The monitor uses these to follow each subagent separately:

- **Subagents panel (left)**: every running subagent with its type, task (the description it was launched with), current action and tool count. Click one to focus the file it is working on.
- **3D scouts**: each subagent gets its own colour and flies to the files it actually reads and edits. A live tag above it shows what it is doing, for example `Explore · Read auth.ts`. The main agent and the camera stay with the main conversation, so parallel subagents don't make the view jump around.
- **Activity feed**: subagent events carry a coloured chip with the agent type.
- **Replay**: subagent fields are saved in the event log, so all of this works in replay too.

A launch (`Agent` tool) carries no id yet. The subagent's first tool call claims the oldest pending launch of the same type. To check which fields your Claude Code version sends, create `data/debug-hooks`: payload shapes (keys and ids, no file contents) are then written to `data/hook-shapes.jsonl`.

## Several projects in parallel

The server keeps a separate live state for every project: graph, events, changed files, tests and agents. Each hook event goes to its project through the Claude session it belongs to, so two or three Claude sessions working on different projects never mix.

- **VS Code**: every window's panel (`AI Monitor · <folder>`) and status bar show only that window's workspace. With `aiDevMonitor.autoOpen` on (the default), the panel opens without taking focus, and only in the window whose folder the Claude session started in.
- **Browser**: open `http://localhost:7777/?project=D:/path/to/project` to pin a tab to one project. Plain `http://localhost:7777` follows whichever project Claude was most recently started in.
- **Nested folders**: a folder inside another project, like `data/demo-project` here, counts as its own project when you open it as a workspace or start a Claude session in it.
- `GET /api/projects` lists the projects the server is tracking. It keeps up to 12 and drops the least recently active ones that nobody is viewing.

## How it works

```
Claude Code hooks ──POST /event──▶ server (Node, 127.0.0.1:7777) ──WebSocket──▶ browser (Three.js)
                                     │  scans files + imports
                                     └─ data/events.jsonl (event log)
```

| Hook | Event | Neural | Galaxy |
|---|---|---|---|
| PreToolUse `Read` | read | neuron glows cyan, scan rings | ship flies over, scan beam |
| PreToolUse `Edit`/`MultiEdit` | edit | amber pulses to dependents | construction rings, hyperlanes to dependents |
| PreToolUse `Write` (new file) | create | neuron is born with a burst | accretion disk forms a planet |
| `Grep`/`Glob` | search | radar ring | radar ring |
| `Bash` + PostToolUse | bash / test_result | wave through the network, failing paths turn red | pulsar beam, failing planets turn red |
| `Task`/`Agent` + SubagentStop | agent_start / stop | coloured scout orbs | scout ships with trails |
| Stop | idle | camera returns to overview | ship returns to orbit |

Test output is parsed for Jest, Vitest, pytest, Mocha and similar runners (for example `24 passed`, `1 failed`, `FAIL path`).

## Files

- [server/index.js](server/index.js): HTTP + WebSocket server, event store, file watcher
- [server/scanner.js](server/scanner.js): file graph and import resolution (JS/TS, Python, CSS)
- [server/normalize.js](server/normalize.js): turns raw hook payloads into visual events
- [web/engine.js](web/engine.js): renderer, bloom, camera follow, callouts, theme switching
- [web/themes/neural.js](web/themes/neural.js), [web/themes/galaxy.js](web/themes/galaxy.js): the two themes
- [web/app.js](web/app.js): panels, activity feed, WebSocket client

Set `MONITOR_PORT` to use a port other than 7777. To start the monitor on a specific project, use `npm start -- --project D:/my-app`.

## Next steps

- Package as a VS Code extension (webview panel) and a Tauri desktop app
- Timeline scrubber to replay a session from `data/events.jsonl`
- Attribute tool calls to their subagent once hooks expose an agent id
