// Claude Code hook payloads -> monitor events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHook, parseTestOutput } from '../server/normalize.js';

const pre = (tool_name, tool_input, extra = {}) => normalizeHook({ hook_event_name: 'PreToolUse', session_id: 's', tool_name, tool_input, ...extra });

test('read / edit / write become read / edit / create with line stats', () => {
  assert.equal(pre('Read', { file_path: '/p/a.ts' }).kind, 'read');
  const e = pre('Edit', { file_path: '/p/a.ts', old_string: 'a\nb', new_string: 'a\nb\nc' });
  assert.equal(e.kind, 'edit');
  assert.deepEqual(e.stats, { added: 3, removed: 2 });
  assert.equal(pre('Write', { file_path: '/p/new.ts', content: 'x' }).kind, 'create');
});

test('a Task/Agent call is a subagent launch and keeps its tool_use_id', () => {
  const e = pre('Task', { description: 'Map the auth flow', subagent_type: 'Explore' }, { tool_use_id: 'toolu_1', transcript_path: '/t/s.jsonl' });
  assert.equal(e.kind, 'agent_start');
  assert.equal(e.launchType, 'Explore');
  assert.equal(e.detail, 'Map the auth flow');
  assert.equal(e.toolUseId, 'toolu_1');
  assert.equal(e.transcript, '/t/s.jsonl');
});

test('tool calls inside a subagent carry its id and type', () => {
  const e = pre('Read', { file_path: '/p/a.ts' }, { agent_id: 'a1', agent_type: 'Explore' });
  assert.equal(e.agent, 'a1');
  assert.equal(e.agentType, 'Explore');
});

test('injected <tags> are stripped from prompts', () => {
  const e = normalizeHook({ hook_event_name: 'UserPromptSubmit', prompt: '<system-reminder>noise</system-reminder>fix the login bug' });
  assert.equal(e.kind, 'prompt');
  assert.equal(e.detail, 'fix the login bug');
});

test('SubagentHandback is ignored', () => {
  assert.equal(pre('SubagentHandback', {}), null);
});

test('test runner output gives pass/fail counts', () => {
  const r = parseTestOutput('PASS tests/a.spec.ts\nFAIL tests/b.spec.ts\n\nTests:       1 failed, 24 passed, 25 total');
  assert.equal(r.passed, 24);
  assert.equal(r.failed, 1);
  assert.deepEqual(r.failingFiles, ['tests/b.spec.ts']);
});
