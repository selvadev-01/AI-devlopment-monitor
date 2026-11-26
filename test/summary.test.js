// Session summary counts from a session's events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSession } from '../server/summary.js';

const t = (s) => `2026-01-01T10:00:${String(s).padStart(2, '0')}.000Z`;
const events = [
  { ts: t(0), kind: 'session' },
  { ts: t(1), kind: 'prompt', detail: 'Add refunds' },
  { ts: t(2), kind: 'read', file: 'src/pay/stripe.ts' },
  { ts: t(3), kind: 'read', file: 'src/pay/stripe.ts' },
  { ts: t(4), kind: 'read', file: 'src/api/orders.ts' },
  { ts: t(5), kind: 'search', detail: 'Grep refund' },
  { ts: t(6), kind: 'edit', file: 'src/pay/stripe.ts', stats: { added: 14, removed: 3 } },
  { ts: t(7), kind: 'create', file: 'src/pay/refund.ts', stats: { added: 40, removed: 0 } },
  { ts: t(8), kind: 'agent_start', agentType: 'Explore' },
  { ts: t(9), kind: 'read', file: 'src/api/users.ts', agent: 'a1' },
  { ts: t(10), kind: 'bash', isTest: true },
  { ts: t(12), kind: 'test_result', ok: false, stats: { passed: 24, failed: 1 }, detail: '1 failed · 24 passed' },
  { ts: t(15), kind: 'idle', alert: { level: 'done' } },
];
const mod = (f) => f.split('/')[1];

test('counts files read, edited and created (a file both read and edited counts as edited)', () => {
  const s = summarizeSession(events, mod);
  assert.deepEqual(s.files, { read: 2, edited: 1, created: 1 });
  assert.deepEqual(s.lines, { added: 54, removed: 3 });
});

test('duration, prompts, tests, subagents, commands, alerts', () => {
  const s = summarizeSession(events, mod);
  assert.equal(s.durationSec, 15);
  assert.equal(s.prompts, 1);
  assert.equal(s.firstPrompt, 'Add refunds');
  assert.equal(s.tests.runs, 1);
  assert.deepEqual({ ok: s.tests.last.ok, failed: s.tests.last.failed }, { ok: false, failed: 1 });
  assert.deepEqual(s.subagents, { count: 1, types: { Explore: 1 } });
  assert.equal(s.commands, 1);
  assert.equal(s.alerts, 1);
});

test('top files: edits first by lines changed, then reads; modules ranked by edits', () => {
  const s = summarizeSession(events, mod);
  assert.deepEqual(s.topFiles.map((f) => f.file).slice(0, 2), ['src/pay/refund.ts', 'src/pay/stripe.ts']);
  assert.equal(s.modules[0].module, 'pay');
  assert.equal(s.modules[0].edits, 2);
});

test('an empty session is all zeros', () => {
  const s = summarizeSession([]);
  assert.equal(s.durationSec, 0);
  assert.equal(s.topFiles.length, 0);
});
