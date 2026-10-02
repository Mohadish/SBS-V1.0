/**
 * ⬚ EDITABLE POLY — the topology and its operations (V0.3.5.9, Phase 1).
 *
 * Pure maths, no THREE, no state: testable in node. A poly is
 *   { v: number[]  (x,y,z per vertex, LOCAL to the node),
 *     f: number[][] (one index list per face, counter-clockwise seen from OUTSIDE) }
 * Faces are convex planar polygons (quads from the box and the loop cuts,
 * n-gons where a loop cut's midpoint lands on a neighbour's edge).
 *
 * Operations are the 3ds Max editable-poly gestures the user asked for:
 * select faces → move them; Shift-move = EXTRUDE (the ring of side faces is
 * built here, the move then stretches it); Alt-click an edge = LOOP CUT
 * through the strip of quads; move single vertices. Every op returns a NEW
 * poly (the caller commits it through actions.setPrimitiveParams → undo,
 * persistence, per-step stars — the primitive machinery).
 */

/** A box with its base at y = 0 (baseAtOrigin) or centred. 8 vertices, 6 quads, outward CCW. */
export function makeBoxPoly(w = 20, h = 20, d = 20, baseAtOrigin = true) {
  const x = w / 2, z = d / 2, y0 = baseAtOrigin ? 0 : -h / 2, y1 = y0 + h;
  return {
    v: [-x, y0, -z, x, y0, -z, x, y0, z, -x, y0, z, -x, y1, -z, x, y1, -z, x, y1, z, -x, y1, z],
    f: [[0, 1, 2, 3], [4, 7, 6, 5], [3, 2, 6, 7], [1, 0, 4, 5], [2, 1, 5, 6], [0, 3, 7, 4]],
  };
}

export function isPoly(p) { return !!p && Array.isArray(p.v) && Array.isArray(p.f) && p.v.length >= 9 && p.f.length > 0; }
export function clonePoly(p) { return { v: p.v.slice(), f: p.f.map(x => x.slice()) }; }

const vx = (p, i) => [p.v[i * 3], p.v[i * 3 + 1], p.v[i * 3 + 2]];

/** Newell's method — robust for any planar polygon. Unit vector, or [0,1,0] for a degenerate face. */
export function faceNormal(p, fi) {
  const f = p.f[fi]; let nx = 0, ny = 0, nz = 0;
  for (let k = 0; k < f.length; k++) {
    const a = vx(p, f[k]), b = vx(p, f[(k + 1) % f.length]);
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(nx, ny, nz);
  return l > 1e-12 ? [nx / l, ny / l, nz / l] : [0, 1, 0];
}

export function faceCentroid(p, fi) {
  const f = p.f[fi]; let x = 0, y = 0, z = 0;
  for (const i of f) { x += p.v[i * 3]; y += p.v[i * 3 + 1]; z += p.v[i * 3 + 2]; }
  return [x / f.length, y / f.length, z / f.length];
}

/** Unit average of the selected faces' normals (the extrude direction). */
export function averageNormal(p, faceIds) {
  let x = 0, y = 0, z = 0;
  for (const fi of faceIds) { const n = faceNormal(p, fi); x += n[0]; y += n[1]; z += n[2]; }
  const l = Math.hypot(x, y, z);
  return l > 1e-9 ? [x / l, y / l, z / l] : [0, 1, 0];
}

/** The vertex ids the given faces use (each once). */
export function verticesOfFaces(p, faceIds) {
  const s = new Set();
  for (const fi of faceIds) for (const i of p.f[fi]) s.add(i);
  return [...s];
}

/** Largest side of the bounding box (the scale every tolerance hangs on). */
export function polyExtent(p) {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.v.length; i += 3) for (let c = 0; c < 3; c++) { if (p.v[i + c] < mn[c]) mn[c] = p.v[i + c]; if (p.v[i + c] > mx[c]) mx[c] = p.v[i + c]; }
  return Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-6);
}

/** An in-plane basis (u, v) with u × v = n: a face wound CCW around n is CCW in (u, v). */
function _basis(n) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const t = ax < ay && ax < az ? [1, 0, 0] : ay < az ? [0, 1, 0] : [0, 0, 1];
  let u = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]];
  const l = Math.hypot(u[0], u[1], u[2]) || 1; u = [u[0] / l, u[1] / l, u[2] / l];
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  return { u, v };
}
const _proj = (p, i, u, v) => { const x = p.v[i * 3], y = p.v[i * 3 + 1], z = p.v[i * 3 + 2]; return [x * u[0] + y * u[1] + z * u[2], x * v[0] + y * v[1] + z * v[2]]; };

/**
 * V0.3.5.11 — EAR CLIPPING per face. Faces are convex quads until the first
 * Boolean; after it a face can be any simple polygon (an L around a bump, the
 * ring pieces around a pocket). Returns index triples; collinear vertices
 * (loop-cut midpoints on a neighbour, healed T-junctions) yield no triangle.
 */
