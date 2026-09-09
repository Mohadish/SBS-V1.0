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
 * 🧭 V0.3.2.164 — parent-chain audit.
 *
 * The user's first live test of the rebuild reported "no objects moved" while
 * the drift was visibly there — so the stored LOCAL transforms match what the
 * scene already shows, and re-applying them is a no-op. The remaining way a
 * correct local transform can produce a wrong world position is a wrong
 * PARENT: the live Object3D hangs under a different group than the one its
 * tree node says (a stale offset-correction folder, a folder group from an
 * earlier step). Save+reload heals exactly this, because the load re-parents
 * everything from the tree.
 *
 * This DETECTS that case and reports it; it deliberately does not re-parent.
 * Blind re-attachment without a keep-position compensation would itself move
 * objects, and per the project rule the repair is only automated after a real
 * capture proves what the fault is.
 *
 * Comparison is tolerant of anonymous wrapper groups (Replace-Model wraps,
 * pivot helpers): for each mapped node we walk UP the live parent chain to
 * the first ancestor that is itself some node's object3d, and compare that
 * node id against the nearest tree ancestor that has a live object. Cables
 * and notes are skipped — they legitimately live under their own scene roots.
 */
const _AUDIT_SKIP_TYPES = new Set(['cable', 'note']);

function _auditParentChain(root) {
  const mismatches = [];
  const byId = steps.object3dById;
  if (!byId || !root) return mismatches;

  const nodeById = state.get('nodeById');
  const nameOf = id => (id == null ? '(scene root)' : (nodeById?.get(id)?.name || id));

  // Reverse map: live Object3D → node id.
  const rev = new Map();
  for (const [id, obj] of byId) if (obj) rev.set(obj, id);

  const walk = (node, treeAncestorId) => {
    if (!node) return;
    const obj = !_AUDIT_SKIP_TYPES.has(node.type) ? byId.get(node.id) : null;
    if (obj && node !== root) {
      let p = obj.parent, liveAncestorId = null, detached = true;
      while (p) {
        if (rev.has(p)) { liveAncestorId = rev.get(p); detached = false; break; }
        if (p === sceneCore.rootGroup || p === sceneCore.scene) { detached = false; break; }
        p = p.parent;
      }
      if (liveAncestorId !== treeAncestorId || detached) {
        mismatches.push({
          id:             node.id,
          name:           node.name || node.id,
          type:           node.type,
          expectedParent: nameOf(treeAncestorId),
          actualParent:   detached ? '(DETACHED — not in scene)' : nameOf(liveAncestorId),
        });
      }
    }
    const next = obj ? node.id : treeAncestorId;
    for (const c of node.children || []) walk(c, next);
  };
  // The root's own object (if mapped) anchors the chain; its children's
  // expected ancestor is the root id when mapped, else the scene root (null).
  walk(root, byId.get(root.id) ? root.id : null);
  return mismatches;
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

  // 🧭 V0.3.2.164 — the audit runs regardless of whether anything moved:
  // "nothing moved" + parent mismatches is precisely the signature that
  // distinguishes the wrong-parent theory from the stale-local one.
  const parentMismatches = _auditParentChain(root);

  sceneCore.requestRender?.(0);
  return { moved, checked: applied, parentMismatches, reason };
}

/**
 * Rebuild and report, for automatic use after operations that rewrite many
 * steps at once.
 *
 * NOT WIRED IN (V0.3.2.161). It was, briefly, and that was premature: it
 * automated a mechanism nobody has yet confirmed actually corrects the
 * fault. The drift is rare, so the honest order is to leave this a manual
 * utility, wait for a recurrence, and see whether window.sbsRebuild()
 * repairs it. If it does, re-enable this at the scope prompts — the
 * argument for putting it there is sound, it just has to come second.
 *
 * Silent when nothing moved; loud when something did, because that is a
 * reproduction case that has so far been impossible to capture.
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
