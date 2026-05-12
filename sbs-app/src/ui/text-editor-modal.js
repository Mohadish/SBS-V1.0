/**
 * SBS — Rich-text editor modal for overlay text boxes.
 *
 * Opens a contenteditable with a format toolbar. User styles any selection
 * (bold / italic / underline / font / size / color / alignment). Returns the
 * edited HTML on save, or null on cancel. Uses document.execCommand — it's
 * deprecated in the spec but every current Electron / Chromium build still
 * implements it reliably, and it gives us per-selection styling with zero
 * external dependencies.
 */

const FONTS = ['Arial','Helvetica','Georgia','Times New Roman','Courier New','Verdana','Tahoma'];
const SIZES = [10,12,14,16,20,24,28,32,40,48,64,96];
const DEFAULT_HTML = '<div>Text</div>';

/**
 * @param {string} [html]  initial HTML (defaults to a single "Text" line)
 * @returns {Promise<string|null>} edited HTML, or null if cancelled
 */
export function openTextEditor(html = DEFAULT_HTML) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed','inset:0','z-index:10000',
      'background:rgba(0,0,0,0.6)',
      'display:flex','align-items:center','justify-content:center',
    ].join(';');

    const dlg = document.createElement('div');
    dlg.style.cssText = [
      'background:var(--panel)','border:1px solid var(--line)','border-radius:10px',
      'width:min(720px,90vw)','max-height:80vh',
      'display:flex','flex-direction:column','gap:8px','padding:12px',
      'color:var(--text)','font-size:13px',
    ].join(';');

    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;';

    const ed = document.createElement('div');
    ed.contentEditable = 'true';
    ed.style.cssText = [
      'flex:1','min-height:180px','max-height:60vh','overflow:auto',
      'padding:12px','border:1px solid var(--line)','border-radius:8px',
      'background:var(--panel2)','outline:none',
      'font-family:Arial','font-size:16px','color:var(--text)',
      'white-space:pre-wrap',
    ].join(';');
    ed.innerHTML = html;

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px;';
    const btnCancel = _btn('Cancel');
    const btnSave   = _btn('Save', 'primary');
    footer.append(btnCancel, btnSave);

    // Toolbar buttons — each operates on the current selection.
    const mkExec = (label, title, cmd, arg) => {
      const b = _btn(label);
      b.title = title;
      b.addEventListener('mousedown', e => e.preventDefault());   // keep selection
      b.addEventListener('click', () => {
        ed.focus();
        document.execCommand(cmd, false, arg);
      });
      return b;
    };

    toolbar.append(
      mkExec('B',   'Bold (Ctrl+B)',       'bold'),
      mkExec('I',   'Italic (Ctrl+I)',     'italic'),
      mkExec('U',   'Underline (Ctrl+U)',  'underline'),
      mkExec('S̶', 'Strikethrough',       'strikeThrough'),
      _sep(),
      _fontFamilySelect(ed),
      _fontSizeSelect(ed),
      _colorInput(ed),
      _sep(),
      mkExec('L',   'Align left',          'justifyLeft'),
      mkExec('C',   'Align center',        'justifyCenter'),
      mkExec('R',   'Align right',         'justifyRight'),
      _sep(),
      mkExec('×', 'Clear formatting',      'removeFormat'),
    );

    const close = (v) => { overlay.remove(); resolve(v); };
    btnCancel.addEventListener('click', () => close(null));
    btnSave  .addEventListener('click', () => close(ed.innerHTML));
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Escape') close(null);
    });

    dlg.append(toolbar, ed, footer);
    overlay.appendChild(dlg);
    document.body.appendChild(overlay);

    // Focus and select all so the user can start typing immediately.
    setTimeout(() => {
      ed.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(ed);
      sel.removeAllRanges();
      sel.addRange(range);
    }, 0);
  });
}

// ── Controls ───────────────────────────────────────────────────────────────

function _fontFamilySelect(ed) {
  const sel = document.createElement('select');
  sel.title = 'Font family';
  sel.style.cssText = 'height:24px;';
  for (const f of FONTS) {
    const o = document.createElement('option'); o.value = f; o.textContent = f;
    sel.appendChild(o);
  }
  sel.addEventListener('mousedown', e => e.stopPropagation());
  sel.addEventListener('change', () => {
    ed.focus();
    document.execCommand('fontName', false, sel.value);
  });
  return sel;
}

function _fontSizeSelect(ed) {
  // execCommand('fontSize', ...) only accepts 1..7 (legacy). Use a CSS-class
  // approach: wrap selection in a <span style="font-size:Npx">.
  const sel = document.createElement('select');
  sel.title = 'Font size (px)';
  sel.style.cssText = 'height:24px;';
  for (const s of SIZES) {
    const o = document.createElement('option'); o.value = s; o.textContent = s;
    if (s === 16) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('mousedown', e => e.stopPropagation());
  sel.addEventListener('change', () => {
    ed.focus();
    _wrapSelectionStyle(`font-size:${sel.value}px`);
  });
  return sel;
}

function _colorInput(ed) {
  const c = document.createElement('input');
  c.type = 'color';
  c.title = 'Text color';
  c.value = '#ffffff';
  c.style.cssText = 'width:28px;height:24px;padding:0;background:transparent;border:none;cursor:pointer;';
  c.addEventListener('mousedown', e => e.stopPropagation());
  c.addEventListener('input', () => {
    ed.focus();
    document.execCommand('foreColor', false, c.value);
  });
  return c;
}

/**
 * Wrap the current selection in a <span style="..."> — used for font-size
 * since execCommand only supports legacy 1..7 sizes.
 */
function _wrapSelectionStyle(css) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const span  = document.createElement('span');
  span.style.cssText = css;
  try {
    span.appendChild(range.extractContents());
    range.insertNode(span);
    // Re-select the wrapped content so chaining styles works.
    const newRange = document.createRange();
    newRange.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(newRange);
  } catch (e) {
    console.warn('[text-editor] wrap failed', e);
  }
}

// ── Utils ──────────────────────────────────────────────────────────────────

function _btn(label, variant) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = [
    'height:24px','padding:0 10px','font-size:13px',
    'border:1px solid #334155','border-radius:6px',
    'background:' + (variant === 'primary' ? '#2563eb' : '#1f2937'),
    'color:#e5e7eb','cursor:pointer',
  ].join(';');
  return b;
}

function _sep() {
  const s = document.createElement('span');
  s.style.cssText = 'width:1px;height:18px;background:#334155;margin:0 4px;';
  return s;
}
