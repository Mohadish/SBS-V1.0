'use strict';

/**
 * The screen colour picker window's bridge (V0.3.4.108): the snapshot to draw
 * (this window's display, named in its URL), and one answer back. Nothing
 * else — the window is sandboxed and isolated.
 */
const { contextBridge, ipcRenderer } = require('electron');

const displayId = new URLSearchParams(window.location.search).get('d') || '';

contextBridge.exposeInMainWorld('sbsPick', {
  image: () => ipcRenderer.invoke('color:pickScreen:image', displayId),
  done:  (hex) => ipcRenderer.send('color:pickScreen:done', hex ?? null),
});
