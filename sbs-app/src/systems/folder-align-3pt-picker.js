/**
 * SBS Step Browser — 3-Point Folder Align Tool (Concentric)
 * ==========================================================
 * Aligns a folder so a circular feature on one of its children mates
 * concentrically with a circular feature elsewhere.
 *
 *   • Phase 'source': snap-pick 3 points on a circular face/edge that
 *     belongs to a folder descendant. Three points → circle center +
 *     plane normal via the same circumcenter formula as the 3-point
 *     pivot tool.
 *   • Phase 'target': snap-pick 3 points on a circular feature
 *     anywhere ELSE (must not be inside the folder being aligned).
 *   • Phase 'preview': the folder's per-step pose is updated so the
 *     source center sits on the target center with their normals
 *     opposed (face-to-face mating). Enter commits / pushes undo,
 *     Esc reverts.
 *
 * Snap-picking reuses snap-picker.js — identical 15° crease threshold,
 * visibility filter, depth cull, vertex+edge snap, etc. Per-step only:
 * writes node.localOffset / localQuaternion, baseLocal* untouched.
 *
 * Three.js is window.THREE.
 */

import { state }                       from '../core/state.js';
import { sceneCore }                   from '../core/scene.js';
import { steps }                       from './steps.js';
import { findSnapTarget }              from './snap-picker.js';
import { circumcenterAndNormal }       from './pivot-center-picker.js';
import {
  alignFolderBySurfaceMatch,
  getFolderObject3D,
  ALIGNABLE_TYPES,
}                                      from './folder-align-picker.js';
import { setStoredQuaternion }         from '../core/transforms.js';

const COLOR_SRC      = 0x55ddff;      // source pin cyan
const COLOR_TGT      = 0xff8c1a;      // target pin orange
const COLOR_CENTER   = 0xffee44;      // derived-center dot yellow
const HOVER_VERT     = 0xffffff;
const HOVER_EDGE     = 0xffff66;
const HOVER_FACE     = 0xaaaaaa;
const MARKER_BASE    = 0.018;
const CROSS_THICKNESS_FACTOR = 1.0;

let _state = null;

// ─── Public lifecycle ─────────────────────────────────────────────────────

export function isActive()    { return !!_state; }
export function getFolderId() { return _state?.folderId ?? null; }
export function getPhase()    { return _state?.phase ?? null; }

export function start(folderId) {
  if (!folderId) return;
  if (_state && _state.folderId === folderId) return;
  if (_state) cancel();
  const nodeById = state.get('nodeById');
  const folder = nodeById?.get(folderId);
  if (!folder || !ALIGNABLE_TYPES.has(folder.type)) return;
  if (!window.THREE || !sceneCore?.overlayScene) return;
  const T = window.THREE;
  _state = {
    folderId,
    folder,
    phase: 'source',           // 'source' | 'target' | 'preview'
    sourcePoints: [],          // [{ world: Vector3, type }]
    targetPoints: [],
    sourceCircle: null,        // { center, normal, radius }
    targetCircle: null,
    hoverGroup:   new T.Group(),
    sourceGroup:  new T.Group(),
    targetGroup:  new T.Group(),
    beforeXf: {
      localOffset:      [...(folder.localOffset      || [0, 0, 0])],
      localQuaternion:  [...(folder.localQuaternion  || [0, 0, 0, 1])],
      orientationSteps: [...(folder.orientationSteps || [0, 0, 0])],
    },
  };
  _state.hoverGroup.name  = 'sbs:folder-align3-hover';
  _state.sourceGroup.name = 'sbs:folder-align3-source';
  _state.targetGroup.name = 'sbs:folder-align3-target';
  sceneCore.overlayScene.add(_state.hoverGroup);
  sceneCore.overlayScene.add(_state.sourceGroup);
  sceneCore.overlayScene.add(_state.targetGroup);
  state.setState({ align3FolderId: folderId, align3FolderPhase: 'source' });
}

export function cancel() {
  if (!_state) return;
  if (_state.phase === 'preview') _restoreBeforeXf();
  _disposeGroup(_state.hoverGroup);
  _disposeGroup(_state.sourceGroup);
  _disposeGroup(_state.targetGroup);
  _state = null;
  state.setState({ align3FolderId: null, align3FolderPhase: null });
}

