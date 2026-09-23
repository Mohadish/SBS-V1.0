/**
 * SBS — Text-edit floating toolbar.
 * ─────────────────────────────────
 * Mounted by overlay.js into the overlay-edit toolbar's left slot, both
 * when the in-place text editor opens AND when ≥1 text box is multi-
 * selected without an editor open. The toolbar itself is dumb: it
 * builds the controls and dispatches every action via a caller-supplied
 * applier(action, value) function. overlay.js decides what that means:
 *
 *   • single-editor mode  → execCommand on the live Selection inside
 *                           the contenteditable (per-character styles).
 *   • multi-textbox mode  → walks each selected text box's HTML and
 *                           changes only the touched property; other
 *                           inline styles are preserved.
 *
 * Critical detail: every interactive control here calls
 * `evt.preventDefault()` on mousedown so clicking the toolbar doesn't
 * blur the contenteditable and lose the selection. Without that, every
 * style click would just be "no selection, no-op".
 *
 * Apply scope (single-editor mode):
 *   • Non-empty range selection → those characters only.
 *   • Caret only                → next typed characters (browser default).
 */

import * as textEngine from '../systems/text-engine.js';
import { openTextEffectsPopover, closeTextEffectsPopover } from './text-effects-popover.js';
import { ACTIONS } from '../systems/text-engine.js';

const FONTS = [
  'Arial', 'Helvetica', 'Georgia', 'Times New Roman',
  'Courier New', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Impact', 'Comic Sans MS',
];
const SIZES = [10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 64, 96, 128];
const SIZE_MIN = 4, SIZE_MAX = 1000;

let _toolbar = null;   // host element (provided by overlay-toolbar.js)
let _editor  = null;   // contenteditable in single-editor mode (null in multi-mode)
let _applier = null;   // function(action, value) — caller-supplied dispatcher

// References to the live dropdown / colour controls so callers can sync
// them with the current selection's actual styling.
let _sizeSel = null;      // the size box (wrapper: input + ▾)
let _sizeInput = null;    // ✎ V0.3.4.100 — the typed size lives here
let _fontSel = null;
let _colorInput = null;
let _fillInput  = null;
let _alphaInput = null;
let _styleSel   = null;       // style-template dropdown (canvas mode only)
let _styleSeparators = [];    // visual separators between locked + always-on controls

/**
 * Build the text controls inside the supplied host element. Replaces any
 * existing children. The host is provided by overlay-toolbar so the
 * controls live on the same row as Add Text / Add Image / Delete.
 *
 * @param {HTMLElement}                       host
 * @param {(action:string, value?:any)=>void} applier  — see file header
 * @param {HTMLElement|null}                  editorEl — contenteditable
 *   in single-editor mode (null in multi-mode); used only to refocus
 *   before each apply so execCommand sees the editable as active.
 */
export function mountTextToolbar(host, applier, editorEl = null, opts = {}) {
  if (_toolbar) unmountTextToolbar();
  _toolbar = host;
  _editor  = editorEl;
  _applier = applier || (() => {});
  _toolbar.innerHTML = '';
  _toolbar.dataset.sbsTextToolbar = '1';
  // Style-tab mode hides alignment buttons (per spec, alignment is the
  // ONLY thing styled boxes can vary at the box level; templates
  // themselves don't carry alignment).
  const showAlignment = opts.showAlignment !== false;

  // Visual layout (left to right):
  //   ⫷ ⫿ ⫸  |  B I U  |  fill α  text-color  size ▼  font ▼
  // Action names match the text-engine's ACTIONS list — no more
  // execCommand-flavoured strings. Strikethrough was removed: edge
  // cases weren't worth the value.
  const colorCtl = _color('Text color', 'A', '#fbbf24',
                          (v) => _apply('color', v));
  const fillCtl  = _color('Fill color (textbox background)', '■', '#1f2937',
                          (v) => _apply('fillColor', _composeRgba(v, _alphaInput?.value)));
  const alphaCtl = _alpha('Fill alpha (0 = transparent, 100 = opaque)',
                          (v) => _apply('fillColor', _composeRgba(_fillInput?.value, v)));

  // ✎ V0.3.4.100 — ONE box for the size: click it and the presets drop down,
  // type into it and that IS the size (Enter applies; ↑/↓ nudge). No
  // "Custom…" detour any more (the user's request).
  _sizeSel    = _sizeBox();
  _fontSel    = _select('font', FONTS,                  (v) => _apply('fontFamily', v));
  _colorInput = colorCtl.querySelector('input[type=color]');
  _fillInput  = fillCtl.querySelector('input[type=color]');
  _alphaInput = alphaCtl.querySelector('input[type=range]');

  if (showAlignment) {
    _toolbar.append(
      _btn('⫷', 'Align left',   () => _apply('alignLeft')),
      _btn('⫿', 'Align center', () => _apply('alignCenter')),
      _btn('⫸', 'Align right',  () => _apply('alignRight')),
      _sep(),
    );
  }
  // Style-locked group — these controls are hidden when a styleId is
  // active so the user only has alignment to vary.
  const lockedGroup = [
    _btn('B', 'Bold (Ctrl+B)',      () => _apply('bold'),      { fontWeight: 'bold' }),
    _btn('I', 'Italic (Ctrl+I)',    () => _apply('italic'),    { fontStyle:  'italic' }),
    _btn('U', 'Underline (Ctrl+U)', () => _apply('underline'), { textDecoration: 'underline' }),
    _sep(),
    fillCtl, alphaCtl,
    colorCtl,
    _sizeSel,
    _fontSel,
  ];
  _toolbar.append(...lockedGroup);
  // Tag the group so setStyleLocked() can flip its visibility en masse.
  for (const el of lockedGroup) el.dataset.sbsStyleLockable = '1';

  _toolbar.style.display = 'flex';
}

