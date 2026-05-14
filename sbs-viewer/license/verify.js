'use strict';

/**
 * SBS Viewer license verifier
 * ===========================
 * Ed25519 signature verification. Payload schema differs from the
 * authoring app (sbs-app/electron/license/verify.js):
 *
 *   payload v: 10               ← '10' identifies viewer flavour
 *   company_id: string          ← baked per-install, see ../company.js
 *   email:      string          ← user-typed at activation
 *   exp:        'YYYY-MM-DD'
 *   mode:       'station' | 'manager'
 *   machine_id: string | null   ← REQUIRED for mode='manager', ignored for 'station'
 *
 * Canonical signed string:
 *   "{v}|{company_id}|{email}|{exp}|{mode}|{machine_id ?? ''}"
 *
 * Same Ed25519 keypair as authoring (one private key on dev machine,
 * different public-key string baked into each app — actually, SAME public
 * key string, since the same private key signs both. The payload version
 * (`v`) is what tells the verifier which app the license belongs to;
 * cross-app reuse fails the `v` check).
 *
 * The keypair is generated once by `sbs_license/keygen.py --init-keys`.
 * Public key copy lives in PUBLIC_KEY_B64 below; private key never leaves
 * `~/.sbs_license/keys/sbs_private.key`.
 */

const crypto = require('node:crypto');
const { safeToday } = require('./time-monitor');

// ── Public key (paste from sbs_license/keygen.py --init-keys output) ────
// Must be identical to sbs-app/electron/license/verify.js and
// sbs_license/license_core.py — they all verify against the same key.
const PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAaY0FkCBVq4fpJuRvVoz2kLP6hU5obvFlvZ+t6/D/9Bc=';

const PAYLOAD_VERSION = 10;

// Days of grace shown as a "renew soon" toast at boot. After expiry,
// hard-lock (no grace beyond it — different from authoring's 3-day cushion).
const GRACE_DAYS = 7;

function _canonicalSignedString(company_id, email, expiry, mode, machine_id) {
  return `${PAYLOAD_VERSION}|${company_id}|${email}|${expiry}|${mode}|${machine_id || ''}`;
}

/**
 * Decode the user-facing key blob back into { payload, signature }.
 * Same JSON-terminator strategy as authoring v2 — first `}` is the end
 * of the flat JSON payload; signature follows after `|`. The signature
 * is raw binary and may itself contain `|` bytes, so splitting on the
 * last `|` (rpartition) is buggy.
 */
function _decodeKeyBlob(key) {
  const padded = key + '='.repeat((4 - (key.length % 4)) % 4);
  const raw = Buffer.from(padded, 'base64url');
  const jsonEnd = raw.indexOf(0x7d /* '}' */);
  if (jsonEnd < 0) throw new Error('Malformed key: no JSON terminator');
  if (raw[jsonEnd + 1] !== 0x7c /* '|' */) {
    throw new Error('Malformed key: missing separator after JSON');
  }
  const payloadJson = raw.subarray(0, jsonEnd + 1).toString('utf8');
  const signature   = raw.subarray(jsonEnd + 2);
  const payload     = JSON.parse(payloadJson);
  return { payload, signature };
}

function _daysUntil(yyyy_mm_dd) {
  // Uses safeToday() (max of system date + last-seen high-water mark) so a
  // system-clock rollback can't extend an expired license. See
  // time-monitor.js for the rationale.
  const [ey, em, ed] = yyyy_mm_dd.split('-').map(Number);
  const expiryMs = Date.UTC(ey, em - 1, ed);
  const [ty, tm, td] = safeToday().split('-').map(Number);
  const todayMs  = Date.UTC(ty, tm - 1, td);
  return Math.round((expiryMs - todayMs) / 86_400_000);
}

/**
 * Verify a (companyId, email, key, machineId, installMode) tuple.
 *
 * @param {object} input
 * @param {string} input.companyId   from company.js (baked constant)
 * @param {string} input.email       user-typed in activation dialog
 * @param {string} input.key         long base64 blob
 * @param {string} input.machineId   current hardware fingerprint
 * @param {'station'|'manager'} input.installMode   from userData (set at install time)
 *
 * @returns {{
 *   valid: boolean,
 *   reason?: string,
 *   companyId?: string, email?: string, expiry?: string,
 *   daysRemaining?: number, gracePeriodActive?: boolean,
 *   licenseMode?: 'station'|'manager',
 * }}
 */
