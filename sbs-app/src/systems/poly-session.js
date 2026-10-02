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
import { matches as keyMatches, keyLabel } from '../core/keymap.js';
import { setIsolateKeepSet, clearIsolate, getIsolateKeepSet } from '../core/isolate-state.js';
import { subDir, joinPath } from '../core/project-paths.js';
import { isPoly, clonePoly, polyToArrays } from './poly-core.js';
import { geometryToPoly, geometryTriangles } from './poly-convert.js';
import { enterPolyEditHost, exitPolyEdit, isPolyEditing, polyEditHostKey, polyEditMode, cleanPolyEdgesHost } from './poly-edit.js';
import { sceneGlb } from '../io/glb-write.js';
import { isEditing as overlayIsEditing, setEditingMode as overlaySetEditing } from './overlay.js';

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
    return { id, kind: it.kind, name: it.name, parent: it.parent || null, depth, faces: it.kind === 'part' ? it.poly.f.length : 0, selected: _s.sel.has(id), primary: _s.primary === id, children: it.kind === 'folder' ? it.children.map(c => row(c, depth + 1)) : [] };
  };
  return {
    name: _s.name, view: _s.view, level: isPolyEditing() ? (polyEditMode() || 'face') : 'object',
    parts: [...alive].filter(id => _s.items.get(id).kind === 'part').length,
    selected: [..._s.sel], primary: _s.primary,
    tree: _s.rootIds.map(id => row(id, 0)),
    canUndo: undoManager.undoScope?.() === SCOPE,
  };
}
export function setPolySessionName(name) { if (_s) { _s.name = String(name || '').trim() || 'poly-asset'; } }

