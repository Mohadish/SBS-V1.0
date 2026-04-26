'use strict';

/**
 * Preload for the hidden TTS host window.
 *
 * The host runs with nodeIntegration:false so it can be a clean browser
 * environment — that's what unlocks the *web* builds of kokoro-js +
 * transformers.js (which use onnxruntime-web with WebGPU). require()
 * isn't available there; this preload bridges IPC + the bundle paths
 * we resolved in main.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ttsHost', {
  // main → host
  onSynth:    (cb) => ipcRenderer.on('tts-host:synth',    (_e, payload) => cb(payload)),
  onShutdown: (cb) => ipcRenderer.on('tts-host:shutdown', () => cb()),

  // host → main
  ready:  (info)            => ipcRenderer.send('tts-host:ready', info),
  result: (id, ok, payload) => ipcRenderer.send('tts-host:result', id, ok, payload),
  log:    (msg)             => ipcRenderer.send('tts-host:log', String(msg)),
});

// Argument forwarding — main passes paths via webPreferences.additionalArguments;
// renderer code can read them off process.argv but with contextIsolation:true
// we need to pull them out here and re-expose.
function _getArg(prefix) {
  const a = (process.argv || []).find(s => s.startsWith(prefix));
  return a ? a.slice(prefix.length) : '';
}

contextBridge.exposeInMainWorld('ttsConfig', {
  bundleDir:    _getArg('--sbs-kokoro-bundle='),
  ortWasmDir:   _getArg('--sbs-ort-wasm='),
});
