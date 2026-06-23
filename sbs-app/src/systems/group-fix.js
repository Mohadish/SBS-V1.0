/**
 * group-fix.js (V0.3.0.171) — "Group for global edit".
 *
 * Wrap a set of selected objects in a NEW folder, baked into a scope of steps
 * (all / forward / backward / selected), so the folder can then be moved/rotated
 * ONCE in Global Mode and that single delta ripples across every scoped step
 * (children keep their own per-step poses; the folder's home transform adds the
 * global offset on top). The retroactive "these parts were never oriented right —
 * fix all N steps" operation. Heavy (restructures every scoped step) → a blocking
 * save-first confirm guards it.
 *
 * Two strategies, auto-selected:
 *   A) SAME PARENT (the usual case): all objects share one container P. The folder
 *      F is created UNDER P at identity, and objects move into F keeping their
 *      exact transforms (F is in the same frame as P → world pose preserved, and
 *      they keep riding P's animation). Pure tree restructure, no pose math.
 *   B) SCATTERED: objects span containers. F is created at the SCENE ROOT and each
 *      object is RE-HOMED to its resolved per-step world pose (steps.
 *      resolveObjectWorldPosesPerStep), so nothing jumps regardless of origin.
 *
 * Mirrors applyFollow's per-step snapshot.tree bake (the only way structure reaches
 * existing steps — a sync never rewrites another step's tree).
 */
import { state }       from '../core/state.js';
import { sceneCore }   from '../core/scene.js';
import { steps }       from './steps.js';
import { undoManager } from './undo.js';
import { createNode }  from '../core/schema.js';
import { captureTransformSnapshot } from '../core/transforms.js';
import { moveNode, findParent, buildNodeMap, isDescendantOf, serializeModelTree } from '../core/nodes.js';
import { chooseFromButtons } from '../ui/prompt.js';
import { setStatus }         from '../ui/status.js';
import { isolateSelection, enterPivotEdit, commitPivotEdit } from './actions.js';   // V0.3.0.172 pivot-in-flow

// ── Immutable spec-tree helpers (mirror follow.js / injectHardwareInstanceIntoAllSteps) ──
function _containsId(spec, id) {
  if (!spec) return false;
  if (spec.id === id) return true;
  return (spec.children || []).some(c => _containsId(c, id));
}
function _findSpec(spec, id) {
  if (!spec) return null;
  if (spec.id === id) return spec;
  for (const c of (spec.children || [])) { const r = _findSpec(c, id); if (r) return r; }
  return null;
}
function _removeFromSpec(spec, id) {
  if (!spec) return spec;
  let changed = false;
  const kids = [];
  for (const c of (spec.children || [])) {
    if (c.id === id) { changed = true; continue; }
    const r = _removeFromSpec(c, id);
    if (r !== c) changed = true;
    kids.push(r);
  }
  return changed ? { ...spec, children: kids } : spec;
}
function _addUnder(spec, parentId, child) {
  if (!spec) return null;
  if (spec.id === parentId) return { ...spec, children: [...(spec.children || []), child] };
  let changed = false;
  const kids = (spec.children || []).map(c => {
    const r = _addUnder(c, parentId, child);
    if (r) { changed = true; return r; }
    return c;
  });
  return changed ? { ...spec, children: kids } : null;
}

/** Scoped step ids (non-base, playable). 'selected' uses state.selectedStepIds. */
function _scopedStepIds(scope) {
  const all = (state.get('steps') || []).filter(s => !s.isBaseStep);
  const ids = all.map(s => s.id);
  if (scope === 'selected') {
    const sel = state.get('selectedStepIds');
    const f = ids.filter(id => sel?.has?.(id));
    return f.length ? f : ids;
  }
  if (scope === 'all') return ids;
  const idx = ids.indexOf(state.get('activeStepId'));
  if (idx < 0) return ids;
  if (scope === 'forward')  return ids.slice(idx);
  if (scope === 'backward') return ids.slice(0, idx + 1);
  return ids;
}

/** Identity transform snapshot for a fresh folder. */
function _identityXf() {
  return captureTransformSnapshot(createNode('folder'));
}

