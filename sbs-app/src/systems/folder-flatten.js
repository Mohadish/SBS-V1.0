/**
 * 📦 FOLDER FLATTEN (backlog #16).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 1 (V0.3.2.243) — the SCANNER. Finds folder levels that add nothing:
 * `↪ Adj from "…"` compensation wrappers left behind by keep-position moves,
 * folders wrapping a single folder, and empty folders.
 *
 * Phase 2a (V0.3.2.244) — REMOVAL, for the free ones only. A free folder is
 * identity everywhere, so taking it out and putting its contents in its place
 * cannot move anything. The removal still refuses to trust that: it measures
 * every object in every affected step before and after, on the data, BEFORE
 * committing a single change — and then again on the live scene of the step
 * being viewed, reverting if anything differs.
 *
 * ── Why only free folders can go (in this phase) ───────────────────────────
 *   SAFE   identity in the live tree and every step. Pure reparent.
 *   BAKE   carries a pose (or hides its contents on some steps): every child
 *          would have to absorb it PER STEP. Phase 2b, not built.
 *   UNSAFE something points at this folder by id, or its pose cannot be
 *          composed away. Left alone.
 *
 * ── The transform model this relies on (core/transforms.js) ────────────────
 * position = baseLocalPosition + localOffset,
 * quaternion = baseLocalQuaternion * localQuaternion, scale = baseLocalScale.
 * The BASE is global (live node only); the DELTAS are what
 * `step.snapshot.transforms[id]` carries per step. `snapshot.tree` is pure
 * structure — "Transforms are NOT duplicated here" (steps.js captureSnapshot).
 * So removal splices the node out of each step's tree spec and drops its own
 * per-step entries; no other number anywhere changes.
 *
 * The pivot is VIRTUAL — never part of object3d.position/quaternion — so it
 * has no world effect, but a pivot the user placed would be silently lost.
 * A mesh has NO per-step transform (isTransformNode excludes it), which is
 * why a wrapper that moves raw meshes can never be baked away.
 */

import { state } from '../core/state.js';
import { steps } from './steps.js';
import {
  flatten, findParent, getPathToNode,
} from '../core/nodes.js';
import {
  isNearZero, isIdentityQuaternion, ensureTransformDefaults, isTransformNode,
} from '../core/transforms.js';

/** Container types — a folder holding exactly one of these adds only a level. */
const CONTAINER_TYPES = new Set(['folder', 'model', 'primitive', 'replaceModel']);

/** The wrapper the keep-position move creates (tree.js _makeAdjustmentFolderSpec). */
const ADJ_PREFIX = '↪ Adj from';

const _SCALE_EPS = 1e-4;

/** Plain-language names for the candidate shapes, for the panel. */
export const KIND_PLAIN = {
  adj:         'leftover wrapper from a move',
  passthrough: 'extra folder around a single folder',
  empty:       'empty folder',
};

function _isUnitScale(s) {
  const [x = 1, y = 1, z = 1] = s || [];
  return Math.abs(x - 1) < _SCALE_EPS && Math.abs(y - 1) < _SCALE_EPS && Math.abs(z - 1) < _SCALE_EPS;
}

function _isUniformScale(s) {
  const [x = 1, y = 1, z = 1] = s || [];
  return Math.abs(x - y) < _SCALE_EPS && Math.abs(y - z) < _SCALE_EPS;
}

/** Does this step's serialised tree contain `id`? */
function _specContains(spec, id) {
  if (!spec) return false;
  if (spec.id === id) return true;
  for (const c of spec.children || []) if (_specContains(c, id)) return true;
  return false;
}

/** A per-step delta is "still" when it moves and turns nothing. */
function _deltaIsStill(snap) {
  if (!snap) return true;   // no entry = never moved on that step
  return isNearZero(snap.localOffset || [0, 0, 0])
      && isIdentityQuaternion(snap.localQuaternion || [0, 0, 0, 1]);
}

/** A per-step delta with a relocated pivot. */
function _hasPivot(snap) {
  if (!snap) return false;
  return !isNearZero(snap.pivotLocalOffset || [0, 0, 0])
      || !isIdentityQuaternion(snap.pivotLocalQuaternion || [0, 0, 0, 1]);
}

