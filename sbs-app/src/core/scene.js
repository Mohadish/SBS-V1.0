/**
 * SBS Step Browser — Scene Core
 * ================================
 * Owns the Three.js renderer, camera, scene graph, lighting,
 * grid/axes helpers, and the custom CAD orbit controls.
 *
 * Usage:
 *   import scene from './core/scene.js';
 *   scene.init(document.getElementById('viewer'), { backgroundColor: '#0f172a' });
 *   scene.startLoop();
 *
 * External modules add objects to `scene.rootGroup` (for scene content)
 * or `scene.overlayScene` (for gizmos / transform handles drawn on top).
 *
 * The camera fill-light follows the camera position so it always
 * illuminates front-facing surfaces regardless of view angle.
 *
 * Canonical-camera framing
 * ------------------------
 * The canvas backing buffer is ALWAYS sized to the project's canonical
 * export resolution (state.export.width × height) at pixelRatio=1, and
 * the camera always projects at canonical aspect — never the viewer's
 * aspect. The canvas's CSS box is letterboxed to canonical aspect inside
 * the container so live viewport == safe-frame == export output, byte
 * for byte, regardless of window size, OS scaling, browser/Electron
 * zoom, or which machine the project is opened on. Black bars in the
 * live preview when window aspect ≠ canonical aspect are intentional
 * — same as any DCC tool with a render-frame.
 */

import { getCanonicalSize, computeSafeFrameRect } from './safe-frame.js';
import * as clock from './clock.js';
// V0.2.22.21 — combined silhouette outline pass. Runs after the main
// scene render to composite a single outline around the union of
// selected meshes.
import { initOutlinePass, resizeOutlinePass, renderOutlinePass } from '../systems/outline-pass.js';
// V0.3.0.1 — ambient occlusion via N8AO through a minimal EffectComposer.
// These addons resolve bare `three` to the global-THREE proxy via the import
// map in index.html. Wired as an opt-in pass; falls back to direct render.
import { EffectComposer } from '../../vendor/three-addons/postprocessing/EffectComposer.js';
import { RenderPass }     from '../../vendor/three-addons/postprocessing/RenderPass.js';
import { N8AOPass }       from '../../vendor/three-addons/N8AO.js';
import { SSRReflectPass } from '../../vendor/three-addons/SSRReflectPass.js';
import { PlanarMirror }   from './planar-mirror.js';

// ── Mini event emitter (no dependency on state.js) ────────────────────────
class Emitter {
  constructor() { this._map = new Map(); }
  on(ev, fn) {
    if (!this._map.has(ev)) this._map.set(ev, new Set());
    this._map.get(ev).add(fn);
    return () => this._map.get(ev)?.delete(fn);
  }
  off(ev, fn) { this._map.get(ev)?.delete(fn); }
  emit(ev, ...a) { this._map.get(ev)?.forEach(fn => { try { fn(...a); } catch(e) { console.error(e); } }); }
}

// ── Easing helpers ────────────────────────────────────────────────────────
const ease = {
  linear:  t => t,
  smooth:  t => t * t * (3 - 2 * t),          // smoothstep
  smootherStep: t => t * t * t * (t * (t * 6 - 15) + 10),
};

// ── SceneCore class ───────────────────────────────────────────────────────
export class SceneCore extends Emitter {
  constructor() {
    super();

    // Three.js objects
    this.renderer     = null;
    this.camera       = null;
    this.scene        = null;
    this.overlayScene = null;  // gizmos / transform controls overlay
    this.rootGroup    = null;  // all imported model objects live here
    this.raycaster    = new THREE.Raycaster();
    this.pointer      = new THREE.Vector2();

    // Helpers
    this.gridHelper   = null;
    this.axesHelper   = null;

    // Lights
    this.hemiLight    = null;
    this.dirLight     = null;
    this.fillLight    = null;  // optional camera-tracking fill light

    // Custom orbit controls state
    this.controls     = null;

    // Camera transition state
    this._transition  = null;

    // Animation loop
    this._rafId       = null;
    this._loopRunning = false;

    // Controls locked (e.g. during deterministic export)
    this._locked      = false;

    // Per-frame hook — external systems register here
    // fn(nowMs, deltaMs) — called once per animation frame before render
    this._tickHooks   = new Set();

    // DOM container
    this._container   = null;
    this._resizeObs   = null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Initialise Three.js and attach the canvas to `container`.
   * Call this once, after the DOM is ready.
   *
   * @param {HTMLElement} container  The #viewer div
   * @param {object}      opts       { backgroundColor, gridVisible, fov }
   */
  init(container, opts = {}) {
    const {
      backgroundColor = '#0f172a',
      gridVisible     = true,
      fov             = 45,
    } = opts;

    this._container = container;

    // ── Renderer ────────────────────────────────────────────────────────
    // pixelRatio is forced to 1 so the canvas backing buffer matches
    // canonical W×H exactly. With native devicePixelRatio (often
    // fractional under OS scaling / browser zoom / Electron zoom), the
    // buffer would be floor(W × PR) — a different size on every machine,
    // breaking cross-machine portability of the export.
    this.renderer = new THREE.WebGLRenderer({
      antialias:             true,
      preserveDrawingBuffer: true,   // required for export / thumbnails
    });
    this.renderer.setPixelRatio(1);
    container.appendChild(this.renderer.domElement);

    // Pin the WebGL canvas's drawingBufferColorSpace to plain sRGB.
    // Without this, Chromium auto-detects the display's wider colour
    // capability (P3 / Rec2020 / HDR-aware) and tags the compositor
    // swap chain accordingly — which then maps SDR-tagged DOM siblings
    // (sidebar / panels) to ~75% of peak luminance (RGB 255 → 190 cap).
    // Voice-over / context-menus / modals escape that cap because
    // backdrop-filter / stacking-context promotes them off the
    // affected compositor layer. Pinning to srgb makes the canvas's
    // colour space match the rest of the page, so Chromium keeps the
    // compositor in plain sRGB and DOM whites render at full 255.
    // Diagnosed by the user via canvas-removal test:
    //   document.querySelectorAll('canvas').forEach(c=>c.remove())
    //   → sidebar instantly snapped from RGB 190 to RGB 255.
    try {
      const gl = this.renderer.getContext();
      if (gl && 'drawingBufferColorSpace' in gl) gl.drawingBufferColorSpace = 'srgb';
    } catch {}
    if ('SRGBColorSpace' in THREE) this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // ── Scenes ──────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(backgroundColor);

    this.overlayScene = new THREE.Scene();  // drawn on top, depth-cleared

    // ── Camera ──────────────────────────────────────────────────────────
    // Aspect is set inside fitToCanonical() once everything is wired —
    // we only need a placeholder here so the constructor doesn't fail.
    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 1_000_000);
    this.camera.position.set(220, 180, 260);
    this.camera.lookAt(0, 0, 0);

    // ── Scene root group (models live inside here) ───────────────────────
    this.rootGroup = new THREE.Group();
    this.scene.add(this.rootGroup);

    // ── Lighting ────────────────────────────────────────────────────────
    // Hemisphere for ambient sky/ground gradient
    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x223344, 1.2);
    this.scene.add(this.hemiLight);

