/**
 * SBS — Translation provider selection (V0.3.2.147)
 *
 * One place that decides whether a translation goes to Google or to the
 * offline engine, and one function every caller uses. The main process
 * routes on the `local` argument; everything above here — language packs,
 * subtitles, single-entry re-translate — is provider-agnostic.
 *
 * Offline mode targets a local OpenAI-compatible server (Ollama, LM Studio
 * or llama.cpp's own server), so no cloud account, key or connection is
 * involved once a model is on the machine.
 */

import * as userSettings from '../core/user-settings.js';

/** True when the user has switched translation to the offline engine. */
export function isLocalProvider() {
  try { return (userSettings.get()?.translate?.provider || 'google') === 'local'; }
  catch { return false; }
}

/** The config the main process needs to drive the local server. */
export function localConfig() {
  const t = userSettings.get()?.translate || {};
  return {
    provider:    'local',
    baseUrl:     String(t.localBaseUrl || '').trim(),
    model:       String(t.localModel   || '').trim(),
    glossary:    Array.isArray(t.glossary) ? t.glossary : [],
    timeoutMs:   Number(t.timeoutMs)   > 0 ? Number(t.timeoutMs)   : 120000,
    concurrency: Number(t.concurrency) > 0 ? Number(t.concurrency) : 2,
  };
}

/**
 * Human-readable reason the current provider can't run, or '' when it can.
 * Callers surface this instead of the old Google-only message.
 */
export function providerBlocker() {
  if (!window.sbsNative?.translate?.batch) return 'Translation is unavailable in this build.';
  if (isLocalProvider()) {
    const c = localConfig();
    if (!c.baseUrl) return 'No offline translator URL — Settings → Translation.';
    if (!c.model)   return 'No offline translator model — Settings → Translation.';
    return '';
  }
  const key = (userSettings.get()?.cloud?.googleApiKey || '').trim();
  if (!key) return 'No Google API key — Settings → Cloud TTS tab (or switch to the offline engine in Settings → Translation).';
  return '';
}

/**
 * Provider-agnostic batch translate. Same contract as the old direct IPC
 * call: the result's `texts` lines up 1:1 with the input.
 */
export async function translateBatch(texts, source, target, apiKey = '', format = 'text') {
  const local = isLocalProvider() ? localConfig() : null;
  return window.sbsNative.translate.batch(texts, source, target, apiKey, format, local);
}
