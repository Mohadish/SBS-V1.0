/**
 * 📦 FOLDER FLATTEN — Phase 1: the SCANNER (V0.3.2.243, backlog #16).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Finds folder levels that add nothing: `↪ Adj from "…"` compensation wrappers
 * nested inside each other, and pass-through folders that hold a single
 * container. Reports them, classified by what removing one would COST.
 *
 * THIS MODULE NEVER MUTATES ANYTHING. It reads the live tree and every step's
 * snapshot and returns a verdict per candidate. Actually collapsing a folder
 * is Phase 2 and is deliberately a separate, explicit, undoable action — the
 * scan is here first so the user can see the mess before anything touches it.
 *
 * ── Why the cost varies ────────────────────────────────────────────────────
 * Structurally an adjustment folder IS just a folder. What decides the cost is
 * its TRANSFORM:
 *
 *   SAFE   identity everywhere — in the live tree and in every step. Removing
 *          it is a pure reparent; no number changes anywhere.
 *   BAKE   it carries a transform, so each child's local transform has to be
 *          composed with it — PER STEP, because the wrapper's own offset is a
 *          per-step value (that is the whole reason these folders exist).
 *   UNSAFE something else points at this exact folder, or its transform cannot
 *          be composed away. Skip it; report why.
 *
 * ── The transform model this relies on (core/transforms.js) ────────────────
 * A node's local pose is  position = baseLocalPosition + localOffset,
 * quaternion = baseLocalQuaternion * localQuaternion, scale = baseLocalScale.
 * The BASE is global (lives only on the live tree node); the DELTAS are what
 * `step.snapshot.transforms[id]` carries per step. `snapshot.tree` is pure
 * structure — "Transforms are NOT duplicated here" (steps.js captureSnapshot).
 * So a future bake rewrites deltas per step and leaves bases alone, and the
 * per-step tree specs only need the node spliced out.
 *
 * The pivot is VIRTUAL — never part of object3d.position/quaternion — so a
 * relocated pivot on the wrapper has no world effect to compose, but it IS a
 * user-placed anchor that would be silently destroyed. That makes it unsafe,
 * not free.
 */

import { state } from '../core/state.js';
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

/**
 * Scan the project for folder levels worth collapsing.
 *
 * @returns {{
 *   candidates: object[], folders: number, steps: number, scannedAt: string
 * }}  candidates are ordered worst-first (unsafe, then bake, then safe), and
 *     within a verdict by tree depth so nested chains read top-down.
 */
