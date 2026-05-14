#!/usr/bin/env node
'use strict';

/**
 * SBS Viewer — Bytenode compile worker.
 * Runs INSIDE Electron's bundled Node (ELECTRON_RUN_AS_NODE=1) so the
 * V8 version matches the runtime that will load the resulting .jsc.
 *
 * Mirrors sbs-app/scripts/bytenode-compile-worker.js.
 */

const path     = require('path');
const fs       = require('fs');
const bytenode = require('bytenode');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LICENSE_DIR  = path.join(PROJECT_ROOT, 'license');

const TARGETS = [
  'verify.js',
  'machine-id.js',
  'store.js',
  'index.js',
  'time-monitor.js',
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
      compileAsModule: true,
    });
    const sz = fs.statSync(out).size;
    console.log(`[bytenode-worker] ${name} → ${path.basename(out)}  (${sz} bytes)`);
  } catch (err) {
    console.error(`[bytenode-worker] FAILED to compile ${name}:`, err?.stack || err);
    failed++;
  }
}

process.exit(failed > 0 ? 1 : 0);
