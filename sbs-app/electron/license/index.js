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
const { getMachineIdCached }   = require('./machine-id');
const { loadLicense, saveLicense, clearLicense } = require('./store');

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

  const result = validateLicense({
    email:     saved.email,
    password:  saved.password,
    key:       saved.key,
    machineId,
  });

  if (result.valid) {
    return {
      state:         result.gracePeriodActive ? 'grace' : 'valid',
      machineId,
      email:         result.email,
      expiry:        result.expiry,
      daysRemaining: result.daysRemaining,
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

function registerLicenseIpc() {
  ipcMain.handle('license:getMachineId', () => {
    return getMachineIdCached();
  });

  ipcMain.handle('license:status', () => {
    return _computeStatus();
  });

  ipcMain.handle('license:validate', (_event, { email, password, key }) => {
    // Live-validate without persisting. Renderer's activation dialog
    // uses this to gate the Save button.
    const machineId = getMachineIdCached();
    return validateLicense({ email, password, key, machineId });
  });

  ipcMain.handle('license:activate', (_event, { email, password, key }) => {
    const machineId = getMachineIdCached();
    const result = validateLicense({ email, password, key, machineId });
    if (!result.valid) return result;
    saveLicense({ email, password, key });
    return { ...result, persisted: true };
  });

  ipcMain.handle('license:deactivate', () => {
    clearLicense();
    return { state: 'unactivated', machineId: getMachineIdCached() };
  });
}

module.exports = { registerLicenseIpc };
