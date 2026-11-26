#!/usr/bin/env node
// Claude Code hook: forwards the hook payload (stdin JSON) to the local monitor.
// Never blocks or fails Claude: short timeout, always exits 0, prints nothing.
const PORT = process.env.MONITOR_PORT || 7777;
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Debug aid: when data/debug-hooks exists, append each payload's shape (keys + ids, no file
// contents) to data/hook-shapes.jsonl. Used to see which fields Claude Code sends.
function debugDump(raw) {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(path.join(dataDir, 'debug-hooks'))) return;
  try {
    const p = JSON.parse(raw);
    const shape = {
      hook: p.hook_event_name, tool: p.tool_name, keys: Object.keys(p).sort(),
      session_id: p.session_id, agent_id: p.agent_id, agent_type: p.agent_type,
      transcript_path: p.transcript_path, agent_transcript_path: p.agent_transcript_path,
      input_keys: p.tool_input ? Object.keys(p.tool_input) : undefined,
    };
    fs.appendFileSync(path.join(dataDir, 'hook-shapes.jsonl'), JSON.stringify(shape) + '\n');
  } catch { /* never fail the hook */ }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  debugDump(input);
  try {
    await fetch(`http://127.0.0.1:${PORT}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: input || '{}',
      signal: AbortSignal.timeout(800),
    });
  } catch {
    // Monitor not running: ignore silently.
  }
  process.exit(0);
});
