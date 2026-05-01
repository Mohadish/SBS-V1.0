/**
 * Animation clock — single source of "now" for every per-frame
 * animation system (materials, cables-render, overlay fades, …).
 *
 * Live playback uses real time (performance.now). Offline export swaps
 * in a synthetic clock so animation phases advance on a deterministic
 * schedule that's independent of host throttling.
 *
 * Anywhere an animation system caches a `startMs` and computes
 * `elapsed = now - startMs` later, it MUST read both reads from THIS
 * module — otherwise mixing performance.now and the synthetic clock
 * produces nonsense elapsed values.
 *
 * The renderer's rAF loop and any wall-clock measurement (encoder
 * timestamps, narration cache TTLs, etc.) must keep using
 * performance.now directly.
 */
let _nowImpl = () => performance.now();

export function now() { return _nowImpl(); }

/** Swap in a synthetic clock. Pass null/undefined to restore real time. */
export function setClockImpl(fn) {
  _nowImpl = fn || (() => performance.now());
}
