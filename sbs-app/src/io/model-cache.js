/**
 * SBS — CAD fast-load cache  (V0.2.22.80)
 * ========================================
 * STEP/IGES/BREP parsing in the OCCT WASM kernel is the dominant import cost
 * (90s+ on a big assembly) — and it's almost all *parsing*, not tessellation,
 * so no quality knob can touch it. The fix is to parse ONCE and stash the
 * result, then replay it on later opens.
 *
 * What we stash is the OCCT `result` ({ root, meshes }) — i.e. the exact
 * tessellated geometry + part tree + colors the kernel produced. Replaying it
 * through buildNodeFromOcct reproduces the identical model in ~1–2s, with no
 * kernel involvement. Perfect fidelity, no glTF round-trip.
 *
 * Storage = a "polyglot tail". We append the cache payload + a fixed 96-byte
 * footer to the file:
 *
 *     [  original STEP bytes  ][  cache payload  ][  96-byte footer  ]
 *
 * STEP content stays at the HEAD, so the file is still a valid STEP — rename
 * .sbsobj→.step and any CAD tool that ignores trailing bytes still opens it.
 * We never feed the tail to OCCT; we locate the boundary from the footer and
 * hand the kernel only the clean head when we must re-parse.
 *
 * The footer is read from the END (like a ZIP central directory), so we never
 * scan the text for END-ISO-10303-21;. It carries a SHA-256 of the head, so an
 * edited/re-saved STEP (whose tail a CAD tool would have stripped, or whose
 * head no longer matches) is detected and safely re-parsed.
 *
 * This module is pure data ⇄ bytes; it does no file I/O and no scene building.
 */

'use strict';

// ── Footer layout (fixed 96 bytes, little-endian) ──────────────────────────
//   0  ..8   magic   "SBSCAC1\0"
//   8  ..12  u32     formatVersion
//   12 ..13  u8      payloadKind (1 = occt-result-blob)
//   13 ..16  reserved
//   16 ..24  u64     headLength      (bytes of source head = payload start)
//   24 ..32  u64     payloadLength   (bytes of cache payload)
//   32 ..64  bytes   headSHA256      (hash of head[0..headLength))
//   64 ..88  reserved
//   88 ..96  magic   "SBSCAC1\0"  (repeated, so a tail is unambiguous)
const FOOTER_SIZE   = 96;
const MAGIC         = 'SBSCAC1\0';        // 8 bytes
const FORMAT_VER    = 1;
const KIND_OCCT     = 1;

const _enc = new TextEncoder();
const _dec = new TextDecoder();

// ── SHA-256 → hex (Web Crypto, available in the renderer) ──────────────────
export async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0');
  return s;
}

// ── Footer read/write ──────────────────────────────────────────────────────
function _buildFooter(headLength, payloadLength, headHashHex) {
  const f  = new Uint8Array(FOOTER_SIZE);
  const dv = new DataView(f.buffer);
  f.set(_enc.encode(MAGIC), 0);
  dv.setUint32(8, FORMAT_VER, true);
  f[12] = KIND_OCCT;
  dv.setBigUint64(16, BigInt(headLength), true);
  dv.setBigUint64(24, BigInt(payloadLength), true);
  for (let i = 0; i < 32; i++) f[32 + i] = parseInt(headHashHex.substr(i * 2, 2), 16);
  f.set(_enc.encode(MAGIC), 88);
  return f;
}

/**
 * Inspect a file's tail. Returns the footer descriptor, or null if there is
 * no SBS cache tail. Cheap — only the last 96 bytes are examined.
 *
 * @param {Uint8Array} fileBytes
 * @returns {{headLength:number, payloadStart:number, payloadLength:number, headHashHex:string}|null}
 */
export function readFooter(fileBytes) {
  if (!fileBytes || fileBytes.length < FOOTER_SIZE) return null;
  const f  = fileBytes.subarray(fileBytes.length - FOOTER_SIZE);
  if (_dec.decode(f.subarray(0, 8))  !== MAGIC) return null;
  if (_dec.decode(f.subarray(88, 96)) !== MAGIC) return null;
  const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
  if (dv.getUint32(8, true) !== FORMAT_VER) return null;
  const headLength    = Number(dv.getBigUint64(16, true));
  const payloadLength = Number(dv.getBigUint64(24, true));
  // Sanity: head + payload + footer must equal the file size.
  if (headLength + payloadLength + FOOTER_SIZE !== fileBytes.length) return null;
  let headHashHex = '';
  for (let i = 0; i < 32; i++) headHashHex += f[32 + i].toString(16).padStart(2, '0');
  return { headLength, payloadStart: headLength, payloadLength, headHashHex };
}

