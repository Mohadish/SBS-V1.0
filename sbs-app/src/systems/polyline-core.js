/**
 * SBS — 2D polylines for the overlay's lines and arrows (V0.3.4.15). Pure geometry: points in,
 * numbers out. No Konva, no DOM — it runs under node for tests.
 *
 * A line and an arrow are the same thing: a list of points (head, tail, any number between),
 * a way to bend through them — 'corner' (straight segments), 'smooth' (a curve through every
 * point) or 'fillet' (straight segments with rounded corners, the cables' look) — and an
 * arrowhead that each END may or may not wear.
 *
 * A CLOSED one is a polygon (V0.3.4.18): the last point joins the first, every point is a corner
 * (there are no ends, so no heads), and it needs at least three points. Every function that cares
 * takes `closed` as its last argument.
 */

export const CURVES = ['corner', 'smooth', 'fillet'];
export const curveOf = (v) => (CURVES.includes(v) ? v : 'corner');

/** [x0,y0,x1,y1,…] → [{x,y},…] (a dangling odd number is dropped) */
export function toPairs(flat) {
  const out = [];
  for (let i = 0; i + 1 < (flat || []).length; i += 2) {
    const x = Number(flat[i]), y = Number(flat[i + 1]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
  }
  return out;
}
export const toFlat = (pairs) => (pairs || []).flatMap(p => [p.x, p.y]);

const _sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const _len = (v) => Math.hypot(v.x, v.y);

/** The nearest place on the (straight) polyline: which segment, how far along it, where, how far away. */
export function nearestOnPolyline(pts, p, closed = false) {
  let best = null;
  const segs = closed && pts.length > 2 ? pts.length : pts.length - 1;       // a polygon has its closing edge too (index n−1: last → first)
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], ab = _sub(b, a), l2 = ab.x * ab.x + ab.y * ab.y;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2)) : 0;
    const q = { x: a.x + ab.x * t, y: a.y + ab.y * t }, d = _len(_sub(p, q));
    if (!best || d < best.dist) best = { index: i, t, point: q, dist: d };
  }
  return best;
}

/** Add a point ON the line nearest to p (the shape does not change until the new point is moved). @returns {{flat:number[], index:number}|null} */
export function insertPoint(flat, p, closed = false) {
  const pts = toPairs(flat);
  const n = pts.length >= 2 ? nearestOnPolyline(pts, p, closed) : null;
  if (!n) return null;
  pts.splice(n.index + 1, 0, n.point);
  return { flat: toFlat(pts), index: n.index + 1 };
}

/**
 * Add a point where the SMOOTH curve really runs (not on the straight chord between two points: on a circle made
 * of eight points the chord lies inside the round, and the new point would dent it). Each curve segment is sampled
 * and the nearest sample is taken. @returns {{flat:number[], index:number}|null}
 */
export function insertPointOnCurve(flat, p, closed = false, samples = 24) {
  const pts = toPairs(flat), n = pts.length;
  if (n < 2) return null;
  const cs = smoothControls(pts, closed), segs = cs.length;
  let best = null;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n], c1 = cs[i].c1, c2 = cs[i].c2;
    for (let k = 1; k < samples; k++) {
      const t = k / samples, u = 1 - t;
      const q = { x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x, y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y };
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (!best || d < best.d) best = { d, i, q };
    }
  }
  if (!best) return null;
  pts.splice(best.i + 1, 0, best.q);
  return { flat: toFlat(pts), index: best.i + 1 };
}

/** Remove a MIDDLE point. The two ends are what makes it a line: they stay. A polygon may lose any point while three remain. @returns {number[]|null} */
export function removePoint(flat, index, closed = false) {
  const pts = toPairs(flat);
  if (closed ? (index < 0 || index >= pts.length || pts.length <= 3) : (index <= 0 || index >= pts.length - 1)) return null;
  pts.splice(index, 1);
  return toFlat(pts);
}

export function movePoint(flat, index, p) {
  const pts = toPairs(flat);
  if (index < 0 || index >= pts.length || !Number.isFinite(p?.x) || !Number.isFinite(p?.y)) return toFlat(pts);
  pts[index] = { x: p.x, y: p.y };
  return toFlat(pts);
}

/**
 * Fillet — the CABLES' rule (cables-render.js): every middle corner is rounded over a constant
 * REACH, the distance d from the corner at which the rounding starts on both of its segments —
 * d = min(reach, 0.49 × each segment), so two neighbouring corners never meet — and the radius
 * follows from the turn: r = d · tan(θ/2) (θ = the angle between the segments). A gentle turn
 * therefore gets a wide arc and a sharp one a tight arc, which is what makes a routed cable look
 * right; a nearly straight point or a reach under half a unit is left as it is.
 * @returns {number[]} one radius per point; 0 for the two ends and for points that are not rounded
 */
