// Read-only checks on the SHIPPED build (V0.3.4.185 — moved into the repo from
// E:\claude-temp). Run after `npm run build`: `npm run verify-build`.
// NEVER extract the asar inside sbs-app/ (a stripped package.json lands over
// the real one) — everything here reads through @electron/asar in memory.
import { createRequire } from 'node:module';
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(`${APP}/package.json`);
const asar = require('@electron/asar');
const UNP = `${APP}/dist/win-unpacked/resources`;
const A = `${UNP}/app.asar`;
const out = [];
let fails = 0;
const ok = (c, m) => { if (!c) fails++; out.push(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

if (!existsSync(A)) { console.error(`no build at ${A} — run npm run build first`); process.exit(2); }

const list = asar.listPackage(A).map(p => p.replace(/\\/g, '/'));
const pkg = JSON.parse(asar.extractFile(A, 'package.json').toString());
const src = JSON.parse(readFileSync(`${APP}/package.json`, 'utf8'));
ok(pkg.version === src.version, `asar package.json version ${pkg.version} (repo ${src.version}), ${list.length} entries`);

// licence: bytecode only, no key material, no dev folders
const lic = list.filter(p => p.startsWith('/electron/license/'));
ok(lic.length > 0 && lic.every(p => !p.endsWith('.js')), `licence module: ${lic.length} files, none .js (${lic.map(p => p.split('/').pop()).join(', ')})`);
ok(!list.some(p => /sbs_license|sbs_private|\.key$|issued/i.test(p)), 'no key material / issuer in the asar');
ok(!list.some(p => p.startsWith('/tests/') || p.startsWith('/tools/') || p.startsWith('/robot/') || p.startsWith('/saves/')), 'no tests/ tools/ robot/ saves/ in the asar');

// assets that features depend on at runtime
const need = ['/assets/hands/sbs-hand.fbx', '/vendor/three-addons/N8AO.js', '/vendor/three.min.js', '/src/main.js', '/electron/preload.js'];
for (const p of need) ok(list.includes(p), `asar has ${p}`);
ok(list.some(p => p.startsWith('/assets/hdri/') && p.endsWith('.hdr')), 'asar has assets/hdri/*.hdr');

// narration engine: the vendored kokoro must not carry the stub env (CPU-only trap)
const kok = asar.extractFile(A, 'vendor/kokoro.web.js').toString();
ok(!/\{set wasmPaths\(\w+\)\{\w+\.backends\.onnx\.wasm\.wasmPaths=/.test(kok), 'kokoro.web.js: stub env patched out (GPU narration engine live)');

// native modules beside the asar
const sharpDir = `${UNP}/app.asar.unpacked/node_modules/@img`;
const sharpPkgs = existsSync(sharpDir) ? readdirSync(sharpDir).filter(d => d.startsWith('sharp-win32')) : [];
const sharpV = sharpPkgs.length ? JSON.parse(readFileSync(`${sharpDir}/${sharpPkgs[0]}/package.json`, 'utf8')).version : null;
const semverGte = (a, b) => { const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); } return true; };
ok(sharpV && semverGte(sharpV, '0.35.4'), `sharp native ${sharpPkgs[0] || '(none)'} ${sharpV} (≥ 0.35.4, the libheif advisory)`);   // numeric, not string: '0.35.10' >= '0.35.4'

// extraResources
ok(existsSync(`${UNP}/manual/SBS-Manual.pdf`) && existsSync(`${UNP}/manual/SBS-Manual.html`), `manual resources: ${existsSync(`${UNP}/manual`) ? readdirSync(`${UNP}/manual`).join(', ') : 'MISSING'}`);
ok(existsSync(`${UNP}/ffmpeg/ffmpeg.exe`), 'ffmpeg/ffmpeg.exe shipped (subfolder — the old check looked at resources/ffmpeg.exe)');
ok(existsSync(`${UNP}/kokoro-bundle`), 'kokoro-bundle shipped');
ok(existsSync(`${UNP}/native`), 'native/ shipped (placeholder → WASM fallback is deliberate)');

const exes = readdirSync(`${APP}/dist`).filter(f => f.endsWith('.exe')).map(f => ({ f, mb: (statSync(`${APP}/dist/${f}`).size / 1e6).toFixed(0), t: statSync(`${APP}/dist/${f}`).mtime.toISOString().slice(0, 16) }));
out.push(...exes.map(e => `     ${e.f}  ${e.mb} MB  ${e.t}`));
console.log(out.join('\n'));
console.log(fails ? `verify-build: ${fails} FAIL` : 'verify-build: all OK');
process.exit(fails ? 1 : 0);
