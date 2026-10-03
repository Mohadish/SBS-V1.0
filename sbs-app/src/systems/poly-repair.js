/**
 * FIX OBJECT — the repair maths for a poly that came in broken.
 *
 * Pure maths like poly-core.js: no THREE, no DOM, no state, testable in node.
 * "Broken" = STL-like triangle soups (every triangle with its own corners),
 * copies of a vertex a hair apart, faces collapsed to a line or a point, the
 * same face twice, cracks (T-junctions) and open holes.
 *
 *   repairPoly(p, eps) = weldNear → cleanDegenerate → capHoles, timed.
 *
 * eps is the user's weld distance (model units). The UI runs repairPoly while
 * the distance is dragged and paints `clusters` (merged spots) and `capFaces`
 * (new faces) red before the user approves; every function returns a NEW poly.
 */
import { clonePoly, faceNormal, polyExtent, triangulateFace } from './poly-core.js';

const _now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

// ── weld ─────────────────────────────────────────────────────────────────────

// The forward half of the 5×5×5 block around a cell: with a cell side of eps/√3, ±2 cells
// reach eps; half of them, so each pair of cells is tested once.
const _FWD = [];
for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
  if (dx > 0 || (dx === 0 && (dy > 0 || (dy === 0 && dz > 0)))) _FWD.push(dx, dy, dz);
}

/**
 * WELD: vertices closer than eps become one. Chains merge (a, b, c each within
 * eps of the next become one even when a and c are farther apart); the merged
 * vertex sits at the average of its cluster. Faces are remapped, repeated
 * corners squeezed out, then cleanDegenerate(…, eps) runs. Vertices no face
 * uses take no part. eps ≤ 0 welds only coincident copies (within 1e-9 × size).
 * Returns { poly,
 *   clusters: [[x,y,z]…]   — every merged spot whose originals were at DIFFERENT positions (the red dots),
 *   clustersCoincident: n — merged spots that were exact copies only (a soup's seams: too many to paint),
 *   dropped: n            — faces cleanDegenerate removed }.
 */
