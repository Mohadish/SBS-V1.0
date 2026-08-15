/**
 * 🌐 Subtitles + translation (V0.3.2.63)
 *
 * Per-step, per-language subtitle OVERRIDE slots. The subtitle header kind
 * (header.js, V0.3.2.57) shows the step's voiceover verbatim; this module
 * adds an editable layer on top of it:
 *
 *   step.subtitles = {
 *     [langKey]: { text, srcHash, edited }        // langKey: 'orig' | 'he' | …
 *   }
 *
 *   • text     — what the subtitle actually shows (hand-edit or translation).
 *   • srcHash  — fingerprint of the SOURCE narration text this entry was
 *                generated from. When the voiceover changes later, the hash
 *                mismatch flags the entry STALE — it is NEVER silently
 *                overwritten (the user's hand-edits and paid translations
 *                survive; a chip in edit mode surfaces the staleness).
 *   • edited   — true when the user hand-edited the text. Edited entries are
 *                never touched by batch translation, stale or not.
 *
 * Resolution (used by header.js resolveHeaderText):
 *   entry text if present → else the live narration text (Original shows the
 *   voiceover; an untranslated language falls back to it too, flagged by the
 *   edit-mode chip).
 *
 * Editing NEVER touches step.narration — the voiceover is the source of
 * truth for AUDIO; subtitles are a presentation layer over it.
 *
 * Translation runs authoring-time through the main process
 * ('translate:batch' → Google Translate v2; key from userSettings.cloud,
 * passed per-call, never stored in code). Incremental like the render
 * cache: only missing or stale-and-unedited lines are sent.
 *
 * All mutations go through actions.commitStateChange (undoable).
 */

import { state }         from '../core/state.js';
import * as actions      from './actions.js';
import * as userSettings from '../core/user-settings.js';
import { polishLine }    from './text-polish.js';   // ✨ punctuation sweep (V0.3.2.66)

/** Languages offered by the subtitle header item. code '' = original. */
export const SUBTITLE_LANGS = [
  { code: '',   label: 'Original (voiceover)' },
  { code: 'he', label: 'Hebrew — עברית' },
];

/** Map a subtitle language code to its slot key ('' → 'orig'). */
export function langKeyOf(lang) { return lang || 'orig'; }

/**
 * Fingerprint of a source narration text (djb2 + length). Only compared
 * for equality to detect "voiceover changed since this subtitle was
 * made" — not a cryptographic hash, collisions are inconsequential.
 */
export function srcHashOf(text) {
  const s = String(text || '').trim();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ':' + s.length;
}

/** The step's spoken narration text — the subtitle's source of truth. */
export function subtitleSourceText(step) {
  return String(step?.narration?.text ?? step?.voiceText ?? '').trim();
}

/** The override entry for a step+language, or null. */
export function getSubtitleEntry(step, lang) {
  const e = step?.subtitles?.[langKeyOf(lang)];
  return (e && typeof e.text === 'string') ? e : null;
}

/**
 * What the subtitle SHOWS for a step+language: the override text when an
 * entry exists, else the live narration text. Pure — reads only the step.
 */
export function resolveSubtitleText(step, lang) {
  const e = getSubtitleEntry(step, lang);
  return e ? e.text : subtitleSourceText(step);
}

/**
 * Status for the edit-mode chip:
 *   'auto'    — showing the live voiceover copy (or a fresh translation)
 *   'edited'  — hand-edited, source unchanged since
 *   'stale'   — source narration changed AFTER this entry was made
 *   'missing' — translated language with no translation yet (falls back
 *               to the source text on screen)
 */
export function subtitleStatus(step, lang) {
  const src = subtitleSourceText(step);
  const e   = getSubtitleEntry(step, lang);
  if (!e) return (lang && src) ? 'missing' : 'auto';
  if (e.srcHash !== srcHashOf(src)) return 'stale';
  return e.edited ? 'edited' : 'auto';
}

// ─── Mutations (undoable — one commitStateChange per user gesture) ──────────

function _writeEntries(label, writes) {
  return actions.commitStateChange(label, ['steps'], () => {
    const arr = (state.get('steps') || []).slice();
    for (const w of writes) {
      const s = arr.find(x => x.id === w.stepId);
      if (!s) continue;
      const subs = { ...(s.subtitles || {}) };
      if (w.entry) subs[langKeyOf(w.lang)] = w.entry;
      else         delete subs[langKeyOf(w.lang)];
      if (Object.keys(subs).length) s.subtitles = subs;
      else                          delete s.subtitles;
    }
    state.setState({ steps: arr });
    state.markDirty();   // commitStateChange only marks dirty on undo/redo, not the initial pass
  });
}

