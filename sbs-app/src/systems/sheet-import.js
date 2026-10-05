/**
 * SBS — 📊 Steps from Excel (V0.3.5.53)
 * =====================================
 * A client hands over ANY spreadsheet (no template). The dialog
 * (ui/sheet-import-dialog.js) lets the user mark columns — step name /
 * voiceover / title — and hands this module one row per step. Here the rows
 * become real steps in the OPEN project, in ONE undo entry:
 *
 *   • every step is what "+ Step" would make from the current scene (one
 *     snapshot, captured once, cloned per step — steps never share objects);
 *   • name + voiceText from the row;
 *   • per Title column, one text box per step, all bound to the SAME constant
 *     title (constTextBoxes def) so style + position are one setting the user
 *     changes later in one place. A 'brand' look reuses an existing def; a
 *     'new' look mints one def named after the column.
 *   • V0.3.5.54: optional groups (the dialog's "C01(name)5-15" line) — each
 *     named group becomes a NEW chapter, inserted right after the active
 *     step's chapter (else after all chapters), holding its rows in order.
 *
 * The overlay text boxes are written straight into step.overlay as the same
 * compact Konva JSON the overlay saves (className 'Image', name
 * 'userTextBox', textHtml + textWidth + styleId + constId). The overlay
 * rasterises them on load and its constant-title sync pass snaps them to the
 * def — no live stage is touched here.
 *
 * Heavy modules (steps.js pulls three.js) load lazily so the pure helpers
 * below stay testable in node.
 */

import state            from '../core/state.js';
import { undoManager }  from './undo.js';
import { createStep, createChapter, generateId } from '../core/schema.js';
import { cloneShareStrings }      from '../core/clone.js';

/** Position presets for a NEW unified title look. */
export const TITLE_POSITIONS = [
  { key: 'top-left',      label: 'Top left' },
  { key: 'top-center',    label: 'Top centre' },
  { key: 'top-right',     label: 'Top right' },
  { key: 'center',        label: 'Centre' },
  { key: 'bottom-left',   label: 'Bottom left' },
  { key: 'bottom-center', label: 'Bottom centre' },
  { key: 'bottom-right',  label: 'Bottom right' },
];
const _POS_KEYS = new Set(TITLE_POSITIONS.map(p => p.key));

// A runaway sheet (a whole parts database) would make thousands of steps and
// one gigantic undo snapshot — say so instead.
export const MAX_IMPORT_ROWS = 2000;

/** What the dialog offers for a Title column's look. */
export function sheetTitleChoices() {
  const styles      = (state.get('styleTemplates') || []).filter(t => t?.id).map(t => ({ id: t.id, name: t.name || 'Style' }));
  const brandTitles = (state.get('constTextBoxes') || []).filter(d => d?.id).map(d => ({ id: d.id, name: d.name || 'Title', styleId: d.styleId || null }));
  return { styles, brandTitles, positions: TITLE_POSITIONS.map(p => ({ ...p })) };
}

// ─── Pure helpers (node-tested: E:/claude-temp/xl-action-test.mjs) ──────────

