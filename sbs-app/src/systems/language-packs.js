// ─── 🌍 LANGUAGE PACKS (V0.3.2.116) ─────────────────────────────────────────
//
// One project, many languages. The .sbsproj stays the single source of truth;
// each additional language is a JSON sidecar holding ONLY what swaps:
//
//     <project>.<lang>.sbslang.json
//
// Pack shape:
//   { _sbslang: { version: 1 }, lang: 'he', sourceLang: 'en',
//     entries: {
//       'step:<id>:name'      : { fmt, src, srcHash, tgt, state },
//       'step:<id>:narration' : { … },
//       'chapter:<id>:name'   : { … },
//       'text:<tid>'          : { … },              // overlay text box (html)
//       'header:<id>:textHtml': { … },
//     },
//     constTexts: { '<defId>': { src:{anchor,x,y,styleId},
//                                tgt:{anchor,x,y,styleId}, positioned } | null },
//     boxes:      { 'text:<tid>': { src:{x,y,textWidth}, tgt:{…} } },
//   }
//
// POSITIONS ARE STORED PER SIDE, exactly like the text. Hebrew titles anchor
// from the other corner and need their own coordinates, so each language keeps
// its own copy — and the SOURCE copy lives in the pack too, or switching back
// would leave the Hebrew layout applied to the English text. A constant set is
// the unit of positioning: set it once per language and every step using that
// set follows, however many there are. Individual boxes only get a `tgt` entry
// once you actually move them in that language; untouched boxes keep the
// source position, so nothing has to be laid out twice unless you want it to.
//
// WHY src IS STORED NEXT TO EVERY TRANSLATION — this is the whole point of the
// design. Because the pack remembers the source string it was translated FROM
// (and its fingerprint), editing the original later lets the tool say "9 lines
// drifted, 2 of them you hand-edited" instead of blindly re-translating (and
// re-billing) the project. It is also what makes switching back to the source
// language a pure data operation: applying `src` restores the original text,
// so no translation-resolver layer has to be threaded through every renderer.
//
// STATE MACHINE per entry:
//   'auto'   — machine translation, safe to replace on a re-run
//   'edited' — you fixed it by hand; never overwritten, only reported
//   'stale'  — the SOURCE changed since this was translated (srcHash mismatch)
//
// SWITCHING: activeLang says which language currently sits in the project.
// Switching L1 → L2 first CAPTURES what is live back into L1's pack (or, when
// L1 is the source language, back into every pack's `src` — which is exactly
// how drift is detected), then APPLIES L2's strings + positions.

import { state }        from '../core/state.js';
import { undoManager }  from './undo.js';
import { cloneShareStrings } from '../core/clone.js';
import * as userSettings from '../core/user-settings.js';
import {
  scanTextUnits, applyTextUnits,
  readTextBoxGeometry, applyTextBoxGeometry,
  markOverlayStringsAuthoritative,
} from './overlay.js';

export const PACK_VERSION = 1;

// ─── Identity / paths ───────────────────────────────────────────────────────

const _sep = (p) => (p.includes('\\') ? '\\' : '/');

/** Directory + base name of the open project, or null when unsaved. */
function _projectParts() {
  const pp = state.get('projectPath');
  if (!pp) return null;
  const s = _sep(pp);
  const i = pp.lastIndexOf(s);
  const dir  = i >= 0 ? pp.slice(0, i) : '.';
  const file = i >= 0 ? pp.slice(i + 1) : pp;
  const base = file.replace(/\.sbsproj$/i, '');
  return { dir, base, sep: s };
}

export function packPathFor(lang) {
  const p = _projectParts();
  return p ? `${p.dir}${p.sep}${p.base}.${lang}.sbslang.json` : null;
}

export function sourceLang() { return state.get('sourceLang') || 'en'; }
export function activeLang() { return state.get('activeLang') || sourceLang(); }

