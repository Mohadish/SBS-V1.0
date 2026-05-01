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

    // ── Model Source Transform mode (Edit → Model source transform…)
    // Transient flag (NOT persisted). When true the left sidebar shows
    // the Model-Source-Transform panel instead of its tabs and the
    // steps panel disables creation / reordering while keeping click-
    // to-navigate live so the user can scrub through the timeline and
    // verify the source edit lands consistently across steps.
    modelSourceMode: false,

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

    // ── Header items — project-level overlay rendered on every step
    headerItems:    [],               // HeaderItem[] — see systems/header.js
    headersLocked:  false,            // when true, header items can't be moved/edited via the canvas
    headersHidden:  false,            // when true, the whole header layer is suppressed (live + export)

    // P4: project-level default styling for header items. Source of
    // truth when an item's styleId is '' (default mode). Same shape as
    // a style template, minus id/name AND minus align — alignment is
    // always per-item (each header item carries its own align field
    // edited via L/C/R buttons in the row).
    headerDefault: {
      fontFamily:     'Arial',
      fontSize:       32,
      fontWeight:     'normal',     // 'normal' | 'bold'
      fontStyle:      'normal',     // 'normal' | 'italic'
      textDecoration: '',           // '' | 'underline'
      color:          '#ffffff',
      fillColor:      null,         // rgba string for textbox bg, or null
    },

    // Mirrors overlay.isEditing() in state-land so other systems
    // (e.g. header.js) can subscribe to edit-mode changes via
    // change:overlayEditing. Source of truth is still overlay.js's
    // setEditingMode — that function writes here.
    overlayEditing: false,

    // When true, the "Step Number" header kind restarts at 1 inside
    // each chapter (Step 1 of Chapter A, then Step 1 of Chapter B…).
    // When false (default), it counts globally across all visible
    // steps regardless of chapter boundaries.
    headerStepNumberPerChapter: false,

    // ── Text style templates — project-level presets each text box can
    // bind to via its `styleId` attr. When bound, the template's font /
    // size / colour / weight / style / decoration / fill all OVERRIDE
    // any inline styling on the box. Editing a template propagates
    // live to every box that references it. Empty = no presets, every
    // box is free-form. See systems/style-templates.js.
    styleTemplates: [],               // StyleTemplate[]

    // ── Cables — 3D wires/conduits routed between mesh anchors and
    // free points. The LIVE state of cables (current step's view).
    // step.snapshot.cables holds per-step variable overrides
    // (positions of free nodes, style, visibility, socket pose). On
    // step activate, the snapshot's overrides are merged in. Topology
    // (id, mesh anchor links, branch chain) stays stable across steps.
    // See systems/cables.js for the full data model and 3-tier
    // anchor resolver (live mesh → phantom → cached fallback).
    cables: [],                       // Cable[]
    // Project-level cable visuals (apply to every cable unless overridden).
    cableGlobalScale:    1.0,         // legacy 0.05–2.0 multiplier — superseded by cableGlobalRadius
    // Phase G: project-level absolute radius. Each cable's effective
    // radius = cableGlobalRadius * (cable.style.size / 100). With the
    // default 1.0 here and per-cable size = 100%, a fresh cable
    // renders at thickness = 1.0 — much thinner than the old default
    // of 3 and with finer slider granularity (size step = 5%).
    cableGlobalRadius:   1.0,
    cableHighlightColor: '#22d3ee',   // colour when cable.highlight=true

    // C3: id of the cable currently in placement mode. While set, the
    // viewport pointerdown handler intercepts left-clicks: hits on a
    // mesh add an anchored point, hits elsewhere add a free point.
    // Cleared on Esc, on the sidebar's Stop Placement button, or
    // automatically on selection / step changes.
    cablePlacingId: null,

    // Phase G follow-up: when true, points placed during cablePlacingId
    // mode are PREPENDED to nodes[] (extends from the cable's start)
    // instead of appended. Driven by "Continue routing" right-clicked
    // on the FIRST node of a non-branch cable. Cleared with placement.
    cablePlacingAtStart: false,

    // C5 (Phase A): currently selected cable point (sphere visual in the
    // viewport). { cableId, nodeId } or null. Drives the cable-point
    // highlight ring in cables-render and gates Phase B (gizmo follow)
    // and later Phase C (re-anchor) work. Independent of selectedId
    // (mesh selection) — clicking a cable point clears mesh selection
    // and vice versa so the gizmo can only follow one target at a time.
    selectedCablePoint: null,

    // C5 (Phase E2): currently selected cable SOCKET. { cableId, nodeId }
    // | null. Mutually exclusive with selectedCablePoint and the mesh
    // selection — selecting any of the three clears the others. Drives
    // the socket-edit panel in cable-tab and the full translate+rotate
    // gizmo on the socket.
    selectedCableSocket: null,

    // C5 (Phase C): a cable point is awaiting a re-anchor pick. While
    // set, the next viewport click on a mesh moves the point's anchor
    // to that mesh + face position. Cleared on Esc, on a successful
    // pick, or when selection changes.
    cableReanchorPickingId: null,     // { cableId, nodeId } | null

    // C5 (Phase D): an insertion is staged — the next click on a mesh
    // adds a new point to the cable at the indicated index relative to
    // the anchor node. Shape: { cableId, anchorNodeId, position }
    // where position is 'before' | 'after'. Cleared on Esc, on a
    // successful pick, or when selection changes.
    cableInsertPickingTarget: null,

    // C5 (Phase E2 follow-up): a SOCKET is awaiting a re-anchor pick.
    // Same modal-pick pattern as cableReanchorPickingId but the click
    // re-anchors the socket (back face on new surface, cable point
    // follows along the new normal). Cleared on Esc / successful pick.
    cableSocketReanchorPickingId: null,    // { cableId, nodeId } | null

    // ── UI state
    activeSidebarTab:   'files',      // which left sidebar tab is open
    gridVisible:        true,
    showExportSafeFrame: false,

    // ── Gizmo / transform
    activeMoveFolderId: null,
    // Node currently in PIVOT EDIT mode (the RED state on the tree's
    // pivot button). When set, the gizmo for that node sits at the
    // pivot world pose with an orange dot at its hub, and gizmo drags
    // write to pivotLocalOffset / pivotLocalQuaternion instead of
    // moving the geometry. Cleared on viewport pointerdown anywhere
    // outside the gizmo handles (RED → BLUE commit).
    pivotEditNodeId: null,

    // Node id awaiting a "snap pivot to surface" raycast. When set,
    // the next viewport pointerdown is intercepted: it raycasts
    // against the scene, and on a hit positions+orients the pivot
    // along the face normal (Z=normal, tangent plane = X/Y). Cleared
    // on hit, on Esc, or on selection change. Triggered from the
    // tree row "Snap Pivot to Surface" menu entry or the panel button.
    pivotSnapPickingNodeId: null,

    // ── Export settings
    // Suppress auto-play of step narration when navigating live in the app.
    // The Preview ▶ button still works regardless. Persisted per project.
    narrationMuted: false,

    // Project-relative folder where synthesized narration WAVs are cached on
    // disk. When set, step.narration.dataFile (sha1.wav filename) replaces
    // the bulky inline base64 dataUrl on save — keeps .sbsproj small.
    // null → inline base64 in project file (legacy behaviour).
    audioCacheFolder: null,

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
      offlineRender:      false,
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
