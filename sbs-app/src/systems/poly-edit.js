/**
 * ⬚ EDIT POLY — the interactive mode (V0.3.5.9, Phase 1 · V0.3.5.12, Phase 2).
 *
 * The 3ds Max editable-poly gestures on a 'poly' primitive, in the viewport:
 *   faces mode (4):   hover highlights · click selects · Shift / Ctrl + click adds or removes
 *                     · a drag that starts OFF the poly = box-select (Shift adds, Alt removes,
 *                       Ctrl = only faces fully inside) · a click off the poly = done
 *                     · drag = move the faces in the view plane
 *                     · the GIZMO at the selection's centre moves / rotates it along axes
 *                       (type a number during a gizmo drag = exact amount; L cycles the
 *                       axes: FACE (average normal) · WORLD · PARENT (the object's own frame));
 *                       Shift + a gizmo arrow = EXTRUDE along that axis
 *                     · Shift + drag = EXTRUDE along the normal, type a number = exact distance;
 *                       on release the block is JOINED (out) or CUT (in) — poly-csg.js
 *                     · Alt = loop-cut PREVIEW on the hovered edge · Alt + click = cut
 *   vertex mode (1):  dots on every vertex · drag one (Shift / Ctrl adds) · box-select · gizmo
 *   edge mode (2):    V0.3.5.45 — click an edge (Shift / Ctrl adds) · double-click = its LOOP ·
 *                     box-select · drag / gizmo moves · right-click ▸ Chamfer… (an amount, a live
 *                     preview; corners that meet are shown RED and welded on Apply)
 *   faces mode (3):   as above (was 4 before V0.3.5.45)
 *   element mode (4): V0.3.5.45 — a click takes the whole connected piece · Del deletes it
 *   Esc = cancel the gesture in flight, else done.
 *   Any face left with fewer than three corners after a gesture is removed (_tidy).
 *
 * The maths lives in poly-core.js; every finished gesture goes through
 * actions.setPrimitiveParams (one undo entry, persistence, the definition
 * registry, ★ on the steps that show it). Undo / redo while the mode is open
 * re-syncs the working copy from the node. During a drag the mesh geometry is
 * rewritten live from the working topology. Helpers (wire, highlights, dots,
 * the loop preview) are children of the mesh so they follow it; none raycasts.
 * The gizmo is the app's own (ui/gizmo.js) driven through a target object —
 * the same contract cable points and hand controls use — so numeric entry,
 * the space badge and the readout come for free.
 *
 * Keyboard order (window capture, registration order): ui/gizmo-numeric.js,
 * then main.js's shortcut handler, then this file — so while the gizmo drags,
 * gizmo-numeric owns every key and this file stays out of the way.
 */
import { state } from '../core/state.js';
import { sceneCore } from '../core/scene.js';
import { matches as keyMatches, keyLabel } from '../core/keymap.js';   // ⬚ V0.3.5.13 — 1 / 2 / 3 / 4 (rebindable) switch the sub-object level
import * as actions from './actions.js';
import { gizmo } from '../ui/gizmo.js';
import { parseExpression } from '../ui/gizmo-numeric.js';
import { showMarqueeBox, hideMarqueeBox } from '../ui/marquee-box.js';
import { setStatus, setStickyStatus, clearStickyStatus } from '../ui/status.js';
import { isPoly, makeBoxPoly, clonePoly, polyToArrays, polyEdges, extrudeFaces, loopCut, moveVertices, averageNormal, verticesOfFaces, extrusionPrism, facesOnCap, polyExtent, cleanEdges, weldPoly, faceNormal } from './poly-core.js';
import { booleanPoly, warmBooleanLib } from './poly-csg.js';   // ⬚ V0.3.5.11 — the Boolean on release
import { edgeKey, polyEdgeList, edgeLoop, chamferEdges } from './poly-edges.js';   // ⬚ V0.3.5.45 — the edge level
import { showContextMenu, hideContextMenu } from '../ui/context-menu.js';
import { staticMeshGlb } from '../io/glb-write.js';

const T = () => window.THREE;
let _ed = null;

export function isPolyEditing() { return !!_ed; }
export function polyEditNodeId() { return _ed?.host?.nodeId || null; }
export function polyEditHostKey() { return _ed?.host?.key || null; }
export function polyEditMode() { return _ed?.mode || null; }

// ⬚ V0.3.5.45 — the four levels (3ds Max's 1 / 2 / 3 / 4)
const MODES = ['vertex', 'edge', 'face', 'element'];
const NOUN = { vertex: 'vertices', edge: 'edges', face: 'faces', element: 'elements' };
const _levels = () => `${keyLabel('polyVertices')} vertices · ${keyLabel('polyEdges')} edges · ${keyLabel('polyFaces')} faces · ${keyLabel('polyElements')} elements`;

const _nodeOf = (id) => state.get('nodeById')?.get(id) || null;
const _isPolyNode = (node) => !!node && node.type === 'primitive' && node.primKind === 'poly';
const _polyOf = (node) => (isPoly(node?.primParams) ? clonePoly(node.primParams) : makeBoxPoly(20, 20, 20, node?.baseAtOrigin !== false));

/**
 * ⬚ V0.3.5.14 — the editor works on a HOST, not on a node: what owns the poly,
 * where the commit goes (undo included) and who tells us it changed under us.
 *   { key, nodeId?, mesh (getter), alive(), getPoly(), snapshot(), commit(poly, label, before),
 *     subscribe(fn) → unsubscribe, onEnter?(), onExit?(), onMissClick?(e) }
 * nodeHost = a project 'poly' primitive (actions.setPrimitiveParams); the Poly
 * Editor session supplies hosts for its own parts (poly-session.js).
 */
export function nodeHost(nodeId) {
  return {
    key: `node:${nodeId}`, nodeId,
    get mesh() { return _nodeOf(nodeId)?.object3d || null; },
    alive() { return _isPolyNode(_nodeOf(nodeId)); },
    getPoly() { const n = _nodeOf(nodeId); return _isPolyNode(n) ? _polyOf(n) : null; },
    snapshot() { return { ...(_nodeOf(nodeId)?.primParams || {}) }; },
    commit(poly, label, before) { actions.setPrimitiveParams(nodeId, { v: poly.v.slice(), f: poly.f.map(x => x.slice()) }, { undoLabel: label, before: before || null }); },
    subscribe(fn) {
      const undo = () => fn('undo'), tree = () => { if (!this.alive()) fn('gone'); };
      state.on('undo:applied', undo); state.on('change:treeData', tree);
      return () => { state.off?.('undo:applied', undo); state.off?.('change:treeData', tree); };
    },
    // V0.3.5.11 — the node is NOT left selected: the object gizmo would take the
    // pointer over the mesh, and a dozen listeners react to a selection change.
    onEnter() { state.setState({ selectedId: null, multiSelectedIds: new Set() }); },
  };
}

export function enterPolyEdit(nodeId, mode = 'face') {
  if (!_isPolyNode(_nodeOf(nodeId))) { setStatus('Edit poly works on a Poly box (right-click a box ▸ Convert to editable poly).', 'warn', 5000); return false; }
  return enterPolyEditHost(nodeHost(nodeId), mode);
}

export function enterPolyEditHost(host, mode = 'face') {
  if (!host?.alive?.()) { setStatus('Nothing to edit here.', 'warn', 4000); return false; }
  if (_ed) exitPolyEdit();
  const mesh = host.mesh;
  if (!mesh || !sceneCore.renderer) { setStatus('That poly has no mesh on screen yet.', 'warn', 4000); return false; }
  // The mode owns the gizmo (main.js leaves it alone while state.polyEditing is
  // set); a click that misses the poly ends the mode (and, for a project node,
  // goes on to select whatever it hit).
  host.onEnter?.();
  state.setState({ polyEditing: host.key });
  gizmo.hide();
  _ed = { host, mesh, poly: host.getPoly(), faceOfTri: null, mode: MODES.includes(mode) ? mode : 'face', selFaces: new Set(), selVerts: new Set(), selEdges: new Set(), hoverFace: -1, hoverVert: -1, hoverEdge: null, chamfer: null, helpers: null, drag: null, before: null, gz: null, marq: null, space: 'local', gizmoShift: false, swallowClick: false, previewKey: null, lastXY: null };
  _ed.faceOfTri = polyToArrays(_ed.poly).faceOfTri;
  _buildHelpers();
  const dom = sceneCore.renderer.domElement;
  const L = _ed.listeners = {
    down:  (e) => _onDown(e),
    move:  (e) => _onMove(e),
    up:    (e) => _onUp(e),
    key:   (e) => _onKey(e),
    keyup: (e) => { if (e.key === 'Alt') _clearPreview(); },
    click: (e) => { if (_ed?.swallowClick) { _ed.swallowClick = false; e.preventDefault(); e.stopImmediatePropagation(); } },
    dbl:   (e) => { if (polyEditDoubleClick(e)) { e.preventDefault(); e.stopImmediatePropagation(); } },
    menu:  (e) => { if (polyEditContextMenu(e)) { e.preventDefault(); e.stopImmediatePropagation(); } },
    step:  () => exitPolyEdit(),
    exp:   () => { if (state.get('_exporting')) exitPolyEdit(); },
  };
  _ed.unsubscribe = host.subscribe?.((why) => { if (!_ed || _ed.committing) return; if (why === 'gone' || !host.alive()) exitPolyEdit(); else _resyncFromNode(); }) || null;
  dom.addEventListener('pointerdown', L.down, true);
  dom.addEventListener('pointermove', L.move, true);
  dom.addEventListener('click', L.click, true);
  dom.addEventListener('dblclick', L.dbl, true);
  dom.addEventListener('contextmenu', L.menu, true);
  window.addEventListener('pointerup', L.up, true);
  window.addEventListener('keydown', L.key, true);
  window.addEventListener('keyup', L.keyup, true);
  state.on('change:activeStepId', L.step);
  state.on('change:_exporting', L.exp);
  _hint();
  warmBooleanLib().catch(() => {});                     // the wasm is ready by the first release
  sceneCore.requestRender?.(200);
  return true;
}

