#!/usr/bin/env node
// Adds (or removes) the monitor's Claude Code hooks.
//   node scripts/install-hooks.js                 -> ~/.claude/settings.json (all projects)
//   node scripts/install-hooks.js --project DIR   -> DIR/.claude/settings.local.json (one project)
//   add --uninstall to remove. A .bak backup is written before any change.
//   By default the hooks are Claude Code "http" hooks: Claude POSTs each event straight to the
//   monitor, with no process to start, so tool calls are not slowed down. Add --command to use
//   the old node script instead (as a non-blocking async hook).
//   SessionStart also gets an async command hook (scripts/ensure-server.js) that starts the monitor
//   in the background when it is not running, so Claude in a plain terminal needs no `npm start`.
//   Add --no-autostart to leave it out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SENDER = path.resolve(HERE, '..', 'hooks', 'send-event.js').split(path.sep).join('/');
const MARKER = 'send-event.js';
const ENSURE = path.resolve(HERE, 'ensure-server.js').split(path.sep).join('/');
const ENSURE_MARKER = 'ensure-server.js';
const COMMAND = `node "${SENDER}"`;
const PORT = Number(process.env.MONITOR_PORT || 7777);
const URL_ = `http://127.0.0.1:${PORT}/event`;

const TOOL_EVENTS = ['PreToolUse', 'PostToolUse'];
const PLAIN_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'Notification'];

const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const pIdx = args.indexOf('--project');
const target = pIdx > -1
  ? path.join(path.resolve(args[pIdx + 1]), '.claude', 'settings.local.json')
  : path.join(os.homedir(), '.claude', 'settings.json');

let settings = {};
if (fs.existsSync(target)) {
  const raw = fs.readFileSync(target, 'utf8');
  try { settings = raw.trim() ? JSON.parse(raw) : {}; } catch (e) {
    console.error(`Could not parse ${target}: ${e.message}. Nothing changed.`);
    process.exit(1);
  }
  fs.writeFileSync(target + '.bak', raw);
}
settings.hooks ??= {};

// Our entries, old (command) or new (http on 127.0.0.1/event), so re-installs replace them.
const isOurs = (group) => (group.hooks || []).some((h) =>
  String(h.command || '').includes(MARKER) || String(h.command || '').includes(ENSURE_MARKER)
  || /^http:\/\/127\.0\.0\.1:\d+\/event$/.test(String(h.url || '')));
const autostart = !args.includes('--no-autostart');
const useCommand = args.includes('--command');
const hook = useCommand
  ? { type: 'command', command: COMMAND, async: true }
  : { type: 'http', url: URL_, timeout: 3 };

for (const evt of [...TOOL_EVENTS, ...PLAIN_EVENTS]) {
  const groups = (settings.hooks[evt] || []).filter((g) => !isOurs(g));
  if (!uninstall) {
    const group = { hooks: [{ ...hook }] };
    if (TOOL_EVENTS.includes(evt)) group.matcher = '*';
    groups.push(group);
    if (evt === 'SessionStart' && autostart) {
      // a custom port is passed as an argument (an env prefix does not work in every shell)
      const portArg = PORT === 7777 ? '' : ` --port ${PORT}`;
      groups.push({ hooks: [{ type: 'command', command: `node "${ENSURE}"${portArg}`, async: true, timeout: 15 }] });
    }
  }
  if (groups.length) settings.hooks[evt] = groups; else delete settings.hooks[evt];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(settings, null, 2) + '\n');
console.log(`${uninstall ? 'Removed' : `Installed ${useCommand ? 'async command' : 'http'}`} monitor hooks ${uninstall ? 'from' : 'in'} ${target}`);
if (!uninstall && autostart) console.log('SessionStart also starts the monitor in the background when it is not running.');
if (!uninstall) console.log('Restart Claude Code (or open a new session) so it picks up the hooks.');
