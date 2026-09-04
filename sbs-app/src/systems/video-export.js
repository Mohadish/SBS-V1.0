/**
 * SBS — Video export
 * ==================
 * Two backends, same timeline-playback loop:
 *
 *   format: 'mp4'       → WebCodecs VideoEncoder (H.264) + mp4-muxer
 *                         Writes moov at the front (fastStart) so timelines
 *                         scrub cleanly in any editor / player.
 *   format: 'webm_vp9'  → MediaRecorder on canvas.captureStream (legacy path)
 *   format: 'webm_vp8'  → MediaRecorder, older codec
 *
 * mp4-muxer is vendored at sbs-app/vendor/mp4-muxer.mjs so the build is fully
 * offline. H.264 encoding uses the OpenH264 binary bundled with Electron
 * (royalty-free commercial umbrella).
 *
 * Future upgrade (phase 2+): offline render loop — advance the animation
 * clock by fixed dt per encoded frame instead of real-time playback. Drop-in
 * replacement; keeps the same encoder layer.
 */

import { state }     from '../core/state.js';
import { steps, setSleepImpl } from './steps.js';
import { isIsolateEngaged, suspendIsolate, resumeIsolate } from '../core/isolate-state.js';
import * as clock    from '../core/clock.js';
import { sceneCore } from '../core/scene.js';
import { rasterizeOverlay, waitForOverlayStable, refreshAllTocBoxesData } from './overlay.js';
import * as videoOverlay from './video-overlay.js';   // 🎬 V0.3.2.82 — seek-per-frame + step duration
import { stepHasOverlaySlot } from './narration-timeline.js';   // 🎬 V0.3.2.84 — video-in-phase vs video-in-hold
import { rasterizeHeaderLayer, waitForHeaderStable }  from './header.js';
import { rasterizeNotesLayer }                        from './notes-render.js';
import { rasterizeTagsLayer }                         from './hardware-insert-anim.js';
import { computeSafeFrameRect }                       from '../core/safe-frame.js';
import { decodeToAudioBuffer, resampleToMonoFloat32, mixTrackToFloat32 } from './audio-bridge.js';
import { synthesize as ttsSynthesize } from './tts.js';
import * as narrationCache from './narration-cache.js';
// V0.2.22.11 — animation phase string parser, used to compute the
// per-step narration start offset (live app fires narration when its
// phase is reached; export must place audio at marker+offset to match).
import { parseAnimation, resolveAnimationString } from './animation.js';

// Vendored ES module (see sbs-app/vendor/mp4-muxer.mjs).
import { Muxer as Mp4Muxer, ArrayBufferTarget } from '../../vendor/mp4-muxer.mjs';

// V0.2.22.2: 50 fps default. Higher FPS produces SMALLER MP4 files for
// slide-show content (smaller per-frame deltas compress better in P-frames)
// AND visibly reduces the step-transition seam stutter. 25/50/100 give clean
// integer frame intervals in ms (40/20/10), avoiding sub-frame remainder
// drift in the offline synthetic sleep.
const DEFAULT_FPS       = 50;
const DEFAULT_BITRATE   = 8_000_000;   // 8 Mbps — 1080p screencast quality
const POST_STEP_HOLD_MS = 400;

/**
 * @param {object} opts
 * @param {'mp4'|'webm_vp9'|'webm_vp8'} [opts.format='mp4']
 * @param {number}  [opts.fps=30]
 * @param {number}  [opts.bitrate=8000000]
 * @param {number}  [opts.stepHoldMs=400]
 * @param {(progress:{current:number,total:number,stepName:string})=>void}
 *                  [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{blob:Blob, extension:string}>}
 */
export async function exportTimelineVideo(opts = {}) {
  let format = opts.format ?? 'mp4';

  // Offline (synthetic-clock, frame-by-frame) render ONLY exists in the MP4
  // engine. WebM is a live MediaRecorder grab off canvas.captureStream() — it
  // cannot decouple from wall-clock, so on a heavy model it captures whatever
  // the GPU managed in real time (the "5 fps stretched over 15" stutter). If
  // the user asked for offline, honour it by forcing MP4 rather than silently
  // falling back to a realtime WebM grab.
  if (opts.offline && format !== 'mp4') {
    console.warn('[export] offline render requested → forcing MP4 (WebM is realtime-only)');
    format = 'mp4';
  }

  return _withIsolateSuspended(() => {
    if (format === 'mp4')          return _exportMp4(opts);
    if (format.startsWith('webm')) return _exportWebM(opts);
    throw new Error(`Unsupported export format: ${format}`);
  });
}

/**
 * Run an export with the isolate mask SUSPENDED. Isolate is a viewport
 * inspection aid, never part of a deliverable — frames must render the true
 * per-step scene. On exit we re-engage the mask and re-stage the active step so
 * the user's isolated view returns exactly as it was.
 */
async function _withIsolateSuspended(fn) {
  const hadIsolate = isIsolateEngaged();
  const restage = () => {
    const active = (state.get('steps') || []).find(s => s.id === state.get('activeStepId'));
    if (active?.snapshot) steps.applySnapshotInstant(active.snapshot);
    steps.snapMeshesOpaque(false);   // reset ALL meshes — any export step may reveal one
  };
  if (hadIsolate) { suspendIsolate(); restage(); }   // reveal real steps for capture
  try {
    return await fn();
  } finally {
    if (hadIsolate) { resumeIsolate(); restage(); }  // restore the isolated view
  }
}

/**
 * Export the timeline as a .sbsproc — the proprietary single-file
 * container the SBS viewer reads. Layout:
 *
 *     [8 bytes]  ASCII magic     "SBSPROC1"
 *     [4 bytes]  uint32 LE       manifest_len  (UTF-8 byte length)
 *     [N bytes]  UTF-8 JSON      manifest      (see _buildSbsProcManifest)
 *     [rest]     raw bytes       MP4 container
 *
 * Self-contained, NOT a zip. The viewer fetches the file, reads the
 * 12-byte header, slices the manifest JSON, then exposes the trailing
 * MP4 bytes as a Blob URL for an HTML5 video element.
 *
 * Always uses the MP4 encoder (the viewer pipeline assumes a valid
 * MP4 stream as the trailing payload).
 */
export async function exportTimelineSbsProc(opts = {}) {
  const result = await _withIsolateSuspended(() => _exportMp4(opts));
  const manifest = _buildSbsProcManifest(result);
  const blob = _packSbsProcBlob(manifest, result.mp4Buffer);
  return {
    blob,
    extension: 'sbsproc',
    codec:     result.codec,
    manifest,
    totalDurationMs: result.totalDurationMs,
  };
}

/**
 * Build the manifest JSON for a .sbsproc. Step-groups collapse to ONE
 * viewer-step per spec: the head's marker becomes the viewer-step's
 * `time_in_ms`, and the entry that immediately follows the LAST sub-
 * step (or the video end) becomes its `time_out_ms`. Sub-step markers
 * are included as `sub_steps` on the viewer-step entry so a future
 * viewer can show internal progress without breaking the "groups read
 * as one step" rule.
 */
function _buildSbsProcManifest(result) {
  const stepsArr = state.get('steps') || [];
  // Map stepId → marker for fast lookup.
  const markerOf = new Map();
  for (const m of result.stepMarkers || []) markerOf.set(m.stepId, m.timeInMs);
  // Filter to playable steps in encoded order — same set _exportMp4 used.
  const playable = stepsArr.filter(s => steps._isPlayable(s));
  const totalMs  = result.totalDurationMs;

  // Walk in order. For each TOP-LEVEL entry, record one viewer-step.
  // A group head's window runs from its marker through the marker of
  // the next top-level entry (or totalMs at the end). Sub-steps go
  // inside `sub_steps` on the head's viewer-step.
  const viewerSteps = [];
  for (let i = 0; i < playable.length; i++) {
    const s = playable[i];
    if (s.groupId) continue;   // sub-steps emitted via head below
    const timeInMs = markerOf.get(s.id) ?? 0;
    // Find next top-level marker (or video end).
    let timeOutMs = totalMs;
    for (let j = i + 1; j < playable.length; j++) {
      if (!playable[j].groupId) {
        timeOutMs = markerOf.get(playable[j].id) ?? totalMs;
        break;
      }
    }
    const entry = {
      id:               s.id,
      title:            s.name || 'Untitled',
      time_in_ms:       timeInMs,
      time_out_ms:      timeOutMs,
      narration_text:   _extractNarrationText(s),
      notes_text:       '',
    };
    if (s.groupHead) {
      const subs = [];
      for (let j = i + 1; j < playable.length && playable[j].groupId === s.id; j++) {
        const sub  = playable[j];
        const subInMs  = markerOf.get(sub.id) ?? timeInMs;
        // Sub-step's own window ends at the next sub-step (same group)
        // or the group's outer timeOutMs.
        let subOutMs = timeOutMs;
        for (let k = j + 1; k < playable.length; k++) {
          const m = markerOf.get(playable[k].id);
          if (m !== undefined) { subOutMs = m; break; }
        }
        subs.push({
          id:             sub.id,
          title:          sub.name || 'Untitled',
          time_in_ms:     subInMs,
          time_out_ms:    subOutMs,
          narration_text: _extractNarrationText(sub),
        });
      }
      if (subs.length) entry.sub_steps = subs;
    }
    viewerSteps.push(entry);
  }

  return {
    format:            'sbsproc',
    version:           1,
    title:             state.get('projectName') || 'Untitled Process',
    total_duration_ms: totalMs,
    fps:               null,                     // muxer wrote whatever fps was used; viewer uses time_in/_out only
    codec:             result.codec || null,
    steps:             viewerSteps,
  };
}