/** Hand-edit: store the text with the CURRENT source fingerprint. */
export function setSubtitleOverride(stepId, lang, text) {
  const s = (state.get('steps') || []).find(x => x.id === stepId);
  if (!s) return false;
  const entry = {
    text:    String(text ?? ''),
    srcHash: srcHashOf(subtitleSourceText(s)),
    edited:  true,
  };
  return _writeEntries('Edit subtitle', [{ stepId, lang, entry }]);
}

/** Drop the override — back to the live voiceover copy. */
export function clearSubtitleOverride(stepId, lang) {
  return _writeEntries('Reset subtitle to auto', [{ stepId, lang, entry: null }]);
}

// ─── Translation (authoring-time, Google v2 via main process) ───────────────

function _apiKey() {
  try { return (userSettings.get()?.cloud?.googleApiKey || '').trim(); }
  catch { return ''; }
}

export function translationAvailable() {
  return !!(_apiKey() && window.sbsNative?.translate?.batch);
}

async function _translateBatch(texts, target) {
  const key = _apiKey();
  if (!key) return { ok: false, error: 'No Google API key — Settings → Cloud TTS tab.' };
  if (!window.sbsNative?.translate?.batch) {
    return { ok: false, error: 'Translation bridge missing — restart the app (main-process update).' };
  }
  // source omitted → Google auto-detects (projects can be any language)
  return window.sbsNative.translate.batch(texts, '', target, key);
}

/**
 * ↺ Refresh one step's subtitle:
 *   Original  → drop the override (back to live voiceover copy).
 *   Translated→ re-translate the CURRENT voiceover now and store it as
 *               un-edited (discards a hand-edit — that's what ↺ means).
 */
export async function refreshSubtitle(stepId, lang) {
  if (!lang) return { ok: !!clearSubtitleOverride(stepId, lang) };
  const s = (state.get('steps') || []).find(x => x.id === stepId);
  const src = subtitleSourceText(s);
  if (!src) return { ok: !!clearSubtitleOverride(stepId, lang) };
  const res = await _translateBatch([src], lang);
  if (!res?.ok) return { ok: false, error: res?.error || 'Translation failed.' };
  const entry = { text: String(res.texts?.[0] ?? ''), srcHash: srcHashOf(src), edited: false };
  _writeEntries('Refresh subtitle', [{ stepId, lang, entry }]);
  return { ok: true };
}

/**
 * Batch-translate subtitles for every step with narration — INCREMENTAL:
 *   • fresh entries (hash matches) are skipped         (auto AND edited)
 *   • stale EDITED entries are skipped                 (never clobber a hand-fix;
 *     the STALE chip + per-line ↺ is the user's path)
 *   • missing entries and stale UN-edited entries are (re)translated
 * { force:true } re-translates un-edited entries even when fresh.
 * One undoable commit for the whole batch.
 */
export async function translateAllSubtitles({ lang = 'he', force = false, onProgress } = {}) {
  const steps = (state.get('steps') || []).filter(s => !s.isBaseStep);
  const jobs = [];
  let skippedEdited = 0;
  for (const s of steps) {
    const src = subtitleSourceText(s);
    if (!src) continue;
    const e = getSubtitleEntry(s, lang);
    const fresh = e && e.srcHash === srcHashOf(src);
    if (e && e.edited) { if (!fresh) skippedEdited++; continue; }   // hand-fixes are sacred
    if (fresh && !force) continue;                                   // up to date
    jobs.push({ stepId: s.id, src });
  }
  if (!jobs.length) return { ok: true, translated: 0, skippedEdited };

  const writes = [];
  const CHUNK = 32;                      // Google v2 accepts ≤128 q per call; stay modest
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const chunk = jobs.slice(i, i + CHUNK);
    onProgress?.(i, jobs.length);
    const res = await _translateBatch(chunk.map(j => j.src), lang);
    if (!res?.ok) {
      // Commit what we have so a mid-run failure doesn't lose paid work.
      if (writes.length) _writeEntries(`Translate ${writes.length} subtitles`, writes);
      return { ok: false, error: res?.error || 'Translation failed.', translated: writes.length, skippedEdited };
    }
    chunk.forEach((j, k) => writes.push({
      stepId: j.stepId, lang,
      entry: { text: String(res.texts?.[k] ?? ''), srcHash: srcHashOf(j.src), edited: false },
    }));
  }
  onProgress?.(jobs.length, jobs.length);
  _writeEntries(`Translate ${writes.length} subtitles`, writes);
  return { ok: true, translated: writes.length, skippedEdited };
}