export function exitPolyEdit() {
  if (!_ed) return;
  const { listeners: L, drag } = _ed;
  if (gizmo.isDragging && gizmo.activeTarget === _target) {   // a gizmo gesture in flight: ended cleanly (readout off, lock off, no commit)
    try { gizmo.revertToDragStart(); gizmo.setNumericLock(false); gizmo._dragMoved = true; gizmo.onPointerUp(); } catch { /* best effort */ }
  }
  if (_ed.chamfer) _chamferEnd(false);                                    // a chamfer on show: the mesh goes back as it was
  if (drag) { _ed.poly = drag.preGesture || drag.start; _applyLive(); }   // a mouse gesture in flight is abandoned
  if (_ed.gz) { _ed.poly = _ed.gz.pre || _ed.gz.start; _ed.gz = null; _applyLive(); }
  if (_ed.marq) { _ed.marq = null; hideMarqueeBox(); }
  if (gizmo.activeTarget === _target) gizmo.hide();
  const dom = sceneCore.renderer?.domElement;
  try {
    dom?.removeEventListener('pointerdown', L.down, true);
    dom?.removeEventListener('pointermove', L.move, true);
    dom?.removeEventListener('click', L.click, true);
    dom?.removeEventListener('dblclick', L.dbl, true);
    dom?.removeEventListener('contextmenu', L.menu, true);
    window.removeEventListener('pointerup', L.up, true);
    window.removeEventListener('keydown', L.key, true);
    window.removeEventListener('keyup', L.keyup, true);
    state.off?.('change:activeStepId', L.step);
    state.off?.('change:_exporting', L.exp);
    _ed.unsubscribe?.();
  } catch { /* listeners already gone */ }
  _disposeHelpers();
  if (dom) dom.style.cursor = '';
  const host = _ed.host;
  _ed = null;
  clearStickyStatus('polyEdit'); clearStickyStatus('polyGesture');
  if (state.get('polyEditing')) state.setState({ polyEditing: null });
  try { host.onExit?.(); } catch { /* the host's business */ }
  sceneCore.requestRender?.(200);
}

/** "Clean edges": coplanar neighbours merged, straight-through vertices dropped (undoable; works in or out of the mode). */
export function cleanPolyEdges(nodeId) { return _isPolyNode(_nodeOf(nodeId)) ? cleanPolyEdgesHost(nodeHost(nodeId)) : false; }
export function cleanPolyEdgesHost(host) {
  if (!host?.alive?.()) return false;
  const mine = _ed && _ed.host.key === host.key;
  if (mine && _ed.drag) _cancelDrag();
  const p = host.getPoly(), c = cleanEdges(p);
  if (c.f.length === p.f.length && c.v.length === p.v.length) { setStatus('Nothing to clean — every edge bends the surface.', 'info', 3500); return false; }
  const before = host.snapshot();
  if (mine) _ed.committing = true;
  try { host.commit(c, 'Clean edges', before); } finally { if (mine && _ed) _ed.committing = false; }
  if (mine) _resyncFromNode();
  setStatus(`Edges cleaned: ${p.f.length} → ${c.f.length} faces.`, 'success', 4000);
  return true;
}

/** Undo / redo (or Clean edges) changed the node under the mode: start again from what the node has. */
function _resyncFromNode() {
  if (!_ed) return;
  const host = _ed.host;
  if (!host.alive()) { exitPolyEdit(); return; }       // undone past "Convert to editable poly": a box again
  if (_ed.chamfer) _chamferEnd(false, true);             // the shape under it changed: the preview is void
  _ed.drag = null; _ed.gz = null; _ed.before = null;
  if (_ed.marq) { _ed.marq = null; hideMarqueeBox(); }
  clearStickyStatus('polyGesture');
  const mesh = host.mesh;
  if (mesh && mesh !== _ed.mesh) { _ed.mesh = mesh; _buildHelpers(); }
  const old = _ed.poly;
  _ed.poly = host.getPoly();
  // ⬚ V0.3.5.47 (diagnostic C3) — the picks are NUMBERS: after an undo / redo / Clean edges that renumbered the
  // vertices or faces (a chamfer, a delete, a merge) they would name other ones — the gizmo jumped there and the
  // next drag moved them. They survive only when the topology is the same (a moved vertex: yes).
  const same = !!old && old.v.length === _ed.poly.v.length && old.f.length === _ed.poly.f.length
    && old.f.every((f, i) => { const g = _ed.poly.f[i]; return f.length === g.length && f.every((x, k) => x === g[k]); });
  if (!same) { _ed.selFaces = new Set(); _ed.selVerts = new Set(); _ed.selEdges = new Set(); }
  _ed.selFaces = new Set([..._ed.selFaces].filter(i => i < _ed.poly.f.length));
  _ed.selVerts = new Set([..._ed.selVerts].filter(i => i < _ed.poly.v.length / 3));
  const live = new Set(_edgeList().map(x => x.key));
  _ed.selEdges = new Set([..._ed.selEdges].filter(k => live.has(k)));
  _ed.hoverFace = -1; _ed.hoverVert = -1; _ed.hoverEdge = null;
  _clearPreview();
  _applyLive();                                         // the mesh may still show an abandoned gesture
  _syncGizmo();
}

// ── helpers on the mesh ──────────────────────────────────────────────────────
function _buildHelpers() {
  const Th = T(); const { mesh } = _ed;
  _disposeHelpers();
  const grp = new Th.Group(); grp.name = 'polyEditHelpers'; grp.userData.isHelper = true; grp.raycast = () => {};
  const noPick = (o) => { o.raycast = () => {}; o.userData.isHelper = true; return o; };
  const wire = noPick(new Th.LineSegments(new Th.BufferGeometry(), new Th.LineBasicMaterial({ color: 0x9fd3ff, transparent: true, opacity: 0.9 })));
  wire.renderOrder = 9610;                               // ⬚ V0.3.5.37 — after the reference pictures (9000+, even the ones drawn over the model): the edges always show
  const faceMat = () => new Th.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.4, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: Th.DoubleSide, depthWrite: false });
  const selM = noPick(new Th.Mesh(new Th.BufferGeometry(), faceMat()));
  const hovM = noPick(new Th.Mesh(new Th.BufferGeometry(), faceMat()));
  selM.renderOrder = 9605; hovM.renderOrder = 9606;
  hovM.material.color.set(0xfbbf24); hovM.material.opacity = 0.3;
  const pts = noPick(new Th.Points(new Th.BufferGeometry(), new Th.PointsMaterial({ size: 9, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true })));
  pts.renderOrder = 9611;
  const loop = noPick(new Th.Line(new Th.BufferGeometry(), new Th.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.95, depthTest: false })));
  loop.renderOrder = 9612; loop.visible = false;
  // ⬚ V0.3.5.45 — the edge level: the picked edges (orange, seen through the body too: a loop goes round the back),
  // the one under the cursor (yellow), and RED dots where a chamfer's corners meet (they will be welded)
  const edgeSel = noPick(new Th.LineSegments(new Th.BufferGeometry(), new Th.LineBasicMaterial({ color: 0xf97316, transparent: true, opacity: 1, depthTest: false })));
  const edgeHov = noPick(new Th.LineSegments(new Th.BufferGeometry(), new Th.LineBasicMaterial({ color: 0xfde047, transparent: true, opacity: 1, depthTest: false })));
  edgeSel.renderOrder = 9613; edgeHov.renderOrder = 9614;
  const warn = noPick(new Th.Points(new Th.BufferGeometry(), new Th.PointsMaterial({ color: 0xef4444, size: 11, sizeAttenuation: false, depthTest: false, transparent: true })));
  warn.renderOrder = 9615; warn.visible = false;
  grp.add(wire, selM, hovM, pts, loop, edgeSel, edgeHov, warn);
  mesh.add(grp);
  _ed.helpers = { grp, wire, selM, hovM, pts, loop, edgeSel, edgeHov, warn };
  _refreshHelpers();
}

function _disposeHelpers() {
  const h = _ed?.helpers;
  if (!h) return;
  try {
    h.grp.parent?.remove(h.grp);
    for (const o of [h.wire, h.selM, h.hovM, h.pts, h.loop, h.edgeSel, h.edgeHov, h.warn]) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
  } catch { /* already gone */ }
  _ed.helpers = null;
}

function _facesGeometry(ids) {
  const Th = T(); const { poly } = _ed;
  const g = new Th.BufferGeometry();
  const f = [...ids].filter(i => i >= 0 && i < poly.f.length).map(i => poly.f[i]);
  if (!f.length) return g;
  const { positions, normals } = polyToArrays({ v: poly.v, f });
  g.setAttribute('position', new Th.BufferAttribute(positions, 3));
  g.setAttribute('normal', new Th.BufferAttribute(normals, 3));
  return g;
}

function _edgesGeometry(keys) {
  const Th = T(); const { poly } = _ed; const n = poly.v.length / 3;
  const pos = [];
  for (const k of keys) {
    const [a, b] = k.split('-').map(Number);
    if (!(a < n && b < n)) continue;
    pos.push(poly.v[a * 3], poly.v[a * 3 + 1], poly.v[a * 3 + 2], poly.v[b * 3], poly.v[b * 3 + 1], poly.v[b * 3 + 2]);
  }
  const g = new Th.BufferGeometry();
  g.setAttribute('position', new Th.BufferAttribute(new Float32Array(pos), 3));
  return g;
}

function _refreshHelpers() {
  if (!_ed?.helpers) return;
  const Th = T(); const { poly, helpers: h, selFaces, hoverFace, selVerts, hoverVert, mode } = _ed;
  const faceLike = mode === 'face' || mode === 'element';
  h.wire.geometry.dispose(); h.wire.geometry = new Th.BufferGeometry();
  h.wire.geometry.setAttribute('position', new Th.BufferAttribute(polyEdges(poly), 3));
  // a chamfer on show: its new bevel faces are highlighted (the picked edges' vertex numbers no longer apply to the preview)
  const bevel = _ed.chamfer?.res?.poly ? (_ed.chamfer.res.newFaceIds || []) : null;
  h.selM.geometry.dispose(); h.selM.geometry = _facesGeometry(bevel || selFaces); h.selM.visible = faceLike || !!bevel;
  const hov = hoverFace >= 0 && !selFaces.has(hoverFace) ? (mode === 'element' ? _elementFaces(hoverFace) : [hoverFace]) : [];
  h.hovM.geometry.dispose(); h.hovM.geometry = _facesGeometry(hov); h.hovM.visible = faceLike;
  const edges = mode === 'edge' && !_ed.chamfer;
  h.edgeSel.geometry.dispose(); h.edgeSel.geometry = _edgesGeometry(edges ? _ed.selEdges : []); h.edgeSel.visible = edges;
  h.edgeHov.geometry.dispose(); h.edgeHov.geometry = _edgesGeometry(edges && _ed.hoverEdge && !_ed.selEdges.has(_ed.hoverEdge) ? [_ed.hoverEdge] : []); h.edgeHov.visible = edges;
  const n = poly.v.length / 3, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = selVerts.has(i), hv = i === hoverVert;
    col[i * 3] = s ? 0.22 : hv ? 0.98 : 0.85; col[i * 3 + 1] = s ? 0.74 : hv ? 0.75 : 0.9; col[i * 3 + 2] = s ? 0.97 : hv ? 0.14 : 1.0;
  }
  h.pts.geometry.dispose(); h.pts.geometry = new Th.BufferGeometry();
  h.pts.geometry.setAttribute('position', new Th.BufferAttribute(new Float32Array(poly.v), 3));
  h.pts.geometry.setAttribute('color', new Th.BufferAttribute(col, 3));
  h.pts.visible = mode === 'vertex';
  sceneCore.requestRender?.(60);
}