/** djb2 + length — same shape as the subtitle fingerprint. Equality only. */
export function srcHashOf(text) {
  const s = String(text ?? '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}.${s.length.toString(36)}`;
}

// ─── Scanning the project into translatable units ───────────────────────────

/**
 * Every translatable unit in the project RIGHT NOW, in the language the
 * project currently holds. Also stamps `tid` on unstamped text boxes.
 * @returns {Array<{key,fmt,src,label}>}
 */
export function scanUnits() {
  const units = [];
  for (const s of (state.get('steps') || [])) {
    if (s.isBaseStep) continue;
    if (s.name)              units.push({ key: `step:${s.id}:name`,      fmt: 'text', src: s.name,             label: 'Step name' });
    if (s.narration?.text)   units.push({ key: `step:${s.id}:narration`, fmt: 'text', src: s.narration.text,   label: 'Voiceover' });
  }
  for (const c of (state.get('chapters') || [])) {
    if (c.name) units.push({ key: `chapter:${c.id}:name`, fmt: 'text', src: c.name, label: 'Chapter name' });
  }
  for (const u of scanTextUnits()) {
    units.push({ key: u.key, fmt: 'html', src: u.html, label: 'Text box' });
  }
  for (const h of (state.get('headerItems') || [])) {
    if (h.kind !== 'custom') continue;                    // other kinds are derived
    // BOTH slots, not either/or: a header renders `text` in default/template
    // mode and `textHtml` once canvas-edited, and a leftover textHtml can sit
    // beside the text that is actually on screen. Translating only one leaves
    // the header in the source language the moment the other is the live one.
    if (h.textHtml) units.push({ key: `header:${h.id}:textHtml`, fmt: 'html', src: h.textHtml, label: 'Header' });
    if (h.text)     units.push({ key: `header:${h.id}:text`,     fmt: 'text', src: h.text,     label: 'Header' });
  }
  return units;
}

// ─── Pack IO ────────────────────────────────────────────────────────────────

export function emptyPack(lang) {
  return {
    _sbslang: { version: PACK_VERSION },
    lang,
    sourceLang: sourceLang(),
    entries: {},
    constTexts: {},
    boxes: {},
  };
}

/**
 * Read a pack. Returns null ONLY when the file genuinely does not exist.
 * A file that exists but cannot be read or parsed THROWS — callers must not
 * treat a corrupt pack as "no pack yet" and overwrite it with an empty one,
 * which would destroy every translation in it.
 */
export async function loadPack(lang) {
  const path = packPathFor(lang);
  if (!path || !window.sbsNative?.readFile) return null;
  if (window.sbsNative.fileExists && !(await window.sbsNative.fileExists(path))) return null;
  let txt;
  try {
    const r = await window.sbsNative.readFile(path, 'utf8');
    if (r && r.ok === false) throw new Error(r.error || 'read failed');
    txt = typeof r === 'string' ? r : (r?.data ?? r?.text ?? '');
  } catch (e) {
    throw new Error(`Cannot read ${lang} pack (${e?.message || e}) — fix or move the file; refusing to overwrite it.`);
  }
  if (!txt || !String(txt).trim()) {
    throw new Error(`The ${lang} pack is empty — fix or move the file; refusing to overwrite it.`);
  }
  let p;
  try { p = JSON.parse(txt); }
  catch (e) { throw new Error(`The ${lang} pack is not valid JSON (${e?.message}) — fix or move the file; refusing to overwrite it.`); }
  if (!p || typeof p !== 'object' || !p.entries) {
    throw new Error(`The ${lang} pack is missing its entries — fix or move the file; refusing to overwrite it.`);
  }
  p.entries    = p.entries    || {};
  p.constTexts = p.constTexts || {};
  p.boxes      = p.boxes      || {};
  return p;
}

export async function savePack(pack) {
  const path = packPathFor(pack.lang);
  if (!path || !window.sbsNative?.writeFile) return { ok: false, error: 'No project path — save the project first.' };
  try {
    // Pretty-printed on purpose: the pack is meant to be readable and
    // diffable — that is half the point of keeping translations out of the
    // binary project file.
    const r = await window.sbsNative.writeFile(path, JSON.stringify(pack, null, 2), 'utf8');
    if (r && r.ok === false) return { ok: false, error: r.error || 'Write failed.' };
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: e?.message || 'Write failed.' };
  }
}