export function triangulateFace(p, fi, normal = null) {
  const f = p.f[fi];
  if (f.length < 3) return [];
  if (f.length === 3) return [[f[0], f[1], f[2]]];
  const n = normal || faceNormal(p, fi);
  const { u, v } = _basis(n);
  const pts = f.map(i => _proj(p, i, u, v));
  let ext = 0;
  for (const a of pts) for (const b of pts) ext = Math.max(ext, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  const eps = Math.max(ext * ext * 1e-10, 1e-18);
  const cross = (a, b, c) => (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0]);
  // a vertex strictly inside the ear, or ON its new diagonal c→a, blocks it (the diagonal would pass through a corner)
  const inside = (q, a, b, c) => cross(a, b, q) > eps && cross(b, c, q) > eps && cross(c, a, q) > -eps;
  // Every vertex ends up in a triangle — even a straight-through one (a loop-cut
  // midpoint, a healed T-junction) — or the edge it sits on would be one segment
  // here and two in the neighbour: a crack for the Boolean engine. Real ears
  // first; a zero-area ear only when nothing else is left to clip.
  const idx = f.map((_, k) => k);
  const tris = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 100000) {
    let clipped = false, flat = -1;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
      const cr = cross(a, b, c);
      if (Math.abs(cr) <= eps) { if (flat < 0) flat = k; continue; }           // straight-through: remembered, used last
      if (cr < 0) continue;                                                     // reflex corner: not an ear
      let ok = true;
      for (const q of idx) { if (q !== a && q !== b && q !== c && inside(q, a, b, c)) { ok = false; break; } }
      if (!ok) continue;
      tris.push([f[a], f[b], f[c]]); idx.splice(k, 1); clipped = true; break;
    }
    if (clipped) continue;
    if (flat >= 0) {                                                            // only flat vertices left to clip: a zero-area ear keeps the edge split
      const a = idx[(flat + idx.length - 1) % idx.length], b = idx[flat], c = idx[(flat + 1) % idx.length];
      tris.push([f[a], f[b], f[c]]); idx.splice(flat, 1); continue;
    }
    for (let k = 1; k + 1 < idx.length; k++) tris.push([f[idx[0]], f[idx[k]], f[idx[k + 1]]]);   // numerically stuck: fan what is left
    return tris;
  }
  if (idx.length === 3) tris.push([f[idx[0]], f[idx[1]], f[idx[2]]]);
  return tris;
}

/** Coincident vertices merged, faces that collapse dropped — what a Boolean engine wants to see. */
export function weldPoly(p, eps = null) {
  const e = eps ?? polyExtent(p) * 5e-6;
  const q = 1 / e, cell = new Map(), map = new Map(), v = [];
  for (let i = 0; i < p.v.length / 3; i++) {
    const x = p.v[i * 3], y = p.v[i * 3 + 1], z = p.v[i * 3 + 2];
    const cx = Math.round(x * q), cy = Math.round(y * q), cz = Math.round(z * q);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) for (let dy = -1; dy <= 1 && found < 0; dy++) for (let dz = -1; dz <= 1 && found < 0; dz++) {
      const arr = cell.get(`${cx + dx},${cy + dy},${cz + dz}`); if (!arr) continue;
      for (const j of arr) if (Math.abs(v[j * 3] - x) <= e && Math.abs(v[j * 3 + 1] - y) <= e && Math.abs(v[j * 3 + 2] - z) <= e) { found = j; break; }
    }
    if (found < 0) { found = v.length / 3; v.push(x, y, z); const key = `${cx},${cy},${cz}`; if (!cell.has(key)) cell.set(key, []); cell.get(key).push(found); }
    map.set(i, found);
  }
  const f = [];
  for (const face of p.f) {
    const out = [];
    for (const i of face) { const j = map.get(i); if (out.length && out[out.length - 1] === j) continue; out.push(j); }
    while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
    if (out.length >= 3) f.push(out);
  }
  return { v, f };
}

/**
 * Flat, non-indexed triangle arrays for THREE (ear clipping per face) +
 * which face each triangle came from (picking) + the polygon edges (the wire).
 */
export function polyToArrays(p) {
  const tris = [];
  for (let fi = 0; fi < p.f.length; fi++) {
    for (const t of triangulateFace(p, fi)) tris.push(fi, t[0], t[1], t[2]);
  }
  const nT = tris.length / 4;
  const positions = new Float32Array(nT * 9), normals = new Float32Array(nT * 9), faceOfTri = new Uint32Array(nT);
  for (let t = 0; t < nT; t++) {
    const fi = tris[t * 4]; faceOfTri[t] = fi;
    const n = faceNormal(p, fi);
    for (let c = 0; c < 3; c++) {
      const i = tris[t * 4 + 1 + c], o = t * 9 + c * 3;
      positions[o] = p.v[i * 3]; positions[o + 1] = p.v[i * 3 + 1]; positions[o + 2] = p.v[i * 3 + 2];
      normals[o] = n[0]; normals[o + 1] = n[1]; normals[o + 2] = n[2];
    }
  }
  return { positions, normals, faceOfTri, triangles: nT };
}

