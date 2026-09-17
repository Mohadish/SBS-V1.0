/**
 * SBS — translation / proofing sheets (V0.3.3.7).
 * ───────────────────────────────────────────────
 * Export: every translatable unit of the project (voiceover, step names,
 * chapter names, constant titles, text boxes, headers) as ONE .xlsx per
 * language — a point-in-time snapshot the client edits while you keep
 * working. Import: the returned sheet is matched by the units' STABLE KEYS
 * (never by row position), rows whose source changed in the meantime are
 * flagged, and everything is previewed before it lands (one undo entry).
 *
 * Both directions run while the project SHOWS ITS SOURCE LANGUAGE: the
 * sheet's Source column and fingerprints are the original text, and a
 * target language's pack is a file that never has to be "live" to be
 * updated. The language panel enforces this.
 *
 * Pure parts (numbering, rows, matching, plain ↔ html) live in
 * translation-sheet-core.js; the .xlsx bytes in io/xlsx.js.
 */

import { state }        from '../core/state.js';
import { undoManager }  from './undo.js';
import { setStatus }    from '../ui/status.js';
import { chooseFromButtons, chooseWithPreview } from '../ui/prompt.js';
import * as lang        from './language-packs.js';
import * as projectPaths from '../core/project-paths.js';
import sceneCore        from '../core/scene.js';
import { rasterizeOverlay } from './overlay.js';
import { steps }        from './steps.js';
import { APP_VERSION }  from '../core/schema.js';
import { buildXlsx, parseXlsx, bytesToBase64, base64ToBytes } from '../io/xlsx.js';
import {
  SHEET_NAME, META_SHEET, FORMAT_VERSION, COLUMNS, COL,
  buildRows, parseHeader, matchRows, summarize, plainIntoHtml, htmlToPlain, normText,
} from './translation-sheet-core.js';

const XLSX_FILTER = [{ name: 'Excel workbook', extensions: ['xlsx'] }];

function _projectBase() {
  const p = state.get('projectPath') || '';
  const file = p.split(/[\\/]/).pop() || 'project';
  return file.replace(/\.sbsproj$/i, '');
}

function _guard() {
  if (!state.get('projectPath')) { setStatus('Save the project first — sheets are built from the saved project.', 'warn', 6000); return false; }
  if (lang.activeLang() !== lang.sourceLang()) {
    setStatus(`Switch the project back to its original language ("${lang.sourceLang()}") first — the sheet's Source column is the original text.`, 'warn', 8000);
    return false;
  }
  return true;
}

// ─── previews ───────────────────────────────────────────────────────────────

/** stepId → data URL. `fresh` walks every visible step and renders a 300 px picture. */
async function _collectPreviews(fresh) {
  const thumbs = new Map();
  if (!fresh) {
    for (const s of (state.get('steps') || [])) if (!s.isBaseStep && s.thumbnail) thumbs.set(s.id, s.thumbnail);
    return { thumbs, w: 240, h: 160 };
  }
  const dom = sceneCore.renderer?.domElement;
  const aspect = dom && dom.width ? dom.height / dom.width : 9 / 16;
  const w = 300, h = Math.max(60, Math.round(w * aspect));
  const extraLayers = (ww, hh) => [rasterizeOverlay({ width: ww, height: hh })];
  const startId = state.get('activeStepId');
  const list = steps.getVisibleSteps();
  let i = 0;
  for (const s of list) {
    i++;
    setStatus(`Rendering step previews… ${i}/${list.length}`, 'info', 0);
    await steps.activateStep(s.id, false);
    await new Promise(r => setTimeout(r, 120));
    // requestThumbnail resolves on the next frame; a static scene may never
    // draw one, so race it against a direct capture.
    let url = await Promise.race([
      sceneCore.requestThumbnail(w, h, 0.72, { extraLayers }),
      new Promise(r => setTimeout(() => r(null), 400)),
    ]);
    if (!url) { try { url = sceneCore.captureThumbnail(w, h, 0.72, { extraLayers }); } catch { url = null; } }
    if (url) thumbs.set(s.id, url);
  }
  if (startId) await steps.activateStep(startId, false);
  setStatus('', 'info', 1);
  return { thumbs, w, h };
}

// ─── export ─────────────────────────────────────────────────────────────────

/**
 * @param {string} code  target language code (a pack language, or the source language for a proofing sheet)
 */
