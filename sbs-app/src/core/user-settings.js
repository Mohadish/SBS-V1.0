/**
 * SBS — User-level preferences (machine-scope, NOT per-project).
 *
 * Stored at the OS userData path as `user-settings.json`. Reads once at
 * boot, writes on every change. Schema is additive and forward-compatible:
 * unknown keys are preserved on round-trip.
 *
 * Layout:
 *   {
 *     version: 1,
 *     ui:        { preferredLanguage: string },
 *     export:    { defaultFps, defaultStepHoldMs, defaultFormat },
 *     narration: { lastUsedVoice }
 *   }
 *
 * The single rule: `userSettings` is not the source of truth for live
 * project data — it's the *defaults* and *machine preferences* layer.
 * Project files still own per-project state (steps, colors, etc.).
 */

const DEFAULTS = {
  version: 1,
  ui: {
    // Empty array → "Any" (no filter). Each entry is a friendly language
    // name e.g. "Hebrew" / "English" — matched against voice.lang.
    preferredLanguages: [],
    // Legacy single-string field, migrated into preferredLanguages on read.
    preferredLanguage:  '',
    osLocale:           '',         // mirror, set on first boot
  },
  export: {
    defaultFps:        30,
    defaultStepHoldMs: 800,
    defaultFormat:     'mp4',
    narrationEnabled:  true,
  },
  narration: {
    lastUsedVoice: '',
  },
};

let _cache = null;
let _ready = null;

/**
 * Initialise from disk + OS locale. Idempotent: subsequent calls return the
 * same promise / cached object.
 */
export function initUserSettings() {
  if (_ready) return _ready;
  _ready = (async () => {
    if (!window.sbsNative?.userSettings) {
      _cache = _deepClone(DEFAULTS);
      return _cache;
    }
    const stored = await window.sbsNative.userSettings.read();
    _cache = _mergeDefaults(stored || {});

    // Migrate legacy single-string preferredLanguage → preferredLanguages array.
    if (_cache.ui.preferredLanguage && !(_cache.ui.preferredLanguages || []).length) {
      _cache.ui.preferredLanguages = [_cache.ui.preferredLanguage];
    }
    if (!Array.isArray(_cache.ui.preferredLanguages)) _cache.ui.preferredLanguages = [];

    // First-boot OS-locale capture.
    if (!_cache.ui.osLocale) {
      const locale = await window.sbsNative.userSettings.locale().catch(() => '');
      if (locale) {
        _cache.ui.osLocale = locale;
        if (!_cache.ui.preferredLanguages.length) {
          _cache.ui.preferredLanguages = [_localeToLanguageName(locale)];
        }
        await window.sbsNative.userSettings.write(_cache);
      }
    }
    return _cache;
  })();
  return _ready;
}

export function get() {
  return _cache ? _deepClone(_cache) : _deepClone(DEFAULTS);
}

/**
 * Patch + persist. Patch is shallow-merged at the top level then per-section,
 * so callers can pass {ui:{preferredLanguage:'Hebrew'}} without wiping
 * other keys.
 */
export async function patch(updates) {
  if (!_cache) await initUserSettings();
  for (const [section, vals] of Object.entries(updates || {})) {
    if (vals && typeof vals === 'object' && !Array.isArray(vals)) {
      _cache[section] = { ...(_cache[section] || {}), ...vals };
    } else {
      _cache[section] = vals;
    }
  }
  if (window.sbsNative?.userSettings) {
    await window.sbsNative.userSettings.write(_cache);
  }
  return _deepClone(_cache);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function _mergeDefaults(stored) {
  const out = _deepClone(DEFAULTS);
  for (const [key, val] of Object.entries(stored)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      out[key] = { ...(out[key] || {}), ...val };
    } else {
      out[key] = val;
    }
  }
  return out;
}

function _deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

/**
 * Translate a BCP-47 locale (e.g. "he-IL", "en-US") into a human-friendly
 * language name we can match against voice metadata. Pulled from a small
 * built-in table — covers the major languages Microsoft Natural voices
 * ship for. Fallback returns the locale's primary tag uppercased.
 */
function _localeToLanguageName(locale) {
  const tag = (locale || '').toLowerCase().split(/[-_]/)[0];
  const map = {
    en: 'English',  he: 'Hebrew',  es: 'Spanish',  fr: 'French',  de: 'German',
    it: 'Italian',  pt: 'Portuguese', ru: 'Russian', zh: 'Chinese', ja: 'Japanese',
    ko: 'Korean',   ar: 'Arabic',  hi: 'Hindi',  tr: 'Turkish', pl: 'Polish',
    cs: 'Czech',    sk: 'Slovak',  hu: 'Hungarian', ro: 'Romanian', el: 'Greek',
    nl: 'Dutch',    sv: 'Swedish', no: 'Norwegian', da: 'Danish',  fi: 'Finnish',
    th: 'Thai',     vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay',
    bn: 'Bengali',  ta: 'Tamil',   te: 'Telugu',  mr: 'Marathi',  gu: 'Gujarati',
    ur: 'Urdu',     fa: 'Persian', uk: 'Ukrainian', bg: 'Bulgarian', hr: 'Croatian',
  };
  return map[tag] || tag.toUpperCase();
}
