/**
 * SBS — editing a table on the ANIMATION overlay (V0.3.4.46).
 *
 * The table on the canvas is a picture of HTML. To edit it, the real HTML is
 * mounted over the canvas at the same place and size — so what you see is what
 * will be drawn — and this module owns everything that happens there:
 * picking cells, typing in one, the two-row bar (the look of the cells, and
 * the shape of the table), and pasting a block out of a spreadsheet.
 *
 * It knows nothing about Konva. It is handed the data and a place to put it
 * back; the overlay turns that into a redraw and an undo entry.
 */

import { tableOverlayHtml } from '../systems/table-html.js';
import {
  tableInsertRow, tableDeleteRows, tableInsertCol, tableDeleteCols,
  tableMerge, tableUnmerge, canMerge, mergeAt, tableSetFmt, tablePaste,
} from '../systems/document-core.js';
import { setStatus } from './status.js';

const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let _open = null;   // { host, bar, data, sel, ctx, editing }

export function isOverlayTableEditorOpen() { return !!_open; }

/** Close it, committing whatever is in the open cell. */
export function closeOverlayTableEditor(abandon = false) {
  const st = _open; _open = null;
  if (!st) return;
  document.removeEventListener('pointerdown', st.away, true);
  window.removeEventListener('resize', st.place);
  if (!abandon) _commitOpenCell(st);
  st.host.remove();
  st.bar.remove();
  st.ctx.onClose?.(st.data);
}

function _rect(st) { return { ...st.ctx.rect() }; }

