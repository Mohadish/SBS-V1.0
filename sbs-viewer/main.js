'use strict';

/**
 * SBS Viewer — Electron entry.
 *
 * Wraps viewer.html in a BrowserWindow so the same file the web build
 * uses can ship as a desktop app. No Node integration in the renderer
 * — the viewer is pure browser-side JS, so we run it under the strict
 * `contextIsolation + sandbox` defaults.
 *
 * To build a Windows installer:
 *   cd sbs-viewer
 *   npm install
 *   npm run build
 * → dist/SBS Viewer Setup <version>.exe
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width:  1280,
    height: 800,
    title:  'SBS Viewer',
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,        // workers don't need a File / Edit menu
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    },
  });
  win.loadFile(path.join(__dirname, 'viewer.html'));
}

app.whenReady().then(createWindow);

// Quit when all windows are closed (Windows / Linux). On macOS the
// app stays in the dock by convention; reopen on dock-click.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
