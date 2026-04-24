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
                            onProgress, signal } = {}) {
  const canvas = sceneCore.renderer?.domElement;
  if (!canvas) throw new Error('No 3D canvas available to export.');

  const stepsToPlay = (state.get('steps') || []).filter(s => !s.hidden && !s.isBaseStep);
  if (!stepsToPlay.length) throw new Error('No steps to export — add at least one step first.');

  const width  = canvas.width;
  const height = canvas.height;

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

  const muxer = new Mp4Muxer({
    target: new ArrayBufferTarget(),
    fastStart: 'in-memory',        // moov at front → scrubbable
    video: {
      codec: chosen.muxerCodec,
      width,
      height,
      frameRate: fps,
    },
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error:  (e) => { throw e; },
  });
  encoder.configure({ codec: chosen.webCodec, width, height, bitrate, framerate: fps });

  // Frame pump — captures the canvas on every render tick and encodes as many
  // fixed-interval frame slots as have elapsed in wall-clock time. Timestamps
  // are regular so playback is smooth even if rAF hiccups.
  const frameIntervalUs = 1_000_000 / fps;
  let nextFrameUs = 0;
  const startMs = performance.now();

  const unsubTick = sceneCore.addTickHook((nowMs) => {
    const elapsedUs = (nowMs - startMs) * 1000;
    while (nextFrameUs <= elapsedUs) {
      const frame = new VideoFrame(canvas, { timestamp: nextFrameUs });
      const keyFrame = Math.round(nextFrameUs / frameIntervalUs) % fps === 0;
      try { encoder.encode(frame, { keyFrame }); } catch (e) { frame.close(); throw e; }
      frame.close();
      nextFrameUs += frameIntervalUs;
    }
  });

  try {
    await _playTimeline(stepsToPlay, stepHoldMs, onProgress, signal);
  } finally {
    unsubTick();
  }

  await encoder.flush();
  encoder.close();
  muxer.finalize();

  const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
  return { blob, extension: 'mp4', codec: chosen.muxerCodec };
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

async function _playTimeline(stepsToPlay, stepHoldMs, onProgress, signal) {
  steps.activateBaseStep();
  await _wait(150);

  for (let i = 0; i < stepsToPlay.length; i++) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const step = stepsToPlay[i];
    onProgress?.({ current: i + 1, total: stepsToPlay.length, stepName: step.name });
    await steps.activateStep(step.id, true);
    await _wait(stepHoldMs);
  }
}

function _wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}
