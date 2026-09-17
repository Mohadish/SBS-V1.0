/**
 * SBS — translation / proofing sheet: the PURE part (no app state, no DOM
 * required). Numbering exactly as the header shows it, row building, the
 * match of a returned sheet against the project, plain ↔ HTML for text
 * boxes. Wired by translation-sheet.js; tested offline in node.
 */

export const SHEET_NAME  = 'Translation';
export const META_SHEET  = '_sbs';
export const FORMAT_VERSION = 1;

/** Column order in the sheet. Names are the contract — the reader matches by header text, never by position. */
export const COLUMNS = ['key', 'srcHash', 'Step', 'Chapter', 'Type', 'Preview', 'Source', 'Target', 'Notes'];
export const COL = Object.fromEntries(COLUMNS.map((c, i) => [c, i]));

// ─── numbering (mirrors header.js buildRenderContext) ───────────────────────

/**
 * Step numbers as the Step Number header shows them: top-level steps only
 * (sub-steps of a group carry the head's number plus their own index),
 * hidden steps and hidden chapters get no number, and with `perChapter` the
 * counter restarts at 1 in every chapter.
 * @returns {Map<string, {label:string, chapterIndex:number, chapterLabel:string, hidden:boolean}>}
 */
export function numberSteps(steps, chapters, perChapter = false) {
  const out = new Map();
  const chHidden = new Set((chapters || []).filter(c => c.hidden).map(c => c.id));
  const chIndex  = new Map((chapters || []).map((c, i) => [c.id, i]));
  const visible  = (steps || []).filter(s => !s.hidden && !s.isBaseStep && !chHidden.has(s.chapterId));
  let global = 0;
  const perCh = new Map();          // chapterId → counter
  const headNo = new Map();         // group head id → its label
  const subNo  = new Map();         // group head id → sub-step counter
  for (const s of visible) {
    if (s.groupId) {
      const n = (subNo.get(s.groupId) || 0) + 1;
      subNo.set(s.groupId, n);
      const head = headNo.get(s.groupId) || '';
      out.set(s.id, _entry(head ? `${head}.${n}` : '', s, chIndex, chapters));
      continue;
    }
    let label;
    if (perChapter && s.chapterId) {
      const n = (perCh.get(s.chapterId) || 0) + 1;
      perCh.set(s.chapterId, n);
      label = String(n);
    } else {
      global++;
      label = String(global);
    }
    headNo.set(s.id, label);
    out.set(s.id, _entry(label, s, chIndex, chapters));
  }
  for (const s of (steps || [])) {
    if (s.isBaseStep || out.has(s.id)) continue;
    out.set(s.id, { ..._entry('', s, chIndex, chapters), hidden: true });
  }
  return out;
}

function _entry(label, s, chIndex, chapters) {
  const ci = s.chapterId != null && chIndex.has(s.chapterId) ? chIndex.get(s.chapterId) : -1;
  return { label, chapterIndex: ci, chapterLabel: ci >= 0 ? `Chapter ${ci + 1}` : '', hidden: false, chapterName: ci >= 0 ? (chapters[ci]?.name || '') : '' };
}

// ─── text helpers ───────────────────────────────────────────────────────────

/** HTML text box → plain lines (one per block / <br>), entities decoded. */
export function htmlToPlain(html) {
  let s = String(html || '');
  s = s.replace(/[​﻿]/g, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(div|p|li|h[1-6])>\s*/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e];
  });
  return normText(s);
}

