// AI Development Monitor server.
// Receives Claude Code hook events (POST /event), keeps a project graph, and streams
// both to the browser over WebSocket (/ws). Binds to 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { scanProject, toRel, moduleOf } from './scanner.js';
import { normalizeHook } from './normalize.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const WEB_DIR = path.join(APP_ROOT, 'web');
const THREE_DIR = path.join(APP_ROOT, 'node_modules', 'three');
let LOG_FILE = path.join(APP_ROOT, 'data', 'events.jsonl');
const HOST = '127.0.0.1';
const MAX_EVENTS = 500;
let quiet = false;
const log = (...a) => { if (!quiet) console.log(...a); };

const state = {
  root: null,
  graph: null,
  events: [],
  modified: new Set(),
  created: new Set(),
  lastTest: null,
  activeAgents: 0,
  nextId: 1,
};

// ---------------------------------------------------------------- project / graph
let watcher = null;
let rescanTimer = null;

function setProject(root) {
  const abs = path.resolve(root);
  if (state.root === abs) return;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return;
  state.root = abs;
  state.modified.clear();
  state.created.clear();
  state.lastTest = null;
  state.graph = scanProject(abs);
  log(`[monitor] project: ${abs} (${state.graph.nodes.length} files, ${state.graph.edges.length} links)`);
  watchProject(abs);
  broadcast({ type: 'graph', graph: state.graph, reset: true, summary: summary() });
}

const IGNORED_SEGMENTS = /(^|[\\/])(node_modules|\.git|dist|build|\.next|coverage|__pycache__|\.venv|data)([\\/]|$)/;

function watchProject(root) {
  try { watcher?.close(); } catch { /* already closed */ }
  try {
    watcher = fs.watch(root, { recursive: true }, (_evt, filename) => {
      if (!filename || IGNORED_SEGMENTS.test(filename)) return;
      clearTimeout(rescanTimer);
      rescanTimer = setTimeout(rescan, 1200);
    });
  } catch (err) {
    log('[monitor] file watching unavailable:', err.message);
  }
}

function rescan() {
  if (!state.root) return;
  const next = scanProject(state.root);
  const prev = state.graph;
  const sig = (g) => g.nodes.length + ':' + g.edges.length + ':' + g.nodes.reduce((s, n) => s + n.loc, 0);
  state.graph = next;
  if (!prev || sig(prev) !== sig(next)) broadcast({ type: 'graph', graph: next, reset: false, summary: summary() });
}

function summary() {
  return {
    project: state.graph?.name || null,
    root: state.root,
    files: state.graph?.nodes.length || 0,
    links: state.graph?.edges.length || 0,
    modified: state.modified.size,
    created: state.created.size,
    lastTest: state.lastTest,
    activeAgents: state.activeAgents,
  };
}

// ---------------------------------------------------------------- events
function ingest(payload) {
  // Follow Claude to whichever project it is working in.
  if (payload?.cwd && !state.root) setProject(payload.cwd);
  else if (payload?.cwd && payload.hook_event_name === 'SessionStart' && path.resolve(payload.cwd) !== state.root) setProject(payload.cwd);

  const ev = normalizeHook(payload);
  if (!ev) return null;

  const rel = ev.file ? toRel(state.root, ev.file) : null;
  const event = {
    id: state.nextId++,
    ts: new Date().toISOString(),
    kind: ev.kind,
    tool: ev.tool,
    file: rel,
    outside: Boolean(ev.file && !rel),
    detail: ev.detail,
    stats: ev.stats || null,
    ok: ev.ok,
    isTest: ev.isTest || false,
    failingFiles: ev.failingFiles || [],
    agentType: ev.agentType || null,
    session: ev.session,
  };

  if (rel && (event.kind === 'edit' || event.kind === 'create')) state.modified.add(rel);
  if (rel && event.kind === 'create') {
    state.created.add(rel);
    if (state.graph && !state.graph.nodes.some((n) => n.id === rel)) {
      const node = { id: rel, name: path.posix.basename(rel), module: moduleOf(rel), loc: event.stats?.added || 1 };
      state.graph.nodes.push(node);
      event.node = node;
    }
  }
  if (event.kind === 'test_result') state.lastTest = { ok: event.ok, ...event.stats, ts: event.ts };
  if (event.kind === 'agent_start') state.activeAgents++;
  if (event.kind === 'agent_stop') state.activeAgents = Math.max(0, state.activeAgents - 1);
  if (event.kind === 'idle') state.activeAgents = 0;

  state.events.push(event);
  if (state.events.length > MAX_EVENTS) state.events.shift();
  fs.appendFile(LOG_FILE, JSON.stringify(event) + '\n', () => {});
  broadcast({ type: 'event', event, summary: summary() });
  return event;
}

// ---------------------------------------------------------------- http
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2',
};

function serveFile(res, baseDir, relPath) {
  const target = path.resolve(baseDir, '.' + path.sep + relPath);
  if (!target.startsWith(baseDir + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(target, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const handler = async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  try {
    if (req.method === 'POST' && url.pathname === '/event') {
      const ev = ingest(JSON.parse(await readBody(req)));
      return json(res, 200, { ok: true, id: ev?.id ?? null });
    }
    if (req.method === 'POST' && url.pathname === '/api/project') {
      const { root } = JSON.parse(await readBody(req));
      setProject(root);
      return json(res, 200, summary());
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, { summary: summary(), graph: state.graph, events: state.events });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/vendor/three/')) {
      return serveFile(res, THREE_DIR, decodeURIComponent(url.pathname.slice('/vendor/three/'.length)));
    }
    if (req.method === 'GET') {
      const p = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      return serveFile(res, WEB_DIR, p);
    }
    res.writeHead(405).end();
  } catch (err) {
    json(res, 400, { ok: false, error: err.message });
  }
};

// ---------------------------------------------------------------- websocket
let wss = null;
function broadcast(msg) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}

/**
 * Start the monitor. Used by the CLI below and by the VS Code extension (in-process).
 * Rejects with err.code === 'EADDRINUSE' when another monitor already owns the port.
 * @returns {Promise<{port:number, close:() => Promise<void>, setProject:(dir:string)=>void}>}
 */
export function startServer({ port = 7777, project, dataDir, silent = false } = {}) {
  quiet = silent;
  const dir = dataDir || path.join(APP_ROOT, 'data');
  fs.mkdirSync(dir, { recursive: true });
  LOG_FILE = path.join(dir, 'events.jsonl');

  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      wss = new WebSocketServer({ server, path: '/ws' });
      wss.on('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'hello', graph: state.graph, events: state.events.slice(-150), summary: summary() }));
      });
      if (project) setProject(project);
      log(`[monitor] open http://localhost:${port}`);
      resolve({
        port,
        setProject,
        close: () => new Promise((done) => {
          try { watcher?.close(); } catch { /* already closed */ }
          for (const c of wss.clients) c.terminate();
          wss.close();
          server.close(() => done());
        }),
      });
    });
  });
}

// CLI: node server/index.js [--project DIR]
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const i = process.argv.indexOf('--project');
  const project = i > -1 ? process.argv[i + 1] : process.env.MONITOR_PROJECT || process.cwd();
  const port = Number(process.env.MONITOR_PORT || 7777);
  startServer({ port, project }).catch((err) => {
    if (err.code === 'EADDRINUSE') console.error(`[monitor] port ${port} is already in use. Is the monitor already running?`);
    else console.error('[monitor]', err);
    process.exit(1);
  });
}
