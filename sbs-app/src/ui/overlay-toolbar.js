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
import { keyHint } from '../core/keymap.js';          // 🎹 advertised shortcut stays in sync
import * as userSettings from '../core/user-settings.js';   // 🧲 only to know WHEN the saved magnet settings are in
import * as header from '../systems/header.js';             // 🏷 the project logo lives in the header
import * as actions from '../systems/actions.js';           // 🏷 …and creating it from here is one undo entry, like the Header tab's

let _bar = null;
let _mainBtn = null;
let _tools = null;
let _textSlot = null;   // populated by text-toolbar.js while editing
let _xrayBtn = null;    // 👓 overlay X-ray toggle (V0.3.2.229, keybound .238) — lives in the Helpers panel since V0.3.4.12
let _helperBar = null, _cogBtn = null, _helpersPanel = null, _helpersOpen = false;   // 🧰 the helper ROW under the bar (👓 X-ray · 🧲 magnet · ⚙) and the settings the ⚙ opens
let _magnetBtn = null, _magnetItems = null, _magnetFrame = null, _magnetDist = null;

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
  const btnTable = _btn('▦',   'Add a table — type in its cells, right-click for rows and columns');
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
  // Interface: 🖼 V0.3.2.189 — first click (no library yet) opens an IMAGE
  // file dialog: you SEE the images while browsing (the folder picker hid
  // them — "you wanna see what you're looking for"), the picked image is
  // inserted right away, and its folder becomes the library. Later clicks
  // insert the first library image at the default pose, as before.
  btnIface.addEventListener('click', async () => {
    if (!interfaces.getLibraryFolder()) {
      const res = await interfaces.chooseAndInsertInterfaceFile();
      if (res.cancelled) { setStatus('No interface image chosen.', 'warn', 2500); return; }
      if (res.ok) {
        const folderName = (res.folder || '').split(/[\\/]/).filter(Boolean).pop() || '';
        setStatus(`Interface inserted: ${res.name} — library set to "${folderName}". Right-click the image to change it.`, 'success', 6000);
      } else setStatus(`Couldn’t insert interface: ${res.error}.`, 'warn', 3000);
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
  btnTable.addEventListener('click', async () => {
    const node = await overlay.addTableBox();
    if (node) setStatus('▦ Table added — double-click it to type, right-click for rows and columns.', 'success', 5000);
    else      setStatus('Couldn’t add the table.', 'warn', 2500);
  });
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
  // `entries` may be a function (built when the menu opens — the logo entry
  // depends on whether the project has one), and an entry may be a ready
  // {label, action} instead of [icon, name, button].
  const _menuFrom = (btn, entries) => (ev) => {
    const r = btn.getBoundingClientRect();
    const list = typeof entries === 'function' ? entries() : entries;
    showContextMenu(
      list.map(e => Array.isArray(e) ? { label: `${e[0]} ${e[1]}`, action: () => e[2].click() } : e),
      r.left, r.bottom + 4,
    );
    ev.stopPropagation();
  };

  // ── 🏷 THE PROJECT LOGO, ON A STEP (V0.3.4.81) ─────────────────────────
  // The logo is a header item (Header tab ▸ 🏷 + Logo). From here it can be put
  // on the current step's overlay as an image — at the place and size it has
  // over the film, so a logo hidden there with the eye lands where it belongs.
  // It is a COPY: an overlay image like any other, which later replacing the
  // logo does not change. A project with no logo yet gets one from here: the
  // picked file becomes the header logo (one undo entry) and is put on the
  // step as well.
  const _insertLogo = async (item) => {
    try {
      const node = await overlay.addImage(item.dataUrl, { x: item.x, y: item.y, w: item.w, h: item.h, label: 'Add the project logo' });
      if (node) setStatus('🏷 The project logo, on this step — where it sits over the film. It is a copy: replacing the logo later does not change it.', 'success', 7000);
    } catch (e) { setStatus(`Could not place the logo: ${e.message}`, 'danger'); }
  };
  const _createLogo = async () => {
    const file = await _pickImageFile();
    if (!file) return;
    const dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result || '')); r.onerror = () => res(''); r.readAsDataURL(file); });
    if (!dataUrl) { setStatus('Could not read that picture.', 'danger'); return; }
    const dims = await new Promise(res => { const im = new Image(); im.onload = () => res({ w: im.width, h: im.height }); im.onerror = () => res({ w: 0, h: 0 }); im.src = dataUrl; });
    const MAX_W = 480;                                     // the Header tab's own sizing rule
    const w = Math.max(1, Math.min(dims.w || MAX_W, MAX_W));
    const h = Math.max(1, Math.round(w * ((dims.w > 0 && dims.h > 0) ? dims.h / dims.w : 1)));
    let item = null;
    actions.commitStateChange('Add the project logo', ['headerItems'], () => {
      item = header.addHeaderItem('image', { dataUrl, naturalW: dims.w, naturalH: dims.h, w, h });
      header.setProjectLogo(item.id);
    });
    if (!item) return;
    await _insertLogo(item);
    setStatus('🏷 Logo created — it is a header item now (Header tab: hide it with the eye if it should not be over the film) and it is on this step.', 'success', 9000);
  };
  const _logoEntry = () => {
    const { item, defined } = header.projectLogoItem();
    return (item && defined)
      ? { label: '🏷 Project logo', action: () => { _insertLogo(item); } }
      : { label: '🏷 Project logo — none yet: pick a file…', action: () => { _createLogo(); } };
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

  const btnAssets = _btn('🖼 Assets ▾', 'Insert an image, the project logo, a video, an interface, a table or a table of contents');
  btnAssets.addEventListener('click', _menuFrom(btnAssets, () => [
    ['🖼', 'Image',             btnImg],
    _logoEntry(),
    ['🎬', 'Video clip',        btnVideo],
    ['🖥', 'Interface',         btnIface],
    ['▦', 'Table',             btnTable],
    ['▤', 'Table of contents', btnToc],
  ]));

  // The originals stay live (the menu clicks them) but are never shown.
  for (const b of [btnImg, btnVideo, btnIface, btnRect, btnCirc, btnEll, btnTri, btnLine, btnArrow, btn3dArrow, btnToc, btnTable]) {
    b.style.display = 'none';
    _tools.appendChild(b);
  }
  // 🗂 V0.3.2.221 — the library manager for the two overlay definition sets
  // that never had one: crop masks and pinned positions. Loaded on demand so
  // it costs nothing until opened.
  const btnLibs = _btn('🗂', 'Manage crop masks and pinned positions (rename, find users, delete)');
  btnLibs.addEventListener('click', async () => {
    const { openMaskPinPanel } = await import('./mask-pin-panel.js');
    openMaskPinPanel('masks');
  });

  _tools.append(btnText, btnConst, _sep(), btnShape, btnAssets, _sep(), btnLibs, btnDel, btnHdrLock);

  // The editing toggle is rightmost — always visible, single source of
  // truth for entering/leaving overlay editing. The old "Done" button
  // was redundant with this toggle and has been removed.
  _mainBtn = _btn(`✏ Edit overlay ${keyHint('overlayEdit')}`, 'Toggle overlay editing mode');
  _mainBtn.addEventListener('click', () => _setEditing(!overlay.isEditing()));

  // 🧰 Helpers (V0.3.4.14) — a SECOND ROW under the bar for the arranging aids: 👓 X-ray, 🧲 the magnet, and a ⚙
  // that opens their settings. A row of its own, because there will be more aids like these. Aids only: nothing
  // here is rendered, exported or saved with the project — the magnet's settings are this machine's (user
  // settings), like the shape defaults. NOT inside the bar: the bar has overflow-x:auto (it scrolls when crowded)
  // and clips whatever hangs in it.
  const PANEL_CSS = ['position:absolute', 'right:8px', 'z-index:30', 'background:rgba(10,15,25,0.85)', 'border:1px solid rgba(255,255,255,0.08)',
    'border-radius:8px', 'font-size:12px', 'user-select:none', 'backdrop-filter:blur(4px)'].join(';');
  _helperBar = document.createElement('div');
  _helperBar.id = 'overlay-helpers-bar';
  _helperBar.style.cssText = `${PANEL_CSS};display:flex;gap:6px;align-items:center;padding:4px 6px;`;
  _xrayBtn = _btn('👓 X-ray', 'Ghost the overlay so you can see the 3D scene underneath. Arranging aid only — renders, exports and thumbnails are unaffected.');
  _xrayBtn.addEventListener('click', () => toggleOverlayXray());
  _magnetBtn = _btn('🧲 Magnet', 'While you drag, the item\'s edges and centre stick to the edges and centres of the other items and of the picture. Hold Alt while dragging to let go of it for a moment; hold Shift to move straight along X or Y.');
  _magnetBtn.addEventListener('click', () => toggleOverlaySnap());
  _cogBtn = _btn('⚙', 'Helper settings — what the magnet sticks to and how far it reaches');
  _helperBar.append(_xrayBtn, _magnetBtn, _cogBtn);

  _helpersPanel = document.createElement('div');
  _helpersPanel.id = 'overlay-helpers-panel';
  _helpersPanel.style.cssText = `${PANEL_CSS};z-index:31;display:none;flex-direction:column;gap:7px;padding:9px 10px;color:#cbd5e1;background:rgba(10,15,25,0.94);white-space:nowrap;`;
  const row = (html) => { const d = document.createElement('label'); d.style.cssText = 'display:flex;gap:7px;align-items:center;cursor:pointer;'; d.innerHTML = html; return d; };
  const head = document.createElement('div'); head.style.cssText = 'font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;'; head.textContent = '🧲 The magnet sticks…';
  _magnetItems = row('<input type="checkbox" data-snap="items"> to the other items');
  _magnetFrame = row('<input type="checkbox" data-snap="frame"> to the picture (edges + centre)');
  _magnetDist  = row('from <input type="number" data-snap="distance" min="1" max="60" step="1" style="width:52px;background:#0b1220;color:#e2e8f0;border:1px solid #334155;border-radius:5px;padding:2px 5px;"> px away');
  _helpersPanel.append(head, _magnetItems, _magnetFrame, _magnetDist);
  _cogBtn.addEventListener('click', (e) => { e.stopPropagation(); _helpersOpen = !_helpersOpen; _syncHelpers(); });
  _helpersPanel.addEventListener('change', async (e) => {
    const k = e.target?.dataset?.snap; if (!k) return;
    await overlay.setSnapPrefs({ [k]: k === 'distance' ? Math.max(1, Math.min(60, Number(e.target.value) || 8)) : !!e.target.checked });
    e.target.blur?.();   // a focused field silences every single-key shortcut (O, X, M, Delete, the arrows) until focus moves
    _syncHelpers();
  });
  _helpersPanel.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.addEventListener('pointerdown', (e) => { if (_helpersOpen && !_helpersPanel.contains(e.target) && e.target !== _cogBtn) { _helpersOpen = false; _syncHelpers(); } }, true);

  // Append in left-to-right DOM order: text slot · tools · toggle. The helper row and its settings hang under the bar.
  _bar.append(_textSlot, _tools, _mainBtn);
  surface.append(_helperBar, _helpersPanel);
  new ResizeObserver(() => _placeHelpers()).observe(_bar);
  _syncXray();
  // the saved settings load after this toolbar is built: show the user's real magnet state once they are in
  userSettings.initUserSettings?.().then(() => _syncHelpers()).catch(() => {});

  surface.appendChild(_bar);

  // 🎹 rebound key → refresh the advertised "(O)" on the toggle.
  window.addEventListener('sbs:keymap-changed', () => {
    if (_mainBtn) {
      const k = keyHint('overlayEdit');
      _mainBtn.textContent = overlay.isEditing() ? `✏ Editing… ${k}` : `✏ Edit overlay ${k}`;
    }
    _syncXray();
  });

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
  const k = keyHint('overlayEdit');
  _mainBtn.textContent = on ? `✏ Editing… ${k}` : `✏ Edit overlay ${k}`;
  _mainBtn.style.background = on ? 'rgba(245,158,11,0.25)' : '';
  _tools.style.display      = on ? 'flex' : 'none';
}

