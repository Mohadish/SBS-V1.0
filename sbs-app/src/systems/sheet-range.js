/**
 * SBS — 📊 Steps from Excel: the "Rows to import" line (V0.3.5.54)
 * ================================================================
 * "I type 1-8, 56, 23-38 like the export's frame range and see the rows
 * chosen at once — and C01(Arrange the parts)5-15,54-56, C02(Clean parts)…
 * makes a chapter per code, holding exactly those rows in that order."
 *
 *   • numbers are EXCEL'S OWN row numbers (the viewer's # column);
 *   • the order typed IS the import order — 15-5 runs backwards, a row typed
 *     twice becomes two separate steps;
 *   • C<number>(<name>) opens a NEW chapter named <name>; the number is only a
 *     label (two chapters may share a name). Everything after it, up to the
 *     next code, belongs to it. Rows before the first code are a plain block.
 *
 * Pure — no app state, no DOM. Node test: E:/claude-temp/xl-range-test.mjs
 */

// A typed range is bounded by the sheet, but "1-60000" pasted ten times
// would still build a huge list on every keystroke — say so instead.
export const MAX_SELECTED_ROWS = 20000;

const MAX_ERRORS = 6;

const _isSep   = (ch) => ch === ',' || ch === ';' || /\s/.test(ch);
const _isDash  = (ch) => ch === '-' || ch === '\u2013' || ch === '\u2014';
const _isDigit = (ch) => ch >= '0' && ch <= '9';

/**
 * @param {string} text  what the user typed
 * @param {{ firstRow:number, lastRow:number }} bounds  lowest importable Excel
 *        row (2 with a header row, else 1) and the sheet's last Excel row
 * @returns {{ empty:boolean, ok:boolean,
 *             groups:{code:string|null, name:string|null, rows:number[]}[],
 *             errors:string[], warnings:string[] }}
 */
