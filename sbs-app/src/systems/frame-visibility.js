// 🎞 In-frame visibility records — the GPU/wiring half (V0.3.2.255, signatures .259).
//
// "Is this part visible in the scene?" (own flag, ancestors, archive) was the
// best the star rules could ask. This answers the real question — "does it
// occupy pixels in the step's FRAME?" — with one low-resolution ID pass:
// every registered part is painted a flat colour that encodes its index, the
// scene is rendered through the STEP's camera into a 320-wide target, and the
// colours that survive are the parts in frame and not hidden behind others.
// Transparent / x-ray parts never occlude (they are dropped from the pass) and
// count as visible when their box crosses the frustum — over-inclusion on
// purpose: a stale star costs a re-render, a missed one ships a stale frame.
//
// When a record is taken: every time a step is LEFT (activateStep, after
// flushSync — the scene stands at that step's final state, the record uses
// the step's SAVED camera, so orbiting the viewport does not matter), at the
// end of a cache fill, and on demand (Edit ▸ Scan steps for what is in frame…,
// window.sbsDiag.scanFrames()). A step with no record — or whose snapshot was
// rebuilt by a tool since — falls back to the scene rule. Records are bitmasks
// over a project-wide part index (~1 bit per part per step), kept in memory
// and mirrored to <render cache dir>/_visible.json.
//
// 🔏 V0.3.2.259 — SIGNED RECORDS FOR THE CACHE KEY. Every record carries the
// signature of the step as it was when the picture was taken: its tree,
// visibility, transforms, per-step colours, resolved camera, plus the global
// definitions that move pixels (primitive params, shape + hardware templates,
// preset solidness). The render cache narrows a span's visible set with a
// record ONLY while the step still matches that signature; anything else is
// the scene rule. That is the guard against the one failure that must never
// happen — a stale record shipping a stale frame.

import state          from '../core/state.js';
import sceneCore      from '../core/scene.js';
import { materials }  from './materials.js';
import * as projectPaths from '../core/project-paths.js';
import * as F         from './frame-visibility-core.js';

const W = 320;                 // ID-pass width; height follows the export aspect
let _rt = null, _mat = null, _rtH = 0;
let _ids = [];                 // bit index → part (mesh node) id
let _idx = new Map();          // part id → bit index
let _recs = new Map();         // stepId → { mask: Uint8Array, sig: string|null }
const _setMemo = new WeakMap();// mask → Set of ids
let _saveTimer = null;

// ── records ─────────────────────────────────────────────────────────────────
function _setOf(rec) {
  if (!rec) return null;
  let s = _setMemo.get(rec.mask);
  if (!s) { s = F.maskToIds(rec.mask, _ids); _setMemo.set(rec.mask, s); }
  return s;
}
/** Set of part ids in frame for the step, or null when no record exists (stars: staleness handled by invalidate). */
export function visibleIn(stepId) { return _setOf(_recs.get(stepId)); }
/** Same, but ONLY while the step still matches the record's signature (the cache key's rule). */
export function visibleInIfFresh(step) {
  const rec = step?.id ? _recs.get(step.id) : null;
  if (!rec || !rec.sig) return null;
  return rec.sig === stepSignature(step) ? _setOf(rec) : null;
}
export function hasRecord(stepId) { return _recs.has(stepId); }
export function isFresh(step) { const rec = step?.id ? _recs.get(step.id) : null; return !!rec?.sig && rec.sig === stepSignature(step); }
export function invalidate(stepId) { if (_recs.delete(stepId)) _scheduleSave(); }
export function recordCount() { return _recs.size; }

function _bitOf(id) {
  let b = _idx.get(id);
  if (b == null) { b = _ids.length; _ids.push(id); _idx.set(id, b); }
  return b;
}

