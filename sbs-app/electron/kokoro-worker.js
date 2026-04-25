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

async function _load() {
  if (_instance)    return _instance;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    const km = require('kokoro-js');
    const tx = require('@huggingface/transformers');
    tx.env.localModelPath    = workerData.bundleDir + path.sep;
    tx.env.allowLocalModels  = true;
    tx.env.allowRemoteModels = false;
    tx.env.cacheDir          = workerData.cacheDir;
    parentPort.postMessage({ kind: 'log', msg: `[kokoro-worker] loading model from ${workerData.bundleDir}` });
    const tts = await km.KokoroTTS.from_pretrained(
      'onnx-community/Kokoro-82M-v1.0-ONNX',
      { dtype: 'q8' }
    );
    _instance = tts;
    parentPort.postMessage({ kind: 'log', msg: `[kokoro-worker] model ready — ${Object.keys(tts.voices || {}).length} voices` });
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
    const audio = await tts.generate(text, { voice });
    const wav = audio.toWav();
    // Transfer the underlying buffer instead of cloning — large for long
    // narration. Convert Uint8Array → Buffer (Node) for parentPort transport.
    const buf = Buffer.from(wav);
    parentPort.postMessage({ id, ok: true, wav: buf });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e?.message || String(e) });
  }
});
