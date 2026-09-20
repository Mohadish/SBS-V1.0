/**
 * SBS — Document (2D manual) : the PURE part (V0.3.4.0, phase D1).
 * ─────────────────────────────────────────────────────────────────
 * The approved animation becomes a paged document: every page covers one
 * or more steps, shows their text (the voiceover by default, independently
 * editable) and one or more pictures of those steps' FINAL state, inside a
 * strict page template (header / text zone / picture slots / footer).
 *
 * Everything here is data → data: pagination, the reconciliation of pages
 * with a timeline that kept changing, per-step document text with drift
 * detection, templates, and the render model the HTML / PDF builder eats.
 * Pages refer to steps by their permanent ids — never by position.
 *
 * No app imports (except the pure numbering helper); tested offline.
 */

import { numberSteps } from './translation-sheet-core.js';
import { WATERMARK_DEFAULTS, watermarkOf } from './watermark-core.js';

export const DOC_VERSION = 1;
export { watermarkOf };

// ─── templates (millimetres, A4 portrait) ───────────────────────────────────

const _img169 = (x, y, w) => ({ x, y, w, h: Math.round(w * 9 / 16 * 10) / 10 });

/**
 * The prefab templates every document starts with. Strict by design: a picture
 * lives in a slot, nowhere else. V0.3.4.3 — a slot no longer has to be 16:9:
 * the picture is CROPPED into it (and can be moved / scaled behind it), so the
 * layouts can use the page properly. Content area: x 12…198, y 32…270 (mm).
 */
export function builtinTemplates() {
  const P = { page: { w: 210, h: 297 }, header: { x: 12, y: 10, w: 186, h: 18 }, footer: { x: 12, y: 275, w: 186, h: 12 }, builtin: true };
  const R = (x, y, w, h) => ({ x, y, w, h });
  return [
    { ...P, id: 'tpl_standard', name: 'One picture — wide (16:9)',              text: R(12, 32, 186, 126), images: [_img169(12, 164, 186)] },
    { ...P, id: 'tpl_tall',     name: 'One picture — tall (3:2)',               text: R(12, 32, 186, 108), images: [R(12, 146, 186, 124)] },
    { ...P, id: 'tpl_two',      name: 'Two pictures side by side',              text: R(12, 32, 186, 124), images: [R(12, 162, 91, 108), R(107, 162, 91, 108)] },
    { ...P, id: 'tpl_three',    name: 'Three pictures — one large, two below',  text: R(12, 32, 186, 66),  images: [R(12, 104, 186, 102), R(12, 210, 91, 60), R(107, 210, 91, 60)] },
    { ...P, id: 'tpl_four',     name: 'Four pictures — two by two',             text: R(12, 32, 186, 66),  images: [R(12, 104, 91, 81), R(107, 104, 91, 81), R(12, 189, 91, 81), R(107, 189, 91, 81)] },
    { ...P, id: 'tpl_picture',  name: 'Large picture, short text',              text: R(12, 32, 186, 60),  images: [_img169(12, 98, 186), _img169(12, 98 + 104.6 + 4, 112)] },
  ];
}

export function emptyDocument() {
  return {
    version: DOC_VERSION,
    templateId: 'tpl_standard',
    templates: [],                       // user templates; builtins are always available
    fields: { title: '', docNo: '', rev: 'A', company: '' },
    header: { left: '{company}', center: '{title}', right: '{docNo} · rev {rev}' },
    footer: { left: '{project}', center: '{chapter}', right: 'Page {page} / {pages}' },
    // numbering: 'step' = the animation's step numbers · 'page' = 1,2,3 per page · 'none'
    // direction: 'auto' (from the text: Hebrew / Arabic → right-to-left) · 'ltr' · 'rtl'   ·   pictureNumbers: the step number on each picture
    // toc: a contents page (chapters → page numbers) opens the document; it counts as page 1, so everything after it shifts
    options: { includeHidden: false, numbering: 'step', direction: 'auto', pictureNumbers: true, toc: true },
    pages: [],
    texts: {},                           // stepId → { text, srcHash }   (absent = follows the voiceover)
    watermark: { ...WATERMARK_DEFAULTS },
    hiddenSteps: [],                     // step (unit) ids left OUT of the document — the animation is not touched
    assets: {},                          // assetId → { dataUrl, w, h, name } : pictures that are not part of the animation
    extras: [],                          // what is not a step page: the contents' place, custom pages — each anchored before a step
    bands: null,                         // { header:{items,rule}, footer:{…} } once the header / footer were edited; null = the classic three cells
  };
}

/** The layout a page gets by itself: as many pictures as it has steps — 1 → the document's default, 2, 3, 4 (and 4 for more: sort the rest out by hand). */
export function templateForCount(n, defaultId = 'tpl_standard') {
  return n <= 1 ? defaultId : n === 2 ? 'tpl_two' : n === 3 ? 'tpl_three' : 'tpl_four';
}

/**
 * Re-pick the template of every page that is still on AUTOMATIC (the user has not chosen
 * one: templateAuto !== false). Pages saved before this flag existed count as automatic only
 * if their template is what automatic would have given them anyway, or the plain default —
 * a layout somebody picked by hand is never taken away.
 */
export function autoTemplates(pages, opts = {}) {
  const hidden = new Set(opts.hidden || []);
  const dflt = opts.defaultId || 'tpl_standard';
  return (pages || []).map(p => {
    const n = (p.stepIds || []).filter(id => !hidden.has(id)).length;
    const want = templateForCount(n, dflt);
    const auto = p.templateAuto === true || (p.templateAuto === undefined && (p.templateId === dflt || p.templateId === want || !p.templateId));
    if (!auto) return p;
    return (p.templateId === want && p.templateAuto === true) ? p : { ...p, templateId: want, templateAuto: true };
  });
}

// ─── user templates ─────────────────────────────────────────────────────────
// A template a user draws is the same record as a prefab one. It is STRICT in the same way:
// the text box and every picture frame live inside the content area (between the header
// and the footer, inside the side margins) and never overlap — that is what keeps every page
// of a manual lined up. Header and footer zones are not part of a user template (yet).

export const PAGE_MM = Object.freeze({ w: 210, h: 297 });
export const CONTENT_MM = Object.freeze({ x: 12, y: 32, w: 186, h: 238.5 });     // x 12…198, y 32…270.5
export const MAX_FRAMES = 8;
const MIN_FRAME = 15, MIN_TEXT_H = 12, MIN_TEXT_W = 40;

