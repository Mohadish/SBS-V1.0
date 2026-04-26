'use strict';

/**
 * TTS host — Kokoro inference inside a hidden Electron renderer.
 * ───────────────────────────────────────────────────────────────
 * Runs in its own renderer process (electron/tts-host.html). nodeIntegration
 * is enabled so we can require() kokoro-js / transformers.js without bundling.
 * The KEY insight: even when loaded via require() in a Node-integrated
 * renderer, transformers.js routes `device:'webgpu'` to its onnxruntime-web
 * backend — which has full WebGPU support via Chromium's GPU stack. So we
 * get GPU acceleration without bundling, without a build step, and without
 * the DirectML EP bugs that broke the worker_threads path.
 *
 * Backend selection (in order):
 *   1. webgpu / fp32  — fastest path, requires DX12-class adapter
 *   2. webgpu / fp16  — half precision, smaller VRAM
 *   3. wasm    / q8   — guaranteed-working fallback (CPU, current speed)
 *
 * Each candidate gets a 1-word smoke synth so we don't lock in a backend
 * that loads cleanly but blows up at inference (the failure mode that
 * burned us on DirectML).
 */

const { ipcRenderer } = require('electron');
const path  = require('path');

const $status = document.getElementById('status');
function log(msg) {
  console.log(msg);
  if ($status) $status.textContent = String(msg);
  try { ipcRenderer.send('tts-host:log', String(msg)); } catch {}
}

function bundleDir() {
  // Main passes the resolved path via webPreferences.additionalArguments.
  // We can't detect dev-vs-packaged from the renderer reliably —
  // process.resourcesPath here points at Electron's own install folder,
  // not our app — so trust what main tells us.
  const arg = (process.argv || []).find(a => a.startsWith('--sbs-kokoro-bundle='));
  if (arg) return arg.slice('--sbs-kokoro-bundle='.length);
  // Last-resort dev fallback (shouldn't be hit if main passes the arg):
  return path.resolve(__dirname, '..', 'kokoro-bundle');
}

let _instance      = null;
let _activeBackend = 'unknown';
let _loadPromise   = null;

async function _load() {
  if (_instance)    return _instance;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    const km = require('kokoro-js');
    const tx = require('@huggingface/transformers');

    const dir = bundleDir();
    tx.env.localModelPath    = dir + path.sep;
    tx.env.allowLocalModels  = true;
    tx.env.allowRemoteModels = false;
    tx.env.cacheDir          = path.join(dir, '.cache');

    log(`[tts-host] bundle dir: ${dir}`);

    const candidates = [
      { device: 'webgpu', dtype: 'fp32' },
      { device: 'webgpu', dtype: 'fp16' },
      { device: 'wasm',   dtype: 'q8'   },
    ];
    log(`[tts-host] candidates: ${candidates.map(c => `${c.device}/${c.dtype}`).join(' → ')}`);

    const t0 = performance.now();
    let chosen = null, tts = null;
    for (const c of candidates) {
      try {
        const tLoad = performance.now();
        const cand  = await km.KokoroTTS.from_pretrained(
          'onnx-community/Kokoro-82M-v1.0-ONNX',
          { dtype: c.dtype, device: c.device },
        );
        // Smoke-synth — a 1-word probe catches "device-loads-but-inference-
        // fails" (the DirectML failure mode). Pick any voice key the model
        // exposes; we don't care which for a probe.
        const smokeVoice = Object.keys(cand.voices || {})[0] || 'af_bella';
        const tSmoke = performance.now();
        await cand.generate('test.', { voice: smokeVoice });
        log(`[tts-host] ✓ ${c.device}/${c.dtype} — load=${Math.round(tSmoke - tLoad)}ms, smoke=${Math.round(performance.now() - tSmoke)}ms`);
        tts = cand;
        chosen = c;
        break;
      } catch (err) {
        log(`[tts-host] ✗ ${c.device}/${c.dtype} — ${(err?.message || err).toString().split('\n')[0]}`);
      }
    }
    if (!tts) throw new Error('Kokoro: no working device/dtype combination');

    _activeBackend = `${chosen.device}/${chosen.dtype}`;
    _instance = tts;
    log(`[tts-host] model ready — backend=${_activeBackend}, ${Object.keys(tts.voices || {}).length} voices, total=${Math.round(performance.now() - t0)}ms`);
    try {
      ipcRenderer.send('tts-host:ready', {
        backend: _activeBackend,
        voices:  Object.keys(tts.voices || {}),
      });
    } catch {}
    return tts;
  })();

  _loadPromise.catch(() => { _loadPromise = null; });
  return _loadPromise;
}

async function _synth(text, voice) {
  const tts = await _load();
  const t0 = performance.now();
  const audio = await tts.generate(text, { voice });
  const ms = Math.round(performance.now() - t0);
  log(`[tts-host] synth ${ms}ms (backend=${_activeBackend}, voice=${voice}, chars=${(text || '').length})`);
  return audio.toWav();   // Uint8Array
}

ipcRenderer.on('tts-host:synth', async (_e, { id, text, voice }) => {
  try {
    const wav = await _synth(text, voice);
    // Send as Buffer-compatible array — Electron IPC structured-clones
    // typed arrays cleanly across the boundary.
    ipcRenderer.send('tts-host:result', id, true, wav);
  } catch (err) {
    ipcRenderer.send('tts-host:result', id, false, err?.message || String(err));
  }
});

ipcRenderer.on('tts-host:shutdown', () => {
  log('[tts-host] shutdown requested');
});

// Kick off model load eagerly so the first user-driven synth doesn't pay
// the warm-up cost.
_load().catch(err => log(`[tts-host] load failed: ${err?.message || err}`));
