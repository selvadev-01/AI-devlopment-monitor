// Renderer, camera, post-processing and theme switching. Themes only draw; the engine
// owns the camera (auto-follow), the floating callout and hover picking.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { NeuralTheme } from './themes/neural.js';
import { GalaxyTheme } from './themes/galaxy.js';
import { KIND_COLORS } from './fx.js';

export const THEMES = { neural: NeuralTheme, galaxy: GalaxyTheme };
const QUALITY = {
  low: { pixelRatio: 1, msaa: 0, shadows: false, ao: false, fps: { active: 30, idle: 10 } },
  balanced: { pixelRatio: 1.5, msaa: 4, shadows: true, ao: false, fps: { active: 60, idle: 20 } },
  high: { pixelRatio: 2, msaa: 4, shadows: true, ao: true, fps: { active: 60, idle: 30 } },
};
const IDLE_AFTER_MS = 6000; // no events, input or camera moves for this long = idle frame rate
const FOCUS_SECONDS = 7;
const USER_HOLD_SECONDS = 8;
const CALLOUT_SECONDS = 5;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Engine {
  constructor(container, model, { onHover, onOpen, quality = 'balanced' } = {}) {
    this.container = container;
    this.model = model;
    this.onHover = onHover;
    this.onOpen = onOpen; // double-click a file: open it in the editor
    // low: no shadows/AO/MSAA, 30 fps; balanced: shadows + MSAA, 60 fps; high: + ambient occlusion.
    this.quality = QUALITY[quality] ? quality : 'balanced';
    const Q = QUALITY[this.quality];
    this.fps = Q.fps;
    this.lastRender = 0;
    this.lastActivity = performance.now();
    this.themeName = null;
    this.theme = null;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, Q.pixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = Q.shadows; // only used by themes with castShadow lights
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.prepend(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'css2d';
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 6000);
    this.camera.position.set(0, 60, 180);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.autoRotate = !this.reducedMotion;
    this.controls.autoRotateSpeed = 0.3;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 2500;
    this.controls.addEventListener('start', () => { this.userHoldUntil = this.now + USER_HOLD_SECONDS; this.markActive(); });

    // MSAA render target: the renderer's own antialias does not apply inside the composer.
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: Q.msaa });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Ambient occlusion (soft contact shadows), switched on by themes that set `ao: true`.
    this.ao = new GTAOPass(this.scene, this.camera, 1, 1);
    this.ao.enabled = false;
    this.composer.addPass(this.ao);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.0, 0.55, 0.1);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    const el = document.createElement('div');
    el.className = 'callout hidden';
    this.calloutEl = el;
    this.callout = new CSS2DObject(el);
    this.scene.add(this.callout);
    this.calloutAnchor = null;
    this.calloutUntil = 0;

    this.now = 0;
    this.focusAnchor = null;
    this.focusDistance = 60;
    this.focusUntil = 0;
    this.userHoldUntil = 0;
    this.homeDistance = 180;
    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pointerPx = { x: 0, y: 0 };
    this.pointerActive = false;
    this.hoverId = null;
    this.tmp = new THREE.Vector3();
    this.origin = new THREE.Vector3();

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.pointerPx = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.pointerActive = true;
      this.markActive();
    });
    canvas.addEventListener('wheel', () => this.markActive(), { passive: true });
    canvas.addEventListener('pointerleave', () => { this.pointerActive = false; this.setHover(null); });
    // Click a file to fly to it; double-click to open it in the editor. A drag (orbit) is not a click.
    let downAt = null;
    canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('click', (e) => {
      const still = downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5;
      if (still && this.hoverId) this.focusFile(this.hoverId);
    });
    canvas.addEventListener('dblclick', () => { if (this.hoverId) this.onOpen?.(this.hoverId); });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
    // Stop rendering entirely while the panel/tab is hidden; resume when it is shown again.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.renderer.setAnimationLoop(null);
      else { this.clock.getDelta(); this.markActive(); this.renderer.setAnimationLoop(() => this.frame()); }
    });
  }

  resize() {
    const w = this.container.clientWidth || 1; const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.labels.setSize(w, h);
  }

  setTheme(name) {
    if (!THEMES[name]) name = 'neural';
    if (this.theme) { this.theme.dispose(); this.scene.remove(this.theme.root); }
    this.themeName = name;
    this.theme = new THEMES[name](this);
    this.scene.add(this.theme.root);
    this.theme.build(this.model);
    const b = this.theme.bloom;
    this.bloom.strength = b.strength; this.bloom.radius = b.radius; this.bloom.threshold = b.threshold;
    this.scene.fog = this.theme.fog || null;
    this.scene.environment = this.theme.environment || null; // reflections for metal themes
    this.controls.maxPolarAngle = this.theme.maxPolar ?? Math.PI; // e.g. galaxy never goes edge-on
    this.ao.enabled = Boolean(this.theme.ao) && QUALITY[this.quality].ao;
    this.scene.environmentIntensity = this.theme.envIntensity ?? 1;
    this.home();
    this.hideCallout();
  }

  rebuild() { if (this.themeName) this.setTheme(this.themeName); }
  sync() { this.theme?.sync(this.model); }

  home() {
    const h = this.theme.home;
    this.focusAnchor = null;
    this.camera.position.copy(h.position);
    this.controls.target.set(0, 0, 0);
    this.homeDistance = h.position.length();
  }

  /** True when the project has a tests module to fly to (otherwise test runs show the overview). */
  /**
   * Overview distance: the theme's home distance, pulled back while subagents fly outside that
   * view, so every running agent stays in frame (at most twice the home distance).
   */
  overviewDistance() {
    const scouts = this.theme.scouts?.map;
    if (!scouts?.size) return this.homeDistance;
    const halfV = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const half = Math.min(halfV, Math.atan(Math.tan(halfV) * this.camera.aspect));
    let r = 0;
    for (const s of scouts.values()) r = Math.max(r, s.obj.position.distanceTo(this.controls.target));
    return Math.min(this.homeDistance * 2, Math.max(this.homeDistance, (r / Math.sin(half)) * 1.1));
  }

  hasTestArea() { return this.theme.testAnchor().lengthSq() > 1; }

  overview() { this.focusAnchor = null; this.focusUntil = 0; this.userHoldUntil = 0; }

  focus(anchorFn, distance, seconds = FOCUS_SECONDS) {
    this.focusAnchor = anchorFn;
    this.focusDistance = distance;
    this.focusUntil = this.now + seconds;
    this.userHoldUntil = 0;
  }

  focusFile(id) {
    if (!this.theme?.positionOf(id)) return;
    this.focus(() => this.theme.positionOf(id), this.theme.focusDistance, 12);
    const n = this.model.nodes.get(id);
    this.showCallout(() => this.theme.positionOf(id), this.model.colorFor(id),
      `<b>FILE</b>${esc(n?.name)}<span class="sub">${esc(id)} · ${n?.loc ?? 0} lines · ${this.model.dependentsOf(id).length} dependents</span>`, 8);
  }

  focusModule(name) {
    if (!this.theme?.moduleCenter(name)) return;
    this.focus(() => this.theme.moduleCenter(name), this.theme.focusDistance * 2.2, 12);
  }

  showCallout(anchorFn, color, html, seconds = CALLOUT_SECONDS) {
    this.calloutAnchor = anchorFn;
    this.calloutEl.innerHTML = html;
    this.calloutEl.style.setProperty('--c', color);
    this.calloutEl.classList.remove('hidden');
    this.calloutUntil = this.now + seconds;
  }
  hideCallout() { this.calloutEl.classList.add('hidden'); this.calloutAnchor = null; }

  handleEvent(ev, meta) {
    if (!this.theme) return;
    this.markActive();
    this.theme.onEvent(ev, meta);
    // Subagents can run in parallel: their scouts carry live tags instead of moving the camera.
    if (ev.agent) return;
    const t = this.theme;
    const hasFile = Boolean(ev.file && t.positionOf(ev.file));
    const fileAnchor = () => t.positionOf(ev.file);
    const agentAnchor = () => t.agentPosition();
    const diff = ev.stats && (ev.kind === 'edit' || ev.kind === 'create')
      ? `<span class="diff"><span class="a">+${ev.stats.added}</span><span class="r">−${ev.stats.removed}</span></span>` : '';
    const name = ev.file ? ev.file.split('/').pop() : '';

    switch (ev.kind) {
      case 'read':
        if (hasFile) {
          this.focus(fileAnchor, t.focusDistance);
          this.showCallout(fileAnchor, KIND_COLORS.read, `<b>READ</b>${esc(name)}<span class="sub">${esc(ev.file)}</span>`);
        }
        break;
      case 'edit':
        if (hasFile) {
          this.focus(fileAnchor, t.focusDistance * 1.25);
          const n = meta.dependents?.length || 0;
          this.showCallout(fileAnchor, KIND_COLORS.edit,
            `<b>EDIT</b>${esc(name)}${diff}<span class="sub">${n ? `${n} dependent${n > 1 ? 's' : ''} affected` : esc(ev.file)}</span>`);
        }
        break;
      case 'create':
        if (hasFile) {
          this.focus(fileAnchor, t.focusDistance * 1.2);
          this.showCallout(fileAnchor, KIND_COLORS.create, `<b>CREATE</b>${esc(name)}${diff}<span class="sub">new file · ${esc(ev.file)}</span>`);
        }
        break;
      case 'search':
        this.showCallout(agentAnchor, KIND_COLORS.search, `<b>SEARCH</b>${esc(ev.detail.replace(/^(Grep|Glob)\s*/, ''))}`, 3);
        break;
      case 'bash':
        this.showCallout(agentAnchor, KIND_COLORS.bash, `<b>${ev.isTest ? 'TEST' : 'BASH'}</b>${esc(ev.detail)}`, ev.isTest ? 8 : 3.5);
        if (ev.isTest && this.hasTestArea()) this.focus(() => t.testAnchor(), t.focusDistance * 2.4, 9);
        break;
      case 'test_result': {
        const c = ev.ok ? KIND_COLORS.ok : KIND_COLORS.fail;
        if (this.hasTestArea()) this.focus(() => t.testAnchor(), t.focusDistance * 2.4, 7);
        else this.overview();
        this.showCallout(() => t.testAnchor(), c,
          `<b>TESTS</b>${esc(ev.detail)}${meta.failing?.length ? `<span class="sub">${esc(meta.failing.join(', '))}</span>` : ''}`, 7);
        break;
      }
      case 'agent_start':
        this.showCallout(agentAnchor, KIND_COLORS.agent, `<b>SUBAGENT</b>${esc(ev.detail)}<span class="sub">${esc(ev.agentType || '')}</span>`, 4);
        break;
      case 'idle':
        this.overview();
        this.hideCallout();
        break;
      default:
        break;
    }
  }

  setHover(id) {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.onHover?.(id, this.pointerPx);
  }

  markActive() { this.lastActivity = performance.now(); }

  frame() {
    // Frame-rate cap: full rate while something is happening, a low rate when idle.
    const ms = performance.now();
    const focusing = this.focusAnchor && this.now < this.focusUntil;
    const idle = !focusing && ms - this.lastActivity > IDLE_AFTER_MS;
    if (ms - this.lastRender < 1000 / (idle ? this.fps.idle : this.fps.active) - 2) return;
    this.lastRender = ms;
    const dt = Math.min(this.clock.getDelta(), 0.12);
    this.now += dt;
    const t = this.theme;
    if (!t) return;
    t.update(dt, this.now);

    // camera follow
    const following = this.focusAnchor && this.now < this.focusUntil && this.now > this.userHoldUntil;
    if (following) {
      const p = this.focusAnchor();
      if (p) {
        this.controls.target.lerp(p, 1 - Math.exp(-dt * 2.6));
        const dir = this.tmp.copy(this.camera.position).sub(this.controls.target).normalize();
        const desired = dir.multiplyScalar(this.focusDistance).add(this.controls.target);
        this.camera.position.lerp(desired, 1 - Math.exp(-dt * 1.4));
      }
    } else if (this.now > this.userHoldUntil && this.now > this.focusUntil) {
      const a = 1 - Math.exp(-dt * 0.7);
      this.controls.target.lerp(this.origin, a);
      const want = this.overviewDistance();
      const d = this.camera.position.distanceTo(this.controls.target);
      if (Math.abs(d - want) > 1) {
        const dir = this.tmp.copy(this.camera.position).sub(this.controls.target).normalize();
        this.camera.position.copy(this.controls.target).add(dir.multiplyScalar(d + (want - d) * a));
      }
    }
    this.controls.autoRotate = !this.reducedMotion && !following;

    // callout follows its anchor (planets move)
    if (this.calloutAnchor) {
      const p = this.calloutAnchor();
      if (p) this.callout.position.copy(p);
      if (this.now > this.calloutUntil) this.hideCallout();
    }

    // hover picking, every other frame
    this._pickTick = !this._pickTick;
    if (this.pointerActive && this._pickTick) {
      this.raycaster.setFromCamera(this.pointer, this.camera);
      this.setHover(t.pick(this.raycaster));
    }

    this.controls.update();
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }
}
