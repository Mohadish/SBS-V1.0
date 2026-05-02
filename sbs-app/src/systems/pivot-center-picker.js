/**
 * SBS Step Browser — 3-Point Center Pivot Tool
 * ===============================================
 * Lets the user pick three points on geometry and use them to position
 * a node's pivot at the center of the unique circle through those 3
 * points, oriented so its Z axis aligns with the plane normal.
 *
 * Use case: drop a pivot perfectly on the axis of a cylinder by
 * clicking three rim vertices (or edge points).
 *
 * Lifecycle
 * ---------
 *   1. actions.startPivotCenterPicking(nodeId) sets tool state.
 *   2. Pointer-move shows the snap-hover marker (vertex / edge / face).
 *   3. Click on geometry places a numbered cross at the snapped point.
 *   4. After 3 crosses are placed, a preview pivot is shown:
 *        orange dot at the circle center plus tiny RGB axis lines.
 *   5. A click on EMPTY space (no snap target) commits the pivot —
 *      same as Enter, same as right-click → Apply.
 *   6. Click on an existing cross removes that single placement.
 *   7. Backspace removes the most recent placement (local undo loop).
 *   8. Esc / right-click → Cancel discards everything.
 *
 * Three.js is window.THREE.
 */

import { state }     from '../core/state.js';
import { sceneCore } from '../core/scene.js';
import { findSnapTarget, worldToCanvasPixels } from './snap-picker.js';

// Cross / dot colors for the placed-point markers (1, 2, 3).
const CROSS_COLORS = [0xff8855, 0x55ddff, 0xeeee44];
const HOVER_COLOR  = 0xffffff;
const PREVIEW_DOT  = 0xff8c1a;   // matches existing pivot orange-dot tone
const AXIS_COLORS  = { x: 0xff3344, y: 0x33dd55, z: 0x4488ff };

// Hit radius for "click on existing cross to remove it" (canvas pixels).
const CROSS_HIT_PX = 16;

// Scale of the cross marker in WORLD units. Sized via a screen-space
// reference at draw time so they stay roughly the same on-screen size
// regardless of camera distance.
const MARKER_BASE = 0.018;       // fraction of viewport height ≈ marker half-size

let _state = null;
//  {
//    nodeId,                    // node whose pivot will be set
//    points: [ {world: Vector3, type: 'vertex'|'edge'|'face'} ],
//    hoverGroup, placedGroup, previewGroup,
//    onChange,                  // callback fired on point-list change for HUD
//  }

// ─── Public lifecycle ─────────────────────────────────────────────────────

export function isActive() {
  return !!_state;
}

export function getNodeId() {
  return _state?.nodeId ?? null;
}

export function getPoints() {
  return _state?.points?.slice() ?? [];
}

/**
 * Enter 3-point picking mode for the given node. Idempotent — calling
 * twice with the same nodeId is a no-op; calling with a different id
 * cancels the previous session first.
 */
export function start(nodeId, { onChange } = {}) {
  if (!nodeId) return;
  if (_state && _state.nodeId === nodeId) return;
  if (_state) cancel();
  if (!window.THREE || !sceneCore?.overlayScene) return;
  const T = window.THREE;
  _state = {
    nodeId,
    points: [],
    hoverGroup:   new T.Group(),
    placedGroup:  new T.Group(),
    previewGroup: new T.Group(),
    onChange: typeof onChange === 'function' ? onChange : null,
  };
  _state.hoverGroup.name   = 'sbs:pivot-center-hover';
  _state.placedGroup.name  = 'sbs:pivot-center-placed';
  _state.previewGroup.name = 'sbs:pivot-center-preview';
  sceneCore.overlayScene.add(_state.hoverGroup);
  sceneCore.overlayScene.add(_state.placedGroup);
  sceneCore.overlayScene.add(_state.previewGroup);
  state.setState({ pivotCenterPickingNodeId: nodeId });
  _emit();
}

