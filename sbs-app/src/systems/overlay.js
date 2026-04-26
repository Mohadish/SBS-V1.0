/**
 * SBS — Per-step 2D overlay (Phase 2a)
 * =====================================
 * A Konva stage pinned on top of the 3D viewport. Each step stores its own
 * overlay state on `step.overlay`, a Konva JSON string, so editing on one
 * step doesn't affect others.
 *
 * Features (MVP):
 *   • Add text box (single style per box — font, size, color via toolbar)
 *   • Add image (local file → base64 data URL, stored inline in the project)
 *   • Click to select; drag to move; corner handles to resize; rotate handle
 *   • Delete key removes the selected node
 *   • Double-click a text box to edit its content via a floating <textarea>
 *
 * Phase 2b will add: compositing overlay canvas over 3D during video export.
 */

import { state } from '../core/state.js';
import { showContextMenu } from '../ui/context-menu.js';
import { mountTextToolbar, unmountTextToolbar, execCommandApplier, setToolbarValues } from '../ui/text-toolbar.js';
import { getTextToolbarSlot }  from '../ui/overlay-toolbar.js';

let _stage       = null;   // Konva.Stage
let _layer       = null;   // Konva.Layer — holds all user content
let _uiLayer     = null;   // Konva.Layer — transformer, editing aids
let _transformer = null;
let _container   = null;
let _editing     = false;
let _resizeObs   = null;
let _saveTimer   = null;
let _activeStepUnwatch = null;

// ─── Init ──────────────────────────────────────────────────────────────────

export function initOverlay() {
  if (!window.Konva) {
    console.warn('[overlay] Konva not loaded — overlay disabled.');
    return;
  }
  _container = document.getElementById('overlay-stage');
  if (!_container) return;

  _stage = new Konva.Stage({
    container: _container,
    width:     _container.clientWidth  || 1,
    height:    _container.clientHeight || 1,
  });
  _layer   = new Konva.Layer();
  _uiLayer = new Konva.Layer();
  _stage.add(_layer);
  _stage.add(_uiLayer);

  _transformer = new Konva.Transformer({
    rotateEnabled: true,
    anchorSize:    8,
    borderStroke:  '#f59e0b',
    anchorStroke:  '#f59e0b',
    anchorFill:    '#fff',
    // Default: aspect-locked corner-only (matches image behaviour). When a
    // text box is selected we flip these to free-resize via _configTransformer
    // — text boxes reflow into the new dimensions instead of stretching.
    keepRatio:        true,
    enabledAnchors:   ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
  });
  _uiLayer.add(_transformer);

  // Click an empty area → deselect.
  _stage.on('pointerdown', (e) => {
    if (e.target === _stage) _setSelection(null);
  });

  // Keyboard: Delete removes the selected node (only when editing).
  window.addEventListener('keydown', _onKeyDown);

  // Resize stage to match viewport surface.
  _syncSize();
  _resizeObs = new ResizeObserver(_syncSize);
  _resizeObs.observe(_container);

  // Restore the currently-active step's overlay on load / step change.
  state.on('step:applied', _onStepApplied);
  state.on('change:activeStepId', _scheduleLoad);
}

function _syncSize() {
  if (!_stage || !_container) return;
  const r = _container.getBoundingClientRect();
  if (r.width && r.height) {
    _stage.width(r.width);
    _stage.height(r.height);
  }
}

// ─── Editing mode ──────────────────────────────────────────────────────────

export function isEditing() { return _editing; }

/**
 * Borrow the overlay's Konva.Stage for sibling layers (header.js).
 * Returns null until initOverlay() has run.
 */
export function getStage() { return _stage; }

export function setEditingMode(on) {
  _editing = !!on;
  if (_container) _container.classList.toggle('editing', _editing);
  if (!_editing) _setSelection(null);
}

// ─── Creating nodes ────────────────────────────────────────────────────────

/**
 * Drop a fresh text box onto the stage and immediately enter in-place
 * edit mode. No modal — Phase 2 onwards we edit on the canvas.
 *
 * The initial raster is just placeholder text so the Konva.Image has
 * something to host while the editable <div> is mounted on top. As
 * soon as the user clicks outside (or presses Escape), the node
 * re-rasterises from the contenteditable's HTML.
 */
export async function addTextBox() {
  if (!_stage) return null;
  const html = '<div>Text</div>';

  const canvas = await _htmlToCanvas(html, { width: 400 });
  if (!canvas) return null;

  const node = new Konva.Image({
    x: (_stage.width()  - canvas.width)  / 2,
    y: (_stage.height() - canvas.height) / 2,
    image: canvas,
    width:  canvas.width,
    height: canvas.height,
    draggable: true,
    name: 'userTextBox',
  });
  node.setAttr('textHtml',  html);
  node.setAttr('textWidth', canvas.width);
  // Stash the natural (un-scaled) dimensions so right-click → Reset can
  // restore the original raster size without recomputing the editor pass.
  node.setAttr('naturalW',  canvas.width);
  node.setAttr('naturalH',  canvas.height);
  _layer.add(node);
  _attachNode(node);
  _setSelection(node);
  // Auto-enter edit mode so the user doesn't have to dbl-click first.
  _enterTextEdit(node);
  _scheduleSave();
  return node;
}

// ─── Live in-place text editing (Phase 2) ───────────────────────────────────
//
// Replaces the modal popup. Double-click a text box → a contenteditable
// <div> mounts over the canvas at the node's position, the rasterised
// Konva.Image is hidden, the user types/edits/selects natively. On click
// outside, we re-rasterise the HTML and bring the Konva.Image back.
//
// Phase 3 will add a floating style toolbar above this editable; the
// toolbar will use mousedown.preventDefault() so clicking it doesn't
// blur the selection.

let _activeTextEditor = null;   // { node, div, onDocMouseDown, transformerWasVisible }

