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

// ─── Decode audio to a uniform shape  { pcm, sampleRate, channels } ───────
//
// We deliberately AVOID AudioContext.decodeAudioData for the common WAV
// path because it can hang the renderer thread on some Windows audio
// configurations (the audio backend gets stuck initialising). The WAV
// format is trivial to parse by hand and SAPI always emits PCM WAV, so
// the fast path covers our entire current TTS surface.
//
// If a future backend ever produces non-WAV audio we fall back to
// AudioContext.decodeAudioData and pray. Caller should wrap in a timeout.

/**
 * @param {string} url 'data:audio/...;base64,...' or blob URL
 * @param {AudioContext|(() => AudioContext)|null} [ctxOrFactory]
 *        Context to use (or a factory that lazily creates one) for non-WAV
 *        fallback decodes. Skipped entirely for the WAV fast path so we
 *        never touch the audio backend if every clip is WAV.
 * @returns {Promise<AudioBuffer|object>}  AudioBuffer-shape: { numberOfChannels, sampleRate, length, getChannelData(c) }
 */
export async function decodeToAudioBuffer(url, ctxOrFactory) {
  // Fast path — WAV manual parse, no AudioContext needed.
  if (url.startsWith('data:audio/wav') || url.startsWith('data:audio/x-wav')) {
    return _parseWavDataUrl(url);
  }

  let arrayBuffer;
  if (url.startsWith('data:')) {
    arrayBuffer = _dataUrlToArrayBuffer(url);
  } else {
    const response = await fetch(url);
    arrayBuffer    = await response.arrayBuffer();
  }
  if (_looksLikeWav(arrayBuffer)) return _parseWavBuffer(arrayBuffer);

  // Non-WAV: fall back to AudioContext.decodeAudioData.
  const ctx = typeof ctxOrFactory === 'function' ? ctxOrFactory() : ctxOrFactory;
  if (!ctx) throw new Error('No AudioContext available for non-WAV decode.');
  return ctx.decodeAudioData(arrayBuffer);
}

// ─── Manual WAV parser (PCM 8/16/32-bit, mono or multichannel) ─────────────

function _parseWavDataUrl(url) {
  return _parseWavBuffer(_dataUrlToArrayBuffer(url));
}

function _looksLikeWav(buf) {
  if (buf.byteLength < 12) return false;
  const v = new DataView(buf);
  return _readStr(v, 0, 4) === 'RIFF' && _readStr(v, 8, 4) === 'WAVE';
}