/** Language codes with a pack sitting beside the project. */
export async function listPackLanguages() {
  const p = _projectParts();
  if (!p || !window.sbsNative?.listDir) return [];
  try {
    const entries = await window.sbsNative.listDir(p.dir);
    const names = (entries || []).map(e => (typeof e === 'string' ? e : e?.name)).filter(Boolean);
    const rx = new RegExp(`^${p.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.([A-Za-z-]{2,10})\\.sbslang\\.json$`);
    return names.map(n => (n.match(rx) || [])[1]).filter(Boolean);
  } catch { return []; }
}

// ─── Merge a fresh scan into a pack (the drift report) ──────────────────────

/**
 * Reconcile a pack against the CURRENT source text.
 *  • new unit            → entry with no tgt, state 'new'
 *  • src changed         → keep tgt, mark 'stale', record the new src
 *  • unit disappeared    → entry dropped (its box/const rows too)
 * Never touches `tgt` — nothing here re-translates.
 * @returns {{pack, added:number, stale:number, removed:number, edited:number, ok:number}}
 */
export function reconcilePack(pack, units) {
  const next = { ...pack, entries: { ...pack.entries } };
  const live = new Set(units.map(u => u.key));
  // ONLY the source language may author `src`. When a TRANSLATION is live the
  // scan returns translated text, and writing that into `src` would destroy
  // the one remaining copy of the original — after which "switch back to the
  // original" re-applies the translation. This is a prune-only pass then.
  const isSrc = (activeLang() === sourceLang());
  let added = 0, stale = 0, removed = 0, edited = 0, fresh = 0;

  for (const u of units) {
    const cur = next.entries[u.key];
    if (!isSrc) {
      // A key first seen while a translation is live has no known source
      // text. Record the translation, leave `src` empty, and let the next
      // source-side scan fill it in — never guess.
      if (!cur) { next.entries[u.key] = { fmt: u.fmt, src: '', srcHash: '', tgt: u.src, state: 'edited' }; added++; }
      else fresh++;
      continue;
    }
    const hash = srcHashOf(u.src);
    if (!cur) {
      next.entries[u.key] = { fmt: u.fmt, src: u.src, srcHash: hash, tgt: '', state: 'new' };
      added++;
      continue;
    }
    if (cur.srcHash !== hash) {
      next.entries[u.key] = { ...cur, fmt: u.fmt, src: u.src, srcHash: hash, state: cur.tgt ? 'stale' : 'new' };
      if (cur.tgt) stale++; else added++;
      continue;
    }
    next.entries[u.key] = { ...cur, fmt: u.fmt, src: u.src };
    if (cur.state === 'edited') edited++;
    else if (cur.tgt) fresh++;
    else added++;
  }

  for (const key of Object.keys(next.entries)) {
    if (!live.has(key)) { delete next.entries[key]; removed++; }
  }

  // Constant-title definitions: a full record per language, not a delta.
  // 20 sets × 6 languages is trivial data and predictable beats clever.
  // A new set starts with tgt = src (inherits the source position) and
  // positioned:false, so the panel can report "3 sets not yet positioned for
  // Hebrew". A deleted set becomes null and is cleaned on the next scan.
  const defs = state.get('constTextBoxes') || [];
  const ct = { ...(next.constTexts || {}) };
  const liveDefs = new Set(defs.map(d => d.id));
  for (const d of defs) {
    const here = { anchor: d.anchor || 'tl', x: d.x, y: d.y, styleId: d.styleId || null };
    const cur = ct[d.id];
    if (!cur)      ct[d.id] = { src: here, tgt: { ...here }, positioned: false };
    else if (isSrc) ct[d.id] = { ...cur, src: here, tgt: cur.tgt || { ...here } };
  }
  for (const id of Object.keys(ct)) if (!liveDefs.has(id)) ct[id] = null;
  next.constTexts = ct;

  // Per-box records: drop any whose box no longer exists; refresh the src side
  // while the source language is live.
  const boxes = { ...(next.boxes || {}) };
  for (const k of Object.keys(boxes)) if (!live.has(k)) delete boxes[k];
  if (isSrc) {
    for (const [k, g] of readTextBoxGeometry()) {
      if (!live.has(k)) continue;
      boxes[k] = { ...(boxes[k] || {}), src: g };
    }
  }
  next.boxes = boxes;

  // NOTE the field is `fresh`, not `ok` — callers spread this report next to
  // an `ok: true` success flag and a numeric `ok` would silently clobber it.
  return { pack: next, added, stale, removed, edited, fresh };
}

