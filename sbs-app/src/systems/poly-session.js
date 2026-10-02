/**
 * ⬚ POLY EDITOR SESSION (V0.3.5.14) — a bunch of objects go in, one .glb asset comes out.
 *
 * The user's design: select anything in the scene (primitives, parts of a STEP
 * / FBX / GLB model, folders, editable polys) ▸ right-click ▸ "Edit in Poly
 * Editor". Every object becomes an editable poly — each stays its OWN object —
 * and the editor opens as its own environment over the same viewport:
 *
 *   · the project is hidden (an isolate mask; nothing in the project is touched),
 *   · the left side shows the editor's OWN TREE (folders + parts). The tree is
 *     the asset's structure: how it is arranged here is how the objects are
 *     separated in the saved file, and it is the same in every view,
 *   · instead of steps there are VIEWS (perspective + the six axis views),
 *   · object level: click selects a part, the gizmo moves / rotates it;
 *     1 / 4 (or a double-click) go into the part's vertices / faces — the same
 *     sub-object editor as a Poly box (poly-edit.js on a host), Booleans included,
 *   · the only way out with a result is APPLY: the tree is written as ONE .glb
 *     into <project>/models/ (folders = glTF nodes, parts = meshes, the poly
 *     topology on each mesh for a lossless re-open) and loaded straight back
 *     as a model whose tree is the one designed here; then the app asks what
 *     to do with the originals (keep / archive / delete what can be deleted)
 *     and puts them in a selection group. DISCARD leaves everything as it was.
 *
 * Session parts are NOT project nodes: nothing reaches the project, its steps
 * or its save file until Apply. Undo entries carry the scope 'polySession' and
 * turn into no-ops once the session is over.
 */
import { state } from '../core/state.js';
import { sceneCore } from '../core/scene.js';
import * as actions from './actions.js';
import { undoManager } from './undo.js';
import { gizmo } from '../ui/gizmo.js';
import { setStatus, setStickyStatus, clearStickyStatus } from '../ui/status.js';
import { showContextMenu, hideContextMenu } from '../ui/context-menu.js';   // ⬚ V0.3.5.19 — right-click a part
import { matches as keyMatches, keyLabel } from '../core/keymap.js';
import { setIsolateKeepSet, clearIsolate, getIsolateKeepSet } from '../core/isolate-state.js';
import { subDir, joinPath } from '../core/project-paths.js';
import { isPoly, clonePoly, polyToArrays, makeBoxPoly } from './poly-core.js';
import { PRIMITIVE_DEFS, defaultPrimitiveParams, buildPrimitiveGeometry } from './primitives.js';   // ⬚ V0.3.5.18 — primitives added inside the editor
import { geometryToPoly, geometryTriangles } from './poly-convert.js';
import { enterPolyEditHost, exitPolyEdit, isPolyEditing, polyEditHostKey, polyEditMode, cleanPolyEdgesHost } from './poly-edit.js';
import { sceneGlb } from '../io/glb-write.js';
import { isEditing as overlayIsEditing, setEditingMode as overlaySetEditing } from './overlay.js';
import { sourceMatrixOfModel } from '../core/transforms.js';
import { polyAssetOfModel, planPolyAssetUpdate, updatePolyAssetInPlace, applyPolyPartColours } from './poly-asset-update.js';   // ⬚ V0.3.5.16 — save over the asset
import { polyPartNodeId } from '../io/importers.js';
import { materials } from './materials.js';   // ⬚ V0.3.5.22 — the scene's colours, used (and added to) from the editor
import { initPolyRefs, disposePolyRefs, syncPolyRefs, polyRefsInfo, polyRefsForSave, polyRefsPointerDown, polyRefsEditing, setPolyRefsEdit, removePolyRef } from './poly-refs.js';   // ⬚ V0.3.5.25 — reference pictures per view

const T = () => window.THREE;
const SCOPE = 'polySession';
const TRI_WARN = 80000;
const HIDE_DOM = ['sidebar-right', 'step-nav-bar', 'overlay-stage', 'notes-overlay', 'screen-overlay', 'export-safe-frame', 'overlay-toolbar', 'overlay-helpers-bar', 'overlay-float-toolbar'];

let _s = null;
let _sidSeq = 0;
let _starting = false;
let _uidSeq = 0;
/**
 * ⬚ V0.3.5.15 — every part and folder has a permanent id that travels in the .glb
 * (node extras.sbsId). The importer derives the project's node ids from it, so a
 * part keeps its identity in the project however its shape or its place in the
 * tree changes — the ground an "update this asset in place" stands on.
 */
