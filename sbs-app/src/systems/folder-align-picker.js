/**
 * SBS Step Browser — 1-Point Folder Align Tool
 * ===============================================
 * Aligns a folder's content to a target surface by picking ONE point
 * on a child mesh (source) and ONE point on any other geometry (target).
 *
 * The folder's per-step localOffset / localQuaternion are computed so
 * the picked source point + normal lands on the picked target point +
 * opposite-normal — surface-mating contact at the picked points.
 *
 * Lifecycle
 * ---------
 *   1. actions.startFolderAlign(folderId) → state.alignFolderId set
 *   2. Pointer-move: hover marker on whichever geometry matches the
 *      current phase (source or target).
 *   3. Click on a face → capture point + normal:
 *        Phase 1 (source): must be a descendant mesh of the folder.
 *        Phase 2 (target): any other geometry.
 *   4. After target capture → APPLY the transform immediately. The
 *      user sees the result. A small confirm/cancel HUD lets them:
 *        Enter   → commit (push undo entry, exit tool)
 *        Esc / right-click → revert (restore pre-align xform, exit)
 *
 * Three.js is window.THREE.
 *
 * Per-step semantics: writes node.localOffset / localQuaternion only.
 * baseLocal* untouched. Matches V0.2.22 architecture — other steps stay
 * intact; the align affects the active step's pose only.
 */

import { state } from '../core/state.js';
import { sceneCore } from '../core/scene.js';
import { setStoredQuaternion } from '../core/transforms.js';

const HOVER_COLOR_SRC = 0x55ddff;   // cyan-ish for source phase
const HOVER_COLOR_TGT = 0xff8c1a;   // orange for target phase
const MARKER_BASE     = 0.025;      // ~25 px on a 1080p viewport

let _state = null;

// ─── Public lifecycle ─────────────────────────────────────────────────────

export function isActive() { return !!_state; }
export function getFolderId() { return _state?.folderId ?? null; }
export function getPhase() { return _state?.phase ?? null; }

/**
 * Enter align mode for a given folder. Captures the folder's current
 * localOffset/Quaternion so cancel can revert. Source-pick phase begins.
 */
export function start(folderId, { onChange } = {}) {
  if (!folderId) return;
  if (_state && _state.folderId === folderId) return;
  if (_state) cancel();
  const nodeById = state.get('nodeById');
  const folder = nodeById?.get(folderId);
  if (!folder || folder.type !== 'folder') return;
  if (!window.THREE || !sceneCore?.overlayScene) return;
  const T = window.THREE;
  _state = {
    folderId,
    folder,
    phase: 'source',   // 'source' | 'target' | 'preview'
    source: null,      // { point: Vector3, normal: Vector3, mesh }
    target: null,
    hoverGroup:   new T.Group(),
    markerGroup:  new T.Group(),
    beforeXf: {
      localOffset:      [...(folder.localOffset      || [0, 0, 0])],
      localQuaternion:  [...(folder.localQuaternion  || [0, 0, 0, 1])],
      orientationSteps: [...(folder.orientationSteps || [0, 0, 0])],
    },
    onChange: typeof onChange === 'function' ? onChange : null,
  };
  _state.hoverGroup.name  = 'sbs:folder-align-hover';
  _state.markerGroup.name = 'sbs:folder-align-markers';
  sceneCore.overlayScene.add(_state.hoverGroup);
  sceneCore.overlayScene.add(_state.markerGroup);
  state.setState({ alignFolderId: folderId, alignFolderPhase: 'source' });
}

/** Discard and exit. Restores pre-align xform if we already applied a preview. */
export function cancel() {
  if (!_state) return;
  // If we already applied (phase 'preview'), revert to before-xf.
  if (_state.phase === 'preview') _restoreBeforeXf();
  _disposeGroup(_state.hoverGroup);
  _disposeGroup(_state.markerGroup);
  _state = null;
  state.setState({ alignFolderId: null, alignFolderPhase: null });
}