/**
 * Replace the toolbar's style-template dropdown contents. Called by
 * overlay.js whenever the templates list changes, the active selection
 * changes, or the bound style of the active selection changes.
 *
 *   templates: [{ id, name }]
 *   currentId: the styleId of the active selection (null/empty = none)
 *   onChange:  (styleId|null) => void
 *
 * Pass templates: null to remove the dropdown entirely (e.g. style-tab
 * mode where the dropdown is meaningless).
 */
export function setStyleDropdown(templates, currentId, onChange) {
  if (!_toolbar) return;
  if (_styleSel) _styleSel.remove();
  _styleSel = null;
  if (!Array.isArray(templates)) return;

  const sel = document.createElement('select');
  sel.title = 'Bind this text box to a style template';
  sel.style.cssText = [
    'background:#1f2937','color:#e5e7eb',
    'border:1px solid #334155','border-radius:6px',
    'height:28px','padding:0 6px','font-size:13px','cursor:pointer',
    'min-width:120px','order:-1',   // keep style picker leftmost in flex order
  ].join(';');
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '(no style)';
  sel.appendChild(noneOpt);
  for (const t of templates) {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.name || 'Untitled';
    sel.appendChild(o);
  }
  sel.value = currentId || '';
  sel.addEventListener('mousedown', e => e.stopPropagation());
  sel.addEventListener('change', () => onChange(sel.value || null));
  _toolbar.prepend(sel);
  _styleSel = sel;
}

let _constSel  = null;   // 📌 constant-text-box dropdown (canvas selection mode)
let _constEdit = null;   // ✏️ rename button beside it
let _constDel  = null;   // 🗑 delete button (only empty constants may die)

/**
 * 📌 Constant-text-box picker (V0.3.2.100) — mirrors the style dropdown.
 * Pass defs (array) + the selected box's current constId to show; pass
 * null to hide. onChange(defId|null) attaches/detaches the selected box;
 * onRename(defId) is fired by the ✏️ pencil for the currently chosen
 * definition (the caller owns the prompt + persistence).
 */
