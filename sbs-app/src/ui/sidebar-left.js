/**
 * SBS Step Browser — Left Sidebar
 * ==================================
 * Manages #sidebar-left-content.
 * Tabs: Files | Tree | Colors | Cameras | Export
 */

import { state }           from '../core/state.js';
import { steps }           from '../systems/steps.js';
import { materials }       from '../systems/materials.js';
import * as actions        from '../systems/actions.js';
import { sceneCore }       from '../core/scene.js';
import { loadModelFile }   from '../io/importers.js';
import { showAssetVerifyDialog } from './asset-verify.js';
import {
  saveProject, loadProject, pickProjectFile, getSuggestedFilename,
  buildIdRemapFromSpec, applyIdRemap, applySpecFieldsToNodes,
  collectAllMeshSpecs, buildDisplacedMeshIdRemap,
}                          from '../io/project.js';
import { initTree, renderTree, expandPathToNode, collapseAll } from './tree.js';
import { setStatus }       from './status.js';
import { createCameraView, generateId, APP_VERSION, APP_RELEASED } from '../core/schema.js';
import { buildNodeMap }    from '../core/nodes.js';
import { applyNodeSourceTransformToObject3D } from '../core/transforms.js';
import { showContextMenu } from './context-menu.js';
import { renderAnimationTab } from './animation-tab.js';
import { renderHeaderTab }    from './header-tab.js';
import { renderStyleTab }     from './style-tab.js';
import { renderCableTab }     from './cable-tab.js';
import { exportTimelineVideo, downloadBlob } from '../systems/video-export.js';
import { listVoices as ttsListVoices } from '../systems/tts.js';
import * as userSettings    from '../core/user-settings.js';
import * as narrationCache  from '../systems/narration-cache.js';

const TABS = ['files', 'tree', 'colors', 'select', 'cameras', 'animation', 'header', 'style', 'cables', 'export'];
let _activeTab   = 'files';
let _container   = null;
let _treeInited  = false;
const _assetStatus   = new Map();   // assetId → 'ok' | 'missing'
const _phantomNodes  = new Map();   // assetId → phantom tree node (for relink)

// ── Init ─────────────────────────────────────────────────────────────────────

export function initSidebarLeft() {
  _container = document.getElementById('sidebar-left-content');
  if (!_container) return;

  _container.innerHTML = `
    <div class="tabBar" id="left-tab-bar">
      <button class="tabBtn active" data-tab="files">Files</button>
      <button class="tabBtn"        data-tab="tree">Tree</button>
      <button class="tabBtn"        data-tab="colors">Colors</button>
      <button class="tabBtn"        data-tab="select">Select</button>
      <button class="tabBtn"        data-tab="cameras">Cameras</button>
      <button class="tabBtn"        data-tab="animation">Anim</button>
      <button class="tabBtn"        data-tab="header">Header</button>
      <button class="tabBtn"        data-tab="style">Style</button>
      <button class="tabBtn"        data-tab="cables">🔌</button>
      <button class="tabBtn"        data-tab="export">Export</button>
    </div>
    <div class="sidebar-panels" id="left-panels"></div>
  `;

  const panelsEl = _container.querySelector('#left-panels');
  for (const tab of TABS) {
    const div        = document.createElement('div');
    div.className    = `tabPanel${tab === _activeTab ? ' active' : ''}`;
    div.id           = `tab-panel-${tab}`;
    div.dataset.tab  = tab;
    panelsEl.appendChild(div);
  }

  _container.querySelector('#left-tab-bar').addEventListener('click', e => {
    const btn = e.target.closest('.tabBtn');
    if (btn) _switchTab(btn.dataset.tab);
  });

  // State subscriptions
  state.on('change:assets',                () => { if (_activeTab === 'files')   _renderFilesTab(); });
  state.on('change:treeData',              () => { if (_activeTab === 'tree')    renderTree(); });
  state.on('change:colorPresets',          () => { if (_activeTab === 'colors')  _renderColorsTab(); });
  state.on('materials:defaultColorsChanged',() => { if (_activeTab === 'colors')  _renderColorsTab(); });
  state.on('change:selectedId',            () => { if (_activeTab === 'colors')  _renderColorsTab(); });
  state.on('change:multiSelectedIds',      () => { if (_activeTab === 'colors')  _renderColorsTab(); });
  state.on('change:cameraViews',           () => { if (_activeTab === 'cameras')   _renderCamerasTab(); });
  // Step bindings live on step.cameraBinding — when the active step
  // changes, or when any step's binding updates, the Cameras tab needs
  // to re-render so the "used by N steps" + "active-bound" indicators
  // stay accurate.
  state.on('change:activeStepId',          () => { if (_activeTab === 'cameras')   _renderCamerasTab(); });
  state.on('change:steps',                 () => { if (_activeTab === 'cameras')   _renderCamerasTab(); });
  state.on('change:projectDirty',          () => { if (_activeTab === 'files')    _renderFilesTab(); });
  state.on('change:selectionOutlineColor', () => { if (_activeTab === 'select')   _renderSelectTab(); });
  state.on('change:animationPresets',      () => { if (_activeTab === 'animation') _renderAnimTab(); });
  state.on('change:headerItems',           () => {
    if (_activeTab === 'header') _renderHeaderTabPanel();
    if (_activeTab === 'style')  _renderStyleTabPanel();   // Save button enable
  });
  state.on('change:headersHidden',         () => { if (_activeTab === 'header')    _renderHeaderTabPanel(); });
  state.on('change:headersLocked',         () => { if (_activeTab === 'header')    _renderHeaderTabPanel(); });
  state.on('change:headerDefault',         () => { if (_activeTab === 'header')    _renderHeaderTabPanel(); });
  state.on('change:headerStepNumberPerChapter', () => { if (_activeTab === 'header') _renderHeaderTabPanel(); });
  // C3/D: cable tab refreshes on cables list change, placement, and on
  // cable-point selection (so the editor's per-point list highlights).
  state.on('change:cables',              () => { if (_activeTab === 'cables') _renderCableTabPanel(); });
  state.on('change:cablePlacingId',      () => { if (_activeTab === 'cables') _renderCableTabPanel(); });
  state.on('change:selectedCablePoint',  () => { if (_activeTab === 'cables') _renderCableTabPanel(); });
  state.on('change:selectedCableSocket', () => { if (_activeTab === 'cables') _renderCableTabPanel(); });
  state.on('change:cableGlobalRadius',   () => { if (_activeTab === 'cables') _renderCableTabPanel(); });
  state.on('change:cableHighlightColor', () => { if (_activeTab === 'cables') _renderCableTabPanel(); });
  state.on('change:styleTemplates',        () => {
    if (_activeTab === 'style')  _renderStyleTabPanel();
    if (_activeTab === 'header') _renderHeaderTabPanel();   // P4b: row dropdowns refresh + Save button enable
  });
  state.on('styleTemplate:updated',        () => {
    if (_activeTab === 'style')  _renderStyleTabPanel();
    if (_activeTab === 'header') _renderHeaderTabPanel();   // P4b: dropdown option labels refresh on rename
  });
  state.on('styleTemplate:removed',        () => {
    if (_activeTab === 'style')  _renderStyleTabPanel();
    if (_activeTab === 'header') _renderHeaderTabPanel();   // P4b: drop the removed template's option
  });

  _renderActiveTab();

  // ── Electron native menu → renderer ──────────────────────────────────────
  if (window.sbsNative?.onMenu) {
    window.sbsNative.onMenu('menu:newProject',    _onNewProject);
    window.sbsNative.onMenu('menu:openProject',   _onOpenProject);
    window.sbsNative.onMenu('menu:saveProject',   () => _onSaveProject(false));
    window.sbsNative.onMenu('menu:saveProjectAs', () => _onSaveProject(true));
    window.sbsNative.onMenu('menu:browseAssets',  _onBrowseAssets);
  }
}

function _switchTab(tab) {
  if (!TABS.includes(tab) || tab === _activeTab) return;
  _activeTab = tab;
  _container.querySelectorAll('.tabBtn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  _container.querySelectorAll('.tabPanel').forEach(p =>
    p.classList.toggle('active', p.dataset.tab === tab));
  _renderActiveTab();
}

function _panel(tab) { return document.getElementById(`tab-panel-${tab}`); }

function _renderActiveTab() {
  switch (_activeTab) {
    case 'files':     _renderFilesTab();   break;
    case 'tree':      _renderTreeTab();    break;
    case 'colors':    _renderColorsTab();  break;
    case 'select':    _renderSelectTab();  break;
    case 'cameras':   _renderCamerasTab(); break;
    case 'animation': _renderAnimTab();    break;
    case 'header':    _renderHeaderTabPanel(); break;
    case 'style':     _renderStyleTabPanel();  break;
    case 'cables':    _renderCableTabPanel();  break;
    case 'export':    _renderExportTab();  break;
  }
}

function _renderAnimTab() {
  renderAnimationTab(_panel('animation'));
}

function _renderHeaderTabPanel() {
  renderHeaderTab(_panel('header'));
}

function _renderStyleTabPanel() {
  renderStyleTab(_panel('style'));
}

function _renderCableTabPanel() {
  renderCableTab(_panel('cables'));
}


// ═══════════════════════════════════════════════════════════════════════════
//  FILES TAB
// ═══════════════════════════════════════════════════════════════════════════

function _renderFilesTab() {
  const el = _panel('files');
  if (!el) return;

  const assets   = state.get('assets') || [];
  const dirty    = state.get('projectDirty');
  const projName = state.get('projectName') || 'Untitled';

  el.innerHTML = `
    <div class="section">
      <div class="title">Project</div>
      <div class="filename" style="font-size:16px">${_esc(projName)}${dirty ? ' <span style="font-size:12px;color:#fdba74">unsaved</span>' : ''}</div>
      <div class="grid2" style="margin-top:8px">
        <button class="btn" id="btn-new-project">New</button>
        <button class="btn" id="btn-open-project">Open…</button>
        <button class="btn" id="btn-save-project">Save</button>
        <button class="btn" id="btn-save-as">Save As…</button>
      </div>
    </div>

    <div class="section">
      <div class="title">Load Model</div>
      <label class="filelabel" style="margin-top:8px;display:flex">
        Load STEP / OBJ / STL / GLTF / FBX
        <input type="file" id="model-file-input"
               accept=".step,.stp,.iges,.igs,.brep,.obj,.stl,.gltf,.glb,.fbx" multiple />
      </label>
    </div>

    <div class="section">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div class="title">Assets (${assets.length})</div>
        ${assets.length > 0 ? `<button class="btn" id="btn-browse-assets" style="font-size:11px;padding:3px 8px">Browse All…</button>` : ''}
      </div>
      <div id="asset-list" style="margin-top:6px">${
        assets.length === 0
          ? '<span class="small muted">No assets loaded.</span>'
          : assets.map((a, i) => {
              const st  = _assetStatus.get(a.id) || 'ok';
              const ico = st === 'ok' ? '✅' : st === 'warning' ? '⚠️' : '❌';
              return `
              <div class="card" style="margin-top:6px;padding:8px;display:flex;align-items:center;gap:8px">
                <span style="font-size:13px;flex-shrink:0">${ico}</span>
                <span class="small" title="${_esc(a.originalPath || a.name)}" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(a.name)}</span>
                <button class="btn" data-browse-asset="${i}" style="font-size:11px;padding:3px 8px;flex-shrink:0">Browse…</button>
              </div>`;
            }).join('')
      }</div>
    </div>

    <div class="section">
      <div class="title">View</div>
      <div class="grid3" style="margin-top:8px">
        <button class="btn" id="btn-fit-all">Fit All</button>
        <button class="btn" id="btn-toggle-grid">Grid</button>
        <button class="btn" id="btn-toggle-theme">Theme</button>
      </div>
    </div>

    <div class="section" style="margin-top:auto;padding-top:12px">
      <div class="small muted" style="text-align:center;line-height:1.6">
        SBS ${_esc(APP_VERSION)}<br>
        <span style="font-size:10px">${_esc(APP_RELEASED)}</span>
      </div>
    </div>
  `;

  el.querySelector('#btn-new-project')?.addEventListener('click', _onNewProject);
  el.querySelector('#btn-open-project')?.addEventListener('click', _onOpenProject);
  el.querySelector('#btn-save-project')?.addEventListener('click', () => _onSaveProject(false));
  el.querySelector('#btn-save-as')?.addEventListener('click',      () => _onSaveProject(true));
  el.querySelector('#btn-fit-all')?.addEventListener('click',      _onFitAll);
  el.querySelector('#btn-toggle-grid')?.addEventListener('click',  _onToggleGrid);
  el.querySelector('#btn-toggle-theme')?.addEventListener('click', _onToggleTheme);

  el.querySelector('#model-file-input')?.addEventListener('change', e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const f of files) _loadModelFile(f);
  });

  el.querySelector('#btn-browse-assets')?.addEventListener('click', _onBrowseAssets);

  el.querySelectorAll('[data-browse-asset]').forEach(btn => {
    const idx   = parseInt(btn.dataset.browseAsset);
    const asset = (state.get('assets') || [])[idx];
    if (!asset) return;
    btn.addEventListener('click', () => _onBrowseSingleAsset(asset));
  });
}

