// Installing the monitor's hooks into a Claude Code settings file keeps everything else in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHooks, hooksStatus, ALL_EVENTS } from '../server/hooks.js';

const user = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard' }] }] } };

test('install adds an http hook for every event and keeps the user\'s own hooks and settings', () => {
  const s = applyHooks(user, { port: 7777 });
  assert.equal(s.model, 'opus');
  for (const e of ALL_EVENTS) assert.ok(s.hooks[e].some((g) => g.hooks[0].url === 'http://127.0.0.1:7777/event'), e);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'my-guard');
  assert.equal(s.hooks.PreToolUse[1].matcher, '*');
  assert.equal(user.hooks.PreToolUse.length, 1, 'input not changed');
  assert.equal(hooksStatus(s, 7777).installed, true);
});

test('re-installing replaces our hooks (no duplicates), also when the port changes', () => {
  const s = applyHooks(applyHooks(user, { port: 7777 }), { port: 7790 });
  assert.equal(s.hooks.Stop.length, 1);
  assert.equal(s.hooks.Stop[0].hooks[0].url, 'http://127.0.0.1:7790/event');
  const st = hooksStatus(applyHooks(user, { port: 7790 }), 7777);
  assert.equal(st.installed, false); assert.equal(st.wrongPort, true); assert.deepEqual(st.ports, [7790]);
});

test("the extension's 'keep' leaves the CLI auto-start hook alone; uninstall removes everything of ours", () => {
  const cli = applyHooks(user, { port: 7777, autostart: 'node "/repo/scripts/ensure-server.js"' });
  const ext = applyHooks(cli, { port: 7777, autostart: 'keep' });
  assert.ok(ext.hooks.SessionStart.some((g) => g.hooks[0].command?.includes('ensure-server.js')));
  assert.equal(applyHooks(user, { port: 7777, autostart: 'keep' }).hooks.SessionStart.length, 1);
  const gone = applyHooks(ext, { uninstall: true });
  assert.deepEqual(gone, user);
  assert.deepEqual(hooksStatus(gone).missing, ALL_EVENTS);
});
