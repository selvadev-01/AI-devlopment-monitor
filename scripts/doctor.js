// `adm doctor`: checks the whole chain from Claude Code to the monitor and says what to fix.
// The check functions are pure (tested in test/doctor.test.js); bin/adm.js gathers the inputs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const REQUIRED_HOOKS = ['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'Notification'];
const OK = 'ok'; const WARN = 'warn'; const FAIL = 'fail';
const f = (level, text, hint) => ({ level, text, ...(hint ? { hint } : {}) });

/** Our hooks in a settings `hooks` block: http to 127.0.0.1:<port>/event, the old send-event.js command, the auto-start. */
function ourHooks(hooks = {}, evt) {
  const out = [];
  for (const g of hooks[evt] || []) {
    for (const h of g.hooks || []) {
      const m = /^http:\/\/127\.0\.0\.1:(\d+)\/event$/.exec(String(h.url || ''));
      if (m) out.push({ kind: 'http', port: Number(m[1]) });
      else if (String(h.command || '').includes('send-event.js')) out.push({ kind: 'command' });
      else if (String(h.command || '').includes('ensure-server.js')) out.push({ kind: 'autostart', command: h.command });
    }
  }
  return out;
}

/**
 * @param files [{ file, settings }] Claude Code settings files that exist (user, project, local)
 * @param port  the port the monitor uses
 */
export function checkHooks(files, port, exists = fs.existsSync) {
  const out = [];
  for (const x of files) if (x.error) out.push(f(FAIL, `${x.file} is not valid JSON: ${x.error}`, 'Claude Code ignores a broken settings file; fix the JSON'));
  const withOurs = files.filter((x) => REQUIRED_HOOKS.some((e) => ourHooks(x.settings?.hooks, e).some((h) => h.kind !== 'autostart')));
  if (!withOurs.length) {
    out.push(f(FAIL, 'Claude Code hooks are not installed', 'Run: npm run hooks:install (all projects), then restart Claude Code'));
    return out;
  }
  if (withOurs.length > 1) {
    out.push(f(WARN, `Hooks are installed in ${withOurs.length} settings files, so every event is sent ${withOurs.length} times`,
      `Keep one: ${withOurs.map((x) => x.file).join(', ')}`));
  }
  for (const { file, settings } of withOurs) {
    const missing = []; const ports = new Set();
    let autostart = null;
    for (const evt of REQUIRED_HOOKS) {
      const hs = ourHooks(settings.hooks, evt);
      if (!hs.some((h) => h.kind !== 'autostart')) missing.push(evt);
      for (const h of hs) { if (h.kind === 'http') ports.add(h.port); if (h.kind === 'autostart') autostart = h.command; }
    }
    if (missing.length) out.push(f(FAIL, `${file}: no monitor hook for ${missing.join(', ')}`, 'Re-run: npm run hooks:install'));
    else out.push(f(OK, `Hooks installed in ${file} (${REQUIRED_HOOKS.length} events)`));
    const wrong = [...ports].filter((p) => p !== port);
    if (wrong.length) {
      out.push(f(FAIL, `Hooks send to port ${wrong.join(', ')}, but the monitor uses ${port}`,
        `Re-run the install with the same port: MONITOR_PORT=${port} npm run hooks:install`));
    }
    if (!autostart) out.push(f(WARN, 'No auto-start hook: in a plain terminal the monitor must be started by hand (adm start)', 'Re-run: npm run hooks:install'));
    else {
      const script = /"([^"]*ensure-server\.js)"/.exec(autostart)?.[1];
      if (script && !exists(script)) out.push(f(FAIL, `The auto-start hook points to ${script}, which no longer exists (was the folder moved?)`, 'Re-run: npm run hooks:install'));
    }
  }
  return out;
}

/** Server version against this checkout: an old VS Code extension keeps serving old code until a reload. */
export function checkServer(health, repoVersion, port, { taken = false, oldMonitor = false } = {}) {
  if (!health && oldMonitor) {
    return [f(FAIL, `An old monitor (before 0.2.0) answers on port ${port}, so none of the newer features reach the page`,
      'It runs inside VS Code: reload VS Code (Developer: Reload Window) after installing the extension')];
  }
  if (!health && taken) return [f(FAIL, `Another program uses port ${port}`, 'Close it, or set MONITOR_PORT and re-install the hooks with that port')];
  if (!health) return [f(FAIL, `The monitor is not running on port ${port}`, 'Start it with: adm   (or open the AI Dev Monitor panel in VS Code)')];
  const where = health.standalone ? `background process ${health.pid}` : 'inside VS Code';
  const out = [f(OK, `Monitor running on port ${port} (${where}, version ${health.version || 'unknown'})`)];
  const fix = health.standalone ? 'Restart it: adm stop, then adm' : 'Reload VS Code (Developer: Reload Window); install the matching extension with npm run ext:install';
  if (!health.version) out.push(f(WARN, 'The running monitor is older than 0.2.5 and cannot report what it received', fix));
  else if (repoVersion && health.version !== repoVersion) out.push(f(WARN, `The running monitor is version ${health.version}, this checkout is ${repoVersion}`, fix));
  return out;
}