export function setConstDropdown(defs, currentId, onChange, onRename, onDelete) {
  if (!_toolbar) return;
  if (_constSel)  { _constSel.remove();  _constSel  = null; }
  if (_constEdit) { _constEdit.remove(); _constEdit = null; }
  if (_constDel)  { _constDel.remove();  _constDel  = null; }
  if (!Array.isArray(defs)) return;

  const sel = document.createElement('select');
  sel.title = 'Attach this text box to a constant (pinned position + unified style)';
  sel.style.cssText = [
    'background:#1f2937', 'color:#e5e7eb',
    'border:1px solid #334155', 'border-radius:6px',
    'height:28px', 'padding:0 6px', 'font-size:13px', 'cursor:pointer',
    'min-width:110px', 'order:-1',
  ].join(';');
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '(not constant)';
  sel.appendChild(noneOpt);
  for (const d of defs) {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = `📌 ${d.name || 'Unnamed'}`;
    sel.appendChild(o);
  }
  sel.value = currentId || '';
  sel.addEventListener('mousedown', e => e.stopPropagation());
  sel.addEventListener('change', () => { onChange(sel.value || null); _syncConstEdit(); });

  const edit = document.createElement('button');
  edit.textContent = '✏️';
  edit.title = 'Rename this constant';
  edit.style.cssText = [
    'background:#1f2937', 'color:#e5e7eb', 'border:1px solid #334155',
    'border-radius:6px', 'height:28px', 'width:30px', 'font-size:13px',
    'cursor:pointer', 'order:-1',
  ].join(';');
  edit.addEventListener('mousedown', e => e.stopPropagation());
  edit.addEventListener('click', () => { if (sel.value) onRename?.(sel.value); });

  // 🗑 delete-the-constant (V0.3.2.102). Only an EMPTY constant may die —
  // the handler refuses in-use defs with a status explaining where they
  // live (the attached box you're editing counts as usage, so from here
  // this mostly fires the explanation; the Constant Titles panel is the
  // proper cleanup home, with counts and disabled bins).
  const del = document.createElement('button');
  del.textContent = '🗑';
  del.title = 'Delete this constant (only when no step uses it)';
  del.style.cssText = edit.style.cssText;
  del.addEventListener('mousedown', e => e.stopPropagation());
  del.addEventListener('click', () => { if (sel.value) onDelete?.(sel.value); });

  const _syncConstEdit = () => {
    edit.style.display = sel.value ? '' : 'none';
    del.style.display  = sel.value ? '' : 'none';
  };
  _syncConstEdit();

  _toolbar.prepend(del);
  _toolbar.prepend(edit);
  _toolbar.prepend(sel);
  _constSel  = sel;
  _constEdit = edit;
  _constDel  = del;
}

/**
 * When a style is bound, hide the locked group so only Align L/C/R and
 * the style dropdown remain. Call after every selection change /
 * styleId update.
 */
let _fxBtn = null;

/**
 * "Fx" button — drop shadow + outline for the whole box (V0.3.2.144).
 *
 * Deliberately OUTSIDE the style-lockable group: these effects are a
 * property of the box, not of the style template, so they stay reachable
 * on a style-bound box — the same reasoning that keeps corner radius live
 * on a style-bound shape.
 *
 * Pass getValues: null to remove the button.
 */
export function setTextEffects(getValues, onChange, onSessionEnd) {
  if (!_toolbar) return;
  if (_fxBtn) { _fxBtn.remove(); _fxBtn = null; }
  closeTextEffectsPopover();
  if (typeof getValues !== 'function') return;

  const b = _btn('Fx', 'Drop shadow and outline (applies to the whole box)');
  b.addEventListener('mousedown', e => e.stopPropagation());
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    openTextEffectsPopover(b, getValues, onChange, onSessionEnd);
  });
  // Tagged lockable: a style-bound box takes its effects FROM the style,
  // so the per-box Fx button hides alongside the other style-owned
  // controls (V0.3.2.145). Alignment remains the only thing left live.
  b.dataset.sbsStyleLockable = '1';
  _toolbar.appendChild(b);
  _fxBtn = b;
}

export function setStyleLocked(locked) {
  if (!_toolbar) return;
  // Binding a style while the Fx popover is open would leave it editing
  // per-box effects that no longer apply to anything.
  if (locked) closeTextEffectsPopover();
  _toolbar.querySelectorAll('[data-sbs-style-lockable]').forEach(el => {
    el.style.display = locked ? 'none' : '';
  });
}

/**
 * Sync the dropdown / colour controls to the current selection's actual
 * styling. Caller computes the values and passes them in — overlay.js
 * does the lifting so the toolbar stays presentation-only.
 *
 *   { fontSize?:number, fontName?:string, color?:string,
 *     fillColor?:string,           // hex like "#1f2937"
 *     fillAlpha?:number }          // 0..100
 *
 * Pass ONLY the keys you can determine. For mixed-value selections the
 * caller may pick a representative (per spec: largest size when sizes
 * differ across multi-select).
 */
export function setToolbarValues({ fontSize, fontName, color, fillColor, fillAlpha } = {}) {
  if (_sizeInput && fontSize != null && document.activeElement !== _sizeInput) _sizeInput.value = String(_sizeKey(fontSize));   // never overwrite what is being typed
  if (_fontSel  && fontName)         _fontSel.value = fontName;
  if (_colorInput && color) {
    _colorInput.value = color;
    const wrap = _colorInput.parentElement;
    if (wrap) wrap.style.color = color;
  }
  if (_fillInput && fillColor) {
    _fillInput.value = fillColor;
    const wrap = _fillInput.parentElement;
    if (wrap) wrap.style.color = fillColor;
  }
  if (_alphaInput && fillAlpha != null) {
    _alphaInput.value = String(Math.max(0, Math.min(100, fillAlpha)));
  }
}