export function scanRedundantFolders() {
  const root  = state.get('treeData');
  const steps = state.get('steps') || [];
  if (!root) return { candidates: [], folders: 0, steps: steps.length, scannedAt: new Date().toISOString() };

  const all  = flatten(root);
  const byId = new Map(all.map(n => [n.id, n]));

  // ── Who points at a folder BY ID ────────────────────────────────────────
  // A folder named in one of these is load-bearing: collapsing it leaves a
  // dangling id, and the feature that stored it silently stops working.
  const referenced = new Map();   // folderId → [why, …]
  const addRef = (id, why) => {
    if (!id) return;
    if (!referenced.has(id)) referenced.set(id, []);
    if (!referenced.get(id).includes(why)) referenced.get(id).push(why);
  };
  for (const n of all) {
    if (n.follow?.parentFolderId) addRef(n.follow.parentFolderId, `holds "${n.name || n.id}" for Follow Object`);
    if (n.follow?.wrapperId)      addRef(n.follow.wrapperId,      `is a Follow wrapper for "${n.name || n.id}"`);
  }
  const ifaceFolder = state.get('interfaceLibraryFolder');
  if (ifaceFolder) addRef(ifaceFolder, 'is the interface library folder');

  const candidates = [];
  let folders = 0;

  for (const node of all) {
    if (node.type !== 'folder') continue;
    if (node === root) continue;
    folders++;

    const kids = node.children || [];
    const isAdj = String(node.name || '').startsWith(ADJ_PREFIX);
    const onlyChildIsContainer = kids.length === 1 && CONTAINER_TYPES.has(kids[0].type);

    // Candidate shapes. An EMPTY folder is reported too but is a different
    // job (the tree already has "delete empty folder") — flagged, not mixed in.
    let kind = null;
    if (kids.length === 0)            kind = 'empty';
    else if (isAdj)                   kind = 'adj';
    else if (onlyChildIsContainer)    kind = 'passthrough';
    if (!kind) continue;

    ensureTransformDefaults(node);

    const reasons  = [];   // why it is unsafe
    const notes    = [];   // what a bake would involve
    let verdict    = 'safe';

    // ── Hard blockers ─────────────────────────────────────────────────────
    const refs = referenced.get(node.id);
    if (refs) reasons.push(...refs);
    if (node.locked)   reasons.push('folder is locked');
    if (node.archived) reasons.push('folder is archived');

    // ── Transform survey: live tree + every step ──────────────────────────
    const baseStill = isNearZero(node.baseLocalPosition || [0, 0, 0])
      && isIdentityQuaternion(node.baseLocalQuaternion || [0, 0, 0, 1])
      && _deltaIsStill(node);   // the live tree's own delta counts as a step too
    const unitScale = _isUnitScale(node.baseLocalScale);

    let movingSteps  = 0;
    let hiddenSteps  = 0;
    let missingSteps = 0;
    let pivotSteps   = _hasPivot(node) ? 1 : 0;

    for (const s of steps) {
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
    }
    if (!unitScale && !_isUniformScale(node.baseLocalScale)) {
      reasons.push('non-uniform scale — composing it with a rotation shears the children');
    }

    // ── Verdict ───────────────────────────────────────────────────────────
    // Is there a POSE to push down into the children, or is this folder just
    // an empty level? An identity folder can always go: its children's world
    // poses do not depend on it, whatever they are.
    const hasPose = !baseStill || !unitScale || movingSteps > 0;

    // A child that cannot carry a transform DELTA has nowhere to receive the
    // folder's pose — and that only matters when there IS a pose. This is the
    // wall for moving ↪ Adj wrappers: they wrap raw MESHES, and a mesh has no
    // per-step transform of its own (isTransformNode excludes it; its world
    // pose comes from its parent chain and its baked import matrix). Composing
    // into one would mean rewriting geometry or the Object3D matrix, outside
    // this data model. An IDENTITY wrapper around meshes is still free.
    const stuckKids = hasPose ? kids.filter(k => !isTransformNode(k)) : [];
    if (stuckKids.length) {
      reasons.push(`carries a pose, but ${stuckKids.length} child(ren) cannot absorb it (${
        [...new Set(stuckKids.map(k => k.type))].join(', ')}) — nothing to compose into`);
    }

    if (reasons.length) {
      verdict = 'unsafe';
    } else if (kind === 'empty' || !hasPose) {
      verdict = 'safe';
      if (missingSteps) notes.push(`absent from ${missingSteps} step(s) — nothing to do there`);
    } else {
      verdict = 'bake';
      if (movingSteps)   notes.push(`moves on ${movingSteps} of ${steps.length} step(s) — each one composes separately`);
      if (!baseStill)    notes.push('carries a fixed offset/rotation of its own');
      if (!unitScale)    notes.push('carries a scale — it multiplies into every child');
      if (missingSteps)  notes.push(`absent from ${missingSteps} step(s)`);
    }

    // Inherited visibility is a semantic the children do not have. Folding it
    // in means writing each child's own localVisible per step — reported so
    // the bake is never a surprise, never silently dropped. Meshes DO carry
    // localVisible, so this alone never blocks.
    if (hiddenSteps && verdict !== 'unsafe') {
      notes.push(`hidden on ${hiddenSteps} step(s) — its children would each need their own hide`);
      if (verdict === 'safe') verdict = 'bake';
    }

    const parent = findParent(root, node.id);
    // getPathToNode returns node IDs, root first — name them, drop the root.
    const pathIds = getPathToNode(root, node.id) || [];
    const path = pathIds.slice(1)
      .map(id => byId.get(id)?.name || id)
      .join(' / ');
    candidates.push({
      id:        node.id,
      name:      node.name || node.id,
      path,
      parentId:  parent?.id || null,
      parentName: parent?.name || '(scene)',
      kind, verdict, reasons, notes,
      childCount: kids.length,
      movingSteps, hiddenSteps, missingSteps,
      depth: pathIds.length,
    });
  }

  const rank = { unsafe: 0, bake: 1, safe: 2 };
  candidates.sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || (a.depth - b.depth) || a.name.localeCompare(b.name));

  return { candidates, folders, steps: steps.length, scannedAt: new Date().toISOString() };
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