const _r1 = (v) => Math.round(Number(v) * 2) / 2;                                // half-millimetre grid
/** A rect forced to be numbers, on the grid, at least min size, inside the content area. */
export function clampRect(r, minW = MIN_FRAME, minH = MIN_FRAME, area = CONTENT_MM) {
  const C = area;
  let w = Math.max(minW, Math.min(C.w, _r1(r?.w) || minW)), h = Math.max(minH, Math.min(C.h, _r1(r?.h) || minH));
  let x = _r1(r?.x), y = _r1(r?.y);
  if (!Number.isFinite(x)) x = C.x; if (!Number.isFinite(y)) y = C.y;
  x = Math.max(C.x, Math.min(C.x + C.w - w, x)); y = Math.max(C.y, Math.min(C.y + C.h - h, y));
  return { x, y, w, h };
}

/** Whatever came in (the editor, an old file, a hand-edited file) → a well-formed template record, numbers only. */
export function sanitizeTemplate(t) {
  const base = builtinTemplates()[0];
  return {
    id: String(t?.id || ''),
    name: String(t?.name || 'My template').slice(0, 80),
    builtin: false,
    page: { ...base.page }, header: { ...base.header }, footer: { ...base.footer },
    text: clampRect(t?.text || base.text, MIN_TEXT_W, MIN_TEXT_H),
    images: (Array.isArray(t?.images) ? t.images : []).slice(0, MAX_FRAMES).map(r => clampRect(r)),
  };
}

const _overlap = (a, b) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;
/** What stops a template from being saved — in plain words, naming the boxes. [] = fine. */
export function templateProblems(t) {
  const zones = [{ name: 'the text box', r: t.text }, ...(t.images || []).map((r, i) => ({ name: `picture ${i + 1}`, r }))];
  const out = [];
  for (let i = 0; i < zones.length; i++) for (let j = i + 1; j < zones.length; j++) if (_overlap(zones[i].r, zones[j].r)) out.push({ a: i, b: j, text: `${zones[i].name} and ${zones[j].name} overlap` });
  return out;
}

export function templateById(doc, id) {
  const mine = (doc?.templates || []).find(t => t.id === id);
  if (mine) return sanitizeTemplate(mine);                    // never trust stored geometry: it is written into style attributes
  return builtinTemplates().find(t => t.id === id) || builtinTemplates()[0];
}

// ─── the timeline as the document sees it ───────────────────────────────────

export const narrationOf = (s) => String(s?.narration?.text ?? s?.voiceText ?? '');

/**
 * Units = what a page can hold: a top-level step, with its sub-steps folded
 * in (a step group plays as ONE clip; its final picture is its last member).
 * @returns {Array<{id:string, members:string[], chapterId:string|null}>} in timeline order
 */
export function unitsOf(steps, chapters, opts = {}) {
  const chHidden = new Set((chapters || []).filter(c => c.hidden).map(c => c.id));
  const playable = (s) => !s.isBaseStep && (opts.includeHidden || (!s.hidden && !chHidden.has(s.chapterId)));
  const units = [], byHead = new Map();
  for (const s of steps || []) {
    if (!playable(s)) continue;
    if (s.groupId && byHead.has(s.groupId)) { byHead.get(s.groupId).members.push(s.id); continue; }
    const u = { id: s.id, members: [s.id], chapterId: s.chapterId ?? null };
    units.push(u); byHead.set(s.id, u);
  }
  return units;
}

let _seq = 0;
const _defaultId = (p) => `${p}_${Date.now().toString(36)}${(++_seq).toString(36)}`;

function _newPage(unit, templateId, newId) {
  return { id: newId('page'), stepIds: [unit.id], templateId, templateAuto: true, images: [{ stepId: unit.members[unit.members.length - 1], auto: true }], flags: [] };
}

/** One page per unit — the starting point; the user merges from there. */
export function autoPaginate(steps, chapters, doc, opts = {}) {
  const newId = opts.newId || _defaultId;
  const tpl = doc?.templateId || 'tpl_standard';
  return unitsOf(steps, chapters, doc?.options).map(u => _newPage(u, tpl, newId));
}

/** The timeline order a document was last laid out against (what reconcile compares the new order to). */
export function orderOf(steps, chapters, doc) {
  return unitsOf(steps, chapters, doc?.options).map(u => u.id);
}

// ─── reconciliation ─────────────────────────────────────────────────────────

const _flag = (page, kind, stepId, note) => {
  if (!page.flags.some(f => f.kind === kind && f.stepId === stepId)) page.flags.push({ kind, stepId: stepId || null, note });
};

/** Indices (into `seq`) of one longest strictly-increasing subsequence. */
function _lis(seq) {
  const tails = [], tailIdx = [], prev = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < seq[i]) lo = mid + 1; else hi = mid; }
    tails[lo] = seq[i]; tailIdx[lo] = i;
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
  }
  const out = [];
  for (let k = tailIdx[tails.length - 1] ?? -1; k >= 0; k = prev[k]) out.push(k);
  return new Set(out);
}

/**
 * Bring the pages back in line with a timeline that changed since they were
 * laid out. NOTHING changes silently — every adjustment leaves a flag on the
 * page it touched, and the report lists them all.
 *
 * WHO MOVED is read from the order itself: the document remembers the order
 * it was last laid out against (doc.order); the steps that kept their
 * relative order (a longest increasing subsequence) stayed put, the others
 * are the movers. A page whose steps ALL moved together, and did not land
 * inside another page's range, simply moved — it keeps everything.
 *
 *   • a step that no longer exists (or is hidden now)   → leaves its page          ('removed')
 *   • a mover                                           → leaves its page          ('moved-out') and is placed like a new step
 *   • a new / moved step whose nearest settled
 *     neighbours on BOTH sides sit on the same page     → joins that page          ('added'; silent if it is the page it came from)
 *   • any other new / moved step                        → gets a page of its own   ('new'), in timeline order
 *   • a chosen picture whose step left the page         → keeps showing it         ('image-left')
 *   • a page with no steps left                         → stays, flagged           ('empty')
 *
 * Page order follows the timeline position of each page's first step.
 * @returns {{pages:Array, order:string[], report:Array<{pageId, kind, stepId, note}>}}
 */
