// Neural theme: files are neurons, imports are axons. Edits send pulses to dependents.
import * as THREE from 'three';
import {
  Animator, KIND_COLORS, ease, glowSprite, dotTexture, ringTexture, starfield, makeLabel, hash, rng, disposeTree, loadTex, skySphere,
} from '../fx.js';
import { ScoutManager } from '../scouts.js';

const TEST_MODULES = ['tests', 'test', '__tests__', 'spec', 'specs', 'e2e'];
const HALO = 3.6; // halo sprite size relative to the neuron core
const C = (hex) => new THREE.Color(hex);
const COL = {
  read: C(KIND_COLORS.read), edit: C(KIND_COLORS.edit), create: C(KIND_COLORS.create), bash: C(KIND_COLORS.bash),
  ok: C(KIND_COLORS.ok), fail: C(KIND_COLORS.fail), search: C(KIND_COLORS.search), white: C('#ffffff'),
};

export class NeuralTheme {
  constructor(engine) {
    this.engine = engine;
    this.root = new THREE.Group();
    this.anim = new Animator();
    this.records = new Map();
    this.labels = [];
    this.centers = new Map();
    this.focusDistance = 42;
    this.bloom = { strength: 0.8, radius: 0.45, threshold: 0.42 }; // halos give the glow; keeps the membrane crisp
    this.fog = new THREE.FogExp2(0x05070a, 0.0026);
    this.home = { position: new THREE.Vector3(0, 40, 170) };
    this.sphereGeo = new THREE.SphereGeometry(1, 20, 14);
    this.tmp = new THREE.Vector3();
    this.agentGoal = new THREE.Vector3();
    this.zero = new THREE.Vector3();
    this.tmpC = new THREE.Color();
  }

  // ------------------------------------------------------------------ build
  build(model) {
    this.model = model;
    const n = Math.max(1, model.nodes.size);
    this.radius = 22 + Math.sqrt(n) * 5;
    this.home.position.set(0, this.radius * 0.35, this.radius * 2.6);

    this.root.add(skySphere('sky_neural', Math.min(5200, this.radius * 14), 0x7d8aa0));
    this.stars = starfield(1200, this.radius * 9, 0.5);
    this.root.add(this.stars);
    this.dust = this.makeDust(700, this.radius * 1.5);
    this.root.add(this.dust);

    this.nodeGroup = new THREE.Group();
    this.root.add(this.nodeGroup);
    const positions = layout(model, this.radius);
    for (const node of model.nodes.values()) this.addRecord(node, positions.get(node.id));
    this.buildEdges();
    this.buildDendrites();
    this.buildLabels();
    this.buildAgent();
    this.scouts = new ScoutManager(this, {
      make: (color) => {
        const spr = glowSprite(color, 4, 0.95);
        const trail = makeTrail(36, color);
        return { obj: spr, trail, dispose: () => { spr.material.dispose(); trail.line.geometry.dispose(); trail.line.material.dispose(); } };
      },
      move: (s, goal, dt) => s.obj.position.lerp(goal, 1 - Math.exp(-dt * 3)),
      lift: 3.2,
    });
    this.scouts.sync(model);
  }