// ── signatures ──────────────────────────────────────────────────────────────
/** The step's camera as the renderer resolves it: bound template, else its own. */
function _cameraStateOf(step) {
  const b = step?.cameraBinding;
  if (b?.mode === 'template' && b.templateId) {
    const tpl = (state.get('cameraViews') || []).find(v => v.id === b.templateId);
    if (tpl) return tpl;
  }
  return step?.snapshot?.camera || null;
}

// Global definitions that change what occupies pixels without touching any
// step: primitive dimensions, shape + hardware templates, preset solidness.
// Memoised for a moment so a plan over 500 steps computes it once.
let _globalSigAt = 0, _globalSigVal = '';
function _globalSig() {
  const now = Date.now();
  if (now - _globalSigAt < 250 && _globalSigVal) return _globalSigVal;
  const prims = [];
  for (const [id, n] of (state.get('nodeById') || new Map())) {
    if (n?.type === 'primitive') prims.push([id, n.primKind, n.primParams, n.primQuality, n.baseAtOrigin]);
  }
  prims.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const pick = (list, f) => (list || []).map(f).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const payload = JSON.stringify({
    prims,
    shapes: pick(state.get('shapeTemplates'), t => [t.id, t.points ?? t.path ?? t.shapePath ?? null, t.w, t.h, t.width, t.height]),
    hw:     pick(state.get('hardwareTemplates'), t => [t.id, t.kind, t.params, t.washerNames]),
    solid:  pick(state.get('colorPresets'), p => [p.id, p.solidness ?? 1, p.opacity ?? 1, p.flatMirror ?? false]),
  });
  _globalSigVal = F.hashString(payload);
  _globalSigAt = now;
  return _globalSigVal;
}

const _sigMemo = new WeakMap();   // snapshot → { cam, glob, sig }
/** Signature of everything that decides what is in this step's frame. */
export function stepSignature(step) {
  const snap = step?.snapshot;
  if (!snap) return '';
  const cam  = JSON.stringify(_cameraStateOf(step) || null);
  const glob = _globalSig();
  const memo = _sigMemo.get(snap);
  if (memo && memo.cam === cam && memo.glob === glob) return memo.sig;
  const own = F.hashString(JSON.stringify({
    tree: snap.tree || null, vis: snap.visibility || null, xf: snap.transforms || null, mats: snap.materials || null,
    cables: snap.cables || null,
  }));
  const sig = `${own}.${F.hashString(cam)}.${glob}`;
  _sigMemo.set(snap, { cam, glob, sig });
  return sig;
}

// ── the ID pass ─────────────────────────────────────────────────────────────
function _ensureGpu(T, h) {
  if (!_rt || _rtH !== h) {
    _rt?.dispose?.();
    _rt = new T.WebGLRenderTarget(W, h, { depthBuffer: true, stencilBuffer: false });
    _rtH = h;
  }
  if (!_mat) {
    _mat = new T.ShaderMaterial({
      uniforms: { uId: { value: new T.Color(0, 0, 0) } },
      vertexShader:   'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 uId; void main(){ gl_FragColor = vec4(uId, 1.0); }',
      side: T.DoubleSide, toneMapped: false, fog: false, transparent: false,
    });
  }
}

// Anything that lets pixels through: alpha, alpha-test, or the SBS x-ray
// falloff (uSolidness < 1 — the unified shader discards per fragment).
function _isTransparent(m) {
  const mats = Array.isArray(m) ? m : [m];
  return mats.some(x => x && (x.transparent === true || (x.opacity ?? 1) < 0.999 || (x.alphaTest ?? 0) > 0
    || x.userData?.xray || (x.uniforms?.uSolidness?.value ?? 1) < 0.999));
}

/** Camera for a step: its saved state (or bound template), export aspect. */
function _cameraFor(step, T, aspect) {
  const live = sceneCore.camera;
  const cs = _cameraStateOf(step);
  const cam = new T.PerspectiveCamera(cs?.fov ?? live?.fov ?? 45, aspect, live?.near ?? 0.1, live?.far ?? 1e6);
  if (cs?.position)   cam.position.set(...cs.position);   else if (live) cam.position.copy(live.position);
  if (cs?.quaternion) cam.quaternion.set(...cs.quaternion); else if (live) cam.quaternion.copy(live.quaternion);
  if (cs?.up)         cam.up.set(...cs.up);               else if (live) cam.up.copy(live.up);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}

