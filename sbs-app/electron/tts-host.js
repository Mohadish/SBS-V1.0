/**
 * TTS host — Kokoro inference via the WEB build of kokoro-js + transformers.js.
 * ─────────────────────────────────────────────────────────────────────────────
 * Why the web build, not the Node build?
 *   • The Node build resolves transformers.js → onnxruntime-node, which only
 *     knows about cpu / dml / cuda execution providers. DirectML choked at
 *     ConvTranspose for every dtype we tried (verified, well-traced).
 *   • The Web build resolves transformers.js → onnxruntime-web, which uses
 *     Chromium's WebGPU stack. Different EP, different bugs (none observed),
 *     and the same code path running under WebGPU works on any DX12 GPU.
 *
 * To use the web build inside Electron, we need a clean *browser* renderer:
 * nodeIntegration:false, ES-module loading, no require(). This file is
 * loaded via <script type="module"> from tts-host.html. IPC + config come
 * through the preload (window.ttsHost, window.ttsConfig).
 *
 * Backend selection: webgpu/fp32 → webgpu/fp16 → wasm/q8. Each candidate
 * gets a 1-word smoke synth so a backend that loads but fails at inference
 * gets caught at startup, not on the user's first click.
 */

// kokoro.web.js is a self-contained ~2 MB ES module bundle (transformers.js
// + onnxruntime-web inlined). Path is relative to *this* file, which lives
// in electron/ — so "../node_modules/..." reaches sbs-app/node_modules/.
import { KokoroTTS, env as kokoroEnv } from '../node_modules/kokoro-js/dist/kokoro.web.js';

const $status = document.getElementById('status');
function log(msg) {
  console.log(msg);
  if ($status) $status.textContent = String(msg);
  try { window.ttsHost.log(msg); } catch {}
}

const cfg = window.ttsConfig || {};
const bundleDir  = cfg.bundleDir  || '';
const ortWasmDir = cfg.ortWasmDir || '';

if (!bundleDir) log('[tts-host] ⚠ no bundleDir — main forgot to set additionalArguments');
log(`[tts-host] bundle dir: ${bundleDir}`);
log(`[tts-host] ort wasm: ${ortWasmDir}`);

// Tell ORT-web (via kokoro-js's re-exported env) where to fetch the wasm
// blobs. These ship inside node_modules/onnxruntime-web/dist/ — main passes
// the absolute path through preload args.
if (ortWasmDir) {
  kokoroEnv.wasmPaths = `file:///${ortWasmDir.replace(/\\/g, '/').replace(/\/?$/, '/')}`;
  log(`[tts-host] wasmPaths: ${kokoroEnv.wasmPaths}`);
}

let _instance      = null;
let _activeBackend = 'unknown';
let _loadPromise   = null;

async function _load() {
  if (_instance)    return _instance;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    const candidates = [
      { device: 'webgpu', dtype: 'fp32' },
      { device: 'webgpu', dtype: 'fp16' },
      { device: 'wasm',   dtype: 'q8'   },
    ];
    log(`[tts-host] candidates: ${candidates.map(c => `${c.device}/${c.dtype}`).join(' → ')}`);

    // transformers.js looks under <cache_dir>/<modelId>/...; our bundle
    // layout is exactly kokoro-bundle/onnx-community/Kokoro-82M-v1.0-ONNX/...
    // so cache_dir == bundleDir + trailing slash works directly. With
    // local_files_only:true it never hits the network.
    const cacheDir = bundleDir.replace(/\\/g, '/').replace(/\/?$/, '/');

    const t0 = performance.now();
    let chosen = null, tts = null;
    for (const c of candidates) {
      try {
        const tLoad = performance.now();
        const cand  = await KokoroTTS.from_pretrained(
          'onnx-community/Kokoro-82M-v1.0-ONNX',
          {
            dtype:            c.dtype,
            device:           c.device,
            cache_dir:        cacheDir,
            local_files_only: true,
          },
        );
        // 1-word smoke probe — catches "device loads, inference dies" the
        // way DirectML did. Pick any voice key the model exposes.
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
      window.ttsHost.ready({
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

window.ttsHost.onSynth(async ({ id, text, voice }) => {
  try {
    const wav = await _synth(text, voice);
    window.ttsHost.result(id, true, wav);
  } catch (err) {
    window.ttsHost.result(id, false, err?.message || String(err));
  }
});

window.ttsHost.onShutdown(() => {
  log('[tts-host] shutdown requested');
});

// Eager load so the first user-driven synth doesn't pay the warm-up cost.
_load().catch(err => log(`[tts-host] load failed: ${err?.message || err}`));
