/**
 * SBS — Floating toolbar for the per-step overlay editor.
 *
 * Lives at the top-right of the viewport. One button always visible ("✏ Edit")
 * that toggles the editing mode. When active, exposes:
 *   + T  add a text box
 *   + 🖼  add an image (opens file picker)
 *   🗑   delete selected
 *   Font controls when a text box is selected
 *   ✓    exit editing
 *
 * Implementation note: kept intentionally flat — single file, no templating.
 * Any styling lives inline so we don't pollute components.css for a WIP
 * feature. Migrate to a proper class later if the toolbar grows.
 */

import * as overlay from '../systems/overlay.js';
import * as interfaces from '../systems/interfaces.js';
import { setStatus } from './status.js';
import { state } from '../core/state.js';
import { chooseFromButtons } from './prompt.js';

let _bar = null;
let _mainBtn = null;
let _tools = null;
let _textSlot = null;   // populated by text-toolbar.js while editing

// Overlay-mode awareness (V0.3.0.23): viewport clicks while editing do nothing,
// which is easy to forget. Blink the toggle on each such click; after 3, offer to
// exit. Both reset whenever overlay editing is entered/exited.
let _misclickCount      = 0;
let _suppressExitPrompt = false;
let _blinkTimer         = null;

export function initOverlayToolbar() {
  const surface = document.getElementById('viewport-surface');
  if (!surface) return;

  _bar = document.createElement('div');
  _bar.id = 'overlay-toolbar';
  // Single row, no wrap. The Edit toggle is the right-anchored constant;
  // tools (and the text-edit slot) extend to the LEFT as the user drills
  // deeper — overlay-edit ON adds Add/Delete to the left of the toggle,
  // text-edit ON adds the style controls further left.
  _bar.style.cssText = [
    'position:absolute',
    'top:8px', 'right:8px',
    'z-index:30',
    'display:flex', 'gap:6px', 'align-items:center', 'flex-wrap:nowrap',
    'background:rgba(10,15,25,0.85)',
    'border:1px solid rgba(255,255,255,0.08)',
    'border-radius:8px',
    'padding:4px 6px',
    'font-size:12px',
    'user-select:none',
    'backdrop-filter:blur(4px)',
    'max-width:calc(100vw - 24px)',
    'overflow-x:auto',
  ].join(';');

  // Slot for the in-place text editor's controls (font / size / color /
  // strike / U / I / B / align L|C|R). Sits LEFTMOST when editing text.
  _textSlot = document.createElement('div');
  _textSlot.id = 'overlay-text-slot';
  _textSlot.style.cssText = 'display:none;gap:4px;align-items:center;flex-wrap:nowrap;';

  // Tools = Add Text / Add Image / Delete. Visible when overlay editing
  // is on. Sits between the text slot (left) and the Edit toggle (right).
  // Order in DOM = visual left-to-right: Add T, Add Img, Delete.
  _tools = document.createElement('div');
  _tools.style.cssText = 'display:none;gap:4px;align-items:center;flex-wrap:nowrap;';
  const btnText  = _btn('+ T',  'Add text box (opens editor)');
  const btnImg   = _btn('+ 🖼', 'Add image');
  const btnIface = _btn('+ 🖥', 'Insert interface (image from your library folder)');
  const btnRect  = _btn('▭',   'Add rectangle');
  const btnCirc  = _btn('●',   'Add circle');
  const btnEll   = _btn('⬭',   'Add ellipse');
  const btnTri   = _btn('▲',   'Add triangle');
  const btnLine  = _btn('—',   'Add line');
  const btnArrow = _btn('→',   'Add arrow');
  const btnToc   = _btn('▤',   'Add table of contents (auto from chapters + timecodes)');
  const btnDel   = _btn('🗑',   'Delete selected');
  btnText.addEventListener('click', async () => {
    const node = await overlay.addTextBox();
    if (node) setStatus('Text box added — double-click to edit.');
  });
  btnImg.addEventListener('click', async () => {
    const file = await _pickImageFile();
    if (!file) return;
    try { await overlay.addImage(file); }
    catch (e) { setStatus(`Image load failed: ${e.message}`, 'danger'); }
  });
  // Interface: first click (no folder yet) prompts for the library folder;
  // every click after that inserts the first library image at the default pose.
  btnIface.addEventListener('click', async () => {
    if (!interfaces.getLibraryFolder()) {
      const folder = await interfaces.chooseLibraryFolder();
      if (!folder) { setStatus('No interface folder chosen.', 'warn', 2500); return; }
      const imgs = await interfaces.listLibraryImages();
      const name = folder.split(/[\\/]/).filter(Boolean).pop() || folder;
      setStatus(`Interface library set → "${name}" (${imgs.length} image${imgs.length === 1 ? '' : 's'}). Click again to insert.`, 'success', 5000);
      return;
    }
    const res = await interfaces.insertFirstInterface();
    if (res.ok) setStatus(`Interface inserted: ${res.name}.`, 'success', 2500);
    else        setStatus(`Couldn’t insert interface: ${res.error}.`, 'warn', 3000);
  });
  btnRect .addEventListener('click', () => { if (overlay.addRect())     setStatus('Rectangle added.'); });
  btnCirc .addEventListener('click', () => { if (overlay.addCircle())   setStatus('Circle added.'); });
  btnEll  .addEventListener('click', () => { if (overlay.addEllipse())  setStatus('Ellipse added.'); });
  btnTri  .addEventListener('click', () => { if (overlay.addTriangle()) setStatus('Triangle added.'); });
  btnLine .addEventListener('click', () => { if (overlay.addLine())     setStatus('Line added.'); });
  btnArrow.addEventListener('click', () => { if (overlay.addArrow())    setStatus('Arrow added.'); });
  btnToc  .addEventListener('click', async () => {
    const node = await overlay.addTocBox();
    if (node) setStatus('Table of contents added — edit lines directly, or right-click → Refresh timecodes.', 'success', 4000);
    else      setStatus('Couldn’t add table of contents.', 'warn', 2500);
  });
  btnDel  .addEventListener('click', () => overlay.deleteSelected());
  _tools.append(btnText, btnImg, btnIface, btnRect, btnCirc, btnEll, btnTri, btnLine, btnArrow, btnToc, btnDel);

  // The editing toggle is rightmost — always visible, single source of
  // truth for entering/leaving overlay editing. The old "Done" button
  // was redundant with this toggle and has been removed.
  _mainBtn = _btn('✏ Edit overlay', 'Toggle overlay editing mode');
  _mainBtn.addEventListener('click', () => _setEditing(!overlay.isEditing()));

  // Append in left-to-right DOM order: text slot · tools · toggle.
  _bar.append(_textSlot, _tools, _mainBtn);

  surface.appendChild(_bar);

  // Blink + (after 3) prompt when the user clicks the viewport while editing.
  state.on('overlay:misclick', _onOverlayMisclick);
  // Entering OR leaving overlay edit resets the nudge state.
  state.on('change:overlayEditing', () => { _misclickCount = 0; _suppressExitPrompt = false; });
}