/** Open the in-place editor on a text-box node. */
function _enterTextEdit(node) {
  if (_activeTextEditor) _exitTextEdit();
  const containerRect = _container.getBoundingClientRect();
  const pos = node.getAbsolutePosition();

  const div = document.createElement('div');
  div.contentEditable = 'true';
  div.spellcheck      = false;
  div.innerHTML       = node.getAttr('textHtml') || '<div>Text</div>';
  div.dataset.sbsTextEditor = '1';
  // CSS MUST match _htmlToCanvas exactly — padding, font-family, font-size,
  // line-height. Otherwise the rasterised result lands somewhere different
  // from where the user typed and the click-out feels like a "jump".
  // Live editor mounts with auto-height. Setting min-height was making
  // the editable taller than the content (and hiding caret position
  // strangeness on short content). With min-height:0 the box's height
  // tracks whatever the user types — exactly matching the rasterised
  // result on click-out.
  // overflow stays visible during edit so the caret never gets clipped
  // mid-line; the rasteriser still uses overflow:hidden internally
  // (no-op when there's no fixed height anyway).
  div.style.cssText = [
    'position:fixed',
    `left:${Math.round(containerRect.left + pos.x)}px`,
    `top:${Math.round(containerRect.top + pos.y)}px`,
    `width:${Math.round(node.width())}px`,
    'min-height:0',
    'padding:8px',                     // matches _htmlToCanvas default
    'margin:0',
    'border:0',
    'outline:2px dashed #f59e0b',
    'outline-offset:0',
    'background:rgba(15,23,42,0.55)',
    'color:#ffffff',                   // matches _htmlToCanvas default
    'font-family:Arial',               // matches _htmlToCanvas default
    'font-size:16px',                  // matches _htmlToCanvas default
    'line-height:1.2',                 // matches _htmlToCanvas default
    'white-space:pre-wrap',
    'word-wrap:break-word',
    'box-sizing:border-box',           // matches _htmlToCanvas default
    'z-index:10000',
    'cursor:text',
    'user-select:text',
  ].join(';');
  document.body.appendChild(div);

  // Hide the rasterised image but KEEP the node addressable so the
  // transformer stays attached — that way the user can resize the box
  // mid-edit and the contenteditable follows live (see node.on('transform')
  // in _attachNode).  We use opacity:0 (not visible:false) for this; the
  // transformer's bounding box still tracks the node's geometry.
  const prevOpacity = node.opacity();
  node.opacity(0);
  // Re-config the transformer for the editing node so 8 anchors show up
  // (selection-only state has no anchors).
  _configTransformerForNode(node);
  _uiLayer.batchDraw();
  _layer.batchDraw();

  // Tell Chromium to wrap new lines in <div> rather than <br>. With
  // <br> at position 0 the browser treats it inconsistently — typing
  // before the first character can swallow content. <div> gives every
  // line a stable block container and Enter / Backspace at position 0
  // behave predictably.
  try { document.execCommand('defaultParagraphSeparator', false, 'div'); } catch {}
  // Force execCommand to write inline-style spans (e.g.
  //   <span style="color:red">...</span>)
  // instead of legacy <font color="..."> markup. Without this Chromium
  // defaults to <font> for foreColor/fontName/fontSize, which our
  // sanitiser strips (not in the allowlist) — so copy/paste between
  // textboxes was losing colour and font on every round trip.
  try { document.execCommand('styleWithCSS', false, true); } catch {}

  // Focus + put the caret at the end of the existing content.
  div.focus();
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(div);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Click-outside detection. Listen at the document on the capture phase
  // so we beat anything else that might consume the click. Skip if the
  // event landed inside the editor (or, later, the toolbar).
  const onDocMouseDown = (e) => {
    if (div.contains(e.target)) return;
    if (e.target?.closest?.('[data-sbs-text-toolbar]')) return;   // Phase 3
    _exitTextEdit();
  };
  // Defer one tick so the same dblclick that opened us doesn't immediately close us.
  setTimeout(() => document.addEventListener('mousedown', onDocMouseDown, true), 0);

  // Esc cancels (no save); Enter inserts a newline (browser default).
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      _exitTextEdit({ discard: true });
    }
  };
  div.addEventListener('keydown', onKeyDown);

  // Sanitise on COPY (source side), not on paste. The user reported
  // that paste-from-other-textboxes broke rasterisation, but paste from
  // arbitrary external sources worked. So the problem is in what our
  // OWN editor was putting on the clipboard — the cloned selection
  // carried wrapper styles / nested padding the SVG-foreignObject
  // rasteriser couldn't handle. Cleaning at copy time means:
  //   • paste between our textboxes works (clean HTML in, clean raster)
  //   • paste from external sources keeps native browser behaviour
  //     (we don't touch what the OS hands us)
  //   • formatting (bold/italic/colour/size/font/alignment) survives
  //     copy → paste because the sanitiser explicitly preserves those
  //     inline styles.
  const onCopy = (e) => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const text = sel.toString();
    const tmp = document.createElement('div');
    tmp.appendChild(sel.getRangeAt(0).cloneContents());
    const html = _sanitiseTextboxHtml(tmp.innerHTML);
    e.preventDefault();
    e.clipboardData?.setData('text/plain', text);
    e.clipboardData?.setData('text/html', html);
  };
  div.addEventListener('copy', onCopy);
  // Cut goes through the same sanitiser so cut→paste is symmetric.
  div.addEventListener('cut', (e) => {
    onCopy(e);
    document.execCommand('delete');
  });

  // Sanitise on paste too. The OS clipboard can hold HTML from anywhere
  // (websites, Word, PDFs, mail clients) — we run their HTML through
  // the same allowlist. If the payload has only plain text, fall back
  // to insertText so the user still gets the content. Without this,
  // arbitrary external HTML routinely breaks the rasteriser and the
  // user sees the "show but don't apply, revert on click-out" loop
  // we hit before.
  const onPaste = (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const html = cd.getData('text/html');
    const text = cd.getData('text/plain');
    if (html) {
      e.preventDefault();
      const clean = _sanitiseTextboxHtml(html);
      // insertHTML is consistent with the rest of execCommand-based
      // editing in this module; it places the HTML at the caret.
      document.execCommand('insertHTML', false, clean);
    } else if (text) {
      e.preventDefault();
      document.execCommand('insertText', false, text);
    }
  };
  div.addEventListener('paste', onPaste);

  // Mount the in-row toolbar (B/I/U/S, font, size, color, align). It
  // takes over the slot inside the existing overlay edit toolbar so all
  // controls live on the same row. Operates on the live Selection inside
  // the contenteditable. The click-outside detector already whitelists
  // [data-sbs-text-toolbar] so toolbar clicks won't dismiss the editor.
  const toolbarHost = getTextToolbarSlot();
  if (toolbarHost) mountTextToolbar(toolbarHost, _singleEditorApplier, div);
  // Sync the dropdowns to whatever style is at the caret. Re-fires on
  // every selection change so moving the caret across mixed-style runs
  // updates the toolbar live.
  const onSelectionChange = () => {
    if (!_activeTextEditor || !div.contains(window.getSelection()?.anchorNode || null)) return;
    setToolbarValues(_readStyleAtCaret(div));
  };
  document.addEventListener('selectionchange', onSelectionChange);
  onSelectionChange();   // initial sync

  _activeTextEditor = { node, div, onDocMouseDown, onKeyDown, onCopy, onPaste, prevOpacity, onSelectionChange };
}

