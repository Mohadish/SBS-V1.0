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
import { translateBatch, isLocalProvider, providerBlocker } from './translate-provider.js';
import {
  scanTextUnitsAndGeometry, applyTextUnitsAndGeometry,
  markOverlayStringsAuthoritative,
} from './overlay.js';
import { _reinternAfterWholesaleRead } from '../io/project.js';
import * as projectPaths from '../core/project-paths.js';   // 📁 folder layout
import * as subtitles from './subtitles.js';   // 💬 separate system — read-only here

export const PACK_VERSION = 1;

/**
 * Small gap between translation requests. Google throttles per user and
 * answers a burst with "User Rate Limit Exceeded" rather than queuing; the
 * main process retries with backoff, but not bursting in the first place is
 * cheaper than recovering. Negligible against a request's own latency.
 */
const _pace = (ms = 150) => new Promise(r => setTimeout(r, ms));

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
  // Strip the autosave suffix (same convention as io/project.js) so a crash
  // recovery opened from Guide.autosave1.sbsproj still finds Guide.<lang>.…
  const base = file.replace(/\.sbsproj$/i, '').replace(/(\.autosave\d*)+$/i, '');
  return { dir, base, sep: s };
}

/**
 * Where a pack lives. Modern: <project>/languages/<lang>.sbslang.json.
 * Legacy (V0.3.2.116–123): <project>/<base>.<lang>.sbslang.json, flat beside
 * the project file. Packs written before the folder layout stay exactly where
 * they are and keep being read — a project is never silently reorganised.
 */
