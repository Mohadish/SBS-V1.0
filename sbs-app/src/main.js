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
import { showMoveToFolderDialog } from './ui/tree.js';
import { positionSafeFrameEl }    from './core/safe-frame.js';
import { initOverlay, getStage as getOverlayStage } from './systems/overlay.js';
import { initOverlayToolbar }  from './ui/overlay-toolbar.js';
import { initHeaderLayer }     from './systems/header.js';
import { initCables, resolveNodeWorldPosition } from './systems/cables.js';        // C1: cables wire step:applied → applyStepSnapshot; C5-B: pos resolver for gizmo target
import * as pivotCenterPicker     from './systems/pivot-center-picker.js';   // 3-point center pivot tool — snap-based picker for cylinder-axis pivot placement
import { initNotesRender }        from './systems/notes-render.js';
import { initCableRender, getCablePointMeshes, getCableSegmentMeshes, getCableSocketMeshes, setInsertHoverPosition } from './systems/cables-render.js';  // C2: cables 3D render; C5-A: point raycast; C5-D: segment raycast + insert ghost; C5-E2: socket raycast
import { initUserSettings }    from './core/user-settings.js';
import { openSettingsModal }   from './ui/settings-modal.js';
import { openModelSourceDialog } from './ui/model-source-dialog.js';
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
// 3D-anchored balloon notes — registers a render-loop tick hook that
// projects each note's mesh-local anchor to canvas pixels and updates
// its DOM div + SVG tail.
initNotesRender();
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
// Edit → Model source transform… opens a floating, draggable window.
// No takeover, no tab — just a window. Cascade-through-snapshots
// architecture (see ui/model-source-dialog.js + actions.js).
window.sbsNative?.onMenu?.('menu:modelSourceTransform', () => openModelSourceDialog());

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
  // E2: socket selection takes the highest precedence — the actions
  // make the three selection states mutually exclusive, but order
  // here defensively in case a future caller sets two at once.
  const sockSel = state.get('selectedCableSocket');
  if (sockSel) {
    const target = _buildCableSocketGizmoTarget(sockSel.cableId, sockSel.nodeId);
    if (target) { gizmo.showForCableSocket(target); return; }
    gizmo.hide();
    return;
  }
  // C5-B: cable-point selection — translate-only gizmo.
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
/**
 * E2: build a cable-socket gizmo target. Same translate plumbing as
 * the point target (translate moves the host point — socket follows
 * by construction), plus rotate hooks that write the socket's
 * localQuaternion. World quat composes mesh-world * localQuaternion
 * (or a normal-derived default when localQuaternion isn't set yet).
 */
