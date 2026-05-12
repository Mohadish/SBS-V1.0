/**
 * SBS Step Browser — Snap Picker
 * =================================
 * Screen-space vertex + edge snapping for tools that need precise
 * geometric anchor points (e.g. the 3-point center pivot tool).
 *
 * Strategy
 * --------
 * 1. Raycast through the cursor with sceneCore.pick → find the hit mesh.
 *    No hit = no snap target (the user isn't pointing at geometry).
 * 2. Within that mesh's BufferGeometry, find:
 *      a) the closest vertex to the cursor in SCREEN PIXELS,
 *      b) the closest edge (line segment between two vertices) to the
 *         cursor in screen pixels.
 * 3. If a vertex sits within R_PX of the cursor, snap to that vertex.
 *    Vertices win over edges — they are the strongest features.
 * 4. Else if an edge sits within R_PX, snap to a point on that edge
 *    (3D position interpolated by the screen-space parameter).
 * 5. Else fall back to the raycast hit point on the face surface.
 *
 * Performance
 * -----------
 * Brute-force per pointer event: O(V) for vertex test, O(E) for edge
 * test, where V/E live on the SINGLE hit mesh (not the whole scene).
 * For typical mechanical-CAD meshes (≤ 50 k verts) this is fine on a
 * 60 fps loop. If it ever lags we can cache projected positions per
 * frame keyed off camera matrix uuid.
 *
 * Three.js is window.THREE.
 */

import { sceneCore } from '../core/scene.js';

// Screen-space snap radius in CSS pixels. Roughly twice the typical
// cursor "feel" of CAD tools — generous enough to grab a vertex you're
// near, tight enough to not pull off the wrong one.
const SNAP_RADIUS_PX = 14;

// Cache for derived edge index lists, keyed by BufferGeometry.uuid.
// Built lazily on first edge test of a given mesh; survives until the
// geometry is replaced (e.g. via source-transform bake — that mutates
// vertex positions in place but keeps the same index buffer, so the
// cached edge list is still valid).
const _edgeCache = new Map();

/**
 * Find the best snap target under the cursor. Returns:
 *   { type: 'vertex'|'edge'|'face', point: THREE.Vector3, mesh: THREE.Mesh }
 * or null if the cursor isn't over any geometry.
 *
 * - 'vertex' / 'edge' = snapped (point lies exactly on geometry).
 * - 'face'            = no vertex/edge close enough; fallback to the
 *                       raycast hit point on the face surface.
 *
 * @param {number} clientX
 * @param {number} clientY
 */
export function findSnapTarget(clientX, clientY) {
  if (!window.THREE) return null;
  const T = window.THREE;

  const hit = sceneCore.pick(clientX, clientY);
  if (!hit?.object?.isMesh) return null;
  const mesh = hit.object;
  const geom = mesh.geometry;
  const posAttr = geom?.attributes?.position;
  if (!posAttr) return { type: 'face', point: hit.point.clone(), mesh };

  // Cursor in screen pixels relative to the renderer canvas.
  const rect = sceneCore.renderer.domElement.getBoundingClientRect();
  const cursorX = clientX - rect.left;
  const cursorY = clientY - rect.top;
  const halfW = rect.width  * 0.5;
  const halfH = rect.height * 0.5;

  mesh.updateMatrixWorld();
  const matrixWorld = mesh.matrixWorld;
  const camera = sceneCore.camera;

  // Project a 3D world point to canvas pixels. Returns null if behind
  // the camera (NDC z > 1).
  const tmpV = new T.Vector3();
  function projectToPixels(local) {
    tmpV.set(local[0], local[1], local[2]).applyMatrix4(matrixWorld);
    const ndc = tmpV.project(camera);
    if (ndc.z > 1 || ndc.z < -1) return null;
    return [
      ( ndc.x + 1) * halfW,
      (-ndc.y + 1) * halfH,
    ];
  }

  // ── Vertex pass ─────────────────────────────────────────────────────────
  let bestVertIdx   = -1;
  let bestVertDist2 = Infinity;
  const arr = posAttr.array;
  const count = posAttr.count;
  const buf = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    buf[0] = arr[i * 3];
    buf[1] = arr[i * 3 + 1];
    buf[2] = arr[i * 3 + 2];
    const px = projectToPixels(buf);
    if (!px) continue;
    const dx = px[0] - cursorX;
    const dy = px[1] - cursorY;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestVertDist2) {
      bestVertDist2 = d2;
      bestVertIdx   = i;
    }
  }

  if (bestVertIdx >= 0 && Math.sqrt(bestVertDist2) <= SNAP_RADIUS_PX) {
    const v = new T.Vector3(
      arr[bestVertIdx * 3],
      arr[bestVertIdx * 3 + 1],
      arr[bestVertIdx * 3 + 2],
    ).applyMatrix4(matrixWorld);
    return { type: 'vertex', point: v, mesh };
  }

  // ── Edge pass ───────────────────────────────────────────────────────────
  const edges = _getEdgeIndices(geom);
  let bestEdgeKey = -1;
  let bestEdgeT   = 0;
  let bestEdgeDist2 = Infinity;
  const a = [0, 0, 0], b = [0, 0, 0];
  for (let e = 0; e < edges.length; e += 2) {
    const ia = edges[e], ib = edges[e + 1];
    a[0] = arr[ia * 3]; a[1] = arr[ia * 3 + 1]; a[2] = arr[ia * 3 + 2];
    b[0] = arr[ib * 3]; b[1] = arr[ib * 3 + 1]; b[2] = arr[ib * 3 + 2];
    const pa = projectToPixels(a);
    if (!pa) continue;
    const pb = projectToPixels(b);
    if (!pb) continue;
    // Closest point on line segment pa-pb to cursor in screen space.
    const sx = pb[0] - pa[0], sy = pb[1] - pa[1];
    const seg2 = sx * sx + sy * sy;
    let t = 0.5;
    if (seg2 > 1e-3) {
      t = ((cursorX - pa[0]) * sx + (cursorY - pa[1]) * sy) / seg2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
    }
    const cx = pa[0] + sx * t;
    const cy = pa[1] + sy * t;
    const dx = cx - cursorX, dy = cy - cursorY;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestEdgeDist2) {
      bestEdgeDist2 = d2;
      bestEdgeT     = t;
      bestEdgeKey   = e;
    }
  }

  if (bestEdgeKey >= 0 && Math.sqrt(bestEdgeDist2) <= SNAP_RADIUS_PX) {
    const ia = edges[bestEdgeKey], ib = edges[bestEdgeKey + 1];
    const ax = arr[ia * 3], ay = arr[ia * 3 + 1], az = arr[ia * 3 + 2];
    const bx = arr[ib * 3], by = arr[ib * 3 + 1], bz = arr[ib * 3 + 2];
    const t = bestEdgeT;
    const local = new T.Vector3(
      ax + (bx - ax) * t,
      ay + (by - ay) * t,
      az + (bz - az) * t,
    );
    // Edge endpoints in world space — exported alongside the snap
    // point so the caller can draw a highlight along the whole edge.
    const edgeA = new T.Vector3(ax, ay, az).applyMatrix4(matrixWorld);
    const edgeB = new T.Vector3(bx, by, bz).applyMatrix4(matrixWorld);
    const world = local.applyMatrix4(matrixWorld);
    return { type: 'edge', point: world, mesh, edgeA, edgeB };
  }

  // ── Fallback: face hit point ────────────────────────────────────────────
  return { type: 'face', point: hit.point.clone(), mesh };
}

