// AI Development Monitor server.
// Receives Claude Code hook events (POST /event) and keeps one live state per project, so several
// Claude sessions working on different projects in parallel each get their own view.
// Browsers subscribe over WebSocket: /ws?project=<folder> for one project, or plain /ws to follow
// whichever project Claude was most recently started in. Binds to 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { scanProject, toRel, moduleFor } from './scanner.js';
import { normalizeHook } from './normalize.js';
import { listSessions, sessionEvents, maxEventId } from './history.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const WEB_DIR = path.join(APP_ROOT, 'web');
const THREE_DIR = path.join(APP_ROOT, 'node_modules', 'three');
let LOG_FILE = path.join(APP_ROOT, 'data', 'events.jsonl');
const HOST = '127.0.0.1';
const MAX_EVENTS = 500;
const MAX_PROJECTS = 12;
let quiet = false;
let standalone = false; // true when run as its own process (npm start / adm), false inside VS Code
let listenPort = null;
const startedAt = Date.now();
const log = (...a) => { if (!quiet) console.log(...a); };

const keyOf = (root) => {
  const r = path.resolve(root).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const IGNORED_SEGMENTS = /(^|[\\/])(node_modules|\.git|dist|build|\.next|coverage|__pycache__|\.venv|data)([\\/]|$)/;

let nextId = 1;
let wss = null;
let followKey = null;                 // project shown to clients that did not pick one
const projects = new Map();           // key -> Project
const sessionProject = new Map();     // Claude session id -> project key

// ---------------------------------------------------------------- per-project state
class Project {
  constructor(root) {
    this.root = path.resolve(root);
    this.key = keyOf(root);
    this.graph = scanProject(this.root);
    this.events = [];
    this.modified = new Set();
    this.created = new Set();
    this.lastTest = null;
    this.agents = new Map();      // subagent id -> { id, type, label, color, startId, tools }
    this.pendingAgents = [];      // launched (Agent tool) but no tool call seen yet, so no id yet
    this.launches = new Map();    // toolUseId (or start:<event id>) -> launch, kept so a guessed binding can be corrected
    this.lastActive = Date.now();
    this.watcher = null;
    this.rescanTimer = null;
    log(`[monitor] project: ${this.root} (${this.graph.nodes.length} files, ${this.graph.edges.length} links)`);
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_evt, filename) => {
        if (!filename || IGNORED_SEGMENTS.test(filename)) return;
        clearTimeout(this.rescanTimer);
        this.rescanTimer = setTimeout(() => this.rescan(), 1200);
      });
    } catch (err) {
      log('[monitor] file watching unavailable:', err.message);
    }
  }

  rescan() {
    const prev = this.graph;
    const next = scanProject(this.root);
    const sig = (g) => g.nodes.length + ':' + g.edges.length + ':' + g.nodes.reduce((s, n) => s + n.loc, 0);
    this.graph = next;
    if (sig(prev) !== sig(next)) send(this.key, { type: 'graph', graph: next, reset: false, summary: this.summary() });
  }

  summary() {
    return {
      project: this.graph?.name || path.basename(this.root),
      root: this.root,
      files: this.graph?.nodes.length || 0,
      links: this.graph?.edges.length || 0,
      modified: this.modified.size,
      created: this.created.size,
      lastTest: this.lastTest,
      activeAgents: this.agents.size + this.pendingAgents.length,
    };
  }

  /**
   * Tag an event with its subagent (id, type, label, colour). A launch has no id yet, so it waits
   * in pendingAgents; the subagent's first tool call claims it (same type first, else oldest) and
   * carries agentStartId so viewers can link the launch to the running agent.
   */
  /** Lowest colour slot no running subagent uses, so parallel agents never share a colour (up to the palette size). */
  freeAgentColor() {
    const used = new Set([...this.agents.values(), ...this.pendingAgents].map((a) => a.color));
    let i = 0;
    while (used.has(i)) i++;
    return i;
  }

  /**
   * Which launch a subagent belongs to. Claude Code writes <session>/subagents/agent-<id>.meta.json
   * next to the session transcript, with the toolUseId of the Task/Agent call that started it and
   * its description. That is exact even when several agents of one type start together; without
   * the file we fall back to the oldest pending launch of the same type.
   */
  agentMeta(ev) {
    if (!ev.transcript || !ev.agent || !/^[\w-]+$/.test(ev.agent)) return null;
    const dir = path.basename(ev.transcript).startsWith('agent-')
      ? path.dirname(ev.transcript)                                   // already a subagent transcript
      : path.join(path.dirname(ev.transcript), ev.session, 'subagents');
    try { return JSON.parse(fs.readFileSync(path.join(dir, `agent-${ev.agent}.meta.json`), 'utf8')); } catch { return null; }
  }

  /** Launch (pending or already bound) for a subagent's meta file. */
  launchFor(meta) {
    if (!meta) return null;
    return (meta.toolUseId && this.launches.get(meta.toolUseId))
      || [...this.launches.values()].find((l) => l.label === meta.description) || null;
  }

  trackAgent(event, ev) {
    if (event.kind === 'agent_start') {
      const pend = { startId: event.id, type: ev.launchType, label: ev.detail, color: this.freeAgentColor(), toolUseId: ev.toolUseId };
      this.pendingAgents.push(pend);
      this.launches.set(ev.toolUseId || `start:${event.id}`, pend);
      if (this.launches.size > 200) this.launches.delete(this.launches.keys().next().value);
      Object.assign(event, { agent: null, agentParent: ev.agent, agentType: pend.type, agentLabel: pend.label, agentColor: pend.color });
      return;
    }
    if (!ev.agent) return;
    let a = this.agents.get(ev.agent);
    if (!a) {
      const exact = this.launchFor(this.agentMeta(ev));
      let i = exact ? this.pendingAgents.indexOf(exact) : -1;
      if (i < 0) i = this.pendingAgents.findIndex((x) => x.type === ev.agentType);
      if (i < 0 && this.pendingAgents.length) i = 0;
      const pend = i >= 0 ? this.pendingAgents.splice(i, 1)[0] : null;
      a = {
        id: ev.agent, type: ev.agentType || pend?.type || 'agent', label: pend?.label || ev.agentType || 'Subagent',
        color: pend ? pend.color : this.freeAgentColor(), startId: pend?.startId ?? null, tools: 0,
        launch: pend, guessed: !exact, tries: 0,
      };
      this.agents.set(a.id, a);
      event.agentStartId = a.startId;
    } else if (a.guessed && a.tries++ < 20) {
      // The meta file may appear a moment after the first tool call: correct a guessed label.
      const right = this.launchFor(this.agentMeta(ev));
      if (right) {
        a.guessed = false;
        if (right !== a.launch) {
          const other = [...this.agents.values()].find((b) => b !== a && b.launch === right);
          if (other) { other.launch = a.launch; other.label = a.launch?.label || other.type; other.guessed = true; }
          else this.pendingAgents = this.pendingAgents.filter((x) => x !== right).concat(a.launch ? [a.launch] : []);
          a.launch = right; a.label = right.label;
        }
      }
    }
    if (event.kind !== 'agent_stop') a.tools++;
    Object.assign(event, { agent: a.id, agentType: a.type, agentLabel: a.label, agentColor: a.color, agentTools: a.tools });
    if (event.kind === 'agent_stop') this.agents.delete(a.id);
  }

  hello() {
    return { type: 'hello', project: this.root, graph: this.graph, events: this.events.slice(-150), summary: this.summary() };
  }

  close() {
    clearTimeout(this.rescanTimer);
    try { this.watcher?.close(); } catch { /* already closed */ }
  }
}

