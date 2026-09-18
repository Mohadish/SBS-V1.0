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
import { cloneShareStrings } from '../core/clone.js';
import { watermarkOf }  from './watermark-core.js';
import { setStatus }    from '../ui/status.js';
import sceneCore        from '../core/scene.js';
import { getCanonicalSize } from '../core/safe-frame.js';
import { rasterizeOverlay, waitForOverlayStable } from './overlay.js';
import { rasterizeNotesLayer } from './notes-render.js';
import { rasterizeTagsLayer } from './hardware-insert-anim.js';
import { materials }     from './materials.js';
import { isIsolateEngaged, suspendIsolate, resumeIsolate } from '../core/isolate-state.js';
import { steps }        from './steps.js';
import { srcHashOf }    from './language-packs.js';
import { projectDisplayName } from './header.js';
import * as projectPaths from '../core/project-paths.js';
import {
  emptyDocument, autoPaginate, reconcile, orderOf, mergeWithPrevious, splitBefore, clearFlags,
  buildRenderModel, stillsNeeded, narrationOf, mergeUnits, splitAll,
} from './document-core.js';
import { renderDocumentHtml } from './document-render.js';

// structure cloned, STRINGS SHARED: the document can hold a baked watermark image, and a
// JSON round-trip would copy that data URL into every undo entry (the heap cage is ~3.5 GB)
const _clone = (v) => cloneShareStrings(v ?? null);
const _steps = () => state.get('steps') || [];
const _chapters = () => state.get('chapters') || [];

export function getDocument() { return state.get('document') || null; }

/** One undoable write of the whole document record. */
function _commit(label, next) {
  const before = _clone(getDocument());
  const after  = _clone(next);
  const write = (d) => { state.setState({ document: d ? _clone(d) : null }); state.markDirty(); };
  write(after);
  // scope: the workspace covers the animation — its Ctrl+Z must only ever act on entries like this one
  undoManager.push(label, () => write(before), () => write(after), { scope: 'document' });
}

// ─── building + syncing ─────────────────────────────────────────────────────

/** First build (or a rebuild from scratch): one page per step, texts kept. */
export function buildPages({ rebuild = false } = {}) {
  const cur = getDocument();
  const doc = cur && !rebuild ? _clone(cur) : { ...emptyDocument(), ...(cur ? { fields: cur.fields, header: cur.header, footer: cur.footer, options: cur.options, texts: cur.texts, templates: cur.templates, templateId: cur.templateId, watermark: watermarkOf(cur), hiddenSteps: cur.hiddenSteps || [] } : {}) };
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
/**
 * The workspace's multi-select merge: the selected steps (widened to the whole
 * range first..last) become ONE page. Document-side only — the animation, its
 * step groups and its numbering are not touched.
 * @returns {string|null} id of the merged page
 */
export function mergeSteps(unitIds) {
  const cur = getDocument(); if (!cur) return null;
  const r = mergeUnits(cur.pages, unitIds, orderOf(_steps(), _chapters(), cur));
  if (r.pages !== cur.pages) _commit('Merge steps into one page', { ...cur, pages: r.pages });
  return r.pageId;
}
/** Every step of the page back on a page of its own. */
export function splitPageAll(pageId) {
  const cur = getDocument(); if (!cur) return;
  const pages = splitAll(cur.pages, pageId);
  if (pages !== cur.pages) _commit('One page per step', { ...cur, pages });
}
export function splitPageBefore(pageId, stepId) {
  const cur = getDocument(); if (!cur) return;
  _commit('Split page', { ...cur, pages: splitBefore(cur.pages, pageId, stepId) });
}
export function setPageTemplate(pageId, templateId) {
  const cur = getDocument(); if (!cur) return;
  _commit('Page template', { ...cur, pages: cur.pages.map(p => p.id === pageId ? { ...p, templateId } : p) });
}
const _withSlot = (p, slot, make) => {
  const images = (p.images || []).map(i => ({ ...i }));
  while (images.length <= slot) images.push({ stepId: null, auto: true });     // a slot nobody touched yet is automatic
  images[slot] = make(images[slot]);
  return { ...p, images };
};
/** Pictures nobody shows any more are dropped from the document (undo brings the whole snapshot back). */
const _pruneAssets = (doc) => {
  const used = new Set((doc.pages || []).flatMap(p => (p.images || []).map(i => i.assetId).filter(Boolean)));
  const assets = {};
  for (const [id, a] of Object.entries(doc.assets || {})) if (used.has(id)) assets[id] = a;
  return { ...doc, assets };
};
const _editPage = (label, pageId, fn) => {
  const cur = getDocument(); if (!cur) return;
  _commit(label, _pruneAssets({ ...cur, pages: cur.pages.map(p => (p.id === pageId ? fn(p, cur) : p)) }));
};

/** choice: a step id · null = automatic (the page's steps are shared out over the slots) · 'empty'. A new picture starts un-cropped. */
export function setPagePicture(pageId, slot, choice) {
  _editPage('Page picture', pageId, (p) => _withSlot(p, slot, () => (
    choice === 'empty' ? { stepId: null, empty: true } : choice ? { stepId: choice } : { stepId: null, auto: true })));
}
/** How the picture sits behind its slot: { zoom, ox, oy } (see document-core pictureBox). null = fill the slot, centred. */
export function setPagePictureFit(pageId, slot, fit) {
  _editPage('Move / scale picture', pageId, (p) => _withSlot(p, slot, (im) => {
    const next = { ...im }; if (fit) next.fit = { zoom: fit.zoom, ox: fit.ox, oy: fit.oy }; else delete next.fit;
    return next;
  }));
}
/** A picture that is NOT part of the animation (a photo, a drawing). Stored in the document — asset = { dataUrl, w, h, name }. */
export function setPagePictureAsset(pageId, slot, asset) {
  const cur = getDocument(); if (!cur || !asset?.dataUrl) return;
  const id = `asset_${Date.now().toString(36)}${Math.floor(performance.now() % 1e6).toString(36)}`;
  const withAsset = { ...cur, assets: { ...(cur.assets || {}), [id]: { dataUrl: asset.dataUrl, w: asset.w, h: asset.h, name: asset.name || '' } } };
  _commit('External picture', _pruneAssets({ ...withAsset, pages: withAsset.pages.map(p => (p.id === pageId ? _withSlot(p, slot, () => ({ assetId: id })) : p)) }));
}
/** Leave steps out of the DOCUMENT (or bring them back). The animation is not touched; the page keeps them, so un-hiding restores everything. */
export function setStepsHidden(unitIds, hidden) {
  const cur = getDocument(); if (!cur) return;
  const set = new Set(cur.hiddenSteps || []);
  for (const id of unitIds || []) { if (hidden) set.add(id); else set.delete(id); }
  _commit(hidden ? 'Hide from the document' : 'Show in the document', { ...cur, hiddenSteps: [...set] });
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
/** 💧 The watermark printed on every page. patch = any of watermark-core's WATERMARK_DEFAULTS keys. */
export function setWatermark(patch) {
  const cur = getDocument(); if (!cur) return;
  _commit('Document watermark', { ...cur, watermark: { ...watermarkOf(cur), ...patch } });
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
    stillAspect: getCanonicalSize().aspect,          // a step picture is the export frame
  });
}

