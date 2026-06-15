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
  openImage:          ()          => ipcRenderer.invoke('dialog:openImage'),
  openProject:        ()          => ipcRenderer.invoke('dialog:openProject'),
  saveProject:        (name)      => ipcRenderer.invoke('dialog:saveProject', name),
  saveHeader:         (name)      => ipcRenderer.invoke('dialog:saveHeader', name),
  openHeader:         ()          => ipcRenderer.invoke('dialog:openHeader'),
  saveNoteLib:        (name)      => ipcRenderer.invoke('dialog:saveNoteLib', name),
  openNoteLib:        ()          => ipcRenderer.invoke('dialog:openNoteLib'),
  chooseExportFolder: ()          => ipcRenderer.invoke('dialog:chooseExportFolder'),
  chooseFolder:       (opts={})   => ipcRenderer.invoke('dialog:chooseFolder', opts),

  // ── File system ──────────────────────────────────────────────────────────
  readFile:  (filePath, encoding) => ipcRenderer.invoke('fs:readFile',  filePath, encoding),
  writeFile: (filePath, data, enc)=> ipcRenderer.invoke('fs:writeFile', filePath, data, enc),
  // Project I/O — transparently gzips on write, gunzips on read (old plain
  // .sbsproj files still load via a magic-byte check in the main process).
  writeProject: (filePath, jsonString) => ipcRenderer.invoke('project:write', filePath, jsonString),
  readProject:  (filePath)             => ipcRenderer.invoke('project:read',  filePath),
  fileExists:(filePath)           => ipcRenderer.invoke('fs:exists',    filePath),
  statFile:  (filePath)           => ipcRenderer.invoke('fs:stat',      filePath),
  listDir:   (dirPath)            => ipcRenderer.invoke('fs:listDir',   dirPath),
  deletePath:(p, opts={})         => ipcRenderer.invoke('fs:deletePath', p, opts),

  // ── App ──────────────────────────────────────────────────────────────────
  getVersion:         ()          => ipcRenderer.invoke('app:getVersion'),
  showInFolder:       (filePath)  => ipcRenderer.invoke('shell:showItemInFolder', filePath),

  // ── Native CAD converter (optional 64-bit OpenCascade sidecar) ───────────
  cad: {
    available: ()                              => ipcRenderer.invoke('cad:available'),
    convert:   (inp, out, linRatio, angDeg, structure) => ipcRenderer.invoke('cad:convert', { inp, out, linRatio, angDeg, structure }),
    cancel:    ()                              => ipcRenderer.invoke('cad:cancel'),
    // Live phase lines from the converter (main → renderer). Returns an
    // unsubscribe fn. Each call: cb({ line }).
    onProgress: (cb) => {
      const h = (_e, data) => { try { cb(data); } catch (_) { /* ignore */ } };
      ipcRenderer.on('cad:progress', h);
      return () => { try { ipcRenderer.removeListener('cad:progress', h); } catch (_) { /* ignore */ } };
    },
  },

  // ── Menu messages (main → renderer) ─────────────────────────────────────
  onMenu: (channel, cb) => {
    const allowed = [
      'menu:newProject', 'menu:openProject', 'menu:saveProject', 'menu:saveProjectAs',
      'menu:loadModel',  'menu:browseAssets',
      'menu:fitAll',     'menu:showAll',
      'menu:openSettings',
      'menu:modelSourceTransform',
      'menu:recoverStuckInputs',
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
    // V0.2.22.35 — Google Cloud TTS (gated behind userSettings.cloud.enabled
    // + googleApiKey in the renderer). Key passed per-call so it never
    // lives in the preload or gets embedded in the binary.
    gcpSynthesize: (text, voice, speed = 1, apiKey = '') =>
      ipcRenderer.invoke('tts:gcp-synthesize', text, voice, speed, apiKey),
  },

  // ── License (3-factor commercial licensing, see electron/license/) ──────
  // The renderer NEVER touches private validation logic — it can only
  // ask "what's my status" and "validate / activate this tuple".
  // Verification + storage live entirely in the main process.
  license: {
    getMachineId: ()                                  => ipcRenderer.invoke('license:getMachineId'),
    status:       ()                                  => ipcRenderer.invoke('license:status'),
    validate:     ({ email, password, key })          => ipcRenderer.invoke('license:validate',   { email, password, key }),
    activate:     ({ email, password, key })          => ipcRenderer.invoke('license:activate',   { email, password, key }),
    deactivate:   ()                                  => ipcRenderer.invoke('license:deactivate'),
  },

  // ── Environment ──────────────────────────────────────────────────────────
  isElectron: true,
  platform: process.platform,   // 'win32' | 'darwin' | 'linux'

});
