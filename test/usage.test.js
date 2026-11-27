// Token counts and cost estimates read from Claude Code transcripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tokensOf, costOf, priceFor, readTranscript, sessionUsage, findTranscript } from '../server/usage.js';

const usage = (o = {}) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o });
const line = (id, ts, model, u) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage: usage(u) } }) + '\n';

test('cache writes split into 5-minute and 1-hour parts', () => {
  const t = tokensOf(usage({ cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 600 } }));
  assert.deepEqual([t.cacheWrite5m, t.cacheWrite1h], [400, 600]);
});

test('cost uses the model price; fast mode doubles it; unknown models are null', () => {
  const t = { input: 1e6, output: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6 };
  assert.equal(costOf('claude-opus-5-5', t), 4 + 20 + 5 + 8 + 0.2);
  assert.equal(costOf('claude-opus-5-5', t, 'fast'), 2 * (4 + 20 + 5 + 8 + 0.2));
  assert.equal(costOf('some-other-model', t), null);
  assert.equal(priceFor('claude-haiku-4-5-20251001'), priceFor('claude-haiku-4-5'));   // dated id
  assert.notEqual(priceFor('claude-opus-5-5'), priceFor('claude-opus-5'));             // longest prefix wins
});

test('Haiku 5.5 prompts over 100K tokens use the higher rate card', () => {
  const short = costOf('claude-haiku-5-5', { input: 50_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
  const long = costOf('claude-haiku-5-5', { input: 200_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
  assert.equal(short, 0.005);
  assert.equal(long, 0.1);
});

test('a message split over several lines counts once; a torn last line waits for the next read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-usage-'));
  const f = path.join(dir, 's1.jsonl');
  const ts = '2026-01-01T10:00:00.000Z';
  fs.writeFileSync(f, line('m1', ts, 'claude-opus-5-5', { output_tokens: 10 }) + line('m1', ts, 'claude-opus-5-5', { output_tokens: 10 })
    + JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
  assert.equal(readTranscript(f).length, 1);
  const next = line('m2', ts, 'claude-opus-5-5', { output_tokens: 5 });
  fs.appendFileSync(f, next.slice(0, 30));
  assert.equal(readTranscript(f).length, 1);
  fs.appendFileSync(f, next.slice(30));
  assert.equal(readTranscript(f).length, 2);
});

test('session usage: main agent, subagents with their meta, per model, and the time window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-usage-'));
  const proj = path.join(root, 'd--work-app');
  const sub = path.join(proj, 'sess-1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const main = path.join(proj, 'sess-1.jsonl');
  fs.writeFileSync(main, line('a', '2026-01-01T09:00:00.000Z', 'claude-opus-5-5', { output_tokens: 999 })  // before the window
    + line('b', '2026-01-01T10:00:01.000Z', 'claude-opus-5-5', { input_tokens: 100, output_tokens: 50 }));
  fs.writeFileSync(path.join(sub, 'agent-x1.jsonl'), line('c', '2026-01-01T10:00:02.000Z', 'claude-haiku-5-5', { output_tokens: 20 }));
  fs.writeFileSync(path.join(sub, 'agent-x1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find refunds' }));

  assert.equal(findTranscript('sess-1', root), main);
  const u = sessionUsage(main, 'sess-1', { since: Date.parse('2026-01-01T10:00:00.000Z') });
  assert.equal(u.total.requests, 2);
  assert.equal(u.main.output, 50);
  assert.equal(u.total.total, 170);
  assert.deepEqual(Object.keys(u.byModel).sort(), ['claude-haiku-5-5', 'claude-opus-5-5']);
  assert.equal(u.agents.length, 1);
  assert.deepEqual([u.agents[0].id, u.agents[0].type, u.agents[0].label, u.agents[0].output], ['x1', 'Explore', 'Find refunds', 20]);
  assert.ok(Math.abs(u.total.cost - ((100 * 4 + 50 * 20) / 1e6 + (20 * 0.5) / 1e6)) < 1e-12);
});
