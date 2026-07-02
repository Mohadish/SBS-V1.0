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
  getPathToNode,
}                         from './core/nodes.js';
import { applyAllTransforms, isTransformNode, isNearZero, isIdentityQuaternion, PIVOT_TYPES } from './core/transforms.js';

// ── I/O ───────────────────────────────────────────────────────────────────────
import { saveProject, getSuggestedFilename, serialize } from './io/project.js';

// ── UI ────────────────────────────────────────────────────────────────────────
import { initStatus, setStatus }  from './ui/status.js';
import { showActivationDialog, showHardLockDialog, showGraceWarning } from './ui/license-dialog.js';
import { initHud }                from './ui/hud.js';
import { initStepNav }            from './ui/step-nav.js';
import { initStepsPanel }         from './ui/steps-panel.js';
import { initSidebarLeft, showColorForNode, openCableTabForCable, clearActiveCable } from './ui/sidebar-left.js';
import { initContextMenu, hideContextMenu, showContextMenu, canonicalizeMenuOrder } from './ui/context-menu.js';
import { promptString } from './ui/prompt.js';
import { showMoveToFolderDialog, showAddToReplaceDialog, showReplaceModeDialog, showInputDialog, showInsertAnimDialog } from './ui/tree.js';
import { positionSafeFrameEl }    from './core/safe-frame.js';
import { initOverlay, getStage as getOverlayStage } from './systems/overlay.js';
import { initOverlayToolbar }  from './ui/overlay-toolbar.js';
import { initHeaderLayer }     from './systems/header.js';
import { initCables, resolveNodeWorldPosition, flattenCablesToCascade, resolveCableSnapshotAtStep, applyStepSnapshot as applyCableStepSnapshot } from './systems/cables.js';        // C1: cables wire step:applied → applyStepSnapshot; C5-B: pos resolver for gizmo target; V0.3.0.151 cascade flatten
import * as pivotCenterPicker     from './systems/pivot-center-picker.js';   // 3-point center pivot tool — snap-based picker for cylinder-axis pivot placement
import * as folderAlignPicker     from './systems/folder-align-picker.js';   // V0.2.22.32 — 1-point folder-to-surface align
import * as folderAlign3ptPicker  from './systems/folder-align-3pt-picker.js'; // V0.2.22.33 — 3-point concentric folder align
import * as hardwarePlacePicker   from './systems/hardware-place-picker.js';  // V0.2.22.61 — place/align nuts on a surface

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
import { segmentMeshFaces, buildRegionViz, regionGeometry, regionAspect } from './core/mesh-segment.js';
import { geometrySignature } from './core/geometry-signature.js';
import { detectHex } from './core/socket-detect.js';
import { applyFollow, clearFollow, startFollowPick, isFollowPicking, cancelFollowPick, onFollowPickClick, promptStopFollowing } from './systems/follow.js';
import * as editSession from './systems/edit-session.js';
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

// V0.2.22.66 — pre-install preview. For every actor with `explodeBefore`
// on, EVERY step before its insert step shows the nut EXPLODED (pre-install
// config); per-part tags appear too when tagName is on. Hooked on
// step:activate (fires EARLY + unconditionally, so it survives same-step
// re-activation and rides an incoming camera/object move) and on
// step:applied (final settle). The per-frame tick keeps the merged mesh
// hidden and the tags glued.
import('./systems/hardware-insert-anim.js').then(hw => {
  state.on('step:activate', (id) => hw.refreshPreInstall(id));
  state.on('step:applied',  ()   => hw.refreshPreInstall(state.get('activeStepId')));
  hw.refreshPreInstall(state.get('activeStepId'));
}).catch(() => {});

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
    // V0.3.0.162 — AO + SSR are now PER-PROJECT (state.render). Apply on any change
    // (project load / render panel). A brand-new project (none loaded yet) seeds its
    // copy from the user default; a loaded project already set state.render itself.
    state.on('change:render', rs => { if (rs) sceneCore.applyRenderSettings(rs); });
    if (!state.get('_projectLoaded') && cur.render) state.setState({ render: cur.render });
    sceneCore.applyRenderSettings(state.get('render'));
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

// Planar-mirror spike (V0.3.0.28): window.sbsMirror.fromSelected() turns the
// selected mesh into a true planar mirror; .clear() removes all.
// Read a source material's mirror-relevant params (custom SBS shader uniforms or
// standard-material fallbacks) so the planar mirror honours roughness / reflection
// intensity / solidness, like SSR does.
function _mirrorParamsFromMaterial(mat) {
  let roughness = 0.45, reflectionIntensity = 0.5, solidness = 1.0, metalness = 0.0, color = null;
  if (mat) {
    const u = mat.uniforms;
    if (u) {
      if (u.uRoughness)           roughness           = u.uRoughness.value;
      if (u.uReflectionIntensity) reflectionIntensity = u.uReflectionIntensity.value;
      if (u.uSolidness)           solidness           = u.uSolidness.value;
      if (u.uMetalness)           metalness           = u.uMetalness.value;
      if (u.uColor)               color               = u.uColor.value;
    } else {
      if (typeof mat.roughness === 'number')       roughness           = mat.roughness;
      if (typeof mat.envMapIntensity === 'number') reflectionIntensity = Math.min(1, mat.envMapIntensity * 2);
      if (typeof mat.opacity === 'number')         solidness           = mat.opacity;
      if (typeof mat.metalness === 'number')       metalness           = mat.metalness;
      if (mat.color)                               color               = mat.color;
    }
  }
  return { roughness, reflectionIntensity, solidness, metalness, color, sourceMaterial: mat };
}

// Total flat-mirror safety ceiling (each mirror = 1 extra scene render/frame). High
// enough to fully cover normal projects; raise/lower via window.sbsMirror.setCap(n).
let _flatMirrorCap = 300;
// Skip flat regions longer/thinner than this (chamfers, edge strips) — useless as
// mirrors and the worst count-inflaters. window.sbsMirror.setMaxAspect(n).
let _flatMirrorMaxAspect = 15;
// Last-seen flatMirror flag per preset — lets the 'materials:presetUpdated' reconciler
// (below) build/clear mirrors only when the flag actually flips (incl. on undo/redo),
// without rebuilding on every unrelated colour/roughness edit.
const _flatMirrorFlagCache = new Map();

// Build per-face flat mirrors for a list of meshes (shared by allFromSelected /
// allFromColor). Clears existing mirrors under each mesh first (dedup), then turns
// every flat region above a sliver threshold into a planar mirror honouring the host
// material's params. hitCap=true means coverage was truncated by the cap.
function _buildFlatMirrors(meshes, cap = _flatMirrorCap) {
  meshes.forEach(m => sceneCore.removePlanarMirrorsUnder(m));
  const angle = state.get('shapeFaceAngleThreshold') ?? 5;
  let count = 0, flatTotal = 0, skipped = 0, hitCap = false;
  for (const mesh of meshes) {
    if (count >= cap) { hitCap = true; break; }
    const flats = segmentMeshFaces(mesh, angle).filter(r => r.flat);
    flatTotal += flats.length;
    if (!flats.length) continue;
    const minArea = flats[0].areaLocal * 0.005;  // skip only true slivers
    mesh.geometry.computeBoundingSphere?.();
    const eps = (mesh.geometry.boundingSphere?.radius || 1) * 0.004;
    const sp  = _mirrorParamsFromMaterial(mesh.material);
    for (const region of flats) {
      if (region.areaLocal < minArea) continue;
      if (regionAspect(mesh, region) > _flatMirrorMaxAspect) { skipped++; continue; }  // chamfer / sliver
      if (count >= cap) { hitCap = true; break; }
      const sub = new window.THREE.Mesh(regionGeometry(mesh, region));
      sub.userData.noSelect = true; sub.userData.isMirrorSubmesh = true;
      sub.position.copy(region.normalLocal).multiplyScalar(eps);
      mesh.add(sub);
      const m = sceneCore.addPlanarMirror(sub, sp);
      if (m) { m.material.polygonOffset = true; m.material.polygonOffsetFactor = -2; m.material.polygonOffsetUnits = -2; }
      count++;
    }
  }
  return { count, flatTotal, skipped, meshCount: meshes.length, hitCap };
}

// Meshes whose effective colour (per-step assignment → project default) is presetId.
function _meshesForColor(presetId) {
  const assign   = materials.meshColorAssignments || {};
  const defs     = materials.meshDefaultColors    || {};
  const nodeById = state.get('nodeById');
  const meshes = [];
  for (const nid of new Set([...Object.keys(assign), ...Object.keys(defs)])) {
    if ((assign[nid] ?? defs[nid]) !== presetId) continue;
    nodeById?.get?.(nid)?.object3d?.traverse(o => {
      if (o.isMesh && !o.userData.isMirrorSubmesh) meshes.push(o);
    });
  }
  return meshes;
}

