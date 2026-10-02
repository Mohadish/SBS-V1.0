/**
 * ⬚ POLY ASSET UPDATE (V0.3.5.16) — save an edit OVER the asset and keep the same model.
 *
 * The user's rule: re-editing an asset the Poly Editor wrote should, by default,
 * overwrite that .glb and update the SAME model in the project — not leave a
 * "poly-asset-2" beside it. A part is the same node before and after (its id
 * comes from the asset id + the part's permanent id in the file), so:
 *
 *   kept part     only a part whose shape changed gets new geometry — on the SAME
 *                 node and mesh object; what every step knows about it (visibility,
 *                 colour, things attached, the folder the user dragged it to) is
 *                 untouched;
 *   new part      joins the model and enters every step (poly-asset-reconcile);
 *   removed part  leaves the model and every step. If anything is attached to it
 *                 (a note, a shape, a screw, a cable end, a follower) the update
 *                 is REFUSED before a byte is written, and says what is attached;
 *   moved part    follows its new folder in the steps where it still sat in the
 *                 old one; where the user had placed it elsewhere it stays.
 *
 * The previous file is copied to <project>/backups/ first; the undo history is
 * cleared afterwards (a file overwrite cannot be undone — like a project load).
 *
 * Two entry points share the step reconcile:
 *   updatePolyAssetInPlace()      Apply ▸ "update" in the Poly Editor;
 *   preparePolyAssetOnLoad() +    a project opens and finds the asset changed on
 *   reconcilePolyAssetsOnLoad()   disk (edited from another project): the same
 *                                 rules, except nothing can be refused any more —
 *                                 what hung on a removed part moves up to its parent.
 */
import { state } from '../core/state.js';
import { steps } from './steps.js';
import { materials } from './materials.js';
import { undoManager } from './undo.js';
import { serializeModelTree, buildNodeMap } from '../core/nodes.js';
import { captureTransformSnapshot, applyNodeSourceTransformToObject3D } from '../core/transforms.js';
import { createNode } from '../core/schema.js';
import { polyPartNodeId, parsePolyGlb, adoptPolyMesh, geomFingerprint, polyContentHash } from '../io/importers.js';
import { makeManifest, manifestHasUids, manifestFromSpec, diffManifests, patchSteps, attachedToGone, spliceGoneFromTree, isEmptyDiff, structureChanged } from './poly-asset-reconcile.js';
import { subDir, joinPath } from '../core/project-paths.js';

const _nodeById = () => state.get('nodeById');
const _assetOf = (assetId) => (state.get('assets') || []).find(a => a.id === assetId) || null;

/**
 * Is this model an asset the Poly Editor wrote that can be updated in place — its file known, and
 * the project holding its manifest with every part's permanent id? → { modelId, assetId, path, file } | null
 * (An asset written before part ids existed is edited like any other object: the result is a new asset.)
 */
export function polyAssetOfModel(modelNode) {
  if (!modelNode || modelNode.type !== 'model' || !modelNode.assetId || modelNode.missing) return null;
  const outer = steps.object3dById.get(modelNode.id) ?? modelNode.object3d;
  if (!outer?.userData?.sbsPolyEditorAsset) return null;
  if (!manifestHasUids(modelNode.polyManifest) || !Object.keys(modelNode.polyManifest.nodes).length) return null;
  const asset = _assetOf(modelNode.assetId);
  const path = asset?.originalPath || '';
  if (!path || !/\.glb$/i.test(path)) return null;
  return { modelId: modelNode.id, assetId: modelNode.assetId, path, file: path.split(/[\\/]/).pop() };
}

/** parts = [{ uid, kind: 'part' | 'folder', name, parentUid | null }] top-down, exactly what the new file holds. */
function _manifestOfParts(assetId, rootId, parts) {
  const idOf = new Map(parts.map(p => [p.uid, polyPartNodeId(assetId, p.uid, p.kind === 'part')]));
  return {
    idOf,
    manifest: makeManifest(rootId, parts.map(p => ({ id: idOf.get(p.uid), kind: p.kind === 'part' ? 'mesh' : 'folder', parent: p.parentUid ? idOf.get(p.parentUid) : rootId, name: p.name, uid: p.uid, frame: p.frame || null }))),
  };
}

