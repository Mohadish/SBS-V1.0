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
import { steps }     from './steps.js';
import { sceneCore } from '../core/scene.js';
import { rasterizeOverlay } from './overlay.js';
import { decodeToAudioBuffer, resampleToMonoFloat32, mixTrackToFloat32 } from './audio-bridge.js';
import { synthesize as ttsSynthesize } from './tts.js';

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
                            onProgress, signal } = {}) {
  const canvas = sceneCore.renderer?.domElement;
  if (!canvas) throw new Error('No 3D canvas available to export.');

  const stepsToPlay = (state.get('steps') || []).filter(s => !s.hidden && !s.isBaseStep);
  if (!stepsToPlay.length) throw new Error('No steps to export — add at least one step first.');

  const width  = canvas.width;
  const height = canvas.height;

  // ── Build the step timeline. Each step's hold is extended so narration
  // (if any) finishes before the next step starts. perStepHold[i] is what
  // we await between activateStep calls during the live playback loop.
  const perStepHold = stepsToPlay.map(step => {
    const animMs = step.transition?.durationMs ?? 1500;
    const narrMs = includeNarration ? (step.narration?.durationMs || 0) : 0;
    return Math.max(stepHoldMs, narrMs - animMs);
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
      // for newly-synthesized clip durations.
      for (let i = 0; i < stepsToPlay.length; i++) {
        const animMs = stepsToPlay[i].transition?.durationMs ?? 1500;
        const narrMs = stepsToPlay[i].narration?.durationMs || 0;
        perStepHold[i] = Math.max(stepHoldMs, narrMs - animMs);
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

  // Frame pump — captures the canvas on every render tick and encodes as many
  // fixed-interval frame slots as have elapsed in wall-clock time. Timestamps
  // are regular so playback is smooth even if rAF hiccups.
  //
  // Composite: we draw the 3D canvas and the Konva overlay into an offscreen
  // 2D canvas, then build the VideoFrame from that. This bakes the overlay
  // (text boxes, images) into the encoded output.
  const composite    = new OffscreenCanvas(width, height);
  const compositeCtx = composite.getContext('2d');

  const frameIntervalUs = 1_000_000 / fps;
  let nextFrameUs = 0;
  const startMs = performance.now();

  const unsubTick = sceneCore.addTickHook((nowMs) => {
    const elapsedUs = (nowMs - startMs) * 1000;
    while (nextFrameUs <= elapsedUs) {
      // 1. Lay down the 3D frame at native size.
      compositeCtx.clearRect(0, 0, width, height);
      compositeCtx.drawImage(canvas, 0, 0, width, height);
      // 2. Bake the overlay on top (null if no overlay nodes exist).
      const ov = rasterizeOverlay({ width, height });
      if (ov) compositeCtx.drawImage(ov, 0, 0, width, height);
      // 3. Encode.
      const frame = new VideoFrame(composite, { timestamp: nextFrameUs });
      const keyFrame = Math.round(nextFrameUs / frameIntervalUs) % fps === 0;
      try { encoder.encode(frame, { keyFrame }); } catch (e) { frame.close(); throw e; }
      frame.close();
      nextFrameUs += frameIntervalUs;
    }
  });

  // Suppress live narration playback while the timeline runs for capture.
  state.setState({ _exporting: true });
  try {
    console.log('[export] timeline playback…');
    await _playTimeline(stepsToPlay, perStepHold, onProgress, signal);
  } finally {
    unsubTick();
    state.setState({ _exporting: false });
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

  steps.activateBaseStep();
  await _wait(150);

  for (let i = 0; i < stepsToPlay.length; i++) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const step = stepsToPlay[i];
    onProgress?.({ current: i + 1, total: stepsToPlay.length, stepName: step.name });
    await steps.activateStep(step.id, true);
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
    const fresh = n?.dataUrl && n.text === text && n.voiceId === voiceId && n.speed === speed;
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
      const out = await ttsSynthesize(s.narration.text, voiceId, { speed });
      s.narration = { text: s.narration.text, voiceId, speed, ...out };
      console.log(`[export]   ✓ ${(out.durationMs / 1000).toFixed(2)}s`);
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
  const segments = [];
  let cursor = 0;
  for (let i = 0; i < stepsToPlay.length; i++) {
    const step  = stepsToPlay[i];
    const anim  = step.transition?.durationMs ?? 1500;
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
    const url = seg.step.narration?.dataUrl;
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

function _wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function _withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}
