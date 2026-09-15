// 🎞 In-frame visibility records — the PURE half (V0.3.2.255).
//
// A record answers "which parts really occupy pixels in this step's frame"
// (camera frustum AND occlusion), as a bitmask over a project-wide part
// index. No imports: everything here is data in, data out, so the encoding,
// the id↔colour mapping and the file format are unit-tested offline.
// The GPU pass that produces the records lives in frame-visibility.js.

/** Part index n (0-based) → the flat colour the ID pass paints it with. 0 = nothing. */
export function idToRgb(n) {
  const v = n + 1;                       // 0 is reserved for "no part"
  return [(v & 255) / 255, ((v >> 8) & 255) / 255, ((v >> 16) & 255) / 255];
}

/** Pixel bytes → part index, or -1 for background / untagged objects. */
export function rgbToId(r, g, b) {
  const v = r | (g << 8) | (b << 16);
  return v === 0 ? -1 : v - 1;
}

/** Collect the part indices present in an RGBA pixel buffer. */
export function indicesInPixels(pixels) {
  const seen = new Set();
  for (let i = 0; i < pixels.length; i += 4) {
    const n = rgbToId(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (n >= 0) seen.add(n);
  }
  return seen;
}

/** Bitmask over `bitCount` bits with the given indices set. */
export function maskFromIndices(indices, bitCount) {
  const m = new Uint8Array(Math.max(1, Math.ceil(bitCount / 8)));
  for (const n of indices) if (n >= 0 && n < bitCount) m[n >> 3] |= (1 << (n & 7));
  return m;
}

export function maskHas(mask, n) {
  const byte = n >> 3;
  return byte < mask.length && (mask[byte] & (1 << (n & 7))) !== 0;
}

/** Bitmask → Set of ids (bit i ↔ ids[i]); bits beyond the mask read as 0. */
export function maskToIds(mask, ids) {
  const out = new Set();
  const n = Math.min(ids.length, mask.length * 8);
  for (let i = 0; i < n; i++) if (mask[i >> 3] & (1 << (i & 7))) out.add(ids[i]);
  return out;
}

export function maskToBase64(mask) {
  let s = '';
  for (let i = 0; i < mask.length; i++) s += String.fromCharCode(mask[i]);
  return (typeof btoa === 'function') ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
}

export function base64ToMask(b64) {
  const s = (typeof atob === 'function') ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const m = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) m[i] = s.charCodeAt(i);
  return m;
}

/** Fast, deterministic 64-bit-ish hash of a string (two FNV-1a 32 lanes), hex. */
export function hashString(str) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x9e3779b1) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/**
 * File format v2: { v:2, ids: [...partIds], steps: { stepId: { m: base64mask, sig } } }.
 * `sig` is the signature of the step's key-relevant state when the record was
 * taken (see frame-visibility.js stepSignature) — the render cache trusts a
 * record only while the step still matches it. v1 files (no sig) still load;
 * their records serve the stars but never the cache key.
 */
export function serializeRecords(ids, records) {
  const steps = {};
  for (const [stepId, rec] of records) {
    const mask = rec?.mask || rec;
    steps[stepId] = { m: maskToBase64(mask), ...(rec?.sig ? { sig: rec.sig } : {}) };
  }
  return JSON.stringify({ v: 2, ids, steps });
}

export function parseRecords(text) {
  const j = JSON.parse(text);
  if (!j || (j.v !== 1 && j.v !== 2) || !Array.isArray(j.ids)) throw new Error('not a frame-visibility record');
  const records = new Map();
  for (const [stepId, v] of Object.entries(j.steps || {})) {
    if (typeof v === 'string') records.set(stepId, { mask: base64ToMask(v), sig: null });
    else if (v && typeof v.m === 'string') records.set(stepId, { mask: base64ToMask(v.m), sig: v.sig || null });
  }
  return { ids: j.ids.map(String), records };
}
