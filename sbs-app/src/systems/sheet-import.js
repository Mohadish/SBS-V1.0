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
 *   • V0.3.5.59: per Image column, one overlay picture per step, all bound to
 *     the SAME pinned position (constShapes def) and the SAME shared crop
 *     mask (cropMasks def) — brand ones, or ONE new pair per column (a preset
 *     position + size + a plain rectangle mask). A Title column's 'new' look
 *     may also mint ONE basic text style (styleId '__new__') so the titles
 *     restyle in bulk later. Every new def rides the import's ONE undo entry.
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
import { makeStyleTemplate }      from './style-templates.js';

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
/** V0.3.5.62 — the JSON weight all the steps of a project may reach (≈ 1.5 GB of heap; the renderer has ~3.5 GB and a save doubles the peak). */
export const STEP_WEIGHT_BUDGET = 800e6;

/** What the dialog offers for a Title column's look. */
export function sheetTitleChoices() {
  const styles      = (state.get('styleTemplates') || []).filter(t => t?.id).map(t => ({ id: t.id, name: t.name || 'Style' }));
  const brandTitles = (state.get('constTextBoxes') || []).filter(d => d?.id).map(d => ({ id: d.id, name: d.name || 'Title', styleId: d.styleId || null }));
  // V0.3.5.59 — the project's / brand's pinned positions + shared masks, for an Image column's look
  const pinnedPositions = (state.get('constShapes') || []).filter(d => d?.id).map(d => ({ id: d.id, name: d.name || 'Position' }));
  const masks           = (state.get('cropMasks')   || []).filter(d => d?.id).map(d => ({ id: d.id, name: d.name || 'Mask' }));
  return { styles, brandTitles, positions: TITLE_POSITIONS.map(p => ({ ...p })), pinnedPositions, masks };
}

/** V0.3.5.59 — the mask shapes a NEW picture look offers (width : height). */
export const PICTURE_ASPECTS = { '4:3': 4 / 3, '1:1': 1, '16:9': 16 / 9 };

/** The styleId a 'new' title look sends to ask for a fresh basic style. */
export const NEW_STYLE_ID = '__new__';

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
  // V0.3.5.62 — RTL text gets its alignment written out even for 'left': a forced-RTL box reads "no alignment"
  // as START = right, so a Hebrew title in a top-left box showed up near the middle of the frame
  const style = align && (align !== 'left' || isRtlText(text)) ? ` style="text-align:${align}"` : '';
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

/**
 * V0.3.5.59 — the box a NEW picture look fills: a preset position (same 7 as
 * titles, 5% margin), `size` = share of the frame width (0.1–0.9), height
 * from the aspect; a box taller than 90% of the frame shrinks to fit. Whole
 * pixels, so the mask fractions describe exactly the same rectangle. The
 * pinned-position def anchors right presets at their right edge (tr), like
 * the titles — a later resize keeps them against that edge.
 */
export function planNewPictureBox(position, { cw, ch, size = 0.35, aspect = '4:3' }) {
  const pos = _POS_KEYS.has(position) ? position : 'top-right';
  const ar = PICTURE_ASPECTS[aspect] || PICTURE_ASPECTS['4:3'];
  const share = Math.min(0.9, Math.max(0.1, Number(size) || 0.35));
  let w = cw * share, h = w / ar;
  if (h > ch * 0.9) { h = ch * 0.9; w = h * ar; }
  w = Math.round(w); h = Math.round(h);
  const mx = Math.round(cw * 0.05), my = Math.round(ch * 0.05);
  const [v, hRaw] = pos === 'center' ? ['center', 'center'] : pos.split('-');
  const hz = hRaw || 'center';
  const left = hz === 'left' ? mx : (hz === 'right' ? cw - mx - w : Math.round((cw - w) / 2));
  const top  = v === 'top' ? my : (v === 'bottom' ? ch - my - h : Math.round((ch - h) / 2));
  const x = Math.max(0, left), y = Math.max(0, top);
  return { x, y, w, h, anchor: hz === 'right' ? 'tr' : 'tl', defX: hz === 'right' ? x + w : x };
}

/**
 * V0.3.5.59 — "cover": the part of a W×H picture that fills a bw×bh box at
 * one scale, centred, as Konva crop attrs (source pixels). WHY a crop and not
 * a centred oversize node: a pinned position snaps the node's bounding-box
 * corner to the def on every step load (_applyConstShapeToNode), so an
 * oversize picture centred under the mask would be dragged back to its own
 * corner — off centre — the moment the step opened. Cropped, the node IS the
 * box: pin and mask both line up exactly, for every picture shape.
 * null when the picture's size is unknown (it then stretches to the box).
 */
