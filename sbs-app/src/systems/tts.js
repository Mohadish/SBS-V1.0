/**
 * SBS — Text-to-speech router.
 *
 * Voice IDs are namespaced so backends slot in alongside without
 * changing callers.
 *
 *   id = 'os:<source>|<name>'     → Windows SAPI / OneCore / macOS / Linux
 *   id = 'kokoro:<speaker>'       → Kokoro-82M ONNX (English only)
 *   id = 'gcp:<voice-name>'       → Google Cloud TTS (V0.2.22.35; opt-in
 *                                    via Settings → Cloud TTS, requires
 *                                    API key + internet)
 *
 * synthesize() always returns { dataUrl, mime, durationMs } so the caller
 * can cache it on the step without caring which backend produced it.
 */

import * as userSettings from '../core/user-settings.js';

let _voiceCache = null;

// V0.2.22.35 — hardcoded Hebrew Google Cloud TTS voices. Listing the
// full Google voice catalogue at runtime (voices.list) would inflate
// the dropdown with 400+ voices the user doesn't care about. For
// personal Hebrew authoring, six is enough. Add more here when needed
// — or wire voices.list later if/when this ships beyond personal use.
const _GCP_HE_VOICES = [
  { name: 'he-IL-Wavenet-A',  gender: 'Female', tier: 'WaveNet'  },
  { name: 'he-IL-Wavenet-B',  gender: 'Male',   tier: 'WaveNet'  },
  { name: 'he-IL-Wavenet-C',  gender: 'Male',   tier: 'WaveNet'  },
  { name: 'he-IL-Wavenet-D',  gender: 'Female', tier: 'WaveNet'  },
  { name: 'he-IL-Standard-A', gender: 'Female', tier: 'Standard' },
  { name: 'he-IL-Standard-B', gender: 'Male',   tier: 'Standard' },
];

/**
 * Drop the cached voice list. Call this after the user toggles cloud
 * TTS on/off or pastes/clears an API key — otherwise the dropdown shows
 * the previous gating decision until app restart.
 */
export function invalidateVoiceCache() {
  _voiceCache = null;
}

/**
 * List every available voice across every backend.
 * Result: [{ id, name, backend, lang, source, raw }]
 *
 * Voice id format: 'os:<source>|<name>' so the synth route can split
 * source ('sapi5' | 'onecore') from name and pick the right engine.
 * Older 'os:<name>' ids stay parseable (no '|' → defaults to 'sapi5').
 */
export async function listVoices() {
  if (_voiceCache) return _voiceCache;
  const voices = [];

  if (window.sbsNative?.tts) {
    try {
      const osVoices = await window.sbsNative.tts.listVoices();
      for (const raw of osVoices) {
        // Tolerate both shapes: structured object OR a legacy plain string.
        const v = typeof raw === 'string' ? { name: raw } : raw;
        if (!v?.name) continue;
        const source = v.source || 'sapi5';
        const lang   = v.lang   || _inferLang(v.name);
        voices.push({
          id:      `os:${source}|${v.name}`,
          name:    v.name,
          backend: 'os',
          lang,
          culture: v.culture || '',
          gender:  v.gender  || '',
          source,
          raw:     v,
        });
      }
    } catch (e) {
      console.warn('[tts] OS backend unavailable:', e?.message);
    }
  }

  // V0.2.22.35 — Google Cloud TTS Hebrew voices. Only listed when the
  // user has opted in AND configured an API key (Settings → Cloud TTS).
  // Off by default — keeps the dropdown clean for users who don't use
  // cloud voices. Cache is invalidated by invalidateVoiceCache() when
  // those settings toggle.
  try {
    const us = userSettings.get();
    if (us?.cloud?.enabled && (us?.cloud?.googleApiKey || '').trim()) {
      for (const v of _GCP_HE_VOICES) {
        voices.push({
          id:      `gcp:${v.name}`,
          name:    `${v.name}  (${v.gender}, ${v.tier})`,
          backend: 'gcp',
          lang:    'Hebrew (Israel)',
          culture: 'he-IL',
          gender:  v.gender,
          source:  'gcp',
          raw:     v,
        });
      }
    }
  } catch (e) {
    console.warn('[tts] Cloud-TTS gating check failed:', e?.message);
  }

  _voiceCache = voices;
  return voices;
}

/**
 * @param {string} text
 * @param {string} voiceId  full id (e.g. 'os:Microsoft Asaf - Hebrew (Israel)')
 * @param {{speed?:number}} [opts]
 * @returns {Promise<{ dataUrl:string, mime:string, durationMs:number }>}
 */
