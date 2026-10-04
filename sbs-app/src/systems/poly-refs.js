/**
 * ⬚ REFERENCE IMAGES of the Poly Editor (V0.3.5.25) — pictures to model against.
 *
 * His design: each flat view (Top, Bottom, Left, Right, Front, Back) has its own
 * picture(s). A picture is not a layer on the screen — it stands IN THE SCENE, on
 * the object's own centre (the pivot of the object's folder), facing its view:
 * zoom in and it grows, pan and it stays on the object. It shows only in the
 * view it belongs to (never in perspective). In "move / scale" mode it is
 * grabbed and dragged, or pulled by a corner; where it is left is its home.
 * A photo is squared first — four corners dragged onto what should be a
 * rectangle (perspective-warp.js) — so it can be traced. Later the same pictures
 * are what gets projected onto the model as textures.
 *
 * How it is drawn. One plane per picture, child of the session group, in the
 * view's own axes, through the anchor point. It never writes or tests depth:
 *   behind (default)  drawn BEFORE the model (the opaque pass, renderOrder far
 *                     below zero, custom blending so its opacity still works) —
 *                     the model covers it;
 *   in front          drawn AFTER everything, see-through — to trace over.
 * (No depth placement: the flat views use a 0.5° lens, a plane pushed "behind"
 * could leave the adaptive far plane. The AO pass reads the real depth buffer,
 * which these planes do not touch.)
 *
 * What is kept. { view, name, path, quad, aspect, u, v, size, opacity, front,
 * visible } per picture — the file's PATH, never its pixels — in the asset
 * (glTF asset.extras.sbsRefs → model.polyManifest.refs), so the next edit of the
 * asset finds its references again. u / v / size are in the session group's
 * units, measured from the anchor along the view's right / up.
 *
 * The session hands over a host: { group, anchor(), view(), goView(v),
 * push(label, undo, redo), changed(), contentSize() }.
 */
import { sceneCore } from '../core/scene.js';
import { setStatus } from '../ui/status.js';
import { warpImage, rectifiedSize } from './perspective-warp.js';

const T = () => window.THREE;
const MAX_SRC = 4096;      // the picture as it is read (the corners are picked on this)
const MAX_TEX = 2048;      // the picture as it is drawn (the renderer's memory is a hard cage)
export const REF_VIEWS = ['front', 'back', 'left', 'right', 'top', 'bottom'];
// the same table as sceneCore.standardViewState: where the camera sits, which way is up on screen
const VIEW = {
  top:    { eye: [0, 1, 0],  up: [0, 0, -1] },
  bottom: { eye: [0, -1, 0], up: [0, 0, 1] },
  left:   { eye: [-1, 0, 0], up: [0, 1, 0] },
  right:  { eye: [1, 0, 0],  up: [0, 1, 0] },
  front:  { eye: [0, 0, 1],  up: [0, 1, 0] },
  back:   { eye: [0, 0, -1], up: [0, 1, 0] },
};
const IMG_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];

let _h = null;             // the session's host
let _refs = [];            // the pictures, bottom → top
let _root = null;          // THREE.Group under the session group
let _helpers = null;       // outline + corner handles of the selected picture
let _sel = null, _edit = false, _seq = 0, _drag = null, _camFn = null, _gen = 0;
const _built = new Set();  // every picture that ever got a plane in this session (a removed one lives on in the undo stack): all are freed at the end

export const polyRefsEditing = () => !!_h && _edit;
// ⬚ V0.3.5.33 — a picture's height: its own proportion × its STRETCH (1 = as it is; Ctrl + a corner stretches freely)
const _stretchOf = (r) => (r.stretch > 0 ? r.stretch : 1);
const _heightOf = (r) => r.size * r.h / r.w * _stretchOf(r);
const _ref = (id) => _refs.find(r => r.id === id) || null;

function _basis(view) {
  const Th = T(), V = VIEW[view] || VIEW.front;
  const n = new Th.Vector3(...V.eye), up = new Th.Vector3(...V.up);
  return { n, up, right: new Th.Vector3().crossVectors(up, n) };
}

