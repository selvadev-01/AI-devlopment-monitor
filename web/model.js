// Client-side project graph + live state (modified / created / failing files).
export const MODULE_COLORS = [
  '#3fd4ff', '#a07bff', '#ffb547', '#2ee6c5', '#ff6fb5', '#9be15d',
  '#5b8cff', '#ff8a4c', '#e0e86a', '#7ef0ff', '#c98bff', '#56e39f',
];

/** Short module name for 3D labels: the last two parts, e.g. "settings / components". */
export const displayName = (name) => name.split('/').slice(-2).join(' / ');

const hexToHsl = (hex) => {
  const n = parseInt(hex.slice(1), 16); const r = (n >> 16) / 255; const g = ((n >> 8) & 255) / 255; const b = (n & 255) / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2; const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
};
const hslToHex = (h, s, l) => {
  const k = (n) => (n + h / 30) % 12; const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
};
/** Variation i of a base colour: same family, shifted hue/lightness so siblings stay distinguishable. */
const shade = (hex, i) => {
  if (!i) return hex;
  const [h, s, l] = hexToHsl(hex);
  const dh = ((i % 7) - 3) * 7;                          // hue stays within ±21° of the family colour
  const dl = ((Math.floor(i / 7) % 4) - 1.5) * 0.06;     // then lightness steps for more siblings
  return hslToHex((h + dh + 360) % 360, s, Math.min(0.78, Math.max(0.4, l + dl)));
};

export class GraphModel {
  constructor() {
    this.name = '';
    this.root = '';
    this.nodes = new Map();      // id -> {id, name, module, loc}
    this.edges = [];             // {source, target}
    this.modules = new Map();    // name -> {name, color, files: []}
    this.colorOf = new Map();    // module -> color (stable across updates)
    this.deps = new Map();       // id -> Set(ids that import it)
    this.imports = new Map();    // id -> Set(ids it imports)
    this.modified = new Map();   // id -> {added, removed}
    this.created = new Set();
    this.failing = new Set();
    this.agents = new Map();     // key ('start:<eventId>' until bound, then agent id) -> running subagent
    this.touched = new Map();    // module -> last time Claude or a subagent worked in it (focus mode)
    this.touchSeq = 0;
  }

  /** Big projects show only the modules in focus in full detail. */
  get large() { return this.nodes.size > 250 || this.modules.size > 24; }

  /** Modules in focus: the most recently touched ones, plus modules with changed files. */
  focusModules(max = 6) {
    const out = new Set([...this.touched.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([m]) => m));
    for (const id of [...this.modified.keys(), ...this.failing]) {
      const m = this.nodes.get(id)?.module;
      if (m && out.size < max + 4) out.add(m);
    }
    return out;
  }

  setGraph(g, reset = true) {
    if (!g) return;
    if (reset) {
      this.modified.clear(); this.created.clear(); this.failing.clear(); this.colorOf.clear(); this.agents.clear();
      this.touched.clear();
      this.familyOf?.clear();
    }
    this.name = g.name; this.root = g.root;
    this.nodes = new Map(g.nodes.map((n) => [n.id, n]));
    this.edges = g.edges.filter((e) => this.nodes.has(e.source) && this.nodes.has(e.target));
    this.rebuildIndexes();
  }

  addNode(node) {
    if (!node || this.nodes.has(node.id)) return false;
    this.nodes.set(node.id, node);
    this.rebuildIndexes();
    return true;
  }

