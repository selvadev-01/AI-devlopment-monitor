// Shared visual helpers: procedural textures, tiny tween system, labels, hashing.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export const KIND_COLORS = {
  read: '#3fd4ff', search: '#8d9bff', edit: '#ffb547', create: '#3ddc84', bash: '#c38bff',
  ok: '#3ddc84', fail: '#ff5a5f', agent: '#ff5fd2', prompt: '#e4e8ef',
};
// Ten clearly different hues, so ten parallel subagents never share a colour.
export const AGENT_COLORS = ['#ffb547', '#ff5fd2', '#3fd4ff', '#9be15d', '#a07bff', '#ff6b5e', '#2ee6c5', '#f4e04d', '#5b8cff', '#ff9fd8'];

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}
export function rng(seed) {
  let s = Math.floor(seed * 2 ** 31) || 1;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

export const ease = {
  outCubic: (k) => 1 - (1 - k) ** 3,
  inOutCubic: (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2),
  outBack: (k) => { const c = 1.70158; return 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2; },
};

const texCache = new Map();
function canvasTexture(key, size, draw) {
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, t);
  return t;
}

export const glowTexture = () => canvasTexture('glow', 128, (g, s) => {
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.18, 'rgba(255,255,255,0.75)');
  r.addColorStop(0.45, 'rgba(255,255,255,0.16)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, s, s);
});

/** Solid round dot with a soft edge: keeps point particles round (not square) up close. */
export const dotTexture = () => canvasTexture('dot', 64, (g, s) => {
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.55, 'rgba(255,255,255,0.9)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, s, s);
});

export const ringTexture = () => canvasTexture('ring', 256, (g, s) => {
  const r = g.createRadialGradient(s / 2, s / 2, s * 0.36, s / 2, s / 2, s / 2);
  r.addColorStop(0, 'rgba(255,255,255,0)');
  r.addColorStop(0.55, 'rgba(255,255,255,0.95)');
  r.addColorStop(0.7, 'rgba(255,255,255,0.25)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, s, s);
});

/**
 * Tiling detail for big textured surfaces seen up close (the galaxy disc): R and G are two
 * seamless fractal noises with mean ~0.5, B is sparse star specks. Mipmaps average it to a flat
 * grey far away, so it only adds structure where the base texture runs out of pixels.
 */
export function dustTexture() {
  const key = 'dust';
  if (texCache.has(key)) return texCache.get(key);
  const S = 512;
  const noise = (seed) => {
    const out = new Float32Array(S * S);
    let amp = 0.5; let total = 0;
    for (const cells of [4, 8, 16, 32, 64]) {
      const r = rng(seed + cells * 0.013);
      const grid = Float32Array.from({ length: cells * cells }, r);
      const at = (x, y) => grid[(y % cells) * cells + (x % cells)];
      const step = S / cells;
      for (let y = 0; y < S; y++) {
        const gy = y / step; const y0 = Math.floor(gy); const fy = gy - y0; const sy = fy * fy * (3 - 2 * fy);
        for (let x = 0; x < S; x++) {
          const gx = x / step; const x0 = Math.floor(gx); const fx = gx - x0; const sx = fx * fx * (3 - 2 * fx);
          const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
          const bot = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
          out[y * S + x] += (top + (bot - top) * sy) * amp;
        }
      }
      total += amp; amp *= 0.55;
    }
    for (let i = 0; i < out.length; i++) out[i] /= total;
    return out;
  };
  const a = noise(0.21); const b = noise(0.67);
  const specks = new Float32Array(S * S);
  const r = rng(0.93);
  const put = (x, y, v) => { const i = ((y + S) % S) * S + ((x + S) % S); specks[i] = Math.max(specks[i], v); };
  for (let i = 0; i < 2600; i++) {
    const x = Math.floor(r() * S); const y = Math.floor(r() * S); const v = 0.35 + r() * 0.65;
    put(x, y, v);
    if (v > 0.8) { put(x + 1, y, v * 0.35); put(x - 1, y, v * 0.35); put(x, y + 1, v * 0.35); put(x, y - 1, v * 0.35); }
  }
  const img = new ImageData(S, S);
  // stretch the noise contrast around 0.5 so the detail is visible, then clamp
  const k = (v) => Math.max(0, Math.min(255, Math.round((0.5 + (v - 0.5) * 2.2) * 255)));
  for (let i = 0; i < S * S; i++) img.data.set([k(a[i]), k(b[i]), Math.round(specks[i] * 255), 255], i * 4);
  const c = document.createElement('canvas');
  c.width = c.height = S;
  c.getContext('2d').putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  texCache.set(key, t);
  return t;
}

export const nebulaTexture = (seed = 1) => canvasTexture('nebula' + seed, 256, (g, s) => {
  const rand = rng(seed * 0.37 + 0.11);
  for (let i = 0; i < 26; i++) {
    const x = s / 2 + (rand() - 0.5) * s * 0.55;
    const y = s / 2 + (rand() - 0.5) * s * 0.55;
    const rad = s * (0.12 + rand() * 0.3);
    const r = g.createRadialGradient(x, y, 0, x, y, rad);
    r.addColorStop(0, `rgba(255,255,255,${0.05 + rand() * 0.07})`);
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, s, s);
  }
});

