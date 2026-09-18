/**
 * SBS — Document → HTML (V0.3.4.0, phase D1). Pure string builder.
 *
 * One A4 page per model page, zones placed in millimetres exactly as the
 * template says. Text stays TEXT (selectable, searchable in the PDF — a
 * certified document must be), pictures are <img> in their slots. The same
 * HTML feeds the in-app preview and Electron's printToPDF.
 */

import { watermarkHtml, watermarkCss, WATERMARK_CSS } from './watermark-core.js';
import { pictureBox } from './document-core.js';
export { watermarkCss };

const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const _mm =(r) => `left:${r.x}mm;top:${r.y}mm;width:${r.w}mm;height:${r.h}mm;`;
/** Row direction = the first strong character (so a Hebrew line puts its number badge on the right). */
const _dirOf = (s) => {
  const m = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ֐-ࣿיִ-﷿ﹰ-ﻼ]/.exec(String(s ?? ''));
  return m && /[֐-ࣿיִ-﷿ﹰ-ﻼ]/.test(m[0]) ? 'rtl' : 'ltr';
};

export const DOCUMENT_CSS = `
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { font-family: Arial, Helvetica, sans-serif; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { position: relative; width: 210mm; height: 297mm; overflow: hidden; background: #fff; page-break-after: always; break-after: page; font-family: Arial, Helvetica, sans-serif; color: #111; text-align: start; line-height: normal; }
.page:last-child { page-break-after: auto; break-after: auto; }
.zone { position: absolute; overflow: hidden; }
.hdr { display: flex; align-items: center; gap: 4mm; border-bottom: 0.4mm solid #222; padding-bottom: 1.5mm; font-size: 9.5pt; }
.hdr .logo { height: 100%; max-height: 14mm; max-width: 40mm; object-fit: contain; flex: 0 0 auto; }
.hdr .l, .ftr .l { flex: 1; text-align: left; } .hdr .c, .ftr .c { flex: 1.4; text-align: center; font-weight: 700; } .hdr .r, .ftr .r { flex: 1; text-align: right; }
/* right-to-left page: the flex row already runs right → left; each end cell hugs the OUTER edge whatever language its own text is in */
.page[dir="rtl"] .hdr .l, .page[dir="rtl"] .ftr .l { text-align: right; } .page[dir="rtl"] .hdr .r, .page[dir="rtl"] .ftr .r { text-align: left; }
.ftr { display: flex; align-items: center; gap: 4mm; border-top: 0.3mm solid #666; padding-top: 1.5mm; font-size: 8.5pt; color: #333; }
.txt h2 { font-size: 13pt; margin: 0 0 3mm; padding-bottom: 1mm; border-bottom: 0.3mm solid #bbb; }
.it { display: flex; gap: 3mm; margin: 0 0 3.2mm; font-size: 11pt; line-height: 1.38; break-inside: avoid; }
.it .no { flex: 0 0 auto; min-width: 9mm; height: 6.2mm; padding: 0 1.6mm; border-radius: 3.1mm; background: #111; color: #fff; font-weight: 700; font-size: 9.5pt; display: flex; align-items: center; justify-content: center; }
.it .tx { flex: 1; white-space: pre-wrap; word-break: break-word; }
.it .nm { display: block; font-weight: 700; font-size: 10pt; margin-bottom: 0.6mm; }
.slot { border: 0.25mm solid #999; background: #fff; display: flex; align-items: center; justify-content: center; }
.slot.none { background: #f4f4f4; }
.slot img.pic { position: absolute; display: block; height: auto; max-width: none; transform: translate(-50%, -50%); }
.slot .ph { color: #888; font-size: 9pt; text-align: center; padding: 3mm; }
.slot .pn { position: absolute; top: 1.6mm; inset-inline-start: 1.6mm; min-width: 9mm; height: 6.2mm; padding: 0 1.8mm; border-radius: 3.1mm; background: #111; color: #fff; font-weight: 700; font-size: 9.5pt; display: flex; align-items: center; justify-content: center; gap: 1.2mm; box-shadow: 0 0 0 0.35mm #fff; white-space: nowrap; }
.slot .pn small { font-weight: 400; font-size: 7.5pt; opacity: .85; }
.cap { position: absolute; font-size: 8pt; color: #555; }
` + WATERMARK_CSS;

/**
 * @param {{pages:Array,total:number}} model        document-core.buildRenderModel()
 * @param {Object} o
 * @param {Map<string,string>|Object} [o.stills]    stepId → image URL (data: or file:)
 * @param {string} [o.logo]                         image URL for the header
 * @param {string} [o.title]                        <title>
 * @param {boolean} [o.showStepNames]               bold step name above each text
 */
