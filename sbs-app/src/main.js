/**
 * SBS Step Browser — Application Entry Point
 * =============================================
 * Initialises every system and UI module, wires event handlers,
 * and starts the render loop.
 *
 * Boot order:
 *   1. State — singleton, already constructed at import time
 *   2. SceneCore  — Three.js renderer, orbit controls
 *   3. Materials  — material system
 *   4. Steps      — step manager (wired to materials)
 *   5. UI modules — sidebar, tree, steps panel, step nav, HUD, status, ctx-menu
 *   6. Viewport event handlers (click/dblclick/contextmenu)
 *   7. Keyboard shortcuts
 *   8. Render loop start
 */

// ── Core systems ──────────────────────────────────────────────────────────────
import { state }          from './core/state.js';
import { sceneCore }      from './core/scene.js';
import { steps }          from './systems/steps.js';
import { materials }      from './systems/materials.js';
import { setupUndoKeyboard, setSelection as actionSetSelection, clearSelection as actionClearSelection, resetTransform } from './systems/actions.js';
import { gizmo }           from './ui/gizmo.js';
import { undoManager }    from './systems/undo.js';
import { selectionActs }  from './systems/select-act.js';

// ── Data helpers ──────────────────────────────────────────────────────────────
import {
  findNode,
  findParent,
  removeNodeById,
  buildNodeMap,
  getNearestContainerAncestor,
}                         from './core/nodes.js';
import { applyAllTransforms } from './core/transforms.js';

// ── I/O ───────────────────────────────────────────────────────────────────────
import { saveProject, getSuggestedFilename } from './io/project.js';

// ── UI ────────────────────────────────────────────────────────────────────────
import { initStatus, setStatus }  from './ui/status.js';
import { initHud }                from './ui/hud.js';
import { initStepNav }            from './ui/step-nav.js';
import { initStepsPanel }         from './ui/steps-panel.js';
import { initSidebarLeft }        from './ui/sidebar-left.js';
import { initContextMenu, hideContextMenu, showContextMenu } from './ui/context-menu.js';
import { initOverlay, getStage as getOverlayStage } from './systems/overlay.js';
import { initOverlayToolbar }  from './ui/overlay-toolbar.js';
import { initHeaderLayer }     from './systems/header.js';
import { initCables }          from './systems/cables.js';        // C1: cables wire step:applied → applyStepSnapshot
import { initCableRender }     from './systems/cables-render.js';  // C2: cables 3D render + per-frame anchor ticker
import { initUserSettings }    from './core/user-settings.js';
import { openSettingsModal }   from './ui/settings-modal.js';
import { schedulePrecache, cancel as cancelPrecache } from './systems/narration-precache.js';

// ══════════════════════════════════════════════════════════════════════════════
//  1. STATE — restore persisted preferences
// ══════════════════════════════════════════════════════════════════════════════

state.restoreTheme();
state.setState({ isElectron: !!window.sbsNative?.isElectron });

// ══════════════════════════════════════════════════════════════════════════════
//  2. SCENE CORE
// ══════════════════════════════════════════════════════════════════════════════

const viewer = document.getElementById('viewer');
sceneCore.init(viewer, { antialias: true, preserveDrawingBuffer: true });
gizmo.init();

function _syncBackground() {
  if (!window.THREE) return;
  sceneCore.scene.background = new THREE.Color(state.get('backgroundColor') || '#0f172a');
}
_syncBackground();
state.on('change:backgroundColor', _syncBackground);

state.on('change:gridVisible', vis => {
  sceneCore.setGridVisible(vis);
});

// ══════════════════════════════════════════════════════════════════════════════
//  3. MATERIALS
// ══════════════════════════════════════════════════════════════════════════════

materials.init();

// ══════════════════════════════════════════════════════════════════════════════
//  4. STEPS
// ══════════════════════════════════════════════════════════════════════════════

steps.setMaterialsSystem(materials);
steps.init();

// ══════════════════════════════════════════════════════════════════════════════
//  5. UI MODULES
// ══════════════════════════════════════════════════════════════════════════════

initStatus();
initContextMenu();
initSidebarLeft();
initStepNav();
initStepsPanel();
initHud();
initOverlay();
initOverlayToolbar();
// Header layer rides on top of the overlay stage; must init AFTER initOverlay.
initHeaderLayer(getOverlayStage());
// C1: cables system — subscribes to step:applied to merge per-step
// variable overrides into state.cables. Must run AFTER steps.init.
initCables();
// C2: cables 3D render mounts CableRoot on sceneCore.scene + folds the
// anchor refresh into sceneCore's existing tick. Must run AFTER scene
// is up + initCables (so subscriptions land in the right order).
initCableRender();
setupUndoKeyboard();