const _newUid = () => `${Date.now().toString(36)}${(++_uidSeq).toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const _uidOf = (obj) => { const u = obj?.userData?.sbsId; return typeof u === 'string' && u ? u : null; };
const _subs = new Set();

export const isPolySession = () => !!_s;
export const polySessionUndoScope = SCOPE;
/** Subscribe to session changes ('open' | 'tree' | 'select' | 'mode' | 'view' | 'undo' | 'close'). */
export function onPolySession(fn) { _subs.add(fn); return () => _subs.delete(fn); }
const _emit = (what) => { for (const fn of [..._subs]) { try { fn(what); } catch (err) { console.warn('[poly session] listener', err); } } };

// ── what the panel reads ─────────────────────────────────────────────────────
export function polySessionInfo() {
  if (!_s) return null;
  const alive = _aliveIds();
  const row = (id, depth) => {
    const it = _s.items.get(id);
    return { id, kind: it.kind, name: it.name, parent: it.parent || null, depth, faces: it.kind === 'part' ? it.poly.f.length : 0, selected: _s.sel.has(id), primary: _s.primary === id, color: it.kind === 'part' ? _hexOf(it.color) : null, children: it.kind === 'folder' ? it.children.map(c => row(c, depth + 1)) : [] };
  };
  const selParts = _selectedPartIds(), prim = _s.items.get(selParts.includes(_s.primary) ? _s.primary : selParts[0]);
  return {
    name: _assetName(), view: _s.view, level: isPolyEditing() ? (polyEditMode() || 'face') : 'object',
    parts: [...alive].filter(id => _s.items.get(id).kind === 'part').length,
    selected: [..._s.sel], primary: _s.primary,
    tree: _s.rootIds.map(id => row(id, 0)),
    canUndo: undoManager.undoScope?.() === SCOPE,
    reedit: _s.reedit ? { file: _s.reedit.file } : null,   // this session edits an asset that is already in the project
    // ⬚ V0.3.5.22 — the panel's tabs: the scene's colours, the editor's own background
    tab: _s.tab || 'model', bg: _s.bg || null,
    colors: (state.get('colorPresets') || []).filter(p => p && p.id && typeof p.color === 'string').map(p => ({ id: p.id, name: p.name || p.color, color: p.color })),
    selParts: selParts.length, selPreset: prim?.presetId || null,
    refs: polyRefsInfo(),                                    // ⬚ V0.3.5.25 — the reference pictures
    scale: _s.scale?.mode || null,                           // ⬚ V0.3.5.26 — the scale box: '2d' | '3d' | off
  };
}
/** The ONE folder everything of a new object sits in (null when the tree's top level is anything else). */
function _rootFolder() {
  if (!_s) return null;
  if (_s.rootFolderId) {                                   // a new object: the folder made (and named) at the door
    const it = _s.items.get(_s.rootFolderId);
    return it && it.kind === 'folder' && _s.rootIds.includes(it.id) ? it : null;
  }
  if (_s.rootIds.length !== 1) return null;                // an asset being re-edited: its single top folder, if that is how it was saved
  const it = _s.items.get(_s.rootIds[0]);
  return it && it.kind === 'folder' ? it : null;
}
/**
 * The name the asset is saved under = the name of the object's folder. It is ONE name with three doors
 * (the panel's field, renaming the folder's row, the Apply dialog), always the last one typed — and it is
 * not part of undo (an undo of something else must not bring an old name back).
 */
const _assetName = () => (!_s ? '' : (!_s.reedit && _rootFolder()?.name) || _s.name);
export function setPolySessionName(name) {
  if (!_s) return;
  _s.name = String(name || '').trim() || 'poly-asset';
  const f = !_s.reedit ? _rootFolder() : null;
  if (f && f.name !== _s.name) { f.name = _s.name; _emit('tree'); }
}

// ── start ────────────────────────────────────────────────────────────────────
function _collectSources(nodeIds, opts = {}) {
  const nodeById = state.get('nodeById');
  const picked = new Set(nodeIds || []);
  const tops = [];                                         // top-most selected only
  const hasPickedAncestor = (id) => {
    const root = state.get('treeData'); if (!root) return false;
    let found = false;
    (function walk(n, under) { if (found) return; if (n.id === id) { found = under; return; } const u = under || picked.has(n.id); for (const c of (n.children || [])) walk(c, u); })(root, false);
    return found;
  };
  for (const id of picked) { const n = nodeById?.get(id); if (n && n.type !== 'scene' && !hasPickedAncestor(id)) tops.push(n); }
  let tris = 0, parts = 0, skipped = 0;
  const meshOf = (n) => (n.object3d?.isMesh && n.object3d.geometry?.attributes?.position ? n.object3d : null);
  let skipNative = null;                                   // ids of the asset being re-edited: they come in from its manifest, once
  const build = (n) => {
    if (!n || n.archived === true) return null;
    if (n.type === 'mesh') { if (skipNative?.has(n.id)) return null; const m = meshOf(n); if (!m) { skipped++; return null; } tris += geometryTriangles(m.geometry); parts++; return { kind: 'part', name: n.name || 'Part', mesh: m, node: n, uid: _uidOf(m), assetId: n.sourceAssetId || null }; }
    if (n.type === 'primitive') {
      const m = meshOf(n);
      const kids = (n.children || []).map(build).filter(Boolean);
      const self = m ? { kind: 'part', name: n.name || 'Primitive', mesh: m, node: n } : null;
      if (self) { tris += geometryTriangles(m.geometry); parts++; } else skipped++;
      if (!kids.length) return self;
      return { kind: 'folder', name: n.name || 'Group', children: [self, ...kids].filter(Boolean), uid: null };
    }
    if (n.type === 'folder' || n.type === 'model' || n.type === 'replaceModel') {
      const kids = (n.children || []).map(build).filter(Boolean);
      // an imported model wraps its content in one inner folder of the same name: do not nest it twice
      if (n.type === 'model' && kids.length === 1 && kids[0].kind === 'folder') return { kind: 'folder', name: n.name || kids[0].name, children: kids[0].children, uid: null };
      return kids.length ? { kind: 'folder', name: n.name || 'Folder', children: kids, uid: n.type === 'folder' ? _uidOf(n.object3d) : null } : null;
    }
    skipped++;                                            // shapes, hardware, hands, notes: not meshes the editor can take (yet)
    return null;
  };
  // ⬚ V0.3.5.16 — picking the single inner folder of a model is picking the model
  for (let i = 0; i < tops.length; i++) {
    const n = tops[i]; if (n.type !== 'folder') continue;
    const root = state.get('treeData'); let parent = null;
    (function walk(x) { if (parent || !x?.children) return; if (x.children.includes(n)) { parent = x; return; } x.children.forEach(walk); })(root);
    if (parent?.type === 'model' && parent.children.length === 1 && !tops.includes(parent)) tops[i] = parent;
  }
  // ⬚ V0.3.5.17 — anything picked INSIDE an asset the Poly Editor wrote (a part, a folder) opens the WHOLE
  // asset: that is the unit being edited — it is one file. (Parts of two different assets stay just parts.)
  {
    const ownerOf = new Map();
    for (const n of nodeById?.values() || []) {
      if (n.type !== 'model' || !polyAssetOfModel(n)) continue;
      ownerOf.set(n.id, n); ownerOf.set(n.polyManifest.root, n);
      for (const id of Object.keys(n.polyManifest.nodes)) ownerOf.set(id, n);
    }
    // A click in the viewport selects the CONTAINER of what was clicked (a locked wrapper made by "Make
    // transformable" or by Follow Object) — a folder that is not the asset's own. So a picked folder is
    // also resolved downwards (it holds parts of one asset and no other model's parts), and the mesh that
    // was actually right-clicked (opts.hitId) decides for a folder that holds the asset AND something else.
    const hitOwner = opts.hitId ? ownerOf.get(opts.hitId) : null;
    const holds = (n, id) => { let f = false; (function w(x) { if (f || !x) return; if (x.id === id) { f = true; return; } (x.children || []).forEach(w); })(n); return f; };
    const ownerOfTop = (n) => {
      const own = ownerOf.get(n.id); if (own) return own;
      if (hitOwner && holds(n, opts.hitId)) return hitOwner;
      if (n.type !== 'folder') return null;
      let o = null, mixed = false;
      (function walk(x) {
        for (const c of x.children || []) {
          const m = ownerOf.get(c.id);
          if (m) { if (o && o !== m) mixed = true; o = m; if (c === m) continue; }                       // the model itself: its subtree is its own
          else if (c.type === 'mesh' || c.type === 'model' || c.type === 'replaceModel') mixed = true;   // a part of something else: this folder is not "the asset"
          walk(c);
        }
      })(n);
      return mixed ? null : o;
    };
    const topOwner = new Map(tops.map(n => [n, ownerOfTop(n)]));
    const owners = new Set([...topOwner.values()].filter(Boolean));
    if (owners.size === 1) {
      const m = [...owners][0], rest = tops.filter(n => topOwner.get(n) !== m);
      tops.length = 0; tops.push(m, ...rest);
    }
  }
  // Exactly ONE asset of the Poly Editor in the selection = that asset is being re-edited (Apply can save over it).
  const polyModels = tops.filter(n => polyAssetOfModel(n));
  let reedit = polyModels.length === 1 ? polyAssetOfModel(polyModels[0]) : null;
  // The asset being re-edited comes in as the FILE has it: every part and folder of its manifest,
  // wherever this step has put a part (another folder, archived, hidden). Seeding it from the live
  // tree would read a part the user dragged out of the model in this step as "removed from the asset".
  let reeditKids = null, reeditBroken = null, native = null;
  if (reedit) {
    const model = polyModels[0], M = model.polyManifest, kidsOf = new Map();
    for (const [id, e] of Object.entries(M.nodes)) { if (!kidsOf.has(e.p)) kidsOf.set(e.p, []); kidsOf.get(e.p).push(id); }
    const arch = new Set();                                // archived in the project (itself or through a folder above it)
    (function walk(n, a) { if (!n) return; const x = a || n.archived === true; if (x) arch.add(n.id); (n.children || []).forEach(c => walk(c, x)); })(state.get('treeData'), false);
    let ok = true, t2 = 0, p2 = 0;
    const mk = (id) => {
      const e = M.nodes[id], n = nodeById?.get(id);
      if (e.k === 'f') { const kids = (kidsOf.get(id) || []).map(mk).filter(Boolean); return kids.length ? { kind: 'folder', name: n?.name || e.n || 'Folder', children: kids, uid: e.u, frame: e.fr || null } : null; }
      const m = n ? meshOf(n) : null;
      if (!m || m.userData?.isPlaceholder) { ok = false; return null; }
      t2 += geometryTriangles(m.geometry); p2++;
      return { kind: 'part', name: n.name || e.n || 'Part', mesh: m, node: n, uid: e.u, assetId: reedit.assetId, native: true, archived: arch.has(id), frame: e.fr || null };
    };
    const kids = (kidsOf.get(M.root) || []).map(mk).filter(Boolean);
    if (ok && kids.length) {
      reeditKids = kids; tris += t2; parts += p2; skipNative = new Set(Object.keys(M.nodes));
      native = { modelId: model.id, meshIds: Object.keys(M.nodes).filter(id => M.nodes[id].k === 'm') };
      // Picked together with the asset and sitting inside its tree, but not a part of it (a primitive, a part
      // of another model, a folder of the user's): it comes in as its own object, like anything picked outside.
      const isNative = (id) => id === M.root || !!M.nodes[id];
      (function walk(n) { for (const c of n.children || []) { if (!isNative(c.id) && picked.has(c.id)) { if (!tops.includes(c)) tops.push(c); } else walk(c); } })(model);
    }
    else { reeditBroken = reedit.file; reedit = null; }    // a part of the asset is not in the project any more: this can only become a new asset
  }
  const built = tops.map(n => (reedit && n.id === reedit.modelId ? { n, kids: reeditKids } : { n, r: build(n) })).filter(x => x.r || x.kids);
  built.sort((a, b) => (b.kids ? 1 : 0) - (a.kids ? 1 : 0));   // the asset's own parts first: they own their permanent ids (a picked copy of one gets a new id)
  // A model on its own brings its CONTENT, not one more folder around it.
  const roots = [], rootSource = [];
  for (const b of built) {
    const list = b.kids || (b.n.type === 'model' && b.r.kind === 'folder' && built.length === 1 ? b.r.children : [b.r]);
    for (const r of list) { roots.push(r); rootSource.push(b.n.id); }
  }
  const name = reedit ? reedit.file : (tops.length === 1 ? (tops[0].name || 'poly-asset') : 'poly-asset');
  return { roots, rootSource, tris, parts, skipped, name, reedit, reeditBroken, native };
}

/**
 * A source object → its poly in SESSION space. cx = { toLocal (world → session), reedit, sourceInv }.
 * A part of the asset being re-edited comes exactly as the file holds it (its own space, wherever
 * the current step has put the model or its folders); everything else is baked from where it stands.
 */
function _bakedPoly(src, cx) {
  const Th = T(); const mesh = src.mesh, node = src.node;
  let poly = null;
  if (cx.reedit && src.assetId === cx.reedit.assetId) {
    if (isPoly(mesh.userData?.sbsPoly)) return clonePoly(mesh.userData.sbsPoly);
    poly = geometryToPoly(mesh.geometry, { heal: geometryTriangles(mesh.geometry) <= 20000 });   // no stored topology: the live vertices carry the model's source transform
    if (!poly) return null;
    const v0 = new Th.Vector3();
    for (let i = 0; i < poly.v.length; i += 3) { v0.set(poly.v[i], poly.v[i + 1], poly.v[i + 2]).applyMatrix4(cx.sourceInv); poly.v[i] = v0.x; poly.v[i + 1] = v0.y; poly.v[i + 2] = v0.z; }
    if (cx.sourceInv.determinant() < 0) poly.f = poly.f.map(f => f.slice().reverse());
    return poly;
  }
  if (node?.type === 'primitive' && node.primKind === 'poly' && isPoly(node.primParams)) poly = clonePoly(node.primParams);
  else if (isPoly(mesh.userData?.sbsPoly) && _sameExtent(mesh.userData.sbsPoly, mesh.geometry)) poly = clonePoly(mesh.userData.sbsPoly);   // a .glb this editor wrote: lossless
  else poly = geometryToPoly(mesh.geometry, { heal: geometryTriangles(mesh.geometry) <= 20000 });
  if (!poly) return null;
  mesh.updateWorldMatrix(true, false);
  const M = new Th.Matrix4().multiplyMatrices(cx.toLocal, mesh.matrixWorld);
  const v = new Th.Vector3();
  for (let i = 0; i < poly.v.length; i += 3) { v.set(poly.v[i], poly.v[i + 1], poly.v[i + 2]).applyMatrix4(M); poly.v[i] = v.x; poly.v[i + 1] = v.y; poly.v[i + 2] = v.z; }
  if (M.determinant() < 0) poly.f = poly.f.map(f => f.slice().reverse());   // a mirrored source: keep the faces outward
  return poly;
}

/** The stored topology still describes THIS geometry (same box, not just the same size — the vertices may have been re-baked since). */
function _sameExtent(poly, geometry) {
  try {
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox; const size = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z, 1e-6);
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < poly.v.length; i += 3) for (let c = 0; c < 3; c++) { const x = poly.v[i + c]; if (x < mn[c]) mn[c] = x; if (x > mx[c]) mx[c] = x; }
    const tol = size * 1e-3 + 1e-4;
    return Math.abs(mn[0] - bb.min.x) <= tol && Math.abs(mn[1] - bb.min.y) <= tol && Math.abs(mn[2] - bb.min.z) <= tol
        && Math.abs(mx[0] - bb.max.x) <= tol && Math.abs(mx[1] - bb.max.y) <= tol && Math.abs(mx[2] - bb.max.z) <= tol;
  } catch { return false; }
}

/** opts.hitId = the mesh that was right-clicked in the viewport (the selection there is its container). */
export async function startPolySession(nodeIds, opts = {}) {
  if (_s || _starting) { setStatus('The Poly Editor is already open — Apply or Discard first.', 'warn', 4000); return false; }
  if (state.get('_exporting')) { setStatus('Not while an export is running.', 'warn', 4000); return false; }
  _starting = true;                                        // the conversion below yields: a second start must not slip in
  try { return await _start(nodeIds, opts); } finally { _starting = false; }
}

async function _start(nodeIds, opts = {}) {
  if (isPolyEditing()) exitPolyEdit();
  const plan = _collectSources(nodeIds, opts);
  const empty = !!opts.empty && !plan.parts;               // ⬚ V0.3.5.18 — a new asset from scratch: nothing comes in, primitives are added inside
  if (!plan.parts && !empty) { setStatus('Nothing in the selection has a mesh the Poly Editor can take.', 'warn', 5000); return false; }
  if (plan.tris > TRI_WARN && !confirm(`These ${plan.parts} objects have ${plan.tris.toLocaleString()} triangles. Converting and editing that much is slow.\n\nGo on?`)) return false;
  // ⬚ V0.3.5.24 (his rule) — a NEW object is ONE named folder, even when it is a single part: the name is
  // asked at the door (Enter takes the default) and is the name the .glb is saved under; the folder's pivot
  // is the middle of what it holds, so the object has a PARENT to be measured from — the folder sits in the
  // world, everything in it sits relative to the folder. (An asset that is re-edited opens as it is.)
  plan.roots.forEach((r, i) => { r.srcId = plan.rootSource[i]; });
  if (!plan.reedit) {
    const panel = await import('../ui/poly-editor-panel.js');
    const asked = await panel.askPolyStartName({ name: _safeName(String(plan.name || '').replace(/\.(glb|gltf|step|stp|fbx|obj|stl|sbsobj)$/i, '')), count: plan.parts });
    if (!asked || _s) return false;
    const rootName = _safeName(asked);
    plan.name = rootName; plan.named = true;                 // the user's own words: kept exactly ("Bracket v1.2" is not a file name)
    plan.roots = plan.roots.length === 1 && plan.roots[0].kind === 'folder'
      ? [{ ...plan.roots[0], name: rootName }]                        // already one folder: it IS the object's folder
      : [{ kind: 'folder', name: rootName, children: plan.roots, uid: null, keepEmpty: true }];
  }
  const Th = T();
  setStickyStatus(`⬚ Poly Editor — converting ${plan.parts} object${plan.parts === 1 ? '' : 's'}…`, 'info', 'polySession');
  await new Promise(r => setTimeout(r, 30));
  sceneCore.rootGroup.updateWorldMatrix(true, true);
  const sess = {
    sid: ++_sidSeq, seq: 0, name: plan.named ? plan.name : plan.name.replace(/\.[a-z0-9]+$/i, ''), items: new Map(), rootIds: [], sel: new Set(), primary: null,
    view: 'persp', space: 'world', subMode: null, sourceIds: [], group: new Th.Group(), prev: null, listeners: null, xf: null, fovPersp: sceneCore.camera?.fov || 35, edits: 0,
    reedit: plan.reedit || null,
    native: plan.native || null,                           // the asset this session was seeded from (stays when Apply can only make a NEW asset)
  };
  sess.group.name = 'PolyEditorSession';
  // ⬚ V0.3.5.16 — the session's own space. A plain session works in the scene's space (identity).
  // Re-editing an asset works in the ASSET's space — what the file holds — and the session group
  // carries the model's pose so it is seen where the model stands; saving over the asset then writes
  // those coordinates as they are (baking the step's pose in would move the model twice).
  const frame = new Th.Matrix4();                            // session space → rootGroup space
  let sourceInv = new Th.Matrix4();
  if (sess.reedit) {
    const model = state.get('nodeById')?.get(sess.reedit.modelId), outer = model?.object3d;
    if (outer) {
      outer.updateWorldMatrix(true, false);
      const S = sourceMatrixOfModel(model);
      sourceInv = S.clone().invert();
      frame.copy(sceneCore.rootGroup.matrixWorld).invert().multiply(outer.matrixWorld).multiply(S);
    }
  }
  frame.decompose(sess.group.position, sess.group.quaternion, sess.group.scale);
  const cx = { toLocal: frame.clone().invert().multiply(sceneCore.rootGroup.matrixWorld.clone().invert()), reedit: sess.reedit, sourceInv };
  const newId = (p) => `${p}${(++sess.seq).toString(36)}`;
  const seenUid = new Set();
  const uidFor = (src) => { const u = src.uid && !seenUid.has(src.uid) ? src.uid : _newUid(); seenUid.add(u); return u; };   // a part that came from this editor keeps its id
  let done = 0, failed = 0, nativeFailed = 0;
  const add = async (src, parent) => {
    if (src.kind === 'folder') {
      const ff = _readFrame(src.frame);
      const it = { id: newId('f'), kind: 'folder', name: src.name, parent, children: [], uid: uidFor(src), frame: { q: ff ? ff.quat : new Th.Quaternion(), p: ff ? ff.pos : null } };
      sess.items.set(it.id, it);
      for (const c of src.children) { const cid = await add(c, it.id); if (cid) it.children.push(cid); }
      if (!it.children.length && !src.keepEmpty) { sess.items.delete(it.id); return null; }
      if (src.srcId) okSources.add(src.srcId);
      return it.id;
    }
    let poly = null;
    try { poly = _bakedPoly(src, cx); } catch (err) { console.warn('[poly session] conversion failed for', src.name, err); }
    done++;
    if (done % 5 === 0) { setStickyStatus(`⬚ Poly Editor — converting… ${done} / ${plan.parts}`, 'info', 'polySession'); await new Promise(r => setTimeout(r, 0)); }
    if (!poly) { failed++; if (src.native) nativeFailed++; return null; }
    // A preset-coloured mesh wears the app's falloff ShaderMaterial: its colour is the uColor uniform, not .color.
    const mat = Array.isArray(src.mesh.material) ? src.mesh.material[0] : src.mesh.material;
    const col = mat?.uniforms?.uColor?.value?.isColor ? mat.uniforms.uColor.value : (mat?.color?.isColor ? mat.color : null);
    const c = col ? [col.r, col.g, col.b] : [0.75, 0.79, 0.83];
    // The part's own frame: the pivot + axes saved with the asset, else the middle of its box, world-aligned.
    // The poly is kept IN that frame (the mesh carries the frame), so the gizmo sits on the object.
    const pf = _readFrame(src.frame);
    const frame0 = pf && pf.pos ? pf : { pos: _polyCentre(poly), quat: new Th.Quaternion() };
    _polyApply(poly, new Th.Matrix4().compose(frame0.pos, frame0.quat, new Th.Vector3(1, 1, 1)).invert());
    const it = { id: newId('p'), kind: 'part', name: src.name, parent, poly, color: c, mesh: null, uid: uidFor(src), archived: src.archived === true, frame0 };
    sess.items.set(it.id, it);
    if (src.srcId) okSources.add(src.srcId);
    return it.id;
  };
  const okSources = new Set();                             // only what really came in counts as an "original" at Apply
  for (const r of plan.roots) { const id = await add(r, null); if (id) sess.rootIds.push(id); }
  sess.sourceIds = [...okSources];
  if (empty && sess.rootIds.length === 1) { sess.sel = new Set(sess.rootIds); sess.primary = sess.rootIds[0]; }   // what is added lands in the object's folder
  clearStickyStatus('polySession');
  if (!empty && ![...sess.items.values()].some(it => it.kind === 'part')) { setStatus('None of those objects could be converted.', 'warn', 5000); return false; }
  // Saving over the asset needs ALL of it in the editor: a part that did not come in would be read as deleted.
  let noUpdate = plan.reeditBroken || null;
  if (sess.reedit && nativeFailed) { noUpdate = sess.reedit.file; sess.reedit = null; }
  _s = sess;
  if (!sess.reedit && plan.named && sess.rootIds.length === 1 && sess.items.get(sess.rootIds[0])?.kind === 'folder') sess.rootFolderId = sess.rootIds[0];   // the object's folder
  // the folder the reference pictures stand on, for the whole session (a second top-level item must not unseat them)
  sess.refAnchorId = sess.rootFolderId || (sess.rootIds.length === 1 && sess.items.get(sess.rootIds[0])?.kind === 'folder' ? sess.rootIds[0] : null);
  for (const it of sess.items.values()) if (it.kind === 'part') { _buildPartMesh(it); if (it.frame0) { it.mesh.position.copy(it.frame0.pos); it.mesh.quaternion.copy(it.frame0.quat); it.frame0 = null; } }
  sceneCore.rootGroup.add(sess.group);
  sess.group.updateMatrixWorld(true);                      // the first view frames the parts where the session group puts them
  for (const it of sess.items.values()) if (it.kind === 'folder' && !it.frame.p) it.frame.p = _pivotLocal(it);   // a folder's pivot is a fixed point: what sits in it is measured from there
  if (empty) {                                             // a new, empty object: its centre is where the user is looking (pictures and the first primitive land there, and it never moves again)
    const f = _rootFolder(), cs = sceneCore.getCameraState?.();
    if (f && !f.frame.p) f.frame.p = Array.isArray(cs?.pivot) ? sess.group.worldToLocal(new Th.Vector3().fromArray(cs.pivot)) : new Th.Vector3();
  }
  _hideProject();
  _attachInput();
  try { initPolyRefs(_refsHost, plan.reedit ? state.get('nodeById')?.get(plan.reedit.modelId)?.polyManifest?.refs : null); } catch (err) { console.warn('[poly session] reference pictures', err); }
  const { openPolyEditorPanel } = await import('../ui/poly-editor-panel.js');
  openPolyEditorPanel();
  _emit('open');
  setPolyView('persp');
  _hint();
  if (empty) { setStatus('Poly Editor: a new, empty asset — add a primitive from the panel on the left.', 'success', 7000); return true; }
  setStatus(`Poly Editor: ${sess.reedit ? `editing ${sess.reedit.file} (the whole asset) — ` : ''}${[...sess.items.values()].filter(i => i.kind === 'part').length} part(s)${failed ? `, ${failed} could not be converted` : ''}${plan.skipped ? `, ${plan.skipped} skipped (not meshes)` : ''}.${noUpdate ? ` Not every part of ${noUpdate} could come in — this edit can only be saved as a NEW asset.` : ''}`, failed || noUpdate ? 'warn' : 'success', noUpdate ? 11000 : 6000);
  return true;
}

// ── frames: every part and every folder has its own pivot + axes (V0.3.5.19) ─
// A part's frame IS its mesh transform (position = the pivot, quaternion = its axes); its poly is kept
// in that frame. A folder's frame is { q, p } in the session group's space (p null = the middle of what
// it holds). Frames belong to the editor: Apply still bakes every vertex into the asset's space, and
// writes the frames beside them (glTF node extras.sbsFrame → model.polyManifest) so the next edit finds them.
function _readFrame(fr) {
  const Th = T();
  if (!fr || !Array.isArray(fr.q) || fr.q.length !== 4 || !fr.q.every(Number.isFinite)) return null;
  const quat = new Th.Quaternion(fr.q[0], fr.q[1], fr.q[2], fr.q[3]);
  if (quat.lengthSq() < 1e-12) return null;
  quat.normalize();
  const pos = Array.isArray(fr.p) && fr.p.length === 3 && fr.p.every(Number.isFinite) ? new Th.Vector3(fr.p[0], fr.p[1], fr.p[2]) : null;
  return { pos, quat };
}
function _polyCentre(poly) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < poly.v.length; i += 3) for (let c = 0; c < 3; c++) { const x = poly.v[i + c]; if (x < mn[c]) mn[c] = x; if (x > mx[c]) mx[c] = x; }
  return new (T().Vector3)((mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2);
}
function _polyApply(poly, M) {
  const v = new (T().Vector3)();
  for (let i = 0; i < poly.v.length; i += 3) { v.set(poly.v[i], poly.v[i + 1], poly.v[i + 2]).applyMatrix4(M); poly.v[i] = v.x; poly.v[i + 1] = v.y; poly.v[i + 2] = v.z; }
  return poly;
}

// ── scene ────────────────────────────────────────────────────────────────────
function _buildPartMesh(part) {
  const Th = T();
  const mat = new Th.MeshStandardMaterial({ color: new Th.Color(part.color[0], part.color[1], part.color[2]), metalness: 0, roughness: 0.6, side: Th.DoubleSide });
  const mesh = new Th.Mesh(new Th.BufferGeometry(), mat);
  mesh.name = part.name; mesh.userData.polyPartId = part.id;
  part.mesh = mesh;
  _refreshPartMesh(part);
  _s.group.add(mesh);
}

function _refreshPartMesh(part) {
  const Th = T(); const { positions, normals, faceOfTri } = polyToArrays(part.poly);
  const g = new Th.BufferGeometry();
  g.setAttribute('position', new Th.BufferAttribute(positions, 3));
  g.setAttribute('normal', new Th.BufferAttribute(normals, 3));
  g.userData.faceOfTri = faceOfTri; g.userData.isPoly = true;
  g.computeBoundingBox(); g.computeBoundingSphere();
  part.mesh.geometry?.dispose?.();
  part.mesh.geometry = g;
  sceneCore.requestRender?.(120);
}

function _aliveIds() {
  const out = new Set();
  const walk = (id) => { const it = _s.items.get(id); if (!it) return; out.add(id); if (it.kind === 'folder') it.children.forEach(walk); };
  _s.rootIds.forEach(walk);
  return out;
}

/** The scene follows the tree: a part is drawn while it is reachable; selected parts glow. */
function _syncScene() {
  if (!_s) return;
  const alive = _aliveIds();
  if (isPolyEditing()) {
    const key = polyEditHostKey() || '', pre = `part:${_s.sid}:`;
    if (key.startsWith(pre) && !alive.has(key.slice(pre.length))) { exitPolyEdit(); if (!_s) return; }
  }
  const selParts = new Set(_selectedPartIds());
  for (const it of _s.items.values()) {
    if (it.kind !== 'part' || !it.mesh) continue;
    it.mesh.visible = alive.has(it.id);
    it.mesh.material.emissive?.setHex(selParts.has(it.id) ? 0x0b3a52 : 0x000000);
  }
  for (const id of [..._s.sel]) if (!alive.has(id)) _s.sel.delete(id);
  if (_s.primary && !alive.has(_s.primary)) _s.primary = [..._s.sel][0] || null;
  _syncGizmo();
  if (_s.pick) _pickPivotMarks();                          // the diamonds follow an undo / a delete made while a tool waits for a click
  syncPolyRefs();                                          // the reference pictures stand on the object's folder
  sceneCore.requestRender?.(120);
}

function _selectedPartIds() {
  if (!_s) return [];
  const out = new Set(), alive = _aliveIds();
  const walk = (id) => { const it = _s.items.get(id); if (!it || !alive.has(id)) return; if (it.kind === 'part') out.add(id); else it.children.forEach(walk); };
  _s.sel.forEach(walk);
  return [...out];
}

function _hideProject() {
  // a flat (axis) view goes back to its perspective lens first, or the restored camera would be stuck flat
  if (sceneCore.getStandardView?.()) { try { sceneCore._exitStandardView?.(); } catch { /* fine */ } }
  const prev = { keep: getIsolateKeepSet(), dom: [], cable: null, camera: sceneCore.getCameraState?.() || null, overlayEditing: false, bg: sceneCore.scene?.background ?? null };
  try { if (overlayIsEditing()) { overlaySetEditing(false); prev.overlayEditing = true; } } catch { /* overlay not up */ }
  // The mask keeps the ROOT (it is sceneCore.rootGroup — the session's parts live under it) and nothing else:
  // every project node is hidden on every visibility pass. Quiet = no step re-capture, no ★ on the active step.
  setIsolateKeepSet(new Set(['__poly_session__', state.get('treeData')?.id].filter(Boolean)));
  try { actions.refreshIsolateView({ quiet: true }); } catch (err) { console.warn('[poly session] mask', err); }
  const cable = sceneCore.scene?.getObjectByName?.('CableRoot');
  if (cable) { prev.cable = { obj: cable, vis: cable.visible }; cable.visible = false; }
  for (const id of HIDE_DOM) { const el = document.getElementById(id); if (el) { prev.dom.push([el, el.style.display]); el.style.display = 'none'; } }
  state.setState({ polySession: true });
  state.clearSelection?.();
  gizmo.hide();
  _s.prev = prev;
  try { const hex = localStorage.getItem(BG_KEY); _s.bg = /^#[0-9a-f]{6}$/i.test(hex || '') ? hex : null; } catch { _s.bg = null; }
  _applyBg();
}

/**
 * how = 'discard' (everything as it was, an earlier isolate included) · 'applied' (no mask: the
 * new model must show) · 'project' (another project is already on screen: only our own DOM comes back).
 */
function _showProject(how = 'discard') {
  const prev = _s?.prev; if (!prev) return;
  // the editor's background goes with it — unless something else (a project that was just opened) has already replaced it
  try { if (_s.bgObj && sceneCore.scene && sceneCore.scene.background === _s.bgObj) sceneCore.scene.background = prev.bg; } catch { /* the scene is gone */ }
  _s.bgObj = null;
  for (const [el, d] of prev.dom) el.style.display = d;
  if (prev.cable) prev.cable.obj.visible = prev.cable.vis;   // the cables root outlives projects
  if (how === 'project') { clearIsolate(); return; }
  if (how === 'discard' && prev.keep) setIsolateKeepSet(prev.keep); else clearIsolate();
  try { actions.refreshIsolateView({ quiet: true }); } catch (err) { console.warn('[poly session] unmask', err); }
  if (prev.camera) { try { sceneCore.applyCameraState(prev.camera); } catch { /* keep the current view */ } }
  if (prev.overlayEditing) { try { overlaySetEditing(true); } catch { /* fine */ } }
}

// ── the panel's tabs · the editor's own background · the scene's colours (V0.3.5.22) ──
export function setPolyTab(tab) {
  if (!_s) return;
  _s.tab = tab === 'colors' || tab === 'env' || tab === 'refs' ? tab : 'model';
  if (_s.tab !== 'model' && _s.scale) { _scaleEnd(); _hint(); _syncScene(); }   // the scale box belongs to the Model tab
  if (_s.tab !== 'refs' && polyRefsEditing()) setPolyRefsEdit(false);   // "move / scale pictures" belongs to the Refs tab: elsewhere a click must reach the parts
  _emit('view');
}

// ⬚ V0.3.5.25 — what the reference pictures need from the session (poly-refs.js). They stand on the OBJECT's
// centre: the pivot of the object's folder (his rule), else the editor's origin.
const _refsHost = {
  get group() { return _s?.group || null; },
  _folder() { if (!_s) return null; const it = _s.refAnchorId ? _s.items.get(_s.refAnchorId) : null; return it && it.kind === 'folder' && _aliveIds().has(it.id) ? it : _rootFolder(); },
  anchor() { const f = this._folder(), p = f ? _pivotLocal(f) : null; return p || new (T().Vector3)(); },
  pin() { const f = this._folder(); if (f && !f.frame.p) f.frame.p = this.anchor(); },   // an anchor that pictures hang on is a fixed point
  view() { return _s?.view || 'persp'; },
  goView(v) { setPolyView(v, { fit: false }); },
  push(label, undo, redo) { if (_s) _push(label, undo, redo); },
  changed() { _emit('view'); },
  contentSize() {
    if (!_s) return 0;
    const b = _sessionBox(false); if (!b) return 0;
    const s = b.getSize(new (T().Vector3)());
    return Math.max(s.x, s.y, s.z) / (_sessionFrame().scale || 1);
  },
};

// The background is the EDITOR's: it is only for seeing things here. The project's own background (state,
// steps, exports) is never written; what the scene showed before comes back when the editor closes. The
// choice is remembered on this computer for the next time the editor opens.
const BG_KEY = 'sbs.polyEditor.background';
function _applyBg() {
  if (!_s) return;
  const scene = sceneCore.scene; if (!scene) return;
  if (_s.bg) { _s.bgObj = new (T().Color)(_s.bg); scene.background = _s.bgObj; }
  else { if (_s.bgObj && scene.background === _s.bgObj) scene.background = _s.prev?.bg ?? null; _s.bgObj = null; }
  sceneCore.requestRender?.(200);
}
/** hex = the editor's background; null = show the project's. quiet = no panel refresh (a colour being dragged). */
export function setPolyBackground(hex, { quiet = false } = {}) {
  if (!_s) return;
  _s.bg = /^#[0-9a-f]{6}$/i.test(hex || '') ? hex.toLowerCase() : null;
  try { if (_s.bg) localStorage.setItem(BG_KEY, _s.bg); else localStorage.removeItem(BG_KEY); } catch { /* private mode */ }
  _applyBg();
  if (!quiet) _emit('view');
}

// Colours come FROM the scene: the project's colour presets. A part coloured here wears that same preset in
// the scene after Apply (no look-alike copy is made), and a colour made here is added to the project's too.
const _hexOf = (c) => '#' + new (T().Color)(c[0], c[1], c[2]).getHexString();
export function polyApplyPreset(presetId) {
  if (!_s) return false;
  const p = (state.get('colorPresets') || []).find(x => x.id === presetId);
  if (!p || typeof p.color !== 'string') return false;
  const ids = _selectedPartIds();
  if (!ids.length) { setStatus('Select the part(s) to colour first.', 'warn', 3500); return false; }
  const c = new (T().Color)(p.color), rgb = [c.r, c.g, c.b];
  const rows = ids.map(id => { const it = _s.items.get(id); return { it, color: it.color.slice(), presetId: it.presetId || null, edited: !!it.colorEdited }; });
  const paint = (it) => { if (it.mesh?.material?.color) it.mesh.material.color.setRGB(it.color[0], it.color[1], it.color[2]); };
  const to = () => { for (const r of rows) { r.it.color = rgb.slice(); r.it.presetId = presetId; r.it.colorEdited = true; paint(r.it); } };
  const back = () => { for (const r of rows) { r.it.color = r.color.slice(); r.it.presetId = r.presetId; r.it.colorEdited = r.edited; paint(r.it); } };
  to();
  _push(ids.length > 1 ? 'Colour parts' : 'Colour part', back, to);
  _syncScene(); _emit('tree');
  setStatus(`${ids.length} part${ids.length === 1 ? '' : 's'}: ${p.name || p.color}.`, 'success', 2500);
  return true;
}
/** A new colour: it is added to the PROJECT's colours (unless that exact colour is already there) and put on the selection. */
export function polyNewColor(hex, name = '') {
  if (!_s || !/^#[0-9a-f]{6}$/i.test(hex || '')) return null;
  const h = hex.toLowerCase(), nm = String(name || '').trim();
  let p = (state.get('colorPresets') || []).find(x => typeof x.color === 'string' && x.color.toLowerCase() === h && (!nm || x.name === nm));
  let made = false;
  if (!p) { try { p = materials.createPreset({ color: h, name: nm || h }); made = true; } catch (err) { console.warn('[poly session] new colour', err); return null; } }
  if (_selectedPartIds().length) polyApplyPreset(p.id);
  else { _emit('tree'); setStatus(made ? `“${p.name || h}” was added to the scene's colours. Select a part and click it to use it.` : 'The scene already has that colour.', made ? 'success' : 'info', 5000); }
  return p.id;
}

