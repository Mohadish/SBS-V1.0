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
import {
  createCameraView, generateId, APP_VERSION, APP_RELEASED,
  createAnimationPreset, DEFAULT_ANIMATION_PRESET_STRING,
} from '../core/schema.js';
import { buildNodeMap }    from '../core/nodes.js';
import { applyNodeSourceTransformToObject3D } from '../core/transforms.js';
import { showContextMenu } from './context-menu.js';
import { undoManager }    from '../systems/undo.js';

/**
 * V0.2.10: scene-selection change wrapped as an undo entry. Used by the
 * Colors-tab right-click "Select by..." actions (active color / default
 * color / all selected colors), which previously mutated scene selection
 * directly with no undo trail. One entry per call, no coalescing.
 */
function _setSceneSelectionUndoable(target, multi, label) {
  const prevId    = state.get('selectedId');
  const prevMulti = new Set(state.get('multiSelectedIds') || []);
  const nextMulti = multi instanceof Set ? multi : new Set(multi || []);
  state.setSelection(target, nextMulti);
  undoManager.push(label,
    () => state.setSelection(prevId, new Set(prevMulti)),
    () => state.setSelection(target, new Set(nextMulti)),
  );
}

/**
 * V0.2.13: shared verb for the "Select by..." live labels. Tri-state
 * driven by modifier keys (Alt wins over Ctrl):
 *   Alt held       → "Remove from selected by"
 *   Ctrl/⌘ held    → "Add to selected by"
 *   neither        → "Select by"
 */
function _selectVerb(m) {
  if (m && m.alt)                  return 'Remove from selected by';
  if (m && (m.ctrl || m.meta))     return 'Add to selected by';
  return 'Select by';
}

/**
 * V0.2.13: apply a "Select by …" menu action against a precomputed mesh
 * id array, branching on the click-time modifier state (alt → remove from
 * scene selection; ctrl/⌘ → add; none → replace). Pushes one undo entry
 * with a label that matches the action variant; clears scene selection
 * when the resulting multi-set is empty.
 */
function _runSelectByMatches(matches, m, contextLabel) {
  const alt = !!(m && m.alt);
  const add = !alt && !!(m && (m.ctrl || m.meta));
  const cur = new Set(state.get('multiSelectedIds') || []);
  let next, verb;
  if (alt) {
    next = cur;
    for (const id of matches) next.delete(id);
    verb = 'Remove';
  } else if (add) {
    next = new Set([...cur, ...matches]);
    verb = 'Add';
  } else {
    next = new Set(matches);
    verb = 'Select';
  }
  const prevId   = state.get('selectedId');
  const inNext   = (id) => id && next.has(id);
  const primary  = next.size === 0 ? null
                 : inNext(prevId)  ? prevId
                 : (matches[0] || [...next][0]);
  _setSceneSelectionUndoable(primary, next, `${verb} by ${contextLabel}`);
  setStatus(`${verb === 'Remove' ? 'Removed' : verb === 'Add' ? 'Added' : 'Selected'} ${matches.length} mesh(es) (${contextLabel}).`);
}
import { renderAnimationTab } from './animation-tab.js';
import { renderHeaderTab }    from './header-tab.js';
import { renderStyleTab }     from './style-tab.js';
import { renderCableTab }     from './cable-tab.js';
import { exportTimelineVideo, downloadBlob } from '../systems/video-export.js';
import { listVoices as ttsListVoices } from '../systems/tts.js';
import * as userSettings    from '../core/user-settings.js';
import * as narrationCache  from '../systems/narration-cache.js';

const TABS = ['files', 'tree', 'colors', 'select', 'cameras', 'animation', 'header', 'style', 'cables', 'notes', 'shapes', 'undo', 'export'];
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
      <button class="tabBtn"        data-tab="notes">💬</button>
      <button class="tabBtn"        data-tab="shapes">▰</button>
      <button class="tabBtn"        data-tab="undo">↶</button>
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

  // V0.2.8: Ctrl+L-drag marquee in the Colors list (Shift+click was hard to
  // use; the marquee makes range selection visual). Each intersected row is
  // toggled in/out of the tab selection (per-bar add/remove).
  _setupColorMarquee();

  // State subscriptions
  state.on('change:assets',                () => { if (_activeTab === 'files')   _renderFilesTab(); });
  state.on('change:treeData',              () => { if (_activeTab === 'tree')    renderTree(); });
  state.on('change:colorPresets',          _queueColorsRender);
  state.on('materials:defaultColorsChanged', _queueColorsRender);
  state.on('change:selectedId',            _queueColorsRender);
  state.on('change:multiSelectedIds',      () => {
    if (_activeTab === 'colors') _queueColorsRender();
    if (_activeTab === 'select') _renderSelectTab();   // refresh "+ Save (N)" button + counters
  });
  // Colors-tab filter + the "used-by-visible / used-by-selection" cues depend
  // on live mesh visibility, which changes on visibility toggles (treeData)
  // and step navigation (step:applied).
  state.on('change:colorTabFilterVisibleOnly',    _queueColorsRender);
  state.on('change:colorTabFilterSelectedFirst',  _queueColorsRender);
  // V0.2.6: re-render when the tab selection itself changes (e.g. r-click
  // "Invert color selection" — previously needed an extra click to redraw).
  state.on('change:selectedColorPresetIds',       _queueColorsRender);
  // V0.2.16: keep the Undo tab's stack lists live.
  state.on('undo:change',                         () => { if (_activeTab === 'undo') _renderUndoTab(); });
  // Expanded-color viewport highlight stays live across selection / step /
  // visibility changes even when the user has switched away from the tab.
  state.on('change:selectedId',          _syncExpandedColorHighlight);
  state.on('change:multiSelectedIds',    _syncExpandedColorHighlight);
  state.on('step:applied',               _syncExpandedColorHighlight);
  state.on('change:treeData',            _syncExpandedColorHighlight);
  state.on('materials:defaultColorsChanged', _syncExpandedColorHighlight);
  state.on('change:colorPresets',        _syncExpandedColorHighlight);
  state.on('step:applied',                 () => { if (_activeTab === 'colors') _queueColorsRender(); });
  state.on('change:treeData',              () => { if (_activeTab === 'colors') _queueColorsRender(); });
  // Flush any deferred Colors-tab render once focus leaves an interactive
  // element inside the tab — keeps the user's open <input type=color>
  // popup alive while they drag, and re-renders cleanly once they're done.
  document.addEventListener('focusout', () => {
    if (_activeTab !== 'colors') return;
    requestAnimationFrame(() => {
      if (_colorsRenderQueued && !_shouldDeferColorsRender()) {
        _colorsRenderQueued = false;
        _renderColorsTab();
      }
    });
  });
  state.on('change:selectionGroups',       () => { if (_activeTab === 'select')   _renderSelectTab(); });
  state.on('change:notePresets',                  () => { if (_activeTab === 'notes')    _renderNotesTab();  });
  state.on('change:treeData',                     () => { if (_activeTab === 'notes')    _renderNotesTab();  });
  state.on('change:noteTemplates',                () => { if (_activeTab === 'notes')    _renderNotesTab();  });
  state.on('change:noteTemplateInstantiationId',  () => { if (_activeTab === 'notes')    _renderNotesTab();  });
  state.on('change:cameraViews',           () => { if (_activeTab === 'cameras')   _renderCamerasTab(); });
  // Step bindings live on step.cameraBinding — when the active step
  // changes, or when any step's binding updates, the Cameras tab needs
  // to re-render so the "used by N steps" + "active-bound" indicators
  // stay accurate.
  state.on('change:activeStepId',          () => { if (_activeTab === 'cameras')   _renderCamerasTab(); });
  state.on('change:steps',                 () => { if (_activeTab === 'cameras')   _renderCamerasTab(); });
  state.on('change:projectDirty',          () => { if (_activeTab === 'files')    _renderFilesTab(); });
  state.on('change:theme',                 () => { if (_activeTab === 'files')    _renderFilesTab(); });
  state.on('change:backgroundColor',       () => { if (_activeTab === 'files')    _renderFilesTab(); });
  state.on('change:backgroundGradient',    () => {
    // Refresh only when the toggle's enabled state changes (input/range
    // events otherwise re-render on every drag tick which destroys the
    // active <input type=color> popup mid-edit).
    if (_activeTab !== 'files') return;
    const el = _panel('files');
    const liveEnabled = !!state.get('backgroundGradient')?.enabled;
    const checkbox = el?.querySelector('#bg-grad-toggle');
    if (checkbox && checkbox.checked !== liveEnabled) _renderFilesTab();
  });
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
  // Shapes tab — refresh on template list changes, draw-mode toggles,
  // and tree changes (so per-template instance counts stay live).
  state.on('change:shapeTemplates',      () => { if (_activeTab === 'shapes') _renderShapesTab(); });
  state.on('change:shapeDrawing',        () => { if (_activeTab === 'shapes') _renderShapesTab(); });
  state.on('change:treeData',            () => { if (_activeTab === 'shapes') _renderShapesTab(); });
  state.on('change:shapePlacementForId', () => { if (_activeTab === 'shapes') _renderShapesTab(); });
  state.on('change:shapeFromFacePicking',() => { if (_activeTab === 'shapes') _renderShapesTab(); });
  // V0.1.85 — shape tab additions: groups, tab selection, filter toggle,
  // and visibility-driven filter rendering refresh.
  state.on('change:shapeTemplateGroups',           () => { if (_activeTab === 'shapes') _renderShapesTab(); });
  state.on('change:selectedShapeTemplateIds',      () => { if (_activeTab === 'shapes') _renderShapesTab(); });
  state.on('change:selectedShapeTemplateGroupIds', () => { if (_activeTab === 'shapes') _renderShapesTab(); });
  state.on('change:shapeTabFilterVisibleOnly',     () => { if (_activeTab === 'shapes') _renderShapesTab(); });
  // Selection changes trigger a Shapes-tab re-render only when that tab
  // is active, so the highlight on the currently-selected flatShape's
  // template row stays in sync. Also covers the V0.1.85 visibility filter
  // (rows refresh when per-instance localVisible flips via select-driven
  // toggleVisibility paths).
  state.on('selection:change',           () => { if (_activeTab === 'shapes') _renderShapesTab(); });

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

/**
 * Switch to the Colors tab and expand the preset currently assigned to
 * a given mesh / flatShape node at the active step. Called from the
 * tree's right-click menu ("Show color").
 *
 * Resolution chain (matches materials.applyAll):
 *   meshColorAssignments[id]  →  meshDefaultColors[id]  →  null
 *
 * If a preset is found, it gets expanded in the colors list so the
 * user lands directly on the relevant color card. If nothing is
 * assigned (e.g. a freshly-imported model with no presets yet), the
 * tab still switches and the user can browse presets manually.
 */
