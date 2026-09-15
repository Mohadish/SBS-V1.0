/**
 * SBS — Animation Preset System
 * ================================
 * Parses animation strings into sequential phases.
 * Provides preset resolution for step transitions.
 *
 * Syntax: 'camera(500), color(300), obj+visibility(400)'
 *   - comma-separated phases
 *   - each phase: one or more type tokens joined by '+', then duration
 *   - duration: raw ms (e.g. 500) OR a named variable: AL1 / AL2
 *       AL1 → state.cameraAnimDurationMs (the global "AL1" slider)
 *       AL2 → state.objectAnimDurationMs (the global "AL2" slider)
 *     Variables are resolved fresh on every step transition, so changing
 *     the global slider live-updates every preset that uses the token.
 *   - types: camera | color | obj | visibility | overlay | overlays |
 *            shape | cable | narration | notes | pause
 *   - types in same phase run simultaneously
 *   - phases run sequentially
 *
 * Examples:
 *   'camera(AL1), color(500), visibility(AL2), obj(AL2)'   → AL1/AL2 dynamic
 *   'camera+color(400), obj+visibility(600)'                → 2 sequential phases
 *   'narration(0), camera(500), obj(800)'                   → narration starts in slot 1
 *   'pause(500), camera(500)'                               → 500ms dwell, then camera
 */

export const DEFAULT_ANIMATION_STR =
  'camera(AL1), overlay(500), visibility(500), color(500), cable(500), obj(AL2), shape(500), notes(500), narration(0)';

// `overlays` (lowercased from 'overlayS') = sustained-overlap variant of
// `overlay`. Two-phase fade keeps shared items at 100% visible alpha
// across the whole transition; see beginOverlaySustainedFade in overlay.js.
//
// `shape` channel = dedicated FADE slot for flatShape nodes. Same opacity
// tween machinery as the regular `visibility` channel, just filtered to
// flatShape ids. Lets the author give shapes their own fade duration
// independent of the mesh visibility timing — e.g.
//   camera(500), visibility(500), obj(500), shape(300)
// fades shapes faster than the rest of the scene. When the string has
// no 'shape' slot, shapes fold into the regular `visibility` channel
// (or the default-fallback fade if visibility is also absent).
//
// `narration` channel = trigger slot. When reached, kicks off the step's
// narration audio playback. Slot DURATION is just "when the trigger
// fires"; the audio plays its own natural length (may extend past the
// slot — that's fine, it's parallel to the rest of the animation). When
// `narration` is absent from the string, the legacy auto-play on
// `step:applied` runs as before.
//
// `notes` channel = SHOW/HIDE FADE slot for notes only. Note move /
// panelOffset transform stays on the `obj` phase. Without `notes` in the
// string, fade and move both ride the `obj` window (legacy behaviour).
//
// `pause` channel = dwell slot. Equivalent to an empty time-capsule in
// the visual editor — just waits durationMs before advancing. Useful for
// inserting a deliberate beat between phases.
// `insert` channel (V0.2.22.51) = hardware-insertion animation slot.
// When a step's animation string contains `insert(N)` AND the step has
// one or more hardware instances flagged as insertion actors, reaching
// this phase plays the explode→assemble effect: the screw + its washers
// appear pulled out along the insertion axis (staggered), then glide
// back into the final placed position over N ms. No actors flagged →
// the slot is an inert dwell (like pause). See systems/hardware-insert-
// anim.js for the effect implementation.
// `fade` (V0.3.2.242) is not a channel — it is a MARKER that turns its phase
// into THE INSTANT BLOCK: the purple block the step panel's Instant / Instant
// fade easing puts at the top of the sequence. The channels sharing that
// phase arrive already final; with a duration they arrive behind a dissolve
// (Instant fade), with `(0)` they simply snap (Instant).
//
// The block is authored ONLY by the easing dropdown — never by hand in the
// editor — and it is always first. Its power is what you drag OUT of it: a
// channel moved to a block BELOW is held at its previous state through the
// snap and animates afterwards. "Camera and objects arrive, then the overlay
// appears" is `fade+camera+obj+…(AL1), overlays(AL1)`.
const VALID_TYPES = new Set([
  'camera', 'color', 'obj', 'visibility', 'cable',
  'overlay', 'overlays', 'shape',
  'narration', 'notes', 'pause', 'insert', 'fade',
]);