/** Build a transform snapshot that places a node at world pose W under an IDENTITY
 *  root frame (strategy B). localOffset/Quaternion carry the pose; base stays identity. */
function _xfFromWorld(w) {
  return {
    localOffset:          [...w.pos],
    localQuaternion:      [...w.quat],
    orientationSteps:     [0, 0, 0],
    pivotLocalOffset:     [0, 0, 0],
    pivotLocalQuaternion: [0, 0, 0, 1],
    baseLocalScale:       [...(w.scale || [1, 1, 1])],
    moveEnabled:   true,
    rotateEnabled: true,
    pivotEnabled:  false,
  };
}

// ── Pivot-in-flow (V0.3.0.172) ──────────────────────────────────────────────
// After wrapping, optionally: isolate the group + enter pivot edit so the user
// places the rotation centre seeing only the group; when they UN-ISOLATE, lock
// that pivot UNIFORMLY across all the group's scoped steps (so a later Global-Mode
// rotation pivots there in every step). Un-isolate is the "done" signal.
let _pendingGroupPivot = null;   // { folderId, scopedIds } | null

state.on('isolate:changed', (e) => {
  if (e?.active) return;             // engaging — wait for the un-isolate
  if (!_pendingGroupPivot) return;   // not our flow
  const { folderId, scopedIds } = _pendingGroupPivot;
  _pendingGroupPivot = null;
  _finalizeGroupPivot(folderId, scopedIds);
});

function _startGroupPivotFlow(folderId, scopedIds) {
  _pendingGroupPivot = { folderId, scopedIds };
  state.setSelection?.(folderId, new Set([folderId]));   // isolateSelection isolates the multi-set
  isolateSelection();
  enterPivotEdit(folderId);
  setStatus('Group isolated — drag the orange pivot to the rotation centre, then click Un-isolate to lock it across all the group’s steps.', 'info', 9000);
}

function _finalizeGroupPivot(folderId, scopedIds) {
  if (state.get('pivotEditNodeId') === folderId) commitPivotEdit();   // exit RED mode (no extra undo)
  const F = state.get('nodeById')?.get?.(folderId);
  if (!F) return;
  const after = {
    pivotLocalOffset:     [...(F.pivotLocalOffset     || [0, 0, 0])],
    pivotLocalQuaternion: [...(F.pivotLocalQuaternion || [0, 0, 0, 1])],
    pivotEnabled:         F.pivotEnabled !== false,
  };
  const scopedSet = new Set(scopedIds || []);
  // Snapshot each scoped step's CURRENT folder pivot (for undo).
  const before = new Map();
  for (const step of (state.get('steps') || [])) {
    if (!scopedSet.has(step.id)) continue;
    const t = step.snapshot?.transforms?.[folderId];
    if (!t) continue;
    before.set(step.id, {
      pivotLocalOffset:     [...(t.pivotLocalOffset     || [0, 0, 0])],
      pivotLocalQuaternion: [...(t.pivotLocalQuaternion || [0, 0, 0, 1])],
      pivotEnabled:         t.pivotEnabled !== false,
    });
  }
  if (!before.size) { setStatus('Pivot set.', 'info', 1800); return; }
  const apply = (which) => {
    const updated = (state.get('steps') || []).map(step => {
      if (!before.has(step.id)) return step;
      const t  = step.snapshot.transforms[folderId];
      const np = which === 'after' ? after : before.get(step.id);
      return { ...step, snapshot: { ...step.snapshot, transforms: { ...step.snapshot.transforms, [folderId]: { ...t, ...np } } } };
    });
    state.setState({ steps: updated });
    state.markDirty?.();
  };
  apply('after');
  undoManager.push('Set group pivot across steps', () => apply('before'), () => apply('after'));
  setStatus('Pivot locked across the group. Press Space (Global Mode) + rotate the folder — it pivots here in every step.', 'success', 5500);
}

/**
 * Core action. Returns { ok, folderId, strategy, scopedCount, scopedIds } or { error }.
 */