export function showColorForNode(nodeId) {
  if (!nodeId) return;
  const activeId = materials.meshColorAssignments?.[nodeId]
                ?? materials.meshDefaultColors?.[nodeId]
                ?? null;
  if (activeId) {
    _colorAnchorId = activeId;
    state.setState({ selectedColorPresetIds: new Set([activeId]) });
  }
  if (_activeTab === 'colors') {
    _queueColorsRender();   // tab already open — force re-render to apply expand
  } else {
    _switchTab('colors');
  }
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
    case 'notes':     _renderNotesTab();   break;
    case 'shapes':    _renderShapesTab();  break;
    case 'undo':      _renderUndoTab();    break;
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
        <button class="btn" id="btn-toggle-theme">Theme: ${state.get('theme') === 'light' ? 'Light' : 'Dark'}</button>
      </div>
    </div>

    <div class="section" id="bg-settings-section">
      <div class="title">Background</div>
      <div class="field-row" style="margin-top:8px;">
        <label class="small" style="flex:1;">Solid color</label>
        <input type="color" id="bg-color"
               value="${_esc(state.get('backgroundColor') || '#0f172a')}"
               style="width:44px;height:28px;padding:2px;border-radius:4px;cursor:pointer;" />
      </div>
      <label class="small" style="display:flex;align-items:center;gap:6px;margin-top:8px;cursor:pointer;">
        <input type="checkbox" id="bg-grad-toggle"
               ${state.get('backgroundGradient')?.enabled ? 'checked' : ''} />
        Use 2-color gradient
      </label>
      <div id="bg-grad-controls"
           style="display:${state.get('backgroundGradient')?.enabled ? 'block' : 'none'};margin-top:8px;">
        <div class="field-row">
          <label class="small" style="flex:1;">From</label>
          <input type="color" id="bg-grad-c1"
                 value="${_esc(state.get('backgroundGradient')?.color1 || '#0f172a')}"
                 style="width:44px;height:28px;padding:2px;border-radius:4px;cursor:pointer;" />
        </div>
        <div class="field-row" style="margin-top:6px;">
          <label class="small" style="flex:1;">To</label>
          <input type="color" id="bg-grad-c2"
                 value="${_esc(state.get('backgroundGradient')?.color2 || '#1e293b')}"
                 style="width:44px;height:28px;padding:2px;border-radius:4px;cursor:pointer;" />
        </div>
        <label class="small" style="display:block;margin-top:8px;">
          Direction <span id="bg-grad-angle-val" class="muted" style="float:right;">${state.get('backgroundGradient')?.angleDeg ?? 180}°</span>
          <input type="range" id="bg-grad-angle" min="0" max="360" step="1"
                 value="${state.get('backgroundGradient')?.angleDeg ?? 180}"
                 style="width:100%;margin-top:4px;" />
        </label>
        <div class="small muted" style="margin-top:4px;line-height:1.4;font-size:10px;">
          0° top→bottom · 90° left→right · 180° bottom→top · 270° right→left
        </div>
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

  // ── Background controls (undoable; change:* listener repaints on restore) ─
  el.querySelector('#bg-color')?.addEventListener('input', e => {
    const val = e.target.value;
    actions.commitStateChange('Background color', ['backgroundColor'], () => {
      state.setState({ backgroundColor: val });
      state.markDirty();
    }, { coalesceKey: 'bgColor' });
  });
  const _setGradient = (patch) => {
    actions.commitStateChange('Background gradient', ['backgroundGradient'], () => {
      const cur = state.get('backgroundGradient') || {};
      state.setState({ backgroundGradient: { ...cur, ...patch } });
      state.markDirty();
    }, { coalesceKey: 'bgGradient' });
  };
  const gradControls = el.querySelector('#bg-grad-controls');
  el.querySelector('#bg-grad-toggle')?.addEventListener('change', e => {
    _setGradient({ enabled: !!e.target.checked });
    if (gradControls) gradControls.style.display = e.target.checked ? 'block' : 'none';
  });
  el.querySelector('#bg-grad-c1')?.addEventListener('input', e => _setGradient({ color1: e.target.value }));
  el.querySelector('#bg-grad-c2')?.addEventListener('input', e => _setGradient({ color2: e.target.value }));
  const angleInput = el.querySelector('#bg-grad-angle');
  const angleVal   = el.querySelector('#bg-grad-angle-val');
  angleInput?.addEventListener('input', e => {
    const a = Number(e.target.value);
    if (angleVal) angleVal.textContent = `${a}°`;
    _setGradient({ angleDeg: a });
  });

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

  // Pull user-default background from prefs so new projects inherit it.
  const us = userSettings.get();
  const bgColor = us.scene?.defaultBackgroundColor || '#0f172a';
  const bgGrad  = us.scene?.defaultBackgroundGradient
    ? { ...us.scene.defaultBackgroundGradient }
    : { enabled:false, color1:'#0f172a', color2:'#1e293b', angleDeg:180 };

  // Bootstrap a "Default" animation preset for every new project — the
  // visual capsule editor in the Animation tab expects every project to
  // have at least one preset with all action channels present. See
  // _migrateAnimationPresets in io/project.js for the load-path twin.
  const defaultAnim = createAnimationPreset({
    name:      'Default',
    animation: DEFAULT_ANIMATION_PRESET_STRING,
    isDefault: true,
  });

  state.setState({
    projectPath: null, projectName: 'Untitled', projectDirty: false,
    assets: [], treeData: null, nodeById: new Map(),
    steps: [], chapters: [], activeStepId: null,
    cameraViews: [], colorPresets: [], selectedId: null,
    multiSelectedIds: new Set(),
    animationPresets: [defaultAnim],
    backgroundColor:    bgColor,
    backgroundGradient: bgGrad,
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
    // RM-converted models (type='replaceModel' + originalType='model') still
    // need their GLB loaded — include them via the originalType check.
    const _isModelOrRMModel = (n) => n?.type === 'model'
      || (n?.type === 'replaceModel' && n?.originalType === 'model');
    if (resolvedAssets.length === 0 && savedSceneRoot?.children?.length) {
      savedSceneRoot.children
        .filter(_isModelOrRMModel)
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

    // Model-type spec nodes — includes RM-converted models (B.2-NEW) so
    // their geometry actually gets imported on reload. Without the
    // originalType check, an RM-model's GLB would re-load but no spec
    // would attach to the freshly-imported meshes → fresh IDs orphaned
    // → entire model renders as bbox placeholders. Skip custom user-
    // created folders at scene root either way.
    const savedModelSpecs = (savedSceneRoot?.children || [])
      .filter(_isModelOrRMModel);

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

    // Defensive: re-apply archived flags from the saved tree spec.
    // applySpecFieldsToNodes already did this in-loop, but other
    // load-time flows can disturb node state, and the initial tree
    // render fires BEFORE archive flags settle — leaving origin nodes
    // that the user archived (e.g., via "Archive and replace") visually
    // un-archived on reload. Forcing a walk + emit closes the gap.
    if (savedSceneRoot) {
      const nbm = state.get('nodeById');
      (function applyArch(spec) {
        if (!spec) return;
        const live = nbm?.get(spec.id);
        if (live) live.archived = spec.archived === true;
        for (const c of (spec.children || [])) applyArch(c);
      })(savedSceneRoot);
      state.emit('change:treeData', state.get('treeData'));
    }

    // Stage scene from Step 0 (exact saved scene state), then activate first user step
    steps.activateBaseStep();

    // Replace-Model post-load rebuild (B.2-NEW.2.5). Wraps each RM's
    // original mesh in a Group + re-clones every child's source object3d
    // into the wrap-group.
    //
    // Order matters: this runs AFTER activateBaseStep because the
    // flatShape-origin RMs need their underlying Mesh built first (via
    // ensureFlatShapeObject3D inside rebuildFromTreeSpec). Before that,
    // steps.object3dById has no entry for the RM and the wrap can't
    // happen. mesh-origin RMs work the same way — their mesh is built
    // during model import, which finishes before this line.
    //
    // Subsequent step navigations preserve the wrap-group via
    // rebuildFromTreeSpec's "skip rebuild when already wrapped" check.
    try { actions.rebuildReplaceModelChildren?.(); }
    catch (err) { console.warn('[replaceModel] post-load rebuild failed:', err); }

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
  // Notes are GLOBAL data layers, not per-asset placeholders. They
  // never need a "missing" flag — even when the host mesh is a phantom,
  // the note carries the user's words and should restore verbatim.
  // Spread-clone preserves all note fields (text, anchorLocal,
  // anchorBboxRelative, panelOffset, sizePresetId, customFontSize, …).
  if (specNode.type === 'note') {
    return {
      ...specNode,
      missing:  false,
      object3d: null,
      children: [],
    };
  }
  // Flat shapes (M1 — 2D shapes in 3D) carry their own geometry data
  // (shapePath + fill + transforms). Preserve every field verbatim so
  // systems/flat-shapes.js can rebuild the THREE.Mesh on first
  // rebuildFromTreeSpec pass; not "missing" in the asset sense.
  if (specNode.type === 'flatShape') {
    return {
      ...specNode,
      missing:  false,
      object3d: null,
      children: (specNode.children || []).map(_cloneSpecAsPhantom),
    };
  }
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
  // Preserve folder transform fields so an SVG-import folder loaded from
  // a saved project keeps any user-applied move / rotate / pivot.
  if (specNode.type === 'folder') {
    if (Array.isArray(specNode.localOffset))         node.localOffset         = specNode.localOffset;
    if (Array.isArray(specNode.localQuaternion))     node.localQuaternion     = specNode.localQuaternion;
    if (Array.isArray(specNode.orientationSteps))    node.orientationSteps    = specNode.orientationSteps;
    if (Array.isArray(specNode.baseLocalQuaternion)) node.baseLocalQuaternion = specNode.baseLocalQuaternion;
    if (Array.isArray(specNode.pivotLocalOffset))    node.pivotLocalOffset    = specNode.pivotLocalOffset;
    if (Array.isArray(specNode.pivotLocalQuaternion))node.pivotLocalQuaternion= specNode.pivotLocalQuaternion;
    if (typeof specNode.moveEnabled   === 'boolean') node.moveEnabled   = specNode.moveEnabled;
    if (typeof specNode.rotateEnabled === 'boolean') node.rotateEnabled = specNode.rotateEnabled;
    if (typeof specNode.pivotEnabled  === 'boolean') node.pivotEnabled  = specNode.pivotEnabled;
  }
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
  let root = state.get('treeData');
  // Bootstrap a scene root when the project has no model assets — e.g. an
  // SVG-only project (M1: 2D shapes in 3D).  Otherwise saved custom folders
  // would silently drop on reopen.
  if (!root) {
    root = {
      id:           'scene_root',
      name:         'Scene',
      type:         'scene',
      children:     [],
      object3d:     sceneCore.rootGroup,
      localVisible: true,
    };
    steps.object3dById.set('scene_root', sceneCore.rootGroup);
    state.setState({ treeData: root, nodeById: buildNodeMap(root) });
  }

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

  // Audit folder/model home anchors once the tree is fully rebuilt.
  // Logs to console only — silent if everything is identity (the common
  // case). Loud (orange) if Global Transform mode left non-identity
  // values behind, so the user knows where to look if "Reset transform"
  // doesn't bring something home. See actions.verifyHomePositions().
  try { actions.verifyHomePositions?.(); }
  catch (err) { console.warn('[home-verifier] post-load check failed:', err); }
}

function _onFitAll() {
  if (!window.THREE || !sceneCore.rootGroup) return;
  const box = new THREE.Box3().setFromObject(sceneCore.rootGroup);
  if (box.isEmpty()) return;
  sceneCore.animateCameraTo(sceneCore.fitStateForBox(box, 1.15), 800, 'smooth');
}

function _onToggleGrid() {
  const before = !!state.get('gridVisible');
  const vis    = !before;
  const apply  = (v) => { state.setState({ gridVisible: v }); sceneCore.setGridVisible(v); };
  apply(vis);
  actions.pushSetterUndo(vis ? 'Show grid' : 'Hide grid', apply, before, vis);
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

// Which preset is currently expanded for editing (derived: the sole
// selected preset). Mirrors selectedColorPresetIds when its size === 1.
let _expandedPresetId = null;
// Shift-range anchor for file-manager color-preset selection.
let _colorAnchorId = null;
// V0.2.4: outline-card collapse state. Auto-collapses when the outline is
// turned OFF; user can manually toggle via the ▼ arrow on the header.
let _outlineCollapsed = false;

// ── Ctrl+L-drag marquee in the Colors list (V0.2.8) ─────────────────────
// Replaces the broken Shift+click-range. A Ctrl/⌘ + left-mouse drag inside
// #color-list draws a translucent box; on release, every color row whose
// row rect intersects the box is TOGGLED in/out of the tab selection.
// `_colorMarqueeJustDragged` blocks the click event that fires on the same
// element after release, so the drag's selection isn't clobbered.
let _colorMarqueeJustDragged = false;

function _setupColorMarquee() {
  const panel = _panel('colors');
  if (!panel) return;
  let down = null;       // { x, y } on Ctrl+pointerdown
  let box  = null;       // the visual marquee div (created on first move)

  panel.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const list = panel.querySelector('#color-list');
    if (!list || !list.contains(e.target)) return;
    down = { x: e.clientX, y: e.clientY };
    e.preventDefault();
  });
  document.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!box && (dx * dx + dy * dy) < 25) return;   // < 5px threshold = treat as a click
    if (!box) {
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;'
        + 'background:rgba(74,144,217,0.15);border:1px dashed #4A90D9;border-radius:2px';
      document.body.appendChild(box);
    }
    const x1 = Math.min(down.x, e.clientX), y1 = Math.min(down.y, e.clientY);
    const x2 = Math.max(down.x, e.clientX), y2 = Math.max(down.y, e.clientY);
    box.style.left = x1 + 'px'; box.style.top = y1 + 'px';
    box.style.width = (x2 - x1) + 'px'; box.style.height = (y2 - y1) + 'px';
  });
  document.addEventListener('pointerup', () => {
    if (!down) return;
    if (box) {
      const r = box.getBoundingClientRect();
      box.remove(); box = null;
      _colorMarqueeJustDragged = true;
      setTimeout(() => { _colorMarqueeJustDragged = false; }, 60);
      const list = panel.querySelector('#color-list');
      const sel  = new Set(state.get('selectedColorPresetIds') || []);
      let changed = false;
      list?.querySelectorAll('.colorRow[data-preset-id]').forEach(row => {
        const rect = row.getBoundingClientRect();
        if (rect.right < r.left || rect.left > r.right
         || rect.bottom < r.top  || rect.top > r.bottom) return;
        const pid = row.dataset.presetId;
        if (sel.has(pid)) sel.delete(pid); else sel.add(pid);
        changed = true;
      });
      if (changed) {
        actions.setColorSelection(sel);
        _renderColorsTab();
      }
    }
    down = null;
  });
}

/**
 * V0.2.6: viewport highlight bound to the EXPANDED color row. Meshes that
 * use the expanded preset AND are currently scene-selected get a YELLOW
 * hull (visible meshes) or MAGENTA ghost (hidden meshes). Cleared when no
 * color is expanded. Re-runs on selection / step / visibility changes.
 */
function _syncExpandedColorHighlight() {
  if (!_expandedPresetId) { materials.clearExpandedColorHighlight(); return; }
  const sceneSel = new Set();
  const sId = state.get('selectedId');
  if (sId) sceneSel.add(sId);
  const m = state.get('multiSelectedIds');
  if (m instanceof Set) for (const id of m) sceneSel.add(id);
  if (sceneSel.size === 0) { materials.clearExpandedColorHighlight(); return; }
  const ids = new Set();
  for (const [mid, pid] of Object.entries(materials.meshColorAssignments)) {
    if (pid === _expandedPresetId && sceneSel.has(mid)) ids.add(mid);
  }
  for (const [mid, pid] of Object.entries(materials.meshDefaultColors)) {
    if (pid === _expandedPresetId && sceneSel.has(mid)) ids.add(mid);
  }
  materials.applyExpandedColorHighlight([...ids]);
}