// ── undo (scope: polySession; a no-op once the session is over) ──────────────
function _noteEdit() { if (!_s) return; _s.edits++; if (!state.get('polySessionDirty')) state.setState({ polySessionDirty: true }); }

function _push(label, undo, redo) {
  const sid = _s.sid;
  _noteEdit();
  undoManager.push(label,
    () => { if (!_s || _s.sid !== sid) return false; undo(); _syncScene(); _emit('undo'); },
    () => { if (!_s || _s.sid !== sid) return false; redo(); _syncScene(); _emit('undo'); },
    { scope: SCOPE });
}
const _structSnap = () => ({ rootIds: _s.rootIds.slice(), items: [..._s.items.values()].map(it => ({ id: it.id, name: it.name, parent: it.parent, children: it.kind === 'folder' ? it.children.slice() : null })) });
function _structRestore(snap) {
  _s.rootIds = snap.rootIds.slice();
  const keepName = !_s.reedit ? _s.rootFolderId : null;      // the object's own name is not undone (see _assetName)
  for (const r of snap.items) { const it = _s.items.get(r.id); if (!it) continue; if (r.id !== keepName) it.name = r.name; it.parent = r.parent; if (it.kind === 'folder') it.children = r.children.slice(); else if (it.mesh) it.mesh.name = r.name; }
}
/** Run a tree change with one undo entry (before / after structure snapshots). */
function _treeOp(label, fn) {
  const before = _structSnap();
  const ok = fn();
  if (ok === false) return false;
  const after = _structSnap();
  _push(label, () => _structRestore(before), () => _structRestore(after));
  _syncScene(); _emit('tree');
  return true;
}

// ── tree operations (the panel calls these) ──────────────────────────────────
export function polySelect(ids, { add = false, toggle = false } = {}) {
  if (!_s) return;
  if (isPolyEditing()) exitPolyEdit();
  const alive = _aliveIds();
  const list = (ids || []).filter(id => alive.has(id));
  if (toggle) { for (const id of list) { if (_s.sel.has(id)) _s.sel.delete(id); else _s.sel.add(id); } }
  else if (add) list.forEach(id => _s.sel.add(id));
  else _s.sel = new Set(list);
  _s.primary = list.length && _s.sel.has(list[list.length - 1]) ? list[list.length - 1] : ([..._s.sel][0] || null);
  _syncScene(); _emit('select');
}

export function polyRename(id, name) {
  const it = _s?.items.get(id); const n = String(name || '').trim();
  if (!it || !n || n === it.name) return false;
  if (!_s.reedit && it.id === _s.rootFolderId) { setPolySessionName(n); return true; }   // the object's folder: its name IS the asset's name
  return _treeOp('Rename', () => { it.name = n; if (it.mesh) it.mesh.name = n; });
}

export function polyNewFolder() {
  if (!_s) return null;
  let id = null;
  _treeOp('New folder', () => {
    const alive = _aliveIds(), sel = new Set([..._s.sel].filter(x => alive.has(x)));
    const order = [];                                      // the tree, top to bottom
    const walk = (x) => { order.push(x); const n = _s.items.get(x); if (n.kind === 'folder') n.children.forEach(walk); };
    _s.rootIds.forEach(walk);
    let tops = order.filter(x => sel.has(x) && !_hasSelectedAncestor(x, sel));   // what gets wrapped: top-most only, in tree order
    const root = !_s.reedit ? _rootFolder() : null;
    if (root && tops.includes(root.id)) tops = [];          // the object's own folder is never wrapped: a new folder goes INSIDE it
    const parent = tops.length ? (_s.items.get(tops[0]).parent || null) : (root?.id || null);
    const it = { id: `f${(++_s.seq).toString(36)}`, kind: 'folder', name: 'Folder', parent, children: [], uid: _newUid(), frame: { q: new (T().Quaternion)(), p: null } };
    _s.items.set(it.id, it); id = it.id;
    const listOf = () => (parent ? _s.items.get(parent).children : _s.rootIds);
    let at = tops.length ? listOf().indexOf(tops[0]) : listOf().length;   // nothing selected before tops[0] sits in this list
    for (const x of tops) _detach(x);
    if (at < 0 || at > listOf().length) at = listOf().length;
    listOf().splice(at, 0, it.id);
    for (const x of tops) { _s.items.get(x).parent = it.id; it.children.push(x); }
    _s.group.updateWorldMatrix(true, true);
    it.frame.p = _pivotLocal(it);                          // its pivot: the middle of what it wraps, fixed from here on (an empty folder gets it from the first thing put in it)
  });
  if (id) { _s.sel = new Set([id]); _s.primary = id; _syncScene(); _emit('select'); }
  return id;
}

function _hasSelectedAncestor(id, set) { let p = _s.items.get(id)?.parent; while (p) { if (set.has(p)) return true; p = _s.items.get(p)?.parent; } return false; }
function _detach(id) {
  const it = _s.items.get(id); if (!it) return;
  const list = it.parent ? _s.items.get(it.parent)?.children : _s.rootIds;
  const k = list ? list.indexOf(id) : -1; if (k >= 0) list.splice(k, 1);
}
const _isUnder = (id, ancestorId) => { let p = id; while (p) { if (p === ancestorId) return true; p = _s.items.get(p)?.parent; } return false; };

/** Move items into a folder (or to the top level when target is null), optionally before a sibling. */
export function polyMove(ids, targetFolderId = null, beforeId = null) {
  if (!_s) return false;
  const set = new Set(ids), tops = ids.filter(x => _s.items.has(x) && !_hasSelectedAncestor(x, set));
  if (!tops.length) return false;
  if (beforeId && tops.includes(beforeId)) return false;                 // dropped on itself: nothing moves
  if (targetFolderId) { const tf = _s.items.get(targetFolderId); if (!tf || tf.kind !== 'folder') return false; if (tops.some(x => _isUnder(targetFolderId, x))) { setStatus('A folder cannot go inside itself.', 'warn', 3000); return false; } }
  return _treeOp('Move in the tree', () => {
    for (const x of tops) _detach(x);
    const list = targetFolderId ? _s.items.get(targetFolderId).children : _s.rootIds;
    let at = beforeId ? list.indexOf(beforeId) : -1; if (at < 0) at = list.length;
    list.splice(at, 0, ...tops);
    for (const x of tops) _s.items.get(x).parent = targetFolderId || null;
  });
}

export function polyDeleteSelected() {
  if (!_s || !_s.sel.size) return false;
  if (isPolyEditing()) exitPolyEdit();
  const sel = new Set(_s.sel), tops = [...sel].filter(x => !_hasSelectedAncestor(x, sel));
  const ok = _treeOp(tops.length === 1 ? 'Delete' : `Delete ${tops.length} items`, () => { for (const x of tops) _detach(x); });
  if (ok) { _s.sel = new Set(); _s.primary = null; _syncScene(); _emit('select'); }
  return ok;
}

export function polyDuplicateSelected() {
  if (!_s || !_s.sel.size) return false;
  if (isPolyEditing()) exitPolyEdit();
  const sel = new Set(_s.sel), tops = [...sel].filter(x => !_hasSelectedAncestor(x, sel));
  const made = [];
  const copy = (id, parent) => {
    const it = _s.items.get(id);
    const nid = `${it.kind === 'folder' ? 'f' : 'p'}${(++_s.seq).toString(36)}`;
    if (it.kind === 'folder') { const f = { id: nid, kind: 'folder', name: it.name, parent, children: [], uid: _newUid(), frame: { q: it.frame.q.clone(), p: it.frame.p ? it.frame.p.clone() : null } }; _s.items.set(nid, f); f.children = it.children.map(c => copy(c, nid)); }
    else {
      const p = { id: nid, kind: 'part', name: `${it.name} copy`, parent, poly: clonePoly(it.poly), color: it.color.slice(), mesh: null, uid: _newUid(), presetId: it.presetId || null, colorEdited: !!it.presetId };   // a copy is a new object
      _s.items.set(nid, p); _buildPartMesh(p);
      p.mesh.position.copy(it.mesh.position); p.mesh.quaternion.copy(it.mesh.quaternion); p.mesh.scale.copy(it.mesh.scale);
    }
    return nid;
  };
  const ok = _treeOp(tops.length === 1 ? 'Duplicate' : `Duplicate ${tops.length} items`, () => {
    for (const x of tops) {
      const it = _s.items.get(x), nid = copy(x, it.parent);
      const list = it.parent ? _s.items.get(it.parent).children : _s.rootIds;
      list.splice(list.indexOf(x) + 1, 0, nid); made.push(nid);
    }
  });
  if (ok) { _s.sel = new Set(made); _s.primary = made[0] || null; _syncScene(); _emit('select'); }
  return ok;
}

