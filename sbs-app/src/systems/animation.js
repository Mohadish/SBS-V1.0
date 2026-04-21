/**
 * SBS — Animation Preset System
 * ================================
 * Parses animation strings into sequential phases.
 * Provides preset resolution for step transitions.
 *
 * Syntax: 'camera(500), color(300), obj+visibility(400)'
 *   - comma-separated phases
 *   - each phase: one or more type tokens joined by '+', then (durationMs)
 *   - types: camera | color | obj | visibility
 *   - types in same phase run simultaneously
 *   - phases run sequentially
 *
 * Examples:
 *   'camera(500), color(500), visibility(500), obj(500)'  → 4 sequential phases
 *   'camera+color(400), obj+visibility(600)'               → 2 sequential phases
 *   'camera+color+obj+visibility(800)'                     → 1 phase (all at once)
 */

export const DEFAULT_ANIMATION_STR = 'camera(500), color(500), visibility(500), obj(500)';

const VALID_TYPES = new Set(['camera', 'color', 'obj', 'visibility']);

// Matches: 'camera(500)' or 'obj+visibility(300)'
const TOKEN_RE = /([a-zA-Z+]+)\(\s*(\d+)\s*\)/g;

/**
 * Parse animation string → array of phases, or null if invalid/empty.
 *
 * @param {string} str
 * @returns {Array<{types:string[], durationMs:number}>|null}
 */
export function parseAnimation(str) {
  if (!str?.trim()) return null;
  // Strip all whitespace so 'visibility + color ( 600 )' == 'visibility+color(600)'
  const normalized = str.replace(/\s+/g, '');
  const phases = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(normalized)) !== null) {
    const types = m[1]
      .split('+')
      .map(t => t.trim().toLowerCase())
      .filter(t => VALID_TYPES.has(t));
    const durationMs = Math.max(0, parseInt(m[2], 10) || 0);
    if (types.length) phases.push({ types, durationMs });
  }
  return phases.length ? phases : null;
}

/**
 * Check if an animation string parses to a valid set of phases.
 * @param {string} str
 * @returns {boolean}
 */
export function isValidAnimation(str) {
  return parseAnimation(str) !== null;
}

/**
 * Resolve the animation string to use for a step.
 * Priority:
 *   1. Step's assigned preset (animPresetId)
 *   2. Project-level default preset (isDefault = true)
 *   3. null → caller falls back to global duration settings (simultaneous mode)
 *
 * @param {object}   transition       step.transition
 * @param {object[]} animationPresets state.get('animationPresets')
 * @returns {string|null}
 */
export function resolveAnimationString(transition, animationPresets) {
  const presets = animationPresets || [];

  // Step has a specific preset assigned
  const stepPresetId = transition?.animPresetId;
  if (stepPresetId) {
    const preset = presets.find(p => p.id === stepPresetId);
    if (preset?.animation?.trim()) return preset.animation;
  }

  // Project-level default preset
  const def = presets.find(p => p.isDefault);
  if (def?.animation?.trim()) return def.animation;

  // No preset → null → simultaneous fallback (global cam/obj durations)
  return null;
}