// Eager-load user-level prefs so subsequent UI can read them synchronously.
initUserSettings().catch(err => console.warn('[settings] init failed:', err));

// File → Settings… menu hook. Channel allowlist lives in preload.js.
window.sbsNative?.onMenu?.('menu:openSettings', () => openSettingsModal());

// Background narration pre-cache:
//   • on project load — synthesize every step's saved text once, in the
//     background, so Preview / Export are instant when the user gets there.
//   • on narration-voice change in the Export tab — the existing path
//     already invalidates clips; trigger a fresh pass to re-cache them.
state.on('project:loaded', () => schedulePrecache('project-loaded'));
// Any export-options change re-runs the pass. Internally idempotent — only
// steps with stale/missing clips get re-synthesized.
state.on('change:export',  () => schedulePrecache('export-options-change'));

// Clear undo history when a new project loads (fresh slate)
state.on('change:projectPath', () => { undoManager.clear(); selectionActs.clear(); });

// ── Gizmo: follow selection ───────────────────────────────────────────────────
function _syncGizmoToSelection() {
  const selId  = state.get('selectedId');
  const nodeById = state.get('nodeById');
  if (!selId || !nodeById) { gizmo.hide(); return; }
  const node = nodeById.get(selId);
  if (!node || node.type === 'mesh' || node.type === 'scene') { gizmo.hide(); return; }
  const obj3d = steps.object3dById?.get(selId);
  if (!obj3d) { gizmo.hide(); return; }
  gizmo.show(node, obj3d);
}
state.on('selection:change',    _syncGizmoToSelection);
state.on('change:treeData',     _syncGizmoToSelection);

// ══════════════════════════════════════════════════════════════════════════════
//  6. VIEWPORT EVENT HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

const canvas = sceneCore.renderer.domElement;

// ── Marquee (box-select) overlay ─────────────────────────────────────────────
// A zero-cost transparent <div> that renders the drag rectangle.

const _marquee = document.createElement('div');
_marquee.id = 'selection-rect';
_marquee.style.cssText = [
  'position:fixed',
  'pointer-events:none',
  'border:1px solid #00cfff',
  'background:rgba(0,180,255,0.08)',
  'display:none',
  'z-index:999',
].join(';');
document.body.appendChild(_marquee);

let _dragStartX = 0, _dragStartY = 0;
let _isDragging = false;
let _justDragged = false;   // skip click event that fires right after a drag
let _dragOnCanvas = false;  // drag only counts when it started on the canvas
let _gizmoConsumed = false; // gizmo took the pointerdown — suppress next click

function _showMarquee(x1, y1, x2, y2) {
  const left = Math.min(x1, x2), top  = Math.min(y1, y2);
  const w    = Math.abs(x2 - x1), h   = Math.abs(y2 - y1);
  _marquee.style.left    = left + 'px';
  _marquee.style.top     = top  + 'px';
  _marquee.style.width   = w    + 'px';
  _marquee.style.height  = h    + 'px';
  _marquee.style.display = 'block';
}

function _hideMarquee() {
  _marquee.style.display = 'none';
}

/**
 * Pick all visible mesh nodeIds that project inside screen rect [x1,y1,x2,y2].
 * Uses raycasting across a grid of sample points for a lightweight approximation.
 */
function _pickInRect(x1, y1, x2, y2) {
  if (!window.THREE) return new Set();
  const root = state.get('treeData');
  if (!root) return new Set();

  const found = new Set();
  const rect  = sceneCore.renderer.domElement.getBoundingClientRect();
  const SAMPLES = 8;   // grid density per axis (9×9 = 81 sample points)

  for (let si = 0; si <= SAMPLES; si++) {
    const cx = x1 + (x2 - x1) * (si / SAMPLES);
    for (let sj = 0; sj <= SAMPLES; sj++) {
      const cy = y1 + (y2 - y1) * (sj / SAMPLES);
      if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) continue;

      const hits = sceneCore.pickAll(cx, cy);
      for (const h of hits) {
        const meshNodeId = h.object.userData?.meshNodeId;
        if (meshNodeId) found.add(meshNodeId);  // collect mesh IDs directly
      }
    }
  }
  return found;
}

// ── Pointer down on canvas: start potential drag-select ──────────────────────

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;

  // Gizmo gets first chance
  if (gizmo.onPointerDown(e.clientX, e.clientY)) {
    canvas.setPointerCapture(e.pointerId);
    _gizmoConsumed = true;
    return;
  }

  _dragStartX   = e.clientX;
  _dragStartY   = e.clientY;
  _isDragging   = false;
  _dragOnCanvas = true;   // drag started on the 3-D viewport
}, { capture: false });

// ── Pointer move: gizmo drag or grow marquee ─────────────────────────────────

