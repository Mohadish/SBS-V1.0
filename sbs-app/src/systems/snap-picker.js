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

  // V0.2.22.29 — when snapPerf is on, also dump every visible hit
  // under the cursor (not just the first). Use to verify that pick()
  // is returning the FOREGROUND mesh and not a behind-it one. If the
  // user reports snap landing on a deeper mesh, look here first.
  if (_diag) {
    try {
      const allHits = sceneCore.pickAll?.(clientX, clientY) || [];
      if (allHits.length > 1) {
        console.log(`[snap] all hits (${allHits.length}):`,
          allHits.map(h => `${h.object.name||'?'}@${h.distance.toFixed(2)}`).join(', '));
      }
    } catch {/* ignore */}
  }

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

  // V0.2.22.28 — compute the hit point's NDC depth. Use this to discard
  // candidate verts/edges that sit BEHIND the hit point (e.g. the back
  // rim of a cylinder when the cursor is over the front face). Without
  // this depth cull, the back-facing rim of a cylinder projects to
  // nearly the same screen-Y as the front silhouette and routinely
  // wins the screen-distance contest, causing the snap point to land
  // on the FAR side of the geometry — the "furthest intersection"
  // behaviour the user reported.
  const _hitV = new T.Vector3(hit.point.x, hit.point.y, hit.point.z).project(camera);
  const hitDepthZ = _hitV.z;
  // Small tolerance so a vert that's coplanar with the hit face still
  // qualifies (e.g. a corner vertex on the very face that was hit).
  const DEPTH_TOL = 0.002;

  // Project a 3D world point to canvas pixels. Returns [x, y, z(ndc)]
  // or null if behind the camera (NDC z > 1).
  const tmpV = new T.Vector3();
  function projectToPixels(local) {
    tmpV.set(local[0], local[1], local[2]).applyMatrix4(matrixWorld);
    const ndc = tmpV.project(camera);
    if (ndc.z > 1 || ndc.z < -1) return null;
    return [
      ( ndc.x + 1) * halfW,
      (-ndc.y + 1) * halfH,
      ndc.z,
    ];
  }

  // V0.2.22.30 — visibility test. Casts a ray from the camera through a
  // world point and checks whether the hit mesh occludes it. Catches
  // intra-mesh occlusion (e.g. an edge on the back side of a complex
  // shape hidden by the same shape's front). Inter-mesh occlusion (other
  // meshes blocking the view) NOT covered — would need scene-wide
  // raycast per candidate (10× cost). The hit mesh handles the most
  // common case the user actually cares about.
  //
  // Returns true if the world point is "visible" — no surface of the
  // hit mesh sits between the camera and it (within tolerance).
  const _vizRaycaster = new T.Raycaster();
  const _vizDir       = new T.Vector3();
  const _camPos       = camera.position;
  const VIZ_TOL_WORLD = 0.0001;   // small to avoid self-occlusion at the same surface
  function isVisibleWorldPoint(worldP) {
    _vizDir.subVectors(worldP, _camPos);
    const distToP = _vizDir.length();
    if (distToP < 1e-9) return true;
    _vizDir.normalize();
    _vizRaycaster.set(_camPos, _vizDir);
    // intersect against ONLY the hit mesh — saves the scene-wide cost.
    const hits = _vizRaycaster.intersectObject(mesh, false);
    if (!hits.length) return true;
    // Any nearer hit means a surface of THIS mesh occludes the point.
    return hits[0].distance >= distToP - VIZ_TOL_WORLD;
  }

  // ── Vertex pass ─────────────────────────────────────────────────────────
  // V0.2.22.30 — collect-and-filter pattern. Gather every vert within
  // SNAP_RADIUS_PX (already depth-culled), sort by screen distance,
  // visibility-test each in order, return first visible. Drops the
  // best-only short-circuit so that an "almost-closest" but VISIBLE
  // vert can win over a "marginally-closer" but OCCLUDED one (e.g.
  // a back-side vert that projected lucky).
  const _tVertStart = _diag ? performance.now() : 0;
  const _MAX_VERT_CANDIDATES = 8;
  const vertCandidates = [];   // {idx, dist2, depth}
  let _vertCulled   = 0;
  const arr = posAttr.array;
  const count = posAttr.count;
  const snapR2 = SNAP_RADIUS_PX * SNAP_RADIUS_PX;
  const buf = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    buf[0] = arr[i * 3];
    buf[1] = arr[i * 3 + 1];
    buf[2] = arr[i * 3 + 2];
    const px = projectToPixels(buf);
    if (!px) continue;
    if (px[2] > hitDepthZ + DEPTH_TOL) { if (_diag) _vertCulled++; continue; }
    const dx = px[0] - cursorX;
    const dy = px[1] - cursorY;
    const d2 = dx * dx + dy * dy;
    if (d2 > snapR2) continue;
    vertCandidates.push({ idx: i, dist2: d2, depth: px[2] });
  }
  vertCandidates.sort((a, b) => a.dist2 - b.dist2);
  const _tVert = _diag ? performance.now() - _tVertStart : 0;

  // Visibility-test candidates in screen-distance order; first visible wins.
  let _vertVizFailed = 0;
  let _vertChosenDepth = 0;
  for (let k = 0; k < Math.min(vertCandidates.length, _MAX_VERT_CANDIDATES); k++) {
    const c = vertCandidates[k];
    const v = new T.Vector3(
      arr[c.idx * 3],
      arr[c.idx * 3 + 1],
      arr[c.idx * 3 + 2],
    ).applyMatrix4(matrixWorld);
    if (!isVisibleWorldPoint(v)) { _vertVizFailed++; continue; }
    _vertChosenDepth = c.depth;
    if (_diag) console.log(`[snap] mesh=${mesh.name||'?'} V=${count} culled=${_vertCulled} cand=${vertCandidates.length} vizFail=${_vertVizFailed} hitZ=${hitDepthZ.toFixed(4)} pickZ=${_vertChosenDepth.toFixed(4)} pick=${_tPick.toFixed(2)} vert=${_tVert.toFixed(2)} total=${(performance.now()-_t0).toFixed(2)}ms → vertex`);
    return { type: 'vertex', point: v, mesh };
  }

  // ── Edge pass ───────────────────────────────────────────────────────────
  // V0.2.22.30 — collect + visibility-filter, same pattern as the vert pass.
  const _tEdgeStart = _diag ? performance.now() : 0;
  const edgePos = _getEdgePositions(geom);
  const edgeSegCount = edgePos.length / 6;
  const _MAX_EDGE_CANDIDATES = 8;
  const edgeCandidates = [];   // {idx, t, dist2, depth}
  let _edgeCulled = 0;
  const a = [0, 0, 0], b = [0, 0, 0];
  for (let e = 0; e < edgeSegCount; e++) {
    const off = e * 6;
    a[0] = edgePos[off];     a[1] = edgePos[off + 1]; a[2] = edgePos[off + 2];
    b[0] = edgePos[off + 3]; b[1] = edgePos[off + 4]; b[2] = edgePos[off + 5];
    const pa = projectToPixels(a);
    if (!pa) continue;
    const pb = projectToPixels(b);
    if (!pb) continue;
    if (pa[2] > hitDepthZ + DEPTH_TOL && pb[2] > hitDepthZ + DEPTH_TOL) {
      if (_diag) _edgeCulled++;
      continue;
    }
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
    if (d2 > snapR2) continue;
    edgeCandidates.push({
      idx: e, t, dist2: d2,
      depth: pa[2] * (1 - t) + pb[2] * t,
    });
  }
  edgeCandidates.sort((a, b) => a.dist2 - b.dist2);
  const _tEdge = _diag ? performance.now() - _tEdgeStart : 0;

  // Visibility-test candidates in screen-distance order; first visible wins.
  let _edgeVizFailed = 0;
  for (let k = 0; k < Math.min(edgeCandidates.length, _MAX_EDGE_CANDIDATES); k++) {
    const c = edgeCandidates[k];
    const off = c.idx * 6;
    const ax = edgePos[off],     ay = edgePos[off + 1], az = edgePos[off + 2];
    const bx = edgePos[off + 3], by = edgePos[off + 4], bz = edgePos[off + 5];
    const t = c.t;
    const local = new T.Vector3(
      ax + (bx - ax) * t,
      ay + (by - ay) * t,
      az + (bz - az) * t,
    );
    const world = local.clone().applyMatrix4(matrixWorld);
    if (!isVisibleWorldPoint(world)) { _edgeVizFailed++; continue; }
    const edgeA = new T.Vector3(ax, ay, az).applyMatrix4(matrixWorld);
    const edgeB = new T.Vector3(bx, by, bz).applyMatrix4(matrixWorld);
    if (_diag) console.log(`[snap] mesh=${mesh.name||'?'} V=${count} E=${edgeSegCount} eCulled=${_edgeCulled} eCand=${edgeCandidates.length} eVizFail=${_edgeVizFailed} hitZ=${hitDepthZ.toFixed(4)} pickZ=${c.depth.toFixed(4)} pick=${_tPick.toFixed(2)} vert=${_tVert.toFixed(2)} edge=${_tEdge.toFixed(2)} total=${(performance.now()-_t0).toFixed(2)}ms → edge`);
    return { type: 'edge', point: world, mesh, edgeA, edgeB };
  }

  // ── Fallback: face hit point ────────────────────────────────────────────
  if (_diag) console.log(`[snap] mesh=${mesh.name||'?'} V=${count} E=${edgeSegCount} eCulled=${_edgeCulled} eCand=${edgeCandidates.length} eVizFail=${_edgeVizFailed} hitZ=${hitDepthZ.toFixed(4)} pick=${_tPick.toFixed(2)} vert=${_tVert.toFixed(2)} edge=${_tEdge.toFixed(2)} total=${(performance.now()-_t0).toFixed(2)}ms → face`);
  return { type: 'face', point: hit.point.clone(), mesh };
}

