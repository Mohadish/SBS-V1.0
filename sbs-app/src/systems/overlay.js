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

export function setEditingMode(on) {
  _editing = !!on;
  if (_container) _container.classList.toggle('editing', _editing);
  if (!_editing) _setSelection(null);
}

// ─── Creating nodes ────────────────────────────────────────────────────────

export function addTextBox({ text = 'Text', x, y, fontSize = 32, fill = '#ffffff', fontFamily = 'Arial' } = {}) {
  if (!_stage) return null;
  const cx = x ?? _stage.width()  / 2;
  const cy = y ?? _stage.height() / 2;
  const node = new Konva.Text({
    x: cx - 80, y: cy - 20,
    text, fontSize, fontFamily, fill,
    padding: 4,
    draggable: true,
    name: 'userText',
  });
  _layer.add(node);
  _attachNode(node);
  _setSelection(node);
  _scheduleSave();
  return node;
}

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
  _layer.add(node);
  _attachNode(node);
  _setSelection(node);
  _scheduleSave();
  return node;
}

function _attachNode(node) {
  node.on('pointerdown', () => _setSelection(node));
  node.on('dragend transformend', _scheduleSave);
  if (node.getClassName() === 'Text') node.on('dblclick', () => _editText(node));
}

function _setSelection(node) {
  if (node) {
    _transformer.nodes([node]);
  } else {
    _transformer.nodes([]);
  }
  _uiLayer.batchDraw();
}

// ─── Selected-node mutators (called from toolbar) ──────────────────────────

export function getSelected() {
  const n = _transformer?.nodes()?.[0];
  return n || null;
}

export function deleteSelected() {
  const n = getSelected();
  if (!n) return false;
  n.destroy();
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
    // Image needs an HTMLImageElement; we stashed the dataUrl in attrs.src.
    const { src, ...rest } = spec.attrs || {};
    const node = new Konva.Image({ ...rest, draggable: true });
    node.setAttr('src', src);
    if (src) {
      _loadImage(src).then(img => { node.image(img); _layer.batchDraw(); })
        .catch(e => console.warn('[overlay] image load failed', e));
    }
    return node;
  }
  return null;
}

// ─── Video-export compositing (used by Phase 2b) ───────────────────────────

/**
 * Returns an HTMLCanvasElement with the overlay's current contents at the
 * given pixel size, or null if there's no overlay. Caller is responsible
 * for disposing.
 */
export function rasterizeOverlay(width, height) {
  if (!_stage || _layer.getChildren().length === 0) return null;
  const prevW = _stage.width();
  const prevH = _stage.height();
  _stage.width(width);
  _stage.height(height);
  const canvas = _layer.toCanvas({ pixelRatio: 1 });
  _stage.width(prevW);
  _stage.height(prevH);
  return canvas;
}

// ─── Internals ─────────────────────────────────────────────────────────────

function _onKeyDown(e) {
  if (!_editing) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (document.activeElement && ['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) return;
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
