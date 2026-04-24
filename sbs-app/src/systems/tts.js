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
 * Result: [{ id, name, backend, lang, raw }]
 */
export async function listVoices() {
  if (_voiceCache) return _voiceCache;
  const voices = [];

  if (window.sbsNative?.tts) {
    try {
      const osVoices = await window.sbsNative.tts.listVoices();
      for (const raw of osVoices) {
        voices.push({
          id:      `os:${raw}`,
          name:    raw,
          backend: 'os',
          lang:    _inferLang(raw),
          raw,
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
  if (!voiceId)      throw new Error('No voice selected.');

  const speed = Number(opts.speed) || 1.0;

  if (voiceId.startsWith('os:')) {
    if (!window.sbsNative?.tts) throw new Error('OS TTS unavailable (not running in Electron).');
    const voiceName = voiceId.slice(3);
    const res = await window.sbsNative.tts.synthesize(text, voiceName, speed);
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