/**
 * File-manager click selection for color-preset rows.
 *   plain → replace, Ctrl/⌘ → toggle, Shift → range from the anchor.
 * Selecting exactly one preset opens its edit card (handled in render).
 */
function _onColorRowClick(e, presetId, presets) {
  // Suppress click after a Ctrl+drag marquee just finished — the drag set
  // the selection; the trailing click would clobber it.
  if (_colorMarqueeJustDragged) return;
  // V0.2.8 click rules:
  //   Ctrl/⌘+L-click  → toggle the row in/out of the selection.
  //   Plain L-click on a SELECTED row → only toggle the editor expand;
  //                                     selection untouched.
  //   Plain L-click on an UNSELECTED row → REPLACE selection with just
  //                                        this row (and expand it).
  //   Shift+L-click   → no special handling (range removed; use Ctrl+drag
  //                     marquee instead — see _colorMarquee below).
  let sel = new Set(state.get('selectedColorPresetIds') || []);
  let selChanged = false;
  if (e.ctrlKey || e.metaKey) {
    if (sel.has(presetId)) sel.delete(presetId); else sel.add(presetId);
    _colorAnchorId = presetId;
    selChanged = true;
  } else {
    if (sel.has(presetId)) {
      // Already selected → just toggle expand.
      if (_expandedPresetId === presetId) _expandedPresetId = null;
      else                                _expandedPresetId = presetId;
    } else {
      // Not selected → replace selection with this one (drop everything
      // else, so the rest lose the blue border + leave the ✦ filter).
      sel = new Set([presetId]);
      _expandedPresetId = presetId;
      selChanged = true;
    }
    _colorAnchorId = presetId;
  }
  if (selChanged) actions.setColorSelection(sel);
  _renderColorsTab();
}

// Re-render guard: while the user has focus on any input inside the
// Colors tab (text, color picker, slider, dropdown, …), re-rendering
// the tab destroys the focused element and yanks any open
// <input type=color> popup off-screen. So we DEFER renders triggered
// by state changes during interaction and flush them on focusout.
let _colorsRenderQueued = false;
function _shouldDeferColorsRender() {
  const el = _panel('colors');
  if (!el) return false;
  const a  = document.activeElement;
  if (!a) return false;
  if (!el.contains(a)) return false;
  return ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName);
}
function _queueColorsRender() {
  if (_activeTab !== 'colors') return;
  if (_shouldDeferColorsRender()) {
    _colorsRenderQueued = true;
    return;
  }
  _colorsRenderQueued = false;
  _renderColorsTab();
}

