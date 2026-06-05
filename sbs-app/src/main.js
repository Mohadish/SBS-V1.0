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
import { setOutlinePreview, clearOutlinePreview } from './systems/outline-pass.js';
import * as actions from './systems/actions.js';
const { setupUndoKeyboard, setSelection: actionSetSelection, clearSelection: actionClearSelection, resetTransform } = actions;
import { gizmo }           from './ui/gizmo.js';
import { initGizmoNumeric } from './ui/gizmo-numeric.js';
import * as shapeEditor   from './systems/shape-editor.js';   // Phase 1: 2D shapes in 3D
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
import { showActivationDialog, showHardLockDialog, showGraceWarning } from './ui/license-dialog.js';
import { initHud }                from './ui/hud.js';
import { initStepNav }            from './ui/step-nav.js';
import { initStepsPanel }         from './ui/steps-panel.js';
import { initSidebarLeft, showColorForNode } from './ui/sidebar-left.js';
import { initContextMenu, hideContextMenu, showContextMenu } from './ui/context-menu.js';
import { showMoveToFolderDialog, showAddToReplaceDialog, showReplaceModeDialog } from './ui/tree.js';
import { positionSafeFrameEl }    from './core/safe-frame.js';
import { initOverlay, getStage as getOverlayStage } from './systems/overlay.js';
import { initOverlayToolbar }  from './ui/overlay-toolbar.js';
import { initHeaderLayer }     from './systems/header.js';
import { initCables, resolveNodeWorldPosition } from './systems/cables.js';        // C1: cables wire step:applied → applyStepSnapshot; C5-B: pos resolver for gizmo target
import * as pivotCenterPicker     from './systems/pivot-center-picker.js';   // 3-point center pivot tool — snap-based picker for cylinder-axis pivot placement
import * as folderAlignPicker     from './systems/folder-align-picker.js';   // V0.2.22.32 — 1-point folder-to-surface align
import * as folderAlign3ptPicker  from './systems/folder-align-3pt-picker.js'; // V0.2.22.33 — 3-point concentric folder align

// ── V0.2.22.23 — pivot hover throttle ─────────────────────────────────────
// sceneCore.pick is O(scene) and runs ~75ms on a CAD project. Pointer-move
// fires at 100-1000Hz, so naively dispatching every event queues up picks
// and the snap marker lags behind the cursor. rAF-coalesce: store the
// LATEST cursor pos every event, fire one pick per animation frame max.
// The cursor->snap latency stays bounded (1 pick worth, ~75ms) regardless
// of how fast the user mouses.
let _pivotHoverPending = null;
let _pivotHoverRafId   = 0;
function _schedulePivotHover(x, y) {
  _pivotHoverPending = { x, y };
  if (_pivotHoverRafId) return;
  _pivotHoverRafId = requestAnimationFrame(() => {
    _pivotHoverRafId = 0;
    const p = _pivotHoverPending;
    _pivotHoverPending = null;
    if (p) pivotCenterPicker.updateHover(p.x, p.y);
  });
}
import { initNotesRender }        from './systems/notes-render.js';
import { initCableRender, getCablePointMeshes, getCableSegmentMeshes, getCableSocketMeshes, setInsertHoverPosition } from './systems/cables-render.js';  // C2: cables 3D render; C5-A: point raycast; C5-D: segment raycast + insert ghost; C5-E2: socket raycast
import { initUserSettings, get as getUserSettings } from './core/user-settings.js';
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
initGizmoNumeric(gizmo);   // live drag readout + numeric input mode

// Debug surface — exposes core handles on window.__sbs for live console
// inspection during development. Not used by app code.
if (typeof window !== 'undefined') {
  window.__sbs = Object.assign(window.__sbs || {}, { gizmo, sceneCore });
}

/**
 * Sync the Three.js scene background from project state. Two modes:
 *   • Solid colour (default) — scene.background = new THREE.Color.
 *   • Linear gradient (state.backgroundGradient.enabled) — bake a small
 *     canvas with a CSS-style linear-gradient at the requested angle,
 *     wrap as a CanvasTexture, set as scene.background. THREE.js will
 *     stretch it to fill the viewport.
 *
 * The texture is rebuilt every time state changes so colour / angle
 * tweaks are immediate. Cheap — 2x256 px canvas, runs once per change.
 */
let _bgTexture = null;
function _buildGradientTexture(c1, c2, angleDeg) {
  const W = 2, H = 256;       // 256-pixel resolution along the gradient axis is plenty
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  // CSS angle convention (0° = bottom→top in CSS terms but we use
  // 0° = top→bottom here so the user-visible direction picker is
  // intuitive for a backdrop). Convert to canvas vector.
  const rad = (angleDeg * Math.PI) / 180;
  const cx = W / 2, cy = H / 2;
  const r  = Math.max(W, H);
  const x1 = cx - Math.sin(rad) * r * 0.5;
  const y1 = cy - Math.cos(rad) * r * 0.5;
  const x2 = cx + Math.sin(rad) * r * 0.5;
  const y2 = cy + Math.cos(rad) * r * 0.5;
  const grad = ctx.createLinearGradient(x1, y1, x2, y2);
  grad.addColorStop(0, c1);
  grad.addColorStop(1, c2);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  const tex = new window.THREE.CanvasTexture(cv);
  if ('SRGBColorSpace' in window.THREE) tex.colorSpace = window.THREE.SRGBColorSpace;
  return tex;
}

function _syncBackground() {
  if (!window.THREE) return;
  const grad = state.get('backgroundGradient');
  if (grad?.enabled) {
    if (_bgTexture) _bgTexture.dispose?.();
    _bgTexture = _buildGradientTexture(
      grad.color1 ?? '#0f172a',
      grad.color2 ?? '#1e293b',
      Number.isFinite(grad.angleDeg) ? grad.angleDeg : 180,
    );
    sceneCore.scene.background = _bgTexture;
  } else {
    if (_bgTexture) { _bgTexture.dispose?.(); _bgTexture = null; }
    sceneCore.scene.background = new THREE.Color(state.get('backgroundColor') || '#0f172a');
  }
}
_syncBackground();
state.on('change:backgroundColor',    _syncBackground);
state.on('change:backgroundGradient', _syncBackground);

state.on('change:gridVisible', vis => {
  sceneCore.setGridVisible(vis);
});
// Sync grid visibility to the live state at boot — sceneCore.init's
// default is grid-on, but state's default is now grid-off. Without
// this line the grid would briefly show on a fresh app launch
// (until the user / a project load toggles it).
sceneCore.setGridVisible(!!state.get('gridVisible'));

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

// ── License gate ───────────────────────────────────────────────────────────
// Run BEFORE any heavy system init so a locked install never wastes time
// loading Three.js / Konva / Kokoro. The gate is async; we kick it off
// and let the rest of init continue underneath. The first user-facing
// UI (sidebar tabs) won't render until the gate resolves because the
// dialog covers the viewport.
_initLicenseGate();

// ── Dialog hygiene (universal close → remove) ──────────────────────────────
// 20+ <dialog> elements across the codebase are created with showModal()
// and torn down by hand. About half the callsites only remove the dialog
// on specific button click paths — Esc, programmatic .close(), and
// backdrop clicks leak a closed-but-still-attached <dialog> in the DOM.
// Closed dialogs are "inert" per spec but their presence can still
// interfere with focus restoration in Electron, which surfaces as the
// "voice-over / name inputs go unresponsive" bug.
//
// Rather than touch every callsite, patch HTMLDialogElement.prototype
// once: every dialog's first showModal() / show() call also registers
// a 'close' listener that auto-removes it from the DOM. Idempotent — a
// flag on the instance prevents double-registration.
//
// The 5-second janitor in actions.js is still wired as a belt-and-
// braces defense, but with this patch it should rarely have anything
// to clean up.
(function _installDialogHygiene() {
  if (typeof HTMLDialogElement === 'undefined') return;
  const _origShowModal = HTMLDialogElement.prototype.showModal;
  const _origShow      = HTMLDialogElement.prototype.show;
  const _ensureCleanup = (dlg) => {
    if (dlg.__sbsHygiene) return;
    dlg.__sbsHygiene = true;
    dlg.addEventListener('close', () => {
      // try is defensive — if some other path already removed the node,
      // .remove() throws DOMException; we don't care.
      try { if (dlg.isConnected) dlg.remove(); } catch {}
    });
  };
  HTMLDialogElement.prototype.showModal = function (...args) {
    _ensureCleanup(this);
    return _origShowModal.apply(this, args);
  };
  HTMLDialogElement.prototype.show = function (...args) {
    _ensureCleanup(this);
    return _origShow.apply(this, args);
  };
})();

// ── Global error / unhandled-rejection handlers ────────────────────────────
// Production runs without DevTools open, so silent async failures (failed
// project saves, narration synth errors, missing-asset retries, etc.) are
// otherwise invisible to the user. Surface them as a status toast AND keep
// the console.error so a developer attaching DevTools can still see the
// stack. event.preventDefault() stops Chromium from showing the default
// "Uncaught (in promise)" banner — we already have a friendlier toast.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const msg    = (reason && (reason.message || reason.toString())) || 'Unhandled error';
  // eslint-disable-next-line no-console
  console.error('[unhandledrejection]', reason);
  try { setStatus(`Error: ${msg.slice(0, 200)}`, 'danger', 4000); } catch {}
  event.preventDefault();
});

