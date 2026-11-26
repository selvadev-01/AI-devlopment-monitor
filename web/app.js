// UI shell: WebSocket connection, panels, theme switch. 3D work lives in engine.js.
import { GraphModel, displayName } from './model.js';
import { Engine } from './engine.js';
import { ReplayClock, TimelineUI, SPEEDS } from './replay.js';
import { AGENT_COLORS } from './fx.js';

const $ = (id) => document.getElementById(id);
const model = new GraphModel();
// ?project=<folder> pins this view to one project (one panel per project when working in parallel).
// Without it the view follows whichever project Claude was most recently started in.
const PROJECT = new URLSearchParams(location.search).get('project');
const Q = PROJECT ? `?project=${encodeURIComponent(PROJECT)}` : '';
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
  ask: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01"/>',
  notify: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
};
const LABEL = {
  read: 'READ', search: 'SEARCH', edit: 'EDIT', create: 'CREATE', bash: 'BASH', bash_result: 'DONE',
  test_result: 'TESTS', agent_start: 'SUBAGENT', agent_stop: 'AGENT DONE', prompt: 'PROMPT', idle: 'IDLE',
  session: 'SESSION', notify: 'NOTICE', web: 'WEB', other: 'TOOL', ask: 'QUESTION',
};
const NOW_COLORS = {
  read: 'var(--read)', search: 'var(--search)', edit: 'var(--edit)', create: 'var(--create)', bash: 'var(--bash)',
  bash_result: 'var(--bash)', test_ok: 'var(--ok)', test_fail: 'var(--fail)', bash_fail: 'var(--fail)',
  agent_start: 'var(--agent)', agent_stop: 'var(--agent)', prompt: 'var(--prompt)', ask: 'var(--edit)',
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

// ------------------------------------------------------------------ engine
const tooltip = $('tooltip');
// Render quality: ?quality=low|balanced|high (the VS Code extension passes its setting), else saved choice.
const QUALITY = new URLSearchParams(location.search).get('quality') || store.get('adm-quality') || 'balanced';
const engine = new Engine($('stage'), model, {
  quality: QUALITY,
  onOpen: (id) => openFile(id),
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

// ------------------------------------------------------------------ go to / open a file
/** Fly to a file; in focus mode its module opens up first. */
function goToFile(id) {
  const m = model.nodes.get(id)?.module;
  if (m) model.touched.set(m, ++model.touchSeq);
  engine.focusFile(id);
}

const EMBEDDED = window.parent !== window; // inside the VS Code panel (an iframe in a webview)
/** Open a file in the editor: the VS Code panel relays the request; a browser uses a vscode:// link. */
function openFile(id) {
  if (!model.root || !model.nodes.has(id)) return;
  const win = /^[A-Za-z]:/.test(model.root) || model.root.includes('\\');
  const sep = win ? '\\' : '/';
  const abs = model.root.replace(/[\\/]+$/, '') + sep + id.split('/').join(sep);
  if (EMBEDDED) { window.parent.postMessage({ type: 'adm-open', path: abs }, '*'); return; }
  const url = 'vscode://file/' + encodeURI(abs.split('\\').join('/').replace(/^\/+/, ''));
  const a = document.createElement('a'); a.href = url; a.click();
}

function openButton(id) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'open-btn'; b.textContent = 'open';
  b.title = 'Open in editor';
  b.addEventListener('click', (e) => { e.stopPropagation(); openFile(id); });
  return b;
}

// ------------------------------------------------------------------ file search
const searchEl = $('search');
const resultsEl = $('search-results');
let results = []; let sel = 0;

/** Ranked matches: file name first, then path; a fuzzy (in-order letters) match comes last. */
function searchFiles(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const n of model.nodes.values()) {
    const id = n.id.toLowerCase(); const name = n.name.toLowerCase();
    let score = -1;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (id.includes(q)) score = 40;
    else {
      let i = 0;
      for (const ch of name) if (ch === q[i]) i++;
      if (i === q.length) score = 20;
    }
    if (score < 0) continue;
    if (model.modified.has(n.id)) score += 5; // files Claude touched are more likely what you want
    out.push({ n, score: score - id.length / 1000 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 12).map((r) => r.n);
}

function highlight(text, q) {
  const span = document.createElement('span');
  const i = text.toLowerCase().indexOf(q);
  if (!q || i < 0) { span.textContent = text; return span; }
  const mark = document.createElement('mark'); mark.textContent = text.slice(i, i + q.length);
  span.append(text.slice(0, i), mark, text.slice(i + q.length));
  return span;
}

function renderResults() {
  const q = searchEl.value.trim().toLowerCase();
  results = searchFiles(q);
  sel = Math.min(sel, Math.max(0, results.length - 1));
  const open = Boolean(q);
  resultsEl.hidden = !open;
  searchEl.setAttribute('aria-expanded', String(open));
  if (!open) return;
  // fixed position: the dropdown is wider than the left panel, which clips its overflow
  const box = searchEl.closest('.search-box').getBoundingClientRect();
  resultsEl.style.left = box.left + 'px';
  resultsEl.style.top = box.bottom + 6 + 'px';
  if (!results.length) { resultsEl.innerHTML = '<li class="empty">No matching files</li>'; return; }
  const rows = results.map((n, i) => {
    const li = document.createElement('li');
    li.id = `sr-${i}`; li.setAttribute('role', 'option');
    li.className = i === sel ? 'sel' : '';
    li.setAttribute('aria-selected', String(i === sel));
    li.style.setProperty('--c', model.colorFor(n.id));
    const dot = document.createElement('span'); dot.className = 'dot';
    const nm = document.createElement('span'); nm.className = 'nm';
    nm.append(highlight(n.name, q));
    // LRM marks keep "/" and "." in place inside the right-to-left (end-first) ellipsis
    const small = document.createElement('small'); small.textContent = '‎' + (n.id.slice(0, -n.name.length - 1) || '.') + '‎';
    nm.append(small);
    li.append(dot, nm, openButton(n.id));
    li.title = n.id;
    li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
    li.addEventListener('click', () => { goToFile(n.id); closeSearch(); });
    return li;
  });
  const foot = document.createElement('li'); foot.className = 'foot';
  foot.textContent = 'Enter: fly to file · Ctrl+Enter: open in editor · Esc: close';
  resultsEl.replaceChildren(...rows, foot);
  searchEl.setAttribute('aria-activedescendant', `sr-${sel}`);
  const selEl = resultsEl.querySelector('.sel'); // scroll the list only, never the panel
  if (selEl) {
    if (selEl.offsetTop < resultsEl.scrollTop) resultsEl.scrollTop = selEl.offsetTop;
    else if (selEl.offsetTop + selEl.offsetHeight > resultsEl.scrollTop + resultsEl.clientHeight) resultsEl.scrollTop = selEl.offsetTop + selEl.offsetHeight - resultsEl.clientHeight;
  }
}

function closeSearch() { searchEl.value = ''; renderResults(); searchEl.blur(); }

searchEl.addEventListener('input', () => { sel = 0; renderResults(); });
searchEl.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== searchEl) { resultsEl.hidden = true; searchEl.setAttribute('aria-expanded', 'false'); } }, 120));
searchEl.addEventListener('focus', () => { if (searchEl.value.trim()) renderResults(); });
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (results.length) sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
    renderResults();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const n = results[sel];
    if (!n) return;
    if (e.ctrlKey || e.metaKey) openFile(n.id);
    else { goToFile(n.id); closeSearch(); }
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    closeSearch();
  }
});

