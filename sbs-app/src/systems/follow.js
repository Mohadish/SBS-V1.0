/**
 * follow.js (V0.3.0.63) — "Follow Object" feature, Stage 2 core.
 *
 * Make a follower node A ride a target node B by placing A as a SIBLING of B
 * inside B's parent folder, at a sustained relative offset, across the scoped
 * step snapshots. A then tracks B's folder wherever it goes — no per-step
 * hand-editing. Generalises injectHardwareInstanceIntoAllSteps + the screw→model
 * world-pose-preserving reparent (setInstanceWorldPose).
 *
 * The follow relationship is stored on the follower (node.follow) and persists
 * via save/load (project.js carries it). The STRUCTURAL consequence (A under B's
 * folder, with a fixed local delta) is baked into each scoped step snapshot, so
 * rebuildFromTreeSpec keeps it on activation with zero extra code.
 *
 * Stage 2 = scope 'all', position only, console-testable via window.sbsFollow.
 * Later stages: scope ranges, opacity/colour mimic, verified picker, wrapper
 * folders for model-parent edge cases.
 */
import { state }        from '../core/state.js';
import { sceneCore }    from '../core/scene.js';
import { steps }        from './steps.js';
import { undoManager }  from './undo.js';
import { cloneShareStrings } from '../core/clone.js';
import { setNodeWorldPoseRaw } from './hardware-actions.js';
import { captureTransformSnapshot } from '../core/transforms.js';
import {
  moveNode, findParent, buildNodeMap, isDescendantOf, serializeModelTree,
} from '../core/nodes.js';
import { chooseFromButtons } from '../ui/prompt.js';
import { setStatus }         from '../ui/status.js';

