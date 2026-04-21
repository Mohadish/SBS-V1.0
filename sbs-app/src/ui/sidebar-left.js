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
}                          from '../io/project.js';
import { initTree, renderTree, expandPathToNode, collapseAll } from './tree.js';
import { setStatus }       from './status.js';
import { createCameraView, generateId, APP_VERSION, APP_RELEASED } from '../core/schema.js';
import { buildNodeMap }    from '../core/nodes.js';
import { showContextMenu } from './context-menu.js';
import { renderAnimationTab } from './animation-tab.js';

const TABS = ['files', 'tree', 'colors', 'select', 'cameras', 'animation', 'export'];
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
  state.on('change:projectDirty',          () => { if (_activeTab === 'files')    _renderFilesTab(); });
  state.on('change:selectionOutlineColor', () => { if (_activeTab === 'select')   _renderSelectTab(); });
  state.on('change:animationPresets',      () => { if (_activeTab === 'animation') _renderAnimTab(); });

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
    case 'export':    _renderExportTab();  break;
  }
}

function _renderAnimTab() {
  renderAnimationTab(_panel('animation'));
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
        Load STEP / OBJ / STL / GLTF
        <input type="file" id="model-file-input"
               accept=".step,.stp,.iges,.igs,.brep,.obj,.stl,.gltf,.glb" multiple />
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

    let modelSpecIndex = 0;

    for (const { assetEntry, resolvedPath } of resolvedAssets) {
      setStatus(`Loading ${assetEntry.name}…`, 'info', 0);
      let modelNode = null;

      const userFile = userFiles.get(assetEntry.id);

      if (userFile) {
        // User-provided via dialog (web re-link or Electron re-link)
        modelNode = await _loadModelFile(userFile, assetEntry, true);
      } else if (isElectron && resolvedPath && window.sbsNative?.readFile) {
        // Electron auto-load from saved path
        const result = await window.sbsNative.readFile(resolvedPath, 'base64');
        if (result?.ok) {
          const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
          modelNode = await _loadModelFile(new File([bytes], assetEntry.name), assetEntry, true);
        }
      }

      // Track asset status
      _assetStatus.set(assetEntry.id, modelNode ? 'ok' : 'missing');

      const specNode = savedSceneRoot?.children?.[modelSpecIndex]
                    ?? assetEntry._legacyTreeSpec
                    ?? null;

      if (modelNode) {
        // Remap freshly-generated IDs → saved IDs from project spec
        if (specNode) {
          const idMap = buildIdRemapFromSpec(modelNode, specNode);
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
        }
      } else if (specNode) {
        // ❌ Missing asset — insert phantom tree nodes from saved spec so steps still work
        _insertPhantomNodes(specNode, assetEntry.id);
      }

      modelSpecIndex++;
    }

    // Restore saved color assignments + defaults (base state before any step)
    const savedDefaults    = project.colors?.defaults    || {};
    const savedAssignments = project.colors?.assignments || savedDefaults;
    materials.meshDefaultColors    = { ...savedDefaults };
    materials.meshColorAssignments = { ...savedAssignments };
    materials.applyAll();

    // Activate first step → restores per-step color overrides + visibility + camera
    const allSteps = state.get('steps');
    if (allSteps?.length) {
      steps.activateStep(allSteps[0].id, false);
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
    id:           specNode.id,
    name:         specNode.name || 'Unknown',
    type:         specNode.type || 'folder',
    missing:      true,
    localVisible: true,
    object3d:     null,
    children:     (specNode.children || []).map(_cloneSpecAsPhantom),
  };
  return node;
}

