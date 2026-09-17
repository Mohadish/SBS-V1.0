/**
 * SBS — minimal .xlsx writer + reader, NO dependencies (enterprise SBOM).
 * ────────────────────────────────────────────────────────────────────────
 * An .xlsx is a zip of XML parts. Both directions are hand-rolled here:
 *   • zip     — local headers + central directory, DEFLATE via the platform
 *               CompressionStream('deflate-raw') (Chromium and Node ≥ 21).
 *   • OOXML   — workbook / worksheets (inline strings), styles (locked vs
 *               unlocked, wrap), sheet protection, frozen header, hidden
 *               columns / sheets, one drawing per sheet for row previews.
 *
 * The READER is deliberately wider than the writer: Excel re-saves with a
 * shared-string table, rich-text runs, sparse rows, formulas — all handled.
 * Only string cell values come back (numbers / booleans as their text).
 *
 * Pure: no app imports, runs in the renderer and in node tests.
 */

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

// ─── zip ────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function _pump(stream, bytes) {
  const w = stream.writable.getWriter();
  w.write(bytes);
  w.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}
const deflateRaw = (bytes) => _pump(new CompressionStream('deflate-raw'), bytes);
const inflateRaw = (bytes) => _pump(new DecompressionStream('deflate-raw'), bytes);

function _concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function _dosStamp(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** @param {Array<{name:string, data:Uint8Array}>} files */
export async function buildZip(files) {
  const { time, date } = _dosStamp();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc  = crc32(f.data);
    const comp = await deflateRaw(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 8, true);
    lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, comp.length, true); lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    local.set(name, 30);
    parts.push(local, comp);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 8, true);
    cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, comp.length, true); cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + comp.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  return _concat([...parts, ...central, eocd]);
}

/** @returns {Promise<Map<string, Uint8Array>>} name → bytes */
export async function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip / xlsx file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged zip directory');
    const method = dv.getUint16(p + 10, true);
    const csize  = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho  = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const comp = bytes.subarray(start, start + csize);
    let data;
    if (method === 0) data = comp;
    else if (method === 8) data = await inflateRaw(comp);
    else throw new Error(`Unsupported zip compression (${method})`);
    files.set(name, data);
    p += 46 + nlen + elen + clen;
  }
  return files;
}

// ─── XML helpers ────────────────────────────────────────────────────────────

const _xmlEsc = (s) => String(s ?? '')
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function _xmlUnesc(s) {
  return String(s ?? '').replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e];
  });
}

const _attr = (tag, name) => {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag) || new RegExp(`(?:^|\\s)${name}='([^']*)'`).exec(tag);
  return m ? _xmlUnesc(m[1]) : null;
};

