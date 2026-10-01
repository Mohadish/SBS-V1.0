/**
 * ⬚ EDIT POLY — the interactive mode (V0.3.5.9, Phase 1).
 *
 * The 3ds Max editable-poly gestures on a 'poly' primitive, in the viewport:
 *   faces mode (4):   hover highlights · click selects (Ctrl adds / removes)
 *                     · drag = move the faces in the view plane
 *                     · Shift + drag = EXTRUDE along their normal (a pocket when pushed in)
 *                     · Alt + click an edge = LOOP CUT through the strip of quads
 *   vertex mode (1):  dots on every vertex · drag one (Ctrl adds) in the view plane
 *   Esc / selecting anything else / a step change / an export = done.
 *
 * The maths lives in poly-core.js; every finished gesture goes through
 * actions.setPrimitiveParams (one undo entry, persistence, the definition
 * registry, ★ on the steps that show it). During a drag the mesh geometry is
 * rewritten live from the working topology. Helpers (wire, highlights, dots)
 * are children of the mesh so they follow it; none of them raycasts.
 */
import { state } from '../core/state.js';
import { sceneCore } from '../core/scene.js';
import * as actions from './actions.js';
import { setStatus, setStickyStatus, clearStickyStatus } from '../ui/status.js';
import { isPoly, makeBoxPoly, clonePoly, polyToArrays, polyEdges, extrudeFaces, loopCut, moveVertices, averageNormal, verticesOfFaces, extrusionPrism, facesOnCap, polyExtent } from './poly-core.js';
import { booleanPoly, warmBooleanLib } from './poly-csg.js';   // ⬚ V0.3.5.11 — the Boolean on release
import { staticMeshGlb } from '../io/glb-write.js';

const T = () => window.THREE;
let _ed = null;

export function isPolyEditing() { return !!_ed; }
export function polyEditNodeId() { return _ed?.nodeId || null; }

const _nodeOf = (id) => state.get('nodeById')?.get(id) || null;
const _polyOf = (node) => (isPoly(node?.primParams) ? clonePoly(node.primParams) : makeBoxPoly(20, 20, 20, node?.baseAtOrigin !== false));

export function enterPolyEdit(nodeId) {
  const node = _nodeOf(nodeId);
  if (!node || node.type !== 'primitive' || node.primKind !== 'poly') { setStatus('Edit poly works on a Poly box (right-click a box ▸ Convert to editable poly).', 'warn', 5000); return false; }
  if (_ed) exitPolyEdit();
  const mesh = node.object3d;
  if (!mesh || !sceneCore.renderer) { setStatus('That poly has no mesh on screen yet.', 'warn', 4000); return false; }
  // V0.3.5.11 — the node is NOT left selected: the gizmo would take the pointer
  // over the mesh, and a dozen listeners react to a selection change. The mode
  // holds its own reference; a click that misses the poly ends it (and goes on
  // to select whatever it hit).
  state.setState({ selectedId: null, multiSelectedIds: new Set(), polyEditing: nodeId });
  _ed = { nodeId, node, mesh, poly: _polyOf(node), faceOfTri: null, mode: 'face', selFaces: new Set(), selVerts: new Set(), hoverFace: -1, hoverVert: -1, helpers: null, drag: null, before: null };
  _ed.faceOfTri = polyToArrays(_ed.poly).faceOfTri;
  _buildHelpers();
  const dom = sceneCore.renderer.domElement;
  const L = _ed.listeners = {
    down: (e) => _onDown(e),
    move: (e) => _onMove(e),
    up:   (e) => _onUp(e),
    key:  (e) => _onKey(e),
    step: () => exitPolyEdit(),
    exp:  () => { if (state.get('_exporting')) exitPolyEdit(); },
    tree: () => { if (_ed && !_nodeOf(_ed.nodeId)) exitPolyEdit(); },
  };
  dom.addEventListener('pointerdown', L.down, true);
  dom.addEventListener('pointermove', L.move, true);
  window.addEventListener('pointerup', L.up, true);
  window.addEventListener('keydown', L.key, true);
  state.on('change:activeStepId', L.step);
  state.on('change:_exporting', L.exp);
  state.on('change:treeData', L.tree);
  _hint();
  warmBooleanLib().catch(() => {});                     // the wasm is ready by the first release
  sceneCore.requestRender?.(200);
  return true;
}