/** Each polygon edge once: [ax,ay,az, bx,by,bz, …] for a LineSegments. */
export function polyEdges(p) {
  const seen = new Set(), out = [];
  for (const f of p.f) for (let k = 0; k < f.length; k++) {
    const a = f[k], b = f[(k + 1) % f.length], key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p.v[a * 3], p.v[a * 3 + 1], p.v[a * 3 + 2], p.v[b * 3], p.v[b * 3 + 1], p.v[b * 3 + 2]);
  }
  return new Float32Array(out);
}

/** Indexed triangles (welded vertices) — for the .glb export and the Boolean kernel; faceOfTri = polygon per triangle. */
export function polyToIndexed(p) {
  const indices = [], faceOfTri = [];
  for (let fi = 0; fi < p.f.length; fi++) for (const t of triangulateFace(p, fi)) { indices.push(t[0], t[1], t[2]); faceOfTri.push(fi); }
  return { positions: new Float32Array(p.v), indices: new Uint32Array(indices), faceOfTri: new Uint32Array(faceOfTri) };
}

/** True when vertex b lies on the straight segment a→c (within eps), i.e. the boundary does not turn at b. */
function _straight(V, a, b, c, eps) {
  const ex = V[c * 3] - V[a * 3], ey = V[c * 3 + 1] - V[a * 3 + 1], ez = V[c * 3 + 2] - V[a * 3 + 2];
  const len2 = ex * ex + ey * ey + ez * ez; if (len2 < eps * eps) return false;
  const wx = V[b * 3] - V[a * 3], wy = V[b * 3 + 1] - V[a * 3 + 1], wz = V[b * 3 + 2] - V[a * 3 + 2];
  const t = (wx * ex + wy * ey + wz * ez) / len2; if (t <= 0 || t >= 1) return false;
  const px = wx - ex * t, py = wy - ey * t, pz = wz - ez * t;
  return px * px + py * py + pz * pz <= eps * eps;
}

/** Positions k in face fi where the boundary really turns (a healed T-junction or a loop-cut midpoint on a neighbour is not a corner). */
export function faceCorners(p, fi, eps = null) {
  const f = p.f[fi], e = eps ?? polyExtent(p) * 1e-5, out = [];
  for (let k = 0; k < f.length; k++) if (!_straight(p.v, f[(k + f.length - 1) % f.length], f[k], f[(k + 1) % f.length], e)) out.push(k);
  return out;
}

// ── V0.3.5.11 — triangles → polygons (the way back from a Boolean) ───────────

/** P ∪ Q across their shared edge(s) as ONE simple loop, or null (a hole / a pinch would form). */
function _mergeLoops(P, Q) {
  const eP = new Set(), eQ = new Set();
  for (let k = 0; k < P.length; k++) eP.add(`${P[k]}>${P[(k + 1) % P.length]}`);
  for (let k = 0; k < Q.length; k++) eQ.add(`${Q[k]}>${Q[(k + 1) % Q.length]}`);
  const edges = [];
  for (let k = 0; k < P.length; k++) { const a = P[k], b = P[(k + 1) % P.length]; if (!eQ.has(`${b}>${a}`)) edges.push([a, b]); }
  for (let k = 0; k < Q.length; k++) { const a = Q[k], b = Q[(k + 1) % Q.length]; if (!eP.has(`${b}>${a}`)) edges.push([a, b]); }
  if (edges.length < 3) return null;
  const next = new Map();
  for (const [a, b] of edges) { if (next.has(a)) return null; next.set(a, b); }   // two ways out of a vertex = a pinch
  const out = []; const start = edges[0][0]; let cur = start;
  do { out.push(cur); cur = next.get(cur); if (cur == null || out.length > edges.length) return null; } while (cur !== start);
  return out.length === edges.length ? out : null;                                // fewer = a second loop (a hole)
}

/** Greedy: absorb edge-neighbours while the polygon stays one simple loop. All inputs coplanar, same winding. */
function _mergeCoplanar(polys) {
  const owner = new Map();
  const own = (i, on) => { const P = polys[i]; for (let k = 0; k < P.length; k++) { const key = `${P[k]}>${P[(k + 1) % P.length]}`; if (on) owner.set(key, i); else owner.delete(key); } };
  polys.forEach((_, i) => own(i, true));
  let changed = true, guard = 0;
  while (changed && guard++ < 1000000) {
    changed = false;
    for (let i = 0; i < polys.length; i++) {
      const P = polys[i]; if (!P) continue;
      for (let k = 0; k < P.length; k++) {
        const a = P[k], b = P[(k + 1) % P.length];
        const j = owner.get(`${b}>${a}`);
        if (j == null || j === i || !polys[j]) continue;
        const m = _mergeLoops(P, polys[j]);
        if (!m) continue;
        own(i, false); own(j, false);
        polys[j] = null; polys[i] = m; own(i, true);
        changed = true; break;
      }
    }
  }
  return polys.filter(Boolean);
}