/** Every <t> inside a fragment, concatenated (rich runs → one string). */
function _textOf(fragment) {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  // Drop phonetic guides (<rPh>) — East-Asian ruby text, never cell content.
  const body = String(fragment || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  while ((m = re.exec(body))) out += _xmlUnesc(m[1]);
  return out;
}

export function colLetter(idx) {   // 0 → A, 25 → Z, 26 → AA
  let s = '', n = idx + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export function colIndex(ref) {    // "AB12" → 27
  const m = /^([A-Z]+)/i.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ─── writer ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SheetSpec
 * @property {string}   name            ≤ 31 chars, no []:*?/\
 * @property {boolean}  [hidden]
 * @property {string[]} header          row 1 (bold)
 * @property {Array<Array<string|number|null>>} rows
 * @property {Array<{width?:number, hidden?:boolean}>} [cols]   per column (Excel width units ≈ characters)
 * @property {number[]} [unlockedCols]  0-based columns the user may edit when the sheet is protected
 * @property {number[]} [wrapCols]      0-based columns with wrapped text, top-aligned
 * @property {boolean}  [protect]       lock every cell except unlockedCols (no password)
 * @property {boolean}  [freezeHeader]
 * @property {boolean}  [autoFilter]
 * @property {Object<number, number>} [rowHeights]   1-based sheet row → height in points
 * @property {Array<{row:number, col:number, dataUrl:string, wPx:number, hPx:number}>} [images]  row = 0-based DATA row
 */

/**
 * @param {{sheets: SheetSpec[]}} spec
 * @returns {Promise<Uint8Array>} the .xlsx bytes
 */
export async function buildXlsx(spec) {
  const sheets = spec.sheets || [];
  if (!sheets.length) throw new Error('buildXlsx: no sheets');
  const files = [];
  const overrides = [];
  const media = [];   // { name, data }
  const mediaByUrl = new Map();   // dataUrl → media part name (the same preview on several sheets = ONE part)
  let imageNo = 0;

  const workbookSheets = sheets.map((s, i) =>
    `<sheet name="${_xmlEsc(_sheetName(s.name))}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('');
  const workbookRels = sheets.map((s, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;

  files.push({ name: 'xl/workbook.xml', data: enc.encode(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="14000"/></bookViews>`
    + `<sheets>${workbookSheets}</sheets></workbook>`) });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: enc.encode(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRels}</Relationships>`) });
  files.push({ name: 'xl/styles.xml', data: enc.encode(STYLES_XML) });
  overrides.push('/xl/workbook.xml|application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml');
  overrides.push('/xl/styles.xml|application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml');

  sheets.forEach((s, i) => {
    const n = i + 1;
    const unlocked = new Set(s.unlockedCols || []);
    const wrap     = new Set(s.wrapCols || []);
    const styleFor = (c, isHeader) => isHeader ? 1 : (wrap.has(c) ? (unlocked.has(c) ? 3 : 2) : (unlocked.has(c) ? 4 : 0));
    const cell = (r, c, v, isHeader) => {
      // An EMPTY cell in an unlocked column must still exist, carrying the
      // unlocked style — otherwise it inherits the sheet default (locked)
      // and the reviewer cannot type into the very cells meant for them
      // (LibreOffice / OpenOffice showed exactly that, V0.3.3.9).
      if (v == null || v === '') return (!isHeader && unlocked.has(c)) ? `<c r="${colLetter(c)}${r}" s="${styleFor(c, false)}"/>` : '';
      return `<c r="${colLetter(c)}${r}" s="${styleFor(c, isHeader)}" t="inlineStr"><is><t xml:space="preserve">${_xmlEsc(v)}</t></is></c>`;
    };
    const rowsXml = [];
    const hdr = s.header || [];
    rowsXml.push(`<row r="1">${hdr.map((v, c) => cell(1, c, v, true)).join('')}</row>`);
    (s.rows || []).forEach((row, ri) => {
      const r = ri + 2;
      const ht = s.rowHeights?.[r];
      rowsXml.push(`<row r="${r}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${(row || []).map((v, c) => cell(r, c, v, false)).join('')}</row>`);
    });
    // Column default style: cells the reviewer ADDS below our rows (or that a
    // re-save materialises) in an unlocked column stay unlocked too.
    const colsXml = (s.cols || []).length
      ? `<cols>${s.cols.map((c, ci) => `<col min="${ci + 1}" max="${ci + 1}" width="${c.width || 10}" customWidth="1"${c.hidden ? ' hidden="1"' : ''}${unlocked.has(ci) ? ` style="${styleFor(ci, false)}"` : ''}/>`).join('')}</cols>`
      : '';
    const lastCol = Math.max(hdr.length, ...(s.rows || []).map(r => (r || []).length), 1);
    const lastRow = (s.rows || []).length + 1;
    const dim = `A1:${colLetter(lastCol - 1)}${lastRow}`;
    const views = `<sheetViews><sheetView workbookViewId="0"${i === 0 ? ' tabSelected="1"' : ''}>`
      + (s.freezeHeader ? `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` : '')
      + `</sheetView></sheetViews>`;
    const protection = s.protect
      ? `<sheetProtection sheet="1" objects="1" scenarios="1" sort="0" autoFilter="0" formatRows="0" formatColumns="0"/>`
      : '';
    const filter = s.autoFilter ? `<autoFilter ref="${dim}"/>` : '';

    // Row previews → one drawing part per sheet.
    let drawingXml = '', drawingRels = '', drawingRef = '';
    const imgs = (s.images || []).filter(im => im && im.dataUrl);
    if (imgs.length) {
      const anchors = imgs.map((im, k) => {
        const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(im.dataUrl);
        if (!m) return '';
        let part = mediaByUrl.get(im.dataUrl);
        if (!part) {
          imageNo++;
          const ext = m[1].toLowerCase() === 'png' ? 'png' : 'jpeg';
          part = `xl/media/image${imageNo}.${ext}`;
          media.push({ name: part, data: _b64ToBytes(m[2]) });
          mediaByUrl.set(im.dataUrl, part);
        }
        const rid = `rId${k + 1}`;
        drawingRels += `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../${part.slice(3)}"/>`;
        const cx = Math.round((im.wPx || 300) * 9525), cy = Math.round((im.hPx || 169) * 9525);
        return `<xdr:oneCellAnchor><xdr:from><xdr:col>${im.col}</xdr:col><xdr:colOff>19050</xdr:colOff><xdr:row>${im.row + 1}</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:from>`
          + `<xdr:ext cx="${cx}" cy="${cy}"/>`
          + `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${k + 2}" name="Preview ${k + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
          + `<xdr:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
          + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`
          + `<xdr:clientData/></xdr:oneCellAnchor>`;
      }).join('');
      drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`;
      files.push({ name: `xl/drawings/drawing${n}.xml`, data: enc.encode(drawingXml) });
      files.push({ name: `xl/drawings/_rels/drawing${n}.xml.rels`, data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRels}</Relationships>`) });
      files.push({ name: `xl/worksheets/_rels/sheet${n}.xml.rels`, data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${n}.xml"/></Relationships>`) });
      overrides.push(`/xl/drawings/drawing${n}.xml|application/vnd.openxmlformats-officedocument.drawing+xml`);
      drawingRef = `<drawing r:id="rId1"/>`;
    }

    // Element ORDER matters to Excel: sheetViews, sheetFormatPr, cols, sheetData,
    // sheetProtection, autoFilter, pageMargins, drawing.
    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + `<dimension ref="${dim}"/>${views}<sheetFormatPr defaultRowHeight="15"/>${colsXml}`
      + `<sheetData>${rowsXml.join('')}</sheetData>${protection}${filter}`
      + `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>${drawingRef}</worksheet>`;
    files.push({ name: `xl/worksheets/sheet${n}.xml`, data: enc.encode(sheetXml) });
    overrides.push(`/xl/worksheets/sheet${n}.xml|application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml`);
  });

  files.push(...media);
  files.unshift({ name: '_rels/.rels', data: enc.encode(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) });
  files.unshift({ name: '[Content_Types].xml', data: enc.encode(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/>`
    + overrides.map(o => { const [p, t] = o.split('|'); return `<Override PartName="${p}" ContentType="${t}"/>`; }).join('')
    + `</Types>`) });
  return buildZip(files);
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>`
  + `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`
  + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
  + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
  + `<cellXfs count="5">`
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`                                                                              // 0 locked plain
  + `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>`                                                                // 1 header
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>`               // 2 locked wrap
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1" applyProtection="1"><alignment wrapText="1" vertical="top"/><protection locked="0"/></xf>`   // 3 unlocked wrap
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyProtection="1"><protection locked="0"/></xf>`                              // 4 unlocked plain
  + `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function _sheetName(n) { return String(n || 'Sheet').replace(/[[\]:*?/\\]/g, ' ').slice(0, 31); }

function _b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToBytes(b64) { return _b64ToBytes(b64); }

// ─── reader ─────────────────────────────────────────────────────────────────

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{sheets: Array<{name:string, hidden:boolean, rows:string[][], images:Array<{row:number,col:number,dataUrl:string}>}>}>}
 *   rows are dense (missing cells → ''), values are strings. images = the
 *   pictures floating over the sheet (drawing parts), with the 0-based cell
 *   their top-left corner sits in — how a reviewer's screenshot in a Notes
 *   cell comes back. (Excel's newer "picture in cell" objects are not read.)
 */
export async function parseXlsx(bytes) {
  const files = await readZip(bytes);
  const get = (name) => { const d = files.get(name) || files.get(name.replace(/^\//, '')); return d ? dec.decode(d) : null; };
  const getBytes = (name) => files.get(name) || files.get(name.replace(/^\//, '')) || null;
  const wb = get('xl/workbook.xml');
  if (!wb) throw new Error('Not an .xlsx workbook (xl/workbook.xml missing)');
  const relsXml = get('xl/_rels/workbook.xml.rels') || '';
  const rels = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = _attr(m[1], 'Id'), target = _attr(m[1], 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  // Shared strings (Excel's own saves use them; ours are inline).
  const shared = [];
  const ssXml = get('xl/sharedStrings.xml');
  if (ssXml) for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(_textOf(m[1] || ''));

  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const tag = m[1];
    const name = _attr(tag, 'name') || `Sheet${sheets.length + 1}`;
    const rid  = _attr(tag, 'r:id') || _attr(tag, 'id');
    const hidden = /state="(hidden|veryHidden)"/.test(tag);
    const path = rels.get(rid);
    const xml  = path ? get(path) : null;
    sheets.push({ name, hidden, rows: xml ? _parseSheet(xml, shared) : [], images: path ? _sheetImages(path, get, getBytes) : [] });
  }
  return { sheets };
}

/** Resolve a relationship Target against the folder of the part that holds the .rels. */
function _resolveRel(partPath, target) {
  if (target.startsWith('/')) return target.slice(1);
  const dir = partPath.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') dir.pop();
    else if (seg && seg !== '.') dir.push(seg);
  }
  return dir.join('/');
}

function _relsOf(partPath, get) {
  const parts = partPath.split('/');
  const file = parts.pop();
  const xml = get(`${parts.join('/')}/_rels/${file}.rels`);
  const map = new Map();
  if (!xml) return map;
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = _attr(m[1], 'Id'), target = _attr(m[1], 'Target'), type = _attr(m[1], 'Type') || '';
    if (id && target) map.set(id, { target: _resolveRel(partPath, target), type });
  }
  return map;
}

const _MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };

function _sheetImages(sheetPath, get, getBytes) {
  const out = [];
  try {
    const sheetRels = _relsOf(sheetPath, get);
    for (const { target, type } of sheetRels.values()) {
      if (!/\/drawing$/.test(type)) continue;
      const dxml = get(target);
      if (!dxml) continue;
      const drels = _relsOf(target, get);
      const anchorRe = /<(?:\w+:)?(oneCellAnchor|twoCellAnchor|absoluteAnchor)\b[\s\S]*?<\/(?:\w+:)?\1>/g;
      let am;
      while ((am = anchorRe.exec(dxml))) {
        const a = am[0];
        const from = /<(?:\w+:)?from>([\s\S]*?)<\/(?:\w+:)?from>/.exec(a)?.[1] || '';
        const col = parseInt(/<(?:\w+:)?col>(\d+)</.exec(from)?.[1] ?? '-1', 10);
        const row = parseInt(/<(?:\w+:)?row>(\d+)</.exec(from)?.[1] ?? '-1', 10);
        const embed = /\b(?:\w+:)?embed="([^"]+)"/.exec(a)?.[1];
        if (row < 0 || !embed) continue;
        const rel = drels.get(embed);
        if (!rel) continue;
        const ext = (rel.target.split('.').pop() || '').toLowerCase();
        const mime = _MIME[ext];
        const bytes = getBytes(rel.target);
        if (!mime || !bytes) continue;
        out.push({ row, col, dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}` });
      }
    }
  } catch (e) {
    console.warn?.('[xlsx] drawing parse skipped:', e?.message || e);
  }
  return out;
}

// ─── OpenDocument (.ods) reader — V0.3.3.10 ─────────────────────────────────
// Apache OpenOffice opens .xlsx but only SAVES the old binary .xls or its
// native .ods; LibreOffice users reach for .ods too. An .ods is the same
// idea as an .xlsx — a zip of XML — so the returned sheet comes back through
// the same reader shape: { sheets: [{ name, hidden, rows, images }] }.

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{sheets: Array<{name:string, hidden:boolean, rows:string[][], images:Array<{row:number,col:number,dataUrl:string}>}>}>}
 */
export async function parseOds(bytes) {
  const files = await readZip(bytes);
  const content = files.get('content.xml');
  if (!content) throw new Error('Not an .ods spreadsheet (content.xml missing)');
  const xml = dec.decode(content);
  // Hidden tables: a table style with table:display="false".
  const hiddenStyles = new Set();
  for (const m of xml.matchAll(/<style:style\b([^>]*)>([\s\S]*?)<\/style:style>/g)) {
    if (/table:display="false"/.test(m[2])) { const n = _attr(m[1], 'style:name'); if (n) hiddenStyles.add(n); }
  }
  const sheets = [];
  const tableRe = /<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g;
  let tm;
  while ((tm = tableRe.exec(xml))) {
    const name = _attr(tm[1], 'table:name') || `Sheet${sheets.length + 1}`;
    const hidden = hiddenStyles.has(_attr(tm[1], 'table:style-name') || '');
    const rows = [], images = [];
    const imageRows = new Set();   // rows that hold only a picture must survive the empty-tail trim
    const rowRe = /<table:table-row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g;
    let rm;
    while ((rm = rowRe.exec(tm[2]))) {
      const repeat = Math.max(1, parseInt(_attr(rm[1], 'table:number-rows-repeated') || '1', 10));
      const cells = [];
      const cellRe = /<table:(table-cell|covered-table-cell)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:\1>)/g;
      let cm;
      while ((cm = cellRe.exec(rm[2] || ''))) {
        const tag = cm[2], inner = cm[3] || '';
        const rep = Math.max(1, parseInt(_attr(tag, 'table:number-columns-repeated') || '1', 10));
        let v = '';
        if (cm[1] === 'table-cell') {
          const paras = [...inner.matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>|<text:p\b[^>]*\/>/g)].map(p => _odsText(p[1] || ''));
          v = paras.length ? paras.join('\n') : (_attr(tag, 'office:value') ?? '');
          for (const im of inner.matchAll(/<draw:image\b([^>]*)\/?>/g)) {
            const href = _attr(im[1], 'xlink:href');
            const data = href && files.get(href.replace(/^\.\//, ''));
            const mime = href && _MIME[(href.split('.').pop() || '').toLowerCase()];
            if (data && mime) { images.push({ row: rows.length, col: cells.length, dataUrl: `data:${mime};base64,${bytesToBase64(data)}` }); imageRows.add(rows.length); }
          }
        }
        // A trailing "repeated 1000 columns" empty cell is padding, not data.
        const n = (v === '' && rep > 50) ? 1 : rep;
        for (let i = 0; i < n; i++) cells.push(v);
      }
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      // Blank rows repeated by the thousands are the sheet's tail, not content.
      const n = cells.length ? Math.min(repeat, 200) : Math.min(repeat, 1);
      for (let i = 0; i < n; i++) rows.push(i === 0 ? cells : cells.slice());
    }
    while (rows.length && !rows[rows.length - 1].length && !imageRows.has(rows.length - 1)) rows.pop();
    const width = Math.max(0, ...rows.map(r => r.length));
    sheets.push({ name, hidden, rows: rows.map(r => { const o = r.slice(); while (o.length < width) o.push(''); return o; }), images });
  }
  return { sheets };
}

function _odsText(p) {
  return _xmlUnesc(String(p)
    .replace(/<text:line-break\s*\/>/g, '\n')
    .replace(/<text:tab\s*\/>/g, '\t')
    .replace(/<text:s\b([^>]*)\/>/g, (m, a) => ' '.repeat(Math.max(1, parseInt(_attr(a, 'text:c') || '1', 10))))
    .replace(/<[^>]+>/g, ''));
}

/** Either format, sniffed from the zip: xl/workbook.xml → xlsx, content.xml → ods. */
export async function parseSpreadsheet(bytes) {
  const files = await readZip(bytes);
  if (files.has('xl/workbook.xml')) return parseXlsx(bytes);
  if (files.has('content.xml')) return parseOds(bytes);
  throw new Error('Not an .xlsx or .ods spreadsheet');
}

function _parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rTag = rm[1] ?? rm[3] ?? '';
    const body = rm[2] || '';
    const rNum = parseInt(_attr(rTag, 'r') || String(rows.length + 1), 10);
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm, autoCol = 0;
    while ((cm = cellRe.exec(body))) {
      const tag = cm[1], inner = cm[2] || '';
      const ref = _attr(tag, 'r');
      const col = ref ? colIndex(ref) : autoCol;
      autoCol = col + 1;
      const t = _attr(tag, 't');
      let v = '';
      if (t === 's') {
        const idx = parseInt((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1] || '-1', 10);
        v = shared[idx] ?? '';
      } else if (t === 'inlineStr') {
        v = _textOf(inner);
      } else {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        v = vm ? _xmlUnesc(vm[1]) : '';
        if (t === 'b') v = v === '1' ? 'TRUE' : 'FALSE';
      }
      while (cells.length < col) cells.push('');
      cells[col] = v;
    }
    while (rows.length < rNum - 1) rows.push([]);
    rows[rNum - 1] = cells;
  }
  const width = Math.max(0, ...rows.map(r => r.length));
  return rows.map(r => { const out = r.slice(); while (out.length < width) out.push(''); return out; });
}
