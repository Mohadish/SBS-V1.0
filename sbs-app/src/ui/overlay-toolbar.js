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
import { showContextMenu } from './context-menu.js';   // 📌 constant-text-box picker
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
  const btnVideo = _btn('+ 🎬', 'Add video clip (played from disk — trim start/end and mute in its right-click menu)');
  const btnConst = _btn('+ 📌', 'Insert a constant text box (pinned position + unified style on every step; per-step text). Create one first: right-click any text box → "Make constant text box…"');
  const btnRect  = _btn('▭',   'Add rectangle');
  const btnCirc  = _btn('●',   'Add circle');
  const btnEll   = _btn('⬭',   'Add ellipse');
  const btnTri   = _btn('▲',   'Add triangle');
  const btnLine  = _btn('—',   'Add line');
  const btnArrow = _btn('→',   'Add arrow');
  const btn3dArrow = _btn('🎯↗', 'Add 3D arrow — click two points ON THE MODEL. The ends stay fixed in 3D space, so the arrow follows when you move the camera.');
  btn3dArrow.addEventListener('click', () => overlay.startAnchoredArrowPlacement());
  const btnToc   = _btn('▤',   'Add table of contents (auto from chapters + timecodes)');
  const btnDel   = _btn('🗑',   'Delete selected');
  // 🔒 Header layer lock (V0.3.2.100) — same toggle the Header tab has,
  // surfaced on the edit toolbar per user request. Label always shows the
  // CURRENT state; click flips it (undoable, same wrapper as the tab).
  const btnHdrLock = _btn('🔒 Header', 'Toggle the header layer lock (locked = headers can\'t be dragged/edited on the canvas)');
  const _syncHdrLock = () => {
    const locked = !!state.get('headersLocked');
    btnHdrLock.textContent = locked ? '🔒 Header locked' : '🔓 Header unlocked';
    btnHdrLock.style.opacity = locked ? '1' : '0.75';
  };
  btnHdrLock.addEventListener('click', async () => {
    // Dynamic imports: static ones would close an import cycle
    // (overlay-toolbar ← overlay ← steps ← actions / header).
    const [{ setHeadersLocked }, actions] = await Promise.all([
      import('../systems/header.js'), import('../systems/actions.js'),
    ]);
    const locked = !!state.get('headersLocked');
    actions.commitStateChange(
      locked ? 'Unlock header layer' : 'Lock header layer',
      ['headersLocked'],
      () => setHeadersLocked(!locked),
    );
  });
  state.on('change:headersLocked', _syncHdrLock);
  _syncHdrLock();
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
  // 🎬 V0.3.2.75 — the clip is REFERENCED from disk, never copied into the
  // project (a video inlined as base64 would blow the renderer's heap).
  // We need the real path, which modern Electron only exposes through the
  // preload bridge — same helper the model importer uses.
  btnVideo.addEventListener('click', async () => {
    const file = await _pickVideoFile();
    if (!file) return;
    const abs = (typeof file.path === 'string' && file.path)
      ? file.path
      : (window.sbsNative?.pathForFile?.(file) || '');
    if (!abs) {
      setStatus('Could not resolve that file\'s path on disk — try dragging it from a normal folder.', 'danger', 7000);
      return;
    }
    setStatus('Opening video…');
    try {
      const node = await overlay.addVideo(abs);
      if (node) {
        const secs = (Number(node.getAttr('videoDurationMs') || 0) / 1000).toFixed(1);
        setStatus(`Video added (${secs}s, muted). Right-click it to trim and unmute.`, 'success', 7000);
      }
    } catch (e) {
      setStatus(`Video failed: ${e.message}`, 'danger', 10000);
    }
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
  // 📌 Insert a constant text box: one definition inserts directly; several
  // open a picker; none yet → point at the creation flow.
  btnConst.addEventListener('click', async (e) => {
    const defs = state.get('constTextBoxes') || [];
    if (!defs.length) {
      setStatus('No constant text boxes defined yet — right-click any text box → "📌 Make constant text box…"', 'info', 7000);
      return;
    }
    if (defs.length === 1) { await overlay.insertConstTextBox(defs[0].id); return; }
    showContextMenu(
      defs.map(d => ({ label: `📌 ${d.name}`, action: () => overlay.insertConstTextBox(d.id) })),
      e.clientX, e.clientY,
    );
  });

  // ── 🧹 Grouped inserts (V0.3.2.137) ────────────────────────────────────
  // Thirteen bare icons sitting shoulder to shoulder was unreadable. The
  // inserts now collapse into two labelled dropdowns; Add-text stays a
  // button of its own because it is the one used constantly.
  //
  // The menu entries CLICK THE ORIGINAL BUTTONS rather than re-implementing
  // their handlers. Those handlers carry real behaviour — file pickers,
  // transcode prompts, library-folder checks, error reporting — and copying
  // any of it here would be a second version to keep in step.
  const _menuFrom = (btn, entries) => (ev) => {
    const r = btn.getBoundingClientRect();
    showContextMenu(
      entries.map(([icon, name, target]) => ({
        label: `${icon} ${name}`,
        action: () => target.click(),
      })),
      r.left, r.bottom + 4,
    );
    ev.stopPropagation();
  };

  const btnShape = _btn('▭ Shape ▾', 'Add a shape');
  btnShape.addEventListener('click', _menuFrom(btnShape, [
    ['▭', 'Rectangle', btnRect],
    ['●', 'Circle',    btnCirc],
    ['⬭', 'Ellipse',   btnEll],
    ['▲', 'Triangle',  btnTri],
    ['—', 'Line',      btnLine],
    ['→', 'Arrow',     btnArrow],
    ['🎯', '3D arrow (anchored to the model)', btn3dArrow],
  ]));

  const btnAssets = _btn('🖼 Assets ▾', 'Insert an image, video, interface or table of contents');
  btnAssets.addEventListener('click', _menuFrom(btnAssets, [
    ['🖼', 'Image',             btnImg],
    ['🎬', 'Video clip',        btnVideo],
    ['🖥', 'Interface',         btnIface],
    ['▤', 'Table of contents', btnToc],
  ]));

  // The originals stay live (the menu clicks them) but are never shown.
  for (const b of [btnImg, btnVideo, btnIface, btnRect, btnCirc, btnEll, btnTri, btnLine, btnArrow, btn3dArrow, btnToc]) {
    b.style.display = 'none';
    _tools.appendChild(b);
  }
  _tools.append(btnText, btnConst, _sep(), btnShape, btnAssets, _sep(), btnDel, btnHdrLock);

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
// ─── Floating style panel (V0.3.2.141) ──────────────────────────────────────
//
// The style controls used to live in a slot inside the top-right overlay
// bar, miles from whatever you were editing. They now ride directly above
// (or below) the selected box/shape.
//
// position:fixed on document.body rather than inside #viewport-surface: the
// panel has to escape the viewport's clipping, and page coordinates are what
// the Konva→DOM mapping already produces (container rect + absolute node
// position, the same pairing the in-place text editor uses).
//
// z-index 40 keeps it above the overlay chrome (z30) and below the modal
// layer (z50) — the ladder that lets context menus and prompts open over it.

let _floatBar  = null;
let _floatSlot = null;

const FLOAT_GAP    = 10;   // px between the panel and the box it serves
const FLOAT_MARGIN = 8;    // px minimum clearance from the window edge

function _ensureFloatBar() {
  if (_floatBar) return;
  _floatBar = document.createElement('div');
  _floatBar.id = 'overlay-float-toolbar';
  _floatBar.dataset.sbsFloatToolbar = '1';
  // The in-place text editor's click-outside detector whitelists
  // [data-sbs-text-toolbar]. The mounted toolbar carries that marker, but
  // the panel's own padding does not — a click landing on the 6px gutter
  // would tear the editor down mid-edit. Mark the whole panel.
  _floatBar.dataset.sbsTextToolbar = '1';
  _floatBar.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'z-index:40',
    'display:none', 'gap:6px', 'align-items:center', 'flex-wrap:nowrap',
    'background:rgba(10,15,25,0.95)',
    'border:1px solid rgba(255,255,255,0.12)',
    'border-radius:8px', 'padding:4px 6px',
    'font-size:12px', 'user-select:none',
    'backdrop-filter:blur(6px)',
    'box-shadow:0 6px 20px rgba(0,0,0,0.45)',
    'max-width:calc(100vw - 16px)',
  ].join(';');
  _floatSlot = document.createElement('div');
  _floatSlot.id = 'overlay-float-slot';
  _floatSlot.style.cssText = 'display:flex;gap:4px;align-items:center;flex-wrap:nowrap;';
  _floatBar.appendChild(_floatSlot);
  document.body.appendChild(_floatBar);
}

/**
 * The mount point for the text / shape toolbars. Returns the FLOATING
 * panel's slot — the legacy `_textSlot` inside the top bar is retained
 * (harmless, empty) so nothing that still references the bar's layout
 * breaks.
 */
export function getTextToolbarSlot() {
  _ensureFloatBar();
  return _floatSlot;
}

/**
 * Park the panel against a box. `rect` is the target's bounding box in
 * PAGE coordinates ({left, top, right, bottom}).
 *
 * Sits above the box by default and flips below when there isn't room —
 * that is the whole point of the flip, so the panel never covers the
 * thing you're editing or slides off-screen. If neither side fits (a box
 * taller than the window) it clamps into view rather than vanishing.
 */
export function showFloatingToolbar(rect) {
  _ensureFloatBar();
  if (!rect) { hideFloatingToolbar(); return; }
  if (!_floatSlot.childElementCount) { hideFloatingToolbar(); return; }

  // Both toolbars set the host to display:none when they unmount — and
  // mountTextToolbar uses the host element ITSELF as its root — so the slot
  // arrives here hidden after any previous unmount. Re-show it, or the
  // panel measures 0×0 and renders as an empty sliver.
  _floatSlot.style.display = 'flex';

  // Measure while invisible so the user never sees it at the old spot.
  _floatBar.style.visibility = 'hidden';
  _floatBar.style.display    = 'flex';
  const w = _floatBar.offsetWidth;
  const h = _floatBar.offsetHeight;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Vertical: prefer above, flip below when the top is too close.
  let top = rect.top - h - FLOAT_GAP;
  if (top < FLOAT_MARGIN) {
    const below = rect.bottom + FLOAT_GAP;
    top = (below + h + FLOAT_MARGIN <= vh) ? below : FLOAT_MARGIN;
  }
  top = Math.max(FLOAT_MARGIN, Math.min(top, vh - h - FLOAT_MARGIN));

  // Horizontal: centre on the box, then clamp into the window.
  let left = rect.left + (rect.right - rect.left) / 2 - w / 2;
  left = Math.max(FLOAT_MARGIN, Math.min(left, vw - w - FLOAT_MARGIN));

  _floatBar.style.left       = `${Math.round(left)}px`;
  _floatBar.style.top        = `${Math.round(top)}px`;
  _floatBar.style.visibility = 'visible';
}

export function hideFloatingToolbar() {
  if (_floatBar) _floatBar.style.display = 'none';
}

export function isFloatingToolbarVisible() {
  return !!_floatBar && _floatBar.style.display !== 'none';
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

function _pickVideoFile() {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file';
    // Only what Chromium can actually decode — an unsupported container
    // fails late and confusingly, so keep it out of the picker.
    inp.accept = 'video/mp4,video/webm,video/ogg,video/quicktime,.mp4,.m4v,.webm,.ogv,.mov';
    inp.onchange = () => resolve(inp.files?.[0] || null);
    inp.oncancel = () => resolve(null);
    inp.click();
  });
}