const THEME_ORDER = ['neural', 'galaxy'];
window.__monitor = { engine, model }; // handy for debugging from the browser console
let theme = THEME_ORDER.includes(store.get('adm-theme')) ? store.get('adm-theme') : 'neural';
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
  if (e.target.closest?.('input, textarea, select, button')) return;
  if (e.key === '/' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); searchEl.focus(); searchEl.select(); return; }
  if (e.key === 't' || e.key === 'T') setTheme(THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]);
  if (e.key === 'f' || e.key === 'F') engine.overview();
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  if (e.key === 'Escape') { if (!summaryEl.hidden) { summaryEl.hidden = true; return; } goLive(); }
  if (mode === 'replay' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    seekQueued = rclock.t + (e.key === 'ArrowLeft' ? -5 : 5);
  }
});

function renderLegend() {
  const LEGENDS = {
    neural: [['Read', 'var(--read)'], ['Edit', 'var(--edit)'], ['New', 'var(--create)'], ['Failing', 'var(--fail)'], ['Subagent', 'var(--agent)']],
    galaxy: [['Scan', 'var(--read)'], ['Build', 'var(--edit)'], ['New planet', 'var(--create)'], ['Failing', 'var(--fail)'], ['Scout', 'var(--agent)']],
  };
  const items = LEGENDS[theme] || LEGENDS.neural;
  $('legend').replaceChildren(...items.map(([t, c]) => {
    const s = document.createElement('span');
    const i = document.createElement('i');
    i.style.setProperty('--c', c);
    s.append(i, t);
    return s;
  }));
}

