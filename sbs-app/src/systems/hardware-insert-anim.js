/**
 * SBS — Hardware insertion animation (V0.2.22.53).
 *
 * The explode→assemble effect, restructured to the user's algorithm:
 *
 *   1. STAGE (transition start): place the screw + washers at their
 *      PRE-INSERTION (exploded) position, computed relative to THIS
 *      step's FINAL placed pose — not the step we're coming from. The
 *      live merged mesh is hidden; transient sub-meshes take over.
 *   2. The animation string resolves phase by phase. Until the `insert`
 *      phase, the pieces sit at the exploded offset. The `visibility`
 *      phase (whenever it runs) FADES them in at that exploded position
 *      — so a screw hidden on the previous step appears smoothly, not
 *      with a threshold pop.
 *   3. ASSEMBLE (`insert` phase): the pieces glide from exploded → final.
 *   4. FINALIZE (transition end): transient pieces disposed, merged mesh
 *      restored visible at the final pose.
 *
 * Because the transient group is placed at the node's TARGET local pose
 * (data transform is already at target by transition time), the explode
 * offset is always relative to where the screw ENDS on this step. The
 * insert actor is also excluded from the obj + visibility channels — the
 * insert effect owns its motion and reveal completely.
 *
 * Time source = core/clock.js, so the effect is deterministic under
 * offline export (fireSyntheticTick drives the tick hook).
 *
 * Insertion axis = local +Y (head +Y, shank −Y; screw inserts in −Y so
 * it explodes outward in +Y). The transient group inherits the node's
 * target orientation, so offsetting a child along local +Y = world
 * insertion axis.
 */

import { state }       from '../core/state.js';
import { sceneCore }   from '../core/scene.js';
import * as clock      from '../core/clock.js';
import { generateScrewParts } from './hardware-generator.js';
import { resolveInsertAnim }  from './hardware-defaults.js';
import { computeSafeFrameRect } from '../core/safe-frame.js';
import { materials }        from './materials.js';          // 🔩 V0.3.5.65 — the pieces carry the nut's outline
import { setAnchorHostProxy } from './cables.js';           // 🔩 V0.3.5.65 — a cable end on the nut follows its piece

// Staged actors, keyed by node id:
//   { group, mergedMesh, meshes, offsets,
//     needsReposition, targetPos, targetQuat, prevPos, prevQuat, repositionMs }
//
// V0.2.22.56 — the transient pieces SHARE the live merged mesh's
// material (re-pointed every tick). That makes them full participants
// in the colour + visibility channels: the colour transition animates
// the real material (correct RGB + metalness + roughness + everything),
// and the screen-door visibility fade drives transitionOpacity on it —
// both respecting their time-block order in the string. The insert
// effect only owns POSITION (reposition + assemble) and keeps the
// merged mesh hidden (re-asserted each tick) so it never double-renders.
const _staged = new Map();
let _reposition = null;  // { startMs, durationMs, easeFn, resolve }
let _pause      = null;  // { startMs, durationMs, resolve } — hold before insert
let _assemble   = null;  // { startMs, durationMs, easeFn, resolve }
let _tickUnsub  = null;


export function isInsertAnimating() { return _staged.size > 0; }

/**
 * Find every hardware instance flagged as an insertion actor for the
 * given step id.
 */
export function findActorsForStep(stepId) {
  const root = state.get('treeData');
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (n.type === 'hardwareInstance'
        && n.insertAnim?.enabled
        && (n.insertAnim.stepId == null || n.insertAnim.stepId === stepId)) {
      out.push(n);
    }
    for (const c of (n.children || [])) walk(c);
  })(root);
  return out;
}

/** Build a screen-space tag <div> (hidden). Font px from note presets. */
function _makeTagDiv(text, eff) {
  const presets = state.get('notePresets') || { small: 18, medium: 36, large: 48 };
  // V0.3.5.64 — 'custom' = the size he typed (tagPx); else the note size presets
  const custom = Number(eff?.tagPx);
  const px = (eff?.tagSize === 'custom' && custom > 0) ? Math.max(6, Math.min(400, custom)) : (presets[eff?.tagSize] || presets.medium || 36);
  const colorHex = eff?.tagColor;
  const div = document.createElement('div');
  div.className = 'sbs-insert-tag';
  div.textContent = text;
  div.style.cssText =
    'position:fixed;pointer-events:none;white-space:nowrap;display:none;' +
    'font-family:system-ui,sans-serif;font-weight:600;' +
    'text-shadow:0 1px 3px rgba(0,0,0,0.9);z-index:50;' +
    'transform:translate(-100%,-50%);';
  div.style.color = colorHex || '#ffffff';
  div.style.fontSize = `${px}px`;
  document.body.appendChild(div);
  return div;
}

/**
 * Washer tag text. Uses the template's custom washerNames[index] when set
 * (V0.2.22.63), else the generic kind label. No dimensions.
 */
function _washerLabel(kind, index, washerNames) {
  const custom = washerNames?.[index];
  if (custom && String(custom).trim()) return String(custom).trim();
  return kind === 'spring' ? 'Spring washer' : 'Flat washer';
}

/**
 * Explode offsets along local +Y for [screw, ...washers] (V0.2.22.53.3):
 *   bottom washer → 1·X … against-head washer → W·X
 *   screw → L + (W+1)·X  (tip clears the whole washer stack)
 */
function _explodeOffsets(tpl, eff, elemCount) {
  const L = Math.max(0.5, Number(tpl.params?.length) || 20);
  const W = elemCount - 1;
  const X = Math.max(1, Number(eff.distance) || 20);
  return Array.from({ length: elemCount }, (_, j) => {
    if (j === 0) return L + (W + 1) * X;
    const rankFromBottom = W - (j - 1);
    return rankFromBottom * X;
  });
}

/**
 * Build the per-part tag items (screw + one per washer). Each anchors to
 * its OWN piece at a local-Y offset so washers label at their real height.
 * Shared by the live insertion staging and the prev-step pre-install
 * preview. Returns [] when the tag is off.
 */
function _buildTagItems(tpl, eff, parts, elems) {
  if (!eff.tagName) return [];
  const D = Math.max(0.5, Number(tpl.params?.diameter) || 4);
  // V0.3.5.64 — which side of the screw the text sits on, and how far from its rim (his ask)
  const side = eff.tagSide === 'right' ? 'right' : 'left';
  const gap  = Number.isFinite(Number(eff.tagGap)) ? Math.max(0, Number(eff.tagGap)) : 10;
  const items = [{
    div: _makeTagDiv(tpl.name || `M${tpl.params?.diameter}×${tpl.params?.length}`, eff),
    piece: elems[0], localY: 0,
    outerRLocal: _headOuterRadius(tpl.params?.headType, D), side, gap,
  }];
  parts.washers.forEach((w, i) => {
    const piece = elems[i + 1];   // elems = [screw, ...washer meshes]
    if (!piece) return;
    items.push({
      div: _makeTagDiv(_washerLabel(w.kind, i, tpl.washerNames), eff),
      piece, localY: w.yTop - w.height / 2,
      outerRLocal: w.outerR, side, gap,
    });
  });
  return items;
}

