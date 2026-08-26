/**
 * 🧵 Overlay image-string interning (V0.3.2.77) — the "string dedupe on load".
 *
 * Measured on the V20 production file: 254 per-step overlay strings hold
 * 178 MB of inline base64 images of which only 26 MB is UNIQUE content —
 * the same interface PNG pasted across dozens of steps, duplicated because
 * JSON.parse gives every step its own private copy of every string.
 * Whole-string dedupe is worthless here (6.7 MB — the strings differ by
 * node positions); the duplication lives INSIDE the strings, at the
 * data-URI level.
 *
 * JavaScript can't share a substring between two flat strings — but V8
 * CAN share leaves of a rope: `a + shared + b` builds a ConsString whose
 * `shared` leaf is stored once no matter how many ropes reference it. So:
 * scan each overlay string, cut it at its data-URIs, look every URI up in
 * a value-keyed pool (Map string keys compare by VALUE — zero collision
 * risk, unlike hashing), and rebuild the overlay as a rope over the pool's
 * canonical URI strings. ~150 MB of duplicate image bytes become shared.
 *
 * Two V8 subtleties this code is built around:
 *  • substring() returns a SLICE that pins its giant parent alive. Every
 *    part we keep is therefore "de-sliced" via (' '+s).substring(1), which
 *    forces a fresh right-sized buffer.
 *  • Reading a rope (JSON.parse, indexOf, save serialization) FLATTENS it
 *    in place — the sharing quietly un-does itself for every string a save
 *    or cache-plan touches. That's why internAllStepOverlays is cheap,
 *    idempotent, and re-run after load, save and autosave rather than only
 *    once. Re-interning a crept string just rebuilds its rope.
 *
 * Nothing persistent changes: the SAVED file is byte-identical, and the
 * render-cache keys parse overlay CONTENT (value-equal) — zero re-renders.
 */

// canonical URI string -> itself (key === value; keyed by VALUE, so lookup
// is exact string equality — never a hash collision)
let _pool = new Map();

/** Base64 alphabet lookup (charCode → 1). */
const _B64 = new Uint8Array(128);
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=') {
  _B64[c.charCodeAt(0)] = 1;
}

/** Force a fresh right-sized copy — releases the slice's giant parent. */
function _deslice(s) { return (' ' + s).substring(1); }

/** Reset the pool (call when a project is replaced — old images must be collectable). */
export function resetInternPool() { _pool = new Map(); }

/**
 * Intern one overlay string. Returns { s, sharedChars } where `s` is either
 * the original (nothing to do) or a rope sharing pooled URI leaves, and
 * sharedChars counts URI chars that now reference an EXISTING pool entry.
 */
export function internOverlayString(str) {
  // NOTE: callers can NOT detect "a rope was built" by comparing the result
  // to the input — strings are primitives, equal content compares === no
  // matter how it's stored. The `found` counter is the only signal.
  if (typeof str !== 'string' || str.length < 4096) return { s: str, sharedChars: 0, found: 0 };

  const parts = [];
  let last = 0, i = 0, sharedChars = 0, found = 0;
  while ((i = str.indexOf('data:', i)) !== -1) {
    const semi = str.indexOf(';base64,', i + 5);
    if (semi === -1 || semi - i > 90) { i += 5; continue; }
    let j = semi + 8;
    while (j < str.length) {
      const c = str.charCodeAt(j);
      if (c > 127 || !_B64[c]) break;
      j++;
    }
    if (j - (semi + 8) < 4096) { i = j; continue; }   // small URI — not worth pooling

    const uriProbe = _deslice(str.substring(i, j));
    let canonical = _pool.get(uriProbe);
    if (canonical) sharedChars += canonical.length;
    else { canonical = uriProbe; _pool.set(canonical, canonical); }

    if (i > last) parts.push(_deslice(str.substring(last, i)));
    parts.push(canonical);
    last = j; i = j; found++;
  }
  if (!found) return { s: str, sharedChars: 0, found: 0 };
  if (last < str.length) parts.push(_deslice(str.substring(last)));

  // Rope build — plain concatenation; V8 keeps the pooled leaves shared.
  let out = parts[0];
  for (let k = 1; k < parts.length; k++) out = out + parts[k];

  // Safety: any mismatch means the scan mis-cut — keep the original.
  if (out.length !== str.length) return { s: str, sharedChars: 0, found: 0 };
  return { s: out, sharedChars, found };
}

/**
 * Intern every step's overlay in place. Idempotent; re-run after anything
 * that flattens ropes wholesale (save, autosave, cache planning).
 * Returns stats for the console/log.
 */
export function internAllStepOverlays(steps) {
  let interned = 0, sharedMB = 0;
  for (const s of steps || []) {
    if (!s || typeof s.overlay !== 'string') continue;
    const r = internOverlayString(s.overlay);
    // Assign on `found`, never on inequality — equal-content strings compare
    // === regardless of representation, so a comparison can never detect the
    // rebuilt rope (the bug the first test run caught: the rope was built
    // and silently discarded, keeping the flat originals alive).
    if (r.found) { s.overlay = r.s; interned++; }
    sharedMB += r.sharedChars / 1e6;
  }
  let poolMB = 0;
  for (const v of _pool.values()) poolMB += v.length / 1e6;
  return { interned, poolImages: _pool.size, poolMB: +poolMB.toFixed(1), sharedMB: +sharedMB.toFixed(1) };
}