// The channels the instant block holds when the easing creates it. Everything
// the engine knows about except `pause` (a spacer) and `overlay` (the classic
// crossfade variant — `overlays`, the sustained one, is the default).
export const INSTANT_BLOCK_CHANNELS = [
  'camera', 'obj', 'color', 'visibility', 'cable',
  'shape', 'notes', 'insert', 'overlays', 'narration',
];

/** Build the instant block's token, holding `channels`, `durRaw` long. */
export function makeInstantBlock(channels, durRaw) {
  const chips = (channels || []).filter(c => VALID_TYPES.has(c) && c !== 'fade');
  return `fade${chips.length ? '+' + chips.join('+') : ''}(${durRaw})`;
}

/** True when `str` already carries an instant block. */
export function hasInstantBlock(str) {
  return /(^|[(,+\s])fade([+(]|$)/i.test(String(str || ''));
}

/**
 * ⚡ V0.3.2.258 — put an instant block holding EVERY channel in front of a
 * private animation. The later blocks keep only what the block does not claim
 * (a pause spacer); `overlay` (classic crossfade) is replaced by the block's
 * `overlays`. This is what "arrive instantly, then drag out what should move"
 * means: the user starts from everything snapped.
 */
export function claimAllForInstantBlock(str, durRaw) {
  const block = makeInstantBlock(INSTANT_BLOCK_CHANNELS, durRaw);
  const claimed = new Set([...INSTANT_BLOCK_CHANNELS, 'overlay', 'fade']);
  const rest = (parseAnimationForEdit(str) || [])
    .map(p => ({ ...p, types: (p.types || []).filter(t => !claimed.has(t)) }))
    .filter(p => p.types.length);
  const tail = rest.length ? serializePhasesForEdit(rest) : '';
  return tail ? `${block}, ${tail}` : block;
}

/** Strip the instant block marker, keeping the channels that rode in it. */
export function stripInstantBlock(str) {
  const phases = parseAnimationForEdit(str);
  if (!phases) return str;
  const kept = phases
    .map(p => ({ ...p, types: p.types.filter(t => t !== 'fade') }))
    // A block that held nothing but the marker leaves nothing behind.
    .filter(p => p.types.length);
  return kept.length ? serializePhasesForEdit(kept) : '';
}

// Matches: 'camera(500)' or 'obj+visibility(AL1)' or 'pause(AL2)'.
// Duration is either digits OR the named variable AL1 / AL2 / al1 / al2.
const TOKEN_RE = /([a-zA-Z+]+)\(\s*(\d+|AL[12]|al[12])\s*\)/g;

/**
 * Parse animation string → array of phases, or null if invalid/empty.
 *
 * @param {string} str
 * @param {(token:string)=>number} [resolveToken]
 *   Optional resolver for AL1 / AL2 tokens. When omitted, AL tokens
 *   resolve to 500 (placeholder — used by `isValidAnimation` so syntax
 *   checks don't require the live state). Real step transitions pass a
 *   resolver that reads state.cameraAnimDurationMs / objectAnimDurationMs.
 *
 * @returns {Array<{types:string[], durationMs:number}>|null}
 */
export function parseAnimation(str, resolveToken = null) {
  if (!str?.trim()) return null;
  // Strip all whitespace so 'visibility + color ( 600 )' == 'visibility+color(600)'
  const normalized = str.replace(/\s+/g, '');
  const phases = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(normalized)) !== null) {
    let types = m[1]
      .split('+')
      .map(t => t.trim().toLowerCase())
      .filter(t => VALID_TYPES.has(t));
    // Pause is a SOLO channel — it only makes sense as a pure dwell.
    // `pause+camera(N)` is silently coerced to `camera(N)` (pause dropped).
    // `pause(N)` alone stays as-is.
    if (types.includes('pause') && types.length > 1) {
      types = types.filter(t => t !== 'pause');
    }
    // NOTE: `fade` deliberately does NOT coerce to solo. It is a marker on
    // the phase, and the channels sharing that phase are exactly the ones
    // that arrive already final. (V0.3.2.240 had it solo; that was the
    // version with no way to say "these arrive, those animate after".)
    // Duration: raw int or AL token
    const durRaw = m[2];
    let durationMs;
    if (/^AL[12]$/i.test(durRaw)) {
      const tk = durRaw.toUpperCase();
      durationMs = resolveToken ? Math.max(0, resolveToken(tk) | 0) : 500;
    } else {
      durationMs = Math.max(0, parseInt(durRaw, 10) || 0);
    }
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
 * Parser for the visual editor.
 *
 * Same syntax as parseAnimation, but PRESERVES the raw duration token so
 * `AL1` / `AL2` stay symbolic — letting the editor round-trip the string
 * without losing the variable binding. Use parseAnimation (with a
 * resolver) for the runtime engine; use this for UI state.
 *
 * @returns {Array<{ types:string[], durationRaw:string }>|null}
 */
export function parseAnimationForEdit(str) {
  if (!str?.trim()) return null;
  const normalized = str.replace(/\s+/g, '');
  const phases = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(normalized)) !== null) {
    const rawTypeStr = m[1].toLowerCase();
    // `null(N)` is the editor's marker for an EMPTY-channel time block —
    // a placeholder the user added via "+ Add time block" but hasn't yet
    // populated. The engine's parseAnimation drops these (null isn't in
    // VALID_TYPES) so they're a no-op at runtime; the editor preserves
    // them so the user's empty rows survive save/reload.
    const isExplicitNull = /(^|\+)null($|\+)/.test(rawTypeStr);
    let types = rawTypeStr
      .split('+')
      .map(t => t.trim())
      .filter(t => VALID_TYPES.has(t));
    // Pause-coercion mirrors parseAnimation: pause is solo-only.
    if (types.includes('pause') && types.length > 1) {
      types = types.filter(t => t !== 'pause');
    }
    // Normalise the duration token: AL1/AL2 uppercase, digits as-is.
    const durRaw = /^al[12]$/i.test(m[2]) ? m[2].toUpperCase() : m[2];
    if (types.length || isExplicitNull) {
      phases.push({ types, durationRaw: durRaw });
    }
  }
  return phases.length ? phases : null;
}

