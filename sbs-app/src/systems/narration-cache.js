/**
 * SBS — Narration disk cache.
 *
 * Off-loads bulky synthesized WAV blobs out of the .sbsproj JSON file and
 * onto the user's disk, in a folder they pick (project-level setting:
 * `state.audioCacheFolder`, relative to the project file).
 *
 * Why
 * ───
 *   A 40-min narration project keeps ~115 MB of base64 dataUrls inline,
 *   bloating the project file to ~155 MB. With the cache folder enabled
 *   the project file drops to ~5 MB; the WAVs sit beside it on disk.
 *
 * Layout on disk
 * ──────────────
 *   <projectDir>/                       <- folder containing the .sbsproj
 *     myproject.sbsproj                 <- text JSON (small)
 *     <audioCacheFolder>/               <- e.g. "myproject_audio"
 *       <voiceSlug>/                    <- e.g. "kokoro-af-bella"
 *         <stepSlug>__<hash>.wav        <- e.g. "intro__a1b2c3d4.wav"
 *         <stepSlug>__<hash>.wav        <- different step / different text
 *       <otherVoiceSlug>/               <- voice change → new folder
 *         ...
 *
 *   Per-voice subfolders keep things tidy when the user switches voices —
 *   old WAVs sit in their own folder rather than mixing with new ones.
 *
 *   Filename = "<stepSlug>__<hash>.wav"
 *     stepSlug  — slug of step.name (or stepId fallback) so users can see
 *                 which step a file belongs to when poking through Explorer
 *     hash      — first 8 hex of SHA-1(text|speed) so the filename changes
 *                 if the text or speed changes (forces a re-synth, leaves
 *                 the old file as a tagged orphan you can identify)
 *
 *   We deliberately do NOT cache fast OS voices (`os:*`) — they synthesize
 *   in tens of ms and caching them just clutters the folder.
 *
 * Step shape
 * ──────────
 *   step.narration = {
 *     text, voiceId, speed, durationMs, mime,
 *     dataFile?: "a1b2c3d4...wav",   // PRESENT when cached on disk
 *     dataUrl?:  "data:audio/wav;..", // PRESENT when no cache OR after lazy-load
 *   }
 *
 * Rules
 * ─────
 *   • If `audioCacheFolder` is null OR projectPath is null → fall back to
 *     inline dataUrl (legacy behaviour). Cache is OPT-IN.
 *   • A file is identified by SHA-1 of `text|voiceId|speed` so identical
 *     clips dedupe across steps. Voice or speed change → new filename;
 *     the old WAV becomes a harmless orphan on disk.
 *   • On project load we DO NOT eagerly read every clip — `dataFile` is
 *     all we know. Audio is read from disk lazily by `ensurePlayable()`.
 *   • Missing folder / missing file on play is logged + treated as a
 *     cache miss; caller can choose to re-synthesize.
 */

import { state } from '../core/state.js';

// ─── Config gate ────────────────────────────────────────────────────────────

/**
 * Returns true when both pre-conditions for disk caching are satisfied:
 *   1. user picked a cache folder for this project,
 *   2. the project has been saved at least once (we have a parent dir to
 *      resolve the relative cache folder against).
 */
export function isCacheEnabled() {
  return !!(state.get('audioCacheFolder') && state.get('projectPath'));
}

/** Absolute path of the cache folder, or null if not configured / project unsaved. */
export function cacheFolderAbsolute() {
  if (!isCacheEnabled()) return null;
  const projectDir = _projectDir();
  const folder     = state.get('audioCacheFolder');
  if (!projectDir) return null;
  return _join(projectDir, folder);
}

// ─── Voice classification ───────────────────────────────────────────────────

/**
 * Fast voices synthesize in tens of milliseconds (Windows SAPI / OneCore via
 * the `os:` namespace). Disk-caching them is a net negative — the file write
 * costs more than the synth, and the folder fills with redundant clones every
 * time a voice changes. The disk cache is reserved for slow neural backends
 * (kokoro, future piper, etc.).
 */
export function isFastVoice(voiceId) {
  return /^os:/.test(voiceId || '');
}

// ─── Path components ────────────────────────────────────────────────────────

/**
 * Filesystem-safe slug. Lowercases, replaces non-alphanumeric runs with `-`,
 * trims leading/trailing dashes, caps length so we don't blow past Windows'
 * 260-char path limit on deeply nested cache folders.
 */
function _slugify(s, max = 40) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

