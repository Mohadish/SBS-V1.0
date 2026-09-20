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
// 🎯 V0.3.2.231 — only to read '_exporting' for the orbit-pivot marker.
// state.js imports schema.js alone, so this closes no cycle.
import { state } from './state.js';

// ═══════════════════════════════════════════════════════════════════════════
//  🎯 ORBIT CAMERA MOVE (V0.3.2.232)
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Point the camera at `target` with the horizon level — the same basis the
 * manual orbit controls build (right = forward × worldY, up = right ×
 * forward), so a move can never introduce roll. Degenerate straight-up or
 * straight-down views fall back to a fixed right vector.
 */
function _levelQuat(eye, target) {
  const fwd = target.clone().sub(eye);
  if (fwd.lengthSq() < 1e-12) return null;
  fwd.normalize();
  const Y = new THREE.Vector3(0, 1, 0);
  let right = new THREE.Vector3().crossVectors(fwd, Y);
  if (right.lengthSq() < 1e-10) right.set(1, 0, 0);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, up, fwd.clone().negate()),
  );
}

function _lookAtLevel(camera, target) {
  const q = _levelQuat(camera.position, target);
  if (!q) return;
  camera.quaternion.copy(q);
  camera.up.set(0, 1, 0).applyQuaternion(q);
}

/** Spherical coordinates of `pos` about `pivot`: azimuth about world Y,
 *  elevation from the horizontal plane, and radius. */
function _sphericalAbout(pos, pivot) {
  const v = pos.clone().sub(pivot);
  const r = v.length();
  if (r < 1e-9) return { az: 0, el: 0, r: 0 };
  const horiz = Math.hypot(v.x, v.z);
  return { az: Math.atan2(v.x, v.z), el: Math.atan2(v.y, horiz), r };
}

/**
 * Describe the move from `fromPos` to `toPos` as an orbit, or return null to
 * leave the caller on its original straight interpolation.
 *
 * Returns null unless at least one END pinned a pivot — that opt-in is what
 * keeps every existing project's camera moves byte-identical. When only one
 * end is pinned, its point serves both ends, which is the sensible default
 * for "I set a centre on this step and want the move into it to respect it".
 * A degenerate radius (camera sitting on the pivot) also declines, since an
 * orbit of radius zero has no direction to interpolate.
 */
function _buildOrbitTween(fromPos, toPos, fromAnim, toAnim, fromQ, toQ, pullout = 0) {
  if (!fromAnim && !toAnim) return null;
  // The points the two ends are MEASURED against, kept on the tween and used
  // again for reconstruction. Measuring about one point and rebuilding about
  // another is what made the camera jump the instant a move began when only
  // one end had a centre.
  const p0 = (fromAnim || toAnim).clone();
  const p1 = (toAnim || fromAnim).clone();
  const a = _sphericalAbout(fromPos, p0);
  const b = _sphericalAbout(toPos,   p1);
  if (a.r < 1e-6 || b.r < 1e-6) return null;
  // Take the SHORT way round: raw azimuths can differ by more than half a
  // turn, and lerping those spins the camera the long way for no reason.
  let dAz = b.az - a.az;
  while (dAz >  Math.PI) dAz -= Math.PI * 2;
  while (dAz < -Math.PI) dAz += Math.PI * 2;

  // AIM OFFSET. A recorded camera does not necessarily point AT its pivot —
  // the pivot is an orbit centre, not a look-at target. Forcing the rig's
  // aim would snap the view to re-centre on frame one and land on the wrong
  // framing at the end. So each end keeps the rotation BETWEEN "aimed at the
  // pivot" and its own recorded orientation, and that offset is slerped
  // across the move: frame 0 is exactly step A's view, frame N exactly step
  // B's, and in between the aim drifts over while the rig orbits.
  const lvlA = _levelQuat(fromPos, p0);
  const lvlB = _levelQuat(toPos,   p1);
  const dFrom = lvlA ? lvlA.clone().invert().multiply(fromQ) : new THREE.Quaternion();
  const dTo   = lvlB ? lvlB.clone().invert().multiply(toQ)   : new THREE.Quaternion();

  return { p0, p1, fromAz: a.az, dAz, fromEl: a.el, toEl: b.el, fromR: a.r, toR: b.r, dFrom, dTo,
           pull: Math.max(0, pullout) };
}

