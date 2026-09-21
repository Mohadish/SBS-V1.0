#!/usr/bin/env node
/**
 * license-roundtrip — do the keygen and the app still speak the same language?
 *
 * A licence is ISSUED by Python (sbs_license/keygen.py + license_core.py) and
 * CHECKED by JavaScript (electron/license/verify.js). The two were written to
 * match and nothing ever checked that they still do. If they drift — a field
 * renamed, the canonical string reordered, the blob encoded differently — no
 * test fails and no build breaks: every NEW licence simply stops activating,
 * and the first person to find out is a customer who has just paid.
 *
 *   node tests/license-roundtrip.js        (npm run test:license)
 *   npm run build runs it first, so a drift cannot reach an installer.
 *
 * HOW, WITHOUT TOUCHING THE REAL KEY. The Python half (license-roundtrip-
 * issue.py) runs keygen's own cmd_issue() with a THROWAWAY key made in memory,
 * so the output is a genuine issued licence in every respect but the signer.
 * This half then takes it apart with the app's REAL decoder and rebuilds the
 * signed string with the app's REAL canonicaliser, and checks the signature
 * against the throwaway public key. What that cannot cover — that the app
 * carries the RIGHT public key — is checked separately, two ways: the constant
 * must be identical in both source files, and the licence already on this
 * machine (issued by the real keygen) must still verify under it.
 *
 * verify.js exposes NO way to swap its public key, on purpose: a verifier
 * whose key can be overridden is a verifier anyone can pass.
 *
 * No Python / no `cryptography` here? The Python half is SKIPPED with a notice
 * and the JS-only checks still run — a build is not hostage to Python.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs     = require('node:fs');
const path   = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

// verify.js pulls in time-monitor → electron. There is no Electron here, and
// none is needed: only the pure halves of the verifier are used.
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return { app: { getPath: () => require('node:os').tmpdir() } };
  return origLoad.call(this, req, ...rest);
};
const verify = require(path.join(ROOT, 'electron', 'license', 'verify.js'));
const { decodeKeyBlob, canonicalSignedString, PUBLIC_KEY_B64 } = verify._internals;
Module._load = origLoad;

let pass = 0, fail = 0, skipped = 0;
const ok   = (name) => { pass++; console.log(`  ok    ${name}`); };
const bad  = (name, why) => { fail++; console.log(`  FAIL  ${name}\n        ${why}`); };
const check = (name, cond, why) => (cond ? ok(name) : bad(name, why));
const same  = (name, got, want) => check(name, got === want, `got      ${JSON.stringify(got)}\n        expected ${JSON.stringify(want)}`);
const pubKey = (b64) => crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });

// ── 1. a licence issued by the REAL keygen code, signed by a throwaway key ──
console.log('\nkeygen (Python)  →  verifier (JS)');
let issued = null;
try {
  const out = execFileSync('python', [path.join(__dirname, 'license-roundtrip-issue.py')],
    { encoding: 'utf8', timeout: 60000, windowsHide: true });
  issued = JSON.parse(out.trim().split(/\r?\n/).pop());
} catch (err) {
  issued = { skip: `could not run python: ${String(err.message || err).split('\n')[0]}` };
}

if (issued.skip || issued.error) {
  skipped++;
  console.log(`  SKIP  the Python half — ${issued.skip || issued.error}`);
  console.log('        (install Python + "pip install cryptography" to run it; the checks below still apply)');
} else {
  let payload, signature;
  try { ({ payload, signature } = decodeKeyBlob(issued.key.replace(/\s+/g, ''))); ok('the app decodes the key blob keygen produced'); }
  catch (e) { bad('the app decodes the key blob keygen produced', e.message); }

  if (payload) {
    same('payload.v is the version the app accepts', payload.v, verify.PAYLOAD_VERSION);
    same('payload.email — lower-cased by keygen', payload.email, issued.email_typed.toLowerCase());
    same('payload.mid — upper-cased by keygen', payload.mid, issued.machine_id_typed.toUpperCase());
    same('payload.exp', payload.exp, issued.expiry);
    check('payload.exp is YYYY-MM-DD, as the app requires', /^\d{4}-\d{2}-\d{2}$/.test(payload.exp), `got ${payload.exp}`);
    same('signature is 64 bytes of Ed25519', signature.length, 64);

    // THE line that must never drift: what Python signed vs what JS rebuilds.
    const rebuilt = canonicalSignedString(String(payload.email).toLowerCase(), String(payload.mid).toUpperCase(), String(payload.exp), issued.password);
    same('the canonical signed string is byte-identical on both sides', rebuilt, issued.canonical);

    const vfy = (s) => { try { return crypto.verify(null, Buffer.from(s, 'utf8'), pubKey(issued.throwaway_public_key_b64), signature); } catch { return false; } };
    check('the signature verifies over the string the APP rebuilds', vfy(rebuilt), 'Ed25519 verify returned false');
    check('…and a wrong password is refused', !vfy(canonicalSignedString(payload.email, payload.mid, payload.exp, issued.password + 'x')), 'a tampered password still verified');
    check('…and a later expiry is refused', !vfy(canonicalSignedString(payload.email, payload.mid, '2099-01-01', issued.password)), 'a tampered expiry still verified');
    check('…and another machine is refused', !vfy(canonicalSignedString(payload.email, '0'.repeat(32), payload.exp, issued.password)), 'a tampered machine id still verified');
  }

  same('PAYLOAD_VERSION: keygen.py = license_core.py', issued.keygen_payload_version, issued.core_payload_version);
  same('PAYLOAD_VERSION: license_core.py = verify.js', issued.core_payload_version, verify.PAYLOAD_VERSION);
  same('PUBLIC KEY: license_core.py = verify.js', issued.core_public_key_b64, PUBLIC_KEY_B64);

  // same hardware, same recipe → same ID. (Python asks wmic only; where wmic
  // is gone it falls back and this is expected to differ — not a failure.)
  if (issued.machine_id_here && process.platform === 'win32') {
    let jsMid = '';
    try { jsMid = require(path.join(ROOT, 'electron', 'license', 'machine-id.js')).getMachineId(); } catch { /* reported below */ }
    let wmic = true; try { execFileSync('wmic', ['os', 'get', 'Version'], { stdio: 'ignore', timeout: 8000, windowsHide: true }); } catch { wmic = false; }
    if (wmic) same('machine ID: Python helper = the app, on this machine', issued.machine_id_here, jsMid);
    else { skipped++; console.log('  SKIP  machine ID parity — wmic is not installed here, so the Python helper falls back (the app does not)'); }
  }
}

