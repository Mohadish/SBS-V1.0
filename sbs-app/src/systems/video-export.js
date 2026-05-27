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
import * as clock    from '../core/clock.js';
import { sceneCore } from '../core/scene.js';
import { rasterizeOverlay, waitForOverlayStable }     from './overlay.js';
import { rasterizeHeaderLayer, waitForHeaderStable }  from './header.js';
import { rasterizeNotesLayer }                        from './notes-render.js';
import { computeSafeFrameRect }                       from '../core/safe-frame.js';
import { decodeToAudioBuffer, resampleToMonoFloat32, mixTrackToFloat32 } from './audio-bridge.js';
import { synthesize as ttsSynthesize } from './tts.js';
import * as narrationCache from './narration-cache.js';

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
  const format = opts.format ?? 'mp4';

  if (format === 'mp4')      return _exportMp4(opts);
  if (format.startsWith('webm')) return _exportWebM(opts);
  throw new Error(`Unsupported export format: ${format}`);
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
  const result = await _exportMp4(opts);
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

// ═══════════════════════════════════════════════════════════════════════════
//  MP4 — WebCodecs VideoEncoder + mp4-muxer
// ═══════════════════════════════════════════════════════════════════════════

async function _exportMp4({ fps = DEFAULT_FPS, bitrate = DEFAULT_BITRATE,
                            stepHoldMs = POST_STEP_HOLD_MS,
                            includeNarration = true,
                            offline = false,
                            onProgress, signal } = {}) {
  const canvas = sceneCore.renderer?.domElement;
  if (!canvas) throw new Error('No 3D canvas available to export.');

  const stepsToPlay = (state.get('steps') || []).filter(s => steps._isPlayable(s));
  if (!stepsToPlay.length) throw new Error('No steps to export — add at least one step first.');

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
    return narrMs + stepHoldMs;
  });

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

      // V0.2.22.7 — surgical pause computation (user's correct proposal).
      //
      // For each step, compute its ANIMATION duration and its NARRATION
      // duration. The only thing we must avoid is voice-vs-voice collisions
      // (overlapping clips compete for the listener's attention even when
      // the mixer sums them cleanly). So the rule is:
      //
      //   • If next step has audio (or this IS the last step):
      //       perStepHold[i] = max(0, narration - animation) + stepHoldMs
      //       Add a pause ONLY if narration exceeds animation. Pause is
      //       exactly the audio excess — no more, no over-padding.
      //
      //   • If next step has NO audio:
      //       perStepHold[i] = stepHoldMs
      //       Animation moves on. Trailing audio overflows naturally into
      //       the next step's frames (no collision risk because next has
      //       no narration of its own). Audio is mixed at this step's
      //       start marker and plays out from there.
      //
      // Animation duration per step matches the actual phase math from
      // applySnapshotAnimated's simultaneous branch:
      //   transition.durationOverride ? transition.objectDurationMs
      //                               : state.objectAnimDurationMs
      //   (fallback: 1500ms)
      //
      // This treats sub-steps and top-level steps uniformly — what matters
      // is whether the NEXT step has audio, not the group boundary. Cross-
      // group overflow can still happen if the next top-level has no
      // narration; if the user doesn't want that, they author narration
      // on the next top-level (which gates the previous step's audio).
      //
      // Known limitation: estimated animation duration may drift from
      // run-time actual (e.g. under realtime browser throttling). If
      // actual > estimated and next step has audio, this step's audio
      // could still be playing when the next starts → collision.
      // Reasonable in practice; refine to run-time measurement if drift
      // becomes a problem.
      const globalObjDur = state.get('objectAnimDurationMs') ?? 1500;
      const _estimateAnimDur = (s) => {
        const t = s.transition || {};
        return t.durationOverride === true
          ? (t.objectDurationMs ?? globalObjDur)
          : globalObjDur;
      };
      for (let i = 0; i < stepsToPlay.length; i++) {
        const step     = stepsToPlay[i];
        const narrMs   = step.narration?.durationMs || 0;
        const animDur  = _estimateAnimDur(step);
        const nextStep = stepsToPlay[i + 1];
        const isLast   = !nextStep;
        const nextHasAudio = isLast || ((nextStep.narration?.durationMs || 0) > 0);
        const audioExcess  = nextHasAudio ? Math.max(0, narrMs - animDur) : 0;
        perStepHold[i] = audioExcess + stepHoldMs;
      }

      console.log('[export] decoding audio segments…');
      audioSegments = await _decodeNarrationSegments(stepsToPlay, AUDIO_RATE);
      audioTrackEnabled = audioSegments.hasAudio;
      console.log(`[export] audio decoded: ${audioTrackEnabled ? `${audioSegments.segments.length} clip(s)` : 'no clips'}`);
    } catch (err) {
      console.warn('[export] audio bridge failed — exporting video only:', err);
      audioTrackEnabled = false;
    }
  }

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

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error:  (e) => { throw e; },
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
    // 3. Bake the project-level header layer above the overlay so
    //    headers always sit on top — dynamic kinds (stepName /
    //    stepNumber / chapter*) resolve their text against whichever
    //    step is active at this exact tick, automatically.
    const hd = rasterizeHeaderLayer({ width, height });
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
  const _syntheticSleep = async (ms) => {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const target = synthMs + Math.max(0, ms);
    while (synthMs + frameIntervalMs <= target) {
      synthMs += frameIntervalMs;
      sceneCore.fireSyntheticTick(synthMs, frameIntervalMs);
      sceneCore.renderFrame();
      _captureAndEncode();
      // Backpressure — let the encoder drain so we don't OOM with
      // a multi-thousand-frame queue on long timelines.
      while (encoder.encodeQueueSize > 16) {
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
      setSleepImpl(_syntheticSleep);
      _setWaitImpl(_syntheticSleep);
      offlineActive = true;
    }
    console.log('[export] timeline playback…' + (offline ? ' (offline mode)' : ''));
    await _playTimeline(stepsToPlay, perStepHold, onProgress, signal, onStepStart, offline);
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
  for (let i = 0; i < stepsToPlay.length; i++) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const step = stepsToPlay[i];
    onProgress?.({ current: i + 1, total: stepsToPlay.length, stepName: step.name });
    // .sbsproc step-marker hook — fires BEFORE the transition begins so
    // the marker timestamp matches the moment the encoded video starts
    // moving toward this step's final state. The viewer uses these to
    // seek between steps. (Optional callback; no-op for plain exports.)
    onStepStart?.(i, step);
    if (i > 0) await steps.activateStep(step.id, true);   // first step already there
    // Drain any pending overlay / header async raster before holding —
    // without this, the first frames of the hold can capture a partial
    // overlay (textbox raster is still pending) or stale header (dynamic-
    // kind hydrate hasn't completed). The wait-for-stable promises
    // resolve as soon as every async raster of the latest refresh
    // settles, so on a fully-cached layer they resolve immediately.
    //
    // V0.2.22.2: in REALTIME mode the drain wait was bleeding into the
    // encoded video because rAF kept firing the tick-hook capture during
    // it — a "100ms" hold could become 500ms in the encoded output when
    // a fresh raster took 400ms. Measure the drain (real-time only) and
    // shave it off the requested hold so the user-set value matches the
    // visible gap.  Offline mode advances the synthetic clock only inside
    // _syntheticSleep; the drain runs in wall-clock without producing
    // frames, so drainMs there is irrelevant — `subtract = 0` keeps the
    // requested hold honest in both paths.
    const drainStart = (!offline) ? performance.now() : 0;
    await Promise.all([waitForOverlayStable(), waitForHeaderStable()]);
    const drainMs = (!offline) ? (performance.now() - drainStart) : 0;
    const wanted    = holds[i] ?? POST_STEP_HOLD_MS;
    const remaining = Math.max(0, wanted - drainMs);
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
    const matches = n?.text === text && n?.voiceId === voiceId && n?.speed === speed;
    const fresh   = matches && (n?.dataUrl || n?.dataFile);
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
      const text = s.narration.text;
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
      console.log(`[export] decode step ${i + 1}/${stepsToPlay.length}: ${step.name}`);
      const audioBuf = await _withTimeout(decodeToAudioBuffer(url, lazyCtx), 10_000, 'decodeAudioData');
      console.log(`[export]   decoded — ${audioBuf.numberOfChannels}ch @ ${audioBuf.sampleRate}Hz, ${audioBuf.duration.toFixed(2)}s`);
      const samples = await _withTimeout(resampleToMonoFloat32(audioBuf, sampleRate), 10_000, 'resample');
      console.log(`[export]   resampled — ${samples.length} frames`);
      segments.push({ stepId: step.id, samples });
      hasAudio = true;
    } catch (err) {
      console.warn('[export] decode failed for step', step.name, err?.message);
    }
  }
  try { ctx?.close(); } catch {}
  return { segments, hasAudio };
}

/**
 * Mix decoded segments into a single Float32 PCM aligned to step
 * markers (timeInMs is the actual encoded video time at each step's
 * activation). totalMs = encoded video duration; PCM is sized to
 * exactly that length so audio extends through the final hold but
 * never beyond. Returns null when no audio has been decoded.
 */
function _mixPcmFromMarkers(audioSegments, markersByStepId, totalMs, sampleRate) {
  if (!audioSegments?.hasAudio) return null;
  const tracks = audioSegments.segments.map(s => ({
    startMs: markersByStepId.get(s.stepId) ?? 0,
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
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => requestAnimationFrame(r));
  await _wait(50);
}

function _withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}