window.addEventListener('error', (event) => {
  const msg = event.message || (event.error && event.error.message) || 'Script error';
  // eslint-disable-next-line no-console
  console.error('[error]', event.error || event);
  try { setStatus(`Error: ${msg.slice(0, 200)}`, 'danger', 4000); } catch {}
  // Don't preventDefault — let Chromium also log to its console.
});

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
initUserSettings()
  .then(() => {
    // Apply scene-level user prefs to the live sceneCore as soon as
    // they're known (zoom-step multiplier, default background).
    const cur = getUserSettings();
    const sc  = cur.scene || {};
    if (typeof sc.cameraZoomScale === 'number') {
      sceneCore.setUserZoomScale(sc.cameraZoomScale);
    }
    if (typeof sc.shapeFaceAngleThreshold === 'number') {
      state.setState({ shapeFaceAngleThreshold: sc.shapeFaceAngleThreshold });
    }
    // V0.2.16: undo stack cap is a per-user pref (Undo tab in the sidebar).
    if (cur.undo && Number.isFinite(cur.undo.maxSize)) {
      undoManager.setMaxSize(cur.undo.maxSize);
    }
    // Default background only applies to brand-new projects (when the
    // current viewport still holds the schema default). Projects that
    // load from disk overwrite these via their own backgroundColor /
    // backgroundGradient fields.
    if (!state.get('_projectLoaded')) {
      if (sc.defaultBackgroundColor) {
        state.setState({ backgroundColor: sc.defaultBackgroundColor });
      }
      if (sc.defaultBackgroundGradient) {
        state.setState({ backgroundGradient: { ...sc.defaultBackgroundGradient } });
      }
    }
  })
  .catch(err => console.warn('[settings] init failed:', err));

// File → Settings… menu hook. Channel allowlist lives in preload.js.
window.sbsNative?.onMenu?.('menu:openSettings', () => openSettingsModal());
// Edit → Model source transform… opens a floating, draggable window.
// No takeover, no tab — just a window. Cascade-through-snapshots
// architecture (see ui/model-source-dialog.js + actions.js).
window.sbsNative?.onMenu?.('menu:modelSourceTransform', () => openModelSourceDialog());

// Edit → "Recover stuck inputs" — same effect as Ctrl+Alt+U. Wraps the
// console diagnostic so non-technical users don't need DevTools when
// text fields go unresponsive. Status message confirms the action.
window.sbsNative?.onMenu?.('menu:recoverStuckInputs', () => {
  try {
    window.sbsDiag?.unstuckInputs?.();
    setStatus('Recovered stuck inputs — try typing again.', 'info', 4000);
  } catch (err) {
    console.error('[recover] failed:', err);
  }
});

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
  // While the polygon editor is active the 3D gizmo would just float on
  // top of the in-place 2D handles, confusing the user. Hide it for the
  // duration of the edit session — it'll come back when the editor exits
  // (the editor emits `change:shapeDrawing` on tear-down, see below).
  if (state.get('shapeDrawing')) { gizmo.hide(); return; }
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
  // Hide gizmo for types that don't carry their own transforms: mesh,
  // scene, note, and replaceModel (RM is a container — its children
  // inherit via Three.js parenting; the RM itself never gets a gizmo
  // per the B.2-NEW.2 spec).
  if (!node
      || node.type === 'mesh'
      || node.type === 'scene'
      || node.type === 'note'
      || node.type === 'replaceModel') { gizmo.hide(); return; }
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
state.on('change:shapeDrawing',         _syncGizmoToSelection);

// ══════════════════════════════════════════════════════════════════════════════
//  6. VIEWPORT EVENT HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

const canvas = sceneCore.renderer.domElement;

// V0.1.82's SVG bbox overlay was REMOVED in V0.1.83. AABB-style bbox
// didn't capture the user's "trace outline of the block of models"
// — that needs a true silhouette pass (OutlinePass-equivalent), which
// requires post-processing infrastructure we don't currently have.
// For now, locked-group selection falls back to per-mesh edge outlines
// (each child gets its own EdgesGeometry highlight, same as RM). The
// proper silhouette trace is deferred until we wire OutlinePass.

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
// Shape editor — same crosshair signal during draw mode (pickPlane or addVertices).
state.on('change:shapeDrawing', dr => {
  canvas.style.cursor = dr ? 'crosshair' : '';
});
// Shape edit-pick mode — same crosshair while waiting for instance click.
state.on('change:shapeEditPickInstanceForId', id => {
  canvas.style.cursor = id ? 'crosshair' : '';
});
// Shape placement-pick mode — same crosshair while waiting for click.
state.on('change:shapePlacementForId', id => {
  canvas.style.cursor = id ? 'crosshair' : '';
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

// V0.2.14/15: live cursor glyph during box-select.
//   Mode glyph (left):  ⿻ intersect / clipping  (default)
//                       ⿴ fully enclosed         (Ctrl/⌘ held)
//   Op badge   (right): + green   (Shift held → ADD)
//                       − red     (Alt held   → REMOVE; wins over Shift)
//                       none      (plain → REPLACE)
// Updates LIVE as any modifier is pressed/released mid-drag.
function _marqueeCursor(glyph, op) {
  const main = `<text x="11" y="20" font-size="18" text-anchor="middle"`
    + ` fill="white" stroke="black" stroke-width="0.6"`
    + ` font-family="sans-serif" paint-order="stroke">${glyph}</text>`;
  const opEl = op
    ? `<text x="25" y="13" font-size="14" text-anchor="middle"`
      + ` fill="${op === '+' ? '#4ade80' : '#f87171'}" stroke="black" stroke-width="0.8"`
      + ` font-family="sans-serif" font-weight="bold" paint-order="stroke">${op}</text>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="26">${main}${opEl}</svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") 11 13, crosshair`;
}
let _savedCanvasCursor = '';
let _marqueeKeyHandler = null;

function _setMarqueeCursor(ctrl, shift, alt) {
  if (!canvas) return;
  const glyph = ctrl ? '⿴' : '⿻';
  const op    = alt ? '−' : (shift ? '+' : null);   // Alt wins over Shift (matches box-select)
  canvas.style.cursor = _marqueeCursor(glyph, op);
}
function _beginMarqueeCursor(e) {
  if (!canvas) return;
  _savedCanvasCursor = canvas.style.cursor || '';
  _setMarqueeCursor(!!(e.ctrlKey || e.metaKey), !!e.shiftKey, !!e.altKey);
  // Track Ctrl/⌘/Shift/Alt press + release WHILE dragging so the glyph
  // swaps even without mouse motion.
  _marqueeKeyHandler = (ev) => _setMarqueeCursor(
    !!(ev.ctrlKey || ev.metaKey), !!ev.shiftKey, !!ev.altKey,
  );
  document.addEventListener('keydown', _marqueeKeyHandler, true);
  document.addEventListener('keyup',   _marqueeKeyHandler, true);
}
function _endMarqueeCursor() {
  if (canvas) canvas.style.cursor = _savedCanvasCursor;
  _savedCanvasCursor = '';
  if (_marqueeKeyHandler) {
    document.removeEventListener('keydown', _marqueeKeyHandler, true);
    document.removeEventListener('keyup',   _marqueeKeyHandler, true);
    _marqueeKeyHandler = null;
  }
}
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
 * Pick all visible mesh nodeIds whose geometry projects inside the screen
 * rect [x1,y1,x2,y2] (client coords). V0.1.93 — projection-based, replacing
 * the old 9×9 raycast grid that structurally missed small/thin objects
 * (fell between sample rays) and inverted-normal models (back-faces don't
 * register a raycast hit). No rays here: every visible mesh is projected to
 * the screen and tested against the rect, so orientation is irrelevant and
 * tiny parts can't slip through gaps.
 *
 * Per mesh:
 *   1. Project the 8 world bounding-box corners → screen AABB.
 *      • No overlap with the rect → skip (fast reject).
 *      • Fully inside the rect → select.
 *   2. Partial overlap → either the object's screen footprint is no bigger
 *      than the marquee (a small/thin object the user is dragging over →
 *      include), or a downsampled geometry vertex projects inside the rect.
 *      This catches thin/crossing parts without over-selecting a big mesh
 *      whose bbox merely grazes the marquee.
 *
 * `windowMode` (Ctrl held): select ONLY objects fully enclosed by the box —
 * the projected bbox must lie entirely inside the marquee. Partial/crossing
 * objects are ignored.
 */
function _pickInRect(x1, y1, x2, y2, windowMode = false) {
  const found = new Set();
  const T = window.THREE;
  if (!T || !sceneCore.rootGroup || !sceneCore.camera) return found;

  const cam  = sceneCore.camera;
  const rect = sceneCore.renderer.domElement.getBoundingClientRect();
  cam.updateMatrixWorld();

  const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
  const boxW = maxX - minX, boxH = maxY - minY;

  // World point → screen px, or null if behind the camera (the perspective
  // divide flips sign behind the eye, so guard on view-space z first).
  const _vv = new T.Vector3();
  const project = (wx, wy, wz) => {
    _vv.set(wx, wy, wz).applyMatrix4(cam.matrixWorldInverse);   // view space
    if (_vv.z > -1e-4) return null;                             // at/behind camera
    _vv.applyMatrix4(cam.projectionMatrix);                     // NDC (divide done)
    return {
      x: rect.left + (_vv.x * 0.5 + 0.5) * rect.width,
      y: rect.top  + (-_vv.y * 0.5 + 0.5) * rect.height,
    };
  };
  const inRect = (p) => p && p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;

  const corner = new T.Vector3();
  sceneCore.rootGroup.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    const meshNodeId = obj.userData?.meshNodeId;
    if (!meshNodeId || obj.userData?.noSelect) return;
    // Effective visibility — skip if this object or any ancestor is hidden.
    for (let o = obj; o; o = o.parent) { if (o.visible === false) return; }

    obj.updateWorldMatrix(true, false);
    const geo = obj.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb) return;

    // 8 bbox corners → screen AABB.
    let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
    let anyFront = false, allInside = true;
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? bb.max.x : bb.min.x,
                 i & 2 ? bb.max.y : bb.min.y,
                 i & 4 ? bb.max.z : bb.min.z).applyMatrix4(obj.matrixWorld);
      const p = project(corner.x, corner.y, corner.z);
      if (!p) { allInside = false; continue; }
      anyFront = true;
      if (p.x < sMinX) sMinX = p.x; if (p.x > sMaxX) sMaxX = p.x;
      if (p.y < sMinY) sMinY = p.y; if (p.y > sMaxY) sMaxY = p.y;
      if (!inRect(p)) allInside = false;
    }
    if (!anyFront) return;
    // Fast reject: screen AABB doesn't touch the marquee.
    if (sMaxX < minX || sMinX > maxX || sMaxY < minY || sMinY > maxY) return;
    // Window mode (Ctrl): only objects whose whole bbox is inside the box.
    if (windowMode) { if (allInside) found.add(meshNodeId); return; }
    // Fully inside → definitely selected.
    if (allInside) { found.add(meshNodeId); return; }
    // Small object overlapping the marquee → include (catches thin/crossing
    // parts the user dragged a box over).
    if ((sMaxX - sMinX) <= boxW && (sMaxY - sMinY) <= boxH) { found.add(meshNodeId); return; }
    // Big object grazing the marquee → require a real vertex inside.
    const pos = geo.attributes?.position;
    if (!pos) { found.add(meshNodeId); return; }   // no verts to test → include
    const n = pos.count;
    const step = Math.max(1, Math.floor(n / 300));  // ≤ ~300 samples
    for (let vi = 0; vi < n; vi += step) {
      corner.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(obj.matrixWorld);
      if (inRect(project(corner.x, corner.y, corner.z))) { found.add(meshNodeId); return; }
    }
  });
  return found;
}