/** The mesh geometry rewritten from the working topology (a drag in progress, a cut just made). */
function _applyLive() {
  const Th = T(); const { mesh, poly } = _ed;
  const { positions, normals, faceOfTri } = polyToArrays(poly);
  const g = mesh.geometry;
  if (g?.attributes?.position && g.attributes.position.array.length === positions.length) {
    g.attributes.position.array.set(positions); g.attributes.position.needsUpdate = true;
    g.attributes.normal.array.set(normals);     g.attributes.normal.needsUpdate = true;
  } else {
    const ng = new Th.BufferGeometry();
    ng.setAttribute('position', new Th.BufferAttribute(positions, 3));
    ng.setAttribute('normal', new Th.BufferAttribute(normals, 3));
    ng.userData.isPoly = true;
    g?.dispose?.();
    mesh.geometry = ng;
  }
  mesh.geometry.userData.faceOfTri = faceOfTri;
  mesh.geometry.computeBoundingBox(); mesh.geometry.computeBoundingSphere();
  _ed.faceOfTri = faceOfTri;
  _refreshHelpers();
}

/**
 * ⬚ V0.3.5.45 — his rule: a face needs at least three corners. Repeated corners
 * (a corner welded onto its neighbour) are merged; a face left with fewer than
 * three distinct corners is removed. Index-based only: nothing is welded here.
 */
function _tidy(p) {
  let dropped = 0;
  const f = [];
  for (const face of p.f) {
    const g = face.filter((x, i) => x !== face[(i + 1) % face.length]);
    if (new Set(g).size < 3) { dropped++; continue; }
    f.push(g);
  }
  return dropped || f.some((g, i) => g.length !== p.f[i]?.length) ? { poly: { v: p.v, f }, dropped } : { poly: p, dropped: 0 };
}

/** Vertices no face uses any more are taken out (indices renumbered). */
function _compact(p) {
  const n = p.v.length / 3, map = new Int32Array(n).fill(-1), v = [];
  for (const face of p.f) for (const i of face) if (map[i] < 0) { map[i] = v.length / 3; v.push(p.v[i * 3], p.v[i * 3 + 1], p.v[i * 3 + 2]); }
  return { v, f: p.f.map(face => face.map(i => map[i])) };
}

/** The gesture is over: one undo entry through the primitive machinery. */
function _commit(label) {
  const td = _tidy(_ed.poly);
  if (td.poly !== _ed.poly) {
    _ed.poly = td.poly;
    if (td.dropped) { _ed.selFaces = new Set(); _ed.hoverFace = -1; }   // the face numbers moved
    _applyLive();
    if (td.dropped) setStatus(`${td.dropped} face${td.dropped === 1 ? '' : 's'} left with fewer than 3 corners — removed.`, 'info', 4500);
  }
  const { host, poly, before } = _ed;
  _ed.committing = true;
  try { host.commit(poly, label, before || null); } finally { if (_ed) _ed.committing = false; }
  if (!_ed) return;
  _ed.before = null;
  const mesh = host.mesh;
  if (mesh && mesh !== _ed.mesh) { _ed.mesh = mesh; _buildHelpers(); }   // a full rebuild swapped the mesh
  _ed.poly = host.getPoly();
  _ed.faceOfTri = polyToArrays(_ed.poly).faceOfTri;
  _refreshHelpers();
  _syncGizmo();
}

// ── picking ──────────────────────────────────────────────────────────────────
/** A ray against THIS mesh only (the whole-scene pick cost 10s of ms on a CAD scene, per pointermove). */
function _hitFace(e) {
  const Th = T(); const rect = sceneCore.renderer.domElement.getBoundingClientRect();
  const rc = _ed.rc || (_ed.rc = new Th.Raycaster());
  rc.setFromCamera(new Th.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), sceneCore.camera);
  const h = rc.intersectObject(_ed.mesh, false)[0];
  if (!h || h.faceIndex == null) return { hit: null, face: -1 };
  const fi = _ed.faceOfTri?.[h.faceIndex];
  return { hit: h, face: fi == null ? -1 : fi };
}
const _onPoly = (e) => (_ed.mode === 'vertex' ? _nearestVertex(e) >= 0 : _ed.mode === 'edge' ? !!_edgeAt(e) : _hitFace(e).face >= 0);

/** Every edge once (cached for the poly in hand — a drag replaces the poly, so the cache follows). */
function _edgeList() {
  if (_ed.edgeFor !== _ed.poly) { _ed.edgeFor = _ed.poly; _ed.edges = polyEdgeList(_ed.poly); }
  return _ed.edges;
}

/** Which piece each face belongs to: faces that share a vertex are one ELEMENT (cached like the edges). */
function _faceElements() {
  const p = _ed.poly;
  if (_ed.elemFor === p) return _ed.elem;
  const n = p.v.length / 3, par = new Int32Array(n);
  for (let i = 0; i < n; i++) par[i] = i;
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (const f of p.f) for (let k = 1; k < f.length; k++) { const a = find(f[0]), b = find(f[k]); if (a !== b) par[a] = b; }
  _ed.elemFor = p; _ed.elem = p.f.map(f => find(f[0]));
  return _ed.elem;
}
function _elementFaces(fi) {
  const el = _faceElements(), r = el[fi], out = [];
  if (r == null) return out;
  for (let i = 0; i < el.length; i++) if (el[i] === r) out.push(i);
  return out;
}
/** The selected faces grown to their whole elements. */
function _growToElements(ids) {
  const el = _faceElements(), roots = new Set([...ids].filter(i => i < el.length).map(i => el[i]));
  const out = new Set();
  for (let i = 0; i < el.length; i++) if (roots.has(el[i])) out.add(i);
  return out;
}

/** The edge under the cursor: the nearest edge of the face hit (within 14 px), else a silhouette edge within 7 px. */
function _edgeAt(e) {
  const p = _ed.poly, { face } = _hitFace(e);
  if (face >= 0) {
    const { k, d } = _nearestEdge(e, face);
    if (d > 14 * 14) return null;
    const f = p.f[face];
    return edgeKey(f[k], f[(k + 1) % f.length]);
  }
  const list = _edgeList();
  if (list.length > 60000) return null;                  // a huge mesh: only the faces' own edges (no scan per mouse move)
  let best = null, bd = 49;
  for (const ed of list) {
    const A = _toScreen([p.v[ed.a * 3], p.v[ed.a * 3 + 1], p.v[ed.a * 3 + 2]]), B = _toScreen([p.v[ed.b * 3], p.v[ed.b * 3 + 1], p.v[ed.b * 3 + 2]]);
    if (A.z > 1 || B.z > 1) continue;
    const dx = B.x - A.x, dy = B.y - A.y, len2 = dx * dx + dy * dy || 1;
    const s = Math.max(0, Math.min(1, ((e.clientX - A.x) * dx + (e.clientY - A.y) * dy) / len2));
    const dd = (A.x + dx * s - e.clientX) ** 2 + (A.y + dy * s - e.clientY) ** 2;
    if (dd < bd) { bd = dd; best = ed.key; }
  }
  return best;
}
const _edgeVerts = (keys) => [...new Set([...keys].flatMap(k => k.split('-').map(Number)))].filter(i => i < _ed.poly.v.length / 3);

function _toScreen(local) {
  const Th = T(); const cam = sceneCore.camera; const rect = sceneCore.renderer.domElement.getBoundingClientRect();
  const v = new Th.Vector3(local[0], local[1], local[2]).applyMatrix4(_ed.mesh.matrixWorld).project(cam);
  return { x: (v.x + 1) / 2 * rect.width + rect.left, y: (1 - v.y) / 2 * rect.height + rect.top, z: v.z };
}

