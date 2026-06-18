/**
 * SBS — Hardware placement / alignment picker (V0.2.22.61).
 *
 * Single-TARGET placement for nuts (screws). Two intents × two modes,
 * one interaction surface:
 *
 *   intent PLACE — drop a NEW instance of a template at the picked pose.
 *   intent ALIGN — re-pose an EXISTING instance (viewport right-click).
 *
 *   mode SURFACE — one click. Hit a surface → land at the hit point, the
 *     insertion axis (local +Y, head) aligned to the surface normal (head
 *     out, shank in). Empty space → drop 50 mm along the camera CENTRE
 *     ray (mid-screen), upright. Hover crosshair + normal arrow.
 *
 *   mode 3-POINT — snap 3 points around a circular feature → fit a circle
 *     (centre + normal via circumcenterAndNormal) → land at the centre,
 *     axis aligned to the circle normal (flipped toward the camera so the
 *     head faces out). Backspace removes the last point, Esc cancels.
 *
 * Reuses snap-picker (findSnapTarget), the circle fit, and the transform
 * write proven by folder-align (setInstanceWorldPose / realignInstance,
 * world→parent-local per-step delta + moveEnabled/rotateEnabled).
 * Three.js is window.THREE.
 */

import { state }       from '../core/state.js';
import { sceneCore }   from '../core/scene.js';
import { steps }       from './steps.js';
import { placeInstance, realignInstance, placeNodeAtWorldPose } from './hardware-actions.js';
import { findSnapTarget }        from './snap-picker.js';
import { circumcenterAndNormal } from './pivot-center-picker.js';
import { setStatus }   from '../ui/status.js';
import { getPathToNode, buildNodeMap } from '../core/nodes.js';

const HOVER_COLOR = 0x55ddff;   // surface crosshair (cyan)
const PT_COLOR    = 0xffee44;   // placed 3-pt markers (yellow)
const HOVER_VERT  = 0xffffff;
const HOVER_EDGE  = 0xffff66;
const HOVER_FACE  = 0xaaaaaa;
const MARKER_BASE = 0.025;      // ~25px on a 1080p viewport

let _state = null;   // { mode, intent, hoverGroup, ptGroup, points, excludeObj }

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export function isActive() { return !!_state; }

/** New instance, placed on a clicked surface. */
export function startPlaceOnSurface(templateId) {
  if (!templateId) return;
  _begin({ mode: 'surface', intent: { kind: 'place', templateId } });
  setStatus('Click a surface to place the nut — or empty space to drop it in front of the camera. Esc to cancel.', 'info', 6000);
}
/** New instance, placed at a 3-point circle centre. */
export function startPlaceBy3Points(templateId) {
  if (!templateId) return;
  _begin({ mode: '3pt', intent: { kind: 'place', templateId } });
  setStatus('Snap 3 points around a circle to place the nut at its centre. Backspace = undo point · Esc = cancel.', 'info', 7000);
}
/** Existing instance, re-aligned to a clicked surface. */
export function startAlignOnSurface(nodeId) {
  if (!nodeId) return;
  _begin({ mode: 'surface', intent: { kind: 'align', nodeId }, exclude: nodeId });
  setStatus('Click a surface to align the nut to. Esc to cancel.', 'info', 6000);
}
/** Existing instance, re-aligned to a 3-point circle centre. */
export function startAlignBy3Points(nodeId) {
  if (!nodeId) return;
  _begin({ mode: '3pt', intent: { kind: 'align', nodeId }, exclude: nodeId });
  setStatus('Snap 3 points around a circle to align the nut to its centre. Backspace = undo point · Esc = cancel.', 'info', 7000);
}

/**
 * Place an EXISTING node (e.g. a freshly-created primitive) at the next click —
 * on a surface, or in front of the camera if you click empty space. Same
 * mechanics as nut placement; kept upright (orient afterwards with the gizmo).
 */
export function startPlaceNodeOnSurface(nodeId) {
  if (!nodeId) return;
  _begin({ mode: 'surface', intent: { kind: 'placeNode', nodeId }, exclude: nodeId });
  setStatus('Click a surface to drop it there, or empty space to place it in front. Esc to cancel.', 'info', 7000);
}

