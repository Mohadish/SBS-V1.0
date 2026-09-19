/**
 * 📄 Document workspace (V0.3.4.1) — Tools ▸ Document…
 *
 * A full takeover: while it is open the animation UI is covered and its
 * shortcuts are silent. RIGHT — every step of the animation with its
 * thumbnail, boxed by the page it prints on; select several and merge them
 * into one page. CENTRE — the page itself, A4 in true proportion, the very
 * markup the PDF is printed from: click a line to rewrite it, click a picture
 * to choose its step. LEFT — the document's fields and the selected page.
 *
 * Everything here writes to state.document only. The animation — steps,
 * groups, numbering, voiceover — is never touched.
 */

import { state } from '../core/state.js';
import { undoManager } from '../systems/undo.js';
import { setStatus } from './status.js';
import { srcHashOf } from '../systems/language-packs.js';
import { numberSteps } from '../systems/translation-sheet-core.js';
import { builtinTemplates, docTextFor, pageRangeLabel, unitsOf, stillsNeeded, pictureBox, containZoom, slotState, directionOf, bandsOf, BAND_MM } from '../systems/document-core.js';
import { DOCUMENT_CSS, renderPageHtml, renderTocPageHtml, renderCustomPageHtml, slotInnerHtml } from '../systems/document-render.js';
import { watermarkOf, watermarkHtml, watermarkCss, watermarkVisible, detectWatermarkMode, bakeWatermarkPixels, fitWithin } from '../systems/watermark-core.js';
import * as D from '../systems/document.js';
import { openTemplateEditor } from './document-template-editor.js';

const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FLAG_ICON = { added: '➕', removed: '➖', 'moved-out': '↗', new: '🆕', 'image-left': '🖼', empty: '∅' };
const PAGE_W = 210 * 96 / 25.4, PAGE_H = 297 * 96 / 25.4;      // A4 in CSS px
const TOC = '@toc';                                            // the "page" id of the table of contents in the workspace

let _root = null, _shadow = null, _statusObs = null;
let _sel = new Set(), _anchor = null, _pageId = null, _zoom = 'fit';
let _walking = false, _walkAgain = false, _exporting = false, _deferred = false, _menu = null, _renderTimer = 0;
let _ptrDown = false, _renderHeld = false;
let _wmOpen = false, _wmDlg = null;
let _slotSel = null, _pageModel = null, _pageLang = null, _assetSlot = 0;
let _tplEd = null;                        // the open template editor, if any

// page-editing affordances — live ONLY in the workspace, never in the PDF
const EDIT_CSS = `
:host { all: initial; }
.fit { transform-origin: 0 0; }
.page { box-shadow: 0 6px 30px rgba(0,0,0,.55); }
.tx { outline: 0.3mm dashed transparent; outline-offset: 0.6mm; border-radius: 0.6mm; cursor: text; min-height: 5mm; }
.tx:hover { outline-color: #60a5fa; }
.tx:focus { outline: 0.4mm solid #2563eb; background: #eff6ff; }
.it.edited .no { box-shadow: 0 0 0 0.5mm #2563eb; }
.it.drifted .no { box-shadow: 0 0 0 0.5mm #f59e0b; }
.slot { cursor: pointer; }
.slot:hover { outline: 0.4mm solid #60a5fa; outline-offset: -0.4mm; }
.slot.sel { outline: 0.7mm solid #2563eb; outline-offset: -0.7mm; }
.slot img.pic { cursor: grab; user-select: none; -webkit-user-drag: none; }
.slot.sel img.pic:active { cursor: grabbing; }
.hdr, .ftr, .ci[data-band] { cursor: pointer; }
.hdr:hover, .ftr:hover { background: #eff6ff; }
.fit:not(.bandmode) .ci[data-band]:hover { outline: 0.3mm dashed #60a5fa; }
.bandmode .page > :not([data-band]):not(.brule):not(.csel):not(.cguide) { opacity: .28; pointer-events: none; }
.bandmode .ci[data-band] { cursor: move; }
.txt.over { outline: 0.5mm solid #dc2626; outline-offset: -0.5mm; }
.txt.over::after { content: '✂ the text does not fit — the end is cut off in the PDF'; position: absolute; right: 0; bottom: 0; background: #dc2626; color: #fff; font-size: 8pt; padding: 0.6mm 2mm; border-top-left-radius: 1.2mm; }
`;

export function openDocumentWorkspace() {
  if (state.get('_exporting')) { setStatus('A video export is running — open the document when it has finished.', 'warn', 7000); return; }
  if (!_root) _build();
  _root.style.display = 'flex';
  if (!_pageId || !D.getDocument()?.pages?.some(p => p.id === _pageId)) _pageId = D.getDocument()?.pages?.[0]?.id || null;
  _renderAll();
  _root.focus();
}

export function closeDocumentWorkspace() {
  if (!_root) return;
  if (_exporting) { setStatus('The PDF is being written — one moment.', 'info', 4000); return; }
  D.abortStillsWalk();          // the walk drives the live scene; it must not go on behind an open animation
  _commitFocusedText();
  _closeMenu();
  _wmDlg?.remove(); _wmDlg = null;
  _flushWheel(); _slotSel = null; _placeSlotBar();
  _tplEd?.close(); _tplEd = null; _dimPanes(false);
  { const a = _shadow?.activeElement; if (a?.isContentEditable) a.blur(); }
  _customSel = null; _bandEdit = null; _root.querySelector('#dw-custombar')?.remove();
  _root.style.display = 'none';
}
const _isOpen = () => !!_root && _root.style.display !== 'none';

// ─── shell ──────────────────────────────────────────────────────────────────

function _build() {
  _root = document.createElement('div');
  _root.id = 'document-workspace';
  _root.tabIndex = -1;
  _root.style.cssText = 'position:fixed;inset:0;z-index:9000;display:flex;flex-direction:column;background:#0b1220;color:#e2e8f0;font-size:13px;outline:none;';
  _root.innerHTML = `
    <style>
      #document-workspace .dw-btn { background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:7px;padding:5px 12px;font:inherit;font-size:12.5px;cursor:pointer; }
      #document-workspace .dw-btn:hover:not(:disabled) { background:#273449; }
      #document-workspace .dw-btn:disabled { opacity:.4;cursor:default; }
      #document-workspace .dw-btn.primary { color:#22d3ee;font-weight:600; }
      #document-workspace .dw-btn.warn { color:#fbbf24;font-weight:600;border-color:#b45309; }
      #document-workspace .dw-in { background:#0b1220;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:4px 7px;font:inherit;font-size:12.5px;width:100%;box-sizing:border-box; }
      #document-workspace select.dw-in { height:27px;padding:2px 5px; }
      #document-workspace .dw-h { font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;margin:14px 0 6px; }
      #document-workspace .dw-lab { font-size:10.5px;color:#94a3b8;display:flex;flex-direction:column;gap:2px;margin-bottom:6px; }
      #document-workspace a { color:#93c5fd;cursor:pointer;text-decoration:none; } #document-workspace a:hover { text-decoration:underline; }
      #document-workspace .dw-pagebox { border:1px solid #334155;border-radius:9px;margin:0 8px 8px;background:#111a2c;overflow:hidden; }
      #document-workspace .dw-pagebox.cur { border-color:#38bdf8;box-shadow:0 0 0 1px #38bdf8; }
      #document-workspace .dw-pagebox.flag { border-color:#f59e0b; }
      #document-workspace .dw-pagehead { display:flex;gap:6px;align-items:center;padding:4px 8px;font-size:11px;color:#94a3b8;background:#0f172a;cursor:pointer; }
      #document-workspace .dw-step { display:flex;gap:8px;align-items:center;padding:5px 8px;cursor:pointer;border-top:1px solid #1e293b;user-select:none; }
      #document-workspace .dw-step:hover { background:#16213a; }
      #document-workspace .dw-step.sel { background:#1d3a5f; }
      #document-workspace .dw-step.pending { opacity:.5; }
      #document-workspace .dw-step.hid > :not(.dw-eye) { opacity:.38; }
      #document-workspace .dw-step.hid .dw-name { text-decoration:line-through; }
      #document-workspace .dw-eye { flex:0 0 auto;width:26px;text-align:center;font-size:14px;opacity:.25;border-radius:5px;padding:2px 0; }
      #document-workspace .dw-step:hover .dw-eye, #document-workspace .dw-step.hid .dw-eye { opacity:1; }
      #document-workspace .dw-eye:hover { background:#273449;text-decoration:none; }
      #document-workspace .dw-thumb { width:84px;height:48px;flex:0 0 auto;border-radius:4px;background:#1e293b;border:1px solid #334155;object-fit:cover;display:block; }
      #document-workspace .dw-no { flex:0 0 auto;min-width:26px;text-align:center;font-weight:700;font-size:11.5px;background:#0b1220;border:1px solid #334155;border-radius:9px;padding:1px 6px; }
      #document-workspace .dw-pgrow { display:flex;gap:9px;align-items:center; }
      #document-workspace .dw-pagehead.dw-pgrow { padding:6px 8px; }
      #document-workspace .dw-pagehead.sel { background:#1d3a5f; }
      #document-workspace .dw-pagethumb { flex:0 0 auto;display:block;width:64px;height:91px;border:1px solid #334155;border-radius:3px;background:#1e293b;overflow:hidden; }
      #document-workspace .dw-step.mini { padding:3px 8px 3px 14px;gap:7px; }
      #document-workspace .dw-grip { flex:0 0 auto;cursor:grab;color:#64748b;font-size:15px;padding:0 1px;user-select:none;touch-action:none; }
      #document-workspace .dw-grip:hover { color:#38bdf8; }
      #document-workspace .dw-pagebox.movable { border-style:solid;border-color:#475569;background:#0f1b30; }
      #document-workspace .dw-pagebox.dragging { opacity:.45; }
      #document-workspace #dw-list { position:relative; }
      #document-workspace .dw-dropline { position:absolute;left:6px;right:6px;height:3px;border-radius:2px;background:#38bdf8;box-shadow:0 0 0 2px rgba(56,189,248,.25);pointer-events:none; }
      #document-workspace .dw-split { flex:0 0 7px;cursor:col-resize;background:#0b1220;border-left:1px solid #334155;border-right:1px solid #334155;touch-action:none; }
      #document-workspace .dw-split:hover, #document-workspace .dw-split.on { background:#38bdf8; }
      #document-workspace .dw-chap { margin:10px 10px 6px;font-size:11px;font-weight:700;color:#cbd5e1;letter-spacing:.04em; }
      #document-workspace .dw-menu { position:fixed;z-index:9100;background:#0f172a;border:1px solid #334155;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.6);padding:4px;min-width:230px;max-height:60vh;overflow:auto; }
      #document-workspace .dw-menu > div { padding:6px 10px;border-radius:5px;cursor:pointer;font-size:12.5px; } #document-workspace .dw-menu > div:hover { background:#1d3a5f; }
      #document-workspace .dw-menu > div.cur { background:#16324f;box-shadow:inset 3px 0 0 #38bdf8; }
      #document-workspace .dw-prow { display:flex;gap:10px;align-items:center; }
      #document-workspace .dw-pthumb { position:relative;flex:0 0 auto;width:96px;height:54px;border-radius:5px;border:1px solid #334155;background:#1e293b;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#64748b;font-size:10.5px; }
      #document-workspace .dw-pthumb img { width:100%;height:100%;object-fit:cover;display:block; }
      #document-workspace .dw-pthumb .tag { position:absolute;left:0;bottom:0;background:#f59e0b;color:#111;font-size:9.5px;font-weight:700;padding:0 5px;border-top-right-radius:4px; }
      #document-workspace .dw-pick { display:flex;gap:9px;align-items:center;width:100%;box-sizing:border-box;background:#0b1220;color:#e2e8f0;border:1px solid #334155;border-radius:7px;padding:4px 8px 4px 4px;font:inherit;font-size:12px;cursor:pointer;text-align:start; }
      #document-workspace .dw-pick:hover { border-color:#38bdf8; }
      #document-workspace .dw-pick .dw-pthumb { width:64px;height:36px; }
    </style>
    <div id="dw-top" style="flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 12px;background:#111a2c;border-bottom:1px solid #334155;">
      <span style="font-weight:700;font-size:14px;">📄 Document</span>
      <span id="dw-status" style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#94a3b8;font-size:12px;padding:0 10px;"></span>
      <span id="dw-actions" style="display:flex;gap:8px;align-items:center;"></span>
      <input type="file" id="dw-asset-file" accept="image/*" hidden>
      <button class="dw-btn" data-act="close" title="Close the document workspace — nothing is lost, the document is part of the project">◀ Edit animation</button>
    </div>
    <div style="flex:1 1 auto;min-height:0;display:flex;">
      <div id="dw-left"  style="flex:0 0 290px;min-width:0;min-height:0;overflow:auto;padding:4px 14px 16px;background:#0f172a;box-sizing:border-box;"></div>
      <div class="dw-split" data-split="l" title="Drag to resize · double-click to fold the settings away"></div>
      <div id="dw-center" style="flex:1 1 auto;min-width:0;min-height:0;overflow:auto;background:#334155;position:relative;"></div>
      <div class="dw-split" data-split="r" title="Drag to resize · double-click to fold the page list away"></div>
      <div id="dw-right" style="flex:0 0 330px;min-width:0;min-height:0;display:flex;flex-direction:column;background:#0f172a;">
        <div id="dw-selbar" style="flex:0 0 auto;padding:8px;border-bottom:1px solid #334155;display:flex;flex-direction:column;gap:6px;"></div>
        <div id="dw-list" style="flex:1 1 auto;min-height:0;overflow:auto;padding-top:6px;"></div>
      </div>
    </div>`;
  document.body.appendChild(_root);

  // the page lives in a shadow root: the app's stylesheet cannot leak into it,
  // so it looks exactly like the script-less window the PDF is printed from
  const host = document.createElement('div');
  host.id = 'dw-pagehost';
  host.style.cssText = 'position:absolute;left:0;top:0;';
  _root.querySelector('#dw-center').appendChild(host);
  _shadow = host.attachShadow({ mode: 'open' });

  _root.addEventListener('click', _onClick);
  _root.addEventListener('change', _onChange);
  // 💧 live: sliders, colour and text redraw the mark while they move; the commit (one undo entry) comes with 'change'
  _root.addEventListener('input', (e) => {
    const t = e.target; if (!t.dataset?.wm) return;
    const v = _wmValue(t);
    _previewWatermark({ [t.dataset.wm]: v });
    const out = _root.querySelector(`[data-wm-out="${t.dataset.wm}"]`);
    if (out) out.textContent = t.dataset.wm === 'opacity' ? _pct(v) : t.dataset.wm === 'angle' ? `${Math.round(v)}°` : `${Math.round(v)}%`;
  });
  _root.addEventListener('mousedown', (e) => {
    if (_menu && !_menu.contains(e.target)) _closeMenu();
    // keep the keyboard inside the workspace: a click on dead space must not drop focus to <body>
    const t = e.composedPath()[0];
    if (!(t instanceof HTMLElement) || !t.closest?.('input,textarea,select,button,a,[contenteditable]')) setTimeout(() => { if (_isOpen() && (document.activeElement === document.body || !document.activeElement)) _root.focus(); }, 0);
  });
  // ── keyboard isolation ── two layers. The app's MAIN shortcut handler is
  // capture-phase on window (it runs before anything here can stop it), so its
  // gate lives in main.js: _takeoverOpen() + a shadow-aware _isInputFocused().
  // The bubble-phase window listeners (undo/redo, overlay Delete…) are stopped here.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    _root.addEventListener(type, (e) => {
      const t = e.composedPath()[0];
      const editable = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (type === 'keydown') _onKey(e, editable);
      const mod = e.ctrlKey || e.metaKey;
      let passes = !editable && mod && /^(Key[ZYS])$/.test(e.code);        // undo / redo / save still belong to the app…
      if (passes && e.code !== 'KeyS') {
        // …but the undo stack is shared with the animation, which is out of sight
        // behind this cover: only a DOCUMENT entry may be undone / redone from here
        const redo = e.code === 'KeyY' || e.shiftKey;
        if ((redo ? undoManager.redoScope() : undoManager.undoScope()) !== 'document') {
          passes = false;
          if (type === 'keydown') setStatus(redo ? 'Nothing to redo in the document.' : 'Nothing more to undo in the document — the next undo step belongs to the animation.', 'info', 5000);
        }
      }
      if (!passes) e.stopPropagation();
    });
  }
  // A line commits on focusout — i.e. on the MOUSEDOWN of the next click — and
  // the re-render it triggers would replace the element under the pointer
  // before mouseup: the click was lost. Hold every re-render while a button is down.
  _root.addEventListener('pointerdown', () => { _ptrDown = true; }, true);
  const release = () => { if (!_ptrDown) return; _ptrDown = false; if (_pan) _onSlotPointerUp(); if (_cdrag) _onCustomPointerUp();   // a drag released outside the page still ends (and commits) here
    if (_renderHeld) { _renderHeld = false; setTimeout(() => { if (_isOpen()) _renderAll(); }, 0); } };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  _shadow.addEventListener('focusout', (e) => { if (e.target?.classList?.contains('tx')) _commitText(e.target); });
  _shadow.addEventListener('input', () => _markOverflow());
  _shadow.addEventListener('click', _onPageClick);
  _shadow.addEventListener('pointerdown', _onSlotPointerDown);
  _shadow.addEventListener('pointerdown', _onCustomPointerDown);
  _shadow.addEventListener('pointermove', _onCustomPointerMove);
  _shadow.addEventListener('pointerup', _onCustomPointerUp);
  _shadow.addEventListener('pointercancel', _onCustomPointerUp);
  _shadow.addEventListener('dblclick', _onCustomDblClick);
  _shadow.addEventListener('focusout', _onCustomFocusOut);
  _shadow.addEventListener('pointermove', _onSlotPointerMove);
  _shadow.addEventListener('pointerup', _onSlotPointerUp);
  _shadow.addEventListener('pointercancel', _onSlotPointerUp);
  _shadow.addEventListener('wheel', _onSlotWheel, { passive: false });
  _root.addEventListener('contextmenu', _onContextMenu);
  _root.addEventListener('pointerdown', _onGripDown);
  _root.addEventListener('pointerdown', _onSplitDown);
  _root.addEventListener('dblclick', (e) => { const sp = e.target.closest?.('.dw-split'); if (sp) _togglePane(sp.dataset.split); });
  window.addEventListener('pointermove', (e) => { _onGripMove(e); _onSplitMove(e); });
  window.addEventListener('pointerup', () => { _onGripUp(); _onSplitUp(); });
  window.addEventListener('pointercancel', () => { _onGripUp(); _onSplitUp(); });
  _applyPanes();
  _root.querySelector('#dw-center').addEventListener('scroll', () => _placeSlotBar());
  _root.querySelector('#dw-center').addEventListener('pointerdown', (e) => { if (e.target.id === 'dw-center' && _slotSel != null) _selectSlot(null); });

  window.addEventListener('resize', () => { if (_isOpen()) { _applyPanes(); _fit(); } });
  // coalesced: a pictures walk activates steps and can fire change:steps once per step
  const rerender = () => { if (!_isOpen()) return; clearTimeout(_renderTimer); _renderTimer = setTimeout(() => { if (_isOpen()) _renderAll(); }, 60); };
  for (const k of ['document', 'steps', 'chapters', 'headerItems', 'headerStepNumberPerChapter']) state.on(`change:${k}`, rerender);

  // the app's status chip is covered — mirror it into the top bar
  const bar = document.getElementById('status-bar');
  if (bar) {
    const out = _root.querySelector('#dw-status');
    const sync = () => { out.textContent = bar.textContent || ''; out.style.color = /--(warn|danger)/.test(bar.className) ? '#fbbf24' : /--(ok|success)/.test(bar.className) ? '#4ade80' : '#94a3b8'; };
    _statusObs = new MutationObserver(sync);
    _statusObs.observe(bar, { childList: true, characterData: true, subtree: true, attributes: true });
  }
}

