/**
 * SBS — Selection Action History
 * ================================
 * Parallel circular buffer for selection undo snapshots.
 *
 * Works alongside undo.js:
 *   - Each user selection change records a snapshot here (returns an ID)
 *   - A lightweight "select-act#ID" slot is pushed to the main undo stack
 *   - When undo reaches that slot, it calls selectionActs.get(id)
 *   - If snapshot is still held  → restore selection, return true
 *   - If snapshot was evicted    → return false (undo.js skips silently)
 *
 * Only the last MAX_SIZE snapshots are kept in memory.
 * Older ones evict automatically — no data loss risk (selection is non-destructive).
 */

const MAX_SIZE = 5;

class SelectionActHistory {
  constructor() {
    this._store   = new Map();   // id → { selectedId, multiIds }
    this._counter = 0;
  }

  /**
   * Record a selection state.
   * @param {string|null} selectedId
   * @param {Set<string>} multiIds
   * @returns {number} snapshot ID
   */
  record(selectedId, multiIds) {
    const id = ++this._counter;
    this._store.set(id, {
      selectedId,
      multiIds: new Set(multiIds),
    });

    // Evict oldest when over capacity
    if (this._store.size > MAX_SIZE) {
      const oldest = this._store.keys().next().value;
      this._store.delete(oldest);
    }

    return id;
  }

  /**
   * Retrieve a snapshot by ID.
   * @returns {{ selectedId, multiIds } | null}  null if evicted
   */
  get(id) {
    return this._store.get(id) ?? null;
  }

  clear() {
    this._store.clear();
    this._counter = 0;
  }
}

export const selectionActs = new SelectionActHistory();
export default selectionActs;
