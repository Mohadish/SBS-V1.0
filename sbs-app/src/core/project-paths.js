// ─── 📁 PROJECT FOLDER LAYOUT (V0.3.2.124) ──────────────────────────────────
//
// A project is a FOLDER, not a loose file. Everything it generates lives
// inside it, organised by purpose and — where it matters — by language, so
// the whole thing can be zipped, copied to another machine and opened:
//
//     MyProject/
//       MyProject.sbsproj
//       languages/   he.sbslang.json   es.sbslang.json
//       audio/       en/<voice>/…      he/<voice>/…
//       render/      en/seg-*.mp4      he/seg-*.mp4
//       media/       video clips, interface images
//       exports/     finished mp4s
//       backups/     autosaves
//
// This module is the ONLY place that knows those names. Before it, the audio
// cache, the render cache, the language packs and the autosave each derived
// their own path from projectPath in their own way, which is how the layout
// drifted in the first place.
//
// BACKWARD COMPATIBILITY IS NOT OPTIONAL. Projects created before this layout
// keep their files exactly where they are: every lookup that can miss offers
// a `legacy` path alongside the modern one, and callers try modern first,
// then legacy. Nothing is ever moved behind the user's back — relocating an
// existing project is a deliberate action (the folder-adoption phase).
//
// No imports beyond state: this sits at the bottom of the dependency graph so
// any subsystem can use it without risking a cycle.

import { state } from './state.js';

export const DIR = {
  languages: 'languages',
  audio:     'audio',
  render:    'render',
  media:     'media',
  exports:   'exports',
  backups:   'backups',
};

/** Legacy render-cache folder used before the layout existed. */
export const LEGACY_RENDER_DIR = '_rendercache';

const _sep = (p) => (p.includes('\\') ? '\\' : '/');

/** Join path parts with the separator already in use for this project. */
export function joinPath(...parts) {
  const clean = parts.filter(p => p != null && p !== '');
  if (!clean.length) return '';
  const sep = _sep(String(clean[0]));
  return clean.map((p, i) => (i === 0 ? String(p).replace(/[\\/]+$/, '') : String(p).replace(/^[\\/]+|[\\/]+$/g, '')))
              .filter(Boolean)
              .join(sep);
}

/**
 * { dir, base, sep } for the open project, or null when it has never been
 * saved. `base` strips .sbsproj AND any .autosaveN suffix, so a project opened
 * from a crash-recovery file still resolves to the real project's folders.
 */
export function projectParts() {
  const pp = state.get('projectPath');
  if (!pp) return null;
  const sep = _sep(pp);
  const i = pp.lastIndexOf(sep);
  const dir  = i >= 0 ? pp.slice(0, i) : '.';
  const file = i >= 0 ? pp.slice(i + 1) : pp;
  const base = file.replace(/\.sbsproj$/i, '').replace(/(\.autosave\d*)+$/i, '');
  return { dir, base, sep };
}

/** The project's own folder, or null when unsaved. */
export function projectDir() { return projectParts()?.dir ?? null; }

/** Absolute path of one layout subfolder ('audio' | 'render' | …). */
export function subDir(which) {
  const p = projectParts();
  const name = DIR[which] || which;
  return p ? joinPath(p.dir, name) : null;
}

/** The language the project's generated assets currently belong to. */
export function activeLangCode() {
  return state.get('activeLang') || state.get('sourceLang') || 'en';
}

/**
 * Render-cache directory for a language.
 * Modern: <project>/render/<lang>/   Legacy: <project>/_rendercache[/<lang>]
 */
export function renderCacheDir(lang = activeLangCode()) {
  const p = projectParts();
  if (!p) return { dir: null, legacy: null };
  const src = state.get('sourceLang') || 'en';
  return {
    dir:    joinPath(p.dir, DIR.render, lang),
    // The .116–.123 shape: source language sat directly in _rendercache,
    // other languages in a subfolder.
    legacy: lang && lang !== src ? joinPath(p.dir, LEGACY_RENDER_DIR, lang)
                                 : joinPath(p.dir, LEGACY_RENDER_DIR),
  };
}

/**
 * Language-pack file for a language.
 * Modern: <project>/languages/<lang>.sbslang.json
 * Legacy: <project>/<base>.<lang>.sbslang.json   (flat, beside the project)
 */
export function langPackPath(lang) {
  const p = projectParts();
  if (!p) return { path: null, legacy: null };
  return {
    path:   joinPath(p.dir, DIR.languages, `${lang}.sbslang.json`),
    legacy: joinPath(p.dir, `${p.base}.${lang}.sbslang.json`),
  };
}

/** Regexes that recognise a pack filename in each location. */
export const LANG_PACK_MODERN_RX = /^([A-Za-z-]{2,10})\.sbslang\.json$/;
export function langPackLegacyRx(base) {
  return new RegExp(`^${String(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.([A-Za-z-]{2,10})\\.sbslang\\.json$`);
}

/**
 * Autosave path — <project>/backups/<base>.autosave.sbsproj.
 * `legacy` is the old sibling-of-the-project location, still read on recovery.
 */
export function autosavePath() {
  const p = projectParts();
  if (!p) return { path: null, legacy: null };
  return {
    path:   joinPath(p.dir, DIR.backups, `${p.base}.autosave.sbsproj`),
    legacy: joinPath(p.dir, `${p.base}.autosave.sbsproj`),
  };
}
