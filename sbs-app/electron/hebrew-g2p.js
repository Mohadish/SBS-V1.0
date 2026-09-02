'use strict';

/**
 * hebrew-g2p.js — Hebrew text → IPA phonemes (V0.3.2.133).
 *
 * A faithful JS port of the `phonikud` pipeline (CC BY 4.0,
 * https://github.com/phonikud/phonikud) — the exact G2P the Hebrew Kokoro
 * checkpoint was trained with. Train/inference parity is a hard requirement:
 * every rule here mirrors the Python original, and scripts/test-hebrew-g2p.js
 * asserts byte-identical output against Python-generated fixtures.
 *
 * Two stages, both offline:
 *   1. addDiacritics(text)  — nikud restoration via the phonikud-1.0 ONNX
 *      model (MIT), run on onnxruntime-node. Plain Hebrew carries no vowels,
 *      so this stage is mandatory, not cosmetic.
 *   2. phonemize(text)      — rule-based FST: vocalized Hebrew → IPA with
 *      stress marks, normalized into Kokoro's 178-token symbol set.
 *
 * Deliberately NOT ported (documented divergence from Python phonikud):
 *   - Expander (digits/dates → Hebrew words). Narration text should spell
 *     numbers out; the app's per-language replace rules (V0.3.2.130) are the
 *     right place for that policy, not the G2P.
 *   - Latin fallback G2P. Latin runs are dropped by post_clean exactly as
 *     Python does with fallback=None. Mixed-language synth is a later phase.
 */

const fs = require('fs');
const path = require('path');

// ─── Unicode constants (mirror phonikud.lexicon) ────────────────────────────

const VOCAL_SHVA_DIACRITIC = 'ֽ';   // meteg
const HATAMA_DIACRITIC     = '֫';   // ole — stress mark
const PREFIX_DIACRITIC     = '|';
const NIKUD_HASER_DIACRITIC = '֯';  // masora
const EN_GERESH            = "'";

const SHVA   = 'ְ';
const SIN    = 'ׂ';
const PATAH  = 'ַ';
const KAMATZ = 'ָ';
const HATAF_KAMATZ = 'ֳ';
const DAGESH = 'ּ';
const HOLAM  = 'ֹ';
const HIRIK  = 'ִ';
const KUBUTS = 'ֻ';
const TSERE  = 'ֵ';
const SEGOL  = 'ֶ';

const STRESS_PHONEME = 'ˈ';   // ˈ

const SET_ENHANCED_DIACRITICS = new Set([HATAMA_DIACRITIC, PREFIX_DIACRITIC, VOCAL_SHVA_DIACRITIC]);

const GERESH_PHONEMES = { 'ג': 'dʒ', 'ז': 'ʒ', 'ת': 'ta', 'צ': 'tʃ', 'ץ': 'tʃ' };

const LETTERS_PHONEMES = {
  'א': 'ʔ', 'ב': 'v', 'ג': 'g', 'ד': 'd', 'ה': 'h', 'ו': 'v', 'ז': 'z',
  'ח': 'x', 'ט': 't', 'י': 'j', 'ך': 'x', 'כ': 'x', 'ל': 'l', 'ם': 'm',
  'מ': 'm', 'ן': 'n', 'נ': 'n', 'ס': 's', 'ע': 'ʔ', 'פ': 'f', 'ף': 'f',
  'ץ': 'ts', 'צ': 'ts', 'ק': 'k', 'ר': 'r', 'ש': 'ʃ', 'ת': 't',
  ['ב' + DAGESH]: 'b', ['כ' + DAGESH]: 'k', ['פ' + DAGESH]: 'p',
  ['ש' + 'ׁ']: 'ʃ', ['ש' + SIN]: 's',
  "'": '',
};

const NIKUD_PHONEMES = {
  'ִ': 'i', 'ֱ': 'e', 'ֵ': 'e', 'ֶ': 'e', 'ֲ': 'a',
  'ַ': 'a', 'ׇ': 'o', 'ֹ': 'o', 'ֺ': 'o', 'ֻ': 'u',
  'ֳ': 'o', 'ָ': 'a',
  [HATAMA_DIACRITIC]: STRESS_PHONEME,
  [VOCAL_SHVA_DIACRITIC]: 'e',
};

const MODERN_SCHEMA = { x: 'χ', r: 'ʁ', g: 'ɡ' };

const PUNCTUATION = new Set(['.', ',', '!', '?', ' ']);

