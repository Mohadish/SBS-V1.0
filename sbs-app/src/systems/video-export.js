/**
 * SBS — Video export (Phase 1a)
 * =============================
 * In-browser timeline → .webm export via MediaRecorder + canvas.captureStream.
 * Zero external dependencies. Royalty-free codecs (VP9 + Opus) only.
 *
 * Pipeline
 *   1. captureStream(fps) on the Three.js renderer's canvas
 *   2. MediaRecorder encodes that stream → webm/VP9 chunks
 *   3. While recording, activate each visible step in order and wait for its
 *      transition to complete. Optional hold time after each step gives the
 *      viewer reading time.
 *   4. Stop the recorder → Blob → download.
 *
 * Phase 1b (later, when we need frame-accurate timing or MP4):
 *   Replace the MediaRecorder with WebCodecs VideoEncoder + mp4-muxer /
 *   webm-muxer. The frame source (renderer canvas) stays the same, and
 *   the _playTimeline loop is unchanged — only the encoder layer swaps.
 */

import { state }     from '../core/state.js';
import { steps }     from './steps.js';
import { sceneCore } from '../core/scene.js';

const DEFAULT_FPS       = 30;
const DEFAULT_BITRATE   = 4_000_000;   // 4 Mbps — good for 1080p screencasts
const POST_STEP_HOLD_MS = 400;         // pause after each step's transition finishes

/**
 * Export the current timeline as a webm video blob.
 *
 * @param {object}   opts
 * @param {number}  [opts.fps=30]
 * @param {number}  [opts.bitrate=4000000]
 * @param {(progress:{current:number,total:number,stepName:string})=>void}
 *                  [opts.onProgress]
 * @param {AbortSignal} [opts.signal]  call .abort() to cancel early
 * @returns {Promise<Blob>}
 */
export async function exportTimelineVideo({
  fps      = DEFAULT_FPS,
  bitrate  = DEFAULT_BITRATE,
  onProgress,
  signal,
} = {}) {
  const canvas = sceneCore.renderer?.domElement;
  if (!canvas) throw new Error('No 3D canvas available to export.');

  const stepsToPlay = (state.get('steps') || [])
    .filter(s => !s.hidden && !s.isBaseStep);
  if (!stepsToPlay.length) throw new Error('No steps to export — add at least one step first.');

  const mime = _pickMime();

  // Start capture stream. Must be created BEFORE MediaRecorder so the stream
  // has at least one video track. captureStream locks to the canvas's current
  // size; resizing the viewport mid-export would distort the output.
  const stream = canvas.captureStream(fps);

  const recorder = new MediaRecorder(stream, {
    mimeType:            mime,
    videoBitsPerSecond:  bitrate,
  });
  const chunks = [];
  recorder.addEventListener('dataavailable', e => { if (e.data?.size) chunks.push(e.data); });

  const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }));

  recorder.start(250);   // flush a chunk every 250ms — keeps memory bounded

  try {
    // Establish a clean ground-truth before the timeline starts recording.
    steps.activateBaseStep();
    await _wait(150);

    for (let i = 0; i < stepsToPlay.length; i++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const step = stepsToPlay[i];
      onProgress?.({ current: i + 1, total: stepsToPlay.length, stepName: step.name });

      // activateStep awaits the transition animation to completion.
      await steps.activateStep(step.id, true);

      // Hold the final frame so viewers can read / absorb.
      await _wait(POST_STEP_HOLD_MS);
    }
  } finally {
    // Ensure recorder always stops, even on error/abort, so tracks are released.
    try { recorder.stop(); } catch {}
    try { stream.getTracks().forEach(t => t.stop()); } catch {}
    await stopped;
  }

  return new Blob(chunks, { type: mime });
}

/**
 * Trigger a browser download of the given Blob. Uses a transient object URL
 * so the blob is eligible for GC once the download kicks off.
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Internal ────────────────────────────────────────────────────────────────

function _pickMime() {
  // VP9 / VP8 are both royalty-free. Prefer VP9 for better compression.
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  throw new Error('No supported webm codec in this browser.');
}

function _wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}