// ─── data the three panes share ─────────────────────────────────────────────

function _ctx() {
  const doc = D.getDocument();
  const steps = state.get('steps') || [], chapters = state.get('chapters') || [];
  const perChapter = !!state.get('headerStepNumberPerChapter');
  const units = unitsOf(steps, chapters, doc?.options);
  const pageOfUnit = new Map();
  for (const p of doc?.pages || []) for (const id of p.stepIds || []) if (!pageOfUnit.has(id)) pageOfUnit.set(id, p);
  let model = null;
  const customIds = new Set((doc?.extras || []).filter(x => x?.kind === 'custom').map(x => x.id));
  return { customIds, get model() { return model || (model = D.renderModel()); }, doc, steps, chapters, perChapter, units, pageOfUnit, hidden: new Set(doc?.hiddenSteps || []), stepById: new Map(steps.map(s => [s.id, s])), nums: numberSteps(steps, chapters, perChapter) };
}

function _renderAll() {
  if (_exporting) { _deferred = true; return; }
  if (_ptrDown) { _renderHeld = true; return; }
  const c = _ctx();
  if (!c.doc || !c.doc.pages?.length) { _renderEmpty(); return _holdFocus(); }
  if (_pageId === TOC ? !c.model.toc : !(c.doc.pages.some(p => p.id === _pageId) || c.customIds.has(_pageId))) _pageId = c.doc.pages[0].id;
  for (const id of [..._sel]) if (!c.units.some(u => u.id === id)) _sel.delete(id);
  _renderTop(c); _renderLeft(c); _renderList(c); _renderPage(c);
  _holdFocus();
}

/** A rebuild can delete the element that had the focus (the button just clicked): never let it fall to <body>, where the workspace's keys are dead. */
function _holdFocus() {
  if (_isOpen() && (!document.activeElement || document.activeElement === document.body)) _root.focus({ preventScroll: true });
}

function _renderEmpty() {
  _root.querySelector('#dw-actions').innerHTML = '';
  _root.querySelector('#dw-left').innerHTML = '';
  _root.querySelector('#dw-selbar').innerHTML = '';
  _root.querySelector('#dw-list').innerHTML = '';
  _shadow.innerHTML = '';
  const c = _root.querySelector('#dw-center');
  let e = c.querySelector('#dw-empty');
  if (!e) { e = document.createElement('div'); e.id = 'dw-empty'; c.appendChild(e); }
  e.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;';
  e.innerHTML = `<div style="max-width:520px;background:#0f172a;border:1px solid #334155;border-radius:12px;padding:26px 28px;line-height:1.6;">
      <div style="font-size:17px;font-weight:700;margin-bottom:8px;">Turn the animation into a printed manual</div>
      <div style="color:#94a3b8;">Every page covers one or more steps: their text on top — the voiceover, until you rewrite it here — and a picture of their final state, inside a fixed A4 template with a header and a footer. The document keeps its own copy of everything: nothing you do here changes the animation.</div>
      <div style="margin-top:16px;"><button class="dw-btn primary" data-act="build" style="padding:8px 18px;font-size:13.5px;">Build the pages — one per step</button></div>
    </div>`;
}

function _renderTop(c) {
  _root.querySelector('#dw-empty')?.remove();
  const pending = D.pendingSync();
  const flagged = c.doc.pages.filter(p => (p.flags || []).length).length;
  _root.querySelector('#dw-actions').innerHTML = `
    <button class="dw-btn${pending ? ' warn' : ''}" data-act="sync" title="Bring the pages in line with the animation as it is now. Every change is marked ❗ on the page it touched.">${pending ? '⟳ The animation changed — sync' : '⟳ Sync with the animation'}</button>
    ${flagged ? `<button class="dw-btn" data-act="reviewed-all">✓ Clear all ❗ (${flagged})</button>` : ''}
    <span style="display:inline-flex;border:1px solid #334155;border-radius:7px;overflow:hidden;">
      <button class="dw-btn" data-act="zoom-fit" style="border:0;border-radius:0;${_zoom === 'fit' ? 'background:#1d3a5f;' : ''}">Fit</button>
      <button class="dw-btn" data-act="zoom-100" style="border:0;border-radius:0;${_zoom === '100' ? 'background:#1d3a5f;' : ''}">100%</button>
    </span>
    <button class="dw-btn primary" data-act="export">⬇ Export PDF…</button>`;
}

// ─── LEFT: document + page ──────────────────────────────────────────────────

