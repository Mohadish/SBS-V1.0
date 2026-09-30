/**
 * 🩹 NORMAL REPAIR (V0.3.4.171) — a mesh whose stored vertex normals do not belong
 * to its faces gets new ones, in place.
 *
 * The case: joint.obj from 3ds Max (guruware OBJ exporter) — every `vn` lies 90°
 * off its face (a face in the XY plane carries vn (1,0,0)). Three's OBJLoader
 * loads them faithfully; the SBS shader flipped them against the view vector
 * (faceforward) and drew a hard line across every plate where dot(N, V) crossed
 * zero — the user's "environment box" lines (V0.3.4.168/.169 made the shader
 * robust to it; this fixes the data at the door).
 *
 * measureNormals(): the angle between each triangle's geometric normal (from its
 * winding) and the mean of its three vertex normals, on a sample. A healthy mesh
 * reads a few degrees; this OBJ reads ~90°.
 *
 * repairNormalsIfBad(): when more than `badFrac` of the sample is tilted past
 * `tiltDeg`, rebuild the normals: per position (welded on a rounded key), the
 * area-weighted sum of the adjacent face normals within `creaseDeg` of the
 * corner's own face — smooth across a cylinder, sharp at a sheet-metal edge —
 * WRITTEN INTO THE EXISTING ATTRIBUTE. Vertex count, index and order never
 * change: the geometry fingerprint the stable node ids hang on (vertex count +
 * face count + bbox) stays identical, so an existing project still finds its
 * parts. Pure maths on THREE objects.
 */

/** @returns {{tris:number, meanDeg:number, maxDeg:number, tiltedFrac:number, flippedFrac:number}|null} */
export function measureNormals(geometry, { sampleTris = 4000, tiltDeg = 30 } = {}) {
  const T = globalThis.THREE;
  const pos = geometry?.attributes?.position, nor = geometry?.attributes?.normal, idx = geometry?.index;
  if (!pos || !nor) return null;
  const tris = idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
  if (!tris) return null;
  const step = Math.max(1, Math.floor(tris / sampleTris));
  const a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3();
  const ng = new T.Vector3(), nv = new T.Vector3(), t1 = new T.Vector3(), t2 = new T.Vector3();
  const cosTilt = Math.cos(tiltDeg * Math.PI / 180);
  let n = 0, tilted = 0, flipped = 0, sum = 0, max = 0;
  for (let t = 0; t < tris; t += step) {
    const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    ng.subVectors(b, a).cross(t2.subVectors(c, a));
    if (ng.lengthSq() < 1e-24) continue;
    ng.normalize();
    nv.fromBufferAttribute(nor, i0).add(t1.fromBufferAttribute(nor, i1)).add(t2.fromBufferAttribute(nor, i2));
    if (nv.lengthSq() < 1e-12) { n++; tilted++; sum += 90; if (max < 90) max = 90; continue; }   // V0.3.4.181 — a zero normal is unusable, not healthy
    nv.normalize();
    const d = Math.max(-1, Math.min(1, ng.dot(nv)));
    const ang = Math.acos(d) * 180 / Math.PI;
    n++; sum += ang; if (ang > max) max = ang; if (d < cosTilt) tilted++; if (d < 0) flipped++;
  }
  if (!n) return { tris, meanDeg: 90, maxDeg: 90, tiltedFrac: 1, flippedFrac: 0 };   // nothing measurable → treat as bad
  return { tris, meanDeg: sum / n, maxDeg: max, tiltedFrac: tilted / n, flippedFrac: flipped / n };
}

/**
 * Rebuild the normals in place (see the header). Returns what was measured and
 * whether it rebuilt. `force` rebuilds regardless; a geometry without normals
 * always gets them.
 */
