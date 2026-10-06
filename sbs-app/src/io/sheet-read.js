/**
 * SBS — read ANY spreadsheet a client hands over into plain text rows.
 * ────────────────────────────────────────────────────────────────────────
 * V0.3.5.53 "Steps from Excel": no template — the client's own sheet, so
 * this reader must take whatever Excel / LibreOffice / a web export wrote.
 *
 *   readSheetFile(name, bytes) → { sheets: [{ name, rows: string[][],
 *                                    images: { "<row>,<col>": [{ name, mime, bytes }] },
 *                                    imagesSkipped: number }] }
 *   columnLetter(i)            → 'A' … 'Z', 'AA' …
 *
 * Pictures (V0.3.5.59): row / col are 0-based exactly like rows[row][col]; a
 * picture belongs to the cell under its top-left corner. xlsx floating
 * pictures (drawing anchors, groups too) AND Excel 365 "Place in cell"
 * pictures (vm → metadata → richData chain); .ods <draw:frame> in a cell.
 * emf / wmf / unknown formats, sheet-anchored pictures and chains that don't
 * resolve are counted in imagesSkipped, never thrown. Raw bytes only — the
 * dialog scales them down; nothing here decodes pixels.
 *
 * .xlsx / .xlsm  zip of XML (fflate unzip). Regex over the well-known OOXML
 *                parts, NO DOMParser — so it runs in node tests too.
 * .ods           read here (V0.3.5.56) — io/xlsx.js parseOds folds repeated
 *                blank rows into one, which shifts every row number below a
 *                gap; "Rows to import" needs LibreOffice's own numbers.
 * .csv/.tsv/.txt RFC 4180, delimiter sniffed among , ; tab (Hebrew/European
 *                Excel writes ;), UTF-8 / UTF-16 by BOM, else windows-1255.
 * .xls (binary)  refused with "save it as .xlsx" — not worth a BIFF parser.
 *
 * Rows: every cell as the text Excel shows for a plain value; all rows the
 * same length; trailing empty rows/columns trimmed. LEADING empties stay so
 * column index i is always Excel's column columnLetter(i).
 *
 * Pure: no app state, no DOM.
 */

import { unzipSync } from '../../vendor/fflate.module.js';

/** 0 → A, 25 → Z, 26 → AA (what the user sees in Excel's header). */
export function columnLetter(i) {
  let s = '', n = Math.max(0, Math.floor(i)) + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * @param {string} name   file name (only the extension is used, plus sniffing)
 * @param {Uint8Array} bytes
 * @returns {Promise<{sheets: Array<{name: string, rows: string[][]}>}>}
 */
export async function readSheetFile(name, bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes || []);
  const ext = (String(name || '').split('.').pop() || '').toLowerCase();
  if (!bytes.length) throw new Error('The file is empty.');
  // Sniff before trusting the extension: exporters misname files all the time.
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4B;
  const isOle = bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0;
  if (isOle) {
    // Old .xls AND password-protected .xlsx are both OLE containers.
    throw new Error(ext === 'xls'
      ? 'Old Excel (.xls) files can\'t be read. Open it in Excel and save it as .xlsx (File → Save As → Excel Workbook).'
      : 'This file is password-protected or in an old Excel format. Open it in Excel, remove the password, and save it as .xlsx.');
  }
  if (isZip) return _readZipSheet(bytes, ext);
  if (['xlsx', 'xlsm', 'xltx', 'xltm', 'ods'].includes(ext)) {
    throw new Error('This file looks damaged — it isn\'t a real Excel workbook. Open it in Excel and save it again as .xlsx.');
  }
  return _readTextSheet(bytes, ext, name);
}

// ─── .xlsx ──────────────────────────────────────────────────────────────────

