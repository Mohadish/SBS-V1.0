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

/**
 * Flat, non-indexed triangle arrays for THREE (fan triangulation per face) +
 * which face each triangle came from (picking) + the polygon edges (the wire).
 */
export function polyToArrays(p) {
  const tris = [];
  for (let fi = 0; fi < p.f.length; fi++) {
    const f = p.f[fi];
    for (let k = 1; k + 1 < f.length; k++) tris.push(fi, f[0], f[k], f[k + 1]);
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

/** Indexed triangles (welded vertices) — for the .glb export. */
export function polyToIndexed(p) {
  const indices = [];
  for (const f of p.f) for (let k = 1; k + 1 < f.length; k++) indices.push(f[0], f[k], f[k + 1]);
  return { positions: new Float32Array(p.v), indices: new Uint32Array(indices) };
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
 * LOOP CUT through the strip of quads starting at edge `ei` of face `fi`:
 * every quad in the strip is split in two at parameter `t` along the cut edge
 * (consistently oriented along the strip), the neighbours that merely touch a
 * cut edge get the new vertex inserted (they become n-gons — still planar and
 * convex). Stops at a non-quad, at an open boundary, or when the loop closes.
 */
export function loopCut(p, fi, ei, t = 0.5) {
  const out = clonePoly(p);
  const key = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const facesOfEdge = new Map();
  out.f.forEach((f, i) => { for (let k = 0; k < f.length; k++) { const kk = key(f[k], f[(k + 1) % f.length]); if (!facesOfEdge.has(kk)) facesOfEdge.set(kk, []); facesOfEdge.get(kk).push(i); } });
  const cuts = [];                       // { face, e1:[from,to], e2:[from,to] } oriented so from↔from across the strip
  const visited = new Set();
  let face = fi, entry = [out.f[fi][ei], out.f[fi][(ei + 1) % out.f[fi].length]];
  const startKey = key(entry[0], entry[1]);
  for (let guard = 0; guard < 100000 && face != null && !visited.has(face); guard++) {
    const f = out.f[face];
    if (f.length !== 4) break;
    let k = f.findIndex((v, i) => v === entry[0] && f[(i + 1) % 4] === entry[1]);
    let flipped = false;
    if (k < 0) { k = f.findIndex((v, i) => v === entry[1] && f[(i + 1) % 4] === entry[0]); flipped = true; }
    if (k < 0) break;
    // quad [a,b,c,d] with the entry edge at k: a=f[k], b=f[k+1]; opposite = (d, c) with d adjacent to a
    const a = f[k], b = f[(k + 1) % 4], c = f[(k + 2) % 4], d = f[(k + 3) % 4];
    const e1 = flipped ? [b, a] : [a, b];               // oriented like `entry`
    const e2 = flipped ? [c, d] : [d, c];               // the vertex across from e1[0] first
    visited.add(face);
    cuts.push({ face, e1, e2, a, b, c, d, flipped });
    if (key(e2[0], e2[1]) === startKey) break;          // the loop closed
    const next = (facesOfEdge.get(key(e2[0], e2[1])) || []).find(x => x !== face);
    if (next == null) break;
    entry = e2; face = next;
  }
  if (!cuts.length) return null;
  // one midpoint per cut edge, t measured from the ORIENTED from-vertex (consistent along the strip)
  const mid = new Map();
  const midOf = (from, to) => {
    const kk = key(from, to);
    if (mid.has(kk)) return mid.get(kk);
    const n = out.v.length / 3;
    for (let c = 0; c < 3; c++) out.v.push(out.v[from * 3 + c] + (out.v[to * 3 + c] - out.v[from * 3 + c]) * t);
    mid.set(kk, n);
    return n;
  };
  const cutKeys = new Set();
  for (const cu of cuts) { cutKeys.add(key(cu.e1[0], cu.e1[1])); cutKeys.add(key(cu.e2[0], cu.e2[1])); }
  // split the strip quads: [a,b,c,d] → [a, m1, m2, d] + [m1, b, c, m2]
  const stripFaces = new Set(cuts.map(cu => cu.face));
  for (const cu of cuts) {
    const m1 = midOf(cu.e1[0], cu.e1[1]);
    const m2 = midOf(cu.e2[0], cu.e2[1]);
    // m1 sits on (a,b), m2 on (d,c) in the quad's own order
    out.f[cu.face] = [cu.a, m1, m2, cu.d];
    out.f.push([m1, cu.b, cu.c, m2]);
  }
  // neighbours touching a cut edge but not in the strip: insert the midpoint between the two vertices
  for (let i = 0; i < out.f.length; i++) {
    if (stripFaces.has(i) || i >= p.f.length) continue;
    const f = out.f[i];
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length];
      const kk = key(a, b);
      if (!cutKeys.has(kk) || !mid.has(kk)) continue;
      f.splice(k + 1, 0, mid.get(kk));
      k++;
    }
  }
  return { poly: out, newVertexIds: [...mid.values()] };
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
