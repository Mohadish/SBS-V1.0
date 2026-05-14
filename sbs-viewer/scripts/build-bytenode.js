#!/usr/bin/env node
'use strict';

/**
 * SBS Viewer — Bytenode build orchestrator.
 *
 * Compiles the viewer's license files (license/*.js) to V8 bytecode
 * (.jsc) under Electron's bundled Node binary (ELECTRON_RUN_AS_NODE=1),
 * so the produced bytecode matches the runtime V8.
 *
 * USAGE
 *   npm run bytenode               compile
 *   npm run bytenode:clean         delete all .jsc artifacts
 *
 * Identical pattern to sbs-app/scripts/build-bytenode.js — see that file
 * for the full reasoning. Kept separate per-app so each can pick its own
 * target list.
 */

const path        = require('path');
const fs          = require('fs');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LICENSE_DIR  = path.join(PROJECT_ROOT, 'license');
const TARGETS      = ['verify.js', 'machine-id.js', 'store.js', 'index.js', 'time-monitor.js'];

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
  try { require.resolve('bytenode'); }
  catch {
    console.error('[bytenode] bytenode package not installed. Run: npm install');
    process.exit(1);
  }

  let electronBin;
  try { electronBin = require('electron'); }
  catch {
    console.error('[bytenode] electron package not installed. Run: npm install');
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
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (result.error) {
    console.error('[bytenode] spawn error:', result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[bytenode] worker exited with code ${result.status}`);
    process.exit(result.status || 1);
  }

  // Sanity check every target produced its .jsc.
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

const cmd = process.argv[2];
if (cmd === '--clean' || cmd === 'clean') clean();
else                                       compile();
