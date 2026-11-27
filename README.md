# AI Dev Monitor

Live 3D view of what Claude Code is doing in your project. Every Read, Edit, new file,
test run and subagent shows up as an animation, in one of two themes:

| Neural | Galaxy |
|---|---|
| ![Neural](docs/neural.webp) | ![Galaxy](docs/galaxy.webp) |

- **Neural**: files are neurons and imports are connections. An edit sends pulses to every file that depends on it, so you can see the impact of a change.
- **Galaxy**: modules are star systems and files are planets. Claude is a ship that scans (Read), builds (Edit) and forms new planets (Write).

Switch themes with the toggle in the top bar or press `T`. Press `F` to go back to the overview.

- **Find a file**: press `/` (or click the search box in the left panel) and type part of a name or path. `Enter` flies the camera to the file; `Ctrl+Enter` opens it in the editor.
- **Open in the editor**: click a file in the 3D view to fly to it, double-click it to open it. Rows in the search results and the changed-files list have an `open` button. Inside the VS Code panel the file opens in the main editor; in a browser it opens through a `vscode://file/…` link.

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

Demo options (after `npm run demo --`): `--loop` repeats it, `--project D:/my-app` plays it on a real project's files (read-only), and `--swarm 10` launches ten subagents that work in parallel.

Each subagent is matched to the exact Task/Agent call that launched it: Claude Code writes `<session>/subagents/agent-<id>.meta.json` next to the session transcript with that call's `tool_use_id`, and the monitor reads it when the subagent's first tool call arrives. If the file is not there yet, it guesses from the oldest launch of the same type and corrects the task label as soon as the file appears.

With many subagents at once, every agent gets its own colour (ten colours), crowded tags shrink to coloured dots, the overview pulls back so every ship stays in frame, the activity feed groups their parallel actions ("READ · 10 agents"), and the Subagents panel switches to one line per agent.

## Needs-you alerts

The monitor tells you when Claude is waiting for you, even when you are in another window:

- **When**: Claude asks for permission, asks you a question (AskUserQuestion), waits for your input, or finishes a turn that took longer than 30 seconds. Short back-and-forth replies stay quiet, subagents never alert, and you get no second reminder after a "finished" alert.
- **Where**: a desktop notification from the monitor itself (Windows toast, macOS Notification Center, `notify-send` on Linux), so it works for Claude in a terminal with no browser open. Open monitor pages also show a banner, play a short chime and blink the tab title, and the VS Code status bar turns amber until Claude works again.
- **Control**: the bell button in the top bar, or `adm alerts on | off | test`. The setting is kept in `data/settings.json` (`alerts`, `doneAfterSec`).

## Session summary

When a turn that took longer than 30 seconds ends, a card shows what Claude did in the session: duration, prompts, files read / edited / created, lines added and removed, the last test result, subagents, commands, the modules it worked in, and the files that changed most (click to fly there, `open` to open it). The **Summary** button in the top bar shows it any time, for the live session or for the session picked in the replay timeline. The numbers come from the full event log (`GET /api/summary`).

## Tokens and cost

The top bar shows how many tokens the current session has used and what that would cost at Anthropic API list prices, for example `$1.84 · 2.3M tok`. Hover over it to see the split by model and token type (output, cache reads, cache writes, input). Click it to open the session summary, which has a **Tokens & cost** section: one row per model, the main agent, and each subagent with its task. Each running subagent also shows its own cost in the Subagents panel.

Hooks don't carry token counts, so the server reads them from the transcripts Claude Code writes under `~/.claude/projects/` (the session's `.jsonl` file, plus `<session>/subagents/agent-<id>.jsonl` for each subagent). It only reads these files and never changes them. It reads only the new lines on each refresh, and it counts a response written across several lines once. The prices are in [server/usage.js](server/usage.js): input, output, 5-minute and 1-hour cache writes, and cache reads, per model. Fast mode costs twice as much. Responses from models not in the table are counted as tokens but not priced. If you use a Pro or Max plan, you are not billed per token; the figure shows what the same work would cost on the API. `GET /api/usage` (`?key=` for a recorded session) returns the same numbers. The demo writes a made-up transcript to `data/demo-transcripts`, so the view has numbers to show.

