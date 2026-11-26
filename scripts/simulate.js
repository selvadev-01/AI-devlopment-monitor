#!/usr/bin/env node
// Plays a scripted Claude Code session against a generated demo project so you can see
// the monitor without running Claude. Usage: npm run demo   (add -- --loop to repeat)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'data', 'demo-project');
const PORT = process.env.MONITOR_PORT || 7777;
const LOOP = process.argv.includes('--loop');
const SPEED = Number(process.env.DEMO_SPEED || 1);

// file -> [imports]; sizes give the graph some variety
const FILES = {
  'src/index.ts': ['src/app.ts'],
  'src/app.ts': ['src/api/router.ts', 'src/config.ts', 'src/utils/logger.ts'],
  'src/config.ts': [],
  'src/api/router.ts': ['src/api/users.ts', 'src/api/orders.ts', 'src/api/auth.ts', 'src/middleware/authGuard.ts', 'src/middleware/rateLimit.ts'],
  'src/api/users.ts': ['src/services/userService.ts', 'src/utils/validate.ts'],
  'src/api/orders.ts': ['src/services/orderService.ts', 'src/utils/validate.ts'],
  'src/api/auth.ts': ['src/auth/auth.ts', 'src/auth/jwt.ts'],
  'src/auth/auth.ts': ['src/auth/jwt.ts', 'src/db/client.ts', 'src/utils/hash.ts'],
  'src/auth/jwt.ts': ['src/config.ts'],
  'src/auth/session.ts': ['src/db/client.ts'],
  'src/middleware/authGuard.ts': ['src/auth/jwt.ts'],
  'src/middleware/rateLimit.ts': ['src/config.ts'],
  'src/services/userService.ts': ['src/db/userRepo.ts', 'src/utils/hash.ts'],
  'src/services/orderService.ts': ['src/db/orderRepo.ts', 'src/payments/stripe.ts'],
  'src/payments/stripe.ts': ['src/config.ts'],
  'src/payments/invoice.ts': ['src/payments/stripe.ts', 'src/utils/format.ts'],
  'src/db/client.ts': ['src/config.ts'],
  'src/db/userRepo.ts': ['src/db/client.ts'],
  'src/db/orderRepo.ts': ['src/db/client.ts'],
  'src/components/App.tsx': ['src/components/Header.tsx', 'src/components/Dashboard.tsx', 'src/components/LoginForm.tsx'],
  'src/components/Header.tsx': ['src/components/Avatar.tsx'],
  'src/components/Avatar.tsx': [],
  'src/components/Dashboard.tsx': ['src/components/OrderTable.tsx', 'src/components/Chart.tsx', 'src/utils/format.ts'],
  'src/components/OrderTable.tsx': ['src/utils/format.ts'],
  'src/components/Chart.tsx': [],
  'src/components/LoginForm.tsx': ['src/utils/validate.ts'],
  'src/utils/logger.ts': [],
  'src/utils/validate.ts': [],
  'src/utils/hash.ts': [],
  'src/utils/format.ts': [],
  'tests/auth.spec.ts': ['src/auth/auth.ts'],
  'tests/users.spec.ts': ['src/api/users.ts'],
  'tests/orders.spec.ts': ['src/api/orders.ts'],
  'tests/format.spec.ts': ['src/utils/format.ts'],
};
const NEW_FILE = 'src/payments/refund.ts';

function relImport(from, to) {
  let r = path.posix.relative(path.posix.dirname(from), to).replace(/\.(ts|tsx)$/, '');
  if (!r.startsWith('.')) r = './' + r;
  return r;
}

function body(file, imports, seed) {
  const head = imports.map((t, i) => `import { dep${i} } from '${relImport(file, t)}';`).join('\n');
  const n = 20 + ((seed * 37) % 160);
  const lines = Array.from({ length: n }, (_, i) => `  // ${path.posix.basename(file)} line ${i}`);
  return `${head}\n\nexport function main() {\n${lines.join('\n')}\n}\n`;
}