/**
 * A triangle soup (non-indexed xyz triples, CCW outward — what the CSG
 * evaluator returns) → a poly: vertices welded, coplanar neighbours merged
 * into polygons (several simple ones where a hole would otherwise form),
 * T-junctions healed (a vertex sitting on another face's edge is inserted
 * there), then every vertex that is straight-through in ALL its faces dropped.
 * The result is as watertight as the soup lets it be.
 */
export function trianglesToPoly(positions, opts = {}) {
  const nT = Math.floor(positions.length / 9);
  const groupOf = opts.groupOf || null;                 // per input triangle: triangles of different groups never merge (edges kept) …
  const across = opts.mergeCoplanar ?? !groupOf;        // … unless asked to merge coplanar neighbours across groups (cleanEdges)
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nT * 9; i += 3) for (let c = 0; c < 3; c++) { const x = positions[i + c]; if (x < mn[c]) mn[c] = x; if (x > mx[c]) mx[c] = x; }
  const extent = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-6);
  const weld = opts.weldEps ?? extent * 5e-6;
  const onEps = opts.edgeEps ?? extent * 2e-5;
  // 1. weld
  const v = [], cell = new Map(), q = 1 / weld;
  const findOrAdd = (x, y, z) => {
    const cx = Math.round(x * q), cy = Math.round(y * q), cz = Math.round(z * q);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const arr = cell.get(`${cx + dx},${cy + dy},${cz + dz}`); if (!arr) continue;
      for (const i of arr) if (Math.abs(v[i * 3] - x) <= weld && Math.abs(v[i * 3 + 1] - y) <= weld && Math.abs(v[i * 3 + 2] - z) <= weld) return i;
    }
    const i = v.length / 3; v.push(x, y, z);
    const key = `${cx},${cy},${cz}`; if (!cell.has(key)) cell.set(key, []); cell.get(key).push(i);
    return i;
  };
  const tris = [], planes = [], groups = [];
  for (let t = 0; t < nT; t++) {
    const o = t * 9;
    const a = findOrAdd(positions[o], positions[o + 1], positions[o + 2]);
    const b = findOrAdd(positions[o + 3], positions[o + 4], positions[o + 5]);
    const c = findOrAdd(positions[o + 6], positions[o + 7], positions[o + 8]);
    if (a === b || b === c || a === c) continue;
    const ux = v[b * 3] - v[a * 3], uy = v[b * 3 + 1] - v[a * 3 + 1], uz = v[b * 3 + 2] - v[a * 3 + 2];
    const wx = v[c * 3] - v[a * 3], wy = v[c * 3 + 1] - v[a * 3 + 1], wz = v[c * 3 + 2] - v[a * 3 + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz);
    if (l < extent * extent * 1e-12) continue;                                   // a sliver
    nx /= l; ny /= l; nz /= l;
    tris.push([a, b, c]);
    // the plane offset is measured from the box corner, not the origin: float noise in the normal
    // times a 500 mm distance used to exceed the tolerance and leave flat faces as triangle fans
    planes.push([nx, ny, nz, nx * (v[a * 3] - mn[0]) + ny * (v[a * 3 + 1] - mn[1]) + nz * (v[a * 3 + 2] - mn[2])]);
    groups.push(groupOf ? groupOf[t] : 0);
  }
  // 2. coplanar groups across shared edges (union-find)
  const parent = tris.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const byEdge = new Map();
  tris.forEach((t, i) => { for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3], key = a < b ? `${a}-${b}` : `${b}-${a}`; if (!byEdge.has(key)) byEdge.set(key, []); byEdge.get(key).push(i); } });
  for (const list of byEdge.values()) for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
    const A = planes[list[x]], B = planes[list[y]];
    const same = groupOf && groups[list[x]] === groups[list[y]];              // one input polygon: merge even if it is slightly bent
    if (!same && !across) continue;
    if (same || (A[0] * B[0] + A[1] * B[1] + A[2] * B[2] > 1 - 1e-5 && Math.abs(A[3] - B[3]) < onEps)) parent[find(list[x])] = find(list[y]);
  }
  const sets = new Map();
  tris.forEach((t, i) => { const r = find(i); if (!sets.has(r)) sets.set(r, []); sets.get(r).push(t.slice()); });
  // 3. merge inside each set
  let f = [];
  for (const g of sets.values()) f.push(..._mergeCoplanar(g));
  // 4. heal T-junctions: a vertex lying on a face's edge (not its endpoint) joins that edge.
  // V0.3.5.14 — candidates come from a grid of cells (~1 vertex each), so a 50k-triangle
  // CAD part converts in seconds, not minutes; an edge spanning too many cells scans all.
  const nV = v.length / 3;
  const cs = Math.max(extent / Math.max(4, Math.ceil(Math.cbrt(nV))), onEps * 4);
  const cellOf = (x, c) => Math.floor((x - mn[c]) / cs);
  const grid = new Map();
  if (opts.heal !== false) for (let i = 0; i < nV; i++) {
    const key = `${cellOf(v[i * 3], 0)},${cellOf(v[i * 3 + 1], 1)},${cellOf(v[i * 3 + 2], 2)}`;
    let arr = grid.get(key); if (!arr) grid.set(key, arr = []); arr.push(i);
  }
  const candidates = (lo, hi) => {
    const a0 = cellOf(lo[0], 0), a1 = cellOf(lo[1], 1), a2 = cellOf(lo[2], 2), b0 = cellOf(hi[0], 0), b1 = cellOf(hi[1], 1), b2 = cellOf(hi[2], 2);
    if ((b0 - a0 + 1) * (b1 - a1 + 1) * (b2 - a2 + 1) > 4096) return null;
    const out = [];
    for (let x = a0; x <= b0; x++) for (let y = a1; y <= b1; y++) for (let z = a2; z <= b2; z++) { const arr = grid.get(`${x},${y},${z}`); if (arr) for (const i of arr) out.push(i); }
    return out;
  };
  if (opts.heal !== false) f = f.map(face => {
    const out = [];
    for (let k = 0; k < face.length; k++) {
      const a = face[k], b = face[(k + 1) % face.length];
      const ax = v[a * 3], ay = v[a * 3 + 1], az = v[a * 3 + 2];
      const dx = v[b * 3] - ax, dy = v[b * 3 + 1] - ay, dz = v[b * 3 + 2] - az;
      const len2 = dx * dx + dy * dy + dz * dz;
      out.push(a);
      if (len2 < onEps * onEps) continue;
      const lo = [Math.min(ax, v[b * 3]) - onEps, Math.min(ay, v[b * 3 + 1]) - onEps, Math.min(az, v[b * 3 + 2]) - onEps];
      const hi = [Math.max(ax, v[b * 3]) + onEps, Math.max(ay, v[b * 3 + 1]) + onEps, Math.max(az, v[b * 3 + 2]) + onEps];
      const on = [];
      const cand = candidates(lo, hi), nC = cand ? cand.length : nV;
      for (let q2 = 0; q2 < nC; q2++) {
        const i = cand ? cand[q2] : q2;
        if (i === a || i === b) continue;
        const x = v[i * 3], y = v[i * 3 + 1], z = v[i * 3 + 2];
        if (x < lo[0] || x > hi[0] || y < lo[1] || y > hi[1] || z < lo[2] || z > hi[2]) continue;
        const t = ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / len2;
        if (t <= 1e-6 || t >= 1 - 1e-6) continue;
        const px = ax + dx * t - x, py = ay + dy * t - y, pz = az + dz * t - z;
        if (px * px + py * py + pz * pz <= onEps * onEps && !face.includes(i)) on.push({ i, t });
      }
      on.sort((p, q3) => p.t - q3.t);
      for (const o of on) out.push(o.i);
    }
    return out;
  });
  // 5. drop vertices that are straight-through in every face using them
  const uses = new Map();
  f.forEach((face, fi) => { for (const i of face) { if (!uses.has(i)) uses.set(i, []); uses.get(i).push(fi); } });
  const straight = (face, k) => {
    const p0 = face[(k + face.length - 1) % face.length], p1 = face[k], p2 = face[(k + 1) % face.length];
    const ex = v[p2 * 3] - v[p0 * 3], ey = v[p2 * 3 + 1] - v[p0 * 3 + 1], ez = v[p2 * 3 + 2] - v[p0 * 3 + 2];
    const len2 = ex * ex + ey * ey + ez * ez; if (len2 < onEps * onEps) return false;
    const wx = v[p1 * 3] - v[p0 * 3], wy = v[p1 * 3 + 1] - v[p0 * 3 + 1], wz = v[p1 * 3 + 2] - v[p0 * 3 + 2];
    const t = (wx * ex + wy * ey + wz * ez) / len2; if (t <= 0 || t >= 1) return false;
    const px = wx - ex * t, py = wy - ey * t, pz = wz - ez * t;
    return px * px + py * py + pz * pz <= onEps * onEps;
  };
  const drop = new Set();
  for (const [i, faces] of uses) {
    let all = true;
    for (const fi of faces) { const face = f[fi]; const k = face.indexOf(i); if (!straight(face, k)) { all = false; break; } }
    if (all) drop.add(i);
  }
  if (drop.size) f = f.map(face => face.filter(i => !drop.has(i)));
  f = f.filter(face => face.length >= 3);
  // 6. compact
  const remap = new Map(), nv = [];
  for (const face of f) for (const i of face) if (!remap.has(i)) { remap.set(i, nv.length / 3); nv.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]); }
  return { v: nv, f: f.map(face => face.map(i => remap.get(i))) };
}