export function exitPolyEdit() {
  if (!_ed) return;
  const { listeners: L, drag } = _ed;
  if (drag) { _ed.poly = drag.preGesture || drag.start; _applyLive(); }   // a gesture in flight is abandoned
  const dom = sceneCore.renderer?.domElement;
  try {
    dom?.removeEventListener('pointerdown', L.down, true);
    dom?.removeEventListener('pointermove', L.move, true);
    window.removeEventListener('pointerup', L.up, true);
    window.removeEventListener('keydown', L.key, true);
    state.off?.('change:activeStepId', L.step);
    state.off?.('change:_exporting', L.exp);
    state.off?.('change:treeData', L.tree);
  } catch { /* listeners already gone */ }
  _disposeHelpers();
  if (dom) dom.style.cursor = '';
  _ed = null;
  clearStickyStatus('polyEdit');
  if (state.get('polyEditing')) state.setState({ polyEditing: null });
  sceneCore.requestRender?.(200);
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
  grp.add(wire, selM, hovM, pts);
  mesh.add(grp);
  _ed.helpers = { grp, wire, selM, hovM, pts };
  _refreshHelpers();
}

function _disposeHelpers() {
  const h = _ed?.helpers;
  if (!h) return;
  try {
    h.grp.parent?.remove(h.grp);
    for (const o of [h.wire, h.selM, h.hovM, h.pts]) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
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
  actions.setPrimitiveParams(nodeId, { v: poly.v.slice(), f: poly.f.map(x => x.slice()) }, { undoLabel: label, before: before || {} });
  _ed.before = null;
  const node = _nodeOf(nodeId);
  if (node?.object3d && node.object3d !== _ed.mesh) { _ed.mesh = node.object3d; _buildHelpers(); }   // a full rebuild swapped the mesh
  _ed.poly = _polyOf(node);
  _ed.faceOfTri = polyToArrays(_ed.poly).faceOfTri;
  _refreshHelpers();
}

// ── picking ──────────────────────────────────────────────────────────────────
function _hitFace(e) {
  const hits = sceneCore.pickAll(e.clientX, e.clientY).filter(h => h.object === _ed.mesh);
  const h = hits[0];
  if (!h || h.faceIndex == null) return { hit: null, face: -1 };
  const fi = _ed.faceOfTri?.[h.faceIndex];
  return { hit: h, face: fi == null ? -1 : fi };
}

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

// ── gestures ─────────────────────────────────────────────────────────────────
const _typing = () => { const el = document.activeElement, tag = el?.tagName; return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable; };

function _onDown(e) {
  if (!_ed || e.button !== 0) return;
  if (_ed.drag?.finishing) { e.preventDefault(); e.stopImmediatePropagation(); return; }   // the Boolean of the last release is still running
  const node = _nodeOf(_ed.nodeId);
  if (!node) { exitPolyEdit(); return; }
  if (_ed.mode === 'vertex') {
    const vi = _nearestVertex(e);
    if (vi < 0) { exitPolyEdit(); return; }                        // off the dots: done — the click goes on to whatever it hit
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.ctrlKey) { if (_ed.selVerts.has(vi)) _ed.selVerts.delete(vi); else _ed.selVerts.add(vi); _refreshHelpers(); return; }
    if (!_ed.selVerts.has(vi)) _ed.selVerts = new Set([vi]);
    const anchor = new (T().Vector3)(_ed.poly.v[vi * 3], _ed.poly.v[vi * 3 + 1], _ed.poly.v[vi * 3 + 2]).applyMatrix4(_ed.mesh.matrixWorld);
    _ed.before = { ...(node.primParams || {}) };
    _ed.drag = { kind: 'vertex', ids: [..._ed.selVerts], x: e.clientX, y: e.clientY, moved: false, anchor, start: clonePoly(_ed.poly), preGesture: clonePoly(_ed.poly) };
    _refreshHelpers();
    return;
  }
  const { hit, face } = _hitFace(e);
  if (!hit || face < 0) { exitPolyEdit(); return; }                // not on this poly: done — the click goes on to whatever it hit
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.altKey) {                                                  // ✂ loop cut through the strip at the nearest edge
    const { k, t } = _nearestEdge(e, face);
    const r = loopCut(_ed.poly, face, k, t);
    if (!r) { setStatus('That edge has no strip of quads to cut through.', 'warn', 4000); return; }
    _ed.before = { ...(node.primParams || {}) };
    _ed.poly = r.poly;
    _ed.selFaces = new Set(); _ed.hoverFace = -1;
    _applyLive();
    _commit('Loop cut');
    setStatus('Loop cut.', 'success', 2500);
    return;
  }
  if (e.ctrlKey) { if (_ed.selFaces.has(face)) _ed.selFaces.delete(face); else _ed.selFaces.add(face); _refreshHelpers(); return; }
  if (!_ed.selFaces.has(face)) _ed.selFaces = new Set([face]);
  const ids = [..._ed.selFaces];
  _ed.before = { ...(node.primParams || {}) };
  const pre = clonePoly(_ed.poly);
  if (e.shiftKey) {                                                // ⬆ extrude: build the ring now, the drag stretches it
    const ex = extrudeFaces(_ed.poly, ids);
    _ed.poly = ex.poly; _ed.selFaces = new Set(ex.capIds);
    _ed.drag = { kind: 'extrude', ids: ex.capVertexIds, capIds: ids.slice(), sides: ex.sideIds.length, normalLocal: averageNormal(ex.poly, ex.capIds), x: e.clientX, y: e.clientY, moved: false, anchor: hit.point.clone(), start: clonePoly(ex.poly), preGesture: pre };
    _applyLive();
  } else {
    _ed.drag = { kind: 'faces', ids: verticesOfFaces(_ed.poly, ids), x: e.clientX, y: e.clientY, moved: false, anchor: hit.point.clone(), start: clonePoly(_ed.poly), preGesture: pre };
  }
  _refreshHelpers();
}