export async function synthesize(text, voiceId, opts = {}) {
  // Sanitize FIRST. Pasted text carries Unicode the Kokoro phonemizer chokes on
  // (smart quotes, dashes, NBSP, zero-width, BOM, control chars, newlines) — on a
  // bad char generate() throws or HANGS, which is the "typed works, pasted fails"
  // bug. Central here so GPU, CPU worker, preview, export + precache all benefit.
  text = _sanitizeForSynth(text);
  if (!text)    throw new Error('Narration text is empty.');
  if (!voiceId) throw new Error('No voice selected — pick one in the Export tab.');

  const speed = Number(opts.speed) || 1.0;

  // Reject legacy / unprefixed voice ids left over from older project files
  // or older defaults (Piper etc.). User must re-pick a current voice.
  if (!/^(os|kokoro|gcp):/.test(voiceId)) {
    throw new Error(`Legacy voice "${voiceId}" — please pick a current voice in the Export tab.`);
  }

  // V0.2.22.35 — Google Cloud TTS branch. Pulls the API key from user
  // settings at call time (not cached) so a key change takes effect on
  // the very next synth without restart. Off-net errors and HTTP errors
  // propagate as throws so the caller can surface them to the user
  // (Export tab status, narration-precache log, etc).
  if (voiceId.startsWith('gcp:')) {
    if (!window.sbsNative?.tts?.gcpSynthesize) {
      throw new Error('Cloud TTS unavailable (not running in Electron).');
    }
    const us = userSettings.get();
    if (!us?.cloud?.enabled) {
      throw new Error('Cloud TTS is disabled — open Settings → Cloud TTS to enable.');
    }
    const apiKey = (us?.cloud?.googleApiKey || '').trim();
    if (!apiKey) {
      throw new Error('No Google Cloud TTS API key — open Settings → Cloud TTS.');
    }
    const voiceName = voiceId.slice(4);   // strip 'gcp:'
    const res = await window.sbsNative.tts.gcpSynthesize(text, voiceName, speed, apiKey);
    if (!res?.ok) throw new Error(res?.error || 'Google Cloud TTS failed.');
    const dataUrl = `data:${res.mime};base64,${res.data}`;
    // Same WAV-header path as the OS branch — main process wraps PCM in
    // a 44-byte WAV header before returning, so this is reliable.
    let durationMs = (res.mime === 'audio/wav') ? _wavDurationMsFromB64(res.data) : 0;
    if (!durationMs) durationMs = await _measureAudioDuration(dataUrl);
    return { dataUrl, mime: res.mime, durationMs };
  }

  if (voiceId.startsWith('os:')) {
    if (!window.sbsNative?.tts) throw new Error('OS TTS unavailable (not running in Electron).');
    // Parse 'os:<source>|<name>' (new format) or 'os:<name>' (legacy).
    const body = voiceId.slice(3);
    const pipe = body.indexOf('|');
    const source    = pipe >= 0 ? body.slice(0, pipe) : 'sapi5';
    const voiceName = pipe >= 0 ? body.slice(pipe + 1) : body;

    // Kokoro fast-path: synth on the renderer's WebGPU when available
    // (~0.7 s/clip vs ~6 s on the node CPU worker). OPPORTUNISTIC — if the GPU
    // engine isn't ready (no GPU / weak GPU / init failed / mid-session loss),
    // we fall straight through to the CPU worker below. The CPU path is never
    // removed, so this works on any machine. See systems/tts-webgpu.js.
    // GPU is OPT-OUTABLE. `tts.forceCpu` (persisted setting) routes Kokoro
    // straight to the CPU worker — a guaranteed-reliable fallback the user can
    // flip if the GPU misbehaves. Read fresh each call so it takes effect on the
    // very next synth (no reload). Default off → GPU when ready, CPU otherwise.
    const forceCpu = !!userSettings.get()?.tts?.forceCpu;

    // Hebrew Kokoro add-on (V0.3.2.133): `he_`-prefixed kokoro voices belong to
    // the separate Hebrew checkpoint. Everything language-specific (nikud
    // restoration -> IPA -> tokens -> synth) happens inside the node worker,
    // so this branch just forwards TEXT like the English path does. The worker
    // errors clearly when the add-on folder is absent; no WebGPU path yet —
    // the Hebrew model is CPU/DML via the worker only.
    if (source === 'kokoro' && voiceName.startsWith('he_')) {
      const res = await _withTimeout(
        window.sbsNative.tts.synthesizeHe(text, voiceName, speed),
        45_000, null,
      );
      if (!res.ok) throw new Error(res.error || 'Hebrew TTS failed.');
      const dataUrl = `data:${res.mime};base64,${res.data}`;
      let durationMs = (res.mime === 'audio/wav') ? _wavDurationMsFromB64(res.data) : 0;
      if (!durationMs) durationMs = await _measureAudioDuration(dataUrl);
      return { dataUrl, mime: res.mime, durationMs };
    }

    if (source === 'kokoro' && !forceCpu) {
      try {
        const wg = await import('./tts-webgpu.js');
        if (wg.isReady()) {
          // Cap the GPU synth: a healthy clip is ~0.7 s, so anything past 15 s is
          // a wedged/deadlocked session. On timeout, disable WebGPU for the rest
          // of the session and fall through to CPU — never hang the caller (which
          // would freeze the "Synthesizing…" status forever).
          return await _withTimeout(wg.synthesize(text, voiceName, speed), 15000,
            () => wg.markUnavailable?.('synth exceeded 15 s'));
        }
        if (wg.getState() === 'untried') wg.warmUp();   // kick background init; CPU takes this clip
      } catch (e) {
        console.warn('[tts] WebGPU path errored — using CPU worker:', e?.message || e);
      }
      // fall through → node CPU worker
    }

    // Bound the CPU-worker call too (the GPU path already has its own timeout).
    // A wedged worker that never replies would otherwise hang this synth forever
    // and poison the caller's de-dup key. 30s is far beyond a real CPU synth (~6s).
    const res = await _withTimeout(
      window.sbsNative.tts.synthesize(text, voiceName, speed, { source }),
      30_000, null,
    );
    if (!res.ok) throw new Error(res.error || 'TTS failed.');
    const dataUrl = `data:${res.mime};base64,${res.data}`;
    // V0.2.22.2: parse the WAV header directly for duration. SAPI5-via-`say`
    // (Windows default) often produces WAVs whose `<audio>` metadata fires
    // late or returns 0ms — the audio-element measurement was unreliable
    // there, which broke narration-overflow scheduling (a 0-duration clip
    // looks silent to the timeline, so the next step activates immediately).
    // Header parse is identical math for all three backends (Kokoro,
    // OneCore, SAPI5). Falls back to the audio-element measurement if the
    // header doesn't yield a result (e.g. non-WAV or corrupt header).
    let durationMs = (res.mime === 'audio/wav') ? _wavDurationMsFromB64(res.data) : 0;
    if (!durationMs) durationMs = await _measureAudioDuration(dataUrl);
    return { dataUrl, mime: res.mime, durationMs };
  }

  throw new Error(`Unknown voice backend: ${voiceId}`);
}

