// Client-side project graph + live state (modified / created / failing files).
export const MODULE_COLORS = [
  '#3fd4ff', '#a07bff', '#ffb547', '#2ee6c5', '#ff6fb5', '#9be15d',
  '#5b8cff', '#ff8a4c', '#e0e86a', '#7ef0ff', '#c98bff', '#56e39f',
];

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
  }

  setGraph(g, reset = true) {
    if (!g) return;
    if (reset) {
      this.modified.clear(); this.created.clear(); this.failing.clear(); this.colorOf.clear(); this.agents.clear();
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
    for (const m of order) {
      if (!this.colorOf.has(m)) this.colorOf.set(m, MODULE_COLORS[this.colorOf.size % MODULE_COLORS.length]);
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
    Object.assign(a, { key: ev.agent, id: ev.agent, type: ev.agentType || a.type, tools: ev.agentTools ?? a.tools + 1 });
    if (ev.kind === 'agent_stop') { this.agents.delete(ev.agent); return; }
    a.last = ev.file ? `${ev.detail}` : ev.detail;
    if (ev.file) a.file = ev.file;
    this.agents.set(ev.agent, a);
  }
}
