/**
 * SBS — editing an overlay table in place (V0.3.4.47).
 *
 * The table on the canvas is a picture of HTML. To edit it, the real HTML is
 * mounted over the canvas at the same place and size — so what you see is what
 * will be drawn — and this module owns everything that happens there: picking
 * cells, typing in one, the two-row bar, the grips that move and resize rows
 * and columns, and pasting a block out of a spreadsheet.
 *
 * ONE COPY OF THE TRUTH. The first version kept its own copy of the table and
 * wrote it back when it closed. Anything that changed the table from outside
 * (the right-click menu, an undo) was then silently overwritten on exit — the
 * menu looked dead, and leaving the table could put a stale shape back. So:
 * the OWNER holds the data. This module never decides what the table is; it
 * asks for it (`ctx.getData()`) and asks for changes (`ctx.apply(patch,
 * label)`), and `refreshOverlayTableEditor()` tells it to re-read when the
 * table changed underneath it. Every change is one undo entry, pushed by the
 * owner as it happens — not one entry at the end.
 *
 * It knows nothing about Konva.
 */

import { tableOverlayHtml } from '../systems/table-html.js';
import {
  tableInsertRow, tableDeleteRows, tableInsertCol, tableDeleteCols,
  tableMerge, tableUnmerge, canMerge, mergeAt, tableSetFmt, tablePaste, tablePasteRich,
  tableMoveRow, tableMoveCol, tableRowMovable, tableColMovable,
} from '../systems/document-core.js';
import { undoManager } from '../systems/undo.js';
import { setStatus } from './status.js';

const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Every table edit is pushed under this scope, so Ctrl+Z inside the table
 *  undoes the table and nothing else (the same trick the document uses). */
export const TABLE_UNDO_SCOPE = 'overlayTable';

const MIN_COL = 0.05;     // a column may not be squeezed below this fraction
const MIN_ROW_PX = 12;    // …nor a row below a line's worth of pixels

let _open = null;

/** Cells copied inside the app — the look travels with the text, which the
 *  system clipboard's plain tab-separated text cannot carry. */
let _clip = null;

export function isOverlayTableEditorOpen() { return !!_open; }

/** The table changed underneath the panel (a menu command, an undo): re-read. */
export function refreshOverlayTableEditor() {
  const st = _open;
  if (!st) return;
  const next = st.ctx.getData?.();
  if (!next) return;
  // The open cell belongs to HTML that is about to be replaced. Forget it, or
  // the next commit would write pre-undo text back over the new data.
  st.editing = null;
  st.data = next;
  _clampSel(st);
  _draw(st);
}

/** Close it, committing whatever is in the open cell. */
export function closeOverlayTableEditor(abandon = false) {
  const st = _open; _open = null;
  if (!st) return;
  document.removeEventListener('pointerdown', st.away, true);
  window.removeEventListener('resize', st.place);
  window.removeEventListener('keydown', st.keys, true);
  window.removeEventListener('pointermove', st.move, true);
  window.removeEventListener('pointerup', st.up, true);
  document.removeEventListener('paste', st.paste, true);
  if (!abandon) { _open = st; _commitOpenCell(st); _open = null; }
  st.host.remove();
  st.bar.remove();
  st.chrome.remove();
  st.ctx.onClose?.();
}

// ─────────────────────────── geometry ───────────────────────────

function _rect(st) { return { ...st.ctx.rect() }; }

function _place(st) {
  const r = _rect(st);
  const tf = `scale(${r.scale})${r.rot ? ` rotate(${r.rot}deg)` : ''}`;
  st.host.style.left = `${Math.round(r.left)}px`;
  st.host.style.top = `${Math.round(r.top)}px`;
  st.host.style.width = `${Math.round(r.width)}px`;
  // A height only when one was dragged — otherwise the rows take what they
  // need, exactly as the rasteriser lets them.
  st.host.style.height = Number(r.height) > 0 ? `${Math.round(r.height)}px` : '';
  st.host.style.transform = tf;
  st.chrome.style.left = st.host.style.left;
  st.chrome.style.top = st.host.style.top;
  st.chrome.style.transform = tf;
  _placeBar(st);
}

/**
 * The bar clears the TABLE and the column grips above it — it used to sit on
 * top of both, hiding the first row and the very grips you drag. It is
 * measured after it is filled (its height changes with what is on it), and
 * when there is no room above the table it goes underneath instead.
 */
function _placeBar(st) {
  const H = st.host.getBoundingClientRect();
  const barH = st.bar.offsetHeight || 58;
  const GRIP = 30;                                   // the column grips live above the table
  let top = H.top - GRIP - barH - 8;
  if (top < 6) top = (H.bottom || H.top) + 16;       // no room above: under the table
  st.bar.style.left = `${Math.round(Math.max(6, H.left))}px`;
  st.bar.style.top = `${Math.round(top)}px`;
}

/** The picked rectangle, normalised. */
function _sel(st) {
  const s = st.sel;
  if (!s) return null;
  return {
    r0: Math.min(s.r0, s.r1), c0: Math.min(s.c0, s.c1),
    r1: Math.max(s.r0, s.r1), c1: Math.max(s.c0, s.c1),
  };
}

