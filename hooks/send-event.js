#!/usr/bin/env node
// Claude Code hook: forwards the hook payload (stdin JSON) to the local monitor.
// Never blocks or fails Claude: short timeout, always exits 0, prints nothing.
const PORT = process.env.MONITOR_PORT || 7777;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
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