  rebuildIndexes() {
    const byModule = new Map();
    for (const n of this.nodes.values()) {
      if (!byModule.has(n.module)) byModule.set(n.module, []);
      byModule.get(n.module).push(n.id);
    }
    const order = [...byModule.keys()].sort((a, b) => byModule.get(b).length - byModule.get(a).length || a.localeCompare(b));
    // Modules under the same top folder share a colour family (e.g. all of "frontend/…" are blues).
    const top = (m) => m.split('/')[0];
    const topSize = new Map();
    for (const m of order) topSize.set(top(m), (topSize.get(top(m)) || 0) + byModule.get(m).length);
    const tops = [...topSize.keys()].sort((a, b) => topSize.get(b) - topSize.get(a));
    this.familyOf ??= new Map();
    for (const t of tops) if (!this.familyOf.has(t)) this.familyOf.set(t, MODULE_COLORS[this.familyOf.size % MODULE_COLORS.length]);
    const used = new Map();
    for (const m of order) {
      if (this.colorOf.has(m)) continue;
      const t = top(m);
      const i = used.get(t) || 0; used.set(t, i + 1);
      // A project with one module per top folder keeps one distinct colour per module.
      this.colorOf.set(m, tops.length === order.length ? MODULE_COLORS[tops.indexOf(t) % MODULE_COLORS.length] : shade(this.familyOf.get(t), i));
    }
    this.modules = new Map(order.map((m) => [m, { name: m, color: this.colorOf.get(m), files: byModule.get(m).sort() }]));

    this.deps = new Map(); this.imports = new Map();
    for (const id of this.nodes.keys()) { this.deps.set(id, new Set()); this.imports.set(id, new Set()); }
    for (const e of this.edges) { this.deps.get(e.target).add(e.source); this.imports.get(e.source).add(e.target); }
  }

  dependentsOf(id) { return [...(this.deps.get(id) || [])]; }
  importsOf(id) { return [...(this.imports.get(id) || [])]; }
  colorFor(id) { const n = this.nodes.get(id); return n ? this.colorOf.get(n.module) : '#ffffff'; }

  matchFiles(paths) {
    const out = new Set();
    for (const p of paths) {
      const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
      for (const id of this.nodes.keys()) if (id.endsWith(norm) || norm.endsWith(id)) out.add(id);
    }
    return out;
  }

  /** Update live state from a server event. Returns extra info for the visuals. */
  apply(ev) {
    const meta = { dependents: [] };
    if (ev.node) this.addNode(ev.node);
    const mod = ev.file && this.nodes.get(ev.file)?.module;
    if (mod) this.touched.set(mod, ++this.touchSeq);
    if (ev.file && (ev.kind === 'edit' || ev.kind === 'create')) {
      const prev = this.modified.get(ev.file) || { added: 0, removed: 0 };
      this.modified.set(ev.file, { added: prev.added + (ev.stats?.added || 0), removed: prev.removed + (ev.stats?.removed || 0) });
      if (ev.kind === 'create') this.created.add(ev.file);
      meta.dependents = this.dependentsOf(ev.file);
    }
    if (ev.kind === 'test_result') {
      this.failing = ev.ok ? new Set() : this.matchFiles(ev.failingFiles || []);
      meta.failing = [...this.failing];
    }
    this.applyAgent(ev, meta);
    return meta;
  }

  applyAgent(ev, meta) {
    if (ev.kind === 'agent_start') {
      const key = `start:${ev.id}`;
      this.agents.set(key, {
        key, id: null, type: ev.agentType || 'agent', label: ev.agentLabel || ev.detail, color: ev.agentColor ?? this.agents.size,
        tools: 0, last: 'Starting…', file: null, since: ev.ts,
      });
      return;
    }
    if (!ev.agent) {
      // Logs from before agent ids were recorded: a stop just ends the oldest subagent.
      if (ev.kind === 'agent_stop') { const first = this.agents.keys().next().value; if (first) this.agents.delete(first); }
      return;
    }
    let a = this.agents.get(ev.agent);
    if (!a && ev.agentStartId != null && this.agents.has(`start:${ev.agentStartId}`)) {
      meta.rekeyedFrom = `start:${ev.agentStartId}`;
      a = this.agents.get(meta.rekeyedFrom);
      this.agents.delete(meta.rekeyedFrom);
    }
    if (!a) a = { type: ev.agentType, label: ev.agentLabel, color: ev.agentColor ?? 0, tools: 0, since: ev.ts };
    // label too: the server may correct a guessed task description once it knows the exact launch
    Object.assign(a, { key: ev.agent, id: ev.agent, type: ev.agentType || a.type, label: ev.agentLabel || a.label, tools: ev.agentTools ?? a.tools + 1 });
    if (ev.kind === 'agent_stop') { this.agents.delete(ev.agent); return; }
    a.last = ev.file ? `${ev.detail}` : ev.detail;
    if (ev.file) a.file = ev.file;
    this.agents.set(ev.agent, a);
  }
}