function _renderColorsTab() {
  const el = _panel('colors');
  if (!el) return;

  const presets    = state.get('colorPresets') || [];
  // Tab multi-select (file-manager). The edit card shows only when exactly
  // one preset is selected; `_expandedPresetId` mirrors that sole id so the
  // Assign / Set-default buttons keep a single target.
  const selPresetIds = new Set([...(state.get('selectedColorPresetIds') || [])].filter(id => presets.some(p => p.id === id)));
  // V0.2.4: plain-click in the tab OWNS _expandedPresetId — selection is
  // independent (driven by scene auto-sync + Ctrl/Shift). We just validate
  // the expanded id still references an existing preset.
  if (_expandedPresetId && !presets.some(p => p.id === _expandedPresetId)) _expandedPresetId = null;
  const outline    = state.get('geometryOutline') || {};
  const multiIds   = state.get('multiSelectedIds') || new Set();
  const selId      = state.get('selectedId');
  const nodeById   = state.get('nodeById') || new Map();
  const solidness0 = outline.opacity ?? 0.9;
  const crease0    = outline.creaseAngle ?? 35;

  // Resolve selected nodes that can receive color presets: model meshes,
  // flatShapes (polygon shapes), AND replaceModel containers. RM passes
  // its id through to actions.assignPreset where _expandRMSelection
  // cascades the color to every child copy inside the RM (B.2-NEW.2).
  // Folders / models / scene-root can't receive presets directly.
  const allSelIds = multiIds.size ? Array.from(multiIds) : (selId ? [selId] : []);
  const meshIds   = allSelIds.filter(id => {
    const t = nodeById.get(id)?.type;
    return t === 'mesh' || t === 'flatShape' || t === 'replaceModel';
  });

  // V0.1.99/V0.2.2: presets used by visible meshes (drives the 👁 filter).
  // The "used-by-scene-selection" highlight is gone — that set IS the tab
  // selection now (projectSceneSelectionToColorsTab keeps it synced), so
  // the standard .selected styling already shows the user which colors
  // their scene selection uses, AND r-click → Unify acts on them directly.
  const filterVisible       = !!state.get('colorTabFilterVisibleOnly');
  const filterSelectedFirst = !!state.get('colorTabFilterSelectedFirst');
  const usedByVisible       = new Set();
  // V0.2.4: build the per-preset visibility info AND a "meshes-using-preset"
  // index, so we can score each selected preset into one of 4 states.
  const meshesUsingPreset = new Map();   // pid → Set<meshId>
  const _addUse = (mid, pid) => {
    if (!pid) return;
    if (!meshesUsingPreset.has(pid)) meshesUsingPreset.set(pid, new Set());
    meshesUsingPreset.get(pid).add(mid);
  };
  for (const [mid, pid] of Object.entries(materials.meshColorAssignments)) _addUse(mid, pid);
  for (const [mid, pid] of Object.entries(materials.meshDefaultColors))    _addUse(mid, pid);
  for (const [mid, mesh] of materials.meshById) {
    let vis = true;
    for (let o = mesh; o; o = o.parent) { if (o.visible === false) { vis = false; break; } }
    if (!vis) continue;
    const pid = materials.meshColorAssignments[mid] ?? materials.meshDefaultColors[mid];
    if (pid) usedByVisible.add(pid);
  }
  // Scene-selected mesh ids (for state 1 / 2 detection).
  const sceneSelMeshIds = new Set();
  if (selId) sceneSelMeshIds.add(selId);
  if (multiIds instanceof Set) for (const id of multiIds) sceneSelMeshIds.add(id);

  /**
   * Scene-only state for a preset's background fill (V0.2.9). Independent
   * of tab selection — the background indicates the color's PRESENCE in the
   * viewport, not whether the row is in the tab selection. Returns:
   *   'all'  — every mesh that uses this preset is scene-selected
   *   'some' — ≥1 (but not all) scene-selected
   *   'none' — no scene-selected meshes (or no meshes at all)
   */
  const sceneStateFor = (presetId) => {
    const assoc = meshesUsingPreset.get(presetId);
    if (!assoc || assoc.size === 0) return 'none';
    let inScene = 0;
    for (const id of assoc) if (sceneSelMeshIds.has(id)) inScene++;
    if (inScene === 0) return 'none';
    return inScene === assoc.size ? 'all' : 'some';
  };

  el.innerHTML = `
    <div class="section">
      <div style="position:sticky;top:0;z-index:3;background:var(--bg);padding-bottom:8px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div class="title">Colors</div>
          <div style="display:flex;align-items:center;gap:10px">
            <label class="small muted" style="display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none"
                   title="Float colors used by currently-visible objects to the top; grey out the rest (still clickable).">
              <input type="checkbox" id="color-filter-visible" ${state.get('colorTabFilterVisibleOnly') ? 'checked' : ''}/>
              <span>👁 filter</span>
            </label>
            <label class="small muted" style="display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none"
                   title="Auto-elevate currently-selected colors to the very top of the list.">
              <input type="checkbox" id="color-filter-selected" ${state.get('colorTabFilterSelectedFirst') ? 'checked' : ''}/>
              <span>✦ selected</span>
            </label>
          </div>
        </div>
        <div class="grid2">
          <button class="btn" id="btn-add-preset">+ Add Color</button>
          <button class="btn" id="btn-assign-preset">Assign to Selected</button>
          <button class="btn" id="btn-assign-default" title="Set as permanent default for selected meshes">★ Set as Default</button>
          <button class="btn" id="btn-revert-default" title="Restore each selected mesh to its default color">↩ Revert to Default</button>
        </div>

        <div class="card" style="margin-top:8px">
          <div class="row" id="outline-header" style="margin-top:0;cursor:pointer">
            <span id="outline-collapse-arrow" style="font-size:10px;opacity:0.7;margin-right:4px;width:10px;display:inline-block;text-align:center">${(!outline.enabled || _outlineCollapsed) ? '▶' : '▼'}</span>
            <div class="small" style="flex:1">Global geometry outline</div>
            <button class="toggle${outline.enabled ? ' on' : ''}" id="outline-toggle"><span class="knob"></span></button>
          </div>
          ${(outline.enabled && !_outlineCollapsed) ? `
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
          </div>` : ''}
        </div>
        <div class="small muted" style="margin-top:6px">
          Click to expand • Ctrl-click toggles selection • Shift range • R-click for unify / delete / invert
        </div>
      </div>

      <div id="color-list" style="margin-top:8px">
        <span class="small muted">No color presets yet.</span>
      </div>
    </div>
  `;

  // ── Outline controls (undoable; setter re-applies the scene side-effect) ──
  const _applyOutline = (v) => materials.setGeometryOutline(v);
  const _outlinePatch = (patch, label) => {
    const before = { ...(state.get('geometryOutline') || {}) };
    materials.setGeometryOutline(patch);
    const after  = { ...(state.get('geometryOutline') || {}) };
    actions.pushSetterUndo(label, _applyOutline, before, after, 'geomOutline');
  };
  el.querySelector('#outline-toggle').addEventListener('click', function(e) {
    e.stopPropagation();   // don't let the outline-header collapse toggle fire
    this.classList.toggle('on');
    const enabled = this.classList.contains('on');
    _outlinePatch({ enabled }, 'Toggle geometry outline');
    // Turning OFF → auto-collapse the controls; ON → auto-expand.
    _outlineCollapsed = !enabled;
    _renderColorsTab();
  });
  // ▼ / ▶ arrow on the outline header — manually toggle the controls.
  el.querySelector('#outline-header')?.addEventListener('click', (e) => {
    if (e.target.closest('#outline-toggle')) return;   // toggle handles itself
    _outlineCollapsed = !_outlineCollapsed;
    _renderColorsTab();
  });
  // Only present when expanded — guard with optional chaining.
  el.querySelector('#outline-color')?.addEventListener('input', e =>
    _outlinePatch({ color: e.target.value }, 'Outline color'));
  el.querySelector('#outline-opacity')?.addEventListener('input', e =>
    _outlinePatch({ opacity: Number(e.target.value) }, 'Outline opacity'));
  el.querySelector('#outline-crease')?.addEventListener('input', e =>
    _outlinePatch({ creaseAngle: Number(e.target.value) }, 'Outline crease angle'));

  // ── Add preset ────────────────────────────────────────────────────────────
  el.querySelector('#btn-add-preset').addEventListener('click', () => {
    const p = actions.addColorPreset({ name: `Color ${presets.length + 1}` });
    if (p) {
      _colorAnchorId = p.id;
      state.setState({ selectedColorPresetIds: new Set([p.id]) });
    }
    _renderColorsTab();
  });

  // 👁 filter — float colors used by visible objects to the top. blur()
  // after change so focus leaves the checkbox and the deferred render flushes
  // immediately (without it, _shouldDeferColorsRender held the redraw until
  // the next interaction — the filter looked "frozen" until you clicked
  // something else).
  el.querySelector('#color-filter-visible')?.addEventListener('change', e => {
    state.setState({ colorTabFilterVisibleOnly: e.target.checked });
    e.target.blur();
  });
  // ✦ selected — float currently-selected colors to the very top.
  el.querySelector('#color-filter-selected')?.addEventListener('change', e => {
    state.setState({ colorTabFilterSelectedFirst: e.target.checked });
    e.target.blur();
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

  // V0.2.9 ordering. When ✦ filter is on, tab-selected presets fan out by
  // the scene-state hierarchy (all → some → tabonly); non-selected follow.
  //   scores: 0 = selected + state-all
  //           1 = selected + state-some
  //           2 = selected + state-tabonly (no scene-selected meshes)
  //           4 = non-selected, used-by-visible (when 👁 filter on)
  //           5 = everything else (dimmed if 👁 filter on)
  const scoreOf = (p) => {
    if (filterSelectedFirst && selPresetIds.has(p.id)) {
      const ss = sceneStateFor(p.id);
      return ss === 'all' ? 0 : ss === 'some' ? 1 : 2;
    }
    if (filterVisible && usedByVisible.has(p.id)) return 4;
    return 5;
  };
  const annotated = presets.map((p, i) => ({ p, i, score: scoreOf(p) }));
  annotated.sort((a, b) => a.score - b.score || a.i - b.i);
  const order = annotated.map(x => x.p);
  const labelForBoundary = (toScore) =>
    toScore === 4 ? 'all colors'
    : toScore === 5 ? (filterVisible ? 'not in view' : 'all colors')
    : null;

  let _prevScore = -1;
  let _oi = -1;
  for (const preset of order) {
    _oi++;
    const score = scoreOf(preset);
    if (_oi > 0 && score !== _prevScore) {
      const label = labelForBoundary(score);
      if (label) {
        const sep = document.createElement('div');
        sep.style.cssText = 'display:flex;align-items:center;gap:8px;margin:12px 0 4px;opacity:0.7;font-size:11px;color:var(--text)';
        sep.innerHTML = `<span style="flex:1;height:1px;background:var(--line)"></span><span>${label}</span><span style="flex:1;height:1px;background:var(--line)"></span>`;
        list.appendChild(sep);
      }
    }
    _prevScore = score;
    const dim           = filterVisible && score === 5;
    const expanded      = _expandedPresetId === preset.id;
    const solidness     = preset.solidness ?? 1.0;
    const isDefault     = defaultIds.has(preset.id);
    const usedByMissing = missingPresets.has(preset.id);
    const modeLabel     = solidness >= 0.999 ? 'Solid'
                        : solidness <= 0.001 ? 'X-ray'
                        : `${Math.round(solidness * 100)}% Solid`;

    const selected = selPresetIds.has(preset.id);
    // V0.2.9: background fills are INDEPENDENT of tab selection.
    //   state-all  / state-some → driven purely by scene selection (apply
    //                              whether the row is in the tab sel or not).
    //   state-tabonly           → the ONLY tab-driven background — grey,
    //                              shown when a row is in the tab sel but
    //                              has no scene-selected meshes.
    //   .selected               → adds only the blue outline.
    const ss = sceneStateFor(preset.id);
    let fillClass = '';
    if      (ss === 'all')  fillClass = ' state-all';
    else if (ss === 'some') fillClass = ' state-some';
    else if (selected)      fillClass = ' state-tabonly';
    const row = document.createElement('div');
    row.className = 'colorRow' + (selected ? ' selected' : '') + fillClass;
    row.dataset.presetId = preset.id;   // V0.2.8: lets the Ctrl+drag marquee identify rows
    row.style.cursor = 'pointer';
    if (usedByMissing) row.style.backgroundImage = HATCH;
    if (dim) { row.style.opacity = '0.5'; row.style.filter = 'grayscale(0.6)'; }

    // V0.2.5: name is always TEXT on the bar so clicking ~90% of the bar
    // toggles expand/collapse. Renaming is only possible when expanded, via
    // the ✎ icon to the LEFT of the name (clicking ✎ swaps the span for an
    // input). The swatch + ✎ stop propagation so they don't toggle the row.
    const renameIcon = expanded
      ? `<span class="cp-rename-icon" title="Rename color"
              style="cursor:pointer;font-size:13px;opacity:0.7;padding:0 3px;flex:0 0 auto;color:var(--text)">✎</span>`
      : '';
    row.innerHTML = `
      <input type="color" class="cp-color" value="${preset.color || '#4a90d9'}" title="Edit color"
             style="width:36px;height:20px;padding:0;border:1px solid rgba(255,255,255,.25);border-radius:6px;cursor:pointer;
                    flex:0 0 auto;-webkit-appearance:none;appearance:none;background:transparent" />
      ${renameIcon}
      <span class="cp-row-name small" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${isDefault ? '<span class="defaultStar" title="Used as a default color">★</span>' : ''}${_esc(preset.name)}
      </span>
      <span class="colorMeta">${modeLabel}</span>
    `;

    // Click → file-manager selection (plain = replace/collapse, Ctrl =
    // toggle, Shift = range). Selecting exactly one opens its edit card.
    row.addEventListener('click', (e) => _onColorRowClick(e, preset.id, presets));

    // Swatch IS a native color input — opens the picker in BOTH collapsed
    // and expanded states. begin/commit bracket the undo entry.
    const sw = row.querySelector('.cp-color');
    sw.addEventListener('click',  e => e.stopPropagation());   // don't toggle the row
    sw.addEventListener('focus',  () => actions.beginPresetEdit(preset.id));
    sw.addEventListener('input',  e => { materials.updatePreset(preset.id, { color: e.target.value }); });
    sw.addEventListener('change', () => actions.commitPresetEdit(preset.id));

    // Rename via the ✎ icon (expanded only). Click ✎ → swap the name span
    // for an editable input + focus it. Enter / blur commits; Esc cancels.
    const renIcon = row.querySelector('.cp-rename-icon');
    if (renIcon) {
      renIcon.addEventListener('click', e => {
        e.stopPropagation();
        const span = row.querySelector('.cp-row-name');
        if (!span) return;
        const input = document.createElement('input');
        input.type  = 'text';
        input.value = preset.name;
        input.className = 'cp-row-name small';
        input.style.cssText = 'flex:1;min-width:0;background:var(--panel2,var(--bg));'
          + 'border:1px solid var(--line);border-radius:4px;color:var(--text);'
          + 'font-size:12px;padding:2px 6px';
        input.addEventListener('click',   ev => ev.stopPropagation());
        input.addEventListener('keydown', ev => {
          if (ev.key === 'Enter')      input.blur();
          else if (ev.key === 'Escape'){ input.value = preset.name; input.blur(); }
        });
        let done = false;
        input.addEventListener('blur', () => {
          if (done) return; done = true;
          const v = input.value.trim() || preset.name;
          if (v !== preset.name) actions.updatePreset(preset.id, { name: v });
          _renderColorsTab();
        });
        span.replaceWith(input);
        input.focus(); input.select();
      });
    }

    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      // If the r-clicked preset isn't part of the current multi-select,
      // collapse selection to just it (mirrors tree / shape-tab behaviour).
      let sel = new Set(state.get('selectedColorPresetIds') || []);
      if (!sel.has(preset.id)) {
        sel = new Set([preset.id]);
        _colorAnchorId = preset.id;
        state.setState({ selectedColorPresetIds: sel });
        _renderColorsTab();
      }
      // Pass the source event so the menu can read the initial modifier
      // state (Ctrl-held-at-show updates live labels immediately).
      _showColorContextMenu(preset, e.clientX, e.clientY, meshIds, sel, e);
    });

    // When expanded, wrap row + edit pane in .colorExpandWrap so the YELLOW
    // outline (active-step style) extends around both together.
    let wrap = null;
    if (expanded) {
      wrap = document.createElement('div');
      wrap.className = 'colorExpandWrap';
      wrap.appendChild(row);
      list.appendChild(wrap);
    } else {
      list.appendChild(row);
    }

    // ── Expanded edit card ────────────────────────────────────────────
    if (expanded) {
      const pane = document.createElement('div');
      pane.className = 'card';
      // Distinct shade so the editor reads as boxed-in under its row. The
      // yellow outline now lives on the wrapping .colorExpandWrap, not here.
      pane.style.cssText = 'background:var(--panel2,rgba(127,127,127,0.06));'
        + 'border:1px solid var(--line);margin-top:0';

      const missingWarningHtml = usedByMissing ? `
        <div style="display:flex;align-items:flex-start;gap:6px;padding:7px 10px;margin-bottom:10px;border-radius:8px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35)">
          <span style="font-size:14px;flex-shrink:0">⚠️</span>
          <span class="small" style="color:#f59e0b;line-height:1.5">This color is assigned to a <strong>missing asset</strong>. Changes are saved and will apply when the asset is relinked.</span>
        </div>` : '';

      pane.innerHTML = `
        ${missingWarningHtml}
        <label class="colorlab">Solidness
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

      // live update (no undo entry) — undo entry created on commit.
      // Name + Color now live on the bar (cp-row-name + cp-color swatch).
      const _live = (key, val) => materials.updatePreset(preset.id, { [key]: val });
      const _upd  = (key, val) => actions.updatePreset(preset.id, { [key]: val });

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

      wrap.appendChild(pane);
    }
  }

  // V0.2.6: refresh the yellow/magenta viewport highlight tied to the
  // currently-expanded color (plain-click expand changes _expandedPresetId
  // without a state event, so the listeners alone wouldn't catch it).
  _syncExpandedColorHighlight();
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
function _showColorContextMenu(preset, x, y, selectedMeshIds, selIds, srcEvent) {
  const activeMatches  = Object.entries(materials.meshColorAssignments)
    .filter(([, pid]) => pid === preset.id).map(([id]) => id);
  const defaultMatches = Object.entries(materials.meshDefaultColors)
    .filter(([, pid]) => pid === preset.id).map(([id]) => id);

  // Multi-select header (V0.1.97): when 2+ presets are selected, offer
  // Unify (merge all into the right-clicked survivor) and bulk Delete.
  const sel = selIds instanceof Set ? selIds : new Set([preset.id]);
  const multiItems = [];
  if (sel.size >= 2) {
    const n = sel.size;
    multiItems.push({
      label: `🔗 Unify ${n} colors → "${preset.name}"`,
      action: () => {
        if (actions.unifyPresets(preset.id, [...sel])) {
          state.setState({ selectedColorPresetIds: new Set([preset.id]) });
          _colorAnchorId = preset.id;
          setStatus(`Unified ${n} colors into "${preset.name}".`);
          _renderColorsTab();
        }
      },
    });
    multiItems.push({
      label: `🗑 Delete ${n} colors`,
      action: () => {
        const r = actions.deletePresets([...sel]);
        state.setState({ selectedColorPresetIds: new Set() });
        if (r.skipped > 0) {
          setStatus(`Deleted ${r.deleted}; skipped ${r.skipped} still used as a default — unify or reassign those first.`, 'warning');
        } else {
          setStatus(`Deleted ${r.deleted} color${r.deleted === 1 ? '' : 's'}.`);
        }
        _renderColorsTab();
      },
    });
    // "Select by all selected colors" — every mesh that uses ANY of the
    // currently-selected presets (active assignment OR project default).
    const allColorMatches = new Set();
    for (const pid of sel) {
      for (const [mid, p] of Object.entries(materials.meshColorAssignments)) {
        if (p === pid) allColorMatches.add(mid);
      }
      for (const [mid, p] of Object.entries(materials.meshDefaultColors)) {
        if (p === pid) allColorMatches.add(mid);
      }
    }
    multiItems.push({
      // Live label tri-state — held Alt → "Remove from", Ctrl → "Add to",
      // none → "Select by". The action branches at click time on the same
      // modifier state so the menu and behavior stay in sync.
      label: `🎨☑ Select by all selected colors (${allColorMatches.size})`,
      liveLabel: (m) => `🎨☑ ${_selectVerb(m)} all selected colors (${allColorMatches.size})`,
      disabled: allColorMatches.size === 0,
      action: (m) => _runSelectByMatches([...allColorMatches], m, `${sel.size} colors`),
    });
    multiItems.push({ separator: true });
  }

  showContextMenu([
    ...multiItems,
    {
      label:    `🎨 Select by active color (${activeMatches.length})`,
      liveLabel:(m) => `🎨 ${_selectVerb(m)} active color (${activeMatches.length})`,
      disabled: activeMatches.length === 0,
      action:   (m) => _runSelectByMatches(activeMatches, m, `active color "${preset.name}"`),
    },
    {
      label:    `🎨⭐ Select by default color (${defaultMatches.length})`,
      liveLabel:(m) => `🎨⭐ ${_selectVerb(m)} default color (${defaultMatches.length})`,
      disabled: defaultMatches.length === 0,
      action:   (m) => _runSelectByMatches(defaultMatches, m, `default color "${preset.name}"`),
    },
    { separator: true },
    {
      // V0.2.4: invert the TAB selection — works for single or multi.
      label:    `🔄 Invert color selection (${(state.get('colorPresets') || []).length - sel.size})`,
      disabled: (state.get('colorPresets') || []).length === 0,
      action:   () => {
        const all = state.get('colorPresets') || [];
        const inv = new Set();
        for (const p of all) if (!sel.has(p.id)) inv.add(p.id);
        actions.setColorSelection(inv);
        setStatus(`Inverted color selection (${inv.size}).`);
      },
    },
    {
      // V0.2.13: drop the entire tab color selection.
      label:    `✦ Deselect all colors (${sel.size})`,
      disabled: sel.size === 0,
      action:   () => {
        actions.setColorSelection(new Set());
        setStatus('Color selection cleared.');
      },
    },
    { separator: true },
    {
      // Always applies the RIGHT-CLICKED color to the current scene
      // selection, regardless of how many tab colors are multi-selected.
      label:    `🎨 Assign "${preset.name}" to selected (${selectedMeshIds.length})`,
      disabled: selectedMeshIds.length === 0,
      action:   () => {
        actions.assignPreset(selectedMeshIds, preset.id);
        setStatus(`Applied "${preset.name}" to ${selectedMeshIds.length} mesh(es).`);
      },
    },
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
  ], x, y, srcEvent ? { initialMods: srcEvent } : undefined);
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
  const groups       = state.get('selectionGroups') || [];
  const selSize      = (state.get('multiSelectedIds') || new Set()).size;

  el.innerHTML = `
    <div class="section">
      <div class="title">Selection</div>

      <div class="field-row" style="margin-top:10px">
        <label class="small" style="flex:1">Highlight Color</label>
        <input type="color" id="sel-outline-color" value="${_esc(outlineColor)}"
               style="width:44px;height:28px;padding:2px;border-radius:4px;cursor:pointer" />
      </div>
      <div class="small muted" style="margin-top:4px;line-height:1.4">
        Color used for the selection overlay and edge outline.
      </div>
    </div>

    <div class="section" style="margin-top:12px">
      <div class="title">Quick Actions</div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
        <button class="btn" id="btn-sel-all-meshes">Select All Meshes</button>
        <button class="btn" id="btn-sel-clear">Deselect All</button>
      </div>
    </div>

    <div class="section" style="margin-top:12px">
      <div class="title">Selection Groups</div>
      <button class="btn primary" id="btn-selgrp-save"
              style="margin-top:8px;width:100%;"
              ${selSize === 0 ? 'disabled title="Select something first"' : ''}>
        + Save current selection as group${selSize ? ` (${selSize})` : ''}
      </button>
      <div id="selgrp-list" style="display:flex;flex-direction:column;gap:4px;margin-top:10px;"></div>
    </div>
  `;

  el.querySelector('#sel-outline-color').addEventListener('input', e => {
    const before = state.get('selectionOutlineColor');
    const after  = e.target.value;
    materials.setSelectionOutlineColor(after);
    actions.pushSetterUndo('Selection outline color',
      v => materials.setSelectionOutlineColor(v), before, after, 'selOutline');
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

  el.querySelector('#btn-selgrp-save').addEventListener('click', () => {
    const id = actions.createSelectionGroup({});
    if (!id) {
      setStatus('Nothing to save — select objects first.', 'warn');
      return;
    }
    setStatus('Selection group saved.');
    _renderSelectTab();
  });

  _renderSelectionGroupList(el.querySelector('#selgrp-list'), groups);
}

function _renderSelectionGroupList(container, groups) {
  if (!container) return;
  if (groups.length === 0) {
    container.innerHTML = `
      <div class="small muted" style="font-size:11px;padding:8px 0;line-height:1.45;">
        No groups yet. Multi-select objects in the tree (or viewport),
        then click <b>+ Save current selection as group</b>.
      </div>
    `;
    return;
  }
  container.innerHTML = '';
  for (const g of groups) {
    const row = document.createElement('div');
    row.style.cssText = `
      display:flex;align-items:center;gap:6px;
      padding:5px 6px;
      background:rgba(255,255,255,0.025);
      border:1px solid var(--line,#334155);
      border-radius:6px;
    `;
    row.innerHTML = `
      <input type="color" data-act="recolor" value="${_esc(g.color)}"
             title="Group color"
             style="width:18px;height:18px;padding:0;border:none;background:transparent;cursor:pointer;flex:none;" />
      <span class="selgrp-name" data-id="${_esc(g.id)}"
            title="Double-click to rename"
            style="flex:1;min-width:0;font-size:12px;font-weight:600;
                   overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:text;">${_esc(g.name)}</span>
      <span class="small muted" style="font-size:10px;flex:none;">${g.ids.length}</span>
      <button class="btn" data-act="load"   title="Load — replace current selection"
              style="padding:1px 6px;font-size:10px;flex:none;">Load</button>
      <button class="btn" data-act="update" title="Update — overwrite from current selection"
              style="padding:1px 6px;font-size:10px;flex:none;">↻</button>
      <button class="btn" data-act="delete" title="Delete group"
              style="padding:1px 6px;font-size:10px;flex:none;">✕</button>
    `;

    const nameSpan = row.querySelector('.selgrp-name');
    nameSpan.addEventListener('dblclick', () => _enterSelGroupRename(nameSpan, g));

    row.querySelector('[data-act="recolor"]').addEventListener('input', e => {
      actions.recolorSelectionGroup(g.id, e.target.value);
    });
    row.querySelector('[data-act="load"]').addEventListener('click', () => {
      const ok = actions.loadSelectionGroup(g.id);
      setStatus(ok ? `Loaded "${g.name}".` : `Group "${g.name}" has no live members.`,
                ok ? 'info' : 'warn');
    });
    row.querySelector('[data-act="update"]').addEventListener('click', () => {
      const sz = (state.get('multiSelectedIds') || new Set()).size;
      if (sz === 0) {
        setStatus('Select something first to update the group.', 'warn');
        return;
      }
      const changed = actions.updateSelectionGroup(g.id);
      setStatus(changed ? `Updated "${g.name}" (${sz}).` : 'No change.');
      _renderSelectTab();
    });
    row.querySelector('[data-act="delete"]').addEventListener('click', () => {
      actions.deleteSelectionGroup(g.id);
      _renderSelectTab();
    });

    container.appendChild(row);
  }
}

function _enterSelGroupRename(span, group) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = group.name;
  input.style.cssText = 'flex:1;min-width:0;font-size:12px;';
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (v && v !== group.name) actions.renameSelectionGroup(group.id, v);
    _renderSelectTab();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')      { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { done = true; _renderSelectTab(); }
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
      <div style="margin-top:6px;">
        <button class="btn" id="btn-cam-refit" title="Recompute camera distance and pivot to frame the whole scene. Useful after rescaling a model.">🎯 Refit camera</button>
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

  el.querySelector('#btn-cam-refit')?.addEventListener('click', () => {
    _onFitAll();
    setStatus('Camera refit to scene.');
  });

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

// ═══════════════════════════════════════════════════════════════════════════
//  NOTES TAB — three font-size presets (small / medium / large)
// ═══════════════════════════════════════════════════════════════════════════
//
// Notes are 3D-anchored balloons attached to mesh faces. Their rendering
// lives in systems/notes-render.js; their lifecycle (create / edit / move
// / delete) lives in actions.js. This tab is just the global STYLE
// editor — the three font-size presets that every note can fall back to,
// so the project gets a consistent visual rhythm.
//
// Phase 1 ships the size editor only. Future iterations can layer a
// template library (canned text snippets) on top.

function _renderNotesTab() {
  const el = _panel('notes');
  if (!el) return;

  const presets   = state.get('notePresets')   || { small: 18, medium: 36, large: 48 };
  const templates = state.get('noteTemplates') || [];
  const placingId = state.get('noteTemplateInstantiationId');

  // Per-template instance count (how many notes in scene reference each).
  const instanceCount = new Map();
  const root = state.get('treeData');
  (function walk(n) {
    if (!n) return;
    if (n.type === 'note' && n.templateId) {
      instanceCount.set(n.templateId, (instanceCount.get(n.templateId) || 0) + 1);
    }
    for (const c of (n.children || [])) walk(c);
  })(root);

  const _esc = (s) => String(s ?? '').replace(/[<>&"']/g, ch => ({
    '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'
  }[ch]));

  const tplRowsHtml = templates.length === 0
    ? `<div class="small muted" style="padding:8px 2px">No templates yet. Click <b>+ New template</b> to create one.</div>`
    : templates.map((t, i) => {
        const preview = (t.text || '').replace(/\s+/g, ' ').trim().slice(0, 60) || '(empty)';
        const count = instanceCount.get(t.id) || 0;
        return `
          <div class="tplRow" data-tplid="${t.id}"
               style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;margin-top:6px;cursor:pointer">
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(t.name || `Template ${i+1}`)}</div>
              <div class="small muted" style="margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(preview)}</div>
            </div>
            <span class="small muted" title="Instances in scene" style="flex-shrink:0">×${count}</span>
            <button class="btn tplAssign" data-act="assign" data-tplid="${t.id}" title="Click here, then click any mesh face to place"
                    style="height:24px;padding:0 8px;font-size:12px;flex-shrink:0">Assign</button>
          </div>`;
      }).join('');

  el.innerHTML = `
    <div class="section">
      <div class="title">Note templates</div>
      <div class="small muted" style="margin-top:4px;line-height:1.4">
        Templates own shared text + size. Each instance has its own position + visibility.
      </div>
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
        <button class="btn primary" id="tpl-new"  style="flex:1 1 100%">+ New template</button>
        <button class="btn"         id="tpl-save" style="flex:1">💾 Save library…</button>
        <button class="btn"         id="tpl-load" style="flex:1">📂 Load library…</button>
      </div>
      ${placingId ? `<div class="small" style="margin-top:8px;padding:8px;border-radius:8px;background:rgba(245,158,11,0.15);border:1px solid #f59e0b;color:#fbbf24">
        🎯 Click a mesh face to place this template — Esc to cancel.
      </div>` : ''}
      <div id="tpl-list" style="margin-top:8px">${tplRowsHtml}</div>
    </div>

    <div class="section" style="margin-top:12px">
      <div class="title">Note size presets</div>
      <div class="small muted" style="margin-top:6px;line-height:1.45">
        Three canonical sizes (in canonical pixels — they scale with the safe frame at render time).
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px;align-items:center">
        <label class="small" for="note-sz-small">Small (px)</label>
        <input id="note-sz-small"  type="number" min="5" max="150" step="1" value="${presets.small  ?? 18}" />
        <label class="small" for="note-sz-medium">Medium (px)</label>
        <input id="note-sz-medium" type="number" min="5" max="150" step="1" value="${presets.medium ?? 36}" />
        <label class="small" for="note-sz-large">Large (px)</label>
        <input id="note-sz-large"  type="number" min="5" max="150" step="1" value="${presets.large  ?? 48}" />
      </div>
    </div>
  `;

  // ── Wire size presets (existing behaviour) ──────────────────────────────
  const wireSize = (id, key) => {
    el.querySelector(id).addEventListener('change', e => {
      const px = Math.max(5, Math.min(150, Number(e.target.value) || presets[key]));
      const next = { ...(state.get('notePresets') || {}), [key]: px };
      state.setState({ notePresets: next });
      state.markDirty();
    });
  };
  wireSize('#note-sz-small',  'small');
  wireSize('#note-sz-medium', 'medium');
  wireSize('#note-sz-large',  'large');

  // ── New template button ─────────────────────────────────────────────────
  el.querySelector('#tpl-new').addEventListener('click', () => {
    import('../systems/actions.js').then(actions => {
      actions.createNewNoteTemplate({});
    });
  });

  // ── Save / Load library ─────────────────────────────────────────────────
  el.querySelector('#tpl-save').addEventListener('click', _onSaveNoteLibrary);
  el.querySelector('#tpl-load').addEventListener('click', _onLoadNoteLibrary);

  // ── Per-row interactions ────────────────────────────────────────────────
  el.querySelectorAll('.tplRow').forEach(row => {
    const tplId = row.dataset.tplid;
    // Left-click row (not on Assign button) → opens edit dialog.
    row.addEventListener('click', e => {
      if (e.target.closest('[data-act="assign"]')) return;
      _openTemplateEditDialog(tplId);
    });
    // Right-click row → context menu.
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      _openTemplateContextMenu(tplId, e.clientX, e.clientY);
    });
  });

  // ── Assign buttons ──────────────────────────────────────────────────────
  el.querySelectorAll('[data-act="assign"]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const tplId = btn.dataset.tplid;
      import('../systems/actions.js').then(actions => {
        actions.startNoteTemplateInstantiation(tplId);
      });
    });
  });
}

function _openTemplateEditDialog(tplId) {
  const list = state.get('noteTemplates') || [];
  const tpl  = list.find(t => t.id === tplId);
  if (!tpl) return;
  // Plain prompt-style dialog — replace with a richer editor later.
  const dlg = document.createElement('dialog');
  dlg.className = 'sbs-dialog';
  dlg.style.cssText = 'width:min(500px,90vw);background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;color:var(--text)';
  const sizes  = ['small', 'medium', 'large'];
  // Quick-insert glyph palette — clicking a glyph inserts it at the
  // textarea's caret position. Specifically the warning / safety set
  // requested by the user.
  const glyphs = ['✔️','❌','☠️','⚡','⚠️','☢️','❗','🛑','💥','🔥','🛠️'];
  const glyphsHtml = glyphs.map(g =>
    `<button type="button" class="tpl-glyph" data-g="${g}"
       style="font-size:20px;width:34px;height:34px;padding:0;border:1px solid var(--line);background:var(--panel2);border-radius:6px;cursor:pointer">${g}</button>`
  ).join('');
  dlg.innerHTML = `
    <div style="font-weight:700;margin-bottom:8px">Edit template</div>
    <label class="small muted">Name</label>
    <input id="tpl-name" type="text" value="${(tpl.name||'').replace(/"/g,'&quot;')}" style="width:100%;margin-top:4px" />
    <label class="small muted" style="margin-top:10px;display:block">Text</label>
    <div id="tpl-glyphs" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${glyphsHtml}</div>
    <textarea id="tpl-text" rows="4" style="width:100%;margin-top:6px;font-family:Arial">${(tpl.text||'').replace(/</g,'&lt;')}</textarea>
    <label class="small muted" style="margin-top:10px;display:block">Size</label>
    <select id="tpl-size" style="width:100%;margin-top:4px">
      ${sizes.map(s => `<option value="${s}" ${s===tpl.sizePresetId?'selected':''}>${s}</option>`).join('')}
    </select>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button class="btn"          id="tpl-cancel">Cancel</button>
      <button class="btn primary"  id="tpl-save">Save</button>
    </div>
  `;
  document.body.appendChild(dlg);

  // Insert a glyph at the textarea's current caret position. Falls back
  // to appending at the end if the field doesn't have a selection range
  // (e.g. before user has focused it).
  const ta = dlg.querySelector('#tpl-text');
  const insertGlyph = (g) => {
    ta.focus();
    const start = ta.selectionStart ?? ta.value.length;
    const end   = ta.selectionEnd   ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const after  = ta.value.slice(end);
    ta.value = before + g + after;
    const pos = start + g.length;
    ta.setSelectionRange(pos, pos);
  };
  dlg.querySelectorAll('.tpl-glyph').forEach(btn => {
    // pointerdown — happens BEFORE the textarea blurs, so caret position
    // is preserved. Avoids click handler that would fire after blur.
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      insertGlyph(btn.dataset.g);
    });
  });

  dlg.addEventListener('keydown', e => { if (e.key === 'Escape') { dlg.close(); dlg.remove(); } });
  dlg.querySelector('#tpl-cancel').addEventListener('click', () => { dlg.close(); dlg.remove(); });
  dlg.querySelector('#tpl-save').addEventListener('click', () => {
    const name = dlg.querySelector('#tpl-name').value;
    const text = dlg.querySelector('#tpl-text').value;
    const size = dlg.querySelector('#tpl-size').value;
    import('../systems/actions.js').then(actions => {
      actions.renameNoteTemplate(tplId, name);
      actions.updateNoteTemplateText(tplId, text);
      actions.setNoteTemplateSize(tplId, size, null);
    });
    dlg.close();
    dlg.remove();
  });
  dlg.showModal();
  ta.focus();
}

function _showTemplatePickerForSwap(fromTplId, clientX, clientY, candidates) {
  import('./context-menu.js').then(({ showContextMenu }) => {
    import('../systems/actions.js').then(actions => {
      showContextMenu(
        candidates.map(t => ({
          label:  `📝 ${t.name || '(unnamed)'}`,
          action: () => {
            const n = actions.swapTemplateForAllInstances(fromTplId, t.id);
            setStatus(`Re-linked ${n} instance${n === 1 ? '' : 's'} to "${t.name || '(unnamed)'}".`);
          },
        })),
        clientX,
        clientY,
      );
    });
  });
}

// ─── Note library — save / load ──────────────────────────────────────────

async function _onSaveNoteLibrary() {
  const tpls = state.get('noteTemplates') || [];
  if (!tpls.length) {
    setStatus('No templates to save.', 'warning');
    return;
  }
  const payload = {
    kind:     'sbs.notelib',
    version:  1,
    exportedAt: new Date().toISOString(),
    templates: tpls.map(t => ({
      name:           t.name || '',
      text:           t.text || '',
      sizePresetId:   t.sizePresetId || 'medium',
      customFontSize: Number.isFinite(t.customFontSize) ? t.customFontSize : null,
    })),
  };
  const json = JSON.stringify(payload, null, 2);

  if (window.sbsNative?.saveNoteLib && window.sbsNative?.writeFile) {
    const path = await window.sbsNative.saveNoteLib('note_library.sbsnotelib');
    if (!path) return;
    const res = await window.sbsNative.writeFile(path, json, 'utf-8');
    if (res?.ok) setStatus(`Library saved → ${path.split(/[\\/]/).pop()}`);
    else         setStatus(`Save failed: ${res?.error || 'unknown'}`, 'danger');
    return;
  }
  // Browser fallback — anchor download.
  const blob = new Blob([json], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = 'note_library.sbsnotelib';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  setStatus('Library saved (downloaded).');
}

async function _onLoadNoteLibrary() {
  let json = null;
  if (window.sbsNative?.openNoteLib && window.sbsNative?.readFile) {
    const path = await window.sbsNative.openNoteLib();
    if (!path) return;
    const res = await window.sbsNative.readFile(path, 'utf-8');
    if (!res?.ok) { setStatus(`Load failed: ${res?.error || 'unknown'}`, 'danger'); return; }
    json = res.data;
  } else {
    json = await new Promise(resolve => {
      const input = document.createElement('input');
      input.type   = 'file';
      input.accept = '.sbsnotelib,.json,application/json';
      input.onchange = () => {
        const f = input.files?.[0];
        if (!f) return resolve(null);
        const r = new FileReader();
        r.onload  = () => resolve(String(r.result || ''));
        r.onerror = () => resolve(null);
        r.readAsText(f);
      };
      input.click();
    });
    if (!json) return;
  }

  let payload;
  try { payload = JSON.parse(json); }
  catch { setStatus('Invalid library file (not JSON).', 'danger'); return; }

  const incoming = Array.isArray(payload?.templates) ? payload.templates : null;
  if (!incoming || !incoming.length) {
    setStatus('No templates found in the file.', 'warning');
    return;
  }

  // Detect name conflicts to know whether we need the resolution dialog.
  const existing = state.get('noteTemplates') || [];
  const existingNames = new Set(existing.map(t => t.name));
  const conflicts = [...new Set(incoming.map(t => t.name).filter(n => existingNames.has(n)))];

  if (!conflicts.length) {
    // No conflicts — straight import.
    const { added } = (await import('../systems/actions.js')).importNoteTemplateLibrary(
      incoming, new Map(),
    );
    setStatus(`Imported ${added} template${added === 1 ? '' : 's'}.`);
    return;
  }

  // Show resolution dialog. Default per-row: rename. User picks per row OR
  // applies one mode to all conflicts.
  const decisions = await _showLibraryConflictDialog(conflicts);
  if (!decisions) return;   // user cancelled
  const resolutions = new Map();
  for (const c of conflicts) resolutions.set(c, decisions[c] || 'rename');
  // Non-conflicting incoming templates: insert as-is (their names aren't
  // in resolutions, so importNoteTemplateLibrary's default 'rename' triggers,
  // but auto-rename only fires on collision — so 'add' would also work.
  // We pin them to 'add' explicitly.
  for (const t of incoming) {
    if (!resolutions.has(t.name)) resolutions.set(t.name, 'add');
  }
  const { added, replaced, skipped, renamed } = (await import('../systems/actions.js'))
    .importNoteTemplateLibrary(incoming, resolutions);
  setStatus(`Imported: +${added}, replaced ${replaced}, renamed ${renamed}, skipped ${skipped}.`);
}

/**
 * Modal dialog for resolving name conflicts during note-library import.
 * Returns a map { [conflictName]: 'rename' | 'replace' | 'skip' } on OK,
 * or null on Cancel.
 */
function _showLibraryConflictDialog(conflictNames) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    dlg.style.cssText = 'width:min(580px,95vw);max-height:80vh;overflow:auto;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:18px';
    const rowsHtml = conflictNames.map(name => `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-top:1px solid var(--line)">
        <div style="flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
             title="${name.replace(/"/g,'&quot;')}">${(name || '(unnamed)').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</div>
        <select class="cf-row" data-name="${name.replace(/"/g,'&quot;')}" style="flex:0 0 auto">
          <option value="rename"  selected>Rename and add</option>
          <option value="replace">Replace existing</option>
          <option value="skip">Skip</option>
        </select>
      </div>`).join('');
    dlg.innerHTML = `
      <div style="font-weight:700;font-size:15px;margin-bottom:6px">Library import — name conflicts</div>
      <div class="small muted" style="margin-bottom:10px">${conflictNames.length} template${conflictNames.length === 1 ? '' : 's'} match an existing name. Pick an action per row, or use the bulk control below.</div>
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);margin-bottom:6px">
        <span class="small muted">Apply to all:</span>
        <select id="cf-bulk" style="flex:1">
          <option value="">— per-row —</option>
          <option value="rename">Rename and add (all)</option>
          <option value="replace">Replace existing (all)</option>
          <option value="skip">Skip (all)</option>
        </select>
      </div>
      ${rowsHtml}
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button class="btn"          id="cf-cancel">Cancel</button>
        <button class="btn primary"  id="cf-ok">Import</button>
      </div>
    `;
    document.body.appendChild(dlg);
    const close = (val) => { dlg.close(); dlg.remove(); resolve(val); };
    dlg.querySelector('#cf-cancel').addEventListener('click', () => close(null));
    dlg.querySelector('#cf-ok').addEventListener('click', () => {
      const out = {};
      dlg.querySelectorAll('.cf-row').forEach(sel => {
        out[sel.dataset.name] = sel.value;
      });
      close(out);
    });
    dlg.querySelector('#cf-bulk').addEventListener('change', e => {
      const v = e.target.value;
      if (!v) return;
      dlg.querySelectorAll('.cf-row').forEach(sel => sel.value = v);
    });
    dlg.addEventListener('keydown', e => { if (e.key === 'Escape') close(null); });
    dlg.showModal();
  });
}

function _openTemplateContextMenu(tplId, clientX, clientY) {
  import('./context-menu.js').then(({ showContextMenu, showConfirmDialog }) => {
    import('../systems/actions.js').then(actions => {
      const list = state.get('noteTemplates') || [];
      const tpl  = list.find(t => t.id === tplId);
      if (!tpl) return;
      // Count linked instances for the delete prompt.
      let instanceCount = 0;
      for (const n of (state.get('nodeById')?.values?.() || [])) {
        if (n?.type === 'note' && n.templateId === tplId) instanceCount++;
      }
      const otherTemplates = (state.get('noteTemplates') || []).filter(t => t.id !== tplId);
      showContextMenu([
        { label: '✏ Edit text/size…', action: () => _openTemplateEditDialog(tplId) },
        { label: 'Rename using content', action: () => actions.renameNoteTemplateFromContent(tplId) },
        { label: 'Rename…', action: () => {
            const next = window.prompt('Template name:', tpl.name || '');
            if (next != null) actions.renameNoteTemplate(tplId, next);
          } },
        { label: 'Duplicate', action: () => actions.duplicateNoteTemplate(tplId) },
        { separator: true },
        { label: '🎯 Assign to object (click a face)', action: () => actions.startNoteTemplateInstantiation(tplId) },
        { label: `🔁 Swap with template… (re-link ${instanceCount} instance${instanceCount===1?'':'s'})`,
          disabled: instanceCount === 0 || otherTemplates.length === 0,
          action: () => _showTemplatePickerForSwap(tplId, clientX, clientY, otherTemplates) },
        { separator: true },
        { label: `Delete — convert ${instanceCount} instance${instanceCount===1?'':'s'} to standalone`,
          action: () => showConfirmDialog(
            'Delete template?',
            `Convert ${instanceCount} linked note${instanceCount===1?'':'s'} to standalone? Their current text/size is preserved.`,
            () => actions.deleteNoteTemplate(tplId, 'detach'),
          ) },
        { label: `Delete — REMOVE ${instanceCount} instance${instanceCount===1?'':'s'} from scene`,
          action: () => showConfirmDialog(
            'Delete template + instances?',
            `This removes ${instanceCount} note${instanceCount===1?'':'s'} from the scene. Undoable with Ctrl+Z.`,
            () => actions.deleteNoteTemplate(tplId, 'remove'),
          ),
          disabled: instanceCount === 0 },
      ], clientX, clientY);
    });
  });
}

function _countNotes(node, n = { c: 0 }) {
  if (!node) return 0;
  if (node.type === 'note') n.c++;
  for (const c of (node.children || [])) _countNotes(c, n);
  return n.c;
}


// ═══════════════════════════════════════════════════════════════════════════
//  SHAPES TAB  (Phase 1 — "2D shapes in 3D")
// ═══════════════════════════════════════════════════════════════════════════
//
// Library list of shape templates + a "+ New Shape" button that arms the
// viewport editor. Each row carries the template's fill swatch, name,
// instance count, and a context menu with "Place" / "Delete".
//
// Phase 2 will add an "Edit polygon" entry that re-opens the viewport
// editor with the existing template's points seeded.

function _renderShapesTab() {
  const el = _panel('shapes');
  if (!el) return;

  const tpls    = state.get('shapeTemplates') || [];
  const drawing = state.get('shapeDrawing');
  const drawingPhase = drawing?.phase ?? null;
  const placeArmedFor = state.get('shapePlacementForId') || null;
  const facePicking   = !!state.get('shapeFromFacePicking');
  // Image-shape: pending mode means the user picked an image and is now
  // waiting to click a model face to drop it. Disables the other create
  // buttons; the row swaps to "Click a face…" + a red Cancel.
  const imagePending  = !!state.get('imageShapePending');
  // Highlight the row of the currently-selected flatShape's template —
  // gives the user a visual link between scene selection and library row.
  const selId = state.get('selectedId');
  const selNode = selId ? state.get('nodeById')?.get(selId) : null;
  const selectedTplId = (selNode && selNode.type === 'flatShape') ? selNode.templateId : null;

  // Count instances per template across the live tree
  const counts = new Map();
  const root = state.get('treeData');
  if (root) {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (n.type === 'flatShape' && n.templateId) {
        counts.set(n.templateId, (counts.get(n.templateId) || 0) + 1);
      }
      if (n.children) for (const c of n.children) stack.push(c);
    }
  }

  el.innerHTML = `
    <div class="section">
      <div class="title">Shapes</div>
      <p class="small muted" style="margin:6px 0 10px">
        Library of 2D polygon templates. Each template can be placed
        many times in the scene. Drawing happens in the viewport.
      </p>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn" id="btn-new-shape" ${drawing || facePicking || imagePending ? 'disabled' : ''}
          style="flex:1">${drawing ? 'Drawing…' : '+ New Shape'}</button>
        ${drawing
          ? `<button class="btn" id="btn-cancel-shape" style="background:#7f1d1d;color:#fff">Cancel</button>`
          : ''}
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <button class="btn" id="btn-shape-from-face"
                ${drawing || imagePending ? 'disabled' : ''}
                style="flex:1${facePicking ? ';background:#0369a1;color:#f1f5f9' : ''}"
                title="Click a face on a model — adjacent triangles within the angle threshold get included; their outline becomes a shape.">
          ${facePicking ? 'Click a face…' : '✂ Create shape from face'}
        </button>
        ${facePicking
          ? `<button class="btn" id="btn-cancel-face-shape" style="background:#7f1d1d;color:#fff">Cancel</button>`
          : ''}
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <button class="btn" id="btn-add-image"
                ${drawing || facePicking ? 'disabled' : ''}
                style="flex:1${imagePending ? ';background:#0369a1;color:#f1f5f9' : ''}"
                title="Pick an image file, then click a model face (or empty space) to drop a textured 2D plane sized to the image's aspect ratio.">
          ${imagePending ? 'Click a face…' : '🖼 + Image'}
        </button>
        ${imagePending
          ? `<button class="btn" id="btn-cancel-image" style="background:#7f1d1d;color:#fff">Cancel</button>`
          : ''}
      </div>
      <label class="small muted" style="display:block;margin-top:6px;line-height:1.4">
        Angle threshold
        <span id="shape-face-angle-val" style="float:right;color:var(--text)">${(state.get('shapeFaceAngleThreshold') ?? 5)}°</span>
        <input type="range" id="shape-face-angle"
               min="0" max="45" step="0.5"
               value="${state.get('shapeFaceAngleThreshold') ?? 5}"
               style="width:100%;margin-top:2px"
               title="Adjacent triangles within this many degrees of the picked triangle's normal join the face set. Tighter = only flat regions; wider = catches gently-curved surfaces." />
      </label>
      ${drawing
        ? `<p class="small" style="margin-top:8px;color:#fdba74">
             ${drawingPhase === 'pickPlane'
               ? 'Click a face or empty space to set the drawing plane.'
               : 'Click to add vertices • Click first vertex (or right-click) to close • Esc to cancel.'}
           </p>` : ''}
      ${facePicking
        ? `<p class="small" style="margin-top:8px;color:#fdba74">
             Click a mesh face — the connected element gets sliced by that face's plane. Right-click or Esc cancels.
           </p>` : ''}
    </div>

    <div class="section">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div class="title">Templates (${tpls.length})</div>
        <label class="small muted" style="display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none"
               title="Reorder: rows with currently-visible instances move to the top; rows with none drop below a separator and render greyed out (still clickable).">
          <input type="checkbox" id="shape-filter-visible" ${state.get('shapeTabFilterVisibleOnly') ? 'checked' : ''}/>
          <span>👁 filter</span>
        </label>
      </div>
      <div class="small muted" style="margin-top:4px">
        Ctrl-click rows to multi-select • Right-click to group / ungroup • Double-click name to rename
      </div>
      <div id="shape-list" style="margin-top:8px">${_renderShapeTabRows({
        tpls, counts, selectedTplId, placeArmedFor,
      })}</div>
    </div>
  `;

  // Event wiring
  el.querySelector('#btn-new-shape')?.addEventListener('click', () => {
    actions.startShapeDraw();
  });
  el.querySelector('#btn-cancel-shape')?.addEventListener('click', () => {
    actions.cancelShapeDraw();
  });
  el.querySelector('#btn-shape-from-face')?.addEventListener('click', () => {
    if (state.get('shapeFromFacePicking')) actions.cancelCreateShapeFromFace();
    else                                    actions.startCreateShapeFromFace();
  });
  el.querySelector('#btn-cancel-face-shape')?.addEventListener('click', () => {
    actions.cancelCreateShapeFromFace();
  });
  el.querySelector('#btn-add-image')?.addEventListener('click', () => {
    // Async — opens OS file picker, then arms placement on success.
    actions.addImageShape();
  });
  el.querySelector('#btn-cancel-image')?.addEventListener('click', () => {
    actions.cancelShapePlacement();   // clears both shapePlacementForId + imageShapePending
  });

  // Angle-threshold slider — live updates the label, persists to user-
  // settings on change (sticky across sessions).
  const angleEl  = el.querySelector('#shape-face-angle');
  const angleLab = el.querySelector('#shape-face-angle-val');
  if (angleEl) {
    angleEl.addEventListener('input', () => {
      const v = Number(angleEl.value) || 0;
      if (angleLab) angleLab.textContent = `${v}°`;
      state.setState({ shapeFaceAngleThreshold: v });
    });
    angleEl.addEventListener('change', () => {
      const v = Number(angleEl.value) || 0;
      userSettings.patch({ scene: { shapeFaceAngleThreshold: v } });
    });
  }

  _wireShapeTabRows(el);
}


// ─── Shape tab — row renderer + event wiring (V0.1.85) ──────────────────
//
// Renders shape-template-groups (collapsible) above ungrouped templates.
// Selection (Set<tplId> + Set<groupId>) is shown via cyan outline. A row
// is "name-editable" only via dblclick on the name span — single-click
// selects/multi-selects the row (no auto-rename). Group rows carry a
// lock toggle (locked = viewport-pick promotion) and an eye toggle
// (visible / hidden / mixed). The visibility filter hides every row
// whose template/group has zero currently-visible instances.

function _renderShapeTabRows({ tpls, counts, selectedTplId, placeArmedFor }) {
  const groups   = state.get('shapeTemplateGroups')           || [];
  const selT     = state.get('selectedShapeTemplateIds')      || new Set();
  const selG     = state.get('selectedShapeTemplateGroupIds') || new Set();
  const filterOn = !!state.get('shapeTabFilterVisibleOnly');

  if (tpls.length === 0) {
    return '<span class="small muted">No shapes yet. Click "+ New Shape" to draw one.</span>';
  }

  const tplById = new Map(tpls.map(t => [t.id, t]));
  const grouped = new Set();
  const groupOfTpl = new Map();   // tplId → owning group id
  for (const g of groups) for (const id of g.templateIds) { grouped.add(id); groupOfTpl.set(id, g.id); }
  const ungrouped = tpls.filter(t => !grouped.has(t.id));

  // `dim` — when the filter is on and the row's roll-up vis state is
  // 'hidden' or 'none', the row lives in the BELOW-separator section and
  // renders greyed-out (still clickable, still hosts its buttons + r-click
  // menu). Group members inherit their parent group's dim flag so a
  // visible group never has a half-greyed member strip.
  const renderTplRow = (t, indent = 0, dim = false) => {
    const ct       = counts.get(t.id) || 0;
    // A row counts as selected when it's directly in the tab selection,
    // when it's the active flatShape's template, OR when its owning group
    // is selected (group selection highlights the bar AND its members).
    const ownGroupSel = groupOfTpl.has(t.id) && selG.has(groupOfTpl.get(t.id));
    const isSel    = selT.has(t.id) || selectedTplId === t.id || ownGroupSel;
    const isArmed  = placeArmedFor === t.id;
    const visState = actions.getShapeTemplateVisibilityState(t.id);
    const eyeIcon  = visState === 'hidden' ? '🚫'
                   : visState === 'mixed'  ? '◐'
                   : visState === 'none'   ? '·'
                   :                         '👁';
    const eyeOpacity = visState === 'visible' ? '1.0' : '0.6';
    const rowStyle = `margin-top:6px;padding:8px;display:flex;align-items:center;gap:8px;cursor:pointer`
      + (indent ? `;margin-left:${indent}px` : ``)
      + (dim    ? `;opacity:0.45;filter:grayscale(0.6)` : ``)
      + (isSel ? `;outline:2px solid #38bdf8;background:rgba(56,189,248,0.08)` : ``);
    const placeLabel = isArmed ? 'Click viewport…' : 'Place';
    const placeStyle = `font-size:11px;padding:3px 8px;flex-shrink:0`
      + (isArmed ? `;background:#0369a1;color:#f1f5f9` : ``);
    return `
      <div class="card shape-row" data-shape-id="${_esc(t.id)}" style="${rowStyle}">
        <span class="shape-swatch" data-tpl-id="${_esc(t.id)}"
              style="width:18px;height:18px;border:1px solid var(--line);border-radius:3px;
                     background:${_esc(t.fill || '#cccccc')};cursor:pointer;flex-shrink:0"
              title="Edit colour"></span>
        <span class="shape-eye" data-tpl-id="${_esc(t.id)}"
              style="flex-shrink:0;cursor:pointer;font-size:14px;opacity:${eyeOpacity}"
              title="Toggle visibility of all instances of this shape">${eyeIcon}</span>
        <span class="shape-name" data-tpl-id="${_esc(t.id)}"
              style="flex:1;font-size:13px;padding:2px 4px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
              title="Double-click to rename">${_esc(t.name || 'Shape')}</span>
        <span class="small muted" style="flex-shrink:0">${ct}×</span>
        <button class="btn" data-edit-id="${_esc(t.id)}"
                style="font-size:11px;padding:3px 8px;flex-shrink:0"
                title="Edit polygon — opens the viewport editor seeded at an existing instance.">Edit</button>
        <button class="btn" data-place-id="${_esc(t.id)}"
                style="${placeStyle}"
                title="${isArmed ? 'Click a face in the viewport to drop the shape. Esc / right-click cancels.' : 'Click then click a face in the viewport to place tangent.'}">${placeLabel}</button>
        <button class="btn" data-delete-id="${_esc(t.id)}"
                style="font-size:11px;padding:3px 8px;flex-shrink:0;background:#7f1d1d;color:#fff">×</button>
      </div>`;
  };

  const renderGroupRow = (g, dim = false) => {
    const visState = actions.getShapeGroupVisibilityState(g.id);
    const isSel    = selG.has(g.id);
    const eyeIcon  = visState === 'hidden' ? '🚫'
                   : visState === 'mixed'  ? '◐'
                   : visState === 'none'   ? '·'
                   :                         '👁';
    const eyeOpacity = visState === 'visible' ? '1.0' : '0.6';
    const lockIcon = g.locked ? '🔒︎' : 'ꗃ';
    const twisty   = g.collapsed ? '▶' : '▼';
    const headStyle = `margin-top:8px;padding:6px 8px;display:flex;align-items:center;gap:8px;cursor:pointer;background:rgba(56,189,248,0.04)`
      + (dim   ? `;opacity:0.45;filter:grayscale(0.6)` : ``)
      + (isSel ? `;outline:2px solid #38bdf8;background:rgba(56,189,248,0.12)` : ``);
    const memberRows = g.collapsed ? '' : g.templateIds.map(tid => {
      const t = tplById.get(tid);
      return t ? renderTplRow(t, 18, dim) : '';
    }).join('');
    return `
      <div class="card shape-group-row" data-group-id="${_esc(g.id)}" style="${headStyle}">
        <span class="shape-group-twisty" data-group-id="${_esc(g.id)}"
              style="flex-shrink:0;cursor:pointer;width:12px;text-align:center">${twisty}</span>
        <span style="flex-shrink:0">📦</span>
        <span class="shape-group-lock" data-group-id="${_esc(g.id)}"
              style="flex-shrink:0;cursor:pointer;color:var(--text);opacity:0.9"
              title="${g.locked ? 'Locked — viewport click on any member instance selects the whole group. Click to unlock.' : 'Unlocked — instances pick individually. Click to lock.'}">${lockIcon}</span>
        <span class="shape-group-eye" data-group-id="${_esc(g.id)}"
              style="flex-shrink:0;cursor:pointer;font-size:14px;opacity:${eyeOpacity}"
              title="Toggle visibility of every instance of every shape in this group">${eyeIcon}</span>
        <span class="shape-group-name" data-group-id="${_esc(g.id)}"
              style="flex:1;font-size:13px;padding:2px 4px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
              title="Double-click to rename">${_esc(g.name || 'Shape Group')}</span>
        <span class="small muted" style="flex-shrink:0">${g.templateIds.length}</span>
      </div>
      ${memberRows}`;
  };

  // Partition by current visibility roll-up. With the filter OFF the
  // "hidden" bucket stays empty and everything renders in original order.
  const isTplVisible   = t => {
    const s = actions.getShapeTemplateVisibilityState(t.id);
    return s === 'visible' || s === 'mixed';
  };
  const isGroupVisible = g => {
    const s = actions.getShapeGroupVisibilityState(g.id);
    return s === 'visible' || s === 'mixed';
  };

  const topItems    = [];
  const bottomItems = [];
  for (const g of groups) {
    const html = renderGroupRow(g, false);
    if (!filterOn || isGroupVisible(g)) topItems.push(html);
    else                                bottomItems.push(renderGroupRow(g, true));
  }
  for (const t of ungrouped) {
    const html = renderTplRow(t, 0, false);
    if (!filterOn || isTplVisible(t)) topItems.push(html);
    else                              bottomItems.push(renderTplRow(t, 0, true));
  }

  const separator = (filterOn && bottomItems.length > 0)
    ? `<div class="small muted" style="display:flex;align-items:center;gap:8px;margin:14px 0 4px;opacity:0.7">
         <span style="flex:1;height:1px;background:var(--line)"></span>
         <span>hidden (${bottomItems.length})</span>
         <span style="flex:1;height:1px;background:var(--line)"></span>
       </div>`
    : '';

  return topItems.join('') + separator + bottomItems.join('');
}

