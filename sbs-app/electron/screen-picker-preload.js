'use strict';

/**
 * The screen colour picker window's bridge (V0.3.4.108): the snapshot to draw,
 * and one answer back. Nothing else — the window is sandboxed and isolated.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sbsPick', {
  image: () => ipcRenderer.invoke('color:pickScreen:image'),
  done:  (hex) => ipcRenderer.send('color:pickScreen:done', hex ?? null),
});
