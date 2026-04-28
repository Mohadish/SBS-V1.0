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
import * as actions from './systems/actions.js';
const { setupUndoKeyboard, setSelection: actionSetSelection, clearSelection: actionClearSelection, resetTransform } = actions;
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
import { initCables, resolveNodeWorldPosition } from './systems/cables.js';        // C1: cables wire step:applied → applyStepSnapshot; C5-B: pos resolver for gizmo target
import { initCableRender, getCablePointMeshes, getCableSegmentMeshes } from './systems/cables-render.js';  // C2: cables 3D render; C5-A: point raycast targets; C5-D: segment raycast for Insert
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
  // C5-B: cable-point selection takes precedence over mesh selection
  // (selectCablePoint clears mesh selection so they're mutually
  // exclusive in practice — but check first to be safe).
  const cableSel = state.get('selectedCablePoint');
  if (cableSel) {
    const target = _buildCablePointGizmoTarget(cableSel.cableId, cableSel.nodeId);
    if (target) { gizmo.showForCablePoint(target); return; }
    // Fall through to hide if target couldn't be built (free / branch
    // / unresolved anchor — gizmo only handles mesh anchors).
    gizmo.hide();
    return;
  }
  const selId  = state.get('selectedId');
  const nodeById = state.get('nodeById');
  if (!selId || !nodeById) { gizmo.hide(); return; }
  const node = nodeById.get(selId);
  if (!node || node.type === 'mesh' || node.type === 'scene') { gizmo.hide(); return; }
  const obj3d = steps.object3dById?.get(selId);
  if (!obj3d) { gizmo.hide(); return; }
  gizmo.show(node, obj3d);
}

/**
 * C5-B: build a cable-point gizmo target — only succeeds for mesh-
 * anchored nodes. Free / branch nodes return null (gizmo stays hidden,
 * point is still selectable for visual context but not movable). The
 * world-pos getter resolves through the cables system's 3-tier
 * resolver so a missing host mesh falls through to the cached pose.
 */
function _buildCablePointGizmoTarget(cableId, nodeId) {
  const cables = state.get('cables') || [];
  const cable  = cables.find(c => c.id === cableId);
  const node   = cable?.nodes?.find(n => n.id === nodeId);
  if (!node || node.anchorType !== 'mesh') return null;
  const T = window.THREE;
  return {
    cableId, nodeId,
    getWorldPos() {
      const cables = state.get('cables') || [];
      const c = cables.find(x => x.id === cableId);
      const n = c?.nodes?.find(x => x.id === nodeId);
      if (!n) return null;
      // Use the cables-system resolver to handle live / cached / phantom.
      const ctx = { makeVec3: (x, y, z) => new T.Vector3(x, y, z) };
      const r   = resolveNodeWorldPosition(n, ctx);
      return r.pos ? new T.Vector3(r.pos[0], r.pos[1], r.pos[2]) : null;
    },
    /**
     * Surface-aligned gizmo frame. Returns a world quaternion mapping
     * +Z to the host face's outward normal (so the Z handle moves the
     * point along the normal, X/Y slide along the surface). Falls back
     * to the host mesh's world quat if normalLocal isn't recorded;
     * identity if no host can be resolved.
     */
    getWorldQuat() {
      const cables = state.get('cables') || [];
      const c = cables.find(x => x.id === cableId);
      const n = c?.nodes?.find(x => x.id === nodeId);
      if (!n || n.anchorType !== 'mesh' || !n.nodeId) return new T.Quaternion();
      const sceneNode = state.get('nodeById')?.get?.(n.nodeId);
      const obj = sceneNode?.object3d;
      if (!obj) return new T.Quaternion();
      const meshQ = new T.Quaternion();
      obj.getWorldQuaternion(meshQ);
      if (Array.isArray(n.normalLocal) && n.normalLocal.length === 3) {
        const normalLocal = new T.Vector3(n.normalLocal[0], n.normalLocal[1], n.normalLocal[2]);
        const worldNormal = normalLocal.applyQuaternion(meshQ).normalize();
        const q = new T.Quaternion();
        q.setFromUnitVectors(new T.Vector3(0, 0, 1), worldNormal);
        return q;
      }
      return meshQ;
    },
    beginMove() { actions.beginCablePointMove(cableId, nodeId); },
    applyCumulativeDelta(worldDelta) {
      actions.applyCablePointCumulativeDelta(cableId, nodeId, worldDelta);
    },
    commitMove() { actions.commitCablePointMove(cableId, nodeId); },
  };
}
state.on('selection:change',           _syncGizmoToSelection);
state.on('change:treeData',            _syncGizmoToSelection);
state.on('change:selectedCablePoint',  _syncGizmoToSelection);

// ══════════════════════════════════════════════════════════════════════════════
//  6. VIEWPORT EVENT HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

const canvas = sceneCore.renderer.domElement;