function subscribers(key) {
  let n = 0;
  if (wss) for (const c of wss.clients) if (c.projectKey === key || (c.follow && followKey === key)) n++;
  return n;
}

function evict() {
  while (projects.size > MAX_PROJECTS) {
    const victim = [...projects.values()]
      .filter((p) => p.key !== followKey && !subscribers(p.key))
      .sort((a, b) => a.lastActive - b.lastActive)[0];
    if (!victim) return;
    victim.close();
    projects.delete(victim.key);
  }
}

/**
 * Project for `dir`. With exact=false a known project that contains `dir` is reused (Claude may
 * run a command from a subfolder); exact=true always uses `dir` itself, so a nested repo opened
 * as its own workspace or started as its own Claude session stays a separate project.
 */
function projectFor(dir, { create = true, exact = false } = {}) {
  if (!dir) return null;
  const k = keyOf(dir);
  if (projects.has(k)) return projects.get(k);
  let best = null;
  if (!exact) {
    for (const p of projects.values()) {
      if (k.startsWith(p.key + path.sep) && (!best || p.key.length > best.key.length)) best = p;
    }
  }
  if (best || !create || !isDir(dir)) return best;
  const p = new Project(dir);
  projects.set(p.key, p);
  evict();
  return p;
}

function setFollow(p) {
  if (!p || followKey === p.key) return;
  followKey = p.key;
  if (!wss) return;
  const data = JSON.stringify(p.hello());
  for (const c of wss.clients) if (c.follow && c.readyState === 1) c.send(data);
}