async function _readZipSheet(bytes, ext) {
  let files;
  try { files = unzipSync(bytes); }
  catch (e) { throw new Error('This file looks damaged and can\'t be opened. Open it in Excel and save it again as .xlsx.'); }
  // Case-insensitive part lookup: some generators write "XL/Workbook.xml".
  const lower = new Map(Object.keys(files).map(k => [k.toLowerCase(), k]));
  const part = (p) => { const k = files[p] ? p : lower.get(String(p).replace(/^\//, '').toLowerCase()); return k ? files[k] : null; };
  const text = (p) => { const b = part(p); return b ? _xmlNorm(_utf8(b)) : null; };

  if (part('content.xml') && !part('xl/workbook.xml')) return { sheets: _readOds(_utf8(part('content.xml')), part) };
  // The workbook part is named by the package's root rels (almost always xl/workbook.xml).
  const rootRels = _rels('_rels/.rels', text('_rels/.rels'), '');
  const wbPath = [...rootRels.values()].find(r => /\/officeDocument$/.test(r.type))?.target || 'xl/workbook.xml';
  const wb = text(wbPath);
  if (!wb) throw new Error('This isn\'t an Excel workbook (no sheets inside). Open it in Excel and save it as .xlsx.');
  const wbDir = wbPath.split('/').slice(0, -1).join('/');
  const wbRels = _rels(wbPath, text(`${wbDir}/_rels/${wbPath.split('/').pop()}.rels`), wbDir);
  const relOfType = (re, fallback) => [...wbRels.values()].find(r => re.test(r.type))?.target || fallback;

  const ssXml = text(relOfType(/\/sharedStrings$/, `${wbDir}/sharedStrings.xml`));
  const shared = [];
  // V0.3.5.62 — the self-closing form FIRST, and the attributes never eat its "/": "<si/>" used to swallow the
  // next item, so every shared string after it shifted by one (titles / voiceovers on the wrong steps)
  if (ssXml) for (const m of ssXml.matchAll(/<si\b[^>]*?\/>|<si\b[^>]*?>([\s\S]*?)<\/si>/g)) shared.push(_runsText(m[1] || ''));

  const fmt = _dateStyles(text(relOfType(/\/styles$/, `${wbDir}/styles.xml`)));
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(wb);

  let richImage = null;   // V0.3.5.59: in-cell picture resolver, built on first vm cell
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const tag = m[1];
    const name = _attr(tag, 'name') || `Sheet${sheets.length + 1}`;
    const rel = wbRels.get(_attr(tag, 'r:id') || _attr(tag, 'id') || '');
    // Chart sheets / dialog sheets have no cells — not offered.
    if (rel && !/\/worksheet$/.test(rel.type)) continue;
    const xml = rel ? text(rel.target) : null;
    const vmCells = [];
    let rows = [];
    // V0.3.5.70 — a sheet past the grid bound is carried as an EMPTY sheet with its message, not thrown: the
    // client's small "Steps" tab beside a 100k-row data tab must still import (the dialog shows the message on that tab)
    try { rows = xml ? _parseWorksheet(xml, shared, fmt, date1904, vmCells, name) : []; }
    catch (e) { if (!e?.gridBound) throw e; sheets.push({ name, rows: [], images: {}, imagesSkipped: 0, error: e.message }); continue; }
    const pics = { images: {}, imagesSkipped: 0 };
    // V0.3.5.59: a broken picture part must never cost the user the TEXT of the sheet.
    try {
      if (xml) {
        _xlsxFloatingImages(rel.target, xml, text, part, pics);
        if (vmCells.length) {
          if (!richImage) richImage = _richImageResolver(text, wbDir, wbRels);
          for (const [r, c, vm] of vmCells) {
            const res = richImage(vm);
            if (res === 'not-image') continue;          // a stock / geography data type — not a picture
            const img = res && _imageEntry(res, part);
            if (!img) { pics.imagesSkipped++; continue; }
            _addImage(pics, r, c, img);
            // Excel stores "#VALUE!" as the cached text of an in-cell picture
            // and never shows it — don't let it reach a title / voiceover.
            if (rows[r] && rows[r][c] === '#VALUE!') rows[r][c] = '';
          }
        }
      }
    } catch (e) { console.warn('[sheet-read] pictures skipped:', e); }
    sheets.push({ name, rows: _coverImages(rows, pics.images), images: pics.images, imagesSkipped: pics.imagesSkipped });
  }
  if (!sheets.length) throw new Error('This workbook has no sheets with cells in it.');
  _onlyErrors(sheets);
  return { sheets };
}

/** Target paths of a .rels part, resolved to package paths. */
function _rels(relsPath, xml, baseDir) {
  const map = new Map();
  if (!xml) return map;
  for (const m of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = _attr(m[1], 'Id'), target = _attr(m[1], 'Target'), type = _attr(m[1], 'Type') || '';
    if (!id || !target || _attr(m[1], 'TargetMode') === 'External') continue;
    map.set(id, { target: _resolve(baseDir, target), type });
  }
  return map;
}

function _resolve(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const dir = baseDir ? baseDir.split('/') : [];
  for (const seg of target.split('/')) {
    if (seg === '..') dir.pop();
    else if (seg && seg !== '.') dir.push(seg);
  }
  return dir.join('/');
}

// ─── pictures (V0.3.5.59) ───────────────────────────────────────────────────
// "If it works, it works": every step of every chain is optional; a link that
// doesn't resolve skips THAT picture (counted), never the sheet.

const _join = (dir, name) => (dir ? `${dir}/${name}` : name);
const _dirOf = (p) => String(p).split('/').slice(0, -1).join('/');
const _relsOf = (p) => _join(_join(_dirOf(p), '_rels'), `${String(p).split('/').pop()}.rels`);

function _addImage(pics, r, c, img) {
  const key = `${r},${c}`;
  (pics.images[key] || (pics.images[key] = [])).push(img);
}

/** A zip entry as { name, mime, bytes }, or null (missing / emf / wmf / unknown). */
function _imageEntry(path, part) {
  const bytes = part(path);
  const mime = bytes ? _imageMime(bytes) : null;
  return mime ? { name: String(path).split('/').pop(), mime, bytes } : null;
}

/** By the bytes, not the file name — Office names media freely. Only what a
 *  browser <img> can show; emf / wmf / tiff → null (skipped). */
function _imageMime(b) {
  if (!b || b.length < 4) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
  const head = _utf8(b.subarray(0, 4096));
  if (/^\s*</.test(head) && /<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

// The grid must reach a picture's cell, or the dialog has no column to mark
// "Image" (a picture column usually has no text). Capped: one picture parked
// at row 900,000 must not allocate the empty rows above it.
const _COVER_MAX_ROW = 20000, _COVER_MAX_COL = 1024;

// V0.3.5.62 — ONE stray cell far outside the table (a note typed in column XFD, a value left at row 100000)
// made the reader fill a dense grid all the way to it: gigabytes for a 1 KB file — the renderer died, with the
// open project. A sheet that reaches that far is refused with words the client can act on.
const _GRID_MAX_COLS = 1024, _GRID_MAX_ROWS = 200000, _GRID_MAX_CELLS = 6e6;
function _checkGrid(lastRow, lastCol, name) {
  if (lastCol < _GRID_MAX_COLS && lastRow < _GRID_MAX_ROWS && (lastRow + 1) * (lastCol + 1) <= _GRID_MAX_CELLS) return;
  // V0.3.5.70 — worded for both cases (a stray cell, or a genuinely huge table); the readers keep the sheet, empty, with this
  const err = new Error(`${name ? `Sheet "${name}"` : 'This sheet'} reaches column ${columnLetter(Math.max(0, lastCol))}, row ${lastRow + 1} — too large to import (${_GRID_MAX_COLS} columns / ${_GRID_MAX_ROWS.toLocaleString('en')} rows / ${(_GRID_MAX_CELLS / 1e6)}M cells). If that is one stray cell, delete it in Excel and save the file again.`);
  err.gridBound = true;
  throw err;
}
/** Every sheet refused by the grid bound: nothing to offer, so the first message is the error. */
function _onlyErrors(sheets) {
  if (sheets.length && sheets.every(s => s.error)) throw new Error(sheets[0].error);
}

function _coverImages(rows, images) {
  const width = rows[0]?.length ?? 0;
  let maxR = rows.length - 1, maxC = width - 1;
  for (const key of Object.keys(images)) {
    const [r, c] = key.split(',').map(Number);
    if (!(r <= _COVER_MAX_ROW && c <= _COVER_MAX_COL)) continue;
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  if (maxR < rows.length && maxC < width) return rows;
  if ((maxR + 1) * (maxC + 1) > _GRID_MAX_CELLS) return rows;   // V0.3.5.62 — a far picture never pads the grid past the same budget
  const out = [];
  for (let i = 0; i <= maxR; i++) {
    const o = new Array(maxC + 1).fill('');
    const src = rows[i];
    if (src) for (let c = 0; c < src.length; c++) o[c] = src[c];
    out.push(o);
  }
  return out;
}

/** Floating pictures: sheet rels → drawing → anchors → <pic><blipFill><blip r:embed> → media. */
function _xlsxFloatingImages(sheetPath, sheetXml, text, part, pics) {
  const sheetRels = _rels(null, text(_relsOf(sheetPath)), _dirOf(sheetPath));
  if (!sheetRels.size) return;
  const ids = [...sheetXml.matchAll(/<drawing\b([^>]*?)\/?>/g)].map(m => _attr(m[1], 'r:id')).filter(Boolean);
  const drawings = ids.length
    ? ids.map(id => sheetRels.get(id)).filter(Boolean)
    : [...sheetRels.values()].filter(r => /\/drawing$/.test(r.type));
  for (const d of drawings) {
    let dxml = text(d.target);
    if (!dxml) continue;
    const drels = _rels(null, text(_relsOf(d.target)), _dirOf(d.target));
    // mc:AlternateContent repeats an object in its Fallback — count it once.
    dxml = dxml.replace(/<Fallback\b[\s\S]*?<\/Fallback>/g, '');
    for (const am of dxml.matchAll(/<(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      // <pic> never nests, so this also finds the pictures inside <grpSp> groups.
      const picsIn = [...am[2].matchAll(/<pic\b[^>]*>([\s\S]*?)<\/pic>/g)].map(m => m[1]);
      if (!picsIn.length) continue;   // a chart / shape / text box
      const from = /<from\b[^>]*>([\s\S]*?)<\/from>/.exec(am[2])?.[1] || '';
      const col = parseInt(/<col\b[^>]*>\s*(\d+)\s*<\/col>/.exec(from)?.[1] ?? '', 10);
      const row = parseInt(/<row\b[^>]*>\s*(\d+)\s*<\/row>/.exec(from)?.[1] ?? '', 10);
      if (am[1] === 'absoluteAnchor' || !Number.isFinite(col) || !Number.isFinite(row)) {
        pics.imagesSkipped += picsIn.length;   // no cell to belong to
        continue;
      }
      for (const p of picsIn) {
        const blip = /<blip\b([^>]*?)\/?>/.exec(p)?.[1];
        const target = blip ? drels.get(_attr(blip, 'r:embed') || '')?.target : null;   // r:link (external) → no bytes
        const img = target ? _imageEntry(target, part) : null;
        if (img) _addImage(pics, row, col, img); else pics.imagesSkipped++;
      }
    }
  }
}

/** Excel 365 "Place in cell" pictures:
 *  cell vm (1-based) → metadata.xml valueMetadata bk → rc t (metadataType, 1-based) / v
 *  → futureMetadata[name] bk[v] → rvb i → rdrichvalue.xml rv[i] → its structure's
 *  _rvRel:LocalImageIdentifier value → richValueRel.xml rel[n] r:id → rels → media.
 *  Returns vm → package path | 'not-image' (a data type such as Stocks) | null (broken chain). */
function _richImageResolver(text, wbDir, wbRels) {
  const relOf = (re, name) => [...wbRels.values()].find(r => re.test(r.type))?.target || _join(wbDir, name);
  const bks = (xml) => [...String(xml || '').matchAll(/<bk\b[^>]*?(?:\/>|>([\s\S]*?)<\/bk>)/g)].map(m => m[1] || '');
  const int = (s) => { const n = parseInt(s ?? '', 10); return Number.isFinite(n) ? n : null; };

  const meta = text(relOf(/\/sheetMetadata$/i, 'metadata.xml')) || '';
  const types = [...meta.matchAll(/<metadataType\b([^>]*?)\/?>/g)].map(m => _attr(m[1], 'name') || '');
  const future = new Map();   // futureMetadata name → [rich value index | null]
  for (const fm of meta.matchAll(/<futureMetadata\b([^>]*?)(?:\/>|>([\s\S]*?)<\/futureMetadata>)/g)) {
    future.set(_attr(fm[1], 'name') || '', bks(fm[2]).map(bk => {
      const rvb = /<rvb\b([^>]*?)\/?>/.exec(bk)?.[1];
      return rvb ? int(_attr(rvb, 'i')) : null;
    }));
  }
  const valueMeta = bks(/<valueMetadata\b[^>]*>([\s\S]*?)<\/valueMetadata>/.exec(meta)?.[1]);

  const rvXml = text(relOf(/\/rdRichValue$/i, 'richData/rdrichvalue.xml')) || '';
  const rvs = [...rvXml.matchAll(/<rv\b([^>]*?)(?:\/>|>([\s\S]*?)<\/rv>)/g)].map(m => ({
    s: int(_attr(m[1], 's')) ?? 0,
    vs: [...(m[2] || '').matchAll(/<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/g)].map(x => _unesc(x[1] || '').trim()),
  }));
  const stXml = text(relOf(/\/rdRichValueStructure$/i, 'richData/rdrichvaluestructure.xml')) || '';
  const structs = [...stXml.matchAll(/<s\b([^>]*?)(?:\/>|>([\s\S]*?)<\/s>)/g)].map(m =>
    [...(m[2] || '').matchAll(/<k\b([^>]*?)\/?>/g)].map(k => _attr(k[1], 'n') || ''));
  const relPath = relOf(/\/richValueRel$/i, 'richData/richValueRel.xml');
  const relIds = [...(text(relPath) || '').matchAll(/<rel\b([^>]*?)\/?>/g)].map(m => _attr(m[1], 'r:id') || _attr(m[1], 'id'));
  const relMap = _rels(null, text(_relsOf(relPath)), _dirOf(relPath));

  return (vm) => {
    const rc = /<rc\b([^>]*?)\/?>/.exec(valueMeta[vm - 1] ?? '')?.[1];
    if (!rc) return null;
    const tName = types[(int(_attr(rc, 't')) ?? 0) - 1];
    if (tName && tName !== 'XLRICHVALUE') return 'not-image';
    const list = future.get(tName || 'XLRICHVALUE') || future.get('XLRICHVALUE');
    const rv = rvs[list?.[int(_attr(rc, 'v')) ?? -1] ?? -1];
    if (!rv) return null;
    let k = 0;   // no structures part at all → assume the classic _localImage layout (id first)
    if (structs.length) {
      const keys = structs[rv.s];
      if (!keys) return null;
      k = keys.indexOf('_rvRel:LocalImageIdentifier');
      if (k < 0) return 'not-image';
    }
    const rid = relIds[int(rv.vs[k]) ?? -1];
    return (rid && relMap.get(rid)?.target) || null;
  };
}

/** .ods: <draw:frame> inside the cell (groups too); a frame may carry an SVG
 *  plus a PNG fallback — the first one a browser shows wins. */
function _odsCellImages(inner, part, pics, r, c) {
  for (const fm of inner.matchAll(/<draw:frame\b[^>]*>([\s\S]*?)<\/draw:frame>/g)) {
    const imgs = [...fm[1].matchAll(/<draw:image\b([^>]*?)\/?>/g)];
    if (!imgs.length) continue;   // a text box / chart, not a picture
    let img = null;
    for (const m of imgs) {
      const href = _attr(m[1], 'xlink:href');
      if (!href || /^[a-z][\w+.-]*:/i.test(href)) continue;   // embedded binary-data / external link
      img = _imageEntry(_resolve('', href), part);
      if (img) break;
    }
    if (img) _addImage(pics, r, c, img); else pics.imagesSkipped++;
  }
}

function _parseWorksheet(xml, shared, fmt, date1904, vmOut, name = '') {
  const data = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1] || '';
  // Sparse first: a styled-but-empty row 1048576 must not allocate a million rows.
  const found = [];   // [rowIndex, [[colIndex, text]]]
  let lastRow = -1, lastCol = -1, nextRow = 0;
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;
  while ((rm = rowRe.exec(data))) {
    const rAttr = parseInt(_attr(rm[1], 'r') || '', 10);
    const r = Number.isFinite(rAttr) && rAttr > 0 ? rAttr - 1 : nextRow;
    nextRow = r + 1;
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm, autoCol = 0;
    while ((cm = cellRe.exec(rm[2] || ''))) {
      const tag = cm[1], inner = cm[2] || '';
      const ref = _attr(tag, 'r');
      const col = ref ? _colIndex(ref) : autoCol;
      if (col < 0) continue;
      autoCol = col + 1;
      // V0.3.5.59: vm = value metadata → maybe an Excel 365 in-cell picture.
      const vm = vmOut ? parseInt(_attr(tag, 'vm') || '', 10) : NaN;
      if (vm > 0) vmOut.push([r, col, vm]);
      const v = _cellValue(_attr(tag, 't'), inner, fmt[parseInt(_attr(tag, 's') || '0', 10)], date1904, shared);
      if (v.trim() === '') continue;
      cells.push([col, v]);
      if (col > lastCol) lastCol = col;
    }
    if (cells.length) { found.push([r, cells]); if (r > lastRow) lastRow = r; }
  }
  _checkGrid(lastRow, lastCol, name);
  const rows = [];
  for (let i = 0; i <= lastRow; i++) rows.push(new Array(lastCol + 1).fill(''));
  for (const [r, cells] of found) for (const [c, v] of cells) rows[r][c] = v;
  return rows;
}

// ─── .ods (V0.3.5.56) ───────────────────────────────────────────────────────
// Same sparse idea as _parseWorksheet: repeated rows / cells ADVANCE the
// row / column counter (so row numbers match LibreOffice's), but only cells
// with text are stored — the 1,048,000-row blank tail costs nothing.

const _ODS_MAX_REPEAT = 1000;   // a non-empty row / cell repeated more is a styling accident

function _readOds(xml, part) {
  xml = xml.replace(/\r\n?/g, '\n');
  const sheets = [];
  for (const tm of xml.matchAll(/<table:table(?=[\s>\/])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table>)/g)) {
    const name = _attr(tm[1], 'table:name') || `Sheet${sheets.length + 1}`;
    const pics = { images: {}, imagesSkipped: 0 };
    // V0.3.5.59: pictures anchored to the PAGE (not a cell) live in <table:shapes> — no row to give them.
    const shapes = /<table:shapes\b[^>]*>([\s\S]*?)<\/table:shapes>/.exec(tm[2] || '')?.[1] || '';
    for (const fm of shapes.matchAll(/<draw:frame\b[^>]*>([\s\S]*?)<\/draw:frame>/g)) {
      if (/<draw:image\b/.test(fm[1])) pics.imagesSkipped++;
    }
    const found = [];   // [rowIndex, [[colIndex, text]]]
    let r = 0, lastRow = -1, lastCol = -1;
    for (const rm of (tm[2] || '').matchAll(/<table:table-row(?=[\s>\/])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)) {
      const rep = _odsRepeat(rm[1], 'table:number-rows-repeated');
      const cells = [];
      let c = 0;
      for (const cm of (rm[2] || '').matchAll(/<table:(table-cell|covered-table-cell)(?=[\s>\/])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:\1>)/g)) {
        const crep = _odsRepeat(cm[2], 'table:number-columns-repeated');
        if (cm[3] && cm[3].includes('<draw:')) {
          try { _odsCellImages(cm[3], part, pics, r, c); }
          catch (e) { console.warn('[sheet-read] ods picture skipped:', e); pics.imagesSkipped++; }
        }
        // a merged cell's hidden part (covered-table-cell) still takes its column
        const v = cm[1] === 'table-cell' ? _odsCell(cm[2], cm[3] || '') : '';
        if (v.trim() !== '') {
          const n = Math.min(crep, _ODS_MAX_REPEAT);
          for (let k = 0; k < n; k++) cells.push([c + k, v]);
          lastCol = Math.max(lastCol, c + n - 1);
        }
        c += crep;
      }
      if (cells.length) {
        const n = Math.min(rep, _ODS_MAX_REPEAT);
        for (let k = 0; k < n; k++) found.push([r + k, cells]);
        lastRow = Math.max(lastRow, r + n - 1);
      }
      r += rep;
    }
    try { _checkGrid(lastRow, lastCol, name); }
    catch (e) { if (!e?.gridBound) throw e; sheets.push({ name, rows: [], images: {}, imagesSkipped: 0, error: e.message }); continue; }   // V0.3.5.70
    const rows = [];
    for (let i = 0; i <= lastRow; i++) rows.push(new Array(lastCol + 1).fill(''));
    for (const [ri, cells] of found) for (const [ci, v] of cells) rows[ri][ci] = v;
    sheets.push({ name, rows: _coverImages(rows, pics.images), images: pics.images, imagesSkipped: pics.imagesSkipped });
  }
  if (!sheets.length) throw new Error('This spreadsheet has no sheets with cells in it.');
  _onlyErrors(sheets);
  return sheets;
}

function _odsRepeat(tag, attr) {
  const n = parseInt(_attr(tag, attr) || '1', 10);
  return Number.isFinite(n) && n > 1 ? n : 1;
}

/** The text LibreOffice shows: its paragraphs, one per line; a comment
 *  (office:annotation) is not cell content. */
function _odsCell(tag, inner) {
  const body = inner.replace(/<office:annotation\b[\s\S]*?<\/office:annotation>/g, '')
    // V0.3.5.59: a picture / shape in the cell carries its own (empty) <text:p/> —
    // it isn't cell text and would add stray line breaks.
    .replace(/<draw:frame\b[\s\S]*?<\/draw:frame>/g, '')
    .replace(/<draw:g\b[\s\S]*?<\/draw:g>/g, '');
  const paras = [...body.matchAll(/<text:(p|h)\b[^>]*?(?:\/>|>([\s\S]*?)<\/text:\1>)/g)].map(m => _odsText(m[2] || ''));
  if (paras.length) return _cellText(paras.join('\n'));
  return _attr(tag, 'office:string-value') ?? _attr(tag, 'office:value') ?? '';
}

function _odsText(p) {
  return _unesc(String(p)
    .replace(/<text:line-break\s*\/>/g, '\n')
    .replace(/<text:tab\s*\/>/g, '\t')
    .replace(/<text:s\b([^>]*?)\/>/g, (m, a) => ' '.repeat(Math.max(1, parseInt(_attr(a, 'text:c') || '1', 10) || 1)))
    .replace(/<[^>]+>/g, ''));
}

function _cellValue(t, inner, dateKind, date1904, shared) {
  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
  switch (t) {
    case 's':         return _cellText(shared[parseInt(v ?? '-1', 10)] ?? '');
    case 'inlineStr': return _cellText(_runsText(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1] || ''));
    case 'b':         return v == null ? '' : (v.trim() === '1' || v.trim() === 'true' ? 'TRUE' : 'FALSE');
    case 'str':
    case 'e':         return v == null ? '' : _cellText(_unesc(v));
    case 'd':         return v == null ? '' : _unesc(v).replace(/T00:00(:00)?(\.0+)?Z?$/, '');
    default: {        // 'n' or none: a number, maybe shown as a date by its style
      if (v == null) return '';
      const s = _unesc(v).trim();
      const n = Number(s);
      if (s === '' || !Number.isFinite(n)) return s;
      return dateKind ? _serialText(n, dateKind, date1904) : _numText(n);
    }
  }
}

/** Excel shows at most 15 significant digits: 0.30000000000000004 → "0.3". */
function _numText(n) {
  if (Object.is(n, -0)) return '0';
  return String(Number(n.toPrecision(15))).replace('e+', 'E+').replace('e-', 'E-');
}

// ─── dates (style-driven) ───────────────────────────────────────────────────
// A date in a cell is just a serial number; only its number format says
// "date". Shown as ISO (2026-10-05 / 14:30) — locale formats like 05/10/26
// are ambiguous between day-first and month-first clients.

const _BUILTIN_DATE = {
  14: 'date', 15: 'date', 16: 'date', 17: 'date', 22: 'datetime',
  18: 'time', 19: 'timesec', 20: 'time', 21: 'timesec', 45: 'timesec', 46: 'elapsed', 47: 'timesec',
};
for (const id of [27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]) _BUILTIN_DATE[id] = 'date';
for (const id of [32, 33, 55, 56]) _BUILTIN_DATE[id] = 'timesec';

/** cellXfs index → date kind (or undefined for plain numbers). */
function _dateStyles(xml) {
  const out = [];
  if (!xml) return out;
  const custom = {};
  for (const m of xml.matchAll(/<numFmt\b([^>]*?)\/?>/g)) {
    const id = parseInt(_attr(m[1], 'numFmtId') || '', 10);
    if (Number.isFinite(id)) custom[id] = _classifyFormat(_attr(m[1], 'formatCode') || '');
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] || '';
  for (const m of xfs.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const id = parseInt(_attr(m[1], 'numFmtId') || '0', 10);
    out.push(id in custom ? custom[id] : _BUILTIN_DATE[id]);
  }
  return out;
}

function _classifyFormat(code) {
  let s = String(code).split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/)[0];   // first section only
  s = s.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/[_*]./g, '');
  if (/\[(h+|m+|s+)\]/i.test(s)) return 'elapsed';
  s = s.replace(/\[[^\]]*\]/g, '');                                // colours, [$-409] locales
  if (/general/i.test(s)) s = s.replace(/general/gi, '');
  const date = /[yd]/i.test(s), time = /[hs]/i.test(s);
  if (date && time) return 'datetime';
  if (date) return 'date';
  if (time) return /s/i.test(s) ? 'timesec' : 'time';
  return undefined;
}