/** Units still needing machine translation (never includes hand-edited ones). */
export function pendingKeys(pack, { force = false } = {}) {
  const out = [];
  for (const [k, e] of Object.entries(pack.entries || {})) {
    if (e.state === 'edited') continue;                 // hand-fixes are sacred
    if (!e.tgt || e.state === 'new' || e.state === 'stale' || force) out.push(k);
  }
  return out;
}

// ─── Machine translation ────────────────────────────────────────────────────

function _apiKey() {
  try { return (userSettings.get()?.cloud?.googleApiKey || '').trim(); }
  catch { return ''; }
}

/** Is machine translation usable right now? (key + main-process bridge) */
export function translationAvailable() {
  return !!(_apiKey() && window.sbsNative?.translate?.batch);
}

/**
 * Fill in every pending entry via Google Translate. Batched, and committed
 * into the pack object as it goes so a mid-run failure never discards work
 * already paid for.
 */
export async function translatePack(pack, { force = false, onProgress, apiKey } = {}) {
  const key = (apiKey || _apiKey() || '').trim();
  if (!key) return { ok: false, error: 'No Google API key — Settings → Cloud TTS tab.' };
  if (!window.sbsNative?.translate?.batch) {
    return { ok: false, error: 'Translation bridge missing — restart the app (main-process update).' };
  }
  const keys = pendingKeys(pack, { force });
  if (!keys.length) return { ok: true, translated: 0 };

  // Two passes, because the two formats are NOT interchangeable. 'html'
  // preserves markup but returns entity-encoded output that must stay encoded;
  // 'text' is decoded for us. Sending a step name or narration line through
  // the html path would bake &#39; and &quot; into plain fields — and the TTS
  // would read them out loud.
  const htmlKeys = keys.filter(k => pack.entries[k].fmt === 'html');
  const textKeys = keys.filter(k => pack.entries[k].fmt !== 'html');
  const CHUNK = 24;   // HTML units are large; stay well under Google's 128-q cap
  let done = 0;
  const total = keys.length;

  for (const [fmt, group] of [['text', textKeys], ['html', htmlKeys]]) {
    for (let i = 0; i < group.length; i += CHUNK) {
      const slice = group.slice(i, i + CHUNK);
      onProgress?.(done, total);
      // Source omitted → Google auto-detects, so this works whatever language
      // the project is authored in.
      const res = await window.sbsNative.translate.batch(
        slice.map(k => pack.entries[k].src), '', pack.lang, key, fmt,
      );
      if (!res?.ok) return { ok: false, error: res?.error || 'Translation failed.', translated: done };
      slice.forEach((k, n) => {
        const t = String(res.texts?.[n] ?? '');
        if (!t) return;
        pack.entries[k] = { ...pack.entries[k], tgt: t, state: 'auto' };
        done++;
      });
    }
  }
  onProgress?.(total, total);
  return { ok: true, translated: done };
}

// ─── Capture (what is live → the pack) ──────────────────────────────────────

/**
 * Read the CURRENT project text into `field` of every entry — 'tgt' when the
 * live language is a translation, 'src' when it is the source language.
 * Called before switching away, so hand-edits made in the app are never lost
 * and edits to the ORIGINAL surface as drift in every other language.
 */
