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
 *   Esc = cancel the gesture in flight, else done.
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
import * as actions from './actions.js';
import { gizmo } from '../ui/gizmo.js';
import { parseExpression } from '../ui/gizmo-numeric.js';
import { showMarqueeBox, hideMarqueeBox } from '../ui/marquee-box.js';
import { setStatus, setStickyStatus, clearStickyStatus } from '../ui/status.js';
import { isPoly, makeBoxPoly, clonePoly, polyToArrays, polyEdges, extrudeFaces, loopCut, moveVertices, averageNormal, verticesOfFaces, extrusionPrism, facesOnCap, polyExtent, cleanEdges } from './poly-core.js';
import { booleanPoly, warmBooleanLib } from './poly-csg.js';   // ⬚ V0.3.5.11 — the Boolean on release
import { staticMeshGlb } from '../io/glb-write.js';

const T = () => window.THREE;
let _ed = null;

export function isPolyEditing() { return !!_ed; }
export function polyEditNodeId() { return _ed?.nodeId || null; }

const _nodeOf = (id) => state.get('nodeById')?.get(id) || null;
const _isPolyNode = (node) => !!node && node.type === 'primitive' && node.primKind === 'poly';
const _polyOf = (node) => (isPoly(node?.primParams) ? clonePoly(node.primParams) : makeBoxPoly(20, 20, 20, node?.baseAtOrigin !== false));

export function enterPolyEdit(nodeId) {
  const node = _nodeOf(nodeId);
  if (!_isPolyNode(node)) { setStatus('Edit poly works on a Poly box (right-click a box ▸ Convert to editable poly).', 'warn', 5000); return false; }
  if (_ed) exitPolyEdit();
  const mesh = node.object3d;
  if (!mesh || !sceneCore.renderer) { setStatus('That poly has no mesh on screen yet.', 'warn', 4000); return false; }
  // V0.3.5.11 — the node is NOT left selected: the object gizmo would take the
  // pointer over the mesh, and a dozen listeners react to a selection change.
  // The mode holds its own reference and owns the gizmo (main.js leaves it
  // alone while state.polyEditing is set); a click that misses the poly ends
  // the mode (and goes on to select whatever it hit).
  state.setState({ selectedId: null, multiSelectedIds: new Set(), polyEditing: nodeId });
  gizmo.hide();
  _ed = { nodeId, node, mesh, poly: _polyOf(node), faceOfTri: null, mode: 'face', selFaces: new Set(), selVerts: new Set(), hoverFace: -1, hoverVert: -1, helpers: null, drag: null, before: null, gz: null, marq: null, space: 'local', gizmoShift: false, swallowClick: false, previewKey: null, lastXY: null };
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
    dbl:   (e) => { if (_ed && e.button === 0 && _onPoly(e)) { e.preventDefault(); e.stopImmediatePropagation(); } },
    step:  () => exitPolyEdit(),
    exp:   () => { if (state.get('_exporting')) exitPolyEdit(); },
    tree:  () => { if (_ed && !_isPolyNode(_nodeOf(_ed.nodeId))) exitPolyEdit(); },
    undo:  () => _resyncFromNode(),
  };
  dom.addEventListener('pointerdown', L.down, true);
  dom.addEventListener('pointermove', L.move, true);
  dom.addEventListener('click', L.click, true);
  dom.addEventListener('dblclick', L.dbl, true);
  window.addEventListener('pointerup', L.up, true);
  window.addEventListener('keydown', L.key, true);
  window.addEventListener('keyup', L.keyup, true);
  state.on('change:activeStepId', L.step);
  state.on('change:_exporting', L.exp);
  state.on('change:treeData', L.tree);
  state.on('undo:applied', L.undo);
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
    window.removeEventListener('pointerup', L.up, true);
    window.removeEventListener('keydown', L.key, true);
    window.removeEventListener('keyup', L.keyup, true);
    state.off?.('change:activeStepId', L.step);
    state.off?.('change:_exporting', L.exp);
    state.off?.('change:treeData', L.tree);
    state.off?.('undo:applied', L.undo);
  } catch { /* listeners already gone */ }
  _disposeHelpers();
  if (dom) dom.style.cursor = '';
  _ed = null;
  clearStickyStatus('polyEdit'); clearStickyStatus('polyGesture');
  if (state.get('polyEditing')) state.setState({ polyEditing: null });
  sceneCore.requestRender?.(200);
}