export function reconcile(doc, steps, chapters, opts = {}) {
  const newId = opts.newId || _defaultId;
  const units = unitsOf(steps, chapters, doc?.options);
  const index = new Map(units.map((u, i) => [u.id, i]));
  const unitById = new Map(units.map(u => [u.id, u]));
  const nameOf = (id) => (steps || []).find(s => s.id === id)?.name || id;
  const pages = (doc?.pages || []).map(p => ({ ...p, stepIds: [...(p.stepIds || [])], images: (p.images || []).map(i => ({ ...i })), flags: [...(p.flags || [])] }));
  const before = new Map(pages.map(p => [p.id, p.flags.length]));

  // who was on which page (first claim wins), minus what vanished
  const pageOf = new Map();
  for (const p of pages) {
    const alive = [];
    for (const id of p.stepIds) {
      if (!index.has(id)) { _flag(p, 'removed', id, `"${nameOf(id)}" is no longer in the sequence`); continue; }
      if (pageOf.has(id)) continue;
      pageOf.set(id, p); alive.push(id);
    }
    p.stepIds = alive;
  }

  // movers: claimed units that did not keep their relative order
  const oldOrder = (doc?.order && doc.order.length) ? doc.order : (doc?.pages || []).flatMap(p => p.stepIds || []);
  const oldIdx = new Map(oldOrder.map((id, i) => [id, i]));
  const claimed = units.filter(u => pageOf.has(u.id) && oldIdx.has(u.id));
  const keep = _lis(claimed.map(u => oldIdx.get(u.id)));
  const movers = new Set(claimed.filter((u, i) => !keep.has(i)).map(u => u.id));
  // a page that moved AS A WHOLE (all members movers, still together, not inside another page's range) just moved
  for (const p of pages) {
    if (!p.stepIds.length || !p.stepIds.every(id => movers.has(id))) continue;
    const idxs = p.stepIds.map(id => index.get(id)).sort((a, b) => a - b);
    let together = true;
    for (let k = idxs[0]; k <= idxs[idxs.length - 1]; k++) { const o = pageOf.get(units[k].id); if (o && o !== p) { together = false; break; } }
    const settledPage = (from, dir) => { for (let k = from; k >= 0 && k < units.length; k += dir) { const id = units[k].id; const o = pageOf.get(id); if (o && o !== p && !movers.has(id)) return o; } return null; };
    const L = settledPage(idxs[0] - 1, -1), R = settledPage(idxs[idxs.length - 1] + 1, +1);
    if (together && !(L && L === R)) for (const id of p.stepIds) movers.delete(id);
  }
  const cameFrom = new Map();
  for (const id of movers) { const p = pageOf.get(id); cameFrom.set(id, p); p.stepIds = p.stepIds.filter(x => x !== id); pageOf.delete(id); }

  // place what is not on any page: new steps and movers
  const out = [...pages];
  const settled = new Map(pageOf);   // neighbours are judged against what was settled BEFORE this pass
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (pageOf.has(u.id)) continue;
    let prev = null, next = null;
    for (let k = i - 1; k >= 0; k--) if (settled.has(units[k].id)) { prev = settled.get(units[k].id); break; }
    for (let k = i + 1; k < units.length; k++) if (settled.has(units[k].id)) { next = settled.get(units[k].id); break; }
    const from = cameFrom.get(u.id) || null;
    if (prev && prev === next) {
      prev.stepIds.push(u.id);
      pageOf.set(u.id, prev);
      if (from !== prev) {
        _flag(prev, 'added', u.id, from ? `"${nameOf(u.id)}" was moved into this page's range` : `"${nameOf(u.id)}" was added inside this page's range`);
        if (from) _flag(from, 'moved-out', u.id, `"${nameOf(u.id)}" was moved to another page`);
      }
    } else {
      const np = _newPage(u, doc?.templateId || 'tpl_standard', newId);
      _flag(np, 'new', u.id, from ? `"${nameOf(u.id)}" was moved here — new page` : `New page for "${nameOf(u.id)}"`);
      if (from) _flag(from, 'moved-out', u.id, `"${nameOf(u.id)}" was moved to a page of its own`);
      out.push(np);
      pageOf.set(u.id, np);
    }
  }

  // members in timeline order; pictures; empties
  for (const p of out) {
    p.stepIds.sort((a, b) => index.get(a) - index.get(b));
    if (!p.stepIds.length) { _flag(p, 'empty', null, 'No steps left on this page'); continue; }
    _resolvePictures(p, unitById, nameOf);
  }

  // page order: timeline position of the first step; an empty page stays right after the page it followed
  const key = new Map();
  let run = -1;
  for (const p of out) if (p.stepIds.length) key.set(p, index.get(p.stepIds[0]));
  for (const p of pages) { if (p.stepIds.length) run = key.get(p); else key.set(p, run + 0.5); }
  for (const p of out) if (!key.has(p)) key.set(p, units.length);
  out.sort((a, b) => key.get(a) - key.get(b));

  const report = [];
  for (const p of out) for (const f of p.flags.slice(before.get(p.id) ?? 0)) report.push({ pageId: p.id, ...f });
  return { pages: out, order: units.map(u => u.id), report };
}

/** Slot 0 follows the page's LAST step until the user picks one (auto); a chosen picture whose step left is flagged, not dropped. */
function _resolvePictures(p, unitById, nameOf) {
  const members = new Set(p.stepIds.flatMap(id => unitById.get(id)?.members || []));
  const lastUnit = unitById.get(p.stepIds[p.stepIds.length - 1]);
  const last = lastUnit ? lastUnit.members[lastUnit.members.length - 1] : null;
  if (!p.images || !p.images.length) p.images = [{ stepId: last, auto: true }];
  p.images.forEach((im, k) => {
    if (im.assetId || im.empty) return;                       // an external image / a slot left empty on purpose: nothing to follow
    if (k === 0 && (im.auto || !im.stepId)) { im.stepId = last; im.auto = true; return; }
    if (im.stepId && !members.has(im.stepId)) _flag(p, 'image-left', im.stepId, `Picture ${k + 1} shows "${nameOf ? nameOf(im.stepId) : im.stepId}", which is not on this page any more`);
  });
}

// ─── page edits ─────────────────────────────────────────────────────────────

/** Merge a page into the one before it. The merged page's automatic picture becomes the new last step's. */
export function mergeWithPrevious(pages, pageId) {
  const i = pages.findIndex(p => p.id === pageId);
  if (i <= 0) return pages;
  const prev = pages[i - 1], cur = pages[i];
  const images = (prev.images || []).map(im => ({ ...im }));
  if (!images.length || images[0].auto) images[0] = { ...(cur.images?.[0] || { stepId: null }), auto: true };
  const merged = { ...prev, stepIds: [...prev.stepIds, ...cur.stepIds], images, flags: [...(prev.flags || []), ...(cur.flags || [])] };
  return [...pages.slice(0, i - 1), merged, ...pages.slice(i + 1)];
}

/** Split a page so that `stepId` starts a new page. Automatic pictures re-resolve at the next reconcile / render. */
export function splitBefore(pages, pageId, stepId, opts = {}) {
  const newId = opts.newId || _defaultId;
  const i = pages.findIndex(p => p.id === pageId);
  if (i < 0) return pages;
  const p = pages[i];
  const k = p.stepIds.indexOf(stepId);
  if (k <= 0) return pages;
  const a = { ...p, stepIds: p.stepIds.slice(0, k) };
  const b = { id: newId('page'), stepIds: p.stepIds.slice(k), templateId: p.templateId, templateAuto: p.templateAuto, images: [{ stepId: null, auto: true }], flags: [] };
  return [...pages.slice(0, i), a, b, ...pages.slice(i + 1)];
}