// ─── ✨ Punctuation sweep (V0.3.2.66) ───────────────────────────────────────
//
// Capitalize the first letter + ensure a terminal period across every step's
// caption, so pasted voiceover reads as clean subtitles.
//
// The sweep writes to the SUBTITLE layer, never to step.narration. That is a
// deliberate architectural choice, not a limitation: narration text is a
// first-class input to the render-cache segment key (render-cache.js
// _stepKeyView), so rewriting it on every step would miss every cached
// segment and re-render the whole movie — and purgeOrphans would then delete
// the old segments permanently. Subtitles are explicitly stripped from that
// key, so a caption sweep costs zero renders, zero re-synthesis and zero
// translation spend. Same on-screen result, none of the damage.

/**
 * Compute the sweep WITHOUT applying it — the dry-run that powers the
 * preview. Returns { changes:[{stepId, stepName, from, to, actions}],
 * unchanged, skipped }.
 */
export function planPunctuationSweep({ lang = '', opts = {} } = {}) {
  const steps = (state.get('steps') || []).filter(s => !s.isBaseStep);
  const changes = [];
  let unchanged = 0, skipped = 0, untranslated = 0, stale = 0;
  for (const s of steps) {
    const src = subtitleSourceText(s);
    if (!src) continue;                       // silent step — nothing to caption
    const entry  = getSubtitleEntry(s, lang);
    const status = subtitleStatus(s, lang);

    // V0.3.2.72 — three ways the sweep used to corrupt the caption layer:
    //
    // 1. UNTRANSLATED lines in a translated slot. resolveSubtitleText falls
    //    back to the SOURCE text when no entry exists, so polishing wrote
    //    English into the Hebrew slot marked edited+fresh — after which
    //    "Translate missing / stale" reported everything up to date and made
    //    zero API calls, and the export burned in English captions.
    if (lang && !entry) { untranslated++; continue; }
    //
    // 2. STALE entries. Re-stamping them with the CURRENT source hash
    //    destroys the only signal that the caption no longer matches what is
    //    spoken — the chip flips from red STALE to amber EDITED and batch
    //    translate then skips it forever. Leave staleness alone; ↺ on the
    //    chip is the intended repair.
    if (status === 'stale') { stale++; continue; }
    //
    // 3. ORIGINAL-language lines that have NO override yet still track the
    //    voiceover live. Polishing every one of them freezes the whole
    //    project's captions, so a later narration edit silently stops
    //    reaching the caption and the export ships the old wording. Only
    //    polish what the polish would actually change — handled below by
    //    the r.changed check, which leaves untouched lines live-following.

    const current = resolveSubtitleText(s, lang);
    const r = polishLine(current, opts);
    if (r.skipped) { skipped++; continue; }
    if (!r.changed) { unchanged++; continue; }
    changes.push({
      stepId:   s.id,
      stepName: s.name || '(unnamed step)',
      from:     current,
      to:       r.text,
      actions:  r.actions,
      hadEntry: !!entry,
    });
  }
  return { changes, unchanged, skipped, untranslated, stale };
}

/**
 * Apply a previously computed sweep plan. One undoable commit for the lot.
 * Entries are marked `edited` so a later Translate-All never clobbers the
 * polished text (hand-edits are sacred in translateAllSubtitles).
 */
export function applyPunctuationSweep(plan, { lang = '' } = {}) {
  const changes = plan?.changes || [];
  if (!changes.length) return { ok: true, applied: 0 };
  const byId = new Map((state.get('steps') || []).map(s => [s.id, s]));
  const writes = [];
  let dropped = 0;
  for (const c of changes) {
    const s = byId.get(c.stepId);
    // RE-VERIFY against CURRENT state. The plan was built before the preview
    // modal opened and the user may have sat on it — a step could have been
    // deleted, or its voiceover edited, in the meantime. Writing the stale
    // polished text stamped with the NEW source fingerprint would mark a
    // caption "fresh" that no longer matches what is spoken. Skip any line
    // whose source moved under us; it simply stays unpolished.
    if (!s) { dropped++; continue; }
    if (resolveSubtitleText(s, lang) !== c.from) { dropped++; continue; }
    writes.push({
      stepId: c.stepId,
      lang,
      entry: {
        text:    c.to,
        srcHash: srcHashOf(subtitleSourceText(s)),
        edited:  true,
      },
    });
  }
  if (!writes.length) return { ok: true, applied: 0, dropped };
  _writeEntries(`Fix punctuation on ${writes.length} subtitles`, writes);
  return { ok: true, applied: writes.length, dropped };
}
