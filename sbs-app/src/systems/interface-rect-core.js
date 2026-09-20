/**
 * SBS — where a step's INTERFACE sits in the frame (V0.3.4.36), as data.
 *
 * Pure: the stored overlay string in, a rectangle in fractions of the frame
 * out. No Konva, no app imports, no live stage — the step being pictured in
 * the document is usually not the step on screen, and a document picture is
 * rendered long after that step was last loaded.
 */

const _rectMemo = new Map();          // stepId → { ref: the overlay string, rect }

/**
 * 🎯 THE INTERFACE'S RECTANGLE on a step, as DATA (V0.3.4.36) — read out of the
 * stored overlay string, never from the live stage, because the step being
 * pictured in the document is usually not the step on screen.
 *
 * Returns the box in FRACTIONS of the frame ({ x, y, w, h } in 0…1), or null.
 * An interface is one flat Image with isInterface:true; when a step has
 * several, the largest wins — a union would be dragged wide by a small panel
 * parked in a corner, and the picture is meant to be framed on the subject.
 *
 * Konva's transform order is translate(x,y) · rotate · skew · scale ·
 * translate(-offset), so the corners are transformed and the axis-aligned box
 * taken from them; a turned panel then gets the box it really occupies.
 */
export function stepInterfaceRect(step, canonical) {
  const ov = step?.overlay;
  if (typeof ov !== 'string' || !ov || ov.indexOf('"isInterface":true') === -1) return null;
  const memo = _rectMemo.get(step.id);
  if (memo && memo.ref === ov) return memo.rect;
  const W = Number(canonical?.width) || 0, H = Number(canonical?.height) || 0;
  let best = null;
  try {
    (function walk(n) {
      if (!n) return;
      const a = n.attrs;
      if (a?.isInterface && !a.isZoom) {
        const w = Number(a.width) || 0, h = Number(a.height) || 0;
        if (w > 0 && h > 0) {
          const sx = Number.isFinite(Number(a.scaleX)) ? Number(a.scaleX) : 1;
          const sy = Number.isFinite(Number(a.scaleY)) ? Number(a.scaleY) : 1;
          const rot = (Number(a.rotation) || 0) * Math.PI / 180;
          const kx = Number(a.skewX) || 0, ky = Number(a.skewY) || 0;
          const ox = Number(a.offsetX) || 0, oy = Number(a.offsetY) || 0;
          const co = Math.cos(rot), si = Math.sin(rot);
          const pt = (px, py) => {
            // scale → skew → rotate → translate, on a point measured from the offset
            let x = (px - ox) * sx, y = (py - oy) * sy;
            const x2 = x + kx * y, y2 = y + ky * x;
            return { x: (Number(a.x) || 0) + x2 * co - y2 * si, y: (Number(a.y) || 0) + x2 * si + y2 * co };
          };
          const cs = [pt(0, 0), pt(w, 0), pt(w, h), pt(0, h)];
          const box = {
            x: Math.min(...cs.map(c => c.x)), y: Math.min(...cs.map(c => c.y)),
            w: Math.max(...cs.map(c => c.x)) - Math.min(...cs.map(c => c.x)),
            h: Math.max(...cs.map(c => c.y)) - Math.min(...cs.map(c => c.y)),
          };
          if (box.w > 0 && box.h > 0 && (!best || box.w * box.h > best.w * best.h)) best = box;
        }
      }
      (n.children || []).forEach(walk);
    })(JSON.parse(ov));
  } catch { best = null; }
  const rect = (best && W > 0 && H > 0)
    ? { x: best.x / W, y: best.y / H, w: best.w / W, h: best.h / H }
    : null;
  if (step.id) _rectMemo.set(step.id, { ref: ov, rect });
  return rect;
}