/** First 8 hex chars of SHA-1(`text|speed`). Voice is implicit in the folder. */
async function _shortHash(text, speed) {
  const buf  = new TextEncoder().encode(`${text}|${Number(speed) || 1}`);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(hash).slice(0, 4)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * "<voiceSlug>/<stepSlug>__<hash>.wav" — what we store in step.narration.dataFile.
 * stepName empty → fall back to stepId substring → fall back to "step".
 */
export async function clipRelativePath({ text, voiceId, speed, stepName, stepId }) {
  const voiceSlug = _slugify(voiceId, 60) || 'voice';
  const stepSlug  = _slugify(stepName, 40) || (stepId ? String(stepId).slice(0, 8) : 'step');
  const hash      = await _shortHash(text, speed);
  return `${voiceSlug}/${stepSlug}__${hash}.wav`;
}

// ─── Save / load ────────────────────────────────────────────────────────────

/**
 * Write the WAV (decoded from a `data:audio/wav;base64,...` URL) into the
 * cache folder. Returns the relative path (to be stored in
 * step.narration.dataFile), or `null` if caching is disabled / skipped /
 * failed.
 *
 * Skipped when:
 *   • caching disabled (no folder, or project unsaved)
 *   • voice is "fast" (os:*) — synthesis is cheap, no point caching
 *   • dataUrl missing
 *
 * Idempotent: if the file already exists, no rewrite, just return its path.
 */
export async function saveClipToDisk({ text, voiceId, speed, dataUrl, stepName, stepId }) {
  if (!isCacheEnabled() || !dataUrl) return null;
  if (isFastVoice(voiceId))          return null;
  if (!window.sbsNative?.writeFile)  return null;

  const relPath  = await clipRelativePath({ text, voiceId, speed, stepName, stepId });
  const fullPath = _join(cacheFolderAbsolute(), relPath);

  // Skip rewrite if file already there (same step + same text hash).
  try {
    const exists = await window.sbsNative.fileExists(fullPath);
    if (exists) return relPath;
  } catch { /* fallthrough — try to write */ }

  const base64 = _stripDataUrlPrefix(dataUrl);
  if (!base64) return null;

  const res = await window.sbsNative.writeFile(fullPath, base64, 'base64');
  if (!res?.ok) {
    console.warn('[narration-cache] write failed:', res?.error);
    return null;
  }
  return relPath;
}

/**
 * Read a cached WAV from disk → return `data:audio/wav;base64,...` URL.
 * Returns null on any error (missing folder, missing file, IPC failure).
 */
export async function loadClipFromDisk(dataFile, mime = 'audio/wav') {
  if (!dataFile)                          return null;
  if (!isCacheEnabled())                  return null;
  if (!window.sbsNative?.readFile)        return null;

  const fullPath = _join(cacheFolderAbsolute(), dataFile);
  try {
    const res = await window.sbsNative.readFile(fullPath, 'base64');
    if (!res?.ok) {
      console.warn('[narration-cache] read failed:', res?.error);
      return null;
    }
    return `data:${mime};base64,${res.data}`;
  } catch (err) {
    console.warn('[narration-cache] read threw:', err?.message);
    return null;
  }
}

/**
 * One-shot migration — walk every step that has an inline dataUrl but no
 * dataFile yet, write the WAV to disk, stamp dataFile on the step. Used
 * right after the user picks a cache folder for a project that already
 * had inline-cached clips: the next save then drops them all from JSON.
 *
 * Returns { migrated, failed } counts. Caller decides how to surface this.
 */
export async function migrateInlineClipsToDisk(steps) {
  let migrated = 0, skipped = 0, failed = 0;
  if (!isCacheEnabled()) return { migrated, skipped, failed };
  for (const s of steps || []) {
    const n = s?.narration;
    if (!n?.dataUrl || n.dataFile) continue;
    if (!n.text || !n.voiceId)     continue;          // malformed entry
    if (isFastVoice(n.voiceId))    { skipped++; continue; }  // fast voice — never cached
    try {
      const dataFile = await saveClipToDisk({
        text:     n.text,
        voiceId:  n.voiceId,
        speed:    n.speed,
        dataUrl:  n.dataUrl,
        stepName: s.name,
        stepId:   s.id,
      });
      if (dataFile) { n.dataFile = dataFile; migrated++; }
      else            failed++;
    } catch (err) {
      console.warn('[narration-cache] migrate failed for step:', err?.message);
      failed++;
    }
  }
  return { migrated, skipped, failed };
}

/**
 * Return a playable dataUrl for a step's narration, regardless of whether
 * it lives inline (dataUrl) or on disk (dataFile).
 *
 * Returns null when there's nothing to play (no clip cached anywhere).
 *
 * Side-effect: when we lazy-load from disk, we hydrate `step.narration.dataUrl`
 * so subsequent plays in the same session are instant. The hydrated value
 * is a runtime-only artefact — it gets stripped again on save (see
 * project.js#serialize).
 */
export async function ensurePlayable(step) {
  const n = step?.narration;
  if (!n) return null;
  if (n.dataUrl)  return n.dataUrl;
  if (!n.dataFile) return null;
  const url = await loadClipFromDisk(n.dataFile, n.mime || 'audio/wav');
  if (url) n.dataUrl = url;
  return url;
}

// ─── Internal ───────────────────────────────────────────────────────────────

function _projectDir() {
  const p = state.get('projectPath') || '';
  // Strip the last "/foo" or "\foo" segment.
  const m = p.match(/^(.*)[\/\\][^\/\\]+$/);
  return m ? m[1] : '';
}

function _join(...parts) {
  return parts.filter(Boolean).join('/').replace(/\\/g, '/');
}

function _stripDataUrlPrefix(dataUrl) {
  // "data:audio/wav;base64,XXXX" → "XXXX"
  const i = dataUrl.indexOf('base64,');
  return i >= 0 ? dataUrl.slice(i + 'base64,'.length) : '';
}