function _buildCableSocketGizmoTarget(cableId, nodeId) {
  const cables = state.get('cables') || [];
  const cable  = cables.find(c => c.id === cableId);
  const node   = cable?.nodes?.find(n => n.id === nodeId);
  if (!node || !node.socket || node.anchorType !== 'mesh') return null;
  const T = window.THREE;
  return {
    cableId, nodeId,
    hasRotate: true,
    /**
     * Stage 2: gizmo position = BACK face (the surface-touching end).
     * Rotate / scale therefore pivot off the surface attachment, not
     * the cable point. Falls through to the cable-point world pos if
     * the back face can't be resolved (no socket / no host mesh).
     */
    getWorldPos() {
      const back = actions.socketBackFaceWorld(cableId, nodeId);
      if (back) return back;
      const cs = state.get('cables') || [];
      const c = cs.find(x => x.id === cableId);
      const n = c?.nodes?.find(x => x.id === nodeId);
      if (!n) return null;
      const ctx = { makeVec3: (x, y, z) => new T.Vector3(x, y, z) };
      const r   = resolveNodeWorldPosition(n, ctx);
      return r.pos ? new T.Vector3(r.pos[0], r.pos[1], r.pos[2]) : null;
    },
    getWorldQuat() {
      const cs = state.get('cables') || [];
      const c = cs.find(x => x.id === cableId);
      const n = c?.nodes?.find(x => x.id === nodeId);
      if (!n?.socket || n.anchorType !== 'mesh' || !n.nodeId) return new T.Quaternion();
      const sceneNode = state.get('nodeById')?.get?.(n.nodeId);
      const obj = sceneNode?.object3d;
      if (!obj) return new T.Quaternion();
      const meshQ = new T.Quaternion();
      obj.getWorldQuaternion(meshQ);
      if (Array.isArray(n.socket.localQuaternion) && n.socket.localQuaternion.length === 4) {
        const local = new T.Quaternion(
          n.socket.localQuaternion[0], n.socket.localQuaternion[1],
          n.socket.localQuaternion[2], n.socket.localQuaternion[3],
        );
        return meshQ.clone().multiply(local);
      }
      // No localQuaternion → derive from normalLocal (matches render).
      if (Array.isArray(n.normalLocal) && n.normalLocal.length === 3) {
        const normalLocal = new T.Vector3(n.normalLocal[0], n.normalLocal[1], n.normalLocal[2]);
        const worldNormal = normalLocal.applyQuaternion(meshQ).normalize();
        const q = new T.Quaternion();
        q.setFromUnitVectors(new T.Vector3(0, 0, 1), worldNormal);
        return q;
      }
      return meshQ;
    },
    // Translate routes to the cable point (the socket has no separate
    // position offset — moving the host point moves the socket).
    beginMove() { actions.beginCablePointMove(cableId, nodeId); },
    applyCumulativeDelta(worldDelta) {
      actions.applyCablePointCumulativeDelta(cableId, nodeId, worldDelta);
    },
    commitMove() { actions.commitCablePointMove(cableId, nodeId); },
    // Rotate writes node.socket.localQuaternion via the dedicated batch.
    beginRotate() { actions.beginCableSocketRotate(cableId, nodeId); },
    applyRotateAroundAxis(worldAxis, angle) {
      actions.applyCableSocketRotateAxisAngle(cableId, nodeId, worldAxis, angle);
    },
    commitRotate() { actions.commitCableSocketRotate(cableId, nodeId); },
  };
}
state.on('selection:change',            _syncGizmoToSelection);
state.on('change:treeData',             _syncGizmoToSelection);
state.on('change:selectedCablePoint',   _syncGizmoToSelection);
state.on('change:selectedCableSocket',  _syncGizmoToSelection);

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
// C5-E2: same crosshair signal for socket re-anchor pick mode.
state.on('change:cableSocketReanchorPickingId', target => {
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

  // Note picking — clicks while in this mode raycast the scene; on a
  // hit landing on the same mesh, a balloon note is created at the hit
  // point. On any other hit (or no hit), pick mode is cancelled. Runs
  // before the gizmo so face hits are honoured even under handles.
  const notePickMeshId = state.get('notePickingMeshId');
  if (notePickMeshId) {
    e.preventDefault();
    e.stopPropagation();
    const hit = sceneCore.pick(e.clientX, e.clientY);
    if (hit?.object?.userData?.meshNodeId === notePickMeshId) {
      actions.createNoteAtHit(notePickMeshId, hit);
    } else {
      actions.cancelNotePicking();
    }
    return;
  }

  // 3-point center pivot: clicks while in this mode are routed to the
  // picker (snap to vertex/edge, place a cross, remove cross, or commit).
  // Runs BEFORE the gizmo so picks land regardless of handle overlap.
  if (state.get('pivotCenterPickingNodeId')) {
    e.preventDefault();
    e.stopPropagation();
    pivotCenterPicker.onPointerDown(e.clientX, e.clientY);
    return;
  }

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

  // C5-D: cable insert-point pick mode. A click on a mesh inserts a
  // new anchored point; a click on empty space is ignored (the user
  // is mid-aim — ESC cancels). The ghost preview (pointermove handler
  // below) shows where the new point would land.
  const insertTarget = state.get('cableInsertPickingTarget');
  if (insertTarget) {
    e.preventDefault();
    e.stopPropagation();
    const hit = sceneCore.pick(e.clientX, e.clientY);
    if (hit) actions.insertCablePointAtHit(hit);
    return;
  }

  // C5-E2: socket re-anchor pick — same pattern as point re-anchor
  // but writes the socket's surface attachment to a new mesh + face.
  const sockReanchor = state.get('cableSocketReanchorPickingId');
  if (sockReanchor) {
    e.preventDefault();
    e.stopPropagation();
    const hit = sceneCore.pick(e.clientX, e.clientY);
    if (hit) actions.applyCableSocketReanchor(hit);
    else     actions.cancelCableSocketReanchor();
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
    // 3-point pivot center mode — refresh the snap hover marker.
    if (state.get('pivotCenterPickingNodeId')) {
      pivotCenterPicker.updateHover(e.clientX, e.clientY);
      return;
    }

    // C5-D: insert-point pick mode — update the ghost-preview sphere
    // to track the cursor's mesh hit so the user sees where the new
    // point would land. Cleared on a hit-miss frame so it disappears
    // when over empty space.
    if (state.get('cableInsertPickingTarget')) {
      const hit = sceneCore.pick(e.clientX, e.clientY);
      setInsertHoverPosition(hit ? hit.point : null);
      return;
    }
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

// C5-D: clear the insert ghost whenever the pick mode ends (success
// / Esc / external cancel). One subscription, idempotent.
state.on('change:cableInsertPickingTarget', target => {
  if (!target) setInsertHoverPosition(null);
});

// 3-point center pivot — clear hover marker when cursor leaves the
// viewport (no pointermove fires off-canvas, so the last marker would
// linger otherwise).
canvas.addEventListener('pointerleave', () => {
  if (state.get('pivotCenterPickingNodeId')) pivotCenterPicker.updateHover(-9999, -9999);
});

// Status feedback as the user picks points, so the HUD reflects the
// "1/3 picked" / "ready — click empty or Enter" state.
state.on('change:pivotCenterPickingNodeId', id => {
  if (!id) return;
  setStatus('Pick 3 points (snap to vertex/edge). Enter to apply, Esc to cancel.', 'info', 0);
});

// Status feedback while waiting for the user to click a face for a new note.
state.on('change:notePickingMeshId', id => {
  if (!id) return;
  setStatus('Click a face on the mesh to anchor the note. Esc to cancel.', 'info', 0);
});

// Multi-step "danger zone" — toggle the yellow viewport ring whenever
// the multi-step selection's size crosses the 2-step threshold. The
// CSS rule (#viewport-surface.multi-step-active::after) draws the ring;
// JS only owns the class. Hidden/revealed by Esc, banner Clear, plain
// step click, and outside-click — all of which mutate selectedStepIds.
state.on('change:selectedStepIds', () => {
  const sel    = state.get('selectedStepIds');
  const active = sel instanceof Set && sel.size >= 2;
  const surf   = document.getElementById('viewport-surface');
  if (surf) surf.classList.toggle('multi-step-active', active);
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

/**
 * E2: raycast cable socket boxes. Returns { cableId, nodeId } for the
 * closest hit socket, or null.
 */
function _pickCableSocket(clientX, clientY) {
  if (!window.THREE) return null;
  const meshes = getCableSocketMeshes();
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
  // E2: socket pick after point pick — the point sphere sits at the
  // socket's front face so it eats clicks at the very front; clicking
  // the body of the box selects the socket.
  const socketHit = _pickCableSocket(e.clientX, e.clientY);
  if (socketHit) {
    actions.selectCableSocket(socketHit.cableId, socketHit.nodeId);
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
      actions.clearCableSocketSelection();
    }
    return;
  }

  const meshNodeId = hit.object.userData?.meshNodeId;
  if (!meshNodeId) return;

  // Selecting a mesh clears any cable-point / socket selection — the
  // gizmo can only follow one target at a time.
  actions.clearCablePointSelection();
  actions.clearCableSocketSelection();

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

  // 3-point center pivot — show a tool-specific menu in this mode and
  // suppress the regular viewport context menu.
  if (state.get('pivotCenterPickingNodeId')) {
    const canApply = pivotCenterPicker.canApply();
    const havePts  = pivotCenterPicker.getPoints().length > 0;
    showContextMenu([
      {
        label: '✓ Apply (Enter)',
        disabled: !canApply,
        action: () => pivotCenterPicker.apply(),
      },
      {
        label: '⌫ Remove last point  [Backspace]',
        disabled: !havePts,
        action: () => pivotCenterPicker.removeLast(),
      },
      {
        label: '🗙 Clear all points',
        disabled: !havePts,
        action: () => pivotCenterPicker.clearAll(),
      },
      { label: '─', disabled: true },
      {
        label: '✕ Cancel  [Esc]',
        action: () => actions.cancelPivotCenterPicking(),
      },
    ], e.clientX, e.clientY);
    return;
  }

  // C5-C/D: right-click on a cable point sphere → point menu (re-anchor,
  // delete). Wins over the gizmo's transform-panel popup because the
  // user's intent is the point itself.
  const cableHit = _pickCablePoint(e.clientX, e.clientY);
  if (cableHit) {
    actions.selectCablePoint(cableHit.cableId, cableHit.nodeId);
    // Look up the host node so the menu can reflect socket + position state.
    const cable = (state.get('cables') || []).find(c => c.id === cableHit.cableId);
    const node  = cable?.nodes?.find(n => n.id === cableHit.nodeId);
    const hasSocket = !!node?.socket;
    const nodeCount = cable?.nodes?.length ?? 0;
    const isLast    = nodeCount > 0 && cable.nodes[nodeCount - 1].id === cableHit.nodeId;
    // Prepending only valid for non-branch cables — branch cables
    // require their branch-start node to stay at index 0.
    const isFirst   = nodeCount > 0 && cable.nodes[0].id === cableHit.nodeId;
    const canPrepend = isFirst && !cable.branchSource;
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
      {
        label: '⌥ Branch from here…',
        action: () => actions.createBranchFromCablePoint(cableHit.cableId, cableHit.nodeId),
      },
      ...(isLast ? [{
        label: '→ Continue routing (end)',
        action: () => actions.startCablePlacement(cableHit.cableId),
      }] : []),
      ...(canPrepend ? [{
        label: '← Continue routing (start)',
        action: () => actions.startCablePlacement(cableHit.cableId, { atStart: true }),
      }] : []),
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

  // C5-E2: right-click on a socket box → socket menu (re-anchor +
  // remove). Auto-select the socket so the gizmo follows.
  const socketHit = _pickCableSocket(e.clientX, e.clientY);
  if (socketHit) {
    actions.selectCableSocket(socketHit.cableId, socketHit.nodeId);
    const sockCable = (state.get('cables') || []).find(c => c.id === socketHit.cableId);
    const sockNodeCount = sockCable?.nodes?.length ?? 0;
    const sockIsLast    = sockNodeCount > 0 && sockCable.nodes[sockNodeCount - 1].id === socketHit.nodeId;
    const sockIsFirst   = sockNodeCount > 0 && sockCable.nodes[0].id === socketHit.nodeId;
    const sockCanPrepend = sockIsFirst && !sockCable?.branchSource;
    const items = [
      {
        label: '↺ Re-anchor socket…',
        action: () => actions.startCableSocketReanchor(socketHit.cableId, socketHit.nodeId),
      },
      ...(sockIsLast ? [{
        label: '→ Continue routing (end)',
        action: () => actions.startCablePlacement(socketHit.cableId),
      }] : []),
      ...(sockCanPrepend ? [{
        label: '← Continue routing (start)',
        action: () => actions.startCablePlacement(socketHit.cableId, { atStart: true }),
      }] : []),
      { label: '─', disabled: true },
      {
        label: '✕ Remove socket',
        action: () => actions.removeCableSocket(socketHit.cableId, socketHit.nodeId),
      },
      { label: '─', disabled: true },
      {
        label: 'Deselect  [Esc]',
        action: () => actions.clearCableSocketSelection(),
      },
    ];
    showContextMenu(items, e.clientX, e.clientY);
    return;
  }

  // C5-D revision: right-click on a cable segment immediately inserts
  // a point AT THE CLICK position, inheriting the predecessor point's
  // host mesh + normal (re-anchor / move available afterwards).
  // Need the world hit on the segment cylinder — re-raycast against
  // the segment meshes here so the menu action has the world point.
  const segHit = _pickCableSegment(e.clientX, e.clientY);
  if (segHit) {
    // Recover the world hit point — _pickCableSegment doesn't return
    // it. Run a quick raycast against the segment meshes only.
    const T = window.THREE;
    const meshes = getCableSegmentMeshes();
    const rect = canvas.getBoundingClientRect();
    const ndc = new T.Vector2(
      ((e.clientX - rect.left) / rect.width)  * 2 - 1,
      -((e.clientY - rect.top)  / rect.height) * 2 + 1,
    );
    const ray = new T.Raycaster();
    ray.setFromCamera(ndc, sceneCore.camera);
    const hits = ray.intersectObjects(meshes, false).filter(h => h.object.visible);
    const hitPoint = hits[0]?.point;
    const items = [
      {
        label: '＋ Insert point here',
        action: () => {
          if (!hitPoint) return;
          actions.insertCablePointAtSegmentHit(segHit.cableId, segHit.fromNodeId, hitPoint);
        },
      },
    ];
    showContextMenu(items, e.clientX, e.clientY);
    return;
  }

  // Gizmo gets first right-click: opens transform panel
  if (gizmo.onRightClick(e.clientX, e.clientY)) return;

  const selId = state.get('selectedId');
  const nodeById = state.get('nodeById');
  const multiIds = state.get('multiSelectedIds') || new Set();
  const node = selId && nodeById ? nodeById.get(selId) : null;
  const isTransformable = node && node.type !== 'mesh' && node.type !== 'scene';
  const hasSel = !!selId && multiIds.size > 0;

  // Note-add hit: a fresh raycast at the right-click position so the
  // menu item creates a note at the FACE the user actually right-clicked,
  // not the current selection. Only valid when the click landed on a
  // real (non-placeholder) mesh.
  const noteHit  = sceneCore.pick(e.clientX, e.clientY);
  const noteMesh = noteHit?.object;
  const noteMeshId = noteMesh?.userData?.meshNodeId;
  const canAddNoteHere = !!(
    noteMeshId &&
    nodeById?.get(noteMeshId)?.type === 'mesh' &&
    !noteMesh?.userData?.isPlaceholder
  );

  const items = [];
  if (canAddNoteHere) {
    items.push({
      label: '💬 Add Note here',
      action: () => actions.createNoteAtHit(noteMeshId, noteHit),
    });
    items.push({ label: '─', disabled: true });
  }
  if (isTransformable) {
    items.push({ label: '↺ Reset transform', action: () => resetTransform(selId) });
    items.push({ label: '─', disabled: true });
  }
  if (hasSel) {
    items.push({
      label: '👁 Hide / Show',
      action: () => actions.toggleVisibility(multiIds),
    });
    items.push({
      label: '◎ Isolate',
      action: () => actions.isolateSelection(),
    });
    if (actions.hasIsolateSnapshot()) {
      items.push({
        label: '◌ Un-isolate',
        action: () => actions.unisolate(),
      });
    }
    items.push({
      label: '⊕ Move to folder…',
      action: () => showMoveToFolderDialog([...multiIds]),
    });
    items.push({
      label: '⊡ Fit to selection',
      action: () => _fitToSelection(multiIds),
    });
    items.push({ label: '─', disabled: true });
  }
  // Two flavours of "Update camera" — free saves to this step's snapshot
  // (always-free, drops any prior template binding); template updates
  // the template the active step is bound to (propagating to every other
  // bound step). Disabled when there's no template binding to target.
  const _viewportActiveStepTplName = (() => {
    const aid = state.get('activeStepId');
    if (!aid) return null;
    const active = (state.get('steps') || []).find(s => s.id === aid);
    if (active?.cameraBinding?.mode !== 'template') return null;
    const tpl = (state.get('cameraViews') || []).find(v => v.id === active.cameraBinding.templateId);
    return tpl?.name || null;
  })();
  items.push({
    label: '◉ Update camera (free)',
    action: () => {
      const activeId = state.get('activeStepId');
      if (activeId) {
        actions.updateStepCameraFromCurrent(activeId);
        setStatus('Camera saved for step.');
      } else {
        setStatus('No active step.', 'warn');
      }
    },
  });
  items.push({
    label: _viewportActiveStepTplName
      ? `◎ Update camera (as template "${_viewportActiveStepTplName}")`
      : '◎ Update camera (as template — none active)',
    disabled: !_viewportActiveStepTplName,
    action: () => {
      const activeId = state.get('activeStepId');
      if (!activeId) return;
      actions.updateStepCameraAsTemplate([activeId]);
      setStatus(`Updated template "${_viewportActiveStepTplName}".`);
    },
  });
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

/**
 * Compute a Box3 over the union of all selected nodes' object3ds and
 * animate the camera to fit. Skips meshes that don't have a live obj3d.
 */
function _fitToSelection(ids) {
  if (!window.THREE || !ids?.size) return;
  const T = window.THREE;
  const box = new T.Box3();
  let any = false;
  for (const id of ids) {
    const obj = steps.object3dById?.get(id);
    if (!obj) continue;
    obj.updateMatrixWorld?.(true);
    box.expandByObject(obj);
    any = true;
  }
  if (!any || box.isEmpty()) return;
  sceneCore.animateCameraTo(sceneCore.fitStateForBox(box, 1.25), 800, 'smooth');
}


// ── Window resize ─────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  if (!viewer) return;
  // sceneCore.fitToCanonical() resizes the canvas backing buffer to
  // canonical W×H, sets camera aspect to canonical, and letterboxes
  // the canvas CSS to the safe-frame rect inside its container —
  // everything we used to do manually here is now centralised there.
  sceneCore.fitToCanonical();
  _refreshSafeFrame();
});

// Canonical size changes (user edits W/H in the Export tab) need to
// re-fit the canvas + camera + safe-frame outline. setExportOption
// fires change:export per key, so this can run multiple times on a
// preset switch — fit is idempotent so that's fine.
state.on('change:export', () => {
  sceneCore.fitToCanonical();
});

// ── Safe frame (canonical export rect) ────────────────────────────────────────
// Stage 1: render the safe-frame overlay element at the position
// computed from state.export.width/height. Stages 2+ will route
// overlay coordinates through this rect.
const _safeFrameEl   = document.getElementById('export-safe-frame');
const _viewportSurfaceEl = document.getElementById('viewport-surface');
function _refreshSafeFrame() {
  if (!_safeFrameEl) return;
  const showFrame = state.get('export')?.showSafeFrame !== false;
  // Toggle visibility via the .show class (CSS sets display:block when present).
  // Also strip the legacy `hidden` attribute on first run.
  _safeFrameEl.removeAttribute('hidden');
  _safeFrameEl.classList.toggle('show', !!showFrame);
  if (!showFrame) return;
  positionSafeFrameEl(_safeFrameEl, _viewportSurfaceEl || viewer);
}
_refreshSafeFrame();
state.on('change:export', _refreshSafeFrame);
// Track viewport-surface size — the renderer's resize handler already
// fires _refreshSafeFrame, but the surface can resize independently
// (sidebar collapse, etc.) so a ResizeObserver catches those too.
if (typeof ResizeObserver !== 'undefined' && _viewportSurfaceEl) {
  new ResizeObserver(_refreshSafeFrame).observe(_viewportSurfaceEl);
}

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

  // 3-point center pivot tool keyboard:
  //   Enter     → apply (when 3 picked)
  //   Backspace → remove last placed cross (local undo, doesn't touch
  //               the global undoManager)
  if (state.get('pivotCenterPickingNodeId')) {
    if (key === 'Enter' && pivotCenterPicker.canApply()) {
      e.preventDefault();
      pivotCenterPicker.apply();
      return;
    }
    if (key === 'Backspace') {
      e.preventDefault();
      pivotCenterPicker.removeLast();
      return;
    }
  }

  // ── Selection ────────────────────────────────────────────────────────────
  if (key === 'Escape') {
    if (gizmo.isDragging) { gizmo.onPointerUp(); return; }
    // 3-point center pivot — Esc cancels the whole picking session.
    if (state.get('pivotCenterPickingNodeId')) {
      actions.cancelPivotCenterPicking();
      return;
    }
    // Note picking — Esc cancels.
    if (state.get('notePickingMeshId')) {
      actions.cancelNotePicking();
      return;
    }
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
    // C5-E2: socket re-anchor pick — Esc cancels.
    if (state.get('cableSocketReanchorPickingId')) {
      actions.cancelCableSocketReanchor();
      return;
    }
    // Phase A/E2: clear any cable-point + socket selection alongside
    // the mesh selection.
    actions.clearCablePointSelection();
    actions.clearCableSocketSelection();
    gizmo.setMode('all');
    state.clearSelection();
    materials.applySelectionHighlight([]);
    gizmo.hide();
    // Multi-step selection is its own concept — clear it on Esc too so
    // a single Esc returns the timeline to "edit active step only" mode.
    // Goes through the action layer so the clear is undoable too.
    const stepSel = state.get('selectedStepIds');
    if (stepSel instanceof Set && stepSel.size) {
      actions.clearSelectedSteps();
    }
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
