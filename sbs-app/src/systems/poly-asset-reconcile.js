/**
 * ⬚ POLY ASSET RECONCILE (V0.3.5.16) — pure: what every step must learn when
 * the content of a Poly Editor asset changes under a model that is already in
 * the project.
 *
 * A step snapshot is a standalone scene description; its `tree` is the sole
 * authority for structure when the step is activated. So when an asset is
 * saved over (or found changed on disk when a project opens), each snapshot
 * is brought up to date with the same four rules:
 *
 *   KEPT    a part with the same id keeps everything the step knows about it —
 *           visibility, colour override, what is attached to it, and WHERE it
 *           is: a part the user dragged out of the model in that step stays
 *           where they put it;
 *   MOVED   a part that changed folder in the asset follows its new folder, but
 *           only in the steps where it still sat in its old home;
 *   ADDED   a new part / folder enters every step that has the model, under its
 *           folder (or the model's root when that folder is not in the step);
 *   GONE    a removed part / folder leaves the step; whatever was parked under
 *           it (a shape, a screw, a user folder, a kept part) moves up to its
 *           parent first, so nothing else disappears with it.
 *
 * A step is STARRED (its saved picture no longer matches) only when something
 * it actually shows changed.
 *
 * No THREE, no state — plain objects in, plain objects out (node-tested).
 *
 * manifest = { v: 1, root: <inner root id>, nodes: { [id]: { k: 'm' | 'f', p: <parent id>, n: <name>, u: <the part's permanent id in the file>, h?: <hash of a part's shape>, fr?: <its pivot + axes in the Poly Editor: { p, q }> } } }
 * — what the project last knew of the asset's own ("native") nodes. The uid is
 * kept here because a folder's three.js group is rebuilt on every step change.
 */

export function makeManifest(rootId, entries) {
  const nodes = {};
  for (const e of entries || []) nodes[e.id] = { k: e.kind === 'folder' || e.kind === 'f' ? 'f' : 'm', p: e.parent || rootId, n: String(e.name ?? ''), u: e.uid || null, ...(e.hash ? { h: e.hash } : {}), ...(e.frame ? { fr: e.frame } : {}) };
  return { v: 1, root: rootId, nodes };
}

/** True when every node of the manifest carries its permanent id (an asset that can be updated in place). */
export const manifestHasUids = (m) => !!m?.nodes && !!m.root && Object.values(m.nodes).every(e => typeof e.u === 'string' && e.u);

/**
 * The manifest a project had before manifests were stored: read off a saved model spec.
 * Native = a mesh the spec says belongs to this asset, and a folder the file still has (knownIds).
 * It errs on the side of "not ours": a folder or mesh of ANOTHER model parked under this one must
 * never be read as a removed part of this asset. Everything else is skipped over.
 */
export function manifestFromSpec(modelSpec, assetId, otherMeshSpecs = [], knownIds = null) {
  const inner = (modelSpec?.children || []).find(c => c.type === 'folder' || c.type === 'group') || null;
  const rootId = inner?.id || `${modelSpec?.id}:root`;
  const entries = [], seen = new Set();
  // (a Replace-Model copy of a part carries the asset id too, but it is the user's object, not the file's: sourceNodeId)
  const isMesh = (s) => s.type === 'mesh' && !s.sourceNodeId && (s.sourceAssetId === assetId || !!knownIds?.has(s.id));
  const isFolder = (s) => (s.type === 'folder' || s.type === 'group') && (knownIds ? knownIds.has(s.id) : String(s.id).startsWith('fd_'));
  (function walk(spec, nativeParent) {
    for (const c of spec?.children || []) {
      if (isMesh(c)) { entries.push({ id: c.id, kind: 'mesh', parent: nativeParent, name: c.name }); seen.add(c.id); walk(c, nativeParent); }
      else if (isFolder(c)) { entries.push({ id: c.id, kind: 'folder', parent: nativeParent, name: c.name }); seen.add(c.id); walk(c, c.id); }
      else walk(c, nativeParent);
    }
  })(inner || modelSpec, rootId);
  for (const s of otherMeshSpecs || []) if (s?.sourceAssetId === assetId && !s.sourceNodeId && !seen.has(s.id)) { entries.push({ id: s.id, kind: 'mesh', parent: rootId, name: s.name }); seen.add(s.id); }
  return makeManifest(rootId, entries);
}

const _depth = (m, id) => { let d = 0, p = m.nodes[id]?.p, guard = 0; while (p && m.nodes[p] && guard++ < 10000) { d++; p = m.nodes[p].p; } return d; };