// ------------------------------------------------------------------ panels
// Big projects: modules grouped under their top folder; groups with changes start expanded.
const openTops = new Map(); // top folder -> expanded (only set once the user toggles it)

function moduleRow(m, label, changed) {
  const li = document.createElement('li');
  li.style.setProperty('--c', m.color);
  const dot = document.createElement('span'); dot.className = 'dot';
  const name = document.createElement('span'); name.className = 'name'; name.textContent = label;
  li.append(dot, name);
  if (changed) {
    const c = document.createElement('span'); c.className = 'mod'; c.textContent = `${changed} changed`;
    li.append(c);
  }
  const n = document.createElement('span'); n.className = 'n'; n.textContent = m.files.length;
  li.append(n);
  li.title = `Focus ${m.name}`;
  li.addEventListener('click', () => {
    model.touched.set(m.name, ++model.touchSeq); // opens it in focus mode
    engine.focusModule(m.name);
  });
  return li;
}

function renderModules() {
  const changedBy = new Map();
  for (const id of model.modified.keys()) {
    const m = model.nodes.get(id)?.module;
    if (m) changedBy.set(m, (changedBy.get(m) || 0) + 1);
  }
  const mods = [...model.modules.values()];
  const tops = new Map();
  for (const m of mods) {
    const t = m.name.split('/')[0];
    if (!tops.has(t)) tops.set(t, []);
    tops.get(t).push(m);
  }
  if (!model.large || tops.size === mods.length) {
    $('modules').replaceChildren(...mods.map((m) => moduleRow(m, m.name, changedBy.get(m.name))));
    return;
  }
  const rows = [];
  const sorted = [...tops.entries()].map(([t, list]) => ({
    t, list, files: list.reduce((a, m) => a + m.files.length, 0), changed: list.reduce((a, m) => a + (changedBy.get(m.name) || 0), 0),
  })).sort((a, b) => b.changed - a.changed || b.files - a.files);
  for (const g of sorted) {
    // Not toggled yet: a group with changes shows only its changed modules.
    const open = openTops.has(g.t) ? openTops.get(g.t) : g.changed > 0;
    const onlyChanged = !openTops.has(g.t);
    const li = document.createElement('li');
    li.className = 'group' + (open ? ' open' : '');
    li.style.setProperty('--c', model.familyOf?.get(g.t) || g.list[0].color);
    const chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = open ? '▾' : '▸';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = g.t;
    const sub = document.createElement('span'); sub.className = 'n'; sub.textContent = g.files;
    li.title = `${g.t}: ${g.list.length} modules, ${g.files} files`;
    li.append(chev, name);
    if (g.changed) { const c = document.createElement('span'); c.className = 'mod'; c.textContent = `${g.changed} changed`; li.append(c); }
    li.append(sub);
    li.setAttribute('role', 'button');
    li.setAttribute('aria-expanded', String(open));
    li.addEventListener('click', () => { openTops.set(g.t, !open); renderModules(); });
    rows.push(li);
    if (!open) continue;
    const list = g.list.filter((m) => !onlyChanged || changedBy.get(m.name)).sort((a, b) => (changedBy.get(b.name) || 0) - (changedBy.get(a.name) || 0) || b.files.length - a.files.length);
    for (const m of list) {
      const row = moduleRow(m, m.name === g.t ? '(root)' : m.name.slice(g.t.length + 1), changedBy.get(m.name));
      row.classList.add('child');
      rows.push(row);
    }
    if (onlyChanged && list.length < g.list.length) {
      const more = document.createElement('li');
      more.className = 'child more';
      more.textContent = `+ ${g.list.length - list.length} more`;
      more.addEventListener('click', () => { openTops.set(g.t, true); renderModules(); });
      rows.push(more);
    }
  }
  $('modules').replaceChildren(...rows);
}

