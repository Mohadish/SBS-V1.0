'use strict';

/**
 * SBS Viewer — preload (renderer ↔ main bridge)
 * ============================================
 * The viewer's renderer runs sandboxed (contextIsolation:true,
 * nodeIntegration:false, sandbox:true — see main.js). This preload is
 * the ONLY place that has access to both Node (via contextBridge) and
 * the renderer; it exposes a TIGHTLY-controlled API at
 * `window.sbsViewer.*`.
 *
 * Only license + install-mode + machine-id are exposed — the rest of
 * the viewer's job (file open, video playback, etc.) is plain browser
 * APIs and doesn't need IPC.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sbsViewer', {
  // ── License (3-factor: company_id [baked] + email + key) ────────────
  // Renderer NEVER touches verification logic — only asks the main
  // process for state and submits user input.
  license: {
    getMachineId:    ()                  => ipcRenderer.invoke('license:getMachineId'),
    getCompanyInfo:  ()                  => ipcRenderer.invoke('license:getCompanyInfo'),
    status:          ()                  => ipcRenderer.invoke('license:status'),
    validate:        ({ email, key })    => ipcRenderer.invoke('license:validate',   { email, key }),
    activate:        ({ email, key })    => ipcRenderer.invoke('license:activate',   { email, key }),
    deactivate:      ()                  => ipcRenderer.invoke('license:deactivate'),

    // Install mode — 'station' (worker, read-only) or 'manager' (can
    // build .sbsasm files). License must authorise 'manager'; falling
    // back to 'station' is fine when license is station-only.
    installMode:     ()                  => ipcRenderer.invoke('license:installMode'),
    setInstallMode:  (mode)              => ipcRenderer.invoke('license:setInstallMode', mode),
  },

  // Environment
  isElectron: true,
  platform:   process.platform,
});
