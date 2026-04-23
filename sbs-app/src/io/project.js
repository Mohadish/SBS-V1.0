/**
 * SBS Step Browser — Project Save / Load
 * ========================================
 * Serialises and deserialises the full application state to/from a
 * .sbsproj file (JSON).
 *
 * FILE I/O STRATEGY (three paths in priority order):
 *   1. Electron  — window.sbsNative.saveFile / openFile (IPC bridge)
 *   2. Web FSA   — window.showSaveFilePicker / showOpenFilePicker
 *   3. Fallback  — <a download> for save, <input type=file> for open
 *
 * LOAD FLOW:
 *   loadProject(file)           → parse + migrate JSON, apply state
 *   buildIdRemapFromSpec(...)   → match freshly-loaded nodes to saved IDs
 *   applyIdRemap(...)           → stamp saved IDs onto live nodes
 *   applySpecFieldsToNodes(...) → restore names, transforms, vis from spec
 *
 * The caller (main.js) owns the model-loading loop and calls these
 * helpers once per loaded model so step snapshots reference the right IDs.
 */

import { state }                      from '../core/state.js';
import {
  createEmptyProject,
  APP_VERSION,
  migrateSection,
  generateId,
}                                     from '../core/schema.js';
import { materials }                  from '../systems/materials.js';
import { steps   }                  from '../systems/steps.js';


// ═══════════════════════════════════════════════════════════════════════════
//  SERIALISE (state → JSON)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Recursively clone a tree node, stripping the non-serialisable
 * `object3d` runtime reference (and any other transient fields).
 */
function stripNode(node) {
  if (!node) return null;
  // eslint-disable-next-line no-unused-vars
  const { object3d, _transient, ...rest } = node;
  return {
    ...rest,
    children: (rest.children || []).map(stripNode),
  };
}

/**
 * Build the full project JSON from current app state.
 * Returns a plain object ready to be JSON.stringify'd.
 *
 * @returns {object}  complete project in createEmptyProject() shape
 */
export function serialize() {
  const project = createEmptyProject();

  // ── _sbs metadata ────────────────────────────────────────────────────────
  project._sbs.app_version = APP_VERSION;
  project._sbs.saved       = new Date().toISOString();

  // ── Assets ───────────────────────────────────────────────────────────────
  project.assets.items = (state.get('assets') || []).map(a => ({ ...a }));

  // ── Tree (strip object3d) ─────────────────────────────────────────────────
  const treeData = state.get('treeData');
  project.tree.root = treeData ? stripNode(treeData) : null;

  // ── Steps ────────────────────────────────────────────────────────────────
  project.steps.items = JSON.parse(JSON.stringify(state.get('steps') || []));

  // ── Chapters ─────────────────────────────────────────────────────────────
  project.chapters.items = JSON.parse(JSON.stringify(state.get('chapters') || []));

  // ── Camera views ─────────────────────────────────────────────────────────
  project.cameras.items = JSON.parse(JSON.stringify(state.get('cameraViews') || []));

  // ── Color presets + mesh assignments ─────────────────────────────────────
  project.colors.items       = JSON.parse(JSON.stringify(state.get('colorPresets') || []));
  project.colors.assignments = { ...materials.meshColorAssignments };
  project.colors.defaults    = { ...materials.meshDefaultColors };

  // ── Notes ─────────────────────────────────────────────────────────────────
  project.notes.templates = JSON.parse(JSON.stringify(state.get('noteTemplates') || []));
  project.notes.presets   = { ...(state.get('notePresets') || {}) };

  // ── Selections ────────────────────────────────────────────────────────────
  project.selections.groups       = JSON.parse(JSON.stringify(state.get('selectionGroups') || []));
  project.selections.outlineColor = state.get('selectionOutlineColor') || '#00ffff';

  // ── Animation presets ──────────────────────────────────────────────────────
  project.animationPresets.items = JSON.parse(JSON.stringify(state.get('animationPresets') || []));

  // ── Settings ──────────────────────────────────────────────────────────────
  const cfg = project.settings;
  cfg.backgroundColor      = state.get('backgroundColor')      ?? '#0f172a';
  cfg.solidOverride        = state.get('solidOverride')        ?? false;
  cfg.gridVisible          = state.get('gridVisible')          ?? true;
  cfg.cameraAnimDurationMs = state.get('cameraAnimDurationMs') ?? 1500;
  cfg.objectAnimDurationMs = state.get('objectAnimDurationMs') ?? 1500;
  cfg.cameraFillLight      = { ...(state.get('cameraFillLight') || {}) };
  cfg.geometryOutline      = { ...(state.get('geometryOutline') || {}) };
  cfg.export               = { ...(state.get('export')         || {}) };

  return project;
}


