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
 * V0.3.5.54 — a "Rows to import" line (systems/sheet-range.js): Excel row
 * numbers in the order wanted, C01(Name) codes make new chapters. The table
 * marks the chosen rows as they are typed.
 *
 * V0.3.5.56 — the table is pickable: click / Shift+click / Ctrl+click rows,
 * right-click → add them to the line, to a chapter, to a new chapter, or copy
 * their numbers. Every edit rewrites the line through formatRowSelection.
 * A "Skip rows with nothing in the marked columns" tick — for every row, the typed line too (V0.3.5.58).
 *
 * V0.3.5.57 — colour per block everywhere (one theme-aware palette): each
 * order number in its block's colour, the typed line painted the same way
 * (textarea over a coloured mirror), right-click → Remove from chapter / from
 * the import list, and a "Result" view listing the import as it comes out.
 *
 * The planning (roles → rows) is pure and exported so a node test can drive
 * it; the reader and the importer load on demand, so this module carries no
 * app state of its own.
 */

import { setStatus }         from './status.js';
import { chooseFromButtons } from './prompt.js';
import { parseRowSelection, formatRowSelection, compressRows, addRowsToGroups, nextChapterCode,
         removeRowsFromGroup, groupsHolding } from '../systems/sheet-range.js';

const PREVIEW_ROWS = 300;   // the table is a preview — the import uses every row
const RESULT_ROWS = 2000;   // V0.3.5.57 — the Result view lists this many steps at most

// V0.3.5.57 — ONE palette for the bars, the order numbers, the typed line and
// the Result view. Bright on the dark panels; the light theme gets darker
// twins (white behind them). Hues kept apart (amber / violet / green / pink /
// blue / orange / silver / tan) so neighbours differ for colour-blind eyes as
// far as 8 can. Red stays out — it means "error" here.
const _PALETTE = {
  dark:  { plain: '#22d3ee', ch: ['#fbbf24', '#a78bfa', '#4ade80', '#f472b6', '#60a5fa', '#fb923c', '#cbd5e1', '#d4a373'] },
  light: { plain: '#0e7490', ch: ['#b45309', '#6d28d9', '#15803d', '#be185d', '#1d4ed8', '#c2410c', '#475569', '#8a5a2b'] },
};

/**
 * A group's colour slot: -1 = the plain block, else from the chapter's OWN
 * number (C02 → slot 1), so taking one chapter out never recolours the rest.
 */
export function chapterSlot(group) {
  if (!group?.code) return -1;
  const n = parseInt(String(group.code).slice(1), 10);
  const k = _PALETTE.dark.ch.length;
  return Number.isFinite(n) ? (((n - 1) % k) + k) % k : k - 1;
}

/** Slot → colour for the current theme (`light` = the app's light theme). */
export function slotColor(slot, light) {
  const p = light ? _PALETTE.light : _PALETTE.dark;
  return slot < 0 ? p.plain : p.ch[slot % p.ch.length];
}

const _isLight = () => typeof document !== 'undefined' && document.documentElement?.getAttribute('data-theme') === 'light';

/**
 * V0.3.5.57 — the typed line cut into painted runs for the mirror behind the
 * text box: each chapter's code, name and rows in its colour, the plain block
 * in its own, the parts an error is about underlined. Runs cover the text
 * exactly once, in order. → [{ text, color|null, bad:boolean }]
 */
export function lineRuns(text, selection, light) {
  const src = String(text ?? '');
  const n = src.length;
  const col = new Array(n).fill(null);
  const bad = new Uint8Array(n);
  for (const s of selection?.spans || []) {
    const c = s.group >= 0 ? slotColor(chapterSlot(selection.groups[s.group]), light) : null;
    for (let i = Math.max(0, s.start); i < Math.min(n, s.end); i++) col[i] = c;
  }
  for (const b of selection?.bad || []) for (let i = Math.max(0, b.start); i < Math.min(n, b.end); i++) bad[i] = 1;
  const runs = [];
  for (let i = 0; i < n;) {
    let j = i + 1;
    while (j < n && col[j] === col[i] && bad[j] === bad[i]) j++;
    runs.push({ text: src.slice(i, j), color: col[i], bad: !!bad[i] });
    i = j;
  }
  return runs;
}

/**
 * V0.3.5.57 — the "Result" view's content: the import as it WILL come out,
 * block by block in order (plain block first, then each chapter), from the
 * plan + the sheet rows. Pure, so a node test can read it.
 * → { sections:[{ code, name, slot, steps:[{ n, row, name, named, voice, titles, empty }] }],
 *     total, notIn (sheet rows the line leaves out), skipped (empty rows the tick skipped) }
 */
export function resultModel(plan, rows) {
  const mapped = [plan.nameCol, plan.voiceCol, ...plan.titleCols].filter(i => i >= 0);
  const cell = (row, i) => String(row?.[i] ?? '').trim();
  const sections = [];
  let cur = null;
  plan.rows.forEach((st, k) => {
    const gi = plan.stepGroup[k];
    if (!cur || cur.gi !== gi) {
      const g = plan.groupInfo[gi];
      cur = { gi, code: g?.code || null, name: g?.code ? g.name : null, slot: chapterSlot(g), steps: [] };
      sections.push(cur);
    }
    const src = rows[plan.order[k] - 1] || [];
    cur.steps.push({
      n: k + 1, row: plan.order[k], name: st.name,
      named: plan.nameCol >= 0 && cell(src, plan.nameCol) !== '',
      voice: st.voice, titles: st.titles,
      empty: !mapped.length || mapped.every(i => cell(src, i) === ''),
    });
  });
  for (const s of sections) delete s.gi;
  const ranged = plan.selection && !plan.selection.empty;
  const notIn = ranged ? Math.max(0, plan.dataCount - new Set(plan.order).size) : 0;
  return { sections, total: plan.rows.length, notIn, skipped: ranged ? 0 : plan.skipped };
}

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
 * Roles + looks (+ the "Rows to import" line) → exactly what
 * importStepsFromSheet takes, plus the counts the summary line shows. A row
 * whose MAPPED cells are all empty is skipped (a client's sheet is full of
 * spacer rows); an empty / missing name becomes "Step N", N = its place among
 * the imported rows.
 *
 * V0.3.5.54 — `range` (Excel row numbers, sheet-range.js) picks WHICH rows and
 * in WHAT order; C01(Name) codes make `groups` for the importer. Empty line =
 * every row, exactly as before. Extra fields for the viewer: `order` (Excel
 * row of each imported step), `stepGroup` (its index in `groupInfo`),
 * `selection` (the parse), `warnings`, `chapters`, `blocked` (line has errors).
 *
 * V0.3.5.58 — `skipEmpty` (the "Skip rows with nothing in the marked
 * columns" tick, ON by default) governs EVERY row, the typed line's too (his
 * expectation: tick it and the empty ones leave the range at once, the step
 * numbers close up). Unticked, an empty row becomes an empty "Step N", said in
 * `notes`. `skippedRows` = the Excel rows the tick left out (for the marks).
 *
 * @param {string[][]} rows    the whole sheet
 * @param {{ headerRow:boolean, roles:string[], looks:object[], range?:string, skipEmpty?:boolean }} opts
 */
