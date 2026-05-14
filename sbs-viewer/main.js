'use strict';

/**
 * SBS Viewer — Electron entry.
 *
 * Wraps viewer.html in a BrowserWindow + registers the license IPC
 * handlers so the renderer's activation dialog has the main-process
 * verifier waiting. Preload exposes the controlled API at
 * `window.sbsViewer.*` — see preload.js for the surface.
 *
 * NOTE: extension OMITTED on `require('./license/index')` so Node's
 * resolver picks `.js` in dev and `.jsc` in bytenode'd production
 * builds (where the .js source is excluded from the asar). The first
 * line registers bytenode's .jsc extension handler — no-op in dev when
 * no .jsc files exist.
 *
 * To build a Windows installer:
 *   cd sbs-viewer
 *   npm install
 *   npm run build
 * → dist/SBS Viewer Setup <version>.exe
 *
 * To build a CUSTOMER-SPECIFIC installer (baked company ID):
 *   node scripts/build-installer.js
 *   (asks for company ID + name, then runs npm run build)
 */

// Register bytenode's .jsc extension handler BEFORE anything else
// requires from ./license/. Inert in dev (no .jsc files exist).
require('bytenode');

const { app, BrowserWindow } = require('electron');
const path = require('path');

// Register license IPC up-front so the renderer's first calls land on
// real handlers (the boot dialog fires window.sbsViewer.license.status()
// during the renderer's initial script execution).
const { registerLicenseIpc } = require('./license/index');
registerLicenseIpc();

// Time-tampering monitor: advance the high-water mark on every launch
// AFTER app.whenReady so app.getPath('userData') resolves. Doing it
// before would crash (userData not initialised until ready).
const { recordLaunch: _recordTimeLaunch } = require('./license/time-monitor');

function createWindow() {
  const win = new BrowserWindow({
    width:  1280,
    height: 800,
    title:  'SBS Viewer',
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
      preload:          path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'viewer.html'));
}

app.whenReady().then(() => {
  _recordTimeLaunch();   // safe to call once userData path is available
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