export function packPathFor(lang) {
  return projectPaths.langPackPath(lang).path;
}
export function packPathLegacy(lang) {
  return projectPaths.langPackPath(lang).legacy;
}
/** The path a pack should be READ from: legacy if that is where it already is. */
async function _readPathFor(lang) {
  const { path, legacy } = projectPaths.langPackPath(lang);
  if (!path) return null;
  if (window.sbsNative?.fileExists) {
    if (await window.sbsNative.fileExists(path))   return path;
    if (legacy && await window.sbsNative.fileExists(legacy)) return legacy;
  }
  return path;
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
export function scanUnits(shared = null) {
  const units = [];
  // `shared` lets a caller reuse ONE overlay parse across several packs —
  // parsing every step's overlay per pack is what blew the memory cage.
  const ov = shared || scanTextUnitsAndGeometry();
  for (const s of (state.get('steps') || [])) {
    if (s.isBaseStep) continue;
    if (s.name)              units.push({ key: `step:${s.id}:name`,      fmt: 'text', src: s.name,             label: 'Step name' });
    if (s.narration?.text)   units.push({ key: `step:${s.id}:narration`, fmt: 'text', src: s.narration.text,   label: 'Voiceover' });
  }
  for (const c of (state.get('chapters') || [])) {
    if (c.name) units.push({ key: `chapter:${c.id}:name`, fmt: 'text', src: c.name, label: 'Chapter name' });
  }
  for (const u of ov.units) {
    // stepId rides along so the Title Manager can jump to the step a text
    // box actually lives on.
    units.push({ key: u.key, fmt: 'html', src: u.html, label: 'Text box', stepId: u.stepId });
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
  if (!window.sbsNative?.readFile) return null;
  const path = await _readPathFor(lang);
  if (!path) return null;
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
  // The FILENAME decides which language a pack IS. `lang` inside the file is
  // untrusted content, and savePack routes its write by it — a copied or
  // hand-edited pack could otherwise overwrite a DIFFERENT language's file.
  if (p.lang && p.lang !== lang) console.warn(`[lang] ${lang} pack declares lang="${p.lang}" — using the filename.`);
  p.lang = lang;
  p.entries    = p.entries    || {};
  p.constTexts = p.constTexts || {};
  p.boxes      = p.boxes      || {};
  return p;
}

export async function savePack(pack) {
  // Write back to wherever this pack already lives — a legacy pack stays put
  // rather than being silently duplicated into languages/ and leaving a stale
  // twin behind. New packs are written into the layout folder.
  const path = await _readPathFor(pack.lang);
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
  const found = new Set();
  const read = async (dir, rx) => {
    try {
      const entries = await window.sbsNative.listDir(dir);
      for (const e of (entries || [])) {
        const n = typeof e === 'string' ? e : e?.name;
        const m = n && n.match(rx);
        if (m) found.add(m[1]);
      }
    } catch { /* folder absent — fine */ }
  };
  // Both locations: languages/<lang>.sbslang.json (layout) and the flat
  // <base>.<lang>.sbslang.json beside the project (pre-layout projects).
  await read(projectPaths.subDir('languages'), projectPaths.LANG_PACK_MODERN_RX);
  await read(p.dir, projectPaths.langPackLegacyRx(p.base));
  return [...found];
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
export function reconcilePack(pack, units, geom = null) {
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
      // HAND-FIXES ARE SACRED, even across drift. Demoting an edited entry
      // to 'stale' would hand it back to the machine on the next Translate,
      // silently destroying the user's own wording. Keep the state, record
      // the drift separately so the panel can still report it.
      const keepEdit = cur.state === 'edited' && !!cur.tgt;
      // srcHash '' uniquely means "source never known" (entries authored
      // while a translation was live, hatch-recreated packs) — the FIRST
      // source fill is not drift, and flagging it would stamp a permanent
      // false review marker on every such line.
      const firstFill = cur.srcHash === '';
      next.entries[u.key] = {
        ...cur, fmt: u.fmt, src: u.src, srcHash: hash,
        state: keepEdit ? 'edited' : (cur.tgt ? 'stale' : 'new'),
        ...(keepEdit && !firstFill ? { drifted: true } : {}),
      };
      if (keepEdit) { edited++; if (!firstFill) stale++; }
      else if (cur.tgt) stale++;
      else added++;
      continue;
    }
    // Hash matches = unchanged SINCE THE LAST SCAN — the mismatch branch
    // above refreshed the stored hash at detection time, so a match here can
    // never mean "the drift resolved". The drifted flag therefore survives
    // reconciles and is cleared only when the user actually REVISES the
    // translation (captureInto's tgt branch) — that is the review the flag
    // exists to prompt.
    next.entries[u.key] = { ...cur, fmt: u.fmt, src: u.src };
    if (cur.state === 'edited') { edited++; if (cur.drifted) stale++; }
    else if (cur.tgt) fresh++;
    else added++;
  }

  // Only the SOURCE scan is a reliable inventory. While a translation is live
  // a blanked or unloaded field simply drops out of scanUnits(), and pruning
  // on that would delete the entry holding the only copy of the original.
  // Genuinely deleted units are cleaned on the next source-side scan.
  if (isSrc) {
    for (const key of Object.keys(next.entries)) {
      if (!live.has(key)) { delete next.entries[key]; removed++; }
    }
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
    // Until a language is deliberately laid out (positioned), its tgt TRACKS
    // the source — otherwise repositioning a set in the original would never
    // reach translations, whose tgt froze at pack-creation time.
    else if (isSrc) ct[d.id] = { ...cur, src: here, tgt: cur.positioned ? (cur.tgt || { ...here }) : { ...here } };
  }
  // Removal is source-scan-only, same rule as the entries above.
  if (isSrc) {
    for (const id of Object.keys(ct)) if (!liveDefs.has(id)) ct[id] = null;
  }
  next.constTexts = ct;

  // Per-box records: refresh the src side while the source language is live;
  // prune only on a source scan.
  const boxes = { ...(next.boxes || {}) };
  if (isSrc) {
    for (const k of Object.keys(boxes)) if (!live.has(k)) delete boxes[k];
    for (const [k, g] of (geom || new Map())) {
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
    // Deleted in this language — translating it would bill for text the
    // resolver then applies as '' anyway. The blank stays authoritative
    // until the user retypes in that language (which clears the flag).
    if (e.blanked) continue;
    if (!e.tgt || e.state === 'new' || e.state === 'stale' || force) out.push(k);
  }
  return out;
}

// ─── Machine translation ────────────────────────────────────────────────────

function _apiKey() {
  if (isLocalProvider()) return 'local';   // placeholder — offline needs no key
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
  if (!key) return { ok: false, error: (providerBlocker() || 'Translation unavailable.') };
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
  const CHUNK = 24;            // count cap — well under Google's 128-q limit
  const MAX_BYTES = 90_000;    // payload cap — under Google's ~200KB request cap
  const bytes = (s) => { try { return new TextEncoder().encode(String(s ?? '')).length; } catch { return String(s ?? '').length * 2; } };
  let done = 0, firstErr = null;
  const total = keys.length;

  for (const [fmt, group] of [['text', textKeys], ['html', htmlKeys]]) {
    let i = 0;
    while (i < group.length) {
      // Budget by BYTES as well as count: one huge HTML unit (embedded
      // styling) could otherwise push a request over the API cap — and a
      // failing chunk must not doom every unit queued after it.
      const slice = [];
      let size = 0;
      while (i < group.length && slice.length < CHUNK) {
        const b = bytes(pack.entries[group[i]].src);
        if (slice.length && size + b > MAX_BYTES) break;   // always take at least one
        slice.push(group[i]); size += b; i++;
      }
      onProgress?.(done, total);
      // Source omitted → Google auto-detects, so this works whatever language
      // the project is authored in.
      const res = await translateBatch(
        slice.map(k => pack.entries[k].src), '', pack.lang, key, fmt,
      );
      await _pace();
      if (!res?.ok) {
        // Remember the failure but keep going — the other chunks are
        // independent, and everything that succeeds is kept. A rate-limit
        // error means the whole run is being throttled, though, so stop
        // rather than hammering the remaining chunks into the same wall.
        if (!firstErr) firstErr = res?.error || 'Translation failed.';
        if (/rate limit/i.test(String(res?.error || ''))) return { ok: false, error: firstErr, translated: done };
        continue;
      }
      slice.forEach((k, n) => {
        const t = String(res.texts?.[n] ?? '');
        if (!t) return;
        // A fresh translation is an explicit "this line should show" — clear
        // any deletion marker (belt: pendingKeys already excludes blanked).
        const { blanked, ...rest } = pack.entries[k];
        // Rules run on every fresh translation, so corrected phrasing
        // never has to be re-fixed by hand after each re-translate.
        pack.entries[k] = { ...rest, tgt: applyRulesToText(pack.rules, t, rest.fmt), state: 'auto' };
        done++;
      });
    }
  }
  onProgress?.(total, total);
  if (firstErr) return { ok: false, error: `${firstErr} (${done}/${total} translated and kept)`, translated: done };
  return { ok: true, translated: done };
}

// ─── Capture (what is live → the pack) ──────────────────────────────────────

/**
 * Read the CURRENT project text into `field` of every entry — 'tgt' when the
 * live language is a translation, 'src' when it is the source language.
 * Called before switching away, so hand-edits made in the app are never lost
 * and edits to the ORIGINAL surface as drift in every other language.
 */
export function captureInto(pack, field, shared = null) {
  const ov = shared || scanTextUnitsAndGeometry();
  const units = scanUnits(ov);
  const byKey = new Map(units.map(u => [u.key, u]));
  let changed = 0;
  for (const [k, e] of Object.entries(pack.entries || {})) {
    const u = byKey.get(k);
    if (!u) continue;
    if (field === 'src') {
      if (e.src === u.src) continue;
      // The original moved on: keep the translation but flag it for review.
      // Same rule as reconcilePack — an EDITED translation keeps its state
      // (drift is recorded separately), or the next Translate would hand the
      // user's own wording back to the machine.
      const keepEdit = e.state === 'edited' && !!e.tgt;
      const firstFill = e.srcHash === '';   // first source fill ≠ drift
      pack.entries[k] = {
        ...e, src: u.src, srcHash: srcHashOf(u.src),
        state: keepEdit ? 'edited' : (e.tgt ? 'stale' : 'new'),
        ...(keepEdit && !firstFill ? { drifted: true } : {}),
      };
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
      // Revising the translation is also the act that RESOLVES a drift review
      // — the user has now seen the line — so the flag clears here, and only
      // here.
      const { drifted, blanked, ...rest } = e;
      const next = { ...rest, tgt: u.src, state: 'edited' };
      // Review queue: a row the user OPENED ('seen') and has now actually
      // changed becomes ✱ 'edited'. That is the whole difference between
      // "looked at, left alone" and "looked at, fixed".
      if (next.review?.tgt === 'seen') next.review = { ...next.review, tgt: 'edited' };
      pack.entries[k] = next;
      changed++;
    }
  }

  // 🗑 Record deletions the scan cannot see (tgt side only). A field blanked
  // while a translation is live simply DROPS OUT of scanUnits, so without an
  // explicit marker the old text resurrects on the next switch. Only fields
  // whose OWNER still exists are marked — owner-gone keys are structural
  // deletes, cleaned by the next source-side prune.
  if (field !== 'src') {
    const stepsArr    = state.get('steps') || [];
    const chaptersArr = state.get('chapters') || [];
    const headersArr  = state.get('headerItems') || [];
    for (const [k, e] of Object.entries(pack.entries || {})) {
      if (byKey.has(k)) {
        if (e.blanked) { const { blanked, ...rest } = e; pack.entries[k] = rest; changed++; }
        continue;
      }
      let m, ownerExists = false;
      if ((m = /^step:(.+):(name|narration)$/.exec(k)))       ownerExists = stepsArr.some(s => s.id === m[1]);
      else if ((m = /^chapter:(.+):name$/.exec(k)))            ownerExists = chaptersArr.some(c => c.id === m[1]);
      else if ((m = /^header:(.+):(text|textHtml)$/.exec(k)))  ownerExists = headersArr.some(h => h.id === m[1]);
      if (ownerExists && !e.blanked) { pack.entries[k] = { ...e, blanked: true }; changed++; }
    }
  }
  const side = field === 'src' ? 'src' : 'tgt';

  // 🎧 Park narration AUDIO metadata per side, keyed to the exact text it was
  // synthesized for. Applying a language replaces the whole narration record
  // (the clip belongs to the old text) — without this, every round trip threw
  // away BOTH languages' clips and forced a re-synthesis (re-billed on Cloud
  // TTS). Only DISK-cached clips are parked; inline base64 clips would bloat
  // the pack file enormously, so they re-synthesize (set an audio cache
  // folder to keep clips across switches).
  for (const [k, e] of Object.entries(pack.entries || {})) {
    const m = /^step:(.+):narration$/.exec(k);
    if (!m) continue;
    const st = (state.get('steps') || []).find(x => x.id === m[1]);
    const n = st?.narration;
    const au = { ...(e.audio || {}) };
    au[side] = (n?.dataFile && n.voiceId)
      ? { voiceId: n.voiceId, speed: n.speed, durationMs: n.durationMs, mime: n.mime, dataFile: n.dataFile, forText: n.text }
      : (au[side] || null);   // keep an older parked clip rather than erase it
    pack.entries[k] = { ...pack.entries[k], audio: au };
  }

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
  for (const [k, g] of ov.geom) {
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

function _applyStrings(resolve, textKeys, audioFor = () => null, boxGeom = null) {
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
      // 🎧 EXCEPT when the pack parked a disk-cached clip for EXACTLY this
      // text — reattach it, so a round trip doesn't re-bill both languages'
      // synthesis. forText is the guarantee the clip matches the words.
      // Reattach only when the clip matches the words AND today's voice
      // settings — the app deliberately invalidates clips on voice/speed
      // change, and a parked copy must not resurrect an old voice.
      const au = audioFor(`step:${s.id}:narration`);
      const exp = state.get('export') || {};
      const settingsOk = au && au.voiceId === exp.narrationVoice
        && (Number(au.speed) || 1) === (Number(exp.narrationSpeed) || 1);
      out.narration = (au && settingsOk && au.forText === narr && au.dataFile)
        ? { text: narr, voiceId: au.voiceId, speed: au.speed, durationMs: au.durationMs, mime: au.mime, dataFile: au.dataFile }
        : { text: narr };
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

  // Text boxes live inside the overlay strings — text AND geometry go
  // through ONE parse pass (two passes doubled peak memory on big projects).
  const textMap = new Map();
  for (const key of (textKeys || [])) {
    const v = resolve(key);
    if (v != null) textMap.set(key, v);
  }
  n += applyTextUnitsAndGeometry(textMap, boxGeom).boxes;
  state.markDirty();
  return n;
}

/**
 * Apply one side ('src' | 'tgt') of a pack's positions. Constant sets fall
 * back to their src record when the target side was never laid out, so a
 * freshly translated language starts exactly where the original sits.
 */
/**
 * Constant-set positions only — the per-BOX geometry is handed back to the
 * caller so it can ride along with the text in a single overlay pass
 * (V0.3.2.121: two passes meant two full parses of every overlay).
 * @returns {{touched:number, geom:Map}}
 */
function _applyConstPositions(pack, side) {
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
  return { touched, geom };
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
  // 🧠 ONE overlay parse for the whole capture phase (V0.3.2.121). Parsing
  // every step's overlay per pack materialises fresh copies of the embedded
  // base64 images each time — with several packs that alone can exhaust the
  // ~3.5GB renderer cage.
  const ovCapture = scanTextUnitsAndGeometry();
  const unitsCapture = scanUnits(ovCapture);

  let fromPack = null;   // reused below as the restore source when lang === src
  if (from === src) {
    // Live text IS the source: fold it into EVERY pack's `src` so each
    // language learns which of its lines have drifted.
    for (const code of await listPackLanguages()) {
      let p;
      try { p = await loadPack(code); }
      catch (e) {
        // A corrupt pack for a language we are NOT touching must not block a
        // switch into a healthy one. We never write to it here, so skipping
        // is exactly as safe as refusing — the panel flags the broken file.
        // The TARGET pack still hard-fails below.
        console.warn('[lang] skipping unreadable pack during capture:', e.message);
        continue;
      }
      if (!p) continue;
      const { pack: rec } = reconcilePack(p, unitsCapture, ovCapture.geom);
      captureInto(rec, 'src', ovCapture);
      const w = await savePack(rec);
      if (!w.ok) return { ok: false, error: `Could not update the ${code} pack (${w.error}) — nothing was switched.` };
    }
  } else {
    let p;
    try { p = await loadPack(from); }
    catch (e) { return { ok: false, error: e.message }; }   // CORRUPT → refuse, it holds data
    // MISSING (not corrupt) is different: the pack's data is already gone,
    // nothing else in the app can reset activeLang, and refusing would lock
    // the project in this language forever. Re-create the pack and capture
    // the live text into it — the escape hatch.
    // BUT never when the destination is the SOURCE language: a recreated pack
    // has no src side, so the originals cannot be restored — the switch would
    // label translated text as the source, and the next source-side reconcile
    // would then write the translation into every sibling pack's src,
    // destroying the last recoverable copies of the originals.
    // Refuse the trip to the SOURCE when the leaving pack cannot restore it:
    // missing outright, OR a hatch-RECREATED pack (every entry src:'') — the
    // latter passes a mere existence check but has no src side, and letting
    // it through would label translated text as the original, after which
    // the next source-side reconcile poisons every sibling pack's src.
    const _es = p ? Object.values(p.entries || {}) : [];
    const srcless = p && _es.length > 0 && !_es.some(e => e && e.srcHash);
    if ((!p || srcless) && lang === src) {
      return { ok: false, error:
        `The ${from} pack ${p ? 'has no source side (it was re-created after its file was lost)' : 'is missing'}, ` +
        `so the ${src} originals cannot be restored from it. Restore ${packPathFor(from)}, ` +
        `or switch into another translation whose pack still exists, then back to ${src}.` };
    }
    const { pack: rec } = reconcilePack(p || emptyPack(from), unitsCapture, ovCapture.geom);
    captureInto(rec, 'tgt', ovCapture);
    const w = await savePack(rec);
    if (!w.ok) return { ok: false, error: `Could not save the ${from} pack (${w.error}) — nothing was switched.` };
    fromPack = rec;
  }

  // 🔁 PROPAGATE (V0.3.2.125) — every language learns what changed, before the
  // incoming one is applied, so switching INTO a language shows it already up
  // to date. Runs between capture and apply for exactly that reason.
  // Best-effort: a translation failure must never block the switch itself —
  // the languages simply stay out of date and the panel reports it.
  try {
    if (translationAvailable()) {
      onProgress?.('Updating other languages…');
      const sync = await syncLanguages({ leaving: from, onProgress: (m) => onProgress?.(m) });
      if (sync.errors?.length) console.warn('[lang] sync issues:', sync.errors.join(' | '));
    }
  } catch (e) {
    console.warn('[lang] propagation skipped:', e?.message);
  }

  // Propagation wrote to its OWN copy of the leaving pack (loaded from disk),
  // so the fromPack captured above is now stale — and it is exactly what the
  // switch-back-to-source resolver reads. Without this refresh, content
  // authored in a translation gets back-filled into the file and then IGNORED
  // on the very switch that triggered it, leaving the foreign text on screen.
  if (fromPack) {
    try { const fresh = await loadPack(from); if (fresh) fromPack = fresh; }
    catch (e) { console.warn('[lang] could not reload the leaving pack:', e?.message); }
  }

  // 🎙 VOICE PER LANGUAGE (V0.3.2.129). Remember the voice the language we
  // are leaving was using, then restore the one this language used before.
  // Applied BEFORE the strings, because the parked-clip reattach in
  // _applyStrings only accepts a clip whose voice matches the CURRENT
  // setting — with the old language's voice still in effect it would reject
  // every clip belonging to the language being entered.
  // Nothing is invalidated here: clip wiping is wired to the voice DROPDOWN,
  // not to the setting, so a programmatic change is safe.
  const voices = { ...(state.get('narrationVoices') || {}) };
  const exp0 = state.get('export') || {};
  if (exp0.narrationVoice) voices[from] = { voiceId: exp0.narrationVoice, speed: exp0.narrationSpeed ?? 1 };
  const want = voices[lang];
  state.setState({ narrationVoices: voices });
  if (want?.voiceId && want.voiceId !== exp0.narrationVoice) {
    state.setState({ export: { ...state.get('export'), narrationVoice: want.voiceId, narrationSpeed: want.speed ?? 1 } });
  }

  onProgress?.('Applying…');
  let target = null;
  if (lang !== src) {
    try { target = await loadPack(lang); }
    catch (e) { return { ok: false, error: e.message }; }
    if (!target) return { ok: false, error: `No pack for "${lang}" — scan and translate it first.` };
  }

  // Snapshots taken AFTER the last await, inside the no-await window — so an
  // edit committed while loadPack was in flight lands in beforeSteps and
  // stays recoverable via Ctrl+Z instead of being silently overwritten.
  // Reuse the capture-phase scan: nothing between here and there re-parses
  // overlays, and a second full parse is exactly what exhausted the heap.
  const textKeys = ovCapture.units.map(u => u.key);
  const beforeSteps    = cloneShareStrings(state.get('steps') || []);
  const beforeChapters = cloneShareStrings(state.get('chapters') || []);
  const beforeHeaders  = cloneShareStrings(state.get('headerItems') || []);
  const beforeDefs     = cloneShareStrings(state.get('constTextBoxes') || []);
  const beforeLang     = from;

  // Resolver. Going INTO a translation: read `tgt`, falling back to `src` for
  // lines never translated. Coming BACK to the original: read `src` out of the
  // pack of the language we are LEAVING — that pack is the one that recorded
  // these originals (fromPack was just reconciled + saved above, so reuse it
  // rather than re-reading disk). A blank `src` means the line was first seen
  // while a translation was live, so its original is unknown; leave the field
  // untouched rather than blanking it.
  // NOTE: no awaits from here through the activeLang commit — a serialize()
  // (autosave) landing between "text applied" and "activeLang set" would
  // write a project whose label lies about its contents.
  let resolve, audioFor;
  if (lang === src) {
    const p = fromPack;
    resolve  = (k) => { const e = p?.entries?.[k]; return (e && e.src) ? e.src : null; };
    audioFor = (k) => p?.entries?.[k]?.audio?.src || null;
  } else {
    // blanked = the user deleted this field while THIS language was live;
    // '' applies the deletion instead of resurrecting old text.
    resolve  = (k) => { const e = target.entries?.[k]; return e ? (e.blanked ? '' : (e.tgt || e.src || null)) : null; };
    // Untranslated lines fall back to the SOURCE text — so the parked
    // source-side clip is the right audio for them (translation→translation
    // switches would otherwise re-bill every untranslated line). The
    // forText === narr guard downstream keeps a mismatched clip out.
    audioFor = (k) => { const a = target.entries?.[k]?.audio; return a?.tgt || a?.src || null; };
  }

  // Positions: the target's `tgt` side going INTO a translation, or the
  // leaving pack's `src` side coming back to the original. Constant sets
  // apply now; per-box geometry rides with the text through ONE overlay pass.
  const posPack = target || fromPack;
  const pos = posPack ? _applyConstPositions(posPack, target ? 'tgt' : 'src') : { touched: 0, geom: new Map() };
  const changed = _applyStrings(resolve, textKeys, audioFor, pos.geom);
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

  // 🧵 Re-share the overlay string pool. Parsing + re-stringifying every
  // overlay FLATTENED the interned ropes, un-sharing the duplicated base64
  // image data (~150MB+ on a big project) — without this the session's
  // headroom shrinks permanently after every switch, which is how the
  // second switch hit the heap cage.
  _reinternAfterWholesaleRead('language switch');
  return { ok: true, changed, lang };
}

/**
 * 🧳 Carry the language sidecars across a Save As (V0.3.2.118). Packs are
 * addressed by the live projectPath, so saving under a new name would strand
 * every translation with the old file — and once a translation is active,
 * the stranded packs hold the only copy of the originals. Copies, never
 * moves; never clobbers an existing destination.
 */
export async function migratePacksTo(oldPath, newPath) {
  try {
    if (!oldPath || !newPath || oldPath === newPath) return 0;
    if (!window.sbsNative?.listDir || !window.sbsNative?.readFile || !window.sbsNative?.writeFile) return 0;
    const part = (p) => {
      const sep = _sep(p); const i = p.lastIndexOf(sep);
      return {
        dir: i >= 0 ? p.slice(0, i) : '.', sep,
        base: (i >= 0 ? p.slice(i + 1) : p).replace(/\.sbsproj$/i, '').replace(/(\.autosave\d*)+$/i, ''),
      };
    };
    const o = part(oldPath), n = part(newPath);
    if (o.dir === n.dir && o.base === n.base) return 0;

    // Gather from BOTH locations of the old project: languages/<lang>.… and
    // the pre-layout flat <base>.<lang>.… beside the file.
    const sources = new Map();   // lang → absolute source path
    const collect = async (dir, rx) => {
      let entries;
      try { entries = await window.sbsNative.listDir(dir); } catch { return; }
      for (const e of (entries || [])) {
        const nm = typeof e === 'string' ? e : e?.name;
        const m = nm && nm.match(rx);
        if (m && !sources.has(m[1])) sources.set(m[1], `${dir}${o.sep}${nm}`);
      }
    };
    await collect(`${o.dir}${o.sep}${projectPaths.DIR.languages}`, projectPaths.LANG_PACK_MODERN_RX);
    await collect(o.dir, projectPaths.langPackLegacyRx(o.base));

    // Write into the NEW project's layout folder — Save As creates a fresh
    // project, so it gets the current organisation regardless of how the
    // original was laid out.
    let copied = 0;
    for (const [lang, src] of sources) {
      const dest = `${n.dir}${n.sep}${projectPaths.DIR.languages}${n.sep}${lang}.sbslang.json`;
      if (window.sbsNative.fileExists && (await window.sbsNative.fileExists(dest))) continue;   // never clobber
      const r = await window.sbsNative.readFile(src, 'utf8');
      const txt = typeof r === 'string' ? r : (r?.data ?? '');
      if (!txt) continue;
      await window.sbsNative.writeFile(dest, txt, 'utf8');
      copied++;
    }
    return copied;
  } catch (e) {
    console.warn('[lang] pack migration failed:', e?.message);
    return 0;
  }
}

// ─── 🔤 Replace rules (V0.3.2.130) ──────────────────────────────────────────
//
// Per-language find/replace, stored IN the pack so they travel with the
// project and are visible in the JSON:
//
//   "rules": [ { id, find, replace, caseSensitive } ]
//
// Applied automatically after every machine translation, and on demand
// across everything already translated ("Run rules now").
//
// COLLAPSING. Adding Y→Z rewrites any existing rule that produced Y, so
// X→Y becomes X→Z. The alternative — chaining at apply time — is
// order-dependent and can loop forever (Y→Z plus Z→Y), so rules are kept
// collapsed and applied in a SINGLE pass instead.

/** Case-aware literal replace-all. */
function _replaceAll(text, find, replace, caseSensitive) {
  if (!find) return text;
  const rx = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
  return text.replace(rx, replace);
}

/**
 * Apply every rule once, left to right.
 * HTML units are split on tags so replacements only ever touch the visible
 * text — a rule for a common word must never rewrite an attribute or a tag
 * name and corrupt the markup.
 */
export function applyRulesToText(rules, text, fmt = 'text') {
  if (!rules?.length || !text) return text;
  const run = (chunk) => {
    let out = chunk;
    for (const r of rules) out = _replaceAll(out, r.find, r.replace ?? '', !!r.caseSensitive);
    return out;
  };
  if (fmt !== 'html') return run(text);
  return String(text).split(/(<[^>]*>)/g).map(part => (part.startsWith('<') ? part : run(part))).join('');
}

/**
 * Add or update a rule, collapsing chains and refusing cycles.
 * @returns {{ok, rules?, collapsed?, error?}}
 */
export function upsertRule(rules, { id, find, replace, caseSensitive = false }) {
  const f = String(find ?? '').trim();
  const r = String(replace ?? '');
  if (!f) return { ok: false, error: 'Nothing to find.' };
  if (f === r) return { ok: false, error: 'Find and replace are identical.' };
  // A rule that turns the new replacement back into the new find would make
  // the pair oscillate on every run.
  const inverse = (rules || []).find(x => x.id !== id && x.find === r && x.replace === f);
  if (inverse) return { ok: false, error: `That reverses an existing rule ("${r}" → "${f}").` };

  let next = (rules || []).filter(x => x.id !== id);
  // COLLAPSE: anything that used to produce `find` now produces `replace`
  // directly, so X→Y→Z is stored as X→Z and applied in one pass.
  let collapsed = 0;
  next = next.map(x => {
    if (x.replace === f) { collapsed++; return { ...x, replace: r }; }
    return x;
  });
  // Re-adding the same find replaces the old rule rather than stacking.
  next = next.filter(x => x.find !== f);
  next.push({ id: id || `rl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`, find: f, replace: r, caseSensitive: !!caseSensitive });
  return { ok: true, rules: next, collapsed };
}

/** Rules for a language — pack for a translation, project settings for the original. */
export async function getRules(langCode) {
  if (langCode === sourceLang()) return (state.get('replaceRules') || {})[langCode] || [];
  try { const p = await loadPack(langCode); return p?.rules || []; }
  catch { return []; }
}

export async function setRules(langCode, rules) {
  if (langCode === sourceLang()) {
    state.setState({ replaceRules: { ...(state.get('replaceRules') || {}), [langCode]: rules } });
    state.markDirty();
    return { ok: true };
  }
  let pack;
  try { pack = await loadPack(langCode); }
  catch (e) { return { ok: false, error: e.message }; }
  if (!pack) return { ok: false, error: `No pack for "${langCode}" — scan it first.` };
  pack.rules = rules;
  return savePack(pack);
}

/**
 * Rules for the ORIGINAL language rewrite the project's own text — there is
 * no `tgt` to correct, so this is a correction layer over the source itself:
 * step names, chapter names, voiceover and on-screen titles.
 *
 * Every translation notices on the next switch, because the source text (and
 * therefore its fingerprint) has moved — hand-edited translations are kept
 * and flagged, machine ones are re-translated. So correcting the original
 * ripples outward exactly like any other source edit.
 */
/**
 * Subtitles are a SEPARATE text from the voiceover — a step can say one thing
 * and caption another — so rules have to be applied to them in their own pass,
 * against their own slot ('' / 'orig' for the original language, the language
 * code for a translation). Batched into a single undo entry.
 * @returns {number} captions rewritten
 */
function _runRulesOnSubtitles(rules, langCode) {
  if (!rules.length) return 0;
  const slot = langCode === sourceLang() ? '' : langCode;
  const key  = subtitles.langKeyOf(slot);
  const writes = [];
  for (const s of (state.get('steps') || [])) {
    if (s.isBaseStep) continue;
    const cur = s.subtitles?.[key]?.text;
    if (!cur) continue;                     // no override of its own — nothing to correct
    const next = applyRulesToText(rules, cur, 'text');
    if (next !== cur) writes.push({ stepId: s.id, lang: slot, text: next });
  }
  if (!writes.length) return 0;
  subtitles.setSubtitleOverrides(writes, `Replace rules — subtitles (${langCode})`);
  return writes.length;
}

async function _runSourceRules(langCode, { bake = false } = {}) {
  const rules = await getRules(langCode);
  if (!rules.length) return { ok: true, changed: 0 };
  if (activeLang() !== langCode) {
    return { ok: false, error: `Switch to "${langCode}" first — these rules rewrite the project's own text.` };
  }
  const subs = _runRulesOnSubtitles(rules, langCode);   // own undo entry (separate system)
  const units = scanUnits();
  const next = new Map();
  for (const u of units) {
    const out = applyRulesToText(rules, u.src, u.fmt);
    if (out !== u.src) next.set(u.key, out);
  }
  if (!next.size && !subs) return { ok: true, changed: 0, subtitles: 0 };
  if (!next.size) { if (bake) await setRules(langCode, []); return { ok: true, changed: 0, subtitles: subs, baked: bake }; }

  const beforeSteps    = cloneShareStrings(state.get('steps') || []);
  const beforeChapters = cloneShareStrings(state.get('chapters') || []);
  const beforeHeaders  = cloneShareStrings(state.get('headerItems') || []);
  const textKeys = [...next.keys()].filter(k => k.startsWith('text:'));
  const changed = _applyStrings((k) => next.get(k) ?? null, textKeys);

  const afterSteps    = cloneShareStrings(state.get('steps') || []);
  const afterChapters = cloneShareStrings(state.get('chapters') || []);
  const afterHeaders  = cloneShareStrings(state.get('headerItems') || []);
  // Baking finalises: the corrected text becomes the truth and the rules stop
  // running. The rule list rides in the SAME undo entry as the text, so one
  // Ctrl+Z gives back both rather than stranding you with reverted text and
  // no rules to re-apply.
  if (bake) await setRules(langCode, []);
  const restore = (s, c, h, rl) => {
    state.setState({ steps: [...s], chapters: [...c], headerItems: [...h] });
    if (rl) state.setState({ replaceRules: { ...(state.get('replaceRules') || {}), [langCode]: rl } });
    markOverlayStringsAuthoritative();
    state.markDirty();
  };
  undoManager.push(`${bake ? 'Bake' : 'Replace'} rules (${langCode})`,
    () => restore(beforeSteps, beforeChapters, beforeHeaders, bake ? rules : null),
    () => restore(afterSteps,  afterChapters,  afterHeaders,  bake ? [] : null),
  );
  return { ok: true, changed, subtitles: subs, baked: bake };
}

/**
 * Rewrite every translated entry through the current rules, and push the
 * result into the live project when that language is showing. One undo entry.
 */
export async function runRules(langCode, { bake = false } = {}) {
  if (langCode === sourceLang()) return _runSourceRules(langCode, { bake });
  let pack;
  try { pack = await loadPack(langCode); }
  catch (e) { return { ok: false, error: e.message }; }
  if (!pack) return { ok: false, error: `No pack for "${langCode}".` };
  const rules = pack.rules || [];
  if (!rules.length) return { ok: true, changed: 0 };

  // Captions are their own text — corrected in their own pass (see the
  // helper's note). Only meaningful while this language is showing, since
  // subtitle overrides live on the steps, not in the pack.
  const subs = activeLang() === langCode ? _runRulesOnSubtitles(rules, langCode) : 0;

  const before = new Map();
  let changed = 0;
  for (const [k, e] of Object.entries(pack.entries || {})) {
    if (!e.tgt) continue;
    const next = applyRulesToText(rules, e.tgt, e.fmt);
    if (next === e.tgt) continue;
    before.set(k, e.tgt);
    // A rule is an explicit instruction, so it applies to hand-edited lines
    // too — but the result is surfaced for review rather than applied
    // silently, and the entry keeps its 'edited' standing.
    pack.entries[k] = _markReview({ ...e, tgt: next }, 'tgt', 'new');
    changed++;
  }
  if (!changed) {
    if (bake) { pack.rules = []; await savePack(pack); }
    return { ok: true, changed: 0, subtitles: subs, baked: bake };
  }
  // Baking finalises: the corrected translations become the truth and the
  // rules stop running on future translations.
  if (bake) pack.rules = [];
  const w = await savePack(pack);
  if (!w.ok) return { ok: false, error: w.error };

  const live = activeLang() === langCode;
  if (live) for (const [k, e] of Object.entries(pack.entries)) if (before.has(k)) applyOneEntry(k, e.tgt);

  const after = new Map([...before.keys()].map(k => [k, pack.entries[k].tgt]));
  // The rule list rides in the same undo entry as the text, so one Ctrl+Z
  // gives back both rather than leaving reverted text and no rules.
  const restore = async (map, rl) => {
    let p; try { p = await loadPack(langCode); } catch { return; }
    if (!p) return;
    for (const [k, v] of map) if (p.entries[k]) p.entries[k] = { ...p.entries[k], tgt: v };
    if (rl) p.rules = rl;
    await savePack(p);
    if (activeLang() === langCode) for (const [k, v] of map) applyOneEntry(k, v);
  };
  undoManager.push(`${bake ? 'Bake' : 'Replace'} rules (${langCode})`,
    () => restore(before, bake ? rules : null),
    () => restore(after,  bake ? [] : null),
  );
  return { ok: true, changed, subtitles: subs, baked: bake };
}

// ─── 🔁 Cross-language propagation (V0.3.2.125) ─────────────────────────────
//
// Edits made in ANY language reach the others — not only edits to the
// original. Fired on language switch (after the outgoing language is
// captured, before the incoming one is applied), and available as an
// explicit "Sync languages" action.
//
// TWO DIRECTIONS, and they are not symmetrical:
//
//   FORWARD (source → translations). The source moved, so each translation
//   is out of date. A translation the machine owns is simply re-translated.
//   A translation YOU hand-edited is NEVER overwritten — it keeps your
//   wording and is flagged `drifted` for review, because the difference is
//   usually deliberate (a corrected number, a phrasing that language needs).
//
//   BACK (translation → source, and onward to the others). Content authored
//   in a translation has no source text at all — switching to the original
//   would leave the foreign text sitting there. Those get back-translated so
//   the original is complete. This direction writes machine text over an
//   authored original, so every entry it touches is marked for review.
//
// REVIEW STATE lives per side: entry.review = { src?, tgt? } with values
// 'new' (changed, not looked at) → 'seen' (opened, left alone) → 'edited'
// (opened and changed). The Title Manager reads it; nothing else does.

/**
 * Push ONE unit's text into the live project — used by the review actions so
 * a single line can change without re-running a whole language switch (which
 * would drag propagation along as a side effect).
 */
export function applyOneEntry(key, value) {
  if (typeof value !== 'string') return 0;
  return _applyStrings((k) => (k === key ? value : null), key.startsWith('text:') ? [key] : []);
}

function _markReview(entry, side, value) {
  const review = { ...(entry.review || {}) };
  review[side] = value;
  return { ...entry, review };
}

/**
 * Back-translate anything authored in `lang` that the source language has no
 * text for, so switching to the original never shows foreign text.
 * @returns {number} entries filled
 */
async function _backfillSource(pack, { apiKey, onProgress } = {}) {
  const src = sourceLang();
  const keys = Object.entries(pack.entries || {})
    .filter(([, e]) => e.tgt && !e.src)      // born in this language
    .map(([k]) => k);
  if (!keys.length) return 0;

  const key = (apiKey || _apiKey() || '').trim();
  if (!key || !window.sbsNative?.translate?.batch) return 0;

  let filled = 0;
  const CHUNK = 24;
  for (const fmt of ['text', 'html']) {
    const group = keys.filter(k => (pack.entries[k].fmt === 'html') === (fmt === 'html'));
    for (let i = 0; i < group.length; i += CHUNK) {
      const slice = group.slice(i, i + CHUNK);
      onProgress?.(`Back-filling ${src} from ${pack.lang}… ${filled}/${keys.length}`);
      const res = await translateBatch(
        slice.map(k => pack.entries[k].tgt), '', src, key, fmt,
      );
      await _pace();
      if (!res?.ok) { console.warn('[lang] backfill failed:', res?.error); continue; }
      slice.forEach((k, n) => {
        const t = String(res.texts?.[n] ?? '');
        if (!t) return;
        const e = pack.entries[k];
        // The original now has machine text where it had nothing — always
        // flag it, this is the lossy direction.
        pack.entries[k] = _markReview({ ...e, src: t, srcHash: srcHashOf(t) }, 'src', 'new');
        filled++;
      });
    }
  }
  return filled;
}

/**
 * Bring one translation pack up to date with the current source text.
 * Machine-owned translations are re-translated; hand-edited ones are kept
 * and left flagged for review.
 * @returns {{translated:number, kept:number}}
 */
async function _propagateInto(pack, { apiKey, onProgress } = {}) {
  const stale = [];
  let kept = 0;
  for (const [k, e] of Object.entries(pack.entries || {})) {
    if (!e.src) continue;
    if (e.state === 'edited') { if (e.drifted) kept++; continue; }   // yours — never overwritten
    if (e.state === 'stale' || e.state === 'new' || !e.tgt) stale.push(k);
  }
  if (!stale.length) return { translated: 0, kept };

  const key = (apiKey || _apiKey() || '').trim();
  if (!key || !window.sbsNative?.translate?.batch) return { translated: 0, kept };

  let translated = 0;
  const CHUNK = 24;
  for (const fmt of ['text', 'html']) {
    const group = stale.filter(k => (pack.entries[k].fmt === 'html') === (fmt === 'html'));
    for (let i = 0; i < group.length; i += CHUNK) {
      const slice = group.slice(i, i + CHUNK);
      onProgress?.(`Updating ${pack.lang}… ${translated}/${stale.length}`);
      const res = await translateBatch(
        slice.map(k => pack.entries[k].src), '', pack.lang, key, fmt,
      );
      await _pace();
      if (!res?.ok) { console.warn('[lang] propagate failed:', res?.error); continue; }
      slice.forEach((k, n) => {
        const t = String(res.texts?.[n] ?? '');
        if (!t) return;
        const { blanked, ...rest } = pack.entries[k];
        pack.entries[k] = _markReview({ ...rest, tgt: applyRulesToText(pack.rules, t, rest.fmt), state: 'auto' }, 'tgt', 'new');
        translated++;
      });
    }
  }
  return { translated, kept };
}

/**
 * Propagate every pending change across all languages. `leaving` is the
 * language whose edits triggered this (its pack is back-filled first, so the
 * source is complete before the other languages translate FROM it).
 */
export async function syncLanguages({ leaving = null, onProgress } = {}) {
  const src = sourceLang();
  const codes = await listPackLanguages();
  const out = { backfilled: 0, translated: 0, kept: 0, languages: 0, errors: [] };
  if (!translationAvailable()) { out.errors.push((providerBlocker() || 'Translation unavailable.')); return out; }

  // 1. BACK: complete the source from the language we are leaving.
  if (leaving && leaving !== src) {
    try {
      const p = await loadPack(leaving);
      if (p) {
        const n = await _backfillSource(p, { onProgress });
        if (n) { const w = await savePack(p); if (!w.ok) out.errors.push(w.error); }
        out.backfilled += n;
      }
    } catch (e) { out.errors.push(e.message); }
  }

  // 2. FORWARD: every language learns the current source.
  for (const code of codes) {
    if (code === src) continue;
    let p;
    try { p = await loadPack(code); } catch (e) { out.errors.push(e.message); continue; }
    if (!p) continue;
    // Reconcile first so `src` reflects the live original and drift is marked.
    const { pack: rec } = reconcilePack(p, scanUnits());
    const r = await _propagateInto(rec, { onProgress });
    out.translated += r.translated;
    out.kept       += r.kept;
    out.languages++;
    const w = await savePack(rec);
    if (!w.ok) out.errors.push(w.error);
  }
  return out;
}

/**
 * ✏ "Update to translated version" — replace ONE hand-edited translation
 * with a fresh machine translation of the current source. Explicit and
 * undoable, because a hand-edit usually exists for a reason.
 */
export async function acceptMachineTranslation(langCode, key) {
  let pack;
  try { pack = await loadPack(langCode); }
  catch (e) { return { ok: false, error: e.message }; }
  if (!pack) return { ok: false, error: `No pack for "${langCode}".` };
  const e = pack.entries?.[key];
  if (!e || !e.src) return { ok: false, error: 'Nothing to translate for that line.' };

  const apiKey = _apiKey();
  if (!apiKey || !window.sbsNative?.translate?.batch) return { ok: false, error: (providerBlocker() || 'Translation unavailable.') };
  const res = await translateBatch([e.src], '', langCode, apiKey, e.fmt === 'html' ? 'html' : 'text');
  if (!res?.ok) return { ok: false, error: res.error || 'Translation failed.' };
  const next = String(res.texts?.[0] ?? '');
  if (!next) return { ok: false, error: 'Translation came back empty.' };

  const before = { ...e };
  const { drifted, blanked, ...rest } = e;
  const ruled = applyRulesToText(pack.rules, next, e.fmt);
  pack.entries[key] = _markReview({ ...rest, tgt: ruled, state: 'auto' }, 'tgt', 'new');
  const w = await savePack(pack);
  if (!w.ok) return { ok: false, error: w.error };

  // Put the new text on screen straight away when this language is showing —
  // the RULED text, so the screen matches what was stored.
  if (activeLang() === langCode) applyOneEntry(key, ruled);

  // Undoable: the hand-edit is the thing being discarded, so put it back
  // exactly as it was — including its review + drift markers. Deliberately
  // NOT a re-switch: that would re-run propagation as a side effect of an
  // undo. Only this one line moves.
  const after = pack.entries[key];
  const restore = async (entry) => {
    let p; try { p = await loadPack(langCode); } catch { return; }
    if (!p) return;
    p.entries[key] = entry;
    await savePack(p);
    if (activeLang() === langCode) applyOneEntry(key, entry.tgt || entry.src || '');
  };
  undoManager.push(`Accept machine translation (${langCode})`,
    () => { restore(before); },
    () => { restore(after); },
  );
  return { ok: true, text: next };
}

/**
 * Rows for the Title Manager's review tab, already in display order.
 *
 * MARKERS (the four states, in sort order):
 *   '!'   new        — auto-translated / added / changed, not looked at
 *   '!p'  drifted    — the source moved but YOUR hand-edit was kept (pen);
 *                      needs surgical attention, never auto-overwritten
 *   '!*'  seen       — you opened it and left it as-is
 *   '*'   edited     — you opened it and changed it
 *   ''    none       — an ordinary title, nothing to review
 *
 * Within each group rows keep the order they appear in the project.
 * `side` is 'tgt' when a translation is showing, 'src' when the original is —
 * so the tab means "changes affecting what you are looking at" either way.
 */
export async function reviewRows(langCode = activeLang()) {
  const src  = sourceLang();
  const side = langCode === src ? 'src' : 'tgt';
  const units = scanUnits();                       // canonical project order
  const order = new Map(units.map((u, i) => [u.key, i]));

  // Showing the original: its review markers live in the packs that wrote to
  // it, so merge across every translation. Showing a translation: just its own.
  const codes = side === 'src'
    ? (await listPackLanguages()).filter(c => c !== src)
    : [langCode];

  const byKey = new Map();
  for (const code of codes) {
    let pack;
    try { pack = await loadPack(code); } catch { continue; }
    if (!pack) continue;
    for (const [k, e] of Object.entries(pack.entries || {})) {
      const st = e.review?.[side];
      const pen = side === 'tgt' && e.state === 'edited' && !!e.drifted;
      const mark = st === 'new' ? '!' : pen ? '!p' : st === 'seen' ? '!*' : st === 'edited' ? '*' : '';
      const prev = byKey.get(k);
      // A key marked in two languages keeps the most urgent marker.
      const rank = (m) => ({ '!': 0, '!p': 1, '!*': 2, '*': 3, '': 4 }[m]);
      if (prev && rank(prev.mark) <= rank(mark)) continue;
      byKey.set(k, { key: k, lang: code, mark, entry: e });
    }
  }

  // 💬 Subtitle rows (V0.3.2.128). Subtitles are a SEPARATE system with their
  // own per-language storage and their own freshness tracking — deliberately
  // not folded into the packs, which would create two sources of truth for the
  // same text. They appear here as their own rows so a step with a distinct
  // caption is visible and editable in one list, and their existing status
  // maps onto the same markers: stale → ❗, hand-edited → ✱.
  const subRows = [];
  try {
    const subLang = side === 'src' ? '' : langCode;
    for (const s of (state.get('steps') || [])) {
      if (s.isBaseStep) continue;
      const entry = s.subtitles?.[subLang || 'orig'];
      if (!entry?.text) continue;                       // only steps with their OWN caption
      const st = subtitles.subtitleStatus(s, subLang);
      subRows.push({
        key: `subtitle:${s.id}:${subLang || 'orig'}`,
        lang: langCode,
        mark: st === 'stale' ? '!' : st === 'edited' ? '*' : '',
        label: 'Subtitle',
        stepId: s.id,
        text: entry.text,
        order: (order.get(`step:${s.id}:narration`) ?? order.get(`step:${s.id}:name`) ?? 0) + 0.5,
        isSubtitle: true,
      });
    }
  } catch (e) { console.warn('[lang] subtitle rows skipped:', e?.message); }

  const rows = [...subRows];
  for (const u of units) {
    const hit = byKey.get(u.key);
    rows.push({
      key:    u.key,
      lang:   hit?.lang || langCode,
      mark:   hit?.mark || '',
      label:  u.label,
      stepId: u.stepId || _stepIdOf(u.key),
      text:   hit?.entry ? (side === 'src' ? (hit.entry.src || u.src) : (hit.entry.tgt || u.src)) : u.src,
      order:  order.get(u.key) ?? 0,
    });
  }
  const rank = (m) => ({ '!': 0, '!p': 1, '!*': 2, '*': 3, '': 4 }[m] ?? 4);
  rows.sort((a, b) => (rank(a.mark) - rank(b.mark)) || (a.order - b.order));
  return { rows, side, lang: langCode };
}

/** Step a unit belongs to, for the jump-to-title action. */
function _stepIdOf(key) {
  let m;
  if ((m = /^step:(.+):(?:name|narration)$/.exec(key))) return m[1];
  if ((m = /^chapter:(.+):name$/.exec(key))) {
    const first = (state.get('steps') || []).find(s => s.chapterId === m[1] && !s.isBaseStep);
    return first?.id || null;
  }
  return null;
}

/** Mark review rows: 'seen' when opened, 'edited' once the text changes. */
export async function setReviewState(langCode, keys, side, value) {
  let pack;
  try { pack = await loadPack(langCode); }
  catch (e) { return { ok: false, error: e.message }; }
  if (!pack) return { ok: false, error: `No pack for "${langCode}".` };
  let n = 0;
  for (const k of (Array.isArray(keys) ? keys : [keys])) {
    const e = pack.entries?.[k];
    if (!e) continue;
    pack.entries[k] = _markReview(e, side, value);
    n++;
  }
  if (!n) return { ok: true, changed: 0 };
  const w = await savePack(pack);
  return w.ok ? { ok: true, changed: n } : { ok: false, error: w.error };
}

/** "Authorize all" — clear review markers the user has actually SEEN. */
export async function clearReviewed(langCode, side) {
  let pack;
  try { pack = await loadPack(langCode); }
  catch (e) { return { ok: false, error: e.message }; }
  if (!pack) return { ok: false, error: `No pack for "${langCode}".` };
  let cleared = 0;
  for (const [k, e] of Object.entries(pack.entries || {})) {
    const st = e.review?.[side];
    // Untouched 'new' rows survive — clearing those would defeat the queue.
    if (st !== 'seen' && st !== 'edited') continue;
    const review = { ...e.review };
    delete review[side];
    const next = { ...e, review };
    if (!Object.keys(review).length) delete next.review;
    pack.entries[k] = next;
    cleared++;
  }
  if (!cleared) return { ok: true, cleared: 0 };
  const w = await savePack(pack);
  return w.ok ? { ok: true, cleared } : { ok: false, error: w.error };
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
  const ov = scanTextUnitsAndGeometry();     // ONE overlay parse
  const units = scanUnits(ov);
  let pack;
  try { pack = (await loadPack(lang)) || emptyPack(lang); }
  catch (e) { return { ok: false, error: e.message }; }
  const rep   = reconcilePack(pack, units, ov.geom);
  const saved = await savePack(rep.pack);
  // The scan's parse flattened the interned ropes — re-share them.
  _reinternAfterWholesaleRead('language scan');
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

/**
 * ✓ Drift review complete (V0.3.2.120). A review can end with "the
 * translation is fine as-is" — retyping identical text is a no-op, so
 * without this the drifted flag (and its ⚠ count) would be stuck until the
 * wording actually changed. Clears the flag on every (or the given) drifted
 * entries of a language's pack.
 */
export async function markReviewed(langCode, keys = null) {
  let pack;
  try { pack = await loadPack(langCode); }
  catch (e) { return { ok: false, error: e.message }; }
  if (!pack) return { ok: false, error: `No pack for "${langCode}".` };
  let cleared = 0;
  for (const [k, e] of Object.entries(pack.entries || {})) {
    if (e.drifted && (!keys || keys.includes(k))) {
      const { drifted, ...rest } = e;
      pack.entries[k] = rest;
      cleared++;
    }
  }
  if (!cleared) return { ok: true, cleared: 0 };
  const saved = await savePack(pack);
  return saved.ok ? { ok: true, cleared } : { ok: false, error: saved.error };
}

// ─── Console helpers ────────────────────────────────────────────────────────

export function _debugScan() { return scanUnits(); }
