/**
 * SBS license store (JS)
 * ======================
 * Persists the activated license to userData/license.json on disk.
 * Format (plain JSON, NOT encrypted — encrypting buys nothing because
 * the decryption key would have to ship in the app):
 *
 *   {
 *     "v": 2,
 *     "email":       "alice@example.com",
 *     "password":    "ABCD-EFGH",
 *     "key":         "<long base64>",
 *     "activated":   "2025-05-13T10:00:00.000Z",
 *     "hwm":         { "ms": 1790000000000, "mac": "<hex>" }
 *   }
 *
 * `hwm` is the clock high-water mark — written and verified by
 * time-monitor.js, not here (it is signed with a key derived from `key` and
 * the machine ID). It lives in THIS file on purpose: the app cannot run
 * without license.json, so the mark cannot be deleted without deactivating.
 * saveLicense() rewrites the file without it; index.js reads the mark first
 * and signs it again afterwards, so an activation never resets it.
 *
 * The integrity check on these fields is the verify.js signature
 * verification — tampering with the file just causes signature failure
 * on next boot, which kicks the user back to the activation dialog.
 */

const { app } = require('electron');
const fs      = require('node:fs');
const path    = require('node:path');

const LICENSE_FILENAME = 'license.json';

function _licensePath() {
  // app.getPath('userData') resolves to:
  //   Win   : %APPDATA%/<appName>/
  //   macOS : ~/Library/Application Support/<appName>/
  //   Linux : ~/.config/<appName>/
  // Survives uninstall/reinstall by default (deleteAppDataOnUninstall=false).
  return path.join(app.getPath('userData'), LICENSE_FILENAME);
}

/**
 * Load any previously-saved license. Returns null if the file is
 * absent, unreadable, or malformed — callers treat that as "needs
 * first-launch activation".
 */
function loadLicense() {
  try {
    const raw = fs.readFileSync(_licensePath(), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && obj.v === 2) return obj;
  } catch {}
  return null;
}

/**
 * Persist the activated license to disk. Atomic write (write to .tmp
 * then rename) so a crash mid-write doesn't corrupt the existing file.
 */
function saveLicense({ email, password, key }) {
  const data = {
    v: 2,
    email:    String(email).trim().toLowerCase(),
    password: String(password).trim(),
    key:      String(key).trim(),
    activated: new Date().toISOString(),
  };
  const target = _licensePath();
  const tmp    = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  return data;
}

/**
 * Delete the saved license. Used when the user clicks "Sign out" or
 * by the developer for testing the activation flow.
 */
function clearLicense() {
  try { fs.unlinkSync(_licensePath()); } catch {}
}

module.exports = { loadLicense, saveLicense, clearLicense, _licensePath };