function _extractNarrationText(step) {
  // Step text lives across two fields; prefer the explicit narration
  // record (richer), fall back to voiceText (legacy / TTS-only steps).
  return (step?.narration?.text || step?.voiceText || '').trim();
}

/**
 * Concatenate the .sbsproc binary: magic + uint32 LE manifest length +
 * UTF-8 manifest JSON + MP4 bytes. Returns a single Blob.
 */
function _packSbsProcBlob(manifest, mp4Buffer) {
  const enc = new TextEncoder();
  const manifestBytes = enc.encode(JSON.stringify(manifest));
  // 12-byte fixed header: 8 magic + 4 length.
  const header = new Uint8Array(12);
  header.set(enc.encode('SBSPROC1'), 0);
  new DataView(header.buffer).setUint32(8, manifestBytes.length, true);
  return new Blob(
    [header, manifestBytes, mp4Buffer],
    { type: 'application/octet-stream' },
  );
}

/**
 * Trigger a browser download of the given Blob.
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Write a Blob to a user-chosen absolute path via the binary fs bridge
 * (V0.3.2.30). Exports ask WHERE FIRST (dialog), render, then land here —
 * no browser-download behavior. Throws on write failure.
 */
export async function saveBlobToPath(blob, outPath) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const r = await window.sbsNative.writeFile(outPath, bytes, null);
  if (!r?.ok) throw new Error('write failed: ' + (r?.error || 'unknown'));
  return outPath;
}

// ═══════════════════════════════════════════════════════════════════════════
//  MP4 — WebCodecs VideoEncoder + mp4-muxer
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Group-aware audio-tail-aware perStepHold (V0.2.22.10/.11 model, extracted
 * V0.3.1.74 so the timing-only dry run shares the EXACT same code — one source
 * of truth). See the long design comment at the _exportMp4 call site history:
 * overflow allowed iff next step is in the same group AND has no audio; else
 * wait for the whole group's audio tail (offset-aware) + stepHoldMs breath.
 */
function _computePerStepHolds(stepsToPlay, stepHoldMs) {
  const globalObjDur = state.get('objectAnimDurationMs') ?? 1500;
  const _estimateAnimDur = (s) => {
    const t = s.transition || {};
    return t.durationOverride === true ? (t.objectDurationMs ?? globalObjDur) : globalObjDur;
  };
  const groupKeyOf  = (s) => s.groupHead ? s.id : (s.groupId || null);
  const groupKeys   = stepsToPlay.map(groupKeyOf);
  const narrDurs    = stepsToPlay.map(s => s.narration?.durationMs || 0);
  const animDurs    = stepsToPlay.map(_estimateAnimDur);
  const narrOffsets = stepsToPlay.map(_narrationStartOffsetMs);   // audio starts at markers[i]+offset
  const markers     = new Array(stepsToPlay.length);
  markers[0] = 0;
  const perStepHold = new Array(stepsToPlay.length);
  const _diagTiming = !!(typeof window !== 'undefined' && window.sbsDiag?.exportTiming);
  if (_diagTiming) {
    console.log('[export] perStepHold table:');
    console.log('  [#] groupKey  | name           | anim | narr | nOff | mkr  | hold | reason');
  }
  let _overflowCount = 0;
  for (let i = 0; i < stepsToPlay.length; i++) {
    const step    = stepsToPlay[i];
    const nextI   = i + 1;
    const myKey   = groupKeys[i];
    const nextKey = nextI < stepsToPlay.length ? groupKeys[nextI] : null;
    const inSameGroupAsNext = myKey !== null && myKey === nextKey;
    const nextHasAudio = nextI < stepsToPlay.length && narrDurs[nextI] > 0;
    const stepAnimEnd  = markers[i] + animDurs[i];
    let hold, reason;
    if (inSameGroupAsNext && !nextHasAudio) {
      hold   = stepHoldMs;                       // overflow into next-step frames
      reason = 'OVERFLOW (same group, next no audio)';
      _overflowCount++;
    } else {
      let groupAudioEnd = stepAnimEnd;                          // floor
      groupAudioEnd = Math.max(groupAudioEnd, markers[i] + narrOffsets[i] + narrDurs[i]);
      if (myKey !== null) {
        for (let j = i - 1; j >= 0 && groupKeys[j] === myKey; j--) {
          groupAudioEnd = Math.max(groupAudioEnd, markers[j] + narrOffsets[j] + narrDurs[j]);
        }
      }
      hold   = Math.max(0, groupAudioEnd - stepAnimEnd) + stepHoldMs;
      reason = inSameGroupAsNext
        ? 'wait (next in-group has audio, collision avoid)'
        : (myKey !== null ? 'wait (end of group)' : 'wait (top-level)');
    }
    perStepHold[i] = hold;
    if (nextI < stepsToPlay.length) markers[nextI] = stepAnimEnd + hold;
    if (_diagTiming) {
      const keyShort = (myKey || '—').slice(0, 8).padEnd(8);
      const nm = (step.name || '').slice(0, 14).padEnd(14);
      console.log(`  [${String(i).padStart(2)}] ${keyShort} | ${nm} | anim=${String(animDurs[i]).padStart(5)} | narr=${String(narrDurs[i]).padStart(5)} | nOff=${String(narrOffsets[i]).padStart(4)} | mkr=${String(markers[i]).padStart(5)} | hold=${String(hold).padStart(5)} | ${reason}`);
    }
  }
  const _totalEstMs = (markers[stepsToPlay.length - 1] || 0) + animDurs[animDurs.length - 1] + perStepHold[perStepHold.length - 1];
  console.log(`[export] timing: ${stepsToPlay.length} step(s), ${_overflowCount} overflow(s), est total ${Math.round(_totalEstMs)}ms`);
  return perStepHold;
}

/**
 * TIMING-ONLY DRY RUN (V0.3.1.74) — measure every step's EXACT timeline
 * duration WITHOUT rendering or encoding a single frame.
 *
 * Plays the timeline through the SAME machinery as the offline export: real
 * activateStep animations (multi-phase strings, insert reposition→pause→
 * assemble, cable morphs), the same group-aware perStepHold, the same
 * synthetic clock quantised to the same fps — so the measured markers match a
 * real export to within a frame. The only difference: the per-frame render +
 * encode is skipped entirely, so ~an hour of rendering becomes ~a minute.
 *
 * Results are persisted via _recordRenderedDurations (renderedDurationMs on
 * each step) → computeChapterTimecodes turns exact → refresh the TOC box and
 * render ONCE with correct times baked in.
 */
