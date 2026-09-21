'use strict';

/**
 * The help window's bridge: exactly one thing, "save this manual as a PDF".
 *
 * The manual is an ordinary HTML file that also opens in any browser. Its
 * ⬇ PDF button looks for window.sbsHelp and shows itself only when it is
 * there — so the same file is correct in both places: in a browser it has its
 * own 🖨 Print, inside the app it can also hand you a finished PDF.
 *
 * Nothing else is exposed. The window is sandboxed and context-isolated, and
 * it needs neither the file system nor the app's own IPC to show a document.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sbsHelp', {
  savePdf: () => ipcRenderer.invoke('help:savePdf'),
});