function _serialText(n, kind, date1904) {
  const p2 = (x) => String(x).padStart(2, '0');
  const totalSec = Math.round(n * 86400);
  if (kind === 'elapsed') {
    const neg = totalSec < 0, a = Math.abs(totalSec);
    return `${neg ? '-' : ''}${Math.floor(a / 3600)}:${p2(Math.floor(a / 60) % 60)}:${p2(a % 60)}`;
  }
  if (n < 0) return _numText(n);   // Excel shows ##### for negative dates
  // 1900 system: day 1 = 1900-01-01, and Excel's fake 1900-02-29 (serial 60) is skipped.
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const dayShift = (!date1904 && n < 60) ? 1 : 0;
  const d = new Date(epoch + (totalSec + dayShift * 86400) * 1000);
  const datePart = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  const hm = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  const sec = d.getUTCSeconds();
  if (kind === 'date') return datePart;
  if (kind === 'time') return hm;
  if (kind === 'timesec') return `${hm}:${p2(sec)}`;
  return `${datePart} ${hm}${sec ? ':' + p2(sec) : ''}`;   // datetime
}

// ─── XML helpers ────────────────────────────────────────────────────────────

const _utf8Dec = new TextDecoder('utf-8');   // strips a UTF-8 BOM by itself
const _utf8 = (b) => _utf8Dec.decode(b);