export function weldNear(p, eps) {
  const V = p.v, n = (V.length / 3) | 0;
  const e = eps > 0 ? eps : polyExtent(p) * 1e-9;
  const e2 = e * e, s = e / Math.sqrt(3);           // any two points in ONE cell are within e: a cell welds whole, no pair test
  const used = new Uint8Array(n);
  for (const f of p.f) for (const i of f) if (i >= 0 && i < n) used[i] = 1;
  // cells in an open-addressing table keyed on the exact integer cell: a hash clash costs a probe, never a false weld
  let cap = 16; while (cap < n * 2) cap <<= 1;
  const mask = cap - 1, table = new Int32Array(cap).fill(-1);
  const CX = new Float64Array(n), CY = new Float64Array(n), CZ = new Float64Array(n);
  const head = new Int32Array(n), nextV = new Int32Array(n), cellOf = new Int32Array(n).fill(-1);
  let nCells = 0;
  const slot = (x, y, z) => {
    let h = Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = (h ^ (h >>> 12)) & mask;
    for (;;) { const c = table[h]; if (c < 0 || (CX[c] === x && CY[c] === y && CZ[c] === z)) return h; h = (h + 1) & mask; }
  };
  for (let i = 0; i < n; i++) {
    if (!used[i]) continue;
    const x = Math.floor(V[i * 3] / s), y = Math.floor(V[i * 3 + 1] / s), z = Math.floor(V[i * 3 + 2] / s);
    const h = slot(x, y, z);
    let c = table[h];
    if (c < 0) { c = table[h] = nCells++; CX[c] = x; CY[c] = y; CZ[c] = z; head[c] = -1; }
    nextV[i] = head[c]; head[c] = i; cellOf[i] = c;
  }
  // union-find over the cells; a neighbour cell already in the same cluster costs no pair test
  const parent = new Int32Array(nCells);
  for (let c = 0; c < nCells; c++) parent[c] = c;
  const root = (c) => { while (parent[c] !== c) { parent[c] = parent[parent[c]]; c = parent[c]; } return c; };
  for (let a = 0; a < nCells; a++) {
    const ax = CX[a], ay = CY[a], az = CZ[a];
    for (let o = 0; o < _FWD.length; o += 3) {
      const b = table[slot(ax + _FWD[o], ay + _FWD[o + 1], az + _FWD[o + 2])];
      if (b < 0) continue;
      const ra = root(a), rb = root(b);
      if (ra === rb) continue;
      pair: for (let i = head[a]; i >= 0; i = nextV[i]) {
        const x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2];
        for (let j = head[b]; j >= 0; j = nextV[j]) {
          const dx = V[j * 3] - x, dy = V[j * 3 + 1] - y, dz = V[j * 3 + 2] - z;
          if (dx * dx + dy * dy + dz * dz <= e2) { parent[ra] = rb; break pair; }
        }
      }
    }
  }
  // one new vertex per cluster, numbered in the order of its first original
  const idx = new Int32Array(nCells).fill(-1), map = new Int32Array(n).fill(-1);
  const sum = [], cnt = [], firstOf = [], moved = [];
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (cellOf[i] < 0) continue;
    const r = root(cellOf[i]);
    let k = idx[r];
    if (k < 0) { k = idx[r] = m++; sum.push(0, 0, 0); cnt.push(0); firstOf.push(i); moved.push(false); }
    map[i] = k; cnt[k]++;
    sum[k * 3] += V[i * 3]; sum[k * 3 + 1] += V[i * 3 + 1]; sum[k * 3 + 2] += V[i * 3 + 2];
    const f0 = firstOf[k] * 3;
    if (!moved[k] && (V[i * 3] !== V[f0] || V[i * 3 + 1] !== V[f0 + 1] || V[i * 3 + 2] !== V[f0 + 2])) moved[k] = true;
  }
  const v = new Array(m * 3), clusters = [];
  let clustersCoincident = 0;
  for (let k = 0; k < m; k++) {
    if (moved[k]) {
      const c = cnt[k];
      v[k * 3] = sum[k * 3] / c; v[k * 3 + 1] = sum[k * 3 + 1] / c; v[k * 3 + 2] = sum[k * 3 + 2] / c;
      clusters.push([v[k * 3], v[k * 3 + 1], v[k * 3 + 2]]);
    } else {                                           // exact copies keep their exact position (an average can drift an ulp)
      const f0 = firstOf[k] * 3;
      v[k * 3] = V[f0]; v[k * 3 + 1] = V[f0 + 1]; v[k * 3 + 2] = V[f0 + 2];
      if (cnt[k] > 1) clustersCoincident++;
    }
  }
  const f = p.f.map(face => {
    const out = [];
    for (const i of face) { const j = i >= 0 && i < n ? map[i] : -1; if (out.length && out[out.length - 1] === j) continue; out.push(j); }
    while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
    return out;
  });
  const clean = cleanDegenerate({ v, f }, eps);
  return { poly: clean.poly, clusters, clustersCoincident, dropped: clean.dropped };
}

// ── degenerate faces ─────────────────────────────────────────────────────────

/** A face as SIMPLE loops: repeats squeezed out, a pass through the same vertex twice cut there (a pinch after a weld). [] = a corner that is no vertex. */
function _simpleLoops(face, nV, stamp, pos, tag) {
  const out = [], st = [];
  for (const i of face) {
    if (!(i >= 0 && i < nV) || (i | 0) !== i) return [];
    if (st.length && st[st.length - 1] === i) continue;
    if (stamp[i] === tag) {                            // back at a vertex of this walk: what lies between is a loop of its own
      const j = pos[i];
      out.push(st.slice(j));
      for (let k = j + 1; k < st.length; k++) stamp[st[k]] = -1;
      st.length = j + 1;
      continue;
    }
    stamp[i] = tag; pos[i] = st.length; st.push(i);
  }
  out.push(st);
  return out;
}