export function captureInto(pack, field) {
  const units = scanUnits();
  const byKey = new Map(units.map(u => [u.key, u]));
  let changed = 0;
  for (const [k, e] of Object.entries(pack.entries || {})) {
    const u = byKey.get(k);
    if (!u) continue;
    if (field === 'src') {
      if (e.src === u.src) continue;
      // The original moved on: keep the translation but flag it for review.
      pack.entries[k] = { ...e, src: u.src, srcHash: srcHashOf(u.src), state: e.tgt ? 'stale' : 'new' };
      changed++;
    } else {
      if (e.tgt === u.src) continue;
      // A line with no translation yet shows the SOURCE text through as a
      // fallback. Seeing that source text live is not a hand-edit — recording
      // it as one would freeze the original into the target language and, since
      // 'edited' is never machine-translated again, make it permanently
      // untranslatable. Only a real deviation counts.
      if (!e.tgt && u.src === e.src) continue;
      // Typed over a machine translation in the app → it is now a hand-edit.
      pack.entries[k] = { ...e, tgt: u.src, state: 'edited' };
      changed++;
    }
  }
  const side = field === 'src' ? 'src' : 'tgt';

  // Positions as they stand in the language being captured.
  const defs = state.get('constTextBoxes') || [];
  const ct = { ...(pack.constTexts || {}) };
  for (const d of defs) {
    const now = { anchor: d.anchor || 'tl', x: d.x, y: d.y, styleId: d.styleId || null };
    const cur = ct[d.id] || { src: { ...now }, tgt: { ...now }, positioned: false };
    const prev = cur[side];
    const moved = !prev || prev.anchor !== now.anchor || prev.x !== now.x || prev.y !== now.y || prev.styleId !== now.styleId;
    // 'positioned' tracks whether THIS language's layout was ever set
    // deliberately — that's what drives the "not yet positioned" report.
    ct[d.id] = { ...cur, [side]: now, positioned: side === 'tgt' ? (cur.positioned || moved) : cur.positioned };
  }
  pack.constTexts = ct;

  const boxes = { ...(pack.boxes || {}) };
  for (const [k, g] of readTextBoxGeometry()) {
    if (!pack.entries[k]) continue;
    const cur = boxes[k];
    if (side === 'src') { boxes[k] = { ...(cur || {}), src: g }; continue; }
    // Sparse on the target side: a box only earns an entry once it actually
    // sits somewhere other than where the source puts it.
    const src = cur?.src;
    const differs = !src || src.x !== g.x || src.y !== g.y || src.textWidth !== g.textWidth;
    if (differs) boxes[k] = { ...(cur || {}), tgt: g };
    else if (cur?.tgt) { const { tgt, ...rest } = cur; boxes[k] = rest; }
  }
  pack.boxes = boxes;
  return changed;
}

// ─── Apply (a pack → the project) ───────────────────────────────────────────

function _applyStrings(resolve, textKeys) {
  const steps = state.get('steps') || [];
  const chapters = state.get('chapters') || [];
  const headerItems = state.get('headerItems') || [];
  let n = 0;

  const nextSteps = steps.map(s => {
    if (s.isBaseStep) return s;
    const name = resolve(`step:${s.id}:name`);
    const narr = resolve(`step:${s.id}:narration`);
    if (name == null && narr == null) return s;
    const out = { ...s };
    if (name != null && name !== s.name) { out.name = name; n++; }
    if (narr != null && narr !== s.narration?.text) {
      // Replace the whole narration record: the cached clip belongs to the
      // OLD text and must not be played over the new one. Same convention as
      // the step-nav editor. renderedDurationMs goes too, or chapter
      // timecodes keep reporting the previous language's timings.
      out.narration = { text: narr };
      delete out.renderedDurationMs;
      n++;
    }
    return out;
  });

  const nextChapters = chapters.map(c => {
    const name = resolve(`chapter:${c.id}:name`);
    if (name == null || name === c.name) return c;
    n++;
    return { ...c, name };
  });

  const nextHeaders = headerItems.map(h => {
    if (h.kind !== 'custom') return h;
    const html = resolve(`header:${h.id}:textHtml`);
    const txt  = resolve(`header:${h.id}:text`);
    if (html == null && txt == null) return h;
    const out = { ...h };
    if (html != null && html !== h.textHtml) { out.textHtml = html; n++; }
    if (txt  != null && txt  !== h.text)     { out.text     = txt;  n++; }
    return out;
  });

  state.setState({ steps: nextSteps, chapters: nextChapters, headerItems: nextHeaders });

  // Text boxes live inside the overlay strings — one pass through overlay.js.
  const textMap = new Map();
  for (const key of (textKeys || [])) {
    const v = resolve(key);
    if (v != null) textMap.set(key, v);
  }
  n += applyTextUnits(textMap).boxes;
  state.markDirty();
  return n;
}