// ── add a primitive (V0.3.5.18) ──────────────────────────────────────────────
// A primitive added here is a part like any other: an editable poly from the first moment (1 / 4 go
// straight into its vertices / faces). It is made with few sides (16) — faces one can model with — and
// every kind comes out CLOSED (node-tested), so joins and cuts work on it. A flat plane is not offered:
// it is not a solid (it comes with the shapes-to-extrude step).
const ADD_KINDS = ['box', 'cylinder', 'sphere', 'cone', 'pyramid', 'tube', 'torus', 'capsule', 'geosphere'];
const ADD_QUALITY = 2;
export const polyPrimitiveKinds = () => ADD_KINDS.filter(k => PRIMITIVE_DEFS[k]).map(k => ({ kind: k, label: PRIMITIVE_DEFS[k].label, icon: PRIMITIVE_DEFS[k].icon || '⬡' }));
/** 1 / 2 / 5 × 10ⁿ, at or below x. */
const _nice = (x) => { if (!(x > 0) || !isFinite(x)) return 20; const e = Math.pow(10, Math.floor(Math.log10(x))), m = x / e; return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * e; };

export function polyAddPrimitive(kind) {
  if (!_s || !ADD_KINDS.includes(kind) || !PRIMITIVE_DEFS[kind]) return null;
  if (isPolyEditing()) exitPolyEdit();
  if (!_s) return null;
  const Th = T(), label = PRIMITIVE_DEFS[kind].label, params = defaultPrimitiveParams(kind);
  let poly = null;
  try {
    if (kind === 'box') poly = makeBoxPoly(params.width, params.height, params.depth, true);
    else { const g = buildPrimitiveGeometry(kind, params, ADD_QUALITY, true); if (g) { poly = geometryToPoly(g, { heal: true }); g.dispose?.(); } }
  } catch (err) { console.warn('[poly session] primitive', kind, err); }
  if (!isPoly(poly)) { setStatus(`The ${label.toLowerCase()} could not be made.`, 'warn', 4000); return null; }
  // Size: about a fifth of what the view shows, as a round number. Place: where the camera is looking.
  let size = 20; const at = new Th.Vector3();
  try {
    const cam = sceneCore.camera, cs = sceneCore.getCameraState?.();
    _s.group.updateWorldMatrix(true, false);
    const ws = _s.group.getWorldScale(new Th.Vector3()), gs = Math.max(Math.abs(ws.x), Math.abs(ws.y), Math.abs(ws.z)) || 1;
    if (cam && Array.isArray(cs?.position) && Array.isArray(cs?.pivot)) {
      const pos = new Th.Vector3().fromArray(cs.position), piv = new Th.Vector3().fromArray(cs.pivot);
      const dir = cam.getWorldDirection(new Th.Vector3());
      let depth = piv.clone().sub(pos).dot(dir);            // the pivot's depth — but on the view axis: the middle of the screen
      if (!(depth > 1e-6)) depth = pos.distanceTo(piv) || 100;
      const visH = 2 * depth * Math.tan((cam.fov || 35) * Math.PI / 360);
      size = _nice(0.2 * visH / gs);
      at.copy(_s.group.worldToLocal(pos.clone().addScaledVector(dir, depth)));
    }
  } catch (err) { console.warn('[poly session] primitive placement', err); }
  const k = size / (kind === 'box' ? params.width : 20);  // every kind's default is about 20 across
  if (isFinite(k) && k > 0 && Math.abs(k - 1) > 1e-9) for (let i = 0; i < poly.v.length; i++) poly.v[i] = Math.round(poly.v[i] * k * 1e6) / 1e6;
  const alive0 = _aliveIds(), names = new Set([...alive0].map(x => _s.items.get(x).name));
  let name = label; for (let n = 2; names.has(name); n++) name = `${label} ${n}`;
  let id = null;
  const ok = _treeOp(`Add ${label.toLowerCase()}`, () => {
    const sel = _s.primary && alive0.has(_s.primary) ? _s.items.get(_s.primary) : null;   // lands in the selected folder, or right after the selected part
    const parent = sel ? (sel.kind === 'folder' ? sel.id : (sel.parent || null)) : (_rootFolder()?.id || null);   // nothing selected: in the object's folder
    const it = { id: `p${(++_s.seq).toString(36)}`, kind: 'part', name, parent, poly, color: [0.75, 0.79, 0.83], mesh: null, uid: _newUid() };
    _s.items.set(it.id, it); id = it.id;
    _buildPartMesh(it);
    it.mesh.position.copy(at);
    const list = parent ? _s.items.get(parent).children : _s.rootIds;
    const k2 = sel && sel.kind !== 'folder' ? list.indexOf(sel.id) : -1;
    list.splice(k2 >= 0 ? k2 + 1 : list.length, 0, it.id);
    const f = parent ? _s.items.get(parent) : null;
    if (f && !f.frame.p) { _s.group.updateWorldMatrix(true, true); f.frame.p = _pivotLocal(f); }   // an empty folder gets its pivot from the first thing put in it: the middle of it
  });
  if (!ok || !id) return null;
  _s.sel = new Set([id]); _s.primary = id; _syncScene(); _emit('select');
  setStatus(`${name} added (${size} across) — the gizmo moves it; ${keyLabel('polyVertices')} / ${keyLabel('polyFaces')} edit its vertices / faces.`, 'success', 6000);
  return id;
}

// ── a part's poly (the sub-object editor commits here) ───────────────────────
function _setPartPoly(id, poly, label, before) {
  const part = _s?.items.get(id); if (!part) return;
  const prev = isPoly(before) ? clonePoly(before) : clonePoly(part.poly), next = clonePoly(poly);
  part.poly = clonePoly(next); _refreshPartMesh(part);
  const sid = _s.sid;
  _noteEdit();
  undoManager.push(label || 'Edit poly',
    () => { if (!_s || _s.sid !== sid) return false; part.poly = clonePoly(prev); _refreshPartMesh(part); _partChanged(id); _emit('undo'); },
    () => { if (!_s || _s.sid !== sid) return false; part.poly = clonePoly(next); _refreshPartMesh(part); _partChanged(id); _emit('undo'); },
    { scope: SCOPE });
  _emit('tree');
}
const _partSubs = new Map();
const _partChanged = (id) => { for (const fn of [...(_partSubs.get(id) || [])]) { try { fn('undo'); } catch (err) { console.warn(err); } } };

function _partHost(id) {
  const sid = _s.sid;
  return {
    key: `part:${sid}:${id}`, partId: id,
    worldFrame() { return _s && _s.sid === sid ? _sessionFrame() : null; },   // the editor's world, for the vertices / faces gizmo too
    get mesh() { return _s && _s.sid === sid ? (_s.items.get(id)?.mesh || null) : null; },
    alive() { return !!_s && _s.sid === sid && _aliveIds().has(id); },
    getPoly() { const p = _s?.items.get(id); return p ? clonePoly(p.poly) : null; },
    snapshot() { const p = _s?.items.get(id); return p ? clonePoly(p.poly) : null; },
    commit(poly, label, before) { _setPartPoly(id, poly, label, before); },
    subscribe(fn) { let set = _partSubs.get(id); if (!set) _partSubs.set(id, set = new Set()); set.add(fn); return () => set.delete(fn); },
    onEnter() { gizmo.hide(); },
    onExit() { if (_s) { _s.subMode = null; _syncScene(); _hint(); _emit('mode'); } },
    onMissClick(e) { if (_s) _clickSelect(_pickPart(e), e); },
  };
}

/** Into the vertices / faces of the primary selected part (1 / 4, a double-click, the panel's level buttons). */
export function polyEnterSub(mode = 'face', id = null) {
  if (!_s) return false;
  _scaleEnd();
  const target = id || _s.primary || _selectedPartIds()[0];
  const it = _s.items.get(target);
  if (!it || it.kind !== 'part') { setStatus('Select ONE part first, then choose vertices or faces.', 'warn', 3500); return false; }
  if (isPolyEditing() && polyEditHostKey() === `part:${_s.sid}:${it.id}`) { exitPolyEdit(); }
  _s.sel = new Set([it.id]); _s.primary = it.id;
  _syncScene();
  if (gizmo.activeTarget === _target) gizmo.hide();
  it.mesh.material.emissive?.setHex(0x000000);            // the sub-object highlights speak for themselves
  const ok = enterPolyEditHost(_partHost(it.id), mode);
  if (ok) { _s.subMode = mode === 'vertex' ? 'vertex' : 'face'; _emit('mode'); }
  return ok;
}
export function polyExitSub() { if (isPolyEditing()) exitPolyEdit(); }

export function polyCleanSelected() {
  if (!_s) return false;
  const ids = _selectedPartIds();
  if (!ids.length) { setStatus('Select the part(s) to clean first.', 'warn', 3000); return false; }
  let n = 0;
  for (const id of ids) if (cleanPolyEdgesHost(_partHost(id))) n++;
  return n > 0;
}

// ── views ────────────────────────────────────────────────────────────────────
function _sessionBox(onlySelected = false) {
  const Th = T(); const box = new Th.Box3();
  const ids = onlySelected && _s.sel.size ? new Set(_selectedPartIds()) : null;
  const alive = _aliveIds();
  _s.group.updateWorldMatrix(true, true);
  for (const it of _s.items.values()) if (it.kind === 'part' && it.mesh && alive.has(it.id) && (!ids || ids.has(it.id))) box.expandByObject(it.mesh);
  return box.isEmpty() ? null : box;
}

export function setPolyView(view, { fit = true, selectionOnly = false } = {}) {
  if (!_s) return;
  const Th = T(); const cam = sceneCore.camera;
  const box = _sessionBox(selectionOnly);
  try {
    if (sceneCore.getStandardView?.()) sceneCore._exitStandardView?.();         // back to the perspective lens first
    if (view === 'persp') {
      if (box) {
        // V0.3.5.23 — the views are the ASSET's (the editor's world): a model the step laid on its side opens upright
        const gq = _groupQuat(), up = new Th.Vector3(0, 1, 0).applyQuaternion(gq);
        const c = box.getCenter(new Th.Vector3()), dir = new Th.Vector3(1, 0.75, 1).normalize().applyQuaternion(gq);
        const pos = c.clone().addScaledVector(dir, Math.max(box.getSize(new Th.Vector3()).length(), 1) * 2);
        const q = new Th.Quaternion().setFromRotationMatrix(new Th.Matrix4().lookAt(pos, c, up));
        const fov = cam.fov < 5 ? (_s.fovPersp || 35) : cam.fov;
        sceneCore.applyCameraState({ position: [pos.x, pos.y, pos.z], quaternion: [q.x, q.y, q.z, q.w], pivot: [c.x, c.y, c.z], up: [up.x, up.y, up.z], fov, orbitPivot: null });
        if (fit) sceneCore.animateCameraTo(sceneCore.fitStateForBox(box, 1.3), 0);
      }
    } else {
      if (box && fit) sceneCore.animateCameraTo(sceneCore.fitStateForBox(box, 1.3), 0);   // frame it in the current lens …
      sceneCore.applyStandardView(view, 0, { frameQuat: _groupQuat() });                   // … then look along the ASSET's axis, flat
    }
  } catch (err) { console.warn('[poly session] view', err); }
  _s.view = view;
  syncPolyRefs();                                          // a reference picture shows only in its own view
  sceneCore.requestRender?.(300);
  _emit('view');
}
/** Frame the selection (or everything) from where the user is looking; a flat axis view stays flat. */
export function polyFit() {
  if (!_s) return;
  const box = _sessionBox(_s.sel.size > 0); if (!box) return;
  try {
    const std = sceneCore.getStandardView?.();
    if (std) sceneCore._exitStandardView?.();              // frame in the perspective lens, then go flat again (keeps the lens to return to)
    sceneCore.animateCameraTo(sceneCore.fitStateForBox(box, 1.3), 0);
    if (std) sceneCore.applyStandardView(std, 0, { frameQuat: _groupQuat() });
  } catch (err) { console.warn('[poly session] fit', err); }
  sceneCore.requestRender?.(300);
}

// ── picking + the object-level gizmo ─────────────────────────────────────────
function _pickPart(e) {
  const Th = T(); const rect = sceneCore.renderer.domElement.getBoundingClientRect();
  const rc = _s.rc || (_s.rc = new Th.Raycaster());
  rc.setFromCamera(new Th.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), sceneCore.camera);
  const alive = _aliveIds();
  const meshes = [..._s.items.values()].filter(it => it.kind === 'part' && it.mesh && alive.has(it.id)).map(it => it.mesh);
  const h = rc.intersectObjects(meshes, false)[0];
  return h ? h.object.userData.polyPartId : null;
}

function _clickSelect(id, e) {
  if (!id) { if (!(e.shiftKey || e.ctrlKey || e.metaKey)) polySelect([]); return; }
  polySelect([id], { toggle: !!(e.shiftKey || e.ctrlKey || e.metaKey) });
}

// What the gizmo acts on, and in whose axes (his rule, V0.3.5.19):
//   WORLD   the world's axes — always;
//   LOCAL   the object's own axes (a part's frame, a folder's frame);
//   PARENT  the axes of the nearest folder above it — the world when it sits at the top level.
// (Inside a part — vertices / faces — the same three mean: world · the selected faces' normal · the part.)
function _itemBoxWorld(it) {
  const Th = T(), box = new Th.Box3(), alive = _aliveIds();
  const walk = (x) => { const n = _s.items.get(x); if (!n || !alive.has(x)) return; if (n.kind === 'part') { if (n.mesh) box.expandByObject(n.mesh); } else n.children.forEach(walk); };
  walk(it.id);
  return box.isEmpty() ? null : box;
}
/** The pivot of a part / folder, in the session group's space. */
function _pivotLocal(it) {
  if (it.kind === 'part') return it.mesh ? it.mesh.position.clone() : null;
  if (it.frame.p) return it.frame.p.clone();
  const box = _itemBoxWorld(it);
  return box ? _s.group.worldToLocal(box.getCenter(new (T().Vector3)())) : null;
}
const _groupQuat = () => _s.group.getWorldQuaternion(new (T().Quaternion)());
/**
 * The editor's own WORLD (V0.3.5.23, his answer: "relative to the asset"): the asset's origin, axes and
 * units — the session group. Editing an asset whose model a step has moved / turned, a part on the
 * asset's origin reads 0, 0, 0 from whichever step the editor was opened. A plain session's group is the
 * scene itself, so there it is simply the scene's world.
 */
function _sessionFrame() {
  const Th = T();
  _s.group.updateWorldMatrix(true, false);
  const pos = new Th.Vector3(), quat = new Th.Quaternion(), sc = new Th.Vector3();
  _s.group.matrixWorld.decompose(pos, quat, sc);
  return { pos, quat, scale: Math.max(Math.abs(sc.x), Math.abs(sc.y), Math.abs(sc.z)) || 1, name: _s.reedit ? "the asset's origin" : 'the world' };
}
/** The ONE item the selection is (a part, or a folder with everything in it) — null for a multi-selection. */
function _singleTop() {
  if (!_s) return null;
  const alive = _aliveIds(), sel = new Set([..._s.sel].filter(x => alive.has(x)));
  const tops = [...sel].filter(x => !_hasSelectedAncestor(x, sel));
  return tops.length === 1 ? _s.items.get(tops[0]) : null;
}
/** The item whose axes LOCAL / PARENT are read from: the primary selection. */
function _subject() {
  if (!_s) return null;
  const alive = _aliveIds();
  const id = _s.primary && _s.sel.has(_s.primary) && alive.has(_s.primary) ? _s.primary : [..._s.sel].find(x => alive.has(x));
  return id ? _s.items.get(id) : null;
}
const _nearestFolder = (it) => { const f = it?.parent ? _s.items.get(it.parent) : null; return f && f.kind === 'folder' ? f : null; };
/** Folders that move with the selection: the selected ones and every folder inside them. */
function _foldersInSelection() {
  const out = [], alive = _aliveIds();
  const walk = (id, inSel) => { const it = _s.items.get(id); if (!it || !alive.has(id) || it.kind !== 'folder') return; const on = inSel || _s.sel.has(id); if (on) out.push(it); it.children.forEach(c => walk(c, on)); };
  _s.rootIds.forEach(id => walk(id, false));
  return out;
}

