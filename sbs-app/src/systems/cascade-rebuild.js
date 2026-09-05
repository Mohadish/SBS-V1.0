/**
 * SBS — Cascade rebuild + divergence detector (V0.3.2.160)
 * =========================================================
 *
 * The problem this exists for, in the user's own framing: "the storage is
 * correct, the in-app interpretation is not."
 *
 * A project's stored data — the tree and each node's LOCAL transform — is the
 * source of truth, and it has never been observed wrong. What drifts is the
 * DERIVED layer: the live Three.js world matrices produced by walking that
 * tree. Loading a project re-derives all of it from scratch and always lands
 * correctly. Incremental edits re-derive only part of it, and after a real
 * structural change — moving an object into a folder with "keep position",
 * then out of the offset-correction folder it created — an object can end up
 * drawn somewhere its own data does not say it is.
 *
 * Saving and reloading fixes it, which is the proof: nothing was ever wrong
 * on disk.
 *
 * WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT
 * -------------------------------------------------
 * It re-derives the DERIVED layer only: re-applies each node's stored local
 * transform onto its live Object3D and forces a full world-matrix cascade
 * from the root. It does not touch the tree, the steps, the snapshots or the
 * project file. The worst case is that it changes nothing.
 *
 * It is NOT an in-memory save/load round trip. That was the obvious idea and
 * it is too dangerous here: applyProjectToState is entangled with id
 * remapping, primitive-registry seeding and model reattachment, and running
 * it against a live scene risks the very data it is meant to protect.
 *
 * THE DETECTOR IS THE POINT
 * -------------------------
 * rebuild() measures every node's world position before and after and reports
 * what MOVED. A rebuild that silently heals is a rebuild nobody ever learns
 * from — and this bug has already survived a long time by being invisible.
 * Each report names the objects and the distance, so the operation that
 * caused the drift is identified while the user works, instead of being
 * hunted later from "it happens sometimes".
 */

import { state }     from '../core/state.js';
import { steps }     from './steps.js';
import { sceneCore } from '../core/scene.js';
import { applyNodeTransformToObject3D } from '../core/transforms.js';

/** Movement below this is float noise, not drift. Millimetres in world units. */
const DRIFT_EPSILON = 1e-3;

function _flattenTree(node, out = []) {
  if (!node) return out;
  out.push(node);
  for (const c of node.children || []) _flattenTree(c, out);
  return out;
}

/** World position of every live object, keyed by node id. */
function _snapshotWorldPositions() {
  const map = new Map();
  const byId = steps.object3dById;
  if (!byId) return map;
  for (const [id, obj] of byId) {
    if (!obj || typeof obj.getWorldPosition !== 'function') continue;
    try {
      const v = obj.getWorldPosition(new THREE.Vector3());
      map.set(id, [v.x, v.y, v.z]);
    } catch { /* object mid-teardown — skip */ }
  }
  return map;
}

function _dist(a, b) {
  if (!a || !b) return 0;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Re-derive the live scene's transforms from the stored tree.
 *
 * @param {string} reason  what triggered it — appears in the report
 * @returns {{ moved: Array, checked: number, reason: string }}
 */
export function rebuildCascade(reason = 'manual') {
  const root = state.get('treeData');
  if (!root) return { moved: [], checked: 0, reason };

  const before = _snapshotWorldPositions();

  // Re-apply each node's OWN stored local transform onto its live object.
  // This is the step incremental edits can miss: the data was updated, the
  // object3d was not, or was updated before its new parent chain settled.
  const nodes = _flattenTree(root);
  const byId  = steps.object3dById;
  let applied = 0;
  for (const node of nodes) {
    const obj = byId?.get(node.id);
    if (!obj) continue;
    try { applyNodeTransformToObject3D(node, obj, false); applied++; }
    catch (e) { console.warn('[cascade] could not re-apply transform for', node.name || node.id, e?.message); }
  }

  // ONE cascade at the end, not one per node: parents must settle before
  // children read them, and doing it per node is both wrong and O(n depth).
  try { sceneCore.rootGroup?.updateWorldMatrix(false, true); }
  catch (e) { console.warn('[cascade] world-matrix update failed:', e?.message); }

  const after = _snapshotWorldPositions();

  const moved = [];
  for (const [id, pos] of after) {
    const d = _dist(before.get(id), pos);
    if (d > DRIFT_EPSILON) {
      const node = state.get('nodeById')?.get(id);
      moved.push({ id, name: node?.name || id, distance: +d.toFixed(4) });
    }
  }
  moved.sort((a, b) => b.distance - a.distance);

  sceneCore.requestRender?.(0);
  return { moved, checked: applied, reason };
}

/**
 * Rebuild and report. Called after operations that rewrite many steps at
 * once — exactly the ones that provoke the drift, and already slow enough
 * that a rebuild disappears into them.
 *
 * Silent when nothing moved, which is the common case; loud when something
 * did, because that is a reproduction case we have been unable to catch.
 */
export function rebuildAfter(reason) {
  const r = rebuildCascade(reason);
  if (!r.moved.length) return r;

  const top = r.moved.slice(0, 8)
    .map(m => `${m.name} (${m.distance})`)
    .join(', ');
  console.warn(
    `[cascade] REBUILD CORRECTED ${r.moved.length} object position(s) after "${reason}". ` +
    `The live scene had drifted from the stored data — this is the bug that ` +
    `save-and-reload was working around. Worst offenders: ${top}` +
    (r.moved.length > 8 ? ` … and ${r.moved.length - 8} more.` : ''),
  );
  return r;
}
