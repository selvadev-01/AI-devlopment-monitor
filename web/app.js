// UI shell: WebSocket connection, panels, theme switch. 3D work lives in engine.js.
import { GraphModel } from './model.js';
import { Engine } from './engine.js';

const $ = (id) => document.getElementById(id);
const model = new GraphModel();
const ICONS = {
  read: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/>',
  create: '<path d="M12 5v14M5 12h14"/>',
  bash: '<path d="m5 7 5 5-5 5M12 19h7"/>',
  test_ok: '<path d="m5 12 5 5 9-10"/>',
  test_fail: '<path d="M6 6l12 12M18 6 6 18"/>',
  agent: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M7.5 8 11 16M16.5 8 13 16"/>',
  prompt: '<path d="M4 5h16v11H8l-4 4z"/>',
  idle: '<path d="M9 6v12M15 6v12"/>',
  dot: '<circle cx="12" cy="12" r="3"/>',
};
const LABEL = {
  read: 'READ', search: 'SEARCH', edit: 'EDIT', create: 'CREATE', bash: 'BASH', bash_result: 'DONE',
  test_result: 'TESTS', agent_start: 'SUBAGENT', agent_stop: 'AGENT DONE', prompt: 'PROMPT', idle: 'IDLE',
  session: 'SESSION', notify: 'NOTICE', web: 'WEB', other: 'TOOL',
};
const NOW_COLORS = {
  read: 'var(--read)', search: 'var(--search)', edit: 'var(--edit)', create: 'var(--create)', bash: 'var(--bash)',
  bash_result: 'var(--bash)', test_ok: 'var(--ok)', test_fail: 'var(--fail)', bash_fail: 'var(--fail)',
  agent_start: 'var(--agent)', agent_stop: 'var(--agent)', prompt: 'var(--prompt)',
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

// ------------------------------------------------------------------ engine
const tooltip = $('tooltip');
const engine = new Engine($('stage'), model, {
  onHover(id, px) {
    const n = id && model.nodes.get(id);
    if (!n) { tooltip.hidden = true; return; }
    const mod = model.modified.get(id);
    const small = document.createElement('small');
    small.textContent = `${n.module} · ${n.loc} lines · ${model.dependentsOf(id).length} dependents${mod ? ` · +${mod.added} −${mod.removed}` : ''}`;
    tooltip.replaceChildren(document.createTextNode(id), small);
    tooltip.style.left = px.x + 'px';
    tooltip.style.top = px.y + 'px';
    tooltip.hidden = false;
  },
});

let theme = store.get('adm-theme') === 'galaxy' ? 'galaxy' : 'neural';
function setTheme(name) {
  theme = name;
  store.set('adm-theme', name);
  for (const b of document.querySelectorAll('.seg-btn')) {
    b.classList.toggle('active', b.dataset.theme === name);
    b.setAttribute('aria-selected', String(b.dataset.theme === name));
  }
  renderLegend();
  if (model.nodes.size) engine.setTheme(name);
}
for (const b of document.querySelectorAll('.seg-btn')) b.addEventListener('click', () => setTheme(b.dataset.theme));
window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  if (e.key === 't' || e.key === 'T') setTheme(theme === 'neural' ? 'galaxy' : 'neural');
  if (e.key === 'f' || e.key === 'F') engine.overview();
});

function renderLegend() {
  const items = theme === 'neural'
    ? [['Read', 'var(--read)'], ['Edit', 'var(--edit)'], ['New', 'var(--create)'], ['Failing', 'var(--fail)'], ['Subagent', 'var(--agent)']]
    : [['Scan', 'var(--read)'], ['Build', 'var(--edit)'], ['New planet', 'var(--create)'], ['Failing', 'var(--fail)'], ['Scout', 'var(--agent)']];
  $('legend').replaceChildren(...items.map(([t, c]) => {
    const s = document.createElement('span');
    const i = document.createElement('i');
    i.style.setProperty('--c', c);
    s.append(i, t);
    return s;
  }));
}