export function buildPlan(rows, { headerRow, roles, looks, range = '', skipEmpty = true }) {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const names = columnNames(rows, headerRow, width);
  const data = headerRow ? rows.slice(1) : rows;
  const firstRow = headerRow ? 2 : 1;
  const nameCol = roles.indexOf('name');
  const voiceCol = roles.indexOf('voice');
  const titleCols = [];
  roles.forEach((r, i) => { if (r === 'title') titleCols.push(i); });
  const mapped = [nameCol, voiceCol, ...titleCols].filter(i => i >= 0);

  const cell = (row, i) => String(row[i] ?? '').trim();
  const isEmpty = (row) => !mapped.length || mapped.every(i => cell(row, i) === '');
  const out = [];
  const order = [], stepGroup = [];
  const take = (row, excelRow, g) => {
    const nm = nameCol >= 0 ? cell(row, nameCol) : '';
    out.push({
      name:   nm || `Step ${out.length + 1}`,   // N = place in the IMPORTED order
      voice:  voiceCol >= 0 ? cell(row, voiceCol) : '',
      titles: titleCols.map(i => cell(row, i)),
    });
    order.push(excelRow);
    stepGroup.push(g);
  };

  const selection = parseRowSelection(range, { firstRow, lastRow: rows.length });
  const warnings = [], notes = [];
  const groupInfo = [];   // [{ code, name, count }] — only groups that kept steps
  let skipped = 0, emptyTaken = 0, groups, chapters = 0;
  const skippedRows = new Set();
  if (!mapped.length) {
    // nothing marked = nothing to make steps from (the summary says so)
  } else if (selection.empty) {
    data.forEach((row, k) => {
      const empty = isEmpty(row);
      if (empty && skipEmpty) { skipped++; return; }
      if (empty) emptyTaken++;
      take(row, k + firstRow, -1);
    });
  } else {
    // Marks follow the typed line even while it still has errors (the user
    // sees what he has so far); `blocked` keeps Import off until it is clean.
    const emptyRows = [];
    for (const g of selection.groups) {
      const gi = groupInfo.length;
      const before = out.length;
      for (const r of g.rows) {
        const row = rows[r - 1] || [];
        if (isEmpty(row)) {
          if (skipEmpty) { skipped++; skippedRows.add(r); continue; }   // V0.3.5.58 — the tick filters the line too
          emptyRows.push(r);
        }
        take(row, r, gi);
      }
      const count = out.length - before;
      if (count) groupInfo.push({ code: g.code, name: g.code ? (g.name || g.code) : null, count });
      else if (g.code && g.rows.length) warnings.push(`${g.code} has only empty rows — it is left out (untick "Skip rows…" to keep them)`);
    }
    emptyTaken = emptyRows.length;
    if (emptyRows.length) {
      const u = [...new Set(emptyRows)];
      const list = u.slice(0, 8).join(', ') + (u.length > 8 ? ', …' : '');
      notes.push(u.length === 1
        ? `Row ${list} is empty in the chosen columns — it comes in as an empty step`
        : `Rows ${list} are empty in the chosen columns — they come in as empty steps`);
    }
    chapters = groupInfo.filter(g => g.code).length;
    // no codes → no groups: the importer places the steps exactly as before
    if (chapters) groups = groupInfo.map(g => ({ name: g.name, count: g.count }));
  }
  warnings.unshift(...selection.warnings);

  const titleColumns = titleCols.map((i, n) => ({
    label: names[i] || `Column ${_letter(i)}`,
    look:  looks?.[i] || defaultLook(n),
  }));
  return {
    rows: out, titleColumns, skipped, emptyTaken, nameCol, voiceCol, titleCols, dataCount: data.length, width, names,
    groups, order, stepGroup, groupInfo, chapters, selection, warnings, notes, firstRow, skippedRows,
    blocked: !selection.ok,
  };
}