/** "Clean edges": coplanar neighbours merged, straight-through vertices dropped (undoable; works in or out of the mode). */
export function cleanPolyEdges(nodeId) {
  const node = _nodeOf(nodeId);
  if (!_isPolyNode(node)) return false;
  if (_ed && _ed.nodeId === nodeId) { if (_ed.drag) _cancelDrag(); }
  const p = _polyOf(node), c = cleanEdges(p);
  if (c.f.length === p.f.length && c.v.length === p.v.length) { setStatus('Nothing to clean — every edge bends the surface.', 'info', 3500); return false; }
  actions.setPrimitiveParams(nodeId, { v: c.v, f: c.f }, { undoLabel: 'Clean edges' });
  if (_ed && _ed.nodeId === nodeId) _resyncFromNode();
  setStatus(`Edges cleaned: ${p.f.length} → ${c.f.length} faces.`, 'success', 4000);
  return true;
}

/** Undo / redo (or Clean edges) changed the node under the mode: start again from what the node has. */
function _resyncFromNode() {
  if (!_ed) return;
  const node = _nodeOf(_ed.nodeId);
  if (!_isPolyNode(node)) { exitPolyEdit(); return; }   // undone past "Convert to editable poly": a box again
  _ed.drag = null; _ed.gz = null; _ed.before = null;
  if (_ed.marq) { _ed.marq = null; hideMarqueeBox(); }
  clearStickyStatus('polyGesture');
  if (node.object3d && node.object3d !== _ed.mesh) { _ed.mesh = node.object3d; _buildHelpers(); }
  _ed.poly = _polyOf(node);
  _ed.selFaces = new Set([..._ed.selFaces].filter(i => i < _ed.poly.f.length));
  _ed.selVerts = new Set([..._ed.selVerts].filter(i => i < _ed.poly.v.length / 3));
  _ed.hoverFace = -1; _ed.hoverVert = -1;
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
  wire.renderOrder = 10;
  const faceMat = () => new Th.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.4, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: Th.DoubleSide, depthWrite: false });
  const selM = noPick(new Th.Mesh(new Th.BufferGeometry(), faceMat()));
  const hovM = noPick(new Th.Mesh(new Th.BufferGeometry(), faceMat()));
  hovM.material.color.set(0xfbbf24); hovM.material.opacity = 0.3;
  const pts = noPick(new Th.Points(new Th.BufferGeometry(), new Th.PointsMaterial({ size: 9, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true })));
  pts.renderOrder = 11;
  const loop = noPick(new Th.Line(new Th.BufferGeometry(), new Th.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.95, depthTest: false })));
  loop.renderOrder = 12; loop.visible = false;
  grp.add(wire, selM, hovM, pts, loop);
  mesh.add(grp);
  _ed.helpers = { grp, wire, selM, hovM, pts, loop };
  _refreshHelpers();
}

