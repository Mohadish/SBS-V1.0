/**
 * ⟷ SHAPE SYMMETRY (V0.3.5.46) — the maths of the shape editor's mirror.
 *
 * His spec: make a shape, then add a symmetry — a mirror LINE (vertical or
 * horizontal) or both lines at once (a cross), placed and turned on the shape's
 * own plane. The part of the shape on the KEPT side of the line(s) is mirrored
 * across them: one line → the kept half and its mirror image; both lines → the
 * kept quarter four times. Turning the line(s) chooses which half / quarter is
 * kept. Where the halves meet on the line they are one outline (a union — the
 * points on the line are shared, nothing to weld by hand).
 *
 * Pure maths, plane-local 2D: no THREE, no DOM, no state. `PC` is the
 * polygon-clipping library (window.polygonClipping in the app).
 *
 *   sym = { mode: 'v' | 'h' | 'vh', cx, cy, ang }
 *     ang = the direction of the VERTICAL line (radians from the plane's +X);
 *     U = (cos ang, sin ang) runs along it, R = U turned −90° (its right).
 *     'v'  → the vertical line, the R side is kept;
 *     'h'  → the horizontal line (along R), the U side is kept;
 *     'vh' → both, the quarter with R ≥ 0 and U ≥ 0 is kept.
 */

/** The line directions for an angle: U along the vertical line, R its right. */
export function symmetryAxes(ang) {
  const ux = Math.cos(ang), uy = Math.sin(ang);
  return { U: [ux, uy], R: [uy, -ux] };
}

/** The kept side / quarter as a ring reaching `size` from the centre (for the tint and the clip). */
export function keptRegion(sym, size) {
  const { U, R } = symmetryAxes(sym.ang);
  const at = (a, b) => [sym.cx + U[0] * a + R[0] * b, sym.cy + U[1] * a + R[1] * b];   // a along U, b along R
  if (sym.mode === 'v') return [at(-size, 0), at(-size, size), at(size, size), at(size, 0)];
  if (sym.mode === 'h') return [at(0, -size), at(size, -size), at(size, size), at(0, size)];
  return [at(0, 0), at(0, size), at(size, size), at(size, 0)];
}

/** Every ring of the editor's polygon list XOR-ed into one shape (the editor shows the XOR). */
function _shapeOf(polygons, PC) {
  const inputs = (polygons || [])
    .filter(p => p?.outer?.length >= 3)
    .map(p => [[p.outer.map(q => [q[0], q[1]]), ...(p.holes || []).filter(h => h?.length >= 3).map(h => h.map(q => [q[0], q[1]]))]]);
  if (!inputs.length) return [];
  let acc = inputs[0];
  for (let i = 1; i < inputs.length; i++) acc = PC.xor(acc, inputs[i]);
  return acc;
}

/** A ring from the library → an open ring: the closing copy, hair-short edges and straight-through corners out. */
function _cleanRing(ring, eps) {
  let r = ring.map(p => [p[0], p[1]]);
  if (r.length > 1) { const a = r[0], b = r[r.length - 1]; if (Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps) r.pop(); }
  let changed = true;
  while (changed && r.length >= 3) {
    changed = false;
    for (let i = 0; i < r.length && r.length >= 3; i++) {
      const a = r[(i - 1 + r.length) % r.length], b = r[i], c = r[(i + 1) % r.length];
      const abx = b[0] - a[0], aby = b[1] - a[1], bcx = c[0] - b[0], bcy = c[1] - b[1];
      const short = Math.hypot(abx, aby) <= eps;
      const straight = Math.abs(abx * bcy - aby * bcx) <= eps * (Math.hypot(abx, aby) + Math.hypot(bcx, bcy)) && (abx * bcx + aby * bcy) >= 0;
      if (short || straight) { r.splice(i, 1); changed = true; i--; }
    }
  }
  return r;
}

/** The shape's box: { x0, y0, x1, y1 } (null when empty). */
export function polygonsBox(polygons) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polygons || []) for (const q of p?.outer || []) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/**
 * The mirrored shape, as the editor's polygon list: every ring its own entry
 * (the editor XORs them, so a hole stays a hole — and stays editable).
 * Returns { polygons: [{ outer, holes: [] }…], empty, error? } — empty = nothing of
 * the shape lies on the kept side (the line is beyond it); error = the clipping
 * library could not build the outline (very rare; the UI says so, nothing applied).
 */
export function mirrorShape(polygons, sym, PC) {
  const S = _shapeOf(polygons, PC);
  const box = polygonsBox(polygons);
  if (!S.length || !box) return { polygons: [], empty: true };
  const size = Math.max(box.x1 - box.x0, box.y1 - box.y0, 1e-9);
  const far = (size + Math.hypot(sym.cx - (box.x0 + box.x1) / 2, sym.cy - (box.y0 + box.y1) / 2)) * 4;
  const part = PC.intersection(S, [[keptRegion(sym, far)]]);
  if (!part.length) return { polygons: [], empty: true };
  const { U, R } = symmetryAxes(sym.ang);
  const C = [sym.cx, sym.cy];
  const map = (mp, f) => mp.map(poly => poly.map(ring => ring.map(f)));
  // Float noise is the enemy here: a seam point and its mirror image must be the SAME numbers, or the
  // library cannot close the outline ("Unable to complete output ring"). So: a point (almost) on a line
  // mirrors onto itself exactly, and every coordinate is rounded to a grid far finer than the shape.
  const run = (grid) => {
    const g = size * grid, snap = (p) => [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g];
    const onLine = size * grid * 4;
    const reflect = (D) => (p) => {
      const vx = p[0] - C[0], vy = p[1] - C[1], d = vx * D[0] + vy * D[1];
      if (Math.abs(vx * D[1] - vy * D[0]) <= onLine) return p;           // on the line: its own image
      return snap([C[0] + 2 * d * D[0] - vx, C[1] + 2 * d * D[1] - vy]);
    };
    const kept = map(part, snap);
    const copies = [kept];
    if (sym.mode === 'v' || sym.mode === 'vh') copies.push(map(kept, reflect(U)));        // across the vertical line
    if (sym.mode === 'h' || sym.mode === 'vh') copies.push(map(kept, reflect(R)));        // across the horizontal line
    if (sym.mode === 'vh') copies.push(map(map(kept, reflect(U)), reflect(R)));           // across both
    return PC.union(...copies);
  };
  let res = null, error = null;
  for (const grid of [1e-9, 1e-7, 1e-5]) {                 // a coarser grid only if the fine one still trips the library
    try { res = run(grid); error = null; break; } catch (err) { error = err; }
  }
  if (!res) return { polygons: [], empty: false, error: error?.message || String(error) };
  const eps = size * 1e-9;
  const out = [];
  for (const poly of res) for (const ring of poly) { const r = _cleanRing(ring, eps); if (r.length >= 3) out.push({ outer: r, holes: [] }); }
  return { polygons: out, empty: !out.length };
}
