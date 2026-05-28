/**
 * SBS Step Browser — Data Model & Schema
 * ========================================
 * Canonical definitions for every data structure in the app.
 *
 * KEY PRINCIPLE: A step is a completely self-contained container.
 * It stores the FULL scene state at the moment it was captured.
 * Steps do not depend on each other. Moving a step in the timeline
 * never breaks it. Transitions are always calculable from any
 * "from" state to any "to" state.
 *
 * KEY PRINCIPLE: Save files are versioned per-section.
 * Unknown fields are always preserved. Migrations are explicit.
 * Old projects load in new versions. Always.
 */

// ── Schema versions (increment when a section's shape changes) ─────────────
export const SCHEMA_VERSIONS = {
  project:    1,
  tree:       1,
  step:       1,
  camera:     1,
  color:      3,   // v3: reflectionIntensity replaces envMapIntensity+falloffStrength
  note:       1,
  asset:      1,
  cable:      1,
  screen:     1,
};

export const APP_VERSION  = 'V0.2.22.18';
// Format: YYYY-MM-DD. Bump along with APP_VERSION on every build worth
// labelling so the File tab shows you're running the expected slice.
export const APP_RELEASED = '2026-05-21';


// ═══════════════════════════════════════════════════════════════════════════
//  PROJECT FILE  (.sbsproj)
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The root structure of a saved .sbsproj file.
 * Every section carries its own schema_version so we can migrate
 * independently without breaking unrelated data.
 *
 * Unknown top-level keys are preserved on round-trip (never dropped).
 */
