// Session summary: what Claude did in one session, computed from its events (pure, tested).

/**
 * @param events   one session's events, oldest first (from history.sessionEvents or live)
 * @param moduleOf (file id) -> module name, from the project graph
 */
export function summarizeSession(events, moduleOf = () => null) {
  const files = new Map(); // file -> { reads, edits, added, removed, created }
  const file = (id) => {
    if (!files.has(id)) files.set(id, { file: id, reads: 0, edits: 0, added: 0, removed: 0, created: false });
    return files.get(id);
  };
  const s = {
    start: events[0]?.ts || null, end: events.at(-1)?.ts || null, durationSec: 0,
    prompts: 0, firstPrompt: null, lastPrompt: null, turns: 0,
    tools: 0, commands: 0, searches: 0, alerts: 0,
    tests: { runs: 0, last: null },
    subagents: { count: 0, types: {} },
    lines: { added: 0, removed: 0 },
    files: { read: 0, edited: 0, created: 0 },
    modules: [], topFiles: [],
  };
  if (s.start && s.end) s.durationSec = Math.max(0, Math.round((new Date(s.end) - new Date(s.start)) / 1000));
  for (const e of events) {
    if (e.alert) s.alerts++;
    switch (e.kind) {
      case 'prompt':
        s.prompts++;
        s.firstPrompt ??= e.detail;
        s.lastPrompt = e.detail;
        break;
      case 'idle': s.turns++; break;
      case 'read': s.tools++; if (e.file) file(e.file).reads++; break;
      case 'search': s.tools++; s.searches++; break;
      case 'edit':
      case 'create': {
        s.tools++;
        if (!e.file) break;
        const f = file(e.file);
        f.edits++;
        if (e.kind === 'create') f.created = true;
        f.added += e.stats?.added || 0; f.removed += e.stats?.removed || 0;
        s.lines.added += e.stats?.added || 0; s.lines.removed += e.stats?.removed || 0;
        break;
      }
      case 'bash': s.tools++; s.commands++; if (e.isTest) s.tests.runs++; break;
      case 'test_result': s.tests.last = { ok: e.ok, passed: e.stats?.passed ?? null, failed: e.stats?.failed ?? null, detail: e.detail }; break;
      case 'agent_start': {
        s.subagents.count++;
        const t = e.agentType || 'agent';
        s.subagents.types[t] = (s.subagents.types[t] || 0) + 1;
        break;
      }
      case 'web': case 'other': case 'ask': s.tools++; break;
      default: break;
    }
  }
  const all = [...files.values()];
  s.files.read = all.filter((f) => f.reads && !f.edits).length;
  s.files.edited = all.filter((f) => f.edits && !f.created).length;
  s.files.created = all.filter((f) => f.created).length;
  // the files that mattered: edits first (by lines changed), then the most-read ones
  s.topFiles = all
    .sort((a, b) => (b.edits > 0) - (a.edits > 0) || (b.added + b.removed) - (a.added + a.removed) || b.reads - a.reads)
    .slice(0, 6);
  const mods = new Map();
  for (const f of all) {
    const m = moduleOf(f.file);
    if (!m) continue;
    const cur = mods.get(m) || { module: m, touches: 0, edits: 0 };
    cur.touches += f.reads + f.edits; cur.edits += f.edits;
    mods.set(m, cur);
  }
  s.modules = [...mods.values()].sort((a, b) => b.edits - a.edits || b.touches - a.touches).slice(0, 6);
  return s;
}