export function unmountTextToolbar() {
  closeTextEffectsPopover();
  _fxBtn = null;
  if (_toolbar) {
    _toolbar.innerHTML = '';
    _toolbar.style.display = 'none';
    delete _toolbar.dataset.sbsTextToolbar;
    _toolbar = null;
  }
  _editor     = null;
  _applier    = null;
  _closeSizeList();
  _sizeSel    = null;
  _sizeInput  = null;
  _fontSel    = null;
  _colorInput = null;
  _fillInput  = null;
  _alphaInput = null;
}

/** Refocus the editable (if we have one) before forwarding to the applier. */
function _apply(action, value) {
  if (_editor) try { _editor.focus(); } catch {}
  if (_applier) _applier(action, value);
}

/**
 * Default applier for single-editor mode — drives the unified
 * text-engine over the contenteditable's live selection.
 *
 * Engine actions: color, fontFamily, fontSize, bold, italic, underline,
 * alignLeft, alignCenter, alignRight. fillColor is intercepted by
 * overlay.js before reaching this applier (it's a node-level attr,
 * not text styling).
 */
export function execCommandApplier(action, value) {
  if (!_editor) return;
  if (!ACTIONS.includes(action)) return;
  const sel = window.getSelection();
  const range = (sel && sel.rangeCount && _editor.contains(sel.anchorNode))
    ? sel.getRangeAt(0)
    : null;
  try {
    textEngine.apply(_editor, range, action, value);
  } catch (err) {
    console.warn(`[text-toolbar] engine apply ${action} failed:`, err);
  }
}

// (All single-editor styling logic lives in src/systems/text-engine.js.
// execCommandApplier above forwards every action to engine.apply()
// with the live Selection range. Mass-mode applier in overlay.js does
// the same with no range, operating on each box's stored HTML.)

// ─── Control factories ─────────────────────────────────────────────────────

function _btn(label, title, onClick, labelStyle) {
  const b = document.createElement('button');
  b.type      = 'button';
  b.title     = title;
  b.textContent = label;
  b.style.cssText = [
    'background:#1f2937','color:#e5e7eb',
    'border:1px solid #334155','border-radius:6px',
    'min-width:28px','height:28px','padding:0 6px',
    'cursor:pointer','font-size:13px','line-height:1',
  ].join(';');
  if (labelStyle) Object.assign(b.style, labelStyle);
  // CRITICAL: prevent default on mousedown so the editable doesn't lose
  // its selection when the toolbar is clicked.
  b.addEventListener('mousedown', e => e.preventDefault());
  b.addEventListener('click',     e => { e.preventDefault(); onClick(); });
  return b;
}

function _sep() {
  const s = document.createElement('div');
  s.style.cssText = 'width:1px;height:18px;background:#334155;margin:0 4px;';
  return s;
}

function _select(kind, options, onChange) {
  const sel = document.createElement('select');
  sel.title = kind === 'font' ? 'Font family' : 'Font size';
  sel.style.cssText = [
    'background:#1f2937','color:#e5e7eb',
    'border:1px solid #334155','border-radius:6px',
    'height:28px','padding:0 4px','font-size:13px','cursor:pointer',
    kind === 'font' ? 'min-width:120px' : 'min-width:64px',
  ].join(';');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
    sel.appendChild(opt);
  }
  if (kind === 'font') sel.value = 'Arial';
  if (kind === 'size') sel.value = '16';
  // V0.3.3.5 — re-picking the value already shown must still fire. A
  // <select> stays silent when you choose the option it displays, and the
  // box mirrors the caret's value — so on a mixed-size selection "40 → 40"
  // did nothing while "40 → 48" restyled everything. Blank the box while
  // the list is open (any pick is then a change); put the value back if
  // the list closes without one.
  sel.addEventListener('mousedown', e => {
    e.stopPropagation();                       // keep selection alive while menu opens
    sel.dataset.prev = sel.value;
    sel.selectedIndex = -1;
  });
  sel.addEventListener('blur', () => {
    if (sel.selectedIndex === -1 && sel.dataset.prev != null) sel.value = sel.dataset.prev;
  });
  sel.addEventListener('change', () => { if (sel.value !== '') onChange(sel.value); });
  return sel;
}