export function groupObjectsForGlobalEdit(nodeIds, scope = 'all') {
  const root = state.get('treeData');
  if (!root) return { error: 'no-scene' };
  const nodeById = state.get('nodeById') || buildNodeMap(root);

  // Validate: real, non-scene, non-archived; drop any that are descendants of
  // another selected node (we move the top-level ones; children ride them).
  let ids = [...new Set(nodeIds || [])].filter(id => {
    const n = nodeById.get(id);
    return n && n.type !== 'scene' && !n.archived;
  });
  // Drop any selected node that is a DESCENDANT of another selected node — we move
  // the top-level ones; their children ride along. isDescendantOf(root, ancestor, node).
  ids = ids.filter(id => !ids.some(o => o !== id && isDescendantOf(root, o, id)));
  if (!ids.length) return { error: 'no-objects' };

  const scopedIds = _scopedStepIds(scope);
  if (!scopedIds.length) return { error: 'no-steps' };

  // Strategy: same direct parent → A (under it, keep transforms); else → B (root + re-home).
  const parents = ids.map(id => findParent(root, id)?.id || root.id);
  const sameParent = parents.every(p => p === parents[0]);
  const strategy = sameParent ? 'A' : 'B';
  const targetParentId = sameParent ? parents[0] : root.id;
  const targetParent   = nodeById.get(targetParentId) || root;

  // For B, resolve each object's per-step world pose BEFORE restructuring.
  const poses = strategy === 'B'
    ? steps.resolveObjectWorldPosesPerStep(ids, scopedIds)
    : null;

  // Undo capture.
  const stepsBefore   = JSON.parse(JSON.stringify(state.get('steps') || []));
  const beforeParents = ids.map(id => ({ id, parentId: findParent(root, id)?.id || root.id }));
  const beforeHomes   = strategy === 'B'
    ? ids.map(id => { const n = nodeById.get(id); return { id, bp: [...(n.baseLocalPosition || [0, 0, 0])], bq: [...(n.baseLocalQuaternion || [0, 0, 0, 1])] }; })
    : [];

  // The folder.
  const F = createNode('folder', { name: 'Global group' });
  const fXf = _identityXf();
  const idSet = new Set(ids);
  const scopedSet = new Set(scopedIds);

  // ── Bake into each scoped step's snapshot.tree ──────────────────────────────
  const updated = (state.get('steps') || []).map(step => {
    if (!scopedSet.has(step.id)) return step;
    const snap = step.snapshot;
    if (!snap || !snap.tree) return step;
    if (!_containsId(snap.tree, targetParentId)) return step;   // parent absent here → skip
    // Pull each object's spec out, collect, then drop into a fresh F under the parent.
    let newTree = snap.tree;
    const objSpecs = [];
    for (const id of ids) {
      const spec = _findSpec(newTree, id);
      if (spec) { objSpecs.push(spec); newTree = _removeFromSpec(newTree, id); }
    }
    if (!objSpecs.length) return step;
    const fSpec = { ...serializeModelTree(F), children: objSpecs };
    newTree = _addUnder(newTree, targetParentId, fSpec) || newTree;

    const xf  = { ...(snap.transforms || {}), [F.id]: { ...fXf } };
    const vis = { ...(snap.visibility || {}), [F.id]: true };
    if (strategy === 'B') {
      const stepPoses = poses?.get(step.id);
      for (const id of ids) {
        const w = stepPoses?.get(id);
        if (w) xf[id] = _xfFromWorld(w);   // re-home to world pose under identity-root F
      }
    }
    // Strategy A keeps each object's existing transform (snap stays as-is).
    return { ...step, snapshot: { ...snap, tree: newTree, transforms: xf, visibility: vis } };
  });

  // ── Live tree: insert F + move objects in (+ re-home for B), then rebuild ────
  const insertLive = () => {
    const r = state.get('treeData');
    const p = (state.get('nodeById') || buildNodeMap(r)).get(targetParentId) || r;
    p.children = p.children || [];
    if (!p.children.some(c => c.id === F.id)) p.children.push(F);
    for (const id of ids) {
      if (strategy === 'B') {
        const n = (state.get('nodeById') || buildNodeMap(r)).get(id);
        if (n) { n.baseLocalPosition = [0, 0, 0]; n.baseLocalQuaternion = [0, 0, 0, 1]; }
      }
      moveNode(r, id, F.id);
    }
    state.setState({ steps: updated, treeData: r, nodeById: buildNodeMap(r) });
    steps.applySnapshotInstant({ tree: serializeModelTree(r) });   // creates F's Group + reparents
    const active = state.get('activeStepId');
    if (active) steps.activateStep(active, false);                 // re-apply the active step's poses
    state.emit('change:treeData', r);
    state.markDirty?.();
    sceneCore.requestRender?.(300);
  };
  insertLive();
  state.setSelection?.(F.id, new Set([F.id]));

  // ── Undo ────────────────────────────────────────────────────────────────────
  undoManager.push(
    'Group for global edit',
    () => {
      const r = state.get('treeData');
      state.setState({ steps: JSON.parse(JSON.stringify(stepsBefore)) });
      for (const b of beforeParents) moveNode(r, b.id, b.parentId);
      for (const h of beforeHomes) { const n = (state.get('nodeById') || buildNodeMap(r)).get(h.id); if (n) { n.baseLocalPosition = h.bp; n.baseLocalQuaternion = h.bq; } }
      const p = (state.get('nodeById') || buildNodeMap(r)).get(targetParentId) || r;
      if (p?.children) p.children = p.children.filter(c => c.id !== F.id);
      state.setState({ treeData: r, nodeById: buildNodeMap(r) });
      steps.applySnapshotInstant({ tree: serializeModelTree(r) });
      const cur = state.get('activeStepId'); if (cur) steps.activateStep(cur, false);
      state.emit('change:treeData', r);
      state.markDirty?.();
    },
    () => groupObjectsForGlobalEdit(nodeIds, scope),
  );
  return { ok: true, folderId: F.id, strategy, scopedCount: scopedIds.length, scopedIds };
}

