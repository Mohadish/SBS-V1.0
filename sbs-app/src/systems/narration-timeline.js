/**
 * SBS — Narration timeline helper (edit-time, pure).
 *
 * Answers: "what narration is audible during a given step, and where are we in
 * it?" — including GROUP OVERFLOW, where a group head's (or earlier sub-step's)
 * narration carries over into later sub-steps that have no narration of their own.
 *
 * This mirrors the player/exporter's timing model (animation-string phase
 * durations + group-membership overflow) but as a small READ-ONLY estimate used
 * by the image-sequence editor + playback to drive the "word leading up to this
 * transition" preview and the sequence window. It does NOT force or change any
 * narration; if the user retimes a step it simply goes stale (visible on
 * playback), per the agreed design.
 *
 * Estimate caveats (intentional, per spec): step display duration ≈ its full
 * transition-animation duration; the last-step audio-tail wait + inter-step
 * breath are not modelled. Good enough for "vicinity" word alignment.
 */
import { state } from '../core/state.js';
import { parseAnimation, resolveAnimationString, DEFAULT_ANIMATION_STR } from './animation.js';
import { stepVideoWindowMs } from './video-overlay.js';   // 🎬 V0.3.2.82 — video length drives step duration

const _groupKeyOf = (s) => (s?.groupHead ? s.id : (s?.groupId || null));

function _resolveAL(tk) {
  if (tk === 'AL1') return state.get('cameraAnimDurationMs') ?? 1500;
  if (tk === 'AL2') return state.get('objectAnimDurationMs')  ?? 1500;
  return 0;
}

/** { totalMs, narrOffsetMs } for a step from its animation string. */
function _animTiming(step) {
  const presets = state.get('animationPresets') || [];
  const animStr = resolveAnimationString(step.transition || {}, presets);
  const phases  = animStr ? parseAnimation(animStr, _resolveAL) : null;
  if (!phases || !phases.length) return { totalMs: 0, narrOffsetMs: 0 };
  let total = 0, narrOffset = 0, found = false;
  for (const ph of phases) {
    if (!found && ph.types?.includes('narration')) { narrOffset = total; found = true; }
    total += ph.durationMs || 0;
  }
  return { totalMs: total, narrOffsetMs: found ? narrOffset : 0 };
}

function _playableSteps() {
  // B4/M9 (V0.3.2.108): also exclude steps of HIDDEN CHAPTERS (steps.js's
  // _isPlayable rule inlined — importing steps.js here would close the
  // steps → overlay → narration-timeline cycle). Without this the TOC
  // listed hidden chapters and their playtime inflated every later
  // chapter's start timecode.
  const chHidden = new Set((state.get('chapters') || []).filter(c => c.hidden).map(c => c.id));
  return (state.get('steps') || []).filter(s => s && !s.hidden && !s.isBaseStep && !chHidden.has(s.chapterId));
}

/**
 * Narration context for a step (used by the sequence editor + playback window).
 * @returns {{ text:string, durationMs:number, offsetMs:number, windowMs:number, isOverflow:boolean }}
 *   - own narration  → this step's text/duration, offset 0, window = its duration
 *   - overflow        → the in-group source whose narration is still audible here:
 *                       its text/duration, the ms-offset into it at this step's
 *                       start, window = this step's display duration
 *   - none            → empty text, window = this step's display duration
 */
export function narrationContextForStep(stepId) {
  const steps = _playableSteps();
  const idx = steps.findIndex(s => s.id === stepId);
  const empty = { text: '', durationMs: 0, offsetMs: 0, windowMs: 0, isOverflow: false };
  if (idx < 0) {
    // V0.3.2.114: off-sequence step (hidden, or inside a hidden chapter).
    // It has no place in the playback timeline — but the sequence editor and
    // live image-sequence playback still need its own window while the user
    // edits it, and V0.3.2.108's hidden-chapter clause started dropping them
    // here. TOC/timecode callers keep using _playableSteps and are unaffected.
    const s = (state.get('steps') || []).find(x => x.id === stepId);
    if (!s) return empty;
    const own = s.narration?.durationMs || 0;
    if (own > 0 && s.narration?.text) {
      return { text: s.narration.text, durationMs: own, offsetMs: 0, windowMs: own, isOverflow: false };
    }
    return { text: '', durationMs: 0, offsetMs: 0, windowMs: _animTiming(s).totalMs || 0, isOverflow: false };
  }
  const step = steps[idx];

  // Own narration → straightforward.
  const ownDur = step.narration?.durationMs || 0;
  if (ownDur > 0 && step.narration?.text) {
    return { text: step.narration.text, durationMs: ownDur, offsetMs: 0, windowMs: ownDur, isOverflow: false };
  }

  // Estimated step-start markers (cumulative transition durations).
  const timing  = steps.map(_animTiming);
  const markers = [];
  let acc = 0;
  for (let i = 0; i < steps.length; i++) { markers[i] = acc; acc += timing[i].totalMs; }

  const myWindow = timing[idx].totalMs || 0;

  // Look back within the SAME group for a narration that's still audible here.
  const gkey = _groupKeyOf(step);
  if (gkey != null) {
    for (let j = idx - 1; j >= 0; j--) {
      if (_groupKeyOf(steps[j]) !== gkey) break;        // left the group
      const dur = steps[j].narration?.durationMs || 0;
      if (dur > 0 && steps[j].narration?.text) {
        const narrStart = markers[j] + timing[j].narrOffsetMs;
        const offset    = markers[idx] - narrStart;
        if (offset >= 0 && offset < dur) {              // still playing here → overflow
          return { text: steps[j].narration.text, durationMs: dur, offsetMs: offset, windowMs: myWindow, isOverflow: true };
        }
        break;                                          // nearest source already ended → no overflow
      }
    }
  }
  return { text: '', durationMs: 0, offsetMs: 0, windowMs: myWindow, isOverflow: false };
}