// ------------------------------------------------------------------ panels
function renderModules() {
  const changedBy = new Map();
  for (const id of model.modified.keys()) {
    const m = model.nodes.get(id)?.module;
    if (m) changedBy.set(m, (changedBy.get(m) || 0) + 1);
  }
  $('modules').replaceChildren(...[...model.modules.values()].map((m) => {
    const li = document.createElement('li');
    li.style.setProperty('--c', m.color);
    const dot = document.createElement('span'); dot.className = 'dot';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = m.name;
    li.append(dot, name);
    if (changedBy.get(m.name)) {
      const c = document.createElement('span'); c.className = 'mod'; c.textContent = `${changedBy.get(m.name)} changed`;
      li.append(c);
    }
    const n = document.createElement('span'); n.className = 'n'; n.textContent = m.files.length;
    li.append(n);
    li.title = `Focus ${m.name}`;
    li.addEventListener('click', () => engine.focusModule(m.name));
    return li;
  }));
}

const changedOrder = new Map();
function renderChanged() {
  const ul = $('changed');
  const ids = [...model.modified.keys()].sort((a, b) => (changedOrder.get(b) || 0) - (changedOrder.get(a) || 0));
  $('changed-count').textContent = ids.length;
  if (!ids.length) { ul.innerHTML = '<li class="empty">No changes yet</li>'; return; }
  ul.replaceChildren(...ids.map((id) => {
    const li = document.createElement('li');
    const tag = document.createElement('span');
    const failing = model.failing.has(id);
    tag.className = 'tag' + (failing ? ' fail' : model.created.has(id) ? ' new' : '');
    tag.textContent = failing ? '✗' : model.created.has(id) ? 'A' : 'M';
    const file = document.createElement('span'); file.className = 'file'; file.textContent = id; file.title = id;
    li.append(tag, file, diffEl(model.modified.get(id)));
    li.addEventListener('click', () => engine.focusFile(id));
    return li;
  }));
}

function diffEl(st) {
  const d = document.createElement('span'); d.className = 'diff';
  const a = document.createElement('span'); a.className = 'a'; a.textContent = `+${st?.added ?? 0}`;
  const r = document.createElement('span'); r.className = 'r'; r.textContent = `−${st?.removed ?? 0}`;
  d.append(a, r);
  return d;
}

function kindClass(ev) {
  if (ev.kind === 'test_result') return ev.ok ? 'test_ok' : 'test_fail';
  if (ev.kind === 'bash_result' && !ev.ok) return 'bash_fail';
  return ev.kind;
}
function iconFor(ev) {
  const k = kindClass(ev);
  if (ICONS[k]) return ICONS[k];
  if (k.startsWith('agent')) return ICONS.agent;
  if (k === 'bash_result' || k === 'bash_fail') return ICONS.bash;
  return ICONS.dot;
}
function kindLabel(ev) {
  if (ev.kind === 'bash' && ev.isTest) return 'TEST RUN';
  if (ev.kind === 'bash_result' && !ev.ok) return 'FAILED';
  return LABEL[ev.kind] || ev.kind.toUpperCase();
}
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

let eventCount = 0;
function feedItem(ev, fresh) {
  const li = document.createElement('li');
  li.className = `k-${kindClass(ev)}${fresh ? ' fresh' : ''}${ev.file ? ' clickable' : ''}`;
  const icon = document.createElement('span');
  icon.className = 'ev-icon';
  icon.innerHTML = `<svg viewBox="0 0 24 24">${iconFor(ev)}</svg>`; // static markup from ICONS only
  const body = document.createElement('div'); body.className = 'ev-body';
  const top = document.createElement('div'); top.className = 'ev-top';
  const kind = document.createElement('span'); kind.className = 'ev-kind'; kind.textContent = kindLabel(ev);
  const t = document.createElement('span'); t.className = 'ev-time'; t.textContent = time(ev.ts);
  top.append(kind, t);
  const detail = document.createElement('div'); detail.className = 'ev-detail';
  detail.textContent = ev.detail || ''; detail.title = ev.detail || '';
  body.append(top, detail);
  if (ev.file && ev.kind !== 'read') {
    const f = document.createElement('div'); f.className = 'ev-file'; f.textContent = ev.file;
    body.append(f);
  }
  if (ev.stats && (ev.kind === 'edit' || ev.kind === 'create')) {
    const x = document.createElement('div'); x.className = 'ev-extra';
    x.append(diffEl(ev.stats));
    const deps = model.dependentsOf(ev.file).length;
    if (deps) { const c = document.createElement('span'); c.className = 'chip'; c.textContent = `${deps} dependent${deps > 1 ? 's' : ''}`; x.append(c); }
    body.append(x);
  }
  li.append(icon, body);
  if (ev.file) li.addEventListener('click', () => engine.focusFile(ev.file));
  return li;
}

