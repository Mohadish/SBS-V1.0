/**
 * SBS — Background narration pre-cache.
 *
 * After a project loads, walk every step that has narration text but no
 * fresh cached dataUrl, and synthesize them serially in the background.
 * The UI stays responsive (each synth is just an awaited IPC); the user
 * gets instant Preview / Export later because every clip is in cache.
 *
 * Trigger points:
 *   • project loaded (state 'project:loaded' or after first activeStepId)
 *   • narration voice / speed changed (clips invalidated → re-cache)
 *   • narration text edited (single-clip targeted re-cache, debounced)
 *
 * Cancellation:
 *   • new project loaded → abort current run
 *   • app close — irrelevant, process dies
 */

import { state }     from '../core/state.js';
import { setStatus } from '../ui/status.js';
import { synthesize as ttsSynthesize } from './tts.js';

let _runCtl = null;        // AbortController for the active run
let _runPromise = null;    // settled when run finishes
let _settled = true;

/** Kick off (or restart) a background pre-synth pass. Idempotent. */
export function schedulePrecache(reason = 'manual') {
  cancel();
  _runCtl     = new AbortController();
  _settled    = false;
  _runPromise = _runOnce(_runCtl.signal, reason).finally(() => { _settled = true; });
}

/** Abort any in-flight pass. Safe to call repeatedly. */
export function cancel() {
  if (_runCtl) { try { _runCtl.abort(); } catch {} _runCtl = null; }
}

/** Wait for the current run (resolves immediately if idle). */
export async function flush() { if (_runPromise) await _runPromise; }

// ─── Core loop ──────────────────────────────────────────────────────────────

async function _runOnce(signal, reason) {
  const exp     = state.get('export') || {};
  const voiceId = exp.narrationVoice;
  const speed   = Number(exp.narrationSpeed) || 1.0;
  if (!voiceId) return;             // nothing to do without a voice

  const allSteps = (state.get('steps') || []).filter(s => !s.hidden && !s.isBaseStep);

  // Build the work list — only steps with text whose cached clip doesn't
  // match the current text+voice+speed.
  const todo = [];
  for (const s of allSteps) {
    const text = s.narration?.text?.trim();
    if (!text) continue;
    const n = s.narration;
    const fresh = n?.dataUrl && n.text === text && n.voiceId === voiceId && n.speed === speed;
    if (!fresh) todo.push(s);
  }
  if (!todo.length) return;

  console.log(`[precache] (${reason}) caching ${todo.length} step(s) — voice=${voiceId} speed=${speed}`);
  for (let i = 0; i < todo.length; i++) {
    if (signal.aborted) { console.log('[precache] aborted'); return; }
    const s = todo[i];
    setStatus(`Caching narration ${i + 1}/${todo.length}…`, 'info', 0);
    try {
      const out = await ttsSynthesize(s.narration.text, voiceId, { speed });
      // It's possible the user navigated / edited mid-synth — re-check the
      // step still wants the same text before stamping the cache.
      if (signal.aborted) return;
      const cur = state.get('steps').find(x => x.id === s.id);
      if (!cur || cur.narration?.text !== s.narration.text) continue;
      cur.narration = { text: s.narration.text, voiceId, speed, ...out };
      // Don't markDirty — we DON'T want every cache to dirty the project.
      // The dataUrls get written on next user-driven save anyway.
    } catch (err) {
      console.warn('[precache] synth failed for', s.name, err?.message);
    }
  }
  setStatus(`Narration cache ready (${todo.length} clip${todo.length === 1 ? '' : 's'}).`);
}