/** Drop namespace prefixes on tag names (<x:c> → <c>; Open XML SDK writes them)
 *  and normalise line ends the way an XML parser does. */
function _xmlNorm(xml) {
  return xml.replace(/\r\n?/g, '\n').replace(/<(\/?)[A-Za-z_][\w.-]*:(?=[A-Za-z_])/g, '<$1');
}

function _unesc(s) {
  return String(s ?? '').replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return ''; }
    }
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e];
  });
}

const _attr = (tag, name) => {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\s)${esc}\\s*=\\s*"([^"]*)"`).exec(tag) || new RegExp(`(?:^|\\s)${esc}\\s*=\\s*'([^']*)'`).exec(tag);
  return m ? _unesc(m[1]) : null;
};

/** Every <t> of a string item, concatenated (rich runs → one string); the
 *  phonetic guides (<rPh>, East-Asian ruby) are never cell content. Whitespace
 *  is kept verbatim — Excel marks it xml:space="preserve", and a parser keeps
 *  text whitespace either way. */
function _runsText(fragment) {
  const body = String(fragment || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  // (V0.3.5.62 — a self-closing <t .../> is an empty run, not the start of one: raw XML leaked into the text)
  for (const m of body.matchAll(/<t\b[^>]*?\/>|<t\b(?:\s[^>]*?)?>([\s\S]*?)<\/t>/g)) out += _unesc(m[1] || '');
  // OOXML escapes control chars as _xHHHH_ (Excel's line break = _x000D_\n).
  return out.replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

/** One line-break convention for everything that reaches a voiceover. */
const _cellText = (s) => String(s ?? '').replace(/\r\n?/g, '\n');

function _colIndex(ref) {   // "AB12" → 27
  const m = /^\$?([A-Za-z]{1,3})/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Pad to one width; trim trailing empty rows and columns (leading stay). */
function _finish(rows) {
  let lastRow = -1, lastCol = -1;
  rows.forEach((r, i) => r.forEach((v, c) => {
    if (String(v).trim() !== '') { if (i > lastRow) lastRow = i; if (c > lastCol) lastCol = c; }
  }));
  const out = [];
  for (let i = 0; i <= lastRow; i++) {
    const r = rows[i] || [];
    const o = new Array(lastCol + 1);
    for (let c = 0; c <= lastCol; c++) o[c] = r[c] == null ? '' : String(r[c]);
    out.push(o);
  }
  return out;
}

// ─── .csv / .tsv / .txt ─────────────────────────────────────────────────────

function _readTextSheet(bytes, ext, fileName) {
  const text = _decodeText(bytes);
  if (/^\s*</.test(text.slice(0, 512))) {
    // Web systems' "Excel export" is often an HTML table or XML Spreadsheet 2003.
    throw new Error('This file is a web page / XML export, not a real spreadsheet. Open it in Excel and save it as .xlsx.');
  }
  let body = text;
  // Excel's own "sep=;" first line names the delimiter (and isn't data).
  let delim = null;
  const sep = /^sep=(.)\r?\n/i.exec(body);
  if (sep) { delim = sep[1]; body = body.slice(sep[0].length); }
  if (!delim) delim = _sniffDelimiter(body, ext);
  const rows = _parseDelimited(body, delim).map(r => r.map(_cellText));
  // A text table has one sheet; name it after the file, like Excel's tab does.
  const base = String(fileName || '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '').trim();
  return { sheets: [{ name: base || 'Sheet1', rows: _finish(rows), images: {}, imagesSkipped: 0 }] };
}

function _decodeText(bytes) {
  // UTF-16 by BOM: Excel's "Unicode Text (*.txt)" — the safe way to save Hebrew.
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const probe = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (probe.includes(0)) throw new Error('This file isn\'t a spreadsheet or text table. Save it from Excel as .xlsx or .csv.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }   // BOM stripped by default
  catch {
    // Not valid UTF-8 → Hebrew Excel's "CSV (Comma delimited)" is windows-1255.
    try { return new TextDecoder('windows-1255').decode(bytes); }
    catch { return new TextDecoder('latin1').decode(bytes); }
  }
}

/** The candidate that splits the first lines into the most consistent >1 fields. */
function _sniffDelimiter(text, ext) {
  const order = ext === 'tsv' || ext === 'txt' ? ['\t', ';', ','] : [',', ';', '\t'];
  const sample = _logicalLines(text.slice(0, 65536), 30);
  if (!sample.length) return order[0];
  let best = order[0], bestScore = -1;
  for (const d of order) {
    const counts = sample.map(line => _parseDelimited(line, d, 1)[0]?.length || 1);
    const freq = new Map();
    for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
    let mode = 1, modeN = 0;
    for (const [c, k] of freq) if (c > 1 && (k > modeN || (k === modeN && c > mode))) { mode = c; modeN = k; }
    const score = mode > 1 ? modeN * 1000 + mode : 0;
    if (score > bestScore) { best = d; bestScore = score; }   // strict > keeps `order` as tie-break
  }
  return bestScore > 0 ? best : order[0];
}

/** Raw record texts (quotes kept) — a quoted line break doesn't end a record. */
function _logicalLines(text, max) {
  const out = [];
  let start = 0, inQ = false;
  for (let i = 0; i < text.length && out.length < max; i++) {
    const ch = text[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && (ch === '\n' || ch === '\r')) {
      if (i > start) out.push(text.slice(start, i));
      if (ch === '\r' && text[i + 1] === '\n') i++;
      start = i + 1;
    }
  }
  if (out.length < max && start < text.length) out.push(text.slice(start));
  return out.filter(l => l.trim() !== '');
}

/** RFC 4180: "" escapes a quote, quoted fields may hold delimiters and line
 *  breaks; CRLF / LF / CR all end a record. A quote mid-field is literal. */
function _parseDelimited(text, delim, maxRows = Infinity) {
  const rows = [];
  let row = [], field = '', i = 0, quoted = false, fieldStart = true;
  const n = text.length;
  const endField = () => { row.push(field); field = ''; fieldStart = true; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < n && rows.length < maxRows) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && fieldStart) { quoted = true; fieldStart = false; i++; continue; }
    if (ch === delim) { endField(); i++; continue; }
    if (ch === '\r' || ch === '\n') {
      endRow();
      i += (ch === '\r' && text[i + 1] === '\n') ? 2 : 1;
      continue;
    }
    field += ch; fieldStart = false; i++;
  }
  if (rows.length < maxRows && (field !== '' || row.length || !fieldStart)) endRow();
  return rows;
}
