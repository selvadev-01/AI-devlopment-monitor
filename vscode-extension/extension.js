// AI Dev Monitor for VS Code.
// - Starts the monitor server in-process (or reuses one already running on the port).
// - Shows the 3D monitor in a webview panel (the web app runs in an iframe).
// - Shows Claude's current action in the status bar.
const vscode = require('vscode');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');

let ctx = null;
let embedded = null;
let panel = null;
let statusItem = null;
let socket = null;
let retryTimer = null;
let retryMs = 1000;
let stopped = false;
let output = null;

const cfg = () => vscode.workspace.getConfiguration('aiDevMonitor');
const port = () => cfg().get('port', 7777);
const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
// Each window pins its views to its own workspace, so parallel Claude sessions in different
// projects each get their own panel and status bar.
const projectQuery = () => (workspaceRoot() ? `?project=${encodeURIComponent(workspaceRoot())}` : '');
const log = (msg) => output?.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: port(), path: urlPath, method, timeout: 1000,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(text) }); } catch { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Make sure a monitor server answers on the port. Returns 'embedded' or 'external'. */
async function ensureServer() {
  if (embedded) return 'embedded';
  try {
    const r = await request('GET', '/api/state');
    if (r.status === 200) return 'external';
  } catch { /* nothing listening yet */ }
  const mod = await import(pathToFileURL(path.join(ctx.extensionPath, 'server', 'index.js')).href);
  try {
    embedded = await mod.startServer({
      port: port(),
      project: workspaceRoot(),
      dataDir: ctx.globalStorageUri.fsPath,
      silent: true,
    });
    log(`Monitor server started on port ${port()} for ${workspaceRoot() || 'no workspace'}`);
    return 'embedded';
  } catch (err) {
    if (err.code === 'EADDRINUSE') return 'external';
    throw err;
  }
}

// ------------------------------------------------------------------ status bar
const ICON = {
  read: 'eye', search: 'search', edit: 'edit', create: 'new-file', bash: 'terminal', bash_result: 'terminal',
  agent_start: 'organization', agent_stop: 'organization', prompt: 'comment', idle: 'debug-pause', session: 'pulse',
};
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function showStatus(ev) {
  if (!statusItem) return;
  if (!ev || ev.kind === 'idle') {
    statusItem.text = '$(pulse) Claude idle';
    statusItem.tooltip = 'AI Dev Monitor: click to open the 3D view';
    statusItem.backgroundColor = undefined;
    return;
  }
  let icon = ICON[ev.kind] || 'pulse';
  if (ev.kind === 'test_result') icon = ev.ok ? 'pass' : 'error';
  const subject = ev.file ? ev.file.split('/').pop() : ev.detail || ev.kind;
  const verb = ev.kind === 'bash' && ev.isTest ? 'Testing' : capital(ev.kind.replace('_', ' '));
  const label = ev.kind === 'test_result' ? `Tests: ${ev.detail}` : ev.file ? `${verb} ${subject}` : subject;
  statusItem.text = `$(${icon}) ${truncate(label, 42)}`;
  statusItem.tooltip = `${ev.detail || ''}${ev.file ? `\n${ev.file}` : ''}\n\nClick to open AI Dev Monitor`;
  statusItem.backgroundColor = ev.kind === 'test_result' && !ev.ok ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
}

function connectSocket() {
  if (stopped) return;
  const WebSocket = require('ws');
  try { socket?.terminate(); } catch { /* ignore */ }
  socket = new WebSocket(`ws://127.0.0.1:${port()}/ws${projectQuery()}`);
  socket.on('open', () => { retryMs = 1000; });
  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'hello') showStatus(msg.events?.[msg.events.length - 1]);
    else if (msg.type === 'event') {
      showStatus(msg.event);
      maybeAutoOpen(msg.event);
    }
  });
  socket.on('error', () => { /* handled by close */ });
  socket.on('close', () => {
    if (stopped) return;
    if (statusItem) statusItem.text = '$(circle-slash) AI Monitor offline';
    clearTimeout(retryTimer);
    // If an external monitor went away, take over the port ourselves.
    retryTimer = setTimeout(() => {
      ensureServer().catch((e) => log(`Server start failed: ${e.message}`)).finally(connectSocket);
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 15000);
  });
}

// ------------------------------------------------------------------ auto open
const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

/** True when the Claude project and one of this window's folders contain each other. */
function belongsToThisWindow(root) {
  if (!root) return false;
  const r = norm(root);
  return (vscode.workspace.workspaceFolders || []).some((f) => {
    const w = norm(f.uri.fsPath);
    return r === w || r.startsWith(w + path.sep) || w.startsWith(r + path.sep);
  });
}

function maybeAutoOpen(ev) {
  if (ev.kind !== 'session' || !cfg().get('autoOpen', true)) return;
  if (!belongsToThisWindow(ev.root)) return;
  log(`Claude session started in ${ev.root}: opening panel`);
  openPanel({ preserveFocus: true });
}

// ------------------------------------------------------------------ panel
async function openPanel({ preserveFocus = false } = {}) {
  if (panel) { panel.reveal(vscode.ViewColumn.Beside, preserveFocus); return; }
  try {
    await ensureServer();
  } catch (err) {
    vscode.window.showErrorMessage(`AI Dev Monitor could not start its server: ${err.message}`);
    return;
  }
  const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${port()}/`));
  const origin = `${external.scheme}://${external.authority}`;
  const src = external.toString(true).replace(/\/?$/, '/') + projectQuery();
  const title = workspaceRoot() ? `AI Monitor · ${path.basename(workspaceRoot())}` : 'AI Dev Monitor';

  panel = vscode.window.createWebviewPanel('aiDevMonitor', title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus }, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.iconPath = new vscode.ThemeIcon('pulse');
  panel.webview.html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline';">
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#06080c}iframe{border:0;width:100%;height:100%;display:block}</style>
</head><body><iframe src="${src.replace(/"/g, '&quot;')}" title="AI Dev Monitor"></iframe></body></html>`;
  panel.onDidDispose(() => { panel = null; });
}

// ------------------------------------------------------------------ lifecycle
async function activate(context) {
  ctx = context;
  output = vscode.window.createOutputChannel('AI Dev Monitor');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'aiDevMonitor.open';
  showStatus(null);
  statusItem.show();

  context.subscriptions.push(
    output,
    statusItem,
    vscode.commands.registerCommand('aiDevMonitor.open', () => openPanel()),
    vscode.commands.registerCommand('aiDevMonitor.showWorkspace', async () => {
      const root = workspaceRoot();
      if (!root) { vscode.window.showWarningMessage('Open a folder first.'); return; }
      await ensureServer();
      openPanel(); // the panel is already pinned to this window's workspace
    }),
    vscode.commands.registerCommand('aiDevMonitor.openInBrowser', async () => {
      await ensureServer();
      vscode.env.openExternal(await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${port()}/${projectQuery()}`)));
    }),
  );

  if (cfg().get('autoStart', true)) {
    try { log(`Server mode: ${await ensureServer()}`); } catch (e) { log(`Server start failed: ${e.message}`); }
  }
  connectSocket();
}

async function deactivate() {
  stopped = true;
  clearTimeout(retryTimer);
  try { socket?.terminate(); } catch { /* ignore */ }
  if (embedded) await embedded.close();
}

module.exports = { activate, deactivate };