export function coverCrop(W, H, bw, bh) {
  if (!(W > 0 && H > 0 && bw > 0 && bh > 0)) return null;
  const s = Math.max(bw / W, bh / H);
  const cwid = Math.min(W, bw / s), chgt = Math.min(H, bh / s);
  const r = v => Math.round(v * 100) / 100;
  return { cropX: r((W - cwid) / 2), cropY: r((H - chgt) / 2), cropWidth: r(cwid), cropHeight: r(chgt) };
}

/** V0.3.5.59 — one overlay picture node, the way addImage + the 📌 / 🎭 menus
 *  leave it: name 'userImage', the data URL in src, natural size, bound by
 *  constShapeId / cropMaskId (ids, never copies — moving a def moves them all). */
export function pictureSpec({ pic, box, posId = null, maskId = null }) {
  const attrs = {
    x: box.x, y: box.y, width: box.w, height: box.h,
    draggable: true,
    name: 'userImage',
    src: pic.dataUrl,
  };
  const W = Number(pic.width) || 0, H = Number(pic.height) || 0;
  if (W > 0 && H > 0) { attrs.naturalW = W; attrs.naturalH = H; }
  const crop = coverCrop(W, H, box.w, box.h);
  if (crop) Object.assign(attrs, crop);
  if (posId)  attrs.constShapeId = posId;
  if (maskId) attrs.cropMaskId   = maskId;
  return { attrs, className: 'Image' };
}