// ─── Pre-install preview (V0.2.22.66) ────────────────────────────────────────
// When an insertion actor has `explodeBefore` ("Display exploded before
// insertion") on, EVERY step before its insert step shows the nut in its
// PRE-INSTALL (exploded) configuration: the merged mesh is hidden and the
// screw + each washer are shown as separate pieces spread along the axis,
// at the nut's installed pose. Tags (if tagName) anchor to each separated
// piece — so labels sit at the real washer positions, never overlapping.
// On the insert step the live staging continues from this exploded state.
//
// nodeId → { group, elems:[Mesh], mergedMesh, prevLayerMask, tagItems:[...] }
const _preview = new Map();
let _previewTickUnsub = null;

// 🔦 V0.3.5.61 — "Name tag: only in Spotlight" (his ask). The tags of such a nut show ONLY while it stands in
// a 🔦 spotlight (node.spotlight on the open step) and the step has SETTLED — they are gone the moment the
// next animation starts, and never ride the insertion. Two carriers:
//   · a nut with an exploded preview on this step: its preview entry, gated (spotOnly);
//   · any other nut: a tags-only entry hung on the assembled nut, built the first time the tick sees it
//     spotlighted (_spotCands = who wants it; cheap until one of them is).
// _settled: false from 'step:activate' until 'step:applied' with no transition running. A step id can also
// change without a transition (undo of a step delete…): then 30 quiet ticks settle it (_animProbe).
let _spotCands = [];
let _settled = true, _idleTicks = 0, _animProbe = null;
/** main.js hands in "is a step transition running?" (steps.js imports this module: no import back). */
export function setInsertAnimProbe(fn) { _animProbe = typeof fn === 'function' ? fn : null; }
const _spotShown = (p) => _settled && !!p.node?.spotlight && p.mergedMesh?.visible !== false;

// ── tag fades (V0.3.5.63 — his note: "they fade in nicely but snap out; they need to fade out also") ──
// The spotlight-only tags and the insertion's own tags fade in AND out over TAG_FADE_MS, on the app clock (so
// the export shows the same fade). A tag whose carrier goes away while it shows — the step changes, the
// animation starts — lives on as a GHOST: its text, where it stood, fading out. The plain pre-install preview
// tags stay instant: they are rebuilt on every step change and a fade would make them blink.
const TAG_FADE_MS = 250;
const _ghosts = [];                  // [{ key, div, wp, rimR, alpha }]
let _fadeTPrev = null, _fadeTStaged = null;
/** How far a fade moves this tick (0..1), per ticker; a long gap counts as 100 ms. */
function _fadeK(which) {
  const now = clock.now();
  const last = which === 'staged' ? _fadeTStaged : _fadeTPrev;
  if (which === 'staged') _fadeTStaged = now; else _fadeTPrev = now;
  return last == null ? 0 : Math.max(0, Math.min(100, now - last)) / TAG_FADE_MS;
}
function _fadeItem(it, want, k) {
  const a = it.alpha ?? 0;
  it.alpha = want ? Math.min(1, a + k) : Math.max(0, a - k);
  if (it.alpha > 0 && it.alpha < 1) sceneCore.requestRender?.(120);   // keep the frames coming until the fade lands
  return it.alpha;
}
function _showTagDiv(div, a) { div.style.display = a > 0 ? 'block' : 'none'; div.style.opacity = a < 1 ? String(a) : ''; }
/** The showing tags of a carrier that is going away become ghosts (they keep their element). */
function _ghostFrom(nodeId, items) {
  const T = window.THREE; if (!T) return;
  items.forEach((it, i) => {
    if (!it.div || !it.piece || !((it.alpha ?? 0) > 0.01)) return;
    const wp = new T.Vector3(0, it.localY || 0, 0), sc = new T.Vector3();
    try { it.piece.localToWorld(wp); it.piece.getWorldScale(sc); } catch { return; }
    _ghosts.push({ key: `${nodeId}#${i}`, div: it.div, wp, rimR: (it.outerRLocal || 0) * (sc.x || 1), alpha: it.alpha, side: it.side, gap: it.gap });
    it.div = null;                                           // the ghost owns the element now
  });
}
/** A carrier rebuilt for a nut whose tags were showing takes them over where they are (no blink on a same-step refresh). */
function _adoptGhosts(nodeId, items) {
  for (let i = 0; i < items.length; i++) {
    const gi = _ghosts.findIndex(g => g.key === `${nodeId}#${i}`);
    if (gi < 0) continue;
    const g = _ghosts.splice(gi, 1)[0];
    items[i].alpha = g.alpha;
    if (g.div?.parentNode) g.div.parentNode.removeChild(g.div);
  }
}
function _tickGhosts(k) {
  if (!_ghosts.length) return;
  const T = window.THREE, cam = sceneCore.camera, dom = sceneCore.renderer?.domElement;
  const rect = dom?.getBoundingClientRect?.() || null;
  const camRight = T ? new T.Vector3() : null;
  if (cam && camRight) cam.matrixWorld.extractBasis(camRight, new T.Vector3(), new T.Vector3());
  for (let i = _ghosts.length - 1; i >= 0; i--) {
    const g = _ghosts[i];
    g.alpha = Math.max(0, g.alpha - k);
    if (g.alpha <= 0 || !g.div) { if (g.div?.parentNode) g.div.parentNode.removeChild(g.div); _ghosts.splice(i, 1); continue; }
    _showTagDiv(g.div, g.alpha);
    if (rect && cam) _anchorTag(g.div, g.wp, g.rimR, rect, cam, camRight, g);
    sceneCore.requestRender?.(120);
  }
}

// ── the pieces stand in for the nut: its OUTLINE and what is ANCHORED on it go with them (V0.3.5.65) ──
// His report: with the geometry outline on, the outline stayed where the nut finally sits (the merged mesh is
// only moved to a hidden layer — its outline children were not) and the pieces had none; during the insertion
// there was no outline at all. And a cable end on the screw's head stayed at the assembled place.
const _edgeCache = new Map();        // piece signature → edge geometry (shared; rebuilt per step change otherwise)
function _edgesFor(sig, i, geometry) {
  const key = `${sig}|${i}|${state.get('geometryOutline')?.creaseAngle ?? 35}`;
  let g = _edgeCache.get(key);
  if (!g) {
    if (_edgeCache.size > 400) { for (const x of _edgeCache.values()) x.dispose?.(); _edgeCache.clear(); }   // (three re-uploads one still in use)
    g = materials.buildOutlineEdges(geometry);
    _edgeCache.set(key, g);
  }
  return g;
}
const _partsSig = (tpl, node) => { try { return `${tpl?.id}|${JSON.stringify(tpl?.params || {})}|${JSON.stringify(node?.washers || null)}`; } catch { return String(tpl?.id); } };
/** Each piece gets the nut's two outline passes (the nut's own materials: same colour, opacity and fade). */
function _attachPieceOutlines(entry) {
  const T = window.THREE;
  entry.outlines = [];
  const passes = materials.getOutlinePasses?.(entry.outlineNode);
  if (!T || !passes) return;                                  // outline off (or not built yet): _syncPieceOutlines tries again
  (entry.outlineElems || []).forEach((piece, i) => {
    let geo; try { geo = _edgesFor(entry.outlineSig, i, piece.geometry); } catch { return; }
    const mk = (mat, back) => { const l = new T.LineSegments(geo, mat); l.raycast = () => {}; l.userData.noSelect = true; if (back) l.renderOrder = -1; piece.add(l); return l; };
    entry.outlines.push({ front: mk(passes.front.material, false), back: passes.back ? mk(passes.back.material, true) : null });
  });
}
/** Every tick: the pieces follow the nut's current outline (it can be rebuilt, restyled, switched off); in the preview the nut's own is parked on the hidden layer. */
function _syncPieceOutlines(entry, parkMerged) {
  const passes = materials.getOutlinePasses?.(entry.outlineNode);
  if (passes && !entry.outlines?.length) _attachPieceOutlines(entry);
  for (const o of entry.outlines || []) {
    o.front.visible = !!passes;
    if (passes && o.front.material !== passes.front.material) o.front.material = passes.front.material;
    if (o.back) {
      o.back.visible = !!(passes?.back?.visible);
      if (passes?.back && o.back.material !== passes.back.material) o.back.material = passes.back.material;
    }
  }
  if (parkMerged && passes) {
    if (passes.front.layers.mask !== (1 << PREVIEW_HIDE_LAYER)) passes.front.layers.set(PREVIEW_HIDE_LAYER);
    if (passes.back && passes.back.layers.mask !== (1 << PREVIEW_HIDE_LAYER)) passes.back.layers.set(PREVIEW_HIDE_LAYER);
  }
}
function _dropPieceOutlines(entry, unparkMerged) {
  for (const o of entry.outlines || []) { o.front.parent?.remove(o.front); o.back?.parent?.remove(o.back); }   // geometry: the cache's; materials: the nut's
  entry.outlines = [];
  if (unparkMerged) { const passes = materials.getOutlinePasses?.(entry.outlineNode); passes?.front.layers.set(0); passes?.back?.layers.set(0); }
}