/** Everything that hangs on the parts about to go, in the live tree, in every step, on cables and followers. */
function _attached(oldM, newM, gone) {
  if (!gone.length) return [];
  const goneSet = new Set(gone), found = new Map();
  const isNative = (id) => !!(oldM.nodes[id] || newM.nodes[id]) || id === oldM.root || id === newM.root;
  const scan = (tree, where) => { for (const a of attachedToGone(tree, goneSet, isNative)) if (!found.has(a.id)) found.set(a.id, { ...a, where }); };
  scan(state.get('treeData'), 'the scene');
  for (const st of state.get('steps') || []) if (st?.snapshot?.tree) scan(st.snapshot.tree, st.isBaseStep ? 'the scene' : (st.name || 'a step'));
  for (const cable of state.get('cables') || []) for (const n of cable.nodes || []) {
    const on = (n.anchorType === 'mesh' && goneSet.has(n.nodeId)) ? n.nodeId : (goneSet.has(n.socket?.connectTarget?.nodeId) ? n.socket.connectTarget.nodeId : null);
    if (on && !found.has(`cable:${cable.id}`)) found.set(`cable:${cable.id}`, { id: cable.id, name: cable.name || 'Cable', type: 'cable end', on, where: 'the scene' });
  }
  for (const n of _nodeById()?.values() || []) if (n.follow?.targetId && goneSet.has(n.follow.targetId) && !found.has(n.id)) found.set(n.id, { id: n.id, name: n.name || n.type, type: 'follower', on: n.follow.targetId, where: 'the scene' });
  const nameOf = (id) => oldM.nodes[id]?.n || id;
  return [...found.values()].map(a => ({ ...a, onName: nameOf(a.on) }));
}

const _normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

/**
 * What an update would do, without doing it. opts.path = write the edit to THAT file and point the
 * model at it (the project swaps to a copy; the old file is not touched) instead of saving over the old one.
 */
export function planPolyAssetUpdate(modelId, parts, opts = {}) {
  const model = _nodeById()?.get(modelId);
  const info = polyAssetOfModel(model);
  if (!info) return { ok: false, reason: 'That model is not an asset of the Poly Editor that can be updated (or its file is unknown).' };
  const norm = _normPath;
  const swap = !!opts.path && norm(opts.path) !== norm(info.path);
  let twins = 0;
  for (const n of _nodeById()?.values() || []) {
    if (n.assetId && n.assetId !== info.assetId && !n.missing && (n.type === 'model' || n.type === 'replaceModel') && norm(_assetOf(n.assetId)?.originalPath) === norm(info.path)) twins++;
  }
  if (twins && !swap) return { ok: false, reason: `${info.file} is loaded ${twins + 1} times in this project — saving over it would leave the other cop${twins === 1 ? 'y' : 'ies'} out of date.` };
  const oldM = model.polyManifest;
  const { manifest: newM, idOf } = _manifestOfParts(info.assetId, oldM.root, parts);
  const diff = diffManifests(oldM, newM);
  return { ok: true, ...info, model, oldM, newM, idOf, diff, swap, target: swap ? opts.path : info.path, structureChanged: structureChanged(diff), attached: _attached(oldM, newM, diff.gone) };
}

/**
 * Would removing this asset's model from the scene leave something behind?
 * → { attached: what hangs on its parts (live tree, every step, cables, followers), outside: parts that sit outside its model row }
 */
export function polyAssetRemovalBlockers(modelId) {
  const nb = _nodeById(), model = nb?.get(modelId), M = model?.polyManifest;
  if (!M?.nodes) return { attached: [], outside: 0 };
  const gone = Object.keys(M.nodes);
  const attached = _attached(M, makeManifest(M.root, []), gone);
  const under = new Set();
  (function w(n) { if (!n) return; under.add(n.id); (n.children || []).forEach(w); })(model);
  const outside = gone.filter(id => M.nodes[id].k === 'm' && nb.has(id) && !under.has(id)).length;
  return { attached, outside };
}

