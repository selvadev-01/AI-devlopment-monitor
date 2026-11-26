// Galaxy theme: modules are star systems, files are planets, Claude is a ship.
import * as THREE from 'three';
import {
  Animator, KIND_COLORS, AGENT_COLORS, ease, glowSprite, ringTexture, loadTex, skySphere, dotTexture, nebulaTexture, starfield, makeLabel, hash, rng, disposeTree, declutterLabels,
} from '../fx.js';
import { ScoutManager } from '../scouts.js';
import { displayName } from '../model.js';
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
  varying vec3 vN; varying vec3 vW; varying vec3 vO; varying vec2 vUv;
  void main() {
    vO = position;
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

// Surface texture (6 planet types, generated with ComfyUI) + soft terminator + drifting clouds,
// with the module colour as a light tint and as the atmosphere rim.
const PLANET_FRAG = /* glsl */`
  uniform vec3 uA; uniform vec3 uHi; uniform vec3 uStar;
  uniform float uHiAmt; uniform float uTime; uniform float uClouds; uniform float uTint; uniform float uSpin;
  uniform sampler2D uMap; uniform sampler2D uCloudMap;
  varying vec3 vN; varying vec3 vW; varying vec3 vO; varying vec2 vUv;
  void main() {
    vec3 base = texture2D(uMap, vUv).rgb;
    base = mix(base, base * uA * 1.8, uTint);
    vec3 N = normalize(vN);
    vec3 L = normalize(uStar - vW);
    vec3 V = normalize(cameraPosition - vW);
    float day = smoothstep(-0.12, 0.55, dot(N, L));
    vec3 col = base * (0.16 + day * 0.72); // night side keeps some light, so planets never read as black dots
    float cl = smoothstep(0.5, 0.9, texture2D(uCloudMap, vUv * vec2(1.0, 1.0) + vec2(uTime * uSpin, 0.0)).r) * uClouds;
    col = mix(col, vec3(0.78, 0.8, 0.84) * (0.03 + day * 0.8), cl * 0.7);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col += uA * rim * (0.1 + day * 0.55);
    col += uHi * uHiAmt * (0.12 + rim * 1.8); // state colour mostly at the edge, so the surface stays visible
    gl_FragColor = vec4(col, 1.0);
  }`;

const RING_VERT = /* glsl */`
  varying vec2 vP;
  void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const RING_FRAG = /* glsl */`
  uniform vec3 uA; uniform float uSeed;
  varying vec2 vP;
  void main() {
    float r = (length(vP) - 1.45) / 0.95;
    if (r < 0.0 || r > 1.0) discard;
    float bands = 0.5 + 0.5 * sin(r * 70.0 + uSeed) * sin(r * 23.0 + uSeed * 2.0);
    float gap = smoothstep(0.0, 0.035, abs(r - 0.6));
    float a = (0.25 + bands * 0.75) * gap * smoothstep(0.0, 0.06, r) * smoothstep(1.0, 0.8, r) * 0.6;
    vec3 c = mix(vec3(0.86, 0.8, 0.7), uA, 0.3) * (0.45 + bands * 0.55);
    gl_FragColor = vec4(c, a);
  }`;

const PLANET_TYPES = [
  { map: 'planet_gas', clouds: 0, tint: 0.18, ringChance: 0.7 },
  { map: 'planet_rock', clouds: 0, tint: 0.22, ringChance: 0.05 },
  { map: 'planet_ice', clouds: 0.2, tint: 0.4, ringChance: 0.2 }, // tinted: plain ice reads as a white ball
  { map: 'planet_lava', clouds: 0, tint: 0.1, ringChance: 0 },
  { map: 'planet_ocean', clouds: 0.55, tint: 0.12, ringChance: 0.05 },
  { map: 'planet_desert', clouds: 0.25, tint: 0.15, ringChance: 0.1 },
];

export class GalaxyTheme {
  constructor(engine) {
    this.engine = engine;
    this.root = new THREE.Group();
    this.anim = new Animator();
    this.records = new Map();
    this.systems = new Map();
    this.labels = [];
    this.focusDistance = 55;
    this.bloom = { strength: 0.75, radius: 0.5, threshold: 0.78 }; // only stars and glows bloom: a lit ice or cloudy planet must not turn into a white ball
    this.timeU = { value: 0 };                                     // shared by every planet's cloud drift
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
    this.maxPolar = 1.25; // never edge-on: labels of systems on one line would stack up
    this.layoutSystems();
    this.home.position.set(0, this.galaxyR * 0.85, this.galaxyR * 0.9);

    this.root.add(new THREE.AmbientLight(0x8090b0, 0.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.3, 1, 0.2);
    this.root.add(sun);

    this.sky = skySphere('sky_space', 5200, 0x9aa3b8); // follows the camera (see update), so it is never cut by the far plane
    this.root.add(this.sky);
    this.stars = starfield(2500, this.galaxyR * 6, 0.6);
    this.stars.material.opacity = 0.6;
    this.root.add(this.stars);
    this.buildNebulae();
    this.buildCore();

    for (const sys of this.systems.values()) this.buildSystem(sys);
    // Big projects: one label per top folder (its slice of the disc) for the far view.
    this.grouped = this.sectors.length < this.systems.size;
    if (this.grouped) {
      for (const sec of this.sectors) {
        const label = makeLabel(sec.t, sec.color, 'module-label top');
        label.position.set(Math.cos(sec.mid) * sec.r, 40, Math.sin(sec.mid) * sec.r);
        label.userData = { top: true };
        this.root.add(label);
        this.labels.push(label);
      }
    }
    for (const node of model.nodes.values()) this.addPlanet(node);
    this.buildShip();
    this.scouts = new ScoutManager(this, {
      make: (color) => {
        const ship = this.makeShip(color, 0.85); // close to the main ship's size, so subagents read as ships too
        const trail = makeTrail(70, color);
        return {
          obj: ship, trail, prev: new THREE.Vector3(),
          dispose: () => { disposeTree(ship); trail.line.geometry.dispose(); trail.line.material.dispose(); },
        };
      },
      move: (s, goal, dt) => this.steer(s.obj, goal, s.prev, dt, 2.2),
      lift: 5,
    });
    this.scouts.sync(model);
  }

  /**
   * Each top folder (frontend, backend…) owns a slice of the galaxy disc, sized by how much space its
   * systems need; inside the slice, systems fill arcs from the centre outwards. So all of "backend/…"
   * is one neighbourhood, with an empty lane between neighbourhoods.
   */
  layoutSystems() {
    const mods = [...this.model.modules.values()];
    const ext = (m) => (8 + Math.sqrt(m.files.length) * 5.4) * SCALE;
    const groups = new Map();
    for (const m of mods) { const t = m.name.split('/')[0]; if (!groups.has(t)) groups.set(t, []); groups.get(t).push(m); }
    const G = [...groups.entries()].map(([t, ms]) => ({ t, ms, need: ms.reduce((s, m) => s + (2 * ext(m) + 14) ** 2, 0) }))
      .sort((a, b) => b.need - a.need);
    const R0 = 60;
    const total = G.reduce((s, g) => s + g.need, 0);
    // Disc big enough for every system plus lanes: area = pi (R^2 - R0^2).
    const R = Math.sqrt(total * 1.35 / Math.PI + R0 * R0);
    const LANE = G.length > 1 ? 0.12 : 0; // radians of empty space between neighbourhoods
    const span = Math.PI * 2 - LANE * G.length;
    this.systems = new Map();
    this.sectors = [];
    // Slice widths follow each group's share; tiny groups get a minimum so their systems fit.
    for (const g of G) g.width = G.length > 1 ? Math.max(0.35, span * (g.need / total)) : Math.PI * 2;
    const fit = G.length > 1 ? span / G.reduce((s, g) => s + g.width, 0) : 1;
    let a0 = 0.4;
    let maxR = R0;
    for (const g of G) {
      const width = g.width * fit;
      const list = g.ms.slice().sort((p, q) => q.files.length - p.files.length);
      // fill arcs: ring by ring from the centre, each system as wide as its extent
      let r = R0; let i = 0;
      while (i < list.length) {
        const ringD = 2 * ext(list[i]) + 12;
        const rr = r + ringD / 2;
        const arc = rr * width;
        let used = 0; const ring = [];
        while (i < list.length && (ring.length === 0 || used + 2 * ext(list[i]) + 12 <= arc)) { used += 2 * ext(list[i]) + 12; ring.push(list[i]); i++; }
        let off = (arc - used) / 2;
        for (const m of ring) {
          const e = ext(m); off += e + 6;
          const ang = a0 + off / rr;
          off += e + 6;
          const pos = new THREE.Vector3(Math.cos(ang) * rr, (hash(m.name) - 0.5) * 10, Math.sin(ang) * rr);
          this.systems.set(m.name, { name: m.name, top: g.t, color: C(m.color), pos, extent: e, count: 0, fk: 1, tilt: (hash(m.name + 't') - 0.5) * 0.35 });
          maxR = Math.max(maxR, rr + e);
        }
        r += ringD;
      }
      this.sectors.push({ t: g.t, a0, width, inner: R0 - 20, outer: r + 10, mid: a0 + width / 2, r: (R0 + r) / 2, color: this.model.familyOf?.get(g.t) || list[0].color });
      a0 += width + LANE;
    }
    this.galaxyR = Math.max(140, maxR + 30);
  }

  buildNebulae() {
    const tints = ['#2a8f9e', '#6b3fa0', '#2b4fa8', '#9a3f86', '#1f7a6a', '#4a3aa0'];
    tints.forEach((tint, i) => {
      const m = new THREE.SpriteMaterial({ map: nebulaTexture(i + 1), color: tint, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false }); // faint: deep space stays black
      const s = new THREE.Sprite(m);
      const a = (i / tints.length) * Math.PI * 2 + 0.3;
      s.position.set(Math.cos(a) * this.galaxyR * 0.7, -30 + i * 6, Math.sin(a) * this.galaxyR * 0.7);
      s.scale.setScalar(this.galaxyR * (1.6 + hash('n' + i)));
      this.root.add(s);
    });
  }

  /**
   * The galaxy itself: a photographic face-on spiral (generated locally with ComfyUI) on a disc under
   * the solar systems, faded at the rim, plus a light sprinkle of stars above it for depth.
   */
  buildCore() {
    const R = this.galaxyR * 1.12;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: loadTex('galaxy_disc') }, uBright: { value: 0.5 } },
      vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap; uniform float uBright; varying vec2 vUv;
        void main() {
          vec3 c = texture2D(uMap, vUv).rgb;
          float r = length(vUv - 0.5) * 2.0;
          float fade = 1.0 - smoothstep(0.72, 0.98, r);   // soft round edge, hides the square corners
          c *= uBright * fade;
          // keep the bright core from blowing out under bloom
          c = c / (1.0 + max(max(c.r, c.g), c.b) * 0.35);
          gl_FragColor = vec4(c, 1.0);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(R, 96), mat);
    this.disc.rotation.x = -Math.PI / 2;
    this.disc.position.y = -10;
    this.root.add(this.disc);

    // a thin sprinkle of stars in the arms, above the disc, so it is not a flat picture up close
    const N = 2500;
    const pos = new Float32Array(N * 3); const col = new Float32Array(N * 3);
    const r = rng(0.31);
    const c = new THREE.Color(); const warm = C('#ffe2c0'); const cool = C('#a9b8ff');
    for (let i = 0; i < N; i++) {
      const t = r() ** 0.7;
      const rad = 20 + t * this.galaxyR * 0.95;
      const ang = (i % 2) * Math.PI + t * 6.5 + (r() - 0.5) * 0.6;
      pos.set([Math.cos(ang) * rad, (r() - 0.5) * 6, Math.sin(ang) * rad], i * 3);
      c.copy(warm).lerp(cool, t).multiplyScalar(0.4 + r() * 0.5);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.arms = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.1, map: dotTexture(), vertexColors: true, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.root.add(this.arms);
    this.root.add(glowSprite(C('#ffe2b8'), this.galaxyR * 0.18, 0.55));
    this.root.add(glowSprite(C('#fff4e0'), 16, 0.9));
  }

  buildSystem(sys) {
    sys.group = new THREE.Group();
    sys.group.position.copy(sys.pos);
    sys.group.rotation.x = sys.tilt;
    // a sun: warm white core, only a hint of the module colour in its halo
    sys.glow = glowSprite(sys.color.clone().lerp(C('#fff1d6'), 0.6), 13, 0.6);
    sys.group.add(sys.glow, glowSprite(C('#fff6e8'), 4.5, 1));
    this.root.add(sys.group);
    const label = makeLabel(displayName(sys.name), '#' + sys.color.getHexString());
    label.userData = { module: sys.name };
    label.position.set(sys.pos.x, sys.pos.y + 9 + sys.extent * 0.22, sys.pos.z); // above the orbits, not on them
    this.root.add(label);
    this.labels.push(label);
  }

  addPlanet(node) {
    const sys = this.systems.get(node.module);
    if (!sys) return null;
    const k = sys.count++;
    const orbit = (7 + Math.sqrt(k) * 5.2 + (hash(node.id) - 0.5) * 1.5) * SCALE;
    const size = (0.4 + Math.log2(node.loc + 1) * 0.14) * SCALE; // small enough that a system reads as many planets, not a few balls
    const type = PLANET_TYPES[Math.floor(hash(node.id + 'type') * PLANET_TYPES.length)];
    const mat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: PLANET_FRAG,
      uniforms: {
        uA: { value: sys.color.clone() },
        uHi: { value: new THREE.Color() },
        uHiAmt: { value: 0 },
        uStar: { value: sys.pos.clone() },
        uMap: { value: loadTex(type.map) },
        uCloudMap: { value: loadTex('clouds', { color: false }) },
        uClouds: { value: type.clouds },
        uTint: { value: type.tint },
        uSpin: { value: 0.003 + hash(node.id + 's') * 0.004 },
        uTime: this.timeU,
      },
    });
    const mesh = new THREE.Mesh(this.planetGeo, mat);
    mesh.scale.setScalar(size);
    mesh.rotation.y = hash(node.id + 'r') * Math.PI * 2;
    mesh.userData.id = node.id;
    sys.group.add(mesh);

    if (hash(node.id + 'ring') < type.ringChance) {
      const ringMat = new THREE.ShaderMaterial({
        vertexShader: RING_VERT, fragmentShader: RING_FRAG,
        uniforms: { uA: { value: sys.color.clone() }, uSeed: { value: hash(node.id) * 20 } },
        transparent: true, side: THREE.DoubleSide, depthWrite: false,
      });
      const ringMesh = new THREE.Mesh(new THREE.RingGeometry(1.45, 2.4, 128, 1), ringMat);
      ringMesh.rotation.x = -Math.PI / 2 + (hash(node.id + 'tilt') - 0.5) * 0.7;
      mesh.add(ringMesh); // child: follows the planet's position and scale
    }

    const pts = [];
    for (let i = 0; i <= 128; i++) { const a = (i / 128) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * orbit, 0, Math.sin(a) * orbit)); }
    const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: sys.color.clone().lerp(COL.white, 0.5), transparent: true, opacity: 0.07, depthWrite: false }));
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

  /**
   * A small cruiser in the style of the concept art: a rounded white hull (lathe profile) with dark
   * panel bands, a glass cockpit, two engine pods with glowing nozzles, and short swept wings.
   * Built from primitives so it needs no model download; the nose points at +z.
   */
  makeShip(engineColor, scale = 1) {
    const g = new THREE.Group();
    const hull = new THREE.MeshStandardMaterial({ color: 0xdfe3e8, metalness: 0.55, roughness: 0.32 });
    const panel = new THREE.MeshStandardMaterial({ color: 0x3a404a, metalness: 0.6, roughness: 0.45 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0d1a24, metalness: 0.9, roughness: 0.08, emissive: 0x1a6f8f, emissiveIntensity: 0.6 });
    const glow = new THREE.MeshBasicMaterial({ color: engineColor, toneMapped: false });
    // hull: lathe profile along z (rounded nose, wide middle, flat tail)
    const prof = [[0, -1.5], [0.42, -1.5], [0.55, -1.1], [0.62, -0.2], [0.58, 0.6], [0.42, 1.2], [0.2, 1.55], [0, 1.62]]
      .map(([r, z]) => new THREE.Vector2(r, z));
    const body = new THREE.Mesh(new THREE.LatheGeometry(prof, 20), hull);
    body.rotation.x = Math.PI / 2; // lathe axis y -> z
    body.scale.set(1, 1, 0.82);    // a bit flatter than round
    for (const z of [-0.75, 0.15]) { // dark panel bands
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.635, 0.635, 0.09, 20, 1, true), panel);
      band.rotation.x = Math.PI / 2; band.position.z = z; band.scale.set(1, 1, 0.82);
      g.add(band);
    }
    const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), glass);
    cockpit.scale.set(1, 0.6, 1.7);
    cockpit.position.set(0, 0.4, 0.75);
    const wingGeo = new THREE.BoxGeometry(1.1, 0.06, 0.7);
    wingGeo.translate(0.55, 0, 0);
    const wings = [];
    for (const side of [-1, 1]) {
      const w = new THREE.Mesh(wingGeo, panel);
      w.position.set(side * 0.45, -0.1, -0.55);
      w.rotation.set(0, side * 0.35, 0);
      w.scale.x = side;
      wings.push(w);
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 1.3, 14), hull);
      pod.rotation.x = Math.PI / 2;
      pod.position.set(side * 1.15, -0.1, -0.85);
      const nozzle = new THREE.Mesh(new THREE.CircleGeometry(0.17, 14), glow);
      nozzle.position.set(side * 1.15, -0.1, -1.51);
      nozzle.rotation.y = Math.PI;
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.42, 0.5), panel);
      fin.position.set(side * 1.15, 0.22, -1.1);
      g.add(pod, nozzle, fin);
    }
    const mainNozzle = new THREE.Mesh(new THREE.CircleGeometry(0.3, 18), glow);
    mainNozzle.position.z = -1.51; mainNozzle.rotation.y = Math.PI;
    const flame = glowSprite(engineColor, 2.4, 1);
    flame.position.z = -1.9;
    g.add(body, cockpit, ...wings, mainNozzle, flame);
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
    this.shipTrail = makeTrail(180, COL.engine); // long trail: the path shows where Claude has been
    this.root.add(this.shipTrail.line);
    this.shipPrev = this.ship.position.clone();
    // Beacon: a glow of fixed screen size, so the ship stays findable from the far overview.
    this.beacon = glowSprite(COL.engine, 0.045, 0.9);
    this.beacon.material.sizeAttenuation = false;
    this.root.add(this.beacon);
    this.shipTag = makeLabel('Claude', '#bff3ff', 'agent-tag');
    this.shipTag.userData = { always: true };
    this.root.add(this.shipTag);
    this.labels.push(this.shipTag);
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
    this.scouts.sync(model);
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

  scanBeam(rec, color, seconds = 2.4, from = this.ship) {
    const geo = new THREE.ConeGeometry(1, 1, 32, 1, true);
    geo.translate(0, -0.5, 0);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const cone = new THREE.Mesh(geo, mat);
    const torus = new THREE.Mesh(new THREE.TorusGeometry(1, 0.035, 8, 96), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.root.add(cone, torus);
    this.anim.add(seconds, (k) => {
      const fade = Math.min(1, k * 5) * Math.min(1, (1 - k) * 4);
      cone.position.copy(from.position);
      cone.lookAt(rec.world);
      cone.scale.set(rec.size * 1.1, rec.size * 1.1, from.position.distanceTo(rec.world));
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
      glow.material.opacity = 0.45 * fade;
      grp.rotation.set(0.5, 0, k * 14);
    }, () => { grp.removeFromParent(); geo.dispose(); mat.dispose(); glow.material.dispose(); });
  }

  onEvent(ev, meta) {
    // Subagent events are acted out by that subagent's scout ship; the main ship stays put.
    const scout = this.scouts.handle(ev, meta);
    if (ev.kind === 'agent_start' || ev.kind === 'agent_stop') return;
    const actor = scout ? scout.obj : this.ship;
    let rec = ev.file ? this.records.get(ev.file) : null;
    switch (ev.kind) {
      case 'prompt':
        this.ring(() => actor.position, COL.white, 2, 30, 1.4);
        break;
      case 'read':
        if (!rec) break;
        if (!scout) this.flyTo(ev.file);
        this.boost(rec, COL.read, 0.8, 2.6);
        this.anim.add(0.7, () => {}, () => this.scanBeam(rec, COL.read, 2.4, actor));
        break;
      case 'search':
        this.ring(() => actor.position, COL.search, 3, scout ? 45 : 90, 2, true);
        break;
      case 'edit':
        if (!rec) break;
        if (!scout) this.flyTo(ev.file);
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
        if (!scout) this.flyTo(ev.file);
        r.scale = 0;
        this.accretion(r, COL.create);
        this.anim.add(2.4, (k) => { r.scale = ease.outBack(Math.max(0, (k - 0.25) / 0.75)); });
        this.boost(r, COL.create, 1, 4);
        this.anim.add(1.4, () => {}, () => this.ring(() => r.world, COL.create, r.size * 2, r.size * 9, 1.4));
        break;
      }
      case 'bash':
        this.flash(COL.bash, actor);
        break;
      case 'bash_result':
        if (!ev.ok) this.flash(COL.fail, actor);
        break;
      case 'test_result':
        this.pulsar(this.testAnchor(), ev.ok ? COL.ok : COL.fail);
        for (const r of this.records.values()) if (r.sys.fk > 0.5) this.boost(r, COL.ok, ev.ok ? 0.35 : 0.2, 2);
        for (const id of meta.failing || []) {
          const fr = this.records.get(id);
          if (fr) this.anim.add(0.8, () => {}, () => this.boost(fr, COL.fail, 1, 4));
        }
        break;
      case 'idle':
        this.shipTarget = null; // background subagents may keep working, so scouts stay
        break;
      default:
        break;
    }
  }

  flash(color, ship = this.ship) {
    const f = ship.userData.flame;
    const back = ship.userData.engineColor || COL.engine;
    this.anim.add(1.4, (k) => { f.material.color.copy(color).lerp(back, k); f.scale.setScalar(2.4 + 3 * (1 - k)); });
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
    this.timeU.value = t;
    const model = this.model;
    const hoverId = this.engine.hoverId;
    // Focus mode (big projects): solar systems Claude is not working in shrink to small dim stars.
    if (model.large) {
      if (!this.focusSet || (this.focusTick = (this.focusTick || 0) + dt) > 0.25) { this.focusTick = 0; this.focusSet = model.focusModules(); }
      for (const sys of this.systems.values()) {
        const want = this.focusSet.has(sys.name) ? 1 : 0;
        if (sys.fk === want) continue;
        sys.fk = want > sys.fk ? Math.min(1, sys.fk + dt * 1.5) : Math.max(0, sys.fk - dt * 0.8);
        sys.group.scale.setScalar(0.35 + 0.65 * ease.outCubic(sys.fk));
      }
    }
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
      rec.ring.material.opacity = (hoverId === rec.id || rec.boost > 0.2 ? 0.3 : 0.07) * (0.25 + 0.75 * rec.sys.fk);
    }
    for (const sys of this.systems.values()) sys.glow.material.opacity = (0.6 + Math.sin(t * 0.8 + sys.pos.x) * 0.06) * (0.45 + 0.55 * sys.fk);

    const goal = this.shipTarget
      ? this.shipTarget()
      : this.shipGoal.set(Math.cos(t * 0.05) * this.galaxyR * 0.32, 22 + Math.sin(t * 0.3) * 4, Math.sin(t * 0.05) * this.galaxyR * 0.32);
    this.steer(this.ship, goal, this.shipPrev, dt, 1.6);
    this.ship.userData.flame.material.opacity = 0.8 + Math.sin(t * 30) * 0.2;
    this.shipTrail.push(this.ship.position);
    // Ships keep a readable size on screen: a 3-unit ship in a 1000-unit galaxy is otherwise sub-pixel.
    const cam = this.engine.camera.position;
    const shipScale = (obj, base) => obj.scale.setScalar(Math.max(base, cam.distanceTo(obj.position) * 0.018 * base));
    shipScale(this.ship, 1.1);
    for (const s of this.scouts.map.values()) shipScale(s.obj, 0.85);
    this.beacon.position.copy(this.ship.position);
    this.shipTag.position.copy(this.ship.position).y += 3 * this.ship.scale.y;

    this.scouts.update(dt, t);

    if ((this.labelTick = (this.labelTick || 0) + dt) > 0.25) {
      this.labelTick = 0;
      const active = this.focusSet || new Set();
      if (this.grouped) {
        const cam = this.engine.camera.position;
        const far = cam.distanceTo(this.engine.controls.target) > this.galaxyR * 0.7;
        for (const l of this.labels) {
          if (l.userData.always) l.visible = true;
          else if (l.userData.top) l.visible = far;
          else l.visible = !far && (active.has(l.userData.module) || cam.distanceTo(l.position) < this.galaxyR * 0.45);
        }
      }
      else for (const l of this.labels) l.visible = true; // small project: every label, minus overlaps
      for (const tag of this.scouts.tags) tag.visible = true;
      // Claude first, then subagent tags (they collapse to dots), then folders and modules
      const rank = (l) => (l.userData.always ? 4 : l.userData.scout ? 3 : l.userData.top ? 2 : active.has(l.userData.module) ? 1 : 0);
      declutterLabels([...this.labels, ...this.scouts.tags].sort((a, b) => rank(b) - rank(a)), this.engine.camera, this.engine.container.clientWidth, this.engine.container.clientHeight);
    }
    this.sky.position.copy(this.engine.camera.position);
    this.arms.rotation.y += dt * 0.006;
    this.disc.rotation.z += dt * 0.004; // the disc turns slowly with the arms
    this.stars.rotation.y += dt * 0.0015;
  }

  dispose() {
    this.anim.clear();
    this.scouts?.dispose();
    for (const l of this.labels) l.removeFromParent();
    disposeTree(this.root);
  }
}