/** "Clean edges": coplanar neighbours merged into one polygon, straight-through vertices dropped — the loop cuts and Boolean seams that no longer bend the surface go away. */
export function cleanEdges(p) {
  const { positions, faceOfTri } = polyToArrays(p);
  const out = trianglesToPoly(positions, { groupOf: faceOfTri, mergeCoplanar: true });   // a bent quad stays one quad; coplanar neighbours merge
  return out.f.length >= 4 ? out : clonePoly(p);
}

/**
 * The closed PRISM an extrude sweeps: the region's faces at the surface (pushed
 * `eps` INTO the body when pulling out, OUT of it when pushing in — so no face
 * of the prism is coplanar with the face it starts from) and the moved cap as
 * it is in `post`, joined by the side walls. Outward winding either way; the
 * Boolean adds it (dist > 0) or cuts it away (dist < 0).
 */
export function extrusionPrism(pre, post, capIds, n, dist, eps) {
  const v = [], f = [], map = new Map();
  const shift = -Math.sign(dist) * eps;
  const add = (x, y, z) => { v.push(x, y, z); return v.length / 3 - 1; };
  for (const fi of capIds) {
    const pf = pre.f[fi], qf = post.f[fi];
    for (let k = 0; k < pf.length; k++) {
      const i = pf[k]; if (map.has(i)) continue;
      const j = qf[k];
      map.set(i, {
        s: add(pre.v[i * 3] + n[0] * shift, pre.v[i * 3 + 1] + n[1] * shift, pre.v[i * 3 + 2] + n[2] * shift),
        c: add(post.v[j * 3], post.v[j * 3 + 1], post.v[j * 3 + 2]),
      });
    }
  }
  const directed = new Set();
  for (const fi of capIds) { const pf = pre.f[fi]; for (let k = 0; k < pf.length; k++) directed.add(`${pf[k]}>${pf[(k + 1) % pf.length]}`); }
  const out = dist > 0;
  for (const fi of capIds) {
    const pf = pre.f[fi];
    const S = pf.map(i => map.get(i).s), C = pf.map(i => map.get(i).c);
    if (out) f.push(C, S.slice().reverse()); else f.push(S, C.slice().reverse());
    for (let k = 0; k < pf.length; k++) {
      const a = pf[k], b = pf[(k + 1) % pf.length];
      if (directed.has(`${b}>${a}`)) continue;
      const A = map.get(a), B = map.get(b);
      f.push(out ? [A.s, B.s, B.c, A.c] : [A.c, B.c, B.s, A.s]);
    }
  }
  return { v, f };
}

