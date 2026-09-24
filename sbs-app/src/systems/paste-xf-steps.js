/**
 * SBS — paste a folder's transforms to MANY steps (V0.3.4.122).
 * ─────────────────────────────────────────────────────────────
 * The single-step "Copy / Paste Transforms" (ui/tree.js) writes the copied
 * poses — the folder A's own pose + every transform-bearing descendant — into
 * the CURRENT step only. This writes them into a scope of steps (all /
 * forward / backward / selected), matching nodes by their stable ids.
 *
 * The reference frame is the CURRENT step: there A sits under a folder B, and
 * the pasted pose of A is a LOCAL pose under B. Each step owns its own tree,
 * so in some steps A may not be under B any more. For those, the user picks
 * (once, for all of them):
 *   • 'virtual'  — keep the step's tree: place A as if it were under B (B's
 *                  world pose in that step ∘ the pasted local pose) and write
 *                  the result as A's local pose under its REAL parent there;
 *   • 'cascade'  — move A back under B in that step's tree, then paste;
 *   • 'skip'     — leave A's own pose alone there (descendants still paste).
 * B is found in a step by its id first; failing that, by its members: the
 * container holding the most of the objects that sat beside A in the
 * reference step (a majority of them at least). Steps where A is absent, or
 * B cannot be found, are skipped and reported.
 *
 * World poses come from the step's own snapshot (baseLocal* of the live node
 * ∘ the step's per-step delta, composed down the step's tree) — no live scene
 * needed, so hidden steps in the scope get exact poses too. One undo entry.
 * Descendants of A are always written as local poses under A, in every case.
 */

import { state }             from '../core/state.js';
import { steps }             from './steps.js';
import { undoManager }       from './undo.js';
import { cloneShareStrings } from '../core/clone.js';
import { isTransformNode, normalizeQuaternion, quarterTurnsFromQuaternion } from '../core/transforms.js';