/** The one-line summary under the table. */
export function summaryText(plan) {
  if (plan.nameCol < 0 && plan.voiceCol < 0 && !plan.titleCols.length) {
    return 'Choose a role above at least one column — Step name, Voiceover or Title.';
  }
  const n = plan.rows.length;
  const steps = n === 1 ? '1 step' : `${n} steps`;
  const ranged = plan.selection && !plan.selection.empty;
  if (ranged && plan.blocked) return 'Fix the "Rows to import" line — nothing is imported until it reads cleanly.';
  const bits = [!ranged
    ? `${steps} will be created`
    : (plan.chapters ? `${plan.chapters === 1 ? '1 chapter' : `${plan.chapters} chapters`} · ${steps}` : steps)];
  bits.push(plan.nameCol >= 0 ? `names from ${_letter(plan.nameCol)}` : 'named Step 1, Step 2, …');
  if (plan.voiceCol >= 0) bits.push(`voiceover from ${_letter(plan.voiceCol)}`);
  const t = plan.titleCols.length;
  if (t) bits.push(t === 1 ? '1 title' : `${t} titles`);
  if (plan.skipped) bits.push(plan.skipped === 1 ? '1 empty row skipped' : `${plan.skipped} empty rows skipped`);
  if (plan.emptyTaken) bits.push(plan.emptyTaken === 1 ? '1 of them empty' : `${plan.emptyTaken} of them empty`);
  if (ranged && plan.chapters && plan.groupInfo?.[0] && !plan.groupInfo[0].code) {
    const pre = plan.groupInfo[0].count;
    bits.push(`${pre === 1 ? '1 step' : `${pre} steps`} before the chapters`);
  }
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

// V0.3.5.56 — .ods (LibreOffice / OpenOffice) was readable but not pickable.
const _FILTERS = [
  { name: 'Spreadsheet', extensions: ['xlsx', 'xlsm', 'ods', 'csv', 'tsv', 'txt', 'xls'] },
  { name: 'Excel',       extensions: ['xlsx', 'xlsm', 'xls'] },
  { name: 'OpenDocument (LibreOffice)', extensions: ['ods'] },
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
    input.accept = '.xlsx,.xlsm,.xls,.ods,.csv,.tsv,.txt';
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
      return { headerRow: true, roles: Array(width).fill('ignore'), looks: [], range: '' };
    });
    // first non-empty sheet
    let cur = Math.max(0, sheets.findIndex(s => s.rows.length));
    let busy = false;
    // V0.3.5.56 — one tick for the whole viewer: skip empty rows when the
    // line is empty (all rows). Rows chosen in the line ignore it.
    let skipEmpty = true;
    // picked table rows (Excel row numbers) + the Shift+click anchor; reset
    // whenever the rows under them change meaning (sheet tab, header switch)
    let picked = new Set(), anchor = null;

    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    dlg.style.cssText = 'width:min(1120px,96vw);max-width:96vw;';
    dlg.innerHTML = `
      <style>
        #sxi-wrap tbody tr { cursor:default; }
        #sxi-wrap tbody tr.sxi-pick > td { background-image:linear-gradient(rgba(129,140,248,.34),rgba(129,140,248,.34)) !important; }
        #sxi-wrap tbody tr.sxi-pick { opacity:1 !important; }
        #sxi-wrap tbody tr.sxi-pick > td:first-child { outline:1px solid rgba(165,180,252,.7); outline-offset:-1px; }
        #sxi-wrap:focus { outline:none; }
        /* V0.3.5.57 — the "Rows to import" box: a textarea with see-through
           text over a mirror (#sxi-range-hl) that paints the same text in the
           chapters' colours. Both MUST share font, padding, line height and
           wrapping, or the colours drift off the caret. */
        #sxi-range-box { position:relative; flex:1; min-width:260px; border:1px solid var(--line); border-radius:8px; background:#111827; }
        html[data-theme="light"] #sxi-range-box { background:var(--panel); }
        #sxi-range-box:focus-within { border-color:var(--accent); }
        #sxi-range, #sxi-range-hl { box-sizing:border-box; margin:0; border:0; padding:4px 10px;
          font:13px/20px Consolas, ui-monospace, monospace; letter-spacing:0; word-spacing:0; tab-size:4;
          white-space:pre-wrap; overflow-wrap:break-word; word-break:normal; text-align:left; direction:ltr; }
        #sxi-range-hl { position:absolute; inset:0; overflow:hidden; pointer-events:none; color:var(--text); }
        #sxi-range { position:relative; display:block; width:100%; height:28px; min-height:28px; resize:none; overflow-y:hidden;
          background:transparent !important; color:transparent; caret-color:var(--text); outline:none; box-shadow:none; border-radius:8px; }
        #sxi-range::placeholder { color:var(--muted); }
        #sxi-range::selection { background:rgba(129,140,248,.38); color:transparent; }
        #sxi-view .tabBtn { padding:3px 12px; font-size:12px; }
      </style>
      <div class="sbs-dialog__body" style="display:flex;flex-direction:column;gap:10px;">
        <div>
          <div class="sbs-dialog__title">📊 Steps from Excel</div>
          <div class="small muted" style="word-break:break-all;">${_esc(fileName)} — mark the columns, then Import. One step per row, added to this project; Ctrl+Z takes the whole import back.</div>
        </div>
        <div id="sxi-tabs" style="display:flex;gap:6px;flex-wrap:wrap;"></div>
        <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:center;">
          <label style="display:flex;align-items:center;gap:6px;width:fit-content;cursor:pointer;">
            <input type="checkbox" id="sxi-header" />
            <span>First row is column names</span>
          </label>
          <label style="display:flex;align-items:center;gap:6px;width:fit-content;cursor:pointer;" title="Ticked, rows with nothing in the marked columns are left out — also the ones in &quot;Rows to import&quot; (they show ⊘). Untick to bring them in as empty steps.">
            <input type="checkbox" id="sxi-skip" />
            <span>Skip rows with nothing in the marked columns</span>
          </label>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <div style="display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;">
            <label for="sxi-range" style="white-space:nowrap;line-height:30px;">Rows to import</label>
            <div id="sxi-range-box">
              <div id="sxi-range-hl" aria-hidden="true"></div>
              <textarea id="sxi-range" rows="1" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" dir="ltr"
                wrap="soft" placeholder="empty = all rows"></textarea>
            </div>
          </div>
          <div class="small muted">e.g. 1-8, 56, 23-38 · chapters: C01(Name)5-15,54-56 · empty = all — the # numbers below, in the order typed. New chapters go right after the chapter of the selected step. Or pick rows below (click, Shift+click, Ctrl+click) and right-click them. "Result" shows the steps as they will come out.</div>
          <div id="sxi-range-err" class="small" style="color:#f87171;display:none;"></div>
          <div id="sxi-range-warn" class="small" style="color:#fbbf24;display:none;"></div>
          <div id="sxi-range-note" class="small" style="color:#7dd3fc;display:none;"></div>
          <div id="sxi-flash" class="small" style="color:#a5b4fc;display:none;"></div>
        </div>
        <div id="sxi-view" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          <button class="tabBtn active" data-view="sheet" title="The spreadsheet — mark the columns, pick rows">Sheet</button>
          <button class="tabBtn" data-view="result" title="The steps as they will come out of the import, in order">Result</button>
          <span id="sxi-view-note" class="small muted"></span>
        </div>
        <div id="sxi-wrap" tabindex="-1" style="overflow:auto;max-height:46vh;border:1px solid var(--line);border-radius:8px;"></div>
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
    const rangeIn = $('#sxi-range'), rangeErr = $('#sxi-range-err'), rangeWarn = $('#sxi-range-warn');
    const rangeNote = $('#sxi-range-note'), flashEl = $('#sxi-flash'), skipCb = $('#sxi-skip');
    const rangeBox = $('#sxi-range-box'), rangeHl = $('#sxi-range-hl');
    const viewEl = $('#sxi-view'), viewNote = $('#sxi-view-note');
    // V0.3.5.57 — 'sheet' (the table) or 'result' (the import as it comes out);
    // each keeps its own scroll so flipping back lands where it was
    let view = 'sheet';
    const viewScroll = { sheet: [0, 0], result: [0, 0] };
    const ac = new AbortController();
    const on = (t, ev, fn) => t.addEventListener(ev, fn, { signal: ac.signal });

    const plan = () => buildPlan(sheets[cur].rows, { ...per[cur], skipEmpty });
    const showError = (msg) => { errEl.textContent = msg || ''; errEl.style.display = msg ? '' : 'none'; };

    const renderTabs = () => {
      tabsEl.style.display = sheets.length > 1 ? 'flex' : 'none';
      tabsEl.innerHTML = sheets.map((s, i) =>
        `<button class="tabBtn${i === cur ? ' active' : ''}" data-sheet="${i}" style="padding:4px 10px;font-size:12px;" dir="auto">${_esc(s.name || `Sheet ${i + 1}`)}${s.rows.length ? '' : ' (empty)'}</button>`).join('');
    };

    const renderTable = () => {
      if (view === 'result') { renderResult(); return; }
      viewNote.textContent = '';
      const rows = sheets[cur].rows;
      const st = per[cur];
      const p = plan();
      const light = _isLight();
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
      // V0.3.5.54 — with a "Rows to import" line: Excel row → its import order
      // number(s) + block, so the chosen rows show the moment they are typed
      const ranged = !p.selection.empty;
      const marks = new Map();
      if (ranged) p.order.forEach((xr, k) => { if (!marks.has(xr)) marks.set(xr, []); marks.get(xr).push(k); });
      const shown = Math.min(PREVIEW_ROWS, data.length);
      for (let r = 0; r < shown; r++) {
        const row = data[r];
        const xr = r + firstExcelRow;
        // a row the import will skip is dimmed, so "N empty rows skipped" is visible
        const skip = !mapped.length || mapped.every(i => String(row[i] ?? '').trim() === '');
        const mk = marks.get(xr);
        const dim = ranged ? (mapped.length && !mk) : (skip && mapped.length && skipEmpty);
        let numCell = String(xr), bar = '', tip = '';
        if (ranged && !mk && p.skippedRows?.has(xr)) {   // V0.3.5.58 — chosen, but empty and skipped by the tick
          numCell = `<span style="margin-inline-end:6px;">⊘</span>${xr}`;
          tip = ` title="Row ${xr} is in the line but empty in the marked columns — skipped (untick &quot;Skip rows…&quot; to keep it)"`;
        }
        if (mk) {
          // V0.3.5.57 — a row used in several blocks: EACH number in its own
          // block's colour, and the bar becomes thin side-by-side stripes
          const groupOf = (k) => p.groupInfo[p.stepGroup[k]];
          const colOf = (k) => slotColor(chapterSlot(groupOf(k)), light);
          const cols = [...new Set(mk.map(colOf))].slice(0, 3);
          bar = cols.length === 1
            ? `box-shadow:inset 3px 0 0 ${cols[0]};`
            : `box-shadow:${cols.map((c, n) => `inset ${(n + 1) * 2}px 0 0 ${c}`).join(',')};`;
          const shownK = mk.slice(0, 3);
          const nums = shownK.map(k => `<span style="color:${colOf(k)};">${k + 1}</span>`).join(',') + (mk.length > 3 ? ',…' : '');
          const where = (k) => { const g = groupOf(k); return `step ${k + 1}${g?.code ? ` (${g.code} ${g.name})` : ''}`; };
          tip = ` title="${_esc(`Row ${xr} → ${mk.map(where).join(', ')}`)}"`;
          numCell = `<span style="color:${colOf(mk[0])};font-weight:600;margin-inline-end:6px;">→${nums}</span>${xr}`;
        }
        html += `<tr data-xr="${xr}"${picked.has(xr) ? ' class="sxi-pick"' : ''} style="${dim ? 'opacity:.35;' : ''}">`;
        html += `<td${tip} style="position:sticky;left:0;background:var(--panel);${bar}color:var(--muted);padding:3px 6px;border-bottom:1px solid var(--line);text-align:end;white-space:nowrap;">${numCell}</td>`;
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
        ? `…${data.length - shown} more row${data.length - shown === 1 ? '' : 's'} (not shown here — ${ranged ? 'the ones chosen in the line are imported too' : 'they are imported too'})`
        : '';
    };

    const renderRange = () => {
      const p = plan();
      const errs = p.selection.errors;
      rangeErr.textContent = errs.join(' · ');
      rangeErr.style.display = errs.length ? '' : 'none';
      rangeWarn.textContent = p.warnings.join(' · ');
      rangeWarn.style.display = p.warnings.length ? '' : 'none';
      rangeNote.textContent = p.notes.join(' · ');
      rangeNote.style.display = p.notes.length ? '' : 'none';
      rangeBox.style.borderColor = errs.length ? '#f87171' : '';
      paintLine(p);
    };

    // V0.3.5.57 — the mirror behind the box: same text, painted per block.
    // A trailing space keeps a last empty line (pasted newline) as tall as the
    // textarea's, so the two never disagree on height.
    const paintLine = (p = plan()) => {
      const light = _isLight();
      rangeHl.innerHTML = lineRuns(rangeIn.value, p.selection, light).map(r =>
        `<span style="${r.color ? `color:${r.color};` : ''}${r.bad ? 'text-decoration:underline wavy #f87171;' : ''}">${_esc(r.text)}</span>`).join('') + ' ';
      fitLine();
    };
    // grow with the text up to ~5 lines, then scroll; the mirror follows. A
    // scrollbar narrows the textarea, so the mirror reserves the same gutter.
    const LINE_MAX = 108;
    const fitLine = () => {
      const keep = rangeIn.scrollTop;   // measuring at height 0 may clamp it
      rangeIn.style.height = '0px';
      const h = rangeIn.scrollHeight;
      if (!h) { rangeIn.style.height = ''; return; }   // not laid out yet (before showModal)
      const over = h > LINE_MAX + 1;
      rangeIn.style.height = `${Math.max(28, Math.min(h, LINE_MAX))}px`;
      rangeIn.style.overflowY = over ? 'scroll' : 'hidden';
      rangeHl.style.scrollbarGutter = over ? 'stable' : 'auto';
      rangeIn.scrollTop = keep;
      rangeHl.scrollTop = rangeIn.scrollTop;
    };

    // V0.3.5.57 — the Result view: what the import makes, in order. Read-only;
    // re-built on every change, like the table it stands in for.
    const renderResult = () => {
      const rows = sheets[cur].rows;
      const p = plan();
      const light = _isLight();
      moreEl.textContent = '';
      if (!rows.length || !p.width) {
        wrap.innerHTML = '<div class="small muted" style="padding:14px;">This sheet is empty.</div>';
        viewNote.textContent = '';
        return;
      }
      if (p.nameCol < 0 && p.voiceCol < 0 && !p.titleCols.length) {
        wrap.innerHTML = '<div class="small muted" style="padding:14px;">Nothing to show yet — in the Sheet view, choose a role above at least one column (Step name, Voiceover or Title).</div>';
        viewNote.textContent = '';
        return;
      }
      const m = resultModel(p, rows);
      const left = [];
      if (m.skipped) left.push(`${m.skipped} empty row${m.skipped === 1 ? '' : 's'} skipped`);
      if (m.notIn) left.push(`${m.notIn} row${m.notIn === 1 ? '' : 's'} of the sheet not in the line`);
      viewNote.textContent = `${m.total === 1 ? '1 step' : `${m.total} steps`}, in import order${left.length ? ` · ${left.join(' · ')} (not shown)` : ''}`;
      const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
      const th = 'position:sticky;top:0;z-index:1;background:var(--panel);border-bottom:1px solid var(--line);padding:4px 6px;text-align:start;font-weight:600;white-space:nowrap;';
      const td = 'padding:3px 6px;border-bottom:1px solid var(--line);vertical-align:top;text-align:start;';
      const showVoice = p.voiceCol >= 0;
      const ncols = 3 + (showVoice ? 1 : 0) + p.titleCols.length;
      let html = '<table style="border-collapse:separate;border-spacing:0;font-size:12px;min-width:100%;"><thead><tr>';
      html += `<th style="${th}">Step</th><th style="${th}">Row</th><th style="${th}">Step name</th>`;
      if (showVoice) html += `<th style="${th}">Voiceover</th>`;
      p.titleColumns.forEach(t => { html += `<th style="${th}" dir="auto">${_esc(t.label)}</th>`; });
      html += '</tr></thead><tbody>';
      if (p.blocked) {
        html += `<tr><td colspan="${ncols}" style="${td}color:#f87171;">The "Rows to import" line still has errors — this is what it reads so far. Import stays off until it reads cleanly.</td></tr>`;
      }
      const hasChapters = m.sections.some(s => s.code);
      let listed = 0;
      for (const s of m.sections) {
        if (listed >= RESULT_ROWS) break;
        const col = slotColor(s.slot, light);
        const count = s.steps.length === 1 ? '1 step' : `${s.steps.length} steps`;
        if (s.code) {
          html += `<tr><td colspan="${ncols}" style="${td}padding-top:10px;box-shadow:inset 3px 0 0 ${col};"><span style="color:${col};font-weight:700;">${_esc(s.code)} · <span dir="auto">${_esc(s.name || s.code)}</span></span> <span class="muted">— ${count}</span></td></tr>`;
        } else if (hasChapters) {
          html += `<tr><td colspan="${ncols}" style="${td}padding-top:10px;box-shadow:inset 3px 0 0 ${col};"><span style="color:${col};font-weight:700;">Before the chapters</span> <span class="muted">— ${count}</span></td></tr>`;
        }
        for (const st of s.steps) {
          if (listed++ >= RESULT_ROWS) break;
          const nm = st.named ? _esc(cut(st.name, 120)) : `<i class="muted">${_esc(st.name)}</i>`;
          const empty = st.empty ? ' <span class="small" style="border:1px solid var(--line);border-radius:6px;padding:0 5px;color:var(--muted);">empty</span>' : '';
          html += `<tr>`;
          html += `<td style="${td}box-shadow:inset 3px 0 0 ${col};color:${col};font-weight:600;text-align:end;white-space:nowrap;">${st.n}</td>`;
          html += `<td style="${td}color:var(--muted);text-align:end;white-space:nowrap;">${st.row}</td>`;
          html += `<td dir="auto" title="${_esc(cut(st.name, 600))}" style="${td}min-width:140px;max-width:280px;">${nm}${empty}</td>`;
          if (showVoice) html += `<td dir="auto" title="${_esc(cut(st.voice, 600))}" style="${td}min-width:180px;max-width:420px;">${st.voice ? _esc(cut(st.voice, 160)) : '<span class="muted">—</span>'}</td>`;
          st.titles.forEach(t => { html += `<td dir="auto" title="${_esc(cut(t, 600))}" style="${td}max-width:220px;">${t ? _esc(cut(t, 80)) : '<span class="muted">—</span>'}</td>`; });
          html += '</tr>';
        }
      }
      html += '</tbody></table>';
      wrap.innerHTML = html;
      if (m.total > RESULT_ROWS) moreEl.textContent = `…${m.total - RESULT_ROWS} more steps (not listed here — they are imported too)`;
    };

    const setView = (v) => {
      if (v === view) return;
      viewScroll[view] = [wrap.scrollLeft, wrap.scrollTop];
      view = v;
      viewEl.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === v));
      hideMenu();
      renderTable();
      [wrap.scrollLeft, wrap.scrollTop] = viewScroll[v];
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
      okBtn.disabled = busy || p.blocked || p.rows.length === 0;
    };

    const renderAll = () => {
      renderTabs();
      headerCb.checked = per[cur].headerRow;
      skipCb.checked = skipEmpty;
      rangeIn.value = per[cur].range || '';
      renderTable(); renderTitles(); renderRange(); renderSummary();
    };

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
      clearPicks(); hideMenu(); flash('');
      renderAll();
    });
    // the typed line stays; it is simply re-read against the new first row
    on(headerCb, 'change', () => {
      per[cur].headerRow = headerCb.checked;
      clearPicks(); hideMenu();   // row 1 may have just become the column names
      renderTable(); renderTitles(); renderRange(); renderSummary();
    });
    on(skipCb, 'change', () => { skipEmpty = skipCb.checked; renderTable(); renderRange(); renderSummary(); });
    on(rangeIn, 'input', () => { per[cur].range = rangeIn.value; showError(''); renderTable(); renderRange(); renderSummary(); });
    // V0.3.5.57 — a textarea now (so it can wrap over the coloured mirror),
    // but still ONE line to the user: Enter adds nothing. Pasted newlines are
    // fine — the line reads them as separators.
    on(rangeIn, 'keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    on(rangeIn, 'scroll', () => { rangeHl.scrollTop = rangeIn.scrollTop; rangeHl.scrollLeft = rangeIn.scrollLeft; });
    on(window, 'resize', fitLine);
    on(viewEl, 'click', (e) => {
      const b = e.target.closest('[data-view]');
      if (b) setView(b.dataset.view);
    });
    // V0.3.5.57 — the palette follows the app's theme (setTheme flips
    // data-theme on <html>): repaint the bars, numbers, line and Result.
    const themeWatch = new MutationObserver(() => { renderTable(); paintLine(); });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    ac.signal.addEventListener('abort', () => themeWatch.disconnect());
    on(wrap, 'change', (e) => {
      const sel = e.target.closest('select[data-col]');
      if (!sel) return;
      const c = Number(sel.dataset.col);
      const st = per[cur];
      st.roles = assignRole(st.roles, c, sel.value);
      if (sel.value === 'title') lookOf(c);
      showError('');
      renderTable(); renderTitles(); renderRange(); renderSummary();
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

    // ─── V0.3.5.56 — picking rows + the right-click menu ─────────────────────
    // The menu and its questions live INSIDE the dialog: showModal() puts the
    // dialog in the top layer, so the app's #context-menu would open behind it.
    let menuEl = null, subEl = null, askClose = null;
    const flash = (msg) => { flashEl.textContent = msg || ''; flashEl.style.display = msg ? '' : 'none'; };
    const clearPicks = () => { picked = new Set(); anchor = null; };
    const pickedRows = () => [...picked].sort((a, b) => a - b);   // table order
    const paintPicks = () => wrap.querySelectorAll('tbody tr[data-xr]')
      .forEach(tr => tr.classList.toggle('sxi-pick', picked.has(Number(tr.dataset.xr))));
    const rowsText = (rows) => rows.length === 1 ? `Row ${rows[0]}` : `Rows ${compressRows(rows)}`;
    const short = (s, n = 140) => (s.length > n ? s.slice(0, n) + '…' : s);
    const hideMenu = () => { menuEl?.remove(); subEl?.remove(); menuEl = subEl = null; };

    const place = (el, x, y) => {
      const r = el.getBoundingClientRect();
      const cx = x + r.width > window.innerWidth ? window.innerWidth - r.width - 4 : x;
      const cy = y + r.height > window.innerHeight ? window.innerHeight - r.height - 4 : y;
      el.style.left = `${Math.max(4, cx)}px`;
      el.style.top = `${Math.max(4, cy)}px`;
    };
    const openSub = (btn, items) => {
      subEl?.remove();
      subEl = buildMenu(items, true);
      const r = btn.getBoundingClientRect(), fr = subEl.getBoundingClientRect();
      place(subEl, r.right + fr.width > window.innerWidth ? r.left - fr.width + 2 : r.right - 2, r.top - 6);
    };
    // same look as the app's context menu (its CSS classes), built here
    function buildMenu(items, isSub) {
      const m = document.createElement('div');
      m.className = 'context-menu show';
      m.style.cssText = 'position:fixed;left:0;top:0;z-index:10;max-height:70vh;overflow:auto;';
      for (const it of items) {
        if (it.separator) { const hr = document.createElement('div'); hr.className = 'context-menu__separator'; m.appendChild(hr); continue; }
        const b = document.createElement('button');
        b.className = 'context-menu__item';
        b.textContent = it.submenu ? `${it.label}  ▸` : it.label;
        b.disabled = !!it.disabled;
        if (it.title) b.title = it.title;
        if (it.color && !b.disabled) b.style.color = it.color;   // V0.3.5.57 — a chapter in its colour
        if (it.submenu) {
          const open = () => { if (!b.disabled) openSub(b, it.submenu); };
          on(b, 'mouseenter', open);
          on(b, 'click', open);
        } else {
          if (!isSub) on(b, 'mouseenter', () => { subEl?.remove(); subEl = null; });
          on(b, 'click', () => { hideMenu(); it.action?.(); });
        }
        m.appendChild(b);
      }
      // clicks in the menu are the menu's — not the table's, not the app's
      for (const ev of ['pointerdown', 'mousedown', 'click', 'contextmenu']) {
        on(m, ev, (e) => { e.stopPropagation(); if (ev === 'contextmenu') e.preventDefault(); });
      }
      dlg.appendChild(m);
      return m;
    }

    /** A question inside the dialog → { id, value } or null (Esc / Cancel). */
    const ask = ({ title, message, buttons, input }) => new Promise((res) => {
      askClose?.(null);
      const layer = document.createElement('div');
      layer.style.cssText = 'position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4);';
      layer.innerHTML = `<div style="background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;width:min(480px,90vw);display:flex;flex-direction:column;gap:10px;box-shadow:0 18px 36px rgba(0,0,0,.5);">
        <div style="font-weight:700;">${_esc(title)}</div>
        ${message ? `<div class="small" style="white-space:pre-wrap;">${_esc(message)}</div>` : ''}
        ${input ? `<input type="text" data-ask-in dir="auto" spellcheck="false" autocomplete="off" placeholder="${_esc(input.placeholder || '')}" style="height:28px;" />` : ''}
        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">${buttons.map(b =>
          `<button class="btn" data-ask="${_esc(b.id)}"${b.primary ? ' style="color:#22d3ee;font-weight:600;"' : ''}>${_esc(b.label)}</button>`).join('')}</div>
      </div>`;
      dlg.appendChild(layer);
      const inp = layer.querySelector('[data-ask-in]');
      const done = (id) => {
        if (askClose !== done) return;
        askClose = null;
        const value = inp ? inp.value : '';
        layer.remove();
        wrap.focus({ preventScroll: true });
        res(id == null || id === 'cancel' ? null : { id, value });
      };
      askClose = done;
      for (const ev of ['pointerdown', 'mousedown', 'contextmenu']) on(layer, ev, (e) => e.stopPropagation());
      on(layer, 'click', (e) => { e.stopPropagation(); const b = e.target.closest('[data-ask]'); if (b) done(b.dataset.ask); });
      const primary = buttons.find(b => b.primary) || buttons[0];
      if (inp) {
        inp.value = input.value || '';
        on(inp, 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(primary.id); } });
        inp.focus(); inp.select();
      } else {
        layer.querySelector(`[data-ask="${CSS.escape(primary.id)}"]`)?.focus();
      }
    });

    // Every edit: change the parsed groups, write the WHOLE line back
    // (formatRowSelection), then re-read it exactly as if it had been typed.
    const setLine = (groups, msg) => {
      const text = formatRowSelection(groups);
      per[cur].range = text;
      rangeIn.value = text;
      showError('');
      renderTable(); renderRange(); renderSummary();
      flash(msg);
    };
    const lineUsable = (p) => p.selection.empty || p.selection.ok;

    const addToList = (rows) => {
      const p = plan();
      if (!lineUsable(p)) return;
      setLine(addRowsToGroups(p.selection.groups, rows, 'plain'), `➕ ${rowsText(rows)} added to the import list`);
    };

    const addToChapter = async (gi, rows) => {
      const p = plan();
      const g = p.selection.groups[gi];
      if (!lineUsable(p) || !g?.code) return;
      let add = rows;
      // Repeats are fine anywhere (a row may be a step twice) — but adding a
      // row to the chapter that already holds it is more likely a slip: ask.
      const have = new Set(g.rows);
      const dup = rows.filter(r => have.has(r));
      if (dup.length) {
        const fresh = rows.filter(r => !have.has(r));
        const label = `${g.code} (${g.name || g.code})`;
        const ans = await ask({
          title: '📁 Already in this chapter',
          message: `${rowsText(dup)} ${dup.length === 1 ? 'is' : 'are'} already in ${label}.\n` +
            (fresh.length
              ? 'Add them again (each time becomes its own step), or leave those out and add only the new ones?'
              : 'Adding again makes each of them a second step in this chapter.'),
          buttons: [
            { id: 'again', label: 'Add them again', primary: !fresh.length },
            ...(fresh.length ? [{ id: 'new', label: `Add only the new ones (${fresh.length})`, primary: true }] : []),
            { id: 'cancel', label: 'Cancel' },
          ],
        });
        if (!ans) return;
        if (ans.id === 'new') add = fresh;
      }
      setLine(addRowsToGroups(plan().selection.groups, add, gi), `📁 ${rowsText(add)} added to the end of ${g.code} (${g.name || g.code})`);
    };

    const newChapter = async (rows) => {
      const p = plan();
      if (!lineUsable(p)) return;
      const code = nextChapterCode(p.selection.groups);
      const ans = await ask({
        title: `＋ New chapter ${code}`,
        message: `It goes at the end of the line and holds ${rowsText(rows).toLowerCase()}, in this order.`,
        input: { value: '', placeholder: 'Chapter name, e.g. Clean parts' },
        buttons: [{ id: 'ok', label: 'Make chapter', primary: true }, { id: 'cancel', label: 'Cancel' }],
      });
      if (!ans) return;
      const name = ans.value.replace(/\s+/g, ' ').trim() || `Chapter ${Number(code.slice(1))}`;
      setLine(addRowsToGroups(plan().selection.groups, rows, 'new', name), `＋ ${code} (${name}) made from ${rowsText(rows).toLowerCase()}`);
    };

    // V0.3.5.57 — take the picked rows OUT of one block (every time they
    // appear in it). A chapter left empty leaves the line, and the note says so.
    const removeFrom = (gi, rows) => {
      const p = plan();
      const g = p.selection.groups[gi];
      if (!lineUsable(p) || !g) return;
      const hit = rows.filter(r => g.rows.includes(r));
      const res = removeRowsFromGroup(p.selection.groups, rows, gi);
      if (!res.removed) return;
      const where = g.code ? `${g.code} (${g.name || g.code})` : 'the import list';
      let msg = `➖ ${rowsText(hit)} taken out of ${where}`;
      if (res.dropped && g.code) msg += ` — it had no rows left, so ${g.code} is gone from the line`;
      if (!res.groups.length) msg += ' — the line is empty now, which means EVERY row is imported';
      setLine(res.groups, msg);
    };

    const copyRows = async (rows) => {
      const text = compressRows(rows);
      let done = false;
      try { await navigator.clipboard.writeText(text); done = true; } catch { /* fall back below */ }
      if (!done) {
        // a textarea INSIDE the dialog — one in the page body can't take focus under the modal
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
        dlg.appendChild(ta);
        ta.select();
        try { done = document.execCommand('copy'); } catch { /* reported below */ }
        ta.remove();
        wrap.focus({ preventScroll: true });
      }
      flash(done ? `📋 Copied: ${short(text)}` : `Could not reach the clipboard — the rows are: ${short(text, 400)}`);
    };

    const openMenu = (x, y) => {
      hideMenu();
      const rows = pickedRows();
      if (!rows.length) return;
      const p = plan();
      const usable = lineUsable(p);
      const fix = usable ? '' : 'Fix the "Rows to import" line first';
      const chapters = p.selection.groups.map((g, gi) => ({ g, gi })).filter(o => o.g.code);
      const what = rows.length === 1 ? `row ${rows[0]}` : `${rows.length} rows`;
      const light = _isLight();
      const chLabel = (g) => `${g.code} ${g.name || ''}`.trim();
      // V0.3.5.57 — Remove entries only where the picked rows actually are
      const holding = usable ? groupsHolding(p.selection.groups, rows) : [];
      const inPlain = holding.find(gi => !p.selection.groups[gi].code);
      const inChapters = holding.filter(gi => p.selection.groups[gi].code);
      const removeItems = [];
      if (inPlain != null) removeItems.push({ label: '➖ Remove from the import list', action: () => removeFrom(inPlain, rows) });
      if (inChapters.length) {
        removeItems.push({ label: '➖ Remove from chapter',
          submenu: inChapters.map(gi => {
            const g = p.selection.groups[gi];
            const n = new Set(rows.filter(r => g.rows.includes(r))).size;
            return { label: `${chLabel(g)}  (${n === 1 ? '1 row' : `${n} rows`})`, color: slotColor(chapterSlot(g), light), action: () => removeFrom(gi, rows) };
          }) });
      }
      menuEl = buildMenu([
        { label: `➕ Add ${what} to the import list`, disabled: !usable, title: fix, action: () => addToList(rows) },
        { label: chapters.length ? '📁 Add to chapter' : '📁 Add to chapter (no chapters in the line yet)',
          disabled: !usable || !chapters.length, title: fix,
          submenu: chapters.map(({ g, gi }) => ({ label: chLabel(g), color: slotColor(chapterSlot(g), light), action: () => addToChapter(gi, rows) })) },
        { label: '＋ New chapter from these rows…', disabled: !usable, title: fix, action: () => newChapter(rows) },
        ...(removeItems.length ? [{ separator: true }, ...removeItems] : []),
        { separator: true },
        { label: '📋 Copy row numbers   Ctrl+C', action: () => copyRows(rows) },
      ]);
      place(menuEl, x, y);
    };

    const rowOf = (e) => e.target.closest('tbody tr[data-xr]');
    // Shift / Ctrl clicks on the rows are the table's: no text selection, and
    // never seen by the app's own click handlers behind the dialog.
    for (const ev of ['pointerdown', 'mousedown']) {
      on(wrap, ev, (e) => {
        if (!rowOf(e)) return;
        e.stopPropagation();
        if (ev === 'mousedown' && (e.shiftKey || e.ctrlKey || e.metaKey)) e.preventDefault();
      });
    }
    on(wrap, 'click', (e) => {
      const tr = rowOf(e);
      if (!tr) return;
      e.stopPropagation();
      hideMenu();
      const xr = Number(tr.dataset.xr);
      const add = e.ctrlKey || e.metaKey;
      if (e.shiftKey && anchor != null) {
        // the shown rows are consecutive Excel rows, so the range is a–b
        const [a, b] = anchor <= xr ? [anchor, xr] : [xr, anchor];
        const span = new Set(add ? picked : []);
        for (let n = a; n <= b; n++) span.add(n);
        picked = span;
      } else if (add) {
        if (picked.has(xr)) picked.delete(xr); else picked.add(xr);
        anchor = xr;
      } else {
        picked = new Set([xr]);
        anchor = xr;
      }
      paintPicks();
      wrap.focus({ preventScroll: true });   // so Ctrl+C lands here, inside the dialog
    });
    on(wrap, 'contextmenu', (e) => {
      const tr = rowOf(e);
      if (!tr) return;
      e.preventDefault();
      e.stopPropagation();
      const xr = Number(tr.dataset.xr);
      if (!picked.has(xr)) { picked = new Set([xr]); anchor = xr; paintPicks(); }
      wrap.focus({ preventScroll: true });
      openMenu(e.clientX, e.clientY);
    });
    on(wrap, 'keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'c' || e.key === 'C') && picked.size) {
        e.preventDefault();
        copyRows(pickedRows());
      }
    });
    on(wrap, 'scroll', hideMenu);
    // a press anywhere else in the dialog closes the menu
    dlg.addEventListener('pointerdown', (e) => {
      if (menuEl && !menuEl.contains(e.target) && !subEl?.contains(e.target)) hideMenu();
    }, { capture: true, signal: ac.signal });

    // keys typed here are the dialog's — never the app's shortcuts behind it
    // (Ctrl+Z, Delete, step keys). Esc still reaches the native 'cancel'.
    const stopKey = (e) => e.stopPropagation();
    on(dlg, 'keydown', stopKey);
    on(dlg, 'keyup', stopKey);

    let closed = false;
    const close = (result) => {
      if (closed) return;
      closed = true;
      askClose?.(null);
      hideMenu();
      ac.abort();
      try { dlg.close(); } catch { /* fine */ }
      dlg.remove();
      resolve(result);
    };
    on(dlg, 'cancel', (e) => {
      e.preventDefault();
      // V0.3.5.56 — Esc closes the innermost thing first: a question, the menu, then the viewer
      if (askClose) { askClose(null); return; }
      if (menuEl) { hideMenu(); return; }
      if (!busy) close(null);
    });
    on($('#sxi-cancel'), 'click', () => { if (!busy) close(null); });

    on(okBtn, 'click', async () => {
      if (busy) return;
      const p = plan();
      if (!p.rows.length || p.blocked) return;
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
        // groups only when the line has chapter codes — otherwise today's call exactly
        res = await importer.importStepsFromSheet(p.groups ? { rows: p.rows, titleColumns, groups: p.groups } : { rows: p.rows, titleColumns });
      } catch (err) {
        console.error('[sheet-import] import failed', err);
        res = { ok: false, reason: err?.message || 'unknown error' };
      }
      busy = false;
      okBtn.textContent = 'Import';
      if (res?.ok) {
        const n = res.created ?? p.rows.length;
        close(res);
        const chap = p.chapters ? ` in ${p.chapters} new chapter${p.chapters === 1 ? '' : 's'}` : '';
        setStatus(`📊 ${n} step${n === 1 ? '' : 's'} created${chap} from ${fileName}${sheets.length > 1 ? ` (${sheets[cur].name})` : ''} — Ctrl+Z undoes the import.`, 'ok', 6000);
      } else {
        // stay open: the user's column choices are worth keeping for a retry
        showError(`Nothing was imported: ${res?.reason || 'unknown reason'}`);
        renderSummary();
      }
    });

    renderAll();
    try { dlg.showModal(); } catch { close(null); }
    if (!closed) fitLine();   // V0.3.5.57 — the box can only measure itself once shown
  });
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