/** Twice the area over the longest edge: ~ how thick the face is (a sliver, a line → 0), whatever its length. */
function _thickness(V, L) {
  let nx = 0, ny = 0, nz = 0, longest = 0;
  for (let k = 0; k < L.length; k++) {
    const a = L[k] * 3, b = L[(k + 1) % L.length] * 3;
    const ax = V[a], ay = V[a + 1], az = V[a + 2], bx = V[b], by = V[b + 1], bz = V[b + 2];
    nx += (ay - by) * (az + bz); ny += (az - bz) * (ax + bx); nz += (ax - bx) * (ay + by);
    const l = (bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2;
    if (l > longest) longest = l;
  }
  return longest > 0 ? Math.hypot(nx, ny, nz) / Math.sqrt(longest) : 0;
}

/**
 * DEGENERATE FACES OUT. A face needs at least 3 distinct corners and a real
 * area: repeated corners are squeezed out, a face passing the same vertex
 * twice is split there into its simple loops, and a loop thinner than
 * max(eps/100, 1e-6 × size) (twice its area over its longest edge — a
 * collapsed face, a T-junction filler) is dropped. The same face twice keeps
 * ONE copy; the same face in BOTH windings loses both (two solids glued face
 * to face, a zero-thickness fin: an inner wall, not skin). A face with a
 * corner that is no vertex is dropped. Unused vertices are compacted away
 * (relative order kept). Returns { poly, dropped: faces removed }.
 */
export function cleanDegenerate(p, eps = null) {
  const V = p.v, nV = (V.length / 3) | 0;
  const tol = Math.max(eps > 0 ? eps * 0.01 : 0, polyExtent(p) * 1e-6);
  const stamp = new Int32Array(nV).fill(-1), pos = new Int32Array(nV);
  const kept = [];
  let dropped = 0;
  for (let fi = 0; fi < p.f.length; fi++) {
    let any = false;
    for (const L of _simpleLoops(p.f[fi], nV, stamp, pos, fi)) if (L.length >= 3 && _thickness(V, L) > tol) { kept.push(L); any = true; }
    if (!any) dropped++;
  }
  // duplicates: walk each face from its smallest index toward the smaller neighbour — the same walk for both
  // windings — and hash it; `dir` tells the winding
  const K = kept.length, start = new Int32Array(K), dir = new Int8Array(K), nxt = new Int32Array(K).fill(-1), byKey = new Map();
  for (let i = 0; i < K; i++) {
    const L = kept[i], n = L.length;
    let m = 0;
    for (let k = 1; k < n; k++) if (L[k] < L[m]) m = k;
    const d = L[(m + 1) % n] < L[(m + n - 1) % n] ? 1 : -1;
    let h = n;
    for (let t = 0; t < n; t++) h = (Math.imul(h, 31) + L[(m + d * t + n) % n]) | 0;
    start[i] = m; dir[i] = d;
    const key = h & 0x3fffffff, prev = byKey.get(key);
    if (prev !== undefined) nxt[i] = prev;
    byKey.set(key, i);
  }
  const same = (i, j) => {
    const A = kept[i], B = kept[j], n = A.length;
    if (B.length !== n) return false;
    for (let t = 0; t < n; t++) if (A[(start[i] + dir[i] * t + n) % n] !== B[(start[j] + dir[j] * t + n) % n]) return false;
    return true;
  };
  const drop = new Uint8Array(K);
  for (const last of byKey.values()) {
    if (nxt[last] < 0) continue;
    const list = [];
    for (let i = last; i >= 0; i = nxt[i]) list.push(i);
    list.reverse();                                     // lowest face id first: that copy is the one kept
    const done = new Uint8Array(list.length);
    for (let x = 0; x < list.length; x++) {
      if (done[x]) continue;
      const cls = [list[x]];
      for (let y = x + 1; y < list.length; y++) if (!done[y] && same(list[x], list[y])) { cls.push(list[y]); done[y] = 1; }
      if (cls.length < 2) continue;
      const bothWays = cls.some(i => dir[i] !== dir[cls[0]]);
      for (let k = bothWays ? 0 : 1; k < cls.length; k++) drop[cls[k]] = 1;
    }
  }
  const remap = new Int32Array(nV).fill(-1);
  for (let i = 0; i < K; i++) if (!drop[i]) for (const k of kept[i]) remap[k] = 0;
  const v = [];
  let m = 0;
  for (let k = 0; k < nV; k++) if (remap[k] === 0) { remap[k] = m++; v.push(V[k * 3], V[k * 3 + 1], V[k * 3 + 2]); }
  const f = [];
  for (let i = 0; i < K; i++) { if (drop[i]) { dropped++; continue; } f.push(kept[i].map(k => remap[k])); }
  return { poly: { v, f }, dropped };
}

// ── open boundary ────────────────────────────────────────────────────────────

/**
 * Half-edges in CSR form (per vertex, the edges leaving it), each classified:
 * a BOUNDARY edge a→b is the only use of its undirected edge (no b→a, no second
 * a→b); `bad` counts the edges that are neither boundary nor matched exactly
 * once each way (flipped faces, non-manifold fans).
 */
function _halfEdges(p) {
  const nV = (p.v.length / 3) | 0, F = p.f;
  let nH = 0;
  for (const f of F) nH += f.length;
  const off = new Int32Array(nV + 1);
  for (const f of F) for (const a of f) off[a + 1]++;
  for (let i = 0; i < nV; i++) off[i + 1] += off[i];
  const fill = off.slice(0, nV), from = new Int32Array(nH), to = new Int32Array(nH), fc = new Int32Array(nH);
  for (let fi = 0; fi < F.length; fi++) {
    const f = F[fi];
    for (let k = 0; k < f.length; k++) { const a = f[k], h = fill[a]++; from[h] = a; to[h] = f[(k + 1) % f.length]; fc[h] = fi; }
  }
  const isB = new Uint8Array(nH);
  let nB = 0, bad = 0;
  for (let h = 0; h < nH; h++) {
    const a = from[h], b = to[h];
    let fw = 0, rev = 0;
    for (let g = off[a]; g < off[a + 1]; g++) if (to[g] === b) fw++;
    for (let g = off[b]; g < off[b + 1]; g++) if (to[g] === a) rev++;
    if (fw === 1 && rev === 0) { isB[h] = 1; nB++; } else if (fw !== 1 || rev !== 1) bad++;
  }
  return { off, from, to, fc, isB, nB, bad, nH };
}

/** At a vertex with several ways out: the first one met turning counter-clockwise (around the surface normal) from the edge we came in by — it hugs the hole. */
function _hug(p, he, u, v, cands) {
  let nx = 0, ny = 0, nz = 0;
  for (let g = he.off[v]; g < he.off[v + 1]; g++) { const n = faceNormal(p, he.fc[g]); nx += n[0]; ny += n[1]; nz += n[2]; }
  const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  const V = p.v, px = V[v * 3], py = V[v * 3 + 1], pz = V[v * 3 + 2];
  const rx = V[u * 3] - px, ry = V[u * 3 + 1] - py, rz = V[u * 3 + 2] - pz, rn = rx * nx + ry * ny + rz * nz;
  let best = cands[0], bestA = Infinity;
  for (const g of cands) {
    const w = he.to[g], dx = V[w * 3] - px, dy = V[w * 3 + 1] - py, dz = V[w * 3 + 2] - pz;
    const cx = ry * dz - rz * dy, cy = rz * dx - rx * dz, cz = rx * dy - ry * dx;
    let a = Math.atan2(cx * nx + cy * ny + cz * nz, rx * dx + ry * dy + rz * dz - rn * (dx * nx + dy * ny + dz * nz));   // the angle in the tangent plane
    if (a <= 0) a += 2 * Math.PI;
    if (a < bestA) { bestA = a; best = g; }
  }
  return best;
}

/** A walk that passes a vertex twice = two loops touching there: cut it into simple loops (faces[k] = the face of edge ids[k]→ids[k+1]). */
function _splitLoop(ids, faces) {
  const out = [], st = [], sf = [], at = new Map();
  for (let k = 0; k < ids.length; k++) {
    const v = ids[k];
    if (at.has(v)) {
      const j = at.get(v);
      out.push({ ids: st.slice(j), faces: sf.slice(j) });
      for (let q = j + 1; q < st.length; q++) at.delete(st[q]);
      st.length = j + 1; sf.length = j + 1;
      sf[j] = faces[k];                                  // v now leaves by edge k
      continue;
    }
    at.set(v, st.length); st.push(v); sf.push(faces[k]);
  }
  out.push({ ids: st, faces: sf });
  return out;
}

/** The boundary as loops in BOUNDARY order ({ ids, faces }) + the walks that dead-ended + the edge census. */
function _boundary(p) {
  const he = _halfEdges(p), loops = [];
  let open = 0;
  if (he.nB) {
    const outB = new Map();
    for (let h = 0; h < he.nH; h++) if (he.isB[h]) { let l = outB.get(he.from[h]); if (!l) outB.set(he.from[h], l = []); l.push(h); }
    const used = new Uint8Array(he.nH);
    for (let h0 = 0; h0 < he.nH; h0++) {
      if (!he.isB[h0] || used[h0]) continue;
      used[h0] = 1;
      const ids = [he.from[h0]], faces = [he.fc[h0]];
      let prev = he.from[h0], cur = he.to[h0], ok = true;
      while (cur !== ids[0]) {
        const cands = (outB.get(cur) || []).filter(g => !used[g]);
        if (!cands.length) { ok = false; break; }         // a dead end (flipped / non-manifold neighbourhood): not a hole we can cap
        const g = cands.length === 1 ? cands[0] : _hug(p, he, prev, cur, cands);
        used[g] = 1; ids.push(cur); faces.push(he.fc[g]); prev = cur; cur = he.to[g];
      }
      if (!ok) { open++; continue; }
      for (const L of _splitLoop(ids, faces)) { if (L.ids.length >= 3) loops.push(L); else open++; }
    }
  }
  return { loops, open, bad: he.bad };
}

/**
 * OPEN HOLES: directed edges a→b that are the only use of their edge (no b→a,
 * no second a→b — a flipped face or a non-manifold fan is NOT a hole),
 * stitched into closed loops. Where several boundary edges leave one vertex
 * (two holes touching at a corner) the walk takes the first one met turning
 * counter-clockwise around the surface normal from the edge it came in by —
 * it hugs its own hole — and a loop that still passes a vertex twice is cut
 * there, so every loop is simple. Walks that dead-end are skipped.
 * Returns [[vertexId…]…], each in CAP order (opposite to its boundary edges):
 * pushed as a face, a loop closes its hole with consistent winding.
 */
export function boundaryLoops(p) {
  return _boundary(p).loops.map(L => L.ids.slice().reverse());
}

// ── caps ─────────────────────────────────────────────────────────────────────

/** Put `ins` between a and b in face f (a→b one of its edges). */
function _insert(f, a, b, ins) {
  for (let k = 0; k < f.length; k++) if (f[k] === a && f[(k + 1) % f.length] === b) { f.splice(k + 1, 0, ...ins); return true; }
  return false;
}

/**
 * A loop whose corners all lie within tol of one line is a CRACK (a T-junction,
 * the slot a dropped sliver left), not a hole: a cap would be a face of zero
 * area. Zip it instead — each side's corners spliced into the other side's
 * edges. 1 = zipped, 0 = not a crack (cap it), -1 = a crack that folds or has
 * two corners at the same spot (leave it open rather than cap it flat).
 */
function _zip(out, L, tol, seams) {
  const V = out.v, ids = L.ids, n = ids.length;
  const d2 = (i, j) => (V[i * 3] - V[j * 3]) ** 2 + (V[i * 3 + 1] - V[j * 3 + 1]) ** 2 + (V[i * 3 + 2] - V[j * 3 + 2]) ** 2;
  let iA = 0, iB = 0, best = -1;
  for (let k = 0; k < n; k++) { const d = d2(ids[0], ids[k]); if (d > best) { best = d; iA = k; } }
  best = -1;
  for (let k = 0; k < n; k++) { const d = d2(ids[iA], ids[k]); if (d > best) { best = d; iB = k; } }
  const A = ids[iA], B = ids[iB], L2 = best;
  if (L2 <= tol * tol) return 0;                       // a speck, not a line
  const ex = V[B * 3] - V[A * 3], ey = V[B * 3 + 1] - V[A * 3 + 1], ez = V[B * 3 + 2] - V[A * 3 + 2];
  const t = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const i = ids[k], wx = V[i * 3] - V[A * 3], wy = V[i * 3 + 1] - V[A * 3 + 1], wz = V[i * 3 + 2] - V[A * 3 + 2];
    const along = wx * ex + wy * ey + wz * ez;
    if (wx * wx + wy * wy + wz * wz - along * along / L2 > tol * tol) return 0;   // off the line: a real hole
    t[k] = along / L2;
  }
  const c1 = [], c2 = [];                              // A → B, then B → A, along the loop
  for (let k = iA; ; k = (k + 1) % n) { c1.push(k); if (k === iB) break; }
  for (let k = iB; ; k = (k + 1) % n) { c2.push(k); if (k === iA) break; }
  for (let q = 0; q + 1 < c1.length; q++) if (!(t[c1[q + 1]] > t[c1[q]])) return -1;
  for (let q = 0; q + 1 < c2.length; q++) if (!(t[c2[q + 1]] < t[c2[q]])) return -1;
  const in1 = c1.slice(1, -1), in2 = c2.slice(1, -1);
  for (const a of in1) for (const b of in2) if (t[a] === t[b]) return -1;
  const up2 = in2.slice().reverse(), down1 = in1.slice().reverse();
  const P = (k) => [V[ids[k] * 3], V[ids[k] * 3 + 1], V[ids[k] * 3 + 2]];
  for (const [chain, other] of [[c1, up2], [c2, down1]]) {
    for (let q = 0; q + 1 < chain.length; q++) {
      const k = chain[q], k2 = chain[q + 1], ta = t[k], tb = t[k2];
      const ins = other.filter(j => (t[j] - ta) * (tb - t[j]) > 0);   // strictly between the edge's ends, in walking order
      if (!ins.length) continue;
      _insert(out.f[L.faces[k]], ids[k], ids[k2], ins.map(j => ids[j]));
      for (const j of ins) seams.push(P(j));
    }
  }
  return 1;
}