function _renderLeft(c) {
  const left = _root.querySelector('#dw-left');
  const keep = left.scrollTop;
  const f = c.doc.fields || {};
  const onToc = _pageId === TOC, custom = (c.doc.extras || []).find(x => x?.kind === 'custom' && x.id === _pageId) || null;
  const page = (onToc || custom) ? c.doc.pages[0] : c.doc.pages.find(p => p.id === _pageId);
  const pi = c.doc.pages.indexOf(page);
  const tpls = [...builtinTemplates(), ...(c.doc.templates || [])];
  const tplNow = tpls.find(t => t.id === page.templateId) || tpls[0];
  const members = (page.stepIds || []).flatMap(id => c.units.find(u => u.id === id)?.members || []);
  const flags = page.flags || [];
  const label = (sid) => `${c.nums.get(sid)?.label ? c.nums.get(sid).label + ' · ' : ''}${c.stepById.get(sid)?.name || sid}`;
  const modelPage = D.renderModel().pages.find(p => p.id === _pageId) || null;     // what each frame resolves to right now

  const lines = members.map(sid => {
    const s = c.stepById.get(sid); if (!s) return '';
    const t = docTextFor(s, c.doc.texts, srcHashOf);
    if (!t.text.trim() && !t.edited && !(page.stepIds || []).includes(sid)) return '';
    return `<div style="margin:0 0 7px;font-size:11.5px;line-height:1.45;">
      <b>${_esc(c.nums.get(sid)?.label || '•')}</b>
      ${t.edited ? (t.drifted ? '<span style="color:#fbbf24;">⚠ the voiceover changed after you rewrote this</span>' : '<span style="color:#60a5fa;">rewritten for the document</span>') : '<span style="color:#94a3b8;">follows the voiceover</span>'}
      ${t.drifted ? `<div dir="auto" style="color:#94a3b8;margin:2px 0;">voiceover now: “${_esc(String(s.narration?.text ?? s.voiceText ?? ''))}”</div>` : ''}
      ${t.edited ? `<div><a data-act="reset-text" data-step="${_esc(sid)}">use the voiceover again</a>${t.drifted ? ` · <a data-act="accept-drift" data-step="${_esc(sid)}">keep mine</a>` : ''}</div>` : ''}
    </div>`;
  }).join('');

  const docHtml = `
    <div class="dw-h">Document</div>
    ${[['title', 'Title'], ['company', 'Company'], ['docNo', 'Document no.'], ['rev', 'Revision']].map(([k, l]) => `<label class="dw-lab">${l}<input class="dw-in" data-field="${k}" value="${_esc(f[k] || '')}" dir="auto"></label>`).join('')}
    <label class="dw-lab">Step numbers
      <select class="dw-in" data-opt="numbering">${[['step', 'The same numbers as the animation'], ['page', '1, 2, 3 on every page'], ['none', 'No numbers']].map(([v, l]) => `<option value="${v}"${(c.doc.options?.numbering || 'step') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <label style="display:flex;gap:8px;align-items:center;margin:0 0 7px;font-size:11.5px;color:#cbd5e1;"><input type="checkbox" data-opt="pictureNumbers"${c.doc.options?.pictureNumbers !== false ? ' checked' : ''}> Step number on each picture (pages with several steps)</label>
    <label style="display:flex;gap:8px;align-items:center;margin:0 0 7px;font-size:11.5px;color:#cbd5e1;" title="A contents page opens the document: every chapter with the page it starts on. It counts as page 1."><input type="checkbox" data-opt="toc"${c.doc.options?.toc !== false ? ' checked' : ''}> Table of contents (chapters → pages)</label>
    <label class="dw-lab">Reading direction
      <select class="dw-in" data-opt="direction">${(() => { const r = directionOf(c.doc, c.steps, c.chapters); const cur = c.doc.options?.direction || 'auto'; return [['auto', `Automatic — now ${r.detected === 'rtl' ? 'right-to-left (Hebrew / Arabic text)' : 'left-to-right'}`], ['ltr', 'Left-to-right'], ['rtl', 'Right-to-left']].map(([v, l]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${l}</option>`).join(''); })()}</select></label>
    <div class="dw-lab">Header and footer${c.doc.bands ? ' — your own design' : ' — standard'}
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:11.5px;"><button class="dw-btn" data-act="band-edit" data-side="header" title="Place the logo, texts, page numbers and pictures of the header and the footer yourself — or click the header / footer on the page">✎ Edit…</button>${c.doc.bands ? '<a data-act="band-reset">back to the standard one</a>' : ''}</div></div>`;
  const pageHtml = `
    <div class="dw-h">Page ${c.model.pages.find(p => p.id === page.id)?.number ?? '—'} of ${c.model.total}</div>
    <div style="font-size:12px;color:#cbd5e1;margin-bottom:8px;">${_esc(pageRangeLabel(page, c.steps, c.chapters, c.perChapter, c.doc.hiddenSteps))}</div>
    ${flags.length ? `<div style="margin:0 0 10px;padding:7px 9px;border-radius:7px;background:rgba(245,158,11,.13);border:1px solid #b45309;font-size:11.5px;line-height:1.5;">${flags.map(x => `${FLAG_ICON[x.kind] || '!'} ${_esc(x.note)}`).join('<br>')}
      <div style="margin-top:5px;"><a data-act="reviewed">✓ Seen — clear these marks</a></div></div>` : ''}
    <label class="dw-lab">Page template
      <select class="dw-in" data-page-opt="template"><option value=""${page.templateAuto !== false ? ' selected' : ''}>Automatic — ${_esc(tplNow.name)}</option>${tpls.map(t => `<option value="${_esc(t.id)}"${(page.templateAuto === false && t.id === page.templateId) ? ' selected' : ''}>${_esc(t.name)}</option>`).join('')}</select></label>
    <div style="font-size:11px;color:#64748b;margin:-2px 0 4px;">Automatic = as many pictures as the page has steps (2, 3, 4).</div>
    <div style="font-size:11.5px;margin:0 0 9px;display:flex;gap:10px;flex-wrap:wrap;"><a data-act="tpl-new" title="Draw your own layout: where the text goes and where each picture frame goes. It starts from this page's layout.">📐 New template…</a>${tplNow.builtin ? '' : `<a data-act="tpl-edit">✎ Edit “${_esc(tplNow.name)}”</a><a data-act="tpl-delete" style="color:#fca5a5;">Delete it</a>`}</div>
    ${(tplNow.images || []).map((_, k) => { const ch = _pictureChoice(c, page, k, modelPage); return `<div class="dw-lab">Picture ${k + 1}
      <button class="dw-pick" data-act="slot-pick" data-slot="${k}" title="Choose which picture goes into this frame">${_thumbBox(ch.thumb, ch.before)}<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(ch.text)}</span><span style="color:#64748b;">▾</span></button></div>`; }).join('')}
    <div style="font-size:11.5px;color:#94a3b8;margin:0 0 6px;">Click a picture on the page: drag moves it behind its frame, the wheel scales it.</div>
    <div style="font-size:11.5px;margin:0 0 8px;"><a data-act="rerender-pictures" title="Pictures refresh by themselves when a step, its overlay, a colour or a style changes. Use this after anything else — a reloaded model, render settings.">↻ Render the pictures again</a></div>
    ${page.stepIds.length > 1 ? `<div style="margin:4px 0 0;"><button class="dw-btn" data-act="split-all" title="Undo the merge: every step of this page gets a page of its own again">Un-merge — one page per step</button></div>` : ''}

    <div class="dw-h">Text on this page</div>
    <div style="font-size:11.5px;color:#94a3b8;margin-bottom:8px;">Click a line on the page to rewrite it. The voiceover is never changed from here.</div>
    ${lines}`;
  // two halves: the fields half is NOT rebuilt while one of its inputs has the
  // focus — Tab from Title to Company commits Title, and a rebuild would throw
  // the caret (and whatever was typed meanwhile) out of Company
  let docBox = left.querySelector('#dw-left-doc'), wmBox = left.querySelector('#dw-left-wm'), pageBox = left.querySelector('#dw-left-page');
  if (!docBox) { left.innerHTML = '<div id="dw-left-doc"></div><div id="dw-left-wm"></div><div id="dw-left-page"></div>'; docBox = left.querySelector('#dw-left-doc'); wmBox = left.querySelector('#dw-left-wm'); pageBox = left.querySelector('#dw-left-page'); }
  if (docBox.contains(document.activeElement)) {
    for (const inp of docBox.querySelectorAll('input[data-field]')) if (inp !== document.activeElement) inp.value = f[inp.dataset.field] || '';
  } else docBox.innerHTML = docHtml;
  _renderWatermarkBox(wmBox, watermarkOf(c.doc));
  pageBox.innerHTML = _bandEdit ? _bandLeftHtml() : custom ? _customLeftHtml(c, custom) : onToc
    ? `<div class="dw-h">Contents — page 1${c.model.toc?.pages.length > 1 ? `–${c.model.toc.pages.length}` : ''} of ${c.model.total}</div><div style="font-size:11.5px;color:#94a3b8;line-height:1.5;">Built from the chapters: every chapter that prints, with the page it starts on. The numbers follow by themselves when you join, split or leave out steps. In the PDF every line is a link.<br><br>It counts as page 1, so the first step page is page ${(c.model.toc?.pages.length || 0) + 1}. Switch it off with <b>Table of contents</b> above.</div>`
    : pageHtml;
  left.scrollTop = keep;
}

// ─── 💧 watermark ────────────────────────────────────────────────────────────

const _pct = (v) => `${Math.round(v * 100)}%`;

function _renderWatermarkBox(box, w) {
  const act = document.activeElement;
  const inside = box.contains(act);
  // typing in a text / number field: leave the box alone (the caret lives there)
  if (inside && (act.tagName === 'TEXTAREA' || (act.tagName === 'INPUT' && /^(text|number)$/.test(act.type)))) return;
  const refocus = inside ? act.dataset?.wm || null : null;
  const summary = !w.enabled ? 'off' : w.kind === 'image' ? (w.image ? `image · ${_pct(w.opacity)}` : 'image — none chosen yet') : `“${w.text.trim().slice(0, 18) || '…'}” · ${_pct(w.opacity)}`;
  const row = 'display:flex;align-items:center;gap:8px;margin:0 0 7px;font-size:11.5px;color:#cbd5e1;';
  const textControls = `
        <label class="dw-lab">Text<textarea class="dw-in" data-wm="text" rows="2" dir="auto" style="resize:vertical;">${_esc(w.text)}</textarea></label>
        <div style="${row}"><span style="flex:0 0 52px;">Size</span><input class="dw-in" data-wm="fontSize" type="number" min="6" max="600" step="1" value="${w.fontSize}" style="width:74px;" title="Any size, in points"><span>pt</span>
          <span style="flex:1"></span><span>Colour</span><input data-wm="color" type="color" value="${_esc(w.color)}" style="width:34px;height:24px;padding:0;border:1px solid #334155;border-radius:5px;background:none;"></div>`;
  const imageControls = `
        <div style="${row}align-items:flex-start;">
          <div style="flex:0 0 96px;height:64px;border:1px solid #334155;border-radius:6px;background:repeating-conic-gradient(#cbd5e1 0% 25%, #f8fafc 0% 50%) 0 0/14px 14px;display:flex;align-items:center;justify-content:center;overflow:hidden;">${w.image ? `<img src="${_esc(w.image.dataUrl)}" alt="" style="max-width:100%;max-height:100%;">` : '<span style="color:#475569;font-size:10.5px;">no image</span>'}</div>
          <div style="min-width:0;flex:1;"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#94a3b8;margin-bottom:5px;">${_esc(w.image?.name || '')}</div>
            <button class="dw-btn" data-act="wm-choose">${w.image ? 'Replace image…' : 'Choose image…'}</button><input type="file" data-wm-file accept="image/*" hidden></div></div>
        <div style="${row}"><span style="flex:0 0 52px;">Width</span><input data-wm="imageWidth" type="range" min="5" max="150" step="1" value="${w.imageWidth}" style="flex:1;"><span data-wm-out="imageWidth" style="flex:0 0 40px;text-align:right;">${Math.round(w.imageWidth)}%</span></div>`;
  const body = !_wmOpen ? '' : `
    <label style="${row}"><input type="checkbox" data-wm="enabled"${w.enabled ? ' checked' : ''}> Print a watermark on every page</label>
    <div style="${w.enabled ? '' : 'opacity:.45;pointer-events:none;'}">
      <label class="dw-lab">Kind
        <select class="dw-in" data-wm="kind"><option value="text"${w.kind === 'text' ? ' selected' : ''}>Text</option><option value="image"${w.kind === 'image' ? ' selected' : ''}>Image (a logo, a stamp)</option></select></label>
      ${w.kind === 'text' ? textControls : imageControls}
      <div style="${row}"><span style="flex:0 0 52px;">Opacity</span><input data-wm="opacity" type="range" min="1" max="100" step="1" value="${Math.round(w.opacity * 100)}" style="flex:1;"><span data-wm-out="opacity" style="flex:0 0 40px;text-align:right;">${_pct(w.opacity)}</span></div>
      <div style="${row}"><span style="flex:0 0 52px;">Angle</span><input data-wm="angle" type="range" min="-90" max="90" step="1" value="${w.angle}" style="flex:1;"><span data-wm-out="angle" style="flex:0 0 40px;text-align:right;">${Math.round(w.angle)}°</span></div>
      <label class="dw-lab">Where
        <select class="dw-in" data-wm="layer"><option value="over"${w.layer === 'over' ? ' selected' : ''}>Over everything — the pictures too</option><option value="under"${w.layer === 'under' ? ' selected' : ''}>Behind the text and the pictures</option></select></label>
    </div>`;
  box.innerHTML = `
    <div class="dw-h" data-act="wm-toggle" style="cursor:pointer;display:flex;gap:6px;align-items:center;" title="A mark printed on every page of the PDF — DRAFT, CONFIDENTIAL, a logo…">
      <span>${_wmOpen ? '▾' : '▸'} 💧 Watermark</span><span data-wm-summary style="text-transform:none;letter-spacing:0;color:${w.enabled ? '#4ade80' : '#64748b'};">${_esc(summary)}</span></div>${body}`;
  if (refocus) box.querySelector(`[data-wm="${refocus}"]`)?.focus({ preventScroll: true });
}

/** A watermark control's value, typed for the model. */
function _wmValue(el) {
  const k = el.dataset.wm;
  if (k === 'enabled') return el.checked;
  if (k === 'opacity') return Number(el.value) / 100;
  if (k === 'fontSize' || k === 'angle' || k === 'imageWidth') return Number(el.value);
  return el.value;
}

/** While a slider / colour / text is being changed: redraw ONLY the mark on the page — no commit, no undo entry yet. */
function _previewWatermark(patch) {
  const pageEl = _shadow.querySelector('.page'); if (!pageEl) return;
  const w = watermarkOf({ watermark: { ...watermarkOf(D.getDocument()), ...patch } });
  pageEl.querySelector('.wm')?.remove();
  if (!watermarkVisible(w)) return;
  pageEl.insertAdjacentHTML(w.layer === 'under' ? 'afterbegin' : 'beforeend', watermarkHtml(w));
}

/**
 * Import dialog: an image becomes a watermark by being BAKED to real transparency
 * once (see watermark-core) — shown here over a white page and over a dark
 * picture, at full strength, so the matte can be judged before it is used.
 */
async function _openWatermarkDialog(srcUrl, name) {
  _wmDlg?.remove();
  const im = new Image();
  im.src = srcUrl;
  try { await im.decode(); } catch { setStatus('That file could not be read as an image.', 'warn', 6000); return; }
  const size = fitWithin(im.naturalWidth || 800, im.naturalHeight || 800, 1600);
  const srcC = document.createElement('canvas'); srcC.width = size.w; srcC.height = size.h;
  const sctx = srcC.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(im, 0, 0, size.w, size.h);
  const src = sctx.getImageData(0, 0, size.w, size.h);
  const detected = detectWatermarkMode(src.data, size.w, size.h);
  const outC = document.createElement('canvas'); outC.width = size.w; outC.height = size.h;
  const st = { mode: detected, tintOn: false, tint: '#6b7280' };

  const dlg = _wmDlg = document.createElement('div');
  dlg.id = 'dw-wm-dialog';
  dlg.style.cssText = 'position:fixed;inset:0;z-index:9200;background:rgba(2,6,23,.72);display:flex;align-items:center;justify-content:center;';
  const opt = (v, label) => `<label style="display:flex;gap:8px;align-items:flex-start;margin:0 0 7px;cursor:pointer;"><input type="radio" name="wm-mode" value="${v}"${st.mode === v ? ' checked' : ''} style="margin-top:2px;"><span>${label}${detected === v ? ' <span style="color:#4ade80;">— looks like this one</span>' : ''}</span></label>`;
  dlg.innerHTML = `<div style="width:640px;max-width:94vw;background:#0f172a;border:1px solid #334155;border-radius:12px;padding:18px 20px;box-shadow:0 20px 60px rgba(0,0,0,.6);font-size:12.5px;line-height:1.5;">
      <div style="font-size:15px;font-weight:700;margin-bottom:4px;">💧 Watermark image</div>
      <div style="color:#94a3b8;margin-bottom:12px;">${_esc(name || '')} · ${size.w} × ${size.h} px. Shown at full strength; on the page it gets the opacity you set.</div>
      <div style="display:flex;gap:12px;margin-bottom:14px;">
        <div style="flex:1;"><canvas data-pv="light" width="290" height="180" style="width:100%;border-radius:8px;border:1px solid #334155;display:block;"></canvas><div style="color:#94a3b8;font-size:11px;margin-top:3px;">over the white page</div></div>
        <div style="flex:1;"><canvas data-pv="dark" width="290" height="180" style="width:100%;border-radius:8px;border:1px solid #334155;display:block;"></canvas><div style="color:#94a3b8;font-size:11px;margin-top:3px;">over a dark picture</div></div>
      </div>
      <div style="font-weight:600;margin-bottom:6px;">What kind of image is this?</div>
      ${opt('white', 'Artwork on a <b>white</b> background — make the white transparent')}
      ${opt('black', 'Artwork on a <b>black</b> background — make the black transparent')}
      ${opt('keep', 'It already has a <b>transparent</b> background — keep it as it is')}
      <label style="display:flex;gap:8px;align-items:center;margin:10px 0 0;cursor:pointer;"><input type="checkbox" data-wmd="tintOn"> Make it one flat colour <input type="color" data-wmd="tint" value="${st.tint}" style="width:34px;height:24px;padding:0;border:1px solid #334155;border-radius:5px;background:none;"><span style="color:#94a3b8;">(a grey mark from a coloured logo, for instance)</span></label>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;"><button class="dw-btn" data-wmd="cancel">Cancel</button><button class="dw-btn primary" data-wmd="use">Use this image</button></div>
    </div>`;
  const paint = () => {
    const baked = bakeWatermarkPixels(src.data, size.w, size.h, { mode: st.mode, tint: st.tintOn ? st.tint : null });
    outC.getContext('2d').putImageData(new ImageData(baked, size.w, size.h), 0, 0);
    for (const [key, bg] of [['light', '#ffffff'], ['dark', '#1e293b']]) {
      const cv = dlg.querySelector(`canvas[data-pv="${key}"]`), x = cv.getContext('2d');
      x.fillStyle = bg; x.fillRect(0, 0, cv.width, cv.height);
      const k = Math.min((cv.width - 24) / size.w, (cv.height - 24) / size.h);
      x.drawImage(outC, (cv.width - size.w * k) / 2, (cv.height - size.h * k) / 2, size.w * k, size.h * k);
    }
  };
  const close = () => { dlg.remove(); if (_wmDlg === dlg) _wmDlg = null; _holdFocus(); };
  dlg.addEventListener('change', (e) => {
    e.stopPropagation();                                       // not a document field — keep it away from _onChange
    if (e.target.name === 'wm-mode') st.mode = e.target.value;
    else if (e.target.dataset.wmd === 'tintOn') st.tintOn = e.target.checked;
    else if (e.target.dataset.wmd === 'tint') { st.tint = e.target.value; st.tintOn = true; dlg.querySelector('[data-wmd="tintOn"]').checked = true; }
    paint();
  });
  dlg.addEventListener('input', (e) => { e.stopPropagation(); if (e.target.dataset.wmd === 'tint') { st.tint = e.target.value; if (st.tintOn) paint(); } });
  dlg.addEventListener('click', (e) => {
    e.stopPropagation();
    const a = e.target.closest?.('[data-wmd]')?.dataset.wmd;
    if (a === 'cancel' || e.target === dlg) return close();
    if (a !== 'use') return;
    const dataUrl = outC.toDataURL('image/png');
    close();
    D.setWatermark({ enabled: true, kind: 'image', image: { dataUrl, w: size.w, h: size.h, mode: st.mode, tint: st.tintOn ? st.tint : null, name: name || '' } });
  });
  _root.appendChild(dlg);
  paint();
  dlg.querySelector('[data-wmd="use"]').focus();
}

// ─── RIGHT: the document, page by page ──────────────────────────────────────
// One box per PAGE, with a thumbnail of the page itself (not of a step): a joined page is one
// page, and that is what the list must show. Its steps are listed under it as compact rows, so
// every step action (select a range, split here, leave out) is still one click away.
// The contents and the custom pages carry a grip: they are the only things that can be moved —
// step pages follow the animation.

const THUMB_W = 64, THUMB_H = Math.round(64 * 297 / 210);
let _thumbSheet = null, _thumbIO = null;

function _renderList(c) {
  const list = _root.querySelector('#dw-list');
  const keep = list.scrollTop;
  const seq = D.documentSequence();
  const printed = new Map(c.model.sequence.map(e => [e.id, e.number]));
  const pageNo = (id) => printed.get(id) ?? '—';                     // the number that is PRINTED; what is left out has none
  const unitAt = new Map(c.units.map((u, i) => [u.id, i]));
  const eye = (u, hid) => `<a class="dw-eye" data-act="hide-toggle" data-unit="${_esc(u.id)}" title="${hid ? 'Put it back into the document' : 'Leave it out of the document (the animation is not touched)'}">${hid ? '🙈' : '👁'}</a>`;
  const thumb = (id) => `<span class="dw-pagethumb" data-thumb="${_esc(id)}"></span>`;
  const flagsHtml = (p) => { const f = p.flags || []; return f.length ? `<span title="${_esc(f.map(x => x.note).join('\n'))}" style="color:#fbbf24;">❗ ${f.map(x => FLAG_ICON[x.kind] || '!').join(' ')}</span>` : ''; };
  const textOf = (u) => { const s = c.stepById.get(u.id); return s ? docTextFor(s, c.doc.texts, srcHashOf).text : ''; };
  const subs = (u) => (u.members.length > 1 ? ` <span style="color:#94a3b8;font-weight:400;">+${u.members.length - 1} sub</span>` : '');
  const tip = 'Click to show the page · Shift / Ctrl-click selects the whole range · right-click for more';

  const pendingRow = (u) => `<div class="dw-pagebox" style="border-style:dashed;"><div class="dw-step pending" data-unit="${_esc(u.id)}" title="Not in the document yet — sync to add it"><span class="dw-pagethumb"></span><span class="dw-no">${_esc(c.nums.get(u.id)?.label || '–')}</span><div style="min-width:0;flex:1;"><div class="dw-name" style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(c.stepById.get(u.id)?.name || u.id)}</div><div style="font-size:11px;color:#94a3b8;">new in the animation — sync to add</div></div></div></div>`;

  let html = '', lastChapter, nextPending = 0;
  const flushPending = (uptoIndex) => { for (; nextPending < c.units.length && nextPending < uptoIndex; nextPending++) { const u = c.units[nextPending]; if (!c.pageOfUnit.has(u.id)) html += pendingRow(u); } };

  seq.forEach((e, si) => {
    if (e.kind === 'toc') {
      if (!c.model.toc) return;                                       // switched off (or no chapters): it prints nothing, so it is not listed
      const t = c.model.toc;
      html += `<div class="dw-pagebox movable${_pageId === TOC ? ' cur' : ''}" data-pagebox="${TOC}" data-seq="${si}" data-extra="${TOC}">
        <div class="dw-pagehead dw-pgrow" data-goto-page="${TOC}"><span class="dw-grip" data-grip="${TOC}" title="Drag to move the contents — or right-click">⠿</span>${thumb(TOC)}<div style="min-width:0;flex:1;"><div><b style="color:#e2e8f0;">Page ${t.number}${t.pages.length > 1 ? `–${t.number + t.pages.length - 1}` : ''}</b></div><div style="font-size:12px;font-weight:600;color:#e2e8f0;">📑 ${_esc(t.title)}</div><div style="font-size:11px;color:#94a3b8;">Contents — ${t.pages.reduce((n, p) => n + p.lines.length, 0)} chapters</div></div></div></div>`;
      return;
    }
    if (e.kind === 'custom') {
      html += `<div class="dw-pagebox movable${_pageId === e.id ? ' cur' : ''}" data-pagebox="${_esc(e.id)}" data-seq="${si}" data-extra="${_esc(e.id)}">
        <div class="dw-pagehead dw-pgrow" data-goto-page="${_esc(e.id)}"><span class="dw-grip" data-grip="${_esc(e.id)}" title="Drag to move this page — or right-click">⠿</span>${thumb(e.id)}<div style="min-width:0;flex:1;"><div><b style="color:#e2e8f0;">Page ${pageNo(e.id)}</b></div><div class="dw-name" style="font-size:12px;font-weight:600;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">✎ ${_esc(e.extra.name || 'Custom page')}</div><div style="font-size:11px;color:#94a3b8;">custom page · ${(e.extra.items || []).length} item${(e.extra.items || []).length === 1 ? '' : 's'}</div></div></div></div>`;
      return;
    }
    const p = e.page;
    const us = (p.stepIds || []).map(id => c.units.find(u => u.id === id)).filter(Boolean);
    if (!us.length) {                                                 // a page with no steps left (flagged ∅ by a sync) — only deletable
      html += `<div class="dw-pagebox flag" data-seq="${si}"><div class="dw-pagehead"><b style="color:#e2e8f0;">Page —</b><span>· ∅ no steps left</span><span style="flex:1"></span><a data-act="delete-page" data-page="${_esc(p.id)}" style="color:#fca5a5;">delete</a></div></div>`;
      return;
    }
    flushPending(unitAt.get(us[0].id));
    if (us[0].chapterId !== lastChapter) {
      const ch = c.chapters.find(x => x.id === us[0].chapterId);
      if (ch) html += `<div class="dw-chap" dir="auto">${_esc(ch.name)}</div>`;
      lastChapter = us[0].chapterId;
    }
    const allHidden = us.every(u => c.hidden.has(u.id));
    const cls = `dw-pagebox${p.id === _pageId ? ' cur' : ''}${(p.flags || []).length ? ' flag' : ''}`;
    const no = `<b style="color:#e2e8f0;">Page ${pageNo(p.id)}</b>${allHidden ? ' <span style="color:#f87171;font-size:11px;">· not printed</span>' : ''}`;
    if (us.length === 1) {
      const u = us[0], hid = c.hidden.has(u.id);
      html += `<div class="${cls}" data-pagebox="${_esc(p.id)}" data-seq="${si}"><div class="dw-step dw-pgrow${_sel.has(u.id) ? ' sel' : ''}${hid ? ' hid' : ''}" data-unit="${_esc(u.id)}" title="${hid ? 'Left out of the document — the eye puts it back' : tip}">${thumb(p.id)}
        <div style="min-width:0;flex:1;"><div style="display:flex;gap:6px;align-items:center;">${no}<span style="flex:1"></span>${flagsHtml(p)}</div>
        <div class="dw-name" style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><span class="dw-no" style="margin-inline-end:5px;">${_esc(c.nums.get(u.id)?.label || '–')}</span>${_esc(c.stepById.get(u.id)?.name || u.id)}${subs(u)}</div>
        <div dir="auto" style="font-size:11px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${hid ? 'left out of the document' : _esc(textOf(u))}</div></div>${eye(u, hid)}</div></div>`;
    } else {
      const a = c.nums.get(us[0].id)?.label || '', b = c.nums.get(us[us.length - 1].id)?.label || '';
      html += `<div class="${cls}" data-pagebox="${_esc(p.id)}" data-seq="${si}">
        <div class="dw-pagehead dw-pgrow${us.every(u => _sel.has(u.id)) ? ' sel' : ''}" data-goto-page="${_esc(p.id)}" data-select-page="${_esc(p.id)}" title="${tip}">${thumb(p.id)}<div style="min-width:0;flex:1;"><div style="display:flex;gap:6px;align-items:center;">${no}<span style="flex:1"></span>${flagsHtml(p)}</div>
          <div style="font-size:12px;font-weight:600;color:#e2e8f0;">${us.length} steps merged <span style="font-weight:400;color:#94a3b8;">(steps ${_esc(a)}–${_esc(b)})</span></div></div></div>
        ${us.map(u => { const hid = c.hidden.has(u.id); return `<div class="dw-step mini${_sel.has(u.id) ? ' sel' : ''}${hid ? ' hid' : ''}" data-unit="${_esc(u.id)}" title="${hid ? 'Left out of the document — the eye puts it back' : tip}"><span class="dw-no">${_esc(c.nums.get(u.id)?.label || '–')}</span><div class="dw-name" style="min-width:0;flex:1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(c.stepById.get(u.id)?.name || u.id)}${subs(u)}</div>${eye(u, hid)}</div>`; }).join('')}</div>`;
    }
    nextPending = Math.max(nextPending, unitAt.get(us[us.length - 1].id) + 1);
  });
  flushPending(c.units.length);
  list.innerHTML = html + '<div class="dw-dropline" hidden></div>';
  list.scrollTop = keep;
  _mountThumbs(c, list);
  _renderSelBar(c);
}

/** Page thumbnails: the real page markup, scaled down, filled only while the row is near the viewport. */
function _mountThumbs(c, list) {
  _thumbIO?.disconnect();
  _thumbSheet = new CSSStyleSheet();
  const k = THUMB_W / PAGE_W;
  _thumbSheet.replaceSync(`${DOCUMENT_CSS}${watermarkCss(c.model.watermark)}:host{all:initial;display:block;width:${THUMB_W}px;height:${THUMB_H}px;overflow:hidden;background:#fff;border-radius:3px;} .fit{transform:scale(${k});transform-origin:0 0;width:210mm;height:297mm;pointer-events:none;}`);
  const byId = new Map(c.model.sequence.map(e => [e.id, e]));
  const o = { logo: D.documentLogo(), watermark: c.model.watermark, dir: c.model.dir, lang: c.model.lang };
  const fill = (host) => {
    const e = byId.get(host.dataset.thumb);
    const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [_thumbSheet];
    if (!e) { root.innerHTML = ''; host.classList.add('off'); return; }
    let page = '';
    if (e.kind === 'toc') page = renderTocPageHtml(e.model.pages[0], { ...o, tocTitle: e.model.title });
    else if (e.kind === 'custom') page = renderCustomPageHtml(e.model, o);
    else {
      const ids = e.model.images.map(im => im.stepId).filter(Boolean);
      const t = _thumbsFor(c, ids);                                   // the rendered picture when there is one, else the step's own thumbnail
      const stills = new Map(e.model.images.filter(im => im.stepId).map(im => [im.key, im.moment === 'start' ? t.start.get(im.stepId) : t.end.get(im.stepId)]));
      page = renderPageHtml(e.model, { ...o, stills });
    }
    root.innerHTML = `<div class="fit">${page}</div>`;
  };
  _thumbIO = new IntersectionObserver((entries) => {
    for (const en of entries) { if (en.isIntersecting) fill(en.target); else if (en.target.shadowRoot) en.target.shadowRoot.innerHTML = ''; }
  }, { root: list, rootMargin: '300px 0px' });
  for (const host of list.querySelectorAll('.dw-pagethumb[data-thumb]')) _thumbIO.observe(host);
}

function _renderSelBar(c) {
  const bar = _root.querySelector('#dw-selbar');
  const a = _selectionActions(c);
  _selBarActions = [a.merge, a.split, a.hide && a.sel.length > 1 ? a.hide : null, a.show && a.sel.length > 1 ? a.show : null].filter(Boolean);
  const html = _selBarActions.map((it, i) => `<button class="dw-btn${it === a.merge ? ' primary' : ''}" data-act="sel-action" data-i="${i}" title="The document only — the animation and its step numbers stay as they are">${it === a.merge ? '⤵ ' : it === a.split ? '✂ ' : ''}${_esc(it.label)}</button>`).join('');
  bar.innerHTML = (html || (a.sel.length >= 2
    ? '<div style="font-size:11.5px;color:#94a3b8;">These steps are already on one page.</div>'
    : '<div style="font-size:11.5px;color:#94a3b8;line-height:1.45;">Select a range of pages (Shift- or Ctrl-click the other end) to join them into one page. Right-click for more.</div>'))
    + `<button class="dw-btn" data-act="add-custom" title="A page that is not made of steps — a cover, a safety notice, a parts list. It goes after the page you are on; drag its grip to move it.">＋ Custom page</button>`;
}
let _selBarActions = [];

// ─── moving the contents / a custom page: drag its grip ─────────────────────

let _drag = null;
function _onGripDown(e) {
  const grip = e.target.closest?.('[data-grip]');
  if (!grip || e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const list = _root.querySelector('#dw-list');
  _drag = { id: grip.dataset.grip, from: Number(grip.closest('[data-seq]').dataset.seq), to: null, list };
  grip.closest('.dw-pagebox').classList.add('dragging');
  try { grip.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
}
function _onGripMove(e) {
  if (!_drag) return;
  const boxes = [..._drag.list.querySelectorAll('.dw-pagebox[data-seq]')];
  const line = _drag.list.querySelector('.dw-dropline');
  // the gap the pointer is nearest to: before box i, or after the last one
  let gap = boxes.length, y = null;
  for (let i = 0; i < boxes.length; i++) { const r = boxes[i].getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { gap = i; y = r.top; break; } }
  if (y === null) { const r = boxes[boxes.length - 1].getBoundingClientRect(); y = r.bottom; }
  _drag.to = gap < boxes.length ? Number(boxes[gap].dataset.seq) : Number(boxes[boxes.length - 1].dataset.seq) + 1;
  const lr = _drag.list.getBoundingClientRect();
  line.hidden = false; line.style.top = `${y - lr.top + _drag.list.scrollTop - 2}px`;
  // keep dragging usable in a long list
  if (e.clientY < lr.top + 30) _drag.list.scrollTop -= 14; else if (e.clientY > lr.bottom - 30) _drag.list.scrollTop += 14;
}
function _onGripUp() {
  const d = _drag; _drag = null;
  if (!d) return;
  d.list.querySelector('.dw-dropline').hidden = true;
  d.list.querySelector('.dw-pagebox.dragging')?.classList.remove('dragging');
  if (d.to === null) return;
  D.moveExtraTo(d.id, d.to > d.from ? d.to - 1 : d.to);             // positions are counted with the moving item taken out
}

/** Right-click on the contents / a custom page. */
function _extraMenu(id, x, y) {
  const seq = D.documentSequence(), i = seq.findIndex(e => e.id === id);
  if (i < 0) return;
  const isToc = id === TOC, what = isToc ? 'the contents' : 'this page';
  const items = [
    i > 0 ? { label: `↑ Move ${what} up`, run: () => D.moveExtraTo(id, i - 1) } : null,
    i < seq.length - 1 ? { label: `↓ Move ${what} down`, run: () => D.moveExtraTo(id, i + 1) } : null,
    i > 0 ? { label: '⤒ Move to the start of the document', run: () => D.moveExtraTo(id, 0) } : null,
    i < seq.length - 1 ? { label: '⤓ Move to the end of the document', run: () => D.moveExtraTo(id, seq.length) } : null,
    { sep: true },
    ...(isToc ? [{ label: 'Switch the contents off', run: () => D.setOptions({ toc: false }) }] : [
      { label: '✎ Rename…', run: () => { const cur = seq[i].extra.name || ''; const n = prompt('Name of this page (shown in the list only):', cur); if (n != null && n.trim() && n !== cur) D.renameCustomPage(id, n.trim()); } },
      { label: '🗑 Delete this page', run: () => { if (confirm('Delete this custom page and everything on it? (Undo brings it back.)')) { if (_pageId === id) _pageId = null; D.deleteCustomPage(id); } } },
    ]),
  ].filter(Boolean);
  _openMenu(items, x, y);
}

/** A new custom page right after the page the user is on (or at the end). */
function _addCustomPage() {
  const seq = D.documentSequence();
  const i = seq.findIndex(e => e.id === _pageId);
  const id = D.addCustomPage(i < 0 ? seq.length : i + 1);
  if (id) { _commitFocusedText(); _pageId = id; _slotSel = null; _sel = new Set(); _renderAll(); }
}

// ─── CENTRE: the page ───────────────────────────────────────────────────────

function _renderPage(c) {
  // never rebuild the page under a caret: the edit commits on blur and re-renders then
  const focused = _shadow.activeElement;
  if (focused?.classList?.contains('tx')) { _deferred = true; return; }
  const model = D.renderModel();
  if (_bandEdit) return _renderBandEdit(model);
  if (_pageId === TOC && model.toc) {
    _pageModel = null; _slotSel = null; _placeSlotBar(); _customSel = null; _placeCustomBar();
    const o = { logo: D.documentLogo(), watermark: model.watermark, dir: model.dir, lang: model.lang, tocTitle: model.toc.title };
    _shadow.innerHTML = `<style>${DOCUMENT_CSS}${watermarkCss(model.watermark)}${EDIT_CSS}.page + .page { margin-top: 8mm; } .toc .tl { pointer-events: none; }</style><div class="fit">${model.toc.pages.map(tp => renderTocPageHtml(tp, o)).join('')}</div>`;
    _fit(); return;
  }
  const cp = model.customs.find(x => x.id === _pageId);
  if (cp) { _pageModel = null; _slotSel = null; _placeSlotBar(); return _renderCustomPage(model, cp); }
  _customSel = null; _placeCustomBar();
  const mp = model.pages.find(p => p.id === _pageId);
  _pageModel = mp || null; _pageLang = model.lang || null;
  if (_slotSel != null && (!mp || _slotSel >= mp.images.length)) _slotSel = null;
  if (!mp) { _placeSlotBar(); _shadow.innerHTML = `<style>${EDIT_CSS}</style><div style="font:13px Arial;color:#e2e8f0;padding:30px;">${(D.getDocument()?.pages.find(p => p.id === _pageId)?.stepIds || []).length ? 'Every step of this page is left out of the document, so the page is not printed. Click the eye of a step on the right to put it back.' : 'This page has no steps left. Delete it from the list on the right.'}</div>`; _fit(); return; }
  const need = stillsNeeded({ pages: [mp] });
  const have = D.cachedStills(need);
  _shadow.innerHTML = `<style>${DOCUMENT_CSS}${watermarkCss(model.watermark)}${EDIT_CSS}</style><div class="fit">${renderPageHtml(mp, { stills: have, logo: D.documentLogo(), watermark: model.watermark, dir: model.dir, lang: model.lang })}</div>`;
  for (const row of _shadow.querySelectorAll('.it')) {
    const it = mp.items.find(i => i.stepId === row.dataset.step);
    if (it?.edited) row.classList.add(it.drifted ? 'drifted' : 'edited');
    const tx = row.querySelector('.tx');
    tx.setAttribute('contenteditable', 'plaintext-only');
    tx.setAttribute('spellcheck', 'true');
    tx.dataset.orig = it?.text ?? '';
  }
  for (const ph of _shadow.querySelectorAll('.slot .ph')) if (/not rendered/.test(ph.textContent)) ph.textContent = 'rendering the picture…';
  _fit(); _markOverflow();
  if (_slotSel != null) _selectSlot(_slotSel);
  if (need.some(id => !have.has(id))) _loadStills();
}

/**
 * Render the current page's missing pictures (walks the needed steps behind the
 * workspace), then patch ONLY the slots — the text under the caret is never rebuilt.
 * One walk at a time; if the page changed meanwhile, go again for the new one.
 */
async function _loadStills() {
  if (_walking) { _walkAgain = true; return; }
  _walking = true;
  try {
    do {
      _walkAgain = false;
      const forPage = _pageId;
      const m0 = D.renderModel();
      const mp = m0.pages.find(p => p.id === forPage), cp = mp ? null : (m0.customs || []).find(x => x.id === forPage);
      const need = mp ? stillsNeeded({ pages: [mp] }) : cp ? stillsNeeded({ customs: [cp] }) : [];
      if (!need.length || D.cachedStills(need).size === need.length) continue;
      let stills = null;
      try { stills = await D.ensureStills(need, {}); }
      catch (e) { console.error('[document] pictures failed:', e); }
      if (!_isOpen()) break;
      if (forPage !== _pageId) { _walkAgain = true; continue; }
      for (const k of need) if (!stills?.get(k)) _stillsFailed.add(k);
      if (cp) { if (_ptrDown) _renderHeld = true; else _renderPage(); continue; }      // a custom page is redrawn whole (never under a caret — it defers itself)
      const now = D.renderModel().pages.find(p => p.id === _pageId);
      for (const slot of _shadow.querySelectorAll('.slot')) {
        const k = Number(slot.dataset.slot), im = now?.images?.[k];
        const sid = im?.stepId;
        const url = sid ? stills?.get(im.key) : null;
        if (url) { slot.innerHTML = slotInnerHtml(im, url, k, _pageLang); slot.classList.remove('none'); }
        else if (sid) { const ph = slot.querySelector('.ph'); if (ph) ph.textContent = 'the picture could not be rendered'; }
      }
      _pageModel = now || _pageModel;
      _placeSlotBar();
    } while (_walkAgain);
  } finally { _walking = false; }
}

function _fit() {
  const centre = _root.querySelector('#dw-center'), host = _root.querySelector('#dw-pagehost');
  const fit = _shadow.querySelector('.fit');
  if (!fit) return;
  const pad = 28;
  // a custom page has its bar floating over the top of the centre: the page starts below it
  const bar = _root.querySelector('#dw-custombar');
  const top = bar ? bar.offsetHeight + 20 : pad;
  const s = _zoom === '100' ? 1 : Math.max(0.2, Math.min((centre.clientWidth - pad * 2) / PAGE_W, (centre.clientHeight - top - pad) / PAGE_H));
  fit.style.transform = `scale(${s})`;
  const nPages = Math.max(1, fit.querySelectorAll('.page').length);
  const w = PAGE_W * s, h = (PAGE_H * nPages + (nPages - 1) * 8 * 96 / 25.4) * s;
  host.style.width = `${w}px`; host.style.height = `${h + pad}px`;
  host.style.left = `${Math.max(pad, (centre.clientWidth - w) / 2)}px`;
  host.style.top = `${_zoom === '100' ? top : Math.max(top, (centre.clientHeight - h + top - pad) / 2)}px`;
  _placeSlotBar();
}

function _markOverflow() {
  const t = _shadow.querySelector('.txt');
  if (t) t.classList.toggle('over', t.scrollHeight > t.clientHeight + 1);
}

// ─── editing on the page ────────────────────────────────────────────────────

const _textOf = (tx) => String(tx.innerText ?? '').replace(/ /g, ' ').replace(/\n+$/, '');

function _commitText(tx) {
  const stepId = tx.closest('.it')?.dataset.step;
  if (!stepId) return;
  const text = _textOf(tx);
  if (text !== (tx.dataset.orig ?? '')) { tx.dataset.orig = text; D.setDocText(stepId, text); }
  else if (_deferred) { _deferred = false; setTimeout(_renderAll, 0); }
}
function _commitFocusedText() {
  const f = _shadow?.activeElement;
  if (f?.classList?.contains('tx') || (f?.classList?.contains('ct') && f.isContentEditable)) f.blur();
}

function _onPageClick(e) {
  if (e.target.closest?.('.slot')) return;                    // handled on pointerdown: select, drag, wheel
  if (_bandEdit) return;
  // the header / the footer: a click opens their editor (they are the document's — every page wears them)
  const zone = e.target.closest?.('.hdr, .ftr, .ci[data-band], .brule');
  if (zone) _enterBandEdit(zone.dataset?.band || (zone.matches('.ftr, .brule.footer') ? 'footer' : 'header'));
}

// ─── 🖼 pictures: select a slot, move / scale the picture behind it ─────────
// A slot is a MASK: the picture fills it (cropped) and can be dragged and
// wheel-scaled behind it; where it does not reach, the white page shows.

const _slotEl = (k) => _shadow.querySelector(`.slot[data-slot="${k}"]`);
const _slotIm = (k) => _pageModel?.images?.[k] || null;

/** Redraw ONE picture with a fit that is not committed yet (dragging / wheeling). */
function _applyFitLive(k, fit) {
  const im = _slotIm(k), img = _slotEl(k)?.querySelector('img.pic');
  if (!im || !img) return;
  const b = pictureBox(im.rect, im.aspect, fit);
  img.style.left = `calc(50% + ${b.dxMm}mm)`; img.style.top = `calc(50% + ${b.dyMm}mm)`; img.style.width = `${b.widthPct}%`;
}

function _selectSlot(k) {
  _slotSel = k;
  for (const s of _shadow.querySelectorAll('.slot')) s.classList.toggle('sel', Number(s.dataset.slot) === k);
  _placeSlotBar();
}

/** The little bar over the selected picture (light DOM, so it keeps its size whatever the page zoom). */
function _placeSlotBar() {
  let bar = _root.querySelector('#dw-slotbar');
  const el = _slotSel == null ? null : _slotEl(_slotSel);
  if (!el) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'dw-slotbar';
    bar.style.cssText = 'position:fixed;z-index:9050;display:flex;gap:4px;align-items:center;background:#0f172a;border:1px solid #38bdf8;border-radius:8px;padding:4px 6px;box-shadow:0 6px 20px rgba(0,0,0,.5);font-size:11.5px;color:#94a3b8;white-space:nowrap;';
    _root.appendChild(bar);
  }
  const im = _slotIm(_slotSel), has = !!el.querySelector('img.pic');
  const what = !im ? '' : im.state === 'asset' ? `external: ${im.name || 'image'}` : im.state === 'auto' ? 'automatic' : im.state === 'step' ? (im.moment === 'start' ? `before step ${im.label || ''}` : 'chosen step') : 'empty';
  bar.innerHTML = `<button class="dw-btn" data-act="slot-menu" style="padding:2px 9px;" title="Which picture goes here">Picture ▾</button>
    ${has ? `<button class="dw-btn" data-act="slot-fill" style="padding:2px 9px;" title="Fill the frame, centred (cropping what does not fit)">Fill</button>
    <button class="dw-btn" data-act="slot-whole" style="padding:2px 9px;" title="Show the whole picture inside the frame">Whole</button>
    <button class="dw-btn" data-act="slot-zoom" data-f="0.9" style="padding:2px 8px;">−</button><button class="dw-btn" data-act="slot-zoom" data-f="1.1111" style="padding:2px 8px;">+</button>
    <span style="padding:0 4px;">drag to move · wheel to scale</span>` : ''}<span style="padding:0 4px;color:#64748b;">${_esc(what)}</span>`;
  const r = el.getBoundingClientRect(), cr = _root.querySelector('#dw-center').getBoundingClientRect();
  bar.style.left = `${Math.max(cr.left + 4, Math.min(r.left, cr.right - bar.offsetWidth - 4))}px`;
  bar.style.top = `${Math.max(cr.top + 4, r.top - bar.offsetHeight - 6)}px`;
}

let _pan = null, _wheelTimer = 0, _wheelFit = null;

function _onSlotPointerDown(e) {
  const el = e.target.closest?.('.slot');
  if (!el) { if (_slotSel != null && !e.target.closest?.('.tx')) _selectSlot(null); return; }
  if (e.button !== 0) return;
  const k = Number(el.dataset.slot);
  _commitFocusedText();
  _selectSlot(k);
  const im = _slotIm(k);
  if (!im || !el.querySelector('img.pic')) return;
  e.preventDefault();                                         // no native image drag, no text selection
  _pan = { k, x: e.clientX, y: e.clientY, start: { ...im.fit }, fit: { ...im.fit }, moved: false, el };
  try { el.setPointerCapture?.(e.pointerId); } catch { /* a pointer that is already gone — the window-level pointerup still ends the drag */ }
}
function _onSlotPointerMove(e) {
  if (!_pan) return;
  const r = _pan.el.getBoundingClientRect();
  const dx = e.clientX - _pan.x, dy = e.clientY - _pan.y;
  if (!_pan.moved && Math.hypot(dx, dy) < 3) return;
  _pan.moved = true;
  _pan.fit = { zoom: _pan.start.zoom, ox: _pan.start.ox + dx / r.width, oy: _pan.start.oy + dy / r.height };
  _applyFitLive(_pan.k, _pan.fit);
}
function _onSlotPointerUp() {
  const p = _pan; _pan = null;
  if (p?.moved) D.setPagePictureFit(_pageId, p.k, p.fit);     // ONE undo entry per drag
}
/** Wheel = scale about the pointer; the commit waits until the wheel has been quiet for a moment (one undo entry). */
function _onSlotWheel(e) {
  const el = e.target.closest?.('.slot');
  if (!el || _slotSel == null || Number(el.dataset.slot) !== _slotSel || !el.querySelector('img.pic')) return;
  e.preventDefault();
  const k = _slotSel, im = _slotIm(k); if (!im) return;
  const cur = _wheelFit?.k === k ? _wheelFit.fit : { ...im.fit };
  const zoom = Math.max(0.05, Math.min(20, cur.zoom * Math.exp(-e.deltaY * 0.0015)));
  const f = zoom / cur.zoom, r = el.getBoundingClientRect();
  const px = (e.clientX - (r.left + r.width / 2)) / r.width, py = (e.clientY - (r.top + r.height / 2)) / r.height;
  const fit = { zoom, ox: px + (cur.ox - px) * f, oy: py + (cur.oy - py) * f };
  _wheelFit = { k, fit, pageId: _pageId };
  _applyFitLive(k, fit);
  clearTimeout(_wheelTimer);
  _wheelTimer = setTimeout(_flushWheel, 350);
}
function _flushWheel() {
  clearTimeout(_wheelTimer);
  const w = _wheelFit; _wheelFit = null;
  if (w && w.pageId === _pageId) D.setPagePictureFit(w.pageId, w.k, w.fit);
}

/** Which picture goes into the slot: automatic · a step of the page · an external image · empty. */
function _slotMenu(slot, x, y) {
  const c = _ctx();
  const page = c.doc.pages.find(p => p.id === _pageId); if (!page) return;
  const members = (page.stepIds || []).filter(id => !c.hidden.has(id)).flatMap(id => c.units.find(u => u.id === id)?.members || []);
  const st = slotState(page, slot), im = page.images?.[slot];
  const thumbs = _thumbsFor(c, members);
  const mp = D.renderModel().pages.find(p => p.id === _pageId);
  const autoStep = mp?.images?.[slot]?.state === 'auto' ? mp.images[slot].stepId : null;
  const row = (thumb, before, html) => `<span class="dw-prow">${_thumbBox(thumb, before)}<span style="min-width:0;">${html}</span></span>`;
  const no = (sid) => `<span class="dw-no" style="margin-inline-end:6px;">${_esc(c.nums.get(sid)?.label || '–')}</span>`;
  _openMenu([
    { cur: st === 'auto', html: row(autoStep ? thumbs.end.get(autoStep) : '', false, `<b>Automatic</b><div style="color:#94a3b8;font-size:11px;">follows the steps of the page${autoStep ? ` — now step ${_esc(c.nums.get(autoStep)?.label || '')}` : ''}</div>`), run: () => D.setPagePicture(_pageId, slot, null) },
    { sep: true },
    ...members.flatMap(sid => [
      { cur: st === 'step' && im?.stepId === sid && im?.moment !== 'start', html: row(thumbs.end.get(sid), false, `${no(sid)}<b>${_esc(c.stepById.get(sid)?.name || sid)}</b>`), run: () => D.setPagePicture(_pageId, slot, sid) },
      { cur: st === 'step' && im?.stepId === sid && im?.moment === 'start', html: `<span style="display:block;padding-inline-start:22px;">${row(thumbs.start.get(sid), true, `↳ <b>before</b> step ${_esc(c.nums.get(sid)?.label || '')}<div style="color:#94a3b8;font-size:11px;">the state it starts from, seen from its camera</div>`)}</span>`, run: () => D.setPagePicture(_pageId, slot, sid, 'start') },
    ]),
    { sep: true },
    { cur: st === 'asset', html: row(st === 'asset' ? (c.doc.assets?.[im.assetId]?.dataUrl || '') : '', false, `🖼 <b>External image…</b><div style="color:#94a3b8;font-size:11px;">a photo, a drawing — not from the animation${st === 'asset' ? ` · now: ${_esc(c.doc.assets?.[im.assetId]?.name || 'image')}` : ''}</div>`), run: () => { _assetSlot = slot; _root.querySelector('#dw-asset-file')?.click(); } },
    { cur: st === 'empty', label: 'Leave this frame empty', run: () => D.setPagePicture(_pageId, slot, 'empty') },
  ], x, y);
}

/** A thumbnail cell (or a grey placeholder); before = the amber "before" tag. */
function _thumbBox(url, before = false) {
  return `<span class="dw-pthumb">${url ? `<img src="${_esc(url)}" alt="" draggable="false">` : '—'}${before ? '<span class="tag">before</span>' : ''}</span>`;
}

/**
 * Small pictures for a picker. The rendered document picture when there is a fresh one (for a
 * BEFORE-frame that is the only true picture); otherwise the step's animation thumbnail — and for
 * a before-frame the thumbnail of the step BEFORE it, which shows the same state (from that step's camera).
 */
function _thumbsFor(c, stepIds) {
  const cached = D.cachedStills(stepIds.flatMap(id => [id, `${id}@start`]));
  const flat = c.units.flatMap(u => u.members);
  const end = new Map(), start = new Map();
  for (const id of stepIds) {
    end.set(id, cached.get(id) || c.stepById.get(id)?.thumbnail || '');
    const i = flat.indexOf(id);
    start.set(id, cached.get(`${id}@start`) || (i > 0 ? c.stepById.get(flat[i - 1])?.thumbnail : '') || '');
  }
  return { end, start };
}

/** What a frame shows right now — for the picker button in the left pane. */
function _pictureChoice(c, page, k, modelPage) {
  const st = slotState(page, k), im = page.images?.[k], mi = modelPage?.images?.[k];
  const name = (sid) => `${c.nums.get(sid)?.label ? c.nums.get(sid).label + ' · ' : ''}${c.stepById.get(sid)?.name || sid}`;
  if (st === 'asset') return { thumb: c.doc.assets?.[im.assetId]?.dataUrl || '', before: false, text: `External image: ${c.doc.assets?.[im.assetId]?.name || 'image'}` };
  if (st === 'empty') return { thumb: '', before: false, text: '— empty —' };
  const sid = st === 'auto' ? mi?.stepId : im?.stepId;
  if (!sid) return { thumb: '', before: false, text: st === 'auto' ? 'Automatic — no step left for this frame' : '—' };
  const before = st === 'step' && im?.moment === 'start';
  const t = _thumbsFor(c, [sid]);
  return { thumb: before ? t.start.get(sid) : t.end.get(sid), before, text: st === 'auto' ? `Automatic — ${name(sid)}` : before ? `before ${name(sid)}` : name(sid) };
}

/** External picture → downscaled, stored in the document (JPEG unless it really has transparency). */
async function _readAsset(file) {
  try {
    const url = await new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(String(rd.result)); rd.onerror = rej; rd.readAsDataURL(file); });
    const im = new Image(); im.src = url; await im.decode();
    const size = fitWithin(im.naturalWidth || 1200, im.naturalHeight || 800, 2400);
    const cv = document.createElement('canvas'); cv.width = size.w; cv.height = size.h;
    const x = cv.getContext('2d', { willReadFrequently: true });
    x.drawImage(im, 0, 0, size.w, size.h);
    const px = x.getImageData(0, 0, size.w, size.h).data;
    let clear = false;
    for (let i = 3, step = Math.max(4, Math.floor(px.length / 200000) * 4); i < px.length; i += step) if (px[i] < 250) { clear = true; break; }
    let dataUrl;
    if (clear) dataUrl = cv.toDataURL('image/png');
    else { const flat = document.createElement('canvas'); flat.width = size.w; flat.height = size.h; const fx = flat.getContext('2d'); fx.fillStyle = '#fff'; fx.fillRect(0, 0, size.w, size.h); fx.drawImage(cv, 0, 0); dataUrl = flat.toDataURL('image/jpeg', 0.9); }
    return { dataUrl, w: size.w, h: size.h, name: file.name };
  } catch (err) {
    console.error('[document] external image failed:', err);
    setStatus('That file could not be read as an image.', 'warn', 6000);
    return null;
  }
}
async function _importAsset(file, slot) {
  const asset = await _readAsset(file);
  if (!asset) return;
  D.setPagePictureAsset(_pageId, slot, asset);
  setStatus(`"${file.name}" added to the document (${asset.w} × ${asset.h}). Drag it to place it, wheel to scale.`, 'success', 6000);
}

// ─── 📐 template editor ─────────────────────────────────────────────────────

function _dimPanes(on) {
  for (const id of ['#dw-left', '#dw-right', '#dw-actions']) { const p = _root.querySelector(id); if (p) { p.style.opacity = on ? '.35' : ''; p.style.pointerEvents = on ? 'none' : ''; } }
}

/** Draw a layout, starting from the current page's. Saving stores it in the document and puts this page on it. */
function _openTemplateEditor(asNew) {
  const c = _ctx();
  const page = c.doc?.pages.find(p => p.id === _pageId); if (!page || _tplEd) return;
  _commitFocusedText(); _flushWheel(); _selectSlot(null); _closeMenu();
  const tpls = [...builtinTemplates(), ...(c.doc.templates || [])];
  const from = tpls.find(t => t.id === page.templateId) || tpls[0];
  const forPage = _pageId;
  _dimPanes(true);
  const done = () => { _tplEd = null; _dimPanes(false); _holdFocus(); };
  _tplEd = openTemplateEditor({
    host: _root.querySelector('#dw-center'), template: from, isNew: asNew || !!from.builtin,
    onSave: (tpl) => { done(); const id = D.saveTemplate(tpl, forPage); if (id) setStatus(`Template “${tpl.name}” saved — this page uses it now, and it is in the template list of every page.`, 'success', 7000); },
    onCancel: done,
  });
}

// ─── ✎ custom pages: free items between the header and the footer ──────────
// A custom page is NOT made of steps: a cover, a safety notice, a parts list. The user places
// text boxes and pictures freely (mm, half-mm grid, inside the content area). Text wears the
// document's body font — only size, weight, slant, alignment and colour vary. Every gesture
// (a drag, a resize, a typed text, a delete) is ONE undo entry.

let _customSel = null, _cdrag = null, _customModel = null;
let _bandEdit = null;                     // 'header' | 'footer' while the header / footer editor is open
let _stillsFailed = new Set();            // pictures that were asked for and did not come back: never walk for them in a loop
const C_AREA = { x: 12, y: 32, w: 186, h: 238.5 };
const CUSTOM_CSS = `
.cguide { position: absolute; border: 0.3mm dashed #cbd5e1; pointer-events: none; }
.ci { cursor: move; }
.ci:hover { outline: 0.3mm solid #60a5fa; }
.ci.ct[contenteditable] { cursor: text; outline: 0.4mm solid #2563eb; background: #eff6ff; overflow: visible; }
.csel { position: absolute; border: 0.5mm solid #f59e0b; pointer-events: none; box-sizing: border-box; }
.csel i { position: absolute; width: 3mm; height: 3mm; margin: -1.5mm 0 0 -1.5mm; background: #fff; border: 0.5mm solid #f59e0b; border-radius: 0.5mm; pointer-events: auto; box-sizing: border-box; }
.cempty { position: absolute; left: 12mm; right: 12mm; top: 120mm; text-align: center; color: #94a3b8; font-size: 12pt; pointer-events: none; }
.fit:not(.bandmode) .ci[data-band] { cursor: pointer; }
.fit:not(.bandmode) .ci[data-band]:hover { outline: 0.3mm dashed #60a5fa; }
.bandmode .cguide { border-color: #f59e0b; }
.bandmode .csel i { width: 2.4mm; height: 2.4mm; margin: -1.2mm 0 0 -1.2mm; }
`;
const C_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const _mmPerPx = () => { const pg = _shadow.querySelector('.page'); return pg ? 210 / pg.getBoundingClientRect().width : 1; };
const _customExtra = () => (D.getDocument()?.extras || []).find(x => x?.kind === 'custom' && x.id === _pageId) || null;
const _snap = (v) => Math.round(v * 2) / 2;

// ONE item editor, two hosts: the items of a custom page — or, while ✎ header / footer is open, the items
// of one BAND. A band is a smaller area, and on a right-to-left page it is SHOWN mirrored while it is
// stored left-to-right (like the picture frames): screen rectangles are converted on their way in.
const _editHost = () => (_bandEdit ? 'band' : _customExtra() ? 'custom' : null);
const _area = () => (_bandEdit ? BAND_MM[_bandEdit] : C_AREA);
const _minW = () => (_bandEdit ? 3 : 5), _minH = () => (_bandEdit ? 2 : 4);
const _toStored = (r) => ((_bandEdit && _customModel?.dir === 'rtl') ? { ...r, x: 210 - r.x - r.w } : r);
function _clampItemRect(r) {
  const A = _area();
  const w = Math.max(_minW(), Math.min(A.w, _snap(r.w))), h = Math.max(_minH(), Math.min(A.h, _snap(r.h)));
  return { x: Math.max(A.x, Math.min(A.x + A.w - w, _snap(r.x))), y: Math.max(A.y, Math.min(A.y + A.h - h, _snap(r.y))), w, h };
}
const _newItemId = (p, n) => `${p}_${Date.now().toString(36)}${n}`;

function _renderCustomPage(model, cp) {
  const editing = _shadow.activeElement;
  if (editing?.classList?.contains('ct') && editing.isContentEditable) { _deferred = true; return; }     // never rebuild under the caret
  _customModel = cp;
  const need = stillsNeeded({ customs: [cp] }), have = D.cachedStills(need);        // pictures taken from the animation
  const o = { stills: have, logo: D.documentLogo(), watermark: model.watermark, dir: model.dir, lang: model.lang };
  _shadow.innerHTML = `<style>${DOCUMENT_CSS}${watermarkCss(model.watermark)}${EDIT_CSS}${CUSTOM_CSS}</style><div class="fit">${renderCustomPageHtml(cp, o)}</div>`;
  const pg = _shadow.querySelector('.page');
  pg.insertAdjacentHTML('beforeend', `<div class="cguide" style="left:${C_AREA.x}mm;top:${C_AREA.y}mm;width:${C_AREA.w}mm;height:${C_AREA.h}mm;"></div>${cp.items.length ? '' : '<div class="cempty">An empty page. Add a text box or a picture with the bar above.</div>'}`);
  for (const el of _shadow.querySelectorAll('.ci.cp.none:not([data-band])')) { const it = cp.items.find(i => i.id === el.dataset.item); if (it?.key && _stillsFailed.has(it.key)) el.textContent = 'the picture could not be rendered'; }
  if (_customSel && !cp.items.some(i => i.id === _customSel)) _customSel = null;
  _placeCustomBar(); _fit(); _drawCustomSel();
  if (need.some(k => !have.has(k) && !_stillsFailed.has(k))) _loadStills();
}

/**
 * ✎ header / footer. The page on show is only the BACKDROP (dimmed, dead to the pointer); the items of
 * one band are live and the custom page's editor drives them. Whatever is done here is the document's
 * header / footer — every page wears it.
 */
function _renderBandEdit(model) {
  const editing = _shadow.activeElement;
  if (editing?.classList?.contains('ct') && editing.isContentEditable) { _deferred = true; return; }
  _pageModel = null; _slotSel = null; _placeSlotBar();
  const o = { logo: D.documentLogo(), watermark: model.watermark, dir: model.dir, lang: model.lang, tocTitle: model.toc?.title };
  let pm = null, html = '';
  if (_pageId === TOC && model.toc) { pm = model.toc.pages[0]; html = renderTocPageHtml(pm, o); }
  else if ((pm = model.customs.find(x => x.id === _pageId) || null)) html = renderCustomPageHtml(pm, { ...o, stills: D.cachedStills(stillsNeeded({ customs: [pm] })) });
  else if ((pm = model.pages.find(p => p.id === _pageId) || model.pages[0] || null)) html = renderPageHtml(pm, { ...o, stills: D.cachedStills(stillsNeeded({ pages: [pm] })) });
  const band = pm?.bandItems?.[_bandEdit];
  if (!band) { _bandEdit = null; _customSel = null; _placeCustomBar(); return _renderPage(); }       // the design was thrown away (an undo, ↺): back to the page
  _customModel = { items: band.items, dir: model.dir };
  const A = BAND_MM[_bandEdit];
  _shadow.innerHTML = `<style>${DOCUMENT_CSS}${watermarkCss(model.watermark)}${EDIT_CSS}${CUSTOM_CSS}</style><div class="fit bandmode">${html}</div>`;
  _shadow.querySelector('.page').insertAdjacentHTML('beforeend', `<div class="cguide" style="left:${A.x}mm;top:${A.y}mm;width:${A.w}mm;height:${A.h}mm;"></div>`);
  if (_customSel && !band.items.some(i => i.id === _customSel)) _customSel = null;
  _placeCustomBar(); _fit(); _drawCustomSel();
}

function _enterBandEdit(side) {
  if (_tplEd || _exporting) return;
  _commitFocusedText(); _flushWheel(); _closeMenu();
  _slotSel = null; _customSel = null;
  _bandEdit = side === 'footer' ? 'footer' : 'header';
  D.customiseBands();                  // the first time: the standard header and footer become free items that look exactly the same
  _renderAll();
}
function _exitBandEdit() {
  const a = _shadow.activeElement; if (a?.isContentEditable) a.blur();
  _bandEdit = null; _customSel = null;
  _renderAll();
}

function _drawCustomSel() {
  _shadow.querySelector('.csel')?.remove();
  const it = _customModel?.items.find(i => i.id === _customSel);
  const pg = _shadow.querySelector('.page');
  if (!it || !pg) return;
  pg.insertAdjacentHTML('beforeend', `<div class="csel" style="left:${it.x}mm;top:${it.y}mm;width:${it.w}mm;height:${it.h}mm;">${C_HANDLES.map(h => `<i data-ch="${h}" style="left:${h.includes('w') ? 0 : h.includes('e') ? 100 : 50}%;top:${h.includes('n') ? 0 : h.includes('s') ? 100 : 50}%;cursor:${h === 'n' || h === 's' ? 'ns' : h === 'e' || h === 'w' ? 'ew' : h === 'nw' || h === 'se' ? 'nwse' : 'nesw'}-resize;"></i>`).join('')}</div>`);
}

/** The bar over the page: add things; and, with an item selected, what can be changed about it. */
function _placeCustomBar() {
  let bar = _root.querySelector('#dw-custombar');
  const host = _editHost();
  if (!host || _tplEd) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'dw-custombar';
    bar.style.cssText = 'position:absolute;z-index:5;left:50%;top:8px;transform:translateX(-50%);display:flex;gap:5px;align-items:center;flex-wrap:wrap;justify-content:center;width:max-content;max-width:96%;box-sizing:border-box;background:#0f172a;border:1px solid #38bdf8;border-radius:9px;padding:5px 8px;box-shadow:0 6px 20px rgba(0,0,0,.5);font-size:11.5px;color:#94a3b8;';
    _root.querySelector('#dw-center').appendChild(bar);
  }
  bar.style.borderColor = host === 'band' ? '#f59e0b' : '#38bdf8';
  if (bar.contains(document.activeElement) && /^(INPUT)$/.test(document.activeElement.tagName) && document.activeElement.type !== 'color') return;   // typing a size
  const it = _customModel?.items.find(i => i.id === _customSel) || null;
  const stored = it ? _itemsNow().find(i => i.id === it.id) : null;
  const b = (act, label, title, on = false, style = '', attrs = '') => `<button class="dw-btn" data-act="${act}" ${attrs} title="${_esc(title)}" style="padding:2px 9px;${on ? 'background:#1d3a5f;border-color:#38bdf8;' : ''}${style}">${label}</button>`;
  const sep = '<span style="width:1px;height:18px;background:#334155;margin:0 3px;"></span>';
  const seg = (side, label) => `<button class="dw-btn" data-act="band-side" data-side="${side}" title="Edit the ${side}" style="border:0;border-radius:0;padding:2px 10px;${_bandEdit === side ? 'background:#1d3a5f;color:#38bdf8;font-weight:600;' : ''}">${label}</button>`;
  const lead = host === 'band'
    ? `<span style="display:inline-flex;border:1px solid #334155;border-radius:7px;overflow:hidden;">${seg('header', 'Header')}${seg('footer', 'Footer')}</span>${sep}`
      + b('ci-add-text', '＋ Text', 'A new text box') + b('ci-add-field', '＋ Field ▾', 'A value that fills itself in on every page: the title, the chapter, the page number…')
      + b('ci-add-picture', '＋ Picture ▾', 'The project’s logo, or a picture from a file')
      + b('band-rule', '▁ Line', `The line between the ${_bandEdit} and the page`, bandsOf(D.getDocument())[_bandEdit]?.rule !== false)
    : b('ci-add-text', '＋ Text', 'A new text box') + b('ci-add-picture', '＋ Picture ▾', 'A picture from a file — or a picture of any step of the animation');
  const tail = host === 'band' ? sep + b('band-reset', '↺ Standard', 'Throw this design away: back to the standard header and footer') + b('band-done', '✓ Done', 'Back to the page (Esc)', false, 'color:#4ade80;font-weight:600;') : '';
  const fitBtns = b('ci-fill', 'Fill', 'Fill the frame (cropping what does not fit)') + b('ci-whole', 'Whole', 'Show the whole picture inside the frame') + b('ci-zoom', '−', 'Smaller inside the frame', false, '', 'data-f="0.9"') + b('ci-zoom', '+', 'Larger inside the frame', false, '', 'data-f="1.1111"');
  bar.innerHTML = lead + '<input type="file" id="dw-ci-file" accept="image/*" hidden>'
    + (!it ? `<span style="padding:0 6px;">click an item to select it · double-click a text to type</span>` : sep
      + (it.type === 'text'
        ? `<label style="display:flex;gap:4px;align-items:center;">Size <input class="dw-in" data-ci="size" type="number" min="6" max="120" step="1" value="${it.size}" style="width:58px;"> pt</label>`
          + b('ci-bold', '<b>B</b>', 'Bold', it.bold) + b('ci-italic', '<i>I</i>', 'Italic', it.italic)
          + b('ci-align-start', '⫷', 'Align to the start', it.align === 'start') + b('ci-align-center', '⫿', 'Centre', it.align === 'center') + b('ci-align-end', '⫸', 'Align to the end', it.align === 'end')
          + `<input data-ci="color" type="color" value="${_esc(it.color)}" title="Text colour" style="width:30px;height:24px;padding:0;border:1px solid #334155;border-radius:5px;background:none;">`
        : it.logo ? '<span style="padding:0 4px;">the project’s logo — always shown whole</span>'
        : (stored?.stepId ? b('ci-step', `🎞 Step ${_esc(it.label || '—')} ▾`, 'Choose another step of the animation') + b('ci-moment', '↳ Before', 'Show the state this step STARTS from (seen from its camera) instead of its final state', stored.moment === 'start') : '') + fitBtns)
      + b('ci-front', '⤒ Front', 'Bring to the front') + b('ci-delete', '🗑', 'Delete this item (Delete key)', false, 'color:#fca5a5;'))
    + tail;
}

function _customLeftHtml(c, x) {
  const no = c.model.sequence.find(e => e.id === x.id)?.number ?? '—';
  return `<div class="dw-h">Page ${no} of ${c.model.total} — custom page</div>
    <label class="dw-lab">Name (shown in the list only)<input class="dw-in" data-custom-name value="${_esc(x.name || '')}" dir="auto"></label>
    <div style="font-size:11.5px;color:#94a3b8;line-height:1.55;">A page that is not made of steps — a cover, a safety notice, a parts list. It has the document's header and footer; between them you place what you want with the bar above the page:<br>
      • <b>＋ Text</b> adds a text box.<br>• <b>＋ Picture ▾</b> adds a picture from a file — or a picture of <b>any step of the animation</b> (its final state, or the state it starts from).<br>• Drag an item to move it, drag a handle to resize it; arrows nudge 1 mm (Shift 5).<br>• <b>Double-click a text</b> to type; click away to finish, Esc to abandon.<br>• Text wears the document's font — size, bold, italic, alignment and colour are yours.<br>• Delete removes the selected item.<br><br>
      Drag the <b>⠿</b> grip of the page in the list (or right-click it) to move the page anywhere in the document.</div>
    <div style="margin-top:10px;"><button class="dw-btn" data-act="custom-delete" style="color:#fca5a5;">🗑 Delete this page</button></div>`;
}

const FIELD_LABELS = [['title', 'Title'], ['company', 'Company'], ['docNo', 'Document no.'], ['rev', 'Revision'], ['project', 'Project name'], ['chapter', 'Chapter name'], ['chapterNo', 'Chapter number'], ['page', 'Page number'], ['pages', 'Number of pages'], ['date', 'Date of the export']];
function _bandLeftHtml() {
  return `<div class="dw-h">✎ Header and footer</div>
    <div style="font-size:11.5px;color:#94a3b8;line-height:1.55;">What you design here is printed on <b>every page</b> — step pages, the contents, custom pages. The page behind is only there to show you the result (← → walk the pages).<br><br>
      • <b>Header / Footer</b> on the bar chooses which one you are editing — or click an item of the other one.<br>• <b>＋ Text</b> adds a text box; <b>double-click</b> a text to type.<br>• <b>＋ Field ▾</b> adds a value that fills itself in: <span style="color:#cbd5e1;">{title} {chapter} {page}…</span> While you type you see the {name}; on the page you see the value. One box can mix both: <span style="color:#cbd5e1;">Page {page} / {pages}</span>.<br>• <b>＋ Picture ▾</b> adds the project's logo or a picture from a file.<br>• <b>▁ Line</b> shows or hides the rule.<br>• Drag to move, handles to resize, arrows nudge 1 mm (Shift 5), Delete removes. Items stay inside the dashed band.<br>• On a right-to-left document the whole design is mirrored by itself.<br><br>
      <b>↺ Standard</b> throws the design away. <b>✓ Done</b> or Esc goes back to the page.</div>`;
}

const _itemsNow = () => (_bandEdit ? (bandsOf(D.getDocument())[_bandEdit]?.items || []) : (_customExtra()?.items || [])).map(i => ({ ...i }));
function _commitItems(items, label) {
  if (_bandEdit) D.setBands({ [_bandEdit]: { items } }, label);
  else D.setCustomItems(_pageId, items, label);
}
function _patchItem(patch, label) {
  if (!_customSel) return;
  _commitItems(_itemsNow().map(i => (i.id === _customSel ? { ...i, ...patch } : i)), label);
}

function _onCustomPointerDown(e) {
  const host = _editHost();
  if (!host || e.button !== 0) return;
  const handle = e.target.closest?.('[data-ch]'), itemEl = e.target.closest?.('.ci[data-item]');
  if (itemEl?.isContentEditable) return;                              // typing: the text box is a text field now
  if (itemEl && !handle) {
    const band = itemEl.dataset.band || '';
    if (host === 'custom' && band) return;                            // the header / footer of a custom page: a click opens their editor (_onPageClick)
    if (host === 'band' && band && band !== _bandEdit) { e.preventDefault(); _commitFocusedText(); _bandEdit = band; _customSel = itemEl.dataset.item; _renderAll(); return; }   // an item of the OTHER band: go there
  }
  if (!handle && !itemEl) { if (_customSel) { _customSel = null; _drawCustomSel(); _placeCustomBar(); } return; }
  const id = handle ? _customSel : itemEl.dataset.item;
  const it = _customModel?.items.find(i => i.id === id); if (!it) return;
  e.preventDefault();
  _commitFocusedText();
  if (_customSel !== id) { _customSel = id; _drawCustomSel(); _placeCustomBar(); }
  _cdrag = { id, h: handle?.dataset.ch || '', x: e.clientX, y: e.clientY, start: { x: it.x, y: it.y, w: it.w, h: it.h }, rect: null, k: _mmPerPx() };
  try { (handle || itemEl).setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
}
function _onCustomPointerMove(e) {
  const d = _cdrag; if (!d) return;
  const dx = (e.clientX - d.x) * d.k, dy = (e.clientY - d.y) * d.k;
  if (!d.rect && Math.hypot(dx, dy) < 0.6) return;
  const A = _area(), mw = _minW(), mh = _minH();
  let { x, y, w, h } = d.start;
  if (!d.h) { x += dx; y += dy; }
  else {
    if (d.h.includes('e')) w = Math.max(mw, d.start.w + dx);
    if (d.h.includes('s')) h = Math.max(mh, d.start.h + dy);
    if (d.h.includes('w')) { w = Math.max(mw, d.start.w - dx); x = d.start.x + d.start.w - w; }
    if (d.h.includes('n')) { h = Math.max(mh, d.start.h - dy); y = d.start.y + d.start.h - h; }
    if (x < A.x) { w -= A.x - x; x = A.x; } if (y < A.y) { h -= A.y - y; y = A.y; }
    w = Math.min(w, A.x + A.w - x); h = Math.min(h, A.y + A.h - y);
  }
  d.rect = _clampItemRect({ x, y, w, h });
  for (const el of [_shadow.querySelector(`.ci[data-item="${CSS.escape(d.id)}"]`), _shadow.querySelector('.csel')]) if (el) { el.style.left = `${d.rect.x}mm`; el.style.top = `${d.rect.y}mm`; el.style.width = `${d.rect.w}mm`; el.style.height = `${d.rect.h}mm`; }
}
function _onCustomPointerUp() {
  const d = _cdrag; _cdrag = null;
  if (d?.rect) _commitItems(_itemsNow().map(i => (i.id === d.id ? { ...i, ..._toStored(d.rect) } : i)), d.h ? 'Resize item' : 'Move item');
}
function _onCustomDblClick(e) {
  const el = e.target.closest?.('.ci.ct[data-item]');
  const host = _editHost();
  if (!el || !host || (el.dataset.band || '') !== (host === 'band' ? _bandEdit : '')) return;
  _customSel = el.dataset.item; _drawCustomSel(); _placeCustomBar();
  // a band text shows its VALUES on the page ("Page 3 / 12"); to type, it shows what was written ("Page {page} / {pages}")
  if (host === 'band') el.innerText = _itemsNow().find(i => i.id === _customSel)?.text ?? el.innerText;
  el.setAttribute('contenteditable', 'plaintext-only'); el.dataset.orig = el.innerText;
  el.focus();
  const r = document.createRange(); r.selectNodeContents(el); const w = _shadow.getSelection ? _shadow.getSelection() : window.getSelection(); w?.removeAllRanges(); w?.addRange(r);
}
function _onCustomFocusOut(e) {
  const el = e.target;
  if (!el?.classList?.contains('ct') || !el.isContentEditable) return;
  const text = String(el.innerText ?? '').replace(/ /g, ' ').replace(/\n+$/, ''), id = el.dataset.item, orig = el.dataset.orig ?? '';
  el.removeAttribute('contenteditable');
  if (text !== orig.replace(/\n+$/, '')) _commitItems(_itemsNow().map(i => (i.id === id ? { ...i, text } : i)), 'Edit text');
  else if (_deferred || _bandEdit) { _deferred = false; setTimeout(_renderAll, 0); }      // a band text goes back to showing its values
}
/** @returns {boolean} handled */
function _onCustomKey(e) {
  if (!_editHost()) return false;
  const typing = _shadow.activeElement?.isContentEditable;
  if (e.key === 'Escape') {
    if (_menu) return false;
    if (typing) { const el = _shadow.activeElement; el.innerText = el.dataset.orig ?? ''; el.blur(); _root.focus({ preventScroll: true }); return true; }
    if (_customSel) { _customSel = null; _drawCustomSel(); _placeCustomBar(); return true; }
    if (_bandEdit) { _exitBandEdit(); return true; }
    return false;
  }
  if (typing || !_customSel) return false;
  const it = _customModel?.items.find(i => i.id === _customSel); if (!it) return false;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); const id = _customSel; _customSel = null; _commitItems(_itemsNow().filter(i => i.id !== id), 'Delete item'); return true; }
  if (/^Arrow/.test(e.key)) {
    e.preventDefault();
    const k = e.shiftKey ? 5 : 1;
    _patchItem(_toStored(_clampItemRect({ ...it, x: it.x + (e.key === 'ArrowRight' ? k : e.key === 'ArrowLeft' ? -k : 0), y: it.y + (e.key === 'ArrowDown' ? k : e.key === 'ArrowUp' ? -k : 0) })), 'Move item');
    return true;
  }
  return false;
}

/** Any step of the animation, with its thumbnail, chapter by chapter — for a picture on a custom page. */
function _stepPictureMenu(x, y, cur, run) {
  const c = _ctx();
  const flat = c.units.flatMap(u => u.members).filter(id => c.stepById.has(id));
  const thumbs = _thumbsFor(c, flat);
  const items = []; let chap = null;
  for (const sid of flat) {
    const s = c.stepById.get(sid), ch = s.chapterId || '';
    if (ch !== chap) { chap = ch; const name = c.chapters.find(k => k.id === ch)?.name; if (name) items.push({ head: name }); }
    items.push({ cur: cur === sid, html: `<span class="dw-prow">${_thumbBox(thumbs.end.get(sid))}<span style="min-width:0;"><span class="dw-no" style="margin-inline-end:6px;">${_esc(c.nums.get(sid)?.label || '–')}</span><b>${_esc(s.name || sid)}</b></span></span>`, run: () => run(sid) });
  }
  if (!flat.length) items.push({ label: 'The animation has no steps yet', run: () => {} });
  _openMenu(items, x, y);
}

function _customAct(act, el) {
  const host = _editHost();
  const r = el.getBoundingClientRect();
  if (act === 'band-edit') { _enterBandEdit(el.dataset.side); return true; }
  if (act === 'band-reset') {
    if (D.getDocument()?.bands && confirm('Throw away your header and footer design and go back to the standard one? (Undo brings it back.)')) { _bandEdit = null; _customSel = null; D.resetBands(); _renderAll(); }
    return true;
  }
  if (!host) return false;
  const it = _customModel?.items.find(i => i.id === _customSel) || null;
  const A = _area();
  if (act === 'band-done') { _exitBandEdit(); return true; }
  if (act === 'band-side') { const a = _shadow.activeElement; if (a?.isContentEditable) a.blur(); _bandEdit = el.dataset.side === 'footer' ? 'footer' : 'header'; _customSel = null; _renderAll(); return true; }
  if (act === 'band-rule') { if (_bandEdit) D.setBands({ [_bandEdit]: { rule: bandsOf(D.getDocument())[_bandEdit]?.rule === false } }, 'Header / footer line'); return true; }
  const addText = (text) => {
    const items = _itemsNow(), id = _newItemId(host === 'band' ? 'b' : 'ci', items.length);
    let box;
    if (host === 'band') { const h = Math.min(7, A.h), w = 50; box = { x: A.x + (A.w - w) / 2, y: A.y + (A.h - h) / 2, w, h, size: 9, align: 'center' }; }
    else {
      const lowest = items.reduce((m, i) => Math.max(m, i.y + i.h), A.y);
      box = { x: A.x, y: lowest + 4 + 18 <= A.y + A.h ? lowest + (items.length ? 4 : 8) : A.y + 8, w: A.w, h: 18, size: 11, align: 'start' };
    }
    _customSel = id;
    _commitItems([...items, { id, type: 'text', ..._clampItemRect(box), text, size: box.size, bold: false, italic: false, align: box.align, color: '#111111' }], 'Add text box');
  };
  if (act === 'ci-add-text') { addText('Text'); return true; }
  if (act === 'ci-add-field') {
    _openMenu(FIELD_LABELS.map(([k, l]) => ({ html: `<b>${_esc(l)}</b> <span style="color:#64748b;">{${k}}</span>`, run: () => {
      const sel = _itemsNow().find(i => i.id === _customSel && i.type === 'text');
      if (sel) _patchItem({ text: `${sel.text}${sel.text && !/\s$/.test(sel.text) ? ' ' : ''}{${k}}` }, 'Add field');      // into the selected text…
      else addText(`{${k}}`);                                                                                              // …or a box of its own
    } })), r.left, r.bottom + 4);
    return true;
  }
  if (act === 'ci-add-image') { _root.querySelector('#dw-ci-file')?.click(); return true; }
  if (act === 'ci-add-picture') {
    const file = { html: '🖼 <b>From a file…</b><div style="color:#94a3b8;font-size:11px;">a photo, a drawing, a symbol</div>', run: () => _root.querySelector('#dw-ci-file')?.click() };
    if (host === 'band') {
      const has = _itemsNow().some(i => i.logo), logo = D.documentLogo();
      _openMenu([{ html: `<span class="dw-prow">${_thumbBox(logo || '')}<span><b>The project’s logo</b><div style="color:#94a3b8;font-size:11px;">${!logo ? 'this project has no logo yet (Header ▸ logo in the animation)' : has ? 'already in this band — adds another one' : 'follows the project: change the logo there and it changes here'}</div></span></span>`, run: () => {
        const items = _itemsNow(), id = _newItemId('b', items.length), h = Math.min(14, A.h);
        _customSel = id;
        _commitItems([...items, { id, type: 'image', logo: true, ..._clampItemRect({ x: A.x, y: A.y + (A.h - h) / 2, w: 32, h }) }], 'Add logo');
      } }, file], r.left, r.bottom + 4);
    } else {
      _openMenu([file, { html: '🎞 <b>From the animation…</b><div style="color:#94a3b8;font-size:11px;">a picture of any step — it follows the step when it changes</div>', run: () => _stepPictureMenu(r.left, r.bottom + 4, null, (sid) => {
        const items = _itemsNow(), id = _newItemId('ci', items.length), w = Math.min(120, A.w), h = _snap(w * 9 / 16);
        _customSel = id;
        _commitItems([...items, { id, type: 'image', stepId: sid, moment: 'end', ..._clampItemRect({ x: A.x + (A.w - w) / 2, y: A.y + 20, w, h }) }], 'Add picture');
      }) }], r.left, r.bottom + 4);
    }
    return true;
  }
  if (act === 'custom-delete') { if (confirm('Delete this custom page and everything on it? (Undo brings it back.)')) { const id = _pageId; _pageId = null; _customSel = null; D.deleteCustomPage(id); } return true; }
  if (!it) return false;
  if (act === 'ci-delete') { const id = _customSel; _customSel = null; _commitItems(_itemsNow().filter(i => i.id !== id), 'Delete item'); return true; }
  if (act === 'ci-front') { const items = _itemsNow(); const me = items.find(i => i.id === _customSel); _commitItems([...items.filter(i => i !== me), me], 'Bring to the front'); return true; }
  if (act === 'ci-step') { _stepPictureMenu(r.left, r.bottom + 4, _itemsNow().find(i => i.id === _customSel)?.stepId || null, (sid) => _patchItem({ stepId: sid }, 'Choose picture')); return true; }
  if (act === 'ci-moment') { _patchItem({ moment: _itemsNow().find(i => i.id === _customSel)?.moment === 'start' ? 'end' : 'start' }, 'Before / after'); return true; }
  if (act === 'ci-bold') { _patchItem({ bold: !it.bold }, 'Bold'); return true; }
  if (act === 'ci-italic') { _patchItem({ italic: !it.italic }, 'Italic'); return true; }
  if (act.startsWith('ci-align-')) { _patchItem({ align: act.slice(9) }, 'Align text'); return true; }
  if (act === 'ci-fill') { _patchItem({ fit: { zoom: 1, ox: 0, oy: 0 } }, 'Picture fit'); return true; }
  if (act === 'ci-whole') { _patchItem({ fit: { zoom: containZoom(it, it.aspect), ox: 0, oy: 0 } }, 'Picture fit'); return true; }
  if (act === 'ci-zoom') { _patchItem({ fit: { ...it.fit, zoom: Math.max(0.05, Math.min(20, it.fit.zoom * Number(el.dataset.f))) } }, 'Picture fit'); return true; }
  return false;
}
function _customChange(t) {
  if (t.dataset?.ci === 'size') { _patchItem({ size: Math.max(6, Math.min(120, Number(t.value) || 11)) }, 'Text size'); return true; }
  if (t.dataset?.ci === 'color') { _patchItem({ color: t.value }, 'Text colour'); return true; }
  if (t.dataset?.customName !== undefined) { const n = t.value.trim(); if (n) D.renameCustomPage(_pageId, n); return true; }
  if (t.id === 'dw-ci-file') {
    const file = t.files?.[0]; t.value = '';
    const side = _bandEdit, forPage = _pageId;
    if (file) _readAsset(file).then(asset => {
      if (!asset || side !== _bandEdit || forPage !== _pageId) return;
      const A = _area(), ratio = asset.w / asset.h;
      let id = null;
      if (side) { const h = Math.max(_minH(), A.h - 4), w = Math.min(60, _snap(h * ratio)); id = D.addBandImage(side, asset, _clampItemRect({ x: A.x + (A.w - w) / 2, y: A.y + 2, w, h })); }
      else { const w = Math.min(120, A.w), h = Math.min(A.h, _snap(w / ratio)); id = D.addCustomImage(forPage, asset, _clampItemRect({ x: A.x + (A.w - w) / 2, y: A.y + 20, w, h })); }
      if (id) { _customSel = id; setStatus(`“${file.name}” added. Drag it to place it, drag a handle to size it.`, 'success', 6000); _renderAll(); }
    });
    return true;
  }
  return false;
}

// ─── panes: draggable separators ────────────────────────────────────────────
// The page needs room; on a small screen the two side panes must give way. Widths are the
// user's (remembered on this machine); the centre is never squeezed below a usable size.

const PANES_KEY = 'sbs.document.panes', CENTRE_MIN = 340;
let _panes = null, _split = null;
function _loadPanes() {
  if (_panes) return _panes;
  let v = null;
  try { v = JSON.parse(localStorage.getItem(PANES_KEY) || 'null'); } catch { /* a private window, a cleared store: defaults */ }
  _panes = { l: Number.isFinite(v?.l) ? v.l : 290, r: Number.isFinite(v?.r) ? v.r : 330, lOff: !!v?.lOff, rOff: !!v?.rOff };
  return _panes;
}
function _savePanes() { try { localStorage.setItem(PANES_KEY, JSON.stringify(_panes)); } catch { /* not remembered, still works */ } }
function _applyPanes() {
  if (!_root) return;
  const p = _loadPanes(), W = _root.clientWidth || window.innerWidth;
  let l = p.lOff ? 0 : Math.max(180, Math.min(p.l, W * 0.45)), r = p.rOff ? 0 : Math.max(200, Math.min(p.r, W * 0.5));
  // not enough room for the page: the list gives way first, then the settings fold away entirely
  if (W - l - r - 14 < CENTRE_MIN && r) r = Math.max(200, W - l - 14 - CENTRE_MIN);
  if (W - l - r - 14 < CENTRE_MIN && l) l = Math.max(0, W - r - 14 - CENTRE_MIN) < 180 ? 0 : W - r - 14 - CENTRE_MIN;
  const L = _root.querySelector('#dw-left'), R = _root.querySelector('#dw-right');
  L.style.flexBasis = `${l}px`; L.style.padding = l ? '4px 14px 16px' : '0'; L.style.overflow = l ? 'auto' : 'hidden';
  R.style.flexBasis = `${r}px`; R.style.overflow = r ? '' : 'hidden';
}
function _onSplitDown(e) {
  const sp = e.target.closest?.('.dw-split');
  if (!sp || e.button !== 0) return;
  e.preventDefault();
  const p = _loadPanes(), side = sp.dataset.split;
  _split = { side, x: e.clientX, start: side === 'l' ? _root.querySelector('#dw-left').getBoundingClientRect().width : _root.querySelector('#dw-right').getBoundingClientRect().width, el: sp };
  if (side === 'l') p.lOff = false; else p.rOff = false;
  sp.classList.add('on');
  try { sp.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
}
function _onSplitMove(e) {
  if (!_split) return;
  const p = _loadPanes(), d = e.clientX - _split.x;
  if (_split.side === 'l') p.l = Math.max(180, _split.start + d); else p.r = Math.max(200, _split.start - d);
  _applyPanes(); _fit();
}
function _onSplitUp() {
  if (!_split) return;
  _split.el.classList.remove('on'); _split = null;
  _savePanes(); _renderList(_ctx());                                  // thumbnails re-measure their rows
}
function _togglePane(side) {
  const p = _loadPanes();
  if (side === 'l') p.lOff = !p.lOff; else p.rOff = !p.rOff;
  _savePanes(); _applyPanes(); _fit();
}

// ─── menus ──────────────────────────────────────────────────────────────────

/** items: { label | html, run } · { sep:true } */
function _openMenu(items, x, y) {
  _closeMenu();
  _menu = document.createElement('div');
  _menu.className = 'dw-menu';
  _menu.innerHTML = items.map((it, i) => it.sep ? '<hr style="border:0;border-top:1px solid #334155;margin:4px 2px;">' : it.head ? `<p style="margin:8px 10px 3px;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:#94a3b8;">${_esc(it.head)}</p>` : `<div data-i="${i}"${it.cur ? ' class="cur"' : ''}>${it.html || _esc(it.label)}</div>`).join('');
  _menu.addEventListener('click', (ev) => {
    const d = ev.target.closest('.dw-menu > [data-i]'); if (!d) return;
    ev.stopPropagation();
    const it = items[Number(d.dataset.i)];
    _closeMenu();
    it?.run?.();
  });
  _root.appendChild(_menu);
  _menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - _menu.offsetWidth - 6))}px`;
  _menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - _menu.offsetHeight - 6))}px`;
}
function _closeMenu() { _menu?.remove(); _menu = null; }

