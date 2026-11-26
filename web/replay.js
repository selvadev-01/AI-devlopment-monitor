// Session replay: a playback clock over recorded events + the timeline bar UI.
const MAX_GAP = 3;       // seconds; long idle gaps are compressed to this
const TAIL = 1.5;        // seconds of padding after the last event
export const SPEEDS = [1, 2, 4, 8];

export class ReplayClock {
  constructor() { this.load([]); this.speed = 1; }

  load(events) {
    this.events = [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id - b.id);
    this.tl = [];
    let acc = 0; let prev = null;
    for (const e of this.events) {
      const ms = Date.parse(e.ts);
      if (prev != null) acc += Math.min(MAX_GAP, Math.max(0, (ms - prev) / 1000));
      this.tl.push(acc);
      prev = ms;
    }
    this.duration = this.events.length ? this.tl[this.tl.length - 1] + TAIL : 0;
    this.t = 0; this.i = 0; this.playing = false;
  }

  /** Index of the first event that has not happened yet at time t. */
  indexAt(t) {
    let lo = 0; let hi = this.tl.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.tl[mid] <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  seek(t) {
    this.t = Math.max(0, Math.min(this.duration, t));
    this.i = this.indexAt(this.t);
    return this.i;
  }

  /** Advance the clock; returns the events that fire during this step. */
  step(dt) {
    if (!this.playing) return [];
    this.t += dt * this.speed;
    const out = [];
    while (this.i < this.events.length && this.tl[this.i] <= this.t) out.push(this.events[this.i++]);
    if (this.t >= this.duration) { this.t = this.duration; this.playing = false; }
    return out;
  }

  nearest(t) {
    if (!this.events.length) return -1;
    const i = this.indexAt(t);
    if (i === 0) return 0;
    if (i >= this.tl.length) return this.tl.length - 1;
    return t - this.tl[i - 1] < this.tl[i] - t ? i - 1 : i;
  }
}

const fmt = (s) => {
  s = Math.max(0, Math.floor(s));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const PLAY = '<svg viewBox="0 0 24 24"><path d="M7 5v14l12-7z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';

/** DOM for the timeline bar. All callbacks are provided by app.js. */
export class TimelineUI {
  constructor({ classOf, onToggle, onSeek, onSpeed, onLive, onPick, onOpenPicker }) {
    const $ = (id) => document.getElementById(id);
    this.classOf = classOf;
    this.play = $('tl-play');
    this.speedBtn = $('tl-speed');
    this.range = $('tl-range');
    this.fill = $('tl-fill');
    this.markers = $('tl-markers');
    this.time = $('tl-time');
    this.select = $('tl-session');
    this.live = $('tl-live');
    this.tip = $('tl-tip');
    this.track = $('tl-track');
    this.clockRef = null;
    this.dragging = false;
    this.mode = 'live';

    this.play.addEventListener('click', onToggle);
    this.speedBtn.addEventListener('click', onSpeed);
    this.live.addEventListener('click', onLive);
    this.select.addEventListener('change', () => onPick(this.select.value));
    this.select.addEventListener('mousedown', onOpenPicker);
    this.select.addEventListener('focus', onOpenPicker);
    this.range.addEventListener('input', () => {
      this.dragging = true;
      onSeek(Number(this.range.value) / 1000); // fraction 0..1 of the session
    });
    this.range.addEventListener('change', () => { this.dragging = false; });
    this.track.addEventListener('pointermove', (e) => this.hover(e));
    this.track.addEventListener('pointerleave', () => { this.tip.hidden = true; });
  }

  setMode(mode, playing) {
    this.mode = mode;
    this.live.classList.toggle('active', mode === 'live');
    if (mode === 'live') this.live.textContent = 'LIVE';
    this.play.innerHTML = playing ? PAUSE : PLAY; // static icon markup
    this.play.setAttribute('aria-label', playing ? 'Pause replay' : 'Play replay');
    this.track.classList.toggle('is-live', mode === 'live');
  }

  setPending(n) { this.live.textContent = n ? `LIVE · ${n} new` : 'LIVE'; }
  setSpeed(s) { this.speedBtn.textContent = `${s}×`; }

  setSessions(list, selected) {
    const opts = list.map((s) => {
      const o = document.createElement('option');
      o.value = s.key;
      const when = new Date(s.start).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
      const prompt = s.firstPrompt ? ` · ${s.firstPrompt.slice(0, 38)}${s.firstPrompt.length > 38 ? '…' : ''}` : '';
      o.textContent = `${s.project || 'project'} · ${when} · ${s.count} events${prompt}`;
      return o;
    });
    if (!opts.length) {
      const o = document.createElement('option'); o.value = ''; o.textContent = 'No recorded sessions yet'; opts.push(o);
    }
    this.select.replaceChildren(...opts);
    if (selected && list.some((s) => s.key === selected)) this.select.value = selected;
  }

  setMarkers(c) {
    this.clockRef = c;
    const d = c.duration || 1;
    const step = Math.max(1, Math.ceil(c.events.length / 700));
    const frag = document.createDocumentFragment();
    c.events.forEach((e, i) => {
      if (i % step && !(e.kind === 'test_result' || e.kind === 'create')) return;
      const m = document.createElement('i');
      m.className = `k-${this.classOf(e)}`;
      m.style.left = `${(c.tl[i] / d) * 100}%`;
      frag.append(m);
    });
    this.markers.replaceChildren(frag);
  }

  setProgress(c) {
    const d = c.duration || 0;
    const k = d ? c.t / d : 1;
    this.fill.style.width = `${k * 100}%`;
    if (!this.dragging) this.range.value = String(Math.round(k * 1000));
    const cur = c.events[Math.max(0, c.i - 1)];
    this.time.textContent = this.mode === 'live'
      ? `${c.events.length} events`
      : `${fmt(c.t)} / ${fmt(d)}${cur ? ` · ${clock(cur.ts)}` : ''}`;
  }

  hover(e) {
    const c = this.clockRef;
    if (!c || !c.events.length) return;
    const r = this.track.getBoundingClientRect();
    const k = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const ev = c.events[c.nearest(k * c.duration)];
    if (!ev) return;
    this.tip.textContent = `${clock(ev.ts)}  ${ev.detail || ev.kind}`;
    this.tip.style.left = `${k * 100}%`;
    this.tip.hidden = false;
  }
}
