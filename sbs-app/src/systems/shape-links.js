/**
 * SBS — Linked shape instances (V0.3.2.150)
 *
 * A linked shape is ONE logical object appearing on many steps. Every
 * instance shares geometry, style and position: resize it on step 4 and
 * the copies on steps 9 and 30 are the same size when you get there.
 * Breaking the link on one instance makes that one unique.
 *
 * This is the shape-side twin of a style template, but wider: a style
 * shares only fill and outline, while a link shares the whole object.
 *
 * "Live everywhere" is resolution, not broadcast
 * ──────────────────────────────────────────────
 * Only ONE step's Konva nodes exist at a time — loading a step calls
 * _layer.destroyChildren() and the other steps are just JSON strings. So
 * there is nothing off-screen to "update": an edit writes the definition,
 * same-step siblings are echoed immediately, and every other instance
 * resolves from the definition when its step is drawn.
 *
 * That covers everything observable — step navigation and video export
 * both activate steps and rasterise the live overlay. The one exception is
 * the steps-panel thumbnail, which is a stale raster of the last visit for
 * shape styles and constant positions too.
 *
 * Rewriting all ~260 stored overlay strings on every drag frame was the
 * alternative. It parses and re-serialises the whole project per pointer
 * move (a documented OOM path here), and the only existing helper for
 * writing another step's overlay schedules a stage rebuild — which would
 * destroy the very node being dragged.
 *
 * Data model
 * ──────────
 *   ShapeLinkDef = {
 *     id, name,
 *     className,     // 'Rect' | 'Circle' | ... — links never cross kinds
 *     x, y, rotation,
 *     geom:  {},     // KIND-DEPENDENT, see GEOM_KEYS below
 *     style: { fill, stroke, strokeWidth, opacity },
 *     shapeStyleId,  // shared style binding, or null
 *   }
 *
 * Geometry is kind-dependent on purpose: a Rect carries width/height, a
 * Circle a radius, an Ellipse radiusX/radiusY, a Line an array of points.
 * Copying width/height between instances would work for rectangles and
 * silently corrupt everything else.
 */

import { state }       from '../core/state.js';
import { generateId }  from '../core/schema.js';
import { undoManager } from './undo.js';

/** The geometry attrs that define each shape kind's size. */
export const GEOM_KEYS = {
  Rect:           ['width', 'height', 'cornerRadius'],
  Circle:         ['radius'],
  Ellipse:        ['radiusX', 'radiusY'],
  RegularPolygon: ['radius', 'sides'],
  Line:           ['points'],
  Arrow:          ['points', 'pointerLength', 'pointerWidth'],
};

/** Paint attrs shared by every kind. */
export const STYLE_KEYS = ['fill', 'stroke', 'strokeWidth', 'opacity'];

export function makeShapeLink(overrides = {}) {
  return {
    id:           generateId('shapelink'),
    name:         overrides.name || 'Linked shape',
    className:    overrides.className || 'Rect',
    x:            0,
    y:            0,
    rotation:     0,
    geom:         {},
    style:        {},
    shapeStyleId: null,
    ...overrides,
  };
}

// ─── State ──────────────────────────────────────────────────────────────────

export function listShapeLinks() {
  return state.get('shapeLinks') || [];
}

export function getShapeLink(id) {
  if (!id) return null;
  return listShapeLinks().find(l => l.id === id) || null;
}

export function addShapeLink(def) {
  _flushBatch();
  const items = listShapeLinks().slice();
  items.push(def);
  state.setState({ shapeLinks: items });
  state.markDirty();
  undoManager.push(`Link shape "${def.name}"`,
    () => _removeFromList(def.id),
    () => _addToList(def),
  );
  return def;
}

export function removeShapeLink(id) {
  _flushBatch();
  const before = getShapeLink(id);
  if (!before) return;
  state.setState({ shapeLinks: listShapeLinks().filter(l => l.id !== id) });
  state.markDirty();
  state.emit('shapeLink:removed', { id });
  undoManager.push(`Delete link "${before.name}"`,
    () => _addToList(before),
    () => _removeFromList(id),
  );
}

export function renameShapeLink(id, name) {
  const items = listShapeLinks().map(l => l.id === id ? { ...l, name: String(name || 'Untitled') } : l);
  state.setState({ shapeLinks: items });
  state.markDirty();
  state.emit('shapeLink:updated', { id });
}

/**
 * Write new values into a definition. Dragging fires this on every gesture
 * END (never per frame), so edits coalesce by id on a 500ms idle timer into
 * ONE undo entry — the same batching shape styles use, and the reason a
 * drag-resize-drag burst doesn't become three undo steps.
 */
let _batch      = null;   // { id, before }
let _batchTimer = null;

export function updateShapeLink(id, patch) {
  if (!_batch || _batch.id !== id) {
    _flushBatch();
    const cur = getShapeLink(id);
    if (cur) _batch = { id, before: JSON.parse(JSON.stringify(cur)) };
  }
  const items = listShapeLinks().map(l => l.id === id ? { ...l, ...patch } : l);
  state.setState({ shapeLinks: items });
  state.markDirty();
  state.emit('shapeLink:updated', { id, patch });
  clearTimeout(_batchTimer);
  _batchTimer = setTimeout(_flushBatch, 500);
}

export function flushShapeLinkBatch() { _flushBatch(); }

function _flushBatch() {
  clearTimeout(_batchTimer);
  _batchTimer = null;
  if (!_batch) return;
  const { id, before } = _batch;
  _batch = null;
  const after = getShapeLink(id);
  if (!after) return;
  const snap = JSON.parse(JSON.stringify(after));
  if (JSON.stringify(before) === JSON.stringify(snap)) return;
  undoManager.push(`Edit linked shape "${snap.name}"`,
    () => _applySnap(id, before),
    () => _applySnap(id, snap),
  );
}

function _applySnap(id, snap) {
  const items = listShapeLinks().map(l => l.id === id ? { ...l, ...snap } : l);
  state.setState({ shapeLinks: items });
  state.markDirty();
  state.emit('shapeLink:updated', { id, patch: snap });
}

function _addToList(def) {
  const items = listShapeLinks().slice();
  items.push(def);
  state.setState({ shapeLinks: items });
  state.markDirty();
  state.emit('shapeLink:updated', { id: def.id });
}

function _removeFromList(id) {
  state.setState({ shapeLinks: listShapeLinks().filter(l => l.id !== id) });
  state.markDirty();
  state.emit('shapeLink:removed', { id });
}
