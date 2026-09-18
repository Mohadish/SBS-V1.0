/**
 * SBS — Document wiring (V0.3.4.0, phase D1): the project's 2D manual.
 * State + undo around the pure core, the step pictures, the PDF export.
 *
 * The document lives in the project (state.document → project.document);
 * the pictures do NOT — they are rendered on demand from the steps' own
 * final state (camera + overlay, no header: the document has its own), so
 * the project stays light and a picture can never disagree with its step.
 */

import { state }        from '../core/state.js';
import { undoManager }  from './undo.js';
import { setStatus }    from '../ui/status.js';
import sceneCore        from '../core/scene.js';
import { computeSafeFrameRect, getCanonicalSize } from '../core/safe-frame.js';
import { rasterizeOverlay, waitForOverlayStable } from './overlay.js';
import { steps }        from './steps.js';
import { srcHashOf }    from './language-packs.js';
import { projectDisplayName } from './header.js';
import * as projectPaths from '../core/project-paths.js';
import {
  emptyDocument, autoPaginate, reconcile, orderOf, mergeWithPrevious, splitBefore, clearFlags,
  buildRenderModel, stillsNeeded, narrationOf,
} from './document-core.js';
import { renderDocumentHtml } from './document-render.js';

const _clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const _steps = () => state.get('steps') || [];
const _chapters = () => state.get('chapters') || [];

export function getDocument() { return state.get('document') || null; }

/** One undoable write of the whole document record. */
function _commit(label, next) {
  const before = _clone(getDocument());
  const after  = _clone(next);
  const write = (d) => { state.setState({ document: d ? _clone(d) : null }); state.markDirty(); };
  write(after);
  undoManager.push(label, () => write(before), () => write(after));
}

// ─── building + syncing ─────────────────────────────────────────────────────

/** First build (or a rebuild from scratch): one page per step, texts kept. */
export function buildPages({ rebuild = false } = {}) {
  const cur = getDocument();
  const doc = cur && !rebuild ? _clone(cur) : { ...emptyDocument(), ...(cur ? { fields: cur.fields, header: cur.header, footer: cur.footer, options: cur.options, texts: cur.texts, templates: cur.templates, templateId: cur.templateId } : {}) };
  if (!doc.fields.title) doc.fields.title = projectDisplayName();
  doc.pages = autoPaginate(_steps(), _chapters(), doc);
  doc.order = orderOf(_steps(), _chapters(), doc);
  _commit(rebuild ? 'Rebuild document pages' : 'Build document pages', doc);
  setStatus(`Document: ${doc.pages.length} page(s), one per step. Merge the ones that belong together.`, 'success', 6000);
  return doc;
}

/** Bring the pages in line with the animation as it is now. */
export function syncWithAnimation() {
  const cur = getDocument();
  if (!cur) return null;
  const r = reconcile(cur, _steps(), _chapters());
  if (!r.report.length && JSON.stringify(r.pages.map(p => p.stepIds)) === JSON.stringify((cur.pages || []).map(p => p.stepIds))) {
    if (JSON.stringify(cur.order || []) !== JSON.stringify(r.order)) _commit('Sync document', { ...cur, pages: r.pages, order: r.order });
    setStatus('Document is in line with the animation.', 'info', 4000);
    return r;
  }
  _commit('Sync document with the animation', { ...cur, pages: r.pages, order: r.order });
  setStatus(`Document synced — ${r.report.length} change(s) flagged ❗ on the pages they touched.`, 'warn', 8000);
  return r;
}

/** Would a sync change anything? (the panel's banner) */
export function pendingSync() {
  const cur = getDocument();
  if (!cur) return 0;
  const r = reconcile(cur, _steps(), _chapters());
  return r.report.length + (JSON.stringify(r.pages.map(p => p.stepIds)) !== JSON.stringify((cur.pages || []).map(p => p.stepIds)) ? 1 : 0);
}