// ── pixels ───────────────────────────────────────────────────────────────────
async function _readImage(path) {
  const nat = window.sbsNative;
  if (!nat?.readFile) throw new Error('reading a picture needs the desktop app');
  const rd = await nat.readFile(path, 'buffer');
  if (!rd?.ok) throw new Error(rd?.error || 'the file could not be read');
  const ext = (String(path).split('.').pop() || '').toLowerCase();
  const url = URL.createObjectURL(new Blob([rd.data], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` }));
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('not a picture this app can read')); i.src = url; });
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error('the picture is empty');
    const k = Math.min(1, MAX_SRC / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}
function _fit(src, max) {
  const k = Math.min(1, max / Math.max(src.width, src.height));
  if (k >= 1) return src;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}
/** The picture as it is drawn: squared up when a quad is given (corners as fractions of the source), else as it is. */
function _finalCanvas(src, quad, aspect) {
  if (!Array.isArray(quad) || quad.length !== 4) return _fit(src, MAX_TEX);
  const px = quad.map(p => ({ x: p.x * src.width, y: p.y * src.height }));
  let { w, h } = rectifiedSize(px, aspect > 0 ? aspect : null);
  const k = Math.min(1, MAX_TEX / Math.max(w, h));
  w = Math.max(8, Math.round(w * k)); h = Math.max(8, Math.round(h * k));
  return warpImage(src, px, w, h, { margin: 0, maxDim: MAX_TEX }).canvas;   // just the rectangle: that is the face being modelled
}

// ── the planes ───────────────────────────────────────────────────────────────
function _texture(canvas) {
  const Th = T(), tex = new Th.CanvasTexture(canvas);
  if ('SRGBColorSpace' in Th) tex.colorSpace = Th.SRGBColorSpace;
  tex.anisotropy = 4; tex.needsUpdate = true;
  return tex;
}
function _buildMesh(ref, canvas) {
  const Th = T();
  ref.w = canvas.width; ref.h = canvas.height;
  const mat = new Th.MeshBasicMaterial({ map: _texture(canvas), side: Th.DoubleSide, depthTest: false, depthWrite: false, toneMapped: false });
  const mesh = new Th.Mesh(new Th.PlaneGeometry(1, 1), mat);
  mesh.name = `ref:${ref.name}`; mesh.userData.polyRefId = ref.id; mesh.frustumCulled = false;
  ref.mesh = mesh; ref.mode = null;
  _built.add(ref);
}
function _disposeMesh(ref) {
  const m = ref.mesh; if (!m) return;
  try { m.parent?.remove(m); m.material.map?.dispose?.(); m.material.dispose(); m.geometry.dispose(); } catch { /* gone */ }
  ref.mesh = null;
}
function _swapCanvas(ref, canvas) {
  if (!ref.mesh) { _buildMesh(ref, canvas); return; }
  const old = ref.mesh.material.map;
  ref.mesh.material.map = _texture(canvas); ref.mesh.material.needsUpdate = true;
  // a projection may still draw with the old texture for one frame (its skin is rebuilt on the next one): freed after that frame
  requestAnimationFrame(() => requestAnimationFrame(() => { try { old?.dispose?.(); } catch { /* fine */ } }));
  ref.w = canvas.width; ref.h = canvas.height;
}

/**
 * ⬚ V0.3.5.47 (diagnostic C6) — the anchor moved by `d` (session space) while nothing else did (a new pivot
 * for the object's folder, another folder becoming the object's): the pictures are measured again from it,
 * so they — and their projections — stay exactly where they were.
 */
export function shiftPolyRefs(d) {
  if (!d || !_refs.length) return;
  for (const ref of _refs) { const b = _basis(ref.view); ref.u -= d.dot(b.right); ref.v -= d.dot(b.up); }
  syncPolyRefs(); _h?.moved?.();
}

/** Everything where it belongs: which pictures show, where, how; the handles of the selected one. */
export function syncPolyRefs() {
  if (!_h?.group || !_root) return;
  const Th = T(), view = _h.view(), a = _h.anchor();
  if (_root.parent !== _h.group) _h.group.add(_root);
  _refs.forEach((ref, i) => {
    const m = ref.mesh; if (!m) return;
    if (m.parent !== _root) _root.add(m);
    m.visible = !!ref.visible && ref.view === view;
    const b = _basis(ref.view);
    m.quaternion.setFromRotationMatrix(new Th.Matrix4().makeBasis(b.right, b.up, b.n));
    m.position.copy(a).addScaledVector(b.right, ref.u).addScaledVector(b.up, ref.v);
    m.scale.set(ref.size, _heightOf(ref), 1);
    const mode = ref.front ? 'front' : 'behind', mat = m.material;
    if (ref.mode !== mode) {
      ref.mode = mode;
      if (ref.front) { mat.transparent = true; mat.blending = Th.NormalBlending; }
      else { mat.transparent = false; mat.blending = Th.CustomBlending; mat.blendEquation = Th.AddEquation; mat.blendSrc = Th.SrcAlphaFactor; mat.blendDst = Th.OneMinusSrcAlphaFactor; }
      mat.needsUpdate = true;
    }
    mat.opacity = Math.max(0.02, Math.min(1, ref.opacity));
    m.renderOrder = (ref.front ? 9000 : -9000) + i;
  });
  for (const c of [..._root.children]) if (c !== _helpers && !_refs.some(r => r.mesh === c)) _root.remove(c);   // removed pictures leave the scene (their objects stay for undo)
  _syncHelpers();
  sceneCore.requestRender?.(120);
  _h.moved?.();                                            // ⬚ V0.3.5.30 — a projection follows its picture
}

/**
 * ⬚ V0.3.5.30 / .32 — what a box projection needs, per view: ONE picture made of every picture of that view
 * that takes part (🎯, on by default), merged the way they lie on the view — the higher in the stack covers the
 * lower, like layers merged in Photoshop: a close-up squared up and enlarged over the whole shot, a sticker on
 * top. Around it a clear border: outside the pictures a face keeps the part's colour (no smeared edge pixels).
 * → { view: { tex, uv(p) } }, p in the session group's space: where p falls on the merged picture, straight
 * along the view's axis. `stale` (not enumerable): a merge was held back (a drag in progress) — ask again soon.
 */
const COMP_MAX = 4096;                                       // the merged picture's longest side, px
const _comp = new Map();                                     // view → { sig, canvas, tex, rel: [x0, y0, x1, y1] from the first picture's corner, t }
function _dropComp(view) {
  const c = _comp.get(view); if (!c) return;
  _comp.delete(view);
  requestAnimationFrame(() => requestAnimationFrame(() => { try { c.tex.dispose(); } catch { /* fine */ } }));   // a skin may draw with it one more frame
}
export function polyRefProjectors() {
  const out = {};
  let stale = false;
  if (_h) {
    const a = _h.anchor(), byView = new Map();
    for (const r of _refs) {                               // bottom → top
      if (r.proj === false || !r.mesh || !(r.w > 0) || !(r.h > 0) || !(r.size > 0) || !r.mesh.material.map?.image) continue;
      if (!byView.has(r.view)) byView.set(r.view, []);
      byView.get(r.view).push(r);
    }
    for (const view of REF_VIEWS) {
      const list = byView.get(view);
      if (!list) { _dropComp(view); continue; }
      // each picture's rectangle on the view's plane: x along its right, y along its up, from the anchor
      const rects = list.map(r => { const hh = _heightOf(r) / 2; return { r, src: r.mesh.material.map.image, x0: r.u - r.size / 2, x1: r.u + r.size / 2, y0: r.v - hh, y1: r.v + hh }; });
      const f = rects[0];
      let X0 = Math.min(...rects.map(q => q.x0)), X1 = Math.max(...rects.map(q => q.x1)), Y0 = Math.min(...rects.map(q => q.y0)), Y1 = Math.max(...rects.map(q => q.y1));
      let ppu = Math.max(...rects.map(q => q.r.w / q.r.size));      // the sharpest picture keeps its own pixels…
      ppu = Math.min(ppu, (COMP_MAX - 4) / Math.max(X1 - X0, Y1 - Y0));   // …within the limit
      const pad = 2 / ppu; X0 -= pad; X1 += pad; Y0 -= pad; Y1 += pad;
      const r6 = (x) => Math.round(x * 1e6) / 1e6;
      // what the merge depends on: which pictures (and their pixels), and where they lie RELATIVE to each other —
      // moving them all together, or the only one, needs no new merge (only the coordinates follow)
      const sig = rects.map(q => `${q.r.id}:${q.r.mesh.material.map.uuid}:${r6(q.x0 - f.x0)}:${r6(q.y0 - f.y0)}:${r6(q.r.size)}:${r6(q.y1 - q.y0)}`).join('|');
      let c = _comp.get(view);
      if (!c || c.sig !== sig) {
        const now = performance.now();
        if (c && now - c.t < 80) stale = true;             // a picture is being dragged: the last merge stands in, the next one comes soon
        else {
          const W = Math.max(1, Math.ceil((X1 - X0) * ppu)), H = Math.max(1, Math.ceil((Y1 - Y0) * ppu));
          const same = c && c.canvas.width === W && c.canvas.height === H;
          const canvas = same ? c.canvas : document.createElement('canvas');
          if (!same) { canvas.width = W; canvas.height = H; }
          const g = canvas.getContext('2d');
          g.clearRect(0, 0, W, H);
          g.imageSmoothingQuality = 'high';
          for (const q of rects) g.drawImage(q.src, (q.x0 - X0) * ppu, (Y1 - q.y1) * ppu, (q.x1 - q.x0) * ppu, (q.y1 - q.y0) * ppu);   // the canvas runs down, the plane's up runs up
          let tex = same ? c.tex : null;
          if (tex) tex.needsUpdate = true;
          else { if (c) _dropComp(view); tex = _texture(canvas); }
          c = { sig, canvas, tex, rel: [X0 - f.x0, Y0 - f.y0, X1 - f.x0, Y1 - f.y0], t: now };
          _comp.set(view, c);
        }
      }
      const b = _basis(view), [rx0, ry0, rx1, ry1] = c.rel;
      const x0 = f.x0 + rx0, y0 = f.y0 + ry0, sx = 1 / (rx1 - rx0), sy = 1 / (ry1 - ry0);
      out[view] = {
        tex: c.tex,
        uv: (p) => {
          const dx = p.x - a.x, dy = p.y - a.y, dz = p.z - a.z;
          return [((dx * b.right.x + dy * b.right.y + dz * b.right.z) - x0) * sx, ((dx * b.up.x + dy * b.up.y + dz * b.up.z) - y0) * sy];
        },
      };
    }
  }
  Object.defineProperty(out, 'stale', { value: stale, enumerable: false });
  return out;
}

function _viewHeightLocal(pLocal) {
  const cam = sceneCore.camera, Th = T();
  const w = _h.group.localToWorld(pLocal.clone());
  const sc = _h.group.getWorldScale(new Th.Vector3());
  return 2 * cam.position.distanceTo(w) * Math.tan((cam.fov || 35) * Math.PI / 360) / (Math.max(Math.abs(sc.x), Math.abs(sc.y), Math.abs(sc.z)) || 1);
}
const _CORNERS = [[-1, 1], [1, 1], [1, -1], [-1, -1]];
function _syncHelpers() {
  const Th = T(), ref = _edit ? _ref(_sel) : null;
  if (_helpers) { for (const c of [..._helpers.children]) { _helpers.remove(c); c.geometry?.dispose?.(); c.material?.dispose?.(); } }
  if (!ref || !ref.mesh || !ref.mesh.visible) { if (_helpers) _helpers.visible = false; return; }
  if (!_helpers) { _helpers = new Th.Group(); _helpers.name = 'ref:helpers'; }
  if (_helpers.parent !== _root) _root.add(_helpers);
  _helpers.visible = true;
  _helpers.position.copy(ref.mesh.position); _helpers.quaternion.copy(ref.mesh.quaternion);
  const hw = ref.size / 2, hh = _heightOf(ref) / 2;
  const g = new Th.BufferGeometry();
  g.setAttribute('position', new Th.BufferAttribute(new Float32Array(_CORNERS.flatMap(([x, y]) => [x * hw, y * hh, 0])), 3));
  const line = new Th.LineLoop(g, new Th.LineBasicMaterial({ color: 0x38bdf8, depthTest: false, depthWrite: false, transparent: true }));
  line.renderOrder = 9990; line.frustumCulled = false;
  _helpers.add(line);
  const s = _viewHeightLocal(ref.mesh.position) * 0.018;
  _CORNERS.forEach(([x, y], k) => {
    const hnd = new Th.Mesh(new Th.PlaneGeometry(s, s), new Th.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, transparent: true, side: Th.DoubleSide }));
    hnd.position.set(x * hw, y * hh, 0); hnd.renderOrder = 9991; hnd.frustumCulled = false; hnd.userData.corner = k;
    _helpers.add(hnd);
  });
}

// ── what the panel reads ─────────────────────────────────────────────────────
export function polyRefsInfo() {
  if (!_h) return { edit: false, sel: null, view: 'persp', list: [] };
  return { edit: _edit, sel: _sel, view: _h.view(), list: _refs.map(r => ({ id: r.id, view: r.view, name: r.name, opacity: r.opacity, front: !!r.front, visible: !!r.visible, size: r.size, squared: !!r.quad, missing: !r.mesh, proj: r.proj !== false, stretch: _stretchOf(r) })) };
}
/**
 * For the asset: the file's path, never its pixels. Each entry carries the anchor it was measured from (`a`),
 * so the next edit puts the picture on the same spot whichever anchor it resolves then.
 * X = the transform the asset's geometry is baked through (a new asset saved from a re-edit of a model the
 * step has turned / scaled: session space → the scene's): the pictures go through it too — the view becomes
 * the view that shows the same face, sizes and offsets take the scale. A picture that no flat view would
 * show upright after that turn cannot be kept (it is left out).
 */
export function polyRefsForSave(X = null) {
  if (!_h) return [];
  const Th = T(), r6 = (x) => Math.round(x * 1e6) / 1e6, a = _h.anchor();
  let q = null, k = 1;
  if (X) { const sc = new Th.Vector3(); q = new Th.Quaternion(); X.decompose(new Th.Vector3(), q, sc); k = Math.max(Math.abs(sc.x), Math.abs(sc.y), Math.abs(sc.z)) || 1; a.applyMatrix4(X); }
  const out = [];
  for (const r of _refs) {
    let view = r.view;
    if (q) {
      const n = new Th.Vector3(...VIEW[r.view].eye).applyQuaternion(q), up = new Th.Vector3(...VIEW[r.view].up).applyQuaternion(q);
      view = REF_VIEWS.find(v => n.dot(new Th.Vector3(...VIEW[v].eye)) > 0.999 && up.dot(new Th.Vector3(...VIEW[v].up)) > 0.999) || null;
      if (!view) continue;
    }
    out.push({ view, name: r.name, path: r.path, quad: r.quad ? r.quad.map(p => ({ x: r6(p.x), y: r6(p.y) })) : null, aspect: r.aspect || null,
      ...(r.quad && r.sq ? { sq: r.sq } : {}),               // how the square-up dialog was left (its corners + the frame), to open it the same way
      ...(r.proj === false ? { proj: false } : {}),          // left out of the projection
      ...(Math.abs(_stretchOf(r) - 1) > 1e-6 ? { stretch: r6(_stretchOf(r)) } : {}),   // stretched wider / taller than its own proportion
      a: [r6(a.x), r6(a.y), r6(a.z)], u: r6(r.u * k), v: r6(r.v * k), size: r6(r.size * k), opacity: r6(r.opacity), front: !!r.front, visible: !!r.visible });
  }
  return out;
}

// ── life ─────────────────────────────────────────────────────────────────────
export function initPolyRefs(host, saved = null) {
  disposePolyRefs();
  const Th = T();
  _h = host; _refs = []; _sel = null; _edit = false; _drag = null; _gen++;
  _root = new Th.Group(); _root.name = 'PolyEditorReferences';
  host.group?.add(_root);
  _camFn = () => { if (_edit && _sel) { _syncHelpers(); } };   // the corner handles keep their size on screen
  try { sceneCore.on?.('controls:change', _camFn); } catch { /* an older scene core */ }
  const gen = _gen;
  if (Array.isArray(saved) && saved.length) host.pin?.();   // the anchor must not move once pictures hang on it
  const A = host.anchor();
  for (const s of Array.isArray(saved) ? saved : []) {
    if (!s || !REF_VIEWS.includes(s.view) || typeof s.path !== 'string') continue;
    const quad = Array.isArray(s.quad) && s.quad.length === 4 && s.quad.every(p => Number.isFinite(p?.x) && Number.isFinite(p?.y)) ? s.quad.map(p => ({ x: p.x, y: p.y })) : null;
    const ref = { id: `r${++_seq}`, view: s.view, name: String(s.name || s.path.split(/[\\/]/).pop() || 'picture'), path: s.path, quad, aspect: s.aspect > 0 ? s.aspect : null, sq: quad && s.sq && typeof s.sq === 'object' ? s.sq : null, proj: s.proj !== false, stretch: s.stretch > 0 ? s.stretch : 1,
      u: Number(s.u) || 0, v: Number(s.v) || 0, size: s.size > 0 ? s.size : 100, opacity: s.opacity > 0 ? s.opacity : 0.6, front: !!s.front, visible: s.visible !== false, w: 1, h: 1, mesh: null, mode: null };
    if (Array.isArray(s.a) && s.a.length === 3 && s.a.every(Number.isFinite)) {   // measured from another anchor than today's: same spot, new numbers
      const d = new Th.Vector3(s.a[0], s.a[1], s.a[2]).sub(A), b = _basis(ref.view);
      ref.u += d.dot(b.right); ref.v += d.dot(b.up);
    }
    _refs.push(ref);
    _readImage(ref.path).then(src => {                      // pictures arrive one by one; a missing file stays in the list (and in the asset)
      if (gen !== _gen || !_refs.includes(ref)) return;
      _buildMesh(ref, _finalCanvas(src, ref.quad, ref.aspect));
      syncPolyRefs(); _h?.changed();
    }).catch(err => { console.warn('[poly refs] could not load', ref.path, err); if (gen === _gen) _h?.changed(); });
  }
  syncPolyRefs();
}
export function disposePolyRefs() {
  for (const v of [..._comp.keys()]) _dropComp(v);         // the merged projection pictures
  _gen++;
  _endDrag(false);
  try { if (_camFn) sceneCore.off?.('controls:change', _camFn); } catch { /* fine */ }
  _camFn = null;
  for (const r of _refs) _disposeMesh(r);
  for (const r of _built) _disposeMesh(r);                  // … and the ones only the undo stack still held
  _built.clear();
  if (_helpers) { for (const c of [..._helpers.children]) { c.geometry?.dispose?.(); c.material?.dispose?.(); } _helpers.parent?.remove(_helpers); _helpers = null; }
  try { _root?.parent?.remove(_root); } catch { /* gone */ }
  _root = null; _refs = []; _h = null; _sel = null; _edit = false;
}

// ── the user's actions ───────────────────────────────────────────────────────
function _changed() { syncPolyRefs(); _h?.changed(); }

/** A picture for the view that is open (in perspective: for Front, and the view goes there). */
export async function addPolyRef() {
  if (!_h) return null;
  const nat = window.sbsNative;
  if (!nat?.openFile) { setStatus('Choosing a picture needs the desktop app.', 'warn', 4000); return null; }
  let view = _h.view();
  if (!REF_VIEWS.includes(view)) { view = 'front'; _h.goView(view); }
  const path = await nat.openFile({ title: `A reference picture for the ${view} view`, filters: [{ name: 'Pictures', extensions: IMG_EXT }] });
  if (!path || !_h) return null;
  let src;
  try { src = await _readImage(path); } catch (err) { setStatus(`That picture could not be opened: ${err?.message || err}`, 'warn', 7000); return null; }
  if (!_h) return null;
  const panel = await import('../ui/poly-editor-panel.js');
  const sq = await panel.askPolySquareUp(src, { title: `A picture for the ${view} view` });
  if (!sq || !_h) return null;
  let canvas, quad = null, aspect = null, sqState = null;
  try {
    if (sq !== 'asis') { quad = sq.quad; aspect = sq.aspect || null; sqState = sq.sq || null; }
    canvas = _finalCanvas(src, quad, aspect);
  } catch (err) { setStatus(`Squaring the picture failed: ${err?.message || err}`, 'warn', 7000); return null; }
  let size = _h.contentSize();
  if (!(size > 0)) size = _viewHeightLocal(_h.anchor()) * 0.6;
  const ref = { id: `r${++_seq}`, view, name: path.split(/[\\/]/).pop() || 'picture', path, quad, aspect, sq: sqState, u: 0, v: 0, size, opacity: 0.6, front: false, visible: true, w: 1, h: 1, mesh: null, mode: null };
  _buildMesh(ref, canvas);
  const add = () => { if (!_refs.includes(ref)) _refs.push(ref); _sel = ref.id; };
  const drop = () => { _refs = _refs.filter(r => r !== ref); if (_sel === ref.id) _sel = null; };
  _h.pin?.();                                                // from the first picture on, the anchor is a fixed point (a new, empty object has none yet)
  add();
  _h.push('Add reference picture', () => { drop(); syncPolyRefs(); }, () => { add(); syncPolyRefs(); });
  _edit = true;                                              // it has just landed: it is placed next
  _changed();
  setStatus(`${ref.name} is on the ${view} view — drag it to move, pull a corner to scale. It is anchored to the object's centre.`, 'success', 7000);
  return ref.id;
}

/** Square the picture again, from its file. */
export async function squarePolyRef(id) {
  const ref = _ref(id); if (!ref || !_h) return false;
  let src;
  try { src = await _readImage(ref.path); } catch (err) { setStatus(`The file of that picture could not be opened: ${err?.message || err}`, 'warn', 7000); return false; }
  if (!_h || !_refs.includes(ref)) return false;
  const panel = await import('../ui/poly-editor-panel.js');
  const sq = await panel.askPolySquareUp(src, { title: ref.name, quad: ref.quad, aspect: ref.aspect, sq: ref.sq || null });
  if (!sq || !_h || !_refs.includes(ref)) return false;
  const before = { quad: ref.quad, aspect: ref.aspect, sq: ref.sq || null }, after = sq === 'asis' ? { quad: null, aspect: null, sq: null } : { quad: sq.quad, aspect: sq.aspect || null, sq: sq.sq || null };
  try { _swapCanvas(ref, _finalCanvas(src, after.quad, after.aspect)); }
  catch (err) { setStatus(`Squaring the picture failed: ${err?.message || err}`, 'warn', 7000); return false; }   // ⬚ V0.3.5.47 (C7) — a failed square-up changed nothing: no undo entry for it
  _setSquare(ref, after);
  src = null;
  // ⬚ V0.3.5.52 (U14) — undo/redo re-read the file instead of holding the 4096² source canvas (up to 64 MB per entry)
  _h.push('Square up reference picture', () => { _resquare(ref, before); syncPolyRefs(); }, () => { _resquare(ref, after); syncPolyRefs(); });
  _changed();
  return true;
}
function _setSquare(ref, s) { ref.quad = s.quad; ref.aspect = s.aspect; ref.sq = s.sq; }
/** ⬚ V0.3.5.52 (U14) — undo/redo of a square-up: the corners now (they are what is saved), the pixels when the file is read again. */
function _resquare(ref, s) {
  _setSquare(ref, s);
  const tok = ref._sqTok = (ref._sqTok || 0) + 1, gen = _gen;   // a quick undo-redo-undo: only the last one draws
  _readImage(ref.path).then(src => {
    if (!_h || gen !== _gen || ref._sqTok !== tok) return;
    _swapCanvas(ref, _finalCanvas(src, ref.quad, ref.aspect));
    _changed();
  }).catch(err => { if (_h && ref._sqTok === tok) setStatus(`The file of that picture could not be opened: ${err?.message || err}`, 'warn', 7000); });
}

export function removePolyRef(id) {
  const ref = _ref(id); if (!ref || !_h) return false;
  const at = _refs.indexOf(ref);
  const drop = () => { _refs = _refs.filter(r => r !== ref); if (_sel === ref.id) _sel = null; };
  const back = () => { if (!_refs.includes(ref)) _refs.splice(Math.min(at, _refs.length), 0, ref); };
  drop();
  _h.push('Remove reference picture', () => { back(); syncPolyRefs(); }, () => { drop(); syncPolyRefs(); });
  _changed();
  return true;
}

/** Select a picture (and go to its view). */
export function selectPolyRef(id) {
  const ref = _ref(id); if (!_h) return;
  _sel = ref ? ref.id : null;
  if (ref && ref.view !== _h.view()) _h.goView(ref.view);
  _changed();
}
export function setPolyRefsEdit(on) {
  if (!_h) return;
  _edit = !!on;
  if (!_edit) _endDrag(false);
  _changed();
}

const _PROPS = new Set(['opacity', 'front', 'visible', 'size', 'u', 'v', 'view', 'name', 'proj', 'stretch']);
let _live = null;   // { id, before } while a slider is dragged: one undo step when it is let go
/**
 * props = { opacity?, front?, visible?, size?, u?, v?, view?, name? }; live = a slider being dragged (no undo
 * step yet); quiet = do not redraw the panel (a field committing as it loses focus to a click on a panel
 * button: a panel rebuilt under that mousedown would swallow the click).
 */
export function setPolyRefProps(id, props, { live = false, quiet = false } = {}) {
  const ref = _ref(id); if (!ref || !_h) return false;
  const keys = Object.keys(props || {}).filter(k => _PROPS.has(k));
  if (!keys.length) return false;
  const snap = () => Object.fromEntries(keys.map(k => [k, ref[k]]));
  const put = (o) => { for (const k of keys) if (o[k] !== undefined) ref[k] = o[k]; };
  if (!_live || _live.id !== id || _live.keys.join() !== keys.join()) _live = { id, keys, before: snap() };
  const next = { ...props };
  if (next.size !== undefined) next.size = Math.max(1e-6, Number(next.size) || ref.size);
  if (next.stretch !== undefined) next.stretch = Math.min(50, Math.max(0.02, Number(next.stretch) || 1));
  if (next.opacity !== undefined) next.opacity = Math.max(0.02, Math.min(1, Number(next.opacity) || 0));
  if (next.view !== undefined && !REF_VIEWS.includes(next.view)) delete next.view;
  put(next);
  syncPolyRefs();
  if (live) return true;
  const before = _live.before, after = snap();
  _live = null;
  if (keys.every(k => before[k] === after[k])) { if (!quiet) _h.changed(); return true; }
  _h.push('Change reference picture', () => { put(before); syncPolyRefs(); }, () => { put(after); syncPolyRefs(); });
  if (!quiet) _h.changed();
  return true;
}

/** One step up (drawn later = on top) or down in the stack. */
export function movePolyRefOrder(id, dir) {
  const ref = _ref(id); if (!ref || !_h) return false;
  const same = _refs.filter(r => r.view === ref.view), k = same.indexOf(ref), other = same[k + (dir > 0 ? 1 : -1)];
  if (!other) return false;
  const swap = () => { const i = _refs.indexOf(ref), j = _refs.indexOf(other); if (i >= 0 && j >= 0) { _refs[i] = other; _refs[j] = ref; } };
  swap();
  _h.push('Reorder reference pictures', () => { swap(); syncPolyRefs(); }, () => { swap(); syncPolyRefs(); });
  _changed();
  return true;
}

// ── grabbing a picture in the view ───────────────────────────────────────────
function _ray(e) {
  const Th = T(), rect = sceneCore.renderer.domElement.getBoundingClientRect(), rc = new Th.Raycaster();
  rc.setFromCamera(new Th.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), sceneCore.camera);
  return rc;
}
/** The cursor on the view's plane through the anchor → (u, v) from the anchor, in the group's units. */
function _planeUV(e, view) {
  const Th = T(), rc = _ray(e), b = _basis(view), a = _h.anchor();
  _h.group.updateWorldMatrix(true, false);
  const pW = _h.group.localToWorld(a.clone()), nW = b.n.clone().transformDirection(_h.group.matrixWorld);
  const hit = rc.ray.intersectPlane(new Th.Plane().setFromNormalAndCoplanarPoint(nW, pW), new Th.Vector3());
  if (!hit) return null;
  const l = _h.group.worldToLocal(hit).sub(a);
  return { u: l.dot(b.right), v: l.dot(b.up) };
}
/** pointerdown in "move / scale" mode → true when a picture (or one of its corners) was grabbed. */
export function polyRefsPointerDown(e) {
  if (!_h || !_edit || _drag) return false;
  const view = _h.view();
  if (!REF_VIEWS.includes(view)) return false;
  const rc = _ray(e), sel = _ref(_sel);
  let grab = null;
  if (sel && sel.mesh?.visible && _helpers?.visible) {
    const hh = rc.intersectObjects(_helpers.children.filter(c => c.userData.corner !== undefined), false)[0];
    if (hh) grab = { ref: sel, corner: hh.object.userData.corner };
  }
  if (!grab) {
    const shown = _refs.filter(r => r.mesh?.visible);
    for (let i = shown.length - 1; i >= 0 && !grab; i--) if (rc.intersectObject(shown[i].mesh, false).length) grab = { ref: shown[i], corner: null };   // the top one first
  }
  if (!grab) return false;
  const p = _planeUV(e, view); if (!p) return false;
  const r = grab.ref;
  _sel = r.id;
  _drag = { ref: r, corner: grab.corner, view, p0: p, u0: r.u, v0: r.v, size0: r.size, stretch0: _stretchOf(r), moved: false, x0: e.clientX, y0: e.clientY };
  _drag.move = (ev) => _dragMove(ev);
  _drag.up = () => _endDrag(true);
  window.addEventListener('pointermove', _drag.move, true);
  window.addEventListener('pointerup', _drag.up, true);
  window.addEventListener('pointercancel', _drag.up, true);
  _changed();
  return true;
}
function _dragMove(e) {
  const d = _drag; if (!d || !_h) return;
  if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;   // a click with a little jitter only selects
  const p = _planeUV(e, d.view); if (!p) return;
  const r = d.ref, own = r.h / r.w;
  if (d.corner == null) { r.u = d.u0 + (p.u - d.p0.u); r.v = d.v0 + (p.v - d.p0.v); }
  else {
    // a corner: the picture grows from the OPPOSITE corner, keeping its proportions — with Ctrl, freely:
    // the width and the height follow the cursor each on its own (the picture is stretched)
    const [sx, sy] = _CORNERS[d.corner], hw = d.size0 / 2, hh = d.size0 * own * d.stretch0 / 2;
    const ou = d.u0 - sx * hw, ov = d.v0 - sy * hh;
    if (e.ctrlKey || e.metaKey) {
      const W = Math.max(0.02 * 2 * hw, (p.u - ou) * sx), Hh = Math.max(0.02 * 2 * hh, (p.v - ov) * sy);
      r.size = W; r.stretch = Math.min(50, Math.max(0.02, Hh / (W * own)));
    } else {
      const s = Math.max(0.02, Math.max(((p.u - ou) * sx) / (2 * hw), ((p.v - ov) * sy) / (2 * hh)));
      r.size = d.size0 * s; r.stretch = d.stretch0;
    }
    r.u = ou + sx * r.size / 2; r.v = ov + sy * _heightOf(r) / 2;
  }
  d.moved = true;
  syncPolyRefs();
}
function _endDrag(commit) {
  const d = _drag; if (!d) return;
  _drag = null;
  window.removeEventListener('pointermove', d.move, true);
  window.removeEventListener('pointerup', d.up, true);
  window.removeEventListener('pointercancel', d.up, true);
  if (!commit) {                                            // cancelled (Esc, the mode ended): the picture goes back to where the drag began
    if (d.moved) { d.ref.u = d.u0; d.ref.v = d.v0; d.ref.size = d.size0; d.ref.stretch = d.stretch0; syncPolyRefs(); }
    return;
  }
  if (!d.moved || !_h) return;
  const r = d.ref, before = { u: d.u0, v: d.v0, size: d.size0, stretch: d.stretch0 }, after = { u: r.u, v: r.v, size: r.size, stretch: _stretchOf(r) };
  const put = (o) => { r.u = o.u; r.v = o.v; r.size = o.size; r.stretch = o.stretch; };
  _h.push(d.corner == null ? 'Move reference picture' : 'Scale reference picture', () => { put(before); syncPolyRefs(); }, () => { put(after); syncPolyRefs(); });
  _h.changed();
}
