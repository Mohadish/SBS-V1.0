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
import { builtinTemplates, docTextFor, pageRangeLabel, unitsOf, stillsNeeded } from '../systems/document-core.js';
import { DOCUMENT_CSS, renderPageHtml } from '../systems/document-render.js';
import { watermarkOf, watermarkHtml, watermarkCss, watermarkVisible, detectWatermarkMode, bakeWatermarkPixels, fitWithin } from '../systems/watermark-core.js';
import * as D from '../systems/document.js';

const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FLAG_ICON = { added: '➕', removed: '➖', 'moved-out': '↗', new: '🆕', 'image-left': '🖼', empty: '∅' };
const PAGE_W = 210 * 96 / 25.4, PAGE_H = 297 * 96 / 25.4;      // A4 in CSS px

let _root = null, _shadow = null, _statusObs = null;
let _sel = new Set(), _anchor = null, _pageId = null, _zoom = 'fit';
let _walking = false, _walkAgain = false, _exporting = false, _deferred = false, _menu = null, _renderTimer = 0;
let _ptrDown = false, _renderHeld = false;
let _wmOpen = false, _wmDlg = null;

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
.slot:hover { outline: 0.5mm solid #2563eb; outline-offset: -0.5mm; }
.hdr, .ftr { cursor: pointer; }
.hdr:hover, .ftr:hover { background: #eff6ff; }
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
      #document-workspace .dw-thumb { width:84px;height:48px;flex:0 0 auto;border-radius:4px;background:#1e293b;border:1px solid #334155;object-fit:cover;display:block; }
      #document-workspace .dw-no { flex:0 0 auto;min-width:26px;text-align:center;font-weight:700;font-size:11.5px;background:#0b1220;border:1px solid #334155;border-radius:9px;padding:1px 6px; }
      #document-workspace .dw-chap { margin:10px 10px 6px;font-size:11px;font-weight:700;color:#cbd5e1;letter-spacing:.04em; }
      #document-workspace .dw-menu { position:fixed;z-index:9100;background:#0f172a;border:1px solid #334155;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.6);padding:4px;min-width:230px;max-height:60vh;overflow:auto; }
      #document-workspace .dw-menu div { padding:6px 10px;border-radius:5px;cursor:pointer;font-size:12.5px; } #document-workspace .dw-menu div:hover { background:#1d3a5f; }
    </style>
    <div id="dw-top" style="flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 12px;background:#111a2c;border-bottom:1px solid #334155;">
      <span style="font-weight:700;font-size:14px;">📄 Document</span>
      <span id="dw-status" style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#94a3b8;font-size:12px;padding:0 10px;"></span>
      <span id="dw-actions" style="display:flex;gap:8px;align-items:center;"></span>
      <button class="dw-btn" data-act="close" title="Close the document workspace — nothing is lost, the document is part of the project">◀ Back to the animation</button>
    </div>
    <div style="flex:1 1 auto;min-height:0;display:flex;">
      <div id="dw-left"  style="flex:0 0 290px;min-height:0;overflow:auto;padding:4px 14px 16px;border-right:1px solid #334155;background:#0f172a;"></div>
      <div id="dw-center" style="flex:1 1 auto;min-width:0;min-height:0;overflow:auto;background:#334155;position:relative;"></div>
      <div id="dw-right" style="flex:0 0 330px;min-height:0;display:flex;flex-direction:column;border-left:1px solid #334155;background:#0f172a;">
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
  const release = () => { if (!_ptrDown) return; _ptrDown = false; if (_renderHeld) { _renderHeld = false; setTimeout(() => { if (_isOpen()) _renderAll(); }, 0); } };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  _shadow.addEventListener('focusout', (e) => { if (e.target?.classList?.contains('tx')) _commitText(e.target); });
  _shadow.addEventListener('input', () => _markOverflow());
  _shadow.addEventListener('click', _onPageClick);

  window.addEventListener('resize', () => { if (_isOpen()) _fit(); });
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
  return { doc, steps, chapters, perChapter, units, pageOfUnit, stepById: new Map(steps.map(s => [s.id, s])), nums: numberSteps(steps, chapters, perChapter) };
}

function _renderAll() {
  if (_exporting) { _deferred = true; return; }
  if (_ptrDown) { _renderHeld = true; return; }
  const c = _ctx();
  if (!c.doc || !c.doc.pages?.length) { _renderEmpty(); return _holdFocus(); }
  if (!c.doc.pages.some(p => p.id === _pageId)) _pageId = c.doc.pages[0].id;
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
  const page = c.doc.pages.find(p => p.id === _pageId);
  const pi = c.doc.pages.indexOf(page);
  const tpls = [...builtinTemplates(), ...(c.doc.templates || [])];
  const tplNow = tpls.find(t => t.id === page.templateId) || tpls[0];
  const members = (page.stepIds || []).flatMap(id => c.units.find(u => u.id === id)?.members || []);
  const flags = page.flags || [];
  const label = (sid) => `${c.nums.get(sid)?.label ? c.nums.get(sid).label + ' · ' : ''}${c.stepById.get(sid)?.name || sid}`;

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
      <select class="dw-in" data-opt="numbering">${[['step', 'The same numbers as the animation'], ['page', '1, 2, 3 on every page'], ['none', 'No numbers']].map(([v, l]) => `<option value="${v}"${(c.doc.options?.numbering || 'step') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
  const pageHtml = `
    <div class="dw-h">Page ${pi + 1} of ${c.doc.pages.length}</div>
    <div style="font-size:12px;color:#cbd5e1;margin-bottom:8px;">${_esc(pageRangeLabel(page, c.steps, c.chapters, c.perChapter))}</div>
    ${flags.length ? `<div style="margin:0 0 10px;padding:7px 9px;border-radius:7px;background:rgba(245,158,11,.13);border:1px solid #b45309;font-size:11.5px;line-height:1.5;">${flags.map(x => `${FLAG_ICON[x.kind] || '!'} ${_esc(x.note)}`).join('<br>')}
      <div style="margin-top:5px;"><a data-act="reviewed">✓ Seen — clear these marks</a></div></div>` : ''}
    <label class="dw-lab">Page template
      <select class="dw-in" data-page-opt="template">${tpls.map(t => `<option value="${_esc(t.id)}"${t.id === page.templateId ? ' selected' : ''}>${_esc(t.name)}</option>`).join('')}</select></label>
    ${(tplNow.images || []).map((_, k) => `<label class="dw-lab">Picture ${k + 1}
      <select class="dw-in" data-page-opt="picture" data-slot="${k}">
        ${k === 0 ? `<option value=""${(page.images?.[0]?.auto || !page.images?.[0]?.stepId) ? ' selected' : ''}>Automatic — the page's last step</option>` : `<option value=""${!page.images?.[k]?.stepId ? ' selected' : ''}>— empty —</option>`}
        ${members.map(sid => `<option value="${_esc(sid)}"${(page.images?.[k]?.stepId === sid && !(k === 0 && page.images?.[0]?.auto)) ? ' selected' : ''}>${_esc(label(sid))}</option>`).join('')}
      </select></label>`).join('')}
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
  pageBox.innerHTML = pageHtml;
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

// ─── RIGHT: the steps, boxed by page ────────────────────────────────────────

function _renderList(c) {
  const list = _root.querySelector('#dw-list');
  const keep = list.scrollTop;
  const thumbOf = (u) => { for (let i = u.members.length - 1; i >= 0; i--) { const t = c.stepById.get(u.members[i])?.thumbnail; if (t) return t; } return ''; };
  const stepRow = (u, pending) => {
    const s = c.stepById.get(u.id);
    const t = s ? docTextFor(s, c.doc.texts, srcHashOf) : { text: '' };
    const th = thumbOf(u);
    return `<div class="dw-step${_sel.has(u.id) ? ' sel' : ''}${pending ? ' pending' : ''}" data-unit="${_esc(u.id)}" title="${pending ? 'Not in the document yet — sync to add it' : 'Click to show its page · Ctrl / Shift-click to select several'}">
      ${th ? `<img class="dw-thumb" src="${_esc(th)}" alt="" draggable="false">` : '<div class="dw-thumb"></div>'}
      <span class="dw-no">${_esc(c.nums.get(u.id)?.label || '–')}</span>
      <div style="min-width:0;flex:1;">
        <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(s?.name || u.id)}${u.members.length > 1 ? ` <span style="color:#94a3b8;font-weight:400;">+${u.members.length - 1} sub</span>` : ''}</div>
        <div dir="auto" style="font-size:11px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${pending ? 'new in the animation — sync to add' : _esc(t.text)}</div>
      </div></div>`;
  };

  // walk the timeline; open a page box whenever the page changes
  let html = '', lastChapter = undefined, openPage = null;
  const close = () => { if (openPage !== null) { html += '</div>'; openPage = null; } };
  const pageNo = new Map(c.doc.pages.map((p, i) => [p.id, i + 1]));
  for (const u of c.units) {
    const p = c.pageOfUnit.get(u.id) || null;
    if (u.chapterId !== lastChapter) {
      close();
      const ch = c.chapters.find(x => x.id === u.chapterId);
      if (ch) html += `<div class="dw-chap" dir="auto">${_esc(ch.name)}</div>`;
      lastChapter = u.chapterId;
    }
    if (!p) { close(); html += `<div class="dw-pagebox" style="border-style:dashed;">${stepRow(u, true)}</div>`; continue; }
    if (openPage !== p.id) {
      close();
      const flags = p.flags || [];
      html += `<div class="dw-pagebox${p.id === _pageId ? ' cur' : ''}${flags.length ? ' flag' : ''}" data-pagebox="${_esc(p.id)}">
        <div class="dw-pagehead" data-goto-page="${_esc(p.id)}"><b style="color:#e2e8f0;">Page ${pageNo.get(p.id)}</b>${p.stepIds.length > 1 ? `<span>· ${p.stepIds.length} steps merged</span>` : ''}<span style="flex:1"></span>${flags.length ? `<span title="${_esc(flags.map(x => x.note).join('\n'))}" style="color:#fbbf24;">❗ ${flags.map(x => FLAG_ICON[x.kind] || '!').join(' ')}</span>` : ''}</div>`;
      openPage = p.id;
    }
    html += stepRow(u, false);
  }
  close();
  // pages with no steps left (flagged ∅ by a sync) — only deletable
  for (const p of c.doc.pages) if (!(p.stepIds || []).length) html += `<div class="dw-pagebox flag"><div class="dw-pagehead"><b style="color:#e2e8f0;">Page ${pageNo.get(p.id)}</b><span>· ∅ no steps left</span><span style="flex:1"></span><a data-act="delete-page" data-page="${_esc(p.id)}" style="color:#fca5a5;">delete</a></div></div>`;
  list.innerHTML = html;
  list.scrollTop = keep;
  _renderSelBar(c);
}

function _renderSelBar(c) {
  const bar = _root.querySelector('#dw-selbar');
  const order = c.units.map(u => u.id);
  const sel = order.filter(id => _sel.has(id) && c.pageOfUnit.has(id));
  let html = '';
  if (sel.length >= 2) {
    const lo = order.indexOf(sel[0]), hi = order.indexOf(sel[sel.length - 1]);
    const range = order.slice(lo, hi + 1).filter(id => c.pageOfUnit.has(id));
    const pagesTouched = new Set(range.map(id => c.pageOfUnit.get(id).id));
    const a = c.nums.get(range[0])?.label || '', b = c.nums.get(range[range.length - 1])?.label || '';
    html = pagesTouched.size > 1
      ? `<button class="dw-btn primary" data-act="merge-sel" title="The document only — the animation and its step numbers stay as they are">⤵ Merge steps ${_esc(a)}–${_esc(b)} into one page${range.length > sel.length ? ` <span style="font-weight:400;color:#94a3b8;">(${range.length} steps — everything in between comes along)</span>` : ''}</button>`
      : `<div style="font-size:11.5px;color:#94a3b8;">Steps ${_esc(a)}–${_esc(b)} are already on one page.</div>`;
  } else if (sel.length === 1) {
    const p = c.pageOfUnit.get(sel[0]);
    const k = p.stepIds.indexOf(sel[0]);
    if (p.stepIds.length > 1 && k > 0) html = `<button class="dw-btn" data-act="split-here" data-step="${_esc(sel[0])}">✂ Start a new page at step ${_esc(c.nums.get(sel[0])?.label || '')}</button>`;
  }
  bar.innerHTML = html || `<div style="font-size:11.5px;color:#94a3b8;line-height:1.45;">Select two or more steps (Shift- or Ctrl-click) to merge them into one page.</div>`;
}

// ─── CENTRE: the page ───────────────────────────────────────────────────────

function _renderPage(c) {
  // never rebuild the page under a caret: the edit commits on blur and re-renders then
  const focused = _shadow.activeElement;
  if (focused?.classList?.contains('tx')) { _deferred = true; return; }
  const model = D.renderModel();
  const mp = model.pages.find(p => p.id === _pageId);
  if (!mp) { _shadow.innerHTML = `<style>${EDIT_CSS}</style><div style="font:13px Arial;color:#e2e8f0;padding:30px;">This page has no steps left. Delete it from the list on the right.</div>`; _fit(); return; }
  const need = stillsNeeded({ pages: [mp] });
  const have = D.cachedStills(need);
  _shadow.innerHTML = `<style>${DOCUMENT_CSS}${watermarkCss(model.watermark)}${EDIT_CSS}</style><div class="fit">${renderPageHtml(mp, { stills: have, logo: D.documentLogo(), watermark: model.watermark })}</div>`;
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
      const mp = D.renderModel().pages.find(p => p.id === forPage);
      const need = mp ? stillsNeeded({ pages: [mp] }) : [];
      if (!need.length || D.cachedStills(need).size === need.length) continue;
      let stills = null;
      try { stills = await D.ensureStills(need, {}); }
      catch (e) { console.error('[document] pictures failed:', e); }
      if (!_isOpen()) break;
      if (forPage !== _pageId) { _walkAgain = true; continue; }
      const now = D.renderModel().pages.find(p => p.id === _pageId);
      for (const slot of _shadow.querySelectorAll('.slot')) {
        const sid = now?.images?.[Number(slot.dataset.slot)]?.stepId;
        const url = sid ? stills?.get(sid) : null;
        if (url) slot.innerHTML = `<img src="${_esc(url)}" alt="">`;
        else if (sid) { const ph = slot.querySelector('.ph'); if (ph) ph.textContent = 'the picture could not be rendered'; }
      }
    } while (_walkAgain);
  } finally { _walking = false; }
}

function _fit() {
  const centre = _root.querySelector('#dw-center'), host = _root.querySelector('#dw-pagehost');
  const fit = _shadow.querySelector('.fit');
  if (!fit) return;
  const pad = 28;
  const s = _zoom === '100' ? 1 : Math.max(0.2, Math.min((centre.clientWidth - pad * 2) / PAGE_W, (centre.clientHeight - pad * 2) / PAGE_H));
  fit.style.transform = `scale(${s})`;
  const w = PAGE_W * s, h = PAGE_H * s;
  host.style.width = `${w}px`; host.style.height = `${h + pad}px`;
  host.style.left = `${Math.max(pad, (centre.clientWidth - w) / 2)}px`;
  host.style.top = `${_zoom === '100' ? pad : Math.max(pad, (centre.clientHeight - h) / 2)}px`;
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
  if (f?.classList?.contains('tx')) f.blur();
}

function _onPageClick(e) {
  const slot = e.target.closest?.('.slot');
  if (slot) return _slotMenu(Number(slot.dataset.slot), e.clientX, e.clientY);
  if (e.target.closest?.('.hdr, .ftr')) {
    const inp = _root.querySelector('#dw-left input[data-field="title"]');
    if (inp) { inp.focus(); inp.select(); }
  }
}

function _slotMenu(slot, x, y) {
  _closeMenu();
  const c = _ctx();
  const page = c.doc.pages.find(p => p.id === _pageId); if (!page) return;
  const members = (page.stepIds || []).flatMap(id => c.units.find(u => u.id === id)?.members || []);
  _menu = document.createElement('div');
  _menu.className = 'dw-menu';
  _menu.innerHTML = `<div data-pick="">${slot === 0 ? 'Automatic — the page\'s last step' : '— leave this picture empty —'}</div>`
    + members.map(sid => `<div data-pick="${_esc(sid)}"><b>${_esc(c.nums.get(sid)?.label || '')}</b> ${_esc(c.stepById.get(sid)?.name || sid)}</div>`).join('');
  _menu.style.left = `${Math.min(x, window.innerWidth - 250)}px`;
  _menu.style.top = `${Math.min(y, window.innerHeight - 40 - 30 * (members.length + 1))}px`;
  _menu.addEventListener('click', (ev) => {
    const d = ev.target.closest('[data-pick]'); if (!d) return;
    ev.stopPropagation();
    const pid = _pageId; _closeMenu();
    D.setPagePicture(pid, slot, d.dataset.pick || null);
  });
  _root.appendChild(_menu);
}
function _closeMenu() { _menu?.remove(); _menu = null; }

// ─── events ─────────────────────────────────────────────────────────────────

function _showPage(pageId) {
  if (!pageId || pageId === _pageId) return false;
  _commitFocusedText();
  _pageId = pageId;
  return true;
}

async function _onClick(e) {
  const stepEl = e.target.closest?.('.dw-step');
  if (stepEl) {
    const c = _ctx(), id = stepEl.dataset.unit, order = c.units.map(u => u.id);
    if (e.shiftKey && _anchor && order.includes(_anchor)) {
      const a = order.indexOf(_anchor), b = order.indexOf(id);
      _sel = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (e.ctrlKey || e.metaKey) { if (_sel.has(id)) _sel.delete(id); else _sel.add(id); _anchor = id; }
    else { _sel = new Set([id]); _anchor = id; }
    const changed = _showPage(c.pageOfUnit.get(id)?.id);
    if (changed) _renderAll(); else { _renderList(_ctx()); _holdFocus(); }
    return;
  }
  const head = e.target.closest?.('[data-goto-page]');
  if (head && !e.target.closest('[data-act]')) { if (_showPage(head.dataset.gotoPage)) _renderAll(); return; }

  const el = e.target.closest?.('[data-act]');
  if (!el) return;
  e.preventDefault();
  const act = el.dataset.act;
  if (act === 'close') return closeDocumentWorkspace();
  if (act === 'build') { const d = D.buildPages(); _pageId = d?.pages?.[0]?.id || null; return; }
  if (act === 'zoom-fit' || act === 'zoom-100') { _zoom = act === 'zoom-fit' ? 'fit' : '100'; _renderTop(_ctx()); _fit(); _holdFocus(); return; }
  if (act === 'wm-toggle') { _wmOpen = !_wmOpen; _renderLeft(_ctx()); _holdFocus(); return; }
  if (act === 'wm-choose') { _root.querySelector('input[data-wm-file]')?.click(); return; }
  if (act === 'rerender-pictures') { D.clearStills(); _renderPage(_ctx()); return; }
  _commitFocusedText();
  if (act === 'sync') return void D.syncWithAnimation();
  if (act === 'reviewed') return D.markPageReviewed(_pageId);
  if (act === 'reviewed-all') return D.markPageReviewed(null);
  if (act === 'delete-page') return D.deletePage(el.dataset.page);
  if (act === 'reset-text') return D.setDocText(el.dataset.step, null);
  if (act === 'accept-drift') return D.acceptDrift(el.dataset.step);
  if (act === 'split-all') return D.splitPageAll(_pageId);
  if (act === 'split-here') {
    const c = _ctx(), p = c.pageOfUnit.get(el.dataset.step);
    if (!p) return;
    D.splitPageBefore(p.id, el.dataset.step);
    const np = _ctx().pageOfUnit.get(el.dataset.step);
    if (np && _showPage(np.id)) _renderAll();
    return;
  }
  if (act === 'merge-sel') {
    const pid = D.mergeSteps([..._sel]);
    if (pid && _showPage(pid)) _renderAll();
    return;
  }
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
  if (t.dataset?.pageOpt === 'template') return D.setPageTemplate(_pageId, t.value);
  if (t.dataset?.pageOpt === 'picture') return D.setPagePicture(_pageId, Number(t.dataset.slot), t.value || null);
}

function _onKey(e, editable) {
  if (e.key === 'Escape') {
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
  if (e.key === 'PageDown' || e.key === 'PageUp') {
    const i = c.doc.pages.findIndex(p => p.id === _pageId);
    const live = c.doc.pages.filter(p => p.stepIds.length);
    const k = live.findIndex(p => p.id === _pageId);
    const np = live[Math.max(0, Math.min(live.length - 1, (k < 0 ? i : k) + (e.key === 'PageDown' ? 1 : -1)))];
    return move(np?.stepIds[0]);
  }
}