export async function measureTimelineDurations({ fps, onProgress, signal } = {}) {
  const stepsToPlay = (state.get('steps') || []).filter(s => steps._isPlayable(s));
  if (!stepsToPlay.length) throw new Error('No steps to measure.');
  const exp = state.get('export') || {};
  // fps MUST match the project's real export fps — frame quantization depends on
  // it. (48fps drops ~10ms/sleep that 50fps's grid-aligned constants don't; the
  // DEFAULT_FPS assumption caused a systematic +35ms/step overshoot on a 48fps
  // project — user-measured, marker-forensics-confirmed. V0.3.1.77)
  if (!Number.isFinite(fps)) fps = Number.isFinite(exp.fps) && exp.fps > 0 ? exp.fps : DEFAULT_FPS;
  const stepHoldMs = Number.isFinite(exp.stepHoldMs) ? exp.stepHoldMs : POST_STEP_HOLD_MS;
  const prevActiveId = state.get('activeStepId');

  // Narration clips must exist for the hold math (durations) — same pre-synth
  // pass the real export runs; cached clips make this a no-op.
  try { await _synthesizeMissingClips(stepsToPlay, onProgress, signal); } catch (e) { console.warn('[measure] pre-synth skipped:', e?.message); }
  const perStepHold = _computePerStepHolds(stepsToPlay, stepHoldMs);

  const frameIntervalMs = 1000 / fps;
  let synthMs   = 0;
  // ENCODED-frame time — mirrors the real export's nextFrameUs exactly. The
  // encoder emits one frame per FULL frame slot; a sleep's sub-frame remainder
  // advances the synthetic clock but encodes NOTHING, so the real video runs a
  // fraction shorter than the clock at every phase/hold boundary. Counting raw
  // synthMs overshot ~40ms/step (+6s over 14min, user-measured); markers must
  // be in encoded time, like the export's own step markers. (V0.3.1.75)
  let encodedMs = 0;
  const _timingSleep = async (ms) => {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const target = synthMs + Math.max(0, ms);
    let n = 0;
    while (synthMs + frameIntervalMs <= target) {
      synthMs += frameIntervalMs;
      sceneCore.fireSyntheticTick(synthMs, frameIntervalMs);
      encodedMs += frameIntervalMs;                        // ← one encoded frame per full slot
      // Yield every ~2s of timeline so the UI breathes + async image rasters resolve.
      if (++n % 100 === 0) { await new Promise(r => setTimeout(r, 0)); if (signal?.aborted) throw new DOMException('aborted', 'AbortError'); }
    }
    if (target > synthMs) { const rem = target - synthMs; synthMs = target; sceneCore.fireSyntheticTick(synthMs, rem); }   // no frame — matches encoder
  };

  const stepMarkers = [];
  const onStepStart = (i, step) => stepMarkers.push({ stepId: step.id, timeInMs: Math.round(encodedMs) });

  state.setState({ _exporting: true });        // suppress live narration playback
  await _hardResetToFirstStep(stepsToPlay);
  sceneCore.stopLoop();
  clock.setClockImpl(() => synthMs);
  setSleepImpl(_timingSleep);
  _setWaitImpl(_timingSleep);
  try {
    await _playTimeline(stepsToPlay, perStepHold, onProgress, signal, onStepStart, true);
    // Sentinel so the LAST step also gets a measured duration (gap to the end).
    stepMarkers.push({ stepId: '__end__', timeInMs: Math.round(encodedMs) });
    _recordRenderedDurations(stepMarkers);
    return { steps: stepsToPlay.length, totalMs: Math.round(encodedMs) };
  } finally {
    clock.setClockImpl(null);
    setSleepImpl(null);
    _setWaitImpl(null);
    sceneCore.startLoop();
    state.setState({ _exporting: false });
    // Land the scene back where the user was (instant apply).
    try { if (prevActiveId) await steps.activateStep(prevActiveId, false); } catch {}
  }
}