export function mergePageUp(pageId) {
  const cur = getDocument(); if (!cur) return;
  _commit('Merge page with the previous', { ...cur, pages: mergeWithPrevious(cur.pages, pageId) });
}
export function splitPageBefore(pageId, stepId) {
  const cur = getDocument(); if (!cur) return;
  _commit('Split page', { ...cur, pages: splitBefore(cur.pages, pageId, stepId) });
}
export function setPageTemplate(pageId, templateId) {
  const cur = getDocument(); if (!cur) return;
  _commit('Page template', { ...cur, pages: cur.pages.map(p => p.id === pageId ? { ...p, templateId } : p) });
}
/** stepId null = back to automatic (slot 0 follows the page's last step). */
export function setPagePicture(pageId, slot, stepId) {
  const cur = getDocument(); if (!cur) return;
  _commit('Page picture', { ...cur, pages: cur.pages.map(p => {
    if (p.id !== pageId) return p;
    const images = (p.images || []).map(i => ({ ...i }));
    while (images.length <= slot) images.push({ stepId: null });
    images[slot] = stepId ? { stepId } : { stepId: null, auto: slot === 0 };
    return { ...p, images };
  }) });
}
export function markPageReviewed(pageId = null) {
  const cur = getDocument(); if (!cur) return;
  _commit(pageId ? 'Page reviewed' : 'All pages reviewed', { ...cur, pages: clearFlags(cur.pages, pageId) });
}
export function deletePage(pageId) {
  const cur = getDocument(); if (!cur) return;
  _commit('Delete page', { ...cur, pages: cur.pages.filter(p => p.id !== pageId) });
}

/** The document's own text for a step. text null = follow the voiceover again. */
export function setDocText(stepId, text) {
  const cur = getDocument(); if (!cur) return;
  const texts = { ...(cur.texts || {}) };
  const step = _steps().find(s => s.id === stepId);
  if (text == null) delete texts[stepId];
  else texts[stepId] = { text: String(text), srcHash: srcHashOf(narrationOf(step)) };
  _commit(text == null ? 'Document text follows the voiceover' : 'Edit document text', { ...cur, texts });
}
/** "I have seen the new voiceover" — keep my text, clear the drift marker. */
export function acceptDrift(stepId) {
  const cur = getDocument(); if (!cur?.texts?.[stepId]) return;
  const step = _steps().find(s => s.id === stepId);
  _commit('Document text reviewed', { ...cur, texts: { ...cur.texts, [stepId]: { ...cur.texts[stepId], srcHash: srcHashOf(narrationOf(step)) } } });
}
export function setFields(patch) {
  const cur = getDocument(); if (!cur) return;
  _commit('Document fields', { ...cur, fields: { ...(cur.fields || {}), ...patch } });
}
export function setOptions(patch) {
  const cur = getDocument(); if (!cur) return;
  _commit('Document options', { ...cur, options: { ...(cur.options || {}), ...patch } });
}
export function setDefaultTemplate(templateId) {
  const cur = getDocument(); if (!cur) return;
  _commit('Default page template', { ...cur, templateId });
}

// ─── model + pictures ───────────────────────────────────────────────────────

export function renderModel() {
  const doc = getDocument();
  if (!doc) return { pages: [], total: 0 };
  return buildRenderModel(doc, _steps(), _chapters(), {
    projectName: projectDisplayName(), date: new Date().toISOString().slice(0, 10),
    hashOf: srcHashOf, perChapter: !!state.get('headerStepNumberPerChapter'),
  });
}

/** The logo the header shows: the project's first header image, if it has one. */
function _logo() {
  return (state.get('headerItems') || []).find(h => h.kind === 'image' && h.dataUrl && h.visible !== false)?.dataUrl || null;
}

const _stills = new Map();   // stepId → { sig, url }   (session cache)
const _sigOf = (s) => `${srcHashOf(JSON.stringify(s?.snapshot ?? null))}.${srcHashOf(String(s?.overlay ?? ''))}.${getCanonicalSize().width}`;

/** The export frame of the live viewport + the step's overlay, as a JPEG data URL. */
function _captureStill(W, H, dom) {
  if (!dom || !dom.width || !dom.height) return null;
  const cw = dom.clientWidth || dom.width, ch = dom.clientHeight || dom.height;
  const sf = computeSafeFrameRect({ width: cw, height: ch });
  if (!sf.width || !sf.height) return null;
  const k = dom.width / cw;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = state.get('backgroundColor') || '#0f172a';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(dom, sf.x * k, sf.y * k, sf.width * k, sf.height * k, 0, 0, W, H);
  try { const ov = rasterizeOverlay({ width: W, height: H }); if (ov) ctx.drawImage(ov, 0, 0, W, H); } catch (e) { console.warn('[document] overlay raster skipped:', e?.message || e); }
  return c.toDataURL('image/jpeg', 0.88);
}

/**
 * Pictures of the given steps' final state. Walks the steps that have no
 * fresh picture yet (each is activated once, instantly), then returns to
 * where the user was.
 * @returns {Promise<Map<string,string>>} stepId → data URL
 */
