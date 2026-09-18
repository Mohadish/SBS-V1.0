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

/** The prefab templates every document starts with. Strict by design: a picture lives in a slot, nowhere else. */
export function builtinTemplates() {
  return [
    {
      id: 'tpl_standard', name: 'Standard — text above, picture below', builtin: true,
      page: { w: 210, h: 297 }, header: { x: 12, y: 10, w: 186, h: 18 }, footer: { x: 12, y: 275, w: 186, h: 12 },
      text: { x: 12, y: 32, w: 186, h: 126 },
      images: [_img169(12, 164, 186)],
    },
    {
      id: 'tpl_two', name: 'Two pictures side by side', builtin: true,
      page: { w: 210, h: 297 }, header: { x: 12, y: 10, w: 186, h: 18 }, footer: { x: 12, y: 275, w: 186, h: 12 },
      text: { x: 12, y: 32, w: 186, h: 176 },
      images: [_img169(12, 214, 91), _img169(107, 214, 91)],
    },
    {
      id: 'tpl_picture', name: 'Large picture, short text', builtin: true,
      page: { w: 210, h: 297 }, header: { x: 12, y: 10, w: 186, h: 18 }, footer: { x: 12, y: 275, w: 186, h: 12 },
      text: { x: 12, y: 32, w: 186, h: 60 },
      images: [_img169(12, 98, 186), _img169(12, 98 + 104.6 + 4, 120)],
    },
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
    options: { includeHidden: false, numbering: 'step' },   // 'step' = the animation's step numbers · 'page' = 1,2,3 per page · 'none'
    pages: [],
    texts: {},                           // stepId → { text, srcHash }   (absent = follows the voiceover)
    watermark: { ...WATERMARK_DEFAULTS },
  };
}

export function templateById(doc, id) {
  return (doc?.templates || []).find(t => t.id === id) || builtinTemplates().find(t => t.id === id) || builtinTemplates()[0];
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
  return { id: newId('page'), stepIds: [unit.id], templateId, images: [{ stepId: unit.members[unit.members.length - 1], auto: true }], flags: [] };
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
  const b = { id: newId('page'), stepIds: p.stepIds.slice(k), templateId: p.templateId, images: [{ stepId: null, auto: true }], flags: [] };
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
  if (made) target = { id: newId('page'), stepIds: [], templateId: touched[0].templateId, images: [{ stepId: null, auto: true }], flags: [] };
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
    : { id: newId('page'), stepIds: [id], templateId: p.templateId, images: [{ stepId: null, auto: true }], flags: [] });
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

// ─── render model ───────────────────────────────────────────────────────────

const _sub = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m));

/**
 * Everything the HTML / PDF builder needs, already resolved.
 * @param {Object} doc
 * @param {Array}  steps
 * @param {Array}  chapters
 * @param {{projectName:string, date?:string, hashOf:(t:string)=>string, perChapter?:boolean}} ctx
 */
export function buildRenderModel(doc, steps, chapters, ctx) {
  const stepById = new Map((steps || []).map(s => [s.id, s]));
  const units = unitsOf(steps, chapters, doc?.options);
  const unitById = new Map(units.map(u => [u.id, u]));
  const nums = numberSteps(steps, chapters, !!ctx?.perChapter);
  const live = (doc?.pages || []).filter(p => (p.stepIds || []).some(id => unitById.has(id)));
  const total = live.length;
  let prevChapter = null;
  const pages = live.map((p, pi) => {
    const tpl = templateById(doc, p.templateId);
    const first = stepById.get(p.stepIds.find(id => unitById.has(id)));
    const ch = (chapters || []).find(c => c.id === first?.chapterId) || null;
    const chapterHead = !!ch && ch.id !== prevChapter;          // the chapter title prints once, on the chapter's first page
    prevChapter = ch ? ch.id : prevChapter;
    const chIdx = ch ? (chapters || []).indexOf(ch) : -1;
    const vars = {
      ...(doc.fields || {}), project: ctx?.projectName || '', date: ctx?.date || '',
      chapter: ch ? ch.name : '', chapterNo: chIdx >= 0 ? chIdx + 1 : '', page: pi + 1, pages: total,
    };
    const items = [];
    let n = 0;
    for (const uid of p.stepIds) {
      const u = unitById.get(uid);
      if (!u) continue;
      for (const sid of u.members) {
        const s = stepById.get(sid);
        if (!s) continue;
        const t = docTextFor(s, doc.texts, ctx.hashOf);
        if (!t.text.trim() && sid !== u.id) continue;        // a silent sub-step adds no line
        n++;
        const label = doc.options?.numbering === 'none' ? '' : doc.options?.numbering === 'page' ? String(n) : (nums.get(sid)?.label || '');
        items.push({ stepId: sid, label, name: s.name || '', text: t.text, edited: t.edited, drifted: t.drifted });
      }
    }
    return {
      id: p.id, number: pi + 1, total, template: tpl,
      header: { left: _sub(doc.header?.left, vars), center: _sub(doc.header?.center, vars), right: _sub(doc.header?.right, vars) },
      footer: { left: _sub(doc.footer?.left, vars), center: _sub(doc.footer?.center, vars), right: _sub(doc.footer?.right, vars) },
      chapter: ch ? ch.name : '', chapterHead, items,
      images: (tpl.images || []).map((rect, k) => ({ rect, stepId: _pictureOf(p, k, unitById) })),
      flags: p.flags || [],
    };
  });
  return { pages, total, watermark: watermarkOf(doc) };
}

/** The step a slot shows: slot 0 follows the page's last step while automatic. */
function _pictureOf(p, k, unitById) {
  const im = p.images?.[k];
  if (k === 0 && (!im || im.auto || !im.stepId)) {
    const ids = (p.stepIds || []).filter(id => unitById.has(id));
    const u = unitById.get(ids[ids.length - 1]);
    return u ? u.members[u.members.length - 1] : null;
  }
  return im?.stepId || null;
}

/** Every step a document needs a picture of. */
export function stillsNeeded(model) {
  const out = new Set();
  for (const p of model.pages) for (const im of p.images) if (im.stepId) out.add(im.stepId);
  return [...out];
}

/** Human label of a page's range: "Steps 3–5 · Chapter 2". */
export function pageRangeLabel(page, steps, chapters, perChapter = false) {
  const nums = numberSteps(steps, chapters, perChapter);
  const labels = (page.stepIds || []).map(id => nums.get(id)?.label).filter(Boolean);
  if (!labels.length) return '(no steps)';
  const first = labels[0], last = labels[labels.length - 1];
  const ch = nums.get(page.stepIds[0])?.chapterLabel || '';
  return `${labels.length > 1 ? `Steps ${first}–${last}` : `Step ${first}`}${ch ? ` · ${ch}` : ''}`;
}
