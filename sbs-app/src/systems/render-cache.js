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

  // DEFINITION-level state (V0.3.2.7): things edited ONCE that change pixels
  // across MANY steps — primitive parameters (live tree = the truth; the frozen
  // copies in step snapshots go stale, which is exactly why they can't key
  // this), flat-shape templates, color presets, cable styles. Any definition
  // edit re-keys EVERY segment — the user's own rule: a project-wide change
  // means render everything. Without this, a primitive param fix would silently
  // reuse stale cached pixels.
  const _prims = [];
  (function walk(n) {
    if (!n) return;
    if (n.type === 'primitive') _prims.push({ id: n.id, k: n.primKind, p: n.primParams, q: n.primQuality, b: n.baseAtOrigin });
    (n.children || []).forEach(walk);
  })(state.get('treeData'));
  const defsKey = {
    prims:  _prims,
    shapes: state.get('shapeTemplates') || [],
    colors: state.get('colorPresets')   || [],
    cables: (state.get('cables') || []).map(c => ({ id: c.id, style: c.style })),
  };

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
      defs: defsKey,
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
/** CSS color → ffmpeg color syntax ('#rrggbb'→'0xrrggbb', 'rgba(r,g,b,a)'→'0xrrggbb@a'). */
function _ffColor(c, fallback) {
  const s = String(c || fallback || 'white').trim();
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (m) {
    const hex = [m[1], m[2], m[3]].map(v => (+v).toString(16).padStart(2, '0')).join('');
    return `0x${hex}${m[4] != null ? `@${m[4]}` : ''}`;
  }
  if (s.startsWith('#')) return '0x' + s.slice(1);
  return s;
}