/** Normalize narration text into something every TTS backend can phonemize.
 *  Conservative: fixes the known phonemizer-breakers without altering meaning. */
export function _sanitizeForSynth(text) {
  // Pure-ASCII source: problematic chars built from code points (no literals).
  const cc = String.fromCharCode;
  let ctrl = '';
  for (let i = 0; i <= 0x1F; i++) if ([0x09, 0x0A, 0x0D, 0x0B, 0x0C].indexOf(i) < 0) ctrl += cc(i);
  ctrl += cc(0x7F);
  // Invisible / formatting / directional chars — the usual paste artefacts (web,
  // PDF, RTL sources) that survive a naive clean and can wedge the phonemizer.
  // Strip them ALL: soft hyphen, Arabic letter mark, Hangul/Khmer/Mongolian
  // fillers, zero-width + directional marks/embeddings/isolates, word joiners,
  // variation selectors, BOM, interlinear annotation.
  let invisible = '';
  for (const [a, b] of [[0x00AD], [0x061C], [0x115F, 0x1160], [0x17B4, 0x17B5], [0x180B, 0x180F],
                        [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2064], [0x2066, 0x206F],
                        [0xFE00, 0xFE0F], [0xFEFF], [0xFFF9, 0xFFFB]]) {
    for (let c = a; c <= (b ?? a); c++) invisible += cc(c);
  }
  const spaces    = cc(0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x202F, 0x205F, 0x3000);
  const sQuote    = cc(0x2018, 0x2019, 0x201A, 0x201B, 0x2032);
  const dQuote    = cc(0x201C, 0x201D, 0x201E, 0x201F, 0x2033);
  const dash      = cc(0x2013, 0x2014, 0x2015);
  const ws        = cc(0x20, 0x09, 0x0A, 0x0D, 0x0B, 0x0C);
  return String(text == null ? '' : text)
    .normalize('NFC')
    .replace(new RegExp('[' + invisible + ']', 'g'), '')          // invisible / formatting / directional
    .replace(new RegExp('[' + spaces + ']', 'g'), ' ')            // exotic spaces
    .replace(new RegExp('[' + sQuote + ']', 'g'), "'")           // smart single quotes
    .replace(new RegExp('[' + dQuote + ']', 'g'), '"')           // smart double quotes
    .replace(new RegExp('[' + dash + ']', 'g'), '-')              // en/em dash
    .replace(new RegExp(cc(0x2026), 'g'), '...')                  // ellipsis
    .replace(new RegExp('[' + ctrl + ']', 'g'), ' ')             // control chars
    .replace(new RegExp('[' + ws + ']+', 'g'), ' ')              // collapse whitespace
    .trim();
}

