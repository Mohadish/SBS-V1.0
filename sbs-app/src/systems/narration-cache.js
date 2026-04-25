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
 *       a1b2c3d4...e5f6.wav             <- SHA-1(text|voice|speed)
 *       9f8e7d6c...3a2b.wav
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

// ─── Filename hashing ───────────────────────────────────────────────────────

/**
 * SHA-1 of `text|voiceId|speed` → "<hex>.wav". Stable across sessions, so
 * the same clip text+voice+speed always resolves to the same file (dedupe).
 */
export async function clipFilename(text, voiceId, speed) {
  const key = `${text}|${voiceId}|${Number(speed) || 1}`;
  const buf = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  const hex = [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex}.wav`;
}

// ─── Save / load ────────────────────────────────────────────────────────────

/**
 * Write the WAV (decoded from a `data:audio/wav;base64,...` URL) into the
 * cache folder. Returns the relative filename (to be stored in
 * step.narration.dataFile), or `null` if caching is disabled / failed.
 *
 * Idempotent: if the file already exists, no rewrite, just return name.
 */
export async function saveClipToDisk({ text, voiceId, speed, dataUrl }) {
  if (!isCacheEnabled() || !dataUrl)        return null;
  if (!window.sbsNative?.writeFile)         return null;

  const filename = await clipFilename(text, voiceId, speed);
  const fullPath = _join(cacheFolderAbsolute(), filename);

  // Skip rewrite if file already there (deduped synth, same hash).
  try {
    const exists = await window.sbsNative.fileExists(fullPath);
    if (exists) return filename;
  } catch { /* fallthrough — try to write */ }

  const base64 = _stripDataUrlPrefix(dataUrl);
  if (!base64) return null;

  const res = await window.sbsNative.writeFile(fullPath, base64, 'base64');
  if (!res?.ok) {
    console.warn('[narration-cache] write failed:', res?.error);
    return null;
  }
  return filename;
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
  let migrated = 0, failed = 0;
  if (!isCacheEnabled()) return { migrated, failed };
  for (const s of steps || []) {
    const n = s?.narration;
    if (!n?.dataUrl || n.dataFile) continue;
    if (!n.text || !n.voiceId)     continue;   // malformed entry
    try {
      const dataFile = await saveClipToDisk({
        text:    n.text,
        voiceId: n.voiceId,
        speed:   n.speed,
        dataUrl: n.dataUrl,
      });
      if (dataFile) { n.dataFile = dataFile; migrated++; }
      else            failed++;
    } catch (err) {
      console.warn('[narration-cache] migrate failed for step:', err?.message);
      failed++;
    }
  }
  return { migrated, failed };
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