/**
 * "Merge these steps into one page" — the workspace's multi-select action.
 * The selection is widened to the whole timeline RANGE first..last (a page is
 * a run of the sequence; a page holding steps 25 and 28 but not 26–27 would
 * read as a mistake in print). Steps outside the range stay on their pages.
 * The first page that lies wholly inside the range becomes the merged page
 * (keeps its id / template / picture choices); if none does, a new page is made.
 * @param {Array} pages
 * @param {string[]} unitIds   selected units (any order)
 * @param {string[]} order     all units in timeline order (orderOf)
 * @returns {{pages:Array, pageId:string|null, range:string[]}}
 */
export function mergeUnits(pages, unitIds, order, opts = {}) {
  const newId = opts.newId || _defaultId;
  const idx = new Map((order || []).map((id, i) => [id, i]));
  const sel = (unitIds || []).filter(id => idx.has(id)).sort((a, b) => idx.get(a) - idx.get(b));
  if (!sel.length) return { pages, pageId: null, range: [] };
  const range = order.slice(idx.get(sel[0]), idx.get(sel[sel.length - 1]) + 1);
  const inRange = new Set(range);
  const onPages = new Set(pages.flatMap(p => p.stepIds || []));
  const members = range.filter(id => onPages.has(id));          // a step no page holds yet (pending sync) is not pulled in
  const touched = pages.filter(p => (p.stepIds || []).some(id => inRange.has(id)));
  if (touched.length <= 1) return { pages, pageId: touched[0]?.id || null, range };   // already one page
  let target = touched.find(p => p.stepIds.every(id => inRange.has(id))) || null;
  const made = !target;
  if (made) target = { id: newId('page'), stepIds: [], templateId: touched[0].templateId, templateAuto: touched[0].templateAuto, images: [{ stepId: null, auto: true }], flags: [] };
  const out = [];
  for (const p of pages) {
    if (p === target) { out.push(null); continue; }              // placeholder — filled below
    const keep = (p.stepIds || []).filter(id => !inRange.has(id));
    if (keep.length === (p.stepIds || []).length) { out.push(p); continue; }
    if (!keep.length) continue;                                  // wholly inside → folded into the target
    out.push({ ...p, stepIds: keep, images: (p.images || []).map(im => ({ ...im })) });
    if (made && p === touched[0]) out.push(null);                // a new page sits right after the first page it took from
  }
  const flags = [...(target.flags || [])];
  for (const p of touched) if (p !== target) for (const f of (p.flags || [])) if (inRange.has(f.stepId) && !flags.some(x => x.kind === f.kind && x.stepId === f.stepId)) flags.push(f);
  const merged = { ...target, stepIds: members, images: (target.images || []).map(im => ({ ...im })), flags };
  const at = out.indexOf(null);
  const res = out.filter(Boolean);
  res.splice(at < 0 ? res.length : out.slice(0, at).filter(Boolean).length, 0, merged);
  // page order = timeline position of each page's first step (empties stay where they were)
  // by its first LIVE step: a page whose leading step was just deleted from the animation (not synced yet) must not jump to the end
  const key = (p) => { const first = (p.stepIds || []).find(id => idx.has(id)); return first === undefined ? null : idx.get(first); };
  const filled = res.filter(p => key(p) !== null).sort((a, b) => key(a) - key(b));
  let k = 0;
  const pagesOut = res.map(p => (key(p) === null ? p : filled[k++]));
  return { pages: pagesOut, pageId: merged.id, range };
}

/** Give every step of a page its own page again (the first keeps the page's id, template and pictures). */
export function splitAll(pages, pageId, opts = {}) {
  const newId = opts.newId || _defaultId;
  const i = pages.findIndex(p => p.id === pageId);
  if (i < 0 || (pages[i].stepIds || []).length < 2) return pages;
  const p = pages[i];
  const parts = p.stepIds.map((id, k) => k === 0
    ? { ...p, stepIds: [id], images: [{ stepId: null, auto: true }, ...(p.images || []).slice(1).map(() => ({ stepId: null }))] }
    : { id: newId('page'), stepIds: [id], templateId: p.templateId, templateAuto: p.templateAuto, images: [{ stepId: null, auto: true }], flags: [] });
  return [...pages.slice(0, i), ...parts, ...pages.slice(i + 1)];
}

export function clearFlags(pages, pageId = null) {
  return pages.map(p => (pageId && p.id !== pageId) ? p : { ...p, flags: [] });
}

// ─── text ───────────────────────────────────────────────────────────────────

/**
 * The document text of one step: the voiceover until someone edits it; from
 * then on an independent copy that remembers which voiceover it was written
 * against, so a later change to the narration shows up as DRIFT instead of
 * silently replacing (or being ignored by) the document.
 */
export function docTextFor(step, texts, hashOf) {
  const narr = narrationOf(step);
  const e = texts?.[step?.id];
  if (!e) return { text: narr, edited: false, drifted: false };
  return { text: String(e.text ?? ''), edited: true, drifted: !!e.srcHash && e.srcHash !== hashOf(narr) };
}

// ─── reading direction ──────────────────────────────────────────────────────

const _RTL_RX = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/g, _LTR_RX = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/g;

/**
 * The document's reading direction. 'auto' counts letters over everything the document
 * prints (its own texts where they exist, the voiceover elsewhere, the title): more
 * right-to-left letters than left-to-right ones → rtl. lang = 'he' | 'ar' | null picks
 * the wording of the built-in header / footer phrases.
 */
export function directionOf(doc, steps, chapters) {
  const pick = doc?.options?.direction;
  let text = String(doc?.fields?.title || '');
  for (const u of unitsOf(steps, chapters, doc?.options)) for (const sid of u.members) {
    const st = (steps || []).find(x => x.id === sid);
    text += ' ' + (doc?.texts?.[sid]?.text ?? narrationOf(st));
  }
  const he = (text.match(/[\u0590-\u05FF]/g) || []).length, ar = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const rtlN = (text.match(_RTL_RX) || []).length, ltrN = (text.match(_LTR_RX) || []).length;
  const detected = rtlN > ltrN ? 'rtl' : 'ltr';
  const dir = pick === 'rtl' || pick === 'ltr' ? pick : detected;
  return { dir, detected, lang: dir === 'rtl' ? (ar > he ? 'ar' : 'he') : null };
}

// The phrases a new document starts with. A right-to-left document that still carries them
// (nobody re-worded the header / footer) prints them in its own language.
const _PHRASES = {
  'Page {page} / {pages}': { he: 'עמוד {page} מתוך {pages}', ar: 'صفحة {page} من {pages}' },
  '{docNo} · rev {rev}':   { he: '{docNo} · מהדורה {rev}',   ar: '{docNo} · إصدار {rev}' },
};
const _phrase = (tpl, lang) => (lang && _PHRASES[tpl]?.[lang]) || tpl;

