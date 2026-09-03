/**
 * SBS — Offline translation engine (V0.3.2.147)
 * ==============================================
 *
 * Speaks the OpenAI `/v1/chat/completions` protocol, which Ollama,
 * LM Studio and llama.cpp's own server all implement. One client therefore
 * covers every practical local runtime, and switching runtime or model is
 * a settings change rather than a code change.
 *
 * It sits behind the SAME `translate:batch` IPC the Google path uses, so
 * the language-pack system above it — chunking, drift detection, review
 * states, replace rules, bake — is completely unchanged.
 *
 * Design decisions that matter
 * ────────────────────────────
 *
 * ONE STRING PER REQUEST. The caller's contract is that the returned array
 * lines up 1:1 with the input. Asking a model for "translate these 20 lines,
 * numbered" invites merged, dropped or renumbered lines, and a single
 * misalignment silently writes every translation onto the WRONG key — a
 * corruption that is invisible until someone reads the output. One string
 * per request makes misalignment structurally impossible. Throughput comes
 * back via a small concurrency pool instead.
 *
 * TAG PROTECTION. Language packs send whole text-box HTML. A language model
 * will cheerfully reflow markup, so tags are swapped for opaque markers
 * before translation and restored after. Markers the model loses are
 * dropped rather than guessed at — losing a <b> beats emitting broken HTML.
 *
 * DETERMINISM. temperature 0 and a fixed seed, so re-running a translation
 * gives the same answer. Without it, every re-translate would look like a
 * content change to the pack's drift detection.
 */

const LANG_NAMES = {
  en: 'English',  he: 'Hebrew',   iw: 'Hebrew',   ar: 'Arabic',
  ru: 'Russian',  fr: 'French',   de: 'German',   es: 'Spanish',
  it: 'Italian',  pt: 'Portuguese', nl: 'Dutch',  pl: 'Polish',
  tr: 'Turkish',  zh: 'Chinese',  ja: 'Japanese', ko: 'Korean',
  uk: 'Ukrainian', ro: 'Romanian', cs: 'Czech',   hu: 'Hungarian',
};

const langName = (code) => {
  const c = String(code || '').toLowerCase().split(/[-_]/)[0];
  return LANG_NAMES[c] || (code ? String(code) : '');
};

// Markers must be things a tokenizer keeps intact and a model won't
// translate. Corner brackets are rare in ordinary prose and survive round
// trips far better than angle brackets or curly braces.
const MARK_OPEN  = '⟦';   // ⟦
const MARK_CLOSE = '⟧';   // ⟧
const markerFor  = (i) => `${MARK_OPEN}${i}${MARK_CLOSE}`;

// Elements that never carry a closing tag, so they're never half a pair.
const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'meta', 'link',
  'source', 'area', 'base', 'col', 'embed', 'track', 'wbr']);

/**
 * Replace every HTML tag with an opaque marker, recording which opening tag
 * belongs to which closing tag.
 *
 * The pairing is what makes dropped markers safe. Without it, a model that
 * loses just the <b> still gets its </b> restored, and the box ends up with
 * a stray closing tag — invalid markup produced by the very step meant to
 * protect it.
 */
function protectTags(html) {
  const tags   = [];
  const pairOf = new Map();      // marker index → its partner's index
  const stack  = [];
  const text = String(html ?? '').replace(/<[^>]*>/g, (tag) => {
    const i = tags.length;
    tags.push(tag);
    const m           = /^<\s*(\/?)\s*([a-zA-Z][\w-]*)/.exec(tag);
    const name        = m ? m[2].toLowerCase() : '';
    const selfClosing = /\/\s*>$/.test(tag);
    if (m && m[1] === '/') {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name === name) {
          pairOf.set(stack[k].i, i);
          pairOf.set(i, stack[k].i);
          stack.splice(k, 1);
          break;
        }
      }
    } else if (name && !selfClosing && !VOID_TAGS.has(name)) {
      stack.push({ name, i });
    }
    return markerFor(i);
  });
  return { text, tags, pairOf };
}