// ── spec-tree helpers (immutable; mirror group-fix.js / follow.js) ─────────────
function _findSpec(spec, id) {
  if (!spec) return null;
  if (spec.id === id) return spec;
  for (const c of (spec.children || [])) { const r = _findSpec(c, id); if (r) return r; }
  return null;
}
function _containsId(spec, id) { return !!_findSpec(spec, id); }
/** The parent spec of `id` (null at the root), or undefined when `id` is not in the tree. */
function _parentOf(spec, id, parent = null) {
  if (!spec) return undefined;
  if (spec.id === id) return parent;
  for (const c of (spec.children || [])) { const r = _parentOf(c, id, spec); if (r !== undefined) return r; }
  return undefined;
}
/** The specs from the root down to `id`, inclusive; null when absent. */
function _pathTo(spec, id, acc = []) {
  if (!spec) return null;
  const next = [...acc, spec];
  if (spec.id === id) return next;
  for (const c of (spec.children || [])) { const r = _pathTo(c, id, next); if (r) return r; }
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

/** Scoped step ids (non-base; hidden ones included — they are steps too). */
export function scopedStepIds(scope) {
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

// ── world poses from a step's own data ───────────────────────────────────────
/**
 * A node's local matrix in a step — the composition core/transforms.js renders:
 * position = baseLocalPosition + (moveEnabled ? localOffset : 0), quaternion =
 * baseLocalQuaternion ⊗ (rotateEnabled ? localQuaternion : I), scale = base.
 * baseLocal* live on the live node (project-wide "home"); the delta is the
 * step's entry, or the live node's own when the step has none (which is what
 * activation leaves in place).
 */
function _localMatrixOf(spec, xf, live) {
  const bp = live?.baseLocalPosition   || [0, 0, 0];
  const bq = live?.baseLocalQuaternion || [0, 0, 0, 1];
  const bs = xf?.baseLocalScale || live?.baseLocalScale || [1, 1, 1];
  const d  = xf || (live ? { localOffset: live.localOffset, localQuaternion: live.localQuaternion, moveEnabled: live.moveEnabled, rotateEnabled: live.rotateEnabled } : null);
  const off = (!d || d.moveEnabled === false) ? [0, 0, 0] : (d.localOffset || [0, 0, 0]);
  const dq  = (!d || d.rotateEnabled === false) ? [0, 0, 0, 1] : (d.localQuaternion || [0, 0, 0, 1]);
  const q = new THREE.Quaternion(...normalizeQuaternion(bq)).multiply(new THREE.Quaternion(...normalizeQuaternion(dq)));
  return new THREE.Matrix4().compose(
    new THREE.Vector3(bp[0] + off[0], bp[1] + off[1], bp[2] + off[2]),
    q,
    new THREE.Vector3(bs[0] ?? 1, bs[1] ?? 1, bs[2] ?? 1),
  );
}
/** World matrix of `id` in a step: the local matrices down the step's tree. */
function _worldMatrixOf(tree, id, transforms, nodeById) {
  const chain = _pathTo(tree, id);
  if (!chain) return null;
  const m = new THREE.Matrix4();
  for (const spec of chain) {
    if (!isTransformNode(spec)) continue;   // the scene root, meshes: no pose of their own
    m.multiply(_localMatrixOf(spec, transforms?.[spec.id], nodeById?.get(spec.id)));
  }
  return m;
}

/** The container in a step that holds the most of `memberIds` as direct children (a majority at least). */
function _findByMembers(tree, memberIds, excludeSubtreeId) {
  let best = null, bestN = 0, tie = false;
  (function walk(s) {
    if (!s || s.id === excludeSubtreeId) return;
    const kids = s.children || [];
    const n = kids.filter(c => memberIds.has(c.id)).length;
    if (n > bestN) { best = s; bestN = n; tie = false; }
    else if (n === bestN && n > 0) tie = true;
    for (const c of kids) walk(c);
  })(tree);
  if (!best || tie || bestN === 0 || bestN * 2 < memberIds.size) return null;
  return { id: best.id, matched: bestN };
}

const _stepName = (s, i) => s?.name || `Step ${i + 1}`;

/**
 * Dry scan: where does A stand in each scoped step?
 * @returns {{ same: string[], diff: Array<{stepId,stepName,parentId,bId,by,matched}>, noB: Array<{stepId,stepName}>, absent: string[] }}
 */
export function scanPasteTransformsToSteps({ folderId, refParentId, refSiblingIds, scope }) {
  const out = { same: [], diff: [], noB: [], absent: [] };
  const all = state.get('steps') || [];
  const ids = new Set(scopedStepIds(scope));
  const members = new Set(refSiblingIds || []);
  all.forEach((s, i) => {
    if (!ids.has(s.id)) return;
    const tree = s.snapshot?.tree;
    if (!tree || !_containsId(tree, folderId)) { out.absent.push(s.id); return; }
    const parent = _parentOf(tree, folderId);
    const parentId = parent?.id ?? null;
    if (parentId === refParentId) { out.same.push(s.id); return; }
    const stepName = _stepName(s, i);
    if (refParentId && _findSpec(tree, refParentId) && !_containsId(_findSpec(tree, folderId), refParentId)) {
      out.diff.push({ stepId: s.id, stepName, parentId, bId: refParentId, by: 'id', matched: members.size });
      return;
    }
    const byM = members.size ? _findByMembers(tree, members, folderId) : null;
    if (byM && byM.id !== parentId) { out.diff.push({ stepId: s.id, stepName, parentId, bId: byM.id, by: 'members', matched: byM.matched }); return; }
    if (byM && byM.id === parentId) { out.same.push(s.id); return; }   // B lost its id but is the parent anyway
    out.noB.push({ stepId: s.id, stepName });
  });
  return out;
}

/**
 * The paste. `poses` = [{ id, xf }] resolved against the CURRENT tree (A itself
 * has id === folderId). `diffMode` = 'virtual' | 'cascade' | 'skip'.
 * @returns the report
 */
export function pasteTransformsToSteps({ folderId, folderName, refParentId, refSiblingIds, poses, includeRoot, diffMode, scope }) {
  const nodeById = state.get('nodeById');
  const plan = scanPasteTransformsToSteps({ folderId, refParentId, refSiblingIds, scope });
  const diffById = new Map(plan.diff.map(d => [d.stepId, d]));
  const sameSet = new Set(plan.same);
  const noBSet  = new Set(plan.noB.map(d => d.stepId));
  const rootXf  = poses.find(p => p.id === folderId)?.xf || null;
  const kids    = poses.filter(p => p.id !== folderId);

  const rep = { same: 0, virtual: 0, cascade: 0, rootSkipped: [], absent: plan.absent.length, descendants: 0, touched: [] };
  const all = state.get('steps') || [];
  const before = [];   // the touched steps as they were (undo)
  const updated = all.map((s, i) => {
    const isSame = sameSet.has(s.id), d = diffById.get(s.id), isNoB = noBSet.has(s.id);
    if (!isSame && !d && !isNoB) return s;
    const snap = s.snapshot;
    let tree = snap.tree;
    const specA = _findSpec(tree, folderId);
    if (!specA) return s;
    const xf = { ...(snap.transforms || {}) };
    let changed = false;

    // descendants — local under A, always
    for (const p of kids) {
      if (!_containsId(specA, p.id)) continue;
      const cur = xf[p.id] || {};
      xf[p.id] = { ...cur, ...p.xf, moveEnabled: cur.moveEnabled !== false, rotateEnabled: cur.rotateEnabled !== false, pivotEnabled: cur.pivotEnabled !== false };
      rep.descendants++; changed = true;
    }

    // A's own pose
    if (includeRoot && rootXf) {
      const live = nodeById?.get(folderId);
      const cur  = xf[folderId] || {};
      const keepFlags = { moveEnabled: cur.moveEnabled !== false, rotateEnabled: cur.rotateEnabled !== false, pivotEnabled: cur.pivotEnabled !== false };
      if (isSame) {
        xf[folderId] = { ...cur, ...rootXf, ...keepFlags };
        rep.same++; changed = true;
      } else if (d && diffMode === 'cascade') {
        tree = _addUnder(_removeFromSpec(tree, folderId), d.bId, specA) || tree;
        xf[folderId] = { ...cur, ...rootXf, ...keepFlags };
        rep.cascade++; changed = true;
      } else if (d && diffMode === 'virtual') {
        const Wb = _worldMatrixOf(tree, d.bId, xf, nodeById);
        const Wp = d.parentId ? _worldMatrixOf(tree, d.parentId, xf, nodeById) : new THREE.Matrix4();
        if (Wb && Wp) {
          const LA = _localMatrixOf(specA, { ...cur, ...rootXf, moveEnabled: true, rotateEnabled: true }, live);
          const Lp = Wp.clone().invert().multiply(Wb.clone().multiply(LA));   // A's local under its REAL parent
          const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
          Lp.decompose(pos, q, sc);
          const bp = live?.baseLocalPosition || [0, 0, 0], bq = live?.baseLocalQuaternion || [0, 0, 0, 1];
          const dq = new THREE.Quaternion(...normalizeQuaternion(bq)).invert().multiply(q);   // total = base ⊗ delta → delta = base⁻¹ ⊗ total
          const dqArr = normalizeQuaternion([dq.x, dq.y, dq.z, dq.w]);
          xf[folderId] = {
            ...cur, ...rootXf,
            localOffset: [pos.x - bp[0], pos.y - bp[1], pos.z - bp[2]],
            localQuaternion: dqArr,
            orientationSteps: quarterTurnsFromQuaternion(dqArr),
            moveEnabled: true, rotateEnabled: true,   // a computed pose must show
            pivotEnabled: keepFlags.pivotEnabled,
          };
          rep.virtual++; changed = true;
        } else rep.rootSkipped.push({ stepName: _stepName(s, i), why: 'pose could not be computed' });
      } else {
        rep.rootSkipped.push({ stepName: _stepName(s, i), why: isNoB ? `"${refParentId ? 'its folder' : 'the parent'}" not found` : 'skipped by choice' });
      }
    }
    if (!changed) return s;
    before.push(cloneShareStrings(s));
    rep.touched.push(s.id);
    return { ...s, snapshot: { ...snap, tree, transforms: xf }, altered: true };
  });
  if (!rep.touched.length) return rep;

  const touched = new Set(rep.touched);
  const after = updated.filter(s => touched.has(s.id)).map(s => cloneShareStrings(s));
  const restore = (list) => {
    const byId = new Map(list.map(s => [s.id, s]));
    state.setState({ steps: (state.get('steps') || []).map(s => byId.has(s.id) ? cloneShareStrings(byId.get(s.id)) : s) });
    state.markDirty?.();
    const active = state.get('activeStepId');
    if (active && touched.has(active)) steps.activateStep(active, false);   // the live tree + poses follow the snapshot
  };
  restore(after);
  const n = rep.same + rep.virtual + rep.cascade;
  undoManager.push(`Paste transforms onto "${folderName || 'folder'}" — ${rep.touched.length} step(s)${n ? '' : ' (descendants only)'}`, () => restore(before), () => restore(after));
  return rep;
}