function _inPoly2(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * After the Boolean the face ids are new: find the faces of `poly` that ARE the
 * moved cap (same normal as a region face, on its plane shifted by dist·n,
 * centroid inside that region face's footprint) so the selection survives and
 * the next Shift-drag continues from there — as Max keeps it.
 */
/** A point surely INSIDE the face (the centroid of its biggest ear) — the vertex mean of an L or a C lies in the notch. */
function _interiorPoint(p, fi) {
  let best = null, bestA = -1;
  for (const [a, b, c] of triangulateFace(p, fi)) {
    const ux = p.v[b * 3] - p.v[a * 3], uy = p.v[b * 3 + 1] - p.v[a * 3 + 1], uz = p.v[b * 3 + 2] - p.v[a * 3 + 2];
    const wx = p.v[c * 3] - p.v[a * 3], wy = p.v[c * 3 + 1] - p.v[a * 3 + 1], wz = p.v[c * 3 + 2] - p.v[a * 3 + 2];
    const area = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
    if (area > bestA) { bestA = area; best = [(p.v[a * 3] + p.v[b * 3] + p.v[c * 3]) / 3, (p.v[a * 3 + 1] + p.v[b * 3 + 1] + p.v[c * 3 + 1]) / 3, (p.v[a * 3 + 2] + p.v[b * 3 + 2] + p.v[c * 3 + 2]) / 3]; }
  }
  return best || faceCentroid(p, fi);
}

export function facesOnCap(poly, pre, capIds, n, dist, eps) {
  const out = [];
  const regions = capIds.map(fi => {
    const nf = faceNormal(pre, fi); const { u, v } = _basis(nf);
    const i0 = pre.f[fi][0];
    const D = nf[0] * (pre.v[i0 * 3] + n[0] * dist) + nf[1] * (pre.v[i0 * 3 + 1] + n[1] * dist) + nf[2] * (pre.v[i0 * 3 + 2] + n[2] * dist);
    return { nf, u, v, D, pts: pre.f[fi].map(i => _proj(pre, i, u, v)) };
  });
  for (let g = 0; g < poly.f.length; g++) {
    const ng = faceNormal(poly, g), c = _interiorPoint(poly, g);
    for (const r of regions) {
      if (ng[0] * r.nf[0] + ng[1] * r.nf[1] + ng[2] * r.nf[2] < 0.999) continue;
      if (Math.abs(r.nf[0] * c[0] + r.nf[1] * c[1] + r.nf[2] * c[2] - r.D) > eps) continue;
      const pc = [c[0] * r.u[0] + c[1] * r.u[1] + c[2] * r.u[2], c[0] * r.v[0] + c[1] * r.v[1] + c[2] * r.v[2]];
      if (_inPoly2(pc, r.pts)) { out.push(g); break; }
    }
  }
  return out;
}

/** Move vertices by a local delta. */
export function moveVertices(p, ids, delta) {
  const out = clonePoly(p);
  for (const i of ids) { out.v[i * 3] += delta[0]; out.v[i * 3 + 1] += delta[1]; out.v[i * 3 + 2] += delta[2]; }
  return out;
}

/**
 * EXTRUDE a group of faces (Max's "extrude polygons, group"): the group keeps
 * its faces as the cap; every vertex the group shares with the rest of the mesh
 * is duplicated for the cap, and each boundary edge gets a side quad
 * [a, b, b', a'] whose normal follows the direction the cap is then moved in
 * (outward = an extrusion, inward = a pocket — same topology, both watertight).
 * Interior edges (shared by two group faces) get no side. Returns the new poly,
 * the cap face ids, the side face ids and the cap's vertex ids (what to move).
 */
export function extrudeFaces(p, faceIds) {
  const region = new Set(faceIds);
  const usedOutside = new Set();
  p.f.forEach((f, i) => { if (!region.has(i)) for (const v of f) usedOutside.add(v); });
  const out = clonePoly(p);
  const dup = new Map();
  const dupOf = (i) => {
    if (!usedOutside.has(i)) return i;
    if (dup.has(i)) return dup.get(i);
    const n = out.v.length / 3;
    out.v.push(p.v[i * 3], p.v[i * 3 + 1], p.v[i * 3 + 2]);
    dup.set(i, n);
    return n;
  };
  const directed = new Set();
  for (const fi of region) { const f = p.f[fi]; for (let k = 0; k < f.length; k++) directed.add(`${f[k]}>${f[(k + 1) % f.length]}`); }
  const sideIds = [];
  for (const fi of region) {
    const f = p.f[fi];
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length];
      if (directed.has(`${b}>${a}`)) continue;          // an edge inside the group
      const a2 = dupOf(a), b2 = dupOf(b);
      if (a2 === a && b2 === b) continue;               // an open boundary of the mesh itself: nothing to connect
      out.f.push([a, b, b2, a2]);
      sideIds.push(out.f.length - 1);
    }
  }
  for (const fi of region) out.f[fi] = p.f[fi].map(dupOf);
  const capIds = [...region];
  return { poly: out, capIds, sideIds, capVertexIds: verticesOfFaces(out, capIds) };
}

