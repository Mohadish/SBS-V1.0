/**
 * ⬚ EDITABLE POLY — the EDGE level: LOOP selection and CHAMFER (3ds Max's
 * editable-poly edge gestures: double-click = Loop, right-click = Chamfer).
 *
 * Pure maths on the poly of poly-core.js ({ v: xyz per vertex, f: index lists,
 * CCW seen from outside }): no THREE, no DOM, no state — testable in node.
 * An edge is addressed by its undirected key 'min-max' (the key polyEdges
 * uses), so a selection survives as long as the vertex ids do.
 *
 * Chamfer is Max's 1-segment chamfer: the distance is measured ALONG the
 * neighbouring edges, so the point slid down an unselected edge is ONE point
 * for both faces sharing that edge — no T-junctions, closed in = closed out.
 * Every new vertex travels on a straight line (base + dist·dir), so the
 * distance at which the first edge shrinks to nothing (maxDist) is exact, and
 * the result is clamped there: the slider can never fold the mesh inside out.
 */

import { faceNormal, polyExtent, triangulateFace } from './poly-core.js';

const _pt = (p, i) => [p.v[i * 3], p.v[i * 3 + 1], p.v[i * 3 + 2]];
const _sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const _dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const _cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const _len = (a) => Math.hypot(a[0], a[1], a[2]);
const _unit = (a) => { const l = _len(a); return l > 1e-300 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
const _ends = (key) => { const s = String(key).split('-'); return [Number(s[0]), Number(s[1])]; };

/** Undirected edge key 'min-max' — the same key poly-core's polyEdges dedupes on. */
export function edgeKey(a, b) { return a < b ? `${a}-${b}` : `${b}-${a}`; }

/**
 * Each undirected edge once: [{ a, b, key, faces: [faceIndex…] }] with a < b,
 * in first-seen order. One face = an open boundary, three or more = non-manifold.
 */
export function polyEdgeList(p) {
  const byKey = new Map(), out = [];
  p.f.forEach((f, fi) => {
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length];
      if (a === b) continue;
      const key = edgeKey(a, b);
      let e = byKey.get(key);
      if (!e) { e = { a: Math.min(a, b), b: Math.max(a, b), key, faces: [] }; byKey.set(key, e); out.push(e); }
      if (e.faces[e.faces.length - 1] !== fi) e.faces.push(fi);
    }
  });
  return out;
}

/**
 * Max's LOOP from edge a–b: walk both ways; through a vertex with exactly four
 * edges and four faces (an interior, manifold valence-4 vertex) the loop goes
 * on along the edge OPPOSITE the incoming one — the only one sharing no face
 * with it. It stops at any other valence, at an open boundary, or when it
 * closes. Returns the keys in walking order, the start edge included
 * ([] when a–b is not an edge of p).
 */
export function edgeLoop(p, a, b) {
  const faceOf = new Map(), nbr = new Map();
  for (const e of polyEdgeList(p)) {
    faceOf.set(e.key, e.faces);
    if (!nbr.has(e.a)) nbr.set(e.a, new Set());
    if (!nbr.has(e.b)) nbr.set(e.b, new Set());
    nbr.get(e.a).add(e.b); nbr.get(e.b).add(e.a);
  }
  const start = edgeKey(a, b);
  if (!faceOf.has(start)) return [];
  // the next vertex past `cur` when arriving from `prev`, or null where Max's loop ends
  const across = (prev, cur) => {
    const nb = nbr.get(cur);
    if (!nb || nb.size !== 4) return null;
    const inF = faceOf.get(edgeKey(prev, cur));
    if (inF.length !== 2) return null;
    const fan = new Set();
    for (const x of nb) { const fs = faceOf.get(edgeKey(cur, x)); if (fs.length !== 2) return null; for (const fi of fs) fan.add(fi); }
    if (fan.size !== 4) return null;                    // a pinched or open fan has no "opposite"
    let out = null;
    for (const x of nb) {
      if (x === prev || faceOf.get(edgeKey(cur, x)).some(fi => inF.includes(fi))) continue;
      if (out != null) return null;
      out = x;
    }
    return out;
  };
  const seen = new Set([start]);
  const walk = (prev, cur) => {
    const keys = [];
    for (let guard = 0; guard < 10000000; guard++) {
      const nx = across(prev, cur);
      if (nx == null) break;
      const k = edgeKey(cur, nx);
      if (k === start) return { keys, closed: true };
      if (seen.has(k)) break;
      seen.add(k); keys.push(k);
      prev = cur; cur = nx;
    }
    return { keys, closed: false };
  };
  const fwd = walk(a, b);
  if (fwd.closed) return [start, ...fwd.keys];
  const back = walk(b, a);
  return [...back.keys.reverse(), start, ...fwd.keys];
}