/**
 * Build (and cache) the unique-edge index list for a BufferGeometry.
 * Returns a flat Int32Array of [a0, b0, a1, b1, …] where each pair is
 * the indices of one undirected edge.
 *
 * Indexed and non-indexed geometries are both supported. Each triangle
 * contributes its 3 edges; duplicates (shared between adjacent
 * triangles) are filtered via a sorted-pair key.
 */
function _getEdgeIndices(geom) {
  const cached = _edgeCache.get(geom.uuid);
  if (cached) return cached;

  const seen = new Set();
  const out = [];
  const idx = geom.index?.array;
  const triCount = idx ? Math.floor(idx.length / 3) : Math.floor((geom.attributes.position?.count ?? 0) / 3);
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx[t * 3]     : t * 3;
    const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
    const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const pairs = [
      i0 < i1 ? `${i0},${i1}` : `${i1},${i0}`,
      i1 < i2 ? `${i1},${i2}` : `${i2},${i1}`,
      i2 < i0 ? `${i2},${i0}` : `${i0},${i2}`,
    ];
    if (!seen.has(pairs[0])) { seen.add(pairs[0]); out.push(i0, i1); }
    if (!seen.has(pairs[1])) { seen.add(pairs[1]); out.push(i1, i2); }
    if (!seen.has(pairs[2])) { seen.add(pairs[2]); out.push(i2, i0); }
  }
  const arr = new Int32Array(out);
  _edgeCache.set(geom.uuid, arr);
  return arr;
}

/**
 * Drop the cached edge list for a given BufferGeometry. Call when the
 * INDEX BUFFER changes (e.g. tessellation rebuild). Vertex-position
 * mutations alone do not invalidate this cache.
 */
export function invalidateSnapCache(geom) {
  if (geom?.uuid) _edgeCache.delete(geom.uuid);
}

/**
 * Project a world-space point to canvas pixels. Used by tools that
 * need to hit-test their own placed markers in screen space.
 * Returns [x, y] in canvas-relative pixels, or null if behind camera.
 */
export function worldToCanvasPixels(worldPoint) {
  if (!window.THREE || !sceneCore?.camera || !sceneCore.renderer) return null;
  const T = window.THREE;
  const rect = sceneCore.renderer.domElement.getBoundingClientRect();
  const v = new T.Vector3(worldPoint.x, worldPoint.y, worldPoint.z).project(sceneCore.camera);
  if (v.z > 1 || v.z < -1) return null;
  return [
    ( v.x + 1) * rect.width  * 0.5,
    (-v.y + 1) * rect.height * 0.5,
  ];
}