/**
 * Discard everything and exit. Safe to call when not active.
 */
export function cancel() {
  if (!_state) return;
  _disposeGroup(_state.hoverGroup);
  _disposeGroup(_state.placedGroup);
  _disposeGroup(_state.previewGroup);
  _state = null;
  state.setState({ pivotCenterPickingNodeId: null });
}

/**
 * Pointermove handler — refresh the hover marker.
 */
export function updateHover(clientX, clientY) {
  if (!_state) return;
  const target = findSnapTarget(clientX, clientY);
  _setHover(
    target?.point ?? null,
    target?.type  ?? null,
    target?.edgeA ?? null,
    target?.edgeB ?? null,
  );
}

/**
 * Pointer-down handler — interpret the click.
 *
 * Decision tree:
 *   • Click on an existing placed cross   → remove that cross.
 *   • Already 3 points placed AND no snap → APPLY (commit pivot).
 *   • Snap target found                   → place a cross (up to 3).
 *   • No snap target                      → ignore (cursor was over empty space mid-pick).
 *
 * Returns true if the click was consumed.
 */
export function onPointerDown(clientX, clientY) {
  if (!_state) return false;

  // Click on an existing cross → remove it.
  const removeIdx = _findCrossUnderCursor(clientX, clientY);
  if (removeIdx >= 0) {
    removePoint(removeIdx);
    return true;
  }

  const target = findSnapTarget(clientX, clientY);

  // Three points already placed: commit on click-on-empty.
  if (_state.points.length >= 3 && !target) {
    apply();
    return true;
  }

  if (!target) return true;       // mid-aim; keep waiting

  // Otherwise: place (or replace, if >3 already).
  if (_state.points.length >= 3) {
    // User clicked geometry while already at 3 points — drop oldest and
    // append the new one so the user can refine without forcing a
    // separate clear step.
    _state.points.shift();
    _rebuildPlacedMarkers();
  }
  _state.points.push({ world: target.point.clone(), type: target.type });
  _addCross(target.point, _state.points.length - 1);
  _refreshPreviewPivot();
  _emit();
  return true;
}

export function removePoint(idx) {
  if (!_state) return;
  if (idx < 0 || idx >= _state.points.length) return;
  _state.points.splice(idx, 1);
  _rebuildPlacedMarkers();
  _refreshPreviewPivot();
  _emit();
}

export function removeLast() {
  if (!_state || _state.points.length === 0) return;
  removePoint(_state.points.length - 1);
}

export function clearAll() {
  if (!_state) return;
  _state.points.length = 0;
  _rebuildPlacedMarkers();
  _refreshPreviewPivot();
  _emit();
}

export function canApply() {
  return !!_state && _state.points.length === 3;
}

/**
 * Commit the pivot and exit the tool. The actual pivot math + undo
 * push happen in actions.applyPivotCenter — this just gathers the
 * three world points and hands them off, then tears down the visuals.
 */
export function apply() {
  if (!_state || _state.points.length !== 3) return;
  // Lazy import to avoid actions <-> picker circular dep at load.
  import('./actions.js').then(actions => {
    const { nodeId } = _state;
    const [p1, p2, p3] = _state.points.map(p => p.world);
    cancel();
    actions.applyPivotCenter(nodeId, p1, p2, p3);
  });
}

// ─── Visual overlay primitives ────────────────────────────────────────────

function _markerSize() {
  // Half-size of the cross arms in world units, sized so they look ~12
  // CSS pixels tall on screen. Approximation good enough for a marker.
  const T = window.THREE;
  const cam = sceneCore.camera;
  if (cam.isPerspectiveCamera) {
    const dist = cam.position.distanceTo(_anyPlaced() ?? new T.Vector3(0,0,0));
    const fovRad = (cam.fov ?? 50) * Math.PI / 180;
    return Math.max(0.0001, dist * Math.tan(fovRad / 2) * MARKER_BASE);
  }
  // Orthographic camera fallback.
  const h = Math.abs((cam.top ?? 1) - (cam.bottom ?? -1));
  return Math.max(0.0001, h * MARKER_BASE);
}