/**
 * Take the record for `step` from the scene AS IT STANDS (caller guarantees
 * the scene is at that step's final state). Returns the number of parts in
 * frame, or -1 when the pass could not run.
 */
export function captureStep(step) {
  const T = window.THREE;
  const r = sceneCore.renderer, scene = sceneCore.scene;
  if (!T || !r || !scene || !step?.id) return -1;
  const exp = state.get('export') || {};
  const aspect = (exp.width > 0 && exp.height > 0) ? exp.width / exp.height : 16 / 9;
  const h = Math.max(16, Math.round(W / aspect));
  _ensureGpu(T, h);
  const cam = _cameraFor(step, T, aspect);

  // Tag every renderable: parts paint their index, everything else paints 0.
  const restore = [];
  const hidden  = [];
  const transparentParts = [];
  const frustum = new T.Frustum().setFromProjectionMatrix(new T.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  const partOf = new Map();
  for (const [id, mesh] of materials.meshById) if (mesh) partOf.set(mesh, id);
  scene.traverse(obj => {
    if (!(obj.isMesh || obj.isLine || obj.isPoints || obj.isSprite)) return;
    const id = partOf.get(obj);
    if (id != null && obj.isMesh && _isTransparent(obj.material)) {
      // Never occludes; counted by frustum below when it is actually shown.
      if (obj.visible) { hidden.push(obj); obj.visible = false; transparentParts.push({ obj, id }); }
      return;
    }
    const rgb = id != null ? F.idToRgb(_bitOf(id)) : [0, 0, 0];
    restore.push([obj, obj.onBeforeRender]);
    obj.onBeforeRender = () => { _mat.uniforms.uId.value.setRGB(rgb[0], rgb[1], rgb[2]); _mat.uniformsNeedUpdate = true; };
  });

  const prevTarget = r.getRenderTarget();
  const prevOverride = scene.overrideMaterial;
  const prevAutoClear = r.autoClear;
  const prevClear = new T.Color(); r.getClearColor(prevClear); const prevAlpha = r.getClearAlpha();
  const pixels = new Uint8Array(W * h * 4);
  try {
    scene.overrideMaterial = _mat;
    r.autoClear = true;
    r.setClearColor(0x000000, 1);
    r.setRenderTarget(_rt);
    r.clear(true, true, true);
    r.render(scene, cam);
    r.readRenderTargetPixels(_rt, 0, 0, W, h, pixels);
  } catch (e) {
    console.warn('[frame-vis] ID pass failed:', e?.message);
    return -1;
  } finally {
    scene.overrideMaterial = prevOverride;
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    r.setClearColor(prevClear, prevAlpha);
    for (const [obj, fn] of restore) obj.onBeforeRender = fn;
    for (const obj of hidden) obj.visible = true;
  }

  const indices = F.indicesInPixels(pixels);
  const box = new T.Box3();
  for (const { obj, id } of transparentParts) {
    // A shown transparent part inside the frustum counts (it cannot hide anything, so it is never "behind").
    let eff = true; for (let p = obj; p; p = p.parent) if (p.visible === false && p !== obj) { eff = false; break; }
    if (!eff) continue;
    box.setFromObject(obj);
    if (!box.isEmpty() && frustum.intersectsBox(box)) indices.add(_bitOf(id));
  }
  _recs.set(step.id, { mask: F.maskFromIndices(indices, _ids.length), sig: stepSignature(step) });
  _scheduleSave();
  return indices.size;
}

/** Record the ACTIVE step from the scene as it stands. */
export function captureActive() {
  const id = state.get('activeStepId');
  const step = (state.get('steps') || []).find(s => s.id === id);
  return step ? captureStep(step) : -1;
}

// ── persistence: <render cache dir>/_visible.json ──────────────────────────
function _filePath() {
  try { const rc = projectPaths.renderCacheDir(); const dir = rc?.dir || rc?.legacy || null; return dir ? `${dir}/_visible.json` : null; }
  catch { return null; }
}
function _scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; save().catch(e => console.warn('[frame-vis] save failed:', e?.message)); }, 2000);
}
export async function save() {
  const p = _filePath();
  if (!p || !window.sbsNative?.writeFile || !_recs.size) return false;
  const r = await window.sbsNative.writeFile(p, F.serializeRecords(_ids, _recs));
  return !!r?.ok;
}
export async function load() {
  _ids = []; _idx = new Map(); _recs = new Map();
  const p = _filePath();
  if (!p || !window.sbsNative?.readFile) return 0;
  try {
    if (window.sbsNative.fileExists && !(await window.sbsNative.fileExists(p))) return 0;
    const r = await window.sbsNative.readFile(p, 'utf8');
    if (!r?.ok) return 0;
    const { ids, records } = F.parseRecords(r.data);
    _ids = ids; _idx = new Map(ids.map((id, i) => [id, i])); _recs = records;
    console.log(`[frame-vis] ${records.size} step record(s) loaded (${ids.length} parts indexed)`);
    return records.size;
  } catch (e) { console.warn('[frame-vis] load failed:', e?.message); return 0; }
}

