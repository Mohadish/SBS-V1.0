#!/usr/bin/env node
'use strict';

/**
 * Bytenode compile worker — runs INSIDE Electron's bundled Node.
 * ===============================================================
 * Invoked by scripts/build-bytenode.js via:
 *
 *   ELECTRON_RUN_AS_NODE=1 <electron> scripts/bytenode-compile-worker.js
 *
 * Running under Electron's node binary guarantees that the bytecode we
 * produce is bound to the SAME V8 version that the runtime app will use
 * to load it. Compiling with the system Node would produce .jsc files
 * that fail at runtime with a magic-number mismatch.
 *
 * For each entry in TARGETS we call bytenode.compileFile and write a
 * `.jsc` sibling next to the `.js` source.
 *
 * SECURITY NOTE
 * -------------
 * Bytenode is NOT cryptographic protection — a determined attacker with
 * matching V8 internals can recover most of the source. It's a speed
 * bump, not a vault. The license verification's REAL security comes from
 * the Ed25519 signature scheme (private key offline, can't forge).
 * Bytenode just slows down "casually crack the validator" attempts.
 */

const path     = require('path');
const fs       = require('fs');
const bytenode = require('bytenode');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LICENSE_DIR  = path.join(PROJECT_ROOT, 'electron', 'license');

// Files to protect — these contain the core license validation logic.
// Keep the list explicit (rather than glob) so we don't accidentally
// bytecode something that breaks (e.g. files with dynamic require, top-
// level await, or odd syntax).
const TARGETS = [
  'verify.js',
  'machine-id.js',
  'store.js',
  'index.js',
];

let failed = 0;

for (const name of TARGETS) {
  const src = path.join(LICENSE_DIR, name);
  const out = src.replace(/\.js$/, '.jsc');

  if (!fs.existsSync(src)) {
    console.warn(`[bytenode-worker] skip — source missing: ${name}`);
    continue;
  }

  try {
    bytenode.compileFile({
      filename:        src,
      output:          out,
      compileAsModule: true,   // wrap as CommonJS — matches how main.js requires these
    });
    const sz = fs.statSync(out).size;
    console.log(`[bytenode-worker] ${name} → ${path.basename(out)}  (${sz} bytes)`);
  } catch (err) {
    console.error(`[bytenode-worker] FAILED to compile ${name}:`, err?.stack || err);
    failed++;
  }
}

process.exit(failed > 0 ? 1 : 0);