/** A row or a column may have gone (an undo, a delete): keep the pick inside. */
function _clampSel(st) {
  if (!st.sel) return;
  const R = Math.max(1, st.data.rows) - 1, C = Math.max(1, st.data.cols) - 1;
  const k = (v, m) => Math.max(0, Math.min(m, Number(v) || 0));
  st.sel = { r0: k(st.sel.r0, R), c0: k(st.sel.c0, C), r1: k(st.sel.r1, R), c1: k(st.sel.c1, C) };
}

// ─────────────────────────── drawing ───────────────────────────

function _cells(st) { return st.host.querySelectorAll('td[data-cell]'); }

function _paintSel(st) {
  const s = _sel(st);
  for (const td of _cells(st)) {
    const [r, c] = String(td.dataset.cell || '').split(',').map(Number);
    const on = s && r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1;
    td.style.outline = on ? '2px solid #2563eb' : '';
    td.style.outlineOffset = on ? '-2px' : '';
  }
  _bar(st);
}

function _draw(st) {
  const r = _rect(st);
  st.host.innerHTML = tableOverlayHtml(st.data, {
    width: Math.round(r.width),
    ...(Number(r.height) > 0 ? { height: Math.round(r.height) } : {}),
  });
  for (const td of _cells(st)) {
    td.style.cursor = 'cell';
    td.style.userSelect = 'none';
  }
  _place(st);
  _paintSel(st);
  _chrome(st);
}

/**
 * The grips: a bar above every column and beside every row (click to pick the
 * whole line, drag to move it), and a thin handle on every inner border (drag
 * to say how wide a column or how tall a row is). They live in their own fixed
 * layer, NOT inside the table, so the table stays a pixel-exact twin of the
 * picture while the grips are free to hang outside it.
 */
function _chrome(st) {
  const r = _rect(st);
  const sc = r.scale > 0 ? r.scale : 1;
  const S = 1 / sc;                                 // keep the grips a constant size on screen
  st.chrome.innerHTML = '';
  const table = st.host.querySelector('table');
  if (!table) { st.geom = null; return; }
  const H = st.host.getBoundingClientRect();
  if (!(H.width > 0)) { st.geom = null; return; }
  const W = Math.round(r.width);                    // host-local width (un-scaled)
  const rows = [...table.querySelectorAll('tr')].map(tr => {
    const b = tr.getBoundingClientRect();
    return { top: (b.top - H.top) / sc, h: b.height / sc };
  });
  const raw = Array.from({ length: st.data.cols }, (_, i) => {
    const w = Number(st.data.widths?.[i]);
    return w > 0 ? w : 1 / Math.max(1, st.data.cols);
  });
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const cols = raw.map(w => (w / sum) * W);
  const TH = 15 * S, HIT = 9 * S, GAP = 5 * S;
  const grip = 'border:0;margin:0;position:absolute;background:rgba(56,189,248,.5);border-radius:2px;pointer-events:auto;';
  const bar = 'border:0;margin:0;position:absolute;background:rgba(56,189,248,.28);pointer-events:auto;';
  let html = '';
  let x = 0;
  for (let i = 0; i < cols.length; i++) {
    const w = cols[i];
    html += `<i data-colg="${i}" title="Click: pick the column. Drag: move it." style="${grip}left:${x}px;top:${-TH - GAP}px;width:${Math.max(4 * S, w - 2 * S)}px;height:${TH}px;cursor:grab;"></i>`;
    x += w;
    if (i < cols.length - 1) {
      html += `<i data-colh="${i}" title="Drag: how wide this column is" style="${bar}left:${x - HIT / 2}px;top:0;width:${HIT}px;height:100%;cursor:col-resize;"></i>`;
    }
  }
  for (let i = 0; i < rows.length; i++) {
    html += `<i data-rowg="${i}" title="Click: pick the row. Drag: move it." style="${grip}left:${-TH - GAP}px;top:${rows[i].top}px;width:${TH}px;height:${Math.max(4 * S, rows[i].h - 2 * S)}px;cursor:grab;"></i>`;
    if (i < rows.length - 1) {
      html += `<i data-rowh="${i}" title="Drag: how tall this row is" style="${bar}left:0;top:${rows[i].top + rows[i].h - HIT / 2}px;width:100%;height:${HIT}px;cursor:row-resize;"></i>`;
    }
  }
  // the grip layer is a zero-sized anchor; the bars need the table's width
  st.chrome.style.width = `${W}px`;
  st.chrome.style.height = `${rows.length ? rows.at(-1).top + rows.at(-1).h : 0}px`;
  st.chrome.innerHTML = html;
  st.geom = { W, rows, cols, S };
}