function _wireShapeTabRows(el) {
  // Filter toggle
  el.querySelector('#shape-filter-visible')?.addEventListener('change', e => {
    actions.setShapeTabFilterVisibleOnly(e.target.checked);
  });

  // ── Row-level interactions (selection, rename, swatch, buttons) ──────
  el.querySelectorAll('.shape-row').forEach(row => {
    const tplId = row.dataset.shapeId;
    row.addEventListener('click', e => {
      // Inner controls (buttons, swatch, eye) keep their own handlers.
      // The NAME does NOT short-circuit — clicking the bar (which the name
      // mostly fills) selects the row; rename is dblclick-only.
      if (e.target.closest('button, .shape-swatch, .shape-eye')) return;
      const mode = (e.ctrlKey || e.metaKey) ? 'toggle' : 'replace';
      actions.selectShapeTemplate(tplId, mode);
    });
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      _showShapeTabContextMenu(e.clientX, e.clientY, { kind: 'template', id: tplId });
    });
  });

  // Group header
  el.querySelectorAll('.shape-group-row').forEach(row => {
    const groupId = row.dataset.groupId;
    row.addEventListener('click', e => {
      // Twisty / lock / eye keep their own handlers. The group NAME does
      // NOT short-circuit — clicking the bar selects the group (rename is
      // dblclick-only).
      if (e.target.closest('.shape-group-twisty, .shape-group-lock, .shape-group-eye')) return;
      const mode = (e.ctrlKey || e.metaKey) ? 'toggle' : 'replace';
      actions.selectShapeTemplateGroup(groupId, mode);
    });
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      _showShapeTabContextMenu(e.clientX, e.clientY, { kind: 'group', id: groupId });
    });
  });

  el.querySelectorAll('.shape-group-twisty').forEach(t => {
    t.addEventListener('click', e => {
      e.stopPropagation();
      const groupId = t.dataset.groupId;
      const g = (state.get('shapeTemplateGroups') || []).find(x => x.id === groupId);
      if (!g) return;
      actions.setShapeTemplateGroupCollapsed(groupId, !g.collapsed);
    });
  });

  el.querySelectorAll('.shape-group-lock').forEach(lk => {
    lk.addEventListener('click', e => {
      e.stopPropagation();
      const groupId = lk.dataset.groupId;
      const g = (state.get('shapeTemplateGroups') || []).find(x => x.id === groupId);
      if (!g) return;
      actions.setShapeTemplateGroupLocked(groupId, !g.locked);
    });
  });

  el.querySelectorAll('.shape-group-eye').forEach(ey => {
    ey.addEventListener('click', e => {
      e.stopPropagation();
      actions.toggleShapeGroupVisibility(ey.dataset.groupId);
    });
  });

  el.querySelectorAll('.shape-eye').forEach(ey => {
    ey.addEventListener('click', e => {
      e.stopPropagation();
      actions.toggleShapeTemplateVisibility(ey.dataset.tplId);
    });
  });

  // Per-template Edit / Place / Delete buttons
  el.querySelectorAll('[data-edit-id]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      actions.startShapeEdit(btn.dataset.editId);
    });
  });
  el.querySelectorAll('[data-delete-id]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      actions.deleteShapeTemplate(btn.dataset.deleteId);
    });
  });
  el.querySelectorAll('[data-place-id]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      actions.startShapePlacement(btn.dataset.placeId);
    });
  });

  // Swatch — color picker
  el.querySelectorAll('.shape-swatch').forEach(sw => {
    sw.addEventListener('click', e => {
      e.stopPropagation();
      const tplId = sw.dataset.tplId;
      const tpl   = (state.get('shapeTemplates') || []).find(t => t.id === tplId);
      if (!tpl) return;
      const input = document.createElement('input');
      input.type = 'color';
      input.value = tpl.fill || '#cccccc';
      input.style.position = 'fixed';
      input.style.opacity  = '0';
      document.body.appendChild(input);
      input.addEventListener('change', () => {
        actions.setShapeTemplateFill(tplId, input.value);
        input.remove();
      });
      input.click();
    });
  });

  // Name spans — dblclick to start an in-place rename. Single click bubbles
  // to the row so it doesn't auto-rename anymore.
  el.querySelectorAll('.shape-name').forEach(span => {
    span.addEventListener('dblclick', e => {
      e.stopPropagation();
      _startInlineRename(span, (newName) => {
        actions.setShapeTemplateName(span.dataset.tplId, newName.trim() || 'Shape');
      });
    });
  });
  el.querySelectorAll('.shape-group-name').forEach(span => {
    span.addEventListener('dblclick', e => {
      e.stopPropagation();
      _startInlineRename(span, (newName) => {
        actions.setShapeTemplateGroupName(span.dataset.groupId, newName.trim() || 'Shape Group');
      });
    });
  });
}

