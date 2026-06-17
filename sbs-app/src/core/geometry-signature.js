/**
 * geometry-signature.js (V0.3.0.48) — a rotation/translation-invariant fingerprint
 * of a mesh's geometry, for "Select Similar" (pick one screw → select every matching
 * instance). In a CAD assembly, repeated parts (screws, nuts, washers) are instances
 * of the SAME geometry, so identical fingerprints group them reliably — far more
 * robust than trying to classify "screw-ness" from head topology.
 *
 * Signature = triangleCount | vertexCount | sorted local bbox dims | volume, each
 * quantised to ~4 significant figures so minor float drift across instances still
 * matches. Counts + volume are orientation-independent; sorting the bbox dims removes
 * axis-order dependence; both are independent of where/how the part sits in the scene.
 */

/** Round to `digits` significant figures, as a stable string key. */
function _sig(x, digits = 4) {
  if (!isFinite(x) || x === 0) return '0';
  const m = Math.pow(10, digits - 1 - Math.floor(Math.log10(Math.abs(x))));
  return String(Math.round(x * m) / m);
}

/** 6× the (unsigned) volume — sum of origin tetrahedra over all triangles. */
function _volume6(pos, triCount, vIndex) {
  const THREE = window.THREE;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cr = new THREE.Vector3();
  let v = 0;
  for (let t = 0; t < triCount; t++) {
    a.fromBufferAttribute(pos, vIndex(t, 0));
    b.fromBufferAttribute(pos, vIndex(t, 1));
    c.fromBufferAttribute(pos, vIndex(t, 2));
    cr.crossVectors(b, c);
    v += a.dot(cr);
  }
  return Math.abs(v);
}

/** Geometry fingerprint string, or null if the mesh has no position data. */
export function geometrySignature(mesh) {
  const geo = mesh && mesh.geometry;
  const pos = geo && geo.getAttribute && geo.getAttribute('position');
  if (!pos) return null;
  const idx = geo.getIndex();
  const triCount = idx ? (idx.count / 3) : (pos.count / 3);
  const vIndex = (t, k) => (idx ? idx.getX(t * 3 + k) : (t * 3 + k));
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const dims = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z].sort((a, b) => a - b);
  const vol = _volume6(pos, triCount, vIndex);
  return `${triCount}|${pos.count}|${_sig(dims[0])}|${_sig(dims[1])}|${_sig(dims[2])}|${_sig(vol)}`;
}
