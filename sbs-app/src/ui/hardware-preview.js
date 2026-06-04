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

  // Camera angled to show the head from slightly above so the drive
  // recess is clearly visible. Adjust position based on the screw's
  // bounding box at render time.
  _camera = new T.PerspectiveCamera(35, canvas.clientWidth / canvas.clientHeight, 0.1, 500);
  _camera.position.set(35, 28, 35);
  _camera.lookAt(0, -8, 0);

  // Light rig: one key directional + one fill from the opposite side +
  // a tiny ambient so the recess isn't pitch black. Standard product-shot
  // lighting — fast to compute (no shadows), reads as "metal".
  const key = new T.DirectionalLight(0xffffff, 1.4);
  key.position.set(20, 30, 20);
  _scene.add(key);
  const fill = new T.DirectionalLight(0xb0c0e0, 0.6);
  fill.position.set(-20, 10, -10);
  _scene.add(fill);
  _scene.add(new T.AmbientLight(0xffffff, 0.35));
}

export function detach() {
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

    // Frame the camera on the bounding box so a tiny M2×4 and a beefy
    // M10×60 both fill the preview equally well.
    _frameMesh(_mesh);

    _renderer.render(_scene, _camera);
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
  if (_mesh) _renderer.render(_scene, _camera);
}

function _frameMesh(mesh) {
  const T = window.THREE;
  const box = new T.Box3().setFromObject(mesh);
  const size = box.getSize(new T.Vector3());
  const centre = box.getCenter(new T.Vector3());
  // Pick a distance such that the bbox's max extent fits comfortably.
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const fovRad = (_camera.fov * Math.PI) / 180;
  const dist   = (maxDim / 2) / Math.tan(fovRad / 2) * 2.0;   // 2× margin
  // Position the camera along a diagonal looking at the bbox centre,
  // angled so the head's top is visible.
  _camera.position.set(centre.x + dist * 0.7, centre.y + dist * 0.55, centre.z + dist * 0.7);
  _camera.lookAt(centre);
  _camera.updateMatrixWorld(true);
}
