/**
 * 📊 Steps from Excel — the viewer (V0.3.5.53)
 *
 * "My client makes ANY spreadsheet — no template. I open it, say which column
 * is the step name, which is the voice-over, which are titles, and get one
 * step per row to start working from."
 *
 * Pick a file → read it (io/sheet-read.js) → a viewer: sheet tabs, a
 * "first row is column names" switch, the first rows of the sheet with a role
 * picker above every column, a look picker per Title column, and a live
 * summary. Import hands the already-filtered rows to systems/sheet-import.js,
 * which makes the steps as ONE undo entry.
 *
 * The planning (roles → rows) is pure and exported so a node test can drive
 * it; the reader and the importer load on demand, so this module carries no
 * app state of its own.
 */

import { setStatus }         from './status.js';
import { chooseFromButtons } from './prompt.js';

const PREVIEW_ROWS = 300;   // the table is a preview — the import uses every row

export const ROLE_LABELS = { ignore: 'Ignore', name: 'Step name', voice: 'Voiceover', title: 'Title' };

// The roles a sheet can only have ONE of — a step has one name, one voice-over.
const _SINGLE = new Set(['name', 'voice']);

// Default spots for the 1st, 2nd, … Title column, so two titles never land on
// top of each other before the user has touched anything.
const _POS_ORDER = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-center', 'bottom-center', 'center'];

const _ROLE_TINT = {
  name:  'rgba(56,189,248,0.14)',
  voice: 'rgba(34,197,94,0.14)',
  title: 'rgba(245,158,11,0.16)',
};

