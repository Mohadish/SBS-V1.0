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

const FONTS = [
  'Arial', 'Helvetica', 'Georgia', 'Times New Roman',
  'Courier New', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Impact', 'Comic Sans MS',
];
const SIZES = [10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 64, 96, 128];

let _toolbar = null;   // host element (provided by overlay-toolbar.js)
let _editor  = null;   // contenteditable in single-editor mode (null in multi-mode)
let _applier = null;   // function(action, value) — caller-supplied dispatcher

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
export function mountTextToolbar(host, applier, editorEl = null) {
  if (_toolbar) unmountTextToolbar();
  _toolbar = host;
  _editor  = editorEl;
  _applier = applier || (() => {});
  _toolbar.innerHTML = '';
  _toolbar.dataset.sbsTextToolbar = '1';

  // Visual layout (left to right) — matches the user's right-to-left
  // mental order so reading the bar from the Edit toggle inward gives:
  //   font ▼ · size ▼ · color · S · U · I · B · ⫸ · ⫿ · ⫷
  _toolbar.append(
    _btn('⫷', 'Align left',   () => _apply('justifyLeft')),
    _btn('⫿', 'Align center', () => _apply('justifyCenter')),
    _btn('⫸', 'Align right',  () => _apply('justifyRight')),
    _sep(),
    _btn('B', 'Bold (Ctrl+B)',     () => _apply('bold'),          { fontWeight: 'bold' }),
    _btn('I', 'Italic (Ctrl+I)',   () => _apply('italic'),        { fontStyle:  'italic' }),
    _btn('U', 'Underline (Ctrl+U)',() => _apply('underline'),     { textDecoration: 'underline' }),
    _btn('S', 'Strikethrough',     () => _apply('strikeThrough'), { textDecoration: 'line-through' }),
    _sep(),
    _color('Text color',                    (v) => _apply('foreColor', v)),
    _select('size', SIZES.map(s => `${s}`), (v) => _apply('fontSize', Number(v))),
    _select('font', FONTS,                  (v) => _apply('fontName', v)),
  );

  _toolbar.style.display = 'flex';
}

export function unmountTextToolbar() {
  if (_toolbar) {
    _toolbar.innerHTML = '';
    _toolbar.style.display = 'none';
    delete _toolbar.dataset.sbsTextToolbar;
    _toolbar = null;
  }
  _editor  = null;
  _applier = null;
}

/** Refocus the editable (if we have one) before forwarding to the applier. */
function _apply(action, value) {
  if (_editor) try { _editor.focus(); } catch {}
  if (_applier) _applier(action, value);
}

/**
 * Default applier for single-editor mode — uses execCommand against the
 * contenteditable's live Selection. Exported so overlay.js can pass it
 * in without reimplementing.
 */
export function execCommandApplier(action, value) {
  try {
    if (action === 'fontSize') {
      _execFontSizeOnSelection(Number(value));
    } else {
      document.execCommand(action, false, value);
    }
  } catch (err) { console.warn(`[text-toolbar] ${action} failed:`, err); }
}

/**
 * Pixel-size font sizing — execCommand('fontSize', 1..7) uses a legacy
 * 7-step API and looks awful at modern resolutions. Wrap the selection
 * in a span with explicit CSS instead.
 */
function _execFontSizeOnSelection(px) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return;   // no selection, can't apply size to nothing
  const span = document.createElement('span');
  span.style.fontSize = `${px}px`;
  try {
    span.appendChild(range.extractContents());
    range.insertNode(span);
    range.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (err) { console.warn('[text-toolbar] fontSize wrap failed:', err); }
}

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

function _color(title, onChange) {
  const wrap = document.createElement('label');
  wrap.title = title;
  wrap.style.cssText = [
    'background:#1f2937','color:#e5e7eb',
    'border:1px solid #334155','border-radius:6px',
    'height:28px','min-width:36px','padding:0 6px',
    'display:inline-flex','align-items:center','justify-content:center',
    'cursor:pointer','font-size:13px','position:relative',
  ].join(';');
  wrap.textContent = 'A';
  wrap.style.fontWeight = 'bold';
  wrap.style.color      = '#fbbf24';

  const input = document.createElement('input');
  input.type  = 'color';
  input.value = '#ffffff';
  input.style.cssText = 'position:absolute;inset:0;opacity:0;cursor:pointer;';
  wrap.appendChild(input);

  input.addEventListener('mousedown', e => e.stopPropagation());
  input.addEventListener('input',     () => { wrap.style.color = input.value; onChange(input.value); });
  input.addEventListener('change',    () => onChange(input.value));
  return wrap;
}
