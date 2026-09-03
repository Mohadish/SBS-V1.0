/**
 * SBS — Shape style templates (project-level presets).
 *
 * The shape-side twin of style-templates.js. A shape style is a saved
 * set of fill + outline that overlay shapes bind to via a `shapeStyleId`
 * attr. Once bound the template's values OVERRIDE the shape's own fill /
 * outline, and editing the template propagates to every bound shape.
 *
 * Data model
 * ──────────
 *   ShapeStyle = {
 *     id:          string,          // generateId('shapestyle')
 *     name:        string,          // user-facing label
 *     fill:        string | null,   // 'rgba(r,g,b,a)' — colour AND opacity
 *     stroke:      string | null,   // '#rrggbb'; null = no outline
 *     strokeWidth: number,          // px
 *   }
 *
 * Deliberately NOT in the model
 * ─────────────────────────────
 *   cornerRadius. It is rectangle geometry rather than styling — it means
 *   nothing on a circle or an arrow — so it stays a per-shape property and
 *   remains editable even while a style is bound. That is the one control
 *   the toolbar leaves live when everything else locks.
 *
 * Binding semantics (per user spec)
 * ─────────────────────────────────
 *   • Bound  → the style is absolute. Fill / outline controls go read-only;
 *     the only way to change the look is to pick a different style.
 *   • Editing a style is done in the Style tab, and updates every shape
 *     bound to it.
 *   • "(no style)" unbinds and BAKES the style's current values into the
 *     shape as its own, so nothing visibly jumps and the user carries on
 *     editing from there. See _bakeShapeStyle in overlay.js.
 *
 * Resolution happens at load/render time (overlay.js), not by writing
 * values into every stored step — the same approach text styles use. That
 * is what makes a template edit reach shapes in steps that aren't on
 * screen: each step re-resolves from the id when it loads.
 */

import { state }       from '../core/state.js';
import { generateId }  from '../core/schema.js';
import { undoManager } from './undo.js';

/** Default values — match SHAPE_DEFAULTS' factory settings in overlay.js. */
export function defaultShapeStyleValues() {
  return {
    fill:        'rgba(74,144,217,0.45)',
    stroke:      '#4A90D9',
    strokeWidth: 3,
  };
}

export function makeShapeStyle(overrides = {}) {
  return {
    id:   generateId('shapestyle'),
    name: overrides.name || 'New shape style',
    ...defaultShapeStyleValues(),
    ...overrides,
  };
}

/** The subset of node attrs a shape style owns. */
export const SHAPE_STYLE_KEYS = ['fill', 'stroke', 'strokeWidth'];

// ─── State mutations ───────────────────────────────────────────────────────

export function listShapeStyles() {
  return state.get('shapeStyles') || [];
}

export function getShapeStyle(id) {
  if (!id) return null;
  return listShapeStyles().find(s => s.id === id) || null;
}

// Mirrors style-templates.js: colour-picker / slider drags fire many
// updates per second, so they auto-batch by id with a 500ms idle commit
// and collapse into ONE undo entry. add / remove push directly.

let _batch      = null;      // { id, before }
let _batchTimer = null;

export function addShapeStyle(overrides = {}) {
  _flushBatch();
  const tpl = makeShapeStyle(overrides);
  const items = listShapeStyles().slice();
  items.push(tpl);
  state.setState({ shapeStyles: items });
  state.markDirty();
  undoManager.push(`Add shape style "${tpl.name}"`,
    () => _removeFromList(tpl.id),
    () => _addToList(tpl),
  );
  return tpl;
}

export function updateShapeStyle(id, patch) {
  if (!_batch || _batch.id !== id) {
    _flushBatch();
    const cur = getShapeStyle(id);
    if (cur) _batch = { id, before: { ...cur } };
  }
  const items = listShapeStyles().map(t => t.id === id ? { ...t, ...patch } : t);
  state.setState({ shapeStyles: items });
  state.markDirty();
  state.emit('shapeStyle:updated', { id, patch });
  clearTimeout(_batchTimer);
  _batchTimer = setTimeout(_flushBatch, 500);
}

export function removeShapeStyle(id) {
  _flushBatch();
  const before = getShapeStyle(id);
  if (!before) return;
  const items = listShapeStyles().filter(t => t.id !== id);
  state.setState({ shapeStyles: items });
  state.markDirty();
  state.emit('shapeStyle:removed', { id });
  undoManager.push(`Delete shape style "${before.name}"`,
    () => _addToList(before),
    () => _removeFromList(id),
  );
}

export function renameShapeStyle(id, name) {
  updateShapeStyle(id, { name: String(name || 'Untitled') });
}

/**
 * Commit any pending edit burst as a single undo entry. Public so UI can
 * call it before navigating away — without a flush the batch sits open
 * until the next update or the 500ms timeout.
 */
export function flushShapeStyleBatch() {
  _flushBatch();
}

function _flushBatch() {
  clearTimeout(_batchTimer);
  _batchTimer = null;
  if (!_batch) return;
  const { id, before } = _batch;
  _batch = null;
  const after = getShapeStyle(id);
  if (!after) return;                                    // deleted mid-burst
  if (JSON.stringify(before) === JSON.stringify({ ...after })) return;
  const finalSnap = { ...after };
  undoManager.push(`Edit shape style "${finalSnap.name}"`,
    () => _applySnap(id, before),
    () => _applySnap(id, finalSnap),
  );
}

function _applySnap(id, snap) {
  const items = listShapeStyles().map(t => t.id === id ? { ...t, ...snap } : t);
  state.setState({ shapeStyles: items });
  state.markDirty();
  state.emit('shapeStyle:updated', { id, patch: snap });
}

function _addToList(tpl) {
  const items = listShapeStyles().slice();
  items.push(tpl);
  state.setState({ shapeStyles: items });
  state.markDirty();
  state.emit('shapeStyle:updated', { id: tpl.id });
}

function _removeFromList(id) {
  const items = listShapeStyles().filter(t => t.id !== id);
  state.setState({ shapeStyles: items });
  state.markDirty();
  state.emit('shapeStyle:removed', { id });
}