function _nearestVertex(e, maxPx = 12) {
  const { poly } = _ed; let best = -1, bd = maxPx * maxPx;
  for (let i = 0; i < poly.v.length / 3; i++) {
    const s = _toScreen([poly.v[i * 3], poly.v[i * 3 + 1], poly.v[i * 3 + 2]]);
    if (s.z > 1) continue;
    const d = (s.x - e.clientX) ** 2 + (s.y - e.clientY) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** The edge of `face` nearest the pointer on screen → { k, t } (edge index, parameter along it). */
function _nearestEdge(e, face) {
  const { poly } = _ed; const f = poly.f[face];
  let best = { k: 0, t: 0.5, d: Infinity };
  for (let k = 0; k < f.length; k++) {
    const a = f[k], b = f[(k + 1) % f.length];
    const A = _toScreen([poly.v[a * 3], poly.v[a * 3 + 1], poly.v[a * 3 + 2]]), B = _toScreen([poly.v[b * 3], poly.v[b * 3 + 1], poly.v[b * 3 + 2]]);
    const dx = B.x - A.x, dy = B.y - A.y, len2 = dx * dx + dy * dy || 1;
    let t = ((e.clientX - A.x) * dx + (e.clientY - A.y) * dy) / len2; t = Math.max(0.05, Math.min(0.95, t));
    const px = A.x + dx * t, py = A.y + dy * t;
    const d = (px - e.clientX) ** 2 + (py - e.clientY) ** 2;
    if (d < best.d) best = { k, t, d };
  }
  return best;
}

/** Mouse movement (pixels) → a LOCAL-space vector at the depth of `anchorWorld`, in the view plane. */
function _localDeltaForPixels(dxPx, dyPx, anchorWorld) {
  const Th = T(); const cam = sceneCore.camera; const rect = sceneCore.renderer.domElement.getBoundingClientRect();
  const ndc = anchorWorld.clone().project(cam);
  const a = new Th.Vector3(ndc.x, ndc.y, ndc.z).unproject(cam);
  const b = new Th.Vector3(ndc.x + dxPx * 2 / rect.width, ndc.y - dyPx * 2 / rect.height, ndc.z).unproject(cam);
  const world = b.sub(a);
  return { world, local: world.clone().applyMatrix3(new Th.Matrix3().setFromMatrix4(_ed.mesh.matrixWorld.clone().invert())) };
}

// ── extrude regions ──────────────────────────────────────────────────────────
/**
 * ⬚ V0.3.5.47 (diagnostic C4) — the selected faces split into separate REGIONS (faces sharing a corner are one),
 * each with its own normal — Max's group extrude. One averaged direction for all of them cancelled out for
 * opposite faces (the top and the bottom of a box: it fell back to +Y), and the result on release differed
 * from the preview. Now each region grows along its own normal by the same amount.
 */
function _capGroups(p, ids) {
  const list = [...ids].filter(i => i < p.f.length);
  const par = new Map();
  const find = (x) => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
  for (const fi of list) for (const v of p.f[fi]) if (!par.has(v)) par.set(v, v);
  for (const fi of list) { const f = p.f[fi]; for (let k = 1; k < f.length; k++) { const a = find(f[0]), b = find(f[k]); if (a !== b) par.set(a, b); } }
  const by = new Map();
  for (const fi of list) { const r = find(p.f[fi][0]); if (!by.has(r)) by.set(r, []); by.get(r).push(fi); }
  return [...by.values()].map(g => ({ ids: g, n: averageNormal(p, g) }));
}
/** Every region's cap moved along its own normal by `dist` (the poly's own units). */
function _moveGroups(start, groups, dist) {
  let p = start;
  for (const g of groups) p = moveVertices(p, g.verts, [g.n[0] * dist, g.n[1] * dist, g.n[2] * dist]);
  return p;
}

// ── the gizmo (the app's own, through a target) ──────────────────────────────
const _selVertexIds = () => (!_ed ? [] : _ed.mode === 'vertex' ? [..._ed.selVerts] : _ed.mode === 'edge' ? _edgeVerts(_ed.selEdges) : verticesOfFaces(_ed.poly, [..._ed.selFaces].filter(i => i < _ed.poly.f.length)));

function _centroidWorld(ids, poly = _ed.poly) {
  const Th = T(); const c = new Th.Vector3();
  if (!ids.length) return c;
  for (const i of ids) c.add(new Th.Vector3(poly.v[i * 3], poly.v[i * 3 + 1], poly.v[i * 3 + 2]));
  return c.multiplyScalar(1 / ids.length).applyMatrix4(_ed.mesh.matrixWorld);
}

/** A world quaternion whose +Z is `nWorld`; X follows the object's own X as far as it can. */
function _frameFromNormal(nWorld) {
  const Th = T();
  const z = nWorld.clone().normalize();
  let hint = new Th.Vector3(1, 0, 0).transformDirection(_ed.mesh.matrixWorld);
  if (Math.abs(hint.dot(z)) > 0.9) hint = new Th.Vector3(0, 1, 0).transformDirection(_ed.mesh.matrixWorld);
  const x = new Th.Vector3().crossVectors(hint, z).normalize();
  if (x.lengthSq() < 1e-9) x.set(1, 0, 0);
  const y = new Th.Vector3().crossVectors(z, x).normalize();
  return new Th.Quaternion().setFromRotationMatrix(new Th.Matrix4().makeBasis(x, y, z));
}

const _target = {
  isPoly: true,
  spaces: ['world', 'parent', 'local'],                    // his order (V0.3.5.20)
  defaultSpace: 'local',
  spaceLabel: (m) => (m === 'local' ? 'LOCAL' : m === 'parent' ? 'PARENT' : 'WORLD'),   // local = the selected faces' normal · parent = the object
  panelNudge: true,                                        // ⬚ V0.3.5.19 — right-click the gizmo: move / rotate by a typed amount
  panelTitle: () => ({ vertex: 'Vertices', edge: 'Edges', face: 'Faces', element: 'Elements' }[_ed?.mode] || 'Faces'),
  panelHint: () => "LOCAL = the selected faces' normal · PARENT = the object's own axes.",
  // where the selection's middle is: from the world's origin, or from the object's own pivot (parent)
  panelFrame(mode) {
    const Th = T(); if (!_ed || mode === 'local') return null;
    const w = _ed.host.worldFrame?.() || null;              // a host may have a world of its own (the Poly Editor: the asset)
    if (mode === 'parent') return { pos: _ed.mesh.getWorldPosition(new Th.Vector3()), quat: _ed.mesh.getWorldQuaternion(new Th.Quaternion()), scale: w?.scale || 1, name: 'the object' };
    return w || { pos: new Th.Vector3(), quat: new Th.Quaternion(), name: 'the world' };
  },
  worldQuat() { return _ed?.host?.worldFrame?.()?.quat || null; },
  panelUnit() { return _ed?.host?.worldFrame?.()?.scale || 1; },
  onSpaceChange(mode) { if (_ed) _ed.space = mode; },   // the user's choice (L / the badge) survives hide + show
  getWorldPos() { return _ed ? _centroidWorld(_selVertexIds()) : null; },
  getWorldQuat(mode = 'local') {
    const Th = T(); if (!_ed) return new Th.Quaternion();
    const parentQ = _ed.mesh.getWorldQuaternion(new Th.Quaternion());
    if (mode === 'parent' || _ed.mode !== 'face' || !_ed.selFaces.size) return parentQ;
    const n = averageNormal(_ed.poly, [..._ed.selFaces].filter(i => i < _ed.poly.f.length));
    return _frameFromNormal(new Th.Vector3(n[0], n[1], n[2]).transformDirection(_ed.mesh.matrixWorld));
  },
  beginMove()   { _gzBegin('move'); },
  applyCumulativeDelta(worldD) {
    const gz = _ed?.gz; if (!gz) return;
    const Th = T();
    const d = worldD.clone().applyMatrix3(new Th.Matrix3().setFromMatrix4(gz.inv));
    gz.delta = [d.x, d.y, d.z];
    if (gz.groups?.length > 1) { const n = gz.normalLocal; _ed.poly = _moveGroups(gz.start, gz.groups, d.x * n[0] + d.y * n[1] + d.z * n[2]); }   // separate regions: each along its own normal
    else _ed.poly = moveVertices(gz.start, gz.ids, gz.delta);
    _applyLive();
  },
  commitMove()  { _gzCommit(`Move ${NOUN[_ed?.mode] || 'faces'}`); },
  hasRotate: true,
  beginRotate() { _gzBegin('rotate'); },
  applyRotateAroundAxis(worldAxis, rad) {
    const gz = _ed?.gz; if (!gz) return;
    const Th = T();
    const q = new Th.Quaternion().setFromAxisAngle(worldAxis.clone().normalize(), rad);
    const p = clonePoly(gz.start), v = new Th.Vector3();
    for (const i of gz.ids) {
      v.set(gz.start.v[i * 3], gz.start.v[i * 3 + 1], gz.start.v[i * 3 + 2]).applyMatrix4(gz.mw).sub(gz.pivot).applyQuaternion(q).add(gz.pivot).applyMatrix4(gz.inv);
      p.v[i * 3] = v.x; p.v[i * 3 + 1] = v.y; p.v[i * 3 + 2] = v.z;
    }
    _ed.poly = p;
    _applyLive();
  },
  commitRotate() { _gzCommit(`Rotate ${NOUN[_ed?.mode] || 'faces'}`); },
};

/** A gizmo gesture starts. Shift on an arrow in faces mode = EXTRUDE along that axis (the ring is built now, the Boolean runs on release). */
function _gzBegin(kind) {
  if (!_ed) return;
  _clearPreview();
  const extrude = kind === 'move' && _ed.gizmoShift && _ed.mode === 'face' && _ed.selFaces.size > 0;
  _ed.gizmoShift = false;
  _ed.before = _ed.host.snapshot();
  const pre = clonePoly(_ed.poly);
  if (extrude) {
    const capIds = [..._ed.selFaces].filter(i => i < _ed.poly.f.length);
    const groups = _capGroups(_ed.poly, capIds);
    if (groups.length > 1) {                                       // regions facing opposite ways have no common arrow to pull along
      let sx = 0, sy = 0, sz = 0; for (const fi of capIds) { const n = faceNormal(_ed.poly, fi); sx += n[0]; sy += n[1]; sz += n[2]; }
      if (Math.hypot(sx, sy, sz) / capIds.length < 0.3) {
        setStatus('Those faces point opposite ways — Shift + drag one of them instead: each region then grows along its own normal.', 'info', 7000);
        _ed.gz = { kind: 'move', ids: [], pre, start: pre, pivot: _centroidWorld(_selVertexIds()), mw: _ed.mesh.matrixWorld.clone(), inv: _ed.mesh.matrixWorld.clone().invert(), delta: [0, 0, 0] };
        return;
      }
    }
    const ex = extrudeFaces(_ed.poly, capIds);
    for (const g of groups) g.verts = verticesOfFaces(ex.poly, g.ids);
    _ed.poly = ex.poly; _ed.selFaces = new Set(ex.capIds);
    _ed.gz = { kind: 'extrude', ids: ex.capVertexIds, capIds, groups, sides: ex.sideIds.length, normalLocal: averageNormal(ex.poly, ex.capIds), pre, start: clonePoly(ex.poly), pivot: _centroidWorld(ex.capVertexIds, ex.poly), mw: _ed.mesh.matrixWorld.clone(), inv: _ed.mesh.matrixWorld.clone().invert(), delta: [0, 0, 0] };
    _applyLive();
    return;
  }
  const ids = _selVertexIds();
  _ed.gz = { kind, ids, pre, start: pre, pivot: _centroidWorld(ids), mw: _ed.mesh.matrixWorld.clone(), inv: _ed.mesh.matrixWorld.clone().invert(), delta: [0, 0, 0] };
}

function _gzCommit(label) {
  const gz = _ed?.gz; if (!gz) return;
  _ed.gz = null; _ed.gzEndedAt = performance.now();
  let moved = false;
  for (let i = 0; i < _ed.poly.v.length && !moved; i++) if (Math.abs(_ed.poly.v[i] - gz.start.v[i]) > 1e-9) moved = true;
  if (!moved) { _ed.poly = gz.pre; _ed.selFaces = new Set([..._ed.selFaces].filter(i => i < _ed.poly.f.length)); _ed.before = null; _applyLive(); _syncGizmo(); return; }
  if (gz.kind === 'extrude') {
    const n = gz.normalLocal, dist = gz.delta[0] * n[0] + gz.delta[1] * n[1] + gz.delta[2] * n[2];
    if (gz.sides > 0 && Math.abs(dist) > 1e-6) { _finishExtrude({ kind: 'extrude', preGesture: gz.pre, capIds: gz.capIds, groups: gz.groups?.length > 1 ? gz.groups : null, normalLocal: n, dist, sides: gz.sides, moved: true }); return; }
    _commit('Extrude faces');                                      // slid sideways (no volume to join or cut): the plain ring
    return;
  }
  _commit(label);
}

/** The gizmo shows at the selection's centre whenever something is selected and no mouse gesture is running. */
function _syncGizmo() {
  if (!_ed) return;
  const ids = _selVertexIds();
  const want = ids.length > 0 && !_ed.drag && !_ed.marq && !_ed.chamfer;
  if (!want) { if (gizmo.activeTarget === _target && !gizmo.isDragging) gizmo.hide(); return; }
  if (gizmo.activeTarget !== _target) { gizmo.showForCableTarget(_target, 'all'); if (_ed.space && _ed.space !== gizmo.spaceMode) gizmo.setSpace(_ed.space); }
  sceneCore.requestRender?.(60);
}

// ── loop-cut preview ─────────────────────────────────────────────────────────
function _previewLoop(face, e) {
  const h = _ed?.helpers; if (!h) return;
  const { k, t } = _nearestEdge(e, face);
  const key = `${face}:${k}:${t.toFixed(2)}`;
  if (_ed.previewKey === key) return;
  _ed.previewKey = key;
  const r = loopCut(_ed.poly, face, k, t);
  if (!r) { h.loop.visible = false; sceneCore.requestRender?.(60); return; }
  const pts = [];
  const push = (i) => pts.push(r.poly.v[i * 3], r.poly.v[i * 3 + 1], r.poly.v[i * 3 + 2]);
  for (const i of r.newVertexIds) push(i);
  if (r.closed && r.newVertexIds.length > 1) push(r.newVertexIds[0]);
  const Th = T();
  h.loop.geometry.dispose(); h.loop.geometry = new Th.BufferGeometry();
  h.loop.geometry.setAttribute('position', new Th.BufferAttribute(new Float32Array(pts), 3));
  h.loop.visible = true;
  setStickyStatus(`✂ loop cut here (${r.newVertexIds.length} faces${r.closed ? ', closed' : ', open end'}) — click to cut`, 'info', 'polyGesture');
  sceneCore.requestRender?.(60);
}

function _clearPreview() {
  if (!_ed) return;
  if (_ed.previewKey != null) clearStickyStatus('polyGesture');
  _ed.previewKey = null;
  if (_ed.helpers?.loop) { _ed.helpers.loop.visible = false; sceneCore.requestRender?.(60); }
}

// ── box-select (a drag that starts off the poly) ─────────────────────────────
function _marqueeApply(m) {
  const { poly } = _ed;
  const x0 = Math.min(m.x, m.x2), x1 = Math.max(m.x, m.x2), y0 = Math.min(m.y, m.y2), y1 = Math.max(m.y, m.y2);
  const inRect = (i) => { const s = _toScreen([poly.v[i * 3], poly.v[i * 3 + 1], poly.v[i * 3 + 2]]); return s.z <= 1 && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1; };
  let picked = new Set();
  const mode = _ed.mode;
  if (mode === 'vertex') {
    for (let i = 0; i < poly.v.length / 3; i++) if (inRect(i)) picked.add(i);
  } else if (mode === 'edge') {
    for (const ed of _edgeList()) { const hits = (inRect(ed.a) ? 1 : 0) + (inRect(ed.b) ? 1 : 0); if (m.ctrl ? hits === 2 : hits > 0) picked.add(ed.key); }
  } else {
    poly.f.forEach((f, fi) => { const hits = f.filter(inRect).length; if (m.ctrl ? hits === f.length : hits > 0) picked.add(fi); });
    if (mode === 'element') picked = _growToElements(picked);
  }
  const cur = mode === 'vertex' ? _ed.selVerts : mode === 'edge' ? _ed.selEdges : _ed.selFaces;
  let next;
  if (m.alt) { next = new Set([...cur].filter(i => !picked.has(i))); }
  else if (m.shift) { next = new Set([...cur, ...picked]); }
  else next = picked;
  if (mode === 'vertex') _ed.selVerts = next; else if (mode === 'edge') _ed.selEdges = next; else _ed.selFaces = next;
  const n = mode === 'element' ? new Set([...picked].map(i => _faceElements()[i])).size : picked.size;
  setStatus(`${n} ${NOUN[mode]} in the box${m.alt ? ' removed' : m.shift ? ' added' : ''} · ${mode === 'element' ? new Set([...next].map(i => _faceElements()[i])).size : next.size} selected.`, 'info', 3000);
}

// ── gestures ─────────────────────────────────────────────────────────────────
const _typing = () => { const el = document.activeElement, tag = el?.tagName; return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable; };
const _swallow = (e) => {
  e.preventDefault(); e.stopImmediatePropagation();
  if (_ed) _ed.swallowClick = true;
  const a = document.activeElement;                      // a cancelled pointerdown would leave a text field focused — and eat the keys
  if (a && a !== document.body && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) a.blur();
};

function _onDown(e) {
  if (!_ed) return;
  if (e.button === 2) { _ed.rmb = { x: e.clientX, y: e.clientY }; return; }   // a right-DRAG (the camera) is not a menu click
  if (e.button !== 0) return;
  if (_ed.chamfer) { _swallow(e); return; }                              // the chamfer is on show: its bar has the say
  if (_ed.drag?.finishing) { _swallow(e); return; }                      // the Boolean of the last release is still running
  if (_ed.drag?.typing) { _swallow(e); _releaseExtrude(_ed.drag); return; }   // a typed extrude: the click keeps it
  if (_ed.drag) _endDrag(_ed.drag);                                     // a release that never arrived (pointer let go off-window)
  if (!_ed.host.alive()) { if (_ed.host.onMissClick) _swallow(e); exitPolyEdit(); return; }
  // the gizmo's handles come first (they live in the overlay scene, in front of everything)
  if (gizmo.activeTarget === _target) {
    _ed.gizmoShift = !!e.shiftKey;
    if (gizmo.onPointerDown(e.clientX, e.clientY, false)) {
      try { sceneCore.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* fine */ }
      _swallow(e);
      return;
    }
    _ed.gizmoShift = false;
  }
  if (_ed.mode === 'vertex') {
    const vi = _nearestVertex(e);
    if (vi < 0) { _beginMarquee(e); return; }
    _swallow(e);
    if (e.ctrlKey || e.shiftKey) { if (_ed.selVerts.has(vi)) _ed.selVerts.delete(vi); else _ed.selVerts.add(vi); _refreshHelpers(); _syncGizmo(); return; }
    if (!_ed.selVerts.has(vi)) _ed.selVerts = new Set([vi]);
    const anchor = new (T().Vector3)(_ed.poly.v[vi * 3], _ed.poly.v[vi * 3 + 1], _ed.poly.v[vi * 3 + 2]).applyMatrix4(_ed.mesh.matrixWorld);
    _ed.before = _ed.host.snapshot();
    _ed.drag = { kind: 'vertex', ids: [..._ed.selVerts], x: e.clientX, y: e.clientY, moved: false, anchor, start: clonePoly(_ed.poly), preGesture: clonePoly(_ed.poly) };
    _refreshHelpers(); _syncGizmo();
    return;
  }
  if (_ed.mode === 'edge') {                                       // ⬚ V0.3.5.45 — edges
    const ek = _edgeAt(e);
    if (!ek) { _beginMarquee(e); return; }
    _swallow(e);
    if (e.ctrlKey || e.shiftKey) { if (_ed.selEdges.has(ek)) _ed.selEdges.delete(ek); else _ed.selEdges.add(ek); _refreshHelpers(); _syncGizmo(); return; }
    if (!_ed.selEdges.has(ek)) _ed.selEdges = new Set([ek]);
    const [a, b] = ek.split('-').map(Number), p = _ed.poly;
    const anchor = new (T().Vector3)((p.v[a * 3] + p.v[b * 3]) / 2, (p.v[a * 3 + 1] + p.v[b * 3 + 1]) / 2, (p.v[a * 3 + 2] + p.v[b * 3 + 2]) / 2).applyMatrix4(_ed.mesh.matrixWorld);
    _ed.before = _ed.host.snapshot();
    _ed.drag = { kind: 'edges', ids: _edgeVerts(_ed.selEdges), x: e.clientX, y: e.clientY, moved: false, anchor, start: clonePoly(p), preGesture: clonePoly(p) };
    _refreshHelpers(); _syncGizmo();
    return;
  }
  if (_ed.mode === 'element') {                                    // ⬚ V0.3.5.45 — whole connected pieces
    const { hit, face } = _hitFace(e);
    if (!hit || face < 0) { _beginMarquee(e); return; }
    _swallow(e);
    const el = _elementFaces(face), wasSel = _ed.selFaces.has(face);
    if (e.ctrlKey || e.shiftKey) { for (const i of el) { if (wasSel) _ed.selFaces.delete(i); else _ed.selFaces.add(i); } _refreshHelpers(); _syncGizmo(); return; }
    if (!wasSel) _ed.selFaces = new Set(el);
    _ed.before = _ed.host.snapshot();
    _ed.drag = { kind: 'faces', ids: verticesOfFaces(_ed.poly, [..._ed.selFaces]), x: e.clientX, y: e.clientY, moved: false, anchor: hit.point.clone(), start: clonePoly(_ed.poly), preGesture: clonePoly(_ed.poly) };
    _refreshHelpers(); _syncGizmo();
    return;
  }
  const { hit, face } = _hitFace(e);
  if (!hit || face < 0) { _beginMarquee(e); return; }
  _swallow(e);
  if (e.altKey) {                                                  // ✂ loop cut at the nearest edge
    const { k, t } = _nearestEdge(e, face);
    const r = loopCut(_ed.poly, face, k, t);
    _clearPreview();
    if (!r) { setStatus('No cut possible from that edge.', 'warn', 4000); return; }
    _ed.before = _ed.host.snapshot();
    _ed.poly = r.poly;
    _ed.selFaces = new Set(); _ed.hoverFace = -1;
    _applyLive();
    _commit('Loop cut');
    setStatus(`Loop cut — ${r.newVertexIds.length} faces${r.closed ? '' : ' (open end)'}.`, 'success', 2500);
    return;
  }
  const wasSel = _ed.selFaces.has(face);
  if (e.ctrlKey) { if (wasSel) _ed.selFaces.delete(face); else _ed.selFaces.add(face); _refreshHelpers(); _syncGizmo(); return; }
  if (e.shiftKey && !wasSel) _ed.selFaces.add(face);              // Shift adds; an unmoved Shift-click on a selected face removes it (below)
  else if (!e.shiftKey && !wasSel) _ed.selFaces = new Set([face]);
  const ids = [..._ed.selFaces];
  _ed.before = _ed.host.snapshot();
  const pre = clonePoly(_ed.poly);
  if (e.shiftKey) {                                                // ⬆ extrude: build the ring now, the drag stretches it
    const ex = extrudeFaces(_ed.poly, ids);
    const groups = _capGroups(_ed.poly, ids); for (const g of groups) g.verts = verticesOfFaces(ex.poly, g.ids);
    const g0 = groups.find(g => g.ids.includes(face)) || groups[0];   // the drag measures along the region it grabbed
    _ed.poly = ex.poly; _ed.selFaces = new Set(ex.capIds);
    _ed.drag = { kind: 'extrude', ids: ex.capVertexIds, capIds: ids.slice(), groups, sides: ex.sideIds.length, normalLocal: g0.n, x: e.clientX, y: e.clientY, moved: false, anchor: hit.point.clone(), start: clonePoly(ex.poly), preGesture: pre, clickToggle: wasSel ? face : -1, typed: '' };
    _applyLive();
  } else {
    _ed.drag = { kind: 'faces', ids: verticesOfFaces(_ed.poly, ids), x: e.clientX, y: e.clientY, moved: false, anchor: hit.point.clone(), start: clonePoly(_ed.poly), preGesture: pre };
  }
  _refreshHelpers(); _syncGizmo();
}

/** Off the poly: a drag becomes a box-select, a plain click ends the mode (and selects whatever it hit). */
function _beginMarquee(e) {
  _swallow(e);
  _ed.missEvent = e;
  // ⬚ V0.3.5.52 (diagnostic U8) — vertex / edge mode: a click on the poly's own surface that missed a dot / an
  // edge is not "off the poly" — it must not end the mode (face / element modes never get here on a face)
  const onPoly = (_ed.mode === 'vertex' || _ed.mode === 'edge') && _hitFace(e).face >= 0;
  _ed.marq = { onPoly, x: e.clientX, y: e.clientY, x2: e.clientX, y2: e.clientY, started: false, shift: !!e.shiftKey, ctrl: !!(e.ctrlKey || e.metaKey), alt: !!e.altKey };
  _clearPreview();
}

function _onMove(e) {
  if (!_ed) return;
  _ed.lastXY = { clientX: e.clientX, clientY: e.clientY };
  if (gizmo.isDragging && gizmo.activeTarget === _target) return;   // main.js drives the gizmo drag
  const m = _ed.marq;
  if (m) {
    e.preventDefault(); e.stopImmediatePropagation();
    m.x2 = e.clientX; m.y2 = e.clientY; m.shift = !!e.shiftKey; m.ctrl = !!(e.ctrlKey || e.metaKey); m.alt = !!e.altKey;
    if (!m.started && Math.hypot(m.x2 - m.x, m.y2 - m.y) < 6) return;
    if (!(e.buttons & 1)) { _endMarquee(e); return; }
    m.started = true;
    showMarqueeBox(m.x, m.y, m.x2, m.y2, { ctrl: m.ctrl, shift: m.shift, alt: m.alt });
    return;
  }
  const d = _ed.drag;
  if (d) {
    e.preventDefault(); e.stopImmediatePropagation();
    if (d.finishing || d.typing) return;
    if (!(e.buttons & 1)) { _endDrag(d); return; }                   // the release happened off-window
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    const { world, local } = _localDeltaForPixels(dx, dy, d.anchor);
    let delta;
    if (d.kind === 'extrude') {
      const Th = T();
      const nWraw = new Th.Vector3(...d.normalLocal).applyMatrix3(new Th.Matrix3().setFromMatrix4(_ed.mesh.matrixWorld));
      const sN = nWraw.length() || 1;                                                          // world length of one unit along the normal
      // ⬚ V0.3.5.47 (diagnostic C5) — the distance in the poly's OWN units (what the Boolean and the cap search
      // measure in, and what a typed distance means): on a scaled part the world value lost the cap selection
      d.dist = world.dot(nWraw.clone().divideScalar(sN)) / sN;
      _ed.poly = d.groups ? _moveGroups(d.start, d.groups, d.dist) : moveVertices(d.start, d.ids, d.normalLocal.map(c => c * d.dist));
    } else {
      delta = local;
      _ed.poly = moveVertices(d.start, d.ids, [delta.x, delta.y, delta.z]);
    }
    _applyLive();
    if (d.kind === 'extrude') setStickyStatus(`⬆ extrude ${d.dist >= 0 ? '+' : ''}${d.dist.toFixed(1)} — release ${d.dist >= 0 ? 'joins' : 'cuts'} · or type the distance`, 'info', 'polyGesture');
    return;
  }
  // hover
  if (_ed.chamfer) return;
  if (_ed.mode === 'face' || _ed.mode === 'element') {
    const { face } = _hitFace(e);
    if (face !== _ed.hoverFace) { _ed.hoverFace = face; _refreshHelpers(); }
    if (_ed.mode === 'face' && e.altKey && face >= 0) _previewLoop(face, e); else if (_ed.previewKey != null) _clearPreview();
    sceneCore.renderer.domElement.style.cursor = face >= 0 ? (e.altKey && _ed.mode === 'face' ? 'crosshair' : 'pointer') : '';
  } else if (_ed.mode === 'edge') {
    const ek = _edgeAt(e);
    if (ek !== _ed.hoverEdge) { _ed.hoverEdge = ek; _refreshHelpers(); }
    sceneCore.renderer.domElement.style.cursor = ek ? 'pointer' : '';
  } else {
    const vi = _nearestVertex(e);
    if (vi !== _ed.hoverVert) { _ed.hoverVert = vi; _refreshHelpers(); }
    sceneCore.renderer.domElement.style.cursor = vi >= 0 ? 'pointer' : '';
  }
}

function _onUp(e) {
  if (!_ed) return;
  if (_ed.marq) { _endMarquee(e); return; }
  const d = _ed.drag;
  if (!d || d.finishing) return;
  if (d.typing) { d.released = true; return; }                     // the typed value owns the gesture now; Enter / Esc / a click end it
  e.preventDefault?.(); e.stopImmediatePropagation?.();
  _endDrag(d);
}

/** The box-select ends: a real box picks, a mere click ends the mode and lets the click select what it hit. */
function _endMarquee(e) {
  const m = _ed.marq; _ed.marq = null;
  hideMarqueeBox();
  if (!m.started && m.onPoly) {                                     // ⬚ V0.3.5.52 (U8) — on the surface: a plain click clears, Ctrl/Shift keep
    _ed.swallowClick = true;
    if (!m.shift && !m.ctrl) { _ed.selVerts = new Set(); _ed.selEdges = new Set(); }
    _refreshHelpers(); _syncGizmo();
    return;
  }
  if (!m.started) {
    const host = _ed.host, ev = _ed.missEvent;
    _ed.swallowClick = !!host.onMissClick;                            // a host that handles the click keeps the app's handler out
    exitPolyEdit();
    if (host.onMissClick && ev) { try { host.onMissClick(ev); } catch { /* the host's business */ } }
    return;
  }
  e?.preventDefault?.(); e?.stopImmediatePropagation?.();
  _ed.swallowClick = true;
  _marqueeApply(m);
  _refreshHelpers(); _syncGizmo();
}

/** A mouse gesture ends (pointer up, or the release caught late). */
function _endDrag(d) {
  if (!_ed || _ed.drag !== d) return;
  if (!d.moved) {                                                  // a click: selection only; an unmoved extrude is undone
    _ed.drag = null;
    clearStickyStatus('polyGesture');
    if (d.kind === 'extrude') { _ed.poly = d.preGesture; _ed.selFaces = new Set([..._ed.selFaces].filter(i => i < _ed.poly.f.length)); if (d.clickToggle >= 0) _ed.selFaces.delete(d.clickToggle); _applyLive(); }
    _ed.before = null;
    _refreshHelpers(); _syncGizmo();
    return;
  }
  if (d.kind === 'extrude') { _releaseExtrude(d); return; }
  _ed.drag = null;
  clearStickyStatus('polyGesture');
  _commit(d.kind === 'vertex' ? 'Move vertex' : d.kind === 'edges' ? 'Move edges' : _ed.mode === 'element' ? 'Move elements' : 'Move faces');
}

/** The extrude gesture ends (mouse release or Enter on a typed distance). A zero distance leaves nothing behind. */
function _releaseExtrude(d) {
  if (!_ed || _ed.drag !== d) return;
  _ed.drag = null;
  clearStickyStatus('polyGesture');
  if (!d.moved || !Number.isFinite(d.dist) || Math.abs(d.dist) <= 1e-6) {
    _ed.poly = d.preGesture; _ed.selFaces = new Set([..._ed.selFaces].filter(i => i < _ed.poly.f.length)); _ed.before = null;
    _applyLive(); _syncGizmo();
    return;
  }
  if (d.sides > 0) { _finishExtrude(d); return; }
  _commit('Extrude faces');
}

/** Esc during a gesture: back to how it was before the pointer went down. */
function _cancelDrag() {
  const d = _ed?.drag; if (!d) return;
  _ed.drag = null;
  clearStickyStatus('polyGesture');
  _ed.poly = d.preGesture || d.start;
  _ed.selFaces = new Set([..._ed.selFaces].filter(i => i < _ed.poly.f.length));
  _ed.before = null;
  _applyLive(); _syncGizmo();
}

/** A typed distance replaces the mouse for this extrude (mm along the normal, maths allowed). */
function _applyTypedExtrude(d) {
  const v = parseExpression(d.typed);
  if (Number.isFinite(v)) {
    d.dist = v; d.moved = true;
    const n = d.normalLocal;
    _ed.poly = d.groups ? _moveGroups(d.start, d.groups, v) : moveVertices(d.start, d.ids, [n[0] * v, n[1] * v, n[2] * v]);
    _applyLive();
  }
  setStickyStatus(`⬆ extrude: typing «${d.typed}» → ${Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : '?'} mm — Enter keeps (${Number.isFinite(v) && v < 0 ? 'cuts' : 'joins'}), Esc cancels`, 'info', 'polyGesture');
}

/**
 * ⬚ V0.3.5.11 — the Boolean on release ("smart extrude", 3ds Max 2021.1+):
 * pulled out, the swept prism is UNITED with the body (an extrusion that runs
 * into another part of the mesh becomes one solid); pushed in, it is CUT away
 * (a pocket; a through-hole when it reaches the far side). The gesture stays
 * "in flight" until the kernel answers (ms) so Esc / a click cannot race it;
 * if the kernel fails the plain extrude of Phase 1 is kept, with a warning.
 * V0.3.5.12 — the edges survive (poly-csg keeps every input polygon's id);
 * also reached from a Shift + gizmo-arrow extrude (`d` built by _gzCommit).
 */
async function _finishExtrude(d) {
  d.finishing = true; _ed.drag = d;
  setStickyStatus(d.dist > 0 ? '⬆ joining…' : '⬇ cutting…', 'info', 'polyGesture');
  const pre = d.preGesture, post = _ed.poly;
  let label = 'Extrude faces', warn = null;
  try {
    const groups = d.groups || [{ ids: d.capIds, n: d.normalLocal }];   // ⬚ V0.3.5.47 (C4) — one prism per region, each along its own normal
    let res = pre;
    for (const g of groups) {
      res = await booleanPoly(res, extrusionPrism(pre, post, g.ids, g.n, d.dist, 0), d.dist > 0 ? 'union' : 'subtract');
      if (!_ed || _ed.drag !== d) return;                                 // the mode ended meanwhile (exit restored the pre-gesture poly)
      if (!res) break;
    }
    if (res) {
      _ed.poly = res;
      _ed.selFaces = new Set(groups.flatMap(g => facesOnCap(res, pre, g.ids, g.n, d.dist, polyExtent(pre) * 1e-4)));
      _ed.selEdges = new Set(); _ed.selVerts = new Set();   // the kernel renumbered every vertex
      _ed.hoverFace = -1;
      _applyLive();
      label = d.dist > 0 ? 'Extrude (join)' : 'Extrude (cut)';
    } else warn = 'The cut would remove everything — plain extrude kept.';
  } catch (err) {
    console.warn('[poly] Boolean failed, plain extrude kept:', err);
    if (!_ed || _ed.drag !== d) return;
    warn = `Join failed (${err?.message || err}) — plain extrude kept.`;
  } finally {
    if (_ed && _ed.drag === d) _ed.drag = null;
    clearStickyStatus('polyGesture');
  }
  _commit(label);
  if (warn) setStatus(warn, 'warn', 6000);
  if (d.exitAfter) { exitPolyEdit(); setStatus('Edit poly done.', 'info', 2500); }
}

function _onKey(e) {
  if (!_ed || _typing() || document.querySelector('dialog[open]')) return;
  if (gizmo.isDragging && gizmo.activeTarget === _target) return;   // gizmo-numeric owns the keys of a gizmo gesture (digits, Enter, Esc)
  // the right-click menu closes on Esc through a later listener this handler would cut off: close it here, and nothing else
  if (e.key === 'Escape' && document.getElementById('context-menu')?.style.display === 'block') { e.preventDefault(); e.stopImmediatePropagation(); hideContextMenu(); return; }
  // a chamfer on show: the undo key only closes it (nothing was committed; it must not undo the edit before)
  if (_ed.chamfer && (e.ctrlKey || e.metaKey) && (e.code === 'KeyZ' || e.code === 'KeyY')) { e.preventDefault(); e.stopImmediatePropagation(); polyEditCancelTool(); return; }
  const d = _ed.drag, k = e.key;
  if (d?.finishing) {                                              // the kernel is working: Esc = finish, then leave
    if (k === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); d.exitAfter = true; }
    return;
  }
  if (d) {                                                         // a mouse gesture is in flight
    if (k === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); _cancelDrag(); return; }
    if (d.kind === 'extrude' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (k === 'Enter') { if (d.typed && Number.isFinite(parseExpression(d.typed))) { e.preventDefault(); e.stopImmediatePropagation(); _releaseExtrude(d); } return; }
      if (k === 'Backspace') {
        if (!d.typed) return;
        e.preventDefault(); e.stopImmediatePropagation();
        d.typed = d.typed.slice(0, -1);
        if (!d.typed) {
          if (d.released) { _cancelDrag(); return; }                // the button is long up: nothing to hand the mouse back to
          d.typing = false; setStickyStatus('⬆ extrude — the mouse is back; release joins / cuts', 'info', 'polyGesture'); return;
        }
        _applyTypedExtrude(d); return;
      }
      if (k.length === 1 && /[\d.\-+*/()]/.test(k)) { e.preventDefault(); e.stopImmediatePropagation(); d.typed += k; d.typing = true; _applyTypedExtrude(d); return; }
    }
    return;
  }
  if (_ed.chamfer) {                                               // ⬚ V0.3.5.45 — the chamfer's bar has the keys
    if (k === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); _chamferEnd(false); setStatus('Chamfer cancelled.', 'info', 2500); return; }
    if (k === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); _chamferApply(); return; }
  }
  if ((k === 'Delete' || k === 'Backspace') && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault(); e.stopImmediatePropagation();
    if (_ed.mode === 'element') _deleteElements();
    else setStatus(`Only whole elements can be deleted for now — ${keyLabel('polyElements')} = Elements, click the piece, Del.`, 'info', 5000);
    return;
  }
  if (k === 'Alt') {                                               // the preview appears without waiting for the mouse to move
    if (_ed.mode === 'face' && !_ed.marq && _ed.hoverFace >= 0 && _ed.lastXY) _previewLoop(_ed.hoverFace, _ed.lastXY);
    return;
  }
  if (k === 'Escape') {
    // A gizmo drag: ui/gizmo-numeric.js (registered first) has already reverted and
    // ended it by the time this runs — so this Esc only cancels that gesture.
    if (performance.now() - (_ed.gzEndedAt || 0) < 200) { e.preventDefault(); e.stopImmediatePropagation(); _syncGizmo(); return; }
    if (_ed.marq) { e.preventDefault(); e.stopImmediatePropagation(); _ed.marq = null; hideMarqueeBox(); _syncGizmo(); return; }
    e.preventDefault(); e.stopImmediatePropagation(); exitPolyEdit(); setStatus('Edit poly done.', 'info', 2500); return;
  }
  const lv = keyMatches('polyVertices', e) ? 'vertex' : keyMatches('polyEdges', e) ? 'edge' : keyMatches('polyFaces', e) ? 'face' : keyMatches('polyElements', e) ? 'element' : null;
  if (lv && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault(); e.stopImmediatePropagation();
    setPolyEditMode(lv);
  }
}

