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
import { mountTextToolbar, unmountTextToolbar, execCommandApplier, setToolbarValues, wasColorPickedRecently, setStyleDropdown, setStyleLocked } from '../ui/text-toolbar.js';
import { getTextToolbarSlot }  from '../ui/overlay-toolbar.js';
import * as textEngine from './text-engine.js';
import { getStyleTemplate, listStyleTemplates } from './style-templates.js';
import { registerLayer, getLayerSelection, persistNodeIfHeader } from './cross-layer.js';
import * as editSession from './edit-session.js';   // P7-A: in-session local undo + commit-time main-undo entry

let _stage       = null;   // Konva.Stage
let _layer       = null;   // Konva.Layer — holds all user content
let _uiLayer     = null;   // Konva.Layer — transformer, editing aids
let _transformer = null;
let _container   = null;
let _editing     = false;
let _resizeObs   = null;
let _saveTimer   = null;
let _activeStepUnwatch = null;
let _loadToken   = 0;     // bumped on every step-change load; older loads abort if outdated

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
  // Name the overlay content layer explicitly so _loadFromActiveStep can
  // pick the right layer back out of step.overlay JSON (which serialises
  // ALL layers — content + UI + header — and a naive "first layer with
  // children" search can mistakenly pick the UI or header layer).
  _layer   = new Konva.Layer({ name: 'sbs-overlay-content' });
  _uiLayer = new Konva.Layer({ name: 'sbs-overlay-ui' });
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

  // Right-click on empty viewport → paste-only context menu (Paste / Paste
  // in place / Delete-disabled). Lets the user paste a copied textbox or
  // image without needing an existing node to right-click on. Selection
  // and "Duplicate" only make sense on a node, so they're omitted here.
  _stage.on('contextmenu', (e) => {
    if (e.target !== _stage) return;          // node-level handler runs instead
    if (!_editing) return;                     // overlay editing must be on
    e.evt?.preventDefault?.();
    const ev = e.evt;
    _showEmptyViewportContextMenu(ev?.clientX ?? 0, ev?.clientY ?? 0);
  });

  // Keyboard: Delete removes the selected node (only when editing).
  window.addEventListener('keydown', _onKeyDown);

  // Resize stage to match viewport surface.
  _syncSize();
  _resizeObs = new ResizeObserver(_syncSize);
  _resizeObs.observe(_container);

  // Restore the currently-active step's overlay on load / step change.
  // CRITICAL ORDER: flush any pending save against the OUTGOING step
  // FIRST (synchronous), then load the new step. Without the flush, a
  // 120-ms-debounced edit can race past activeStepId — the timer fires
  // reading the NEW id and either loses the edit or writes the wrong
  // step. We capture _pendingSaveStepId at schedule time precisely so
  // this flush can target the correct (outgoing) step regardless of
  // when it actually fires.
  state.on('change:activeStepId', _flushPendingSave);
  state.on('change:activeStepId', _scheduleLoad);
  state.on('step:applied', _onStepApplied);

  // Live style-template propagation. When a template changes, every
  // text box on the ACTIVE step that's bound to it re-rasterises.
  // Inactive steps pick up the change next time they load (every
  // text-box reload routes through _reflowTextBox, which reads the
  // current template values).
  state.on('styleTemplate:updated', _onStyleTemplateUpdated);
  state.on('styleTemplate:removed', _onStyleTemplateUpdated);   // also re-rasterise when a template is deleted

  // Register with the cross-layer registry so header.js can ask for
  // the current overlay selection (for combined multi-drag) and ask
  // us to persist after a cross-layer drag commits — see systems/
  // cross-layer.js. No-op when called before init.
  registerLayer('overlay', {
    getSelection: () => _transformer?.nodes() || [],
    scheduleSave: () => _scheduleSave(),
  });
}