/**
 * Inverse of parseAnimationForEdit. Builds an animation string from a
 * structured phases array. Each phase: { types: string[], durationRaw }.
 * `types` is rendered in canonical order (CHANNEL_ORDER), de-duplicated.
 * Empty types[] is rendered as a single `pause` channel.
 */
/**
 * Normalised structural signature of an animation string, used for
 * similarity comparison in the user's preset collection.
 *
 * Per spec: "compare all stored strings in the collection for
 * similarities in order of action and pauses. only ignore (custom ms)".
 *
 * The normalisation:
 *   • channels inside a phase sorted alphabetically (camera+obj ≡ obj+camera)
 *   • pause channels preserved (they're structurally meaningful)
 *   • AL1 / AL2 tokens preserved (user's intent — AL2 ≠ AL1)
 *   • numeric (custom ms) durations replaced with the placeholder `C`
 *     so different custom values still register as identical structure
 *
 * Examples:
 *   `camera(500), obj(AL1)`         → `camera(C), obj(AL1)`
 *   `camera(1200), obj(AL1)`        → `camera(C), obj(AL1)`   ← exact match
 *   `obj+camera(AL2), pause(750)`   → `camera+obj(AL2), pause(C)`
 *
 * Returns '' on invalid input.
 */
export function normalizeStringForCompare(str) {
  const phases = parseAnimationForEdit(str);
  if (!phases) return '';
  return phases.map(p => {
    const types = [...new Set(p.types)].sort().join('+');
    const dur = /^AL[12]$/i.test(p.durationRaw) ? p.durationRaw.toUpperCase() : 'C';
    return `${types}(${dur})`;
  }).join(', ');
}

/**
 * Similarity score between two animation strings, 0..1.
 *
 *   1.00 = exact normalised match (only custom ms values differ, if any)
 *   ~0.95+ = same phase count + same channels-per-phase, AL tokens differ
 *   0..1   = phase-by-phase structural overlap (LCS-style)
 *
 * Used by the r-click "Add to collection" guard to surface near-duplicates.
 */