// Chars introduced by hyper-phoneme escapes ([word](/ipa/)) — postClean must
// let them through, exactly like Python's lexicon.ADDITIONAL_PHONEMES
// (module-global and persistent across calls, mirroring the original).
const ADDITIONAL_PHONEMES = new Set();

const SET_PHONEMES = new Set([
  ...Object.values(NIKUD_PHONEMES),
  ...Object.values(LETTERS_PHONEMES),
  ...Object.values(GERESH_PHONEMES),
  ...Object.values(MODERN_SCHEMA),
  'w',
].flatMap(p => [p]).filter(Boolean));

// HE_PATTERN: standard nikud+letters plus the enhanced diacritics + '"'
const NON_STANDARD = VOCAL_SHVA_DIACRITIC + HATAMA_DIACRITIC + '\\|' + NIKUD_HASER_DIACRITIC + EN_GERESH;
const HE_PATTERN = new RegExp(`[\\u05b0-\\u05ea${NON_STANDARD}"]+`, 'g');

// ─── normalize (phonikud.utils.normalize) ───────────────────────────────────

// NFD-decompose, sort each letter's combining marks, canonicalize gershayim.
function normalize(text) {
  let t = text.normalize('NFD');
  t = t.replace(/(\p{L})(\p{M}+)/gu, (_, letter, marks) => letter + [...marks].sort().join(''));
  t = t.replace(/״/g, '"').replace(/׳/g, "'");
  t = t.replace(/׳/g, "'").replace(/־/g, '-');
  return t;
}

// ─── Letter model (phonikud.variants.Letter) ────────────────────────────────

class Letter {
  constructor(char, diac) {
    this.char = normalize(char);
    this.allDiac = normalize(diac);
  }
  get diac() {
    return [...this.allDiac].filter(c => !SET_ENHANCED_DIACRITICS.has(c)).join('');
  }
  toString() { return this.char + this.allDiac; }
}

