/**
 * SBS — Hardware insertion animation (V0.2.22.52).
 *
 * The explode→assemble effect. When a step plays and one or more
 * hardware instances are flagged as insertion actors for that step,
 * the engine calls beginInsertAnimations(): each actor's screw +
 * washers appear pulled OUT along the insertion axis (staggered), then
 * glide back into the final placed position over the phase duration.
 *
 * Architecture (see hardware-generator.generateScrewParts):
 *   - The live instance is a single merged mesh. We DON'T animate it.
 *   - For the duration of the effect we build TRANSIENT sub-meshes
 *     (screw body + each washer) overlaid at the instance's exact
 *     pose, hide the merged mesh, and animate the transient pieces.
 *   - On completion we dispose the transient pieces and re-show the
 *     merged mesh at its final pose. Nothing about the persistent
 *     scene/tree/colour state changes.
 *
 * Time source = core/clock.js (same as every other transition), so the
 * effect is deterministic under offline export — the export loop's
 * fireSyntheticTick drives advanceInsertAnimations through the tick hook.
 *
 * Insertion axis = the instance's local +Y (head points +Y, shank −Y;
 * the screw inserts in −Y, so it explodes outward in +Y). Because the
 * transient group inherits the instance's world orientation, offsetting
 * a child along LOCAL +Y moves it along the WORLD insertion axis — no
 * world-space math needed.
 */

import { state }       from '../core/state.js';
import { sceneCore }   from '../core/scene.js';
import * as clock      from '../core/clock.js';
import { generateScrewParts } from './hardware-generator.js';

// Active effects, keyed by instance node id. Each entry:
//   { group, mergedMesh, offsets:[], meshes:[], startMs, durationMs, easeFn }
const _active = new Map();
let _onDoneCb   = null;
let _tickUnsub  = null;

/** Are any insertion effects currently playing? */
export function isInsertAnimating() { return _active.size > 0; }

/**
 * Find every hardware instance flagged as an insertion actor for the
 * given step id. Walks the live tree. An actor with stepId === null
 * matches any step (rare; mostly stepId is set).
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
 * Begin the explode→assemble effect for the given actor nodes.
 *
 * @param {TreeNode[]} actors      hardwareInstance nodes (from findActorsForStep)
 * @param {number}     durationMs  total tween time
 * @param {Function}   easeFn      easing fn (raw 0..1 → eased 0..1)
 * @param {Function}   onDone      called once ALL actors finish
 */
export function beginInsertAnimations(actors, durationMs, easeFn, onDone) {
  // Clean any prior effect first (a new step interrupts an in-flight one).
  _teardown(/* restore */ true);

  const valid = (actors || []).filter(Boolean);
  if (!valid.length) { onDone?.(); return; }

  const T = window.THREE;
  const tpls = state.get('hardwareTemplates') || [];
  const startMs = clock.now();

  for (const node of valid) {
    const merged = node.object3d;
    if (!merged || !merged.parent) continue;
    const tpl = tpls.find(t => t.id === node.templateId);
    if (!tpl) continue;

    // Build transient parts from the same spec + washers.
    let parts;
    try {
      parts = generateScrewParts(tpl.params || {}, node.washers || null);
    } catch (e) {
      console.warn('[insert-anim] parts build failed:', e?.message);
      continue;
    }

    // Transient group overlaid on the merged mesh's exact local pose.
    const group = new T.Group();
    group.name = 'sbs:insert-anim';
    group.position.copy(merged.position);
    group.quaternion.copy(merged.quaternion);
    group.scale.copy(merged.scale);
    merged.parent.add(group);

    // Shared material = the instance's current material (so the
    // transient pieces match whatever colour the user applied).
    const mat = Array.isArray(merged.material) ? merged.material[0] : merged.material;

    // Element list in stack order: screw first, then washers top→down.
    const elems = [parts.screw, ...parts.washers.map(w => w.mesh)];
    for (const m of elems) {
      m.material = mat;
      group.add(m);
    }

    // Explode offsets along local +Y (V0.2.22.52.2 — exact spec).
    //   screw body  → L + (W+1)·X   → tip lands at (W+1)·X, leads the stack
    //   washer j    → L + j·X       (j = 1 first/against-head … W last)
    // The +L term lifts EVERY washer clear off the shaft (so the screw
    // slides through them during assembly). X = per-element spacing,
    // default 20 mm, adjustable per-instance via the right-click menu
    // (node.insertAnim.distance). All converge to 0 (assembled) at u=1.
    const L = Math.max(0.5, Number(tpl.params?.length) || 20);
    const W = elems.length - 1;                       // washer count (elems[0]=screw)
    const ov = Number(node.insertAnim?.distance);
    const X = Number.isFinite(ov) && ov > 0 ? ov : 20;
    const offsets = elems.map((_, j) =>
      j === 0 ? L + (W + 1) * X : L + j * X
    );

    // Hide the merged mesh; show the transient group exploded (hard
    // appear — no fade, per the plan).
    merged.visible = false;
    elems.forEach((m, i) => { m.position.y = offsets[i]; });

    _active.set(node.id, {
      group, mergedMesh: merged, meshes: elems, offsets,
      startMs, durationMs: Math.max(1, durationMs), easeFn,
    });
  }

  if (!_active.size) { onDone?.(); return; }

  _onDoneCb = onDone || null;
  // Lazily register the per-frame advance hook (idempotent — only one).
  if (!_tickUnsub) {
    _tickUnsub = sceneCore.addTickHook(() => advanceInsertAnimations(clock.now()));
  }
  // Drive frame 0 immediately so the exploded state shows before the
  // first rAF tick (avoids a one-frame flash of the hidden merged mesh).
  advanceInsertAnimations(startMs);
}

/**
 * Per-tick advance. Lerps each actor's pieces from exploded → assembled.
 * Resolves the onDone callback once every actor reaches progress 1.
 */
export function advanceInsertAnimations(nowMs) {
  if (!_active.size) return;
  let allDone = true;

  for (const [, eff] of _active) {
    const elapsed = nowMs - eff.startMs;
    const raw     = Math.min(1, Math.max(0, elapsed / eff.durationMs));
    const u       = eff.easeFn ? eff.easeFn(raw) : raw;
    // offset shrinks to 0 as u→1: pos = offset * (1 - u)
    for (let i = 0; i < eff.meshes.length; i++) {
      eff.meshes[i].position.y = eff.offsets[i] * (1 - u);
    }
    if (raw < 1) allDone = false;
  }

  if (allDone) _finish();
}

function _finish() {
  _teardown(/* restore */ true);
  const cb = _onDoneCb;
  _onDoneCb = null;
  if (cb) cb();
}

/**
 * Cancel any in-flight effect WITHOUT resolving onDone. Used when a new
 * step interrupts (begin calls this) or on hard scene resets.
 */
export function cancelInsertAnimations() {
  _teardown(/* restore */ true);
  _onDoneCb = null;
}

/**
 * Dispose transient groups + (optionally) restore the merged meshes to
 * visible. restore=false leaves merged meshes hidden — only used in
 * pathological teardown where the caller will re-stage the scene anyway.
 */
function _teardown(restore) {
  for (const [, eff] of _active) {
    if (eff.group?.parent) eff.group.parent.remove(eff.group);
    for (const m of (eff.meshes || [])) {
      m.geometry?.dispose?.();
      // material is shared with the live mesh — do NOT dispose it.
    }
    if (restore && eff.mergedMesh) {
      eff.mergedMesh.visible = true;
    }
  }
  _active.clear();
}