/**
 * Apply one side ('src' | 'tgt') of a pack's positions. Constant sets fall
 * back to their src record when the target side was never laid out, so a
 * freshly translated language starts exactly where the original sits.
 */
function _applyPositions(pack, side) {
  const defs = state.get('constTextBoxes') || [];
  const ct = pack.constTexts || {};
  let touched = 0;
  const next = defs.map(d => {
    const rec = ct[d.id];
    const p = rec && (rec[side] || rec.src);
    if (!p) return d;
    if (d.anchor === p.anchor && d.x === p.x && d.y === p.y && (d.styleId || null) === (p.styleId || null)) return d;
    touched++;
    return { ...d, anchor: p.anchor || 'tl', x: p.x, y: p.y, styleId: p.styleId || null };
  });
  if (touched) { state.setState({ constTextBoxes: next }); state.markDirty(); }

  const geom = new Map();
  for (const [k, rec] of Object.entries(pack.boxes || {})) {
    const g = rec && (rec[side] || rec.src);
    if (g) geom.set(k, g);
  }
  return touched + applyTextBoxGeometry(geom);
}

/**
 * Switch the project into `lang`. Captures the live language first, then
 * applies the target's strings and positions. ONE undo entry for the lot.
 */
export async function switchLanguage(lang, { onProgress } = {}) {
  const from = activeLang();
  if (lang === from) return { ok: true, unchanged: true };
  const src = sourceLang();

  onProgress?.('Capturing current language…');
  // 1. Capture what is live so nothing typed in the app is lost. A failed
  // write here ABORTS the switch: proceeding would overwrite the project with
  // the other language and silently discard everything just edited.
  if (from === src) {
    // Live text IS the source: fold it into EVERY pack's `src` so each
    // language learns which of its lines have drifted.
    for (const code of await listPackLanguages()) {
      let p;
      try { p = await loadPack(code); }
      catch (e) { return { ok: false, error: e.message }; }
      if (!p) continue;
      const { pack: rec } = reconcilePack(p, scanUnits());
      captureInto(rec, 'src');
      const w = await savePack(rec);
      if (!w.ok) return { ok: false, error: `Could not update the ${code} pack (${w.error}) — nothing was switched.` };
    }
  } else {
    let p;
    try { p = await loadPack(from); }
    catch (e) { return { ok: false, error: e.message }; }
    if (!p) {
      // No pack for the language currently in the project: its originals have
      // no home, so switching would strand them. Refuse rather than guess.
      return { ok: false, error: `The ${from} pack is missing — restore it beside the project before switching, or the ${from} text has nowhere to go.` };
    }
    const { pack: rec } = reconcilePack(p, scanUnits());
    captureInto(rec, 'tgt');
    const w = await savePack(rec);
    if (!w.ok) return { ok: false, error: `Could not save the ${from} pack (${w.error}) — nothing was switched.` };
  }

  onProgress?.('Applying…');
  const units = scanUnits();
  const textKeys = units.filter(u => u.key.startsWith('text:')).map(u => u.key);

  const beforeSteps    = cloneShareStrings(state.get('steps') || []);
  const beforeChapters = cloneShareStrings(state.get('chapters') || []);
  const beforeHeaders  = cloneShareStrings(state.get('headerItems') || []);
  const beforeDefs     = cloneShareStrings(state.get('constTextBoxes') || []);
  const beforeLang     = from;

  let target = null;
  if (lang !== src) {
    try { target = await loadPack(lang); }
    catch (e) { return { ok: false, error: e.message }; }
    if (!target) return { ok: false, error: `No pack for "${lang}" — scan and translate it first.` };
  }

  // Resolver. Going INTO a translation: read `tgt`, falling back to `src` for
  // lines never translated. Coming BACK to the original: read `src` out of the
  // pack of the language we are LEAVING — that pack is the one that recorded
  // these originals. (Reading "any pack" would restore a different language's
  // idea of the source.)
  let resolve;
  if (lang === src) {
    let p;
    try { p = await loadPack(from); }
    catch (e) { return { ok: false, error: e.message }; }
    if (!p) return { ok: false, error: `The ${from} pack is missing — cannot restore the original text.` };
    // A blank `src` means the line was first seen while a translation was
    // live, so its original is unknown; leave the field untouched rather than
    // blanking it.
    resolve = (k) => { const e = p.entries?.[k]; return (e && e.src) ? e.src : null; };
  } else {
    resolve = (k) => {
      const e = target.entries?.[k];
      if (!e) return null;
      return e.tgt || e.src || null;
    };
  }

  const changed = _applyStrings(resolve, textKeys);
  // Positions come from whichever pack we have: the target's `tgt` side going
  // INTO a translation, or any pack's `src` side coming back to the original.
  if (target) _applyPositions(target, 'tgt');
  else {
    // Same rule as the strings: the layout we are restoring is the one the
    // pack we are LEAVING recorded on its src side.
    let p = null;
    try { p = await loadPack(from); } catch { /* strings already resolved above */ }
    if (p) _applyPositions(p, 'src');
  }
  state.setState({ activeLang: lang });

  // Undo restores the strings AND the geometry wholesale — geometry lives in
  // the overlay strings and the const defs, both captured above.
  const restore = (steps, chapters, headers, defs, langCode) => {
    state.setState({
      steps: [...steps], chapters: [...chapters], headerItems: [...headers],
      constTextBoxes: [...defs], activeLang: langCode,
    });
    // The restored steps carry their own overlay strings, so the live Konva
    // stage is now stale — without this the next debounced write serialises
    // the stale stage back over them.
    markOverlayStringsAuthoritative();
    state.markDirty();
  };
  const afterSteps    = cloneShareStrings(state.get('steps') || []);
  const afterChapters = cloneShareStrings(state.get('chapters') || []);
  const afterHeaders  = cloneShareStrings(state.get('headerItems') || []);
  const afterDefs     = cloneShareStrings(state.get('constTextBoxes') || []);
  undoManager.push(`Switch language → ${lang}`,
    () => restore(beforeSteps, beforeChapters, beforeHeaders, beforeDefs, beforeLang),
    () => restore(afterSteps,  afterChapters,  afterHeaders,  afterDefs,  lang),
  );

  return { ok: true, changed, lang };
}