/**
 * LOOP CUT starting at parameter `t` along edge `ei` of face `fi` (V0.3.5.12
 * — any face, not only quads). Each face on the way is split by a chord from
 * the point where the loop enters to the point where it leaves:
 *   · a face with FOUR real corners (a quad, even one carrying extra
 *     straight-through vertices from a neighbour's cut or a healed seam)
 *     leaves on the opposite side at the same fraction — the classic strip;
 *   · any other face leaves where the in-plane perpendicular from the entry
 *     point first meets the boundary (so the loop keeps going through the
 *     n-gons a Boolean leaves behind instead of dying at them).
 * Neighbours that merely share a cut edge get the new vertex inserted. Stops
 * at an open boundary, at a corner vertex, at a face already cut, or when the
 * loop closes. Returns the new poly, the loop's vertices in order (for the
 * preview polyline) and whether it closed — or null when no face could be cut.
 */
export function loopCut(p, fi, ei, t = 0.5) {
  const out = clonePoly(p);
  const V = out.v, eps = polyExtent(p) * 1e-5;
  const at = (i) => [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const addVertex = (q) => { V.push(q[0], q[1], q[2]); return V.length / 3 - 1; };
  const insertOnEdge = (a, b, m) => {
    for (const f of out.f) for (let k = 0; k < f.length; k++) {
      const x = f[k], y = f[(k + 1) % f.length];
      if ((x === a && y === b) || (x === b && y === a)) { f.splice(k + 1, 0, m); break; }
    }
  };
  const f0 = out.f[fi];
  if (!f0 || f0.length < 3) return null;
  const a0 = f0[ei], b0 = f0[(ei + 1) % f0.length], A0 = at(a0), B0 = at(b0);
  const m0 = addVertex([A0[0] + (B0[0] - A0[0]) * t, A0[1] + (B0[1] - A0[1]) * t, A0[2] + (B0[2] - A0[2]) * t]);
  insertOnEdge(a0, b0, m0);
  const cuts = [], visited = new Set(), loop = [m0];
  let face = fi, vin = m0, closed = false;
  for (let guard = 0; guard < 100000 && face != null && !visited.has(face); guard++) {
    const f = out.f[face], m = f.length, kin = f.indexOf(vin);
    if (kin < 0 || m < 4) break;
    const corners = faceCorners(out, face, eps);
    let exit = null;                                     // { vertex } | { a, b, point }
    const onSegment = (ia, ib, s) => {                   // a point at fraction s of edge ia→ib, snapping to the ends
      const A = at(ia), B = at(ib), L = dist(A, B);
      if (s * L <= eps) return { vertex: ia };
      if ((1 - s) * L <= eps) return { vertex: ib };
      return { a: ia, b: ib, point: [A[0] + (B[0] - A[0]) * s, A[1] + (B[1] - A[1]) * s, A[2] + (B[2] - A[2]) * s] };
    };
    if (corners.length === 4 && !corners.includes(kin)) {
      const fwd = (from, to) => { const ks = []; for (let k = from; ; k = (k + 1) % m) { ks.push(k); if (k === to) break; } return ks; };
      const s = corners.findIndex((ck, i) => fwd(ck, corners[(i + 1) % 4]).includes(kin));
      const P = corners[s], Q = corners[(s + 1) % 4], R = corners[(s + 2) % 4], S = corners[(s + 3) % 4];
      const chainLen = (ks) => { let l = 0; for (let i = 0; i + 1 < ks.length; i++) l += dist(at(f[ks[i]]), at(f[ks[i + 1]])); return l; };
      const cPQ = fwd(P, Q), cSR = fwd(R, S).reverse();          // entry side P→Q, opposite side walked S→R (S across from P)
      const u = chainLen(cPQ.slice(0, cPQ.indexOf(kin) + 1)) / (chainLen(cPQ) || 1);
      const target = u * chainLen(cSR); let acc = 0;
      for (let i = 0; i + 1 < cSR.length; i++) {
        const L = dist(at(f[cSR[i]]), at(f[cSR[i + 1]]));
        if (acc + L >= target - eps || i + 2 === cSR.length) { exit = onSegment(f[cSR[i]], f[cSR[i + 1]], L > eps ? Math.max(0, Math.min(1, (target - acc) / L)) : 0); break; }
        acc += L;
      }
    } else {
      const n = faceNormal(out, face); const { u, v } = _basis(n);
      const P2 = (i) => _proj(out, i, u, v);
      const O = P2(vin), prev = P2(f[(kin + m - 1) % m]), next = P2(f[(kin + 1) % m]);
      let dx = next[0] - prev[0], dy = next[1] - prev[1]; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
      const D = [-dy, dx];                                   // the interior is to the left of the boundary direction
      let best = null;
      for (let k = 0; k < m; k++) {
        if (k === kin || (k + 1) % m === kin) continue;    // the two edges meeting at the entry vertex
        const A = P2(f[k]), B = P2(f[(k + 1) % m]);
        const ex = B[0] - A[0], ey = B[1] - A[1];
        const den = D[0] * ey - D[1] * ex; if (Math.abs(den) < 1e-12) continue;
        const sx = A[0] - O[0], sy = A[1] - O[1];
        const sRay = (sx * ey - sy * ex) / den, r = (sx * D[1] - sy * D[0]) / den;
        if (sRay <= eps || r < -1e-9 || r > 1 + 1e-9) continue;
        if (!best || sRay < best.sRay) best = { sRay, k, r: Math.max(0, Math.min(1, r)) };
      }
      if (best) exit = onSegment(f[best.k], f[(best.k + 1) % m], best.r);
    }
    if (!exit) break;
    visited.add(face);
    let vout, next = null;
    if (exit.vertex != null) {
      vout = exit.vertex;
      if (vout === vin) break;
      cuts.push({ face, vin, vout });
      if (vout === m0) { closed = true; break; }
      const others = out.f.map((ff, i) => i).filter(i => i !== face && out.f[i].includes(vout) && !faceCorners(out, i, eps).includes(out.f[i].indexOf(vout)));
      next = others.length === 1 ? others[0] : null;   // a real corner: the loop ends there
    } else {
      vout = addVertex(exit.point);
      insertOnEdge(exit.a, exit.b, vout);
      cuts.push({ face, vin, vout });
      next = out.f.findIndex((ff, i) => i !== face && ff.includes(vout));
      if (next < 0) next = null;                       // an open boundary
    }
    loop.push(vout);
    if (next == null) break;
    face = next; vin = vout;
  }
  if (!cuts.length) return null;
  for (const cu of cuts) {                             // split each cut face along its chord
    const f = out.f[cu.face], m = f.length, i = f.indexOf(cu.vin), j = f.indexOf(cu.vout);
    if (i < 0 || j < 0 || i === j || (i + 1) % m === j || (j + 1) % m === i) continue;
    const one = [], two = [];
    for (let k = i; ; k = (k + 1) % m) { one.push(f[k]); if (k === j) break; }
    for (let k = j; ; k = (k + 1) % m) { two.push(f[k]); if (k === i) break; }
    out.f[cu.face] = one; out.f.push(two);
  }
  return { poly: out, newVertexIds: loop, closed };
}

/** True when every edge is shared by exactly two faces in opposite directions (a closed, consistently wound mesh). */
export function isWatertight(p) {
  const count = new Map();
  for (const f of p.f) for (let k = 0; k < f.length; k++) {
    const a = f[k], b = f[(k + 1) % f.length];
    const d = `${a}>${b}`;
    if (count.has(d)) return false;                   // the same directed edge twice = inconsistent winding
    count.set(d, true);
  }
  for (const d of count.keys()) { const [a, b] = d.split('>'); if (!count.has(`${b}>${a}`)) return false; }
  return true;
}