/**
 * 🎹 V0.3.2.168 — the keyboard shortcut's entry point (keymap 'overlayEdit').
 * Same path as clicking the button, so the label/tools stay in sync. No-op
 * before the toolbar exists.
 */
export function toggleOverlayEditing() {
  if (!_mainBtn) return;
  _setEditing(!overlay.isEditing());
}

/** 👓 V0.3.2.238 — the X-ray toggle's single entry point, so the button and
 *  the keyboard shortcut can never disagree about the label. */
export function toggleOverlayXray() {
  overlay.setOverlayXray(!overlay.isOverlayXray());
  _syncXray();
}

function _syncXray() {
  if (!_xrayBtn) return;
  const on = overlay.isOverlayXray();
  const k  = keyHint('overlayXray');
  _xrayBtn.textContent = on ? `👓 X-ray on ${k}` : `👓 X-ray ${k}`;
  _xrayBtn.style.background = on ? 'rgba(56,189,248,0.28)' : '';
  _syncHelpers();
}

/** 🧲 The magnet's single entry point — the button, the M key and the label can never disagree. */
export async function toggleOverlaySnap() {
  const on = !overlay.getSnapPrefs().enabled;
  await overlay.setSnapPrefs({ enabled: on });
  _syncHelpers();
  setStatus(on ? '🧲 Magnet on — dragged items stick to each other and to the picture (hold Alt to let go).' : '🧲 Magnet off.', 'info', 3000);
}

