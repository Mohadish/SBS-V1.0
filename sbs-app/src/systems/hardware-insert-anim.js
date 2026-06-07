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
function _makeTagDiv(text, tagSize, colorHex) {
  const presets = state.get('notePresets') || { small: 18, medium: 36, large: 48 };
  const px = presets[tagSize] || presets.medium || 36;
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
  const items = [{
    div: _makeTagDiv(tpl.name || `M${tpl.params?.diameter}×${tpl.params?.length}`, eff.tagSize, eff.tagColor),
    piece: elems[0], localY: 0,
    outerRLocal: _headOuterRadius(tpl.params?.headType, D),
  }];
  parts.washers.forEach((w, i) => {
    const piece = elems[i + 1];   // elems = [screw, ...washer meshes]
    if (!piece) return;
    items.push({
      div: _makeTagDiv(_washerLabel(w.kind, i, tpl.washerNames), eff.tagSize, eff.tagColor),
      piece, localY: w.yTop - w.height / 2,
      outerRLocal: w.outerR,
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
// nodeId → { group, elems:[Mesh], mergedMesh, tagItems:[{div,piece,localY,outerRLocal}] }
const _preview = new Map();
let _previewTickUnsub = null;

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
    if (p.group?.parent) p.group.parent.remove(p.group);
    for (const m of (p.elems || [])) m.geometry?.dispose?.();
    for (const it of (p.tagItems || [])) {
      if (it.div?.parentNode) it.div.parentNode.removeChild(it.div);
    }
    if (p.mergedMesh) p.mergedMesh.visible = true;   // un-hide the assembled nut
  }
  _preview.clear();
  if (_previewTickUnsub) { _previewTickUnsub(); _previewTickUnsub = null; }
}

/**
 * Rebuild the pre-install previews for the given active step. For each
 * actor with `explodeBefore` on, on EVERY step before its insert step,
 * hide the merged mesh and show the exploded pieces at the nut's installed
 * pose. Per-part tags appear too when `tagName` is on. Static — the tick
 * only re-asserts the hidden merged mesh, re-points the shared material,
 * and positions the tags so they ride camera/object moves. (The nut shows
 * only where it's visible, since the pieces share its live material.)
 */
export function refreshPreInstall(activeStepId) {
  clearPreInstall();
  if (!activeStepId) return;
  const T = window.THREE;
  const root = sceneCore.rootGroup;
  if (!T || !root) return;
  const tpls = state.get('hardwareTemplates') || [];
  const diag = (typeof window !== 'undefined' && window.sbsDiag?.preview);
  let seen = 0, gated = 0;

  for (const node of _allActors()) {
    seen++;
    const eff = resolveInsertAnim(node);
    const insertStep = node.insertAnim?.stepId;
    const before = insertStep && _isBeforeInsertStep(insertStep, activeStepId);
    if (diag) console.log('[preview] actor', node.id,
      { explodeBefore: eff.explodeBefore, insertStep, activeStepId, before, hasMerged: !!node.object3d });
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

    // Installed world pose of the nut (where it ends up after insertion).
    merged.updateMatrixWorld(true);
    const pos = new T.Vector3(), quat = new T.Quaternion(), scale = new T.Vector3();
    merged.matrixWorld.decompose(pos, quat, scale);

    const group = new T.Group();
    group.name = 'sbs:insert-preview';
    group.position.copy(pos);
    group.quaternion.copy(quat);
    group.scale.copy(scale);
    root.add(group);

    const elems = [parts.screw, ...parts.washers.map(w => w.mesh)];
    const liveMat = Array.isArray(merged.material) ? merged.material[0] : merged.material;
    const offsets = _explodeOffsets(tpl, eff, elems.length);
    elems.forEach((m, i) => {
      if (liveMat) m.material = liveMat;
      m.visible = true;                 // show the part even if the nut is hidden here
      m.position.y = offsets[i];        // exploded (pre-install) layout
      group.add(m);
    });
    group.updateMatrixWorld(true);
    merged.visible = false;             // the assembled mesh steps aside

    _preview.set(node.id, {
      group, elems, mergedMesh: merged,
      tagItems: _buildTagItems(tpl, eff, parts, elems),
    });
    gated++;
  }

  if (seen > 0) console.log(`[preview] step=${activeStepId} actors=${seen} built=${gated} (set window.sbsDiag={preview:true} for per-actor detail)`);
  if (_preview.size && !_previewTickUnsub) {
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
    // explodeBefore nuts were already shown EXPLODED at the installed pose
    // on every step before this one, so on the insert step they start
    // exploded at the target too — no reposition, just assemble.
    const needsReposition = !appearing && !!prev && !eff.explodeBefore;

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
    //   needsReposition → assembled (offset 0); the reposition phase
    //     translates the group prev→target AND explodes 0→offset.
    //   else → already exploded (offset); assemble brings them to 0.
    merged.visible = false;
    elems.forEach((m, i) => { m.position.y = needsReposition ? 0 : offsets[i]; });

    const repMs = Number(eff.repositionMs);
    const entry = {
      group, mergedMesh: merged, meshes: elems, offsets,
      needsReposition, targetPos, targetQuat, prevPos, prevQuat,
      repositionMs: Number.isFinite(repMs) && repMs >= 0 ? repMs : 300,
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
    if (eff.tagName) {
      entry.tagItems = _buildTagItems(tpl, eff, parts, elems);
      entry.tagShown = needsReposition || !!eff.explodeBefore;
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

function _advance(now) {
  if (!_staged.size) return;

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
      // … while the pieces explode 0 → full offset.
      for (let i = 0; i < s.meshes.length; i++) {
        s.meshes[i].position.y = s.offsets[i] * u;
      }
    }
    if (raw >= 1) { const r = _reposition.resolve; _reposition = null; r?.(); }
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
function _anchorTag(div, worldPos, outerR, rect, cam, camRight) {
  const a = _projectAnchor(worldPos, outerR, rect, cam, camRight);
  if (!a) { div.style.visibility = 'hidden'; return; }
  div.style.visibility = 'visible';
  div.style.left = `${a.cx - a.rimPx - 10}px`;  // 10px left of the rim
  div.style.top  = `${a.cy}px`;                 // translate(-100%,-50%) centres it
}

/**
 * Anchor a tag bound to a PIECE at a local-Y offset. World point =
 * piece.localToWorld(0, localY, 0); rim radius = outerRLocal × world
 * scale (so it tracks a scaled parent folder). Shared by animated +
 * static tags — washers anchor at their own height, like the head.
 */
function _anchorPieceTag(div, piece, localY, outerRLocal, rect, cam, camRight) {
  const T = window.THREE;
  _vWp    = _vWp    || new T.Vector3();
  _vScale = _vScale || new T.Vector3();
  _vWp.set(0, localY || 0, 0);
  piece.localToWorld(_vWp);
  piece.getWorldScale(_vScale);
  _anchorTag(div, _vWp, (outerRLocal || 0) * (_vScale.x || 1), rect, cam, camRight);
}

function _positionTags() {
  const T = window.THREE;
  const cam = sceneCore.camera;
  const dom = sceneCore.renderer?.domElement;
  if (!cam || !dom || !_staged.size) return;
  const rect = dom.getBoundingClientRect();
  const camRight = new T.Vector3();
  cam.matrixWorld.extractBasis(camRight, new T.Vector3(), new T.Vector3());
  for (const s of _staged.values()) {
    if (!s.tagItems) continue;
    for (const it of s.tagItems) {
      if (!it.div) continue;
      // Shown once tagShown is set AND the item's piece is visible —
      // follows camera/object every frame (note-like).
      if (!s.tagShown || !it.piece?.visible) { it.div.style.display = 'none'; continue; }
      it.div.style.display = 'block';
      _anchorPieceTag(it.div, it.piece, it.localY, it.outerRLocal, rect, cam, camRight);
    }
  }
}

/**
 * Per-frame upkeep for the pre-install previews: re-assert the merged mesh
 * hidden, re-point each piece at the live (shared) material so colour
 * changes follow, and position the per-part tags. The pieces are exploded
 * and static, so the tags sit at the real washer heights — no stacking,
 * no overlap.
 */
function _advancePreview() {
  if (!_preview.size) return;
  const T = window.THREE;
  const root = sceneCore.rootGroup;
  const cam = sceneCore.camera;
  const dom = sceneCore.renderer?.domElement;
  // Keep the merged meshes hidden, materials in sync, and the preview group
  // attached — a step rebuild can re-show the merged mesh or detach our
  // group, so we re-assert it every frame.
  for (const p of _preview.values()) {
    if (root && p.group && p.group.parent !== root) root.add(p.group);
    if (p.mergedMesh) {
      p.mergedMesh.visible = false;
      const liveMat = Array.isArray(p.mergedMesh.material)
        ? p.mergedMesh.material[0] : p.mergedMesh.material;
      if (liveMat) for (const m of p.elems) { m.visible = true; if (m.material !== liveMat) m.material = liveMat; }
    }
  }
  if (!cam || !dom) return;
  const rect = dom.getBoundingClientRect();
  const camRight = new T.Vector3();
  cam.matrixWorld.extractBasis(camRight, new T.Vector3(), new T.Vector3());
  for (const p of _preview.values()) {
    for (const it of (p.tagItems || [])) {
      if (!it.div) continue;
      it.div.style.display = 'block';
      _anchorPieceTag(it.div, it.piece, it.localY, it.outerRLocal, rect, cam, camRight);
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
  _assemble = null;
}
