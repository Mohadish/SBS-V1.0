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

// ─── Fetch interceptor ──────────────────────────────────────────────────
// kokoro-js (even the .web bundle) hard-codes https://huggingface.co/...
// URLs for config.json, tokenizer.json, model files, voice .bin files.
// It only forwards dtype/device/progress_callback to the inner transformers
// from_pretrained — cache_dir and local_files_only are silently dropped.
// So we can't tell the library "use local files only" through the API.
//
// Solution: intercept fetch() at the renderer level. When we see an HF URL
// for the Kokoro repo, rewrite it to a file:// URL pointing at the same
// path inside kokoro-bundle/. The bundle layout mirrors the HF repo, so
// the substitution is one-line. No actual network requests fire.
const HF_PREFIX = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/';
const _origFetch = window.fetch.bind(window);
const _bundleFileUrl = (rel) => {
  // Build a percent-encoded file:// URL from an absolute Windows-or-Unix
  // path. encodeURI handles spaces (we have one in "SBS-V1.0 - Claude")
  // and other reserved chars without mangling the slashes.
  const abs = `${bundleDir.replace(/\\/g, '/').replace(/\/?$/, '/')}onnx-community/Kokoro-82M-v1.0-ONNX/${rel}`;
  return encodeURI(`file:///${abs}`);
};
window.fetch = (input, init) => {
  const u = typeof input === 'string' ? input : (input?.url || '');
  if (u.startsWith(HF_PREFIX)) {
    const rel    = u.slice(HF_PREFIX.length).split('?')[0];
    const local  = _bundleFileUrl(rel);
    log(`[tts-host] fetch ↪ ${rel} (local)`);
    return _origFetch(local, init);
  }
  return _origFetch(input, init);
};

// kokoro.web.js is a self-contained ~2 MB ES module bundle (transformers.js
// + onnxruntime-web inlined). Path is relative to *this* file, which lives
// in electron/ — so "../node_modules/..." reaches sbs-app/node_modules/.
const { KokoroTTS, env: kokoroEnv } = await import('../node_modules/kokoro-js/dist/kokoro.web.js');

// Tell ORT-web (via kokoro-js's re-exported env) where to fetch the wasm
// blobs. These ship inside node_modules/onnxruntime-web/dist/ — main passes
// the absolute path through preload args.
if (ortWasmDir) {
  kokoroEnv.wasmPaths = encodeURI(`file:///${ortWasmDir.replace(/\\/g, '/').replace(/\/?$/, '/')}`);
  log(`[tts-host] wasmPaths: ${kokoroEnv.wasmPaths}`);
}

let _instance      = null;
let _activeBackend = 'unknown';
let _loadPromise   = null;

async function _load() {
  if (_instance)    return _instance;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    // WebGPU pre-flight — if the renderer doesn't expose navigator.gpu or
    // the adapter request fails, drop the webgpu candidates immediately.
    // Without this, WebGPU init can hang silently on machines where the
    // adapter is unreachable.
    let webgpuOk = false;
    if (navigator.gpu) {
      try {
        const adapter = await Promise.race([
          navigator.gpu.requestAdapter(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('adapter request timed out')), 5000)),
        ]);
        if (adapter) {
          webgpuOk = true;
          log(`[tts-host] WebGPU adapter: ${adapter.info?.vendor || '?'} ${adapter.info?.architecture || ''}`);
        } else {
          log('[tts-host] WebGPU adapter: null (no GPU available)');
        }
      } catch (err) {
        log(`[tts-host] WebGPU adapter check failed: ${err?.message || err}`);
      }
    } else {
      log('[tts-host] navigator.gpu not present — webgpu candidates skipped');
    }

    const allCandidates = [
      { device: 'webgpu', dtype: 'fp32', needsGpu: true  },
      { device: 'webgpu', dtype: 'fp16', needsGpu: true  },
      { device: 'wasm',   dtype: 'q8',   needsGpu: false },
    ];
    const candidates = allCandidates.filter(c => !c.needsGpu || webgpuOk);
    log(`[tts-host] candidates: ${candidates.map(c => `${c.device}/${c.dtype}`).join(' → ')}`);

    // transformers.js looks under <cache_dir>/<modelId>/...; our bundle
    // layout is exactly kokoro-bundle/onnx-community/Kokoro-82M-v1.0-ONNX/...
    // so cache_dir == bundleDir + trailing slash works directly. With
    // local_files_only:true it never hits the network.
    const cacheDir = bundleDir.replace(/\\/g, '/').replace(/\/?$/, '/');

    // Per-candidate timeout. WebGPU first-load is slow because ORT-web
    // compiles the entire ONNX graph into WGSL compute shaders — on a cold
    // run with the 82 M-param Kokoro graph this can take 1-2 minutes.
    // Subsequent runs hit Chromium's shader cache and start in seconds.
    // We give it a generous 4 minutes before giving up.
    const PER_CANDIDATE_MS = 240_000;
    const _withTimeout = (p, ms, label) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ]);

    // Heartbeat — without this the user sees the candidate name and then
    // nothing for ages. Heartbeat resets on every log() call so it only
    // fires when the loader is genuinely silent.
    let _lastLogAt = performance.now();
    const _origLog = log;
    // Wrap log so the heartbeat knows when something else logged.
    // (We're inside _load's IIFE, so this rebind is local.)
    function _heartbeatLog(msg) { _lastLogAt = performance.now(); _origLog(msg); }
    const _heartbeatTimer = setInterval(() => {
      const idle = Math.round((performance.now() - _lastLogAt) / 1000);
      if (idle >= 10) _origLog(`[tts-host] still loading… (${idle}s idle, this is normal for first-run WebGPU shader compile)`);
    }, 5000);

    const t0 = performance.now();
    let chosen = null, tts = null;
    for (const c of candidates) {
      try {
        _heartbeatLog(`[tts-host] trying ${c.device}/${c.dtype} (this can take 1-2 minutes on first run for WebGPU)`);
        const tLoad = performance.now();
        const cand  = await _withTimeout(
          KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
            dtype:            c.dtype,
            device:           c.device,
            cache_dir:        cacheDir,
            local_files_only: true,
          }),
          PER_CANDIDATE_MS,
          `${c.device}/${c.dtype} load`,
        );
        // 1-word smoke probe — catches "device loads, inference dies" the
        // way DirectML did. Pick any voice key the model exposes.
        const smokeVoice = Object.keys(cand.voices || {})[0] || 'af_bella';
        const tSmoke = performance.now();
        await _withTimeout(
          cand.generate('test.', { voice: smokeVoice }),
          PER_CANDIDATE_MS,
          `${c.device}/${c.dtype} smoke`,
        );
        log(`[tts-host] ✓ ${c.device}/${c.dtype} — load=${Math.round(tSmoke - tLoad)}ms, smoke=${Math.round(performance.now() - tSmoke)}ms`);
        tts = cand;
        chosen = c;
        break;
      } catch (err) {
        log(`[tts-host] ✗ ${c.device}/${c.dtype} — ${(err?.message || err).toString().split('\n')[0]}`);
      }
    }
    clearInterval(_heartbeatTimer);
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
