// adm doctor: each check turns what it finds into ok / warn / fail with a fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHooks, checkServer, checkSession, checkAlerts, REQUIRED_HOOKS } from '../scripts/doctor.js';

const http = (port) => ({ hooks: [{ type: 'http', url: `http://127.0.0.1:${port}/event` }] });
const installed = (port = 7777, ensure = 'node "/repo/scripts/ensure-server.js"') => {
  const hooks = {};
  for (const e of REQUIRED_HOOKS) hooks[e] = [http(port)];
  hooks.SessionStart.push({ hooks: [{ type: 'command', command: ensure }] });
  return { hooks };
};
const levels = (fs) => fs.map((x) => x.level);

test('hooks: missing, complete, wrong port, duplicated, moved auto-start', () => {
  assert.equal(checkHooks([{ file: 'u', settings: {} }], 7777)[0].level, 'fail');
  assert.deepEqual(levels(checkHooks([{ file: 'u', settings: installed() }], 7777, () => true)), ['ok']);
  assert.match(checkHooks([{ file: 'u', settings: installed(7790) }], 7777, () => true).find((x) => x.level === 'fail').text, /port 7790/);
  assert.match(checkHooks([{ file: 'u', settings: installed() }, { file: 'p', settings: installed() }], 7777, () => true)[0].text, /sent 2 times/);
  assert.match(checkHooks([{ file: 'u', settings: installed() }], 7777, () => false).at(-1).text, /no longer exists/);
  const partial = installed(); delete partial.hooks.Stop;
  assert.match(checkHooks([{ file: 'u', settings: partial }], 7777, () => true)[0].text, /no monitor hook for Stop/);
});

test('server: not running, old version, matching version', () => {
  assert.equal(checkServer(null, '0.2.5', 7777)[0].level, 'fail');
  assert.equal(checkServer({ standalone: false, version: '0.2.4' }, '0.2.5', 7777)[1].level, 'warn');
  assert.deepEqual(levels(checkServer({ standalone: true, pid: 1, version: '0.2.5' }, '0.2.5', 7777)), ['ok']);
});

const session = (o = {}) => ({
  session: 'abcdef123456', root: '/w/app', lastAt: new Date(0).toISOString(),
  hooks: { SessionStart: 1, UserPromptSubmit: 2, PreToolUse: 9, PostToolUse: 9, Stop: 2 }, notificationTypes: {},
  transcript: '/t.jsonl', transcriptExists: true, usage: { requests: 12, tokens: 50000, cost: 0.42, unpriced: 0 },
  launches: { withId: 2, withoutId: 0 }, agents: { exact: 2, guessed: 0, corrected: 0 }, ...o,
});

test('session: a healthy session is all ok', () => {
  assert.deepEqual([...new Set(levels(checkSession(session(), 0)))], ['ok']);
});

test('session: guessed subagents, no tool_use_id, no transcript, unknown model', () => {
  const out = checkSession(session({ launches: { withId: 0, withoutId: 2 }, agents: { exact: 0, guessed: 2, corrected: 0 }, transcript: null }), 0);
  assert.ok(out.some((x) => /without tool_use_id/.test(x.text)));
  assert.ok(out.some((x) => /matched by guess/.test(x.text)));
  assert.ok(out.some((x) => x.level === 'fail' && /transcript_path/.test(x.text)));
  assert.ok(checkSession(session({ usage: { requests: 3, tokens: 9, cost: 0, unpriced: 3 } }), 0).some((x) => /no price/.test(x.text)));
});

test('alerts: off, and no notifier on the system', () => {
  assert.equal(checkAlerts({ alerts: false, doneAfterSec: 30 }, 'win32', () => true)[0].level, 'warn');
  assert.match(checkAlerts({ alerts: true, doneAfterSec: 30 }, 'linux', () => false)[1].text, /notify-send not found/);
});

test('server: an old monitor or another program on the port is told apart from "not running"', () => {
  assert.match(checkServer(null, '0.2.5', 7777, { taken: true, oldMonitor: true })[0].text, /old monitor/);
  assert.match(checkServer(null, '0.2.5', 7777, { taken: true })[0].text, /Another program/);
});