function _anyPlaced() {
  return _state?.points?.[0]?.world ?? null;
}

function _buildCross(worldPoint, color) {
  const T = window.THREE;
  const s = _markerSize();
  const verts = new Float32Array([
    -s, 0, 0,  s, 0, 0,
     0,-s, 0,  0, s, 0,
     0, 0,-s,  0, 0, s,
  ]);
  const geom = new T.BufferGeometry();
  geom.setAttribute('position', new T.BufferAttribute(verts, 3));
  const mat = new T.LineBasicMaterial({
    color, depthTest: false, depthWrite: false,
    transparent: true, opacity: 0.95,
  });
  const lines = new T.LineSegments(geom, mat);
  lines.position.copy(worldPoint);
  lines.renderOrder = 999;
  return lines;
}

function _buildDot(worldPoint, color) {
  const T = window.THREE;
  const s = _markerSize() * 0.6;
  const geom = new T.SphereGeometry(s, 16, 12);
  const mat = new T.MeshBasicMaterial({
    color, depthTest: false, depthWrite: false,
    transparent: true, opacity: 0.95,
  });
  const m = new T.Mesh(geom, mat);
  m.position.copy(worldPoint);
  m.renderOrder = 1000;
  return m;
}

function _setHover(worldPoint, type, edgeA, edgeB) {
  if (!_state) return;
  _disposeGroup(_state.hoverGroup, /* keep */ true);
  if (!worldPoint) return;
  const colour = type === 'vertex' ? 0xffffff
              : type === 'edge'   ? 0xffff66
              :                     0xaaaaaa;
  // For edge snaps, draw a highlight along the WHOLE edge so the user
  // sees exactly which segment will be used — and a brighter cross at
  // the snap point along it.
  if (type === 'edge' && edgeA && edgeB) {
    _state.hoverGroup.add(_buildSegmentCylinder(edgeA, edgeB, 0xffee44, 0.35));
  }
  _state.hoverGroup.add(_buildCross(worldPoint, colour));
}

function _addCross(worldPoint, idx) {
  if (!_state) return;
  const colour = CROSS_COLORS[idx % CROSS_COLORS.length];
  _state.placedGroup.add(_buildCross(worldPoint, colour));
}

function _rebuildPlacedMarkers() {
  if (!_state) return;
  _disposeGroup(_state.placedGroup, /* keep */ true);
  _state.points.forEach((p, i) => _addCross(p.world, i));
}

function _refreshPreviewPivot() {
  if (!_state) return;
  _disposeGroup(_state.previewGroup, /* keep */ true);
  if (_state.points.length !== 3) return;
  const T = window.THREE;
  const [a, b, c] = _state.points.map(p => p.world);
  const result = circumcenterAndNormal(a, b, c);
  if (!result) return;
  const { center, normal, radius } = result;

  // Plane basis: Z = normal, X = (a - center) projected into the plane,
  // Y = Z × X. Same convention as actions.applyPivotCenter so the
  // preview matches the committed pose exactly.
  const z = normal.clone().normalize();
  let x = new T.Vector3().subVectors(a, center);
  x.sub(z.clone().multiplyScalar(x.dot(z)));
  if (x.lengthSq() < 1e-10) x.set(1, 0, 0);
  x.normalize();
  const y = new T.Vector3().crossVectors(z, x).normalize();

  // Crosshair axes — three thick cylinders extending in BOTH directions
  // through the center. Rendered behind the centre dot so the dot is
  // never occluded.
  const armLen   = _markerSize() * 2.4;
  const armRadius = _pixelToWorld(center, 1.5);  // 3-px-thick crosshair (radius = 1.5 px)
  for (const [name, dir] of [['x', x], ['y', y], ['z', z]]) {
    _state.previewGroup.add(_buildAxisCylinder(center, dir, armLen, armRadius, AXIS_COLORS[name]));
  }

  // Circle through the 3 points. LineLoop in the plane — no thickness,
  // colour-matched to the dot for a clean preview ring.
  _state.previewGroup.add(_buildPlaneCircle(center, x, y, radius, PREVIEW_DOT));

  // Orange dot LAST so it renders on top of the crosshair intersection.
  _state.previewGroup.add(_buildDot(center, PREVIEW_DOT));
}