const _target = {
  isPolySession: true,
  spaces: ['world', 'parent', 'local'], defaultSpace: 'world',   // his order (V0.3.5.20)
  spaceLabel: (m) => `${_s?.pivotMode ? 'PIVOT · ' : ''}${m === 'local' ? 'LOCAL' : m === 'parent' ? 'PARENT' : 'WORLD'}`,
  // V0.3.5.20 — what the panel's numbers are measured from: the world's origin, or the pivot + axes of the
  // folder the object sits in (no folder = the world is its folder). LOCAL = the object itself: nothing to read.
  panelFrame(mode) {
    const Th = T(); if (!_s || mode === 'local') return null;
    const w = _sessionFrame();
    if (mode === 'parent') {
      const sub = _subject(), f = sub ? _nearestFolder(sub) : null, p = f ? _pivotLocal(f) : null;
      if (f && p) return { pos: _s.group.localToWorld(p), quat: w.quat.clone().multiply(f.frame.q), scale: w.scale, name: `“${f.name}”` };
    }
    return w;                                               // the world — and the "folder" of what sits in no folder
  },
  panelWorldQuat() { return _s && _subject() ? _target.getWorldQuat('local') : null; },
  worldQuat() { return _s ? _groupQuat() : null; },        // the gizmo's WORLD axes = the asset's
  panelUnit() { return _s ? _sessionFrame().scale : 1; },
  panelNudge: true,
  panelTitle: () => { if (!_s) return 'Poly Editor'; const one = _singleTop(), n = _selectedPartIds().length; return `${_s.pivotMode ? 'Pivot of ' : ''}${one ? one.name : `${n} parts`}`; },
  panelHint: () => (_s?.pivotMode ? 'Pivot mode: only the pivot moves, the geometry stays where it is.' : `${_s?.reedit ? "WORLD = the asset's own origin and axes · " : ''}PARENT = its folder's (no folder = the world) · LOCAL = the object's own axes.`),
  onSpaceChange(m) { if (_s) _s.space = m; },
  getWorldPos() {
    if (!_s) return null;
    const Th = T();
    const po = _s.xf?.pivotOnly; if (po) return _s.group.localToWorld(po.pos.clone());
    const one = _singleTop();
    if (one) { const p = _pivotLocal(one); return p ? _s.group.localToWorld(p) : null; }   // ONE object: the gizmo sits on its pivot
    const box = new Th.Box3();
    for (const id of _selectedPartIds()) { const m = _s.items.get(id)?.mesh; if (m) box.expandByObject(m); }
    return box.isEmpty() ? null : box.getCenter(new Th.Vector3());
  },
  getWorldQuat(mode = 'local') {
    const Th = T(); if (!_s) return new Th.Quaternion();
    const sub = _subject(); if (!sub) return new Th.Quaternion();
    const gq = _groupQuat();
    if (mode === 'parent') { const f = _nearestFolder(sub); return f ? gq.multiply(f.frame.q) : gq; }   // no folder: the editor's world is its folder
    const po = _s.xf?.pivotOnly; if (po) return gq.multiply(po.quat);
    return sub.kind === 'part' ? sub.mesh.getWorldQuaternion(new Th.Quaternion()) : gq.multiply(sub.frame.q);
  },
  beginMove() { _xfBegin(); },
  applyCumulativeDelta(worldD) {
    const xf = _s?.xf; if (!xf) return;
    const d = worldD.clone().applyMatrix3(xf.rootInv3);
    if (xf.pivotOnly) { xf.pivotOnly.pos.copy(xf.pivotOnly.pos0).add(d); sceneCore.requestRender?.(60); return; }
    for (const r of xf.rows) r.mesh.position.copy(r.pos).add(d);
    for (const r of xf.frows) if (r.p) r.it.frame.p.copy(r.p).add(d);
    if (xf.frows.length) syncPolyRefs();                     // the pictures ride the object's folder
    sceneCore.requestRender?.(60);
  },
  commitMove() { _xfCommit('Move part'); },
  hasRotate: true,
  beginRotate() { _xfBegin(); },
  applyRotateAroundAxis(worldAxis, rad) {
    const xf = _s?.xf; if (!xf) return;
    const Th = T();
    const axis = worldAxis.clone().applyMatrix3(xf.rootInv3).normalize();
    const q = new Th.Quaternion().setFromAxisAngle(axis, rad);
    if (xf.pivotOnly) { xf.pivotOnly.quat.copy(q).multiply(xf.pivotOnly.quat0); sceneCore.requestRender?.(60); return; }
    _xfRigid(xf, q, null);
    sceneCore.requestRender?.(60);
  },
  commitRotate() { _xfCommit('Rotate part'); },
};

/** Rotate (about the gesture's pivot) and / or shift everything the gesture holds — parts and folder frames. Group space. */
function _xfRigid(xf, q, d) {
  for (const r of xf.rows) {
    r.mesh.position.copy(r.pos).sub(xf.pivot).applyQuaternion(q).add(xf.pivot); if (d) r.mesh.position.add(d);
    r.mesh.quaternion.copy(q).multiply(r.quat);
  }
  for (const r of xf.frows) {
    r.it.frame.q.copy(q).multiply(r.q);
    if (r.p) { r.it.frame.p.copy(r.p).sub(xf.pivot).applyQuaternion(q).add(xf.pivot); if (d) r.it.frame.p.add(d); }
  }
}

function _xfBegin() {
  if (!_s) return;
  const Th = T();
  _s.group.updateWorldMatrix(true, true);
  const rootInv = _s.group.matrixWorld.clone().invert();      // the parts' parent space (the session group; identity for a plain session)
  const pivotW = _target.getWorldPos() || new Th.Vector3();
  const xf = { rows: [], frows: [], rootInv3: new Th.Matrix3().setFromMatrix4(rootInv), pivot: pivotW.clone().applyMatrix4(rootInv), pivotOnly: null };
  const one = _s.pivotMode ? _singleTop() : null;
  if (one) {                                                 // PIVOT mode: the gesture moves the frame, not the geometry
    const pos = _pivotLocal(one) || new Th.Vector3(), quat = one.kind === 'part' ? one.mesh.quaternion.clone() : one.frame.q.clone();
    xf.pivotOnly = { it: one, pos0: pos.clone(), quat0: quat.clone(), pos, quat };
  } else {
    xf.rows = _selectedPartIds().map(id => { const m = _s.items.get(id).mesh; return { id, mesh: m, pos: m.position.clone(), quat: m.quaternion.clone() }; });
    xf.frows = _foldersInSelection().map(it => ({ it, q: it.frame.q.clone(), p: it.frame.p ? it.frame.p.clone() : null }));
  }
  _s.xf = xf;
}

function _xfCommit(label) {
  const xf = _s?.xf; if (!xf) return;
  _s.xf = null;
  if (xf.pivotOnly) {
    const po = xf.pivotOnly;
    if (po.pos.distanceToSquared(po.pos0) > 1e-12 || Math.abs(po.quat.dot(po.quat0)) < 1 - 1e-12) _setFrame(po.it, po.pos, po.quat, /^Rotate/.test(label) ? 'Rotate pivot' : 'Move pivot');
    return;
  }
  const after = xf.rows.map(r => ({ mesh: r.mesh, pos: r.mesh.position.clone(), quat: r.mesh.quaternion.clone() }));
  const fafter = xf.frows.map(r => ({ it: r.it, q: r.it.frame.q.clone(), p: r.it.frame.p ? r.it.frame.p.clone() : null }));
  const moved = xf.rows.some((r, i) => r.pos.distanceToSquared(after[i].pos) > 1e-12 || Math.abs(r.quat.dot(after[i].quat)) < 1 - 1e-12)
    || xf.frows.some((r, i) => Math.abs(r.q.dot(fafter[i].q)) < 1 - 1e-12 || (!!r.p && r.p.distanceToSquared(fafter[i].p) > 1e-12));
  if (!moved) return;
  const set = (rows, frows) => {
    for (const r of rows) { r.mesh.position.copy(r.pos); r.mesh.quaternion.copy(r.quat); }
    for (const r of frows) { r.it.frame.q.copy(r.q); r.it.frame.p = r.p ? r.p.clone() : null; }
  };
  _push(xf.rows.length > 1 ? `${label}s` : label, () => set(xf.rows, xf.frows), () => set(after, fafter));
}

/**
 * Give a part / folder another pivot + axes WITHOUT moving its geometry (pos, quat in the session group's space).
 * A part's vertices are re-expressed in the new frame; a folder only remembers the frame. One undo step.
 */
function _setFrame(it, pos, quat, label) {
  if (!_s || !it) return false;
  const Th = T(), q1 = quat.clone().normalize();
  if (it.kind === 'folder') {
    const before = { q: it.frame.q.clone(), p: it.frame.p ? it.frame.p.clone() : null }, after = { q: q1, p: pos ? pos.clone() : null };
    const set = (f) => { it.frame.q.copy(f.q); it.frame.p = f.p ? f.p.clone() : null; };
    set(after);
    _push(label, () => set(before), () => set(after));
  } else {
    const m = it.mesh, sc = m.scale.clone();
    const M = new Th.Matrix4().compose(pos, q1, sc).invert().multiply(new Th.Matrix4().compose(m.position, m.quaternion, sc));
    const before = { poly: clonePoly(it.poly), pos: m.position.clone(), quat: m.quaternion.clone() };
    const after = { poly: _polyApply(clonePoly(it.poly), M), pos: pos.clone(), quat: q1 };
    const set = (f) => { it.poly = clonePoly(f.poly); m.position.copy(f.pos); m.quaternion.copy(f.quat); _refreshPartMesh(it); _partChanged(it.id); };
    set(after);
    _push(label, () => set(before), () => set(after));
  }
  _syncScene(); _emit('tree');
  return true;
}

// ── pivot ────────────────────────────────────────────────────────────────────
export const isPolyPivotMode = () => !!_s?.pivotMode;
/** PIVOT mode: the gizmo moves / turns only the pivot of the ONE selected object. */
export function polySetPivotMode(on) {
  if (!_s) return false;
  if (on && !_singleTop()) { setStatus('Select ONE part or folder first — a pivot belongs to one object.', 'warn', 4000); return false; }
  if (on && isPolyEditing()) exitPolyEdit();
  if (!_s) return false;
  if (on) _scaleEnd();
  _s.pivotMode = !!on;
  try { gizmo.setSpace(gizmo.spaceMode); } catch { /* the badge re-reads its name on the next show */ }
  _hint(); _syncScene(); _emit('mode');
  return true;
}

/** 'center' · 'base' (the lowest side, in the object's own axes) · 'reset' (axes back to the world's). */
export function polyPivotPreset(what) {
  const it = _singleTop();
  if (!it) { setStatus('Select ONE part or folder first.', 'warn', 3500); return false; }
  const Th = T();
  _s.group.updateWorldMatrix(true, true);
  const curPos = _pivotLocal(it) || new Th.Vector3();
  const curQuat = it.kind === 'part' ? it.mesh.quaternion.clone() : it.frame.q.clone();
  if (what === 'reset') return _setFrame(it, curPos, new Th.Quaternion(), 'Reset pivot axes');
  let target = null;
  if (it.kind === 'part') {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < it.poly.v.length; i += 3) for (let c = 0; c < 3; c++) { const x = it.poly.v[i + c]; if (x < mn[c]) mn[c] = x; if (x > mx[c]) mx[c] = x; }
    target = new Th.Vector3((mn[0] + mx[0]) / 2, what === 'base' ? mn[1] : (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2)
      .applyMatrix4(new Th.Matrix4().compose(it.mesh.position, it.mesh.quaternion, it.mesh.scale));   // its own box → the group's space
  } else {
    const box = _itemBoxWorld(it); if (!box) return false;
    const c = box.getCenter(new Th.Vector3()); if (what === 'base') c.y = box.min.y;
    target = _s.group.worldToLocal(c);
  }
  return _setFrame(it, target, curQuat, what === 'base' ? 'Pivot to base' : 'Pivot to centre');
}

/** The world frame "the object's Y turned onto n, everything else kept" → the session group's space. */
function _quatOnto(it, nW) {
  const Th = T(), gq = _groupQuat();
  const curW = it.kind === 'part' ? it.mesh.getWorldQuaternion(new Th.Quaternion()) : gq.clone().multiply(it.frame.q);
  const y = new Th.Vector3(0, 1, 0).applyQuaternion(curW);
  const qW = nW ? new Th.Quaternion().setFromUnitVectors(y, nW.clone().normalize()).multiply(curW) : curW;
  return gq.invert().multiply(qW);
}
export function polyPivotToSurface() {
  const it = _singleTop();
  if (!it) { setStatus('Select ONE part or folder first.', 'warn', 3500); return false; }
  _startPick({ need: 1, what: `Pivot of ${it.name} — click the point it goes to (its Y turns to the surface)`, done: ([h]) => _setFrame(it, _s.group.worldToLocal(h.p.clone()), _quatOnto(it, h.n), 'Pivot to surface') });
  return true;
}
export function polyPivotBy3Points() {
  const it = _singleTop();
  if (!it) { setStatus('Select ONE part or folder first.', 'warn', 3500); return false; }
  _startPick({ need: 3, circles: true, what: `Pivot of ${it.name} — 3 points on a circle (the pivot goes to its centre)`, done: (pts) => {
    const c = _circle3(pts[0].p, pts[1].p, pts[2].p, _outOf(pts));
    if (!c) { setStatus('Those 3 points are on one line — no circle goes through them.', 'warn', 5000); return; }
    _setFrame(it, _s.group.worldToLocal(c.c.clone()), _quatOnto(it, c.n), 'Pivot by 3 points');
  } });
  return true;
}

// ── align (V0.3.5.20, the project's own way): pick ON THE OBJECT first, then where it goes ──
// Surface: one point on a face of the object, one on a face of another part → the two faces meet
// (the picked points touch, the normals oppose). 3 points: a circle on the object (a pin, a rim), a circle
// on the other part (a hole) → the centres meet, the axes line up (the smaller of the two turns: the
// object is not flipped over).
function _alignRigid(srcP, srcDir, tgtP, tgtDir, label) {
  if (!_s) return;
  const Th = T();
  const wasPivot = _s.pivotMode; _s.pivotMode = false;
  try {
    _xfBegin();
    const xf = _s.xf; if (!xf) return;
    _s.group.updateWorldMatrix(true, false);
    xf.pivot = srcP.clone().applyMatrix4(_s.group.matrixWorld.clone().invert());   // the turn is about the picked point
    const Rw = new Th.Quaternion().setFromUnitVectors(srcDir.clone().normalize(), tgtDir.clone().normalize());
    const q = new Th.Quaternion(), s = Math.sqrt(Math.max(0, 1 - Rw.w * Rw.w)), ang = 2 * Math.acos(Math.min(1, Math.max(-1, Rw.w)));
    if (s > 1e-9 && ang > 1e-9) q.setFromAxisAngle(new Th.Vector3(Rw.x / s, Rw.y / s, Rw.z / s).applyMatrix3(xf.rootInv3).normalize(), ang);
    _xfRigid(xf, q, tgtP.clone().sub(srcP).applyMatrix3(xf.rootInv3));
    _xfCommit(label);
  } finally { if (_s) { _s.pivotMode = wasPivot; _syncScene(); } }
}
const _otherParts = () => { const sel = new Set(_selectedPartIds()), alive = _aliveIds(); return [..._s.items.values()].filter(it => it.kind === 'part' && alive.has(it.id) && !sel.has(it.id)); };
function _alignReady() {
  if (!_s || !_selectedPartIds().length) { setStatus('Select what should be aligned first.', 'warn', 3500); return false; }
  if (!_otherParts().length) { setStatus('There is no other part to align to.', 'warn', 4000); return false; }
  return true;
}
export function polyAlignToSurface() {
  if (!_alignReady()) return false;
  const sel = new Set(_selectedPartIds());
  _startPick({
    need: 2, allow: (i) => (i === 0 ? { only: sel } : { not: sel }),
    what: (i) => (i === 0 ? 'Align — click a face ON THE OBJECT you are aligning (the face that will touch)' : 'Align — now click the face it should sit on'),
    miss: (i) => (i === 0 ? 'Click on the selected object — the face of it that should touch.' : 'Click on ANOTHER part — the surface to sit on.'),
    // a FACE of the object meets the surface (normals opposed); its PIVOT sits on it (the pivot's Y along the surface, like "Pivot to a surface")
    done: ([a, b]) => _alignRigid(a.p, a.snap === 'pivot' ? a.n.clone().negate() : a.n, b.p, b.n.clone().negate(), 'Align to surface'),
  });
  return true;
}
export function polyAlignBy3Points() {
  if (!_alignReady()) return false;
  const sel = new Set(_selectedPartIds());
  _startPick({
    need: 6, circles: true, allow: (i) => (i < 3 ? { only: sel } : { not: sel }),
    what: (i) => (i < 3 ? `Align — point ${i + 1} of 3 ON THE OBJECT (3 corners of the face that will touch, or 3 points of a rim)` : `Align — point ${i - 2} of 3 where it goes (the face / rim it will sit against)`),
    miss: (i) => (i < 3 ? 'Click on the selected object.' : 'Click on ANOTHER part — the one to align to.'),
    done: (pts) => {
      const s = _circle3(pts[0].p, pts[1].p, pts[2].p, _outOf(pts.slice(0, 3))), g = _circle3(pts[3].p, pts[4].p, pts[5].p, _outOf(pts.slice(3)));
      if (!s || !g) { setStatus('Three of those points are on one line — no circle goes through them.', 'warn', 5000); return; }
      // V0.3.5.22 (his test): the two planes MEET — the object's face against the other face, normals opposed —
      // exactly like Align to a surface. (Lining the axes up by the smaller turn left a box sunk INSIDE the other.)
      _alignRigid(s.c, s.n, g.c, g.n.clone().negate(), 'Align by 3 points');
    },
  });
  return true;
}

/** The side the picked surface shows: the sum of the normals of the faces that were clicked (null when the picks say nothing). */
function _outOf(pts) {
  const v = new (T().Vector3)();
  for (const h of pts) if (h?.n) v.add(h.n);
  return v.lengthSq() > 1e-12 ? v.normalize() : null;
}
/**
 * The circle through 3 points → { c: centre, n: its normal } — null when they are on one line. The normal
 * points OUT of the surface the points were picked on (`out`, from the clicked faces); when that does not
 * say (corners clicked from the neighbouring faces, pivots) it is the side turned to the camera — the side
 * of a face one can click on is the side one sees.
 */