// ═══════════════════════════════════════════════════════════════════════════
//  FILE-TYPE CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const FILE_TYPES = [
  { description: 'SBS Step Browser Project', accept: { 'application/json': ['.sbsproj', '.json'] } },
];


// ═══════════════════════════════════════════════════════════════════════════
//  SAVE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Save the current project.
 *
 * @param {object}  [options]
 * @param {'auto'|'saveAs'|'overwrite'} [options.mode='auto']
 * @param {FileSystemFileHandle} [options.handle]   — FSA handle to overwrite
 * @param {string}  [options.suggestedName]         — filename hint
 * @param {string}  [options.electronPath]          — Electron: path to overwrite
 *
 * @returns {Promise<{saved:boolean, path?:string, handle?:FileSystemFileHandle, cancelled?:boolean, downloaded?:boolean}>}
 */
export async function saveProject(options = {}) {
  const {
    mode          = 'auto',
    handle        = null,
    suggestedName = getSuggestedFilename(),
    electronPath  = null,
  } = options;

  steps.flushSync();       // ensure active step snapshot is current
  steps.upsertBaseStep();  // capture scene into hidden Step 0 staging area

  const project  = serialize();
  const content  = JSON.stringify(project, null, 2);
  const filename = suggestedName.endsWith('.sbsproj')
    ? suggestedName
    : `${suggestedName.replace(/\.(json|sbsproj)$/i, '')}.sbsproj`;

  // ── Path 1: Electron IPC ─────────────────────────────────────────────────
  // 'auto'   → overwrite existing path silently; open dialog only if unsaved
  // 'saveAs' → always open dialog
  if (window.sbsNative?.saveProject) {
    const existingPath = state.get('projectPath');
    let savePath;
    if (mode === 'auto' && existingPath) {
      savePath = existingPath;          // silent overwrite — no dialog
    } else {
      savePath = electronPath || await window.sbsNative.saveProject(filename);
      if (!savePath) return { saved: false, cancelled: true };
    }
    const writeResult = await window.sbsNative.writeFile(savePath, content, 'utf-8');
    if (!writeResult?.ok) throw new Error(writeResult?.error || 'Write failed');
    _setProjectMeta(savePath);
    state.markClean();
    return { saved: true, path: savePath };
  }

  // ── Path 2: File System Access API ───────────────────────────────────────
  // 'auto'   → reuse stored handle silently; open picker only if no handle yet
  // 'saveAs' → always open picker
  if (window.showSaveFilePicker) {
    try {
      const storedHandle = state.get('fsaFileHandle');
      const saveHandle = (mode === 'auto' && storedHandle)
        ? storedHandle
        : await window.showSaveFilePicker({ suggestedName: filename, types: FILE_TYPES });
      await _writeToHandle(saveHandle, content);
      state.setState({ fsaFileHandle: saveHandle });   // persist for next auto-save
      _setProjectMeta(saveHandle.name);
      state.markClean();
      return { saved: true, handle: saveHandle };
    } catch (err) {
      if (err.name === 'AbortError') return { saved: false, cancelled: true };
      throw err;
    }
  }

  // ── Path 3: <a download> fallback ────────────────────────────────────────
  _triggerDownload(filename, content, 'application/json');
  state.markClean();
  return { saved: true, downloaded: true };
}


/**
 * Write a string to a FileSystemFileHandle.
 */
