/**
 * SBS — Paste Transforms, into one step or many (V0.3.4.124).
 * ───────────────────────────────────────────────────────────
 * Replaces V0.3.4.122's "Paste Transforms to steps…" (reverted — the user:
 * "it makes nothing"). The rule now: copy a folder's transforms; paste opens
 * the SAME scope prompt every multi-step change gets (just this step / all /
 * previous / following / selected), then a PLAIN CASCADE — the copied local
 * poses of the folder and of every part inside it, written by node id into
 * each chosen step. The tree there is never touched; the move / rotate /
 * pivot toggles come along AS THEY WERE ON THE COPY (V0.3.4.125: move on /
 * rotation off / pivot off → pasted exactly so). Steps whose tree differs
 * from this one are reported first: leave them out, or paste anyway.
 *
 * HOW A STEP IS WRITTEN — the lesson of .122:
 *   • the ACTIVE step: on the LIVE nodes (applyTransformSnapshot + the dirty
 *     sync stores it in the step). NEVER by rewriting its snapshot and
 *     re-activating it: activateStep flushes the pending sync into the
 *     LEAVING step first — the same step — so the live (old) poses would
 *     overwrite the paste. That is what .122 did.
 *   • every other step: its snapshot.transforms entries directly (the entry
 *     keeps its own flags / scale / spotlight; only the pose fields change).
 * One undo entry for all of it.
 */

import { state }       from '../core/state.js';
import { steps }       from './steps.js';
import { undoManager } from './undo.js';
import { findParent }  from '../core/nodes.js';
import { captureTransformSnapshot, applyTransformSnapshot, applyAllTransforms } from '../core/transforms.js';

/** The pose fields a paste carries. Scale and the spotlight stay the target's. */
const XF_KEYS = ['localOffset', 'localQuaternion', 'orientationSteps', 'pivotLocalOffset', 'pivotLocalQuaternion'];
/** V0.3.4.125 — the toggles travel with the copy when it carries them (move on / rotation off /
 *  pivot off → pasted exactly so); an older clipboard without them leaves the target's alone. */
const FLAG_KEYS = ['moveEnabled', 'rotateEnabled', 'pivotEnabled'];

function _findSpec(spec, id) {
  if (!spec) return null;
  if (spec.id === id) return spec;
  for (const c of (spec.children || [])) { const r = _findSpec(c, id); if (r) return r; }
  return null;
}
/** The parent id of `id` in a spec tree: null at the root, undefined when absent. */
function _parentIdOf(spec, id, parent = null) {
  if (!spec) return undefined;
  if (spec.id === id) return parent ? parent.id : null;
  for (const c of (spec.children || [])) { const r = _parentIdOf(c, id, spec); if (r !== undefined) return r; }
  return undefined;
}
const _pick = (xf) => {
  const o = {};
  for (const k of XF_KEYS)   if (Array.isArray(xf?.[k]))       o[k] = [...xf[k]];
  for (const k of FLAG_KEYS) if (typeof xf?.[k] === 'boolean') o[k] = xf[k];
  return o;
};
const _name = (s, i) => s?.name || `Step ${i + 1}`;

/**
 * Which of the chosen steps (other than the active one) have the same tree
 * around the folder as THIS step: the folder is there, under the same parent,
 * and every copied part is inside it.
 * @returns {{ same: Array<{stepId,stepName}>, different: Array<{stepId,stepName}> }}
 */
export function scanTransformStructure(folderId, entryIds, stepIds) {
  const root = state.get('treeData');
  const liveParentId = findParent(root, folderId)?.id ?? null;
  const active = state.get('activeStepId');
  const same = [], different = [];
  const all = state.get('steps') || [];
  const idx = new Map(all.map((s, i) => [s.id, i]));
  for (const id of stepIds) {
    if (id === active || !idx.has(id)) continue;
    const s = all[idx.get(id)];
    const tree = s.snapshot?.tree;
    const fs = tree ? _findSpec(tree, folderId) : null;
    let ok = !!fs && _parentIdOf(tree, folderId) === liveParentId;
    if (ok) for (const eid of entryIds) { if (eid !== folderId && !_findSpec(fs, eid)) { ok = false; break; } }
    (ok ? same : different).push({ stepId: id, stepName: _name(s, idx.get(id)) });
  }
  return { same, different };
}