/** Same escape the app uses for text it writes into overlay HTML. */
export function escapeTextHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Cell text as it should sit in a box: CRLF folded, outer blank lines gone. */
export function cleanCellText(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n')
    // soft breaks (vertical tab = Excel's Shift+Enter _x000B_, form feed, Unicode line / paragraph separators) are
    // line breaks; other control characters are illegal in the SVG the title is drawn through — the box loaded blank
    .replace(/[\u000B\u000C\u2028\u2029]/g, '\n').replace(/[\u0000-\u0008\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/^\s*\n|\n\s*$/g, '').trim();
}

const _RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g;
const _LTR_RE = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/g;

/** Mostly Hebrew / Arabic letters? Then the box is forced RTL (V0.3.3.4) —
 *  'auto' guesses wrong on the common "12-345 בורג" serial-first line. */
export function isRtlText(s) {
  const t = String(s ?? '');
  const rtl = (t.match(_RTL_RE) || []).length;
  if (!rtl) return false;
  return rtl >= (t.match(_LTR_RE) || []).length;
}

/** The box HTML — same shape as the overlay's _defaultTextHtml (div > span),
 *  one div per line. Alignment sits on the div because it is the only inline
 *  styling a style binding keeps. */
export function titleHtml(text, { align = 'left', fontSize = 48, fontFamily = 'Arial', color = '#ffffff' } = {}) {
  const span  = `font-family:${fontFamily};font-size:${fontSize}px;color:${color}`;
  const style = align && align !== 'left' ? ` style="text-align:${align}"` : '';
  const lines = cleanCellText(text).split('\n');
  return lines.map(l => `<div${style}><span style="${span}">${escapeTextHtml(l) || '<br>'}</span></div>`).join('');
}

/** Rough raster height (no DOM here): wrapped line count × 1.2 line-height +
 *  the rasteriser's 8px padding top and bottom. Only used to keep bottom /
 *  centre titles inside the frame — the real height comes from the raster. */
export function estimateBoxHeight(text, width, fontSize) {
  const inner = Math.max(20, width - 16);
  const perLine = Math.max(1, Math.floor(inner / (fontSize * 0.55)));
  let lines = 0;
  for (const l of cleanCellText(text).split('\n')) lines += Math.max(1, Math.ceil(l.length / perLine));
  return Math.ceil(lines * fontSize * 1.2 + 16);
}

/**
 * Def geometry for a 'new' look. The def owns the anchor corner (tl / tr);
 * every instance gets the same width, so a centred preset is a tl anchor at
 * (cw - w) / 2. `maxH` = tallest box in the column (bottom / centre presets
 * sit it fully inside the frame); `stack` = room already taken at this preset
 * by earlier title columns (they stack away from the edge, never overlap).
 */
export function planNewTitleGeometry(position, { cw, ch, maxH, stack = 0 }) {
  const pos = _POS_KEYS.has(position) ? position : 'bottom-center';
  const mx = Math.round(cw * 0.05), my = Math.round(ch * 0.05);
  const [v, hRaw] = pos === 'center' ? ['center', 'center'] : pos.split('-');
  const h = hRaw || 'center';
  const width = Math.round(h === 'center' ? cw * 0.7 : cw * 0.42);
  let y;
  if (v === 'top')         y = my + stack;
  else if (v === 'bottom') y = ch - my - maxH - stack;
  else                     y = Math.round((ch - maxH) / 2) + stack;
  y = Math.max(0, Math.round(y));
  if (h === 'right') return { anchor: 'tr', x: cw - mx, y, width, align: 'right' };
  if (h === 'left')  return { anchor: 'tl', x: mx, y, width, align: 'left' };
  return { anchor: 'tl', x: Math.round((cw - width) / 2), y, width, align: 'center' };
}

/** Instance width + alignment for an existing (brand) def: the room between
 *  its anchor and the far frame edge, within sane bounds. */
export function brandInstanceGeometry(def, cw) {
  const mx = Math.round(cw * 0.05);
  const room = def.anchor === 'tr' ? (def.x || 0) - mx : cw - (def.x || 0) - mx;
  const width = Math.round(Math.max(200, Math.min(cw * 0.6, room)));
  return { width, align: def.anchor === 'tr' ? 'right' : 'left' };
}

/** One overlay text-box node spec, positioned the way _applyConstToNode will. */
export function textBoxSpec({ text, def, width, align, fontSize, styleId }) {
  const h = estimateBoxHeight(text, width, fontSize);
  const attrs = {
    x: def.anchor === 'tr' ? def.x - width : def.x,
    y: def.y,
    width, height: h,
    draggable: true,
    name: 'userTextBox',
    textHtml: titleHtml(text, { align, fontSize }),
    textWidth: width,
    naturalW: width, naturalH: h,
    constId: def.id,
  };
  if (styleId) attrs.styleId = styleId;
  if (isRtlText(text)) attrs.textDir = 'rtl';
  return { attrs, className: 'Image' };
}

/** A step's overlay string holding these nodes; null when there are none
 *  (a step without an overlay is how the app stores "nothing on screen"). */
export function overlayJson(nodes, cw, ch) {
  if (!nodes?.length) return null;
  return JSON.stringify({
    attrs: { width: cw, height: ch },
    className: 'Stage',
    children: [{ attrs: { name: 'sbs-overlay-content' }, className: 'Layer', children: nodes }],
  });
}

const _DEFAULT_NAME = /^(step \d+|new step)?$/i;

/** Does this overlay string hold any user content (headers don't count)? */
function _overlayHasContent(str) {
  if (typeof str !== 'string' || !str) return false;
  let spec; try { spec = JSON.parse(str); } catch { return true; }   // unreadable = not ours to throw away
  return (spec?.children || []).some(l => l?.className === 'Layer'
    && (l.children || []).some(c => c?.attrs?.name !== 'sbs-header-item'));
}

/** The project's untouched starting step (V0.3.2.146 seed): the only step,
 *  nothing captured, no name / voice / overlay of its own. */
export function emptySeedStep(stepsArr) {
  const real = (stepsArr || []).filter(s => !s.isBaseStep);
  if (real.length !== 1) return null;
  const s = real[0];
  if (s.snapshot?.tree) return null;
  if (String(s.voiceText || '').trim() || String(s.narration?.text || '').trim()) return null;
  if (!_DEFAULT_NAME.test(String(s.name || '').trim())) return null;
  if (s.groupHead || s.groupId) return null;
  if (_overlayHasContent(s.overlay)) return null;
  return s;
}

/** Where the new steps land: after the last step (or in place of the seed). */
export function planStepList(current, created, seed = null) {
  const kept = seed ? current.filter(s => s !== seed && s.id !== seed.id) : current.slice();
  return [...kept, ...created];
}

/**
 * V0.3.5.54 — the dialog's row-range line ("C01(Arrange)5-15, C02(Clean)28-35")
 * arrives as groups [{ name, count }] that cover the rows in order. Checked
 * here, not trusted: a miscounted list would silently file steps into the
 * wrong chapter. null = no groups (today's import). Zero-row plain blocks are
 * dropped; a zero-row chapter is an error (an empty chapter is never wanted).
 * @returns {{ segments: {name:string|null, start:number, count:number}[] } | { error: string } | null}
 */
export function planSheetGroups(groups, total) {
  if (groups == null || (Array.isArray(groups) && !groups.length)) return null;
  if (!Array.isArray(groups)) return { error: 'The row list could not be read — retype it.' };
  const segments = [];
  let start = 0;
  for (const g of groups) {
    const count = Number(g?.count);
    if (!Number.isInteger(count) || count < 0) return { error: 'The row list could not be read — retype it.' };
    const name = g?.name == null ? null : (String(g.name).trim() || 'Chapter');
    if (!count) { if (name !== null) return { error: `Chapter "${name}" has no rows.` }; continue; }
    segments.push({ name, start, count });
    start += count;
  }
  if (start !== total) return { error: 'The row list does not match the rows to import — retype it.' };
  return { segments };
}

/** V0.3.5.54 — where new chapters go: right after the ACTIVE step's chapter,
 *  else (no chapters / active step chapter-less) after all of them = null. */
export function anchorChapterId(stepsArr, chaptersArr, activeStepId) {
  const act = (stepsArr || []).find(s => s.id === activeStepId);
  const cid = act?.chapterId;
  return cid && (chaptersArr || []).some(c => c.id === cid) ? cid : null;
}

/** V0.3.5.54 — the chapter list with `added` spliced in right after `afterId`
 *  (in their own order); at the end when afterId is null or gone (deleted
 *  between undo and redo). Later chapters shift on: 3 after #4 → #5 is #8. */
export function insertChaptersAfter(chaptersArr, added, afterId) {
  const out = (chaptersArr || []).slice();
  const i = afterId ? out.findIndex(c => c.id === afterId) : -1;
  out.splice(i < 0 ? out.length : i + 1, 0, ...added);
  return out;
}

const _EMPTY_SCENE_TREE = () => ({ id: 'scene_root', name: 'Scene', type: 'scene', localVisible: true, archived: false, children: [] });

/**
 * Build the steps + defs from the dialog's rows. Pure apart from id minting.
 * @returns {{ steps: object[], newDefs: object[] } | { error: string }}
 */
export function buildSheetSteps({ rows, titleColumns, baseSnapshot, cw, ch, styles, defs, chapterId = null, firstNumber = 1 }) {
  const styleById = new Map((styles || []).map(t => [t.id, t]));
  const defById   = new Map((defs || []).map(d => [d.id, d]));
  const usedNames = new Set((defs || []).map(d => d.name));
  const cols = (titleColumns || []).map(c => ({ label: String(c?.label || '').trim() || 'Title', look: c?.look || { kind: 'new' } }));
  const textAt = (r, i) => cleanCellText(r?.titles?.[i]);

  // One def + instance geometry per title column. Columns with no text in
  // any row make no def (an empty constant would only clutter the 📌 list).
  const plans = [];
  const newDefs = [];
  const stackAt = new Map();   // position key → room taken by earlier columns
  for (let i = 0; i < cols.length; i++) {
    const { label, look } = cols[i];
    if (!rows.some(r => textAt(r, i))) { plans.push(null); continue; }
    if (look.kind === 'brand') {
      const def = defById.get(look.constId);
      if (!def) return { error: `The title type for "${label}" is no longer in this project — pick it again.` };
      const tpl = def.styleId ? styleById.get(def.styleId) : null;
      const fontSize = tpl?.fontSize || Math.round(ch * 0.044);
      plans.push({ def, styleId: def.styleId || null, fontSize, ...brandInstanceGeometry(def, cw) });
      continue;
    }
    const tpl = look.styleId ? styleById.get(look.styleId) : null;
    const styleId = tpl ? tpl.id : null;   // a style deleted meanwhile → plain look
    const fontSize = tpl?.fontSize || Math.round(ch * 0.044);
    const position = _POS_KEYS.has(look.position) ? look.position : 'bottom-center';
    const probeW = planNewTitleGeometry(position, { cw, ch, maxH: 0 }).width;
    const maxH = Math.max(...rows.map(r => (textAt(r, i) ? estimateBoxHeight(textAt(r, i), probeW, fontSize) : 0)));
    const stack = stackAt.get(position) || 0;
    const g = planNewTitleGeometry(position, { cw, ch, maxH, stack });
    stackAt.set(position, stack + maxH + Math.round(fontSize * 0.3));
    let name = label, n = 2;
    while (usedNames.has(name)) name = `${label} (${n++})`;
    usedNames.add(name);
    const def = { id: generateId('ctb'), name, anchor: g.anchor, x: g.x, y: g.y, styleId };
    newDefs.push(def);
    plans.push({ def, styleId, fontSize, width: g.width, align: g.align });
  }

  const tree = baseSnapshot?.tree || null;
  const steps = rows.map((r, idx) => {
    const name = cleanCellText(r?.name).replace(/\s*\n\s*/g, ' ') || `Step ${firstNumber + idx}`;
    const step = createStep({ name, chapterId });
    const snap = cloneShareStrings(baseSnapshot || step.snapshot);
    // No model yet → an EMPTY scene tree, not null: the first model load then
    // injects itself into EVERY step (injectModelIntoAllSteps) instead of
    // capturing into one and leaving the rest without it (V0.3.2.159).
    if (!tree) snap.tree = _EMPTY_SCENE_TREE();
    step.snapshot = snap;
    // the voiceover lives in step.narration.text (what the voiceover box, TTS, the precache, export and the
    // timeline read); voiceText is the legacy field older readers still fall back to — both, as step import does
    const voice = cleanCellText(r?.voice);
    if (voice) step.narration = { text: voice };
    step.voiceText = voice;
    step.voiceEnabled = true;
    step.altered = true;   // ★ new step — never rendered
    const nodes = [];
    plans.forEach((p, i) => {
      const text = p && textAt(r, i);
      if (text) nodes.push(textBoxSpec({ text, def: p.def, width: p.width, align: p.align, fontSize: p.fontSize, styleId: p.styleId }));
    });
    const ov = overlayJson(nodes, cw, ch);
    if (ov) step.overlay = ov;
    return step;
  });
  return { steps, newDefs };
}

// ─── The import ──────────────────────────────────────────────────────────────

/**
 * @param {{ rows: {name:string, voice:string, titles:string[]}[],
 *           titleColumns: {label:string, look:{kind:'brand',constId:string}|{kind:'new',styleId:string|null,position:string}}[],
 *           groups?: {name:string|null, count:number}[] }} p
 *   groups (V0.3.5.54): cover `rows` in order; name null = a plain block
 *   (today's placement), a name = a NEW chapter holding those rows' steps.
 * @returns {Promise<{ok:true, created:number, chapters:number}|{ok:false, reason:string}>}
 */
export async function importStepsFromSheet({ rows, titleColumns = [], groups = null } = {}) {
  if (!Array.isArray(rows) || !rows.length) return { ok: false, reason: 'No rows to import.' };
  if (rows.length > MAX_IMPORT_ROWS) return { ok: false, reason: `${rows.length} rows is more than ${MAX_IMPORT_ROWS} steps — split the sheet or filter the rows first.` };
  const grouping = planSheetGroups(groups, rows.length);
  if (grouping?.error) return { ok: false, reason: grouping.error };

  const [{ default: steps }, overlay, { getCanonicalSize }] = await Promise.all([
    import('./steps.js'), import('./overlay.js'), import('../core/safe-frame.js'),
  ]);
  try { steps.flushSync(); } catch { /* nothing pending */ }
  try { overlay.flushSave(); } catch { /* no stage yet */ }

  const all0 = state.get('steps') || [];
  const seed = emptySeedStep(all0);
  const realSteps = all0.filter(s => !s.isBaseStep && s !== seed);
  const last = realSteps[realSteps.length - 1] || seed || null;
  const { width: cw, height: ch } = getCanonicalSize();
  const baseSnapshot = steps.captureSnapshot();

  const built = buildSheetSteps({
    rows, titleColumns, baseSnapshot, cw, ch,
    styles: state.get('styleTemplates') || [],
    defs: state.get('constTextBoxes') || [],
    // the last step's chapter: normalizeOrder files chapter-less steps BEFORE
    // every chapter, which is not "after the existing steps"
    chapterId: last?.chapterId ?? null,
    firstNumber: realSteps.length + 1,
  });
  if (built.error) return { ok: false, reason: built.error };
  const created = built.steps, newDefs = built.newDefs;
  const createdIds = new Set(created.map(s => s.id));
  const newDefIds  = new Set(newDefs.map(d => d.id));

  // V0.3.5.54 — chapter codes: each named group is a NEW chapter (the app's
  // own factory, like "+ Chapter") owning its rows' steps in typed order;
  // plain groups keep the chapter given above. Steps are appended in typed
  // order, so normalizeOrder (chapter-list order, stable inside a chapter)
  // lays each chapter out exactly as typed — and nothing reshuffles later.
  const newChapters = [];
  for (const seg of grouping?.segments || []) {
    if (seg.name === null) continue;
    const chap = createChapter({ name: seg.name });
    newChapters.push(chap);
    for (let i = seg.start; i < seg.start + seg.count; i++) created[i].chapterId = chap.id;
  }
  const newChapterIds = new Set(newChapters.map(c => c.id));
  const chapterAnchor = anchorChapterId(all0, state.get('chapters') || [], state.get('activeStepId'));

  // Steps kept from before that have NO tree while there is no model either
  // (a named-but-empty first step): give them the empty scene tree too, or
  // the first model load would skip them (it only injects into steps with a
  // tree once any step has one). Restored on undo.
  const noModel = !state.get('treeData');
  const patched = new Map();   // id → { orig, next }
  if (noModel) {
    for (const s of realSteps) {
      if (s.snapshot && !s.snapshot.tree) patched.set(s.id, { orig: s, next: { ...s, snapshot: { ...s.snapshot, tree: _EMPTY_SCENE_TREE() } } });
    }
  }

  const prevActive = state.get('activeStepId');
  const prevSel    = new Set(state.get('selectedStepIds') instanceof Set ? state.get('selectedStepIds') : []);
  const seedIndex  = seed ? all0.indexOf(seed) : -1;

  // Splice against the CURRENT arrays at undo / redo time (stale-snapshot
  // rule, as in duplicateSteps / unifyConstantTitles): an edit made to other
  // steps or titles in between is never rolled back with the import.
  const place = () => {
    let cur = (state.get('steps') || []).filter(s => !createdIds.has(s.id));
    if (patched.size) cur = cur.map(s => (patched.get(s.id)?.orig === s ? patched.get(s.id).next : s));
    const curSeed = seed ? cur.find(s => s.id === seed.id) : null;
    const defsNow = (state.get('constTextBoxes') || []).filter(d => !newDefIds.has(d.id));
    const next = { steps: planStepList(cur, created, curSeed), constTextBoxes: [...defsNow, ...newDefs] };
    // chapters in the SAME setState as their steps — no render ever sees a step whose chapter is missing
    if (newChapters.length) {
      next.chapters = insertChaptersAfter((state.get('chapters') || []).filter(c => !newChapterIds.has(c.id)), newChapters, chapterAnchor);
    }
    state.setState(next);
    steps.normalizeOrder();
    state.markDirty();
    if (state.get('activeStepId') !== created[0].id) steps.activateStep(created[0].id, false);
    state.setState({ selectedStepIds: new Set([created[0].id]) });
  };
  const unplace = () => {
    let cur = (state.get('steps') || []).filter(s => !createdIds.has(s.id));
    if (patched.size) cur = cur.map(s => (patched.get(s.id)?.next === s ? patched.get(s.id).orig : s));
    if (seed && !cur.some(s => s.id === seed.id)) cur.splice(Math.min(Math.max(0, seedIndex), cur.length), 0, seed);
    const undone = { steps: cur, constTextBoxes: (state.get('constTextBoxes') || []).filter(d => !newDefIds.has(d.id)) };
    if (newChapters.length) undone.chapters = (state.get('chapters') || []).filter(c => !newChapterIds.has(c.id));
    state.setState(undone);
    steps.normalizeOrder();
    state.markDirty();
    const act = state.get('activeStepId');
    if (!cur.some(s => s.id === act)) {
      const back = cur.find(s => s.id === prevActive) || cur.find(s => !s.isBaseStep);
      if (back) steps.activateStep(back.id, false);
    }
    state.setState({ selectedStepIds: new Set([...prevSel].filter(id => cur.some(s => s.id === id))) });
  };

  place();
  undoManager.push(`Steps from Excel (${created.length})`, unplace, place);
  console.log(`[sheet-import] ${created.length} step(s)${seed ? ' (replaced the empty starting step)' : ''}, ${newDefs.length} new title type(s), ${newChapters.length} new chapter(s)${newChapters.length ? (chapterAnchor ? ` after chapter ${chapterAnchor}` : ' at the end') : ''}.`);
  return { ok: true, created: created.length, chapters: newChapters.length };
}