async function _writeToHandle(handle, content) {
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

/**
 * Trigger a browser download of a text file.
 */
function _triggerDownload(filename, content, mime = 'application/json') {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Update state with the current project file name/path.
 */
function _setProjectMeta(pathOrName) {
  const name = String(pathOrName || 'project.sbsproj').split(/[\\/]/).pop();
  state.setState({ projectPath: pathOrName, projectName: name });
}


// ═══════════════════════════════════════════════════════════════════════════
//  OPEN FILE PICKER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Show a file-open dialog for .sbsproj files.
 *
 * @returns {Promise<{file:File, handle?:FileSystemFileHandle, path?:string}|null>}
 */
export async function pickProjectFile() {
  // Electron — preload exposes sbsNative.openProject() → path | null
  //            and sbsNative.readFile(path, encoding) → { ok, data }
  if (window.sbsNative?.openProject) {
    const filePath = await window.sbsNative.openProject();
    if (!filePath) return null;
    const readResult = await window.sbsNative.readFile(filePath, 'utf-8');
    if (!readResult?.ok) throw new Error(readResult?.error || 'Read failed');
    const file = new File([readResult.data], filePath.split(/[\\/]/).pop(), { type: 'application/json' });
    return { file, path: filePath };
  }

  // File System Access API
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: FILE_TYPES,
        multiple: false,
      });
      const file = await handle.getFile();
      return { file, handle };
    } catch (err) {
      if (err.name === 'AbortError') return null;
      throw err;
    }
  }

  // input[type=file] fallback
  return new Promise(resolve => {
    const input    = document.createElement('input');
    input.type     = 'file';
    input.accept   = '.sbsproj,.json';
    input.onchange = () => {
      const file = input.files?.[0] || null;
      resolve(file ? { file } : null);
    };
    input.click();
  });
}


// ═══════════════════════════════════════════════════════════════════════════
//  PARSE & MIGRATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse raw JSON text into a migrated project object.
 * Handles both the new format and the legacy POC v0.2xx format.
 *
 * @param {string} text  raw file text
 * @returns {object}     project in createEmptyProject() shape
 */
export function parseProjectFile(text) {
  const raw = JSON.parse(text);

  // Legacy POC format (has projectFormat:'sbsproj' at root)
  if (raw.projectFormat === 'sbsproj') {
    return _migrateLegacyPoc(raw);
  }

  // New format — run per-section migrations
  const project = { ...raw };
  const sections = ['assets', 'tree', 'steps', 'chapters', 'cameras', 'colors', 'notes', 'selections', 'settings'];
  for (const sectionName of sections) {
    if (project[sectionName]) {
      project[sectionName] = migrateSection(sectionName, project[sectionName]);
    }
  }
  return project;
}

/**
 * Convert a legacy POC v0.2xx project to the new format.
 */