function send(key, msg) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c.readyState === 1 && (c.projectKey === key || (c.follow && followKey === key))) c.send(data);
  }
}

// ---------------------------------------------------------------- events
function ingest(payload) {
  const sid = payload?.session_id;
  let p = null;
  if (payload?.hook_event_name === 'SessionStart' && payload.cwd) p = projectFor(payload.cwd, { exact: true });
  if (!p && sid && sessionProject.has(sid)) p = projects.get(sessionProject.get(sid)) || null;
  if (!p && payload?.cwd) p = projectFor(payload.cwd);
  if (!p && followKey) p = projects.get(followKey) || null;
  if (!p) return null;
  if (sid) sessionProject.set(sid, p.key);
  if (payload.hook_event_name === 'SessionStart' || !followKey) setFollow(p);

  const ev = normalizeHook(payload);
  if (!ev) return null;
  p.lastActive = Date.now();

  const rel = ev.file ? toRel(p.root, ev.file) : null;
  const event = {
    id: nextId++,
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
    root: p.root,
  };

  if (rel && (event.kind === 'edit' || event.kind === 'create')) p.modified.add(rel);
  if (rel && event.kind === 'create') {
    p.created.add(rel);
    if (!p.graph.nodes.some((n) => n.id === rel)) {
      const node = { id: rel, name: path.posix.basename(rel), module: moduleFor(rel, p.graph.modulePrefixes), loc: event.stats?.added || 1 };
      p.graph.nodes.push(node);
      event.node = node;
    }
  }
  if (event.kind === 'test_result') p.lastTest = { ok: event.ok, ...event.stats, ts: event.ts };
  p.trackAgent(event, ev);

  p.events.push(event);
  if (p.events.length > MAX_EVENTS) p.events.shift();
  fs.appendFile(LOG_FILE, JSON.stringify(event) + '\n', () => {});
  send(p.key, { type: 'event', event, summary: p.summary() });
  return event;
}

// ---------------------------------------------------------------- http
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary', '.hdr': 'application/octet-stream',
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

/** ?project=<dir> picks a project; without it, the followed project. */
function pickProject(url) {
  const dir = url.searchParams.get('project');
  return dir ? projectFor(dir, { exact: true }) : projects.get(followKey) || null;
}