/** old manifest → new manifest: what was added (top-down), what is gone (deepest first), what moved, what was renamed. */
export function diffManifests(oldM, newM) {
  const o = oldM?.nodes || {}, n = newM?.nodes || {};
  const added = Object.keys(n).filter(id => !o[id]).sort((a, b) => _depth(newM, a) - _depth(newM, b));
  const gone = Object.keys(o).filter(id => !n[id]).sort((a, b) => _depth(oldM, b) - _depth(oldM, a));
  const moved = [], renamed = [], kept = [];
  const rootOf = (m, p) => (p === m.root ? '#root' : p);   // the two manifests may name the root differently
  for (const id of Object.keys(n)) {
    if (!o[id]) continue;
    kept.push(id);
    if (rootOf(oldM, o[id].p) !== rootOf(newM, n[id].p)) moved.push({ id, from: o[id].p, to: n[id].p });
    if (o[id].n !== n[id].n) renamed.push({ id, name: n[id].n });
  }
  return { added, gone, moved, renamed, kept };
}

export const isEmptyDiff = (d) => !d || (!d.added.length && !d.gone.length && !d.moved.length && !d.renamed.length);
export const structureChanged = (d) => !!d && (d.added.length > 0 || d.gone.length > 0 || d.moved.length > 0);

function _cloneTree(spec) { return spec ? { ...spec, children: (spec.children || []).map(_cloneTree) } : spec; }
function _index(tree) {
  const idx = new Map();
  (function walk(spec, parent) { if (!spec) return; idx.set(spec.id, { spec, parent }); for (const c of spec.children || []) walk(c, spec); })(tree, null);
  return idx;
}
const _isUnder = (spec, ancestor) => { let found = false; (function walk(s) { if (found || !s) return; if (s === spec) { found = true; return; } for (const c of s.children || []) walk(c); })(ancestor); return found; };
/** Is this node drawn in the step: itself and every ancestor visible and not archived. */
function _shown(idx, vis, id) {
  let e = idx.get(id), guard = 0;
  while (e && guard++ < 10000) {
    if (e.spec.archived === true) return false;
    if (vis && vis[e.spec.id] === false) return false;
    e = e.parent ? idx.get(e.parent.id) : null;
  }
  return true;
}

/**
 * One snapshot brought up to date.
 * ctx = { modelId, oldM, newM, diff, specFor(id) → a lean spec for an added node (children: []),
 *         folderXf() → a fresh neutral transform entry for an added folder,
 *         metaFor?(id) → { bbox, fingerprint } for a kept mesh, changedIds?: Set of kept meshes whose shape changed }
 * → { snapshot, touched, picture, rehomed } — `snapshot` is the input object when nothing applied;
 *   `picture` = something this step actually shows changed.
 */
export function patchSnapshot(snap, ctx) {
  const none = { snapshot: snap, touched: false, picture: false, rehomed: 0 };
  if (!snap || !snap.tree) return none;
  const { modelId, oldM, newM, diff } = ctx;
  if (!_index(snap.tree).has(modelId)) return none;         // the model is not in this step
  const tree = _cloneTree(snap.tree), idx = _index(tree);
  let vis = snap.visibility || null, xf = snap.transforms || null, mats = snap.materials || null;
  let touched = false, picture = false, rehomed = 0;
  const native = (id) => !!(oldM.nodes[id] || newM.nodes[id]) || id === oldM.root || id === newM.root;
  const orphaned = new Set();                              // kept natives whose folder went away under them

  // GONE — deepest first; the children move up into the gone node's place
  for (const id of diff.gone) {
    const e = idx.get(id);
    if (e && e.parent) {
      if (oldM.nodes[id]?.k === 'm' && _shown(idx, vis, id)) picture = true;
      const list = e.parent.children, at = list.indexOf(e.spec), kids = e.spec.children || [];
      list.splice(at, 1, ...kids);
      for (const k of kids) { idx.set(k.id, { spec: k, parent: e.parent }); if (native(k.id)) orphaned.add(k.id); else rehomed++; }
      idx.delete(id);
      touched = true;
    }
    if (vis && vis[id] !== undefined) { vis = { ...vis }; delete vis[id]; touched = true; }
    if (xf && xf[id] !== undefined) { xf = { ...xf }; delete xf[id]; touched = true; }
    if (mats && mats[id] !== undefined) { mats = { ...mats }; delete mats[id]; touched = true; }
  }

  // ADDED — top-down, so a new folder is there before its new children
  for (const id of diff.added) {
    if (idx.has(id)) continue;                             // already known to this step
    const want = newM.nodes[id].p;
    const target = idx.get(want)?.spec || idx.get(newM.root)?.spec || idx.get(oldM.root)?.spec || idx.get(modelId).spec;
    const spec = { ...ctx.specFor(id), children: [] };
    target.children = [...(target.children || []), spec];
    idx.set(id, { spec, parent: target });
    vis = { ...(vis || {}), [id]: true };
    if (newM.nodes[id].k === 'f' && ctx.folderXf) xf = { ...(xf || {}), [id]: ctx.folderXf() };
    if (newM.nodes[id].k === 'm' && _shown(idx, vis, id)) picture = true;
    touched = true;
  }

  // MOVED — only where the part still sat in its old home (or lost it just now)
  for (const { id, from, to } of diff.moved) {
    const e = idx.get(id);
    if (!e || !e.parent) continue;
    const home = from === oldM.root ? [oldM.root, newM.root] : [from];
    if (!home.includes(e.parent.id) && !orphaned.has(id)) continue;   // the user placed it elsewhere in this step: it stays
    const target = idx.get(to)?.spec || (to === newM.root ? idx.get(oldM.root)?.spec : null);
    if (!target || target === e.parent || _isUnder(target, e.spec)) continue;
    e.parent.children = e.parent.children.filter(c => c !== e.spec);
    target.children = [...(target.children || []), e.spec];
    idx.set(id, { spec: e.spec, parent: target });
    if (_shown(idx, vis, id)) picture = true;
    touched = true;
  }

  // names + the mesh facts a spec carries
  for (const { id, name } of diff.renamed) { const e = idx.get(id); if (e && e.spec.name !== name) { e.spec.name = name; touched = true; } }
  for (const id of diff.kept) {
    if (newM.nodes[id].k !== 'm') continue;
    const e = idx.get(id); if (!e) continue;
    const m = ctx.metaFor ? ctx.metaFor(id) : null;
    const fpDiff = !!m?.fingerprint && e.spec.fingerprint !== m.fingerprint;
    const reshaped = ctx.changedIds ? ctx.changedIds.has(id) : fpDiff;   // the caller knows which shapes changed; else the fingerprint says
    if (m?.bbox) e.spec.bbox = m.bbox;
    if (m?.fingerprint) e.spec.fingerprint = m.fingerprint;
    if (fpDiff || reshaped) touched = true;
    if (reshaped && _shown(idx, vis, id)) picture = true;
  }

  if (!touched) return none;
  return { snapshot: { ...snap, tree, visibility: vis ?? snap.visibility, transforms: xf ?? snap.transforms, materials: mats ?? snap.materials }, touched: true, picture, rehomed };
}

