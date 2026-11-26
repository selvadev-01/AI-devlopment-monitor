// Reads the event log (events.jsonl) and splits it into replayable session segments.
// A segment starts at a session's first event or at each SessionStart ("session" kind),
// so repeated runs with the same session id (e.g. the demo) stay separate.
import fs from 'node:fs';
import path from 'node:path';

let cache = { file: null, mtimeMs: 0, size: 0, events: [] };

export function readLog(file) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  if (cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.events;
  const events = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, events };
  return events;
}

export function maxEventId(file) {
  return readLog(file).reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);
}

function segment(events) {
  const current = new Map(); // session id -> segment
  const segments = [];
  for (const e of events) {
    const sid = e.session || 'unknown';
    let seg = current.get(sid);
    if (!seg || e.kind === 'session') {
      seg = { key: `${sid}@${e.ts}`, session: sid, root: null, events: [] };
      current.set(sid, seg);
      segments.push(seg);
    }
    if (!seg.root && e.root) seg.root = e.root;
    seg.events.push(e);
  }
  return segments;
}

export function listSessions(file) {
  return segment(readLog(file))
    .filter((s) => s.events.length > 1)
    .map((s) => ({
      key: s.key,
      session: s.session,
      root: s.root,
      project: s.root ? path.basename(s.root) : null,
      start: s.events[0].ts,
      end: s.events[s.events.length - 1].ts,
      count: s.events.length,
      firstPrompt: s.events.find((e) => e.kind === 'prompt')?.detail || null,
    }))
    .reverse();
}

export function sessionEvents(file, key) {
  return segment(readLog(file)).find((s) => s.key === key) || null;
}
