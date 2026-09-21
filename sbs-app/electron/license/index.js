/**
 * SBS license IPC bridge
 * =======================
 * Registers the main-process IPC handlers that the renderer calls
 * through the `window.sbsNative.license.*` API (see preload.js).
 *
 * Five entry points:
 *   license:getMachineId    → returns this machine's 32-hex ID
 *   license:status          → returns current license status (loads from disk)
 *   license:validate        → DOES NOT persist — just runs the verifier
 *                             over a tuple (used by the activation dialog
 *                             for live validation before clicking Save)
 *   license:activate        → verifies + persists on success
 *   license:deactivate      → wipes the on-disk license (forces re-activation)
 *
 * Status return shape (used by renderer to decide what UI to show):
 *   { state: 'unactivated' | 'valid' | 'grace' | 'expired',
 *     email?, machineId, expiry?, daysRemaining?, reason? }
 */

const { ipcMain } = require('electron');
// Extensions OMITTED so the resolver picks .js in dev, .jsc in production.
// See scripts/build-bytenode.js for the build-time compilation flow.
const { validateLicense }      = require('./verify');
const { getMachineIdCached, getMachineIdCandidates } = require('./machine-id');
const { loadLicense, saveLicense, clearLicense } = require('./store');

/**
 * Verify a licence against THIS MACHINE — under any name it can truthfully
 * answer to (see machine-id.js). The strongest ID is tried first and is the
 * only one the ordinary boot ever computes; the older names are consulted
 * only when that one says MACHINE_MISMATCH, which is exactly the case of a
 * licence issued while the machine was being read less well than it is now.
 *
 * `legacyBinding` on the result says the licence held, but only under an
 * older name — worth telling the user, because that name is the fragile one.
 */
function _validateOnThisMachine({ email, password, key }) {
  const primary = getMachineIdCached();
  const first = validateLicense({ email, password, key, machineId: primary });
  if (first.valid || first.reason !== 'MACHINE_MISMATCH') return first;
  for (const machineId of getMachineIdCandidates().slice(1)) {
    const r = validateLicense({ email, password, key, machineId });
    if (r.valid) return { ...r, legacyBinding: true };
  }
  return first;      // none of them: report the mismatch against the ID we show
}

/**
 * Translate a verifier result + on-disk presence into the higher-level
 * status the renderer reasons about.
 */
function _computeStatus() {
  const machineId = getMachineIdCached();
  const saved     = loadLicense();

  if (!saved) {
    return { state: 'unactivated', machineId };
  }

  const result = _validateOnThisMachine(saved);

  if (result.valid) {
    return {
      state:         result.gracePeriodActive ? 'grace' : 'valid',
      machineId,
      email:         result.email,
      expiry:        result.expiry,
      daysRemaining: result.daysRemaining,
      ...(result.legacyBinding ? { legacyBinding: true } : {}),
    };
  }

  // Saved but verifier rejected it — treat as expired/invalid and
  // funnel back to the activation dialog. The renderer surfaces
  // result.reason so the user can see WHY it failed.
  return {
    state:         result.reason === 'EXPIRED' ? 'expired' : 'unactivated',
    machineId,
    email:         saved.email,
    expiry:        result.expiry,
    daysRemaining: result.daysRemaining,
    reason:        result.reason,
  };
}

// ─── THE AUTHORITY LIVES HERE, IN THE MAIN PROCESS ─────────────────────────
//
// The activation dialog is drawn by the renderer, and the renderer is the one
// place a user can reach into: with DevTools open the dialog can simply be
// removed from the page. While the renderer was also the only thing DECIDING
// whether the app may run, removing the dialog was the whole crack.
//
// So the verdict is held here, and the app's own IPC is refused while it is
// "no". A dismissed dialog then leaves a window that cannot open a project,
// save one, export, speak or convert CAD — every one of those goes through a
// handler below the gate. DevTools can stay available for support work (the
// console diagnostics depend on it) because it no longer unlocks anything.
//
// This file is bytenode-compiled in production, so the decision is not sitting
// in readable JavaScript either. It does not stop someone who unpacks the asar
// and rewrites main.js — nothing offline does — but that is a different class
// of person from one who presses Ctrl+Shift+I.
let _ok = false;
let _checkedAt = 0;
const RECHECK_MS = 30 * 60 * 1000;   // an app left running across its expiry must notice

function _refresh() {
  const s = _computeStatus();
  _ok = (s.state === 'valid' || s.state === 'grace');
  _checkedAt = Date.now();
  return s;
}

/** May the app's own IPC be served right now? Fails CLOSED on any error. */
function isLicensed() {
  if (Date.now() - _checkedAt > RECHECK_MS) {
    try { _refresh(); } catch (err) { _ok = false; console.warn('[license] check failed:', err?.message); }
  }
  return _ok;
}

/**
 * Put every ipcMain.handle() behind the verdict — ONE choke point, installed
 * before the first handler is registered, so a handler added next year is
 * covered without anyone remembering to. license:* stays open: those are the
 * calls the activation dialog itself is made of.
 *
 * Only handle() is gated. The on() channels are one-way notes FROM the
 * renderer (dirty flag, save result, key map) — they hand nothing back, and
 * wrapping them would break removeListener, which matches by function identity.
 */
// Served without a licence. license:* is what the activation dialog is made
// of; help:* is the manual — reading it is not a licensed act, and its one
// call only writes the manual to a path the user picked. Keep this list SHORT:
// every prefix here is a door in the wall.
const _OPEN_CHANNELS = ['license:', 'help:'];

function installIpcGate() {
  if (ipcMain.__sbsGated) return;
  ipcMain.__sbsGated = true;
  const raw = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => raw(channel, (event, ...args) => {
    if (!_OPEN_CHANNELS.some(p => String(channel).startsWith(p)) && !isLicensed()) {
      throw new Error('SBS is not activated.');
    }
    return fn(event, ...args);
  });
}

function registerLicenseIpc() {
  try { _refresh(); } catch (err) { _ok = false; console.warn('[license] first check failed:', err?.message); }

  ipcMain.handle('license:getMachineId', () => {
    return getMachineIdCached();
  });

  ipcMain.handle('license:status', () => {
    return _refresh();          // every status read re-decides the verdict
  });

  ipcMain.handle('license:validate', (_event, { email, password, key }) => {
    // Live-validate without persisting. Renderer's activation dialog
    // uses this to gate the Save button.
    return _validateOnThisMachine({ email, password, key });
  });

  ipcMain.handle('license:activate', (_event, { email, password, key }) => {
    // a customer re-entering a key issued under this machine's older name
    // must not be turned away by the app having learned a better one
    const result = _validateOnThisMachine({ email, password, key });
    if (!result.valid) return result;
    saveLicense({ email, password, key });
    _refresh();                 // re-verified FROM DISK — the same path a boot takes
    return { ...result, persisted: true };
  });

  ipcMain.handle('license:deactivate', () => {
    clearLicense();
    _ok = false; _checkedAt = Date.now();
    return { state: 'unactivated', machineId: getMachineIdCached() };
  });
}

module.exports = { registerLicenseIpc, installIpcGate, isLicensed };