// ─── the text size box (V0.3.4.100; replaces V0.3.4.1's list + "Custom…") ──
// A number box with the presets hanging under it. Click → the presets drop
// down, pick one and it applies. Type → the list closes, what you typed is the
// size: Enter (or leaving the box) applies it, Esc puts the old value back.
// ↑ / ↓ nudge by 1, Shift for 10. The text's selection is kept across all of it.

const _sizeKey = (n) => { const v = Math.round(Number(n) * 10) / 10; return Number.isFinite(v) ? v : 16; };
let _sizeList = null;     // the open preset list (one at a time)

function _closeSizeList() {
  if (_sizeList) { _sizeList.remove(); _sizeList = null; }
}

function _sizeBox() {
  const wrap = document.createElement('div');
  wrap.title = `Text size in pixels of the export frame (${SIZE_MIN}–${SIZE_MAX}). Click for presets, or type a size and press Enter.`;
  wrap.style.cssText = [
    'background:#1f2937','color:#e5e7eb',
    'border:1px solid #334155','border-radius:6px',
    'height:28px','display:inline-flex','align-items:stretch','box-sizing:border-box','position:relative',
  ].join(';');
  const inp = document.createElement('input');
  inp.type = 'text'; inp.inputMode = 'decimal'; inp.value = '16';
  inp.setAttribute('aria-label', 'Text size');
  inp.style.cssText = 'background:transparent;color:inherit;border:0;outline:0;width:44px;padding:0 0 0 6px;font-size:13px;box-sizing:border-box;';
  const arrow = document.createElement('button');
  arrow.type = 'button'; arrow.textContent = '▾'; arrow.tabIndex = -1;
  arrow.title = 'Preset sizes';
  arrow.style.cssText = 'background:transparent;color:#94a3b8;border:0;padding:0 5px 0 2px;cursor:pointer;font-size:12px;line-height:1;';
  wrap.append(inp, arrow);
  _sizeInput = inp;

  // typing in the box takes the window selection away from the text being
  // edited — keep the range and put it back before the size is applied
  let saved = null, prev = inp.value;
  const keepRange = () => {
    const ws = window.getSelection();
    saved = (_editor && ws && ws.rangeCount && _editor.contains(ws.anchorNode)) ? ws.getRangeAt(0).cloneRange() : null;
  };
  const restoreRange = () => {
    if (!saved || !_editor) return;
    try { _editor.focus(); const w = window.getSelection(); w.removeAllRanges(); w.addRange(saved); } catch { /* the text changed under us — apply to the whole box instead */ }
  };
  const commit = (raw) => {
    const txt = String(raw ?? inp.value).replace(',', '.').trim();
    const n = _sizeKey(txt);
    const valid = txt !== '' && Number.isFinite(Number(txt)) && n >= SIZE_MIN && n <= SIZE_MAX;
    if (!valid) { inp.value = prev; return false; }
    inp.value = String(n); prev = inp.value;
    restoreRange();
    _apply('fontSize', n);
    return true;
  };
  const open = () => {
    _closeSizeList();
    const list = document.createElement('div');
    list.dataset.sbsTextToolbar = '1';   // clicks inside never close the in-place editor
    const r = wrap.getBoundingClientRect();
    list.style.cssText = `position:fixed;left:${Math.round(r.left)}px;top:${Math.round(r.bottom + 2)}px;z-index:10050;background:#0f172a;color:#e5e7eb;border:1px solid #334155;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.5);padding:4px 0;min-width:${Math.round(r.width)}px;max-height:260px;overflow:auto;font-size:13px;`;
    for (const s of SIZES) {
      const it = document.createElement('div');
      it.textContent = String(s);
      it.style.cssText = `padding:3px 12px;cursor:pointer;${String(s) === inp.value ? 'background:rgba(56,189,248,0.18);' : ''}`;
      it.addEventListener('mouseenter', () => { it.style.background = 'rgba(56,189,248,0.28)'; });
      it.addEventListener('mouseleave', () => { it.style.background = String(s) === inp.value ? 'rgba(56,189,248,0.18)' : ''; });
      it.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });   // the box keeps focus, the text keeps its selection
      it.addEventListener('click', (e) => { e.stopPropagation(); _closeSizeList(); inp.value = String(s); commit(String(s)); });
      list.appendChild(it);
    }
    document.body.appendChild(list);
    _sizeList = list;
  };
  wrap.addEventListener('mousedown', (e) => { e.stopPropagation(); if (document.activeElement !== inp) keepRange(); });
  arrow.addEventListener('mousedown', (e) => { e.preventDefault(); });
  arrow.addEventListener('click', (e) => { e.stopPropagation(); if (_sizeList) _closeSizeList(); else { keepRange(); open(); } });
  inp.addEventListener('focus', () => { prev = inp.value; open(); inp.select(); });
  inp.addEventListener('input', () => { _closeSizeList(); });               // typing = a custom value, the list is out of the way
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter')  { e.preventDefault(); _closeSizeList(); commit(); inp.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); _closeSizeList(); inp.value = prev; restoreRange(); inp.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      const n = Math.max(SIZE_MIN, Math.min(SIZE_MAX, _sizeKey(String(inp.value).replace(',', '.')) + step));
      inp.value = String(n); commit(String(n)); inp.focus();
    }
  });
  inp.addEventListener('blur', () => { setTimeout(_closeSizeList, 120); if (inp.value !== prev) commit(); });   // leaving the box with a new number applies it
  return wrap;
}