// P-P1+: crosshair cursor while pivot-snap pick mode is active so the
// user knows the next click is a target-pick. Cleared on snap or Esc.
state.on('change:pivotSnapPickingNodeId', id => {
  canvas.style.cursor = id ? 'crosshair' : '';
});
// C3: same crosshair signal for cable placement mode.
state.on('change:cablePlacingId', id => {
  canvas.style.cursor = id ? 'crosshair' : '';
});
// C5-C: same crosshair signal for cable re-anchor pick mode.
state.on('change:cableReanchorPickingId', target => {
  canvas.style.cursor = target ? 'crosshair' : '';
});
// C5-D: same crosshair signal for cable insert-point pick mode.
state.on('change:cableInsertPickingTarget', target => {
  canvas.style.cursor = target ? 'crosshair' : '';
});

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

  // P-P1+: snap-to-surface pick mode consumes the click — raycast
  // against the scene, snap pivot if there's a hit, otherwise cancel.
  // Runs BEFORE the gizmo so the user can target a face that happens
  // to be behind / under a gizmo handle.
  const snapPickNodeId = state.get('pivotSnapPickingNodeId');
  if (snapPickNodeId) {
    e.preventDefault();
    e.stopPropagation();
    const hit = sceneCore.pick(e.clientX, e.clientY);
    if (hit) actions.snapPivotToHit(snapPickNodeId, hit);
    else     actions.cancelPivotSnapPicking();
    return;
  }

  // C5-C: cable re-anchor pick mode — raycast for a mesh; if hit,
  // re-anchor the staged cable point; else cancel silently. Runs
  // before the gizmo so the user can target a face under a handle.
  const reanchorTarget = state.get('cableReanchorPickingId');
  if (reanchorTarget) {
    e.preventDefault();
    e.stopPropagation();
    const hit = sceneCore.pick(e.clientX, e.clientY);
    if (hit) actions.reanchorCablePoint(hit);
    else     actions.cancelCableReanchorPicking();
    return;
  }

  // C5-D: cable insert-point pick mode — splice a new anchored point
  // before/after a chosen anchor node. Same pattern as re-anchor.
  const insertTarget = state.get('cableInsertPickingTarget');
  if (insertTarget) {
    e.preventDefault();
    e.stopPropagation();
    const hit = sceneCore.pick(e.clientX, e.clientY);
    if (hit) actions.insertCablePointAtHit(hit);
    else     actions.cancelCableInsertPicking();
    return;
  }

  // C3: cable placement mode consumes the click — raycast for a
  // mesh anchor; if no mesh is hit the click is silently ignored.
  // Free points (ground-plane fallback) were dropped in Phase B per
  // the "every cable node attaches to an object" rule. To wire a
  // cable in air, future helper/null tree nodes will provide an
  // attachable surface. Stays in placement mode for repeated
  // clicks; user exits via Esc or the Stop Placement button.
  const placingCableId = state.get('cablePlacingId');
  if (placingCableId) {
    e.preventDefault();
    e.stopPropagation();
    const hit = sceneCore.pick(e.clientX, e.clientY);
    if (hit) {
      actions.addCableAnchoredPoint(placingCableId, hit);
    } else {
      setStatus('Cable points must attach to a mesh — click an object.', 'warn', 1500);
    }
    return;
  }

  // Gizmo gets first chance
  if (gizmo.onPointerDown(e.clientX, e.clientY)) {
    canvas.setPointerCapture(e.pointerId);
    _gizmoConsumed = true;
    return;
  }

  // P-P1: any viewport pointerdown OUTSIDE a gizmo handle while in
  // pivot edit mode commits the edit (RED → BLUE per spec). Doesn't
  // consume the event — selection / drag-select still proceeds normally
  // (the user might click an object as a way to commit + select).
  if (state.get('pivotEditNodeId')) {
    actions.commitPivotEdit();
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

// ── Cable point picking (Phase A) ────────────────────────────────────────────
// CableRoot lives directly on sceneCore.scene (not under rootGroup), so the
// generic sceneCore.pick() can't see the point spheres. Run a dedicated
// raycast against `getCablePointMeshes()` and return the closest hit's
// userData. Caller checks for null.

function _pickCablePoint(clientX, clientY) {
  if (!window.THREE) return null;
  const meshes = getCablePointMeshes();
  if (!meshes.length) return null;
  const T = window.THREE;
  const rect = canvas.getBoundingClientRect();
  const ndc = new T.Vector2(
    ((clientX - rect.left) / rect.width)  * 2 - 1,
    -((clientY - rect.top)  / rect.height) * 2 + 1,
  );
  const ray = new T.Raycaster();
  ray.setFromCamera(ndc, sceneCore.camera);
  const hits = ray.intersectObjects(meshes, false).filter(h => h.object.visible);
  if (!hits.length) return null;
  return {
    cableId: hits[0].object.userData.cableId,
    nodeId:  hits[0].object.userData.nodeId,
    object:  hits[0].object,
  };
}

/**
 * Phase D: raycast cable segment cylinders. Returns { cableId,
 * fromNodeId, toNodeId } for the closest hit segment, or null.
 */
function _pickCableSegment(clientX, clientY) {
  if (!window.THREE) return null;
  const meshes = getCableSegmentMeshes();
  if (!meshes.length) return null;
  const T = window.THREE;
  const rect = canvas.getBoundingClientRect();
  const ndc = new T.Vector2(
    ((clientX - rect.left) / rect.width)  * 2 - 1,
    -((clientY - rect.top)  / rect.height) * 2 + 1,
  );
  const ray = new T.Raycaster();
  ray.setFromCamera(ndc, sceneCore.camera);
  const hits = ray.intersectObjects(meshes, false).filter(h => h.object.visible);
  if (!hits.length) return null;
  return {
    cableId:    hits[0].object.userData.cableId,
    fromNodeId: hits[0].object.userData.fromNodeId,
    toNodeId:   hits[0].object.userData.toNodeId,
  };
}

// ── Click: select object ─────────────────────────────────────────────────────

canvas.addEventListener('click', e => {
  if (e.button !== 0) return;
  // Suppress click after gizmo interaction or drag-select
  if (_gizmoConsumed) { _gizmoConsumed = false; return; }
  if (_justDragged)   { _justDragged   = false; return; }
  hideContextMenu();

  // Phase A: cable points have priority over mesh selection AND don't
  // require a loaded tree (cables can exist without a model). Run this
  // BEFORE the tree/nbm guard or cables-only sessions never select.
  const cableHit = _pickCablePoint(e.clientX, e.clientY);
  if (cableHit) {
    actions.selectCablePoint(cableHit.cableId, cableHit.nodeId);
    return;
  }

  const root    = state.get('treeData');
  const nbm     = state.get('nodeById');
  if (!root || !nbm) return;

  const hit = sceneCore.pick(e.clientX, e.clientY);
  if (!hit) {
    if (!e.ctrlKey && !e.metaKey) {
      actionClearSelection();
      actions.clearCablePointSelection();
    }
    return;
  }

  const meshNodeId = hit.object.userData?.meshNodeId;
  if (!meshNodeId) return;

  // Selecting a mesh clears any cable-point selection — the gizmo can
  // only follow one target (mesh-folder OR cable-point), never both.
  actions.clearCablePointSelection();

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

  // C5-C/D: right-click on a cable point sphere → point menu (re-anchor,
  // delete). Wins over the gizmo's transform-panel popup because the
  // user's intent is the point itself.
  const cableHit = _pickCablePoint(e.clientX, e.clientY);
  if (cableHit) {
    actions.selectCablePoint(cableHit.cableId, cableHit.nodeId);
    // Look up the host node so the menu can reflect socket state.
    const cable = (state.get('cables') || []).find(c => c.id === cableHit.cableId);
    const node  = cable?.nodes?.find(n => n.id === cableHit.nodeId);
    const hasSocket = !!node?.socket;
    const items = [
      {
        label: '↺ Re-anchor…',
        action: () => actions.startCableReanchorPicking(cableHit.cableId, cableHit.nodeId),
      },
      { label: '─', disabled: true },
      hasSocket
        ? {
            label: '✕ Remove socket',
            action: () => actions.removeCableSocket(cableHit.cableId, cableHit.nodeId),
          }
        : {
            label: '＋ Add socket',
            action: () => actions.addCableSocket(cableHit.cableId, cableHit.nodeId),
          },
      { label: '─', disabled: true },
      {
        label: '✕ Delete this point',
        action: () => actions.deleteCablePoint(cableHit.cableId, cableHit.nodeId),
      },
      { label: '─', disabled: true },
      {
        label: 'Deselect  [Esc]',
        action: () => actions.clearCablePointSelection(),
      },
    ];
    showContextMenu(items, e.clientX, e.clientY);
    return;
  }

  // C5-D: right-click on a cable segment cylinder → "Insert point here".
  // Action enters pick-anchor mode; the next mesh click sets the new
  // point's anchor and splices it between the segment's two endpoints.
  const segHit = _pickCableSegment(e.clientX, e.clientY);
  if (segHit) {
    const items = [
      {
        label: '＋ Insert point here…',
        action: () => actions.startCableInsertPicking(segHit.cableId, segHit.fromNodeId, 'after'),
      },
    ];
    showContextMenu(items, e.clientX, e.clientY);
    return;
  }

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
    // Snap-to-surface mode is its own little modal — cancel that
    // before tearing down the selection.
    if (state.get('pivotSnapPickingNodeId')) {
      actions.cancelPivotSnapPicking();
      return;
    }
    // C3: cable placement is a modal too — Esc exits without
    // touching the rest of the selection.
    if (state.get('cablePlacingId')) {
      actions.stopCablePlacement();
      return;
    }
    // C5-C: cable re-anchor pick mode — Esc cancels the pick.
    if (state.get('cableReanchorPickingId')) {
      actions.cancelCableReanchorPicking();
      return;
    }
    // C5-D: cable insert-point pick mode — Esc cancels the pick.
    if (state.get('cableInsertPickingTarget')) {
      actions.cancelCableInsertPicking();
      return;
    }
    // Phase A: clear any cable-point selection alongside mesh selection.
    actions.clearCablePointSelection();
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