// ── Files actions ─────────────────────────────────────────────────────────────

function _onNewProject() {
  if (state.get('projectDirty') && !confirm('Discard unsaved changes and start a new project?')) return;
  // Clear Three.js scene
  if (sceneCore.rootGroup) {
    while (sceneCore.rootGroup.children.length) {
      sceneCore.rootGroup.remove(sceneCore.rootGroup.children[0]);
    }
  }
  steps.object3dById.clear();
  steps.meshById.clear();
  state.setState({
    projectPath: null, projectName: 'Untitled', projectDirty: false,
    assets: [], treeData: null, nodeById: new Map(),
    steps: [], chapters: [], activeStepId: null,
    cameraViews: [], colorPresets: [], selectedId: null,
    multiSelectedIds: new Set(),
  });
  setStatus('New project.');
}

async function _onOpenProject() {
  if (state.get('projectDirty') && !confirm('Open a project? Unsaved changes will be lost.')) return;
  try {
    const picked = await pickProjectFile();
    if (!picked) return;

    const { file, path = null } = picked;

    // Clear existing scene before loading new project
    if (sceneCore.rootGroup) {
      while (sceneCore.rootGroup.children.length) {
        sceneCore.rootGroup.remove(sceneCore.rootGroup.children[0]);
      }
    }
    steps.object3dById.clear();
    steps.meshById.clear();
    materials.meshById.clear();
    materials.originalMaterials.clear();
    materials.meshColorAssignments = {};
    materials.meshDefaultColors    = {};
    state.setState({ treeData: null, nodeById: new Map() });

    // Clear stale asset status before new project loads
    _assetStatus.clear();
    _phantomNodes.clear();

    const { project, assets: resolvedAssets } = await loadProject(file, path);

    // Pre-mark all assets missing — updated to 'ok' as each model loads successfully
    for (const { assetEntry } of resolvedAssets) {
      _assetStatus.set(assetEntry.id, 'missing');
    }
    if (_activeTab === 'files') _renderFilesTab();

    // Saved scene tree — used for ID remapping after model loads
    const savedSceneRoot = project.tree?.root;
    const isElectron     = !!window.sbsNative?.isElectron;

    // If project was saved before asset-tracking: assets list is empty but tree has models.
    // Synthesize asset entries from tree model nodes so the dialog can fire.
    if (resolvedAssets.length === 0 && savedSceneRoot?.children?.length) {
      savedSceneRoot.children
        .filter(n => n.type === 'model')
        .forEach(n => {
          resolvedAssets.push({
            assetEntry: {
              id:           generateId('asset'),
              name:         n.name || 'Unknown model',
              type:         'model',
              originalPath: '',
              relativePath: '',
            },
            resolvedPath: null,
          });
        });
    }

    // Asset verification — shows dialog on web or when paths are missing.
    // Resolves with Map<assetId, File> for user-provided files.
    let userFiles = new Map();
    if (resolvedAssets.length > 0) {
      try {
        userFiles = await showAssetVerifyDialog(resolvedAssets, isElectron);
      } catch (err) {
        if (err?.message === 'cancelled') { setStatus('Project load cancelled.'); return; }
        console.error('Asset verify error:', err);
        // Continue load — treat as no user files provided
      }
    }

    // Collect ALL saved mesh specs once (used for displaced-mesh remap below).
    // Displaced meshes are those moved into custom folders outside their native model subtree.
    const allSavedMeshSpecs = collectAllMeshSpecs(savedSceneRoot);

    // Model-type spec nodes only — skip custom user-created folders at scene root.
    // Previously the code used a positional index over ALL children which broke if
    // any custom folder lived at scene root level before the model nodes.
    const savedModelSpecs = (savedSceneRoot?.children || []).filter(c => c.type === 'model');

    let modelSpecIndex = 0;

    for (const { assetEntry, resolvedPath } of resolvedAssets) {
      setStatus(`Loading ${assetEntry.name}…`, 'info', 0);
      let modelNode = null;

      const userFile = userFiles.get(assetEntry.id);

      if (userFile) {
        // User-provided via dialog (web re-link or Electron re-link)
        modelNode = await _loadModelFile(userFile, assetEntry, true);
      } else if (isElectron && resolvedPath && window.sbsNative?.readFile) {
        // Electron auto-load from saved path. Use the 'buffer' encoding
        // so IPC marshals raw bytes as a Uint8Array — for large OBJs
        // (200+ MB) the legacy base64 + atob + charCodeAt loop blew
        // the renderer heap (string × 4/3 + decoded copy + per-char
        // mapper allocations cascaded into "invalid array length").
        const result = await window.sbsNative.readFile(resolvedPath, 'buffer');
        if (result?.ok) {
          // result.data is already a Uint8Array (Buffer over IPC).
          modelNode = await _loadModelFile(new File([result.data], assetEntry.name), assetEntry, true);
        }
      }

      // Track asset status
      _assetStatus.set(assetEntry.id, modelNode ? 'ok' : 'missing');

      // Find the saved spec node for this model (only among model-type children,
      // not custom folders).  Fall back to legacy per-asset tree spec.
      const specNode = savedModelSpecs[modelSpecIndex]
                    ?? assetEntry._legacyTreeSpec
                    ?? null;

      if (modelNode) {
        // Remap freshly-generated IDs → saved IDs from project spec.
        if (specNode) {
          const idMap = buildIdRemapFromSpec(modelNode, specNode);

          // Also remap "displaced" meshes: those moved to custom folders and therefore
          // absent from specNode's subtree.  Matched by meshIndex + sourceAssetId.
          buildDisplacedMeshIdRemap(modelNode, allSavedMeshSpecs, assetEntry.id, idMap);

          applyIdRemap(modelNode, idMap);
          materials.remapMeshIds(idMap);
          for (const [newId, savedId] of idMap) {
            if (newId === savedId) continue;
            if (steps.object3dById.has(newId)) {
              steps.object3dById.set(savedId, steps.object3dById.get(newId));
              steps.object3dById.delete(newId);
            }
          }
          const root    = state.get('treeData');
          const nodeById = buildNodeMap(root);
          state.setState({ nodeById });
          applySpecFieldsToNodes(specNode, nodeById);
          // Re-bake the saved source transform onto the freshly-imported
          // (unbaked) geometry. applySpecFieldsToNodes wrote the saved
          // sourceLocal* values onto the live model node — now apply them.
          const liveModel = nodeById.get(modelNode.id);
          if (liveModel?.type === 'model') {
            const outer = steps.object3dById.get(liveModel.id) ?? liveModel.object3d;
            applyNodeSourceTransformToObject3D(liveModel, outer, steps.object3dById);
          }
        }
      } else if (specNode) {
        // ❌ Missing asset — insert phantom tree nodes from saved spec so steps still work
        _insertPhantomNodes(specNode, assetEntry.id);
      }

      modelSpecIndex++;
    }

    // Insert phantom nodes for any scene-root custom folders from the saved tree
    // that aren't yet in the live tree (they contain displaced meshes and need to
    // exist so rebuildFromTreeSpec can reparent the correctly-remapped live meshes
    // into them when the first step is activated).
    _insertPhantomCustomFolders(savedSceneRoot);

    // Restore saved color assignments + defaults (base state before any step)
    const savedDefaults    = project.colors?.defaults    || {};
    const savedAssignments = project.colors?.assignments || savedDefaults;
    materials.meshDefaultColors    = { ...savedDefaults };
    materials.meshColorAssignments = { ...savedAssignments };
    materials.applyAll();

    // Stage scene from Step 0 (exact saved scene state), then activate first user step
    steps.activateBaseStep();

    const userSteps = (state.get('steps') || []).filter(s => !s.isBaseStep && !s.hidden);
    if (userSteps.length) {
      steps.activateStep(userSteps[0].id, false);
    }

    setStatus(`Opened: ${state.get('projectName')}.`);
  } catch (err) {
    console.error('Open project failed:', err);
    setStatus('Failed to open project.', 'danger');
  }
}

async function _onSaveProject(forceDialog = false) {
  try {
    const result = await saveProject({
      mode: forceDialog ? 'saveAs' : 'auto',
      suggestedName: getSuggestedFilename(),
    });
    if (result.saved) setStatus(`Saved: ${state.get('projectName')}.`);
    else if (!result.cancelled) setStatus('Save failed.', 'danger');
  } catch (err) {
    console.error('Save failed:', err);
    setStatus('Save failed.', 'danger');
  }
}

async function _loadModelFile(file, assetEntry = null, skipColorExtraction = false) {
  setStatus(`Loading ${file.name}…`, 'info', 0);
  try {
    const modelNode = await loadModelFile(file, { assetEntry, skipColorExtraction });
    setStatus(`Loaded ${file.name}.`);
    state.markDirty();

    if (modelNode && !assetEntry) {
      // assetEntry is set only during project reload — skip auto-step logic then.
      const existingSteps = state.get('steps') || [];
      if (existingSteps.length === 0) {
        // First model ever → auto-create first step so the scene is never stepless
        steps.createStepFromCurrent('Step 1');
      } else {
        // Additional model → backfill into every existing step so switching
        // steps never removes the new model from the scene.
        steps.injectModelIntoAllSteps(modelNode);
      }
    }

    if (assetEntry?.id) {
      _assetStatus.set(assetEntry.id, 'ok');
      if (_activeTab === 'files') _renderFilesTab();
    }
    return modelNode ?? null;
  } catch (err) {
    console.error('Model load error:', err);
    setStatus(`Failed to load ${file.name}: ${err.message}`, 'danger');
    if (assetEntry?.id) {
      _assetStatus.set(assetEntry.id, 'missing');
      if (_activeTab === 'files') _renderFilesTab();
    }
    return null;
  }
}

// ── Phantom nodes for missing assets ─────────────────────────────────────────

