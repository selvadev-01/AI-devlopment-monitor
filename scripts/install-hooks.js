#!/usr/bin/env node
// Adds (or removes) the monitor's Claude Code hooks.
//   node scripts/install-hooks.js                 -> ~/.claude/settings.json (all projects)
//   node scripts/install-hooks.js --project DIR   -> DIR/.claude/settings.local.json (one project)
//   add --uninstall to remove. A .bak backup is written before any change.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SENDER = path.resolve(HERE, '..', 'hooks', 'send-event.js').split(path.sep).join('/');
const MARKER = 'send-event.js';
const COMMAND = `node "${SENDER}"`;

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

const isOurs = (group) => (group.hooks || []).some((h) => String(h.command || '').includes(MARKER));

for (const evt of [...TOOL_EVENTS, ...PLAIN_EVENTS]) {
  const groups = (settings.hooks[evt] || []).filter((g) => !isOurs(g));
  if (!uninstall) {
    const group = { hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] };
    if (TOOL_EVENTS.includes(evt)) group.matcher = '*';
    groups.push(group);
  }
  if (groups.length) settings.hooks[evt] = groups; else delete settings.hooks[evt];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(settings, null, 2) + '\n');
console.log(`${uninstall ? 'Removed' : 'Installed'} monitor hooks ${uninstall ? 'from' : 'in'} ${target}`);
if (!uninstall) console.log('Restart Claude Code (or open a new session) so it picks up the hooks.');
