/**
 * 🚀 V0.3.5.60 — the RECENT PROJECTS list behind Quick start's "Continue a project".
 *
 * Pure functions, no DOM, no state: the list lives in user settings
 * (quickStart.recent) and ui/quick-start.js records into it when a project is
 * opened or saved. Kept separate so the rules (newest first, one entry per
 * file, at most 8, a vanished file greyed) are testable in plain node.
 *
 * Entry: { path, name, folder, at }   at = ms since epoch (last opened / saved)
 */

export const RECENT_MAX = 8;

/** Same file? Windows paths ignore case and slash direction. */
export function samePath(a, b) {
  const n = (p) => String(p || '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
  return !!a && !!b && n(a) === n(b);
}

/** A list entry for a project file path (name without .sbsproj, its folder). */
export function recentEntry(path, at = Date.now()) {
  const p = String(path || '');
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const file = cut >= 0 ? p.slice(cut + 1) : p;
  return {
    path: p,
    name: file.replace(/\.sbsproj$/i, '') || file,
    folder: cut >= 0 ? p.slice(0, cut) : '',
    at: Number.isFinite(at) ? at : Date.now(),
  };
}

/** Only well-formed entries survive (a hand-edited settings file must not break the window). */
export function cleanRecent(list) {
  return (Array.isArray(list) ? list : [])
    .filter(e => e && typeof e.path === 'string' && e.path.trim())
    .map(e => ({ ...recentEntry(e.path, Number(e.at)), ...(typeof e.name === 'string' && e.name ? { name: e.name } : {}) }));
}

/** Put `path` on top (newest first), drop its older copy, keep at most `max`. */
export function addRecent(list, path, at = Date.now(), max = RECENT_MAX) {
  if (!path || typeof path !== 'string') return cleanRecent(list).slice(0, max);
  const rest = cleanRecent(list).filter(e => !samePath(e.path, path));
  return [recentEntry(path, at), ...rest].slice(0, max);
}

/** The list without `path`. */
export function removeRecent(list, path) {
  return cleanRecent(list).filter(e => !samePath(e.path, path));
}

/**
 * The list with `missing: true` on every entry whose file is gone.
 * exists(path) → boolean | Promise<boolean>; an exists() that throws counts as
 * "there" — a flaky check must not grey a good project.
 */
export async function markMissing(list, exists) {
  const clean = cleanRecent(list);
  if (typeof exists !== 'function') return clean.map(e => ({ ...e, missing: false }));
  return Promise.all(clean.map(async (e) => {
    let there = true;
    try { there = !!(await exists(e.path)); } catch { there = true; }
    return { ...e, missing: !there };
  }));
}

/** "today 14:05" / "yesterday" / "3 Oct 2026" — when the entry was last used. */
export function recentWhen(at, now = Date.now()) {
  const d = new Date(at), n = new Date(now);
  if (!Number.isFinite(d.getTime())) return '';
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86400000);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diff === 0) return `today ${hm}`;
  if (diff === 1) return `yesterday ${hm}`;
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${M[d.getMonth()]} ${d.getFullYear()}`;
}
