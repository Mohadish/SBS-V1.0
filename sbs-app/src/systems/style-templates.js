/**
 * SBS — Text style templates (project-level presets).
 *
 * A style template is a saved set of text styling — font, size, weight,
 * style, decoration, colour, fill — that text boxes can bind to via a
 * `styleId` attr. Once bound, the template's values OVERRIDE any inline
 * styling the box's HTML carries. Editing a template propagates live to
 * every box that references it.
 *
 * Use cases the user wants:
 *   • Define "Heading", "Body", "Caption" once, apply to many boxes.
 *   • Adjust the heading colour in one place, every "Heading" box updates.
 *   • Save a set of templates as a sidecar file for cross-project reuse
 *     (lives alongside the .sbsheader format we already ship — same
 *     wrapper, different items section).
 *
 * Data model
 * ──────────
 *   StyleTemplate = {
 *     id:             string,        // generateId('style')
 *     name:           string,        // user-facing label
 *     color:          string,        // '#rrggbb'
 *     fontFamily:     string,
 *     fontSize:       number,        // px
 *     fontWeight:     'normal' | 'bold',
 *     fontStyle:      'normal' | 'italic',
 *     textDecoration: '' | 'underline',
 *     fillColor:      string | null, // rgba() string for textbox bg
 *   }
 *
 * Defaults match the in-place text editor's defaults so a freshly
 * created template "looks like" what the user gets when they type
 * without any styling applied.
 */

import { state }       from '../core/state.js';
import { generateId }  from '../core/schema.js';
import { undoManager } from './undo.js';

/** Default values — match the text editor's CSS defaults exactly. */
export function defaultStyleValues() {
  return {
    color:          '#ffffff',
    fontFamily:     'Arial',
    fontSize:       16,
    fontWeight:     'normal',
    fontStyle:      'normal',
    textDecoration: '',
    fillColor:      null,
  };
}

export function makeStyleTemplate(overrides = {}) {
  return {
    id:   generateId('style'),
    name: overrides.name || 'New style',
    ...defaultStyleValues(),
    ...overrides,
  };
}

// ─── State mutations ───────────────────────────────────────────────────────

export function listStyleTemplates() {
  return state.get('styleTemplates') || [];
}

export function getStyleTemplate(id) {
  if (!id) return null;
  return listStyleTemplates().find(s => s.id === id) || null;
}

// P7-B-2: undo-aware mutators. Slider/colour-picker drags fire many
// updateStyleTemplate calls per second; auto-batching them by id with
// a 500ms idle commit collapses each editing burst into ONE undo
// entry "Edit style". add / remove are one-shot — push an entry per
// call directly. _flushStyleBatch() commits any pending burst.

let _styleBatch      = null;       // { id, before }
let _styleBatchTimer = null;

export function addStyleTemplate(overrides = {}) {
  _flushStyleBatch();   // close any prior burst before mutating the list
  const tpl = makeStyleTemplate(overrides);
  const items = listStyleTemplates().slice();
  items.push(tpl);
  state.setState({ styleTemplates: items });
  state.markDirty();
  undoManager.push(`Add style "${tpl.name}"`,
    () => _removeFromList(tpl.id),
    () => _addToList(tpl),
  );
  return tpl;
}

export function updateStyleTemplate(id, patch) {
  // Open / continue a batch keyed by template id. Switching to a
  // different id closes the prior burst with its own undo entry.
  if (!_styleBatch || _styleBatch.id !== id) {
    _flushStyleBatch();
    const cur = getStyleTemplate(id);
    if (cur) _styleBatch = { id, before: { ...cur } };
  }
  const items = listStyleTemplates().map(t => t.id === id ? { ...t, ...patch } : t);
  state.setState({ styleTemplates: items });
  state.markDirty();
  state.emit('styleTemplate:updated', { id, patch });
  // Restart idle timer — burst commits when no further updates land
  // for 500ms (release the slider, blur the input, etc.).
  clearTimeout(_styleBatchTimer);
  _styleBatchTimer = setTimeout(_flushStyleBatch, 500);
}

export function removeStyleTemplate(id) {
  _flushStyleBatch();
  const before = getStyleTemplate(id);
  if (!before) return;
  const items = listStyleTemplates().filter(t => t.id !== id);
  state.setState({ styleTemplates: items });
  state.markDirty();
  state.emit('styleTemplate:removed', { id });
  undoManager.push(`Delete style "${before.name}"`,
    () => _addToList(before),
    () => _removeFromList(id),
  );
}

export function renameStyleTemplate(id, name) {
  updateStyleTemplate(id, { name: String(name || 'Untitled') });
}

/**
 * Commit any pending styleBatch as a single undo entry. Public so
 * UI code can call before navigating away (closing the style tab,
 * switching projects) — without a flush, the batch sits open until
 * the next update or 500ms timeout.
 */
export function flushStyleBatch() {
  _flushStyleBatch();
}

function _flushStyleBatch() {
  clearTimeout(_styleBatchTimer);
  _styleBatchTimer = null;
  if (!_styleBatch) return;
  const { id, before } = _styleBatch;
  _styleBatch = null;
  const after = getStyleTemplate(id);
  if (!after) return;                                      // template was deleted mid-burst
  if (JSON.stringify(before) === JSON.stringify({ ...after })) return;
  const finalSnap = { ...after };
  undoManager.push(`Edit style "${finalSnap.name}"`,
    () => _applySnap(id, before),
    () => _applySnap(id, finalSnap),
  );
}

function _applySnap(id, snap) {
  const items = listStyleTemplates().map(t => t.id === id ? { ...t, ...snap } : t);
  state.setState({ styleTemplates: items });
  state.markDirty();
  state.emit('styleTemplate:updated', { id, patch: snap });
}

function _addToList(tpl) {
  const items = listStyleTemplates().slice();
  items.push(tpl);
  state.setState({ styleTemplates: items });
  state.markDirty();
  state.emit('styleTemplate:updated', { id: tpl.id });
}

function _removeFromList(id) {
  const items = listStyleTemplates().filter(t => t.id !== id);
  state.setState({ styleTemplates: items });
  state.markDirty();
  state.emit('styleTemplate:removed', { id });
}