function _readStr(view, offset, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/**
 * Returns an AudioBuffer-shaped object so the rest of the bridge doesn't
 * care whether we parsed manually or via decodeAudioData. Caller only
 * uses .numberOfChannels, .sampleRate, .length, .getChannelData(c).
 */
function _parseWavBuffer(buf) {
  if (!_looksLikeWav(buf)) throw new Error('Not a RIFF/WAVE file.');
  const view = new DataView(buf);

  // Walk chunks to find 'fmt ' and 'data'.
  let fmtOff = -1, dataOff = -1, dataSize = 0;
  let off = 12;
  while (off + 8 <= view.byteLength) {
    const id   = _readStr(view, off, 4);
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ') fmtOff = off + 8;
    else if (id === 'data') { dataOff = off + 8; dataSize = size; break; }
    off += 8 + size + (size & 1);   // chunks are padded to even sizes
  }
  if (fmtOff < 0 || dataOff < 0) throw new Error('WAV missing fmt or data chunk.');

  const audioFormat   = view.getUint16(fmtOff, true);
  const numChannels   = view.getUint16(fmtOff + 2, true);
  const sampleRate    = view.getUint32(fmtOff + 4, true);
  const bitsPerSample = view.getUint16(fmtOff + 14, true);

  // audioFormat 1 = PCM, 3 = IEEE float, 0xFFFE = WAVE_FORMAT_EXTENSIBLE.
  if (audioFormat !== 1 && audioFormat !== 3 && audioFormat !== 0xFFFE) {
    throw new Error(`WAV format ${audioFormat} is not PCM/float (compressed WAVs unsupported).`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const totalFrames    = Math.floor(dataSize / (numChannels * bytesPerSample));
  const channels = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(totalFrames));

  if ((audioFormat === 1 || audioFormat === 0xFFFE) && bitsPerSample === 16) {
    const inv = 1 / 0x8000;
    for (let i = 0; i < totalFrames; i++) {
      const base = dataOff + i * numChannels * 2;
      for (let c = 0; c < numChannels; c++) channels[c][i] = view.getInt16(base + c * 2, true) * inv;
    }
  } else if ((audioFormat === 1 || audioFormat === 0xFFFE) && bitsPerSample === 8) {
    // 8-bit WAV is unsigned with a 128 bias.
    for (let i = 0; i < totalFrames; i++) {
      const base = dataOff + i * numChannels;
      for (let c = 0; c < numChannels; c++) channels[c][i] = (view.getUint8(base + c) - 128) / 128;
    }
  } else if ((audioFormat === 1 || audioFormat === 0xFFFE) && bitsPerSample === 24) {
    const inv = 1 / 0x800000;
    for (let i = 0; i < totalFrames; i++) {
      const base = dataOff + i * numChannels * 3;
      for (let c = 0; c < numChannels; c++) {
        const o = base + c * 3;
        let s = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getUint8(o + 2) << 16);
        if (s & 0x800000) s |= 0xFF000000;   // sign extend
        channels[c][i] = s * inv;
      }
    }
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    for (let i = 0; i < totalFrames; i++) {
      const base = dataOff + i * numChannels * 4;
      for (let c = 0; c < numChannels; c++) channels[c][i] = view.getFloat32(base + c * 4, true);
    }
  } else {
    throw new Error(`Unsupported WAV bit depth ${bitsPerSample} for format ${audioFormat}.`);
  }

  // AudioBuffer-like object.
  return {
    numberOfChannels: numChannels,
    sampleRate,
    length:           totalFrames,
    duration:         totalFrames / sampleRate,
    getChannelData(c) { return channels[c]; },
  };
}

function _dataUrlToArrayBuffer(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Malformed data URL.');
  const meta    = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  const isBase64 = /;base64\b/.test(meta);
  let binary;
  if (isBase64) {
    binary = atob(payload);
  } else {
    binary = decodeURIComponent(payload);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ─── Resample any AudioBuffer to mono Float32 at a target rate ─────────────

/**
 * Returns a Float32Array of mono samples at the target rate. Multichannel
 * inputs are averaged. Pure JS — avoids OfflineAudioContext which can hang
 * on Windows audio configurations under specific renderer states.
 *
 * Linear interpolation is plenty for speech narration (the dominant SBS
 * use case) and predictable. Higher-quality SRC (sinc / kaiser) can be
 * dropped in here later without touching callers.
 *
 * @param {AudioBuffer} buffer
 * @param {number}      targetRate   e.g. 48000
 * @returns {Promise<Float32Array>}
 */
export async function resampleToMonoFloat32(buffer, targetRate) {
  const mono = _mixToMono(buffer);
  if (buffer.sampleRate === targetRate) return mono;
  return _linearResample(mono, buffer.sampleRate, targetRate);
}

function _mixToMono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const len = buffer.length;
  const out = new Float32Array(len);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += ch[i];
  }
  const inv = 1 / buffer.numberOfChannels;
  for (let i = 0; i < len; i++) out[i] *= inv;
  return out;
}

function _linearResample(input, srcRate, dstRate) {
  const ratio = srcRate / dstRate;
  const len   = Math.floor(input.length / ratio);
  const out   = new Float32Array(len);
  const last  = input.length - 1;
  for (let i = 0; i < len; i++) {
    const x  = i * ratio;
    const lo = Math.floor(x);
    const hi = lo + 1 > last ? last : lo + 1;
    const t  = x - lo;
    out[i] = input[lo] * (1 - t) + input[hi] * t;
  }
  return out;
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
