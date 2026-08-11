/**
 * ✨ Text polish (V0.3.2.66) — deterministic caption punctuation.
 *
 * Two jobs, and deliberately ONLY two:
 *   1. Capitalize the first letter of the line.
 *   2. Ensure the line ends with a period.
 *
 * No AI, no network, no GPU — and that is the RIGHT answer here, not a
 * compromise. Capitalization and terminal punctuation are decidable from
 * the characters themselves; a language model would add latency, cost and
 * non-determinism to a problem that has exact rules. What actually makes
 * this hard is the content: SBS narration mixes English prose, Hebrew,
 * part codes (M8, Ø3.5), dimensions (12 mm), abbreviations (Fig., approx.)
 * and bare numbers. Every rule below exists to keep those intact.
 *
 * Guarantees:
 *   • IDEMPOTENT — polish(polish(x)) === polish(x).
 *   • NEVER lowercases anything, ever. One write op: one lowercase code
 *     point → its uppercase form.
 *   • NEVER produces '..' that wasn't in the input.
 *   • Locale-independent (toUpperCase, never toLocaleUpperCase — the
 *     Turkish dotted-i would make output differ per machine).
 *   • Caseless scripts (Hebrew, Arabic, CJK) are a no-op for capitalization;
 *     Hebrew still gets a terminal period, which is correct — Hebrew uses
 *     the same U+002E full stop, and in LOGICAL string order it belongs at
 *     the end of the string exactly as in English (the bidi algorithm
 *     renders it on the visual left at display time).
 *
 * Pure module: no imports, no DOM, no state. Node-testable in isolation.
 */

// ─── Character classes ──────────────────────────────────────────────────────

// Invisible bidi/formatting controls. Never counted as content, never
// stripped — Hebrew lines may legitimately carry isolates/embeddings.
const BIDI_CTRL = '‎‏؜‪‫‬‭‮⁦⁧⁨⁩﻿';

// Characters skippable BEFORE the first letter when looking for something
// to capitalize. Digits and letters are hard stops and are NOT in this set.
const OPENERS = new Set([
  ...' \t ',
  ...'"\'`',
  ...'‘’“”‚„',        // curly quotes
  ...'«»‹›',                     // guillemets
  ...'׳״',                                 // Hebrew geresh / gershayim
  ...'-‐–—•·*',             // bullet / dash markers
  ...'([{',
  ...BIDI_CTRL,
]);

// Endings that already terminate a line. Comma and colon are deliberate:
// a comma marks a continued cue, a colon marks a label or list intro —
// appending a period to either corrupts the meaning.
const TERMINATORS = new Set([
  '.', '!', '?', '…', ';', ':', ',',
  '‽',           // interrobang
  '؟',           // Arabic question mark
  '׃',           // Hebrew sof pasuq
  '。', '！', '？',   // fullwidth CJK forms
]);

// Trailing dash = interrupted speech / hard wrap. Never terminate.
const CONTINUATION_TAILS = new Set(['-', '‐', '‑', '‒', '–', '—', '―']);

// Closing quotes/brackets — a period may already sit inside them.
const CLOSERS = new Set([')', ']', '}', '"', '\'', '’', '”', '»', '›', '״']);

// Measurement / math symbols. A line opening with one of these is notation,
// not prose — don't hunt past it for a letter to capitalize.
const SYMBOL_PREFIX = new Set([
  '⌀', '∅', 'Ø',   // diameter sign, empty set, Ø
  '°', '±', '×', 'µ', '≤', '≥',
  '#', '%', '$', '€', '£', '₪',    // incl. shekel
]);

// Lowercase tokens that must never be capitalized — unit symbols and
// abbreviations whose case is meaningful. 'mm gap' must not become 'Mm gap'.
const PROTECTED_LOWERCASE = new Set([
  'mm', 'cm', 'm', 'km', 'um', 'nm', 'kg', 'g', 'mg', 'ml', 'l',
  'in', 'ft', 's', 'ms', 'min', 'h', 'hr', 'psi', 'rpm', 'pcs', 'ea',
  'x', 'deg', 'ph',
  'e.g.', 'i.e.', 'etc.', 'cf.', 'vs.',
]);

// Unit symbols never count as prose "words" when deciding sentence-ness.
const UNIT_TOKENS = new Set([
  'mm', 'cm', 'm', 'km', 'um', 'nm', 'kg', 'g', 'mg', 'ml', 'l',
  'in', 'ft', 's', 'ms', 'min', 'h', 'hr', 'psi', 'rpm', 'nm', 'pcs', 'ea', 'deg',
]);