/** Commit the preview as the final state, push undo, exit. */
export function commit() {
  if (!_state || _state.phase !== 'preview') return;
  // Snapshot the after-xf for redo.
  const folder = _state.folder;
  const afterXf = {
    localOffset:      [...(folder.localOffset      || [0, 0, 0])],
    localQuaternion:  [...(folder.localQuaternion  || [0, 0, 0, 1])],
    orientationSteps: [...(folder.orientationSteps || [0, 0, 0])],
  };
  const beforeXf = _state.beforeXf;
  const folderId = _state.folderId;
  const name     = folder.name || 'folder';

  // Tear down picker visuals BEFORE pushing undo so undo replay starts clean.
  _disposeGroup(_state.hoverGroup);
  _disposeGroup(_state.markerGroup);
  _state = null;
  state.setState({ alignFolderId: null, alignFolderPhase: null });

  // Lazy-import to dodge circular dep.
  import('./actions.js').then(actions => {
    actions._pushFolderAlignUndo?.(folderId, name, beforeXf, afterXf)
      ?? _fallbackPush(folderId, name, beforeXf, afterXf);
  });
}

// Fallback if actions doesn't expose the helper yet — push directly.
function _fallbackPush(folderId, name, beforeXf, afterXf) {
  Promise.all([
    import('./undo.js'),
    import('./steps.js'),
    import('./actions.js'),
  ]).then(([{ undoManager }, { steps }, _actions]) => {
    const apply = (xf) => {
      const nb = state.get('nodeById');
      const n = nb?.get(folderId);
      if (!n) return;
      n.localOffset      = [...xf.localOffset];
      n.localQuaternion  = [...xf.localQuaternion];
      n.orientationSteps = [...xf.orientationSteps];
      const obj = steps.object3dById?.get(folderId);
      if (obj) {
        obj.position.set(
          (n.baseLocalPosition?.[0] || 0) + n.localOffset[0],
          (n.baseLocalPosition?.[1] || 0) + n.localOffset[1],
          (n.baseLocalPosition?.[2] || 0) + n.localOffset[2],
        );
        const blq = n.baseLocalQuaternion || [0, 0, 0, 1];
        const T = window.THREE;
        const bq = new T.Quaternion(blq[0], blq[1], blq[2], blq[3]);
        const lq = new T.Quaternion(n.localQuaternion[0], n.localQuaternion[1], n.localQuaternion[2], n.localQuaternion[3]);
        obj.quaternion.copy(bq).multiply(lq);
      }
      steps.scheduleTransformSync();
      state.markDirty?.();
      state.emit('change:treeData', state.get('treeData'));
    };
    apply(afterXf);
    undoManager.push(
      `Align folder "${name}"`,
      () => apply(beforeXf),
      () => apply(afterXf),
    );
  });
}

/**
 * Pointer-move handler — refresh the hover marker based on current phase.
 */
export function updateHover(clientX, clientY) {
  if (!_state) return;
  if (_state.phase === 'preview') return;   // markers locked; awaiting Enter/Esc
  const hit = _faceHitAt(clientX, clientY, _state.phase);
  _setHover(hit);
}

/**
 * Pointer-down handler — capture pick for current phase, then advance.
 */
export function onPointerDown(clientX, clientY) {
  if (!_state) return false;
  if (_state.phase === 'preview') return false;   // Enter/Esc instead

  const hit = _faceHitAt(clientX, clientY, _state.phase);
  if (!hit) return true;   // mid-aim over empty space; ignore

  if (_state.phase === 'source') {
    _state.source = hit;
    _state.phase = 'target';
    _addPersistentMarker(hit, HOVER_COLOR_SRC);
    state.setState({ alignFolderPhase: 'target' });
    return true;
  }
  // target phase
  _state.target = hit;
  _addPersistentMarker(hit, HOVER_COLOR_TGT);
  _applyAlignmentPreview();
  _state.phase = 'preview';
  state.setState({ alignFolderPhase: 'preview' });
  return true;
}

/**
 * Keyboard handler — Enter commits, Esc cancels.
 * Returns true if the key was consumed.
 */
export function onKeyDown(key) {
  if (!_state) return false;
  if (_state.phase === 'preview') {
    if (key === 'Enter') { commit(); return true; }
    if (key === 'Escape') { cancel(); return true; }
  } else {
    if (key === 'Escape') { cancel(); return true; }
  }
  return false;
}

// ─── Face-hit raycast with phase-aware filtering ──────────────────────────