/** Cell text as it comes back from a spreadsheet → what we store. */
export function normText(s) {
  return String(s ?? '')
    .replace(/_x000D_/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n').map(l => l.replace(/[ \t]+$/g, '')).join('\n')
    .replace(/\n+$/g, '')
    .replace(/^\n+/g, '');
}

const _escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Put translated PLAIN text back into a styled text box:
 *   • one line of source text → the translation replaces its text run(s),
 *     the first run's styling wraps everything;
 *   • N source lines and N translated lines → line by line, each keeping
 *     its own line's styling;
 *   • otherwise → every translated line wrapped in the FIRST line's styling.
 * Works with a DOM when there is one (the app), a regex fallback otherwise.
 */
export function plainIntoHtml(srcHtml, plain) {
  const lines = normText(plain).split('\n');
  if (typeof document !== 'undefined') return _plainIntoHtmlDom(srcHtml, lines);
  return _plainIntoHtmlRegex(srcHtml, lines);
}

function _plainIntoHtmlDom(srcHtml, lines) {
  const root = document.createElement('div');
  root.innerHTML = String(srcHtml || '');
  const blocks = [...root.children].filter(el => /^(DIV|P)$/.test(el.tagName));
  const styleChainOf = (block) => {
    // innermost text run's ancestor spans, outermost first → nested wrapper
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let tn;
    while ((tn = walker.nextNode())) if (tn.textContent.trim()) break;
    const chain = [];
    let p = tn ? tn.parentElement : null;
    while (p && p !== block && p !== root) { if (p.tagName === 'SPAN' && p.getAttribute('style')) chain.unshift(p.getAttribute('style')); p = p.parentElement; }
    return chain;
  };
  const wrapLine = (text, chain, blockStyle) => {
    let inner = _escHtml(text) || '<br>';
    for (let i = chain.length - 1; i >= 0; i--) inner = `<span style="${chain[i]}">${inner}</span>`;
    return `<div${blockStyle ? ` style="${blockStyle}"` : ''}>${inner}</div>`;
  };
  if (blocks.length === lines.length && blocks.length > 0) {
    return blocks.map((b, i) => wrapLine(lines[i], styleChainOf(b), b.getAttribute('style') || '')).join('');
  }
  const first = blocks[0] || root;
  const chain = styleChainOf(first);
  const blockStyle = blocks[0]?.getAttribute('style') || '';
  return lines.map(l => wrapLine(l, chain, blockStyle)).join('');
}

function _plainIntoHtmlRegex(srcHtml, lines) {
  const s = String(srcHtml || '');
  const blockStyle = (/<div\s+style="([^"]*)"/i.exec(s) || [])[1] || '';
  const spans = [];
  const re = /<span\s+style="([^"]*)"/gi;
  let m;
  while ((m = re.exec(s))) spans.push(m[1]);
  const chain = spans.slice(0, 1);
  return lines.map(l => {
    let inner = _escHtml(l) || '<br>';
    for (let i = chain.length - 1; i >= 0; i--) inner = `<span style="${chain[i]}">${inner}</span>`;
    return `<div${blockStyle ? ` style="${blockStyle}"` : ''}>${inner}</div>`;
  }).join('');
}

// ─── rows ───────────────────────────────────────────────────────────────────

/**
 * Build the sheet rows in timeline order: a chapter row wherever a chapter
 * starts, then per step its voiceover (with the preview), step name, text
 * boxes; project headers at the end.
 *
 * @param {Object} p
 * @param {Array}  p.steps        state.steps (timeline order)
 * @param {Array}  p.chapters
 * @param {Array<{key,fmt,src,label,stepId?,constId?}>} p.units   scanUnits()
 * @param {Object} p.entries      pack.entries (target language) or {} for the source language
 * @param {boolean} p.perChapter  header numbering restarts per chapter
 * @param {(text:string)=>string} p.hashOf
 * @param {Map<string,string>} [p.thumbs]   stepId → data URL
 * @returns {Array<{cells:string[], stepId:string|null, thumb:string|null}>}
 */
export function buildRows({ steps, chapters, units, entries = {}, perChapter = false, hashOf, thumbs = null }) {
  const nums = numberSteps(steps, chapters, perChapter);
  const byStep = new Map();     // stepId → units on that step (text boxes)
  const stepUnit = new Map();   // `${stepId}:${what}` → unit
  const chapterUnit = new Map();
  const headerUnits = [];
  for (const u of units) {
    let m;
    if ((m = /^step:(.+):(name|narration)$/.exec(u.key))) stepUnit.set(`${m[1]}:${m[2]}`, u);
    else if ((m = /^chapter:(.+):name$/.exec(u.key))) chapterUnit.set(m[1], u);
    else if (u.key.startsWith('header:')) headerUnits.push(u);
    else if (u.stepId) { if (!byStep.has(u.stepId)) byStep.set(u.stepId, []); byStep.get(u.stepId).push(u); }
    else headerUnits.push(u);
  }
  const rows = [];
  const tgtOf = (u) => {
    const e = entries?.[u.key];
    if (!e || !e.tgt) return '';
    return u.fmt === 'html' ? htmlToPlain(e.tgt) : normText(e.tgt);
  };
  const srcOf = (u) => u.fmt === 'html' ? htmlToPlain(u.src) : normText(u.src);
  const push = (u, type, num, stepId, thumb) => {
    rows.push({
      cells: [u.key, hashOf(u.src), num?.label ?? '', num?.chapterLabel ?? '', type, '', srcOf(u), tgtOf(u), ''],
      stepId, thumb: thumb || null,
    });
  };
  let lastChapter = undefined;
  for (const s of steps || []) {
    if (s.isBaseStep) continue;
    const num = nums.get(s.id);
    if (s.chapterId !== lastChapter) {
      lastChapter = s.chapterId;
      const cu = s.chapterId ? chapterUnit.get(s.chapterId) : null;
      if (cu) rows.push({ cells: [cu.key, hashOf(cu.src), '', num?.chapterLabel ?? '', 'Chapter', '', normText(cu.src), tgtOf(cu), ''], stepId: null, thumb: null });
    }
    const hiddenTag = num?.hidden ? ' (hidden)' : '';
    const narr = stepUnit.get(`${s.id}:narration`);
    const name = stepUnit.get(`${s.id}:name`);
    const thumb = thumbs?.get(s.id) || null;
    if (narr) push(narr, `Voiceover${hiddenTag}`, num, s.id, thumb);
    if (name) push(name, `Step name${hiddenTag}`, num, s.id, narr ? null : thumb);
    for (const u of byStep.get(s.id) || []) push(u, (u.constId ? 'Title' : 'Text box') + hiddenTag, num, s.id, null);
  }
  for (const u of headerUnits) push(u, 'Header', null, null, null);
  return rows;
}