/** Which piece carries a point given in the nut's own frame: a washer for a point in its band outside the shank, else the screw. */
function _pieceFor(elems, washers, shankR, pt) {
  const y = Number(pt?.[1]) || 0, r = Math.hypot(Number(pt?.[0]) || 0, Number(pt?.[2]) || 0);
  for (let i = 0; i < (washers?.length || 0); i++) {
    const w = washers[i];
    if (elems[i + 1] && y <= w.yTop + 1e-6 && y >= w.yTop - w.height - 1e-6 && r > shankR + 1e-6) return elems[i + 1];
  }
  return elems[0] || null;
}
let _vP = null, _vQ = null, _vS = null;
/**
 * The piece standing in for node `nodeId` at a point of its own frame — null when the nut is shown as itself.
 * Posed on demand: the cables' tick runs before this module's, and would otherwise trail the screw by a frame.
 */
export function proxyHostFor(nodeId, localPt) {
  const st = _staged.get(nodeId);
  if (st?.meshes?.length) {
    const now = clock.now();
    if (now !== _advancedAt) _advance(now);                  // posed for this instant (the tick's own call still runs: it is a pure function of the time)
    const piece = _pieceFor(st.meshes, st.washersInfo, st.shankR, localPt);
    piece?.updateWorldMatrix?.(true, false);
    return piece;
  }
  const p = _preview.get(nodeId);
  if (p && !p.tagsOnly && p.elems?.length && p.group && p.mergedMesh) {
    const T = window.THREE; if (!T) return null;
    _vP = _vP || new T.Vector3(); _vQ = _vQ || new T.Quaternion(); _vS = _vS || new T.Vector3();
    p.mergedMesh.updateWorldMatrix(true, false);
    p.mergedMesh.matrixWorld.decompose(_vP, _vQ, _vS);
    p.group.position.copy(_vP); p.group.quaternion.copy(_vQ); p.group.scale.copy(_vS);
    p.group.updateMatrixWorld(true);
    return _pieceFor(p.elems, p.washersInfo, p.shankR, localPt);
  }
  return null;
}
setAnchorHostProxy(proxyHostFor);

/** Tags-only entries for the spotlighted candidates that have none yet. */
function _ensureSpotTags() {
  if (!_settled || !_spotCands.length) return;
  const tpls = state.get('hardwareTemplates') || [];
  for (const node of _spotCands) {
    if (!node.spotlight || _preview.has(node.id)) continue;
    const merged = node.object3d, tpl = tpls.find(t => t.id === node.templateId);
    if (!merged || !tpl) continue;
    let parts;
    try { parts = generateScrewParts(tpl.params || {}, node.washers || null); } catch { continue; }
    // only the parts' measures are needed: every tag hangs on the ASSEMBLED nut, at its part's own height
    const tagItems = _buildTagItems(tpl, resolveInsertAnim(node), parts, Array(1 + parts.washers.length).fill(merged));
    try { parts.screw?.geometry?.dispose?.(); for (const w of parts.washers) w.mesh?.geometry?.dispose?.(); } catch { /* transient */ }
    _adoptGhosts(node.id, tagItems);                         // its tags were showing a moment ago: carry on from there
    _preview.set(node.id, { node, tagsOnly: true, spotOnly: true, group: null, elems: [], mergedMesh: merged, tagItems });
  }
}

// The assembled mesh is hidden from RENDERING by moving it to this layer
// (the camera + raycaster only see layer 0), NOT by setting .visible=false.
// That keeps the visibility system's "appearing" detection honest (it reads
// obj.visible), so a steadily-visible nut isn't faded in on every step.
const PREVIEW_HIDE_LAYER = 1;

/** All hardware instances flagged as insertion actors (any step). */
function _allActors() {
  const root = state.get('treeData');
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (n.type === 'hardwareInstance' && n.insertAnim?.enabled) out.push(n);
    for (const c of (n.children || [])) walk(c);
  })(root);
  return out;
}

/** Playable steps in order. Mirrors StepsManager._isPlayable: skip
 *  base/hidden steps and steps in hidden chapters. */
function _playableSteps() {
  const chapters = state.get('chapters') || [];
  const chHidden = (id) => !!(id && chapters.find(c => c.id === id)?.hidden);
  return (state.get('steps') || []).filter(
    s => s && !s.isBaseStep && !s.hidden && !chHidden(s.chapterId)
  );
}

/** True when `activeStepId` comes BEFORE `insertStepId` in playable order
 *  (i.e. a pre-insertion step where the exploded preview should show). */
function _isBeforeInsertStep(insertStepId, activeStepId) {
  const playable = _playableSteps();
  const insIdx = playable.findIndex(s => s.id === insertStepId);
  const actIdx = playable.findIndex(s => s.id === activeStepId);
  return insIdx >= 0 && actIdx >= 0 && actIdx < insIdx;
}

/** Tear down every pre-install preview: dispose pieces, remove tag DOM,
 *  restore the merged mesh. (Geometry only — the material is shared.) */
export function clearPreInstall() {
  for (const p of _preview.values()) {
    if (p.spotOnly && p.node) _ghostFrom(p.node.id, p.tagItems || []);   // 🔦 V0.3.5.63 — they fade out where they stood
    if (!p.tagsOnly) _dropPieceOutlines(p, true);            // 🔩 V0.3.5.65 — the nut's own outline shows again
    if (p.group?.parent) p.group.parent.remove(p.group);
    // Dispose transient GEOMETRY only — the material is SHARED with the live
    // merged mesh (owned by the materials system); never dispose it.
    for (const m of (p.elems || [])) m.geometry?.dispose?.();
    for (const it of (p.tagItems || [])) {
      if (it.div?.parentNode) it.div.parentNode.removeChild(it.div);
    }
    if (p.mergedMesh && !p.tagsOnly) p.mergedMesh.layers.mask = p.prevLayerMask ?? 1;  // re-render it (a tags-only entry never hid it)
  }
  _preview.clear();
  _spotCands = [];
  if (_ghosts.length) { if (!_previewTickUnsub) _previewTickUnsub = sceneCore.addTickHook(() => _advancePreview()); }   // the ghosts need the tick
  else if (_previewTickUnsub) { _previewTickUnsub(); _previewTickUnsub = null; }
}