function _begin({ mode, intent, exclude = null }) {
  cancel();
  const T = window.THREE;
  if (!T || !sceneCore?.overlayScene) return;
  _state = {
    mode, intent,
    hoverGroup: new T.Group(),
    ptGroup:    new T.Group(),
    points:     [],
    excludeObj: exclude ? (steps.object3dById?.get(exclude) ?? null) : null,
  };
  _state.hoverGroup.name = 'sbs:hw-place-hover';
  _state.ptGroup.name    = 'sbs:hw-place-points';
  sceneCore.overlayScene.add(_state.hoverGroup);
  sceneCore.overlayScene.add(_state.ptGroup);
  state.setState({ hwPlaceActive: true });
}

export function cancel() {
  if (!_state) return;
  _disposeGroup(_state.hoverGroup);
  _disposeGroup(_state.ptGroup);
  _state = null;
  state.setState({ hwPlaceActive: false });
}

// ─── Input ──────────────────────────────────────────────────────────────────

export function updateHover(clientX, clientY) {
  if (!_state) return;
  _disposeGroup(_state.hoverGroup, /* keep */ true);
  if (_state.mode === 'surface') {
    const hit = _surfaceHitAt(clientX, clientY);
    if (hit) _state.hoverGroup.add(_buildPin(hit.point, hit.normal, HOVER_COLOR));
  } else {
    const t = findSnapTarget(clientX, clientY);
    if (t && !_isExcludedHit(t.mesh)) {
      const color = t.type === 'vertex' ? HOVER_VERT
                  : t.type === 'edge'   ? HOVER_EDGE
                  :                       HOVER_FACE;
      _state.hoverGroup.add(_buildPin(t.point, null, color));
    }
  }
}

/** Returns true when the click was consumed. */
export function onPointerDown(clientX, clientY) {
  if (!_state) return false;

  if (_state.mode === 'surface') {
    const hit = _surfaceHitAt(clientX, clientY);
    const { worldPos, worldQuat } = _resolveSurface(hit);
    _commit(worldPos, worldQuat, hit?.object);   // hit.object = host mesh → parent model
    return true;
  }

  // 3-point mode — accumulate snapped points; fit + commit at 3.
  const t = findSnapTarget(clientX, clientY);
  if (!t || _isExcludedHit(t.mesh)) return true;   // mid-aim / own mesh
  if (_state.points.length === 0) _state.refMesh = t.mesh;   // first point's mesh → parent model (per "use the first one")
  _state.points.push(t.point.clone());
  _rebuildPoints();
  if (_state.points.length === 3) {
    const fit = circumcenterAndNormal(_state.points[0], _state.points[1], _state.points[2]);
    if (!fit) {                                     // collinear → drop, retry
      _state.points.pop();
      _rebuildPoints();
      setStatus('Those 3 points are collinear — pick 3 spread around the circle.', 'warn', 3500);
      return true;
    }
    const { worldPos, worldQuat } = _resolve3pt(fit);
    _commit(worldPos, worldQuat, _state.refMesh);
  }
  return true;
}

export function onKeyDown(key) {
  if (!_state) return false;
  if (key === 'Escape') { cancel(); return true; }
  if (_state.mode === '3pt' && key === 'Backspace') {
    if (_state.points.length) { _state.points.pop(); _rebuildPoints(); }
    return true;
  }
  return false;
}

// ─── Resolve target pose ─────────────────────────────────────────────────────

function _resolveSurface(hit) {
  const T = window.THREE;
  if (hit) {
    // Head out: align +Y (head / insertion axis) to the surface normal.
    const q = new T.Quaternion().setFromUnitVectors(
      new T.Vector3(0, 1, 0), hit.normal.clone().normalize());
    return { worldPos: hit.point.clone(), worldQuat: q };
  }
  // Empty space → 50 mm along the camera's centre ray, kept upright.
  const ray = _cameraCentreRay();
  const worldPos = ray.origin.clone().addScaledVector(ray.direction, 50);
  return { worldPos, worldQuat: new T.Quaternion() };
}

function _resolve3pt(fit) {
  const T = window.THREE;
  let n = fit.normal.clone().normalize();
  // The circle normal's sign depends on click winding — flip it to face
  // the camera so the head always points OUT of the circle's plane.
  const toCam = new T.Vector3().subVectors(sceneCore.camera.position, fit.center);
  if (n.dot(toCam) < 0) n.negate();
  const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), n);
  return { worldPos: fit.center.clone(), worldQuat: q };
}