export function renderDocumentHtml(model, o = {}) {
  const oo = { ...o, watermark: o.watermark ?? model.watermark, dir: o.dir ?? model.dir, lang: o.lang ?? model.lang };
  const pages = (model.pages || []).map(p => renderPageHtml(p, oo)).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${_esc(o.title || 'Document')}</title><style>${DOCUMENT_CSS}${watermarkCss(oo.watermark)}${o.extraCss || ''}</style></head><body>${pages}</body></html>`;
}

/**
 * What sits inside a picture slot: the picture, CROPPED by the slot — placed by
 * its centre (slot centre + the user's offset) and sized in % of the slot width
 * (100 % × zoom of "fills the slot"). Exported: the workspace patches a slot with
 * the same markup when a picture arrives.
 */
/** The step number a picture refers to (pages that print several steps) — and "before" on a before-frame. */
export function pictureBadgeHtml(im, lang) {
  if (!im.label && im.moment !== 'start') return '';
  const before = im.moment === 'start' ? `<small>${lang === 'he' ? 'לפני' : lang === 'ar' ? 'قبل' : 'before'}</small>` : '';
  return `<span class="pn">${_esc(im.label || '')}${before}</span>`;
}

export function slotInnerHtml(im, url, k, lang = null) {
  if (!url) return `<div class="ph">${im.stepId ? 'picture not rendered yet' : `picture ${k + 1} — empty`}</div>${pictureBadgeHtml(im, lang)}`;
  const b = pictureBox(im.rect, im.aspect, im.fit);
  return `<img class="pic" src="${_esc(url)}" alt="" draggable="false" style="left:calc(50% + ${b.dxMm}mm);top:calc(50% + ${b.dyMm}mm);width:${b.widthPct}%;">${pictureBadgeHtml(im, lang)}`;
}

/**
 * ONE page as a <section> — the PDF, the preview and the workspace's live page
 * are all this same markup, so what is edited is what prints. Rows carry
 * data-step and slots data-slot: the workspace hangs its editing on them.
 * @param {Object} p   a page of buildRenderModel()
 * @param {Object} o   same options as renderDocumentHtml; chapterHead overrides p.chapterHead
 */
export function renderPageHtml(p, o = {}) {
  const still = (id) => (o.stills instanceof Map ? o.stills.get(id) : o.stills?.[id]) || null;
  const t = p.template;
  const chapterHead = (o.chapterHead ?? p.chapterHead) && p.chapter ? `<h2 dir="auto">${_esc(p.chapter)}</h2>` : '';
  const items = p.items.map(it => `<div class="it" dir="${_dirOf(it.text)}" data-step="${_esc(it.stepId)}">${it.label ? `<span class="no">${_esc(it.label)}</span>` : ''}<div class="tx" dir="auto">${o.showStepNames && it.name ? `<span class="nm">${_esc(it.name)}</span>` : ''}${_esc(it.text)}</div></div>`).join('');
  const slots = p.images.map((im, k) => {
    const url = im.src || (im.stepId ? (still(im.key) || (im.moment !== 'start' ? still(im.stepId) : null)) : null);
    return `<div class="zone slot${url ? '' : ' none'}" data-slot="${k}" style="${_mm(im.rect)}">${slotInnerHtml(im, url, k, o.lang)}</div>`;
  }).join('');
  // 💧 'under' = painted first (the text and the pictures cover it); 'over' = last, on top of the pictures too
  const pd = o.dir === 'rtl' ? 'rtl' : 'ltr';
  const wm = watermarkHtml(o.watermark);
  const under = !!wm && o.watermark.layer === 'under';
  return `<section class="page" dir="${pd}" data-page="${p.number}" data-id="${_esc(p.id)}">`
    + (under ? wm : '')
    + `<div class="zone hdr" style="${_mm(t.header)}">${o.logo ? `<img class="logo" src="${_esc(o.logo)}" alt="">` : ''}<div class="l" dir="${pd}">${_esc(p.header.left)}</div><div class="c" dir="${pd}">${_esc(p.header.center)}</div><div class="r" dir="${pd}">${_esc(p.header.right)}</div></div>`
    + `<div class="zone txt" style="${_mm(t.text)}">${chapterHead}${items}</div>`
    + slots
    + `<div class="zone ftr" style="${_mm(t.footer)}"><div class="l" dir="${pd}">${_esc(p.footer.left)}</div><div class="c" dir="${pd}">${_esc(p.footer.center)}</div><div class="r" dir="${pd}">${_esc(p.footer.right)}</div></div>`
    + (wm && !under ? wm : '')
    + `</section>`;
}