function _migrateLegacyPoc(raw) {
  const project = createEmptyProject();
  project._sbs.saved = raw.savedAt || new Date().toISOString();

  const scene = raw.scene || {};
  const cs    = scene.currentState || {};

  // Steps
  if (Array.isArray(scene.steps))        project.steps.items         = scene.steps;
  if (Array.isArray(scene.cameraViews))  project.cameras.items       = scene.cameraViews;
  if (Array.isArray(scene.noteTemplates))project.notes.templates     = scene.noteTemplates;
  if (Array.isArray(scene.selectionGroups)) project.selections.groups = scene.selectionGroups;

  // Color presets
  if (Array.isArray(cs.colorPresets))    project.colors.items = cs.colorPresets;

  // Settings
  if (cs.backgroundColor)               project.settings.backgroundColor      = cs.backgroundColor;
  if (cs.showGrid !== undefined)         project.settings.gridVisible          = cs.showGrid;
  if (cs.overrideMode !== undefined)     project.settings.solidOverride        = !!cs.overrideMode;
  if (cs.selectionOutlineColor)          project.selections.outlineColor       = cs.selectionOutlineColor;
  if (cs.cameraAnimDuration != null)     project.settings.cameraAnimDurationMs = cs.cameraAnimDuration;
  if (cs.objectAnimDuration != null)     project.settings.objectAnimDurationMs = cs.objectAnimDuration;

  project.settings.cameraFillLight = {
    enabled:   !!cs.cameraFillLightEnabled,
    color:     _hexOrDefault(cs.cameraFillLightColor,  '#ffffff'),
    intensity: _clamp(cs.cameraFillLightIntensity, 0, 20, 1.1),
    distance:  _clamp(cs.cameraFillLightDistance,  0, 1e6, 0),
    decay:     _clamp(cs.cameraFillLightDecay,     0, 8, 2),
    offsetX:   _clamp(cs.cameraFillLightOffsetX,   -1e5, 1e5, -120),
    offsetY:   _clamp(cs.cameraFillLightOffsetY,   -1e5, 1e5, 70),
    offsetZ:   _clamp(cs.cameraFillLightOffsetZ,   -1e5, 1e5, 140),
  };

  project.settings.geometryOutline = {
    enabled:     !!cs.globalGeometryOutlineEnabled,
    color:       _hexOrDefault(cs.globalGeometryOutlineColor, '#000000'),
    opacity:     _clamp(cs.globalGeometryOutlineOpacity, 0, 1, 0.9),
    creaseAngle: _clamp(cs.globalGeometryOutlineAngle, 1, 180, 35),
  };

  project.settings.export = {
    ...project.settings.export,
    fileName:        'sbs_export',
    outputFormat:    cs.exportOutputFormat    || 'webm_vp8',
    formatPreset:    cs.exportFormatPreset    || 'hdtv_1080',
    width:           cs.exportWidth           ?? 1920,
    height:          cs.exportHeight          ?? 1080,
    fps:             cs.exportFps             ?? 30,
    stepHoldMs:      cs.exportStepHoldDuration ?? 800,
    narrationVoice:  cs.exportNarrationVoice  || 'en_US-lessac-high',
    narrationSpeed:  cs.exportNarrationSpeed  ?? 1.0,
    narrationHelperUrl:        cs.exportNarrationHelperUrl        || 'http://127.0.0.1:8765',
    deterministicHelperUrl:    cs.exportDeterministicHelperUrl    || 'http://127.0.0.1:8766',
  };

  // Asset entries — derived from model specs
  // We stash the saved treeSpec on each asset so the caller can do ID remapping.
  if (Array.isArray(scene.models)) {
    project.assets.items = scene.models.map(m => ({
      id:           m.slotId || m.id || generateId('asset'),
      name:         m.name || 'Unnamed Model',
      type:         'model',
      originalPath: m.stepSource?.absolutePath || '',
      relativePath: m.stepSource?.relativePath || m.stepSource?.fileName || '',
      fileHash:     null,
      fileSize:     m.stepSource?.fileSize || null,
      importedAt:   new Date().toISOString(),
      // Non-standard field — preserved for ID-remap during load, stripped on re-save
      _legacyTreeSpec: m.tree || null,
    }));
  }

  return project;
}

// ── Small helpers for migration ────────────────────────────────────────────

function _clamp(v, lo, hi, def) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

function _hexOrDefault(v, def) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v || '')) ? v : def;
}


// ═══════════════════════════════════════════════════════════════════════════
//  APPLY TO STATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply all non-geometry sections of a loaded project to app state.
 * Geometry (tree, object3d links) is handled separately by the model-loader.
 *
 * @param {object} project  migrated project from parseProjectFile()
 */
export function applyProjectToState(project) {
  const s = project.settings || {};

  // ── Settings ──────────────────────────────────────────────────────────────
  state.setState({
    backgroundColor:      s.backgroundColor        ?? '#0f172a',
    solidOverride:        s.solidOverride           ?? false,
    gridVisible:          s.gridVisible             ?? true,
    cameraAnimDurationMs: s.cameraAnimDurationMs    ?? 1500,
    objectAnimDurationMs: s.objectAnimDurationMs    ?? 1500,
    cameraFillLight:      s.cameraFillLight
                            ? { ...state.get('cameraFillLight'), ...s.cameraFillLight }
                            : state.get('cameraFillLight'),
    geometryOutline:      s.geometryOutline
                            ? { ...state.get('geometryOutline'), ...s.geometryOutline }
                            : state.get('geometryOutline'),
    export:               s.export
                            ? { ...state.get('export'), ...s.export }
                            : state.get('export'),
  });

  // ── Content arrays ────────────────────────────────────────────────────────
  state.setState({
    steps:                project.steps?.items              || [],
    chapters:             project.chapters?.items           || [],
    cameraViews:          project.cameras?.items            || [],
    colorPresets:         project.colors?.items             || [],
    animationPresets:     project.animationPresets?.items   || [],
    noteTemplates:        project.notes?.templates          || [],
    notePresets:          project.notes?.presets            || state.get('notePresets'),
    selectionGroups:      project.selections?.groups        || [],
    selectionOutlineColor:project.selections?.outlineColor  || '#00ffff',
    assets:               project.assets?.items             || [],
  });

  state.markClean();
}