/** What one Claude Code session actually delivered (one entry of /api/doctor). */
export function checkSession(s, now = Date.now()) {
  const out = [];
  const ago = s.lastAt ? Math.round((now - Date.parse(s.lastAt)) / 60000) : null;
  out.push(f(OK, `Receiving events from ${s.root ? path.basename(s.root) : '?'} (session ${s.session.slice(0, 8)}${ago != null ? `, last event ${ago < 1 ? 'just now' : `${ago} min ago`}` : ''})`));
  const seen = (h) => (s.hooks[h] || 0) > 0;
  if (!seen('PreToolUse') && !seen('PostToolUse')) out.push(f(WARN, 'No tool calls arrived yet (PreToolUse / PostToolUse)', 'Ask Claude to read a file, then run adm doctor again'));
  if (!seen('UserPromptSubmit')) out.push(f(WARN, 'No prompt arrived (UserPromptSubmit), so turn timing and "finished" alerts cannot work'));
  else if (!seen('Stop')) out.push(f(WARN, 'No Stop event yet: fine while Claude is still on its first turn; otherwise the Stop hook is not firing'));

  if (!s.transcript) out.push(f(FAIL, 'Events carry no transcript_path, so tokens and cost cannot be read', 'Update Claude Code'));
  else if (!s.transcriptExists) out.push(f(WARN, `Transcript not found: ${s.transcript}`));
  else if (!s.usage?.requests) {
    out.push(s.transcriptResponses
      ? f(OK, `Transcript readable (${s.transcriptResponses} responses with token counts); the cost view counts from when the monitor first saw this session`)
      : f(WARN, 'Transcript found, but it has no token counts yet', 'Normal right after a session starts; check again after Claude has answered once'));
  }
  else {
    out.push(f(OK, `Tokens read: ${s.usage.tokens.toLocaleString('en-US')} in ${s.usage.requests} responses, about $${s.usage.cost.toFixed(2)} at API prices`));
    if (s.usage.unpriced) out.push(f(WARN, `${s.usage.unpriced} responses came from a model with no price in server/usage.js; their tokens count, their cost does not`));
  }

  const L = s.launches; const A = s.agents;
  const total = A.exact + A.guessed + A.corrected;
  if (!L.withId && !L.withoutId && !total) out.push(f(OK, 'No subagents in this session yet (nothing to check there)'));
  else {
    if (L.withoutId) out.push(f(WARN, `${L.withoutId} subagent launches came without tool_use_id, so they can only be matched by type and order`, 'Update Claude Code'));
    if (A.guessed) out.push(f(WARN, `${A.guessed} of ${total} subagents were matched by guess (no agent-<id>.meta.json found), so their labels may be swapped`));
    else if (total) out.push(f(OK, `Subagents: all ${total} matched to their launch exactly${A.corrected ? ` (${A.corrected} after a first guess)` : ''}`));
  }
  if (seen('Notification') && !Object.keys(s.notificationTypes || {}).length) {
    out.push(f(WARN, 'Notifications arrive without notification_type; alerts fall back to reading the message text'));
  }
  return out;
}

/** Desktop notifications: the alerts setting and the OS tool used to show them. */
export function checkAlerts(settings, platform = process.platform, has = hasCommand) {
  if (!settings) return [];
  const out = [settings.alerts
    ? f(OK, `Needs-you alerts on (a "finished" alert after turns of ${settings.doneAfterSec} s or more)`)
    : f(WARN, 'Needs-you alerts are off', 'Turn them on: adm alerts on')];
  const tool = { win32: 'powershell', darwin: 'osascript' }[platform] || 'notify-send';
  if (!has(tool)) out.push(f(WARN, `${tool} not found, so desktop notifications cannot be shown (the page banner and sound still work)`));
  return out;
}

export function hasCommand(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', windowsHide: true });
  return r.status === 0;
}

/** Claude Code settings files for a project folder (user, project, local) that exist. */
export function settingsFiles(cwd, home = os.homedir()) {
  const list = [path.join(home, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')];
  const out = [];
  for (const file of [...new Set(list.map((p) => path.resolve(p)))]) {
    if (!fs.existsSync(file)) continue;
    try { out.push({ file, settings: JSON.parse(fs.readFileSync(file, 'utf8') || '{}') }); } catch (e) { out.push({ file, settings: {}, error: e.message }); }
  }
  return out;
}

export function format(findings) {
  const mark = { ok: '✓', warn: '!', fail: '✗' };
  return findings.map((x) => `  ${mark[x.level]} ${x.text}${x.hint ? `\n      → ${x.hint}` : ''}`).join('\n');
}
