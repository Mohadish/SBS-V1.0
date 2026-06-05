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
import { materials }   from './materials.js';

/**
 * Resolve the colour a screw should be at THIS step:
 *   step snapshot assignment → project default → live material → grey.
 * Returns a THREE.Color. Mirrors materials' resolution chain so the
 * transient pieces match the assigned preset, not the raw grey.
 */
function _resolveColor(node, merged, stepMaterials) {
  const T = window.THREE;
  const stepPid = stepMaterials?.[node.id];
  const pid = stepPid != null ? stepPid : (materials.meshDefaultColors?.[node.id] ?? null);
  if (pid) {
    const preset = (state.get('colorPresets') || []).find(p => p.id === pid);
    if (preset?.color) { try { return new T.Color(preset.color); } catch {} }
  }
  const src = Array.isArray(merged.material) ? merged.material[0] : merged.material;
  return src?.color ? src.color.clone() : new T.Color(0xc0c4cc);
}

// Staged actors, keyed by node id:
//   { group, mergedMesh, meshes, offsets, fadeMat, appearing,
//     needsReposition, targetPos, targetQuat, prevPos, prevQuat, repositionMs }
const _staged = new Map();
let _fade       = null;  // { startMs, durationMs, easeFn, resolve }
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
 *   showingIdSet  Set<id> nodes becoming visible this step
 *   fromWorld     {id:{position,quaternion}} previous-step world poses
 *   toWorld       {id:{position,quaternion}} this-step world poses
 *   stepMaterials {id: presetId} this step's colour assignments (snapshot)
 * @returns {Set<string>} ids actually staged
 */
export function stageInsertActors(actors, opts = {}) {
  _disposeAll(/* restore */ true);   // clear any prior staging first

  const T = window.THREE;
  const { showingIdSet, fromWorld = {}, toWorld = {}, stepMaterials = {} } = opts;
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

    const appearing = !!showingIdSet?.has(node.id);
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

    // FRESH transparent material. Colour = the screw's RESOLVED preset
    // colour for THIS step (snapshot assignment → project default →
    // template grey), NOT the live material's colour — at staging the
    // live material can still be the previous step's / the raw grey,
    // which is what made the animation render grey (V0.2.22.55 fix).
    const fadeMat = new T.MeshStandardMaterial({
      color:       _resolveColor(node, merged, stepMaterials),
      metalness:   0.65,
      roughness:   0.35,
      transparent: true,
      opacity:     appearing ? 0 : 1,   // fade in only if hidden before
    });

    const elems = [parts.screw, ...parts.washers.map(w => w.mesh)];
    for (const m of elems) { m.material = fadeMat; group.add(m); }

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
    _staged.set(node.id, {
      group, mergedMesh: merged, meshes: elems, offsets, fadeMat, appearing,
      needsReposition, targetPos, targetQuat, prevPos, prevQuat,
      repositionMs: Number.isFinite(repMs) && repMs >= 0 ? repMs : 300,
    });
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
 * FADE — called when the visibility phase fires. Fades the appearing
 * actors' pieces 0→1 over durationMs. Resolves when done (or instantly
 * if nothing is appearing). Non-appearing actors are already opaque.
 */
export function runInsertFade(durationMs, easeFn) {
  // Only run when at least one staged actor is APPEARING this step
  // (was hidden in the previous step). Otherwise there's nothing to
  // fade — the pieces are already opaque.
  const anyAppearing = [..._staged.values()].some(s => s.appearing);
  if (!_staged.size || !anyAppearing) return Promise.resolve();
  return new Promise(resolve => {
    _fade = { startMs: clock.now(), durationMs: Math.max(1, durationMs), easeFn, resolve };
  });
}

/**
 * ASSEMBLE — called when the insert phase fires. Moves the pieces from
 * exploded → final over durationMs, and ensures opacity reaches 1 (so a
 * step with no visibility phase still shows the screw). Resolves on done.
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

  if (_fade) {
    const raw = Math.min(1, Math.max(0, (now - _fade.startMs) / _fade.durationMs));
    const u   = _fade.easeFn ? _fade.easeFn(raw) : raw;
    for (const s of _staged.values()) {
      if (s.appearing && s.fadeMat) s.fadeMat.opacity = u;
    }
    if (raw >= 1) { const r = _fade.resolve; _fade = null; r?.(); }
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
    }
    if (raw >= 1) { const r = _assemble.resolve; _assemble = null; r?.(); }
  }
}

function _disposeAll(restore) {
  for (const s of _staged.values()) {
    if (s.group?.parent) s.group.parent.remove(s.group);
    for (const m of (s.meshes || [])) m.geometry?.dispose?.();
    s.fadeMat?.dispose?.();
    if (restore && s.mergedMesh) s.mergedMesh.visible = true;
  }
  _staged.clear();
  _fade = null;
  _reposition = null;
  _assemble = null;
}
