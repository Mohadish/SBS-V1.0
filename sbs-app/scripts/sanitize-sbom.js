#!/usr/bin/env node
'use strict';

/**
 * SBOM metadata sanitizer (V0.3.2.39 — security-audit compliance).
 * =================================================================
 * SBOM scanners read the package.json files INSIDE the shipped asar. Two
 * classes of finding come from metadata that has no runtime existence:
 *
 *   1. devDependencies declarations — e.g. node_modules/platform declares
 *      "requirejs": "^2.3.6" as a DEV dependency. RequireJS is not installed
 *      and not shipped, but the string got the product flagged ("RequireJS
 *      2.3.6, vulnerable"). Dev deps are NEVER needed at runtime.
 *
 *   2. Version RANGES in dependencies — onnxruntime-web declares
 *      "protobufjs": "^7.2.4", which scanners read as ">=7.2.4 <8.0.0 —
 *      includes vulnerable versions" even when the RESOLVED version is
 *      patched. Pinning the declaration to the exactly-installed version
 *      makes the SBOM read the truth.
 *
 * Run AFTER npm install and BEFORE electron-builder (wired into `npm run
 * build`). Mutates node_modules/... package.json files in place — npm
 * restores originals on the next `npm install`, so this is build-time-only
 * hygiene, not a fork of anyone's package.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'node_modules');

/** version of an installed package (nearest node_modules resolution from a dir) */
function installedVersion(fromDir, name) {
  let dir = fromDir;
  for (let i = 0; i < 10; i++) {
    const p = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')).version || null; } catch { return null; }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // top-level fallback
  const top = path.join(ROOT, name, 'package.json');
  if (fs.existsSync(top)) {
    try { return JSON.parse(fs.readFileSync(top, 'utf8')).version || null; } catch { return null; }
  }
  return null;
}

function* walkPackageJsons(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkPackageJsons(p);
    else if (e.name === 'package.json') yield p;
  }
}

let stripped = 0, pinned = 0, files = 0;
for (const pj of walkPackageJsons(ROOT)) {
  let obj;
  try { obj = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch { continue; }
  let touched = false;

  // 1. Dev-only metadata: never needed at runtime, reads as phantom components.
  for (const k of ['devDependencies', 'scripts', 'optionalDevDependencies']) {
    if (obj[k] && Object.keys(obj[k]).length) { delete obj[k]; stripped++; touched = true; }
  }

  // 2. Pin declared runtime dependency RANGES to the exactly-installed version.
  const pkgDir = path.dirname(pj);
  for (const sect of ['dependencies', 'optionalDependencies']) {
    const deps = obj[sect];
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      const v = installedVersion(pkgDir, name);
      // Always pin to the INSTALLED version — even when the declaration is
      // already exact. A previous sanitize pass (or upstream pinning) can
      // leave a stale exact version behind after an override changes what's
      // actually installed; the SBOM must read what ships.
      if (v && String(range) !== v) { deps[name] = v; pinned++; touched = true; }
    }
  }

  if (touched) { fs.writeFileSync(pj, JSON.stringify(obj, null, 2) + '\n'); files++; }
}

console.log(`[sanitize-sbom] ${files} package.json file(s) sanitized — ${stripped} dev/script section(s) stripped, ${pinned} dependency range(s) pinned to installed versions.`);