/** A new part's colour: a preset this asset already uses with the same hex, else a new one — its default from now on. */
function _colourNewMeshes(assetId, ids) {
  if (!ids.length) return;
  const presets = state.get('colorPresets') || [], byHex = new Map();
  for (const n of _nodeById()?.values() || []) {
    if (n.type !== 'mesh' || n.sourceAssetId !== assetId) continue;
    const p = presets.find(x => x.id === materials.meshDefaultColors[n.id]);
    if (p?.color) byHex.set(String(p.color).toLowerCase(), p);
  }
  for (const id of ids) {
    const orig = materials.originalMaterials.get(id);
    if (!orig || Array.isArray(orig)) continue;
    const hex = (orig.color?.isColor ? '#' + orig.color.getHexString() : '#bfcad4').toLowerCase();
    let preset = byHex.get(hex);
    if (!preset) { preset = materials.createPreset({ color: hex, name: hex, roughness: Number.isFinite(orig.roughness) ? orig.roughness : 0.45, metalness: Number.isFinite(orig.metalness) ? orig.metalness : 0.05 }); byHex.set(hex, preset); }
    materials.meshColorAssignments[id] = preset.id;
    materials.meshDefaultColors[id] = preset.id;
  }
  state.emit('materials:defaultColorsChanged');
}

function _reconcileCtx(modelId, oldM, newM, diff, changedIds = null) {
  const nb = _nodeById();
  return {
    modelId, oldM, newM, diff, changedIds,
    specFor: (id) => {
      const node = nb?.get(id);
      if (node && newM.nodes[id].k === 'm') return { ...serializeModelTree(node), children: [] };
      return { id, name: newM.nodes[id].n, type: newM.nodes[id].k === 'f' ? 'folder' : 'mesh', localVisible: true, archived: false, children: [] };
    },
    folderXf: () => captureTransformSnapshot(createNode('folder', { id: 'tmp_poly_folder', name: '' })),
    metaFor: (id) => { const n = nb?.get(id); return n ? { bbox: n.bbox, fingerprint: n.fingerprint } : null; },
  };
}

/** A live node leaves the tree; its children move up into its place. */
function _spliceLive(root, id) {
  let done = false;
  (function walk(n) {
    if (done || !n?.children) return;
    const at = n.children.findIndex(c => c.id === id);
    if (at >= 0) { const gone = n.children[at]; n.children.splice(at, 1, ...(gone.children || [])); done = true; return; }
    n.children.forEach(walk);
  })(root);
  return done;
}

function _refreshMeshNode(node, mesh) {
  try {
    mesh.geometry.computeBoundingBox(); mesh.geometry.computeBoundingSphere();
    const bb = mesh.geometry.boundingBox;
    if (bb && isFinite(bb.min.x) && isFinite(bb.max.x)) node.bbox = { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] };
    node.fingerprint = geomFingerprint(mesh.geometry);
  } catch (err) { console.warn('[poly asset] bbox', node.id, err); }
}