/**
 * Build a cylinder centered at `origin`, oriented along `axisDir`
 * (extending equally in both directions, total length = `length`).
 * Used for the crosshair axes — depth-test off, renders behind the
 * centre dot.
 */
function _buildAxisCylinder(origin, axisDir, length, radius, color) {
  const T = window.THREE;
  const geom = new T.CylinderGeometry(radius, radius, length, 16, 1, false);
  const mat = new T.MeshBasicMaterial({
    color, depthTest: false, depthWrite: false,
    transparent: true, opacity: 0.95,
  });
  const mesh = new T.Mesh(geom, mat);
  mesh.position.copy(origin);
  // Default cylinder axis is +Y. Rotate +Y onto axisDir.
  const up = new T.Vector3(0, 1, 0);
  mesh.quaternion.setFromUnitVectors(up, axisDir.clone().normalize());
  mesh.renderOrder = 999;
  return mesh;
}

/**
 * Build a thin cylinder spanning two world endpoints — used for edge
 * highlight. `thicknessFactor` scales relative to the marker size so
 * the highlight is visibly thicker than a 1-px line but thinner than
 * the crosshair.
 */
function _buildSegmentCylinder(p1, p2, color, thicknessFactor = 0.3) {
  const T = window.THREE;
  const dir = new T.Vector3().subVectors(p2, p1);
  const length = dir.length();
  if (length < 1e-9) return new T.Group();
  const radius = _pixelToWorld(p1, 1.0) * 1.5 * thicknessFactor + 1e-6;
  const geom = new T.CylinderGeometry(radius, radius, length, 12, 1, false);
  const mat = new T.MeshBasicMaterial({
    color, depthTest: false, depthWrite: false,
    transparent: true, opacity: 0.6,
  });
  const mesh = new T.Mesh(geom, mat);
  mesh.position.addVectors(p1, p2).multiplyScalar(0.5);
  const up = new T.Vector3(0, 1, 0);
  mesh.quaternion.setFromUnitVectors(up, dir.clone().normalize());
  mesh.renderOrder = 998;
  return mesh;
}

/**
 * Build a closed circle (LineLoop) in the plane spanned by basis
 * vectors `u` and `v`, centered at `center`, of given `radius`.
 */
function _buildPlaneCircle(center, u, v, radius, color, segments = 96) {
  const T = window.THREE;
  const arr = new Float32Array(segments * 3);
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const cs = Math.cos(t) * radius;
    const sn = Math.sin(t) * radius;
    arr[i * 3]     = center.x + u.x * cs + v.x * sn;
    arr[i * 3 + 1] = center.y + u.y * cs + v.y * sn;
    arr[i * 3 + 2] = center.z + u.z * cs + v.z * sn;
  }
  const geom = new T.BufferGeometry();
  geom.setAttribute('position', new T.BufferAttribute(arr, 3));
  const mat = new T.LineBasicMaterial({
    color, depthTest: false, depthWrite: false,
    transparent: true, opacity: 0.85,
  });
  const loop = new T.LineLoop(geom, mat);
  loop.renderOrder = 998;
  return loop;
}

/**
 * World units per `px` CSS pixels at the depth of `worldPoint`.
 * Used to size cylinder radii so they look ~constant on screen
 * regardless of camera distance.
 */
