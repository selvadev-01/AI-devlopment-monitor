#!/usr/bin/env node
// adm: run the AI Dev Monitor from any terminal (for Claude Code in the CLI).
//   adm              start the monitor (if needed) and open it for the current folder
//   adm open [dir]   open the monitor for a folder (default: current folder)
//   adm start        start it in the background without opening a browser
//   adm stop         stop a monitor started by adm / npm start (not the one inside VS Code)
//   adm status       show whether it runs, where, and which projects it has seen
// MONITOR_PORT picks another port (default 7777).
import fs from 'node:fs';
import path from 'node:path';
import { PORT, DATA_DIR, health, portTaken, ensureRunning, monitorUrl, openUrl } from '../scripts/serverctl.js';

const [cmd = 'open', arg] = process.argv.slice(2);
const where = (h) => (h.standalone ? `background process ${h.pid}` : 'inside VS Code');

async function up(project) {
  const before = await health();
  const h = before || await ensureRunning({ project });
  if (!h) {
    console.error(`Port ${PORT} is used by another program, or by an older monitor (reload VS Code after updating the extension). Set MONITOR_PORT to use a different port.`);
    process.exit(1);
  }
  console.log(before ? `Monitor already running on port ${PORT} (${where(h)}).` : `Started the monitor on port ${PORT} (log: data/server.log).`);
  return h;
}

switch (cmd) {
  case 'open': {
    const dir = path.resolve(arg || process.cwd());
    await up(dir);
    const url = monitorUrl(PORT, dir);
    openUrl(url);
    console.log(`Opened ${url}`);
    break;
  }
  case 'start':
    await up(arg ? path.resolve(arg) : process.cwd());
    console.log(`Open ${monitorUrl(PORT)} in a browser, or run: adm open`);
    break;
  case 'stop': {
    const h = await health();
    if (!h) { console.log(`No monitor running on port ${PORT}.`); break; }
    if (!h.standalone) { console.log('The monitor runs inside VS Code; it stops when VS Code closes.'); break; }
    try { process.kill(h.pid); } catch (e) { console.error(`Could not stop process ${h.pid}: ${e.message}`); process.exit(1); }
    fs.rmSync(path.join(DATA_DIR, `server-${PORT}.pid`), { force: true });
    console.log(`Stopped the monitor (process ${h.pid}).`);
    break;
  }
  case 'status': {
    const h = await health();
    if (!h && await portTaken()) { console.log(`Port ${PORT} answers, but not as this monitor: another program, or an older monitor (reload VS Code after updating the extension).`); break; }
    if (!h) { console.log(`Not running (port ${PORT}). Start it with: adm`); break; }
    console.log(`Running on port ${PORT}, ${where(h)}, up ${Math.round(h.uptime / 60)} min.`);
    console.log(`Following: ${h.follow || '(no project yet)'}`);
    try {
      const { projects } = await (await fetch(`http://127.0.0.1:${PORT}/api/projects`)).json();
      for (const p of projects) console.log(`  ${p.name.padEnd(28)} ${String(p.events).padStart(4)} events  ${p.activeAgents ? `${p.activeAgents} subagents  ` : ''}${p.root}`);
    } catch { /* older server */ }
    break;
  }
  case 'help': case '--help': case '-h':
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 8).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    break;
  default:
    console.error(`Unknown command "${cmd}". Run: adm help`);
    process.exit(1);
}
