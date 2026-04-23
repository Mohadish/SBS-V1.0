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
import { createStep, createEmptySnapshot } from '../core/schema.js';
import { parseAnimation, resolveAnimationString } from './animation.js';
import {
  captureVisibilitySnapshot,
  applyVisibilitySnapshot,
  diffVisibility,
  captureParentMap,
  applyParentMap,
  buildNodeMap,
  flatten,
  serializeModelTree,
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
} from '../core/transforms.js';

// ── Easing helpers (mirror scene.js — no circular dependency) ─────────────
const easeSmooth = t => t * t * (3 - 2 * t);
const easeLinear = t => t;
const EASING = { smooth: easeSmooth, linear: easeLinear, instant: () => 1 };


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

    // Tick hook unsubscribe function
    this._tickUnsubscribe = null;
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

    // Register per-frame animation tick
    this._tickUnsubscribe = sceneCore.addTickHook((nowMs) => {
      this._advanceObjectTransitions(nowMs);
    });
  }

  dispose() {
    clearInterval(this._syncTimer);
    this._tickUnsubscribe?.();
    this._objectTransitions = [];
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

      // Cables (deep-copy)
      cables: JSON.parse(JSON.stringify(
        state.get('activeStepId')
          ? this._getActiveStep()?.snapshot?.cables ?? []
          : []
      )),
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

    // Camera
    if (snapshot.camera && !opts.suppressCamera) {
      sceneCore.applyCameraState(snapshot.camera);
    }

    // Sync placeholder outline colours with the step's material assignments.
    // Must run AFTER applySnapshot so meshColorAssignments are up to date.
    this._updatePlaceholderColors(nodeById);

    // Notes / screenItems / cables are applied by their own systems
    // (they listen to 'step:activate' on state)
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

    const changedNodeIds = diffWorldTransforms(fromWorldTransforms, toWorldTransforms);

    // Depth map (DFS order = parents before children — kept for transition sorting)
    const depthMap = {};
    flatten(state.get('treeData')).forEach((node, i) => { depthMap[node.id] = i; });

    // Apply target visibility now and compute which meshes are hiding/showing.
    // Hiding meshes are kept obj.visible=true for dither-fade.
    // Showing meshes will be snapped to opacity=0 so they're invisible before
    // their visibility phase.
    const { hidingMeshIds, showingMeshIds } = this._prepareVisibility(
      nodeById, toSnapshot.visibility,
    );

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

    // ── Resolve animation preset ─────────────────────────────────────────
    const animStr = resolveAnimationString(
      transition, state.get('animationPresets') || [],
    );
    const phases = animStr ? parseAnimation(animStr) : null;

    let cameraHandled = false;

    if (phases) {
      // ── PHASED MODE ───────────────────────────────────────────────────
      // Showing meshes must be invisible during pre-vis phases.
      if (showingMeshIds.length) {
        this._materials?.snapShowingToZero(showingMeshIds);
      }

      cameraHandled = await this._runPhasedAnimation(toSnapshot, phases, {
        changedNodeIds, fromWorldTransforms, toWorldTransforms, depthMap,
        hidingMeshIds, showingMeshIds,
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

      // Object transforms — world-space lerp (v0.266: objects stay in target hierarchy)
      this._objectTransitions = [];
      const startMs = performance.now();
      for (const nodeId of changedNodeIds) {
        const worldFrom = fromWorldTransforms[nodeId];
        const worldTo   = toWorldTransforms[nodeId];
        if (!worldFrom || !worldTo) continue;
        this._objectTransitions.push({ nodeId, worldFrom, worldTo, startMs, durationMs: objDur, easeFn, isWorld: true, depth: depthMap[nodeId] ?? 0 });
      }
      // Sort parents before children so world→local math uses correct parent matrices
      this._objectTransitions.sort((a, b) => a.depth - b.depth);

      // Visibility fades (BEFORE beginColorTransition)
      if (hidingMeshIds.length || showingMeshIds.length) {
        this._materials?.beginVisibilityTransitions(
          hidingMeshIds, showingMeshIds, objDur, easeFn,
        );
      }

      // Color/material transition
      if (toSnapshot.materials && this._materials) {
        this._materials.beginColorTransition(toSnapshot.materials, objDur, easeFn);
      }

      const objectP = new Promise(resolve => {
        if (!this._objectTransitions.length) { resolve(); return; }
        this._onObjectTransitionsDone = resolve;
      });

      await Promise.all([cameraP, objectP]);
    }

    // ── Guard: if a newer animation started while we awaited, bail out ──
    if (this._animGeneration !== myGen) return;

    // ── Final: snap to exact target state ─────────────────────────────
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
    const hidingMeshIds  = [];
    const showingMeshIds = [];
    if (!visibilitySnapshot || !this._materials) {
      return { hidingMeshIds, showingMeshIds };
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

    // Compute which meshes changed effective visibility
    for (const [nodeId] of this._materials.meshById) {
      const prevVis = prevMeshVis.get(nodeId) ?? false;
      const obj     = this.object3dById.get(nodeId);
      const newVis  = obj ? obj.visible : false;
      if (prevVis && !newVis) {
        hidingMeshIds.push(nodeId);
        if (obj) obj.visible = true;   // keep visible — fade will hide it
      } else if (!prevVis && newVis) {
        showingMeshIds.push(nodeId);
      }
    }

    return { hidingMeshIds, showingMeshIds };
  }

  /**
   * Run phases sequentially. Each phase starts its subset of animations and
   * waits for phaseDuration before advancing to the next phase.
   * Returns true (camera was handled by a phase) or false.
   *
   * @private
   */
  async _runPhasedAnimation(toSnapshot, phases, opts) {
    const { changedNodeIds, fromWorldTransforms, toWorldTransforms, depthMap, hidingMeshIds, showingMeshIds, easing, easeFn, myGen } = opts;

    let cameraHandled = false;
    let objHandled    = false;
    let colorHandled  = false;
    let visHandled    = false;

    for (const phase of phases) {
      const { types, durationMs } = phase;
      const phasePromises = [];

      // Camera
      if (types.includes('camera') && !cameraHandled && toSnapshot.camera) {
        cameraHandled = true;
        phasePromises.push(sceneCore.animateCameraTo(toSnapshot.camera, durationMs, easing));
      }

      // Object transforms — world-space lerp (v0.266: objects stay in target hierarchy)
      if (types.includes('obj') && !objHandled && changedNodeIds.length) {
        objHandled = true;
        this._objectTransitions = [];
        const startMs = performance.now();
        for (const nodeId of changedNodeIds) {
          const worldFrom = fromWorldTransforms[nodeId];
          const worldTo   = toWorldTransforms[nodeId];
          if (!worldFrom || !worldTo) continue;
          this._objectTransitions.push({ nodeId, worldFrom, worldTo, startMs, durationMs, easeFn, isWorld: true, depth: depthMap[nodeId] ?? 0 });
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

      // Wait for this phase's duration (and any sub-promises that finish sooner)
      await Promise.all([_sleep(durationMs), ...phasePromises]);

      // Bail if a newer animation was started while we slept
      if (myGen !== undefined && this._animGeneration !== myGen) return false;
    }

    return cameraHandled;
  }

  // ─── Object transition tick ────────────────────────────────────────────
  _advanceObjectTransitions(nowMs) {
    // Advance material colour transition every frame (independent of object transforms)
    this._materials?.advanceColorTransition(nowMs);

    // Advance per-mesh visibility fades (runs AFTER colour — overrides back-outline opacity)
    this._materials?.advanceVisibilityTransitions(nowMs, this.object3dById);

    if (!this._objectTransitions.length) return;

    const { nodeById } = state.pick('nodeById');
    const done = [];

    for (const tr of this._objectTransitions) {
      const elapsed = nowMs - tr.startMs;
      const raw     = Math.min(elapsed / tr.durationMs, 1);
      const alpha   = tr.easeFn(raw);

      const node = nodeById.get(tr.nodeId);
      const obj  = this.object3dById.get(tr.nodeId);

      if (node && obj && isAnimatableNode(node)) {
        if (tr.isWorld) {
          // World-space lerp. Objects stay in their target hierarchy; we use
          // world→local conversion (v0.266 approach) so the correct local
          // position is set regardless of which folder the node is in.
          // Parents are processed before children (depth sort) so parent
          // matrices are current when children compute their local positions.
          const lerpedPos  = lerpVec3(tr.worldFrom.position,  tr.worldTo.position,  alpha);
          const lerpedQuat = slerpQuaternion(tr.worldFrom.quaternion, tr.worldTo.quaternion, alpha);
          _setWorldTransformOnObject(obj, lerpedPos, lerpedQuat);
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
  async activateStep(stepId, animate = true) {
    const steps = state.get('steps');
    const step  = steps.find(s => s.id === stepId);
    if (!step) return;

    // If another animation is in progress (direct step card click mid-anim),
    // snap it to final so the scene is clean before starting a new transition.
    // snapCurrentToFinal does NOT rebuild the tree — it only snaps object positions
    // and materials since the tree/node data is already at the target state.
    this.snapCurrentToFinal();

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

    if (shouldAnimate) {
      this._animRunning       = true;
      this._currentTargetSnap = step.snapshot;
      await this.applySnapshotAnimated(step.snapshot, tr);
      // Only clear flags if we're still the active animation (no newer step started)
      if (myToken === this._activationToken) {
        this._animRunning                  = false;
        this._currentTargetSnap            = null;
        this._currentTargetWorldTransforms = null;
      }
    } else {
      this._animRunning       = false;
      this._currentTargetSnap = null;
      this.applySnapshotInstant(step.snapshot);
    }

    state.emit('step:applied', step);

    // Silently pre-warm the NEXT step's transition so its matrices are
    // ready before the user clicks. Discreet — deferred, no render output.
    const allSteps  = state.get('steps').filter(s => !s.hidden && !s.isBaseStep);
    const curIdx    = allSteps.findIndex(s => s.id === stepId);
    const nextStep  = allSteps[curIdx + 1];
    if (nextStep) this._prewarm(nextStep.id);
  }

  /**
   * Activate a step by index (0-based).
   */
  activateStepByIndex(index, animate = true) {
    const steps = state.get('steps').filter(s => !s.hidden && !s.isBaseStep);
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

    // Cancel the in-flight animation so applySnapshotAnimated bails on resume
    this._animGeneration++;
    if (this._onObjectTransitionsDone) {
      this._onObjectTransitionsDone();
      this._onObjectTransitionsDone = null;
    }
    this._objectTransitions = [];

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

    const steps = state.get('steps').filter(s => !s.hidden && !s.isBaseStep);
    const activeId  = state.get('activeStepId');
    const currentIdx = steps.findIndex(s => s.id === activeId);
    const nextIdx    = Math.max(0, Math.min(steps.length - 1, currentIdx + delta));
    return this.activateStep(steps[nextIdx]?.id, animate);
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
   * This is the ONLY way to update a step's camera after it was created.
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
    state.setState({ steps: [...allSteps] });
    state.markDirty();
    state.emit('step:synced', step);
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

    const label = name ?? this._nextStepLabel(steps);
    const step  = createStep({ name: label, ...overrides });
    step.snapshot = this.captureSnapshot();

    // Insert after active step, or at end
    const activeIdx = steps.findIndex(s => s.id === activeId);
    const insertAt  = activeIdx >= 0 ? activeIdx + 1 : steps.length;
    const newSteps  = [...steps];
    newSteps.splice(insertAt, 0, step);

    state.setState({ steps: newSteps });
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
    step.hidden = !!hidden;
    state.setState({ steps: [...steps] });
    state.markDirty();
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  CHAPTER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════
  /** Assign a step to a chapter (null = no chapter). */
  assignChapter(stepId, chapterId) {
    const steps = state.get('steps');
    const step  = steps.find(s => s.id === stepId);
    if (!step) return;
    step.chapterId = chapterId ?? null;
    state.setState({ steps: [...steps] });
    state.markDirty();
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
    return state.get('steps').filter(s => !s.hidden && !s.isBaseStep);
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

  // Walk tree, track inherited visibility
  function walk(node, inherited) {
    const effective = inherited && node.localVisible;
    const obj = object3dById.get(node.id);
    if (obj) obj.visible = effective;
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
  const specType = spec.type === 'group' ? 'folder' : spec.type;
  let node = null;

  if (specType === 'folder') {
    // Always create a fresh group — old group was cleaned up by cleanupFolderGroups
    if (!THREE) return null;
    const group = new THREE.Group();
    group.name = spec.name || 'Folder';
    group.userData.isCustomFolder = true;
    if (parentObject3d) parentObject3d.add(group);
    object3dById.set(spec.id, group);

    // Build or reuse the data node
    const existing = nodeById.get(spec.id);
    node = existing ?? { id: spec.id, type: 'folder' };
    node.name         = spec.name || node.name || 'Folder';
    node.localVisible = spec.localVisible !== false;
    node.object3d     = group;
    node.children     = [];
    if (!existing) nodeById.set(spec.id, node);

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

  } else if (specType === 'mesh') {
    // Mesh: reuse live node, reparent Three.js object to new parent.
    // For MISSING (phantom) mesh nodes, create or reuse a bounding-box
    // placeholder so the object is visible, selectable, and arrangeable
    // even while its asset file is absent.
    node = nodeById.get(spec.id);
    if (!node) return null;
    node.name         = spec.name || node.name;
    node.localVisible = spec.localVisible !== false;
    // Inherit bbox from spec if node doesn't have it yet (e.g. phantom clone
    // created before bbox serialisation was added — forward-compat fallback).
    if (!node.bbox && spec.bbox) node.bbox = spec.bbox;
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

  } else {
    // scene root or unknown — pass through; use node.object3d as parent for children
    node = nodeById.get(spec.id);
    if (!node) return null;
    node.children = [];
  }

  // Determine which Three.js object children should attach to.
  // folder/model/scene all own a group; mesh nodes don't.
  const childParent = (specType === 'mesh')
    ? parentObject3d
    : (object3dById.get(spec.id) ?? node?.object3d ?? parentObject3d);

  for (const childSpec of (spec.children || [])) {
    const childNode = rebuildFromTreeSpec(childSpec, nodeById, object3dById, childParent);
    if (childNode) node.children.push(childNode);
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

  // Position directly at bbox centre within the parent folder group.
  // We set lines.position explicitly here rather than relying on the transform
  // system (applyAllTransformsToScene) because mesh nodes are not transform
  // nodes — keeping it simple and robust.
  lines.position.set(cx, cy, cz);

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
    const parentObj = object3dById.get(targetParentId) ?? nodeById.get(targetParentId)?.object3d;
    if (!obj || !parentObj || obj.parent === parentObj) continue;
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
    out[node.id] = {
      position:     [_wp.x, _wp.y, _wp.z],
      quaternion:   [_wq.x, _wq.y, _wq.z, _wq.w],
      moveEnabled:   node.moveEnabled   !== false,
      rotateEnabled: node.rotateEnabled !== false,
      pivotEnabled:  node.pivotEnabled  !== false,
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

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}


// ── Singleton export ───────────────────────────────────────────────────────
export const steps = new StepManager();
export default steps;