/**
 * Rebuild the pre-install previews for the given active step. For each
 * actor with `explodeBefore` on, on EVERY step before its insert step,
 * hide the merged mesh and show the exploded pieces. Per-part tags appear
 * too when `tagName` is on.
 *
 * The preview acts as a live PROXY for the nut: the pieces carry the node
 * id (so a viewport click selects the nut), the group follows the merged
 * mesh's transform every frame (gizmo + obj-channel animation, no jump),
 * and the group's visibility mirrors the merged mesh's HONEST visibility.
 *
 * The assembled mesh is hidden from RENDERING via layers (V0.2.22.70.1),
 * NOT .visible — so the visibility system's appearing-detection (which
 * reads obj.visible) stays honest and the nut isn't faded in on every step.
 * The pieces SHARE the live material, so colour + the genuine fade follow.
 * _advancePreview owns all the per-frame upkeep.
 */
export function refreshPreInstall(activeStepId, opts = {}) {
  // 🔦 V0.3.5.61 — { animating } comes with the step events: true at 'step:activate', the truth at 'step:applied'
  if ('animating' in opts) { _settled = !opts.animating; _idleTicks = 0; }
  clearPreInstall();
  if (!activeStepId) return;
  const T = window.THREE;
  const root = sceneCore.rootGroup;
  if (!T || !root) return;
  const tpls = state.get('hardwareTemplates') || [];
  const diag = (typeof window !== 'undefined' && window.sbsDiag?.preview);
  let seen = 0, gated = 0;
  const why = [];

  for (const node of _allActors()) {
    seen++;
    const eff = resolveInsertAnim(node);
    const insertStep = node.insertAnim?.stepId;
    const before = !!(insertStep && _isBeforeInsertStep(insertStep, activeStepId));
    if (diag) why.push(`explodeBefore=${eff.explodeBefore} insertStep=${insertStep} before=${before} hasMerged=${!!node.object3d} hasTpl=${!!(state.get('hardwareTemplates')||[]).find(t=>t.id===node.templateId)}`);
    if (!eff.explodeBefore) continue;                 // only when "display exploded before"
    if (!insertStep) continue;
    if (!before) continue;                            // only on steps BEFORE the insert step
    const merged = node.object3d;
    if (!merged) continue;
    const tpl = tpls.find(t => t.id === node.templateId);
    if (!tpl) continue;

    let parts;
    try { parts = generateScrewParts(tpl.params || {}, node.washers || null); }
    catch (e) { console.warn('[insert-anim] preview parts failed:', e?.message); continue; }

    const group = new T.Group();
    group.name = 'sbs:insert-preview';
    root.add(group);   // pose + visibility are driven each frame in _advancePreview

    // SHARE the nut's live material (re-pointed each frame) so the pieces
    // carry the exact colour + metalness + the genuine visibility fade.
    const liveMat = Array.isArray(merged.material) ? merged.material[0] : merged.material;
    const elems = [parts.screw, ...parts.washers.map(w => w.mesh)];
    const offsets = _explodeOffsets(tpl, eff, elems.length);
    elems.forEach((m, i) => {
      if (liveMat) m.material = liveMat;
      m.position.y = offsets[i];        // exploded (pre-install) layout
      // Make the pieces pick as the nut, so viewport click selects the node.
      m.userData.nodeId             = node.id;
      m.userData.meshNodeId         = node.id;
      m.userData.hardwareInstanceId = node.id;
      group.add(m);
    });

    // Hide the assembled mesh from rendering via LAYERS (keeps .visible honest).
    const prevLayerMask = merged.layers.mask;
    merged.layers.set(PREVIEW_HIDE_LAYER);

    const entry = {
      group, elems, mergedMesh: merged, prevLayerMask,
      tagItems: _buildTagItems(tpl, eff, parts, elems),
      node, spotOnly: !!(eff.tagName && eff.tagSpotlight),   // 🔦 its tags wait for the spotlight
      // 🔩 V0.3.5.65 — the pieces carry the nut's outline and what is anchored on it
      outlineNode: node.id, outlineElems: elems, outlineSig: _partsSig(tpl, node), outlines: [],
      washersInfo: parts.washers.map(w => ({ yTop: w.yTop, height: w.height })), shankR: (Number(tpl.params?.diameter) || 4) / 2,
    };
    _attachPieceOutlines(entry);
    if (entry.spotOnly && _spotShown(entry)) _adoptGhosts(node.id, entry.tagItems);
    _preview.set(node.id, entry);
    gated++;
  }

  // 🔦 V0.3.5.61 — every other nut whose tags show only in a spotlight is a candidate (see _ensureSpotTags)
  (function walk(n) {
    if (!n) return;
    if (n.type === 'hardwareInstance' && !n.archived && !_preview.has(n.id)) {
      const e = resolveInsertAnim(n);
      if (e.tagName && e.tagSpotlight) _spotCands.push(n);
    }
    for (const c of (n.children || [])) walk(c);
  })(state.get('treeData'));

  if (diag && seen > 0) console.log(`[preview] step=${activeStepId} actors=${seen} built=${gated} | ${why.join(' || ')}`);
  if ((_preview.size || _spotCands.length || _ghosts.length) && !_previewTickUnsub) {
    _previewTickUnsub = sceneCore.addTickHook(() => _advancePreview());
  }
  _advancePreview();
}

/**
 * STAGE — build the transient exploded pieces in WORLD space (added to
 * rootGroup, which is identity), hide the merged mesh.
 *
 * World-space staging (V0.2.22.55) fixes the folder-offset bug: poses
 * come straight from the captured world transforms, so a parent folder
 * that moves between steps doesn't skew the prev↔target conversion.
 *
 * @param {TreeNode[]} actors
 * @param {object} opts
 *   appearingIdSet Set<id> nodes becoming visible this step (kept IN the
 *                  visibility channel so they fade via the real material)
 *   fromWorld      {id:{position,quaternion}} previous-step world poses
 *   toWorld        {id:{position,quaternion}} this-step world poses
 * @returns {Set<string>} ids actually staged
 */