// ── 2. the app carries a public key that is well-formed ──
console.log('\nthe public key in the app');
try { const k = pubKey(PUBLIC_KEY_B64); same('verify.js PUBLIC_KEY_B64 is a valid Ed25519 SPKI key', k.asymmetricKeyType, 'ed25519'); }
catch (e) { bad('verify.js PUBLIC_KEY_B64 is a valid Ed25519 SPKI key', e.message); }
{ // …and matches the Python source, read as TEXT so this runs without Python too
  const core = path.resolve(ROOT, '..', 'sbs_license', 'license_core.py');
  if (fs.existsSync(core)) {
    const m = /^PUBLIC_KEY_B64\s*:\s*str\s*=\s*"([^"]*)"/m.exec(fs.readFileSync(core, 'utf8'));
    same('PUBLIC KEY: license_core.py (source text) = verify.js', m && m[1], PUBLIC_KEY_B64);
  } else { skipped++; console.log('  SKIP  sbs_license/ is not next to this checkout'); }
}

// ── 3. a licence the REAL keygen issued still verifies under that key ──
console.log('\na real licence, issued by the real keygen');
{
  const file = path.join(process.env.APPDATA || '', 'sbs-step-browser', 'license.json');
  let lic = null; try { lic = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none here */ }
  if (!lic?.key) { skipped++; console.log('  SKIP  no licence on this machine'); }
  else {
    try {
      const { payload, signature } = decodeKeyBlob(String(lic.key).replace(/\s+/g, ''));
      const s = canonicalSignedString(String(payload.email).toLowerCase(), String(payload.mid).toUpperCase(), String(payload.exp), String(lic.password).trim());
      check("this machine's licence verifies under the app's public key (expiry aside)",
        crypto.verify(null, Buffer.from(s, 'utf8'), pubKey(PUBLIC_KEY_B64), signature),
        'the signature does NOT verify — the app and the keygen no longer agree, or the key in verify.js is not the one licences are signed with');
    } catch (e) { bad("this machine's licence parses", e.message); }
  }
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
if (fail) console.log('\n✖ The keygen and the app disagree. Licences issued now may not activate. Do not ship this build.');
process.exit(fail ? 1 : 0);