/** ⬚ V0.3.5.45 — switch the level inside the mode (the keys, the right-click menu, the Poly Editor's panel). */
export function setPolyEditMode(mode) {
  if (!_ed || !MODES.includes(mode) || _ed.drag) return false;
  if (_ed.chamfer) _chamferEnd(false);
  if (_ed.mode === mode) return true;
  _ed.mode = mode;
  if (mode === 'element' && _ed.selFaces.size) _ed.selFaces = _growToElements(_ed.selFaces);
  if (mode === 'edge' && _ed.selEdges.size) { const live = new Set(_edgeList().map(x => x.key)); _ed.selEdges = new Set([..._ed.selEdges].filter(k => live.has(k))); }
  _ed.hoverFace = -1; _ed.hoverVert = -1; _ed.hoverEdge = null;
  _clearPreview();
  if (gizmo.activeTarget === _target) gizmo.hide();            // the frame changes with the mode
  _refreshHelpers(); _syncGizmo(); _hint();
  state.emit('polyEdit:mode', _ed.mode);
  return true;
}

/** ⬚ V0.3.5.45 — a double-click: in Edges, the LOOP of the edge under the cursor (Shift / Ctrl adds it). True = it was ours. */
export function polyEditDoubleClick(e) {
  if (!_ed || e.button !== 0 || _ed.chamfer) return false;
  if (_ed.mode !== 'edge') return _onPoly(e);
  const ek = _edgeAt(e);
  if (!ek) return false;
  _selectLoop(ek, e.shiftKey || e.ctrlKey);
  return true;
}
function _selectLoop(ek, add) {
  if (!_ed || !ek) return;                                // the menu outlived the mode
  const [a, b] = ek.split('-').map(Number);
  const loop = edgeLoop(_ed.poly, a, b);
  if (!loop?.length) return;
  _ed.selEdges = add ? new Set([..._ed.selEdges, ...loop]) : new Set(loop);
  _refreshHelpers(); _syncGizmo();
  setStatus(loop.length > 1 ? `Loop — ${loop.length} edges selected.` : 'No loop runs on from this edge (its corners do not have four edges each) — just the edge.', 'info', 3500);
}

