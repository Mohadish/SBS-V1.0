/**
 * SBS — Edit Session (transactional undo for prolonged edits)
 * ============================================================
 * Wraps a series of fine-grained edits into ONE main-undo entry, while
 * giving the user a local-stack Ctrl-Z that's scoped to the session.
 *
 * Why
 *   Without this, every B/I/U/colour/font/size/etc. press during a
 *   text edit pollutes the global undo log with dozens of tiny entries.
 *   The user wants Ctrl-Z inside the editor to step BACK through the
 *   styling work, but Ctrl-Z OUTSIDE the editor to undo project-level
 *   things ("delete that step", "rename this preset"). This module is
 *   the seam between those two scopes.
 *
 * Lifecycle (P7-A: textbox / header editor)
 *   begin({ snapshot, restoreLocal, restoreCommitted, label })
 *     ↳ captures the seed state. Local stack starts empty.
 *
 *   record()                   — call BEFORE each toolbar / engine op.
 *                                Pushes a snapshot of the pre-op state
 *                                so undoLocal() can return to it.
 *
 *   undoLocal() / redoLocal()  — step within the session. Returns
 *                                true if the call did something
 *                                (caller can fall back to native /
 *                                main-undo on false).
 *
 *   end({ commit })            — finalize.
 *                                  commit:false → restoreLocal(seed).
 *                                  commit:true  → diff seed vs final;
 *                                                   if changed, push
 *                                                   ONE main-undo
 *                                                   entry.
 *
 * Snapshot/restore are caller-supplied so each subsystem (overlay,
 * header, mass-mode in P7-B, structural in P7-C) can serialise its
 * own state shape. The module itself is data-agnostic.
 *
 * Scope (P7-A)
 *   Only single-editor sessions wire this for now. Mass-mode and style-
 *   template edits will follow in P7-B; structural overlay ops in P7-C.
 *   Shape of begin()/end() stays the same — those just call begin /
 *   immediately end({commit:true}) with no record() calls in between
 *   (one-shot mutations don't need a local stack).
 */

import undoManager from './undo.js';

let _active = null;

export function begin({ snapshot, restoreLocal, restoreCommitted, label }) {
  // If a stale session is open (developer error or re-entry), fold it
  // into the main undo log with whatever changes it has — losing it
  // entirely would be silent data loss.
  if (_active) end({ commit: true });
  _active = {
    label:             label || 'Edit',
    snapshot,
    restoreLocal,
    restoreCommitted,
    seed:              snapshot(),
    stack:             [],
    redo:              [],
  };
}

/**
 * Push a snapshot of the CURRENT state onto the local stack. Call this
 * BEFORE the mutation so undoLocal() can restore the pre-mutation
 * state. Returns silently if no session is active — callers can
 * sprinkle this freely without guard checks.
 */
export function record() {
  if (!_active) return;
  _active.stack.push(_active.snapshot());
  _active.redo = [];                     // any new edit invalidates redo
}

/**
 * Step backward in the session. Returns true if a snapshot was popped
 * + restored, false if the stack was empty (caller can fall through
 * to native browser undo or main-undo).
 *
 * Snapshots both directions: the current state goes onto the redo
 * stack so redoLocal() can return to it.
 */
export function undoLocal() {
  if (!_active || _active.stack.length === 0) return false;
  const cur = _active.snapshot();
  _active.redo.push(cur);
  const prev = _active.stack.pop();
  _active.restoreLocal(prev);
  return true;
}

export function redoLocal() {
  if (!_active || _active.redo.length === 0) return false;
  const cur = _active.snapshot();
  _active.stack.push(cur);
  const next = _active.redo.pop();
  _active.restoreLocal(next);
  return true;
}

/**
 * Finalize the session.
 *   commit:false (Esc / discard)
 *     → revert the live editor to the seed snapshot via restoreLocal,
 *       then drop the session. Nothing reaches the main undo log.
 *
 *   commit:true (click-out, Enter, etc.)
 *     → if the final state differs from the seed, push ONE entry on
 *       undoManager. Undo/redo on that entry calls restoreCommitted
 *       (which works on the BAKED state — by then the editor div is
 *       gone, so restoreLocal is no longer reachable).
 */
export function end({ commit }) {
  if (!_active) return;
  const sess = _active;
  _active = null;

  if (!commit) {
    sess.restoreLocal(sess.seed);
    return;
  }
  const final = sess.snapshot();
  if (_eq(sess.seed, final)) return;     // no-op session — no entry

  undoManager.push(
    sess.label,
    () => sess.restoreCommitted(sess.seed),
    () => sess.restoreCommitted(final),
  );
}

export function isActive()      { return _active !== null; }
export function canUndoLocal()  { return !!_active && _active.stack.length > 0; }
export function canRedoLocal()  { return !!_active && _active.redo.length  > 0; }

/**
 * Cheap shallow equality via JSON.stringify. Snapshots in this codebase
 * are plain data ({ html, fillColor, styleId, ... }), so the round-trip
 * is fine. If a future caller stores non-JSON values (functions, DOM
 * nodes), they'll need to provide their own diff — but that's a
 * smell anyway: snapshots should be data, not references.
 */
function _eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