/** Close the in-place editor, re-rasterise on the way out (unless discard). */
async function _exitTextEdit(opts = {}) {
  if (!_activeTextEditor) return;
  const { node, div, onDocMouseDown, onKeyDown, onCopy, onPaste, prevOpacity, onSelectionChange } = _activeTextEditor;
  document.removeEventListener('mousedown', onDocMouseDown, true);
  if (onSelectionChange) document.removeEventListener('selectionchange', onSelectionChange);
  div.removeEventListener('keydown', onKeyDown);
  if (onCopy) {
    div.removeEventListener('copy', onCopy);
    div.removeEventListener('cut',  onCopy);
  }
  if (onPaste) div.removeEventListener('paste', onPaste);
  unmountTextToolbar();

  const html = div.innerHTML;

  if (!opts.discard && html) {
    // Rasterise BEFORE tearing the editor down. _reflowTextBox already
    // honours node.getAttr('fillColor') so the textbox's background
    // survives the round-trip — that was the bug where "any edit
    // removes the background colour". Doing it while the editor is
    // still mounted also kills the "nothing → raster" flicker the
    // user called out: the new image is ready before the editable
    // disappears.
    //
    // If rasterisation fails (typically: HTML the SVG-foreignObject
    // path can't render) we revert textHtml so the next dblclick
    // reopens the LAST KNOWN-GOOD content rather than re-loading the
    // bad HTML and getting stuck in a "click-out doesn't take" loop.
    const prevHtml = node.getAttr('textHtml');
    node.setAttr('textHtml', html);
    const ok = await _reflowTextBox(node);
    if (!ok) {
      console.warn('[overlay] rasterise failed on click-out — reverting to previous text.');
      node.setAttr('textHtml', prevHtml);
    }
  }

  // Now swap visibility back. The new raster is in place, so removing
  // the editor reveals it instantly without an empty frame.
  node.opacity(typeof prevOpacity === 'number' ? prevOpacity : 1);
  div.remove();
  _activeTextEditor = null;
  _configTransformerForNode(node);
  _layer.batchDraw();
  _uiLayer.batchDraw();
  _scheduleSave();
}

/**
 * Re-rasterize a text-box node at its CURRENT width AND height. The
 * raster reflows the stored HTML into the user-dragged box: text wraps
 * at the new width, and content that overflows the dragged height is
 * clipped (true text-frame behaviour). Font size is unchanged.
 *
 * Position and dragged dimensions are preserved — this fixes the Phase 1
 * bug where the node snapped back to the content's natural height,
 * making the user's height drag look ignored.
 */
async function _reflowTextBox(node) {
  const html = node.getAttr('textHtml');
  if (!html) return false;
  const w = Math.max(20, Math.round(node.width()));
  const bgColor = node.getAttr('fillColor') || 'transparent';
  // Auto-height: do NOT pass `height` to the rasteriser. The canvas
  // ends up exactly as tall as the wrapped text needs at this width.
  // Box grows/shrinks vertically as the content does — true text-frame
  // behaviour without a manual height handle for the user to fight.
  const canvas = await _htmlToCanvas(html, { width: w, bgColor });
  if (!canvas) return false;
  node.image(canvas);
  node.width(canvas.width);
  node.height(canvas.height);
  node.setAttr('textWidth', canvas.width);
  node.setAttr('naturalW',  canvas.width);
  node.setAttr('naturalH',  canvas.height);
  _layer.batchDraw();
  return true;
}

// (Old modal-based _editTextBox + openTextEditor import removed in Phase 2.
// In-place editing via _enterTextEdit / _exitTextEdit is now the only path.)

/**
 * @param {string|File} src  data URL or File object (e.g. from <input type="file">)
 */
export async function addImage(src) {
  if (!_stage) return null;
  const dataUrl = typeof src === 'string' ? src : await _fileToDataURL(src);
  const img = await _loadImage(dataUrl);
  // Fit to 50% of stage on the larger axis, keep aspect.
  const maxW = _stage.width()  * 0.5;
  const maxH = _stage.height() * 0.5;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = img.width * scale;
  const h = img.height * scale;
  const node = new Konva.Image({
    x: (_stage.width() - w) / 2,
    y: (_stage.height() - h) / 2,
    image: img,
    width:  w,
    height: h,
    draggable: true,
    name: 'userImage',
  });
  // Store the data URL so toJSON round-trips (Konva doesn't serialize HTMLImageElement).
  node.setAttr('src', dataUrl);
  // Native pixel dimensions — used by right-click → Reset to restore the
  // image to its raw size (1:1 with the source file). The fitted w/h above
  // is just the on-create placement, not the "original" the user sees as canonical.
  node.setAttr('naturalW', img.width);
  node.setAttr('naturalH', img.height);
  _layer.add(node);
  _attachNode(node);
  _setSelection(node);
  _scheduleSave();
  return node;
}

