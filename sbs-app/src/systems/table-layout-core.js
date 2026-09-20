/**
 * SBS — where a table's cells actually sit (V0.3.4.45), in plain numbers.
 *
 * The document draws its tables with HTML and CSS, which measures itself. On
 * the ANIMATION overlay there is no CSS: the table is drawn on a canvas, so
 * something has to say where every line and every word goes. That is this
 * module, and it is pure — no Konva, no DOM — so it can be tested offline and
 * reused by the drawing, by the hit test and by the editor alike.
 *
 * UNITS. The box comes in as width and height in canvas pixels. Column widths
 * are fractions of the box (they already are, everywhere in this app) and row
 * heights are fractions too, with 0 meaning "share what is left with the other
 * automatic rows" — so a table keeps its proportions when the item is resized,
 * which is what a reader expects of a shape on the overlay.
 *
 * (The document's own tables keep their millimetres; nothing here touches them.)
 */

import { mergeMap } from './document-core.js';

const _num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** Column edges in pixels: widths are fractions and always sum to 1. */
function _colsOf(t, W) {
  const n = Math.max(1, t?.cols | 0);
  const raw = Array.from({ length: n }, (_, i) => Math.max(0, _num(t?.widths?.[i], 1 / n)));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const out = [];
  let x = 0;
  for (let i = 0; i < n; i++) {
    const w = (raw[i] / sum) * W;
    out.push({ x, w });
    x += w;
  }
  return out;
}

/**
 * Row edges in pixels. A row with a height of its own keeps it; the rest share
 * whatever is left, and never less than nothing — a table crammed into a short
 * box gives its automatic rows zero rather than negative height.
 */
function _rowsOf(t, H) {
  const n = Math.max(1, t?.rows | 0);
  const set = Array.from({ length: n }, (_, i) => Math.max(0, _num(t?.rowH?.[i], 0)));
  const fixed = set.reduce((a, b) => a + b, 0);
  const autos = set.filter(v => v <= 0).length;
  const left = Math.max(0, 1 - fixed);
  const share = autos ? left / autos : 0;
  const out = [];
  let y = 0;
  for (let i = 0; i < n; i++) {
    const h = (set[i] > 0 ? set[i] : share) * H;
    out.push({ y, h });
    y += h;
  }
  return out;
}

/**
 * The whole geometry: one entry per VISIBLE cell (a merged block appears once,
 * with the box it really covers), plus the grid lines to stroke.
 *
 * @param {object} t   a table item (rows, cols, cells, widths, rowH, merges, fmt, imgs)
 * @param {number} W   box width in pixels
 * @param {number} H   box height in pixels
 */
export function layoutTable(t, W, H) {
  const cols = _colsOf(t, Math.max(0, _num(W)));
  const rows = _rowsOf(t, Math.max(0, _num(H)));
  const { starts, covered } = mergeMap(t);
  const cells = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols.length; c++) {
      const key = `${r},${c}`;
      if (covered.has(key)) continue;
      const m = starts.get(key);
      const rs = m ? m.rs : 1, cs = m ? m.cs : 1;
      const last = cols[Math.min(cols.length - 1, c + cs - 1)];
      const bottom = rows[Math.min(rows.length - 1, r + rs - 1)];
      cells.push({
        r, c, rs, cs, key,
        x: cols[c].x, y: rows[r].y,
        w: (last.x + last.w) - cols[c].x,
        h: (bottom.y + bottom.h) - rows[r].y,
        text: String(t?.cells?.[r]?.[c] ?? ''),
        fmt: t?.fmt?.[key] || null,
        img: t?.imgs?.[key] || null,
        head: t?.head !== false && r === 0,
      });
    }
  }
  return { cols, rows, cells, w: cols.reduce((a, b) => a + b.w, 0), h: rows.reduce((a, b) => a + b.h, 0) };
}

/**
 * The grid lines, as segments — an inner line is only drawn where it is not
 * swallowed by a merge, which is what makes a merged block read as one cell.
 */
export function tableLines(t, layout) {
  const { cols, rows, cells } = layout;
  const W = layout.w, H = layout.h;
  const out = [];
  const push = (x1, y1, x2, y2) => out.push({ x1, y1, x2, y2 });
  // the frame
  push(0, 0, W, 0); push(0, H, W, H); push(0, 0, 0, H); push(W, 0, W, H);
  // every visible cell draws its own right and bottom edge, so merges leave no
  // stray line through the middle of themselves
  for (const cell of cells) {
    const right = cell.x + cell.w, bottom = cell.y + cell.h;
    if (right < W - 0.01) push(right, cell.y, right, bottom);
    if (bottom < H - 0.01) push(cell.x, bottom, right, bottom);
  }
  void cols; void rows;
  return out;
}

/** Which cell is under a point, in the box's own coordinates. null outside. */
export function cellAt(layout, x, y) {
  for (const cell of layout?.cells || []) {
    if (x >= cell.x && x < cell.x + cell.w && y >= cell.y && y < cell.y + cell.h) return cell;
  }
  return null;
}

/** The nearest column border to a point, for dragging a width. -1 = none. */
export function colBorderAt(layout, x, tol = 4) {
  let best = -1, bestD = tol;
  const cols = layout?.cols || [];
  for (let i = 0; i < cols.length - 1; i++) {
    const edge = cols[i].x + cols[i].w;
    const d = Math.abs(x - edge);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** …and the nearest row border. */
export function rowBorderAt(layout, y, tol = 4) {
  let best = -1, bestD = tol;
  const rows = layout?.rows || [];
  for (let i = 0; i < rows.length - 1; i++) {
    const edge = rows[i].y + rows[i].h;
    const d = Math.abs(y - edge);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Column widths after dragging border `i` to `x` — as fractions, never letting
 * a column fall under 3% of the table, and only ever moving the two columns
 * that share the border.
 */
export function resizeColumn(t, layout, i, x) {
  const cols = layout.cols, W = layout.w || 1;
  if (i < 0 || i >= cols.length - 1) return null;
  const left = cols[i], right = cols[i + 1];
  const room = left.w + right.w;
  const MIN = 0.03 * W;
  const wLeft = Math.min(Math.max(x - left.x, MIN), room - MIN);
  const out = (t.widths || []).slice();
  const scale = (left.w + right.w) / W;
  const total = out.reduce((a, b) => a + b, 0) || 1;
  out[i] = (wLeft / W) * (total / 1) * (1 / (scale / (scale || 1)));
  out[i] = (wLeft / W) * total;
  out[i + 1] = ((room - wLeft) / W) * total;
  const sum = out.reduce((a, b) => a + b, 0) || 1;
  return out.map(v => v / sum);
}

/** Row heights after dragging border `i` to `y`, as fractions of the box. */
export function resizeRow(t, layout, i, y) {
  const rows = layout.rows, H = layout.h || 1;
  if (i < 0 || i >= rows.length - 1) return null;
  const top = rows[i];
  const MIN = 0.02 * H;
  const h = Math.min(Math.max(y - top.y, MIN), Math.max(MIN, H - top.y - MIN));
  const out = Array.from({ length: rows.length }, (_, k) => Math.max(0, _num(t?.rowH?.[k], 0)));
  out[i] = h / H;
  // the row below keeps its own height if it had one, so the drag is local
  if (out[i + 1] > 0) {
    const room = (rows[i].h + rows[i + 1].h) / H;
    out[i + 1] = Math.max(0.02, room - out[i]);
  }
  return out;
}
