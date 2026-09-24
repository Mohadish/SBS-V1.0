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

import { APP_VERSION } from '../core/schema.js';
import { setStickyStatus } from './status.js';

const _norm = (v) => String(v || '').trim().replace(/^v/i, '').replace(/-/g, '.');

/** @returns {Promise<boolean>} true when the core matches (or cannot be asked). */
export async function checkCoreVersion() {
  try {
    const core = await window.sbsNative?.getVersion?.();
    if (!core) return true;
    if (_norm(core) === _norm(APP_VERSION)) return true;
    console.warn(`[boot] interface ${APP_VERSION} is running on core ${core} — restart the app`);
    setStickyStatus(`Interface ${APP_VERSION} on core ${core}: Ctrl+R reloaded only the interface. Close and reopen SBS before using anything new.`, 'warn', 'stale-core');
    return false;
  } catch { return true; }
}