## Claude Code in a terminal (CLI)

The hooks are installed in `~/.claude/settings.json`, so `claude` in any terminal reports to the monitor just like the VS Code extension does. A `SessionStart` hook (`scripts/ensure-server.js`, async, never blocks Claude) starts the monitor in the background when it is not running, so there is no `npm start` to remember. VS Code and the terminal share one monitor on port 7777.

Run `npm link` once in this folder to get the `adm` command:

```bash
adm              # start the monitor if needed and open it for the current folder
adm open [dir]   # open it for another folder (one browser tab per project)
adm start        # start it in the background, no browser
adm status       # running? where? which projects has it seen?
adm stop         # stop a monitor started from the terminal (the VS Code one stops with VS Code)
adm doctor       # check everything from Claude Code to the monitor; --toast also sends a test notification
```

`adm doctor` checks each step that has to work for the monitor to show a session. For each problem it finds, it prints the fix:

- **Hooks:** they are in a Claude Code settings file, cover all 7 events and send to the right port. It also warns when they are installed twice, because then every event arrives twice, and when the auto-start script path no longer exists.
- **Monitor:** it runs, its version matches this checkout, and it is not an old monitor still running inside VS Code.
- **Latest real session:** which hooks actually arrived and whether the transcript can be read for tokens. It also checks whether each subagent was matched to its launch exactly, through `tool_use_id` and the `agent-<id>.meta.json` file, or only by guess.
- **Alerts:** they are on, and the system tool that shows desktop notifications is there.

The command exits with code 1 when something is broken. The monitor's own view of what arrived is at `GET /api/doctor`.

The background monitor logs to `data/server.log`. Install the hooks without the auto-start with `node scripts/install-hooks.js --no-autostart`.

## Connect Claude Code

The monitor gets its events from Claude Code hooks. To install them:

```bash
npm run hooks:install                            # all projects  (~/.claude/settings.json)
node scripts/install-hooks.js --project D:/my-app   # one project (.claude/settings.local.json)
npm run hooks:uninstall                          # remove them again
```

The installer writes a `.bak` backup before it changes the settings file. Start a new Claude Code session after installing.

Keep `npm start` running (or use the VS Code extension, which runs the server for you). The monitor follows whichever project Claude is working in.

The installed hooks are Claude Code **`http` hooks**: Claude POSTs each event straight to `http://127.0.0.1:7777/event`, and no process is started per tool call. On a Windows laptop, starting a hook process took about 0.6 s, twice per tool call, so this keeps Claude fast. The server answers `204` with an empty body, so Claude has no hook output to act on. To use the older node script instead, run `node scripts/install-hooks.js --command`; it is installed as an `async` hook, so it never blocks Claude.

## Performance

| Setting `aiDevMonitor.quality` (or `?quality=` in the browser) | What it turns on |
|---|---|
| `low` | pixel ratio 1, no MSAA, 30 fps (10 when idle) |
| `balanced` (default) | MSAA, 60 fps (20 when idle) |
| `high` | full pixel ratio, 60 fps (30 when idle) |

Rendering drops to the idle frame rate after 6 s without events or input, and stops completely while the panel or tab is hidden. The server itself uses about 55 MB of RAM.

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
- [server/usage.js](server/usage.js): token counts and estimated cost from Claude Code transcripts
- [web/engine.js](web/engine.js): renderer, bloom, camera follow, callouts, theme switching
- [web/themes/neural.js](web/themes/neural.js), [web/themes/galaxy.js](web/themes/galaxy.js): the two themes
- [web/app.js](web/app.js): panels, activity feed, WebSocket client

Set `MONITOR_PORT` to use a port other than 7777. To start the monitor on a specific project, use `npm start -- --project D:/my-app`.

## Next steps

- Package as a VS Code extension (webview panel) and a Tauri desktop app
- Timeline scrubber to replay a session from `data/events.jsonl`
- Attribute tool calls to their subagent once hooks expose an agent id