const RE_LOWER   = /\p{Ll}/u;
const RE_UPPER   = /\p{Lu}|\p{Lt}/u;
const RE_LETTER  = /\p{L}/u;
const RE_DIGIT   = /\p{Nd}/u;
const RE_HEBREW  = /[֐-׿]/;
const RE_SYMBOL  = /\p{S}/u;
const RE_EMOJI   = /\p{Extended_Pictographic}/u;
const RE_OPEN_PUNCT = /\p{Ps}|\p{Pi}/u;

// ─── Never-touch gate ───────────────────────────────────────────────────────

/**
 * Lines the sweep must leave completely alone. Returns a reason string, or
 * null when the line is fair game.
 */
export function neverTouchReason(line) {
  const s = String(line ?? '');
  if (!s.trim()) return 'empty';
  // Content check ignoring invisible controls
  const visible = [...s].filter(c => !BIDI_CTRL.includes(c)).join('').trim();
  if (!visible) return 'no visible content';

  // Markup / template / code
  if (/^<[^>]+>$/.test(visible)) return 'markup line';
  if (/\{\{.*\}\}|\$\{.*\}|%[sd]\b|\{\d+\}/.test(visible)) return 'template placeholder';

  // Non-speech caption tags and stage directions: fully bracketed content
  if (/^\[.*\]$/.test(visible)) return 'bracketed annotation';
  if (/^\(.*\)$/.test(visible)) return 'parenthetical annotation';
  if (/^♪.*♪$|^♫.*♫$/.test(visible)) return 'music cue';

  // Subtitle-format structural lines (defensive — SBS doesn't author these,
  // but pasted SRT/VTT fragments turn up in narration fields).
  if (/-->/.test(visible)) return 'timecode line';
  if (/^WEBVTT\b/.test(visible)) return 'WebVTT header';
  if (/^\d+$/.test(visible)) return 'bare number / cue index';

  return null;
}

// ─── Capitalization ─────────────────────────────────────────────────────────

/**
 * Capitalize the first CASED letter of the line.
 *
 * Scans by code point, skipping only OPENERS. Stops at the first letter of
 * ANY script — so a Hebrew line stops on a caseless Hebrew letter and is
 * correctly left alone, instead of the scan running on to capitalize some
 * Latin part code in the middle of the sentence.
 */
export function capitalizeFirst(line) {
  const s = String(line ?? '');

  // One recognised list marker may be skipped: "3. insert" → "3. Insert".
  // A single LETTER + '.'/')' is NOT accepted — that would eat initials.
  const marker = /^([\s‎‏]*(?:\d{1,3}[.)]|[•·*\-‐–—])\s+)/.exec(s);
  const offset = marker ? marker[1].length : 0;

  const chars = [...s.slice(offset)];
  let idx = offset;
  for (const cp of chars) {
    if (OPENERS.has(cp)) { idx += cp.length; continue; }
    if (SYMBOL_PREFIX.has(cp)) return s;          // notation, not prose
    if (RE_DIGIT.test(cp))     return s;          // "3 bolts" stays "3 bolts"
    if (!RE_LETTER.test(cp))   return s;          // any other symbol → bail
    // First letter found.
    if (!RE_LOWER.test(cp)) return s;             // already upper, or caseless (Hebrew)
    if (_protectedToken(s, idx)) return s;
    const up = cp.toUpperCase();                  // locale-INdependent by design
    if (up === cp) return s;
    if ([...up].length !== 1) return s;           // ß→SS, ﬁ→FI: don't expand
    return s.slice(0, idx) + up + s.slice(idx + cp.length);
  }
  return s;
}

/**
 * True when the token starting at `idx` must keep its lowercase first
 * letter: it carries a digit (part codes, versions), has deliberate
 * internal capitals (pH, mAh), or is a protected unit/abbreviation.
 */
