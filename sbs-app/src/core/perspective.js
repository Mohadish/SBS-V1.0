/**
 * PERSPECTIVE AMOUNT  (V0.3.4.22)
 * ═══════════════════════════════════════════════════════════════════════════
 * One number describes how much perspective a camera has: k = tan(fov/2).
 *
 *   • The frame height at the focus plane is  H = 2 · d · k.
 *   • So holding H while k changes IS the cinematic dolly zoom: the subject
 *     keeps its size and only the perspective opens up or flattens.
 *   • k → 0 is orthographic. That is why k, and not the fov ANGLE, is the
 *     parameter this app interpolates, steps and stores against.
 *
 * Orthographic here is a very long lens, not a second camera: at ORTHO_FOV_DEG
 * the camera sits ~115× the frame height away and parallel edges converge by
 * 0.44% — invisible — while every part of the app that reads `camera.fov`
 * (gizmo, pickers, mirrors, thumbnails, N8AO) keeps working unchanged. See
 * docs/CAMERA-PERSPECTIVE-RESEARCH.md for why a real OrthographicCamera is not
 * worth what it would break.
 *
 * Pure maths — no THREE, no DOM, no state. Everything else builds on this.
 */

const RAD = Math.PI / 180;

/** The flat end of the slider. Displayed as "Orthographic". */
export const ORTHO_FOV_DEG = 0.5;
/** The wide end — wider than this is a fish-eye, not an illustration. */
export const WIDE_FOV_DEG = 78;

export const K_ORTHO = Math.tan(ORTHO_FOV_DEG * RAD / 2);
export const K_WIDE  = Math.tan(WIDE_FOV_DEG  * RAD / 2);

/** k = tan(fov/2) — the perspective amount of a vertical fov in degrees. */
export function kOf(fovDeg) {
  const f = Number(fovDeg);
  if (!Number.isFinite(f)) return K_ORTHO;
  return Math.tan(Math.min(Math.max(f, 0), 179.9) * RAD / 2);
}

/** …and back. */
export function fovOf(k) {
  const v = Number(k);
  if (!Number.isFinite(v) || v <= 0) return ORTHO_FOV_DEG;
  return 2 * Math.atan(v) / RAD;
}

/** Keep k inside the usable family. */
export function clampK(k) {
  const v = Number(k);
  if (!Number.isFinite(v)) return K_ORTHO;
  return Math.min(Math.max(v, K_ORTHO), K_WIDE);
}

/** Same, in degrees — the only place a fov should be clamped. */
export function clampFov(fovDeg) { return fovOf(clampK(kOf(fovDeg))); }

/** Is this camera at the flat end? (A hair of tolerance for float noise.) */
export function isOrtho(fovDeg) { return Number(fovDeg) <= ORTHO_FOV_DEG + 1e-4; }

/** Frame height at distance `dist`. `zoom` is the viewport overscan factor. */
export function frameHeight(dist, fovDeg, zoom = 1) {
  return 2 * Math.abs(Number(dist) || 0) * kOf(fovDeg) / (Number(zoom) || 1);
}

/** The distance that frames `height` at this fov — the dolly-zoom inverse. */
export function distForFrame(height, fovDeg, zoom = 1) {
  const k = kOf(fovDeg);
  return Math.abs(Number(height) || 0) * (Number(zoom) || 1) / (2 * k);
}

/**
 * 35 mm-equivalent focal length, for a label a photographer can read.
 * Vertical: a 24 mm-high frame ⇒ f = 12/k.
 */
export function lensMm(fovDeg) {
  const k = kOf(fovDeg);
  return k > 0 ? 12 / k : Infinity;
}

/** "Orthographic" · "34.0° · 39 mm" — one label for the HUD and the panels. */
export function perspectiveLabel(fovDeg) {
  if (isOrtho(fovDeg)) return 'Orthographic';
  const mm = lensMm(fovDeg);
  return `${Number(fovDeg).toFixed(1)}° · ${mm < 1000 ? Math.round(mm) : Math.round(mm / 10) * 10} mm`;
}

