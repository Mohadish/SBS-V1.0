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
import { computeSafeFrameRect }                       from '../core/safe-frame.js';
import { decodeToAudioBuffer, resampleToMonoFloat32, mixTrackToFloat32 } from './audio-bridge.js';
import { synthesize as ttsSynthesize } from './tts.js';
import * as narrationCache from './narration-cache.js';

// Vendored ES module (see sbs-app/vendor/mp4-muxer.mjs).
import { Muxer as Mp4Muxer, ArrayBufferTarget } from '../../vendor/mp4-muxer.mjs';

const DEFAULT_FPS       = 30;
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

  const stepsToPlay = (state.get('steps') || []).filter(s => !s.hidden && !s.isBaseStep);
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

  // Stage 4: temporarily render the 3D scene AT CANONICAL RESOLUTION so
  // the export captures sharp pixels instead of upscaling the viewport
  // canvas (which is whatever-size the user's window happens to be).
  //
  // We must also FORCE pixelRatio = 1 for the duration of the export.
  // Three.js setSize multiplies the requested size by the renderer's
  // pixel ratio when sizing the canvas backing buffer:
  //   canvas.width  = floor(width  * pixelRatio)
  //   canvas.height = floor(height * pixelRatio)
  // On Electron/Chromium this PR follows window.devicePixelRatio, which
  // is fractional under OS display-scaling AND under any browser zoom
  // (Ctrl+/-). A user running e.g. PR=0.76 ends up with a 1460×821
  // backing buffer instead of 1920×1080 — the 3D layer is then upscaled
  // to canonical via drawImage (blurry), AND any non-canonical aspect
  // drift from floor() shows up as a sub-pixel crop in computeSafeFrame
  // (sf.x=0.2, sf.width=1459.6) which can soft-stretch the 3D layer.
  // Forcing PR=1 makes canvas.width/height EXACTLY width/height and
  // pins drawImage to pixel-perfect 1:1 source→dest. The live viewport
  // visibly resizes during export — that's acceptable while exporting
  // (user isn't editing). Restored via sceneCore.resize() in finally so
  // the viewer auto-fits its container regardless of saved PR.
  const savedRendererSize = { w: canvas.width, h: canvas.height };
  const savedCameraAspect = sceneCore.camera.aspect;
  const savedPixelRatio   = sceneCore.renderer.getPixelRatio();
  const savedCanvasCssW   = canvas.style.width;
  const savedCanvasCssH   = canvas.style.height;
  sceneCore.renderer.setPixelRatio(1);
  sceneCore.renderer.setSize(width, height, false);   // false = don't touch CSS size
  sceneCore.camera.aspect = width / height;
  sceneCore.camera.updateProjectionMatrix();

  // Live-preview cosmetic: with updateStyle=false above, the canvas CSS
  // box stays at the viewer container's aspect while its internal buffer
  // is now canonical aspect. The browser then stretches non-uniformly
  // and the user sees the 3D layer squashed during export. (Output is
  // unaffected — drawImage reads from the buffer.) Letterbox the canvas
  // CSS into its parent at the canonical aspect so the live preview
  // matches what's being encoded.
  try {
    const parent = canvas.parentElement;
    if (parent) {
      const pw = parent.clientWidth;
      const ph = parent.clientHeight;
      const ca = width / height;
      const pa = pw / ph;
      let cssW, cssH;
      if (pa >= ca) { cssH = ph; cssW = ph * ca; }
      else          { cssW = pw; cssH = pw / ca; }
      canvas.style.width  = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
  } catch {}

  // ── Build the step timeline.
  // Per-step hold is always added AFTER the step's narration (or after the
  // animation if there's no narration). That way "Step hold (ms)" in the
  // Export tab is a true global breath between steps, not a minimum that
  // long narration silently overrides.
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

  if (includeNarration) {
    try {
      // Pre-synth: any step with narration text but no fresh cached clip
      // gets synthesized now so audio bridge finds them all. Runs for every
      // export entry point (timeline button, Export tab Start, etc.).
      await _synthesizeMissingClips(stepsToPlay, onProgress, signal);

      // Recompute per-step holds AFTER pre-synth so the timeline accounts
      // for newly-synthesized clip durations. Same formula as initial setup
      // (narration + global hold).
      for (let i = 0; i < stepsToPlay.length; i++) {
        const narrMs = stepsToPlay[i].narration?.durationMs || 0;
        perStepHold[i] = narrMs + stepHoldMs;
      }

      console.log('[export] building audio track…');
      audioMaster = await _buildNarrationTrack(stepsToPlay, perStepHold, AUDIO_RATE);
      audioTrackEnabled = audioMaster.hasAudio;
      console.log(`[export] audio track ready: ${audioTrackEnabled ? `${(audioMaster.totalMs/1000).toFixed(1)}s` : 'no clips'}`);
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

  // Audio encoder + chunked encode — runs CONCURRENTLY with the video frame
  // pump. We capture the promise so we can await its completion before
  // calling encoder.flush() at the end.
  let audioEncodePromise = Promise.resolve();
  if (audioTrackEnabled) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error:  (e) => { console.error('[export] audio encoder', e); },
    });
    audioEncoder.configure({
      codec: audioCodec, sampleRate: AUDIO_RATE, numberOfChannels: AUDIO_CHANNELS, bitrate: AUDIO_BITRATE,
    });
    audioEncodePromise = _encodeAudioMaster(audioMaster.pcm, AUDIO_RATE, audioEncoder)
      .catch(err => { console.warn('[export] audio pump aborted:', err?.message); });
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

  if (!offline) {
    // Realtime path — rAF tick hook fires after each natural _render.
    // No need to call renderFrame() here: the current canvas already
    // reflects this rAF's render. Multiple catch-up frames just repeat
    // the same canvas state at fixed timestamps.
    const startMs = performance.now();
    unsubTick = sceneCore.addTickHook((nowMs) => {
      const elapsedUs = (nowMs - startMs) * 1000;
      while (nextFrameUs <= elapsedUs) {
        _captureAndEncode();
      }
    });
  }

  // Suppress live narration playback while the timeline runs for capture.
  state.setState({ _exporting: true });
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
    await _playTimeline(stepsToPlay, perStepHold, onProgress, signal);
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
    // Stage 4 cleanup: restore PR + camera + canvas CSS, then let
    // sceneCore.resize() re-fit the viewer to its container. Using
    // sceneCore.resize() instead of replaying savedRendererSize avoids
    // a double-PR-multiply bug: savedRendererSize.{w,h} were already
    // PR-scaled when captured, so passing them back through setSize
    // would shrink the canvas.
    try {
      canvas.style.width  = savedCanvasCssW;
      canvas.style.height = savedCanvasCssH;
      sceneCore.renderer.setPixelRatio(savedPixelRatio);
      sceneCore.camera.aspect = savedCameraAspect;
      sceneCore.camera.updateProjectionMatrix();
      sceneCore.resize();
    } catch {}
    // Suppress the unused-var lint on savedRendererSize — kept around
    // for diagnostics if a future export bug needs the pre-export size.
    void savedRendererSize;
  }

  console.log('[export] flush video encoder…');
  await encoder.flush();
  encoder.close();
  if (audioEncoder) {
    console.log('[export] await audio pump…');
    await audioEncodePromise;
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

  const stepsToPlay = (state.get('steps') || []).filter(s => !s.hidden && !s.isBaseStep);
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

  try {
    await _hardResetToFirstStep(stepsToPlay);
    await _playTimeline(stepsToPlay, stepHoldMs, onProgress, signal);
  } finally {
    try { recorder.stop(); } catch {}
    try { stream.getTracks().forEach(t => t.stop()); } catch {}
    await stopped;
  }

  const blob = new Blob(chunks, { type: mime });
  return { blob, extension: 'webm', codec: format === 'webm_vp8' ? 'vp8' : 'vp9' };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Shared — timeline playback loop
// ═══════════════════════════════════════════════════════════════════════════

async function _playTimeline(stepsToPlay, holdsMsArg, onProgress, signal) {
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
    if (i > 0) await steps.activateStep(step.id, true);   // first step already there
    // Drain any pending overlay / header async raster before holding —
    // without this, the first frames of the hold can capture a partial
    // overlay (textbox raster is still pending) or stale header (dynamic-
    // kind hydrate hasn't completed). The wait-for-stable promises
    // resolve as soon as every async raster of the latest refresh
    // settles, so on a fully-cached layer they resolve immediately.
    await Promise.all([waitForOverlayStable(), waitForHeaderStable()]);
    await _wait(holds[i] ?? POST_STEP_HOLD_MS);
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
async function _buildNarrationTrack(stepsToPlay, perStepHold, sampleRate) {
  // Compute step start time (cumulative animation + hold).
  // The first export step is pre-activated by _hardResetToFirstStep, so its
  // animation does NOT play in the video — treat its anim duration as 0
  // when computing audio offsets, otherwise step-2's narration would
  // start at (anim1 + hold1) instead of just hold1.
  const segments = [];
  let cursor = 0;
  for (let i = 0; i < stepsToPlay.length; i++) {
    const step  = stepsToPlay[i];
    const anim  = i === 0 ? 0 : (step.transition?.durationMs ?? 1500);
    segments.push({ step, startMs: cursor });
    cursor += anim + perStepHold[i];
  }
  const totalMs = cursor;

  // Decode each clip. WAV (the SAPI output format) is parsed manually
  // in audio-bridge.js — no AudioContext touched. We only construct a
  // fallback context lazily IF a non-WAV codec shows up. Avoiding the
  // AudioContext entirely for the SAPI path side-steps a renderer hang
  // we hit on Windows during decodeAudioData of step 1.
  let ctx = null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const lazyCtx = () => ctx ?? (ctx = new Ctx());
  const decoded = [];
  let hasAudio = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // Resolve the playable url — inline dataUrl OR lazy-loaded from disk
    // cache. Returns null if neither is available (no clip for this step).
    const url = await narrationCache.ensurePlayable(seg.step);
    if (!url) continue;
    try {
      console.log(`[export] decode step ${i + 1}/${segments.length}: ${seg.step.name}`);
      const audioBuf = await _withTimeout(decodeToAudioBuffer(url, lazyCtx), 10_000, 'decodeAudioData');
      console.log(`[export]   decoded — ${audioBuf.numberOfChannels}ch @ ${audioBuf.sampleRate}Hz, ${(audioBuf.duration).toFixed(2)}s`);
      const samples  = await _withTimeout(resampleToMonoFloat32(audioBuf, sampleRate), 10_000, 'resample');
      console.log(`[export]   resampled — ${samples.length} frames`);
      decoded.push({ startMs: seg.startMs, samples });
      hasAudio = true;
    } catch (err) {
      console.warn('[export] decode failed for step', seg.step.name, err?.message);
    }
  }
  try { ctx.close(); } catch {}

  if (!hasAudio) return { pcm: null, totalMs, hasAudio: false };
  const pcm = mixTrackToFloat32(decoded, totalMs, sampleRate);
  return { pcm, totalMs, hasAudio: true };
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