function ensureDemoProject() {
  Object.entries(FILES).forEach(([file, imports], i) => {
    const abs = path.join(ROOT, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, body(file, imports, i + 3));
  });
  fs.rmSync(path.join(ROOT, NEW_FILE), { force: true });
}

// --project DIR: play the same session on a real project's files (read-only: nothing is written).
const PI = process.argv.indexOf('--project');
const PROJ = PI > -1 ? path.resolve(process.argv[PI + 1]) : null;
const MAP = new Map();
const POOL = []; // files the swarm demo spreads its subagents over (one busy file per module)
if (PROJ) {
  const { scanProject } = await import('../server/scanner.js');
  const g = scanProject(PROJ);
  const deps = new Map();
  for (const e of g.edges) deps.set(e.target, (deps.get(e.target) || 0) + 1);
  const isTest = (id) => /\.(spec|test)\.[jt]sx?$/.test(id);
  // Busy files (most dependents) from different modules make the edit pulses visible.
  const seen = new Set(); const busy = [];
  for (const n of [...g.nodes].sort((a, b) => (deps.get(b.id) || 0) - (deps.get(a.id) || 0))) {
    if (isTest(n.id) || seen.has(n.module)) continue;
    seen.add(n.module); busy.push(n.id);
  }
  const tests = g.nodes.filter((n) => isTest(n.id)).map((n) => n.id);
  const names = ['src/payments/stripe.ts', 'src/services/orderService.ts', 'src/api/orders.ts', 'src/auth/auth.ts',
    'src/auth/jwt.ts', 'src/api/router.ts', 'src/api/users.ts', 'src/db/orderRepo.ts'];
  names.forEach((n, i) => MAP.set(n, busy[i % busy.length]));
  POOL.push(...busy);
  MAP.set('tests/auth.spec.ts', tests[0] || busy[8] || busy[0]);
  MAP.set('tests/orders.spec.ts', tests[1] || busy[9] || busy[0]);
  MAP.set('src/payments/refund.ts', path.posix.join(path.posix.dirname(MAP.get('src/payments/stripe.ts')), 'refund-demo.ts'));
  console.log(`demo on ${PROJ}: ${g.nodes.length} files, playing on`, [...MAP.values()].slice(0, 4).join(', '), '…');
}
const ROOT_DIR = PROJ || ROOT;
const abs = (f) => path.join(ROOT_DIR, MAP.get(f) || f);
const nLines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SPEED));

