#!/usr/bin/env node
// SessionStart hook (installed as an async command hook next to the http hooks): if the monitor is
// not running, start it in the background for this session's folder, then deliver the SessionStart
// event the http hook could not (it fired while nothing was listening). Never blocks Claude, never
// prints hook output, and does nothing if another program holds the port.
const pi = process.argv.indexOf('--port');
if (pi > -1) process.env.MONITOR_PORT = process.argv[pi + 1]; // read by serverctl.js when it loads
const { health, ensureRunning, PORT } = await import('./serverctl.js');

const readStdin = () => new Promise((resolve) => {
  if (process.stdin.isTTY) return resolve('');
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { s += c; });
  process.stdin.on('end', () => resolve(s));
  setTimeout(() => resolve(s), 1500); // stdin left open: go on with what arrived
});

try {
  let payload = null;
  try { payload = JSON.parse(await readStdin()); } catch { /* run by hand */ }
  if (!(await health())) {
    const h = await ensureRunning({ project: payload?.cwd });
    if (h && payload?.hook_event_name) {
      await fetch(`http://127.0.0.1:${PORT}/event`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(2000),
      }).catch(() => {});
    }
  }
} catch { /* a monitor problem must never disturb Claude */ }
process.exit(0);