/** Full TTS diagnostic for the console (window.sbsTTSDiag(text?)). Analyzes the
 *  text for hidden/suspicious characters, shows the sanitized form, reports the
 *  engine state, and runs a real synth of the sanitized text to confirm it works.
 *  No text → uses the active step's narration. */
export async function diagnose(text) {
  if (text == null) {
    try {
      const { state } = await import('../core/state.js');
      const id = state.get('activeStepId');
      text = (state.get('steps') || []).find(s => s.id === id)?.narration?.text || '';
    } catch { text = ''; }
  }
  const raw = String(text ?? '');
  const sanitized = _sanitizeForSynth(raw);
  const suspicious = [];
  for (const ch of raw) {                              // iterate by code point
    const c = ch.codePointAt(0);
    const bad = c < 0x20 || c === 0x7F || c === 0xA0
      || (c >= 0x2000 && c <= 0x206F) || c === 0xFEFF || c > 0x2E7F;
    if (bad) suspicious.push(`U+${c.toString(16).toUpperCase().padStart(4, '0')} ${JSON.stringify(ch)}`);
  }
  const engine = await getEngineStatus();
  let voiceId = 'os:kokoro|af_heart';
  try { const { state } = await import('../core/state.js'); voiceId = state.get('export')?.narrationVoice || voiceId; } catch {}
  let synthTest;
  try {
    const t0 = performance.now();
    const out = await synthesize(raw, voiceId);
    synthTest = { ok: true, ms: Math.round(performance.now() - t0), durationMs: out.durationMs };
  } catch (e) { synthTest = { ok: false, error: e?.message || String(e) }; }
  const report = { engine, voiceId, rawLength: raw.length, sanitizedLength: sanitized.length,
    changedBySanitize: raw !== sanitized, suspiciousChars: suspicious, sanitizedPreview: sanitized.slice(0, 160), synthTest };
  console.log('[tts-diag]', report);
  return report;
}

/** Dump the active step's RAW narration text as per-character code points — NO
 *  synth, so it's safe to run on a wedged/sticky step. Used to identify a paste
 *  artefact the sanitizer might miss. `flagged` = the non-ASCII/control chars to
 *  scan; `kept:false` means the sanitizer already removes it. */
export async function dumpNarrationText(stepId) {
  const { state } = await import('../core/state.js');
  const id   = stepId || state.get('activeStepId');
  const step = (state.get('steps') || []).find(s => s.id === id);
  const raw  = String(step?.narration?.text ?? '');
  const sanitized = _sanitizeForSynth(raw);
  const chars = [...raw].map((ch, i) => {
    const n = ch.codePointAt(0);
    return { i, code: 'U+' + n.toString(16).toUpperCase().padStart(4, '0'), char: ch, kept: sanitized.includes(ch) };
  });
  const flagged = chars.filter(c => {
    const n = parseInt(c.code.slice(2), 16);
    return n < 0x20 || n === 0x7F || n > 0x7E;
  });
  return { stepId: id, rawLength: raw.length, sanitizedLength: sanitized.length, changed: raw !== sanitized, raw, sanitized, flagged, chars };
}

/** Engine diagnostics for the console (window.sbsTTS.engine()). Reports the GPU
 *  engine state + whether the user has forced the CPU path. */
export async function getEngineStatus() {
  let webgpu = 'n/a', webgpuError = null;
  try {
    const wg = await import('./tts-webgpu.js');
    webgpu = wg.getState();
    webgpuError = wg.lastError()?.message || null;
  } catch (e) { webgpuError = e?.message || String(e); }
  return { webgpu, webgpuError, forceCpu: !!userSettings.get()?.tts?.forceCpu };
}

