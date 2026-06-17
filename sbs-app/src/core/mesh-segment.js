/**
 * mesh-segment.js (V0.3.0.29) — split a mesh's triangles into COPLANAR FLAT
 * regions, the geometry-space way the outline / shape-from-face already use
 * (flood-fill by face-normal angle). Each large coplanar region is a candidate
 * flat mirror plane; the small/fragmented leftovers are curved surface → SSR.
 *
 * Stage 2a is detection + a debug viz only (colour each region). The region
 * geometry it extracts is reused later to build the actual per-face mirrors.
 */

/**
 * @returns Array<{ tris:number[], areaLocal, normalLocal:Vector3, centerLocal:Vector3 }>
 * sorted largest-area first. Normals/centres are in MESH-LOCAL space.
 */
export function segmentMeshFaces(mesh, angleDeg = 5, flatTolDeg = 3) {
  const THREE = window.THREE;
  const geo = mesh.geometry;
  const pos = geo && geo.getAttribute('position');
  if (!pos) return [];
  const idx = geo.getIndex();
  const triCount = idx ? (idx.count / 3) : (pos.count / 3);
  const vIndex = (t, k) => (idx ? idx.getX(t * 3 + k) : (t * 3 + k));

  // Per-triangle normal / centroid / area (local space).
  const triN = new Array(triCount);
  const triC = new Array(triCount);
  const triArea = new Float32Array(triCount);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), nn = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    a.fromBufferAttribute(pos, vIndex(t, 0));
    b.fromBufferAttribute(pos, vIndex(t, 1));
    c.fromBufferAttribute(pos, vIndex(t, 2));
    ab.subVectors(b, a); ac.subVectors(c, a);
    nn.crossVectors(ab, ac);
    const len = nn.length();
    triArea[t] = len * 0.5;
    triN[t] = len > 1e-12 ? nn.clone().multiplyScalar(1 / len) : new THREE.Vector3(0, 0, 1);
    triC[t] = new THREE.Vector3().addVectors(a, b).add(c).multiplyScalar(1 / 3);
  }

  // Edge adjacency via quantized endpoint hashing (works indexed or not, and
  // across duplicated verts at hard edges).
  const Q = 1e4;
  const ptKey = (i) => `${Math.round(pos.getX(i) * Q)},${Math.round(pos.getY(i) * Q)},${Math.round(pos.getZ(i) * Q)}`;
  const edgeKey = (i, j) => { const pa = ptKey(i), pb = ptKey(j); return pa < pb ? pa + '|' + pb : pb + '|' + pa; };
  const edgeMap = new Map();
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const e = edgeKey(vIndex(t, k), vIndex(t, (k + 1) % 3));
      let arr = edgeMap.get(e); if (!arr) { arr = []; edgeMap.set(e, arr); }
      arr.push(t);
    }
  }
  const adj = (t) => {
    const out = [];
    for (let k = 0; k < 3; k++) {
      const arr = edgeMap.get(edgeKey(vIndex(t, k), vIndex(t, (k + 1) % 3)));
      if (arr) for (const o of arr) if (o !== t) out.push(o);
    }
    return out;
  };

  // Flood-fill: grow a region while neighbours stay within angleDeg of the seed
  // normal (keeps each region genuinely flat, not just smoothly connected).
  const cosThresh = Math.cos(angleDeg * Math.PI / 180);
  const visited = new Uint8Array(triCount);
  const regions = [];
  for (let s = 0; s < triCount; s++) {
    if (visited[s]) continue;
    const seedN = triN[s];
    const tris = [s]; visited[s] = 1;
    const queue = [s];
    while (queue.length) {
      const t = queue.pop();
      for (const o of adj(t)) {
        if (visited[o]) continue;
        if (triN[o].dot(seedN) >= cosThresh) { visited[o] = 1; tris.push(o); queue.push(o); }
      }
    }
    let area = 0;
    const avgN = new THREE.Vector3(), cen = new THREE.Vector3();
    for (const t of tris) { area += triArea[t]; avgN.addScaledVector(triN[t], triArea[t]); cen.addScaledVector(triC[t], triArea[t]); }
    if (area < 1e-9) continue;
    avgN.normalize(); cen.multiplyScalar(1 / area);
    // Planarity: a TRUE flat face has ~all its area within a tight tolerance of
    // the region normal. A curved band (cylinder slice) spans the flood angle →
    // fails this → stays curved (SSR), not a mirror.
    const flatCos = Math.cos(flatTolDeg * Math.PI / 180);
    let flatArea = 0;
    for (const t of tris) if (triN[t].dot(avgN) >= flatCos) flatArea += triArea[t];
    const flat = (flatArea / area) >= 0.95;
    regions.push({ tris, areaLocal: area, normalLocal: avgN, centerLocal: cen, flat });
  }
  regions.sort((A, B) => B.areaLocal - A.areaLocal);
  return regions;
}