async function _exportMp4({ fps = DEFAULT_FPS, bitrate = DEFAULT_BITRATE,
                            stepHoldMs = POST_STEP_HOLD_MS,
                            includeNarration = true,
                            offline = false,
                            // V0.3.2.1 — step-render-cache groundwork (proof-of-seam):
                            _stepsRange  = null,    // [fromIdx, toIdx] into the playable list → render just that span
                            _zeroLeadHold = false,  // lead step emits 0 frames → output starts exactly at the transition into step 2 of the span
                            _noAutoSync   = false,  // segment/test renders skip the TOC timing pass
                            // V0.3.2.3 — cached-segment mode:
                            _noHeader     = false,  // exclude the ENTIRE header layer (composited at assembly instead)
                            _noAudioTrack = false,  // narration-TIMED holds but NO audio track (audio mixed globally at assembly)
                            onProgress, signal } = {}) {
  const _wallStartMs = performance.now();   // for the end-of-export summary
  const canvas = sceneCore.renderer?.domElement;
  if (!canvas) throw new Error('No 3D canvas available to export.');

  let stepsToPlay = (state.get('steps') || []).filter(s => steps._isPlayable(s));
  if (Array.isArray(_stepsRange)) {
    const [f, t] = _stepsRange;
    stepsToPlay = stepsToPlay.slice(Math.max(0, f), Math.min(stepsToPlay.length, t + 1));
  }
  if (!stepsToPlay.length) throw new Error('No steps to export — add at least one step first.');

  // AUTO-SYNC (V0.3.1.78, user-requested "mandatory check before render"): if
  // any step lacks a measured duration (new/edited since the last sync), run
  // the timing-only dry run FIRST, then rewrite every TOC box (style-preserving)
  // so THIS render bakes exact chapter times — no manual sbsTocSync needed.
  // All-measured projects skip this entirely (zero cost).
  const _staleCount = stepsToPlay.filter(s => !Number.isFinite(s.renderedDurationMs)).length;
  if (!_noAutoSync && _staleCount > 0) {
    console.log(`[export] auto-sync: ${_staleCount} step(s) without measured timing — running the timing pass first…`);
    await measureTimelineDurations({
      fps,
      onProgress: (p) => onProgress?.({ ...p, stepName: `Timing: ${p.stepName ?? ''}` }),
      signal,
    });
    const tocSteps = await refreshAllTocBoxesData();
    if (tocSteps) console.log(`[export] auto-sync: refreshed TOC boxes in ${tocSteps} step(s).`);
  }

  // Output dimensions come from the project's canonical export config
  // (state.export.width × state.export.height), NOT the viewport canvas.
  // The viewport canvas is whatever size the user's window happens to
  // be — using it produced different resolutions on different machines
  // and ignored the W/H fields in the Export tab. Composite onto an
  // OffscreenCanvas at the canonical size; drawImage scales the live
  // canvas into the target rect. Stage 4 will render natively at the
  // canonical size for sharper output.
  const _exp   = state.get('export') || {};
  const width  = (Number.isFinite(_exp.width)  && _exp.width  > 0) ? _exp.width  : canvas.width;
  const height = (Number.isFinite(_exp.height) && _exp.height > 0) ? _exp.height : canvas.height;

  // The canvas is ALWAYS at canonical buffer + canonical-aspect camera
  // (sceneCore.fitToCanonical, called from init / resize / change:export),
  // so export needs no per-run renderer surgery. Live preview already
  // looks identical to what's being encoded.

  // ── Build the step timeline (initial estimate — actual values come from
  // the recompute after _synthesizeMissingClips below).
  const perStepHold = stepsToPlay.map(step => {
    const narrMs = includeNarration ? (step.narration?.durationMs || 0) : 0;
    // 🎬 V0.3.2.84 — with an overlay slot in the animation string, the
    // video plays INSIDE the stretched overlay phase (the phase engine
    // holds that block open for the whole trimmed window), so it must NOT
    // also inflate the hold — that would double-count the clip. Only a
    // step with NO overlay slot plays its clip during the hold. Mirrors
    // narration-timeline's estimate exactly.
    const videoMs = videoOverlay.stepVideoWindowMs(step);
    const videoInHold = (videoMs > 0 && !stepHasOverlaySlot(step)) ? videoMs : 0;
    return Math.max(narrMs, videoInHold) + stepHoldMs;
  });

  // 🔬 V0.3.2.92 — SELF-ARMING fade diagnostics. Any export containing a
  // video step turns the trace on automatically (no user setup): every run
  // produces the ghost-handoff / fade-ramp / composite-pixel evidence the
  // fade-out investigation has been missing from every manual repro.
  if (typeof window !== 'undefined' && stepsToPlay.some(s => videoOverlay.stepVideoWindowMs(s) > 0)) {
    window.sbsDiag = window.sbsDiag || {};
    if (!window.sbsDiag.videoExportTrace) {
      window.sbsDiag.videoExportTrace = true;
      console.log('[vtrace] AUTO-ENABLED — export contains a video step; expect GHOST HANDOFF / fade / pixel lines below');
    }
  }

  // Pick a codec the host actually supports. Chromium/Electron builds vary:
  // some ship OpenH264 encoding (H.264/avc), most ship software VP9 encoding,
  // newer builds ship AV1. mp4-muxer accepts all three in an MP4 container
  // and every one of them produces a scrubbable timeline.
  const codecCandidates = [
    // H.264 (universal playback — preferred when available)
    { webCodec: 'avc1.640033', muxerCodec: 'avc' },  // High, Level 5.1 (≤4K)
    { webCodec: 'avc1.640028', muxerCodec: 'avc' },  // High, Level 4.0 (≤1080p30)
    { webCodec: 'avc1.42E01F', muxerCodec: 'avc' },  // Baseline, Level 3.1
    // VP9 (royalty-free; VP9-in-MP4 plays in Chrome, Firefox, Edge, VLC 3+, modern editors)
    { webCodec: 'vp09.00.10.08', muxerCodec: 'vp9' },
    // AV1 (royalty-free, modern; software-encoded on most setups)
    { webCodec: 'av01.0.04M.08', muxerCodec: 'av1' },
  ];
  let chosen = null;
  for (const c of codecCandidates) {
    try {
      const probe = await VideoEncoder.isConfigSupported({
        codec: c.webCodec, width, height, bitrate, framerate: fps,
      });
      if (probe?.supported) { chosen = c; break; }
    } catch { /* some builds throw on unknown strings — just try the next */ }
  }
  if (!chosen) throw new Error('No supported video codec (H.264 / VP9 / AV1).');

  // ── Audio: pre-decode all narration clips → master Float32 timeline.
  // Done before muxer/encoder setup so we know whether to add an audio track.
  const AUDIO_RATE     = 48000;
  const AUDIO_CHANNELS = 1;
  const AUDIO_BITRATE  = 96_000;
  let audioMaster   = null;       // Float32 PCM aligned to step start times
  let audioCodec    = null;       // 'opus' | 'aac'
  let audioEncoder  = null;
  let audioTrackEnabled = false;

  // Decoded segments (per-step samples). Mixed AFTER _playTimeline using
  // captured step markers so the audio offsets match the actual encoded
  // video timeline — `step.transition.durationMs` estimates can drift
  // from real animation length, especially under realtime throttling,
  // which makes step N+1's narration creep into step N's hold.
  let audioSegments = null;
  if (includeNarration) {
    try {
      // Pre-synth: any step with narration text but no fresh cached clip
      // gets synthesized now so audio bridge finds them all. Runs for every
      // export entry point (timeline button, Export tab Start, etc.).
      await _synthesizeMissingClips(stepsToPlay, onProgress, signal);

      // V0.2.22.8 — group-aware surgical pause computation.
      //
      // V0.2.22.7's mistake: used uniform "next-has-audio" logic for ALL
      // steps. That let top-level steps overflow into the next top-level
      // when the next had no narration — violating the user's explicit
      // earlier preference ("Within sub-steps of same parent only").
      //
      // Correct rule = V0.2.22.6 grouping + V0.2.22.7 surgical math:
      //
      //   • Top-level step (no group, or step.groupHead === true):
      //       Always wait for own narration. Pause = max(0, narrMs - animDur)
      //       + stepHoldMs.
      //
      //   • Last sub-step in a group:
      //       Always wait. Same surgical pause as top-level. Prevents
      //       this group's narration from leaking into the next top-level.
      //
      //   • Mid-group sub-step:
      //       Check if NEXT sub-step has audio.
      //       - If yes: wait (surgical pause) so the two voices don't
      //         collide.
      //       - If no: pause = stepHoldMs only. Trailing audio overflows
      //         naturally into next sub-step's frames (additive mix
      //         in audio-bridge.js).
      //
      // Animation duration per step matches applySnapshotAnimated's
      // simultaneous-mode math:
      //   transition.durationOverride ? transition.objectDurationMs
      //                               : state.objectAnimDurationMs
      //   (fallback: 1500ms)
      //
      // Classifier:
      //   isSubStep      = !!step.groupId && step.groupHead !== true
      //   isLastInGroup  = isSubStep && (no next OR next.groupId differs)
      //
      // Known limitation: estimated animation duration may drift from
      // run-time actual under realtime browser throttling. Default
      // offline mode (V0.2.22.3) makes the synthetic clock deterministic
      // and drift-free.
      const perStepHoldComputed = _computePerStepHolds(stepsToPlay, stepHoldMs);
      perStepHoldComputed.forEach((h, i) => { perStepHold[i] = h; });
      // V0.2.22.10 — group-aware audio-tail-aware perStepHold.
      //
      // Diagnosis from V0.2.22.9: my classifier treated group HEADS as
      // top-level, forcing them to wait for their own narration. But a
      // group head's narration must be able to overflow into its
      // sub-steps (the user's "Step 1 (copy)" → "New Step" case).
      //
      // New model: GROUP MEMBERSHIP (not head/sub role).
      //   groupKey(s) = s.groupHead ? s.id : (s.groupId || null)
      //   step i and i+1 are "in same group" iff groupKey[i] === groupKey[i+1]
      //   AND groupKey[i] !== null (non-grouped steps don't pair up).
      //
      // Overflow rule for step i:
      //   Allowed iff: next step is in same group AND next has no audio.
      //   If allowed: perStepHold[i] = stepHoldMs (breath only). The
      //     animation moves on; this step's audio plays into the next
      //     step's frames.
      //   Else: wait for THE GROUP'S total audio tail to finish before
      //     advancing — surgical. The wait covers not just THIS step's
      //     own narration but any prior in-group narration that's still
      //     playing (from overflows earlier in the group). Computed
      //     against estimated markers built up forward.
      //
      // This puts group heads and mid-group sub-steps on equal footing.
      // The last step in a group does the heavy lifting of waiting for
      // the group's audio tail so nothing leaks into the next group /
      // top-level step.
      if (_noAudioTrack) {
        // Segment mode: holds above are narration-TIMED (the video makes room
        // for the voice), but the audio itself is mixed globally at assembly.
        audioTrackEnabled = false;
      } else {
        console.log('[export] decoding audio segments…');
        audioSegments = await _decodeNarrationSegments(stepsToPlay, AUDIO_RATE);
        audioTrackEnabled = audioSegments.hasAudio;
        console.log(`[export] audio decoded: ${audioTrackEnabled ? `${audioSegments.segments.length} clip(s)` : 'no clips'}`);
      }
    } catch (err) {
      console.warn('[export] audio bridge failed — exporting video only:', err);
      audioTrackEnabled = false;
    }
  }

  // Segment semantics (V0.3.2.1): with _zeroLeadHold the FIRST step of the span
  // is instant-applied by the hard reset but contributes ZERO frames (its hold
  // is zeroed; offline frames are only emitted inside sleeps). The output then
  // starts exactly at the transition into the span's second step — i.e. a
  // segment = "transition into step K + K's hold", given span [K-1, …].
  if (_zeroLeadHold && perStepHold.length) perStepHold[0] = 0;

  const muxerCfg = {
    target: new ArrayBufferTarget(),
    fastStart: 'in-memory',        // moov at front → scrubbable
    video: {
      codec: chosen.muxerCodec,
      width,
      height,
      frameRate: fps,
    },
  };
  if (audioTrackEnabled) {
    // Prefer AAC (universal MP4 player support — WMP, QuickTime, iOS, mobile).
    // Fall back to Opus if the Electron build doesn't ship an AAC encoder.
    // Opus-in-MP4 is technically valid but only VLC / browsers / pro tools
    // play it; native OS players treat the audio track as missing.
    const audioCandidates = ['mp4a.40.2', 'opus'];
    for (const c of audioCandidates) {
      try {
        const probe = await AudioEncoder.isConfigSupported({
          codec: c, sampleRate: AUDIO_RATE, numberOfChannels: AUDIO_CHANNELS, bitrate: AUDIO_BITRATE,
        });
        if (probe?.supported) {
          audioCodec = c;
          break;
        }
      } catch { /* try next */ }
    }
    if (audioCodec) {
      muxerCfg.audio = {
        codec:           audioCodec === 'opus' ? 'opus' : 'aac',
        numberOfChannels: AUDIO_CHANNELS,
        sampleRate:       AUDIO_RATE,
      };
    } else {
      console.warn('[export] No audio encoder available — exporting without narration.');
      audioTrackEnabled = false;
    }
  }
  const muxer = new Mp4Muxer(muxerCfg);

  // Async encoder errors arrive on this callback OFF the await chain — throwing
  // here just produces an unhandled rejection and the export keeps awaiting a
  // dead encoder forever (queue never drains → backpressure loop spins → app
  // freezes). Capture it instead; the frame pump checks it and aborts cleanly
  // so the `finally` restores the render loop.
  let _encoderError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error:  (e) => { _encoderError = _encoderError || e; console.error('[export] video encoder error:', e?.message || e); },
  });
  encoder.configure({ codec: chosen.webCodec, width, height, bitrate, framerate: fps });

  // Audio encoder is configured here but NOT pumped yet — the master
  // PCM is mixed AFTER _playTimeline using captured step markers, so
  // the encode runs serially after video. Slight serial cost vs the
  // legacy concurrent path, but the only way to align audio to the
  // ACTUAL synth/realtime clock the encoder used. Without this, slow
  // animations (realtime throttling, multi-phase transitions) push
  // step N's transition past its `durationMs` estimate and step N+1's
  // narration creeps backward into step N's hold ("voice creep").
  if (audioTrackEnabled) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error:  (e) => { console.error('[export] audio encoder', e); },
    });
    audioEncoder.configure({
      codec: audioCodec, sampleRate: AUDIO_RATE, numberOfChannels: AUDIO_CHANNELS, bitrate: AUDIO_BITRATE,
    });
  }

  // Frame pump — captures the canvas and encodes frames at fixed timestamps.
  //
  // Two strategies:
  //   • realtime (default): rAF tick hook captures however many frame slots
  //     have elapsed in wall-clock time. Smooth, but throttled when the
  //     window is backgrounded / floating small (Chromium throttles rAF +
  //     setTimeout in those cases — exports take 5× longer there).
  //   • offline: stops the rAF loop, overrides steps._sleep so each phase
  //     advances a synthetic clock by exactly 1/fps per encoded frame. The
  //     animation timeline drives the encoder directly — wall-clock time
  //     and window throttling are completely decoupled from the output.
  //     Slower than realtime when realtime isn't throttled, but produces
  //     identical-duration output regardless of host conditions.
  //
  // Composite: we draw the 3D canvas and the Konva overlay into an offscreen
  // 2D canvas, then build the VideoFrame from that. This bakes the overlay
  // (text boxes, images) into the encoded output.
  const composite    = new OffscreenCanvas(width, height);
  const compositeCtx = composite.getContext('2d');

  const frameIntervalUs = 1_000_000 / fps;
  const frameIntervalMs = 1000 / fps;
  let nextFrameUs = 0;
  let _framesRendered = 0, _framesReused = 0;   // holds-only 3D-render-skip stats
  const _captureAndEncode = () => {
    // 1. Lay down the 3D frame at native size.
    // Stage 4: extract just the SAFE-FRAME rect from the live viewport
    // canvas (it has the canonical aspect by construction), then
    // drawImage it into the canonical W × H output. Without this crop,
    // drawImage stretched the full viewport canvas (whatever aspect
    // that was) into the canonical output, which squished everything
    // when viewport aspect ≠ canonical aspect.
    compositeCtx.clearRect(0, 0, width, height);
    const sf = computeSafeFrameRect({ width: canvas.width, height: canvas.height });
    if (sf.width > 0 && sf.height > 0) {
      compositeCtx.drawImage(canvas, sf.x, sf.y, sf.width, sf.height, 0, 0, width, height);
    } else {
      compositeCtx.drawImage(canvas, 0, 0, width, height);
    }
    // 2. Bake the per-step overlay on top.
    const ov = rasterizeOverlay({ width, height });
    if (ov) compositeCtx.drawImage(ov, 0, 0, width, height);
    // 2b. Bake 3D-anchored balloon notes. The live tick paints these
    //     as DOM divs + SVG paths, which canvas-only export pipelines
    //     can't capture — without this composite step they would
    //     simply not appear in the encoded MP4 / .sbsproc. Layered
    //     above the Konva overlay so notes draw on top of any 2D
    //     screen items the user added.
    const nl = rasterizeNotesLayer({ width, height });
    if (nl) compositeCtx.drawImage(nl, 0, 0, width, height);
    // 2c. Bake hardware insert spec/washer tags. Like the notes, these are
    //     live screen-space DOM <div>s the canvas capture can't see, so they
    //     were missing from the exported video. Drawn above notes (matches the
    //     live z-50), below the header.
    const tg = rasterizeTagsLayer({ width, height });
    if (tg) compositeCtx.drawImage(tg, 0, 0, width, height);
    // 3. Bake the project-level header layer above the overlay so
    //    headers always sit on top — dynamic kinds (stepName /
    //    stepNumber / chapter*) resolve their text against whichever
    //    step is active at this exact tick, automatically.
    const hd = _noHeader ? null : rasterizeHeaderLayer({ width, height });
    if (hd) compositeCtx.drawImage(hd, 0, 0, width, height);
    // 4. Encode.
    const frame = new VideoFrame(composite, { timestamp: nextFrameUs });
    const keyFrame = Math.round(nextFrameUs / frameIntervalUs) % fps === 0;
    try { encoder.encode(frame, { keyFrame }); } catch (e) { frame.close(); throw e; }
    frame.close();
    nextFrameUs += frameIntervalUs;
  };

  let unsubTick = () => {};
  let synthMs = 0;
  let offlineActive = false;

  // Synthetic sleep — advances synthMs frame-by-frame, fires ticks,
  // renders, captures & encodes one frame per slot. Shared by the
  // setSleepImpl (steps animation phases) and _setWaitImpl (inter-step
  // holds) overrides so both produce matching encoded duration.
  // V0.3.2.154 — heap probe. The renderer has a hard ~3.5 GB ceiling and
  // inlined base64 (overlay images, sequences, audio) is its main consumer.
  // Near that ceiling an image decode can stall SILENTLY — no error, no
  // rejection — which is exactly how a step "hangs on load" with an empty
  // console. Logging the level per step turns that from a guess into a
  // number, and shows whether it climbs across the export.
  const _heapMB = () => (performance.memory
    ? Math.round(performance.memory.usedJSHeapSize / 1048576)
    : null);

  const _syntheticSleep = async (ms, opts = {}) => {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    // Holds-only 3D-render skip (V0.3.1.59): an inter-step hold is static in 3D
    // by construction — the transition already finished and (confirmed with the
    // user) nothing animates while a step just sits and narrates. Re-rendering
    // the heavy scene (meshes + SSAA + AO) every frame produces PIXEL-IDENTICAL
    // output, so we render the hold's FIRST frame once (insurance the canvas is
    // current) then reuse it: preserveDrawingBuffer keeps the last frame on the
    // WebGL canvas for the composite drawImage. We STILL fireSyntheticTick +
    // raster the overlay/header/notes and encode one frame per slot every frame,
    // so image-sequence flipbooks + dynamic header text still animate and the
    // encoded duration + audio sync stay exact. Animation phases pass no flag →
    // render every frame as before.
    const staticHold = !!opts.staticHold;
    let renderThisHoldFrame = true;
    // V0.3.2.153 — for callers that must not advance time without capturing
    // it. The loop below only emits a frame when the requested span covers a
    // whole frame interval, so a fixed-ms poll can advance the synthetic
    // clock and encode nothing at some frame rates (a 40ms sleep at 24fps:
    // 41.67 > 40). A polling loop doing that silently fast-forwards every
    // animation into a window where no frame exists. minOneFrame widens the
    // span to one frame so the poll always captures. See the overlay-fade
    // driver in steps.js.
    const wantMs = opts.minOneFrame ? Math.max(ms, frameIntervalMs) : ms;
    const target = synthMs + Math.max(0, wantMs);
    while (synthMs + frameIntervalMs <= target) {
      if (_encoderError) throw _encoderError;   // dead encoder → abort, don't spin
      synthMs += frameIntervalMs;
      sceneCore.fireSyntheticTick(synthMs, frameIntervalMs);
      // 🎬 V0.3.2.82 — deterministic video: seek every live clip to THIS
      // frame's synthetic timestamp and wait for the decoder before the
      // capture below rasterises the overlay. No-op (no await, no cost)
      // when the step has no video.
      if (videoOverlay.hasActiveVideos()) await videoOverlay.seekAllToClock(synthMs);
      if (!staticHold || renderThisHoldFrame) { sceneCore.renderFrame(); _framesRendered++; }
      else                                     { _framesReused++; }
      renderThisHoldFrame = false;
      _captureAndEncode();
      // Backpressure — let the encoder drain so we don't OOM with
      // a multi-thousand-frame queue on long timelines. Watchdog: if the queue
      // refuses to drain for ~30s (dead/stalled encoder), bail instead of
      // hanging the app — the finally will restore the live render loop.
      let _bpWaits = 0;
      while (encoder.encodeQueueSize > 16) {
        if (_encoderError) throw _encoderError;
        if (++_bpWaits > 6000) throw new Error('Export stalled: video encoder stopped draining (queue stuck for 30s). Try a lower fps or resolution.');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      // Yield to the event loop so progress callbacks fire, the UI
      // stays responsive, and any audio-pump microtasks get a turn.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    }
    // Sub-frame remainder — advance synth without emitting an extra frame.
    if (target > synthMs) {
      const rem = target - synthMs;
      synthMs = target;
      sceneCore.fireSyntheticTick(synthMs, rem);
    }
  };

  // Wall-clock anchor for the realtime path. Set inside the realtime
  // branch and read by the step-marker callback below — synthMs covers
  // the offline path, performance.now()-startMs covers realtime.
  let realtimeStartMs = 0;
  if (!offline) {
    // Realtime path — rAF tick hook fires after each natural _render.
    // No need to call renderFrame() here: the current canvas already
    // reflects this rAF's render. Multiple catch-up frames just repeat
    // the same canvas state at fixed timestamps.
    realtimeStartMs = performance.now();
    unsubTick = sceneCore.addTickHook((nowMs) => {
      const elapsedUs = (nowMs - realtimeStartMs) * 1000;
      while (nextFrameUs <= elapsedUs) {
        _captureAndEncode();
      }
    });
  }

  // Step markers — captured at each step's activation point. Used by
  // BOTH the .sbsproc manifest AND the audio mix.
  //
  // We use `nextFrameUs / 1000` (encoded video time) rather than synthMs
  // or wall-clock. The encoded video timestamps are determined by the
  // count of _captureAndEncode calls, which lags synthMs by ~1 frame
  // (the synthetic-sleep loop's last sub-frame remainder fires no
  // capture). In realtime mode, rAF jitter can also make wall-clock
  // diverge from encoder time. Using nextFrameUs is exact: the marker
  // points at the boundary between this step's last encoded frame and
  // the next step's first encoded frame, so the viewer's auto-pause
  // snap-back actually lands on this step's last frame (not the next
  // step's first frame, which was the bug).
  const stepMarkers = [];
  const onStepStart = (i, step) => {
    const t = nextFrameUs / 1000;
    stepMarkers.push({ stepId: step.id, timeInMs: Math.max(0, Math.round(t)) });
  };

  // Suppress live narration playback while the timeline runs for capture.
  state.setState({ _exporting: true });
  // V0.3.0.86 — render the TIGHT export frame (no live overscan margin) during capture.
  sceneCore.setExportFraming(true);
  // Authoring-aid Bbox placeholders are hidden from the encoded frames
  // unless the user opts in via Export tab → "Export boundary boxes".
  // Pair the hide BEFORE _hardResetToFirstStep with the restore in
  // finally so a crash mid-export doesn't leave the scene mutated.
  const exportBboxes = !!(state.get('export') || {}).exportBoundaryBoxes;
  if (!exportBboxes) steps.setPlaceholderBboxesVisible(false);
  try {
    // _hardResetToFirstStep runs in REAL time even in offline mode —
    // its instant apply + rAF settle don't drive any animation phase,
    // and we don't want the warm-up to emit encoded frames (would
    // desync video against the audio master, which starts at t=0 from
    // step 1's narration). Switch to synthetic clock AFTER the reset.
    await _hardResetToFirstStep(stepsToPlay);
    if (offline) {
      // Animation systems (cables-render, materials, overlay, steps)
      // cache start timestamps via clock.now() — swap to synthetic
      // clock so `elapsed = clock.now() - startMs` matches the synth
      // ticks fired below. Stop the rAF loop so real-time ticks don't
      // fight the synthetic clock.
      sceneCore.stopLoop();
      clock.setClockImpl(() => synthMs);
      setSleepImpl(_syntheticSleep);                                   // animation phases → render every frame
      _setWaitImpl((ms) => _syntheticSleep(ms, { staticHold: true })); // inter-step holds → static 3D, reuse the frame
      offlineActive = true;
    }
    console.log('[export] timeline playback…' + (offline ? ' (offline mode)' : ''));
    await _playTimeline(stepsToPlay, perStepHold, onProgress, signal, onStepStart, offline);
    // Persist the MEASURED per-step durations into the project so the Table of
    // Contents computes exact chapter timecodes — inserts/cables and all — from
    // real render times, not the estimate. (V0.3.1.73) End sentinel so the LAST
    // step gets a duration too — else it stays untagged and the auto-sync
    // re-triggers on every export. (V0.3.1.78)
    // Segment/partial/silent renders must NOT poison the measured TOC durations
    // (zeroed lead hold + missing narration give wrong per-step times).
    if (!_stepsRange && !_zeroLeadHold && includeNarration) {
      _recordRenderedDurations([...stepMarkers, { stepId: '__end__', timeInMs: nextFrameUs / 1000 }]);
    }
    const _totFrames = _framesRendered + _framesReused;
    if (offline && _totFrames > 0) {
      const _h = _heapMB();
      if (_h !== null) console.log(`[export] heap after this segment: ${_h} MB${_h > 2600 ? '  ⚠ NEAR THE ~3500 MB CEILING — image decodes can stall silently here' : ''}`);
      console.log(`[export] holds-only render skip — 3D rendered ${_framesRendered}/${_totFrames} frames, reused ${_framesReused} static hold frame(s) (${Math.round(100 * _framesReused / _totFrames)}% of 3D renders skipped).`);
    }
  } finally {
    unsubTick();
    if (offlineActive) {
      // Restore real-time clock + sleep + wait + rAF render loop before returning.
      clock.setClockImpl(null);
      setSleepImpl(null);
      _setWaitImpl(null);
      sceneCore.startLoop();
    }
    state.setState({ _exporting: false });
    sceneCore.setExportFraming(false);   // restore live overscan
    if (!exportBboxes) steps.setPlaceholderBboxesVisible(true);
  }

  console.log('[export] flush video encoder…');
  await encoder.flush();
  encoder.close();

  const totalEncodedMs = Math.max(0, Math.round(nextFrameUs / 1000));

  // Audio mix + encode happens HERE — after video so we can use the
  // ACTUAL step markers (synthMs in offline, performance.now() in
  // realtime). Each step's audio is placed at the marker, eliminating
  // the legacy creep where animation took longer than its estimate.
  if (audioEncoder && audioSegments) {
    console.log(`[export] mix audio (${stepMarkers.length} markers, total=${totalEncodedMs}ms)…`);
    const markersByStepId = new Map(stepMarkers.map(m => [m.stepId, m.timeInMs]));
    const pcm = _mixPcmFromMarkers(audioSegments, markersByStepId, totalEncodedMs, AUDIO_RATE);
    if (pcm) {
      console.log('[export] encode audio…');
      try {
        await _encodeAudioMaster(pcm, AUDIO_RATE, audioEncoder);
      } catch (err) {
        console.warn('[export] audio pump aborted:', err?.message);
      }
    }
    console.log('[export] flush audio encoder…');
    // Hard timeout so a hung encoder can't freeze the renderer indefinitely.
    await Promise.race([
      audioEncoder.flush(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('audio encoder flush timed out')), 30_000)),
    ]).catch(err => { console.warn('[export]', err?.message); });
    try { audioEncoder.close(); } catch {}
  }
  console.log('[export] finalize muxer…');
  muxer.finalize();
  console.log('[export] done.');

  // Proof-of-mode summary. If offline truly engaged, render wall-time will be
  // FAR larger than the output duration on a heavy model (each of the
  // fps×seconds frames was rendered serially). If render ≈ output, it ran
  // realtime and the output is the machine's framerate stretched across the
  // timeline (the stutter the user reported).
  const _renderS  = (performance.now() - _wallStartMs) / 1000;
  const _outS     = totalEncodedMs / 1000;
  const _nFrames  = Math.round(nextFrameUs / frameIntervalUs);
  const _ratio    = _outS > 0 ? (_renderS / _outS) : 0;
  console.log(
    `[export] SUMMARY · mode=${offline ? 'OFFLINE (frame-by-frame)' : 'REALTIME'} · ` +
    `${_nFrames} frames @ ${fps}fps · output ${_outS.toFixed(1)}s · ` +
    `render took ${_renderS.toFixed(1)}s (${_ratio.toFixed(1)}× the video length)`,
  );

  const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
  return {
    blob, extension: 'mp4',
    codec: chosen.muxerCodec + (audioTrackEnabled ? '+' + audioCodec : ''),
    mp4Buffer: muxer.target.buffer,
    totalDurationMs: totalEncodedMs,
    stepMarkers,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  WebM — MediaRecorder on canvas.captureStream (legacy / fallback)
// ═══════════════════════════════════════════════════════════════════════════

async function _exportWebM({ format = 'webm_vp9', fps = DEFAULT_FPS,
                             bitrate = DEFAULT_BITRATE,
                             stepHoldMs = POST_STEP_HOLD_MS,
                             onProgress, signal } = {}) {
  const canvas = sceneCore.renderer?.domElement;
  if (!canvas) throw new Error('No 3D canvas available to export.');

  const stepsToPlay = (state.get('steps') || []).filter(s => steps._isPlayable(s));
  if (!stepsToPlay.length) throw new Error('No steps to export — add at least one step first.');

  const prefer = format === 'webm_vp8'
    ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8']
    : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9'];
  const mime = [...prefer, 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('No supported webm codec.');

  const stream   = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const chunks   = [];
  recorder.addEventListener('dataavailable', e => { if (e.data?.size) chunks.push(e.data); });
  const stopped = new Promise(r => recorder.addEventListener('stop', r, { once: true }));
  recorder.start(250);

  const exportBboxes = !!(state.get('export') || {}).exportBoundaryBoxes;
  if (!exportBboxes) steps.setPlaceholderBboxesVisible(false);
  try {
    await _hardResetToFirstStep(stepsToPlay);
    await _playTimeline(stepsToPlay, stepHoldMs, onProgress, signal);
  } finally {
    try { recorder.stop(); } catch {}
    try { stream.getTracks().forEach(t => t.stop()); } catch {}
    await stopped;
    if (!exportBboxes) steps.setPlaceholderBboxesVisible(true);
  }

  const blob = new Blob(chunks, { type: mime });
  return { blob, extension: 'webm', codec: format === 'webm_vp8' ? 'vp8' : 'vp9' };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Shared — timeline playback loop
// ═══════════════════════════════════════════════════════════════════════════

async function _playTimeline(stepsToPlay, holdsMsArg, onProgress, signal, onStepStart, offline = false) {
  // holdsMsArg can be a single number (legacy) or one entry per step.
  const holds = Array.isArray(holdsMsArg)
    ? holdsMsArg
    : stepsToPlay.map(() => holdsMsArg);

  // Hard reset already landed the scene exactly on the first export step
  // (instant apply, like a double-click). We hold its final state for the
  // configured duration, then transition into step 2 and onwards.
  // V0.2.22.14 — per-step diagnostic gated behind window.sbsDiag.exportTiming.
  const _diagTiming = !!(typeof window !== 'undefined' && window.sbsDiag?.exportTiming);
  for (let i = 0; i < stepsToPlay.length; i++) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const step = stepsToPlay[i];
    onProgress?.({ current: i + 1, total: stepsToPlay.length, stepName: step.name });
    onStepStart?.(i, step);
    const tBefore = _diagTiming ? performance.now() : 0;
    if (i > 0) await steps.activateStep(step.id, true);
    const drainStart = (!offline) ? performance.now() : 0;
    await Promise.all([waitForOverlayStable(), waitForHeaderStable()]);
    // 🎬 V0.3.2.88 — a ZERO-HOLD step is the segment's LEAD: it exists only
    // as the FROM state for the transition into the next step. Its video
    // already finished during ITS OWN segment, so its correct end-state is
    // the TRIM-OUT frame — not trim-in, where a fresh staging parks it.
    // Without this, the crossfade at every segment boundary faded out the
    // WRONG frame (or an unattached clip = the reported threshold cut).
    if ((holds[i] ?? 0) === 0 && videoOverlay.hasActiveVideos()) {
      await videoOverlay.parkAtEnd();
    }
    const drainMs = (!offline) ? (performance.now() - drainStart) : 0;
    const wanted    = holds[i] ?? POST_STEP_HOLD_MS;
    const remaining = Math.max(0, wanted - drainMs);
    if (_diagTiming) {
      const animMsActual = performance.now() - tBefore - drainMs;
      console.log(`[export] step ${i} "${(step.name||'').slice(0,24)}" — animActual=${Math.round(animMsActual)}ms drain=${Math.round(drainMs)}ms wantedHold=${wanted}ms actualWait=${Math.round(remaining)}ms`);
    }
    await _wait(remaining);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Pre-synthesis pass — any step with narration text but no fresh cached
//  clip gets synthesized using the project voice + speed before encoding.
// ═══════════════════════════════════════════════════════════════════════════

async function _synthesizeMissingClips(stepsToPlay, onProgress, signal) {
  const exp     = state.get('export') || {};
  const voiceId = exp.narrationVoice;
  const speed   = Number(exp.narrationSpeed) || 1.0;
  if (!voiceId) {
    console.log('[export] pre-synth skipped — no project voice configured.');
    return;
  }

  const todo = [];
  let withText = 0, alreadyCached = 0;
  for (const s of stepsToPlay) {
    const text = s.narration?.text?.trim();
    if (!text) continue;
    withText++;
    const n = s.narration;
    // Compare TRIMMED-to-TRIMMED (V0.3.2.22). The stamp below stores trimmed
    // text; comparing raw stored text against the trimmed scan value made any
    // step with stray whitespace re-synthesize on EVERY export, forever.
    const matches = n?.text?.trim() === text && n?.voiceId === voiceId && n?.speed === speed;
    let fresh     = matches && !!n?.dataUrl;
    // V0.3.2.120 — a dataFile POINTER is not proof the clip exists (purged
    // cache, moved project, language-pack reattach to a since-deleted file).
    // Probe it now: success hydrates n.dataUrl (the decode loop reads it
    // moments later anyway — no extra IO), failure drops the dead pointer so
    // this step re-synthesizes on THIS export instead of shipping silent.
    if (!fresh && matches && n?.dataFile) {
      fresh = !!(await narrationCache.ensurePlayable(s));
    }
    if (fresh) { alreadyCached++; continue; }
    todo.push(s);
  }
  console.log(`[export] pre-synth scan: ${stepsToPlay.length} step(s), ${withText} with text, ${alreadyCached} cached, ${todo.length} to synthesize`);
  if (!todo.length) return;

  for (let i = 0; i < todo.length; i++) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const s = todo[i];
    onProgress?.({ current: 0, total: 0, stepName: `Synthesizing ${i + 1}/${todo.length}: ${s.name}` });
    console.log(`[export] pre-synth ${i + 1}/${todo.length}: "${s.name}"`);
    try {
      const text = s.narration.text.trim();   // stamp what the freshness check compares
      const out  = await ttsSynthesize(text, voiceId, { speed });
      const dataFile = await narrationCache
        .saveClipToDisk({
          text, voiceId, speed,
          dataUrl:  out.dataUrl,
          stepName: s.name,
          stepId:   s.id,
        })
        .catch(() => null);
      s.narration = { text, voiceId, speed, ...out };
      if (dataFile) s.narration.dataFile = dataFile;
      console.log(`[export]   ✓ ${(out.durationMs / 1000).toFixed(2)}s${dataFile ? ` → ${dataFile}` : ''}`);
    } catch (err) {
      console.warn(`[export]   ✗ synth failed for "${s.name}":`, err?.message);
    }
  }
  state.markDirty();
}

// ═══════════════════════════════════════════════════════════════════════════
//  Audio bridge — narration → mono PCM timeline → AudioEncoder
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Decode every step's narration clip and place its samples at the right
 * offset within the master audio timeline. Returns { pcm, totalMs, hasAudio }.
 */
/**
 * Decode every narration clip into mono Float32 samples at the target
 * sample-rate. Mixing happens later (after _playTimeline) using the
 * actual step markers — see _mixPcmFromMarkers. The decode-side timeout
 * (`_withTimeout` 10s) guards against pathological audio bridge hangs.
 */
async function _decodeNarrationSegments(stepsToPlay, sampleRate) {
  let ctx = null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const lazyCtx = () => ctx ?? (ctx = new Ctx());
  const segments = [];
  let hasAudio = false;
  for (let i = 0; i < stepsToPlay.length; i++) {
    const step = stepsToPlay[i];
    const url = await narrationCache.ensurePlayable(step);
    if (!url) continue;
    try {
      const audioBuf = await _withTimeout(decodeToAudioBuffer(url, lazyCtx), 10_000, 'decodeAudioData');
      const samples = await _withTimeout(resampleToMonoFloat32(audioBuf, sampleRate), 10_000, 'resample');
      const offsetMs = _narrationStartOffsetMs(step);
      console.log(`[export] decode ${i + 1}/${stepsToPlay.length}: "${step.name}" — ${audioBuf.duration.toFixed(2)}s @ ${audioBuf.sampleRate}Hz, offset=${offsetMs}ms`);
      segments.push({ stepId: step.id, samples, offsetMs });
      hasAudio = true;
    } catch (err) {
      console.warn('[export] decode failed for step', step.name, err?.message);
    }
  }
  try { ctx?.close(); } catch {}
  return { segments, hasAudio };
}

/**
 * V0.2.22.11 — compute when a step's narration should START playing,
 * RELATIVE TO the step's activation marker. Matches live-app behavior:
 * the phased animator fires `narration:trigger` when the `narration`
 * phase of the resolved animation string is reached. Offset = sum of
 * durationMs of all phases BEFORE the narration phase.
 *
 * Returns 0 when:
 *   - The step has no animation preset (simultaneous mode — narration
 *     plays at step start)
 *   - The animation string has no `narration` phase (legacy strings)
 *   - The narration phase is the FIRST phase (offset is 0)
 */
function _narrationStartOffsetMs(step) {
  const transition = step.transition || {};
  const presets = state.get('animationPresets') || [];
  const animStr = resolveAnimationString(transition, presets);
  if (!animStr) return 0;
  const resolveAL = (tk) => {
    if (tk === 'AL1') return state.get('cameraAnimDurationMs') ?? 1500;
    if (tk === 'AL2') return state.get('objectAnimDurationMs')  ?? 1500;
    return 0;
  };
  const phases = parseAnimation(animStr, resolveAL);
  if (!phases) return 0;
  let offset = 0;
  for (const phase of phases) {
    if (phase.types.includes('narration')) return offset;
    offset += phase.durationMs;
  }
  // No narration phase in this preset — legacy behavior: play at start.
  return 0;
}

/**
 * Mix decoded segments into a single Float32 PCM aligned to step
 * markers (timeInMs is the actual encoded video time at each step's
 * activation) PLUS each segment's narration phase offset.
 *
 * V0.2.22.11 — added the offsetMs term so audio fires at the same
 * point relative to step start that the live app fires `narration:
 * trigger`. Previously every clip started at marker time (= step
 * activation = animation start), which doesn't match the phased
 * animator's behavior when narration is configured to fire AFTER
 * earlier phases (camera, obj, etc).
 *
 * totalMs = encoded video duration; PCM is sized to exactly that
 * length so audio extends through the final hold but never beyond.
 * Returns null when no audio has been decoded.
 */
function _mixPcmFromMarkers(audioSegments, markersByStepId, totalMs, sampleRate) {
  if (!audioSegments?.hasAudio) return null;
  const tracks = audioSegments.segments.map(s => ({
    startMs: (markersByStepId.get(s.stepId) ?? 0) + (s.offsetMs || 0),
    samples: s.samples,
  }));
  return mixTrackToFloat32(tracks, totalMs, sampleRate);
}

/**
 * Push the master PCM into the AudioEncoder in 1024-frame chunks.
 * Yields to the event loop every YIELD_EVERY chunks so the renderer thread
 * stays responsive during long encodes. Without the yields the loop can
 * pump tens of thousands of synchronous encode() calls before returning,
 * which is enough to make DevTools drop the connection on Windows builds.
 */
async function _encodeAudioMaster(pcm, sampleRate, encoder) {
  const CHUNK       = 1024;
  const YIELD_EVERY = 64;          // every ~1.4s of audio
  const total       = pcm.length;
  let chunkIdx = 0;
  for (let frame = 0; frame < total; frame += CHUNK) {
    const len   = Math.min(CHUNK, total - frame);
    const slice = pcm.subarray(frame, frame + len);
    let audioData;
    try {
      audioData = new AudioData({
        format:           'f32-planar',
        sampleRate,
        numberOfFrames:   len,
        numberOfChannels: 1,
        timestamp:        Math.round((frame / sampleRate) * 1_000_000),
        data:             slice,
      });
      encoder.encode(audioData);
    } catch (e) {
      console.warn('[export] audio encode failed:', e?.message);
      try { audioData?.close(); } catch {}
      throw e;
    }
    audioData.close();

    if (++chunkIdx % YIELD_EVERY === 0) {
      // Let the event loop breathe — UI redraws, DevTools heartbeats, etc.
      await new Promise(r => setTimeout(r, 0));
    }
  }
}

// Inter-step hold delay. Defaults to wall-clock setTimeout, but the
// offline export path swaps in a synthetic-clock implementation so the
// configured Step Hold also produces matching encoded duration.
let _waitImpl = (ms) => new Promise(r => setTimeout(r, ms));
function _wait(ms) { return _waitImpl(ms); }
function _setWaitImpl(fn) {
  _waitImpl = fn || ((ms) => new Promise(r => setTimeout(r, ms)));
}

/**
 * Write each step's MEASURED duration (gap to the next step's real activation
 * time) onto the step as `renderedDurationMs`, then markDirty. The TOC's
 * computeChapterTimecodes prefers these measured values over its estimate, so
 * chapter timecodes become EXACT after an export — including insert/cable
 * animation time the project file can't otherwise express. Steps missing from
 * the marker list (and the final step) keep no measured value → estimate. (V0.3.1.73)
 */
function _recordRenderedDurations(stepMarkers) {
  if (!Array.isArray(stepMarkers) || stepMarkers.length < 2) return;
  const sorted = [...stepMarkers].sort((a, b) => (a.timeInMs || 0) - (b.timeInMs || 0));
  const byId = new Map((state.get('steps') || []).map(s => [s.id, s]));
  let n = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const step = byId.get(sorted[i].stepId);
    if (!step) continue;
    step.renderedDurationMs = Math.max(0, Math.round((sorted[i + 1].timeInMs || 0) - (sorted[i].timeInMs || 0)));
    n++;
  }
  if (n) { state.markDirty(); console.log(`[export] recorded ${n} measured step durations → exact TOC timing.`); }
}

/**
 * Land the scene exactly on the first export step before any frame is
 * captured. This is the equivalent of double-clicking that step in the
 * timeline — `activateStep(id, false)` applies its snapshot instantly,
 * including camera, transforms, materials, and overlay. The result: the
 * very first captured frame is already the first step's final state, no
 * camera bleed from whichever step the user happened to leave active.
 *
 * Subsequent steps animate normally during the export loop. The first
 * step's transition does NOT appear in the recording — by design, since
 * we use it as the starting frame.
 */
async function _hardResetToFirstStep(stepsToPlay) {
  if (!stepsToPlay?.length) return;
  console.log('[export] virtual double-click on first export step:', stepsToPlay[0].name);
  // Clear selection so the gizmo + selection outlines don't leak into the
  // recorded frames. setSelection(null, empty) drops both primary + multi.
  try { state.setSelection(null, new Set()); } catch {}
  try { steps.snapCurrentToFinal(); } catch {}
  // animate=false → instant apply, identical to a step-card double-click.
  await steps.activateStep(stepsToPlay[0].id, false);
  // Two rAF + a small buffer so render + tick hooks settle before capture.
  //
  // V0.3.2.155 — each rAF is RACED against a timeout. A bare
  // `await new Promise(r => requestAnimationFrame(r))` is an unbounded wait:
  // the browser only services frame callbacks when the page paints, and an
  // export stops the render loop and can go long stretches without painting.
  // The race keeps the settle behaviour when frames are flowing and degrades
  // to a short delay when they are not, instead of hanging the export before
  // it has encoded anything.
  const _frameOrTimeout = () => Promise.race([
    new Promise(r => requestAnimationFrame(r)),
    new Promise(r => setTimeout(r, 100)),
  ]);
  await _frameOrTimeout();
  await _frameOrTimeout();
  await _wait(50);
}

function _withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// V0.3.2.5 — the render-cache assembly reuses the export's audio machinery:
// per-step decode (ensurePlayable → mono Float32 @ rate, with the narration
// phase offset) and marker-based mixing into one master track.
export { _decodeNarrationSegments as decodeNarrationSegments,
         _mixPcmFromMarkers      as mixPcmFromMarkers };

// V0.3.2.14 — the incremental (.sbsproc) assembly reuses the manifest builder
// and the binary packer (it supplies its own stepMarkers + totalDurationMs).
export { _buildSbsProcManifest as buildSbsProcManifest,
         _packSbsProcBlob     as packSbsProcBlob };