canvas.addEventListener('pointermove', e => {
  if (!(e.buttons & 1)) {
    // No button — update hover
    gizmo.onHover(e.clientX, e.clientY);
    return;
  }

  // Active gizmo drag
  if (gizmo.isDragging) {
    gizmo.onPointerMove(e.clientX, e.clientY);
    return;
  }
});

window.addEventListener('pointermove', e => {
  if (!(e.buttons & 1)) return;            // left button must be held
  if (!_dragOnCanvas) return;              // only when drag started on viewport
  if (sceneCore.controls?.active) return;  // orbit/pan owns the pointer
  if (gizmo.isDragging) return;            // gizmo owns the pointer

  const dx = e.clientX - _dragStartX;
  const dy = e.clientY - _dragStartY;
  if (!_isDragging && Math.sqrt(dx * dx + dy * dy) > 6) {
    _isDragging = true;
  }
  if (_isDragging) {
    _showMarquee(_dragStartX, _dragStartY, e.clientX, e.clientY);
  }
}, { passive: true });

// ── Pointer up: finalise gizmo or selection ───────────────────────────────────

window.addEventListener('pointerup', e => {
  if (gizmo.isDragging) {
    gizmo.onPointerUp();
    return;
  }

  _dragOnCanvas = false;     // reset regardless

  if (!_isDragging) return;
  _hideMarquee();
  _isDragging  = false;
  _justDragged = true;   // suppress the click event that fires next

  const found = _pickInRect(_dragStartX, _dragStartY, e.clientX, e.clientY);
  if (found.size === 0) {
    if (!e.ctrlKey && !e.metaKey) actionClearSelection();
    return;
  }

  const multi = e.ctrlKey || e.metaKey
    ? new Set([...(state.get('multiSelectedIds') || []), ...found])
    : found;

  const primary = [...multi][0];
  actionSetSelection(primary, multi);
});

// ── Click: select object ─────────────────────────────────────────────────────

canvas.addEventListener('click', e => {
  if (e.button !== 0) return;
  // Suppress click after gizmo interaction or drag-select
  if (_gizmoConsumed) { _gizmoConsumed = false; return; }
  if (_justDragged) { _justDragged = false; return; }
  hideContextMenu();

  const root    = state.get('treeData');
  const nbm     = state.get('nodeById');
  if (!root || !nbm) return;

  const hit = sceneCore.pick(e.clientX, e.clientY);
  if (!hit) {
    if (!e.ctrlKey && !e.metaKey) actionClearSelection();
    return;
  }

  const meshNodeId = hit.object.userData?.meshNodeId;
  if (!meshNodeId) return;

  const target = meshNodeId;
  const multi  = new Set(state.get('multiSelectedIds') || []);
  if (e.ctrlKey || e.metaKey) {
    if (multi.has(target)) multi.delete(target);
    else                   multi.add(target);
    actionSetSelection(target, multi);
  } else {
    actionSetSelection(target, new Set([target]));
  }
});

// ── Double-click: select all children of container ───────────────────────────

canvas.addEventListener('dblclick', e => {
  const root = state.get('treeData');
  const nbm  = state.get('nodeById');
  if (!root || !nbm) return;

  const hit = sceneCore.pick(e.clientX, e.clientY);
  if (!hit) return;

  const meshNodeId = hit.object.userData?.meshNodeId;
  if (!meshNodeId) return;

  // Double-click selects all meshes in the nearest container (model/folder)
  const container = getNearestContainerAncestor(root, meshNodeId);
  if (!container) return;

  // Collect every mesh descendant of the container
  const meshIds = new Set();
  const walk = n => {
    if (n.type === 'mesh') meshIds.add(n.id);
    (n.children || []).forEach(walk);
  };
  walk(container);

  state.setSelection(container.id, meshIds);
  materials.applySelectionHighlight(meshIds);
});

// ── Context menu on viewport ──────────────────────────────────────────────────

canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  hideContextMenu();

  // Gizmo gets first right-click: opens transform panel
  if (gizmo.onRightClick(e.clientX, e.clientY)) return;

  const selId = state.get('selectedId');
  const nodeById = state.get('nodeById');
  const node = selId && nodeById ? nodeById.get(selId) : null;
  const isTransformable = node && node.type !== 'mesh' && node.type !== 'scene';

  const items = [];
  if (isTransformable) {
    items.push({ label: '↺ Reset transform', action: () => resetTransform(selId) });
    items.push({ label: '─', disabled: true });
  }
  items.push({
    label: 'Fit view  [F]',
    action: () => {
      if (!sceneCore.rootGroup || !window.THREE) return;
      const box = new THREE.Box3().setFromObject(sceneCore.rootGroup);
      if (!box.isEmpty()) sceneCore.animateCameraTo(sceneCore.fitStateForBox(box, 1.15), 800, 'smooth');
    },
  });
  if (selId) {
    items.push({ label: 'Deselect  [Esc]', action: () => { actionClearSelection(); gizmo.hide(); } });
  }

  if (items.length) showContextMenu(items, e.clientX, e.clientY);
});