    // Key directional light
    this.dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
    this.dirLight.position.set(180, 240, 120);
    this.scene.add(this.dirLight);

    // Fill light (camera-tracking, initially disabled — added to scene
    // but intensity is 0 until explicitly enabled)
    this.fillLight = new THREE.PointLight(0xffffff, 0, 0, 2);
    this.scene.add(this.fillLight);

    // ── Grid & axes ─────────────────────────────────────────────────────
    this.gridHelper = new THREE.GridHelper(400, 20, 0x334155, 0x1e293b);
    this.gridHelper.position.y = -40;
    this.gridHelper.visible = gridVisible;
    this.scene.add(this.gridHelper);

    this.axesHelper = new THREE.AxesHelper(60);
    this.axesHelper.visible = gridVisible;
    this.scene.add(this.axesHelper);

    // ── Custom CAD orbit controls ────────────────────────────────────────
    this._initControls();

    // Initial fit — sizes the buffer + camera + canvas CSS letterbox.
    this.fitToCanonical();

    // ── Resize observer ─────────────────────────────────────────────────
    this._resizeObs = new ResizeObserver(() => this.fitToCanonical());
    this._resizeObs.observe(container);

    // ── Render-on-demand wake triggers ──────────────────────────────────
    // Any interaction wakes the loop for a short window; the per-frame camera
    // check + active-animation checks keep it alive while things move. When
    // none fire, the loop freezes the last frame (no AO shimmer, no GPU churn).
    // 'input'/'change' included so editing UI controls — color picker sliders,
    // shape & flexibility sliders, opacity, hex fields — drive the 3D viewport
    // in real time (they change the scene without moving the camera, so the
    // camera check alone wouldn't wake the loop). Konva overlays already render
    // independently, so they were never affected.
    const _wake = () => this.requestRender(800);
    for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'input', 'change']) {
      document.addEventListener(ev, _wake, { capture: true, passive: true });
    }
    if (typeof window !== 'undefined') {
      window.sbsRender = {
        freeze: (b) => { this._freezeWhenIdle = (b !== false); this.requestRender(0); },
        wake:   ()  => this.requestRender(0),
        thumbs: (b) => { this._thumbsOff = (b === false); console.log('[scene] thumbnail capture', b === false ? 'OFF' : 'ON'); },
      };
      // Adaptive near/far controls. on(false) → legacy fixed 0.1/1e6 planes (A/B).
      // set({nearFactor, farMargin, ratioCap}) — lower nearFactor pushes the near
      // plane closer (fixes close-up AO cutout) at a little precision cost.
      this._clipCfg = this._clipCfg || { enabled: true, nearFactor: 0.5, farMargin: 1.5, ratioCap: 50000 };
      window.sbsClip = {
        on:  (b) => { this._clipCfg.enabled = (b !== false); this.requestRender(300); console.log('[scene] adaptive clip', b !== false ? 'ON' : 'OFF'); },
        set: (o) => { Object.assign(this._clipCfg, o || {}); this.requestRender(300); },
        get: () => ({ near: this.camera && this.camera.near, far: this.camera && this.camera.far, cfg: { ...this._clipCfg } }),
      };
    }

    // ── V0.2.22.21 — initialise the outline pass ────────────────────────
    // Runs AFTER fitToCanonical so the canonical buffer size is known.
    const _c = getCanonicalSize();
    initOutlinePass(this.renderer, _c.width, _c.height);

    this.emit('init');
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  RENDER LOOP
  // ═══════════════════════════════════════════════════════════════════════
  startLoop() {
    if (this._loopRunning) return;
    this._loopRunning = true;
    let last = performance.now();

    const tick = (now) => {
      if (!this._loopRunning) return;
      this._rafId = requestAnimationFrame(tick);

      const delta = now - last;
      last = now;

      // Advance camera transition
      this._advanceTransition(now);

      // Update camera fill light position to track camera
      this._syncFillLight();

      // Render-on-demand: decide BEFORE the tick hooks so idle-aware hooks (the
      // thumbnail capture) can skip when the viewport is frozen. Freezing the
      // idle viewport stops the AO shimmer AND saves GPU. Kill-switch:
      // window.sbsRender.freeze(false).
      const shouldRender = this._shouldRender(now);
      this._idle = !shouldRender;

      // External tick hooks (animations, gizmos, notes rendering, etc.)
      this._tickHooks.forEach(fn => { try { fn(now, delta); } catch(e) { console.error(e); } });

      // Render only when something changed.
      if (shouldRender) this._render();
    };

    this._rafId = requestAnimationFrame(tick);
  }

  stopLoop() {
    this._loopRunning = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  // ── Render-on-demand ─────────────────────────────────────────────────────
  // The viewport redraws only when something changed: camera moved, a camera/
  // object animation is running, or an interaction requested it. When idle it
  // freezes the last frame → no AO shimmer + no idle GPU churn. Kill-switch:
  // window.sbsRender.freeze(false) forces continuous rendering.

  /** Ask the loop to render for the next `ms` milliseconds (0 = just next frame). */
  requestRender(ms = 0) {
    this._renderReqUntil = Math.max(this._renderReqUntil || 0, performance.now() + ms);
  }

  /** True when the loop is currently frozen (idle-aware hooks check this). */
  isIdle() { return this._idle === true; }

  /** Compact key of the camera pose — equality means "camera didn't move". */
  _camKey() {
    const c = this.camera; if (!c) return '';
    const p = c.position, q = c.quaternion;
    return p.x + ',' + p.y + ',' + p.z + ',' + q.x + ',' + q.y + ',' + q.z + ',' + q.w + ',' + c.zoom + ',' + c.fov;
  }

  _shouldRender(now) {
    if (this._freezeWhenIdle === false) return true;           // kill-switch
    const key    = this._camKey();
    const moved  = key !== this._lastCamKey;
    const active = !!this._transition || now < (this._renderReqUntil || 0);
    if (moved || active) { this._lastCamKey = key; this._settle = 4; return true; }
    if (this._settle > 0) { this._settle--; return true; }     // settle tail after motion
    return false;                                              // idle → freeze
  }

  /**
   * Render a single frame without the animation loop.
   * Used for export/thumbnail capture.
   */
  renderOnce() {
    this._syncFillLight();
    this._render();
  }

  /**
   * Grab the current viewport as a small data-URL thumbnail (JPEG).
   * Downscaled via an offscreen 2D canvas so storage stays tight.
   * Returns null if the renderer isn't ready.
   *
   * @param {number} w         target width in px  (default 120)
   * @param {number} h         target height in px (default 80)
   * @param {number} quality   JPEG quality 0..1   (default 0.55)
   * @returns {string|null}    data URL or null
   */
  /**
   * @param {number} w
   * @param {number} h
   * @param {number} quality
   * @param {{ withoutOverlayScene?: boolean,
   *           extraLayers?: (w:number, h:number) => Array<HTMLCanvasElement|null> }} [opts]
   *   - withoutOverlayScene: when true, force a fresh render of the main
   *     scene only (no gizmo / transform handles). The next regular _render
   *     restores the full picture in the same rAF tick — no live flicker.
   *   - extraLayers: optional fn returning canvases to composite on top of
   *     the 3D layer (e.g. the Konva text/image overlay). Each layer is
   *     drawn in order, scaled to (w,h).
   */
  captureThumbnail(w = 120, h = 80, quality = 0.55, opts = {}) {
    if (this._thumbsOff === true) return null;  // debug kill-switch (window.sbsRender.thumbs(false))
    // Backwards-compat: accept boolean as the old withoutOverlay flag.
    if (typeof opts === 'boolean') opts = { withoutOverlayScene: opts };

    const dom = this.renderer?.domElement;
    if (!dom || !dom.width || !dom.height) return null;

    let src = dom;   // default: read the live canvas as-is
    if (opts.withoutOverlayScene) {
      // Render scene-only to an OFFSCREEN target so this capture NEVER paints
      // onto the live canvas. Rendering to the live canvas (then reading it)
      // flashed a scene-only frame ~5×/sec during active periods — confirmed by
      // diagnostics: the blink rate equalled the thumbnail-capture rate. Down-
      // scaled 1/3 so the GPU→CPU readback stays cheap; matches canonical aspect.
      const W = dom.width, H = dom.height;
      const dw = Math.max(2, Math.round(W / 3)), dh = Math.max(2, Math.round(H / 3));
      let rt = this._thumbRT;
      if (!rt) {
        rt = this._thumbRT = new THREE.WebGLRenderTarget(dw, dh);
        // Match the live canvas's sRGB output, else readback pixels are linear → dark thumbs.
        if ('SRGBColorSpace' in THREE) rt.texture.colorSpace = THREE.SRGBColorSpace;
      } else if (rt.width !== dw || rt.height !== dh) rt.setSize(dw, dh);
      const prevRT = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(rt);
      this.renderer.autoClear = true;
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(prevRT);
      const buf = new Uint8Array(dw * dh * 4);
      this.renderer.readRenderTargetPixels(rt, 0, 0, dw, dh, buf);
      // WebGL pixels are bottom-up → flip rows into a 2D canvas we scale from.
      const sc = (this._thumbSrcCanvas = this._thumbSrcCanvas || document.createElement('canvas'));
      sc.width = dw; sc.height = dh;
      const sctx = sc.getContext('2d');
      const img = sctx.createImageData(dw, dh);
      const row = dw * 4;
      for (let y = 0; y < dh; y++) {
        const sOff = (dh - 1 - y) * row;
        img.data.set(buf.subarray(sOff, sOff + row), y * row);
      }
      sctx.putImageData(img, 0, 0);
      src = sc;
    }

    const off = document.createElement('canvas');
    off.width  = w;
    off.height = h;
    const ctx = off.getContext('2d');
    if (!ctx) return null;
    try {
      ctx.drawImage(src, 0, 0, w, h);
      if (typeof opts.extraLayers === 'function') {
        const layers = opts.extraLayers(w, h) || [];
        for (const layer of layers) {
          if (layer) ctx.drawImage(layer, 0, 0, w, h);
        }
      }
      return off.toDataURL('image/jpeg', quality);
    } catch (e) {
      return null;
    }
  }

  /**
   * Capture a thumbnail by REUSING the next main render instead of doing a
   * separate scene render. A separate render — even to an offscreen target —
   * perturbs the full-scene N8AO pass's GL state, so the next AO frame comes
   * back under-occluded (the "bright then AO builds" blink, at the capture
   * rate). Reusing the frame the loop already drew means zero extra GPU work
   * and nothing to disturb. _render() fulfils the request right after
   * composer.render() (scene+AO, before the outline + gizmo overlay), so the
   * grab is clean. Resolves with a JPEG data-URL, or null.
   *
   * @param {{ extraLayers?: (w:number,h:number)=>Array<HTMLCanvasElement|null> }} [opts]
   * @returns {Promise<string|null>}
   */
  requestThumbnail(w = 120, h = 80, quality = 0.55, opts = {}) {
    if (this._thumbsOff === true) return Promise.resolve(null);
    return new Promise((resolve) => {
      this._pendingThumb = { w, h, quality, opts, resolve };
    });
  }

  /** Read the just-rendered live canvas into a downscaled JPEG (no re-render). */
  _grabCanvasThumb(w, h, quality, opts) {
    const dom = this.renderer?.domElement;
    if (!dom || !dom.width || !dom.height) return null;
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const ctx = off.getContext('2d');
    if (!ctx) return null;
    try {
      ctx.drawImage(dom, 0, 0, w, h);
      if (typeof opts.extraLayers === 'function') {
        const layers = opts.extraLayers(w, h) || [];
        for (const layer of layers) { if (layer) ctx.drawImage(layer, 0, 0, w, h); }
      }
      return off.toDataURL('image/jpeg', quality);
    } catch (e) {
      return null;
    }
  }

  _render() {
    if (!this.renderer) return;
    // Adaptive near/far first — fits depth precision to the view so the AO
    // (which reads depth) stays clean at any distance. Must run before the AO
    // composer, which reads camera.near / camera.far.
    this._updateClipPlanes();

    // Planar mirrors: render their reflections ONCE here, before the composer,
    // so the reflection pass can't re-fire inside the N8AO/SSR scene renders.
    if (this._mirrors && this._mirrors.length) {
      for (const m of this._mirrors) {
        try { m.update(this.renderer, this.scene, this.camera); } catch (e) { console.error(e); }
      }
    }

    // Main scene — through the N8AO composer when AO is enabled, else direct.
    // The composer's last pass restores the render target to screen, so the
    // outline + overlay below still composite on top exactly as before.
    // Use the composer when AO OR SSR is on (SSR is a composer pass). When AO is
    // off the N8AO pass is disabled but the composer still runs for SSR / the
    // plain RenderPass.
    const composer = (this._aoEnabled !== false || this._ssrEnabled) ? this._ensureComposer() : null;
    if (composer && this._n8aoPass) {
      // Freeze N8AO's noise seed while the camera is still → every re-render
      // produces IDENTICAL AO → no shimmer, even when the loop wakes on a mouse
      // move / box-select. Live seed only while the camera actually moves
      // (motion masks the per-frame variation).
      const key = this._camKey();
      if (key !== this._aoCamKey) { this._aoCamKey = key; this._n8aoPass.frozenTime = null; }
      else if (this._n8aoPass.frozenTime == null) { this._n8aoPass.frozenTime = performance.now() / 1000; }
    }
    this.renderer.autoClear = true;
    if (composer) composer.render();
    else          this.renderer.render(this.scene, this.camera);

    // Fulfil a pending thumbnail grab by REUSING this render — the canvas is
    // now scene+AO, before the outline/gizmo passes below. No separate render
    // → no perturbation of the N8AO pass (the cause of the static-frame blink).
    if (this._pendingThumb) {
      const p = this._pendingThumb; this._pendingThumb = null;
      try { p.resolve(this._grabCanvasThumb(p.w, p.h, p.quality, p.opts)); }
      catch (e) { p.resolve(null); }
    }

    // V0.2.22.21 — combined silhouette outline (additive composite over
    // the just-drawn scene). Early-exits when nothing is selected.
    renderOutlinePass(this.scene, this.camera);

    // Overlay scene (gizmos / transform handles) — depth-cleared so they
    // always appear on top
    if (this.overlayScene.children.length > 0) {
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.overlayScene, this.camera);
      this.renderer.autoClear = true;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  AMBIENT OCCLUSION (N8AO via EffectComposer) — V0.3.0.1
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Lazily build the AO composer at the renderer's current size. Returns the
   * composer, or null if construction failed (AO then disables itself so the
   * viewport keeps rendering directly). N8AOPass renders its own depth from the
   * scene — so the custom unified shader's dither-discard naturally shapes the
   * AO coverage. screenSpaceRadius keeps the AO scale-independent across the
   * very different model sizes CAD assemblies come in.
   */
  _ensureComposer() {
    if (this._composer) return this._composer;
    if (!this.renderer || !this.scene || !this.camera) return null;
    try {
      const size = this.renderer.getSize(new THREE.Vector2());
      const composer = new EffectComposer(this.renderer);
      composer.addPass(new RenderPass(this.scene, this.camera));
      const n8ao = new N8AOPass(this.scene, this.camera, size.width, size.height);
      const c = n8ao.configuration;
      c.screenSpaceRadius = true;   // aoRadius in px → scale-independent
      c.aoRadius          = 24.0;
      c.distanceFalloff   = 1.0;
      c.intensity         = 4.0;
      c.aoSamples         = 16;
      c.denoiseSamples    = 8;
      c.denoiseRadius     = 12;
      c.gammaCorrection   = true;   // final sRGB (renderer uses NoToneMapping → no OutputPass)
      c.accumulate        = false;  // NEVER cross-frame accumulate — ghosts under motion
      composer.addPass(n8ao);
      this._n8aoPass = n8ao;
      n8ao.enabled = (this._aoEnabled !== false);

      // SSR contact reflections. Last pass when enabled → renders to screen; the
      // composer's isLastEnabledPass() handles the on/off swap automatically.
      // Isolated try/catch: an MRT/WebGL2 failure must not take AO down with it.
      let ssr = null;
      try {
        ssr = new SSRReflectPass(this.scene, this.camera, size.width, size.height);
        ssr.enabled = !!this._ssrEnabled;
        composer.addPass(ssr);
        this._ssrPass = ssr;
      } catch (e) {
        console.warn('[scene] SSR pass init failed — reflections disabled:', e);
        this._ssrPass = null;
      }

      this._composer = composer;
      // Re-apply settings captured before the passes existed (boot ordering).
      if (this._renderSettings) this.applyRenderSettings();
      // Console tuning hooks for the spike:
      //   window.sbsAO.set({aoRadius:32,intensity:5}) / .on(false)
      //   window.sbsSSR.on(true) / .set({intensity:0.6, maxDistance:8, thickness:1, steps:24})
      if (typeof window !== 'undefined') {
        window.sbsAO = {
          set:  (o) => this.setAOConfig(o),
          on:   (b) => this.setAOEnabled(b),
          pass: n8ao,
        };
        window.sbsSSR = {
          on:   (b) => { this.setSSREnabled(b !== false); console.log('[scene] SSR', b !== false ? 'ON' : 'OFF'); },
          set:  (o) => { if (this._ssrPass) Object.assign(this._ssrPass.params, o || {}); this.requestRender(300); },
          pass: ssr,
        };
      }
      console.log('[scene] N8AO composer ready', size.width + 'x' + size.height);
      return composer;
    } catch (e) {
      console.error('[scene] N8AO composer init failed — AO disabled:', e);
      this._aoEnabled = false;
      this._composer = null;
      return null;
    }
  }

  /** Toggle ambient occlusion on/off (toggles the N8AO pass; composer stays). */
  setAOEnabled(on) {
    this._aoEnabled = !!on;
    if (this._n8aoPass) this._n8aoPass.enabled = !!on;
    this.requestRender(300);
  }

  /** Toggle SSR contact reflections on/off. */
  setSSREnabled(on) {
    this._ssrEnabled = !!on;
    if (this._ssrPass) this._ssrPass.enabled = !!on;
    this.requestRender(300);
  }

  /** Live-tune N8AO config, e.g. setAOConfig({ aoRadius: 32, intensity: 5 }). */
  setAOConfig(opts = {}) {
    if (!this._n8aoPass) return;
    for (const [k, v] of Object.entries(opts)) {
      try { this._n8aoPass.configuration[k] = v; } catch (_) { /* ignore bad keys */ }
    }
  }

  /**
   * Apply a render-settings object {ao:{enabled,intensity,radius,falloff},
   * ssr:{enabled,intensity,maxDistance,thickness,steps}} — from userSettings.render.
   * Stored so _ensureComposer can re-apply once the passes exist (boot order).
   */
  applyRenderSettings(rs) {
    if (rs) this._renderSettings = rs;
    const s = this._renderSettings;
    if (!s) return;
    const ao = s.ao || {};
    this._aoEnabled  = (ao.enabled !== false);
    this._ssrEnabled = !!(s.ssr && s.ssr.enabled);
    if (this._n8aoPass) {
      this._n8aoPass.enabled = this._aoEnabled;
      const cfg = {};
      if (ao.intensity != null) cfg.intensity       = ao.intensity;
      if (ao.radius    != null) cfg.aoRadius         = ao.radius;
      if (ao.falloff   != null) cfg.distanceFalloff  = ao.falloff;
      this.setAOConfig(cfg);
    }
    if (this._ssrPass) {
      this._ssrPass.enabled = this._ssrEnabled;
      const ss = s.ssr || {}, p = this._ssrPass.params;
      if (ss.intensity   != null) p.intensity   = ss.intensity;
      if (ss.roughness   != null) p.roughness   = ss.roughness;
      if (ss.maxDistance != null) p.maxDistance = ss.maxDistance;
      if (ss.thickness   != null) p.thickness   = ss.thickness;
      if (ss.steps       != null) p.steps       = ss.steps;
    }
    this.requestRender(300);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  TICK HOOKS
  // ═══════════════════════════════════════════════════════════════════════
  /** Register a per-frame callback. Returns an unsubscribe function. */
  addTickHook(fn) {
    this._tickHooks.add(fn);
    return () => this._tickHooks.delete(fn);
  }

  /**
   * Manually fire all registered tick hooks with synthetic timestamps.
   * Used by offline render mode — the export loop drives time, not rAF.
   * Does NOT render or advance the camera transition; caller controls that.
   */
  fireSyntheticTick(now, delta) {
    this._advanceTransition(now);
    this._syncFillLight();
    this._tickHooks.forEach(fn => { try { fn(now, delta); } catch(e) { console.error(e); } });
  }

  /** Public render-once entry point used by offline export per-frame capture.
   * Renders the SAME way the live viewport does — through the AO composer when
   * AO is on — so the exported mp4 has ambient occlusion. */
  renderFrame() {
    this._render();
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  FIT — canonical buffer + canonical-aspect camera + letterboxed CSS
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Size the renderer buffer to canonical W × H, set camera aspect to
   * canonical, and position the canvas's CSS box as the safe-frame rect
   * inside the container (letterbox / pillarbox depending on container
   * shape). Idempotent — safe to call on every resize event.
   */
  fitToCanonical() {
    if (!this.renderer || !this._container) return;
    const c = getCanonicalSize();
    const pw = this._container.clientWidth;
    const ph = this._container.clientHeight;
    if (pw === 0 || ph === 0 || c.width === 0 || c.height === 0) return;

    // 1. Backing buffer at exact canonical px (PR was forced to 1 in init).
    this.renderer.setSize(c.width, c.height, false);   // false = don't touch CSS, we set it next
    // V0.2.22.21 — keep the outline pass's offscreen target in sync.
    resizeOutlinePass(c.width, c.height);
    // V0.3.0.1 — keep the AO composer's render targets at canonical size too.
    if (this._composer) this._composer.setSize(c.width, c.height);
    this.requestRender(0);   // size/aspect changed → force a redraw (camera-pose key wouldn't catch it)

    // 2. Camera at canonical aspect — every render projects the same
    //    frustum on every machine. Output is reproducible.
    this.camera.aspect = c.aspect;
    this.camera.updateProjectionMatrix();

    // 3. CSS box = safe-frame rect inside container. computeSafeFrameRect
    //    returns the largest canonical-aspect rectangle that fits, centred.
    const sf = computeSafeFrameRect({ width: pw, height: ph });
    const dom = this.renderer.domElement;
    dom.style.position = 'absolute';
    dom.style.left   = `${sf.x}px`;
    dom.style.top    = `${sf.y}px`;
    dom.style.width  = `${sf.width}px`;
    dom.style.height = `${sf.height}px`;

    this.emit('resize', { width: c.width, height: c.height });
  }

  /** @deprecated — use fitToCanonical(). Kept as an alias for callers. */
  resize() { this.fitToCanonical(); }

  // ═══════════════════════════════════════════════════════════════════════
  //  BACKGROUND / GRID / HELPERS
  // ═══════════════════════════════════════════════════════════════════════
  setBackground(hex) {
    if (this.scene) this.scene.background = new THREE.Color(hex);
  }

  setGridVisible(visible) {
    if (this.gridHelper)  this.gridHelper.visible  = visible;
    if (this.axesHelper)  this.axesHelper.visible  = visible;
  }

  /**
   * Set the user-preference zoom-step multiplier. Default 1.0; lower
   * values mean a finer-step wheel, higher means coarser. Persisted in
   * user-settings.json under scene.cameraZoomScale and applied at boot
   * + on every Scene-tab change.
   */
  setUserZoomScale(v) {
    const n = Number(v);
    this._userZoomScale = (Number.isFinite(n) && n > 0) ? n : 1.0;
  }
  getUserZoomScale() { return this._userZoomScale ?? 1.0; }

  // ═══════════════════════════════════════════════════════════════════════
  //  FILL LIGHT
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Configure the camera-tracking fill light.
   * @param {object} opts  { enabled, color, intensity, distance, decay,
   *                         offsetX, offsetY, offsetZ }
   */
  setFillLight(opts = {}) {
    if (!this.fillLight) return;
    this._fillLightOpts = opts;

    this.fillLight.color.set(opts.color  ?? '#ffffff');
    this.fillLight.intensity = opts.enabled ? (opts.intensity ?? 1.1) : 0;
    this.fillLight.distance  = opts.distance ?? 0;
    this.fillLight.decay     = opts.decay    ?? 2;
  }

  _syncFillLight() {
    if (!this.fillLight || !this.camera) return;
    if (!this.fillLight.intensity) return;   // off — skip math

    const o = this._fillLightOpts ?? {};
    const ox = o.offsetX ?? -120;
    const oy = o.offsetY ??   70;
    const oz = o.offsetZ ??  140;

    // Build an offset in camera space, transform to world space
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up    = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    const back  = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 2); // -forward

    this.fillLight.position
      .copy(this.camera.position)
      .addScaledVector(right, ox)
      .addScaledVector(up,    oy)
      .addScaledVector(back, -oz);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  CAMERA STATE
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Return current camera state (matches CameraState schema).
   */
  getCameraState() {
    const pos = this.camera.position;
    const q   = this.camera.quaternion;
    const up  = this.camera.up;
    return {
      position:   [pos.x, pos.y, pos.z],
      quaternion: [q.x, q.y, q.z, q.w],
      pivot:      [this.controls.pivot.x, this.controls.pivot.y, this.controls.pivot.z],
      up:         [up.x, up.y, up.z],
      fov:        this.camera.fov,
    };
  }

  /**
   * Apply a CameraState immediately (no animation).
   */
  applyCameraState(state) {
    if (!state || !this.camera) return;

    if (state.position)   this.camera.position.set(...state.position);
    if (state.quaternion) this.camera.quaternion.set(...state.quaternion);
    if (state.up)         this.camera.up.set(...state.up);
    if (state.fov != null) {
      this.camera.fov = state.fov;
      this.camera.updateProjectionMatrix();
    }
    if (state.pivot && this.controls) {
      this.controls.pivot.set(...state.pivot);
      this.controls.syncSpherical();
    }
  }

  /**
   * Animate the camera from its current state to `targetState`.
   * Any in-progress transition is cancelled and replaced.
   *
   * @param {object} targetState  CameraState
   * @param {number} durationMs   Animation duration (0 = instant)
   * @param {string} easing       'smooth' | 'linear' | 'instant'
   * @returns {Promise}           Resolves when animation completes
   */
  animateCameraTo(targetState, durationMs = 1500, easing = 'smooth') {
    if (!targetState || !this.camera) return Promise.resolve();

    if (durationMs <= 0 || easing === 'instant') {
      this.applyCameraState(targetState);
      return Promise.resolve();
    }

    const fromState = this.getCameraState();

    const fromPos  = new THREE.Vector3(...fromState.position);
    const fromQ    = new THREE.Quaternion(...fromState.quaternion);
    const fromPivot = new THREE.Vector3(...fromState.pivot);
    const fromFov  = fromState.fov ?? 45;

    const toPos    = new THREE.Vector3(...(targetState.position   ?? fromState.position));
    const toQ      = new THREE.Quaternion(...(targetState.quaternion ?? fromState.quaternion));
    const toPivot  = new THREE.Vector3(...(targetState.pivot      ?? fromState.pivot));
    const toFov    = targetState.fov ?? fromFov;

    return new Promise((resolve) => {
      // Cancel any previous transition
      if (this._transition?.reject) this._transition.reject('cancelled');

      // Pin startMs to the CURRENT clock value (synthMs in offline export,
      // performance.now in realtime). Previously this was null and got
      // initialised on the first tick — but in offline mode the synthetic
      // sleep schedule is computed against the OBJECT-transition startMs
      // (which uses clock.now() up front). Setting camera startMs lazily
      // pushed camera completion ~1 frame past the sleep's target, so
      // Promise.all([cameraP, objectP, _sleep(maxDur)]) hung forever
      // waiting on a camera transition that never got another tick.
      this._transition = {
        startMs:  clock.now(),
        durationMs,
        easeFn:   ease[easing] ?? ease.smooth,
        fromPos, fromQ, fromPivot, fromFov,
        toPos, toQ, toPivot, toFov,
        resolve,
        reject: null,
      };
      this._transition.reject = (reason) => {
        this._transition = null;
        resolve();   // don't reject — just snap to current
      };
    });
  }

  _advanceTransition(nowMs) {
    const t = this._transition;
    if (!t) return;

    // startMs is set at animateCameraTo() time (clock.now() — synthMs in
    // offline, performance.now in realtime). The previous lazy-init on
    // first tick mismatched the offline synthetic sleep schedule, which
    // is computed against object-transition startMs taken at phase
    // setup. The mismatch shifted camera completion past the sleep
    // target, hanging Promise.all forever in offline export.
    const elapsed = nowMs - t.startMs;
    // Clamp LOW to 0: a stale first-frame timestamp (heavy step setup) can make
    // elapsed negative, and easeFn(negative) returns a positive alpha — the
    // camera would jump forward one frame then pop back. Pin frame 0 to start.
    const raw     = Math.max(0, Math.min(elapsed / t.durationMs, 1));
    const alpha   = t.easeFn(raw);

    // Interpolate position
    const pos = t.fromPos.clone().lerp(t.toPos, alpha);
    this.camera.position.copy(pos);

    // Slerp quaternion
    const q = t.fromQ.clone().slerp(t.toQ, alpha);
    this.camera.quaternion.copy(q);

    // Interpolate pivot
    const pivot = t.fromPivot.clone().lerp(t.toPivot, alpha);
    this.controls.pivot.copy(pivot);

    // Interpolate FOV
    const fov = t.fromFov + (t.toFov - t.fromFov) * alpha;
    if (Math.abs(fov - this.camera.fov) > 0.001) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    if (raw >= 1) {
      this.controls.syncSpherical();
      const resolve = t.resolve;
      this._transition = null;
      resolve();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  FIT TO SCENE
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Fit the camera to a bounding box.
   * Returns a CameraState you can pass to animateCameraTo().
   */
  fitStateForBox(box, padding = 1.25) {
    if (!box || box.isEmpty()) return this.getCameraState();

    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const radius = size.length() * 0.5 * padding;

    const fovRad   = THREE.MathUtils.degToRad(this.camera.fov);
    const aspectH  = Math.min(this.camera.aspect, 1);
    const distance = radius / Math.sin(fovRad * 0.5 * aspectH);

    // Keep the current camera direction, just move it back
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);

    const newPos = center.clone().addScaledVector(dir, -distance);

    const q = new THREE.Quaternion();
    const m = new THREE.Matrix4().lookAt(newPos, center, this.camera.up);
    q.setFromRotationMatrix(m);

    return {
      position:   [newPos.x, newPos.y, newPos.z],
      quaternion: [q.x, q.y, q.z, q.w],
      pivot:      [center.x, center.y, center.z],
      up:         [0, 1, 0],
      fov:        this.camera.fov,
    };
  }

  /**
   * Compute a bounding box for a set of Three.js objects
   * (or the entire rootGroup if objects is null/empty).
   */
  computeBoundingBox(objects = null) {
    const targets = objects?.length ? objects : [this.rootGroup];
    const box = new THREE.Box3();
    targets.forEach(o => box.expandByObject(o));
    return box;
  }

  /**
   * Adaptive near/far clip planes (V0.3.0.14). The fixed 0.1 / 1,000,000 planes
   * are a 10⁷:1 ratio — almost no depth precision survives at distance, so flat
   * panels quantize into stepped depth and N8AO paints noise on the steps (worse
   * the farther the camera). Here we fit the planes to the visible bounds + the
   * current camera distance on every render, keeping the ratio tight so depth
   * precision — and the AO — stay clean at any zoom. Clip-safe: planes sit
   * beyond the geometry with margin, and never tighter than the old fixed near.
   *
   * The bounds traversal is the costly part, so it's cached and refreshed on a
   * 200 ms throttle while interactive; during export (loop stopped) it refreshes
   * every frame so a step animation can't drift outside stale planes.
   */
  _updateClipPlanes() {
    const cam = this.camera;
    if (!cam) return;
    const now = performance.now();
    const throttleMs = this._loopRunning ? 200 : 0;
    if (!this._clipSphere || (now - (this._clipBoundsMs || 0)) > throttleMs) {
      const box = this.computeBoundingBox(null);                 // rootGroup
      if (this.gridHelper?.visible) box.expandByObject(this.gridHelper);
      if (this.axesHelper?.visible) box.expandByObject(this.axesHelper);
      if (box.isEmpty()) {
        this._clipSphere = null;
      } else {
        this._clipSphere = this._clipSphere || new THREE.Sphere();
        box.getBoundingSphere(this._clipSphere);
      }
      this._clipBoundsMs = now;
    }

    // Tunable via window.sbsClip. enabled=false → legacy fixed planes (A/B test).
    const cfg = this._clipCfg ||
      (this._clipCfg = { enabled: true, nearFactor: 0.5, farMargin: 1.5, ratioCap: 50000 });

    let near, far;
    if (!cfg.enabled) {
      near = 0.1; far = 1000000;                   // legacy fixed planes
    } else {
      const s = this._clipSphere;
      if (s && isFinite(s.radius) && s.radius > 0) {
        const dist = cam.position.distanceTo(s.center);
        const r = s.radius;
        far  = dist + r * cfg.farMargin;            // beyond the far edge
        // nearFactor scales how close the near plane sits to the nearest geometry.
        // Lower = near plane pushed closer → less close-up clipping, slightly less
        // precision (ratioCap is the floor). Higher = more precision, more clip risk.
        near = Math.max(far / cfg.ratioCap, (dist - r) * cfg.nearFactor);
        if (!(near > 0)) near = far / cfg.ratioCap;
      } else {
        near = 0.1; far = 100000;                   // empty scene → safe default
      }
    }

    // Rebuild the projection only on a meaningful change (avoid per-frame churn).
    if (Math.abs(cam.near - near) > near * 0.02 || Math.abs(cam.far - far) > far * 0.02) {
      cam.near = near;
      cam.far  = far;
      cam.updateProjectionMatrix();
    }
  }

  // ── Planar mirrors (V0.3.0.28 spike) ────────────────────────────────────
  /** Turn a flat mesh into a true planar mirror (reflection rendered in _render). */
  addPlanarMirror(mesh) {
    if (!mesh || !mesh.isMesh) return null;
    this._mirrors = this._mirrors || [];
    const m = new PlanarMirror(mesh);
    this._mirrors.push(m);
    this.requestRender(300);
    return m;
  }
  /** Debug: log each mirror's state (in-scene? visible? material? geometry?). */
  mirrorInfo() {
    const list = this._mirrors || [];
    console.log('[mirror] count:', list.length);
    for (const m of list) {
      const sub = m.mesh;
      let p = sub, inScene = false;
      while (p) { if (p === this.scene) { inScene = true; break; } p = p.parent; }
      const g = sub && sub.geometry;
      console.log('  sub →', {
        inScene, visible: sub && sub.visible, parent: sub && sub.parent && (sub.parent.name || sub.parent.type),
        material: sub && sub.material && sub.material.type, frustumCulled: sub && sub.frustumCulled,
        posVerts: g && g.getAttribute && g.getAttribute('position') && g.getAttribute('position').count,
        uDebug: sub && sub.material && sub.material.uniforms && sub.material.uniforms.uDebug && sub.material.uniforms.uDebug.value,
      });
    }
  }
  /** Debug: paint all planar mirrors solid magenta to test visibility. */
  setMirrorDebug(on) {
    if (this._mirrors) for (const m of this._mirrors) m.setDebug?.(on);
    this.requestRender(300);
  }
  /** Remove planar mirrors whose sub-mesh lives under `root` (re-run dedup). */
  removePlanarMirrorsUnder(root) {
    if (!this._mirrors || !root) return;
    const keep = [];
    for (const m of this._mirrors) {
      let p = m.mesh, under = false;
      while (p) { if (p === root) { under = true; break; } p = p.parent; }
      if (under) { try { m.dispose(); } catch {} } else keep.push(m);
    }
    this._mirrors = keep;
    this.requestRender(300);
  }
  /** Remove all planar mirrors, restoring their original materials. */
  clearPlanarMirrors() {
    if (this._mirrors) { for (const m of this._mirrors) { try { m.dispose(); } catch {} } }
    this._mirrors = [];
    this.requestRender(300);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  RAYCASTING / PICKING
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Cast a ray from screen coords into `this.rootGroup`.
   * Returns the first visible hit or null.
   */
  pick(clientX, clientY) {
    if (!this.renderer) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    this.pointer.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster
      .intersectObject(this.rootGroup, true)
      .filter(h => h.object.visible);
    return hits[0] ?? null;
  }

  /**
   * Same as `pick` but returns all hits.
   */
  pickAll(clientX, clientY) {
    if (!this.renderer) return [];
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    this.pointer.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster
      .intersectObject(this.rootGroup, true)
      .filter(h => h.object.visible);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  CONTROLS LOCK (for deterministic export)
  // ═══════════════════════════════════════════════════════════════════════
  lockControls()   { this._locked = true;  }
  unlockControls() { this._locked = false; }

  // ═══════════════════════════════════════════════════════════════════════
  //  CUSTOM CAD ORBIT CONTROLS
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Custom Y-up orbit controls that match the POC feel exactly:
   *   - Middle mouse button drag  →  pan
   *   - Alt + middle mouse drag   →  orbit (Y-up constrained, pivot hit test)
   *   - Scroll wheel              →  adaptive zoom toward view direction
   *
   * Controls state is on `this.controls` so camera-state capture can
   * read/write `this.controls.pivot` directly.
   */
  _initControls() {
    const dom = this.renderer.domElement;

    const ctrl = {
      active:      null,           // 'pan' | 'rotate' | null
      lastX:       0,
      lastY:       0,
      panSpeed:    0.75,
      zoomSpeed:   4.8,
      rotateSpeed: 0.008,
      pivot:       new THREE.Vector3(0, 0, 0),
      spherical:   new THREE.Spherical(),
      orbit: {
        startMouseX:  0,
        startMouseY:  0,
        startPivot:   new THREE.Vector3(),
        startOffset:  new THREE.Vector3(),
        startForward: new THREE.Vector3(),
        startUp:      new THREE.Vector3(),
        startRight:   new THREE.Vector3(),
      },
      syncSpherical: () => {
        const offset = this.camera.position.clone().sub(ctrl.pivot);
        ctrl.spherical.setFromVector3(offset);
        if (!Number.isFinite(ctrl.spherical.radius) || ctrl.spherical.radius <= 0) {
          ctrl.spherical.radius = 300;
          ctrl.spherical.theta  = Math.PI / 4;
          ctrl.spherical.phi    = Math.PI / 3;
        }
      },
    };

    ctrl.syncSpherical();
    this.controls = ctrl;

    // ── Internal helpers ─────────────────────────────────────────────────
    //
    // Pivot policy on orbit-start:
    //   1. Raycast hit a face → pivot lands on that hit point.
    //   2. Miss (clicked empty background) → KEEP the current pivot.
    //      This is the CAD-standard behaviour (Solidworks / Fusion /
    //      Onshape). It's also scale-immune: after a model rescale the
    //      old pivot may be at any world-coordinate but the camera-to-
    //      pivot distance stays sane, so orbit radius stays sane.
    //   3. Miss AND pivot has never been set (e.g. brand-new scene) →
    //      fall back to scene center as a one-time initialiser.
    const _updatePivotFromHit = (clientX, clientY) => {
      const hit = this.pick(clientX, clientY);
      if (hit) {
        ctrl.pivot.copy(hit.point);
        ctrl.syncSpherical();
        return;
      }
      // Miss: keep current pivot if it's been initialised. We treat
      // "initialised" as any non-zero pivot OR a finite spherical radius
      // from a prior successful pick / fit-to-view call.
      const pivotInit = ctrl.pivot.lengthSq() > 1e-12
        || (Number.isFinite(ctrl.spherical.radius) && ctrl.spherical.radius > 0);
      if (pivotInit) {
        // Re-sync just in case the camera moved since the last orbit
        // (pan keeps pivot+camera locked, but defensive).
        ctrl.syncSpherical();
        return;
      }
      // One-time fallback for the very first orbit before any pivot
      // has been set.
      const box = new THREE.Box3().setFromObject(this.rootGroup);
      if (!box.isEmpty()) {
        ctrl.pivot.copy(box.getCenter(new THREE.Vector3()));
        ctrl.syncSpherical();
      }
    };

    const _captureOrbit = (clientX, clientY) => {
      _updatePivotFromHit(clientX, clientY);
      const o = ctrl.orbit;
      o.startMouseX = clientX;
      o.startMouseY = clientY;
      o.startPivot.copy(ctrl.pivot);
      o.startOffset.copy(this.camera.position).sub(ctrl.pivot);
      this.camera.getWorldDirection(o.startForward).normalize();
      o.startUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
      o.startRight.crossVectors(o.startForward, o.startUp).normalize();
    };

    const _applyYUpOrbit = (totalDx, totalDy) => {
      const o = ctrl.orbit;
      const Y  = new THREE.Vector3(0, 1, 0);

      // Yaw around world Y
      const yawQ = new THREE.Quaternion()
        .setFromAxisAngle(Y, -totalDx * ctrl.rotateSpeed);

      const yawedOffset  = o.startOffset.clone().applyQuaternion(yawQ);
      const yawedForward = o.startForward.clone().applyQuaternion(yawQ);

      // Pitch around the camera's local X axis (after yaw)
      let pitchAxis = new THREE.Vector3().crossVectors(yawedForward, Y);
      if (pitchAxis.lengthSq() < 1e-10) {
        pitchAxis.copy(o.startRight).applyQuaternion(yawQ);
      }
      pitchAxis.normalize();

      const pitchQ     = new THREE.Quaternion()
        .setFromAxisAngle(pitchAxis, -totalDy * ctrl.rotateSpeed);
      const newOffset  = yawedOffset.clone().applyQuaternion(pitchQ);
      let newForward   = yawedForward.clone().applyQuaternion(pitchQ).normalize();

      // Clamp to avoid gimbal flip at poles
      const VL = 0.999;
      if (Math.abs(newForward.y) > VL) {
        newForward.y = Math.sign(newForward.y) * VL;
        const horiz = Math.sqrt(1 - newForward.y * newForward.y);
        let flat = new THREE.Vector3(newForward.x, 0, newForward.z);
        if (flat.lengthSq() < 1e-10) flat.set(0, 0, 1);
        flat.normalize().multiplyScalar(horiz);
        newForward.set(flat.x, newForward.y, flat.z).normalize();
      }

      const newPos = o.startPivot.clone().add(newOffset);

      let right = new THREE.Vector3().crossVectors(newForward, Y);
      if (right.lengthSq() < 1e-10) right.set(1, 0, 0);
      right.normalize();
      const up = new THREE.Vector3().crossVectors(right, newForward).normalize();

      this.camera.position.copy(newPos);
      const basis = new THREE.Matrix4().makeBasis(right, up, newForward.clone().negate());
      this.camera.quaternion.setFromRotationMatrix(basis);
      ctrl.pivot.copy(o.startPivot);
      ctrl.syncSpherical();

      this.emit('controls:change');
    };

    // ── Wheel: distance-based zoom (scale-immune) ────────────────────────
    // Step = (distance from camera to pivot) × baseFactor × user-prefs scale.
    // No dependency on scene-size — works at any world-unit scale, never
    // needs recalibration after a model rescale.
    //
    // Modifiers:
    //   Ctrl + wheel  → 0.1× step (10× slower / finer control)
    //   Shift + wheel → 10×  step (10× faster / coarser)
    //   Bare wheel    → 1×   step (default)
    dom.addEventListener('wheel', (e) => {
      if (this._locked) return;
      e.preventDefault();

      const delta   = Math.sign(e.deltaY);
      const forward = new THREE.Vector3();
      this.camera.getWorldDirection(forward);

      // Distance to pivot drives the step size — close-up moves are tiny,
      // far-away moves are large. Floor prevents getting "stuck" at 0.
      const dist = Math.max(this.camera.position.distanceTo(ctrl.pivot), 1e-4);
      const mult = e.ctrlKey ? 0.1 : (e.shiftKey ? 10 : 1);
      // _userZoomScale is user-pref multiplier (default 1.0); set via
      // setUserZoomScale() from the Scene settings tab.
      const userScale = (typeof this._userZoomScale === 'number')
        ? this._userZoomScale : 1.0;
      const step = dist * 0.08 * ctrl.zoomSpeed * mult * userScale;

      this.camera.position.addScaledVector(forward, delta > 0 ? -step : step);
      ctrl.syncSpherical();
      this.emit('controls:change');
    }, { passive: false });

    // ── Pointer down: start pan or rotate on middle button ───────────────
    dom.addEventListener('pointerdown', (e) => {
      if (this._locked || e.button !== 1) return;
      e.preventDefault();

      ctrl.active = e.altKey ? 'rotate' : 'pan';
      ctrl.lastX  = e.clientX;
      ctrl.lastY  = e.clientY;
      dom.style.cursor = e.altKey ? 'grabbing' : 'move';

      if (ctrl.active === 'rotate') {
        _captureOrbit(e.clientX, e.clientY);
      }
    });

    // ── Pointer move: pan or orbit ───────────────────────────────────────
    window.addEventListener('pointermove', (e) => {
      if (!ctrl.active) return;
      e.preventDefault();

      const dx = e.clientX - ctrl.lastX;
      const dy = e.clientY - ctrl.lastY;
      ctrl.lastX = e.clientX;
      ctrl.lastY = e.clientY;

      if (ctrl.active === 'pan') {
        const distance = this.camera.position.distanceTo(ctrl.pivot);
        const factor   = Math.max(distance * 0.0016, 0.02) * ctrl.panSpeed;
        const right    = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0).normalize();
        const up       = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1).normalize();
        const offset   = new THREE.Vector3()
          .addScaledVector(right, -dx * factor)
          .addScaledVector(up,     dy * factor);
        this.camera.position.add(offset);
        ctrl.pivot.add(offset);
        this.emit('controls:change');
        return;
      }

      if (ctrl.active === 'rotate') {
        const totalDx = e.clientX - ctrl.orbit.startMouseX;
        const totalDy = e.clientY - ctrl.orbit.startMouseY;
        _applyYUpOrbit(totalDx, totalDy);
      }
    });

    // ── Pointer up: release ──────────────────────────────────────────────
    window.addEventListener('pointerup', () => {
      ctrl.active      = null;
      dom.style.cursor = 'default';
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  DISPOSE
  // ═══════════════════════════════════════════════════════════════════════
  dispose() {
    this.stopLoop();
    this._resizeObs?.disconnect();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
    this._map.clear();
    this._tickHooks.clear();
  }
}

// ── Singleton export ───────────────────────────────────────────────────────
export const sceneCore = new SceneCore();
export default sceneCore;