/** The orange line that says where a dragged row or column will land. */
function _dropLine(st, kind, to) {
  const old = st.chrome.querySelector('[data-drop]');
  if (old) old.remove();
  const g = st.geom;
  if (!g || to == null) return;
  const el = document.createElement('i');
  const base = 'position:absolute;background:#f59e0b;border-radius:2px;pointer-events:none;';
  if (kind === 'row') {
    const last = g.rows.at(-1);
    const y = to >= g.rows.length ? (last ? last.top + last.h : 0) : g.rows[to].top;
    el.style.cssText = `${base}left:0;top:${y - 1.5 * g.S}px;width:100%;height:${3 * g.S}px;`;
  } else {
    let x = 0;
    for (let i = 0; i < to && i < g.cols.length; i++) x += g.cols[i];
    el.style.cssText = `${base}top:0;left:${x - 1.5 * g.S}px;height:100%;width:${3 * g.S}px;`;
  }
  el.dataset.drop = '1';
  st.chrome.appendChild(el);
}

// ─────────────────────────── writing ───────────────────────────

/** Read the open cell back and commit it as its own change. */
function _commitOpenCell(st) {
  const td = st.editing;
  if (!td) return false;
  st.editing = null;
  td.removeAttribute('contenteditable');
  const [r, c] = String(td.dataset.cell || '').split(',').map(Number);
  const text = String(td.innerText ?? '').replace(/ /g, ' ').replace(/\n+$/, '');
  if (!(r >= 0 && c >= 0)) return false;
  if (text === (st.data.cells?.[r]?.[c] ?? '')) return false;
  const cells = st.data.cells.map((row, y) => row.map((v, x) => (y === r && x === c ? text : v)));
  _apply(st, { cells }, 'Edit cell');
  return true;
}

/**
 * Hand a change to the owner and take back whatever the table now is. The
 * owner writes it, redraws the picture and pushes the undo entry.
 */
function _apply(st, patch, label) {
  if (!patch || !_open) return false;
  const next = st.ctx.apply?.(patch, label);
  if (!next) return false;
  st.data = next;
  _clampSel(st);
  _draw(st);
  return true;
}

// ─────────────────────────── the bar ───────────────────────────

function _bar(st) {
  // Never rebuild the bar mid-gesture — while a button is being pressed, or
  // while a swatch is held open or a size is being typed: the element under
  // the user's finger would vanish under it.
  if (st.holdBar) return;
  const act = document.activeElement;
  if (act && st.bar.contains(act) && act.tagName === 'INPUT') return;
  const s = _sel(st);
  const one = s && s.r0 === s.r1 && s.c0 === s.c1;
  const f = s ? (st.data.fmt?.[`${s.r0},${s.c0}`] || {}) : {};
  const b = (a, label, title, on) =>
    `<button data-t="${a}" title="${_esc(title)}" style="height:22px;padding:0 7px;font-size:11.5px;border-radius:5px;cursor:pointer;`
    + `border:1px solid ${on ? '#38bdf8' : 'rgba(255,255,255,.12)'};background:${on ? '#1d3a5f' : 'rgba(15,23,42,.9)'};color:#e2e8f0;">${label}</button>`;
  const where = !s ? 'no cells picked' : one ? `row ${s.r0 + 1}, column ${s.c0 + 1}` : `${s.r1 - s.r0 + 1}×${s.c1 - s.c0 + 1} cells`;
  const canM = s && canMerge(st.data, s.r0, s.c0, s.r1, s.c1);
  const canU = s && !!mergeAt(st.data, s.r0, s.c0);
  st.bar.innerHTML =
    `<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">`
    + `<span style="color:#7dd3fc;font-size:11px;">${_esc(where)}</span>`
    + b('bold', '<b>B</b>', 'Bold', !!f.b) + b('italic', '<i>I</i>', 'Italic', !!f.i)
    + b('al-start', '⫷', 'Align to the start', f.a === 'start') + b('al-center', '⫿', 'Centre', f.a === 'center') + b('al-end', '⫸', 'Align to the end', f.a === 'end')
    + `<label style="display:flex;gap:3px;align-items:center;color:#94a3b8;font-size:11px;">size`
    + `<input data-t="size" type="number" min="5" max="40" step="1" value="${Number(f.s) || st.data.size || 15}" style="width:52px;height:22px;background:#0f172a;color:#e2e8f0;border:1px solid rgba(255,255,255,.12);border-radius:5px;"></label>`
    + `<input data-t="fg" type="color" value="${_esc(f.c || st.data.color || '#111111')}" title="Text colour" style="width:28px;height:22px;padding:0;border:1px solid rgba(255,255,255,.12);border-radius:5px;background:none;">`
    + `<input data-t="bg" type="color" value="${_esc(f.bg || '#ffffff')}" title="Cell colour" style="width:28px;height:22px;padding:0;border:1px solid rgba(255,255,255,.12);border-radius:5px;background:none;">`
    + b('clear', '⌫', 'Clear the look of the picked cells')
    + `</div>`
    + `<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-top:4px;">`
    + b('row-above', '＋ Row ▲', 'A row above') + b('row-below', '＋ Row ▼', 'A row below')
    + b('row-dup', '⧉ Row', 'Duplicate the row') + b('row-del', '🗑 Row', 'Delete the picked row(s)')
    + b('col-before', '＋ Col ◀', 'A column before') + b('col-after', '＋ Col ▶', 'A column after')
    + b('col-dup', '⧉ Col', 'Duplicate the column') + b('col-del', '🗑 Col', 'Delete the picked column(s)')
    + (canM ? b('merge', '⬓ Merge', 'Make the picked cells one') : '')
    + (canU ? b('unmerge', '⬚ Unmerge', 'Break the merged cell apart') : '')
    + b('even-cols', '↔ Even', 'Give every column the same width')
    + b('auto-rows', '↕ Auto', 'Let every row take the height its text needs')
    + b('head', 'Header', 'The first row is a heading', st.data.head !== false)
    + b('grid', 'Grid', 'Lines around every cell', st.data.grid !== false)
    + b('done', '✓ Done', 'Finish editing (Esc)')
    + `</div>`;
  _placeBar(st);     // its height just changed
}