/** Verify the head bytes still match the hash recorded in the footer. */
export async function verifyHead(headBytes, headHashHex) {
  return (await sha256Hex(headBytes)) === headHashHex;
}

// ── OCCT result ⇄ payload blob ──────────────────────────────────────────────
//   payload = [ u32 jsonLen ][ jsonBytes ][ binary section ]
//   json    = { v, root, meshes:[ {color, p, n, u, i} ] }  (each slot = {o,l})
//   binary  = concatenated typed-array bytes (f32 attrs, u32 index)

function _toF32(a) { return a instanceof Float32Array ? a : new Float32Array(a); }
function _toU32(a) { return a instanceof Uint32Array  ? a : new Uint32Array(a); }

// Keep only the fields buildNodeFromOcct consumes (name, meshes, children).
function _cleanRoot(node) {
  return {
    name:     node?.name ?? 'Node',
    meshes:   Array.isArray(node?.meshes) ? node.meshes.slice() : [],
    children: Array.isArray(node?.children) ? node.children.map(_cleanRoot) : [],
  };
}

export function serializeOcctResult(result) {
  const chunks = [];     // Uint8Array views, concatenated into the binary section
  let binLen = 0;
  const push = (typed) => {
    const o = binLen;
    const u8 = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    chunks.push(u8);
    binLen += u8.byteLength;
    return { o, l: typed.length };       // o = byte offset, l = element count
  };

  const meshesMeta = (result.meshes || []).map((m) => {
    const posSrc = m?.attributes?.position?.array ?? m?.attributes?.position;
    const norSrc = m?.attributes?.normal?.array   ?? m?.attributes?.normal;
    const uvSrc  = m?.attributes?.uv?.array       ?? m?.attributes?.uv;
    const idxSrc = m?.index?.array                ?? m?.index;
    return {
      color: m?.color ?? null,
      p: posSrc ? push(_toF32(posSrc)) : null,
      n: norSrc ? push(_toF32(norSrc)) : null,
      u: uvSrc  ? push(_toF32(uvSrc))  : null,
      i: idxSrc ? push(_toU32(idxSrc)) : null,
    };
  });

  const manifest  = { v: 1, root: _cleanRoot(result.root), meshes: meshesMeta };
  const jsonBytes = _enc.encode(JSON.stringify(manifest));

  const out = new Uint8Array(4 + jsonBytes.length + binLen);
  new DataView(out.buffer).setUint32(0, jsonBytes.length, true);
  out.set(jsonBytes, 4);
  let off = 4 + jsonBytes.length;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

export function deserializeOcctBlob(payload) {
  const dv      = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const jsonLen = dv.getUint32(0, true);
  const json    = JSON.parse(_dec.decode(payload.subarray(4, 4 + jsonLen)));
  const binBase = 4 + jsonLen;

  // Copy each slice into a fresh buffer (avoids byteOffset-alignment traps).
  const f32 = (slot) => {
    if (!slot) return null;
    const start = binBase + slot.o;
    return new Float32Array(payload.slice(start, start + slot.l * 4).buffer);
  };
  const u32 = (slot) => {
    if (!slot) return null;
    const start = binBase + slot.o;
    return new Uint32Array(payload.slice(start, start + slot.l * 4).buffer);
  };

  const meshes = json.meshes.map((m) => ({
    color: m.color ?? null,
    attributes: {
      position: m.p ? { array: f32(m.p) } : undefined,
      normal:   m.n ? { array: f32(m.n) } : undefined,
      uv:       m.u ? { array: f32(m.u) } : undefined,
    },
    index: m.i ? { array: u32(m.i) } : undefined,
  }));
  return { root: json.root, meshes };
}

/**
 * Assemble a baked file: [ head ][ payload ][ footer ].
 * head = the clean STEP/IGES/BREP source bytes; result = the OCCT parse result.
 *
 * @param {Uint8Array} headBytes
 * @param {object}     occtResult  { root, meshes }
 * @returns {Promise<Uint8Array>}
 */
export async function buildBakedFile(headBytes, occtResult) {
  const payload  = serializeOcctResult(occtResult);
  const hashHex  = await sha256Hex(headBytes);
  const footer   = _buildFooter(headBytes.length, payload.length, hashHex);
  const out      = new Uint8Array(headBytes.length + payload.length + footer.length);
  out.set(headBytes, 0);
  out.set(payload, headBytes.length);
  out.set(footer, headBytes.length + payload.length);
  return out;
}

export const FOOTER_BYTES = FOOTER_SIZE;