window.sbsMirror = {
  fromSelected: () => {
    const id   = state.get('selectedId');
    const node = id ? state.get('nodeById')?.get?.(id) : null;
    let mesh = null;
    node?.object3d?.traverse(o => { if (!mesh && o.isMesh) mesh = o; });
    if (mesh) { sceneCore.addPlanarMirror(mesh); console.log('[mirror] added on', mesh.name || node?.name || '(mesh)'); }
    else console.warn('[mirror] select a mesh (or a node containing one) first');
  },
  // 2b: mirror the LARGEST flat region of the selected mesh (per-face, true planar).
  faceFromSelected: () => {
    const id   = state.get('selectedId');
    const node = id ? state.get('nodeById')?.get?.(id) : null;
    let mesh = null;
    node?.object3d?.traverse(o => { if (!mesh && o.isMesh) mesh = o; });
    if (!mesh) { console.warn('[mirror] select a mesh first'); return; }
    const angle   = state.get('shapeFaceAngleThreshold') ?? 5;
    const regions = segmentMeshFaces(mesh, angle);
    const region  = regions.find(r => r.flat);   // largest flat (regions sorted by area)
    if (!region) { console.warn('[mirror] no flat region found on this mesh'); return; }
    const sub = new window.THREE.Mesh(regionGeometry(mesh, region));
    sub.userData.noSelect = true;
    sub.userData.isMirrorSubmesh = true;
    // Push the overlay slightly OUT along the face normal so it can't z-fight
    // behind the original face (which would hide the mirror entirely).
    mesh.geometry.computeBoundingSphere?.();
    const eps = (mesh.geometry.boundingSphere?.radius || 1) * 0.004;
    sub.position.copy(region.normalLocal).multiplyScalar(eps);
    mesh.add(sub);
    const m = sceneCore.addPlanarMirror(sub, _mirrorParamsFromMaterial(mesh.material));
    if (m) { m.material.polygonOffset = true; m.material.polygonOffsetFactor = -2; m.material.polygonOffsetUnits = -2; }
    console.log('[mirror] face mirror on largest flat region (area', region.areaLocal.toFixed(2) + '). If blank, run window.sbsMirror.debug(true) — magenta = visible.');
  },
  // 2c: mirror ALL flat faces across every mesh under the selection (capped).
  allFromSelected: (cap = _flatMirrorCap) => {
    const id   = state.get('selectedId');
    const node = id ? state.get('nodeById')?.get?.(id) : null;
    if (!node?.object3d) { console.warn('[mirror] select a mesh/model first'); return; }
    const meshes = [];
    node.object3d.traverse(o => { if (o.isMesh && !o.userData.isMirrorSubmesh) meshes.push(o); });
    const r = _buildFlatMirrors(meshes, cap);
    console.log(`[mirror] ${r.count} face mirrors` + (r.skipped ? `, ${r.skipped} sliver/chamfer skipped` : '') + (r.hitCap ? ` — CAPPED at ${cap}; setCap() to raise` : ` (of ${r.flatTotal} flat regions)`) + '. Each = 1 render/frame.');
  },
  // 2c per-COLOUR: mirror all flat faces of every mesh assigned a colour preset.
  // The bridge to the per-colour "Flat mirror" toggle. Call with no id to list ids.
  allFromColor: (sel, cap = _flatMirrorCap) => {
    const presets = state.get('colorPresets') || [];
    const shortOf = p => (p.id.match(/_(\d+)$/) || [])[1] || '?';
    if (sel == null || sel === '') {
      console.log('[mirror] usage: allFromColor("#hex")  OR  allFromColor(<number>)\n' +
        presets.map(p => `   ${String(shortOf(p)).padStart(3)}   ${p.color}   ${p.name && p.name !== p.color ? p.name : ''}`).join('\n'));
      return;
    }
    const s = String(sel).trim().toLowerCase().replace(/^#/, '');
    const preset = presets.find(p =>
      p.id === sel ||
      String(p.color || '').toLowerCase().replace(/^#/, '') === s ||
      String(p.name  || '').toLowerCase().replace(/^#/, '') === s ||
      String(shortOf(p)) === s);
    if (!preset) { console.warn('[mirror] no colour matches', JSON.stringify(sel), '— run allFromColor() to list them.'); return; }
    const meshes = _meshesForColor(preset.id);
    if (!meshes.length) { console.warn('[mirror] no meshes use colour', preset.color, `(${preset.id})`); return; }
    const r = _buildFlatMirrors(meshes, cap);
    console.log(`[mirror] ${preset.color}: ${r.count} mirrors on ${r.meshCount} mesh(es)` +
      (r.skipped ? `, ${r.skipped} sliver/chamfer faces skipped` : '') +
      (r.hitCap ? ` — CAPPED at ${cap} (more remain; window.sbsMirror.setCap(${cap * 2}) then re-tick)` : ` (of ${r.flatTotal} flat regions)`) + '.');
  },
  // Remove flat mirrors from every mesh using a colour preset (toggle OFF).
  clearColor: (presetId) => {
    const meshes = _meshesForColor(presetId);
    meshes.forEach(m => sceneCore.removePlanarMirrorsUnder(m));
    console.log(`[mirror] cleared flat mirrors for colour ${presetId} (${meshes.length} mesh(es))`);
  },
  // Rebuild all flat mirrors from the presets' flatMirror flag (project load / refresh).
  syncFromPresets: () => {
    sceneCore.clearPlanarMirrors();
    const presets = state.get('colorPresets') || [];
    const flagged = presets.filter(p => p.flatMirror);
    let total = 0;
    for (const p of flagged) {
      const meshes = _meshesForColor(p.id);
      if (meshes.length) total += _buildFlatMirrors(meshes).count;
    }
    // Seed the reconciler cache so a later unrelated edit of a flagged colour
    // doesn't trigger a redundant rebuild.
    presets.forEach(p => _flatMirrorFlagCache.set(p.id, !!p.flatMirror));
    if (flagged.length) console.log(`[mirror] synced ${total} mirror(s) from ${flagged.length} flat-mirror colour(s)`);
    return total;
  },
  // Adjust the total flat-mirror ceiling (each mirror = 1 render/frame). Lower it on
  // huge projects to bound the framerate; re-tick the colour / syncFromPresets to apply.
  setCap: (n) => { _flatMirrorCap = Math.max(1, n | 0); console.log('[mirror] flat-mirror cap =', _flatMirrorCap, '— re-tick the colour or run window.sbsMirror.syncFromPresets() to apply.'); return _flatMirrorCap; },
  getCap: () => _flatMirrorCap,
  // Max flat-face elongation kept (long/short). Lower → drop more chamfers/strips.
  setMaxAspect: (n) => { _flatMirrorMaxAspect = Math.max(1, +n || 15); console.log('[mirror] max flat-face aspect =', _flatMirrorMaxAspect, '(higher keeps thinner faces) — re-tick / syncFromPresets to apply.'); return _flatMirrorMaxAspect; },
  getMaxAspect: () => _flatMirrorMaxAspect,
  debug: (b) => sceneCore.setMirrorDebug(b !== false),
  info:  () => sceneCore.mirrorInfo(),
  clear: () => { sceneCore.clearPlanarMirrors(); console.log('[mirror] cleared'); },
};

// Renderer WebGPU Kokoro engine — debug hooks. Synth auto-routes through this
// when ready (see systems/tts.js); these let you drive it manually:
//   await window.sbsTTSWebGPU.warmUp()   → init + report 'ready'|'unavailable'
//   await window.sbsTTSWebGPU.state()    → current engine state
//   await window.sbsTTSWebGPU.synth('hello there')   → { dataUrl, durationMs }
window.sbsTTSWebGPU = {
  warmUp: ()                          => import('./systems/tts-webgpu.js').then(m => m.warmUp()),
  state:  ()                          => import('./systems/tts-webgpu.js').then(m => m.getState()),
  synth:  (t, v = 'af_heart', s = 1)  => import('./systems/tts-webgpu.js').then(m => m.synthesize(t, v, s)),
};

// TTS engine controls + diagnostics from the console:
//   await window.sbsTTS.engine()        → { webgpu:'ready'|…, webgpuError, forceCpu }
//   await window.sbsTTS.forceCPU(true)  → ALWAYS use the CPU worker (persisted)
//   await window.sbsTTS.forceCPU(false) → GPU when ready, CPU otherwise
// forceCPU is the guaranteed-reliable escape hatch: it survives reloads and takes
// effect on the very next synth, so the CPU can always cover for the GPU.
window.sbsTTS = {
  engine:   ()          => import('./systems/tts.js').then(m => m.getEngineStatus()),
  forceCPU: (on = true) => import('./systems/tts.js').then(m => m.setForceCpu(on)),
  // Unstick a step whose real-voice synth wedged (its de-dup key is poisoned) —
  // no need to duplicate the step. Returns how many in-flight entries it cleared.
  clearPending: () => import('./ui/steps-panel.js').then(m => { const n = m.clearPendingSynths(); console.log(`[tts] cleared ${n} pending synth entr${n === 1 ? 'y' : 'ies'}`); return n; }),
  // Capture the active step's narration text char-by-char (NO synth — safe on a
  // stuck step) and write it to a file Claude can read. Run while a step is sticky.
  dumpText: async () => {
    const rep = await (await import('./systems/tts.js')).dumpNarrationText();
    try { await window.sbsNative.writeFile('E:/SBS-V1.0 - Claude/.claude/worktrees/V0.3.1/tts-textdump.json', JSON.stringify(rep, null, 2), 'utf-8'); }
    catch (e) { console.warn('[tts] dumpText write failed:', e?.message); }
    console.log(`[tts] text dump written — ${rep.flagged.length} flagged char(s), changed=${rep.changed}`);
    alert('Text captured — tell Claude "done"');
    return rep;
  },
};
// Full TTS diagnostic — run when a clip misbehaves. No arg → uses the active
// step's narration. Reports engine state, flags hidden/suspicious characters in
// the text (the paste-breaks-Kokoro culprit), shows the sanitized form, and runs
// a real synth to confirm it works:  await window.sbsTTSDiag()
window.sbsTTSDiag = (text) => import('./systems/tts.js').then(m => m.diagnose(text));

// Emergency memory relief: drop the undo/redo history, which on a big project
// pins the OLD base64 (overlay / sequence frames / audio) of every base64-changing
// edit. Run when the heap is climbing toward the ~3.5 GB cage; the freed data is
// collectable on the next GC. Returns how many undo entries were cleared.
window.sbsFreeMemory = () => import('./systems/undo.js').then(({ undoManager }) => {
  const n = undoManager.listUndo().length;
  undoManager.clear();
  const heap = performance.memory ? ` (heap ${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)} MB used)` : '';
  console.log(`[mem] cleared ${n} undo entries — their retained base64 is now collectable${heap}`);
  return n;
});

// Where is the heap going? Sums the INLINE base64 (overlay JSON incl. sequence
// frames, + narration audio) held in the steps, and whether the audio cache
// folder is set. Read-only, no synth — safe to run any time. This tells us which
// disk-cache actually matters for THIS project.
window.sbsMemReport = () => import('./core/state.js').then((m) => {
  const state = m.state ?? m.default;
  const steps = state.get('steps') || [];
  let overlayBytes = 0, narrInlineBytes = 0, narrInlineCount = 0, narrDiskCount = 0, seqFrames = 0;
  for (const s of steps) {
    if (typeof s.overlay === 'string') {
      overlayBytes += s.overlay.length;
      seqFrames += (s.overlay.match(/"sequence"/g) || []).length;   // rough: sequences present
    }
    const n = s.narration;
    if (n?.dataUrl) { narrInlineBytes += n.dataUrl.length; narrInlineCount++; }
    else if (n?.dataFile) narrDiskCount++;
  }
  const mb = (b) => +(b / 1048576).toFixed(1);
  const rep = {
    steps: steps.length,
    audioCacheFolder: state.get('audioCacheFolder') || 'NOT SET → all narration is inline base64',
    overlayInline_MB: mb(overlayBytes),
    stepsWithSequences: seqFrames,
    narrationInline: `${narrInlineCount} clips = ${mb(narrInlineBytes)} MB`,
    narrationOnDisk: narrDiskCount,
    heapUsed_MB: performance.memory ? mb(performance.memory.usedJSHeapSize) : 'n/a',
  };
  console.log('[mem-report]', rep);
  return rep;
});

// Interface library folder controls — the folder is now persisted per project
// (V0.3.1.52), but if you pick the WRONG one, you had to restart. These let you
// check / re-pick / clear it live (then Save to persist the correction):
//   await window.sbsIface.folder()      → current library folder path
//   await window.sbsIface.setFolder()   → re-open the folder picker (fix a wrong pick)
//   window.sbsIface.clearFolder()       → forget it (next insert re-prompts)
window.sbsIface = {
  folder:      () => import('./systems/interfaces.js').then(m => m.getLibraryFolder()),
  setFolder:   () => import('./systems/interfaces.js').then(m => m.chooseLibraryFolder()),
  clearFolder: () => import('./systems/interfaces.js').then(m => { m.setLibraryFolder(null); console.log('[iface] library folder cleared — next insert will re-prompt'); return true; }),
  // Re-derive every bonded shape on the CURRENT step from its % and BAKE the
  // corrected positions into this step's stored overlay. Bonded shapes are
  // always derived on load anyway (so this is a cache refresh, not a repair) —
  // use it to clean a step's stored data after a default change. Safe (current
  // step only; no full-project sweep). Then Save the project to persist.
  reSave: () => import('./systems/overlay.js').then(m => {
    for (const iface of (m.getInterfaceNodes?.() || [])) m.syncBondedShapes?.(iface);
    m.flushSave?.();
    console.log('[iface] re-fit + baked current step’s bonded shapes');
    return true;
  }),
};

// EAGER warm-up at launch (background). The fp32 Kokoro model is ~325 MB and the
// GPU shaders must compile, so a cold warm-up takes tens of seconds. Doing it
// lazily (only on the first synth) means early clips fall back to the slow CPU
// worker → "TTS doesn't work, then works after a while". Critically, a renderer
// reload (Ctrl+R) resets the engine to 'untried', so this must re-run on every
// load — which it does (main.js re-executes). Idempotent: warmUp() no-ops if
// already ready/initializing. Small delay so the 3D scene/UI boot first. Skipped
// entirely when the user has forced the CPU path (no point loading 325 MB).
setTimeout(async () => {
  try {
    const us = await import('./core/user-settings.js');
    if (us.get?.()?.tts?.forceCpu) { console.log('[tts] forceCpu set — skipping GPU warm-up (CPU worker only).'); return; }
  } catch {}
  window.sbsTTSWebGPU.warmUp()
    .then((st) => console.log(`[tts] launch warm-up → ${st}`))
    .catch(() => {});
}, 2000);

// ── Select Similar (V0.3.0.48) ────────────────────────────────────────────────

// ── Reparent-arc straighten controls ──────────────────────────────────────
// When an object moves between folders but barely changes visual position, the
// transition's pivot/inherit math used to fling it through a big arc. This
// feature gives those objects a plain straight world-lerp instead. It does NOT
// remove them from the animation, so their per-frame data write-back still runs
// (no home drift). Default ON, threshold 10.
//   window.sbsReparent.off() / .on()      → global default off / on
//   window.sbsReparent.threshold(20)      → widen the "barely moved" window
//   window.sbsReparent.stepOff()/stepOn() → override the CURRENT step only
//   window.sbsReparent.stepAuto()         → clear the current step's override
//   window.sbsReparent.status()           → print the effective settings
//   window.sbsReparentDebug = true        → log each reparented object's decision
window.sbsReparent = {
  on:  () => { state.setState({ reparentArc: true  }); console.log('[reparent] global default = ON'); },
  off: () => { state.setState({ reparentArc: false }); console.log('[reparent] global default = OFF'); },
  threshold: (n) => { state.setState({ reparentArcThreshold: Math.max(0, +n || 0) }); console.log('[reparent] global threshold =', state.get('reparentArcThreshold')); },
  // Per-step helpers write to step.transition via the undoable/persisted action
  // (same field the popover checkbox uses).
  stepOn:   () => { const s = steps._getActiveStep?.(); if (!s) return console.warn('[reparent] no active step'); actions.updateTransition(s.id, { reparentArc: true  }); console.log(`[reparent] step "${s.name || s.id}" = ON`); },
  stepOff:  () => { const s = steps._getActiveStep?.(); if (!s) return console.warn('[reparent] no active step'); actions.updateTransition(s.id, { reparentArc: false }); console.log(`[reparent] step "${s.name || s.id}" = OFF`); },
  stepAuto: () => { const s = steps._getActiveStep?.(); if (!s) return console.warn('[reparent] no active step'); actions.updateTransition(s.id, { reparentArc: undefined, reparentArcThreshold: undefined }); console.log(`[reparent] step "${s.name || s.id}" = AUTO (uses global)`); },
  status: () => {
    const s = steps._getActiveStep?.();
    const t = s?.transition || {};
    const gOn = state.get('reparentArc') !== false, gThr = state.get('reparentArcThreshold') ?? 10;
    const sOv = t.reparentArc !== undefined ? (t.reparentArc ? 'ON' : 'OFF') : 'auto';
    console.log(`[reparent] global=${gOn ? 'ON' : 'OFF'} thr=${gThr} | step "${s?.name || s?.id || '—'}" override=${sOv} thr=${t.reparentArcThreshold ?? '(global)'}`);
  },
};

// Auto-name every step — also in the step right-click menu.
window.sbsRenameSteps          = () => actions.autoNameStepsByChapter();
window.sbsRenameStepsNarration = () => actions.autoNameStepsFromNarration();

// DIAGNOSTIC (read-only — no UI, no storage, no shared code touched). Logs the
// SELECTED object's pivot pose measured RELATIVE TO ITS PARENT FOLDER'S PIVOT —
// the exact math behind the planned LOCAL lens. Verify these numbers against your
// mental model BEFORE we wire it into the panel.
//   - TRANSLATE: child pivot offset from the parent pivot, in the PARENT's frame.
//     Zero ⇒ child pivot sits exactly on the parent pivot.
//   - ROTATE: child orientation relative to the parent's orientation (the delta).
//     Parent 30° + child 45° world ⇒ reads 15°. Zero ⇒ child aligned to parent.
//   - Object with no parent folder (at root) ⇒ parent = world origin/identity, so
//     these equal the WORLD readout.
window.sbsLocalRel = () => {
  const T = window.THREE;
  const id = state.get('selectedId');
  const nodeById = state.get('nodeById');
  const root = state.get('treeData');
  if (!T || !id || !nodeById) { console.warn('[localRel] select an object first'); return; }
  const node = nodeById.get(id);
  const obj  = steps.object3dById?.get(id);
  if (!node || !obj) { console.warn('[localRel] no object3d for the selection'); return; }
  obj.updateWorldMatrix(true, false);

  // Child pivot world pose (pivot, or origin if no pivot — matches the WORLD lens).
  const cPiv = (node.pivotEnabled === false) ? [0, 0, 0] : (node.pivotLocalOffset ?? [0, 0, 0]);
  const childPivotWorld = obj.localToWorld(new T.Vector3(cPiv[0], cPiv[1], cPiv[2]));
  const childQ = obj.getWorldQuaternion(new T.Quaternion());

  // Parent folder (data-tree parent) pivot world pose, or world origin at root.
  const parentNode = findParent(root, id);
  let parentPivotWorld = new T.Vector3(0, 0, 0);
  let parentQ = new T.Quaternion();
  if (parentNode && parentNode.type !== 'scene') {
    const parentObj = steps.object3dById?.get(parentNode.id);
    if (parentObj) {
      parentObj.updateWorldMatrix(true, false);
      const pPiv = (parentNode.pivotEnabled === false) ? [0, 0, 0] : (parentNode.pivotLocalOffset ?? [0, 0, 0]);
      parentPivotWorld = parentObj.localToWorld(new T.Vector3(pPiv[0], pPiv[1], pPiv[2]));
      parentObj.getWorldQuaternion(parentQ);
    }
  }

  const invParentQ = parentQ.clone().invert();
  const relPos = childPivotWorld.clone().sub(parentPivotWorld).applyQuaternion(invParentQ);
  const relQ   = invParentQ.clone().multiply(childQ);
  const e = new T.Euler().setFromQuaternion(relQ, 'XYZ');
  const f   = v => +v.toFixed(2);
  const deg = r => +(r * 180 / Math.PI).toFixed(2);
  const out = { translate: [f(relPos.x), f(relPos.y), f(relPos.z)], rotate: [deg(e.x), deg(e.y), deg(e.z)] };
  console.log(`[localRel] "${node.name || id}" relative to parent "${parentNode?.name || '(root)'}"`);
  console.log('  TRANSLATE (parent-pivot frame):', out.translate);
  console.log('  ROTATE °  (rel to parent):', out.rotate);
  return out;
};

// Pick one mesh → select every part with a matching geometry fingerprint. CAD
// assemblies keep repeated parts (screws/nuts/washers) as instances of the same
// geometry, so identical fingerprints group them reliably. window.sbsSelectSimilar().
window.sbsSelectSimilar = () => {
  const id = state.get('selectedId');
  if (!id) { console.warn('[similar] select one mesh first'); return; }
  const node = state.get('nodeById')?.get?.(id);
  let refMesh = null;
  node?.object3d?.traverse(o => { if (!refMesh && o.isMesh) refMesh = o; });
  if (!refMesh) { console.warn('[similar] the selection has no mesh'); return; }
  const refSig = geometrySignature(refMesh);
  if (!refSig) { console.warn('[similar] could not fingerprint the selection'); return; }
  const matches = [];
  for (const [nid, mesh] of materials.meshById) {
    if (geometrySignature(mesh) === refSig) matches.push(nid);
  }
  if (!matches.length) { console.warn('[similar] no matches'); return; }
  actions.setSelection(matches[0], new Set(matches));
  console.log(`[similar] selected ${matches.length} part(s) matching signature ${refSig}`);
  return matches.length;
};

// ── Select by HEX socket/head (V0.3.0.49 spike) ───────────────────────────────
// Detect the hex pattern (6 flat walls ~60° around an axis) and select every hex
// fastener — Allen-socket screws, hex bolt heads, hex nuts — regardless of length.
// window.sbsHexInfo() prints the selected part's hex score so you can pick a threshold.
window.sbsSelectHex = (minScore = 0.8) => {
  const matches = [];
  for (const [nid, mesh] of materials.meshById) {
    if (detectHex(mesh, { minScore })) matches.push(nid);
  }
  if (!matches.length) {
    console.warn(`[hex] none found at score≥${minScore}. Select your screw + run window.sbsHexInfo() to see its score, then window.sbsSelectHex(<lower>).`);
    return;
  }
  actions.setSelection(matches[0], new Set(matches));
  console.log(`[hex] selected ${matches.length} hex fastener(s) at score≥${minScore}.`);
  return matches.length;
};
window.sbsHexInfo = () => {
  const id = state.get('selectedId');
  const node = id ? state.get('nodeById')?.get?.(id) : null;
  let mesh = null;
  node?.object3d?.traverse(o => { if (!mesh && o.isMesh) mesh = o; });
  if (!mesh) { console.warn('[hex] select a screw first'); return; }
  const h = detectHex(mesh, { minScore: 0 });
  if (!h) { console.log('[hex] no analysable flat regions on this mesh'); return; }
  const suggest = Math.max(0.6, +(h.score - 0.1).toFixed(2));
  console.log(`[hex] selected part → score ${h.score.toFixed(3)} (≥0.8 = clean hex), walls ${h.walls}, radius ${h.radius.toFixed(2)}. Try window.sbsSelectHex(${suggest}).`);
  return h;
};

// ── Follow Object (V0.3.0.63, Stage 2 console test) ───────────────────────────
// Selection form: select the FOLLOWER, shift-select the TARGET, then
// window.sbsFollow('all'|'forward'|'backward'). Explicit form (unambiguous):
// window.sbsFollow.ids(followerId, targetId, scope). window.sbsUnfollow() clears.
window.sbsFollow = (scope = 'all') => {
  const primary = state.get('selectedId');
  const multi   = [...(state.get('multiSelectedIds') || [])];
  const target  = multi.find(id => id !== primary);
  if (!primary || !target) {
    console.warn('[follow] select the FOLLOWER then shift-select the TARGET, or use window.sbsFollow.ids(followerId, targetId, scope).');
    return;
  }
  console.log('[follow] follower =', primary, '| target =', target, '| scope =', scope);
  return applyFollow(primary, target, { scope });
};
window.sbsFollow.ids = (followerId, targetId, scope = 'all') => applyFollow(followerId, targetId, { scope });
window.sbsUnfollow = () => clearFollow(state.get('selectedId'));

// ── Stuck text-field diagnostics + unstick (V0.3.0.48) ─────────────────────────
// Run window.sbsDiag.input() WHEN typing is stuck → captures the cause. Run
// window.sbsFix.input() to force-unstick (close stray modals, clear inert, refocus).
// EXTEND window.sbsDiag — do NOT reassign it: actions.js already populates it at import
// (unstuckInputs, cablesAudit, visibilityAudit, rmHealth, …) and the Edit menu + Ctrl+Alt+U
// call window.sbsDiag.unstuckInputs. A full `= {}` reassignment would wipe those.
window.sbsDiag = window.sbsDiag || {};
// V0.3.0.151 — run the cascade flatten on the CURRENT session (no reload). Converts
// existing per-step cable data to defining-steps-only, re-resolves the live cable,
// and re-renders. Save to persist. window.sbsCable.flatten()
window.sbsCable = window.sbsCable || {};
window.sbsCable.flatten = () => {
  const removed = flattenCablesToCascade();
  applyCableStepSnapshot(resolveCableSnapshotAtStep(state.get('activeStepId')));
  sceneCore.requestRender?.(0);
  console.log(`[cables] flatten: removed ${removed} per-step entr${removed === 1 ? 'y' : 'ies'} → cascade. Save to persist.`);
  return removed;
};
window.sbsDiag.input = () => {
    const desc = el => el ? `${el.tagName}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : ''}` : null;
    const ae = document.activeElement;
    const openD = [...document.querySelectorAll('dialog')].filter(d => d.open);
    const modal = openD.filter(d => { try { return d.matches(':modal'); } catch { return false; } });
    const inert = [...document.querySelectorAll('[inert]')];
    let editActive = false; try { editActive = editSession.isActive(); } catch {}
    let synthPrevented = null;
    if (ae) { try { const ev = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }); ae.dispatchEvent(ev); synthPrevented = ev.defaultPrevented; } catch {} }
    const report = {
      activeElement: desc(ae),
      activeIsEditable: !!ae && (['INPUT', 'TEXTAREA'].includes(ae.tagName) || ae.isContentEditable),
      documentHasFocus: document.hasFocus(),
      openDialogs: openD.length,
      modalDialogs: modal.length,
      modalIds: modal.map(desc).join(', '),
      inertNodes: inert.length,
      inertIds: inert.slice(0, 6).map(desc).join(', '),
      editSessionActive: editActive,
      syntheticKeydownPrevented: synthPrevented,
    };
    console.log('%c[diag] WHEN STUCK expect: activeIsEditable=true, documentHasFocus=true, modalDialogs=0, editSessionActive=false, syntheticKeydownPrevented=false. Anything else = the cause — send me this table.', 'font-weight:bold');
    (console.table || console.log)(report);
    return report;
};
// Archived-flag persistence diagnostic. Run BEFORE saving with something archived:
// compares the live archived nodes against what serialize() would actually write to
// the file — pinpoints save (flag missing from serialized tree) vs load (flag in the
// save but gone after reload). Run again AFTER reload to see if the live tree kept it.
window.sbsDiag.archived = () => {
  const nodeById = state.get('nodeById');
  const live = [];
  nodeById?.forEach?.((n, id) => { if (n && n.archived === true) live.push(`${n.name || '(node)'} [${id}]`); });
  let saved = [];
  try {
    const proj = serialize();
    const walk = (n) => { if (!n) return; if (n.archived === true) saved.push(n.id); (n.children || []).forEach(walk); };
    walk(proj.tree?.root);
  } catch (e) { saved = [`(serialize failed: ${e.message})`]; }
  console.log('%c[diag] archived — live tree vs what would be SAVED:', 'font-weight:bold');
  console.log('  live archived nodes :', live.length, live);
  console.log('  in serialized save  :', saved.length, saved);
  console.log('  → live has them but SAVE does not = save bug. Both have them but they vanish after reload = load/remap bug.');
  return { live, saved };
};
// Shape persistence diag (V0.3.0.95). Run BEFORE save and AFTER reload, then
// compare: fewer in "save tree" than "live" = SAVE drops instances; equal here
// but fewer after reload = LOAD drops them; orphans>0 = a template didn't persist.
// Interface bond health for the ACTIVE step. Run after load to verify bonds
// survived save/load: `orphanedBonds` = shapes whose attachedTo doesn't match any
// live interface (= broken bond); `defaultPose` null after load = the shared
// default wasn't persisted. window.sbsDiag.iface()
window.sbsDiag.iface = async () => {
  const ov = await import('./systems/overlay.js');
  const ifaces = ov.getInterfaceNodes ? ov.getInterfaceNodes() : [];
  let defaultPose = null;
  try { defaultPose = (await import('./systems/interfaces.js')).getDefaultPose(); } catch {}
  const ifaceIds = new Set(ifaces.map(n => n.getAttr('ifaceId')).filter(Boolean));
  const layer = ifaces[0]?.getLayer?.();
  const orphanedBonds = [];
  if (layer) for (const c of layer.getChildren()) {
    const at = c.getAttr && c.getAttr('attachedTo');
    if (at && !ifaceIds.has(at)) orphanedBonds.push({ node: c.name?.() || c.getClassName?.(), attachedTo: at });
  }
  const rep = {
    defaultPose,
    interfaces: ifaces.map(n => ({
      ifaceId:   n.getAttr('ifaceId') || '(NONE — bonds can\'t match!)',
      atDefault: !!n.getAttr('atDefault'),
      bonded:    (ov.getAttachedShapes ? ov.getAttachedShapes(n) : []).length,
      pos:       `${Math.round(n.x())},${Math.round(n.y())}`,
      size:      `${Math.round(n.width())}x${Math.round(n.height())}`,
    })),
    orphanedBonds,
  };
  console.log('[iface-diag]', rep);
  return rep;
};

window.sbsDiag.shapes = () => {
  const nodeById = state.get('nodeById');
  const tplIds = new Set((state.get('shapeTemplates') || []).map(t => t.id));
  const live = [];
  nodeById?.forEach?.((n, id) => {
    if (n && n.type === 'flatShape') {
      live.push({ id, name: n.name || '(shape)', templateId: n.templateId, tplOK: tplIds.has(n.templateId) });
    }
  });
  let saved = [], savedTpls = [];
  try {
    const proj = serialize();
    const walk = (n) => { if (!n) return; if (n.type === 'flatShape') saved.push({ id: n.id, templateId: n.templateId }); (n.children || []).forEach(walk); };
    walk(proj.tree?.root);
    savedTpls = (proj.shapes?.items || []).map(t => t.id);
  } catch (e) { saved = [`(serialize failed: ${e.message})`]; }
  const savedTplSet = new Set(savedTpls);
  const orphans = saved.filter(s => s.templateId && !savedTplSet.has(s.templateId));
  console.log('%c[diag] shapes — live vs SAVE:', 'font-weight:bold');
  console.log('  live flatShape instances :', live.length, live);
  console.log('  in serialized save tree  :', saved.length, saved);
  console.log('  templates in save library:', savedTpls.length, savedTpls);
  console.log('  ORPHAN saved instances (template NOT saved):', orphans.length, orphans);
  console.log('  → fewer in save-tree than live = SAVE drops; equal now but fewer after reload = LOAD drops; orphans>0 = template lost.');
  return { live, saved, savedTpls, orphans };
};
// V0.3.0.123 — easy per-frame trace: click the misbehaving shape to SELECT it,
// then run window.sbsDiag.traceSelected(). Play the step, copy the [fadeTrace ~]
// lines, then window.sbsDiag.traceOff().
window.sbsDiag.traceSelected = () => {
  const id = state.get('selectedId');
  if (!id) {
    console.log('%c[trace] Nothing selected. Click the misbehaving shape first, then run this again.', 'color:#f59e0b');
    return null;
  }
  const node = state.get('nodeById')?.get(id);
  window.sbsDiag.fadeTraceNode = id;
  console.log(`%c[trace] ON for "${node?.name || id}" (${node?.type}). Now PLAY the step, then copy every [fadeTrace ~] line. Run window.sbsDiag.traceOff() when done.`, 'color:#22c55e;font-weight:bold');
  return id;
};
window.sbsDiag.traceOff = () => { window.sbsDiag.fadeTraceNode = null; console.log('[trace] off.'); };
// V0.3.0.142 — one-shot inspector: dump what EVERY step stores for a cable (per
// node: anc/pos/pl). Reveals contaminated or missing per-step data without
// recording. Run window.sbsDiag.cableSteps() to list cables, or pass a cable id.
window.sbsDiag.cableSteps = (cableId) => {
  const steps = state.get('steps') || [];
  if (!cableId) {
    console.log('Cables:', (state.get('cables') || []).map(c => `${c.id} (${c.nodes?.length || 0} nodes)`));
    console.log('Run window.sbsDiag.cableSteps("<cableId>") to dump per-step data.');
    return;
  }
  const fmt = (a, n) => Array.isArray(a) ? a.slice(0, n).map(v => Number(v).toFixed(0)).join(',') : '?';
  steps.forEach((s, i) => {
    const c = s.snapshot?.cables?.[cableId];
    if (!c) { console.log(`step ${i} "${s.name}": (NO cable entry)`); return; }
    const nodeStr = c.nodes && Object.keys(c.nodes).length
      ? Object.entries(c.nodes).map(([nid, pose]) => {
          const p = Array.isArray(pose) ? { pos: pose } : (pose || {});
          const bits = [];
          if (p.anc) bits.push(`anc=${fmt(p.anc, 3)}`);
          if (p.pos) bits.push(`pos=${fmt(p.pos, 3)}`);
          if (typeof p.pl === 'boolean') bits.push(`pl=${p.pl}`);
          return `${String(nid).slice(-5)}{${bits.join(' ')}}`;
        }).join('  ')
      : '(no nodes captured)';
    console.log(`step ${i} "${s.name}": vis=${c.visible} ${nodeStr}`);
  });
};
// V0.3.0.168 — "Group for global edit" DRY RUN. Select objects, then run
// window.sbsGroupFix.dryRun()  (or 'forward'/'backward'/'selected'). NON-DESTRUCTIVE:
// it only RESOLVES + reports each selected object's world pose across the scoped
// steps so we can confirm the per-step resolution is correct before wiring the
// actual (destructive) wrap. Reports pose count, how many are DISTINCT (static vs
// animated), and any steps where an object is missing.
window.sbsGroupFix = window.sbsGroupFix || {};
window.sbsGroupFix.dryRun = (scope = 'all') => {
  const sel = [...(state.get('multiSelectedIds') || [])];
  if (!sel.length) { console.log('[groupFix] Select 1+ objects in the tree/viewport first.'); return; }
  const allSteps = (state.get('steps') || []).filter(s => !s.isBaseStep);
  const ids   = allSteps.map(s => s.id);
  const active = state.get('activeStepId');
  const aIdx  = ids.indexOf(active);
  let scoped  = ids;
  if (scope === 'forward'  && aIdx >= 0) scoped = ids.slice(aIdx);
  if (scope === 'backward' && aIdx >= 0) scoped = ids.slice(0, aIdx + 1);
  if (scope === 'selected') { const ss = state.get('selectedStepIds'); const f = ids.filter(id => ss?.has?.(id)); scoped = f.length ? f : ids; }
  const poses    = steps.resolveObjectWorldPosesPerStep(sel, scoped);
  const nodeById = state.get('nodeById');
  console.log(`[groupFix] DRY RUN — ${sel.length} object(s) × ${scoped.length} step(s) (scope: ${scope}). NOTHING changed.`);
  for (const id of sel) {
    const name = nodeById?.get?.(id)?.name || id;
    const seen = []; let missing = 0;
    for (const sid of scoped) {
      const w = poses.get(sid)?.get(id);
      if (!w) { missing++; continue; }
      // V0.3.0.170 — report the VISUAL centre (bbox), not the transform origin
      // (which is [0,0,0] for baked CAD geometry and tells you nothing).
      seen.push((w.center || w.pos).map(v => Number(v).toFixed(0)).join(','));
    }
    const distinct = new Set(seen).size;
    console.log(`  "${name}": ${seen.length} resolved, ${distinct} distinct centre${distinct === 1 ? '' : 's'}${missing ? `, MISSING in ${missing} step(s)` : ''} | first=[${seen[0] || '-'}] last=[${seen[seen.length - 1] || '-'}]`);
  }
  console.log('[groupFix] These are VISUAL centres (mm). Expect each part at a DIFFERENT, sensible spot (not all 0,0,0). "MISSING in 3" = your 3 hidden steps — fine. If the centres look right, say the word and I wire the wrap.');
  return poses;
};
window.sbsFix = window.sbsFix || {};
// Manually re-run the orphan-shape self-heal (also runs automatically on load).
window.sbsFix.pruneShapes = () => {
  const n = actions.pruneOrphanShapeInstances?.() ?? 0;
  console.log(n ? `[fix] pruned ${n} orphan shape(s). Save to persist.` : '[fix] no orphan shapes.');
  return n;
};
window.sbsFix.input = () => {
    const done = [];
    [...document.querySelectorAll('dialog')].filter(d => d.open).forEach(d => { try { d.close(); done.push('closed <dialog> ' + (d.id || '')); } catch {} });
    [...document.querySelectorAll('[inert]')].forEach(n => { try { n.removeAttribute('inert'); done.push('cleared [inert]'); } catch {} });
    try { if (editSession.isActive()) { editSession.end({ commit: false }); done.push('ended edit session'); } } catch {}
    try { document.activeElement?.blur?.(); } catch {}
    try { window.focus(); document.body.focus?.(); } catch {}
    console.log('[fix] unstick:', done.length ? done.join(', ') : 'no stray dialogs/inert/session; focus reset. If still stuck, run window.sbsDiag.input() and send me the table.');
    return done;
};

// Flat-face segmentation viz (V0.3.0.29, Tier-2 stage 2a): window.sbsSegment.show()
// colours each coplanar flat region on the selected mesh so we can validate
// detection before building per-face mirrors. .clear() removes the overlay.
let _segViz = null;
window.sbsSegment = {
  show: () => {
    if (_segViz) { _segViz.parent?.remove(_segViz); _segViz = null; }
    const id   = state.get('selectedId');
    const node = id ? state.get('nodeById')?.get?.(id) : null;
    let mesh = null;
    node?.object3d?.traverse(o => { if (!mesh && o.isMesh) mesh = o; });
    if (!mesh) { console.warn('[segment] select a mesh (or a node containing one) first'); return; }
    const angle   = state.get('shapeFaceAngleThreshold') ?? 5;
    const regions = segmentMeshFaces(mesh, angle);
    _segViz = buildRegionViz(mesh, regions);
    sceneCore.requestRender(300);
    const big = regions.filter(r => r.tris.length >= 4).length;
    console.log(`[segment] ${regions.length} regions @ ${angle}° (${big} sizeable). Biggest area ≈ ${regions[0]?.areaLocal?.toFixed?.(2)}. Coloured overlays added — distinct flat colour per face = good.`);
  },
  clear: () => { if (_segViz) { _segViz.parent?.remove(_segViz); _segViz = null; sceneCore.requestRender(300); console.log('[segment] cleared'); } },
};

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
// Flat mirrors are derived (not saved) — rebuild them once a project finishes
// loading, from each colour preset's flatMirror flag. Deferred so the scene tree
// + material assignments are settled first.
state.on('project:loaded', () => setTimeout(() => {
  try { window.sbsMirror?.syncFromPresets?.(); } catch (e) { console.warn('[mirror] sync on load failed', e); }
}, 0));
// V0.3.0.80 — the project:loaded pass above can fire BEFORE the model's meshes are
// registered (model load is async, especially asset reintegration). With no meshes,
// _meshesForColor() is empty so syncFromPresets() builds nothing — which is why flat
// mirrors "didn't persist" and only came back after manually re-ticking the colour.
// Re-run the sync once meshes actually arrive. Debounced so a multi-model load (or
// reintegration) collapses to a single rebuild after the last model lands.
let _mirrorResyncTimer = null;
state.on('model:loaded', () => {
  clearTimeout(_mirrorResyncTimer);
  _mirrorResyncTimer = setTimeout(() => {
    try { window.sbsMirror?.syncFromPresets?.(); } catch (e) { console.warn('[mirror] resync on model load failed', e); }
  }, 250);
});
// Keep flat mirrors in sync with each colour's flatMirror flag across DO / UNDO / REDO.
// materials.updatePreset and its undo/redo all emit 'materials:presetUpdated', so we
// build/clear here when (and only when) the flag flips — the checkbox handler no longer
// does it imperatively, which previously left orphan mirrors after Ctrl+Z.
state.on('materials:presetUpdated', (preset) => {
  if (!preset || !preset.id) return;
  const was = _flatMirrorFlagCache.get(preset.id) || false;
  const now = !!preset.flatMirror;
  if (was === now) return;
  _flatMirrorFlagCache.set(preset.id, now);
  try {
    if (now) window.sbsMirror?.allFromColor?.(preset.id);
    else     window.sbsMirror?.clearColor?.(preset.id);
  } catch (e) { console.warn('[mirror] flatMirror flag sync failed', e); }
});
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
    // V0.3.0.119 — 2+ points selected → one gizmo at their centroid that moves
    // them all together. Single selection keeps the existing per-point target.
    const multi = state.get('selectedCablePoints') || [];
    if (multi.length >= 2) {
      const multiTarget = _buildCablePointsGizmoTarget(multi);
      // V0.3.0.164 — 'all' mode so the group gets translate + ROTATE handles
      // (was translate-only). Rotate spins the whole subtree about the centroid.
      if (multiTarget) { gizmo.showForCableTarget(multiTarget, 'all'); return; }
    }
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
 * V0.3.0.119 — composite gizmo target for MULTIPLE selected cable points.
 * One world-oriented gizmo at the points' centroid; dragging fans the same world
 * delta out to every point (begin/apply/commit all → one undo). Only mesh-anchored
 * points contribute; returns null if fewer than 2 resolve.
 */
function _buildCablePointsGizmoTarget(points) {
  const T = window.THREE;
  const pts = (points || []).filter(p => {
    const n = _findCableNodeFor(p.cableId, p.nodeId);
    return n && n.anchorType === 'mesh';
  });
  if (pts.length < 2) return null;
  const worldOf = (cableId, nodeId) => {
    const cables = state.get('cables') || [];
    const n = cables.find(x => x.id === cableId)?.nodes?.find(x => x.id === nodeId);
    if (!n) return null;
    const r = resolveNodeWorldPosition(n, { makeVec3: (x, y, z) => new T.Vector3(x, y, z) });
    return r.pos ? new T.Vector3(r.pos[0], r.pos[1], r.pos[2]) : null;
  };
  return {
    isMulti: true,
    hasRotate: true,   // V0.3.0.164 — group rotate about the centroid
    getWorldPos() {
      const c = new T.Vector3(); let n = 0;
      for (const p of pts) { const w = worldOf(p.cableId, p.nodeId); if (w) { c.add(w); n++; } }
      return n ? c.multiplyScalar(1 / n) : null;
    },
    // V0.3.0.164 — LOCAL frame = the double-clicked group ROOT node's surface
    // orientation (per user spec). Falls back to world axes (identity) when no
    // root is set (e.g. a shift-built selection) or it can't be resolved. The
    // gizmo's WORLD toggle ignores this and uses world axes either way.
    getWorldQuat() {
      const root = state.get('selectedCableGroupRoot');
      if (!root) return new T.Quaternion();
      const cs = state.get('cables') || [];
      const n  = cs.find(x => x.id === root.cableId)?.nodes?.find(x => x.id === root.nodeId);
      if (!n || n.anchorType !== 'mesh' || !n.nodeId) return new T.Quaternion();
      const obj = state.get('nodeById')?.get?.(n.nodeId)?.object3d;
      if (!obj) return new T.Quaternion();
      const meshQ = new T.Quaternion(); obj.getWorldQuaternion(meshQ);
      if (Array.isArray(n.normalLocal) && n.normalLocal.length === 3) {
        const wn = new T.Vector3(n.normalLocal[0], n.normalLocal[1], n.normalLocal[2])
          .applyQuaternion(meshQ).normalize();
        return new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, 1), wn);
      }
      return meshQ;
    },
    beginMove() { actions.beginCablePointsMove(pts); },
    applyCumulativeDelta(worldDelta) { actions.applyCablePointsCumulativeDelta(worldDelta); },
    commitMove() { actions.commitCablePointsMove(); },
    beginRotate() { actions.beginCableGroupRotate(pts); },
    applyRotateAroundAxis(worldAxis, angle) { actions.applyCableGroupRotate(worldAxis, angle); },
    commitRotate() { actions.commitCableGroupRotate(); },
  };
}

