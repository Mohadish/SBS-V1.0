/**
 * ▣ Cells — the fit maths, pure (V0.3.6.12). Shared by the overlay (live fitting) and by the importers
 * (pdf2sbs, Steps from Excel), which write a picture's initial geometry the same way the app will refit it.
 * A cell = a pinned position (constShapes def) with a size: { x, y, w, h, align }.
 */
export const CELL_ALIGN = { tl: [0, 0], t: [0.5, 0], tr: [1, 0], l: [0, 0.5], c: [0.5, 0.5], r: [1, 0.5], bl: [0, 1], b: [0.5, 1], br: [1, 1] };
export const CELL_ALIGN_LABELS = { tl: '⌜ top-left', t: '⌃ top', tr: '⌝ top-right', l: '⟨ left', c: '⊙ centre', r: '⟩ right', bl: '⌞ bottom-left', b: '⌄ bottom', br: '⌟ bottom-right' };

/** Is this constShapes definition a cell (a pin that knows its size)? */
export function isCellDef(def) { return !!(def && Number(def.w) > 0 && Number(def.h) > 0); }

/**
 * A node whose visible rect is `v` and origin `o` (canvas px) → { k, x, y }: the uniform scale that fits `v`
 * whole into the cell (times `scale`, a picture's own share of the fit) and the origin that puts the scaled
 * rect at the cell's alignment point.
 */
export function cellFit(v, o, def, scale = 1) {
  const k = Math.min(def.w / Math.max(1e-6, v.w), def.h / Math.max(1e-6, v.h)) * (scale > 0 ? scale : 1);
  const [ax, ay] = CELL_ALIGN[def.align] || CELL_ALIGN.c;
  const tx = def.x + (def.w - v.w * k) * ax, ty = def.y + (def.h - v.h * k) * ay;   // the visible rect's new top-left
  return { k, x: tx - (v.x - o.x) * k, y: ty - (v.y - o.y) * k };
}

/** The rect a W×H picture (its own box, no mask) takes inside the cell — what an importer writes as the node's geometry. */
export function cellRectFor(W, H, def, scale = 1) {
  const f = cellFit({ x: 0, y: 0, w: W, h: H }, { x: 0, y: 0 }, def, scale);
  return { x: Math.round(f.x), y: Math.round(f.y), width: Math.round(W * f.k), height: Math.round(H * f.k), k: f.k };
}