/** ⬚ V0.3.5.45 — the right-click menu inside the mode. True = shown (the caller swallows the event). */
export function polyEditContextMenu(e) {
  if (!_ed || _ed.drag || _ed.marq) return false;
  const r = _ed.rmb; _ed.rmb = null;
  if (r && Math.hypot(e.clientX - r.x, e.clientY - r.y) > 5) return true;   // the button was dragged (the camera): no menu, and nothing else's either
  if (_ed.chamfer) return true;
  if (gizmo.activeTarget === _target && gizmo.onRightClick(e.clientX, e.clientY)) return true;   // on the gizmo: move / rotate by an amount
  const items = [];
  if (_ed.mode === 'edge') {
    const ek = _edgeAt(e);
    if (ek && !_ed.selEdges.has(ek)) { _ed.selEdges = new Set([ek]); _refreshHelpers(); _syncGizmo(); }
    const n = _ed.selEdges.size;
    items.push({ label: `◪ Chamfer${n ? ` ${n} edge${n === 1 ? '' : 's'}` : ''}…`, disabled: !n, action: () => startChamfer() });
    items.push({ label: '⟳ Select the loop (or double-click the edge)', disabled: !ek, action: () => _selectLoop(ek, false) });
    items.push({ separator: true });
  } else if (_ed.mode === 'element') {
    const { face } = _hitFace(e);
    if (face >= 0 && !_ed.selFaces.has(face)) { _ed.selFaces = new Set(_elementFaces(face)); _refreshHelpers(); _syncGizmo(); }
    items.push({ label: '🗑 Delete the element (Del)', disabled: !_ed.selFaces.size, action: () => _deleteElements() });
    items.push({ separator: true });
  }
  for (const m of MODES) items.push({ label: `${_ed.mode === m ? '✔ ' : ''}${NOUN[m][0].toUpperCase()}${NOUN[m].slice(1)} (${keyLabel({ vertex: 'polyVertices', edge: 'polyEdges', face: 'polyFaces', element: 'polyElements' }[m])})`, action: () => setPolyEditMode(m) });
  showContextMenu(items, e.clientX, e.clientY);
  return true;
}

