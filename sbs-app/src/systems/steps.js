/**
 * SBS Step Browser — Step System
 * =================================
 * The step lifecycle: create, capture, activate, animate, sync.
 *
 * Core contract (from schema.js):
 *   A Step is a SELF-CONTAINED snapshot of the entire scene.
 *   It stores visibility, transforms, materials, camera, notes,
 *   screen items, cables. Steps don't reference each other.
 *   Moving a step in the timeline never breaks it.
 *   A transition is always calculable: diff(from.snapshot, to.snapshot).
 *
 * This module:
 *   - Captures the current scene into a step snapshot
 *   - Applies a step snapshot to the scene (with optional animation)
 *   - Manages the "dirty" sync loop (scene changes → step snapshot updated)
 *   - Handles step CRUD (create, duplicate, delete, reorder)
 *
 * Dependencies (all singletons imported):
 *   state   — single source of truth
 *   sceneCore — Three.js renderer / camera
 *   nodes, transforms — pure data helpers
 */

import state                        from '../core/state.js';
import sceneCore                    from '../core/scene.js';
import * as clock                   from '../core/clock.js';
import { rasterizeOverlay }         from './overlay.js';
import * as cablesSystem            from './cables.js';   // C1: per-step cable snapshot capture/apply
import * as cablesRender            from './cables-render.js';   // H1: cable phase animations
import * as overlaySystem           from './overlay.js';   // H2: overlay phase fade-in / fade-out
import { ensureFlatShapeObject3D }   from './flat-shapes.js'; // M1: 2D shapes in 3D — build mesh on demand
import { ensurePrimitiveObject3D }   from './primitives.js';  // V0.2.22.90: parametric primitives — build mesh on demand
import { ensureHardwareInstanceObject3D, ensureHardwareNutObject3D } from './hardware-templates.js'; // V0.2.22.38: procedural hardware — build mesh on demand
import { createStep, createEmptySnapshot } from '../core/schema.js';
import { parseAnimation, resolveAnimationString } from './animation.js';
import {
  stageInsertActors, runInsertReposition, runInsertPause, runInsertAssemble,
  showInsertTags, showInsertTrajectory,
  finalizeInsertActors, clearPreInstall, findActorsForStep,
  getStagedInsertTotalMs,
} from './hardware-insert-anim.js'; // V0.2.22.57 — screw stage/reposition/assemble + tag/trajectory
// V0.1.78 — narration overflow coordination. UI module exports the
// query helpers; cross-layer import is OK here (actions.js + overlay.js
// already cross the same boundary).
import { isNarrationPlaying, awaitNarrationEnd } from '../ui/steps-panel.js';
import {
  captureVisibilitySnapshot,
  applyVisibilitySnapshot,
  diffVisibility,
  captureParentMap,
  applyParentMap,
  buildNodeMap,
  flatten,
  serializeModelTree,
  computeEffectiveVisibility,
} from '../core/nodes.js';
import {
  captureAllTransforms,
  captureTransformSnapshot,
  applyAllTransformSnapshots,
  interpolateTransformSnapshot,
  applyTransformSnapshot,
  applyNodeTransformToObject3D,
  isTransformNode,
  lerpVec3,
  slerpQuaternion,
  quarterTurnsFromQuaternion,
} from '../core/transforms.js';
import { isIsolateActive, getIsolateKeepSet } from '../core/isolate-state.js';

// ── Easing helpers (mirror scene.js — no circular dependency) ─────────────
const easeSmooth = t => t * t * (3 - 2 * t);
const easeLinear = t => t;
const EASING = { smooth: easeSmooth, linear: easeLinear, instant: () => 1 };

// Sticky export-time flag: when true, every Bbox placeholder built by
// _createMeshPlaceholder spawns with visible=false. Set + cleared by
// StepManager.setPlaceholderBboxesVisible (called by video-export
// before/after the encode). Module-scoped because rebuildFromTreeSpec
// + _createMeshPlaceholder are top-level helpers, not class methods.
let _placeholdersHidden = false;


// ═══════════════════════════════════════════════════════════════════════════
//  STEP MANAGER
// ═══════════════════════════════════════════════════════════════════════════
class StepManager {
  constructor() {
    // Active object animation transitions
    this._objectTransitions = [];

    // Animation cancellation: increment to invalidate any in-flight animation
    this._animGeneration = 0;

    // Snap-to-final: track whether an animated transition is in progress and
    // what its target snapshot is so we can commit it before starting a new one.
    this._animRunning               = false;
    this._currentTargetSnap         = null;
    this._currentTargetWorldTransforms = null;  // stored so snapCurrentToFinal can position ALL nodes (incl. mesh)
    this._activationToken           = 0;   // incremented per activateStep call; prevents stale async from clearing flags

    // Transform-write gate: transforms (and tree structure) in a step snapshot
    // must ONLY be overwritten when an explicit user action commits them
    // (gizmo drag, reset, hierarchy move).  Normal dirty syncs (visibility,
    // material changes) must never touch transform/tree data.
    // Set to true by scheduleTransformSync(); cleared after each sync.
    this._syncIncludesTransforms = false;

    // Resolve fn for the objectTransitions-done promise (null when idle)
    this._onObjectTransitionsDone = null;

    // Dirty tracking — pending snapshot sync
    this._dirty   = false;
    this._syncTimer = null;

    // Maps shared with the rest of the app:
    this.object3dById = new Map();
    this.meshById     = new Map();

    // Materials system reference (set by materials.js on init)
    this._materials = null;

    // Tick hook unsubscribe functions
    this._tickUnsubscribe      = null;
    this._thumbTickUnsubscribe = null;
    this._lastThumbMs          = 0;
    this._thumbIntervalMs      = 200;   // 5 fps cap
  }

  // ─── Setup ───────────────────────────────────────────────────────────────
  /**
   * Register the materials system (avoids circular imports).
   * Called by materials.js during its initialisation.
   */
  setMaterialsSystem(mat) {
    this._materials = mat;
  }

  /** Start the sync timer and register the tick hook for animations. */
  init() {
    // Sync dirty snapshots every 500ms (matches POC rhythm)
    this._syncTimer = setInterval(() => {
      if (this._dirty) this.syncActiveStepNow();
    }, 500);

    // Register per-frame animation tick. While object/step transitions run,
    // keep the render-on-demand loop awake — object motion doesn't move the
    // camera, so the loop's camera check alone wouldn't notice it.
    this._tickUnsubscribe = sceneCore.addTickHook((nowMs) => {
      this._advanceObjectTransitions(nowMs);
      if (this._animRunning || (this._objectTransitions && this._objectTransitions.length)) {
        sceneCore.requestRender?.(150);
      }
    });

    // Thumbnail capture tick — 5 fps throttle, updates active step's preview.
    // Skip while the viewport is idle (frozen): nothing changed so the thumb is
    // still valid, and re-rendering it onto the live canvas would reintroduce
    // the flicker we just removed.
    this._thumbTickUnsubscribe = sceneCore.addTickHook((nowMs) => {
      if (sceneCore.isIdle?.()) return;
      if (nowMs - this._lastThumbMs < this._thumbIntervalMs) return;
      this.captureActiveThumbnail();
    });
  }

  dispose() {
    clearInterval(this._syncTimer);
    this._tickUnsubscribe?.();
    this._thumbTickUnsubscribe?.();
    this._objectTransitions = [];
  }

