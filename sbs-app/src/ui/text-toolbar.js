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
import { ACTIONS } from '../systems/text-engine.js';

const FONTS = [
  'Arial', 'Helvetica', 'Georgia', 'Times New Roman',
  'Courier New', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Impact', 'Comic Sans MS',
];
const SIZES = [10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 64, 96, 128];

let _toolbar = null;   // host element (provided by overlay-toolbar.js)
let _editor  = null;   // contenteditable in single-editor mode (null in multi-mode)
let _applier = null;   // function(action, value) — caller-supplied dispatcher

// References to the live dropdown / colour controls so callers can sync
// them with the current selection's actual styling.
let _sizeSel = null;
let _fontSel = null;
let _colorInput = null;
let _fillInput  = null;
let _alphaInput = null;

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

  _sizeSel    = _select('size', SIZES.map(s => `${s}`), (v) => _apply('fontSize',   Number(v)));
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
  _toolbar.append(
    _btn('B', 'Bold (Ctrl+B)',      () => _apply('bold'),      { fontWeight: 'bold' }),
    _btn('I', 'Italic (Ctrl+I)',    () => _apply('italic'),    { fontStyle:  'italic' }),
    _btn('U', 'Underline (Ctrl+U)', () => _apply('underline'), { textDecoration: 'underline' }),
    _sep(),
    fillCtl, alphaCtl,
    colorCtl,
    _sizeSel,
    _fontSel,
  );

  _toolbar.style.display = 'flex';
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
  if (_sizeSel  && fontSize != null) _sizeSel.value = String(fontSize);
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
  if (_toolbar) {
    _toolbar.innerHTML = '';
    _toolbar.style.display = 'none';
    delete _toolbar.dataset.sbsTextToolbar;
    _toolbar = null;
  }
  _editor     = null;
  _applier    = null;
  _sizeSel    = null;
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
  sel.addEventListener('mousedown', e => e.stopPropagation()); // keep selection alive while menu opens
  sel.addEventListener('change',    () => onChange(sel.value));
  return sel;
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