/**
 * Put the tags back. A marker the model lost takes its tag with it — AND
 * its partner, so a half-surviving pair can't leave unbalanced markup
 * behind. Losing a <b> is cosmetic; emitting a lone </b> is a broken box.
 */
function restoreTags(text, tags, pairOf) {
  let out = String(text ?? '');

  const present = new Set();
  for (let i = 0; i < tags.length; i++) if (out.includes(markerFor(i))) present.add(i);

  const drop = new Set();
  for (let i = 0; i < tags.length; i++) {
    const p = pairOf?.get(i);
    if (p === undefined) continue;                 // void / unmatched — no partner to orphan
    if (!present.has(i) || !present.has(p)) { drop.add(i); drop.add(p); }
  }

  for (let i = 0; i < tags.length; i++) {
    out = out.split(markerFor(i)).join(drop.has(i) ? '' : tags[i]);
  }
  // Sweep malformed leftovers (e.g. "⟦ 2 ⟧" after the model reformatted one).
  return out.replace(new RegExp(`${MARK_OPEN}\\s*\\d+\\s*${MARK_CLOSE}`, 'g'), '');
}

/** Strip the wrappers models like to add around a bare answer. */
function cleanReply(raw) {
  let s = String(raw ?? '').trim();
  // Fenced block.
  const fence = /^```[a-z]*\s*\n([\s\S]*?)\n?```$/i.exec(s);
  if (fence) s = fence[1].trim();
  // Leading label ("Translation:", "Hebrew:", "תרגום:").
  s = s.replace(/^(translation|translated text|hebrew|english|תרגום)\s*[:\-–]\s*/i, '');
  // A whole-string quote wrap — only when both ends match and nothing
  // inside closes early, so a legitimately quoted sentence survives.
  const q = /^(["'“”„«»])([\s\S]*)\1$/.exec(s);
  if (q && !q[2].includes(q[1])) s = q[2];
  return s.trim();
}

function buildSystemPrompt(source, target, glossary) {
  const tgt = langName(target) || 'the target language';
  const src = langName(source);
  const lines = [
    src
      ? `You are a professional translator. Translate from ${src} to ${tgt}.`
      : `You are a professional translator. Detect the input language and translate it to ${tgt}.`,
    `Reply with ONLY the translated text. No preamble, no explanation, no quotes, no notes.`,
    `Preserve every ${MARK_OPEN}n${MARK_CLOSE} placeholder exactly as written, in the same order. They stand for formatting tags.`,
    `Keep numbers, measurements, part numbers and product codes exactly as they appear.`,
    `Preserve the leading and trailing whitespace of the input.`,
    `If the text is already in ${tgt}, return it unchanged.`,
    `Translate even single words or fragments. Never refuse, never ask a question.`,
  ];
  const terms = (glossary || []).filter(t => t && t.from && t.to);
  if (terms.length) {
    lines.push('Use these required translations for the following terms:');
    for (const t of terms.slice(0, 200)) lines.push(`  "${t.from}" -> "${t.to}"`);
  }
  return lines.join('\n');
}

/** POST one completion. Throws on transport/HTTP error. */
async function chat({ baseUrl, model, system, user, timeoutMs, apiKey }) {
  const url  = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs || 120000));
  try {
    const res = await fetch(url, {
      method:  'POST',
      signal:  ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        // Local servers ignore auth; LM Studio and some proxies want a token
        // present. Harmless either way.
        Authorization: `Bearer ${apiKey || 'local'}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user },
        ],
        // Determinism: the pack's drift detection compares translations, so
        // a re-run that merely rephrases would read as a real change.
        temperature: 0,
        top_p: 1,
        seed: 0,
        stream: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Local translator HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    }
    const json = await res.json();
    const out  = json?.choices?.[0]?.message?.content;
    if (typeof out !== 'string') throw new Error('Local translator returned no message content.');
    return out;
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`Local translator timed out after ${Math.round((timeoutMs || 120000) / 1000)}s. `
        + 'A cold model load can exceed this — try again once the model is resident, or raise the timeout.');
    }
    if (/fetch failed|ECONNREFUSED|other side closed/i.test(e?.message || '')) {
      throw new Error(`Cannot reach the local translator at ${baseUrl}. Is the server running?`);
    }
    throw e;
  } finally {
    clearTimeout(t);   // otherwise every request leaves a live timer behind
  }
}

/** Translate one string, with tag protection when it's HTML. */
async function translateOne(text, opts) {
  const raw = String(text ?? '');
  if (!raw.trim()) return raw;                       // whitespace/empty round-trips untouched

  const isHtml = opts.format === 'html';
  const { text: protectedText, tags, pairOf } = isHtml
    ? protectTags(raw)
    : { text: raw, tags: [], pairOf: null };
  // Nothing but markup (e.g. "<br/>") — no words to translate.
  if (!protectedText.replace(new RegExp(`${MARK_OPEN}\\d+${MARK_CLOSE}`, 'g'), '').trim()) return raw;

  const reply    = await chat({ ...opts, system: opts.system, user: protectedText });
  const cleaned  = cleanReply(reply);
  if (!cleaned) return raw;                          // model gave nothing — keep the source
  return isHtml ? restoreTags(cleaned, tags, pairOf) : cleaned;
}

/**
 * Translate an array of strings. The result is ALWAYS the same length and
 * order as the input; a string that fails individually comes back as its
 * original text and is reported in `failed`, so one bad line can't shift
 * every translation after it onto the wrong key.
 */
async function translateLocalBatch({
  baseUrl, model, texts, source, target, format = 'text',
  glossary = [], timeoutMs = 120000, concurrency = 2, apiKey = '',
  onProgress,
} = {}) {
  if (!baseUrl) return { ok: false, error: 'No local translator URL configured (Settings → Translation).' };
  if (!model)   return { ok: false, error: 'No local translator model configured (Settings → Translation).' };
  if (!Array.isArray(texts) || !texts.length) return { ok: false, error: 'No texts to translate.' };
  if (!target) return { ok: false, error: 'No target language.' };

  const system = buildSystemPrompt(source, target, glossary);
  const opts   = { baseUrl, model, format, timeoutMs, apiKey, system };
  const out    = new Array(texts.length);
  const failed = [];
  let firstErr = null;
  let done     = 0;

  // Fixed-size worker pool over a shared cursor. Keeps the GPU busy without
  // firing every request at a server that can only hold a few in flight.
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= texts.length) return;
      try {
        out[i] = await translateOne(texts[i], opts);
      } catch (e) {
        out[i] = String(texts[i] ?? '');             // keep the source line
        failed.push(i);
        if (!firstErr) firstErr = e?.message || 'Local translation failed.';
        // A connection failure will hit every remaining item too — stop
        // instead of grinding through hundreds of identical timeouts.
        if (/Cannot reach the local translator/i.test(firstErr)) { cursor = texts.length; return; }
      }
      onProgress?.(++done, texts.length);
    }
  };

  const n = Math.max(1, Math.min(8, concurrency | 0 || 1));
  await Promise.all(Array.from({ length: Math.min(n, texts.length) }, worker));

  if (failed.length === texts.length) return { ok: false, error: firstErr || 'Local translation failed.' };
  return {
    ok: true,
    texts: out.map(v => String(v ?? '')),
    ...(failed.length ? { partial: true, failedCount: failed.length, error: firstErr } : {}),
  };
}

/** Connection probe for the settings UI: round-trips one short phrase. */
async function testLocalTranslator({ baseUrl, model, target = 'he', timeoutMs = 60000, apiKey = '' } = {}) {
  if (!baseUrl) return { ok: false, error: 'Enter the server URL first.' };
  if (!model)   return { ok: false, error: 'Enter the model name first.' };
  const started = Date.now();
  try {
    const sample = 'Attach the bracket to the frame using two screws.';
    const reply  = await chat({
      baseUrl, model, timeoutMs, apiKey,
      system: buildSystemPrompt('en', target, []),
      user:   sample,
    });
    const text = cleanReply(reply);
    return { ok: true, ms: Date.now() - started, sample, text, model };
  } catch (e) {
    return { ok: false, error: e?.message || 'Test failed.', ms: Date.now() - started };
  }
}

module.exports = { translateLocalBatch, testLocalTranslator };