/** Max distance of a face's corners from its Newell plane (0 for a triangle, and for a face squashed flat at maxDist — the weld removes it, splitting it would not). */
function _planeError(poly, face, areaEps) {
  if (face.length <= 3) return 0;
  let nx = 0, ny = 0, nz = 0;
  for (let k = 0; k < face.length; k++) {
    const a = face[k] * 3, b = face[(k + 1) % face.length] * 3;
    nx += (poly.v[a + 1] - poly.v[b + 1]) * (poly.v[a + 2] + poly.v[b + 2]);
    ny += (poly.v[a + 2] - poly.v[b + 2]) * (poly.v[a] + poly.v[b]);
    nz += (poly.v[a] - poly.v[b]) * (poly.v[a + 1] + poly.v[b + 1]);
  }
  if (Math.hypot(nx, ny, nz) <= areaEps) return 0;
  const tmp = { v: poly.v, f: [face] };
  const n = faceNormal(tmp, 0);
  let cx = 0, cy = 0, cz = 0;
  for (const i of face) { cx += poly.v[i * 3]; cy += poly.v[i * 3 + 1]; cz += poly.v[i * 3 + 2]; }
  cx /= face.length; cy /= face.length; cz /= face.length;
  let err = 0;
  for (const i of face) err = Math.max(err, Math.abs(n[0] * (poly.v[i * 3] - cx) + n[1] * (poly.v[i * 3 + 1] - cy) + n[2] * (poly.v[i * 3 + 2] - cz)));
  return err;
}

/**
 * CHAMFER the selected edges by `dist`, measured along the neighbouring edges
 * (Max's 1-segment chamfer):
 *   · each selected edge becomes a new face — the bevel strip;
 *   · a face next to it shrinks back: its corner slides down its other edge,
 *     or, when both its edges at that corner are chamfered, moves inside it
 *     (the parallelogram point, so a box face stays a rectangle);
 *   · a face whose corner is cut although neither of its edges there is
 *     chamfered gains the extra corner (the third face at a box corner when
 *     one edge is chamfered becomes a pentagon);
 *   · whatever hole is left where chamfered edges meet gets its own patch
 *     face (three chamfered edges at a box corner → a triangle there; a
 *     valence-4 vertex at the end of one chamfered edge stays and gets a
 *     triangle beside the strip).
 * Every face stays planar — a bevel or patch that would bend (an irregular
 * mesh) is split into triangles — and the winding stays consistent. Open
 * boundary edges in the selection are ignored (nothing to bevel to).
 *
 * `dist` is clamped to maxDist, where the first edge collapses (half an edge
 * when both its ends slide toward each other, a whole edge when one end is
 * fixed). Returns
 *   { poly, nearPairs, collapsed, dist, maxDist, weldEps, newFaceIds }
 *   · nearPairs: [[xyz, xyz]…] new vertices (or a new vertex and an old one)
 *     closer than weldEps = 1 % of min(dist, shortest neighbouring edge) —
 *     the UI paints them red and tells the user they will be welded
 *     (weldPoly(poly, weldEps) on commit);
 *   · collapsed: faces left with fewer than 3 distinct corners at that eps
 *     (the weld drops them — a polygon needs 3 corners);
 *   · newFaceIds: the bevel and patch faces (to select / highlight).
 * Original faces keep their index (new faces are appended); vertices no face
 * uses any more are dropped, so vertex ids after them shift down.
 * Or { poly: null, reason } — nothing chamferable, a non-manifold vertex on
 * the selection, or a result that would not be closed when the input was.
 */
