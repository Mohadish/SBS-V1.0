/**
 * SBS — Undo / Redo Manager
 * ==========================
 * Simple command stack.  Each entry: { label, undo(), redo() }.
 * Nothing here knows about materials, steps, or Three.js —
 * it only manages the stack and emits events.
 */

import state from '../core/state.js';

class UndoManager {
  constructor() {
    this._undo    = [];   // [ { label, undo, redo } ]
    this._redo    = [];
    this._maxSize = 100;
  }

  /**
   * Push a reversible command.
   * Clears the redo stack (new action breaks the redo chain).
   *
   * Optional `coalesceKey` (in opts) folds rapid repeats of the same
   * action into a single undo entry. If the TOP of the stack has a
   * matching key AND was pushed within `coalesceWindowMs` (default
   * 800 ms), this push REPLACES the top's redo + label, keeping the
   * top's original undo. Use it for verbose drag-style streams (e.g.
   * "Step selection") that would otherwise flood the log.
   */
  push(label, undoFn, redoFn, opts = {}) {
    this._redo = [];
    const top = this._undo.at(-1);
    const now = performance.now();
    const window = opts.coalesceWindowMs ?? 800;
    if (
      opts.coalesceKey &&
      top?.coalesceKey === opts.coalesceKey &&
      (now - (top._t ?? 0)) <= window
    ) {
      top.redo  = redoFn;
      top.label = label;
      top._t    = now;
    } else {
      this._undo.push({
        label, undo: undoFn, redo: redoFn,
        coalesceKey: opts.coalesceKey,
        _t: now,
      });
      if (this._undo.length > this._maxSize) this._undo.shift();
    }
    state.emit('undo:change');
  }

  undo() {
    const cmd = this._undo.pop();
    if (!cmd) return;
    const result = cmd.undo();
    // result === false means "evicted / no-op" — don't pollute redo stack
    if (result !== false) this._redo.push(cmd);
    state.emit('undo:change');
  }

  redo() {
    const cmd = this._redo.pop();
    if (!cmd) return;
    cmd.redo();
    this._undo.push(cmd);
    state.emit('undo:change');
  }

  canUndo()   { return this._undo.length > 0; }
  canRedo()   { return this._redo.length > 0; }
  undoLabel() { return this._undo.at(-1)?.label ?? null; }
  redoLabel() { return this._redo.at(-1)?.label ?? null; }

  /** Clear both stacks (e.g. after project load). */
  clear() {
    this._undo = [];
    this._redo = [];
    state.emit('undo:change');
  }
}

export const undoManager = new UndoManager();
export default undoManager;
