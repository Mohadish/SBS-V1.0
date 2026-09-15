// Renders docs/manual/SBS-Manual.html to SBS-Manual.pdf with Electron's own printer (no new deps).
// Run from sbs-app:  npx electron <this file>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const html = path.resolve(process.argv[2] || path.join(__dirname, 'SBS-Manual.html'));
const out = path.resolve(process.argv[3] || path.join(path.dirname(html), 'SBS-Manual.pdf'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 1400, webPreferences: { offscreen: false } });
  await win.loadFile(html);
  await win.webContents.executeJavaScript('document.documentElement.removeAttribute("data-theme"); new Promise(r => setTimeout(r, 400))');
  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    pageSize: 'A4',
    margins: { top: 0.55, bottom: 0.6, left: 0.55, right: 0.55 },
    generateTaggedPDF: true,
    generateDocumentOutline: true,
    displayHeaderFooter: true,
    headerTemplate: '<div style="font-size:8px;color:#888;width:100%;padding:0 40px;">SBS Step Browser — User Manual</div>',
    footerTemplate: '<div style="font-size:8px;color:#888;width:100%;text-align:center;">Page <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    preferCSSPageSize: false,
  });
  fs.writeFileSync(out, pdf);
  console.log('PDF written:', out, (pdf.length / 1024).toFixed(0) + ' KB');
  app.exit(0);
}).catch(err => { console.error('PDF FAILED', err); app.exit(1); });