function _circle3(a, b, c, out = null) {
  const Th = T();
  const ab = b.clone().sub(a), ac = c.clone().sub(a), n = new Th.Vector3().crossVectors(ab, ac), n2 = n.lengthSq();
  if (!(n2 > 1e-18 * Math.max(ab.lengthSq(), ac.lengthSq(), 1e-12) ** 2) || n2 < 1e-24) return null;
  const centre = a.clone()
    .addScaledVector(new Th.Vector3().crossVectors(n, ab), ac.lengthSq() / (2 * n2))
    .addScaledVector(new Th.Vector3().crossVectors(ac, n), ab.lengthSq() / (2 * n2));
  n.normalize();
  const side = out && Math.abs(n.dot(out)) > 0.2 ? n.dot(out) : n.dot(sceneCore.camera.position.clone().sub(centre));
  if (side < 0) n.negate();
  return { c: centre, n };
}

// ── picking points on the model (for the align / pivot tools) ────────────────
/**
 * need = how many clicks; allow(i) → { only: Set } | { not: Set } | null — which parts click i may land on;
 * what / miss = text, or (i) → text, for click i; circles = the clicks come in threes, each three a circle.
 *
 * A click SNAPS (V0.3.5.21), in this order: to a PIVOT — of a part or of a folder; they are drawn as small
 * diamonds while picking — to a CORNER of the face under the cursor, to the nearest point on an EDGE of that
 * face, else it is the point on the surface. A picked point is drawn as a cross + an ARROW along its normal
 * (cyan = on the object, orange = where it goes: the project's colours); the same pin follows the cursor
 * before the click, so what a click would take is seen first.
 */
const PICK_PIVOT_PX = 8, PICK_CORNER_PX = 12, PICK_EDGE_PX = 10;   // a pivot only when the cursor is on its diamond: it may lie inside the part
function _startPick({ need, what, miss = null, allow = null, circles = false, done }) {
  if (!_s) return;
  if (isPolyEditing()) exitPolyEdit();
  if (!_s) return;
  _endPick(true);
  _scaleEnd();
  const Th = T(), group = new Th.Group(), marks = new Th.Group(), pivots = new Th.Group(), hover = new Th.Group();
  group.name = 'sbs:poly-pick';
  group.add(marks, pivots, hover);
  (sceneCore.overlayScene || sceneCore.scene)?.add(group);
  _s.pick = { need, what, miss, allow, circles, pts: [], done, group, marks, pivots, hover, raf: 0, last: null };
  if (gizmo.activeTarget === _target) gizmo.hide();
  _pickPivotMarks();
  _pickHint();
}
const _pickText = (x, i) => (typeof x === 'function' ? x(i) : x);
function _pickHint() { const k = _s?.pick; if (k) setStickyStatus(`⬚ ${_pickText(k.what, k.pts.length)} — click ${k.pts.length + 1} of ${k.need} · it snaps to pivots ◇, corners and edges · Esc or right-click cancels`, 'info', 'polySession'); }
function _disposePins(g) {
  while (g.children.length) { const c = g.children[g.children.length - 1]; g.remove(c); if (c.children?.length) _disposePins(c); c.geometry?.dispose?.(); c.material?.dispose?.(); }
}
function _endPick(quiet = false) {
  const k = _s?.pick; if (!k) return;
  if (k.raf) { try { cancelAnimationFrame(k.raf); } catch { /* fine */ } }
  try { _disposePins(k.group); k.group.parent?.remove(k.group); } catch { /* gone */ }
  _s.pick = null;
  if (!quiet) { _hint(); _syncGizmo(); }
  sceneCore.requestRender?.(120);
}
/** Which parts the NEXT click may land on, and the colour of its pin. */
function _pickRule() {
  const k = _s.pick, rule = k.allow ? k.allow(k.pts.length) : null;
  return { ok: (id) => (rule?.only ? rule.only.has(id) : rule?.not ? !rule.not.has(id) : true), color: rule?.only ? 0x55ddff : rule?.not ? 0xff8c1a : 0xfbbf24 };
}
/** The pivots the next click may snap to: of the parts the rule allows, and of the folders whose parts it all allows. World space. */
function _pickPivots() {
  const Th = T(), { ok } = _pickRule(), alive = _aliveIds(), gq = _groupQuat(), out = [];
  const partsUnder = (it) => { const r = []; (function w(x) { const n = _s.items.get(x); if (!n || !alive.has(x)) return; if (n.kind === 'part') r.push(x); else n.children.forEach(w); })(it.id); return r; };
  for (const it of _s.items.values()) {
    if (!alive.has(it.id)) continue;
    if (it.kind === 'part') { if (!it.mesh || !ok(it.id)) continue; }
    else { const ps = partsUnder(it); if (!ps.length || !ps.every(ok)) continue; }
    const pl = _pivotLocal(it); if (!pl) continue;
    const q = it.kind === 'part' ? it.mesh.getWorldQuaternion(new Th.Quaternion()) : gq.clone().multiply(it.frame.q);
    out.push({ p: _s.group.localToWorld(pl), n: new Th.Vector3(0, 1, 0).applyQuaternion(q) });
  }
  return out;
}
const _pinSize = (p) => { const cam = sceneCore.camera; return Math.max(1e-6, cam.position.distanceTo(p) * Math.tan((cam.fov || 35) * Math.PI / 360) * 0.025); };
/** A cross on the point + an arrow along its normal — drawn over everything. */
function _buildPin(p, n, color, opacity = 0.95) {
  const Th = T(), s = _pinSize(p), g = new Th.Group();
  const cg = new Th.BufferGeometry();
  cg.setAttribute('position', new Th.BufferAttribute(new Float32Array([-s, 0, 0, s, 0, 0, 0, -s, 0, 0, s, 0, 0, 0, -s, 0, 0, s]), 3));
  const cross = new Th.LineSegments(cg, new Th.LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity }));
  cross.position.copy(p); cross.renderOrder = 999;
  g.add(cross);
  if (n && n.lengthSq() > 1e-12) {
    const dir = n.clone().normalize(), len = s * 4, q = new Th.Quaternion().setFromUnitVectors(new Th.Vector3(0, 1, 0), dir);
    const shaft = new Th.Mesh(new Th.CylinderGeometry(s * 0.07, s * 0.07, len, 8), new Th.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: opacity * 0.9 }));
    shaft.position.copy(p).addScaledVector(dir, len / 2); shaft.quaternion.copy(q); shaft.renderOrder = 998;
    const head = new Th.Mesh(new Th.ConeGeometry(s * 0.3, s * 0.9, 12), new Th.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: opacity * 0.9 }));
    head.position.copy(p).addScaledVector(dir, len + s * 0.45); head.quaternion.copy(q); head.renderOrder = 998;
    g.add(shaft, head);
  }
  return g;
}
/** The diamonds on the pivots the next click may take. */
function _pickPivotMarks() {
  const k = _s?.pick; if (!k) return;
  const Th = T();
  _disposePins(k.pivots);
  for (const c of _pickPivots()) {
    const r0 = _pinSize(c.p) * 0.5;
    const m = new Th.Mesh(new Th.OctahedronGeometry(r0), new Th.MeshBasicMaterial({ color: 0xe879f9, wireframe: true, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 }));
    m.position.copy(c.p); m.renderOrder = 997; m.userData.r0 = r0;
    k.pivots.add(m);
  }
  sceneCore.requestRender?.(120);
}
/** What a click at this cursor position would take → { p, n, snap: 'pivot' | 'corner' | 'edge' | 'surface' } (world) — or null. */
function _pickPoint(e) {
  const Th = T(), rect = sceneCore.renderer.domElement.getBoundingClientRect(), cam = sceneCore.camera, { ok } = _pickRule();
  const rc = _s.rc || (_s.rc = new Th.Raycaster());
  rc.setFromCamera(new Th.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), cam);
  const s = new Th.Vector3();
  const far2 = (v) => { s.copy(v).project(cam); if (s.z >= 1) return Infinity; const dx = (s.x * 0.5 + 0.5) * rect.width + rect.left - e.clientX, dy = (-s.y * 0.5 + 0.5) * rect.height + rect.top - e.clientY; return dx * dx + dy * dy; };
  // 1. a pivot (it need not lie on the model)
  let best = PICK_PIVOT_PX * PICK_PIVOT_PX, piv = null;
  for (const c of _pickPivots()) { const d = far2(c.p); if (d < best) { best = d; piv = c; } }
  if (piv) return { p: piv.p.clone(), n: piv.n.clone(), snap: 'pivot' };
  // 2. the model
  const alive = _aliveIds();
  const meshes = [..._s.items.values()].filter(it => it.kind === 'part' && it.mesh && alive.has(it.id) && ok(it.id)).map(it => it.mesh);
  const h = rc.intersectObjects(meshes, false)[0];
  if (!h) return null;
  const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
  if (n && n.dot(rc.ray.direction) > 0) n.negate();        // the side that was clicked
  const p = h.point.clone(), part = _s.items.get(h.object.userData.polyPartId);
  let snap = 'surface';
  // Corners and edges OF THE FACE THAT WAS CLICKED only (not of the whole part: in a flat view the corner on
  // the far side projects onto the same pixel, and the tool would land behind the surface).
  const ids = part ? part.poly.f[h.object.geometry?.userData?.faceOfTri?.[h.faceIndex]] : null;
  if (ids) {
    const W = ids.map(vi => new Th.Vector3(part.poly.v[vi * 3], part.poly.v[vi * 3 + 1], part.poly.v[vi * 3 + 2]).applyMatrix4(h.object.matrixWorld));
    let bc = PICK_CORNER_PX * PICK_CORNER_PX, corner = null;
    for (const v of W) { const d = far2(v); if (d < bc) { bc = d; corner = v; } }
    if (corner) { p.copy(corner); snap = 'corner'; }
    else {
      let be = PICK_EDGE_PX * PICK_EDGE_PX, onEdge = null; const q = new Th.Vector3();
      for (let a = 0; a < W.length; a++) {
        rc.ray.distanceSqToSegment(W[a], W[(a + 1) % W.length], undefined, q);     // the point of this edge nearest to the cursor's ray
        const d = far2(q); if (d < be) { be = d; onEdge = q.clone(); }
      }
      if (onEdge) { p.copy(onEdge); snap = 'edge'; }
    }
  }
  return { p, n, snap };
}
/** The pin under the cursor: what the next click would take (one frame late at most). */
function _pickHover(e) {
  const k = _s?.pick; if (!k) return;
  k.last = { clientX: e.clientX, clientY: e.clientY };
  if (k.raf) return;
  k.raf = requestAnimationFrame(() => {
    const kk = _s?.pick; if (!kk || kk !== k) return;
    k.raf = 0;
    _disposePins(k.hover);
    for (const m of k.pivots.children) m.scale.setScalar(_pinSize(m.position) * 0.5 / (m.userData.r0 || 1));   // the same size on screen after a zoom
    let h = null;
    try { h = _pickPoint(k.last); } catch (err) { console.warn('[poly session] pick hover', err); }
    if (h) k.hover.add(_buildPin(h.p, h.n, _pickRule().color, 0.55));
    sceneCore.requestRender?.(60);
  });
}
function _pickClick(e) {
  const k = _s.pick, h = _pickPoint(e), i = k.pts.length;
  if (!h) { setStatus(_pickText(k.miss, i) || 'Click on a part of the model.', 'warn', 3000); return; }
  const color = _pickRule().color;                           // read BEFORE the point is counted: the rule is per click
  if (k.circles && k.pts.slice(k.pts.length - (k.pts.length % 3)).some(q => q.p.distanceToSquared(h.p) < 1e-16)) { setStatus('That is the same point as one already picked — click a different point of the circle.', 'warn', 4000); return; }
  // circles: every 3 points must make a circle — said at the third click, not after all of them
  if (k.circles && k.pts.length % 3 === 2 && !_circle3(k.pts[k.pts.length - 2].p, k.pts[k.pts.length - 1].p, h.p)) { setStatus('That point is on one line with the other two (or on one of them) — no circle goes through them. Click the third point somewhere else.', 'warn', 6000); return; }
  k.pts.push(h);
  _disposePins(k.hover);
  k.marks.add(_buildPin(h.p, h.n, color));
  sceneCore.requestRender?.(120);
  if (k.pts.length < k.need) { _pickPivotMarks(); _pickHint(); return; }
  const pts = k.pts.slice(), done = k.done;
  _endPick(true);
  try { done(pts); } catch (err) { console.warn('[poly session] pick', err); }
  if (_s) { _hint(); _syncScene(); }
}