// ═══════════════════════════════════════════════════════════════════════════
//  ID REMAP — reconnect saved IDs to freshly-loaded geometry
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a Map<newId → savedId> by walking `liveNode` and `specNode`
 * in parallel DFS order.
 *
 * Strategy:
 *   - Nodes are matched by type + position in children array.
 *   - Mesh nodes are additionally matched by meshIndex (deterministic
 *     OCCT tessellation order ensures same file → same mesh order).
 *
 * @param {TreeNode} liveNode  freshly loaded node (new IDs)
 * @param {object}   specNode  saved tree spec (saved IDs)
 * @param {Map<string,string>} [idMap]
 * @returns {Map<string,string>}
 */
export function buildIdRemapFromSpec(liveNode, specNode, idMap = new Map()) {
  if (!liveNode || !specNode) return idMap;
  if (liveNode.type !== (specNode.type === 'group' ? 'folder' : specNode.type)) return idMap;

  idMap.set(liveNode.id, specNode.id);

  const liveChildren = liveNode.children || [];
  const specChildren = specNode.children || [];

  // Match mesh children by meshIndex (most reliable)
  const specMeshes  = specChildren.filter(c => c.type === 'mesh');
  const liveMeshes  = liveChildren.filter(c => c.type === 'mesh');

  for (const specMesh of specMeshes) {
    let liveMesh = null;
    if (specMesh.meshIndex != null) {
      liveMesh = liveMeshes.find(c => c.meshIndex === specMesh.meshIndex) ?? null;
    }
    if (!liveMesh) {
      // Fallback: positional match
      const idx = specMeshes.indexOf(specMesh);
      liveMesh  = liveMeshes[idx] ?? null;
    }
    if (liveMesh) buildIdRemapFromSpec(liveMesh, specMesh, idMap);
  }

  // Match non-mesh children (folders) by position
  const specFolders = specChildren.filter(c => c.type !== 'mesh');
  const liveFolders = liveChildren.filter(c => c.type !== 'mesh');
  specFolders.forEach((specChild, i) => {
    if (liveFolders[i]) buildIdRemapFromSpec(liveFolders[i], specChild, idMap);
  });

  return idMap;
}

/**
 * Apply an ID remap to a live node tree IN PLACE.
 * - Rewrites node.id
 * - Updates object3d.userData.meshNodeId on mesh nodes
 *
 * @param {TreeNode}             node
 * @param {Map<string,string>}   idMap   new → saved
 */
export function applyIdRemap(node, idMap) {
  if (!node) return;
  const savedId = idMap.get(node.id);
  if (savedId) {
    if (node.object3d) node.object3d.userData.meshNodeId = savedId;
    node.id = savedId;
  }
  (node.children || []).forEach(c => applyIdRemap(c, idMap));
}

/**
 * Collect every mesh spec node from an entire saved scene tree into a flat array.
 * Includes displaced meshes that live in custom folders outside their native model.
 * The returned spec objects retain all saved properties (meshIndex, sourceAssetId, …).
 *
 * @param {object|null} specRoot  saved scene root (project.tree.root)
 * @returns {object[]}  flat array of all mesh spec nodes in the tree
 */
export function collectAllMeshSpecs(specRoot) {
  const specs = [];
  function walk(node) {
    if (!node) return;
    if (node.type === 'mesh') specs.push(node);
    for (const child of (node.children || [])) walk(child);
  }
  walk(specRoot);
  return specs;
}

/**
 * Extend an existing ID remap map with entries for "displaced" meshes — meshes
 * that were moved out of their native model subtree (e.g. into a scene-root custom
 * folder) before the project was saved.
 *
 * Standard buildIdRemapFromSpec() only walks the model's own saved spec subtree and
 * therefore misses displaced meshes (they were removed from that subtree when the
 * user moved them).  This function finds those meshes in the FULL saved tree and
 * matches them to live mesh nodes by meshIndex + sourceAssetId.
 *
 * @param {TreeNode}  liveModelNode      freshly-loaded model node (pre-applyIdRemap)
 * @param {object[]}  allSavedMeshSpecs  from collectAllMeshSpecs(savedSceneRoot)
 * @param {string}    assetId            stable asset ID of the model being remapped
 * @param {Map}       idMap              Map<newId, savedId> from buildIdRemapFromSpec (mutated)
 * @returns {Map}  idMap, now including displaced-mesh entries
 */