/** Local helper: find a cable node ({cableId,nodeId}) without building a target. */
function _findCableNodeFor(cableId, nodeId) {
  const cables = state.get('cables') || [];
  return cables.find(c => c.id === cableId)?.nodes?.find(n => n.id === nodeId) || null;
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
  // Live plug check — the socket may be toggled while selected (V0.3.0.132).
  const _plugged = () => {
    const n = (state.get('cables') || []).find(c => c.id === cableId)?.nodes?.find(x => x.id === nodeId);
    return !!(n?.socket?.plugged && n.socket.connectTarget);
  };
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
      const cs0 = state.get('cables') || [];
      const n0  = cs0.find(x => x.id === cableId)?.nodes?.find(x => x.id === nodeId);
      const ctx = { makeVec3: (x, y, z) => new T.Vector3(x, y, z) };
      // V0.3.0.130 — PLUGGED: the socket sits on its target; the gizmo rides it
      // there (resolveNodeWorldPosition Tier 0), not its old unplugged back face.
      if (n0?.socket?.plugged && n0.socket.connectTarget) {
        const r = resolveNodeWorldPosition(n0, ctx);
        if (r.pos) return new T.Vector3(r.pos[0], r.pos[1], r.pos[2]);
      }
      const back = actions.socketBackFaceWorld(cableId, nodeId);
      if (back) return back;
      if (!n0) return null;
      const r = resolveNodeWorldPosition(n0, ctx);
      return r.pos ? new T.Vector3(r.pos[0], r.pos[1], r.pos[2]) : null;
    },
    getWorldQuat() {
      const cs = state.get('cables') || [];
      const c = cs.find(x => x.id === cableId);
      const n = c?.nodes?.find(x => x.id === nodeId);
      if (!n?.socket) return new T.Quaternion();
      // V0.3.0.130 — PLUGGED: align to the TARGET surface (matches the render's
      // _socketWorldQuat) so the rotate gizmo sits square on the connection.
      const ct = n.socket.plugged ? n.socket.connectTarget : null;
      if (ct?.nodeId) {
        const tObj = state.get('nodeById')?.get?.(ct.nodeId)?.object3d;
        if (tObj) {
          const tQ = new T.Quaternion(); tObj.getWorldQuaternion(tQ);
          if (Array.isArray(ct.localQuaternion) && ct.localQuaternion.length === 4) {
            return tQ.multiply(new T.Quaternion(
              ct.localQuaternion[0], ct.localQuaternion[1], ct.localQuaternion[2], ct.localQuaternion[3]));
          }
          if (Array.isArray(ct.normalLocal) && ct.normalLocal.length === 3) {
            const wn = new T.Vector3(ct.normalLocal[0], ct.normalLocal[1], ct.normalLocal[2])
              .applyQuaternion(tQ).normalize();
            return new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, 1), wn);
          }
        }
      }
      if (n.anchorType !== 'mesh' || !n.nodeId) return new T.Quaternion();
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
    // Translate: a PLUGGED socket nudges its CONNECTION POINT (fine-adjust on the
    // destination surface); otherwise it moves the host cable point. V0.3.0.132.
    beginMove() {
      if (_plugged()) actions.beginSocketConnectAdjust(cableId, nodeId);
      else            actions.beginCablePointMove(cableId, nodeId);
    },
    applyCumulativeDelta(worldDelta) {
      if (_plugged()) actions.applySocketConnectDelta(worldDelta);
      else            actions.applyCablePointCumulativeDelta(cableId, nodeId, worldDelta);
    },
    commitMove() {
      if (_plugged()) actions.commitSocketConnectAdjust();
      else            actions.commitCablePointMove(cableId, nodeId);
    },
    // Rotate: PLUGGED → spin the connection facing (connectTarget.localQuaternion);
    // else → the host-relative socket rotate. V0.3.0.133.
    beginRotate() {
      if (_plugged()) actions.beginSocketConnectRotate(cableId, nodeId);
      else            actions.beginCableSocketRotate(cableId, nodeId);
    },
    applyRotateAroundAxis(worldAxis, angle) {
      if (_plugged()) actions.applySocketConnectRotate(cableId, nodeId, worldAxis, angle);
      else            actions.applyCableSocketRotateAxisAngle(cableId, nodeId, worldAxis, angle);
    },
    commitRotate() {
      if (_plugged()) actions.commitSocketConnectRotate(cableId, nodeId);
      else            actions.commitCableSocketRotate(cableId, nodeId);
    },
  };
}
state.on('selection:change',            _syncGizmoToSelection);
state.on('change:treeData',             _syncGizmoToSelection);
state.on('change:selectedCablePoint',   _syncGizmoToSelection);
state.on('change:selectedCablePoints',  _syncGizmoToSelection);   // V0.3.0.119 multi-move
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
// V0.3.0.129: crosshair for socket connection-point pick mode.
state.on('change:cableSocketConnectPickingId', target => {
  canvas.style.cursor = target ? 'crosshair' : '';
  if (!target) _hideConnectArrow();   // V0.3.0.169 — drop the surface arrow when the pick ends/cancels
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

// V0.2.22.121: live box-select mode/op badge. Implemented as a DOM element that
// FOLLOWS the cursor — NOT the CSS `cursor` property. Browsers freeze the CSS
// cursor while a mouse button is held, so the old approach only showed the icon
// AFTER release. A positioned <div> updates live on every pointermove + modifier
// keydown/keyup.
//   Mode glyph (left):  ⿻ intersect / clipping (default) · ⿴ fully enclosed (Ctrl/⌘)
//   Op badge   (right):  + green = ADD (Shift) · − red = REMOVE (Alt; wins over Shift)
const _marqueeIcon = document.createElement('div');
_marqueeIcon.id = 'marquee-icon';
_marqueeIcon.style.cssText = [
  'position:fixed', 'pointer-events:none', 'display:none', 'z-index:1000',
  'filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))',
].join(';');
document.body.appendChild(_marqueeIcon);

function _marqueeIconSVG(windowMode, op) {
  // Original clearer glyphs (⿻ clipping / ⿴ fully-enclosed). These render fine in
  // a DOM <text> element (the real bug was the CSS cursor freezing mid-drag, not
  // glyph support — now fixed by drawing into this DOM element instead).
  const glyph = windowMode ? '⿴' : '⿻';
  const main  = `<text x="11" y="20" font-size="18" text-anchor="middle"`
    + ` fill="white" stroke="black" stroke-width="0.6"`
    + ` font-family="sans-serif" paint-order="stroke">${glyph}</text>`;
  const opEl = op
    ? `<text x="25" y="13" font-size="14" text-anchor="middle"`
      + ` fill="${op === '+' ? '#4ade80' : '#f87171'}" stroke="black" stroke-width="0.8"`
      + ` font-family="sans-serif" font-weight="bold" paint-order="stroke">${op}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="26" style="display:block">${main}${opEl}</svg>`;
}

let _savedCanvasCursor = '';
let _marqueeKeyHandler = null;
let _marqueeLastX = 0, _marqueeLastY = 0;

function _positionMarqueeIcon(x, y) {
  _marqueeLastX = x; _marqueeLastY = y;
  _marqueeIcon.style.left = (x + 16) + 'px';
  _marqueeIcon.style.top  = (y + 10) + 'px';
}

function _setMarqueeCursor(ctrl, shift, alt) {
  const op = alt ? '−' : (shift ? '+' : null);   // Alt wins over Shift (matches box-select)
  _marqueeIcon.innerHTML = _marqueeIconSVG(ctrl, op);
  _marqueeIcon.style.display = 'block';
}

function _beginMarqueeCursor(e) {
  if (canvas) { _savedCanvasCursor = canvas.style.cursor || ''; canvas.style.cursor = 'crosshair'; }
  _positionMarqueeIcon(e.clientX, e.clientY);
  _setMarqueeCursor(!!(e.ctrlKey || e.metaKey), !!e.shiftKey, !!e.altKey);
  // Update the badge when modifiers change mid-drag, even without mouse motion.
  _marqueeKeyHandler = (ev) => {
    _setMarqueeCursor(!!(ev.ctrlKey || ev.metaKey), !!ev.shiftKey, !!ev.altKey);
    _positionMarqueeIcon(_marqueeLastX, _marqueeLastY);
  };
  document.addEventListener('keydown', _marqueeKeyHandler, true);
  document.addEventListener('keyup',   _marqueeKeyHandler, true);
}

function _endMarqueeCursor() {
  if (canvas) canvas.style.cursor = _savedCanvasCursor;
  _savedCanvasCursor = '';
  _marqueeIcon.style.display = 'none';
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
  // A fresh press cancels any still-pending (deferred) ray-select popup from a
  // prior click — so starting an orbit/gizmo drag right after a click can't let
  // the popup surface mid-drag. (The current click schedules its own AFTER this.)
  _cancelDeferredRaySelect();
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
    const hitMeshId = hit?.object?.userData?.meshNodeId || null;
    if (hitMeshId === notePickMeshId) {
      actions.createNoteAtHit(notePickMeshId, hit);
    } else if (hitMeshId && state.get('nodeById')?.get(notePickMeshId)?.type === 'model') {
      // Model target (V0.3.0.94): a model has no single mesh, so anchor the
      // note to the actual child face that was clicked.
      actions.createNoteAtHit(hitMeshId, hit);
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

  // V0.2.22.61 — hardware place/align picker consumes the click. One pick:
  // surface hit → place/align there (axis = normal); empty → 50mm down the
  // camera centre-ray. Runs before gizmo so a face under a handle is still
  // pickable.
  if (state.get('hwPlaceActive')) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
    hardwarePlacePicker.onPointerDown(e.clientX, e.clientY);
    return;
  }

  // Follow-Object target pick — the click selects the object to follow.
  if (isFollowPicking()) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;
    const hit = sceneCore.pick(e.clientX, e.clientY);
    const targetId = hit?.object?.userData?.flatShapeNodeId ?? hit?.object?.userData?.meshNodeId ?? null;
    if (targetId) actionSetSelection(targetId);   // highlight the target for verification
    onFollowPickClick(targetId);
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

  // V0.3.0.129 — socket "set connection point" pick: raycast a destination mesh
  // face and store it as where the socket plugs in.
  const sockConnect = state.get('cableSocketConnectPickingId');
  if (sockConnect) {
    e.preventDefault();
    e.stopPropagation();
    _gizmoConsumed = true;   // V0.3.0.169 — suppress the follow-up click so no ray-select popup fires
    _hideConnectArrow();
    const hit = sceneCore.pick(e.clientX, e.clientY);
    if (hit) actions.applyCableSocketConnectTarget(hit);
    else     actions.cancelCableSocketConnectPick();
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

  // Gizmo gets first chance (pass initial Ctrl/⌘ state for Ctrl-drag global)
  if (gizmo.onPointerDown(e.clientX, e.clientY, e.ctrlKey || e.metaKey)) {
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

// V0.3.0.169 — surface-alignment arrow shown while picking a socket's CONNECTION
// POINT: a little arrow on the hovered face pointing along its outward normal, so
// you can SEE the surface the socket will align to before clicking. Renders on top.
let _connectArrow = null;
function _ensureConnectArrow() {
  const T = window.THREE;
  if (_connectArrow || !T) return _connectArrow;
  _connectArrow = new T.ArrowHelper(new T.Vector3(0, 0, 1), new T.Vector3(), 1, 0x22d3ee, 0.4, 0.28);
  _connectArrow.visible = false;
  for (const m of [_connectArrow.line, _connectArrow.cone]) {
    if (!m) continue;
    m.renderOrder = 9999;
    if (m.material) { m.material.depthTest = false; m.material.transparent = true; }
  }
  sceneCore.scene.add(_connectArrow);
  return _connectArrow;
}
function _hideConnectArrow() { if (_connectArrow) { _connectArrow.visible = false; sceneCore.requestRender?.(); } }
function _updateConnectArrow(clientX, clientY) {
  const T = window.THREE;
  const arrow = _ensureConnectArrow();
  if (!arrow) return;
  const hit = sceneCore.pick(clientX, clientY);
  if (!hit || !hit.point) { arrow.visible = false; sceneCore.requestRender?.(); return; }
  const n = new T.Vector3(0, 0, 1);
  if (hit.face && hit.object) n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
  arrow.position.copy(hit.point);
  arrow.setDirection(n);
  const dist = sceneCore.camera.position.distanceTo(hit.point);
  const len  = Math.max(dist * 0.09, 1);
  arrow.setLength(len, len * 0.32, len * 0.2);
  arrow.visible = true;
  sceneCore.requestRender?.();
}

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

    // V0.2.22.61 — hardware place/align hover crosshair.
    if (state.get('hwPlaceActive')) {
      hardwarePlacePicker.updateHover(e.clientX, e.clientY);
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
    // V0.3.0.169: socket connection-point pick — surface-aligned arrow on the
    // hovered face so the user sees what the socket will snap to before clicking.
    if (state.get('cableSocketConnectPickingId')) {
      _updateConnectArrow(e.clientX, e.clientY);
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
    _positionMarqueeIcon(e.clientX, e.clientY);
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
  // V0.3.0.75 — Alt+drag INVERT from a folder UNIT (with or without Ctrl). If only a
  // container is selected as a unit, expand it to all interior objects first, so the
  // drag removes from the FULL interior (matching the Alt-click invert) instead of
  // having nothing to remove. Drops the unit treatment → partial multi-select.
  if (doRemove && current.size === 1) {
    const _nbm = state.get('nodeById');
    const _u   = _nbm?.get([...current][0]);
    if (_u && state.get('selectedId') === _u.id
        && (_u.type === 'folder' || _u.type === 'model') && (_u.children || []).length) {
      current.clear();
      (function w(n) { if (materials.meshById?.has(n.id)) current.add(n.id); for (const c of (n.children || [])) w(c); })(_u);
    }
  }
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

// V0.3.0.169 — true effective visibility: a leaf mesh reads visible=true even when
// its CABLE GROUP is hidden (cables-render sets entry.group.visible, not the leaves),
// so the old `h.object.visible` filter let HIDDEN cables stay clickable (clicking
// empty space would grab one + pop open the Cables tab). Walk the parent chain.
function _visibleInWorld(obj) {
  for (let o = obj; o; o = o.parent) if (o.visible === false) return false;
  return true;
}

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
  const hits = ray.intersectObjects(meshes, false).filter(h => _visibleInWorld(h.object));
  if (!hits.length) return null;
  return {
    cableId: hits[0].object.userData.cableId,
    nodeId:  hits[0].object.userData.nodeId,
    object:  hits[0].object,
  };
}

/** World distance from point P to segment AB. */
function _distPointToSegment(p, a, b) {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-9)));
  return p.distanceTo(a.clone().add(ab.multiplyScalar(t)));
}
/**
 * V0.3.0.173 — find the node-pair whose straight segment is nearest a world point.
 * Flex/fillet cables render as ONE tube (no per-segment ids), so this recovers the
 * segment a tube hit belongs to → "Insert point" works in curve/fillet mode too.
 */
function _nearestCableSegment(cableId, point) {
  if (!window.THREE || !point) return null;
  const T = window.THREE;
  const nodes = (state.get('cables') || []).find(c => c.id === cableId)?.nodes || [];
  if (nodes.length < 2) return null;
  const ctx = { makeVec3: (x, y, z) => new T.Vector3(x, y, z) };
  const pos = nodes.map(n => { const r = resolveNodeWorldPosition(n, ctx); return r.pos ? new T.Vector3(r.pos[0], r.pos[1], r.pos[2]) : null; });
  let best = null, bestD = Infinity;
  for (let i = 0; i < pos.length - 1; i++) {
    if (!pos[i] || !pos[i + 1]) continue;
    const d = _distPointToSegment(point, pos[i], pos[i + 1]);
    if (d < bestD) { bestD = d; best = { fromNodeId: nodes[i].id, toNodeId: nodes[i + 1].id }; }
  }
  return best;
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
  const hits = ray.intersectObjects(meshes, false).filter(h => _visibleInWorld(h.object));
  if (!hits.length) return null;
  const obj = hits[0].object;
  let fromNodeId = obj.userData.fromNodeId;
  let toNodeId   = obj.userData.toNodeId;
  if (!fromNodeId && obj.userData.cableId) {
    // Tube (flex/fillet) — no per-segment ids; resolve the nearest node-pair.
    const seg = _nearestCableSegment(obj.userData.cableId, hits[0].point);
    if (seg) { fromNodeId = seg.fromNodeId; toNodeId = seg.toNodeId; }
  }
  return { cableId: obj.userData.cableId, fromNodeId, toNodeId };
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
  const hits = ray.intersectObjects(meshes, false).filter(h => _visibleInWorld(h.object));
  if (!hits.length) return null;
  return {
    cableId: hits[0].object.userData.cableId,
    nodeId:  hits[0].object.userData.nodeId,
  };
}

// ── Click: select object ─────────────────────────────────────────────────────

// V0.3.0.72 — progressive container selection. A double-click selects the
// immediate-parent container as a clean movable UNIT (set here by the dblclick
// handler); a 3rd rapid click on the SAME container escalates to "select all
// interior". Window-gated so a later unrelated click isn't mistaken for a triple.
let _lastUnitDbl = null;   // { container: id, t: performance.now() }

canvas.addEventListener('click', e => {
  if (e.button !== 0) return;
  // Suppress click after gizmo interaction or drag-select
  if (_gizmoConsumed) { _gizmoConsumed = false; return; }
  if (_justDragged)   { _justDragged   = false; return; }
  hideContextMenu();
  // Any new click cancels a still-pending ray-select popup from the PREVIOUS click
  // (so a double/triple never lets it surface). An already-open popup is handled by
  // the _raySelect branch below.
  _cancelDeferredRaySelect();

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
    // V0.3.0.119 — Shift adds/removes the point from the multi-select set so
    // several cable points can be moved together.
    actions.selectCablePoint(cableHit.cableId, cableHit.nodeId, e.shiftKey);
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
  // V0.3.0.120 — clicking a cable BODY (not a node/socket) selects that cable and
  // opens the Cables tab, so its node pick-markers appear and you can grab them.
  const segHitSel = _pickCableSegment(e.clientX, e.clientY);
  if (segHitSel?.cableId) {
    openCableTabForCable(segHitSel.cableId, e.shiftKey);   // V0.3.0.166 — Shift adds to the multi-cable set
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
      clearActiveCable();   // V0.3.0.149 — drop the cable's node orbs on click-out
    }
    return;
  }

  const meshNodeId = hit.object.userData?.meshNodeId;
  if (!meshNodeId) return;

  // V0.3.0.72/74 — TRIPLE-click escalation. A 3rd rapid click on the SAME container
  // the preceding double-click selected as a unit selects ALL its interior objects —
  // every LEAF object, recursing through sub-folders whether LOCKED or UNLOCKED (the
  // walk never stops at a lock; folder nodes themselves aren't selected, only objects
  // with a registered mesh). Plain clicks only (modifiers fall through to add/remove/
  // toggle). Consumes the click.
  if (_lastUnitDbl && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
      && (performance.now() - _lastUnitDbl.t) < 500) {
    const cont = getNearestContainerAncestor(root, meshNodeId);
    if (cont && cont.id === _lastUnitDbl.container) {
      _lastUnitDbl = null;
      const interior = new Set();
      (function walk(n) {
        if (materials.meshById?.has(n.id)) interior.add(n.id);
        for (const c of (n.children || [])) walk(c);   // recurse through everything, locks included
      })(cont);
      actionSetSelection(cont.id, interior);   // group gizmo + every interior object highlighted
      return;
    }
    _lastUnitDbl = null;
  }

  // Selecting a mesh clears any cable-point / socket selection — the
  // gizmo can only follow one target at a time.
  actions.clearCablePointSelection();
  actions.clearCableSocketSelection();
  clearActiveCable();   // V0.3.0.149 — and drop the selected cable's node orbs

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
      _scheduleRaySelect(allEntities, e.clientX, e.clientY, 'replace');
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
      _scheduleRaySelect(cands, e.clientX, e.clientY, 'add');
    }
  } else if (mode === 'remove') {
    // V0.3.0.75 — INVERT from a folder UNIT. When only a container (folder/model) is
    // selected as a unit (locked or unlocked) and you Alt-click an object inside it,
    // select every interior object EXCEPT the one clicked — instead of the old
    // "nothing to remove". Drops the unit outline/gizmo (it's a partial set now).
    const _unitId = (multi.size === 1) ? [...multi][0] : null;
    const _unit   = (_unitId && state.get('selectedId') === _unitId) ? nbm.get(_unitId) : null;
    const _unitIsContainer = _unit && (_unit.type === 'folder' || _unit.type === 'model') && (_unit.children || []).length;
    const _path = _unitIsContainer ? (getPathToNode(root, meshNodeId) || []) : [];
    const _uIdx = _unitIsContainer ? _path.indexOf(_unit.id) : -1;
    if (_uIdx >= 0) {
      const clickedObjId = (_uIdx + 1 < _path.length) ? _path[_uIdx + 1] : meshNodeId;
      const excluded = new Set();
      (function w(n) { if (!n) return; excluded.add(n.id); for (const c of (n.children || [])) w(c); })(nbm.get(clickedObjId));
      const rest = new Set();
      (function w(n) { if (materials.meshById?.has(n.id) && !excluded.has(n.id)) rest.add(n.id); for (const c of (n.children || [])) w(c); })(_unit);
      if (rest.size === 0) { actionClearSelection(); setStatus('Removed the only object — selection cleared.'); }
      else {
        actionSetSelection([...rest][0], rest);
        setStatus(`Selected ${rest.size} object${rest.size === 1 ? '' : 's'} — all but "${nbm.get(clickedObjId)?.name || 'one'}".`);
      }
      return;
    }
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
      _scheduleRaySelect(cands, e.clientX, e.clientY, 'remove');
    }
  } else { // toggle
    if (allEntities.length === 0) return;
    if (allEntities.length === 1) _commitToggle(allEntities[0]);
    else _scheduleRaySelect(allEntities, e.clientX, e.clientY, 'toggle');
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

  // A double-click must never leave the single-click ray-select popup up: kill any
  // pending (deferred) open AND any already-open popup.
  _cancelDeferredRaySelect();
  if (_raySelect) _raySelectCancel();

  // V0.3.0.164 — double-click a cable NODE → select its downstream subtree (the
  // node + all following nodes + branch descendants + their sockets) as one
  // movable/rotatable group. Runs before the tree guard (cables can exist with
  // no model loaded) and before mesh logic so it has priority on cable spheres.
  const cableDbl = _pickCablePoint(e.clientX, e.clientY);
  if (cableDbl) {
    actions.selectCableNodeSubtree(cableDbl.cableId, cableDbl.nodeId);
    return;
  }

  const root = state.get('treeData');
  const nbm  = state.get('nodeById');
  if (!root || !nbm) return;

  const hit = sceneCore.pick(e.clientX, e.clientY);
  if (!hit) return;

  const meshNodeId = hit.object.userData?.meshNodeId;
  if (!meshNodeId) return;

  // V0.3.0.74 — LOCKED folder: double-click TEMPORARILY UNLOCKS it so its objects
  // become individually selectable, and selects the top-level object inside (the
  // folder's direct child on the path to the click). The folder auto re-locks once
  // none of its objects stay selected (see _autoRelockTempUnlocked). Nested locked
  // folders stay locked — double-click again to step inside, recursively.
  const lockedAnc = actions.findLockedFolderAncestor(root, meshNodeId);
  if (lockedAnc) {
    const temp = new Set(state.get('tempUnlockFolderIds') || []);
    temp.add(lockedAnc.id);
    state.setState({ tempUnlockFolderIds: temp });
    const path = getPathToNode(root, meshNodeId) || [];
    const idx  = path.indexOf(lockedAnc.id);
    const childId = (idx >= 0 && idx + 1 < path.length) ? path[idx + 1] : meshNodeId;
    actionSetSelection(childId, new Set([childId]));
    setStatus(`🔓 "${lockedAnc.name || 'folder'}" temporarily unlocked — pick objects inside; click away to re-lock.`, 'info', 3500);
    _lastUnitDbl = null;   // not the unlocked-folder unit escalation
    return;
  }

  // V0.3.0.72 — UNLOCKED container: pop UP to the IMMEDIATE-PARENT container and
  // select it as a clean, MOVABLE UNIT. The multi-set is JUST the container id, so:
  //   • outline-pass wraps its descendant mass into ONE folder silhouette, and
  //   • applySelectionHighlight tints nothing (no mesh ids in the set) — no clutter.
  // The gizmo targets the container, so you can grab and move the whole group.
  // A 3rd rapid click (handled in the click listener) selects all the interior.
  const container = getNearestContainerAncestor(root, meshNodeId);
  if (!container) return;

  actionSetSelection(container.id, new Set([container.id]));
  _lastUnitDbl = { container: container.id, t: performance.now() };
});