export function commit() {
  if (!_state || _state.phase !== 'preview') return;
  const folder = _state.folder;
  const afterXf = {
    localOffset:      [...(folder.localOffset      || [0, 0, 0])],
    localQuaternion:  [...(folder.localQuaternion  || [0, 0, 0, 1])],
    orientationSteps: [...(folder.orientationSteps || [0, 0, 0])],
  };
  const beforeXf = _state.beforeXf;
  const folderId = _state.folderId;
  const name     = folder.name || 'folder';

  _disposeGroup(_state.hoverGroup);
  _disposeGroup(_state.sourceGroup);
  _disposeGroup(_state.targetGroup);
  _state = null;
  state.setState({ align3FolderId: null, align3FolderPhase: null });

  import('./undo.js').then(({ undoManager }) => {
    const apply = (xf) => {
      const nb = state.get('nodeById');
      const n = nb?.get(folderId);
      if (!n) return;
      n.localOffset      = [...xf.localOffset];
      n.localQuaternion  = [...xf.localQuaternion];
      n.orientationSteps = [...xf.orientationSteps];
      const obj = getFolderObject3D(folderId);
      if (obj) {
        const T = window.THREE;
        obj.position.set(
          (n.baseLocalPosition?.[0] || 0) + n.localOffset[0],
          (n.baseLocalPosition?.[1] || 0) + n.localOffset[1],
          (n.baseLocalPosition?.[2] || 0) + n.localOffset[2],
        );
        const blq = n.baseLocalQuaternion || [0, 0, 0, 1];
        const bq = new T.Quaternion(blq[0], blq[1], blq[2], blq[3]);
        const lq = new T.Quaternion(n.localQuaternion[0], n.localQuaternion[1], n.localQuaternion[2], n.localQuaternion[3]);
        obj.quaternion.copy(bq).multiply(lq);
      }
      steps.scheduleTransformSync();
      state.markDirty?.();
      state.emit('change:treeData', state.get('treeData'));
    };
    undoManager.push(
      `Align by 3 points "${name}"`,
      () => apply(beforeXf),
      () => apply(afterXf),
    );
  });
}

// ─── Pointer / key plumbing ───────────────────────────────────────────────

export function updateHover(clientX, clientY) {
  if (!_state) return;
  if (_state.phase === 'preview') return;
  const target = findSnapTarget(clientX, clientY);
  _setHover(target);
}

/**
 * Pointer-down: snap-pick a point, append to the current phase's list.
 * When 3 points are collected for the source, advance to target. When
 * the target completes, fit both circles and apply the preview.
 *
 * Click on an existing pin removes it (same affordance as the 3-pt
 * pivot tool). Returns true if the click was consumed.
 */
export function onPointerDown(clientX, clientY) {
  if (!_state) return false;
  if (_state.phase === 'preview') return false;

  // Clicking an already-placed pin in the current phase removes it.
  const arr = _currentPointsArray();
  const grp = _currentGroup();
  const removeIdx = _findPinUnderCursor(clientX, clientY, grp, arr);
  if (removeIdx >= 0) {
    arr.splice(removeIdx, 1);
    _rebuildGroup(grp, arr, _currentColor());
    return true;
  }

  // Phase-aware face-membership filter: the source picks must land on
  // a folder descendant; target picks must land elsewhere. The snap
  // picker doesn't know about folder scope, so we re-check the
  // underlying mesh via a quick pickAll and reject picks whose hit
  // doesn't satisfy the phase constraint.
  const target = findSnapTarget(clientX, clientY);
  if (!target) return true;       // mid-aim; ignore

  if (!_passesPhaseFilter(clientX, clientY)) {
    // Surfacing this softly: just blink the hover, no status spam.
    return true;
  }

  arr.push({ world: target.point.clone(), type: target.type });
  _rebuildGroup(grp, arr, _currentColor());

  if (arr.length === 3) {
    if (_state.phase === 'source') {
      const fit = _fitCircle(arr);
      if (!fit) {
        // Degenerate (collinear) — drop the last pick and let the user retry.
        arr.pop();
        _rebuildGroup(grp, arr, _currentColor());
        return true;
      }
      _state.sourceCircle = fit;
      _addCenterDot(_state.sourceGroup, fit.center);
      _state.phase = 'target';
      state.setState({ align3FolderPhase: 'target' });
    } else {
      const fit = _fitCircle(arr);
      if (!fit) {
        arr.pop();
        _rebuildGroup(grp, arr, _currentColor());
        return true;
      }
      _state.targetCircle = fit;
      _addCenterDot(_state.targetGroup, fit.center);
      _applyPreview();
      _state.phase = 'preview';
      state.setState({ align3FolderPhase: 'preview' });
    }
  }
  return true;
}