/** ⬚ V0.3.5.45 — Ctrl+Z while a tool of the mode is on show only closes it (nothing was committed). True = it did. */
export function polyEditCancelTool() {
  if (!_ed?.chamfer) return false;
  _chamferEnd(false);
  setStatus('Chamfer cancelled.', 'info', 2500);
  return true;
}

// ── elements ─────────────────────────────────────────────────────────────────
function _deleteElements() {
  if (!_ed || _ed.mode !== 'element') return;
  const ids = new Set([..._ed.selFaces].filter(i => i < _ed.poly.f.length));
  if (!ids.size) { setStatus('Click the piece to delete first.', 'info', 3000); return; }
  if (ids.size >= _ed.poly.f.length) { setStatus('That is the whole object — delete it at the object level instead (Esc, then Del).', 'warn', 5000); return; }
  const n = new Set([...ids].map(i => _faceElements()[i])).size;
  _ed.before = _ed.host.snapshot();
  _ed.poly = _compact({ v: _ed.poly.v, f: _ed.poly.f.filter((_, i) => !ids.has(i)) });
  _ed.selFaces = new Set(); _ed.selVerts = new Set(); _ed.selEdges = new Set(); _ed.hoverFace = -1;
  _applyLive();
  _commit(n === 1 ? 'Delete element' : `Delete ${n} elements`);
  setStatus(`${n} element${n === 1 ? '' : 's'} deleted (${ids.size} faces). Ctrl+Z brings ${n === 1 ? 'it' : 'them'} back.`, 'success', 4500);
}

// ── chamfer (edges) ──────────────────────────────────────────────────────────
const _nice = (x) => { if (!(x > 0)) return 0; const p = Math.pow(10, Math.floor(Math.log10(x))); const m = x / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; };
const _fmt = (x) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? String(+x.toFixed(3)) : String(+x.toPrecision(3)));
const _len = (p, a, b) => Math.hypot(p.v[a * 3] - p.v[b * 3], p.v[a * 3 + 1] - p.v[b * 3 + 1], p.v[a * 3 + 2] - p.v[b * 3 + 2]);

/** How far a chamfer of these edges can go: the shortest edge running on from one of them. */
function _chamferReach(p, keys) {
  const sel = new Set(keys); let reach = Infinity;
  for (const f of p.f) for (let i = 0; i < f.length; i++) {
    const a = f[i], b = f[(i + 1) % f.length];
    if (!sel.has(edgeKey(a, b))) continue;
    const prev = f[(i - 1 + f.length) % f.length], next = f[(i + 2) % f.length];
    if (!sel.has(edgeKey(prev, a))) reach = Math.min(reach, _len(p, prev, a));
    if (!sel.has(edgeKey(b, next))) reach = Math.min(reach, _len(p, b, next));
  }
  return Number.isFinite(reach) ? reach : Math.min(...keys.map(k => { const [a, b] = k.split('-').map(Number); return _len(p, a, b); }));
}