function validateLicense({ companyId, email, key, machineId, installMode }) {
  if (PUBLIC_KEY_B64 === 'REPLACE_WITH_YOUR_PUBLIC_KEY') {
    return { valid: false, reason: 'NOT_CONFIGURED' };
  }

  const inputCompany = (companyId || '').trim();
  const e = (email   || '').trim().toLowerCase();
  const k = (key     || '').replace(/\s+/g, '');
  const m = (machineId || '').trim().toUpperCase();
  const installM = (installMode === 'manager') ? 'manager' : 'station';

  if (!inputCompany || inputCompany === '__DEV__') {
    return { valid: false, reason: 'NOT_CONFIGURED' };
  }
  if (!e || !k) return { valid: false, reason: 'MISSING_INPUT' };

  // ── Decode key ─────────────────────────────────────────────────────
  let payload, signature;
  try {
    ({ payload, signature } = _decodeKeyBlob(k));
  } catch {
    return { valid: false, reason: 'MALFORMED_KEY' };
  }

  if (payload?.v !== PAYLOAD_VERSION) {
    return { valid: false, reason: 'VERSION_MISMATCH' };
  }

  const pCompany   = String(payload.company_id || '').trim();
  const pEmail     = String(payload.email || '').toLowerCase();
  const pExp       = String(payload.exp || '');
  const pMode      = (payload.mode === 'manager') ? 'manager' : 'station';
  const pMachineId = String(payload.machine_id || '').toUpperCase();

  // ── Company binding ───────────────────────────────────────────────
  if (pCompany !== inputCompany) {
    return { valid: false, reason: 'COMPANY_MISMATCH' };
  }
  // ── Email match ───────────────────────────────────────────────────
  if (pEmail !== e) {
    return { valid: false, reason: 'EMAIL_MISMATCH' };
  }

  // ── Signature verification ────────────────────────────────────────
  let publicKeyObj;
  try {
    const pubDer = Buffer.from(PUBLIC_KEY_B64, 'base64');
    publicKeyObj = crypto.createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
  } catch {
    return { valid: false, reason: 'BAD_PUBLIC_KEY' };
  }

  const signedData = Buffer.from(
    _canonicalSignedString(pCompany, pEmail, pExp, pMode, pMachineId),
    'utf8',
  );
  let sigOk = false;
  try {
    sigOk = crypto.verify(null, signedData, publicKeyObj, signature);
  } catch {
    return { valid: false, reason: 'INVALID_SIGNATURE' };
  }
  if (!sigOk) {
    return { valid: false, reason: 'INVALID_SIGNATURE' };
  }

  // ── Mode-specific gates ───────────────────────────────────────────
  if (pMode === 'manager') {
    // Manager licenses are bound to a specific machine.
    if (!pMachineId) {
      return { valid: false, reason: 'MALFORMED_KEY' };
    }
    if (pMachineId !== m) {
      return { valid: false, reason: 'MACHINE_MISMATCH' };
    }
  }
  // Refuse to run as manager if the license only authorises station.
  // Caller (renderer) will degrade UI to station mode in this case.
  const effectiveMode = (installM === 'manager' && pMode === 'manager')
    ? 'manager'
    : 'station';

  // ── Expiry ────────────────────────────────────────────────────────
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pExp)) {
    return { valid: false, reason: 'MALFORMED_KEY' };
  }
  const daysRemaining = _daysUntil(pExp);
  if (daysRemaining < 0) {
    return {
      valid: false, reason: 'EXPIRED',
      companyId: pCompany, email: pEmail, expiry: pExp,
      daysRemaining, licenseMode: pMode,
    };
  }

  return {
    valid: true,
    companyId:        pCompany,
    email:            pEmail,
    expiry:           pExp,
    daysRemaining,
    licenseMode:      pMode,        // what the license authorises
    effectiveMode,                   // what the renderer should run as
    gracePeriodActive: daysRemaining <= GRACE_DAYS,
  };
}

module.exports = { validateLicense, PAYLOAD_VERSION, GRACE_DAYS };