/**
 * UI entry: blocking save-first confirm → scope picker → run. `nodeIds` defaults
 * to the current multi-selection.
 */
export async function promptGroupForGlobalEdit(nodeIds) {
  const ids = (nodeIds && nodeIds.length) ? nodeIds : [...(state.get('multiSelectedIds') || [])];
  if (!ids.length) { setStatus('Select the objects to group first.', 'warn', 2200); return; }

  const go = await chooseFromButtons(
    '⚠️ Group for global edit',
    `This puts ${ids.length} object(s) into a new folder ACROSS the chosen steps so you can move/rotate them all at once (Global Mode). It RESTRUCTURES every affected step — save your project first. Undoable, but heavy. Continue?`,
    [
      { id: 'go',     label: 'I saved — continue', primary: true },
      { id: 'cancel', label: 'Cancel' },
    ],
  );
  if (go !== 'go') return;

  const scope = await chooseFromButtons(
    'Which steps?',
    'The grouping (and your later global move) applies to these steps. The current step is always included.',
    [
      { id: 'all',      label: 'All steps', primary: true },
      { id: 'forward',  label: 'This step → forward' },
      { id: 'backward', label: 'Up to this step' },
      { id: 'selected', label: 'Selected steps only' },
      { id: 'cancel',   label: 'Cancel' },
    ],
  );
  if (!scope || scope === 'cancel') return;

  const res = groupObjectsForGlobalEdit(ids, scope);
  if (res?.error) {
    setStatus(`Couldn't group: ${res.error}.`, 'warn', 3000);
    return;
  }
  if (!res?.ok) return;

  // Offer to place the rotation pivot now (isolate → drag → un-isolate locks it
  // across the group's steps). Skip → user sets it later / rotates about origin.
  const piv = await chooseFromButtons(
    'Set the group pivot?',
    `Grouped ${ids.length} object(s) across ${res.scopedCount} step(s). Place a rotation pivot now? The group will isolate so you see only it — drag the orange pivot, then UN-ISOLATE to lock it across every one of the group's steps.`,
    [
      { id: 'set',  label: 'Set pivot now', primary: true },
      { id: 'skip', label: 'Skip — I’ll set it later' },
    ],
  );
  if (piv === 'set') {
    _startGroupPivotFlow(res.folderId, res.scopedIds);
  } else {
    setStatus('Turn on Global Mode (Space) and move/rotate the folder — it ripples to every scoped step.', 'success', 4500);
  }
}