function _color(title, label = 'A', defaultBadge = '#fbbf24', onChange) {
  const wrap = document.createElement('label');
  wrap.title = title;
  wrap.style.cssText = [
    'background:#1f2937','color:#e5e7eb',
    'border:1px solid #334155','border-radius:6px',
    'height:28px','min-width:36px','padding:0 6px',
    'display:inline-flex','align-items:center','justify-content:center',
    'cursor:pointer','font-size:13px','position:relative',
  ].join(';');
  wrap.textContent = label;
  wrap.style.fontWeight = 'bold';
  wrap.style.color      = defaultBadge;

  const input = document.createElement('input');
  input.type  = 'color';
  input.value = defaultBadge;
  input.style.cssText = 'position:absolute;inset:0;opacity:0;cursor:pointer;';
  wrap.appendChild(input);

  // The native colour picker is an OS-level dialog. When the user closes
  // it (by picking, or by clicking outside), the closing click also fires
  // a mousedown on whatever's under the cursor — which the editor's
  // click-outside detector then interprets as "exit edit mode". Result:
  // the user picks a colour, then loses every other style edit they made
  // because the editor commits early.
  // Stamp a recent-pick timestamp on every color event; the editor's
  // click-outside guard reads _wasColorPickedRecently() and skips one
  // dismissal if so.
  const stamp = () => { _lastColorEventAt = performance.now(); };
  input.addEventListener('mousedown', (e) => { e.stopPropagation(); stamp(); });
  input.addEventListener('focus',     stamp);
  input.addEventListener('input',     () => { wrap.style.color = input.value; onChange(input.value); stamp(); });
  input.addEventListener('change',    () => { onChange(input.value); stamp(); });
  return wrap;
}

let _lastColorEventAt = 0;
const COLOR_DISMISS_GUARD_MS = 400;
/**
 * True iff a colour picker emitted any event within the last
 * COLOR_DISMISS_GUARD_MS milliseconds. Read by overlay.js's
 * click-outside detector to swallow exactly one dismissal that would
 * otherwise close the editor when the OS picker dialog closes.
 */
export function wasColorPickedRecently() {
  return (performance.now() - _lastColorEventAt) < COLOR_DISMISS_GUARD_MS;
}

/**
 * Alpha slider. 0..100 (percent of opacity). Calls onChange(percent)
 * on every input event so the rasteriser sees live feedback.
 */
function _alpha(title, onChange) {
  const wrap = document.createElement('label');
  wrap.title = title;
  wrap.style.cssText = [
    'background:#1f2937','color:#94a3b8',
    'border:1px solid #334155','border-radius:6px',
    'height:28px','padding:0 6px',
    'display:inline-flex','align-items:center','gap:4px',
    'cursor:ns-resize','font-size:11px',
  ].join(';');
  wrap.textContent = 'α';

  const input = document.createElement('input');
  input.type  = 'range';
  input.min   = '0';
  input.max   = '100';
  input.value = '100';
  input.style.cssText = 'width:60px;cursor:ew-resize;';
  wrap.appendChild(input);

  input.addEventListener('mousedown', e => e.stopPropagation());
  input.addEventListener('input', () => onChange(Number(input.value)));
  return wrap;
}

/**
 * Compose an rgba() string from a hex colour and alpha percent (0..100).
 * Returns null when either input is missing.
 */
function _composeRgba(hex, alphaPercent) {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, (Number(alphaPercent) || 0) / 100));
  return `rgba(${r},${g},${b},${a})`;
}