/**
 * A step's total time on the timeline: its transition animation, extended so the
 * narration finishes, plus the inter-step breath (stepHoldMs). Mirrors the
 * exporter's perStepHold intent: hold = max(0, audioEnd - animEnd) + breath.
 * Group narration overflow is APPROXIMATED per-step (the head carries its clip);
 * cumulative chapter boundaries stay close because a group's total time is ~equal
 * either way. An ESTIMATE — validate against a real export, refine from markers.
 */
function _stepTimelineMs(step, stepHoldMs) {
  // EXACT replica of the exporter's per-step marker advance (video-export
  // _estimateAnimDur + _narrationStartOffsetMs + perStepHold): a step lasts
  //   max(animDur, narrOffset + narrDur) + stepHoldMs
  // where animDur = objectAnimDurationMs (or per-step override) — NOT the
  // phased-string total — and narration starts at narrOffset (the phases BEFORE
  // its narration phase), not at 0 (overlap → under-counts) nor after the whole
  // animation (additive → over-counts). Group audio-tail is approximated per-step.
  const globalObjDur = state.get('objectAnimDurationMs') ?? 1500;
  const t = step.transition || {};
  const animMs = (t.durationOverride === true) ? (t.objectDurationMs ?? globalObjDur) : globalObjDur;
  const { narrOffsetMs } = _animTiming(step);   // === exporter's _narrationStartOffsetMs
  const narrMs = step.narration?.durationMs || 0;
  // 🎬 V0.3.2.84 — a video on the step's overlay is a third duration input,
  // and its placement depends on the animation string. With an overlay slot
  // (the normal case) the video STRETCHES that slot: fade-in lands on the
  // frozen first frame, playback runs inside the phase chain, and every
  // later block (obj etc.) queues behind it — so it adds SEQUENTIALLY to
  // the animation. Without an overlay slot the clip plays during the hold
  // instead, so it competes with narration via max(). Videos never overflow
  // into the next step either way. Mirrored exactly in the exporter's
  // perStepHold, so estimate and encode can't drift.
  const videoMs = stepVideoWindowMs(step);
  if (videoMs > 0 && stepHasOverlaySlot(step)) {
    return Math.max(animMs + videoMs, narrOffsetMs + narrMs) + stepHoldMs;
  }
  return Math.max(animMs, narrOffsetMs + narrMs, videoMs) + stepHoldMs;
}

/**
 * True when the step's RESOLVED animation string contains an overlay slot
 * ('overlay(...)' or sustained 'overlays(...)'). Decides where a video's
 * window lives: inside the phase chain (slot present) or in the hold.
 */
