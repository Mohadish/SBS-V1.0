'use strict';

/**
 * SBS Viewer — persistent store
 * =============================
 * Holds TWO files in userData:
 *
 *   license.json   { v: 10, email, key, activated }      ← active license
 *   install.json   { mode: 'station'|'manager' }         ← install mode (set at install time)
 *
 * Plain JSON, not encrypted — the decryption key would have to ship in
 * the app, so it would buy nothing. The Ed25519 signature on the license
 * itself is the integrity check; tampering yields a signature failure on
 * next boot, which kicks the user back to the activation dialog.
 *
 * `install.json` is written ONCE — either by the NSIS installer (if it
 * passes the chosen mode via a known mechanism) or on first launch
 * (default station; user can switch in settings). Survives reinstall.
 */

const { app } = require('electron');
const fs      = require('node:fs');
const path    = require('node:path');

const LICENSE_FILENAME = 'license.json';
const INSTALL_FILENAME = 'install.json';

function _licensePath() {
  return path.join(app.getPath('userData'), LICENSE_FILENAME);
}
function _installPath() {
  return path.join(app.getPath('userData'), INSTALL_FILENAME);
}

/** Load saved license; returns null when absent, unreadable, or wrong version. */
function loadLicense() {
  try {
    const raw = fs.readFileSync(_licensePath(), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && obj.v === 10) return obj;
  } catch {}
  return null;
}

function saveLicense({ email, key }) {
  const data = {
    v:         10,
    email:     String(email).trim().toLowerCase(),
    key:       String(key).trim(),
    activated: new Date().toISOString(),
  };
  const target = _licensePath();
  const tmp    = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  return data;
}

function clearLicense() {
  try { fs.unlinkSync(_licensePath()); } catch {}
}

// ── Install-mode persistence ────────────────────────────────────────────

/**
 * Default mode is 'station' (read-only, no builder UI). The user can
 * upgrade to 'manager' from settings, but the license must authorise it
 * — `verify.js` returns `effectiveMode='station'` when the license is
 * station-only, regardless of what the install file says.
 */
function loadInstallMode() {
  try {
    const raw = fs.readFileSync(_installPath(), 'utf8');
    const obj = JSON.parse(raw);
    if (obj?.mode === 'manager') return 'manager';
  } catch {}
  return 'station';
}

function saveInstallMode(mode) {
  const m = (mode === 'manager') ? 'manager' : 'station';
  const target = _installPath();
  const tmp    = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ mode: m }, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  return m;
}

module.exports = {
  loadLicense, saveLicense, clearLicense,
  loadInstallMode, saveInstallMode,
  _licensePath, _installPath,
};
