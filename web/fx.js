// Shared visual helpers: procedural textures, tiny tween system, labels, hashing.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export const KIND_COLORS = {
  read: '#3fd4ff', search: '#8d9bff', edit: '#ffb547', create: '#3ddc84', bash: '#c38bff',
  ok: '#3ddc84', fail: '#ff5a5f', agent: '#ff5fd2', prompt: '#e4e8ef',
};
export const AGENT_COLORS = ['#ffb547', '#ff5fd2', '#3fd4ff', '#9be15d', '#a07bff'];

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

export const ringTexture = () => canvasTexture('ring', 256, (g, s) => {
  const r = g.createRadialGradient(s / 2, s / 2, s * 0.36, s / 2, s / 2, s / 2);
  r.addColorStop(0, 'rgba(255,255,255,0)');
  r.addColorStop(0.55, 'rgba(255,255,255,0.95)');
  r.addColorStop(0.7, 'rgba(255,255,255,0.25)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, s, s);
});

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
