// WebGL variant of the clean white test — adds a live WebGL canvas
// next to a plain white panel. If the panel dims here too, WebGL
// (i.e. Three.js in the real SBS app) is the trigger.
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    backgroundColor: '#ffffff',
  });
  win.loadFile(path.join(__dirname, 'index-webgl.html'));
  win.webContents.openDevTools();
});

app.on('window-all-closed', () => app.quit());
