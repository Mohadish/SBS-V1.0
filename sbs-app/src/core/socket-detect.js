/**
 * socket-detect.js (V0.3.0.49) — detect a HEX socket / head on a mesh, so all hex
 * fasteners (Allen-socket screws, hex bolt heads, hex nuts) can be selected at once
 * regardless of length. A hex has 6 flat walls evenly spaced ~60° around an axis; we
 * measure that as the 6-fold rotational symmetry (R6) of the flat-face normals around
 * a candidate axis:  R6 = |Σ area·e^{i·6·θ}| / Σ area.  R6≈1 → clean hex; a round
 * shaft (many evenly-spaced facets) or random faces cancel to R6≈0.
 *
 * Spike scope / known limits:
 *  - Candidate axes are the LOCAL X/Y/Z (covers axis-aligned parts — the common CAD
 *    case). A part modelled at an angle in its own local frame may be missed.
 *  - R6 is computed over ALL walls (not yet isolated to the head band), so a heavily
 *    tessellated shaft can dilute the score. If the real model under-detects, the fix
 *    is to bin walls by axial position and take the best band.
 */
import { segmentMeshFaces } from './mesh-segment.js';

/**
 * @returns {null | { hasHex, score, axis, radius, walls }} — `score` is R6 in [0,1].
 *   Returns null if the mesh can't be analysed or scores below minScore.
 *   Pass minScore:0 to always get the best score back (for inspection).
 */
export function detectHex(mesh, { minScore = 0.8, angleDeg = 5 } = {}) {
  const THREE = window.THREE;
  const geo = mesh && mesh.geometry;
  if (!geo || !geo.getAttribute || !geo.getAttribute('position')) return null;
  const regions = segmentMeshFaces(mesh, angleDeg).filter(r => r.flat);
  if (regions.length < 5) return null;                 // need ~6 walls
  if (!geo.boundingBox) geo.computeBoundingBox();
  const center = geo.boundingBox.getCenter(new THREE.Vector3());

  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  let best = null;
  for (const axis of axes) {
    const up = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(up, axis).normalize();
    const v = new THREE.Vector3().crossVectors(axis, u).normalize();
    let sumW = 0, re = 0, im = 0, walls = 0, radSum = 0;
    for (const r of regions) {
      const n = r.normalLocal;
      if (Math.abs(n.dot(axis)) > 0.35) continue;       // ~parallel to axis → top/bottom, not a wall
      const theta = Math.atan2(n.dot(v), n.dot(u));
      const w = r.areaLocal;
      re += w * Math.cos(6 * theta);
      im += w * Math.sin(6 * theta);
      sumW += w; walls++;
      const d = r.centerLocal.clone().sub(center);
      const along = d.dot(axis);
      radSum += d.sub(axis.clone().multiplyScalar(along)).length();
    }
    if (walls < 5 || sumW <= 0) continue;
    const R6 = Math.sqrt(re * re + im * im) / sumW;
    if (!best || R6 > best.score) best = { score: R6, axis: axis.clone(), walls, radius: radSum / walls };
  }
  if (!best) return null;
  if (best.score < minScore) return null;
  return { hasHex: best.score >= 0.8, score: best.score, axis: best.axis, radius: best.radius, walls: best.walls };
}