export function chamferEdges(p, keys, dist) {
  if (!(dist > 0)) return { poly: null, reason: 'the chamfer distance must be above 0' };
  const nV0 = p.v.length / 3;
  const ext = polyExtent(p);
  // directed edge → its face; the same directed edge twice = non-manifold or flipped there
  const dirFace = new Map(), bad = new Set();
  p.f.forEach((f, fi) => {
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length], d = `${a}>${b}`;
      if (dirFace.has(d)) { bad.add(a); bad.add(b); } else dirFace.set(d, fi);
    }
  });
  const sel = new Set();
  for (const key of keys || []) {
    const [a, b] = _ends(key);
    const F = dirFace.get(`${a}>${b}`), G = dirFace.get(`${b}>${a}`);
    if (F != null && G != null && F !== G) sel.add(edgeKey(a, b));
  }
  if (!sel.size) return { poly: null, reason: 'no edge between two faces is selected' };
  const touched = new Set();
  for (const key of sel) for (const i of _ends(key)) touched.add(i);
  for (const i of touched) if (bad.has(i)) return { poly: null, reason: `the mesh is non-manifold at vertex ${i}` };

  // new vertices: position = base + dist·dir (straight lines → exact collapse distances)
  const NB = [], ND = [], owner = new Map();
  const addV = (base, dir, v) => { const id = nV0 + NB.length / 3; NB.push(base[0], base[1], base[2]); ND.push(dir[0], dir[1], dir[2]); owner.set(id, v); return id; };

  const corners = new Map();                            // touched vertex → its face corners
  p.f.forEach((f, fi) => f.forEach((i, k) => {
    if (!touched.has(i)) return;
    let l = corners.get(i); if (!l) corners.set(i, l = []);
    l.push({ fi, k, prev: f[(k + f.length - 1) % f.length], next: f[(k + 1) % f.length] });
  }));

  const R = new Map();                                  // 'fi:k' → the vertex ids replacing that corner, in face order
  const nearOld = new Set();
  let minEdge = Infinity;
  for (const v of touched) {
    // the fan around v: face F_i runs x_i → v → x_{i+1}; edge e_i = v–x_i lies between F_{i-1} and F_i
    const cs = corners.get(v), byPrev = new Map();
    for (const c of cs) { if (byPrev.has(c.prev)) return { poly: null, reason: `the mesh is non-manifold at vertex ${v}` }; byPrev.set(c.prev, c); }
    const nexts = new Set(cs.map(c => c.next));
    const starts = cs.filter(c => !nexts.has(c.prev));  // an open fan starts at the boundary
    if (starts.length > 1) return { poly: null, reason: `the mesh is pinched at vertex ${v}` };
    const closed = !starts.length, first = starts[0] || cs[0], order = [first];
    for (let c = byPrev.get(first.next); c && c !== first && order.length <= cs.length; c = byPrev.get(c.next)) order.push(c);
    if (order.length !== cs.length) return { poly: null, reason: `the mesh is pinched at vertex ${v}` };
    const n = order.length;
    const x = order.map(c => c.prev);
    if (!closed) x.push(order[n - 1].next);
    const E = (j) => closed ? ((j % n) + n) % n : j;
    const isSel = (j) => (closed || (j >= 0 && j <= n)) && sel.has(edgeKey(v, x[E(j)]));
    const hasF = (i) => closed || (i >= 0 && i < n);
    const V = _pt(p, v);
    const u = x.map(xi => _unit(_sub(_pt(p, xi), V)));
    for (const xi of x) { nearOld.add(xi); minEdge = Math.min(minEdge, _len(_sub(_pt(p, xi), V))); }
    nearOld.add(v);
    // the one point on unselected edge e_j: slid along it when a face beside it shrinks back from a chamfer, else v itself
    const cpOf = new Map();
    const cp = (j) => {
      j = E(j);
      if (cpOf.has(j)) return cpOf.get(j);
      const slides = (hasF(j - 1) && isSel(j - 1)) || (hasF(j) && isSel(j + 1));
      const id = slides ? addV(V, u[j], v) : v;
      if (!slides) owner.set(v, v);
      cpOf.set(j, id);
      return id;
    };
    for (let i = 0; i < n; i++) {
      const c = order[i], s0 = isSel(i), s1 = isSel(i + 1);
      let list;
      if (s0 && s1) {                                   // both edges chamfered: the corner moves inside the face
        const ui = u[E(i)], un = u[E(i + 1)], nf = faceNormal(p, c.fi);
        const into = [-ui[0], -ui[1], -ui[2]];          // travel direction into v
        const sum = [ui[0] + un[0], ui[1] + un[1], ui[2] + un[2]];
        let dir;
        if (_len(sum) < 0.1) dir = _unit(_cross(nf, into));                    // a straight-through corner: the inward perpendicular
        else { const convex = _dot(_cross(into, un), nf) >= 0; dir = convex ? sum : [-sum[0], -sum[1], -sum[2]]; }   // a reflex corner moves the other way
        list = [addV(V, dir, v)];
      } else if (s0) list = [cp(i + 1)];
      else if (s1) list = [cp(i)];
      else { const a = cp(i), b = cp(i + 1); list = a === b ? [a] : [a, b]; }
      R.set(`${c.fi}:${c.k}`, list);
    }
  }

  // the original faces with their corners replaced (only those around the selection change)
  const changed = new Set();
  for (const cs of corners.values()) for (const c of cs) changed.add(c.fi);
  const faces = p.f.map((f, fi) => {
    if (!changed.has(fi)) return f.slice();
    const out = [];
    f.forEach((i, k) => { const r = R.get(`${fi}:${k}`); if (r) out.push(...r); else out.push(i); });
    return out;
  });
  const around = [...changed].map(fi => faces[fi]);   // the only faces a new vertex can sit in
  // one bevel strip per selected edge, reversing the shrunk edge of each of its two faces
  const strips = [];
  for (const key of sel) {
    const [a, b] = _ends(key);
    const F = dirFace.get(`${a}>${b}`), G = dirFace.get(`${b}>${a}`);
    const at = (fi, i) => R.get(`${fi}:${p.f[fi].indexOf(i)}`);
    const Fa = at(F, a), Fb = at(F, b), Ga = at(G, a), Gb = at(G, b);
    const q = [Fb[0], Fa[Fa.length - 1], Ga[0], Gb[Gb.length - 1]].filter((id, k, arr) => id !== arr[(k + 1) % arr.length]);
    if (q.length >= 3) strips.push(q);
  }
  // patches: around each touched vertex, the directed edges nobody matches yet bound the hole left there
  const directed = new Set();
  for (const f of around.concat(strips)) for (let k = 0; k < f.length; k++) directed.add(`${f[k]}>${f[(k + 1) % f.length]}`);
  const holes = new Map();
  for (const f of around.concat(strips)) for (let k = 0; k < f.length; k++) {
    const a = f[k], b = f[(k + 1) % f.length], oa = owner.get(a);
    if (oa == null || oa !== owner.get(b) || directed.has(`${b}>${a}`)) continue;
    let m = holes.get(oa); if (!m) holes.set(oa, m = new Map());
    if (m.has(b)) return { poly: null, reason: `could not close the corner at vertex ${oa}` };
    m.set(b, a);                                        // the patch runs b → a
  }
  const patches = [];
  for (const m of holes.values()) {
    const targets = new Set(m.values());
    for (const s of [...m.keys()]) {                    // a chain that starts nowhere runs along the mesh's own open boundary: left open
      if (targets.has(s)) continue;
      for (let c = s; m.has(c);) { const nx = m.get(c); m.delete(c); c = nx; }
    }
    while (m.size) {
      const s = m.keys().next().value, loop = [s];
      let c = m.get(s); m.delete(s);
      while (c !== s && m.has(c)) { loop.push(c); const nx = m.get(c); m.delete(c); c = nx; }
      if (c === s && loop.length >= 3) patches.push(loop);
    }
  }

  // maxDist: the smallest dist at which an edge whose ends move shrinks to nothing
  const nNew = NB.length / 3;
  const baseOf = (i) => i < nV0 ? _pt(p, i) : [NB[(i - nV0) * 3], NB[(i - nV0) * 3 + 1], NB[(i - nV0) * 3 + 2]];
  const dirOf = (i) => i < nV0 ? [0, 0, 0] : [ND[(i - nV0) * 3], ND[(i - nV0) * 3 + 1], ND[(i - nV0) * 3 + 2]];
  let maxDist = Infinity;
  const seenE = new Set();
  for (const f of around.concat(strips, patches)) for (let k = 0; k < f.length; k++) {
    const a = f[k], b = f[(k + 1) % f.length];
    if (a < nV0 && b < nV0) continue;
    const key = edgeKey(a, b);
    if (seenE.has(key)) continue;
    seenE.add(key);
    const E0 = _sub(baseOf(b), baseOf(a)), dD = _sub(dirOf(b), dirOf(a)), dd = _dot(dD, dD);
    if (dd < 1e-24) continue;
    const t = -_dot(E0, dD) / dd;
    if (!(t > 0)) continue;
    const m = [E0[0] + dD[0] * t, E0[1] + dD[1] * t, E0[2] + dD[2] * t];
    if (_len(m) <= 1e-6 * _len(E0)) maxDist = Math.min(maxDist, t);
  }
  const d = Math.min(dist, maxDist);

  const v = p.v.slice();
  for (let j = 0; j < nNew; j++) v.push(NB[j * 3] + ND[j * 3] * d, NB[j * 3 + 1] + ND[j * 3 + 1] * d, NB[j * 3 + 2] + ND[j * 3 + 2] * d);
  // a strip or patch over a bent spot (irregular meshes) is split into planar triangles
  const tmp = { v, f: [] }, planeTol = ext * 1e-6;
  const fresh = [];
  for (const face of strips.concat(patches)) {
    if (_planeError(tmp, face, ext * ext * 1e-9) <= planeTol) { fresh.push(face); continue; }
    tmp.f = [face];
    for (const t of triangulateFace(tmp, 0)) fresh.push(t);
  }
  const allF = faces.concat(fresh);

  // closed in = closed out. Only the changed faces can break it (an untouched face holds no touched
  // vertex), so the whole-mesh isWatertight pass — the slow part on a big mesh — runs on them alone.
  let wasClosed = !bad.size;
  if (wasClosed) for (const k of dirFace.keys()) { const [a, b] = k.split('>'); if (!dirFace.has(`${b}>${a}`)) { wasClosed = false; break; } }
  if (wasClosed) {
    const local = new Set();
    for (const f of around.concat(fresh)) for (let k = 0; k < f.length; k++) {
      const key = `${f[k]}>${f[(k + 1) % f.length]}`;
      if (local.has(key)) return { poly: null, reason: 'the chamfer would fold the mesh' };
      local.add(key);
    }
    for (const key of local) {
      const [a, b] = key.split('>').map(Number), rev = `${b}>${a}`;
      if (local.has(rev)) continue;
      const fi = a < nV0 && b < nV0 ? dirFace.get(rev) : null;
      if (fi == null || changed.has(fi)) return { poly: null, reason: 'the chamfer would open the mesh' };
    }
  }

  // compact: the vertices no face uses any more (a chamfered corner) are dropped, the rest keep their order
  const used = new Uint8Array(nV0 + nNew);
  for (const f of allF) for (const i of f) used[i] = 1;
  const remap = new Int32Array(nV0 + nNew).fill(-1), outV = [];
  for (let i = 0; i < nV0 + nNew; i++) if (used[i]) { remap[i] = outV.length / 3; outV.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]); }
  const poly = { v: outV, f: allF.map(f => f.map(i => remap[i])) };
  const newFaceIds = fresh.map((_, k) => faces.length + k);

  // near pairs: what the weld will merge (new–new, or a new vertex reaching an old one)
  const weldEps = 0.01 * Math.min(d, minEdge);
  const cand = [];
  for (const i of nearOld) if (remap[i] >= 0) cand.push(remap[i]);
  for (let j = 0; j < nNew; j++) if (remap[nV0 + j] >= 0) cand.push(remap[nV0 + j]);
  const firstNew = remap.slice(nV0).reduce((m, r) => (r >= 0 && r < m ? r : m), Infinity);
  const P = (i) => [outV[i * 3], outV[i * 3 + 1], outV[i * 3 + 2]];
  const cell = Math.max(weldEps, 1e-12), grid = new Map(), nearPairs = [];
  const cellKey = (q, dx, dy, dz) => `${Math.floor(q[0] / cell) + dx},${Math.floor(q[1] / cell) + dy},${Math.floor(q[2] / cell) + dz}`;
  for (const i of cand) {
    const q = P(i);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const arr = grid.get(cellKey(q, dx, dy, dz));
      if (!arr) continue;
      for (const j of arr) if ((i >= firstNew || j >= firstNew) && _len(_sub(P(j), q)) <= weldEps) nearPairs.push([P(j), q]);
    }
    const k0 = cellKey(q, 0, 0, 0);
    let arr = grid.get(k0); if (!arr) grid.set(k0, arr = []); arr.push(i);
  }
  // collapsed: faces left with fewer than 3 distinct corners once the near points merge
  let collapsed = 0;
  for (const fi of [...changed, ...newFaceIds]) {      // the untouched faces did not move
    const f = poly.f[fi];
    const distinct = [];
    for (const i of f) { const q = P(i); if (!distinct.some(s => _len(_sub(s, q)) <= weldEps)) distinct.push(q); if (distinct.length >= 3) break; }
    if (distinct.length < 3) collapsed++;
  }
  return { poly, nearPairs, collapsed, dist: d, maxDist, weldEps, newFaceIds };
}