/** The logo the header shows: the project's first header image, if it has one. */
function _logo() {
  return (state.get('headerItems') || []).find(h => h.kind === 'image' && h.dataUrl && h.visible !== false)?.dataUrl || null;
}

const _stills = new Map();   // stepId → { sig, url }   (session cache)

// A picture is fresh while everything it is drawn from is unchanged: the step's
// own snapshot + overlay, AND the project-level definitions those only refer to
// by id (a colour preset, a text style, a pinned position, a crop mask…).
const PICTURE_KEYS = ['colorPresets', 'styleTemplates', 'shapeStyles', 'constTextBoxes', 'constShapes', 'cropMasks', 'backgroundColor', 'activeLang', 'export'];
const _defsSig = () => srcHashOf(JSON.stringify(PICTURE_KEYS.map(k => state.get(k) ?? null)));
const _sigOf = (s, defs = _defsSig()) => `${srcHashOf(JSON.stringify(s?.snapshot ?? null))}.${srcHashOf(String(s?.overlay ?? ''))}.${defs}`;
/** "Render the pictures again" — for the changes no signature can see (geometry reloaded, render settings…). */
export function clearStills() { _stills.clear(); }

/**
 * One export frame, composed exactly like a video frame (minus the header —
 * the page has its own): 3D, then overlay, notes, hardware tags.
 *
 * The renderer's buffer IS the canonical frame (fitToCanonical sizes it to
 * export W × H at the canonical aspect) — it is NOT the viewport, so there is
 * nothing to letterbox-crop. What does differ from the export is the live
 * OVERSCAN (safe frame shown → camera zoomed out by 1/ov): ensureStills turns
 * export framing on for the walk; the centre crop below only covers a grab
 * that happens with overscan still in force.
 */
function _captureStill(W, H, dom) {
  if (!dom || !dom.width || !dom.height) return null;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = state.get('backgroundColor') || '#0f172a';
  ctx.fillRect(0, 0, W, H);
  const ov = sceneCore.getEffectiveOverscan?.() || 1;
  const sw = dom.width / ov, sh = dom.height / ov;
  ctx.drawImage(dom, (dom.width - sw) / 2, (dom.height - sh) / 2, sw, sh, 0, 0, W, H);
  for (const [name, fn] of [['overlay', rasterizeOverlay], ['notes', rasterizeNotesLayer], ['tags', rasterizeTagsLayer]]) {
    try { const l = fn({ width: W, height: H }); if (l) ctx.drawImage(l, 0, 0, W, H); }
    catch (e) { console.warn(`[document] ${name} layer skipped:`, e?.message || e); }
  }
  return c.toDataURL('image/jpeg', 0.88);
}