// ── Pointer down on canvas: start potential drag-select ──────────────────────

canvas.addEventListener('pointerdown', e => {
  // In-editor "Add polygon from face" picker — checked BEFORE the shape
  // editor's general click intercept because the editor is in 'edit'
  // phase while the picker is armed, and would otherwise eat the click.
  if (state.get('addPolygonFromFacePicking') && e.button === 0) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
    actions.addPolygonFromFaceAtClick(e.clientX, e.clientY);
    return;
  }
  if (state.get('addPolygonFromFacePicking') && e.button === 2) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
    actions.cancelAddPolygonFromFacePick();
    return;
  }

  // Shape editor — Phase 1 of "2D shapes in 3D". When active, the editor
  // owns viewport clicks: left = pick plane / add vertex / close, right
  // = commit. Other modes (gizmo, picking, etc.) are bypassed entirely.
  if (shapeEditor.isDrawing() && (e.button === 0 || e.button === 2)) {
    // Right-click in edit mode shouldn't be consumed by the editor's
    // pointerdown — let the contextmenu handler take over to show the
    // edit-mode menu (Add point / New shape / Exit).
    const phase = state.get('shapeDrawing')?.phase;
    if (e.button === 2 && phase === 'edit') return;
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
    shapeEditor.onPointerDown(e.clientX, e.clientY, e.button);
    return;
  }

  // Place-shape picker — the next left click drops one instance
  // tangent to the hit face (or camera-facing on empty space) and
  // disarms. Right-click / Esc cancels (handled in the keydown +
  // contextmenu blocks).
  const placeTplId = state.get('shapePlacementForId');
  if (placeTplId && e.button === 0) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
    actions.placeShapeAtClick(placeTplId, e.clientX, e.clientY);
    return;
  }
  if (placeTplId && e.button === 2) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
    actions.cancelShapePlacement();
    return;
  }

  // Create-shape-from-face picker — left click slices the clicked face's
  // connected component with the face's plane and lands the cross-section
  // as a new shape. Right-click / Esc cancels.
  if (state.get('shapeFromFacePicking') && e.button === 0) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
    actions.createShapeFromFaceAtClick(e.clientX, e.clientY);
    return;
  }
  if (state.get('shapeFromFacePicking') && e.button === 2) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
    actions.cancelCreateShapeFromFace();
    return;
  }

  // Edit-shape multi-instance pick mode — the next left-click picks
  // which flatShape instance to edit. Clicks elsewhere cancel.
  const editPickTplId = state.get('shapeEditPickInstanceForId');
  if (editPickTplId && e.button === 0) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
    const hit = sceneCore.pick(e.clientX, e.clientY);
    const meshNodeId = hit?.object?.userData?.flatShapeNodeId
                    ?? hit?.object?.userData?.meshNodeId;
    if (meshNodeId) {
      actions.pickInstanceForEdit(meshNodeId);
    } else {
      actions.cancelShapeEditPick();
    }
    return;
  }

  if (e.button !== 0) return;

  // Note picking — clicks while in this mode raycast the scene; on a
  // hit landing on the same mesh, a balloon note is created at the hit
  // point. On any other hit (or no hit), pick mode is cancelled. Runs
  // before the gizmo so face hits are honoured even under handles.
  const notePickMeshId = state.get('notePickingMeshId');
  if (notePickMeshId) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
    const hit = sceneCore.pick(e.clientX, e.clientY);
    if (hit?.object?.userData?.meshNodeId === notePickMeshId) {
      actions.createNoteAtHit(notePickMeshId, hit);
    } else {
      actions.cancelNotePicking();
    }
    return;
  }

  // Note REPOSITION — clicks raycast for ANY mesh (different from
  // create, which restricts to the same mesh). On a hit, the note's
  // anchor moves to the new face and the note re-parents in the tree.
  // Click on empty space cancels.
  const noteReposId = state.get('noteRepositioningId');
  if (noteReposId) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
    const hit = sceneCore.pick(e.clientX, e.clientY);
    if (hit?.object?.userData?.meshNodeId) {
      actions.repositionNoteAtHit(noteReposId, hit);
    } else {
      actions.cancelNoteRepositioning();
    }
    return;
  }

  // Template INSTANTIATION — click any mesh face to drop a fresh note
  // instance there, linked to the active template. Click on empty space
  // cancels. Mirrors note REPOSITION but creates a new note instead of
  // moving an existing one.
  const tplInstId = state.get('noteTemplateInstantiationId');
  if (tplInstId) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
    const hit = sceneCore.pick(e.clientX, e.clientY);
    if (hit?.object?.userData?.meshNodeId) {
      actions.placeNoteTemplateAtHit(tplInstId, hit);
    } else {
      actions.cancelNoteTemplateInstantiation();
    }
    return;
  }

  // 3-point center pivot: clicks while in this mode are routed to the
  // picker (snap to vertex/edge, place a cross, remove cross, or commit).
  // Runs BEFORE the gizmo so picks land regardless of handle overlap.
  // _gizmoConsumed suppresses the follow-up click event from re-selecting.
  if (state.get('pivotCenterPickingNodeId')) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
    pivotCenterPicker.onPointerDown(e.clientX, e.clientY);
    return;
  }

  // V0.2.22.32 — 1-point folder align tool consumes the click. Source
  // phase captures a face on a folder descendant; target phase captures a
  // face elsewhere and immediately previews the alignment (Enter/Esc to
  // commit/revert). In preview phase the picker returns false so the
  // click falls through to nothing (no mesh re-select).
  if (state.get('alignFolderId')) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
    folderAlignPicker.onPointerDown(e.clientX, e.clientY);
    return;
  }

  // V0.2.22.33 — 3-point concentric folder align consumes the click.
  // Source phase: snap-pick 3 pts on a folder-descendant circular face.
  // Target phase: snap-pick 3 pts on a circular feature elsewhere. The
  // picker auto-advances at 3 picks per side; Backspace removes the
  // last pick, Enter commits, Esc reverts.
  if (state.get('align3FolderId')) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
    folderAlign3ptPicker.onPointerDown(e.clientX, e.clientY);
    return;
  }

  // P-P1+: snap-to-surface pick mode consumes the click — raycast
  // against the scene, snap pivot if there's a hit, otherwise cancel.
  // Runs BEFORE the gizmo so the user can target a face that happens
  // to be behind / under a gizmo handle.
  // _gizmoConsumed flag is reused (the click handler at line 758 reads
  // it to skip mesh selection) so snap-pick clicks DON'T re-select the
  // object — without it the user's pivot would land, then the click
  // event would fire after pointerup and re-select the mesh, hiding
  // the gizmo+pivot the snap had just placed.
  const snapPickNodeId = state.get('pivotSnapPickingNodeId');
  if (snapPickNodeId) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
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
  // Same pattern for translate-global mode (Phase 2).
  if (state.get('globalEditNodeId')) {
    actions.commitGlobalEdit();
  }

  _dragStartX   = e.clientX;
  _dragStartY   = e.clientY;
  _isDragging   = false;
  _dragOnCanvas = true;   // drag started on the 3-D viewport
}, { capture: false });

// ── Pointer move: gizmo drag or grow marquee ─────────────────────────────────