const LETTERS_RE = /(\p{L})([\p{M}'|]*)/gu;

function getLetters(word) {
  const out = [];
  for (const m of word.matchAll(LETTERS_RE)) out.push(new Letter(m[1], m[2]));
  return out;
}

// ─── Vocal shva + stress prediction (phonikud.utils) ────────────────────────

function markVocalShva(word) {
  const letters = getLetters(word);
  if (!letters.length) return word;
  if ('למנרי'.includes(letters[0].char)) {
    letters[0].allDiac += VOCAL_SHVA_DIACRITIC;
  } else if (letters.length > 1 && 'אעה'.includes(letters[1].char)) {
    letters[0].allDiac += VOCAL_SHVA_DIACRITIC;
  } else if ('וכלב'.includes(letters[0].char) && letters[0].allDiac.includes(PREFIX_DIACRITIC)) {
    letters[0].allDiac += VOCAL_SHVA_DIACRITIC;
  }
  for (const letter of letters) {
    if (letter.allDiac.includes(PREFIX_DIACRITIC)) {
      letter.allDiac = letter.allDiac.replace(/\|/g, '') + PREFIX_DIACRITIC;
    }
  }
  return letters.map(l => l.toString()).join('');
}

// Syllable split (phonikud.syllables.get_syllables)
const VOWEL_DIACS = [];
for (let i = 0x05b1; i < 0x05bc; i++) VOWEL_DIACS.push(String.fromCharCode(i));
VOWEL_DIACS.push('ׇ', 'ֽ');

function hasVowelDiacs(s) {
  if (s === 'ו' + DAGESH) return true;
  return VOWEL_DIACS.some(d => s.includes(d));
}

function getSyllables(word) {
  const letters = getLetters(word);
  const syllables = [];
  let cur = '';
  let vowelState = false;
  let i = 0;
  while (i < letters.length) {
    const letter = letters[i];
    const hasVowel = hasVowelDiacs(letter.toString()) || (i === 0 && letter.allDiac.includes(SHVA));
    const vav1 = i + 2 < letters.length && letters[i + 2].char === 'ו';
    const vav2 = i + 3 < letters.length && letters[i + 3].char === 'ו';

    if (hasVowel) {
      if (vowelState) { syllables.push(cur); cur = letter.toString(); }
      else cur += letter.toString();
      vowelState = true;
    } else {
      cur += letter.toString();
    }
    i += 1;

    if (vav1 && vav2) {
      if (cur) { syllables.push(cur + letters[i].toString()); cur = ''; }
      cur = letters[i + 1].toString() + letters[i + 2].toString();
      i += 3;
      vowelState = true;
    } else if (vav1 && letters[i + 1].diac) {
      if (cur) { syllables.push(cur); cur = ''; }
      vowelState = false;
    }
  }
  if (cur) syllables.push(cur);
  return syllables;
}

function addMilraHatama(word) {
  const syllables = getSyllables(word);
  if (!syllables.length) return word;
  const stressIndex = syllables.length === 1 ? 0 : syllables.length - 1;
  const letters = getLetters(syllables[stressIndex]);
  letters[0].allDiac += HATAMA_DIACRITIC;
  syllables[stressIndex] = letters.map(l => l.toString()).join('');
  return syllables.join('');
}

function sortHatama(letters) {
  for (let i = 0; i < letters.length - 1; i++) {
    const diacs = [...letters[i].allDiac];
    if (diacs.includes(HATAMA_DIACRITIC) && diacs.includes(NIKUD_HASER_DIACRITIC)) {
      letters[i].allDiac = diacs.filter(d => d !== HATAMA_DIACRITIC).join('');
      letters[i + 1].allDiac += HATAMA_DIACRITIC;
    }
  }
  return letters;
}

// Stress goes immediately before the first vowel (TTS convention).
function sortStress(phonemes) {
  const joined = phonemes.join('');
  if (!joined.includes(STRESS_PHONEME)) return phonemes;
  if (![...'aeiou'].some(v => joined.includes(v))) return phonemes;
  phonemes = phonemes.filter(p => p !== STRESS_PHONEME);
  for (let i = 0; i < phonemes.length; i++) {
    for (let j = 0; j < phonemes[i].length; j++) {
      if ('aeiou'.includes(phonemes[i][j])) {
        phonemes[i] = phonemes[i].slice(0, j) + STRESS_PHONEME + phonemes[i].slice(j);
        return phonemes;
      }
    }
  }
  return phonemes;
}

// ─── The FST core (phonikud.hebrew) ─────────────────────────────────────────

function handleYud(cur, prev, next) {
  return !!(next && !cur.diac && prev && (prev.char + prev.diac) !== 'אֵ' &&
    !(next.char === 'ו' && next.diac && !next.diac.includes(SHVA)));
}

function handleVav(cur, prev, next) {
  if (prev && prev.diac.includes(SHVA) && cur.diac.includes(HOLAM)) return [['vo'], true, true, 0];

  if (next && next.char === 'ו') {
    const diac = cur.diac + next.diac;
    if (diac.includes(HOLAM)) return [['vo'], true, true, 1];
    if (cur.diac === next.diac) return [['vu'], true, true, 1];
    if (cur.diac.includes(HIRIK)) return [['vi'], true, true, 0];
    if (cur.diac.includes(SHVA) && !next.diac) return [['v'], true, true, 0];
    if (cur.diac.includes(KAMATZ) || cur.diac.includes(PATAH)) return [['va'], true, true, 0];
    if (cur.diac.includes(TSERE) || cur.diac.includes(SEGOL)) return [['ve'], true, true, 0];
    return [[], false, false, 0];
  }

  if (/[ַ-ָ]/.test(cur.diac)) return [['va'], true, true, 0];
  if (cur.diac.includes(TSERE) || cur.diac.includes(SEGOL)) return [['ve'], true, true, 0];
  if (cur.diac.includes(HOLAM)) return [['o'], true, true, 0];
  if (cur.diac.includes(KUBUTS) || cur.diac.includes(DAGESH)) return [['u'], true, true, 0];
  if (cur.diac.includes(SHVA) && !prev) return [['ve'], true, true, 0];
  if (cur.diac.includes(HIRIK)) return [['vi'], true, true, 0];
  if (next && !cur.diac) return [[], true, true, 0];
  return [['v'], true, true, 0];
}

function letterToPhonemes(cur, prev, next) {
  let curPhonemes = [];
  let skipDiacritics = false;
  let skipConsonants = false;
  let skipOffset = 0;

  if (cur.allDiac.includes(NIKUD_HASER_DIACRITIC)) {
    skipConsonants = true;
    skipDiacritics = true;
  } else if (cur.char === 'א' && !cur.diac && prev) {
    if (next && next.char !== 'ו') skipConsonants = true;
  } else if (cur.char === 'י' && handleYud(cur, prev, next)) {
    skipConsonants = true;
  } else if (cur.char === 'ש' && cur.diac.includes(SIN)) {
    if (next && next.char === 'ש' && !next.diac && /[ַָ]/.test(cur.diac)) {
      curPhonemes.push('sa');
      skipConsonants = true;
      skipDiacritics = true;
      skipOffset += 1;
    } else {
      curPhonemes.push('s');
      skipConsonants = true;
    }
  } else if (cur.char === 'ש' && !cur.diac && prev && prev.diac.includes(SIN)) {
    curPhonemes.push('s');
    skipConsonants = true;
  } else if (!next && cur.char === 'ח' && cur.diac.includes(PATAH)) {
    curPhonemes.push('ax');
    skipDiacritics = true;
    skipConsonants = true;
  } else if (!next && cur.char === 'ה' && cur.diac.includes(PATAH)) {
    curPhonemes.push('ah');
    skipDiacritics = true;
    skipConsonants = true;
  } else if (!next && cur.char === 'ע' && cur.diac.includes(PATAH)) {
    curPhonemes.push('a');
    skipDiacritics = true;
    skipConsonants = true;
  }

  if (cur.diac.includes("'") && GERESH_PHONEMES[cur.char] !== undefined) {
    if (cur.char === 'ת') {
      curPhonemes.push(GERESH_PHONEMES[cur.char]);
      skipDiacritics = true;
      skipConsonants = true;
    } else {
      curPhonemes.push(GERESH_PHONEMES[cur.char]);
      skipConsonants = true;
    }
  } else if (cur.diac.includes(DAGESH) && LETTERS_PHONEMES[cur.char + DAGESH] !== undefined) {
    curPhonemes.push(LETTERS_PHONEMES[cur.char + DAGESH]);
    skipConsonants = true;
  } else if (cur.char === 'ו' && !cur.allDiac.includes(NIKUD_HASER_DIACRITIC)) {
    const [vavPhonemes, vavSkipCons, vavSkipDiac, vavSkipOffset] = handleVav(cur, prev, next);
    curPhonemes.push(...vavPhonemes);
    skipConsonants = vavSkipCons;
    skipDiacritics = vavSkipDiac;
    skipOffset += vavSkipOffset;
  }

  if (!skipConsonants) curPhonemes.push(LETTERS_PHONEMES[cur.char] ?? '');

  if (cur.diac.includes(KAMATZ) && next && next.diac.includes(HATAF_KAMATZ)) {
    curPhonemes.push('o');
    skipDiacritics = true;
  }

  let nikudPhonemes = [];
  if (!skipDiacritics) {
    nikudPhonemes = [...cur.allDiac].map(n => NIKUD_PHONEMES[n] ?? '');
  } else if (cur.allDiac.includes(HATAMA_DIACRITIC)) {
    nikudPhonemes = [STRESS_PHONEME];
  }
  curPhonemes.push(...nikudPhonemes);
  curPhonemes = sortStress(curPhonemes);
  curPhonemes = curPhonemes.filter(p => [...p].every(ch => SET_PHONEMES.has(ch)));
  curPhonemes = curPhonemes.filter(Boolean);
  return [curPhonemes, skipOffset];
}

function phonemizeHebrewWord(letters) {
  const phonemes = [];
  let i = 0;
  while (i < letters.length) {
    const cur = letters[i];
    const prev = i > 0 ? letters[i - 1] : null;
    const next = i + 1 < letters.length ? letters[i + 1] : null;
    const [nextPhonemes, skipOffset] = letterToPhonemes(cur, prev, next);
    phonemes.push(...nextPhonemes);
    i += skipOffset + 1;
  }
  return phonemes;
}

// ─── Post-processing (phonikud.utils) ───────────────────────────────────────

function postNormalize(phonemes) {
  return phonemes.split(' ').map(word => {
    word = word.replace(/ʔ$/, '');
    word = word.replace(/h$/, '');
    word = word.replace(/ˈh$/, '');
    word = word.replace(/ij$/, 'i');
    return word;
  }).join(' ');
}

function postClean(phonemes) {
  const out = [];
  for (const ch of phonemes) {
    if (ch === '-') out.push(' ');
    else if (SET_PHONEMES.has(ch) || ADDITIONAL_PHONEMES.has(ch) ||
             ch === ' ' || PUNCTUATION.has(ch)) out.push(ch);
  }
  return out.join('');
}

// ─── Public: phonemize (mirrors phonikud.phonemize defaults) ────────────────

function phonemize(text) {
  text = normalize(text);

  text = text.replace(HE_PATTERN, (word, offset) => {
    if (offset > 0 && text[offset - 1] === '[') return word;   // hyper-phoneme escape
    // PARITY NOTE: Python phonikud calls mark_vocal_shva(word) but DISCARDS the
    // return value (strings are immutable), so the rule-based vocal-shva
    // prediction is inert in the release the model was trained with. Vocal shva
    // arrives via the meteg the NIKUD MODEL emits, not this rule. We mirror the
    // actual behaviour; markVocalShva stays exported for a future upstream fix.
    if (!word.includes(HATAMA_DIACRITIC)) word = addMilraHatama(word);
    let letters = getLetters(word);
    letters = sortHatama(letters);
    let phonemes = phonemizeHebrewWord(letters).join('');
    phonemes = postNormalize(phonemes);
    for (const [k, v] of Object.entries(MODERN_SCHEMA)) {
      phonemes = phonemes.replace(new RegExp(k, 'g'), v);
    }
    return phonemes;
  });

  // hyper-phonemes: [word](/ipa/) → ipa. Register each escaped char so
  // postClean keeps it (Python adds them to lexicon.ADDITIONAL_PHONEMES).
  text = text.replace(/\[(.+?)\]\(\/(.+?)\/\)/g, (_, __, ipa) => {
    for (const ch of ipa) ADDITIONAL_PHONEMES.add(ch);
    return ipa;
  });

  text = postClean(text);
  return text;
}

// ─── Nikud restoration (port of phonikud_onnx, MIT) ─────────────────────────

const NIKUD_CLASSES = [
  '', '<MAT_LECT>', 'ּ', 'ְ', 'ֱ', 'ֲ', 'ֳ', 'ִ',
  'ֵ', 'ֶ', 'ַ', 'ָ', 'ֹ', 'ֺ', 'ֻ',
  'ְּ', 'ֱּ', 'ֲּ', 'ֳּ', 'ִּ',
  'ֵּ', 'ֶּ', 'ַּ', 'ָּ', 'ֹּ',
  'ֺּ', 'ֻּ', 'ׇ', 'ׇּ',
];
const SHIN_CLASSES = ['ׁ', 'ׂ'];
const MATRES = new Set(['א', 'ו', 'י']);

function isHebrewLetter(ch) {
  const o = ch.codePointAt(0);
  return o >= 0x05d0 && o <= 0x05ea;
}

class Nikud {
  /**
   * @param {string} modelPath   phonikud-1.0.onnx
   * @param {string} tokenizerPath  vendored dictabert char tokenizer.json
   */
  constructor(modelPath, tokenizerPath) {
    this._modelPath = modelPath;
    this._sessionPromise = null;
    const tok = JSON.parse(fs.readFileSync(tokenizerPath, 'utf-8'));
    this._vocab = tok.model.vocab;
    this._cls = this._vocab['[CLS]'];
    this._sep = this._vocab['[SEP]'];
    this._unk = this._vocab['[UNK]'];
  }

  async _ensureSession() {
    // Cache the PROMISE, not the resolved session: two interleaved cold calls
    // would otherwise both pass a null check and create the 300MB native
    // session twice, leaking one (same pattern as the worker's _loadPromise).
    if (!this._sessionPromise) {
      const ort = require('onnxruntime-node');
      this._sessionPromise = ort.InferenceSession.create(this._modelPath);
      this._sessionPromise.catch(() => { this._sessionPromise = null; });
    }
    return this._sessionPromise;
  }

  // Char-level tokenize matching the dictabert tokenizer's FULL normalizer
  // chain: NFKC → Lowercase → StripAccents → Replace('<foreign>'→'[UNK]') →
  // Replace(disallowed-run → '[UNK]'), then one token per char with the
  // literal '[UNK]' kept as a single token (per the pre_tokenizer).
  //
  // Two subtleties the review proved matter (input ids otherwise diverge and
  // can flip the model's stress/nikud predictions):
  //   1. StripAccents removes COMBINING marks only — it does NOT decompose,
  //      so composed é survives it and then falls to the disallowed Replace.
  //      (Do not NFD here.)
  //   2. A RUN of disallowed chars collapses to ONE [UNK] token, not N.
  //
  // Returns ids + a map back to source character indices (positions that
  // produce no token, or that sit inside a collapsed [UNK] run, map to -1 /
  // the run's first char — non-Hebrew chars never receive diacritics anyway).
  _tokenize(text) {
    // Allowed set — verbatim from the vendored tokenizer.json Replace regex.
    const ALLOWED = /[\u0590-\u05ff\x00-\x7f\u200c-\u203f\u20a0-\u20bf\u2200-\u22ff\u2150-\u218b\ufb00-\ufb4f]/;
    const ids = [this._cls];
    const srcIndex = [-1];
    const chars = [...text];
    let inUnkRun = false;
    for (let i = 0; i < chars.length; i++) {
      // '<foreign>' literal → one [UNK] (first Replace normalizer).
      if (chars[i] === '<' && chars.slice(i, i + 9).join('') === '<foreign>') {
        ids.push(this._unk); srcIndex.push(-1);
        i += 8; inUnkRun = false; continue;
      }
      // NFKC → lowercase → strip combining marks WITHOUT decomposing.
      let c = chars[i].normalize('NFKC').toLowerCase();
      c = [...c].filter(ch => !/\p{Mn}/u.test(ch)).join('');
      if (!c) { continue; }
      for (const ch of c) {
        if (ALLOWED.test(ch)) {
          ids.push(this._vocab[ch] ?? this._unk);
          srcIndex.push(i);
          inUnkRun = false;
        } else if (!inUnkRun) {
          // First char of a disallowed run → single [UNK] for the whole run.
          ids.push(this._unk);
          srcIndex.push(-1);
          inUnkRun = true;
        }
        // subsequent disallowed chars: swallowed into the same [UNK]
      }
    }
    ids.push(this._sep);
    srcIndex.push(-1);
    return { ids, srcIndex };
  }

  /** Plain Hebrew → Hebrew with nikud + stress (ole) + vocal-shva (meteg) + prefix (|). */
  async addDiacritics(text) {
    const ort = require('onnxruntime-node');
    const session = await this._ensureSession();

    const stripped = text.replace(/[֐-ׇ|]/g, m => (isHebrewLetter(m) ? m : ''));
    const { ids, srcIndex } = this._tokenize(stripped);
    const n = ids.length;
    const big = BigInt64Array.from(ids.map(BigInt));
    const feeds = {
      input_ids: new ort.Tensor('int64', big, [1, n]),
      attention_mask: new ort.Tensor('int64', BigInt64Array.from({ length: n }, () => 1n), [1, n]),
      token_type_ids: new ort.Tensor('int64', new BigInt64Array(n), [1, n]),
    };
    const out = await session.run(feeds);

    const nikudLogits = out.nikud_logits;
    const shinLogits = out.shin_logits;
    const addLogits = out.additional_logits;
    const [/*b*/, seq, nNikud] = nikudLogits.dims;
    const nShin = shinLogits.dims[2];
    const nAdd = addLogits.dims[2];

    const argmax = (data, row, width) => {
      let best = 0, bestV = -Infinity;
      for (let k = 0; k < width; k++) {
        const v = data[row * width + k];
        if (v > bestV) { bestV = v; best = k; }
      }
      return best;
    };

    const chars = [...stripped];
    const pieces = chars.map(c => c);   // start from the raw chars
    for (let t = 0; t < Math.min(seq, srcIndex.length); t++) {
      const si = srcIndex[t];
      if (si < 0) continue;
      const ch = chars[si];
      if (!isHebrewLetter(ch)) continue;

      let nikud = NIKUD_CLASSES[argmax(nikudLogits.data, t, nNikud)];
      const shin = ch === 'ש' ? SHIN_CLASSES[argmax(shinLogits.data, t, nShin)] : '';
      if (nikud === '<MAT_LECT>') {
        if (!MATRES.has(ch)) nikud = '';
        else { pieces[si] = ch; continue; }
      }
      const stress = addLogits.data[t * nAdd + 0] > 0 ? HATAMA_DIACRITIC : '';
      const shva  = addLogits.data[t * nAdd + 1] > 0 ? VOCAL_SHVA_DIACRITIC : '';
      const prefix = addLogits.data[t * nAdd + 2] > 0 ? PREFIX_DIACRITIC : '';
      pieces[si] = ch + shin + nikud + stress + shva + prefix;
    }
    return pieces.join('');
  }
}

module.exports = { phonemize, normalize, Nikud };