/** V0.3.5.59 — a usable picture from the dialog: a data URL of an image. */
function _picOk(p) {
  return !!(p && typeof p.dataUrl === 'string' && /^data:image\//i.test(p.dataUrl));
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
export function buildSheetSteps({ rows, titleColumns, imageColumns = [], baseSnapshot, cw, ch, styles, defs, shapeDefs = [], maskDefs = [], chapterId = null, firstNumber = 1 }) {
  const styleById = new Map((styles || []).map(t => [t.id, t]));
  const defById   = new Map((defs || []).map(d => [d.id, d]));
  const usedNames = new Set((defs || []).map(d => d.name));
  const cols = (titleColumns || []).map(c => ({ label: String(c?.label || '').trim() || 'Title', look: c?.look || { kind: 'new' } }));
  const textAt = (r, i) => cleanCellText(r?.titles?.[i]);
  const uniqueName = (used, base) => { let n = base, k = 2; while (used.has(n)) n = `${base} (${k++})`; used.add(n); return n; };

  // ── V0.3.5.59 — Image columns: one shared position + mask per column ──
  const picAt = (r, i) => (_picOk(r?.images?.[i]) ? r.images[i] : null);
  const posById  = new Map((shapeDefs || []).map(d => [d.id, d]));
  const maskById = new Map((maskDefs || []).map(d => [d.id, d]));
  const usedPos  = new Set((shapeDefs || []).map(d => d.name));
  const usedMask = new Set((maskDefs || []).map(d => d.name));
  const newPins = [], newMasks = [];
  const picPlans = [];
  (imageColumns || []).forEach((c, i) => {
    if (picPlans.error) return;
    const label = String(c?.label || '').trim() || 'Picture';
    const look = c?.look || { kind: 'new' };
    if (!rows.some(r => picAt(r, i))) { picPlans.push(null); return; }   // no picture anywhere → no defs
    if (look.kind === 'brand') {
      const pos  = look.posId  ? posById.get(look.posId)   : null;
      const mask = look.maskId ? maskById.get(look.maskId) : null;
      if (look.posId && !pos)   { picPlans.error = `The pinned position for "${label}" is no longer in this project — pick it again.`; return; }
      if (look.maskId && !mask) { picPlans.error = `The mask for "${label}" is no longer in this project — pick it again.`; return; }
      if (!pos && !mask)        { picPlans.error = `Pick a pinned position for "${label}".`; return; }
      let posId = pos?.id || null, x, y, w, h;
      if (!mask) {                                            // pinned, no mask: the look's size / aspect at the pin
        const fallback = planNewPictureBox('center', { cw, ch, size: look.size, aspect: look.aspect });
        w = fallback.w; h = fallback.h;
        x = Math.round(pos.anchor === 'tr' ? (pos.x || 0) - w : (pos.x || 0)); y = Math.round(pos.y || 0);
      } else {
        const mx = mask.x * cw, my = mask.y * ch, mw = Math.max(1, mask.w * cw), mh = Math.max(1, mask.h * ch);
        x = Math.round(mx); y = Math.round(my); w = Math.round(mw); h = Math.round(mh);   // the window itself
        if (pos) {
          // V0.3.5.62 (diagnostic) — the pin snaps the box's CORNER home on every load while the mask stays where
          // it is: the box must reach from the pin's corner over the WHOLE window, or the picture loads half /
          // fully blank. A pin that lies inside or past the window cannot do that: the mask alone is bound.
          const px = pos.x || 0, py = pos.y || 0, tr = pos.anchor === 'tr';
          const okX = tr ? px >= mx + mw - 2 : px <= mx + 2, okY = py <= my + 2;
          if (okX && okY) {
            if (tr) { x = Math.round(mx); w = Math.max(1, Math.round(px - mx)); }
            else    { x = Math.round(px); w = Math.max(1, Math.round(mx + mw - px)); }
            y = Math.round(py); h = Math.max(1, Math.round(my + mh - py));
          } else {
            posId = null;
            console.info(`[sheet-import] "${label}": its pinned position lies inside / past the mask — the pictures are bound to the mask only`);
          }
        }
      }
      picPlans.push({ box: { x, y, w, h }, posId, maskId: mask?.id || null });
      return;
    }
    const b = planNewPictureBox(look.position, { cw, ch, size: look.size, aspect: look.aspect });
    // same shapes the 📌 "Make pinned position…" / 🎭 promote menus write
    // V0.3.5.70 — ONE name, free in both lists: the next import's default look pairs a pin with the mask of the same
    // name, so "Photo (2)" + "Photo" would have paired the new mask with an older, unrelated pin
    let shared = label, k = 2;
    while (usedPos.has(shared) || usedMask.has(shared)) shared = `${label} (${k++})`;
    usedPos.add(shared); usedMask.add(shared);
    const pin  = { id: generateId('csp'), name: shared, anchor: b.anchor, x: b.defX, y: b.y };
    const mask = { id: generateId('cmk'), name: shared, kind: 'rect', x: b.x / cw, y: b.y / ch, w: b.w / cw, h: b.h / ch, rot: 0 };
    newPins.push(pin); newMasks.push(mask);
    picPlans.push({ box: { x: b.x, y: b.y, w: b.w, h: b.h }, posId: pin.id, maskId: mask.id });
  });
  if (picPlans.error) return { error: picPlans.error };

  // One def + instance geometry per title column. Columns with no text in
  // any row make no def (an empty constant would only clutter the 📌 list).
  const plans = [];
  const newDefs = [];
  const newStyles = [];
  const usedStyleNames = new Set((styles || []).map(t => t.name));
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
    let tpl = look.styleId ? styleById.get(look.styleId) : null;
    if (look.styleId === NEW_STYLE_ID) {
      // V0.3.5.59 — "＋ New basic style": the app's default text look at the size an unstyled imported
      // title already gets (the stock 16 px would shrink every title once bound) — one per column
      tpl = makeStyleTemplate({ name: uniqueName(usedStyleNames, `${label} style`), fontSize: Math.round(ch * 0.044) });
      newStyles.push(tpl);
    }
    const styleId = tpl ? tpl.id : null;   // a style deleted meanwhile → plain look
    const fontSize = tpl?.fontSize || Math.round(ch * 0.044);
    const position = _POS_KEYS.has(look.position) ? look.position : 'bottom-center';
    const probeW = planNewTitleGeometry(position, { cw, ch, maxH: 0 }).width;
    const maxH = Math.max(...rows.map(r => (textAt(r, i) ? estimateBoxHeight(textAt(r, i), probeW, fontSize) : 0)));
    const stack = stackAt.get(position) || 0;
    const g = planNewTitleGeometry(position, { cw, ch, maxH, stack });
    stackAt.set(position, stack + maxH + Math.round(fontSize * 0.3));
    const name = uniqueName(usedNames, label);
    const def = { id: generateId('ctb'), name, anchor: g.anchor, x: g.x, y: g.y, styleId };
    newDefs.push(def);
    plans.push({ def, styleId, fontSize, width: g.width, align: g.align });
  }

  const tree = baseSnapshot?.tree || null;
  let pictures = 0;
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
    // V0.3.5.59 — pictures first, so the step's titles draw on top of them
    picPlans.forEach((p, i) => {
      const pic = p && picAt(r, i);
      if (pic) { nodes.push(pictureSpec({ pic, box: p.box, posId: p.posId, maskId: p.maskId })); pictures++; }
    });
    plans.forEach((p, i) => {
      const text = p && textAt(r, i);
      if (text) nodes.push(textBoxSpec({ text, def: p.def, width: p.width, align: p.align, fontSize: p.fontSize, styleId: p.styleId }));
    });
    const ov = overlayJson(nodes, cw, ch);
    if (ov) step.overlay = ov;
    return step;
  });
  return { steps, newDefs, newStyles, newPins, newMasks, pictures };
}