// ── on-demand scan: visit every playable step instantly and record it ──────
export async function scanAllSteps({ settleMs = 120, onProgress = null, signal = null } = {}) {
  const { steps } = await import('./steps.js');
  const startId = state.get('activeStepId');
  const list = steps.getVisibleSteps();
  const t0 = performance.now();
  let n = 0, i = 0;
  for (const s of list) {
    if (signal?.aborted) break;
    i++;
    onProgress?.({ index: i, total: list.length, step: s });
    await steps.activateStep(s.id, false);
    await new Promise(r => setTimeout(r, settleMs));
    if (captureStep(s) >= 0) n++;
  }
  if (startId) await steps.activateStep(startId, false);
  await save();
  const ms = Math.round(performance.now() - t0);
  console.log(`[frame-vis] scanned ${n}/${list.length} step(s) in ${ms} ms`);
  return { scanned: n, total: list.length, ms };
}

// ── init ────────────────────────────────────────────────────────────────────
let _inited = false;
export function initFrameVisibility() {
  if (_inited) return;
  _inited = true;
  // The leaving step's final state is on screen (activateStep: snap → flushSync → here).
  // Recorded when the step was EDITED (it wears the star), has no record yet, or
  // its record no longer matches it — plain navigation through recorded,
  // unchanged steps costs nothing.
  state.on('step:leaving', ({ stepId } = {}) => {
    const step = (state.get('steps') || []).find(s => s.id === stepId);
    if (!step || step.isBaseStep) return;
    if (step.altered !== true && isFresh(step)) return;
    try { captureStep(step); } catch (e) { console.warn('[frame-vis] capture failed:', e?.message); }
  });
  state.on('project:modelsSettled', () => { load().catch(() => {}); });
  if (typeof window !== 'undefined') {
    window.sbsDiag = window.sbsDiag || {};
    window.sbsDiag.scanFrames = () => scanAllSteps();
    window.sbsDiag.frameVis = (stepId) => {
      const id = stepId || state.get('activeStepId');
      const step = (state.get('steps') || []).find(s => s.id === id);
      const s = visibleIn(id);
      console.log(s ? `${s.size} part(s) in frame — ${isFresh(step) ? 'record is CURRENT (usable by the cache key)' : 'record is STALE (stars only; re-taken when the step is left)'}` : 'no record for this step');
      return s;
    };
  }
}