export function repairNormalsIfBad(geometry, { creaseDeg = 30, tiltDeg = 30, badFrac = 0.2, force = false } = {}) {
  const T = globalThis.THREE;
  const pos = geometry?.attributes?.position;
  if (!pos) return { repaired: false, measure: null };
  const hadNormals = !!geometry.attributes.normal;
  const measure = hadNormals ? measureNormals(geometry, { tiltDeg }) : null;
  const bad = !hadNormals || force || !measure || measure.tiltedFrac > badFrac;
  if (!bad) return { repaired: false, measure };

  const idx = geometry.index;
  const tris = idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
  const vi = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);

  // Per-triangle area-weighted normal.
  const faceN = new Float32Array(tris * 3);
  const a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3(), ng = new T.Vector3(), t2 = new T.Vector3();
  for (let t = 0; t < tris; t++) {
    a.fromBufferAttribute(pos, vi(t, 0)); b.fromBufferAttribute(pos, vi(t, 1)); c.fromBufferAttribute(pos, vi(t, 2));
    ng.subVectors(b, a).cross(t2.subVectors(c, a));           // |ng| = 2 × area
    faceN[t * 3] = ng.x; faceN[t * 3 + 1] = ng.y; faceN[t * 3 + 2] = ng.z;
  }

  // Weld by position: key → the triangles touching that position.
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const size = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z, 1e-9);
  const q = size * 1e-6;                                      // weld tolerance: a millionth of the part
  const keyOf = (i) => `${Math.round(pos.getX(i) / q)},${Math.round(pos.getY(i) / q)},${Math.round(pos.getZ(i) / q)}`;
  const byPos = new Map();
  const cornerKey = new Array(tris * 3);
  for (let t = 0; t < tris; t++) for (let k = 0; k < 3; k++) {
    const key = keyOf(vi(t, k));
    cornerKey[t * 3 + k] = key;
    let list = byPos.get(key);
    if (!list) { list = []; byPos.set(key, list); }
    if (list[list.length - 1] !== t) list.push(t);
  }

  // Each corner: the sum of the adjacent faces within the crease of its own face.
  // V0.3.4.181 — on INDEXED geometry a vertex shared across a crease would take
  // whichever corner wrote it last (order-dependent). Such a vertex gets the plain
  // welded average instead (no crease) — smooth there, deterministic everywhere.
  const cosCrease = Math.cos(creaseDeg * Math.PI / 180) - 1e-4;   // V0.3.4.185 — float slack: facets EXACTLY creaseDeg apart (12-sided cylinders) weld on every corner, never per-corner by rounding
  const out = new Float32Array(pos.count * 3);
  const written = new Uint8Array(pos.count);
  const conflict = idx ? new Uint8Array(pos.count) : null;
  const fn = new T.Vector3(), on = new T.Vector3(), acc = new T.Vector3();
  for (let t = 0; t < tris; t++) {
    fn.set(faceN[t * 3], faceN[t * 3 + 1], faceN[t * 3 + 2]);
    const fl = fn.length();
    if (fl < 1e-30) continue;
    fn.divideScalar(fl);
    for (let k = 0; k < 3; k++) {
      acc.set(0, 0, 0);
      for (const o of byPos.get(cornerKey[t * 3 + k])) {
        on.set(faceN[o * 3], faceN[o * 3 + 1], faceN[o * 3 + 2]);
        const ol = on.length();
        if (ol < 1e-30) continue;
        if (on.dot(fn) / ol >= cosCrease) acc.add(on);       // within the crease → smooth across it
      }
      if (acc.lengthSq() < 1e-30) acc.copy(fn);
      acc.normalize();
      const v = vi(t, k);
      if (conflict && written[v] && !conflict[v]) {
        const dx = out[v * 3] - acc.x, dy = out[v * 3 + 1] - acc.y, dz = out[v * 3 + 2] - acc.z;
        if (dx * dx + dy * dy + dz * dz > 1e-6) conflict[v] = 1;
      }
      out[v * 3] = acc.x; out[v * 3 + 1] = acc.y; out[v * 3 + 2] = acc.z;
      written[v] = 1;
    }
  }
  if (conflict) {
    for (let v = 0; v < pos.count; v++) {
      if (!conflict[v]) continue;
      acc.set(0, 0, 0);
      for (const o of byPos.get(keyOf(v)) || []) acc.add(on.set(faceN[o * 3], faceN[o * 3 + 1], faceN[o * 3 + 2]));
      if (acc.lengthSq() < 1e-30) continue;
      acc.normalize();
      out[v * 3] = acc.x; out[v * 3 + 1] = acc.y; out[v * 3 + 2] = acc.z;
    }
  }
  // Vertices no triangle references: keep what they had (V0.3.4.185 — a
  // normal attribute can be SHARED between primitives that index it
  // differently, e.g. a multi-material GLB; stamping an up vector there
  // corrupted the sibling's vertices), else a harmless up vector.
  const attr = geometry.attributes.normal;
  for (let v = 0; v < pos.count; v++) {
    if (written[v]) continue;
    if (attr) { out[v * 3] = attr.getX(v); out[v * 3 + 1] = attr.getY(v); out[v * 3 + 2] = attr.getZ(v); }
    else { out[v * 3] = 0; out[v * 3 + 1] = 1; out[v * 3 + 2] = 0; }
  }

  // Write in place only into a plain float attribute (V0.3.4.185 — a
  // quantized/normalized Int8 or Int16 normal, KHR_mesh_quantization, would
  // have truncated the floats to 0/±1); anything else gets a fresh attribute.
  if (attr && attr.array instanceof Float32Array && !attr.normalized && attr.array.length === out.length && !attr.isInterleavedBufferAttribute) {
    attr.array.set(out);
    attr.needsUpdate = true;
  } else {
    geometry.setAttribute('normal', new T.BufferAttribute(out, 3));
  }
  return { repaired: true, measure };
}