const handler = async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  try {
    if (req.method === 'POST' && url.pathname === '/event') {
      ingest(JSON.parse(await readBody(req)));
      // Empty 2xx: Claude Code's http hooks parse a JSON body as hook output, so send none.
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/project') {
      const { root } = JSON.parse(await readBody(req));
      const p = projectFor(root, { exact: true });
      if (!p) return json(res, 404, { ok: false, error: 'project folder not found' });
      setFollow(p);
      return json(res, 200, p.summary());
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      // lets `adm` and the auto-start hook tell this monitor apart from another program on the port
      return json(res, 200, {
        app: 'ai-dev-monitor', pid: process.pid, port: listenPort, standalone,
        uptime: Math.round((Date.now() - startedAt) / 1000), follow: projects.get(followKey)?.root || null,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const p = pickProject(url);
      if (!p) return json(res, 200, { project: null, summary: null, graph: null, events: [] });
      return json(res, 200, { project: p.root, summary: p.summary(), graph: p.graph, events: p.events });
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      return json(res, 200, {
        follow: projects.get(followKey)?.root || null,
        projects: [...projects.values()].sort((a, b) => b.lastActive - a.lastActive).map((p) => ({
          root: p.root, name: path.basename(p.root), lastActive: new Date(p.lastActive).toISOString(),
          events: p.events.length, activeAgents: p.agents.size + p.pendingAgents.length,
        })),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const p = pickProject(url);
      const all = listSessions(LOG_FILE);
      const sessions = p ? all.filter((s) => !s.root || keyOf(s.root) === p.key) : all;
      return json(res, 200, { sessions, live: p?.events.at(-1)?.session || null });
    }
    if (req.method === 'GET' && url.pathname === '/api/replay') {
      const seg = sessionEvents(LOG_FILE, url.searchParams.get('key') || '');
      if (!seg) return json(res, 404, { ok: false, error: 'session not found' });
      return json(res, 200, { key: seg.key, root: seg.root, events: seg.events });
    }
    if (req.method === 'GET' && url.pathname === '/api/graph') {
      const root = url.searchParams.get('root');
      const known = root ? projects.get(keyOf(root)) : projects.get(followKey);
      if (known) return json(res, 200, { graph: known.graph });
      if (!root || !isDir(root)) return json(res, 404, { ok: false, error: 'project folder not found' });
      return json(res, 200, { graph: scanProject(path.resolve(root)) });
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

/**
 * Start the monitor. Used by the CLI below and by the VS Code extension (in-process).
 * Rejects with err.code === 'EADDRINUSE' when another monitor already owns the port.
 * @returns {Promise<{port:number, close:() => Promise<void>}>}
 */
export function startServer({ port = 7777, project, dataDir, silent = false } = {}) {
  quiet = silent;
  const dir = dataDir || path.join(APP_ROOT, 'data');
  fs.mkdirSync(dir, { recursive: true });
  LOG_FILE = path.join(dir, 'events.jsonl');
  nextId = Math.max(nextId, maxEventId(LOG_FILE) + 1); // ids stay unique across restarts

  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      listenPort = port;
      wss = new WebSocketServer({ server, path: '/ws' });
      wss.on('connection', (ws, req) => {
        const dirParam = new URL(req.url, `http://${HOST}`).searchParams.get('project');
        const p = dirParam ? projectFor(dirParam, { exact: true }) : projects.get(followKey) || null;
        if (dirParam && p) ws.projectKey = p.key; else ws.follow = true;
        ws.send(JSON.stringify(p ? p.hello() : { type: 'hello', project: null, graph: null, events: [], summary: null }));
      });
      if (project) setFollow(projectFor(project, { exact: true }));
      log(`[monitor] open http://localhost:${port}`);
      resolve({
        port,
        close: () => new Promise((done) => {
          for (const p of projects.values()) p.close();
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
  standalone = true;
  // pid file: `adm stop` uses it to stop a standalone server (never the one inside VS Code)
  const pidFile = path.join(APP_ROOT, 'data', `server-${port}.pid`);
  startServer({ port, project }).then(() => {
    fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port }));
    const cleanup = () => { try { if (JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid === process.pid) fs.rmSync(pidFile); } catch { /* gone */ } };
    process.on('exit', cleanup);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0));
  }).catch((err) => {
    if (err.code === 'EADDRINUSE') console.error(`[monitor] port ${port} is already in use. Is the monitor already running?`);
    else console.error('[monitor]', err);
    process.exit(1);
  });
}