const _samePoly = (a, b) => { try { return !!a && !!b && JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };

/**
 * Apply ▸ replace (or, with opts.path, ▸ "save a copy and use it in place of the old model").
 * parts = what the new file holds; glb = its bytes (ArrayBuffer).
 * → { ok: true, added, gone, moved, reshaped, stepsChanged, backup, file } | { ok: false, reason, attached? }
 */
export async function updatePolyAssetInPlace(modelId, parts, glb, opts = {}) {
  const plan = planPolyAssetUpdate(modelId, parts, opts);
  if (!plan.ok) return plan;
  if (plan.attached.length) return { ok: false, reason: 'attached', attached: plan.attached };
  if (steps._animRunning) return { ok: false, reason: 'A step is still animating — try again in a moment.' };
  const nat = window.sbsNative;
  if (!nat?.writeFile) return { ok: false, reason: 'Saving needs the desktop app.' };
  const { assetId, oldM, newM, idOf, diff, swap } = plan;
  const path = plan.target, newFile = path.split(/[\\/]/).pop();
  steps.flushSync();

  // ── the file: the old one to backups/, the new one in its place (a swap leaves the old file alone) ──
  let backup = null;
  if (!swap) try {
    const old = await nat.readFile(path, 'buffer');
    const dir = subDir('backups');
    if (old?.ok && dir) {
      try { await nat.mkdir?.(dir); } catch { /* writeFile makes the folder too */ }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      backup = joinPath(dir, `${plan.file.replace(/\.glb$/i, '')}.${stamp}.glb`);
      const w = await nat.writeFile(backup, old.data);
      if (!w?.ok) backup = null;
    }
  } catch (err) { console.warn('[poly asset] backup failed', err); backup = null; }
  let parsed;
  try { parsed = await parsePolyGlb(glb.slice(0)); }             // read it back BEFORE the old file is replaced
  catch (err) { return { ok: false, reason: `The new file could not be read back (${err?.message || err}) — nothing was changed.` }; }
  const res = await nat.writeFile(path, new Uint8Array(glb));
  if (!res?.ok) return { ok: false, reason: `The file could not be written: ${res?.error || 'unknown error'}` };
  let st = null;
  try { st = await nat.statFile?.(path); } catch { /* "now" will do */ }

  // ── from here on everything is synchronous: no step sync can see a half-swapped scene ──
  const nb = _nodeById(), model = nb.get(modelId);
  const outer = steps.object3dById.get(modelId) ?? model.object3d;
  const root = state.get('treeData');
  const uidOfId = new Map([...idOf].map(([uid, id]) => [id, uid]));
  const reshaped = new Set();
  for (const [id, e] of Object.entries(newM.nodes)) {       // what the next open compares the file with
    if (e.k !== 'm') continue;
    const h = polyContentHash(parsed.byUid.get(uidOfId.get(id))?.userData?.sbsPoly);
    if (h) e.h = h;
  }

  for (const id of diff.kept) {                              // KEPT: the same node, the same mesh object; new geometry only where the shape changed
    if (newM.nodes[id].k !== 'm') continue;
    const node = nb.get(id), mesh = steps.object3dById.get(id) ?? node?.object3d, src = parsed.byUid.get(uidOfId.get(id));
    if (!node || !mesh?.isMesh || !src?.isMesh || !src.geometry) continue;
    if (_samePoly(mesh.userData.sbsPoly, src.userData.sbsPoly)) continue;
    const assign = materials.meshColorAssignments[id], orig = materials.originalMaterials.get(id);
    materials.unregisterMesh(id);                           // drops the helper passes that hold the old geometry
    const oldG = mesh.geometry;
    mesh.geometry = src.geometry;
    try { oldG?.dispose?.(); } catch { /* fine */ }
    delete mesh.userData.sbsOriginalPosition; delete mesh.userData.sbsOriginalNormal;   // the source-transform bake starts again from the new vertices
    mesh.userData.sbsPoly = src.userData.sbsPoly; mesh.userData.sbsId = uidOfId.get(id);
    materials.registerMesh(id, mesh);
    if (orig) materials.originalMaterials.set(id, orig);    // registerMesh would have cloned the managed (preset) material
    if (assign !== undefined) materials.meshColorAssignments[id] = assign;
    _refreshMeshNode(node, mesh);
    reshaped.add(id);
  }
  for (const { id, name } of diff.renamed) { const node = nb.get(id); if (node) { node.name = name; const o = steps.object3dById.get(id); if (o) o.name = name; } }
  // A swap to another file: the model row and its inner folder are named after the file — unless the user named them.
  const relabel = new Map();
  if (swap) {
    const oldBase = plan.file.replace(/\.glb$/i, ''), inner = nb.get(newM.root);
    if (model.name === plan.file) { model.name = newFile; if (outer) outer.name = newFile; relabel.set(modelId, newFile); }
    if (inner && inner.name === oldBase) { inner.name = newFile.replace(/\.glb$/i, ''); relabel.set(inner.id, inner.name); }
  }

  for (const id of diff.gone) {                              // GONE
    const node = nb.get(id), obj = steps.object3dById.get(id) ?? node?.object3d;
    if (oldM.nodes[id].k === 'm') {
      materials.unregisterMesh(id);
      delete materials.meshDefaultColors[id];
      if (obj) { obj.parent?.remove(obj); try { obj.geometry?.dispose?.(); } catch { /* fine */ } }
    }
    steps.object3dById.delete(id);
    _spliceLive(root, id);
    nb.delete(id);
  }

  const innerNode = nb.get(newM.root) || model;
  const addedMeshIds = [];
  const T = window.THREE;
  for (const id of diff.added) {                             // ADDED (a folder needs nothing live: the step's tree builds it)
    if (newM.nodes[id].k !== 'm') continue;
    const uid = uidOfId.get(id), src = parsed.byUid.get(uid);
    if (!src?.isMesh) continue;
    const node = adoptPolyMesh(src, assetId, uid, newM.nodes[id].n);
    outer.add(src);
    src.userData.sbsModelLocalMatrix = new T.Matrix4().toArray();   // the file's vertices are already in the model's space
    steps.object3dById.set(id, src);
    innerNode.children = [...(innerNode.children || []), node];
    nb.set(id, node);
    addedMeshIds.push(id);
  }
  _colourNewMeshes(assetId, addedMeshIds);

  // ── every step ─────────────────────────────────────────────────────────────
  const r = patchSteps(state.get('steps') || [], _reconcileCtx(modelId, oldM, newM, diff, reshaped));
  model.polyManifest = newM;
  if (relabel.size) for (const s of r.steps) (function w(n) { if (!n) return; if (relabel.has(n.id)) n.name = relabel.get(n.id); (n.children || []).forEach(w); })(s?.snapshot?.tree);   // a spec's name renames the live node when its step is opened
  const assets = (state.get('assets') || []).map(a => (a.id === assetId
    ? { ...a, fileSize: glb.byteLength, lastModified: st?.mtimeMs ? Math.round(st.mtimeMs) : Date.now(), ...(swap ? { originalPath: path, relativePath: '', name: newFile } : {}) }
    : a));
  state.setState({ steps: r.steps, assets, nodeById: buildNodeMap(root) });

  // ── the scene: source transform on the new vertices, colours, the active step re-staged from its patched snapshot ──
  try { applyNodeSourceTransformToObject3D(model, outer, steps.object3dById); } catch (err) { console.warn('[poly asset] source transform', err); }
  materials.applyAll();
  const active = (state.get('steps') || []).find(s => s.id === state.get('activeStepId'));
  if (active?.snapshot) steps.applySnapshotInstant(active.snapshot, { suppressCamera: true });
  state.emit('change:treeData', state.get('treeData'));
  undoManager.clear();                                       // the file is overwritten: nothing before this can be undone
  state.markDirty();
  return { ok: true, added: diff.added.length, gone: diff.gone.length, moved: diff.moved.length, reshaped: reshaped.size, stepsChanged: r.changed, backup, file: newFile, swapped: swap };
}

/**
 * A project is opening; this Poly Editor asset was just loaded from its file. Called BEFORE the saved
 * tree is used to restore what hangs on the model (shapes, notes, primitives): the parts the file no
 * longer has are taken out of the SAVED tree first (their children move up), so those things are
 * restored under the parent instead of being dropped with their part.
 * → the item for reconcilePolyAssetsOnLoad(), or null when the file is what the project last saw.
 */
export function preparePolyAssetOnLoad({ modelNode, assetId, name, specNode, savedRoot, allSavedMeshSpecs }) {
  const newM = modelNode?.polyManifest;                      // the importer just read it off the file
  if (!newM || !manifestHasUids(newM)) return null;
  const known = !!specNode?.polyManifest?.nodes;
  const oldM = known ? specNode.polyManifest : manifestFromSpec(specNode, assetId, allSavedMeshSpecs, new Set(Object.keys(newM.nodes)));
  const diff = diffManifests(oldM, newM);
  // A project saved before manifests were stored: where a part sat and what it was called are the USER's
  // arrangement in that save, not the file's — only what was added and what is gone can be trusted.
  if (!known) {
    diff.moved = []; diff.renamed = [];
    const saved = new Set();                               // … and a node the save already has, wherever it sits, is not "new"
    (function walk(n) { if (!n) return; saved.add(n.id); (n.children || []).forEach(walk); })(savedRoot);
    diff.added = diff.added.filter(id => !saved.has(id));
  }
  const isNative = (id) => !!(oldM.nodes[id] || newM.nodes[id]) || id === oldM.root || id === newM.root;
  let lost = [];
  if (diff.gone.length && savedRoot) lost = spliceGoneFromTree(savedRoot, diff.gone, isNative);
  const savedFp = new Map();
  for (const s of allSavedMeshSpecs || []) if (s?.id && oldM.nodes[s.id] && s.fingerprint) savedFp.set(s.id, s.fingerprint);
  return { modelId: modelNode.id, assetId, name: name || 'asset', oldM, newM, diff, savedFp, lost };
}

/**
 * … and, once the saved colours are back and before the first step is staged, every step learns the
 * difference. → notes for the user (shown after "Opened: …").
 */
export function reconcilePolyAssetsOnLoad(items) {
  const notes = [];
  for (const it of items || []) {
    try {
      const nb = _nodeById(), model = nb?.get(it.modelId);
      if (!model) continue;
      const { oldM, newM, diff } = it;
      model.polyManifest = newM;
      const reshaped = new Set();
      for (const id of diff.kept) {
        if (newM.nodes[id].k !== 'm') continue;
        const ho = oldM.nodes[id]?.h, hn = newM.nodes[id].h, node = nb.get(id), fp = it.savedFp?.get(id);
        if (ho && hn ? ho !== hn : !!(node && fp && node.fingerprint && fp !== node.fingerprint)) reshaped.add(id);
      }
      if (isEmptyDiff(diff) && !reshaped.size) continue;     // the file is what the project last saw: nothing is touched
      const root = state.get('treeData');
      for (const id of diff.gone) {                          // a saved-tree pass may have left a row for a part the file no longer has
        if (!nb.has(id)) continue;
        const obj = steps.object3dById.get(id);
        if (obj?.userData?.isPlaceholder) { obj.parent?.remove(obj); steps.object3dById.delete(id); }
        delete materials.meshDefaultColors[id]; delete materials.meshColorAssignments[id];
        _spliceLive(root, id); nb.delete(id);
      }
      for (const { id, name } of diff.renamed) { const node = nb.get(id); if (node) node.name = name; }
      const addedMeshIds = diff.added.filter(id => newM.nodes[id].k === 'm' && nb.has(id));
      _colourNewMeshes(it.assetId, addedMeshIds);
      const r = patchSteps(state.get('steps') || [], _reconcileCtx(it.modelId, oldM, newM, diff, reshaped));
      state.setState({ steps: r.steps, nodeById: buildNodeMap(root) });
      materials.applyAll();
      state.markDirty();
      const lostNotes = (it.lost || []).filter(x => x.type === 'note').length, lostOther = (it.lost || []).length - lostNotes;
      const bits = [diff.added.length ? `+${diff.added.length} new` : '', diff.gone.length ? `−${diff.gone.length} removed` : '', diff.moved.length ? `${diff.moved.length} moved` : '', reshaped.size ? `${reshaped.size} reshaped` : '', diff.renamed.length ? `${diff.renamed.length} renamed` : '',
        lostOther ? `${lostOther} attached object(s) moved up to the parent` : '', lostNotes ? `${lostNotes} note(s) on removed parts were dropped` : ''].filter(Boolean);
      notes.push(`${it.name}: ${bits.join(', ') || 'updated'}`);
      if ((it.lost || []).length) console.info(`[poly asset] "${it.name}": attached to removed parts →`, it.lost);
    } catch (err) { console.warn('[poly asset] reconcile on load failed for', it?.name, err); }
  }
  return notes;
}