/**
 * Convert a non-editable name span into a temporary <input>, focus +
 * select it, commit on Enter / blur, cancel on Esc. The input takes
 * the span's slot in the flex row so the layout doesn't jump.
 */
function _startInlineRename(span, commit) {
  const original = span.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = original;
  input.style.cssText = span.style.cssText
    + ';background:transparent;border:1px dashed var(--line);color:inherit;outline:none';
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save && input.value !== original) commit(input.value);
    // Tab re-renders on the state change; if not (e.g. same value), restore span.
    if (input.isConnected) input.replaceWith(span);
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function _showShapeTabContextMenu(x, y, target) {
  const selT = state.get('selectedShapeTemplateIds')      || new Set();
  const selG = state.get('selectedShapeTemplateGroupIds') || new Set();
  const groups = state.get('shapeTemplateGroups') || [];

  // Click target falls into selection if it's already part of it; otherwise
  // treat the click as a single-target action (don't blow away the user's
  // multi-select silently — but also don't ignore a right-click on an
  // un-selected row).
  let tplIds = new Set();
  let groupIds = new Set();
  if (target.kind === 'template') {
    if (selT.has(target.id)) tplIds = new Set(selT);
    else                     tplIds = new Set([target.id]);
  } else {
    if (selG.has(target.id)) groupIds = new Set(selG);
    else                     groupIds = new Set([target.id]);
  }

  const items = [];

  if (target.kind === 'template') {
    const inSomeGroup = [...tplIds].some(id => groups.some(g => g.templateIds.includes(id)));
    const canGroup = tplIds.size >= 1;
    items.push({
      label: `📦 Group ${tplIds.size} shape${tplIds.size === 1 ? '' : 's'}`,
      disabled: !canGroup,
      action: () => actions.createShapeTemplateGroupFromTemplates([...tplIds]),
    });
    if (inSomeGroup) {
      items.push({
        label: '⤴ Remove from group',
        action: () => actions.removeTemplatesFromShapeGroup([...tplIds]),
      });
    }
    // "Add to existing group" — appears when other groups exist.
    const otherGroups = groups.filter(g => ![...tplIds].every(id => g.templateIds.includes(id)));
    if (otherGroups.length > 0) {
      items.push({ label: '─', disabled: true });
      for (const g of otherGroups) {
        items.push({
          label: `→ Add to "${g.name}"`,
          action: () => actions.addTemplatesToShapeGroup(g.id, [...tplIds]),
        });
      }
    }
    items.push({ label: '─', disabled: true });
    items.push({
      label: '👁 Toggle visibility (all instances)',
      action: () => { for (const id of tplIds) actions.toggleShapeTemplateVisibility(id); },
    });
  } else {
    items.push({
      label: '⤴ Ungroup',
      action: () => { for (const id of groupIds) actions.unGroupShapeTemplateGroup(id); },
    });
    items.push({
      label: '✎ Rename',
      disabled: groupIds.size !== 1,
      action: () => {
        const span = document.querySelector(`.shape-group-name[data-group-id="${[...groupIds][0]}"]`);
        if (span) _startInlineRename(span, (newName) => {
          actions.setShapeTemplateGroupName([...groupIds][0], newName.trim() || 'Shape Group');
        });
      },
    });
    items.push({ label: '─', disabled: true });
    items.push({
      label: '🔒 Toggle lock',
      action: () => {
        for (const id of groupIds) {
          const g = groups.find(x => x.id === id);
          if (g) actions.setShapeTemplateGroupLocked(id, !g.locked);
        }
      },
    });
    items.push({
      label: '👁 Toggle visibility (all members)',
      action: () => { for (const id of groupIds) actions.toggleShapeGroupVisibility(id); },
    });
  }

  showContextMenu(items, x, y);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Undo tab (V0.2.16)
// ═══════════════════════════════════════════════════════════════════════════
// Lets the user tune the undo-stack cap and see live what's on the stack
// (recent action labels). Top of each list = most recent. The cap persists
// to userSettings.undo.maxSize so it follows the user across projects.

function _renderUndoTab() {
  const el = _panel('undo');
  if (!el) return;

  const max  = undoManager.getMaxSize();
  const undo = undoManager.listUndo();   // oldest → newest
  const redo = undoManager.listRedo();

  // Render most-recent FIRST in the lists for at-a-glance scanning.
  const undoTop = [...undo].reverse();
  const redoTop = [...redo].reverse();

  const _renderList = (items, emptyMsg, accentColor) => items.length === 0
    ? `<div class="small muted" style="padding:6px 8px;font-style:italic">${emptyMsg}</div>`
    : items.map((label, i) => `
        <div class="small" style="display:flex;align-items:center;gap:8px;padding:5px 8px;
                                   border-radius:4px;background:rgba(127,127,127,0.06);
                                   margin-top:4px${i === 0 ? `;border-left:3px solid ${accentColor}` : ''}">
          <span style="opacity:0.5;width:24px;text-align:right;font-variant-numeric:tabular-nums">${i + 1}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(label || '(unlabeled)')}</span>
          ${i === 0 ? `<span class="small muted" style="font-size:10px;text-transform:uppercase;letter-spacing:.4px">top</span>` : ''}
        </div>
      `).join('');

  el.innerHTML = `
    <div class="section">
      <div class="title">Undo</div>
      <div class="card" style="margin-top:8px">
        <label class="colorlab" style="display:block">
          Max history entries
          <input type="number" id="undo-max" min="10" max="2000" step="10" value="${max}"
                 style="margin-top:6px;width:120px" />
        </label>
        <div class="small muted" style="margin-top:6px;line-height:1.45">
          Old entries drop off (oldest first) once the cap is reached.
          Higher caps eat more memory — big mutations like step paste or
          color unify carry deep-cloned snapshots. 200 is a comfortable
          default; 500+ on heavy projects only if you really need it.
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin-top:10px">
          <button class="btn" id="undo-clear" title="Empty both stacks">🗑 Clear history</button>
          <span class="small muted" id="undo-stats" style="margin-left:auto">
            ${undo.length} undo · ${redo.length} redo
          </span>
        </div>
      </div>

      <div class="card" style="margin-top:8px">
        <div class="title" style="font-size:13px">Undo stack (${undo.length})</div>
        <div class="small muted" style="margin-top:2px">Top entry is what Ctrl+Z would undo.</div>
        <div style="margin-top:6px;max-height:34vh;overflow:auto">
          ${_renderList(undoTop, 'Nothing to undo yet.', '#4A90D9')}
        </div>
      </div>

      <div class="card" style="margin-top:8px">
        <div class="title" style="font-size:13px">Redo stack (${redo.length})</div>
        <div class="small muted" style="margin-top:2px">Top entry is what Ctrl+Y / Ctrl+Shift+Z would redo.</div>
        <div style="margin-top:6px;max-height:25vh;overflow:auto">
          ${_renderList(redoTop, 'Nothing to redo.', '#facc15')}
        </div>
      </div>
    </div>
  `;

  const maxInput = el.querySelector('#undo-max');
  maxInput?.addEventListener('change', () => {
    const v = Math.max(10, Math.min(2000, Math.floor(Number(maxInput.value) || 200)));
    maxInput.value = v;
    undoManager.setMaxSize(v);
    userSettings.patch({ undo: { maxSize: v } });
    _renderUndoTab();
  });
  el.querySelector('#undo-clear')?.addEventListener('click', () => {
    if (!confirm('Clear the undo and redo history? This cannot be undone.')) return;
    undoManager.clear();
    setStatus('Undo history cleared.');
  });
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
          <label class="colorlab" title="Extra dwell appended to each step in the exported video (ms). Pause WITHIN a transition is authored inside animation presets via the pause channel.">Step hold (ms)
            <input type="number" id="exp-hold" value="${exp.stepHoldMs??100}" min="0" max="10000" step="100" style="margin-top:6px;" />
          </label>
        </div>

        <label style="display:flex;align-items:center;gap:6px;margin-top:10px;cursor:pointer;">
          <input type="checkbox" id="exp-show-safe-frame" ${exp.showSafeFrame !== false ? 'checked' : ''} />
          <span class="small muted">Show safe frame in viewport</span>
        </label>

        <label style="display:flex;align-items:flex-start;gap:6px;margin-top:8px;cursor:pointer;">
          <input type="checkbox" id="exp-offline-render" ${exp.offlineRender ? 'checked' : ''} style="margin-top:3px;" />
          <span class="small muted">
            Offline render (recommended)
            <div class="small muted" style="font-size:11px;opacity:0.75;margin-top:2px;">
              Decouples animation from real time. Same project renders the same duration regardless of window size or focus.
              <strong style="color:#fbbf24;">If unchecked, the window MUST stay visible during the entire export — covering it with another window pauses rendering and produces frozen / duplicated frames in the output.</strong>
            </div>
          </span>
        </label>

        <label style="display:flex;align-items:flex-start;gap:6px;margin-top:8px;cursor:pointer;">
          <input type="checkbox" id="exp-bboxes" ${exp.exportBoundaryBoxes ? 'checked' : ''} style="margin-top:3px;" />
          <span class="small muted">
            Export boundary boxes
            <div class="small muted" style="font-size:11px;opacity:0.75;margin-top:2px;">
              Include missing-asset / deleted-mesh Bbox placeholders (orange wireframes) in the encoded video. Off by default — they're authoring aids, not finished output.
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
  el.querySelector('#exp-bboxes')?.addEventListener('change', e =>
    state.setExportOption('exportBoundaryBoxes', !!e.target.checked));
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
      // V0.2.22.3 — use ?? not ||. The previous `Number(x) || N` coerced
      // a user-typed 0 to the fallback N (because 0 is falsy). User
      // setting step-hold to 0 silently became 800ms. Same trap fixed
      // for fps even though 0 fps is nonsensical — consistency matters.
      fps:              Number.isFinite(Number(exp.fps))        ? Number(exp.fps)        : 50,
      stepHoldMs:       Number.isFinite(Number(exp.stepHoldMs)) ? Number(exp.stepHoldMs) : 800,
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