/**
 * Copy the picked cells. Chromium fires no `copy` event without a DOM
 * selection, so this is driven from the key instead, through a throwaway
 * textarea — and the look of the cells is kept alongside, in the app's own
 * clipboard, because tab-separated text cannot carry it.
 */
function _copyCells(st, cut) {
  const s = _sel(st);
  if (!s) return;
  const rows = s.r1 - s.r0 + 1, cols = s.c1 - s.c0 + 1;
  const grid = [], fmt = {}, imgs = {};
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) {
      const rr = s.r0 + y, cc = s.c0 + x;
      row.push(st.data.cells?.[rr]?.[cc] ?? '');
      const f = st.data.fmt?.[`${rr},${cc}`];
      if (f) fmt[`${y},${x}`] = f;
      const p = st.data.imgs?.[`${rr},${cc}`];
      if (p) imgs[`${y},${x}`] = p;                 // the pictures travel too
    }
    grid.push(row);
  }
  const tsv = grid.map(r => r.join('\t')).join('\n');
  _clip = { rows, cols, tsv, fmt, imgs };
  const ta = document.createElement('textarea');
  ta.value = tsv;
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* the in-app clipboard still holds it */ }
  ta.remove();
  st.host.focus({ preventScroll: true });
  if (cut) {
    const cells = st.data.cells.map((row, y) => row.map((v, x) =>
      (y >= s.r0 && y <= s.r1 && x >= s.c0 && x <= s.c1 ? '' : v)));
    _apply(st, { cells }, 'Cut cells');
  }
  setStatus(`${rows}×${cols} cells ${cut ? 'cut' : 'copied'}.`, 'success', 3000);
}

function _act(st, a) {
  const s = _sel(st) || { r0: 0, c0: 0, r1: 0, c1: 0 };
  const d = st.data;
  const go = (patch, label) => { _apply(st, patch, label); };
  if (a === 'bold')   return go(tableSetFmt(d, s.r0, s.c0, s.r1, s.c1, { b: d.fmt?.[`${s.r0},${s.c0}`]?.b ? null : 1 }), 'Cell look');
  if (a === 'italic') return go(tableSetFmt(d, s.r0, s.c0, s.r1, s.c1, { i: d.fmt?.[`${s.r0},${s.c0}`]?.i ? null : 1 }), 'Cell look');
  if (a.startsWith('al-')) return go(tableSetFmt(d, s.r0, s.c0, s.r1, s.c1, { a: a.slice(3) }), 'Cell look');
  if (a === 'clear')  return go(tableSetFmt(d, s.r0, s.c0, s.r1, s.c1, { a: null, b: null, i: null, bg: null, c: null, s: null }), 'Clear the look');
  if (a === 'row-above') return go(tableInsertRow(d, s.r0), 'Add row');
  if (a === 'row-below') return go(tableInsertRow(d, s.r1 + 1), 'Add row');
  if (a === 'row-dup')   return go(tableInsertRow(d, s.r1 + 1, s.r0), 'Duplicate row');
  if (a === 'row-del')   return go(tableDeleteRows(d, s.r0, s.r1), 'Remove row');
  if (a === 'col-before') return go(tableInsertCol(d, s.c0), 'Add column');
  if (a === 'col-after')  return go(tableInsertCol(d, s.c1 + 1), 'Add column');
  if (a === 'col-dup')    return go(tableInsertCol(d, s.c1 + 1, s.c0), 'Duplicate column');
  if (a === 'col-del')    return go(tableDeleteCols(d, s.c0, s.c1), 'Remove column');
  if (a === 'merge')   return go(tableMerge(d, s.r0, s.c0, s.r1, s.c1), 'Merge cells');
  if (a === 'unmerge') { const m = mergeAt(d, s.r0, s.c0); return go(m && tableUnmerge(d, m.r, m.c, m.r + m.rs - 1, m.c + m.cs - 1), 'Unmerge cells'); }
  if (a === 'even-cols') return go({ widths: Array.from({ length: d.cols }, () => 1 / d.cols) }, 'Column width');
  if (a === 'auto-rows') return go({ rowH: [] }, 'Row height');
  if (a === 'head') return go({ head: d.head === false }, 'Heading row');
  if (a === 'grid') return go({ grid: d.grid === false }, 'Table lines');
  if (a === 'done') return closeOverlayTableEditor();
}