function _blinkEditButton() {
  if (!_mainBtn) return;
  if (_blinkTimer) { clearTimeout(_blinkTimer); _blinkTimer = null; }
  const base = () => (overlay.isEditing() ? 'rgba(245,158,11,0.25)' : '');
  let n = 0;
  const step = () => {
    _mainBtn.style.background = (n % 2 === 0) ? 'rgba(245,158,11,0.95)' : base();
    n++;
    if (n <= 5) { _blinkTimer = setTimeout(step, 110); }
    else        { _mainBtn.style.background = base(); _blinkTimer = null; }
  };
  step();
}

async function _onOverlayMisclick() {
  _blinkEditButton();                       // always blink — the reminder
  if (_suppressExitPrompt) return;
  if (++_misclickCount < 3) return;
  _misclickCount = 0;
  const choice = await chooseFromButtons(
    'Overlay edit mode is on',
    "You're editing the overlay, so clicks in the viewport won't select 3D objects. Exit overlay edit?",
    [{ id: 'exit', label: 'Exit overlay', primary: true }, { id: 'stay', label: 'Stay in overlay' }],
  );
  if (choice === 'exit') _setEditing(false);
  else _suppressExitPrompt = true;          // declined → don't prompt again until they leave overlay
}

/**
 * Returns the inline DIV that text-toolbar.js populates while the
 * in-place text editor is open. Lives on the same row as the Add /
 * Delete buttons and the Edit toggle — no separate floating bar.
 */
export function getTextToolbarSlot() {
  return _textSlot;
}

function _setEditing(on) {
  overlay.setEditingMode(on);
  _mainBtn.textContent = on ? '✏ Editing…' : '✏ Edit overlay';
  _mainBtn.style.background = on ? 'rgba(245,158,11,0.25)' : '';
  _tools.style.display      = on ? 'flex' : 'none';
}

// ── Utils ──────────────────────────────────────────────────────────────────

function _btn(label, title) {
  const b = document.createElement('button');
  b.className   = 'btn';
  b.textContent = label;
  b.title       = title || '';
  b.style.cssText = 'height:24px;padding:0 8px;font-size:12px;';
  return b;
}

function _sep() {
  const s = document.createElement('span');
  s.style.cssText = 'width:1px;height:16px;background:rgba(255,255,255,0.15);margin:0 2px;';
  return s;
}

function _pickImageFile() {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => resolve(inp.files?.[0] || null);
    inp.oncancel = () => resolve(null);
    inp.click();
  });
}

