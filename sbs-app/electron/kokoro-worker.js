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

// Model loads are SERIALIZED. Both loaders mutate the process-global
// tx.env.localModelPath and transformers.js re-reads it on every file fetch,
// so two cold loads interleaving (English synth + Hebrew synth arriving
// together) resolve files against the wrong root — either both ladders fail
// with the misleading "no working device/dtype combination", or a later
// candidate silently loads on a degraded backend (review finding, V0.3.2.133).
// Synthesis itself is NOT serialized — only the load ladders.
let _loadChain = Promise.resolve();
function _serializeLoad(fn) {
  const run = _loadChain.then(fn, fn);
  _loadChain = run.catch(() => {});
  return run;
}
let _activeBackend = 'unknown';   // 'dml' | 'cpu' — for timing logs

async function _load() {
  if (_instance)    return _instance;
  if (_loadPromise) return _loadPromise;
  _loadPromise = _serializeLoad(async () => {
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
    // Distinguish "model files missing" (a fresh worktree without the gitignored
    // bundle) from a real device/dtype incompatibility. Without this guard the
    // missing-files case falls through to the generic "no working device/dtype
    // combination" message, which sends debugging the wrong direction.
    if (!have('') && !have('_fp16') && !have('_quantized')) {
      throw new Error(
        `Kokoro model bundle not found under ${modelDir}. The bundle is gitignored, ` +
        `so a fresh git worktree has no copy — copy sbs-app/kokoro-bundle from your ` +
        `main checkout, or run the fetch-kokoro script.`,
      );
    }
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
  });
  _loadPromise.catch(() => { _loadPromise = null; });
  return _loadPromise;
}

// ---------------------------------------------------------------------------
// Hebrew add-on (V0.3.2.133)
//
// A separate 82M checkpoint, loaded lazily and ONLY when a Hebrew clip is
// actually requested - warming both models would double the ~325 MB resident
// cost against the renderer's heap ceiling for no benefit.
//
// Two deliberate departures from the English path:
//   1. Input is IPA PHONEMES, not text. kokoro-js's phonemizer is espeak
//      English and cannot produce Hebrew IPA, so the renderer phonemizes
//      (nikud -> IPA) and we skip straight to the token path.
//   2. We read the voicepack ourselves instead of letting kokoro-js do it.
//      kokoro-js resolves voices relative to its OWN package directory
//      (node_modules/kokoro-js/voices), which is inside the asar in a
//      packaged build and therefore not writable. Reading from the add-on
//      folder keeps the whole feature inside one removable directory.
// ---------------------------------------------------------------------------

let _heInstance = null;
let _heLoad     = null;
let _heVoices   = new Map();   // name -> Float32Array(510*256)
let _heNikud    = null;        // lazy phonikud ONNX session (lives HERE, not main)

// ALL onnxruntime-node usage must stay inside this worker. Loading the native
// binding in BOTH main and a worker_thread crashes the app on the second
// main-side inference (verified live, V0.3.2.133: exit 127 right after the
// worker initialized its own ORT). So the nikud model runs here too, and the
// main process never touches ORT.
function _heG2p() { return require('./hebrew-g2p.js'); }

async function _heTextToPhonemes(text) {
  const g2p = _heG2p();
  if (!_heNikud) {
    _heNikud = new g2p.Nikud(
      path.join(workerData.hebrewDir, 'nikud', 'phonikud-1.0.onnx'),
      path.join(workerData.hebrewDir, 'nikud', 'tokenizer.json'),
    );
  }
  const t0 = Date.now();
  const vocalized = await _heNikud.addDiacritics(text);
  const phonemes  = g2p.phonemize(vocalized);
  parentPort.postMessage({ kind: 'log',
    msg: `[kokoro-he] g2p ${Date.now() - t0}ms: "${text.slice(0, 30)}" -> "${phonemes.slice(0, 60)}"` });
  return phonemes;
}