canvas.addEventListener('pointermove', e => {
  // Shape editor — keep the rubber-band line + snap-close hover live as
  // the cursor moves, with or without a button held.
  if (shapeEditor.isDrawing()) {
    shapeEditor.onPointerMove(e.clientX, e.clientY);
    return;
  }

  if (!(e.buttons & 1)) {
    // 3-point pivot center mode — refresh the snap hover marker.
    // V0.2.22.23 — rAF-coalesce. sceneCore.pick is the bottleneck (~75ms
    // on CAD scenes per pointer event, confirmed by snapPerf diagnostic).
    // Pointer-move fires faster than pick can complete, so events queue
    // up and the snap marker lags noticeably behind the cursor.
    // Coalesce: record the LATEST pos every event, only fire one pick
    // per animation frame. The pick itself is still 75ms but the queue
    // never grows past one pending position.
    if (state.get('pivotCenterPickingNodeId')) {
      _schedulePivotHover(e.clientX, e.clientY);
      return;
    }

    // V0.2.22.32 — folder-align hover. Refreshes the cross+arrow marker
    // on whichever surface matches the current phase. pickAll is O(scene)
    // like pivot's, but this tool is used briefly (two clicks) so we don't
    // bother rAF-coalescing yet — revisit if it lags on huge scenes.
    if (state.get('alignFolderId')) {
      folderAlignPicker.updateHover(e.clientX, e.clientY);
      return;
    }

    // V0.2.22.33 — 3-point align hover. Snap-picker uses findSnapTarget
    // (same as 3-pt pivot tool) which is already rAF-throttled internally
    // for its own caller; we call it directly here because the cross
    // marker reflects vertex/edge/face snap mid-aim and the user expects
    // tight follow.
    if (state.get('align3FolderId')) {
      folderAlign3ptPicker.updateHover(e.clientX, e.clientY);
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

// V0.2.22.32 — folder align: prompt for each phase. The picker drives
// the phase transitions via state.alignFolderPhase; we echo the active
// phase in the status bar so the user knows what's expected next.
state.on('change:alignFolderPhase', phase => {
  if (phase === 'source') {
    setStatus('Align folder: click a face INSIDE the folder (source). Esc to cancel.', 'info', 0);
  } else if (phase === 'target') {
    setStatus('Align folder: click the target surface (anywhere else). Esc to cancel.', 'info', 0);
  } else if (phase === 'preview') {
    setStatus('Align folder: Enter to commit, Esc to revert.', 'info', 0);
  }
});

// V0.2.22.33 — 3-point concentric align: same per-phase status pattern,
// plus a Backspace hint while points are being collected.
state.on('change:align3FolderPhase', phase => {
  if (phase === 'source') {
    setStatus('Align by 3 pts: pick 3 snap points on a circle INSIDE the folder. Backspace undo, Esc cancel.', 'info', 0);
  } else if (phase === 'target') {
    setStatus('Align by 3 pts: pick 3 snap points on the TARGET circle. Backspace undo, Esc cancel.', 'info', 0);
  } else if (phase === 'preview') {
    setStatus('Align by 3 pts: Enter to commit, Esc to revert.', 'info', 0);
  }
});

// Status feedback while waiting for the user to click a face for a new note.
state.on('change:notePickingMeshId', id => {
  if (!id) return;
  setStatus('Click a face on the mesh to anchor the note. Esc to cancel.', 'info', 0);
});

// Status feedback while waiting for the user to click a face to relocate
// an existing note's anchor.
state.on('change:noteRepositioningId', id => {
  if (!id) return;
  setStatus('Click a face on any mesh to move the note there. Esc to cancel.', 'info', 0);
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
    _beginMarqueeCursor(e);
  }
  if (_isDragging) {
    _showMarquee(_dragStartX, _dragStartY, e.clientX, e.clientY);
    _setMarqueeCursor(!!(e.ctrlKey || e.metaKey), !!e.shiftKey, !!e.altKey);
  }
}, { passive: true });

// ── Pointer up: finalise gizmo or selection ───────────────────────────────────

window.addEventListener('pointerup', e => {
  // Shape editor: end an in-progress vertex drag (edit mode). Bail before
  // any selection-clearing logic so a click-drag-release on a vertex
  // doesn't deselect.
  if (shapeEditor.isDrawing()) {
    shapeEditor.onPointerUp();
    if (state.get('shapeDrawing')?.phase === 'edit') return;
  }

  if (gizmo.isDragging) {
    gizmo.onPointerUp();
    return;
  }

  _dragOnCanvas = false;     // reset regardless

  if (!_isDragging) return;
  _hideMarquee();
  _isDragging  = false;
  _endMarqueeCursor();
  _justDragged = true;   // suppress the click event that fires next

  // V0.1.94 box-select modifiers:
  //   Ctrl (or ⌘) → "window" mode: only objects FULLY enclosed by the box.
  //                 Without it: "clipping" mode = anything the box touches.
  //   Shift       → ADD the boxed objects to the current selection.
  //   Alt         → REMOVE the boxed objects from the current selection.
  //   (neither)   → REPLACE the selection with the boxed objects.
  const windowMode = e.ctrlKey || e.metaKey;
  const doAdd      = e.shiftKey;
  const doRemove   = e.altKey;
  const found = _pickInRect(_dragStartX, _dragStartY, e.clientX, e.clientY, windowMode);

  const current = new Set(state.get('multiSelectedIds') || []);
  let multi;
  if (doRemove) {
    multi = current;
    for (const id of found) multi.delete(id);
  } else if (doAdd) {
    multi = current;
    for (const id of found) multi.add(id);
  } else {
    multi = found;   // replace
  }

  if (multi.size === 0) { actionClearSelection(); return; }
  // Keep the existing primary if it survived; else pick any member.
  const prevPrimary = state.get('selectedId');
  const primary = multi.has(prevPrimary) ? prevPrimary : [...multi][0];
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

  // ── Replace-Model viewport picker (B.2-NEW.2) ────────────────────────
  // When the user clicked "🎯 Pick from viewport…" in the add-to-replace
  // dialog, state.replaceModelPickingForId holds the RM id waiting for a
  // source. The next viewport click resolves to that mesh/flatShape and
  // re-opens the mode dialog. Esc cancels (handled at keydown).
  const rmPickFor = state.get('replaceModelPickingForId');
  if (rmPickFor) {
    const hit = sceneCore.pick(e.clientX, e.clientY);
    const hitMeshId = hit?.object?.userData?.meshNodeId;
    if (!hitMeshId) {
      setStatus('No object under cursor — try again or press Esc to cancel.', 'warning');
      return;
    }
    const nbm = state.get('nodeById');
    const hitNode = nbm?.get(hitMeshId);
    // Reject: archived, the RM itself, descendant of RM, RM children, wrong type.
    const isInRM = !!hit.object.userData?.replaceModelId;
    if (!hitNode ||
        hitNode.archived ||
        hitMeshId === rmPickFor ||
        isInRM ||
        (hitNode.type !== 'mesh' && hitNode.type !== 'flatShape')) {
      setStatus('Not a valid replacement source. Pick a mesh or flat-shape outside the RM. (Esc to cancel.)', 'warning');
      return;
    }
    state.setState({ replaceModelPickingForId: null });
    showReplaceModeDialog(rmPickFor, hitMeshId, hitNode.name || 'object');
    return;
  }

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

  // V0.1.89/96 ray-select: while the candidate list is open, a plain L-click
  // on geometry advances the highlight to the next overlapping entity; an
  // L-click on blank background CANCELS (same as Esc). R-click confirms
  // (contextmenu handler); Esc cancels (keydown). Middle-drag still orbits.
  if (_raySelect && e.button === 0) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
    const hit = sceneCore.pick(e.clientX, e.clientY);
    if (hit && hit.object?.userData?.meshNodeId) _raySelectCycle(1);
    else _raySelectCancel();
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

  // ── Selection promotion (B.2-NEW.2 RM + V0.1.92 locked folders) ──────
  // Two promotion paths, in priority order:
  //   1. RM: hit's userData.replaceModelId → the RM that owns it.
  //   2. Locked folder: hit lives inside a folder with locked=true →
  //      that folder is the selection target (treat as one unit).
  // Both paths include all descendants in the click-set so per-mesh
  // edge outlines render across each child.
  const promotedRmId       = hit.object.userData?.replaceModelId;
  const promotedRmNode     = promotedRmId ? nbm.get(promotedRmId) : null;
  const lockedGroupNode    = !promotedRmNode
    ? actions.findLockedFolderAncestor?.(root, meshNodeId)
    : null;
  const promotedContainer  = promotedRmNode || lockedGroupNode || null;

  // V0.1.85: locked shape-tab group — flatShape instances whose template
  // belongs to a locked shape group expand the click to every instance of
  // every member template. Runs only when no tree-side promotion fired
  // (RM / locked tree-group take priority). Result is a flat node-id set
  // (no container hierarchy), so the selection target is the clicked mesh
  // and the set carries the siblings.
  const shapeGroupSet = !promotedContainer
    ? actions.selectionPromoteForLockedShapeGroup?.(meshNodeId)
    : null;
  const target = promotedContainer ? promotedContainer.id : meshNodeId;

  // Build the "selection-set" for the click.
  // V0.2.22.21.1 — semantics diverge by promotion type:
  //   RM: still include every descendant (B.2-NEW.2 contract — selection
  //       IS the whole RM unit's children).
  //   Locked folder: JUST the folder id. Per V0.2.22.21 the silhouette
  //       outline pass automatically wraps the folder's descendant mesh
  //       mass on its own. Inflating multi with descendants used to be
  //       needed for V0.2.18's per-mesh outlineOnly hulls; the new
  //       silhouette replaces that visual, so the multi can stay clean.
  //       Matches tree single-click on a folder.
  const buildContainerSet = (containerId) => {
    const out = new Set([containerId]);
    const containerNode = nbm.get(containerId);
    if (containerNode?.children) {
      (function walk(n) {
        for (const c of (n.children || [])) { out.add(c.id); walk(c); }
      })(containerNode);
    }
    return out;
  };

  const clickSet = promotedContainer
    ? (lockedGroupNode === promotedContainer
        ? new Set([target])                  // locked folder: clean unit
        : buildContainerSet(target))         // RM: full descendant set
    : (shapeGroupSet && shapeGroupSet.size > 0 ? shapeGroupSet : new Set([target]));

  // V0.2.7: four distinct click modes (each with the matching ray-select
  // menu when 2+ entities are under the cursor):
  //   (no mod) REPLACE — all entities are candidates, no tags.
  //   Shift    ADD     — only NOT-selected entities, "ADD" tags.
  //   Alt      REMOVE  — only currently-SELECTED entities, "REMOVE" tags.
  //   Ctrl/⌘   TOGGLE  — ALL entities; each row tagged ADD or REMOVE
  //                       depending on its current selection state.
  const mode = e.altKey  ? 'remove'
             : (e.ctrlKey || e.metaKey) ? 'toggle'
             : e.shiftKey ? 'add'
             : 'replace';
  const allEntities = actions.resolveRaySelectEntities(e.clientX, e.clientY);
  const multi = new Set(state.get('multiSelectedIds') || []);

  // Helper: toggle an entity's selection state (add if absent, remove if
  // present) — shared by 'toggle' single-entity path and confirm.
  const _commitToggle = (ent) => {
    const present = multi.has(ent.targetId);
    for (const id of ent.meshIds) { if (present) multi.delete(id); else multi.add(id); }
    if (multi.size === 0) { actionClearSelection(); return; }
    const prevPrim = state.get('selectedId');
    actionSetSelection(multi.has(prevPrim) ? prevPrim : [...multi][0], multi);
  };

  if (mode === 'replace') {
    if (allEntities.length >= 2) {
      _openRaySelect(allEntities, e.clientX, e.clientY, 'replace');
    } else {
      actionSetSelection(target, clickSet);
    }
  } else if (mode === 'add') {
    const cands = allEntities.filter(ent => !multi.has(ent.targetId));
    if (cands.length === 0) {
      setStatus('Nothing to add — everything under the cursor is already selected.');
    } else if (cands.length === 1) {
      const ent = cands[0];
      for (const id of ent.meshIds) multi.add(id);
      actionSetSelection(ent.targetId, multi);
    } else {
      _openRaySelect(cands, e.clientX, e.clientY, 'add');
    }
  } else if (mode === 'remove') {
    const cands = allEntities.filter(ent => multi.has(ent.targetId));
    if (cands.length === 0) {
      setStatus('Nothing to remove — nothing selected under the cursor.');
    } else if (cands.length === 1) {
      const ent = cands[0];
      for (const id of ent.meshIds) multi.delete(id);
      multi.delete(ent.targetId);
      if (multi.size === 0) { actionClearSelection(); }
      else {
        const prevPrimary = state.get('selectedId');
        actionSetSelection(multi.has(prevPrimary) ? prevPrimary : [...multi][0], multi);
      }
    } else {
      _openRaySelect(cands, e.clientX, e.clientY, 'remove');
    }
  } else { // toggle
    if (allEntities.length === 0) return;
    if (allEntities.length === 1) _commitToggle(allEntities[0]);
    else _openRaySelect(allEntities, e.clientX, e.clientY, 'toggle');
  }
});

// ── Double-click: select all children of container ───────────────────────────

canvas.addEventListener('dblclick', e => {
  // Shape editor: in 'edit' mode a double-click on a vertex selects the
  // entire polygon — Delete / Backspace then removes the whole polygon
  // instead of one vertex. Lets the editor consume the event before the
  // generic mesh-container double-click logic runs.
  if (shapeEditor.isDrawing()
      && state.get('shapeDrawing')?.phase === 'edit'
      && shapeEditor.onDoubleClick(e.clientX, e.clientY)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }

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

// ══════════════════════════════════════════════════════════════════════════
//  RAY-SELECT — disambiguate overlapping picks (V0.1.89)
// ══════════════════════════════════════════════════════════════════════════
//
// Auto-opens a cursor-anchored cycle list when a plain click pierces 2+
// distinct entities (actions.resolveRaySelectEntities). The active candidate
// is previewed in a HUE-SHIFTED variant of the selection color. L-click
// (viewport) cycles, hovering a list row previews it, R-click or a row
// mousedown confirms, Esc cancels.
let _raySelect = null;   // { entities, index, el, color }

// Shift the hue of a #rrggbb hex by `deg` degrees (HSL space). Used to make
// the candidate-preview color clearly distinct from the cyan selection while
// staying related to the user's chosen palette.
function _hueShiftHex(hex, deg) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#ffd23f';
  const n = parseInt(m[1], 16);
  let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = 0; s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0)
      : max === g ? (b - r) / d + 2
      :             (r - g) / d + 4;
    h /= 6;
  }
  h = (h + deg / 360) % 1; if (h < 0) h += 1;
  if (s < 0.25) s = 0.6;   // bump so near-grays still read as a distinct hue
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let R, G, B;
  if (s === 0) { R = G = B = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    R = hue2rgb(p, q, h + 1 / 3); G = hue2rgb(p, q, h); B = hue2rgb(p, q, h - 1 / 3);
  }
  const hx = v => ('0' + Math.round(v * 255).toString(16)).slice(-2);
  return '#' + hx(R) + hx(G) + hx(B);
}

function _openRaySelect(entities, x, y, mode = 'replace') {
  _closeRaySelectUI();
  const color = _hueShiftHex(state.get('selectionOutlineColor') ?? '#00ffff', 45);
  _raySelect = { entities, index: 0, el: null, color, mode };
  _buildRaySelectList(x, y);
  _raySelectPreview();
  const verb = mode === 'add'    ? 'add'
             : mode === 'remove' ? 'remove'
             : mode === 'toggle' ? 'toggle'
             :                     'confirm';
  setStatus(`${entities.length} objects under cursor — L-click to cycle, R-click to ${verb}, Esc to cancel.`);
}

function _raySelectPreview() {
  if (!_raySelect) return;
  const ent = _raySelect.entities[_raySelect.index];
  // Separate preview channel — the existing selection stays highlighted
  // (cyan) underneath; the candidate shows in the hue-shifted color on top.
  materials.applyPreviewHighlight(new Set(ent.meshIds), _raySelect.color);
  // V0.2.22.21.4 — also drive the silhouette outline-pass preview channel
  // so locked-folder entities (whose meshIds is just the folder id, not
  // descendants) still show a visible silhouette during the cycle. For
  // non-locked entities this duplicates the per-mesh hull preview with a
  // silhouette outline — harmless and visually consistent with selection
  // (which is also silhouette + per-mesh hull).
  setOutlinePreview(ent.targetId, _raySelect.color);
  if (_raySelect.el) {
    _raySelect.el.querySelectorAll('[data-ray-idx]').forEach(row => {
      const on = Number(row.dataset.rayIdx) === _raySelect.index;
      row.style.background = on ? 'rgba(255,210,63,0.18)' : 'transparent';
      row.style.fontWeight = on ? '600' : '400';
    });
  }
}

function _raySelectCycle(delta) {
  if (!_raySelect) return;
  const n = _raySelect.entities.length;
  _raySelect.index = (((_raySelect.index + delta) % n) + n) % n;
  _raySelectPreview();
}

function _raySelectConfirm() {
  if (!_raySelect) return;
  const ent  = _raySelect.entities[_raySelect.index];
  const mode = _raySelect.mode;
  _closeRaySelectUI();
  _raySelect = null;
  materials.clearPreviewHighlight();
  clearOutlinePreview();   // V0.2.22.21.4
  // Setting the real selection fires selection:change → the highlight
  // repaints in the normal selection color (clearing the preview hue).
  if (mode === 'add' || mode === 'toggle') {
    // Shift (add) → candidate set was pre-filtered to non-selected, so the
    // present check always falls into the "add" branch. Ctrl (toggle) →
    // unfiltered candidates; the present check toggles per-item.
    const multi    = new Set(state.get('multiSelectedIds') || []);
    const present  = multi.has(ent.targetId);
    for (const id of ent.meshIds) { if (present) multi.delete(id); else multi.add(id); }
    if (multi.size === 0) actionClearSelection();
    else {
      const prevPrim = state.get('selectedId');
      actionSetSelection(multi.has(prevPrim) ? prevPrim : [...multi][0], multi);
    }
    setStatus(`${present ? 'Removed' : 'Added'} "${ent.name}".`);
  } else if (mode === 'remove') {
    // Alt: drop the chosen entity from the selection.
    const multi = new Set(state.get('multiSelectedIds') || []);
    for (const id of ent.meshIds) multi.delete(id);
    multi.delete(ent.targetId);
    if (multi.size === 0) { actionClearSelection(); }
    else {
      const prevPrimary = state.get('selectedId');
      actionSetSelection(multi.has(prevPrimary) ? prevPrimary : [...multi][0], multi);
    }
    setStatus(`Removed "${ent.name}".`);
  } else {
    actionSetSelection(ent.targetId, new Set(ent.meshIds));
    setStatus(`Selected "${ent.name}".`);
  }
}

function _raySelectCancel() {
  if (!_raySelect) return;
  _closeRaySelectUI();
  _raySelect = null;
  // Selection highlight was never disturbed — just drop the preview channels.
  materials.clearPreviewHighlight();
  clearOutlinePreview();   // V0.2.22.21.4
  setStatus('Selection cancelled.');
}

function _closeRaySelectUI() {
  if (_raySelect?.el) { _raySelect.el.remove(); _raySelect.el = null; }
}

function _buildRaySelectList(x, y) {
  const el = document.createElement('div');
  el.className = 'ray-select-list';
  el.style.cssText = `position:fixed;left:${x + 14}px;top:${y + 14}px;z-index:10000;`
    + `background:var(--panel,#1e293b);border:1px solid var(--line,#334155);border-radius:6px;`
    + `box-shadow:0 6px 24px rgba(0,0,0,0.5);padding:4px;min-width:160px;max-height:50vh;`
    + `overflow:auto;font-size:12px;user-select:none;color:var(--text,#cbd5e1);`;
  const header = document.createElement('div');
  header.textContent = `Pick (${_raySelect.entities.length})`;
  header.style.cssText = 'padding:4px 8px;opacity:0.55;font-size:11px;';
  el.appendChild(header);
  // V0.2.6/V0.2.7: per-row "ADD" or "REMOVE" tag showing what confirming
  // would do. Uniform in pure add (Shift) / remove (Alt) modes; per-entity
  // in TOGGLE mode (Ctrl/⌘), where each candidate is tagged ADD if not in
  // selection, REMOVE if it is. No tag in plain REPLACE mode.
  const sceneMulti = new Set(state.get('multiSelectedIds') || []);
  const tagFor = (ent) => {
    if (_raySelect.mode === 'add')    return { word: 'add',    color: '#4ade80' };
    if (_raySelect.mode === 'remove') return { word: 'remove', color: '#f87171' };
    if (_raySelect.mode === 'toggle') {
      return sceneMulti.has(ent.targetId)
        ? { word: 'remove', color: '#f87171' }
        : { word: 'add',    color: '#4ade80' };
    }
    return null;
  };
  _raySelect.entities.forEach((ent, i) => {
    const row = document.createElement('div');
    row.dataset.rayIdx = String(i);
    row.style.cssText  = 'padding:5px 10px;border-radius:4px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:6px';
    const tag = tagFor(ent);
    if (tag) {
      const tagEl = document.createElement('span');
      tagEl.textContent = tag.word;
      tagEl.style.cssText = `color:${tag.color};font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.4px;flex-shrink:0;min-width:42px`;
      row.appendChild(tagEl);
    }
    const nameSpan = document.createElement('span');
    nameSpan.textContent = ent.name;
    nameSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    row.appendChild(nameSpan);
    row.addEventListener('mouseenter', () => { if (_raySelect) { _raySelect.index = i; _raySelectPreview(); } });
    row.addEventListener('mousedown', ev => { ev.preventDefault(); ev.stopPropagation(); if (_raySelect) { _raySelect.index = i; _raySelectConfirm(); } });
    el.appendChild(row);
  });
  document.body.appendChild(el);
  _raySelect.el = el;
  // Clamp on-screen.
  const r = el.getBoundingClientRect();
  if (r.right  > window.innerWidth)  el.style.left = Math.max(8, x - r.width  - 14) + 'px';
  if (r.bottom > window.innerHeight) el.style.top  = Math.max(8, window.innerHeight - r.height - 8) + 'px';
}

// ── Context menu on viewport ──────────────────────────────────────────────────

canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  hideContextMenu();

  // V0.1.89 ray-select: R-click solidifies the currently-highlighted
  // candidate and suppresses the normal context menu.
  if (_raySelect) {
    e.stopPropagation();
    _raySelectConfirm();
    return;
  }

  // Shape editor right-click semantics depend on phase:
  //   - addVertices: pointerdown(button=2) committed the polygon → just
  //     suppress the menu (no further handling).
  //   - edit:        show a small menu — "Add point" if the click was on
  //     an edge segment, "New shape" if it landed on the empty grid.
  //     Esc / outside-click closes the menu without doing anything.
  if (shapeEditor.isDrawing()) {
    const phase = state.get('shapeDrawing')?.phase;
    if (phase !== 'edit') return;
    // R-click ON the polygon gizmo → floating transform panel
    // (Move X/Y, Rotate, Scale). Wins over the edge / empty menu.
    if (shapeEditor.pickPolyGizmoForMenu(e.clientX, e.clientY)) {
      _showPolyTransformPanel(e.clientX, e.clientY);
      return;
    }
    const edgeHit = shapeEditor.pickEdgeForMenu(e.clientX, e.clientY);
    const items = [];
    if (edgeHit) {
      items.push({
        label: '＋ Add point here',
        action: () => shapeEditor.addPointOnEdge(e.clientX, e.clientY),
      });
      // Right-click on an edge identifies which polygon it belongs to —
      // offer a one-click "Delete polygon" path for the user who wants
      // to remove a whole shape without first selecting all its vertices.
      items.push({
        label: '🗑 Delete this shape',
        action: () => shapeEditor.deleteSelectedPolygon(edgeHit.polyIdx),
      });
    } else {
      // Empty grid right-click — append a NEW polygon to this template.
      // Each additional polygon is XOR-ed with the existing geometry, so
      // overlapping rectangles produce a "+" with a clear centre, donuts,
      // etc. Snap-close the new polygon to commit it back to edit mode.
      items.push({
        label: '⊕ Add shape (XOR with existing)',
        action: () => shapeEditor.newShape(),
      });
      items.push({
        label: '⊕ Add shape from face',
        action: () => actions.startAddPolygonFromFacePick(),
      });
    }
    items.push({ label: '─', disabled: true });
    items.push({ label: '✖ Exit edit  [Esc]', action: () => actions.cancelShapeDraw() });
    showContextMenu(items, e.clientX, e.clientY);
    return;
  }

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
        label: '🗑 Clear all points',
        disabled: !havePts,
        action: () => pivotCenterPicker.clearAll(),
      },
      { label: '─', disabled: true },
      {
        label: '✖ Cancel  [Esc]',
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
            label: '🗑 Remove socket',
            action: () => actions.removeCableSocket(cableHit.cableId, cableHit.nodeId),
          }
        : {
            label: '＋ Add socket',
            action: () => actions.addCableSocket(cableHit.cableId, cableHit.nodeId),
          },
      {
        label: '🌿 Branch from here…',
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
        label: '🗑 Delete this point',
        action: () => actions.deleteCablePoint(cableHit.cableId, cableHit.nodeId),
      },
      { label: '─', disabled: true },
      {
        label: '✖ Deselect  [Esc]',
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
        label: '🗑 Remove socket',
        action: () => actions.removeCableSocket(socketHit.cableId, socketHit.nodeId),
      },
      { label: '─', disabled: true },
      {
        label: '✖ Deselect  [Esc]',
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

  // ── Archived-selection short-circuit ─────────────────────────────────
  // If every selected node is archived, the viewport menu collapses to
  // a single Unarchive item — same contract as the tree r-click menu.
  // Every other action is a no-op on archived nodes anyway; showing
  // the full menu would advertise commands that silently do nothing.
  if (hasSel && [...multiIds].every(id => nodeById?.get(id)?.archived === true)) {
    const ids = [...multiIds];
    items.push({
      label: ids.length > 1 ? `📤 Unarchive ${ids.length} items` : '📤 Unarchive',
      action: () => actions.unarchiveNodes(ids),
    });
    showContextMenu(items, e.clientX, e.clientY);
    return;
  }

  if (canAddNoteHere) {
    items.push({
      label: '💬 Add Note here',
      action: () => actions.createNoteAtHit(noteMeshId, noteHit),
    });
    items.push({ label: '─', disabled: true });
  }

  // ── Per-note Show / Hide list for the right-clicked mesh ────────────────
  // ONLY notes that are direct children of THIS mesh — i.e. positioned
  // on it. Notes on other meshes inside the same model don't appear
  // here. Right-click a mesh with no notes → section absent entirely.
  if (noteMeshId && nodeById) {
    const meshNode = nodeById.get(noteMeshId);
    const directNotes = (meshNode?.children || []).filter(c => c?.type === 'note');
    if (directNotes.length) {
      items.push({
        label: `🗒 Notes on "${(meshNode.name || 'mesh').slice(0, 24)}" (${directNotes.length})`,
        disabled: true,
      });
      // Resolve template-linked notes' display name from the template's
      // user-facing name, not the empty instance text.
      const tplList = state.get('noteTemplates') || [];
      for (const nt of directNotes) {
        const visEff = (nodeById.get(nt.id)?.localVisible !== false);
        let short;
        if (nt.templateId) {
          const tpl = tplList.find(t => t.id === nt.templateId);
          short = tpl?.name || '(linked template)';
        } else {
          const txt = (nt.text || '').replace(/\s+/g, ' ').trim();
          short = txt ? (txt.length > 30 ? txt.slice(0, 30) + '…' : txt) : '(empty note)';
        }
        items.push({
          label:  `   ${visEff ? '👁' : '🚫'}  ${short}`,
          action: () => actions.toggleVisibility([nt.id]),
        });
      }
      items.push({ label: '─', disabled: true });
    }
  }

  // Flat-shape entries (Phase 2 / 2.1 / 2.3) — shown ABOVE the generic
  // transform actions so they're easy to find. Mirrors the equivalent
  // tree-row right-click menu so users get the same options whether
  // they right-click in the viewport or in the tree.
  if (node?.type === 'flatShape') {
    const inGlobal = state.get('globalEditNodeId') === node.id;
    items.push({
      label: '✏ Edit shape…',
      action: () => actions.startShapeEdit(node.templateId),
    });
    items.push({
      label: inGlobal ? '✓ Global Transform (active)' : '🌐 Global Transform',
      action: () => inGlobal
        ? actions.commitGlobalEdit()
        : actions.enterGlobalEdit(node.id),
    });
    items.push({
      label: '📋 Copy step pose',
      action: () => actions.copyInstanceStepPose(node.id),
    });
    const stepSel = state.get('selectedStepIds');
    items.push({
      label: stepSel instanceof Set && stepSel.size >= 2
        ? `📥 Paste step pose to ${stepSel.size} steps`
        : '📥 Paste step pose',
      disabled: !actions.hasInstancePoseClipboard(),
      action: () => actions.pasteInstanceStepPose(node.id),
    });
    items.push({
      label: '🗑 Delete shape',
      action: () => actions.deleteFlatShapeInstance(node.id),
    });
    items.push({ label: '─', disabled: true });
  }

  // V0.2.22.44 — hardware instance(s) in the viewport. Same menu shape
  // as the tree's right-click. Multi-aware on delete: if several
  // screws are selected and the right-clicked one is among them,
  // delete acts on the whole selection.
  const multiSet = (multiIds instanceof Set) ? multiIds : new Set();
  const allMultiHw = multiSet.size > 1
    && [...multiSet].every(id => nodeById?.get(id)?.type === 'hardwareInstance');
  if (node?.type === 'hardwareInstance') {
    items.push({
      label: '🔩 Duplicate (same template)',
      action: () => {
        import('./systems/hardware-actions.js').then(hw =>
          hw.duplicateInstance(node.id));
      },
    });
    items.push({
      label: '🔩 Edit template (affects all instances)…',
      action: () => {
        import('./ui/sidebar-left.js').then(sb =>
          sb.editHardwareTemplate(node.templateId));
      },
    });
    const delLabel = allMultiHw
      ? `🗑 Delete ${multiSet.size} screws`
      : '🗑 Delete screw';
    const delIds = allMultiHw ? [...multiSet] : [node.id];
    items.push({
      label: delLabel,
      action: () => {
        import('./systems/hardware-actions.js').then(hw =>
          hw.deleteInstances(delIds));
      },
    });
    items.push({ label: '─', disabled: true });
    // Washer options (V0.2.22.47) — multi-aware. Same handler as the
    // tree right-click; applies to whole selection if it's all screws.
    const washerIds = allMultiHw ? [...multiSet] : [node.id];
    const curr = node?.washers || { count: 0, spring: false };
    const _check = (cfg) =>
      (curr.count === cfg.count && !!curr.spring === !!cfg.spring) ? ' ✓' : '';
    const _setW = (cfg) => {
      import('./systems/hardware-actions.js').then(hw =>
        hw.setInstanceWashers(washerIds, cfg));
    };
    items.push({
      label: `⊕ No washers${_check({ count: 0, spring: false })}`,
      action: () => _setW({ count: 0, spring: false }),
    });
    items.push({
      label: `⊕ One washer${_check({ count: 1, spring: false })}`,
      action: () => _setW({ count: 1, spring: false }),
    });
    items.push({
      label: `⊕ Two washers${_check({ count: 2, spring: false })}`,
      action: () => _setW({ count: 2, spring: false }),
    });
    items.push({
      label: `⊕ Spring washer only${_check({ count: 1, spring: true })}`,
      action: () => _setW({ count: 1, spring: true }),
    });
    items.push({
      label: `⊕ Spring + flat washer${_check({ count: 2, spring: true })}`,
      action: () => _setW({ count: 2, spring: true }),
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
      label: '🔍 Isolate',
      action: () => actions.isolateSelection(),
    });
    if (actions.hasIsolateSnapshot()) {
      items.push({
        label: '🌐 Un-isolate',
        action: () => actions.unisolate(),
      });
    }
    items.push({
      label: '📁→ Move to folder…',
      action: () => showMoveToFolderDialog([...multiIds]),
    });
    items.push({
      label: '🎯 Fit to selection',
      action: () => _fitToSelection(multiIds),
    });
    // Show color — single mesh/flatShape selection only. Ambiguous which
    // color to show when multiple objects are selected, so the option
    // only appears when exactly one bindable node is selected.
    if (multiIds.size === 1 && (node?.type === 'mesh' || node?.type === 'flatShape' || node?.type === 'hardwareInstance')) {
      items.push({
        label: '🎨 Show color',
        action: () => showColorForNode(node.id),
      });
    }
    // ── Convert to Replace-Model (B.2-NEW.1) ─────────────────────────────
    // Mirrors the tree r-click entry. Single non-archived node only —
    // mesh / flatShape / model (NOT folder). Just flips node.type; no
    // immediate visual change beyond the 🔄 icon in the tree.
    if (multiIds.size === 1 && node && !node.archived &&
        (node.type === 'mesh' || node.type === 'flatShape' || node.type === 'model')) {
      items.push({
        label: '🔄 Convert to Replace-Model',
        action: () => actions.convertToReplaceModel(node.id),
      });
    }
    // ── RM-only: Add to replace (B.2-NEW.2) ──────────────────────────────
    if (multiIds.size === 1 && node?.type === 'replaceModel' && !node.archived) {
      items.push({
        label: '＋ Add to replace…',
        action: () => showAddToReplaceDialog(node.id),
      });
    }
    // ── Archive / Unarchive ─────────────────────────────────────────────
    // Mirrors the tree r-click menu. Toggle is here so the user can lock
    // a node out of the scene without ever opening the tree. Scene root
    // can't be archived (no entry for it). The action is idempotent on
    // the actions.js side so showing one item for a mixed-selection just
    // archives the ones that aren't yet.
    {
      const ids = [...multiIds];
      const anyNotArchived = ids.some(id => nodeById?.get(id)?.archived !== true);
      const anyArchived    = ids.some(id => nodeById?.get(id)?.archived === true);
      if (anyNotArchived) {
        items.push({
          label: ids.length > 1 ? `🗃️ Archive ${ids.length} items` : '🗃️ Archive',
          action: () => actions.archiveNodes(ids),
        });
      }
      if (anyArchived) {
        items.push({
          label: ids.length > 1 ? `📤 Unarchive ${ids.length} items` : '📤 Unarchive',
          action: () => actions.unarchiveNodes(ids),
        });
      }
    }
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
    label: '📷 Update step camera',
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
      ? `📷🔗 Update template "${_viewportActiveStepTplName}"`
      : '📷🔗 Update template (none bound to step)',
    disabled: !_viewportActiveStepTplName,
    action: () => {
      const activeId = state.get('activeStepId');
      if (!activeId) return;
      actions.updateStepCameraAsTemplate([activeId]);
      setStatus(`Updated template "${_viewportActiveStepTplName}".`);
    },
  });
  items.push({
    label: '🎯 Fit view  [F]',
    action: () => {
      if (!sceneCore.rootGroup || !window.THREE) return;
      const box = new THREE.Box3().setFromObject(sceneCore.rootGroup);
      if (!box.isEmpty()) sceneCore.animateCameraTo(sceneCore.fitStateForBox(box, 1.15), 800, 'smooth');
    },
  });
  if (selId) {
    items.push({ label: '✖ Deselect  [Esc]', action: () => { actionClearSelection(); gizmo.hide(); } });
  }

  if (items.length) showContextMenu(items, e.clientX, e.clientY);
});

