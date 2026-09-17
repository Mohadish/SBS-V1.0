/**
 * SBS — review notes (V0.3.3.8).
 * ───────────────────────────────
 * Remarks a translator / proofreader typed into the Notes column of a
 * translation sheet (plus any picture they floated over the row) come back
 * into the project as review notes: one per row, tied to the step and the
 * unit it was about, with an "addressed" tick. Project-level (saved in the
 * .sbsproj), every mutation undoable.
 *
 *   ReviewNote = { id, key, stepId, lang, type, text, images: string[] (data URLs),
 *                  resolved, createdAt, file }
 */

import { state }       from '../core/state.js';
import { undoManager } from './undo.js';

export function listReviewNotes() { return state.get('reviewNotes') || []; }

export function newReviewNoteId() { return `rn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`; }

function _write(list) {
  state.setState({ reviewNotes: list });
  state.markDirty();
}

/** Add many notes at once (one undo entry). Returns the added notes. */
export function addReviewNotes(notes, label = 'Import notes') {
  const add = (notes || []).filter(n => n && (n.text || (n.images && n.images.length))).map(n => ({
    id: n.id || newReviewNoteId(),
    key: n.key || null, stepId: n.stepId || null, lang: n.lang || '', type: n.type || '',
    text: String(n.text || ''), images: (n.images || []).slice(), resolved: !!n.resolved,
    createdAt: n.createdAt || new Date().toISOString(), file: n.file || '',
  }));
  if (!add.length) return [];
  const before = listReviewNotes();
  const after  = [...before, ...add];
  _write(after);
  undoManager.push(`${label} (${add.length})`, () => _write(before), () => _write(after));
  return add;
}

export function setReviewNoteResolved(id, resolved) {
  const before = listReviewNotes();
  const note = before.find(n => n.id === id);
  if (!note || !!note.resolved === !!resolved) return;
  const after = before.map(n => (n.id === id ? { ...n, resolved: !!resolved } : n));
  _write(after);
  undoManager.push(resolved ? 'Note addressed' : 'Note reopened', () => _write(before), () => _write(after));
}

export function deleteReviewNote(id) {
  const before = listReviewNotes();
  if (!before.some(n => n.id === id)) return;
  const after = before.filter(n => n.id !== id);
  _write(after);
  undoManager.push('Delete note', () => _write(before), () => _write(after));
}

export function clearResolvedReviewNotes() {
  const before = listReviewNotes();
  const after  = before.filter(n => !n.resolved);
  if (after.length === before.length) return 0;
  _write(after);
  undoManager.push(`Clear ${before.length - after.length} addressed note(s)`, () => _write(before), () => _write(after));
  return before.length - after.length;
}