/** Float32 mono PCM → 16-bit WAV bytes (for ffmpeg to mux). */
function _wavFromFloat32(pcm, rate) {
  const n = pcm.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/**
 * ASSEMBLE the final video from the cache (V0.3.2.5 — slices 3a+3b).
 *   1. Render any missing segments (reuses everything cached).
 *   2. Read every sidecar → global step markers (cumulative) + total length.
 *   3. ffmpeg concat (stream copy — lossless, seconds).
 *   4. Decode narration clips → mix ONE master track at the global markers
 *      (the export's own machinery) → WAV → ffmpeg mux (video copied, AAC audio).
 * NOT YET: header layer / progress bar composite (slice 3c) — the output is
 * header-less for now. Returns { path, totalMs, segments, reused, rendered }.
 */
export async function assembleFromCache({ onProgress, signal, output } = {}) {
  const fill = await renderMissingSegments({ onProgress, signal });
  if (fill.failed) throw new Error(`${fill.failed} segment(s) failed to render — aborting assembly`);
  // Use the FILL's plan — never re-plan mid-run (rendering mutates step data →
  // fingerprints drift → a re-plan would disown the files just written; the
  // "137 still missing after fill" bug).
  const plan = fill.plan;
  const stillMissing = plan.spans.filter(s => !s.cached).length;
  if (stillMissing) throw new Error(`${stillMissing} segment(s) unaccounted for after fill`);

  // Global markers from the sidecars: each span's steps at (cumulative + local).
  // Also stamp each span's assembled-time window (header track + bars need it).
  let cum = 0;
  const markersByStepId = new Map();
  const files = [];
  for (const span of plan.spans) {
    const sj = await window.sbsNative.readFile(`${plan.dir}/seg-${span.key}.json`, 'utf8');
    if (!sj?.ok) throw new Error(`sidecar missing for "${span.name}" — clear _rendercache and refill`);
    const sc = JSON.parse(sj.data);
    for (const st of (sc.steps || [])) markersByStepId.set(st.stepId, cum + st.ms);
    files.push(`${plan.dir}/seg-${span.key}.mp4`);
    span._startMs = cum;
    span._durMs   = sc.durationMs || 0;
    cum += span._durMs;
  }
  const totalMs = cum;

  // Lossless video concat (same codec/params by construction).
  onProgress?.({ stepName: 'stitching video (lossless concat)…' });
  const listPath = `${plan.dir}/_list.txt`;
  await window.sbsNative.writeFile(listPath, files.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
  const vPath = `${plan.dir}/_assembly-video.mp4`;
  let r = await window.sbsNative.ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', vPath]);
  if (!r?.ok) throw new Error('concat failed: ' + (r?.stderrTail || '').slice(-300));

  // ── Header track (V0.3.2.8, slice 3c) ──────────────────────────────────────
  // One static PNG per span (dynamic text resolved against the span's HEAD step
  // — matches the live header's treat-group-as-one-step rule), played as a
  // concat image sequence and overlaid in the final pass. The progress bar
  // animates via per-chapter ffmpeg drawbox width expressions (same linear fill
  // as the live bar; square corners — cosmetic difference only).
  const exp  = state.get('export') || {};
  const expW = (Number.isFinite(exp.width)  && exp.width  > 0) ? exp.width  : 1920;
  const expH = (Number.isFinite(exp.height) && exp.height > 0) ? exp.height : 1080;
  const header = await import('./header.js');
  const allHdrItems = (state.get('headerItems') || []).filter(i => i.visible !== false);
  const headersOn = !state.get('headersHidden') && allHdrItems.length > 0;
  let hdrListPath = null;
  const boxFilters = [];
  if (headersOn) {
    const staticItems = allHdrItems.filter(i => i.kind !== 'chapterProgress');
    if (staticItems.length) {
      onProgress?.({ stepName: 'rendering header track…' });
      const lines = [];
      for (let i = 0; i < plan.spans.length; i++) {
        const span = plan.spans[i];
        const ctx = header.buildRenderContext(span.steps[0].id);
        const cnv = await header.rasterizeHeaderDataToCanvas(ctx, { width: expW, height: expH });
        if (!cnv) { lines.length = 0; break; }
        const blob  = await new Promise(res => cnv.toBlob(res, 'image/png'));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const w = await window.sbsNative.writeFile(`${plan.dir}/_hdr/span-${i}.png`, bytes, null);
        if (!w?.ok) throw new Error('header png write failed: ' + w?.error);
        lines.push(`file '_hdr/span-${i}.png'`, `duration ${(span._durMs / 1000).toFixed(3)}`);
      }
      if (lines.length) {
        lines.push(`file '_hdr/span-${plan.spans.length - 1}.png'`);   // concat-demuxer quirk: repeat the last entry
        hdrListPath = `${plan.dir}/_hdrlist.txt`;
        const w = await window.sbsNative.writeFile(hdrListPath, lines.join('\n'), 'utf8');
        if (!w?.ok) throw new Error('header list write failed');
      }
    }
    // Progress bars: track = constant box; fill = width grows linearly across
    // each chapter's assembled-time window.
    const progItems = allHdrItems.filter(i => i.kind === 'chapterProgress');
    if (progItems.length) {
      const wins = [];
      for (const span of plan.spans) {
        const ch = span.steps[0].chapterId ?? null;
        const last = wins[wins.length - 1];
        if (last && last.ch === ch) last.end = span._startMs + span._durMs;
        else wins.push({ ch, start: span._startMs, end: span._startMs + span._durMs });
      }
      for (const item of progItems) {
        const x = Math.round(item.x), y = Math.round(item.y), w = Math.round(item.w), h = Math.round(item.h);
        boxFilters.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${_ffColor(item.trackColor, 'white@0.4')}:t=fill`);
        for (const win of wins) {
          if (!win.ch) continue;                       // outside chapters the bar stays empty
          const cs = (win.start / 1000).toFixed(3);
          const ce = (win.end   / 1000).toFixed(3);
          const cd = Math.max(0.001, (win.end - win.start) / 1000).toFixed(3);
          boxFilters.push(`drawbox=x=${x}:y=${y}:w='max(2,trunc(${w}*min(1,(t-${cs})/${cd})))':h=${h}`
            + `:color=${_ffColor(item.fillColor, '0x3b82f6')}:t=fill:enable='between(t,${cs},${ce})'`);
        }
      }
    }
  }

  // Global audio master at the assembled markers.
  const ve = await import('./video-export.js');
  const playable = (state.get('steps') || []).filter(s => steps._isPlayable(s));
  onProgress?.({ stepName: 'decoding narration clips…' });
  const audio = await ve.decodeNarrationSegments(playable, 48000);
  let aPath = null;
  if (audio.hasAudio) {
    const pcm = ve.mixPcmFromMarkers(audio, markersByStepId, totalMs, 48000);
    aPath = `${plan.dir}/_assembly-audio.wav`;
    const w = await window.sbsNative.writeFile(aPath, _wavFromFloat32(pcm, 48000), null);
    if (!w?.ok) throw new Error('audio master write failed: ' + w?.error);
  }

  // ── Final pass: composite headers + bar (re-encode) OR plain mux (copy) ────
  const projDir = (state.get('projectPath') || '').replace(/[\\/][^\\/]*$/, '');
  const outPath = output || `${projDir}/${(state.get('export')?.fileName) || 'sbs_export'}-assembled.mp4`;
  onProgress?.({ stepName: 'compositing + muxing final video…' });
  const args = ['-y', '-i', vPath];
  let aInIdx = 1;
  if (hdrListPath) { args.push('-f', 'concat', '-safe', '0', '-i', hdrListPath); aInIdx = 2; }
  if (aPath) args.push('-i', aPath);
  const chains = [];
  let vLabel = '[0:v]';
  if (hdrListPath)      { chains.push(`[0:v][1:v]overlay=0:0:eof_action=pass[vh]`); vLabel = '[vh]'; }
  if (boxFilters.length) { chains.push(`${vLabel}${boxFilters.join(',')}[vb]`); vLabel = '[vb]'; }
  if (chains.length) {
    args.push('-filter_complex', chains.join(';'), '-map', vLabel);
    if (aPath) args.push('-map', `${aInIdx}:a:0`);
    args.push('-c:v', 'libx264', '-preset', 'fast', '-b:v', String(exp.videoBitrate || 4_000_000), '-pix_fmt', 'yuv420p');
  } else {
    args.push('-map', '0:v:0');
    if (aPath) args.push('-map', `${aInIdx}:a:0`);
    args.push('-c:v', 'copy');
  }
  if (aPath) args.push('-c:a', 'aac', '-b:a', '192k');
  args.push(outPath);
  r = await window.sbsNative.ffmpeg(args);
  if (!r?.ok) throw new Error('composite/mux failed: ' + (r?.stderrTail || '').slice(-300));
  return { path: outPath, totalMs, segments: plan.spans.length, reused: fill.reused, rendered: fill.rendered,
           headers: !!(hdrListPath || boxFilters.length) };
}

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
      span.cached = true;          // this run's plan now knows the file exists
      done++;
    } catch (e) {
      console.warn(`[render-cache] segment "${span.name}" failed:`, e?.message);
      failed++;
      if (e?.name === 'AbortError') throw e;
    }
  }
  // Return THE PLAN too (V0.3.2.9): rendering mutates project data mid-run
  // (overlay self-heals, narration stamps on step activation), so fingerprints
  // recomputed AFTER the fill can differ from the ones the files were written
  // under. One run = one plan — the assembly must consume THIS plan, never
  // re-derive it.
  return { rendered: done, reused: plan.hits, failed, dir: plan.dir, total: plan.spans.length, plan };
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