export function parseRowSelection(text, { firstRow = 1, lastRow = Infinity } = {}) {
  const src = String(text ?? '');
  const out = { empty: false, ok: true, groups: [], errors: [], warnings: [] };
  if (!src.replace(/[\s,;]+/g, '')) { out.empty = true; return out; }   // only separators = nothing typed

  const errs = new Set();
  const err = (m) => errs.add(m);
  let cur = null;          // the group rows go into
  let total = 0;
  let capHit = false;
  const quiet = new Set();     // chapters already reported
  const len = src.length;
  let i = 0;

  const groupForRows = () => {
    if (!cur) { cur = { code: null, name: null, rows: [] }; out.groups.push(cur); }
    return cur;
  };
  const rowError = (n) => {
    if (n < 1) return `Row ${n} doesn't exist — rows start at 1`;
    if (n < firstRow) return firstRow === 2
      ? `Row ${n} holds the column names, so it can't be a step — untick "First row is column names" to import it`
      : `Row ${n} is before the first row that can be imported (row ${firstRow})`;
    if (n > lastRow) return `Row ${n} is past the end of the sheet (last row ${lastRow})`;
    return null;
  };
  const pushRows = (a, b) => {
    const g = groupForRows();
    const step = a <= b ? 1 : -1;
    const count = Math.abs(b - a) + 1;
    if (total + count > MAX_SELECTED_ROWS) {
      if (!capHit) err(`That chooses more than ${MAX_SELECTED_ROWS} rows — use shorter ranges`);
      capHit = true;
      return;
    }
    total += count;
    for (let n = a; ; n += step) { g.rows.push(n); if (n === b) break; }
  };
  // the next C01( / c1( / C( … starts a chapter code
  const codeAhead = (k) => {
    if (src[k] !== 'c' && src[k] !== 'C') return false;
    let j = k + 1;
    if (_isDigit(src[j] || '')) return true;
    while (j < len && /\s/.test(src[j])) j++;
    return src[j] === '(';
  };
  // a token that is none of the above: skip it whole (a bracket runs to its
  // closing one) and name it in plain words
  const garbage = (start) => {
    let j = start, depth = 0;
    while (j < len) {
      const ch = src[j];
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0 && _isSep(ch)) break;
      j++;
    }
    const tok = src.slice(start, j);
    err(`"${tok.length > 24 ? tok.slice(0, 24) + '…' : tok}" is not a row number, a range like 5-15, or a chapter code like C01(Name)`);
    return j;
  };
  const readInt = (k) => {
    let j = k;
    while (j < len && _isDigit(src[j])) j++;
    return { n: Number(src.slice(k, j)), end: j };
  };
  // a number must end at a separator, a dash, the end, or a stuck-on code ("5-15C02(…)")
  const cleanEnd = (k) => k >= len || _isSep(src[k]) || _isDash(src[k]) || codeAhead(k);

  while (i < len) {
    const ch = src[i];
    if (_isSep(ch)) { i++; continue; }

    if (codeAhead(i)) {
      const start = i;
      i++;
      const { end } = readInt(i);
      const hasNum = end > i;
      const code = hasNum ? `C${src.slice(i, end)}` : 'C?';
      i = end;
      let k = i;
      while (k < len && /\s/.test(src[k])) k++;
      let name = null, unclosed = false;
      if (src[k] === '(') {
        let depth = 0, j = k;
        for (; j < len; j++) {
          if (src[j] === '(') depth++;
          else if (src[j] === ')' && --depth === 0) break;
        }
        if (j >= len) {
          err(`${code}: the chapter name needs a closing )`);
          unclosed = true;
          name = src.slice(k + 1).replace(/\s+/g, ' ').trim();
          i = len;
        } else {
          name = src.slice(k + 1, j).replace(/\s+/g, ' ').trim();
          i = j + 1;
          if (!name) err(`${code}: the chapter name is empty — e.g. ${code}(Clean parts)`);
        }
      } else {
        err(`${code} needs a chapter name in brackets right after it, e.g. ${code}(Clean parts)`);
      }
      if (!hasNum) err(`"${src.slice(start, Math.min(i, start + 24))}" needs a number after the C, e.g. C01(Name)`);
      cur = { code, name: name || null, rows: [] };
      out.groups.push(cur);
      if (unclosed) quiet.add(cur);   // its rows sit inside the open name — one error is enough
      continue;
    }

    if (_isDigit(ch)) {
      const start = i;
      const a = readInt(i);
      if (!cleanEnd(a.end)) { i = garbage(start); continue; }
      // a range? "5-15", "5 - 15", "15–5"
      let k = a.end;
      while (k < len && /\s/.test(src[k])) k++;
      if (k < len && _isDash(src[k])) {
        k++;
        while (k < len && /\s/.test(src[k])) k++;
        if (k >= len || !_isDigit(src[k])) {
          err(`"${a.n}-" needs an end row, e.g. ${a.n}-${a.n + 10}`);
          i = k;
          continue;
        }
        const b = readInt(k);
        if (!cleanEnd(b.end) || (b.end < len && _isDash(src[b.end]))) { i = garbage(start); continue; }
        i = b.end;
        const ea = rowError(a.n), eb = rowError(b.n);
        if (ea) err(ea);
        if (eb) err(eb);
        if (!ea && !eb) pushRows(a.n, b.n);
        continue;
      }
      i = a.end;
      const e = rowError(a.n);
      if (e) err(e); else pushRows(a.n, a.n);
      continue;
    }

    i = garbage(i);
  }

  for (const g of out.groups) {
    if (g.code && !g.rows.length && !quiet.has(g)) {
      err(`${g.code}${g.name ? ` (${g.name})` : ''} has no rows — add them after it, e.g. ${g.code}(${g.name || 'Name'})5-15`);
    }
  }

  // Duplicates are allowed (one row → two steps) — say it, so it is a choice.
  const seen = new Map();
  for (const g of out.groups) for (const r of g.rows) seen.set(r, (seen.get(r) || 0) + 1);
  const dup = [...seen].filter(([, c]) => c > 1);
  if (dup.length === 1) out.warnings.push(`Row ${dup[0][0]} is chosen ${dup[0][1]} times — each time becomes its own step`);
  else if (dup.length > 1) out.warnings.push(`${dup.length} rows are chosen more than once — each time becomes its own step`);

  const list = [...errs];
  out.errors = list.length > MAX_ERRORS
    ? [...list.slice(0, MAX_ERRORS), `…and ${list.length - MAX_ERRORS} more`]
    : list;
  out.ok = out.errors.length === 0;
  return out;
}