// ── start ────────────────────────────────────────────────────────────────────
function _collectSources(nodeIds) {
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
  const build = (n) => {
    if (!n || n.archived === true) return null;
    if (n.type === 'mesh') { const m = meshOf(n); if (!m) { skipped++; return null; } tris += geometryTriangles(m.geometry); parts++; return { kind: 'part', name: n.name || 'Part', mesh: m, node: n, uid: _uidOf(m) }; }
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
  const built = tops.map(n => ({ n, r: build(n) })).filter(x => x.r);
  let roots = built.map(x => x.r), rootSource = built.map(x => x.n.id);
  // One model on its own: its CONTENT is the tree — not one more folder around it, or
  // every re-edit of an asset would nest it one level deeper.
  if (built.length === 1 && built[0].n.type === 'model' && roots[0].kind === 'folder') { roots = roots[0].children; rootSource = roots.map(() => built[0].n.id); }
  return { roots, rootSource, tris, parts, skipped, name: tops.length === 1 ? (tops[0].name || 'poly-asset') : 'poly-asset' };
}

function _bakedPoly(src, rootInv) {
  const Th = T(); const mesh = src.mesh, node = src.node;
  let poly = null;
  if (node?.type === 'primitive' && node.primKind === 'poly' && isPoly(node.primParams)) poly = clonePoly(node.primParams);
  else if (isPoly(mesh.userData?.sbsPoly) && _sameExtent(mesh.userData.sbsPoly, mesh.geometry)) poly = clonePoly(mesh.userData.sbsPoly);   // a .glb this editor wrote: lossless
  else poly = geometryToPoly(mesh.geometry, { heal: geometryTriangles(mesh.geometry) <= 20000 });
  if (!poly) return null;
  mesh.updateWorldMatrix(true, false);
  const M = new Th.Matrix4().multiplyMatrices(rootInv, mesh.matrixWorld);
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

export async function startPolySession(nodeIds) {
  if (_s || _starting) { setStatus('The Poly Editor is already open — Apply or Discard first.', 'warn', 4000); return false; }
  if (state.get('_exporting')) { setStatus('Not while an export is running.', 'warn', 4000); return false; }
  _starting = true;                                        // the conversion below yields: a second start must not slip in
  try { return await _start(nodeIds); } finally { _starting = false; }
}

async function _start(nodeIds) {
  if (isPolyEditing()) exitPolyEdit();
  const plan = _collectSources(nodeIds);
  if (!plan.parts) { setStatus('Nothing in the selection has a mesh the Poly Editor can take.', 'warn', 5000); return false; }
  if (plan.tris > TRI_WARN && !confirm(`These ${plan.parts} objects have ${plan.tris.toLocaleString()} triangles. Converting and editing that much is slow.\n\nGo on?`)) return false;
  const Th = T();
  setStickyStatus(`⬚ Poly Editor — converting ${plan.parts} object${plan.parts === 1 ? '' : 's'}…`, 'info', 'polySession');
  await new Promise(r => setTimeout(r, 30));
  sceneCore.rootGroup.updateWorldMatrix(true, false);
  const rootInv = sceneCore.rootGroup.matrixWorld.clone().invert();
  const sess = {
    sid: ++_sidSeq, seq: 0, name: plan.name.replace(/\.[a-z0-9]+$/i, ''), items: new Map(), rootIds: [], sel: new Set(), primary: null,
    view: 'persp', space: 'world', subMode: null, sourceIds: [], group: new Th.Group(), prev: null, listeners: null, xf: null, fovPersp: sceneCore.camera?.fov || 35, edits: 0,
  };
  sess.group.name = 'PolyEditorSession';
  const newId = (p) => `${p}${(++sess.seq).toString(36)}`;
  const seenUid = new Set();
  const uidFor = (src) => { const u = src.uid && !seenUid.has(src.uid) ? src.uid : _newUid(); seenUid.add(u); return u; };   // a part that came from this editor keeps its id
  let done = 0, failed = 0;
  const add = async (src, parent) => {
    if (src.kind === 'folder') {
      const it = { id: newId('f'), kind: 'folder', name: src.name, parent, children: [], uid: uidFor(src) };
      sess.items.set(it.id, it);
      for (const c of src.children) { const cid = await add(c, it.id); if (cid) it.children.push(cid); }
      if (!it.children.length) { sess.items.delete(it.id); return null; }
      return it.id;
    }
    let poly = null;
    try { poly = _bakedPoly(src, rootInv); } catch (err) { console.warn('[poly session] conversion failed for', src.name, err); }
    done++;
    if (done % 5 === 0) { setStickyStatus(`⬚ Poly Editor — converting… ${done} / ${plan.parts}`, 'info', 'polySession'); await new Promise(r => setTimeout(r, 0)); }
    if (!poly) { failed++; return null; }
    // A preset-coloured mesh wears the app's falloff ShaderMaterial: its colour is the uColor uniform, not .color.
    const mat = Array.isArray(src.mesh.material) ? src.mesh.material[0] : src.mesh.material;
    const col = mat?.uniforms?.uColor?.value?.isColor ? mat.uniforms.uColor.value : (mat?.color?.isColor ? mat.color : null);
    const c = col ? [col.r, col.g, col.b] : [0.75, 0.79, 0.83];
    const it = { id: newId('p'), kind: 'part', name: src.name, parent, poly, color: c, mesh: null, uid: uidFor(src) };
    sess.items.set(it.id, it);
    return it.id;
  };
  const okSources = new Set();                             // only what really came in counts as an "original" at Apply
  for (let i = 0; i < plan.roots.length; i++) { const id = await add(plan.roots[i], null); if (id) { sess.rootIds.push(id); okSources.add(plan.rootSource[i]); } }
  sess.sourceIds = [...okSources];
  clearStickyStatus('polySession');
  if (![...sess.items.values()].some(it => it.kind === 'part')) { setStatus('None of those objects could be converted.', 'warn', 5000); return false; }
  _s = sess;
  for (const it of sess.items.values()) if (it.kind === 'part') _buildPartMesh(it);
  sceneCore.rootGroup.add(sess.group);
  _hideProject();
  _attachInput();
  const { openPolyEditorPanel } = await import('../ui/poly-editor-panel.js');
  openPolyEditorPanel();
  _emit('open');
  setPolyView('persp');
  _hint();
  setStatus(`Poly Editor: ${[...sess.items.values()].filter(i => i.kind === 'part').length} part(s)${failed ? `, ${failed} could not be converted` : ''}${plan.skipped ? `, ${plan.skipped} skipped (not meshes)` : ''}.`, failed ? 'warn' : 'success', 6000);
  return true;
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
  const prev = { keep: getIsolateKeepSet(), dom: [], cable: null, camera: sceneCore.getCameraState?.() || null, overlayEditing: false };
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
}

/**
 * how = 'discard' (everything as it was, an earlier isolate included) · 'applied' (no mask: the
 * new model must show) · 'project' (another project is already on screen: only our own DOM comes back).
 */
function _showProject(how = 'discard') {
  const prev = _s?.prev; if (!prev) return;
  for (const [el, d] of prev.dom) el.style.display = d;
  if (prev.cable) prev.cable.obj.visible = prev.cable.vis;   // the cables root outlives projects
  if (how === 'project') { clearIsolate(); return; }
  if (how === 'discard' && prev.keep) setIsolateKeepSet(prev.keep); else clearIsolate();
  try { actions.refreshIsolateView({ quiet: true }); } catch (err) { console.warn('[poly session] unmask', err); }
  if (prev.camera) { try { sceneCore.applyCameraState(prev.camera); } catch { /* keep the current view */ } }
  if (prev.overlayEditing) { try { overlaySetEditing(true); } catch { /* fine */ } }
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
  for (const r of snap.items) { const it = _s.items.get(r.id); if (!it) continue; it.name = r.name; it.parent = r.parent; if (it.kind === 'folder') it.children = r.children.slice(); else if (it.mesh) it.mesh.name = r.name; }
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
    const tops = order.filter(x => sel.has(x) && !_hasSelectedAncestor(x, sel));   // what gets wrapped: top-most only, in tree order
    const parent = tops.length ? (_s.items.get(tops[0]).parent || null) : null;
    const it = { id: `f${(++_s.seq).toString(36)}`, kind: 'folder', name: 'Folder', parent, children: [], uid: _newUid() };
    _s.items.set(it.id, it); id = it.id;
    const listOf = () => (parent ? _s.items.get(parent).children : _s.rootIds);
    let at = tops.length ? listOf().indexOf(tops[0]) : listOf().length;   // nothing selected before tops[0] sits in this list
    for (const x of tops) _detach(x);
    if (at < 0 || at > listOf().length) at = listOf().length;
    listOf().splice(at, 0, it.id);
    for (const x of tops) { _s.items.get(x).parent = it.id; it.children.push(x); }
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
    if (it.kind === 'folder') { const f = { id: nid, kind: 'folder', name: it.name, parent, children: [], uid: _newUid() }; _s.items.set(nid, f); f.children = it.children.map(c => copy(c, nid)); }
    else {
      const p = { id: nid, kind: 'part', name: `${it.name} copy`, parent, poly: clonePoly(it.poly), color: it.color.slice(), mesh: null, uid: _newUid() };   // a copy is a new object
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
        const c = box.getCenter(new Th.Vector3()), dir = new Th.Vector3(1, 0.75, 1).normalize();
        const pos = c.clone().addScaledVector(dir, Math.max(box.getSize(new Th.Vector3()).length(), 1) * 2);
        const q = new Th.Quaternion().setFromRotationMatrix(new Th.Matrix4().lookAt(pos, c, new Th.Vector3(0, 1, 0)));
        const fov = cam.fov < 5 ? (_s.fovPersp || 35) : cam.fov;
        sceneCore.applyCameraState({ position: [pos.x, pos.y, pos.z], quaternion: [q.x, q.y, q.z, q.w], pivot: [c.x, c.y, c.z], up: [0, 1, 0], fov, orbitPivot: null });
        if (fit) sceneCore.animateCameraTo(sceneCore.fitStateForBox(box, 1.3), 0);
      }
    } else {
      if (box && fit) sceneCore.animateCameraTo(sceneCore.fitStateForBox(box, 1.3), 0);   // frame it in the current lens …
      sceneCore.applyStandardView(view, 0);                                                // … then look along the axis, flat
    }
  } catch (err) { console.warn('[poly session] view', err); }
  _s.view = view;
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
    if (std) sceneCore.applyStandardView(std, 0);
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

const _target = {
  isPolySession: true,
  spaces: ['world', 'local'], defaultSpace: 'world',
  spaceLabel: (m) => (m === 'local' ? 'OBJECT' : 'WORLD'),
  onSpaceChange(m) { if (_s) _s.space = m; },
  getWorldPos() {
    if (!_s) return null;
    const Th = T(); const box = new Th.Box3();
    for (const id of _selectedPartIds()) { const m = _s.items.get(id)?.mesh; if (m) box.expandByObject(m); }
    return box.isEmpty() ? null : box.getCenter(new Th.Vector3());
  },
  getWorldQuat() {
    const Th = T(); const ids = _selectedPartIds();
    const m = _s?.items.get(ids.includes(_s?.primary) ? _s.primary : ids[0])?.mesh;
    return m ? m.getWorldQuaternion(new Th.Quaternion()) : new Th.Quaternion();
  },
  beginMove() { _xfBegin(); },
  applyCumulativeDelta(worldD) {
    const xf = _s?.xf; if (!xf) return;
    const d = worldD.clone().applyMatrix3(xf.rootInv3);
    for (const r of xf.rows) r.mesh.position.copy(r.pos).add(d);
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
    for (const r of xf.rows) { r.mesh.position.copy(r.pos).sub(xf.pivot).applyQuaternion(q).add(xf.pivot); r.mesh.quaternion.copy(q).multiply(r.quat); }
    sceneCore.requestRender?.(60);
  },
  commitRotate() { _xfCommit('Rotate part'); },
};

function _xfBegin() {
  if (!_s) return;
  const Th = T();
  sceneCore.rootGroup.updateWorldMatrix(true, false);
  const rootInv = sceneCore.rootGroup.matrixWorld.clone().invert();
  const pivotW = _target.getWorldPos() || new Th.Vector3();
  _s.xf = {
    rows: _selectedPartIds().map(id => { const m = _s.items.get(id).mesh; return { id, mesh: m, pos: m.position.clone(), quat: m.quaternion.clone() }; }),
    rootInv3: new Th.Matrix3().setFromMatrix4(rootInv), pivot: pivotW.clone().applyMatrix4(rootInv),
  };
}

function _xfCommit(label) {
  const xf = _s?.xf; if (!xf) return;
  _s.xf = null;
  const after = xf.rows.map(r => ({ mesh: r.mesh, pos: r.mesh.position.clone(), quat: r.mesh.quaternion.clone() }));
  const moved = xf.rows.some((r, i) => r.pos.distanceToSquared(after[i].pos) > 1e-12 || Math.abs(r.quat.dot(after[i].quat)) < 1 - 1e-12);
  if (!moved) return;
  const set = (rows) => { for (const r of rows) { r.mesh.position.copy(r.pos); r.mesh.quaternion.copy(r.quat); } };
  _push(xf.rows.length > 1 ? `${label}s` : label, () => set(xf.rows), () => set(after));
}

function _syncGizmo() {
  if (!_s || isPolyEditing()) return;
  const want = _selectedPartIds().length > 0;
  if (!want) { if (gizmo.activeTarget === _target && !gizmo.isDragging) gizmo.hide(); return; }
  if (gizmo.activeTarget !== _target) { gizmo.showForCableTarget(_target, 'all'); if (_s.space && _s.space !== gizmo.spaceMode) gizmo.setSpace(_s.space); }
}

// ── input (capture on the canvas / window, registered before the sub-object editor's) ──
const _typing = () => { const el = document.activeElement, tag = el?.tagName; return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable; };

function _attachInput() {
  const dom = sceneCore.renderer.domElement;
  const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); const a = document.activeElement; if (a && a !== document.body && _typing()) a.blur(); };
  const L = {
    down: (e) => {
      if (!_s || e.button !== 0) return;
      if (isPolyEditing()) return;                         // the sub-object editor's own listener (added later) takes it
      swallow(e);
      if (gizmo.activeTarget === _target && gizmo.onPointerDown(e.clientX, e.clientY, false)) { try { dom.setPointerCapture(e.pointerId); } catch { /* fine */ } return; }
      _clickSelect(_pickPart(e), e);
    },
    click: (e) => { if (_s) { e.preventDefault(); e.stopImmediatePropagation(); } },          // the app's click handler never runs here
    dbl: (e) => { if (!_s) return; e.preventDefault(); e.stopImmediatePropagation(); if (isPolyEditing()) return; const id = _pickPart(e); if (id) polyEnterSub('face', id); },
    menu: (e) => { if (_s) { e.preventDefault(); e.stopImmediatePropagation(); } },
    key: (e) => _onKey(e),
    mode: () => { if (_s) _emit('mode'); },
    std: (v) => { if (_s) { _s.view = v || 'persp'; _emit('view'); } },   // orbiting out of an axis view = perspective again
    loaded: () => _forceClose('Another project was opened — the Poly Editor was closed without applying.', 'project'),
    exp: () => { if (state.get('_exporting')) _forceClose('An export started — the Poly Editor was closed without applying.'); },
  };
  dom.addEventListener('pointerdown', L.down, true);
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
  if (keyMatches('gizmoSpace', e) && !mod && !e.altKey) { e.preventDefault(); gizmo.toggleSpace(); return; }
  if (keyMatches('fitView', e) && !mod && !e.altKey) { e.preventDefault(); polyFit(); return; }
  if (isPolyEditing()) return;                               // 1 / 4 / Esc / typed distances: the sub-object editor's
  if (mod && e.code === 'KeyD') { e.preventDefault(); e.stopImmediatePropagation(); polyDuplicateSelected(); return; }
  if (mod || e.altKey) return;
  if (keyMatches('polyVertices', e) || keyMatches('polyFaces', e)) { e.preventDefault(); e.stopImmediatePropagation(); polyEnterSub(keyMatches('polyVertices', e) ? 'vertex' : 'face'); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopImmediatePropagation(); polyDeleteSelected(); return; }
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (_s.sel.size) polySelect([]); return; }
}

