#!/usr/bin/env node
'use strict';

/**
 * Vendor + patch the WebGPU-Kokoro assets into vendor/ (V0.3.0.x).
 *
 * The renderer WebGPU TTS engine (src/systems/tts-webgpu.js) imports a browser
 * build of kokoro-js plus onnxruntime-web's WebGPU wasm. These live in
 * node_modules; this script copies them into vendor/ and applies one essential
 * PATCH so the app stays offline + CSP-clean:
 *
 *   kokoro.web.js defaults ORT's wasm path to a jsdelivr CDN
 *   (`https://cdn.jsdelivr.net/npm/@huggingface/transformers@<ver>/dist/`).
 *   That import is BOTH blocked by our CSP and fatal offline. We rewrite the
 *   default to `new URL("./ort/", import.meta.url).href` — i.e. the vendored
 *   wasm next to the bundle, resolved relative to the bundle itself (so it
 *   works in any worktree and when packaged).
 *
 * Idempotent. Vendored files are gitignored (binary/large); this script
 * regenerates them. Wired into `build` so a clean checkout packages correctly.
 *
 * Run standalone:  node scripts/vendor-tts-webgpu.js   (or: npm run vendor-tts)
 */

const fs   = require('fs');
const path = require('path');

const ROOT       = path.resolve(__dirname, '..');                 // sbs-app/
const VENDOR     = path.join(ROOT, 'vendor');
const VENDOR_ORT = path.join(VENDOR, 'ort');
const NM         = path.join(ROOT, 'node_modules');

const SRC_BUNDLE = path.join(NM, 'kokoro-js', 'dist', 'kokoro.web.js');
const SRC_MJS    = path.join(NM, '@huggingface', 'transformers', 'dist', 'ort-wasm-simd-threaded.jsep.mjs');
const SRC_WASM   = path.join(NM, '@huggingface', 'transformers', 'dist', 'ort-wasm-simd-threaded.jsep.wasm');

const DST_BUNDLE = path.join(VENDOR, 'kokoro.web.js');
const DST_MJS    = path.join(VENDOR_ORT, 'ort-wasm-simd-threaded.jsep.mjs');
const DST_WASM   = path.join(VENDOR_ORT, 'ort-wasm-simd-threaded.jsep.wasm');

// The jsdelivr default (template literal) → bundle-relative local path.
const JSDELIVR = 'C.wasm.wasmPaths=`https://cdn.jsdelivr.net/npm/@huggingface/transformers@${n.env.version}/dist/`';
const LOCAL    = 'C.wasm.wasmPaths=new URL("./ort/",import.meta.url).href';

// PATCH 2 (V0.3.4.98). kokoro-js 1.2.1's web bundle EXPORTS A STUB as `env`:
//   Mf={set wasmPaths(e){Wg.backends.onnx.wasm.wasmPaths=e},get wasmPaths(){…}}
// — only wasmPaths reaches the real transformers env (Wg = Yg.env). Everything
// tts-webgpu.js sets on it (allowRemoteModels=false, allowLocalModels=true,
// localModelPath=file://…) landed on the stub and changed nothing, so the
// loader kept its browser defaults — local models OFF, remote ON — and fetched
// config.json from huggingface.co, which the CSP blocks: "Failed to fetch",
// engine 'unavailable', every clip on the CPU worker (~6–20 s instead of
// ~0.7 s). Found 2026-09-23; the 0.3.3-0 installer shipped like this. The
// export is rewritten to the real env object (identifiers matched by shape,
// not by name — they change per build).
const ENV_STUB = /(\w+)=\{set wasmPaths\(e\)\{(\w+)\.backends\.onnx\.wasm\.wasmPaths=e\},get wasmPaths\(\)\{return \2\.backends\.onnx\.wasm\.wasmPaths\}\}/;

function fail(msg) { console.error(`[vendor-tts] FATAL: ${msg}`); process.exit(1); }

for (const [label, p] of [['kokoro.web.js', SRC_BUNDLE], ['ort .mjs', SRC_MJS], ['ort .wasm', SRC_WASM]]) {
  if (!fs.existsSync(p)) fail(`${label} not found at ${p}. Run \`npm install\` first.`);
}

fs.mkdirSync(VENDOR_ORT, { recursive: true });

// 1. kokoro.web.js — copy, then patch the jsdelivr default to local.
let bundle = fs.readFileSync(SRC_BUNDLE, 'utf8');
if (bundle.includes(JSDELIVR)) {
  bundle = bundle.replace(JSDELIVR, LOCAL);
} else if (!bundle.includes(LOCAL)) {
  fail('kokoro.web.js no longer contains the expected jsdelivr default — the bundle changed; update the patch in scripts/vendor-tts-webgpu.js.');
}
if (bundle.includes('cdn.jsdelivr.net/npm/@huggingface/transformers@${n.env.version}')) {
  fail('patch did not remove the jsdelivr default — aborting to avoid shipping an online-dependent build.');
}
// 2. the env export → the real env (see PATCH 2 above).
const stub = bundle.match(ENV_STUB);
if (stub) {
  bundle = bundle.replace(ENV_STUB, '$1=$2');
  console.log(`[vendor-tts] env export patched: ${stub[1]} → ${stub[2]} (the real transformers env)`);
} else if (/set wasmPaths\(e\)/.test(bundle)) {
  fail('kokoro.web.js exports an env stub of a new shape — update ENV_STUB in scripts/vendor-tts-webgpu.js (the engine cannot load local models through a stub).');
} else {
  console.log('[vendor-tts] env export: no stub found — the bundle exports the real env already');
}
fs.writeFileSync(DST_BUNDLE, bundle);

// 2. ORT wasm + loader — straight copy.
fs.copyFileSync(SRC_MJS, DST_MJS);
fs.copyFileSync(SRC_WASM, DST_WASM);

console.log('[vendor-tts] vendored + patched:');
console.log('  ', DST_BUNDLE, '(jsdelivr → local ./ort/)');
console.log('  ', DST_MJS);
console.log('  ', DST_WASM, `(${(fs.statSync(DST_WASM).size / 1048576).toFixed(0)} MB)`);
