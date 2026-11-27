#!/usr/bin/env node
// adm: run the AI Dev Monitor from any terminal (for Claude Code in the CLI).
//   adm              start the monitor (if needed) and open it for the current folder
//   adm open [dir]   open the monitor for a folder (default: current folder)
//   adm start        start it in the background without opening a browser
//   adm stop         stop a monitor started by adm / npm start (not the one inside VS Code)
//   adm status       show whether it runs, where, and which projects it has seen
//   adm alerts [on|off|test]  desktop notification + sound when Claude needs you
//   adm doctor [--toast]      check hooks, monitor, the latest session, tokens, subagents, alerts
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
  case 'alerts': {
    const h = await health();
    if (!h) { console.log(`No monitor running on port ${PORT}. Start it with: adm start`); break; }
    const api = (p, body) => fetch(`http://127.0.0.1:${PORT}${p}`, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}).then((r) => r.json());
    if (arg === 'on' || arg === 'off') {
      const s = await api('/api/settings', { alerts: arg === 'on' });
      console.log(`Alerts ${s.alerts ? 'on' : 'off'}.`);
    } else if (arg === 'test') {
      await api('/api/alert-test', {});
      console.log('Sent a test alert: desktop notification, plus banner and sound in open monitor pages.');
    } else {
      const s = await api('/api/settings');
      console.log(`Alerts ${s.alerts ? 'on' : 'off'}: permission prompts, questions, and turns longer than ${s.doneAfterSec} s.`);
      console.log('Use: adm alerts on | off | test');
    }
    break;
  }
  case 'doctor': {
    const d = await import('../scripts/doctor.js');
    const repoVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    const h = await health();
    let info = null;
    if (h) { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/doctor`); if (r.ok) info = await r.json(); } catch { /* older server */ } }
    const all = [];
    const section = (title, findings) => { all.push(...findings); if (findings.length) console.log(`\n${title}\n${d.format(findings)}`); };
    const major = Number(process.versions.node.split('.')[0]);
    console.log(`AI Dev Monitor doctor (version ${repoVersion}, port ${PORT}, Node ${process.versions.node})`);
    if (major < 18) section('Node', [{ level: 'fail', text: `Node ${process.versions.node} is too old`, hint: 'Install Node 18 or newer' }]);
    section('Claude Code hooks', d.checkHooks(d.settingsFiles(process.cwd()), PORT));
    let taken = false; let oldMonitor = false;
    if (!h && (taken = await portTaken())) {
      // a monitor from before /api/health still answers /api/state with its summary
      try { oldMonitor = Boolean((await (await fetch(`http://127.0.0.1:${PORT}/api/state`, { signal: AbortSignal.timeout(1500) })).json())?.summary); } catch { /* not ours */ }
    }
    section('Monitor', d.checkServer(h, repoVersion, PORT, { taken, oldMonitor }));
    if (info) {
      const real = info.sessions.filter((s) => !s.demo);
      if (!real.length) {
        section('Latest Claude Code session', [{ level: 'warn',
          text: info.sessions.length ? 'Only the demo has sent events since the monitor started' : 'No Claude Code session has sent events since the monitor started',
          hint: 'Start Claude Code (or send a prompt in an open session), ask it to read a file, then run adm doctor again' }]);
      } else {
        section('Latest Claude Code session', d.checkSession(real[0]));
        if (real.length > 1) console.log(`    (${real.length - 1} more session${real.length > 2 ? 's' : ''} seen; this is the most recent)`);
      }
      section('Alerts', d.checkAlerts(info.settings));
      if (arg === '--toast') {
        await fetch(`http://127.0.0.1:${PORT}/api/alert-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        console.log('    Sent a test notification: you should see a desktop notification now.');
      }
    }
    const fails = all.filter((x) => x.level === 'fail').length; const warns = all.filter((x) => x.level === 'warn').length;
    console.log(`\n${fails ? `${fails} problem${fails > 1 ? 's' : ''} to fix` : 'No problems'}${warns ? `, ${warns} warning${warns > 1 ? 's' : ''}` : ''}.${fails || warns ? '' : ' Everything from Claude Code to the monitor works.'}`);
    if (arg !== '--toast') console.log('Run adm doctor --toast to also send a test desktop notification.');
    process.exitCode = fails ? 1 : 0;
    break;
  }
  case 'help': case '--help': case '-h':
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    break;
  default:
    console.error(`Unknown command "${cmd}". Run: adm help`);
    process.exit(1);
}
