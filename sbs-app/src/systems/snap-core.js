/**
 * SBS — the magnet: snapping a dragged box to other boxes and to the picture frame
 * (V0.3.4.12). Pure: boxes in, a correction + guide lines out. No Konva, no DOM — it runs
 * under node for tests, and the same maths can serve the document's pages later.
 *
 * Every box has three lines per axis: left / centre / right and top / middle / bottom. While
 * a box moves, each of ITS lines looks for a line of another box (or of the frame) within
 * the magnet distance; the axis is corrected by the smallest such gap. Both axes are
 * independent, so a box can sit on a vertical and a horizontal guide at once.
 *
 * "The part you hold wins": the moving line nearest to where the pointer holds the box is
 * asked first — hold an item by its left edge and its left edge is what snaps; hold it by
 * the middle and its centre does. Only when that line finds nothing do the other two get
 * their turn. A multi-selection is ONE box (the caller passes the union), so the group
 * keeps its shape and snaps by its outer lines and its centre.
 */

const EPS = 0.01;

/** @returns {{x:number,y:number,w:number,h:number}|null} the box around all the boxes */
export function unionBox(boxes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes || []) {
    if (!b || ![b.x, b.y, b.w, b.h].every(Number.isFinite)) continue;
    if (b.x < x0) x0 = b.x; if (b.y < y0) y0 = b.y;
    if (b.x + b.w > x1) x1 = b.x + b.w; if (b.y + b.h > y1) y1 = b.y + b.h;
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const _lines = (b, axis) => (axis === 'x' ? [b.x, b.x + b.w / 2, b.x + b.w] : [b.y, b.y + b.h / 2, b.y + b.h]);
const LINE_NAMES = { x: ['left', 'centre', 'right'], y: ['top', 'middle', 'bottom'] };

function _snapAxis(axis, box, targets, distance, grab) {
  const mine = _lines(box, axis);
  // which of my three lines is nearest to the hand
  let held = 1;
  if (grab && Number.isFinite(grab[axis])) { let best = Infinity; mine.forEach((v, i) => { const d = Math.abs(grab[axis] - v); if (d < best) { best = d; held = i; } }); }
  const nearest = (idxs) => {
    let pick = null;
    for (const i of idxs) for (const t of targets) {
      const tl = _lines(t.box, axis);
      for (let k = 0; k < 3; k++) {
        const gap = tl[k] - mine[i];
        if (Math.abs(gap) > distance) continue;
        if (!pick || Math.abs(gap) < Math.abs(pick.gap) - EPS) pick = { gap, at: tl[k], mine: i, theirs: k, target: t };
      }
    }
    return pick;
  };
  // the held line is asked first; only when it finds nothing do the other two get their turn (the nearer of them wins)
  return nearest([held]) || nearest([0, 1, 2].filter(i => i !== held));
}

/**
 * @param {{x,y,w,h}} box         the moving box where the pointer has put it (not yet corrected)
 * @param {Array<{x,y,w,h,id?:*}>} others  the boxes it may snap to
 * @param {object} [o]
 * @param {number} [o.distance=8]  magnet distance, in the SAME units as the boxes
 * @param {{w:number,h:number}|null} [o.frame]  the picture frame (0,0)–(w,h): its edges and its centre are lines too
 * @param {{x:number,y:number}|null} [o.grab]   where the pointer holds the moving box
 * @returns {{dx:number, dy:number, guides:Array<{axis:'x'|'y', at:number, from:number, to:number, mine:string, theirs:string, frame:boolean}>}}
 *          dx / dy = the correction to add; a guide on axis 'x' is a VERTICAL line at x = at, from y = from to y = to
 */
export function snapBox(box, others, o = {}) {
  const out = { dx: 0, dy: 0, guides: [] };
  if (!box || ![box.x, box.y, box.w, box.h].every(Number.isFinite)) return out;
  const distance = Number.isFinite(o.distance) && o.distance > 0 ? o.distance : 8;
  const targets = (others || []).filter(b => b && [b.x, b.y, b.w, b.h].every(Number.isFinite)).map(b => ({ box: b, frame: false }));
  const f = o.frame;
  if (f && f.w > 0 && f.h > 0) targets.push({ box: { x: 0, y: 0, w: f.w, h: f.h }, frame: true });
  if (!targets.length) return out;

  const px = _snapAxis('x', box, targets, distance, o.grab), py = _snapAxis('y', box, targets, distance, o.grab);
  if (px) out.dx = px.gap;
  if (py) out.dy = py.gap;
  const moved = { x: box.x + out.dx, y: box.y + out.dy, w: box.w, h: box.h };

  // one guide per snapped axis, running through EVERY box that shares the line — so three items in a row show one line
  for (const [axis, p] of [['x', px], ['y', py]]) {
    if (!p) continue;
    const cross = axis === 'x' ? 'y' : 'x', size = axis === 'x' ? 'h' : 'w';
    let from = moved[cross], to = moved[cross] + moved[size], onFrame = false;
    for (const t of targets) {
      if (!_lines(t.box, axis).some(v => Math.abs(v - p.at) <= EPS)) continue;
      if (t.frame) onFrame = true;
      from = Math.min(from, t.box[cross]); to = Math.max(to, t.box[cross] + t.box[size]);
    }
    out.guides.push({ axis, at: p.at, from, to, mine: LINE_NAMES[axis][p.mine], theirs: LINE_NAMES[axis][p.theirs], frame: onFrame && p.target.frame });
  }
  return out;
}
