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

    parentPort.postMessage({ kind: 'log', msg: `[kokoro-worker] loading model from ${workerData.bundleDir} (device=${device})` });
    const t0 = Date.now();

    let tts;
    try {
      // q8 is what we tested on CPU. Try it on DML first; fall back to fp32
      // if DML rejects the quantized graph (some EPs are pickier than CPU).
      tts = await km.KokoroTTS.from_pretrained(
        'onnx-community/Kokoro-82M-v1.0-ONNX',
        { dtype: 'q8', device },
      );
      _activeBackend = device;
    } catch (err) {
      if (device !== 'cpu') {
        parentPort.postMessage({
          kind: 'log',
          msg:  `[kokoro-worker] ${device} load failed (${err?.message || err}); falling back to CPU`,
        });
        tts = await km.KokoroTTS.from_pretrained(
          'onnx-community/Kokoro-82M-v1.0-ONNX',
          { dtype: 'q8', device: 'cpu' },
        );
        _activeBackend = 'cpu';
      } else {
        throw err;
      }
    }

    _instance = tts;
    parentPort.postMessage({
      kind: 'log',
      msg:  `[kokoro-worker] model ready — backend=${_activeBackend}, ${Object.keys(tts.voices || {}).length} voices, load=${Date.now() - t0}ms`,
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