function _place(st) {
  const r = _rect(st);
  st.host.style.left = `${Math.round(r.left)}px`;
  st.host.style.top = `${Math.round(r.top)}px`;
  st.host.style.width = `${Math.round(r.width)}px`;
  st.host.style.transform = `scale(${r.scale})`;
  st.bar.style.left = `${Math.round(r.left)}px`;
  st.bar.style.top = `${Math.max(6, Math.round(r.top - st.bar.offsetHeight - 8))}px`;
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

function _paintSel(st) {
  const s = _sel(st);
  for (const td of st.host.querySelectorAll('td')) {
    const [r, c] = String(td.dataset.cell || '').split(',').map(Number);
    const on = s && r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1;
    td.style.outline = on ? '2px solid #2563eb' : '';
    td.style.outlineOffset = on ? '-2px' : '';
  }
  _bar(st);
}

/** Read the open cell back into the data (no redraw, no commit). */
function _commitOpenCell(st) {
  const td = st.editing;
  if (!td) return false;
  st.editing = null;
  td.removeAttribute('contenteditable');
  const [r, c] = String(td.dataset.cell || '').split(',').map(Number);
  const text = String(td.innerText ?? '').replace(/ /g, ' ').replace(/\n+$/, '');
  if (!(r >= 0 && c >= 0)) return false;
  if (text === (st.data.cells[r]?.[c] ?? '')) return false;
  const cells = st.data.cells.map((row, y) => row.map((v, x) => (y === r && x === c ? text : v)));
  _apply(st, { cells }, 'Edit table');
  return true;
}

/** Change the data, redraw the editor, and tell the owner. */
function _apply(st, patch, label) {
  st.data = { ...st.data, ...patch };
  st.ctx.onCommit?.(st.data, label);
  _draw(st);
}

function _draw(st) {
  const r = _rect(st);
  // the same height the picture is drawn at, so the editor IS what you will get
  st.host.innerHTML = tableOverlayHtml(st.data, {
    width: Math.round(r.width),
    ...(Number(r.height) > 0 ? { height: Math.round(r.height) } : {}),
  });
  for (const td of st.host.querySelectorAll('td')) {
    td.style.cursor = 'cell';
    td.style.userSelect = 'none';
  }
  _paintSel(st);
  _place(st);
}

/** The two-row bar: the look of the picked cells, and the shape of the table. */
function _bar(st) {
  const s = _sel(st);
  const one = s && s.r0 === s.r1 && s.c0 === s.c1;
  const f = s ? (st.data.fmt?.[`${s.r0},${s.c0}`] || {}) : {};
  const b = (act, label, title, on) =>
    `<button data-t="${act}" title="${_esc(title)}" style="height:22px;padding:0 7px;font-size:11.5px;border-radius:5px;cursor:pointer;`
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
    + `<input data-t="size" type="number" min="6" max="80" step="1" value="${Number(f.s) || st.data.size || 15}" style="width:52px;height:22px;background:#0f172a;color:#e2e8f0;border:1px solid rgba(255,255,255,.12);border-radius:5px;"></label>`
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
    + b('head', 'Header', 'The first row is a heading', st.data.head !== false)
    + b('grid', 'Grid', 'Lines around every cell', st.data.grid !== false)
    + b('done', '✓ Done', 'Finish editing (Esc)')
    + `</div>`;
}

function _act(st, act, el) {
  const s = _sel(st) || { r0: 0, c0: 0, r1: 0, c1: 0 };
  const d = st.data;
  const go = (patch, label) => { if (patch) _apply(st, patch, label); };
  if (act === 'bold')   return go(tableSetFmt(d, s.r0, s.c0, s.r1, s.c1, { b: d.fmt?.[`${s.r0},${s.c0}`]?.b ? null : 1 }), 'Cell look');
  if (act === 'italic') return go(tableSetFmt(d, s.r0, s.c0, s.r1, s.c1, { i: d.fmt?.[`${s.r0},${s.c0}`]?.i ? null : 1 }), 'Cell look');
  if (act.startsWith('al-')) return go(tableSetFmt(d, s.r0, s.c0, s.r1, s.c1, { a: act.slice(3) }), 'Cell look');
  if (act === 'clear')  return go(tableSetFmt(d, s.r0, s.c0, s.r1, s.c1, { a: null, b: null, i: null, bg: null, c: null, s: null }), 'Clear the look');
  if (act === 'row-above') return go(tableInsertRow(d, s.r0), 'Add row');
  if (act === 'row-below') return go(tableInsertRow(d, s.r1 + 1), 'Add row');
  if (act === 'row-dup')   return go(tableInsertRow(d, s.r1 + 1, s.r0), 'Duplicate row');
  if (act === 'row-del')   return go(tableDeleteRows(d, s.r0, s.r1), 'Remove row');
  if (act === 'col-before') return go(tableInsertCol(d, s.c0), 'Add column');
  if (act === 'col-after')  return go(tableInsertCol(d, s.c1 + 1), 'Add column');
  if (act === 'col-dup')    return go(tableInsertCol(d, s.c1 + 1, s.c0), 'Duplicate column');
  if (act === 'col-del')    return go(tableDeleteCols(d, s.c0, s.c1), 'Remove column');
  if (act === 'merge')   return go(tableMerge(d, s.r0, s.c0, s.r1, s.c1), 'Merge cells');
  if (act === 'unmerge') { const m = mergeAt(d, s.r0, s.c0); return go(m && tableUnmerge(d, m.r, m.c, m.r + m.rs - 1, m.c + m.cs - 1), 'Unmerge cells'); }
  if (act === 'head') return go({ head: d.head === false }, 'Heading row');
  if (act === 'grid') return go({ grid: d.grid === false }, 'Table lines');
  if (act === 'done') return closeOverlayTableEditor();
  void el;
}

/** Type into one cell. */
function _editCell(st, td) {
  if (st.editing === td) return;
  _commitOpenCell(st);
  st.editing = td;
  td.setAttribute('contenteditable', 'plaintext-only');
  td.style.userSelect = 'text';
  td.focus();
  const rg = document.createRange(); rg.selectNodeContents(td);
  const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(rg);
}

/**
 * Open the editor.
 * @param {object} ctx { data, rect(), onCommit(data,label), onClose(data) }
 */
export function openOverlayTableEditor(ctx) {
  closeOverlayTableEditor();
  const host = document.createElement('div');
  host.dataset.sbsTableEditor = '1';
  host.style.cssText = 'position:fixed;z-index:60;transform-origin:0 0;outline:2px dashed #f59e0b;font-family:Arial;';
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;z-index:61;background:rgba(10,15,25,.95);border:1px solid #38bdf8;border-radius:9px;'
    + 'padding:5px 7px;box-shadow:0 8px 24px rgba(0,0,0,.5);color:#94a3b8;font:500 11.5px/1.2 system-ui,sans-serif;max-width:min(900px,94vw);';
  document.body.appendChild(host);
  document.body.appendChild(bar);

  const st = { host, bar, data: JSON.parse(JSON.stringify(ctx.data)), sel: { r0: 0, c0: 0, r1: 0, c1: 0 }, ctx, editing: null, drag: false };
  _open = st;
  st.place = () => _place(st);
  window.addEventListener('resize', st.place);

  // picking cells
  host.addEventListener('pointerdown', (e) => {
    const td = e.target.closest?.('td[data-cell]');
    if (!td) return;
    if (st.editing === td) return;                       // typing: let the caret work
    e.preventDefault(); e.stopPropagation();
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
  const endDrag = () => { st.drag = false; };
  host.addEventListener('pointerup', endDrag);
  window.addEventListener('pointerup', endDrag, { once: false });
  host.addEventListener('contextmenu', (e) => {
    const td = e.target.closest?.('td[data-cell]');
    if (!td || !st.ctx.onMenu) return;
    e.preventDefault(); e.stopPropagation();
    const [r, c] = String(td.dataset.cell).split(',').map(Number);
    // right-clicking INSIDE the picked block keeps the block — that is what
    // "delete these rows" has to mean. Outside it, the right-click picks a cell.
    const s = _sel(st);
    if (!(s && r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1)) {
      st.sel = { r0: r, c0: c, r1: r, c1: c };
      _paintSel(st);
    }
    st.ctx.onMenu({ r, c }, e.clientX, e.clientY);
  });
  host.addEventListener('dblclick', (e) => {
    const td = e.target.closest?.('td[data-cell]');
    if (td) { e.preventDefault(); e.stopPropagation(); _editCell(st, td); }
  });

  // keys
  host.addEventListener('keydown', (e) => {
    e.stopPropagation();                                  // the app's shortcuts stay out
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
  });

  // paste: a block out of a spreadsheet fills the cells and grows the table
  host.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    const s = _sel(st);
    if (!s || !/[\t\n]/.test(text)) return;               // one value: let the caret take it
    e.preventDefault(); e.stopPropagation();
    _commitOpenCell(st);
    const patch = tablePaste(st.data, s.r0, s.c0, text);
    if (patch) { _apply(st, patch, 'Paste into the table'); setStatus('Pasted into the table.', 'success', 3000); }
  });

  bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-t]');
    if (!btn || btn.tagName === 'INPUT') return;
    e.preventDefault(); e.stopPropagation();
    _act(st, btn.dataset.t, btn);
  });
  bar.addEventListener('change', (e) => {
    const inp = e.target.closest?.('[data-t]');
    if (!inp) return;
    const s = _sel(st) || { r0: 0, c0: 0, r1: 0, c1: 0 };
    const key = inp.dataset.t;
    const patch = key === 'size' ? { s: Math.max(6, Math.min(80, Number(inp.value) || st.data.size)) }
      : key === 'fg' ? { c: String(inp.value).toLowerCase() }
      : key === 'bg' ? { bg: String(inp.value).toLowerCase() } : null;
    if (patch) _apply(st, tableSetFmt(st.data, s.r0, s.c0, s.r1, s.c1, patch), 'Cell look');
  });

  st.away = (e) => {
    if (host.contains(e.target) || bar.contains(e.target)) return;
    // the table's own right-click menu floats outside the host — clicking a
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
