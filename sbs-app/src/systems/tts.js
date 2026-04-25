/**
 * SBS — Text-to-speech router.
 *
 * Phase 3a: a single backend (OS voices via `say` npm). Voice IDs are
 * namespaced so additional backends (Kokoro, Piper, etc.) can slot in
 * alongside without changing callers.
 *
 *   id = 'os:<voice-name>'        → Windows SAPI / macOS say / Linux festival
 *   id = 'kokoro:<speaker>'       → (future) Kokoro-82M ONNX
 *
 * synthesize() always returns { dataUrl, mime, durationMs } so the caller
 * can cache it on the step without caring which backend produced it.
 */

let _voiceCache = null;

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
  if (!text?.trim()) throw new Error('Narration text is empty.');
  if (!voiceId)      throw new Error('No voice selected — pick one in the Export tab.');

  const speed = Number(opts.speed) || 1.0;

  // Reject legacy / unprefixed voice ids left over from older project files
  // or older defaults (Piper etc.). User must re-pick a current voice.
  if (!/^(os|kokoro):/.test(voiceId)) {
    throw new Error(`Legacy voice "${voiceId}" — please pick a current voice in the Export tab.`);
  }

  if (voiceId.startsWith('os:')) {
    if (!window.sbsNative?.tts) throw new Error('OS TTS unavailable (not running in Electron).');
    // Parse 'os:<source>|<name>' (new format) or 'os:<name>' (legacy).
    const body = voiceId.slice(3);
    const pipe = body.indexOf('|');
    const source    = pipe >= 0 ? body.slice(0, pipe) : 'sapi5';
    const voiceName = pipe >= 0 ? body.slice(pipe + 1) : body;
    const res = await window.sbsNative.tts.synthesize(text, voiceName, speed, { source });
    if (!res.ok) throw new Error(res.error || 'TTS failed.');
    const dataUrl = `data:${res.mime};base64,${res.data}`;
    const durationMs = await _measureAudioDuration(dataUrl);
    return { dataUrl, mime: res.mime, durationMs };
  }

  throw new Error(`Unknown voice backend: ${voiceId}`);
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