function _attachNode(node) {
  // Single click selects (or toggles when held with Shift/Ctrl/Meta for
  // multi-select).
  //
  // Subtle but important: a plain click on a node that's ALREADY part of
  // a multi-selection should preserve the group — that click is the user
  // grabbing the group to drag, not asking to demote the selection to
  // just this one node. Without this guard, every drag start collapses
  // the selection to length-1 and the multi-drag handler bails.
  node.on('pointerdown', (e) => {
    const additive = !!(e.evt && (e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey));
    const current  = _transformer?.nodes() || [];
    if (!additive && current.includes(node)) return;
    _setSelection(node, additive);
  });

  // Multi-node drag. Konva's per-node draggable only moves the grabbed
  // node; siblings in the same selection stay put. Stash starting
  // positions on dragstart, apply the grabbed-node's delta to every
  // sibling on dragmove. dragend clears the cache.
  let _multiDragStarts = null;
  node.on('dragstart', () => {
    const sel = _transformer?.nodes() || [];
    if (sel.length <= 1) return;
    _multiDragStarts = new Map();
    for (const n of sel) _multiDragStarts.set(n, { x: n.x(), y: n.y() });
  });
  node.on('dragmove', () => {
    if (!_multiDragStarts) return;
    const start = _multiDragStarts.get(node);
    if (!start) return;
    const dx = node.x() - start.x;
    const dy = node.y() - start.y;
    for (const n of _multiDragStarts.keys()) {
      if (n === node) continue;
      const s = _multiDragStarts.get(n);
      n.x(s.x + dx);
      n.y(s.y + dy);
    }
    _layer.batchDraw();
  });
  node.on('dragend', () => { _multiDragStarts = null; });

  // LIVE resize during edit — when the user drags a transform anchor on a
  // text box that's currently being edited, the contenteditable resizes
  // in real time so the user sees text reflow instead of a stretched
  // raster (the editor is HTML, the raster only comes back on click-out).
  node.on('transform', () => {
    const editing = _activeTextEditor && _activeTextEditor.node === node;
    if (!editing) return;
    const div = _activeTextEditor.div;
    // Width-only resize for text boxes — height is content-driven, the
    // editable's natural height grows / shrinks as the wrap reflows.
    // We deliberately don't set a min-height here so the user sees real
    // height feedback while dragging.
    const w = node.width() * node.scaleX();
    div.style.width = `${Math.max(20, Math.round(w))}px`;
    div.style.minHeight = '0px';
    // Editor follows the node's anchored corner during left-side drags.
    const containerRect = _container.getBoundingClientRect();
    const pos = node.getAbsolutePosition();
    div.style.left = `${Math.round(containerRect.left + pos.x)}px`;
    div.style.top  = `${Math.round(containerRect.top  + pos.y)}px`;
  });

  // Flatten Konva's scaleX/scaleY into width/height on transformend so
  // toJSON round-trips a clean rect (and so future Resets compare against
  // a single source of truth instead of "width × scale").
  node.on('transformend', () => {
    const sx = node.scaleX();
    const sy = node.scaleY();
    if (sx !== 1 || sy !== 1) {
      node.width(node.width() * sx);
      node.height(node.height() * sy);
      node.scaleX(1);
      node.scaleY(1);
    }
    const editing = _activeTextEditor && _activeTextEditor.node === node;
    if (editing) {
      // In edit mode the editor IS the source of truth — sync its width
      // (height is content-driven, so we leave min-height at 0).
      const div = _activeTextEditor.div;
      div.style.width     = `${Math.max(20, Math.round(node.width()))}px`;
      div.style.minHeight = '0px';
    } else if (node.getClassName() === 'Image' && node.getAttr('textHtml')) {
      // Selection-only state: not currently expected (we removed text-box
      // anchors outside of edit mode), but if anything ever reaches here
      // we still want the raster to reflow rather than stay stretched.
      _reflowTextBox(node);
    }
    _scheduleSave();
  });
  node.on('dragend', _scheduleSave);
  // Right-click → context menu with Reset Size + Delete.
  node.on('contextmenu', (e) => {
    e.evt?.preventDefault();
    e.cancelBubble = true;
    _setSelection(node);
    const ev = e.evt;
    _showOverlayContextMenu(node, ev?.clientX ?? 0, ev?.clientY ?? 0);
  });
  if (node.getClassName() === 'Text') node.on('dblclick', () => _editText(node));
  // Any Konva.Image tagged as a user text box opens the in-place editor —
  // BUT only when this node is the sole selection. Editing one item of a
  // multi-selection produced flickery height changes (the editable mounts
  // at the node's geometry, but other selected nodes were getting their
  // bbox refreshed too). Cleanest fix: dblclick while multi-selected does
  // nothing; user has to click out of the group first, then dblclick.
  if (node.getClassName() === 'Image' && node.getAttr('textHtml')) {
    node.on('dblclick', () => {
      const sel = _transformer?.nodes() || [];
      if (sel.length > 1) return;
      _enterTextEdit(node);
    });
  }
}

/**
 * Reset a node's box back to the source-of-truth size:
 *   text box → canvas dimensions at last raster (textWidth × naturalH)
 *   image    → the source file's native pixel size (naturalW × naturalH)
 *
 * Position is preserved (we shrink/grow around the top-left). Aspect is
 * preserved by definition — both axes go back to the natural dims.
 */
function resetNodeToOriginalSize(node) {
  if (!node) return;
  const naturalW = node.getAttr('naturalW');
  const naturalH = node.getAttr('naturalH');
  if (!Number.isFinite(naturalW) || !Number.isFinite(naturalH)) return;
  node.width(naturalW);
  node.height(naturalH);
  node.scaleX(1);
  node.scaleY(1);
  _layer.batchDraw();
  _uiLayer.batchDraw();
  _scheduleSave();
}

function _showOverlayContextMenu(node, x, y) {
  const items = [];
  const hasNatural = Number.isFinite(node.getAttr('naturalW')) && Number.isFinite(node.getAttr('naturalH'));
  items.push({
    label:    'Reset to original size',
    disabled: !hasNatural,
    action:   () => resetNodeToOriginalSize(node),
  });
  items.push({ separator: true });
  items.push({
    label:  'Delete',
    action: () => {
      node.destroy();
      _setSelection(null);
      _layer.batchDraw();
      _scheduleSave();
    },
  });
  showContextMenu(items, x, y);
}

/**
 * Set or extend the overlay's node selection.
 *   _setSelection(null)            — clear all
 *   _setSelection(node)            — replace selection with [node]
 *   _setSelection(node, additive)  — toggle node in/out of the existing
 *                                    set (shift/ctrl/meta-click)
 *
 * Multi-select is honoured by Konva.Transformer natively: passing an
 * array of nodes draws one bounding box around all of them and a drag
 * moves the whole group together.
 */
function _setSelection(node, additive = false) {
  let nodes;
  if (!node) {
    nodes = [];
  } else if (additive) {
    const current = _transformer.nodes() || [];
    nodes = current.includes(node)
      ? current.filter(n => n !== node)
      : [...current, node];
  } else {
    nodes = [node];
  }
  _transformer.nodes(nodes);
  _configTransformerForNodes(nodes);
  _uiLayer.batchDraw();

  // Multi-textbox toolbar: when ≥1 text box is selected and we're not
  // already inside the in-place editor, surface the style toolbar in
  // "multi-mode". Each style click then routes through _multiTextApplier
  // — which walks each selected box's HTML and changes only the touched
  // property, leaving other inline styles intact.
  _refreshMultiToolbar();
}

