/**
 * tts-webgpu.js — Kokoro TTS on the renderer's WebGPU (V0.3.0.x).
 *
 * Runs Kokoro-82M through onnxruntime-web's WebGPU EP instead of the node
 * worker's DirectML/CPU path. On a capable GPU this is ~0.7 s/clip warm vs
 * ~6 s on CPU. Fully offline (local model, local wasm, voices from the bundle).
 *
 * PORTABILITY / FALLBACK — this engine is opportunistic, never required. It
 * must PASS every gate (navigator.gpu → adapter → model load → warm-up synth)
 * before `state === 'ready'`. Any failure (no GPU, weak GPU, driver bug, OOM,
 * old Chromium) → `state === 'unavailable'`, and tts.js silently routes Kokoro
 * to the node/CPU worker exactly as before. Nothing here is machine-specific:
 * all paths are relative to this module (import.meta.url), and WebGPU is a
 * vendor-neutral abstraction (NVIDIA/AMD/Intel/integrated all work through it).
 *
 * Two gotchas this build handles (validated empirically, V0.3.0.x):
 *   1. The web bundle defaults ORT's wasm to a jsdelivr CDN — patched out to a
 *      bundle-relative path by scripts/vendor-tts-webgpu.js (offline + CSP).
 *   2. Electron 28 = Chromium 120, which lacks ReadableStream async iteration
 *      (Chromium 124+). kokoro's phonemizer needs it → polyfilled below.
 */

const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let _state = 'untried';   // 'untried' | 'initializing' | 'ready' | 'unavailable'
let _tts   = null;
let _initPromise = null;
let _lastError = null;

export function getState()  { return _state; }
export function isReady()   { return _state === 'ready'; }
export function lastError() { return _lastError; }

// ── Chromium-120 polyfill: ReadableStream async iteration ──────────────────────
function _installReadableStreamAsyncIterator() {
  if (typeof ReadableStream === 'undefined') return;
  if (ReadableStream.prototype[Symbol.asyncIterator]) return;
  ReadableStream.prototype[Symbol.asyncIterator] = function ({ preventCancel = false } = {}) {
    const reader = this.getReader();
    return {
      async next() {
        try { const r = await reader.read(); if (r.done) reader.releaseLock(); return r; }
        catch (e) { reader.releaseLock(); throw e; }
      },
      async return(value) {
        if (!preventCancel) { const c = reader.cancel(value); reader.releaseLock(); await c; }
        else reader.releaseLock();
        return { done: true, value };
      },
      [Symbol.asyncIterator]() { return this; },
    };
  };
  ReadableStream.prototype.values = ReadableStream.prototype[Symbol.asyncIterator];
}

// ── Voice fetch shim: the bundle loads voices from a hardcoded huggingface.co
//    URL (CacheStorage fallback is unavailable on file://). Redirect to the
//    local bundle so synth is fully offline. Installed once. ────────────────────
let _shimInstalled = false;
function _installVoiceShim(modelBase) {
  if (_shimInstalled) return;
  _shimInstalled = true;
  const VOICE_RE  = /huggingface\.co\/onnx-community\/Kokoro-82M-v1\.0-ONNX\/resolve\/main\/voices\/([^?]+\.bin)/;
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url;
    const m = url && url.match(VOICE_RE);
    if (m) return origFetch(`${modelBase}${REPO}/voices/${m[1]}`, init);
    return origFetch(input, init);
  };
}

/**
 * Bring the engine up (idempotent, never throws). Safe to call eagerly at app
 * launch so the first real clip is already warm. Returns the resulting state.
 */
export async function warmUp() {
  if (_state === 'ready' || _state === 'unavailable') return _state;
  if (_initPromise) { await _initPromise; return _state; }
  _state = 'initializing';
  _initPromise = (async () => {
    try {
      if (!navigator.gpu) throw new Error('navigator.gpu unavailable (no WebGPU in this build)');
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('requestAdapter() returned null (no WebGPU-capable device)');

      _installReadableStreamAsyncIterator();
      // MODEL path comes from the main process: packaged builds keep the model
      // in resources/ (extraResources, OUTSIDE the asar) while this module +
      // vendor/ are INSIDE it, so a module-relative path would miss it. Main's
      // _kokoroBundleDir() already resolves dev / packaged / worktree correctly.
      // Fall back to the relative path for dev / non-Electron.
      let modelBase;
      try { modelBase = await window.sbsNative?.tts?.kokoroBundleUrl?.(); } catch {}
      if (!modelBase) modelBase = new URL('../../kokoro-bundle/', import.meta.url).href;
      if (!modelBase.endsWith('/')) modelBase += '/';
      // WASM lives in vendor/ (inside the asar, asar-unpacked at build) → it
      // resolves relative to this module in both dev and packaged.
      const wasmBase = new URL('../../vendor/ort/', import.meta.url).href;
      _installVoiceShim(modelBase);

      const { KokoroTTS, env } = await import('../../vendor/kokoro.web.js');
      env.allowRemoteModels = false;
      env.allowLocalModels  = true;
      env.localModelPath    = modelBase;
      env.backends ??= {}; env.backends.onnx ??= {}; env.backends.onnx.wasm ??= {};
      env.backends.onnx.wasm.wasmPaths = {
        mjs:  `${wasmBase}ort-wasm-simd-threaded.jsep.mjs`,
        wasm: `${wasmBase}ort-wasm-simd-threaded.jsep.wasm`,
      };
      env.backends.onnx.wasm.numThreads = 1;   // file:// has no SharedArrayBuffer

      const t0 = performance.now();
      _tts = await KokoroTTS.from_pretrained(REPO, { dtype: 'fp32', device: 'webgpu' });
      // Warm-up synth compiles the GPU shaders so the first REAL clip is fast.
      const v = Object.keys(_tts.voices || {})[0] || 'af_heart';
      await _tts.generate('warm up.', { voice: v });
      _state = 'ready';
      console.log(`[tts-webgpu] ready — GPU synth enabled (init ${Math.round(performance.now() - t0)} ms)`);
    } catch (e) {
      _lastError = e;
      _tts = null;
      _state = 'unavailable';
      console.warn('[tts-webgpu] unavailable — Kokoro will use the CPU worker:', e?.message || e);
    }
  })();
  await _initPromise;
  _initPromise = null;
  return _state;
}

function _u8ToB64(u8) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  return btoa(bin);
}

/**
 * Synthesize one clip. ONLY call when isReady() — throws otherwise so the
 * caller (tts.js) can fall back to the CPU worker. Returns the same shape as
 * the rest of the TTS pipeline: { dataUrl, mime, durationMs }.
 *
 * @param {string} text
 * @param {string} speaker  Kokoro voice id, e.g. 'af_heart'
 * @param {number} [speed]
 */
export async function synthesize(text, speaker, speed = 1.0) {
  if (_state !== 'ready' || !_tts) throw new Error('WebGPU TTS engine not ready');
  const voice = (speaker && _tts.voices?.[speaker]) ? speaker : (Object.keys(_tts.voices || {})[0] || 'af_heart');
  const rate  = Number.isFinite(Number(speed)) && Number(speed) > 0 ? Number(speed) : 1.0;
  const audio = await _tts.generate(text, { voice, speed: rate });
  const wav   = audio.toWav();                       // ArrayBuffer (RIFF/WAVE)
  const dataUrl = `data:audio/wav;base64,${_u8ToB64(new Uint8Array(wav))}`;
  const durationMs = audio.sampling_rate
    ? Math.round((audio.audio.length / audio.sampling_rate) * 1000)
    : 0;
  return { dataUrl, mime: 'audio/wav', durationMs };
}
