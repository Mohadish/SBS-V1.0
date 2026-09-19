/**
 * SBS — rubber-band selection, the geometry and the rules (V0.3.4.11). Pure: no Konva, no DOM —
 * the overlay hands it plain points, so it runs under node for tests.
 *
 * The rules are the 3D scene's box-select, unchanged:
 *   (no key)   the box TOUCHES the item                 → "intersect" mode, REPLACE the selection
 *   Ctrl / ⌘   the item lies FULLY inside the box       → "window" mode
 *   Shift      ADD what the box caught to the selection
 *   Alt        REMOVE what the box caught from it       (Alt wins over Shift)
 *
 * "Touches" is tested against the item's TRUE outline, not its axis-aligned bounding box: a
 * rotated rectangle is its four corners, an arrow / line is its segments (with half its stroke
 * as thickness) — so a box drawn in the empty corner of a diagonal arrow's bounding box does
 * not catch the arrow.
 */

export const MARQUEE_THRESHOLD_PX = 6;          // the 3D scene's: below this a press-release is a click

/** @returns {{x:number,y:number,w:number,h:number}} normalised rectangle from two corners */
export function rectOf(x1, y1, x2, y2) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/** What the modifier keys mean. */
export function marqueeOp({ ctrl = false, shift = false, alt = false } = {}) {
  return { windowMode: !!ctrl, op: alt ? 'remove' : shift ? 'add' : 'replace' };
}

const _inside = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/** Every point of the outline inside the rectangle. */
export function pointsInsideRect(pts, r) {
  return pts.length > 0 && pts.every(p => _inside(p, r));
}

/** Segment a→b against an axis-aligned rectangle (Liang–Barsky). */
export function segmentIntersectsRect(a, b, r) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;                  // parallel to this edge: inside it or not at all
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else       { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, a.x - r.x) && clip(dx, r.x + r.w - a.x) && clip(-dy, a.y - r.y) && clip(dy, r.y + r.h - a.y);
}

/**
 * A CONVEX polygon against an axis-aligned rectangle — separating axes: the rectangle's two,
 * then one per polygon edge. No separating axis = they overlap (touching counts).
 */
export function convexIntersectsRect(poly, r) {
  if (poly.length === 0) return false;
  if (poly.length === 1) return _inside(poly[0], r);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  if (maxX < r.x || minX > r.x + r.w || maxY < r.y || minY > r.y + r.h) return false;
  const rc = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const nx = -(b.y - a.y), ny = b.x - a.x;
    if (nx === 0 && ny === 0) continue;          // a repeated point
    let pMin = Infinity, pMax = -Infinity, rMin = Infinity, rMax = -Infinity;
    for (const p of poly) { const d = p.x * nx + p.y * ny; if (d < pMin) pMin = d; if (d > pMax) pMax = d; }
    for (const p of rc)   { const d = p.x * nx + p.y * ny; if (d < rMin) rMin = d; if (d > rMax) rMax = d; }
    if (pMax < rMin || rMax < pMin) return false;
  }
  return true;
}

/** An open polyline (an arrow, a line) with a thickness: any segment reaches the rectangle grown by half the stroke. */
export function polylineIntersectsRect(pts, r, halfWidth = 0) {
  const g = { x: r.x - halfWidth, y: r.y - halfWidth, w: r.w + halfWidth * 2, h: r.h + halfWidth * 2 };
  if (pts.length === 1) return _inside(pts[0], g);
  for (let i = 0; i + 1 < pts.length; i++) if (segmentIntersectsRect(pts[i], pts[i + 1], g)) return true;
  return false;
}

/** Even–odd rule: is p inside the (closed, possibly concave) polygon? */
export function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A CLOSED polygon (V0.3.4.18 — convex or not) against a rectangle: an edge (the closing one too) reaches it, or it lies inside. */
export function closedIntersectsRect(pts, r, halfWidth = 0) {
  if (pts.length < 3) return polylineIntersectsRect(pts, r, halfWidth);
  if (polylineIntersectsRect([...pts, pts[0]], r, halfWidth)) return true;
  return pointInPolygon({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, pts);        // no edge reaches the box: it is either wholly inside the polygon or wholly outside
}

/**
 * @param {Array<{id:*, kind:'poly'|'line'|'closed', pts:{x:number,y:number}[], halfWidth?:number}>} items
 *        pts in the SAME space as rect. 'poly' = a convex outline (the item's own box through its
 *        transform); 'line' = an open polyline.
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @param {boolean} windowMode  true = only items fully inside
 * @returns {Array} ids caught, in the items' order
 */
export function pickInMarquee(items, rect, windowMode = false) {
  const out = [];
  for (const it of items || []) {
    const pts = it?.pts || [];
    if (!pts.length || pts.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) continue;
    const hit = windowMode
      ? pointsInsideRect(pts, it.kind === 'line' && it.halfWidth ? { x: rect.x + it.halfWidth, y: rect.y + it.halfWidth, w: rect.w - it.halfWidth * 2, h: rect.h - it.halfWidth * 2 } : rect)
      : (it.kind === 'line' ? polylineIntersectsRect(pts, rect, it.halfWidth || 0) : it.kind === 'closed' ? closedIntersectsRect(pts, rect, it.halfWidth || 0) : convexIntersectsRect(pts, rect));
    if (hit) out.push(it.id);
  }
  return out;
}

/**
 * The new selection. Order is kept stable: what was selected stays in its order, what is added
 * follows in the order it was found (the transformer's first node is the "primary" for toolbars).
 */
export function applyMarquee(current, found, op = 'replace') {
  const cur = [...(current || [])], hit = new Set(found || []);
  if (op === 'remove') return cur.filter(id => !hit.has(id));
  if (op === 'add') { const have = new Set(cur); return [...cur, ...(found || []).filter(id => !have.has(id))]; }
  return [...(found || [])];
}