export function stageInsertActors(actors, opts = {}) {
  _disposeAll(/* restore */ true);   // clear any prior staging first

  const T = window.THREE;
  const { appearingIdSet, fromWorld = {}, toWorld = {} } = opts;
  const tpls = state.get('hardwareTemplates') || [];
  const root = sceneCore.rootGroup;
  const staged = new Set();
  if (!root) return staged;

  for (const node of (actors || [])) {
    const merged = node.object3d;
    if (!merged || !merged.parent) continue;
    const tpl = tpls.find(t => t.id === node.templateId);
    if (!tpl) continue;
    const target = toWorld[node.id];
    if (!target) continue;   // need a target world pose to stage against

    let parts;
    try { parts = generateScrewParts(tpl.params || {}, node.washers || null); }
    catch (e) { console.warn('[insert-anim] parts build failed:', e?.message); continue; }

    // Resolve effective values (per-instance custom → project → system).
    const eff = resolveInsertAnim(node);

    const appearing = !!appearingIdSet?.has(node.id);
    const prev = fromWorld[node.id];
    // A screw that was visible last step REPOSITIONS: the group travels
    // prev → target over "Reposition pre-step (ms)". explodeBefore nuts
    // reposition too — but stay EXPLODED the whole way (they were already
    // shown exploded on the prev step), so the travel reads as the exploded
    // cluster gliding into the insertion position before it assembles.
    const needsReposition = !appearing && !!prev;
    const preExploded     = !!eff.explodeBefore;

    const targetPos  = new T.Vector3(target.position[0], target.position[1], target.position[2]);
    const targetQuat = new T.Quaternion(target.quaternion[0], target.quaternion[1], target.quaternion[2], target.quaternion[3]);
    const prevPos    = prev ? new T.Vector3(prev.position[0], prev.position[1], prev.position[2]) : null;
    const prevQuat   = prev ? new T.Quaternion(prev.quaternion[0], prev.quaternion[1], prev.quaternion[2], prev.quaternion[3]) : null;

    // Target world scale (a scaled parent folder scales the screw too).
    const targetScale = new T.Vector3();
    merged.getWorldScale(targetScale);

    const group = new T.Group();
    group.name = 'sbs:insert-anim';
    group.scale.copy(targetScale);
    if (needsReposition) { group.position.copy(prevPos); group.quaternion.copy(prevQuat); }
    else                 { group.position.copy(targetPos); group.quaternion.copy(targetQuat); }
    root.add(group);

    // SHARE the live merged mesh's material (re-pointed each tick). This
    // gives the transient pieces the exact material — full colour +
    // metalness + roughness + every other setting — and lets the colour
    // and visibility channels animate them naturally (the channels drive
    // the merged mesh's material, the pieces follow). The merged mesh is
    // hidden + re-asserted hidden each tick so it never double-renders.
    const elems = [parts.screw, ...parts.washers.map(w => w.mesh)];
    const liveMat = Array.isArray(merged.material) ? merged.material[0] : merged.material;
    for (const m of elems) { if (liveMat) m.material = liveMat; group.add(m); }

    // Explode offsets along local +Y (shared with the pre-install preview).
    const L = Math.max(0.5, Number(tpl.params?.length) || 20);   // for the trajectory line
    const offsets = _explodeOffsets(tpl, eff, elems.length);

    // Initial piece positions:
    //   needsReposition & !preExploded → assembled (offset 0); reposition
    //     translates the group prev→target AND explodes 0→offset.
    //   preExploded → already exploded (offset); reposition just travels,
    //     then assemble brings them to 0.
    //   appearing / no-reposition → exploded (offset); assemble to 0.
    merged.visible = false;
    elems.forEach((m, i) => { m.position.y = (needsReposition && !preExploded) ? 0 : offsets[i]; });

    const repMs   = Number(eff.repositionMs);
    const pauseMs = Number(eff.pauseBeforeMs);
    const entry = {
      // 🔩 V0.3.5.65 — the pieces carry the nut's outline and what is anchored on it
      outlineNode: node.id, outlineElems: elems, outlineSig: _partsSig(tpl, node), outlines: [],
      washersInfo: parts.washers.map(w => ({ yTop: w.yTop, height: w.height })), shankR: (Number(tpl.params?.diameter) || 4) / 2,
      group, mergedMesh: merged, meshes: elems, offsets,
      needsReposition, preExploded, targetPos, targetQuat, prevPos, prevQuat,
      repositionMs: Number.isFinite(repMs) && repMs >= 0 ? repMs : 300,
      // Hold before the insertion so the viewer can read the tags.
      pauseBefore:   !!eff.pauseBefore,
      pauseBeforeMs: Number.isFinite(pauseMs) && pauseMs >= 0 ? pauseMs : 300,
      tagItems: null, tagShown: false,
      lineObj: null, lineShown: false,
    };

    // ── Spec-name + washer tags (per part). Anchored to each piece at a
    // local-Y offset, so washers label at their real height.
    //
    // Timing: explodeBefore nuts carry their tags in from the pre-install
    // preview, so they show from the START of the transition and are
    // removed at the `insert` block (hideInsertTags) — "remove the tags,
    // THEN insert". A non-explode screw that was visible last step also
    // shows from the start; an APPEARING screw waits for the overlay block
    // (showInsertTags) so the label doesn't float over a not-yet-faded-in
    // screw.
    // 🔦 V0.3.5.61 — "only in Spotlight": no tags on the insertion at all (they left when this animation began)
    if (eff.tagName && !eff.tagSpotlight) {
      entry.tagItems = _buildTagItems(tpl, eff, parts, elems);
      entry.tagShown = needsReposition || preExploded;
      for (const it of entry.tagItems) it.alpha = preExploded ? 1 : 0;   // V0.3.5.63 — carried in from the preview: no blink; else they fade in
    }

    // ── Trajectory line — THICK dotted line (V0.2.22.58): a row of dash
    // cylinders (radius = thickness) along the insertion axis at the
    // TARGET pose, tip → 8mm past the head bottom. Dash + gap scale with
    // thickness. Shown just before insertion, faded over the assemble.
    if (eff.trajectory) {
      const thick = Math.max(0.02, Number(eff.lineThickness) || 0.5);
      const gapScale = Math.max(0, Number(eff.lineGap));
      const gapMul = Number.isFinite(gapScale) ? gapScale : 2;
      let color = 0xffaa00;
      try { color = new T.Color(eff.lineColor || '#ffaa00').getHex(); } catch {}
      const a = targetPos.clone().add(new T.Vector3(0, -L, 0).applyQuaternion(targetQuat));
      const b = targetPos.clone().add(new T.Vector3(0,  8, 0).applyQuaternion(targetQuat));
      const { group: lineGroup, mat: lineMat } = _buildDashedTube(a, b, thick, color, gapMul);
      lineGroup.visible = false;
      root.add(lineGroup);
      entry.lineObj = lineGroup;
      entry.lineMat = lineMat;
    }

    _attachPieceOutlines(entry);
    _staged.set(node.id, entry);
    staged.add(node.id);
  }

  if (staged.size && !_tickUnsub) {
    _tickUnsub = sceneCore.addTickHook(() => _advance(clock.now()));
  }
  return staged;
}

/**
 * REPOSITION — for actors that were visible at a different pose last
 * step, translate the group prev → target AND explode the pieces
 * 0 → offset, over the (per-instance) reposition time. Resolves after
 * the longest reposition. No-op if no actor needs it.
 */
export function runInsertReposition(easeFn) {
  const need = [..._staged.values()].filter(s => s.needsReposition);
  if (!need.length) return Promise.resolve();
  const durationMs = Math.max(1, ...need.map(s => s.repositionMs || 300));
  return new Promise(resolve => {
    _reposition = { startMs: clock.now(), durationMs, easeFn, resolve };
  });
}

/**
 * PAUSE — a deliberate hold AFTER the reposition and BEFORE the insertion,
 * so the viewer can read the spec/washer tags before the nut drives in.
 * The pieces sit exploded (tags visible) for the longest enabled pause.
 * Clock-driven so it's deterministic under offline export.
 */
