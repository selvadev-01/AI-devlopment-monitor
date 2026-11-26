// "Needs you" alerts: tell the user when Claude is waiting for them, even when they are in another
// window. decideAlert() is pure (tested); notifyOS() shows a desktop notification from the server,
// so it works for Claude in a terminal with no browser or VS Code open.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const DEFAULT_SETTINGS = { alerts: true, doneAfterSec: 30 };

/**
 * @param state   per-session memory: { turnStart, lastAlertAt, alertedTurn }
 * @param event   normalized event (kind, detail, tool, …)
 * @param payload raw hook payload (Notification: message, notification_type)
 * @returns {null | { level: 'needs' | 'done', title: string, message: string }}
 */
export function decideAlert(state, event, payload, now = Date.now(), settings = DEFAULT_SETTINGS) {
  if (event.agent) return null; // subagents never wait on the user; their parent does
  let alert = null;
  if (event.kind === 'prompt') { state.turnStart = now; state.alertedTurn = false; return null; }
  if (event.kind === 'notify') {
    const type = payload?.notification_type || '';
    const msg = String(payload?.message || event.detail || '');
    if (type === 'permission_prompt' || /permission/i.test(msg)) alert = { level: 'needs', title: 'Claude needs your permission', message: msg };
    else if (type === 'elicitation_dialog') alert = { level: 'needs', title: 'Claude has a question', message: msg };
    else if (type === 'idle_prompt' || /waiting for your input/i.test(msg)) {
      // the turn already ended with a "finished" alert: the idle reminder adds nothing
      if (state.alertedTurn) return null;
      alert = { level: 'needs', title: 'Claude is waiting for you', message: msg };
    } else if (type === 'auth_success') return null;
    else alert = { level: 'needs', title: 'Claude', message: msg };
  } else if (event.kind === 'ask') {
    alert = { level: 'needs', title: 'Claude has a question', message: event.detail || '' };
  } else if (event.kind === 'idle') {
    // only long turns: a quick back-and-forth would alert on every reply
    const secs = state.turnStart != null ? (now - state.turnStart) / 1000 : 0;
    if (secs < settings.doneAfterSec) return null;
    alert = { level: 'done', title: 'Claude finished', message: `Done after ${formatSecs(secs)}. Your turn.` };
  }
  if (!alert) return null;
  if (state.lastAlertAt && now - state.lastAlertAt < 4000 && alert.level !== 'needs') return null; // no bursts
  state.lastAlertAt = now;
  if (event.kind === 'idle') state.alertedTurn = true;
  return alert;
}

const formatSecs = (s) => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

/** Settings live in <dataDir>/settings.json (alerts on/off, the "finished" threshold). */
export function readSettings(dataDir) {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')) }; } catch { return { ...DEFAULT_SETTINGS }; }
}
export function writeSettings(dataDir, patch) {
  const next = { ...readSettings(dataDir) };
  if (typeof patch.alerts === 'boolean') next.alerts = patch.alerts;
  if (Number.isFinite(patch.doneAfterSec) && patch.doneAfterSec >= 0) next.doneAfterSec = Math.round(patch.doneAfterSec);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(next, null, 2));
  return next;
}

// Windows toast through PowerShell's WinRT API (no module to install). Title and text arrive as
// environment variables, so nothing from an event is ever pasted into the script.
export const WIN_TOAST = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
$t.Item(0).AppendChild($x.CreateTextNode($env:ADM_TITLE)) > $null
$t.Item(1).AppendChild($x.CreateTextNode($env:ADM_BODY)) > $null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))
`;

/** Desktop notification. Best effort: failures are ignored (and reported to onError). */
export function notifyOS(title, body, onError = () => {}) {
  const t = String(title).slice(0, 120); const b = String(body).slice(0, 240);
  let cmd; let args; let env = process.env;
  if (process.platform === 'win32') {
    cmd = 'powershell.exe'; args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WIN_TOAST];
    env = { ...process.env, ADM_TITLE: t, ADM_BODY: b };
  } else if (process.platform === 'darwin') {
    cmd = 'osascript'; args = ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', '-e', 'end run', t, b];
  } else {
    cmd = 'notify-send'; args = ['--app-name=AI Dev Monitor', t, b];
  }
  try {
    const p = spawn(cmd, args, { env, stdio: 'ignore', windowsHide: true });
    p.on('error', onError);
    p.unref();
  } catch (e) { onError(e); }
}
