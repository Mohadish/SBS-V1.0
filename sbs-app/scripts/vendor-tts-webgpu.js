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
fs.writeFileSync(DST_BUNDLE, bundle);

// 2. ORT wasm + loader — straight copy.
fs.copyFileSync(SRC_MJS, DST_MJS);
fs.copyFileSync(SRC_WASM, DST_WASM);

console.log('[vendor-tts] vendored + patched:');
console.log('  ', DST_BUNDLE, '(jsdelivr → local ./ort/)');
console.log('  ', DST_MJS);
console.log('  ', DST_WASM, `(${(fs.statSync(DST_WASM).size / 1048576).toFixed(0)} MB)`);