function _faceHitAt(clientX, clientY, phase) {
  const all = sceneCore.pickAll?.(clientX, clientY) || [];
  if (!all.length) return null;

  const folder = _state.folder;
  const folderDescIds = _collectDescendantMeshIds(folder);

  // Phase 1: pick must be on a mesh inside the folder.
  // Phase 2: pick must NOT be on a folder descendant (target is "elsewhere").
  for (const h of all) {
    if (!h.object?.isMesh || !h.face) continue;
    const meshNodeId = h.object.userData?.meshNodeId
                    ?? h.object.userData?.nodeId
                    ?? null;
    if (!meshNodeId) continue;
    const isInFolder = folderDescIds.has(meshNodeId);
    if (phase === 'source' && !isInFolder) continue;
    if (phase === 'target' &&  isInFolder) continue;

    // Build face normal in world space.
    const T = window.THREE;
    const m3 = new T.Matrix3().getNormalMatrix(h.object.matrixWorld);
    const n  = h.face.normal.clone().applyMatrix3(m3).normalize();
    return { point: h.point.clone(), normal: n, mesh: h.object };
  }
  return null;
}

function _collectDescendantMeshIds(folderNode) {
  const out = new Set();
  (function walk(n) {
    if (!n) return;
    if (n.type === 'mesh') out.add(n.id);
    for (const c of (n.children || [])) walk(c);
  })(folderNode);
  return out;
}

// ─── Alignment math ───────────────────────────────────────────────────────

/**
 * Apply the source→target alignment as a delta on the folder's world
 * matrix, then back-solve and write per-step localOffset / localQuaternion.
 * Doesn't touch baseLocal*. Doesn't push undo (commit() does that).
 *
 * Math (all in world space):
 *   - Rotation R: source.normal → -target.normal (face-to-face contact)
 *   - Pivoted around source.point so the rotated source point stays put
 *   - Translation T: source.point → target.point
 *   Combined delta M:
 *     M = Translate(target.point - source.point)
 *       × Translate(source.point) × R × Translate(-source.point)
 *
 *   F.matrixWorld_new = M × F.matrixWorld_old
 *   F.matrixLocal_new = parent.matrixWorld⁻¹ × F.matrixWorld_new
 *   Decompose, write back to localOffset / localQuaternion.
 */
function _applyAlignmentPreview() {
  const T = window.THREE;
  if (!T) return;
  const folder = _state.folder;
  const src = _state.source;
  const tgt = _state.target;
  const obj = sceneCore && _folderObject3d(folder.id);
  if (!obj || !src || !tgt) return;

  // Rotation from source.normal to -target.normal.
  const sN = src.normal.clone().normalize();
  const tN = tgt.normal.clone().normalize().negate();
  const R = new T.Quaternion().setFromUnitVectors(sN, tN);

  // Build the delta M (world space).
  const M  = new T.Matrix4();
  const Tneg = new T.Matrix4().makeTranslation(-src.point.x, -src.point.y, -src.point.z);
  const Rm   = new T.Matrix4().makeRotationFromQuaternion(R);
  const Tpos = new T.Matrix4().makeTranslation( src.point.x,  src.point.y,  src.point.z);
  const Tshift = new T.Matrix4().makeTranslation(
    tgt.point.x - src.point.x,
    tgt.point.y - src.point.y,
    tgt.point.z - src.point.z,
  );
  // M = Tshift * Tpos * R * Tneg
  M.copy(Tshift).multiply(Tpos).multiply(Rm).multiply(Tneg);

  // Apply delta to folder's world matrix.
  obj.updateMatrixWorld(true);
  const newWorld = new T.Matrix4().multiplyMatrices(M, obj.matrixWorld);

  // Back-solve to local (per folder's parent).
  const parent = obj.parent;
  if (parent) parent.updateMatrixWorld(true);
  const invParent = parent
    ? new T.Matrix4().copy(parent.matrixWorld).invert()
    : new T.Matrix4();
  const newLocal = new T.Matrix4().multiplyMatrices(invParent, newWorld);

  const newPos   = new T.Vector3();
  const newQuat  = new T.Quaternion();
  const newScale = new T.Vector3();
  newLocal.decompose(newPos, newQuat, newScale);

  // Write back to node — per V0.2.22 keep-position convention.
  const blp = folder.baseLocalPosition   || [0, 0, 0];
  const blq = folder.baseLocalQuaternion || [0, 0, 0, 1];
  folder.localOffset = [
    newPos.x - blp[0],
    newPos.y - blp[1],
    newPos.z - blp[2],
  ];
  const baseQ  = new T.Quaternion(blq[0], blq[1], blq[2], blq[3]).invert();
  const localQ = baseQ.multiply(newQuat);
  setStoredQuaternion(folder, [localQ.x, localQ.y, localQ.z, localQ.w]);

  // Push to Three.js + sync step snapshot.
  obj.position.set(newPos.x, newPos.y, newPos.z);
  obj.quaternion.copy(newQuat);
  obj.updateMatrixWorld(true);
  import('./steps.js').then(({ steps }) => {
    steps.scheduleTransformSync();
  });
  state.markDirty?.();
  state.emit('change:treeData', state.get('treeData'));
}