/** Type into one cell. */
function _editCell(st, td) {
  if (st.editing === td) return;
  const at = td.dataset?.cell;
  _commitOpenCell(st);
  // the commit may have redrawn: find the cell again by its address
  const live = at ? st.host.querySelector(`td[data-cell="${at}"]`) : td;
  if (!live) return;
  st.editing = live;
  live.setAttribute('contenteditable', 'plaintext-only');
  live.style.userSelect = 'text';
  live.focus();
  const rg = document.createRange(); rg.selectNodeContents(live);
  const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(rg);
}

// ─────────────────────────── open ───────────────────────────

/**
 * @param {object} ctx
 *   getData()             the table as it is NOW (the owner holds it)
 *   rect()                { left, top, width, height, scale, rot } on screen
 *   apply(patch, label)   write a change; returns the new table, or null
 *   onMenu(cell, x, y)    right-click on a cell
 *   onClose()             the panel is gone
 */
export function openOverlayTableEditor(ctx) {
  closeOverlayTableEditor();
  const data = ctx.getData?.();
  if (!data) return null;

  const host = document.createElement('div');
  host.dataset.sbsTableEditor = '1';
  // A PIXEL-EXACT TWIN of the rasteriser's wrapper (overlay.js _htmlToCanvas).
  // Anything missing here shows up as "the layout changed after I exited":
  // white-space alone moves every row that holds a line break.
  const size = Math.max(6, Number(data.size) || 15);
  host.style.cssText = [
    'position:fixed', 'z-index:60', 'transform-origin:0 0',
    'outline:2px dashed #f59e0b',
    'padding:0', 'margin:0', 'border:0',
    `color:${data.color || '#111111'}`,
    'background-color:transparent',
    'font-family:Arial', `font-size:${size}px`,
    'font-weight:normal', 'font-style:normal', 'text-decoration:none',
    'text-align:start', 'unicode-bidi:plaintext',
    'box-sizing:border-box', 'white-space:pre-wrap', 'word-wrap:break-word',
    'line-height:1.2', 'overflow:hidden',
  ].join(';');

  const chrome = document.createElement('div');
  chrome.style.cssText = 'position:fixed;z-index:62;transform-origin:0 0;pointer-events:none;';

  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;z-index:63;background:rgba(10,15,25,.95);border:1px solid #38bdf8;border-radius:9px;'
    + 'padding:5px 7px;box-shadow:0 8px 24px rgba(0,0,0,.5);color:#94a3b8;font:500 11.5px/1.2 system-ui,sans-serif;max-width:min(900px,94vw);';

  document.body.appendChild(host);
  document.body.appendChild(chrome);
  document.body.appendChild(bar);

  const st = {
    host, bar, chrome, ctx, data,
    sel: { r0: 0, c0: 0, r1: 0, c1: 0 },
    editing: null, drag: false, grip: null, coldrag: null, rowdrag: null,
    fmtTarget: null, geom: null, holdBar: false,
  };
  _open = st;

  st.place = () => { _place(st); _chrome(st); };
  window.addEventListener('resize', st.place);

  // ── picking cells ──
  host.addEventListener('pointerdown', (e) => {
    // A RIGHT-click fires pointerdown first. Collapsing the pick here is what
    // made "right-click three cells and delete both rows" impossible: by the
    // time the menu opened, only the cell under the pointer was picked.
    if (e.button !== 0) return;
    const td = e.target.closest?.('td[data-cell]');
    if (!td) return;
    if (st.editing === td) return;                       // typing: let the caret work
    e.preventDefault(); e.stopPropagation();
    st.host.focus({ preventScroll: true });              // keep the keys and the clipboard here
    _commitOpenCell(st);
    const [r, c] = String(td.dataset.cell).split(',').map(Number);
    st.sel = e.shiftKey && st.sel ? { ...st.sel, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c };
    st.drag = true;
    _paintSel(st);
  });
  host.addEventListener('pointermove', (e) => {
    if (!st.drag) return;
    const td = e.target.closest?.('td[data-cell]');
    if (!td) return;
    const [r, c] = String(td.dataset.cell).split(',').map(Number);
    if (r !== st.sel.r1 || c !== st.sel.c1) { st.sel = { ...st.sel, r1: r, c1: c }; _paintSel(st); }
  });
  host.addEventListener('dblclick', (e) => {
    const td = e.target.closest?.('td[data-cell]');
    if (td) { e.preventDefault(); e.stopPropagation(); _editCell(st, td); }
  });
  // ── drop a picture file straight onto a cell ──
  host.addEventListener('dragover', (e) => {
    if (!st.ctx.picture) return;
    if (![...(e.dataTransfer?.items || [])].some(i => i.kind === 'file')) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    const td = e.target.closest?.('td[data-cell]');
    for (const cell of _cells(st)) cell.style.boxShadow = cell === td ? 'inset 0 0 0 3px #f59e0b' : '';
  });
  host.addEventListener('dragleave', () => {
    for (const cell of _cells(st)) cell.style.boxShadow = '';
  });
  host.addEventListener('drop', (e) => {
    if (!st.ctx.picture) return;
    const td = e.target.closest?.('td[data-cell]');
    const file = [...(e.dataTransfer?.files || [])].find(f => /^image\//.test(f.type));
    for (const cell of _cells(st)) cell.style.boxShadow = '';
    if (!td || !file) return;
    e.preventDefault(); e.stopPropagation();
    _commitOpenCell(st);
    const [r, c] = String(td.dataset.cell).split(',').map(Number);
    st.ctx.picture(r, c, file);
  });

  host.addEventListener('contextmenu', (e) => {
    const td = e.target.closest?.('td[data-cell]');
    if (!td || !st.ctx.onMenu) return;
    e.preventDefault(); e.stopPropagation();
    const [r, c] = String(td.dataset.cell).split(',').map(Number);
    _commitOpenCell(st);                 // never lose what is being typed
    // Right-clicking INSIDE the picked block keeps the block — that is what
    // "merge these" and "delete these rows" have to mean. Outside it, the
    // right-click picks a cell.
    const s = _sel(st);
    if (!(s && r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1)) {
      st.sel = { r0: r, c0: c, r1: r, c1: c };
      _paintSel(st);
    }
    // the menu is built from the BLOCK, not just the cell under the pointer
    st.ctx.onMenu({ r, c, sel: _sel(st) }, e.clientX, e.clientY);
  });

  // ── the grips: pick a line, move a line, resize a line ──
  chrome.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest?.('i[data-colg],i[data-rowg],i[data-colh],i[data-rowh]');
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    _commitOpenCell(st);
    const d = el.dataset;
    const sc = _rect(st).scale || 1;
    if (d.colg != null) {
      const i = Number(d.colg);
      st.sel = { r0: 0, c0: i, r1: Math.max(0, st.data.rows - 1), c1: i };
      _paintSel(st);
      st.grip = tableColMovable(st.data, i) ? { kind: 'col', i, to: i, moved: false } : null;
      if (!st.grip) setStatus('This column runs through a merged cell — unmerge it first.', 'warn', 5000);
    } else if (d.rowg != null) {
      const i = Number(d.rowg);
      st.sel = { r0: i, c0: 0, r1: i, c1: Math.max(0, st.data.cols - 1) };
      _paintSel(st);
      st.grip = tableRowMovable(st.data, i) ? { kind: 'row', i, to: i, moved: false } : null;
      if (!st.grip) setStatus('This row runs through a merged cell — unmerge it first.', 'warn', 5000);
    } else if (d.colh != null) {
      const i = Number(d.colh);
      const w = Array.from({ length: st.data.cols }, (_, k) => {
        const v = Number(st.data.widths?.[k]);
        return v > 0 ? v : 1 / Math.max(1, st.data.cols);
      });
      st.coldrag = { i, x: e.clientX, sc, w, next: null, moved: false, boxW: st.geom?.W || 1 };
    } else if (d.rowh != null) {
      const i = Number(d.rowh);
      st.rowdrag = { i, y: e.clientY, sc, h0: st.geom?.rows?.[i]?.h || MIN_ROW_PX, h: 0, moved: false };
    }
  });

  st.move = (e) => {
    if (st.grip) {
      const g = st.geom;
      if (!g) return;
      const H = st.host.getBoundingClientRect();
      const sc = _rect(st).scale || 1;
      if (st.grip.kind === 'row') {
        const y = (e.clientY - H.top) / sc;
        let to = g.rows.length;
        for (let i = 0; i < g.rows.length; i++) {
          if (y < g.rows[i].top + g.rows[i].h / 2) { to = i; break; }
        }
        st.grip.to = to;
      } else {
        const x = (e.clientX - H.left) / sc;
        let to = g.cols.length, run = 0;
        for (let i = 0; i < g.cols.length; i++) {
          if (x < run + g.cols[i] / 2) { to = i; break; }
          run += g.cols[i];
        }
        st.grip.to = to;
      }
      st.grip.moved = true;
      _dropLine(st, st.grip.kind, st.grip.to);
      return;
    }
    if (st.coldrag) {
      const cd = st.coldrag;
      const i = cd.i;
      const f = ((e.clientX - cd.x) / (cd.sc || 1)) / Math.max(1, cd.boxW);
      if (!cd.moved && Math.abs(f) < 0.002) return;
      cd.moved = true;
      const w = cd.w.slice();
      const room = w[i] + w[i + 1];
      const a = Math.max(MIN_COL, Math.min(room - MIN_COL, w[i] + f));
      w[i] = a; w[i + 1] = room - a;
      cd.next = w;
      // live preview: write the <col> widths straight into the DOM
      const sum = w.reduce((p, q) => p + q, 0) || 1;
      st.host.querySelectorAll('col').forEach((c, k) => {
        c.style.width = `${((w[k] / sum) * 100).toFixed(3)}%`;
      });
      _chrome(st);
      return;
    }
    if (st.rowdrag) {
      const rd = st.rowdrag;
      const dy = (e.clientY - rd.y) / (rd.sc || 1);
      if (!rd.moved && Math.abs(dy) < 1.5) return;
      rd.moved = true;
      rd.h = Math.max(MIN_ROW_PX, Math.round(rd.h0 + dy));
      const tr = st.host.querySelectorAll('tr')[rd.i];
      if (tr) tr.style.height = `${rd.h}px`;
      _chrome(st);
    }
  };

  st.up = () => {
    if (st.grip) {
      const g = st.grip; st.grip = null;
      _dropLine(st, g.kind, null);
      if (g.moved && g.to !== g.i && g.to !== g.i + 1) {
        const patch = g.kind === 'row' ? tableMoveRow(st.data, g.i, g.to) : tableMoveCol(st.data, g.i, g.to);
        if (_apply(st, patch, g.kind === 'row' ? 'Move row' : 'Move column')) {
          const dest = g.to > g.i ? g.to - 1 : g.to;      // the pick travels with the line
          st.sel = g.kind === 'row'
            ? { r0: dest, c0: 0, r1: dest, c1: Math.max(0, st.data.cols - 1) }
            : { r0: 0, c0: dest, r1: Math.max(0, st.data.rows - 1), c1: dest };
          _paintSel(st);
        }
      }
      return;
    }
    if (st.coldrag) {
      const cd = st.coldrag; st.coldrag = null;
      if (cd.moved && cd.next) _apply(st, { widths: cd.next }, 'Column width');
      return;
    }
    if (st.rowdrag) {
      const rd = st.rowdrag; st.rowdrag = null;
      if (rd.moved) {
        const rowH = Array.from({ length: st.data.rows }, (_, k) => Number(st.data.rowH?.[k]) || 0);
        rowH[rd.i] = rd.h;
        _apply(st, { rowH }, 'Row height');
      }
      return;
    }
    st.drag = false;
  };
  window.addEventListener('pointermove', st.move, true);
  window.addEventListener('pointerup', st.up, true);

  // ── keys. Ctrl+Z / Ctrl+Y are taken over: while a table is open they undo
  //    the TABLE, never the animation behind it. Without this, a Ctrl+Z after
  //    clicking a bar button reached the app's stack and could delete the very
  //    table being edited. ──
  st.keys = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.code === 'KeyZ' || e.code === 'KeyY')) {
      e.preventDefault(); e.stopPropagation();
      const redo = e.code === 'KeyY' || e.shiftKey;
      _commitOpenCell(st);                      // the cell in flight becomes its own entry first
      const scope = redo ? undoManager.redoScope() : undoManager.undoScope();
      if (scope !== TABLE_UNDO_SCOPE) {
        setStatus(redo ? 'Nothing to redo in this table.' : 'Nothing more to undo in this table — finish (Esc) to undo the rest.', 'info', 5000);
        return;
      }
      if (redo) undoManager.redo(); else undoManager.undo();
      return;                                   // the owner calls refreshOverlayTableEditor()
    }
    if (mod && (e.code === 'KeyC' || e.code === 'KeyX') && !st.editing) {
      e.preventDefault(); e.stopPropagation();
      _copyCells(st, e.code === 'KeyX');
      return;
    }
    if (!(st.host.contains(e.target) || st.bar.contains(e.target) || st.chrome.contains(e.target))) return;
    // Typing in the bar's own fields (the size) is ordinary typing: Enter,
    // the arrows and Delete belong to that field, not to the table. Without
    // this, Enter jumped into a cell and Delete emptied the picked cells while
    // the user was setting a font size.
    const tag = e.target?.tagName;
    if (st.bar.contains(e.target) && (tag === 'INPUT' || tag === 'TEXTAREA')) return;
    e.stopPropagation();                        // the app's shortcuts stay out of the table
    if (e.key === 'Escape') { e.preventDefault(); closeOverlayTableEditor(); return; }
    const s = _sel(st);
    if (e.key === 'Tab' && s) {
      e.preventDefault();
      _commitOpenCell(st);
      const c = e.shiftKey ? s.c0 - 1 : s.c0 + 1;
      const nc = Math.max(0, Math.min(st.data.cols - 1, c));
      st.sel = { r0: s.r0, c0: nc, r1: s.r0, c1: nc };
      _paintSel(st);
      const td = host.querySelector(`td[data-cell="${s.r0},${nc}"]`);
      if (td) _editCell(st, td);
      return;
    }
    if (!st.editing && s && (e.key === 'Enter' || e.key === 'F2')) {
      e.preventDefault();
      const td = host.querySelector(`td[data-cell="${s.r0},${s.c0}"]`);
      if (td) _editCell(st, td);
      return;
    }
    if (!st.editing && s && /^Arrow/.test(e.key)) {
      e.preventDefault();
      const dr = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      const dc = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      const r = Math.max(0, Math.min(st.data.rows - 1, s.r0 + dr));
      const c = Math.max(0, Math.min(st.data.cols - 1, s.c0 + dc));
      st.sel = e.shiftKey ? { ...st.sel, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c };
      _paintSel(st);
      return;
    }
    if (!st.editing && s && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      const cells = st.data.cells.map((row, y) => row.map((v, x) =>
        (y >= s.r0 && y <= s.r1 && x >= s.c0 && x <= s.c1 ? '' : v)));
      _apply(st, { cells }, 'Clear cells');
    }
  };
  window.addEventListener('keydown', st.keys, true);

  // ── paste. On the DOCUMENT, in capture: the panel is not always what holds
  //    the focus (a bar button does after you click one), and a paste that
  //    lands anywhere else was simply lost. ──
  st.paste = (e) => {
    if (!_open) return;
    const s = _sel(st);
    if (!s) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    // A PICTURE only wins when there is no grid to read: a spreadsheet puts
    // BOTH the cells as text AND a picture of them on the clipboard, and the
    // cells are what the user meant.
    if (!/[\t\n]/.test(text) && st.ctx.picture) {
      const item = [...(e.clipboardData?.items || [])].find(i => i.type?.startsWith('image/'));
      const file = item?.getAsFile?.();
      if (file) {
        e.preventDefault(); e.stopPropagation();
        _commitOpenCell(st);
        const at = _sel(st) || s;
        st.ctx.picture(at.r0, at.c0, file);
        return;
      }
    }
    if (!text) return;
    // A single value while a cell is open belongs to the caret; anything with
    // a tab or a newline is a block of cells, whatever is focused.
    if (st.editing && !/[\t\n]/.test(text)) return;
    e.preventDefault(); e.stopPropagation();
    _commitOpenCell(st);
    const at = _sel(st) || s;
    // Cells copied inside the app carry their look; the system clipboard only
    // carries the text, so it is the app's copy when the text still matches.
    const rich = _clip && _clip.tsv === text ? _clip : null;
    const patch = rich ? tablePasteRich(st.data, at.r0, at.c0, rich)
                       : tablePaste(st.data, at.r0, at.c0, text);
    if (_apply(st, patch, 'Paste into the table')) {
      setStatus('Pasted into the table.', 'success', 3000);
    }
  };
  document.addEventListener('paste', st.paste, true);

  // ── the bar ──
  // A colour picker reports `change` only when it CLOSES — by then the user has
  // usually clicked a cell, moving the pick. So the cells a swatch was opened
  // FOR are snapshotted on the way down, and the commit uses that.
  bar.addEventListener('pointerdown', (e) => {
    // capture, and NOT stopped here — the swatch and the size field still need
    // this event to focus and to open.
    //
    // WHAT IS BEING TYPED IS SAVED FIRST. Reaching for the bar mid-word used
    // to throw the word away: the change was written onto the table as the
    // NODE still held it, which was the text from before the cell was opened,
    // and the redraw then put that back. Commit the open cell here, and hold
    // the bar together for this gesture so the button under the finger is not
    // replaced by the rebuild.
    if (!e.target?.closest?.('[data-t]')) return;
    st.holdBar = true;
    _commitOpenCell(st);
    setTimeout(() => { st.holdBar = false; }, 0);
    if (e.target.closest('[data-t="fg"],[data-t="bg"],[data-t="size"]')) st.fmtTarget = _sel(st);
  }, true);
  bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-t]');
    if (!btn || btn.tagName === 'INPUT') return;
    e.preventDefault(); e.stopPropagation();
    _act(st, btn.dataset.t);
  });
  // live while the picker is open: paint the cells at once, commit on close
  bar.addEventListener('input', (e) => {
    const inp = e.target.closest?.('[data-t="fg"],[data-t="bg"]');
    const s = st.fmtTarget;
    if (!inp || !s) return;
    for (const td of _cells(st)) {
      const [r, c] = String(td.dataset.cell).split(',').map(Number);
      if (r < s.r0 || r > s.r1 || c < s.c0 || c > s.c1) continue;
      if (inp.dataset.t === 'bg') td.style.background = inp.value; else td.style.color = inp.value;
    }
  });
  bar.addEventListener('change', (e) => {
    const inp = e.target.closest?.('[data-t]');
    if (!inp) return;
    const s = st.fmtTarget || _sel(st) || { r0: 0, c0: 0, r1: 0, c1: 0 };
    st.fmtTarget = null;
    const key = inp.dataset.t;
    const patch = key === 'size' ? { s: Math.max(5, Math.min(40, Number(inp.value) || st.data.size)) }
      : key === 'fg' ? { c: String(inp.value).toLowerCase() }
      : key === 'bg' ? { bg: String(inp.value).toLowerCase() } : null;
    if (patch) _apply(st, tableSetFmt(st.data, s.r0, s.c0, s.r1, s.c1, patch), 'Cell look');
  });

  st.away = (e) => {
    if (host.contains(e.target) || bar.contains(e.target) || chrome.contains(e.target)) return;
    // the table's own right-click menu floats outside the panel — clicking a
    // command in it must not be read as "the user has left the table"
    if (e.target?.closest?.('.context-menu')) return;
    closeOverlayTableEditor();
  };
  setTimeout(() => document.addEventListener('pointerdown', st.away, true), 0);

  _draw(st);
  host.tabIndex = -1;
  host.focus({ preventScroll: true });
  return st;
}
