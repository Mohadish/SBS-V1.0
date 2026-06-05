/**
 * SBS — Hardware tab live preview (V0.2.22.39).
 *
 * Small dedicated Three.js scene that renders the current edit-form
 * spec into a canvas. Independent of the main viewport so a fast
 * edit-cycle (drag the slider, see the screw update) doesn't trigger
 * scene-tree rebuilds, step-snapshot dirtying, or instance-rebuild
 * cascades.
 *
 * Lifecycle:
 *   attach(canvas)   — wire the canvas to a fresh THREE scene/renderer.
 *                      Idempotent — calling twice on the same canvas is
 *                      a no-op (just re-renders).
 *   update(params)   — regenerate the screw mesh and render one frame.
 *                      Cheap: tens of ms even for complex drives.
 *   detach()         — dispose the renderer + scene; call before
 *                      removing the canvas from the DOM to avoid GPU
 *                      resource leaks across tab re-renders.
 */

import { generateScrewMesh } from '../systems/hardware-generator.js';

let _renderer = null;
let _scene    = null;
let _camera   = null;
let _mesh     = null;
let _canvas   = null;

// Orbit camera state (V0.2.22.40). Spherical coordinates around _target.
//   _radius   — distance from target
//   _theta    — yaw (around world Y)
//   _phi      — pitch (from +Y down; clamped to avoid gimbal flip at poles)
let _target = null;          // THREE.Vector3 (set in attach)
let _radius = 1;
let _theta  = Math.PI / 4;
let _phi    = Math.PI / 4;   // 45° from +Y → looks down at an angle, drive socket visible
const _PHI_MIN = 0.1;
const _PHI_MAX = Math.PI - 0.1;
const _RADIUS_MIN = 0.1;
const _RADIUS_MAX = 2000;
// Auto-fit baseline radius — used when the user hasn't manually zoomed.
// Re-derived every time the geometry changes; we keep the existing radius
// after that so the user's zoom level persists across param edits.
let _autoFitDone = false;

// Pointer interaction state.
let _dragActive = false;
let _dragLastX  = 0;
let _dragLastY  = 0;
let _wheelHandler  = null;
let _downHandler   = null;
let _moveHandler   = null;
let _upHandler     = null;

export function attach(canvas) {
  const T = window.THREE;
  if (!T) return;
  if (_canvas === canvas && _renderer) return;   // already attached
  if (_renderer) detach();

  _canvas = canvas;
  _renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
  _renderer.setPixelRatio(window.devicePixelRatio || 1);
  _renderer.setSize(canvas.clientWidth, canvas.clientHeight, /* updateStyle */ false);
  _renderer.outputColorSpace = T.SRGBColorSpace;

  _scene = new T.Scene();

  // Camera. Position is recomputed each render from spherical orbit state.
  _camera = new T.PerspectiveCamera(35, canvas.clientWidth / canvas.clientHeight, 0.1, 500);
  _target = new T.Vector3(0, 0, 0);
  _autoFitDone = false;       // recompute fit on next update()

  // Light rig: key + fill + ambient. Reads as "metal" with no shadow
  // computation cost.
  const key = new T.DirectionalLight(0xffffff, 1.4);
  key.position.set(20, 30, 20);
  _scene.add(key);
  const fill = new T.DirectionalLight(0xb0c0e0, 0.6);
  fill.position.set(-20, 10, -10);
  _scene.add(fill);
  _scene.add(new T.AmbientLight(0xffffff, 0.35));

  _bindPointerInteraction(canvas);
}

export function detach() {
  if (_canvas) _unbindPointerInteraction(_canvas);
  if (_mesh) {
    _mesh.geometry?.dispose?.();
    _mesh.material?.dispose?.();
    _scene?.remove(_mesh);
    _mesh = null;
  }
  _renderer?.dispose?.();
  _renderer = null;
  _scene    = null;
  _camera   = null;
  _canvas   = null;
  _target   = null;
  _autoFitDone = false;
}

/**
 * Regenerate the preview mesh from the given params and render one frame.
 * Safe to call before attach() — silently no-ops in that case.
 */
export function update(params) {
  if (!_renderer || !_scene) return;
  try {
    if (_mesh) {
      _mesh.geometry?.dispose?.();
      _mesh.material?.dispose?.();
      _scene.remove(_mesh);
      _mesh = null;
    }
    const mesh = generateScrewMesh(params);
    if (!mesh) return;
    _mesh = mesh;
    _scene.add(_mesh);

    // Auto-fit ONCE per attach so the first frame frames the screw
    // nicely. After that, preserve the user's manual zoom across param
    // edits — only the geometry changes, the camera stays where they
    // left it.
    if (!_autoFitDone) {
      _autoFit(_mesh);
      _autoFitDone = true;
    }
    _renderFrame();
  } catch (e) {
    console.warn('[hw-preview] update failed:', e?.message || e);
  }
}

/**
 * Re-render the current mesh after a canvas resize. Call from a
 * ResizeObserver in the host.
 */
