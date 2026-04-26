'use strict';

/**
 * Kokoro inference worker.
 *
 * Spawned as a worker_threads Worker by main.js. All Kokoro / ONNX runtime
 * heavy lifting happens here, so the main process event loop (and every IPC
 * handler that sits on it) stays responsive while a synth is in flight.
 *
 * Protocol
 *   ← from main: { kind: 'synth', id, text, voice }
 *   → to main:   { id, ok: true, wav: Buffer }
 *   → to main:   { id, ok: false, error: string }
 */

const { parentPort, workerData } = require('worker_threads');
const path = require('path');

let _instance = null;
let _loadPromise = null;
let _activeBackend = 'unknown';   // 'dml' | 'cpu' — for timing logs

async function _load() {
  if (_instance)    return _instance;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    const km  = require('kokoro-js');
    const tx  = require('@huggingface/transformers');
    let   ort = null;
    try { ort = require('onnxruntime-node'); } catch { /* CPU-only build */ }

    tx.env.localModelPath    = workerData.bundleDir + path.sep;
    tx.env.allowLocalModels  = true;
    tx.env.allowRemoteModels = false;
    tx.env.cacheDir          = workerData.cacheDir;

    // Probe which execution providers the bundled onnxruntime-node ships
    // with. DirectML is the Windows-universal GPU path — works on any DX12
    // GPU (NVIDIA, AMD, Intel, integrated) without a CUDA install. We
    // prefer it; fall back to CPU silently if unavailable.
    const supported = ort?.listSupportedBackends?.() || [];
    const hasDml    = supported.some(b => b?.name === 'dml');
    const device    = hasDml ? 'dml' : 'cpu';
    parentPort.postMessage({
      kind: 'log',
      msg:  `[kokoro-worker] ORT backends: ${supported.map(b => b.name).join(', ') || '(none)'} → device=${device}`,
    });

    // Try a sequence of (device, dtype) pairs. The first that survives a
    // smoke-test synth wins. Order matters:
    //   1. dml + fp32  — fastest path, but needs model.onnx in the bundle
    //                     (added by fetch-kokoro.js if available)
    //   2. dml + fp16  — middle ground, smaller file, may fall over on some
    //                     ops with this graph
    //   3. dml + q8    — lightest, but DML rejects the q8 ConvTranspose in
    //                     this Kokoro graph (verified failure)
    //   4. cpu + q8    — guaranteed-working fallback, current baseline
    //
    // We don't just try-catch the load: q8 LOADS fine on DML, then dies at
    // first synth with "ConvTranspose: parameter is incorrect". So every
    // candidate gets a tiny smoke-test synth before we lock it in.
    const fs       = require('fs');
    const modelDir = path.join(workerData.bundleDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx');
    const have     = (suffix) => fs.existsSync(path.join(modelDir, `model${suffix}.onnx`));
    const candidates = [];
    if (hasDml && have(''))           candidates.push({ device: 'dml', dtype: 'fp32' });
    if (hasDml && have('_fp16'))      candidates.push({ device: 'dml', dtype: 'fp16' });
    if (hasDml && have('_quantized')) candidates.push({ device: 'dml', dtype: 'q8'   });
    candidates.push({ device: 'cpu', dtype: 'q8' });   // always as last resort

    parentPort.postMessage({
      kind: 'log',
      msg:  `[kokoro-worker] candidates: ${candidates.map(c => `${c.device}/${c.dtype}`).join(' → ')}`,
    });

    const t0 = Date.now();
    let tts = null;
    let chosen = null;
    for (const c of candidates) {
      try {
        const tLoad = Date.now();
        const cand = await km.KokoroTTS.from_pretrained(
          'onnx-community/Kokoro-82M-v1.0-ONNX',
          { dtype: c.dtype, device: c.device },
        );
        // Smoke-test: a 1-word synth picks up any op-not-supported errors
        // that only fire at inference time (the q8/dml ConvTranspose issue).
        const smokeVoice = Object.keys(cand.voices || {})[0] || 'af_bella';
        const tSmoke = Date.now();
        await cand.generate('test.', { voice: smokeVoice });
        parentPort.postMessage({
          kind: 'log',
          msg:  `[kokoro-worker] ✓ ${c.device}/${c.dtype} — load=${tSmoke - tLoad}ms, smoke=${Date.now() - tSmoke}ms`,
        });
        tts = cand;
        chosen = c;
        break;
      } catch (err) {
        parentPort.postMessage({
          kind: 'log',
          msg:  `[kokoro-worker] ✗ ${c.device}/${c.dtype} — ${err?.message?.split('\n')[0] || err}`,
        });
      }
    }
    if (!tts) throw new Error('Kokoro: no working device/dtype combination');

    _activeBackend = `${chosen.device}/${chosen.dtype}`;
    _instance = tts;
    parentPort.postMessage({
      kind: 'log',
      msg:  `[kokoro-worker] model ready — backend=${_activeBackend}, ${Object.keys(tts.voices || {}).length} voices, total=${Date.now() - t0}ms`,
    });
    return tts;
  })();
  _loadPromise.catch(() => { _loadPromise = null; });
  return _loadPromise;
}

parentPort.on('message', async (msg) => {
  if (msg?.kind !== 'synth') return;
  const { id, text, voice } = msg;
  try {
    const tts = await _load();
    const t0  = Date.now();
    const audio = await tts.generate(text, { voice });
    const synthMs = Date.now() - t0;
    const wav = audio.toWav();
    const buf = Buffer.from(wav);
    parentPort.postMessage({
      kind: 'log',
      msg:  `[kokoro-worker] synth ${synthMs}ms (backend=${_activeBackend}, voice=${voice}, chars=${(text || '').length})`,
    });
    parentPort.postMessage({ id, ok: true, wav: buf });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e?.message || String(e) });
  }
});
