/**
 * SBS — Hardware insertion-animation defaults + resolution (V0.2.22.58).
 *
 * Every per-instance insertion-anim value can be `null` ("use default").
 * The effective value resolves through three levels, first non-null wins:
 *
 *   per-instance custom → project default (.sbsproj) → system default
 *   (user-settings "Nuts" tab) → hardcoded fallback.
 *
 * This module owns the hardcoded fallbacks, the merge, and the per-node
 * resolver. It imports only state + user-settings, so nothing imports it
 * back (no cycles).
 */

import { state }            from '../core/state.js';
import * as userSettings    from '../core/user-settings.js';

// Last-ditch fallbacks if neither project nor system default is set.
export const HARDWARE_FALLBACK = {
  distance:      20,
  repositionMs:  300,
  tagName:       false,
  tagSize:       'medium',
  tagColor:      '#ffffff',   // tag text colour
  explodeBefore: false,       // show the nut EXPLODED on every step before insertion
  pauseBefore:   true,        // hold before the insertion (so the tags are readable)
  pauseBeforeMs: 300,         // pause duration (ms)
  trajectory:    false,
  lineThickness: 0.5,
  lineGap:       2,          // gap = thickness × lineGap (dash = thickness × 3)
  lineColor:     '#ffaa00',
};

/**
 * The effective DEFAULT set: hardcoded ← system (user-settings.nuts) ←
 * project (state.hardwareDefaults). Each layer overrides the previous
 * for keys it defines.
 */
export function getEffectiveDefaults() {
  let sys = {};
  try { sys = userSettings.get()?.nuts || {}; } catch {}
  const proj = state.get('hardwareDefaults') || {};
  return { ...HARDWARE_FALLBACK, ...sys, ...proj };
}

/**
 * Resolve a hardware-instance node's insertion-anim values. Returns a
 * fully-populated object (no nulls) — per-instance value when set, else
 * the effective default.
 */
export function resolveInsertAnim(node) {
  const def = getEffectiveDefaults();
  const ia  = node?.insertAnim || {};
  const pick = (k) => (ia[k] == null ? def[k] : ia[k]);
  return {
    enabled:       !!ia.enabled,
    stepId:        ia.stepId ?? null,
    distance:      pick('distance'),
    repositionMs:  pick('repositionMs'),
    tagName:       pick('tagName'),
    tagSize:       pick('tagSize'),
    tagColor:      pick('tagColor'),
    explodeBefore: pick('explodeBefore'),
    pauseBefore:   pick('pauseBefore'),
    pauseBeforeMs: pick('pauseBeforeMs'),
    trajectory:    pick('trajectory'),
    lineThickness: pick('lineThickness'),
    lineGap:       pick('lineGap'),
    lineColor:     pick('lineColor'),
  };
}

/**
 * Snapshot the current effective default into the PROJECT (.sbsproj),
 * so this file recalls these values on load regardless of the machine's
 * system settings. Point 4 of the V0.2.22.58 spec — "snapshot current
 * defaults" mode.
 */
export function snapshotProjectDefault() {
  const snap = getEffectiveDefaults();
  state.setState({ hardwareDefaults: { ...snap } });
  state.markDirty?.();
  return snap;
}

/** Clear the project-level override (fall back to system defaults). */
export function clearProjectDefault() {
  state.setState({ hardwareDefaults: null });
  state.markDirty?.();
}

/**
 * Edit the project-level default in place. Seeds from the current
 * effective default the first time (so the unedited fields keep their
 * resolved values), then applies `patch`. Used by the Hardware tab's
 * live defaults editor — any change here becomes the default for every
 * nut in this project, overriding the system default.
 */
export function setProjectDefault(patch = {}) {
  const base = state.get('hardwareDefaults') || getEffectiveDefaults();
  state.setState({ hardwareDefaults: { ...base, ...patch } });
  state.markDirty?.();
  return state.get('hardwareDefaults');
}