/** Force (or unforce) the CPU worker for Kokoro, persisted across launches.
 *  window.sbsTTS.forceCPU(true) → always CPU; (false) → GPU when available. */
export async function setForceCpu(on = true) {
  await userSettings.patch({ tts: { forceCpu: !!on } });
  console.log(`[tts] forceCpu = ${!!on} — Kokoro will use ${on ? 'the CPU worker' : 'GPU when ready, else CPU'}.`);
  return !!on;
}

/** Reject if `promise` hasn't settled within `ms`; fires `onTimeout` once.
 *  The underlying work keeps running but the caller is freed to fall back. */
function _withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try { onTimeout?.(); } catch {}
      reject(new Error(`TTS synth timed out after ${ms} ms`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// ── Internal ────────────────────────────────────────────────────────────────

/**
 * Windows voice names look like:
 *   "Microsoft Asaf - Hebrew (Israel)"
 *   "Microsoft David Desktop - English (United States)"
 * macOS:  "Samantha"  (language not in the name)
 * Linux:  varies.
 * We do a best-effort extraction; fallback to "—".
 */
function _inferLang(name) {
  const m = /-\s*(.+?)\s*$/.exec(name);
  return m ? m[1] : '—';
}

function _measureAudioDuration(dataUrl) {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = 'metadata';
    a.addEventListener('loadedmetadata', () => {
      resolve(Math.round((a.duration || 0) * 1000));
    }, { once: true });
    a.addEventListener('error', () => resolve(0), { once: true });
    a.src = dataUrl;
  });
}

/**
 * V0.2.22.2 — derive duration directly from a base64-encoded WAV header.
 * Works uniformly across Kokoro / OneCore / SAPI5-via-`say` outputs and
 * sidesteps the `<audio>` loadedmetadata race that returned 0ms for some
 * SAPI5 WAVs (which silently killed narration overflow scheduling).
 *
 * Returns 0 if the buffer isn't a valid WAV or required chunks are missing.
 *
 * WAV structure (RIFF):
 *   bytes 0-3   "RIFF"
 *   bytes 4-7   chunk size (LE)
 *   bytes 8-11  "WAVE"
 *   then chunks: <4-byte id><4-byte size LE><size bytes><pad if size odd>
 *   "fmt " chunk data layout we care about:
 *     +0 audioFormat (2)   +2 numChannels (2)
 *     +4 sampleRate  (4)   +8 byteRate    (4)
 *     +12 blockAlign (2)   +14 bitsPerSample (2)
 *   "data" chunk size tells us byte count of PCM payload.
 *   duration_ms = (dataSize / byteRate) × 1000.
 */
function _wavDurationMsFromB64(b64) {
  try {
    if (typeof b64 !== 'string' || b64.length < 60) return 0;
    // Decode JUST the header (256 bytes is plenty for any sane fmt+data
    // offsets) to avoid base64-decoding multi-MB audio just to read 4
    // numbers. We can't slice base64 byte-perfectly, so decode a generous
    // chunk and walk it.
    const headerB64 = b64.slice(0, 1024);            // ~768 bytes raw
    const binStr = atob(headerB64);
    const u8 = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) u8[i] = binStr.charCodeAt(i);
    const dv = new DataView(u8.buffer);
    if (u8.length < 12) return 0;
    // "RIFF" + "WAVE" magic.
    if (dv.getUint32(0, false) !== 0x52494646) return 0;
    if (dv.getUint32(8, false) !== 0x57415645) return 0;

    let byteRate = 0;
    let dataSize = 0;
    let pos = 12;
    while (pos + 8 <= u8.length) {
      const chunkId   = dv.getUint32(pos, false);
      const chunkSize = dv.getUint32(pos + 4, true);
      if (chunkId === 0x666d7420 /* "fmt " */) {
        if (pos + 8 + 16 <= u8.length) {
          byteRate = dv.getUint32(pos + 8 + 8, true);
        }
      } else if (chunkId === 0x64617461 /* "data" */) {
        dataSize = chunkSize;
        break;
      }
      pos += 8 + chunkSize + (chunkSize & 1);   // chunks word-aligned
    }
    if (!byteRate || !dataSize) return 0;
    return Math.round((dataSize / byteRate) * 1000);
  } catch {
    return 0;
  }
}