/** Every step patched; a step whose picture changed is starred (never the base step). */
export function patchSteps(steps, ctx) {
  let changed = 0, starred = 0, rehomed = 0;
  const next = (steps || []).map(st => {
    const r = patchSnapshot(st?.snapshot, ctx);
    if (!r.touched) return st;
    changed++; rehomed += r.rehomed;
    if (!r.picture) {
      // Nothing this step SHOWS changed (the part is hidden here, or only a name moved): the facts are
      // written into the same snapshot object. The ★ logic tells "re-captured" by the object itself —
      // a new object here would star the whole timeline after a one-part edit.
      Object.assign(st.snapshot, { tree: r.snapshot.tree, visibility: r.snapshot.visibility, transforms: r.snapshot.transforms, materials: r.snapshot.materials });
      return st;
    }
    const star = !st.isBaseStep;
    if (star) starred++;
    return { ...st, snapshot: r.snapshot, ...(star ? { altered: true } : {}) };
  });
  return { steps: next, changed, starred, rehomed };
}

/**
 * What hangs on the parts that are about to go: every non-native node whose nearest native
 * ancestor is a gone node — in a tree spec, or a live tree (same shape). → [{ id, name, type, on }]
 */
export function attachedToGone(tree, goneIds, isNative) {
  const gone = goneIds instanceof Set ? goneIds : new Set(goneIds || []), out = [];
  (function walk(spec, under) {
    if (!spec) return;
    if (gone.has(spec.id)) under = spec.id;
    else if (isNative(spec.id)) under = null;
    else if (under) { out.push({ id: spec.id, name: spec.name || spec.type || spec.id, type: spec.type || '', on: under }); return; }
    for (const c of spec.children || []) walk(c, under);
  })(tree, null);
  return out;
}

/**
 * IN PLACE: gone nodes leave a tree and their children move up into their place (a saved project tree
 * read from disk, about to be used to re-attach shapes / notes). → the non-native children that moved up.
 */
export function spliceGoneFromTree(tree, goneIds, isNative) {
  const gone = goneIds instanceof Set ? goneIds : new Set(goneIds || []), moved = [];
  if (!tree || !gone.size) return moved;
  (function walk(spec) {
    if (!spec?.children) return;
    for (let i = 0; i < spec.children.length; i++) {
      const c = spec.children[i];
      if (!gone.has(c.id)) continue;
      const kids = c.children || [];
      for (const k of kids) if (!gone.has(k.id) && !isNative(k.id)) moved.push({ id: k.id, name: k.name || k.type || k.id, type: k.type || '', from: c.id });
      spec.children.splice(i, 1, ...kids);
      i--;                                                 // look at what just moved up (a gone folder inside a gone folder)
    }
    for (const c of spec.children) walk(c);
  })(tree);
  return moved;
}
