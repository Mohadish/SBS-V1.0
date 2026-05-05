// Minimal Electron app for diagnosing the white-renders-as-grey issue.
// Zero SBS code, zero custom switches, default BrowserWindow settings.
// Run from sbs-app/ with:   npx electron white-test/main.js
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    backgroundColor: '#ffffff',
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.openDevTools();
});

app.on('window-all-closed', () => app.quit());