function _cloneSpecAsPhantom(specNode) {
  const node = {
    id:                specNode.id,
    name:              specNode.name || 'Unknown',
    type:              specNode.type || 'folder',
    missing:           true,
    localVisible:      specNode.localVisible !== false,
    object3d:          null,
    // Geometry bounds — used to render a bounding-box placeholder in the scene
    // so missing objects have a real, visible, interactive stand-in.
    bbox:              specNode.bbox              ?? null,
    // Saved color — applied as outline tint on the placeholder box.
    colorPresetId:     specNode.colorPresetId     ?? null,
    // Fields needed for ID remapping and displaced-mesh tracking on relink.
    meshIndex:         specNode.meshIndex         ?? null,
    sourceAssetId:     specNode.sourceAssetId     ?? null,
    baseLocalPosition: specNode.baseLocalPosition ?? [0, 0, 0],
    baseLocalScale:    specNode.baseLocalScale    ?? [1, 1, 1],
    children:          (specNode.children || []).map(_cloneSpecAsPhantom),
  };
  return node;
}

function _insertPhantomNodes(specNode, assetId) {
  const phantom = _cloneSpecAsPhantom(specNode);

  // If no models have loaded yet (all assets missing), treeData is null and
  // the original code would return early — no phantoms ever created.
  // Create a minimal scene root so phantoms have somewhere to live.
  let root = state.get('treeData');
  if (!root) {
    root = {
      id:       'scene_root',
      name:     'Scene',
      type:     'scene',
      children: [],
      object3d: sceneCore.rootGroup,
      localVisible: true,
    };
    steps.object3dById.set('scene_root', sceneCore.rootGroup);
  }

  root.children = root.children || [];
  root.children.push(phantom);
  const nodeById = buildNodeMap(root);
  state.setState({ treeData: { ...root }, nodeById });
  if (assetId) _phantomNodes.set(assetId, phantom);
}

/**
 * Insert phantom nodes for any scene-root custom folders saved in the project
 * that don't yet exist in the live tree (because they contain displaced meshes
 * from models that are either still loading or missing).
 *
 * Call once after ALL models have loaded and been remapped, passing the full
 * saved scene root so we can find custom folders (non-model children of scene root).
 *
 * @param {object|null} savedSceneRoot  project.tree.root
 */
function _insertPhantomCustomFolders(savedSceneRoot) {
  if (!savedSceneRoot) return;
  const root = state.get('treeData');
  if (!root) return;

  const nodeById = state.get('nodeById') || new Map();
  let changed = false;

  for (const child of (savedSceneRoot.children || [])) {
    // Only non-model scene-root children (custom folders).
    if (child.type === 'model') continue;
    // Skip if already in the live tree (could have been reconstructed by a step).
    if (nodeById.has(child.id)) continue;

    // Insert as phantom — meshes inside may already have live counterparts
    // (correctly remapped), in which case rebuildFromTreeSpec will reuse them.
    const phantom = _cloneSpecAsPhantom(child);
    root.children.push(phantom);
    changed = true;
  }

  if (changed) {
    const newNodeById = buildNodeMap(root);
    state.setState({ treeData: { ...root }, nodeById: newNodeById });
  }
}

// ── Browse assets (relink) ────────────────────────────────────────────────────

async function _onBrowseAssets() {
  const assets = state.get('assets') || [];
  if (!assets.length) return;
  const isElectron = !!window.sbsNative?.isElectron;
  const entries = assets.map(a => ({ assetEntry: a, resolvedPath: a.originalPath || null }));
  let userFiles;
  try {
    userFiles = await showAssetVerifyDialog(entries, isElectron, { forceShow: true });
  } catch { return; }

  for (const [assetId, file] of userFiles) {
    const asset = assets.find(a => a.id === assetId);
    if (asset) await _relinkAsset(file, asset);
  }
  _renderFilesTab();
}

async function _onBrowseSingleAsset(asset) {
  const isElectron = !!window.sbsNative?.isElectron;
  const entries = [{ assetEntry: asset, resolvedPath: asset.originalPath || null }];
  let userFiles;
  try {
    userFiles = await showAssetVerifyDialog(entries, isElectron, { forceShow: true });
  } catch { return; }

  for (const [assetId, file] of userFiles) {
    if (assetId === asset.id) await _relinkAsset(file, asset);
  }
  _renderFilesTab();
}

/**
 * Relink a previously-missing asset:
 * 1. Load file
 * 2. Remap new IDs → saved IDs (via phantom node)
 * 3. Remove phantom from tree (surgical nodeById update)
 * 4. Reinstate from frame 0 — apply base step to establish clean ground-truth
 *    scene state, then re-apply the user's active step on top.
 *
 * WHY frame 0 first:
 *   After _loadModelFile, the Three.js scene is in a mixed state — the live
 *   model sits at file-default position while stale phantom folder groups from
 *   earlier step navigation may still occupy object3dById.  Jumping straight to
 *   activateStep tries to patch this inconsistent state and produces wrong
 *   placements.  activateBaseStep() runs a full cleanupFolderGroups +
 *   rebuildFromTreeSpec + applyAllTransforms cycle from the authoritative base
 *   snapshot, giving every subsequent activateStep a clean, known-good
 *   foundation to build on.
 */
async function _relinkAsset(file, assetEntry) {
  // Capture active step BEFORE any async work so we restore the right step.
  const activeStep = state.get('activeStepId');
  const phantom    = _phantomNodes.get(assetEntry.id);

  const modelNode = await _loadModelFile(file, assetEntry, true);
  if (!modelNode) return;

  if (phantom) {
    // Remap fresh IDs → saved IDs stored in phantom
    const idMap = buildIdRemapFromSpec(modelNode, phantom);
    applyIdRemap(modelNode, idMap);
    materials.remapMeshIds(idMap);
    for (const [newId, savedId] of idMap) {
      if (newId === savedId) continue;
      if (steps.object3dById.has(newId)) {
        steps.object3dById.set(savedId, steps.object3dById.get(newId));
        steps.object3dById.delete(newId);
      }
    }

    // Dispose any bounding-box placeholder objects created for phantom mesh nodes.
    // Must run BEFORE the surgical nodeById update so node.object3d still points
    // to the placeholder (finalizeModelImport already overwrote object3dById with
    // real meshes, but node.object3d on the phantom nodes still references the
    // LineSegments objects we created).
    function _disposePlaceholders(node) {
      if (node.missing) {
        if (node.type === 'mesh' && node.object3d?.isLineSegments) {
          // Dispose bbox placeholder LineSegments
          const ls = node.object3d;
          if (ls.parent) ls.parent.remove(ls);
          ls.geometry?.dispose();
          ls.material?.dispose();
          node.object3d = null;
        } else if (node.type === 'folder' && node.object3d) {
          // Dispose the persistent phantom folder group.
          // cleanupFolderGroups preserved it — we must remove it explicitly
          // now that the real model is back and will own this folder slot.
          const grp = node.object3d;
          if (grp.parent) grp.parent.remove(grp);
          node.object3d = null;
          if (steps.object3dById.get(node.id) === grp) {
            steps.object3dById.delete(node.id);
          }
        }
      }
      (node.children || []).forEach(_disposePlaceholders);
    }
    _disposePlaceholders(phantom);

    // Remove phantom from tree — surgical nodeById update (NOT buildNodeMap).
    //
    // WHY: rebuildFromTreeSpec (called during activateStep/activateBaseStep) moves
    // displaced live mesh nodes from other models into phantom folder data nodes as
    // their children. buildNodeMap(root) walks only the live scene tree and would
    // miss those displaced nodes (they're in the phantom subtree, not the other
    // models' subtrees). Losing them from nodeById causes rebuildFromTreeSpec to
    // silently drop them from every folder they were placed in after relink.
    //
    // INSTEAD: remove only truly-phantom entries (missing:true) from nodeById,
    // preserve all live displaced nodes, and register the fresh live model nodes.
    const root = state.get('treeData');
    if (root) {
      root.children = (root.children || []).filter(c => c !== phantom);

      const nodeById = new Map(state.get('nodeById'));

      // Delete phantom-only nodes (missing:true). Live nodes that ended up
      // inside phantom folder children are NOT marked missing and are kept.
      function _removePhantomsFromMap(node) {
        if (node.missing) nodeById.delete(node.id);
        (node.children || []).forEach(_removePhantomsFromMap);
      }
      _removePhantomsFromMap(phantom);

      // Register live model nodes with their remapped (saved) IDs.
      // Also clear any stale .missing flag so reinstated nodes render white.
      function _addToMap(node) {
        node.missing = false;
        nodeById.set(node.id, node);
        (node.children || []).forEach(_addToMap);
      }
      _addToMap(modelNode);

      state.setState({ treeData: { ...root }, nodeById });
    }
    _phantomNodes.delete(assetEntry.id);
  }

  // Re-apply base colors to newly loaded meshes.
  materials.applyAll();

  // Single reintegration contract: step 0 → active step → placeholder sweep.
  steps.reintegrateFromStep0(activeStep);
}

function _onFitAll() {
  if (!window.THREE || !sceneCore.rootGroup) return;
  const box = new THREE.Box3().setFromObject(sceneCore.rootGroup);
  if (box.isEmpty()) return;
  sceneCore.animateCameraTo(sceneCore.fitStateForBox(box, 1.15), 800, 'smooth');
}

function _onToggleGrid() {
  const vis = !state.get('gridVisible');
  state.setState({ gridVisible: vis });
  sceneCore.setGridVisible(vis);
}

function _onToggleTheme() {
  state.setTheme(state.get('theme') === 'dark' ? 'light' : 'dark');
}


// ═══════════════════════════════════════════════════════════════════════════
//  TREE TAB
// ═══════════════════════════════════════════════════════════════════════════

function _renderTreeTab() {
  const el = _panel('tree');
  if (!el) return;

  if (!_treeInited) {
    _treeInited = true;
    el.innerHTML = `
      <div class="topbar" style="gap:6px;flex-wrap:wrap">
        <button class="btn" id="btn-select-all">Select All</button>
        <button class="btn" id="btn-deselect">Deselect</button>
        <button class="btn" id="btn-collapse">Collapse</button>
        <button class="btn" id="btn-new-folder">New Folder</button>
      </div>
      <div id="tree-mount" class="tree"></div>
    `;

    el.querySelector('#btn-select-all')?.addEventListener('click', () => {
      const root = state.get('treeData');
      if (!root) return;
      const ids = new Set();
      const walk = n => { ids.add(n.id); (n.children || []).forEach(walk); };
      walk(root);
      state.setSelection(root.id, ids);
    });
    el.querySelector('#btn-deselect')?.addEventListener('click', () => state.clearSelection());
    el.querySelector('#btn-collapse')?.addEventListener('click', () => collapseAll());
    el.querySelector('#btn-new-folder')?.addEventListener('click', _onCreateFolder);

    initTree(el.querySelector('#tree-mount'));
  }

  renderTree();
}

function _onCreateFolder() {
  const root = state.get('treeData');
  if (!root) { setStatus('Load a model first.'); return; }
  _showFolderNameDialog('New Folder', name => {
    const selectedId = state.get('selectedId');
    const nodeById   = state.get('nodeById');

    // Choose parent: selected container, or scene root
    let parent = selectedId && nodeById ? nodeById.get(selectedId) : null;
    if (!parent || parent.type === 'mesh') parent = root;

    const THREE = window.THREE;
    if (!THREE) return;

    const group = new THREE.Group();
    group.name  = name;
    group.userData.isCustomFolder = true;

    const node = {
      id: generateId('folder'), name, type: 'folder',
      localVisible: true, object3d: group, children: [],
      localOffset: [0,0,0], localQuaternion: [0,0,0,1],
      pivotLocalOffset: [0,0,0], pivotLocalQuaternion: [0,0,0,1],
      baseLocalPosition: [0,0,0], baseLocalQuaternion: [0,0,0,1], baseLocalScale: [1,1,1],
      moveEnabled: true, rotateEnabled: true, pivotEnabled: true,
    };

    parent.children.push(node);
    if (parent.object3d) parent.object3d.add(group);
    steps.object3dById.set(node.id, group);  // register so gizmo can attach

    state.setState({ nodeById: buildNodeMap(root) });
    expandPathToNode(node.id);
    steps.scheduleTransformSync();
    setStatus(`Created folder "${node.name}".`);
  });
}

