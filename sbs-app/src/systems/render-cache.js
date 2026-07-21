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
 * Key inputs (all pixel-affecting). Segments are rendered WITHOUT the header
 * layer (the ENTIRE header — logos, step/chapter names+numbers, progress bar —
 * composites at assembly, per the user's design), so keys are POSITION-
 * INDEPENDENT: moving steps / reordering chapters / narration-timing tweaks
 * elsewhere all keep a segment's key stable. What's in:
 *   • the PREVIOUS step's snapshot (the transition's FROM state)
 *   • every step in the span (minus volatile fields: thumbnails, cached
 *     audio bodies, measured durations; narration text+durationMs stay —
 *     hold LENGTH is part of the segment's pixels)
 *   • render settings (size/fps/bitrate/background/AO/anim durations/hold)
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

  // Spans: contiguous same-group steps collapse to one segment.
  const spans = [];
  for (let i = 0; i < playable.length; i++) {
    const gk = _groupKeyOf(playable[i]);
    const last = spans[spans.length - 1];
    if (gk !== null && last && last.groupKey === gk) { last.to = i; last.steps.push(playable[i]); continue; }
    spans.push({ from: i, to: i, groupKey: gk, steps: [playable[i]] });
  }

  // Pixel-affecting global settings. NO header config, NO positions, NO
  // sibling durations — segments are header-less (assembly composites the
  // header layer), so keys stay stable across moves/reorders/timing tweaks.
  const exp = state.get('export') || {};
  const settingsKey = {
    w: exp.width, h: exp.height, fps: exp.fps, bitrate: exp.videoBitrate,
    stepHold: exp.stepHoldMs,
    bg: state.get('backgroundColor'), bgGrad: state.get('backgroundGradient'),
    render: state.get('render'),
    camMs: state.get('cameraAnimDurationMs'), objMs: state.get('objectAnimDurationMs'),
    epoch: RENDER_CACHE_EPOCH,
  };

  for (const span of spans) {
    const prev = span.from > 0 ? playable[span.from - 1] : null;
    const payload = JSON.stringify({
      prev: prev ? _stepKeyView(prev) : null,
      steps: span.steps.map(_stepKeyView),
      settings: settingsKey,
    });
    span.key   = await _sha1hex(payload);
    span.name  = span.steps[0].name || '(step)';
    span.count = span.steps.length;
  }
  return { spans, playableCount: playable.length };
}

/**
 * Render every MISSING segment into <project>/_rendercache/ (V0.3.2.3).
 * Each miss renders via the proven segment machinery: span [from-1 … to] with
 * the lead step instant-applied + zero frames (the very first segment has no
 * prev — it starts with its own hold, no transition). Segments are HEADER-LESS
 * and SILENT but narration-TIMED. Beside each seg-<key>.mp4 a seg-<key>.json
 * sidecar records its exact duration + within-segment step offsets — the
 * assembly pass uses those to place audio + compute global markers.
 * Returns { rendered, reused, failed, dir }.
 */
export async function renderMissingSegments({ onProgress, signal } = {}) {
  const { exportTimelineVideo } = await import('./video-export.js');
  const plan = await planWithCacheStatus();
  if (!plan.dir) throw new Error('Save the project first — the cache lives next to the .sbsproj.');
  const misses = plan.spans.filter(s => !s.cached);
  let done = 0, failed = 0;
  for (const span of misses) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    onProgress?.({ current: done + 1, total: misses.length, stepName: span.name });
    try {
      const isFirst = span.from === 0;
      const res = await exportTimelineVideo({
        format: 'mp4', offline: true,
        includeNarration: true,           // narration-TIMED holds…
        _noAudioTrack: true,              // …but no audio in the file
        _noHeader: true,                  // header layer composites at assembly
        _stepsRange: [isFirst ? 0 : span.from - 1, span.to],
        _zeroLeadHold: !isFirst,          // first segment = its own hold, no lead
        _noAutoSync: true,
      });
      const bytes = new Uint8Array(await res.blob.arrayBuffer());
      let w = await window.sbsNative.writeFile(`${plan.dir}/seg-${span.key}.mp4`, bytes, null);
      if (!w?.ok) throw new Error(w?.error || 'mp4 write failed');
      // Sidecar: duration + step offsets INSIDE the segment (assembly needs
      // these for audio placement + global markers). Marker times are already
      // encoded-frame times relative to the segment's own t=0.
      const inSpan = new Set(span.steps.map(s => s.id));
      const sidecar = {
        key: span.key, durationMs: res.totalDurationMs,
        steps: (res.stepMarkers || [])
          .filter(m => inSpan.has(m.stepId))          // drop the zero-frame lead step's marker
          .map(m => ({ stepId: m.stepId, ms: m.timeInMs })),
      };
      w = await window.sbsNative.writeFile(`${plan.dir}/seg-${span.key}.json`, JSON.stringify(sidecar), 'utf8');
      if (!w?.ok) throw new Error(w?.error || 'sidecar write failed');
      done++;
    } catch (e) {
      console.warn(`[render-cache] segment "${span.name}" failed:`, e?.message);
      failed++;
      if (e?.name === 'AbortError') throw e;
    }
  }
  return { rendered: done, reused: plan.hits, failed, dir: plan.dir, total: plan.spans.length };
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
