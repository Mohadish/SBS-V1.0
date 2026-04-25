/**
 * SBS — Audio bridge
 * ===================
 * Backend-agnostic audio utilities. Every TTS / mic / future backend stores
 * audio as a data URL in `step.narration.dataUrl`. This module turns those
 * data URLs into the format the video exporter needs (mono Float32 PCM at
 * a unified sample rate) and provides helpers for the reverse direction
 * (raw PCM → WAV data URL) so backends like Kokoro can produce the same
 * shape.
 *
 *   data URL  ───decodeToAudioBuffer──▶  AudioBuffer  ───resampleToMono───▶  Float32Array
 *      ▲
 *      └────────── pcmToWavDataUrl ─────── Float32Array (raw backend output)
 *
 * Use OfflineAudioContext for resampling so we get the browser's high-quality
 * sample-rate conversion for free.
 */

// ─── Decode any browser-readable audio (WAV/MP3/Opus/etc.) → AudioBuffer ───

/**
 * @param {string}        dataUrl    'data:audio/...;base64,...' or blob URL
 * @param {AudioContext}  audioCtx   any AudioContext (online or offline)
 * @returns {Promise<AudioBuffer>}
 */
export async function decodeToAudioBuffer(dataUrl, audioCtx) {
  const response    = await fetch(dataUrl);
  const arrayBuffer = await response.arrayBuffer();
  return audioCtx.decodeAudioData(arrayBuffer);
}

// ─── Resample any AudioBuffer to mono Float32 at a target rate ─────────────

/**
 * Returns a Float32Array of mono samples at the target rate. Multichannel
 * inputs are averaged. If the source is already mono at the target rate,
 * returns its channel-0 data directly (zero-copy when possible).
 *
 * @param {AudioBuffer} buffer
 * @param {number}      targetRate   e.g. 48000
 * @returns {Promise<Float32Array>}
 */
export async function resampleToMonoFloat32(buffer, targetRate) {
  // Fast path — already mono at target rate.
  if (buffer.sampleRate === targetRate && buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0).slice();
  }
  // Use OfflineAudioContext for high-quality SRC. It handles both rate
  // conversion and channel mixdown in one render pass.
  const dur     = buffer.length / buffer.sampleRate;
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(dur * targetRate)), targetRate);
  const src     = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

// ─── Float32 PCM → WAV data URL ─────────────────────────────────────────────

/**
 * Wrap mono Float32 PCM samples in a 16-bit WAV file and return a base64
 * data URL. Used by backends that produce raw PCM (e.g. Kokoro) so they
 * conform to the unified `step.narration.dataUrl` contract without the
 * caller needing to know the format.
 *
 * @param {Float32Array} pcm        mono samples in [-1, 1]
 * @param {number}       sampleRate
 * @returns {string} 'data:audio/wav;base64,...'
 */
export function pcmToWavDataUrl(pcm, sampleRate) {
  const numSamples = pcm.length;
  const byteLength = 44 + numSamples * 2;
  const buf  = new ArrayBuffer(byteLength);
  const view = new DataView(buf);

  // RIFF header
  _writeStr(view,  0, 'RIFF');
  view.setUint32(  4, 36 + numSamples * 2, true);
  _writeStr(view,  8, 'WAVE');
  // fmt subchunk
  _writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);                  // subchunk size
  view.setUint16(20, 1,  true);                  // PCM format
  view.setUint16(22, 1,  true);                  // channels = 1 (mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);      // byte rate
  view.setUint16(32, 2,  true);                  // block align
  view.setUint16(34, 16, true);                  // bits per sample
  // data subchunk
  _writeStr(view, 36, 'data');
  view.setUint32(40, numSamples * 2, true);

  // Float32 [-1, 1] → Int16
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }

  // ArrayBuffer → base64. btoa needs a binary string; chunk to avoid stack
  // overflow for long clips.
  const bytes  = new Uint8Array(buf);
  const chunk  = 0x8000;
  let   binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return 'data:audio/wav;base64,' + btoa(binary);
}

function _writeStr(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// ─── Master timeline build ──────────────────────────────────────────────────

/**
 * Build a single mono Float32 PCM buffer aligned to the video timeline.
 *
 * Each entry in `track` describes one step's contribution:
 *   { startMs, samples }
 * where `samples` is a Float32Array at `targetRate`, or null/undefined for
 * a silent step. `totalMs` defines the overall buffer length.
 *
 * @param {{startMs:number, samples?:Float32Array}[]} track
 * @param {number} totalMs
 * @param {number} targetRate
 * @returns {Float32Array}
 */
export function mixTrackToFloat32(track, totalMs, targetRate) {
  const totalFrames = Math.ceil((totalMs / 1000) * targetRate);
  const out = new Float32Array(totalFrames);
  for (const seg of track) {
    if (!seg.samples?.length) continue;
    const startFrame = Math.round((seg.startMs / 1000) * targetRate);
    const len = Math.min(seg.samples.length, totalFrames - startFrame);
    if (len <= 0) continue;
    out.set(seg.samples.subarray(0, len), startFrame);
  }
  return out;
}