export function runInsertPause() {
  const need = [..._staged.values()].filter(s => s.pauseBefore && s.pauseBeforeMs > 0);
  if (!need.length) return Promise.resolve();
  const durationMs = Math.max(1, ...need.map(s => s.pauseBeforeMs || 0));
  return new Promise(resolve => {
    _pause = { startMs: clock.now(), durationMs, resolve };
  });
}

/**
 * Show the spec-name tags (called at the `overlay` block). The tick
 * positions them each frame; they hide when the assemble completes.
 */
export function showInsertTags() {
  for (const s of _staged.values()) {
    if (s.tagItems?.length) s.tagShown = true;   // tick owns per-frame display
  }
}

/**
 * Hide the spec-name tags — called as the FIRST action of the `insert`
 * block (timed by the animation string), so the tags are removed before
 * the insertion motion runs ("remove the tags, THEN insert"). The tick
 * hides every item next frame via tagShown=false.
 */
export function hideInsertTags() {
  for (const s of _staged.values()) s.tagShown = false;
}

/**
 * Show the trajectory lines (called just before insertion). They fade
 * out over the assemble.
 */
export function showInsertTrajectory() {
  for (const s of _staged.values()) {
    if (s.lineObj) { s.lineShown = true; s.lineObj.visible = true; }
  }
}

/**
 * ASSEMBLE — called when the insert phase fires. Moves the pieces from
 * exploded → final over durationMs. Opacity is owned by the visibility
 * channel (the pieces share the live material). Resolves on done.
 *
 * The tags are removed HERE, as the first act of the insertion (timed by
 * the string's insert block): "remove the tags, THEN insert."
 */
export function runInsertAssemble(durationMs, easeFn) {
  if (!_staged.size) return Promise.resolve();
  hideInsertTags();
  return new Promise(resolve => {
    _assemble = { startMs: clock.now(), durationMs: Math.max(1, durationMs), easeFn, resolve };
  });
}

/**
 * Total wall-clock the SIMULTANEOUS-mode insert sequence will occupy:
 * reposition + pause + assemble (mirrors runInsertReposition / runInsertPause /
 * runInsertAssemble durations). steps.js needs this so the offline export's
 * synthetic-frame _sleep runs long enough to drive the clock-ticked insert
 * phases to completion — otherwise insertSimP never resolves in offline mode
 * (no rAF ticks after the sleep ends) and the export hangs. 0 when nothing is
 * staged. Pass the assemble duration the caller will use (objDur).
 */
export function getStagedInsertTotalMs(assembleMs) {
  if (!_staged.size) return 0;
  const all       = [..._staged.values()];
  const repoNeed  = all.filter(s => s.needsReposition);
  const repo      = repoNeed.length  ? Math.max(1, ...repoNeed.map(s => s.repositionMs || 300)) : 0;
  const pauseNeed = all.filter(s => s.pauseBefore && s.pauseBeforeMs > 0);
  const pause     = pauseNeed.length ? Math.max(1, ...pauseNeed.map(s => s.pauseBeforeMs || 0)) : 0;
  return repo + pause + Math.max(1, assembleMs);
}

/**
 * FINALIZE — dispose transient pieces, restore each merged mesh visible
 * at its final pose. Call once at transition end (both phased + simul
 * paths). Safe to call when nothing is staged.
 */
export function finalizeInsertActors() {
  _disposeAll(/* restore */ true);
  if (_tickUnsub) { _tickUnsub(); _tickUnsub = null; }
}

/**
 * Hard cancel — finalize the live animation AND tear down any prev-step
 * pre-install preview. Called at the top of activateStep; the next step
 * rebuilds its own preview via refreshPreInstall().
 */
export function cancelInsertAnimations() {
  finalizeInsertActors();
  clearPreInstall();
}

// ─── Per-tick ───────────────────────────────────────────────────────────────

let _advancedAt = null;
function _advance(now) {
  if (!_staged.size) return;
  _advancedAt = now;                                         // 🔩 V0.3.5.65 — proxyHostFor asks ahead of the tick, once per instant

  // Every tick: keep the merged mesh hidden (override the visibility
  // channel, which may flip it visible), and re-point the transient
  // pieces at the merged mesh's CURRENT material — the colour channel
  // can REPLACE the material object mid-transition, and we want the
  // pieces to follow the live colour + the screen-door fade uniform.
  for (const s of _staged.values()) {
    if (s.mergedMesh) {
      s.mergedMesh.visible = false;
      const liveMat = Array.isArray(s.mergedMesh.material)
        ? s.mergedMesh.material[0] : s.mergedMesh.material;
      if (liveMat) for (const m of s.meshes) { if (m.material !== liveMat) m.material = liveMat; }
    }
    _syncPieceOutlines(s, false);                            // 🔩 V0.3.5.65
  }

  if (_reposition) {
    const T = window.THREE;
    const raw = Math.min(1, Math.max(0, (now - _reposition.startMs) / _reposition.durationMs));
    const u   = _reposition.easeFn ? _reposition.easeFn(raw) : raw;
    for (const s of _staged.values()) {
      if (!s.needsReposition) continue;
      // Group translates/rotates prev → target …
      s.group.position.lerpVectors(s.prevPos, s.targetPos, u);
      s.group.quaternion.copy(s.prevQuat).slerp(s.targetQuat, u);
      // … while the pieces explode 0 → full offset — UNLESS preExploded,
      // in which case they were already apart and just ride the travel.
      for (let i = 0; i < s.meshes.length; i++) {
        s.meshes[i].position.y = s.preExploded ? s.offsets[i] : s.offsets[i] * u;
      }
    }
    if (raw >= 1) { const r = _reposition.resolve; _reposition = null; r?.(); }
  }

  if (_pause) {
    // Hold — pieces stay where they are (exploded, tags visible). Just wait.
    if (now - _pause.startMs >= _pause.durationMs) {
      const r = _pause.resolve; _pause = null; r?.();
    }
  }

  if (_assemble) {
    const raw = Math.min(1, Math.max(0, (now - _assemble.startMs) / _assemble.durationMs));
    const u   = _assemble.easeFn ? _assemble.easeFn(raw) : raw;
    for (const s of _staged.values()) {
      // Position only — opacity is owned entirely by the visibility
      // channel (V0.2.22.53.4). If visibility sits AFTER insert in the
      // string, an appearing screw assembles while still invisible
      // (opacity 0) and then fades in at the visibility block — "appears
      // after the insert animation", which is the intended behaviour.
      for (let i = 0; i < s.meshes.length; i++) {
        s.meshes[i].position.y = s.offsets[i] * (1 - u);
      }
      // Trajectory line vanishes AS the insertion acts (opacity 1→0).
      if (s.lineObj?.visible && s.lineMat) {
        s.lineMat.opacity = 1 - raw;
      }
    }
    if (raw >= 1) {
      // Insertion complete. Tags were already removed at the insert block
      // (hideInsertTags); just drop the trajectory line and resolve.
      for (const s of _staged.values()) {
        if (s.lineObj) s.lineObj.visible = false;
      }
      const r = _assemble.resolve; _assemble = null; r?.();
    }
  }

  // Position the visible spec-name tags: project the head's world point
  // and right-anchor the label 10px to its left, vertically centred.
  _positionTags();
}

