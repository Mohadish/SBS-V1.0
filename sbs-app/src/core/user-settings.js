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
  // V0.3.2.138 — "sticky" shape defaults. Editing fill/outline/thickness/
  // radius on a selected overlay shape records those values here, and the
  // next shape you create is born with them. Machine-scope on purpose:
  // it's a tool setting (like a brush), not project data, so it follows
  // the user across projects and survives a restart.
  overlay: {
    shapeDefaults: {
      fill:         'rgba(74,144,217,0.45)',
      stroke:       '#4A90D9',
      strokeWidth:  3,
      cornerRadius: 0,
    },
  },
  scene: {
    // Wheel-zoom step multiplier. Step = distance × baseFactor × cameraZoomScale.
    // 1.0 = default; lower = finer/slower zoom, higher = coarser/faster.
    cameraZoomScale: 1.0,
    // Default viewport background applied to NEW projects (and to loads
    // of legacy projects that don't store their own override).
    defaultBackgroundColor: '#0f172a',
    defaultBackgroundGradient: {
      enabled:  false,
      color1:   '#0f172a',
      color2:   '#1e293b',
      angleDeg: 180,
    },
    // Create-shape-from-face: angle deviation (degrees) for the flood fill.
    // Triangles within this many degrees of the picked triangle's normal
    // get included in the face set. Tighter → only flat regions; wider →
    // catches gently-curved surfaces too.
    shapeFaceAngleThreshold: 5,
  },
  // V0.3.0.18 — viewport render settings (AO + SSR contact reflections).
  // Machine-scope / app-global for now, applied live + on boot. Per-project
  // override comes later. Surfaced as sliders in the Files tab + Scene settings.
  render: {
    ao:  { enabled: true,  intensity: 4.0, radius: 24.0, falloff: 1.0 },
    ssr: { enabled: false, intensity: 1.0, roughness: 0.3, maxDistance: 8.0, thickness: 1.0, steps: 24 },
  },
  // User-level animation preset collection. Entries are { name, animation }.
  // Cross-project, machine-scope — the user's personal library of preset
  // strings they want to reuse across projects. The actual project still
  // gets a COPY pasted in when imported via "+ From collection"; this is
  // a TEMPLATE store, not a live link.
  animation: {
    collection: [],   // Array<{ name: string, animation: string }>
  },
  // V0.2.22.85 — CAD (STEP/IGES) import via the native 64-bit converter.
  cad: {
    // Fast-load cache placement asked in the convert popup:
    //   'ask' (prompt each load) | 'sbsobj' | 'inplace'. Remembered choice skips it.
    cacheMode: 'ask',
    // Imported tree STRUCTURE:
    //   'hierarchy' — assembly folders + real STEP product/instance names (default)
    //   'flat'      — legacy: one flat list of parts (lowest risk, no restructuring)
    importMode: 'hierarchy',
    // When true, the STEP load popup also lets you pick structure per-file.
    // When false (default), loads silently use `importMode`.
    askImportOnLoad: false,
  },
  undo: {
    // V0.2.16: maximum entries kept in the undo stack. Older ones drop off
    // FIFO once the cap is reached. Tunable in the Undo tab. Each entry's
    // memory cost varies — color-sel entries are tiny, step-paste/unify
    // entries can hold a full deep-cloned steps array (hundreds of KB on
    // large projects), so don't push this absurdly high.
    maxSize: 200,
  },
  // V0.2.22.35 — Cloud TTS. Off by default; opt-in only. When enabled +
  // googleApiKey set, additional Google Cloud he-IL voices appear in the
  // Export tab's voice dropdown alongside the OS / Kokoro voices. Stored
  // here (machine-scope) so the API key never leaks into project files.
  // This is single-user / personal-authoring scope today — not shipped to
  // end-users of exported projects. Their playback uses cached WAVs that
  // were synthesized at authoring time.
  cloud: {
    enabled:      false,
    googleApiKey: '',
  },
  // V0.3.2.37 — Auto-backup ("Autosave" settings tab). Writing a large
  // project blocks the renderer for seconds, so by default the backup waits
  // for a natural pause instead of interrupting mid-action. Rotating slots
  // give you several restore points instead of one.
  autosave: {
    enabled:       true,
    intervalMin:   10,     // back up after this much DIRTY work
    waitForIdle:   true,   // postpone while actively working (off = save on the dot)
    idleSec:       6,      // "you stopped" threshold
    nudgeWhenBusy: true,   // if busy when due, offer a dismissible prompt…
    maxWaitMin:    25,     // …and force one anyway after this long
    slots:         3,      // rotating files: .autosave1 / 2 / 3 …
    folder:        '',     // '' = alongside the project file
  },
  // 🎬 Lighting presets (V0.3.2.54) — saved production looks, USER-level so a
  // look saved once is available in EVERY project (the user's "load
  // environments across projects"). Each: { id, name, production:{...} }.
  lightingPresets: [],
  // V0.2.22.58 — SYSTEM-level defaults for the hardware insertion
  // animation (the "Nuts" settings tab). Per-instance values that are
  // left as "use default" resolve to the project default (.sbsproj),
  // then to these, then to the hardcoded fallbacks. Saved with user data.
  nuts: {
    distance:      20,        // X explode spacing (mm)
    repositionMs:  300,       // pre-insertion reposition time (ms)
    tagName:       false,     // show spec-name tag
    tagSize:       'medium',  // 'small' | 'medium' | 'large'
    tagColor:      '#ffffff', // tag text colour
    explodeBefore: false,     // show the nut exploded on every step before insertion
    pauseBefore:   true,      // hold before the insertion (so tags are readable)
    pauseBeforeMs: 300,       // pause duration (ms)
    trajectory:    false,     // show dotted insertion-path line
    lineThickness: 0.5,       // trajectory line thickness (mm)
    lineGap:       2,         // dotted gap scaler (gap = thickness × this)
    lineColor:     '#ffaa00', // trajectory line colour
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