// ── scale (V0.3.5.26) ────────────────────────────────────────────────────────
// His ask: "we need a way to scale things, 2D and 3D". A box with eight handles is drawn around the
// selection AS IT IS SEEN (the screen's own right / up), from any angle:
//   2D   a side handle stretches it along that screen direction only (width, or height); a corner handle
//        stretches both equally. Depth is not touched.
//   3D   any handle scales it equally in ALL directions.
// The opposite side (or corner) stays where it is. The scale is real: it goes into the vertices of every
// selected part (a part has no "scale" of its own to carry), pivots and folder pivots move with it. One undo step.
export const polyScaleMode = () => _s?.scale?.mode || null;
/** '2d' | '3d' | null (off). */
export function polySetScaleMode(mode) {
  if (!_s) return false;
  const m = mode === '2d' || mode === '3d' ? mode : null;
  if (m && !_selectedPartIds().length) { setStatus('Select what should be scaled first.', 'warn', 3500); return false; }
  if (m && isPolyEditing()) exitPolyEdit();
  if (!_s) return false;
  if (m) { if (_s.pick) _endPick(true); _s.pivotMode = false; if (polyRefsEditing()) setPolyRefsEdit(false); if (!_s.scale) _scaleBegin(); _s.scale.mode = m; }
  else _scaleEnd();
  _hint(); _syncScene(); _emit('mode');
  return true;
}
const _SCALE_HANDLES = { tl: 'nwse-resize', t: 'ns-resize', tr: 'nesw-resize', r: 'ew-resize', br: 'nwse-resize', b: 'ns-resize', bl: 'nesw-resize', l: 'ew-resize' };
function _scaleBegin() {
  const wrap = document.createElement('div');             // the size of the viewport: the box never draws over the side panels
  wrap.style.cssText = 'position:fixed;z-index:50;pointer-events:none;overflow:hidden;display:none;';
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;pointer-events:none;box-sizing:border-box;border:1px dashed #fbbf24;';
  const hs = {};
  for (const [k, cur] of Object.entries(_SCALE_HANDLES)) {
    const h = document.createElement('div');
    h.style.cssText = `position:absolute;width:12px;height:12px;margin:-6px 0 0 -6px;box-sizing:border-box;background:#fff;border:2px solid #b45309;border-radius:2px;pointer-events:auto;cursor:${cur};touch-action:none;`;
    h.style.left = k.includes('l') ? '0%' : k.includes('r') ? '100%' : '50%';
    h.style.top = k.includes('t') ? '0%' : k.includes('b') ? '100%' : '50%';
    h.addEventListener('pointerdown', (e) => _scaleDown(e, k));
    box.append(h); hs[k] = h;
  }
  wrap.appendChild(box); document.body.appendChild(wrap);
  const sc = _s.scale = { mode: '2d', wrap, box, hs, raf: 0, drag: null };
  const tick = () => { if (!_s || _s.scale !== sc) return; _scaleLayout(); sc.raf = requestAnimationFrame(tick); };
  tick();
}
function _scaleEnd() {
  const sc = _s?.scale; if (!sc) return;
  if (sc.drag) _scaleFinish(false);
  try { cancelAnimationFrame(sc.raf); sc.wrap.remove(); } catch { /* gone */ }
  _s.scale = null;
}
/** Where the selection is on the screen: the box its parts' own boxes make, in client pixels. */
function _scaleScreenRect() {
  const Th = T(), cam = sceneCore.camera, r = sceneCore.renderer.domElement.getBoundingClientRect(), v = new Th.Vector3();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of _selectedPartIds()) {
    const m = _s.items.get(id)?.mesh, bb = m?.geometry?.boundingBox; if (!bb) continue;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(m.matrixWorld).project(cam);
      if (!isFinite(v.x) || !isFinite(v.y) || v.z > 1) continue;
      const x = (v.x * 0.5 + 0.5) * r.width + r.left, y = (-v.y * 0.5 + 0.5) * r.height + r.top;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return isFinite(x0) && x1 - x0 > 1 && y1 - y0 > 1 ? { x0, y0, x1, y1, canvas: r } : null;
}
function _scaleLayout() {
  const sc = _s?.scale; if (!sc) return;
  const R = isPolyEditing() || _s.pick ? null : _scaleScreenRect();
  if (!R) { sc.wrap.style.display = 'none'; return; }
  const w = sc.wrap.style, s = sc.box.style, c = R.canvas;
  w.display = 'block'; w.left = `${c.left}px`; w.top = `${c.top}px`; w.width = `${c.width}px`; w.height = `${c.height}px`;
  s.left = `${R.x0 - c.left}px`; s.top = `${R.y0 - c.top}px`; s.width = `${R.x1 - R.x0}px`; s.height = `${R.y1 - R.y0}px`;
}
function _scaleDown(e, k) {
  const sc = _s?.scale; if (!sc || sc.drag || e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const R = _scaleScreenRect(); if (!R) return;
  const Th = T(), cam = sceneCore.camera;
  cam.updateMatrixWorld(); _s.group.updateWorldMatrix(true, true);
  const right = new Th.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize(), up = new Th.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize(), depth = new Th.Vector3().crossVectors(right, up).normalize();
  const wb = new Th.Box3(); for (const id of _selectedPartIds()) { const m = _s.items.get(id)?.mesh; if (m) wb.expandByObject(m); }
  const C = wb.getCenter(new Th.Vector3()), cp = C.clone().project(cam);                 // everything is measured at the depth of the selection's middle
  const hx = k.includes('l') ? -1 : k.includes('r') ? 1 : 0, hy = k.includes('t') ? -1 : k.includes('b') ? 1 : 0;
  const fx = hx < 0 ? R.x1 : hx > 0 ? R.x0 : (R.x0 + R.x1) / 2, fy = hy < 0 ? R.y1 : hy > 0 ? R.y0 : (R.y0 + R.y1) / 2;   // the side that stays
  const d = sc.drag = {
    hx, hy, fx, fy, sx0: hx < 0 ? R.x0 : R.x1, sy0: hy < 0 ? R.y0 : R.y1, right, up, depth, f: [1, 1, 1], M: new Th.Matrix4(),
    F: new Th.Vector3(((fx - R.canvas.left) / R.canvas.width) * 2 - 1, -(((fy - R.canvas.top) / R.canvas.height) * 2 - 1), cp.z).unproject(cam),
    Ginv: _s.group.matrixWorld.clone().invert(),
    rows: _selectedPartIds().map(id => { const it = _s.items.get(id), m = it.mesh; return { it, m, W0: m.matrixWorld.clone() }; }),
    frows: _foldersInSelection().filter(f => f.frame.p).map(f => ({ it: f, p0: f.frame.p.clone() })),
  };
  d.move = (ev) => _scaleMove(ev);
  d.end = () => _scaleFinish(true);
  window.addEventListener('pointermove', d.move, true);
  window.addEventListener('pointerup', d.end, true);
  window.addEventListener('pointercancel', d.end, true);
}
function _scaleMove(e) {
  const sc = _s?.scale, d = sc?.drag; if (!d) return;
  const Th = T();
  let sx = d.hx ? (e.clientX - d.fx) / (d.sx0 - d.fx) : 1, sy = d.hy ? (e.clientY - d.fy) / (d.sy0 - d.fy) : 1;
  sx = Math.max(0.01, sx); sy = Math.max(0.01, sy);                                      // never through itself (no mirror)
  const both = d.hx && d.hy ? Math.max(sx, sy) : d.hx ? sx : sy;
  d.f = sc.mode === '3d' ? [both, both, both] : (d.hx && d.hy ? [both, both, 1] : [d.hx ? sx : 1, d.hy ? sy : 1, 1]);
  // x' = F + A (x − F), A = stretch along the screen's right / up / depth
  const B = new Th.Matrix4().makeBasis(d.right, d.up, d.depth);
  const A = B.clone().multiply(new Th.Matrix4().makeScale(d.f[0], d.f[1], d.f[2])).multiply(B.clone().transpose());
  d.M.makeTranslation(d.F.x, d.F.y, d.F.z).multiply(A).multiply(new Th.Matrix4().makeTranslation(-d.F.x, -d.F.y, -d.F.z));
  for (const r of d.rows) { r.m.matrixAutoUpdate = false; r.m.matrix.copy(d.Ginv).multiply(d.M).multiply(r.W0); r.m.matrixWorldNeedsUpdate = true; }   // shown as it will be; baked when the mouse is let go
  const pc = (x) => `${Math.round(x * 1000) / 10}%`;
  setStatus(sc.mode === '3d' ? `Scale (all directions): ${pc(d.f[0])}` : `Scale: width ${pc(d.f[0])} · height ${pc(d.f[1])}`, 'info', 1500);
  sceneCore.requestRender?.(60);
}
/** The gesture ends: bake it (commit) or put everything back. */
function _scaleFinish(commit) {
  const sc = _s?.scale, d = sc?.drag; if (!d) return;
  sc.drag = null;
  window.removeEventListener('pointermove', d.move, true);
  window.removeEventListener('pointerup', d.end, true);
  window.removeEventListener('pointercancel', d.end, true);
  const Th = T();
  for (const r of d.rows) { r.m.matrixAutoUpdate = true; r.m.updateMatrix(); r.m.matrixWorldNeedsUpdate = true; }
  const changed = commit && d.f.some(x => Math.abs(x - 1) > 1e-6);
  if (!changed) { sceneCore.requestRender?.(120); return; }
  const G = _s.group.matrixWorld;
  const partRows = d.rows.map(r => {
    const m = r.m, pos1 = new Th.Vector3().setFromMatrixPosition(r.W0).applyMatrix4(d.M).applyMatrix4(d.Ginv);   // the pivot goes with it
    const F1w = new Th.Matrix4().multiplyMatrices(G, new Th.Matrix4().compose(pos1, m.quaternion, m.scale));
    const V = F1w.invert().multiply(d.M).multiply(r.W0);                                  // old own space → new own space
    const poly = _polyApply(clonePoly(r.it.poly), V);
    return { it: r.it, before: { poly: clonePoly(r.it.poly), pos: m.position.clone() }, after: { poly, pos: pos1 } };
  });
  const folderRows = d.frows.map(r => ({ it: r.it, before: r.p0.clone(), after: r.p0.clone().applyMatrix4(G).applyMatrix4(d.M).applyMatrix4(d.Ginv) }));
  const put = (key) => {
    for (const r of partRows) { r.it.poly = clonePoly(r[key].poly); r.it.mesh.position.copy(r[key].pos); r.it.mesh.updateMatrixWorld(true); _refreshPartMesh(r.it); _partChanged(r.it.id); }
    for (const r of folderRows) r.it.frame.p = r[key].clone();
  };
  put('after');
  _push(sc.mode === '3d' ? 'Scale (3D)' : 'Scale', () => put('before'), () => put('after'));
  _syncScene(); _emit('tree');
}

// ── the right-click menu of a part / folder ──────────────────────────────────
export function polyShowMenu(x, y) {
  if (!_s || !_s.sel.size) return;
  const one = _singleTop(), nParts = _selectedPartIds().length, onePart = one?.kind === 'part';
  showContextMenu([
    { label: '📍 Align to a surface… (a face of it, then where it goes)', disabled: !nParts, action: () => polyAlignToSurface() },
    { label: '⊚ Align by 3 points… (a circle on it, then the circle it goes to)', disabled: !nParts, action: () => polyAlignBy3Points() },
    { separator: true },
    { label: '⤢ Scale', disabled: !nParts, submenu: [
      { label: `${_s.scale?.mode === '2d' ? '✔ ' : ''}2D — width / height as you see it (a corner = both equally)`, action: () => polySetScaleMode(_s.scale?.mode === '2d' ? null : '2d') },
      { label: `${_s.scale?.mode === '3d' ? '✔ ' : ''}3D — equally in all directions`, action: () => polySetScaleMode(_s.scale?.mode === '3d' ? null : '3d') },
    ] },
    { label: '✛ Pivot', disabled: !one, submenu: [
      { label: _s.pivotMode ? '✔ Moving the pivot only — click to finish' : '✛ Move the pivot only (with the gizmo)', action: () => polySetPivotMode(!_s.pivotMode) },
      { separator: true },
      { label: '📍 Pivot to a point on a surface…', action: () => polyPivotToSurface() },
      { label: '⊚ Pivot by 3 points (the centre of a circle)…', action: () => polyPivotBy3Points() },
      { separator: true },
      { label: 'Pivot to the centre', action: () => polyPivotPreset('center') },
      { label: 'Pivot to the base', action: () => polyPivotPreset('base') },
      { label: "Reset the pivot's axes to the world's", action: () => polyPivotPreset('reset') },
    ] },
    { separator: true },
    { label: `Vertices (${keyLabel('polyVertices')})`, disabled: !onePart, action: () => polyEnterSub('vertex') },
    { label: `Faces (${keyLabel('polyFaces')})`, disabled: !onePart, action: () => polyEnterSub('face') },
    { separator: true },
    { label: '⧉ Duplicate', action: () => polyDuplicateSelected() },
    { label: '📁 New folder around the selection', action: () => polyNewFolder() },
    { label: '🗑 Delete', action: () => polyDeleteSelected() },
  ], x, y);
}

function _syncGizmo() {
  if (!_s || isPolyEditing() || _s.pick) return;
  if (_s.scale) { if (gizmo.activeTarget === _target && !gizmo.isDragging) gizmo.hide(); return; }   // the scale box has the stage: no gizmo under its handles
  if (_s.pivotMode && !_singleTop()) {                       // a pivot belongs to ONE object
    _s.pivotMode = false;
    try { if (gizmo.activeTarget === _target) gizmo.setSpace(gizmo.spaceMode); } catch { /* the badge re-reads its name on the next show */ }
    _hint(); _emit('mode');
  }
  const want = _selectedPartIds().length > 0;
  if (!want) { if (gizmo.activeTarget === _target && !gizmo.isDragging) gizmo.hide(); return; }
  if (gizmo.activeTarget !== _target) { gizmo.showForCableTarget(_target, 'all'); if (_s.space && _s.space !== gizmo.spaceMode) gizmo.setSpace(_s.space); }
  const title = _target.panelTitle();                        // the open amount panel names what it acts on
  if (gizmo._panel && _s.panelTitle !== title) { try { gizmo._rebindPanel(); } catch { /* the panel is the gizmo's own */ } }
  _s.panelTitle = title;
}

// ── input (capture on the canvas / window, registered before the sub-object editor's) ──
const _typing = () => { const el = document.activeElement, tag = el?.tagName; return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable; };

function _attachInput() {
  const dom = sceneCore.renderer.domElement;
  const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); const a = document.activeElement; if (a && a !== document.body && _typing()) a.blur(); };
  const L = {
    down: (e) => {
      if (!_s) return;
      if (e.button === 2) { _s.rmb = { x: e.clientX, y: e.clientY }; return; }
      if (e.button !== 0) return;
      if (_s.pick) { swallow(e); _pickClick(e); return; }
      if (isPolyEditing()) return;                         // the sub-object editor's own listener (added later) takes it
      if (polyRefsEditing() && polyRefsPointerDown(e)) { swallow(e); return; }   // a reference picture (or one of its corners) was grabbed
      swallow(e);
      if (gizmo.activeTarget === _target && gizmo.onPointerDown(e.clientX, e.clientY, false)) { try { dom.setPointerCapture(e.pointerId); } catch { /* fine */ } return; }
      _clickSelect(_pickPart(e), e);
    },
    click: (e) => { if (_s) { e.preventDefault(); e.stopImmediatePropagation(); } },          // the app's click handler never runs here
    move: (e) => { if (_s?.pick) _pickHover(e); },         // the pin under the cursor (nothing is swallowed: the camera still orbits)
    dbl: (e) => { if (!_s) return; e.preventDefault(); e.stopImmediatePropagation(); if (isPolyEditing() || _s.pick) return; const id = _pickPart(e); if (id) polyEnterSub('face', id); },
    menu: (e) => {
      if (!_s) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const r = _s.rmb; _s.rmb = null;
      if (r && Math.hypot(e.clientX - r.x, e.clientY - r.y) > 5) return;      // the button was dragged: not a menu click
      if (_s.pick) { _endPick(); setStatus('Cancelled.', 'info', 2000); return; }
      if (gizmo.onRightClick(e.clientX, e.clientY)) return;                    // on the gizmo: move / rotate by an amount · world / local / parent
      if (isPolyEditing()) return;
      const id = _pickPart(e);
      if (id && !_selectedPartIds().includes(id)) polySelect([id]);
      if (!_s.sel.size) return;
      polyShowMenu(e.clientX, e.clientY);
    },
    key: (e) => _onKey(e),
    mode: () => { if (_s) _emit('mode'); },
    std: (v) => { if (_s) { _s.view = v || 'persp'; syncPolyRefs(); _emit('view'); } },   // orbiting out of an axis view = perspective again (the reference pictures go with the view)
    loaded: () => _forceClose('Another project was opened — the Poly Editor was closed without applying.', 'project'),
    exp: () => { if (state.get('_exporting')) _forceClose('An export started — the Poly Editor was closed without applying.'); },
  };
  dom.addEventListener('pointerdown', L.down, true);
  dom.addEventListener('pointermove', L.move, true);
  dom.addEventListener('click', L.click, true);
  dom.addEventListener('dblclick', L.dbl, true);
  dom.addEventListener('contextmenu', L.menu, true);
  window.addEventListener('keydown', L.key, true);
  state.on('polyEdit:mode', L.mode);
  state.on('project:loaded', L.loaded);                   // NOT change:projectPath — a first save / Save As changes the path too
  state.on('project:fresh', L.loaded);                    // New Project
  state.on('change:_exporting', L.exp);
  sceneCore.on?.('camera:standardView', L.std);
  _s.listeners = L;
}

function _detachInput() {
  const L = _s?.listeners; if (!L) return;
  const dom = sceneCore.renderer?.domElement;
  try {
    dom?.removeEventListener('pointerdown', L.down, true);
    dom?.removeEventListener('pointermove', L.move, true);
    dom?.removeEventListener('click', L.click, true);
    dom?.removeEventListener('dblclick', L.dbl, true);
    dom?.removeEventListener('contextmenu', L.menu, true);
    window.removeEventListener('keydown', L.key, true);
    state.off?.('polyEdit:mode', L.mode);
    state.off?.('project:loaded', L.loaded);
    state.off?.('project:fresh', L.loaded);
    sceneCore.off?.('camera:standardView', L.std);
    state.off?.('change:_exporting', L.exp);
  } catch { /* already gone */ }
  _s.listeners = null;
}

function _onKey(e) {
  if (!_s || _typing() || document.querySelector('dialog[open]')) return;
  // the right-click menu closes on Esc through a listener this handler would cut off: close it here, and nothing else
  if (e.key === 'Escape' && document.getElementById('context-menu')?.style.display === 'block') { e.preventDefault(); e.stopImmediatePropagation(); hideContextMenu(); return; }
  const mod = e.ctrlKey || e.metaKey;
  // Undo / redo stay inside the editor: the shared stack also holds the project's entries underneath.
  if (mod && (e.code === 'KeyZ' || e.code === 'KeyY')) {
    const redo = e.code === 'KeyY' || e.shiftKey;
    if ((redo ? undoManager.redoScope?.() : undoManager.undoScope?.()) !== SCOPE) {
      e.preventDefault(); e.stopImmediatePropagation();
      setStatus(redo ? 'Nothing to redo in the Poly Editor.' : 'Nothing more to undo in the Poly Editor.', 'info', 3500);
    }
    return;
  }
  if (gizmo.isDragging) return;                              // gizmo-numeric owns the keys of a gizmo gesture
  if (_s.pick) { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); _endPick(); setStatus('Cancelled.', 'info', 2000); } return; }
  if (keyMatches('gizmoSpace', e) && !mod && !e.altKey) { e.preventDefault(); gizmo.toggleSpace(); return; }
  if (keyMatches('fitView', e) && !mod && !e.altKey) { e.preventDefault(); polyFit(); return; }
  if (isPolyEditing()) return;                               // 1 / 4 / Esc / typed distances: the sub-object editor's
  if (mod && e.code === 'KeyD') { e.preventDefault(); e.stopImmediatePropagation(); polyDuplicateSelected(); return; }
  if (mod || e.altKey) return;
  if (keyMatches('polyVertices', e) || keyMatches('polyFaces', e)) { e.preventDefault(); e.stopImmediatePropagation(); polyEnterSub(keyMatches('polyVertices', e) ? 'vertex' : 'face'); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault(); e.stopImmediatePropagation();
    const pic = polyRefsEditing() ? polyRefsInfo().sel : null;   // in "move / scale pictures" Del takes the picture that is selected there, not the parts
    if (pic) removePolyRef(pic); else polyDeleteSelected();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopImmediatePropagation();
    if (_s.scale?.drag) _scaleFinish(false);                 // a scale in the hand: put it back
    else if (_s.scale) polySetScaleMode(null);
    else if (polyRefsEditing()) setPolyRefsEdit(false);
    else if (_s.pivotMode) polySetPivotMode(false);
    else if (_s.sel.size) polySelect([]);
    return;
  }
}

function _hint() {
  if (!_s) return;
  if (_s.scale) { setStickyStatus(_s.scale.mode === '3d' ? '⬚ SCALE 3D — pull any handle of the box: everything grows / shrinks equally in all directions · the opposite side stays · Esc ends it' : '⬚ SCALE 2D — pull a side handle = width or height (as you see it) · a corner = both equally · the opposite side stays · Esc ends it', 'info', 'polySession'); return; }
  if (_s.pivotMode) { setStickyStatus(`⬚ PIVOT mode — the gizmo moves / turns only the pivot of ${_singleTop()?.name || 'the object'}; the geometry stays · Esc ends it (or right-click ▸ Pivot)`, 'info', 'polySession'); return; }
  setStickyStatus(`⬚ Poly Editor · right-click a part = align / pivot · right-click the gizmo = move / rotate by an amount · add primitives on the left · click selects a part (Shift adds) · the gizmo moves / rotates it · ${keyLabel('polyVertices')} = vertices, ${keyLabel('polyFaces')} = faces (or double-click) · ${keyLabel('fitView')} = fit · Del deletes · Ctrl+D duplicates · arrange the tree on the left, then Apply`, 'info', 'polySession');
}