export function buildDisplacedMeshIdRemap(liveModelNode, allSavedMeshSpecs, assetId, idMap) {
  if (!liveModelNode || !allSavedMeshSpecs?.length) return idMap;

  // Collect live mesh nodes from this model that were NOT remapped by the standard path.
  const unmappedLive = [];
  function collectUnmapped(node) {
    if (node.type === 'mesh' && !idMap.has(node.id)) unmappedLive.push(node);
    (node.children || []).forEach(collectUnmapped);
  }
  collectUnmapped(liveModelNode);
  if (!unmappedLive.length) return idMap;

  // Saved mesh IDs that are already claimed — don't double-match.
  const claimedSavedIds = new Set(idMap.values());

  // Filter saved mesh specs to candidates for this model's displaced meshes:
  //   1. Not already matched by a previous remap.
  //   2. Tagged with this model's assetId (via sourceAssetId set during load).
  //   3. Legacy fallback: accept untagged specs (old project files — may be
  //      ambiguous in multi-model projects but correct for single-model ones).
  const candidates = allSavedMeshSpecs.filter(spec => {
    if (claimedSavedIds.has(spec.id)) return false;
    // sourceAssetId required — meshIndex values overlap across models so we
    // cannot safely match without knowing which model a displaced spec belongs to.
    // Old project files without sourceAssetId simply skip displaced remap (they
    // load correctly via the standard in-subtree remap path).
    return spec.sourceAssetId === assetId;
  });
  if (!candidates.length) return idMap;

  // Match by meshIndex (deterministic OCCT tessellation order).
  for (const live of unmappedLive) {
    if (live.meshIndex == null) continue; // non-OCCT mesh — no reliable index
    const idx = candidates.findIndex(spec => spec.meshIndex === live.meshIndex);
    if (idx < 0) continue;
    const match = candidates[idx];
    idMap.set(live.id, match.id);
    claimedSavedIds.add(match.id);
    candidates.splice(idx, 1); // prevent double-claiming the same saved spec
  }

  return idMap;
}

/**
 * After remapping, apply saved fields from a spec back onto the live nodes:
 * names, transforms, visibility, colorPresetId.
 *
 * @param {object}               specNode  saved node (with saved IDs)
 * @param {Map<string,TreeNode>} nodeById  live map (already has remapped IDs)
 */
export function applySpecFieldsToNodes(specNode, nodeById) {
  if (!specNode) return;
  const live = nodeById.get(specNode.id);
  if (live) {
    live.name         = specNode.name        || live.name;
    live.localVisible = specNode.localVisible !== false;

    if (Array.isArray(specNode.localOffset))          live.localOffset          = specNode.localOffset;
    if (Array.isArray(specNode.localQuaternion))       live.localQuaternion       = specNode.localQuaternion;
    if (Array.isArray(specNode.orientationSteps))      live.orientationSteps      = specNode.orientationSteps;
    if (Array.isArray(specNode.pivotLocalOffset))      live.pivotLocalOffset      = specNode.pivotLocalOffset;
    if (Array.isArray(specNode.pivotLocalQuaternion))  live.pivotLocalQuaternion  = specNode.pivotLocalQuaternion;
    if (specNode.moveEnabled   !== undefined)          live.moveEnabled           = !!specNode.moveEnabled;
    if (specNode.rotateEnabled !== undefined)          live.rotateEnabled         = !!specNode.rotateEnabled;
    if (specNode.pivotEnabled  !== undefined)          live.pivotEnabled          = !!specNode.pivotEnabled;
    live.colorPresetId = specNode.colorPresetId || null;
  }
  (specNode.children || []).forEach(sc => applySpecFieldsToNodes(sc, nodeById));
}


// ═══════════════════════════════════════════════════════════════════════════
//  MAIN LOAD ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load a project from a File object or raw JSON text.
 *
 * WHAT THIS DOES:
 *   1. Parses + migrates the project JSON.
 *   2. Applies non-geometry state (steps, settings, colors …) to app state.
 *   3. Returns the project data + a resolved-asset list for the caller to
 *      use when loading geometry.
 *
 * WHAT THE CALLER (main.js) MUST DO AFTER:
 *   For each asset in `result.assets`:
 *     a) Read the file from `resolvedPath`
 *     b) Call importers.loadModelBuffer(buffer, name, assetEntry)
 *     c) After load, call buildIdRemapFromSpec + applyIdRemap + applySpecFieldsToNodes
 *        using `assetEntry._legacyTreeSpec` (legacy) or the saved tree.root (new format)
 *     d) Rebuild state.nodeById
 *
 * @param {File|string} fileOrText
 * @param {string}      [filePath]  absolute path (Electron) for relative-path resolution
 * @returns {Promise<{project:object, assets:Array<{assetEntry:object, resolvedPath:string|null}>}>}
 */
