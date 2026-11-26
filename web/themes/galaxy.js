// Galaxy theme: modules are star systems, files are planets, Claude is a ship.
import * as THREE from 'three';
import {
  Animator, KIND_COLORS, AGENT_COLORS, ease, glowSprite, ringTexture, nebulaTexture, starfield, makeLabel, hash, rng, disposeTree,
} from '../fx.js';
import { makeTrail } from './neural.js';

const TEST_MODULES = ['tests', 'test', '__tests__', 'spec', 'specs', 'e2e'];
const SCALE = 1.7; // planet size + orbit radius multiplier, keeps planets readable from the overview
const C = (hex) => new THREE.Color(hex);
const COL = {
  read: C(KIND_COLORS.read), edit: C(KIND_COLORS.edit), create: C(KIND_COLORS.create), bash: C(KIND_COLORS.bash),
  ok: C(KIND_COLORS.ok), fail: C(KIND_COLORS.fail), search: C(KIND_COLORS.search), white: C('#ffffff'), black: C('#000000'),
  engine: C('#7fe8ff'),
};

const PLANET_VERT = /* glsl */`
  varying vec3 vN; varying vec3 vW; varying vec3 vO;
  void main() {
    vO = position;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

const PLANET_FRAG = /* glsl */`
  uniform vec3 uA; uniform vec3 uB; uniform vec3 uHi; uniform vec3 uStar;
  uniform float uSeed; uniform float uHiAmt; uniform float uBands;
  varying vec3 vN; varying vec3 vW; varying vec3 vO;
  float h(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h(i), h(i + vec3(1,0,0)), f.x), mix(h(i + vec3(0,1,0)), h(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(h(i + vec3(0,0,1)), h(i + vec3(1,0,1)), f.x), mix(h(i + vec3(0,1,1)), h(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
  void main() {
    vec3 p = normalize(vO);
    float n = fbm(p * 2.6 + uSeed * 7.0);
    float bands = sin((p.y + n * 0.45) * uBands + uSeed * 10.0) * 0.5 + 0.5;
    vec3 base = mix(uA * 0.28, uA, bands);
    base = mix(base, uB, smoothstep(0.45, 0.8, n) * 0.6);
    vec3 N = normalize(vN);
    vec3 L = normalize(uStar - vW);
    vec3 V = normalize(cameraPosition - vW);
    float diff = max(dot(N, L), 0.0);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    vec3 col = base * (0.04 + diff * 1.15) + uA * rim * (0.25 + diff * 0.6) + uHi * uHiAmt * (0.55 + rim * 1.2);
    gl_FragColor = vec4(col, 1.0);
  }`;

export class GalaxyTheme {
  constructor(engine) {
    this.engine = engine;
    this.root = new THREE.Group();
    this.anim = new Animator();
    this.records = new Map();
    this.systems = new Map();
    this.labels = [];
    this.scouts = [];
    this.focusDistance = 38;
    this.bloom = { strength: 0.95, radius: 0.5, threshold: 0.1 };
    this.fog = null;
    this.home = { position: new THREE.Vector3(0, 160, 320) };
    this.planetGeo = new THREE.SphereGeometry(1, 40, 28);
    this.zero = new THREE.Vector3();
    this.shipGoal = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    this.dir = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.q0 = new THREE.Quaternion();
  }

  // ------------------------------------------------------------------ build
  build(model) {
    this.model = model;
    this.layoutSystems();
    this.home.position.set(0, this.galaxyR * 0.5, this.galaxyR * 0.95);

    this.root.add(new THREE.AmbientLight(0x8090b0, 0.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.3, 1, 0.2);
    this.root.add(sun);

    this.stars = starfield(3500, this.galaxyR * 8, 0.6);
    this.root.add(this.stars);
    this.buildNebulae();
    this.buildCore();

    for (const sys of this.systems.values()) this.buildSystem(sys);
    for (const node of model.nodes.values()) this.addPlanet(node);
    this.buildShip();
  }

  layoutSystems() {
    const mods = [...this.model.modules.values()];
    const ext = mods.map((m) => (8 + Math.sqrt(m.files.length) * 5.4) * SCALE);
    let r = 40 + (ext[0] || 0);
    this.systems = new Map();
    mods.forEach((m, i) => {
      if (i > 0) r += ext[i - 1] * 0.55 + ext[i] * 0.55 + 10;
      const a = i * 2.2 + 0.4;
      const pos = new THREE.Vector3(Math.cos(a) * r, (hash(m.name) - 0.5) * 16, Math.sin(a) * r);
      this.systems.set(m.name, { name: m.name, color: C(m.color), pos, extent: ext[i], count: 0, tilt: (hash(m.name + 't') - 0.5) * 0.35 });
    });
    this.galaxyR = Math.max(140, r + (ext[ext.length - 1] || 0) + 30);
  }

  buildNebulae() {
    const tints = ['#2a8f9e', '#6b3fa0', '#2b4fa8', '#9a3f86', '#1f7a6a', '#4a3aa0'];
    tints.forEach((tint, i) => {
      const m = new THREE.SpriteMaterial({ map: nebulaTexture(i + 1), color: tint, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false });
      const s = new THREE.Sprite(m);
      const a = (i / tints.length) * Math.PI * 2 + 0.3;
      s.position.set(Math.cos(a) * this.galaxyR * 0.7, -30 + i * 6, Math.sin(a) * this.galaxyR * 0.7);
      s.scale.setScalar(this.galaxyR * (1.6 + hash('n' + i)));
      this.root.add(s);
    });
  }

  buildCore() {
    const N = 9000;
    const pos = new Float32Array(N * 3); const col = new Float32Array(N * 3);
    const r = rng(0.31);
    const warm = C('#ffd6a0'); const cool = C('#7f9cff'); const vio = C('#b07cff'); const c = new THREE.Color();
    const gauss = () => (r() + r() + r() - 1.5) / 1.5;
    for (let i = 0; i < N; i++) {
      const arm = i % 3;
      const t = r() ** 0.8;
      const rad = 8 + t * this.galaxyR * 0.95;
      const ang = arm * (Math.PI * 2 / 3) + t * 5.2 + gauss() * 0.35;
      const spread = (1 - t * 0.4) * rad * 0.1;
      pos.set([Math.cos(ang) * rad + gauss() * spread, gauss() * (5 * (1 - t) + 1.2), Math.sin(ang) * rad + gauss() * spread], i * 3);
      c.copy(warm).lerp(arm === 1 ? vio : cool, Math.min(1, t * 1.6)).multiplyScalar(0.35 + r() * 0.5);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.arms = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.1, vertexColors: true, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.root.add(this.arms);
    this.root.add(glowSprite(C('#ffe2b8'), 70, 0.9));
    this.root.add(glowSprite(C('#fff4e0'), 18, 1));
  }

  buildSystem(sys) {
    sys.group = new THREE.Group();
    sys.group.position.copy(sys.pos);
    sys.group.rotation.x = sys.tilt;
    sys.glow = glowSprite(sys.color, 22, 0.85);
    sys.group.add(sys.glow, glowSprite(sys.color.clone().lerp(COL.white, 0.55), 7, 1));
    this.root.add(sys.group);
    const label = makeLabel(sys.name, '#' + sys.color.getHexString());
    label.position.set(sys.pos.x, sys.pos.y + 9, sys.pos.z);
    this.root.add(label);
    this.labels.push(label);
  }

  addPlanet(node) {
    const sys = this.systems.get(node.module);
    if (!sys) return null;
    const k = sys.count++;
    const orbit = (7 + Math.sqrt(k) * 5.2 + (hash(node.id) - 0.5) * 1.5) * SCALE;
    const size = (0.6 + Math.log2(node.loc + 1) * 0.3) * SCALE;
    const mat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: PLANET_FRAG,
      uniforms: {
        uA: { value: sys.color.clone() },
        uB: { value: sys.color.clone().offsetHSL((hash(node.id + 'h') - 0.5) * 0.3, -0.2, 0.15) },
        uHi: { value: new THREE.Color() },
        uHiAmt: { value: 0 },
        uStar: { value: sys.pos.clone() },
        uSeed: { value: hash(node.id) * 10 },
        uBands: { value: 6 + hash(node.id + 'b') * 18 },
      },
    });
    const mesh = new THREE.Mesh(this.planetGeo, mat);
    mesh.scale.setScalar(size);
    mesh.userData.id = node.id;
    sys.group.add(mesh);

    const pts = [];
    for (let i = 0; i <= 128; i++) { const a = (i / 128) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * orbit, 0, Math.sin(a) * orbit)); }
    const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: sys.color, transparent: true, opacity: 0.13, depthWrite: false }));
    sys.group.add(ring);

    const rec = {
      id: node.id, sys, mesh, ring, size, orbit, mat,
      angle: hash(node.id + 'a') * Math.PI * 2,
      speed: (0.9 / Math.sqrt(orbit)) * 0.32,
      world: new THREE.Vector3(), boost: 0, decay: 1, boostColor: new THREE.Color(), scale: 1,
    };
    this.records.set(node.id, rec);
    this.placePlanet(rec);
    return rec;
  }

  placePlanet(rec) {
    rec.mesh.position.set(Math.cos(rec.angle) * rec.orbit, 0, Math.sin(rec.angle) * rec.orbit);
    rec.mesh.updateMatrixWorld();
    rec.mesh.getWorldPosition(rec.world);
  }

  makeShip(engineColor, scale = 1) {
    const g = new THREE.Group();
    const hull = new THREE.MeshStandardMaterial({ color: 0xc9ced6, metalness: 0.75, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f38, metalness: 0.6, roughness: 0.5 });
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.55, 2.8, 12), hull);
    body.rotation.x = Math.PI / 2;
    const wing = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.07, 0.9), dark);
    wing.position.z = -0.55;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.6, 0.7), dark);
    fin.position.set(0, 0.32, -0.8);
    const flame = glowSprite(engineColor, 2.4, 1);
    flame.position.z = -1.6;
    g.add(body, wing, fin, flame);
    g.scale.setScalar(scale);
    g.userData.flame = flame;
    g.userData.engineColor = engineColor.clone();
    return g;
  }

  buildShip() {
    this.ship = this.makeShip(COL.engine, 1.1);
    this.ship.position.set(this.galaxyR * 0.3, 20, 0);
    this.root.add(this.ship);
    this.shipTarget = null;
    this.shipTrail = makeTrail(60, COL.engine);
    this.root.add(this.shipTrail.line);
    this.shipPrev = this.ship.position.clone();
  }

  // ------------------------------------------------------------------ sync
  sync(model) {
    this.model = model;
    if ([...model.modules.keys()].some((n) => !this.systems.has(n))) { this.engine.rebuild(); return; }
    for (const node of model.nodes.values()) if (!this.records.has(node.id)) this.addPlanet(node);
    for (const [id, rec] of this.records) {
      if (!model.nodes.has(id)) {
        rec.mesh.removeFromParent(); rec.ring.removeFromParent();
        rec.mat.dispose(); rec.ring.geometry.dispose(); rec.ring.material.dispose();
        this.records.delete(id);
      }
    }
  }

  // ------------------------------------------------------------------ queries
  positionOf(id) { return this.records.get(id)?.world || null; }
  agentPosition() { return this.ship.position; }
  moduleCenter(name) { return this.systems.get(name)?.pos || null; }
  testAnchor() {
    for (const m of TEST_MODULES) if (this.systems.has(m)) return this.systems.get(m).pos;
    return this.zero;
  }
  pick(raycaster) {
    const hits = raycaster.intersectObjects([...this.records.values()].map((r) => r.mesh), false);
    return hits.length ? hits[0].object.userData.id : null;
  }

  // ------------------------------------------------------------------ effects
  boost(rec, color, amount = 1, seconds = 2) {
    if (!rec) return;
    rec.boost = Math.max(rec.boost, amount);
    rec.boostColor.copy(color);
    rec.decay = seconds;
  }

  flyTo(id) {
    const rec = this.records.get(id);
    if (!rec) return;
    this.shipTarget = () => this.shipGoal.copy(rec.world).add(this.tmp.set(0, rec.size * 2 + 2.5, rec.size * 2.5 + 3));
  }

  ring(posFn, color, from, to, seconds = 1.2, flat = false) {
    let obj;
    if (flat) {
      obj = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 96), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
      obj.rotation.x = -Math.PI / 2;
    } else {
      obj = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    }
    this.root.add(obj);
    this.anim.add(seconds, (k) => {
      obj.position.copy(posFn());
      obj.scale.setScalar(from + (to - from) * ease.outCubic(k));
      obj.material.opacity = 0.85 * (1 - k);
    }, () => { obj.removeFromParent(); if (flat) obj.geometry.dispose(); obj.material.dispose(); });
  }

  scanBeam(rec, color, seconds = 2.4) {
    const geo = new THREE.ConeGeometry(1, 1, 32, 1, true);
    geo.translate(0, -0.5, 0);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const cone = new THREE.Mesh(geo, mat);
    const torus = new THREE.Mesh(new THREE.TorusGeometry(1, 0.035, 8, 96), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.root.add(cone, torus);
    this.anim.add(seconds, (k) => {
      const fade = Math.min(1, k * 5) * Math.min(1, (1 - k) * 4);
      cone.position.copy(this.ship.position);
      cone.lookAt(rec.world);
      cone.scale.set(rec.size * 1.1, rec.size * 1.1, this.ship.position.distanceTo(rec.world));
      mat.opacity = 0.22 * fade;
      torus.position.copy(rec.world);
      torus.scale.setScalar(rec.size * 1.5);
      torus.rotation.set(Math.PI / 2 + Math.sin(k * 12) * 0.6, 0, k * 6);
      torus.material.opacity = 0.9 * fade;
    }, () => {
      cone.removeFromParent(); geo.dispose(); mat.dispose();
      torus.removeFromParent(); torus.geometry.dispose(); torus.material.dispose();
    });
  }

  constructionRing(rec, seconds = 3) {
    const torus = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 8, 120), new THREE.MeshBasicMaterial({ color: COL.edit, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    const inner = new THREE.Mesh(new THREE.TorusGeometry(1, 0.03, 6, 120, Math.PI * 1.3), torus.material.clone());
    this.root.add(torus, inner);
    this.anim.add(seconds, (k) => {
      const fade = Math.min(1, k * 4) * Math.min(1, (1 - k) * 3);
      torus.position.copy(rec.world); inner.position.copy(rec.world);
      torus.scale.setScalar(rec.size * (1.9 + 0.1 * Math.sin(k * 20)));
      inner.scale.setScalar(rec.size * 1.55);
      torus.rotation.set(Math.PI / 2.3, k * 4, 0);
      inner.rotation.set(Math.PI / 2.1, -k * 7, k * 2);
      torus.material.opacity = fade; inner.material.opacity = fade * 0.8;
    }, () => {
      for (const m of [torus, inner]) { m.removeFromParent(); m.geometry.dispose(); m.material.dispose(); }
    });
  }

  hyperlane(fromRec, toRec, color, delay) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    const spark = glowSprite(color, 2.2, 0);
    this.root.add(line, spark);
    let hit = false;
    const total = 1.8 + delay;
    this.anim.add(total, (k) => {
      const t = k * total;
      if (t < delay) return;
      const q = (t - delay) / 1.8;
      geo.attributes.position.array.set([fromRec.world.x, fromRec.world.y, fromRec.world.z, toRec.world.x, toRec.world.y, toRec.world.z]);
      geo.attributes.position.needsUpdate = true;
      mat.opacity = 0.7 * Math.sin(q * Math.PI);
      spark.position.lerpVectors(fromRec.world, toRec.world, ease.inOutCubic(Math.min(1, q * 1.6)));
      spark.material.opacity = q < 0.62 ? 1 : 0;
      if (q >= 0.62 && !hit) { hit = true; this.boost(toRec, color, 0.7, 1.8); }
    }, () => { line.removeFromParent(); geo.dispose(); mat.dispose(); spark.removeFromParent(); spark.material.dispose(); });
  }

  accretion(rec, color, seconds = 2.2) {
    const N = 500;
    const pos = new Float32Array(N * 3);
    const seeds = Array.from({ length: N }, () => ({ a: Math.random() * Math.PI * 2, r: 4 + Math.random() * 9, y: (Math.random() - 0.5) * 1.2 }));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color, size: 0.35, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    this.root.add(pts);
    this.anim.add(seconds, (k) => {
      const a = g.attributes.position.array;
      const q = ease.inOutCubic(k);
      for (let i = 0; i < N; i++) {
        const s = seeds[i];
        const rr = s.r * (1 - q) + rec.size * 0.9 * q;
        const ang = s.a + (k * 9) / Math.sqrt(s.r);
        a[i * 3] = rec.world.x + Math.cos(ang) * rr;
        a[i * 3 + 1] = rec.world.y + s.y * (1 - q);
        a[i * 3 + 2] = rec.world.z + Math.sin(ang) * rr;
      }
      g.attributes.position.needsUpdate = true;
      m.opacity = 0.9 * (1 - k * k);
    }, () => { pts.removeFromParent(); g.dispose(); m.dispose(); });
  }

  pulsar(anchor, color, seconds = 5) {
    const grp = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const geo = new THREE.CylinderGeometry(0.15, 3.2, 120, 24, 1, true);
    geo.translate(0, 60, 0);
    const b1 = new THREE.Mesh(geo, mat); const b2 = new THREE.Mesh(geo, mat);
    b2.rotation.z = Math.PI;
    const glow = glowSprite(color, 26, 0);
    grp.add(b1, b2, glow);
    grp.position.copy(anchor);
    this.root.add(grp);
    this.anim.add(seconds, (k) => {
      const fade = Math.min(1, k * 5) * Math.min(1, (1 - k) * 3);
      mat.opacity = 0.35 * fade;
      glow.material.opacity = 0.9 * fade;
      grp.rotation.set(0.5, 0, k * 14);
    }, () => { grp.removeFromParent(); geo.dispose(); mat.dispose(); glow.material.dispose(); });
  }

  onEvent(ev, meta) {
    let rec = ev.file ? this.records.get(ev.file) : null;
    switch (ev.kind) {
      case 'prompt':
        this.ring(() => this.ship.position, COL.white, 2, 30, 1.4);
        break;
      case 'read':
        if (!rec) break;
        this.flyTo(ev.file);
        this.boost(rec, COL.read, 0.8, 2.6);
        this.anim.add(0.7, () => {}, () => this.scanBeam(rec, COL.read));
        break;
      case 'search':
        this.ring(() => this.ship.position, COL.search, 3, 90, 2, true);
        break;
      case 'edit':
        if (!rec) break;
        this.flyTo(ev.file);
        this.boost(rec, COL.edit, 1, 3.2);
        this.constructionRing(rec);
        (meta.dependents || []).forEach((dep, i) => {
          const d = this.records.get(dep);
          if (d) this.hyperlane(rec, d, COL.edit, 0.5 + i * 0.15);
        });
        break;
      case 'create': {
        const node = ev.file && this.model.nodes.get(ev.file);
        if (!rec && node) {
          if (!this.systems.has(node.module)) { this.engine.rebuild(); return; }
          rec = this.addPlanet(node);
        }
        if (!rec) break;
        const r = rec;
        this.flyTo(ev.file);
        r.scale = 0;
        this.accretion(r, COL.create);
        this.anim.add(2.4, (k) => { r.scale = ease.outBack(Math.max(0, (k - 0.25) / 0.75)); });
        this.boost(r, COL.create, 1, 4);
        this.anim.add(1.4, () => {}, () => this.ring(() => r.world, COL.create, r.size * 2, r.size * 9, 1.4));
        break;
      }
      case 'bash':
        this.flash(COL.bash);
        break;
      case 'bash_result':
        if (!ev.ok) this.flash(COL.fail);
        break;
      case 'test_result':
        this.pulsar(this.testAnchor(), ev.ok ? COL.ok : COL.fail);
        for (const r of this.records.values()) this.boost(r, COL.ok, ev.ok ? 0.45 : 0.2, 2);
        for (const id of meta.failing || []) {
          const fr = this.records.get(id);
          if (fr) this.anim.add(0.8, () => {}, () => this.boost(fr, COL.fail, 1, 4));
        }
        break;
      case 'agent_start':
        this.spawnScout();
        break;
      case 'agent_stop':
        this.removeScout();
        break;
      case 'idle':
        this.shipTarget = null;
        while (this.scouts.length) this.removeScout();
        break;
      default:
        break;
    }
  }

  flash(color) {
    const f = this.ship.userData.flame;
    this.anim.add(1.4, (k) => { f.material.color.copy(color).lerp(COL.engine, k); f.scale.setScalar(2.4 + 3 * (1 - k)); });
  }

  spawnScout() {
    const color = C(AGENT_COLORS[this.scouts.length % AGENT_COLORS.length]);
    const ship = this.makeShip(color, 0.6);
    ship.position.copy(this.ship.position);
    this.root.add(ship);
    const trail = makeTrail(70, color);
    this.root.add(trail.line);
    const systems = [...this.systems.values()];
    const sys = systems[Math.floor(Math.random() * systems.length)];
    this.scouts.push({ ship, trail, color, sys, target: null, retarget: 0, goal: new THREE.Vector3(), prev: ship.position.clone() });
  }

  removeScout() {
    const s = this.scouts.shift();
    if (!s) return;
    this.anim.add(0.9, (k) => { s.ship.scale.setScalar(0.6 * (1 - k) + 0.001); s.trail.line.material.opacity = 1 - k; }, () => {
      s.ship.removeFromParent(); disposeTree(s.ship);
      s.trail.line.removeFromParent(); s.trail.line.geometry.dispose(); s.trail.line.material.dispose();
    });
  }

  steer(obj, goal, prev, dt, rate) {
    prev.copy(obj.position);
    obj.position.lerp(goal, 1 - Math.exp(-dt * rate));
    this.dir.subVectors(obj.position, prev);
    if (this.dir.lengthSq() > 1e-6) {
      this.look.copy(obj.position).add(this.dir.normalize());
      this.q0.copy(obj.quaternion);
      obj.lookAt(this.look);
      const target = obj.quaternion.clone();
      obj.quaternion.copy(this.q0).slerp(target, 1 - Math.exp(-dt * 5));
    }
  }

  // ------------------------------------------------------------------ frame
  update(dt, t) {
    this.anim.update(dt);
    const model = this.model;
    const hoverId = this.engine.hoverId;
    for (const rec of this.records.values()) {
      rec.angle += rec.speed * dt;
      this.placePlanet(rec);
      rec.mesh.rotation.y += dt * 0.3;
      rec.boost = Math.max(0, rec.boost - dt / rec.decay);
      const u = rec.mat.uniforms;
      let amt = 0;
      const hi = u.uHi.value.copy(COL.black);
      if (model.failing.has(rec.id)) { hi.copy(COL.fail); amt = 0.55; }
      else if (model.created.has(rec.id)) { hi.copy(COL.create); amt = 0.3; }
      else if (model.modified.has(rec.id)) { hi.copy(COL.edit); amt = 0.3; }
      if (hoverId === rec.id) { hi.lerp(COL.white, 0.6); amt = Math.max(amt, 0.35); }
      if (rec.boost > 0) { hi.lerp(rec.boostColor, Math.min(1, rec.boost * 1.5)); amt = Math.max(amt, rec.boost); }
      u.uHiAmt.value = amt;
      rec.mesh.scale.setScalar(Math.max(0.001, rec.size * rec.scale));
      rec.ring.material.opacity = hoverId === rec.id || rec.boost > 0.2 ? 0.35 : 0.13;
    }
    for (const sys of this.systems.values()) sys.glow.material.opacity = 0.75 + Math.sin(t * 0.8 + sys.pos.x) * 0.08;

    const goal = this.shipTarget
      ? this.shipTarget()
      : this.shipGoal.set(Math.cos(t * 0.05) * this.galaxyR * 0.32, 22 + Math.sin(t * 0.3) * 4, Math.sin(t * 0.05) * this.galaxyR * 0.32);
    this.steer(this.ship, goal, this.shipPrev, dt, 1.6);
    this.ship.userData.flame.material.opacity = 0.8 + Math.sin(t * 30) * 0.2;
    this.shipTrail.push(this.ship.position);

    for (const s of this.scouts) {
      s.retarget -= dt;
      if (s.retarget <= 0 && s.sys) {
        const files = model.modules.get(s.sys.name)?.files || [];
        const r = this.records.get(files[Math.floor(Math.random() * files.length)]);
        if (r) { s.target = r; this.boost(r, s.color, 0.6, 1.5); }
        s.retarget = 1.8 + Math.random() * 1.4;
      }
      if (s.target) s.goal.copy(s.target.world).add(this.tmp.set(0, s.target.size * 2 + 1.5, 0));
      else s.goal.copy(s.sys.pos);
      this.steer(s.ship, s.goal, s.prev, dt, 2.2);
      s.trail.push(s.ship.position);
    }

    this.arms.rotation.y += dt * 0.006;
    this.stars.rotation.y += dt * 0.0015;
  }

  dispose() {
    this.anim.clear();
    for (const l of this.labels) l.removeFromParent();
    disposeTree(this.root);
  }
}
