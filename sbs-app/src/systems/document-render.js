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
.txt h2, .txt .ch { font-size: 13pt; font-weight: 700; margin: 0 0 3mm; padding-bottom: 1mm; border-bottom: 0.3mm solid #bbb; }
.toc h1 { font-size: 18pt; margin: 0 0 7mm; padding-bottom: 2mm; border-bottom: 0.5mm solid #222; }
.toc .tl { display: flex; align-items: baseline; gap: 2.5mm; font-size: 11pt; line-height: 1.3; margin: 0 0 3.1mm; color: inherit; text-decoration: none; }
.toc .tl .tn { flex: 0 0 9mm; font-weight: 700; }
.toc .tl .tt { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toc .tl .td { flex: 1 1 8mm; border-bottom: 0.3mm dotted #888; transform: translateY(-1mm); }
.toc .tl .tp { flex: 0 0 auto; font-variant-numeric: tabular-nums; font-weight: 700; }
.toc .tl.ts { font-size: 9.5pt; margin: 0 0 2.1mm; padding-inline-start: 9mm; color: #333; }
.toc .tl.ts .tn { flex: 0 0 11mm; font-weight: 600; }
.toc .tl.ts .tp { font-weight: 400; }
.toc .tl.ts .td { border-bottom-color: #bbb; }
.ctb { overflow: hidden; }
.ctb table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.ctb th, .ctb td { border: 0.25mm solid #555; padding: 1.1mm 1.5mm; vertical-align: top; text-align: inherit; font-weight: 400; word-break: break-word; line-height: 1.3; }
.ctb th { font-weight: 700; background: #ececec; }
.ctb.nogrid th, .ctb.nogrid td { border: 0; border-bottom: 0.25mm solid #ccc; }
.ctb.zebra tbody tr:nth-child(even) td { background: #f4f4f4; }
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
/* custom pages: free items placed in mm; text wears the body font */
.ci { position: absolute; overflow: hidden; }
.ci.ct { white-space: pre-wrap; word-break: break-word; line-height: 1.38; }
.ci.cp { background: #fff; }
.ci.cp.none { background: #f4f4f4; border: 0.25mm dashed #999; display: flex; align-items: center; justify-content: center; color: #888; font-size: 9pt; }
.ci.cp img.pic { position: absolute; display: block; height: auto; max-width: none; transform: translate(-50%, -50%); }
.ci.cp img.logo { width: 100%; height: 100%; object-fit: contain; display: block; }
/* an edited header / footer: free items; text is centred vertically in its box like the classic cells were */
.ci.ct.bt { display: flex; flex-direction: column; justify-content: center; line-height: 1.2; }
.brule { position: absolute; height: 0; border-top: 0.4mm solid #222; }
.brule.footer { border-top: 0.3mm solid #666; }
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
  const seq = model.sequence || [...(model.toc ? [{ kind: 'toc', model: model.toc }] : []), ...(model.pages || []).map(p => ({ kind: 'page', model: p }))];
  const pages = seq.flatMap(e => e.kind === 'toc' ? e.model.pages.map(tp => renderTocPageHtml(tp, { ...oo, tocTitle: e.model.title }))
    : e.kind === 'custom' ? [renderCustomPageHtml(e.model, oo)] : [renderPageHtml(e.model, oo)]).join('\n');
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
 * One free item (a custom page's, or an edited header / footer's). A picture is a file (it.src),
 * a step of the animation rendered on demand (it.key → o.stills) or the project's logo (it.logo → o.logo).
 * @param {string} [band]  'header' | 'footer' — marks band items for the editor and centres their text vertically
 */
export function customItemHtml(it, o = {}, band = '') {
  const box = `left:${it.x}mm;top:${it.y}mm;width:${it.w}mm;height:${it.h}mm;`;
  const tag = `data-item="${_esc(it.id)}"${band ? ` data-band="${band}"` : ''}`;
  if (it.type === 'image') {
    const still = (id) => (o.stills instanceof Map ? o.stills.get(id) : o.stills?.[id]) || null;
    if (it.logo) return o.logo ? `<div class="ci cp" ${tag} style="${box}"><img class="logo" src="${_esc(o.logo)}" alt="" draggable="false"></div>` : `<div class="ci cp none" ${tag} style="${box}">logo</div>`;
    const url = it.src || (it.key ? still(it.key) : null);
    if (!url) return `<div class="ci cp none" ${tag} style="${box}">${it.stepId ? 'rendering the picture…' : 'picture'}</div>`;
    const b = pictureBox(it, it.aspect, it.fit);
    return `<div class="ci cp" ${tag} style="${box}"><img class="pic" src="${_esc(url)}" alt="" draggable="false" style="left:calc(50% + ${b.dxMm}mm);top:calc(50% + ${b.dyMm}mm);width:${b.widthPct}%;"></div>`;
  }
  const align = it.align === 'center' ? 'center' : it.align === 'end' ? 'end' : 'start';
  if (it.type === 'table') {
    // table-layout:fixed is what makes the preview and printToPDF agree — auto
    // layout re-measures against the print font and drifts.
    const cg = `<colgroup>${(it.widths || []).map(w => `<col style="width:${(w * 100).toFixed(3)}%">`).join('')}</colgroup>`;
    const body = (it.cells || []).map((row, r) => `<tr>${(row || []).map((cell, c) => {
      const t = (it.head && r === 0) ? 'th' : 'td';
      return `<${t} data-cell="${r},${c}" dir="auto">${_esc(cell)}</${t}>`;
    }).join('')}</tr>`).join('');
    return `<div class="ci ctb${it.grid === false ? ' nogrid' : ''}${it.zebra ? ' zebra' : ''}" ${tag}`
      + ` style="${box}font-size:${it.size}pt;color:${_esc(it.color)};text-align:${align};">`
      + `<table>${cg}<tbody>${body}</tbody></table></div>`;
  }
  return `<div class="ci ct${band ? ' bt' : ''}" ${tag} dir="auto" style="${box}font-size:${it.size}pt;font-weight:${it.bold ? 700 : 400};font-style:${it.italic ? 'italic' : 'normal'};text-align:${align};color:${_esc(it.color)};">${_esc(it.text)}</div>`;
}

/**
 * The header or the footer of a page: the classic three cells (+ logo) — or, once it was edited, its free items.
 * Every kind of page (steps, contents, custom) prints its bands through here.
 */
export function bandHtml(side, p, o = {}) {
  const t = p.template, rect = side === 'header' ? t.header : t.footer, pd = o.dir === 'rtl' ? 'rtl' : 'ltr';
  const bi = p.bandItems?.[side];
  if (bi) {
    const rule = bi.rule ? `<div class="brule ${side}" style="left:${rect.x}mm;top:${side === 'header' ? rect.y + rect.h : rect.y}mm;width:${rect.w}mm;"></div>` : '';
    return rule + bi.items.map(it => customItemHtml(it, o, side)).join('');
  }
  const cells = p[side] || {};
  return `<div class="zone ${side === 'header' ? 'hdr' : 'ftr'}" style="${_mm(rect)}">${side === 'header' && o.logo ? `<img class="logo" src="${_esc(o.logo)}" alt="">` : ''}<div class="l" dir="${pd}">${_esc(cells.left)}</div><div class="c" dir="${pd}">${_esc(cells.center)}</div><div class="r" dir="${pd}">${_esc(cells.right)}</div></div>`;
}

/** A custom page: the document's header and footer, and between them whatever the user placed. */
export function renderCustomPageHtml(cp, o = {}) {
  const t = cp.template, pd = o.dir === 'rtl' ? 'rtl' : 'ltr';
  const wm = watermarkHtml(o.watermark), under = !!wm && o.watermark.layer === 'under';
  return `<section class="page" id="pg-${cp.number}" dir="${pd}" data-page="${cp.number}" data-id="${_esc(cp.id)}">`
    + (under ? wm : '')
    + bandHtml('header', cp, o)
    + (cp.items || []).map(it => customItemHtml(it, o)).join('')
    + bandHtml('footer', cp, o)
    + (wm && !under ? wm : '')
    + `</section>`;
}

/**
 * A contents page: one line per chapter — number, name, dotted leader, page — each line a link to
 * that page (the PDF keeps it clickable). Same header / footer / watermark as every other page.
 */
export function renderTocPageHtml(tp, o = {}) {
  const t = tp.template, pd = o.dir === 'rtl' ? 'rtl' : 'ltr';
  const wm = watermarkHtml(o.watermark), under = !!wm && o.watermark.layer === 'under';
  const C = { x: 12, y: 32, w: 186, h: 238.5 };
  // a step line is the same row, one step in and a shade lighter (V0.3.4.33)
  const lines = tp.lines.map(l => `<a class="tl${l.kind === 'step' ? ' ts' : ''}" href="#pg-${l.page}">`
    + `<span class="tn">${_esc(l.no)}</span><span class="tt" dir="auto">${_esc(l.name)}</span>`
    + `<span class="td"></span><span class="tp">${_esc(l.page)}</span></a>`).join('');
  return `<section class="page" id="pg-${tp.number}" dir="${pd}" data-page="${tp.number}" data-id="${_esc(tp.id)}">`
    + (under ? wm : '')
    + bandHtml('header', tp, o)
    + `<div class="zone toc" style="${_mm(C)}">${tp.first ? `<h1 dir="auto">${_esc(o.tocTitle || 'Contents')}</h1>` : ''}${lines}</div>`
    + bandHtml('footer', tp, o)
    + (wm && !under ? wm : '')
    + `</section>`;
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
  const chapterHead = !p.chapter ? '' : (o.chapterHead ?? p.chapterHead) ? `<h2 dir="auto">${_esc(p.chapter)}</h2>` : `<div class="ch" dir="auto">${_esc(p.chapter)}</div>`;
  const items = p.items.map(it => `<div class="it" dir="${_dirOf(it.text)}" data-step="${_esc(it.stepId)}">${it.label ? `<span class="no">${_esc(it.label)}</span>` : ''}<div class="tx" dir="auto">${o.showStepNames && it.name ? `<span class="nm">${_esc(it.name)}</span>` : ''}${_esc(it.text)}</div></div>`).join('');
  const slots = p.images.map((im, k) => {
    const url = im.src || (im.stepId ? (still(im.key) || (im.moment !== 'start' ? still(im.stepId) : null)) : null);
    return `<div class="zone slot${url ? '' : ' none'}" data-slot="${k}" style="${_mm(im.rect)}">${slotInnerHtml(im, url, k, o.lang)}</div>`;
  }).join('');
  // 💧 'under' = painted first (the text and the pictures cover it); 'over' = last, on top of the pictures too
  const pd = o.dir === 'rtl' ? 'rtl' : 'ltr';
  const wm = watermarkHtml(o.watermark);
  const under = !!wm && o.watermark.layer === 'under';
  return `<section class="page" id="pg-${p.number}" dir="${pd}" data-page="${p.number}" data-id="${_esc(p.id)}">`
    + (under ? wm : '')
    + bandHtml('header', p, o)
    + `<div class="zone txt" style="${_mm(t.text)}">${chapterHead}${items}</div>`
    + slots
    + bandHtml('footer', p, o)
    + (wm && !under ? wm : '')
    + `</section>`;
}