export function stepHasOverlaySlot(step) {
  const presets = state.get('animationPresets') || [];
  const str = resolveAnimationString(step?.transition || {}, presets) || DEFAULT_ANIMATION_STR;
  return /\boverlays?\s*\(/i.test(str);
}

/**
 * 🔊 When a step's VIDEO starts making sound, relative to step start
 * (V0.3.2.88) — the audio-mix twin of narrOffsetMs. Playback triggers when
 * the overlay fade-in COMPLETES, so the offset is the sum of phases before
 * the overlay block PLUS that block's own duration. No overlay slot →
 * playback starts after the whole animation (the .84 fallback) → totalMs.
 */
export function videoAudioStartOffsetMs(step) {
  const presets = state.get('animationPresets') || [];
  const animStr = resolveAnimationString(step?.transition || {}, presets) || DEFAULT_ANIMATION_STR;
  const phases  = parseAnimation(animStr, _resolveAL);
  if (!phases || !phases.length) return 0;
  let total = 0;
  for (const ph of phases) {
    total += ph.durationMs || 0;
    if (ph.types?.includes('overlay') || ph.types?.includes('overlays')) return total;
  }
  return total;   // no overlay block → after the whole animation
}

/**
 * Compute each chapter's START TIME in the final playback/export timeline —
 * the data behind an auto-generated Table of Contents. Walks the playable steps
 * in order, summing per-step durations, recording the cumulative time at each
 * chapter boundary. Each step prefers its MEASURED duration (renderedDurationMs,
 * written by the exporter) — EXACT, insert/cable time included — and falls back
 * to the estimate for steps not yet rendered (or edited since). Returns
 * { chapters:[{chapterId,name,startMs,startStepId,measured}], totalMs, hasEstimate }.
 * Pure/read-only; safe to call any time.
 */
export function computeChapterTimecodes(opts = {}) {
  const stepHoldMs = opts.stepHoldMs ?? (state.get('export')?.stepHoldMs ?? 400);   // POST_STEP_HOLD_MS
  const steps      = _playableSteps();
  const chapItems  = state.get('chapters')?.items || state.get('chapters') || [];
  const nameById   = new Map((Array.isArray(chapItems) ? chapItems : []).map(c => [c.id, c.name]));
  const out = []; let t = 0; let lastCh; let cleanSoFar = true; let hasEstimate = false;
  for (const s of steps) {
    const ch = s.chapterId ?? null;
    if (ch !== lastCh) {
      // A chapter's start time is EXACT only if every step before it was measured.
      out.push({ chapterId: ch, name: ch ? (nameById.get(ch) || '(chapter)') : '(no chapter)', startMs: Math.round(t), startStepId: s.id, measured: cleanSoFar });
      lastCh = ch;
    }
    if (Number.isFinite(s.renderedDurationMs)) { t += s.renderedDurationMs; }
    else { t += _stepTimelineMs(s, stepHoldMs); hasEstimate = true; cleanSoFar = false; }
  }
  return { chapters: out, totalMs: Math.round(t), hasEstimate };
}

/**
 * How far through its CHAPTER a step is, 0..1 — drives the chapter-progress
 * header bar (backlog #15). TIME-weighted: measured renderedDurationMs when
 * available, the estimate otherwise. Rules (per the user's spec): chapter's
 * first step → 0 (bar starts empty), chapter's last step → 1 (ends full),
 * in between → elapsed-before-this-step / chapter total. Steps outside any
 * chapter → 0 (empty bar).
 */
/**
 * The active step's SPAN within its chapter — { startFrac, endFrac, durMs } —
 * for the CONTINUOUS progress-bar fill: the bar animates startFrac→endFrac
 * over the step's real duration. Because endFrac−startFrac is exactly this
 * step's share of the chapter total, the fill rate is CONSTANT across step
 * boundaries — globally linear over the whole chapter, per the user's spec.
 * null when the step is outside any chapter (bar shows empty).
 */
export function chapterProgressSpan(stepId) {
  const steps = _playableSteps();
  const idx = steps.findIndex(s => s.id === stepId);
  if (idx < 0) return null;
  const ch = steps[idx].chapterId ?? null;
  if (!ch) return null;
  const stepHoldMs = state.get('export')?.stepHoldMs ?? 400;
  const durOf = (s) => Number.isFinite(s.renderedDurationMs) ? s.renderedDurationMs : _stepTimelineMs(s, stepHoldMs);
  const members = steps.filter(s => (s.chapterId ?? null) === ch);
  const total = members.reduce((t, s) => t + durOf(s), 0);
  if (!(total > 0)) return null;
  let before = 0, dur = 0;
  for (const s of members) { if (s.id === stepId) { dur = durOf(s); break; } before += durOf(s); }
  return { startFrac: before / total, endFrac: Math.min(1, (before + dur) / total), durMs: dur };
}

export function chapterProgressForStep(stepId) {
  const steps = _playableSteps();
  const idx = steps.findIndex(s => s.id === stepId);
  if (idx < 0) return 0;
  const ch = steps[idx].chapterId ?? null;
  if (!ch) return 0;
  const stepHoldMs = state.get('export')?.stepHoldMs ?? 400;
  const durOf = (s) => Number.isFinite(s.renderedDurationMs) ? s.renderedDurationMs : _stepTimelineMs(s, stepHoldMs);
  const members = steps.filter(s => (s.chapterId ?? null) === ch);
  if (members.length <= 1) return 1;
  if (members[members.length - 1].id === stepId) return 1;
  const total = members.reduce((t, s) => t + durOf(s), 0);
  if (!(total > 0)) return 0;
  let before = 0;
  for (const s of members) { if (s.id === stepId) break; before += durOf(s); }
  return Math.max(0, Math.min(1, before / total));
}