/** Texture from web/textures/<name>.jpg (generated locally with ComfyUI), cached and wrap-repeating. */
const loader = new THREE.TextureLoader();
export function loadTex(name, { color = true } = {}) {
  const key = 'file:' + name;
  if (texCache.has(key)) return texCache.get(key);
  const t = loader.load(`/textures/${name}.jpg`);
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

/** Large inside-out sphere showing an equirectangular panorama behind the scene. */
export function skySphere(name, radius, tint = 0xffffff) {
  const mat = new THREE.MeshBasicMaterial({ map: loadTex(name), side: THREE.BackSide, depthWrite: false, fog: false, color: tint });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
  mesh.renderOrder = -1;
  return mesh;
}

export function glowSprite(color, size, opacity = 1) {
  const m = new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(size);
  return s;
}

export function starfield(count, radius, spread = 0.6) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const rand = rng(0.42);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1; const th = rand() * Math.PI * 2;
    const r = radius * (1 - spread + rand() * spread);
    const s = Math.sqrt(1 - u * u);
    pos.set([r * s * Math.cos(th), r * u, r * s * Math.sin(th)], i * 3);
    c.setHSL(0.55 + rand() * 0.15, 0.4, 0.55 + rand() * 0.4);
    col.set([c.r, c.g, c.b], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, map: glowTexture(), vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending });
  return new THREE.Points(geo, mat);
}

export function makeLabel(text, color, className = 'module-label') {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  el.style.setProperty('--c', color);
  return new CSS2DObject(el);
}

/** Minimal tween runner: add(duration, onUpdate(k), onDone). */
export class Animator {
  constructor() { this.items = []; }
  add(dur, fn, done) { const it = { t: 0, dur, fn, done }; this.items.push(it); return it; }
  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      const k = Math.min(1, it.t / it.dur);
      it.fn(k);
      if (k >= 1) { this.items.splice(i, 1); it.done?.(); }
    }
  }
  clear() { this.items.length = 0; }
}

function isCached(tex) { for (const t of texCache.values()) if (t === tex) return true; return false; }

export function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { if (m.map && !isCached(m.map)) m.map.dispose(); m.dispose(); }
  });
}

const _v = new THREE.Vector3();
/**
 * Keep labels from overlapping on screen. Labels earlier in the list win, so callers put the
 * important ones first. A label that loses is hidden, or, if it has userData.collapse (subagent
 * tags), shrinks to a coloured dot instead so the agent stays visible.
 */
export function declutterLabels(labels, camera, width, height) {
  const boxes = [];
  const hits = (x, y, w, h) => boxes.some((b) => Math.abs(b.x - x) < b.w + w && Math.abs(b.y - y) < b.h + h);
  for (const l of labels) {
    if (!l.visible) continue;
    const collapse = l.userData?.collapse;
    if (collapse) l.element.classList.remove('mini');
    l.getWorldPosition(_v).project(camera);
    if (_v.z > 1) continue;
    const x = (_v.x * 0.5 + 0.5) * width; const y = (-_v.y * 0.5 + 0.5) * height;
    const w = (l.element.textContent.length * (collapse ? 7 : 8.6) + 20) / 2; const h = 12;
    if (hits(x, y, w, h)) {
      if (!collapse) { l.visible = false; continue; }
      // still crowded as a dot (it would sit on another label): hide the tag, the ship stays visible
      if (hits(x, y, 6, 6)) { l.visible = false; continue; }
      l.element.classList.add('mini');
      boxes.push({ x, y, w: 6, h: 6 });
      continue;
    }
    boxes.push({ x, y, w, h });
  }
}