/**
 * Decide whether the multi-textbox toolbar should be mounted/unmounted
 * based on the current selection. Single-editor mode wins (it has its
 * own mount + unmount calls in _enterTextEdit / _exitTextEdit).
 */
function _refreshMultiToolbar() {
  if (_activeTextEditor) return;     // single-editor mode owns the slot
  const host = getTextToolbarSlot();
  if (!host) return;
  const sel = _transformer?.nodes() || [];
  const textBoxes = sel.filter(n => n.getAttr?.('textHtml'));
  if (textBoxes.length >= 1) {
    mountTextToolbar(host, _multiTextApplier);
    setToolbarValues(_summariseStyleAcrossBoxes(textBoxes));
  } else {
    unmountTextToolbar();
  }
}

/**
 * Walk every text box's HTML, collect inline font-size / font-family /
 * colour declarations, and return a representative value per the user
 * spec: unified value when consistent, LARGEST when sizes differ. For
 * font / colour with mixed values we just pick the first one we see —
 * better than nothing for a hint, and the user can always override.
 */
function _summariseStyleAcrossBoxes(nodes) {
  const sizes = new Set();
  const fonts = new Set();
  const colors = new Set();
  const tmp = document.createElement('div');
  for (const n of nodes) {
    tmp.innerHTML = n.getAttr('textHtml') || '';
    tmp.querySelectorAll('[style]').forEach(el => {
      if (el.style.fontSize)   sizes.add(_parsePxSize(el.style.fontSize));
      if (el.style.fontFamily) fonts.add(_stripQuotes(el.style.fontFamily));
      if (el.style.color)      colors.add(_normaliseColor(el.style.color));
    });
  }
  sizes.delete(null);   // discard unparseable

  // Mixed-font fallback: pick the font of the FIRST text run inside the
  // LAST selected box. Per user spec — "first letter of the last box
  // selected" — gives the user a meaningful representative instead of
  // a stale Arial default.
  let fontName;
  if (fonts.size === 1) {
    fontName = [...fonts][0];
  } else if (fonts.size > 1) {
    const last = nodes[nodes.length - 1];
    fontName = _firstFontInHtml(last?.getAttr?.('textHtml') || '');
  }

  // Fill is a node-level attr. Take the LAST selected box's value (or
  // the only one if uniform). Decompose the rgba string into hex + alpha
  // so the colour input + slider can show meaningful initial values.
  const fills = nodes.map(n => n.getAttr('fillColor')).filter(Boolean);
  const lastFill = fills[fills.length - 1] || null;
  const fillBits = lastFill ? _decomposeRgba(lastFill) : null;

  return {
    fontSize: sizes.size === 0 ? undefined
            : sizes.size === 1 ? [...sizes][0]
            : Math.max(...sizes),     // mixed → largest, per spec
    fontName,
    color:    colors.size === 1 ? [...colors][0] : undefined,
    fillColor: fillBits?.hex,
    fillAlpha: fillBits?.alpha,
  };
}

/**
 * Split an rgba()/rgb()/#hex string into { hex:'#rrggbb', alpha:0..100 }.
 * Returns null on unparseable input.
 */
function _decomposeRgba(s) {
  if (!s) return null;
  const str = String(s).trim();
  // rgba(r, g, b, a) — alpha as 0..1
  let m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(str);
  if (m) {
    const hex = (n) => Number(n).toString(16).padStart(2, '0');
    return {
      hex:   `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`,
      alpha: m[4] != null ? Math.round(parseFloat(m[4]) * 100) : 100,
    };
  }
  // #rrggbb
  m = /^#?([0-9a-f]{6})$/i.exec(str);
  if (m) return { hex: `#${m[1]}`, alpha: 100 };
  return null;
}

/**
 * Pre-order DFS through a stored HTML fragment for the first element
 * with an explicit inline fontFamily. Returns the family stripped of
 * quotes / fallback list. Null when no element declares one.
 */
function _firstFontInHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  const visit = (el) => {
    if (el.style?.fontFamily) return _stripQuotes(el.style.fontFamily);
    for (const c of el.children || []) {
      const f = visit(c);
      if (f) return f;
    }
    return null;
  };
  return visit(tmp);
}

function _parsePxSize(s) {
  const m = /^([\d.]+)\s*px/i.exec(String(s).trim());
  return m ? Math.round(parseFloat(m[1])) : null;
}

/**
 * Read the computed font-size / family / colour at the current caret /
 * selection inside the contenteditable. Used in single-editor mode to
 * keep the toolbar dropdowns in sync as the caret moves across text
 * runs with different inline styles.
 */
function _readStyleAtCaret(editor) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return {};
  let n = sel.getRangeAt(0).startContainer;
  if (n && n.nodeType === 3) n = n.parentNode;            // text node → element
  if (!n || !(n instanceof Element)) return {};
  if (!editor.contains(n)) return {};
  const cs = window.getComputedStyle(n);
  // Fill is a node-level attr (textbox background) — read it from the
  // active editor's owning node so the toolbar's fill controls also seed.
  let fillBits = null;
  if (_activeTextEditor?.node) {
    fillBits = _decomposeRgba(_activeTextEditor.node.getAttr('fillColor'));
  }
  return {
    fontSize: Math.round(parseFloat(cs.fontSize)) || undefined,
    fontName: _stripQuotes(cs.fontFamily) || undefined,
    color:    _normaliseColor(cs.color)   || undefined,
    fillColor: fillBits?.hex,
    fillAlpha: fillBits?.alpha,
  };
}