let _walkAbort = false;
/** Stop a pictures walk after the step it is on (the workspace closed). */
export function abortStillsWalk() { _walkAbort = true; }

/**
 * Pictures of the given steps' final state. Walks the steps that have no
 * fresh picture yet (each is activated once, instantly), then returns to
 * where the user was.
 *
 * The walk borrows the VIDEO EXPORT's capture context, because a page picture
 * must be the frame the video shows: _exporting (recorded cameras even with
 * Work Camera on, no authoring markers, no autosave mid-walk), the tight export
 * framing, isolate suspended, placeholder boxes per the export setting, the
 * selection highlight hidden. Everything is put back in finally.
 * A video export that is already running owns the scene — then nothing is
 * walked and only cached pictures are returned.
 * @returns {Promise<Map<string,string>>} stepId → data URL
 */
export async function ensureStills(stepIds, { onProgress = null } = {}) {
  const c = getCanonicalSize();
  const W = Math.min(c.width, 1920), H = Math.round(W * c.height / c.width);
  const all = _steps();
  const defs = _defsSig();
  const foreign = !!state.get('_exporting');
  const todo = foreign ? [] : stepIds.filter(id => { const s = all.find(x => x.id === id); return s && _stills.get(id)?.sig !== _sigOf(s, defs); });
  const once = new Map();      // a fallback grab is shown but never cached as fresh
  if (todo.length) {
    _walkAbort = false;
    const startId = state.get('activeStepId');
    const userCam = state.get('workCamera') === true ? sceneCore.getCameraState?.() : null;
    const hadIso = isIsolateEngaged();
    const hideBoxes = !(state.get('export') || {}).exportBoundaryBoxes;
    const prevFraming = !!sceneCore._exportFraming;
    state.setState({ _exporting: true });
    sceneCore.setExportFraming(true);
    if (hadIso) suspendIsolate();
    if (hideBoxes) steps.setPlaceholderBboxesVisible(false);
    let i = 0;
    try {
      for (const id of todo) {
        if (_walkAbort) break;
        i++;
        onProgress?.(i, todo.length);
        await steps.activateStep(id, false);
        try { await Promise.race([waitForOverlayStable?.(), new Promise(r => setTimeout(r, 1500))]); } catch { /* best effort */ }
        // activation re-applies materials and with them the selection highlight — hide it per step
        try { materials.setSelectionVisualsVisible(false); } catch { /* no meshes yet */ }
        // grab INSIDE the next render, before the outline + gizmo are composited
        let url = await Promise.race([
          sceneCore.requestCleanFrame((dom) => _captureStill(W, H, dom)),
          new Promise(r => setTimeout(() => r(null), 1500)),
        ]);
        const s = all.find(x => x.id === id);
        if (url && s) _stills.set(id, { sig: _sigOf(s, defs), url });
        else {
          sceneCore._pendingFrame = null;
          url = _captureStill(W, H, sceneCore.renderer?.domElement);
          if (url) once.set(id, url);
          console.warn('[document] no clean frame for step', id, '— used the canvas as it is; it will be rendered again next time');
        }
      }
    } finally {
      try { materials.setSelectionVisualsVisible(true); } catch { /* nothing to restore */ }
      if (hideBoxes) steps.setPlaceholderBboxesVisible(true);
      if (hadIso) resumeIsolate();
      sceneCore.setExportFraming(prevFraming);
      state.setState({ _exporting: false });
    }
    if (startId) await steps.activateStep(startId, false);
    if (userCam) { try { sceneCore.applyCameraState(userCam); } catch { /* keep the step's camera */ } }   // Work Camera: the free view comes back
  }
  const out = new Map();
  for (const id of stepIds) { const e = _stills.get(id); if (e) out.set(id, e.url); else if (once.has(id)) out.set(id, once.get(id)); }
  return out;
}

/** The pictures already rendered this session and still fresh — no step is activated. */
export function cachedStills(stepIds) {
  const all = _steps(), out = new Map(), defs = _defsSig();
  for (const id of stepIds || []) {
    const s = all.find(x => x.id === id), e = _stills.get(id);
    if (s && e && e.sig === _sigOf(s, defs)) out.set(id, e.url);
  }
  return out;
}
export const documentLogo = () => _logo();

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
  if (state.get('_exporting')) { setStatus('A video export is running — export the PDF when it has finished.', 'warn', 7000); return null; }
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