// ─── pictures in slots ──────────────────────────────────────────────────────

const _clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

/** A slot's fit, sanitised. zoom 1 = the picture exactly FILLS the slot (cropped); ox / oy = its centre's offset, in slot widths / heights. */
export function fitOf(im) {
  const f = im?.fit || {};
  return { zoom: _clampN(f.zoom, 0.05, 20, 1), ox: _clampN(f.ox, -5, 5, 0), oy: _clampN(f.oy, -5, 5, 0) };
}

/**
 * Where a picture of the given aspect sits in a slot: its width in % of the
 * slot width, and its centre's offset from the slot centre in mm. The slot
 * clips it; where the picture does not reach, the white page shows.
 */
export function pictureBox(rect, aspect, fit) {
  const a = aspect > 0 ? aspect : 16 / 9;
  const f = fitOf({ fit });
  const cover = Math.max(1, a / (rect.w / rect.h)) * 100;       // fills the slot on both axes
  return { widthPct: cover * f.zoom, dxMm: f.ox * rect.w, dyMm: f.oy * rect.h };
}

// ─── zooming a picture inside its frame (V0.3.4.29) ────────────────────────
// One place for every step size, so the wheel, the buttons and the typed
// percentage can never disagree. Fill = zoom 1 = 100%, so the number the user
// types IS the zoom, times a hundred.

/** What the picture bar offers: 10% … 800%. (The stored range stays wider, so
 *  no existing document is re-clamped behind the user's back.) */
export const ZOOM_UI_MIN = 0.1;
export const ZOOM_UI_MAX = 8;
/** − and + on the bar. */
export const ZOOM_BUTTON_STEP = 0.05;
/** One wheel notch — finer than the buttons, as asked. Ctrl = fine, Shift = coarse. */
export const ZOOM_WHEEL_STEP   = 0.02;
export const ZOOM_WHEEL_FINE   = 0.005;
export const ZOOM_WHEEL_COARSE = 0.10;

export function clampUiZoom(z) { return _clampN(z, ZOOM_UI_MIN, ZOOM_UI_MAX, 1); }

/**
 * How many NOTCHES one wheel event is worth — and never more than one.
 *
 * `deltaY` is not a count: a plain mouse sends ±100 per notch, a trackpad sends
 * a stream of small fractions, and a free-spinning wheel (or an inertial
 * trackpad fling) sends single events of 300–600. Scaling the zoom by the raw
 * delta is what made one flick jump ~20% and, on a big inertial event, snap the
 * picture right out — the "abrupt zoom out" mid-gesture. Small deltas still
 * give smooth fractions; huge ones are capped.
 */
export function wheelNotches(e) {
  const dy = Number(e?.deltaY) || 0;
  const raw = e?.deltaMode === 1 ? dy / 3            // lines
            : e?.deltaMode === 2 ? dy                // pages
            : dy / 100;                              // pixels (the usual)
  return Math.max(-1, Math.min(1, raw));
}

/** The zoom one wheel event lands on. Up = bigger. */
export function zoomAfterWheel(zoom, e) {
  const step = e?.ctrlKey || e?.metaKey ? ZOOM_WHEEL_FINE
             : e?.shiftKey ? ZOOM_WHEEL_COARSE
             : ZOOM_WHEEL_STEP;
  return clampUiZoom(Number(zoom) * Math.pow(1 + step, -wheelNotches(e)));
}

/** The zoom a − / + press lands on (`dir` = −1 or +1). Exactly reversible. */
export function zoomAfterButton(zoom, dir) {
  return clampUiZoom(Number(zoom) * Math.pow(1 + ZOOM_BUTTON_STEP, dir < 0 ? -1 : 1));
}

/** What the bar shows: a whole percent. */
export function zoomPercent(zoom) { return Math.round((Number(zoom) || 1) * 1000) / 10; }
/** …and what a typed percent means. Junk keeps the current value. */
export function zoomFromPercent(pct, fallback = 1) {
  const n = parseFloat(String(pct).replace(/[^\d.+-]/g, ''));
  return Number.isFinite(n) && n > 0 ? clampUiZoom(n / 100) : clampUiZoom(fallback);
}

/** The zoom at which the WHOLE picture is visible inside the slot (nothing cropped). */
export function containZoom(rect, aspect) {
  const a = aspect > 0 ? aspect : 16 / 9, sa = rect.w / rect.h;
  return Math.min(1, a / sa) / Math.max(1, a / sa);
}

export const ASSET_URL_RX = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+\/=]+$/i;

// ─── the document as a SEQUENCE ─────────────────────────────────────────────
// Step pages follow the animation — their order is not the user's to change. Everything
// else the document prints is an EXTRA: the table of contents and the custom pages. An extra
// is anchored BEFORE a step ('@start' · a unit id · '@end'), so it keeps its place when pages
// are joined, split or re-synced; extras that share an anchor keep their order in doc.extras.

export const TOC_ID = '@toc';
export const TOC_LINES = 26;                       // chapter lines per contents page: 26 × 8.1 mm + the title fit the 238 mm content area with room to spare
const TOC_TITLE = { en: 'Contents', he: 'תוכן עניינים', ar: 'المحتويات' };

/** doc.extras, well-formed. The contents has a place even in a document saved before it could be moved: the front. */
export function extrasOf(doc) {
  const list = (Array.isArray(doc?.extras) ? doc.extras : []).filter(x => x && x.id && (x.kind === 'custom' || x.kind === 'toc'));
  const seen = new Set(), out = [];
  for (const x of list) { const id = x.kind === 'toc' ? TOC_ID : String(x.id); if (seen.has(id)) continue; seen.add(id); out.push(x.kind === 'toc' ? { ...x, id: TOC_ID } : x); }
  return out.some(x => x.kind === 'toc') ? out : [{ id: TOC_ID, kind: 'toc', beforeUnit: '@start' }, ...out];
}

/**
 * Everything the document holds, in reading order: [{kind:'page', page} | {kind:'toc', extra} | {kind:'custom', extra}].
 * Over ALL pages (printed or not) — the workspace list shows this; the render model numbers the printed ones.
 * @param {string[]} order   all units in timeline order (orderOf) — used when an anchor's step is gone
 */