  makeDust(count, radius) {
    const pos = new Float32Array(count * 3);
    const r = rng(0.77);
    for (let i = 0; i < count; i++) {
      const v = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar(radius * Math.cbrt(r()));
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ size: 0.5, map: dotTexture(), color: 0x6f86a8, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
  }

  addRecord(node, pos) {
    const color = C(this.model.colorOf.get(node.module) || '#ffffff');
    const size = 0.55 + Math.log2(node.loc + 1) * 0.17;
    const group = new THREE.Group();
    group.position.copy(pos);
    const core = new THREE.Mesh(this.sphereGeo, somaMaterial(color));
    core.scale.setScalar(size);
    const halo = glowSprite(color, size * HALO, 0.3);
    halo.userData.id = node.id;
    group.add(core, halo);
    this.nodeGroup.add(group);
    const rec = { id: node.id, group, core, halo, base: color, size, boost: 0, boostColor: COL.white.clone(), decay: 1, scale: 1, phase: hash(node.id) * Math.PI * 2 };
    this.records.set(node.id, rec);
    return rec;
  }

  edgeCurve(a, b, key) {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const off = new THREE.Vector3(hash(key + 'x') - 0.5, hash(key + 'y') - 0.5, hash(key + 'z') - 0.5).multiplyScalar(a.distanceTo(b) * 0.35);
    return new THREE.QuadraticBezierCurve3(a.clone(), mid.add(off), b.clone());
  }

  buildEdges() {
    if (this.edgeLines) { this.edgeLines.removeFromParent(); this.edgeLines.geometry.dispose(); this.edgeLines.material.dispose(); }
    const SEG = 10;
    const edges = this.model.edges.filter((e) => this.records.has(e.source) && this.records.has(e.target));
    const pos = new Float32Array(edges.length * SEG * 6);
    const col = new Float32Array(edges.length * SEG * 6);
    this.curves = new Map();
    const c0 = new THREE.Color(); const c1 = new THREE.Color();
    edges.forEach((e, i) => {
      const a = this.records.get(e.source); const b = this.records.get(e.target);
      const curve = this.edgeCurve(a.group.position, b.group.position, e.source + e.target);
      this.curves.set(e.source + '->' + e.target, { curve, index: i });
      const pts = curve.getPoints(SEG);
      for (let s = 0; s < SEG; s++) {
        const o = (i * SEG + s) * 6;
        pos.set([pts[s].x, pts[s].y, pts[s].z, pts[s + 1].x, pts[s + 1].y, pts[s + 1].z], o);
        c0.copy(a.base).lerp(b.base, s / SEG).multiplyScalar(0.32);
        c1.copy(a.base).lerp(b.base, (s + 1) / SEG).multiplyScalar(0.32);
        col.set([c0.r, c0.g, c0.b, c1.r, c1.g, c1.b], o);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.edgeBaseColors = col.slice();
    this.edgeSeg = SEG;
    this.edgeLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.root.add(this.edgeLines);
  }

  tintEdge(source, target, color, strength) {
    const e = this.curves?.get(source + '->' + target);
    if (!e) return;
    const attr = this.edgeLines.geometry.attributes.color;
    const start = e.index * this.edgeSeg * 6;
    for (let k = 0; k < this.edgeSeg * 2; k++) {
      const o = start + k * 3;
      attr.array[o] = this.edgeBaseColors[o] * (1 - strength) + color.r * strength * 0.9;
      attr.array[o + 1] = this.edgeBaseColors[o + 1] * (1 - strength) + color.g * strength * 0.9;
      attr.array[o + 2] = this.edgeBaseColors[o + 2] * (1 - strength) + color.b * strength * 0.9;
    }
    attr.needsUpdate = true;
  }

  buildDendrites() {
    if (this.dendrites) { this.dendrites.removeFromParent(); this.dendrites.geometry.dispose(); this.dendrites.material.dispose(); }
    const pos = []; const col = [];
    for (const rec of this.records.values()) {
      const r = rng(hash(rec.id) + 0.01);
      const count = 4 + Math.floor(r() * 4);
      for (let i = 0; i < count; i++) {
        const dir = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
        const len = rec.size * (1.6 + r() * 2.2);
        const p0 = rec.group.position.clone().addScaledVector(dir, rec.size * 0.8);
        const p1 = rec.group.position.clone().addScaledVector(dir, len);
        const p2 = p1.clone().add(new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(len * 0.5));
        pos.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
        const c = rec.base.clone().multiplyScalar(0.45);
        for (let k = 0; k < 4; k++) { const f = k < 2 ? 1 : 0.45; col.push(c.r * f, c.g * f, c.b * f); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.dendrites = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.root.add(this.dendrites);
  }

  buildLabels() {
    for (const l of this.labels) l.removeFromParent();
    this.labels = [];
    this.centers = new Map();
    for (const [name, mod] of this.model.modules) {
      const c = new THREE.Vector3(); let top = -Infinity; let k = 0;
      for (const id of mod.files) {
        const r = this.records.get(id);
        if (r) { c.add(r.group.position); top = Math.max(top, r.group.position.y); k++; }
      }
      if (!k) continue;
      c.divideScalar(k);
      this.centers.set(name, c);
      const label = makeLabel(name, mod.color);
      label.position.set(c.x, top + 4, c.z);
      this.root.add(label);
      this.labels.push(label);
    }
  }

  buildAgent() {
    this.agent = new THREE.Group();
    this.agentGlow = glowSprite(0xffffff, 5.5, 0.8);
    this.agentCore = glowSprite(0xbff3ff, 2.2, 1);
    this.agent.add(this.agentGlow, this.agentCore);
    this.agent.position.set(0, this.radius * 0.6, 0);
    this.root.add(this.agent);
    this.agentTarget = null;
    this.agentTrail = makeTrail(48, C('#bff3ff'));
    this.root.add(this.agentTrail.line);
  }

  // ------------------------------------------------------------------ sync
  sync(model) {
    this.model = model;
    let changed = false;
    for (const node of model.nodes.values()) {
      if (!this.records.has(node.id)) { this.addRecord(node, this.placeNear(node)); changed = true; }
    }
    for (const [id, rec] of this.records) {
      if (!model.nodes.has(id)) { rec.group.removeFromParent(); disposeTree(rec.group); this.records.delete(id); changed = true; }
    }
    this.buildEdges();
    if (changed) { this.buildDendrites(); this.buildLabels(); }
    this.scouts.sync(model);
  }

  placeNear(node) {
    const near = [...this.model.importsOf(node.id), ...this.model.dependentsOf(node.id)].map((id) => this.records.get(id)).filter(Boolean);
    const r = rng(hash(node.id));
    const jitter = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(10);
    if (near.length) return near.reduce((a, rec) => a.add(rec.group.position), new THREE.Vector3()).divideScalar(near.length).add(jitter);
    const c = this.centers.get(node.module);
    return (c ? c.clone() : new THREE.Vector3()).add(jitter);
  }

  // ------------------------------------------------------------------ queries
  positionOf(id) { return this.records.get(id)?.group.position || null; }
  agentPosition() { return this.agent.position; }
  moduleCenter(name) { return this.centers.get(name) || null; }
  testAnchor() {
    for (const m of TEST_MODULES) if (this.centers.has(m)) return this.centers.get(m);
    return this.zero;
  }
  pick(raycaster) {
    const hits = raycaster.intersectObjects([...this.records.values()].map((r) => r.halo), false);
    return hits.length ? hits[0].object.userData.id : null;
  }

  // ------------------------------------------------------------------ effects
  boost(rec, color, amount = 1, seconds = 2) {
    if (!rec) return;
    rec.boost = Math.max(rec.boost, amount);
    rec.boostColor.copy(color);
    rec.decay = seconds;
  }

  ring(pos, color, from, to, seconds = 1.2, delay = 0) {
    const mat = new THREE.SpriteMaterial({ map: ringTexture(), color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const s = new THREE.Sprite(mat);
    s.position.copy(pos);
    s.scale.setScalar(from);
    this.root.add(s);
    const total = seconds + delay;
    this.anim.add(total, (k) => {
      const t = k * total;
      if (t < delay) return;
      const q = (t - delay) / seconds;
      s.scale.setScalar(from + (to - from) * ease.outCubic(q));
      mat.opacity = (1 - q) * 0.9;
    }, () => { s.removeFromParent(); mat.dispose(); });
  }

  pulse(fromId, toId, color, delay = 0, onArrive) {
    const key1 = toId + '->' + fromId; const key2 = fromId + '->' + toId;
    const entry = this.curves.get(key1) || this.curves.get(key2);
    if (!entry) return;
    const reverse = this.curves.has(key1);
    const spr = glowSprite(color, 2.6, 0);
    this.root.add(spr);
    const total = 0.9 + delay;
    this.anim.add(total, (k) => {
      const t = k * total;
      if (t < delay) return;
      const q = ease.inOutCubic((t - delay) / 0.9);
      entry.curve.getPoint(reverse ? 1 - q : q, spr.position);
      spr.material.opacity = Math.sin(q * Math.PI) * 0.4 + 0.6;
    }, () => { spr.removeFromParent(); spr.material.dispose(); onArrive?.(); });
  }

  burst(pos, color, count = 70) {
    const p = new Float32Array(count * 3); const v = [];
    for (let i = 0; i < count; i++) {
      p.set([pos.x, pos.y, pos.z], i * 3);
      v.push(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(4 + Math.random() * 10));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const m = new THREE.PointsMaterial({ color, size: 0.7, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const pts = new THREE.Points(g, m);
    const origin = pos.clone();
    this.root.add(pts);
    this.anim.add(1.6, (k) => {
      const a = g.attributes.position.array;
      const q = ease.outCubic(k);
      for (let i = 0; i < count; i++) {
        a[i * 3] = origin.x + v[i].x * q; a[i * 3 + 1] = origin.y + v[i].y * q; a[i * 3 + 2] = origin.z + v[i].z * q;
      }
      g.attributes.position.needsUpdate = true;
      m.opacity = 1 - k;
    }, () => { pts.removeFromParent(); g.dispose(); m.dispose(); });
  }

  moveAgentTo(id) {
    const rec = this.records.get(id);
    if (rec) this.agentTarget = () => this.agentGoal.copy(rec.group.position).setY(rec.group.position.y + rec.size * 2.2 + 1.5);
  }

  setAgentColor(color, seconds = 1.5) {
    this.anim.add(seconds, (k) => { this.agentGlow.material.color.copy(color).lerp(COL.white, k); });
  }

  onEvent(ev, meta) {
    // Subagent events are acted out by that subagent's scout; the main orb stays where it is.
    const scout = this.scouts.handle(ev, meta);
    if (ev.kind === 'agent_start' || ev.kind === 'agent_stop') return;
    const actorPos = scout ? scout.obj.position : this.agent.position;
    const rec = ev.file ? this.records.get(ev.file) : null;
    switch (ev.kind) {
      case 'prompt':
        this.ring(actorPos, COL.white, 2, 24, 1.4);
        break;
      case 'read':
        if (!rec) break;
        if (!scout) this.moveAgentTo(ev.file);
        this.boost(rec, COL.read, 1, 2.6);
        this.ring(rec.group.position, COL.read, rec.size * 2, rec.size * 12, 1.3, 0.3);
        this.ring(rec.group.position, COL.read, rec.size * 2, rec.size * 12, 1.3, 0.9);
        break;
      case 'search':
        if (!scout) this.setAgentColor(COL.search);
        this.ring(actorPos, COL.search, 3, scout ? 30 : 60, 1.8);
        break;
      case 'edit':
        if (!rec) break;
        if (!scout) this.moveAgentTo(ev.file);
        this.boost(rec, COL.edit, 1, 3.2);
        this.popScale(rec, 1.6);
        (meta.dependents || []).forEach((dep, i) => {
          this.pulse(ev.file, dep, COL.edit, 0.35 + i * 0.12, () => this.boost(this.records.get(dep), COL.edit, 0.75, 1.8));
          this.tintEdgeFor(dep, ev.file, COL.edit, 2.4);
        });
        break;
      case 'create': {
        const node = ev.file && this.model.nodes.get(ev.file);
        const r = rec || (node && this.addRecord(node, this.placeNear(node)));
        if (!r) break;
        if (!scout) this.moveAgentTo(ev.file);
        r.scale = 0;
        this.anim.add(1.6, (k) => { r.scale = ease.outBack(k); });
        this.boost(r, COL.create, 1, 3.5);
        this.burst(r.group.position, COL.create);
        this.ring(r.group.position, COL.create, 1, r.size * 14, 1.6, 0.2);
        break;
      }
      case 'bash':
        if (!scout) this.setAgentColor(COL.bash, 2);
        this.ring(actorPos, COL.bash, 2, 14, 1);
        break;
      case 'bash_result':
        if (!ev.ok) { if (!scout) this.setAgentColor(COL.fail, 2); this.ring(actorPos, COL.fail, 2, 18, 1.2); }
        break;
      case 'test_result': {
        const origin = this.testAnchor().clone();
        this.ring(origin, ev.ok ? COL.ok : COL.fail, 4, this.radius * 3, 2.4);
        for (const r of this.records.values()) {
          const delay = r.group.position.distanceTo(origin) / (this.radius * 1.6);
          this.anim.add(delay + 0.01, () => {}, () => this.boost(r, COL.ok, 0.55, 1.6));
        }
        for (const id of meta.failing || []) {
          const fr = this.records.get(id);
          if (!fr) continue;
          this.anim.add(0.6, () => {}, () => this.boost(fr, COL.fail, 1, 4));
          for (const imp of this.model.importsOf(id)) {
            this.pulse(id, imp, COL.fail, 0.6);
            this.tintEdgeFor(id, imp, COL.fail, 6);
          }
        }
        break;
      }
      case 'idle':
        this.agentTarget = null; // background subagents may keep working, so scouts stay
        break;
      default:
        break;
    }
  }

  tintEdgeFor(a, b, color, seconds) {
    this.anim.add(seconds, (k) => {
      const s = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
      this.tintEdge(a, b, color, s); this.tintEdge(b, a, color, s);
    });
  }

  popScale(rec, peak) {
    this.anim.add(0.8, (k) => { rec.scale = 1 + (peak - 1) * Math.sin(k * Math.PI); }, () => { rec.scale = 1; });
  }

  // ------------------------------------------------------------------ frame
  update(dt, t) {
    this.anim.update(dt);
    const model = this.model;
    const hoverId = this.engine.hoverId;
    const cam = this.engine.camera.position;
    for (const rec of this.records.values()) {
      rec.boost = Math.max(0, rec.boost - dt / rec.decay);
      const c = rec.core.material.color.copy(rec.base);
      let stateGlow = 0;
      if (model.failing.has(rec.id)) { c.lerp(COL.fail, 0.85); stateGlow = 0.35; }
      else if (model.created.has(rec.id)) { c.lerp(COL.create, 0.6); stateGlow = 0.25; }
      else if (model.modified.has(rec.id)) { c.lerp(COL.edit, 0.5); stateGlow = 0.2; }
      if (hoverId === rec.id) c.lerp(COL.white, 0.4);
      c.lerp(rec.boostColor, rec.boost);
      rec.halo.material.color.copy(c);
      // Fade the halo when the camera is close so the membrane texture of the cell body shows.
      const dist = cam.distanceTo(rec.group.position);
      const near = Math.min(1, Math.max(0, (dist - rec.size * 6) / (rec.size * 28)));
      rec.halo.material.opacity = (0.26 + stateGlow * 0.8 + rec.boost * 0.4 + 0.04 * Math.sin(t * 1.3 + rec.phase)) * (0.15 + 0.85 * near);
      const s = Math.max(0.001, rec.size * rec.scale * (1 + rec.boost * 0.35));
      rec.core.scale.setScalar(s);
      rec.halo.scale.setScalar(s * HALO * (1 + rec.boost * 0.35));
    }

    const goal = this.agentTarget
      ? this.agentTarget()
      : this.agentGoal.set(Math.cos(t * 0.15) * this.radius * 0.45, this.radius * 0.35 + Math.sin(t * 0.4) * 3, Math.sin(t * 0.15) * this.radius * 0.45);
    this.agent.position.lerp(goal, 1 - Math.exp(-dt * 2.4));
    this.agentCore.scale.setScalar(2.2 + Math.sin(t * 6) * 0.2);
    this.agentTrail.push(this.agent.position);

    this.scouts.update(dt, t);

    this.dust.rotation.y += dt * 0.01;
    this.stars.rotation.y += dt * 0.002;
  }

  dispose() {
    this.anim.clear();
    this.scouts?.dispose();
    for (const l of this.labels) l.removeFromParent();
    disposeTree(this.root);
  }
}

// --------------------------------------------------------------------- helpers
const SOMA_VERT = /* glsl */`
  varying vec3 vN; varying vec3 vW; varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

// Electron-microscopy membrane texture on the cell body, with a bright translucent rim.
const SOMA_FRAG = /* glsl */`
  uniform vec3 uColor; uniform sampler2D uMap;
  varying vec3 vN; varying vec3 vW; varying vec2 vUv;
  void main() {
    float m = pow(texture2D(uMap, vUv * vec2(2.0, 1.0)).r, 1.6);
    vec3 V = normalize(cameraPosition - vW);
    float f = 1.0 - max(dot(normalize(vN), V), 0.0);
    vec3 c = uColor * (0.1 + m * 0.75) + uColor * pow(f, 2.4) * 1.1;
    gl_FragColor = vec4(c, 1.0);
  }`;

/** Neuron body material. `material.color` aliases the uniform so existing colour code keeps working. */
function somaMaterial(color) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: SOMA_VERT,
    fragmentShader: SOMA_FRAG,
    uniforms: { uColor: { value: color.clone() }, uMap: { value: loadTex('membrane', { color: false }) } },
  });
  mat.color = mat.uniforms.uColor.value;
  return mat;
}

export function makeTrail(n, color) {
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < n; i++) { const f = (1 - i / n) ** 2; col.set([c.r * f, c.g * f, c.b * f], i * 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const line = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
  line.frustumCulled = false;
  let filled = false;
  return {
    line,
    push(p) {
      const a = g.attributes.position.array;
      if (!filled) { for (let i = 0; i < n; i++) a.set([p.x, p.y, p.z], i * 3); filled = true; }
      a.copyWithin(3, 0, (n - 1) * 3);
      a[0] = p.x; a[1] = p.y; a[2] = p.z;
      g.attributes.position.needsUpdate = true;
    },
  };
}

/** Clustered force layout, deterministic per file id. */
function layout(model, radius) {
  const ids = [...model.nodes.keys()];
  const N = ids.length;
  const pos = new Map();
  const mods = [...model.modules.keys()];
  const centers = new Map();
  const M = mods.length;
  mods.forEach((m, i) => {
    if (M === 1) { centers.set(m, new THREE.Vector3()); return; }
    const y = 1 - (i / (M - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = i * 2.399963;
    centers.set(m, new THREE.Vector3(Math.cos(th) * r, y * 0.6, Math.sin(th) * r).multiplyScalar(radius));
  });
  for (const id of ids) {
    const n = model.nodes.get(id);
    const r = rng(hash(id) + 0.003);
    const spread = 5 + Math.sqrt(model.modules.get(n.module).files.length) * 2.4;
    pos.set(id, centers.get(n.module).clone().add(new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(spread * 2)));
  }
  if (N < 2) return pos;

  const P = ids.map((id) => pos.get(id));
  const CEN = ids.map((id) => centers.get(model.nodes.get(id).module));
  const idx = new Map(ids.map((id, i) => [id, i]));
  const E = model.edges.map((e) => [idx.get(e.source), idx.get(e.target)]).filter(([a, b]) => a != null && b != null);
  const iters = Math.max(20, Math.min(160, Math.round(5e6 / (N * N))));
  const F = P.map(() => new THREE.Vector3());
  const d = new THREE.Vector3();
  for (let it = 0; it < iters; it++) {
    const cool = 1 - it / iters;
    for (const f of F) f.set(0, 0, 0);
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        d.subVectors(P[i], P[j]);
        const dist2 = Math.max(d.lengthSq(), 0.5);
        if (dist2 > 900) continue;
        d.multiplyScalar(26 / dist2);
        F[i].add(d); F[j].sub(d);
      }
    }
    for (const [a, b] of E) {
      d.subVectors(P[b], P[a]);
      const dist = d.length() || 0.01;
      d.multiplyScalar(((dist - 9) * 0.035) / dist);
      F[a].add(d); F[b].sub(d);
    }
    for (let i = 0; i < N; i++) {
      F[i].addScaledVector(d.subVectors(CEN[i], P[i]), 0.03);
      const len = F[i].length();
      if (len > 2.5) F[i].multiplyScalar(2.5 / len);
      P[i].addScaledVector(F[i], cool);
    }
  }
  return pos;
}