const agentColor = (i) => AGENT_COLORS[(i ?? 0) % AGENT_COLORS.length];

function renderAgents() {
  const list = [...model.agents.values()];
  $('agent-count').textContent = list.length;
  if (!list.length) { $('agents').innerHTML = '<li class="empty">No subagents running</li>'; return; }
  $('agents').replaceChildren(...list.map((a) => {
    // Compact once several run at once: one line each (type + task), the latest action in the tooltip.
    const li = document.createElement('li');
    if (list.length > 3) li.className = 'compact';
    li.style.setProperty('--c', agentColor(a.color));
    const dot = document.createElement('span'); dot.className = 'dot';
    const body = document.createElement('div'); body.style.minWidth = '0';
    const row = document.createElement('div'); row.className = 'row';
    const type = document.createElement('span'); type.className = 'type'; type.textContent = a.type;
    const tools = document.createElement('span'); tools.className = 'tools'; tools.textContent = `${a.tools} tool${a.tools === 1 ? '' : 's'}`;
    const task = document.createElement('span'); task.className = 'task'; task.textContent = a.label || '';
    const last = document.createElement('div'); last.className = 'last'; last.textContent = a.last || '';
    if (list.length > 3) { row.append(type, task, tools); body.append(row); }
    else { row.append(type, tools); task.classList.add('block'); body.append(row, task, last); }
    li.append(dot, body);
    li.title = `${a.type}: ${a.label || ''}
${a.last || ''}${a.file ? `
Click to fly to ${a.file}` : ''}`;
    if (a.file) li.addEventListener('click', () => engine.focusFile(a.file));
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
    li.append(tag, file, diffEl(model.modified.get(id)), openButton(id));
    li.addEventListener('click', () => goToFile(id));
    li.addEventListener('dblclick', () => openFile(id));
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
  // subagent rows are quieter than the main Claude's, so the main thread stays easy to follow
  li.className = `k-${kindClass(ev)}${fresh ? ' fresh' : ''}${ev.file ? ' clickable' : ''}${ev.agent ? ' sub' : ''}`;
  const icon = document.createElement('span');
  icon.className = 'ev-icon';
  icon.innerHTML = `<svg viewBox="0 0 24 24">${iconFor(ev)}</svg>`; // static markup from ICONS only
  const body = document.createElement('div'); body.className = 'ev-body';
  const top = document.createElement('div'); top.className = 'ev-top';
  const kind = document.createElement('span'); kind.className = 'ev-kind'; kind.textContent = kindLabel(ev);
  const t = document.createElement('span'); t.className = 'ev-time'; t.textContent = time(ev.ts);
  top.append(kind);
  if (ev.agent || (ev.kind === 'agent_start' && ev.agentType)) {
    const chip = document.createElement('span');
    chip.className = 'chip agent-chip';
    chip.style.setProperty('--c', agentColor(ev.agentColor));
    chip.textContent = ev.agentType || 'subagent';
    top.append(chip);
  }
  top.append(t);
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

/**
 * Subagents working in parallel do the same kind of thing at once (ten "Grep refund"s). Consecutive
 * subagent events of one kind within a few seconds share one row: "SEARCH · 10 agents" with the
 * latest few lines, instead of flooding the feed. A main-Claude event always starts a new row.
 */
const GROUP_WINDOW_MS = 6000;
function renderGroup(li) {
  const entries = li._entries;
  const ev = entries[entries.length - 1];
  const body = li.querySelector('.ev-body');
  const top = document.createElement('div'); top.className = 'ev-top';
  const kind = document.createElement('span'); kind.className = 'ev-kind'; kind.textContent = kindLabel(ev);
  const chip = document.createElement('span'); chip.className = 'chip agent-chip';
  const agents = new Set(entries.map((e) => e.agent));
  chip.textContent = `${agents.size} agent${agents.size > 1 ? 's' : ''}`;
  const t = document.createElement('span'); t.className = 'ev-time'; t.textContent = time(ev.ts);
  top.append(kind, chip, t);
  const lines = entries.slice(-3).reverse().map((e) => {
    const row = document.createElement('div'); row.className = 'ev-line';
    row.style.setProperty('--c', agentColor(e.agentColor));
    const dot = document.createElement('i');
    const b = document.createElement('b'); b.textContent = e.agentType || 'agent';
    row.append(dot, b, document.createTextNode(` ${e.detail || ''}`));
    row.title = e.detail || '';
    return row;
  });
  body.replaceChildren(top, ...lines);
  if (entries.length > 3) {
    const more = document.createElement('div'); more.className = 'ev-more'; more.textContent = `+ ${entries.length - 3} more`;
    body.append(more);
  }
}

function pushFeed(ev, fresh) {
  const ol = $('feed');
  ol.querySelector('.empty')?.remove();
  const first = ol.firstElementChild;
  const key = ev.agent && ev.kind !== 'agent_stop' ? `sub:${ev.kind}` : null;
  if (key && first?._group === key && new Date(ev.ts) - new Date(first._entries.at(-1).ts) < GROUP_WINDOW_MS) {
    first._entries.push(ev);
    first.classList.add('grouped');
    renderGroup(first);
  } else {
    const li = feedItem(ev, fresh);
    if (key) { li._group = key; li._entries = [ev]; }
    ol.prepend(li);
  }
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
let mode = 'live';           // 'live' | 'replay'
function renderStatus() {
  const el = $('status');
  if (mode === 'replay') {
    el.className = 'status replay';
    el.querySelector('b').textContent = 'REPLAY';
    return;
  }
  const live = wsOpen && lastKind !== 'idle' && Date.now() - lastEventAt < 30000;
  el.className = 'status ' + (!wsOpen ? '' : live ? 'live' : 'idle');
  el.querySelector('b').textContent = !wsOpen ? 'OFFLINE' : live ? 'LIVE' : 'IDLE';
}
setInterval(renderStatus, 1000);

function resetFeed(events) {
  $('feed').innerHTML = '<li class="empty">Events from Claude Code will appear here.</li>';
  eventCount = 0;
  $('event-count').textContent = 0;
  for (const ev of events) pushFeed(ev, false);
}

// ------------------------------------------------------------------ replay
const rclock = new ReplayClock();
const liveClock = new ReplayClock();
let liveEvents = [];
let pending = 0;
let replayGraph = null;
let replayRoot = null;
let selectedKey = null;
let seekQueued = null;
let liveSessionId = null;

const timeline = new TimelineUI({
  classOf: kindClass,
  onToggle: () => togglePlay(),
  onSeek: (k) => {
    if (mode === 'replay') seekQueued = k * rclock.duration;
    else startReplay(selectedKey, k);
  },
  onSpeed: () => {
    rclock.speed = SPEEDS[(SPEEDS.indexOf(rclock.speed) + 1) % SPEEDS.length];
    timeline.setSpeed(rclock.speed);
  },
  onLive: () => goLive(),
  onPick: (key) => { selectedKey = key; startReplay(key, 0); },
  onOpenPicker: () => refreshSessions(),
});

async function refreshSessions() {
  try {
    const r = await (await fetch(`/api/sessions${Q}`)).json();
    liveSessionId = r.live;
    if (!selectedKey || !r.sessions.some((s) => s.key === selectedKey)) {
      selectedKey = (r.sessions.find((s) => s.session === r.live) || r.sessions[0])?.key || null;
    }
    timeline.setSessions(r.sessions, selectedKey);
  } catch { /* server offline */ }
}

async function startReplay(key, frac = 0) {
  if (!key) { await refreshSessions(); key = selectedKey; }
  if (!key) return;
  let r; let g;
  try {
    r = await (await fetch(`/api/replay?key=${encodeURIComponent(key)}`)).json();
    if (!r.events?.length) return;
    g = (await (await fetch(`/api/graph${r.root ? `?root=${encodeURIComponent(r.root)}` : ''}`)).json()).graph;
  } catch { return; }
  if (!g) return;

  // Files created during the session should not exist at its start.
  const created = new Set(r.events.filter((e) => e.kind === 'create' && e.file).map((e) => e.file));
  const createdNodes = new Map(g.nodes.filter((n) => created.has(n.id)).map((n) => [n.id, n]));
  for (const e of r.events) if (e.kind === 'create' && !e.node && createdNodes.has(e.file)) e.node = createdNodes.get(e.file);
  replayGraph = {
    ...g,
    nodes: g.nodes.filter((n) => !created.has(n.id)),
    edges: g.edges.filter((e) => !created.has(e.source) && !created.has(e.target)),
  };
  replayRoot = r.root || g.root;
  selectedKey = key;
  mode = 'replay';
  pending = 0;
  timeline.setPending(0);
  rclock.load(r.events);
  timeline.setMode('replay', true);
  timeline.setMarkers(rclock);
  resetReplayState(rclock.seek(frac * rclock.duration));
  engine.setTheme(theme);
  rclock.playing = true;
  renderStatus();
}

function replaySummary(done) {
  let agents = 0; let lastTest = null;
  for (const e of done) {
    if (e.kind === 'agent_start') agents++;
    if (e.kind === 'agent_stop') agents = Math.max(0, agents - 1);
    if (e.kind === 'idle') agents = 0;
    if (e.kind === 'test_result') lastTest = { ok: e.ok, ...e.stats };
  }
  return {
    project: replayGraph?.name, root: replayRoot, files: model.nodes.size, links: model.edges.length,
    modified: model.modified.size, created: model.created.size, lastTest, activeAgents: agents,
  };
}

/** Rebuild model + panels as they were after the first i events (no animation). */
function resetReplayState(i) {
  model.setGraph(replayGraph, true);
  changedOrder.clear();
  const done = rclock.events.slice(0, i);
  for (const ev of done) {
    model.apply(ev);
    if (ev.file && model.modified.has(ev.file)) changedOrder.set(ev.file, ev.id);
  }
  resetFeed(done.slice(-150));
  if (done.length) renderNow(done[done.length - 1]);
  else renderNow({ kind: 'session', detail: 'Start of session' });
  renderModules(); renderChanged(); renderAgents(); renderSummary(replaySummary(done));
}

function playReplayEvent(ev) {
  const meta = model.apply(ev);
  if (ev.file && model.modified.has(ev.file)) changedOrder.set(ev.file, ev.id);
  engine.handleEvent(ev, meta);
  pushFeed(ev, true);
  renderNow(ev);
  if (ev.kind === 'edit' || ev.kind === 'create' || ev.kind === 'test_result') { renderModules(); renderChanged(); }
  if (ev.agent || ev.kind.startsWith('agent')) renderAgents();
  renderSummary(replaySummary(rclock.events.slice(0, rclock.i)));
}

function togglePlay() {
  if (mode === 'live') { startReplay(selectedKey, 0); return; }
  if (!rclock.playing && rclock.t >= rclock.duration) seekQueued = 0;
  rclock.playing = !rclock.playing;
  timeline.setMode('replay', rclock.playing);
}

async function goLive() {
  if (mode === 'live') return;
  mode = 'live';
  rclock.playing = false;
  seekQueued = null;
  pending = 0;
  timeline.setPending(0);
  timeline.setMode('live', false);
  try { onHello(await (await fetch(`/api/state${Q}`)).json()); } catch { /* reconnect will refresh */ }
  renderStatus();
}

function currentLiveSession() {
  const last = liveEvents[liveEvents.length - 1];
  if (!last) return [];
  const evs = liveEvents.filter((e) => e.session === last.session);
  let start = 0;
  evs.forEach((e, i) => { if (e.kind === 'session') start = i; });
  return evs.slice(start);
}

function updateLiveTimeline() {
  if (mode !== 'live') return;
  liveClock.load(currentLiveSession());
  liveClock.seek(liveClock.duration);
  timeline.setMarkers(liveClock);
  timeline.setProgress(liveClock);
}

let lastFrame = performance.now();
function loop(now) {
  const dt = Math.min(0.5, (now - lastFrame) / 1000); // real time, so slow frames don't slow the replay
  lastFrame = now;
  if (mode === 'replay') {
    if (seekQueued != null) {
      const i = rclock.seek(seekQueued);
      seekQueued = null;
      resetReplayState(i);
      engine.sync();
      engine.handleEvent({ kind: 'idle' }, {});
    }
    const wasPlaying = rclock.playing;
    for (const ev of rclock.step(dt)) playReplayEvent(ev);
    if (wasPlaying && !rclock.playing) timeline.setMode('replay', false);
    timeline.setProgress(rclock);
  }
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------ socket
function onHello(msg) {
  liveEvents = (msg.events || []).slice(-500);
  if (mode === 'replay') return;
  model.setGraph(msg.graph, true);
  changedOrder.clear();
  for (const ev of msg.events || []) {
    model.apply(ev);
    if (ev.file && model.modified.has(ev.file)) changedOrder.set(ev.file, ev.id);
  }
  resetFeed((msg.events || []).slice(-150));
  const last = msg.events?.[msg.events.length - 1];
  if (last) { renderNow(last); lastKind = last.kind; lastEventAt = Date.parse(last.ts); }
  if (model.nodes.size) engine.setTheme(theme);
  renderModules(); renderChanged(); renderAgents(); renderSummary(msg.summary);
  updateLiveTimeline();
  refreshSessions();
}

function onGraph(msg) {
  if (mode === 'replay') return;
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

// ------------------------------------------------------------------ needs-you alert
// The server decides when Claude needs the user (permission, question, end of a long turn) and
// also shows a desktop notification. The page adds a banner, a chime and a blinking tab title.
const alertEl = $('alert-banner');
const bellEl = $('bell');
const baseTitle = document.title;
let alertsOn = true; let titleTimer = null; let audio = null;

function chime(level) {
  try {
    audio ??= new AudioContext();
    const notes = level === 'done' ? [660, 880] : [880, 660, 880];
    notes.forEach((f, i) => {
      const o = audio.createOscillator(); const g = audio.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const t = audio.currentTime + i * 0.16;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.16);
    });
  } catch { /* audio blocked until the user interacts with the page */ }
}

function showAlert(alert) {
  if (!alertsOn) return;
  alertEl.className = `alert-banner ${alert.level}`;
  alertEl.replaceChildren();
  const b = document.createElement('b'); b.textContent = alert.title;
  const s = document.createElement('span'); s.textContent = alert.message || '';
  alertEl.append(b, s);
  alertEl.hidden = false;
  chime(alert.level);
  clearInterval(titleTimer);
  let on = false;
  titleTimer = setInterval(() => { on = !on; document.title = on ? `● ${alert.title}` : baseTitle; }, 900);
}
function clearAlert() {
  alertEl.hidden = true;
  clearInterval(titleTimer); titleTimer = null;
  document.title = baseTitle;
}
alertEl.addEventListener('click', clearAlert);

function renderBell() {
  bellEl.classList.toggle('off', !alertsOn);
  bellEl.setAttribute('aria-pressed', String(alertsOn));
  bellEl.title = alertsOn ? 'Alerts on: desktop notification + sound when Claude needs you (click to turn off)' : 'Alerts off (click to turn on)';
}
bellEl.addEventListener('click', async () => {
  alertsOn = !alertsOn; renderBell(); if (!alertsOn) clearAlert();
  try {
    const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alerts: alertsOn }) });
    alertsOn = (await r.json()).alerts; renderBell();
  } catch { /* offline: keep the local choice */ }
});
fetch('/api/settings').then((r) => r.json()).then((s) => { alertsOn = s.alerts !== false; renderBell(); }).catch(() => renderBell());

// ------------------------------------------------------------------ session summary
// What Claude did in a session (server-computed from the full log): opens by itself when a long
// turn ends, and from the Summary button for the live session or the one picked for replay.
const summaryEl = $('summary');
const fmtDur = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

async function openSummary(key = null) {
  let s;
  try {
    const q = key ? `?key=${encodeURIComponent(key)}` : Q;
    const r = await fetch(`/api/summary${q}`);
    if (!r.ok) throw new Error();
    s = await r.json();
  } catch {
    summaryEl.replaceChildren(el('div', 'sum-empty', 'No session recorded yet.'));
    summaryEl.hidden = false;
    return;
  }
  const head = el('header');
  const title = el('div', 'sum-title');
  title.append(el('b', null, 'Session summary'), el('span', null, `${s.project || ''} · ${fmtDur(s.durationSec)} · ${s.prompts} prompt${s.prompts === 1 ? '' : 's'}`));
  const close = el('button', 'sum-close', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => { summaryEl.hidden = true; });
  head.append(title, close);
  const parts = [head];
  if (s.firstPrompt) parts.push(el('p', 'sum-prompt', `“${s.firstPrompt}”`));

  const tile = (label, value, cls = '') => { const d = el('div', `sum-tile ${cls}`); d.append(el('b', null, value), el('span', null, label)); return d; };
  const t = s.tests.last;
  const grid = el('div', 'sum-grid');
  grid.append(
    tile('files read', String(s.files.read)),
    tile('edited', String(s.files.edited), s.files.edited ? 'edit' : ''),
    tile('new files', String(s.files.created), s.files.created ? 'create' : ''),
    tile('lines', `+${s.lines.added} −${s.lines.removed}`),
    tile('tests', t ? (t.ok ? `✓ ${t.passed ?? ''}` : `✗ ${t.failed ?? ''}`) : '—', t ? (t.ok ? 'ok' : 'fail') : ''),
    tile('subagents', String(s.subagents.count), s.subagents.count ? 'agent' : ''),
    tile('commands', String(s.commands)),
    tile('tool calls', String(s.tools)),
  );
  parts.push(grid);

  if (s.modules.length) {
    const mods = el('div', 'sum-mods');
    for (const m of s.modules) {
      const chip = el('span', 'sum-chip', `${displayName(m.module)} · ${m.edits ? `${m.edits} edit${m.edits > 1 ? 's' : ''}` : `${m.touches} read${m.touches > 1 ? 's' : ''}`}`);
      chip.style.setProperty('--c', model.colorOf.get(m.module) || 'var(--muted)');
      mods.append(chip);
    }
    parts.push(el('h3', null, 'Modules'), mods);
  }
  if (s.topFiles.length) {
    const ul = el('ul', 'sum-files');
    for (const f of s.topFiles) {
      const li = el('li');
      const tag = el('span', `tag${f.created ? ' new' : f.edits ? '' : ' read'}`, f.created ? 'A' : f.edits ? 'M' : 'R');
      const name = el('span', 'file', `‎${f.file}‎`); name.title = f.file; // LRM: keeps "." in place in the end-first ellipsis
      li.append(tag, name, f.edits ? diffEl(f) : el('span', 'reads', `${f.reads}×`), openButton(f.file));
      if (model.nodes.has(f.file)) li.addEventListener('click', () => goToFile(f.file));
      ul.append(li);
    }
    parts.push(el('h3', null, 'Files'), ul);
  }
  const types = Object.entries(s.subagents.types);
  if (types.length) parts.push(el('p', 'sum-foot', `Subagents: ${types.map(([k, v]) => `${v}× ${k}`).join(', ')}`));
  summaryEl.replaceChildren(...parts);
  summaryEl.hidden = false;
}
$('summary-btn').addEventListener('click', () => {
  if (!summaryEl.hidden) { summaryEl.hidden = true; return; }
  openSummary(mode === 'replay' ? selectedKey : null);
});

function onEvent(msg) {
  const ev = msg.event;
  if (mode !== 'replay') {
    if (ev.alert?.level === 'done') openSummary(); // a long turn just ended: here is what happened
    if (ev.alert) showAlert(ev.alert);
    else if (!ev.agent && !['notify', 'idle', 'session'].includes(ev.kind)) clearAlert(); // Claude is working again
  }
  liveEvents.push(ev);
  if (liveEvents.length > 500) liveEvents.shift();
  if (mode === 'replay') { pending++; timeline.setPending(pending); return; }
  const meta = model.apply(ev);
  if (ev.file && model.modified.has(ev.file)) changedOrder.set(ev.file, ev.id);
  if (!engine.theme && model.nodes.size) engine.setTheme(theme);
  engine.handleEvent(ev, meta);
  pushFeed(ev, true);
  renderNow(ev);
  lastEventAt = Date.now(); lastKind = ev.kind;
  renderStatus();
  if (ev.kind === 'edit' || ev.kind === 'create' || ev.kind === 'test_result') { renderModules(); renderChanged(); }
  if (ev.agent || ev.kind.startsWith('agent')) renderAgents();
  renderSummary(msg.summary);
  updateLiveTimeline();
  if (ev.kind === 'session') refreshSessions();
}

let retry = 500;
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${Q}`);
  ws.onopen = () => { wsOpen = true; retry = 500; renderStatus(); };
  ws.onclose = () => { wsOpen = false; renderStatus(); setTimeout(connect, retry); retry = Math.min(retry * 2, 8000); };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'hello') onHello(msg);
    else if (msg.type === 'graph') onGraph(msg);
    else if (msg.type === 'event') onEvent(msg);
    else if (msg.type === 'alert') showAlert(msg.event.alert); // test alert
  };
}

setTheme(theme);
timeline.setMode('live', false);
timeline.setSpeed(rclock.speed);
refreshSessions();
connect();
requestAnimationFrame(loop);