// Scratch vectors reused per frame to avoid per-tag allocation.
let _vWp = null, _vScale = null;

/**
 * Project a world point + rim radius to screen pixels. Returns
 * { cx, cy, rimPx } (centre + rim pixel radius), or null if behind the
 * camera. rect/camRight reused across a batch.
 */
function _projectAnchor(worldPos, outerR, rect, cam, camRight) {
  const c = worldPos.clone().project(cam);
  if (c.z > 1) return null;
  const cx = rect.left + (c.x * 0.5 + 0.5) * rect.width;
  const cy = rect.top  + (-c.y * 0.5 + 0.5) * rect.height;
  const rimW = worldPos.clone().addScaledVector(camRight, outerR || 0);
  const r = rimW.project(cam);
  const rimX = rect.left + (r.x * 0.5 + 0.5) * rect.width;
  return { cx, cy, rimPx: Math.abs(rimX - cx) };
}

/**
 * Anchor one tag <div> 10px to the camera-left of a WORLD POINT's rim,
 * vertically centred. `outerR` is in world units.
 */
function _anchorTag(div, worldPos, outerR, rect, cam, camRight, o = null) {
  const a = _projectAnchor(worldPos, outerR, rect, cam, camRight);
  if (!a) { div.style.visibility = 'hidden'; return; }
  div.style.visibility = 'visible';
  // V0.3.5.64 — `o` = the tag item: side 'left' (default: the text ENDS `gap` px left of the rim) | 'right' (it STARTS `gap` px right of it)
  const right = o?.side === 'right', gap = Number.isFinite(o?.gap) ? o.gap : 10;
  div.style.transform = right ? 'translate(0,-50%)' : 'translate(-100%,-50%)';
  div.style.left = right ? `${a.cx + a.rimPx + gap}px` : `${a.cx - a.rimPx - gap}px`;
  div.style.top  = `${a.cy}px`;                 // the translate centres it on that height
}

/**
 * Anchor a tag bound to a PIECE at a local-Y offset. World point =
 * piece.localToWorld(0, localY, 0); rim radius = outerRLocal × world
 * scale (so it tracks a scaled parent folder). Shared by animated +
 * static tags — washers anchor at their own height, like the head.
 */
function _anchorPieceTag(div, piece, localY, outerRLocal, rect, cam, camRight, o = null) {
  const T = window.THREE;
  _vWp    = _vWp    || new T.Vector3();
  _vScale = _vScale || new T.Vector3();
  _vWp.set(0, localY || 0, 0);
  piece.localToWorld(_vWp);
  piece.getWorldScale(_vScale);
  _anchorTag(div, _vWp, (outerRLocal || 0) * (_vScale.x || 1), rect, cam, camRight, o);
}

function _positionTags() {
  const T = window.THREE;
  const cam = sceneCore.camera;
  const dom = sceneCore.renderer?.domElement;
  if (!cam || !dom || !_staged.size) return;
  const rect = dom.getBoundingClientRect();
  const camRight = new T.Vector3();
  cam.matrixWorld.extractBasis(camRight, new T.Vector3(), new T.Vector3());
  const k = _fadeK('staged');
  for (const s of _staged.values()) {
    if (!s.tagItems) continue;
    for (const it of s.tagItems) {
      if (!it.div) continue;
      // Shown once tagShown is set AND the item's piece is visible —
      // follows camera/object every frame (note-like). V0.3.5.63: fades in and out.
      const a = _fadeItem(it, !!s.tagShown && !!it.piece?.visible, k);
      _showTagDiv(it.div, a);
      if (a > 0) _anchorPieceTag(it.div, it.piece, it.localY, it.outerRLocal, rect, cam, camRight, it);
    }
  }
}

/**
 * Bake the currently-visible insert tags onto a {width × height} 2D canvas for
 * video export. The live tags are screen-space DOM <div>s (not in the WebGL
 * canvas), so the canvas-capture export misses them — same problem the balloon
 * notes had. This re-projects each visible tag at OUTPUT resolution (world →
 * NDC → output px, font scaled by the safe-frame scale) and right-anchors the
 * label 10px left of the rim, vertically centred — mirroring _anchorPieceTag /
 * the .sbs-insert-tag div styling. Returns null when nothing is showing so the
 * compositor can skip the layer. Call AFTER renderFrame(), BEFORE encode.
 */
export function rasterizeTagsLayer({ width, height, still = false }) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  const T = window.THREE;
  const cam = sceneCore?.camera;
  if (!T || !cam) return null;

  // What is showing: the insertion's own tags — and (🔦 V0.3.5.61) the spotlight-only tags, which live on the
  // pre-install previews. ONLY those: the plain preview tags were never part of the export and stay so.
  // V0.3.5.63 — each with its fade (the ticks move it on the export's clock); `still` = a document picture:
  // no time passes there, so a tag is simply on (1) or off, and nothing is fading away.
  const items = [];   // [{ it, a, ghost? }]
  for (const s of _staged.values()) {
    if (!s.tagItems) continue;
    for (const it of s.tagItems) {
      if (!it.div || !it.piece || !it.div.textContent) continue;
      const a = still ? ((s.tagShown && it.piece.visible) ? 1 : 0) : (it.alpha ?? 0);
      if (a > 0) items.push({ it, a });
    }
  }
  _ensureSpotTags();
  for (const p of _preview.values()) {
    if (!p.spotOnly) continue;
    for (const it of (p.tagItems || [])) {
      if (!it.div || !it.piece || !it.div.textContent) continue;
      const a = still ? (_spotShown(p) ? 1 : 0) : (it.alpha ?? 0);
      if (a > 0) items.push({ it, a });
    }
  }
  if (!still) for (const g of _ghosts) if (g.div?.textContent && g.alpha > 0) items.push({ it: g, a: g.alpha, ghost: true });
  if (!items.length) return null;

  // Refresh matrices — export composites BEFORE the next render() (same as notes).
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  sceneCore.scene.updateMatrixWorld(true);

  const out = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = out.getContext('2d', { alpha: true });
  if (!ctx) return null;

  const scale    = computeSafeFrameRect({ width, height }).scale || 1;
  const camRight = new T.Vector3();
  cam.matrixWorld.extractBasis(camRight, new T.Vector3(), new T.Vector3());
  const wp = new T.Vector3(), wscale = new T.Vector3(), rimW = new T.Vector3(), ndc = new T.Vector3();

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  let drew = false;

  {
    for (const { it, a, ghost } of items) {
      const div = it.div;
      const text = div.textContent || '';

      if (ghost) wp.copy(it.wp); else { wp.set(0, it.localY || 0, 0); it.piece.localToWorld(wp); }
      ndc.copy(wp).project(cam);
      if (ndc.z > 1 || ndc.z < -1) continue;
      const cx = ( ndc.x + 1) * width  * 0.5;
      const cy = (-ndc.y + 1) * height * 0.5;

      if (!ghost) it.piece.getWorldScale(wscale);
      rimW.copy(wp).addScaledVector(camRight, ghost ? it.rimR : (it.outerRLocal || 0) * (wscale.x || 1));
      const rimX  = (rimW.project(cam).x + 1) * width * 0.5;
      const rimPx = Math.abs(rimX - cx);

      const fontPx = (parseFloat(div.style.fontSize) || 36) * scale;
      ctx.font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      // Match the div's text-shadow: 0 1px 3px rgba(0,0,0,.9).
      ctx.shadowColor   = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur    = 3 * scale;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 1 * scale;
      ctx.fillStyle = div.style.color || '#ffffff';
      ctx.globalAlpha = a;
      // V0.3.5.64 — the tag's own side and gap (matches the live _anchorTag)
      const tRight = it.side === 'right', tGap = (Number.isFinite(it.gap) ? it.gap : 10) * scale;
      ctx.textAlign = tRight ? 'left' : 'right';
      ctx.fillText(text, tRight ? cx + rimPx + tGap : cx - rimPx - tGap, cy);
      drew = true;
    }
  }
  ctx.globalAlpha = 1;
  ctx.shadowColor = 'transparent';
  return drew ? out : null;
}