export function similarityScore(strA, strB) {
  const nA = normalizeStringForCompare(strA);
  const nB = normalizeStringForCompare(strB);
  if (!nA || !nB) return 0;
  if (nA === nB) return 1;

  // Structural pass: ignore durations entirely, compare channel sets per phase.
  const pa = parseAnimationForEdit(strA);
  const pb = parseAnimationForEdit(strB);
  const sigA = pa.map(p => [...new Set(p.types)].sort().join('+'));
  const sigB = pb.map(p => [...new Set(p.types)].sort().join('+'));
  if (sigA.length === 0 || sigB.length === 0) return 0;

  // Quick win: if phase sigs match (ignoring durations entirely), it's a
  // near-match — only AL tokens / custom durations differ. Score 0.95.
  if (sigA.length === sigB.length && sigA.every((s, i) => s === sigB[i])) {
    return 0.95;
  }

  // Otherwise: positional match ratio across the longer phase array.
  let matches = 0;
  const maxLen = Math.max(sigA.length, sigB.length);
  for (let i = 0; i < maxLen; i++) {
    if (sigA[i] && sigB[i] && sigA[i] === sigB[i]) matches++;
  }
  return matches / maxLen;
}

export function serializePhasesForEdit(phases) {
  if (!Array.isArray(phases) || phases.length === 0) return '';
  const tokens = phases.map(p => {
    const seen = new Set();
    let types = (p.types || []).filter(t => {
      if (seen.has(t)) return false;
      seen.add(t);
      return VALID_TYPES.has(t);
    });
    // Pause-coercion: if a phase ended up with pause + other channels
    // (e.g. user dropped a chip on a pause block), drop the pause so the
    // engine doesn't see contradictory tokens.
    if (types.includes('pause') && types.length > 1) {
      types = types.filter(t => t !== 'pause');
    }
    // Empty time block — write `null(0)` as a no-op placeholder. The
    // engine's parseAnimation drops these (null isn't valid). They only
    // exist as a UI affordance — a transient empty slot the user added
    // via "+ Add time block" while planning their phasing. Pause blocks
    // (explicitly types:['pause']) keep their pause token.
    if (types.length === 0) {
      return `null(${p.durationRaw || '0'})`;
    }
    const dur = p.durationRaw && /^(AL[12]|\d+)$/i.test(String(p.durationRaw))
      ? String(p.durationRaw).toUpperCase()
      : '500';
    return `${types.join('+')}(${dur})`;
  });
  return tokens.join(', ');
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
  const str  = _resolvePresetString(transition, animationPresets);
  const ease = transition?.cameraEasing;

  // ⚡🌒 INSTANT / INSTANT FADE (V0.3.2.242) — the easing OWNS the instant
  // block, and the block is always the first phase. `instant` gives it a
  // zero duration (a plain snap); `instantFade` gives it AL1 (dissolve out,
  // snap, dissolve in).
  //
  // The substitution lives HERE, not in the transition engine, because the
  // narration timeline, the video-export frame plan and the render-cache key
  // all resolve the step's animation through this one function. Faking it
  // deeper down would have made the export's idea of the step's length
  // disagree with what the engine actually plays.
  if ((ease === 'instantFade' || ease === 'instant') && !hasInstantBlock(str)) {
    const dur = ease === 'instant' ? '0' : 'AL1';
    // The block holds EVERYTHING unless the step has a private animation of
    // its own. On Default that is the whole meaning of picking the easing;
    // on a NAMED preset it is the honest reading too — a preset is shared
    // across steps and cannot be re-choreographed for this one, so its motion
    // has nowhere to live once the step is set to arrive instantly.
    const priv = transition?.animPresetId === '__private__'
      && transition?.privateAnimation?.trim();
    if (!priv) return makeInstantBlock(INSTANT_BLOCK_CHANNELS, dur);

    // ⚡ V0.3.2.258 — a private animation WITHOUT a block (a file from before
    // the editor wrote it, or an easing set outside the editor): the block
    // takes every channel, as the editor now does (claimAllForInstantBlock).
    // It used to hold only the channels the private string did not schedule —
    // usually none, since a private animation starts as a copy of Default —
    // so the step arrived with an empty block and kept animating smoothly.
    // A private string that already HAS a block is the user's arrangement
    // (channels dragged out of it are meant to move) and is played as-is.
    return claimAllForInstantBlock(str, dur);
  }
  return str;
}

function _resolvePresetString(transition, animationPresets) {
  const presets = animationPresets || [];

  // V0.1.98: per-step PRIVATE animation. The sentinel animPresetId
  // '__private__' means "use this step's own custom string", stored on the
  // transition (never shown as a preset). Takes priority over everything.
  if (transition?.animPresetId === '__private__' && transition?.privateAnimation?.trim()) {
    return transition.privateAnimation;
  }

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
