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
 * WHAT THIS DOES (V0.3.2.165 — second core)
 * ------------------------------------------
 * It replays the LOAD path on the already-loaded objects: capture the scene
 * into hidden Step 0 exactly as saveProject() does, activate the base step
 * (full folder-group cleanup + rebuild-from-tree-spec + apply-all-transforms
 * — the pass that rebuilds the PARENT structure), replay the user's active
 * step, sweep orphan placeholders. Save + restart + reload, minus reading
 * the geometry files. It still never touches applyProjectToState — that
 * path is entangled with id remapping and model reattachment and stays
 * load-only. See rebuildCascade() for why the first core (re-apply locals,
 * cascade matrices) was retired: the user's live test proved it a no-op.
 *
 * THE DETECTOR IS STILL THE POINT
 * -------------------------------
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

/** Movement below this is float noise, not drift. Millimetres in world units. */
const DRIFT_EPSILON = 1e-3;

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
 * Re-derive the live scene from the stored data — the in-memory equivalent
 * of save + restart + reload, minus reading the geometry files.
 *
 * 🔁 V0.3.2.165 — the core was REPLACED. The original implementation
 * re-applied each node's stored local transform and cascaded world matrices.
 * The user's live test proved that does nothing: the locals already match
 * what the scene shows ("no objects moved"), because the drift is not a
 * stale local — it is structure, an object hanging under the wrong live
 * parent. What provably heals it is a full reload, and the user's own
 * reading of that was exact: the expensive part of a reload is re-importing
 * geometry from disk; the derivation itself is seconds even on a huge
 * project. So this now runs the reload's own replay path on the already-
 * loaded objects:
 *
 *   1. flushSync()        — the active step's snapshot captures any pending edit
 *   2. upsertBaseStep()   — the scene is captured into hidden Step 0, exactly
 *                           as saveProject() does before writing the file.
 *                           Safe even on a drifted scene: capture stores the
 *                           LOCAL data, which was never wrong — proven every
 *                           time save-then-reload healed.
 *   3. activateBaseStep() — full cleanupFolderGroups + rebuildFromTreeSpec +
 *                           apply-all-transforms from the base snapshot; this
 *                           is the step that rebuilds the PARENT structure
 *   4. activateStep(active, no-animate) — the user's step replayed on top,
 *                           the same way a fresh load lands on it
 *   5. removeOrphanedPlaceholders() — same sweep the relink contract runs
 *
 * Steps 3-5 are reintegrateFromStep0's contract, inlined so the async step
 * activation can be awaited — the before/after report must measure a scene
 * that has settled, not one mid-flight.
 *
 * THE REPORT REMAINS THE POINT. World positions are measured before and
 * after, and the parent-chain audit runs BEFORE the rebuild (capturing the
 * fault as it stood — this is the reproduction evidence) and again AFTER
 * (proving the rebuild cleaned it, or telling us it could not).
 *
 * @param {string} reason  what triggered it — appears in the report
 * @returns {Promise<{ moved: Array, checked: number,
 *                     parentMismatches: Array, parentMismatchesAfter: Array,
 *                     reason: string }>}
 */
export async function rebuildCascade(reason = 'manual') {
  const root = state.get('treeData');
  if (!root) return { moved: [], checked: 0, parentMismatches: [], parentMismatchesAfter: [], reason };
  if (state.get('_exporting')) {
    console.warn('[cascade] rebuild skipped — an export is running.');
    return { moved: [], checked: 0, parentMismatches: [], parentMismatchesAfter: [], reason, skipped: 'exporting' };
  }

  const before = _snapshotWorldPositions();
  // Audit FIRST — this is the drift capture, taken while the fault stands.
  const parentMismatches = _auditParentChain(root);

  const activeStepId = state.get('activeStepId');
  steps.flushSync();
  steps.upsertBaseStep();
  steps.activateBaseStep();
  if (activeStepId) await steps.activateStep(activeStepId, false);
  steps.removeOrphanedPlaceholders();

  try { sceneCore.rootGroup?.updateWorldMatrix(false, true); }
  catch (e) { console.warn('[cascade] world-matrix update failed:', e?.message); }

  const after = _snapshotWorldPositions();
  const parentMismatchesAfter = _auditParentChain(root);

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
  return { moved, checked: after.size, parentMismatches, parentMismatchesAfter, reason };
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
export async function rebuildAfter(reason) {
  const r = await rebuildCascade(reason);
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