export function filletRadii(pts, reach, closed = false) {
  const R = Number.isFinite(reach) && reach > 0 ? reach : 0, n = pts.length, ring = closed && n > 2;
  return pts.map((p, i) => {
    if (!R || (!ring && (i === 0 || i === n - 1))) return 0;
    const a = _sub(pts[(i - 1 + n) % n], p), b = _sub(pts[(i + 1) % n], p), la = _len(a), lb = _len(b);
    if (!la || !lb) return 0;
    const cos = Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y) / (la * lb)));
    const theta = Math.acos(cos);                        // π = straight through, 0 = a hairpin
    const d = Math.min(R, 0.49 * la, 0.49 * lb);
    if (theta > 0.997 * Math.PI || theta < 1e-3 || d < 0.5) return 0;
    return d * Math.tan(theta / 2);
  });
}

/** Smooth: cubic Bézier control points of each segment for a curve THROUGH every point (Catmull-Rom; the ends are REFLECTED like the cables', so the curve leaves an end along its first chord). */
export function smoothControls(pts, closed = false) {
  const out = [], n = pts.length, ring = closed && n > 2;
  for (let i = 0; i < (ring ? n : n - 1); i++) {
    const p1 = pts[i], p2 = pts[(i + 1) % n];
    const p0 = ring ? pts[(i - 1 + n) % n] : (pts[i - 1] || { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y });
    const p3 = ring ? pts[(i + 2) % n] : (pts[i + 2] || { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y });
    out.push({
      c1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      c2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
    });
  }
  return out;
}

/** Which way an END points (a unit vector, outward) — what its arrowhead follows. end: 'start' | 'end' */
export function endDirection(pts, end, curve = 'corner') {
  if (pts.length < 2) return { x: 1, y: 0 };
  const tip = end === 'start' ? pts[0] : pts[pts.length - 1];
  let from = end === 'start' ? pts[1] : pts[pts.length - 2];
  if (curve === 'smooth' && pts.length > 2) {
    const cs = smoothControls(pts);
    from = end === 'start' ? cs[0].c1 : cs[cs.length - 1].c2;
  }
  let v = _sub(tip, from), l = _len(v);
  if (!l) { v = _sub(tip, end === 'start' ? pts[1] : pts[pts.length - 2]); l = _len(v); }
  return l ? { x: v.x / l, y: v.y / l } : { x: 1, y: 0 };
}

/** The three corners of an arrowhead whose tip stands on `tip` and points along `dir`. */
export function headTriangle(tip, dir, length, width) {
  const bx = tip.x - dir.x * length, by = tip.y - dir.y * length, nx = -dir.y, ny = dir.x;
  return [{ x: tip.x, y: tip.y }, { x: bx + nx * width / 2, y: by + ny * width / 2 }, { x: bx - nx * width / 2, y: by - ny * width / 2 }];
}

/**
 * Which ends wear a head. New shapes say so themselves (headStart / headEnd booleans); an arrow
 * from before V0.3.4.15 has no such attrs — Konva's own flags / the class decide for it.
 */
export function headsOf({ className, headStart, headEnd, pointerAtBeginning, pointerAtEnding } = {}) {
  const isArrow = className === 'Arrow';
  return {
    start: typeof headStart === 'boolean' ? headStart : (isArrow ? !!pointerAtBeginning : false),
    end: typeof headEnd === 'boolean' ? headEnd : (isArrow ? pointerAtEnding !== false : false),
  };
}

/**
 * The points of a basic shape as a polygon, in the shape's OWN coordinates (the node's transform is not applied).
 * kind: 'rect' {w,h} (from its top-left corner) · 'ngon' {r, sides} (Konva's RegularPolygon: first point straight up) ·
 * 'ellipse' {rx, ry, count=8} (centred; first point straight up — eight points with Smooth read as round).
 */
export function shapeOutline(kind, o = {}) {
  if (kind === 'rect') { const w = Number(o.w) || 0, h = Number(o.h) || 0; return [0, 0, w, 0, w, h, 0, h]; }
  const out = [];
  if (kind === 'ngon') {
    const n = Math.max(3, Math.round(Number(o.sides) || 3)), r = Number(o.r) || 0;
    for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; out.push(r * Math.sin(a), -r * Math.cos(a)); }
    return out;
  }
  if (kind === 'ellipse') {
    const n = Math.max(4, Math.round(Number(o.count) || 8)), rx = Number(o.rx) || 0, ry = Number(o.ry) || 0;
    for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n - Math.PI / 2; out.push(rx * Math.cos(a), ry * Math.sin(a)); }
    return out;
  }
  return out;
}