/** What the current selection allows — shared by the bar above the list and the right-click menu. */
function _selectionActions(c) {
  const order = c.units.map(u => u.id);
  const sel = order.filter(id => _sel.has(id) && c.pageOfUnit.has(id));
  const out = { sel, merge: null, split: null, unmerge: null, hide: null, show: null };
  if (!sel.length) return out;
  const lbl = (id) => c.nums.get(id)?.label || '';
  if (sel.length >= 2) {
    const pagesTouched = new Set(sel.map(id => c.pageOfUnit.get(id).id));
    if (pagesTouched.size > 1) out.merge = { label: `Join steps ${lbl(sel[0])}–${lbl(sel[sel.length - 1])} into one page`, run: () => { const pid = D.mergeSteps(sel); if (pid && _showPage(pid)) _renderAll(); } };
  } else {
    const p = c.pageOfUnit.get(sel[0]), k = p.stepIds.indexOf(sel[0]);
    if (p.stepIds.length > 1 && k > 0) out.split = { label: `Start a new page at step ${lbl(sel[0])}`, run: () => { D.splitPageBefore(p.id, sel[0]); const np = _ctx().pageOfUnit.get(sel[0]); if (np && _showPage(np.id)) _renderAll(); } };
  }
  const pg = c.pageOfUnit.get(sel[0]);
  if (sel.length === 1 && pg.stepIds.length > 1) out.unmerge = { label: 'Un-merge — one page per step', run: () => D.splitPageAll(pg.id) };
  const n = sel.length === 1 ? `step ${lbl(sel[0])}` : `steps ${lbl(sel[0])}–${lbl(sel[sel.length - 1])}`;
  if (sel.some(id => !c.hidden.has(id))) out.hide = { label: `🙈 Leave ${n} out of the document`, run: () => D.setStepsHidden(sel, true) };
  if (sel.some(id => c.hidden.has(id))) out.show = { label: `👁 Put ${n} back into the document`, run: () => D.setStepsHidden(sel, false) };
  return out;
}