export async function ensureStills(stepIds, { onProgress = null } = {}) {
  const c = getCanonicalSize();
  const W = 1600, H = Math.round(W * c.height / c.width);
  const all = _steps();
  const todo = stepIds.filter(id => { const s = all.find(x => x.id === id); return s && _stills.get(id)?.sig !== _sigOf(s); });
  const startId = state.get('activeStepId');
  let i = 0;
  for (const id of todo) {
    i++;
    onProgress?.(i, todo.length);
    await steps.activateStep(id, false);
    try { await Promise.race([waitForOverlayStable?.(), new Promise(r => setTimeout(r, 1500))]); } catch { /* best effort */ }
    // grab INSIDE the next render, before the selection outline + gizmo are
    // composited; a frozen loop that never draws falls back to the canvas as is
    let url = await Promise.race([
      sceneCore.requestCleanFrame((dom) => _captureStill(W, H, dom)),
      new Promise(r => setTimeout(() => r(null), 600)),
    ]);
    if (!url) { sceneCore._pendingFrame = null; url = _captureStill(W, H, sceneCore.renderer?.domElement); }
    const s = all.find(x => x.id === id);
    if (url && s) _stills.set(id, { sig: _sigOf(s), url });
  }
  if (todo.length && startId) await steps.activateStep(startId, false);
  const out = new Map();
  for (const id of stepIds) { const e = _stills.get(id); if (e) out.set(id, e.url); }
  return out;
}

/** HTML of the whole document (or of one page) — preview and PDF share it. */
export async function documentHtml({ pageId = null, withStills = true, onProgress = null } = {}) {
  let model = renderModel();
  if (pageId) { const p = model.pages.filter(x => x.id === pageId); model = { pages: p, total: model.total }; }
  const stills = withStills ? await ensureStills(stillsNeeded(model), { onProgress }) : new Map();
  return renderDocumentHtml(model, { stills, logo: _logo(), title: getDocument()?.fields?.title || projectDisplayName() });
}

/**
 * Pages whose text does not fit its zone — it would be CUT OFF in the PDF, and
 * a manual must never lose a sentence silently. Measured in a hidden,
 * script-less frame with the real layout (pictures do not affect the text zone).
 * @returns {Promise<Array<{id:string, number:number}>>}
 */
export async function overflowingPages() {
  const html = await documentHtml({ withStills: false });
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-same-origin');
  f.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;visibility:hidden;border:0;';
  document.body.appendChild(f);
  try {
    await new Promise((res) => { f.addEventListener('load', res, { once: true }); f.srcdoc = html; setTimeout(res, 3000); });
    const out = [];
    f.contentDocument?.querySelectorAll('.page').forEach(pg => {
      const t = pg.querySelector('.txt');
      if (t && t.scrollHeight > t.clientHeight + 1) out.push({ id: pg.dataset.id, number: Number(pg.dataset.page) });
    });
    return out;
  } finally { f.remove(); }
}

// ─── PDF ────────────────────────────────────────────────────────────────────

export async function exportPdf() {
  const doc = getDocument();
  if (!doc?.pages?.length) { setStatus('Build the document pages first.', 'warn', 5000); return null; }
  if (!window.sbsNative?.printPdf) { setStatus('PDF export needs a full restart of the app (the export engine lives in the main process).', 'warn', 9000); return null; }
  const over = await overflowingPages().catch(() => []);
  if (over.length && !confirm(`The text does not fit on page ${over.map(o => o.number).join(', ')} —the end of it would be cut off in the PDF.\n\nShorten the text, split the page, or pick a template with more room for text.\n\nExport anyway?`)) return null;
  const base = (doc.fields?.docNo ? `${doc.fields.docNo} ` : '') + (doc.fields?.title || projectDisplayName());
  const dir = projectPaths.subDir?.('exports') || null;
  const safe = base.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'document';
  const defaultPath = dir ? `${dir}${dir.includes('\\') ? '\\' : '/'}${safe}.pdf` : `${safe}.pdf`;
  const out = await window.sbsNative.saveFile({ title: 'Export document as PDF', defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (!out) return null;
  const html = await documentHtml({ onProgress: (i, n) => setStatus(`Rendering step pictures… ${i}/${n}`, 'info', 0) });
  setStatus('Writing the PDF…', 'info', 0);
  const r = await window.sbsNative.printPdf(html, out);
  if (!r?.ok) { setStatus(`PDF export failed: ${r?.error || 'unknown error'}`, 'warn', 10000); return null; }
  setStatus(`Document exported — ${renderModel().total} page(s) → ${out}`, 'success', 10000);
  return out;
}

if (typeof window !== 'undefined') window.sbsDocument = { get: getDocument, build: buildPages, sync: syncWithAnimation, exportPdf, html: documentHtml };
