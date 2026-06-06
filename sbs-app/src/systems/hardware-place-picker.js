/**
 * SBS — Hardware placement / alignment picker (V0.2.22.61).
 *
 * Single-TARGET placement for nuts (screws). Two intents, one interaction:
 *
 *   • PLACE  — drop a NEW instance of a template at the picked pose.
 *   • ALIGN  — re-pose an EXISTING instance (viewport right-click).
 *
 * Surface mode (this phase): one click.
 *   - Click a surface → the nut lands at the hit point, its insertion axis
 *     (local +Y, head) aligned to the surface normal — head out, shank in.
 *   - Click empty space → the nut drops 50 mm along the camera's CENTRE
 *     ray (mid-screen), kept upright (world +Y).
 *
 * A hover crosshair + normal arrow previews where it'll land. Esc cancels.
 *
 * Reuses the transform-write proven by folder-align: setInstanceWorldPose /
 * realignInstance convert the world pose to the parent-local per-step delta
 * and flip moveEnabled/rotateEnabled on. Three.js is window.THREE.
 */

import { state }       from '../core/state.js';
import { sceneCore }   from '../core/scene.js';
import { steps }       from './steps.js';
import { placeInstance, realignInstance } from './hardware-actions.js';
import { setStatus }   from '../ui/status.js';

const HOVER_COLOR = 0x55ddff;   // cyan crosshair
const MARKER_BASE = 0.025;      // ~25px on a 1080p viewport

let _state = null;   // { mode, intent, hoverGroup, excludeObj }

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export function isActive() { return !!_state; }

/** Arm surface placement for a NEW instance of `templateId`. */
export function startPlaceOnSurface(templateId) {
  if (!templateId) return;
  _begin({ mode: 'surface', intent: { kind: 'place', templateId } });
  setStatus('Click a surface to place the nut — or empty space to drop it in front of the camera. Esc to cancel.', 'info', 6000);
}

/** Arm surface re-alignment for an EXISTING instance (viewport menu). */
export function startAlignOnSurface(nodeId) {
  if (!nodeId) return;
  _begin({ mode: 'surface', intent: { kind: 'align', nodeId }, exclude: nodeId });
  setStatus('Click a surface to align the nut to. Esc to cancel.', 'info', 6000);
}

function _begin({ mode, intent, exclude = null }) {
  cancel();
  const T = window.THREE;
  if (!T || !sceneCore?.overlayScene) return;
  _state = {
    mode, intent,
    hoverGroup: new T.Group(),
    excludeObj: exclude ? (steps.object3dById?.get(exclude) ?? null) : null,
  };
  _state.hoverGroup.name = 'sbs:hw-place-hover';
  sceneCore.overlayScene.add(_state.hoverGroup);
  state.setState({ hwPlaceActive: true });
}

export function cancel() {
  if (!_state) return;
  _disposeGroup(_state.hoverGroup);
  _state = null;
  state.setState({ hwPlaceActive: false });
}

// ─── Input ──────────────────────────────────────────────────────────────────

export function updateHover(clientX, clientY) {
  if (!_state) return;
  const hit = _surfaceHitAt(clientX, clientY);
  _setHover(hit);
}

/** Returns true when the click was consumed. */
export function onPointerDown(clientX, clientY) {
  if (!_state) return false;
  const hit = _surfaceHitAt(clientX, clientY);
  const { worldPos, worldQuat } = _resolveTarget(hit);
  _commit(worldPos, worldQuat);
  return true;
}

export function onKeyDown(key) {
  if (!_state) return false;
  if (key === 'Escape') { cancel(); return true; }
  return false;
}

// ─── Resolve + commit ─────────────────────────────────────────────────────

function _resolveTarget(hit) {
  const T = window.THREE;
  if (hit) {
    // Head out: align the screw's +Y (head / insertion axis) to the
    // surface normal so the shank points into the surface.
    const q = new T.Quaternion().setFromUnitVectors(
      new T.Vector3(0, 1, 0), hit.normal.clone().normalize());
    return { worldPos: hit.point.clone(), worldQuat: q };
  }
  // Empty space → 50 mm along the camera's centre ray, kept upright.
  const ray = _cameraCentreRay();
  const worldPos = ray.origin.clone().addScaledVector(ray.direction, 50);
  return { worldPos, worldQuat: new T.Quaternion() };
}