function _showFolderNameDialog(defaultVal, onConfirm) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sbs-dialog';
  const esc = s => String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  dlg.innerHTML = `
    <div class="sbs-dialog__body">
      <div class="sbs-dialog__title">New Folder</div>
      <input type="text" id="_fn-input" value="${esc(defaultVal)}"
        style="margin-top:10px;width:100%;box-sizing:border-box" />
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <button class="btn" id="_fn-cancel">Cancel</button>
        <button class="btn" id="_fn-ok">Create</button>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);

  const input  = dlg.querySelector('#_fn-input');
  const cancel = dlg.querySelector('#_fn-cancel');
  const ok     = dlg.querySelector('#_fn-ok');

  const confirm = () => {
    const val = input.value.trim();
    dlg.close(); dlg.remove();
    if (val) onConfirm(val);
  };

  cancel.addEventListener('click', () => { dlg.close(); dlg.remove(); });
  ok.addEventListener('click', confirm);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') confirm();
    if (e.key === 'Escape') { dlg.close(); dlg.remove(); }
  });

  dlg.showModal();
  requestAnimationFrame(() => { input.select(); });
}


// ═══════════════════════════════════════════════════════════════════════════
//  COLORS TAB
// ═══════════════════════════════════════════════════════════════════════════

// Which preset is currently expanded for editing
let _expandedPresetId = null;

function _renderColorsTab() {
  const el = _panel('colors');
  if (!el) return;

  const presets    = state.get('colorPresets') || [];
  const outline    = state.get('geometryOutline') || {};
  const multiIds   = state.get('multiSelectedIds') || new Set();
  const selId      = state.get('selectedId');
  const nodeById   = state.get('nodeById') || new Map();
  const solidness0 = outline.opacity ?? 0.9;
  const crease0    = outline.creaseAngle ?? 35;

  // Resolve selected mesh nodeIds only (folders/models can't receive presets directly)
  const allSelIds = multiIds.size ? Array.from(multiIds) : (selId ? [selId] : []);
  const meshIds   = allSelIds.filter(id => nodeById.get(id)?.type === 'mesh');

  el.innerHTML = `
    <div class="section">
      <div class="title">Colors</div>
      <div class="grid2">
        <button class="btn" id="btn-add-preset">+ Add Color</button>
        <button class="btn" id="btn-assign-preset">Assign to Selected</button>
        <button class="btn" id="btn-assign-default" title="Set as permanent default for selected meshes">★ Set as Default</button>
        <button class="btn" id="btn-revert-default" title="Restore each selected mesh to its default color">↩ Revert to Default</button>
      </div>

      <div class="card" style="margin-top:8px">
        <div class="row" style="margin-top:0">
          <div class="small">Global geometry outline</div>
          <button class="toggle${outline.enabled ? ' on' : ''}" id="outline-toggle"><span class="knob"></span></button>
        </div>
        <div class="grid2" style="margin-top:8px">
          <label class="colorlab">Outline color
            <input id="outline-color" type="color" value="${outline.color || '#000000'}" style="margin-top:6px" />
          </label>
          <label class="colorlab">Opacity
            <input id="outline-opacity" type="number" min="0" max="1" step="0.05" value="${solidness0}" style="margin-top:6px" />
          </label>
        </div>
        <div style="margin-top:8px">
          <label class="colorlab">Crease angle (degrees)
            <input id="outline-crease" type="number" min="1" max="180" step="1" value="${crease0}" style="margin-top:6px" />
          </label>
        </div>
      </div>

      <div id="color-list" style="margin-top:8px">
        <span class="small muted">No color presets yet.</span>
      </div>
    </div>
  `;

  // ── Outline controls ──────────────────────────────────────────────────────
  el.querySelector('#outline-toggle').addEventListener('click', function() {
    this.classList.toggle('on');
    materials.setGeometryOutline({ enabled: this.classList.contains('on') });
  });
  el.querySelector('#outline-color').addEventListener('input', e =>
    materials.setGeometryOutline({ color: e.target.value }));
  el.querySelector('#outline-opacity').addEventListener('input', e =>
    materials.setGeometryOutline({ opacity: Number(e.target.value) }));
  el.querySelector('#outline-crease').addEventListener('input', e =>
    materials.setGeometryOutline({ creaseAngle: Number(e.target.value) }));

  // ── Add preset ────────────────────────────────────────────────────────────
  el.querySelector('#btn-add-preset').addEventListener('click', () => {
    const p = materials.createPreset({ name: `Color ${presets.length + 1}` });
    _expandedPresetId = p.id;
    _renderColorsTab();
  });

  // ── Assign to selected (step override) ───────────────────────────────────
  el.querySelector('#btn-assign-preset').addEventListener('click', () => {
    if (!_expandedPresetId) { setStatus('Expand a color preset first.'); return; }
    if (!meshIds.length)    { setStatus('Select mesh objects first.'); return; }
    actions.assignPreset(meshIds, _expandedPresetId);
    setStatus(`Applied color to ${meshIds.length} mesh(es).`);
  });

  // ── Set as default ────────────────────────────────────────────────────────
  el.querySelector('#btn-assign-default').addEventListener('click', () => {
    if (!_expandedPresetId) { setStatus('Expand a color preset first.'); return; }
    if (!meshIds.length)    { setStatus('Select mesh objects first.'); return; }
    const preset = presets.find(p => p.id === _expandedPresetId);
    const ok = confirm(
      `Set "${preset?.name ?? 'this color'}" as the DEFAULT color for ${meshIds.length} mesh(es)?\n\n` +
      `This changes the base color globally — all steps will use this color unless they have a specific override.`
    );
    if (!ok) return;
    actions.assignDefaultColor(meshIds, _expandedPresetId);
    setStatus(`Default color set for ${meshIds.length} mesh(es).`);
  });

  // ── Revert to default ─────────────────────────────────────────────────────
  el.querySelector('#btn-revert-default').addEventListener('click', () => {
    if (!meshIds.length) { setStatus('Select mesh objects first.'); return; }
    actions.revertToDefault(meshIds);
    setStatus(`Reverted ${meshIds.length} mesh(es) to default color.`);
  });

  // ── Preset list ───────────────────────────────────────────────────────────
  const list = el.querySelector('#color-list');
  if (presets.length === 0) return;
  list.innerHTML = '';

  const defaultIds      = materials.getDefaultPresetIds();
  const missingMeshIds  = _collectPhantomMeshIds();
  const missingPresets  = _getMissingAssetPresets(missingMeshIds);

  const HATCH = 'repeating-linear-gradient(135deg,rgba(120,120,120,0.18) 0px,rgba(120,120,120,0.18) 4px,transparent 4px,transparent 11px)';

  for (const preset of presets) {
    const expanded      = _expandedPresetId === preset.id;
    const solidness     = preset.solidness ?? 1.0;
    const isDefault     = defaultIds.has(preset.id);
    const usedByMissing = missingPresets.has(preset.id);
    const modeLabel     = solidness >= 0.999 ? 'Solid'
                        : solidness <= 0.001 ? 'X-ray'
                        : `${Math.round(solidness * 100)}% Solid`;

    const row = document.createElement('div');
    row.className = 'colorRow' + (expanded ? ' selected' : '');
    row.style.cursor = 'pointer';
    if (usedByMissing) row.style.backgroundImage = HATCH;

    row.innerHTML = `
      <span class="colorSwatch" style="background:${preset.color || '#4a90d9'}"></span>
      <span class="small" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${isDefault ? '<span class="defaultStar" title="Used as a default color">★</span>' : ''}${_esc(preset.name)}
      </span>
      <span class="colorMeta">${modeLabel}</span>
    `;

    // Click anywhere on bar → toggle expand
    row.addEventListener('click', () => {
      _expandedPresetId = expanded ? null : preset.id;
      _renderColorsTab();
    });

    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      _showColorContextMenu(preset, e.clientX, e.clientY, meshIds);
    });

    list.appendChild(row);

    // ── Expanded edit card ────────────────────────────────────────────
    if (expanded) {
      const pane = document.createElement('div');
      pane.className = 'card';

      const missingWarningHtml = usedByMissing ? `
        <div style="display:flex;align-items:flex-start;gap:6px;padding:7px 10px;margin-bottom:10px;border-radius:8px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35)">
          <span style="font-size:14px;flex-shrink:0">⚠️</span>
          <span class="small" style="color:#f59e0b;line-height:1.5">This color is assigned to a <strong>missing asset</strong>. Changes are saved and will apply when the asset is relinked.</span>
        </div>` : '';

      pane.innerHTML = `
        ${missingWarningHtml}
        <label class="colorlab">Name
          <input type="text" class="cp-name" value="${_esc(preset.name)}" style="margin-top:6px" />
        </label>
        <label class="colorlab" style="margin-top:8px">Color
          <input type="color" class="cp-color" value="${preset.color || '#4a90d9'}" style="margin-top:6px" />
        </label>
        <label class="colorlab" style="margin-top:8px">Solidness
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
            <input type="range" class="cp-solidness" min="0" max="1" step="0.01" value="${solidness}" style="flex:1" />
            <span class="cp-sol-val small muted">${solidness.toFixed(2)}</span>
          </div>
        </label>
        <label class="colorlab" style="margin-top:8px">Metalness
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
            <input type="range" class="cp-metalness" min="0" max="1" step="0.01" value="${preset.metalness ?? 0.05}" style="flex:1" />
            <span class="cp-met-val small muted">${(preset.metalness ?? 0.05).toFixed(2)}</span>
          </div>
        </label>
        <label class="colorlab" style="margin-top:8px">Roughness
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
            <input type="range" class="cp-roughness" min="0" max="1" step="0.01" value="${preset.roughness ?? 0.45}" style="flex:1" />
            <span class="cp-rou-val small muted">${(preset.roughness ?? 0.45).toFixed(2)}</span>
          </div>
        </label>
        <label class="colorlab" style="margin-top:8px">Reflection Intensity
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
            <input type="range" class="cp-reflection" min="0" max="1" step="0.01" value="${preset.reflectionIntensity ?? 0.5}" style="flex:1" />
            <span class="cp-ref-val small muted">${(preset.reflectionIntensity ?? 0.5).toFixed(2)}</span>
          </div>
        </label>
        <label class="colorlab" style="margin-top:8px">Outline
          <select class="cp-outline" style="margin-top:6px">
            <option value="null"  ${preset.outlineEnabled === null  ? 'selected' : ''}>Global default</option>
            <option value="true"  ${preset.outlineEnabled === true  ? 'selected' : ''}>Always on</option>
            <option value="false" ${preset.outlineEnabled === false ? 'selected' : ''}>Always off</option>
          </select>
        </label>
        <label class="colorlab" style="margin-top:8px;flex-direction:row;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" class="cp-remove-textures" ${preset.removeTextures ? 'checked' : ''} />
          <span class="small">Strip textures (pure solid color)</span>
        </label>
        <div style="display:flex;justify-content:flex-end;margin-top:12px">
          <button class="btn cp-del" title="${isDefault ? 'Default color — replacement required' : usedByMissing ? 'Used by missing asset' : 'Delete'}">🗑 Delete</button>
        </div>
      `;

      // live update (no undo entry) — undo entry created on commit
      const _live = (key, val) => materials.updatePreset(preset.id, { [key]: val });
      const _upd  = (key, val) => actions.updatePreset(preset.id, { [key]: val });

      pane.querySelector('.cp-name').addEventListener('change', e => {
        _upd('name', e.target.value.trim() || preset.name); _renderColorsTab();
      });

      const colorPicker = pane.querySelector('.cp-color');
      colorPicker.addEventListener('focus',  () => actions.beginPresetEdit(preset.id));
      colorPicker.addEventListener('input',  e => {
        _live('color', e.target.value);
        row.querySelector('.colorSwatch').style.background = e.target.value;
      });
      colorPicker.addEventListener('change', () => actions.commitPresetEdit(preset.id));

      const _wireSliderUndo = (slider, valEl, key, fmt = v => Number(v).toFixed(2)) => {
        slider.addEventListener('pointerdown', () => actions.beginPresetEdit(preset.id));
        slider.addEventListener('input', e => {
          valEl.textContent = fmt(e.target.value);
          _live(key, Number(e.target.value));
        });
        slider.addEventListener('pointerup', () => actions.commitPresetEdit(preset.id));
      };

      _wireSliderUndo(pane.querySelector('.cp-solidness'),   pane.querySelector('.cp-sol-val'), 'solidness');
      _wireSliderUndo(pane.querySelector('.cp-metalness'),   pane.querySelector('.cp-met-val'), 'metalness');
      _wireSliderUndo(pane.querySelector('.cp-roughness'),   pane.querySelector('.cp-rou-val'), 'roughness');
      _wireSliderUndo(pane.querySelector('.cp-reflection'),  pane.querySelector('.cp-ref-val'), 'reflectionIntensity');

      pane.querySelector('.cp-outline').addEventListener('change', e => {
        const v = e.target.value;
        _upd('outlineEnabled', v === 'null' ? null : v === 'true');
      });
      pane.querySelector('.cp-remove-textures').addEventListener('change', e => {
        _upd('removeTextures', e.target.checked);
      });
      pane.querySelector('.cp-del').addEventListener('click', () =>
        _deletePresetWithProtection(preset, presets, missingMeshIds));

      list.appendChild(pane);
    }
  }
}

// ── Missing-asset helpers for color tab ───────────────────────────────────────

function _collectPhantomMeshIds() {
  const ids = new Set();
  const walk = node => {
    if (node.type === 'mesh') ids.add(node.id);
    for (const c of (node.children || [])) walk(c);
  };
  for (const phantom of _phantomNodes.values()) walk(phantom);
  return ids;
}

function _getMissingAssetPresets(missingMeshIds) {
  const used = new Set();
  // Current active assignments
  for (const [meshId, pid] of Object.entries(materials.meshColorAssignments)) {
    if (missingMeshIds.has(meshId) && pid) used.add(pid);
  }
  // Permanent defaults
  for (const [meshId, pid] of Object.entries(materials.meshDefaultColors)) {
    if (missingMeshIds.has(meshId) && pid) used.add(pid);
  }
  // Step-level snapshot assignments
  for (const step of (state.get('steps') || [])) {
    for (const [meshId, pid] of Object.entries(step.snapshot?.materials || {})) {
      if (missingMeshIds.has(meshId) && pid) used.add(pid);
    }
  }
  return used;
}

// ── Color right-click context menu ────────────────────────────────────────────
function _showColorContextMenu(preset, x, y, selectedMeshIds) {
  const activeMatches  = Object.entries(materials.meshColorAssignments)
    .filter(([, pid]) => pid === preset.id).map(([id]) => id);
  const defaultMatches = Object.entries(materials.meshDefaultColors)
    .filter(([, pid]) => pid === preset.id).map(([id]) => id);

  showContextMenu([
    {
      label:    `Select by active color (${activeMatches.length})`,
      disabled: activeMatches.length === 0,
      action:   () => {
        state.setSelection(activeMatches[0], new Set(activeMatches));
        setStatus(`Selected ${activeMatches.length} mesh(es) using "${preset.name}".`);
      },
    },
    {
      label:    `Select by default color (${defaultMatches.length})`,
      disabled: defaultMatches.length === 0,
      action:   () => {
        state.setSelection(defaultMatches[0], new Set(defaultMatches));
        setStatus(`Selected ${defaultMatches.length} mesh(es) with default "${preset.name}".`);
      },
    },
    { separator: true },
    {
      label:    `★ Set as default for selected (${selectedMeshIds.length})`,
      disabled: selectedMeshIds.length === 0,
      action:   () => {
        if (!selectedMeshIds.length) { setStatus('Select mesh objects first.'); return; }
        const ok = confirm(
          `Set "${preset.name}" as the DEFAULT color for ${selectedMeshIds.length} mesh(es)?\n\n` +
          `This changes the base color globally across all steps without a specific override.`
        );
        if (!ok) return;
        materials.assignDefaultColor(selectedMeshIds, preset.id);
        steps.scheduleSync();
        setStatus(`Default color set for ${selectedMeshIds.length} mesh(es).`);
      },
    },
    {
      label:    `↩ Revert selected to default (${selectedMeshIds.length})`,
      disabled: selectedMeshIds.length === 0,
      action:   () => {
        if (!selectedMeshIds.length) { setStatus('Select mesh objects first.'); return; }
        materials.revertToDefault(selectedMeshIds);
        steps.scheduleSync();
        setStatus(`Reverted ${selectedMeshIds.length} mesh(es) to default color.`);
      },
    },
  ], x, y);
}

// ── Delete with default-color + missing-asset protection ─────────────────────
function _deletePresetWithProtection(preset, allPresets, missingMeshIds) {
  const defaultCount  = materials.defaultColorMeshCount(preset.id);
  const missingIds    = missingMeshIds || _collectPhantomMeshIds();

  // Count missing-asset mesh usages: defaults + active assignments + step snapshots
  let missingCount = 0;
  const _hasMissing = (map) => Object.entries(map).some(([id, pid]) => pid === preset.id && missingIds.has(id));
  if (_hasMissing(materials.meshDefaultColors))    missingCount++;
  if (_hasMissing(materials.meshColorAssignments)) missingCount++;
  for (const step of (state.get('steps') || [])) {
    if (_hasMissing(step.snapshot?.materials || {})) { missingCount++; break; }
  }

  if (defaultCount > 0 || missingCount > 0) {
    _showReplacementPicker(preset, allPresets, defaultCount, missingCount);
    return;
  }

  if (!confirm(`Delete "${preset.name}"?`)) return;
  if (_expandedPresetId === preset.id) _expandedPresetId = null;
  actions.deletePreset(preset.id);
}

function _showReplacementPicker(preset, allPresets, defaultCount, missingCount = 0) {
  const others = allPresets.filter(p => p.id !== preset.id);

  const hasMissing = missingCount > 0;
  const hasDefault = defaultCount > 0;

  if (others.length === 0) {
    const reason = hasDefault
      ? `it is the default color for ${defaultCount} mesh(es)`
      : `it is assigned to ${missingCount} mesh(es) on a missing asset`;
    alert(`Cannot delete "${preset.name}" — ${reason}\nand no other presets exist.\n\nCreate a replacement preset first.`);
    return;
  }

  let bodyText = '';
  if (hasDefault && hasMissing) {
    bodyText = `<strong>${_esc(preset.name)}</strong> is the default color for <strong>${defaultCount}</strong> mesh(es) and is also assigned to <strong>${missingCount}</strong> mesh(es) on a ⚠️ missing asset.<br><br>Choose a replacement — changes will be saved and applied when the missing asset is relinked.`;
  } else if (hasDefault) {
    bodyText = `<strong>${_esc(preset.name)}</strong> is the default color for <strong>${defaultCount}</strong> mesh(es).<br>Choose a replacement before deleting.`;
  } else {
    bodyText = `<strong>${_esc(preset.name)}</strong> is assigned to <strong>${missingCount}</strong> mesh(es) on a ⚠️ <strong>missing asset</strong>.<br><br>Choose a replacement color — it will be saved and applied when the asset is relinked.`;
  }

  const dlg = document.createElement('dialog');
  dlg.className = 'sbs-dialog';
  dlg.innerHTML = `
    <div class="sbs-dialog__body">
      <div class="sbs-dialog__title">Replace Color Before Deleting</div>
      <p class="small" style="margin:8px 0 12px;line-height:1.6">${bodyText}</p>
      <select id="dlg-replace-sel" style="width:100%;margin-bottom:14px">
        ${others.map(p => `
          <option value="${_esc(p.id)}">
            ${materials.isDefaultPreset(p.id) ? '★ ' : ''}${_esc(p.name)}
          </option>`).join('')}
      </select>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" id="dlg-cancel">Cancel</button>
        <button class="btn btn-danger" id="dlg-confirm">Replace &amp; Delete</button>
      </div>
    </div>
  `;

  document.body.appendChild(dlg);
  dlg.showModal();

  dlg.querySelector('#dlg-cancel').addEventListener('click', () => {
    dlg.close(); dlg.remove();
  });

  dlg.querySelector('#dlg-confirm').addEventListener('click', () => {
    const newId = dlg.querySelector('#dlg-replace-sel').value;
    if (!newId) return;
    // Reassign default colors (live meshes)
    materials.reassignDefault(preset.id, newId);
    // Reassign missing-asset mesh colors: defaults, active assignments, and all step snapshots
    const missingIds = _collectPhantomMeshIds();
    for (const meshId of missingIds) {
      if (materials.meshDefaultColors[meshId] === preset.id)
        materials.meshDefaultColors[meshId] = newId;
      if (materials.meshColorAssignments[meshId] === preset.id)
        materials.meshColorAssignments[meshId] = newId;
    }
    // Patch step snapshots. Architectural rule: a snapshot entry whose value
    // equals the project default is NOT a real override — strip it so future
    // default changes propagate. So when we replace oldId → newId, if newId
    // matches the mesh's new default, drop the entry entirely instead of
    // stamping it.
    const allSteps = state.get('steps') || [];
    let stepsDirty = false;
    for (const step of allSteps) {
      const mats = step.snapshot?.materials;
      if (!mats) continue;
      for (const meshId of missingIds) {
        if (mats[meshId] !== preset.id) continue;
        if (materials.meshDefaultColors[meshId] === newId) {
          delete mats[meshId];                 // tracking-default → strip
        } else {
          mats[meshId] = newId;                // real override → swap
        }
        stepsDirty = true;
      }
    }
    if (stepsDirty) state.setState({ steps: [...allSteps] });
    if (_expandedPresetId === preset.id) _expandedPresetId = null;
    actions.deletePreset(preset.id);
    dlg.close(); dlg.remove();
    state.markDirty();
    setStatus(`Replaced color and deleted "${preset.name}".`);
  });
}

/** Wire a range slider: update live value display and call onChange. */
function _wireSlider(container, selector, onChange) {
  const slider = container.querySelector(selector);
  if (!slider) return;
  const valEl = slider.nextElementSibling;
  slider.addEventListener('input', e => {
    const v = Number(e.target.value);
    if (valEl) valEl.textContent = v.toFixed(2);
    onChange(v);
  });
}


// ═══════════════════════════════════════════════════════════════════════════
//  SELECT TAB
// ═══════════════════════════════════════════════════════════════════════════

function _renderSelectTab() {
  const el = _panel('select');
  if (!el) return;

  const outlineColor = state.get('selectionOutlineColor') ?? '#00ffff';

  el.innerHTML = `
    <div class="section">
      <div class="title">Selection</div>

      <div class="field-row" style="margin-top:10px">
        <label class="small" style="flex:1">Highlight Color</label>
        <input type="color" id="sel-outline-color" value="${_esc(outlineColor)}"
               style="width:44px;height:28px;padding:2px;border-radius:4px;cursor:pointer" />
      </div>
      <div class="small muted" style="margin-top:4px;line-height:1.4">
        Color used for the selection overlay and edge outline.<br>
        White = fully neutral tint. Cyan is the default.
      </div>
    </div>

    <div class="section" style="margin-top:12px">
      <div class="title">Quick Actions</div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
        <button class="btn" id="btn-sel-all-meshes">Select All Meshes</button>
        <button class="btn" id="btn-sel-clear">Deselect All</button>
      </div>
    </div>
  `;

  el.querySelector('#sel-outline-color').addEventListener('input', e => {
    materials.setSelectionOutlineColor(e.target.value);
  });

  el.querySelector('#btn-sel-all-meshes').addEventListener('click', () => {
    const ids = [...materials.meshById.keys()];
    if (ids.length) {
      state.setSelection(ids[0], new Set(ids));
      setStatus(`Selected ${ids.length} mesh(es).`);
    }
  });

  el.querySelector('#btn-sel-clear').addEventListener('click', () => {
    state.clearSelection();
    setStatus('Selection cleared.');
  });
}


// ═══════════════════════════════════════════════════════════════════════════
//  CAMERAS TAB
// ═══════════════════════════════════════════════════════════════════════════

function _renderCamerasTab() {
  const el    = _panel('cameras');
  const views = state.get('cameraViews') || [];
  if (!el) return;

  // Active step's current binding — used to flag which template (if any)
  // the active step is bound to, AND to surface the per-step camera
  // dropdown right inside the tab so the user can rebind without
  // round-tripping through the steps panel.
  const stepsArr  = state.get('steps') || [];
  const activeId  = state.get('activeStepId');
  const activeStep = activeId ? stepsArr.find(s => s.id === activeId) : null;
  const activeBindingTplId = activeStep?.cameraBinding?.mode === 'template'
    ? activeStep.cameraBinding.templateId
    : null;

  // Per-template usage count (how many steps reference each one).
  const usage = new Map();
  for (const s of stepsArr) {
    const b = s.cameraBinding;
    if (b?.mode === 'template' && b.templateId) {
      usage.set(b.templateId, (usage.get(b.templateId) || 0) + 1);
    }
  }

  el.innerHTML = `
    <div class="section">
      <div class="title">Cameras</div>
      <div class="small muted" style="margin-top:6px;line-height:1.5;">
        Templates are reusable named camera views. Steps either use a
        template (edit-once-affects-many) or hold their own free camera
        snapshot. Right-click a step → Update camera = always free.
      </div>
      <div style="margin-top:10px;">
        <button class="btn" id="btn-cam-new">+ Save current view as template</button>
      </div>
      ${activeStep ? `
        <div class="card" style="margin-top:10px;font-size:12px;">
          <div class="small muted" style="margin-bottom:4px;">Active step camera</div>
          <select id="active-step-cam-binding" style="width:100%;">
            <option value="" ${!activeBindingTplId ? 'selected' : ''}>[Free camera]</option>
            ${views.map(v =>
              `<option value="${_esc(v.id)}" ${activeBindingTplId === v.id ? 'selected' : ''}>${_esc(v.name)}</option>`
            ).join('')}
          </select>
        </div>
      ` : ''}
      <div id="cam-list" style="margin-top:10px;"></div>
    </div>
  `;

  el.querySelector('#btn-cam-new').addEventListener('click', () => {
    const proposed = `Camera ${views.length + 1}`;
    // Electron renderer disables window.prompt(); use a custom modal
    // instead. Same scaffold as the delete-template dialog below.
    _showSimplePromptDialog({
      title:  'New camera template',
      label:  'Name',
      value:  proposed,
      okText: 'Save',
      onSave: (name) => {
        const v = (name || '').trim() || proposed;
        actions.createCameraTemplate(v);
        setStatus(`Saved camera template "${v}".`);
      },
    });
  });

  const bindSel = el.querySelector('#active-step-cam-binding');
  bindSel?.addEventListener('change', e => {
    actions.setStepCameraBinding(activeId, e.target.value || null);
    setStatus(e.target.value
      ? `Bound step to camera "${views.find(v => v.id === e.target.value)?.name}".`
      : 'Step set to free camera.');
  });

  const list = el.querySelector('#cam-list');
  if (views.length === 0) {
    list.innerHTML = '<div class="small muted">No camera templates yet.</div>';
    return;
  }
  list.innerHTML = '';

  for (const view of views) {
    const isActiveBound = view.id === activeBindingTplId;
    const useCount      = usage.get(view.id) || 0;

    const item = document.createElement('div');
    item.className = 'cameraItem';
    if (isActiveBound) item.style.outline = '1px solid var(--accent, #f59e0b)';
    item.innerHTML = `
      <div class="cameraRow" style="align-items:center;gap:6px;">
        <span class="cam-name-text" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:text;" title="Double-click to rename">${_esc(view.name)}</span>
        <span class="small muted" style="font-size:11px;flex-shrink:0;">${useCount} step${useCount === 1 ? '' : 's'}</span>
      </div>
      <div class="cameraActions">
        <button class="btn" data-goto="${_esc(view.id)}" title="Move the live camera to this template's view (does not change any step's binding)">▶ Go To</button>
        <button class="btn" data-update="${_esc(view.id)}" title="Set this template to the current view AND bind the active step to it. All other bound steps follow automatically.">🔄 Update</button>
        <button class="btn" data-del="${_esc(view.id)}" title="Delete this template">🗑 Delete</button>
      </div>
    `;

    item.querySelector('[data-goto]').addEventListener('click', e => {
      e.stopPropagation();
      sceneCore.animateCameraTo({
        position: view.position, quaternion: view.quaternion,
        pivot: view.pivot, up: view.up, fov: view.fov,
      }, 800, 'smooth');
    });

    item.querySelector('[data-update]').addEventListener('click', e => {
      e.stopPropagation();
      actions.updateCameraTemplate(view.id);
      setStatus(`Updated camera "${view.name}"${activeStep ? ` (bound to "${activeStep.name}")` : ''}.`);
    });

    item.querySelector('[data-del]').addEventListener('click', e => {
      e.stopPropagation();
      _showDeleteCameraTemplateDialog(view, useCount);
    });

    // Inline rename — dblclick the name to edit, Enter / blur to commit.
    const nameSpan = item.querySelector('.cam-name-text');
    nameSpan.addEventListener('dblclick', () => _enterCamRename(nameSpan, view));

    list.appendChild(item);
  }
}

function _enterCamRename(span, view) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = view.name;
  input.style.cssText = 'flex:1;min-width:0;font-size:inherit;';
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (v && v !== view.name) actions.renameCameraTemplate(view.id, v);
    _renderCamerasTab();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { done = true; _renderCamerasTab(); }
  });
}

/**
 * Delete-template dialog — modeled on the New-Folder dialog UX.
 *
 *   Dropdown: [Convert to free camera] (default) | template1 | template2 | ...
 *   Buttons:  Cancel | <dynamic label that flips between
 *                       "Convert to free" and "Change to template">
 *
 * Bound steps either get a free-camera snapshot of the deleted template's
 * last state, or get re-bound to the chosen replacement. Single undo
 * entry covers the whole operation.
 */
/**
 * Generic single-input prompt dialog. Electron's renderer disables
 * window.prompt(), so we render our own modal with a text field and
 * OK/Cancel buttons. Used by "+ New template" — could be reused
 * elsewhere any time we need a quick name from the user.
 */
function _showSimplePromptDialog({ title, label, value = '', okText = 'OK', onSave }) {
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.55)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'z-index:9999',
  ].join(';');

  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = [
    'min-width:340px', 'max-width:440px', 'padding:16px',
    'background:var(--panel, #0f172a)', 'border:1px solid var(--line, #334155)',
    'border-radius:10px', 'display:flex', 'flex-direction:column', 'gap:10px',
  ].join(';');

  card.innerHTML = `
    <div class="title" style="font-size:14px;">${_esc(title)}</div>
    <label class="colorlab">${_esc(label)}
      <input type="text" id="prompt-input" value="${_esc(value)}" style="margin-top:6px;width:100%;" />
    </label>
    <div class="grid2" style="margin-top:6px;">
      <button class="btn" id="prompt-cancel">Cancel</button>
      <button class="btn primary" id="prompt-ok">${_esc(okText)}</button>
    </div>
  `;

  const input    = card.querySelector('#prompt-input');
  const okBtn    = card.querySelector('#prompt-ok');
  const cancelBtn = card.querySelector('#prompt-cancel');

  const close = () => overlay.remove();
  const commit = () => { onSave?.(input.value); close(); };

  cancelBtn.addEventListener('click', close);
  okBtn.addEventListener('click', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); close();  }
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

function _showDeleteCameraTemplateDialog(view, useCount) {
  const views = (state.get('cameraViews') || []).filter(v => v.id !== view.id);

  // Modal scaffolding — match the rest of the app's dialog look (dark
  // overlay, centred card). Plain DOM, no framework.
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.55)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'z-index:9999',
  ].join(';');

  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = [
    'min-width:340px', 'max-width:440px', 'padding:16px',
    'background:var(--panel, #0f172a)', 'border:1px solid var(--line, #334155)',
    'border-radius:10px', 'display:flex', 'flex-direction:column', 'gap:10px',
  ].join(';');

  card.innerHTML = `
    <div class="title" style="font-size:14px;">Delete camera "${_esc(view.name)}"</div>
    <div class="small muted" style="line-height:1.5;">
      ${useCount === 0
        ? 'No steps are bound to this camera.'
        : `${useCount} step${useCount === 1 ? '' : 's'} use this camera. Choose where they should land:`}
    </div>
    <select id="cam-del-replacement" style="width:100%;">
      <option value="">[Convert to free camera]</option>
      ${views.map(v => `<option value="${_esc(v.id)}">${_esc(v.name)}</option>`).join('')}
    </select>
    <div class="grid2" style="margin-top:6px;">
      <button class="btn" id="cam-del-cancel">Cancel</button>
      <button class="btn primary" id="cam-del-go">Convert to free</button>
    </div>
  `;

  const sel        = card.querySelector('#cam-del-replacement');
  const goBtn      = card.querySelector('#cam-del-go');
  const cancelBtn  = card.querySelector('#cam-del-cancel');

  sel.addEventListener('change', () => {
    goBtn.textContent = sel.value ? 'Change to template' : 'Convert to free';
  });

  const close = () => overlay.remove();
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  goBtn.addEventListener('click', () => {
    const replacement = sel.value || null;
    actions.deleteCameraTemplate(view.id, replacement);
    setStatus(replacement
      ? `Deleted "${view.name}"; ${useCount} step(s) rebound.`
      : `Deleted "${view.name}"; ${useCount} step(s) converted to free camera.`);
    close();
  });

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  setTimeout(() => sel.focus(), 0);
}


// ═══════════════════════════════════════════════════════════════════════════
//  EXPORT TAB
// ═══════════════════════════════════════════════════════════════════════════

function _onUserSettingsChanged() {
  // Live-rebuild the Export tab so the voice list reflects the new filter.
  if (_panel('export')) _renderExportTab();
}

function _renderExportTab() {
  const el  = _panel('export');
  if (!el) return;

  const exp = state.get('export') || {};

  el.innerHTML = `
    <div class="section">
      <div class="title">Export</div>
      <div class="small muted" style="margin-top:6px;">Exports the 3D viewport + scene notes. UI chrome stays out of the rendered file.</div>

      <div class="card">
        <label class="colorlab">File name
          <input type="text" id="exp-filename" value="${_esc(exp.fileName || 'sbs_export')}" placeholder="sbs_export" style="margin-top:6px;" />
        </label>

        <label class="small muted" style="display:block;margin-top:10px;">Output format</label>
        <select id="exp-format" style="margin-top:8px;">
          <option value="mp4"      ${exp.outputFormat==='mp4'     ?'selected':''}>MP4 (H.264) — recommended</option>
          <option value="webm_vp9" ${exp.outputFormat==='webm_vp9'?'selected':''}>WebM VP9</option>
          <option value="webm_vp8" ${exp.outputFormat==='webm_vp8'?'selected':''}>WebM VP8</option>
          <option value="png_seq"  ${exp.outputFormat==='png_seq' ?'selected':''} disabled>PNG Sequence (not yet)</option>
        </select>

        <label class="small muted" style="display:block;margin-top:10px;">Format preset</label>
        <select id="exp-preset" style="margin-top:8px;">
          <option value="hdtv_1080"   ${exp.formatPreset==='hdtv_1080'   ?'selected':''}>HDTV 1080p (1920 × 1080)</option>
          <option value="hdtv_720"    ${exp.formatPreset==='hdtv_720'    ?'selected':''}>HDTV 720p (1280 × 720)</option>
          <option value="square_1080" ${exp.formatPreset==='square_1080' ?'selected':''}>Square 1080 × 1080</option>
          <option value="custom"      ${exp.formatPreset==='custom'      ?'selected':''}>Custom…</option>
        </select>

        <div class="grid2" style="margin-top:8px;">
          <label class="colorlab">Width (px)
            <input type="number" id="exp-width"  value="${exp.width  ?? 1920}" min="64" max="7680" step="2" style="margin-top:6px;" />
          </label>
          <label class="colorlab">Height (px)
            <input type="number" id="exp-height" value="${exp.height ?? 1080}" min="64" max="4320" step="2" style="margin-top:6px;" />
          </label>
        </div>

        <div class="grid2" style="margin-top:10px;">
          <label class="colorlab">Frame rate (fps)
            <input type="number" id="exp-fps" value="${exp.fps??30}" min="1" max="120" step="1" style="margin-top:6px;" />
          </label>
          <label class="colorlab">Step hold (ms)
            <input type="number" id="exp-hold" value="${exp.stepHoldMs??800}" min="0" max="10000" step="100" style="margin-top:6px;" />
          </label>
        </div>

        <label style="display:flex;align-items:center;gap:6px;margin-top:10px;cursor:pointer;">
          <input type="checkbox" id="exp-show-safe-frame" ${exp.showSafeFrame !== false ? 'checked' : ''} />
          <span class="small muted">Show safe frame in viewport</span>
        </label>

        <label style="display:flex;align-items:flex-start;gap:6px;margin-top:8px;cursor:pointer;">
          <input type="checkbox" id="exp-offline-render" ${exp.offlineRender ? 'checked' : ''} style="margin-top:3px;" />
          <span class="small muted">
            Offline render (deterministic)
            <div class="small muted" style="font-size:11px;opacity:0.75;margin-top:2px;">
              Decouples animation from real time. Slower but immune to window-throttling — same project renders the same duration regardless of window size or focus.
            </div>
          </span>
        </label>
      </div>

      <div class="card" style="margin-top:8px;">
        <div class="title" style="font-size:13px;">Narration</div>
        <div class="small muted" style="margin-top:4px;">
          Voice and speed used for all step narration. Changing these invalidates cached clips.
        </div>

        <label class="small muted" style="display:block;margin-top:8px;">Voice</label>
        <select id="exp-voice" style="margin-top:6px;">
          <option value="">Loading voices…</option>
        </select>

        <label class="small muted" style="display:block;margin-top:10px;">Speed — <span id="exp-voice-speed-lbl">${(exp.narrationSpeed ?? 1).toFixed(2)}×</span></label>
        <input type="range" id="exp-voice-speed" min="0.5" max="2" step="0.05"
               value="${exp.narrationSpeed ?? 1}" style="margin-top:4px;width:100%;" />

        <label style="display:flex;align-items:center;gap:6px;margin-top:10px;cursor:pointer;">
          <input type="checkbox" id="exp-narration-enabled" ${exp.narrationEnabled !== false ? 'checked' : ''} />
          <span class="small muted">Include narration in export</span>
        </label>

        <div style="margin-top:12px;border-top:1px solid #1f2937;padding-top:10px;">
          <div class="small muted" style="margin-bottom:4px;">Audio cache folder</div>
          <div class="small muted" style="margin-bottom:6px;font-size:11px;">
            Slow neural voices (Kokoro etc.) cache to <code>&lt;voice&gt;/&lt;step&gt;__&lt;hash&gt;.wav</code>
            here instead of bloating the .sbsproj. Fast OS voices skip this —
            they re-synth instantly. Path is relative to the project file.
          </div>
          <div id="exp-cache-state" class="small" style="margin-bottom:6px;">
            <em style="opacity:0.6;">— inline (no folder set) —</em>
          </div>
          <div class="grid2">
            <button class="btn" id="btn-cache-pick">Choose folder…</button>
            <button class="btn" id="btn-cache-clear">Clear</button>
          </div>
          <div class="grid2" style="margin-top:6px;">
            <button class="btn" id="btn-cache-purge-stale" title="Delete every voice subfolder that isn't the active voice. Safe — re-synth happens on next play.">Clear inactive voices</button>
            <button class="btn" id="btn-cache-purge-all" title="Wipe everything inside the cache folder. All clips re-synth on next play.">Clear all cache</button>
          </div>
          <div id="exp-cache-summary" class="small muted" style="margin-top:6px;font-size:11px;"></div>
        </div>
      </div>

      <div class="grid2" style="margin-top:8px;">
        <button class="btn" id="btn-export">Start Export</button>
        <button class="btn" id="btn-export-cancel" disabled>Cancel Export</button>
      </div>

      <div class="card" style="margin-top:8px;">
        <div id="exp-status" class="small muted">Idle.</div>
      </div>
    </div>
  `;

  const PRESETS = {
    hdtv_1080:   { width:1920, height:1080 },
    hdtv_720:    { width:1280, height:720  },
    square_1080: { width:1080, height:1080 },
  };

  el.querySelector('#exp-filename').addEventListener('change', e =>
    state.setExportOption('fileName', e.target.value.trim() || 'sbs_export'));
  el.querySelector('#exp-format').addEventListener('change', e =>
    state.setExportOption('outputFormat', e.target.value));
  el.querySelector('#exp-preset').addEventListener('change', e => {
    state.setExportOption('formatPreset', e.target.value);
    if (e.target.value !== 'custom') {
      const r = PRESETS[e.target.value] || PRESETS.hdtv_1080;
      state.setExportOption('width',  r.width);
      state.setExportOption('height', r.height);
      // Sync the W/H inputs immediately — same render-pass, no re-render needed.
      const wInput = el.querySelector('#exp-width');
      const hInput = el.querySelector('#exp-height');
      if (wInput) wInput.value = String(r.width);
      if (hInput) hInput.value = String(r.height);
    }
  });
  // Custom width / height — selecting either flips the preset to "custom"
  // so future exports honour the typed numbers. Min clamp matches the UI.
  const _onSizeChange = (key) => (e) => {
    const val = Math.max(64, Number(e.target.value) || 0);
    state.setExportOption(key, val);
    if (state.get('export')?.formatPreset !== 'custom') {
      state.setExportOption('formatPreset', 'custom');
      const presetSel = el.querySelector('#exp-preset');
      if (presetSel) presetSel.value = 'custom';
    }
  };
  el.querySelector('#exp-width') ?.addEventListener('change', _onSizeChange('width'));
  el.querySelector('#exp-height')?.addEventListener('change', _onSizeChange('height'));
  el.querySelector('#exp-show-safe-frame')?.addEventListener('change', e =>
    state.setExportOption('showSafeFrame', !!e.target.checked));
  el.querySelector('#exp-offline-render')?.addEventListener('change', e =>
    state.setExportOption('offlineRender', !!e.target.checked));
  el.querySelector('#exp-fps').addEventListener('change', e =>
    state.setExportOption('fps', Number(e.target.value)));
  el.querySelector('#exp-hold').addEventListener('change', e =>
    state.setExportOption('stepHoldMs', Number(e.target.value)));
  el.querySelector('#btn-export').addEventListener('click', _onExportTabStart);
  el.querySelector('#btn-export-cancel').addEventListener('click', _onExportTabCancel);

  // ── Narration controls ───────────────────────────────────────────────────
  const voiceSel = el.querySelector('#exp-voice');
  const speedInp = el.querySelector('#exp-voice-speed');
  const speedLbl = el.querySelector('#exp-voice-speed-lbl');
  const narrEn   = el.querySelector('#exp-narration-enabled');

  ttsListVoices().then(list => {
    if (!list.length) {
      voiceSel.innerHTML = `<option value="">No OS voices available — restart Electron after install</option>`;
      return;
    }
    // Filter by user's preferred languages (Settings → Language). Empty = no filter.
    const prefs = (userSettings.get().ui?.preferredLanguages || [])
      .map(s => s.toLowerCase().trim())
      .filter(Boolean);
    const filtered = prefs.length
      ? list.filter(v => {
          const lang = (v.lang || '').toLowerCase();
          return prefs.some(p => lang.includes(p));
        })
      : list;
    const shown = filtered.length ? filtered : list;   // never show empty list
    const current = exp.narrationVoice || '';
    voiceSel.innerHTML = [
      `<option value="">— none —</option>`,
      ...shown.map(v => `<option value="${_esc(v.id)}" ${v.id === current ? 'selected' : ''}>${_esc(v.name)} — ${_esc(v.lang)}</option>`),
    ].join('');
  }).catch(err => {
    voiceSel.innerHTML = `<option value="">Error loading voices: ${_esc(err.message)}</option>`;
  });

  // Re-render this tab when language preference changes (so the voice
  // dropdown picks up the new filter without restart).
  window.addEventListener('sbs:user-settings-changed', _onUserSettingsChanged);

  voiceSel.addEventListener('change', () => {
    state.setExportOption('narrationVoice', voiceSel.value);
    _invalidateAllNarrationClips();
    // Refresh the cache folder's _README.txt so its "Active voice" line
    // tracks the new selection. Silent if no cache folder is configured.
    narrationCache.writeReadme().catch(() => {});
  });
  speedInp.addEventListener('input', () => { speedLbl.textContent = `${Number(speedInp.value).toFixed(2)}×`; });
  speedInp.addEventListener('change', () => {
    state.setExportOption('narrationSpeed', Number(speedInp.value));
    _invalidateAllNarrationClips();
  });
  narrEn.addEventListener('change', () =>
    state.setExportOption('narrationEnabled', !!narrEn.checked));

  // ── Audio cache folder ─────────────────────────────────────────────────
  const cacheState   = el.querySelector('#exp-cache-state');
  const cacheSummary = el.querySelector('#exp-cache-summary');
  const btnPick      = el.querySelector('#btn-cache-pick');
  const btnClear     = el.querySelector('#btn-cache-clear');
  const btnPurgeStale= el.querySelector('#btn-cache-purge-stale');
  const btnPurgeAll  = el.querySelector('#btn-cache-purge-all');

  const _renderCacheState = () => {
    // Tab may have re-rendered; bail if our DOM is gone (don't leak into stale nodes).
    if (!cacheState.isConnected) return;
    const folder      = state.get('audioCacheFolder');
    const projectPath = state.get('projectPath');
    if (!folder) {
      cacheState.innerHTML = `<em style="opacity:0.6;">— inline (no folder set) —</em>`;
    } else if (!projectPath) {
      cacheState.innerHTML = `<span style="color:#fbbf24;">Save the project first — folder needs a base path.</span>
        <div class="small muted" style="margin-top:2px;">Will be: <code>${_esc(folder)}</code></div>`;
    } else {
      cacheState.innerHTML = `<span style="color:#86efac;">✓</span> <code>${_esc(folder)}</code>
        <div class="small muted" style="margin-top:2px;">${_esc(projectPath.replace(/[\/\\][^\/\\]+$/, ''))}/</div>`;
    }
    _refreshCacheSummary();
  };

  // Asynchronously update the summary line under the cache buttons —
  // shows folder count + total size + which voice is active. Quiet when
  // caching isn't enabled or the folder hasn't been created yet.
  const _refreshCacheSummary = () => {
    if (!cacheSummary?.isConnected) return;
    if (!narrationCache.isCacheEnabled()) {
      cacheSummary.innerHTML = '';
      return;
    }
    narrationCache.listVoiceFolders().then(folders => {
      if (!cacheSummary.isConnected) return;
      if (!folders) { cacheSummary.innerHTML = '(folder not yet created)'; return; }
      if (!folders.length) { cacheSummary.innerHTML = '(empty — no clips cached yet)'; return; }
      const active = narrationCache.activeVoiceSlug();
      const totalBytes = folders.reduce((s, f) => s + f.totalBytes, 0);
      const stale = folders.filter(f => f.name !== active);
      const totalMb  = (totalBytes / 1024 / 1024).toFixed(1);
      const staleMb  = (stale.reduce((s, f) => s + f.totalBytes, 0) / 1024 / 1024).toFixed(1);
      cacheSummary.innerHTML =
        `${folders.length} voice folder(s), ${totalMb} MB total · ${stale.length} stale (${staleMb} MB) · `
        + `<a href="#" id="exp-cache-readme">open _README.txt</a>`;
      const link = el.querySelector('#exp-cache-readme');
      if (link) link.addEventListener('click', e => {
        e.preventDefault();
        const root = state.get('projectPath')?.replace(/[\/\\][^\/\\]+$/, '') + '/' + state.get('audioCacheFolder');
        if (window.sbsNative?.showInFolder) window.sbsNative.showInFolder(`${root}/_README.txt`);
      });
    }).catch(() => { cacheSummary.innerHTML = ''; });
  };
  _renderCacheState();

  btnPick.addEventListener('click', async () => {
    if (!window.sbsNative?.chooseFolder) return;
    const projectPath = state.get('projectPath');
    if (!projectPath) {
      setStatus('Save the project first — the cache folder is stored relative to it.', 'warning');
      return;
    }
    const projectDir = projectPath.replace(/[\/\\][^\/\\]+$/, '');
    const picked = await window.sbsNative.chooseFolder({
      title:       'Choose narration cache folder',
      defaultPath: projectDir,
    });
    if (!picked) return;
    // Convert to relative-to-project. If the user picked a folder OUTSIDE
    // the project dir (e.g. on a different drive), keep the absolute path
    // so portability still kinda works.
    const rel = _toRelative(projectDir, picked);
    state.setState({ audioCacheFolder: rel });
    state.markDirty();
    _renderCacheState();

    // One-shot: migrate any inline-cached clips to disk so the next save
    // is small. Skips fast OS voices (those don't disk-cache by design).
    setStatus(`Audio cache folder set: ${rel}. Migrating existing clips…`, 'info', 0);
    const { migrated, skipped, failed } = await narrationCache.migrateInlineClipsToDisk(state.get('steps') || []);

    // Build a result message tuned to what actually happened. The most
    // common confusing case is "0 migrated, N skipped" — happens when the
    // project only has fast OS voices, which by design never disk-cache.
    let msg, level;
    if (failed) {
      msg = `Cache folder set — ${migrated} moved, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}.`;
      level = 'warning';
    } else if (migrated && skipped) {
      msg = `Cache folder ready — ${migrated} clip(s) moved to disk, ${skipped} stayed inline (fast OS voices skip disk cache by design).`;
    } else if (migrated) {
      msg = `Cache folder ready — ${migrated} clip(s) moved to disk.`;
    } else if (skipped) {
      msg = `Cache folder ready, but nothing to migrate — your ${skipped} cached clip(s) all use fast OS voices, which skip disk cache by design. Switch to a Kokoro voice and the cache will fill.`;
    } else {
      msg = `Audio cache folder set: ${rel}. No cached clips yet — synth will populate it.`;
    }
    setStatus(msg, level);
    // Stamp the human-readable manifest at the top of the cache folder.
    await narrationCache.writeReadme().catch(() => {});
    _refreshCacheSummary();
  });

  btnClear.addEventListener('click', () => {
    if (!state.get('audioCacheFolder')) return;
    state.setState({ audioCacheFolder: null });
    state.markDirty();
    setStatus('Audio cache folder cleared — new clips will inline into project file.');
    _renderCacheState();
  });

  btnPurgeStale.addEventListener('click', async () => {
    if (!narrationCache.isCacheEnabled()) {
      setStatus('No cache folder set — nothing to purge.', 'warning');
      return;
    }
    btnPurgeStale.disabled = true;
    setStatus('Purging inactive voice folders…', 'info', 0);
    try {
      const r = await narrationCache.purgeInactiveVoices(state.get('steps') || []);
      if (r.deletedFolders || r.clearedSteps) state.markDirty();
      setStatus(`Purged ${r.deletedFolders} inactive folder(s); ${r.clearedSteps} step(s) reset to text-only.`);
    } catch (err) {
      setStatus(`Purge failed: ${err.message}`, 'danger');
    } finally {
      btnPurgeStale.disabled = false;
      _refreshCacheSummary();
    }
  });

  btnPurgeAll.addEventListener('click', async () => {
    if (!narrationCache.isCacheEnabled()) {
      setStatus('No cache folder set — nothing to purge.', 'warning');
      return;
    }
    if (!window.confirm('Delete EVERYTHING inside the audio cache folder?\n\nAll clips will need to re-synth on next play / export.')) return;
    btnPurgeAll.disabled = true;
    setStatus('Wiping audio cache…', 'info', 0);
    try {
      const r = await narrationCache.purgeAll(state.get('steps') || []);
      if (r.deletedFolders || r.deletedFiles || r.clearedSteps) state.markDirty();
      setStatus(`Wiped cache — ${r.deletedFolders} folder(s), ${r.deletedFiles} loose file(s); ${r.clearedSteps} step(s) reset.`);
    } catch (err) {
      setStatus(`Wipe failed: ${err.message}`, 'danger');
    } finally {
      btnPurgeAll.disabled = false;
      _refreshCacheSummary();
    }
  });

  // Re-render on project save (projectPath becomes available) and on load.
  state.on('change:projectPath',     _renderCacheState);
  state.on('change:audioCacheFolder', _renderCacheState);
  // Refresh the cache folder's manifest after every successful save so the
  // README reflects the saved-state truth (active voice, current sub-folders).
  state.on('project:saved', () => {
    narrationCache.writeReadme().catch(() => {});
    _refreshCacheSummary();
  });
}

/**
 * Express `picked` as a path relative to `base` when possible (no `..`
 * traversal, same drive). Otherwise return the absolute path unchanged.
 * Tolerates mixed slash styles on Windows.
 */
function _toRelative(base, picked) {
  if (!base || !picked) return picked || '';
  const norm = s => s.replace(/\\/g, '/').replace(/\/$/, '');
  const b = norm(base);
  const p = norm(picked);
  if (p === b)              return '.';
  if (p.startsWith(b + '/')) return p.slice(b.length + 1);
  return p;   // outside project dir — keep absolute
}

/**
 * Voice or speed changed at the project level — drop all cached audio
 * blobs on steps so the next preview / export re-synthesizes with the
 * new settings. Leaves the narration TEXT untouched.
 */
function _invalidateAllNarrationClips() {
  const steps = state.get('steps') || [];
  let changed = 0;
  for (const s of steps) {
    // Either inline (dataUrl) or disk-cached (dataFile) clips need to go —
    // the new voice/speed pair gets a different SHA-1, and the old WAV
    // becomes a harmless orphan in the cache folder.
    if (s.narration?.dataUrl || s.narration?.dataFile) {
      s.narration = { text: s.narration.text || '' };
      changed++;
    }
  }
  if (changed) {
    state.markDirty();
    setStatus(`Voice settings changed — ${changed} cached clip(s) cleared.`);
  }
}

// ── Export tab: run export via the shared video-export pipeline ─────────────

let _exportTabCtrl = null;   // AbortController, null when idle

async function _onExportTabStart() {
  if (_exportTabCtrl) return;                     // already running
  _exportTabCtrl = new AbortController();

  const startBtn  = document.getElementById('btn-export');
  const cancelBtn = document.getElementById('btn-export-cancel');
  const statusEl  = document.getElementById('exp-status');
  if (startBtn)  startBtn.disabled  = true;
  if (cancelBtn) cancelBtn.disabled = false;

  const set = (txt) => { if (statusEl) statusEl.textContent = txt; };
  const exp = state.get('export') || {};
  const fileBase = (exp.fileName || 'sbs_export').replace(/\s+/g, '_');

  try {
    set('Preparing…');
    await steps.flushSync();

    // exportTimelineVideo handles pre-synthesis internally now — every export
    // entry point (timeline button, Export tab) gets the missing-clip pass.

    const { blob, extension, codec } = await exportTimelineVideo({
      format:           exp.outputFormat || 'mp4',
      fps:              Number(exp.fps) || 30,
      stepHoldMs:       Number(exp.stepHoldMs) || 800,
      includeNarration: exp.narrationEnabled !== false,
      offline:          !!exp.offlineRender,
      signal:           _exportTabCtrl.signal,
      onProgress: ({ current, total, stepName }) => {
        set(`Step ${current}/${total}: ${stepName}`);
      },
    });

    set(`Encoding finished (${codec?.toUpperCase()}) — downloading ${(blob.size / 1e6).toFixed(1)} MB`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(blob, `${fileBase}-${stamp}.${extension}`);
    set(`Done. Saved ${fileBase}-${stamp}.${extension} (${(blob.size / 1e6).toFixed(1)} MB, ${codec?.toUpperCase()}).`);
    setStatus(`Exported ${extension.toUpperCase()} / ${codec?.toUpperCase()} (${(blob.size / 1e6).toFixed(1)} MB).`);
  } catch (err) {
    if (err?.name === 'AbortError') { set('Cancelled.'); setStatus('Export cancelled.', 'warning'); }
    else {
      console.error('Export failed:', err);
      set(`Failed: ${err.message}`);
      setStatus(`Export failed: ${err.message}`, 'danger');
    }
  } finally {
    _exportTabCtrl = null;
    if (startBtn)  startBtn.disabled  = false;
    if (cancelBtn) cancelBtn.disabled = true;
  }
}

function _onExportTabCancel() {
  if (_exportTabCtrl) _exportTabCtrl.abort();
}


// ── Util ──────────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

export { expandPathToNode };