// Nearest MODEL ancestor of the picked surface mesh → the screw's parent. Walks the
// data-node path up from the picked object3d's node. Returns null when there's no model
// ancestor (e.g. a primitive / shape at scene root), so the caller falls back to the
// Hardware folder.
function _modelAncestorId(mesh) {
  if (!mesh) { console.warn('[hw-place] no picked mesh'); return null; }
  let o = mesh, nodeId = null;
  while (o && !nodeId) { nodeId = o.userData?.meshNodeId || o.userData?.nodeId; o = o.parent; }
  if (!nodeId) { console.warn('[hw-place] picked mesh has no meshNodeId/nodeId', mesh.name, mesh.userData); return null; }
  const root = state.get('treeData');
  if (!root) return null;
  const nodeById = buildNodeMap(root);          // fresh from the live tree — never a stale state map
  const path = getPathToNode(root, nodeId);     // [rootId, …, nodeId]
  for (let i = path.length - 1; i >= 0; i--) {
    const n = nodeById.get(path[i]);
    if (n && n.type === 'model') return n.id;
  }
  console.warn('[hw-place] no model ancestor for node', nodeId,
    '— path types:', path.map(id => nodeById.get(id)?.type).join(' > ') || '(empty)');
  return null;
}

function _commit(worldPos, worldQuat, refMesh) {
  const intent = _state.intent;
  if (intent.kind === 'place') {
    // Parent the screw under the host MODEL it was placed on → it becomes a child of
    // that model and follows it on move / save / load. Falls back to the Hardware
    // folder when the surface has no model ancestor.
    const parentId = _modelAncestorId(refMesh);
    const inst = placeInstance(intent.templateId, parentId, {
      worldPose: { position: worldPos, quaternion: worldQuat },
    });
    if (inst) {
      state.setSelection?.(inst.id);
      setStatus(parentId ? 'Screw placed — child of its model.' : 'Screw placed.', 'success', 2000);
    }
  } else if (intent.kind === 'align') {
    const ok = realignInstance(intent.nodeId, worldPos, worldQuat);
    if (ok) setStatus('Nut aligned.', 'success', 2000);
  } else if (intent.kind === 'placeNode') {
    // Generic node (primitive) placement — position at the clicked point, kept
    // upright (worldQuat null); the user orients afterwards with the gizmo.
    const ok = placeNodeAtWorldPose(intent.nodeId, worldPos, null);
    if (ok) { state.setSelection?.(intent.nodeId); setStatus('Placed.', 'success', 1800); }
  }
  cancel();
}

// ─── Raycast helpers ──────────────────────────────────────────────────────────

function _surfaceHitAt(clientX, clientY) {
  const all = sceneCore.pickAll?.(clientX, clientY) || [];
  if (!all.length) return null;
  const T = window.THREE;
  for (const h of all) {
    if (!h.object?.isMesh || !h.face) continue;
    if (_isExcludedHit(h.object)) continue;   // skip the aligning nut itself
    const m3 = new T.Matrix3().getNormalMatrix(h.object.matrixWorld);
    const n  = h.face.normal.clone().applyMatrix3(m3).normalize();
    return { point: h.point.clone(), normal: n, object: h.object };
  }
  return null;
}

function _isExcludedHit(obj) {
  if (!_state?.excludeObj || !obj) return false;
  let o = obj;
  while (o) { if (o === _state.excludeObj) return true; o = o.parent; }
  return false;
}

function _cameraCentreRay() {
  const T = window.THREE;
  const ray = new T.Raycaster();
  ray.setFromCamera(new T.Vector2(0, 0), sceneCore.camera);   // (0,0) NDC = centre
  return { origin: ray.ray.origin.clone(), direction: ray.ray.direction.clone() };
}

// ─── Overlay markers ──────────────────────────────────────────────────────────

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

function _rebuildPoints() {
  if (!_state) return;
  _disposeGroup(_state.ptGroup, /* keep */ true);
  for (const p of _state.points) _state.ptGroup.add(_buildPin(p, null, PT_COLOR));
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