async function send(payload) {
  const full = { session_id: 'demo-session', cwd: ROOT_DIR, transcript_path: '', ...payload };
  try {
    await fetch(`http://127.0.0.1:${PORT}/event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(full),
    });
  } catch {
    console.error(`Monitor not reachable on port ${PORT}. Start it first with: npm start`);
    process.exit(1);
  }
}

// `agent` = { agent_id, agent_type }: Claude Code adds these to tool calls made inside a subagent.
const pre = (tool_name, tool_input, agent = {}) => send({ hook_event_name: 'PreToolUse', tool_name, tool_input, ...agent });
const post = (tool_name, tool_input, tool_response, agent = {}) => send({ hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response, ...agent });
const read = (f, agent) => pre('Read', { file_path: abs(f) }, agent);
const edit = (f, add, rem, agent) => pre('Edit', { file_path: abs(f), old_string: nLines(rem), new_string: nLines(add) }, agent);
const stopAgent = (agent) => send({ hook_event_name: 'SubagentStop', ...agent });
const EXPLORE = { agent_id: 'demo-explore', agent_type: 'Explore' };
const REVIEW = { agent_id: 'demo-review', agent_type: 'code-reviewer' };
const DOCS = { agent_id: 'demo-docs', agent_type: 'general-purpose' };
const EDGE = { agent_id: 'demo-edge', agent_type: 'Explore' };

async function session() {
  if (!PROJ) ensureDemoProject(); // never create or delete files in a real project
  await send({ hook_event_name: 'SessionStart', source: 'startup' });
  await sleep(2500);
  await send({ hook_event_name: 'UserPromptSubmit', prompt: 'Add refund support to payments and fix the failing auth test' });
  await sleep(1500);
  await pre('Grep', { pattern: 'refund|charge', path: abs('src') });
  await sleep(1400);
  for (const f of ['src/payments/stripe.ts', 'src/services/orderService.ts', 'src/api/orders.ts']) { await read(f); await sleep(1600); }

  await pre('Task', { description: 'Explore test setup', subagent_type: 'Explore' });
  await sleep(900);
  await read('tests/auth.spec.ts', EXPLORE); await sleep(1300);
  await read('src/auth/auth.ts', EXPLORE); await sleep(1300);
  await stopAgent(EXPLORE);
  await sleep(1200);

  await edit('src/payments/stripe.ts', 14, 3); await sleep(2400);
  const content = body(NEW_FILE, ['src/payments/stripe.ts', 'src/db/orderRepo.ts'], 9);
  await pre('Write', { file_path: abs(NEW_FILE), content });
  if (!PROJ) fs.writeFileSync(abs(NEW_FILE), content);
  await sleep(2800);
  await edit('src/services/orderService.ts', 9, 2); await sleep(2000);
  await edit('src/api/orders.ts', 22, 4); await sleep(2000);

  const test = { command: 'npm test', description: 'Run tests' };
  await pre('Bash', test); await sleep(2600);
  await post('Bash', test, { stdout: `PASS tests/users.spec.ts\nPASS tests/orders.spec.ts\nFAIL ${MAP.get('tests/auth.spec.ts') || 'tests/auth.spec.ts'}\n\nTests:       1 failed, 24 passed, 25 total`, stderr: '', interrupted: false });
  await sleep(2600);

  await read('src/auth/jwt.ts'); await sleep(1500);
  await edit('src/auth/auth.ts', 6, 5); await sleep(2000);

  await pre('Task', { description: 'Review payment changes', subagent_type: 'code-reviewer' });
  await sleep(500);
  await pre('Task', { description: 'Update API docs', subagent_type: 'general-purpose' });
  await sleep(500);
  await pre('Task', { description: 'Check refund edge cases', subagent_type: 'Explore' });
  await sleep(700);
  // three subagents working in parallel, each on its own files
  await read('src/payments/stripe.ts', REVIEW); await sleep(700);
  await read('src/api/router.ts', DOCS); await sleep(600);
  await read('src/payments/refund.ts', EDGE); await sleep(800);
  await read('src/services/orderService.ts', REVIEW); await sleep(700);
  await pre('Grep', { pattern: 'amount <= 0', path: abs('src') }, EDGE); await sleep(800);
  await read('src/api/users.ts', DOCS); await sleep(700);
  await read('src/db/orderRepo.ts', EDGE); await sleep(800);
  await edit('src/api/router.ts', 8, 1, DOCS); await sleep(900);
  await read('tests/orders.spec.ts', EDGE); await sleep(900);
  await stopAgent(EDGE); await sleep(700);
  const lint = { command: 'npm run lint', description: 'Lint' };
  await pre('Bash', lint, REVIEW); await sleep(1200);
  await post('Bash', lint, { stdout: 'No problems', stderr: '' }, REVIEW); await sleep(700);
  await stopAgent(REVIEW); await sleep(900);
  await stopAgent(DOCS); await sleep(1200);

  await pre('Bash', test); await sleep(2600);
  await post('Bash', test, { stdout: 'PASS tests/auth.spec.ts\nPASS tests/users.spec.ts\nPASS tests/orders.spec.ts\nPASS tests/format.spec.ts\n\nTests:       25 passed, 25 total', stderr: '', interrupted: false });
  await sleep(2200);
  await send({ hook_event_name: 'Stop' });
}

// --swarm N: N subagents launched together and working in parallel (default 10). Four of them
// share one module on purpose, so crowding (tags, colours) shows up.
const SI = process.argv.indexOf('--swarm');
const SWARM = SI > -1 ? Math.max(1, Number(process.argv[SI + 1]) || 10) : 0;

async function swarm(n) {
  if (!PROJ) ensureDemoProject();
  const files = POOL.length ? POOL : Object.keys(FILES).map((f) => abs(f));
  const absOf = (f) => (path.isAbsolute(f) ? f : path.join(ROOT_DIR, f));
  const TYPES = ['Explore', 'Explore', 'code-reviewer', 'general-purpose', 'Explore', 'test-runner',
    'code-reviewer', 'general-purpose', 'Explore', 'docs-writer', 'security-reviewer', 'Explore'];
  const TASKS = ['Map the auth flow', 'Find refund callers', 'Review billing changes', 'Update API docs',
    'Check edge cases', 'Run the failing tests', 'Review the repositories', 'Write migration notes',
    'Trace the job queue', 'Document the webhooks', 'Audit input validation', 'Find dead code'];
  await send({ hook_event_name: 'SessionStart', source: 'startup' });
  await sleep(2000);
  await send({ hook_event_name: 'UserPromptSubmit', prompt: `Split the refund work across ${n} subagents` });
  await sleep(1200);
  const agents = Array.from({ length: n }, (_, i) => ({
    agent_id: `swarm-${i}`, agent_type: TYPES[i % TYPES.length], task: TASKS[i % TASKS.length],
    // agents 0-3 crowd into the same module; the rest spread out
    files: i < 4 ? [files[0], files[0], files[1 % files.length]] : [files[(i * 3) % files.length], files[(i * 3 + 1) % files.length], files[(i * 3 + 2) % files.length]],
  }));
  // Like Claude Code: each launch has a tool_use_id, and each subagent gets a meta file
  // (<session>/subagents/agent-<id>.meta.json) naming that tool_use_id. The files live in
  // data/demo-transcripts, never in the project. Odd agents get theirs late, to exercise the
  // server's correction of a guessed binding.
  const tdir = path.resolve(HERE, '..', 'data', 'demo-transcripts');
  const transcript = path.join(tdir, 'demo-session.jsonl');
  const metaDir = path.join(tdir, 'demo-session', 'subagents');
  fs.rmSync(metaDir, { recursive: true, force: true });
  fs.mkdirSync(metaDir, { recursive: true });
  const writeMeta = (a, i) => fs.writeFileSync(path.join(metaDir, `agent-${a.agent_id}.meta.json`),
    JSON.stringify({ agentType: a.agent_type, description: a.task, toolUseId: `toolu_swarm_${i}` }));
  for (const [i, a] of agents.entries()) {
    await send({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: `toolu_swarm_${i}`, transcript_path: transcript,
      tool_input: { description: a.task, subagent_type: a.agent_type } });
    if (i % 2 === 0) writeMeta(a, i);
    await sleep(250);
  }
  for (let step = 0; step < 6; step++) {
    if (step === 1) agents.forEach((a, i) => { if (i % 2) writeMeta(a, i); });
    // the first tool calls arrive in reverse launch order, so "oldest launch of that type" would be wrong
    for (const a of step === 0 ? agents.slice().reverse() : agents) {
      const agent = { agent_id: a.agent_id, agent_type: a.agent_type, transcript_path: transcript };
      const f = absOf(a.files[step % a.files.length]);
      if (step === 4 && a.agent_type !== 'Explore') await pre('Edit', { file_path: f, old_string: nLines(2), new_string: nLines(6) }, agent);
      else if (step === 2) await pre('Grep', { pattern: 'refund', path: ROOT_DIR }, agent);
      else await pre('Read', { file_path: f }, agent);
      await sleep(260);
    }
    await sleep(900);
  }
  for (const a of agents) { await stopAgent({ agent_id: a.agent_id, agent_type: a.agent_type }); await sleep(700); }
  await sleep(1500);
  await send({ hook_event_name: 'Stop' });
}

do {
  console.log(SWARM ? `▶ swarm demo: ${SWARM} subagents` : '▶ demo session');
  if (SWARM) await swarm(SWARM); else await session();
  if (LOOP) await sleep(5000);
} while (LOOP);
console.log('✓ demo finished');
