'use strict';

/**
 * The screen colour picker window's bridge (V0.3.4.108): the snapshot to draw
 * (this window's display, named in its URL), and one answer back. Nothing
 * else — the window is sandboxed and isolated.
 * V0.3.4.117 — the window is pooled and lives through many picks: 'session'
 * starts one (the page then asks for the snapshot — raw RGBA
 * { width, height, rgba }, answered when the capture is in), 'drawn' tells
 * main the page has it on screen (so the window is shown only then), 'end'
 * closes the session. `focus` asks for the keyboard when the pointer arrives.
 */
const { contextBridge, ipcRenderer } = require('electron');

const displayId = new URLSearchParams(window.location.search).get('d') || '';

contextBridge.exposeInMainWorld('sbsPick', {
  image:     () => ipcRenderer.invoke('color:pickScreen:image', displayId),
  drawn:     () => ipcRenderer.send('color:pickScreen:drawn', displayId),
  focus:     () => ipcRenderer.send('color:pickScreen:focus', displayId),
  done:      (hex) => ipcRenderer.send('color:pickScreen:done', hex ?? null),
  onSession: (cb) => { ipcRenderer.on('color:pickScreen:session', () => cb()); },
  onEnd:     (cb) => { ipcRenderer.on('color:pickScreen:end', () => cb()); },
});