export async function exportTranslationSheet(code) {
  if (!_guard()) return null;
  const src = lang.sourceLang();
  const isSource = code === src;
  let pack = null;
  if (!isSource) {
    try { pack = await lang.loadPack(code); }
    catch (e) { setStatus(`Cannot read the "${code}" pack: ${e?.message || e}`, 'warn', 8000); return null; }
  }
  const previews = await chooseFromButtons(
    'Step previews',
    'Put a picture of each step next to its voiceover? Fresh previews walk through every step once (roughly a second per ten steps).',
    [{ id: 'fresh', label: 'Render 300 px previews', primary: true }, { id: 'cached', label: 'Use the small thumbnails' }, { id: 'none', label: 'No previews' }],
  );
  if (previews == null) return null;

  let thumbs = null, tw = 0, th = 0;
  if (previews !== 'none') {
    const r = await _collectPreviews(previews === 'fresh');
    thumbs = r.thumbs; tw = r.w; th = r.h;
  }
  const units = lang.scanUnits();
  const rows = buildRows({
    steps: state.get('steps') || [], chapters: state.get('chapters') || [], units,
    entries: pack?.entries || {}, perChapter: !!state.get('headerStepNumberPerChapter'),
    hashOf: lang.srcHashOf, thumbs,
  });
  const images = [], rowHeights = {};
  rows.forEach((r, i) => {
    if (!r.thumb) return;
    images.push({ row: i, col: COL.Preview, dataUrl: r.thumb, wPx: tw, hPx: th });
    rowHeights[i + 2] = Math.ceil(th * 0.75) + 6;   // px → points, plus breathing room
  });
  const base = _projectBase();
  const meta = [
    ['project', base], ['exported', new Date().toISOString()], ['sourceLang', src], ['targetLang', code],
    ['appVersion', APP_VERSION], ['formatVersion', String(FORMAT_VERSION)], ['rows', String(rows.length)],
    ['note', 'Edit the Target and Notes columns only. Rows may be sorted or moved; the hidden key column is what SBS matches on.'],
  ];
  const bytes = await buildXlsx({ sheets: [
    {
      name: SHEET_NAME, header: COLUMNS, rows: rows.map(r => r.cells),
      cols: [
        { width: 8, hidden: true }, { width: 8, hidden: true }, { width: 8 }, { width: 12 }, { width: 13 },
        { width: previews === 'none' ? 3 : Math.ceil(tw / 7) + 2 }, { width: 55 }, { width: 55 }, { width: 28 },
      ],
      unlockedCols: [COL.Target, COL.Notes], wrapCols: [COL.Source, COL.Target, COL.Notes],
      protect: true, freezeHeader: true, autoFilter: true, rowHeights, images,
    },
    { name: META_SHEET, hidden: true, header: ['field', 'value'], rows: meta },
  ] });

  const exportsDir = projectPaths.subDir?.('exports') || null;
  const defaultPath = exportsDir ? `${exportsDir}${exportsDir.includes('\\') ? '\\' : '/'}${base}.${code}.translation.xlsx` : `${base}.${code}.translation.xlsx`;
  const path = await window.sbsNative.saveFile({ title: `Export "${code}" translation sheet`, defaultPath, filters: XLSX_FILTER });
  if (!path) return null;
  const w = await window.sbsNative.writeFile(path, bytesToBase64(bytes), 'base64');
  if (w && w.ok === false) { setStatus(`Could not write the sheet: ${w.error}`, 'warn', 8000); return null; }
  setStatus(`Sheet exported — ${rows.length} line(s)${thumbs ? `, ${images.length} preview(s)` : ''} → ${path}`, 'success', 10000);
  return path;
}

// ─── import ─────────────────────────────────────────────────────────────────

