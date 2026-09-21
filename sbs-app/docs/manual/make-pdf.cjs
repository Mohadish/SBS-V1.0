// Renders docs/manual/SBS-Manual.html to SBS-Manual.pdf with Electron's own printer (no new deps).
// Run from sbs-app:  npm run manual-pdf      (npm run build does it for you)
//
// The recipe itself lives in electron/manual-pdf.js, shared with the app's own
// Help ▸ Save the manual as PDF…, so the shipped file and the on-demand one can
// never disagree about page size, margins, bookmarks or the running header.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { renderManualPdf } = require('../../electron/manual-pdf.js');

const html = path.resolve(process.argv[2] || path.join(__dirname, 'SBS-Manual.html'));
const out = path.resolve(process.argv[3] || path.join(path.dirname(html), 'SBS-Manual.pdf'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 1400, webPreferences: { offscreen: false } });
  await win.loadFile(html);
  const pdf = await renderManualPdf(win.webContents);
  fs.writeFileSync(out, pdf);
  console.log('PDF written:', out, (pdf.length / 1024).toFixed(0) + ' KB');
  app.exit(0);
}).catch(err => { console.error('PDF FAILED', err); app.exit(1); });
