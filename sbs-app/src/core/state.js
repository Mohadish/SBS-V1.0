/**
 * SBS Step Browser — App State
 * =============================
 * Single source of truth for the entire application.
 *
 * Rules:
 *  - State is only mutated through setState() or the named setters below.
 *  - Components listen for changes via state.on('change:key', handler).
 *  - No component reaches into another component's internals — it reads state.
 *
 * This replaces the old pattern of `app.whatever = value` scattered across
 * 13,000 lines with no clear ownership.
 */

// ── Simple event emitter ───────────────────────────────────────────────────
class EventEmitter {
  constructor() { this._listeners = new Map(); }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);   // returns an unsubscribe function
  }

  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }

  emit(event, ...args) {
    this._listeners.get(event)?.forEach(fn => {
      try { fn(...args); }
      catch (err) { console.error(`[state] Error in "${event}" handler:`, err); }
    });
  }

  once(event, fn) {
    const wrapper = (...args) => { this.off(event, wrapper); fn(...args); };
    return this.on(event, wrapper);
  }
}

// ── Initial state ──────────────────────────────────────────────────────────
function createInitialState() {
  return {
    // ── App meta
    appVersion:     '1.0.0',
    theme:          'dark',           // 'dark' | 'light'
    isElectron:     !!window.sbsNative?.isElectron,

    // ── Project
    projectPath:    null,             // path to the .sbsproj file (or null)
    projectDirty:   false,            // unsaved changes?
    projectName:    'Untitled',

    // ── Assets registry (After Effects model)
    assets: [],                       // [{ id, name, originalPath, type, hash }]

    // ── Scene tree
    treeData:       null,             // root node of the scene tree
    nodeById:       new Map(),        // fast lookup: id → node

    // ── Selection
    selectedId:         null,         // primary selected node id
    multiSelectedIds:   new Set(),    // all selected node ids

    // ── Steps
    steps:          [],               // ordered array of step objects
    chapters:       [],               // ordered array of chapter objects
    activeStepId:   null,             // currently active step id

    // ── Camera views
    cameraViews:    [],               // saved camera presets

    // ── Color presets
    colorPresets:   [],               // [{id, name, type:'solid'|'falloff', ...}]

    // ── Notes library
    noteTemplates:  [],               // [{id, text, fontSize, ...}]
    notePresets: {
      small:  18,
      medium: 36,
      large:  48,
    },

    // ── UI state
    activeSidebarTab:   'files',      // which left sidebar tab is open
    gridVisible:        true,
    showExportSafeFrame: false,

    // ── Gizmo / transform
    activeMoveFolderId: null,
    activeTransformMode: null,        // 'object' | 'pivot' | null

    // ── Export settings
    export: {
      fileName:           'sbs_export',
      outputFormat:       'mp4',
      formatPreset:       'hdtv_1080',
      width:              1920,
      height:             1080,
      fps:                30,
      stepHoldMs:         800,
      startFromActive:    true,
      showSafeFrame:      true,
      narrationEnabled:   true,
      narrationVoice:     '',          // empty → user must pick in Export tab
      narrationSpeed:     1.0,
      narrationHelperUrl: 'http://127.0.0.1:8765',
      deterministicHelperUrl: 'http://127.0.0.1:8766',
      exportFolderPath:   null,
    },

    // ── Lighting
    cameraFillLight: {
      enabled:   false,
      color:     '#ffffff',
      intensity: 1.1,
      distance:  0,
      decay:     2,
      offsetX:   -120,
      offsetY:   70,
      offsetZ:   140,
    },

    // ── Geometry outline
    geometryOutline: {
      enabled:    false,
      color:      '#000000',
      opacity:    0.9,
      creaseAngle: 35,
    },

    // ── Viewport background
    backgroundColor: '#0f172a',
    solidOverride:   false,

    // ── Animation durations
    cameraAnimDurationMs: 1500,
    objectAnimDurationMs: 1500,

    // ── Selection groups
    selectionGroups:      [],
    selectionOutlineColor: '#00ffff',

    // ── Internal: not persisted
    _occt:          null,             // OCCT importer instance
    _exportSession: null,             // active export session
    _sequenceSession: null,           // active playback session
    _stepDirty:     false,            // pending step sync
  };
}

// ── State class ────────────────────────────────────────────────────────────
class AppState extends EventEmitter {
  constructor() {
    super();
    this._state = createInitialState();
  }

  /** Read any state key */
  get(key) {
    return this._state[key];
  }

  /** Update one or more keys and emit change events */
  setState(patch) {
    const changed = [];
    for (const [key, value] of Object.entries(patch)) {
      if (this._state[key] !== value) {
        this._state[key] = value;
        changed.push(key);
      }
    }
    if (changed.length === 0) return;
    for (const key of changed) {
      this.emit(`change:${key}`, this._state[key]);
    }
    this.emit('change', changed, this._state);
  }

  /** Convenience: read multiple keys as an object */
  pick(...keys) {
    const result = {};
    for (const k of keys) result[k] = this._state[k];
    return result;
  }

  // ── Named setters for clarity and discoverability ──────────────────────

  setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    this.setState({ theme });
    // Persist preference
    try { localStorage.setItem('sbs-theme', theme); } catch (_) {}
  }

  setActiveStep(stepId) {
    this.setState({ activeStepId: stepId });
    this.emit('step:activate', stepId);
  }

  setSelection(primaryId, multiIds = null) {
    const multi = multiIds instanceof Set ? multiIds
      : multiIds ? new Set(multiIds)
      : primaryId ? new Set([primaryId])
      : new Set();
    this._state.selectedId      = primaryId;
    this._state.multiSelectedIds = multi;
    this.emit('change:selectedId', primaryId);
    this.emit('change:multiSelectedIds', multi);
    this.emit('selection:change', { primary: primaryId, multi });
  }

  clearSelection() {
    this.setSelection(null, new Set());
  }

  markDirty() {
    if (!this._state.projectDirty) this.setState({ projectDirty: true });
  }

  markClean() {
    if (this._state.projectDirty) this.setState({ projectDirty: false });
  }

  setExportOption(key, value) {
    const exportState = { ...this._state.export, [key]: value };
    this.setState({ export: exportState });
  }

  /** Restore saved theme on startup */
  restoreTheme() {
    try {
      const saved = localStorage.getItem('sbs-theme');
      if (saved === 'light' || saved === 'dark') this.setTheme(saved);
    } catch (_) {}
  }
}

// ── Singleton export ───────────────────────────────────────────────────────
export const state = new AppState();
export default state;