/**
 * Keyboard: Backspace removes the most recent pick in the current
 * phase. Enter commits when previewing. Esc cancels at any time.
 */
export function onKeyDown(key) {
  if (!_state) return false;
  if (_state.phase === 'preview') {
    if (key === 'Enter')  { commit(); return true; }
    if (key === 'Escape') { cancel(); return true; }
    return false;
  }
  if (key === 'Escape') { cancel(); return true; }
  if (key === 'Backspace') {
    const arr = _currentPointsArray();
    if (arr.length === 0) return true;
    arr.pop();
    _rebuildGroup(_currentGroup(), arr, _currentColor());
    return true;
  }
  return false;
}

// ─── Phase plumbing ───────────────────────────────────────────────────────

function _currentPointsArray() {
  return _state.phase === 'source' ? _state.sourcePoints : _state.targetPoints;
}
function _currentGroup() {
  return _state.phase === 'source' ? _state.sourceGroup : _state.targetGroup;
}
function _currentColor() {
  return _state.phase === 'source' ? COLOR_SRC : COLOR_TGT;
}

function _passesPhaseFilter(clientX, clientY) {
  const all = sceneCore.pickAll?.(clientX, clientY) || [];
  const folderDescIds = _collectDescendantMeshIds(_state.folder);
  for (const h of all) {
    const meshId = h.object?.userData?.meshNodeId ?? h.object?.userData?.nodeId;
    if (!meshId) continue;
    const inFolder = folderDescIds.has(meshId);
    if (_state.phase === 'source') return inFolder;
    if (_state.phase === 'target') return !inFolder;
  }
  return false;
}

function _collectDescendantMeshIds(rootNode) {
  // Self + every descendant id (any type) — see folder-align-picker.js for why
  // (leaf primitives align to their own surface; nested non-mesh kids qualify).
  const out = new Set();
  (function walk(n) {
    if (!n) return;
    out.add(n.id);
    for (const c of (n.children || [])) walk(c);
  })(rootNode);
  return out;
}

// ─── Circle fit + apply ───────────────────────────────────────────────────

function _fitCircle(arr) {
  if (arr.length !== 3) return null;
  return circumcenterAndNormal(arr[0].world, arr[1].world, arr[2].world);
}

function _applyPreview() {
  const src = _state.sourceCircle;
  const tgt = _state.targetCircle;
  if (!src || !tgt) return;
  alignFolderBySurfaceMatch(
    _state.folder,
    src.center, src.normal,
    tgt.center, tgt.normal,
  );
}

function _restoreBeforeXf() {
  const folder = _state.folder;
  const before = _state.beforeXf;
  folder.localOffset      = [...before.localOffset];
  folder.localQuaternion  = [...before.localQuaternion];
  folder.orientationSteps = [...before.orientationSteps];
  const obj = getFolderObject3D(folder.id);
  if (obj) {
    const T = window.THREE;
    const blp = folder.baseLocalPosition   || [0, 0, 0];
    const blq = folder.baseLocalQuaternion || [0, 0, 0, 1];
    obj.position.set(blp[0] + before.localOffset[0],
                     blp[1] + before.localOffset[1],
                     blp[2] + before.localOffset[2]);
    const bq = new T.Quaternion(blq[0], blq[1], blq[2], blq[3]);
    const lq = new T.Quaternion(before.localQuaternion[0], before.localQuaternion[1],
                                before.localQuaternion[2], before.localQuaternion[3]);
    obj.quaternion.copy(bq).multiply(lq);
    obj.updateMatrixWorld(true);
  }
  steps.scheduleTransformSync();
  state.emit('change:treeData', state.get('treeData'));
}

// ─── Visual overlay primitives ────────────────────────────────────────────