function _hint() {
  if (!_s) return;
  setStickyStatus(`⬚ Poly Editor · click selects a part (Shift adds) · the gizmo moves / rotates it · ${keyLabel('polyVertices')} = vertices, ${keyLabel('polyFaces')} = faces (or double-click) · ${keyLabel('fitView')} = fit · Del deletes · Ctrl+D duplicates · arrange the tree on the left, then Apply`, 'info', 'polySession');
}

// ── the end ──────────────────────────────────────────────────────────────────
function _teardown(how = 'discard') {
  if (!_s) return;
  if (isPolyEditing()) exitPolyEdit();
  if (gizmo.activeTarget === _target) gizmo.hide();
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

/** The session tree → glTF node tree: folders = empty nodes, parts = meshes in model space (their session transform baked in). */
function _glbRoots() {
  const Th = T();
  sceneCore.rootGroup.updateWorldMatrix(true, true);
  const rootInv = sceneCore.rootGroup.matrixWorld.clone().invert();
  const node = (id) => {
    const it = _s.items.get(id);
    if (it.kind === 'folder') { const kids = it.children.map(node).filter(Boolean); return kids.length ? { name: it.name, children: kids, extras: { sbsId: it.uid || (it.uid = _newUid()) } } : null; }
    const M = new Th.Matrix4().multiplyMatrices(rootInv, it.mesh.matrixWorld);
    const baked = clonePoly(it.poly), v = new Th.Vector3();
    for (let i = 0; i < baked.v.length; i += 3) { v.set(baked.v[i], baked.v[i + 1], baked.v[i + 2]).applyMatrix4(M); baked.v[i] = v.x; baked.v[i + 1] = v.y; baked.v[i + 2] = v.z; }
    if (M.determinant() < 0) baked.f = baked.f.map(f => f.slice().reverse());
    const { positions, normals } = polyToArrays(baked);
    const indices = new Uint32Array(positions.length / 3); for (let i = 0; i < indices.length; i++) indices[i] = i;
    const r4 = (x) => Math.round(x * 1e5) / 1e5;
    return { name: it.name, mesh: { positions, normals, indices, color: it.color }, extras: { sbsId: it.uid || (it.uid = _newUid()), sbsPoly: { v: baked.v.map(r4), f: baked.f } } };
  };
  return _s.rootIds.map(node).filter(Boolean);
}

/** APPLY: write the tree as one .glb into the project, load it as a model, then settle the originals. */
export async function applyPolySession() {
  if (!_s) return false;
  if (_s.applying) return false;
  if (isPolyEditing()) exitPolyEdit();
  const roots = _glbRoots();
  if (!roots.length) { setStatus('There is nothing in the tree to save.', 'warn', 4000); return false; }
  _s.applying = true;
  const name = _safeName(_s.name), sourceIds = _s.sourceIds.slice();
  let written = null;
  try {
    const path = await _targetPath(name);
    if (!path) { _s.applying = false; return false; }
    setStickyStatus('⬚ Poly Editor — saving the asset…', 'info', 'polySession');
    const glb = sceneGlb({ roots, name, extras: { sbsPolyEditor: 1 } });
    const res = await window.sbsNative.writeFile(path, _b64(glb), 'base64');
    if (!res?.ok) throw new Error(res?.error || 'write failed');
    written = path;
    _teardown('applied');                                  // the project comes back (no isolate mask) before the new model lands in it
    const { importModelAtPath } = await import('../ui/sidebar-left.js');
    const modelNode = await importModelAtPath(path);
    if (!modelNode) throw new Error('the saved asset did not load back');
    setStatus(`Poly Editor: saved ${path.split(/[\\/]/).pop()} (${Math.round(glb.byteLength / 1024)} KB) and loaded it into the scene.`, 'success', 7000);
    const { askPolyOriginals } = await import('../ui/poly-editor-panel.js');
    await _settleOriginals(sourceIds, name, modelNode.id, askPolyOriginals);
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
