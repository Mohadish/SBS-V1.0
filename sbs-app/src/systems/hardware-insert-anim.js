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
import { getComputedLocalPosition, getTotalLocalQuaternion } from '../core/transforms.js';

// Staged actors, keyed by node id:
//   { group, mergedMesh, meshes:[], offsets:[], fadeMat, appearing }
const _staged = new Map();
let _fade     = null;   // { startMs, durationMs, easeFn, resolve }
let _assemble = null;   // { startMs, durationMs, easeFn, resolve }
let _tickUnsub = null;

const _FADE_FALLBACK_FRAC = 0.4;   // assemble also ramps opacity (safety)

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
 * STAGE — build the transient exploded pieces at each actor's TARGET
 * local pose, hide the merged mesh. Pieces start at the exploded offset.
 * Opacity starts at 0 for actors that are APPEARING this step (so the
 * visibility phase fades them in) or 1 for actors already visible.
 *
 * @param {TreeNode[]} actors
 * @param {Set<string>} showingIdSet  node ids that are becoming visible
 *                                    this step (from the visibility prep)
 * @returns {Set<string>} ids actually staged (caller excludes these from
 *                        the obj + visibility channels)
 */
export function stageInsertActors(actors, showingIdSet) {
  _disposeAll(/* restore */ true);   // clear any prior staging first

  const T = window.THREE;
  const tpls = state.get('hardwareTemplates') || [];
  const staged = new Set();

  for (const node of (actors || [])) {
    const merged = node.object3d;
    if (!merged || !merged.parent) continue;
    const tpl = tpls.find(t => t.id === node.templateId);
    if (!tpl) continue;

    let parts;
    try { parts = generateScrewParts(tpl.params || {}, node.washers || null); }
    catch (e) { console.warn('[insert-anim] parts build failed:', e?.message); continue; }

    // Transient group at the node's TARGET local pose (data transform is
    // already at target by transition time → explode is relative to THIS
    // step's final placement, not the step we came from).
    const group = new T.Group();
    group.name = 'sbs:insert-anim';
    const tp = getComputedLocalPosition(node);
    const tq = getTotalLocalQuaternion(node);
    group.position.set(tp[0], tp[1], tp[2]);
    group.quaternion.set(tq[0], tq[1], tq[2], tq[3]);
    const bs = node.baseLocalScale || [1, 1, 1];
    group.scale.set(bs[0], bs[1], bs[2]);
    merged.parent.add(group);

    // FRESH transparent material — NOT a clone of the live material.
    // The live material is screen-door "dither fade" patched: its
    // opacity is driven by a `transitionOpacity` shader uniform, and
    // plain `.opacity` is ignored — so cloning it and animating .opacity
    // produced a hard pop (the V0.2.22.52.4 bug). A plain
    // MeshStandardMaterial with transparent+opacity alpha-blends
    // normally, so the fade actually renders. Colour/metalness/roughness
    // are copied from the live material so the pieces still match.
    const src = Array.isArray(merged.material) ? merged.material[0] : merged.material;
    const fadeMat = new T.MeshStandardMaterial({
      color:     src?.color ? src.color.clone() : new T.Color(0xc0c4cc),
      metalness: src?.metalness ?? 0.65,
      roughness: src?.roughness ?? 0.35,
      transparent: true,
      opacity:   0,                  // always fade in — pieces are brand-new
    });

    const elems = [parts.screw, ...parts.washers.map(w => w.mesh)];
    for (const m of elems) { m.material = fadeMat; group.add(m); }

    // Explode offsets along local +Y (V0.2.22.52.4 layout):
    //   bottom washer → L+X … against-head washer → L+W·X (no swap)
    //   screw → 2L+(W+1)·X  → TIP at L+(W+1)·X = screw length + spacing
    const L = Math.max(0.5, Number(tpl.params?.length) || 20);
    const W = elems.length - 1;
    const ov = Number(node.insertAnim?.distance);
    const X = Number.isFinite(ov) && ov > 0 ? ov : 20;
    const offsets = elems.map((_, j) => {
      if (j === 0) return 2 * L + (W + 1) * X;
      const rankFromBottom = W - (j - 1);
      return L + rankFromBottom * X;
    });

    merged.visible = false;
    elems.forEach((m, i) => { m.position.y = offsets[i]; });

    _staged.set(node.id, { group, mergedMesh: merged, meshes: elems, offsets, fadeMat });
    staged.add(node.id);
  }

  if (staged.size && !_tickUnsub) {
    _tickUnsub = sceneCore.addTickHook(() => _advance(clock.now()));
  }
  return staged;
}

/**
 * FADE — called when the visibility phase fires. Fades the appearing
 * actors' pieces 0→1 over durationMs. Resolves when done (or instantly
 * if nothing is appearing). Non-appearing actors are already opaque.
 */
export function runInsertFade(durationMs, easeFn) {
  if (!_staged.size) return Promise.resolve();
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
      if (s.fadeMat) s.fadeMat.opacity = u;
    }
    if (raw >= 1) { const r = _fade.resolve; _fade = null; r?.(); }
  }

  if (_assemble) {
    const raw = Math.min(1, Math.max(0, (now - _assemble.startMs) / _assemble.durationMs));
    const u   = _assemble.easeFn ? _assemble.easeFn(raw) : raw;
    for (const s of _staged.values()) {
      for (let i = 0; i < s.meshes.length; i++) {
        s.meshes[i].position.y = s.offsets[i] * (1 - u);
      }
      // Safety ramp: if no visibility phase faded the pieces, bring them
      // opaque over the assemble so the screw isn't invisible at the end.
      if (s.fadeMat && s.fadeMat.opacity < 1) {
        s.fadeMat.opacity = Math.max(s.fadeMat.opacity, Math.min(1, raw / _FADE_FALLBACK_FRAC));
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
  _assemble = null;
}