function _stepLabel(step, index) {
  return step?.name || step?.title || `step ${index + 1}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SCAN (read-only)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Scan the project for folder levels worth collapsing.
 *
 * Each candidate carries `reasons` / `notes` (engineering detail, for the
 * console) and `plain` (one short phrase a person can read, for the panel).
 *
 * @returns {{ candidates: object[], folders: number, steps: number, scannedAt: string }}
 */
export function scanRedundantFolders() {
  const root  = state.get('treeData');
  const stepList = state.get('steps') || [];
  if (!root) return { candidates: [], folders: 0, steps: stepList.length, scannedAt: new Date().toISOString() };

  const all  = flatten(root);
  const byId = new Map(all.map(n => [n.id, n]));

  // ── Who points at a folder BY ID ────────────────────────────────────────
  // A folder named in one of these is load-bearing: collapsing it leaves a
  // dangling id, and the feature that stored it silently stops working.
  const referenced = new Map();   // folderId → [{ why, plain }]
  const addRef = (id, why, plain) => {
    if (!id) return;
    if (!referenced.has(id)) referenced.set(id, []);
    if (!referenced.get(id).some(r => r.why === why)) referenced.get(id).push({ why, plain });
  };
  for (const n of all) {
    if (n.follow?.parentFolderId) addRef(n.follow.parentFolderId, `holds "${n.name || n.id}" for Follow Object`, 'used by Follow Object');
    if (n.follow?.wrapperId)      addRef(n.follow.wrapperId,      `is a Follow wrapper for "${n.name || n.id}"`, 'used by Follow Object');
  }
  const ifaceFolder = state.get('interfaceLibraryFolder');
  if (ifaceFolder) addRef(ifaceFolder, 'is the interface library folder', 'your interface library folder');

  const candidates = [];
  let folders = 0;

  for (const node of all) {
    if (node.type !== 'folder') continue;
    if (node === root) continue;
    folders++;

    const kids = node.children || [];
    const isAdj = String(node.name || '').startsWith(ADJ_PREFIX);
    const onlyChildIsContainer = kids.length === 1 && CONTAINER_TYPES.has(kids[0].type);

    let kind = null;
    if (kids.length === 0)            kind = 'empty';
    else if (isAdj)                   kind = 'adj';
    else if (onlyChildIsContainer)    kind = 'passthrough';
    if (!kind) continue;

    ensureTransformDefaults(node);

    const reasons = [];   // why it is unsafe (detail)
    const notes   = [];   // what a bake would involve (detail)
    const plains  = [];   // the same, in plain words, most important first
    let verdict   = 'safe';

    // ── Hard blockers ─────────────────────────────────────────────────────
    const parent = findParent(root, node.id);
    for (const r of referenced.get(node.id) || []) { reasons.push(r.why); plains.push(r.plain); }
    if (node.locked)   { reasons.push('folder is locked');   plains.push('locked'); }
    if (node.archived) { reasons.push('folder is archived'); plains.push('archived'); }
    if (node.missing)  { reasons.push('belongs to a missing model — relink it first'); plains.push('belongs to a missing model'); }
    // Replace-Model children are rebuilt by origin id on load; restructuring
    // underneath one is outside what this pass understands.
    if (parent?.type === 'replaceModel') { reasons.push('sits directly inside a replaced model'); plains.push('inside a replaced model'); }
    if (node.localVisible === false) { reasons.push('hidden in the step you are viewing'); plains.push('hidden right now'); }

    // ── Transform survey: live tree + every step ──────────────────────────
    const baseStill = isNearZero(node.baseLocalPosition || [0, 0, 0])
      && isIdentityQuaternion(node.baseLocalQuaternion || [0, 0, 0, 1])
      && _deltaIsStill(node);   // the live tree's own delta counts as a step too
    const unitScale = _isUnitScale(node.baseLocalScale);

    let movingSteps  = 0;
    let hiddenSteps  = 0;
    let missingSteps = 0;
    let pivotSteps   = _hasPivot(node) ? 1 : 0;

    for (const s of stepList) {
      const snap = s?.snapshot;
      if (!snap) continue;
      if (snap.tree && !_specContains(snap.tree, node.id)) { missingSteps++; continue; }
      const t = snap.transforms?.[node.id];
      if (!_deltaIsStill(t)) movingSteps++;
      if (_hasPivot(t))      pivotSteps++;
      if (snap.visibility && snap.visibility[node.id] === false) hiddenSteps++;
    }

    if (pivotSteps) {
      reasons.push(`carries a relocated pivot${pivotSteps > 1 ? ` on ${pivotSteps} step(s)` : ''} — it would be destroyed`);
      plains.push('has a pivot you placed');
    }
    if (!unitScale && !_isUniformScale(node.baseLocalScale)) {
      reasons.push('non-uniform scale — composing it with a rotation shears the children');
      plains.push('stretched unevenly');
    }

    // ── Verdict ───────────────────────────────────────────────────────────
    // Is there a POSE to push down into the children, or is this folder just
    // an empty level? An identity folder can always go.
    const hasPose = !baseStill || !unitScale || movingSteps > 0;

    // A child that cannot carry a transform DELTA has nowhere to receive the
    // folder's pose — which only matters when there IS a pose. This is the
    // wall for moving ↪ Adj wrappers around raw meshes.
    const stuckKids = hasPose ? kids.filter(k => !isTransformNode(k)) : [];
    if (stuckKids.length) {
      reasons.push(`carries a pose, but ${stuckKids.length} child(ren) cannot absorb it (${
        [...new Set(stuckKids.map(k => k.type))].join(', ')}) — nothing to compose into`);
      plains.push('holds parts in place that cannot move on their own');
    }

    if (reasons.length) {
      verdict = 'unsafe';
    } else if (kind === 'empty' || !hasPose) {
      verdict = 'safe';
      if (missingSteps) notes.push(`absent from ${missingSteps} step(s) — nothing to do there`);
    } else {
      verdict = 'bake';
      if (movingSteps)  { notes.push(`moves on ${movingSteps} of ${stepList.length} step(s) — each one composes separately`); plains.push('moves its contents on some steps'); }
      if (!baseStill)   { notes.push('carries a fixed offset/rotation of its own'); plains.push('offsets its contents'); }
      if (!unitScale)   { notes.push('carries a scale — it multiplies into every child'); plains.push('scales its contents'); }
      if (missingSteps)   notes.push(`absent from ${missingSteps} step(s)`);
    }

    if (hiddenSteps && verdict !== 'unsafe') {
      notes.push(`hidden on ${hiddenSteps} step(s) — its children would each need their own hide`);
      plains.push('hides its contents on some steps');
      if (verdict === 'safe') verdict = 'bake';
    }

    const pathIds = getPathToNode(root, node.id) || [];
    candidates.push({
      id:         node.id,
      name:       node.name || node.id,
      path:       pathIds.slice(1, -1).map(id => byId.get(id)?.name || id).join(' / '),
      parentId:   parent?.id || null,
      parentName: parent?.name || '(scene)',
      kind, verdict, reasons, notes,
      plain:      plains[0] || KIND_PLAIN[kind],
      childCount: kids.length,
      movingSteps, hiddenSteps, missingSteps,
      depth:      pathIds.length,
    });
  }

  const rank = { unsafe: 0, bake: 1, safe: 2 };
  candidates.sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || (a.depth - b.depth) || a.name.localeCompare(b.name));

  return { candidates, folders, steps: stepList.length, scannedAt: new Date().toISOString() };
}

/** Console view of the scan — `await window.sbsFlatten.scan()`. */
export function logScan() {
  const r = scanRedundantFolders();
  const by = v => r.candidates.filter(c => c.verdict === v);
  console.log(`[flatten] ${r.folders} folder(s), ${r.steps} step(s) → ${r.candidates.length} candidate(s): `
    + `${by('safe').length} safe, ${by('bake').length} bake, ${by('unsafe').length} unsafe.`);
  if (r.candidates.length) {
    console.table(r.candidates.map(c => ({
      verdict: c.verdict, kind: c.kind, name: c.name, children: c.childCount,
      moves: c.movingSteps, hidden: c.hiddenSteps, absent: c.missingSteps,
      why: [...c.reasons, ...c.notes].join('; '),
    })));
  }
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════
//  REMOVAL (Phase 2a) — plan → verify on data → apply → verify live
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Copy-on-write splice: returns the SAME object when nothing below it
 * changed, so an untouched step keeps its spec by identity and a touched one
 * shares every unaffected subtree with its previous version. That is what
 * lets undo hold the old trees by reference instead of cloning ~300 of them.
 */
function _cowList(list, removed) {
  let changed = false;
  const out = [];
  for (const c of list) {
    if (removed.has(c.id)) {
      changed = true;
      for (const g of _cowList(c.children || [], removed)) out.push(g);
    } else {
      const n = _cowSpec(c, removed);
      if (n !== c) changed = true;
      out.push(n);
    }
  }
  return changed ? out : list;
}

function _cowSpec(spec, removed) {
  const kids = spec.children || [];
  const next = _cowList(kids, removed);
  return next === kids ? spec : { ...spec, children: next };
}

/**
 * Build the removal plan for `ids`. Re-scans first and keeps only ids that
 * are STILL free — the panel may have been open while the project changed.
 * Touches nothing.
 */
export function planFolderRemoval(ids) {
  const scan = scanRedundantFolders();
  const safe = new Map(scan.candidates.filter(c => c.verdict === 'safe').map(c => [c.id, c]));
  const wanted  = [...(ids || [])];
  const removed = new Set(wanted.filter(id => safe.has(id)));
  const dropped = wanted.filter(id => !safe.has(id));

  const changes = [];
  if (removed.size) {
    (state.get('steps') || []).forEach((step, index) => {
      const snap = step?.snapshot;
      if (!snap?.tree) return;
      const newTree = _cowSpec(snap.tree, removed);
      const tr = {}, vis = {};
      let entries = false;
      for (const id of removed) {
        if (snap.transforms && Object.prototype.hasOwnProperty.call(snap.transforms, id)) { tr[id] = snap.transforms[id]; entries = true; }
        if (snap.visibility && Object.prototype.hasOwnProperty.call(snap.visibility, id)) { vis[id] = snap.visibility[id]; entries = true; }
      }
      if (newTree === snap.tree && !entries) return;
      changes.push({ stepId: step.id, stepName: _stepLabel(step, index), oldTree: snap.tree, newTree, tr, vis });
    });
  }

  return {
    removed,
    names: [...removed].map(id => safe.get(id).name),
    dropped,
    changes,
  };
}

// ── Data verification ───────────────────────────────────────────────────────

function _localMatrix(live, d, THREE, tmp) {
  // Mirrors getComputedLocalPosition / getTotalLocalQuaternion, with the
  // STEP's delta instead of whatever the live node happens to hold.
  const base  = live.baseLocalPosition   || [0, 0, 0];
  const baseQ = live.baseLocalQuaternion || [0, 0, 0, 1];
  const moveOn = (d?.moveEnabled   ?? live.moveEnabled)   !== false;
  const rotOn  = (d?.rotateEnabled ?? live.rotateEnabled) !== false;
  const off = moveOn ? (d?.localOffset     || [0, 0, 0])    : [0, 0, 0];
  const dq  = rotOn  ? (d?.localQuaternion || [0, 0, 0, 1]) : [0, 0, 0, 1];
  const sc  = d?.baseLocalScale || live.baseLocalScale || [1, 1, 1];
  tmp.p.set(base[0] + off[0], base[1] + off[1], base[2] + off[2]);
  tmp.q.set(baseQ[0], baseQ[1], baseQ[2], baseQ[3]);
  tmp.dq.set(dq[0], dq[1], dq[2], dq[3]);
  tmp.q.multiply(tmp.dq).normalize();
  tmp.s.set(sc[0], sc[1], sc[2]);
  return new THREE.Matrix4().compose(tmp.p, tmp.q, tmp.s);
}

/** World matrix + effective visibility of every node in one step's spec. */
function _poses(spec, snap, byId, THREE) {
  const tr  = snap?.transforms || {};
  const vis = snap?.visibility || {};
  const out = new Map();
  const tmp = { p: new THREE.Vector3(), q: new THREE.Quaternion(), dq: new THREE.Quaternion(), s: new THREE.Vector3() };
  const walk = (s, parentM, parentV) => {
    const live = byId.get(s.id);
    let m = parentM;
    if (live && isTransformNode(live)) m = parentM.clone().multiply(_localMatrix(live, tr[s.id], THREE, tmp));
    const own = Object.prototype.hasOwnProperty.call(vis, s.id) ? vis[s.id] !== false : s.localVisible !== false;
    const v = parentV && own;
    out.set(s.id, { e: m.elements, v });
    for (const c of s.children || []) walk(c, m, v);
  };
  walk(spec, new THREE.Matrix4(), true);
  return out;
}

function _sameMatrix(a, b) {
  for (let i = 0; i < 16; i++) {
    if (Math.abs(a[i] - b[i]) > 1e-4 * Math.max(1, Math.abs(a[i]))) return false;
  }
  return true;
}

function _comparePoses(before, after, removed) {
  for (const [id, b] of before) {
    if (removed.has(id)) {
      if (after.has(id)) return { id, why: 'is still there after removal' };
      continue;
    }
    const a = after.get(id);
    if (!a)             return { id, why: 'would disappear' };
    if (a.v !== b.v)    return { id, why: 'would change visibility' };
    if (!_sameMatrix(b.e, a.e)) return { id, why: 'would move' };
  }
  for (const id of after.keys()) if (!before.has(id)) return { id, why: 'would appear from nowhere' };
  return null;
}

/**
 * Prove, on the DATA, that the plan moves nothing in any step it touches.
 * Runs before a single change is committed, so a failure has nothing to undo.
 *
 * @returns {Promise<{ok:true} | {ok:false, stepName, nodeName, why}>}
 */
export async function verifyPlan(plan, onProgress) {
  const THREE = window.THREE;
  if (!THREE) return { ok: false, stepName: '-', nodeName: '-', why: 'the 3D engine is not ready' };
  const byId = state.get('nodeById') || new Map();
  const stepById = new Map((state.get('steps') || []).map(s => [s.id, s]));

  for (let i = 0; i < plan.changes.length; i++) {
    const ch   = plan.changes[i];
    const snap = stepById.get(ch.stepId)?.snapshot;
    const before = _poses(ch.oldTree, snap, byId, THREE);
    const after  = _poses(ch.newTree, snap, byId, THREE);
    const bad = _comparePoses(before, after, plan.removed);
    if (bad) {
      return { ok: false, stepName: ch.stepName, nodeName: byId.get(bad.id)?.name || bad.id, why: bad.why };
    }
    if (i % 8 === 7) {
      onProgress?.(i + 1, plan.changes.length);
      await new Promise(r => setTimeout(r, 0));   // keep the window painting
    }
  }
  onProgress?.(plan.changes.length, plan.changes.length);
  return { ok: true };
}

// ── Apply / revert ──────────────────────────────────────────────────────────

function _swap(plan, forward) {
  const stepById = new Map((state.get('steps') || []).map(s => [s.id, s]));
  for (const ch of plan.changes) {
    const snap = stepById.get(ch.stepId)?.snapshot;
    if (!snap) continue;
    if (forward) {
      snap.tree = ch.newTree;
      if (snap.transforms) for (const id of Object.keys(ch.tr))  delete snap.transforms[id];
      if (snap.visibility) for (const id of Object.keys(ch.vis)) delete snap.visibility[id];
    } else {
      snap.tree = ch.oldTree;
      if (Object.keys(ch.tr).length)  snap.transforms = Object.assign(snap.transforms || {}, ch.tr);
      if (Object.keys(ch.vis).length) snap.visibility = Object.assign(snap.visibility || {}, ch.vis);
    }
  }
}

/**
 * Rebuild the live scene + tree from the active step's data. Same path the
 * tree paste uses after rewriting a step's spec: applySnapshotInstant tears
 * down folder groups while the old folders are still in the live tree, then
 * rebuilds the hierarchy from the (new) spec — so a removed folder's group
 * goes with it and its contents land in the parent's group.
 */
export function reapplyActiveStep() {
  const id = state.get('activeStepId');
  const s  = (state.get('steps') || []).find(x => x.id === id);
  if (s?.snapshot) steps.applySnapshotInstant(s.snapshot, { suppressCamera: true });
  state.emit('change:treeData', state.get('treeData'));
}

export function applyPlan(plan)  { _swap(plan, true);  reapplyActiveStep(); state.markDirty(); }
export function revertPlan(plan) { _swap(plan, false); reapplyActiveStep(); state.markDirty(); }

// ── Live verification (the step being viewed) ───────────────────────────────

/** World matrices of every live scene object, except the folders being removed. */
export function captureLiveWorld(removed) {
  const out  = new Map();
  const byId = state.get('nodeById') || new Map();
  for (const [id, obj] of steps.object3dById || []) {
    if (!obj || removed?.has(id) || !byId.has(id)) continue;
    obj.updateWorldMatrix(true, false);
    out.set(id, obj.matrixWorld.elements.slice());
  }
  return out;
}

/** First object whose live world pose differs, or null. */
export function compareLiveWorld(before, after) {
  const byId = state.get('nodeById') || new Map();
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a) return { id, name: byId.get(id)?.name || id, why: 'went missing from the scene' };
    if (!_sameMatrix(b, a)) return { id, name: byId.get(id)?.name || id, why: 'moved' };
  }
  return null;
}