/** Fallback when io/sheet-read.js is not loaded (node tests): A … Z, AA … */
function _letterLocal(i) {
  let s = '', n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
let _letter = _letterLocal;

/**
 * Give column `col` the role `role`. Step name / Voiceover are single: picking
 * a second one MOVES the role (the old column drops back to Ignore) rather
 * than refusing — the user's latest click is the intent.
 */
export function assignRole(roles, col, role) {
  const next = roles.slice();
  if (_SINGLE.has(role)) for (let i = 0; i < next.length; i++) if (next[i] === role) next[i] = 'ignore';
  next[col] = ROLE_LABELS[role] ? role : 'ignore';
  return next;
}

/** Column names from the first row when it is a header row; '' otherwise. */
export function columnNames(rows, headerRow, width) {
  const head = headerRow && rows.length ? rows[0] : [];
  return Array.from({ length: width }, (_, i) => String(head[i] ?? '').trim());
}

/** The default look for the n-th Title column: a fresh unified look, spread out. */
export function defaultLook(n, positions) {
  const keys = (positions || []).map(p => p.key);
  const order = _POS_ORDER.filter(k => keys.includes(k));
  const pool = order.length ? order : (keys.length ? keys : _POS_ORDER);
  return { kind: 'new', styleId: null, position: pool[n % pool.length] };
}

/**
 * Roles + looks → exactly what importStepsFromSheet takes, plus the counts the
 * summary line shows. A row whose MAPPED cells are all empty is skipped (a
 * client's sheet is full of spacer rows); an empty / missing name becomes
 * "Step N", N = its place among the imported rows.
 *
 * @param {string[][]} rows    the whole sheet
 * @param {{ headerRow:boolean, roles:string[], looks:object[] }} opts
 */
export function buildPlan(rows, { headerRow, roles, looks }) {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const names = columnNames(rows, headerRow, width);
  const data = headerRow ? rows.slice(1) : rows;
  const nameCol = roles.indexOf('name');
  const voiceCol = roles.indexOf('voice');
  const titleCols = [];
  roles.forEach((r, i) => { if (r === 'title') titleCols.push(i); });
  const mapped = [nameCol, voiceCol, ...titleCols].filter(i => i >= 0);

  const cell = (row, i) => String(row[i] ?? '').trim();
  const out = [];
  let skipped = 0;
  for (const row of data) {
    if (!mapped.length || mapped.every(i => cell(row, i) === '')) { skipped++; continue; }
    const nm = nameCol >= 0 ? cell(row, nameCol) : '';
    out.push({
      name:   nm || `Step ${out.length + 1}`,
      voice:  voiceCol >= 0 ? cell(row, voiceCol) : '',
      titles: titleCols.map(i => cell(row, i)),
    });
  }
  const titleColumns = titleCols.map((i, n) => ({
    label: names[i] || `Column ${_letter(i)}`,
    look:  looks?.[i] || defaultLook(n),
  }));
  return { rows: out, titleColumns, skipped, nameCol, voiceCol, titleCols, dataCount: data.length, width, names };
}

/** The one-line summary under the table. */
export function summaryText(plan) {
  if (plan.nameCol < 0 && plan.voiceCol < 0 && !plan.titleCols.length) {
    return 'Choose a role above at least one column — Step name, Voiceover or Title.';
  }
  const n = plan.rows.length;
  const bits = [n === 1 ? '1 step will be created' : `${n} steps will be created`];
  bits.push(plan.nameCol >= 0 ? `names from ${_letter(plan.nameCol)}` : 'named Step 1, Step 2, …');
  if (plan.voiceCol >= 0) bits.push(`voiceover from ${_letter(plan.voiceCol)}`);
  const t = plan.titleCols.length;
  if (t) bits.push(t === 1 ? '1 title' : `${t} titles`);
  if (plan.skipped) bits.push(plan.skipped === 1 ? '1 empty row skipped' : `${plan.skipped} empty rows skipped`);
  return bits.join(' · ');
}

// ─── entry point ─────────────────────────────────────────────────────────────

/** Files tab → "📊 Steps from Excel…". */
export async function openSheetImport() {
  const picked = await _pickFile();
  if (!picked) return;

  let reader, importer, book;
  try {
    reader = await import('../io/sheet-read.js');
    importer = await import('../systems/sheet-import.js');
  } catch (err) {
    console.error('[sheet-import] module load failed', err);
    setStatus('Steps from Excel is not available in this build.', 'danger');
    return;
  }
  if (typeof reader.columnLetter === 'function') _letter = reader.columnLetter;

  try {
    book = await reader.readSheetFile(picked.name, picked.bytes);
  } catch (err) {
    console.warn('[sheet-import] read failed', err);
    await _tell(`Could not read "${picked.name}".`, err?.message || 'The file could not be opened as a spreadsheet.');
    return;
  }
  const sheets = (book?.sheets || []).filter(s => s && Array.isArray(s.rows));
  if (!sheets.length || sheets.every(s => !s.rows.length)) {
    await _tell(`"${picked.name}" is empty.`, 'There are no rows in this file to make steps from.');
    return;
  }

  let choices = { styles: [], brandTitles: [], positions: [] };
  try { choices = importer.sheetTitleChoices() || choices; }
  catch (err) { console.warn('[sheet-import] title choices failed', err); }

  await _showViewer(picked.name, sheets, choices, importer);
}

// ─── file pick ───────────────────────────────────────────────────────────────

const _FILTERS = [
  { name: 'Spreadsheet', extensions: ['xlsx', 'xlsm', 'csv', 'tsv', 'txt', 'xls'] },
  { name: 'Excel',       extensions: ['xlsx', 'xlsm', 'xls'] },
  { name: 'Text table',  extensions: ['csv', 'tsv', 'txt'] },
];

async function _pickFile() {
  if (window.sbsNative?.openFile && window.sbsNative?.readFile) {
    const path = await window.sbsNative.openFile({ title: 'Steps from Excel — pick a spreadsheet', filters: _FILTERS });
    if (!path) return null;
    const name = path.split(/[\\/]/).pop();
    const r = await window.sbsNative.readFile(path, 'buffer');
    if (!r?.ok) { setStatus(`Could not open ${name}: ${r?.error || 'unknown error'}`, 'danger'); return null; }
    // IPC hands a Buffer/Uint8Array; normalise so the reader sees one type
    const d = r.data;
    const bytes = d instanceof Uint8Array ? d : new Uint8Array(d?.buffer ? d.buffer : d);
    return { name, bytes };
  }
  // Browser fallback
  const f = await new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xlsm,.xls,.csv,.tsv,.txt';
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
  if (!f) return null;
  return { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
}

function _tell(title, message) {
  return chooseFromButtons(`📊 ${title}`, message, [{ id: 'ok', label: 'OK', primary: true }]);
}

// ─── the viewer ──────────────────────────────────────────────────────────────

function _showViewer(fileName, sheets, choices, importer) {
  return new Promise((resolve) => {
    const styles = choices.styles || [];
    const brandTitles = choices.brandTitles || [];
    const positions = (choices.positions && choices.positions.length)
      ? choices.positions
      : _POS_ORDER.map(k => ({ key: k, label: k }));

    // per-sheet choices survive flipping between tabs
    const per = sheets.map(s => {
      const width = s.rows.reduce((m, r) => Math.max(m, r.length), 0);
      return { headerRow: true, roles: Array(width).fill('ignore'), looks: [] };
    });
    // first non-empty sheet
    let cur = Math.max(0, sheets.findIndex(s => s.rows.length));
    let busy = false;

    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    dlg.style.cssText = 'width:min(1120px,96vw);max-width:96vw;';
    dlg.innerHTML = `
      <div class="sbs-dialog__body" style="display:flex;flex-direction:column;gap:10px;">
        <div>
          <div class="sbs-dialog__title">📊 Steps from Excel</div>
          <div class="small muted" style="word-break:break-all;">${_esc(fileName)} — mark the columns, then Import. One step per row, added to this project; Ctrl+Z takes the whole import back.</div>
        </div>
        <div id="sxi-tabs" style="display:flex;gap:6px;flex-wrap:wrap;"></div>
        <label style="display:flex;align-items:center;gap:6px;width:fit-content;cursor:pointer;">
          <input type="checkbox" id="sxi-header" />
          <span>First row is column names</span>
        </label>
        <div id="sxi-wrap" style="overflow:auto;max-height:46vh;border:1px solid var(--line);border-radius:8px;"></div>
        <div id="sxi-more" class="small muted"></div>
        <div id="sxi-titles" style="display:flex;flex-direction:column;gap:6px;"></div>
        <div id="sxi-summary" style="font-size:13px;"></div>
        <div id="sxi-error" class="small" style="color:#f87171;display:none;"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
          <button class="btn" id="sxi-cancel">Cancel</button>
          <button class="btn" id="sxi-ok" style="color:#22d3ee;font-weight:600;">Import</button>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);

    const $ = (sel) => dlg.querySelector(sel);
    const tabsEl = $('#sxi-tabs'), headerCb = $('#sxi-header'), wrap = $('#sxi-wrap');
    const moreEl = $('#sxi-more'), titlesEl = $('#sxi-titles'), sumEl = $('#sxi-summary');
    const errEl = $('#sxi-error'), okBtn = $('#sxi-ok');
    const ac = new AbortController();
    const on = (t, ev, fn) => t.addEventListener(ev, fn, { signal: ac.signal });

    const plan = () => buildPlan(sheets[cur].rows, per[cur]);
    const showError = (msg) => { errEl.textContent = msg || ''; errEl.style.display = msg ? '' : 'none'; };

    const renderTabs = () => {
      tabsEl.style.display = sheets.length > 1 ? 'flex' : 'none';
      tabsEl.innerHTML = sheets.map((s, i) =>
        `<button class="tabBtn${i === cur ? ' active' : ''}" data-sheet="${i}" style="padding:4px 10px;font-size:12px;" dir="auto">${_esc(s.name || `Sheet ${i + 1}`)}${s.rows.length ? '' : ' (empty)'}</button>`).join('');
    };

    const renderTable = () => {
      const rows = sheets[cur].rows;
      const st = per[cur];
      const p = plan();
      if (!rows.length || !p.width) {
        wrap.innerHTML = '<div class="small muted" style="padding:14px;">This sheet is empty.</div>';
        moreEl.textContent = '';
        return;
      }
      const keepX = wrap.scrollLeft, keepY = wrap.scrollTop;
      const data = st.headerRow ? rows.slice(1) : rows;
      const firstExcelRow = st.headerRow ? 2 : 1;
      const mapped = [p.nameCol, p.voiceCol, ...p.titleCols].filter(i => i >= 0);
      const thBase = 'position:sticky;top:0;z-index:1;background:var(--panel);border-bottom:1px solid var(--line);padding:4px 6px;text-align:start;vertical-align:top;font-weight:400;';
      const opt = (v, sel) => `<option value="${v}"${v === sel ? ' selected' : ''}>${ROLE_LABELS[v]}</option>`;
      let html = '<table style="border-collapse:separate;border-spacing:0;font-size:12px;min-width:100%;"><thead><tr>';
      html += `<th style="${thBase}left:0;z-index:2;color:var(--muted);vertical-align:bottom;">#</th>`;
      for (let c = 0; c < p.width; c++) {
        const role = st.roles[c] || 'ignore';
        const tint = _ROLE_TINT[role] ? `box-shadow:inset 0 0 0 999px ${_ROLE_TINT[role]};` : '';
        html += `<th style="${thBase}${tint}min-width:110px;">
          <select data-col="${c}" style="height:26px;font-size:12px;padding:0 4px;">${['ignore', 'name', 'voice', 'title'].map(v => opt(v, role)).join('')}</select>
          <div style="margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px;"><b>${_letter(c)}</b>${p.names[c] ? ` <span dir="auto" title="${_esc(p.names[c])}">${_esc(p.names[c])}</span>` : ''}</div>
        </th>`;
      }
      html += '</tr></thead><tbody>';
      const shown = Math.min(PREVIEW_ROWS, data.length);
      for (let r = 0; r < shown; r++) {
        const row = data[r];
        // a row the import will skip is dimmed, so "N empty rows skipped" is visible
        const skip = !mapped.length || mapped.every(i => String(row[i] ?? '').trim() === '');
        html += `<tr style="${skip && mapped.length ? 'opacity:.4;' : ''}">`;
        html += `<td style="position:sticky;left:0;background:var(--panel);color:var(--muted);padding:3px 6px;border-bottom:1px solid var(--line);text-align:end;">${r + firstExcelRow}</td>`;
        for (let c = 0; c < p.width; c++) {
          const v = String(row[c] ?? '');
          const role = st.roles[c] || 'ignore';
          const tint = _ROLE_TINT[role] ? `background:${_ROLE_TINT[role]};` : '';
          html += `<td dir="auto" title="${_esc(v.length > 600 ? v.slice(0, 600) + '…' : v)}" style="${tint}padding:3px 6px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px;text-align:start;">${_esc(v)}</td>`;
        }
        html += '</tr>';
      }
      html += '</tbody></table>';
      wrap.innerHTML = html;
      wrap.scrollLeft = keepX; wrap.scrollTop = keepY;
      moreEl.textContent = data.length > shown
        ? `…${data.length - shown} more row${data.length - shown === 1 ? '' : 's'} (not shown here — they are imported too)`
        : '';
    };

    const renderTitles = () => {
      const p = plan();
      const st = per[cur];
      if (!p.titleCols.length) { titlesEl.innerHTML = ''; return; }
      const brandOpts = brandTitles.map(b => `<option value="brand:${_esc(b.id)}">${_esc(b.name || 'Title')} (brand title)</option>`).join('');
      const styleOpts = '<option value="">Default style</option>' +
        styles.map(s => `<option value="${_esc(s.id)}">${_esc(s.name || s.id)}</option>`).join('');
      const posOpts = positions.map(o => `<option value="${_esc(o.key)}">${_esc(o.label || o.key)}</option>`).join('');
      titlesEl.innerHTML = `<div class="small muted">Every step gets the same title box per Title column — same style, same place. You can change them later.</div>` +
        p.titleCols.map((c, n) => {
          const look = st.looks[c] || defaultLook(n, positions);
          const isBrand = look.kind === 'brand';
          return `<div data-tcol="${c}" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px;border:1px solid var(--line);border-radius:8px;box-shadow:inset 3px 0 0 #f59e0b;">
            <span style="min-width:140px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><b>Title · ${_letter(c)}</b>${p.names[c] ? ` <span dir="auto">${_esc(p.names[c])}</span>` : ''}</span>
            <label class="small muted" style="display:flex;align-items:center;gap:4px;">Look
              <select data-look style="height:28px;width:auto;min-width:170px;">
                ${brandOpts}<option value="new">New unified look</option>
              </select></label>
            <label class="small muted" data-newonly style="display:${isBrand ? 'none' : 'flex'};align-items:center;gap:4px;">Style
              <select data-style style="height:28px;width:auto;min-width:130px;">${styleOpts}</select></label>
            <label class="small muted" data-newonly style="display:${isBrand ? 'none' : 'flex'};align-items:center;gap:4px;">Position
              <select data-pos style="height:28px;width:auto;min-width:120px;">${posOpts}</select></label>
            ${isBrand ? '<span class="small muted">style + position come from the brand title</span>' : ''}
          </div>`;
        }).join('');
      // set the selects' values after the markup exists (ids may carry any text)
      titlesEl.querySelectorAll('[data-tcol]').forEach((rowEl, n) => {
        const c = Number(rowEl.dataset.tcol);
        const look = st.looks[c] || defaultLook(n, positions);
        rowEl.querySelector('[data-look]').value = look.kind === 'brand' ? `brand:${look.constId}` : 'new';
        rowEl.querySelector('[data-style]').value = look.styleId || '';
        rowEl.querySelector('[data-pos]').value = look.position || positions[0].key;
      });
    };

    const renderSummary = () => {
      const p = plan();
      sumEl.textContent = summaryText(p);
      okBtn.disabled = busy || p.rows.length === 0;
    };

    const renderAll = () => { renderTabs(); headerCb.checked = per[cur].headerRow; renderTable(); renderTitles(); renderSummary(); };

    // Pin the defaults the user saw into st.looks, so changing one field of a
    // look never silently re-defaults the others.
    const lookOf = (c) => {
      const st = per[cur];
      if (!st.looks[c]) {
        const n = plan().titleCols.indexOf(c);
        st.looks[c] = defaultLook(Math.max(0, n), positions);
      }
      return st.looks[c];
    };

    on(tabsEl, 'click', (e) => {
      const b = e.target.closest('[data-sheet]');
      if (!b || busy) return;
      cur = Number(b.dataset.sheet);
      wrap.scrollLeft = 0; wrap.scrollTop = 0;
      showError('');
      renderAll();
    });
    on(headerCb, 'change', () => { per[cur].headerRow = headerCb.checked; renderTable(); renderTitles(); renderSummary(); });
    on(wrap, 'change', (e) => {
      const sel = e.target.closest('select[data-col]');
      if (!sel) return;
      const c = Number(sel.dataset.col);
      const st = per[cur];
      st.roles = assignRole(st.roles, c, sel.value);
      if (sel.value === 'title') lookOf(c);
      showError('');
      renderTable(); renderTitles(); renderSummary();
    });
    on(titlesEl, 'change', (e) => {
      const rowEl = e.target.closest('[data-tcol]');
      if (!rowEl) return;
      const c = Number(rowEl.dataset.tcol);
      const look = lookOf(c);
      const t = e.target;
      if (t.matches('[data-look]')) {
        if (t.value.startsWith('brand:')) per[cur].looks[c] = { kind: 'brand', constId: t.value.slice(6), styleId: look.styleId ?? null, position: look.position };
        else per[cur].looks[c] = { kind: 'new', styleId: look.styleId ?? null, position: look.position || defaultLook(0, positions).position };
        renderTitles();
      } else if (t.matches('[data-style]')) {
        look.styleId = t.value || null;
      } else if (t.matches('[data-pos]')) {
        look.position = t.value;
      }
    });

    // keys typed here are the dialog's — never the app's shortcuts behind it
    // (Ctrl+Z, Delete, step keys). Esc still reaches the native 'cancel'.
    const stopKey = (e) => e.stopPropagation();
    on(dlg, 'keydown', stopKey);
    on(dlg, 'keyup', stopKey);

    let closed = false;
    const close = (result) => {
      if (closed) return;
      closed = true;
      ac.abort();
      try { dlg.close(); } catch { /* fine */ }
      dlg.remove();
      resolve(result);
    };
    on(dlg, 'cancel', (e) => { e.preventDefault(); if (!busy) close(null); });
    on($('#sxi-cancel'), 'click', () => { if (!busy) close(null); });

    on(okBtn, 'click', async () => {
      if (busy) return;
      const p = plan();
      if (!p.rows.length) return;
      // the importer gets clean looks — only the fields its contract names
      const titleColumns = p.titleColumns.map(t => ({
        label: t.label,
        look: t.look.kind === 'brand'
          ? { kind: 'brand', constId: t.look.constId }
          : { kind: 'new', styleId: t.look.styleId ?? null, position: t.look.position },
      }));
      busy = true;
      okBtn.textContent = 'Importing…';
      renderSummary();
      showError('');
      let res;
      try {
        res = await importer.importStepsFromSheet({ rows: p.rows, titleColumns });
      } catch (err) {
        console.error('[sheet-import] import failed', err);
        res = { ok: false, reason: err?.message || 'unknown error' };
      }
      busy = false;
      okBtn.textContent = 'Import';
      if (res?.ok) {
        const n = res.created ?? p.rows.length;
        close(res);
        setStatus(`📊 ${n} step${n === 1 ? '' : 's'} created from ${fileName}${sheets.length > 1 ? ` (${sheets[cur].name})` : ''} — Ctrl+Z undoes the import.`, 'ok', 6000);
      } else {
        // stay open: the user's column choices are worth keeping for a retry
        showError(`Nothing was imported: ${res?.reason || 'unknown reason'}`);
        renderSummary();
      }
    });

    renderAll();
    try { dlg.showModal(); } catch { close(null); }
  });
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