function _commit(worldPos, worldQuat) {
  const intent = _state.intent;
  if (intent.kind === 'place') {
    const inst = placeInstance(intent.templateId, null, {
      worldPose: { position: worldPos, quaternion: worldQuat },
    });
    if (inst) {
      state.setSelection?.(inst.id);
      setStatus('Nut placed.', 'success', 2000);
    }
  } else if (intent.kind === 'align') {
    const ok = realignInstance(intent.nodeId, worldPos, worldQuat);
    if (ok) setStatus('Nut aligned.', 'success', 2000);
  }
  cancel();
}

// ─── Raycast ────────────────────────────────────────────────────────────────

function _surfaceHitAt(clientX, clientY) {
  const all = sceneCore.pickAll?.(clientX, clientY) || [];
  if (!all.length) return null;
  const T = window.THREE;
  for (const h of all) {
    if (!h.object?.isMesh || !h.face) continue;
    // Skip the aligning nut's own mesh so it can't target itself.
    if (_state.excludeObj && _isSelfOrDescendant(h.object, _state.excludeObj)) continue;
    const m3 = new T.Matrix3().getNormalMatrix(h.object.matrixWorld);
    const n  = h.face.normal.clone().applyMatrix3(m3).normalize();
    return { point: h.point.clone(), normal: n, object: h.object };
  }
  return null;
}

function _isSelfOrDescendant(obj, ancestor) {
  let o = obj;
  while (o) { if (o === ancestor) return true; o = o.parent; }
  return false;
}

function _cameraCentreRay() {
  const T = window.THREE;
  const ray = new T.Raycaster();
  ray.setFromCamera(new T.Vector2(0, 0), sceneCore.camera);   // (0,0) NDC = centre
  return { origin: ray.ray.origin.clone(), direction: ray.ray.direction.clone() };
}

// ─── Hover overlay (cross + normal arrow) ──────────────────────────────────

function _markerSize(at) {
  const T = window.THREE;
  const cam = sceneCore.camera;
  if (cam.isPerspectiveCamera) {
    const pivot = at ?? cam.position;
    const dist = cam.position.distanceTo(pivot);
    const fovRad = (cam.fov ?? 50) * Math.PI / 180;
    return Math.max(0.0001, dist * Math.tan(fovRad / 2) * MARKER_BASE);
  }
  const h = Math.abs((cam.top ?? 1) - (cam.bottom ?? -1));
  return Math.max(0.0001, h * MARKER_BASE);
}

function _buildPin(point, normal, color) {
  const T = window.THREE;
  const s = _markerSize(point);
  const group = new T.Group();
  const v = new Float32Array([-s,0,0, s,0,0,  0,-s,0, 0,s,0,  0,0,-s, 0,0,s]);
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(v, 3));
  const cross = new T.LineSegments(g, new T.LineBasicMaterial({
    color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95,
  }));
  cross.position.copy(point);
  cross.renderOrder = 999;
  group.add(cross);

  if (normal) {
    const len = s * 4, r = Math.max(0.0001, s * 0.06);
    const cyl = new T.Mesh(
      new T.CylinderGeometry(r, r, len, 8, 1, false),
      new T.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85 }));
    cyl.position.copy(point).addScaledVector(normal, len * 0.5);
    cyl.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), normal.clone().normalize());
    cyl.renderOrder = 998;
    group.add(cyl);
  }
  return group;
}

function _setHover(hit) {
  if (!_state) return;
  _disposeGroup(_state.hoverGroup, true);
  if (!hit) return;
  _state.hoverGroup.add(_buildPin(hit.point, hit.normal, HOVER_COLOR));
}

function _disposeGroup(g, keep = false) {
  if (!g) return;
  while (g.children.length) {
    const c = g.children[g.children.length - 1];
    g.remove(c);
    c.geometry?.dispose?.();
    c.material?.dispose?.();
    if (c.children?.length) _disposeGroup(c, true);
  }
  if (!keep && g.parent) g.parent.remove(g);
}