/**
 * 🔲 DOLLY ZOOM (V0.3.4.22) — the rig for a move between two DIFFERENT amounts
 * of perspective.
 *
 * Interpolating the distance and the fov separately (what this file did until
 * now) lets their product — the framing, H = 2·d·tan(fov/2) — wander: a 50° → 1°
 * move draws the subject at 0.076× its size halfway through and pulls it back at
 * the end. That settling zoom is the "bob". So the transition interpolates the
 * two things the eye actually reads, the framing and the perspective, and
 * DERIVES the distance from them on every frame (see core/perspective.js).
 *
 * Returns the two on-axis focus points and focus distances, or null when either
 * end has no usable focus plane (the caller then keeps the old behaviour).
 */
function _buildDollyZoom(fromPos, fromQ, fromFocusPt, fromFov, toPos, toQ, toFocusPt, toFov) {
  if (!fromFocusPt || !toFocusPt) return null;
  const f0 = new THREE.Vector3(0, 0, -1).applyQuaternion(fromQ);
  const f1 = new THREE.Vector3(0, 0, -1).applyQuaternion(toQ);
  const d0 = focusDistance(fromPos, f0, fromFocusPt, fromPos.distanceTo(fromFocusPt));
  const d1 = focusDistance(toPos,   f1, toFocusPt,   toPos.distanceTo(toFocusPt));
  if (!(d0 > 1e-6) || !(d1 > 1e-6)) return null;
  return {
    fromFov, toFov, d0, d1,
    F0: fromPos.clone().addScaledVector(f0, d0),
    F1: toPos.clone().addScaledVector(f1, d1),
  };
}
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
// V0.3.4.22 — the perspective family: k = tan(fov/2), framing H = 2·d·k, and the
// dolly-zoom blend that keeps H exact on every frame of a transition.
import { kOf, fovOf, stepK, clampFov, blendPerspective, perspectiveDiffers, focusDistance,
         frameHeight, distForFrame, ORTHO_FOV_DEG } from './perspective.js';

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
    // 🎯 The active step's ANIMATION orbit centre: an absolute world point
    // (THREE.Vector3) or null. Distinct from controls.pivot, which is the
    // transient CAD orbit centre the cursor's raycast replaces on every
    // manual orbit. Only the step-to-step camera move reads this one.
    this._animPivot   = null;
    // 🎯 Mid-move dolly pull-back, as a fraction of the distance the camera
    // would otherwise be at (0 = none, 0.5 = half again as far).
    this._animPullout = 0;

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
        // Live overscan margin around the export frame (1 = WYSIWYG). Tied to the
        // "Show safe frame" toggle, but tunable here, e.g. window.sbsRender.overscan(1.5).
        overscan: (n) => { this.setOverscan(n); console.log('[scene] live overscan ×', this.getOverscan()); return this.getOverscan(); },
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
      // V0.3.0.86 — the live render is OVERSCAN (a scene margin around the export
      // frame); a thumbnail must show ONLY the export frame = the centre 1/ov of it.
      const ov = this._exportFraming ? 1 : (this._overscan || 1);
      if (ov > 1) {
        const sw = src.width / ov, sh = src.height / ov;
        ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, w, h);
      } else {
        ctx.drawImage(src, 0, 0, w, h);
      }
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

  /**
   * 📄 Run `fn(canvas)` on the NEXT main render, at the same clean moment a
   * thumbnail is grabbed (scene+AO, before outline / gizmo). Forces that render.
   * @returns {Promise<any>} whatever fn returned, or null
   */
  requestCleanFrame(fn) {
    return new Promise((resolve) => {
      this._pendingFrame = { fn, resolve };
      // a window, not 0: requestRender(0) stamps "now", and by the next tick
      // now > stamp — an idle (frozen) loop would never draw the frame we wait for
      this.requestRender(250);
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
      // Same rule as captureThumbnail (V0.3.0.86): under live OVERSCAN the export
      // frame is the centre 1/ov of the buffer — without the crop the 3D came out
      // zoomed-out under a full-size overlay layer.
      const ov = this._exportFraming ? 1 : (this._overscan || 1);
      if (ov > 1) {
        const sw = dom.width / ov, sh = dom.height / ov;
        ctx.drawImage(dom, (dom.width - sw) / 2, (dom.height - sh) / 2, sw, sh, 0, 0, w, h);
      } else {
        ctx.drawImage(dom, 0, 0, w, h);
      }
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
    // V0.3.0.80 — ALWAYS render through the composer (when it built) so the N8AO
    // pass's sRGB gammaCorrection is applied even with AO "off". The direct path
    // below skips that gamma, which made the IBL/HDRI lighting look dark/flat when
    // AO was toggled off. "AO off" is now intensity 0 (setAOEnabled), not a bypass.
    const composer = this._ensureComposer();
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
    // 📄 Same moment, full resolution: the document's step pictures read the
    // clean canvas themselves (own slot, so a step thumbnail is never clobbered).
    if (this._pendingFrame) {
      const p = this._pendingFrame; this._pendingFrame = null;
      try { p.resolve(p.fn(this.renderer.domElement)); }
      catch (e) { p.resolve(null); }
    }

    // V0.2.22.21 — combined silhouette outline (additive composite over
    // the just-drawn scene). Early-exits when nothing is selected.
    renderOutlinePass(this.scene, this.camera);

    // 🎯 Keep the pinned-pivot crosshair honest every frame: it tracks the
    // camera for constant screen size, and it must vanish while exporting.
    // (Thumbnails are already safe — _pendingThumb grabs the canvas ABOVE,
    // before overlayScene is composited.)
    if (this._orbitPivotMarker) this.updateOrbitPivotMarker();

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
      this._aoIntensity ??= c.intensity;   // remember the "on" intensity for toggling
      // Pass stays ENABLED so its gammaCorrection always runs; AO "off" = intensity 0.
      n8ao.enabled = true;
      n8ao.configuration.intensity = (this._aoEnabled !== false) ? (this._aoIntensity ?? c.intensity) : 0;

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
    // Keep the pass + composer running so gammaCorrection (and thus the IBL/HDRI
    // lighting) stays; "off" just zeroes the AO darkening.
    if (this._n8aoPass) {
      this._n8aoPass.enabled = true;
      this._n8aoPass.configuration.intensity = on ? (this._aoIntensity ?? 4.0) : 0;
    }
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
      if (k === 'intensity') {
        this._aoIntensity = v;                    // remember the "on" intensity
        if (this._aoEnabled === false) continue;  // don't un-mute the AO while it's off
      }
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
      this._n8aoPass.enabled = true;   // always on (gamma); intensity 0 = AO off
      const cfg = {};
      if (ao.intensity != null) cfg.intensity       = ao.intensity;
      if (ao.radius    != null) cfg.aoRadius         = ao.radius;
      if (ao.falloff   != null) cfg.distanceFalloff  = ao.falloff;
      this.setAOConfig(cfg);
      if (this._aoEnabled === false) this._n8aoPass.configuration.intensity = 0;
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

    // ── 🎬 Production Render, stage 1 (V0.3.2.46) ───────────────────────────
    // ACES filmic tone mapping + exposure — the first piece of the final-
    // output look. OFF (default) = the classic preview look, byte-identical
    // for every existing project. Tone mapping is COMPILED INTO material
    // programs, so flipping the mode must mark every material for recompile
    // or the viewport silently keeps the old curve.
    if (this.renderer) {
      const prod    = s.production || {};
      const wantTM  = prod.enabled ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
      const wantExp = prod.enabled ? (Number(prod.exposure) > 0 ? Number(prod.exposure) : 1.0) : 1.0;
      const flip    = this.renderer.toneMapping !== wantTM;
      if (flip || this.renderer.toneMappingExposure !== wantExp) {
        // renderer-level tone mapping covers the BUILT-IN material paths
        // (textured MeshStandardMaterial presets). Compiled-in → recompile.
        this.renderer.toneMapping         = wantTM;
        this.renderer.toneMappingExposure = wantExp;
        if (flip && this.scene) {
          this.scene.traverse(o => {
            const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
            for (const m of mats) m.needsUpdate = true;
          });
        }
      }
      // The SBS unified ShaderMaterial (ALL non-texture presets — i.e. most
      // of every scene) ignores renderer.toneMapping entirely; its ACES lives
      // in-shader behind uniforms. Dynamic import dodges the module cycle
      // (materials.js imports sceneCore).
      import('../systems/materials.js')
        .then(m => {
          m.materials?.setProductionLook?.(prod);
          m.materials?.applyProductionEnvironment?.(prod);   // HDRI (V0.3.2.49)
        })
        .catch(() => {});
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
    // V0.3.0.86 — live OVERSCAN. With ov>1 the live camera zooms OUT (zoom=1/ov) so
    // the viewport shows the export frame PLUS a surrounding margin of scene (which
    // the safe-frame overlay dims). Export + thumbnails force ov=1 (the tight export
    // frame). The canvas CSS box grows by the same ov, so the export frame still maps
    // to the inner computeSafeFrameRect rect — where the overlay + the Konva overlay
    // already sit (so nothing else needs to move).
    const ov = this._exportFraming ? 1 : (this._overscan || 1);
    this.camera.zoom = 1 / ov;
    this.camera.updateProjectionMatrix();

    // 3. CSS box = safe-frame rect (× overscan) inside container. computeSafeFrameRect
    //    returns the largest canonical-aspect rectangle that fits, centred.
    const sf = computeSafeFrameRect({ width: pw, height: ph });
    const ow = sf.width * ov, oh = sf.height * ov;
    const dom = this.renderer.domElement;
    dom.style.position = 'absolute';
    dom.style.left   = `${sf.x - (ow - sf.width) / 2}px`;
    dom.style.top    = `${sf.y - (oh - sf.height) / 2}px`;
    dom.style.width  = `${ow}px`;
    dom.style.height = `${oh}px`;

    this.emit('resize', { width: c.width, height: c.height });
  }

  /**
   * Live-viewport overscan factor (V0.3.0.86). 1 = WYSIWYG (canvas == export frame).
   * >1 shows a margin of scene around the export frame (dimmed by the safe-frame
   * overlay). Driven by the "Show safe frame" toggle. Console: window.sbsRender.overscan(n).
   */
  setOverscan(f) { this._overscan = Math.max(1, Number(f) || 1); this.fitToCanonical(); this.requestRender(0); }
  getOverscan() { return this._overscan || 1; }
  /**
   * The overscan factor actually in force RIGHT NOW — 1 while export framing
   * is on, whatever the live setting says (V0.3.2.151).
   *
   * getOverscan() deliberately reports the user's live preference and ignores
   * _exportFraming, which is correct for the settings UI and wrong for anyone
   * projecting coordinates: both internal users of the factor read
   * `this._exportFraming ? 1 : (this._overscan || 1)` instead. Anything mapping
   * world space onto the canonical frame needs THIS value, or every projected
   * point lands scaled-off-centre in an export.
   */
  getEffectiveOverscan() { return this._exportFraming ? 1 : (this._overscan || 1); }
  /** Force the tight export frame (ov=1) while exporting / capturing a thumbnail. */
  setExportFraming(on) { this._exportFraming = !!on; this.fitToCanonical(); }

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
      // 🎯 V0.3.2.234 — the step's ANIMATION orbit centre: an absolute world
      // point, like a 3D-anchored arrow's endpoint, bound to nothing and
      // following nothing. Kept separate from `pivot` above, which is the
      // transient CAD orbit centre the cursor's raycast keeps replacing —
      // sharing one field made manual orbiting overwrite the step's choice.
      // Only written when set, so steps without one serialise as before.
      ...(this._animPivot ? { orbitPivot: [this._animPivot.x, this._animPivot.y, this._animPivot.z] } : {}),
      ...(this._animPullout ? { orbitPullout: this._animPullout } : {}),
    };
  }

  /**
   * Apply a CameraState immediately (no animation).
   */
  applyCameraState(state) {
    if (!state || !this.camera) return;
    this._stdView = null; this._stdViewFov = null;   // a step's camera is not a standard view

    if (state.position)   this.camera.position.set(...state.position);
    if (state.quaternion) this.camera.quaternion.set(...state.quaternion);
    if (state.up)         this.camera.up.set(...state.up);
    if (state.fov != null) {
      // Clamped into the perspective family (V0.3.4.22): 0.5° is "orthographic"
      // and anything wider than 78° is a fish-eye, not an illustration. Every
      // fov ever written by this app is already inside it, so nothing moves.
      this.camera.fov = clampFov(state.fov);
      this.camera.updateProjectionMatrix();
    }
    if (state.pivot && this.controls) {
      this.controls.pivot.set(...state.pivot);
      this.controls.syncSpherical();
    }
    this._animPivot = Array.isArray(state.orbitPivot)
      ? new THREE.Vector3(...state.orbitPivot) : null;
    this._animPullout = Number(state.orbitPullout) || 0;
    this.updateOrbitPivotMarker();
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  🔲 PERSPECTIVE AMOUNT (V0.3.4.22)
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * How far along the camera's OWN view axis the orbit pivot sits — the depth
   * of the plane whose framing must not change when the perspective does.
   *
   * Projected, not measured: the CAD pivot is wherever the cursor last hit a
   * face, so the straight distance |pivot − eye| would frame a plane that is
   * not the one on screen. A pinned step orbit centre wins when there is one,
   * because the user chose that point on purpose.
   */
  focusDistance() {
    if (!this.camera) return 0;
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    const pivot = this._animPivot || this.controls?.pivot;
    if (!pivot) return 0;
    return focusDistance(this.camera.position, fwd, pivot,
      this.camera.position.distanceTo(pivot));
  }

  /**
   * Set the amount of perspective and DOLLY so the framing does not change —
   * the cinematic dolly zoom, one instant of it. The subject keeps its size;
   * only the perspective opens up or flattens. A plain fov change without the
   * dolly would make everything jump in size, which is the wrong control.
   *
   * @param {number} fovDeg  clamped into the family (0.5° = orthographic)
   */
  setPerspectiveFov(fovDeg) {
    if (!this.camera) return;
    const fov = clampFov(fovDeg);
    if (Math.abs(fov - this.camera.fov) < 1e-6) return;

    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    const d = this.focusDistance();
    if (d > 1e-6) {
      // The point the framing is measured at, then the distance that frames the
      // SAME height at the new lens: d₂ = H / (2·k₂) with H = 2·d·k₁.
      const H = 2 * d * kOf(this.camera.fov);
      const d2 = H / (2 * kOf(fov));
      const focus = this.camera.position.clone().addScaledVector(fwd, d);
      this.camera.position.copy(focus).addScaledVector(fwd, -d2);
    }
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.controls?.syncSpherical();
    // A lens you dialled yourself is yours: leaving a standard view later must
    // not overwrite it with the one the view replaced.
    this._stdViewFov = null;
    this.emit('camera:perspective', fov);
    this.emit('controls:change');
    this.requestRender(300);
  }

  getPerspectiveFov() { return this.camera ? this.camera.fov : 45; }

  // ═══════════════════════════════════════════════════════════════════════
  //  🧭 STANDARD VIEWS (V0.3.4.23)
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * The camera state for a named axis view — top, bottom, left, right, front,
   * back — orthographic by default, the way a technical drawing is drawn.
   *
   * It keeps YOUR framing: the subject stays the size it is, centred on the
   * point you are already looking at (the on-axis focus point, not the CAD
   * pivot, which may be anywhere the cursor last landed). Only the direction
   * you look from, and the lens, change.
   */
  standardViewState(view, opts = {}) {
    if (!this.camera) return null;
    const V = {
      //        where the camera goes          which way is up on screen
      top:    { eye: [0, 1, 0],  up: [0, 0, -1] },   // +Z falls to the bottom of the frame
      bottom: { eye: [0, -1, 0], up: [0, 0, 1] },
      left:   { eye: [-1, 0, 0], up: [0, 1, 0] },
      right:  { eye: [1, 0, 0],  up: [0, 1, 0] },
      front:  { eye: [0, 0, 1],  up: [0, 1, 0] },
      back:   { eye: [0, 0, -1], up: [0, 1, 0] },
    }[String(view || '').toLowerCase()];
    if (!V) return null;

    const fov = clampFov(opts.fov ?? ORTHO_FOV_DEG);
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    const d = this.focusDistance() || this.camera.position.distanceTo(this.controls?.pivot ?? new THREE.Vector3());
    const focus = this.camera.position.clone().addScaledVector(fwd, d);
    // Same frame height, new lens ⇒ the distance the dolly zoom would put us at.
    const H = frameHeight(d || 1, this.camera.fov, this.camera.zoom);
    const dist = Math.max(distForFrame(H, fov, this.camera.zoom), 1e-4);

    const up  = new THREE.Vector3(...V.up);
    const pos = focus.clone().addScaledVector(new THREE.Vector3(...V.eye), dist);
    const q = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(pos, focus, up));
    return {
      position:   [pos.x, pos.y, pos.z],
      quaternion: [q.x, q.y, q.z, q.w],
      pivot:      [focus.x, focus.y, focus.z],
      up:         [up.x, up.y, up.z],
      fov,
    };
  }

  /** Fly to a standard view and remember the lens to come back to. */
  applyStandardView(view, durationMs = 600) {
    const st = this.standardViewState(view);
    if (!st) return Promise.resolve();
    const prevFov = this._stdView ? this._stdViewFov : this.camera.fov;
    const p = this.animateCameraTo(st, durationMs, 'smooth');   // clears _stdView
    this._stdView = String(view).toLowerCase();
    this._stdViewFov = prevFov;
    this.emit('camera:standardView', this._stdView);
    return p;
  }

  getStandardView() { return this._stdView || null; }

  /**
   * Orbiting out of a standard view leaves it — the CAD behaviour: the named
   * view is where you START turning the object from, not a mode you are stuck
   * in. The perspective you had before the view comes back with it, and since
   * that restore is a dolly zoom the framing does not change; only the depth
   * comes back. If you dialled a lens yourself while in the view, that one is
   * yours and nothing is restored.
   */
  _exitStandardView() {
    if (!this._stdView) return;
    const back = this._stdViewFov;
    this._stdView = null;
    this._stdViewFov = null;
    if (back != null && Math.abs(back - this.camera.fov) > 1e-6) this.setPerspectiveFov(back);
    this.emit('camera:standardView', null);
  }

  /**
   * One wheel notch of perspective. Positive = more perspective (wider lens,
   * camera closer); negative flattens towards orthographic. Ctrl / Shift scale
   * the notch exactly as they scale the ordinary wheel dolly.
   */
  nudgePerspective(notches, speed = 1) {
    if (!this.camera) return this.camera?.fov ?? 45;
    const next = stepK(kOf(this.camera.fov), notches, speed);
    this.setPerspectiveFov(fovOf(next));
    return this.camera.fov;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  🎯 PINNED ORBIT CENTRE (V0.3.2.231)
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Pin the orbit centre to a world point (or unpin with null). The point is
   * the same `controls.pivot` the camera state already carries per step, so
   * saving, copy-paste and the between-step camera tween all come for free —
   * the only new behaviour is that orbiting stops re-picking it.
   *
   * No roll risk: the orbit rebuilds its basis from world Y every frame
   * (right = forward × Y, up = right × forward), so the horizon stays level
   * whatever the pivot is.
   */
  setOrbitPivot(worldPoint) {
    this._animPivot = worldPoint ? worldPoint.clone() : null;
    this.updateOrbitPivotMarker();
    this.emit('controls:change');
  }

  getOrbitPivot() {
    return this._animPivot ? this._animPivot.clone() : null;
  }

  setOrbitPullout(mult) { this._animPullout = Math.max(0, Number(mult) || 0); }
  getOrbitPullout() { return this._animPullout || 0; }

  /**
   * Show a small crosshair at a pinned pivot so the step's orbit centre is
   * visible instead of invisible state. Lives in overlayScene, which
   * renderFrame draws depth-cleared on top — and which the export path also
   * draws, so the marker is explicitly hidden while exporting or grabbing a
   * thumbnail. Authoring aid only, exactly like the work camera.
   */
  updateOrbitPivotMarker() {
    if (!this.overlayScene || !window.THREE) return;
    const T = window.THREE;
    const want = !!this._animPivot;
    if (!this._orbitPivotMarker) {
      if (!want) return;
      const g = new T.Group();
      g.name = 'sbs-orbit-pivot';
      const mat = new T.LineBasicMaterial({ color: 0xf59e0b, depthTest: false, transparent: true, opacity: 0.95 });
      const arm = (a, b) => {
        const geo = new T.BufferGeometry().setFromPoints([a, b]);
        return new T.Line(geo, mat);
      };
      const R = 1;   // unit crosshair — scaled to a constant screen size below
      g.add(arm(new T.Vector3(-R, 0, 0), new T.Vector3(R, 0, 0)));
      g.add(arm(new T.Vector3(0, -R, 0), new T.Vector3(0, R, 0)));
      g.add(arm(new T.Vector3(0, 0, -R), new T.Vector3(0, 0, R)));
      const ring = new T.Mesh(
        new T.SphereGeometry(0.18, 12, 8),
        new T.MeshBasicMaterial({ color: 0xf59e0b, depthTest: false, transparent: true, opacity: 0.9 }),
      );
      g.add(ring);
      g.renderOrder = 9999;
      this._orbitPivotMarker = g;
      this.overlayScene.add(g);
    }
    const m = this._orbitPivotMarker;
    m.visible = want && !state.get('_exporting');
    if (!m.visible) return;
    m.position.copy(this._animPivot);
    // Constant on-screen size: scale with distance so it never becomes a dot
    // on a big assembly or a wall on a small one.
    const d = Math.max(this.camera.position.distanceTo(this._animPivot), 1e-3);
    // …and with the LENS, not distance alone (V0.3.4.22): the on-screen size of
    // a world-sized thing is d·tan(fov/2), so the old plain `d * 0.045` grew to
    // ten times the frame once a step went orthographic. 0.1087 keeps the marker
    // exactly the size it has always been at the default 45°.
    const s = d * kOf(this.camera.fov) * 0.1087;
    m.scale.set(s, s, s);
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
    // Any camera move that is not applyStandardView itself leaves the standard
    // view (it re-sets the flag straight after calling in).
    this._stdView = null;

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

    // 🎯 ORBIT MOVE (V0.3.2.232). Lerping position and slerping rotation
    // independently walks the camera along a near-straight line and lets the
    // subject drift across the frame. When a pivot is PINNED, interpolate in
    // SPHERICAL space around it instead — azimuth about world up, elevation,
    // and dolly distance, all together — and rebuild the look direction from
    // the pivot each frame. The pinned point then stays put in frame, which
    // is the whole point of choosing it.
    //
    // Strictly opt-in: with no pin on either end, `orbit` is null and every
    // line below runs exactly as it did before.
    const fromAnim = Array.isArray(fromState.orbitPivot)   ? new THREE.Vector3(...fromState.orbitPivot)   : null;
    const toAnim   = Array.isArray(targetState.orbitPivot) ? new THREE.Vector3(...targetState.orbitPivot) : null;
    // The pull-out belongs to the step being moved INTO — it describes that
    // step's arrival, not the departure from the previous one.
    const orbit = _buildOrbitTween(fromPos, toPos, fromAnim, toAnim, fromQ, toQ,
      Number(targetState.orbitPullout) || 0);

    // 🔲 DOLLY ZOOM (V0.3.4.22). Strictly opt-in, exactly like the orbit rig:
    // only when the two ends really hold different amounts of perspective. With
    // one fov across a project — which is every project written before this
    // version — `dolly` is null and every line below runs as it always has.
    const dolly = perspectiveDiffers(fromFov, toFov)
      ? _buildDollyZoom(fromPos, fromQ, fromAnim || fromPivot, fromFov,
                        toPos,   toQ,   toAnim   || toPivot,   toFov)
      : null;

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
        orbit, dolly,
        // Arriving by ANIMATION must leave the same orbit centre as arriving
        // instantly through applyCameraState — otherwise the step is reached
        // still carrying the previous step's, and the marker and right-click
        // menu disagree with the step you are on.
        toAnim,
        toPullout: Number(targetState.orbitPullout) || 0,
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

    // Pivot first — the orbit path is expressed relative to it.
    const pivot = t.fromPivot.clone().lerp(t.toPivot, alpha);
    this.controls.pivot.copy(pivot);

    if (t.orbit) {
      // 🎯 Orbit move: azimuth, elevation and dolly advance together around
      // the pivot, then the aim offset is blended on top. The rig's own
      // pivot track (p0→p1) is used here, NOT the camera-state pivots — they
      // can differ when only one end is pinned, and mixing the two is what
      // made the camera jump on the first frame.
      const o   = t.orbit;
      const p   = o.p0.clone().lerp(o.p1, alpha);
      const az  = o.fromAz + o.dAz * alpha;
      const el  = o.fromEl + (o.toEl - o.fromEl) * alpha;
      let   r   = o.fromR  + (o.toR  - o.fromR)  * alpha;
      // Pull-out: a raised-cosine hump on the dolly distance — zero at both
      // ends with zero slope (so departure and arrival are untouched and the
      // rise eases out and back in), peaking mid-move at (1 + pull)× the
      // distance the camera would otherwise be at. Lets a big swing rise
      // away to show the whole object and dive back into the final framing.
      if (o.pull > 0) r *= 1 + o.pull * (1 - Math.cos(2 * Math.PI * alpha)) / 2;
      const ce  = Math.cos(el);
      const dir = new THREE.Vector3(ce * Math.sin(az), Math.sin(el), ce * Math.cos(az));
      this.camera.position.copy(p).addScaledVector(dir, r);
      const lvl = _levelQuat(this.camera.position, p);
      if (lvl) {
        // Level aim × the blended offset → frame 0 is exactly step A's
        // recorded view and the last frame exactly step B's, with the
        // re-aiming spread smoothly across the move instead of snapping.
        const d = o.dFrom.clone().slerp(o.dTo, alpha);
        this.camera.quaternion.copy(lvl).multiply(d);
        this.camera.up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      }
    } else {
      // Interpolate position
      const pos = t.fromPos.clone().lerp(t.toPos, alpha);
      this.camera.position.copy(pos);

      // Slerp quaternion
      const q = t.fromQ.clone().slerp(t.toQ, alpha);
      this.camera.quaternion.copy(q);
    }

    if (t.dolly) {
      // 🔲 The perspective changes across this move, so the distance is not a
      // thing to interpolate — it is a thing to DERIVE. Blend the framing and
      // the perspective amount, then slide the camera along its own view axis
      // until the frame height at the focus plane is exactly the blended one.
      // The branches above already chose the DIRECTION (orbit arc or straight
      // line) and the orientation; only the radius is overridden here, so the
      // path, the aim offset and the level-up all keep working as before.
      const dz = t.dolly;
      const r = blendPerspective({ fov: dz.fromFov, dist: dz.d0 },
                                 { fov: dz.toFov,   dist: dz.d1 }, alpha);
      let dist = r.dist;
      // The pull-out hump lives on the radius in the orbit branch — which this
      // block replaces. Re-apply it to the framing instead, or it is erased.
      if (t.orbit?.pull > 0) dist *= 1 + t.orbit.pull * (1 - Math.cos(2 * Math.PI * alpha)) / 2;

      const F = dz.F0.clone().lerp(dz.F1, alpha);        // the focus point, this frame
      const back = this.camera.position.clone().sub(F);  // eye ← focus, whatever path chose it
      if (back.lengthSq() < 1e-12) back.set(0, 0, 1).applyQuaternion(this.camera.quaternion);
      this.camera.position.copy(F).addScaledVector(back.normalize(), dist);

      if (Math.abs(r.fov - this.camera.fov) > 1e-6) {
        this.camera.fov = r.fov;
        this.camera.updateProjectionMatrix();
      }
    } else {
      // Interpolate FOV
      const fov = t.fromFov + (t.toFov - t.fromFov) * alpha;
      if (Math.abs(fov - this.camera.fov) > 0.001) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }
    }

    if (raw >= 1) {
      this._animPivot = t.toAnim ? t.toAnim.clone() : null;
      this._animPullout = t.toPullout || 0;
      this.controls.syncSpherical();
      this.updateOrbitPivotMarker();
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
  addPlanarMirror(mesh, opts) {
    if (!mesh || !mesh.isMesh) return null;
    this._mirrors = this._mirrors || [];
    const m = new PlanarMirror(mesh, opts);
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
      panSpeed:    1,        // 1 = exactly 1:1 with the cursor (V0.3.4.23)
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
    // 🎯 NOTE (V0.3.2.234): the step's orbit centre deliberately does NOT
    // appear here. That point exists for the step-to-step ANIMATION only;
    // exploring the scene by hand keeps orbiting around whatever the cursor
    // is over, which is the CAD behaviour the user relies on.
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
      // Turning the object leaves a standard view (and brings back the lens it
      // replaced) BEFORE the rig captures its start pose — otherwise the orbit
      // would begin from a camera that is about to move under it.
      this._exitStandardView();
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
      // Straight down or straight up: forward × worldY is zero, and the old
      // fallback to world X rolled the view the instant you orbited out of a
      // top view. Keep the camera's CURRENT right instead — the screen keeps
      // its orientation and the turn starts from what you were looking at.
      if (right.lengthSq() < 1e-10) right.setFromMatrixColumn(this.camera.matrix, 0);
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
    //   Alt + wheel   → 🔲 PERSPECTIVE, not distance (V0.3.4.22): the lens opens
    //                   up or flattens towards orthographic while the camera
    //                   dollies to hold the framing. Ctrl / Shift scale that
    //                   notch too. The badge that follows the cursor while Alt
    //                   is held is wired in main.js off 'camera:perspective'.
    dom.addEventListener('wheel', (e) => {
      if (this._locked) return;
      e.preventDefault();

      // Not while Alt + middle-drag is orbiting — Alt already means "orbit"
      // for that gesture, and a wheel tick mid-orbit must not re-lens the shot.
      if (e.altKey && !ctrl.active) {
        const mult = e.ctrlKey ? 0.25 : (e.shiftKey ? 3 : 1);
        // Wheel AWAY from you (deltaY < 0, the "zoom in" direction) widens the
        // lens — the camera comes closer and the perspective grows.
        this.nudgePerspective(-Math.sign(e.deltaY), mult);
        return;
      }

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
        // TRUE 1:1 GRAB (V0.3.4.23). The pan step is how much world a screen
        // pixel is worth at the focus plane — frame height ÷ canvas height —
        // NOT the raw distance. Distance alone only works at one lens: the
        // flatter the perspective the further the camera sits for the same
        // framing, so on an orthographic view (~115× the frame height away)
        // one pixel of drag threw the scene ~50 pixels. Now what you grab
        // stays under the cursor at every perspective, which is the whole
        // point of the gesture.
        const hPx      = this.renderer?.domElement?.clientHeight || 1;
        const distance = this.focusDistance() || this.camera.position.distanceTo(ctrl.pivot);
        const factor   = Math.max(frameHeight(distance, this.camera.fov, this.camera.zoom) / hPx, 1e-6)
                       * ctrl.panSpeed;
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