export async function loadProject(fileOrText, filePath = null) {
  const text    = typeof fileOrText === 'string' ? fileOrText : await fileOrText.text();
  const project = parseProjectFile(text);

  applyProjectToState(project);

  if (filePath) _setProjectMeta(filePath);

  // Build resolved-asset list for caller
  const assets = (project.assets?.items || []).map(assetEntry => ({
    assetEntry,
    resolvedPath: resolveAssetPath(assetEntry, filePath),
  }));

  // Emit so the app can show "loading models…" UI
  state.emit('project:loaded', { project, assets });

  return { project, assets };
}


// ═══════════════════════════════════════════════════════════════════════════
//  ASSET PATH RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve an asset's file path to an absolute path.
 *
 * Resolution order:
 *   1. relativePath relative to the project file's directory
 *   2. originalPath (absolute, may have moved)
 *
 * @param {object}      asset
 * @param {string|null} projectFilePath
 * @returns {string|null}
 */
export function resolveAssetPath(asset, projectFilePath = null) {
  if (!projectFilePath) return asset.originalPath || null;

  // Directory containing the .sbsproj file
  const projectDir = projectFilePath.replace(/[\\/][^\\/]*$/, '');

  if (asset.relativePath) {
    const rel = asset.relativePath.replace(/\\/g, '/');
    // Simple join — keep the platform separator the OS prefers
    const sep = projectFilePath.includes('\\') ? '\\' : '/';
    return projectDir + sep + rel.replace(/\//g, sep);
  }

  return asset.originalPath || null;
}

/**
 * Compute the relative path of `assetPath` from `projectFilePath`'s directory.
 *
 * @param {string} assetPath       absolute path to the asset
 * @param {string} projectFilePath absolute path to the .sbsproj file
 * @returns {string}  relative path using forward slashes
 */
export function makeRelativePath(assetPath, projectFilePath) {
  if (!assetPath || !projectFilePath) return assetPath || '';

  const normalize = p => p.replace(/\\/g, '/').replace(/\/+/g, '/');
  const projDir   = normalize(projectFilePath).replace(/\/[^/]*$/, '');
  const asset     = normalize(assetPath);

  // Find common prefix
  const projParts  = projDir.split('/');
  const assetParts = asset.split('/');
  let common = 0;
  while (common < projParts.length && common < assetParts.length
         && projParts[common].toLowerCase() === assetParts[common].toLowerCase()) {
    common++;
  }

  const ups  = projParts.length - common;
  const down = assetParts.slice(common);
  return [...Array(ups).fill('..'), ...down].join('/') || '.';
}


// ═══════════════════════════════════════════════════════════════════════════
//  SUGGESTED FILENAME
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a suggested save filename from current state.
 *
 * @returns {string}  e.g. 'motor_assembly.sbsproj'
 */
export function getSuggestedFilename() {
  const name = state.get('projectName');
  if (name && name !== 'Untitled') {
    return name.endsWith('.sbsproj') ? name : `${name.replace(/\.sbsproj$/i, '')}.sbsproj`;
  }
  const assets = state.get('assets') || [];
  if (assets.length > 0) {
    const base = (assets[0].name || 'project')
      .replace(/\.(step|stp|iges|igs|brep|obj|stl|gltf|glb)$/i, '');
    return `${base}.sbsproj`;
  }
  return 'project.sbsproj';
}


// ═══════════════════════════════════════════════════════════════════════════
//  SINGLETON EXPORT
// ═══════════════════════════════════════════════════════════════════════════

export const project = {
  serialize,
  saveProject,
  loadProject,
  pickProjectFile,
  parseProjectFile,
  applyProjectToState,
  buildIdRemapFromSpec,
  collectAllMeshSpecs,
  buildDisplacedMeshIdRemap,
  applyIdRemap,
  applySpecFieldsToNodes,
  resolveAssetPath,
  makeRelativePath,
  getSuggestedFilename,
};

export default project;