function _pixelToWorld(worldPoint, px) {
  const cam = sceneCore.camera;
  const rect = sceneCore.renderer.domElement.getBoundingClientRect();
  if (cam.isPerspectiveCamera) {
    const dist = cam.position.distanceTo(worldPoint);
    const fovRad = (cam.fov ?? 50) * Math.PI / 180;
    const worldHeight = 2 * dist * Math.tan(fovRad / 2);
    return (px / rect.height) * worldHeight;
  }
  // Orthographic.
  const h = Math.abs((cam.top ?? 1) - (cam.bottom ?? -1));
  return (px / rect.height) * h;
}

function _disposeGroup(group, keep = false) {
  if (!group) return;
  while (group.children.length) {
    const c = group.children.pop();
    c.geometry?.dispose?.();
    c.material?.dispose?.();
  }
  if (!keep && group.parent) group.parent.remove(group);
}

function _findCrossUnderCursor(clientX, clientY) {
  if (!_state) return -1;
  const rect = sceneCore.renderer.domElement.getBoundingClientRect();
  const cx = clientX - rect.left, cy = clientY - rect.top;
  let best = -1, bestD = CROSS_HIT_PX;
  for (let i = 0; i < _state.points.length; i++) {
    const px = worldToCanvasPixels(_state.points[i].world);
    if (!px) continue;
    const d = Math.hypot(px[0] - cx, px[1] - cy);
    if (d <= bestD) { bestD = d; best = i; }
  }
  return best;
}

function _emit() {
  if (_state?.onChange) _state.onChange(_state.points.length);
}

// ─── Math: 3-point circumcenter + plane normal ────────────────────────────

/**
 * Given three non-collinear world points P1, P2, P3, return
 *   { center: Vector3, normal: Vector3, radius: number }
 * where center is the circumcenter of triangle P1·P2·P3 and normal is
 * the triangle's plane normal (right-hand rule from click order
 * P1 → P2 → P3).
 *
 * Uses the BARYCENTRIC circumcenter formula:
 *
 *     C = (α·P1 + β·P2 + γ·P3) / (α + β + γ)
 *
 *     a = |P3 − P2|     (length opposite P1)
 *     b = |P3 − P1|     (length opposite P2)
 *     c = |P2 − P1|     (length opposite P3)
 *
 *     α = a²·(b² + c² − a²)
 *     β = b²·(a² + c² − b²)
 *     γ = c²·(a² + b² − c²)
 *
 * The denominator collapses to zero when the points are collinear —
 * we bail in that case. This formula is numerically stable and harder
 * to flub than cross-product-based offsets.
 *
 * Returns null if the points are collinear or coincident.
 */
export function circumcenterAndNormal(P1, P2, P3) {
  if (!window.THREE) return null;
  const T = window.THREE;

  const a2 = new T.Vector3().subVectors(P3, P2).lengthSq();   // |P3-P2|²
  const b2 = new T.Vector3().subVectors(P3, P1).lengthSq();   // |P3-P1|²
  const c2 = new T.Vector3().subVectors(P2, P1).lengthSq();   // |P2-P1|²
  if (a2 < 1e-18 || b2 < 1e-18 || c2 < 1e-18) return null;    // coincident

  const alpha = a2 * (b2 + c2 - a2);
  const beta  = b2 * (a2 + c2 - b2);
  const gamma = c2 * (a2 + b2 - c2);
  const denom = alpha + beta + gamma;
  if (Math.abs(denom) < 1e-18) return null;                   // collinear

  const center = new T.Vector3()
    .addScaledVector(P1, alpha / denom)
    .addScaledVector(P2, beta  / denom)
    .addScaledVector(P3, gamma / denom);

  // Plane normal — right-hand rule from click order P1 → P2 → P3.
  const ab = new T.Vector3().subVectors(P2, P1);
  const ac = new T.Vector3().subVectors(P3, P1);
  const normal = new T.Vector3().crossVectors(ab, ac);
  if (normal.lengthSq() < 1e-18) return null;
  normal.normalize();

  const radius = center.distanceTo(P1);
  return { center, normal, radius };
}