// ─── The import ──────────────────────────────────────────────────────────────

/**
 * @param {{ rows: {name:string, voice:string, titles:string[]}[],
 *           titleColumns: {label:string, look:{kind:'brand',constId:string}|{kind:'new',styleId:string|null,position:string}}[],
 *           imageColumns?: {label:string, look:{kind:'brand',posId:string,maskId:string|null}|{kind:'new',position:string,size:number,aspect:string}}[],
 *           groups?: {name:string|null, count:number}[] }} p
 *   groups (V0.3.5.54): cover `rows` in order; name null = a plain block
 *   (today's placement), a name = a NEW chapter holding those rows' steps.
 *   imageColumns (V0.3.5.59): rows[i].images[k] = { dataUrl, width, height } | null for column k.
 *   A 'new' title look with styleId '__new__' mints one basic text style for that column.
 * @returns {Promise<{ok:true, created:number, chapters:number, pictures:number}|{ok:false, reason:string}>}
 */
export async function importStepsFromSheet({ rows, titleColumns = [], imageColumns = [], groups = null } = {}) {
  if (!Array.isArray(rows) || !rows.length) return { ok: false, reason: 'No rows to import.' };
  // V0.3.5.62 — never under a running export (it would switch the step being rendered) or the Poly Editor (the project is masked)
  if (state.get('_exporting')) return { ok: false, reason: 'An export is running — import after it finishes.' };
  if (state.get('polySession')) return { ok: false, reason: 'The Poly Editor is open — Apply or Discard it first.' };
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
  // V0.3.5.62 (diagnostic) — every step carries a FULL copy of the scene: on a heavy model (4 MB a step) a few
  // hundred rows ran the renderer out of memory, with the open project. Weighed before anything is built; the
  // existing steps count too (they weigh about the same), and a save clones them all once more.
  let _stepChars = 0;
  try { _stepChars = JSON.stringify(baseSnapshot).length; } catch { _stepChars = 0; }
  const _fits = _stepChars > 0 ? Math.floor(STEP_WEIGHT_BUDGET / _stepChars) - realSteps.length : Infinity;
  if (rows.length > _fits) {
    return { ok: false, reason: _fits > 0
      ? `This model is heavy — each step holds a full copy of the scene. About ${_fits} more steps fit in memory; choose fewer rows in "Rows to import".`
      : 'This model is heavy and the project already holds about as many steps as fit in memory — nothing was imported.' };
  }

  const built = buildSheetSteps({
    rows, titleColumns, imageColumns, baseSnapshot, cw, ch,
    styles: state.get('styleTemplates') || [],
    defs: state.get('constTextBoxes') || [],
    shapeDefs: state.get('constShapes') || [],
    maskDefs: state.get('cropMasks') || [],
    // the last step's chapter: normalizeOrder files chapter-less steps BEFORE
    // every chapter, which is not "after the existing steps"
    chapterId: last?.chapterId ?? null,
    firstNumber: realSteps.length + 1,
  });
  if (built.error) return { ok: false, reason: built.error };
  const created = built.steps, newDefs = built.newDefs;
  const createdIds = new Set(created.map(s => s.id));
  const newDefIds  = new Set(newDefs.map(d => d.id));
  // V0.3.5.59 — the new style / pinned-position / mask defs come and go with the steps (same undo entry)
  const extraDefs = [
    { key: 'styleTemplates', items: built.newStyles || [] },
    { key: 'constShapes',    items: built.newPins   || [] },
    { key: 'cropMasks',      items: built.newMasks  || [] },
  ].filter(e => e.items.length).map(e => ({ ...e, ids: new Set(e.items.map(d => d.id)) }));
  const pictures = built.pictures || 0;

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
    // defs in the SAME setState as the steps — the first step's overlay loads with its pin / mask / style there
    for (const e of extraDefs) next[e.key] = [...(state.get(e.key) || []).filter(d => !e.ids.has(d.id)), ...e.items];
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
    for (const e of extraDefs) undone[e.key] = (state.get(e.key) || []).filter(d => !e.ids.has(d.id));
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
  console.log(`[sheet-import] ${created.length} step(s)${seed ? ' (replaced the empty starting step)' : ''}, ${newDefs.length} new title type(s), ${(built.newStyles || []).length} new style(s), ${pictures} picture(s), ${(built.newPins || []).length} new pinned position(s), ${(built.newMasks || []).length} new mask(s), ${newChapters.length} new chapter(s)${newChapters.length ? (chapterAnchor ? ` after chapter ${chapterAnchor}` : ' at the end') : ''}.`);
  return { ok: true, created: created.length, chapters: newChapters.length, pictures };
}