/** Cap one loop (cap order): an n-gon if planar, else ear-clipped triangles, else a fan around a new centroid vertex. */
function _cap(out, ids, capFaces) {
  const V = out.v, tmp = { v: V, f: [ids] }, n = faceNormal(tmp, 0);
  let cx = 0, cy = 0, cz = 0;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const i of ids) {
    for (let c = 0; c < 3; c++) { const x = V[i * 3 + c]; if (x < mn[c]) mn[c] = x; if (x > mx[c]) mx[c] = x; }
    cx += V[i * 3]; cy += V[i * 3 + 1]; cz += V[i * 3 + 2];
  }
  cx /= ids.length; cy /= ids.length; cz /= ids.length;
  const size = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-12);
  let off = 0;
  for (const i of ids) off = Math.max(off, Math.abs((V[i * 3] - cx) * n[0] + (V[i * 3 + 1] - cy) * n[1] + (V[i * 3 + 2] - cz) * n[2]));
  if (off <= size * 1e-4) { out.f.push(ids); capFaces.push(out.f.length - 1); return; }
  // ear clipping is O(n²)+: a huge warped loop goes straight to the fan
  let tris = ids.length <= 400 ? triangulateFace(tmp, 0, n) : null;
  if (tris) {
    const tiny = size * size * 1e-12;
    const ok = tris.length === ids.length - 2 && tris.every(([a, b, c]) => {
      const ux = V[b * 3] - V[a * 3], uy = V[b * 3 + 1] - V[a * 3 + 1], uz = V[b * 3 + 2] - V[a * 3 + 2];
      const wx = V[c * 3] - V[a * 3], wy = V[c * 3 + 1] - V[a * 3 + 1], wz = V[c * 3 + 2] - V[a * 3 + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      return Math.hypot(nx, ny, nz) > tiny && nx * n[0] + ny * n[1] + nz * n[2] > -tiny;   // no sliver, no triangle folded back
    });
    if (!ok) tris = null;
  }
  if (!tris) {
    const c = V.length / 3;
    V.push(cx, cy, cz);
    tris = ids.map((a, k) => [c, a, ids[(k + 1) % ids.length]]);
  }
  for (const t of tris) { out.f.push(t); capFaces.push(out.f.length - 1); }
}

