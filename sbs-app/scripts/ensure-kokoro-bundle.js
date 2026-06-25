#!/usr/bin/env node
'use strict';

/**
 * Build guard — guarantees the Kokoro model bundle is present before packaging.
 *
 * Why this exists: `kokoro-bundle/` is gitignored, so a fresh git worktree has
 * NO copy of its own. electron-builder's `extraResources` copies
 * `sbs-app/kokoro-bundle` verbatim from whatever checkout the build runs in — if
 * the dir is absent, electron-builder only WARNS and ships an installer with no
 * model, so TTS is silently broken in the packaged .exe. (The dev-time runtime
 * fallback in electron/main.js does NOT help here — packaging copies files at
 * build time, it can't follow a runtime path.)
 *
 * Order of resolution:
 *   1. bundle already present in this checkout            → done
 *   2. missing → copy it from the main checkout's bundle  → done (the accepted
 *      "duplicate the bundle onto this branch" tradeoff, automated; ~427 MB)
 *   3. still missing → FAIL the build with instructions   → never ship broken
 *
 * Wired into the `build` / `build:nobytenode` npm scripts, ahead of
 * electron-builder. Run standalone any time: `node scripts/ensure-kokoro-bundle.js`.
 */

const fs   = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '..');                 // sbs-app/
const DEST      = path.join(ROOT, 'kokoro-bundle');
// The CPU-baseline model is required on every platform; treat its presence as
// "the bundle is usable". A full copy also brings model.onnx (fp32, GPU) along.
const REL_MODEL = path.join('onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_quantized.onnx');

const hasBundle = (dir) => { try { return fs.existsSync(path.join(dir, REL_MODEL)); } catch { return false; } };

if (hasBundle(DEST)) {
  console.log('[ensure-kokoro] bundle present →', DEST);
  process.exit(0);
}

// Resolve the main checkout's bundle from a worktree path:
//   <root>/.claude/worktrees/<name>/sbs-app  →  <root>/sbs-app/kokoro-bundle
const m   = ROOT.replace(/\\/g, '/').match(/^(.*)\/\.claude\/worktrees\/[^/]+\/sbs-app$/i);
const sib = m ? path.join(m[1], 'sbs-app', 'kokoro-bundle') : null;

if (sib && hasBundle(sib)) {
  console.log('[ensure-kokoro] bundle missing in this worktree — copying from main checkout');
  console.log('  from:', sib);
  console.log('  to:  ', DEST, '(~427 MB, one-time)');
  fs.cpSync(sib, DEST, { recursive: true });
  if (hasBundle(DEST)) {
    console.log('[ensure-kokoro] copy complete — bundle ready for packaging.');
    process.exit(0);
  }
  console.error('[ensure-kokoro] copy finished but the model is still missing — source may be incomplete.');
}

console.error(
  '\n[ensure-kokoro] FATAL: kokoro-bundle is missing and no sibling copy was found.\n' +
  '  Packaging now would ship the app WITHOUT the Kokoro model — TTS would be broken.\n' +
  `  Expected: ${path.join(DEST, REL_MODEL)}\n` +
  '  Fix: run  `npm run fetch-models`  in this checkout (downloads ~427 MB), then rebuild.\n',
);
process.exit(1);
