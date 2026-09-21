'use strict';

/**
 * The manual → PDF, ONE recipe for both places that make one (V0.3.4.62):
 *
 *   • the BUILD   docs/manual/make-pdf.cjs regenerates SBS-Manual.pdf so the
 *                 file that ships in the installer always matches the HTML
 *   • the APP     Help ▸ Save the manual as PDF… renders it on demand from
 *                 the very HTML the help window is showing
 *
 * It lived only in make-pdf.cjs, run by hand — and so the PDF went stale every
 * time the manual was edited (it was two days and a dozen edits behind when
 * this was written). Sharing the recipe means the two can never disagree about
 * page size, margins, bookmarks or the running header.
 *
 * A TAGGED PDF WITH AN OUTLINE, on purpose. The manual is as much for feeding
 * to a language model as for reading: tags keep the text in reading order and
 * the outline gives it the chapter structure, which is what makes "here is the
 * manual, how do I…" work well.
 */

const PDF_OPTIONS = {
  printBackground: true,
  pageSize: 'A4',
  margins: { top: 0.55, bottom: 0.6, left: 0.55, right: 0.55 },
  generateTaggedPDF: true,
  generateDocumentOutline: true,
  displayHeaderFooter: true,
  headerTemplate: '<div style="font-size:8px;color:#888;width:100%;padding:0 40px;">SBS Step Browser — User Manual</div>',
  footerTemplate: '<div style="font-size:8px;color:#888;width:100%;text-align:center;">Page <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  preferCSSPageSize: false,
};

/**
 * Render a loaded manual page to a PDF buffer. The print is always LIGHT: a
 * reader's dark theme is for the screen, and a dark page wastes toner and reads
 * badly once printed. The theme is put back afterwards, so a visible help
 * window does not flash to light and stay there.
 */
async function renderManualPdf(webContents) {
  await webContents.executeJavaScript(`
    (function () {
      var r = document.documentElement;
      window.__sbsThemeWas = r.getAttribute('data-theme');
      r.removeAttribute('data-theme');
      return new Promise(function (ok) { setTimeout(ok, 400); });
    })()`);
  try {
    return await webContents.printToPDF(PDF_OPTIONS);
  } finally {
    await webContents.executeJavaScript(`
      (function () {
        var r = document.documentElement, t = window.__sbsThemeWas;
        if (t) r.setAttribute('data-theme', t);
        delete window.__sbsThemeWas;
      })()`).catch(() => {});
  }
}

module.exports = { PDF_OPTIONS, renderManualPdf };