function _onMove(e) {
  if (!_ed) return;
  const d = _ed.drag;
  if (d) {
    e.preventDefault(); e.stopImmediatePropagation();
    if (d.finishing) return;
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
    if (d.kind === 'extrude') setStickyStatus(`⬆ extrude ${d.dist >= 0 ? '+' : ''}${d.dist.toFixed(1)} — release to keep`, 'info', 'polyGesture');
    return;
  }
  // hover
  if (_ed.mode === 'face') {
    const { face } = _hitFace(e);
    if (face !== _ed.hoverFace) { _ed.hoverFace = face; _refreshHelpers(); }
    sceneCore.renderer.domElement.style.cursor = face >= 0 ? (e.altKey ? 'crosshair' : 'pointer') : '';
  } else {
    const vi = _nearestVertex(e);
    if (vi !== _ed.hoverVert) { _ed.hoverVert = vi; _refreshHelpers(); }
    sceneCore.renderer.domElement.style.cursor = vi >= 0 ? 'pointer' : '';
  }
}

function _onUp(e) {
  if (!_ed?.drag || _ed.drag.finishing) return;
  const d = _ed.drag; _ed.drag = null;
  clearStickyStatus('polyGesture');
  if (!d.moved) {                                                  // a click: selection only; an unmoved extrude is undone
    if (d.kind === 'extrude') { _ed.poly = d.preGesture; _ed.selFaces = new Set([..._ed.selFaces].filter(i => i < _ed.poly.f.length)); _applyLive(); }
    _ed.before = null;
    _refreshHelpers();
    return;
  }
  e.preventDefault?.(); e.stopImmediatePropagation?.();
  if (d.kind === 'extrude' && d.sides > 0 && Math.abs(d.dist || 0) > 1e-6) { _finishExtrude(d); return; }
  _commit(d.kind === 'extrude' ? 'Extrude faces' : d.kind === 'vertex' ? 'Move vertex' : 'Move faces');
}

/**
 * ⬚ V0.3.5.11 — the Boolean on release ("smart extrude", 3ds Max 2021.1+):
 * pulled out, the swept prism is UNITED with the body (an extrusion that runs
 * into another part of the mesh becomes one solid); pushed in, it is CUT away
 * (a pocket; a through-hole when it reaches the far side). The gesture stays
 * "in flight" until the kernel answers (ms) so Esc / a click cannot race it;
 * if the kernel fails the plain extrude of Phase 1 is kept, with a warning.
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
}

function _onKey(e) {
  if (!_ed || _typing() || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); exitPolyEdit(); setStatus('Edit poly done.', 'info', 2500); return; }
  if (e.key === '1' || e.key === '4') {
    e.preventDefault(); e.stopImmediatePropagation();
    _ed.mode = e.key === '1' ? 'vertex' : 'face';
    _ed.hoverFace = -1; _ed.hoverVert = -1;
    _refreshHelpers(); _hint();
  }
}

function _hint() {
  if (!_ed) return;
  setStickyStatus(_ed.mode === 'face'
    ? '⬚ Edit poly · FACES: click selects (Ctrl adds) · drag moves · Shift+drag = extrude (out = joins what it meets · in = cuts a pocket / a hole) · Alt+click an edge = loop cut · 1 = vertices · Esc = done'
    : '⬚ Edit poly · VERTICES: drag a dot (Ctrl adds more) · 4 = faces · Esc = done',
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