function _onStyleTemplateUpdated(payload) {
  if (!_layer) return;
  const id = payload?.id;
  // Re-rasterise every text box on the active layer whose styleId
  // matches (or, on remove, whose styleId is now stale).
  for (const child of _layer.getChildren()) {
    if (child.getClassName?.() !== 'Image') continue;
    if (!child.getAttr('textHtml')) continue;
    const childStyleId = child.getAttr('styleId');
    if (id && childStyleId !== id) continue;
    if (!id && !childStyleId) continue;
    _reflowTextBox(child).catch(() => {});
  }
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
  // Mirror to state so non-overlay systems (header.js) can subscribe
  // and turn their own interaction on/off in lockstep — see P1 of the
  // header workstream. _editing remains the source of truth for code
  // inside this module; state.overlayEditing is purely a broadcast.
  state.setState({ overlayEditing: _editing });
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
  if (!canvas.width || !canvas.height) {
    console.warn('[overlay] addTextBox: 0-sized canvas — aborting', canvas.width, canvas.height);
    return null;
  }

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

let _activeTextEditor = null;   // { node, div, onDocMouseDown, transformerWasVisible, ctx }

/**
 * Default editor controller for OVERLAY textboxes — re-raster via
 * _reflowTextBox, persist via _scheduleSave, style via setAttr('styleId').
 * header.js builds its own controller (different layer, different
 * persistence path, no per-step save). The controller is the only
 * surface that varies between contexts; the editor itself is layer-
 * agnostic — see enterTextEditor below.
 */
function _overlayEditorCtx(node) {
  return {
    transformer: _transformer,
    configureTransformer: () => _configTransformerForNode(node),
    reflow:        () => _reflowTextBox(node),
    onCommit:      async (html) => {
      const prev = node.getAttr('textHtml');
      node.setAttr('textHtml', html);
      const ok = await _reflowTextBox(node);
      if (!ok) {
        console.warn('[overlay] rasterise failed on click-out — reverting to previous text.');
        node.setAttr('textHtml', prev);
      }
    },
    onSave:        _scheduleSave,
    getStyleId:    () => node.getAttr('styleId') || '',
    setStyleId:    (id) => {
      // P7-A: snapshot before style binding changes so the toolbar
      // dropdown is undoable inside the same session as B/I/U/etc.
      editSession.record();
      node.setAttr('styleId', id || null);
      _reflowTextBox(node).catch(() => {});
      _scheduleSave();
    },
  };
}

/**
 * Public entry point for opening the in-place text editor on any
 * Konva.Image-with-textHtml node (overlay textbox OR header textbox).
 * Caller passes a `ctx` controller object that abstracts the
 * layer-specific bits (transformer, persistence, re-raster, style
 * binding); when omitted, the overlay default is used.
 *
 * The editor ITSELF is identical in both contexts — same div, same
 * toolbar, same paste sanitiser, same style engine. Only the side-
 * effects vary, which is what the controller captures.
 */
export function enterTextEditor(node, ctx) {
  _enterTextEdit(node, ctx);
}

/** Open the in-place editor on a text-box node. */
function _enterTextEdit(node, ctxOverride) {
  if (_activeTextEditor) _exitTextEdit();
  const ctx = ctxOverride || _overlayEditorCtx(node);
  // Derive DOM container from the node's stage rather than overlay's
  // module-local _container — this lets header.js reuse the editor
  // without us hard-coding the overlay stage's div.
  const stage = node.getLayer()?.getStage();
  const containerEl = stage?.container() || _container;
  const containerRect = containerEl.getBoundingClientRect();
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
  // (selection-only state has no anchors). The controller knows which
  // transformer to reach for — overlay's, header's, etc.
  ctx.configureTransformer?.();
  // Redraw the layers the transformer + node live in. node.getLayer() is
  // the content layer; transformer might be on a different one (overlay
  // has _uiLayer, header keeps both on _layer). Drawing both is cheap
  // and avoids a stale frame on whichever the transformer sits in.
  const nodeLayer  = node.getLayer();
  const trLayer    = ctx.transformer?.getLayer?.();
  nodeLayer?.batchDraw();
  if (trLayer && trLayer !== nodeLayer) trLayer.batchDraw();

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
    // Swallow the click that fires when the OS colour-picker dialog
    // closes — without this, every "pick colour" gesture also exits
    // the editor and discards subsequent style edits.
    if (wasColorPickedRecently()) return;
    _exitTextEdit();
  };
  // Defer one tick so the same dblclick that opened us doesn't immediately close us.
  setTimeout(() => document.addEventListener('mousedown', onDocMouseDown, true), 0);

  // Esc cancels (no save); Enter inserts a newline (browser default).
  // Ctrl+Z / Ctrl+Y route to the local edit-session stack first — if a
  // toolbar / engine op was the last thing, undoLocal() pops it and
  // we preventDefault. If the local stack is empty (only typing has
  // happened since the last toolbar op), we DON'T preventDefault so
  // the browser's native contenteditable undo handles the keystrokes.
  // This gives the user fine-grained Ctrl-Z inside the editor without
  // duplicating the browser's typing-undo machinery.
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      _exitTextEdit({ discard: true });
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key === 'z') {
      if (editSession.canUndoLocal()) {
        e.preventDefault();
        e.stopPropagation();
        editSession.undoLocal();
        // Toolbar mirrors the post-undo caret styling.
        setToolbarValues(_readStyleAtCaret(div));
      }
      return;
    }
    if (mod && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
      if (editSession.canRedoLocal()) {
        e.preventDefault();
        e.stopPropagation();
        editSession.redoLocal();
        setToolbarValues(_readStyleAtCaret(div));
      }
      return;
    }
  };
  div.addEventListener('keydown', onKeyDown);

  // No custom COPY handler. The browser's native copy from a
  // contenteditable serialises the selection with COMPUTED styles
  // resolved onto the cloned spans — exactly what we want for paste
  // round-trips between our textboxes. A custom onCopy that used
  // cloneContents() lost those computed styles (cloneContents only
  // captures literal inline styles on the selected nodes, not
  // ancestor-inherited ones), which is why styled paste between
  // textboxes was always coming through plain.

  // Sanitise on PASTE only. Catches:
  //   • clipboard wrapper artefacts (<meta>, <!--StartFragment-->,
  //     <!doctype>, <html><body>) that break SVG-foreignObject
  //   • disallowed tags / attrs / inline images / scripts
  //   • legacy <font> tags promoted to inline <span style>
  //   • leading / trailing block padding that would force extra empty
  //     lines around the inserted content
  // Insertion goes through the Selection API, not execCommand —
  // execCommand('insertHTML') in some Chromium versions silently strips
  // inline styles on the inserted fragment. Manual insertNode preserves
  // them verbatim.
  const onPaste = (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const html = cd.getData('text/html');
    const text = cd.getData('text/plain');
    if (html) {
      e.preventDefault();
      const clean = _trimPasteBlocks(_sanitiseTextboxHtml(html));
      _insertHtmlAtCaret(div, clean);
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
  if (toolbarHost) {
    mountTextToolbar(toolbarHost, _singleEditorApplier, div);
    // Style dropdown — only mount when the controller actually supports
    // style-template binding for this context. Headers don't (yet — P4),
    // so we pass null to remove the dropdown rather than show a no-op
    // control. Overlay textboxes always provide getStyleId/setStyleId.
    if (ctx.setStyleId) {
      const initialStyleId = ctx.getStyleId?.() || '';
      setStyleDropdown(listStyleTemplates(), initialStyleId, (newId) => {
        ctx.setStyleId(newId);
        setStyleLocked(!!newId);
      });
      setStyleLocked(!!initialStyleId);
    } else {
      setStyleDropdown(null);    // explicitly hide
      setStyleLocked(false);
    }
  }
  // Sync the dropdowns to whatever style is at the caret. Re-fires on
  // every selection change so moving the caret across mixed-style runs
  // updates the toolbar live.
  const onSelectionChange = () => {
    if (!_activeTextEditor || !div.contains(window.getSelection()?.anchorNode || null)) return;
    setToolbarValues(_readStyleAtCaret(div));
  };
  document.addEventListener('selectionchange', onSelectionChange);
  onSelectionChange();   // initial sync

  _activeTextEditor = { node, div, onDocMouseDown, onKeyDown, onPaste, prevOpacity, onSelectionChange, ctx };

  // P7-A: open an edit session so toolbar / engine ops can be undone
  // locally (Ctrl-Z inside the editor) and the WHOLE session collapses
  // into a SINGLE main-undo entry on commit. Snapshot captures editor
  // HTML + node attrs we care about (fillColor for textbox bg, styleId
  // for template binding). restoreLocal works on the LIVE editor div;
  // restoreCommitted works on the BAKED Konva.Image after click-out.
  editSession.begin({
    label: 'Edit text',
    snapshot: () => ({
      html:      div.innerHTML,
      fillColor: node.getAttr('fillColor') ?? null,
      styleId:   node.getAttr('styleId')   ?? null,
    }),
    restoreLocal: (snap) => {
      // Editor still mounted — write to the contenteditable + node attrs.
      // The visible textbox stays opacity:0 so the editor is what the
      // user sees; restoring node attrs is for the on-commit raster.
      div.innerHTML = snap.html;
      node.setAttr('fillColor', snap.fillColor);
      node.setAttr('styleId',   snap.styleId);
      div.style.backgroundColor = snap.fillColor || 'rgba(15,23,42,0.55)';
    },
    restoreCommitted: async (snap) => {
      // Editor already torn down — operate on the Konva.Image directly.
      // Skip if the node was destroyed (step change, deletion). Returning
      // false from undoManager's command tells it to drop this entry from
      // the redo path rather than spin on a dead reference.
      if (!node || node.isDestroyed?.()) return false;
      node.setAttr('textHtml',  snap.html);
      node.setAttr('fillColor', snap.fillColor);
      node.setAttr('styleId',   snap.styleId);
      await _reflowTextBox(node);
      _scheduleSave();
    },
  });
}

/** Close the in-place editor, re-rasterise on the way out (unless discard). */
async function _exitTextEdit(opts = {}) {
  if (!_activeTextEditor) return;
  const { node, div, onDocMouseDown, onKeyDown, onPaste, prevOpacity, onSelectionChange, ctx } = _activeTextEditor;
  document.removeEventListener('mousedown', onDocMouseDown, true);
  if (onSelectionChange) document.removeEventListener('selectionchange', onSelectionChange);
  div.removeEventListener('keydown', onKeyDown);
  if (onPaste) div.removeEventListener('paste', onPaste);
  unmountTextToolbar();

  const html = div.innerHTML;

  if (!opts.discard && html) {
    // Commit goes through the controller so each context decides how to
    // persist + re-raster (overlay: set textHtml attr + _reflowTextBox;
    // header: updateHeaderItem with new textHtml). Awaited so the new
    // raster is in place BEFORE we remove the editor — kills the
    // "nothing → raster" flicker on click-out.
    try { await ctx.onCommit?.(html); }
    catch (e) { console.warn('[text-editor] commit failed', e); }
  }

  // P7-A: close the edit session.
  //   discard → restoreLocal(seed) reverts node attrs (editor div is
  //             still mounted at this point, so the snapshot is valid).
  //   commit  → push ONE main-undo entry capturing the seed → final diff,
  //             so the user can Ctrl-Z this whole edit later (outside
  //             the editor) without seeing every B/I/U press individually.
  editSession.end({ commit: !opts.discard });

  // Now swap visibility back. The new raster is in place, so removing
  // the editor reveals it instantly without an empty frame.
  node.opacity(typeof prevOpacity === 'number' ? prevOpacity : 1);
  div.remove();
  _activeTextEditor = null;
  ctx.configureTransformer?.();
  const nodeLayer = node.getLayer();
  const trLayer   = ctx.transformer?.getLayer?.();
  nodeLayer?.batchDraw();
  if (trLayer && trLayer !== nodeLayer) trLayer.batchDraw();
  ctx.onSave?.();
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
  // Defensive width: node.width() can return undefined / NaN if the node
  // was just constructed without explicit width (e.g. legacy save). NaN
  // through Math.round → NaN → canvas.width = NaN → canvas coerces to
  // 0, which Konva later tries to drawImage and throws "0 width or
  // height". Guard with a 400px fallback.
  const rawW = Math.round(node.width());
  const w = Number.isFinite(rawW) && rawW > 0 ? Math.max(20, rawW) : 400;
  const styleId = node.getAttr('styleId') || null;
  const tpl = styleId ? getStyleTemplate(styleId) : null;

  // Style-template-bound boxes ignore their inline styling and inherit
  // EVERYTHING from the template (per spec: assigning a style overrides
  // any per-character formatting). Alignment is the only thing that
  // survives — strip alignment from the inline styles (we keep the
  // <div text-align:...> wrappers because alignment IS the box-level
  // override).
  let renderHtml = html;
  let opts = { width: w, bgColor: node.getAttr('fillColor') || 'transparent' };
  if (tpl) {
    renderHtml = _stripInlineStylingExceptAlign(html);
    opts = {
      ...opts,
      fontFamily:     tpl.fontFamily     || 'Arial',
      fontSize:       tpl.fontSize       || 16,
      color:          tpl.color          || '#ffffff',
      fontWeight:     tpl.fontWeight     || 'normal',
      fontStyle:      tpl.fontStyle      || 'normal',
      textDecoration: tpl.textDecoration || '',
      bgColor:        tpl.fillColor || opts.bgColor,
    };
  }

  // Auto-height: do NOT pass `height` to the rasteriser. The canvas
  // ends up exactly as tall as the wrapped text needs at this width.
  // Box grows/shrinks vertically as the content does — true text-frame
  // behaviour without a manual height handle for the user to fight.
  const canvas = await _htmlToCanvas(renderHtml, opts);
  if (!canvas) return false;
  // Reject canvases with zero dim — drawImage on a 0×0 source throws
  // synchronously inside Konva's _sceneFunc and corrupts subsequent
  // draws on the layer. Better to skip than to poison the layer.
  if (!canvas.width || !canvas.height) {
    console.warn('[overlay] _reflowTextBox: 0-sized canvas, skipping image swap', { w, opts, html: html.slice(0, 80) });
    return false;
  }
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

  // Multi-node drag — now CROSS-LAYER. Konva's per-node draggable only
  // moves the grabbed node; siblings (in the same OR the header layer)
  // stay put. We stash starting positions across both layers' selections
  // on dragstart, apply the grabbed-node's delta to every sibling on
  // dragmove, and persist any header siblings on dragend (the grabbed
  // node + overlay siblings are in step.overlay JSON, captured by the
  // dragend handler below; header siblings need updateHeaderItem each).
  let _multiDragStarts = null;
  node.on('dragstart', () => {
    const own  = _transformer?.nodes() || [];
    const peer = getLayerSelection('header');
    const sel  = [...own, ...peer];
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
    // Both layers may need a redraw — header peer nodes live on a
    // different Konva.Layer and won't auto-redraw from _layer.batchDraw().
    _layer.batchDraw();
    _multiDragStarts.peerLayer ??= [..._multiDragStarts.keys()].find(n => n !== node && n.getLayer && n.getLayer() !== _layer)?.getLayer();
    _multiDragStarts.peerLayer?.batchDraw?.();
  });
  node.on('dragend', () => {
    if (_multiDragStarts) {
      // Persist any header siblings — overlay nodes are saved in one
      // shot via _scheduleSave below (their positions ride along in
      // _stage.toJSON()).
      for (const n of _multiDragStarts.keys()) {
        if (n !== node) persistNodeIfHeader(n);
      }
    }
    _multiDragStarts = null;
  });

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

// ─── Overlay clipboard (in-memory, persists across step changes) ───────────
//
// A simple module-scoped buffer. Holds an array of node specs (one per
// copied node) plus the position they were copied FROM, so paste-in-place
// can drop them at the original coordinates regardless of which step is
// active when the paste happens.
//
// Format mirrors the spec shape used by _recreateNode:
//   { className, attrs }
// ATTR LIST: x, y, width, height, src, textHtml, textWidth, naturalW,
//            naturalH, fillColor, styleId, scaleX, scaleY, rotation
// (image is intentionally NOT serialised — Konva can't round-trip an
//  HTMLImageElement; we re-load from `src` or re-rasterise from textHtml.)
let _overlayClipboard = null;

function _serializeNode(node) {
  if (!node) return null;
  const a = node.attrs || {};
  const out = {
    className: node.getClassName(),
    attrs: {
      x:        a.x ?? 0,
      y:        a.y ?? 0,
      width:    a.width,
      height:   a.height,
      scaleX:   a.scaleX ?? 1,
      scaleY:   a.scaleY ?? 1,
      rotation: a.rotation ?? 0,
    },
  };
  // Inline payload — only the fields _recreateNode looks at.
  for (const k of ['src', 'textHtml', 'textWidth', 'naturalW', 'naturalH', 'fillColor', 'styleId']) {
    if (a[k] != null) out.attrs[k] = a[k];
  }
  return out;
}

/**
 * Right-click → Copy. Snapshots every selected overlay node into the
 * module clipboard along with their captured x/y for paste-in-place.
 */
function _copyToOverlayClipboard() {
  const sel = _transformer?.nodes() || [];
  if (!sel.length) return false;
  _overlayClipboard = sel.map(n => ({
    spec:        _serializeNode(n),
    capturedAt:  { x: n.x() ?? 0, y: n.y() ?? 0 },
  })).filter(e => e.spec);
  return _overlayClipboard.length > 0;
}

/**
 * Paste from clipboard. With `inPlace:false` the new nodes drop near
 * their original position offset slightly so duplicates don't perfectly
 * overlap; with `inPlace:true` they land exactly where the original
 * was when copied — even across steps, since we stored the captured
 * x/y per-node.
 *
 * Async because _recreateNode now awaits the textbox raster (the load
 * path needed it to avoid a 0×0 race). Paste / Duplicate callers can
 * fire-and-forget — we return a Promise<boolean> for completeness.
 */
async function _pasteFromOverlayClipboard(opts = {}) {
  if (!_overlayClipboard?.length) return false;
  const { inPlace = false, offset = 20 } = opts;
  const newNodes = [];
  for (const entry of _overlayClipboard) {
    const node = await _recreateNode(entry.spec);
    if (!node) continue;
    if (inPlace) {
      node.x(entry.capturedAt.x);
      node.y(entry.capturedAt.y);
    } else {
      node.x((entry.capturedAt.x ?? 0) + offset);
      node.y((entry.capturedAt.y ?? 0) + offset);
    }
    _layer.add(node);
    _attachNode(node);
    newNodes.push(node);
  }
  if (!newNodes.length) return false;

  // Replace selection with the freshly-pasted nodes.
  _transformer.nodes(newNodes);
  _configTransformerForNodes(newNodes);
  _layer.batchDraw();
  _uiLayer.batchDraw();
  _scheduleSave();
  return true;
}

/** Duplicate = copy current selection then immediately paste with a small offset. */
async function _duplicateSelected() {
  if (!_copyToOverlayClipboard()) return false;
  return _pasteFromOverlayClipboard({ inPlace: false, offset: 20 });
}

/**
 * Right-click on the empty viewport — only paste actions make sense
 * here (no selection to copy, no node to duplicate). Disabled when
 * the clipboard is empty so the menu still shows the user what's
 * available, just greyed out.
 */
function _showEmptyViewportContextMenu(x, y) {
  const hasClipboard = !!_overlayClipboard?.length;
  showContextMenu([
    { label: 'Paste',          disabled: !hasClipboard, action: () => _pasteFromOverlayClipboard({ inPlace: false }) },
    { label: 'Paste in place', disabled: !hasClipboard, action: () => _pasteFromOverlayClipboard({ inPlace: true })  },
  ], x, y);
}

function _showOverlayContextMenu(node, x, y) {
  const sel = _transformer?.nodes() || [node];
  const hasClipboard = !!_overlayClipboard?.length;
  showContextMenu([
    { label: 'Duplicate',       action: _duplicateSelected },
    { label: 'Copy',            action: _copyToOverlayClipboard },
    { label: 'Paste',           disabled: !hasClipboard, action: () => _pasteFromOverlayClipboard({ inPlace: false }) },
    { label: 'Paste in place',  disabled: !hasClipboard, action: () => _pasteFromOverlayClipboard({ inPlace: true })  },
    { separator: true },
    { label:  'Delete',
      action: () => {
        for (const n of sel) n.destroy();
        _setSelection(null);
        _layer.batchDraw();
        _scheduleSave();
      },
    },
  ], x, y);
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
    // Style dropdown — multi-mode assignment writes the same styleId
    // to every selected text box. Show "(no style)" when the selection
    // mixes bound + unbound, or different bound IDs.
    const ids = new Set(textBoxes.map(n => n.getAttr('styleId') || ''));
    const uniformId = ids.size === 1 ? [...ids][0] : '';
    setStyleDropdown(listStyleTemplates(), uniformId, (newId) => {
      for (const n of textBoxes) {
        n.setAttr('styleId', newId || null);
        _reflowTextBox(n).catch(() => {});
      }
      setStyleLocked(!!newId);
      _scheduleSave();
    });
    setStyleLocked(uniformId ? true : false);
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
 * Single-editor applier — intercepts the node-level `fillColor` action
 * (textbox background, not text styling), routes everything else to
 * execCommandApplier (which now drives the unified text-engine over
 * the live selection inside the contenteditable).
 *
 * fillColor is intercepted here because it modifies the Konva node's
 * own attribute and the live editor's CSS background — the engine
 * doesn't touch either.
 */
function _singleEditorApplier(action, value) {
  // P7-A: snapshot the pre-op state so Ctrl-Z inside the editor can
  // step back through toolbar / engine ops one at a time. record() is
  // a no-op when no session is active, so it's safe to call
  // unconditionally here.
  editSession.record();
  if (action === 'fillColor') {
    if (!_activeTextEditor || !value) return;
    _activeTextEditor.node.setAttr('fillColor', value);
    _activeTextEditor.div.style.backgroundColor = value;
    return;
  }
  execCommandApplier(action, value);
}

/**
 * Mass-mode applier: iterate selected text boxes, run the unified
 * text-engine over each box's stored HTML with no Range (so it
 * touches every text run). Then re-rasterise. fillColor is a
 * node-level attr (not inline style) so it short-circuits ahead
 * of the engine call.
 */
function _multiTextApplier(action, value) {
  const sel = _transformer?.nodes() || [];
  const targets = sel.filter(n => n.getAttr?.('textHtml'));
  if (!targets.length) return;

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
    const root   = document.createElement('div');
    root.innerHTML = before;
    textEngine.apply(root, null, action, value);
    const after = root.innerHTML;
    if (after === before) continue;
    node.setAttr('textHtml', after);
    _reflowTextBox(node).catch(() => {});
  }
  _scheduleSave();
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
//
// Edits debounce through _scheduleSave (120 ms) so rapid changes coalesce.
// We capture the step id AT SCHEDULE TIME (`_pendingSaveStepId`) — the
// timer fire might happen after the user has already switched to a
// different step, and writing to `state.get('activeStepId')` at that
// point would land the edit on the wrong step (or on a step whose
// overlay has just been cleared by the load path).
//
// _flushPendingSave runs synchronously on `change:activeStepId` BEFORE
// the load handler, so the OUTGOING step's pending edits are committed
// against the still-loaded _stage content. After flush, the load can
// safely destroy the layer and reinstate the new step.

let _pendingSaveStepId = null;

function _scheduleSave() {
  if (!_pendingSaveStepId) _pendingSaveStepId = state.get('activeStepId');
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_flushPendingSave, 120);
}

function _flushPendingSave() {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  const stepId = _pendingSaveStepId;
  _pendingSaveStepId = null;
  if (stepId) _writeOverlayToStep(stepId);
}

function _writeOverlayToStep(stepId) {
  if (!_stage || !stepId) return;
  const steps = state.get('steps') || [];
  const step  = steps.find(s => s.id === stepId);
  if (!step) return;
  const json = _serialiseStageJson();
  if (step.overlay === json) return;
  step.overlay = json;
  state.markDirty();
}

/**
 * Konva.Stage.toJSON serialises every node attr — including
 * Konva.Image's `image`, which is an HTMLCanvasElement we built via
 * _htmlToCanvas. JSON.stringify(canvas) returns "{}" (canvases have no
 * enumerable own properties), so the saved spec carries `image: {}`.
 *
 * On restore, `new Konva.Image({ image: {} })` accepts the empty object
 * and the next batchDraw passes it to ctx.drawImage — which throws
 * "image argument is a canvas with width or height of 0" and corrupts
 * subsequent draws on the layer ("works once then stops").
 *
 * The image is recoverable from `textHtml` (rasterise via _reflowTextBox)
 * or `src` (re-load via _loadImage), so the serialised image attr is
 * pure dead weight. Scrub it on the way out.
 */
function _serialiseStageJson() {
  if (!_stage) return null;
  let parsed;
  try { parsed = JSON.parse(_stage.toJSON()); }
  catch { return _stage.toJSON(); }
  const stripImage = (children) => {
    for (const c of children || []) {
      if (c?.attrs && 'image' in c.attrs) delete c.attrs.image;
      if (c?.children) stripImage(c.children);
    }
  };
  stripImage(parsed?.children);
  return JSON.stringify(parsed);
}

let _loadRaf = 0;
function _scheduleLoad() {
  // Defer by a frame so step.snapshot application completes before restore.
  // Cancel any prior RAF so rapid step changes don't queue multiple loads.
  if (_loadRaf) cancelAnimationFrame(_loadRaf);
  _loadRaf = requestAnimationFrame(() => { _loadRaf = 0; _loadFromActiveStep(); });
}

function _onStepApplied() {
  _loadFromActiveStep();
}

async function _loadFromActiveStep() {
  if (!_stage) return;
  // Tag this load so a later step-change invalidates a still-running one.
  // Without this, two rapid step switches can interleave: load #1's awaits
  // resolve AFTER load #2 has already populated the layer, dumping load #1's
  // (now-stale) nodes into the wrong step's layer.
  const myToken = ++_loadToken;
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

  // Find the content layer in the parsed spec. CRITICAL: prefer the
  // overlay layer by NAME ('userContent' or unnamed first layer) — the
  // stage also contains _uiLayer (transformer) and the header layer,
  // and a naive "first layer with children" scan can pick the wrong
  // one when the overlay is empty but UI / header have nodes.
  const savedLayers = spec.children || [];
  const saved = savedLayers.find(l => l.className === 'Layer' && l.attrs?.name === 'sbs-overlay-content')
             || savedLayers.find(l => l.className === 'Layer' && !l.attrs?.name && (l.children || []).length > 0)
             || savedLayers.find(l => l.className === 'Layer' && (l.children || []).length > 0)
             || savedLayers[0];
  if (!saved) { _layer.batchDraw(); return; }

  // Build every node FULLY (await async raster) before adding it to the
  // layer. Adding a Konva.Image to the layer before its image is set
  // means Konva tries to draw a node with no image — usually fine, but
  // when paired with a stale 0-dim attrs.image it throws "0 width or
  // height" inside Konva's draw loop. Awaiting eliminates that race
  // entirely and is what addTextBox / addImage already do for new nodes.
  for (const childSpec of (saved.children || [])) {
    const node = await _recreateNode(childSpec);
    if (myToken !== _loadToken) return;   // a newer load superseded us
    if (node) {
      _layer.add(node);
      _attachNode(node);
    }
  }
  _layer.batchDraw();
}

async function _recreateNode(spec) {
  if (!spec) return null;
  if (spec.className === 'Text')  return new Konva.Text({ ...spec.attrs, draggable: true });
  if (spec.className === 'Image') {
    // `image` is stripped defensively. Konva 9 toObject filters non-plain
    // objects out of attrs (so HTMLCanvasElement / HTMLImageElement do not
    // round-trip through toJSON in current builds), but older saves or
    // future Konva versions might leak one through — and even an empty `{}`
    // here fails the next draw with a 0×0 error.
    const { src, textHtml, textWidth, naturalW, naturalH, fillColor, styleId, image, ...rest } = spec.attrs || {};
    void image;   // intentionally discarded
    const node = new Konva.Image({ ...rest, draggable: true });
    if (Number.isFinite(naturalW)) node.setAttr('naturalW', naturalW);
    if (Number.isFinite(naturalH)) node.setAttr('naturalH', naturalH);
    if (fillColor)                 node.setAttr('fillColor', fillColor);
    if (styleId)                   node.setAttr('styleId', styleId);
    if (textHtml) {
      node.setAttr('textHtml',  textHtml);
      node.setAttr('textWidth', textWidth);
      // AWAIT the raster — see _loadFromActiveStep comment. _reflowTextBox
      // sets node.image(canvas) once the SVG-foreignObject paints. If we
      // don't await, the layer can render the node before the image lands.
      try { await _reflowTextBox(node); }
      catch (e) { console.warn('[overlay] text rasterize failed', e); }
    } else if (src) {
      node.setAttr('src', src);
      try {
        const img = await _loadImage(src);
        node.image(img);
        if (!Number.isFinite(node.getAttr('naturalW'))) node.setAttr('naturalW', img.width);
        if (!Number.isFinite(node.getAttr('naturalH'))) node.setAttr('naturalH', img.height);
      } catch (e) { console.warn('[overlay] image load failed', e); }
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
  // Don't intercept anything while typing in any editable. Browsers'
  // native Ctrl+C / Ctrl+V handle text selection inside contenteditable.
  const ae = document.activeElement;
  if (ae && (['INPUT','TEXTAREA'].includes(ae.tagName) || ae.isContentEditable)) return;
  if (_activeTextEditor) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (deleteSelected()) e.preventDefault();
    return;
  }

  // Clipboard shortcuts for overlay NODES (textboxes, images). Only fire
  // when nothing is being typed — guard above bails on contenteditable.
  // Paste / Duplicate are async (recreating a textbox awaits its raster),
  // so we check clipboard / selection sync to decide whether to swallow
  // the key, then fire-and-forget the async work.
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'c') { if (_copyToOverlayClipboard()) e.preventDefault(); return; }
  if (k === 'v') {
    const inPlace = !!e.altKey;            // Ctrl+Alt+V → paste in place
    if (_overlayClipboard?.length) {
      e.preventDefault();
      _pasteFromOverlayClipboard({ inPlace });
    }
    return;
  }
  if (k === 'd') {
    if (_transformer?.nodes()?.length) {
      e.preventDefault();
      _duplicateSelected();
    }
    return;
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
  // background-color is INTENTIONALLY excluded. Web sources love to put
  // a highlight colour on copied spans (search-result highlight, syntax
  // highlighting, banner backgrounds). Pasting that into a textbox left
  // visible coloured rectangles around the imported text that the user
  // had no way to remove. Textbox fill (the user-facing "background"
  // feature) is a node-level attr, not inline CSS, so dropping
  // background-color here doesn't affect it.
  const ALLOWED_STYLES = [
    'color',
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

  // Promote legacy <font color="..." face="..." size="..."> to
  // <span style="color:...;font-family:...;font-size:...">. Chromium's
  // execCommand still produces <font> in some configurations, and old
  // clipboard payloads carry it. Without this, the allowlist below
  // would unwrap <font> entirely and lose the styling.
  const SIZE_PX = { 1: 10, 2: 12, 3: 16, 4: 18, 5: 24, 6: 32, 7: 48 };
  tmp.querySelectorAll('font').forEach(f => {
    const span = document.createElement('span');
    const styles = [];
    const c = f.getAttribute('color');
    const fc = f.getAttribute('face');
    const sz = f.getAttribute('size');
    if (c)  styles.push(`color:${c}`);
    if (fc) styles.push(`font-family:${fc}`);
    if (sz && SIZE_PX[sz]) styles.push(`font-size:${SIZE_PX[sz]}px`);
    if (styles.length) span.setAttribute('style', styles.join(';'));
    while (f.firstChild) span.appendChild(f.firstChild);
    f.replaceWith(span);
  });

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

/**
 * Trim block-level padding that browsers stuff around clipboard payloads.
 *
 * When the user copies "hello" from inside another textbox, the browser's
 * cloneContents() often returns:
 *   <div>hello</div>
 * (the line's wrapper div, plus possibly empty <div><br></div> on either
 * side). insertHTML drops that block-level structure where the caret is,
 * which forces line breaks before AND after — the user sees an extra
 * empty line above and below the pasted text.
 *
 * This helper:
 *   • drops leading / trailing empty blocks (<div><br></div>, <p><br></p>)
 *   • unwraps a single outer <div> / <p> wrapper, so a one-line paste
 *     stays inline with the caret's current line.
 *
 * Multi-line pastes (multiple top-level blocks) are left as-is — the
 * line-break behaviour is intentional in that case.
 */
/**
 * Insert sanitised HTML at the contenteditable's current caret /
 * selection via the Selection API. Replacement for execCommand(
 * 'insertHTML', ...) which silently drops inline styles in some
 * Chromium builds.
 *
 * Caret is left immediately after the inserted content so the user
 * can continue typing where the paste ended.
 */
function _insertHtmlAtCaret(editor, html) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return;

  // Replace the selection with the new content.
  range.deleteContents();

  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  const frag = document.createDocumentFragment();
  let last = null;
  while (tmp.firstChild) last = frag.appendChild(tmp.firstChild);
  range.insertNode(frag);

  // Move the caret to just after the inserted content.
  if (last) {
    range.setStartAfter(last);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function _trimPasteBlocks(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';

  const isEmpty = (el) => {
    if (!el) return false;
    // Whitespace-only text nodes
    if (el.nodeType === 3) return !el.textContent.trim();
    if (el.nodeType !== 1) return false;
    // Bare <br> at the boundary
    if (el.tagName === 'BR') return true;
    // <div>/<p> with nothing visible inside (just whitespace or <br>s)
    if (/^(DIV|P)$/.test(el.tagName) &&
        !el.textContent.trim() &&
        !el.querySelector('img,svg,input,canvas')) {
      return true;
    }
    return false;
  };

  const stripBoundaries = () => {
    while (tmp.firstChild && isEmpty(tmp.firstChild)) tmp.removeChild(tmp.firstChild);
    while (tmp.lastChild  && isEmpty(tmp.lastChild))  tmp.removeChild(tmp.lastChild);
  };

  // Iterative unwrap. Each pass strips boundary padding and, if there's
  // still exactly one outer block wrapper containing only inline content
  // (no nested div/p), promotes its children up. Repeat — sometimes
  // clipboard payloads nest several wrappers (e.g. <div><div><div>text)
  // and we want the innermost text to land flat.
  let safety = 5;
  while (safety-- > 0) {
    stripBoundaries();
    if (tmp.children.length === 1 &&
        /^(DIV|P)$/.test(tmp.firstElementChild.tagName) &&
        !tmp.firstElementChild.querySelector('div,p')) {
      const only = tmp.firstElementChild;
      while (only.firstChild) tmp.insertBefore(only.firstChild, only);
      only.remove();
      continue;   // strip again, look for the next layer
    }
    break;
  }
  return tmp.innerHTML;
}

/**
 * Strip every inline style EXCEPT text-align from a HTML fragment.
 * Used when rendering style-template-bound text boxes — the template
 * dictates colour / font / size / weight / etc., but per-line alignment
 * is the user's per-box choice and survives.
 */
function _stripInlineStylingExceptAlign(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = String(html || '');
  tmp.querySelectorAll('[style]').forEach(el => {
    const align = el.style.textAlign;
    el.removeAttribute('style');
    if (align) el.style.textAlign = align;
  });
  // Drop legacy <font>/<u>/<s> entirely — template handles these.
  tmp.querySelectorAll('font,u,s,strike').forEach(el => {
    const parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  });
  return tmp.innerHTML;
}

/**
 * Public re-export so other systems (header.js) can rasterise their
 * own HTML through the same SVG-foreignObject path the overlay uses.
 * Same options + same XHTML normalisation, no duplication.
 */
export function htmlToCanvas(html, opts = {}) {
  return _htmlToCanvas(html, opts);
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
    fontWeight = 'normal',           // style-template overrides
    fontStyle  = 'normal',
    textDecoration = '',
  } = opts;

  // XHTML normalisation. SVG foreignObject parses its inner content as
  // XHTML, which is strict about void elements:
  //   • Chromium's contenteditable emits <br> (HTML5 form). In XHTML,
  //     an unclosed <br> is treated as an opening tag and CONSUMES every
  //     sibling after it until the parent closes — so an empty line
  //     followed by more text would visually drop the second part.
  //   • An empty <div></div> renders zero-height in SVG, swallowing what
  //     the user intended as a blank line.
  // Also strip zero-width spaces — the toolbar uses them as caret-style
  // placeholders when a font-size / colour is picked with no selection
  // (so the next typed character lands inside the styled span). Once
  // the user has typed the actual character, the ZWSP has done its
  // job and can be removed; if they didn't type anything, the empty
  // wrapper is removed by the cleanup pass and the ZWSP goes with it.
  // Either way, the rasterised output should never contain ZWSPs —
  // they're invisible in the editor but can confuse downstream
  // shaping / line-break logic in the SVG renderer.
  html = String(html || '')
    .replace(/[​﻿]/g,             '')
    .replace(/<br(\s[^>]*)?>/gi,            '<br$1/>')
    .replace(/<hr(\s[^>]*)?>/gi,            '<hr$1/>')
    .replace(/<img(\s[^>]*)?>/gi,           '<img$1/>')
    .replace(/<div(\s[^>]*)?><\/div>/gi,    '<div$1><br/></div>')
    .replace(/<p(\s[^>]*)?><\/p>/gi,        '<p$1><br/></p>');

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
    `font-weight:${fontWeight}`,
    `font-style:${fontStyle}`,
    `text-decoration:${textDecoration || 'none'}`,
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
  // Browser coerces canvas.width/height = NaN → 0. Force-clamp to sane
  // minimums here, so callers downstream never see a 0-sized canvas
  // even if `width` / `h` came in mangled.
  canvas.width  = (Number.isFinite(width) && width > 0) ? width : 20;
  canvas.height = (Number.isFinite(h)     && h     > 0) ? h     : 1;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}