/**
 * Per-frame upkeep for the pre-install previews. Each frame:
 *   • re-assert the assembled mesh on the hidden render layer + re-point the
 *     pieces at its LIVE material (the colour channel can swap the material
 *     object), so colour + the genuine visibility fade follow;
 *   • follow the live node transform (gizmo, obj-channel animation, no jump);
 *   • mirror the nut's HONEST visibility onto the group — handles steady
 *     show, genuine fade-in/out, and hard hide, with no per-step blink.
 */
function _advancePreview() {
  // 🔦 a step id that changed with no transition never gets its 'step:applied': quiet ticks settle it
  if (!_settled) { if (_animProbe && !_animProbe()) { if (++_idleTicks >= 30) _settled = true; } else _idleTicks = 0; }
  const k = _fadeK('prev');
  _ensureSpotTags();
  _tickGhosts(k);
  if (!_preview.size) return;   // (the tick stays until the next clearPreInstall: unhooking from inside a tick could skip another hook)
  const T = window.THREE;
  const root = sceneCore.rootGroup;
  const cam = sceneCore.camera;
  const dom = sceneCore.renderer?.domElement;
  const wp = new T.Vector3(), wq = new T.Quaternion(), ws = new T.Vector3();

  for (const [, p] of _preview) {
    if (p.tagsOnly) { p.mergedMesh?.updateWorldMatrix?.(true, false); continue; }   // 🔦 nothing to pose: the tags hang on the nut itself
    if (root && p.group && p.group.parent !== root) root.add(p.group);
    const merged = p.mergedMesh;
    if (merged) {
      if (merged.layers.mask !== (1 << PREVIEW_HIDE_LAYER)) merged.layers.set(PREVIEW_HIDE_LAYER);
      const liveMat = Array.isArray(merged.material) ? merged.material[0] : merged.material;
      if (liveMat) for (const m of p.elems) { if (m.material !== liveMat) m.material = liveMat; }
      merged.updateWorldMatrix(true, false);
      merged.matrixWorld.decompose(wp, wq, ws);
      p.group.position.copy(wp);
      p.group.quaternion.copy(wq);
      p.group.scale.copy(ws);
      p.group.updateMatrixWorld(true);      // so tags track this frame's pose
      _syncPieceOutlines(p, true);          // 🔩 V0.3.5.65
      // merged.visible is the nut's honest visibility (we hid RENDERING via
      // layers, not .visible) — so the pieces follow it, and the shared
      // material carries the fade.
      p.group.visible = merged.visible;
    }
  }

  if (!cam || !dom) return;
  const rect = dom.getBoundingClientRect();
  const camRight = new T.Vector3();
  cam.matrixWorld.extractBasis(camRight, new T.Vector3(), new T.Vector3());
  for (const [, p] of _preview) {
    const show = p.tagsOnly ? _spotShown(p) : (p.group.visible && (!p.spotOnly || _spotShown(p)));
    for (const it of (p.tagItems || [])) {
      if (!it.div) continue;
      if (p.spotOnly) {                                        // 🔦 these fade in and out (V0.3.5.63)
        const a = _fadeItem(it, show, k);
        _showTagDiv(it.div, a);
        if (a > 0) _anchorPieceTag(it.div, it.piece, it.localY, it.outerRLocal, rect, cam, camRight, it);
        continue;
      }
      if (!show) { it.div.style.display = 'none'; continue; }
      it.div.style.display = 'block';
      _anchorPieceTag(it.div, it.piece, it.localY, it.outerRLocal, rect, cam, camRight, it);
    }
  }
}

// ─── Geometry helpers ────────────────────────────────────────────────────────

/** Head's widest radius (world units, scale 1) for tag-rim anchoring. */
function _headOuterRadius(headType, D) {
  switch (headType) {
    case 'flat':    return 1.0   * D;
    case 'flange':  return 0.866 * 1.05 * D;
    case 'hex':     return 0.866 * D;
    case 'button':  return 0.95  * D;
    case 'socket':  return 0.75  * D;
    case 'lowhead': return 0.75  * D;
    case 'none':    return 0.5   * D;
    default:        return 0.875 * D;
  }
}

/**
 * Build a THICK dotted line as a row of dash cylinders from a→b. Radius =
 * thickness; dash length + gap scale with thickness (dash 3×, gap 2×), so
 * the dotted ratio looks consistent at any thickness. Returns the group
 * + the shared material (for opacity fade).
 */
function _buildDashedTube(a, b, thickness, colorHex, gapScale = 2) {
  const T = window.THREE;
  const group = new T.Group();
  const mat = new T.MeshBasicMaterial({
    color: colorHex, transparent: true, opacity: 1, depthTest: false,
  });
  const dir = new T.Vector3().subVectors(b, a);
  const total = dir.length();
  if (total < 1e-6) return { group, mat };
  dir.normalize();
  const dash = Math.max(0.05, thickness * 3);
  const gap  = Math.max(0.01, thickness * gapScale);
  const stride = dash + gap;
  const up = new T.Vector3(0, 1, 0);
  const quat = new T.Quaternion().setFromUnitVectors(up, dir);
  let d = 0;
  while (d < total) {
    const len = Math.min(dash, total - d);
    const cyl = new T.Mesh(new T.CylinderGeometry(thickness, thickness, len, 8, 1), mat);
    cyl.quaternion.copy(quat);
    cyl.position.copy(a).addScaledVector(dir, d + len / 2);
    cyl.renderOrder = 999;
    group.add(cyl);
    d += stride;
  }
  return { group, mat };
}

function _disposeAll(restore) {
  for (const s of _staged.values()) {
    if (s.group?.parent) s.group.parent.remove(s.group);
    // Dispose transient GEOMETRY only. The material is SHARED with the
    // live merged mesh (owned by the materials system) — never dispose it.
    for (const m of (s.meshes || [])) m.geometry?.dispose?.();
    _dropPieceOutlines(s, false);                            // 🔩 V0.3.5.65
    // Spec-name + washer tag DOM + trajectory line are owned here.
    for (const it of (s.tagItems || [])) {
      if (it.div?.parentNode) it.div.parentNode.removeChild(it.div);
    }
    if (s.lineObj) {
      if (s.lineObj.parent) s.lineObj.parent.remove(s.lineObj);
      for (const c of (s.lineObj.children || [])) c.geometry?.dispose?.();
      s.lineMat?.dispose?.();
    }
    if (restore && s.mergedMesh) s.mergedMesh.visible = true;
  }
  _staged.clear();
  _reposition = null;
  _pause = null;
  _assemble = null;
}