// ── the end ──────────────────────────────────────────────────────────────────
function _teardown(how = 'discard') {
  if (!_s) return;
  if (isPolyEditing()) exitPolyEdit();
  _endPick(true);
  _scaleEnd();
  try { disposePolyRefs(); } catch (err) { console.warn('[poly session] reference pictures', err); }
  try { hideContextMenu(); } catch { /* not up */ }
  if (gizmo.activeTarget === _target) gizmo.hide();
  try { gizmo._closePanel?.(); } catch { /* not open */ }
  if (sceneCore.getStandardView?.()) { try { sceneCore._exitStandardView?.(); } catch { /* fine */ } }
  _detachInput();
  try {
    _s.group.parent?.remove(_s.group);
    for (const it of _s.items.values()) if (it.mesh) { it.mesh.geometry?.dispose?.(); it.mesh.material?.dispose?.(); }
  } catch { /* already gone */ }
  _showProject(how);
  _partSubs.clear();
  _s = null;
  clearStickyStatus('polySession');
  try { undoManager.dropScope?.(SCOPE); } catch { /* an older undo manager: the entries are no-ops anyway */ }
  state.setState({ polySession: null, polySessionDirty: null });
  sceneCore.requestRender?.(300);
  _emit('close');
  import('../ui/poly-editor-panel.js').then(m => m.closePolyEditorPanel()).catch(() => {});
}

function _forceClose(msg, how = 'discard') { if (!_s) return; _teardown(how); setStatus(msg, 'warn', 7000); }

export function discardPolySession({ ask = true } = {}) {
  if (!_s) return false;
  if (ask && _s.edits > 0 && !confirm('Discard everything done in the Poly Editor?\n\nThe project is left exactly as it was.')) return false;
  _teardown('discard');
  setStatus('Poly Editor closed — nothing was changed in the project.', 'info', 4000);
  return true;
}

function _b64(ab) {
  const u8 = new Uint8Array(ab); let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

const _safeName = (n) => (String(n || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'poly-asset');

async function _targetPath(name) {
  const nat = window.sbsNative; if (!nat?.writeFile) throw new Error('saving needs the desktop app');
  const dir = subDir('models');
  const base = _safeName(name);
  if (!dir) {                                              // an unsaved project has no folder yet: ask
    return nat.saveFile?.({ title: 'Save the Poly Editor asset (.glb)', defaultPath: `${base}.glb`, filters: [{ name: 'glTF binary', extensions: ['glb'] }] }) || null;
  }
  try { await nat.mkdir?.(dir); } catch { /* writeFile makes the folder too */ }
  for (let k = 1; k < 1000; k++) {
    const p = joinPath(dir, k === 1 ? `${base}.glb` : `${base}-${k}.glb`);
    if (!(await nat.fileExists?.(p))) return p;
  }
  return joinPath(dir, `${base}-${Date.now()}.glb`);
}

/**
 * The session tree → { roots: the glTF node tree, parts: the flat list of what it holds, top-down }.
 * Folders = empty nodes (an empty folder is not written), parts = meshes with their session transform
 * baked in — in the SCENE's space for a new asset (it lands where it stands), in the ASSET's own
 * space when saving over the asset being re-edited.
 */
function _assetLayout(space = 'scene') {
  const Th = T();
  sceneCore.rootGroup.updateWorldMatrix(true, true);
  const rootInv = (space === 'asset' ? _s.group.matrixWorld : sceneCore.rootGroup.matrixWorld).clone().invert();
  // frames → the file's space (a folder's frame lives in the session group's space; a part's is its mesh)
  const X = new Th.Matrix4().multiplyMatrices(rootInv, _s.group.matrixWorld), xq = new Th.Quaternion();
  X.decompose(new Th.Vector3(), xq, new Th.Vector3());
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  const frameOut = (p, q) => ({ p: p ? [r6(p.x), r6(p.y), r6(p.z)] : null, q: [r6(q.x), r6(q.y), r6(q.z), r6(q.w)] });
  const parts = [];
  const node = (id, parentUid) => {
    const it = _s.items.get(id);
    if (!it.uid) it.uid = _newUid();
    if (it.kind === 'folder') {
      const mark = parts.length;
      const ff = frameOut(it.frame.p ? it.frame.p.clone().applyMatrix4(X) : null, xq.clone().multiply(it.frame.q));
      parts.push({ uid: it.uid, kind: 'folder', name: it.name, parentUid, frame: ff });
      const kids = it.children.map(c => node(c, it.uid)).filter(Boolean);
      if (!kids.length) { parts.length = mark; return null; }
      return { name: it.name, children: kids, extras: { sbsId: it.uid, sbsFrame: ff } };
    }
    const M = new Th.Matrix4().multiplyMatrices(rootInv, it.mesh.matrixWorld);
    const fp = new Th.Vector3(), fq = new Th.Quaternion();
    M.decompose(fp, fq, new Th.Vector3());
    const pfr = frameOut(fp, fq);
    parts.push({ uid: it.uid, kind: 'part', name: it.name, parentUid, frame: pfr, tint: it.presetId ? { presetId: it.presetId, edited: !!it.colorEdited } : null });
    const baked = clonePoly(it.poly), v = new Th.Vector3();
    for (let i = 0; i < baked.v.length; i += 3) { v.set(baked.v[i], baked.v[i + 1], baked.v[i + 2]).applyMatrix4(M); baked.v[i] = v.x; baked.v[i + 1] = v.y; baked.v[i + 2] = v.z; }
    if (M.determinant() < 0) baked.f = baked.f.map(f => f.slice().reverse());
    const { positions, normals } = polyToArrays(baked);
    const indices = new Uint32Array(positions.length / 3); for (let i = 0; i < indices.length; i++) indices[i] = i;
    const r4 = (x) => Math.round(x * 1e5) / 1e5;
    return { name: it.name, mesh: { positions, normals, indices, color: it.color }, extras: { sbsId: it.uid, sbsFrame: pfr, sbsPoly: { v: baked.v.map(r4), f: baked.f } } };
  };
  const roots = _s.rootIds.map(id => node(id, null)).filter(Boolean);
  return { roots, parts };
}

/**
 * APPLY — two outcomes and no follow-up questions (his decision, V0.3.5.23: "we'll just have replace and
 * save as new asset; if you want more, you resolve it in the application").
 * Editing an asset that is already in the project:
 *   REPLACE (the default)  the edit is saved over the file and the same model is updated in every step;
 *   SAVE AS A NEW ASSET    asks only for a name; the new .glb is added to the scene as a separate model
 *                          where it stands. The old model is not touched, nothing follows, nothing is
 *                          removed — taking its place, following an object, archiving or deleting the old
 *                          one are things the user does in the project (Files ▸ Browse, Follow, Archive).
 * Anything else (objects → a new asset): asks for the name, writes the .glb, loads it as a model.
 */
export async function applyPolySession() {
  if (!_s || _s.applying || _s.asking) return false;
  if (isPolyEditing()) exitPolyEdit();
  _s.asking = true;
  try {
    const panel = await import('../ui/poly-editor-panel.js');
    if (_s.reedit) {
      const re = _s.reedit;
      const { roots, parts } = _assetLayout('asset');
      if (!roots.length) { setStatus('There is nothing in the tree to save.', 'warn', 4000); return false; }
      const plan = planPolyAssetUpdate(re.modelId, parts);
      const d = plan.ok && plan.structureChanged ? plan.diff : null;
      const changed = d ? [d.added.length ? `${d.added.length} added` : '', d.gone.length ? `${d.gone.length} removed` : '', d.moved.length ? `${d.moved.length} moved to another folder` : ''].filter(Boolean).join(' · ') : '';
      const how = await panel.askPolySaveHow({ file: re.file, canReplace: plan.ok, whyNot: plan.ok ? '' : plan.reason, changed });
      if (!_s || !how) return false;
      if (how === 'replace') return await _applyUpdate();
      const name = await panel.askPolyName({ name: `${re.file.replace(/\.glb$/i, '')}-copy`, keeps: re.file });
      if (!_s || !name) return false;
      _s.name = _safeName(name);
      return await _applyNew({ oldModel: 'keep' });
    }
    if (![..._aliveIds()].some(id => _s.items.get(id).kind === 'part')) { setStatus('There is nothing in the tree to save — add a primitive first.', 'warn', 5000); return false; }
    const name = await panel.askPolyName({ name: _assetName() });
    if (!_s || !name) return false;
    setPolySessionName(_safeName(name));                     // the file, the model and the object's folder carry the same name
    return await _applyNew();
  } finally { if (_s) _s.asking = false; }
}

async function _applyUpdate() {
  const re = _s.reedit;
  const { roots, parts } = _assetLayout('asset');
  if (!roots.length) { setStatus('There is nothing in the tree to save.', 'warn', 4000); return false; }
  const plan = planPolyAssetUpdate(re.modelId, parts);
  if (!plan.ok) { setStatus(`${plan.reason} Save it as a new asset instead.`, 'warn', 9000); return false; }
  const panel = await import('../ui/poly-editor-panel.js');
  if (plan.attached.length) { await panel.showPolyBlocked(plan.attached, re.file); return false; }
  _s.applying = true;
  const name = _safeName(_s.name), others = _s.sourceIds.filter(id => id !== re.modelId);
  try {
    setStickyStatus(`⬚ Poly Editor — updating ${re.file}…`, 'info', 'polySession');
    const refs = polyRefsForSave();
    const glb = sceneGlb({ roots, name: re.file.replace(/\.glb$/i, ''), extras: { sbsPolyEditor: 1, sbsRefs: refs } });
    const r = await updatePolyAssetInPlace(re.modelId, parts, glb, { refs });   // the session stays open until this has worked
    if (!r.ok) {
      if (_s) { _s.applying = false; clearStickyStatus('polySession'); _hint(); }
      if (r.reason === 'attached') { await panel.showPolyBlocked(r.attached, re.file); return false; }
      setStatus(`The asset was not updated: ${r.reason}`, 'danger', 12000);
      return false;
    }
    _teardown('applied');
    try { state.setSelection?.(re.modelId, new Set([re.modelId])); } catch { /* fine */ }
    const what = r.added || r.gone || r.moved ? ` (${[r.added ? `+${r.added} new` : '', r.gone ? `−${r.gone} removed` : '', r.moved ? `${r.moved} moved` : ''].filter(Boolean).join(', ')})` : '';
    setStatus(`Replaced ${re.file} — the same model, in every step${what}.${r.backup ? ' The previous version is in backups/.' : ''} Undo history was cleared.`, 'success', 10000);
    if (others.length) {
      // A picked container that still holds a part of this asset (the user parked it there) is not an
      // "original": archiving it would hide the part that was just updated. Only its other content is.
      const nb = state.get('nodeById'), M = nb?.get(re.modelId)?.polyManifest?.nodes || {};
      const holdsNative = (n) => !!n && (!!M[n.id] || (n.children || []).some(holdsNative));
      const TAKEN = new Set(['mesh', 'primitive', 'folder', 'model', 'replaceModel']);
      const absorbed = [];
      const expand = (n) => {
        if (!n || M[n.id] || !TAKEN.has(n.type)) return;
        if (!holdsNative(n)) { absorbed.push(n.id); return; }
        (n.children || []).forEach(expand);
      };
      others.forEach(id => expand(nb?.get(id)));
      if (absorbed.length) await _settleOriginals(absorbed, name, re.modelId, panel.askPolyOriginals);
    }
    return true;
  } catch (err) {
    console.error('[poly session] update failed', err);
    if (_s) { _s.applying = false; clearStickyStatus('polySession'); _hint(); }
    setStatus(`Update failed: ${err?.message || err}`, 'danger', 12000);
    return false;
  }
}

async function _applyNew({ oldModel = null } = {}) {
  const { roots, parts } = _assetLayout('scene');
  const presetsBefore = new Set((state.get('colorPresets') || []).map(p => p.id));
  if (!roots.length) { setStatus('There is nothing in the tree to save.', 'warn', 4000); return false; }
  _s.applying = true;
  const name = _safeName(_s.name), sourceIds = _s.sourceIds.slice();
  const native = _s.native, aliveNow = _aliveIds();
  const archUids = [..._s.items.values()].filter(it => it.kind === 'part' && it.archived && it.uid && aliveNow.has(it.id)).map(it => it.uid);
  let written = null;
  try {
    const path = await _targetPath(name);
    if (!path) { _s.applying = false; return false; }
    setStickyStatus('⬚ Poly Editor — saving the asset…', 'info', 'polySession');
    // the reference pictures go through the same turn / scale as the geometry (session space → the scene's)
    const Xr = new (T().Matrix4)().multiplyMatrices(sceneCore.rootGroup.matrixWorld.clone().invert(), _s.group.matrixWorld);
    const refsOut = polyRefsForSave(Xr), refsLost = polyRefsInfo().list.length - refsOut.length;
    const glb = sceneGlb({ roots, name, extras: { sbsPolyEditor: 1, sbsRefs: refsOut } });
    const res = await window.sbsNative.writeFile(path, _b64(glb), 'base64');
    if (!res?.ok) throw new Error(res?.error || 'write failed');
    written = path;
    _teardown('applied');                                  // the project comes back (no isolate mask) before the new model lands in it
    const { importModelAtPath } = await import('../ui/sidebar-left.js');
    const modelNode = await importModelAtPath(path);
    if (!modelNode) throw new Error('the saved asset did not load back');
    setStatus(`Poly Editor: saved ${path.split(/[\\/]/).pop()} (${Math.round(glb.byteLength / 1024)} KB) and loaded it into the scene.${refsLost > 0 ? ` ${refsLost} reference picture(s) were left out: the model is turned in this step, so they fit no flat view of the new asset.` : ''}`, refsLost > 0 ? 'warn' : 'success', refsLost > 0 ? 12000 : 7000);
    // parts coloured from the scene's colours wear those same colours (not the look-alikes the import made)
    try { applyPolyPartColours(modelNode.assetId, parts, presetsBefore); } catch (err) { console.warn('[poly session] colours', err); }
    const { askPolyOriginals } = await import('../ui/poly-editor-panel.js');
    // The session held the whole old asset (seeded from its manifest). Two things follow for the NEW model:
    // a part that was archived in the project stays archived, and a part some step keeps OUTSIDE the old
    // model is an original too — archiving the old model alone would leave it on screen beside its copy.
    const strays = [];
    if (native) {
      const nb = state.get('nodeById');
      const trees = [state.get('treeData'), ...(state.get('steps') || []).map(s => s?.snapshot?.tree)].filter(Boolean);
      for (const t of trees) {
        const all = new Set(), under = new Set();
        (function w(n, u) { const x = u || n.id === native.modelId; all.add(n.id); if (x) under.add(n.id); (n.children || []).forEach(c => w(c, x)); })(t, false);
        if (!all.has(native.modelId)) continue;
        for (const id of native.meshIds) if (all.has(id) && !under.has(id) && nb?.has(id) && !strays.includes(id)) strays.push(id);
      }
      if (archUids.length && modelNode.assetId) { try { actions.archiveNodes(archUids.map(u => polyPartNodeId(modelNode.assetId, u, true))); } catch (err) { console.warn('[poly session] re-archive', err); } }
    }
    if (native && oldModel) {
      // A new asset made from an asset that is in the project: the old model is left exactly as it is
      // (V0.3.5.23). Only objects merged in from OUTSIDE it are still asked about.
      const others = sourceIds.filter(id => id !== native.modelId);
      if (others.length) await _settleOriginals(others, name, modelNode.id, askPolyOriginals);
      return true;
    }
    await _settleOriginals([...sourceIds, ...strays], name, modelNode.id, askPolyOriginals);
    return true;
  } catch (err) {
    console.error('[poly session] apply failed', err);
    if (_s) _s.applying = false;
    clearStickyStatus('polySession'); if (_s) _hint();
    setStatus(written ? `The asset was saved (${written}) but did not load: ${err?.message || err}. Import it from Files ▸ Add model.` : `Apply failed: ${err?.message || err}`, 'danger', 12000);
    return false;
  }
}

/** Keep / Archive / Delete-what-can-be-deleted for the objects the asset was made from, + a selection group. */
async function _settleOriginals(sourceIds, name, newModelId, ask) {
  const nodeById = state.get('nodeById');
  const ids = sourceIds.filter(id => nodeById?.has(id) && id !== newModelId);
  if (!ids.length) return;
  const deletable = (id) => { const n = nodeById.get(id); return n?.type === 'primitive' && !(n.children || []).length; };
  const nDel = ids.filter(deletable).length;
  const choice = await ask({ count: ids.length, deletable: nDel });
  if (!choice) return;
  let rest = ids;
  if (choice.action === 'delete') {
    for (const id of ids.filter(deletable)) { try { actions.deletePrimitive(id); } catch (err) { console.warn('[poly session] delete', id, err); } }
    rest = ids.filter(id => state.get('nodeById')?.has(id));
    if (rest.length) actions.archiveNodes(rest);          // what cannot be deleted (model parts, folders) is archived
  } else if (choice.action === 'archive') actions.archiveNodes(ids);
  if (choice.group && rest.length) { try { actions.createSelectionGroup({ name: `Poly: ${name}`, ids: rest }); } catch (err) { console.warn('[poly session] group', err); } }
}