// Feature-edge threshold in degrees. Adjacent triangles whose normals
// differ by MORE than this contribute their shared edge as a "feature"
// (silhouette / crease / boundary). Triangles whose normals are within
// the threshold are considered coplanar — their shared edge is interior
// tessellation noise and gets dropped. Boundary edges (only one adjacent
// triangle, e.g. mesh hole edges) are always kept.
//
// V0.2.22.26 — default raised 30 → 45. The 30 value still pulled in
// tessellation seams on coarse cylinders / shallow chamfers. 45 catches
// only HARD features (90° machined corners, drilled-hole rims, sharp
// cutoffs) which the user identified as the snap targets they care
// about. Tunable at runtime via DevTools:
//   window.sbsDiag = { ...window.sbsDiag, snapEdgeDeg: 60 };
// Lower (15-30) = catch softer features incl. tessellation seams.
// Higher (60-90) = only the SHARPEST features.
const FEATURE_EDGE_DEG_DEFAULT = 45;
function _featureEdgeThreshold() {
  const t = typeof window !== 'undefined' ? window.sbsDiag?.snapEdgeDeg : null;
  return Number.isFinite(t) ? t : FEATURE_EDGE_DEG_DEFAULT;
}

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
function _getEdgePositions(geom) {
  const thresholdDeg = _featureEdgeThreshold();
  const cacheKey = `${geom.uuid}@${thresholdDeg}`;
  const cached = _edgeCache.get(cacheKey);
  if (cached) return cached;

  const T = window.THREE;
  if (!T?.EdgesGeometry || !geom?.attributes?.position) {
    const empty = new Float32Array(0);
    _edgeCache.set(cacheKey, empty);
    return empty;
  }

  // V0.2.22.27 — switched from in-house index-keyed filter to Three.js's
  // EdgesGeometry. Reason: SBS's baked / flattened meshes (after FBX/OBJ
  // import + bake pass) often have UN-SHARED vertices — every triangle
  // owns its own copies of its 3 corners, even when two triangles touch.
  // The previous filter keyed edges by vertex INDEX, so it never found
  // any shared edges → every edge was classified as a "boundary edge"
  // (one adjacent triangle) → kept regardless of threshold. Result:
  // every triangle hypotenuse showed as a snap target. Matches user
  // report: "lots of hits on interior edges of flat faces."
  //
  // Three.js EdgesGeometry merges vertices by POSITION (with epsilon)
  // before building adjacency, then keeps only edges whose adjacent
  // triangle normals diverge by > thresholdDeg. The output is a flat
  // Float32 position buffer: [ax,ay,az, bx,by,bz, …] — one pair per
  // feature edge segment, no index lookup needed.
  const edgesGeo = new T.EdgesGeometry(geom, thresholdDeg);
  const positions = edgesGeo.attributes.position?.array
    ?? new Float32Array(0);
  // Free the wrapping geometry — we keep only the position buffer.
  // (Buffer is a Float32Array view; detaching the geometry's index/attrs
  // for GC is just hygiene.)
  edgesGeo.dispose?.();
  _edgeCache.set(cacheKey, positions);
  return positions;
}

/**
 * Drop the cached edge list for a given BufferGeometry. Call when the
 * INDEX BUFFER changes (e.g. tessellation rebuild). Vertex-position
 * mutations alone do not invalidate this cache.
 */
export function invalidateSnapCache(geom) {
  if (!geom?.uuid) return;
  // V0.2.22.26 — cache key now includes the threshold; drop every entry
  // whose key starts with this geometry's uuid.
  const prefix = geom.uuid + '@';
  for (const key of _edgeCache.keys()) {
    if (key.startsWith(prefix)) _edgeCache.delete(key);
  }
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
