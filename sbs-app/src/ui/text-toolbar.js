/**
 * SBS — Text-edit floating toolbar.
 * ─────────────────────────────────
 * Mounted by overlay.js when the in-place text editor opens; dismounted
 * on exit. Operates on the live Selection inside the contenteditable via
 * document.execCommand (deprecated in spec, but every Chromium build
 * still implements it reliably and it gives us per-character styling
 * with zero deps).
 *
 * Critical detail: every interactive control here calls
 * `evt.preventDefault()` on mousedown so clicking the toolbar doesn't
 * blur the contenteditable and lose the selection. Without that, every
 * style click would just be "no selection, no-op".
 *
 * Toolbar controls:
 *   B / I / U / S  ─ bold / italic / underline / strike
 *   Font dropdown  ─ browser-built-in family list
 *   Size dropdown  ─ pixel sizes
 *   Color picker   ─ text color
 *   Align L/C/R    ─ paragraph alignment
 *
 * Apply scope:
 *   • If the user has a non-empty range selection → those characters only.
 *   • If selection is collapsed (just a caret) → execCommand applies to
 *     the next typed characters (browser-default behaviour).
 *   • Multi-textbox selection (Phase 5) is handled at the overlay layer,
 *     not here.
 */

const FONTS = [
  'Arial', 'Helvetica', 'Georgia', 'Times New Roman',
  'Courier New', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Impact', 'Comic Sans MS',
];
const SIZES = [10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 64, 96, 128];

let _toolbar = null;   // host element (provided by overlay-toolbar.js)
let _editor  = null;   // the contenteditable <div> we're attached to

/**
 * Build the text controls inside the supplied host element. Replaces any
 * existing children. The host is provided by overlay-toolbar so the
 * controls live on the same row as Add Text / Add Image / Delete /
 * Done — no separate floating bar.
 */
export function mountTextToolbar(host, editorEl) {
  if (_toolbar) unmountTextToolbar();
  _toolbar = host;
  _editor  = editorEl;
  _toolbar.innerHTML = '';
  _toolbar.dataset.sbsTextToolbar = '1';

  _toolbar.append(
    _btn('B', 'Bold (Ctrl+B)',     () => _exec('bold'),          { fontWeight: 'bold' }),
    _btn('I', 'Italic (Ctrl+I)',   () => _exec('italic'),        { fontStyle:  'italic' }),
    _btn('U', 'Underline (Ctrl+U)',() => _exec('underline'),     { textDecoration: 'underline' }),
    _btn('S', 'Strikethrough',     () => _exec('strikeThrough'), { textDecoration: 'line-through' }),
    _sep(),
    _select('font', FONTS,                  (v) => _exec('fontName', v)),
    _select('size', SIZES.map(s => `${s}`), (v) => _execFontSize(Number(v))),
    _color('Text color',                    (v) => _exec('foreColor', v)),
    _sep(),
    _btn('⫷', 'Align left',   () => _exec('justifyLeft')),
    _btn('⫿', 'Align center', () => _exec('justifyCenter')),
    _btn('⫸', 'Align right',  () => _exec('justifyRight')),
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
  _editor = null;
}

/**
 * execCommand wrapper that preserves the editor's focus + selection.
 * Without re-focusing first, execCommand sometimes no-ops because the
 * editor already lost focus during the toolbar mousedown.
 */
function _exec(cmd, arg) {
  if (!_editor) return;
  _editor.focus();
  try { document.execCommand(cmd, false, arg); }
  catch (err) { console.warn(`[text-toolbar] execCommand ${cmd} failed:`, err); }
}

/**
 * Pixel-size font sizing — execCommand('fontSize', 1..7) is the legacy
 * 7-step API and produces ugly rounding. We work around by wrapping the
 * selection in a span with explicit font-size CSS.
 */
function _execFontSize(px) {
  if (!_editor) return;
  _editor.focus();
  // execCommand('fontSize', 7) marks the selection with <font size="7"> —
  // we then walk those marker fonts and replace with span style.
  // Modern reliable path: insertHTML wrapping the selected text in a span.
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return;   // no selection, can't apply size to nothing
  const span = document.createElement('span');
  span.style.fontSize = `${px}px`;
  try {
    span.appendChild(range.extractContents());
    range.insertNode(span);
    // Restore selection over the new span content.
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
  // Pick a reasonable default selection so the dropdown shows something useful.
  if (kind === 'font') sel.value = 'Arial';
  if (kind === 'size') sel.value = '16';
  sel.addEventListener('mousedown', e => e.stopPropagation()); // keep selection alive while menu opens
  sel.addEventListener('change',    () => onChange(sel.value));
  return sel;
}

function _color(title, onChange) {
  // Native color picker. 'change' fires when user closes the picker.
  // Wrap in a button-styled <label> so it matches the toolbar visually.
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
