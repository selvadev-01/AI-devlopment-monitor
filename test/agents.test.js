// Subagents: each one is bound to the exact launch (via Claude Code's meta file), parallel agents get
// distinct colours, and a guessed binding is corrected once the meta file appears.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';

const PORT = 7841;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-test-'));
const root = path.join(tmp, 'proj');
const transcript = path.join(tmp, 'claude', 'sess.jsonl');
const metaDir = path.join(tmp, 'claude', 'sess', 'subagents');
let server;

const post = (body) => fetch(`http://127.0.0.1:${PORT}/event`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session_id: 'sess', cwd: root, transcript_path: transcript, ...body }),
});
const launch = (i, type, description) => post({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: `toolu_${i}`, tool_input: { description, subagent_type: type } });
const read = (agent, type, file) => post({ hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: agent, agent_type: type, tool_input: { file_path: path.join(root, file) } });
const meta = (agent, i, type, description) => fs.writeFileSync(path.join(metaDir, `agent-${agent}.meta.json`), JSON.stringify({ agentType: type, description, toolUseId: `toolu_${i}` }));
const lastLabel = async (agent) => {
  const { events } = await (await fetch(`http://127.0.0.1:${PORT}/api/state?project=${encodeURIComponent(root)}`)).json();
  return events.filter((e) => e.agent === agent).at(-1);
};

before(async () => {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const f of ['a', 'b', 'c']) fs.writeFileSync(path.join(root, 'src', `${f}.ts`), `export const ${f} = 1;\n`);
  fs.mkdirSync(metaDir, { recursive: true });
  server = await startServer({ port: PORT, project: root, dataDir: path.join(tmp, 'data'), silent: true });
  await post({ hook_event_name: 'SessionStart', source: 'startup' });
});
after(async () => { await server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('three Explore agents starting in reverse order get their own task labels (meta file present)', async () => {
  const tasks = ['Map auth', 'Find refunds', 'Trace jobs'];
  for (const [i, t] of tasks.entries()) { await launch(i, 'Explore', t); meta(`x${i}`, i, 'Explore', t); }
  for (const i of [2, 1, 0]) await read(`x${i}`, 'Explore', 'src/a.ts'); // oldest-launch guessing would swap 0 and 2
  for (const [i, t] of tasks.entries()) assert.equal((await lastLabel(`x${i}`)).agentLabel, t);
  const colours = await Promise.all(tasks.map(async (_, i) => (await lastLabel(`x${i}`)).agentColor));
  assert.equal(new Set(colours).size, 3, 'parallel agents never share a colour');
  for (const i of [0, 1, 2]) await post({ hook_event_name: 'SubagentStop', agent_id: `x${i}`, agent_type: 'Explore' });
});

test('a guessed binding is corrected when the meta file appears later', async () => {
  await launch(10, 'Explore', 'First task');
  await launch(11, 'Explore', 'Second task');
  await read('y11', 'Explore', 'src/b.ts'); // no meta yet: guessed as the oldest launch, "First task"
  assert.equal((await lastLabel('y11')).agentLabel, 'First task');
  meta('y11', 11, 'Explore', 'Second task');
  await read('y11', 'Explore', 'src/c.ts');
  assert.equal((await lastLabel('y11')).agentLabel, 'Second task');
  meta('y10', 10, 'Explore', 'First task');
  await read('y10', 'Explore', 'src/a.ts');
  assert.equal((await lastLabel('y10')).agentLabel, 'First task');
});

test('/api/health identifies the monitor', async () => {
  const h = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();
  assert.equal(h.app, 'ai-dev-monitor');
  assert.equal(h.port, PORT);
  assert.equal(h.standalone, false); // started from code, like inside VS Code
});

test('/api/doctor reports the hooks that arrived and how each subagent was bound', async () => {
  const { version, sessions } = await (await fetch(`http://127.0.0.1:${PORT}/api/doctor`)).json();
  assert.ok(version);
  const s = sessions.find((x) => x.session === 'sess');
  assert.ok(s.hooks.PreToolUse > 0 && s.hooks.SessionStart === 1);
  assert.deepEqual(s.launches, { withId: 5, withoutId: 0 });
  assert.deepEqual(s.agents, { exact: 4, guessed: 0, corrected: 1 });
  assert.equal(s.transcript, transcript);
  assert.equal(s.transcriptExists, false);
});
