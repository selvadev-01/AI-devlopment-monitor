// When does Claude "need you"? Permission prompts and questions always; the end of a turn only
// when the turn was long; never for subagents; no repeated reminder after a "finished" alert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAlert, DEFAULT_SETTINGS } from '../server/alerts.js';

const S = DEFAULT_SETTINGS; // finished alert after 30 s
const prompt = { kind: 'prompt' };
const idle = { kind: 'idle' };
const notify = (message, notification_type) => [{ kind: 'notify', detail: message }, { message, notification_type }];

test('a permission prompt always alerts', () => {
  const st = {};
  const a = decideAlert(st, ...notify('Claude needs your permission to use Bash', 'permission_prompt'), 1000, S);
  assert.equal(a.level, 'needs');
  assert.equal(a.title, 'Claude needs your permission');
});

test('a question from Claude alerts with the question text', () => {
  const a = decideAlert({}, { kind: 'ask', detail: 'Which database should I use?' }, {}, 1000, S);
  assert.equal(a.title, 'Claude has a question');
  assert.equal(a.message, 'Which database should I use?');
});

test('a short turn ends quietly, a long one alerts "finished"', () => {
  const st = {};
  decideAlert(st, prompt, {}, 0, S);
  assert.equal(decideAlert(st, idle, {}, 10_000, S), null);
  decideAlert(st, prompt, {}, 20_000, S);
  const a = decideAlert(st, idle, {}, 20_000 + 95_000, S);
  assert.equal(a.level, 'done');
  assert.match(a.message, /2 min/);
});

test('after a "finished" alert the idle reminder does not alert again', () => {
  const st = {};
  decideAlert(st, prompt, {}, 0, S);
  assert.ok(decideAlert(st, idle, {}, 60_000, S));
  assert.equal(decideAlert(st, ...notify('Claude is waiting for your input', 'idle_prompt'), 120_000, S), null);
});

test('the idle reminder alerts when the turn was too short for a "finished" alert', () => {
  const st = {};
  decideAlert(st, prompt, {}, 0, S);
  decideAlert(st, idle, {}, 5_000, S);
  assert.equal(decideAlert(st, ...notify('Claude is waiting for your input', 'idle_prompt'), 65_000, S).title, 'Claude is waiting for you');
});

test('subagents never alert', () => {
  assert.equal(decideAlert({}, { kind: 'ask', agent: 'a1', detail: '?' }, {}, 0, S), null);
});

test('the "finished" threshold comes from the settings', () => {
  const st = {};
  decideAlert(st, prompt, {}, 0, S);
  assert.ok(decideAlert(st, idle, {}, 6_000, { ...S, doneAfterSec: 5 }));
});
