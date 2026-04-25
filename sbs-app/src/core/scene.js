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
 */

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
    this.renderer = new THREE.WebGLRenderer({
      antialias:             true,
      preserveDrawingBuffer: true,   // required for export / thumbnails
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    // ── Scenes ──────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(backgroundColor);

    this.overlayScene = new THREE.Scene();  // drawn on top, depth-cleared

    // ── Camera ──────────────────────────────────────────────────────────
    this.camera = new THREE.PerspectiveCamera(
      fov,
      container.clientWidth / container.clientHeight,
      0.1,
      1_000_000,
    );
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

    // ── Resize observer ─────────────────────────────────────────────────
    this._resizeObs = new ResizeObserver(() => this.resize());
    this._resizeObs.observe(container);

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

      // External tick hooks (animations, gizmos, notes rendering, etc.)
      this._tickHooks.forEach(fn => { try { fn(now, delta); } catch(e) { console.error(e); } });

      // Render
      this._render();
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
    // Backwards-compat: accept boolean as the old withoutOverlay flag.
    if (typeof opts === 'boolean') opts = { withoutOverlayScene: opts };

    const dom = this.renderer?.domElement;
    if (!dom || !dom.width || !dom.height) return null;

    if (opts.withoutOverlayScene) {
      this.renderer.autoClear = true;
      this.renderer.render(this.scene, this.camera);
    }

    const off = document.createElement('canvas');
    off.width  = w;
    off.height = h;
    const ctx = off.getContext('2d');
    if (!ctx) return null;
    try {
      ctx.drawImage(dom, 0, 0, w, h);
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

  _render() {
    if (!this.renderer) return;
    // Main scene
    this.renderer.autoClear = true;
    this.renderer.render(this.scene, this.camera);

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
  //  TICK HOOKS
  // ═══════════════════════════════════════════════════════════════════════
  /** Register a per-frame callback. Returns an unsubscribe function. */
  addTickHook(fn) {
    this._tickHooks.add(fn);
    return () => this._tickHooks.delete(fn);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  RESIZE
  // ═══════════════════════════════════════════════════════════════════════
  resize() {
    if (!this.renderer || !this._container) return;
    const w = this._container.clientWidth;
    const h = this._container.clientHeight;
    if (w === 0 || h === 0) return;

    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.emit('resize', { width: w, height: h });
  }

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

      this._transition = {
        startMs:  null,
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

    if (t.startMs === null) t.startMs = nowMs;

    const elapsed = nowMs - t.startMs;
    const raw     = Math.min(elapsed / t.durationMs, 1);
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
    const _updatePivotFromHit = (clientX, clientY) => {
      const hit = this.pick(clientX, clientY);
      if (hit) {
        ctrl.pivot.copy(hit.point);
        ctrl.syncSpherical();
        return;
      }
      // Fall back to scene center
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

    // ── Wheel: adaptive zoom ─────────────────────────────────────────────
    dom.addEventListener('wheel', (e) => {
      if (this._locked) return;
      e.preventDefault();

      const delta   = Math.sign(e.deltaY);
      const forward = new THREE.Vector3();
      this.camera.getWorldDirection(forward);

      const box       = new THREE.Box3().setFromObject(this.rootGroup);
      const sceneSize = box.isEmpty()
        ? 100
        : box.getSize(new THREE.Vector3()).length();
      const step = Math.max(sceneSize * 0.015, 0.5) * ctrl.zoomSpeed;

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