// V0.3.0.74 — auto re-lock. A temporarily-unlocked folder reverts to locked the
// moment none of its objects (itself or any descendant) remain selected. Runs on
// every selection change; nested temp-unlocked folders re-lock independently.
function _autoRelockTempUnlocked() {
  const temp = state.get('tempUnlockFolderIds');
  if (!temp || temp.size === 0) return;
  const multi = state.get('multiSelectedIds') || new Set();
  const nbm   = state.get('nodeById');
  if (!nbm) return;
  const stillUnlocked = new Set();
  for (const fid of temp) {
    const folder = nbm.get(fid);
    if (!folder) continue;   // node gone → drop (effectively re-lock)
    let sel = false;
    (function walk(n) {
      if (sel) return;
      if (multi.has(n.id)) { sel = true; return; }
      for (const c of (n.children || [])) walk(c);
    })(folder);
    if (sel) stillUnlocked.add(fid);
  }
  if (stillUnlocked.size !== temp.size) state.setState({ tempUnlockFolderIds: stillUnlocked });
}
state.on('selection:change', _autoRelockTempUnlocked);

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

// V0.3.0.73 — the ray-select popup must appear on a SINGLE click only, never during
// a double/triple. We DEFER opening it by ~300ms; a follow-up click (cancel at the
// top of the click handler), the dblclick handler, or the triple branch cancels the
// pending open before it ever shows. Only ambiguous (2+ under cursor) clicks defer;
// plain single-object clicks select immediately as before.
const RAY_DEFER_MS = 300;
let _rayOpenTimer = null;
function _scheduleRaySelect(entities, x, y, mode = 'replace') {
  _cancelDeferredRaySelect();
  _rayOpenTimer = setTimeout(() => { _rayOpenTimer = null; _openRaySelect(entities, x, y, mode); }, RAY_DEFER_MS);
}
function _cancelDeferredRaySelect() {
  if (_rayOpenTimer) { clearTimeout(_rayOpenTimer); _rayOpenTimer = null; }
}

