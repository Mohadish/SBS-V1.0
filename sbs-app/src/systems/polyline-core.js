/**
 * SBS — 2D polylines for the overlay's lines and arrows (V0.3.4.15). Pure geometry: points in,
 * numbers out. No Konva, no DOM — it runs under node for tests.
 *
 * A line and an arrow are the same thing: a list of points (head, tail, any number between),
 * a way to bend through them — 'corner' (straight segments), 'smooth' (a curve through every
 * point) or 'fillet' (straight segments with rounded corners, the cables' look) — and an
 * arrowhead that each END may or may not wear.
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
export function nearestOnPolyline(pts, p) {
  let best = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], ab = _sub(b, a), l2 = ab.x * ab.x + ab.y * ab.y;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2)) : 0;
    const q = { x: a.x + ab.x * t, y: a.y + ab.y * t }, d = _len(_sub(p, q));
    if (!best || d < best.dist) best = { index: i, t, point: q, dist: d };
  }
  return best;
}

/** Add a point ON the line nearest to p (the shape does not change until the new point is moved). @returns {{flat:number[], index:number}|null} */
export function insertPoint(flat, p) {
  const pts = toPairs(flat);
  const n = pts.length >= 2 ? nearestOnPolyline(pts, p) : null;
  if (!n) return null;
  pts.splice(n.index + 1, 0, n.point);
  return { flat: toFlat(pts), index: n.index + 1 };
}

/** Remove a MIDDLE point. The two ends are what makes it a line: they stay. @returns {number[]|null} */
export function removePoint(flat, index) {
  const pts = toPairs(flat);
  if (index <= 0 || index >= pts.length - 1) return null;
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
 * Fillet: the radius each MIDDLE corner can really take. A round corner touches both of its
 * segments at d = r / tan(θ/2) from the corner (θ = the angle between them); d may use at most
 * half of each segment (the neighbour corner needs the other half), so a short segment or a
 * sharp turn gets a smaller radius instead of a broken arc.
 * @returns {number[]} one radius per point; 0 for the two ends and for straight-through points
 */
export function filletRadii(pts, radius) {
  const R = Number.isFinite(radius) && radius > 0 ? radius : 0;
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1 || !R) return 0;
    const a = _sub(pts[i - 1], p), b = _sub(pts[i + 1], p), la = _len(a), lb = _len(b);
    if (!la || !lb) return 0;
    const cos = Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y) / (la * lb)));
    const theta = Math.acos(cos);                        // π = straight through, 0 = a hairpin
    if (theta > Math.PI - 1e-3 || theta < 1e-3) return 0;
    const tanHalf = Math.tan(theta / 2);
    return Math.max(0, Math.min(R, (Math.min(la, lb) / 2) * tanHalf));
  });
}

/** Smooth: cubic Bézier control points of each segment for a curve THROUGH every point (Catmull-Rom, ends doubled). */
export function smoothControls(pts) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
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