function _restoreBeforeXf() {
  const folder = _state.folder;
  const before = _state.beforeXf;
  folder.localOffset      = [...before.localOffset];
  folder.localQuaternion  = [...before.localQuaternion];
  folder.orientationSteps = [...before.orientationSteps];
  const obj = _folderObject3d(folder.id);
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
  import('./steps.js').then(({ steps }) => {
    steps.scheduleTransformSync();
  });
  state.emit('change:treeData', state.get('treeData'));
}

function _folderObject3d(folderId) {
  // Lazy-import steps to avoid circular.
  // For now, walk the scene to find the Object3D — slow but simple.
  // TODO: use a direct map lookup once we expose one.
  let result = null;
  if (typeof window !== 'undefined' && window.__sbsStepsRef) {
    return window.__sbsStepsRef.object3dById?.get(folderId) ?? null;
  }
  // Fallback: search the scene tree.
  if (!sceneCore?.scene) return null;
  sceneCore.scene.traverse(o => {
    if (!result && o.userData?.nodeId === folderId) result = o;
  });
  return result;
}

// ─── Visual overlays ──────────────────────────────────────────────────────

function _markerSize() {
  const T = window.THREE;
  const cam = sceneCore.camera;
  if (cam.isPerspectiveCamera) {
    const pivot = _state?.source?.point ?? cam.position;
    const dist = cam.position.distanceTo(pivot);
    const fovRad = (cam.fov ?? 50) * Math.PI / 180;
    return Math.max(0.0001, dist * Math.tan(fovRad / 2) * MARKER_BASE);
  }
  const h = Math.abs((cam.top ?? 1) - (cam.bottom ?? -1));
  return Math.max(0.0001, h * MARKER_BASE);
}

function _buildPin(worldPoint, worldNormal, color) {
  const T = window.THREE;
  const s = _markerSize();
  const group = new T.Group();
  // Cross at the picked point.
  const crossVerts = new Float32Array([
    -s, 0, 0,  s, 0, 0,
     0,-s, 0,  0, s, 0,
     0, 0,-s,  0, 0, s,
  ]);
  const crossGeom = new T.BufferGeometry();
  crossGeom.setAttribute('position', new T.BufferAttribute(crossVerts, 3));
  const crossMat = new T.LineBasicMaterial({
    color, depthTest: false, depthWrite: false,
    transparent: true, opacity: 0.95,
  });
  const cross = new T.LineSegments(crossGeom, crossMat);
  cross.position.copy(worldPoint);
  cross.renderOrder = 999;
  group.add(cross);

  // Normal arrow (a thin cylinder pointing along the normal).
  const arrowLen = s * 4;
  const radius   = Math.max(0.0001, s * 0.06);
  const cylGeom  = new T.CylinderGeometry(radius, radius, arrowLen, 8, 1, false);
  const cylMat   = new T.MeshBasicMaterial({
    color, depthTest: false, depthWrite: false,
    transparent: true, opacity: 0.85,
  });
  const cyl = new T.Mesh(cylGeom, cylMat);
  cyl.position.copy(worldPoint).addScaledVector(worldNormal, arrowLen * 0.5);
  cyl.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), worldNormal.clone().normalize());
  cyl.renderOrder = 998;
  group.add(cyl);

  return group;
}

function _setHover(hit) {
  if (!_state) return;
  _disposeGroup(_state.hoverGroup, true);
  if (!hit) return;
  const color = _state.phase === 'source' ? HOVER_COLOR_SRC : HOVER_COLOR_TGT;
  _state.hoverGroup.add(_buildPin(hit.point, hit.normal, color));
}

function _addPersistentMarker(hit, color) {
  if (!_state) return;
  _state.markerGroup.add(_buildPin(hit.point, hit.normal, color));
  // Clear hover so the persistent marker is what's shown.
  _disposeGroup(_state.hoverGroup, true);
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
