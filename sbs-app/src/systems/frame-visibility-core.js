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

/** File format: { v, ids: [...partIds], steps: { stepId: base64mask } }. */
export function serializeRecords(ids, masks) {
  const steps = {};
  for (const [stepId, mask] of masks) steps[stepId] = maskToBase64(mask);
  return JSON.stringify({ v: 1, ids, steps });
}

export function parseRecords(text) {
  const j = JSON.parse(text);
  if (!j || j.v !== 1 || !Array.isArray(j.ids)) throw new Error('not a frame-visibility record');
  const masks = new Map();
  for (const [stepId, b64] of Object.entries(j.steps || {})) masks.set(stepId, base64ToMask(b64));
  return { ids: j.ids.map(String), masks };
}
