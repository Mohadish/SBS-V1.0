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

import { state }      from '../core/state.js';
import { generateId } from '../core/schema.js';

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

export function addStyleTemplate(overrides = {}) {
  const tpl = makeStyleTemplate(overrides);
  const items = listStyleTemplates().slice();
  items.push(tpl);
  state.setState({ styleTemplates: items });
  state.markDirty();
  return tpl;
}

export function updateStyleTemplate(id, patch) {
  const items = listStyleTemplates().map(t => t.id === id ? { ...t, ...patch } : t);
  state.setState({ styleTemplates: items });
  state.markDirty();
  state.emit('styleTemplate:updated', { id, patch });
}

export function removeStyleTemplate(id) {
  const items = listStyleTemplates().filter(t => t.id !== id);
  state.setState({ styleTemplates: items });
  state.markDirty();
  state.emit('styleTemplate:removed', { id });
}

export function renameStyleTemplate(id, name) {
  updateStyleTemplate(id, { name: String(name || 'Untitled') });
}
