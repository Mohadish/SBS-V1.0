/**
 * SBS — a table as HTML (V0.3.4.45), for the ANIMATION overlay.
 *
 * The overlay draws every text box by putting HTML inside an SVG foreignObject
 * and rasterising it (overlay.js _htmlToCanvas), and the table of contents is a
 * whole generated block done exactly that way. A table is the same idea: the
 * step stores the table's DATA, the picture is made from it on load, and only
 * the data is ever saved — no pixels per step.
 *
 * Two rules the rasteriser imposes, and both are why this is its own module:
 *   • the markup must be XHTML — every tag closed, every void tag self-closed
 *     (an unclosed <col> swallows the rest of the table);
 *   • there is no stylesheet — every style is inline, on the element.
 *
 * Pure: no DOM, no Konva. The document's own tables keep their millimetres and
 * their CSS; this is the canvas-pixel twin of them.
 */

const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A table as it starts life on the overlay: three by three, a heading row. */
export function defaultOverlayTable() {
  return {
    rows: 3, cols: 3,
    cells: [['', '', ''], ['', '', ''], ['', '', '']],
    widths: [1 / 3, 1 / 3, 1 / 3],
    rowH: [],                       // the overlay lets rows take the height they need
    merges: [], fmt: {}, imgs: {},
    head: true, grid: true, zebra: false,
    size: 15, align: 'start', color: '#111111',
    bg: '#ffffffee', line: '#555555', headBg: '#ececec',
  };
}

/** The look of one cell, as an inline style. */
function _cellStyle(t, r, c, pad) {
  const f = t.fmt?.[`${r},${c}`] || {};
  const head = t.head !== false && r === 0;
  const grid = t.grid !== false;
  const bg = f.bg || (head ? (t.headBg || '#ececec') : (t.zebra && r % 2 === 1 ? '#00000010' : ''));
  return [
    grid ? `border:1px solid ${t.line || '#555555'}` : `border:0;border-bottom:1px solid ${t.line || '#999999'}`,
    `padding:${pad}px ${pad * 1.4}px`,
    'vertical-align:top',
    'word-break:break-word',
    `text-align:${f.a || t.align || 'start'}`,
    `font-weight:${f.b || head ? 700 : 400}`,
    f.i ? 'font-style:italic' : 'font-style:normal',
    f.c ? `color:${f.c}` : '',
    f.s ? `font-size:${Number(f.s)}px` : '',
    bg ? `background:${bg}` : '',
  ].filter(Boolean).join(';');
}

/**
 * The table, ready for the rasteriser.
 *
 * @param {object} t      the table data
 * @param {object} opts   { width }  the box width in canvas pixels
 */
export function tableOverlayHtml(t, opts = {}) {
  const fixedH = Number(opts.height) > 0 ? Math.round(Number(opts.height)) : 0;
  if (!t?.rows || !t?.cols) return '<div></div>';
  const size = Math.max(6, Number(t.size) || 15);
  // A row should look like a line of text with a little air, not a box twice
  // the height of its letters: 0.35 of the font added top AND bottom made a
  // 15px font sit in a 30px row. 0.22 keeps it readable at about 1.7 lines.
  const pad = Math.max(2, Math.round(size * 0.22));
  const widths = Array.from({ length: t.cols }, (_, i) => Math.max(0.02, Number(t.widths?.[i]) || 1 / t.cols));
  const sum = widths.reduce((a, b) => a + b, 0) || 1;
  // <col/> MUST be self-closed: the rasteriser parses XHTML, and a bare <col>
  // eats every row after it.
  const cg = `<colgroup>${widths.map(w => `<col style="width:${((w / sum) * 100).toFixed(3)}%"/>`).join('')}</colgroup>`;

  const covered = new Set(), starts = new Map();
  for (const m of t.merges || []) {
    starts.set(`${m.r},${m.c}`, m);
    for (let y = m.r; y < m.r + m.rs; y++) {
      for (let x = m.c; x < m.c + m.cs; x++) if (y !== m.r || x !== m.c) covered.add(`${y},${x}`);
    }
  }

  const body = (t.cells || []).map((row, r) => {
    const tds = (row || []).map((cell, c) => {
      if (covered.has(`${r},${c}`)) return '';
      const m = starts.get(`${r},${c}`);
      const span = m ? ` colspan="${m.cs}" rowspan="${m.rs}"` : '';
      return `<td data-cell="${r},${c}"${span} style="${_cellStyle(t, r, c, pad)}">${_esc(cell) || '&#160;'}</td>`;
    }).join('');
    const h = Number(t.rowH?.[r]) > 0 ? `height:${Math.round(Number(t.rowH[r]))}px;` : '';
    return `<tr style="${h}">${tds}</tr>`;
  }).join('');

  const frame = [
    'width:100%',
    'border-collapse:collapse',
    'table-layout:fixed',                       // what makes the drawn width match the stored one
    `font-size:${size}px`,
    'line-height:1.25',
    `color:${t.color || '#111111'}`,
    t.bg ? `background:${t.bg}` : '',
    // a height the user dragged: the rows share it, the way an HTML table fills
    // a box it is given
    fixedH ? `height:${fixedH}px` : '',
  ].filter(Boolean).join(';');

  return `<table style="${frame}">${cg}<tbody>${body}</tbody></table>`;
}