export function resize(width, height) {
  if (!_renderer || !_camera || !_canvas) return;
  _renderer.setSize(width, height, false);
  _camera.aspect = width / height;
  _camera.updateProjectionMatrix();
  if (_mesh) _renderFrame();
}

// ─── Camera / orbit math ────────────────────────────────────────────────────

/**
 * One-shot framing: aim _target at the HEAD region (not the whole-screw
 * bbox centre), pick a baseline _radius such that the head fills the
 * canvas with a small margin. Spherical angles (_theta, _phi) keep
 * their current values so the user's orientation persists after
 * auto-fits.
 *
 * V0.2.22.45 — target the head only. Previously the camera orbited
 * the bbox centre of the entire mesh, which sat about halfway down
 * the shank — pulling the head off-screen at most rotation angles
 * and putting the orbit pivot at the wrong end of the interesting
 * geometry. The hardware generator parks the head above y=0 and the
 * shank below; the head region's y range is roughly [0, max(y)].
 */
function _autoFit(mesh) {
  const T = window.THREE;
  const fullBox = new T.Box3().setFromObject(mesh);
  if (fullBox.isEmpty()) return;

  // Head bbox = the slice of the mesh above y=0. The hardware generator
  // places the head between y=0 (head/shank interface) and y=max. Clamp
  // the box to just that vertical slice; X/Z keep the full extent (the
  // head's footprint is what matters for camera distance).
  const headBox = fullBox.clone();
  headBox.min.y = Math.max(0, fullBox.min.y);
  // If somehow the mesh has no head portion (defensive), fall back to
  // the full bbox.
  const useBox = (headBox.min.y < headBox.max.y) ? headBox : fullBox;

  const size   = useBox.getSize(new T.Vector3());
  const centre = useBox.getCenter(new T.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const fovRad = (_camera.fov * Math.PI) / 180;
  _radius = (maxDim / 2) / Math.tan(fovRad / 2) * 2.2;     // small margin
  _target.copy(centre);
}

/**
 * Recompute the camera pose from (_target, _radius, _theta, _phi) and
 * render one frame. Called by every interactive event + after update().
 */
function _renderFrame() {
  if (!_renderer || !_camera || !_scene || !_target) return;
  const sinPhi = Math.sin(_phi);
  const x = _target.x + _radius * sinPhi * Math.cos(_theta);
  const y = _target.y + _radius * Math.cos(_phi);
  const z = _target.z + _radius * sinPhi * Math.sin(_theta);
  _camera.position.set(x, y, z);
  _camera.lookAt(_target);
  _camera.updateMatrixWorld(true);
  _renderer.render(_scene, _camera);
}

// ─── Pointer interaction ────────────────────────────────────────────────────

function _bindPointerInteraction(canvas) {
  // Wheel: zoom (adjust _radius). preventDefault stops the parent panel
  // from scrolling when the user is over the preview.
  _wheelHandler = (e) => {
    e.preventDefault();
    const scale = Math.exp(e.deltaY * 0.0015);   // ~1.5% per wheel tick
    _radius = Math.max(_RADIUS_MIN, Math.min(_RADIUS_MAX, _radius * scale));
    _renderFrame();
  };
  canvas.addEventListener('wheel', _wheelHandler, { passive: false });

  // Pointer drag: rotate (adjust _theta, _phi).
  _downHandler = (e) => {
    if (e.button !== 0 && e.button !== 1) return;  // only left / middle
    _dragActive = true;
    _dragLastX  = e.clientX;
    _dragLastY  = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  _moveHandler = (e) => {
    if (!_dragActive) return;
    const dx = e.clientX - _dragLastX;
    const dy = e.clientY - _dragLastY;
    _dragLastX = e.clientX;
    _dragLastY = e.clientY;
    // Pixel-to-radian sensitivity. 1/300 → a full canvas drag rotates
    // about 90°, comfortable for a 220px preview.
    _theta -= dx * 0.005;
    _phi    = Math.max(_PHI_MIN, Math.min(_PHI_MAX, _phi - dy * 0.005));
    _renderFrame();
  };
  _upHandler = (e) => {
    if (!_dragActive) return;
    _dragActive = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
  };
  canvas.addEventListener('pointerdown', _downHandler);
  canvas.addEventListener('pointermove', _moveHandler);
  canvas.addEventListener('pointerup',     _upHandler);
  canvas.addEventListener('pointercancel', _upHandler);
  canvas.addEventListener('pointerleave',  _upHandler);

  canvas.style.cursor = 'grab';
}

function _unbindPointerInteraction(canvas) {
  if (_wheelHandler) canvas.removeEventListener('wheel', _wheelHandler);
  if (_downHandler)  canvas.removeEventListener('pointerdown', _downHandler);
  if (_moveHandler)  canvas.removeEventListener('pointermove', _moveHandler);
  if (_upHandler) {
    canvas.removeEventListener('pointerup',     _upHandler);
    canvas.removeEventListener('pointercancel', _upHandler);
    canvas.removeEventListener('pointerleave',  _upHandler);
  }
  _wheelHandler = _downHandler = _moveHandler = _upHandler = null;
}
