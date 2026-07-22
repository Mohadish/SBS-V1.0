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
export const RENDER_CACHE_EPOCH = 2;   // 2: canonical hashing (V0.3.2.22)

const _groupKeyOf = (s) => s.groupHead ? s.id : (s.groupId || null);

/** Canonical form for hashing (V0.3.2.22): object keys sorted, numbers
 *  rounded to 1e-4. Several subsystems rewrite step data with identical
 *  visual content but different bytes — overlay re-serialization shuffles
 *  Konva attr insertion order, bonded-shape sync re-derives floats, synth
 *  passes replace whole narration objects. None of that noise may ever
 *  change a fingerprint; only content that changes pixels should. */
function _canon(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v;
  if (Array.isArray(v)) return v.map(_canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = _canon(v[k]);
    return o;
  }
  return v;
}

/** Step as it matters to pixels: strip volatile / non-rendered fields. */
function _stepKeyView(s) {
  const c = { ...s };
  delete c.thumbnail;
  delete c.renderedDurationMs;      // measurement, not content (durations enter via the chapter vector)
  if (c.narration) {
    // Fixed-shape view: the narration object is wholesale-replaced by the
    // synth/precache passes (audio body, property order, re-measured
    // duration) without the audible content changing. Only what affects
    // pixels/timing keys: the spoken text + hold duration.
    c.narration = {
      text: String(c.narration.text || '').trim(),
      voiceId: c.narration.voiceId ?? null,
      speed: c.narration.speed ?? 1,
      durationMs: Math.round(c.narration.durationMs || 0),
    };
  }
  // Overlay is a serialized Konva-stage string — parse it so canonicalization
  // reaches inside (activation-time reflow/heal/sync rewrites reorder attrs
  // and nudge floats on visually identical overlays).
  if (typeof c.overlay === 'string' && c.overlay) {
    try { c.overlay = JSON.parse(c.overlay); } catch { /* unparseable → keys as raw string */ }
  }
  return _canon(c);
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
  // Sorted by id (V0.3.2.20): tree/list REORDERING must not re-key — only
  // actual definition content changes should (forensics showed a pure shuffle
  // contributing to a full invalidation).
  const _byId = (a, b) => String(a.id).localeCompare(String(b.id));
  const defsKey = {
    prims:  _prims.slice().sort(_byId),
    shapes: (state.get('shapeTemplates') || []).slice().sort(_byId),
    colors: (state.get('colorPresets')   || []).slice().sort(_byId),
    cables: (state.get('cables') || []).map(c => ({ id: c.id, style: c.style })).sort(_byId),
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

  const plan = { spans, playableCount: playable.length, settingsKey, defsKey };
  for (const span of spans) {
    span._prevRef = span.from > 0 ? playable[span.from - 1] : null;
    span.name  = span.steps[0].name || '(step)';
    span.count = span.steps.length;
    await _keySpan(span, plan);
  }
  return plan;
}

/** (Re)compute a span's key + part-hashes from the CURRENT live objects.
 *  Called at plan time AND again right after a span renders (V0.3.2.21):
 *  step activation during rendering self-heals/rewrites step data, so the
 *  settled post-render state is the only stable thing to file the cache
 *  under — keying at plan time wrote files under fingerprints that were
 *  obsolete by the next run (the back-to-back full-re-render bug). */
async function _keySpan(span, plan) {
  const p = _spanPayload(span, plan);
  span._prevH  = await _sha1hex(p.prevJson);
  span._stepsH = await _sha1hex(p.stepsJson);
  span.key = await _sha1hex(p.full);
  return span.key;
}

function _spanPayload(span, plan) {
  const prevJson  = JSON.stringify(span._prevRef ? _stepKeyView(span._prevRef) : null);
  const stepsJson = JSON.stringify(span.steps.map(_stepKeyView));
  return { prevJson, stepsJson,
    full: `{"prev":${prevJson},"steps":${stepsJson},"settings":${JSON.stringify(_canon(plan.settingsKey))},"defs":${JSON.stringify(_canon(plan.defsKey))}}` };
}

/** Drift forensics (V0.3.2.21): compare this plan against the previous one
 *  (_rendercache/_lastplan.json) and NAME what changed — which spans, which
 *  part (step data vs prev-step vs defs vs settings), and for the first
 *  drifted span a field-by-field payload diff down to the first differing
 *  character. This is how we catch fields that silently rewrite themselves
 *  between runs and churn the cache. */
async function _reportPlanDrift(out, dir) {
  const lastPath = `${dir}/_lastplan.json`;
  let old = null;
  try {
    const r = await window.sbsNative.readFile(lastPath, 'utf8');
    if (r?.ok) old = JSON.parse(r.data);
  } catch { /* first run */ }

  if (old && out.misses > 0) {
    try {
      const defsChanged     = JSON.stringify(old.defs)     !== JSON.stringify(out.defsKey);
      const settingsChanged = JSON.stringify(old.settings) !== JSON.stringify(out.settingsKey);
      let stepsDrift = 0, prevDrift = 0, comparable = old.spans?.length === out.spans.length;
      if (comparable) {
        for (let i = 0; i < out.spans.length; i++) {
          if (old.spans[i].stepsH !== out.spans[i]._stepsH) stepsDrift++;
          else if (old.spans[i].prevH !== out.spans[i]._prevH) prevDrift++;
        }
      }
      console.warn(`[render-cache] plan drift vs previous plan: ` +
        (comparable ? `${stepsDrift} span(s) with changed STEP data, ${prevDrift} with changed PREV-step only, ` : `span count ${old.spans?.length} → ${out.spans.length}, `) +
        `defs ${defsChanged ? 'CHANGED' : 'same'}, settings ${settingsChanged ? 'CHANGED' : 'same'}`);

      // Field-level diff of the first drifted span's payload.
      if (comparable && old.sample) {
        const i = out.spans.findIndex((s, j) => old.spans[j].stepsH !== s._stepsH || old.spans[j].prevH !== s._prevH);
        if (i === old.sample.index) {
          const cur = JSON.parse(_spanPayload(out.spans[i], out).full);
          const prev = JSON.parse(old.sample.payload);
          const diffs = [];
          const strCtx = (a, b) => {
            let k = 0; while (k < a.length && a[k] === b[k]) k++;
            return `…${a.slice(Math.max(0, k - 50), k + 50)}… → …${b.slice(Math.max(0, k - 50), k + 50)}…`;
          };
          const cmp = (pa, pb, pfx) => {
            if (diffs.length >= 12) return;
            if (JSON.stringify(pa) === JSON.stringify(pb)) return;
            if (typeof pa === 'string' && typeof pb === 'string') { diffs.push(`${pfx}: ${strCtx(pa, pb)}`); return; }
            if (typeof pa !== 'object' || typeof pb !== 'object' || !pa || !pb) { diffs.push(`${pfx}: ${JSON.stringify(pa)?.slice(0, 80)} → ${JSON.stringify(pb)?.slice(0, 80)}`); return; }
            for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) cmp(pa[k], pb[k], `${pfx}.${k}`);
          };
          cmp(prev, cur, `span${i}("${out.spans[i].name.slice(0, 20)}")`);
          if (diffs.length) console.warn('[render-cache] first drifted span, field diff (previous → current):\n' + diffs.join('\n'));
        }
      }
      out.driftReport = { defsChanged, settingsChanged, stepsDrift, prevDrift, comparable };
    } catch (e) { console.warn('[render-cache] drift report failed:', e?.message); }
  }

  // Record THIS plan for the next comparison. Sample = payload of the first
  // span that currently misses (most likely to drift again), else span 0.
  try {
    const si = Math.max(0, out.spans.findIndex(s => !s.cached));
    await window.sbsNative.writeFile(lastPath, JSON.stringify({
      when: new Date().toISOString(),
      settings: out.settingsKey, defs: out.defsKey,
      spans: out.spans.map(s => ({ name: s.name, key: s.key, prevH: s._prevH, stepsH: s._stepsH })),
      sample: out.spans.length ? { index: si, payload: _spanPayload(out.spans[si], out).full } : null,
    }), 'utf8');
  } catch { /* best-effort */ }
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
export async function assembleFromCache({ onProgress, signal, output, force = false } = {}) {
  const ve = await import('./video-export.js');
  const timings = [];
  let renderedCount = 0;
  let _t = performance.now();
  const _mark = (label) => { timings.push([label, performance.now() - _t]); _t = performance.now(); };

  const _checkFill = (fill) => {
    if (fill.failed) throw new Error(`${fill.failed} segment(s) failed to render — aborting assembly`);
    const missing = fill.plan.spans.filter(s => !s.cached).length;
    if (missing) throw new Error(`${missing} segment(s) unaccounted for after fill`);
    return fill.plan;   // ONE plan per run — never re-plan mid-flight
  };

  // Sidecars → global markers + each span's assembled-time window.
  const readTimeline = async (plan) => {
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
    return { markersByStepId, files, totalMs: cum };
  };

  const fill1 = await renderMissingSegments({ onProgress, signal, force });
  let plan = _checkFill(fill1);
  renderedCount += fill1.rendered;
  _mark('render segments');

  let TL = await readTimeline(plan);

  // EXACT TOC (V0.3.2.13): chapter times read off THE ASSEMBLED TIMELINE
  // ITSELF — not the measured-duration estimate, which accumulates ~1 frame of
  // rounding per segment and drifted seconds by the late chapters. Stamp the
  // true times into the TOC boxes; if any box actually changed, only its host
  // segment re-renders (overlay text never affects durations → the timeline is
  // stable → no circularity).
  {
    const chapItems = state.get('chapters')?.items || state.get('chapters') || [];
    const chapName  = new Map(chapItems.map(c => [c.id, c.name]));
    const chaptersExact = [];
    let lastCh;
    for (const span of plan.spans) {
      const ch = span.steps[0].chapterId ?? null;
      if (ch !== lastCh) {
        chaptersExact.push({ chapterId: ch, name: ch ? (chapName.get(ch) || '(chapter)') : '(no chapter)', startMs: Math.round(span._startMs) });
        lastCh = ch;
      }
    }
    try {
      const ov = await import('./overlay.js');
      await ov.waitForOverlayStable?.();
      const touched = await ov.refreshAllTocBoxesData?.({ chapters: chaptersExact });
      if (touched) {
        onProgress?.({ stepName: `TOC stamped with exact times (${touched} step(s)) — re-rendering host segment(s)…` });
        const fill2 = await renderMissingSegments({ onProgress, signal });
        plan = _checkFill(fill2);
        renderedCount += fill2.rendered;
        TL = await readTimeline(plan);
      }
    } catch (e) { console.warn('[assemble] exact-TOC stamp failed:', e?.message); }
  }
  _mark('timeline + exact TOC');
  const { markersByStepId, files } = TL;
  const totalMs = TL.totalMs;

  // Lossless video concat (same codec/params by construction).
  onProgress?.({ stepName: 'stitching video (lossless concat)…' });
  const listPath = `${plan.dir}/_list.txt`;
  await window.sbsNative.writeFile(listPath, files.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
  const vPath = `${plan.dir}/_assembly-video.mp4`;
  let r = await window.sbsNative.ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', vPath]);
  if (!r?.ok) throw new Error('concat failed: ' + (r?.stderrTail || '').slice(-300));
  _mark('stitch (lossless concat)');

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
  const boxFilters = [];    // static track boxes (drawbox is fine for constants)
  const fillChains = [];    // animated fills: color source → time-cropped → overlaid
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
      // NOTE (V0.3.2.10): drawbox CANNOT animate — in its expressions `t` is
      // the THICKNESS, not time (the stuck-full-bar bug). The fill is instead a
      // solid color source CROPPED to a growing width (crop DOES evaluate `t`
      // as timestamp per frame) and overlaid during its chapter's window.
      for (const item of progItems) {
        const x = Math.round(item.x), y = Math.round(item.y), w = Math.round(item.w), h = Math.round(item.h);
        boxFilters.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${_ffColor(item.trackColor, 'white@0.4')}:t=fill`);
        for (const win of wins) {
          if (!win.ch) continue;                       // outside chapters the bar stays empty
          fillChains.push({
            color: _ffColor(item.fillColor, '0x3b82f6'),
            w, h, x, y,
            cs: (win.start / 1000).toFixed(3),
            ce: (win.end   / 1000).toFixed(3),
            cd: Math.max(0.001, (win.end - win.start) / 1000).toFixed(3),
          });
        }
      }
    }
  }

  _mark('header track');

  // Global audio master at the assembled markers.
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

  _mark('audio master');

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
  // Animated fill (V0.3.2.11): the canonical ffmpeg progress-bar idiom. A
  // solid strip SLIDES right inside a transparent bar-sized canvas (the canvas
  // clips the spill), then the canvas overlays at the bar's position during
  // its chapter window. overlay x-expressions evaluate per frame — no dynamic
  // crop sizes (which starved the graph → "received no packets").
  const dTot = (totalMs / 1000 + 1).toFixed(3);
  fillChains.forEach((f, i) => {
    chains.push(`color=c=${f.color}:s=${f.w}x${f.h}:r=25:d=${dTot}[pf${i}]`);
    chains.push(`color=c=black@0.0:s=${f.w}x${f.h}:r=25:d=${dTot},format=rgba[pc${i}]`);
    chains.push(`[pc${i}][pf${i}]overlay=x='-${f.w}+${f.w}*clip((t-${f.cs})/${f.cd},0,1)':y=0[pm${i}]`);
    chains.push(`${vLabel}[pm${i}]overlay=x=${f.x}:y=${f.y}:eof_action=pass:enable='between(t,${f.cs},${f.ce})'[vf${i}]`);
    vLabel = `[vf${i}]`;
  });
  if (chains.length) {
    // Script file instead of an argv-inlined graph: debuggable (persists next
    // to the cache) and immune to Windows command-line length limits.
    const fgPath = `${plan.dir}/_filtergraph.txt`;
    const wfg = await window.sbsNative.writeFile(fgPath, chains.join(';\n'), 'utf8');
    if (!wfg?.ok) throw new Error('filtergraph write failed');
    // FFmpeg 8+ removed -filter_complex_script; the modern equivalent is the
    // generic read-option-from-file form: -/filter_complex <path>.
    args.push('-/filter_complex', fgPath, '-map', vLabel);
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
  _mark('composite + mux');
  const totalS = timings.reduce((a, [, ms]) => a + ms, 0) / 1000;
  console.log('%c[assemble] stage timing:', 'font-weight:bold;color:#38bdf8');
  for (const [label, ms] of timings) console.log(`   ${label.padEnd(26)} ${(ms / 1000).toFixed(1)}s`);
  console.log(`   ${'TOTAL'.padEnd(26)} ${totalS.toFixed(1)}s  (${(totalS / 60).toFixed(1)} min)`);
  // Step markers in playable order — the .sbsproc manifest consumes these.
  const stepMarkers = plan.spans.flatMap(span =>
    span.steps.map(s => ({ stepId: s.id, timeInMs: Math.round(markersByStepId.get(s.id) ?? 0) })));
  return { path: outPath, totalMs, segments: plan.spans.length,
           reused: plan.spans.length - renderedCount, rendered: renderedCount,
           headers: !!(hdrListPath || boxFilters.length), timings, stepMarkers };
}

/**
 * Incremental .sbsproc export (V0.3.2.14): assemble the mp4 from the cache,
 * then pack it with a manifest built from the assembly's OWN exact markers —
 * the same numbers the audio and TOC use, so the viewer's step windows match
 * the video by construction.
 */
export async function assembleToSbsProc(opts = {}) {
  const ve = await import('./video-export.js');
  const r = await assembleFromCache(opts);
  const rf = await window.sbsNative.readFile(r.path, 'buffer');
  if (!rf?.ok) throw new Error('assembled mp4 read failed: ' + rf?.error);
  const bytes = rf.data instanceof Uint8Array ? rf.data : new Uint8Array(rf.data);
  const manifest = ve.buildSbsProcManifest({ stepMarkers: r.stepMarkers, totalDurationMs: r.totalMs });
  const blob = ve.packSbsProcBlob(manifest, bytes);
  return { ...r, blob, manifest, extension: 'sbsproc', totalDurationMs: r.totalMs };
}

export async function renderMissingSegments({ onProgress, signal, force = false, forceStepIds = null } = {}) {
  const { exportTimelineVideo } = await import('./video-export.js');
  const plan = await planWithCacheStatus();
  if (!plan.dir) throw new Error('Save the project first — the cache lives next to the .sbsproj.');
  if (force) { for (const s of plan.spans) s.cached = false; plan.hits = 0; }   // human override: re-render everything
  else if (forceStepIds?.size) {
    // Surgical override (user design): re-render the segments CONTAINING the
    // selected steps. A step inside a group forces its whole group's segment
    // (a group IS one segment); the previous step is the render's starting
    // pose automatically; the following segment needs nothing (end states are
    // identical by construction).
    for (const s of plan.spans) if (s.steps.some(st => forceStepIds.has(st.id))) s.cached = false;
    plan.hits = plan.spans.filter(s => s.cached).length;
  }
  const misses = plan.spans.filter(s => !s.cached);
  let done = 0, failed = 0;
  for (const span of misses) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    onProgress?.({ current: done + 1, total: misses.length, stepName: span.name });
    try {
      const isFirst = span.from === 0;
      // Honor the project's export settings (V0.3.2.22) — without these the
      // segments silently rendered at the built-in defaults (50fps/400ms/8M)
      // while the cache key claimed the configured values.
      const exp = state.get('export') || {};
      const res = await exportTimelineVideo({
        format: 'mp4', offline: true,
        fps:        Number.isFinite(Number(exp.fps))          ? Number(exp.fps)          : 50,
        stepHoldMs: Number.isFinite(Number(exp.stepHoldMs))   ? Number(exp.stepHoldMs)   : 800,
        bitrate:    Number.isFinite(Number(exp.videoBitrate)) ? Number(exp.videoBitrate) : 4_000_000,
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
  // FINAL SETTLE PASS (V0.3.2.22): playback is over — every step has been
  // activated and the data is as settled as this session gets. A span's steps
  // can still be mutated AFTER its own render (the lead step belongs to the
  // previous span; cable arrangements write back onto earlier defining
  // steps), so keying any earlier is too early. Re-key EVERY cached span now
  // and re-file any segment whose fingerprint moved — disk ends up keyed
  // exactly as the next plan will compute, so the next export HITS.
  let rekeyed = 0;
  for (const span of plan.spans) {
    if (!span.cached) continue;
    const oldKey = span.key;
    await _keySpan(span, plan);
    if (span.key === oldKey) continue;
    try {
      const mp4 = await window.sbsNative.readFile(`${plan.dir}/seg-${oldKey}.mp4`, 'buffer');
      const sj  = await window.sbsNative.readFile(`${plan.dir}/seg-${oldKey}.json`, 'utf8');
      if (!mp4?.ok || !sj?.ok) throw new Error('source segment unreadable');
      const sc = JSON.parse(sj.data); sc.key = span.key;
      const b = mp4.data instanceof Uint8Array ? mp4.data : new Uint8Array(mp4.data);
      let w = await window.sbsNative.writeFile(`${plan.dir}/seg-${span.key}.mp4`, b, null);
      if (!w?.ok) throw new Error(w?.error || 'mp4 copy failed');
      w = await window.sbsNative.writeFile(`${plan.dir}/seg-${span.key}.json`, JSON.stringify(sc), 'utf8');
      if (!w?.ok) throw new Error(w?.error || 'sidecar copy failed');
      span.file = `${plan.dir}/seg-${span.key}.mp4`;
      rekeyed++;
    } catch (e) {
      // Copy failed → keep pointing at the file that DOES exist so this
      // run's assembly still works; the next plan will just miss this span.
      console.warn(`[render-cache] settle re-file of "${span.name}" failed:`, e?.message);
      span.key = oldKey;
      span.file = `${plan.dir}/seg-${oldKey}.mp4`;
    }
  }
  if (rekeyed) console.log(`[render-cache] settle pass: ${rekeyed} segment(s) re-filed under settled fingerprints`);

  // Record this fill's key inputs so the next plan can NAME the cause of any
  // mass invalidation (V0.3.2.20).
  if (done > 0 && !failed) {
    try {
      await window.sbsNative.writeFile(`${plan.dir}/_keyinputs.json`,
        JSON.stringify({ settings: plan.settingsKey, defs: plan.defsKey }), 'utf8');
    } catch { /* best-effort */ }
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
  const out = { ...plan, dir, hits, misses: plan.spans.length - hits };
  if (dir) await _reportPlanDrift(out, dir);

  // WHY-INVALIDATED report (V0.3.2.20): when most of the cache missed, diff
  // the current key inputs against the ones recorded at the last successful
  // fill and NAME the cause — no more silent full re-renders.
  if (dir && out.misses > plan.spans.length / 2) {
    try {
      const prev = await window.sbsNative.readFile(`${dir}/_keyinputs.json`, 'utf8');
      if (prev?.ok) {
        const old = JSON.parse(prev.data);
        const parts = [];
        for (const k of ['prims', 'shapes', 'colors', 'cables']) {
          if (JSON.stringify(old.defs?.[k]) !== JSON.stringify(plan.defsKey[k])) parts.push(k === 'prims' ? 'primitives' : k);
        }
        if (JSON.stringify(old.settings) !== JSON.stringify(plan.settingsKey)) parts.push('render settings');
        if (parts.length) {
          out.invalidationHint = `cache mass-invalidated because DEFINITIONS changed: ${parts.join(', ')} (your rule: project-wide change → render everything)`;
          console.warn('[render-cache] ' + out.invalidationHint);
        }
      }
    } catch { /* report is best-effort */ }
  }
  return out;
}