function _stripQuotes(s) {
  return String(s).replace(/^["']|["']$/g, '').split(',')[0].trim();
}

function _normaliseColor(s) {
  // Convert "rgb(r,g,b)" → "#rrggbb" so the colour input accepts it.
  const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i.exec(String(s).trim());
  if (m) {
    const hex = (n) => Number(n).toString(16).padStart(2, '0');
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
  }
  return String(s);
}

/**
 * Apply a single style "action" to every text box in the current
 * multi-selection. Each box's HTML is mutated so ONLY the touched
 * property changes — other inline styles are preserved. Then the box
 * is re-rasterised.
 *
 * Implementation strategy
 * - For property-style actions (foreColor, fontSize, fontName) we walk
 *   the box's HTML, strip any existing inline declaration of that one
 *   property, then wrap the entire content in a span with the new
 *   value. Net effect: the touched property gets a fresh outer override
 *   that wins via CSS cascade; everything else (including unrelated
 *   inline styles on inner spans) keeps working.
 * - For toggle-style actions (bold, italic, underline, strike) we wrap
 *   the entire content in the matching tag (<b>, <i>, <u>, <s>). Toggle
 *   off isn't supported in multi-mode — applying the same action twice
 *   nests the wrapper, which the rasteriser still renders correctly
 *   (subsequent clicks are visually idempotent).
 * - For alignment we wrap content in a <div style="text-align:...">.
 */
function _multiTextApplier(action, value) {
  const sel = _transformer?.nodes() || [];
  const targets = sel.filter(n => n.getAttr?.('textHtml'));
  if (!targets.length) return;

  // fillColor is a NODE-level property (textbox background), not an
  // HTML inline style. Handle it without going through the HTML rewrite.
  if (action === 'fillColor') {
    if (!value) return;
    for (const node of targets) {
      node.setAttr('fillColor', value);
      _reflowTextBox(node).catch(() => {});
    }
    _scheduleSave();
    return;
  }

  for (const node of targets) {
    const before = node.getAttr('textHtml') || '';
    const after  = _applyActionToHtml(before, action, value);
    if (after === before) continue;
    node.setAttr('textHtml', after);
    _reflowTextBox(node).catch(() => {});
  }
  _scheduleSave();
}

/**
 * Single-editor applier — wraps execCommandApplier with a fillColor
 * branch that mutates the active text-box node directly. The editable's
 * own background is updated live so the user sees the colour as they
 * pick. _reflowTextBox runs on click-out to bake the bg into the raster.
 */
function _singleEditorApplier(action, value) {
  if (action === 'fillColor') {
    if (!_activeTextEditor || !value) return;
    _activeTextEditor.node.setAttr('fillColor', value);
    _activeTextEditor.div.style.backgroundColor = value;
    return;
  }
  execCommandApplier(action, value);
}

function _applyActionToHtml(html, action, value) {
  const root = document.createElement('div');
  root.innerHTML = html || '';

  // Property-style actions: strip the matching inline style from every
  // descendant, then wrap the whole content in a span declaring the new
  // value. The outer wrapper wins via cascade.
  const PROP_ACTIONS = {
    foreColor: 'color',
    fontName:  'fontFamily',
    fontSize:  'fontSize',
  };
  if (PROP_ACTIONS[action]) {
    const cssProp = PROP_ACTIONS[action];
    root.querySelectorAll('[style]').forEach(el => { el.style[cssProp] = ''; });
    const wrap = document.createElement('span');
    wrap.style[cssProp] = action === 'fontSize' ? `${value}px` : String(value);
    while (root.firstChild) wrap.appendChild(root.firstChild);
    root.appendChild(wrap);
    return root.innerHTML;
  }

  const TAG_ACTIONS = { bold: 'b', italic: 'i', underline: 'u', strikeThrough: 's' };
  if (TAG_ACTIONS[action]) {
    const wrap = document.createElement(TAG_ACTIONS[action]);
    while (root.firstChild) wrap.appendChild(root.firstChild);
    root.appendChild(wrap);
    return root.innerHTML;
  }

  if (action === 'justifyLeft' || action === 'justifyCenter' || action === 'justifyRight') {
    const align = action === 'justifyLeft' ? 'left'
                : action === 'justifyRight' ? 'right' : 'center';
    const wrap = document.createElement('div');
    wrap.style.textAlign = align;
    while (root.firstChild) wrap.appendChild(root.firstChild);
    root.appendChild(wrap);
    return root.innerHTML;
  }

  return html;   // unknown action — no-op
}

/**
 * Flip the transformer's resize behaviour based on what's selected AND
 * whether we're in the in-place text editor.
 *
 *   • Text box, NOT editing — full 8 anchors, free resize. Raster reflows
 *     at transformend (snap behaviour: brief stretch during drag, clean
 *     reflow on release).
 *   • Text box, EDITING       — full 8 anchors, free resize. The editor's
 *     contenteditable resizes LIVE during drag (see node.on('transform')),
 *     so the user sees the actual final layout while dragging — no
 *     stretched-then-snap flash.
 *   • Plain image             — aspect-locked uniform scale on the four
 *     corners. Skewing bitmaps looks bad.
 *
 * Rotation is disabled on text boxes (rotating rasterised text + then
 * editing a contenteditable inside a rotated bbox is tricky — defer
 * unless asked).
 */
function _configTransformerForNode(node) {
  _configTransformerForNodes(node ? [node] : []);
}

/**
 * Multi-node-aware transformer config. If every selected node is a text
 * box, free-resize 8 anchors. If anything else is in the set, downgrade
 * to aspect-locked corners (no way to mix per-node configs in one
 * transformer). Selection-only state with no nodes has no effect.
 */
function _configTransformerForNodes(nodes) {
  if (!_transformer || !nodes?.length) return;
  const allTextBoxes = nodes.every(n => n.getClassName?.() === 'Image' && n.getAttr('textHtml'));
  if (allTextBoxes) {
    // Text boxes: WIDTH ONLY. Height is computed from content — taller
    // text = taller box, automatically. Top/bottom/corner anchors are
    // off because they'd let the user fight the auto-height; the user
    // adjusts width and the box snaps to the right vertical extent.
    _transformer.keepRatio(false);
    _transformer.rotateEnabled(false);
    _transformer.enabledAnchors(['middle-left', 'middle-right']);
    return;
  }
  // Anything with an image (or mixed) — lock aspect, corners only.
  _transformer.keepRatio(true);
  _transformer.rotateEnabled(true);
  _transformer.enabledAnchors(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
}

// ─── Selected-node mutators (called from toolbar) ──────────────────────────

export function getSelected() {
  const n = _transformer?.nodes()?.[0];
  return n || null;
}

export function deleteSelected() {
  const nodes = _transformer?.nodes() || [];
  if (!nodes.length) return false;
  for (const n of nodes) n.destroy();
  _setSelection(null);
  _layer.batchDraw();
  _scheduleSave();
  return true;
}

export function updateSelectedText(patch) {
  const n = getSelected();
  if (!n || n.getClassName() !== 'Text') return;
  n.setAttrs(patch);
  _layer.batchDraw();
  _scheduleSave();
}

// ─── Per-step persistence ──────────────────────────────────────────────────

function _scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_saveToActiveStep, 120);
}

function _saveToActiveStep() {
  _saveTimer = null;
  const activeId = state.get('activeStepId');
  if (!activeId) return;
  const steps = state.get('steps') || [];
  const step  = steps.find(s => s.id === activeId);
  if (!step) return;
  const json = _stage ? _stage.toJSON() : null;
  // Only write if changed — no churn on read-only step activations.
  if (step.overlay === json) return;
  step.overlay = json;
  state.markDirty();
}

function _scheduleLoad() {
  // Defer by a frame so step.snapshot application completes before restore.
  requestAnimationFrame(_loadFromActiveStep);
}

function _onStepApplied() {
  _loadFromActiveStep();
}

function _loadFromActiveStep() {
  if (!_stage) return;
  const activeId = state.get('activeStepId');
  const steps = state.get('steps') || [];
  const step  = steps.find(s => s.id === activeId);

  // Clear current content + selection.
  _transformer.nodes([]);
  _layer.destroyChildren();

  if (!step?.overlay) { _layer.batchDraw(); return; }

  let spec;
  try {
    spec = JSON.parse(step.overlay);
  } catch { console.warn('[overlay] failed to parse step.overlay'); _layer.batchDraw(); return; }

  // Find the content layer in the parsed spec and recreate its children here
  // (the saved JSON contains its own stage + layers; we only want its user layer).
  const savedLayers = spec.children || [];
  const saved = savedLayers.find(l => l.className === 'Layer' && (l.children || []).length > 0) || savedLayers[0];
  if (!saved) { _layer.batchDraw(); return; }

  for (const childSpec of (saved.children || [])) {
    const node = _recreateNode(childSpec);
    if (node) {
      _layer.add(node);
      _attachNode(node);
    }
  }
  _layer.batchDraw();
}

function _recreateNode(spec) {
  if (!spec) return null;
  if (spec.className === 'Text')  return new Konva.Text({ ...spec.attrs, draggable: true });
  if (spec.className === 'Image') {
    const { src, textHtml, textWidth, naturalW, naturalH, fillColor, ...rest } = spec.attrs || {};
    const node = new Konva.Image({ ...rest, draggable: true });
    // Preserve any naturalW/naturalH that round-tripped through JSON; if
    // they're missing (older overlays predating the Reset feature), we
    // backfill from the re-raster / image-load below so right-click →
    // Reset works on existing projects too.
    if (Number.isFinite(naturalW)) node.setAttr('naturalW', naturalW);
    if (Number.isFinite(naturalH)) node.setAttr('naturalH', naturalH);
    if (fillColor)                 node.setAttr('fillColor', fillColor);
    if (textHtml) {
      // Rich-text box — re-rasterize from stored HTML.
      node.setAttr('textHtml',  textHtml);
      node.setAttr('textWidth', textWidth);
      _htmlToCanvas(textHtml, {
        width:  textWidth || 400,
        bgColor: fillColor || 'transparent',
      }).then(canvas => {
        if (canvas) {
          node.image(canvas);
          // Don't clobber width/height (the user may have resized) — but
          // backfill naturalW/H from this fresh raster if they weren't saved.
          if (!Number.isFinite(node.getAttr('naturalW'))) node.setAttr('naturalW', canvas.width);
          if (!Number.isFinite(node.getAttr('naturalH'))) node.setAttr('naturalH', canvas.height);
          _layer.batchDraw();
        }
      }).catch(e => console.warn('[overlay] text rasterize failed', e));
    } else if (src) {
      node.setAttr('src', src);
      _loadImage(src).then(img => {
        node.image(img);
        if (!Number.isFinite(node.getAttr('naturalW'))) node.setAttr('naturalW', img.width);
        if (!Number.isFinite(node.getAttr('naturalH'))) node.setAttr('naturalH', img.height);
        _layer.batchDraw();
      }).catch(e => console.warn('[overlay] image load failed', e));
    }
    return node;
  }
  return null;
}

// ─── Video-export compositing (used by Phase 2b) ───────────────────────────

/**
 * Rasterize the current overlay to a canvas sized to fit the given width
 * (or height) while preserving aspect. Returns null if there's nothing on
 * the overlay. Does not mutate the live stage.
 *
 * @param {{width?:number, height?:number}} [opts]
 */
export function rasterizeOverlay(opts = {}) {
  if (!_stage || _layer.getChildren().length === 0) return null;
  const sw = _stage.width();
  const sh = _stage.height();
  if (!sw || !sh) return null;
  const ratio = opts.width  ? opts.width  / sw
              : opts.height ? opts.height / sh
              : 1;
  return _layer.toCanvas({ pixelRatio: ratio });
}

// ─── Internals ─────────────────────────────────────────────────────────────

function _onKeyDown(e) {
  if (!_editing) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    // Skip whenever ANY editable element has focus — INPUT, TEXTAREA, OR
    // any contenteditable (our in-place text editor mounts a contenteditable
    // <div>, so without this check Backspace would destroy the whole node
    // mid-edit and stop further typing dead).
    const ae = document.activeElement;
    if (ae && (['INPUT','TEXTAREA'].includes(ae.tagName) || ae.isContentEditable)) return;
    // Don't interfere while the in-place editor is open even if focus
    // briefly slipped (e.g. during selection grab).
    if (_activeTextEditor) return;
    if (deleteSelected()) e.preventDefault();
  }
}