export function sequenceOf(doc, order) {
  const pages = doc?.pages || [];
  const at = new Map();
  pages.forEach((p, i) => { for (const id of p.stepIds || []) if (!at.has(id)) at.set(id, i); });
  const pos = new Map((order || []).map((id, i) => [id, i]));
  const indexOf = (x) => {
    const a = x.beforeUnit;
    if (a === '@end') return pages.length;
    if (!a || a === '@start') return 0;
    if (at.has(a)) return at.get(a);
    // its step is gone (deleted / hidden in the animation): the next surviving step keeps the place
    if (pos.has(a)) for (let k = pos.get(a) + 1; k < order.length; k++) if (at.has(order[k])) return at.get(order[k]);
    return pages.length;
  };
  const byIndex = new Map();
  for (const x of extrasOf(doc)) { const i = indexOf(x); if (!byIndex.has(i)) byIndex.set(i, []); byIndex.get(i).push(x); }
  const seq = [];
  for (let i = 0; i <= pages.length; i++) {
    for (const x of byIndex.get(i) || []) seq.push({ kind: x.kind, id: x.id, extra: x });
    if (i < pages.length) seq.push({ kind: 'page', id: pages[i].id, page: pages[i] });
  }
  return seq;
}

/**
 * Put an extra at position `index` of the sequence (as if it had first been taken out).
 * Returns the new doc.extras — EVERY extra re-anchored canonically from the resulting order:
 * '@start' if no step page precedes it, else before the first step of the next step page, else '@end'.
 */
export function moveExtra(doc, extraId, index, order) {
  const seq = sequenceOf(doc, order).filter(e => e.id !== extraId);
  const moving = extrasOf(doc).find(x => x.id === extraId);
  if (!moving) return extrasOf(doc);
  seq.splice(Math.max(0, Math.min(seq.length, index)), 0, { kind: moving.kind, id: moving.id, extra: moving });
  return _reanchor(seq);
}
function _reanchor(seq) {
  const out = [];
  seq.forEach((e, i) => {
    if (e.kind === 'page') return;
    const pageBefore = seq.slice(0, i).some(s => s.kind === 'page' && (s.page.stepIds || []).length);
    const next = seq.slice(i + 1).find(s => s.kind === 'page' && (s.page.stepIds || []).length);
    out.push({ ...e.extra, beforeUnit: !pageBefore ? '@start' : next ? next.page.stepIds[0] : '@end' });
  });
  return out;
}

// ─── custom pages ───────────────────────────────────────────────────────────
// A page that is NOT made of steps: a cover, a safety notice, a parts list. The header and the
// footer are the document's; between them the user places text boxes and pictures freely (mm).
// Text wears the document's body font — only size, weight, slant, alignment and colour vary.

export const MAX_CUSTOM_ITEMS = 60;
const _hex = (c, d) => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : d);

export function sanitizeCustomItem(it, area = CONTENT_MM) {
  const rect = clampRect(it, area === CONTENT_MM ? 5 : 3, area === CONTENT_MM ? 4 : 2, area);
  const base = { id: String(it?.id || ''), ...rect };
  if (it?.type === 'image') {
    const at = Math.round(Number(it?.atMs));
    return { ...base, type: 'image', assetId: String(it.assetId || ''), stepId: it.stepId ? String(it.stepId) : '',
      moment: it.moment === 'start' ? 'start' : 'end', logo: !!it.logo, fit: fitOf(it),
      // the frame of a video step this picture is taken at (V0.3.4.30); absent = the clip's first frame
      ...(Number.isFinite(at) && at >= 0 ? { atMs: at } : {}) };
  }
  return {
    ...base, type: 'text', text: String(it?.text ?? '').slice(0, 8000),
    size: _clampN(it?.size, 6, 120, 11), bold: !!it?.bold, italic: !!it?.italic,
    align: ['start', 'center', 'end'].includes(it?.align) ? it.align : 'start', color: _hex(it?.color, '#111111'),
  };
}
export function sanitizeCustomPage(x) {
  return { id: String(x?.id || ''), kind: 'custom', beforeUnit: x?.beforeUnit || '@end', name: String(x?.name || 'Custom page').slice(0, 80),
    items: (Array.isArray(x?.items) ? x.items : []).slice(0, MAX_CUSTOM_ITEMS).map(it => sanitizeCustomItem(it)) };      // NOT .map(sanitizeCustomItem): map's index would arrive as the clamp area
}

// ─── header / footer bands ──────────────────────────────────────────────────
// Until somebody edits them the header and the footer are three text cells (left / centre /
// right) and the project's logo. Editing turns a band into FREE ITEMS — the same records as a
// custom page's, clamped to the band: text (it may carry {title} {company} {docNo} {rev}
// {project} {chapter} {chapterNo} {page} {pages} {date}) and pictures (a file, or the project's
// logo). doc.bands = { header:{items,rule}, footer:{items,rule} }; a missing side stays classic.

export const BAND_MM = Object.freeze({ header: Object.freeze({ x: 12, y: 10, w: 186, h: 18 }), footer: Object.freeze({ x: 12, y: 275, w: 186, h: 12 }) });
export const BAND_FIELDS = ['title', 'company', 'docNo', 'rev', 'project', 'chapter', 'chapterNo', 'page', 'pages', 'date'];
export const MAX_BAND_ITEMS = 12;

/** The classic layout as free items — what the editor starts from, so "customise" changes nothing until the user does. */
export function defaultBandItems(side, doc, hasLogo = false) {
  const B = BAND_MM[side], head = side === 'header';
  const t = (id, x, w, text, align, bold) => ({ id: `${side[0]}_${id}`, type: 'text', x, y: head ? B.y + 2 : B.y + 3, w, h: head ? 12 : 7, text: String(text || ''), size: head ? 9.5 : 8.5, bold: !!bold, italic: false, align, color: head ? '#111111' : '#333333' });
  const src = (head ? doc?.header : doc?.footer) || {};
  const logoW = head && hasLogo ? 32 : 0;
  const items = [
    t('l', B.x + (logoW ? logoW + 3 : 0), 58 - (logoW ? logoW + 3 : 0), src.left, 'start', false),
    t('c', B.x + 60, 66, src.center, 'center', true),
    t('r', B.x + 128, 58, src.right, 'end', false),
  ];
  if (logoW) items.unshift({ id: 'h_logo', type: 'image', logo: true, x: B.x, y: B.y, w: logoW, h: 14, fit: { zoom: containZoom({ w: logoW, h: 14 }, 3), ox: 0, oy: 0 } });
  return items.map(it => sanitizeCustomItem(it, B));
}

/** doc.bands, well-formed: { header: null | {items, rule}, footer: … } — null = the classic three cells. */
export function bandsOf(doc) {
  const out = {};
  for (const side of ['header', 'footer']) {
    const b = doc?.bands?.[side];
    out[side] = (b && Array.isArray(b.items)) ? { rule: b.rule !== false, items: b.items.slice(0, MAX_BAND_ITEMS).map(it => sanitizeCustomItem(it, BAND_MM[side])) } : null;
  }
  return out;
}

// ─── render model ───────────────────────────────────────────────────────────

const _sub = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m));