async function _loadHebrew() {
  if (_heInstance) return _heInstance;
  if (_heLoad)     return _heLoad;
  if (!workerData.hebrewDir) throw new Error('Hebrew add-on is not installed');

  _heLoad = _serializeLoad(async () => {
    const km = require('kokoro-js');
    const tx = require('@huggingface/transformers');
    let   ort = null;
    try { ort = require('onnxruntime-node'); } catch { /* CPU-only build */ }

    // transformers.js resolves <localModelPath><modelId>, so point it at the
    // add-on's PARENT and use the folder name as the id. Restored afterwards so
    // a later English load still resolves against kokoro-bundle.
    tx.env.localModelPath = path.dirname(workerData.hebrewDir) + path.sep;
    const heId = path.basename(workerData.hebrewDir);

    // CPU ONLY - deliberately no DML for the Hebrew graph. Verified live
    // (V0.3.2.133): the export's ConvTranspose fails DML inference with
    // "parameter is incorrect" (same op family as the English q8/DML issue).
    // Until the model is re-exported DML-compatible there is nothing to gain
    // from trying. CPU synth is ~0.8-1 s/clip warm - fine for narration.
    const candidates = [{ device: 'cpu', dtype: 'fp32' }];

    let tts = null, chosen = null;
    for (const c of candidates) {
      try {
        const t0 = Date.now();
        const cand = await km.KokoroTTS.from_pretrained(heId, { dtype: c.dtype, device: c.device });
        // Smoke-test with a REAL inference before locking the backend in.
        // Same trap as the English q8 path: our fp32 export's ConvTranspose
        // LOADS on DML then throws "parameter is incorrect" at first synth
        // (verified live, V0.3.2.133). Only a forward pass reveals it.
        {
          const { input_ids } = cand.tokenizer('salom.', { truncation: true });
          const style = await _heVoice('he_shaul');
          await cand.model({
            input_ids,
            style: new tx.Tensor('float32', style.slice(0, 256), [1, 256]),
            speed: new tx.Tensor('float32', [1], [1]),
          });
        }
        tts = cand;
        chosen = c;
        parentPort.postMessage({ kind: 'log',
          msg: `[kokoro-he] loaded+smoked ${c.device}/${c.dtype} in ${Date.now() - t0}ms` });
        break;
      } catch (err) {
        parentPort.postMessage({ kind: 'log',
          msg: `[kokoro-he] x ${c.device}/${c.dtype} - ${err?.message?.split('\n')[0] || err}` });
      }
    }
    // Restore to the ENGLISH bundle root (not a captured snapshot): with the
    // load lock held, this is the only value the next English load expects.
    tx.env.localModelPath = workerData.bundleDir + path.sep;
    if (!tts) throw new Error('Hebrew Kokoro: no working device/dtype combination');
    _heInstance = tts;
    return tts;
  });
  _heLoad.catch(() => { _heLoad = null; });
  return _heLoad;
}

/** Load a voicepack straight from the add-on folder (see note 2 above). */
async function _heVoice(name) {
  if (_heVoices.has(name)) return _heVoices.get(name);
  const fsp  = require('fs/promises');
  const file = path.join(workerData.hebrewDir, 'voices', `${name}.bin`);
  const { buffer, byteOffset, byteLength } = await fsp.readFile(file);
  const data = new Float32Array(buffer.slice(byteOffset, byteOffset + byteLength));
  _heVoices.set(name, data);
  return data;
}

/**
 * Synthesize from PRE-COMPUTED IPA phonemes.
 * Mirrors kokoro-js generate_from_ids(), which we cannot call directly because
 * it resolves the voicepack from its own package folder.
 */
async function _heSynth(phonemes, voice, speed) {
  const tx  = require('@huggingface/transformers');
  const tts = await _loadHebrew();

  const { input_ids } = tts.tokenizer(phonemes, { truncation: true });
  const n     = input_ids.dims.at(-1);
  const style = (await _heVoice(voice))
    .slice(256 * Math.min(Math.max(n - 2, 0), 509),
           256 * Math.min(Math.max(n - 2, 0), 509) + 256);

  const { waveform } = await tts.model({
    input_ids,
    style: new tx.Tensor('float32', style, [1, 256]),
    speed: new tx.Tensor('float32', [speed], [1]),
  });
  return new tx.RawAudio(waveform.data, 24000);
}

parentPort.on('message', async (msg) => {
  if (msg?.kind !== 'synth' && msg?.kind !== 'synth-he') return;
  const { id, text, voice, speed } = msg;

  // Hebrew branch: `text` is plain Hebrew; the full chain (nikud -> IPA ->
  // tokens -> model) runs here so ORT never loads in the main process.
  if (msg.kind === 'synth-he') {
    try {
      const t0   = Date.now();
      const rate = Number.isFinite(Number(speed)) && Number(speed) > 0 ? Number(speed) : 1.0;
      const phonemes = await _heTextToPhonemes(text);
      if (!phonemes.trim()) throw new Error('Hebrew G2P produced no phonemes.');
      const audio = await _heSynth(phonemes, voice, rate);
      parentPort.postMessage({ kind: 'log',
        msg: `[kokoro-he] synth ${Date.now() - t0}ms (voice=${voice}, phonemes=${(text || '').length})` });
      parentPort.postMessage({ id, ok: true, wav: Buffer.from(audio.toWav()) });
    } catch (e) {
      parentPort.postMessage({ id, ok: false, error: e?.message || String(e) });
    }
    return;
  }

  try {
    const tts = await _load();
    const t0  = Date.now();
    // kokoro-js generate() accepts { voice, speed }; speed defaults to 1
    // when undefined, so older messages without the field stay backwards-
    // compatible. Range guidance from the library: positive number, 1 = nominal.
    const rate = Number.isFinite(Number(speed)) && Number(speed) > 0 ? Number(speed) : 1.0;
    const audio = await tts.generate(text, { voice, speed: rate });
    const synthMs = Date.now() - t0;
    const wav = audio.toWav();
    const buf = Buffer.from(wav);
    parentPort.postMessage({
      kind: 'log',
      msg:  `[kokoro-worker] synth ${synthMs}ms (backend=${_activeBackend}, voice=${voice}, speed=${rate}, chars=${(text || '').length})`,
    });
    parentPort.postMessage({ id, ok: true, wav: buf });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e?.message || String(e) });
  }
});
