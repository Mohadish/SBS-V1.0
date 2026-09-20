#!/usr/bin/env node
/**
 * sync-version — ONE source of truth for the version (V0.3.4.61).
 *
 * The app's version lives in src/core/schema.js as APP_VERSION ('V0.3.4.61')
 * and is bumped on every commit. package.json carried its OWN copy, bumped by
 * hand at release time — and it drifted: package.json said 0.3.3-0 while the
 * app said V0.3.4.58. That copy is not cosmetic. It names the installer file,
 * it is what app.getVersion() returns, and it is the number NSIS compares to
 * decide whether an install is an upgrade. An installer built from the drifted
 * tree would have installed today's app under a version 58 builds stale.
 *
 * So package.json's version is now DERIVED, at the start of every build:
 *
 *     APP_VERSION  V0.3.4.61   →   package.json  0.3.4-61
 *
 * (the mapping the releases have always used: V0.3.2.162 ↔ 0.3.2-162,
 * V0.3.3.0 ↔ 0.3.3-0). In semver terms the last part is a numeric prerelease
 * tag, and numeric tags compare as NUMBERS — 0.3.4-61 > 0.3.4-9 — so upgrade
 * ordering is right.
 *
 *   node scripts/sync-version.js           write package.json if it differs
 *   node scripts/sync-version.js --check   change nothing; exit 1 on drift
 *
 * The write is a one-line text replacement, not parse-and-restringify, so the
 * rest of package.json keeps its formatting and the diff is one line.
 * package-lock.json is left alone — its root version is cosmetic.
 */
'use strict';

const fs   = require('node:fs');
const path = require('node:path');

const ROOT   = path.resolve(__dirname, '..');
const SCHEMA = path.join(ROOT, 'src', 'core', 'schema.js');
const PKG    = path.join(ROOT, 'package.json');
const CHECK  = process.argv.includes('--check');

function fail(msg) { console.error(`[sync-version] ${msg}`); process.exit(1); }

const schema = fs.readFileSync(SCHEMA, 'utf8');
const mVer = /export const APP_VERSION\s*=\s*'V(\d+)\.(\d+)\.(\d+)\.(\d+)'/.exec(schema);
if (!mVer) fail(`could not read APP_VERSION from ${path.relative(ROOT, SCHEMA)} — expected 'V<a>.<b>.<c>.<d>'.`);
const want = `${Number(mVer[1])}.${Number(mVer[2])}.${Number(mVer[3])}-${Number(mVer[4])}`;

const pkgText = fs.readFileSync(PKG, 'utf8');
// the FIRST "version" key is the package's own (dependencies carry none here)
const mPkg = /^(\s*"version"\s*:\s*")([^"]*)(")/m.exec(pkgText);
if (!mPkg) fail('could not find the "version" field in package.json.');
const have = mPkg[2];

// The File tab shows APP_RELEASED next to the version; a build is exactly the
// moment it matters. Only a reminder — a build step should not edit source.
const mRel = /export const APP_RELEASED\s*=\s*'(\d{4}-\d{2}-\d{2})'/.exec(schema);
const today = new Date();
const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
if (mRel && mRel[1] !== todayStr && !CHECK) {
  console.warn(`[sync-version] note: APP_RELEASED is ${mRel[1]} (today is ${todayStr}). `
    + `If this build is a release, update it in src/core/schema.js.`);
}

if (have === want) {
  console.log(`[sync-version] ok — package.json ${have} matches APP_VERSION V${mVer.slice(1, 5).join('.')}`);
  process.exit(0);
}

if (CHECK) {
  fail(`DRIFT: package.json says ${have}, APP_VERSION says V${mVer.slice(1, 5).join('.')} (= ${want}). `
    + `Run "node scripts/sync-version.js" (npm run build does it for you).`);
}

fs.writeFileSync(PKG, pkgText.replace(mPkg[0], `${mPkg[1]}${want}${mPkg[3]}`));
console.log(`[sync-version] package.json ${have} → ${want}  (from APP_VERSION V${mVer.slice(1, 5).join('.')})`);