// ─── Orchestration (what the panel calls) ───────────────────────────────────

/**
 * Rescan the project and reconcile it into `lang`'s pack, WITHOUT translating.
 * This is the drift report: what is new, what went stale under you, what you
 * hand-edited, and which constant sets still have no layout for this language.
 */
export async function scanLanguage(lang) {
  if (activeLang() !== sourceLang()) {
    return { ok: false, error: `Switch back to ${sourceLang()} before scanning — the project currently holds ${activeLang()}.` };
  }
  const units = scanUnits();
  let pack;
  try { pack = (await loadPack(lang)) || emptyPack(lang); }
  catch (e) { return { ok: false, error: e.message }; }
  const rep   = reconcilePack(pack, units);
  const saved = await savePack(rep.pack);
  if (!saved.ok) return { ok: false, error: saved.error };
  const unpositioned = Object.values(rep.pack.constTexts || {})
    .filter(v => v && !v.positioned).length;
  // Spread FIRST: the report carries its own counters and one of them used to
  // land on top of this `ok` flag.
  return { ...rep, ok: true, total: units.length, unpositioned, path: saved.path };
}

/** Scan, then machine-translate everything pending, then save the pack. */
export async function translateLanguage(lang, { force = false, onProgress } = {}) {
  const scan = await scanLanguage(lang);
  if (!scan.ok) return scan;
  const pack = scan.pack;
  const res = await translatePack(pack, { force, onProgress });
  // Save regardless: a mid-run failure must not discard work already paid for.
  const saved = await savePack(pack);
  if (!res.ok) return { ok: false, error: res.error, translated: res.translated || 0, pack };
  if (!saved.ok) return { ok: false, error: saved.error, translated: res.translated };
  return { ...scan, ok: true, translated: res.translated, pack };
}

// ─── Console helpers ────────────────────────────────────────────────────────

export function _debugScan() { return scanUnits(); }
