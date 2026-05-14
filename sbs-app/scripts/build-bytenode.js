#!/usr/bin/env node
'use strict';

/**
 * Bytenode build orchestrator.
 * ============================
 * Compiles the SBS license files (electron/license/*.js) to V8 bytecode
 * (.jsc) so the production app ships protected — customers can't open the
 * .asar and read the validation logic in cleartext.
 *
 * KEY POINT — V8 version pinning
 * ------------------------------
 * Bytecode is bound to the EXACT V8 version that produced it. Compiling
 * with the system Node binary would produce .jsc files that fail to load
 * inside Electron at runtime (different V8). To dodge that, we spawn the
 * Electron binary in "run as node" mode (`ELECTRON_RUN_AS_NODE=1`) — that
 * gives us a plain Node REPL but with Electron's bundled V8. The bytecode
 * produced there is guaranteed to load at runtime.
 *
 * USAGE
 * -----
 *   npm run bytenode             → compile (called automatically by `npm run build`)
 *   npm run bytenode:clean       → delete all .jsc artifacts and exit
 *
 * The actual compilation lives in scripts/bytenode-compile-worker.js — we
 * spawn that under Electron's node, capture its exit code, and propagate.
 *
 * DEV WORKFLOW
 * ------------
 * `npm run start` / `npm run dev` does NOT touch this script. The source
 * .js files load normally; .jsc files (if present from a prior build)
 * sit alongside but are ignored by Node's resolver because the .js still
 * wins. .jsc files are gitignored.
 *
 * PRODUCTION WORKFLOW (`npm run build`)
 * -------------------------------------
 * 1. This script runs → emits .jsc files alongside .js sources.
 * 2. electron-builder packages the app. The "files" config in
 *    package.json EXCLUDES the .js sources for license/*, so customers
 *    only get .jsc. Node's resolver finds index.jsc when index.js is
 *    absent (with bytenode's .jsc extension handler registered).
 */

const path        = require('path');
const fs          = require('fs');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LICENSE_DIR  = path.join(PROJECT_ROOT, 'electron', 'license');
const TARGETS      = ['verify.js', 'machine-id.js', 'store.js', 'index.js'];

// ─── Sub-commands ────────────────────────────────────────────────────────────

function clean() {
  let removed = 0;
  for (const name of TARGETS) {
    const jsc = path.join(LICENSE_DIR, name.replace(/\.js$/, '.jsc'));
    if (fs.existsSync(jsc)) {
      fs.unlinkSync(jsc);
      console.log(`[bytenode] removed ${path.relative(PROJECT_ROOT, jsc)}`);
      removed++;
    }
  }
  console.log(`[bytenode] clean done — ${removed} file(s) removed`);
}

function compile() {
  // Sanity: bytenode must be installed.
  try {
    require.resolve('bytenode');
  } catch {
    console.error('[bytenode] `bytenode` package is not installed. Run:  npm install');
    process.exit(1);
  }

  // Path to Electron's binary (npm package `electron` exports it as a string).
  let electronBin;
  try {
    electronBin = require('electron');
  } catch {
    console.error('[bytenode] `electron` package is not installed. Run:  npm install');
    process.exit(1);
  }
  if (typeof electronBin !== 'string') {
    console.error('[bytenode] Could not resolve Electron binary path. Got:', electronBin);
    process.exit(1);
  }

  const worker = path.join(__dirname, 'bytenode-compile-worker.js');
  console.log(`[bytenode] compiling ${TARGETS.length} license file(s) using Electron's V8…`);

  const result = spawnSync(electronBin, [worker], {
    stdio: 'inherit',
    env:   { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });

  if (result.error) {
    console.error('[bytenode] spawn error:', result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[bytenode] worker exited with code ${result.status}`);
    process.exit(result.status || 1);
  }

  // Sanity: every target should now have a sibling .jsc.
  let missing = 0;
  for (const name of TARGETS) {
    const jsc = path.join(LICENSE_DIR, name.replace(/\.js$/, '.jsc'));
    if (!fs.existsSync(jsc)) {
      console.error(`[bytenode] MISSING after compile: ${path.relative(PROJECT_ROOT, jsc)}`);
      missing++;
    }
  }
  if (missing > 0) process.exit(1);

  console.log('[bytenode] compile done.');
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

const cmd = process.argv[2];
if (cmd === '--clean' || cmd === 'clean') {
  clean();
} else {
  compile();
}