/** The same thing in a couple of characters, for a list row: "Ortho" · "35°". */
export function perspectiveShort(fovDeg) {
  if (isOrtho(fovDeg)) return 'Ortho';
  const f = Number(fovDeg);
  return `${f < 10 ? f.toFixed(1) : Math.round(f)}°`;
}

/**
 * Where the wheel lands: `notches` steps of `speed` along a GEOMETRIC ladder in
 * k, so one notch always feels like the same amount of change, wide or narrow.
 * Positive `notches` = more perspective.
 *
 * The flat end has a detent: the last notch before the floor snaps exactly onto
 * it, so "orthographic" is a place you can land on rather than approach.
 */
export function stepK(k, notches, speed = 1) {
  const from = clampK(k);
  const n = Number(notches) || 0;
  const s = Math.max(0.02, Number(speed) || 1);
  let next = from * Math.exp(n * 0.11 * s);
  if (next <= K_ORTHO * Math.exp(0.11 * s * 0.75)) next = K_ORTHO;   // detent at the flat end
  return clampK(next);
}

/** 0 (orthographic) … 1 (widest) — a geometric slider position for k. */
export function perspectiveFraction(fovDeg) {
  const k = clampK(kOf(fovDeg));
  return Math.log(k / K_ORTHO) / Math.log(K_WIDE / K_ORTHO);
}

/** …and back, for a slider's input handler. */
export function fovForFraction(frac) {
  const t = Math.min(Math.max(Number(frac) || 0, 0), 1);
  return fovOf(K_ORTHO * Math.pow(K_WIDE / K_ORTHO, t));
}

/**
 * THE TRANSITION. Interpolate what the eye actually reads — the framing and
 * the amount of perspective — and DERIVE the distance from them.
 *
 *   k(α) = lerp(k₀, k₁, α)                 linear: k is the perceptual axis
 *   H(α) = H₀ · (H₁/H₀)^α                  geometric: a zoom is multiplicative
 *   d(α) = H(α) / (2·k(α))                 never interpolated
 *
 * Interpolating the distance and the fov separately instead — which is what the
 * app did until now — lets their product wander: a 50° → 1° move draws the
 * subject at 0.076× its size halfway through and pulls it back at the end. That
 * is the "bob" this function exists to kill.
 *
 * @param {{fov:number, dist:number}} from
 * @param {{fov:number, dist:number}} to
 * @param {number} alpha  eased 0…1
 * @returns {{fov:number, dist:number, k:number, height:number}}
 */
export function blendPerspective(from, to, alpha) {
  const a = Math.min(Math.max(Number(alpha) || 0, 0), 1);
  const k0 = kOf(from?.fov), k1 = kOf(to?.fov);
  const d0 = Math.max(Math.abs(Number(from?.dist) || 0), 1e-9);
  const d1 = Math.max(Math.abs(Number(to?.dist)   || 0), 1e-9);
  const H0 = 2 * d0 * k0, H1 = 2 * d1 * k1;
  const k = k0 + (k1 - k0) * a;
  const height = H0 * Math.pow(H1 / H0, a);
  return { fov: fovOf(k), dist: height / (2 * k), k, height };
}

/** Do these two ends differ enough to be worth the dolly-zoom path at all? */
export function perspectiveDiffers(fovA, fovB) {
  return Math.abs(kOf(fovA) - kOf(fovB)) > 1e-4;
}

/**
 * The focus distance of a camera: how far along its OWN view axis the orbit
 * pivot sits. Not |pivot − eye| — the CAD pivot is wherever the cursor last hit
 * a face, often well off the axis, and using the raw distance would frame the
 * wrong plane and reintroduce a bob.
 *
 * Vectors are plain {x,y,z}; `fwd` must be normalised. Falls back when the
 * pivot is behind the camera or implausibly close.
 */
export function focusDistance(eye, fwd, pivot, fallback = 0) {
  const fb = Math.abs(Number(fallback) || 0);
  if (!eye || !fwd || !pivot) return fb;
  const d = (pivot.x - eye.x) * fwd.x + (pivot.y - eye.y) * fwd.y + (pivot.z - eye.z) * fwd.z;
  if (!Number.isFinite(d) || d <= 1e-6) return fb;
  return d;
}
