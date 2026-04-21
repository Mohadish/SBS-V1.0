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
import {
  captureVisibilitySnapshot,
  applyVisibilitySnapshot,
  diffVisibility,
} from '../core/nodes.js';
import {
  captureAllTransforms,
  applyAllTransformSnapshots,
  diffTransforms,
  interpolateTransformSnapshot,
  applyTransformSnapshot,
  applyNodeTransformToObject3D,
  isTransformNode,
  ensureTransformDefaults,
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
    // [{ nodeId, fromSnap, toSnap, startMs, durationMs, easeFn }]
    this._objectTransitions = [];

    // Dirty tracking — pending snapshot sync
    this._dirty   = false;
    this._syncTimer = null;

    // Maps shared with the rest of the app:
    //   object3dById: Map<nodeId, THREE.Object3D>
    //   meshById:     Map<nodeId, THREE.Mesh>
    // These are set externally after models load.
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

      // Transforms (only transform-capable nodes)
      transforms: treeData ? captureAllTransforms(treeData) : {},

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
    const { nodeById } = state.pick('nodeById');

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

    // Notes / screenItems / cables are applied by their own systems
    // (they listen to 'step:activate' on state)
  }

  /**
   * Animate from the current scene state to a step snapshot.
   * Kicks off camera animation (via sceneCore) and object transitions (via tick hook).
   *
   * @param {Snapshot} toSnapshot
   * @param {object}   transition  step.transition settings
   * @returns {Promise}  resolves when all animations complete
   */
  async applySnapshotAnimated(toSnapshot, transition = {}) {
    if (!toSnapshot) { this.applySnapshotInstant(toSnapshot); return; }

    // Resolve durations: per-step override takes precedence, otherwise global settings
    const globalCam  = state.get('cameraAnimDurationMs') ?? 1500;
    const globalObj  = state.get('objectAnimDurationMs') ?? 1500;
    const useOverride = transition.durationOverride === true;
    const durationMs  = useOverride
      ? (transition.cameraDurationMs ?? globalCam)
      : globalCam;
    const objDurationMs = useOverride
      ? (transition.objectDurationMs ?? globalObj)
      : globalObj;
    const easing     = transition.cameraEasing ?? 'smooth';
    const objEasing  = transition.objectEasing ?? 'smooth';
    const { nodeById } = state.pick('nodeById');

    // ── Camera ──────────────────────────────────────────────────────────
    const cameraP = toSnapshot.camera
      ? sceneCore.animateCameraTo(toSnapshot.camera, durationMs, easing)
      : Promise.resolve();

    // ── Object transforms ─────────────────────────────────────────────
    const currentTransforms = captureAllTransforms(state.get('treeData'));
    const changedNodeIds     = diffTransforms(currentTransforms, toSnapshot.transforms ?? {});

    const easeFn = EASING[objEasing] ?? easeSmooth;
    const startMs = performance.now();

    // Cancel any existing object transitions
    this._objectTransitions = [];

    for (const nodeId of changedNodeIds) {
      const from = currentTransforms[nodeId];
      const to   = toSnapshot.transforms?.[nodeId];
      if (!from || !to) continue;

      this._objectTransitions.push({
        nodeId, from, to,
        startMs, durationMs: objDurationMs, easeFn,
      });
    }

    // ── Visibility: dither-fade meshes in/out ────────────────────────────
    // Instead of instant obj.visible toggle (which pops the stencil buffer and
    // makes back-outlines jump), we keep meshes visible and fade them via
    // transitionOpacity dither, then hide them when the fade completes.
    if (toSnapshot.visibility) {
      // Record current effective (Three.js) visibility of every tracked mesh.
      const prevMeshVis = new Map();
      if (this._materials) {
        for (const [nodeId] of this._materials.meshById) {
          const obj = this.object3dById.get(nodeId);
          prevMeshVis.set(nodeId, obj ? obj.visible : false);
        }
      }

      // Apply the data-model visibility change and propagate to Three.js.
      applyVisibilitySnapshot(nodeById, toSnapshot.visibility);
      applyAllVisibilityToScene(nodeById, this.object3dById);

      // Compute which mesh nodes changed effective (Three.js) visibility.
      const hidingMeshIds  = [];
      const showingMeshIds = [];
      if (this._materials) {
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
      }

      // Start per-mesh dither fades (BEFORE beginColorTransition so that
      // applyAll() inside beginColorTransition reapplies fade values).
      if (this._materials && (hidingMeshIds.length || showingMeshIds.length)) {
        this._materials.beginVisibilityTransitions(
          hidingMeshIds, showingMeshIds, objDurationMs, easeFn,
        );
      }
    }

    // ── Materials: animate colour/solidness/outline-opacity ──────────────
    if (toSnapshot.materials && this._materials) {
      this._materials.beginColorTransition(toSnapshot.materials, objDurationMs, easeFn);
    }

    // Wait for all animations to complete
    const objectP = new Promise(resolve => {
      if (this._objectTransitions.length === 0) { resolve(); return; }
      // Will resolve when last transition finishes in _advanceObjectTransitions
      this._onObjectTransitionsDone = resolve;
    });

    await Promise.all([cameraP, objectP]);

    // ── Final: snap to exact target state ─────────────────────────────
    this.applySnapshotInstant(toSnapshot, { suppressCamera: true });
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

      if (node && obj && isTransformNode(node)) {
        const interp = interpolateTransformSnapshot(tr.from, tr.to, alpha);
        applyTransformSnapshot(node, interp);
        applyNodeTransformToObject3D(node, obj, false);
        obj.updateMatrixWorld(true);
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

    // Update state (fires 'step:activate' event for notes/screen overlay)
    state.setActiveStep(stepId);
    state.markDirty();

    const { durationMs = 1500 } = step.transition ?? {};

    if (animate && durationMs > 0) {
      await this.applySnapshotAnimated(step.snapshot, step.transition ?? {});
    } else {
      this.applySnapshotInstant(step.snapshot);
    }

    state.emit('step:applied', step);
  }

  /**
   * Activate a step by index (0-based).
   */
  activateStepByIndex(index, animate = true) {
    const steps = state.get('steps').filter(s => !s.hidden);
    const step  = steps[index];
    if (step) return this.activateStep(step.id, animate);
  }

  /**
   * Activate next/previous visible step relative to current active.
   */
  activateRelativeStep(delta, animate = true) {
    const steps     = state.get('steps').filter(s => !s.hidden);
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
   */
  scheduleSync() {
    this._dirty = true;
    state.setState({ _stepDirty: true });
  }

  /**
   * Immediately update the active step's snapshot with current scene state.
   */
  syncActiveStepNow() {
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

    step.snapshot = newSnapshot;
    this._dirty   = false;
    state.setState({ _stepDirty: false, steps: [...steps] });
    state.emit('step:synced', step);
  }

  /**
   * Flush any pending dirty sync immediately.
   * Call before saving, exporting, or navigating.
   */
  flushSync() {
    if (this._dirty) this.syncActiveStepNow();
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
      // Activate next step, or previous, or clear
      const next = newSteps[idx] ?? newSteps[idx - 1] ?? null;
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
    return state.get('steps').filter(s => !s.hidden);
  }

  getStepIndex(stepId) {
    return state.get('steps').findIndex(s => s.id === stepId);
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
    const num = steps.length + 1;
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


// ── Singleton export ───────────────────────────────────────────────────────
export const steps = new StepManager();
export default steps;