/** Local-space BufferGeometry of one region's triangles (non-indexed). */
export function regionGeometry(mesh, region) {
  const THREE = window.THREE;
  const pos = mesh.geometry.getAttribute('position');
  const idx = mesh.geometry.getIndex();
  const vIndex = (t, k) => (idx ? idx.getX(t * 3 + k) : (t * 3 + k));
  const verts = new Float32Array(region.tris.length * 9);
  const v = new THREE.Vector3();
  let o = 0;
  for (const t of region.tris) for (let k = 0; k < 3; k++) {
    v.fromBufferAttribute(pos, vIndex(t, k));
    verts[o++] = v.x; verts[o++] = v.y; verts[o++] = v.z;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * In-plane elongation of a flat region (long axis / short axis), via 2-D PCA of
 * its vertices projected onto the region plane. A square/disc face → ~1; a chamfer
 * or thin edge strip → high. Orientation-independent (catches diagonal slivers).
 */
export function regionAspect(mesh, region) {
  const THREE = window.THREE;
  const pos = mesh.geometry.getAttribute('position');
  const idx = mesh.geometry.getIndex();
  const vIndex = (t, k) => (idx ? idx.getX(t * 3 + k) : (t * 3 + k));
  const n  = region.normalLocal;
  const up = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u  = new THREE.Vector3().crossVectors(up, n).normalize();
  const v  = new THREE.Vector3().crossVectors(n, u).normalize();
  const p  = new THREE.Vector3();
  let cnt = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (const t of region.tris) for (let k = 0; k < 3; k++) {
    p.fromBufferAttribute(pos, vIndex(t, k));
    const a = p.dot(u), b = p.dot(v);
    sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; cnt++;
  }
  if (cnt < 2) return 1;
  const ma = sa / cnt, mb = sb / cnt;
  const vaa = saa / cnt - ma * ma, vbb = sbb / cnt - mb * mb, vab = sab / cnt - ma * mb;
  const tr = vaa + vbb, det = vaa * vbb - vab * vab;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  return Math.sqrt(l1 / Math.max(l2, 1e-12));
}

/** Debug viz: overlay each region as a translucent flat colour on the mesh. */
export function buildRegionViz(mesh, regions, maxRegions = 40) {
  const THREE = window.THREE;
  const group = new THREE.Group();
  group.name = '__segmentViz';
  let ci = 0;
  for (const r of regions.slice(0, maxRegions)) {
    let color, opacity;
    if (r.flat) { color = new THREE.Color().setHSL((ci * 0.6180339887) % 1, 0.78, 0.55); ci++; opacity = 0.8; }
    else        { color = new THREE.Color(0x1a1a1a); opacity = 0.35; }   // curved → excluded from mirrors
    const m = new THREE.Mesh(regionGeometry(mesh, r), new THREE.MeshBasicMaterial({
      color, side: THREE.DoubleSide, transparent: true, opacity,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }));
    m.renderOrder = 999;
    m.userData.noSelect = true;
    group.add(m);
  }
  mesh.add(group);   // child → inherits the mesh's world transform
  return group;
}