export function startChamfer() {
  if (!_ed || _ed.mode !== 'edge' || _ed.drag || _ed.chamfer) return false;
  const keys = [..._ed.selEdges];
  if (!keys.length) { setStatus('Pick the edge(s) to chamfer first.', 'info', 3000); return false; }
  _clearPreview();
  const pre = clonePoly(_ed.poly), reach = _chamferReach(pre, keys);
  _ed.chamfer = { keys, pre, before: _ed.host.snapshot(), reach, dist: _nice(reach * 0.2) || reach * 0.2, res: null, bar: null };
  if (gizmo.activeTarget === _target) gizmo.hide();
  _chamferCompute();
  setStickyStatus('◪ CHAMFER — type the amount or drag the slider · RED dots = corners that meet: they are welded into one on Apply · Enter applies, Esc cancels', 'info', 'polyGesture');
  return true;
}

function _chamferCompute() {
  const c = _ed?.chamfer; if (!c) return;
  let r;
  try { r = chamferEdges(c.pre, c.keys, c.dist); } catch (err) { console.warn('[poly] chamfer failed', err); r = { poly: null, reason: err?.message || String(err) }; }
  c.res = r;
  if (r?.poly && r.maxDist > 0 && !c.reachSet) { c.reach = r.maxDist; c.reachSet = true; }   // the slider's end: where the first edge collapses
  _ed.poly = r?.poly || c.pre;
  _applyLive();
  const h = _ed.helpers;
  if (h?.warn) {
    const pts = (r?.poly && r.nearPairs) ? r.nearPairs.flat().flat() : [];
    h.warn.geometry.dispose(); h.warn.geometry = new (T().BufferGeometry)();
    h.warn.geometry.setAttribute('position', new (T().BufferAttribute)(new Float32Array(pts), 3));
    h.warn.visible = pts.length > 0;
  }
  _chamferBar();
  sceneCore.requestRender?.(80);
}

function _chamferBar() {
  const c = _ed?.chamfer; if (!c) return;
  if (!c.bar) {
    const surf = document.getElementById('viewport-surface') || sceneCore.renderer?.domElement?.parentElement;
    const bar = c.bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;top:40px;left:50%;transform:translateX(-50%);z-index:40;display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:7px 10px;border-radius:10px;background:var(--panel,#0f172a);border:1px solid #f97316;box-shadow:0 10px 30px rgba(0,0,0,.55);color:var(--text,#e5e7eb);font-size:12px;max-width:94%;';
    for (const ev of ['pointerdown', 'dblclick', 'contextmenu', 'wheel']) bar.addEventListener(ev, (e) => e.stopPropagation());
    const b = (label, title, fn, extra = '') => { const x = document.createElement('button'); x.className = 'btn'; x.textContent = label; x.title = title; x.style.cssText = `height:26px;padding:0 9px;font-size:12px;${extra}`; x.addEventListener('click', (e) => { e.preventDefault(); x.blur(); fn(); }); return x; };
    const lab = document.createElement('span'); lab.style.cssText = 'font-weight:600;';
    lab.textContent = `◪ Chamfer ${c.keys.length} edge${c.keys.length === 1 ? '' : 's'} by`;
    const num = document.createElement('input'); num.type = 'text'; num.value = _fmt(c.dist); num.title = 'How far back from the edge (mm, along the faces next to it) — maths allowed. Enter takes it.';
    num.style.cssText = 'width:64px;height:24px;padding:0 6px;font-size:12px;';
    const rng = document.createElement('input'); rng.type = 'range'; rng.min = '0'; rng.max = '1000'; rng.step = '1'; rng.style.cssText = 'width:150px;';
    const toR = (d) => String(Math.round(Math.max(0, Math.min(1, d / c.reach)) * 1000));
    rng.value = toR(c.dist);
    const take = (v, from) => {
      if (!_ed?.chamfer || !(v > 0) || !Number.isFinite(v)) return;
      c.dist = v;
      if (from !== 'num') num.value = _fmt(v);
      if (from !== 'rng') rng.value = toR(v);
      _chamferCompute();
    };
    rng.addEventListener('input', () => take(Math.max(c.reach * 1e-3, c.reach * (+rng.value / 1000)), 'rng'));
    rng.addEventListener('pointerup', () => rng.blur());
    num.addEventListener('change', () => take(parseExpression(num.value), 'num'));
    num.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); take(parseExpression(num.value), 'num'); num.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); num.value = _fmt(c.dist); num.blur(); }
    });
    const unit = document.createElement('span'); unit.textContent = 'mm'; unit.style.opacity = '.7';
    const msg = document.createElement('span'); msg.style.cssText = 'margin:0 4px;';
    const ok = b('✔ Apply  [Enter]', 'Chamfer as shown (corners that meet are welded into one). One undo step.', () => _chamferApply(), 'background:#14532d;border-color:#22c55e;color:#dcfce7;font-weight:600;');
    const no = b('✕ Cancel  [Esc]', 'Leave the edges as they were', () => { _chamferEnd(false); setStatus('Chamfer cancelled.', 'info', 2500); });
    bar.append(lab, num, unit, rng, msg, ok, no);
    c.ui = { msg, ok };
    surf?.appendChild(bar);
    setTimeout(() => { try { num.focus(); num.select(); } catch { /* fine */ } }, 0);   // type the amount straight away (Enter takes it, Enter again applies)
  }
  const r = c.res, { msg, ok } = c.ui;
  const near = r?.poly ? (r.nearPairs?.length || 0) : 0, col = r?.poly ? (r.collapsed || 0) : 0;
  msg.style.color = !r?.poly ? '#fca5a5' : near ? '#fca5a5' : '';
  const capped = r?.poly && r.dist < c.dist - 1e-9 ? ` · capped at ${_fmt(r.dist)} (the most it can go)` : '';
  msg.textContent = !r?.poly ? `can't: ${r?.reason || 'the result would not be a closed body'} — try a smaller amount`
    : near ? `⚠ ${near} corner pair${near === 1 ? '' : 's'} meet${near === 1 ? 's' : ''} (red) — welded into one on Apply${col ? ` · ${col} face${col === 1 ? '' : 's'} collapse${col === 1 ? 's' : ''} and ${col === 1 ? 'is' : 'are'} removed` : ''}`
      : `→ ${r.poly.f.length} faces${col ? ` · ${col} collapse and are removed` : ''}`;
  msg.textContent += capped;
  ok.disabled = !r?.poly;
}

function _chamferApply() {
  const c = _ed?.chamfer; if (!c?.res?.poly) return;
  let p = c.res.poly, welded = 0;
  if (c.res.nearPairs?.length) {
    p = weldPoly(p, c.res.weldEps);                  // the corners that meet (red) become one; a face left with < 3 corners goes
    welded = c.res.nearPairs.length;
  }
  const before = c.before, n = c.keys.length;
  _chamferEnd(true);
  _ed.poly = p; _ed.before = before;
  _ed.selEdges = new Set(); _ed.hoverEdge = null; _ed.selFaces = new Set(); _ed.selVerts = new Set();
  _applyLive();
  _commit(n === 1 ? 'Chamfer edge' : `Chamfer ${n} edges`);
  setStatus(`Chamfered ${n} edge${n === 1 ? '' : 's'}${welded ? ` · ${welded} meeting corner${welded === 1 ? '' : 's'} welded` : ''}. Ctrl+Z takes it back.`, 'success', 5000);
}

/** Close the chamfer. `kept` = Apply took the poly; otherwise the mesh goes back (`quiet` = the shape changed under it). */
function _chamferEnd(kept, quiet = false) {
  const c = _ed?.chamfer; if (!c) return;
  _ed.chamfer = null;
  try { c.bar?.remove(); } catch { /* gone */ }
  const h = _ed.helpers;
  if (h?.warn) h.warn.visible = false;
  clearStickyStatus('polyGesture');
  if (!kept && !quiet) { _ed.poly = c.pre; _applyLive(); }
  if (!kept) _syncGizmo();
  sceneCore.requestRender?.(80);
}

function _hint() {
  if (!_ed) return;
  const m = _ed.mode;
  setStickyStatus(m === 'face'
    ? `⬚ Edit poly · FACES: click selects (Shift / Ctrl adds · drag off the poly = box) · drag or the gizmo moves (Shift + an arrow = extrude · type a number = exact · L = axes face / world / parent) · Shift+drag = extrude (type the distance; out joins, in cuts) · Alt = loop-cut preview, Alt+click cuts · ${_levels()} · Esc = done`
    : m === 'edge'
      ? `⬚ Edit poly · EDGES: click selects (Shift / Ctrl adds · drag off the poly = box) · double-click = the whole loop · drag or the gizmo moves them · right-click = Chamfer… · ${_levels()} · Esc = done`
      : m === 'element'
        ? `⬚ Edit poly · ELEMENTS (each separate piece): click takes a whole piece (Shift / Ctrl adds · drag off the poly = box) · drag or the gizmo moves it · Del deletes it · ${_levels()} · Esc = done`
        : `⬚ Edit poly · VERTICES: drag a dot (Shift / Ctrl adds · drag off the poly = box) · the gizmo moves / rotates the picked ones · ${_levels()} · Esc = done`,
  'info', 'polyEdit');
}

// ── export ───────────────────────────────────────────────────────────────────
function _b64(ab) {
  const u8 = new Uint8Array(ab); let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The poly as a .glb (flat-shaded triangles, its colour, the topology in asset.extras.sbsPoly). */
export async function exportPolyGlb(nodeId) {
  const node = _nodeOf(nodeId);
  if (!node || node.primKind !== 'poly') return false;
  const poly = _polyOf(node);
  const path = await window.sbsNative?.saveFile?.({ title: 'Export the poly as .glb', defaultPath: `${(node.name || 'poly').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'poly'}.glb`, filters: [{ name: 'glTF binary', extensions: ['glb'] }] });
  if (!path) return false;
  try {
    const { positions, normals } = polyToArrays(poly);
    const indices = new Uint32Array(positions.length / 3); for (let i = 0; i < indices.length; i++) indices[i] = i;
    const c = node.object3d?.material?.color;
    const color = c ? [c.r, c.g, c.b] : [0.75, 0.79, 0.83];
    const glb = staticMeshGlb({ positions, normals, indices, color, name: node.name || 'poly', extras: { sbsPoly: poly, sbsPolyVersion: 1 } });
    const r = await window.sbsNative.writeFile(path, _b64(glb), 'base64');
    if (!r?.ok) throw new Error(r?.error || 'write failed');
    setStatus(`Poly exported (${Math.round(glb.byteLength / 1024)} KB) → ${path.split(/[\\/]/).pop()}`, 'success', 7000);
    return true;
  } catch (err) {
    setStatus(`Export failed: ${err?.message || err}`, 'warn', 6000);
    return false;
  }
}