function _insertPhantomNodes(specNode, assetId) {
  const phantom  = _cloneSpecAsPhantom(specNode);
  const root     = state.get('treeData');
  if (!root) return;
  root.children  = root.children || [];
  root.children.push(phantom);
  const nodeById = buildNodeMap(root);
  state.setState({ treeData: { ...root }, nodeById });
  if (assetId) _phantomNodes.set(assetId, phantom);
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
 * 3. Remove phantom from tree
 * 4. Restore colors + reactivate current step
 */
async function _relinkAsset(file, assetEntry) {
  const phantom = _phantomNodes.get(assetEntry.id);

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

    // Remove phantom from tree
    const root = state.get('treeData');
    if (root) {
      root.children = (root.children || []).filter(c => c !== phantom);
      const nodeById = buildNodeMap(root);
      state.setState({ treeData: { ...root }, nodeById });
    }
    _phantomNodes.delete(assetEntry.id);
  }

  // Re-apply saved default + assignment colors to newly loaded meshes
  materials.applyAll();

  // Reactivate current step to restore step-level color overrides
  const activeStep = state.get('activeStepId');
  if (activeStep) steps.activateStep(activeStep, false);
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
  const root       = state.get('treeData');
  const selectedId = state.get('selectedId');
  const nodeById   = state.get('nodeById');
  if (!root) { setStatus('Load a model first.'); return; }

  const name = prompt('Folder name:', 'New Group');
  if (!name?.trim()) return;

  // Choose parent
  let parent = selectedId && nodeById ? nodeById.get(selectedId) : null;
  if (!parent || parent.type === 'mesh') parent = root;

  const THREE = window.THREE;
  if (!THREE) return;

  const group = new THREE.Group();
  group.name  = name.trim();
  group.userData.isCustomFolder = true;

  const node = {
    id: generateId('folder'), name: name.trim(), type: 'folder',
    localVisible: true, object3d: group, children: [],
    localOffset: [0,0,0], localQuaternion: [0,0,0,1],
    pivotLocalOffset: [0,0,0], pivotLocalQuaternion: [0,0,0,1],
    baseLocalPosition: [0,0,0], baseLocalQuaternion: [0,0,0,1], baseLocalScale: [1,1,1],
    moveEnabled: true, rotateEnabled: true, pivotEnabled: true,
  };

  parent.children.push(node);
  if (parent.object3d) parent.object3d.add(group);

  state.setState({ nodeById: buildNodeMap(root) });
  expandPathToNode(node.id);
  steps.scheduleSync();
  setStatus(`Created folder "${node.name}".`);
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
    // Patch step snapshots
    const allSteps = state.get('steps') || [];
    let stepsDirty = false;
    for (const step of allSteps) {
      const mats = step.snapshot?.materials;
      if (!mats) continue;
      for (const meshId of missingIds) {
        if (mats[meshId] === preset.id) { mats[meshId] = newId; stepsDirty = true; }
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

  el.innerHTML = `
    <div class="section">
      <div class="title">Camera Setup</div>
      <div class="grid2" style="margin-top:8px;">
        <input type="text" id="cam-name-input" placeholder="View name" />
        <button class="btn" id="btn-save-cam">Save Current</button>
      </div>
      <div id="cam-list" class="small muted" style="margin-top:8px;">No saved views.</div>
    </div>
  `;

  el.querySelector('#btn-save-cam').addEventListener('click', () => {
    const nameEl = el.querySelector('#cam-name-input');
    const name = (nameEl?.value.trim()) || `View ${views.length + 1}`;
    const cs = sceneCore.getCameraState();
    const view = createCameraView({ name, ...cs });
    state.setState({ cameraViews: [...views, view] });
    state.markDirty();
    setStatus(`Saved view "${view.name}".`);
    if (nameEl) nameEl.value = '';
    _renderCamerasTab();
  });

  const list = el.querySelector('#cam-list');
  if (views.length === 0) return;
  list.innerHTML = '';

  for (const view of views) {
    const item = document.createElement('div');
    item.className = 'cameraItem';
    item.innerHTML = `
      <div class="cameraRow">
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(view.name)}</span>
      </div>
      <div class="cameraActions">
        <button class="btn" data-goto="${_esc(view.id)}">▶ Go To</button>
        <button class="btn" data-del="${_esc(view.id)}">🗑 Delete</button>
      </div>
    `;
    item.querySelector('[data-goto]').addEventListener('click', e => {
      e.stopPropagation();
      sceneCore.animateCameraTo({
        position: view.position, quaternion: view.quaternion,
        pivot: view.pivot, up: view.up, fov: view.fov,
      }, 800, 'smooth');
    });
    item.querySelector('[data-del]').addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm(`Delete view "${view.name}"?`)) return;
      state.setState({ cameraViews: views.filter(v => v.id !== view.id) });
      state.markDirty();
      _renderCamerasTab();
    });
    list.appendChild(item);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  EXPORT TAB
// ═══════════════════════════════════════════════════════════════════════════

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
          <option value="webm_vp8" ${exp.outputFormat==='webm_vp8'?'selected':''}>WebM VP8</option>
          <option value="webm_vp9" ${exp.outputFormat==='webm_vp9'?'selected':''}>WebM VP9</option>
          <option value="png_seq"  ${exp.outputFormat==='png_seq' ?'selected':''}>PNG Sequence</option>
        </select>

        <label class="small muted" style="display:block;margin-top:10px;">Format preset</label>
        <select id="exp-preset" style="margin-top:8px;">
          <option value="hdtv_1080"   ${exp.formatPreset==='hdtv_1080'   ?'selected':''}>HDTV 1080p (1920 × 1080)</option>
          <option value="hdtv_720"    ${exp.formatPreset==='hdtv_720'    ?'selected':''}>HDTV 720p (1280 × 720)</option>
          <option value="square_1080" ${exp.formatPreset==='square_1080' ?'selected':''}>Square 1080 × 1080</option>
        </select>

        <div class="grid2" style="margin-top:10px;">
          <label class="colorlab">Frame rate (fps)
            <input type="number" id="exp-fps" value="${exp.fps??30}" min="1" max="120" step="1" style="margin-top:6px;" />
          </label>
          <label class="colorlab">Step hold (ms)
            <input type="number" id="exp-hold" value="${exp.stepHoldMs??800}" min="0" max="10000" step="100" style="margin-top:6px;" />
          </label>
        </div>
      </div>

      <div class="grid2" style="margin-top:8px;">
        <button class="btn" id="btn-export">Start Export</button>
        <button class="btn" disabled>Cancel Export</button>
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
    const r = PRESETS[e.target.value] || PRESETS.hdtv_1080;
    state.setExportOption('formatPreset', e.target.value);
    state.setExportOption('width', r.width);
    state.setExportOption('height', r.height);
  });
  el.querySelector('#exp-fps').addEventListener('change', e =>
    state.setExportOption('fps', Number(e.target.value)));
  el.querySelector('#exp-hold').addEventListener('change', e =>
    state.setExportOption('stepHoldMs', Number(e.target.value)));
  el.querySelector('#btn-export').addEventListener('click', () =>
    setStatus('Export not yet implemented in this build.', 'warn'));
}


// ── Util ──────────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

export { expandPathToNode };