function _editText(node) {
  // Minimal inline text editor — a floating <textarea> over the node.
  const pos  = node.getAbsolutePosition();
  const area = document.createElement('textarea');
  area.value = node.text();
  area.style.cssText = [
    'position:absolute',
    `left:${pos.x}px`, `top:${pos.y}px`,
    `width:${Math.max(node.width(), 120)}px`,
    `font-size:${node.fontSize()}px`,
    `font-family:${node.fontFamily()}`,
    `color:${node.fill()}`,
    'background:rgba(0,0,0,0.6)',
    'border:1px solid #f59e0b',
    'padding:4px',
    'z-index:9999',
    'resize:both',
  ].join(';');
  _container.appendChild(area);
  area.focus();
  area.select();

  const commit = () => {
    node.text(area.value);
    area.remove();
    _layer.batchDraw();
    _scheduleSave();
  };
  area.addEventListener('blur', commit);
  area.addEventListener('keydown', e => {
    if (e.key === 'Escape') { area.remove(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { commit(); }
  });
}

function _fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function _loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Rasterize a chunk of HTML to an HTMLCanvasElement via an inline SVG
 * `<foreignObject>`. Inline styles only — nothing from the host page leaks
 * in, so the rendering is deterministic and safe to export.
 *
 * @param {string} html  — HTML markup for the text box body
 * @param {{width?:number, height?:number, padding?:number, fontFamily?:string, fontSize?:number, color?:string}} [opts]
 *   - height: when supplied, the canvas is exactly this tall and content
 *     that overflows is clipped (overflow:hidden). Without it, the
 *     canvas auto-fits to whatever height the content needs at `width`.
 * @returns {Promise<HTMLCanvasElement|null>}
 */
/**
 * Whitelist sanitiser for HTML produced by the in-place text editor —
 * runs at COPY time, so anything pasted between SBS textboxes is
 * guaranteed to be safe for the SVG-foreignObject rasteriser.
 *
 * Allowed tags  : div, p, br, span, b, i, u, s, strong, em
 * Allowed styles: color, background-color, font-size, font-family,
 *                 font-weight, font-style, text-decoration, text-align
 *
 * Everything else is unwrapped (children promoted) or stripped.
 * Class / id / data-* attributes are dropped. Original visual look is
 * preserved for the formatting we actually support; cosmetic loss is
 * acceptable for things we can't render anyway.
 */
function _sanitiseTextboxHtml(html) {
  const ALLOWED_TAGS = new Set(['DIV', 'P', 'BR', 'SPAN', 'B', 'I', 'U', 'S', 'STRONG', 'EM']);
  const ALLOWED_STYLES = [
    'color', 'background-color',
    'font-size', 'font-family', 'font-weight', 'font-style',
    'text-decoration', 'text-align',
  ];

  // Strip clipboard wrapper artefacts before parsing. Chrome and Word
  // routinely wrap clipboard payloads in <!--StartFragment-->,
  // <meta charset='utf-8'>, <html><body>, doctypes, etc. The SVG-
  // foreignObject rasteriser falls over on those — leaving them in
  // was a major cause of "paste shows up live but doesn't apply".
  const cleaned = String(html || '')
    .replace(/<!--[\s\S]*?-->/g,         '')   // HTML comments
    .replace(/<\?[\s\S]*?\?>/g,           '')   // <?xml ...?> processing instructions
    .replace(/<!doctype[^>]*>/gi,         '')   // doctype
    .replace(/<meta\b[^>]*>/gi,           '')   // <meta charset=...>
    .replace(/<\/?(html|body|head)\b[^>]*>/gi, '');

  const tmp = document.createElement('div');
  tmp.innerHTML = cleaned;

  function clean(node) {
    if (node.nodeType === 3) return;       // text node — keep as-is
    if (node.nodeType !== 1) { node.remove(); return; }

    if (!ALLOWED_TAGS.has(node.tagName)) {
      // Unwrap: promote children, drop the wrapper.
      const parent = node.parentNode;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      parent.removeChild(node);
      return;
    }

    // Stash allowed inline styles, then strip every attribute and
    // re-apply just the kept styles. Removes class, id, data-*, and
    // any unsafe inline declarations in one pass.
    const keep = {};
    for (const prop of ALLOWED_STYLES) {
      const v = node.style?.getPropertyValue(prop);
      if (v) keep[prop] = v;
    }
    for (let i = node.attributes.length - 1; i >= 0; i--) {
      node.removeAttribute(node.attributes[i].name);
    }
    if (Object.keys(keep).length) {
      const styleStr = Object.entries(keep).map(([k, v]) => `${k}:${v}`).join(';');
      node.setAttribute('style', styleStr);
    }

    // Recurse into children (snapshot first — clean() may remove nodes).
    Array.from(node.childNodes).forEach(clean);
  }
  Array.from(tmp.childNodes).forEach(clean);
  return tmp.innerHTML;
}

async function _htmlToCanvas(html, opts = {}) {
  const {
    width      = 400,
    height,                          // explicit height → fixed canvas, content clips
    padding    = 8,
    fontFamily = 'Arial',
    fontSize   = 16,
    color      = '#ffffff',
    bgColor    = 'transparent',      // textbox fill — rgba string preferred
  } = opts;

  let h;
  if (typeof height === 'number' && Number.isFinite(height)) {
    h = Math.max(1, Math.round(height));
  } else {
    // Auto-fit height by measuring an off-screen div at the same width.
    const host = document.createElement('div');
    host.style.cssText = [
      'position:absolute', 'left:-99999px', 'top:0',
      `width:${width}px`,
      `padding:${padding}px`,
      `color:${color}`,
      `font-family:${fontFamily}`,
      `font-size:${fontSize}px`,
      'box-sizing:border-box',
      'white-space:pre-wrap',
      'word-wrap:break-word',
      'line-height:1.2',
    ].join(';');
    host.innerHTML = html;
    document.body.appendChild(host);
    h = Math.max(1, Math.ceil(host.getBoundingClientRect().height));
    document.body.removeChild(host);
  }

  // 2. Wrap the same markup inside an SVG foreignObject at the measured /
  //    requested size. overflow:hidden lets the box clip content when the
  //    user drags height shorter than what the text would need — true
  //    text-frame behaviour rather than always growing to fit.
  const bodyStyle = [
    `width:${width}px`,
    `height:${h}px`,
    `padding:${padding}px`,
    `color:${color}`,
    `font-family:${fontFamily}`,
    `font-size:${fontSize}px`,
    `background-color:${bgColor}`,
    'box-sizing:border-box',
    'white-space:pre-wrap',
    'word-wrap:break-word',
    'line-height:1.2',
    'overflow:hidden',
  ].join(';');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}">` +
      `<foreignObject width="${width}" height="${h}">` +
        `<div xmlns="http://www.w3.org/1999/xhtml" style="${bodyStyle}">${html}</div>` +
      `</foreignObject>` +
    `</svg>`;
  const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

  let img;
  try { img = await _loadImage(dataUrl); }
  catch (e) { console.warn('[overlay] html rasterize load failed', e); return null; }

  const canvas = document.createElement('canvas');
  canvas.width  = width;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, h);
  return canvas;
}