// ─── reading a sheet back ───────────────────────────────────────────────────

/** Header row → { columnName: index }, case-insensitive, trimmed. */
export function parseHeader(headerRow) {
  const idx = {};
  (headerRow || []).forEach((h, i) => {
    const n = String(h || '').trim();
    const hit = COLUMNS.find(c => c.toLowerCase() === n.toLowerCase());
    if (hit && !(hit in idx)) idx[hit] = i;
  });
  return idx;
}

/**
 * Match every data row of a returned sheet against the CURRENT project.
 * @param {string[][]} rows        data rows (header excluded)
 * @param {Object} idx             parseHeader()
 * @param {Array<{key,fmt,src}>} units   scanUnits() now
 * @param {(text:string)=>string} hashOf
 * @returns {Array<{row:number, key:string|null, unit:Object|null, how:'key'|'hash'|'text'|'none',
 *                  stale:boolean, target:string, notes:string, blank:boolean, duplicate:boolean}>}
 */
export function matchRows(rows, idx, units, hashOf) {
  const byKey  = new Map(units.map(u => [u.key, u]));
  const srcPlain = (u) => u.fmt === 'html' ? htmlToPlain(u.src) : normText(u.src);
  const byHash = new Map();   // srcHash → units (may collide: identical texts)
  const byText = new Map();
  for (const u of units) {
    const h = hashOf(u.src);
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(u);
    const t = srcPlain(u);
    if (!byText.has(t)) byText.set(t, []);
    byText.get(t).push(u);
  }
  const get = (r, c) => (c == null ? '' : String(r[c] ?? ''));
  const seen = new Set();
  const out = [];
  rows.forEach((r, i) => {
    if (!r || r.every(v => String(v ?? '').trim() === '')) return;
    const key = get(r, idx.key).trim() || null;
    const hash = get(r, idx.srcHash).trim();
    const source = normText(get(r, idx.Source));
    const target = normText(get(r, idx.Target));
    const notes  = normText(get(r, idx.Notes));
    let unit = null, how = 'none';
    if (key && byKey.has(key)) { unit = byKey.get(key); how = 'key'; }
    else if (hash && byHash.get(hash)?.length === 1) { unit = byHash.get(hash)[0]; how = 'hash'; }
    else if (source && byText.get(source)?.length === 1) { unit = byText.get(source)[0]; how = 'text'; }
    const stale = !!(unit && hash && hashOf(unit.src) !== hash);
    const duplicate = !!(unit && seen.has(unit.key));
    if (unit) seen.add(unit.key);
    out.push({ row: i + 2, key: unit ? unit.key : key, unit, how, stale, target, notes, blank: !target, duplicate });
  });
  return out;
}

/** Summary counts for the preview / status line. */
export function summarize(matches) {
  const s = { rows: matches.length, matched: 0, byKey: 0, byHash: 0, byText: 0, unmatched: 0, blank: 0, stale: 0, duplicate: 0 };
  for (const m of matches) {
    if (!m.unit) { s.unmatched++; continue; }
    s.matched++;
    if (m.how === 'key') s.byKey++; else if (m.how === 'hash') s.byHash++; else s.byText++;
    if (m.blank) s.blank++;
    if (m.stale) s.stale++;
    if (m.duplicate) s.duplicate++;
  }
  return s;
}
