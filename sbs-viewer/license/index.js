'use strict';

/**
 * SBS Viewer license — IPC bridge
 * ===============================
 * Registers main-process handlers for the renderer's
 * `window.sbsViewer.license.*` calls. Mirrors authoring's IPC layer but
 * with the viewer's company-bound payload semantics.
 *
 * Handlers:
 *   license:getMachineId    → 32-hex hardware fingerprint
 *   license:getCompanyInfo  → { id, name } from baked company.js
 *   license:status          → current state for boot dialog routing
 *   license:validate        → live-check a tuple without persisting (dialog gate)
 *   license:activate        → verify + save on success
 *   license:deactivate      → wipe license (forces re-activation)
 *   license:installMode     → read current install-mode (station|manager)
 *   license:setInstallMode  → write install-mode (settings toggle)
 *
 * Note: extensions OMITTED on sibling requires so the resolver picks
 * .js in dev and .jsc in bytenode'd production builds. Same pattern as
 * sbs-app/electron/license/index.js.
 */

const { ipcMain } = require('electron');
const { validateLicense }    = require('./verify');
const { getMachineIdCached } = require('./machine-id');
const {
  loadLicense, saveLicense, clearLicense,
  loadInstallMode, saveInstallMode,
} = require('./store');
const company = require('../company');

/**
 * Compute the higher-level status the renderer reasons about.
 * states: 'unactivated' | 'valid' | 'grace' | 'expired'
 */
function _computeStatus() {
  const machineId   = getMachineIdCached();
  const installMode = loadInstallMode();
  const saved       = loadLicense();

  if (!saved) {
    return {
      state: 'unactivated',
      machineId, installMode,
      company: { id: company.COMPANY_ID, name: company.COMPANY_NAME },
    };
  }

  const result = validateLicense({
    companyId: company.COMPANY_ID,
    email:     saved.email,
    key:       saved.key,
    machineId,
    installMode,
  });

  if (result.valid) {
    return {
      state:             result.gracePeriodActive ? 'grace' : 'valid',
      machineId, installMode,
      company:           { id: company.COMPANY_ID, name: company.COMPANY_NAME },
      email:             result.email,
      expiry:            result.expiry,
      daysRemaining:     result.daysRemaining,
      licenseMode:       result.licenseMode,
      effectiveMode:     result.effectiveMode,
    };
  }

  return {
    state:           result.reason === 'EXPIRED' ? 'expired' : 'unactivated',
    machineId, installMode,
    company:         { id: company.COMPANY_ID, name: company.COMPANY_NAME },
    email:           saved.email,
    expiry:          result.expiry,
    daysRemaining:   result.daysRemaining,
    reason:          result.reason,
  };
}

function registerLicenseIpc() {
  ipcMain.handle('license:getMachineId', () => getMachineIdCached());

  ipcMain.handle('license:getCompanyInfo', () => ({
    id:   company.COMPANY_ID,
    name: company.COMPANY_NAME,
  }));

  ipcMain.handle('license:status', () => _computeStatus());

  ipcMain.handle('license:validate', (_e, { email, key }) => {
    return validateLicense({
      companyId:   company.COMPANY_ID,
      email, key,
      machineId:   getMachineIdCached(),
      installMode: loadInstallMode(),
    });
  });

  ipcMain.handle('license:activate', (_e, { email, key }) => {
    const result = validateLicense({
      companyId:   company.COMPANY_ID,
      email, key,
      machineId:   getMachineIdCached(),
      installMode: loadInstallMode(),
    });
    if (!result.valid) return result;
    saveLicense({ email, key });
    return { ...result, persisted: true };
  });

  ipcMain.handle('license:deactivate', () => {
    clearLicense();
    return _computeStatus();
  });

  ipcMain.handle('license:installMode',    () => loadInstallMode());
  ipcMain.handle('license:setInstallMode', (_e, mode) => saveInstallMode(mode));
}

module.exports = { registerLicenseIpc };