export function createEmptyProject() {
  return {
    _sbs: {
      app_version:           APP_VERSION,
      format_version:        1,
      created:               new Date().toISOString(),
      saved:                 new Date().toISOString(),
      min_compatible_version:'1.0.0',
    },

    // Asset registry — the CAD/model files this project references
    assets: {
      schema_version: SCHEMA_VERSIONS.asset,
      items: [],          // AssetEntry[]
    },

    // Scene tree — folder/model/mesh hierarchy
    tree: {
      schema_version: SCHEMA_VERSIONS.tree,
      root: null,         // TreeNode (scene root)
    },

    // Steps — the presentation timeline
    steps: {
      schema_version: SCHEMA_VERSIONS.step,
      items: [],          // Step[]
    },

    // Chapters — grouping of steps
    chapters: {
      schema_version: 1,
      items: [],          // Chapter[]
    },

    // Saved camera views
    cameras: {
      schema_version: SCHEMA_VERSIONS.camera,
      items: [],          // CameraView[]
    },

    // Color / material presets
    colors: {
      schema_version: SCHEMA_VERSIONS.color,
      items: [],          // ColorPreset[]
    },

    // Note templates library
    notes: {
      schema_version: SCHEMA_VERSIONS.note,
      templates: [],      // NoteTemplate[]
      presets: { small: 18, medium: 36, large: 48 },
    },

    // Selection groups
    selections: {
      schema_version: 1,
      groups: [],         // SelectionGroup[]
      outlineColor: '#00ffff',
    },

    // Animation presets — phased transition definitions
    animationPresets: {
      schema_version: 1,
      items: [],          // AnimationPreset[]
    },

    // Header overlay items — project-level (NOT duplicated into steps).
    // Renders on a dedicated layer above the per-step overlay so a single
    // edit ripples to every step. Dynamic kinds (stepName, stepNumber,
    // chapterName, chapterNumber) resolve their text per-step at render
    // time. See systems/header.js.
    headers: {
      schema_version: 1,
      items: [],          // HeaderItem[]
    },

    // Text style templates — project-level presets that text boxes can
    // bind to via styleId. See systems/style-templates.js.
    styles: {
      schema_version: 1,
      items: [],          // StyleTemplate[]
    },

    // Flat-shape templates — project-level polygon library. Instances live
    // in the scene tree (type='flatShape') and reference these by id.
    // See systems/flat-shapes.js + ui/shape-tab.js.
    shapes: {
      schema_version: 1,
      items: [],          // ShapeTemplate[]
    },

    // App-level settings saved with the project
    settings: {
      schema_version: 1,
      backgroundColor:        '#0f172a',
      solidOverride:          false,
      gridVisible:            false,
      cameraAnimDurationMs:   1500,
      objectAnimDurationMs:   1500,
      cameraFillLight: {
        enabled: false, color: '#ffffff', intensity: 1.1,
        distance: 0, decay: 2, offsetX: -120, offsetY: 70, offsetZ: 140,
      },
      geometryOutline: {
        enabled: false, color: '#000000', opacity: 0.9, creaseAngle: 35,
      },
      export: {
        fileName: 'sbs_export', outputFormat: 'webm_vp8',
        formatPreset: 'hdtv_1080', width: 1920, height: 1080,
        fps: 30, stepHoldMs: 100, narrationVoice: 'en_US-lessac-high',
        narrationSpeed: 1.0,
        narrationHelperUrl: 'http://127.0.0.1:8765',
        deterministicHelperUrl: 'http://127.0.0.1:8766',
      },
    },
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  ASSET ENTRY
// ═══════════════════════════════════════════════════════════════════════════
/**
 * A reference to an external file (CAD model, image, etc.)
 * The project never embeds the file — it references it.
 * This is the After Effects model.
 */
export function createAsset(overrides = {}) {
  return {
    id:           generateId('asset'),
    name:         '',
    type:         'model',          // 'model' | 'image'
    originalPath: '',               // absolute path when project was saved
    relativePath: '',               // relative to the .sbsproj file (preferred)
    fileHash:     null,             // SHA-256 of file content (change detection)
    fileSize:     null,
    importedAt:   new Date().toISOString(),
    ...overrides,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  TREE NODE
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Every element in the 3D scene lives in this tree.
 * Types: 'scene' (root), 'model', 'folder', 'mesh'
 */
export function createNode(type, overrides = {}) {
  return {
    id:           generateId(type),
    name:         '',
    type,                           // 'scene' | 'model' | 'folder' | 'mesh'
    assetId:      null,             // for type='model': links to AssetEntry
    localVisible: true,
    // archived: locked-hidden state. True ⇒ node is treated as if removed
    // from the scene (fully invisible, no captures, no audits, no
    // interaction) but kept in the tree with all its per-step history
    // intact. Toggle via tree/viewport r-click "Archive" / "Unarchive".
    // Used for Replace Object (old node archives) and as a general-purpose
    // "preserve, don't show" toggle.
    archived:     false,
    // locked: folder-only (V0.1.92, replaces the old isGroup/groupLocked
    // "Group" concept). When true, a folder is treated as a single unit:
    // a viewport click on any descendant promotes the selection up to this
    // folder, and the tree row auto-collapses. Default false (plain folder).
    // Legacy `isGroup` folders migrate to locked on load (io/project.js).
    locked:       false,
    children:     [],

    // Transform (folder and model nodes only)
    localOffset:        [0, 0, 0],
    localQuaternion:    [0, 0, 0, 1],
    baseLocalPosition:  [0, 0, 0],
    baseLocalQuaternion:[0, 0, 0, 1],
    baseLocalScale:     [1, 1, 1],
    pivotLocalOffset:   [0, 0, 0],
    pivotLocalQuaternion:[0, 0, 0, 1],
    pivotEnabled:       true,
    moveEnabled:        true,
    rotateEnabled:      true,

    // Model SOURCE transform — model nodes only. Lives on an INNER
    // Three.js group inserted between the model's outer group and its
    // mesh children. Equivalent to opening the model in another DCC,
    // applying the transform there, and reloading the file: the
    // geometry is "baked" with this transform from the perspective of
    // the rest of the SBS pipeline. Per-step localOffset/Quaternion
    // and the pivot system act on the OUTER group and never see the
    // source — pivot stays put, per-step animations are untouched,
    // every step inherits the source through the inner group's
    // place in the hierarchy.
    sourceLocalPosition:   [0, 0, 0],
    sourceLocalQuaternion: [0, 0, 0, 1],
    sourceLocalScale:      [1, 1, 1],

    // Mesh-specific
    meshIndex:    null,             // index in the model's mesh list
    colorPresetId:null,             // applied color preset (null = original)

    ...overrides,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  FLAT SHAPE  ("2D shapes in 3D" — Phase 1)
// ═══════════════════════════════════════════════════════════════════════════
//
// Library-and-instance model, mirrors notes:
//   - createShapeTemplate(): SHARED polygon + fill, lives at project level
//                            (state.shapeTemplates), can be re-placed many times.
//   - createFlatShapeNode(): per-PLACEMENT instance, lives in the scene tree
//                            with its own transform; references a template by id.
//
// The mesh geometry is built from the template's polygon and the instance's
// transform (localOffset / localQuaternion = the plane's pose at draw time).
// Geometry is rebuilt on demand by systems/flat-shapes.js whenever the node
// has no live object3d — save/load only needs the fields below.

/**
 * Library entry. ONE polygon per template in v1.
 *
 *   polygon.outer   [[x,y], …]               main contour (plane-local 2D)
 *   polygon.holes   [[[x,y], …], …]          optional holes — empty in v1
 *
 * Identity (id) is stable; instances reference it. Edit the template ⇒
 * every instance updates on next mesh rebuild.
 */
export function createShapeTemplate(overrides = {}) {
  return {
    id:       generateId('shapeTpl'),
    name:     '',
    fill:     '#cccccc',
    // List of input polygons. The displayed geometry is the XOR of all
    // entries — every additional polygon flips the parity, so two
    // overlapping rectangles produce a "+" with a clear centre, three
    // produce a solid centre again, and a fully-contained polygon
    // becomes a hole (donut). Each entry: { outer:[[x,y]…], holes:[…] }.
    polygons: [{ outer: [], holes: [] }],
    // ── Optional: image-shape data ────────────────────────────────────
    // When set, the template renders as a TEXTURED rectangle (image is
    // mapped to the polygon's bounding box via UVs). `polygons` is still
    // used — for image-shapes we pre-populate it with a rectangle in the
    // image's aspect ratio. Treating image-shapes as "flatShape with a
    // texture map" means save/load, step snapshots, picking, transforms
    // and undo all keep working unchanged.
    //
    //   dataUrl   "data:image/png;base64,..."   the image payload
    //   format    'png' | 'jpg' | 'gif' | 'bmp'
    //   width     number (px) — image natural width
    //   height    number (px) — image natural height
    //   hasAlpha  boolean — true for PNG/GIF (renders with alphaTest)
    //
    // Migration: legacy templates default to image=null (renders with
    // fill colour as before). Project save/load passes the field through.
    image:    null,
    ...overrides,
  };
}

/**
 * Tab-only grouping of shape templates. Lives in state.shapeTemplateGroups
 * (NOT in the scene tree). Affects only:
 *   - Shape tab rendering (collapsible row containing member templates)
 *   - Viewport selection promotion when `locked` is true (any flatShape
 *     instance whose template belongs to a locked group expands the
 *     selection to ALL instances of ALL member templates)
 *   - Bulk hide/show via the group's eye toggle
 * Templates can belong to at most one group; ungrouped templates render
 * at the top of the tab as before.
 *
 *   templateIds   [tplId, …]   members, in display order
 *   locked        boolean      true → viewport selection promotion
 *   collapsed     boolean      tab UI state — not undoable
 */
export function createShapeTemplateGroup(overrides = {}) {
  return {
    id:          generateId('shapeGrp'),
    name:        'Shape Group',
    locked:      true,
    collapsed:   false,
    templateIds: [],
    ...overrides,
  };
}

/**
 * A placed instance of a shape template. Behaves like a transform-capable
 * node (model/folder family) for the gizmo + step snapshots — see
 * isTransformNode() in core/transforms.js.
 *
 * `templateId` is REQUIRED: a flatShape with no template renders nothing.
 * `localScale` is a per-instance uniform scale delta on top of
 * baseLocalScale (Phase 2 will surface a gizmo handle for it).
 */
export function createFlatShapeNode(overrides = {}) {
  return {
    id:           generateId('flatShape'),
    name:         '',
    type:         'flatShape',
    localVisible: true,
    // archived: see createNode for semantics — flat-shape instances honour
    // the same archive contract as model/folder/mesh nodes.
    archived:     false,
    children:     [],

    // Pointer to a state.shapeTemplates entry — owns polygon + fill.
    templateId:   null,

    // ── Drawing-plane orientation (parent-local quaternion). ───────────
    // Captured at placement time (the world rotation that aligns the
    // template's 2D plane with the picked face / camera-facing plane,
    // expressed in the instance's parent frame). We BAKE this rotation
    // into the geometry vertices when building the mesh — that way
    // baseLocalQuaternion stays at identity and the gizmo math behaves
    // exactly like a folder (no axis-swap bug).
    planeLocalQuaternion: [0, 0, 0, 1],

    // Transforms — same shape as model/folder so the gizmo works.
    localOffset:        [0, 0, 0],
    localQuaternion:    [0, 0, 0, 1],
    orientationSteps:   [0, 0, 0],
    baseLocalPosition:  [0, 0, 0],
    baseLocalQuaternion:[0, 0, 0, 1],   // identity for shapes — plane goes into geometry
    baseLocalScale:     [1, 1, 1],      // global-only — written by Phase 2.1 scale handle
    pivotLocalOffset:   [0, 0, 0],
    pivotLocalQuaternion:[0, 0, 0, 1],
    pivotEnabled:       false,
    moveEnabled:        true,
    rotateEnabled:      true,

    ...overrides,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  STEP  ← The most important data structure in the app
// ═══════════════════════════════════════════════════════════════════════════
/**
 * A step is a COMPLETE, SELF-CONTAINED world state.
 *
 * It stores everything needed to reproduce the exact scene at that moment:
 * - Every node's visibility
 * - Every node's transform (position, rotation)
 * - Every material / color override
 * - The camera position and orientation
 * - All annotations / notes and their positions
 * - All screen overlay items (text boxes, images)
 * - Cable system state
 *
 * Steps do NOT reference each other.
 * A step moved anywhere in the timeline is still fully valid.
 * A transition from step A to step B is always calculable:
 *   diff(A.snapshot, B.snapshot) → animate each changed property.
 */
export function createStep(overrides = {}) {
  return {
    id:        generateId('step'),
    name:      'New Step',
    chapterId: null,                // optional chapter grouping
    hidden:    false,               // hidden steps are skipped in playback

    // ── Step grouping (Phase A of step-groups) ────────────────────────────
    // A "step group" is just a normal step with a lock icon and zero or
    // more sub-steps following it in the steps array. The first step IS
    // the group head — there's no separate container. Sub-steps point at
    // their head via groupId; their position in the array defines play
    // order within the group. Header always shows the head's number for
    // every sub-step. The viewer plays head + sub-steps as ONE segment.
    //
    //   groupHead = true   → this step has the lock icon. May be empty
    //                        (no sub-steps yet) or carry sub-steps after
    //                        it in the array. groupId stays null on heads.
    //   groupId   = <id>   → this step is a sub-step pointing at the
    //                        groupHead step with that id. groupHead=false.
    //   both default       → ordinary top-level step, unrelated to groups.
    //
    // Invariant (enforced by drag-and-drop): all steps with groupId === X
    // appear contiguously immediately after step X in the steps array.
    //
    //   groupLocked = true   → head stays expanded regardless of activity.
    //                          Mirrors chapter.locked semantics. Field is
    //                          only meaningful on heads (groupHead=true).
    groupHead:   false,
    groupId:     null,
    groupLocked: false,

    // Voice-over / narration text
    voiceText:      '',
    voiceEnabled:   true,

    // Transition settings (how to animate INTO this step)
    transition: {
      durationMs:       1500,       // camera + object animation duration (simultaneous fallback)
      cameraEasing:     'smooth',   // 'smooth' | 'linear' | 'instant'
      objectEasing:     'smooth',
      visibilityFade:   true,       // fade visibility changes
      animPresetId:     null,       // null = use project default (or simultaneous fallback)
    },

    // Camera binding — controls whether this step uses its own snapshot
    // camera ('free') or pulls from a named template in cameraViews ('template').
    // 'free' is the default for new steps; user opts in to templates per step
    // via the camera dropdown in the steps panel.
    cameraBinding: createCameraBinding(),

    // ── THE SNAPSHOT: complete scene state ────────────────────────────────
    snapshot: createEmptySnapshot(),

    ...overrides,
  };
}

/**
 * Camera binding for a step.
 * mode='free'     → camera comes from step.snapshot.camera (today's behaviour)
 * mode='template' → camera comes from cameraViews[templateId] at activation time
 */
export function createCameraBinding(overrides = {}) {
  return {
    mode:       'free',
    templateId: null,
    ...overrides,
  };
}

/**
 * A snapshot is the full scene state at a moment in time.
 * Captured when a step is saved, applied when a step is activated.
 */
export function createEmptySnapshot() {
  return {
    // Visibility: nodeId → boolean
    visibility: {},

    // Transforms: nodeId → { localOffset, localQuaternion, pivotLocalOffset, pivotLocalQuaternion }
    transforms: {},

    // Material overrides: nodeId → { colorPresetId } | null (null = original material)
    materials: {},

    // Camera state (exact)
    camera: null,                   // CameraState | null

    // Scene notes (annotations anchored to 3D positions)
    notes: [],                      // SceneNote[]   — legacy flat-list

    // Per-step panel offsets for 3D-anchored balloon notes (Phase 2).
    // Sparse map: { [noteId]: {x, y} }. The note's panelOffset is
    // GLOBAL (set at creation) — this map overrides it per-step so a
    // single note can sit in a different screen-relative position on
    // each step and lerp smoothly between them across step transitions.
    // Visibility is per-step via the standard snapshot.visibility map.
    notePanelOffsets: {},

    // Screen overlay items (text boxes, images over the 2D viewport)
    screenItems: [],                // ScreenItem[]

    // Header overlay items (title / chapter display)
    headerItems: [],                // HeaderItem[]

    // Cable system state
    cables: [],                     // Cable[]
  };
}

/**
 * Camera state — exact position and orientation.
 * Stores both quaternion (precise) and pivot (orbit target).
 */
export function createCameraState(overrides = {}) {
  return {
    position:   [0, 0, 100],        // [x, y, z]
    quaternion: [0, 0, 0, 1],       // [x, y, z, w]
    pivot:      [0, 0, 0],          // orbit target [x, y, z]
    up:         [0, 1, 0],          // camera up vector
    fov:        50,                  // field of view (degrees)
    ...overrides,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  SCENE NOTE  (legacy flat-list shape — kept for back-compat with the
//   never-used scaffold. New notes go through createNoteNode below and
//   live as TREE CHILDREN of their anchor mesh.)
// ═══════════════════════════════════════════════════════════════════════════
export function createSceneNote(overrides = {}) {
  return {
    id:           generateId('note'),
    templateId:   null,             // null = freestanding note (not from library)
    text:         '',
    fontSize:     'medium',         // 'small' | 'medium' | 'large'
    // 2D viewport position (normalized 0–1 relative to safe frame)
    x:            0.1,
    y:            0.1,
    // 3D anchor (optional — if set, note follows a point in 3D space)
    anchorWorld:  null,             // [x, y, z] in world space
    visible:      true,
    ...overrides,
  };
}

/**
 * 3D-anchored balloon note — lives as a TREE CHILD of its anchor mesh.
 *
 * Anchor strategy: on creation we record both the hit point in MESH-LOCAL
 * space (anchorLocal) and the same point as a fraction of the mesh's
 * bbox (anchorBboxRelative). Renderer uses anchorLocal when the mesh
 * geometry is loaded; falls back to bbox-relative when the asset is
 * missing and the mesh is a phantom placeholder, so the note keeps its
 * meaningful position even across a missing-asset reload.
 *
 * Style: sizePresetId references one of state.notePresets's keys
 * ('small' / 'medium' / 'large'). Setting customFontSize to a number
 * overrides the preset for that single note.
 *
 * Per-step state (visibility + panelOffset) is captured in
 * step.snapshot.noteStates[noteId] as a sparse override map (Phase 2).
 * Phase 1 just renders the global state.
 */
export function createNoteNode(overrides = {}) {
  return {
    id:                 generateId('note'),
    type:               'note',
    name:               '',
    localVisible:       true,
    children:           [],

    anchorMeshId:       null,                // owning mesh node id
    anchorLocal:        [0, 0, 0],           // hit point in MESH-LOCAL frame
    anchorBboxRelative: [0.5, 0.5, 0.5],     // 0–1 within mesh.bbox (resilience)
    text:               '',
    sizePresetId:       'medium',            // refs state.notePresets[sizePresetId]
    customFontSize:     null,                // px override; null = use preset
    panelOffset:        { x: 90, y: -70 },   // pixels, relative to anchor screen pt
    templateId:         null,                // null = standalone note (no library link)

    ...overrides,
  };
}

/**
 * Note template — entry in state.noteTemplates. Owns the SHARED content
 * (text + size). Instances reference it by id. Position + visibility
 * are still per-instance (on the createNoteNode that holds templateId).
 */
export function createNoteTemplate(overrides = {}) {
  return {
    id:             generateId('ntpl'),
    name:           '',                      // auto-named "Template N" when blank
    text:           '',
    sizePresetId:   'medium',
    customFontSize: null,
    ...overrides,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  SCREEN ITEM (text boxes, images overlaid on the viewport)
// ═══════════════════════════════════════════════════════════════════════════
export function createScreenItem(kind, overrides = {}) {
  const base = {
    id:     generateId('screen'),
    kind,                           // 'text' | 'image'
    // Normalized rect relative to safe frame (0–1)
    rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.15 },
    locked:  false,
    visible: true,
  };

  if (kind === 'text') {
    return {
      ...base,
      content: null,                // Quill delta JSON
      style: {
        color:      '#e5e7eb',
        background: 'transparent',
        align:      'left',
        fontSize:   16,
      },
      ...overrides,
    };
  }

  if (kind === 'image') {
    return {
      ...base,
      assetId:  null,               // references AssetEntry
      fit:      'contain',          // 'contain' | 'cover' | 'fill'
      ...overrides,
    };
  }

  return { ...base, ...overrides };
}


// ═══════════════════════════════════════════════════════════════════════════
//  CHAPTER
// ═══════════════════════════════════════════════════════════════════════════
export function createChapter(overrides = {}) {
  return {
    id:     generateId('chapter'),
    name:   'Chapter',
    hidden: false,
    locked: false,   // true = always expanded in timeline, ignores collapse state
    ...overrides,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  COLOR PRESET
// ═══════════════════════════════════════════════════════════════════════════
/**
 * A color preset defines the complete visual appearance of a surface.
 *
 * The key concept: ALL values are global to the preset.
 * Objects are assigned a preset; that assignment can change per step.
 * Transitioning between steps lerps between the two presets' values.
 *
 * The four material parameters:
 *   solidness           1=fully solid, 0=full X-ray falloff; step-animatable
 *   metalness           0=dielectric, 1=metallic; step-animatable
 *   roughness           0=mirror, 1=fully diffuse; step-animatable
 *   reflectionIntensity 0=matte, 1=shiny specular highlights; step-animatable
 *
 * How solidness works:
 *   The shader computes a view-angle falloff value per fragment:
 *     0 = face pointing directly at camera  (centre of model)
 *     1 = face is edge-on / 90°             (silhouette edge)
 *   That falloff value is mapped through an opacity curve:
 *     solidness=1.0 → flat curve at y=1.0 (all faces fully opaque → solid)
 *     solidness=0.0 → X-ray curve (centre transparent, edges opaque)
 *     solidness 0–1 → smooth interpolation between the two curves
 *   The curve shape (falloff power) is fixed at 2.5.
 */
export function createColorPreset(overrides = {}) {
  return {
    id:              generateId('color'),
    name:            'New Color',

    // ── The four material parameters ─────────────────────────────────────
    color:               '#4a90d9', // hex, step-animatable
    solidness:           1.0,       // 1=solid, 0=full X-ray; step-animatable
    metalness:           0.05,      // 0–1, step-animatable
    roughness:           0.45,      // 0–1, step-animatable
    reflectionIntensity: 0.5,       // 0=matte, 1=shiny; step-animatable

    // ── Outline override (null = inherit global setting) ─────────────────
    outlineEnabled:  null,          // null | true | false

    // ── Texture handling ─────────────────────────────────────────────────
    // false (default): preserve original texture maps; preset colour is a tint.
    // true:            strip all texture maps; render as pure solid colour.
    removeTextures: false,

    // ── Back face pass (reserved — not yet active) ───────────────────────
    backFaceEnabled:    false,
    backFaceColor:      '#ffffff',
    backFaceOpacity:    0.35,
    backFaceEdgeDarken: 0.45,

    ...overrides,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  CAMERA VIEW
// ═══════════════════════════════════════════════════════════════════════════
export function createCameraView(overrides = {}) {
  return {
    id:       generateId('cam'),
    name:     'View',
    ...createCameraState(),
    ...overrides,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  ANIMATION PRESET
// ═══════════════════════════════════════════════════════════════════════════
/**
 * An animation preset defines phased transition behaviour.
 * Syntax: 'camera(500), color(300), obj+visibility(400)'
 * Phases run sequentially; types within a phase run simultaneously.
 */
// One phase, every real action channel parallel at AL1 (the global
// camera-duration slider value). This is the "idiot-proof default" —
// the visual editor doesn't let the user ADD channels, only redistribute
// them across phases, so every channel must be present from the start.
// Notes:
//   - `overlays` (sustained no-flicker) is the default crossfade flavour.
//     `overlay` (classic crossfade) is available via a per-capsule mode
//     toggle in the visual editor; both never coexist in the same string.
//   - `pause` is NOT in the default — it's added by the user via
//     "+ Pause" when they want a dwell between phases.
export const DEFAULT_ANIMATION_PRESET_STRING =
  'camera+visibility+obj+color+overlays+cable+narration+notes+shape(AL1)';

export function createAnimationPreset(overrides = {}) {
  return {
    id:        generateId('anim'),
    name:      'New Animation',
    // Cover every channel the engine knows about so a freshly-created
    // preset transitions everything by default. The visual editor in
    // animation-tab.js lets the user split capsules across phases.
    animation: DEFAULT_ANIMATION_PRESET_STRING,
    isDefault: false,
    ...overrides,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  CABLE — 3D wire/conduit between mesh anchors and free points
// ═══════════════════════════════════════════════════════════════════════════
//
// Topology-hoisted model: the IDENTITY of a cable (id + mesh anchor links +
// branch chain) is project-global. The VARIABLE state (positions, style,
// visibility, socket pose) is captured in each step's snapshot and re-
// applied when the step activates. This lets a single cable carry one
// route across all steps while still varying its appearance per step.
//
// Per-anchor cached world position + quaternion give us a 3-tier
// fallback when the anchor target's mesh is gone (asset missing OR
// user removed model from tree):
//   1. mesh alive          → derive from mesh.matrixWorld + anchorLocal
//   2. phantom placeholder → derive from the placeholder's transform
//   3. cache               → use cachedWorldPos / cachedWorldQuat
// The cache is refreshed every frame the mesh is alive, so a fresh
// removal hands off to the cache with no visible jump.

/**
 * One node in a cable's chain. anchorType decides how its world
 * position resolves:
 *   - 'mesh'  : nodeId+anchorLocal on a scene-tree mesh
 *   - 'free'  : world `position` directly
 *   - 'branch': starts a branch off another cable's node — world pos
 *               recurses through {sourceCableId, sourceNodeId}
 *
 * One socket max per node (BoxGeometry connector at the endpoint).
 */
export function createCableNode(overrides = {}) {
  return {
    id:                 generateId('cnode'),
    type:               'point',          // 'point' | 'branch-start'
    anchorType:         'free',           // 'mesh' | 'free' | 'branch'
    nodeId:             null,             // scene-tree node id (when anchorType='mesh')
    anchorLocal:        null,             // [x,y,z] local offset on the anchor mesh
    normalLocal:        null,             // [x,y,z] face normal at pick time (drives socket orientation)
    position:           null,             // [x,y,z] world position (when anchorType='free')
    sourceCableId:      null,             // (when anchorType='branch') parent cable id
    sourceNodeId:       null,             // (when anchorType='branch') parent node id
    branchCableIds:     [],               // outgoing branches from this node — blocks delete
    cachedWorldPos:     null,             // [x,y,z] last-known world pos — fallback when anchor target dies
    cachedWorldQuat:    null,             // [x,y,z,w] last-known world quat — for sockets
    socket:             null,             // CableSocket | null
    ...overrides,
  };
}

/**
 * Connector box at a cable node. Orientation lives in `localQuaternion`
 * when the host node is mesh-anchored (so it follows the mesh), else
 * `quaternion` (world-space) for free / branch nodes. Render offsets the
 * box half its depth along the +Z axis so the front face touches the
 * cable point — see persistSocketFromVisual for the inverse math.
 */
export function createCableSocket(overrides = {}) {
  return {
    id:               generateId('csock'),
    name:             '',
    color:            '#ff9d57',
    size:             { w: 10, h: 10, d: 18 },
    localQuaternion:  null,               // [x,y,z,w] when host node is mesh-anchored
    quaternion:       null,               // [x,y,z,w] world-space, for free/branch hosts
    ...overrides,
  };
}

export function createCable(overrides = {}) {
  return {
    id:           generateId('cable'),
    name:         '',
    nodes:        [],                     // CableNode[]
    branchSource: null,                   // { cableId, nodeId } when this cable branches off another
    visible:      true,
    highlight:    false,
    style: {
      color:     '#ffb24a',
      // Phase G: per-cable size % multiplier on cableGlobalRadius
      // (default 100). Effective radius = globalRadius × (size/100).
      // Legacy `radius` field is still read by cableEffectiveRadius()
      // when `size` is missing, so old projects keep their look.
      size:      100,
      type:      'straight',              // 'straight' | 'catenary' | 'bezier' (only 'straight' rendered today)
    },
    ...overrides,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  MIGRATION REGISTRY
// ═══════════════════════════════════════════════════════════════════════════
/**
 * When a section's schema_version changes, add a migration function here.
 * Migrations run in order: v1→v2→v3 etc.
 * Each migration receives the old data and returns new data.
 *
 * Example (future):
 *   steps: [
 *     null,               // v1 → v2
 *     (data) => { ... },  // v2 → v3
 *   ]
 */
export const MIGRATIONS = {
  project: [],
  tree:    [],
  step:    [],
  camera:  [],
  color: [
    // v1 → v2: type/opacity/falloff fields → solidness/falloffStrength
    (data) => {
      const items = (data.items || []).map(p => {
        if (p.solidness !== undefined) return p;  // already v2
        const isFalloff = p.type === 'falloff' || p.falloff;
        const solidness = isFalloff
          ? 0.0
          : typeof p.opacity === 'number' ? p.opacity : 1.0;
        const falloffPower = typeof p.falloffPower === 'number' ? p.falloffPower : 2.5;
        // map falloffPower (1–8) back to falloffStrength (0–1)
        const falloffStrength = Math.max(0, Math.min(1, (falloffPower - 1) / 7));
        const { type: _t, opacity: _o, falloff: _f, falloffPower: _fp,
                backOpacity, backColor, backEdgeDarken, ...rest } = p;
        return {
          ...rest,
          solidness,
          falloffStrength,
          envMapIntensity: p.envMapIntensity ?? 0.01,
          outlineEnabled:  null,
          backFaceEnabled:    false,
          backFaceColor:      backColor      ?? '#ffffff',
          backFaceOpacity:    backOpacity    ?? 0.35,
          backFaceEdgeDarken: backEdgeDarken ?? 0.45,
        };
      });
      return { ...data, items };
    },
    // v2 → v3: reflectionIntensity replaces envMapIntensity + falloffStrength
    (data) => {
      const items = (data.items || []).map(p => {
        if (p.reflectionIntensity !== undefined) return p; // already v3
        // Map old envMapIntensity (typical range 0.01–0.5) to reflectionIntensity (0–1).
        // Default was 0.01 → maps to 0.5 (neutral). Scale: envMap * 50 clamped 0–1.
        const reflectionIntensity = Math.min(1, Math.max(0,
          (p.envMapIntensity ?? 0.01) * 50
        ));
        const { envMapIntensity: _e, falloffStrength: _f, ...rest } = p;
        return { ...rest, reflectionIntensity };
      });
      return { ...data, items };
    },
  ],
  note:    [],
  asset:   [],
  cable:   [],
  screen:  [],
};

/**
 * Migrate a section's data from its saved version to the current version.
 * Unknown fields are always preserved.
 */
export function migrateSection(sectionName, data) {
  const migrations = MIGRATIONS[sectionName] || [];
  const savedVersion = data?.schema_version ?? 1;
  const currentVersion = SCHEMA_VERSIONS[sectionName] ?? 1;

  let result = { ...data };
  for (let v = savedVersion; v < currentVersion; v++) {
    const migrate = migrations[v - 1];
    if (typeof migrate === 'function') {
      result = migrate(result);
    }
  }
  result.schema_version = currentVersion;
  return result;
}


// ═══════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
let _idCounter = 0;

export function generateId(prefix = 'id') {
  _idCounter++;
  const ts  = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${ts}${rand}_${_idCounter}`;
}

export function makeIdentityQuaternion() { return [0, 0, 0, 1]; }
export function makeIdentityPosition()   { return [0, 0, 0]; }
export function makeIdentityScale()      { return [1, 1, 1]; }