function _onContextMenu(e) {
  const extra = e.target.closest?.('[data-extra]');
  if (extra) { e.preventDefault(); if (_showPage(extra.dataset.extra)) { _sel = new Set(); _renderAll(); } _extraMenu(extra.dataset.extra, e.clientX, e.clientY); return; }
  const row = e.target.closest?.('.dw-step');
  if (!row || row.classList.contains('pending')) return;
  e.preventDefault();
  const id = row.dataset.unit;
  if (!_sel.has(id)) { _sel = new Set([id]); _anchor = id; const c0 = _ctx(); if (_showPage(c0.pageOfUnit.get(id)?.id)) _renderAll(); else _renderList(c0); }
  const a = _selectionActions(_ctx());
  const items = [a.merge, a.split, a.unmerge].filter(Boolean);
  if (items.length && (a.hide || a.show)) items.push({ sep: true });
  items.push(...[a.hide, a.show].filter(Boolean));
  if (items.length) _openMenu(items, e.clientX, e.clientY);
}

// ─── events ─────────────────────────────────────────────────────────────────

function _showPage(pageId) {
  if (!pageId || pageId === _pageId) return false;
  _commitFocusedText();
  _flushWheel();
  _pageId = pageId; _slotSel = null; _customSel = null;
  return true;
}