/**
 * The paste.
 * @param {{ folderName:string, entries:Array<{id:string, xf:object}>, stepIds:string[] }} args
 *   entries — the copied poses resolved to THIS tree's node ids (the folder included)
 *   stepIds — every step to write, the active one included when it should be
 * @returns {{ steps:number, nodes:number, live:number }}
 */
export function pasteTransforms({ folderName, entries, stepIds }) {
  const nodeById = state.get('nodeById');
  const active   = state.get('activeStepId');
  const targets  = new Set(stepIds || []);

  // ── the active step: the live nodes ────────────────────────────────────────
  let liveBefore = null, liveAfter = null;
  if (targets.has(active)) {
    liveBefore = []; liveAfter = [];
    for (const e of entries) {
      const n = nodeById?.get(e.id);
      if (!n) continue;
      const cur = captureTransformSnapshot(n);
      liveBefore.push({ id: e.id, snap: cur });
      liveAfter.push({ id: e.id, snap: { ...cur, ..._pick(e.xf) } });   // flags, scale, spotlight: the target's own
    }
  }

  // ── every other step: its snapshot entries ─────────────────────────────────
  const stepBefore = new Map();   // stepId → { nodeId: previous entry | null }
  const stepAfter  = new Map();
  for (const s of (state.get('steps') || [])) {
    if (!targets.has(s.id) || s.id === active) continue;
    const tree = s.snapshot?.tree;
    if (!tree) continue;
    const prev = {}, next = {};
    let any = false;
    for (const e of entries) {
      if (!_findSpec(tree, e.id)) continue;   // the part is not in this step at all
      const cur  = s.snapshot.transforms?.[e.id] || null;
      const live = nodeById?.get(e.id);
      const base = cur || (live ? captureTransformSnapshot(live) : null);
      if (!base) continue;
      prev[e.id] = cur;
      next[e.id] = { ...base, ..._pick(e.xf) };
      any = true;
    }
    if (any) { stepBefore.set(s.id, prev); stepAfter.set(s.id, next); }
  }
  if (!(liveAfter?.length) && !stepAfter.size) return { steps: 0, nodes: 0, live: 0 };

  const applyLive = (list) => {
    if (!list?.length) return;
    const nb = state.get('nodeById');
    for (const e of list) { const n = nb?.get(e.id); if (n) applyTransformSnapshot(n, e.snap); }
    const root = state.get('treeData');
    if (root) applyAllTransforms(root, steps.object3dById);
    steps.scheduleTransformSync();   // the dirty sync stores the live poses in the active step
    state.emit('change:treeData', root);
  };
  const applySteps = (map) => {
    if (!map.size) return;
    const updated = (state.get('steps') || []).map(s => {
      const ent = map.get(s.id);
      if (!ent) return s;
      const xf = { ...(s.snapshot.transforms || {}) };
      for (const [id, v] of Object.entries(ent)) { if (v) xf[id] = v; else delete xf[id]; }
      return { ...s, snapshot: { ...s.snapshot, transforms: xf }, altered: true };   // ★ a new pose is a new picture
    });
    state.setState({ steps: updated });
  };
  const doApply   = () => { applyLive(liveAfter);  applySteps(stepAfter);  state.markDirty?.(); };
  const undoApply = () => { applyLive(liveBefore); applySteps(stepBefore); state.markDirty?.(); };

  doApply();
  const nSteps = stepAfter.size + (liveAfter?.length ? 1 : 0);
  undoManager.push(`Paste transforms onto "${folderName || 'folder'}" — ${nSteps} step(s)`, undoApply, doApply);
  return { steps: nSteps, nodes: entries.length, live: liveAfter?.length || 0 };
}
