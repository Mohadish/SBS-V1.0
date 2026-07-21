/**
 * SBS — Step render cache (V0.3.2.x): SEGMENT PLANNER.
 *
 * Divides the playable timeline into render segments and computes a
 * CONTENT-ADDRESSED cache key per segment. The key IS the invalidation:
 * any change that affects a segment's pixels changes its key, so a cached
 * file either matches exactly or is never used — no dirty-flag wiring.
 *
 * Segment = one step, except STEP-GROUPS which collapse to ONE segment
 * (user design: audio overflow lives inside groups, so group edges are the
 * only safe cut points).
 *
 * Key inputs (all pixel-affecting):
 *   • the PREVIOUS step's snapshot (the transition's FROM state)
 *   • every step in the span (minus volatile fields: thumbnails, cached
 *     audio bodies, measured durations)
 *   • render settings (size/fps/bitrate/background/AO/anim durations/hold)
 *   • the header config + this span's header context (names/indices —
 *     dynamic header kinds bake these into pixels)
 *   • the chapter's per-step DURATION VECTOR — the progress bar's fill
 *     fractions depend on every sibling step's length, so a timing change
 *     anywhere in the chapter correctly re-keys the whole chapter
 *     (Phase 1 bakes headers into segments; the Phase 2 header-split will
 *     drop this dependency for step-granular hits)
 *   • RENDER_CACHE_EPOCH — bump when render code changes pixels
 *
 * Proof-of-seam (V0.3.2.1, user-validated): separately-rendered segments
 * concat seamlessly; transition paths may vary marginally vs a monolithic
 * render (planner reads live state) — accepted, coherent within any one
 * assembled video.
 */

import { state } from '../core/state.js';
import { steps } from './steps.js';

/** Bump when renderer/exporter changes make previously-cached pixels stale. */
export const RENDER_CACHE_EPOCH = 1;

const _groupKeyOf = (s) => s.groupHead ? s.id : (s.groupId || null);

/** Step as it matters to pixels: strip volatile / non-rendered fields. */
function _stepKeyView(s) {
  const c = { ...s };
  delete c.thumbnail;
  delete c.renderedDurationMs;      // measurement, not content (durations enter via the chapter vector)
  if (c.narration) {
    const n = { ...c.narration };
    delete n.dataUrl; delete n.dataFile; delete n.mime;   // audio body isn't in the segment
    c.narration = n;                                       // text + durationMs stay (hold timing)
  }
  return c;
}

async function _sha1hex(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** Divide the playable timeline into segments + compute cache keys. */
export async function computeSegmentPlan() {
  const playable = (state.get('steps') || []).filter(s => steps._isPlayable(s));
  const chapItems = state.get('chapters')?.items || state.get('chapters') || [];
  const chapIdxOf = (id) => chapItems.findIndex(c => c.id === id);

  // Spans: contiguous same-group steps collapse to one segment.
  const spans = [];
  for (let i = 0; i < playable.length; i++) {
    const gk = _groupKeyOf(playable[i]);
    const last = spans[spans.length - 1];
    if (gk !== null && last && last.groupKey === gk) { last.to = i; last.steps.push(playable[i]); continue; }
    spans.push({ from: i, to: i, groupKey: gk, steps: [playable[i]] });
  }

  // Pixel-affecting global settings.
  const exp = state.get('export') || {};
  const settingsKey = {
    w: exp.width, h: exp.height, fps: exp.fps, bitrate: exp.videoBitrate,
    stepHold: exp.stepHoldMs,
    bg: state.get('backgroundColor'), bgGrad: state.get('backgroundGradient'),
    render: state.get('render'),
    camMs: state.get('cameraAnimDurationMs'), objMs: state.get('objectAnimDurationMs'),
    headers: state.get('headerItems'), headersHidden: state.get('headersHidden'),
    headerDefault: state.get('headerDefault'), perChapterNums: state.get('headerStepNumberPerChapter'),
    epoch: RENDER_CACHE_EPOCH,
  };

  // Chapter duration vectors (progress-bar fill inputs).
  const durOf = (s) => Number.isFinite(s.renderedDurationMs) ? Math.round(s.renderedDurationMs)
                     : Math.round(s.narration?.durationMs || 0);
  const chapterVec = new Map();
  for (const s of playable) {
    const ch = s.chapterId ?? null;
    if (!chapterVec.has(ch)) chapterVec.set(ch, []);
    chapterVec.get(ch).push(durOf(s));
  }

  for (const span of spans) {
    const prev = span.from > 0 ? playable[span.from - 1] : null;
    const ch = span.steps[0].chapterId ?? null;
    const payload = JSON.stringify({
      prev: prev ? _stepKeyView(prev) : null,
      steps: span.steps.map(_stepKeyView),
      settings: settingsKey,
      chapterDur: chapterVec.get(ch) || [],
      headerCtx: { stepIdx: span.from, chapterId: ch, chapterIdx: ch ? chapIdxOf(ch) : -1,
                   names: span.steps.map(s => s.name) },
    });
    span.key   = await _sha1hex(payload);
    span.name  = span.steps[0].name || '(step)';
    span.count = span.steps.length;
  }
  return { spans, playableCount: playable.length };
}

/** Plan + check which segments already exist in <project>/_rendercache/. */
export async function planWithCacheStatus() {
  const plan = await computeSegmentPlan();
  const pp = state.get('projectPath');
  const dir = pp ? pp.replace(/[\\/][^\\/]*$/, '') + '/_rendercache' : null;
  let hits = 0;
  for (const span of plan.spans) {
    span.file   = dir ? `${dir}/seg-${span.key}.mp4` : null;
    span.cached = false;
    if (span.file && window.sbsNative?.fileExists) {
      try { span.cached = !!(await window.sbsNative.fileExists(span.file)); } catch { /* treat as miss */ }
    }
    if (span.cached) hits++;
  }
  return { ...plan, dir, hits, misses: plan.spans.length - hits };
}
