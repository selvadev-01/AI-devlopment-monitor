// Shared by the `adm` command and the SessionStart auto-start hook: find, start and open the monitor.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(HERE, '..');
export const DATA_DIR = path.join(APP_ROOT, 'data');
export const PORT = Number(process.env.MONITOR_PORT || 7777);
const SERVER = path.join(APP_ROOT, 'server', 'index.js');

/** The monitor's /api/health on this port, or null if nothing (or something else) answers. */
export async function health(port = PORT, timeoutMs = 600) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const h = await res.json();
    return h?.app === 'ai-dev-monitor' ? h : null;
  } catch { return null; }
}

/** True when some other program holds the port (so we must not start a second server on it). */
export async function portTaken(port = PORT) {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(600) }); return true; } catch { return false; }
}

/**
 * Start the server as a background process that outlives the caller (a hook or the `adm`
 * command), logging to data/server.log. Resolves with its health once it answers.
 */
export async function startDetached({ port = PORT, project } = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
  const args = [SERVER];
  if (project) args.push('--project', project);
  const child = spawn(process.execPath, args, {
    cwd: APP_ROOT, detached: true, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, MONITOR_PORT: String(port) },
  });
  child.unref();
  fs.closeSync(out);
  for (let i = 0; i < 40; i++) {
    const h = await health(port, 400);
    if (h) return h;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/** Running monitor, starting one if needed. Returns its health, or null (port used by something else). */
export async function ensureRunning({ port = PORT, project } = {}) {
  const h = await health(port);
  if (h) return h;
  if (await portTaken(port)) return null;
  return startDetached({ port, project });
}

/** Monitor URL, pinned to one project folder when given. */
export const monitorUrl = (port = PORT, project = null) =>
  `http://localhost:${port}/${project ? `?project=${encodeURIComponent(project)}` : ''}`;

/** Open a URL in the default browser. */
export function openUrl(url) {
  if (process.platform === 'win32') {
    // `start "" "<url>"` passed verbatim: node's own quoting would mangle the empty title argument
    spawn('cmd', ['/c', `start "" "${url.replace(/"/g, '%22')}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
    return;
  }
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}
