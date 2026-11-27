// Token use and estimated cost of a Claude Code session, read from the transcripts Claude Code
// writes (hooks carry no token counts). The main transcript is <projects>/<slug>/<session>.jsonl;
// each subagent has <projects>/<slug>/<session>/subagents/agent-<id>.jsonl (+ .meta.json).
// Files are read incrementally: only bytes appended since the last read are parsed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// USD per million tokens: input, output, 5-minute cache write, 1-hour cache write, cache read.
// Anthropic API list prices. Claude Pro/Max subscribers do not pay per token, so the UI calls this
// an API-price estimate. Matched by the longest id prefix (dated ids and "[1m]" suffixes still match).
export const PRICES = {
  'claude-fable-5-2': [8, 40, 10, 16, 0.2],
  'claude-mythos-5-2': [8, 40, 10, 16, 0.2],
  'claude-fable-5-1': [10, 50, 12.5, 20, 0.25],
  'claude-mythos-5-1': [10, 50, 12.5, 20, 0.25],
  'claude-fable-5': [10, 50, 12.5, 20, 1],
  'claude-mythos-5': [10, 50, 12.5, 20, 1],
  'claude-opus-5-5': [4, 20, 5, 8, 0.2],
  'claude-opus-5': [5, 25, 6.25, 10, 0.5],
  'claude-opus-4-8': [5, 25, 6.25, 10, 0.5],
  'claude-opus-4-7': [5, 25, 6.25, 10, 0.5],
  'claude-opus-4-6': [5, 25, 6.25, 10, 0.5],
  'claude-opus-4-5': [5, 25, 6.25, 10, 0.5],
  'claude-opus-4': [15, 75, 18.75, 30, 1.5],
  'claude-sonnet-5-5': [2, 10, 2.5, 4, 0.1],
  'claude-sonnet-5': [2, 10, 2.5, 4, 0.2],
  'claude-sonnet-4': [3, 15, 3.75, 6, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.2, 0.01],
  'claude-haiku-4-5': [1, 5, 1.25, 2, 0.1],
  'claude-3-5-haiku': [0.8, 4, 1, 1.6, 0.08],
};
const PRICE_KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);
const HAIKU55_LONG = [0.5, 2.5, 0.625, 1, 0.05]; // Haiku 5.5 prompts over 100K tokens

export function priceFor(model) {
  const id = String(model || '').replace(/^anthropic\./, '');
  const k = PRICE_KEYS.find((p) => id.startsWith(p));
  return k ? PRICES[k] : null;
}

/** Tokens of one API response, split the way they are billed. */
export function tokensOf(u = {}) {
  const write = u.cache_creation_input_tokens || 0;
  const w1h = Math.min(write, u.cache_creation?.ephemeral_1h_input_tokens || 0);
  return {
    input: u.input_tokens || 0, output: u.output_tokens || 0,
    cacheWrite5m: write - w1h, cacheWrite1h: w1h, cacheRead: u.cache_read_input_tokens || 0,
  };
}

/** Estimated USD for one response; null when the model's price is unknown. */
export function costOf(model, t, speed) {
  let p = priceFor(model);
  if (!p) return null;
  const prompt = t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
  if (p === PRICES['claude-haiku-5-5'] && prompt > 100_000) p = HAIKU55_LONG;
  const usd = (t.input * p[0] + t.output * p[1] + t.cacheWrite5m * p[2] + t.cacheWrite1h * p[3] + t.cacheRead * p[4]) / 1e6;
  return speed === 'fast' ? usd * 2 : usd; // fast mode is twice the standard rate
}

// ---------------------------------------------------------------- transcript reading
const files = new Map(); // path -> { offset, size, recs: Map(message id -> rec) }

/** Billed responses in a transcript, one per API message (a message spans several lines). */
export function readTranscript(file) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  let c = files.get(file);
  if (!c || st.size < c.size) c = { offset: 0, size: 0, recs: new Map() }; // new or rewritten
  if (st.size > c.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - c.offset);
      fs.readSync(fd, buf, 0, buf.length, c.offset);
      const end = buf.lastIndexOf(10); // only whole lines; a torn last line is read next time
      if (end >= 0) {
        for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
          if (!line.includes('"usage"')) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          const m = o.message;
          if (o.type !== 'assistant' || !m?.usage || !m.model || m.model.startsWith('<')) continue;
          c.recs.set(m.id || o.uuid, { ts: Date.parse(o.timestamp) || 0, model: m.model, speed: m.usage.speed, t: tokensOf(m.usage) });
        }
        c.offset += end + 1;
      }
    } finally { fs.closeSync(fd); }
  }
  c.size = st.size;
  files.set(file, c);
  if (files.size > 400) files.delete(files.keys().next().value);
  return [...c.recs.values()];
}

const transcripts = new Map(); // session id -> main transcript path (from hook payloads)
export function rememberTranscript(session, file) {
  if (!session || !file || path.basename(file).startsWith('agent-')) return;
  transcripts.set(session, file);
  if (transcripts.size > 500) transcripts.delete(transcripts.keys().next().value);
}

/** The session's main transcript: known from hooks, else looked up under ~/.claude/projects. */
export function findTranscript(session, projectsDir = path.join(os.homedir(), '.claude', 'projects')) {
  if (transcripts.has(session)) return transcripts.get(session);
  if (!/^[\w-]+$/.test(session || '')) return null;
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(projectsDir, d, `${session}.jsonl`);
    if (fs.existsSync(f)) { transcripts.set(session, f); return f; }
  }
  return null;
}

const empty = () => ({ input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, total: 0, cost: 0, requests: 0, unpriced: 0 });
function add(acc, r) {
  for (const k of ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead']) acc[k] += r.t[k];
  acc.total += r.t.input + r.t.output + r.t.cacheWrite5m + r.t.cacheWrite1h + r.t.cacheRead;
  const usd = costOf(r.model, r.t, r.speed);
  if (usd == null) acc.unpriced++; else acc.cost += usd;
  acc.requests++;
  return acc;
}

/**
 * Tokens and cost of a session between `since` and `until` (ms; until null = still running):
 * totals, per model, the main agent, and each subagent (id from agent-<id>.jsonl).
 */
export function sessionUsage(transcript, session, { since = 0, until = null } = {}) {
  if (!transcript) return null;
  const res = { total: empty(), main: empty(), byModel: {}, agents: [] };
  const inWindow = (r) => r.ts >= since - 2000 && (until == null || r.ts <= until + 10_000);
  const take = (recs, acc) => {
    for (const r of recs) {
      if (!inWindow(r)) continue;
      add(acc, r); add(res.total, r);
      add(res.byModel[r.model] ||= empty(), r);
    }
  };
  take(readTranscript(transcript), res.main);
  const dir = path.join(path.dirname(transcript), session, 'subagents');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^agent-[\w-]+\.jsonl$/.test(n)); } catch { /* no subagents */ }
  for (const n of names) {
    const id = n.slice(6, -6);
    const acc = empty();
    take(readTranscript(path.join(dir, n)), acc);
    if (!acc.requests) continue;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${id}.meta.json`), 'utf8')); } catch { /* none */ }
    res.agents.push({ id, type: meta.agentType || 'agent', label: meta.description || '', ...acc });
  }
  res.agents.sort((a, b) => b.cost - a.cost || b.total - a.total);
  return res;
}
