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
  statFile:  (filePath)           => ipcRenderer.invoke('fs:stat',      filePath),

  // ── App ──────────────────────────────────────────────────────────────────
  getVersion:         ()          => ipcRenderer.invoke('app:getVersion'),
  showInFolder:       (filePath)  => ipcRenderer.invoke('shell:showItemInFolder', filePath),

  // ── Menu messages (main → renderer) ─────────────────────────────────────
  onMenu: (channel, cb) => {
    const allowed = [
      'menu:newProject', 'menu:openProject', 'menu:saveProject', 'menu:saveProjectAs',
      'menu:loadModel',  'menu:browseAssets',
      'menu:fitAll',     'menu:showAll',
      'menu:openSettings',
    ];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, ...args) => cb(...args));
  },

  // ── User settings (machine-level prefs, persisted to userData/user-settings.json) ─
  userSettings: {
    read:               ()    => ipcRenderer.invoke('settings:read'),
    write:              (obj) => ipcRenderer.invoke('settings:write', obj),
    locale:             ()    => ipcRenderer.invoke('settings:locale'),
    path:               ()    => ipcRenderer.invoke('settings:path'),
    installedLanguages: ()    => ipcRenderer.invoke('settings:installedLanguages'),
  },

  // ── Text-to-speech (OS voices via `say` npm + OneCore via PowerShell) ────
  tts: {
    listVoices: ()                                     => ipcRenderer.invoke('tts:listVoices'),
    synthesize: (text, voice, speed = 1, opts = {})    => ipcRenderer.invoke('tts:synthesize', text, voice, speed, opts),
  },

  // ── Environment ──────────────────────────────────────────────────────────
  isElectron: true,
  platform: process.platform,   // 'win32' | 'darwin' | 'linux'

});