function _markerSize(refPoint) {
  const T = window.THREE;
  const cam = sceneCore.camera;
  if (cam.isPerspectiveCamera) {
    const pivot = refPoint ?? _anyPlaced() ?? cam.position;
    const dist = cam.position.distanceTo(pivot);
    const fovRad = (cam.fov ?? 50) * Math.PI / 180;
    return Math.max(0.0001, dist * Math.tan(fovRad / 2) * MARKER_BASE);
  }
  const h = Math.abs((cam.top ?? 1) - (cam.bottom ?? -1));
  return Math.max(0.0001, h * MARKER_BASE);
}

function _anyPlaced() {
  return _state?.sourcePoints?.[0]?.world
      ?? _state?.targetPoints?.[0]?.world
      ?? null;
}

function _buildCross(worldPoint, color) {
  const T = window.THREE;
  const s = _markerSize(worldPoint);
  const group = new T.Group();
  const axes = [[s,0,0],[0,s,0],[0,0,s]];
  for (const [dx, dy, dz] of axes) {
    const p1 = new T.Vector3(worldPoint.x - dx, worldPoint.y - dy, worldPoint.z - dz);
    const p2 = new T.Vector3(worldPoint.x + dx, worldPoint.y + dy, worldPoint.z + dz);
    group.add(_buildSegmentCylinder(p1, p2, color, CROSS_THICKNESS_FACTOR));
  }
  group.renderOrder = 999;
  return group;
}

function _buildSegmentCylinder(p1, p2, color, thicknessFactor = 1.0) {
  const T = window.THREE;
  const dir = new T.Vector3().subVectors(p2, p1);
  const len = dir.length();
  if (len < 1e-9) return new T.Group();
  // Match the pivot picker's pixel size — radius scaled by marker size.
  const radius = Math.max(0.0001, _markerSize(p1) * 0.06 * thicknessFactor);
  const geom = new T.CylinderGeometry(radius, radius, len, 8, 1, false);
  const mat  = new T.MeshBasicMaterial({
    color, depthTest: false, depthWrite: false,
    transparent: true, opacity: 0.9,
  });
  const mesh = new T.Mesh(geom, mat);
  mesh.position.copy(p1).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir.clone().normalize());
  mesh.renderOrder = 998;
  return mesh;
}

function _buildDot(worldPoint, color, scale = 0.6) {
  const T = window.THREE;
  const s = _markerSize(worldPoint) * scale;
  const geom = new T.SphereGeometry(s, 16, 12);
  const mat  = new T.MeshBasicMaterial({
    color, depthTest: false, depthWrite: false,
    transparent: true, opacity: 0.95,
  });
  const m = new T.Mesh(geom, mat);
  m.position.copy(worldPoint);
  m.renderOrder = 1000;
  return m;
}

function _setHover(target) {
  if (!_state) return;
  _disposeGroup(_state.hoverGroup, /* keep */ true);
  if (!target) return;
  const colour = target.type === 'vertex' ? HOVER_VERT
              : target.type === 'edge'   ? HOVER_EDGE
              :                            HOVER_FACE;
  if (target.type === 'edge' && target.edgeA && target.edgeB) {
    _state.hoverGroup.add(_buildSegmentCylinder(target.edgeA, target.edgeB, 0xffee44, 1.2));
  }
  _state.hoverGroup.add(_buildCross(target.point, colour));
}

function _rebuildGroup(group, points, color) {
  _disposeGroup(group, /* keep */ true);
  points.forEach(p => group.add(_buildCross(p.world, color)));
}

function _addCenterDot(group, worldPoint) {
  group.add(_buildDot(worldPoint, COLOR_CENTER, 0.5));
}

function _findPinUnderCursor(clientX, clientY, group, points) {
  // Cheap screen-space distance check — each pin's world center
  // projected to canvas, threshold ~16 px (matches 3-pt pivot tool).
  if (!sceneCore?.renderer) return -1;
  const rect = sceneCore.renderer.domElement.getBoundingClientRect();
  const cx = clientX - rect.left;
  const cy = clientY - rect.top;
  let bestIdx = -1;
  let bestD2  = 16 * 16;
  const T = window.THREE;
  const v = new T.Vector3();
  for (let i = 0; i < points.length; i++) {
    v.copy(points[i].world).project(sceneCore.camera);
    const sx = (v.x *  0.5 + 0.5) * rect.width;
    const sy = (v.y * -0.5 + 0.5) * rect.height;
    const d2 = (sx - cx) ** 2 + (sy - cy) ** 2;
    if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
  }
  return bestIdx;
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
