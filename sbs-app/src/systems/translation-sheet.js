/**
 * SBS — translation / proofing sheets (V0.3.3.7, multi-language V0.3.3.8).
 * ────────────────────────────────────────────────────────────────────────
 * Export: every translatable unit of the project (voiceover, step names,
 * chapter names, constant titles, text boxes, headers) into ONE .xlsx with
 * a sheet (tab) per language — a point-in-time snapshot the client edits
 * while you keep working. Import: every language sheet in the returned
 * workbook is matched by the units' STABLE KEYS (never by row position),
 * rows whose source changed in the meantime are flagged, everything is
 * previewed before it lands (one undo entry per language), and whatever the
 * client wrote in Notes (or pasted as a picture) becomes a review note.
 *
 * Both directions run while the project SHOWS ITS SOURCE LANGUAGE: the
 * sheet's Source column and fingerprints are the original text, and a
 * target language's pack is a file that never has to be "live" to be
 * updated. The language panel enforces this.
 *
 * Pure parts (numbering, rows, matching, plain ↔ html, notes) live in
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
import { addReviewNotes } from './review-notes.js';
import {
  LEGACY_SHEET_NAME, META_SHEET, FORMAT_VERSION, COLUMNS, COL, sheetNameFor,
  augmentUnits, buildRows, parseHeader, matchRows, summarize, notesFrom, stepIdOfUnit,
  plainIntoHtml, htmlToPlain, normText,
} from './translation-sheet-core.js';

const XLSX_FILTER = [{ name: 'Excel workbook', extensions: ['xlsx'] }];
const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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

// ─── export options dialog ──────────────────────────────────────────────────

/** @returns {Promise<{langs:string[], previews:'fresh'|'cached'|'none', includeHidden:boolean}|null>} */
function _exportOptions(src, packLangs) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    const langRows = [
      `<label style="display:flex;gap:8px;align-items:center;"><input type="checkbox" data-lang="${_esc(src)}" ${packLangs.length ? '' : 'checked'}> <b>${_esc(src)}</b> <span class="small muted">— the original, as a proofing sheet (Target column empty)</span></label>`,
      ...packLangs.map(c => `<label style="display:flex;gap:8px;align-items:center;"><input type="checkbox" data-lang="${_esc(c)}" checked> <b>${_esc(c)}</b> <span class="small muted">— translation sheet</span></label>`),
    ].join('');
    dlg.innerHTML = `
      <div class="sbs-dialog__body" style="max-width:min(560px,90vw);">
        <div class="sbs-dialog__title">Export translation sheet</div>
        <div class="small muted" style="margin-top:6px;line-height:1.5;">One workbook, one tab per language you tick. Only Target and Notes are editable in it; rows may be sorted, moved or filtered — SBS matches them by a hidden key.</div>
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:5px;">${langRows}</div>
        <div style="margin-top:12px;font-weight:600;">Step previews</div>
        <div style="display:flex;flex-direction:column;gap:4px;margin-top:4px;">
          <label style="display:flex;gap:8px;align-items:center;"><input type="radio" name="prev" value="fresh" checked> Render 300 px previews <span class="small muted">— walks through every step once, about a second per ten steps</span></label>
          <label style="display:flex;gap:8px;align-items:center;"><input type="radio" name="prev" value="cached"> Use the small step thumbnails</label>
          <label style="display:flex;gap:8px;align-items:center;"><input type="radio" name="prev" value="none"> No previews</label>
        </div>
        <label style="display:flex;gap:8px;align-items:center;margin-top:12px;"><input type="checkbox" id="ts-hidden"> Include hidden steps <span class="small muted">— steps and chapters hidden from the sequence</span></label>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
          <button class="btn" data-choice="cancel">Cancel</button>
          <button class="btn" data-choice="ok" style="color:#22d3ee;font-weight:600;">Export</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.querySelector('[data-choice="cancel"]').addEventListener('click', () => done(null));
    dlg.querySelector('[data-choice="ok"]').addEventListener('click', () => {
      const langs = [...dlg.querySelectorAll('input[data-lang]:checked')].map(i => i.dataset.lang);
      if (!langs.length) { setStatus('Tick at least one language.', 'warn', 3000); return; }
      done({ langs, previews: dlg.querySelector('input[name="prev"]:checked')?.value || 'none', includeHidden: !!dlg.querySelector('#ts-hidden').checked });
    });
    dlg.addEventListener('cancel', e => { e.preventDefault(); done(null); });
    dlg.showModal();
  });
}

// ─── previews ───────────────────────────────────────────────────────────────

/** stepId → data URL. `fresh` walks every step (hidden ones too when asked) and renders a 300 px picture. */
async function _collectPreviews(fresh, includeHidden) {
  const thumbs = new Map();
  const all = (state.get('steps') || []).filter(s => !s.isBaseStep);
  if (!fresh) {
    for (const s of all) if (s.thumbnail) thumbs.set(s.id, s.thumbnail);
    return { thumbs, w: 240, h: 160 };
  }
  const dom = sceneCore.renderer?.domElement;
  const aspect = dom && dom.width ? dom.height / dom.width : 9 / 16;
  const w = 300, h = Math.max(60, Math.round(w * aspect));
  const extraLayers = (ww, hh) => [rasterizeOverlay({ width: ww, height: hh })];
  const startId = state.get('activeStepId');
  const visibleIds = new Set(steps.getVisibleSteps().map(s => s.id));
  const list = includeHidden ? all : all.filter(s => visibleIds.has(s.id));
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

export async function exportTranslationSheet() {
  if (!_guard()) return null;
  const src = lang.sourceLang();
  const packLangs = (await lang.listPackLanguages()).filter(c => c !== src);
  const opts = await _exportOptions(src, packLangs);
  if (!opts) return null;

  const packs = new Map();
  for (const code of opts.langs) {
    if (code === src) continue;
    try { packs.set(code, await lang.loadPack(code)); }
    catch (e) { setStatus(`Cannot read the "${code}" pack: ${e?.message || e}`, 'warn', 8000); return null; }
  }
  let thumbs = null, tw = 0, th = 0;
  if (opts.previews !== 'none') {
    const r = await _collectPreviews(opts.previews === 'fresh', opts.includeHidden);
    thumbs = r.thumbs; tw = r.w; th = r.h;
  }
  const allSteps = state.get('steps') || [];
  const units = augmentUnits(lang.scanUnits(), allSteps);
  const perChapter = !!state.get('headerStepNumberPerChapter');
  const sheets = [];
  let total = 0, imageCount = 0;
  for (const code of opts.langs) {
    const rows = buildRows({
      steps: allSteps, chapters: state.get('chapters') || [], units,
      entries: packs.get(code)?.entries || {}, perChapter, includeHidden: opts.includeHidden,
      hashOf: lang.srcHashOf, thumbs,
    });
    const images = [], rowHeights = {};
    rows.forEach((r, i) => {
      if (!r.thumb) return;
      images.push({ row: i, col: COL.Preview, dataUrl: r.thumb, wPx: tw, hPx: th });
      rowHeights[i + 2] = Math.ceil(th * 0.75) + 6;   // px → points, plus breathing room
    });
    total += rows.length; imageCount += images.length;
    sheets.push({
      name: sheetNameFor(code), header: COLUMNS, rows: rows.map(r => r.cells),
      cols: [
        { width: 8, hidden: true }, { width: 8, hidden: true }, { width: 8 }, { width: 12 },
        { width: opts.previews === 'none' ? 3 : Math.ceil(tw / 7) + 2 }, { width: 13 }, { width: 55 }, { width: 55 }, { width: 28 },
      ],
      unlockedCols: [COL.Target, COL.Notes], wrapCols: [COL.Source, COL.Target, COL.Notes],
      protect: true, freezeHeader: true, autoFilter: true, rowHeights, images,
    });
  }
  const base = _projectBase();
  sheets.push({ name: META_SHEET, hidden: true, header: ['field', 'value'], rows: [
    ['project', base], ['exported', new Date().toISOString()], ['sourceLang', src], ['languages', opts.langs.join(',')],
    ['appVersion', APP_VERSION], ['formatVersion', String(FORMAT_VERSION)], ['includeHidden', opts.includeHidden ? '1' : '0'],
    ['note', 'One tab per language. Edit the Target and Notes columns only; a picture floated over a row becomes a review note in SBS. Rows may be sorted or moved; the hidden key column is what SBS matches on.'],
  ] });
  const bytes = await buildXlsx({ sheets });

  const exportsDir = projectPaths.subDir?.('exports') || null;
  const fname = `${base}.translation.xlsx`;
  const defaultPath = exportsDir ? `${exportsDir}${exportsDir.includes('\\') ? '\\' : '/'}${fname}` : fname;
  const path = await window.sbsNative.saveFile({ title: 'Export translation sheet', defaultPath, filters: XLSX_FILTER });
  if (!path) return null;
  const w = await window.sbsNative.writeFile(path, bytesToBase64(bytes), 'base64');
  if (w && w.ok === false) { setStatus(`Could not write the sheet: ${w.error}`, 'warn', 8000); return null; }
  setStatus(`Sheet exported — ${opts.langs.length} language tab(s), ${total} line(s)${thumbs ? `, ${imageCount} preview(s)` : ''} → ${path}`, 'success', 10000);
  return path;
}

// ─── import ─────────────────────────────────────────────────────────────────

export async function importTranslationSheet() {
  if (!_guard()) return null;
  const path = await window.sbsNative.openFile({ title: 'Import a translation sheet', filters: XLSX_FILTER });
  if (!path) return null;
  const rd = await window.sbsNative.readFile(path, 'base64');
  if (!rd?.ok) { setStatus(`Could not read the file: ${rd?.error || 'unknown error'}`, 'warn', 8000); return null; }
  let wb;
  try { wb = await parseXlsx(base64ToBytes(rd.data)); }
  catch (e) { setStatus(`Not a readable .xlsx: ${e?.message || e}`, 'warn', 8000); return null; }
  const fileName = path.split(/[\\/]/).pop();

  const meta = Object.fromEntries((wb.sheets.find(s => s.name === META_SHEET)?.rows || []).slice(1).map(r => [String(r[0] || ''), String(r[1] || '')]));
  const base = _projectBase();
  if (meta.project && meta.project !== base) {
    const c = await chooseFromButtons('Different project', `This sheet was exported from "${meta.project}"; the open project is "${base}". Import anyway?`,
      [{ id: 'go', label: 'Import anyway', danger: true }, { id: 'no', label: 'Cancel', primary: true }]);
    if (c !== 'go') return null;
  }
  if (Number(meta.formatVersion) > FORMAT_VERSION) setStatus(`This sheet comes from a newer SBS (format ${meta.formatVersion}); columns it added are ignored.`, 'warn', 8000);

  // Which tabs are languages? Known packs + the source; a V0.3.3.7 single
  // "Translation" tab imports into the language its meta names.
  const src = lang.sourceLang();
  const known = new Set([src, ...(await lang.listPackLanguages())]);
  const jobs = [];
  for (const sh of wb.sheets) {
    if (sh.hidden || sh.name === META_SHEET) continue;
    let code = null;
    if (known.has(sh.name)) code = sh.name;
    else if (sh.name === LEGACY_SHEET_NAME && meta.targetLang) code = meta.targetLang;
    else if (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(sh.name)) code = sh.name;   // a language tab whose pack does not exist yet
    if (code) jobs.push({ code, sheet: sh });
  }
  if (!jobs.length) { setStatus('No language tab found in that workbook (tabs are named by language code, e.g. "he").', 'warn', 8000); return null; }

  const allSteps = state.get('steps') || [];
  const units = augmentUnits(lang.scanUnits(), allSteps);
  let importedLines = 0, importedNotes = 0;
  for (const { code, sheet } of jobs) {
    const r = await _importSheet(code, sheet, units, fileName);
    if (r === 'abort') break;
    importedLines += r.lines; importedNotes += r.notes;
  }
  setStatus(`Import done — ${importedLines} line(s) across ${jobs.length} language tab(s), ${importedNotes} review note(s).`, 'success', 8000);
  return path;
}

/** One language tab → preview → pack / project → notes. */
async function _importSheet(code, sheet, units, fileName) {
  const idx = parseHeader(sheet.rows[0] || []);
  if (idx.Target == null || idx.Source == null) { setStatus(`Tab "${sheet.name}": no Source / Target columns — skipped.`, 'warn', 6000); return { lines: 0, notes: 0 }; }
  const src = lang.sourceLang();
  const isSource = code === src;
  let pack = null;
  if (!isSource) {
    try { pack = (await lang.loadPack(code)) || lang.emptyPack(code); }
    catch (e) { setStatus(`Cannot read the "${code}" pack: ${e?.message || e}`, 'warn', 8000); return { lines: 0, notes: 0 }; }
  }
  const matches = matchRows(sheet.rows.slice(1), idx, units, lang.srcHashOf);
  const sum = summarize(matches);
  const plain = (u, v) => (u.fmt === 'html' ? htmlToPlain(v) : normText(v));
  const currentOf = (u) => isSource ? plain(u, u.src) : plain(u, pack.entries[u.key]?.tgt || '');
  const changes = matches.filter(m => m.unit && !m.blank && !m.duplicate && currentOf(m.unit) !== m.target);
  const notes = notesFrom(matches, sheet.images || [], idx);

  const rowsPreview = changes.map(m => ({
    label: `${m.unit.label}${m.stale ? ' · ⚠ source changed after the export' : ''}${m.how !== 'key' ? ` · matched by ${m.how === 'hash' ? 'fingerprint' : 'text'}` : ''}${m.notes ? ` · note: ${m.notes}` : ''}`,
    from: currentOf(m.unit), to: m.target,
  }));
  const msg = `Tab "${sheet.name}" → language "${code}". ${sum.rows} row(s) — ${sum.matched} matched (${sum.byKey} by key, ${sum.byHash} by fingerprint, ${sum.byText} by text), `
    + `${sum.unmatched} not found in the project, ${sum.blank} left blank (kept as is), ${sum.duplicate} duplicate. `
    + `${changes.length} line(s) would change; ${sum.stale} row(s) had their source edited after the export. ${notes.length} review note(s) will be added.`;
  const buttons = [{ id: 'all', label: `Apply ${changes.length}`, primary: true }];
  if (changes.some(m => m.stale)) buttons.push({ id: 'safe', label: `Apply only unchanged-source rows (${changes.filter(m => !m.stale).length})` });
  if (!changes.length && notes.length) buttons[0].label = 'Add the notes';
  buttons.push({ id: 'skip', label: 'Skip this tab' }, { id: 'abort', label: 'Stop the import' });
  const choice = await chooseWithPreview(`Import into "${code}"`, msg, rowsPreview, buttons);
  if (!choice || choice === 'abort') return 'abort';
  if (choice === 'skip') return { lines: 0, notes: 0 };
  const apply = choice === 'safe' ? changes.filter(m => !m.stale) : changes;
  if (apply.length) await _applyChanges(code, isSource, pack, apply);

  // Review notes: text and/or pictures, shrunk so the project stays light.
  let added = 0;
  if (notes.length) {
    const list = [];
    for (const n of notes) {
      const images = [];
      for (const u of n.images) { try { images.push(await _shrinkImage(u)); } catch { images.push(u); } }
      list.push({
        key: n.key, stepId: stepIdOfUnit(n.unit), lang: code, type: n.unit?.label || '',
        text: n.text, images, file: fileName,
      });
    }
    added = addReviewNotes(list, `Import notes from "${sheet.name}"`).length;
  }
  return { lines: apply.length, notes: added };
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

/** Client screenshots can be huge; cap at 1200 px wide, JPEG. */
function _shrinkImage(dataUrl, maxW = 1200) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (img.width <= maxW && dataUrl.length < 600000) { resolve(dataUrl); return; }
      const s = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('bad image'));
    img.src = dataUrl;
  });
}

if (typeof window !== 'undefined') {
  window.sbsSheet = { export: exportTranslationSheet, import: importTranslationSheet };
}