function pushFeed(ev, fresh) {
  const ol = $('feed');
  ol.querySelector('.empty')?.remove();
  ol.prepend(feedItem(ev, fresh));
  while (ol.children.length > 200) ol.lastElementChild.remove();
  $('event-count').textContent = ++eventCount;
}

function renderNow(ev) {
  const kindEl = $('now-kind');
  kindEl.textContent = kindLabel(ev);
  kindEl.style.setProperty('--c', NOW_COLORS[kindClass(ev)] || 'var(--muted)');
  $('now-detail').textContent = ev.file ? `${ev.detail}  ·  ${ev.file}` : ev.detail;
  const s = $('now-stats');
  s.replaceChildren();
  if (ev.stats && (ev.kind === 'edit' || ev.kind === 'create')) s.append(diffEl(ev.stats));
}

function renderSummary(sum) {
  if (!sum) return;
  $('project').textContent = sum.project || '—';
  $('sb-files').textContent = sum.files;
  $('sb-links').textContent = sum.links;
  $('sb-modified').textContent = sum.modified;
  $('sb-created').textContent = sum.created;
  $('sb-agents').textContent = `${sum.activeAgents} agent${sum.activeAgents === 1 ? '' : 's'}`;
  $('sb-path').textContent = sum.root || '';
  const tests = $('sb-tests');
  tests.className = 'tests';
  if (sum.lastTest) {
    tests.classList.add(sum.lastTest.ok ? 'ok' : 'fail');
    tests.textContent = sum.lastTest.ok ? `✓ ${sum.lastTest.passed || 'all'} passed` : `✗ ${sum.lastTest.failed} failed · ${sum.lastTest.passed} passed`;
  } else tests.textContent = 'tests —';
}

// ------------------------------------------------------------------ status
let wsOpen = false;
let lastEventAt = 0;
let lastKind = 'idle';
function renderStatus() {
  const el = $('status');
  const live = wsOpen && lastKind !== 'idle' && Date.now() - lastEventAt < 30000;
  el.className = 'status ' + (!wsOpen ? '' : live ? 'live' : 'idle');
  el.querySelector('b').textContent = !wsOpen ? 'OFFLINE' : live ? 'LIVE' : 'IDLE';
}
setInterval(renderStatus, 1000);

// ------------------------------------------------------------------ socket
function onHello(msg) {
  model.setGraph(msg.graph, true);
  changedOrder.clear();
  $('feed').innerHTML = '<li class="empty">Events from Claude Code will appear here.</li>';
  eventCount = 0;
  $('event-count').textContent = 0;
  for (const ev of msg.events || []) {
    model.apply(ev);
    if (ev.file && model.modified.has(ev.file)) changedOrder.set(ev.file, ev.id);
    pushFeed(ev, false);
  }
  const last = msg.events?.[msg.events.length - 1];
  if (last) { renderNow(last); lastKind = last.kind; lastEventAt = Date.parse(last.ts); }
  if (model.nodes.size) engine.setTheme(theme);
  renderModules(); renderChanged(); renderSummary(msg.summary);
}

function onGraph(msg) {
  if (msg.reset) {
    model.setGraph(msg.graph, true);
    changedOrder.clear();
    engine.setTheme(theme);
  } else {
    model.setGraph(msg.graph, false);
    if (engine.theme) engine.sync(); else engine.setTheme(theme);
  }
  renderModules(); renderChanged(); renderSummary(msg.summary);
}

function onEvent(msg) {
  const ev = msg.event;
  const meta = model.apply(ev);
  if (ev.file && model.modified.has(ev.file)) changedOrder.set(ev.file, ev.id);
  if (!engine.theme && model.nodes.size) engine.setTheme(theme);
  engine.handleEvent(ev, meta);
  pushFeed(ev, true);
  renderNow(ev);
  lastEventAt = Date.now(); lastKind = ev.kind;
  renderStatus();
  if (ev.kind === 'edit' || ev.kind === 'create' || ev.kind === 'test_result') { renderModules(); renderChanged(); }
  renderSummary(msg.summary);
}

let retry = 500;
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { wsOpen = true; retry = 500; renderStatus(); };
  ws.onclose = () => { wsOpen = false; renderStatus(); setTimeout(connect, retry); retry = Math.min(retry * 2, 8000); };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'hello') onHello(msg);
    else if (msg.type === 'graph') onGraph(msg);
    else if (msg.type === 'event') onEvent(msg);
  };
}

setTheme(theme);
connect();
