/**
 * SBS — structure-clone helpers that DON'T duplicate big immutable strings.
 *
 * Why this exists: `JSON.parse(JSON.stringify(x))` deep-clones EVERYTHING,
 * including every string. For SBS state that means copying gigabytes of inline
 * base64 (overlay JSON, image-sequence frames, narration audio) on every undo
 * snapshot / copy / paste — which OOM-crashed the renderer (the heap cage is a
 * hard ~3.5 GB; see electron/main.js). These helpers copy only the object/array
 * STRUCTURE (so the clone is independent and safe to mutate) while SHARING the
 * string leaves by reference. Sharing is safe because JS strings are immutable:
 * an "edit" reassigns a property to a NEW string, it never mutates the shared one.
 *
 * Constraint: PLAIN JSON-shaped data only (objects, arrays, strings, numbers,
 * booleans, null). No Date / Map / Set / class instances — those would be
 * structurally flattened. SBS step/preset/state data is plain JSON, so this is a
 * safe drop-in for the JSON deep-clone used in undo snapshots.
 */

/** Independent structure, shared string/primitive leaves. */
export function cloneShareStrings(v) {
  if (v === null || typeof v !== 'object') return v;      // primitives (strings) shared by ref
  if (Array.isArray(v)) return v.map(cloneShareStrings);
  const out = {};
  for (const k of Object.keys(v)) out[k] = cloneShareStrings(v[k]);
  return out;
}

/** Deep structural equality for plain JSON data, using === on leaves so shared
 *  string refs short-circuit in O(1). Replaces JSON.stringify(a)===JSON.stringify(b)
 *  (which re-serialises everything) for cheap no-op detection on base64-heavy state. */
export function structEqual(a, b) {
  if (a === b) return true;                                // same ref (incl. shared strings) → O(1)
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!structEqual(a[k], b[k])) return false;
  return true;
}