/**
 * CAP every open hole (see boundaryLoops). A loop whose corners all lie within
 * eps of one line is a CRACK (a T-junction, the slot a dropped sliver left):
 * it is ZIPPED — each side's corners spliced into the opposite side's edges,
 * no face added, no vertex moved. Any other loop gets a cap: ONE n-gon when
 * planar (every corner within 1e-4 × the loop's size of its Newell plane),
 * else ear-clipped triangles on the Newell plane, else (the clipping folded
 * or left a sliver) a fan around a NEW vertex at the loop's centroid.
 * eps defaults to 1e-5 × the object's size. Returns { poly,
 *   capFaces: [faceId…] (the red faces), holes: loops found, zipped: cracks closed,
 *   seams: [[x,y,z]…] the corners spliced by the zips, stillOpen: loops still open after,
 *   watertight: every edge now used exactly once each way }.
 */
export function capHoles(p, eps = null) {
  const tol = eps > 0 ? eps : polyExtent(p) * 1e-5;
  const out = clonePoly(p), first = _boundary(p);
  const capFaces = [], seams = [];
  let zipped = 0;
  for (const L of first.loops) {
    const z = _zip(out, L, tol, seams);
    if (z > 0) { zipped++; continue; }
    if (z < 0) continue;                               // a crack we cannot zip stays open: a flat cap would be a zero-area face
    _cap(out, L.ids.slice().reverse(), capFaces);
  }
  const after = zipped || capFaces.length ? _boundary(out) : first;
  const stillOpen = after.loops.length + after.open;
  return { poly: out, capFaces, holes: first.loops.length, zipped, seams, stillOpen, watertight: stillOpen === 0 && after.bad === 0 };
}

/**
 * FIX OBJECT in one call: weldNear → cleanDegenerate → capHoles, timed (ms;
 * the UI stops previewing live above ~3 s). Returns { poly, clusters,
 * clustersCoincident, capFaces, dropped, holes, zipped, seams, stillOpen,
 * watertight, ms } — see the three steps.
 */
export function repairPoly(p, eps) {
  const t0 = _now();
  const w = weldNear(p, eps);
  const c = capHoles(w.poly, eps);
  return {
    poly: c.poly, clusters: w.clusters, clustersCoincident: w.clustersCoincident,
    capFaces: c.capFaces, dropped: w.dropped, holes: c.holes, zipped: c.zipped, seams: c.seams,
    stillOpen: c.stillOpen, watertight: c.watertight, ms: _now() - t0,
  };
}