// V0.3.0.76 — modifier cursor badge. While Shift (+ / add), Alt (− / remove) or
// Ctrl-⌘ (± / toggle) is held and the cursor hovers the viewport with no button
// down, a small badge follows the cursor signalling what the NEXT click will do
// (it opens the ray-select picker if the click is ambiguous — Phase 1). Hidden the
// instant a button goes down (drag → the marquee icon takes over) and during any
// special pick mode. Purely visual — no effect on the actual selection logic.
const _modBadge = document.createElement('div');
_modBadge.id = 'mod-cursor-badge';
_modBadge.style.cssText = ['position:fixed', 'pointer-events:none', 'display:none',
  'z-index:1000', 'filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))'].join(';');
document.body.appendChild(_modBadge);
let _modPX = 0, _modPY = 0, _modInCanvas = false, _modBtnDown = false;
function _modBadgeSVG(op) {
  const col = op === '+' ? '#4ade80' : op === '−' ? '#f87171' : '#67e8f9';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" style="display:block">`
    + `<text x="11" y="16" font-size="17" text-anchor="middle" fill="${col}" stroke="black"`
    + ` stroke-width="0.9" font-family="sans-serif" font-weight="bold" paint-order="stroke">${op}</text></svg>`;
}
function _anyPickModeActive() {
  return !!(state.get('hwPlaceActive') || state.get('alignFolderId') || state.get('align3FolderId')
    || state.get('replaceModelPickingForId') || state.get('shapeDrawing')
    || state.get('pivotCenterPickingNodeId') || state.get('addPolygonFromFacePicking') || _raySelect);
}
function _refreshModBadge(alt, shift, ctrl) {
  const op = alt ? '−' : shift ? '+' : ctrl ? '±' : null;
  if (!op || !_modInCanvas || _modBtnDown || _anyPickModeActive()) { _modBadge.style.display = 'none'; return; }
  _modBadge.innerHTML = _modBadgeSVG(op);
  _modBadge.style.left = (_modPX + 16) + 'px';
  _modBadge.style.top  = (_modPY + 12) + 'px';
  _modBadge.style.display = 'block';
}
canvas.addEventListener('pointermove', e => {
  _modPX = e.clientX; _modPY = e.clientY; _modInCanvas = true; _modBtnDown = e.buttons !== 0;
  _refreshModBadge(e.altKey, e.shiftKey, e.ctrlKey || e.metaKey);
});
canvas.addEventListener('pointerenter', () => { _modInCanvas = true; });
canvas.addEventListener('pointerleave', () => { _modInCanvas = false; _modBadge.style.display = 'none'; });
canvas.addEventListener('pointerdown',  () => { _modBtnDown = true;  _modBadge.style.display = 'none'; });
window.addEventListener('pointerup',    e => { _modBtnDown = false; _refreshModBadge(e.altKey, e.shiftKey, e.ctrlKey || e.metaKey); });
const _modKeyRefresh = (e) => {
  if (e.key === 'Shift' || e.key === 'Alt' || e.key === 'Control' || e.key === 'Meta')
    _refreshModBadge(e.altKey, e.shiftKey, e.ctrlKey || e.metaKey);
};
document.addEventListener('keydown', _modKeyRefresh);
document.addEventListener('keyup',   _modKeyRefresh);

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
    const sockNode      = sockCable?.nodes?.find(n => n.id === socketHit.nodeId);
    const sockHasTarget = !!sockNode?.socket?.connectTarget;
    const items = [
      {
        label: '↺ Re-anchor socket…',
        action: () => actions.startCableSocketReanchor(socketHit.cableId, socketHit.nodeId),
      },
      { label: '─', disabled: true },
      {   // V0.3.0.129 — connection animation (Phase 1)
        label: sockHasTarget ? '🔌 Connection point (re-set)…' : '🔌 Set connection point…',
        action: () => actions.startCableSocketConnectPick(socketHit.cableId, socketHit.nodeId),
      },
      ...(sockHasTarget ? [{
        label: sockNode.socket.plugged ? '⏏ Unplug (this step)' : '🔗 Plug (this step)',
        action: () => actions.toggleSocketPlugged(socketHit.cableId, socketHit.nodeId),
      }] : []),
      {
        label: '🧭 Realign to zero',
        action: () => actions.resetSocketOrientation(socketHit.cableId, socketHit.nodeId),
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
    // V0.3.0.150 — insert a point at the segment's MIDPOINT, propagated to EVERY
    // step at that step's exact midpoint (steps.computeCableMidpointsPerStep).
    // No hit point needed.
    const items = [
      {
        label: '＋ Insert point (midpoint)',
        action: () => actions.insertCablePointMidpoint(segHit.cableId, segHit.fromNodeId),
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
      // Edit THIS instance directly — no second "click an instance" step.
      action: () => actions.editShapeInstance(node.id),
    });
    // Global Transform mode — HIDDEN V0.3.0.97 (redundant w/ multi-step + Paste
    // Transforms). Code kept for legacy; flip GLOBAL_XF_ENABLED to restore.
    const GLOBAL_XF_ENABLED = false;
    if (GLOBAL_XF_ENABLED) {
      items.push({
        label: inGlobal ? '✓ Global Transform (active)' : '🌐 Global Transform',
        action: () => inGlobal
          ? actions.commitGlobalEdit()
          : actions.enterGlobalEdit(node.id),
      });
    }
    items.push({
      label: '📋 Copy Transforms',
      action: () => actions.copyInstanceStepPose(node.id),
    });
    const stepSel = state.get('selectedStepIds');
    items.push({
      label: stepSel instanceof Set && stepSel.size >= 2
        ? `📌 Paste Transforms to ${stepSel.size} steps`
        : '📌 Paste Transforms',
      disabled: !actions.hasInstancePoseClipboard(),
      action: () => actions.pasteInstanceStepPose(node.id),
    });
    items.push({
      label: '🗑 Delete shape',
      action: () => actions.deleteFlatShapeInstance(node.id),
    });
    items.push({ label: '─', disabled: true });
  }

  // ── Parametric primitive (V0.2.22.94) — copy / paste / paste-instance / delete ──
  if (node?.type === 'primitive') {
    // Per-step pose clipboard (V0.3.0.94) — same as flatShape / hardware.
    items.push({
      label: '📋 Copy Transforms',
      action: () => actions.copyInstanceStepPose(node.id),
    });
    const _primSelStep = state.get('selectedStepIds')?.size ?? 0;
    items.push({
      label: _primSelStep >= 2 ? `📌 Paste Transforms to ${_primSelStep} steps` : '📌 Paste Transforms',
      disabled: !actions.hasInstancePoseClipboard(),
      action: () => actions.pasteInstanceStepPose(node.id),
    });
    items.push({ label: '─', disabled: true });
    items.push({ label: '📋 Copy', action: () => actions.copyPrimitive(node.id) });
    items.push({
      label:    '📄 Paste (independent)',
      disabled: !actions.hasPrimitiveClipboard(),
      action:   () => actions.pastePrimitive(),
    });
    items.push({
      label:    '🔗 Paste Instance (linked parameters)',
      disabled: !actions.hasPrimitiveClipboard(),
      action:   () => actions.pastePrimitiveInstance(),
    });
    items.push({ label: '🗑 Delete', action: () => actions.deletePrimitive(node.id) });
    items.push({ label: '─', disabled: true });
  }

  // V0.2.22.44 — hardware instance(s) in the viewport. Same menu shape
  // as the tree's right-click. Multi-aware on delete: if several
  // screws are selected and the right-clicked one is among them,
  // delete acts on the whole selection.
  const multiSet = (multiIds instanceof Set) ? multiIds : new Set();
  const allMultiHw = multiSet.size > 1
    && [...multiSet].every(id => nodeById?.get(id)?.type === 'hardwareInstance');
  if (node?.type === 'hardwareNut') {
    items.push({
      label: '📋 Copy Transforms',
      action: () => actions.copyInstanceStepPose(node.id),
    });
    items.push({
      label: '📌 Paste Transforms',
      disabled: !actions.hasInstancePoseClipboard(),
      action: () => actions.pasteInstanceStepPose(node.id),
    });
    items.push({
      label: '🗑 Delete nut',
      action: () => {
        import('./systems/hardware-actions.js').then(hw => hw.deleteNut(node.id));
      },
    });
    items.push({ label: '─', disabled: true });
  }
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
    items.push({
      label: '🔩 Add nut',
      action: () => {
        import('./systems/hardware-actions.js').then(hw => hw.createNutForBolt(node.id));
      },
    });
    // V0.2.22.61 — re-align a placed nut. Surface: click a face. 3-point:
    // snap 3 points around a circle. Same picker as the Hardware tab.
    items.push({
      label: '🎯 Place on surface…',
      action: () => hardwarePlacePicker.startAlignOnSurface(node.id),
    });
    items.push({
      label: '🎯 Align by 3 points…',
      action: () => hardwarePlacePicker.startAlignBy3Points(node.id),
    });
    // Copy / paste the active step's pose (translation + rotation +
    // visibility) — cross-instance allowed.
    items.push({
      label: '📋 Copy Transforms',
      action: () => actions.copyInstanceStepPose(node.id),
    });
    const _hwStepSel = state.get('selectedStepIds');
    items.push({
      label: _hwStepSel instanceof Set && _hwStepSel.size >= 2
        ? `📌 Paste Transforms to ${_hwStepSel.size} steps`
        : '📌 Paste Transforms',
      disabled: !actions.hasInstancePoseClipboard(),
      action: () => actions.pasteInstanceStepPose(node.id),
    });
    const isActor = node?.insertAnim?.enabled === true;
    items.push({
      label: isActor
        ? '🎬 Stop insertion animation'
        : '🎬 Animate insertion on this step',
      action: () => {
        import('./systems/hardware-actions.js').then(hw =>
          hw.setInsertActor([node.id], !isActor));
      },
    });
    if (isActor) {
      items.push({
        label: `📏 Adjust insertion animation…`,
        action: () => {
          showInsertAnimDialog(node?.insertAnim || {}, (patch) => {
            import('./systems/hardware-actions.js').then(hw =>
              hw.setInsertAnimParams([node.id], patch));
          });
        },
      });
    }
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

  // Reset — 3-way (V0.3.0.105, parity with the tree menu; was one combined item).
  if (isTransformable) {
    const _txIds = [...multiIds].filter(id => isTransformNode(nodeById?.get(id)));
    items.push({ label: '↺ Reset Move',           action: () => _txIds.forEach(id => actions.resetTransformField(id, 'move')) });
    items.push({ label: '↺ Reset Rotation',       action: () => _txIds.forEach(id => actions.resetTransformField(id, 'rotate')) });
    items.push({ label: '↺ Reset All Transforms', action: () => _txIds.forEach(id => actions.resetTransformField(id, 'all')) });
    items.push({ label: '─', disabled: true });
  }
  // Pivot tools (V0.3.0.108 — folders + created objects, parity with the tree). Copy /
  // Paste transfer the BLUE pivot; snap / 3-pt enter a viewport pick mode.
  if (multiIds.size === 1 && node && !node.archived && PIVOT_TYPES.has(node.type)) {
    const _hasBluePivot = node.pivotEnabled === true && (
      !isNearZero(node.pivotLocalOffset) || !isIdentityQuaternion(node.pivotLocalQuaternion)
    );
    items.push({ label: '⊕ Copy Pivot',  disabled: !_hasBluePivot,                 action: () => actions.copyPivot(node.id) });
    items.push({ label: '⊕ Paste Pivot', disabled: !actions.hasPivotClipboard(),    action: () => actions.pastePivot(node.id) });
    {
      const _selCount = (state.get('selectedStepIds') instanceof Set) ? state.get('selectedStepIds').size : 0;
      items.push({
        label: `⊕ Paste Pivot → selected steps${_selCount ? ` (${_selCount})` : ''}`,
        disabled: !actions.hasPivotClipboard() || _selCount === 0,
        action: () => {
          const res = actions.pastePivotToSelectedSteps(node.id);
          if (res?.ok) {
            let msg = `Pasted pivot to ${res.applied} step${res.applied === 1 ? '' : 's'}.`;
            if (res.skippedNoFolder) msg += ` ${res.skippedNoFolder} selected ${res.skippedNoFolder === 1 ? 'step lacks' : 'steps lack'} this folder — skipped.`;
            if (res.uncovered)       msg += ` ⚠ ${res.uncovered} other ${res.uncovered === 1 ? 'step still has' : 'steps still have'} a different pivot for this folder (possible swing).`;
            setStatus(msg, res.uncovered ? 'warn' : 'success', res.uncovered ? 6500 : 3500);
          } else {
            setStatus(`Couldn’t paste pivot: ${res?.error || 'unknown'}.`, 'warn', 3000);
          }
        },
      });
    }
    items.push({ label: '🧲 Snap Pivot to Surface…',     action: () => actions.startPivotSnapPicking(node.id) });
    items.push({ label: '⊕ Pivot Center via 3 Points…',  action: () => actions.startPivotCenterPicking(node.id) });
    items.push({ label: '─', disabled: true });
  }
  // Surface-match align (V0.3.0.71) — folders + primitives / models / shapes, now
  // in the VIEWPORT too (was tree-only). Acts on the selection; r-clicking a locked
  // folder promotes selection to the whole folder, so it aligns the unit.
  if (multiIds.size === 1 && node && !node.archived && folderAlignPicker.ALIGNABLE_TYPES.has(node.type)) {
    items.push({ label: '🎯 Align to surface…',               action: () => folderAlignPicker.start(node.id) });
    items.push({ label: '🎯 Align by 3 points (concentric)…', action: () => folderAlign3ptPicker.start(node.id) });
    items.push({ label: '─', disabled: true });
  }
  // Follow Object (V0.3.0.64) — A rides B's folder across steps.
  if (multiIds.size === 1 && node && !node.archived && node.type !== 'scene') {
    items.push(node.follow
      ? { label: '🔗 Stop following…', action: () => promptStopFollowing(node.id) }
      : { label: '🔗 Follow object…',  action: () => startFollowPick(node.id) });
    items.push({ label: '─', disabled: true });
  }
  if (hasSel) {
    const _isolated = actions.hasIsolateSnapshot();
    items.push({
      label: '👁 Visibility',
      disabled: _isolated,   // while isolated, the mask owns hide/show
      // Hybrid row (V0.3.0.92): click = standard hide/show this step; hover ▸ =
      // the across-steps submenu below.
      action: () => actions.toggleVisibility(multiIds),
      submenu: [
        { label: '👁 Hide / Show — this step', action: () => actions.toggleVisibility(multiIds) },
        { separator: true },
        { label: '◀ 👁 Show on all previous steps',  action: () => actions.setNodeVisibilityAcrossSteps(multiIds, true,  'previous') },
        { label: '◀ 🚫 Hide on all previous steps',  action: () => actions.setNodeVisibilityAcrossSteps(multiIds, false, 'previous') },
        { separator: true },
        { label: '▶ 👁 Show on all following steps', action: () => actions.setNodeVisibilityAcrossSteps(multiIds, true,  'following') },
        { label: '▶ 🚫 Hide on all following steps', action: () => actions.setNodeVisibilityAcrossSteps(multiIds, false, 'following') },
      ],
    });
    if (_isolated) {
      items.push({
        label: '🌐 Un-isolate',
        action: () => actions.unisolate(),
      });
    } else {
      items.push({
        label: '🔍 Isolate',
        action: () => actions.isolateSelection(),
      });
    }
    items.push({
      label: '📁→ Move to folder…',
      action: () => showMoveToFolderDialog([...multiIds]),
    });
    // Rename (V0.3.0.105, parity with the tree). renameNodeGlobal cascades the new
    // name into every step's snapshot, so it's correct for folders too.
    if (multiIds.size === 1 && node && node.type !== 'scene' && node.type !== 'note') {
      items.push({
        label: `✏ Rename "${(node.name || '').slice(0, 24)}"`,
        action: async () => {
          const name = await promptString('Rename', node.name || '');
          if (name) actions.renameNodeGlobal(node.id, name);
        },
      });
    }
    // Make transformable — RAW MESH only (V0.3.0.107). Everything else already
    // has its own gizmo; a bare loaded-model mesh is the one that needs wrapping.
    if (multiIds.size === 1 && node && !node.archived && node.type === 'mesh') {
      items.push({
        label: '🪄 Make transformable',
        action: () => actions.makeTransformable(node.id),
      });
    }
    items.push({
      label: '🎯 Fit to selection',
      action: () => _fitToSelection(multiIds),
    });
    // Show color — single mesh/flatShape selection only. Ambiguous which
    // color to show when multiple objects are selected, so the option
    // only appears when exactly one bindable node is selected.
    if (multiIds.size === 1 && (node?.type === 'mesh' || node?.type === 'flatShape' || node?.type === 'hardwareInstance' || node?.type === 'primitive')) {
      items.push({
        label: '🎨 Show color',
        action: () => showColorForNode(node.id),
      });
    }
    // ── Convert to Replace-Model (B.2-NEW.1) — HIDDEN V0.3.0.91 ──────────
    // Follow Object replaces this; menu entry disabled (action kept for legacy).
    // Flip CONVERT_TO_RM_ENABLED to re-enable.
    const CONVERT_TO_RM_ENABLED = false;
    if (CONVERT_TO_RM_ENABLED && multiIds.size === 1 && node && !node.archived &&
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

  // V0.3.0.96 — same canonical section order as the tree menu, so an object's
  // viewport r-click reads identically. Camera / Fit-view / Deselect sink to the
  // bottom (group 13). Mode menus (shape draw, cable routing) show earlier and
  // are NOT canonicalized.
  if (items.length) showContextMenu(canonicalizeMenuOrder(items), e.clientX, e.clientY);
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

// ── Global Mode visual indicator (V0.3.0.125) ──────────────────────────────
// Thick blue inset border + faint "GLOBAL MODE" watermark over the viewport
// while state.globalMode is on, plus a discoverable toggle button (Spacebar is
// the primary toggle). pointer-events:none on the overlay so it never blocks.
(function _setupGlobalModeIndicator() {
  const surf = _viewportSurfaceEl;
  if (!surf) return;
  if (getComputedStyle(surf).position === 'static') surf.style.position = 'relative';

  const ov = document.createElement('div');
  ov.id = 'global-mode-overlay';
  ov.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:55;display:none;'
    + 'box-shadow:inset 0 0 0 4px #2563eb, inset 0 0 30px 6px rgba(37,99,235,0.30);';
  const wm = document.createElement('div');
  wm.textContent = 'GLOBAL MODE';
  wm.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);'
    + 'font:800 64px/1 system-ui,sans-serif;letter-spacing:10px;color:#3b82f6;'
    + 'opacity:0.10;white-space:nowrap;user-select:none;';
  ov.appendChild(wm);
  surf.appendChild(ov);

  // V0.3.0.174 — removed the always-on top-right "🌐 Global" toggle button: it
  // sat over the header/overlay UI. Space toggles Global Mode and the blue
  // viewport overlay (below) is the on-screen indication.
  const sync = () => {
    ov.style.display = state.get('globalMode') ? 'block' : 'none';
  };
  state.on('change:globalMode', sync);
  sync();
})();
function _refreshSafeFrame() {
  if (!_safeFrameEl) return;
  const showFrame = state.get('export')?.showSafeFrame !== false;
  // Toggle visibility via the .show class (CSS sets display:block when present).
  // Also strip the legacy `hidden` attribute on first run.
  _safeFrameEl.removeAttribute('hidden');
  _safeFrameEl.classList.toggle('show', !!showFrame);
  // V0.3.0.86 — "Show safe frame" now drives the live OVERSCAN: on → zoom out so the
  // surrounding scene shows (dimmed by this overlay); off → tight WYSIWYG export frame.
  sceneCore.setOverscan(showFrame ? 1.3 : 1);
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
  // Space → GLOBAL MODE toggle (V0.3.0.125). Step-forward stays on ArrowRight
  // (Space was a redundant duplicate of it). Guarded by _isInputFocused above,
  // so Space still types normally in text fields.
  if (key === ' ')          { e.preventDefault(); actions.toggleGlobalMode(); return; }

  // ── Gizmo space toggle (Local ↔ World) ──────────────────────────────────
  if (key === 'l' || key === 'L') {
    e.preventDefault();
    gizmo.toggleSpace();
    return;
  }

  // ── Fit ──────────────────────────────────────────────────────────────────
  // F frames the SELECTION (the whole point of the shortcut). Only when nothing
  // is selected does it fall back to fitting the entire scene. V0.3.0.110 — was
  // always fitting rootGroup, so it zoomed out to the whole scene every time.
  if (key === 'f' || key === 'F') {
    e.preventDefault();
    if (!sceneCore.rootGroup || !window.THREE) return;
    const selSet = state.get('multiSelectedIds');
    const selId  = state.get('selectedId');
    const ids = (selSet instanceof Set && selSet.size) ? selSet
              : (selId ? new Set([selId]) : null);
    if (ids) {
      _fitToSelection(ids);
    } else {
      const box = new THREE.Box3().setFromObject(sceneCore.rootGroup);
      if (!box.isEmpty()) {
        sceneCore.animateCameraTo(sceneCore.fitStateForBox(box, 1.15), 800, 'smooth');
      }
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

  // V0.2.22.61 — hardware place/align picker keyboard (Esc cancels).
  if (state.get('hwPlaceActive')) {
    if (hardwarePlacePicker.onKeyDown(key)) {
      e.preventDefault();
      return;
    }
  }

  // Follow-Object target pick — Esc cancels.
  if (isFollowPicking() && key === 'Escape') {
    cancelFollowPick();
    e.preventDefault();
    return;
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
    // V0.3.0.129: socket connection-point pick — Esc cancels.
    if (state.get('cableSocketConnectPickingId')) {
      actions.cancelCableSocketConnectPick();
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