/** The helper row hangs right under the bar, its settings right under the row — whatever the bar's height. */
function _placeHelpers() {
  if (!_bar || !_helperBar) return;
  const top = _bar.offsetTop + _bar.offsetHeight + 4;
  _helperBar.style.top = `${top}px`;
  _helpersPanel.style.top = `${top + _helperBar.offsetHeight + 4}px`;
}

/** 🧰 The row shows what is switched on; the ⚙ panel mirrors the magnet's settings. */
function _syncHelpers() {
  if (!_helperBar) return;
  const p = overlay.getSnapPrefs();
  const k = keyHint('overlaySnap');
  _magnetBtn.textContent = p.enabled ? `🧲 Magnet on ${k}` : `🧲 Magnet ${k}`;
  _magnetBtn.style.background = p.enabled ? 'rgba(244,114,182,0.30)' : '';
  _cogBtn.style.background = _helpersOpen ? 'rgba(56,189,248,0.28)' : '';
  _helpersPanel.style.display = _helpersOpen ? 'flex' : 'none';
  _placeHelpers();
  _magnetItems.querySelector('input').checked = p.items;
  _magnetFrame.querySelector('input').checked = p.frame;
  const d = _magnetDist.querySelector('input');
  if (document.activeElement !== d) d.value = String(p.distance);
  for (const r of [_magnetItems, _magnetFrame, _magnetDist]) r.style.opacity = p.enabled ? '1' : '.55';
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

