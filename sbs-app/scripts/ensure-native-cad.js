#!/usr/bin/env node
/**
 * ensure-native-cad — say the truth about the 64-bit CAD converter (V0.3.4.61).
 *
 * native/bin/win-x64/sbs-occt-convert.exe is an OPTIONAL add-on: OpenCascade
 * built native + 64-bit, so big STEP / IGES assemblies load without the ~2 GB
 * cap of the in-app WASM reader. Without it the app still works — small files
 * load through WASM exactly as before — so its absence must not fail a build.
 *
 * What it must not be is SILENT. The folder has only ever held a placeholder,
 * electron-builder filters the placeholder out, and so every installer ever
 * built shipped with no converter and nothing said so: a customer's 300 MB
 * assembly simply fails, and nobody at the build end knew the feature was out.
 * The Kokoro model check hard-fails the build; this had no check at all.
 *
 *   • exe absent        → a loud, plain notice. The build continues.
 *   • exe present, but without its OpenCascade DLLs beside it
 *                       → the build FAILS. That installer would be worse than
 *                         one without the converter: the app would find the
 *                         exe, run it, and it would die on the customer's
 *                         machine instead of falling back to WASM.
 *   • SBS_REQUIRE_NATIVE_CAD=1  → absence fails the build too. Set it for a
 *                         release that is promised to open big assemblies.
 *
 * To build the converter: native/README.md (Visual Studio C++ + vcpkg; the
 * first OpenCascade build takes one to two hours).
 */
'use strict';

const fs   = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIR  = path.join(ROOT, 'native', 'bin', 'win-x64');
const EXE  = path.join(DIR, 'sbs-occt-convert.exe');
const REQUIRE = process.env.SBS_REQUIRE_NATIVE_CAD === '1';

// A Windows build is the only one that ships today (see package.json targets).
if (process.platform !== 'win32') {
  console.log('[ensure-native-cad] not a Windows build — skipped.');
  process.exit(0);
}

const bar = '─'.repeat(72);

if (!fs.existsSync(EXE)) {
  const lines = [
    '',
    bar,
    '  ⚠  THIS INSTALLER WILL NOT INCLUDE THE 64-BIT CAD CONVERTER',
    bar,
    '  native/bin/win-x64/sbs-occt-convert.exe is not there.',
    '',
    '  The app still works: STEP / IGES files load through the in-app reader.',
    '  But that reader is 32-bit and stops at about 2 GB of memory, so LARGE',
    '  assemblies (roughly 150 MB of STEP and up) will fail to open for whoever',
    '  installs this build.',
    '',
    '  To include it: build it once (native/README.md — Visual Studio C++ and',
    '  vcpkg, the first OpenCascade build takes 1–2 hours), then build again.',
    '  To make its absence stop the build:  set SBS_REQUIRE_NATIVE_CAD=1',
    bar,
    '',
  ];
  if (REQUIRE) { console.error(lines.join('\n')); console.error('[ensure-native-cad] SBS_REQUIRE_NATIVE_CAD=1 → failing the build.'); process.exit(1); }
  console.warn(lines.join('\n'));
  process.exit(0);
}

// The exe is dynamically linked against OpenCascade (it has to be — LGPL), so
// it is useless without the TK*.dll set next to it.
const dlls = fs.readdirSync(DIR).filter(f => /\.dll$/i.test(f));
const tk   = dlls.filter(f => /^TK/i.test(f));
const MUST = ['TKernel.dll', 'TKMath.dll'];            // nothing in OCCT runs without these two
const missing = MUST.filter(m => !dlls.some(d => d.toLowerCase() === m.toLowerCase()));

if (missing.length || tk.length < 8) {
  console.error([
    '',
    bar,
    '  ✖  THE CAD CONVERTER IS THERE, BUT ITS OPENCASCADE DLLs ARE NOT',
    bar,
    `  Found sbs-occt-convert.exe with ${tk.length} TK*.dll beside it`
      + (missing.length ? ` — missing ${missing.join(', ')}.` : ' — far too few.'),
    '',
    '  Shipping this is worse than shipping no converter: the app would find',
    '  the exe, run it on a big file, and it would crash on the customer\'s',
    '  machine instead of falling back to the in-app reader.',
    '',
    '  Copy EVERY dll from  vcpkg\\installed\\x64-windows\\bin  into',
    '  native\\bin\\win-x64\\  (or list them: dumpbin /DEPENDENTS sbs-occt-convert.exe).',
    bar,
    '',
  ].join('\n'));
  process.exit(1);
}

const mb = (n) => (n / 1048576).toFixed(0);
const total = fs.readdirSync(DIR).reduce((s, f) => { try { return s + fs.statSync(path.join(DIR, f)).size; } catch { return s; } }, 0);
console.log(`[ensure-native-cad] ok — 64-bit converter present with ${dlls.length} DLLs (${tk.length} OpenCascade), ${mb(total)} MB. It will ship.`);
