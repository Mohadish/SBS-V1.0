'use strict';

/**
 * Preload — secure IPC bridge
 *
 * This is the ONLY file that has access to both Node.js (via contextBridge)
 * and the renderer (webpage). It exposes a tightly controlled API under
 * window.sbsNative so the UI can talk to the file system and OS without
 * ever having direct Node.js access.
 *
 * Rule: only add things here that the UI genuinely needs.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sbsNative', {

  // ── Dialogs ──────────────────────────────────────────────────────────────
  openModel:          ()          => ipcRenderer.invoke('dialog:openModel'),
  openProject:        ()          => ipcRenderer.invoke('dialog:openProject'),
  saveProject:        (name)      => ipcRenderer.invoke('dialog:saveProject', name),
  chooseExportFolder: ()          => ipcRenderer.invoke('dialog:chooseExportFolder'),

  // ── File system ──────────────────────────────────────────────────────────
  readFile:  (filePath, encoding) => ipcRenderer.invoke('fs:readFile',  filePath, encoding),
  writeFile: (filePath, data, enc)=> ipcRenderer.invoke('fs:writeFile', filePath, data, enc),
  fileExists:(filePath)           => ipcRenderer.invoke('fs:exists',    filePath),

  // ── App ──────────────────────────────────────────────────────────────────
  getVersion:         ()          => ipcRenderer.invoke('app:getVersion'),
  showInFolder:       (filePath)  => ipcRenderer.invoke('shell:showItemInFolder', filePath),

  // ── Environment ──────────────────────────────────────────────────────────
  isElectron: true,
  platform: process.platform,   // 'win32' | 'darwin' | 'linux'

});
