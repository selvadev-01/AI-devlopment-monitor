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

const abs = (f) => path.join(ROOT, f);
const nLines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SPEED));

async function send(payload) {
  const full = { session_id: 'demo-session', cwd: ROOT, transcript_path: '', ...payload };
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
  ensureDemoProject();
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
  fs.writeFileSync(abs(NEW_FILE), content);
  await sleep(2800);
  await edit('src/services/orderService.ts', 9, 2); await sleep(2000);
  await edit('src/api/orders.ts', 22, 4); await sleep(2000);

  const test = { command: 'npm test', description: 'Run tests' };
  await pre('Bash', test); await sleep(2600);
  await post('Bash', test, { stdout: 'PASS tests/users.spec.ts\nPASS tests/orders.spec.ts\nFAIL tests/auth.spec.ts\n\nTests:       1 failed, 24 passed, 25 total', stderr: '', interrupted: false });
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

do {
  console.log('▶ demo session');
  await session();
  if (LOOP) await sleep(5000);
} while (LOOP);
console.log('✓ demo finished');