async function _onClick(e) {
  const eye = e.target.closest?.('[data-act="hide-toggle"]');
  if (eye) { e.preventDefault(); const c0 = _ctx(), id0 = eye.dataset.unit; const ids = _sel.has(id0) && _sel.size > 1 ? [..._sel] : [id0]; D.setStepsHidden(ids, !c0.hidden.has(id0)); return; }
  const stepEl = e.target.closest?.('.dw-step');
  if (stepEl) {
    const c = _ctx(), id = stepEl.dataset.unit, order = c.units.map(u => u.id);
    // A selection is ALWAYS one unbroken range: Shift OR Ctrl + click = everything from the anchor to here.
    // (Ctrl used to toggle single steps — Ctrl-clicking the step that was already selected silently dropped
    // it, and the join then left it outside.)
    if ((e.shiftKey || e.ctrlKey || e.metaKey) && _anchor && order.includes(_anchor)) {
      const a = order.indexOf(_anchor), b = order.indexOf(id);
      _sel = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else { _sel = new Set([id]); _anchor = id; }
    const changed = _showPage(c.pageOfUnit.get(id)?.id);
    if (changed) _renderAll(); else { _renderList(_ctx()); _holdFocus(); }
    return;
  }
  const head = e.target.closest?.('[data-goto-page]');
  if (head && !e.target.closest('[data-act]') && !e.target.closest('[data-grip]')) {
    // the head of a JOINED page stands for all of its steps: clicking it selects them (Shift / Ctrl extends the range to them)
    const c1 = _ctx(), pg = head.dataset.selectPage ? c1.doc.pages.find(p => p.id === head.dataset.selectPage) : null;
    if (pg) {
      const order = c1.units.map(u => u.id), mine = pg.stepIds.filter(id => order.includes(id));
      if ((e.shiftKey || e.ctrlKey || e.metaKey) && _anchor && order.includes(_anchor)) {
        const a = order.indexOf(_anchor), lo = Math.min(a, order.indexOf(mine[0])), hi = Math.max(a, order.indexOf(mine[mine.length - 1]));
        _sel = new Set(order.slice(lo, hi + 1));
      } else { _sel = new Set(mine); _anchor = mine[0]; }
    } else _sel = new Set();
    if (_showPage(head.dataset.gotoPage)) _renderAll(); else { _renderList(_ctx()); _holdFocus(); }
    return;
  }

  const el = e.target.closest?.('[data-act]');
  if (!el) return;
  e.preventDefault();
  const act = el.dataset.act;
  if (act === 'close') return closeDocumentWorkspace();
  if (act === 'build') { const d = D.buildPages(); _pageId = d?.pages?.[0]?.id || null; return; }
  if (act === 'zoom-fit' || act === 'zoom-100') { _zoom = act === 'zoom-fit' ? 'fit' : '100'; _renderTop(_ctx()); _fit(); _holdFocus(); return; }
  if (act === 'wm-toggle') { _wmOpen = !_wmOpen; _renderLeft(_ctx()); _holdFocus(); return; }
  if (act === 'wm-choose') { _root.querySelector('input[data-wm-file]')?.click(); return; }
  if (act === 'add-custom') { _addCustomPage(); return; }
  if ((act.startsWith('ci-') || act.startsWith('band-') || act === 'custom-delete') && _customAct(act, el)) return;
  if (act === 'tpl-new' || act === 'tpl-edit') { _openTemplateEditor(act === 'tpl-new'); return; }
  if (act === 'tpl-delete') { const pg = _ctx().doc.pages.find(p => p.id === _pageId); if (pg && confirm('Delete this template? Pages that use it go back to the automatic layout. (Undo brings it back.)')) D.deleteTemplate(pg.templateId); return; }
  if (act === 'sel-action') { _commitFocusedText(); _selBarActions[Number(el.dataset.i)]?.run?.(); return; }
  if (act === 'slot-pick') { const r = el.getBoundingClientRect(); _slotMenu(Number(el.dataset.slot), r.left, r.bottom + 4); return; }
  if (act === 'slot-menu') { const r = el.getBoundingClientRect(); _slotMenu(_slotSel ?? 0, r.left, r.bottom + 4); return; }
  if (act === 'slot-fill') { if (_slotSel != null) D.setPagePictureFit(_pageId, _slotSel, null); return; }
  if (act === 'slot-whole') { const im = _slotIm(_slotSel); if (im) D.setPagePictureFit(_pageId, _slotSel, { zoom: containZoom(im.rect, im.aspect), ox: 0, oy: 0 }); return; }
  if (act === 'slot-zoom') { const im = _slotIm(_slotSel); if (im) D.setPagePictureFit(_pageId, _slotSel, { ...im.fit, zoom: Math.max(0.05, Math.min(20, im.fit.zoom * Number(el.dataset.f))) }); return; }
  if (act === 'rerender-pictures') { D.clearStills(); _stillsFailed = new Set(); _renderPage(_ctx()); return; }
  _commitFocusedText();
  if (act === 'sync') return void D.syncWithAnimation();
  if (act === 'reviewed') return D.markPageReviewed(_pageId);
  if (act === 'reviewed-all') return D.markPageReviewed(null);
  if (act === 'delete-page') return D.deletePage(el.dataset.page);
  if (act === 'reset-text') return D.setDocText(el.dataset.step, null);
  if (act === 'accept-drift') return D.acceptDrift(el.dataset.step);
  if (act === 'split-all') return D.splitPageAll(_pageId);
  if (act === 'export') {
    if (_exporting || _walking) return;
    _exporting = true;
    try { await D.exportPdf(); }
    catch (err) { console.error('[document] export failed:', err); }
    finally { _exporting = false; _deferred = false; _renderAll(); }
  }
}

function _onChange(e) {
  const t = e.target;
  if (_customChange(t)) return;
  if (t.dataset?.wm) return D.setWatermark({ [t.dataset.wm]: _wmValue(t) });
  if (t.matches?.('input[data-wm-file]')) {
    const file = t.files?.[0]; if (!file) return;
    const rd = new FileReader();
    rd.onload = () => _openWatermarkDialog(String(rd.result), file.name);
    rd.onerror = () => setStatus('That file could not be read.', 'warn', 6000);
    rd.readAsDataURL(file);
    t.value = '';
    return;
  }
  if (t.dataset?.field) return D.setFields({ [t.dataset.field]: t.value });
  if (t.dataset?.opt === 'numbering') return D.setOptions({ numbering: t.value });
  if (t.dataset?.opt === 'direction') return D.setOptions({ direction: t.value });
  if (t.dataset?.opt === 'toc') return D.setOptions({ toc: t.checked });
  if (t.dataset?.opt === 'pictureNumbers') return D.setOptions({ pictureNumbers: t.checked });
  if (t.dataset?.pageOpt === 'template') return D.setPageTemplate(_pageId, t.value || null);
  if (t.id === 'dw-asset-file') { const file = t.files?.[0]; t.value = ''; if (file) _importAsset(file, _assetSlot); return; }
}

function _onKey(e, editable) {
  if (_tplEd) return;
  if (_onCustomKey(e)) return;                                          // the template editor has the keyboard (arrows nudge a box there)
  if (e.key === 'Escape') {
    if (_slotSel != null && !_menu && !_wmDlg) { _selectSlot(null); return; }
    if (_wmDlg) { _wmDlg.remove(); _wmDlg = null; _holdFocus(); return; }
    if (_menu) { _closeMenu(); return; }
    const f = _shadow.activeElement;
    if (f?.classList?.contains('tx')) { f.innerText = f.dataset.orig ?? ''; f.blur(); _markOverflow(); _root.focus({ preventScroll: true }); }
    return;
  }
  if (editable || e.ctrlKey || e.metaKey || e.altKey) return;
  const c = _ctx();
  if (!c.doc?.pages?.length) return;
  const order = c.units.map(u => u.id).filter(id => c.pageOfUnit.has(id));
  const move = (to) => { if (!to) return; e.preventDefault(); _sel = new Set([to]); _anchor = to; _showPage(c.pageOfUnit.get(to).id); _renderAll(); _root.querySelector(`.dw-step[data-unit="${CSS.escape(to)}"]`)?.scrollIntoView({ block: 'nearest' }); };
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const cur = order.indexOf(_anchor);
    return move(order[Math.max(0, Math.min(order.length - 1, (cur < 0 ? 0 : cur + (e.key === 'ArrowDown' ? 1 : -1))))]);
  }
  if (e.key === 'PageDown' || e.key === 'PageUp' || e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    const ids = c.model.sequence.map(x => x.id);                       // what prints, in order: step pages, the contents, custom pages
    const k = ids.indexOf(_pageId), fwd = e.key === 'PageDown' || e.key === 'ArrowRight';
    const to = ids[Math.max(0, Math.min(ids.length - 1, (k < 0 ? 0 : k + (fwd ? 1 : -1))))];
    if (!to || to === _pageId) return;
    const pg = c.doc.pages.find(p => p.id === to);
    if (pg) return move(pg.stepIds.find(id => c.pageOfUnit.has(id)));
    if (_showPage(to)) { _sel = new Set(); _renderAll(); _root.querySelector(`[data-pagebox="${CSS.escape(to)}"]`)?.scrollIntoView({ block: 'nearest' }); }
    return;
  }
}
