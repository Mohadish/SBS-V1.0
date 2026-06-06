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

    const appearing = !!appearingIdSet?.has(node.id);
    const prev = fromWorld[node.id];
    const needsReposition = !appearing && !!prev;

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

    // Explode offsets along local +Y (V0.2.22.53.3 layout):
    //   bottom washer → 1·X … against-head washer → W·X (no swap)
    //   screw → L + (W+1)·X   → TIP at (W+1)·X (= 3X for two washers)
    const L = Math.max(0.5, Number(tpl.params?.length) || 20);
    const W = elems.length - 1;
    const ov = Number(node.insertAnim?.distance);
    const X = Number.isFinite(ov) && ov > 0 ? ov : 20;
    const offsets = elems.map((_, j) => {
      if (j === 0) return L + (W + 1) * X;
      const rankFromBottom = W - (j - 1);
      return rankFromBottom * X;
    });

    // Initial piece positions:
    //   needsReposition → assembled (offset 0); the reposition phase
    //     translates the group prev→target AND explodes 0→offset.
    //   else → already exploded (offset); assemble brings them to 0.
    merged.visible = false;
    elems.forEach((m, i) => { m.position.y = needsReposition ? 0 : offsets[i]; });

    const repMs = Number(node.insertAnim?.repositionMs);
    const entry = {
      group, mergedMesh: merged, meshes: elems, offsets,
      needsReposition, targetPos, targetQuat, prevPos, prevQuat,
      repositionMs: Number.isFinite(repMs) && repMs >= 0 ? repMs : 300,
      headPiece: elems[0],          // screw body — tag tracks its head
      tagEl: null, tagShown: false,
      lineObj: null, lineShown: false,
    };

    // ── Spec-name tag (V0.2.22.57) — 2D screen-space label, created
    // hidden; shown at the `overlay` block, hidden when insertion
    // completes. Right edge anchored 10px left of the head, vertically
    // centred, horizontal. Font px from the note size presets.
    if (node.insertAnim?.tagName) {
      const presets = state.get('notePresets') || { small: 18, medium: 36, large: 48 };
      const px = presets[node.insertAnim.tagSize] || presets.medium || 36;
      const txt = tpl.name || `M${tpl.params?.diameter}×${tpl.params?.length}`;
      const div = document.createElement('div');
      div.className = 'sbs-insert-tag';
      div.textContent = txt;
      div.style.cssText =
        'position:fixed;pointer-events:none;white-space:nowrap;display:none;' +
        'color:#fff;font-family:system-ui,sans-serif;font-weight:600;' +
        'text-shadow:0 1px 3px rgba(0,0,0,0.9);z-index:50;' +
        'transform:translate(-100%,-50%);';
      div.style.fontSize = `${px}px`;
      document.body.appendChild(div);
      entry.tagEl = div;
    }

    // ── Trajectory line (V0.2.22.57) — dotted, tip → 8mm past the head
    // bottom, along the insertion axis at the TARGET pose. Static in
    // world space; shown just before insertion, faded over the assemble.
    if (node.insertAnim?.trajectory) {
      const a = targetPos.clone().add(new T.Vector3(0, -L, 0).applyQuaternion(targetQuat));
      const b = targetPos.clone().add(new T.Vector3(0,  8, 0).applyQuaternion(targetQuat));
      const lgeom = new T.BufferGeometry().setFromPoints([a, b]);
      const lmat  = new T.LineDashedMaterial({
        color: 0xffaa00, dashSize: 1.4, gapSize: 0.9,
        transparent: true, opacity: 1, depthTest: false,
      });
      const line = new T.Line(lgeom, lmat);
      line.computeLineDistances();
      line.renderOrder = 999;
      line.visible = false;
      root.add(line);
      entry.lineObj = line;
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
    if (s.tagEl) { s.tagShown = true; s.tagEl.style.display = 'block'; }
  }
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
 */
export function runInsertAssemble(durationMs, easeFn) {
  if (!_staged.size) return Promise.resolve();
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

/** Hard cancel — same as finalize (no separate semantics needed). */
export function cancelInsertAnimations() { finalizeInsertActors(); }

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
      if (s.lineObj?.visible && s.lineObj.material) {
        s.lineObj.material.opacity = 1 - raw;
      }
    }
    if (raw >= 1) {
      // Insertion complete — the spec-name tags disappear now.
      for (const s of _staged.values()) {
        if (s.tagEl) { s.tagShown = false; s.tagEl.style.display = 'none'; }
        if (s.lineObj) s.lineObj.visible = false;
      }
      const r = _assemble.resolve; _assemble = null; r?.();
    }
  }

  // Position the visible spec-name tags: project the head's world point
  // and right-anchor the label 10px to its left, vertically centred.
  _positionTags();
}

function _positionTags() {
  const T = window.THREE;
  const cam = sceneCore.camera;
  const dom = sceneCore.renderer?.domElement;
  if (!cam || !dom) return;
  let rect = null;
  for (const s of _staged.values()) {
    if (!s.tagEl || !s.tagShown) continue;
    if (!rect) rect = dom.getBoundingClientRect();
    const wp = new T.Vector3();
    s.headPiece.getWorldPosition(wp);
    const v = wp.project(cam);                 // NDC, z>1 ⇒ behind camera
    if (v.z > 1) { s.tagEl.style.visibility = 'hidden'; continue; }
    const sx = rect.left + (v.x * 0.5 + 0.5) * rect.width;
    const sy = rect.top  + (-v.y * 0.5 + 0.5) * rect.height;
    s.tagEl.style.visibility = 'visible';
    s.tagEl.style.left = `${sx - 10}px`;       // right edge 10px left of head
    s.tagEl.style.top  = `${sy}px`;            // translate(-100%,-50%) centres it
  }
}

function _disposeAll(restore) {
  for (const s of _staged.values()) {
    if (s.group?.parent) s.group.parent.remove(s.group);
    // Dispose transient GEOMETRY only. The material is SHARED with the
    // live merged mesh (owned by the materials system) — never dispose it.
    for (const m of (s.meshes || [])) m.geometry?.dispose?.();
    // Spec-name tag DOM + trajectory line are owned here — clean them.
    if (s.tagEl?.parentNode) s.tagEl.parentNode.removeChild(s.tagEl);
    if (s.lineObj) {
      if (s.lineObj.parent) s.lineObj.parent.remove(s.lineObj);
      s.lineObj.geometry?.dispose?.();
      s.lineObj.material?.dispose?.();
    }
    if (restore && s.mergedMesh) s.mergedMesh.visible = true;
  }
  _staged.clear();
  _reposition = null;
  _assemble = null;
}