/**
 * Everything the HTML / PDF builder needs, already resolved.
 * @param {Object} doc
 * @param {Array}  steps
 * @param {Array}  chapters
 * @param {{projectName:string, date?:string, hashOf:(t:string)=>string, perChapter?:boolean, stillAspect?:number}} ctx
 * @returns {{sequence:Array, pages:Array, customs:Array, toc:Object|null, total:number, watermark, dir, lang}}
 *   sequence = what prints, in order: {kind:'toc'|'page'|'custom', id, number, model}
 */
export function buildRenderModel(doc, steps, chapters, ctx) {
  const stepById = new Map((steps || []).map(s => [s.id, s]));
  const units = unitsOf(steps, chapters, doc?.options);
  const unitById = new Map(units.map(u => [u.id, u]));
  const nums = numberSteps(steps, chapters, !!ctx?.perChapter);
  const hidden = new Set(doc?.hiddenSteps || []);
  const shown = (id) => unitById.has(id) && !hidden.has(id);
  const prints = (p) => (p.stepIds || []).some(shown);                                  // a page whose steps are all hidden is not printed
  const reading = directionOf(doc, steps, chapters);
  const headOf = new Map(); for (const u of units) for (const m of u.members) headOf.set(m, u.id);
  const chapterOfPage = (p) => { const f = stepById.get((p.stepIds || []).find(shown)); return (chapters || []).find(c => c.id === f?.chapterId) || null; };

  // ── what prints, in order ──
  const seq = sequenceOf(doc, units.map(u => u.id)).filter(e => e.kind !== 'page' || prints(e.page));
  // The contents: one line per chapter that actually prints. Its LENGTH is known before anything is numbered
  // (lines = chapters), so there is no chicken-and-egg: it takes ceil(lines / TOC_LINES) pages where it stands.
  const chapterStarts = [];
  { let prev = null; for (const e of seq) if (e.kind === 'page') { const ch = chapterOfPage(e.page); if (ch && ch.id !== prev) chapterStarts.push({ ch, pageId: e.page.id }); prev = ch ? ch.id : prev; } }
  const tocOn = doc?.options?.toc !== false && chapterStarts.length > 0;
  const tocPageCount = tocOn ? Math.ceil(chapterStarts.length / TOC_LINES) : 0;
  const printed = seq.filter(e => e.kind !== 'toc' || tocOn);
  let n = 0;
  const numberOf = new Map();
  for (const e of printed) { numberOf.set(e.id, n + 1); n += e.kind === 'toc' ? tocPageCount : 1; }
  const total = n;

  const varsFor = (number, ch) => {
    const chIdx = ch ? (chapters || []).indexOf(ch) : -1;
    return { ...(doc.fields || {}), project: ctx?.projectName || '', date: ctx?.date || '', chapter: ch ? ch.name : '', chapterNo: chIdx >= 0 ? chIdx + 1 : '', page: number, pages: total };
  };
  const custom = bandsOf(doc);
  const pageW = 210;
  const bandItems = (side, vars) => (!custom[side] ? null : {
    rule: custom[side].rule,
    items: custom[side].items.map(it => {
      const m = reading.dir === 'rtl' ? { ...it, x: pageW - it.x - it.w } : it;           // a right-to-left page mirrors its bands like its picture frames
      if (m.type !== 'image') return { ...m, text: _sub(_phrase(m.text, reading.lang), vars) };
      const a = m.logo ? null : doc?.assets?.[m.assetId];
      const good = a && ASSET_URL_RX.test(String(a.dataUrl || '')) && a.w > 0 && a.h > 0;
      return { ...m, src: good ? a.dataUrl : null, aspect: good ? a.w / a.h : (ctx?.logoAspect > 0 ? ctx.logoAspect : 3) };
    }),
  });
  const bands = (vars) => {
    const H = (side) => _sub(_phrase(doc.header?.[side], reading.lang), vars), F = (side) => _sub(_phrase(doc.footer?.[side], reading.lang), vars);
    return { header: { left: H('left'), center: H('center'), right: H('right') }, footer: { left: F('left'), center: F('center'), right: F('right') },
      bandItems: { header: bandItems('header', vars), footer: bandItems('footer', vars) } };
  };

  let prevChapter = null;
  const pageModel = (p) => {
    const number = numberOf.get(p.id);
    const tpl = templateById(doc, p.templateId);
    const ch = chapterOfPage(p);
    const chapterHead = !!ch && ch.id !== prevChapter;          // the chapter's FIRST page (its title is a real heading there → a PDF bookmark); every page shows the name
    prevChapter = ch ? ch.id : prevChapter;
    const items = [];
    let k = 0;
    for (const uid of p.stepIds) {
      const u = unitById.get(uid);
      if (!u || hidden.has(uid)) continue;
      for (const sid of u.members) {
        const s = stepById.get(sid);
        if (!s) continue;
        const t = docTextFor(s, doc.texts, ctx.hashOf);
        if (!t.text.trim() && sid !== u.id) continue;        // a silent sub-step adds no line
        k++;
        const label = doc.options?.numbering === 'none' ? '' : doc.options?.numbering === 'page' ? String(k) : (nums.get(sid)?.label || '');
        items.push({ stepId: sid, label, name: s.name || '', text: t.text, edited: t.edited, drifted: t.drifted });
      }
    }
    return {
      id: p.id, number, total, template: tpl, ...bands(varsFor(number, ch)),
      chapter: ch ? ch.name : '', chapterHead, items,
      images: (tpl.images || []).map((rect, i) => {
        // right-to-left: the FIRST picture is the right-hand one — mirror the frame across the page
        const r = reading.dir === 'rtl' ? { ...rect, x: (tpl.page?.w || 210) - rect.x - rect.w } : rect;
        const im = _slotOf(p, i, r, (tpl.images || []).length, unitById, hidden, doc, ctx);
        // the number the picture refers to = the number of its line on this page (a silent sub-step borrows its step's)
        let label = '';
        if (im.stepId && doc.options?.pictureNumbers !== false && (items.length > 1 || im.moment === 'start')) {
          label = (items.find(x => x.stepId === im.stepId) || items.find(x => x.stepId === headOf.get(im.stepId)))?.label || '';
        }
        return { ...im, label, key: im.stepId ? stillKey(im.stepId, im.moment, im.atMs) : null };
      }),
      flags: p.flags || [],
    };
  };
  const customModel = (x) => {
    const c = sanitizeCustomPage(x), number = numberOf.get(x.id);
    return {
      id: c.id, kind: 'custom', number, total, name: c.name, template: templateById(doc, doc?.templateId), ...bands(varsFor(number, null)),
      items: c.items.map(it => {
        if (it.type !== 'image') return it;
        // a picture taken from the ANIMATION: rendered on demand like a page picture (end of the step, or its BEFORE frame)
        if (it.stepId) return stepById.has(it.stepId) ? { ...it, src: null, key: stillKey(it.stepId, it.moment, it.atMs), aspect: ctx?.stillAspect > 0 ? ctx.stillAspect : 16 / 9, label: nums.get(it.stepId)?.label || '' } : { ...it, src: null, stepId: '', aspect: 16 / 9 };
        const a = doc?.assets?.[it.assetId];
        const good = a && ASSET_URL_RX.test(String(a.dataUrl || '')) && a.w > 0 && a.h > 0;
        return { ...it, src: good ? a.dataUrl : null, aspect: good ? a.w / a.h : 1, name: good ? (a.name || '') : '' };
      }),
    };
  };

  const pages = [], customs = [], sequence = [];
  let toc = null;
  for (const e of printed) {
    if (e.kind === 'page') { const m = pageModel(e.page); pages.push(m); sequence.push({ kind: 'page', id: m.id, number: m.number, model: m }); }
    else if (e.kind === 'custom') { const m = customModel(e.extra); customs.push(m); sequence.push({ kind: 'custom', id: m.id, number: m.number, model: m }); }
    else {
      const first = numberOf.get(TOC_ID);
      toc = {
        title: TOC_TITLE[reading.lang] || TOC_TITLE.en, number: first,
        pages: Array.from({ length: tocPageCount }, (_, i) => ({
          id: `${TOC_ID}${i ? i + 1 : ''}`, number: first + i, total, template: templateById(doc, doc?.templateId), ...bands(varsFor(first + i, null)),
          first: i === 0,
          lines: chapterStarts.slice(i * TOC_LINES, (i + 1) * TOC_LINES).map(l => ({ no: (chapters || []).indexOf(l.ch) + 1, name: l.ch.name, page: numberOf.get(l.pageId) })),
        })),
      };
      sequence.push({ kind: 'toc', id: TOC_ID, number: first, model: toc });
    }
  }
  return { sequence, pages, customs, toc, total, watermark: watermarkOf(doc), dir: reading.dir, lang: reading.lang };
}


