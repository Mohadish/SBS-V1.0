/**
 * SBS License Verifier (JS) — v2 model
 * =====================================
 * JS port of sbs_license/license_core.py. Runs in the Electron MAIN
 * process (Node side), reachable from the renderer only via IPC.
 *
 * Inputs the user types in the activation dialog:
 *   email   — their address
 *   password — short string from developer (XXXX-XXXX)
 *   key      — long base64 string from developer
 *
 * App-extracted at validate time:
 *   machine_id — sha256-of-hardware hash (see machine-id.js)
 *
 * The verifier reconstructs the signed canonical string
 *   "{email}|{mid}|{exp}|{password}"
 * decodes the key blob to recover { payload, signature }, and verifies
 * the signature with the embedded public key. Any mismatch in any of
 * the 4 input strings → verification fails.
 *
 * MUST stay in sync with sbs_license/license_core.py — same payload
 * format, same canonical string, same Ed25519 algorithm. Tests in
 * tests/license-roundtrip.js confirm Python → JS round-trip.
 */

const crypto = require('node:crypto');

// ── Public key embedded in the app ───────────────────────────────────────
// Paste the same string as sbs_license/license_core.py here after
// running keygen.py --init-keys. Both files MUST hold identical values.
const PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAaY0FkCBVq4fpJuRvVoz2kLP6hU5obvFlvZ+t6/D/9Bc=';

const PAYLOAD_VERSION = 2;

// Grace window: this many days BEFORE expiry, app shows a warning
// toast at boot but still runs. AFTER expiry, hard-lock.
const GRACE_DAYS = 3;

/**
 * Build the exact string that gets signed. Must produce byte-identical
 * output to license_core.canonical_signed_string in Python.
 */
function _canonicalSignedString(email, machineId, expiry, password) {
  return `${email}|${machineId}|${expiry}|${password}`;
}

/**
 * Decode the user-facing key string back into { payload, signature }.
 * @returns {{ payload: object, signature: Buffer }}
 * @throws Error on malformed input.
 */
function _decodeKeyBlob(key) {
  // urlsafe base64 — may be missing trailing '=' padding (keygen strips it).
  const padded = key + '='.repeat((4 - (key.length % 4)) % 4);
  const raw = Buffer.from(padded, 'base64url');
  // The v2 payload is a flat JSON object with no nesting and no string
  // values containing '}' (email/date/hex/int only), so the FIRST '}' is
  // unambiguously the end of the JSON. We can't split on '|' because the
  // raw 64-byte Ed25519 signature that follows can contain '|' bytes (0x7c)
  // anywhere — using lastIndexOf would land inside the signature.
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

/**
 * Days between two YYYY-MM-DD date strings (positive = expiry in future,
 * negative = past). Uses UTC midnight to avoid timezone-edge weirdness.
 */
function _daysUntil(yyyy_mm_dd) {
  const [y, m, d] = yyyy_mm_dd.split('-').map(Number);
  const expiryMs = Date.UTC(y, m - 1, d);
  const now = new Date();
  const todayMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((expiryMs - todayMs) / 86_400_000);
}

/**
 * Verify a (email, password, key, machineId) tuple.
 *
 * @param {object} input
 * @param {string} input.email
 * @param {string} input.password
 * @param {string} input.key
 * @param {string} input.machineId
 * @returns {{
 *   valid:       boolean,
 *   reason?:     string,           // when invalid
 *   email?:      string,
 *   machineId?:  string,
 *   expiry?:     string,           // YYYY-MM-DD
 *   daysRemaining?: number,
 *   gracePeriodActive?: boolean,   // within GRACE_DAYS of expiry
 *   hardLocked?: boolean,          // expired beyond grace → refuse launch
 * }}
 */
function validateLicense({ email, password, key, machineId }) {
  if (PUBLIC_KEY_B64 === 'REPLACE_WITH_YOUR_PUBLIC_KEY') {
    return {
      valid: false,
      reason: 'NOT_CONFIGURED',
      hardLocked: true,
      message:
        'This SBS build was not configured with a public key. ' +
        'Contact your distributor.',
    };
  }

  // Normalise inputs the same way the Python keygen normalises.
  // For the key, strip ALL whitespace (terminals can wrap long lines on
  // copy, embedding stray spaces/newlines that break base64 decode).
  const e = (email    || '').trim().toLowerCase();
  const p = (password || '').trim();
  const k = (key      || '').replace(/\s+/g, '');
  const m = (machineId|| '').trim().toUpperCase();

  if (!e || !p || !k || !m) {
    return { valid: false, reason: 'MISSING_INPUT', hardLocked: true };
  }

  // ── Decode key ─────────────────────────────────────────────────────
  let payload, signature;
  try {
    ({ payload, signature } = _decodeKeyBlob(k));
  } catch {
    return { valid: false, reason: 'MALFORMED_KEY', hardLocked: true };
  }

  if (payload?.v !== PAYLOAD_VERSION) {
    return { valid: false, reason: 'VERSION_MISMATCH', hardLocked: true };
  }

  const pEmail = String(payload.email || '').toLowerCase();
  const pMid   = String(payload.mid   || '').toUpperCase();
  const pExp   = String(payload.exp   || '');

  // ── Identifier match ───────────────────────────────────────────────
  if (pEmail !== e) {
    return { valid: false, reason: 'EMAIL_MISMATCH', hardLocked: true };
  }
  if (pMid !== m) {
    return { valid: false, reason: 'MACHINE_MISMATCH', hardLocked: true };
  }

  // ── Signature verification ─────────────────────────────────────────
  // The signing key is Ed25519 in DER (SubjectPublicKeyInfo) format —
  // same as what cryptography.hazmat produces on the Python side. Node's
  // built-in crypto handles this natively with no external dependency.
  let publicKeyObj;
  try {
    const pubDer = Buffer.from(PUBLIC_KEY_B64, 'base64');
    publicKeyObj = crypto.createPublicKey({
      key: pubDer,
      format: 'der',
      type: 'spki',
    });
  } catch (err) {
    return { valid: false, reason: 'BAD_PUBLIC_KEY', hardLocked: true };
  }

  const signedData = Buffer.from(
    _canonicalSignedString(pEmail, pMid, pExp, p),
    'utf8',
  );

  // crypto.verify with algorithm=null → Node infers from the key type
  // (Ed25519 doesn't take a hash algorithm — the algorithm field must
  // be null, not 'sha256').
  let sigOk = false;
  try {
    sigOk = crypto.verify(null, signedData, publicKeyObj, signature);
  } catch {
    return { valid: false, reason: 'INVALID_SIGNATURE', hardLocked: true };
  }
  if (!sigOk) {
    return { valid: false, reason: 'INVALID_SIGNATURE', hardLocked: true };
  }

  // ── Expiry ─────────────────────────────────────────────────────────
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pExp)) {
    return { valid: false, reason: 'MALFORMED_KEY', hardLocked: true };
  }
  const daysRemaining = _daysUntil(pExp);

  if (daysRemaining < 0) {
    return {
      valid: false,
      reason: 'EXPIRED',
      hardLocked: true,
      expiry: pExp,
      daysRemaining,
      email: pEmail,
    };
  }

  return {
    valid: true,
    email: pEmail,
    machineId: pMid,
    expiry: pExp,
    daysRemaining,
    // Grace window — informational. App still runs; UI shows a warning
    // toast at boot.
    gracePeriodActive: daysRemaining <= GRACE_DAYS,
    hardLocked: false,
  };
}

module.exports = {
  validateLicense,
  PAYLOAD_VERSION,
  GRACE_DAYS,
};