/**
 * Floating transform panel for the polygon gizmo. Shown on R-click of
 * the gizmo while in shape edit mode. Type-and-Enter applies a delta:
 *   Move X / Move Y → translate by N plane-units
 *   Rotate          → rotate by N degrees around centroid
 *   Scale           → multiply distance-from-centroid by N
 * Each apply is a single undo entry. Esc / outside click closes.
 */
let _polyTransformPanel = null;
function _showPolyTransformPanel(clientX, clientY) {
  _hidePolyTransformPanel();
  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed',
    `left:${clientX + 12}px`,
    `top:${clientY - 8}px`,
    'z-index:9999',
    'background:#1e293b',
    'border:1px solid #334155',
    'border-radius:8px',
    'padding:12px 14px',
    'min-width:200px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
    'font-size:12px',
    'color:#e2e8f0',
    'user-select:none',
  ].join(';');
  const fieldStyle = 'flex:1;background:var(--panel,#0f172a);border:1px solid var(--line,#334155);border-radius:4px;color:var(--text,#e2e8f0);padding:3px 6px;font-size:12px;outline:none;width:0;font-family:monospace;';
  const row = (id, label, color, value) => `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
      <span style="color:${color};font-weight:700;width:46px;flex-shrink:0;">${label}</span>
      <input data-field="${id}" type="text" value="${value}" autocomplete="off" spellcheck="false" style="${fieldStyle}" />
    </div>`;
  panel.innerHTML = `
    <div style="font-weight:700;font-size:13px;color:#f1f5f9;margin-bottom:10px;letter-spacing:0.3px;border-bottom:1px solid #1e293b;padding-bottom:6px;">Shape Transform</div>
    <div style="margin-bottom:8px;">
      <div style="font-size:10px;color:#64748b;margin-bottom:4px;letter-spacing:0.5px;">TRANSLATE (delta, plane-local)</div>
      ${row('tx', 'X',     '#e05555', '0')}
      ${row('ty', 'Y',     '#55cc55', '0')}
    </div>
    <div style="margin-bottom:8px;">
      <div style="font-size:10px;color:#64748b;margin-bottom:4px;letter-spacing:0.5px;">ROTATE (° around centroid)</div>
      ${row('rz', 'Z',     '#5588e0', '0')}
    </div>
    <div>
      <div style="font-size:10px;color:#64748b;margin-bottom:4px;letter-spacing:0.5px;">SCALE (factor, 1 = no change)</div>
      ${row('sc', 'Scale', '#c0c8d6', '1')}
    </div>
    <div style="margin-top:8px;font-size:10px;color:#64748b;">Type a value, press Enter to apply.</div>
  `;
  document.body.appendChild(panel);
  _polyTransformPanel = panel;

  // Nudge into viewport.
  requestAnimationFrame(() => {
    const r = panel.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    if (r.right  > vw - 8) panel.style.left = `${vw - r.width  - 8}px`;
    if (r.bottom > vh - 8) panel.style.top  = `${vh - r.height - 8}px`;
  });

  const apply = (id, raw) => {
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return;
    if (id === 'tx') shapeEditor.applyPolyTranslate(v, 0);
    if (id === 'ty') shapeEditor.applyPolyTranslate(0, v);
    if (id === 'rz') shapeEditor.applyPolyRotate(v);
    if (id === 'sc') shapeEditor.applyPolyScale(v);
  };

  panel.querySelectorAll('input[data-field]').forEach(inp => {
    inp.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      apply(inp.dataset.field, inp.value);
      // Reset to neutral default so a follow-up Enter doesn't re-apply.
      inp.value = (inp.dataset.field === 'sc') ? '1' : '0';
      inp.select();
    });
  });
  // First field gets focus.
  setTimeout(() => panel.querySelector('input[data-field="tx"]')?.focus(), 0);

  const onDown = (ev) => { if (!panel.contains(ev.target)) _hidePolyTransformPanel(); };
  const onKey  = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); _hidePolyTransformPanel(); } };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, { capture: true });
    document.addEventListener('keydown', onKey, { capture: true });
    panel._cleanup = () => {
      document.removeEventListener('pointerdown', onDown, { capture: true });
      document.removeEventListener('keydown', onKey, { capture: true });
    };
  }, 0);
}