// ── Spec-tree helpers (immutable, mirror injectHardwareInstanceIntoAllSteps) ──
function _containsId(spec, id) {
  if (!spec) return false;
  if (spec.id === id) return true;
  return (spec.children || []).some(c => _containsId(c, id));
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

/** Step ids in scope, given the scope mode + the step the action fired on. */
function _scopedStepIds(scope, fromStepId) {
  const all = (state.get('steps') || []).filter(s => !s.isBaseStep);
  const ids = all.map(s => s.id);
  if (scope === 'all' || !fromStepId) return ids;
  const idx = ids.indexOf(fromStepId);
  if (idx < 0) return ids;
  if (scope === 'forward')  return ids.slice(idx);
  if (scope === 'backward') return ids.slice(0, idx + 1);
  return ids;
}

/**
 * Apply a follow: A becomes a sibling of B in B's parent folder across the
 * scoped steps, world position preserved. Returns true on success.
 *
 * @param {string} followerId
 * @param {string} targetId
 * @param {{scope?: 'all'|'forward'|'backward'}} [opts]
 */
export function applyFollow(followerId, targetId, opts = {}) {
  const T = window.THREE;
  const root = state.get('treeData');
  if (!root) { console.warn('[follow] no scene'); return false; }
  const nodeById = state.get('nodeById') || buildNodeMap(root);
  const A = nodeById.get(followerId);
  const B = nodeById.get(targetId);
  if (!A || !B)        { console.warn('[follow] follower or target not found'); return false; }
  if (A.id === B.id)   { console.warn('[follow] an object cannot follow itself'); return false; }
  if (isDescendantOf(root, A.id, B.id)) { console.warn('[follow] target is inside the follower → would cycle'); return false; }
  const parentFolder = findParent(root, B.id);
  if (!parentFolder)   { console.warn('[follow] target has no parent container'); return false; }
  const parentFolderId = parentFolder.id;
  if (parentFolderId === findParent(root, A.id)?.id && A.follow?.targetId === targetId) {
    console.log('[follow] already following', targetId); // idempotent re-apply still rewrites pose below
  }

  const scope      = opts.scope || 'all';
  const fromStepId = state.get('activeStepId') || null;
  const scopedIds  = _scopedStepIds(scope, fromStepId);

  // ── Capture BEFORE state for undo ──────────────────────────────────────────
  const beforeParentId = findParent(root, A.id)?.id || null;
  const beforeFollow   = A.follow ? { ...A.follow } : null;
  const stepsBefore    = cloneShareStrings(state.get('steps') || []);   // structural clone, shares base64 strings (V0.3.2.31 — JSON.stringify blew V8's 512MB string cap on big projects)

  // ── LIVE reparent, preserving A's world pose ───────────────────────────────
  const Aobj      = steps.object3dById?.get(A.id) || A.object3d || null;
  const folderObj = steps.object3dById?.get(parentFolderId) || sceneCore.rootGroup;
  const worldPos  = new T.Vector3();
  const worldQuat = new T.Quaternion();
  if (Aobj) {
    Aobj.updateWorldMatrix(true, false);
    Aobj.getWorldPosition(worldPos);
    Aobj.getWorldQuaternion(worldQuat);
  }
  moveNode(root, A.id, parentFolderId);                 // data-tree move
  if (Aobj && folderObj && Aobj.parent !== folderObj) {
    folderObj.add(Aobj);                                // object3d reparent
  }
  if (Aobj) setNodeWorldPoseRaw(A, Aobj, worldPos, worldQuat);   // EXACT world pose preserved (no washer comp — right for follow)

  // The fixed per-step delta A holds relative to the folder (so it rides it).
  const xfSnap  = captureTransformSnapshot(A);
  const visFlag = A.localVisible !== false;
  const followerSpec = serializeModelTree(A);

  // ── Bake into the scoped step snapshots ────────────────────────────────────
  const scoped = new Set(scopedIds);
  let touched = 0, skipped = 0;
  const updated = (state.get('steps') || []).map(step => {
    if (!scoped.has(step.id)) return step;
    const snap = step.snapshot;
    if (!snap || !snap.tree) return step;
    if (!_containsId(snap.tree, parentFolderId)) { skipped++; return step; }  // folder absent here (wrapper handled later)
    let newTree = _removeFromSpec(snap.tree, A.id);
    newTree = _addUnder(newTree, parentFolderId, followerSpec) || newTree;
    touched++;
    return {
      ...step,
      snapshot: {
        ...snap,
        tree:       newTree,
        visibility: { ...(snap.visibility || {}), [A.id]: visFlag },
        transforms: { ...(snap.transforms || {}), [A.id]: xfSnap },
      },
    };
  });
  state.setState({ steps: updated });

  // ── Record the relationship + refresh live tree ────────────────────────────
  A.follow = { targetId, parentFolderId, scope, fromStepId, mimicOpacity: false, mimicColor: false, wrapperId: null };
  state.setState({ nodeById: buildNodeMap(root), treeData: root });
  state.emit('change:treeData', root);
  state.markDirty?.();
  sceneCore.requestRender?.(300);

  console.log(`[follow] "${A.name || A.id}" now follows "${B.name || B.id}" (in folder "${parentFolder.name || parentFolderId}") — scope ${scope}, ${touched} step(s) updated${skipped ? `, ${skipped} skipped (folder not present in those steps)` : ''}.`);

  // ── Undo: restore steps + A's parent/transform/follow ──────────────────────
  undoManager.push(
    'Follow object',
    () => {
      const r2 = state.get('treeData');
      state.setState({ steps: stepsBefore });
      if (beforeParentId) moveNode(r2, A.id, beforeParentId);
      A.follow = beforeFollow;
      state.setState({ nodeById: buildNodeMap(r2) });
      const cur = state.get('activeStepId');
      if (cur) steps.activateStep(cur, false); else steps.activateBaseStep?.();
      state.emit('change:treeData', r2);
    },
    () => applyFollow(followerId, targetId, opts),
  );
  return true;
}

/** Remove a follow relationship (does NOT move A back — just clears the flag). */
export function clearFollow(followerId) {
  const nodeById = state.get('nodeById');
  const A = nodeById?.get?.(followerId);
  if (A?.follow) { A.follow = null; state.markDirty?.(); console.log('[follow] cleared on', followerId); }
}

/**
 * Detach a follower back to the SCENE ROOT — it becomes a free object (no follow),
 * keeping its current world position, across all steps. The "go back to root" option
 * of the Stop-following dialog. Mirrors applyFollow but reparents to root + clears
 * the flag. Undoable.
 */
export function unfollowToRoot(followerId, scope = 'all') {
  const T = window.THREE;
  const root = state.get('treeData');
  if (!root) return false;
  const A = (state.get('nodeById') || buildNodeMap(root)).get(followerId);
  if (!A) { console.warn('[follow] node not found'); return false; }
  const rootId = root.id;
  const scopedIds = _scopedStepIds(scope, state.get('activeStepId') || null);

  const beforeParentId = findParent(root, A.id)?.id || null;
  const beforeFollow   = A.follow ? { ...A.follow } : null;
  const stepsBefore    = cloneShareStrings(state.get('steps') || []);   // V0.3.2.31 — was JSON.stringify (512MB string cap)

  // Live reparent to the scene root, world pose preserved.
  const Aobj    = steps.object3dById?.get(A.id) || A.object3d || null;
  const rootObj = steps.object3dById?.get(rootId) || sceneCore.rootGroup;
  const worldPos = new T.Vector3(), worldQuat = new T.Quaternion();
  if (Aobj) { Aobj.updateWorldMatrix(true, false); Aobj.getWorldPosition(worldPos); Aobj.getWorldQuaternion(worldQuat); }
  moveNode(root, A.id, rootId);
  if (Aobj && rootObj && Aobj.parent !== rootObj) rootObj.add(Aobj);
  if (Aobj) setNodeWorldPoseRaw(A, Aobj, worldPos, worldQuat);

  const xfSnap  = captureTransformSnapshot(A);
  const visFlag = A.localVisible !== false;
  const spec    = serializeModelTree(A);
  const scoped  = new Set(scopedIds);
  const updated = (state.get('steps') || []).map(step => {
    if (!scoped.has(step.id)) return step;
    const snap = step.snapshot;
    if (!snap || !snap.tree) return step;
    let newTree = _removeFromSpec(snap.tree, A.id);
    newTree = _addUnder(newTree, rootId, spec) || { ...newTree, children: [...(newTree.children || []), spec] };
    return {
      ...step,
      snapshot: { ...snap, tree: newTree,
        visibility: { ...(snap.visibility || {}), [A.id]: visFlag },
        transforms: { ...(snap.transforms || {}), [A.id]: xfSnap } },
    };
  });
  state.setState({ steps: updated });

  A.follow = null;
  state.setState({ nodeById: buildNodeMap(root), treeData: root });
  state.emit('change:treeData', root);
  state.markDirty?.();
  sceneCore.requestRender?.(300);
  console.log(`[follow] "${A.name || A.id}" detached to root.`);

  undoManager.push(
    'Stop following (to root)',
    () => {
      const r2 = state.get('treeData');
      state.setState({ steps: stepsBefore });
      if (beforeParentId) moveNode(r2, A.id, beforeParentId);
      A.follow = beforeFollow;
      state.setState({ nodeById: buildNodeMap(r2) });
      const cur = state.get('activeStepId');
      if (cur) steps.activateStep(cur, false); else steps.activateBaseStep?.();
      state.emit('change:treeData', r2);
    },
    () => unfollowToRoot(followerId, scope),
  );
  return true;
}

/**
 * "Stop following" dialog: detach to root, re-target a different object, or cancel.
 * (Clearing the flag alone left the object sitting in its old folder with no way back.)
 */
export async function promptStopFollowing(nodeId) {
  const choice = await chooseFromButtons(
    'Stop following',
    'What should this object do now?',
    [
      { id: 'root',     label: 'Detach — move back to root (free object)', primary: true },
      { id: 'retarget', label: 'Follow a different object…' },
      { id: 'cancel',   label: 'Cancel' },
    ],
  );
  if (choice === 'root') {
    const scope = await chooseFromButtons(
      'Detach to root — which steps?',
      'The current step is always included.',
      [
        { id: 'all',      label: 'All steps', primary: true },
        { id: 'forward',  label: 'This step → forward' },
        { id: 'backward', label: 'This step → backward' },
        { id: 'cancel',   label: 'Cancel' },
      ],
    );
    if (scope && scope !== 'cancel') unfollowToRoot(nodeId, scope);
  } else if (choice === 'retarget') startFollowPick(nodeId);
}

// ── Stage 4: verified click-to-pick-target flow (r-click → "Follow Object") ───
let _pickFollowerId = null;

/** Begin picking a target for `followerId`. Next viewport click = the target. */
export function startFollowPick(followerId) {
  const A = state.get('nodeById')?.get?.(followerId);
  if (!A) { console.warn('[follow] pick: invalid follower'); return; }
  _pickFollowerId = followerId;
  state.setState({ followPickActive: true });
  setStatus(`Follow Object — click the object "${A.name || 'this'}" should follow (Esc to cancel).`, 'info', 8000);
}

export function isFollowPicking() { return !!_pickFollowerId; }

export function cancelFollowPick() {
  if (!_pickFollowerId) return;
  _pickFollowerId = null;
  state.setState({ followPickActive: false });
  setStatus('Follow cancelled.', 'muted', 1200);
}

/**
 * Handle a target click during pick mode. `targetNodeId` is the node the user
 * clicked (already resolved + highlighted by the caller). Shows a verify/confirm
 * dialog with the scope choice, then applies. Returns true (consumed the click).
 */
export async function onFollowPickClick(targetNodeId) {
  const followerId = _pickFollowerId;
  if (!followerId) return false;
  if (!targetNodeId)               { setStatus('Click an object to follow (Esc to cancel).', 'warn', 2000); return true; }
  if (targetNodeId === followerId) { setStatus('Pick a DIFFERENT object as the target.', 'warn', 2200); return true; }
  const nodeById = state.get('nodeById');
  const A = nodeById?.get?.(followerId);
  const B = nodeById?.get?.(targetNodeId);
  if (!A || !B) { cancelFollowPick(); return true; }

  const choice = await chooseFromButtons(
    'Follow Object',
    `Make "${A.name || 'the selected object'}" follow "${B.name || 'this object'}" — keeping it in that object's folder across steps?`,
    [
      { id: 'all',      label: 'Follow — all steps', primary: true },
      { id: 'forward',  label: 'From this step → forward' },
      { id: 'backward', label: 'Up to this step' },
      { id: 'cancel',   label: 'Cancel' },
    ],
  );
  _pickFollowerId = null;
  state.setState({ followPickActive: false });
  if (!choice || choice === 'cancel') { setStatus('Follow cancelled.', 'muted', 1200); return true; }
  const ok = applyFollow(followerId, targetNodeId, { scope: choice });
  if (ok) setStatus(`"${A.name || 'Object'}" now follows "${B.name || 'target'}".`, 'success', 2500);
  return true;
}
