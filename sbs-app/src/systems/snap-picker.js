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
  // V0.2.22.23 — diagnostic profiling. Enable in DevTools with:
  //   window.sbsDiag = { ...window.sbsDiag, snapPerf: true };
  // Then run the 3-point pivot tool over the laggy scenario. Each
  // pointer-move logs one line: raycast time + vertex-pass time +
  // edge-pass time + mesh vert count + total. Use to determine
  // whether the bottleneck is sceneCore.pick (O(scene)) or the
  // per-mesh vertex/edge passes (O(V)).
  const _diag = typeof window !== 'undefined' && window.sbsDiag?.snapPerf;
  const _t0   = _diag ? performance.now() : 0;

  if (!window.THREE) return null;
  const T = window.THREE;

  const _tPickStart = _diag ? performance.now() : 0;
  const hit = sceneCore.pick(clientX, clientY);
  const _tPick = _diag ? performance.now() - _tPickStart : 0;

  if (!hit?.object?.isMesh) {
    if (_diag) console.log(`[snap] pick=${_tPick.toFixed(2)}ms hit=none`);
    return null;
  }
  const mesh = hit.object;
  const geom = mesh.geometry;
  const posAttr = geom?.attributes?.position;
  if (!posAttr) {
    if (_diag) console.log(`[snap] pick=${_tPick.toFixed(2)}ms mesh=${mesh.name||'?'} no-geom → face`);
    return { type: 'face', point: hit.point.clone(), mesh };
  }

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
  const _tVertStart = _diag ? performance.now() : 0;
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
  const _tVert = _diag ? performance.now() - _tVertStart : 0;

  if (bestVertIdx >= 0 && Math.sqrt(bestVertDist2) <= SNAP_RADIUS_PX) {
    const v = new T.Vector3(
      arr[bestVertIdx * 3],
      arr[bestVertIdx * 3 + 1],
      arr[bestVertIdx * 3 + 2],
    ).applyMatrix4(matrixWorld);
    if (_diag) console.log(`[snap] mesh=${mesh.name||'?'} V=${count} pick=${_tPick.toFixed(2)} vert=${_tVert.toFixed(2)} total=${(performance.now()-_t0).toFixed(2)}ms → vertex`);
    return { type: 'vertex', point: v, mesh };
  }

  // ── Edge pass ───────────────────────────────────────────────────────────
  const _tEdgeStart = _diag ? performance.now() : 0;
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
  const _tEdge = _diag ? performance.now() - _tEdgeStart : 0;

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
    if (_diag) console.log(`[snap] mesh=${mesh.name||'?'} V=${count} E=${edges.length/2} pick=${_tPick.toFixed(2)} vert=${_tVert.toFixed(2)} edge=${_tEdge.toFixed(2)} total=${(performance.now()-_t0).toFixed(2)}ms → edge`);
    return { type: 'edge', point: world, mesh, edgeA, edgeB };
  }

  // ── Fallback: face hit point ────────────────────────────────────────────
  if (_diag) console.log(`[snap] mesh=${mesh.name||'?'} V=${count} E=${edges.length/2} pick=${_tPick.toFixed(2)} vert=${_tVert.toFixed(2)} edge=${_tEdge.toFixed(2)} total=${(performance.now()-_t0).toFixed(2)}ms → face`);
  return { type: 'face', point: hit.point.clone(), mesh };
}

// Feature-edge threshold in degrees. Adjacent triangles whose normals
// differ by MORE than this contribute their shared edge as a "feature"
// (silhouette / crease / boundary). Triangles whose normals are within
// the threshold are considered coplanar — their shared edge is interior
// tessellation noise and gets dropped. 30° is a good general default
// for mechanical CAD (sharp cube corners ≈ 90°, gentle curves on a
// tessellated cylinder ≈ 5-15°). Boundary edges (only one adjacent
// triangle, e.g. mesh hole edges) are always kept.
const FEATURE_EDGE_DEG = 30;

/**
 * Build (and cache) the FEATURE-edge index list for a BufferGeometry.
 * Returns a flat Int32Array of [a0, b0, a1, b1, …] where each pair is
 * the indices of one undirected feature edge.
 *
 * V0.2.22.25 — was: every triangle edge (every diagonal of every
 * tessellated quad). For curved/tessellated surfaces this gave the snap
 * picker thousands of meaningless interior edges to choose from, and it
 * almost always picked one of those instead of the visible feature edge
 * the user was actually aiming for. User reported: "Yellow lines that
 * are popping up. It is not very helpful — on the contrary, it's the
 * worst one. Rarely is it ever doing something useful."
 *
 * Now: an edge is kept iff
 *   • it has only one adjacent triangle (mesh boundary), OR
 *   • its two adjacent triangles' normals differ by > FEATURE_EDGE_DEG.
 * Interior edges between coplanar (or near-coplanar) triangles are
 * dropped. Matches THREE.EdgesGeometry's filter logic.
 *
 * Indexed and non-indexed geometries are both supported.
 */
function _getEdgeIndices(geom) {
  const cached = _edgeCache.get(geom.uuid);
  if (cached) return cached;

  const idx = geom.index?.array;
  const pos = geom.attributes.position;
  if (!pos) {
    const empty = new Int32Array(0);
    _edgeCache.set(geom.uuid, empty);
    return empty;
  }
  const posArr = pos.array;
  const triCount = idx
    ? Math.floor(idx.length / 3)
    : Math.floor(pos.count / 3);

  // Edge map: "i<j" → { i, j, normals: [Vec3, Vec3?] }
  const edgeMap = new Map();
  const cosThreshold = Math.cos(FEATURE_EDGE_DEG * Math.PI / 180);

  // Reusable vectors for normal computation.
  const ax = (i) => posArr[i * 3];
  const ay = (i) => posArr[i * 3 + 1];
  const az = (i) => posArr[i * 3 + 2];

  function addEdge(i, j, nx, ny, nz) {
    const a = i < j ? i : j;
    const b = i < j ? j : i;
    const key = `${a},${b}`;
    let rec = edgeMap.get(key);
    if (!rec) { rec = { i: a, j: b, n: [] }; edgeMap.set(key, rec); }
    rec.n.push(nx, ny, nz);
  }

  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx[t * 3]     : t * 3;
    const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
    const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
    // Compute triangle normal via cross product (unnormalised).
    const e1x = ax(i1) - ax(i0), e1y = ay(i1) - ay(i0), e1z = az(i1) - az(i0);
    const e2x = ax(i2) - ax(i0), e2y = ay(i2) - ay(i0), e2z = az(i2) - az(i0);
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nLen = Math.hypot(nx, ny, nz);
    if (nLen < 1e-12) continue;  // degenerate triangle — skip
    nx /= nLen; ny /= nLen; nz /= nLen;
    addEdge(i0, i1, nx, ny, nz);
    addEdge(i1, i2, nx, ny, nz);
    addEdge(i2, i0, nx, ny, nz);
  }

  const out = [];
  for (const rec of edgeMap.values()) {
    if (rec.n.length === 3) {
      // Boundary edge — exactly one adjacent triangle. Always keep.
      out.push(rec.i, rec.j);
    } else if (rec.n.length >= 6) {
      // Two (or more — non-manifold) adjacent triangles. Keep iff the
      // normals diverge MORE than the feature threshold. We compare just
      // the first two — that's the standard case; non-manifold edges
      // are vanishingly rare in CAD meshes.
      const dot = rec.n[0] * rec.n[3] + rec.n[1] * rec.n[4] + rec.n[2] * rec.n[5];
      if (dot < cosThreshold) out.push(rec.i, rec.j);
    }
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