function _hidePolyTransformPanel() {
  if (!_polyTransformPanel) return;
  _polyTransformPanel._cleanup?.();
  _polyTransformPanel.remove();
  _polyTransformPanel = null;
}

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

// ── EMERGENCY UNSTICK ─────────────────────────────────────────────────────
// Ctrl+Alt+U from anywhere (including with focus stuck inside a hidden
// dialog) clears stale <dialog> elements, blurs detached focus, and
// resets stuck drag/pointer-event state. Capture phase so it runs even
// if another listener tries to swallow events. See unstuckInputs() in
// systems/actions.js for what it actually does.
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.altKey && (e.key === 'u' || e.key === 'U')) {
    e.preventDefault();
    e.stopPropagation();
    try {
      window.sbsDiag?.unstuckInputs?.();
      setStatus('Unstuck inputs — try typing again.', 'info', 4000);
    } catch {}
  }
}, { capture: true });

// ── V0.2.22.32.2 — suppress lone-Alt menu-bar activation ─────────────────
// Windows convention: a press-then-release of Alt with no other key in
// between activates the native menu bar (File gets keyboard focus, next
// Enter opens it). The app uses Alt+middle-drag for orbit, so EVERY
// orbit-then-keypress sequence trips this — pressing Enter to commit
// a folder-align preview pops the File menu instead of committing.
//
// Fix: capture-phase keydown/keyup on the Alt key with preventDefault.
// Chromium uses the default action of Alt to drive menu activation, so
// preventDefault is enough to disarm it. Alt+OtherKey combos and the
// Alt+middle-button orbit still work — those rely on the modifier flag
// on other events, not on Alt's own default action.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Alt') e.preventDefault();
}, { capture: true });
window.addEventListener('keyup', (e) => {
  if (e.key === 'Alt') e.preventDefault();
}, { capture: true });

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
  // After moving the active step, keep the selection united with it UNLESS
  // we're in multi-select (selection ≥ 2 steps) — see
  // uniteStepSelectionWithActive. activateRelativeStep sets activeStepId
  // synchronously, so reading it inside the unite call is safe.
  if (key === 'ArrowLeft')  { e.preventDefault(); steps.activateRelativeStep(-1); actions.uniteStepSelectionWithActive(); return; }
  if (key === 'ArrowRight') { e.preventDefault(); steps.activateRelativeStep(+1); actions.uniteStepSelectionWithActive(); return; }
  if (key === ' ')          { e.preventDefault(); steps.activateRelativeStep(+1); actions.uniteStepSelectionWithActive(); return; }

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

  // V0.2.22.32 — folder align tool keyboard. Picker owns the decision
  // (Enter only after the 2nd pick previews; Esc anywhere in the flow).
  if (state.get('alignFolderId')) {
    if (folderAlignPicker.onKeyDown(key)) {
      e.preventDefault();
      return;
    }
  }

  // V0.2.22.33 — 3-point folder align keyboard. Backspace removes the
  // last picked point in the current phase; Enter commits when previewing.
  if (state.get('align3FolderId')) {
    if (folderAlign3ptPicker.onKeyDown(key)) {
      e.preventDefault();
      return;
    }
  }

  // ── Selection ────────────────────────────────────────────────────────────
  if (key === 'Escape') {
    if (gizmo.isDragging) { gizmo.onPointerUp(); return; }
    // Replace-Model viewport pick — Esc cancels the one-shot pick mode
    // armed from the add-to-replace dialog's "🎯 Pick from viewport…"
    // button. Runs BEFORE shape editor / placement / etc. so the user
    // can bail at any time.
    if (state.get('replaceModelPickingForId')) {
      state.setState({ replaceModelPickingForId: null });
      setStatus('Replace-Model pick cancelled.');
      return;
    }
    // Shape editor — Esc abandons in-progress polygon (no undo entry,
    // nothing was committed). Highest priority among picking modes.
    if (shapeEditor.isDrawing()) {
      actions.cancelShapeDraw();
      return;
    }
    // Edit-pick mode (waiting for the user to click an instance to edit).
    if (state.get('shapeEditPickInstanceForId')) {
      actions.cancelShapeEditPick();
      return;
    }
    // Place-shape picker — Esc disarms.
    if (state.get('shapePlacementForId')) {
      actions.cancelShapePlacement();
      return;
    }
    // Ray-select cycle list — Esc cancels (no selection change).
    if (_raySelect) {
      _raySelectCancel();
      return;
    }
    // Create-shape-from-face picker — Esc disarms.
    if (state.get('shapeFromFacePicking')) {
      actions.cancelCreateShapeFromFace();
      return;
    }
    // Add-polygon-from-face picker (in-editor) — Esc disarms.
    if (state.get('addPolygonFromFacePicking')) {
      actions.cancelAddPolygonFromFacePick();
      return;
    }
    // Translate-global — Esc rolls back the open session and exits mode.
    // Per-drag undo entries already pushed stay in the log.
    if (state.get('globalEditNodeId')) {
      actions.cancelGlobalEdit();
      return;
    }
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
    // Note repositioning — Esc cancels.
    if (state.get('noteRepositioningId')) {
      actions.cancelNoteRepositioning();
      return;
    }
    // Template instantiation — Esc cancels.
    if (state.get('noteTemplateInstantiationId')) {
      actions.cancelNoteTemplateInstantiation();
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

  // ── Shape editor: Delete removes the selection (edit mode) ──────────
  // Selection can be a single vertex (single click) or a whole polygon
  // (double-click on any vertex of that polygon). deleteSelected
  // dispatches to the right path.
  if ((key === 'Delete' || key === 'Backspace')
      && state.get('shapeDrawing')?.phase === 'edit') {
    e.preventDefault();
    shapeEditor.deleteSelected();
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
  // Reject elements detached from the live document (rare but happens
  // when a dialog closes and the user-agent restores focus to a stale
  // node). Treating these as "input focused" would mask legitimate
  // keyboard shortcuts.
  if (!document.body.contains(el)) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

// ─── License gate (runs at boot) ────────────────────────────────────────────
// Reads the saved license, validates against this machine's hardware.
// Three terminal outcomes:
//   valid    → app proceeds normally (no UI)
//   grace    → app proceeds with a one-shot warning toast
//   expired  → hard-lock screen, user can re-activate or quit
//   unactivated → activation dialog, user enters credentials or quits
async function _initLicenseGate() {
  if (!window.sbsNative?.license?.status) {
    // Non-Electron (e.g. dev web preview) — skip licensing for now.
    return;
  }
  try {
    let status = await window.sbsNative.license.status();
    while (true) {
      if (status.state === 'valid') return;
      if (status.state === 'grace') { showGraceWarning(status); return; }

      if (status.state === 'expired') {
        const choice = await showHardLockDialog(status);
        if (choice === 'quit') { window.close(); return; }
        // 'reactivate' → fall through to activation dialog
      }

      // unactivated OR re-activate requested
      try {
        const result = await showActivationDialog({
          initialEmail: status.email || '',
          reason:       status.reason || null,
        });
        if (result?.valid) {
          setStatus(`SBS activated — ${result.daysRemaining} days remaining.`);
          return;
        }
      } catch (err) {
        if (err?.message === 'cancelled') { window.close(); return; }
        throw err;
      }
      // Refresh status if activation didn't succeed for some weird reason
      status = await window.sbsNative.license.status();
    }
  } catch (err) {
    console.error('[license-gate] failed:', err);
    setStatus(`License check failed: ${err?.message || err}`, 'danger', 8000);
  }
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