  /**
   * Capture the current viewport as a thumbnail for the active step.
   * Respects the 5-fps throttle unless `force` is true (used on step change
   * to guarantee the outgoing step's final state is saved).
   *
   * Updates step.thumbnail in place WITHOUT calling markDirty or state.setState
   * so the main timeline doesn't re-render on every frame. Emits 'step:thumb'
   * so the steps panel can update only the affected <img> surgically.
   *
   * @param {boolean} force   bypass the throttle
   */
  captureActiveThumbnail(force = false) {
    const now = performance.now();
    // Skip mid-transition captures — the 5fps throttle would otherwise
    // grab a frame in the middle of camera / object / color / opacity
    // tweens, leaving the saved thumbnail in a half-state (object midway
    // through a fly-in, color mid-lerp, etc.). The `force` path is taken
    // when the active step CHANGES (line ~993, after snapCurrentToFinal),
    // so it bypasses both this guard and the throttle.
    if (!force && this._animRunning) return;
    if (!force && now - this._lastThumbMs < this._thumbIntervalMs) return;
    const activeId = state.get('activeStepId');
    if (!activeId) return;
    this._lastThumbMs = now;

    // The Konva 2D per-step overlay (text/images) is composited on top so the
    // preview matches what the user sees. Header is INTENTIONALLY excluded —
    // it would dominate a 120×80 preview and repeat identically on every step.
    const extraLayers = (w, h) => [rasterizeOverlay({ width: w, height: h })];
    const store = (dataUrl) => {
      if (!dataUrl) return;
      const step = state.get('steps').find(s => s.id === activeId);
      if (!step) return;
      step.thumbnail = dataUrl;
      state.emit('step:thumb', { stepId: activeId, dataUrl });
    };

    if (force) {
      // Step CHANGED — capture the outgoing step's final frame synchronously,
      // before the new step's transition starts. This path does its OWN render
      // (selection visuals hidden first). It runs once per step change and any
      // 1-frame AO disturbance is masked by the transition that follows.
      this._materials?.setSelectionVisualsVisible(false);
      const dataUrl = sceneCore.captureThumbnail(120, 80, 0.55, {
        withoutOverlayScene: true, extraLayers,
      });
      this._materials?.setSelectionVisualsVisible(true);
      store(dataUrl);
    } else {
      // Periodic refresh during editing — REUSE the main render (no separate
      // render → no AO blink). Fulfilled after composer.render() but before the
      // outline/gizmo passes, so the preview stays clean.
      sceneCore.requestThumbnail(120, 80, 0.55, { extraLayers }).then(store);
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  SNAPSHOT CAPTURE
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Capture the COMPLETE current scene state into a Snapshot object.
   * This is what gets stored in step.snapshot.
   *
   * @returns {Snapshot}
   */
  captureSnapshot() {
    const { treeData, nodeById } = state.pick('treeData', 'nodeById');

    return {
      // Visibility
      visibility: treeData ? captureVisibilitySnapshot(treeData) : {},

      // Transforms (localOffset/quaternion — authoritative, always current)
      transforms: treeData ? captureAllTransforms(treeData) : {},

      // Full tree structure (replaces parentMap — mirrors v0.266 architecture).
      // Stored as a lightweight serialised tree: id, name, type, localVisible, children.
      // Transforms are NOT duplicated here — they live in snapshot.transforms.
      tree: treeData ? serializeModelTree(treeData) : null,

      // Material overrides
      materials: this._materials ? this._materials.captureSnapshot() : {},

      // Camera
      camera: sceneCore.getCameraState(),

      // Notes (deep-copy so they're independent)
      notes: JSON.parse(JSON.stringify(
        state.get('activeStepId')
          ? this._getActiveStep()?.snapshot?.notes ?? []
          : []
      )),

      // Per-step balloon-note panel offsets — { [noteId]: {x, y} }.
      // Captured every snapshot; on apply, the active step's overrides
      // are written back to the live tree before render. Step
      // transitions lerp from FROM-step's offsets to TO-step's offsets
      // for smooth note repositioning instead of vanish-and-reappear.
      notePanelOffsets: treeData ? _captureNotePanelOffsets(treeData) : {},

      // Screen items (deep-copy)
      screenItems: JSON.parse(JSON.stringify(
        state.get('activeStepId')
          ? this._getActiveStep()?.snapshot?.screenItems ?? []
          : []
      )),

      // Header items (deep-copy)
      headerItems: JSON.parse(JSON.stringify(
        state.get('activeStepId')
          ? this._getActiveStep()?.snapshot?.headerItems ?? []
          : []
      )),

      // Cables — per-step VARIABLE overrides only. Topology (id, mesh
      // anchor links, branch chain) lives project-global in state.cables.
      // captureCableStepSnapshot() extracts just the variable bits keyed
      // by cable id; applyCableStepSnapshot() merges them back. Step
      // snapshots without a cable id leave that cable's variables
      // untouched on apply (so a fresh cable stays visible across all
      // past steps until the user explicitly varies it). See
      // systems/cables.js.
      cables: cablesSystem.captureStepSnapshot(),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  APPLY SNAPSHOT TO SCENE
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Apply a step snapshot to the scene immediately (no animation).
   * Used during project load, step creation, and as the final frame
   * of an animated transition.
   *
   * @param {Snapshot} snapshot
   * @param {object}   opts  { suppressCamera: boolean }
   */
  applySnapshotInstant(snapshot, opts = {}) {
    if (!snapshot) return;
    let { nodeById } = state.pick('nodeById');

    // ── Tree arrangement (hierarchy rebuild) ────────────────────────────────
    // v0.266 approach: tear down all folder groups, rebuild from full tree spec.
    // Falls back to parentMap for old snapshots that pre-date the tree field.
    if (snapshot.tree) {
      const root = state.get('treeData');
      if (root) {
        // Clean up all stale folder Three.js groups first
        cleanupFolderGroups(root, this.object3dById);
        // Rebuild hierarchy from spec (folders recreated, meshes reparented)
        rebuildFromTreeSpec(snapshot.tree, nodeById, this.object3dById, null);
        nodeById = buildNodeMap(root);
        state.setState({ nodeById });
        state.emit('change:treeData', root);
      }
    } else if (snapshot.parentMap) {
      // Backward compat: old snapshots without tree field
      const root = state.get('treeData');
      applyParentMap(root, snapshot.parentMap);
      syncThreeJsHierarchy(snapshot.parentMap, nodeById, this.object3dById);
      nodeById = buildNodeMap(root);
      state.setState({ nodeById });
      state.emit('change:treeData', root);
    }

    // Visibility
    if (snapshot.visibility) {
      applyVisibilitySnapshot(nodeById, snapshot.visibility);
      applyAllVisibilityToScene(nodeById, this.object3dById);
    }

    // Transforms
    if (snapshot.transforms) {
      applyAllTransformSnapshots(nodeById, snapshot.transforms);
      applyAllTransformsToScene(nodeById, this.object3dById);
    }

    // Materials
    if (snapshot.materials && this._materials) {
      this._materials.applySnapshot(snapshot.materials);
    }

    // Per-step balloon-note panel offsets. Sparse map; only notes
    // present in the override get their panelOffset rewritten. Notes
    // not in the map keep whatever offset they had (which is fine —
    // their global default will show).
    if (snapshot.notePanelOffsets) {
      _applyNotePanelOffsets(nodeById, snapshot.notePanelOffsets);
    }

    // Camera
    if (snapshot.camera && !opts.suppressCamera) {
      sceneCore.applyCameraState(snapshot.camera);
    }

    // Sync placeholder outline colours with the step's material assignments.
    // Must run AFTER applySnapshot so meshColorAssignments are up to date.
    this._updatePlaceholderColors(nodeById);

    // Notes / screenItems / cables are applied by their own systems
    // (they listen to 'step:activate' on state). Clear any in-flight
    // note transition state — applySnapshotInstant means "snap, no
    // animation", so any pending lerp must be discarded.
    _clearNoteAnims(nodeById);

    // ── Self-heal stuck visibility state ────────────────────────────
    // _pendingShowingHidden holds meshes pre-snapped to opacity 0 so
    // they stay invisible while earlier phases run. After the phase
    // loop completes (or for an instant snap that didn't run a phase
    // loop), the set should be empty — but rare flow combinations
    // (multi-step edit cancelled mid-fade, applySnapshotInstant called
    // out-of-sequence) could leave stragglers. Those stragglers cause
    // the "ghost-hidden mesh" bug: obj.visible=true yet material.opacity
    // pinned at 0 every applyAll. We force-reset each lingering entry
    // whose mesh is meant to be visible per the just-applied snapshot.
    if (this._materials?._pendingShowingHidden?.size) {
      const outlineSettings = state.get('geometryOutline');
      const stuck = [...this._materials._pendingShowingHidden];
      for (const nodeId of stuck) {
        const obj = this.object3dById.get(nodeId);
        if (obj && obj.visible !== false) {
          this._materials._setNodeTransitionOpacity(nodeId, 1.0, outlineSettings, 0);
          this._materials._pendingShowingHidden.delete(nodeId);
        }
      }
    }

    // Isolate overlay: a kept mesh that is hidden on THIS step (but forced
    // visible by the mask) is not in the self-heal set above — re-assert full
    // opacity so it never renders as a ghost (obj.visible=true yet opacity 0)
    // as the user steps through while isolated.
    if (isIsolateActive()) this.snapMeshesOpaque();
  }

  /**
   * Force mesh TRANSITION opacity to fully opaque. Used when the isolate mask
   * flips on/off (and at the tail of an isolated instant-snap): a mesh the mask
   * reveals may still carry opacity 0 from an earlier fade-out, which would
   * render it invisible despite obj.visible=true.
   *
   * @param {boolean} [onlyVisible=true]  When true, only currently-visible
   *   meshes are snapped. Pass FALSE when leaving isolate for an export — the
   *   first exported step may reveal a mesh that was hidden (opacity 0) under
   *   the mask, so every mesh is reset; hidden ones at opacity 1 are harmless
   *   (not rendered) and any later fade-in re-snaps to 0 first.
   * Instant op — assumes no fade is mid-flight.
   */
  snapMeshesOpaque(onlyVisible = true) {
    if (!this._materials) return;
    const outlineSettings = state.get('geometryOutline');
    for (const [nodeId] of this._materials.meshById) {
      const obj = this.object3dById.get(nodeId);
      if (!obj) continue;
      if (onlyVisible && !obj.visible) continue;
      this._materials._setNodeTransitionOpacity(nodeId, 1.0, outlineSettings, 0);
    }
    if (this._materials._pendingShowingHidden) this._materials._pendingShowingHidden.clear();
  }

  /**
   * Update the outline colour of every bounding-box placeholder (missing mesh)
   * in the scene to match the current color-preset assignments.
   * Called after every applySnapshotInstant so placeholders always reflect the
   * step's color state.
   * @private
   */
  _updatePlaceholderColors(nodeById) {
    if (!nodeById) return;
    const presets     = state.get('colorPresets') || [];
    const presetMap   = new Map(presets.map(p => [p.id, p.color]));
    const assignments = this._materials?.meshColorAssignments ?? {};

    for (const [id, node] of nodeById) {
      if (!node.missing || node.type !== 'mesh') continue;
      const obj = this.object3dById.get(id);
      if (!obj?.isLineSegments) continue;
      // Prefer the step's explicit color assignment; fall back to the node's
      // saved colorPresetId; fall back to the default amber.
      const presetId = assignments[id] ?? node.colorPresetId ?? null;
      const color    = presetId ? (presetMap.get(presetId) ?? '#ff8c00') : '#ff8c00';
      obj.material.color.set(color);
    }
  }

  /**
   * Animate from the current scene state to a step snapshot.
   * If the step (or project) has an animation preset, runs phases sequentially.
   * Otherwise falls back to the previous simultaneous mode (global cam/obj durations).
   *
   * @param {Snapshot} toSnapshot
   * @param {object}   transition  step.transition settings
   * @returns {Promise}  resolves when all animations complete
   */
  async applySnapshotAnimated(toSnapshot, transition = {}) {
    if (typeof window !== 'undefined' && window.sbsDiag?.animTrace) {
      // eslint-disable-next-line no-console
      console.log(`[anim] applySnapshotAnimated start gen=${this._animGeneration + 1} t=${performance.now().toFixed(0)}`);
    }
    if (!toSnapshot) { this.applySnapshotInstant(toSnapshot); return; }

    // ── Cancel any in-flight animation ───────────────────────────────────
    this._animGeneration++;
    const myGen = this._animGeneration;
    // Resolve any dangling object-transitions promise so old awaits unblock
    if (this._onObjectTransitionsDone) {
      this._onObjectTransitionsDone();
      this._onObjectTransitionsDone = null;
    }
    this._objectTransitions = [];

    // ── Pre-warm: ensure all world matrices are current ──────────────────
    // Without this, getWorldPosition() returns stale values on first run.
    this._warmMatrices();

    const globalCam = state.get('cameraAnimDurationMs') ?? 1500;
    const globalObj = state.get('objectAnimDurationMs') ?? 1500;
    const easing    = transition.cameraEasing ?? 'smooth';
    const objEasing = transition.objectEasing ?? 'smooth';
    const easeFn    = EASING[objEasing] ?? easeSmooth;
    let { nodeById } = state.pick('nodeById');

    // ── Capture FROM world positions (before any hierarchy or transform change) ─
    this._warmMatrices();
    const fromWorldTransforms = captureWorldTransforms(state.get('treeData'), this.object3dById);

    // ── Rebuild target tree hierarchy (v0.266 approach) ──────────────────────
    // 1. Tear down all folder groups — they'll be recreated for the target step.
    // 2. Rebuild hierarchy from the target snapshot's tree spec.
    // 3. Apply target transforms so Three.js positions are correct for TO capture.
    // Falls back to parentMap for old snapshots without a tree field.
    const root = state.get('treeData');
    if (toSnapshot.tree && root) {
      cleanupFolderGroups(root, this.object3dById);
      rebuildFromTreeSpec(toSnapshot.tree, nodeById, this.object3dById, null);
      nodeById = buildNodeMap(root);
      state.setState({ nodeById });
      state.emit('change:treeData', root);
    } else if (toSnapshot.parentMap && root) {
      applyParentMap(root, toSnapshot.parentMap);
      nodeById = buildNodeMap(root);
      state.setState({ nodeById });
      syncThreeJsHierarchy(toSnapshot.parentMap, nodeById, this.object3dById);
      state.emit('change:treeData', root);
    }

    // ── Apply target transforms in the new hierarchy, then read TO world positions ─
    // Now that Three.js has the correct parent-child structure, applying transforms
    // gives us the exact world positions each object will occupy at the end of
    // the animation — no need for a save/restore cycle.
    if (toSnapshot.transforms) {
      applyAllTransformSnapshots(nodeById, toSnapshot.transforms);
      applyAllTransformsToScene(nodeById, this.object3dById);
    }
    this._warmMatrices();
    const toWorldTransforms = captureWorldTransforms(state.get('treeData'), this.object3dById);
    this._currentTargetWorldTransforms = toWorldTransforms;

    let changedNodeIds = diffWorldTransforms(fromWorldTransforms, toWorldTransforms);

    // Parent-id map keyed on the TARGET hierarchy (built post-rebuild).
    // Combined with the changedSet, this lets us detect each transition's
    // "parent is also animating?" status — the trigger for the local-
    // relative lerp branch that fixes the dip-through-surface bug
    // (children of rotating parents take the chord, not the arc, under
    // pure world-space lerp).
    const parentMap  = captureParentMap(state.get('treeData'));
    const changedSet = new Set(changedNodeIds);

    // Depth map (DFS order = parents before children — kept for transition sorting)
    const depthMap = {};
    flatten(state.get('treeData')).forEach((node, i) => { depthMap[node.id] = i; });

    // ── Capture FROM note state BEFORE _prepareVisibility flips visibility.
    // _scheduleNoteAnims (called later, after the simultaneous/phased
    // branch decides on durations) reads this snapshot to know what to
    // lerp FROM. If we waited until then, note.localVisible would
    // already be at the TO value and the fade would never run.
    const fromNoteState = _captureFromNoteState(state.get('treeData'));

    // Apply target visibility now and compute which meshes are hiding/showing.
    // Hiding meshes are kept obj.visible=true for dither-fade.
    // Showing meshes will be snapped to opacity=0 so they're invisible before
    // their visibility phase.
    const vis = this._prepareVisibility(nodeById, toSnapshot.visibility);
    // Pre-snap showing meshes to opacity 0 BEFORE any phase runs.
    // _prepareVisibility flips obj.visible=true on the showing set
    // immediately — without this snap, any phase that runs ahead of
    // 'visibility' (e.g. camera, color, obj) renders those meshes at
    // full opacity, producing a "threshold appear at first slot, then
    // invisible during visibility, then fade in" jitter when the
    // user puts color (or anything) before visibility in the string.
    // Clear the pending set first so a previous activate's leftovers
    // don't suppress visibility unrelated to the current transition.
    this._materials?._pendingShowingHidden?.clear?.();

    // ── Resolve animation preset (need it now to route shapes) ───────
    // AL1 / AL2 in the string resolve to the current values of the
    // global duration sliders. This means changing those sliders live-
    // updates every preset that uses the named-variable form, without
    // requiring the user to re-edit the strings.
    const animStr = resolveAnimationString(
      transition, state.get('animationPresets') || [],
    );
    const _resolveALToken = (tk) => {
      if (tk === 'AL1') return state.get('cameraAnimDurationMs') ?? 1500;
      if (tk === 'AL2') return state.get('objectAnimDurationMs')  ?? 1500;
      return 0;
    };
    const phases = animStr ? parseAnimation(animStr, _resolveALToken) : null;

    // 'shape' channel: threshold-snap visibility for flatShape nodes,
    // independent of mesh fade. When that channel exists in the
    // schedule, shapes go through it; otherwise they fold into the
    // regular visibility/mesh arrays so they fade like everything else.
    const hasShapePhase = !!phases && phases.some(p => p.types.includes('shape'));

    let hidingMeshIds, showingMeshIds, hidingShapeIds, showingShapeIds;
    if (hasShapePhase) {
      // shape(N) is in the string — shapes get their own fade slot,
      // independent of the mesh visibility channel. Both pre-snap to
      // opacity=0 so the fade-in starts from invisible.
      hidingMeshIds   = vis.hidingMeshIds;
      showingMeshIds  = vis.showingMeshIds;
      hidingShapeIds  = vis.hidingShapeIds;
      showingShapeIds = vis.showingShapeIds;
    } else {
      hidingMeshIds   = [...vis.hidingMeshIds,  ...vis.hidingShapeIds];
      showingMeshIds  = [...vis.showingMeshIds, ...vis.showingShapeIds];
      hidingShapeIds  = [];
      showingShapeIds = [];
    }

    // V0.2.22.53 — STAGE insertion actors. The insert effect fully owns
    // each flagged screw's reveal + motion: build the exploded transient
    // pieces at THIS step's final pose now, hide the merged mesh, and
    // exclude the actor from the obj + visibility channels. The pieces
    // sit exploded; the visibility phase fades them in (at the exploded
    // position) and the insert phase assembles them. This is what
    // prevents both the appear-at-final-then-jump AND the threshold pop.
    const _insertActors = findActorsForStep(state.get('activeStepId'));
    const _stagedActorIds = _insertActors.length
      ? stageInsertActors(_insertActors, {
          appearingIdSet: new Set(showingMeshIds),
          fromWorld:      fromWorldTransforms,
          toWorld:        toWorldTransforms,
        })
      : new Set();
    if (_stagedActorIds.size) {
      // V0.2.22.56 — keep insertion actors IN the colour + visibility
      // channels: the transient pieces share the live material and
      // follow those animations (colour transition, screen-door fade),
      // respecting their time-block order. Only exclude from the OBJ
      // channel — the screw's position is driven by the insert
      // reposition/assemble, not the prev→target lerp. (The insert
      // effect re-asserts the merged mesh hidden each tick so the
      // visibility channel can't double-render it.)
      changedNodeIds = changedNodeIds.filter(id => !_stagedActorIds.has(id));
    }

    // All showing items (meshes + shapes) pre-snap to opacity=0 so the
    // fade-in actually starts from invisible. Without this, anything
    // appearing this step would flash at full alpha for a frame.
    const allShowingPreSnap = [...showingMeshIds, ...showingShapeIds];
    if (allShowingPreSnap.length && this._materials?.snapShowingToZero) {
      this._materials.snapShowingToZero(allShowingPreSnap);
    }

    // ── Place objects at FROM world positions (v0.266 approach) ─────────────
    // Objects stay in their TARGET hierarchy (no detach). We use world→local
    // math to set each transform node to its FROM world position within the
    // new parent's coordinate space. Parents are processed before children
    // (DFS order from flatten) so parent matrices are current when children
    // compute their local positions.
    this._warmMatrices();
    flatten(state.get('treeData')).forEach(node => {
      if (!isAnimatableNode(node)) return;
      const obj = this.object3dById.get(node.id);
      if (!obj) return;
      const wt = fromWorldTransforms[node.id];
      if (!wt) return;  // new nodes (e.g. folder that didn't exist in FROM): keep at target position
      const wasVisible = obj.visible;
      _setWorldTransformOnObject(obj, wt.position, wt.quaternion);
      obj.visible = wasVisible;
    });

    // animStr/phases already resolved above (needed for shape-phase routing).

    let cameraHandled = false;

    if (phases) {
      // ── PHASED MODE ───────────────────────────────────────────────────
      // Showing items (meshes + shapes) re-snap to opacity=0 so any
      // phase that runs ahead of visibility / shape doesn't reveal
      // them at full alpha.
      if (allShowingPreSnap.length) {
        this._materials?.snapShowingToZero(allShowingPreSnap);
      }

      // Schedule note panel-offset lerp + opacity fade across the entire
      // phased animation. Move/offset always rides the object-duration
      // window. FADE timing depends on whether the preset has a `notes`
      // slot: when present, defer fade — the notes phase handler stamps
      // real fadeStartMs/Dur when its slot fires. Without this defer,
      // the obj-duration fade would complete (and clear _anim) BEFORE
      // the notes phase fires later in the sequence, leaving the
      // override as a no-op (the actual bug we saw).
      const phasedStartMs = clock.now();
      const hasNotesPhase = phases.some(p => p.types.includes('notes'));
      _scheduleNoteAnims(
        state.get('treeData'), fromNoteState, toSnapshot,
        phasedStartMs, globalObj, easeFn,
        { deferFade: hasNotesPhase },
      );

      cameraHandled = await this._runPhasedAnimation(toSnapshot, phases, {
        changedNodeIds, fromWorldTransforms, toWorldTransforms, depthMap,
        parentMap, changedSet,
        hidingMeshIds, showingMeshIds,
        hidingShapeIds, showingShapeIds,
        stagedActorIds: _stagedActorIds,
        easing, easeFn, myGen,
      });
    } else {
      // ── SIMULTANEOUS MODE (legacy / no preset) ────────────────────────
      cameraHandled = true;
      const useOverride  = transition.durationOverride === true;
      const cameraDur    = useOverride ? (transition.cameraDurationMs ?? globalCam) : globalCam;
      const objDur       = useOverride ? (transition.objectDurationMs  ?? globalObj) : globalObj;

      // Camera
      const cameraP = toSnapshot.camera
        ? sceneCore.animateCameraTo(toSnapshot.camera, cameraDur, easing)
        : Promise.resolve();

      // Object transforms — world-space lerp (v0.266: objects stay in target hierarchy).
      // Children of an animating parent get an `inheritParentId + localFrom + localTo`
      // bundle so their per-frame lerp runs in PARENT-LOCAL space (arc-following);
      // children of static parents with an offset pivot get a `pivotData` bundle
      // so they arc around their pivot (not chord-cut through it).
      this._objectTransitions = [];
      const startMs = clock.now();
      for (const nodeId of changedNodeIds) {
        const worldFrom = fromWorldTransforms[nodeId];
        const worldTo   = toWorldTransforms[nodeId];
        if (!worldFrom || !worldTo) continue;
        const inheritExtras = _buildInheritExtras(
          nodeId, worldFrom, worldTo,
          parentMap, changedSet, fromWorldTransforms, toWorldTransforms,
        );
        // Pivot data only when NOT inheriting from parent — the combined
        // case (animating parent + pivoted child) is a known limitation
        // for now (todo: pivot-aware lerp in parent-local frame).
        const pivotExtras = inheritExtras.inheritParentId
          ? {}
          : _buildPivotExtras(worldFrom, worldTo);
        this._objectTransitions.push({
          nodeId, worldFrom, worldTo, startMs,
          durationMs: objDur, easeFn, isWorld: true,
          depth: depthMap[nodeId] ?? 0,
          ...inheritExtras,
          ...pivotExtras,
        });
      }
      // Sort parents before children so world→local math uses correct parent matrices
      this._objectTransitions.sort((a, b) => a.depth - b.depth);

      // Visibility fades (BEFORE beginColorTransition)
      if (hidingMeshIds.length || showingMeshIds.length) {
        this._materials?.beginVisibilityTransitions(
          hidingMeshIds, showingMeshIds, objDur, easeFn,
        );
      }

      // Note transitions — per-step panelOffset lerp + opacity fade.
      // fromNoteState was captured BEFORE _prepareVisibility flipped
      // note.localVisible to its target, so we know the actual FROM
      // visibility for each note. _scheduleNoteAnims sets _anim on
      // every note that needs to change; notes-render lerps each
      // frame and clears _anim when alpha hits 1.
      _scheduleNoteAnims(state.get('treeData'), fromNoteState, toSnapshot, startMs, objDur, easeFn);

      // Color/material transition
      if (toSnapshot.materials && this._materials) {
        this._materials.beginColorTransition(toSnapshot.materials, objDur, easeFn);
      }

      // Cable transitions — opacity + colour lerp. Without this kick-off
      // cables threshold-pop in simultaneous mode (the regression the
      // user hit when no animation preset was set). Result is awaited
      // alongside cameraP / objectP below so the phase completes when
      // all channels finish.
      const cableSimP = new Promise(resolve => {
        cablesRender.beginCableTransitions(toSnapshot.cables, objDur, easeFn, resolve);
      });

      // Overlay crossfade — default to the sustained variant (no flicker
      // on items shared between steps). Same rationale as cables above.
      const overlaySimP = new Promise(resolve => {
        overlaySystem.beginOverlaySustainedFade(objDur, easeFn, resolve);
      });

      const objectP = new Promise(resolve => {
        if (!this._objectTransitions.length) { resolve(); return; }
        this._onObjectTransitionsDone = resolve;
      });

      // V0.2.22.56 — insertion in SIMULTANEOUS (non-phased) mode. Pieces
      // were staged before this branch. Reposition (prev→staging) runs
      // first, then assemble (staging→final). Colour + fade ride the
      // shared material via the standard channels (already running).
      // V0.2.22.57 — tag + trajectory shown up front (no phase ordering).
      let insertSimP = Promise.resolve();
      if (_stagedActorIds.size) {
        showInsertTags();
        showInsertTrajectory();
        insertSimP = runInsertReposition(easeFn)
          .then(() => runInsertPause())
          .then(() => runInsertAssemble(objDur, easeFn));
      }

      // OFFLINE-EXPORT FIX: in simultaneous mode (no animation preset),
      // cameraP and objectP both advance via tick hooks. In offline
      // mode, ticks only fire from inside _syntheticSleep — so without
      // a _sleep here, no ticks fire and the await hangs forever.
      // Phased mode escapes this because each phase already calls
      // _sleep(durationMs) explicitly. Padding the await with a sleep
      // for the longest phase ensures synthetic ticks drive the
      // transitions to completion in offline mode, and is a no-op in
      // realtime mode (rAF still drives ticks; sleep just waits).
      // The insert runs reposition→pause→assemble SEQUENTIALLY (see insertSimP
      // above), so its total can far exceed objDur. Offline export only fires
      // ticks while _sleep runs, so the sleep must span the WHOLE insert or
      // insertSimP never resolves and the export hangs (the bug the user hit).
      const insertTotalDur = _stagedActorIds.size ? getStagedInsertTotalMs(objDur) : 0;
      const maxDur = Math.max(cameraDur, objDur, insertTotalDur);
      await Promise.all([cameraP, objectP, cableSimP, overlaySimP, insertSimP, _sleep(maxDur)]);
    }

    // ── Guard: if a newer animation started while we awaited, bail out ──
    if (this._animGeneration !== myGen) return;

    // V0.2.22.53 — tear down insertion staging: dispose transient pieces,
    // restore each merged mesh visible at its final pose. The snap below
    // then settles exact final transform/visibility. (On a bail above, the
    // NEXT activation's stageInsertActors disposes the old staging.)
    if (_stagedActorIds.size) finalizeInsertActors();

    // Safety-net: any note with a still-deferred fade (fadeStartMs===Infinity)
    // means the `notes` slot never fired during the phase loop (e.g. the
    // string included `notes` but the loop ended without reaching it for
    // some unusual reason). Drop those records so applySnapshotInstant's
    // final visibility snap is what the renderer reads.
    const _root = state.get('treeData');
    if (_root) {
      _walkNotes(_root, note => {
        if (note._anim && note._anim.fadeStartMs === Infinity) {
          delete note._anim;
        }
      });
    }

    // ── Final: snap to exact target state ─────────────────────────────
    // V0.2.22.17 Stage 2 — instrument the snap. With Stage 1's per-frame
    // data writes, the snap SHOULD be a visual no-op for object transforms
    // because animation's last tick at alpha=1 already wrote the exact
    // target into node.localOffset / localQuaternion. Compare pre-snap
    // node values to snapshot.transforms — log any node whose stored
    // delta differs by more than 1e-4. Gated behind
    // window.sbsDiag.seamCheck so it's quiet by default.
    if (typeof window !== 'undefined' && window.sbsDiag?.seamCheck
        && toSnapshot.transforms) {
      const nb = state.get('nodeById');
      const drifts = [];
      for (const [id, target] of Object.entries(toSnapshot.transforms)) {
        const live = nb?.get(id);
        if (!live || !isTransformNode(live)) continue;
        const lo = live.localOffset      || [0, 0, 0];
        const lq = live.localQuaternion  || [0, 0, 0, 1];
        const to = target.localOffset    || [0, 0, 0];
        const tq = target.localQuaternion || [0, 0, 0, 1];
        const dPos = Math.max(Math.abs(lo[0]-to[0]), Math.abs(lo[1]-to[1]), Math.abs(lo[2]-to[2]));
        const dQuat = Math.max(Math.abs(lq[0]-tq[0]), Math.abs(lq[1]-tq[1]), Math.abs(lq[2]-tq[2]), Math.abs(lq[3]-tq[3]));
        if (dPos > 1e-4 || dQuat > 1e-4) {
          drifts.push({ id, name: live.name, dPos: dPos.toFixed(5), dQuat: dQuat.toFixed(5) });
        }
      }
      if (drifts.length) {
        console.warn(`[seam] drift on ${drifts.length} node(s) at end of animation:`, drifts);
      } else {
        console.log('[seam] clean — no drift detected this transition.');
      }
    }
    this.applySnapshotInstant(toSnapshot, { suppressCamera: cameraHandled });
  }

  /**
   * Force Three.js to recompute all world matrices.
   * Called before reading getWorldPosition() — without this, matrices are
   * stale on first run and world-position calculations return wrong values.
   * @private
   */
  _warmMatrices() {
    const root3d = sceneCore.rootGroup;
    if (root3d) root3d.updateMatrixWorld(true);
  }

  /**
   * Silently pre-warm the transition to a given step without rendering.
   * Ensures matrices are ready so the NEXT real transition starts cleanly.
   * Called discreetly after each step activation.
   * @private
   */
  _prewarm(nextStepId) {
    if (!nextStepId) return;
    // Defer to avoid blocking the current activation render
    setTimeout(() => {
      this._warmMatrices();
      // Touch world positions of all transform nodes to prime the cache
      const THREE = window.THREE;
      if (!THREE) return;
      for (const [, obj] of this.object3dById) {
        obj.getWorldPosition(new THREE.Vector3());
      }
    }, 0);
  }

  /**
   * Apply target visibility to the scene and compute which mesh nodes changed.
   * Hiding meshes have obj.visible kept=true (for fade-out).
   * Returns arrays of hiding/showing nodeIds for the animation system.
   *
   * @private
   */
  _prepareVisibility(nodeById, visibilitySnapshot) {
    const hidingMeshIds   = [];
    const showingMeshIds  = [];
    const hidingShapeIds  = [];
    const showingShapeIds = [];
    if (!visibilitySnapshot || !this._materials) {
      return { hidingMeshIds, showingMeshIds, hidingShapeIds, showingShapeIds };
    }

    // Record current Three.js visibility
    const prevMeshVis = new Map();
    for (const [nodeId] of this._materials.meshById) {
      const obj = this.object3dById.get(nodeId);
      prevMeshVis.set(nodeId, obj ? obj.visible : false);
    }

    // Apply target visibility to data model + Three.js objects
    applyVisibilitySnapshot(nodeById, visibilitySnapshot);
    applyAllVisibilityToScene(nodeById, this.object3dById);

    // Compute which meshes changed effective visibility. flatShape nodes
    // get partitioned out so the caller can route them to the dedicated
    // 'shape' threshold-snap channel if the animation string opted into
    // it. When there's no 'shape' slot the caller folds them back into
    // the regular hiding/showing mesh arrays — legacy fade behaviour.
    for (const [nodeId] of this._materials.meshById) {
      const prevVis = prevMeshVis.get(nodeId) ?? false;
      const obj     = this.object3dById.get(nodeId);
      const newVis  = obj ? obj.visible : false;
      const node    = nodeById?.get(nodeId);
      const isShape = node?.type === 'flatShape';
      if (prevVis && !newVis) {
        if (isShape) hidingShapeIds.push(nodeId);
        else         hidingMeshIds.push(nodeId);
        if (obj) obj.visible = true;   // keep visible — fade/snap will hide it
      } else if (!prevVis && newVis) {
        if (isShape) showingShapeIds.push(nodeId);
        else         showingMeshIds.push(nodeId);
      }
    }

    // ── Folder-cascade fade fix (V0.1.74) ─────────────────────────────
    // Three.js skips the entire subtree of any object whose `.visible =
    // false`. So when a folder goes visible→hidden in a step transition,
    // `applyAllVisibilityToScene` set folder.obj.visible = false, the
    // mesh-hide loop above detected its descendants as "hiding" and
    // restored mesh.obj.visible = true (correct) — but the folder is
    // still invisible, the renderer skips the subtree, and the fade
    // shader uniforms animate to no effect (instant snap visually).
    //
    // Fix: walk each hiding mesh's Three.js ancestor chain; any ancestor
    // that's currently invisible gets restored to visible TEMPORARILY
    // so the fade actually renders. We track those ancestors and re-
    // cascade visibility once all fade transitions complete (see
    // _advanceObjectTransitions below).
    this._fadeRestoredAncestors = this._fadeRestoredAncestors || new Set();
    const allHiding = [...hidingMeshIds, ...hidingShapeIds];
    if (allHiding.length) {
      for (const meshId of allHiding) {
        const obj = this.object3dById.get(meshId);
        if (!obj) continue;
        let p = obj.parent;
        while (p && p !== sceneCore.rootGroup) {
          if (p.visible === false) {
            p.visible = true;
            this._fadeRestoredAncestors.add(p);
          }
          p = p.parent;
        }
      }
    }

    return { hidingMeshIds, showingMeshIds, hidingShapeIds, showingShapeIds };
  }

  /**
   * Run phases sequentially. Each phase starts its subset of animations and
   * waits for phaseDuration before advancing to the next phase.
   * Returns true (camera was handled by a phase) or false.
   *
   * @private
   */
  async _runPhasedAnimation(toSnapshot, phases, opts) {
    const {
      changedNodeIds, fromWorldTransforms, toWorldTransforms, depthMap,
      parentMap = {}, changedSet = new Set(),
      hidingMeshIds, showingMeshIds,
      hidingShapeIds = [], showingShapeIds = [],
      stagedActorIds = new Set(),
      easing, easeFn, myGen,
    } = opts;

    let cameraHandled    = false;
    let objHandled       = false;
    let colorHandled     = false;
    let visHandled       = false;
    let cableHandled     = false;
    let overlayHandled   = false;
    let shapeHandled     = false;
    let narrationHandled = false;
    let notesHandled     = false;
    let insertHandled    = false;   // V0.2.22.52 — hardware explode→assemble
    // `pause` slots don't need a handled flag — they're idempotent dwells
    // (the await Promise.all([_sleep(durationMs), ...]) at the end of the
    // phase loop already enforces the time).
    // `notesHandled` gates the FADE channel; note movement still rides obj.

    for (const phase of phases) {
      const { types, durationMs } = phase;
      const phasePromises = [];
      // Sleep span for this phase. The insert handler extends it to cover the
      // full reposition+pause+assemble chain, so offline export fires synthetic
      // ticks for the whole insert (else insertSimP hangs — same bug as the
      // simultaneous path).
      let _sleepMs = durationMs;

      // H2: overlay phase — proper crossfade. Old content moves to a
      // ghost layer + fades out while the new step's content loads
      // into the main layer + fades in, both over the slot duration.
      // Without a 'overlay' slot, the post-anim step:applied flow
      // snaps content (no fade), preserving legacy behaviour.
      //
      // `overlays` (sustained) is the same machinery but a two-phase
      // ramp that keeps shared items at 100% visible alpha — no
      // flicker on shapes/text/images present in both steps. If both
      // appear in the same phase, sustained wins.
      if ((types.includes('overlay') || types.includes('overlays')) && !overlayHandled) {
        overlayHandled = true;
        const sustained = types.includes('overlays');
        phasePromises.push(new Promise(resolve => {
          if (sustained) overlaySystem.beginOverlaySustainedFade(durationMs, easeFn, resolve);
          else           overlaySystem.beginOverlayCrossfade   (durationMs, easeFn, resolve);
        }));
        // V0.2.22.57 — spec-name tags appear at the overlay block.
        if (stagedActorIds.size) showInsertTags();
      }

      // Camera
      if (types.includes('camera') && !cameraHandled && toSnapshot.camera) {
        cameraHandled = true;
        phasePromises.push(sceneCore.animateCameraTo(toSnapshot.camera, durationMs, easing));
      }

      // Object transforms — world-space lerp (v0.266: objects stay in target hierarchy).
      // See `_buildInheritExtras` — children of animating parents lerp in
      // parent-local space (arc-following). `_buildPivotExtras` adds the
      // pivot-aware variant so an offset pivot stays put during rotation.
      if (types.includes('obj') && !objHandled && changedNodeIds.length) {
        objHandled = true;
        if (typeof window !== 'undefined' && window.sbsDiag?.animTrace) {
          // eslint-disable-next-line no-console
          console.log(`[anim] OBJ phase fire (phase-loop) gen=${myGen} t=${performance.now().toFixed(0)} count=${changedNodeIds.length} dur=${durationMs}`);
        }
        this._objectTransitions = [];
        const startMs = clock.now();
        for (const nodeId of changedNodeIds) {
          const worldFrom = fromWorldTransforms[nodeId];
          const worldTo   = toWorldTransforms[nodeId];
          if (!worldFrom || !worldTo) continue;
          const inheritExtras = _buildInheritExtras(
            nodeId, worldFrom, worldTo,
            parentMap, changedSet, fromWorldTransforms, toWorldTransforms,
          );
          const pivotExtras = inheritExtras.inheritParentId
            ? {}
            : _buildPivotExtras(worldFrom, worldTo);
          this._objectTransitions.push({
            nodeId, worldFrom, worldTo, startMs,
            durationMs, easeFn, isWorld: true,
            depth: depthMap[nodeId] ?? 0,
            ...inheritExtras,
            ...pivotExtras,
          });
        }
        // Sort parents before children so world→local conversion uses correct parent matrices
        this._objectTransitions.sort((a, b) => a.depth - b.depth);
        if (this._objectTransitions.length) {
          phasePromises.push(new Promise(resolve => {
            this._onObjectTransitionsDone = resolve;
          }));
        }
      }

      // Visibility fades (BEFORE color so applyAll inside beginColorTransition
      // can reapply fade values via the _visTransitions reapply block)
      if (types.includes('visibility') && !visHandled &&
          (hidingMeshIds.length || showingMeshIds.length)) {
        visHandled = true;
        this._materials?.beginVisibilityTransitions(
          hidingMeshIds, showingMeshIds, durationMs, easeFn,
        );
        // V0.2.22.56 — insertion actors are kept IN showingMeshIds, so
        // their screen-door fade rides this same call; the transient
        // pieces share the live material and follow it. No separate fade.
      }

      // Color/material transition
      if (types.includes('color') && !colorHandled &&
          toSnapshot.materials && this._materials) {
        colorHandled = true;
        this._materials.beginColorTransition(toSnapshot.materials, durationMs, easeFn);
        // beginColorTransition calls applyAll() which resets transitionOpacity=1.0
        // on all meshes. If the vis phase hasn't run yet, re-zero showing meshes
        // so they stay invisible until their phase starts.
        if (!visHandled && showingMeshIds.length) {
          this._materials.snapShowingToZero(showingMeshIds);
        }
      }

      // 'shape' channel — DEDICATED FADE slot for flatShape nodes.
      // Same opacity-tween machinery as the regular 'visibility' channel,
      // just filtered to shape ids. Lets the author give shapes an
      // independent fade duration from the rest of the scene — e.g.
      // `camera(500), visibility(500), obj(500), shape(300)` fades
      // shapes faster (or with their own offset) than the meshes.
      //
      // For snap/threshold behaviour, use a tiny duration like shape(0).
      if (types.includes('shape') && !shapeHandled) {
        shapeHandled = true;
        if (hidingShapeIds.length || showingShapeIds.length) {
          this._materials?.beginVisibilityTransitions(
            hidingShapeIds, showingShapeIds, durationMs, easeFn,
          );
        }
      }

      // H1: cable transitions — opacity (visibility flip) + colour lerp.
      // Drives cables-render's _cableTransitions map; per-tick advance
      // is folded into the cables tick hook.
      if (types.includes('cable') && !cableHandled) {
        cableHandled = true;
        phasePromises.push(new Promise(resolve => {
          cablesRender.beginCableTransitions(
            toSnapshot.cables, durationMs, easeFn, resolve,
          );
        }));
      }

      // `narration` — TRIGGER slot. Fires the step:applied narration
      // playback path RIGHT NOW (at this phase's start). The audio plays
      // its own natural length asynchronously; the slot's durationMs
      // controls when narration STARTS relative to the rest of the
      // animation, not how long the audio runs. When `narration` is in
      // the string, the legacy step:applied auto-play (see
      // _playStepNarration in ui/steps-panel.js) suppresses itself so
      // we don't double-trigger.
      if (types.includes('narration') && !narrationHandled) {
        narrationHandled = true;
        try { state.emit('narration:trigger', toSnapshot); }
        catch (err) { console.warn('[steps] narration trigger failed:', err); }
      }

      // `notes` — show/hide FADE slot for notes. Move / panelOffset
      // transform stays on the obj phase (intentional: notes can fade
      // independently while their position still rides the camera/obj
      // window). Calling _scheduleNoteFades schedules a fade-only window
      // on each note's _anim record so the renderer lerps opacity over
      // THIS slot, while offset/framePosition keep using the wider obj
      // timing already set by the obj phase (or the obj fallback).
      if (types.includes('notes') && !notesHandled) {
        notesHandled = true;
        const root = state.get('treeData');
        if (root) {
          _scheduleNoteFades(root, toSnapshot, clock.now(), durationMs, easeFn);
        }
      }

      // `insert` — hardware ASSEMBLE phase (V0.2.22.53). Pieces were
      // staged exploded at transition start; this moves them exploded →
      // final over the slot duration. Inert dwell when no actors staged.
      if (types.includes('insert') && !insertHandled) {
        insertHandled = true;
        if (stagedActorIds.size) {
          // Trajectory line appears just before insertion; reposition
          // (prev→staging) THEN assemble (staging→final). The line fades
          // over the assemble.
          showInsertTrajectory();
          phasePromises.push(
            runInsertReposition(easeFn)
              .then(() => runInsertPause())
              .then(() => runInsertAssemble(durationMs, easeFn)),
          );
          _sleepMs = Math.max(_sleepMs, getStagedInsertTotalMs(durationMs));
        }
      }

      // `pause` — dwell. No-op handler; the await Promise.all below
      // already enforces durationMs. Listing this branch explicitly so
      // grep + future readers find it next to the rest.
      // if (types.includes('pause')) { /* dwell handled by await below */ }

      // Wait for this phase's duration (and any sub-promises that finish sooner)
      await Promise.all([_sleep(_sleepMs), ...phasePromises]);

      // Bail if a newer animation was started while we slept
      if (myGen !== undefined && this._animGeneration !== myGen) return false;
    }

    // ── Finalize missing channels — run DEFAULT animation, not snap ────
    // User rule: "all animation strings must fall on default if missing
    // from string." A preset like 'shape(500)' should make shapes snap
    // (their slot is in the string) but every other channel still
    // animates over the global default duration — not threshold-pop.
    //
    // EVERY engine channel must have a fallback here. When you add a new
    // channel to VALID_TYPES in animation.js:
    //   1. Add its phase handler ABOVE in the per-phase dispatch loop
    //   2. Add a fallback below (mirrors the handler with default duration)
    //   3. Update DEFAULT_ANIMATION_PRESET_STRING in schema.js
    //   4. Update _CHANNELS_REQUIRED in io/project.js for back-fill migration
    //
    // Without all four, the channel will threshold-pop when the preset
    // omits it — exactly the regression the user hit for cable + overlay
    // before this fallback block grew.
    const fallbackCam = state.get('cameraAnimDurationMs') ?? 1500;
    const fallbackObj = state.get('objectAnimDurationMs') ?? 1500;
    const fallbackPromises = [];

    if (!cameraHandled && toSnapshot.camera) {
      cameraHandled = true;
      fallbackPromises.push(
        sceneCore.animateCameraTo(toSnapshot.camera, fallbackCam, opts.easing),
      );
    }
    if (!objHandled && changedNodeIds.length) {
      objHandled = true;
      if (typeof window !== 'undefined' && window.sbsDiag?.animTrace) {
        // eslint-disable-next-line no-console
        console.log(`[anim] OBJ FALLBACK fire gen=${myGen} t=${performance.now().toFixed(0)} count=${changedNodeIds.length} dur=${fallbackObj}`);
      }
      const startMs = clock.now();
      this._objectTransitions = [];
      for (const nodeId of changedNodeIds) {
        const worldFrom = fromWorldTransforms[nodeId];
        const worldTo   = toWorldTransforms[nodeId];
        if (!worldFrom || !worldTo) continue;
        const inheritExtras = _buildInheritExtras(
          nodeId, worldFrom, worldTo,
          parentMap, changedSet, fromWorldTransforms, toWorldTransforms,
        );
        const pivotExtras = inheritExtras.inheritParentId
          ? {}
          : _buildPivotExtras(worldFrom, worldTo);
        this._objectTransitions.push({
          nodeId, worldFrom, worldTo, startMs,
          durationMs: fallbackObj, easeFn, isWorld: true,
          depth: depthMap[nodeId] ?? 0,
          ...inheritExtras,
          ...pivotExtras,
        });
      }
      this._objectTransitions.sort((a, b) => a.depth - b.depth);
      if (this._objectTransitions.length) {
        fallbackPromises.push(new Promise(resolve => {
          this._onObjectTransitionsDone = resolve;
        }));
      }
    }
    // visibility + shape: both use the same fade machinery. When
    // EITHER is missing from the string, the missing group falls back
    // to a default fade. Shapes that were folded into mesh arrays
    // (no shape slot in string) ride along automatically.
    if (!visHandled && (hidingMeshIds.length || showingMeshIds.length)) {
      visHandled = true;
      this._materials?.beginVisibilityTransitions(
        hidingMeshIds, showingMeshIds, fallbackObj, easeFn,
      );
      fallbackPromises.push(_sleep(fallbackObj));
    }
    if (!shapeHandled && (hidingShapeIds.length || showingShapeIds.length)) {
      shapeHandled = true;
      this._materials?.beginVisibilityTransitions(
        hidingShapeIds, showingShapeIds, fallbackObj, easeFn,
      );
      fallbackPromises.push(_sleep(fallbackObj));
    }
    // Color: when the string omits 'color', tween materials over the
    // global object duration instead of threshold-snapping. Same machinery
    // as the explicit color phase — beginColorTransition is idempotent
    // w.r.t. applyAll, and the trailing applySnapshotInstant (line ~616
    // in applySnapshotAnimated) will snap to exact target values once
    // the tween completes.
    if (!colorHandled && toSnapshot.materials && this._materials) {
      colorHandled = true;
      this._materials.beginColorTransition(toSnapshot.materials, fallbackObj, easeFn);
      // applyAll inside beginColorTransition resets transitionOpacity=1.0
      // on every mesh — re-zero anything that hasn't fired its visibility
      // phase yet, identical to the explicit-color-phase guard above.
      if (!visHandled && showingMeshIds.length) {
        this._materials.snapShowingToZero(showingMeshIds);
      }
      fallbackPromises.push(_sleep(fallbackObj));
    }
    // Cable fallback — when the string omits 'cable', tween cables over
    // the global object duration. Without this, adding/removing cables
    // between steps threshold-pops.
    if (!cableHandled) {
      cableHandled = true;
      fallbackPromises.push(new Promise(resolve => {
        cablesRender.beginCableTransitions(toSnapshot.cables, fallbackObj, easeFn, resolve);
      }));
    }
    // Overlay fallback — default to the sustained variant (no flicker on
    // items shared between steps). Without this, overlay items added /
    // removed between steps threshold-pop.
    if (!overlayHandled) {
      overlayHandled = true;
      fallbackPromises.push(new Promise(resolve => {
        overlaySystem.beginOverlaySustainedFade(fallbackObj, easeFn, resolve);
      }));
      if (stagedActorIds.size) showInsertTags();   // V0.2.22.57 — tags at overlay fallback
    }
    // narration / notes / pause have no fallback — narration's legacy
    // step:applied auto-play covers it, notes ride obj phase when no
    // notes slot is in the string (handled inside _scheduleNoteAnims),
    // and pause is a user-authored delay (no semantics when absent).

    // `insert` fallback (V0.2.22.53) — assemble staged actors over the
    // object duration when the string omits an insert slot. Flagging the
    // instance is enough; insert(N) in the string is just for timing.
    if (!insertHandled && stagedActorIds.size) {
      insertHandled = true;
      showInsertTrajectory();
      fallbackPromises.push(
        runInsertReposition(easeFn)
          .then(() => runInsertPause())
          .then(() => runInsertAssemble(fallbackObj, easeFn)),
      );
    }

    if (fallbackPromises.length) {
      await Promise.all(fallbackPromises);
      if (myGen !== undefined && this._animGeneration !== myGen) return false;
    }

    return cameraHandled;
  }

  // ─── Object transition tick ────────────────────────────────────────────
  _advanceObjectTransitions(nowMs) {
    // V0.1.77 diag: trace the first 12 frames of OBJ animation. Shows
    // alpha progression — if alpha rewinds, the lerp itself is the bug;
    // if alpha is monotonic, the stutter is somewhere else (e.g. another
    // handler resetting object positions mid-frame).
    if (typeof window !== 'undefined' && window.sbsDiag?.animTrace
        && this._objectTransitions.length > 0) {
      this._objAnimDiagFrame = (this._objAnimDiagFrame ?? -1) + 1;
      if (this._objAnimDiagFrame < 12) {
        const first = this._objectTransitions[0];
        if (first) {
          const raw = Math.max(0, Math.min((nowMs - first.startMs) / first.durationMs, 1));
          // eslint-disable-next-line no-console
          console.log(`[anim] OBJ frame ${this._objAnimDiagFrame}: raw=${raw.toFixed(3)} count=${this._objectTransitions.length} t=${performance.now().toFixed(0)} startMs=${first.startMs.toFixed(0)}`);
        }
      }
    } else if (typeof window !== 'undefined' && window.sbsDiag?.animTrace
               && this._objAnimDiagFrame != null
               && this._objectTransitions.length === 0) {
      // Reset frame counter when transitions drain — next OBJ phase fire restarts the count.
      this._objAnimDiagFrame = null;
    }

    // Advance material colour transition every frame (independent of object transforms)
    this._materials?.advanceColorTransition(nowMs);

    // Advance per-mesh visibility fades (runs AFTER colour — overrides back-outline opacity).
    // Returns true on the frame where the LAST fade just completed; we use that to
    // re-cascade folder-ancestor visibility (V0.1.74 fix — see _prepareVisibility).
    const fadesJustFinished = this._materials?.advanceVisibilityTransitions(nowMs, this.object3dById);
    if (fadesJustFinished && this._fadeRestoredAncestors?.size) {
      // Re-cascade visibility so folders we temporarily kept visible
      // to let the fade render now reflect their real (data-tree)
      // hidden state. applyAllVisibilityToScene walks the tree and
      // resets obj.visible = effective on every node.
      const { nodeById } = state.pick('nodeById');
      if (nodeById) applyAllVisibilityToScene(nodeById, this.object3dById);
      this._fadeRestoredAncestors.clear();
    }

    if (!this._objectTransitions.length) return;

    const { nodeById } = state.pick('nodeById');
    const done = [];

    for (const tr of this._objectTransitions) {
      const elapsed = nowMs - tr.startMs;
      // Clamp LOW to 0: on heavy models the first rAF after the (blocking)
      // step setup can carry a stale timestamp that is BEHIND startMs, making
      // elapsed negative. easeFn(negative) returns a POSITIVE alpha (smoothstep
      // of -0.2 ≈ +0.14), so the object would render ~14% into the move for one
      // frame ("jump to a future frame") then pop back. Clamping pins frame 0
      // to the exact FROM pose regardless of model size / timestamp lag.
      const raw     = Math.max(0, Math.min(elapsed / tr.durationMs, 1));
      const alpha   = tr.easeFn(raw);

      const node = nodeById.get(tr.nodeId);
      const obj  = this.object3dById.get(tr.nodeId);

      if (node && obj && isAnimatableNode(node)) {
        if (tr.isWorld) {
          if (tr.pivotData) {
            // PIVOT-AWARE branch. The object's rotation slerps directly,
            // but its position is derived from the (lerped) pivot world
            // position minus the rotated pivot offset. When the user's
            // pivot is consistent across both steps (the common case —
            // pivot was set once, both steps share it), pivotWorldFrom
            // ≈ pivotWorldTo and the pivot is a constant point in
            // world space. The object cleanly arcs around it.
            //
            // Without this branch, the world-pos lerp connects the
            // back-solved endpoints with a straight chord, producing
            // the visible "wobble through the pivot" the user reported.
            const THREE = window.THREE;
            const lerpedQuat = slerpQuaternion(tr.worldFrom.quaternion, tr.worldTo.quaternion, alpha);
            const lerpedPivotLocal = lerpVec3(tr.pivotData.localFrom, tr.pivotData.localTo, alpha);
            const lerpedPivotWorld = lerpVec3(tr.pivotData.worldFrom, tr.pivotData.worldTo, alpha);
            const offsetWorld = new THREE.Vector3(
              lerpedPivotLocal[0], lerpedPivotLocal[1], lerpedPivotLocal[2],
            ).applyQuaternion(
              new THREE.Quaternion(lerpedQuat[0], lerpedQuat[1], lerpedQuat[2], lerpedQuat[3]),
            );
            const lerpedPos = [
              lerpedPivotWorld[0] - offsetWorld.x,
              lerpedPivotWorld[1] - offsetWorld.y,
              lerpedPivotWorld[2] - offsetWorld.z,
            ];
            _setWorldTransformOnObject(obj, lerpedPos, lerpedQuat);
            _writeDataStateFromObject3D(node, obj);  // V0.2.22.17 Stage 1
          } else if (tr.inheritParentId && tr.localFrom && tr.localTo) {
            // PARENT-LOCAL lerp branch. The tree-data parent is also
            // animating this frame (it was processed earlier in the loop
            // via the depth sort, so its matrixWorld is already at its
            // own lerped state). We feed Three.js the LOCAL pose relative
            // to that parent and let the scene-graph multiplication
            // produce the world position — child rides the parent's
            // rotation ARC instead of taking the world-space chord.
            //
            // Without this branch, a flatShape parented under a rotating
            // model visibly dips through the model's surface mid-tween.
            const lerpedPos  = lerpVec3(tr.localFrom.position,  tr.localTo.position,  alpha);
            const lerpedQuat = slerpQuaternion(tr.localFrom.quaternion, tr.localTo.quaternion, alpha);
            obj.position.set(lerpedPos[0], lerpedPos[1], lerpedPos[2]);
            obj.quaternion.set(lerpedQuat[0], lerpedQuat[1], lerpedQuat[2], lerpedQuat[3]);
            obj.updateMatrix();
            // updateMatrixWorld(false) — don't cascade to children here;
            // any animating descendant will run later in this same loop
            // and recompute its own matrixWorld via its parent's just-
            // updated matrix.
            obj.updateMatrixWorld(false);
            _writeDataStateFromObject3D(node, obj);  // V0.2.22.17 Stage 1
          } else {
            // World-space lerp. Objects stay in their target hierarchy; we use
            // world→local conversion (v0.266 approach) so the correct local
            // position is set regardless of which folder the node is in.
            // Parents are processed before children (depth sort) so parent
            // matrices are current when children compute their local positions.
            const lerpedPos  = lerpVec3(tr.worldFrom.position,  tr.worldTo.position,  alpha);
            const lerpedQuat = slerpQuaternion(tr.worldFrom.quaternion, tr.worldTo.quaternion, alpha);
            _setWorldTransformOnObject(obj, lerpedPos, lerpedQuat);
            _writeDataStateFromObject3D(node, obj);  // V0.2.22.17 Stage 1
          }
        } else {
          // Legacy: localOffset lerp (fallback for old snapshots without worldTransforms)
          const interp = interpolateTransformSnapshot(tr.from, tr.to, alpha);
          applyTransformSnapshot(node, interp);
          applyNodeTransformToObject3D(node, obj, false);
          obj.updateMatrixWorld(true);
        }
      }

      if (raw >= 1) done.push(tr);
    }

    // Remove completed transitions
    done.forEach(tr => {
      const idx = this._objectTransitions.indexOf(tr);
      if (idx >= 0) this._objectTransitions.splice(idx, 1);
    });

    // Notify if all done
    if (this._objectTransitions.length === 0 && this._onObjectTransitionsDone) {
      const fn = this._onObjectTransitionsDone;
      this._onObjectTransitionsDone = null;
      fn();
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  STEP ACTIVATION
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Activate a step — apply its snapshot to the scene.
   * If the step has a transition duration > 0, animate.
   *
   * @param {string}  stepId
   * @param {boolean} [animate]  override transition animation (default: use step settings)
   */
  async activateStep(stepId, animate = true, opts = {}) {
    if (typeof window !== 'undefined' && window.sbsDiag?.animTrace) {
      // eslint-disable-next-line no-console
      console.log(`[anim] activateStep(${stepId}, animate=${animate}, fromArrow=${!!opts.fromArrow}) t=${performance.now().toFixed(0)}`);
      // V0.1.76: dump caller stack (3 frames after this fn + the wrapper).
      // The "mystery 721 instant activate mid-animation" needs to be
      // attributed to a specific caller — middle-click, undo, state
      // listener, etc.
      const stack = (new Error()).stack?.split('\n') || [];
      // Skip first 2 lines (Error / current fn), keep next ~5 callers.
      console.log('[anim]   caller stack:\n' + stack.slice(2, 7).join('\n'));
    }
    const steps = state.get('steps');
    const step  = steps.find(s => s.id === stepId);
    if (!step) return;

    // V0.2.22.55 — UNCONDITIONALLY tear down any lingering insertion
    // staging before this activation does anything. Fixes the orphan-
    // clone bug: a normal completion finalizes its own staging, but an
    // INTERRUPTED transition (newer step started mid-animation) bailed
    // before finalize, and if the next step had no insert actors,
    // stageInsertActors never ran to clean up — leaving the transient
    // pieces frozen in the scene as an un-removable clone. Cleaning here
    // every time guarantees no leftovers regardless of path.
    //
    // NOTE: only the live STAGING is torn down here. The pre-install PREVIEW
    // teardown (clearPreInstall) is deferred until AFTER captureActiveThumb-
    // nail below — clearPreInstall un-hides the assembled mesh, and the
    // thumbnail does a real render to the main canvas, so tearing the
    // preview down first would flash the assembled nut for one frame
    // (V0.2.22.73).
    finalizeInsertActors();

    // Flush any pending dirty-sync into the LEAVING step BEFORE we
    // change the active step. Otherwise quick toggle-then-navigate
    // (under the 500ms scheduleSync timer) loses the change. Cable
    // visibility is the most visible victim — material + visibility
    // toggles all rely on this same race.
    this.flushSync();

    // If another animation is in progress (direct step card click mid-anim),
    // snap it to final so the scene is clean before starting a new transition.
    // snapCurrentToFinal does NOT rebuild the tree — it only snaps object positions
    // and materials since the tree/node data is already at the target state.
    this.snapCurrentToFinal();


    // Capture the OUTGOING step's final viewport state before we switch away.
    // Force bypasses the 5-fps throttle so nothing is lost on quick step changes.
    // The pre-install preview is still active here, so the outgoing step's
    // thumbnail correctly shows the exploded nut.
    if (state.get('activeStepId') !== stepId) this.captureActiveThumbnail(true);

    // NOW tear down the pre-install preview (un-hides the assembled mesh).
    // Done AFTER the thumbnail render so it doesn't flash on the live canvas.
    clearPreInstall();

    // Update state (fires 'step:activate' event for notes/screen overlay)
    state.setActiveStep(stepId);
    state.markDirty();

    const tr = step.transition ?? {};
    const { durationMs = 1500 } = tr;

    // Animate if: animate=true AND (legacy durationMs > 0 OR a phased preset is active)
    const animStr = resolveAnimationString(tr, state.get('animationPresets') || []);
    const shouldAnimate = animate && (durationMs > 0 || animStr !== null);

    // Stamp a unique token for this activation. Only the activation that OWNS
    // the current token is allowed to clear _animRunning when it completes.
    // Prevents a stale async from resetting the flag mid-animation of a newer step.
    const myToken = ++this._activationToken;

    // Resolve camera through cameraBinding before any apply path sees
    // the snapshot — template-bound steps pull from cameraViews, free
    // steps use their own snapshot.camera.
    const resolvedSnap = this._resolveStepSnapshot(step);

    if (shouldAnimate) {
      this._animRunning       = true;
      this._currentTargetSnap = resolvedSnap;
      await this.applySnapshotAnimated(resolvedSnap, tr);
      // Only clear flags if we're still the active animation (no newer step started)
      if (myToken === this._activationToken) {
        this._animRunning                  = false;
        this._currentTargetSnap            = null;
        this._currentTargetWorldTransforms = null;
      }
    } else {
      this._animRunning       = false;
      this._currentTargetSnap = null;
      this.applySnapshotInstant(resolvedSnap);
    }

    state.emit('step:applied', step);

    // Silently pre-warm the NEXT step's transition so its matrices are
    // ready before the user clicks. Discreet — deferred, no render output.
    const allSteps  = state.get('steps').filter(s => this._isPlayable(s));
    const curIdx    = allSteps.findIndex(s => s.id === stepId);
    const nextStep  = allSteps[curIdx + 1];
    if (nextStep) this._prewarm(nextStep.id);

    // ── Step-group auto-chain (Phase C) ─────────────────────────────────
    // When activation came from arrow / step-nav navigation (opts.fromArrow
    // true), and the current step is part of a group, immediately chain
    // into the next sub-step — no pause, no user input. The chain ends
    // when the next step isn't a sub-step of the same group.
    //
    // Click and middle-click activations don't pass fromArrow, so they
    // stop at the end of the clicked step (per spec — click = "edit this
    // specific step", arrow = "play the assembly forward"). The token
    // gate ensures interruption (a click during chain) breaks the chain
    // cleanly: the interrupting call increments _activationToken, the
    // outer chain's await resolves via snapCurrentToFinal, and the stale
    // token mismatch makes this branch a no-op.
    if (opts.fromArrow && myToken === this._activationToken) {
      const currentGroupId = step.groupHead ? step.id : (step.groupId || null);
      if (currentGroupId) {
        const next = nextStep;
        if (next && next.groupId === currentGroupId) {
          // ── In-group chain (V0.1.78 — narration overflow rule) ──────
          // The previous step's narration may still be playing past this
          // sub-step's animation (overflow). If the NEXT sub-step has
          // its OWN narration, two narrations would overlap — so hold
          // the chain until the current narration finishes before
          // activating the next sub-step (which will start its own
          // narration via the normal step:applied / narration:trigger
          // path). Sub-steps without narration chain immediately, even
          // if the head's narration is still playing.
          const nextHasNarration = !!(next.narration?.dataFile || next.narration?.dataUrl);
          if (nextHasNarration && isNarrationPlaying()) {
            // Don't await on the call stack — fire-and-forget so the
            // current activateStep returns. Token gate inside the
            // async block aborts cleanly if a user interrupt fires.
            (async () => {
              await awaitNarrationEnd();
              if (myToken !== this._activationToken) return;
              this.activateStep(next.id, true, { fromArrow: true });
            })();
          } else {
            this.activateStep(next.id, true, { fromArrow: true });
          }
        }
        // V0.1.80 reverted: end-of-group narration overflow no longer
        // auto-crosses the group boundary. The narration audio keeps
        // playing past the last sub-step (V0.1.78 still leaves the
        // clip alone on no-narration step transitions), but the
        // playback chain STOPS at the group end — user advances
        // manually. The earlier "cross-boundary on overflow" branch
        // was firing even after narration ended in some flows, making
        // the group feel runaway. Holding is the safer default.
      }
    }
  }

  /**
   * Activate a step by index (0-based).
   */
  activateStepByIndex(index, animate = true) {
    const steps = state.get('steps').filter(s => this._isPlayable(s));
    const step  = steps[index];
    if (step) return this.activateStep(step.id, animate);
  }

  /**
   * Snap the current in-flight animation to its final state immediately.
   * Does NOT navigate to a new step — caller should do that on the next interaction.
   * Returns true if an animation was in progress and was snapped.
   *
   * WHY we do NOT call applySnapshotInstant here:
   *   applySnapshotAnimated already rebuilds the target tree (cleanupFolderGroups +
   *   rebuildFromTreeSpec) and writes target transforms to node.localOffset
   *   synchronously before its first await.  What is still animating is only the
   *   Three.js object positions (world-space lerp) and material colours.
   *   Calling applySnapshotInstant would re-run the tree rebuild on a scene that
   *   is already in the target tree state, causing double-rebuild corruption.
   *   Instead we only snap the Two things that are mid-transition:
   *     1. Three.js object positions → applyAllTransformsToScene (reads node.localOffset)
   *     2. Material colours          → materials.applySnapshot
   */
  snapCurrentToFinal() {
    if (!this._animRunning) return false;
    if (typeof window !== 'undefined' && window.sbsDiag?.animTrace) {
      // eslint-disable-next-line no-console
      console.log(`[anim] snapCurrentToFinal t=${performance.now().toFixed(0)}`);
    }

    // Cancel the in-flight animation so applySnapshotAnimated bails on resume
    this._animGeneration++;
    if (this._onObjectTransitionsDone) {
      this._onObjectTransitionsDone();
      this._onObjectTransitionsDone = null;
    }
    this._objectTransitions = [];
    // H1: snap any in-flight cable phase to final + resolve its await
    cablesRender.snapCableTransitionsToFinal();
    // H2: same for the overlay fade.
    overlaySystem.snapOverlayFadeToFinal();

    // Snap ALL animatable nodes (model, folder, AND mesh) to their target world positions.
    // We must use _setWorldTransformOnObject here — NOT applyAllTransformsToScene —
    // because mesh nodes are animated via world-space lerp but are NOT covered by
    // applyAllTransformsToScene (which only processes isTransformNode = model/folder).
    // After a snap, mesh obj.position would be left at a mid-animation local value,
    // and the next animation would capture those wrong world positions as FROM, causing
    // a cascade offset that accumulates with every interrupted animation.
    if (this._currentTargetWorldTransforms) {
      const root = state.get('treeData');
      // DFS order (flatten) = parents before children, so parent matrices are correct
      // when children compute their world→local conversion.
      flatten(root).forEach(node => {
        if (!isAnimatableNode(node)) return;
        const obj = this.object3dById.get(node.id);
        if (!obj) return;
        const wt = this._currentTargetWorldTransforms[node.id];
        if (!wt) return;
        _setWorldTransformOnObject(obj, wt.position, wt.quaternion);
      });
      this._warmMatrices();
    }

    // Snap material colours to target
    if (this._currentTargetSnap?.materials && this._materials) {
      this._materials.applySnapshot(this._currentTargetSnap.materials);
    }

    this._animRunning                  = false;
    this._currentTargetSnap            = null;
    this._currentTargetWorldTransforms = null;
    return true;
  }

  /**
   * Activate next/previous visible step relative to current active.
   * If an animation is in progress, snaps it to final instead of navigating —
   * the next call (next key press) will then navigate.
   */
  activateRelativeStep(delta, animate = true) {
    // If animating: snap to final only. Don't chain into a new step.
    if (this.snapCurrentToFinal()) return;

    const steps = state.get('steps').filter(s => this._isPlayable(s));
    const activeId  = state.get('activeStepId');
    const currentIdx = steps.findIndex(s => s.id === activeId);

    // Step-groups (Phase C/D): arrow navigation has group-aware semantics.
    //   RIGHT (+1): step forward by one in the flat array. If the
    //               current step is in a group, the next step may also
    //               be a sub-step of the same group — that's fine,
    //               activateStep's auto-chain handles continuing through
    //               the rest of the group. So a single +1 hop here is
    //               correct in both cases.
    //   LEFT  (-1): jump back to the PREVIOUS TOP-LEVEL step (skipping
    //               over any sub-steps that happen to precede the
    //               current position in the flat array). If that target
    //               is a group head, activateStep's auto-chain plays it
    //               from head through every sub-step.
    if (delta < 0) {
      // From a SUB-STEP, left arrow jumps to the top-level step BEFORE
      // the current group (so the user steps out of the group entirely,
      // not back to its head). From a HEAD or normal step, it's the
      // previous top-level step in flat-array order. In both cases, if
      // the landing step is itself a group head, auto-chain plays its
      // body from the head onward.
      const current = steps[currentIdx];
      let searchFrom = currentIdx - 1;
      if (current?.groupId) {
        const headIdx = steps.findIndex(s => s.id === current.groupId);
        searchFrom = headIdx - 1;
      }
      let prevTopLevelIdx = -1;
      for (let i = searchFrom; i >= 0; i--) {
        if (!steps[i].groupId) { prevTopLevelIdx = i; break; }
      }
      if (prevTopLevelIdx < 0) return;   // no previous top-level step
      return this.activateStep(steps[prevTopLevelIdx].id, animate, { fromArrow: true });
    }

    const nextIdx = Math.max(0, Math.min(steps.length - 1, currentIdx + delta));
    return this.activateStep(steps[nextIdx]?.id, animate, { fromArrow: true });
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  DIRTY SYNC
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Mark the active step as needing a snapshot update.
   * The timer will call syncActiveStepNow() shortly.
   * NOTE: transforms and tree structure are NOT updated by this path —
   * use scheduleTransformSync() for any mutation that changes node positions,
   * rotations, or the scene hierarchy.
   */
  scheduleSync() {
    this._dirty = true;
    state.setState({ _stepDirty: true });
  }

  /**
   * Toggle visibility of all missing-asset Bbox placeholder LineSegments.
   * Used by the video exporter to keep authoring-aid outlines out of
   * encoded frames unless the user explicitly opted in via Export tab →
   * "Export boundary boxes".
   *
   * Sets a sticky module flag so every placeholder rebuilt during
   * subsequent step transitions inherits the hidden state — without
   * this, the Bbox would reappear on the next step nav.
   *
   * Phantom-folder Groups (isPlaceholderFolder) are intentionally NOT
   * toggled: they wrap foreign-object guests too, and hiding the Group
   * would hide those guests with it.
   */
  setPlaceholderBboxesVisible(visible) {
    _placeholdersHidden = !visible;
    for (const [, obj] of this.object3dById) {
      if (obj?.userData?.isPlaceholder) obj.visible = visible;
    }
  }

  /**
   * Like scheduleSync(), but also allows the next sync to overwrite the step's
   * transform and tree data.  Call this ONLY from explicit user transform
   * actions: gizmo drag commit, reset, hierarchy rearrangement.
   */
  scheduleTransformSync() {
    this._syncIncludesTransforms = true;
    this._dirty = true;
    state.setState({ _stepDirty: true });
  }

  /**
   * Immediately update the active step's snapshot with current scene state.
   *
   * Transform-immutability contract:
   *   Transforms (node localOffset/localQuaternion) and the scene tree structure
   *   are ONLY written when _syncIncludesTransforms is true — i.e. when the sync
   *   was explicitly requested by a user transform action (gizmo commit, reset,
   *   hierarchy move).  All other syncs (visibility, materials, notes) preserve
   *   the step's existing transform/tree data verbatim.
   */
  syncActiveStepNow() {
    // Never capture mid-animation: scene is in intermediate state and would
    // corrupt the active step's snapshot with wrong transforms / colors.
    if (this._animRunning) return;
    const activeId = state.get('activeStepId');
    if (!activeId) return;

    const steps = state.get('steps');
    const step  = steps.find(s => s.id === activeId);
    if (!step) return;

    const newSnapshot = this.captureSnapshot();

    // Camera is locked at step-creation time and must not be overwritten
    // by automatic dirty syncs (which fire whenever the user changes
    // selection or visibility).  Preserve whatever camera was saved.
    if (step.snapshot?.camera) {
      newSnapshot.camera = step.snapshot.camera;
    }

    // TRANSFORM IMMUTABILITY: only overwrite transforms/tree when this sync
    // was triggered by an explicit transform-commit action.  Otherwise restore
    // the step's existing values so that navigation, visibility changes, or
    // material edits can never bleed transform data into a step.
    const includesTransforms = this._syncIncludesTransforms;
    this._syncIncludesTransforms = false;   // always reset after use
    if (!includesTransforms && step.snapshot) {
      if (step.snapshot.transforms !== undefined) {
        newSnapshot.transforms = step.snapshot.transforms;
      }
      if (step.snapshot.tree !== undefined) {
        newSnapshot.tree = step.snapshot.tree;
      }
    }

    step.snapshot = newSnapshot;
    this._dirty   = false;
    state.setState({ _stepDirty: false, steps: [...steps] });
    state.emit('step:synced', step);

    // Immediately reflect any color-preset changes on placeholder outlines.
    const nodeById = state.get('nodeById');
    if (nodeById) this._updatePlaceholderColors(nodeById);
  }

  /**
   * Flush any pending dirty sync immediately.
   * Call before saving, exporting, or navigating.
   */
  flushSync() {
    if (this._dirty && !this._animRunning) this.syncActiveStepNow();
    // Note: _syncIncludesTransforms is consumed inside syncActiveStepNow and reset there.
  }

  /**
   * Explicitly save the current viewport camera position into a step.
   * Step-level "Update camera" is ALWAYS free-camera: snapshot the
   * current view AND set cameraBinding to free, breaking any prior
   * template link. Updating a *template* (which propagates to every
   * bound step) goes through the Camera tab, not this entry point.
   *
   * @param {string} stepId  target step (defaults to active step)
   */
  saveStepCamera(stepId) {
    const id    = stepId ?? state.get('activeStepId');
    if (!id) return;
    const allSteps = state.get('steps');
    const step     = allSteps.find(s => s.id === id);
    if (!step) return;

    step.snapshot = step.snapshot ?? {};
    step.snapshot.camera = sceneCore.getCameraState();
    if (!step.cameraBinding) step.cameraBinding = { mode: 'free', templateId: null };
    step.cameraBinding.mode       = 'free';
    step.cameraBinding.templateId = null;
    state.setState({ steps: [...allSteps] });
    state.markDirty();
    state.emit('step:synced', step);
  }

  /**
   * Resolve the effective camera state for a step, honouring its
   * cameraBinding. Templates are stored in state.cameraViews — when a
   * step's binding points there, we copy out the camera fields so the
   * activate path can apply/animate to that state.
   *
   * Returns null if the step has no usable camera (no snapshot camera
   * AND no template, OR the template id no longer exists with no
   * snapshot fallback). Callers should treat null as "skip camera".
   *
   * @param {Step} step
   * @returns {CameraState|null}
   */
  _resolveStepCamera(step) {
    if (!step) return null;
    const binding = step.cameraBinding;
    if (binding?.mode === 'template' && binding.templateId) {
      const views = state.get('cameraViews') || [];
      const tpl   = views.find(v => v.id === binding.templateId);
      if (tpl) {
        return {
          position:   tpl.position,
          quaternion: tpl.quaternion,
          pivot:      tpl.pivot,
          up:         tpl.up,
          fov:        tpl.fov,
        };
      }
      // Template was deleted out from under this step. Fall back to the
      // step's last-snapshotted camera so the view doesn't blank.
    }
    return step.snapshot?.camera ?? null;
  }

  /**
   * Returns the step's snapshot with camera resolved through its
   * cameraBinding — what the activate paths actually want to apply.
   * Returns the original snapshot if nothing changes (no template
   * binding, no camera at all).
   *
   * @param {Step} step
   * @returns {Snapshot}
   */
  _resolveStepSnapshot(step) {
    if (!step?.snapshot) return step?.snapshot;
    const resolvedCam = this._resolveStepCamera(step);
    if (resolvedCam === step.snapshot.camera) return step.snapshot;
    return { ...step.snapshot, camera: resolvedCam };
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  STEP CRUD
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Create a new step from the current scene state and insert it
   * after the currently active step (or at the end).
   *
   * @param {string} [name]    step name (auto-generated if omitted)
   * @returns {Step}
   */
  createStepFromCurrent(name, overrides = {}) {
    const steps    = state.get('steps');
    const activeId = state.get('activeStepId');
    const active   = steps.find(s => s.id === activeId);

    // Inherit active step's chapter when none given — keeps new steps inside
    // the user's current chapter so normalizeOrder doesn't relocate them.
    const inheritedChapterId = overrides.chapterId !== undefined
      ? overrides.chapterId
      : (active?.chapterId ?? null);

    const label = name ?? this._nextStepLabel(steps);
    const step  = createStep({ name: label, ...overrides, chapterId: inheritedChapterId });
    step.snapshot = this.captureSnapshot();

    // Insert after active step, or at end
    const activeIdx = steps.findIndex(s => s.id === activeId);
    const insertAt  = activeIdx >= 0 ? activeIdx + 1 : steps.length;
    const newSteps  = [...steps];
    newSteps.splice(insertAt, 0, step);

    state.setState({ steps: newSteps });
    this.normalizeOrder();
    state.setActiveStep(step.id);
    state.markDirty();
    state.emit('step:created', step);

    return step;
  }

  /**
   * Inject a newly-loaded model into every existing step snapshot so that
   * switching to any step never hides/removes the model.
   *
   * For each step that does NOT already contain the model:
   *   • snapshot.tree      — model spec appended to scene_root children
   *   • snapshot.visibility — all model nodes set to visible (true)
   *   • snapshot.transforms — all transform nodes get their current transforms
   *
   * @param {TreeNode} modelNode  the live tree node returned by loadModelFile
   */
  injectModelIntoAllSteps(modelNode) {
    if (!modelNode) return;
    const stepsArr = state.get('steps') || [];
    if (!stepsArr.length) return;

    // Serialise the model's current tree structure (no transforms — stored separately)
    const modelSpec = serializeModelTree(modelNode);

    // Collect the model's current visibility and transforms from the live tree
    const modelVisibility = {};
    const modelTransforms = {};
    flatten(modelNode).forEach(node => {
      modelVisibility[node.id] = node.localVisible !== false;
      if (isTransformNode(node)) {
        modelTransforms[node.id] = captureTransformSnapshot(node);
      }
    });

    // Helper: does a serialised tree already contain a node with this id?
    function specContainsId(spec, id) {
      if (!spec) return false;
      if (spec.id === id) return true;
      return (spec.children || []).some(c => specContainsId(c, id));
    }

    const updated = stepsArr.map(step => {
      const snap = step.snapshot;
      if (!snap) return step;

      // Skip if this step already has the model in its tree
      if (snap.tree && specContainsId(snap.tree, modelNode.id)) return step;

      // Append to the scene_root's children list in the serialised tree
      let newTree = snap.tree;
      if (newTree) {
        newTree = {
          ...newTree,
          children: [...(newTree.children || []), modelSpec],
        };
      }

      return {
        ...step,
        snapshot: {
          ...snap,
          tree:       newTree,
          visibility: { ...modelVisibility, ...(snap.visibility || {}) },
          transforms: { ...modelTransforms, ...(snap.transforms || {}) },
        },
      };
    });

    state.setState({ steps: updated });
    state.markDirty();
  }

  /**
   * V0.2.22.64 — make a runtime-placed HARDWARE INSTANCE survive step
   * snapshots, the way injectModelIntoAllSteps does for imported models.
   *
   * Two differences from a model:
   *   • the instance lives UNDER the Hardware folder, not at scene root;
   *   • we must ADD it even to steps whose folder already exists (a model
   *     is skipped once present, but here each NEW instance is a new child
   *     of an existing folder — the old "skip if folder present" check
   *     would drop every instance after the first → the multi-instance bug).
   *
   * For each step that doesn't already contain the instance:
   *   • snapshot.tree       — instance spec appended under its folder spec
   *                           (folder spec added under scene_root if absent)
   *   • snapshot.visibility — instance (+ folder) set visible
   *   • snapshot.transforms — instance's current transform
   *
   * rebuildFromTreeSpec only needs the spec present to keep the live node
   * in the hierarchy (it looks the node up in nodeById), so this is enough.
   */
  injectHardwareInstanceIntoAllSteps(instNode, folderNode) {
    if (!instNode) return;
    const stepsArr = state.get('steps') || [];
    if (!stepsArr.length) return;

    const instSpec   = serializeModelTree(instNode);
    const folderId   = folderNode?.id || null;
    const folderSpec = folderNode
      ? { ...serializeModelTree(folderNode), children: [] }
      : null;

    // Visibility + transforms for the instance (and the folder, if new).
    const vis = {};
    const xf  = {};
    vis[instNode.id] = instNode.localVisible !== false;
    if (isTransformNode(instNode)) xf[instNode.id] = captureTransformSnapshot(instNode);
    if (folderNode) {
      vis[folderNode.id] = folderNode.localVisible !== false;
      if (isTransformNode(folderNode)) xf[folderNode.id] = captureTransformSnapshot(folderNode);
    }

    const containsId = (spec, id) => {
      if (!spec) return false;
      if (spec.id === id) return true;
      return (spec.children || []).some(c => containsId(c, id));
    };
    // Immutably append `child` under the node with id===parentId. Returns
    // a new spec tree, or null if the parent wasn't found.
    const addUnder = (spec, parentId, child) => {
      if (!spec) return null;
      if (spec.id === parentId) {
        return { ...spec, children: [...(spec.children || []), child] };
      }
      let changed = false;
      const kids = (spec.children || []).map(c => {
        const r = addUnder(c, parentId, child);
        if (r) { changed = true; return r; }
        return c;
      });
      return changed ? { ...spec, children: kids } : null;
    };

    const updated = stepsArr.map(step => {
      const snap = step.snapshot;
      if (!snap || !snap.tree) return step;
      if (containsId(snap.tree, instNode.id)) return step;   // already present

      let newTree = snap.tree;
      if (folderId && containsId(newTree, folderId)) {
        newTree = addUnder(newTree, folderId, instSpec) || newTree;
      } else if (folderSpec) {
        const folderWithChild = { ...folderSpec, children: [instSpec] };
        newTree = { ...newTree, children: [...(newTree.children || []), folderWithChild] };
      } else {
        newTree = { ...newTree, children: [...(newTree.children || []), instSpec] };
      }

      return {
        ...step,
        snapshot: {
          ...snap,
          tree:       newTree,
          visibility: { ...vis, ...(snap.visibility || {}) },
          transforms: { ...xf,  ...(snap.transforms || {}) },
        },
      };
    });

    state.setState({ steps: updated });
    state.markDirty();
  }

  /**
   * Duplicate any step by ID and insert a copy after it.
   * @param {string} stepId
   * @returns {Step|null}
   */
  duplicateStep(stepId) {
    const steps  = state.get('steps');
    const source = steps.find(s => s.id === stepId);
    if (!source) return null;

    const copy = createStep({
      name:         source.name + ' (copy)',
      chapterId:    source.chapterId,
      voiceText:    source.voiceText,
      voiceEnabled: source.voiceEnabled,
      transition:   { ...source.transition },
      snapshot:     JSON.parse(JSON.stringify(source.snapshot)),
      // step.overlay is a Konva.Stage JSON string (text boxes, images,
      // shapes) — duplicate by copying the string verbatim so the new
      // step starts with an identical overlay. Without this the dup
      // arrived with an empty stage.
      overlay:      source.overlay || null,
    });

    const sourceIdx = steps.indexOf(source);
    const newSteps  = [...steps];
    newSteps.splice(sourceIdx + 1, 0, copy);

    state.setState({ steps: newSteps });
    state.setActiveStep(copy.id);
    state.markDirty();
    state.emit('step:created', copy);
    return copy;
  }

  /** @deprecated Use duplicateStep(stepId) instead */
  duplicateActiveStep() {
    const activeId = state.get('activeStepId');
    return activeId ? this.duplicateStep(activeId) : null;
  }

  /**
   * Delete a step by ID.
   * If it was active, activate the nearest remaining step.
   * @param {string} stepId
   */
  deleteStep(stepId) {
    const steps   = state.get('steps');
    const activeId = state.get('activeStepId');
    const idx      = steps.findIndex(s => s.id === stepId);
    if (idx < 0) return;

    const newSteps = steps.filter(s => s.id !== stepId);
    state.setState({ steps: newSteps });
    state.markDirty();

    if (activeId === stepId) {
      // Activate next user step, or previous, skipping the base step
      const userSteps     = newSteps.filter(s => !s.isBaseStep);
      const userIdxBefore = steps.slice(0, idx).filter(s => !s.isBaseStep).length;
      const next = userSteps[userIdxBefore] ?? userSteps[userIdxBefore - 1] ?? null;
      if (next) {
        this.activateStep(next.id, false);
      } else {
        state.setActiveStep(null);
      }
    }

    state.emit('step:deleted', stepId);
  }

  /**
   * Rename a step.
   * @param {string} stepId
   * @param {string} name
   */
  renameStep(stepId, name) {
    const steps = state.get('steps');
    const step  = steps.find(s => s.id === stepId);
    if (!step) return;
    step.name = name;
    state.setState({ steps: [...steps] });
    state.markDirty();
    state.emit('step:renamed', step);
  }

  /**
   * Update step transition settings.
   * @param {string} stepId
   * @param {object} transitionPatch
   */
  updateTransition(stepId, transitionPatch) {
    const steps = state.get('steps');
    const step  = steps.find(s => s.id === stepId);
    if (!step) return;
    step.transition = { ...step.transition, ...transitionPatch };
    state.setState({ steps: [...steps] });
    state.markDirty();
  }

  /**
   * Reorder steps by moving `stepId` to `newIndex`.
   * @param {string} stepId
   * @param {number} newIndex
   */
  reorderStep(stepId, newIndex) {
    const steps  = [...state.get('steps')];
    const oldIdx = steps.findIndex(s => s.id === stepId);
    if (oldIdx < 0) return;

    const [step] = steps.splice(oldIdx, 1);
    steps.splice(Math.max(0, Math.min(steps.length, newIndex)), 0, step);

    state.setState({ steps });
    this.normalizeOrder();
    state.markDirty();
    state.emit('steps:reordered');
  }

  /**
   * Toggle a step's hidden flag.
   * @param {string}  stepId
   * @param {boolean} hidden
   */
  setStepHidden(stepId, hidden) {
    const steps = state.get('steps');
    const step  = steps.find(s => s.id === stepId);
    if (!step) return;
    const want = !!hidden;
    step.hidden = want;
    // Step-groups: toggling a HEAD cascades the same hidden state to
    // every sub-step under it. Without this, the head disappears from
    // playback but the sub-steps still play, breaking the "group reads
    // as one step" invariant. Show on the head also un-hides every
    // sub-step (regardless of their previous individual state) so the
    // group toggle is symmetric and predictable.
    if (step.groupHead) {
      for (const s of steps) {
        if (s.groupId === stepId) s.hidden = want;
      }
    }
    state.setState({ steps: [...steps] });
    state.markDirty();
  }

  /**
   * Toggle (or set) a chapter's hidden flag. When a chapter is hidden,
   * every step inside it is skipped from playback / export — useful
   * for project variation management where alternate chapters can be
   * staged side-by-side and toggled in/out without deleting steps.
   * The per-step hidden flag is independent: a chapter can be
   * "showing" and individual steps inside still hidden.
   */
  setChapterHidden(chapterId, hidden) {
    const chapters = state.get('chapters') || [];
    const chap     = chapters.find(c => c.id === chapterId);
    if (!chap) return;
    const next = !!hidden;
    chap.hidden = next;
    // Hiding auto-UNLOCKS the chapter so it collapses by default —
    // hidden steps shouldn't dominate the panel. The user can manually
    // re-lock via the lock button if they want the chapter expanded
    // while hidden (e.g. for last-glance reference). Auto-unlock is a
    // one-shot side-effect of hide; un-hiding doesn't touch the lock.
    if (next) chap.locked = false;
    state.setState({ chapters: [...chapters] });
    state.markDirty();
  }

  /**
   * Returns true when the step would be encoded by export / advanced by
   * playback navigation — i.e. it's not the hidden base step, not
   * marked hidden itself, and its chapter (if any) is not hidden.
   * Centralised so every playback / export call site reads the same
   * rules. Build a chapter map up front in tight loops.
   */
  _isPlayable(step, chaptersById = null) {
    if (!step || step.hidden || step.isBaseStep) return false;
    if (step.chapterId) {
      const ch = chaptersById
        ? chaptersById.get(step.chapterId)
        : (state.get('chapters') || []).find(c => c.id === step.chapterId);
      if (ch?.hidden) return false;
    }
    return true;
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  CHAPTER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════
  /** Toggle a chapter's locked flag (locked => always expanded in timeline). */
  setChapterLocked(chapterId, locked) {
    const chapters = state.get('chapters') || [];
    const updated  = chapters.map(c => c.id === chapterId ? { ...c, locked: !!locked } : c);
    state.setState({ chapters: updated });
    state.markDirty();
  }

  /** Assign a step to a chapter (null = no chapter). */
  assignChapter(stepId, chapterId) {
    const steps = state.get('steps');
    const step  = steps.find(s => s.id === stepId);
    if (!step) return;
    step.chapterId = chapterId ?? null;
    state.setState({ steps: [...steps] });
    this.normalizeOrder();
    state.markDirty();
  }

  /**
   * Re-sort state.steps so it matches visual order:
   *   [base step] → [chapter 1 steps in their relative order]
   *                → [chapter 2 steps ...]
   *                → [ungrouped steps at end]
   *
   * The visual timeline (badges, next/prev) iterates state.steps directly,
   * so keeping the array == display order is the single source of truth.
   * Call after any mutation that may diverge the two (assign chapter,
   * delete chapter, create step, move step).
   */
  normalizeOrder() {
    const all       = state.get('steps') || [];
    const chapters  = state.get('chapters') || [];
    const chIds     = new Set(chapters.map(c => c.id));
    const base      = all.filter(s =>  s.isBaseStep);
    const nonBase   = all.filter(s => !s.isBaseStep);
    const byCh      = new Map();
    const ungrouped = [];
    for (const s of nonBase) {
      if (s.chapterId && chIds.has(s.chapterId)) {
        if (!byCh.has(s.chapterId)) byCh.set(s.chapterId, []);
        byCh.get(s.chapterId).push(s);
      } else {
        ungrouped.push(s);
      }
    }
    // Order: base → ungrouped → chapters (in chapter-list order).
    // Placing ungrouped BEFORE chapter sections makes newly-created empty
    // chapters appear at the true end of the timeline, and prevents older
    // ungrouped steps from visually "falling under" a new chapter header.
    const newOrder = [...base, ...ungrouped];
    for (const c of chapters) newOrder.push(...(byCh.get(c.id) || []));

    // Only emit state change if order actually differs (avoid render churn).
    const sameOrder = newOrder.length === all.length
      && newOrder.every((s, i) => s === all[i]);
    if (sameOrder) return;
    state.setState({ steps: newOrder });
  }

  /**
   * Move a step: set its chapterId and relocate it in the steps array.
   * Atomic — emits a single state change so the UI renders once.
   * @param {string}      stepId
   * @param {string|null} chapterId   target chapter (null = ungrouped)
   * @param {number}      newIndex    target index in the flat steps array
   */
  moveStepToChapter(stepId, chapterId, newIndex) {
    const steps  = [...state.get('steps')];
    const oldIdx = steps.findIndex(s => s.id === stepId);
    if (oldIdx < 0) return;

    const [step] = steps.splice(oldIdx, 1);
    step.chapterId = chapterId ?? null;
    steps.splice(Math.max(0, Math.min(steps.length, newIndex)), 0, step);

    state.setState({ steps });
    this.normalizeOrder();
    state.markDirty();
    state.emit('steps:reordered');
  }

  /**
   * Move multiple steps as a contiguous block to a new index + chapter.
   * Relative order of the moved steps is preserved (sorted by current
   * array position before insertion).
   *
   * @param {string[]}     stepIds    ids of steps to move (order doesn't matter)
   * @param {string|null}  chapterId  target chapter (null = ungrouped)
   * @param {number}       newIndex   target insertion index in the full array
   */
  moveStepsToChapter(stepIds, chapterId, newIndex) {
    if (!stepIds?.length) return;
    const steps   = [...state.get('steps')];
    const moveSet = new Set(stepIds);

    // Collect the moved steps, preserving their current relative order.
    const toMove = steps
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => moveSet.has(s.id))
      .sort((a, b) => a.i - b.i)
      .map(({ s }) => s);
    if (!toMove.length) return;

    // Everything except the moved steps, in current order.
    const remaining = steps.filter(s => !moveSet.has(s.id));

    // Adjust insertIdx: every moved step originally before insertIdx shifts it left.
    let adjusted = newIndex;
    for (const s of toMove) {
      if (steps.indexOf(s) < newIndex) adjusted--;
    }
    adjusted = Math.max(0, Math.min(remaining.length, adjusted));

    // Stamp chapterId on every moved step.
    for (const s of toMove) s.chapterId = chapterId ?? null;

    const merged = [
      ...remaining.slice(0, adjusted),
      ...toMove,
      ...remaining.slice(adjusted),
    ];

    state.setState({ steps: merged });
    this.normalizeOrder();
    state.markDirty();
    state.emit('steps:reordered');
  }

  /**
   * Reorder a whole chapter — moves the chapter and every step that belongs to
   * it as one block. The chapter list and the steps list are updated together.
   * @param {string} chapterId
   * @param {number} newChapterIdx   index in the chapters array
   */
  reorderChapter(chapterId, newChapterIdx) {
    const chapters = [...(state.get('chapters') || [])];
    const oldIdx   = chapters.findIndex(c => c.id === chapterId);
    if (oldIdx < 0) return;

    const [chapter] = chapters.splice(oldIdx, 1);
    const clampedIdx = Math.max(0, Math.min(chapters.length, newChapterIdx));
    chapters.splice(clampedIdx, 0, chapter);

    // Rebuild steps order: for each chapter in new order, emit its steps in
    // their original relative order; ungrouped steps keep their positions
    // relative to the nearest preceding chapter.
    const allSteps    = state.get('steps') || [];
    const byChapter   = new Map();
    const ungrouped   = [];
    for (const s of allSteps) {
      if (s.chapterId && chapters.some(c => c.id === s.chapterId)) {
        if (!byChapter.has(s.chapterId)) byChapter.set(s.chapterId, []);
        byChapter.get(s.chapterId).push(s);
      } else {
        ungrouped.push(s);
      }
    }
    const newSteps = [];
    for (const c of chapters) {
      const chSteps = byChapter.get(c.id) || [];
      newSteps.push(...chSteps);
    }
    newSteps.push(...ungrouped);

    state.setState({ chapters, steps: newSteps });
    state.markDirty();
    state.emit('steps:reordered');
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  VOICE / NARRATION TEXT
  // ═══════════════════════════════════════════════════════════════════════
  setVoiceText(stepId, text) {
    const steps = state.get('steps');
    const step  = steps.find(s => s.id === stepId);
    if (!step) return;
    step.voiceText    = text ?? '';
    step.voiceEnabled = typeof text === 'string' && text.trim().length > 0;
    state.setState({ steps: [...steps] });
    state.markDirty();
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  GETTERS
  // ═══════════════════════════════════════════════════════════════════════
  getActiveStep() { return this._getActiveStep(); }

  getStepById(id) {
    return state.get('steps').find(s => s.id === id) ?? null;
  }

  getVisibleSteps() {
    return state.get('steps').filter(s => this._isPlayable(s));
  }

  getStepIndex(stepId) {
    return state.get('steps').findIndex(s => s.id === stepId);
  }

  // ─── Base Step (Step 0) ──────────────────────────────────────────────────

  /**
   * Return the hidden base step, or null if not present.
   * The base step is never shown in the timeline and is not user-navigable.
   */
  getBaseStep() {
    return state.get('steps').find(s => s.isBaseStep) ?? null;
  }

  /**
   * Create or update the hidden base step with the CURRENT scene state.
   * Called by saveProject() before serialisation so the file contains an
   * exact scene snapshot that can be used as a staging area on load.
   */
  upsertBaseStep() {
    const stepsArr = state.get('steps') || [];
    const snapshot = this.captureSnapshot();
    const existing = stepsArr.find(s => s.isBaseStep);
    if (existing) {
      existing.snapshot = snapshot;
      state.setState({ steps: [...stepsArr] });
    } else {
      const base = createStep({ name: '__base__' });
      base.isBaseStep = true;
      base.hidden     = true;
      base.snapshot   = snapshot;
      base.transition = { durationMs: 0 };
      state.setState({ steps: [base, ...stepsArr] });
    }
  }

  /**
   * Apply the base step snapshot instantly (no animation, no activeStepId change).
   * Call after project load, before activating the first user step, to stage
   * the scene in the exact saved state.
   */
  activateBaseStep() {
    const base = this.getBaseStep();
    if (base?.snapshot) this.applySnapshotInstant(base.snapshot, { suppressCamera: true });
  }

  /**
   * Asset-reintegration contract.
   *
   * A reintegration ALWAYS begins by rebasing the scene to step 0 (home
   * coordinates), then replays the user's active step on top, then sweeps
   * any orphan placeholder bounding boxes. This guarantees every reintegrate
   * is a clean full-cycle, not a partial patch.
   *
   * Call from _relinkAsset (or any future reintegration entry point) AFTER
   * the id remap + phantom cleanup is complete.
   *
   * @param {string|null} activeStepId   step to re-apply after step 0 (null = stay on step 0)
   */
  reintegrateFromStep0(activeStepId) {
    this.activateBaseStep();
    if (activeStepId) this.activateStep(activeStepId, false);
    this.removeOrphanedPlaceholders();
  }

  /**
   * Sweep the scene for placeholder LineSegments (the wireframe Bbox
   * boxes the rebuild creates for missing-mesh nodes) whose data node
   * is no longer flagged `missing` — i.e. asset re-integration just
   * provided the real geometry. Without this, after a relink the
   * placeholder stays parented next to the real mesh and renders as
   * a stray wireframe ghost.
   */
  removeOrphanedPlaceholders() {
    const nodeById = state.get('nodeById');
    if (!nodeById || !sceneCore.rootGroup) return;
    const toRemove = [];
    sceneCore.rootGroup.traverse(obj => {
      if (!obj?.userData?.isPlaceholder) return;
      const id = obj.userData.meshNodeId;
      const node = id ? nodeById.get(id) : null;
      if (!node || node.missing === false) toRemove.push(obj);
    });
    for (const obj of toRemove) {
      if (obj.parent) obj.parent.remove(obj);
      try { obj.geometry?.dispose?.(); } catch {}
      try { obj.material?.dispose?.(); } catch {}
      // If this placeholder was registered under the node's id, clear
      // the registry entry so a stale ref doesn't shadow the real mesh.
      if (obj.userData?.meshNodeId && this.object3dById.get(obj.userData.meshNodeId) === obj) {
        this.object3dById.delete(obj.userData.meshNodeId);
      }
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════
  _getActiveStep() {
    const id    = state.get('activeStepId');
    const steps = state.get('steps');
    return steps.find(s => s.id === id) ?? null;
  }

  _nextStepLabel(steps) {
    const num = steps.filter(s => !s.isBaseStep).length + 1;
    return `Step ${num}`;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  SCENE PROPAGATION HELPERS
// (Call Three.js directly — require object3dById map from steps instance)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply visibility from nodeById data to Three.js objects.
 * A node is visible only if it AND all ancestors are localVisible=true.
 */
function applyAllVisibilityToScene(nodeById, object3dById) {
  // We need the tree root to do ancestor-aware visibility
  const root = state.get('treeData');
  if (!root) return;

  // Isolate overlay: while active, visibility comes from the keep-set instead of
  // each node's per-step localVisible (which stays untouched for un-isolate).
  const keep = isIsolateActive() ? getIsolateKeepSet() : null;

  // Walk tree, track inherited visibility. Archive trumps localVisible —
  // archived nodes (and their descendants) are forced invisible regardless
  // of any per-step snapshot. Matches computeVisibleSet in core/nodes.js.
  function walk(node, inherited) {
    const nodeVis   = keep ? keep.has(node.id) : node.localVisible;
    const effective = inherited && nodeVis && !node.archived;
    const obj = object3dById.get(node.id);
    if (obj) {
      // Bbox placeholders honor the sticky export-hide flag so they stay
      // out of the encoded video even after each step transition re-runs
      // this pass. Real geometry + phantom-folder Groups follow normal
      // visibility rules.
      obj.visible = (_placeholdersHidden && obj.userData?.isPlaceholder)
        ? false
        : effective;
    }
    node.children.forEach(c => walk(c, effective));
  }

  walk(root, true);
}

/**
 * Remove all custom folder Three.js groups under a subtree from the scene.
 * Must be called before rebuildFromTreeSpec so stale groups don't linger.
 *
 * @param {TreeNode}             rootNode     model or scene node to clean under
 * @param {Map<string,Object3D>} object3dById
 */
function cleanupFolderGroups(rootNode, object3dById) {
  if (!rootNode) return;
  flatten(rootNode).forEach(node => {
    if (node.type !== 'folder') return;
    // Phantom (missing) folder groups are PRESERVED across rebuilds so that
    // real meshes displaced inside them are not unnecessarily reparented on
    // every step change.  Their Three.js groups are stable and reused by
    // rebuildFromTreeSpec.  Disposal happens explicitly in _relinkAsset.
    if (node.missing) return;
    const obj = object3dById.get(node.id) ?? node.object3d;
    if (obj?.parent) obj.parent.remove(obj);
    if (node.id) object3dById.delete(node.id);
  });
}

/**
 * Rebuild the Three.js hierarchy and data tree from a serialised tree spec.
 * Mirrors v0.266's rebuildTreeFromSpec:
 *   - folder nodes → fresh THREE.Group each time, added to parent3d
 *   - model nodes  → reuse existing model Three.js group (parentObject3d IS the group)
 *   - mesh nodes   → reuse live node from nodeById, reparent to parent3d
 *
 * Mutates the LIVE data-tree nodes (name, children, localVisible) in place,
 * so nodeById stays valid after the call.  Returns the rebuilt root node,
 * or null if the spec root isn't found in the live tree.
 *
 * @param {object}               spec          serialised tree (from serializeModelTree)
 * @param {Map<string,TreeNode>} nodeById      current live map
 * @param {Map<string,Object3D>} object3dById  Three.js object registry
 * @param {Object3D}             parentObject3d parent Three.js object for this level
 * @returns {TreeNode|null}
 */
function rebuildFromTreeSpec(spec, nodeById, object3dById, parentObject3d) {
  if (!spec) return null;
  const THREE = window.THREE;
  // 'group' → 'folder' is a legacy alias from v0.266 saves.
  // 'replaceModel' (B.2-NEW) is a TYPE-LAYER concept; structurally it
  // behaves exactly like its `originalType` for tree-rebuild purposes,
  // so we route it to the same branch. The live node keeps `type=
  // 'replaceModel'` — only the rebuild path uses the original type to
  // pick which Three.js scaffolding to wire up.
  let specType = spec.type === 'group' ? 'folder' : spec.type;
  if (specType === 'replaceModel') {
    specType = spec.originalType || 'folder';
  }
  let node = null;

  if (specType === 'folder') {
    if (!THREE) return null;
    const existingNode = nodeById.get(spec.id);

    if (existingNode?.missing) {
      // ── Phantom folder — REUSE the existing Three.js Group ────────────────
      // cleanupFolderGroups skips phantom folders so their groups persist.
      // Reusing them means real meshes displaced inside don't get unnecessarily
      // reparented on every step change, and transforms stay stable.
      node = existingNode;
      node.name         = spec.name || node.name || 'Folder';
      node.localVisible = spec.localVisible !== false;
      node.children     = [];

      let phantomGroup = object3dById.get(spec.id) ?? node.object3d;
      if (!phantomGroup) {
        // First encounter — create the group now and keep it for future rebuilds.
        phantomGroup = new THREE.Group();
        phantomGroup.name = spec.name || 'Folder';
        phantomGroup.userData.isPlaceholderFolder = true;
        node.object3d = phantomGroup;
      }
      // Reparent if the hierarchy changed (user moved the folder)
      if (parentObject3d && phantomGroup.parent !== parentObject3d) {
        if (phantomGroup.parent) phantomGroup.parent.remove(phantomGroup);
        parentObject3d.add(phantomGroup);
      }
      object3dById.set(spec.id, phantomGroup);

    } else {
      // ── Live folder — always create a fresh group ─────────────────────────
      // The old group was removed by cleanupFolderGroups.
      const group = new THREE.Group();
      group.name = spec.name || 'Folder';
      group.userData.isCustomFolder = true;
      if (parentObject3d) parentObject3d.add(group);
      object3dById.set(spec.id, group);

      node = existingNode ?? { id: spec.id, type: 'folder' };
      node.name         = spec.name || node.name || 'Folder';
      node.localVisible = spec.localVisible !== false;
      node.object3d     = group;
      node.children     = [];
      if (!existingNode) nodeById.set(spec.id, node);
    }

  } else if (specType === 'model') {
    // Model node: reuse existing group, reparent to new folder/scene parent if needed.
    node = nodeById.get(spec.id);
    if (!node) return null;
    node.name         = spec.name || node.name;
    node.localVisible = spec.localVisible !== false;
    node.children     = [];
    const modelObj = object3dById.get(spec.id) ?? node.object3d;
    if (modelObj && parentObject3d && modelObj.parent !== parentObject3d) {
      if (modelObj.parent) modelObj.parent.remove(modelObj);
      parentObject3d.add(modelObj);
    }
    // Clear stale missing flag once a real model group is attached.
    if (modelObj && node.missing) node.missing = false;

  } else if (specType === 'mesh') {
    // Mesh: reuse live node, reparent Three.js object to new parent.
    // For MISSING (phantom) mesh nodes, create or reuse a bounding-box
    // placeholder so the object is visible, selectable, and arrangeable
    // even while its asset file is absent.
    node = nodeById.get(spec.id);
    if (!node) return null;
    // ── Preserve note children across step rebuilds ────────────────────
    // Notes are GLOBAL — they live on the live tree, not in step
    // snapshots (serializeModelTree filters them out). The mesh branch
    // here is the only place note nodes ever sit, so we save them
    // before wiping children and re-append them at the bottom of this
    // function. Without this, every step transition would discard the
    // user's notes.
    const preservedNotes = (node.children || []).filter(c => c?.type === 'note');
    node._preservedNotesForRebuild = preservedNotes;
    node.name         = spec.name || node.name;
    node.localVisible = spec.localVisible !== false;
    // Inherit bbox from spec if node doesn't have it yet (e.g. phantom clone
    // created before bbox serialisation was added — forward-compat fallback).
    if (!node.bbox && spec.bbox) node.bbox = spec.bbox;
    // placeholderTransform — re-hydrate on load so saved phantoms render
    // at their original local rotation/scale (FBX models need this; OBJ
    // typically has identity per-mesh transforms and the field is absent).
    if (!node.placeholderTransform && spec.placeholderTransform) {
      node.placeholderTransform = spec.placeholderTransform;
    }
    node.children     = [];

    let obj = object3dById.get(spec.id) ?? node.object3d;

    if (!obj && node.missing) {
      // Create a LineSegments bounding-box placeholder for this missing mesh.
      // Reuse the existing one stored on node.object3d if already built.
      obj = _createMeshPlaceholder(node);
      if (obj) {
        node.object3d = obj;
        object3dById.set(node.id, obj);
      }
    }

    if (obj && parentObject3d && obj.parent !== parentObject3d) {
      if (obj.parent) obj.parent.remove(obj);
      parentObject3d.add(obj);
    }

    // Clear stale missing flag once a real (non-placeholder) mesh is attached.
    if (obj && !obj.userData?.isPlaceholder && node.missing) node.missing = false;

    // Ensure userData reflects the current node ID on every tree rebuild.
    // This guards against ID drift after the relink remap cycle — without
    // this, hit.object.userData.meshNodeId could be stale and picking fails.
    if (obj && obj.userData && !node.missing) {
      obj.userData.meshNodeId = node.id;
      obj.userData.nodeId     = node.id;
    }

  } else if (specType === 'flatShape') {
    // Flat 2D shape (M1 — "2D shapes in 3D"). Reuse the live node so its
    // shapePath + fill survive every rebuild. Build the THREE.Mesh on
    // first encounter (e.g. just after project load) and reparent on
    // subsequent rebuilds — the data tree is the source of truth, the
    // saved spec only carries id/type/name/visibility.
    node = nodeById.get(spec.id);
    if (!node) return null;
    node.name         = spec.name || node.name;
    node.localVisible = spec.localVisible !== false;
    // Restore the template pointer / baked plane from the spec if the live node
    // somehow lost them — keeps the mesh buildable across rebuilds.
    if (spec.templateId)           node.templateId          = spec.templateId;
    if (spec.planeLocalQuaternion) node.planeLocalQuaternion = spec.planeLocalQuaternion;
    node.children     = [];

    // Replace-Model with an already-built wrap-group (B.2-NEW): SKIP
    // ensureFlatShapeObject3D — that builder would dispose the wrap-
    // group's children and replace it with a fresh flatShape Mesh,
    // destroying the RM's wrap structure on every step navigation. Just
    // reparent the existing wrap-group as needed and let the children
    // recursion below handle the RM's copy children.
    if (node.type === 'replaceModel' &&
        node.object3d?.userData?.isReplaceModelGroup) {
      const wrapObj = node.object3d;
      if (parentObject3d && wrapObj.parent !== parentObject3d) {
        if (wrapObj.parent) wrapObj.parent.remove(wrapObj);
        parentObject3d.add(wrapObj);
      }
      object3dById.set(spec.id, wrapObj);
    } else {
      // Normal flatShape (or RM with no wrap yet — first activateBaseStep
      // on initial load runs before rebuildReplaceModelChildren wraps it).
      //
      // Always run ensureFlatShapeObject3D — it has its own cache-hit
      // fast path (matching shapeBuildKey returns the existing mesh) AND
      // that path also re-asserts materials.meshById registration.
      let obj = ensureFlatShapeObject3D(node);
      if (obj) {
        node.object3d = obj;
        object3dById.set(spec.id, obj);
        if (parentObject3d && obj.parent !== parentObject3d) {
          if (obj.parent) obj.parent.remove(obj);
          parentObject3d.add(obj);
        }
        if (obj.userData) {
          obj.userData.flatShapeNodeId = node.id;
          obj.userData.meshNodeId      = node.id;
          obj.userData.nodeId          = node.id;
        }
      }
    }

  } else if (specType === 'hardwareInstance') {
    // V0.2.22.38 — procedural hardware. Same lazy-build pattern as
    // flatShape: ensureHardwareInstanceObject3D returns the cached Mesh
    // when the template signature matches, rebuilds when the template
    // was edited, returns null when the template is missing (orphan).
    node = nodeById.get(spec.id);
    if (!node) return null;
    node.name         = spec.name || node.name;
    node.localVisible = spec.localVisible !== false;
    node.templateId   = spec.templateId || node.templateId || null;
    node.children     = [];
    const obj = ensureHardwareInstanceObject3D(node);
    if (obj) {
      node.object3d = obj;
      object3dById.set(spec.id, obj);
      if (parentObject3d && obj.parent !== parentObject3d) {
        if (obj.parent) obj.parent.remove(obj);
        parentObject3d.add(obj);
      }
      if (obj.userData) {
        obj.userData.hardwareInstanceId = node.id;
        obj.userData.meshNodeId         = node.id;
        obj.userData.nodeId             = node.id;
      }
    }

  } else if (specType === 'primitive') {
    // V0.2.22.90 — parametric primitive. Reuse the live node and rebuild the
    // mesh from kind + params + quality (restored from the spec if the live
    // node somehow lost them, e.g. when restored from a snapshot alone).
    node = nodeById.get(spec.id);
    if (!node) {
      // Procedural + self-contained (the spec carries primKind/primParams/quality),
      // so materialise it from the spec when no live node exists yet — e.g. a
      // primitive nested in CUSTOM FOLDERS UNDER A MODEL, which the load's reattach
      // pass can't reach before those folders are rebuilt. Mirrors the folder
      // branch's create-from-spec, so the box no longer vanishes on reload.
      node = { id: spec.id, type: 'primitive' };
      nodeById.set(spec.id, node);
    }
    node.name         = spec.name || node.name;
    node.localVisible = spec.localVisible !== false;
    // Primitive shape params are STRUCTURAL (not per-step animated). Use the spec
    // only as a FALLBACK when the live node lost them — otherwise an unconditional
    // overwrite from a stale snapshot reset a resized box back to default dimensions
    // on load (the live node already carries the correct saved params).
    if (spec.primKind    && !node.primKind)              node.primKind    = spec.primKind;
    if (spec.primParams  && !node.primParams)            node.primParams  = spec.primParams;
    if (spec.primQuality != null && node.primQuality == null) node.primQuality = spec.primQuality;
    if (spec.primLinkId  && !node.primLinkId)            node.primLinkId  = spec.primLinkId;
    if (spec.baseAtOrigin != null && node.baseAtOrigin == null) node.baseAtOrigin = spec.baseAtOrigin;
    node.children     = [];
    const obj = ensurePrimitiveObject3D(node);
    if (obj) {
      node.object3d = obj;
      object3dById.set(spec.id, obj);
      if (parentObject3d && obj.parent !== parentObject3d) {
        if (obj.parent) obj.parent.remove(obj);
        parentObject3d.add(obj);
      }
      if (obj.userData) {
        obj.userData.primitiveNodeId = node.id;
        obj.userData.meshNodeId      = node.id;
        obj.userData.nodeId          = node.id;
      }
    }

  } else if (specType === 'hardwareNut') {
    // V0.2.22.78 — bolt-driven nut. Geometry derives from the bolt's
    // diameter; the mesh attaches UNDER the bolt's mesh (parentObject3d is
    // the bolt — see childParent below) so it inherits the bolt transform.
    node = nodeById.get(spec.id);
    if (!node) return null;
    node.name           = spec.name || node.name;
    node.localVisible   = spec.localVisible !== false;
    node.boltTemplateId = spec.boltTemplateId || node.boltTemplateId || null;
    node.children       = [];
    const obj = ensureHardwareNutObject3D(node);
    if (obj) {
      node.object3d = obj;
      object3dById.set(spec.id, obj);
      if (parentObject3d && obj.parent !== parentObject3d) {
        if (obj.parent) obj.parent.remove(obj);
        parentObject3d.add(obj);
      }
      if (obj.userData) {
        obj.userData.hardwareInstanceId = node.id;
        obj.userData.meshNodeId         = node.id;
        obj.userData.nodeId             = node.id;
      }
    }

  } else {
    // scene root or unknown — pass through; use node.object3d as parent for children
    node = nodeById.get(spec.id);
    if (!node) return null;
    node.children = [];
  }

  // Determine which Three.js object children should attach to.
  //   - folder / scene own a group; their data-children parent under it.
  //   - model children attach to the model's outer group. (Source
  //     transform is baked into mesh vertices, no inner group needed.)
  //   - mesh nodes carry a Mesh; flatShape children of a mesh need to
  //     parent UNDER that Mesh in Three.js so they inherit its world
  //     transform (cable mesh-anchor style). Notes on a mesh have no
  //     object3d so the parent doesn't matter for them.
  //   - flatShape itself has no children in v1, so its branch never
  //     recurses; childParent there is irrelevant but kept consistent.
  //   - hardwareInstance is leaf-only (V0.2.22.38), same as flatShape.
  let childParent;
  if (specType === 'flatShape' || specType === 'hardwareNut') {
    childParent = parentObject3d;   // leaf — no meaningful Three.js children
  } else if (specType === 'hardwareInstance') {
    // V0.2.22.78 — a bolt's nut child renders UNDER the bolt's mesh so it
    // inherits the bolt's world transform (bolt-driven).
    childParent = object3dById.get(spec.id) ?? node?.object3d ?? parentObject3d;
  } else {
    childParent = object3dById.get(spec.id) ?? node?.object3d ?? parentObject3d;
  }

  for (const childSpec of (spec.children || [])) {
    const childNode = rebuildFromTreeSpec(childSpec, nodeById, object3dById, childParent);
    if (childNode) node.children.push(childNode);
  }

  // Re-attach any note children that were preserved at the start of this
  // mesh's rebuild (see the mesh branch above). Notes are global —
  // they survive step transitions because they're never IN the step
  // spec to begin with.
  if (specType === 'mesh' && node._preservedNotesForRebuild?.length) {
    for (const n of node._preservedNotesForRebuild) node.children.push(n);
    delete node._preservedNotesForRebuild;
  }

  return node;
}

// ─── Placeholder helpers ───────────────────────────────────────────────────

/**
 * Resolve the outline color for a missing-asset placeholder.
 * Uses the node's saved colorPresetId if available; falls back to amber.
 */
function _resolvePlaceholderColor(node) {
  if (node.colorPresetId) {
    const presets = state.get('colorPresets') || [];
    const preset  = presets.find(p => p.id === node.colorPresetId);
    if (preset?.color) return preset.color;
  }
  return '#ff8c00';   // amber — immediately recognisable as "missing asset"
}

/**
 * Build a THREE.LineSegments bounding-box placeholder for a missing mesh node.
 *
 * The box matches the saved geometry extents (bbox) and is positioned at the
 * bbox centre so it sits exactly where the real mesh would appear within its
 * parent folder group.  The outline colour comes from the node's colorPresetId
 * (or amber if no preset is assigned).
 *
 * The returned object has:
 *   userData.meshNodeId    — enables picking / selection
 *   userData.isPlaceholder — distinguishes it from real geometry
 *
 * @param {TreeNode} node   phantom mesh data node
 * @returns {THREE.LineSegments|null}
 */
function _createMeshPlaceholder(node) {
  const THREE = window.THREE;
  if (!THREE) return null;

  const bbox = node.bbox;
  let edgesGeom;
  let cx = 0, cy = 0, cz = 0;
  if (bbox
    && isFinite(bbox.min[0]) && isFinite(bbox.max[0])
    && isFinite(bbox.min[1]) && isFinite(bbox.max[1])
    && isFinite(bbox.min[2]) && isFinite(bbox.max[2])
  ) {
    const w = Math.max(bbox.max[0] - bbox.min[0], 1e-4);
    const h = Math.max(bbox.max[1] - bbox.min[1], 1e-4);
    const d = Math.max(bbox.max[2] - bbox.min[2], 1e-4);
    edgesGeom = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
    cx = (bbox.min[0] + bbox.max[0]) / 2;
    cy = (bbox.min[1] + bbox.max[1]) / 2;
    cz = (bbox.min[2] + bbox.max[2]) / 2;
  } else {
    // No saved bbox (old project format) — use a visible default cube.
    // 50 units = 50 mm at SBS/OCCT scale, visible for typical mechanical parts.
    edgesGeom = new THREE.EdgesGeometry(new THREE.BoxGeometry(50, 50, 50));
  }

  const color    = _resolvePlaceholderColor(node);
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
  const lines    = new THREE.LineSegments(edgesGeom, material);

  lines.userData.meshNodeId    = node.id;
  lines.userData.isPlaceholder = true;
  // Sticky export-time hide: when set, the newly built placeholder
  // spawns invisible so the encoder never sees it. Cleared when export
  // unwinds via setPlaceholderBboxesVisible(true).
  if (_placeholdersHidden) lines.visible = false;

  // Position the placeholder. Two paths:
  //   - placeholderTransform present (set by deleteTopLevelAssembly,
  //     captures the original mesh's local position/rotation/scale):
  //     apply it to the LineSegments + translate the BoxGeometry by
  //     the bbox centre, so the wireframe lands at the same world
  //     orientation the original mesh occupied. Required for FBX
  //     models whose loader puts non-identity transforms on each mesh.
  //   - otherwise (legacy / load-time missing-asset path): position
  //     the LineSegments at the bbox centre in folder-local space and
  //     leave rotation/scale at identity. Matches pre-existing
  //     behaviour for OBJ-imported missing-asset projects.
  const pt = node.placeholderTransform;
  if (pt && Array.isArray(pt.position) && Array.isArray(pt.quaternion)) {
    edgesGeom.translate(cx, cy, cz);
    lines.position.set(pt.position[0], pt.position[1], pt.position[2]);
    lines.quaternion.set(pt.quaternion[0], pt.quaternion[1], pt.quaternion[2], pt.quaternion[3]);
    if (Array.isArray(pt.scale)) {
      lines.scale.set(pt.scale[0], pt.scale[1], pt.scale[2]);
    }
  } else {
    lines.position.set(cx, cy, cz);
  }

  return lines;
}

/**
 * Force Three.js parent-child hierarchy to match a target parentMap.
 * Checks CURRENT Three.js parent vs target and moves only if different.
 * Works even when objects are at an unexpected location (e.g. rootGroup
 * after animation detach) — does not rely on detected data-tree moves.
 *
 * @param {Object}                 parentMap    { [nodeId]: parentId }
 * @param {Map<string,TreeNode>}   nodeById
 * @param {Map<string,Object3D>}   object3dById
 */
function syncThreeJsHierarchy(parentMap, nodeById, object3dById) {
  if (!parentMap) return;
  for (const [nodeId, targetParentId] of Object.entries(parentMap)) {
    const obj       = object3dById.get(nodeId)         ?? nodeById.get(nodeId)?.object3d;
    const parentNode = nodeById.get(targetParentId);
    const parentObj = object3dById.get(targetParentId) ?? parentNode?.object3d;
    if (!obj || !parentObj) continue;
    if (obj.parent === parentObj) continue;
    if (obj.parent) obj.parent.remove(obj);
    parentObj.add(obj);
  }
}

/**
 * Apply transforms from nodeById data to Three.js objects.
 */
function applyAllTransformsToScene(nodeById, object3dById) {
  for (const [id, node] of nodeById) {
    if (!isTransformNode(node)) continue;
    const obj = object3dById.get(id);
    if (obj) applyNodeTransformToObject3D(node, obj, false);
  }
  // Batch matrix world update
  const root3d = sceneCore.rootGroup;
  if (root3d) root3d.updateMatrixWorld(true);
}


// ─── World-space transform helpers ────────────────────────────────────────

/**
 * Set a Three.js Object3D to a given WORLD position + quaternion, regardless
 * of what parent hierarchy it is currently in. Mirrors v0.266's
 * setObjectWorldTransform — does a proper world→local conversion so the
 * object's LOCAL position/quaternion produce the requested world transform.
 *
 * Call after the target hierarchy has been built and parent matrices are
 * current (i.e. after _warmMatrices). Also updates the object's own matrix
 * so subsequent sibling/child calls see the correct parent matrix.
 *
 * @param {THREE.Object3D} obj
 * @param {number[]}       worldPos   [x,y,z]
 * @param {number[]}       worldQuat  [x,y,z,w]
 */
/**
 * Decompose `child_world × inv(parent_world)` into a local pose. Used at
 * transition-setup time so children of an ANIMATING transform-node can
 * lerp in PARENT-LOCAL space — that's what makes a flatShape ride its
 * parent's rotation arc instead of taking the chord between its world
 * FROM and TO positions.
 *
 * Without this, a shape on a rotating part takes a straight line in world
 * space while the part it's stuck to traces an arc — the shape visibly
 * "dips in and out" of the surface. With local-space lerp, child sticks
 * to parent for free via Three.js's scene-graph matrix propagation.
 *
 * Scale is ignored (we only animate position + quaternion).
 *
 * @param {{position:number[], quaternion:number[]}} parentWorld
 * @param {{position:number[], quaternion:number[]}} childWorld
 * @returns {{position:number[], quaternion:number[]}}
 */
function _composeLocalFromWorlds(parentWorld, childWorld) {
  const THREE = window.THREE;
  const ONE   = new THREE.Vector3(1, 1, 1);
  const pMat = new THREE.Matrix4().compose(
    new THREE.Vector3(...parentWorld.position),
    new THREE.Quaternion(...parentWorld.quaternion),
    ONE,
  );
  const cMat = new THREE.Matrix4().compose(
    new THREE.Vector3(...childWorld.position),
    new THREE.Quaternion(...childWorld.quaternion),
    ONE,
  );
  const localMat = new THREE.Matrix4().copy(pMat).invert().multiply(cMat);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  localMat.decompose(pos, quat, scl);
  return {
    position:   [pos.x, pos.y, pos.z],
    quaternion: [quat.x, quat.y, quat.z, quat.w],
  };
}

/**
 * Build the extras object pushed alongside a transition entry when the
 * node's tree-parent is ALSO animating. Returns `{}` when no inheritance
 * is needed (parent static → world-space lerp is correct).
 */
/**
 * If the node has a non-zero pivot enabled on BOTH FROM and TO sides,
 * compute the world-space pivot pose at both endpoints + the lerp data
 * the runtime tick needs to spin the object around that pivot. When
 * absent (no pivot / disabled / zero offset), returns `{}` — the runtime
 * falls through to the plain world-pos+quat lerp it always used.
 *
 * Math:
 *   pivot_world = obj_pos + applyQuat(obj_quat, pivot_local)
 * If the user's "blue pivot is consistent across both steps" condition
 * holds (which is the entire point of the back-solve at edit time),
 * pivot_world_from == pivot_world_to → during lerp the pivot point is
 * a constant and the object arcs cleanly around it.
 *
 * NOT used when the node also inherits from an animating parent
 * (parent-arc branch wins for now — the combined case isn't on the
 * user's critical path; logged as a follow-up).
 */
function _buildPivotExtras(worldFrom, worldTo) {
  const THREE = window.THREE;
  if (!THREE || !worldFrom || !worldTo) return {};
  // Both sides must have an active non-zero pivot. Disabled-on-one-side
  // or zero-pivot → standard lerp is identical, no extras needed.
  if (!worldFrom.pivotEnabled || !worldTo.pivotEnabled) return {};
  const pivLocalFrom = worldFrom.pivotLocalOffset || [0, 0, 0];
  const pivLocalTo   = worldTo.pivotLocalOffset   || [0, 0, 0];
  const _isZero = v => Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2]) < 1e-7;
  if (_isZero(pivLocalFrom) && _isZero(pivLocalTo)) return {};

  // pivotWorld_X = worldPos_X + rotate(worldQuat_X, pivotLocal_X)
  const computePivotWorld = (wt, pivLocal) => {
    const offW = new THREE.Vector3(pivLocal[0], pivLocal[1], pivLocal[2])
      .applyQuaternion(new THREE.Quaternion(...wt.quaternion));
    return [
      wt.position[0] + offW.x,
      wt.position[1] + offW.y,
      wt.position[2] + offW.z,
    ];
  };
  return {
    pivotData: {
      worldFrom: computePivotWorld(worldFrom, pivLocalFrom),
      worldTo:   computePivotWorld(worldTo,   pivLocalTo),
      localFrom: [...pivLocalFrom],
      localTo:   [...pivLocalTo],
    },
  };
}

function _buildInheritExtras(nodeId, worldFrom, worldTo, parentMap, changedSet, fromWT, toWT) {
  const parentId = parentMap[nodeId];
  if (!parentId || !changedSet.has(parentId)) return {};
  const parentFrom = fromWT[parentId];
  const parentTo   = toWT[parentId];
  if (!parentFrom || !parentTo) return {};
  return {
    inheritParentId: parentId,
    localFrom:       _composeLocalFromWorlds(parentFrom, worldFrom),
    localTo:         _composeLocalFromWorlds(parentTo,   worldTo),
  };
}

/**
 * V0.2.22.17 Stage 1 — write data-state back from a Three.js Object3D
 * whose local matrix (obj.position / obj.quaternion) was just set by an
 * animation tick. Without this, the animation engine only updates the
 * scene graph; node.localOffset and node.localQuaternion stay at their
 * pre-animation values. The end-of-transition applySnapshotInstant snap
 * then "writes the answer in" — but at any moment AFTER the last animation
 * tick and BEFORE the snap, the data state lags. That mismatch is the
 * source of the visible seam stutter (the encoder captures a frame
 * sampled at lerp(t<1), the snap then jumps the Object3D to the exact
 * snapshot.transforms value, the next captured frame shows that jump).
 *
 * With per-frame data writes:
 *   - On the last animation tick, alpha clamps to 1.0 →
 *     lerped local pose = exact target → node.localOffset / Quaternion
 *     also match exact target.
 *   - The subsequent applySnapshotInstant snap reads the same target
 *     values from snapshot.transforms and writes the same values to
 *     node.localOffset / Quaternion. No-op. No visible jump.
 *
 * Stage 1 keeps the snap in place as a safety net + verifier. Stage 2
 * (later commit) will instrument & confirm zero drift. Stage 3 removes
 * the snap entirely once verified clean.
 *
 * Only applies to TRANSFORM-bearing nodes (folder/model/flatShape).
 * Mesh nodes don't carry per-node deltas — their pose is the parent
 * chain × baked vertex positions, so no data state to write back.
 */
function _writeDataStateFromObject3D(node, obj) {
  if (!node || !obj || !isTransformNode(node)) return;
  const blp = node.baseLocalPosition  || [0, 0, 0];
  const blq = node.baseLocalQuaternion || [0, 0, 0, 1];
  // localOffset = obj.position (local-relative-to-parent) − baseLocalPosition.
  node.localOffset = [
    obj.position.x - blp[0],
    obj.position.y - blp[1],
    obj.position.z - blp[2],
  ];
  // localQuaternion = inv(baseLocalQuaternion) × obj.quaternion.
  const THREE = window.THREE;
  if (THREE) {
    const baseQ  = new THREE.Quaternion(blq[0], blq[1], blq[2], blq[3]).invert();
    const localQ = baseQ.multiply(obj.quaternion);
    node.localQuaternion  = [localQ.x, localQ.y, localQ.z, localQ.w];
    node.orientationSteps = quarterTurnsFromQuaternion(node.localQuaternion);
  }
}

function _setWorldTransformOnObject(obj, worldPos, worldQuat) {
  const THREE = window.THREE;
  if (!THREE || !obj) return;

  const parent = obj.parent;
  // Ensure the parent's world matrix is current before converting.
  // updateWorldMatrix(true, false) = update ancestors up the chain but NOT
  // children (we only need the parent's matrix for the inversion below).
  if (parent) parent.updateWorldMatrix(true, false);

  // Build the target world matrix from the requested world pos + quat.
  // We preserve the object's current SCALE (we only animate position/rotation).
  const worldMatrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...worldPos),
    new THREE.Quaternion(...worldQuat),
    obj.scale.clone(),       // preserve current scale
  );

  // Convert world matrix → local matrix using the parent's world matrix.
  const localMatrix = parent
    ? new THREE.Matrix4().copy(parent.matrixWorld).invert().multiply(worldMatrix)
    : worldMatrix;

  localMatrix.decompose(obj.position, obj.quaternion, obj.scale);

  // Update this object's own matrix so subsequent child calls see the
  // correct parent matrix when they call parent.updateWorldMatrix().
  obj.updateMatrixWorld(false);
}

/**
 * True for nodes that participate in world-transform animation:
 * model/folder nodes (user-positionable) AND mesh nodes (follow their parent
 * but must be tracked so folder-reparenting jumps can be animated).
 */
function isAnimatableNode(node) {
  return isTransformNode(node) || node?.type === 'mesh';
}

/**
 * Capture world-space position + quaternion for every animatable node
 * (model, folder, AND mesh). Mesh world transforms are captured so that
 * reparenting to/from rotated folders can be animated smoothly.
 * Call AFTER warmMatrices() so all matrices are current.
 * @param {TreeNode}            root
 * @param {Map<string,Object3D>} object3dById
 * @returns { [nodeId]: { position: number[], quaternion: number[] } }
 */
function captureWorldTransforms(root, object3dById) {
  const out  = {};
  const THREE = window.THREE;
  if (!THREE || !root) return out;
  const _wp = new THREE.Vector3();
  const _wq = new THREE.Quaternion();
  flatten(root).forEach(node => {
    if (!isAnimatableNode(node)) return;
    const obj = object3dById.get(node.id);
    if (!obj) return;
    obj.getWorldPosition(_wp);
    obj.getWorldQuaternion(_wq);
    // Pivot fields are captured alongside world pose so the lerp can
    // run a pivot-aware path (see _buildPivotExtras + _advanceObjectTransitions
    // pivot branch). Without these, a rotation around an offset pivot
    // lerps the cylinder's ORIGIN on a chord while the rotation arcs
    // around the pivot — visible wobble where the user expects a clean
    // spin. captureTransformSnapshot already serialises these into each
    // step's persisted snapshot — we re-capture from the live node here
    // because the snapshot map isn't indexed alongside world transforms.
    out[node.id] = {
      position:     [_wp.x, _wp.y, _wp.z],
      quaternion:   [_wq.x, _wq.y, _wq.z, _wq.w],
      moveEnabled:   node.moveEnabled   !== false,
      rotateEnabled: node.rotateEnabled !== false,
      pivotEnabled:  node.pivotEnabled  !== false,
      pivotLocalOffset:     [...(node.pivotLocalOffset     || [0,0,0])],
      pivotLocalQuaternion: [...(node.pivotLocalQuaternion || [0,0,0,1])],
    };
  });
  return out;
}

/**
 * Diff two worldTransforms snapshots — return nodeIds where anything changed.
 * @param {object} fromWT
 * @param {object} toWT
 * @returns {string[]}
 */
function diffWorldTransforms(fromWT, toWT) {
  const changed = [];
  const allIds = new Set([...Object.keys(fromWT ?? {}), ...Object.keys(toWT ?? {})]);
  for (const id of allIds) {
    const from = fromWT?.[id];
    const to   = toWT?.[id];
    if (!from || !to) { changed.push(id); continue; }
    const posChanged = (from.position  ?? []).some((v, i) => Math.abs(v - (to.position?.[i]  ?? 0))       > 1e-5);
    const rotChanged = (from.quaternion ?? []).some((v, i) => Math.abs(v - (to.quaternion?.[i] ?? (i===3?1:0))) > 1e-5);
    if (posChanged || rotChanged) changed.push(id);
  }
  return changed;
}


// ── Helpers ────────────────────────────────────────────────────────────────

// ─── Balloon-note per-step state helpers ──────────────────────────────────
//
// Notes are TREE NODES under their anchor mesh (see schema.createNoteNode).
// Their text + size + anchor are GLOBAL — same on every step. Their
// panelOffset (where the balloon sits relative to the projected anchor
// point) is PER-STEP — saved into snapshot.notePanelOffsets and
// rewritten onto the live note when a step is applied. Visibility is
// already per-step via the standard snapshot.visibility map.

function _walkNotes(node, fn) {
  if (!node) return;
  if (node.type === 'note') fn(node);
  for (const c of (node.children || [])) _walkNotes(c, fn);
}

function _captureNotePanelOffsets(root) {
  const out = {};
  _walkNotes(root, n => {
    const o = n.panelOffset || { x: 0, y: 0 };
    const entry = { x: o.x ?? 0, y: o.y ?? 0 };
    // New frame-relative position model. Stored alongside legacy
    // panelOffset under a non-conflicting key. Apply path reads both
    // and prefers frame when present.
    if (n.framePosition && Number.isFinite(n.framePosition.x) && Number.isFinite(n.framePosition.y)) {
      entry.fx = n.framePosition.x;
      entry.fy = n.framePosition.y;
    }
    out[n.id] = entry;
  });
  return out;
}

function _applyNotePanelOffsets(nodeById, map) {
  for (const [id, off] of Object.entries(map || {})) {
    const note = nodeById?.get(id);
    if (note?.type === 'note') {
      note.panelOffset = { x: off.x ?? 0, y: off.y ?? 0 };
      if (Number.isFinite(off.fx) && Number.isFinite(off.fy)) {
        note.framePosition = { x: off.fx, y: off.fy };
      } else {
        // Step had no framePosition saved — clear any leftover so the
        // legacy panelOffset path takes over (and re-migrates lazily).
        delete note.framePosition;
      }
    }
  }
}

function _clearNoteAnims(nodeById) {
  if (!nodeById) return;
  for (const node of nodeById.values()) {
    if (node?.type === 'note' && node._anim) delete node._anim;
  }
}

/**
 * Snapshot every live note's CURRENT panelOffset + EFFECTIVE visibility
 * BEFORE applySnapshotAnimated mutates the live tree (rebuildFromTreeSpec
 * / _prepareVisibility). Effective vis = note's own AND every ancestor's
 * — so when the anchor mesh is hidden, the note's effective vis is
 * false even if note.localVisible is true. That way step transitions
 * that toggle the anchor's visibility correctly fade the note in/out.
 *
 * Returns: { [noteId]: { panelOffset:{x,y}, visible:bool } }
 */
function _captureFromNoteState(root) {
  const out = {};
  if (!root) return out;
  const effMap = computeEffectiveVisibility(root);
  _walkNotes(root, n => {
    const entry = {
      panelOffset: { x: n.panelOffset?.x ?? 0, y: n.panelOffset?.y ?? 0 },
      visible:     !!effMap.get(n.id),
    };
    if (n.framePosition && Number.isFinite(n.framePosition.x) && Number.isFinite(n.framePosition.y)) {
      entry.framePosition = { x: n.framePosition.x, y: n.framePosition.y };
    }
    out[n.id] = entry;
  });
  return out;
}

/**
 * Schedule per-note panel-offset + opacity fade interpolations for a
 * step transition. notes-render reads each note's _anim every tick and
 * lerps panelOffset + opacity, clearing _anim when alpha hits 1. We
 * only schedule for notes whose target state actually differs from
 * their current state — no busy-work for notes that don't move.
 *
 * fromState is captured BEFORE the live tree gets mutated (see
 * _captureFromNoteState) so we know each note's REAL pre-transition
 * state, not the post-mutation state.
 */
function _scheduleNoteAnims(treeData, fromState, toSnapshot, startMs, durationMs, easeFn, opts = {}) {
  const deferFade = !!opts.deferFade;
  if (!treeData) return;
  const toOffsets = toSnapshot?.notePanelOffsets || {};
  const toVis     = toSnapshot?.visibility || {};
  // TO-side effective visibility: simulates the visibility map that
  // _prepareVisibility is about to apply, then walks ancestors. So a
  // note whose anchor mesh is hidden in the TO step gets toVisible=false
  // and fades out — even if the note's own localVisible is true.
  const toEffMap  = computeEffectiveVisibility(treeData, toVis);
  _walkNotes(treeData, note => {
    const from = fromState?.[note.id] || {
      panelOffset: { x: note.panelOffset?.x ?? 0, y: note.panelOffset?.y ?? 0 },
      visible:     note.localVisible !== false,
    };
    const fromOffset  = from.panelOffset;
    const toOffset    = toOffsets[note.id] || fromOffset;
    const fromVisible = from.visible;
    const toVisible   = !!toEffMap.get(note.id);

    // FramePosition lerp (new model). Read from / to off the captured
    // state and the destination snapshot. If either side has it, build
    // a frame-% interpolation; the render layer prefers framePosition
    // when present and lerps between fromFP and toFP.
    const fromFP = from.framePosition
                || (note.framePosition && Number.isFinite(note.framePosition.x)
                    ? { x: note.framePosition.x, y: note.framePosition.y }
                    : null);
    const tEntry = toOffsets[note.id];
    const toFP   = (tEntry && Number.isFinite(tEntry.fx) && Number.isFinite(tEntry.fy))
                   ? { x: tEntry.fx, y: tEntry.fy }
                   : fromFP;   // missing → snap to current

    const noOffsetChange = Math.abs(fromOffset.x - toOffset.x) < 0.5
                        && Math.abs(fromOffset.y - toOffset.y) < 0.5;
    const noFPChange = !fromFP || !toFP
                       || (Math.abs(fromFP.x - toFP.x) < 0.0005
                        && Math.abs(fromFP.y - toFP.y) < 0.0005);
    const noVisChange    = fromVisible === toVisible;
    if (noOffsetChange && noFPChange && noVisChange) {
      delete note._anim;
      return;
    }
    note._anim = {
      fromOffset:  { x: fromOffset.x, y: fromOffset.y },
      toOffset:    { x: toOffset.x,   y: toOffset.y   },
      fromFP:      fromFP ? { x: fromFP.x, y: fromFP.y } : null,
      toFP:        toFP   ? { x: toFP.x,   y: toFP.y   } : null,
      fromVisible,
      toVisible,
      startMs,
      durationMs,
      easeFn,
      // Fade timing. When deferFade is true (notes channel is in the
      // animation string), set fadeStartMs to Infinity — that pegs
      // fadeT at 0 in notes-render so opacity stays at FROM until the
      // notes phase fires and _scheduleNoteFades stamps real values.
      // Otherwise leave undefined: notes-render falls back to the main
      // (move) timing — legacy behaviour where fade rides obj phase.
      fadeStartMs:    deferFade ? Infinity : undefined,
      fadeDurationMs: undefined,
      fadeEaseFn:     undefined,
    };
  });
}

/**
 * Override the FADE-only timing on each note's _anim record so notes
 * show/hide on a separate clock from their movement. Called by the
 * phased animator when the animation string includes a `notes(N)` slot.
 *
 * Side-effect-only: mutates note._anim in place. Assumes _scheduleNoteAnims
 * has already established the move-timing record. Notes whose visibility
 * doesn't change are left alone (no opacity tween to schedule).
 */
function _scheduleNoteFades(treeData, toSnapshot, startMs, durationMs, easeFn) {
  if (!treeData) return;
  _walkNotes(treeData, note => {
    const a = note._anim;
    if (!a) return;                              // nothing to fade
    if (a.fromVisible === a.toVisible) return;   // no visibility change
    a.fadeStartMs    = startMs;
    a.fadeDurationMs = Math.max(1, durationMs);
    a.fadeEaseFn     = easeFn;
  });
}


// Real-time sleep — what live playback uses. Offline export swaps this
// out via setSleepImpl so animation phases advance on a synthetic
// clock instead of being throttled by setTimeout / rAF behaviour.
let _sleepImpl = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
function _sleep(ms) { return _sleepImpl(ms); }
export function setSleepImpl(fn) {
  _sleepImpl = fn || ((ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms))));
}


// ── Singleton export ───────────────────────────────────────────────────────
export const steps = new StepManager();
export default steps;