function _protectedToken(s, idx) {
  const m = /^[\p{L}\p{Nd}.'’-]+/u.exec(s.slice(idx));
  if (!m) return false;
  const tok = m[0];
  if (RE_DIGIT.test(tok)) return true;                       // m8, v0.3.2, x4
  if (RE_UPPER.test(tok.slice(1))) return true;              // pH, iPhone, mAh
  if (PROTECTED_LOWERCASE.has(tok.toLowerCase())) return true;
  return false;
}

// ─── Terminal punctuation ───────────────────────────────────────────────────

/**
 * Ensure the line ends with a period — appending exactly one U+002E, and
 * only when the line is prose that isn't already terminated.
 */
export function ensureTerminalPeriod(line) {
  const s = String(line ?? '');

  // Split off the invisible tail so a bidi isolate terminator stays
  // outermost (and balanced) when we insert the period before it.
  let end = s.length;
  while (end > 0) {
    const c = s[end - 1];
    if (c === ' ' || c === '\t' || c === ' ' || BIDI_CTRL.includes(c)) { end--; continue; }
    break;
  }
  const body = s.slice(0, end).replace(/[ \t ]+$/, '');
  // Trailing plain whitespace is DROPPED (a trailing space wedges the Kokoro
  // phonemizer — see step-nav.js flushSave); bidi controls survive verbatim,
  // since a Hebrew line may legitimately close an isolate/embedding.
  const tail = [...s.slice(end)].filter(c => BIDI_CTRL.includes(c)).join('');
  if (!body) return s;

  if (!_needsPeriod(body)) return s;
  return body + '.' + tail;
}

function _needsPeriod(body) {
  const last = body[body.length - 1];

  if (TERMINATORS.has(last))         return false;   // already terminated
  if (CONTINUATION_TAILS.has(last))  return false;   // interrupted / wrapped
  if (/\.\.\.$|\. \. \.$/.test(body)) return false;  // spelled-out ellipsis
  if (RE_EMOJI.test(last))           return false;
  if (RE_SYMBOL.test(last))          return false;   // ♪ ✓ → ° etc.
  if (RE_OPEN_PUNCT.test(last))      return false;   // malformed tail
  if (/[/&+=]$/.test(body))          return false;   // lone connector

  // Closing quote/bracket whose inner character already terminates.
  if (CLOSERS.has(last)) {
    const prev = body[body.length - 2];
    if (prev && TERMINATORS.has(prev)) return false;
  }

  // Unbalanced straight quotes → don't guess, the tail may be a typo.
  // BUT Hebrew abbreviations are written with GERSHAYIM, which almost
  // everyone types as a straight double quote: מ"מ (mm), ס"מ (cm), ק"ג (kg),
  // בע"מ. Those are letters, not quotation marks — counting them made every
  // such line look unbalanced and silently skipped its period. Discount any
  // quote flanked by Hebrew letters (same for geresh in ג׳ / ג').
  const quotesOnly = body.replace(/(?<=[֐-׿])["'](?=[֐-׿])/g, '');
  const dq = (quotesOnly.match(/"/g) || []).length;
  if (dq % 2 === 1) return false;

  // URLs / paths / identifiers — a trailing period breaks copy-paste.
  const lastTok = body.split(/\s+/).pop() || '';
  if (/:\/\/|^www\.|@|^[A-Za-z]:\\|\.[a-z]{2,4}$/.test(lastTok)) return false;

  // Sentence-ness: the line must contain at least one real WORD. A pure
  // code/dimension line ("M8 x 20", "Ø3.5", "P/N 4471-02") gets no period.
  if (!_hasWordToken(body)) return false;

  return true;
}

function _hasWordToken(body) {
  for (const tok of body.split(/\s+/)) {
    const clean = tok.replace(/^[^\p{L}\p{Nd}]+|[^\p{L}\p{Nd}]+$/gu, '');
    if (!clean) continue;
    if (RE_HEBREW.test(clean)) {
      if ((clean.match(/[֐-׿]/g) || []).length >= 2) return true;
      continue;
    }
    if (RE_DIGIT.test(clean)) continue;                  // code token
    if (!/^\p{L}+$/u.test(clean)) continue;              // mixed junk
    if (clean.length < 2) continue;                       // single letter
    if (UNIT_TOKENS.has(clean.toLowerCase())) continue;   // bare unit
    return true;
  }
  return false;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Polish one line. Returns { text, changed, actions, skipped }.
 *   actions — ['capitalized'] / ['period'] / both, for the dry-run preview.
 *   skipped — the never-touch reason when the line was left alone.
 */
export function polishLine(line, opts = {}) {
  const src = String(line ?? '');
  const doCaps   = opts.capitalize !== false;
  const doPeriod = opts.period     !== false;

  const skip = neverTouchReason(src);
  if (skip) return { text: src, changed: false, actions: [], skipped: skip };

  let out = src;
  const actions = [];
  if (doCaps) {
    const c = capitalizeFirst(out);
    if (c !== out) { actions.push('capitalized'); out = c; }
  }
  if (doPeriod) {
    const p = ensureTerminalPeriod(out);
    if (p !== out) { actions.push('period'); out = p; }
  }

  // Hard invariant: never manufacture a double period.
  if (out.includes('..') && !src.includes('..')) {
    return { text: src, changed: false, actions: [], skipped: 'double-period guard' };
  }
  return { text: out, changed: out !== src, actions, skipped: null };
}