// ── Window resize ─────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  if (!viewer) return;
  const w = viewer.clientWidth;
  const h = viewer.clientHeight;
  sceneCore.renderer.setSize(w, h);
  sceneCore.camera.aspect = w / h;
  sceneCore.camera.updateProjectionMatrix();
});

// ══════════════════════════════════════════════════════════════════════════════
//  7. KEYBOARD SHORTCUTS
// ══════════════════════════════════════════════════════════════════════════════

window.addEventListener('keydown', async e => {
  if (_isInputFocused()) return;

  const mod = e.ctrlKey || e.metaKey;
  const key = e.key;

  // ── File ────────────────────────────────────────────────────────────────
  if (mod && !e.shiftKey && key === 's') {
    e.preventDefault();
    const r = await saveProject({ mode: 'auto', suggestedName: getSuggestedFilename() });
    if (r.saved) setStatus(`Saved: ${state.get('projectName')}.`);
    return;
  }
  if (mod && e.shiftKey && key === 'S') {
    e.preventDefault();
    const r = await saveProject({ mode: 'saveAs', suggestedName: getSuggestedFilename() });
    if (r.saved) setStatus(`Saved: ${state.get('projectName')}.`);
    return;
  }

  // ── Step navigation ──────────────────────────────────────────────────────
  if (key === 'ArrowLeft')  { e.preventDefault(); steps.activateRelativeStep(-1); return; }
  if (key === 'ArrowRight') { e.preventDefault(); steps.activateRelativeStep(+1); return; }
  if (key === ' ')          { e.preventDefault(); steps.activateRelativeStep(+1); return; }

  // ── Gizmo space toggle (Local ↔ World) ──────────────────────────────────
  if (key === 'l' || key === 'L') {
    e.preventDefault();
    gizmo.toggleSpace();
    return;
  }

  // ── Fit ──────────────────────────────────────────────────────────────────
  if (key === 'f' || key === 'F') {
    e.preventDefault();
    if (!sceneCore.rootGroup || !window.THREE) return;
    const box = new THREE.Box3().setFromObject(sceneCore.rootGroup);
    if (!box.isEmpty()) {
      sceneCore.animateCameraTo(sceneCore.fitStateForBox(box, 1.15), 800, 'smooth');
    }
    return;
  }

  // ── Selection ────────────────────────────────────────────────────────────
  if (key === 'Escape') {
    if (gizmo.isDragging) { gizmo.onPointerUp(); return; }
    gizmo.setMode('all');
    state.clearSelection();
    materials.applySelectionHighlight([]);
    gizmo.hide();
    return;
  }

  // ── Delete empty folder ──────────────────────────────────────────────────
  if (key === 'Delete' || key === 'Backspace') {
    const selId  = state.get('selectedId');
    const nbm    = state.get('nodeById');
    if (!selId || !nbm) return;
    const node = nbm.get(selId);
    if (node?.type === 'folder' && !(node.children?.length)) {
      const root = state.get('treeData');
      const { removed } = removeNodeById(root, selId);
      if (removed?.object3d?.parent) removed.object3d.parent.remove(removed.object3d);
      state.setState({ nodeById: buildNodeMap(root) });
      state.clearSelection();
      steps.scheduleTransformSync();
      state.markDirty();
      setStatus(`Deleted folder "${removed?.name}".`);
    }
    return;
  }
}, { capture: true });

function _isInputFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

// ══════════════════════════════════════════════════════════════════════════════
//  8. DOCUMENT TITLE — tracks project name + dirty state
// ══════════════════════════════════════════════════════════════════════════════

function _updateTitle() {
  const dirty = state.get('projectDirty');
  const name  = state.get('projectName') || 'Untitled';
  document.title = `${dirty ? '● ' : ''}${name} — SBS Step Browser`;
}
state.on('change:projectDirty', _updateTitle);
state.on('change:projectName',  _updateTitle);
_updateTitle();

// ══════════════════════════════════════════════════════════════════════════════
//  9. START RENDER LOOP
// ══════════════════════════════════════════════════════════════════════════════

sceneCore.startLoop();

// ══════════════════════════════════════════════════════════════════════════════
//  10. DEV GLOBALS — only in development
// ══════════════════════════════════════════════════════════════════════════════

if (window.location.hostname === 'localhost' || window.location.protocol === 'file:') {
  window._sbs = { state, sceneCore, steps, materials };
}

// ══════════════════════════════════════════════════════════════════════════════
//  Ready
// ══════════════════════════════════════════════════════════════════════════════

setStatus('Ready.', 'ok', 2000);