export async function importTranslationSheet(code) {
  if (!_guard()) return null;
  const path = await window.sbsNative.openFile({ title: `Import a "${code}" translation sheet`, filters: XLSX_FILTER });
  if (!path) return null;
  const rd = await window.sbsNative.readFile(path, 'base64');
  if (!rd?.ok) { setStatus(`Could not read the file: ${rd?.error || 'unknown error'}`, 'warn', 8000); return null; }
  let wb;
  try { wb = await parseXlsx(base64ToBytes(rd.data)); }
  catch (e) { setStatus(`Not a readable .xlsx: ${e?.message || e}`, 'warn', 8000); return null; }

  const meta = Object.fromEntries((wb.sheets.find(s => s.name === META_SHEET)?.rows || []).slice(1).map(r => [String(r[0] || ''), String(r[1] || '')]));
  const sheet = wb.sheets.find(s => s.name === SHEET_NAME) || wb.sheets.find(s => !s.hidden) || wb.sheets[0];
  if (!sheet?.rows?.length) { setStatus('That workbook has no rows.', 'warn', 6000); return null; }
  const idx = parseHeader(sheet.rows[0]);
  if (idx.Target == null || idx.Source == null) { setStatus('No "Source" / "Target" columns in the first row — is this a sheet SBS exported?', 'warn', 8000); return null; }

  // Provenance: the wrong project or the wrong language is the classic mistake.
  const base = _projectBase();
  if (meta.project && meta.project !== base) {
    const c = await chooseFromButtons('Different project', `This sheet was exported from "${meta.project}"; the open project is "${base}". Import anyway?`,
      [{ id: 'go', label: 'Import anyway', danger: true }, { id: 'no', label: 'Cancel', primary: true }]);
    if (c !== 'go') return null;
  }
  if (meta.targetLang && meta.targetLang !== code) {
    const c = await chooseFromButtons('Different language', `This sheet was exported for "${meta.targetLang}"; you are importing into "${code}". Import anyway?`,
      [{ id: 'go', label: 'Import anyway', danger: true }, { id: 'no', label: 'Cancel', primary: true }]);
    if (c !== 'go') return null;
  }
  if (Number(meta.formatVersion) > FORMAT_VERSION) setStatus(`This sheet comes from a newer SBS (format ${meta.formatVersion}); columns it added are ignored.`, 'warn', 8000);

  const src = lang.sourceLang();
  const isSource = code === src;
  let pack = null;
  if (!isSource) {
    try { pack = (await lang.loadPack(code)) || lang.emptyPack(code); }
    catch (e) { setStatus(`Cannot read the "${code}" pack: ${e?.message || e}`, 'warn', 8000); return null; }
  }
  const units = lang.scanUnits();
  const matches = matchRows(sheet.rows.slice(1), idx, units, lang.srcHashOf);
  const sum = summarize(matches);
  const plain = (u, v) => (u.fmt === 'html' ? htmlToPlain(v) : normText(v));
  const currentOf = (u) => isSource ? plain(u, u.src) : plain(u, pack.entries[u.key]?.tgt || '');
  const changes = matches.filter(m => m.unit && !m.blank && !m.duplicate && currentOf(m.unit) !== m.target);

  const rowsPreview = changes.map(m => ({
    label: `${m.unit.label}${m.stale ? ' · ⚠ source changed after the export' : ''}${m.how !== 'key' ? ` · matched by ${m.how === 'hash' ? 'fingerprint' : 'text'}` : ''}${m.notes ? ` · note: ${m.notes}` : ''}`,
    from: currentOf(m.unit), to: m.target,
  }));
  const msg = `${sum.rows} row(s) — ${sum.matched} matched (${sum.byKey} by key, ${sum.byHash} by fingerprint, ${sum.byText} by text), `
    + `${sum.unmatched} not found in the project, ${sum.blank} left blank (kept as is), ${sum.duplicate} duplicate. `
    + `${changes.length} line(s) would change; ${sum.stale} of the rows had their source edited after the export.`;
  const buttons = [{ id: 'all', label: `Apply ${changes.length}`, primary: true }];
  if (changes.some(m => m.stale)) buttons.push({ id: 'safe', label: `Apply only unchanged-source rows (${changes.filter(m => !m.stale).length})` });
  buttons.push({ id: 'cancel', label: 'Cancel' });
  const choice = await chooseWithPreview(`Import into "${code}"`, msg, rowsPreview, buttons);
  if (!choice || choice === 'cancel') return null;
  const apply = choice === 'safe' ? changes.filter(m => !m.stale) : changes;
  if (!apply.length) { setStatus('Nothing to apply.', 'info', 4000); return null; }
  await _applyChanges(code, isSource, pack, apply);
  return path;
}

async function _applyChanges(code, isSource, pack, apply) {
  // html units: the translated plain text goes back into the box's styling
  // (the current target html when there is one, else the source html).
  const valueFor = (m) => m.unit.fmt === 'html'
    ? plainIntoHtml(isSource ? m.unit.src : (pack?.entries[m.unit.key]?.tgt || m.unit.src), m.target)
    : m.target;
  const after  = new Map(apply.map(m => [m.unit.key, valueFor(m)]));
  const before = new Map(apply.map(m => [m.unit.key, m.unit.src]));   // live text now (source language is live)
  const packBefore = pack ? JSON.stringify(pack) : null;

  if (pack) {
    for (const m of apply) {
      const key = m.unit.key;
      const cur = pack.entries[key] || { fmt: m.unit.fmt, src: m.unit.src, srcHash: lang.srcHashOf(m.unit.src), tgt: '', state: 'new' };
      pack.entries[key] = {
        ...cur, fmt: m.unit.fmt, src: m.unit.src, srcHash: lang.srcHashOf(m.unit.src),
        tgt: after.get(key), state: 'edited',
        drifted: m.stale ? true : (cur.drifted || false),
        review: { ...(cur.review || {}), tgt: m.stale ? 'new' : 'edited' },
      };
    }
    const r = await lang.savePack(pack);
    if (!r.ok) { setStatus(`Could not save the "${code}" pack: ${r.error}`, 'warn', 8000); return; }
  }
  const packAfter = pack ? JSON.stringify(pack) : null;
  let n = 0;
  if (isSource) n = lang.applyEntries(after);

  undoManager.push(`Import sheet into "${code}" (${apply.length})`,
    async () => { if (isSource) lang.applyEntries(before); if (packBefore) await lang.savePack(JSON.parse(packBefore)); },
    async () => { if (isSource) lang.applyEntries(after);  if (packAfter)  await lang.savePack(JSON.parse(packAfter)); },
  );
  setStatus(isSource
    ? `Imported ${apply.length} line(s) into the project (${n} changed).`
    : `Imported ${apply.length} line(s) into the "${code}" pack. Switch to "${code}" to see them.`, 'success', 8000);
}

if (typeof window !== 'undefined') {
  window.sbsSheet = { export: exportTranslationSheet, import: importTranslationSheet };
}
