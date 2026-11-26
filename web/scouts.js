// Subagents as "scouts": one per running subagent, in that agent's colour, flying to the files the
// subagent itself reads and edits, with a live tag ("Explore · Read auth.ts") above it.
// Shared by both themes; each theme supplies how a scout looks (make) and moves (move).
import * as THREE from 'three';
import { AGENT_COLORS, makeLabel } from './fx.js';

export class ScoutManager {
  /**
   * @param theme  needs root, agentPosition(), positionOf(fileId)
   * @param opts   make(color) -> {obj, trail, dispose()}, move(scout, goal, dt), lift (height above a file)
   */
  constructor(theme, { make, move, lift = 3, place = null, tagHeight = 1.5 }) {
    this.tagHeight = tagHeight;
    this.theme = theme;
    this.make = make;
    this.move = move;
    this.lift = lift;
    // place(goal, filePos, scout, index, t): where a scout stands next to a file. Themes with a
    // wall (clockwork) or a floor (office) override the default "hover around it" placement.
    this.place = place;
    this.map = new Map();
    this.dying = [];
    this.goal = new THREE.Vector3();
  }

  get size() { return this.map.size; }
  /** Live tags of the running subagents (for label decluttering). */
  get tags() { return [...this.map.values()].map((s) => s.tag); }

  ensure(key, info) {
    let s = this.map.get(key);
    if (s) return s;
    const color = new THREE.Color(AGENT_COLORS[(info.color ?? this.map.size) % AGENT_COLORS.length]);
    const body = this.make(color);
    body.obj.position.copy(this.theme.agentPosition());
    const tag = makeLabel('', '#' + color.getHexString(), 'agent-tag');
    tag.userData = { collapse: true, scout: true }; // crowded: shrinks to a coloured dot
    this.theme.root.add(body.obj, body.trail.line, tag);
    s = {
      key, ...body, tag, color, type: info.type || 'agent', label: info.label || '', last: info.last || 'Starting…',
      targetId: info.file || null, phase: this.map.size * 1.7,
    };
    this.map.set(key, s);
    this.setTag(s);
    return s;
  }

  setTag(s) {
    const b = document.createElement('b');
    b.textContent = s.type;
    s.tag.element.replaceChildren(b, document.createTextNode(` · ${s.last}`));
    s.tag.element.title = s.label;
  }

  remove(key) {
    const s = (key && this.map.get(key))
      || [...this.map.values()].find((x) => x.key.startsWith('start:'))
      || this.map.values().next().value;
    if (!s) return;
    this.map.delete(s.key);
    s.tag.removeFromParent();
    s.dying = 0;
    this.dying.push(s);
  }

  /** Route an event; returns the scout that performed it (or null for main-agent events). */
  handle(ev, meta = {}) {
    if (ev.kind === 'agent_start') {
      this.ensure(`start:${ev.id}`, { type: ev.agentType, label: ev.agentLabel || ev.detail, color: ev.agentColor });
      return null;
    }
    if (ev.kind === 'agent_stop') {
      this.remove(ev.agent && this.map.has(ev.agent) ? ev.agent : meta.rekeyedFrom || null);
      return null;
    }
    if (!ev.agent) return null;
    let s = this.map.get(ev.agent);
    if (!s && meta.rekeyedFrom && this.map.has(meta.rekeyedFrom)) {
      s = this.map.get(meta.rekeyedFrom);
      this.map.delete(meta.rekeyedFrom);
      s.key = ev.agent;
      this.map.set(ev.agent, s);
    }
    if (!s) s = this.ensure(ev.agent, { type: ev.agentType, label: ev.agentLabel, color: ev.agentColor });
    s.type = ev.agentType || s.type;
    s.label = ev.agentLabel || s.label; // corrected by the server once the exact launch is known
    s.last = ev.detail || s.last;
    if (ev.file && this.theme.positionOf(ev.file)) s.targetId = ev.file;
    this.setTag(s);
    return s;
  }

  /** Make the scouts match model.agents (after a theme rebuild or a replay seek). */
  sync(model) {
    for (const key of [...this.map.keys()]) if (!model.agents.has(key)) this.remove(key);
    for (const a of model.agents.values()) {
      const s = this.ensure(a.key, { type: a.type, label: a.label, color: a.color, last: a.last, file: a.file });
      if (a.file && this.theme.positionOf(a.file)) s.targetId = a.file;
    }
  }

  update(dt, t) {
    const home = this.theme.agentPosition();
    let i = 0;
    for (const s of this.map.values()) {
      const p = s.targetId && this.theme.positionOf(s.targetId);
      // Each scout keeps its own slot around a file, so two agents on the same file don't overlap.
      const a = s.phase + t * 0.25;
      if (p && this.place) this.place(this.goal, p, s, i, t);
      else if (p) this.goal.set(p.x + Math.cos(a) * 2.4, p.y + this.lift + (i % 3) * 1.4, p.z + Math.sin(a) * 2.4);
      else this.goal.set(home.x + Math.cos(t * 0.6 + s.phase) * 6, home.y + 2, home.z + Math.sin(t * 0.6 + s.phase) * 6);
      this.move(s, this.goal, dt);
      s.trail.push(s.obj.position);
      s.tag.position.copy(s.obj.position).setY(s.obj.position.y + this.tagHeight);
      i++;
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const s = this.dying[i];
      s.dying += dt / 0.9;
      s.trail.line.material.opacity = Math.max(0, 1 - s.dying);
      s.obj.scale.multiplyScalar(0.92);
      if (s.dying >= 1) {
        s.obj.removeFromParent(); s.trail.line.removeFromParent();
        s.dispose?.();
        this.dying.splice(i, 1);
      }
    }
  }

  dispose() {
    for (const s of this.map.values()) s.tag.removeFromParent();
    this.map.clear();
    this.dying = [];
  }
}
