/**
 * SBS — is the interface running on the core it was built with? (V0.3.4.118)
 * ──────────────────────────────────────────────────────────────────────
 * Ctrl+R reloads the renderer only. After an update that touched the main
 * process (electron/*.js) the interface is then newer than its core: the
 * version in the title is the new one, the bridge and the helper pages are
 * the old ones — and things fail in strange ways (three times now with the
 * screen colour picker; the last one showed black, inert screens). The
 * core's version is package.json as read at launch (app.getVersion), the
 * interface's is APP_VERSION — same number when both are current. When they
 * differ, a pinned warning says so until the app is reopened.
 */

import { APP_VERSION, CORE_VERSION } from '../core/schema.js';
import { setStickyStatus } from './status.js';

const _nums = (v) => String(v || '').trim().replace(/^v/i, '').split(/[.-]/).map(n => Number(n) || 0);
const _lt = (a, b) => { const A = _nums(a), B = _nums(b); for (let i = 0; i < Math.max(A.length, B.length); i++) { const d = (A[i] || 0) - (B[i] || 0); if (d) return d < 0; } return false; };

/**
 * V0.3.4.133 — the notice only when it is TRUE that Ctrl+R is not enough: the
 * running core (package.json at launch) is older than CORE_VERSION, the last
 * version that changed anything under electron/. A core that merely lags the
 * interface number is fine (the user: "I just closed and opened it and it
 * disappeared — only put it when I really have to").
 * @returns {Promise<boolean>} true when the core is good enough (or cannot be asked).
 */
export async function checkCoreVersion() {
  try {
    const core = await window.sbsNative?.getVersion?.();
    if (!core) return true;
    if (!_lt(core, CORE_VERSION)) return true;
    console.warn(`[boot] interface ${APP_VERSION} needs core ≥ ${CORE_VERSION}; the running core is ${core} — restart the app`);
    setStickyStatus(`The running core (${core}) is older than this interface needs (${CORE_VERSION}) — Ctrl+R reloads only the interface. Close and reopen SBS.`, 'warn', 'stale-core');
    return false;
  } catch { return true; }
}
