/**
 * ⬚ POLY CONVERT (V0.3.5.14) — any mesh geometry → an editable poly.
 *
 * A three.js BufferGeometry (indexed or not: a primitive, a tessellated STEP
 * part, a GLB mesh) becomes { v, f } in the geometry's OWN space: triangles
 * welded, coplanar neighbours merged into polygons (a box comes back as six
 * quads, a cylinder as n-gon caps + a ring of quads, a curved CAD face stays
 * triangles — that is the tessellation, it is not re-modelled). The caller
 * keeps the object's world transform beside the poly.
 */
import { trianglesToPoly } from './poly-core.js';

/** Triangle soup (xyz per corner) of a BufferGeometry, honouring the index and the draw range. */
export function geometrySoup(geometry) {
  const pos = geometry?.attributes?.position;
  if (!pos) return new Float32Array(0);
  const index = geometry.index?.array || null;
  const start = geometry.drawRange?.start || 0;
  const countAll = index ? index.length : pos.count;
  const count = Math.min(geometry.drawRange?.count ?? Infinity, countAll - start);
  const nT = Math.floor(count / 3);
  const out = new Float32Array(nT * 9);
  for (let t = 0; t < nT; t++) for (let c = 0; c < 3; c++) {
    const vi = index ? index[start + t * 3 + c] : start + t * 3 + c;
    out[t * 9 + c * 3] = pos.getX(vi); out[t * 9 + c * 3 + 1] = pos.getY(vi); out[t * 9 + c * 3 + 2] = pos.getZ(vi);   // the accessors know interleaved + normalised buffers
  }
  return out;
}

/** A BufferGeometry → poly (local space). Returns null for an empty geometry. */
export function geometryToPoly(geometry, opts = {}) {
  const soup = geometrySoup(geometry);
  if (soup.length < 9) return null;
  const p = trianglesToPoly(soup, opts);
  return p.f.length ? p : null;
}

/** How many triangles a geometry draws (the budget check before converting a huge CAD part). */
export function geometryTriangles(geometry) {
  const pos = geometry?.attributes?.position; if (!pos) return 0;
  const index = geometry.index?.array || null;
  const start = geometry.drawRange?.start || 0;
  const countAll = index ? index.length : pos.count;
  return Math.floor(Math.min(geometry.drawRange?.count ?? Infinity, countAll - start) / 3);
}