/**
 * What a slot shows. AUTOMATIC slots share out the page's visible steps so the
 * LAST slot always shows the page's final state: with n slots and m steps, slot k
 * shows step m − n + k (3 steps in a 2-picture page → steps 2 and 3); with fewer
 * steps than slots the first m slots are used. A missing entry counts as automatic
 * (a page switched to a template with more slots). An external image wins over both.
 */
export function slotState(p, k) {
  const im = p.images?.[k];
  if (!im) return 'auto';
  if (im.assetId) return 'asset';
  if (im.auto) return 'auto';
  if (im.stepId) return 'step';
  return k === 0 && !im.empty ? 'auto' : 'empty';        // legacy: slot 0 without a choice was always automatic
}
function _slotOf(p, k, rect, nSlots, unitById, hidden, doc, ctx) {
  const im = p.images?.[k] || null;
  const state = slotState(p, k);
  // The chosen video frame rides on the slot model too (V0.3.4.32) — without it
  // stillKey below never saw the time, so a picked frame changed nothing at all.
  const _at = Math.round(Number(im?.atMs));
  const base = { rect, fit: fitOf(im), state, stepId: null, moment: 'end', assetId: null, src: null,
    ...(Number.isFinite(_at) && _at >= 0 ? { atMs: _at } : {}),
    aspect: ctx?.stillAspect > 0 ? ctx.stillAspect : 16 / 9 };
  if (state === 'asset') {
    const a = doc?.assets?.[im.assetId];
    if (a && ASSET_URL_RX.test(String(a.dataUrl || '')) && a.w > 0 && a.h > 0) return { ...base, assetId: im.assetId, src: a.dataUrl, aspect: a.w / a.h, name: a.name || '' };
    return { ...base, state: 'empty' };
  }
  if (state === 'step') return { ...base, stepId: im.stepId, moment: im.moment === 'start' ? 'start' : 'end' };
  if (state === 'auto') {
    const units = (p.stepIds || []).filter(id => unitById.has(id) && !hidden.has(id)).map(id => unitById.get(id));
    const i = units.length >= nSlots ? units.length - nSlots + k : k;
    const u = units[i];
    return { ...base, stepId: u ? u.members[u.members.length - 1] : null };
  }
  return base;
}

/**
 * A step can be pictured at two moments: 'end' — its final state (the usual picture) — and
 * 'start' — the state it begins from: the PREVIOUS step's end state seen through THIS step's
 * camera, i.e. the "before" of a before / after pair. Key: "<stepId>" or "<stepId>@start".
 *
 * A step holding a VIDEO can also be pictured at a chosen FRAME of that clip
 * (V0.3.4.30) — key "<stepId>@t<ms>". The time is part of the key, so two
 * frames of one clip are two different pictures and can sit side by side on
 * the same page.
 */
export const stillKey = (stepId, moment, atMs) => {
  // A BEFORE picture is the previous step's end state seen from this step's
  // camera — it draws no overlay at all, so a clip frame means nothing there.
  if (moment === 'start') return `${stepId}@start`;
  const t = Math.round(Number(atMs));
  return (Number.isFinite(t) && t >= 0) ? `${stepId}@t${t}` : String(stepId);
};
export const parseStillKey = (key) => {
  const s = String(key);
  const m = /^(.+)@t(\d+)$/.exec(s);
  if (m) return { stepId: m[1], moment: 'end', atMs: Number(m[2]) };
  return s.endsWith('@start') ? { stepId: s.slice(0, -6), moment: 'start' } : { stepId: s, moment: 'end' };
};

/** Every picture a document needs rendered — as still keys. */
export function stillsNeeded(model) {
  const out = new Set();
  for (const p of model.pages || []) for (const im of p.images) if (im.stepId) out.add(im.key || stillKey(im.stepId, im.moment, im.atMs));
  for (const c of model.customs || []) for (const it of c.items) if (it.type === 'image' && it.stepId) out.add(it.key || stillKey(it.stepId, it.moment, it.atMs));
  return [...out];
}

/** Human label of a page's range: "Steps 3–5 · Chapter 2". */
export function pageRangeLabel(page, steps, chapters, perChapter = false, hiddenSteps = null) {
  const nums = numberSteps(steps, chapters, perChapter);
  const hid = new Set(hiddenSteps || []);
  const labels = (page.stepIds || []).filter(id => !hid.has(id)).map(id => nums.get(id)?.label).filter(Boolean);
  if (!labels.length) return (page.stepIds || []).length ? '(all its steps are hidden)' : '(no steps)';
  const first = labels[0], last = labels[labels.length - 1];
  const ch = nums.get((page.stepIds || []).find(id => !hid.has(id)))?.chapterLabel || '';
  return `${labels.length > 1 ? `Steps ${first}–${last}` : `Step ${first}`}${ch ? ` · ${ch}` : ''}`;
}