function _disposeHelpers() {
  const h = _ed?.helpers;
  if (!h) return;
  try {
    h.grp.parent?.remove(h.grp);
    for (const o of [h.wire, h.selM, h.hovM, h.pts, h.loop]) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
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

function _refreshHelpers() {
  if (!_ed?.helpers) return;
  const Th = T(); const { poly, helpers: h, selFaces, hoverFace, selVerts, hoverVert, mode } = _ed;
  h.wire.geometry.dispose(); h.wire.geometry = new Th.BufferGeometry();
  h.wire.geometry.setAttribute('position', new Th.BufferAttribute(polyEdges(poly), 3));
  h.selM.geometry.dispose(); h.selM.geometry = _facesGeometry(selFaces); h.selM.visible = mode === 'face';
  h.hovM.geometry.dispose(); h.hovM.geometry = _facesGeometry(hoverFace >= 0 && !selFaces.has(hoverFace) ? [hoverFace] : []); h.hovM.visible = mode === 'face';
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

/** The gesture is over: one undo entry through the primitive machinery. */
function _commit(label) {
  const { nodeId, poly, before } = _ed;
  actions.setPrimitiveParams(nodeId, { v: poly.v.slice(), f: poly.f.map(x => x.slice()) }, { undoLabel: label, before: before || null });
  _ed.before = null;
  const node = _nodeOf(nodeId);
  if (node?.object3d && node.object3d !== _ed.mesh) { _ed.mesh = node.object3d; _buildHelpers(); }   // a full rebuild swapped the mesh
  _ed.poly = _polyOf(node);
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
const _onPoly = (e) => (_ed.mode === 'vertex' ? _nearestVertex(e) >= 0 : _hitFace(e).face >= 0);

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

// ── the gizmo (the app's own, through a target) ──────────────────────────────
const _selVertexIds = () => (!_ed ? [] : _ed.mode === 'vertex' ? [..._ed.selVerts] : verticesOfFaces(_ed.poly, [..._ed.selFaces].filter(i => i < _ed.poly.f.length)));

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
  spaces: ['local', 'world', 'parent'],
  defaultSpace: 'local',
  spaceLabel: (m) => (m === 'local' ? 'FACE' : m === 'parent' ? 'PARENT' : 'WORLD'),
  onSpaceChange(mode) { if (_ed) _ed.space = mode; },   // the user's choice (L / the badge) survives hide + show
  getWorldPos() { return _ed ? _centroidWorld(_selVertexIds()) : null; },
  getWorldQuat(mode = 'local') {
    const Th = T(); if (!_ed) return new Th.Quaternion();
    const parentQ = _ed.mesh.getWorldQuaternion(new Th.Quaternion());
    if (mode === 'parent' || _ed.mode === 'vertex' || !_ed.selFaces.size) return parentQ;
    const n = averageNormal(_ed.poly, [..._ed.selFaces].filter(i => i < _ed.poly.f.length));
    return _frameFromNormal(new Th.Vector3(n[0], n[1], n[2]).transformDirection(_ed.mesh.matrixWorld));
  },
  beginMove()   { _gzBegin('move'); },
  applyCumulativeDelta(worldD) {
    const gz = _ed?.gz; if (!gz) return;
    const Th = T();
    const d = worldD.clone().applyMatrix3(new Th.Matrix3().setFromMatrix4(gz.inv));
    gz.delta = [d.x, d.y, d.z];
    _ed.poly = moveVertices(gz.start, gz.ids, gz.delta);
    _applyLive();
  },
  commitMove()  { _gzCommit(_ed?.mode === 'vertex' ? 'Move vertices' : 'Move faces'); },
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
  commitRotate() { _gzCommit(_ed?.mode === 'vertex' ? 'Rotate vertices' : 'Rotate faces'); },
};

/** A gizmo gesture starts. Shift on an arrow in faces mode = EXTRUDE along that axis (the ring is built now, the Boolean runs on release). */
function _gzBegin(kind) {
  if (!_ed) return;
  const node = _nodeOf(_ed.nodeId);
  _clearPreview();
  const extrude = kind === 'move' && _ed.gizmoShift && _ed.mode === 'face' && _ed.selFaces.size > 0;
  _ed.gizmoShift = false;
  _ed.before = { ...(node?.primParams || {}) };
  const pre = clonePoly(_ed.poly);
  if (extrude) {
    const capIds = [..._ed.selFaces].filter(i => i < _ed.poly.f.length);
    const ex = extrudeFaces(_ed.poly, capIds);
    _ed.poly = ex.poly; _ed.selFaces = new Set(ex.capIds);
    _ed.gz = { kind: 'extrude', ids: ex.capVertexIds, capIds, sides: ex.sideIds.length, normalLocal: averageNormal(ex.poly, ex.capIds), pre, start: clonePoly(ex.poly), pivot: _centroidWorld(ex.capVertexIds, ex.poly), mw: _ed.mesh.matrixWorld.clone(), inv: _ed.mesh.matrixWorld.clone().invert(), delta: [0, 0, 0] };
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
    if (gz.sides > 0 && Math.abs(dist) > 1e-6) { _finishExtrude({ kind: 'extrude', preGesture: gz.pre, capIds: gz.capIds, normalLocal: n, dist, sides: gz.sides, moved: true }); return; }
    _commit('Extrude faces');                                      // slid sideways (no volume to join or cut): the plain ring
    return;
  }
  _commit(label);
}

/** The gizmo shows at the selection's centre whenever something is selected and no mouse gesture is running. */
function _syncGizmo() {
  if (!_ed) return;
  const ids = _selVertexIds();
  const want = ids.length > 0 && !_ed.drag && !_ed.marq;
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
  const picked = new Set();
  if (_ed.mode === 'vertex') {
    for (let i = 0; i < poly.v.length / 3; i++) if (inRect(i)) picked.add(i);
  } else {
    poly.f.forEach((f, fi) => { const hits = f.filter(inRect).length; if (m.ctrl ? hits === f.length : hits > 0) picked.add(fi); });
  }
  const cur = _ed.mode === 'vertex' ? _ed.selVerts : _ed.selFaces;
  let next;
  if (m.alt) { next = new Set([...cur].filter(i => !picked.has(i))); }
  else if (m.shift) { next = new Set([...cur, ...picked]); }
  else next = picked;
  if (_ed.mode === 'vertex') _ed.selVerts = next; else _ed.selFaces = next;
  setStatus(`${picked.size} ${_ed.mode === 'vertex' ? 'vertices' : 'faces'} in the box${m.alt ? ' removed' : m.shift ? ' added' : ''} · ${next.size} selected.`, 'info', 3000);
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
  if (!_ed || e.button !== 0) return;
  if (_ed.drag?.finishing) { _swallow(e); return; }                      // the Boolean of the last release is still running
  if (_ed.drag?.typing) { _swallow(e); _releaseExtrude(_ed.drag); return; }   // a typed extrude: the click keeps it
  if (_ed.drag) _endDrag(_ed.drag);                                     // a release that never arrived (pointer let go off-window)
  const node = _nodeOf(_ed.nodeId);
  if (!node) { exitPolyEdit(); return; }
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
    _ed.before = { ...(node.primParams || {}) };
    _ed.drag = { kind: 'vertex', ids: [..._ed.selVerts], x: e.clientX, y: e.clientY, moved: false, anchor, start: clonePoly(_ed.poly), preGesture: clonePoly(_ed.poly) };
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
    _ed.before = { ...(node.primParams || {}) };
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
  _ed.before = { ...(node.primParams || {}) };
  const pre = clonePoly(_ed.poly);
  if (e.shiftKey) {                                                // ⬆ extrude: build the ring now, the drag stretches it
    const ex = extrudeFaces(_ed.poly, ids);
    _ed.poly = ex.poly; _ed.selFaces = new Set(ex.capIds);
    _ed.drag = { kind: 'extrude', ids: ex.capVertexIds, capIds: ids.slice(), sides: ex.sideIds.length, normalLocal: averageNormal(ex.poly, ex.capIds), x: e.clientX, y: e.clientY, moved: false, anchor: hit.point.clone(), start: clonePoly(ex.poly), preGesture: pre, clickToggle: wasSel ? face : -1, typed: '' };
    _applyLive();
  } else {
    _ed.drag = { kind: 'faces', ids: verticesOfFaces(_ed.poly, ids), x: e.clientX, y: e.clientY, moved: false, anchor: hit.point.clone(), start: clonePoly(_ed.poly), preGesture: pre };
  }
  _refreshHelpers(); _syncGizmo();
}

/** Off the poly: a drag becomes a box-select, a plain click ends the mode (and selects whatever it hit). */
function _beginMarquee(e) {
  _swallow(e);
  _ed.marq = { x: e.clientX, y: e.clientY, x2: e.clientX, y2: e.clientY, started: false, shift: !!e.shiftKey, ctrl: !!(e.ctrlKey || e.metaKey), alt: !!e.altKey };
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
      const nW = new Th.Vector3(...d.normalLocal).transformDirection(_ed.mesh.matrixWorld);   // unit, world
      const dist = world.dot(nW);                                                              // along the normal only
      delta = nW.clone().multiplyScalar(dist).applyMatrix3(new Th.Matrix3().setFromMatrix4(_ed.mesh.matrixWorld.clone().invert()));
      d.dist = dist;
    } else delta = local;
    _ed.poly = moveVertices(d.start, d.ids, [delta.x, delta.y, delta.z]);
    _applyLive();
    if (d.kind === 'extrude') setStickyStatus(`⬆ extrude ${d.dist >= 0 ? '+' : ''}${d.dist.toFixed(1)} — release ${d.dist >= 0 ? 'joins' : 'cuts'} · or type the distance`, 'info', 'polyGesture');
    return;
  }
  // hover
  if (_ed.mode === 'face') {
    const { face } = _hitFace(e);
    if (face !== _ed.hoverFace) { _ed.hoverFace = face; _refreshHelpers(); }
    if (e.altKey && face >= 0) _previewLoop(face, e); else if (_ed.previewKey != null) _clearPreview();
    sceneCore.renderer.domElement.style.cursor = face >= 0 ? (e.altKey ? 'crosshair' : 'pointer') : '';
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
  if (!m.started) { _ed.swallowClick = false; exitPolyEdit(); return; }
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
  _commit(d.kind === 'vertex' ? 'Move vertex' : 'Move faces');
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
    _ed.poly = moveVertices(d.start, d.ids, [n[0] * v, n[1] * v, n[2] * v]);
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
    const prism = extrusionPrism(pre, post, d.capIds, d.normalLocal, d.dist, 0);
    const res = await booleanPoly(pre, prism, d.dist > 0 ? 'union' : 'subtract');
    if (!_ed || _ed.drag !== d) return;                                   // the mode ended meanwhile (exit restored the pre-gesture poly)
    if (res) {
      _ed.poly = res;
      _ed.selFaces = new Set(facesOnCap(res, pre, d.capIds, d.normalLocal, d.dist, polyExtent(pre) * 1e-4));
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
  if (k === '1' || k === '4') {
    e.preventDefault(); e.stopImmediatePropagation();
    _ed.mode = k === '1' ? 'vertex' : 'face';
    _ed.hoverFace = -1; _ed.hoverVert = -1;
    _clearPreview();
    if (gizmo.activeTarget === _target) gizmo.hide();            // the frame changes with the mode
    _refreshHelpers(); _syncGizmo(); _hint();
  }
}

function _hint() {
  if (!_ed) return;
  setStickyStatus(_ed.mode === 'face'
    ? '⬚ Edit poly · FACES: click selects (Shift / Ctrl adds · drag off the poly = box) · drag or the gizmo moves (Shift + an arrow = extrude · type a number = exact · L = axes face / world / parent) · Shift+drag = extrude (type the distance; out joins, in cuts) · Alt = loop-cut preview, Alt+click cuts · 1 = vertices · Esc = done'
    : '⬚ Edit poly · VERTICES: drag a dot (Shift / Ctrl adds · drag off the poly = box) · the gizmo moves / rotates the picked ones · 4 = faces · Esc = done',
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
