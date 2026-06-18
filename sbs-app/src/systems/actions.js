/**
 * SBS — Undoable Actions
 * =======================
 * Every user mutation that should be reversible goes through here.
 * UI code calls actions.xxx() instead of materials/steps directly.
 *
 * Slider batching:
 *   pointerdown → actions.beginPresetEdit(presetId)   (snapshot FROM)
 *   input       → materials.updatePreset() directly    (live, no undo entry)
 *   pointerup   → actions.commitPresetEdit(presetId)   (snapshot TO, push command)
 */

import state                    from '../core/state.js';
import { undoManager }          from './undo.js';
import { setStatus }            from '../ui/status.js';
import { selectionActs }        from './select-act.js';
import { materials }            from '../systems/materials.js';
import steps                    from '../systems/steps.js';
import sceneCore                from '../core/scene.js';
import { createAnimationPreset, createCameraView, createNode, createNoteNode, createNoteTemplate, createShapeTemplate, createShapeTemplateGroup, createFlatShapeNode, createPrimitiveNode, generateId } from '../core/schema.js';
import * as editSession         from './edit-session.js';   // P7-A: gate Ctrl-Z while in overlay edit
import * as cables              from './cables.js';          // C3: cable mutators (data layer)
import {
  ensureFlatShapeObject3D,
  disposeFlatShape,
  rebuildInstancesOfTemplate as _rebuildInstancesOfTemplate,
} from './flat-shapes.js';   // M1 P1: 2D shapes (template-backed instances)
import * as shapeEditor        from './shape-editor.js';
import {
  ensurePrimitiveObject3D,
  rebuildPrimitive,
  defaultPrimitiveParams,
  PRIMITIVE_DEFS,
} from './primitives.js';     // V0.2.22.90: parametric primitives
import {
  applyAllVisibility,
  captureTransformSnapshot,
  applyTransformSnapshot,
  applyNodeTransformToObject3D,
  applyNodeSourceTransformToObject3D,
  ensureTransformDefaults,
  isTransformNode,
}                               from '../core/transforms.js';
import {
  setIsolateKeepSet, clearIsolate, getIsolateKeepSet,
  isIsolateActive, isIsolateEngaged,
}                               from '../core/isolate-state.js';
import {
  moveNode    as _nodes_moveNode,
  buildNodeMap as _nodes_buildNodeMap,
  captureParentMap,
  findNode,
  findParent,
  isDescendantOf,
  serializeModelTree,
}                               from '../core/nodes.js';


// ═══════════════════════════════════════════════════════════════════════════
//  MATERIAL ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Assign a color preset to one or more meshes.
 *
 * Routes through selectedStepIds the same way toggleVisibility does:
 * size ≥ 2 → bulk-mutate every step's snapshot.materials in one
 * undoable transaction. Otherwise the existing single-step flow.
 */
export function assignPreset(meshIds, presetId) {
  // _expandRMSelection: if the user selected a Replace-Model, cascade
  // the color to every child copy inside it (the RM itself has no
  // rendered mesh — the assignment on RM.id is purely a marker for the
  // add-time inheritance path in addToReplaceModel). Children IDs in
  // the expanded list are what actually paint geometry. Cascading is
  // STEP-SENSITIVE: behaves exactly like any other color action — the
  // current step gets the change (or every selected step in multi-step
  // mode). Stepping back/forward shows the per-step state, not a
  // forced global.
  const ids = _expandRMSelection(_stripArchived(meshIds));
  if (!ids.length) return;
  const stepSel = state.get('selectedStepIds');
  const isMulti = stepSel instanceof Set && stepSel.size >= 2;
  if (isMulti) {
    _bulkAssignColorMulti(ids, presetId, stepSel, 'Assign color');
    return;
  }
  const prev = Object.fromEntries(
    ids.map(id => [id, materials.meshColorAssignments[id] ?? null])
  );
  materials.assignPreset(ids, presetId);
  steps.scheduleSync();
  undoManager.push(
    'Assign color',
    () => { _restoreAssignments(ids, prev); materials.applyAll(); steps.scheduleSync(); },
    () => { materials.assignPreset(ids, presetId); steps.scheduleSync(); },
  );
}

/**
 * Remove color preset from one or more meshes. Same multi-step routing
 * as assignPreset (presetId = null is the "remove" payload in the bulk
 * path; the result is identical to deleting the entry from the map).
 */
export function removePreset(meshIds) {
  const ids = _expandRMSelection(_stripArchived(meshIds));
  if (!ids.length) return;
  const stepSel = state.get('selectedStepIds');
  const isMulti = stepSel instanceof Set && stepSel.size >= 2;
  if (isMulti) {
    _bulkAssignColorMulti(ids, null, stepSel, 'Remove color');
    return;
  }
  const prev = Object.fromEntries(
    ids.map(id => [id, materials.meshColorAssignments[id] ?? null])
  );
  materials.removePreset(ids);
  steps.scheduleSync();
  undoManager.push(
    'Remove color',
    () => { _restoreAssignments(ids, prev); materials.applyAll(); steps.scheduleSync(); },
    () => { materials.removePreset(ids); steps.scheduleSync(); },
  );
}

/**
 * Apply a color preset assignment (or removal, when presetId === null)
 * to the given mesh ids across every step in stepIdSet. ONE undo entry
 * per call. If the active step is in the set, live materials state is
 * also mutated so the viewport reflects the change immediately.
 *
 * Snapshot shape — step.snapshot.materials = { [meshId]: presetId }.
 * presetId === null OR equal to the mesh's project default: omit/delete
 * the entry so the mesh inherits the default. This matches what
 * materials.captureSnapshot does (it filters defaults out).
 */
/**
 * Re-stage the CURRENT active step's materials snapshot to live state.
 * Called after any setState that mutated step.snapshot.materials so the
 * viewport reflects whatever step the user is on right now — not the
 * step that was active at apply time. Safe to call when no snapshot
 * materials exist.
 */
function _restageActiveMaterials(stepsArr) {
  const activeId = state.get('activeStepId');
  if (!activeId) return;
  const activeStep = stepsArr.find(x => x.id === activeId);
  if (activeStep?.snapshot?.materials !== undefined) {
    materials.applySnapshot(activeStep.snapshot.materials);
  }
}

function _bulkAssignColorMulti(meshIds, presetId, stepIdSet, label) {
  const allSteps = state.get('steps') || [];
  const defaults = materials.meshDefaultColors || {};

  const nextSteps = allSteps.map(s => {
    if (!stepIdSet.has(s.id)) return s;
    const snap   = s.snapshot || {};
    const oldMat = snap.materials || {};
    const newMat = { ...oldMat };
    let dirty = false;
    for (const id of meshIds) {
      const target = (presetId == null || presetId === defaults[id]) ? undefined : presetId;
      if (target === undefined) {
        if (oldMat[id] !== undefined) { delete newMat[id]; dirty = true; }
      } else {
        if (oldMat[id] !== target)    { newMat[id] = target; dirty = true; }
      }
    }
    if (!dirty) return s;
    return { ...s, snapshot: { ...snap, materials: newMat } };
  });
  const touched = nextSteps.filter((s, i) => s !== allSteps[i]);
  if (touched.length === 0) return;
  const touchedIds = touched.map(s => s.id);

  const apply = (stepsArr) => {
    state.setState({ steps: stepsArr });
    state.markDirty();
    // Always re-stage the CURRENT active step. The user may have
    // switched active steps between apply and undo/redo.
    _restageActiveMaterials(stepsArr);
    state.emit('steps:bulkApplied', { stepIds: touchedIds });
  };
  apply(nextSteps);

  undoManager.push(
    `${label} on ${touched.length} step(s)`,
    () => apply(allSteps),
    () => apply(nextSteps),
  );
}

/**
 * Set a preset as the permanent default color for meshes (undoable).
 */
export function assignDefaultColor(meshIds, presetId) {
  const ids = _expandRMSelection(_stripArchived(meshIds));
  if (!ids.length) return;
  const prevAssign  = Object.fromEntries(ids.map(id => [id, materials.meshColorAssignments[id] ?? null]));
  const prevDefault = Object.fromEntries(ids.map(id => [id, materials.meshDefaultColors[id] ?? null]));

  materials.assignDefaultColor(ids, presetId);
  steps.scheduleSync();

  undoManager.push(
    'Set default color',
    () => {
      ids.forEach(id => {
        if (prevDefault[id] === null) delete materials.meshDefaultColors[id];
        else materials.meshDefaultColors[id] = prevDefault[id];
        if (prevAssign[id] === null) delete materials.meshColorAssignments[id];
        else materials.meshColorAssignments[id] = prevAssign[id];
      });
      materials.applyAll();
      steps.scheduleSync();
    },
    () => { materials.assignDefaultColor(ids, presetId); steps.scheduleSync(); },
  );
}

/**
 * Revert mesh color assignments back to their defaults (undoable).
 *
 * Routes through selectedStepIds the same way assignPreset / removePreset
 * do: when ≥ 2 steps are multi-selected, the per-step override entry is
 * removed across every step (semantically equivalent to assigning null).
 */
export function revertToDefault(meshIds) {
  const ids = _expandRMSelection(_stripArchived(meshIds));
  if (!ids.length) return;
  const stepSel = state.get('selectedStepIds');
  const isMulti = stepSel instanceof Set && stepSel.size >= 2;
  if (isMulti) {
    _bulkAssignColorMulti(ids, null, stepSel, 'Revert to default color');
    return;
  }
  const prevAssign = Object.fromEntries(ids.map(id => [id, materials.meshColorAssignments[id] ?? null]));

  materials.revertToDefault(ids);
  steps.scheduleSync();

  undoManager.push(
    'Revert to default color',
    () => {
      ids.forEach(id => {
        if (prevAssign[id] === null) delete materials.meshColorAssignments[id];
        else materials.meshColorAssignments[id] = prevAssign[id];
      });
      materials.applyAll();
      steps.scheduleSync();
    },
    () => { materials.revertToDefault(ids); steps.scheduleSync(); },
  );
}

/**
 * Delete a color preset (undoable).
 * Saves preset data + affected mesh assignments for restore.
 */
export function deletePreset(presetId) {
  const preset   = { ...state.get('colorPresets').find(p => p.id === presetId) };
  const affected = Object.entries(materials.meshColorAssignments)
    .filter(([, pid]) => pid === presetId)
    .map(([id]) => id);

  materials.deletePreset(presetId);

  undoManager.push(
    `Delete "${preset.name}"`,
    () => {
      // Re-insert preset
      const presets = [...state.get('colorPresets')];
      presets.push(preset);
      state.setState({ colorPresets: presets });
      // Restore mesh assignments
      affected.forEach(id => { materials.meshColorAssignments[id] = presetId; });
      materials.applyAll();
      state.markDirty();
    },
    () => { materials.deletePreset(presetId); },
  );
}

/**
 * Bulk-delete color presets (V0.1.97). Presets still used as a DEFAULT color
 * are protected (would orphan meshes) — they're skipped and reported; use
 * unifyPresets to merge those. Deletable presets are removed in one undo
 * entry that restores presets + the per-step + live assignments they touched.
 */
export function deletePresets(ids) {
  const all = state.get('colorPresets') || [];
  const wanted = new Set((ids || []).filter(id => all.some(p => p.id === id)));
  if (wanted.size === 0) return { deleted: 0, skipped: 0 };

  const deletable = [...wanted].filter(id => !materials.isDefaultPreset(id));
  const skipped   = wanted.size - deletable.length;
  if (deletable.length === 0) return { deleted: 0, skipped };

  const del = new Set(deletable);
  const beforePresets = JSON.parse(JSON.stringify(all));
  const beforeAssign  = { ...materials.meshColorAssignments };
  const beforeSteps   = JSON.parse(JSON.stringify(state.get('steps') || []));

  const apply = () => {
    // Drop the presets.
    state.setState({ colorPresets: (state.get('colorPresets') || []).filter(p => !del.has(p.id)) });
    // Strip live + per-step assignments that pointed at them.
    for (const k of Object.keys(materials.meshColorAssignments)) {
      if (del.has(materials.meshColorAssignments[k])) delete materials.meshColorAssignments[k];
    }
    const steps2 = (state.get('steps') || []).map(s => {
      const mat = s.snapshot?.materials;
      if (!mat) return s;
      let changed = false; const nm = {};
      for (const [mid, pid] of Object.entries(mat)) {
        if (del.has(pid)) { changed = true; continue; }   // drop
        nm[mid] = pid;
      }
      return changed ? { ...s, snapshot: { ...s.snapshot, materials: nm } } : s;
    });
    state.setState({ steps: steps2 });
    materials.applyAll();
    state.markDirty();
  };
  apply();
  undoManager.push(
    `Delete ${deletable.length} color${deletable.length === 1 ? '' : 's'}`,
    () => {
      materials.meshColorAssignments = { ...beforeAssign };
      state.setState({ colorPresets: beforePresets, steps: beforeSteps });
      materials.applyAll();
      state.markDirty();
    },
    () => apply(),
  );
  return { deleted: deletable.length, skipped };
}

/**
 * Unify a set of color presets into one survivor (V0.1.97). Every reference
 * to a merged preset — project-level DEFAULTS (meshDefaultColors), live
 * step-override assignments (meshColorAssignments), and EVERY step
 * snapshot's materials map — is remapped to `survivorId`; the merged presets
 * are then removed. So all objects that used the merged colors (including as
 * their default) adopt the survivor. One undo entry restores everything.
 */
export function unifyPresets(survivorId, mergedIds) {
  const all = state.get('colorPresets') || [];
  if (!all.some(p => p.id === survivorId)) return false;
  const merged = new Set((mergedIds || []).filter(id => id !== survivorId && all.some(p => p.id === id)));
  if (merged.size === 0) return false;

  const beforePresets  = JSON.parse(JSON.stringify(all));
  const beforeDefaults = { ...materials.meshDefaultColors };
  const beforeAssign   = { ...materials.meshColorAssignments };
  const beforeSteps    = JSON.parse(JSON.stringify(state.get('steps') || []));

  const apply = () => {
    for (const k of Object.keys(materials.meshDefaultColors)) {
      if (merged.has(materials.meshDefaultColors[k])) materials.meshDefaultColors[k] = survivorId;
    }
    for (const k of Object.keys(materials.meshColorAssignments)) {
      if (merged.has(materials.meshColorAssignments[k])) materials.meshColorAssignments[k] = survivorId;
    }
    const steps2 = (state.get('steps') || []).map(s => {
      const mat = s.snapshot?.materials;
      if (!mat) return s;
      let changed = false; const nm = {};
      for (const [mid, pid] of Object.entries(mat)) {
        const r = merged.has(pid) ? survivorId : pid;
        nm[mid] = r; if (r !== pid) changed = true;
      }
      return changed ? { ...s, snapshot: { ...s.snapshot, materials: nm } } : s;
    });
    state.setState({
      steps:        steps2,
      colorPresets: (state.get('colorPresets') || []).filter(p => !merged.has(p.id)),
    });
    materials.applyAll();
    state.markDirty();
  };
  apply();
  undoManager.push(
    `Unify ${merged.size + 1} colors`,
    () => {
      materials.meshDefaultColors    = { ...beforeDefaults };
      materials.meshColorAssignments = { ...beforeAssign };
      state.setState({ colorPresets: beforePresets, steps: beforeSteps });
      materials.applyAll();
      state.markDirty();
    },
    () => apply(),
  );
  return true;
}

// Slider batch state
let _presetBatch = null;

/**
 * Call on pointerdown of any preset slider/color input.
 * Snapshots the current preset values as the "from" state.
 */
export function beginPresetEdit(presetId) {
  if (_presetBatch?.presetId === presetId) return; // already open
  const preset = state.get('colorPresets').find(p => p.id === presetId);
  if (!preset) return;
  _presetBatch = { presetId, from: { ...preset } };
}

/**
 * Call on pointerup / change of any preset slider/color input.
 * Compares current preset to saved "from" and pushes one undo entry.
 */
export function commitPresetEdit(presetId) {
  if (!_presetBatch || _presetBatch.presetId !== presetId) return;
  const { from } = _presetBatch;
  _presetBatch = null;
  const to = { ...state.get('colorPresets').find(p => p.id === presetId) };
  if (JSON.stringify(from) === JSON.stringify(to)) return; // no real change
  undoManager.push(
    'Edit preset',
    () => { materials.updatePreset(presetId, from); },
    () => { materials.updatePreset(presetId, to); },
  );
}

/**
 * One-shot preset update (for name, checkboxes — not sliders).
 */
export function updatePreset(presetId, patch) {
  const from = { ...state.get('colorPresets').find(p => p.id === presetId) };
  materials.updatePreset(presetId, patch);
  const to   = { ...state.get('colorPresets').find(p => p.id === presetId) };
  undoManager.push(
    'Edit preset',
    () => { materials.updatePreset(presetId, from); },
    () => { materials.updatePreset(presetId, to); },
  );
}


// ═══════════════════════════════════════════════════════════════════════════
//  STEP ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

export function createStep(name, overrides) {
  const step = steps.createStepFromCurrent(name, overrides);
  undoManager.push(
    `Create "${step.name}"`,
    () => { steps.deleteStep(step.id); },
    () => {
      // Redo: re-insert the saved snapshot at the same position
      const all = [...state.get('steps')];
      const idx = all.findIndex(s => s.id === step.id);
      if (idx < 0) all.push(step);
      state.setState({ steps: all });
      state.setActiveStep(step.id);
      state.markDirty();
    },
  );
  return step;
}

export function deleteStep(stepId) {
  const all      = state.get('steps');
  const step     = all.find(s => s.id === stepId);
  if (!step) return;
  const snapshot  = JSON.parse(JSON.stringify(step));
  const idx       = all.indexOf(step);
  const prevActive = state.get('activeStepId');

  steps.deleteStep(stepId);
  undoManager.push(
    `Delete "${snapshot.name}"`,
    () => {
      const cur = [...state.get('steps')];
      cur.splice(Math.min(idx, cur.length), 0, snapshot);
      state.setState({ steps: cur });
      if (prevActive === stepId) state.setActiveStep(stepId);
      state.markDirty();
      state.emit('step:created', snapshot);
    },
    () => { steps.deleteStep(snapshot.id); },
  );
}

export function renameStep(stepId, name) {
  const step = steps.getStepById(stepId);
  if (!step) return;
  const from = step.name;
  steps.renameStep(stepId, name);
  undoManager.push(
    'Rename step',
    () => { steps.renameStep(stepId, from); },
    () => { steps.renameStep(stepId, name); },
  );
}

export function reorderStep(stepId, newIndex) {
  const oldIndex = steps.getStepIndex(stepId);
  steps.reorderStep(stepId, newIndex);
  undoManager.push(
    'Reorder step',
    () => { steps.reorderStep(stepId, oldIndex); },
    () => { steps.reorderStep(stepId, newIndex); },
  );
}

/**
 * Move a step into a chapter (or out, if chapterId is null) and relocate
 * it in the steps array. Single atomic action with undo.
 */
export function moveStepToChapter(stepId, chapterId, newIndex) {
  const step = steps.getStepById(stepId);
  if (!step) return;
  const oldChapterId = step.chapterId ?? null;
  const oldIndex     = steps.getStepIndex(stepId);
  steps.moveStepToChapter(stepId, chapterId, newIndex);
  undoManager.push(
    'Move step',
    () => { steps.moveStepToChapter(stepId, oldChapterId, oldIndex); },
    () => { steps.moveStepToChapter(stepId, chapterId,    newIndex); },
  );
}

/**
 * Move multiple steps as a contiguous block. Undo snapshots full state
 * before + after because restoring individual positions becomes brittle
 * when the set is large or crosses chapter boundaries.
 */
export function moveStepsToChapter(stepIds, chapterId, newIndex) {
  if (!stepIds?.length) return;
  const prevSteps = JSON.parse(JSON.stringify(state.get('steps') || []));
  steps.moveStepsToChapter(stepIds, chapterId, newIndex);
  const nextSteps = JSON.parse(JSON.stringify(state.get('steps') || []));
  undoManager.push(
    'Move steps',
    () => { state.setState({ steps: prevSteps }); state.markDirty(); state.emit('steps:reordered'); },
    () => { state.setState({ steps: nextSteps }); state.markDirty(); state.emit('steps:reordered'); },
  );
}

/**
 * Move steps to a (chapter, index) AND reassign their group membership
 * in one atomic action. Drag-into-group / drag-out-of-group flows route
 * through this so the reorder + groupId change land in a single undo
 * entry.
 *
 * `groupAssignment` is `{ [stepId]: <headStepId> | null }`. Any id not
 * in the map keeps its current `groupId`. A step assigned a non-null
 * groupId is forced to `groupHead=false` (can't be a head AND a sub-
 * step at once).
 */
export function moveStepsToChapterAndRegroup(stepIds, chapterId, newIndex, groupAssignment = null) {
  if (!stepIds?.length) return;
  const prevSteps = JSON.parse(JSON.stringify(state.get('steps') || []));
  steps.moveStepsToChapter(stepIds, chapterId, newIndex);
  if (groupAssignment && Object.keys(groupAssignment).length) {
    const cur = state.get('steps') || [];
    const next = cur.map(s => {
      if (!(s.id in groupAssignment)) return s;
      const newGroupId = groupAssignment[s.id];
      const patch = { groupId: newGroupId };
      if (newGroupId) patch.groupHead = false;
      return { ...s, ...patch };
    });
    state.setState({ steps: next });
  }
  const nextSteps = JSON.parse(JSON.stringify(state.get('steps') || []));
  undoManager.push(
    'Move steps',
    () => { state.setState({ steps: prevSteps }); state.markDirty(); state.emit('steps:reordered'); },
    () => { state.setState({ steps: nextSteps }); state.markDirty(); state.emit('steps:reordered'); },
  );
  state.markDirty();
  state.emit('steps:reordered');
}

/**
 * Toggle a chapter's locked flag (locked => always expanded in timeline).
 */
export function setChapterLocked(chapterId, locked) {
  const chapters = state.get('chapters') || [];
  const prev     = chapters.find(c => c.id === chapterId);
  if (!prev) return;
  const prevVal = !!prev.locked;
  steps.setChapterLocked(chapterId, locked);
  undoManager.push(
    'Lock chapter',
    () => { steps.setChapterLocked(chapterId, prevVal); },
    () => { steps.setChapterLocked(chapterId, !!locked); },
  );
}

/**
 * Reorder a whole chapter (and its steps) to a new index in the chapter list.
 */
export function reorderChapter(chapterId, newChapterIdx) {
  const chapters = state.get('chapters') || [];
  const oldIdx   = chapters.findIndex(c => c.id === chapterId);
  if (oldIdx < 0) return;
  const prevSteps    = [...(state.get('steps') || [])];
  const prevChapters = [...chapters];
  steps.reorderChapter(chapterId, newChapterIdx);
  undoManager.push(
    'Reorder chapter',
    () => { state.setState({ steps: prevSteps, chapters: prevChapters }); state.markDirty(); },
    () => { steps.reorderChapter(chapterId, newChapterIdx); },
  );
}

/**
 * Convert a normal step into a group head. The step itself stays put;
 * `groupHead=true` adds a lock icon + collapse control in the steps
 * panel. The newly-marked head starts EMPTY (no sub-steps under it) —
 * sub-steps are added later by dragging existing steps onto the head.
 *
 * Idempotent: calling on an already-head step is a no-op.
 * Refused on sub-steps (groupId !== null) — promote them out first.
 */
export function convertStepToGroup(stepId) {
  const stepsArr = state.get('steps') || [];
  const idx = stepsArr.findIndex(s => s.id === stepId);
  if (idx < 0) return false;
  const step = stepsArr[idx];
  if (step.groupHead || step.groupId) return false;
  const next = stepsArr.map(s => s.id === stepId
    ? { ...s, groupHead: true, groupLocked: false }
    : s);
  state.setState({ steps: next });
  state.markDirty();
  undoManager.push(
    'Convert to step group',
    () => {
      const cur = state.get('steps') || [];
      state.setState({
        steps: cur.map(s => s.id === stepId ? { ...s, groupHead: false, groupLocked: false } : s),
      });
      state.markDirty();
    },
    () => {
      const cur = state.get('steps') || [];
      state.setState({
        steps: cur.map(s => s.id === stepId ? { ...s, groupHead: true } : s),
      });
      state.markDirty();
    },
  );
  return true;
}

/**
 * Ungroup a step-group head. Allowed on any head: empty heads simply
 * lose the lock icon; non-empty heads release every sub-step into the
 * top-level list (sub-steps stay where they are in the array; their
 * `groupId` is cleared so they become normal top-level steps).
 *
 * Refused if the step isn't a head.
 */
export function ungroupStep(stepId) {
  const stepsArr = state.get('steps') || [];
  const idx = stepsArr.findIndex(s => s.id === stepId);
  if (idx < 0) return false;
  const step = stepsArr[idx];
  if (!step.groupHead) return false;
  // Snapshot which sub-steps were under this head, for undo.
  const subIds = stepsArr
    .filter(s => s.groupId === stepId)
    .map(s => s.id);
  const next = stepsArr.map(s => {
    if (s.id === stepId)        return { ...s, groupHead: false, groupLocked: false };
    if (s.groupId === stepId)   return { ...s, groupId: null };
    return s;
  });
  state.setState({ steps: next });
  state.markDirty();
  undoManager.push(
    'Ungroup step',
    () => {
      const cur = state.get('steps') || [];
      const restored = cur.map(s => {
        if (s.id === stepId)         return { ...s, groupHead: true };
        if (subIds.includes(s.id))   return { ...s, groupId: stepId };
        return s;
      });
      state.setState({ steps: restored });
      state.markDirty();
    },
    () => {
      const cur = state.get('steps') || [];
      state.setState({
        steps: cur.map(s => {
          if (s.id === stepId)        return { ...s, groupHead: false, groupLocked: false };
          if (s.groupId === stepId)   return { ...s, groupId: null };
          return s;
        }),
      });
      state.markDirty();
    },
  );
  return true;
}

/**
 * Toggle a group head's lock state. Locked = always expanded; unlocked
 * = collapses unless it contains the active step (mirrors chapter lock
 * semantics).
 */
export function setGroupLocked(stepId, locked) {
  const stepsArr = state.get('steps') || [];
  const step = stepsArr.find(s => s.id === stepId);
  if (!step || !step.groupHead) return;
  const prev = !!step.groupLocked;
  const want = !!locked;
  if (prev === want) return;
  state.setState({
    steps: stepsArr.map(s => s.id === stepId ? { ...s, groupLocked: want } : s),
  });
  state.markDirty();
  undoManager.push(
    'Lock step group',
    () => {
      const cur = state.get('steps') || [];
      state.setState({ steps: cur.map(s => s.id === stepId ? { ...s, groupLocked: prev } : s) });
      state.markDirty();
    },
    () => {
      const cur = state.get('steps') || [];
      state.setState({ steps: cur.map(s => s.id === stepId ? { ...s, groupLocked: want } : s) });
      state.markDirty();
    },
  );
}

export function duplicateStep(stepId) {
  const copy = steps.duplicateStep(stepId);
  if (!copy) return null;
  undoManager.push(
    `Duplicate step`,
    () => { steps.deleteStep(copy.id); },
    () => {
      const cur = [...state.get('steps')];
      if (!cur.find(s => s.id === copy.id)) {
        const srcIdx = cur.findIndex(s => s.id === stepId);
        cur.splice(srcIdx + 1, 0, copy);
        state.setState({ steps: cur });
        state.setActiveStep(copy.id);
        state.markDirty();
      }
    },
  );
  return copy;
}

export function updateTransition(stepId, patch) {
  const step = steps.getStepById(stepId);
  if (!step) return;
  const from = { ...(step.transition ?? {}) };
  steps.updateTransition(stepId, patch);
  undoManager.push(
    'Edit transition',
    () => { steps.updateTransition(stepId, from); },
    () => { steps.updateTransition(stepId, patch); },
  );
}


// ═══════════════════════════════════════════════════════════════════════════
//  VISIBILITY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Isolate — a NON-DESTRUCTIVE, global visibility mask (core/isolate-state.js).
 *
 * Engaging isolate keeps ONLY the selected ids (+ ancestors + descendants)
 * visible, on EVERY step, until un-isolate. It NEVER writes per-step snapshots,
 * so un-isolate simply drops the mask and re-stages — every step's real hide
 * state returns untouched. While isolated, hide/show is locked (the mask owns
 * visibility); transforms / colours / camera still flow per step.
 */
function _collectKeepSet(rootIds) {
  const nodeById = state.get('nodeById');
  if (!nodeById) return new Set();
  const keep = new Set();
  // Ancestors of each root id (so parent folders stay visible)
  const root = state.get('treeData');
  const ancestorsOf = (targetId) => {
    const stack = [{ node: root, path: [] }];
    while (stack.length) {
      const { node, path } = stack.pop();
      if (node.id === targetId) { for (const p of path) keep.add(p); return; }
      for (const c of (node.children || [])) stack.push({ node: c, path: [...path, node.id] });
    }
  };
  // Descendants of each root id (so the kid meshes of an isolated folder show)
  const collectDesc = (id) => {
    const node = nodeById.get(id);
    if (!node) return;
    keep.add(id);
    for (const c of (node.children || [])) collectDesc(c.id);
  };
  for (const id of rootIds) {
    collectDesc(id);
    ancestorsOf(id);
  }
  return keep;
}

/**
 * Push the current mask state (on or off) to the live scene: run the
 * isolate-aware visibility pass, then snap revealed meshes to full opacity so
 * nothing ghosts. Shared by isolate + un-isolate (and their undo/redo).
 */
function _applyIsolateView() {
  _syncVis();                  // applyAllVisibility is isolate-aware
  steps.snapMeshesOpaque();    // kill ghost-opacity on freshly-revealed meshes
}

export function isolateSelection() {
  if (isIsolateEngaged()) return;          // can't isolate while already isolated
  const nodeById = state.get('nodeById');
  if (!nodeById) return;
  const ids = state.get('multiSelectedIds');
  if (!ids?.size) return;
  const keep = _collectKeepSet(ids);
  if (!keep.size) return;

  setIsolateKeepSet(keep);
  _applyIsolateView();
  state.emit('isolate:changed', { active: true });
  setStatus('Isolated — hide/show locked until un-isolate');

  undoManager.push(
    'Isolate',
    () => { clearIsolate();          _applyIsolateView(); state.emit('isolate:changed', { active: false }); },
    () => { setIsolateKeepSet(keep); _applyIsolateView(); state.emit('isolate:changed', { active: true  }); },
  );
}

export function unisolate() {
  if (!isIsolateEngaged()) return;
  const keep = getIsolateKeepSet();
  clearIsolate();
  _applyIsolateView();
  state.emit('isolate:changed', { active: false });

  undoManager.push(
    'Un-isolate',
    () => { setIsolateKeepSet(keep); _applyIsolateView(); state.emit('isolate:changed', { active: true  }); },
    () => { clearIsolate();          _applyIsolateView(); state.emit('isolate:changed', { active: false }); },
  );
}

/** TRUE when an isolate is engaged — UI shows Un-isolate and greys hide/show. */
export function hasIsolateSnapshot() { return isIsolateEngaged(); }

// ═══════════════════════════════════════════════════════════════════════════
//  CLEAN TREE — collapse redundant import wrapper folders
// ═══════════════════════════════════════════════════════════════════════════
//
// STEP/OCCT import (buildNodeFromOcct) mirrors the CAD assembly verbatim → deep
// chains of single-child folders that group NOTHING (a 12,874-node model is
// ~2,070 such wrappers). This collapses them:
//   - folder with 0 meshes in its subtree   → removed
//   - folder with exactly 1 child           → child hoisted up (eats chains)
//   - folder with >=2 children              → kept (real grouping)
//
// SAFETY: only folders that are IDENTITY in their base AND in EVERY step's
// transform snapshot are touched, so nothing shifts. Locked (make-transformable
// / group) and archived folders are always left alone. The model's own node is
// never collapsed. Works the same whether the scene re-imports the model or
// loads from snapshots, because we rewrite each step's snapshot tree + maps and
// re-stage to rebuild the scene. One undo entry.

const _CT_EPS = 1e-5;
function _ctVecZero(v)   { return !v || (Math.abs(v[0]) < _CT_EPS && Math.abs(v[1]) < _CT_EPS && Math.abs(v[2]) < _CT_EPS); }
function _ctQuatId(q)    { return !q || (Math.abs(q[0]) < _CT_EPS && Math.abs(q[1]) < _CT_EPS && Math.abs(q[2]) < _CT_EPS && Math.abs(1 - q[3]) < _CT_EPS); }
function _ctScaleOne(s)  { return !s || (Math.abs(1 - s[0]) < _CT_EPS && Math.abs(1 - s[1]) < _CT_EPS && Math.abs(1 - s[2]) < _CT_EPS); }

/** A folder that carries its OWN geometry (some imports type leaf parts as
 *  'folder' with a meshIndex/fingerprint) is a PART, not grouping — never
 *  collapse it or we'd delete the part. */
function _folderHasGeometry(n) { return (n.meshIndex != null) || !!n.fingerprint; }

/** A folder is safe to collapse only if removing it cannot move any descendant —
 *  i.e. it contributes an identity transform in its base and in every step. */
function _folderIsIdentityEverywhere(node, allSteps) {
  if (!_ctVecZero(node.localOffset)       || !_ctQuatId(node.localQuaternion))     return false;
  if (!_ctVecZero(node.baseLocalPosition) || !_ctQuatId(node.baseLocalQuaternion)) return false;
  if (!_ctScaleOne(node.baseLocalScale))                                           return false;
  for (const s of allSteps) {
    const t = s?.snapshot?.transforms?.[node.id];
    if (!t) continue;                                  // no entry ⇒ identity default
    if (!_ctVecZero(t.localOffset) || !_ctQuatId(t.localQuaternion)) return false;
  }
  return true;
}

/** Bottom-up collapse of the LIVE tree under `scopeRoot`. Mutates `.children`
 *  arrays in place; records removed folder ids and a node→old-children backup
 *  so the change is fully reversible. */
function _collapseLiveFolders(scopeRoot, isCollapsible, removedIds, backup) {
  const recurse = (node) => {
    const kids = node.children;
    if (!kids || !kids.length) return;
    // Traverse ALL containers depth-first — the part tree often sits under a
    // 'model'/'scene'/replaceModel node, NOT a 'folder'. Only collapsing into
    // folder-typed children here would skip the whole subtree.
    for (const c of kids) recurse(c);
    const newKids = [];
    let changed = false;
    for (const c of kids) {
      if (c.type === 'folder' && isCollapsible(c)) {
        const cc = c.children || [];
        if (cc.length === 0) { removedIds.add(c.id); changed = true; }          // empty → drop
        else if (cc.length === 1) {                                             // wrapper → hoist
          const only = cc[0];
          if (!only.name && c.name) only.name = c.name;
          newKids.push(only); removedIds.add(c.id); changed = true;
        } else { newKids.push(c); }                                             // ≥2 → keep
      } else { newKids.push(c); }
    }
    if (changed) { backup.set(node, kids); node.children = newKids; }
  };
  recurse(scopeRoot);
}

/** Remove `removedIds` folders from a serialized snapshot tree spec, hoisting
 *  each removed folder's children into its parent. Pure — returns a new spec. */
function _removeIdsFromSpec(spec, removedIds) {
  if (!spec) return spec;
  const out = [];
  for (const c of (spec.children || [])) {
    const rc = _removeIdsFromSpec(c, removedIds);
    if (rc && rc.type === 'folder' && removedIds.has(rc.id)) out.push(...(rc.children || []));
    else out.push(rc);
  }
  return { ...spec, children: out };
}

/**
 * Collapse redundant wrapper folders. scopeRootId = null → whole tree; otherwise
 * only that node's subtree. One undo entry.
 */
export function cleanTree(scopeRootId = null) {
  const treeData = state.get('treeData');
  if (!treeData) return;
  const allSteps  = state.get('steps') || [];
  const scopeRoot = scopeRootId ? state.get('nodeById')?.get(scopeRootId) : treeData;
  if (!scopeRoot) return;

  const isCollapsible = (n) =>
    n.type === 'folder' && n !== scopeRoot &&
    n.locked !== true && n.archived !== true &&
    !_folderHasGeometry(n) &&
    _folderIsIdentityEverywhere(n, allSteps);

  // 1. Collapse the live tree, collecting removed ids + a reversible backup.
  const removedIds = new Set();
  const backup     = new Map();   // node → previous children array
  _collapseLiveFolders(scopeRoot, isCollapsible, removedIds, backup);

  if (!removedIds.size) { setStatus('Clean tree — no redundant folders found'); return; }

  const childrenNew = new Map();
  for (const node of backup.keys()) childrenNew.set(node, node.children);

  // 2. Rewrite every step snapshot: drop removed ids from the tree spec +
  //    visibility + transforms. Plain data → safe to clone.
  const oldSteps = allSteps;
  const newSteps = allSteps.map(s => {
    const snap = s?.snapshot;
    if (!snap) return s;
    const next = { ...snap };
    if (snap.tree)       next.tree       = _removeIdsFromSpec(snap.tree, removedIds);
    if (snap.visibility) { next.visibility = { ...snap.visibility }; for (const id of removedIds) delete next.visibility[id]; }
    if (snap.transforms) { next.transforms = { ...snap.transforms }; for (const id of removedIds) delete next.transforms[id]; }
    return { ...s, snapshot: next };
  });

  // apply: swap child arrays + steps, rebuild nodeById, re-stage active step so
  // the Three scene rebuilds from the thinned snapshot tree.
  const apply = (childMap, stepsArr) => {
    for (const [node, kids] of childMap) node.children = kids;
    const nb = _nodes_buildNodeMap(treeData);
    state.setState({ steps: stepsArr, nodeById: nb });
    state.markDirty();
    const active = stepsArr.find(x => x.id === state.get('activeStepId'));
    if (active?.snapshot) steps.applySnapshotInstant(active.snapshot);
    state.emit('change:treeData', treeData);
  };

  apply(childrenNew, newSteps);
  // Deselect — a removed folder may have been selected (stale gizmo otherwise).
  // setState emits change:selectedId / change:multiSelectedIds → gizmo updates.
  state.setState({ selectedId: null, multiSelectedIds: new Set() });
  setStatus(`Clean tree — removed ${removedIds.size} redundant folder(s)`);

  undoManager.push(
    `Clean tree (${removedIds.size} folders)`,
    () => apply(backup,      oldSteps),
    () => apply(childrenNew, newSteps),
  );
}

/**
 * Dry-run: how many folders cleanTree(scopeRootId) WOULD remove. Non-mutating —
 * runs the same collapse on a light structural clone. Used by the post-load
 * cleanup suggestion so it only fires when there's real bloat.
 */
export function countRedundantFolders(scopeRootId = null) {
  const treeData = state.get('treeData');
  if (!treeData) return 0;
  const allSteps = state.get('steps') || [];
  const src = scopeRootId ? state.get('nodeById')?.get(scopeRootId) : treeData;
  if (!src) return 0;
  // Clone only the fields the collapse + guards read (id/type/flags/transform).
  const clone = (n) => ({
    id: n.id, type: n.type, locked: n.locked, archived: n.archived,
    meshIndex: n.meshIndex, fingerprint: n.fingerprint,
    localOffset: n.localOffset, localQuaternion: n.localQuaternion,
    baseLocalPosition: n.baseLocalPosition, baseLocalQuaternion: n.baseLocalQuaternion,
    baseLocalScale: n.baseLocalScale,
    children: (n.children || []).map(clone),
  });
  const root = clone(src);
  const isCollapsible = (n) =>
    n.type === 'folder' && n !== root &&
    n.locked !== true && n.archived !== true &&
    !_folderHasGeometry(n) && _folderIsIdentityEverywhere(n, allSteps);
  const removed = new Set();
  _collapseLiveFolders(root, isCollapsible, removed, new Map());
  return removed.size;
}

// ─── Step / chapter multi-selection (state.selectedStepIds) ──────────────
//
// Routed through actions.js so every change goes through the undo log.
// Rapid bursts of changes (Ctrl-click streams, chapter shift-extends)
// coalesce into a single entry within an 800 ms window so the log
// doesn't fill with one entry per click. Each finalised entry restores
// the EXACT set that existed before the burst started.

let _silentStepSel = false;

/**
 * Read state.selectedStepIds as a Set (defensive — if somehow missing,
 * returns an empty Set).
 */
function _getSelectedStepIds() {
  const s = state.get('selectedStepIds');
  return s instanceof Set ? s : new Set();
}

/**
 * Replace the multi-step selection. Pushes a coalesced undo entry
 * unless `opts.silent` is true (used by the undo/redo lambdas
 * themselves so they don't recurse).
 */
export function setSelectedSteps(ids, opts = {}) {
  const before = new Set(_getSelectedStepIds());
  const after  = new Set(ids || []);
  // No-op: don't push an undo entry for a change that isn't one.
  if (before.size === after.size && [...before].every(x => after.has(x))) return;
  state.setState({ selectedStepIds: new Set(after) });
  if (_silentStepSel || opts.silent) return;
  undoManager.push(
    after.size === 0 ? 'Clear step selection' : `Step selection (${after.size})`,
    () => {
      _silentStepSel = true;
      state.setState({ selectedStepIds: new Set(before) });
      _silentStepSel = false;
    },
    () => {
      _silentStepSel = true;
      state.setState({ selectedStepIds: new Set(after) });
      _silentStepSel = false;
    },
    { coalesceKey: 'setSelectedSteps' },
  );
}

export function clearSelectedSteps() {
  setSelectedSteps([]);
}

/**
 * Keep the step selection UNITED with the active step — used after step
 * navigation (arrow keys). When NOT in multi-select (selection size ≤ 1)
 * the sole selected step follows the active step. In multi-select (≥ 2)
 * the selection is left intact so the active step can sit outside it
 * (that's the whole point of multi-select). Silent: navigation isn't an
 * undoable action, so this must not push undo entries.
 */
export function uniteStepSelectionWithActive() {
  const sel  = state.get('selectedStepIds');
  const size = sel instanceof Set ? sel.size : 0;
  if (size >= 2) return;                  // multi-select: leave it alone
  const activeId = state.get('activeStepId');
  if (!activeId) return;
  if (size === 1 && sel.has(activeId)) return;   // already united
  setSelectedSteps([activeId], { silent: true });
}

/**
 * Force the step selection to exactly [stepId], collapsing even out of
 * multi-select. Used by middle-mouse: make a step active AND the sole
 * selection regardless of the current mode. Silent (navigation gesture).
 */
export function forceUniteStepSelection(stepId) {
  if (!stepId) return;
  setSelectedSteps([stepId], { silent: true });
}

// ═══════════════════════════════════════════════════════════════════════════
//  GENERIC UNDO WRAPPER (V0.1.88) — plain-data state keys
// ═══════════════════════════════════════════════════════════════════════════
//
// Many structural / settings mutations historically ran from the UI with
// no undo entry (chapters, paste, header items, project settings, color
// presets). commitStateChange() snapshots the named state KEYS (deep JSON
// clone) before + after a mutator callback and pushes ONE swap-based undo
// entry. Only safe for JSON-serialisable keys — NEVER pass keys that hold
// Sets/Maps/Three.js refs (selectedStepIds, nodeById, treeData, object3d).
// Tree/object3d mutations use bespoke actions (live scene-graph reparenting
// can't survive a JSON round-trip).
//
// `opts.coalesceKey` merges rapid repeats (slider drags, text typing) into
// a single undo entry — same mechanism as setSelectedSteps.
export function commitStateChange(label, keys, mutator, opts = {}) {
  const snap = () => {
    const o = {};
    for (const k of keys) o[k] = JSON.parse(JSON.stringify(state.get(k) ?? null));
    return o;
  };
  const before = snap();
  mutator();
  const after = snap();
  if (JSON.stringify(before) === JSON.stringify(after)) return false;   // no-op
  const apply = (s) => {
    const patch = {};
    for (const k of keys) patch[k] = JSON.parse(JSON.stringify(s[k]));
    state.setState(patch);
    state.markDirty();
    // If 'steps' is among the restored keys and the active step vanished
    // (undo/redo of a delete), fall back to the first real step so the
    // viewport isn't stranded on a non-existent step.
    if (keys.includes('steps')) {
      const arr = state.get('steps') || [];
      const act = state.get('activeStepId');
      if (act && !arr.some(x => x.id === act)) {
        const first = arr.find(x => !x.isBaseStep);
        if (first) steps.activateStep(first.id, false);
      }
    }
  };
  undoManager.push(label,
    () => apply(before),
    () => apply(after),
    opts.coalesceKey ? { coalesceKey: opts.coalesceKey } : undefined,
  );
  return true;
}

// ─── Tree folders — undoable create / delete (V0.1.88) ──────────────────────
//
// Folder nodes carry a live Three.js Group (object3d), so undo can't use
// the JSON-snapshot path. Undo/redo splice the node + add/remove the live
// Three.js Group from the scene graph directly.

// V0.2.22.16 — folder create/delete now go through the unified rebuild path,
// matching the in-app structural-move refactor from V0.2.22. Both functions
// previously did `p.object3d.add(group)` / `obj.parent.remove(obj)` directly,
// which produced an in-session Three.js graph that could subtly diverge
// from what load reproduces from the saved spec. The folder-create case
// was low-risk in practice (the folder is brand new at identity) but
// uniform architecture beats one-off shortcuts — fewer special cases to
// reason about, no surprise drift if the unified rebuild evolves later.
export function createFolderInNode(parentId, name = 'Group') {
  const root = state.get('treeData');
  if (!root) return null;
  const parent = state.get('nodeById')?.get(parentId) || findNode(root, parentId);
  if (!parent) return null;

  const folderNode = createNode('folder', { name });
  // baseLocal* / localOffset etc. come from createNode defaults (identity).

  const doInsert = () => {
    const r = state.get('treeData');
    const p = state.get('nodeById')?.get(parentId) || findNode(r, parentId);
    if (!p) return;
    p.children = p.children || [];
    if (!p.children.some(c => c.id === folderNode.id)) p.children.push(folderNode);
    state.setState({ nodeById: _nodes_buildNodeMap(r) });
    // Rebuild Three.js via the same path load uses — creates the folder's
    // fresh Group at identity, parented correctly per spec.
    steps.applySnapshotInstant({ tree: serializeModelTree(r) });
    state.emit('change:treeData', r);
    steps.scheduleTransformSync();
    state.markDirty();
  };
  const doRemove = () => {
    const r = state.get('treeData');
    const p = state.get('nodeById')?.get(parentId) || findNode(r, parentId);
    if (p?.children) p.children = p.children.filter(c => c.id !== folderNode.id);
    state.setState({ nodeById: _nodes_buildNodeMap(r) });
    steps.applySnapshotInstant({ tree: serializeModelTree(r) });
    state.emit('change:treeData', r);
    steps.scheduleTransformSync();
    state.markDirty();
  };

  doInsert();
  state.setSelection(folderNode.id, new Set([folderNode.id]));
  undoManager.push(`Create folder "${name}"`, doRemove, doInsert);
  return folderNode.id;
}

export function deleteFolderNode(folderId) {
  const root = state.get('treeData');
  if (!root) return false;
  const parent = _findNodeParent(root, folderId);
  if (!parent) return false;
  const idx = (parent.children || []).findIndex(c => c.id === folderId);
  if (idx < 0) return false;
  const node = parent.children[idx];
  const parentId = parent.id;

  const doRemove = () => {
    const r = state.get('treeData');
    const p = state.get('nodeById')?.get(parentId) || _findNodeParent(r, folderId);
    if (p?.children) {
      const i = p.children.findIndex(c => c.id === folderId);
      if (i >= 0) p.children.splice(i, 1);
    }
    state.setState({ nodeById: _nodes_buildNodeMap(r) });
    // Rebuild Three.js via the same path load uses — cleanupFolderGroups
    // tears down the removed folder's Group; rebuildFromTreeSpec recreates
    // everything else from the updated spec.
    steps.applySnapshotInstant({ tree: serializeModelTree(r) });
    state.emit('change:treeData', r);
    steps.scheduleTransformSync();
    state.markDirty();
  };
  const doRestore = () => {
    const r = state.get('treeData');
    const p = state.get('nodeById')?.get(parentId) || findNode(r, parentId);
    if (p) {
      p.children = p.children || [];
      if (!p.children.some(c => c.id === folderId)) {
        const at = Math.min(idx, p.children.length);
        p.children.splice(at, 0, node);
      }
    }
    state.setState({ nodeById: _nodes_buildNodeMap(r) });
    steps.applySnapshotInstant({ tree: serializeModelTree(r) });
    state.emit('change:treeData', r);
    steps.scheduleTransformSync();
    state.markDirty();
  };

  doRemove();
  undoManager.push(`Delete folder "${node.name}"`, doRestore, doRemove);
  return true;
}

// ─── Make transformable — wrap a node in a locked pivot-folder (V0.2.22.79) ───
//
// One click "give this thing a gizmo":
//   • A fresh folder is created at the node's exact tree position, named
//     after the node, and the node is moved inside it.
//   • The folder is LOCKED (so viewport selection promotes to it → its
//     gizmo) and its VIRTUAL pivot is parked on the node's bbox-centre
//     while the gizmo axes stay aligned to the surrounding (parent) folder.
//   • Because the wrapper folder is identity within the parent, the node's
//     world pose is preserved automatically — no "cascade?" prompt, no
//     visible jump (the "transform correction" is implicit).
//   • The wrapper is injected into EVERY step snapshot (wrapping the node
//     wherever it sits in that step) so the gizmo drives the node across
//     the whole timeline, not just the active step.
//
// Pivot maths: pivotLocalOffset lives in the folder's LOCAL space and the
// folder is identity inside its parent, so folder-local == parent frame.
// getPivotWorldPosition → folder.localToWorld(offset) = node centre in
// world; getPivotWorldQuaternion → folder.worldQuat × identity = parent
// frame. That's "centred to node, oriented to parent" for free, and BLUE
// pivot mode makes rotation orbit the node centre.
export function makeTransformable(nodeId) {
  const root = state.get('treeData');
  if (!root) return null;
  const nb0 = state.get('nodeById') || _nodes_buildNodeMap(root);
  const target = nb0.get(nodeId);
  if (!target) return null;
  if (target.type === 'scene' || target.type === 'note' || target.type === 'hardwareNut') return null;
  const parent0 = _findNodeParent(root, nodeId);
  if (!parent0) return null;                       // scene root itself / detached
  const beforeParentId = parent0.id;

  // Fresh wrapper folder — locked, identity transform, pivot-enabled.
  const folder = createNode('folder', { name: target.name || 'Group', locked: true });
  ensureTransformDefaults(folder);
  folder.pivotEnabled = true;
  const folderId = folder.id;

  const cloneSn = (s) => ({
    id: s.id,
    tree:       s.snapshot?.tree       ? JSON.parse(JSON.stringify(s.snapshot.tree))       : undefined,
    transforms: s.snapshot?.transforms ? JSON.parse(JSON.stringify(s.snapshot.transforms)) : undefined,
    visibility: s.snapshot?.visibility ? JSON.parse(JSON.stringify(s.snapshot.visibility)) : undefined,
  });
  const beforeSteps = (state.get('steps') || []).map(cloneSn);

  // ── live restructure: wrap target under folder, at its position ──
  const wrapLive = () => {
    const r = state.get('treeData');
    const p = state.get('nodeById')?.get(beforeParentId) || _findNodeParent(r, nodeId);
    const t = state.get('nodeById')?.get(nodeId);
    if (!p || !t) return;
    const i = (p.children || []).findIndex(c => c.id === nodeId);
    if (i < 0) return;
    p.children.splice(i, 1, folder);
    folder.children = [t];
    state.setState({ treeData: r, nodeById: _nodes_buildNodeMap(r) });
  };
  const unwrapLive = () => {
    const r = state.get('treeData');
    const p = _findNodeParent(r, folderId);
    const t = state.get('nodeById')?.get(nodeId) || (folder.children || [])[0];
    if (!p || !t) return;
    const i = (p.children || []).findIndex(c => c.id === folderId);
    if (i < 0) return;
    p.children.splice(i, 1, t);
    folder.children = [];
    state.setState({ treeData: r, nodeById: _nodes_buildNodeMap(r) });
  };

  wrapLive();
  steps.applySnapshotInstant({ tree: serializeModelTree(state.get('treeData')) });

  // ── compute the folder's pivot from the node's world bbox-centre ──
  _centerPivotOnTarget(folderId, nodeId);

  const fnode = state.get('nodeById')?.get(folderId);
  const fSnap = captureTransformSnapshot(fnode);
  const folderShell = { ...serializeModelTree(fnode), children: [] };

  // ── inject wrapper into EVERY step snapshot ──
  const wrapInSpec = (spec) => {
    if (!spec) return spec;
    const kids = spec.children || [];
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.id === nodeId) {
        const nk = [...kids];
        nk[i] = { ...folderShell, children: [c] };
        return { ...spec, children: nk };
      }
      const sub = wrapInSpec(c);
      if (sub !== c) {
        const nk = [...kids];
        nk[i] = sub;
        return { ...spec, children: nk };
      }
    }
    return spec;
  };
  const injectSteps = () => {
    const next = (state.get('steps') || []).map(s => {
      const snap = s.snapshot;
      if (!snap?.tree) return s;
      if (_specHasId(snap.tree, folderId)) return s;     // idempotent
      if (!_specHasId(snap.tree, nodeId))  return s;     // step lacks the node
      return {
        ...s,
        snapshot: {
          ...snap,
          tree: wrapInSpec(snap.tree),
          transforms: { [folderId]: JSON.parse(JSON.stringify(fSnap)), ...(snap.transforms || {}) },
          visibility: { [folderId]: true, ...(snap.visibility || {}) },
        },
      };
    });
    state.setState({ steps: next });
  };
  injectSteps();

  state.markDirty();
  state.emit('change:treeData', state.get('treeData'));
  state.setSelection(folderId, new Set([folderId]));

  const afterSteps = (state.get('steps') || []).map(cloneSn);

  undoManager.push(`Make "${target.name || 'object'}" transformable`,
    () => {                                            // UNDO
      unwrapLive();
      _restoreStepStructures(beforeSteps);
      _reapplyActiveSnapshot();
      state.emit('change:treeData', state.get('treeData'));
      state.markDirty();
    },
    () => {                                            // REDO
      wrapLive();
      _restoreStepStructures(afterSteps);
      _reapplyActiveSnapshot();
      // pivot/locked ride on the persistent `folder` node + afterSteps
      // transforms; re-applying the active snapshot restores them.
      state.emit('change:treeData', state.get('treeData'));
      state.markDirty();
    },
  );
  return folderId;
}

/** True iff a serialised tree spec contains a node with `id`. */
function _specHasId(spec, id) {
  if (!spec) return false;
  if (spec.id === id) return true;
  return (spec.children || []).some(c => _specHasId(c, id));
}

/**
 * Park a wrapper folder's VIRTUAL pivot on its wrapped node's world
 * bbox-centre. Orientation stays the folder's own (identity) frame =
 * parent frame, since the folder is identity within its parent.
 */
function _centerPivotOnTarget(folderId, nodeId) {
  const T = window.THREE;
  if (!T) return;
  const folderObj = steps.object3dById?.get(folderId);
  const targetObj = steps.object3dById?.get(nodeId);
  const fnode     = state.get('nodeById')?.get(folderId);
  if (!folderObj || !targetObj || !fnode) return;
  folderObj.updateMatrixWorld(true);
  targetObj.updateMatrixWorld(true);
  const box = new T.Box3().setFromObject(targetObj);
  if (!box || box.isEmpty()) return;
  const center = box.getCenter(new T.Vector3());
  const local  = folderObj.worldToLocal(center.clone());
  ensureTransformDefaults(fnode);
  fnode.pivotLocalOffset     = [local.x, local.y, local.z];
  fnode.pivotLocalQuaternion = [0, 0, 0, 1];
  fnode.pivotEnabled         = true;
  fnode.moveEnabled          = true;
  fnode.rotateEnabled        = true;
  applyNodeTransformToObject3D(fnode, folderObj, true);
}

/** Restore each step's snapshot {tree, transforms, visibility} from clones. */
function _restoreStepStructures(clones) {
  const byId = new Map(clones.map(c => [c.id, c]));
  const next = (state.get('steps') || []).map(s => {
    const c = byId.get(s.id);
    if (!c) return s;
    return {
      ...s,
      snapshot: {
        ...s.snapshot,
        ...(c.tree       !== undefined ? { tree:       JSON.parse(JSON.stringify(c.tree)) }       : {}),
        ...(c.transforms !== undefined ? { transforms: JSON.parse(JSON.stringify(c.transforms)) } : {}),
        ...(c.visibility !== undefined ? { visibility: JSON.parse(JSON.stringify(c.visibility)) } : {}),
      },
    };
  });
  state.setState({ steps: next, nodeById: _nodes_buildNodeMap(state.get('treeData')) });
}

/** Re-apply the active step's snapshot so Three.js matches the restored tree. */
function _reapplyActiveSnapshot() {
  const activeId = state.get('activeStepId');
  const step = (state.get('steps') || []).find(s => s.id === activeId);
  if (step?.snapshot) steps.applySnapshotInstant(step.snapshot);
}

// ─── Color preset — undoable create (V0.1.88) ───────────────────────────────
//
// materials.createPreset() mutates state.colorPresets with no undo. Wrap it.
export function addColorPreset(overrides = {}) {
  let created = null;
  commitStateChange('Add color preset', ['colorPresets'], () => {
    created = materials.createPreset(overrides);
  });
  return created;
}

/**
 * Undo wrapper for settings whose SETTER applies a scene side-effect that
 * a plain setState-restore wouldn't re-trigger (e.g. geometry outline,
 * selection-outline color — no change:* listener repaints them). The
 * caller applies the change normally, then passes the setter fn + the
 * full before/after values; undo/redo re-invoke the setter so the side-
 * effect re-runs. `coalesceKey` merges slider-drag bursts into one entry.
 */
export function pushSetterUndo(label, applyFn, beforeVal, afterVal, coalesceKey) {
  if (JSON.stringify(beforeVal) === JSON.stringify(afterVal)) return false;
  undoManager.push(label,
    () => applyFn(beforeVal),
    () => applyFn(afterVal),
    coalesceKey ? { coalesceKey } : undefined,
  );
  return true;
}

/**
 * Toggle the `hidden` (skip-from-playback) flag on one or more steps as a
 * SINGLE undoable action. Replaces the old steps.setStepHidden() call
 * sites, which mutated state with NO undo entry (so multi-step hide could
 * not be undone — V0.1.85 item 4.4 fix).
 *
 * Direction: if ANY target step is currently visible, hide them all;
 * otherwise show them all. Group-head selection cascades to its sub-steps
 * (mirrors the old setStepHidden cascade) so a group reads as one step.
 */
export function toggleStepsHidden(stepIds) {
  const allSteps = state.get('steps') || [];
  const seed = new Set((stepIds || []).filter(id => allSteps.some(s => s.id === id)));
  if (seed.size === 0) return;

  // Expand group heads → their sub-steps.
  const idSet = new Set(seed);
  for (const s of allSteps) {
    if (s.groupHead && seed.has(s.id)) {
      for (const sub of allSteps) if (sub.groupId === s.id) idSet.add(sub.id);
    }
  }

  const targets = allSteps.filter(s => idSet.has(s.id));
  const anyVisible = targets.some(s => !s.hidden);
  const want = anyVisible;   // hide if any visible, else show all

  // Capture exact before-state (per id) so undo restores mixed states.
  const before = new Map();
  for (const s of targets) before.set(s.id, !!s.hidden);
  const after = new Map();
  for (const id of idSet) after.set(id, want);

  // No-op guard: every target already at `want`.
  let changed = false;
  for (const [id, v] of after) if (before.get(id) !== v) { changed = true; break; }
  if (!changed) return;

  const apply = (hiddenMap) => {
    const arr = state.get('steps') || [];
    const nextArr = arr.map(s => hiddenMap.has(s.id) ? { ...s, hidden: hiddenMap.get(s.id) } : s);
    state.setState({ steps: nextArr });
    state.markDirty();
  };
  apply(after);

  const n = idSet.size;
  undoManager.push(
    `${want ? 'Hide' : 'Show'} ${n} step${n === 1 ? '' : 's'}`,
    () => apply(before),
    () => apply(after),
  );
}

/**
 * Move every id under the destination folder. One undo entry restores
 * each node's original parent. Skips moves that would put a node into
 * itself or its own descendant. Triggers a tree rebuild + nodeById
 * refresh so the rest of the app sees the new hierarchy.
 */
export function moveNodesToFolder(ids, destFolderId) {
  const root = state.get('treeData');
  if (!root || !ids?.length || !destFolderId) return;
  // Archived nodes are READ-ONLY — they cannot be directly moved. They
  // still follow their container if the container itself is moved (Three
  // .js scene-graph parenting handles that), but a direct "move to
  // folder" gesture on an archived node is silently dropped.
  ids = _stripArchived(ids);
  if (!ids.length) return;
  // Snapshot original parents so undo can splice each node back.
  const before = [];
  for (const id of ids) {
    const parent = _findNodeParent(root, id);
    if (!parent) continue;
    const idx = (parent.children || []).findIndex(c => c.id === id);
    before.push({ id, parentId: parent.id, index: idx });
  }
  // Apply moves (skip self / descendant of destination).
  const moved = [];
  for (const { id } of before) {
    if (_nodes_moveNode(root, id, destFolderId)) moved.push(id);
  }
  if (!moved.length) return;
  state.setState({ nodeById: _nodes_buildNodeMap(root), treeData: root });
  steps.scheduleTransformSync();
  state.markDirty();
  undoManager.push(
    moved.length === 1 ? 'Move to folder' : `Move ${moved.length} to folder`,
    () => {
      const r = state.get('treeData');
      // Reverse order so children restore before parents (no descendant conflicts).
      for (const b of [...before].reverse()) {
        _nodes_moveNode(r, b.id, b.parentId, b.index);
      }
      state.setState({ nodeById: _nodes_buildNodeMap(r), treeData: r });
      steps.scheduleTransformSync();
      state.markDirty();
    },
    () => {
      const r = state.get('treeData');
      for (const id of moved) _nodes_moveNode(r, id, destFolderId);
      state.setState({ nodeById: _nodes_buildNodeMap(r), treeData: r });
      steps.scheduleTransformSync();
      state.markDirty();
    },
  );
}

function _findNodeParent(node, targetId) {
  for (const c of (node.children || [])) {
    if (c.id === targetId) return node;
    const sub = _findNodeParent(c, targetId);
    if (sub) return sub;
  }
  return null;
}

/**
 * Toggle visibility of one or more nodes.
 *
 * Routing:
 *   • If selectedStepIds.size ≥ 2: the change is applied to EVERY step
 *     in the set in one shot — one undo entry covering all of them.
 *     The user sees the multi-step banner in the timeline and knows
 *     this is happening. If the active step is part of the set, live
 *     state is also mutated so the viewport reflects the change.
 *   • Otherwise: the change is applied to the active step alone via
 *     the existing live-state + scheduleSync flow.
 *
 * Cascade-inversion on SHOW: if a node we're showing has any HIDDEN
 * ancestor in the affected step's tree, that ancestor is flipped to
 * visible AND its non-path-non-target children are explicitly hidden.
 * This means clicking 👁 on a buried mesh exposes JUST that mesh, not
 * the whole sibling tree of its ancestors. HIDE has no cascade —
 * setting a node hidden hides it and any descendant that inherits.
 */
export function toggleVisibility(nodeIds) {
  // While isolated, the mask owns visibility — hide/show is locked. Covers the
  // tree eye button, the viewport r-click, and the 'H' shortcut in one place.
  if (isIsolateEngaged()) { setStatus('Un-isolate to change hide/show'); return; }
  const nodeById = state.get('nodeById');
  const treeData = state.get('treeData');
  // Strip archived ids — archived nodes are READ-ONLY and must not respond
  // to hide/show. The eye button in the tree row, the viewport r-click,
  // and the keyboard 'H' shortcut all route through here, so this single
  // filter covers every user path.
  const ids      = _stripArchived([...nodeIds].filter(id => nodeById?.has(id)));
  if (!ids.length) return;
  const newVis = !nodeById.get(ids[0]).localVisible;

  const stepSel = state.get('selectedStepIds');
  const isMulti = stepSel instanceof Set && stepSel.size >= 2;

  if (isMulti) {
    _toggleVisibilityMulti(ids, newVis, stepSel, treeData);
    return;
  }

  // Single-step path: mutate live state then captureSync.
  const wasVisible = ids.map(id => nodeById.get(id).localVisible !== false);
  // Build a current vis map from live state, apply cascade-aware change,
  // then write the result back to live nodes (for SHOW). HIDE remains
  // a simple per-id flip — no cascade needed.
  const liveMap = {};
  for (const [id, n] of nodeById) liveMap[id] = n.localVisible !== false;
  const changes = newVis
    ? _computeShowCascadeChanges(liveMap, ids, treeData)
    : Object.fromEntries(ids.map(id => [id, false]));
  // Capture full BEFORE map of any node we're about to flip — covers
  // the cascaded siblings too, so undo restores them exactly.
  const before = {};
  for (const id of Object.keys(changes)) {
    if (liveMap[id] !== changes[id]) before[id] = liveMap[id];
  }
  if (Object.keys(before).length === 0) return;   // nothing to do

  const apply = (map) => {
    const nb = state.get('nodeById');
    for (const [id, vis] of Object.entries(map)) {
      const n = nb.get(id);
      if (n) n.localVisible = !!vis;
    }
    _syncVis();
  };
  apply(changes);

  undoManager.push(
    newVis ? 'Show' : 'Hide',
    () => apply(before),
    () => apply(changes),
  );
  // Avoid the wasVisible variable lint flag.
  void wasVisible;
}


// ─── Archive / Unarchive ──────────────────────────────────────────────────
//
// Archive marks a node as "locked-hidden": it stays in the tree (with all
// per-step history intact) but is forced invisible in the viewport,
// regardless of any per-step snapshot.visibility. Toggle survives save
// /reload via the tree section (see core/nodes.js serializeModelTree +
// io/project.js applySpecFieldsToNodes).
//
// Why a separate flag from localVisible:
//   - localVisible is per-step (each snapshot.visibility records it).
//   - archived is a PERMANENT node property — not captured per-step,
//     not changed by step transitions.
//   - The visibility-resolution path (core/nodes.js computeVisibleSet +
//     systems/steps.js applyAllVisibilityToScene) AND-s both, so archive
//     wins over any per-step visibility the snapshot wants to apply.
//
// Used by Replace Object (the replaced node is archived to preserve its
// history) and as a general-purpose toggle for nodes the user wants out
// of the scene but doesn't want to delete.

/**
 * Mark one or more nodes as archived. Idempotent — ids already archived
 * are skipped. Single undoable transaction restores exact prior state.
 *
 * @param {Iterable<string>} nodeIds
 */
export function archiveNodes(nodeIds) {
  const nodeById = state.get('nodeById');
  if (!nodeById) return;
  const ids = [...nodeIds].filter(id => nodeById.has(id));
  if (!ids.length) return;

  // Capture BEFORE state for undo (only ids that will actually change).
  const flipped = [];
  for (const id of ids) {
    const n = nodeById.get(id);
    if (n && n.archived !== true) flipped.push(id);
  }
  if (!flipped.length) return;

  const apply = (archived) => {
    const nb = state.get('nodeById');
    for (const id of flipped) {
      const n = nb.get(id);
      if (n) n.archived = !!archived;
    }
    _syncVis();
  };
  apply(true);

  undoManager.push(
    flipped.length === 1 ? 'Archive' : `Archive ${flipped.length} nodes`,
    () => apply(false),
    () => apply(true),
  );
}

/**
 * Unmark one or more nodes as archived. Idempotent — ids not currently
 * archived are skipped.
 *
 * @param {Iterable<string>} nodeIds
 */
export function unarchiveNodes(nodeIds) {
  const nodeById = state.get('nodeById');
  if (!nodeById) return;
  const ids = [...nodeIds].filter(id => nodeById.has(id));
  if (!ids.length) return;

  const flipped = [];
  for (const id of ids) {
    const n = nodeById.get(id);
    if (n && n.archived === true) flipped.push(id);
  }
  if (!flipped.length) return;

  const apply = (archived) => {
    const nb = state.get('nodeById');
    for (const id of flipped) {
      const n = nb.get(id);
      if (n) n.archived = !!archived;
    }
    _syncVis();
  };
  apply(false);

  undoManager.push(
    flipped.length === 1 ? 'Unarchive' : `Unarchive ${flipped.length} nodes`,
    () => apply(true),
    () => apply(false),
  );
}


// ═══════════════════════════════════════════════════════════════════════════
//  REPLACE-MODEL (B.2-NEW) — container that takes over for a replaced object
// ═══════════════════════════════════════════════════════════════════════════
//
// Replace-Model (RM) is a container node TYPE (`type='replaceModel'`) that
// the user converts an existing object INTO. The conversion is just a type
// flip — the node's id, transforms, per-step state, cables, color
// assignments all stay anchored to the SAME node, so nothing breaks. The
// 🔄 icon advertises the new state in the tree.
//
// Once a node is an RM, the user can "add to replace" — picking another
// object and dropping a COPY of it as a child of the RM. The original
// geometry of the RM (the mesh/flatShape this node was before conversion)
// can be hidden (originalGeometryHidden flag) so only the added copies
// render. Multiple objects can be added; they all live as children of the
// RM and inherit its per-step state through Three.js scene parenting.
//
// All editing of an RM's children is restricted to two actions — remove
// from RM, or global transform — enforced at the action layer. Selection
// of any child promotes to the RM in both viewport and tree.
//
// This phase (B.2-NEW.1) ships only the TYPE conversion + visual icon +
// save/load round-trip. Add-to-replace, restricted r-click, selection
// promotion, global transform, and un-replace ship in B.2-NEW.2 - .4.

// V0.1.72: `_findEnclosingReplaceModel` removed — duplicated the exported
// `findReplaceModelAncestor` (defined later in this file, used by both
// tree.js and actions.js). Callers now use that single helper; this comment
// stub is here for grep/blame so the next reader sees the consolidation.

/**
 * Convert a mesh / flatShape / model node INTO a replace-model container.
 * The node's id, transforms, per-step state, cables, color assignments all
 * stay anchored to the same node — only its `type` changes (and a few
 * tracking fields are added). The visible scene state is unchanged until
 * the user runs "add to replace" on the resulting RM.
 *
 * @param {string} nodeId
 * @returns {boolean}  true on success
 */
export function convertToReplaceModel(nodeId) {
  const nb       = state.get('nodeById');
  const treeData = state.get('treeData');
  if (!nb || !treeData) return false;
  const node = nb.get(nodeId);
  if (!node) return false;
  // Whitelist: mesh / flatShape / model only. Folders / scene / notes /
  // already-RM / archived nodes are blocked. Conversion inside another
  // RM is blocked too — the selection-promotion contract assumes RM
  // children stay leaf-ish.
  if (node.type !== 'mesh' && node.type !== 'flatShape' && node.type !== 'model') return false;
  if (node.archived) return false;
  if (findReplaceModelAncestor(treeData, nodeId)) return false;

  const fromType = node.type;
  node.type                   = 'replaceModel';
  node.originalType           = fromType;
  node.originalGeometryHidden = false;   // user can flip later via RM menu

  state.emit('change:treeData', treeData);
  state.markDirty();

  undoManager.push(
    `Convert "${(node.name || 'object').slice(0, 20)}" to Replace-Model`,
    () => {
      const n = state.get('nodeById')?.get(nodeId);
      if (!n) return;
      n.type = fromType;
      delete n.originalType;
      delete n.originalGeometryHidden;
      state.emit('change:treeData', state.get('treeData'));
    },
    () => {
      const n = state.get('nodeById')?.get(nodeId);
      if (!n) return;
      n.type = 'replaceModel';
      n.originalType = fromType;
      n.originalGeometryHidden = false;
      state.emit('change:treeData', state.get('treeData'));
    },
  );
  return true;
}


// ─── Folder Lock (V0.1.92) ────────────────────────────────────────────────
//
// Every folder carries a `locked` boolean (default false). A LOCKED folder:
//   • promotes viewport selection — clicking any descendant selects the
//     whole folder (treat the sub-assembly as one unit), and
//   • auto-collapses in the tree (reads as one unit).
// This replaces the old "Group" concept (isGroup/groupLocked): a locked
// folder IS the group. Legacy `isGroup` folders migrate to `locked` on load
// (see io/project.js). Loose objects are organised via New folder / Move to
// folder + drag, then locked — there's no "group loose objects" shortcut.

/** Toggle (or set) a folder's lock state. Single undo entry. */
export function setFolderLocked(folderId, locked) {
  const nb = state.get('nodeById');
  const node = nb?.get(folderId);
  if (!node || node.type !== 'folder') return false;
  const prev = node.locked === true;
  const next = locked === undefined ? !prev : !!locked;
  if (prev === next) return false;
  node.locked = next;
  state.emit('change:treeData', state.get('treeData'));
  state.markDirty();
  undoManager.push(
    next ? 'Lock folder' : 'Unlock folder',
    () => { const n = state.get('nodeById')?.get(folderId); if (n) n.locked = prev; state.emit('change:treeData', state.get('treeData')); state.markDirty(); },
    () => { const n = state.get('nodeById')?.get(folderId); if (n) n.locked = next; state.emit('change:treeData', state.get('treeData')); state.markDirty(); },
  );
  return true;
}

/**
 * Walk up the tree to find the nearest LOCKED folder ancestor. Used by the
 * viewport selection promotion (mirrors findReplaceModelAncestor). Returns
 * the folder node or null.
 */
export function findLockedFolderAncestor(root, nodeId) {
  if (!root || !nodeId) return null;
  // V0.3.0.74 — a TEMPORARILY-unlocked folder (double-click) is treated as NOT
  // locked here, so clicks inside it select the actual objects instead of
  // promoting back up to the folder. The transient set lives in state.
  const tempUnlocked = state.get('tempUnlockFolderIds');
  let found = null;
  (function walk(node, ancestors) {
    if (found) return;
    if (node.id === nodeId) {
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const a = ancestors[i];
        if (a.type === 'folder' && a.locked === true
            && !(tempUnlocked && tempUnlocked.has(a.id))) {
          found = a;
          return;
        }
      }
      return;
    }
    for (const c of (node.children || [])) walk(c, [...ancestors, node]);
  })(root, []);
  return found;
}


// ─── Global rename ─────────────────────────────────────────────────────────
//
// Plain renameNode (core/nodes.js) only touches the live tree — past and
// future step snapshots still carry the OLD name inside their snapshot
// .tree spec, so navigating between steps reverts the rename. For node
// types whose identity is "global across the timeline" (mesh, flatShape,
// replaceModel — not folders, which are step-local containers), the
// rename must cascade into every step's snapshot.tree.

/**
 * Internal — produce a new snapshot.tree spec with the name of `id`
 * replaced. Returns the SAME spec object when there's no match (cheap
 * skip in the steps.map below).
 */
function _renameInTreeSpec(spec, id, newName) {
  if (!spec) return spec;
  if (spec.id === id) {
    if (spec.name === newName) return spec;
    return { ...spec, name: newName };
  }
  if (!spec.children?.length) return spec;
  let changed = false;
  const newKids = spec.children.map(c => {
    const r = _renameInTreeSpec(c, id, newName);
    if (r !== c) changed = true;
    return r;
  });
  return changed ? { ...spec, children: newKids } : spec;
}

/**
 * Rename a node globally — updates live name + every step's snapshot.tree
 * spec for that id. Undoable; restores the prior name across all steps.
 *
 * Use this for node types where the name is a global identifier (mesh,
 * flatShape, replaceModel). Folders use the legacy per-step rename
 * (their name is allowed to vary across steps).
 *
 * @param {string} nodeId
 * @param {string} newName
 * @returns {boolean}
 */
export function renameNodeGlobal(nodeId, newName) {
  const nb   = state.get('nodeById');
  const node = nb?.get(nodeId);
  if (!node) return false;
  newName = String(newName || '').trim();
  const oldName = node.name || '';
  if (!newName || newName === oldName) return false;

  const applyName = (name) => {
    const n = state.get('nodeById')?.get(nodeId);
    if (!n) return;
    n.name = name;
    if (n.object3d) n.object3d.name = name;
    const allSteps = state.get('steps') || [];
    const next = allSteps.map(s => {
      if (!s.snapshot) return s;
      const newTree = _renameInTreeSpec(s.snapshot.tree, nodeId, name);
      if (newTree === s.snapshot.tree) return s;
      return { ...s, snapshot: { ...s.snapshot, tree: newTree } };
    });
    state.setState({ steps: next });
    state.emit('change:treeData', state.get('treeData'));
    steps.scheduleTransformSync();
  };

  applyName(newName);
  state.markDirty();

  undoManager.push(
    `Rename "${oldName.slice(0, 16)}" → "${newName.slice(0, 16)}"`,
    () => applyName(oldName),
    () => applyName(newName),
  );
  return true;
}


/**
 * Add a clone of `sourceBId` as a child of `rmId` (a replace-model).
 *
 * Captures B's WORLD pose relative to RM at the current step and bakes
 * it into the clone's local transform — the clone sits at a fixed local
 * pose inside RM's wrap-group, so RM's per-step animations cascade to
 * it via Three.js scene parenting (no math required, unlike V0.1.55).
 *
 * On first add, the RM's original geometry gets wrapped in a Three.js
 * Group so the mesh's `visible=false` (originalGeometryHidden) doesn't
 * cascade to the copies (Three.js renderer skips descendants of a
 * hidden parent, so the wrap-group acts as a "render trampoline").
 *
 * Modes:
 *   - 'archiveAndReplace'  archive origin B after copying
 *   - 'copyAndReplace'     leave origin B alone
 *
 * v1 limitations:
 *   - sourceB must be type='mesh' or 'flatShape' (model deferred)
 *   - cloned material is shared with the source — change to source's
 *     material affects all clones. Intentional for v1.
 *   - undo restores the data + scene to pre-add state; redo just re-
 *     archives origin (full re-add comes in B.2-NEW.4).
 *
 * @param {string} rmId
 * @param {string} sourceBId
 * @param {'archiveAndReplace'|'copyAndReplace'} mode
 * @returns {boolean}
 */
export function addToReplaceModel(rmId, sourceBId, mode) {
  const T = window.THREE;
  if (!T) return false;
  const nb       = state.get('nodeById');
  const treeData = state.get('treeData');
  if (!nb || !treeData) return false;

  const rmNode  = nb.get(rmId);
  const srcNode = nb.get(sourceBId);
  if (!rmNode || !srcNode) return false;
  if (rmNode.type !== 'replaceModel') return false;
  if (rmId === sourceBId) return false;
  if (srcNode.type !== 'mesh' && srcNode.type !== 'flatShape') return false;
  if (srcNode.archived) return false;
  if (isDescendantOf(treeData, rmId, sourceBId)) return false;
  if (mode !== 'archiveAndReplace' && mode !== 'copyAndReplace') return false;

  const rmObj  = steps.object3dById?.get(rmId);
  const srcObj = steps.object3dById?.get(sourceBId);
  if (!rmObj || !srcObj) return false;

  // ── 1. Capture B's pose RELATIVE to RM at the current step ────────────
  rmObj.updateMatrixWorld(true);
  srcObj.updateMatrixWorld(true);
  const M_rm_world = rmObj.matrixWorld.clone();
  const M_b_world  = srcObj.matrixWorld.clone();
  const M_local    = new T.Matrix4().copy(M_rm_world).invert().multiply(M_b_world);
  const pos   = new T.Vector3();
  const quat  = new T.Quaternion();
  const scale = new T.Vector3();
  M_local.decompose(pos, quat, scale);

  // ── 2. Clone B's Three.js object3d (recursive deep clone) ─────────────
  const cloneObj = srcObj.clone(true);

  // ── 3. Wrap RM's mesh in a Group on first add ─────────────────────────
  // First add only — the RM's mesh becomes a child of a new wrap-group
  // (which inherits the mesh's pose). Subsequent adds reuse the same
  // wrap-group. Detected via userData.isReplaceModelGroup.
  let prevRmObjPos, prevRmObjQuat, prevRmObjScale, prevRmObjVisible, prevRmObjParent, originalMeshRef;
  const needsWrap = !rmObj.userData?.isReplaceModelGroup;
  let wrapGroup;
  if (needsWrap) {
    wrapGroup = new T.Group();
    wrapGroup.userData.isReplaceModelGroup = true;
    wrapGroup.userData.nodeId              = rmId;
    wrapGroup.name = (rmObj.name || 'RM') + '_RM';
    // Capture pose for undo
    prevRmObjPos     = rmObj.position.clone();
    prevRmObjQuat    = rmObj.quaternion.clone();
    prevRmObjScale   = rmObj.scale.clone();
    prevRmObjVisible = rmObj.visible;
    prevRmObjParent  = rmObj.parent;
    originalMeshRef  = rmObj;
    // Inherit pose
    wrapGroup.position.copy(rmObj.position);
    wrapGroup.quaternion.copy(rmObj.quaternion);
    wrapGroup.scale.copy(rmObj.scale);
    // Attach wrap-group to scene at rmObj's parent
    if (prevRmObjParent) prevRmObjParent.add(wrapGroup);
    // Reset rmObj local + reparent under wrap-group
    rmObj.position.set(0, 0, 0);
    rmObj.quaternion.identity();
    rmObj.scale.set(1, 1, 1);
    rmObj.userData.isReplaceModelOriginal = true;
    rmObj.userData.replaceModelId         = rmId;
    wrapGroup.add(rmObj);              // detaches from previous parent
    rmObj.visible = false;             // hide original geometry
    rmNode.object3d                   = wrapGroup;
    rmNode.originalGeometryHidden     = true;
    steps.object3dById.set(rmId, wrapGroup);
  } else {
    wrapGroup = rmObj;
  }

  // ── 4. Position + parent the clone ────────────────────────────────────
  cloneObj.position.copy(pos);
  cloneObj.quaternion.copy(quat);
  cloneObj.scale.copy(scale);
  wrapGroup.add(cloneObj);
  cloneObj.updateMatrixWorld(true);

  // ── 5. Create the data node for the clone ─────────────────────────────
  const copyId = generateId('rmChild');
  const copyType = srcNode.type;
  const copyNode = createNode(copyType, {
    id:                   copyId,
    name:                 (srcNode.name || 'Object') + ' (replacement)',
    archived:             false,
    localOffset:          [pos.x, pos.y, pos.z],
    localQuaternion:      [quat.x, quat.y, quat.z, quat.w],
    baseLocalPosition:    [0, 0, 0],
    baseLocalQuaternion:  [0, 0, 0, 1],
    baseLocalScale:       [scale.x, scale.y, scale.z],
    pivotEnabled:         false,
    pivotLocalOffset:     [0, 0, 0],
    pivotLocalQuaternion: [0, 0, 0, 1],
  });
  if (copyType === 'flatShape') {
    copyNode.templateId           = srcNode.templateId;
    copyNode.planeLocalQuaternion = [...(srcNode.planeLocalQuaternion || [0, 0, 0, 1])];
  } else if (copyType === 'mesh') {
    // bbox can be either an array [minX,minY,minZ,maxX,maxY,maxZ] OR an
    // object { min:[...], max:[...] } depending on how the mesh was
    // imported. Spreading an object throws "not iterable" — deep-clone
    // via JSON so either shape round-trips safely.
    copyNode.bbox        = srcNode.bbox ? JSON.parse(JSON.stringify(srcNode.bbox)) : null;
    copyNode.fingerprint = srcNode.fingerprint || null;
  }
  // sourceNodeId — pointer to the ORIGIN node B was cloned from. Save/
  // load uses this to re-clone the geometry on project reload: the
  // copy itself has no saved mesh data, so we walk back to the origin
  // and clone its live object3d again. See rebuildReplaceModelChildren.
  copyNode.sourceNodeId = sourceBId;
  copyNode.object3d            = cloneObj;
  cloneObj.userData.nodeId             = copyId;
  cloneObj.userData.meshNodeId         = copyId;
  cloneObj.userData.isReplaceModelChild= true;
  cloneObj.userData.replaceModelId     = rmId;
  // Stamp the same RM marker on every sub-mesh inside the clone so
  // raycast hits can promote to the RM (selection-promotion in
  // B.2-NEW.3 will walk userData.replaceModelId).
  cloneObj.traverse((o) => {
    if (o === cloneObj) return;
    o.userData = o.userData || {};
    o.userData.replaceModelId      = rmId;
    o.userData.replaceModelChildId = copyId;
  });

  // ── 6. Add to data tree ───────────────────────────────────────────────
  rmNode.children = rmNode.children || [];
  rmNode.children.push(copyNode);
  steps.object3dById.set(copyId, cloneObj);
  state.setState({ nodeById: _nodes_buildNodeMap(treeData) });

  // ── 6b. Register clone with the materials registry so color presets
  //        can apply to it. registerMesh stashes the original material
  //        so 'Revert to default' works too. Walks sub-meshes inside a
  //        Group clone (flatShape's object3d is often a Group of meshes).
  if (cloneObj.isMesh) {
    materials.registerMesh?.(copyId, cloneObj);
  } else {
    cloneObj.traverse((o) => {
      if (o.isMesh) materials.registerMesh?.(copyId, o);
    });
  }

  // ── 6c-bis. Flat-shape children of B come through the recursive clone
  //          as Three.js sub-objects, but without data-tree entries —
  //          which means the user can't see or interact with them in
  //          the tree. Walk the source's tree children in parallel with
  //          the clone's Three.js children and register each flatShape
  //          as a sub-copy node under the RM child. Recurses for nested
  //          shapes. Save preserves sourceNodeId on each sub-copy so
  //          rebuildReplaceModelChildren can re-attach them on reload.
  _processRMChildShapesRecursively(srcNode, copyNode, srcObj, cloneObj, rmId);

  // ── 6c. Per-step color inheritance from RM → copy. ────────────────────
  // For every step where the RM has a color assigned, propagate that
  // SAME color to the new copy in that step's snapshot. Steps where
  // the RM has no color leave the copy without a color too (so the
  // child mirrors whatever the RM does step-by-step). This is the
  // step-sensitive "RM cascade" — applying a new RM color afterwards
  // touches the current step only, and the change still cascades to
  // children via _expandRMSelection.
  //
  // snapshot.materials is a DIRECT { [meshId]: presetId } map (see
  // _bulkAssignColorMulti / materials.applySnapshot — there's NO
  // `.assignments` sub-prop). Write to that map directly.
  const rmPresetLive       = materials.meshColorAssignments?.[rmId];
  const rmDefaultColorLive = materials.meshDefaultColors?.[rmId];
  if (rmPresetLive != null)       materials.meshColorAssignments[copyId] = rmPresetLive;
  if (rmDefaultColorLive != null) materials.meshDefaultColors[copyId]    = rmDefaultColorLive;
  {
    const allSteps2 = state.get('steps') || [];
    const next2 = allSteps2.map(s => {
      const mat = s.snapshot?.materials;
      if (!mat) return s;
      const rmColorInStep = mat[rmId];
      if (rmColorInStep == null) return s;
      const newMat = { ...mat, [copyId]: rmColorInStep };
      return { ...s, snapshot: { ...s.snapshot, materials: newMat } };
    });
    state.setState({ steps: next2 });
  }

  // ── 7. Propagate the new copy node into every step's snapshot.tree ───
  _propagateNewNodeToSteps(copyNode, rmId);

  // ── 8. Archive origin B if requested ──────────────────────────────────
  const originPrevArchived = srcNode.archived === true;
  if (mode === 'archiveAndReplace') {
    const sn = state.get('nodeById')?.get(sourceBId);
    if (sn) sn.archived = true;
  }

  // ── 9. Visual sync ────────────────────────────────────────────────────
  // _syncVis() is the canonical "apply data → scene" call: runs
  // applyAllVisibility (archive trumps visibility), emits change:treeData
  // (tree row re-render), then scheduleSync (transforms + materials).
  // Plain applyAllVisibility on its own didn't refresh the tree icon
  // / opacity for the archived origin — _syncVis closes the loop.
  _syncVis();
  materials.applyAll();
  steps.scheduleTransformSync();
  state.markDirty();

  // ── 10. Undo / Redo ───────────────────────────────────────────────────
  undoManager.push(
    `Add "${(srcNode.name || 'object').slice(0, 16)}" to Replace-Model`,
    () => {
      // ── UNDO ─────────────────────────────────────────────────────────
      // 1. Restore origin B's archive state
      const sn = state.get('nodeById')?.get(sourceBId);
      if (sn) sn.archived = originPrevArchived;

      // 2. Remove the copy from RM's children + all step snapshots
      const rmN = state.get('nodeById')?.get(rmId);
      if (rmN?.children) {
        rmN.children = rmN.children.filter(c => c.id !== copyId);
      }
      const td  = state.get('treeData');
      const stp = state.get('steps') || [];
      const next = stp.map(s => {
        if (!s.snapshot) return s;
        const tr   = { ...(s.snapshot.transforms || {}) }; delete tr[copyId];
        const vi   = { ...(s.snapshot.visibility || {}) }; delete vi[copyId];
        const tree = _removeFromTreeSpec(s.snapshot.tree, copyId);
        // Strip the per-step material assignment we wrote at add-time.
        // snap.materials is a DIRECT map keyed by mesh id (no
        // `.assignments` sub-prop) — same shape _bulkAssignColorMulti uses.
        let mat = s.snapshot.materials;
        if (mat && copyId in mat) {
          mat = { ...mat };
          delete mat[copyId];
        }
        return { ...s, snapshot: { ...s.snapshot, tree, transforms: tr, visibility: vi, materials: mat } };
      });
      state.setState({ steps: next });
      // Drop the global material entries too — they belonged solely to
      // the copy we're removing.
      delete materials.meshColorAssignments[copyId];
      delete materials.meshDefaultColors[copyId];

      // 3. Detach + dispose the clone in Three.js + unregister materials.
      // Walk copyNode's data-tree children to clean up sub-shape copy
      // registrations too (their Three.js objects leave the scene with
      // cloneObj.parent.remove, but the ID maps + global material
      // assignments would linger otherwise — the audit found this
      // leaked across undo/redo cycles on RM children that had
      // flatShape sub-nodes).
      (function cleanupSubs(n) {
        for (const c of (n.children || [])) {
          steps.object3dById.delete(c.id);
          materials.unregisterMesh?.(c.id);
          delete materials.meshColorAssignments[c.id];
          delete materials.meshDefaultColors[c.id];
          cleanupSubs(c);
        }
      })(copyNode);
      if (cloneObj.parent) cloneObj.parent.remove(cloneObj);
      steps.object3dById.delete(copyId);
      materials.unregisterMesh?.(copyId);

      // 4. Unwrap RM if this was the first add
      if (needsWrap && originalMeshRef && wrapGroup) {
        if (originalMeshRef.parent === wrapGroup) wrapGroup.remove(originalMeshRef);
        originalMeshRef.position.copy(prevRmObjPos);
        originalMeshRef.quaternion.copy(prevRmObjQuat);
        originalMeshRef.scale.copy(prevRmObjScale);
        originalMeshRef.visible = prevRmObjVisible;
        delete originalMeshRef.userData.isReplaceModelOriginal;
        delete originalMeshRef.userData.replaceModelId;
        if (prevRmObjParent) prevRmObjParent.add(originalMeshRef);
        if (wrapGroup.parent) wrapGroup.parent.remove(wrapGroup);
        const rmN2 = state.get('nodeById')?.get(rmId);
        if (rmN2) {
          rmN2.object3d              = originalMeshRef;
          rmN2.originalGeometryHidden = false;
        }
        steps.object3dById.set(rmId, originalMeshRef);
      }

      state.setState({ nodeById: _nodes_buildNodeMap(td) });
      _syncVis();
      materials.applyAll();
      steps.scheduleTransformSync();
    },
    () => {
      // ── REDO ─────────────────────────────────────────────────────────
      // v1 redo is intentionally minimal — re-running addToReplaceModel
      // properly requires re-cloning + re-wrapping which has too many
      // side-effects to replay safely. The user can just run the menu
      // entry again.
      // (Full redo support lands in B.2-NEW.4.)
    },
  );

  return true;
}

// `_removeFromTreeSpec` is already defined later in this file (used by
// other actions that surgically prune step snapshots). The B.2-NEW.2
// undo path reuses it — no separate copy needed here.


// ─── Shared helper: register flat-shape descendants of an RM child ────────
//
// When B is cloned (in addToReplaceModel) or re-cloned (on load via
// rebuildReplaceModelChildren), its flatShape children come through as
// Three.js sub-objects of the clone but have NO data-tree entries —
// they're invisible in the tree and uninteractive. This helper walks
// the source's data-tree children in parallel with the clone's
// Three.js children and:
//
//   - For ADD path: CREATES a sub-copy data node under the RM child
//     with sourceNodeId pointing to the original shape.
//   - For LOAD path: REUSES the sub-copy data node (already loaded
//     from the saved spec via the sourceNodeId match).
//
// Either way, the helper stamps userData + registers the Three.js
// sub-object with materials so the shape paints and selects. Recurses
// for nested shape children, capped at depth 8 for safety.
function _processRMChildShapesRecursively(srcDataNode, copyDataNode, srcObj, cloneObj, rmId, depth = 0) {
  if (depth > 8) return;
  if (!srcDataNode || !copyDataNode || !srcObj || !cloneObj) return;
  if (!Array.isArray(srcObj.children) || !Array.isArray(cloneObj.children)) return;

  for (const srcChild of (srcDataNode.children || [])) {
    if (srcChild.type !== 'flatShape') continue;
    const origSubObj = srcChild.object3d;
    if (!origSubObj) continue;

    // clone(true) preserves children order; match by index in source's
    // Three.js children list (NOT data-tree index — these can differ).
    const idx = srcObj.children.indexOf(origSubObj);
    if (idx < 0) continue;
    const cloneSubObj = cloneObj.children[idx];
    if (!cloneSubObj) continue;

    // Find existing sub-copy (LOAD path) or create new (ADD path).
    let subCopy = (copyDataNode.children || []).find(c => c.sourceNodeId === srcChild.id);
    if (!subCopy) {
      const subId = generateId('rmShape');
      subCopy = createNode('flatShape', {
        id:                   subId,
        name:                 srcChild.name || 'Shape',
        templateId:           srcChild.templateId,
        planeLocalQuaternion: [...(srcChild.planeLocalQuaternion || [0, 0, 0, 1])],
        localOffset:          [...(srcChild.localOffset          || [0, 0, 0])],
        localQuaternion:      [...(srcChild.localQuaternion      || [0, 0, 0, 1])],
        baseLocalPosition:    [...(srcChild.baseLocalPosition    || [0, 0, 0])],
        baseLocalQuaternion:  [...(srcChild.baseLocalQuaternion  || [0, 0, 0, 1])],
        baseLocalScale:       [...(srcChild.baseLocalScale       || [1, 1, 1])],
        pivotEnabled:         false,
        pivotLocalOffset:     [0, 0, 0],
        pivotLocalQuaternion: [0, 0, 0, 1],
      });
      subCopy.sourceNodeId = srcChild.id;
      copyDataNode.children = copyDataNode.children || [];
      copyDataNode.children.push(subCopy);
    }

    subCopy.object3d = cloneSubObj;
    cloneSubObj.userData.nodeId              = subCopy.id;
    cloneSubObj.userData.flatShapeNodeId     = subCopy.id;
    cloneSubObj.userData.meshNodeId          = subCopy.id;
    cloneSubObj.userData.isReplaceModelChild = true;
    cloneSubObj.userData.replaceModelId      = rmId;
    cloneSubObj.userData.replaceModelChildId = subCopy.id;
    steps.object3dById.set(subCopy.id, cloneSubObj);

    if (cloneSubObj.isMesh) {
      materials.registerMesh?.(subCopy.id, cloneSubObj);
    } else {
      cloneSubObj.traverse((o) => {
        if (o.isMesh) materials.registerMesh?.(subCopy.id, o);
      });
    }

    // Recurse for nested shapes under this one.
    _processRMChildShapesRecursively(srcChild, subCopy, origSubObj, cloneSubObj, rmId, depth + 1);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  REPLACE-MODEL POST-LOAD REBUILD (B.2-NEW.2.5)
// ═══════════════════════════════════════════════════════════════════════════
//
// At save time, RM children carry only their data (id / name / transform /
// sourceNodeId). Their Three.js geometry was a runtime .clone() that
// nothing on disk captures. On project load this function walks every RM,
// wraps its original mesh in a Group, and re-clones each child's origin
// object3d back into the wrap-group, restoring the in-memory scene to
// what the user had at save time.
//
// Must run AFTER all assets are loaded (so source object3ds are wired)
// and BEFORE the first step is activated (so rebuildFromTreeSpec sees
// the wrap-group + child clones already in place).

// ─── Replace-Model child operations (B.2-NEW.3) ───────────────────────────
//
// RM children only support two operations per the user spec:
//   1. Remove from RM (delete the copy + cleanup).
//   2. Global transform (translate / rotate / scale relative to the
//      RM, baked into the child's pose — no per-step animation).

/**
 * Remove an RM child copy from its replaceModel.
 *
 * The copy node is removed from the data tree, the cloned object3d is
 * detached from the wrap-group, all materials / object3dById entries
 * are cleaned up, and the copy is stripped from every step's snapshot
 * (.tree, .transforms, .visibility, .materials).
 *
 * @param {string} childId
 * @param {object} [options]
 * @param {boolean} [options.unarchiveOrigin=false]  If the source origin
 *           is archived, also flip it back to un-archived after removal.
 * @returns {boolean} true on success
 */
export function removeFromReplaceModel(childId, options = {}) {
  const nb       = state.get('nodeById');
  const treeData = state.get('treeData');
  if (!nb || !treeData) return false;

  const child = nb.get(childId);
  if (!child) return false;
  // Find the RM ancestor in the data tree.
  const rmNode = findReplaceModelAncestor(treeData, childId);
  if (!rmNode) return false;

  // Find the immediate parent (the copy might be nested under a sub-shape).
  const parent = findParent(treeData, childId);
  if (!parent) return false;
  const idxInParent = (parent.children || []).indexOf(child);
  if (idxInParent < 0) return false;

  // Capture for undo.
  const childSpec    = serializeModelTree(child);   // includes nested sub-shapes
  const originId     = child.sourceNodeId || null;
  const originLive   = originId ? nb.get(originId) : null;
  const originWasArchived = originLive?.archived === true;
  const cloneObjRef  = child.object3d || steps.object3dById?.get(childId) || null;
  const parentId     = parent.id;
  // Material assignments for the copy + any sub-copies.
  const collectIds = (n, out = []) => {
    out.push(n.id);
    for (const c of (n.children || [])) collectIds(c, out);
    return out;
  };
  const allIds = collectIds(child);
  const prevColors = {};
  const prevDefaults = {};
  for (const id of allIds) {
    if (id in (materials.meshColorAssignments || {})) prevColors[id]   = materials.meshColorAssignments[id];
    if (id in (materials.meshDefaultColors    || {})) prevDefaults[id] = materials.meshDefaultColors[id];
  }
  // Per-step snapshot entries for the copy + sub-copies — capture before
  // we strip so undo can restore exactly.
  const prevSnapshotEntries = (state.get('steps') || []).map(s => {
    const out = { stepId: s.id };
    if (!s.snapshot) return out;
    out.tree = s.snapshot.tree;   // keep ref for undo restore via re-add
    out.transforms = {};
    out.visibility = {};
    out.materials  = {};
    for (const id of allIds) {
      if (s.snapshot.transforms && id in s.snapshot.transforms) {
        out.transforms[id] = s.snapshot.transforms[id];
      }
      if (s.snapshot.visibility && id in s.snapshot.visibility) {
        out.visibility[id] = s.snapshot.visibility[id];
      }
      if (s.snapshot.materials && id in s.snapshot.materials) {
        out.materials[id] = s.snapshot.materials[id];
      }
    }
    return out;
  });

  const removeNow = () => {
    const nb2 = state.get('nodeById');
    const td2 = state.get('treeData');
    if (!nb2 || !td2) return;

    // 1. Detach cloneObj from Three.js scene + dispose ID maps
    if (cloneObjRef?.parent) cloneObjRef.parent.remove(cloneObjRef);
    for (const id of allIds) {
      steps.object3dById?.delete(id);
      materials.unregisterMesh?.(id);
      delete materials.meshColorAssignments[id];
      delete materials.meshDefaultColors[id];
    }

    // 2. Remove from parent's children in data tree
    const liveParent = nb2.get(parentId);
    if (liveParent?.children) {
      liveParent.children = liveParent.children.filter(c => c.id !== childId);
    }
    // 3. Strip from every step snapshot — tree, transforms, visibility,
    //    materials (each by every id in `allIds`).
    const stp = state.get('steps') || [];
    const next = stp.map(s => {
      if (!s.snapshot) return s;
      let tree = s.snapshot.tree;
      for (const id of allIds) tree = _removeFromTreeSpec(tree, id);
      const tr = { ...(s.snapshot.transforms || {}) };
      const vi = { ...(s.snapshot.visibility || {}) };
      const mat = { ...(s.snapshot.materials  || {}) };
      for (const id of allIds) { delete tr[id]; delete vi[id]; delete mat[id]; }
      return { ...s, snapshot: { ...s.snapshot, tree, transforms: tr, visibility: vi, materials: mat } };
    });
    state.setState({ steps: next, nodeById: _nodes_buildNodeMap(td2) });

    // 4. Optionally un-archive the origin source node.
    if (options.unarchiveOrigin && originLive) {
      const ol = state.get('nodeById')?.get(originId);
      if (ol) ol.archived = false;
    }

    state.emit('change:treeData', td2);
    materials.applyAll();
    steps.scheduleTransformSync();
    state.markDirty();
  };
  removeNow();

  // ── Undo / Redo ─────────────────────────────────────────────────────
  // Undo restores the data node + every step entry + (optionally) the
  // origin's archive state. Redo re-runs removeNow.
  // The clone's Three.js geometry is RE-CLONED from the source on undo
  // (same as rebuildReplaceModelChildren) — we can't re-attach the
  // disposed cloneObj reliably, so we recompute.
  undoManager.push(
    `Remove "${(child.name || 'copy').slice(0, 20)}" from Replace-Model`,
    () => {
      // Undo — re-insert the child + its sub-shapes by replaying the
      // logic in rebuildReplaceModelChildren for this RM.
      const nb3 = state.get('nodeById');
      const td3 = state.get('treeData');
      if (!nb3 || !td3) return;
      const rmLive   = nb3.get(rmNode.id);
      const parLive  = nb3.get(parentId);
      if (!rmLive || !parLive) return;
      // Re-create the data node from spec (deep clone via JSON to drop
      // any object3d residue) and re-attach at the saved index.
      const restored = JSON.parse(JSON.stringify(childSpec));
      (function clearObj3d(n) {
        n.object3d = null;
        for (const c of (n.children || [])) clearObj3d(c);
      })(restored);
      parLive.children = parLive.children || [];
      parLive.children.splice(idxInParent, 0, restored);
      // Restore snapshot entries.
      const stp = state.get('steps') || [];
      const next = stp.map(s => {
        if (!s.snapshot) return s;
        const restoredEntry = prevSnapshotEntries.find(e => e.stepId === s.id);
        if (!restoredEntry) return s;
        // Re-insert into snapshot.tree at the RM's children.
        const newTree = _addToTreeSpec(s.snapshot.tree, parentId, serializeModelTree(restored));
        const tr = { ...(s.snapshot.transforms || {}), ...restoredEntry.transforms };
        const vi = { ...(s.snapshot.visibility || {}), ...restoredEntry.visibility };
        const mat = { ...(s.snapshot.materials  || {}), ...restoredEntry.materials };
        return { ...s, snapshot: { ...s.snapshot, tree: newTree || s.snapshot.tree, transforms: tr, visibility: vi, materials: mat } };
      });
      state.setState({ steps: next, nodeById: _nodes_buildNodeMap(td3) });
      // Restore material entries (global).
      for (const [id, preset] of Object.entries(prevColors))   materials.meshColorAssignments[id] = preset;
      for (const [id, preset] of Object.entries(prevDefaults)) materials.meshDefaultColors[id]    = preset;
      // Restore origin archive state.
      if (options.unarchiveOrigin && originLive) {
        const ol = state.get('nodeById')?.get(originId);
        if (ol) ol.archived = originWasArchived;
      }
      // Re-clone the source geometry into the wrap-group via the
      // existing rebuild path (idempotent).
      rebuildReplaceModelChildren();
      state.emit('change:treeData', state.get('treeData'));
      materials.applyAll();
      steps.scheduleTransformSync();
    },
    () => { removeNow(); },
  );

  return true;
}

/**
 * Apply a global transform (translate Δ + rotate Δ Euler degrees +
 * uniform scale ×) to an RM child copy. Bakes into baseLocal* fields
 * and pushes per-Three.js obj3d updates manually (mesh-type nodes are
 * not transform nodes so applyNodeTransformToObject3D bails on them).
 *
 * @param {string} childId
 * @param {object} params { dx, dy, dz, rx, ry, rz, sx, sy, sz }
 */
export function applyRMChildGlobalTransform(childId, params) {
  const T = window.THREE;
  if (!T) return false;
  const nb   = state.get('nodeById');
  const node = nb?.get(childId);
  if (!node) return false;
  const treeData = state.get('treeData');
  if (!treeData) return false;
  const rm = findReplaceModelAncestor(treeData, childId);
  if (!rm) return false;

  const dx = +(params?.dx ?? 0), dy = +(params?.dy ?? 0), dz = +(params?.dz ?? 0);
  const rx = +(params?.rx ?? 0) * Math.PI / 180;
  const ry = +(params?.ry ?? 0) * Math.PI / 180;
  const rz = +(params?.rz ?? 0) * Math.PI / 180;
  const sx = +(params?.sx ?? 1), sy = +(params?.sy ?? 1), sz = +(params?.sz ?? 1);
  if (dx === 0 && dy === 0 && dz === 0 && rx === 0 && ry === 0 && rz === 0 && sx === 1 && sy === 1 && sz === 1) {
    return false;
  }

  // Capture before for undo.
  const before = {
    baseLocalPosition:   [...(node.baseLocalPosition   || [0, 0, 0])],
    baseLocalQuaternion: [...(node.baseLocalQuaternion || [0, 0, 0, 1])],
    baseLocalScale:      [...(node.baseLocalScale      || [1, 1, 1])],
  };

  const apply = (which) => {
    const n = state.get('nodeById')?.get(childId);
    if (!n) return;
    if (which === 'undo') {
      n.baseLocalPosition   = [...before.baseLocalPosition];
      n.baseLocalQuaternion = [...before.baseLocalQuaternion];
      n.baseLocalScale      = [...before.baseLocalScale];
    } else {
      // Translate Δ — add directly.
      n.baseLocalPosition = [
        (n.baseLocalPosition?.[0] || 0) + dx,
        (n.baseLocalPosition?.[1] || 0) + dy,
        (n.baseLocalPosition?.[2] || 0) + dz,
      ];
      // Rotate Δ Euler — compose: base × delta.
      const qBase   = new T.Quaternion(
        n.baseLocalQuaternion?.[0] || 0,
        n.baseLocalQuaternion?.[1] || 0,
        n.baseLocalQuaternion?.[2] || 0,
        n.baseLocalQuaternion?.[3] ?? 1,
      );
      const qDelta = new T.Quaternion().setFromEuler(new T.Euler(rx, ry, rz, 'XYZ'));
      const qTotal = qBase.multiply(qDelta);
      n.baseLocalQuaternion = [qTotal.x, qTotal.y, qTotal.z, qTotal.w];
      // Scale × — multiply each axis.
      n.baseLocalScale = [
        (n.baseLocalScale?.[0] ?? 1) * sx,
        (n.baseLocalScale?.[1] ?? 1) * sy,
        (n.baseLocalScale?.[2] ?? 1) * sz,
      ];
    }
    // Apply to obj3d directly — mesh-type RM children aren't transform
    // nodes (isTransformNode=false), so applyNodeTransformToObject3D
    // would bail. Compose the same way getComputedLocalPosition +
    // getTotalLocalQuaternion do, but write to obj3d.position/quat/scale.
    const obj = steps.object3dById?.get(childId);
    if (obj) {
      const bp = n.baseLocalPosition   || [0, 0, 0];
      const lp = n.localOffset         || [0, 0, 0];
      const bq = n.baseLocalQuaternion || [0, 0, 0, 1];
      const lq = n.localQuaternion     || [0, 0, 0, 1];
      const bs = n.baseLocalScale      || [1, 1, 1];
      obj.position.set(bp[0] + lp[0], bp[1] + lp[1], bp[2] + lp[2]);
      const qb = new T.Quaternion(bq[0], bq[1], bq[2], bq[3]);
      const ql = new T.Quaternion(lq[0], lq[1], lq[2], lq[3]);
      obj.quaternion.copy(qb).multiply(ql);
      obj.scale.set(bs[0], bs[1], bs[2]);
      obj.updateMatrix();
    }
    state.emit('change:treeData', state.get('treeData'));
    steps.scheduleTransformSync();
    state.markDirty();
  };

  apply('do');

  undoManager.push(
    `Global transform "${(node.name || 'copy').slice(0, 20)}"`,
    () => apply('undo'),
    () => apply('do'),
  );
  return true;
}

/**
 * Walk up the tree to find a replaceModel ancestor of `nodeId`.
 * Public helper (used by both actions.js + tree.js) — returns the RM
 * TreeNode or null.
 */
export function findReplaceModelAncestor(root, nodeId) {
  if (!root || !nodeId) return null;
  let found = null;
  (function walk(node, ancestors) {
    if (found) return;
    if (node.id === nodeId) {
      for (let i = ancestors.length - 1; i >= 0; i--) {
        if (ancestors[i].type === 'replaceModel') { found = ancestors[i]; return; }
      }
      return;
    }
    for (const c of (node.children || [])) walk(c, [...ancestors, node]);
  })(root, []);
  return found;
}


/**
 * Post-load rebuild for every replaceModel in the live tree. Idempotent
 * — re-running on an already-wrapped RM is a no-op.
 */
export function rebuildReplaceModelChildren() {
  const T = window.THREE;
  if (!T) return;
  const treeData = state.get('treeData');
  if (!treeData) return;

  const rms = [];
  (function walk(node) {
    if (node?.type === 'replaceModel' && (node.children?.length || 0) > 0) {
      rms.push(node);
    }
    for (const c of (node?.children || [])) walk(c);
  })(treeData);

  for (const rm of rms) _rebuildOneReplaceModel(rm, T);
}

function _rebuildOneReplaceModel(rm, T) {
  const rmObj = steps.object3dById?.get(rm.id);
  if (!rmObj) {
    // Missing source for A — RM is orphaned. Skip; the data tree still
    // lists children but they won't render without their parent geometry.
    console.warn('[replaceModel] post-load: RM has no object3d:', rm.id);
    return;
  }

  // Already wrapped (re-run safety) — just ensure children are attached.
  if (rmObj.userData?.isReplaceModelGroup) {
    for (const child of (rm.children || [])) {
      if (!steps.object3dById.has(child.id)) _rebuildOneRMChild(child, rm, rmObj, T);
    }
    return;
  }

  const sceneParent = rmObj.parent;
  if (!sceneParent) {
    console.warn('[replaceModel] post-load: RM mesh has no scene parent:', rm.id);
    return;
  }

  // ── Wrap A's mesh in a Group (same mechanics as addToReplaceModel) ─
  const wrapGroup = new T.Group();
  wrapGroup.userData.isReplaceModelGroup = true;
  wrapGroup.userData.nodeId              = rm.id;
  wrapGroup.name = (rmObj.name || 'RM') + '_RM';
  wrapGroup.position.copy(rmObj.position);
  wrapGroup.quaternion.copy(rmObj.quaternion);
  wrapGroup.scale.copy(rmObj.scale);
  sceneParent.add(wrapGroup);

  rmObj.position.set(0, 0, 0);
  rmObj.quaternion.identity();
  rmObj.scale.set(1, 1, 1);
  rmObj.userData.isReplaceModelOriginal = true;
  rmObj.userData.replaceModelId         = rm.id;
  wrapGroup.add(rmObj);
  if (rm.originalGeometryHidden === true) rmObj.visible = false;

  rm.object3d = wrapGroup;
  steps.object3dById.set(rm.id, wrapGroup);

  // ── Build each child's object3d via clone of its source ────────────
  for (const child of (rm.children || [])) {
    _rebuildOneRMChild(child, rm, wrapGroup, T);
  }
}

function _rebuildOneRMChild(child, rm, wrapGroup, T) {
  const sourceId = child.sourceNodeId;
  if (!sourceId) return;
  const sourceObj = steps.object3dById?.get(sourceId);
  if (!sourceObj) {
    // Source missing — could render a bbox placeholder here. For v1
    // just warn; the child node exists in the tree but has no geometry.
    console.warn('[replaceModel] post-load: source missing for RM child:', child.id, 'src:', sourceId);
    return;
  }

  const cloneObj = sourceObj.clone(true);

  // Restore the saved local pose.
  const lp = child.localOffset     || [0, 0, 0];
  const lq = child.localQuaternion || [0, 0, 0, 1];
  const ls = child.baseLocalScale  || [1, 1, 1];
  cloneObj.position.set(lp[0], lp[1], lp[2]);
  cloneObj.quaternion.set(lq[0], lq[1], lq[2], lq[3]);
  cloneObj.scale.set(ls[0], ls[1], ls[2]);

  wrapGroup.add(cloneObj);

  // Stamp userData for picking + selection promotion.
  cloneObj.userData.nodeId              = child.id;
  cloneObj.userData.meshNodeId          = child.id;
  cloneObj.userData.isReplaceModelChild = true;
  cloneObj.userData.replaceModelId      = rm.id;
  cloneObj.traverse((o) => {
    if (o === cloneObj) return;
    o.userData = o.userData || {};
    o.userData.replaceModelId      = rm.id;
    o.userData.replaceModelChildId = child.id;
  });

  child.object3d = cloneObj;
  steps.object3dById.set(child.id, cloneObj);

  // Register with materials so color presets can paint the clone.
  if (cloneObj.isMesh) {
    materials.registerMesh?.(child.id, cloneObj);
  } else {
    cloneObj.traverse((o) => {
      if (o.isMesh) materials.registerMesh?.(child.id, o);
    });
  }

  // Re-attach flat-shape sub-copies (loaded from spec) to their
  // corresponding clone sub-objects. The data tree already has the
  // sub-copy nodes (saved via _processRMChildShapesRecursively at
  // add-time); this just wires the Three.js side back together.
  const srcDataNode = state.get('nodeById')?.get(sourceId);
  if (srcDataNode) {
    _processRMChildShapesRecursively(srcDataNode, child, sourceObj, cloneObj, rm.id);
  }
}


/**
 * Re-stage the CURRENT active step's visibility snapshot to live nodes
 * + scene. Called after any setState that mutated step snapshots so the
 * viewport reflects the new state of whatever step the user is on RIGHT
 * NOW (which may differ from the active step at apply time, after a
 * series of undos / redos / step switches). Safe to call when no
 * snapshot exists — bails silently.
 */
function _restageActiveVisibility(stepsArr) {
  const activeId = state.get('activeStepId');
  if (!activeId) return;
  const activeStep = stepsArr.find(x => x.id === activeId);
  const vis = activeStep?.snapshot?.visibility;
  if (!vis) return;
  const nb = state.get('nodeById');
  for (const [id, v] of Object.entries(vis)) {
    const n = nb.get(id);
    if (n) n.localVisible = !!v;
  }
  const treeData = state.get('treeData');
  if (treeData) {
    applyAllVisibility(treeData, steps.object3dById);
    state.emit('change:treeData', treeData);
  }
}

function _toggleVisibilityMulti(ids, newVis, stepIdSet, treeData) {
  const allSteps = state.get('steps') || [];

  // For each step in the set, compute its NEW visibility map. Skip
  // unchanged ones so the no-op steps stay === old (refcount equality
  // makes the touched-count check below cheap).
  const nextSteps = allSteps.map(s => {
    if (!stepIdSet.has(s.id)) return s;
    const snap = s.snapshot || {};
    const oldVis = snap.visibility || {};
    const changes = newVis
      ? _computeShowCascadeChanges(oldVis, ids, treeData)
      : Object.fromEntries(ids.map(id => [id, false]));
    if (Object.keys(changes).length === 0) return s;
    const newViz = { ...oldVis, ...changes };
    return { ...s, snapshot: { ...snap, visibility: newViz } };
  });
  const touched = nextSteps.filter((s, i) => s !== allSteps[i]);
  if (touched.length === 0) return;
  const touchedIds = touched.map(s => s.id);

  const apply = (stepsArr) => {
    state.setState({ steps: stepsArr });
    state.markDirty();
    // Re-evaluate active step at run time, NOT at apply time. Between
    // apply and an eventual undo/redo the user may have switched
    // steps; we always want the viewport to reflect WHATEVER step is
    // currently active under the new state.steps array.
    _restageActiveVisibility(stepsArr);
    // Tell the UI which step cards just changed so they can flash.
    state.emit('steps:bulkApplied', { stepIds: touchedIds });
  };
  apply(nextSteps);

  undoManager.push(
    `${newVis ? 'Show' : 'Hide'} ${ids.length} node(s) on ${touched.length} step(s)`,
    () => apply(allSteps),
    () => apply(nextSteps),
  );
}

/**
 * Set one-or-more nodes' visibility across a range of steps relative to the
 * ACTIVE step (exclusive) — as a SINGLE undo entry. scope:
 *   'following' → every step AFTER the active one
 *   'previous'  → every step BEFORE the active one
 * Per the agreed scope: affects only the exact nodes (no child cascade, no
 * show-ancestor cascade) and never the active step itself (use plain Hide/Show
 * for that). Writes straight into each target step's self-contained snapshot
 * visibility map. The active view doesn't change — the affected step cards
 * flash via 'steps:bulkApplied' so the user sees what was touched.
 */
export function setNodeVisibilityAcrossSteps(nodeIds, visible, scope) {
  if (isIsolateEngaged()) { setStatus('Un-isolate to change hide/show'); return; }
  const nodeById = state.get('nodeById');
  const ids = [...(nodeIds || [])].filter(id => nodeById?.has(id));
  if (!ids.length || (scope !== 'following' && scope !== 'previous')) return;

  const allSteps  = state.get('steps') || [];
  const activeIdx = allSteps.findIndex(s => s.id === state.get('activeStepId'));
  if (activeIdx < 0) return;
  const inRange = (idx) => scope === 'following' ? idx > activeIdx : idx < activeIdx;

  const nextSteps = allSteps.map((s, idx) => {
    if (!inRange(idx)) return s;
    const snap   = s.snapshot || {};
    const oldVis = snap.visibility || {};
    // Skip steps already at the target for every id (keeps refcount equality).
    if (ids.every(id => (oldVis[id] !== false) === visible)) return s;
    const newViz = { ...oldVis };
    for (const id of ids) newViz[id] = visible;
    return { ...s, snapshot: { ...snap, visibility: newViz } };
  });

  const touched = nextSteps.filter((s, i) => s !== allSteps[i]);
  if (!touched.length) return;
  const touchedIds = touched.map(s => s.id);

  const apply = (stepsArr) => {
    state.setState({ steps: stepsArr });
    state.markDirty();
    _restageActiveVisibility(stepsArr);   // active step unaffected; keeps live state consistent across undo/redo
    state.emit('steps:bulkApplied', { stepIds: touchedIds });
  };
  apply(nextSteps);

  undoManager.push(
    `${visible ? 'Show' : 'Hide'} ${ids.length} node(s) on ${touched.length} ${scope} step(s)`,
    () => apply(allSteps),
    () => apply(nextSteps),
  );
}

/**
 * Given a current visibility map and a set of ids being SHOWN, return
 * the minimal {id: bool} delta that:
 *   1. Sets each target id visible.
 *   2. For every ANCESTOR of any target that was hidden, flips it
 *      visible AND hides its non-path-non-target children.
 *
 * Already-visible ancestors are untouched (their siblings stay as-is).
 * The tree shape used for ancestor walks is the LIVE treeData; in
 * 99% of projects every step shares the same shape so this works as
 * expected. If a step has been reparented differently, cascade may
 * miss in that step — refine to per-step tree if it ever bites.
 */
function _computeShowCascadeChanges(visMap, ids, treeData) {
  const changes = {};
  if (!treeData) {
    for (const id of ids) if (visMap[id] !== true) changes[id] = true;
    return changes;
  }
  const parentOf = captureParentMap(treeData);
  // Build the preserve set: ids ∪ all ancestors of any id, up to root.
  const preserve = new Set(ids);
  for (const id of ids) {
    let cur = parentOf[id];
    while (cur) {
      if (preserve.has(cur)) break;
      preserve.add(cur);
      cur = parentOf[cur];
    }
  }
  // For each preserve ancestor that was hidden, flip it visible AND
  // hide every non-preserve direct child. Skip the targets — they're
  // handled at the end so their flip wins.
  for (const id of preserve) {
    if (ids.includes(id)) continue;
    if (visMap[id] === false) {
      changes[id] = true;
      const node = findNode(treeData, id);
      for (const child of (node?.children || [])) {
        if (!preserve.has(child.id)) {
          if (visMap[child.id] !== false) changes[child.id] = false;
        }
      }
    }
  }
  for (const id of ids) {
    if (visMap[id] !== true) changes[id] = true;
  }
  return changes;
}


// ═══════════════════════════════════════════════════════════════════════════
//  SELECTION  (uses parallel select-act.js buffer)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Undoable selection change.
 * Records the PREVIOUS selection in select-act.js (circular buffer, max 5).
 * Pushes a lightweight "select-act#ID" slot into the main undo stack.
 * If the snapshot was evicted when undo fires, it silently skips (returns false).
 */
export function setSelection(primaryId, multiIds) {
  // P-P1: any selection change implicitly commits an open pivot edit.
  // The user clicked a tree row / right-clicked something / etc — same
  // semantics as clicking in the viewport. Skip if selecting the same
  // node that's being edited (no real change in focus).
  const editingId = state.get('pivotEditNodeId');
  if (editingId && editingId !== primaryId) commitPivotEdit();

  const prevId    = state.get('selectedId');
  const prevMulti = new Set(state.get('multiSelectedIds') ?? []);

  // Record where we're undoing TO (the previous state)
  const actId = selectionActs.record(prevId, prevMulti);

  // Apply new selection
  const multi = multiIds instanceof Set ? multiIds : new Set(multiIds ?? (primaryId ? [primaryId] : []));
  state.setSelection(primaryId, multi);
  materials.applySelectionHighlight(multi);

  undoManager.push(
    `select-act#${actId}`,
    () => {
      const snap = selectionActs.get(actId);
      if (!snap) return false;   // evicted — signal undo.js to skip redo push
      state.setSelection(snap.selectedId, snap.multiIds);
      materials.applySelectionHighlight(snap.multiIds);
    },
    () => {
      state.setSelection(primaryId, multi);
      materials.applySelectionHighlight(multi);
    },
  );
}

export function clearSelection() {
  setSelection(null, new Set());
}


// ═══════════════════════════════════════════════════════════════════════════
//  TRANSFORM ACTIONS  (gizmo drag batching — same pattern as preset sliders)
// ═══════════════════════════════════════════════════════════════════════════

let _transformBatch = null;

/**
 * Call on gizmo pointerdown.
 * Snapshots the current transform as the "from" state.
 */
export function beginTransformEdit(nodeId) {
  if (_transformBatch?.nodeId === nodeId) return;
  // Archived nodes are READ-ONLY — refuse to enter the gizmo batch.
  // The gizmo itself is suppressed in main.js when archived, but this
  // is the defence-in-depth path in case something else calls in.
  if (_isArchived(nodeId)) return;
  const nodeById = state.get('nodeById');
  const node = nodeById?.get(nodeId);
  if (!node) return;
  _transformBatch = { nodeId, from: captureTransformSnapshot(node) };
}

/**
 * Call on gizmo pointerup.
 * Compares current transform to "from" and pushes one undo entry.
 */
export function commitTransformEdit(nodeId) {
  if (!_transformBatch || _transformBatch.nodeId !== nodeId) return;
  const { from } = _transformBatch;
  _transformBatch = null;
  const nodeById = state.get('nodeById');
  const node = nodeById?.get(nodeId);
  if (!node) return;
  const to = captureTransformSnapshot(node);
  if (JSON.stringify(from) === JSON.stringify(to)) return;
  const obj3d = steps.object3dById?.get(nodeId);
  undoManager.push(
    'Transform',
    () => {
      const nb = state.get('nodeById');
      const n  = nb?.get(nodeId);
      if (!n) return;
      applyTransformSnapshot(n, from);
      const o = steps.object3dById?.get(nodeId);
      if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
    () => {
      const nb = state.get('nodeById');
      const n  = nb?.get(nodeId);
      if (!n) return;
      applyTransformSnapshot(n, to);
      const o = steps.object3dById?.get(nodeId);
      if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
  );
  steps.scheduleTransformSync();
}

/**
 * Walk the tree and report any folder/model nodes whose baseLocal* fields
 * are non-identity. flatShape is INTENTIONALLY skipped — its baseLocal*
 * stores the placement world-pose (set at insertion time), so non-identity
 * is expected there.
 *
 * Non-identity baseLocal* on a folder/model usually means one of:
 *   - Global Transform mode was used intentionally (legitimate)
 *   - A stale paste poisoned the home anchor (bug — the "object stuck out
 *     of home" failure mode the user hit before this verifier shipped)
 *
 * The verifier doesn't auto-repair — auto-clearing would destroy legitimate
 * Global Transform work. It just logs + returns a list. Call from console
 * via `window.sbsDiag?.verifyHome()` for an ad-hoc audit. Also runs
 * automatically after project load and after paste (results only logged
 * to console, no toast — keeps the UI quiet unless the user investigates).
 *
 * Returns: `[{ id, name, type, baseLocalPosition, baseLocalQuaternion }, …]`
 */
export function verifyHomePositions() {
  const root = state.get('treeData');
  if (!root) return [];

  const _isIdentity3 = v =>
    !Array.isArray(v) || (Math.abs(v[0] ?? 0) + Math.abs(v[1] ?? 0) + Math.abs(v[2] ?? 0) < 1e-6);
  const _isIdentityQ = v =>
    !Array.isArray(v) || (
      Math.abs(v[0] ?? 0) + Math.abs(v[1] ?? 0) + Math.abs(v[2] ?? 0) < 1e-6
      && Math.abs((v[3] ?? 1) - 1) < 1e-6
    );

  const drift = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'folder' || n.type === 'model') {
      const p = n.baseLocalPosition;
      const q = n.baseLocalQuaternion;
      if (!_isIdentity3(p) || !_isIdentityQ(q)) {
        drift.push({
          id: n.id,
          name: n.name || '(unnamed)',
          type: n.type,
          baseLocalPosition:   [...(p || [0,0,0])],
          baseLocalQuaternion: [...(q || [0,0,0,1])],
        });
      }
    }
    if (n.children) for (const c of n.children) stack.push(c);
  }

  if (drift.length === 0) {
    console.log('[home-verifier] OK — every folder/model has an identity home anchor.');
  } else {
    console.warn(`[home-verifier] ${drift.length} folder/model node(s) with non-identity baseLocal*. ` +
                 'If you used Global Transform mode this is expected. If not — paste/copy may have ' +
                 'drifted home anchors. Recovery: select the node + run actions.resetTransformDeep(<id>) ' +
                 'or use the tree right-click "Deep reset transform" menu (when added). Details:', drift);
  }
  return drift;
}

/**
 * Cable-binding health audit. Walks every cable's anchored nodes and
 * reports any that can't reach a live mesh via either the data-tree
 * `nodeById` (looking at `node.object3d`) OR `steps.object3dById`.
 * Those are the cables stuck on `cachedWorldPos` — the "anchored
 * visually but won't follow the object" bug.
 *
 * Also reports orphan entries in `object3dById` (nodeIds that aren't in
 * nodeById) — the data-tree alteration scenario where the two maps
 * desync.
 *
 * Usage: `window.sbsDiag.cablesAudit()` — returns a report object,
 * logs a summary to console.
 */
export function cablesAudit() {
  const nodeById     = state.get('nodeById') || new Map();
  const object3dById = steps.object3dById || new Map();
  const cables       = state.get('cables') || [];

  const orphanCableAnchors = [];
  for (const c of cables) {
    for (const n of (c.nodes || [])) {
      if (n.anchorType !== 'mesh' || !n.nodeId) continue;
      const sceneNode = nodeById.get(n.nodeId);
      const viaNodeBy   = !!sceneNode?.object3d;
      const viaObjBy    = !!object3dById.get?.(n.nodeId);
      if (!viaNodeBy && !viaObjBy) {
        orphanCableAnchors.push({
          cableId:   c.id,
          cableName: c.name || '(unnamed)',
          nodeId:    n.id,
          anchorNodeId: n.nodeId,
          cachedWorldPos: n.cachedWorldPos,
        });
      }
    }
  }

  // Map-desync: object3d on nodeById's node doesn't match object3dById's entry
  const desyncedNodes = [];
  for (const [id, node] of nodeById) {
    if (!node?.object3d) continue;
    const o = object3dById.get?.(id);
    if (o && o !== node.object3d) {
      desyncedNodes.push({ id, name: node.name || '(unnamed)', type: node.type });
    }
  }

  // Orphan entries in object3dById that don't exist in nodeById
  const orphanObj3dEntries = [];
  for (const [id] of object3dById) {
    if (id === 'scene_root') continue;
    if (!nodeById.has(id)) {
      orphanObj3dEntries.push(id);
    }
  }

  const report = {
    orphanCableAnchors,
    desyncedNodes,
    orphanObj3dEntries,
    summary: {
      orphanCables: orphanCableAnchors.length,
      desyncedNodes: desyncedNodes.length,
      orphanObj3dEntries: orphanObj3dEntries.length,
    },
  };

  if (orphanCableAnchors.length === 0 && desyncedNodes.length === 0 && orphanObj3dEntries.length === 0) {
    console.log('[cables-audit] OK — every cable anchor resolves cleanly.');
  } else {
    console.warn('[cables-audit] Issues detected:', report);
  }
  return report;
}

/**
 * Visibility-state audit + repair.
 *
 * Symptom this catches: a mesh has `obj.visible === true` AND its
 * effective tree visibility says "should be visible", but its
 * material.opacity is pinned at 0 — usually because
 * `_pendingShowingHidden` retains a stale entry from a cancelled /
 * never-completed visibility phase. The user sees the object vanish
 * from the viewport while its outline still renders.
 *
 * Returns the list of stuck nodeIds. If you pass `{ repair: true }`
 * the function also resets material.opacity (and back-pass) to 1.0
 * and drains the pending set for those nodes.
 *
 * Usage:
 *   window.sbsDiag.visibilityAudit()              // report-only
 *   window.sbsDiag.visibilityAudit({ repair:true })// fix in place
 */
export function visibilityAudit(opts = {}) {
  const repair = !!opts.repair;
  if (!materials) return { stuck: [] };
  const pending = materials._pendingShowingHidden;
  const stuck = [];
  if (pending && pending.size) {
    const outlineSettings = state.get('geometryOutline');
    for (const nodeId of [...pending]) {
      const obj = steps.object3dById?.get(nodeId);
      if (obj && obj.visible !== false) {
        stuck.push({ nodeId, name: state.get('nodeById')?.get(nodeId)?.name || '(unknown)' });
        if (repair) {
          try { materials._setNodeTransitionOpacity(nodeId, 1.0, outlineSettings, 0); } catch {}
          pending.delete(nodeId);
        }
      }
    }
  }

  if (stuck.length === 0) {
    console.log('[visibility-audit] OK — no stuck-hidden meshes detected.');
  } else if (repair) {
    console.log(`[visibility-audit] Repaired ${stuck.length} stuck mesh(es):`, stuck);
  } else {
    console.warn(`[visibility-audit] ${stuck.length} stuck mesh(es). Run window.sbsDiag.visibilityAudit({ repair: true }) to fix:`, stuck);
  }
  return { stuck, repaired: repair ? stuck.length : 0 };
}

/**
 * Unstick the renderer's text-input pathway.
 *
 * The "voice-over / name inputs go unresponsive" symptom usually comes
 * from one of these:
 *   • A <dialog> was closed but not removed from the DOM. document
 *     .activeElement may still point inside it.
 *   • A capture-phase keydown listener leaked from a panel that was
 *     hidden without its _cleanup running.
 *   • A drag operation didn't fire dragend (e.g. dropped outside the
 *     viewport) and the dragged element retains opacity:0.4.
 *   • body / html got pointer-events:none from a half-finished animation
 *     and never had it cleared.
 *
 * This function clears all of those defensively. Safe to call any time;
 * idempotent. Logs every action it took for diagnostic feedback.
 *
 * Usage: `window.sbsDiag.unstuckInputs()` — manual recovery.
 * Also runs automatically every few seconds as a janitor.
 */
export function unstuckInputs() {
  const actions = [];

  // 1. Remove every <dialog> that's NOT currently open. A closed-but-
  // still-attached dialog is "inert" per the HTML spec, but its presence
  // can interfere with focus restoration and lingering event listeners
  // that were registered on `dlg` directly.
  document.querySelectorAll('dialog').forEach(d => {
    if (!d.open) {
      try { d.remove(); actions.push(`removed-stale-dialog: ${d.className || d.tagName}`); }
      catch {}
    }
  });

  // 2. If the active element is inside an off-screen / display:none
  // subtree, blur it so the next click on a real input lands cleanly.
  const ae = document.activeElement;
  if (ae && ae !== document.body && ae !== document.documentElement) {
    // offsetParent === null means the element (or an ancestor) has
    // display:none. Exceptions: <body> and fixed-positioned elements.
    if (ae.offsetParent === null && getComputedStyle(ae).position !== 'fixed') {
      try { ae.blur(); actions.push(`blurred-hidden-focus: ${ae.tagName}`); } catch {}
    }
  }

  // 3. Reset pointer-events:none on body / html if something forgot to.
  for (const root of [document.body, document.documentElement]) {
    if (root.style.pointerEvents === 'none') {
      root.style.pointerEvents = '';
      actions.push(`cleared-pointer-events: ${root.tagName}`);
    }
  }

  // 4. Reset opacity:0.4 on draggable elements (our drag-source style)
  // — if the user dragged a chip and dropped outside any drop zone,
  // dragend should have fired but Electron's drag implementation
  // sometimes misses it on the renderer side.
  document.querySelectorAll('[draggable="true"]').forEach(el => {
    if (el.style.opacity === '0.4' || el.style.opacity === '0.5') {
      el.style.opacity = '';
      actions.push(`reset-drag-opacity: ${el.className || el.tagName}`);
    }
  });

  if (actions.length === 0) {
    console.log('[unstuck-inputs] OK — nothing obviously blocking.');
  } else {
    console.log('[unstuck-inputs] Cleared:', actions);
  }
  return actions;
}

/**
 * Quiet background janitor. Removes closed-but-still-attached <dialog>
 * elements every few seconds. Pure DOM hygiene — never logs, never
 * touches anything that's actually in use (only acts on dialogs whose
 * .open property is false, i.e. already programmatically closed).
 *
 * Called once at module load from the IIFE below.
 */
function _startInputUnstickJanitor() {
  if (typeof window === 'undefined') return;
  if (window.__sbsInputJanitor) return;        // idempotent
  window.__sbsInputJanitor = setInterval(() => {
    document.querySelectorAll('dialog').forEach(d => {
      if (!d.open) {
        try { d.remove(); } catch {}
      }
    });
  }, 5000);
}

// Expose for ad-hoc console use during QA.
try {
  if (typeof window !== 'undefined') {
    window.sbsDiag = window.sbsDiag || {};
    window.sbsDiag.verifyHome       = verifyHomePositions;
    window.sbsDiag.resetDeep        = (id) => resetTransformDeep(id);
    window.sbsDiag.cablesAudit      = cablesAudit;
    window.sbsDiag.visibilityAudit  = visibilityAudit;
    window.sbsDiag.visibilityRepair = () => visibilityAudit({ repair: true });
    window.sbsDiag.unstuckInputs    = unstuckInputs;
    window.sbsDiag.rmHealth         = rmHealth;
    // Animation trace flag. Set true in console → logs every animation
    // entry point with timestamps. Used to diagnose the "OBJ stutter
    // — start, rewind after 50ms, restart" report. Off by default.
    window.sbsDiag.animTrace        = false;
    _startInputUnstickJanitor();
  }
} catch {}

/**
 * RM health check — counts RMs / copies / orphan registrations.
 *
 *   sbsDiag.rmHealth()              // report only
 *   sbsDiag.rmHealth({ clean:true}) // report + sweep orphans
 *
 * Orphans = ids registered in object3dById / materials.meshById /
 * meshColorAssignments / meshDefaultColors that aren't in nodeById.
 * These come from import paths that registered intermediate groups
 * BEFORE bake-and-flatten dropped them from the data tree (fixed in
 * V0.1.73's bakeAndFlattenImport Phase 5 — but pre-fix imports leave
 * residue that survives until you sweep it).
 */
export function rmHealth(opts = {}) {
  const nb        = state.get('nodeById');
  const validIds  = new Set(nb ? nb.keys() : []);
  const matIds    = materials.meshById ? [...materials.meshById.keys()]    : [];
  const objIds    = steps.object3dById  ? [...steps.object3dById.keys()]   : [];
  const colorIds  = Object.keys(materials.meshColorAssignments || {});
  const defIds    = Object.keys(materials.meshDefaultColors    || {});

  let rms = 0, copies = 0;
  for (const node of (nb?.values() || [])) {
    if (node.type === 'replaceModel') rms++;
    if (node.sourceNodeId)            copies++;
  }
  const orphanMat   = matIds   .filter(id => !validIds.has(id));
  const orphanObj   = objIds   .filter(id => !validIds.has(id));
  const orphanColor = colorIds .filter(id => !validIds.has(id));
  const orphanDef   = defIds   .filter(id => !validIds.has(id));

  const report = {
    nodes:                    validIds.size,
    RMs:                      rms,
    copies,
    materialsRegistered:      matIds.length,
    object3dRegistered:       objIds.length,
    colorAssignments:         colorIds.length,
    defaultColors:            defIds.length,
    orphanMaterials:          orphanMat.length,
    orphanObject3d:           orphanObj.length,
    orphanColorAssignments:   orphanColor.length,
    orphanDefaultColors:      orphanDef.length,
  };
  const totalOrphans = orphanMat.length + orphanObj.length + orphanColor.length + orphanDef.length;

  if (opts.clean && totalOrphans) {
    // Sweep every orphan id from every registry. Safe because they
    // refer to data nodes that no longer exist — no live consumer
    // would look them up.
    for (const id of orphanMat)   materials.meshById?.delete(id);
    for (const id of orphanObj)   steps.object3dById?.delete(id);
    for (const id of orphanColor) delete materials.meshColorAssignments[id];
    for (const id of orphanDef)   delete materials.meshDefaultColors[id];
    console.log(`[RM health] cleaned ${totalOrphans} orphan entries.`);
    return rmHealth();   // re-run to verify clean
  }

  if (totalOrphans > 0) {
    console.warn('[RM health] orphan IDs detected:', report);
    if (orphanMat.length)   console.warn('  orphan materials:',           orphanMat);
    if (orphanObj.length)   console.warn('  orphan object3d:',            orphanObj);
    if (orphanColor.length) console.warn('  orphan color assignments:',   orphanColor);
    if (orphanDef.length)   console.warn('  orphan default colors:',      orphanDef);
    console.warn('  → run `sbsDiag.rmHealth({ clean: true })` to sweep.');
  } else {
    console.log('[RM health] clean.', report);
  }
  return report;
}

/**
 * Deep reset — zeros BOTH the per-step delta (localOffset / localQuaternion)
 * AND the project-global home anchor (baseLocalPosition / baseLocalQuaternion /
 * baseLocalScale). Use this as a recovery hatch when a node is "stuck out of
 * home" and a regular Reset doesn't help — meaning the home anchor itself
 * has drifted (typically via Global Transform mode or a stale paste).
 *
 * Side effects:
 *   - For folders / models: returns to true identity. Usually what you want
 *     when home is corrupted.
 *   - For flatShape: baseLocalPosition IS the placement (the world spot the
 *     plane was dropped onto). This will move the shape to world origin. The
 *     caller is responsible for confirming with the user before invoking on
 *     a flatShape.
 *
 * Undoable.
 */
export function resetTransformDeep(nodeId) {
  if (_isArchived(nodeId)) return;
  const nodeById = state.get('nodeById');
  const node = nodeById?.get(nodeId);
  if (!node) return;

  const fromDelta = captureTransformSnapshot(node);
  const fromBase  = {
    baseLocalPosition:   [...(node.baseLocalPosition   || [0, 0, 0])],
    baseLocalQuaternion: [...(node.baseLocalQuaternion || [0, 0, 0, 1])],
    baseLocalScale:      [...(node.baseLocalScale      || [1, 1, 1])],
  };

  const apply = () => {
    const n = state.get('nodeById')?.get(nodeId);
    if (!n) return;
    applyTransformSnapshot(n, {
      localOffset: [0, 0, 0], localQuaternion: [0, 0, 0, 1],
      moveEnabled: true, rotateEnabled: true,
    });
    n.baseLocalPosition   = [0, 0, 0];
    n.baseLocalQuaternion = [0, 0, 0, 1];
    n.baseLocalScale      = [1, 1, 1];
    const o = steps.object3dById?.get(nodeId);
    if (o) applyNodeTransformToObject3D(n, o);
    steps.scheduleTransformSync();
  };
  apply();

  undoManager.push(
    'Deep reset transform',
    () => {
      const n = state.get('nodeById')?.get(nodeId);
      if (!n) return;
      applyTransformSnapshot(n, fromDelta);
      n.baseLocalPosition   = [...fromBase.baseLocalPosition];
      n.baseLocalQuaternion = [...fromBase.baseLocalQuaternion];
      n.baseLocalScale      = [...fromBase.baseLocalScale];
      const o = steps.object3dById?.get(nodeId);
      if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
    apply,
  );
}

/**
 * Reset a node's transform to identity (undoable).
 */
export function resetTransform(nodeId) {
  if (_isArchived(nodeId)) return;
  const nodeById = state.get('nodeById');
  const node = nodeById?.get(nodeId);
  if (!node) return;
  const from = captureTransformSnapshot(node);
  applyTransformSnapshot(node, { localOffset: [0,0,0], localQuaternion: [0,0,0,1], moveEnabled: true, rotateEnabled: true });
  const obj3d = steps.object3dById?.get(nodeId);
  if (obj3d) applyNodeTransformToObject3D(node, obj3d);
  steps.scheduleTransformSync();
  undoManager.push(
    'Reset transform',
    () => {
      const nb = state.get('nodeById');
      const n  = nb?.get(nodeId);
      if (!n) return;
      applyTransformSnapshot(n, from);
      const o = steps.object3dById?.get(nodeId);
      if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
    () => {
      const nb = state.get('nodeById');
      const n  = nb?.get(nodeId);
      if (!n) return;
      applyTransformSnapshot(n, { localOffset: [0,0,0], localQuaternion: [0,0,0,1], moveEnabled: true, rotateEnabled: true });
      const o = steps.object3dById?.get(nodeId);
      if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
  );
}


/**
 * Toggle a transform enabled flag blue ↔ red.
 * No-op if the node has no delta for that axis (grey state — nothing to toggle).
 * @param {string} nodeId
 * @param {'moveEnabled'|'rotateEnabled'|'pivotEnabled'} flag
 */
export function toggleTransformEnabled(nodeId, flag) {
  if (_isArchived(nodeId)) return;
  const nodeById = state.get('nodeById');
  const node     = nodeById?.get(nodeId);
  if (!node) return;
  const from   = captureTransformSnapshot(node);
  const newVal = !(node[flag] !== false);
  node[flag]   = newVal;
  const obj3d  = steps.object3dById?.get(nodeId);
  if (obj3d) applyNodeTransformToObject3D(node, obj3d);
  steps.scheduleTransformSync();
  undoManager.push(
    `Toggle ${flag}`,
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      applyTransformSnapshot(n, from);
      const o = steps.object3dById?.get(nodeId); if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      n[flag] = newVal;
      const o = steps.object3dById?.get(nodeId); if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
  );
}

/**
 * Reset move, rotation, or both to identity (grey state).
 * @param {string} nodeId
 * @param {'move'|'rotate'|'all'} field
 */
export function resetTransformField(nodeId, field) {
  if (_isArchived(nodeId)) return;
  const nodeById = state.get('nodeById');
  const node     = nodeById?.get(nodeId);
  if (!node) return;
  const from = captureTransformSnapshot(node);

  if (field === 'move' || field === 'all') {
    node.localOffset = [0, 0, 0];
    node.moveEnabled = true;
  }
  if (field === 'rotate' || field === 'all') {
    node.localQuaternion  = [0, 0, 0, 1];
    node.orientationSteps = [0, 0, 0];
    node.rotateEnabled    = true;
  }

  const obj3d = steps.object3dById?.get(nodeId);
  if (obj3d) applyNodeTransformToObject3D(node, obj3d);
  steps.scheduleTransformSync();

  const label = field === 'all' ? 'Reset all transforms' : `Reset ${field}`;
  undoManager.push(
    label,
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      applyTransformSnapshot(n, from);
      const o = steps.object3dById?.get(nodeId); if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      if (field === 'move' || field === 'all') { n.localOffset = [0,0,0]; n.moveEnabled = true; }
      if (field === 'rotate' || field === 'all') { n.localQuaternion = [0,0,0,1]; n.orientationSteps = [0,0,0]; n.rotateEnabled = true; }
      const o = steps.object3dById?.get(nodeId); if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
  );
}


// ═══════════════════════════════════════════════════════════════════════════
//  PIVOT ACTIONS  (3-state: GREY ↔ RED ↔ BLUE — see ui/tree.js + ui/gizmo.js)
// ═══════════════════════════════════════════════════════════════════════════
//
// State machine recap:
//   GREY  : pivotEnabled=false. Gizmo at object origin. Default.
//   RED   : pivotEnabled=true AND state.pivotEditNodeId === node.id.
//           Orange dot at gizmo hub. Drag MOVES the pivot data
//           (pivotLocalOffset / pivotLocalQuaternion) — geometry
//           untouched. Commit on viewport pointerdown anywhere
//           outside a gizmo handle.
//   BLUE  : pivotEnabled=true AND not editing. Gizmo at pivot pose.
//           Drag rotation routes through setNodeLocalRotationPreservePivot
//           so the pivot world point stays fixed.
//
// Transitions:
//   GREY click  → enterPivotEdit (RED)
//   RED  commit → commitPivotEdit (BLUE) [from viewport pointerdown]
//   RED  click  → cancelPivotEdit (GREY or BLUE depending on seed)
//   BLUE click  → setPivotEnabled(false) (GREY, data preserved)
//   GREY click again → enterPivotEdit re-using stored data (RED)
//
// Undo: the whole RED → BLUE editing session is ONE entry "Edit pivot"
// captured via the standard {begin, capture, commit} pattern used by
// transform / preset edits. Cancel discards the entry.

let _pivotBatch = null;

/**
 * GREY → RED. Enable pivot, mark this node as the editing target,
 * snapshot for undo. Idempotent — calling on an already-editing node
 * is a no-op.
 */
export function enterPivotEdit(nodeId) {
  if (!nodeId) return;
  if (_isArchived(nodeId)) return;
  if (state.get('pivotEditNodeId') === nodeId) return;
  // If a different node was being edited, commit that one first so
  // we never have two open edit sessions.
  if (state.get('pivotEditNodeId')) commitPivotEdit();

  const nodeById = state.get('nodeById');
  const node = nodeById?.get(nodeId);
  if (!node) return;

  _pivotBatch = { nodeId, from: captureTransformSnapshot(node) };
  node.pivotEnabled = true;
  state.setState({ pivotEditNodeId: nodeId });
  steps.scheduleTransformSync();
}

/**
 * RED → BLUE. Close the edit session, push ONE undo entry covering
 * the whole pivot adjustment. Called from main.js on viewport
 * pointerdown anywhere outside the gizmo handles.
 */
export function commitPivotEdit() {
  if (!_pivotBatch) return;
  // Per-drag undo entries are pushed by commitPivotDrag (called from
  // gizmo.onPointerUp), so by the time we reach here every change the
  // user made is already in the undo log. This call only exits the
  // RED edit mode; it doesn't push its own entry. (Pushing one here
  // too would double-count: undo would walk back through the per-drag
  // entries one by one, then through this combined entry — confusing.)
  _pivotBatch = null;
  state.setState({ pivotEditNodeId: null });
  steps.scheduleTransformSync();
}

/**
 * Per-DRAG commit while in pivot edit mode. Called from gizmo
 * onPointerUp at the end of every translate / plane / rotate drag
 * inside RED edit mode. Pushes a single undo entry covering THIS
 * drag's pivot offset + quaternion change. Does NOT exit edit mode —
 * the user can keep dragging the gizmo and each drag becomes its own
 * undoable step.
 *
 * `before` is the snapshot the gizmo captured at pointerdown
 *   { offset: number[3], quat: number[4] }.
 */
export function commitPivotDrag(nodeId, before) {
  if (!nodeId || !before) return;
  const node = state.get('nodeById')?.get(nodeId);
  if (!node) return;
  const after = {
    offset: [...(node.pivotLocalOffset      || [0, 0, 0])],
    quat:   [...(node.pivotLocalQuaternion  || [0, 0, 0, 1])],
  };
  // Skip no-op drags.
  const same = (a, b, eps = 1e-7) => a.length === b.length
    && a.every((v, i) => Math.abs(v - b[i]) < eps);
  if (same(before.offset, after.offset) && same(before.quat, after.quat)) return;

  undoManager.push('Edit pivot',
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      n.pivotLocalOffset     = [...before.offset];
      n.pivotLocalQuaternion = [...before.quat];
      n.pivotEnabled = true;
      const o = steps.object3dById?.get(nodeId);
      if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      n.pivotLocalOffset     = [...after.offset];
      n.pivotLocalQuaternion = [...after.quat];
      n.pivotEnabled = true;
      const o = steps.object3dById?.get(nodeId);
      if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
  );
}

/**
 * RED → GREY/BLUE. Roll back to the snapshot captured at
 * enterPivotEdit, clear the edit flag. The visual landing state
 * depends on the seed: if pivotEnabled was true at enter time
 * (re-entering an existing pivot), the node lands BLUE again; if
 * false (first-time enter from GREY), it lands GREY.
 */
export function cancelPivotEdit() {
  if (!_pivotBatch) return;
  const { nodeId, from } = _pivotBatch;
  _pivotBatch = null;
  state.setState({ pivotEditNodeId: null });

  const node = state.get('nodeById')?.get(nodeId);
  if (!node) return;
  applyTransformSnapshot(node, from);
  const obj3d = steps.object3dById?.get(nodeId);
  if (obj3d) applyNodeTransformToObject3D(node, obj3d);
  steps.scheduleTransformSync();
}

/**
 * BLUE → GREY (when on=false) or GREY → BLUE (when on=true, with
 * stored pivot data). Toggles pivotEnabled with an undo entry.
 * Pivot data is preserved either direction.
 */
export function setPivotEnabled(nodeId, on) {
  const node = state.get('nodeById')?.get(nodeId);
  if (!node) return;
  const prev = node.pivotEnabled !== false;
  const next = !!on;
  if (prev === next) return;
  node.pivotEnabled = next;
  const obj3d = steps.object3dById?.get(nodeId);
  if (obj3d) applyNodeTransformToObject3D(node, obj3d);
  steps.scheduleTransformSync();
  undoManager.push(
    next ? 'Enable pivot' : 'Disable pivot',
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      n.pivotEnabled = prev;
      const o = steps.object3dById?.get(nodeId); if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      n.pivotEnabled = next;
      const o = steps.object3dById?.get(nodeId); if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
  );
}

/** Whether a pivot edit session is currently open. */
export function isPivotEditing() { return _pivotBatch !== null; }


// ═══════════════════════════════════════════════════════════════════════════
//  GLOBAL-TRANSFORM EDIT  (Phase 2 / 2.1 — flat shapes only)
// ═══════════════════════════════════════════════════════════════════════════
//
// State machine — same shape as pivot-edit (enter / per-drag commit /
// cancel / exit on viewport pointerdown):
//
//   OFF → enterGlobalEdit                      → RED  (state.globalEditNodeId)
//   RED → translate / plane gizmo drag         → writes baseLocalPosition
//   RED → rotate ring drag                     → writes baseLocalQuaternion
//   RED → scale handle drag                    → writes baseLocalScale
//   RED → drag end                             → commitGlobal{T|R|S}Drag
//                                                 pushes ONE undo entry
//   RED → click outside gizmo                  → commitGlobalEdit (exit)
//   RED → Esc                                  → cancelGlobalEdit
//
// Per-drag undo entries target base* fields, which are project-global
// (not in step.snapshot.transforms). So the changes ripple to every
// step uniformly — that's the whole point of the mode.

let _globalBatch = null;

/**
 * Enter global-transform mode for the given flatShape node. Idempotent.
 * If a different node was being edited, commits that one first so we
 * never have two open sessions.
 */
export function enterGlobalEdit(nodeId) {
  if (!nodeId) return;
  if (_isArchived(nodeId)) return;
  if (state.get('globalEditNodeId') === nodeId) return;
  if (state.get('globalEditNodeId')) commitGlobalEdit();
  // A pivot edit and a global edit can't both own the gizmo;
  // committing pivot first leaves the user with the cleaner state.
  if (state.get('pivotEditNodeId')) commitPivotEdit();

  const node = state.get('nodeById')?.get(nodeId);
  if (!node || node.type !== 'flatShape') return;

  _globalBatch = {
    nodeId,
    fromPos:   [...(node.baseLocalPosition   || [0, 0, 0])],
    fromQuat:  [...(node.baseLocalQuaternion || [0, 0, 0, 1])],
    fromScale: [...(node.baseLocalScale      || [1, 1, 1])],
  };
  state.setState({ globalEditNodeId: nodeId });
}

/** Per-drag undo for translate/plane. `before` = [x,y,z] baseLocalPosition snapshot. */
export function commitGlobalTranslateDrag(nodeId, before) {
  _commitGlobalBaseDrag(nodeId, 'baseLocalPosition', before, [0, 0, 0], 'Translate global');
}

/** Per-drag undo for rotate. `before` = [x,y,z,w] baseLocalQuaternion snapshot. */
export function commitGlobalRotateDrag(nodeId, before) {
  _commitGlobalBaseDrag(nodeId, 'baseLocalQuaternion', before, [0, 0, 0, 1], 'Rotate global');
}

/** Per-drag undo for scale. `before` = [x,y,z] baseLocalScale snapshot. */
export function commitGlobalScaleDrag(nodeId, before) {
  _commitGlobalBaseDrag(nodeId, 'baseLocalScale', before, [1, 1, 1], 'Scale global');
}

/**
 * Exit global mode. Per-drag entries are already in the undo log; this
 * call only clears the flag (no extra undo entry). Called from main.js
 * on viewport pointerdown outside gizmo handles.
 */
export function commitGlobalEdit() {
  if (!_globalBatch) return;
  _globalBatch = null;
  state.setState({ globalEditNodeId: null });
}

/**
 * Esc handler. Rolls back ALL THREE base fields to the snapshots taken
 * at enter and clears the flag. Per-drag entries already pushed stay
 * in the undo log (user can Ctrl-Z them individually).
 */
export function cancelGlobalEdit() {
  if (!_globalBatch) return;
  const { nodeId, fromPos, fromQuat, fromScale } = _globalBatch;
  _globalBatch = null;
  state.setState({ globalEditNodeId: null });

  const node = state.get('nodeById')?.get(nodeId);
  if (!node) return;
  node.baseLocalPosition   = [...fromPos];
  node.baseLocalQuaternion = [...fromQuat];
  node.baseLocalScale      = [...fromScale];
  const obj3d = steps.object3dById?.get(nodeId);
  if (obj3d) applyNodeTransformToObject3D(node, obj3d);
  state.emit('change:treeData', state.get('treeData'));
}

/** Whether a global-edit session is currently open. */
export function isGlobalEditing() { return _globalBatch !== null; }

// Generic per-drag commit helper — same shape for translate / rotate / scale.
function _commitGlobalBaseDrag(nodeId, field, before, identity, label) {
  if (!nodeId || !before) return;
  const node = state.get('nodeById')?.get(nodeId);
  if (!node) return;
  const after = [...(node[field] || identity)];
  const same = (a, b, eps = 1e-7) => a.length === b.length
    && a.every((v, i) => Math.abs(v - b[i]) < eps);
  if (same(before, after)) return;

  undoManager.push(label,
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      n[field] = [...before];
      const o = steps.object3dById?.get(nodeId);
      if (o) applyNodeTransformToObject3D(n, o);
      state.emit('change:treeData', state.get('treeData'));
    },
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      n[field] = [...after];
      const o = steps.object3dById?.get(nodeId);
      if (o) applyNodeTransformToObject3D(n, o);
      state.emit('change:treeData', state.get('treeData'));
    },
  );
  state.markDirty();
}

// Per-step scale uses the regular begin/commitTransformEdit pair —
// captureTransformSnapshot now includes localScale (Phase 2.1), so
// scale handle drags fall through the normal undo path.


// ─── Pivot clipboard (copy / paste — only the "blue" / committed pivot) ───

let _pivotClipboard = null;

/** True when the clipboard holds a copied pivot ready for paste. */
export function hasPivotClipboard() { return _pivotClipboard !== null; }

/**
 * Copy the active pivot from a folder. Captures pivotLocalOffset +
 * pivotLocalQuaternion only — and only if the source actually has a
 * relocated pivot (BLUE state). Grey/red sources are ignored.
 *
 * Typical use: identical-folder-across-steps. Set pivot on Step 5,
 * navigate to Step 8, paste it on the same folder there. Per-step
 * snapshot already captures pivot, so the paste lands as a per-step
 * value.
 */
export function copyPivot(nodeId) {
  const node = state.get('nodeById')?.get(nodeId);
  if (!node || node.pivotEnabled !== true) return false;
  _pivotClipboard = {
    offset:     [...(node.pivotLocalOffset     ?? [0, 0, 0])],
    quaternion: [...(node.pivotLocalQuaternion ?? [0, 0, 0, 1])],
  };
  return true;
}

/**
 * Paste the clipboard pivot onto a folder. Enables pivot, sets offset
 * and quaternion, leaves all other transforms alone. Undoable as one
 * "Paste pivot" entry.
 */
export function pastePivot(nodeId) {
  if (!_pivotClipboard) return false;
  if (_isArchived(nodeId)) return false;
  const node = state.get('nodeById')?.get(nodeId);
  if (!node) return false;

  const from  = captureTransformSnapshot(node);
  node.pivotLocalOffset     = [..._pivotClipboard.offset];
  node.pivotLocalQuaternion = [..._pivotClipboard.quaternion];
  node.pivotEnabled         = true;
  const obj3d = steps.object3dById?.get(nodeId);
  if (obj3d) applyNodeTransformToObject3D(node, obj3d);
  steps.scheduleTransformSync();
  const to = captureTransformSnapshot(node);

  undoManager.push('Paste pivot',
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      applyTransformSnapshot(n, from);
      const o = steps.object3dById?.get(nodeId); if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      applyTransformSnapshot(n, to);
      const o = steps.object3dById?.get(nodeId); if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
  );
  return true;
}

// ─── Snap pivot to surface (raycast pick + position+orient) ────────────────
//
// startPivotSnapPicking puts the app into "next viewport click picks
// a face" mode — main.js intercepts pointerdown while
// state.pivotSnapPickingNodeId is set. snapPivotToHit does the math
// once a hit lands.

export function startPivotSnapPicking(nodeId) {
  if (!nodeId) return;
  // Close any open pivot edit session first — snap is a one-shot
  // commit and shouldn't co-exist with an in-progress drag edit.
  if (state.get('pivotEditNodeId')) commitPivotEdit();
  state.setState({ pivotSnapPickingNodeId: nodeId });
}

export function cancelPivotSnapPicking() {
  if (state.get('pivotSnapPickingNodeId')) {
    state.setState({ pivotSnapPickingNodeId: null });
  }
}

/**
 * Snap a node's pivot to a raycast hit's point + face normal:
 *   - pivotLocalOffset = hit point in object-local space.
 *   - pivotLocalQuaternion = orientation with Z aligned to the
 *     world-space face normal; tangent plane (X / Y) chosen so X is
 *     perpendicular to world up (or world right when normal is near
 *     vertical, to avoid degenerate cross product).
 *   - pivotEnabled = true (BLUE state).
 *
 * Undoable as one "Snap pivot to surface" entry. Clears
 * pivotSnapPickingNodeId on success.
 */
export function snapPivotToHit(nodeId, hit) {
  if (!hit || !hit.point || !hit.face || !hit.object) return false;
  const node = state.get('nodeById')?.get(nodeId);
  if (!node) return false;
  const obj3d = steps.object3dById?.get(nodeId);
  if (!obj3d) return false;

  const T = window.THREE;
  // Hit point → object-local for pivotLocalOffset.
  const localPos = obj3d.worldToLocal(hit.point.clone());

  // Face normal in WORLD space (transformDirection applies rotation only).
  const worldNormal = hit.face.normal.clone()
    .transformDirection(hit.object.matrixWorld)
    .normalize();

  // Build a world-space orthonormal basis: Z = normal, Y = world-up
  // projected onto tangent plane, X = Y × Z. Fall back to world-X if
  // the normal is too close to up.
  const z = worldNormal;
  let up = new T.Vector3(0, 1, 0);
  if (Math.abs(up.dot(z)) > 0.99) up = new T.Vector3(1, 0, 0);
  const x = new T.Vector3().crossVectors(up, z).normalize();
  const y = new T.Vector3().crossVectors(z, x).normalize();
  const m = new T.Matrix4().makeBasis(x, y, z);
  const worldQ = new T.Quaternion().setFromRotationMatrix(m);

  // pivotLocalQuaternion = obj.worldQ⁻¹ × worldQ.
  const objWorldQ = new T.Quaternion();
  obj3d.getWorldQuaternion(objWorldQ);
  const pivotLocalQ = objWorldQ.clone().invert().multiply(worldQ);

  const from = captureTransformSnapshot(node);
  node.pivotLocalOffset     = [localPos.x, localPos.y, localPos.z];
  node.pivotLocalQuaternion = [pivotLocalQ.x, pivotLocalQ.y, pivotLocalQ.z, pivotLocalQ.w];
  node.pivotEnabled         = true;
  applyNodeTransformToObject3D(node, obj3d);
  steps.scheduleTransformSync();
  const to = captureTransformSnapshot(node);

  state.setState({ pivotSnapPickingNodeId: null });

  undoManager.push('Snap pivot to surface',
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      applyTransformSnapshot(n, from);
      const o = steps.object3dById?.get(nodeId); if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      applyTransformSnapshot(n, to);
      const o = steps.object3dById?.get(nodeId); if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
  );
  return true;
}

// ─── 3-Point Center Pivot ─────────────────────────────────────────────────
//
// User picks 3 points on geometry; the unique circle through them gives
// a center (pivot position) and plane normal (pivot Z axis). Useful for
// dropping a pivot perfectly on a cylinder axis by clicking 3 rim
// vertices. Tool state + visuals live in pivot-center-picker.js — these
// actions are just the start / cancel / commit wrappers.

export function startPivotCenterPicking(nodeId) {
  if (!nodeId) return;
  if (state.get('pivotEditNodeId')) commitPivotEdit();
  // Avoid two pick modes overlapping.
  if (state.get('pivotSnapPickingNodeId')) cancelPivotSnapPicking();
  // Lazy import to avoid actions ↔ picker circular load.
  import('./pivot-center-picker.js').then(picker => picker.start(nodeId));
}

export function cancelPivotCenterPicking() {
  import('./pivot-center-picker.js').then(picker => picker.cancel());
}

/**
 * Compute the circle through three world points; write the result onto
 * the node's pivot fields (Z axis = plane normal, X = direction toward
 * the first point in the plane, Y = Z × X), and immediately enter pivot
 * edit mode so the user can fine-tune via the gizmo.
 *
 * Math: barycentric circumcenter — same helper as the picker preview,
 * so what the user sees in the preview is what gets committed. See
 * pivot-center-picker.js circumcenterAndNormal for the formula.
 *
 * Undoable as one "Pivot from 3 points" entry. Falls back silently if
 * the three points are collinear or coincident.
 */
export async function applyPivotCenter(nodeId, p1, p2, p3) {
  if (!nodeId || !p1 || !p2 || !p3) return false;
  const node = state.get('nodeById')?.get(nodeId);
  if (!node) return false;
  const obj3d = steps.object3dById?.get(nodeId);
  if (!obj3d) return false;
  if (!window.THREE) return false;

  const T = window.THREE;

  // Lazy import keeps the actions ↔ picker dep loop loose.
  const picker = await import('./pivot-center-picker.js');
  const result = picker.circumcenterAndNormal(p1, p2, p3);
  if (!result) return false;
  const worldCenter = result.center;
  const worldNormal = result.normal;

  // Build a world-space orthonormal basis: Z = normal, X = (p1 - center)
  // projected onto the plane (so axes align with the user's first pick),
  // Y = Z × X.
  const z = worldNormal;
  let x = new T.Vector3().subVectors(p1, worldCenter);
  x.sub(z.clone().multiplyScalar(x.dot(z)));
  if (x.lengthSq() < 1e-10) {
    // p1 effectively at center — pick any tangent.
    const fallback = Math.abs(z.y) > 0.99 ? new T.Vector3(1, 0, 0)
                                          : new T.Vector3(0, 1, 0);
    x.copy(fallback).sub(z.clone().multiplyScalar(z.dot(fallback)));
  }
  x.normalize();
  const y = new T.Vector3().crossVectors(z, x).normalize();
  const m = new T.Matrix4().makeBasis(x, y, z);
  const worldQ = new T.Quaternion().setFromRotationMatrix(m);

  // Convert world-space pose into the node's local frame.
  obj3d.updateMatrixWorld(true);
  const localCenter = obj3d.worldToLocal(worldCenter.clone());
  const objWorldQ = new T.Quaternion();
  obj3d.getWorldQuaternion(objWorldQ);
  const pivotLocalQ = objWorldQ.clone().invert().multiply(worldQ);

  const from = captureTransformSnapshot(node);
  node.pivotLocalOffset     = [localCenter.x, localCenter.y, localCenter.z];
  node.pivotLocalQuaternion = [pivotLocalQ.x, pivotLocalQ.y, pivotLocalQ.z, pivotLocalQ.w];
  node.pivotEnabled         = true;
  applyNodeTransformToObject3D(node, obj3d);
  steps.scheduleTransformSync();
  const to = captureTransformSnapshot(node);

  undoManager.push('Pivot from 3 points',
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      applyTransformSnapshot(n, from);
      const o = steps.object3dById?.get(nodeId); if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      applyTransformSnapshot(n, to);
      const o = steps.object3dById?.get(nodeId); if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
  );

  // Pivot is committed and BLUE (pivotEnabled + non-zero data). The
  // user can re-enter RED edit mode explicitly via the pivot icon if
  // they want to fine-tune via the gizmo — auto-entering edit mode
  // here would defeat the "show me the pivot is on the object" cue.
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════
//  CABLE ACTIONS  (C3)
// ═══════════════════════════════════════════════════════════════════════════
//
// Thin undoable wrappers around cables.js mutators. Each user action
// pushes ONE undo entry. The cable RENDER (cables-render.js) already
// listens to `change:cables` and rebuilds — these actions just need to
// drive state.setState through the cables.js helpers; no manual render
// kicks needed.

/** Add a fresh cable. Returns the new cable record. Undoable. */
export function createCable(name) {
  const cable = cables.addCable(name ? { name } : {});
  undoManager.push(`Add cable${name ? ` "${name}"` : ''}`,
    () => { cables.removeCable(cable.id); },
    () => {
      // Redo: re-create. cables.addCable assigns a new id, so we
      // splice the saved record back in directly to keep ids stable
      // (anchored points + branchSource refs survive).
      const list = (state.get('cables') || []).filter(c => c.id !== cable.id);
      state.setState({ cables: [...list, cable] });
      state.markDirty();
    },
  );
  return cable;
}

/** Delete a cable. Undoable — undo restores the full record. */
export function deleteCable(cableId) {
  const cable = cables.getCable(cableId);
  if (!cable) return false;
  const snapshot = JSON.parse(JSON.stringify(cable));   // deep-clone for restore
  cables.removeCable(cableId);
  undoManager.push(`Delete cable "${cable.name || ''}"`,
    () => {
      const list = (state.get('cables') || []).filter(c => c.id !== cableId);
      state.setState({ cables: [...list, snapshot] });
      state.markDirty();
    },
    () => { cables.removeCable(cableId); },
  );
  return true;
}

/** Toggle cable visibility. Undoable. */
export function toggleCableVisibility(cableId) {
  const cable = cables.getCable(cableId);
  if (!cable) return;
  const next = !cable.visible;
  cables.updateCable(cableId, { visible: next });
  // Cable visibility is part of the per-step snapshot — scheduleSync
  // pushes the change into the active step so navigating away and
  // back preserves it (and the next step keeps its own value).
  steps.scheduleSync();
  undoManager.push(next ? 'Show cable' : 'Hide cable',
    () => { cables.updateCable(cableId, { visible: !next }); steps.scheduleSync(); },
    () => { cables.updateCable(cableId, { visible: next  }); steps.scheduleSync(); },
  );
}

/** Toggle cable highlight. Undoable. Per-step. */
export function toggleCableHighlight(cableId) {
  const cable = cables.getCable(cableId);
  if (!cable) return;
  const next = !cable.highlight;
  cables.updateCable(cableId, { highlight: next });
  steps.scheduleSync();
  undoManager.push(next ? 'Highlight cable' : 'Unhighlight cable',
    () => { cables.updateCable(cableId, { highlight: !next }); steps.scheduleSync(); },
    () => { cables.updateCable(cableId, { highlight: next  }); steps.scheduleSync(); },
  );
}

/**
 * Toggle a cable between flexible (smooth spline) and straight. Structural /
 * per-cable (not a per-step variable), so it marks dirty rather than syncing
 * into the active step. The cable renderer's per-tick picks up the flag and
 * rebuilds the body (spline tube vs cylinders).
 */
export function setCableFlexible(cableId, on) {
  const cable = cables.getCable(cableId);
  if (!cable) return;
  const next = !!on;
  const prev = !!cable.flexible;
  if (next === prev) return;
  cables.updateCable(cableId, { flexible: next });
  state.markDirty();
  undoManager.push(next ? 'Make cable flexible' : 'Make cable straight',
    () => { cables.updateCable(cableId, { flexible: prev }); state.markDirty(); },
    () => { cables.updateCable(cableId, { flexible: next }); state.markDirty(); },
  );
}

/**
 * Patch a cable's name / style fields. NOT undoable per-keystroke —
 * caller is expected to debounce / commit on blur if precision is
 * needed (mirrors the style-template slider pattern). Lightweight
 * usage: type → blur → one updateCable + one undo entry.
 */
export function renameCable(cableId, name) {
  const cable = cables.getCable(cableId);
  if (!cable || cable.name === name) return;
  const prev = cable.name;
  cables.updateCable(cableId, { name });
  undoManager.push(`Rename cable to "${name}"`,
    () => cables.updateCable(cableId, { name: prev }),
    () => cables.updateCable(cableId, { name      }),
  );
}

/** Patch a cable's style. Undoable. When `size` % changes, slides
 *  any attached sockets' cable points along the forward axis so the
 *  socket back face stays put on the surface (same IK as the global
 *  radius adjuster — both feed into the cable's effective radius).
 */
export function setCableStyle(cableId, stylePatch) {
  const cable = cables.getCable(cableId);
  if (!cable || !stylePatch) return;
  const prev = { ...(cable.style || {}) };
  // Snapshot anchorLocal of all socketed nodes BEFORE the patch — we
  // need both the old + new effective radius to compute the slide.
  const beforeAnchors = new Map();
  if (stylePatch.size !== undefined) {
    for (const n of (cable.nodes || [])) {
      if (n.socket && n.anchorType === 'mesh' && Array.isArray(n.anchorLocal)) {
        beforeAnchors.set(n.id, n.anchorLocal.slice());
      }
    }
  }
  const r0 = cableEffectiveRadius(cable);

  cables.updateCableStyle(cableId, stylePatch);
  const next = { ...(cables.getCable(cableId)?.style || {}) };
  if (JSON.stringify(prev) === JSON.stringify(next)) return;

  // Apply the IK slide for sockets if size changed.
  if (stylePatch.size !== undefined) {
    const c2 = cables.getCable(cableId);
    const r1 = cableEffectiveRadius(c2);
    const ratio = r1 / (r0 || 1);
    if (Math.abs(r1 - r0) > 1e-6) {
      for (const n of (c2.nodes || [])) {
        if (!n.socket || n.anchorType !== 'mesh' || !Array.isArray(n.anchorLocal)) continue;
        const sizeDPct = (n.socket.size?.d ?? 100) / 100;
        const oldDepth = SOCKET_BASE_D * r0 * sizeDPct;
        const newDepth = SOCKET_BASE_D * r1 * sizeDPct;
        const delta = newDepth - oldDepth;
        const fwd = _socketForwardMeshLocal(n);
        n.anchorLocal = [
          n.anchorLocal[0] + delta * fwd.x,
          n.anchorLocal[1] + delta * fwd.y,
          n.anchorLocal[2] + delta * fwd.z,
        ];
      }
      state.setState({ cables: [...(state.get('cables') || [])] });
      state.markDirty();
    }
  }

  undoManager.push('Edit cable style',
    () => {
      cables.updateCableStyle(cableId, prev);
      // Restore pre-patch anchors so the slide is fully reversible.
      if (beforeAnchors.size) {
        const c = cables.getCable(cableId);
        if (c) {
          for (const n of (c.nodes || [])) {
            const before = beforeAnchors.get(n.id);
            if (before) n.anchorLocal = before.slice();
          }
          state.setState({ cables: [...(state.get('cables') || [])] });
        }
      }
    },
    () => {
      cables.updateCableStyle(cableId, next);
      // Re-apply the slide on redo.
      if (stylePatch.size !== undefined) {
        const c2 = cables.getCable(cableId);
        if (c2) {
          const r1redo = cableEffectiveRadius(c2);
          for (const n of (c2.nodes || [])) {
            if (!n.socket || n.anchorType !== 'mesh') continue;
            const before = beforeAnchors.get(n.id);
            if (!before) continue;
            const sizeDPct = (n.socket.size?.d ?? 100) / 100;
            const oldDepth = SOCKET_BASE_D * r0 * sizeDPct;
            const newDepth = SOCKET_BASE_D * r1redo * sizeDPct;
            const delta = newDepth - oldDepth;
            const fwd = _socketForwardMeshLocal(n);
            n.anchorLocal = [
              before[0] + delta * fwd.x,
              before[1] + delta * fwd.y,
              before[2] + delta * fwd.z,
            ];
          }
          state.setState({ cables: [...(state.get('cables') || [])] });
        }
      }
    },
  );
}

/**
 * Add a free-position point to the active cable at the given world
 * position. Returns the new node id, or null on failure.
 */
export function addCableFreePoint(cableId, worldPos) {
  if (!worldPos) return null;
  const node = cables.addCablePoint(cableId, {
    type:       'point',
    anchorType: 'free',
    position:        [worldPos.x, worldPos.y, worldPos.z],
    cachedWorldPos:  [worldPos.x, worldPos.y, worldPos.z],
  });
  if (!node) return null;
  undoManager.push('Add cable point',
    () => cables.removeCablePoint(cableId, node.id),
    () => {
      // Re-append (id preserved). Splice into nodes if missing.
      const cable = cables.getCable(cableId);
      if (!cable) return;
      if (cable.nodes?.find(n => n.id === node.id)) return;
      const list = (state.get('cables') || []).map(c =>
        c.id === cableId ? { ...c, nodes: [...(c.nodes || []), node] } : c,
      );
      state.setState({ cables: list });
      state.markDirty();
    },
  );
  return node.id;
}

/**
 * Add a mesh-anchored point at a raycast hit. The hit's point is
 * stored in object-local space (so the cable follows the mesh as it
 * animates), the face normal in object-local for default socket
 * orientation, and a cachedWorldPos seed for the 3-tier resolver's
 * fallback.
 */
export function addCableAnchoredPoint(cableId, hit) {
  if (!hit?.point || !hit?.object) return null;
  const T = window.THREE;
  // Find the tree node id from the hit object — search up the parent
  // chain until we find one with a registered id in nodeById's reverse
  // map. For now, use the hit object's userData if our system tagged it.
  const meshNodeId = _findTreeNodeIdForObject(hit.object);
  if (!meshNodeId) {
    // Fallback to free point at the hit world position.
    return addCableFreePoint(cableId, hit.point);
  }

  // Capture object-local position + normal from hit.
  const localPos = hit.object.worldToLocal(hit.point.clone());
  const localNormal = hit.face?.normal ? hit.face.normal.clone().normalize() : null;

  // Direction-aware add: prepend if the user is "Continue routing"
  // off the cable's first node, otherwise append.
  const atStart = !!state.get('cablePlacingAtStart');

  const node = cables.addCablePoint(cableId, {
    type:       'point',
    anchorType: 'mesh',
    nodeId:           meshNodeId,
    anchorLocal:      [localPos.x, localPos.y, localPos.z],
    normalLocal:      localNormal ? [localNormal.x, localNormal.y, localNormal.z] : null,
    cachedWorldPos:   [hit.point.x, hit.point.y, hit.point.z],
  }, { atStart });
  if (!node) return null;
  undoManager.push('Add cable point',
    () => cables.removeCablePoint(cableId, node.id),
    () => {
      const cable = cables.getCable(cableId);
      if (!cable) return;
      if (cable.nodes?.find(n => n.id === node.id)) return;
      const list = (state.get('cables') || []).map(c => {
        if (c.id !== cableId) return c;
        const nodes = atStart ? [node, ...(c.nodes || [])] : [...(c.nodes || []), node];
        return { ...c, nodes };
      });
      state.setState({ cables: list });
      state.markDirty();
    },
  );
  return node.id;
}

/** Helper: walk up the THREE object's parents looking for a tagged tree id.
 *
 * Authoritative source: state.nodeById (the data tree). A nodeId returned
 * here is GUARANTEED to resolve via nodeById in subsequent lookups
 * (resolveNodeWorldPosition, cable updates, etc.).
 *
 * Previous version walked steps.object3dById which can drift out of sync
 * with nodeById after tree alterations (relink, move, model-source-bake,
 * delete-and-re-add). When it did, this function would return a nodeId
 * that nodeById couldn't find, and the cable resolver would fall through
 * to its `cachedWorldPos` cache forever — the "cable point won't follow
 * the object even on a brand-new cable" bug the user hit.
 *
 * Walks the THREE parent chain so a mesh inside a model group resolves
 * to the model's nodeId (registered) rather than the mesh's (typically
 * not registered).
 */
function _findTreeNodeIdForObject(obj) {
  const nodeById = state.get('nodeById');
  if (!nodeById) return null;
  let cur = obj;
  while (cur) {
    for (const [nodeId, node] of nodeById) {
      if (node?.object3d === cur) return nodeId;
    }
    cur = cur.parent;
  }
  return null;
}

/** Begin / stop placement mode. UI sets state.cablePlacingId.
 *  Pass `{ atStart: true }` to extend from the cable's first node
 *  (points get prepended to nodes[]). Default appends to the end.
 */
export function startCablePlacement(cableId, opts = {}) {
  if (!cables.getCable(cableId)) return;
  state.setState({
    cablePlacingId:      cableId,
    cablePlacingAtStart: !!opts.atStart,
  });
}

export function stopCablePlacement() {
  if (state.get('cablePlacingId') || state.get('cablePlacingAtStart')) {
    state.setState({ cablePlacingId: null, cablePlacingAtStart: false });
  }
}

/**
 * Phase A — cable point selection.
 *
 * Pure UI state, NO undo. Selecting a cable point clears any mesh
 * selection so the gizmo (Phase B) can target one thing at a time;
 * conversely, mesh selection callers should clear cable selection
 * to keep the two mutually exclusive.
 *
 * Pass null to clear.
 */
export function selectCablePoint(cableId, nodeId) {
  if (!cableId || !nodeId) {
    clearCablePointSelection();
    return;
  }
  // E2: when the node has a socket, the socket "owns" the position —
  // selecting the point would just give a translate-only gizmo that
  // can't drive the back-face / scale semantics the socket needs.
  // Redirect to socket selection so the user always interacts with
  // the right anchor.
  const node = _findCableNode(cableId, nodeId);
  if (node?.socket) {
    selectCableSocket(cableId, nodeId);
    return;
  }
  // Clear mesh selection without going through setSelection (which
  // would push an undo entry — selection of cable points is ephemeral).
  if (state.get('selectedId') || (state.get('multiSelectedIds')?.size ?? 0) > 0) {
    state.setSelection(null, new Set());
    materials.applySelectionHighlight([]);
  }
  // Mutually exclusive with socket selection.
  if (state.get('selectedCableSocket')) {
    state.setState({ selectedCableSocket: null });
  }
  state.setState({ selectedCablePoint: { cableId, nodeId } });
}

export function clearCablePointSelection() {
  if (state.get('selectedCablePoint')) {
    state.setState({ selectedCablePoint: null });
  }
}

/**
 * E2: cable-socket selection. Mutually exclusive with selectedCablePoint
 * and the mesh selection — selecting one clears the others. Pure UI,
 * no undo (selection is ephemeral).
 */
export function selectCableSocket(cableId, nodeId) {
  if (!cableId || !nodeId) {
    clearCableSocketSelection();
    return;
  }
  if (state.get('selectedId') || (state.get('multiSelectedIds')?.size ?? 0) > 0) {
    state.setSelection(null, new Set());
    materials.applySelectionHighlight([]);
  }
  if (state.get('selectedCablePoint')) {
    state.setState({ selectedCablePoint: null });
  }
  state.setState({ selectedCableSocket: { cableId, nodeId } });
}

export function clearCableSocketSelection() {
  if (state.get('selectedCableSocket')) {
    state.setState({ selectedCableSocket: null });
  }
}

// ─── Cable point move (Phase B) ───────────────────────────────────────────
//
// Drag-batched, mesh-anchor-only writes to cable.nodes[i].anchorLocal.
// Free / branch nodes are silently skipped — gizmo only shows for mesh
// anchors per the design rule "every cable node attaches to an object".
//
// Lifecycle (matches the gizmo's pointerdown/move/up):
//   1. beginCablePointMove(cableId, nodeId)
//        snapshots current anchorLocal so we can build undo at commit
//   2. setCablePointAnchorLocal(cableId, nodeId, [x,y,z]) per drag frame
//        mutates the cable node IN PLACE (no setState — the cables-render
//        per-frame ticker re-reads anchorLocal and updates the sphere
//        without a heavy geometry rebuild)
//   3. commitCablePointMove(cableId, nodeId)
//        emits change:cables (so save/load + downstream subscribers see
//        the new value), marks project dirty, pushes one undo entry
//        comparing snapshot → current.
//
// `applyCablePointWorldDelta` is the convenient call site for the gizmo
// translate write-back: it converts a world-space delta into the anchor
// mesh's local space and writes the new anchorLocal in place.

let _cablePointMoveBatch = null;   // { cableId, nodeId, snapshot:[x,y,z] }

function _findCableNode(cableId, nodeId) {
  const cable = (state.get('cables') || []).find(c => c.id === cableId);
  if (!cable) return null;
  const node  = (cable.nodes || []).find(n => n.id === nodeId);
  return node || null;
}

export function beginCablePointMove(cableId, nodeId) {
  const node = _findCableNode(cableId, nodeId);
  if (!node || node.anchorType !== 'mesh' || !Array.isArray(node.anchorLocal)) return;
  _cablePointMoveBatch = {
    cableId, nodeId,
    snapshot: node.anchorLocal.slice(),
  };
}

/**
 * Cumulative drag write — `worldDelta` is measured from the SNAPSHOT
 * captured by beginCablePointMove (i.e. the pose at pointerdown), not
 * from the previous frame. This makes per-frame calls idempotent: the
 * gizmo can call this every pointermove with the running cursor delta
 * and the result is always anchored to the start, no creep.
 *
 * Conversion: new anchorLocal = mesh.worldToLocal( start_world_pos + worldDelta )
 *   where start_world_pos = mesh.localToWorld(snapshot anchorLocal)
 */
export function applyCablePointCumulativeDelta(cableId, nodeId, worldDelta) {
  if (!_cablePointMoveBatch
      || _cablePointMoveBatch.cableId !== cableId
      || _cablePointMoveBatch.nodeId !== nodeId) return;
  const node = _findCableNode(cableId, nodeId);
  if (!node || node.anchorType !== 'mesh' || !Array.isArray(node.anchorLocal)) return;
  const T = window.THREE;
  if (!T) return;
  const nodeById = state.get('nodeById');
  const sceneNode = nodeById?.get?.(node.nodeId);
  const obj = sceneNode?.object3d;
  if (!obj) return;

  obj.updateMatrixWorld?.(true);
  const startLocal = _cablePointMoveBatch.snapshot;
  const startWorld = new T.Vector3(startLocal[0], startLocal[1], startLocal[2]);
  obj.localToWorld(startWorld);
  const newWorld   = startWorld.clone().add(worldDelta);
  const newLocal   = newWorld.clone();
  obj.worldToLocal(newLocal);
  // In-place mutation — the per-frame cable ticker picks this up next
  // frame and updates the sphere visual without a geometry rebuild.
  node.anchorLocal[0] = newLocal.x;
  node.anchorLocal[1] = newLocal.y;
  node.anchorLocal[2] = newLocal.z;
}

// ─── Cable socket add / remove (Phase E1) ─────────────────────────────────

/**
 * Add a default socket to a cable point. The host node carries the
 * socket; only one socket per node. If the node already has a socket
 * this is a no-op (caller should remove first or use a future edit).
 *
 * Default orientation derives from node.normalLocal at render time,
 * so a freshly-added socket sits flush on the host face automatically.
 */
/**
 * Socket size is now stored as percentages (100 = default). The
 * actual world dimensions = cable.style.radius * SOCKET_BASE_*.
 * Centralised here + in cables-render so the multiplier model is
 * consistent across UI inputs, render scale, and the IK shift.
 */
export const SOCKET_BASE_W = 4;   // multiplier on cable radius
export const SOCKET_BASE_H = 4;
export const SOCKET_BASE_D = 6;

/**
 * Phase G: a cable's effective radius is the project-level
 * cableGlobalRadius multiplied by the per-cable size %, fallback
 * to legacy cable.style.radius for older project files that don't
 * have the `size` field yet.
 */
export function cableEffectiveRadius(cable) {
  const globalR = state.get('cableGlobalRadius') ?? 1.0;
  const sizePct = cable?.style?.size;
  if (typeof sizePct === 'number') return globalR * (sizePct / 100);
  // Legacy path — old projects stored an absolute radius. Treat it
  // as if a same-thickness % so existing cables don't suddenly grow.
  const legacyR = cable?.style?.radius;
  if (typeof legacyR === 'number') return legacyR;
  return globalR;
}

export function socketActualSize(cable, socket) {
  const radius = cableEffectiveRadius(cable);
  const sz = socket?.size || { w: 100, h: 100, d: 100 };
  return {
    w: SOCKET_BASE_W * radius * (sz.w / 100),
    h: SOCKET_BASE_H * radius * (sz.h / 100),
    d: SOCKET_BASE_D * radius * (sz.d / 100),
  };
}

/**
 * Phase G: project-level cable global radius. Push undo entry so the
 * before/after value is reversible. setState fires change:cableGlobalRadius
 * which the render module subscribes to via _refreshAll.
 */
export function setCableGlobalRadius(value) {
  const before = state.get('cableGlobalRadius') ?? 1.0;
  const after  = Math.max(0.05, +value || 1.0);
  if (before === after) return;

  // Sockets are sized by global radius — depth grew/shrank, so the
  // cable point's anchor (which sits at the socket's front face) must
  // slide along the forward axis to keep the back face on the surface.
  // Per-node mutate; the undo path flips r0/r1 to walk the math back.
  const adjust = (r0, r1) => {
    const cur = state.get('cables') || [];
    for (const c of cur) {
      for (const n of (c.nodes || [])) {
        if (!n.socket || n.anchorType !== 'mesh' || !Array.isArray(n.anchorLocal)) continue;
        const sizeDPct = (n.socket.size?.d ?? 100) / 100;
        const oldDepth = SOCKET_BASE_D * r0 * sizeDPct;
        const newDepth = SOCKET_BASE_D * r1 * sizeDPct;
        const delta = newDepth - oldDepth;
        const fwd = _socketForwardMeshLocal(n);
        n.anchorLocal = [
          n.anchorLocal[0] + delta * fwd.x,
          n.anchorLocal[1] + delta * fwd.y,
          n.anchorLocal[2] + delta * fwd.z,
        ];
      }
    }
  };

  state.setState({ cableGlobalRadius: after });
  adjust(before, after);
  state.setState({ cables: [...(state.get('cables') || [])] });
  state.markDirty();

  undoManager.push(
    'Set cable global radius',
    () => {
      state.setState({ cableGlobalRadius: before });
      adjust(after, before);
      state.setState({ cables: [...(state.get('cables') || [])] });
      state.markDirty();
    },
    () => {
      state.setState({ cableGlobalRadius: after });
      adjust(before, after);
      state.setState({ cables: [...(state.get('cables') || [])] });
      state.markDirty();
    },
  );
}

/**
 * Phase G: project-level highlight colour. Applied by cables-render
 * to any cable with cable.highlight === true. Single undo entry per
 * commit (UI uses the change event so picker dragging doesn't
 * spam undo).
 */
export function setCableHighlightColor(value) {
  const before = state.get('cableHighlightColor') ?? '#22d3ee';
  const after  = String(value || '#22d3ee');
  if (before === after) return;
  state.setState({ cableHighlightColor: after });
  state.markDirty();
  undoManager.push(
    'Set cable highlight color',
    () => { state.setState({ cableHighlightColor: before }); state.markDirty(); },
    () => { state.setState({ cableHighlightColor: after  }); state.markDirty(); },
  );
}

/**
 * Stage 2 helpers — socket geometry math. The "forward" direction is
 * the socket's local +Z axis (in mesh-local space when the host is
 * mesh-anchored). The cable point sits at the FRONT face of the
 * socket; the BACK face is at front - d * forward (still in mesh-
 * local). Back face = where the socket is plugged in (the surface).
 *
 * All callers go through these so rotate / scale / gizmo-position
 * code share one source of truth.
 */
function _socketForwardMeshLocal(node) {
  const T = window.THREE;
  if (!T) return new T.Vector3(0, 0, 1);
  const sock = node?.socket;
  if (Array.isArray(sock?.localQuaternion) && sock.localQuaternion.length === 4) {
    const q = new T.Quaternion(
      sock.localQuaternion[0], sock.localQuaternion[1],
      sock.localQuaternion[2], sock.localQuaternion[3],
    );
    return new T.Vector3(0, 0, 1).applyQuaternion(q);
  }
  // Default orientation = +Z aligned to the surface normal in mesh-local.
  if (Array.isArray(node?.normalLocal) && node.normalLocal.length === 3) {
    return new T.Vector3(node.normalLocal[0], node.normalLocal[1], node.normalLocal[2]).normalize();
  }
  return new T.Vector3(0, 0, 1);
}

function _socketBackFaceMeshLocal(cable, node) {
  const T = window.THREE;
  if (!T || !node?.socket || !Array.isArray(node.anchorLocal)) return null;
  const fwd = _socketForwardMeshLocal(node);
  const d   = socketActualSize(cable, node.socket).d;
  const front = new T.Vector3(node.anchorLocal[0], node.anchorLocal[1], node.anchorLocal[2]);
  return front.clone().sub(fwd.multiplyScalar(d));
}

/** Back face in WORLD coordinates — for gizmo position. */
export function socketBackFaceWorld(cableId, nodeId) {
  const T = window.THREE;
  if (!T) return null;
  const cs = state.get('cables') || [];
  const c  = cs.find(x => x.id === cableId);
  const n  = c?.nodes?.find(x => x.id === nodeId);
  if (!c || !n?.socket || n.anchorType !== 'mesh' || !n.nodeId) return null;
  const sceneNode = state.get('nodeById')?.get?.(n.nodeId);
  const obj = sceneNode?.object3d;
  if (!obj) return null;
  const backLocal = _socketBackFaceMeshLocal(c, n);
  if (!backLocal) return null;
  obj.updateMatrixWorld?.(true);
  return obj.localToWorld(backLocal);
}

export function addCableSocket(cableId, nodeId) {
  const node = _findCableNode(cableId, nodeId);
  if (!node || node.socket) return false;
  // Size as percentage of cable-radius defaults — direct dimension
  // entry isn't part of the UI; user adjusts via 100% sliders + a
  // lock-ratio checkbox in the cable-tab editor.
  const cable  = (state.get('cables') || []).find(c => c.id === cableId);
  const socket = cables.createCableSocket({ size: { w: 100, h: 100, d: 100 } });

  // IK shift: lift the cable point by the socket's actual depth along
  // the surface normal so the back face lands on the anchored surface
  // and the front face sits at the (new) cable point.
  const actualD = socketActualSize(cable, socket).d;
  const beforeAnchor = Array.isArray(node.anchorLocal) ? node.anchorLocal.slice() : null;
  let didShift = false;
  if (node.anchorType === 'mesh'
      && Array.isArray(node.anchorLocal)
      && Array.isArray(node.normalLocal)
      && node.normalLocal.length === 3) {
    const nx = node.normalLocal[0];
    const ny = node.normalLocal[1];
    const nz = node.normalLocal[2];
    node.anchorLocal = [
      node.anchorLocal[0] + actualD * nx,
      node.anchorLocal[1] + actualD * ny,
      node.anchorLocal[2] + actualD * nz,
    ];
    didShift = true;
  }

  node.socket = socket;
  state.setState({ cables: [...(state.get('cables') || [])] });
  state.markDirty();
  undoManager.push(
    'Add socket',
    () => {
      const n = _findCableNode(cableId, nodeId);
      if (!n) return;
      n.socket = null;
      if (didShift && beforeAnchor) n.anchorLocal = beforeAnchor.slice();
      state.setState({ cables: [...(state.get('cables') || [])] });
      state.markDirty();
    },
    () => {
      const n = _findCableNode(cableId, nodeId);
      if (!n) return;
      n.socket = socket;
      if (didShift) {
        const nx = n.normalLocal[0];
        const ny = n.normalLocal[1];
        const nz = n.normalLocal[2];
        n.anchorLocal = [
          beforeAnchor[0] + actualD * nx,
          beforeAnchor[1] + actualD * ny,
          beforeAnchor[2] + actualD * nz,
        ];
      }
      state.setState({ cables: [...(state.get('cables') || [])] });
      state.markDirty();
    },
  );
  return true;
}

/**
 * Patch a socket's variable fields (size / color / name). One undo
 * entry comparing snapshot vs. patched. No IK adjustment — sliders
 * change the box's footprint without re-running the lift.
 */
export function setCableSocketProps(cableId, nodeId, patch) {
  const node = _findCableNode(cableId, nodeId);
  if (!node?.socket || !patch) return false;
  const cable = (state.get('cables') || []).find(c => c.id === cableId);
  const before = JSON.parse(JSON.stringify(node.socket));
  const beforeAnchor = Array.isArray(node.anchorLocal) ? node.anchorLocal.slice() : null;

  // Snapshot OLD actual depth before applying the patch, so a depth
  // change can update the cable point's anchor (back face fixed on
  // the surface, front face = anchor sweeps along the forward axis).
  const oldD = socketActualSize(cable, node.socket).d;

  if (patch.color  !== undefined) node.socket.color = patch.color;
  if (patch.name   !== undefined) node.socket.name  = patch.name;
  if (patch.size) {
    node.socket.size = {
      ...node.socket.size,
      ...(patch.size.w !== undefined ? { w: Math.max(10, +patch.size.w) } : {}),
      ...(patch.size.h !== undefined ? { h: Math.max(10, +patch.size.h) } : {}),
      ...(patch.size.d !== undefined ? { d: Math.max(10, +patch.size.d) } : {}),
    };
  }

  // Recompute anchor when depth changed: keep back face fixed, slide
  // front face (= cable point) along the forward direction by the
  // depth delta. W / H / colour / name don't affect the anchor.
  const newD = socketActualSize(cable, node.socket).d;
  if (Array.isArray(node.anchorLocal) && Math.abs(newD - oldD) > 1e-6) {
    const T = window.THREE;
    const fwd = _socketForwardMeshLocal(node);
    const delta = newD - oldD;
    node.anchorLocal = [
      node.anchorLocal[0] + delta * fwd.x,
      node.anchorLocal[1] + delta * fwd.y,
      node.anchorLocal[2] + delta * fwd.z,
    ];
  }

  const after = JSON.parse(JSON.stringify(node.socket));
  const afterAnchor = Array.isArray(node.anchorLocal) ? node.anchorLocal.slice() : null;
  state.setState({ cables: [...(state.get('cables') || [])] });
  state.markDirty();
  undoManager.push(
    'Edit socket',
    () => {
      const n = _findCableNode(cableId, nodeId);
      if (!n?.socket) return;
      Object.assign(n.socket, before);
      n.socket.size = { ...before.size };
      if (beforeAnchor) n.anchorLocal = beforeAnchor.slice();
      state.setState({ cables: [...(state.get('cables') || [])] });
      state.markDirty();
    },
    () => {
      const n = _findCableNode(cableId, nodeId);
      if (!n?.socket) return;
      Object.assign(n.socket, after);
      n.socket.size = { ...after.size };
      if (afterAnchor) n.anchorLocal = afterAnchor.slice();
      state.setState({ cables: [...(state.get('cables') || [])] });
      state.markDirty();
    },
  );
  return true;
}

/**
 * Remove a socket cleanly: shrink the depth to 0 (which slides the
 * cable point back along the forward direction onto the back face,
 * the original anchored surface), then drop the socket data. Net
 * effect is the cable point lands on the surface where the socket
 * was plugged in. One undo entry restores both the socket AND the
 * shifted-up anchor.
 */
export function removeCableSocket(cableId, nodeId) {
  const node = _findCableNode(cableId, nodeId);
  if (!node || !node.socket) return false;

  const beforeSocket = JSON.parse(JSON.stringify(node.socket));
  const beforeAnchor = Array.isArray(node.anchorLocal) ? node.anchorLocal.slice() : null;

  // Slide the cable point onto the back face (the socket's surface
  // attachment) by collapsing its depth contribution. We do this by
  // overwriting anchorLocal with the back-face mesh-local position.
  if (Array.isArray(node.anchorLocal)) {
    const cable = (state.get('cables') || []).find(c => c.id === cableId);
    const back  = _socketBackFaceMeshLocal(cable, node);
    if (back) {
      node.anchorLocal = [back.x, back.y, back.z];
    }
  }
  node.socket = null;

  const afterAnchor = Array.isArray(node.anchorLocal) ? node.anchorLocal.slice() : null;

  state.setState({ cables: [...(state.get('cables') || [])] });
  state.markDirty();
  undoManager.push(
    'Remove socket',
    () => {
      const n = _findCableNode(cableId, nodeId);
      if (!n) return;
      n.socket = beforeSocket;
      if (beforeAnchor) n.anchorLocal = beforeAnchor.slice();
      state.setState({ cables: [...(state.get('cables') || [])] });
      state.markDirty();
    },
    () => {
      const n = _findCableNode(cableId, nodeId);
      if (!n) return;
      n.socket = null;
      if (afterAnchor) n.anchorLocal = afterAnchor.slice();
      state.setState({ cables: [...(state.get('cables') || [])] });
      state.markDirty();
    },
  );
  return true;
}

// ─── Cable socket re-anchor (E2 follow-up) ────────────────────────────────

export function startCableSocketReanchor(cableId, nodeId) {
  const node = _findCableNode(cableId, nodeId);
  if (!node?.socket || node.anchorType !== 'mesh') return;
  state.setState({ cableSocketReanchorPickingId: { cableId, nodeId } });
}

export function cancelCableSocketReanchor() {
  if (state.get('cableSocketReanchorPickingId')) {
    state.setState({ cableSocketReanchorPickingId: null });
  }
}

/**
 * Apply a socket re-anchor pick. Snaps the back face to the new mesh
 * + face position, resets the socket's orientation to align with the
 * new surface normal, and re-runs the IK shift so the cable point
 * sits at the new front face. One undo entry restores all of:
 *   nodeId, anchorLocal, normalLocal, cachedWorldPos, socket.localQuaternion.
 */
export function applyCableSocketReanchor(hit) {
  const target = state.get('cableSocketReanchorPickingId');
  if (!target || !hit?.point || !hit?.object) return false;
  const node = _findCableNode(target.cableId, target.nodeId);
  if (!node?.socket || node.anchorType !== 'mesh') {
    cancelCableSocketReanchor();
    return false;
  }
  const meshNodeId = _findTreeNodeIdForObject(hit.object);
  if (!meshNodeId) {
    cancelCableSocketReanchor();
    return false;
  }
  const cable = (state.get('cables') || []).find(c => c.id === target.cableId);
  if (!cable) { cancelCableSocketReanchor(); return false; }

  const T = window.THREE;
  const localPos    = hit.object.worldToLocal(hit.point.clone());
  const localNormal = hit.face?.normal
    ? hit.face.normal.clone().normalize()
    : new T.Vector3(0, 0, 1);

  const before = {
    nodeId:                node.nodeId,
    anchorLocal:           Array.isArray(node.anchorLocal)    ? node.anchorLocal.slice()    : null,
    normalLocal:           Array.isArray(node.normalLocal)    ? node.normalLocal.slice()    : null,
    cachedWorldPos:        Array.isArray(node.cachedWorldPos) ? node.cachedWorldPos.slice() : null,
    socketLocalQuaternion: Array.isArray(node.socket.localQuaternion)
      ? node.socket.localQuaternion.slice()
      : null,
  };

  // Compute new socket localQuaternion = the default orientation on
  // the new surface (+Z aligned to local normal).
  const q = new T.Quaternion();
  q.setFromUnitVectors(new T.Vector3(0, 0, 1), localNormal);
  const newSocketLocalQuat = [q.x, q.y, q.z, q.w];

  // New anchor = back face on new surface + actualD * normal.
  const actualD = socketActualSize(cable, node.socket).d;
  const newAnchorLocal = [
    localPos.x + actualD * localNormal.x,
    localPos.y + actualD * localNormal.y,
    localPos.z + actualD * localNormal.z,
  ];

  const after = {
    nodeId:                meshNodeId,
    anchorLocal:           newAnchorLocal,
    normalLocal:           [localNormal.x, localNormal.y, localNormal.z],
    cachedWorldPos:        [hit.point.x, hit.point.y, hit.point.z],
    socketLocalQuaternion: newSocketLocalQuat,
  };

  // Apply.
  node.nodeId         = after.nodeId;
  node.anchorLocal    = after.anchorLocal.slice();
  node.normalLocal    = after.normalLocal.slice();
  node.cachedWorldPos = after.cachedWorldPos.slice();
  node.socket.localQuaternion = after.socketLocalQuaternion.slice();

  state.setState({ cables: [...(state.get('cables') || [])] });
  state.markDirty();
  cancelCableSocketReanchor();

  undoManager.push(
    'Re-anchor socket',
    () => {
      const n = _findCableNode(target.cableId, target.nodeId);
      if (!n?.socket) return;
      if (before.nodeId         !== null) n.nodeId         = before.nodeId;
      if (before.anchorLocal)             n.anchorLocal    = before.anchorLocal.slice();
      if (before.normalLocal)             n.normalLocal    = before.normalLocal.slice();
      if (before.cachedWorldPos)          n.cachedWorldPos = before.cachedWorldPos.slice();
      if (before.socketLocalQuaternion) {
        n.socket.localQuaternion = before.socketLocalQuaternion.slice();
      } else {
        n.socket.localQuaternion = null;
      }
      state.setState({ cables: [...(state.get('cables') || [])] });
      state.markDirty();
    },
    () => {
      const n = _findCableNode(target.cableId, target.nodeId);
      if (!n?.socket) return;
      n.nodeId         = after.nodeId;
      n.anchorLocal    = after.anchorLocal.slice();
      n.normalLocal    = after.normalLocal.slice();
      n.cachedWorldPos = after.cachedWorldPos.slice();
      n.socket.localQuaternion = after.socketLocalQuaternion.slice();
      state.setState({ cables: [...(state.get('cables') || [])] });
      state.markDirty();
    },
  );
  return true;
}

// ─── Cable branching (Phase F) ────────────────────────────────────────────

/**
 * Create a new cable that branches off an existing point. The new
 * cable's first node is `anchorType: 'branch'` referring back to the
 * parent point (resolveNodeWorldPosition handles the recursion). The
 * parent point's branchCableIds array gains this cable's id, blocking
 * accidental delete in future cascade-protect work.
 *
 * Auto-enters placement mode so the user can click meshes to extend
 * the branch immediately, same as creating a fresh cable from the tab.
 *
 * Undo: snapshot the whole cables array before/after — branching
 * touches three places (parent.branchCableIds, the new cable record,
 * and the branch-start node) and a brute snapshot is the cheapest
 * round-trip. State is small enough that JSON-clone cost is fine.
 */
export function createBranchFromCablePoint(parentCableId, parentNodeId) {
  const parentNode = _findCableNode(parentCableId, parentNodeId);
  if (!parentNode) return null;

  const beforeCables = JSON.parse(JSON.stringify(state.get('cables') || []));

  const branchCable = cables.addCable({
    name: `Branch ${cables.listCables().length}`,
    branchSource: { cableId: parentCableId, nodeId: parentNodeId },
  });
  cables.addCablePoint(branchCable.id, {
    type:           'branch-start',
    anchorType:     'branch',
    sourceCableId:  parentCableId,
    sourceNodeId:   parentNodeId,
  });

  // Update parent's outgoing-branch list. Direct mutation followed by
  // setState since cables.* mutators always take cable-level paths.
  const parentRef = _findCableNode(parentCableId, parentNodeId);
  if (parentRef) {
    parentRef.branchCableIds = [...(parentRef.branchCableIds || []), branchCable.id];
  }
  state.setState({ cables: [...(state.get('cables') || [])] });
  state.markDirty();

  const afterCables = JSON.parse(JSON.stringify(state.get('cables') || []));

  undoManager.push(
    'Create branch',
    () => {
      state.setState({ cables: JSON.parse(JSON.stringify(beforeCables)) });
      state.markDirty();
    },
    () => {
      state.setState({ cables: JSON.parse(JSON.stringify(afterCables)) });
      state.markDirty();
    },
  );

  // Auto-enter placement so the user can immediately drop more
  // points along the branch. ESC / Stop Placement exits.
  startCablePlacement(branchCable.id);

  return branchCable;
}

// ─── Cable point delete / insert (Phase D) ────────────────────────────────

/**
 * Delete a single cable point. Captures the node + its position in
 * the cable's node list so undo can splice it back in at the same
 * spot. Clears selection if the deleted point was selected.
 */
export function deleteCablePoint(cableId, nodeId) {
  const cable = (state.get('cables') || []).find(c => c.id === cableId);
  if (!cable) return false;
  const idx   = (cable.nodes || []).findIndex(n => n.id === nodeId);
  if (idx < 0) return false;

  const removed = cable.nodes[idx];

  const wasSelected = (() => {
    const sel = state.get('selectedCablePoint');
    return sel && sel.cableId === cableId && sel.nodeId === nodeId;
  })();

  cables.removeCablePoint(cableId, nodeId);
  if (wasSelected) clearCablePointSelection();

  undoManager.push(
    'Delete cable point',
    () => {
      // Splice the node back in at its original index.
      const cur = state.get('cables') || [];
      const list = cur.map(c => {
        if (c.id !== cableId) return c;
        const nodes = (c.nodes || []).slice();
        nodes.splice(Math.min(idx, nodes.length), 0, removed);
        return { ...c, nodes };
      });
      state.setState({ cables: list });
      state.markDirty();
    },
    () => {
      cables.removeCablePoint(cableId, nodeId);
      if (wasSelected) clearCablePointSelection();
    },
  );
  return true;
}

/**
 * Enter insert-point pick mode. While set, the next viewport click on
 * a mesh adds a new anchored cable point to the cable at the slot
 * before/after the anchor node. ESC cancels.
 */
export function startCableInsertPicking(cableId, anchorNodeId, position) {
  if (position !== 'before' && position !== 'after') return;
  const cable = (state.get('cables') || []).find(c => c.id === cableId);
  if (!cable || !(cable.nodes || []).find(n => n.id === anchorNodeId)) return;
  state.setState({ cableInsertPickingTarget: { cableId, anchorNodeId, position } });
}

export function cancelCableInsertPicking() {
  if (state.get('cableInsertPickingTarget')) {
    state.setState({ cableInsertPickingTarget: null });
  }
}

/**
 * Phase D revision: immediate insert at the right-clicked world
 * position, inheriting the anchor mesh + face normal from the
 * preceding point (segment.fromNodeId). The user can re-anchor /
 * move it later — this is just a faster create that doesn't need
 * a separate pick gesture.
 *
 * `fromNodeId` is the segment's left endpoint (the existing
 * "Insert point here" UX called startCableInsertPicking with
 * position='after' on this id).
 */
export function insertCablePointAtSegmentHit(cableId, fromNodeId, hitPoint) {
  const cable = (state.get('cables') || []).find(c => c.id === cableId);
  if (!cable) return false;
  const anchorIdx = (cable.nodes || []).findIndex(n => n.id === fromNodeId);
  if (anchorIdx < 0) return false;
  const fromNode = cable.nodes[anchorIdx];
  // Need a mesh anchor on the predecessor — the new point inherits
  // both the host mesh and its surface normal so re-anchor isn't
  // required to make the point movable.
  if (fromNode.anchorType !== 'mesh' || !fromNode.nodeId) return false;
  const sceneNode = state.get('nodeById')?.get?.(fromNode.nodeId);
  const obj = sceneNode?.object3d;
  if (!obj) return false;
  const T = window.THREE;
  if (!T) return false;
  obj.updateMatrixWorld?.(true);
  const localPos = obj.worldToLocal(hitPoint.clone());

  const newNode = cables.createCableNode({
    type:           'point',
    anchorType:     'mesh',
    nodeId:         fromNode.nodeId,
    anchorLocal:    [localPos.x, localPos.y, localPos.z],
    normalLocal:    Array.isArray(fromNode.normalLocal) ? fromNode.normalLocal.slice() : null,
    cachedWorldPos: [hitPoint.x, hitPoint.y, hitPoint.z],
  });

  const insertIdx = anchorIdx + 1;
  const list = (state.get('cables') || []).map(c => {
    if (c.id !== cableId) return c;
    const nodes = (c.nodes || []).slice();
    nodes.splice(insertIdx, 0, newNode);
    return { ...c, nodes };
  });
  state.setState({ cables: list });
  state.markDirty();

  undoManager.push(
    'Insert cable point',
    () => cables.removeCablePoint(cableId, newNode.id),
    () => {
      const cur = state.get('cables') || [];
      const list2 = cur.map(c => {
        if (c.id !== cableId) return c;
        const nodes = (c.nodes || []).slice();
        nodes.splice(Math.min(insertIdx, nodes.length), 0, newNode);
        return { ...c, nodes };
      });
      state.setState({ cables: list2 });
      state.markDirty();
    },
  );
  return true;
}

/**
 * Apply an insert-point pick. Builds a mesh-anchored node at the hit
 * and splices it into the cable at the position chosen at picking
 * start. One undo entry — removes the spliced node on undo.
 */
export function insertCablePointAtHit(hit) {
  const target = state.get('cableInsertPickingTarget');
  if (!target || !hit?.point || !hit?.object) return false;
  const meshNodeId = _findTreeNodeIdForObject(hit.object);
  if (!meshNodeId) {
    cancelCableInsertPicking();
    return false;
  }
  const cable = (state.get('cables') || []).find(c => c.id === target.cableId);
  if (!cable) { cancelCableInsertPicking(); return false; }
  const anchorIdx = (cable.nodes || []).findIndex(n => n.id === target.anchorNodeId);
  if (anchorIdx < 0) { cancelCableInsertPicking(); return false; }
  const insertIdx = target.position === 'before' ? anchorIdx : anchorIdx + 1;

  const localPos    = hit.object.worldToLocal(hit.point.clone());
  const localNormal = hit.face?.normal ? hit.face.normal.clone().normalize() : null;

  const newNode = cables.createCableNode({
    type:           'point',
    anchorType:     'mesh',
    nodeId:         meshNodeId,
    anchorLocal:    [localPos.x, localPos.y, localPos.z],
    normalLocal:    localNormal ? [localNormal.x, localNormal.y, localNormal.z] : null,
    cachedWorldPos: [hit.point.x, hit.point.y, hit.point.z],
  });

  const list = (state.get('cables') || []).map(c => {
    if (c.id !== target.cableId) return c;
    const nodes = (c.nodes || []).slice();
    nodes.splice(insertIdx, 0, newNode);
    return { ...c, nodes };
  });
  state.setState({ cables: list });
  state.markDirty();
  cancelCableInsertPicking();

  undoManager.push(
    'Insert cable point',
    () => {
      cables.removeCablePoint(target.cableId, newNode.id);
    },
    () => {
      const cur = state.get('cables') || [];
      const list2 = cur.map(c => {
        if (c.id !== target.cableId) return c;
        const nodes = (c.nodes || []).slice();
        nodes.splice(Math.min(insertIdx, nodes.length), 0, newNode);
        return { ...c, nodes };
      });
      state.setState({ cables: list2 });
      state.markDirty();
    },
  );
  return true;
}

// ─── Cable socket rotate (Phase E2) ───────────────────────────────────────
//
// Drag-batched writes to node.socket.localQuaternion. Mirrors the
// point-move lifecycle (begin / cumulative apply / commit). Mesh-
// anchored hosts only — branch / free hosts could be added later if
// needed (different math, no parent meshWorldQuat).

// Snapshot during rotate carries enough to back-solve the cable
// point's new anchorLocal each frame: the mesh-local back face
// (fixed during pure rotation) and the start orientation.
let _cableSocketRotateBatch = null;
//   { cableId, nodeId,
//     startQuat:[x,y,z,w], startAnchor:[x,y,z],
//     backFaceLocal:[x,y,z], actualD:number }

function _quatFromNormalLocal(node) {
  const T = window.THREE;
  if (!T) return [0, 0, 0, 1];
  if (!Array.isArray(node?.normalLocal) || node.normalLocal.length !== 3) return [0, 0, 0, 1];
  const v = new T.Vector3(node.normalLocal[0], node.normalLocal[1], node.normalLocal[2]).normalize();
  const q = new T.Quaternion();
  q.setFromUnitVectors(new T.Vector3(0, 0, 1), v);
  return [q.x, q.y, q.z, q.w];
}

export function beginCableSocketRotate(cableId, nodeId) {
  const node = _findCableNode(cableId, nodeId);
  if (!node?.socket || !Array.isArray(node.anchorLocal)) return;
  const cable = (state.get('cables') || []).find(c => c.id === cableId);
  if (!cable) return;
  // Persist the current localQuaternion (or seed it from normalLocal
  // so the snapshot is the same orientation the renderer is using).
  if (!Array.isArray(node.socket.localQuaternion) || node.socket.localQuaternion.length !== 4) {
    node.socket.localQuaternion = _quatFromNormalLocal(node);
  }
  const back = _socketBackFaceMeshLocal(cable, node);
  _cableSocketRotateBatch = {
    cableId, nodeId,
    startQuat:     node.socket.localQuaternion.slice(),
    startAnchor:   node.anchorLocal.slice(),
    backFaceLocal: back ? [back.x, back.y, back.z] : null,
    actualD:       socketActualSize(cable, node.socket).d,
  };
}

export function applyCableSocketRotateAxisAngle(cableId, nodeId, worldAxis, angle) {
  if (!_cableSocketRotateBatch
      || _cableSocketRotateBatch.cableId !== cableId
      || _cableSocketRotateBatch.nodeId !== nodeId) return;
  const node = _findCableNode(cableId, nodeId);
  if (!node?.socket || node.anchorType !== 'mesh' || !node.nodeId) return;
  const T = window.THREE;
  if (!T) return;
  const sceneNode = state.get('nodeById')?.get?.(node.nodeId);
  const obj = sceneNode?.object3d;
  if (!obj) return;
  obj.updateMatrixWorld?.(true);
  const meshQ = new T.Quaternion();
  obj.getWorldQuaternion(meshQ);
  const meshQinv = meshQ.clone().invert();
  // Transport the world rotation axis into mesh-local.
  const localAxis = worldAxis.clone().applyQuaternion(meshQinv).normalize();
  const deltaQ = new T.Quaternion().setFromAxisAngle(localAxis, angle);
  const snap = _cableSocketRotateBatch.startQuat;
  const snapQ = new T.Quaternion(snap[0], snap[1], snap[2], snap[3]);
  // Pre-multiply: rotation is around a fixed mesh-local axis (axis
  // doesn't follow the socket as it spins).
  const newQ = deltaQ.clone().multiply(snapQ);
  node.socket.localQuaternion = [newQ.x, newQ.y, newQ.z, newQ.w];

  // Back-solve the cable point: the BACK face stays fixed during
  // rotation (it's the surface attachment); the FRONT face (= cable
  // point) sweeps around it. New anchor = backFaceLocal + d * newForward.
  const back = _cableSocketRotateBatch.backFaceLocal;
  const d    = _cableSocketRotateBatch.actualD;
  if (back && Number.isFinite(d)) {
    const newForward = new T.Vector3(0, 0, 1).applyQuaternion(newQ);
    node.anchorLocal = [
      back[0] + d * newForward.x,
      back[1] + d * newForward.y,
      back[2] + d * newForward.z,
    ];
  }
}

export function commitCableSocketRotate(cableId, nodeId) {
  if (!_cableSocketRotateBatch
      || _cableSocketRotateBatch.cableId !== cableId
      || _cableSocketRotateBatch.nodeId !== nodeId) return;
  const node = _findCableNode(cableId, nodeId);
  const beforeQuat   = _cableSocketRotateBatch.startQuat;
  const beforeAnchor = _cableSocketRotateBatch.startAnchor;
  const afterQuat    = node?.socket?.localQuaternion ? node.socket.localQuaternion.slice() : null;
  const afterAnchor  = Array.isArray(node?.anchorLocal) ? node.anchorLocal.slice() : null;
  _cableSocketRotateBatch = null;
  if (!afterQuat) return;
  if (beforeQuat[0] === afterQuat[0] && beforeQuat[1] === afterQuat[1]
      && beforeQuat[2] === afterQuat[2] && beforeQuat[3] === afterQuat[3]) return;

  state.setState({ cables: [...(state.get('cables') || [])] });
  state.markDirty();
  undoManager.push(
    'Rotate socket',
    () => {
      const n = _findCableNode(cableId, nodeId);
      if (!n?.socket) return;
      n.socket.localQuaternion = beforeQuat.slice();
      if (beforeAnchor) n.anchorLocal = beforeAnchor.slice();
      state.setState({ cables: [...(state.get('cables') || [])] });
      state.markDirty();
    },
    () => {
      const n = _findCableNode(cableId, nodeId);
      if (!n?.socket) return;
      n.socket.localQuaternion = afterQuat.slice();
      if (afterAnchor) n.anchorLocal = afterAnchor.slice();
      state.setState({ cables: [...(state.get('cables') || [])] });
      state.markDirty();
    },
  );
}

// ─── Cable re-anchor (Phase C) ────────────────────────────────────────────

/**
 * Enter re-anchor pick mode for a cable point. While set, the next
 * viewport click on a mesh moves the point's anchor to that mesh +
 * face. ESC cancels.
 */
export function startCableReanchorPicking(cableId, nodeId) {
  const node = _findCableNode(cableId, nodeId);
  if (!node || node.anchorType !== 'mesh') return;
  state.setState({ cableReanchorPickingId: { cableId, nodeId } });
}

export function cancelCableReanchorPicking() {
  if (state.get('cableReanchorPickingId')) {
    state.setState({ cableReanchorPickingId: null });
  }
}

/**
 * Apply a re-anchor pick. `hit` is a raycast hit (sceneCore.pick) with
 * .object + .point + .face. Re-anchors the currently-picking cable
 * point to the new mesh's node id + local position + face normal.
 * One undo entry — restores all four anchor fields together.
 */
export function reanchorCablePoint(hit) {
  const target = state.get('cableReanchorPickingId');
  if (!target || !hit?.point || !hit?.object) return false;
  const node = _findCableNode(target.cableId, target.nodeId);
  if (!node || node.anchorType !== 'mesh') {
    cancelCableReanchorPicking();
    return false;
  }
  const meshNodeId = _findTreeNodeIdForObject(hit.object);
  if (!meshNodeId) {
    // Hit was on a non-tree object (gizmo? cable spheres should be
    // filtered by the picker). Bail without committing.
    cancelCableReanchorPicking();
    return false;
  }

  const localPos    = hit.object.worldToLocal(hit.point.clone());
  const localNormal = hit.face?.normal ? hit.face.normal.clone().normalize() : null;

  const before = {
    nodeId:         node.nodeId,
    anchorLocal:    Array.isArray(node.anchorLocal)    ? node.anchorLocal.slice()    : null,
    normalLocal:    Array.isArray(node.normalLocal)    ? node.normalLocal.slice()    : null,
    cachedWorldPos: Array.isArray(node.cachedWorldPos) ? node.cachedWorldPos.slice() : null,
  };
  const after = {
    nodeId:         meshNodeId,
    anchorLocal:    [localPos.x, localPos.y, localPos.z],
    normalLocal:    localNormal ? [localNormal.x, localNormal.y, localNormal.z] : null,
    cachedWorldPos: [hit.point.x, hit.point.y, hit.point.z],
  };

  // Apply the new anchor in place + bump cables for subscribers.
  Object.assign(node, after);
  state.setState({ cables: [...(state.get('cables') || [])] });
  state.markDirty();
  cancelCableReanchorPicking();

  undoManager.push(
    'Re-anchor cable point',
    () => {
      const n = _findCableNode(target.cableId, target.nodeId);
      if (!n) return;
      Object.assign(n, before);
      state.setState({ cables: [...(state.get('cables') || [])] });
      state.markDirty();
    },
    () => {
      const n = _findCableNode(target.cableId, target.nodeId);
      if (!n) return;
      Object.assign(n, after);
      state.setState({ cables: [...(state.get('cables') || [])] });
      state.markDirty();
    },
  );
  return true;
}

export function commitCablePointMove(cableId, nodeId) {
  if (!_cablePointMoveBatch
      || _cablePointMoveBatch.cableId !== cableId
      || _cablePointMoveBatch.nodeId !== nodeId) {
    return;
  }
  const node = _findCableNode(cableId, nodeId);
  if (!node) { _cablePointMoveBatch = null; return; }
  const before = _cablePointMoveBatch.snapshot;
  const after  = node.anchorLocal.slice();
  _cablePointMoveBatch = null;

  // No real change — drag was a no-op (e.g. user grabbed a handle but
  // didn't move). Skip undo entry, skip dirty.
  if (before[0] === after[0] && before[1] === after[1] && before[2] === after[2]) return;

  // Bump cables to refresh subscribers (geometry rebuild on rebuild
  // path is harmless — we already updated in place during drag).
  state.setState({ cables: [...(state.get('cables') || [])] });
  state.markDirty();

  undoManager.push(
    'Move cable point',
    () => {
      const n = _findCableNode(cableId, nodeId);
      if (!n) return;
      n.anchorLocal = before.slice();
      state.setState({ cables: [...(state.get('cables') || [])] });
      state.markDirty();
    },
    () => {
      const n = _findCableNode(cableId, nodeId);
      if (!n) return;
      n.anchorLocal = after.slice();
      state.setState({ cables: [...(state.get('cables') || [])] });
      state.markDirty();
    },
  );
}


// ═══════════════════════════════════════════════════════════════════════════
//  ANIMATION PRESET ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

export function createAnimPreset(name) {
  const preset   = createAnimationPreset({ name: name || 'New Animation' });
  const presets  = [...(state.get('animationPresets') || []), preset];
  state.setState({ animationPresets: presets });
  state.markDirty();
  undoManager.push(
    `Create animation "${preset.name}"`,
    () => {
      state.setState({ animationPresets: (state.get('animationPresets') || []).filter(p => p.id !== preset.id) });
      state.markDirty();
    },
    () => {
      state.setState({ animationPresets: [...(state.get('animationPresets') || []), preset] });
      state.markDirty();
    },
  );
  return preset;
}

export function updateAnimPreset(presetId, patch) {
  const presets  = state.get('animationPresets') || [];
  const preset   = presets.find(p => p.id === presetId);
  if (!preset) return;
  const from     = { ...preset };
  Object.assign(preset, patch);
  state.setState({ animationPresets: [...presets] });
  state.markDirty();
  undoManager.push(
    'Edit animation',
    () => {
      const ps = state.get('animationPresets') || [];
      const p  = ps.find(x => x.id === presetId);
      if (p) { Object.assign(p, from); state.setState({ animationPresets: [...ps] }); }
      state.markDirty();
    },
    () => {
      const ps = state.get('animationPresets') || [];
      const p  = ps.find(x => x.id === presetId);
      if (p) { Object.assign(p, patch); state.setState({ animationPresets: [...ps] }); }
      state.markDirty();
    },
  );
}

export function setDefaultAnimPreset(presetId) {
  const presets = (state.get('animationPresets') || []).map(p => ({
    ...p,
    isDefault: p.id === presetId,
  }));
  state.setState({ animationPresets: presets });
  state.markDirty();
}

export function deleteAnimPreset(presetId) {
  const presets     = state.get('animationPresets') || [];
  const preset      = { ...presets.find(p => p.id === presetId) };
  if (!preset.id) return;
  const newPresets  = presets.filter(p => p.id !== presetId);

  // Clear any step references to this preset
  const stepsBefore = JSON.parse(JSON.stringify(state.get('steps') || []));
  const stepsAfter  = stepsBefore.map(s =>
    s.transition?.animPresetId === presetId
      ? { ...s, transition: { ...s.transition, animPresetId: null } }
      : s,
  );

  state.setState({ animationPresets: newPresets, steps: stepsAfter });
  state.markDirty();

  undoManager.push(
    `Delete animation "${preset.name}"`,
    () => {
      state.setState({
        animationPresets: [...(state.get('animationPresets') || []), preset],
        steps: stepsBefore,
      });
      state.markDirty();
    },
    () => {
      state.setState({
        animationPresets: (state.get('animationPresets') || []).filter(p => p.id !== presetId),
        steps: stepsAfter,
      });
      state.markDirty();
    },
  );
}


// ═══════════════════════════════════════════════════════════════════════════
//  KEYBOARD SHORTCUTS  (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z)
// ═══════════════════════════════════════════════════════════════════════════

export function setupUndoKeyboard() {
  window.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;

    // P7-A: when an edit session is open (textbox / header canvas
    // editor mounted), Ctrl-Z / Ctrl-Y must NOT bleed into the main
    // undo log — that's how a stray Ctrl-Z while editing was undoing
    // timeline / step changes from the global stack. Route to the
    // local session stack first; if the session is empty, swallow the
    // event rather than fall through. The editor's own keydown
    // handler on the contenteditable already covers Ctrl-Z/Y while
    // the editor is FOCUSED; this branch handles the case where
    // focus has drifted onto the toolbar / colour picker / etc. but
    // a session is still open.
    // Normalise case so Caps Lock doesn't break undo/redo: with Caps Lock ON an
    // unshifted "z" arrives as e.key "Z" (and Shift+z as "z"), so comparing to a
    // literal 'z'/'Z' silently failed. Use the lowercased key + e.shiftKey.
    const k = (e.key || '').toLowerCase();
    if (editSession.isActive()) {
      if (!e.shiftKey && k === 'z') {
        e.preventDefault();
        editSession.undoLocal();   // false-return = local stack empty; we still swallow
        return;
      }
      if (k === 'y' || (e.shiftKey && k === 'z')) {
        e.preventDefault();
        editSession.redoLocal();
        return;
      }
    }

    if (_isInputFocused()) return;
    if (!e.shiftKey && k === 'z') { e.preventDefault(); undoManager.undo(); }
    if (k === 'y')                { e.preventDefault(); undoManager.redo(); }
    if (e.shiftKey && k === 'z')  { e.preventDefault(); undoManager.redo(); }
  });
}


// ═══════════════════════════════════════════════════════════════════════════
//  PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function _restoreAssignments(ids, prev) {
  ids.forEach(id => {
    if (prev[id] === null) delete materials.meshColorAssignments[id];
    else materials.meshColorAssignments[id] = prev[id];
  });
}

function _syncVis() {
  applyAllVisibility(state.get('treeData'), steps.object3dById);
  state.emit('change:treeData', state.get('treeData'));
  steps.scheduleSync();
}

// ─── Archive immutability guard ───────────────────────────────────────────
//
// Archived nodes are READ-ONLY: ignore any direct user mutation. They still
// follow their CONTAINER (parent transforms / parent visibility / step
// rebuilds carry them along), but a direct click on the eye / color / move
// / etc. is silently dropped. Filtering happens at the action entry so the
// UI doesn't need to know — clicks just no-op on archived selections.
//
// _stripArchived(ids):  return only the non-archived ids from `ids`.
// _isArchived(id):      single-id helper for early-return guards.

function _stripArchived(ids) {
  const nb = state.get('nodeById');
  if (!nb) return Array.isArray(ids) ? [...ids] : [...(ids || [])];
  const list = Array.isArray(ids) ? ids : [...(ids || [])];
  return list.filter(id => nb.get(id)?.archived !== true);
}

function _isArchived(id) {
  const nb = state.get('nodeById');
  return nb?.get(id)?.archived === true;
}

// ── Replace-Model selection expansion ─────────────────────────────────────
//
// When the user has an RM selected (selectedId === RM.id, possibly via
// the viewport's selection-promotion path), color / visibility / cable
// / similar mutations should apply to ALL the RM's children too —
// otherwise the change writes to RM.id only (which has no rendered
// mesh) and nothing visible happens.
//
// _expandRMSelection adds every descendant of any RM id in `ids` to the
// returned set. The RM's own id stays in the list (so RM-level color
// assignments are still recorded — they're inherited by newly-added
// children via addToReplaceModel's 6c step).
//
// V0.1.83 revert: locked folder-groups intentionally DO NOT cascade
// here. Per user spec, applying a color/etc. to a locked group does
// nothing — the group's contents are treated as a single unit for
// SELECTION, but mutations to the group itself don't reach children.
// (Mutations on individually-selected children — possible only when
// the group is unlocked — work normally.)
function _expandRMSelection(ids) {
  const nb = state.get('nodeById');
  if (!nb) return Array.isArray(ids) ? [...ids] : [...(ids || [])];
  const list = Array.isArray(ids) ? ids : [...(ids || [])];
  const out = new Set(list);
  for (const id of list) {
    const node = nb.get(id);
    if (node?.type === 'replaceModel') {
      (function walk(n) {
        for (const c of (n.children || [])) { out.add(c.id); walk(c); }
      })(node);
    }
  }
  return [...out];
}

/**
 * True if the selection includes at least one replaceModel container.
 * When true, color / visibility / etc. mutations should treat the change
 * as RM-level — i.e., cascade across EVERY step (the RM's color is a
 * "default for the entire timeline", not a per-step override per spec).
 * Individual per-step overrides on a SPECIFIC child are still possible
 * by selecting that child alone.
 */
function _hasRMInSelection(ids) {
  const nb = state.get('nodeById');
  if (!nb) return false;
  const list = Array.isArray(ids) ? ids : [...(ids || [])];
  return list.some(id => nb.get(id)?.type === 'replaceModel');
}

function _isInputFocused() {
  const t = document.activeElement?.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || document.activeElement?.isContentEditable;
}

// ═══════════════════════════════════════════════════════════════════════════
//  MODEL SOURCE TRANSFORM (Edit → Model source transform…)
// ═══════════════════════════════════════════════════════════════════════════
//
// Cascade-through-snapshots design (per user spec):
//   1. The user enters a delta (position, rotation, uniform scale) at
//      the model's "step 0" / origin location.
//   2. We mutate EVERY step's snapshot.transforms[modelId] so the same
//      delta appears in every step. Per-step animation deltas
//      (the gap from one step to the next) are preserved.
//   3. Pivot's WORLD orientation must stay invariant — otherwise the
//      gizmo's local-translate axes would rotate with the source.
//      Compensate node.pivotLocalQuaternion with inv(Δq) so:
//          pivot_world_after  = (...×Δq) × inv(Δq)×pivotQ_old = pivot_world_before
//   4. Scale is project-level (node.baseLocalScale) — multiply directly.
//
// This function is rare (user opens it occasionally); the cascade walks
// every step. That cost is fine for the simplicity it buys downstream
// — no extra Three.js groups, no per-frame composition, the per-step
// stored transforms ARE the world transforms.

/**
 * Set the model's source transform. Writes to node.sourceLocal* and
 * BAKES the transform into every belonging mesh's geometry vertices —
 * equivalent to opening the model file in another DCC, applying the
 * transform there, and reloading. The bake rides INSIDE the geometry,
 * so it cascades through every step regardless of where each mesh has
 * been moved in any given step.
 *
 * - Per-step transforms (localOffset / localQuaternion) are NEVER
 *   touched. They keep their existing semantics — animations preserved.
 * - The pivot system operates on the model's outer group; source is
 *   embedded in the geometry. Pivot world position + orientation are
 *   unaffected.
 * - Displaced meshes (moved into other folders in some steps) still
 *   pick up the source — the bake follows the geometry data, not the
 *   tree position.
 *
 * Inputs are ABSOLUTE (the source state), not deltas. Apply replaces,
 * never stacks: each apply rewinds to the import-time original geometry
 * before re-baking with the current source matrix.
 */
export function setModelSourceTransform(nodeId, sourceLocalPosition, sourceLocalQuaternion, sourceLocalScale) {
  const node = state.get('nodeById')?.get(nodeId);
  if (!node || node.type !== 'model') return;

  const before = {
    sourceLocalPosition:   [...(node.sourceLocalPosition   || [0,0,0])],
    sourceLocalQuaternion: [...(node.sourceLocalQuaternion || [0,0,0,1])],
    sourceLocalScale:      [...(node.sourceLocalScale      || [1,1,1])],
  };

  const apply = (vals) => {
    node.sourceLocalPosition   = [...vals.sourceLocalPosition];
    node.sourceLocalQuaternion = [...vals.sourceLocalQuaternion];
    node.sourceLocalScale      = [...vals.sourceLocalScale];
    const obj = steps.object3dById?.get(nodeId);
    applyNodeSourceTransformToObject3D(node, obj, steps.object3dById);
    state.markDirty();
  };

  const after = {
    sourceLocalPosition:   [...sourceLocalPosition],
    sourceLocalQuaternion: [...sourceLocalQuaternion],
    sourceLocalScale:      [...sourceLocalScale],
  };

  apply(after);

  undoManager.push(
    `Model source transform "${node.name || 'model'}"`,
    () => apply(before),
    () => apply(after),
  );
}

/**
 * Preview-only variant of setModelSourceTransform — writes node fields and
 * bakes geometry, but does NOT push an undo entry. Used by the model source
 * dialog while the user types: every keystroke applies a live preview, and
 * the user clicks Apply (which calls setModelSourceTransform) to commit a
 * single undo entry covering the whole edit session. See
 * model-source-dialog.js for the full preview/commit/cancel lifecycle.
 */
export function previewModelSourceTransform(nodeId, sourceLocalPosition, sourceLocalQuaternion, sourceLocalScale) {
  const node = state.get('nodeById')?.get(nodeId);
  if (!node || node.type !== 'model') return;
  node.sourceLocalPosition   = [...sourceLocalPosition];
  node.sourceLocalQuaternion = [...sourceLocalQuaternion];
  node.sourceLocalScale      = [...sourceLocalScale];
  const obj = steps.object3dById?.get(nodeId);
  applyNodeSourceTransformToObject3D(node, obj, steps.object3dById);
  state.markDirty();
}

// ═══════════════════════════════════════════════════════════════════════════
//  CAMERA TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════
// Templates live in state.cameraViews. Steps reference them by id via
// step.cameraBinding = { mode: 'template', templateId }. Editing a template
// implicitly moves every bound step (steps.activateStep resolves cameras
// through the binding at activation time).

const CAMERA_FIELDS = ['position', 'quaternion', 'pivot', 'up', 'fov'];

function _captureCameraState() {
  // Snapshot just the fields a CameraView holds. Avoids leaking unrelated
  // state from sceneCore.getCameraState() into the saved template.
  const cs = sceneCore.getCameraState();
  const out = {};
  for (const k of CAMERA_FIELDS) out[k] = cs[k];
  return out;
}

/**
 * Create a new camera template from the CURRENT viewport state.
 * Does NOT auto-bind any step — the user opts steps in via the per-step
 * camera dropdown, or via updateCameraTemplate (which auto-binds the
 * active step).
 */
export function createCameraTemplate(name) {
  const cleanName = (name || '').trim() || `Camera ${(state.get('cameraViews')?.length ?? 0) + 1}`;
  const view = createCameraView({ name: cleanName, ..._captureCameraState() });
  const before = state.get('cameraViews') || [];
  state.setState({ cameraViews: [...before, view] });
  state.markDirty();

  undoManager.push(
    `Add camera "${cleanName}"`,
    () => { state.setState({ cameraViews: before }); state.markDirty(); },
    () => { state.setState({ cameraViews: [...before, view] }); state.markDirty(); },
  );
  return view.id;
}

/**
 * Rename a template. Step bindings reference id only, so no propagation.
 */
export function renameCameraTemplate(templateId, name) {
  const views = state.get('cameraViews') || [];
  const i = views.findIndex(v => v.id === templateId);
  if (i < 0) return;
  const oldName = views[i].name;
  const newName = (name || '').trim();
  if (!newName || newName === oldName) return;
  const next = views.map((v, idx) => idx === i ? { ...v, name: newName } : v);
  state.setState({ cameraViews: next });
  state.markDirty();
  undoManager.push(
    `Rename camera "${oldName}" → "${newName}"`,
    () => { state.setState({ cameraViews: views });        state.markDirty(); },
    () => { state.setState({ cameraViews: next });          state.markDirty(); },
  );
}

/**
 * Update a template's camera state to the CURRENT viewport.
 * Side-effect: auto-binds the active step to this template if it
 * isn't already bound somewhere — so pressing Update on a card both
 * captures the view AND adopts the active step into that camera.
 *
 * Every other step already bound to this template follows automatically
 * because they look the template up at activate time — no rewrite of
 * their snapshots needed (template-delta semantics).
 */
export function updateCameraTemplate(templateId) {
  const views = state.get('cameraViews') || [];
  const i = views.findIndex(v => v.id === templateId);
  if (i < 0) return;

  const beforeView = views[i];
  const afterView  = { ...beforeView, ..._captureCameraState() };
  const nextViews  = views.map((v, idx) => idx === i ? afterView : v);

  // Auto-bind the active step if free (or bound to a different template).
  const activeId = state.get('activeStepId');
  const allSteps = state.get('steps') || [];
  const stepIdx  = activeId ? allSteps.findIndex(s => s.id === activeId) : -1;

  let prevBinding = null;
  let nextStepsArr = allSteps;
  if (stepIdx >= 0) {
    const step = allSteps[stepIdx];
    prevBinding = step.cameraBinding ? { ...step.cameraBinding } : { mode: 'free', templateId: null };
    if (prevBinding.mode !== 'template' || prevBinding.templateId !== templateId) {
      const newBinding = { mode: 'template', templateId };
      nextStepsArr = allSteps.map((s, idx) => idx === stepIdx
        ? { ...s, cameraBinding: newBinding }
        : s,
      );
    }
  }

  state.setState({ cameraViews: nextViews, steps: nextStepsArr });
  state.markDirty();

  undoManager.push(
    `Update camera "${beforeView.name}"`,
    () => {
      state.setState({ cameraViews: views, steps: allSteps });
      state.markDirty();
    },
    () => {
      state.setState({ cameraViews: nextViews, steps: nextStepsArr });
      state.markDirty();
    },
  );
}

/**
 * Delete a template. Steps bound to it are migrated according to
 * `replacement`:
 *   replacement = null     → become free, snapshot.camera seeded from
 *                            the deleted template's last state (no view
 *                            jump on next activation)
 *   replacement = '<id>'   → re-bind to that template
 *
 * The migration is part of the same undo entry — undo restores the
 * template AND every affected step's prior binding.
 */
export function deleteCameraTemplate(templateId, replacement = null) {
  const views    = state.get('cameraViews') || [];
  const tpl      = views.find(v => v.id === templateId);
  if (!tpl) return;
  const allSteps = state.get('steps') || [];

  // Resolve replacement validity. A bad id just falls back to free.
  const repl = replacement && views.some(v => v.id === replacement && v.id !== templateId)
    ? replacement
    : null;

  const tplCamSnapshot = {
    position:   tpl.position,
    quaternion: tpl.quaternion,
    pivot:      tpl.pivot,
    up:         tpl.up,
    fov:        tpl.fov,
  };

  const nextViews = views.filter(v => v.id !== templateId);
  const nextSteps = allSteps.map(s => {
    const b = s.cameraBinding;
    if (b?.mode !== 'template' || b.templateId !== templateId) return s;
    if (repl) {
      return { ...s, cameraBinding: { mode: 'template', templateId: repl } };
    }
    // Convert to free, seed snapshot.camera with the template's last state
    // so the visible framing stays put on the next activation.
    return {
      ...s,
      cameraBinding: { mode: 'free', templateId: null },
      snapshot: { ...(s.snapshot || {}), camera: { ...tplCamSnapshot } },
    };
  });

  state.setState({ cameraViews: nextViews, steps: nextSteps });
  state.markDirty();

  undoManager.push(
    `Delete camera "${tpl.name}"`,
    () => { state.setState({ cameraViews: views,    steps: allSteps }); state.markDirty(); },
    () => { state.setState({ cameraViews: nextViews, steps: nextSteps }); state.markDirty(); },
  );
}

/**
 * Bind a step's camera to a template, OR set it to free.
 * `templateId = null` (or 'free') → free camera mode.
 *
 * Free-mode binding does NOT modify step.snapshot.camera — the existing
 * snapshot keeps driving until the user explicitly updates it. This
 * means: switching template→free shows the snapshot's camera (which may
 * or may not match what the template was showing). To "freeze" the
 * template's current view as the new free snapshot, see saveStepCameraFromCurrent.
 */
export function setStepCameraBinding(stepId, templateId) {
  const allSteps = state.get('steps') || [];
  const idx      = allSteps.findIndex(s => s.id === stepId);
  if (idx < 0) return;
  const step       = allSteps[idx];
  const prev       = step.cameraBinding ? { ...step.cameraBinding } : { mode: 'free', templateId: null };
  const newBinding = templateId
    ? { mode: 'template', templateId }
    : { mode: 'free', templateId: null };

  if (prev.mode === newBinding.mode && prev.templateId === newBinding.templateId) return;

  const nextSteps = allSteps.map((s, i) => i === idx ? { ...s, cameraBinding: newBinding } : s);
  state.setState({ steps: nextSteps });
  state.markDirty();

  // Re-apply the active step so the new binding takes effect immediately.
  if (state.get('activeStepId') === stepId) {
    steps.activateStep(stepId, false);
  }

  const prevSteps = allSteps;
  undoManager.push(
    'Change step camera binding',
    () => { state.setState({ steps: prevSteps });  state.markDirty(); if (state.get('activeStepId') === stepId) steps.activateStep(stepId, false); },
    () => { state.setState({ steps: nextSteps }); state.markDirty(); if (state.get('activeStepId') === stepId) steps.activateStep(stepId, false); },
  );
}

/**
 * Bind a set of steps to the same camera (template id, or null for free).
 * Single undo entry covers them all. Used by multi-select dropdowns.
 */
export function setStepCameraBindingMulti(stepIds, templateId) {
  if (!stepIds?.length) return;
  const allSteps   = state.get('steps') || [];
  const idSet      = new Set(stepIds);
  const newBinding = templateId
    ? { mode: 'template', templateId }
    : { mode: 'free', templateId: null };
  const nextSteps  = allSteps.map(s => idSet.has(s.id) ? { ...s, cameraBinding: { ...newBinding } } : s);
  // Skip if nothing actually changed.
  if (nextSteps.every((s, i) => s === allSteps[i])) return;

  state.setState({ steps: nextSteps });
  state.markDirty();
  if (idSet.has(state.get('activeStepId'))) {
    steps.activateStep(state.get('activeStepId'), false);
  }

  undoManager.push(
    `Change camera on ${stepIds.length} step(s)`,
    () => {
      state.setState({ steps: allSteps }); state.markDirty();
      if (idSet.has(state.get('activeStepId'))) steps.activateStep(state.get('activeStepId'), false);
    },
    () => {
      state.setState({ steps: nextSteps }); state.markDirty();
      if (idSet.has(state.get('activeStepId'))) steps.activateStep(state.get('activeStepId'), false);
    },
  );
}

/**
 * Step-level "Update camera" — undoable wrapper around steps.saveStepCamera.
 * Always converts the step to free-camera with the current view, regardless
 * of any prior template binding.
 */
export function updateStepCameraFromCurrent(stepId) {
  const id = stepId ?? state.get('activeStepId');
  if (!id) return;
  const allSteps = state.get('steps') || [];
  const idx      = allSteps.findIndex(s => s.id === id);
  if (idx < 0) return;
  const prev     = allSteps[idx];

  // Build the next step with new camera + free binding.
  const next = {
    ...prev,
    snapshot:      { ...(prev.snapshot || {}), camera: _captureCameraState() },
    cameraBinding: { mode: 'free', templateId: null },
  };
  const nextSteps = allSteps.map((s, i) => i === idx ? next : s);

  state.setState({ steps: nextSteps });
  state.markDirty();
  state.emit('step:synced', next);

  undoManager.push(
    `Update camera on "${prev.name}"`,
    () => { state.setState({ steps: allSteps });  state.markDirty(); state.emit('step:synced', prev); },
    () => { state.setState({ steps: nextSteps }); state.markDirty(); state.emit('step:synced', next); },
  );
}

/**
 * "Update camera as template" — bundle action.
 *
 * Resolves the template `templateId` from the active step's binding
 * (or accepts an explicit one), updates that template to the CURRENT
 * view, and binds every step in `stepIds` to it. Single undo entry
 * covers the template state delta AND every binding change.
 *
 * If no template can be resolved (active step is free and no explicit
 * id was passed), this is a no-op — the right-click menu should keep
 * the entry disabled in that state.
 */
export function updateStepCameraAsTemplate(stepIds, templateId = null) {
  if (!stepIds?.length) return;

  // Resolve the target template — explicit arg, then active-step binding.
  let resolvedId = templateId;
  if (!resolvedId) {
    const allSteps = state.get('steps') || [];
    const activeId = state.get('activeStepId');
    const active   = activeId ? allSteps.find(s => s.id === activeId) : null;
    if (active?.cameraBinding?.mode === 'template' && active.cameraBinding.templateId) {
      resolvedId = active.cameraBinding.templateId;
    }
  }
  if (!resolvedId) return;

  const beforeViews = state.get('cameraViews') || [];
  const i = beforeViews.findIndex(v => v.id === resolvedId);
  if (i < 0) return;

  const beforeSteps = state.get('steps') || [];
  const idSet       = new Set(stepIds);
  const cam         = _captureCameraState();

  const afterViews = beforeViews.map((v, idx) => idx === i ? { ...v, ...cam } : v);
  const afterSteps = beforeSteps.map(s => idSet.has(s.id)
    ? { ...s, cameraBinding: { mode: 'template', templateId: resolvedId } }
    : s,
  );
  if (afterViews.every((v, j) => v === beforeViews[j]) &&
      afterSteps.every((s, j) => s === beforeSteps[j])) return;

  state.setState({ cameraViews: afterViews, steps: afterSteps });
  state.markDirty();
  if (idSet.has(state.get('activeStepId'))) {
    steps.activateStep(state.get('activeStepId'), false);
  }

  const tplName = beforeViews[i].name;
  undoManager.push(
    `Update camera "${tplName}" on ${stepIds.length} step(s)`,
    () => {
      state.setState({ cameraViews: beforeViews, steps: beforeSteps });
      state.markDirty();
      if (idSet.has(state.get('activeStepId'))) steps.activateStep(state.get('activeStepId'), false);
    },
    () => {
      state.setState({ cameraViews: afterViews, steps: afterSteps });
      state.markDirty();
      if (idSet.has(state.get('activeStepId'))) steps.activateStep(state.get('activeStepId'), false);
    },
  );
}

/**
 * Multi-step "Update camera" — applies the current view as a free-camera
 * snapshot to every selected step. One undo entry.
 */
export function updateStepCameraFromCurrentMulti(stepIds) {
  if (!stepIds?.length) return;
  const allSteps = state.get('steps') || [];
  const idSet    = new Set(stepIds);
  const cam      = _captureCameraState();
  const nextSteps = allSteps.map(s => idSet.has(s.id)
    ? {
        ...s,
        snapshot:      { ...(s.snapshot || {}), camera: { ...cam } },
        cameraBinding: { mode: 'free', templateId: null },
      }
    : s,
  );
  if (nextSteps.every((s, i) => s === allSteps[i])) return;

  state.setState({ steps: nextSteps });
  state.markDirty();

  undoManager.push(
    `Update camera on ${stepIds.length} step(s)`,
    () => { state.setState({ steps: allSteps });  state.markDirty(); },
    () => { state.setState({ steps: nextSteps }); state.markDirty(); },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  SELECTION GROUPS
// ═══════════════════════════════════════════════════════════════════════════
//
// A selection group is a NAMED, COLOR-TAGGED list of node IDs (any type:
// mesh / folder / model). Saved with the project under
// project.selections.groups. CRUD actions all push undo entries so the
// group list stays in lockstep with global history. Loading a group
// (writing the saved IDs into multiSelectedIds) is intentionally NOT
// undoable — selection is UI state, not data.
//
// Phase B will add cross-step ops (mass show/hide/etc.) that take a
// group id + a step-id set and dispatch on op.kind. This file holds
// the data layer; the Select tab UI lives in sidebar-left.js.

const SEL_GROUP_PALETTE = [
  '#ef4444', '#22c55e', '#3b82f6', '#eab308',
  '#a855f7', '#14b8a6', '#f97316', '#ec4899',
];

function _getSelectionGroups() {
  return state.get('selectionGroups') || [];
}

function _setSelectionGroups(next) {
  state.setState({ selectionGroups: next });
  state.markDirty();
}

function _captureGroupsSnapshot() {
  // Deep-clone via JSON for the undo before/after — selection groups are
  // tiny plain-data so this is cheap and avoids accidental aliasing.
  return JSON.parse(JSON.stringify(_getSelectionGroups()));
}

/**
 * Create a new selection group from the current multi-selection (or an
 * explicit ids list). Returns the new group's id, or null if there's
 * nothing to save.
 */
export function createSelectionGroup({ name, ids, color } = {}) {
  const sourceIds = Array.isArray(ids) ? ids.slice() : [...(state.get('multiSelectedIds') || [])];
  if (sourceIds.length === 0) return null;
  const before = _captureGroupsSnapshot();
  const next   = before.slice();
  const group  = {
    id:    generateId('selgrp'),
    name:  (name && name.trim()) || `Group ${next.length + 1}`,
    ids:   sourceIds.filter(id => typeof id === 'string'),
    color: color || SEL_GROUP_PALETTE[next.length % SEL_GROUP_PALETTE.length],
  };
  next.push(group);
  _setSelectionGroups(next);
  undoManager.push(
    `Save selection group "${group.name}"`,
    () => _setSelectionGroups(before),
    () => _setSelectionGroups(next),
  );
  return group.id;
}

/**
 * Overwrite an existing group's ids from the current multi-selection
 * (or an explicit list). Skips if the group doesn't exist or the new
 * id list matches.
 */
export function updateSelectionGroup(groupId, { ids } = {}) {
  const before = _captureGroupsSnapshot();
  const idx = before.findIndex(g => g.id === groupId);
  if (idx < 0) return false;
  const newIds = Array.isArray(ids) ? ids.slice() : [...(state.get('multiSelectedIds') || [])];
  const filtered = newIds.filter(id => typeof id === 'string');
  if (JSON.stringify(filtered) === JSON.stringify(before[idx].ids)) return false;
  const next = before.slice();
  next[idx] = { ...next[idx], ids: filtered };
  _setSelectionGroups(next);
  undoManager.push(
    `Update selection group "${next[idx].name}"`,
    () => _setSelectionGroups(before),
    () => _setSelectionGroups(next),
  );
  return true;
}

/**
 * Rename a group. Trims the input; no-op if the name is empty or
 * unchanged.
 */
export function renameSelectionGroup(groupId, newName) {
  const trimmed = (newName ?? '').trim();
  if (!trimmed) return false;
  const before = _captureGroupsSnapshot();
  const idx = before.findIndex(g => g.id === groupId);
  if (idx < 0) return false;
  if (before[idx].name === trimmed) return false;
  const next = before.slice();
  next[idx] = { ...next[idx], name: trimmed };
  _setSelectionGroups(next);
  undoManager.push(
    `Rename selection group → "${trimmed}"`,
    () => _setSelectionGroups(before),
    () => _setSelectionGroups(next),
  );
  return true;
}

/**
 * Update the color swatch on a group. Color is a hex string ("#rrggbb").
 */
export function recolorSelectionGroup(groupId, newColor) {
  if (typeof newColor !== 'string') return false;
  const before = _captureGroupsSnapshot();
  const idx = before.findIndex(g => g.id === groupId);
  if (idx < 0) return false;
  if (before[idx].color === newColor) return false;
  const next = before.slice();
  next[idx] = { ...next[idx], color: newColor };
  _setSelectionGroups(next);
  undoManager.push(
    `Recolor selection group "${next[idx].name}"`,
    () => _setSelectionGroups(before),
    () => _setSelectionGroups(next),
  );
  return true;
}

export function deleteSelectionGroup(groupId) {
  const before = _captureGroupsSnapshot();
  const idx = before.findIndex(g => g.id === groupId);
  if (idx < 0) return false;
  const next = before.slice();
  const removed = next.splice(idx, 1)[0];
  _setSelectionGroups(next);
  undoManager.push(
    `Delete selection group "${removed.name}"`,
    () => _setSelectionGroups(before),
    () => _setSelectionGroups(next),
  );
  return true;
}

/**
 * Push a group's saved ids into the live multi-selection. Filters out
 * stale ids (nodes that no longer exist). NOT undoable — selection is
 * UI state, not project data.
 */
export function loadSelectionGroup(groupId) {
  const group = _getSelectionGroups().find(g => g.id === groupId);
  if (!group) return false;
  const nodeById = state.get('nodeById');
  const live = (group.ids || []).filter(id => nodeById?.has(id));
  if (live.length === 0) {
    state.clearSelection();
    return false;
  }
  state.setSelection(live[0], new Set(live));
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════
//  NOTES (3D-anchored balloon notes — tree children of their anchor mesh)
// ═══════════════════════════════════════════════════════════════════════════
//
// Lifecycle:
//   1. startNotePicking(meshId)   — enters face-pick mode for that mesh.
//      The next viewport pointerdown raycasts; on a hit on THIS mesh,
//      a new note is created at the hit point and the user enters
//      inline-text-edit mode for it.
//   2. cancelNotePicking()        — leaves picking mode silently.
//   3. createNoteAtHit(meshId, hit) — direct creation, used by the
//      pick-mode pointerdown handler (lives in main.js, mirroring the
//      pivot snap-to-surface flow).
//   4. editNoteText(noteId, text) — undoable rename.
//   5. setNotePanelOffset(noteId, offset) — one-shot undoable write
//      (pair via _commitNotePanelOffset for drag-style commits).
//   6. setNoteSizePreset / setNoteCustomFontSize — undoable.
//   7. deleteNote(noteId)         — undoable; removes note from tree.

export function startNotePicking(meshId) {
  if (!meshId) return;
  if (_isArchived(meshId)) return;
  // Don't co-exist with a reposition pick.
  if (state.get('noteRepositioningId')) cancelNoteRepositioning();
  state.setState({ notePickingMeshId: meshId });
}

export function cancelNotePicking() {
  if (state.get('notePickingMeshId')) {
    state.setState({ notePickingMeshId: null });
  }
}

/**
 * Enter "reposition this note" face-pick mode. The next viewport click
 * on any mesh face moves the note's anchor there and re-parents it in
 * the tree. Click on empty space cancels.
 */
export function startNoteRepositioning(noteId) {
  if (!noteId) return;
  if (state.get('notePickingMeshId')) cancelNotePicking();
  state.setState({ noteRepositioningId: noteId });
}

export function cancelNoteRepositioning() {
  if (state.get('noteRepositioningId')) {
    state.setState({ noteRepositioningId: null });
  }
}

/**
 * Move an existing note's anchor to a fresh raycast hit. Called from
 * main.js's pointerdown intercept while state.noteRepositioningId is
 * set. Updates anchorMeshId / anchorLocal / anchorBboxRelative AND
 * re-parents the note in the tree (note nodes always live as direct
 * children of their anchor mesh). Single undo entry covers the whole
 * gesture, including the tree reparent.
 */
export function repositionNoteAtHit(noteId, hit) {
  if (!noteId || !hit?.point || !hit?.object) return false;
  const T = window.THREE;
  const newMeshId = hit.object.userData?.meshNodeId;
  if (!newMeshId) return false;

  const root      = state.get('treeData');
  const nb        = state.get('nodeById');
  const note      = nb?.get(noteId);
  const newMesh   = nb?.get(newMeshId);
  if (!note || note.type !== 'note') return false;
  if (!newMesh || newMesh.type !== 'mesh') return false;

  // Refresh world matrix on the target mesh so worldToLocal returns
  // the correct point in mesh-local frame regardless of step state.
  const newObj = steps.object3dById?.get(newMeshId);
  if (!newObj) return false;
  newObj.updateMatrixWorld(true);
  const local = newObj.worldToLocal(hit.point.clone());

  // bbox-relative fallback for missing-asset resilience.
  let rel = [0.5, 0.5, 0.5];
  const bb = newMesh.bbox;
  if (bb && Array.isArray(bb.min) && Array.isArray(bb.max)) {
    const wx = Math.max(bb.max[0] - bb.min[0], 1e-6);
    const wy = Math.max(bb.max[1] - bb.min[1], 1e-6);
    const wz = Math.max(bb.max[2] - bb.min[2], 1e-6);
    rel = [
      (local.x - bb.min[0]) / wx,
      (local.y - bb.min[1]) / wy,
      (local.z - bb.min[2]) / wz,
    ];
  }

  // Capture full BEFORE state for undo.
  const oldMeshId = note.anchorMeshId;
  const oldMesh   = nb?.get(oldMeshId);
  const before = {
    anchorMeshId:       note.anchorMeshId,
    anchorLocal:        [...(note.anchorLocal || [0, 0, 0])],
    anchorBboxRelative: [...(note.anchorBboxRelative || [0.5, 0.5, 0.5])],
    parentId:           oldMeshId,
  };
  const after = {
    anchorMeshId:       newMeshId,
    anchorLocal:        [local.x, local.y, local.z],
    anchorBboxRelative: rel,
    parentId:           newMeshId,
  };

  const apply = (vals) => {
    const noteN = state.get('nodeById')?.get(noteId);
    if (!noteN) return;
    // Clear reposition mode at the same time as the apply so a redo
    // doesn't leave the user trapped in pick mode.
    state.setState({ noteRepositioningId: null });
    noteN.anchorMeshId       = vals.anchorMeshId;
    noteN.anchorLocal        = [...vals.anchorLocal];
    noteN.anchorBboxRelative = [...vals.anchorBboxRelative];
    // Re-parent in the live tree if anchor mesh changed.
    if (vals.parentId && vals.parentId !== _findNodeParent(state.get('treeData'), noteId)?.id) {
      _reparentNote(state.get('treeData'), noteId, vals.parentId);
      state.setState({ nodeById: _nodes_buildNodeMap(state.get('treeData')) });
    }
    state.emit('change:treeData', state.get('treeData'));
    state.markDirty();
  };
  apply(after);

  undoManager.push(
    'Reposition note',
    () => apply(before),
    () => apply(after),
  );
  void oldMesh;
  return true;
}

function _reparentNote(root, noteId, newParentId) {
  if (!root) return;
  // Find current parent + remove from its children.
  const oldParent = _findNodeParent(root, noteId);
  if (!oldParent) return;
  const idx = (oldParent.children || []).findIndex(c => c.id === noteId);
  if (idx < 0) return;
  const [note] = oldParent.children.splice(idx, 1);
  // Append to new parent.
  const newParent = _findNodeRecursiveLocal(root, newParentId);
  if (newParent && newParent.type === 'mesh') {
    newParent.children = [...(newParent.children || []), note];
  } else {
    // Fallback — restore to original spot if the new parent is gone.
    oldParent.children.splice(idx, 0, note);
  }
}

function _findNodeRecursiveLocal(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of (node.children || [])) {
    const r = _findNodeRecursiveLocal(c, id);
    if (r) return r;
  }
  return null;
}

/**
 * Create a note at a raycast hit. Called from main.js's pointerdown
 * intercept while state.notePickingMeshId is set. Anchors at the hit
 * point in MESH-LOCAL space and ALSO records a bbox-relative position
 * so the note survives the asset going missing later.
 */
export function createNoteAtHit(meshId, hit) {
  if (!hit?.point || !hit?.object || !meshId) return null;
  if (_isArchived(meshId)) return null;
  const T = window.THREE;
  const meshNode = state.get('nodeById')?.get(meshId);
  if (!meshNode || meshNode.type !== 'mesh') return null;
  const obj = steps.object3dById?.get(meshId);
  if (!obj) return null;

  // Force the world matrix fresh — Three.js's worldToLocal uses
  // matrixWorld AS-IS without refreshing it, and after a step change
  // the cached matrix may be stale. Without this, the note's
  // anchorLocal lands at the wrong point on the mesh.
  obj.updateMatrixWorld(true);
  // Hit point in MESH-LOCAL.
  const local = obj.worldToLocal(hit.point.clone());
  // bbox-relative — falls back to (0.5, 0.5, 0.5) if no bbox saved.
  let rel = [0.5, 0.5, 0.5];
  const bb = meshNode.bbox;
  if (bb && Array.isArray(bb.min) && Array.isArray(bb.max)) {
    const wx = Math.max(bb.max[0] - bb.min[0], 1e-6);
    const wy = Math.max(bb.max[1] - bb.min[1], 1e-6);
    const wz = Math.max(bb.max[2] - bb.min[2], 1e-6);
    rel = [
      (local.x - bb.min[0]) / wx,
      (local.y - bb.min[1]) / wy,
      (local.z - bb.min[2]) / wz,
    ];
  }

  const note = createNoteNode({
    anchorMeshId:       meshId,
    anchorLocal:        [local.x, local.y, local.z],
    anchorBboxRelative: rel,
    text:               'Note',
  });
  // Append as child of the mesh in the tree.
  meshNode.children = [...(meshNode.children || []), note];
  state.setState({
    nodeById:           _nodes_buildNodeMap(state.get('treeData')),
    notePickingMeshId:  null,
  });
  state.emit('change:treeData', state.get('treeData'));
  state.markDirty();

  undoManager.push(
    'Add note',
    () => {
      const nb = state.get('nodeById');
      const m  = nb?.get(meshId);
      if (m) m.children = (m.children || []).filter(c => c.id !== note.id);
      state.setState({ nodeById: _nodes_buildNodeMap(state.get('treeData')) });
      state.emit('change:treeData', state.get('treeData'));
      state.markDirty();
    },
    () => {
      const nb = state.get('nodeById');
      const m  = nb?.get(meshId);
      if (!m) return;
      if (!(m.children || []).some(c => c.id === note.id)) {
        m.children = [...(m.children || []), note];
      }
      state.setState({ nodeById: _nodes_buildNodeMap(state.get('treeData')) });
      state.emit('change:treeData', state.get('treeData'));
      state.markDirty();
    },
  );
  return note.id;
}

export function editNoteText(noteId, newText) {
  const nb = state.get('nodeById');
  const note = nb?.get(noteId);
  if (!note || note.type !== 'note') return;
  const before = note.text || '';
  const after  = (newText ?? '').toString();
  if (before === after) return;
  note.text = after;
  state.emit('change:treeData', state.get('treeData'));
  state.markDirty();
  undoManager.push(
    'Edit note text',
    () => {
      const n = state.get('nodeById')?.get(noteId);
      if (n) { n.text = before; state.emit('change:treeData', state.get('treeData')); state.markDirty(); }
    },
    () => {
      const n = state.get('nodeById')?.get(noteId);
      if (n) { n.text = after;  state.emit('change:treeData', state.get('treeData')); state.markDirty(); }
    },
  );
}

export function setNoteSizePreset(noteId, presetId) {
  const note = state.get('nodeById')?.get(noteId);
  if (!note || note.type !== 'note') return;
  const before = { sizePresetId: note.sizePresetId, customFontSize: note.customFontSize };
  if (note.sizePresetId === presetId && note.customFontSize === null) return;
  note.sizePresetId   = presetId;
  note.customFontSize = null;
  state.emit('change:treeData', state.get('treeData'));
  state.markDirty();
  undoManager.push(
    'Note size preset',
    () => {
      const n = state.get('nodeById')?.get(noteId); if (!n) return;
      n.sizePresetId = before.sizePresetId; n.customFontSize = before.customFontSize;
      state.emit('change:treeData', state.get('treeData')); state.markDirty();
    },
    () => {
      const n = state.get('nodeById')?.get(noteId); if (!n) return;
      n.sizePresetId = presetId; n.customFontSize = null;
      state.emit('change:treeData', state.get('treeData')); state.markDirty();
    },
  );
}

export function setNoteCustomFontSize(noteId, px) {
  const note = state.get('nodeById')?.get(noteId);
  if (!note || note.type !== 'note') return;
  // V0.2.22.18 — Number.isFinite + explicit fallback. `|| 16` coerced
  // a user-typed 0 to 16; the Math.max/min clamp handles the legitimate
  // range — we just need a real number going in.
  const _v = Number(px);
  const size = Math.max(5, Math.min(150, Number.isFinite(_v) ? _v : 16));
  const before = { sizePresetId: note.sizePresetId, customFontSize: note.customFontSize };
  if (before.customFontSize === size) return;
  note.customFontSize = size;
  state.emit('change:treeData', state.get('treeData'));
  state.markDirty();
  undoManager.push(
    'Note custom size',
    () => {
      const n = state.get('nodeById')?.get(noteId); if (!n) return;
      n.sizePresetId = before.sizePresetId; n.customFontSize = before.customFontSize;
      state.emit('change:treeData', state.get('treeData')); state.markDirty();
    },
    () => {
      const n = state.get('nodeById')?.get(noteId); if (!n) return;
      n.customFontSize = size;
      state.emit('change:treeData', state.get('treeData')); state.markDirty();
    },
  );
}

/**
 * Internal — used by notes-render's drag handler at pointerup, after
 * it has already mutated note.panelOffset live during the drag. We
 * just push a single undo entry covering the whole gesture.
 */
export function _commitNotePanelOffset(noteId, before, after) {
  if (!noteId || !before || !after) return;
  const note = state.get('nodeById')?.get(noteId);
  if (!note) return;
  note.panelOffset = { x: after.x, y: after.y };
  state.markDirty();
  // Capture into the active step's snapshot.notePanelOffsets so the
  // new offset persists per-step. Without this, dragging a balloon
  // would only affect the live state and the next step nav would
  // overwrite it with the destination step's saved offset.
  steps.scheduleSync();
  undoManager.push(
    'Move note',
    () => {
      const n = state.get('nodeById')?.get(noteId);
      if (n) {
        n.panelOffset = { x: before.x, y: before.y };
        state.markDirty();
        steps.scheduleSync();
      }
    },
    () => {
      const n = state.get('nodeById')?.get(noteId);
      if (n) {
        n.panelOffset = { x: after.x,  y: after.y  };
        state.markDirty();
        steps.scheduleSync();
      }
    },
  );
}

/**
 * Commit a note framePosition change (drag commit).
 * framePosition = { x, y } as fractions (0..1) of the safe-frame rect.
 * Mirrors _commitNotePanelOffset but for the new frame-relative model.
 */
export function _commitNoteFramePosition(noteId, before, after) {
  if (!noteId || !before || !after) return;
  const note = state.get('nodeById')?.get(noteId);
  if (!note) return;
  note.framePosition = { x: after.x, y: after.y };
  state.markDirty();
  steps.scheduleSync();
  undoManager.push(
    'Move note',
    () => {
      const n = state.get('nodeById')?.get(noteId);
      if (n) {
        n.framePosition = { x: before.x, y: before.y };
        state.markDirty();
        steps.scheduleSync();
      }
    },
    () => {
      const n = state.get('nodeById')?.get(noteId);
      if (n) {
        n.framePosition = { x: after.x,  y: after.y  };
        state.markDirty();
        steps.scheduleSync();
      }
    },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  NOTE TEMPLATES (Library)
// ═══════════════════════════════════════════════════════════════════════════
//
// Templates own SHARED content (text + size). Note instances reference a
// template via note.templateId; render reads text/size from the template
// when set, falling back to the instance's own text/size otherwise.
// Position (framePosition / panelOffset) and visibility remain per-instance.

function _autoTemplateName(templates) {
  let n = templates.length + 1;
  const taken = new Set(templates.map(t => t.name));
  while (taken.has(`Template ${n}`)) n++;
  return `Template ${n}`;
}

export function createNewNoteTemplate(initial = {}) {
  const list = (state.get('noteTemplates') || []).slice();
  const tpl = createNoteTemplate({
    name: initial.name || _autoTemplateName(list),
    text: initial.text || '',
    sizePresetId:   initial.sizePresetId   || 'medium',
    customFontSize: initial.customFontSize ?? null,
  });
  list.push(tpl);
  state.setState({ noteTemplates: list });
  state.markDirty();
  undoManager.push(
    'New note template',
    () => {
      state.setState({ noteTemplates: (state.get('noteTemplates') || []).filter(t => t.id !== tpl.id) });
      state.markDirty();
    },
    () => {
      const cur = state.get('noteTemplates') || [];
      if (!cur.some(t => t.id === tpl.id)) {
        state.setState({ noteTemplates: [...cur, tpl] });
        state.markDirty();
      }
    },
  );
  return tpl.id;
}

function _patchTemplate(id, patch, label) {
  const list = state.get('noteTemplates') || [];
  const before = list.find(t => t.id === id);
  if (!before) return;
  const after = { ...before, ...patch };
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  state.setState({
    noteTemplates: list.map(t => t.id === id ? after : t),
  });
  state.markDirty();
  state.emit('change:treeData', state.get('treeData'));   // re-render notes
  undoManager.push(
    label,
    () => {
      const cur = state.get('noteTemplates') || [];
      state.setState({ noteTemplates: cur.map(t => t.id === id ? before : t) });
      state.markDirty();
      state.emit('change:treeData', state.get('treeData'));
    },
    () => {
      const cur = state.get('noteTemplates') || [];
      state.setState({ noteTemplates: cur.map(t => t.id === id ? after : t) });
      state.markDirty();
      state.emit('change:treeData', state.get('treeData'));
    },
  );
}

export function updateNoteTemplateText(id, newText) {
  _patchTemplate(id, { text: (newText ?? '').toString() }, 'Edit template text');
}

export function setNoteTemplateSize(id, sizePresetId, customFontSize = null) {
  _patchTemplate(id, { sizePresetId, customFontSize }, 'Edit template size');
}

export function renameNoteTemplate(id, newName) {
  _patchTemplate(id, { name: (newName ?? '').toString() }, 'Rename template');
}

/**
 * Duplicate a template. Auto-names the copy as "<base> (copy)" or
 * "<base> (copy 2)" / etc. so it doesn't collide with existing names.
 * Returns the new template's id.
 */
export function duplicateNoteTemplate(id) {
  const list = state.get('noteTemplates') || [];
  const src  = list.find(t => t.id === id);
  if (!src) return null;
  const base = (src.name || 'Template') + ' (copy)';
  const taken = new Set(list.map(t => t.name));
  let name = base;
  let n = 2;
  while (taken.has(name)) name = `${base} ${n++}`;
  const tpl = createNoteTemplate({
    name,
    text:           src.text,
    sizePresetId:   src.sizePresetId,
    customFontSize: src.customFontSize,
  });
  const next = [...list, tpl];
  state.setState({ noteTemplates: next });
  state.markDirty();
  state.emit('change:treeData', state.get('treeData'));
  undoManager.push(
    'Duplicate template',
    () => {
      state.setState({ noteTemplates: (state.get('noteTemplates') || []).filter(t => t.id !== tpl.id) });
      state.markDirty();
      state.emit('change:treeData', state.get('treeData'));
    },
    () => {
      const cur = state.get('noteTemplates') || [];
      if (!cur.some(t => t.id === tpl.id)) {
        state.setState({ noteTemplates: [...cur, tpl] });
        state.markDirty();
        state.emit('change:treeData', state.get('treeData'));
      }
    },
  );
  return tpl.id;
}

/**
 * Re-link every note instance currently bound to fromId so it points at
 * toId instead. The "from" template stays in the library (just becomes
 * orphaned). Single undo entry covers all reassignments.
 */
export function swapTemplateForAllInstances(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return 0;
  const list = state.get('noteTemplates') || [];
  if (!list.some(t => t.id === fromId) || !list.some(t => t.id === toId)) return 0;
  const nb = state.get('nodeById');
  if (!nb) return 0;
  const linked = [];
  for (const n of nb.values()) {
    if (n?.type === 'note' && n.templateId === fromId) linked.push(n);
  }
  if (!linked.length) return 0;
  const before = linked.map(n => ({ id: n.id, templateId: n.templateId }));
  for (const n of linked) n.templateId = toId;
  state.markDirty();
  state.emit('change:treeData', state.get('treeData'));
  undoManager.push(
    'Swap template for all instances',
    () => {
      const nb2 = state.get('nodeById');
      for (const b of before) {
        const n = nb2?.get(b.id);
        if (n) n.templateId = b.templateId;
      }
      state.markDirty();
      state.emit('change:treeData', state.get('treeData'));
    },
    () => {
      const nb2 = state.get('nodeById');
      for (const b of before) {
        const n = nb2?.get(b.id);
        if (n) n.templateId = toId;
      }
      state.markDirty();
      state.emit('change:treeData', state.get('treeData'));
    },
  );
  return linked.length;
}

/**
 * Auto-rename based on the template's text content. Uses the first 3
 * words (or shorter, if text is shorter). Empty text → no rename.
 */
export function renameNoteTemplateFromContent(id) {
  const list = state.get('noteTemplates') || [];
  const t = list.find(x => x.id === id);
  if (!t) return;
  const words = (t.text || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
  if (!words.length) return;
  renameNoteTemplate(id, words.join(' '));
}

/**
 * Delete a template. mode controls what happens to instances:
 *   'detach'   — convert each instance to a standalone note (copy current
 *                template text/size into the instance, clear templateId).
 *   'remove'   — delete each linked instance from the tree.
 * Default: 'detach' (no data loss).
 */
export function deleteNoteTemplate(id, mode = 'detach') {
  const list   = state.get('noteTemplates') || [];
  const tpl    = list.find(t => t.id === id);
  if (!tpl) return;
  const root   = state.get('treeData');
  const nb     = state.get('nodeById');
  const linked = [];
  if (nb) {
    for (const n of nb.values()) {
      if (n?.type === 'note' && n.templateId === id) linked.push(n);
    }
  }

  // Snapshot per-instance "before" data for undo.
  const beforeInstances = linked.map(n => ({
    id: n.id,
    text: n.text,
    sizePresetId: n.sizePresetId,
    customFontSize: n.customFontSize,
    templateId: n.templateId,
    parentId: _findNodeParent(root, n.id)?.id || null,
    indexInParent: (() => {
      const p = _findNodeParent(root, n.id);
      return p ? (p.children || []).findIndex(c => c.id === n.id) : -1;
    })(),
    nodeSnap: JSON.parse(JSON.stringify(n)),
  }));

  // Apply.
  if (mode === 'remove') {
    for (const inst of linked) {
      const parent = _findNodeParent(root, inst.id);
      if (parent) parent.children = (parent.children || []).filter(c => c.id !== inst.id);
    }
    state.setState({ nodeById: _nodes_buildNodeMap(root) });
  } else {
    // detach: copy template content into each instance, clear templateId.
    for (const inst of linked) {
      inst.text           = tpl.text;
      inst.sizePresetId   = tpl.sizePresetId;
      inst.customFontSize = tpl.customFontSize;
      inst.templateId     = null;
    }
  }
  state.setState({ noteTemplates: list.filter(t => t.id !== id) });
  state.emit('change:treeData', state.get('treeData'));
  state.markDirty();

  undoManager.push(
    'Delete template',
    () => {
      // Restore template + restore instance contents.
      const cur = state.get('noteTemplates') || [];
      state.setState({ noteTemplates: [...cur, tpl] });
      const r  = state.get('treeData');
      const nb2 = state.get('nodeById');
      if (mode === 'remove') {
        for (const b of beforeInstances) {
          const p = nb2?.get(b.parentId);
          if (p) {
            const kids = p.children || [];
            const exists = kids.some(c => c.id === b.id);
            if (!exists) {
              const insertAt = Math.min(b.indexInParent >= 0 ? b.indexInParent : kids.length, kids.length);
              p.children = [...kids.slice(0, insertAt), b.nodeSnap, ...kids.slice(insertAt)];
            }
          }
        }
        state.setState({ nodeById: _nodes_buildNodeMap(r) });
      } else {
        for (const b of beforeInstances) {
          const n = state.get('nodeById')?.get(b.id);
          if (n) {
            n.text           = b.text;
            n.sizePresetId   = b.sizePresetId;
            n.customFontSize = b.customFontSize;
            n.templateId     = b.templateId;
          }
        }
      }
      state.emit('change:treeData', state.get('treeData'));
      state.markDirty();
    },
    () => {
      // Re-apply delete.
      const cur = state.get('noteTemplates') || [];
      state.setState({ noteTemplates: cur.filter(t => t.id !== id) });
      const r = state.get('treeData');
      if (mode === 'remove') {
        for (const b of beforeInstances) {
          const p = _findNodeParent(r, b.id);
          if (p) p.children = (p.children || []).filter(c => c.id !== b.id);
        }
        state.setState({ nodeById: _nodes_buildNodeMap(r) });
      } else {
        for (const b of beforeInstances) {
          const n = state.get('nodeById')?.get(b.id);
          if (n) {
            n.text           = tpl.text;
            n.sizePresetId   = tpl.sizePresetId;
            n.customFontSize = tpl.customFontSize;
            n.templateId     = null;
          }
        }
      }
      state.emit('change:treeData', state.get('treeData'));
      state.markDirty();
    },
  );
}

/**
 * Enter "place template" face-pick mode. Cancels any other pick mode.
 * Cleared on Esc / selection change / on hit (placeNoteTemplateAtHit).
 */
export function startNoteTemplateInstantiation(templateId) {
  if (!templateId) return;
  cancelNotePicking();
  cancelNoteRepositioning();
  state.setState({ noteTemplateInstantiationId: templateId });
}

export function cancelNoteTemplateInstantiation() {
  if (state.get('noteTemplateInstantiationId')) {
    state.setState({ noteTemplateInstantiationId: null });
  }
}

/**
 * On a viewport pointerdown that hit a mesh while
 * noteTemplateInstantiationId is set: create a fresh note instance under
 * that mesh, with templateId set to the active template. Mirrors
 * createNoteAtHit but for template instantiation.
 */
export function placeNoteTemplateAtHit(templateId, hit) {
  if (!templateId || !hit?.point || !hit?.object) return false;
  const meshId = hit.object.userData?.meshNodeId;
  if (!meshId) return false;
  const root     = state.get('treeData');
  const nb       = state.get('nodeById');
  const meshNode = nb?.get(meshId);
  if (!meshNode || meshNode.type !== 'mesh') return false;

  const obj = steps.object3dById?.get(meshId);
  if (!obj) return false;
  obj.updateMatrixWorld(true);
  const local = obj.worldToLocal(hit.point.clone());

  // bbox-relative resilience.
  let rel = [0.5, 0.5, 0.5];
  const bb = meshNode.bbox;
  if (bb && Array.isArray(bb.min) && Array.isArray(bb.max)) {
    const wx = Math.max(bb.max[0] - bb.min[0], 1e-6);
    const wy = Math.max(bb.max[1] - bb.min[1], 1e-6);
    const wz = Math.max(bb.max[2] - bb.min[2], 1e-6);
    rel = [
      (local.x - bb.min[0]) / wx,
      (local.y - bb.min[1]) / wy,
      (local.z - bb.min[2]) / wz,
    ];
  }

  const note = createNoteNode({
    anchorMeshId:       meshId,
    anchorLocal:        [local.x, local.y, local.z],
    anchorBboxRelative: rel,
    text:               '',                      // empty — template's text wins
    templateId,
  });
  meshNode.children = [...(meshNode.children || []), note];
  state.setState({
    nodeById:                    _nodes_buildNodeMap(state.get('treeData')),
    noteTemplateInstantiationId: null,
  });
  state.emit('change:treeData', state.get('treeData'));
  state.markDirty();

  undoManager.push(
    'Place template',
    () => {
      const m = state.get('nodeById')?.get(meshId);
      if (m) m.children = (m.children || []).filter(c => c.id !== note.id);
      state.setState({ nodeById: _nodes_buildNodeMap(state.get('treeData')) });
      state.emit('change:treeData', state.get('treeData'));
      state.markDirty();
    },
    () => {
      const m = state.get('nodeById')?.get(meshId);
      if (!m) return;
      if (!(m.children || []).some(c => c.id === note.id)) {
        m.children = [...(m.children || []), note];
      }
      state.setState({ nodeById: _nodes_buildNodeMap(state.get('treeData')) });
      state.emit('change:treeData', state.get('treeData'));
      state.markDirty();
    },
  );
  return note.id;
}

/**
 * Detach a single note instance from its template. Copies the template's
 * current text/size into the instance, clears templateId.
 */
export function detachNoteFromTemplate(noteId) {
  const note = state.get('nodeById')?.get(noteId);
  if (!note || note.type !== 'note' || !note.templateId) return;
  const list = state.get('noteTemplates') || [];
  const tpl  = list.find(t => t.id === note.templateId);
  if (!tpl) return;
  const before = {
    text: note.text, sizePresetId: note.sizePresetId,
    customFontSize: note.customFontSize, templateId: note.templateId,
  };
  note.text           = tpl.text;
  note.sizePresetId   = tpl.sizePresetId;
  note.customFontSize = tpl.customFontSize;
  note.templateId     = null;
  state.emit('change:treeData', state.get('treeData'));
  state.markDirty();
  undoManager.push(
    'Detach template',
    () => {
      const n = state.get('nodeById')?.get(noteId);
      if (n) Object.assign(n, before);
      state.emit('change:treeData', state.get('treeData'));
      state.markDirty();
    },
    () => {
      const n = state.get('nodeById')?.get(noteId);
      if (n) Object.assign(n, { ...before, ...{ text: tpl.text, sizePresetId: tpl.sizePresetId, customFontSize: tpl.customFontSize, templateId: null } });
      state.emit('change:treeData', state.get('treeData'));
      state.markDirty();
    },
  );
}

/**
 * Swap a note's content source — link to a (different) template, copying
 * the template's text/size into the instance's snapshot fields for safety
 * but using templateId as the source of truth at render time.
 */
export function linkNoteToTemplate(noteId, templateId) {
  const note = state.get('nodeById')?.get(noteId);
  if (!note || note.type !== 'note') return;
  const list = state.get('noteTemplates') || [];
  if (!list.some(t => t.id === templateId)) return;
  const before = { templateId: note.templateId };
  if (before.templateId === templateId) return;
  note.templateId = templateId;
  state.emit('change:treeData', state.get('treeData'));
  state.markDirty();
  undoManager.push(
    'Link to template',
    () => {
      const n = state.get('nodeById')?.get(noteId);
      if (n) n.templateId = before.templateId;
      state.emit('change:treeData', state.get('treeData'));
      state.markDirty();
    },
    () => {
      const n = state.get('nodeById')?.get(noteId);
      if (n) n.templateId = templateId;
      state.emit('change:treeData', state.get('treeData'));
      state.markDirty();
    },
  );
}

// ── Note template library — bulk import with conflict resolution ──────────
//
// Imports a list of templates into the live state. Each incoming template
// is matched against existing ones BY NAME. The caller passes a per-name
// resolution map so the import is non-interactive at this layer (the UI
// builds the dialog and feeds the decisions). Resolutions:
//   'add'     → insert as-is (no conflict, or user picked rename-only)
//   'replace' → overwrite existing entry with the same name (keep ID so
//               linked instances continue to point at the right template)
//   'skip'    → drop this incoming template
//   'rename'  → insert with auto-suffixed name "Foo (2)", "Foo (3)" …
//
// Returns counts: { added, replaced, skipped, renamed }.
// Pushes a single undo entry covering the whole import.

function _uniqueRenameAvailable(baseName, takenNames) {
  if (!takenNames.has(baseName)) return baseName;
  let n = 2;
  while (takenNames.has(`${baseName} (${n})`)) n++;
  return `${baseName} (${n})`;
}

export function importNoteTemplateLibrary(incoming, resolutions /* Map<name, mode> */) {
  if (!Array.isArray(incoming) || !incoming.length) {
    return { added: 0, replaced: 0, skipped: 0, renamed: 0 };
  }
  const before = JSON.parse(JSON.stringify(state.get('noteTemplates') || []));
  const next   = before.slice();
  const byName = new Map(next.map(t => [t.name, t]));
  let added = 0, replaced = 0, skipped = 0, renamed = 0;

  for (const tpl of incoming) {
    if (!tpl || typeof tpl !== 'object') continue;
    const name = String(tpl.name || '').trim();
    const mode = resolutions instanceof Map
                 ? (resolutions.get(name) || 'rename')
                 : 'rename';
    if (mode === 'skip')   { skipped++; continue; }
    if (mode === 'replace' && byName.has(name)) {
      const existing = byName.get(name);
      const updated  = {
        ...existing,
        text:           tpl.text ?? '',
        sizePresetId:   tpl.sizePresetId   || existing.sizePresetId || 'medium',
        customFontSize: Number.isFinite(tpl.customFontSize) ? tpl.customFontSize : null,
      };
      const idx = next.findIndex(t => t.id === existing.id);
      if (idx >= 0) next[idx] = updated;
      byName.set(name, updated);
      replaced++;
      continue;
    }
    // 'add' → use given name. 'rename' → auto-rename to avoid collision.
    let finalName = name;
    if (mode !== 'add') {
      finalName = _uniqueRenameAvailable(name || 'Template', new Set(byName.keys()));
      if (finalName !== name) renamed++;
    }
    const fresh = createNoteTemplate({
      name:           finalName,
      text:           tpl.text ?? '',
      sizePresetId:   tpl.sizePresetId   || 'medium',
      customFontSize: Number.isFinite(tpl.customFontSize) ? tpl.customFontSize : null,
    });
    next.push(fresh);
    byName.set(finalName, fresh);
    added++;
  }

  state.setState({ noteTemplates: next });
  state.markDirty();
  state.emit('change:treeData', state.get('treeData'));

  const after = JSON.parse(JSON.stringify(next));
  undoManager.push(
    'Import note library',
    () => {
      state.setState({ noteTemplates: JSON.parse(JSON.stringify(before)) });
      state.markDirty();
      state.emit('change:treeData', state.get('treeData'));
    },
    () => {
      state.setState({ noteTemplates: JSON.parse(JSON.stringify(after)) });
      state.markDirty();
      state.emit('change:treeData', state.get('treeData'));
    },
  );
  return { added, replaced, skipped, renamed };
}

// ── Note position clipboard ────────────────────────────────────────────────
//
// Copy a note's framePosition once; paste it into every selected step's
// snapshot for that same note. The active step also gets the live mutation
// applied immediately so the user sees the change without re-navigating.
//
// noteId is captured at copy time so the paste targets the SAME note —
// pasting onto a different note's right-click menu is currently disabled
// in the UI; if relaxed later, the action can accept a target noteId.

let _notePosClip = null;

export function copyNotePosition(noteId) {
  const n = state.get('nodeById')?.get(noteId);
  if (!n || n.type !== 'note') return;
  const fp = n.framePosition;
  if (!fp || !Number.isFinite(fp.x) || !Number.isFinite(fp.y)) return;
  _notePosClip = { noteId, x: fp.x, y: fp.y };
}

export function getNotePositionClipboard() { return _notePosClip; }

export function pasteNotePositionToSelectedSteps() {
  if (!_notePosClip) return 0;
  const sel = state.get('selectedStepIds');
  if (!(sel instanceof Set) || sel.size === 0) return 0;
  const stepsArr = state.get('steps') || [];
  const targets  = stepsArr.filter(s => sel.has(s.id));
  if (!targets.length) return 0;

  // Snapshot before for undo (one entry covers the whole paste).
  const beforeMap = new Map();   // stepId → prior snapshot.notePanelOffsets[noteId]
  for (const step of targets) {
    if (!step.snapshot) continue;
    const prior = step.snapshot.notePanelOffsets?.[_notePosClip.noteId];
    beforeMap.set(step.id, prior ? { ...prior } : null);
  }

  const apply = (clip) => {
    const arr = state.get('steps') || [];
    for (const step of arr) {
      if (!sel.has(step.id) || !step.snapshot) continue;
      if (!step.snapshot.notePanelOffsets) step.snapshot.notePanelOffsets = {};
      const existing = step.snapshot.notePanelOffsets[clip.noteId] || {};
      step.snapshot.notePanelOffsets[clip.noteId] = {
        ...existing,
        fx: clip.x,
        fy: clip.y,
      };
    }
    // If active step is in the selection, mirror onto the live note so
    // the user sees the new position immediately.
    const activeId = state.get('activeStepId');
    if (sel.has(activeId)) {
      const note = state.get('nodeById')?.get(clip.noteId);
      if (note?.type === 'note') note.framePosition = { x: clip.x, y: clip.y };
    }
    state.markDirty();
    state.emit('change:treeData', state.get('treeData'));
  };

  apply(_notePosClip);
  const snap = { ..._notePosClip };
  const beforeSnap = beforeMap;
  undoManager.push(
    'Paste note position',
    () => {
      const arr = state.get('steps') || [];
      for (const step of arr) {
        if (!beforeSnap.has(step.id) || !step.snapshot) continue;
        const prior = beforeSnap.get(step.id);
        if (!step.snapshot.notePanelOffsets) step.snapshot.notePanelOffsets = {};
        if (prior) step.snapshot.notePanelOffsets[snap.noteId] = prior;
        else delete step.snapshot.notePanelOffsets[snap.noteId];
      }
      state.markDirty();
      state.emit('change:treeData', state.get('treeData'));
    },
    () => apply(snap),
  );
  return targets.length;
}

export function deleteNote(noteId) {
  const root = state.get('treeData');
  const nb   = state.get('nodeById');
  const note = nb?.get(noteId);
  if (!note || note.type !== 'note') return;
  // Find parent. Since notes always live as direct children of a mesh,
  // we can use the anchorMeshId as a hint, but fall back to a tree walk.
  const parent = _findNodeParent(root, noteId);
  if (!parent) return;
  const idx = (parent.children || []).findIndex(c => c.id === noteId);
  if (idx < 0) return;
  parent.children.splice(idx, 1);
  state.setState({ nodeById: _nodes_buildNodeMap(root) });
  state.emit('change:treeData', root);
  state.markDirty();
  undoManager.push(
    'Delete note',
    () => {
      const r = state.get('treeData');
      const p = _findNodeRecursive(r, parent.id);
      if (!p) return;
      const i = Math.min(idx, (p.children || []).length);
      p.children = [...(p.children || [])];
      p.children.splice(i, 0, note);
      state.setState({ nodeById: _nodes_buildNodeMap(r) });
      state.emit('change:treeData', r);
      state.markDirty();
    },
    () => {
      const r = state.get('treeData');
      const p = _findNodeRecursive(r, parent.id);
      if (!p) return;
      p.children = (p.children || []).filter(c => c.id !== noteId);
      state.setState({ nodeById: _nodes_buildNodeMap(r) });
      state.emit('change:treeData', r);
      state.markDirty();
    },
  );
}

function _findNodeRecursive(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of (node.children || [])) {
    const r = _findNodeRecursive(c, id);
    if (r) return r;
  }
  return null;
}


// ═══════════════════════════════════════════════════════════════════════════
//  SHAPE TEMPLATE / INSTANCE ACTIONS  (Phase 1 — "2D shapes in 3D")
// ═══════════════════════════════════════════════════════════════════════════
//
// Library + instance flow, mirrors notes:
//   1. startShapeDraw()         → enters viewport editor (pickPlane → addVertices).
//   2. shape-editor.js fires
//      'shapeEditor:commit'     → onShapeEditorCommit() creates a fresh template
//                                 + auto-places one instance at the drawn plane.
//   3. placeShapeInstance()     → drops another instance of an existing template.
//   4. deleteShapeTemplate()    → cascade: delete every instance + the template.
//
// Per-step propagation: when an instance is created we walk every step
// (or only state.selectedStepIds when multi-selection is active) and
// patch its snapshot.tree + .visibility[id] + .transforms[id]. This is
// the fix for the M1 bug where a node added mid-project disappeared when
// the user navigated to a step captured before the node existed.

/** Begin drawing a NEW template. Editor takes over the viewport. */
export function startShapeDraw() {
  _resetShapeInteraction();   // clear any leftover placement / pick / image mode
  shapeEditor.startDrawing(null);
}


// ─────────────────────────────────────────────────────────────────────
//  IMAGE-SHAPE  (file-pick → click-to-place)
// ─────────────────────────────────────────────────────────────────────
//
// "Image shapes" are flatShape templates that carry an `image` field with
// a base64 dataUrl + natural dimensions. The mesh builder swaps the
// material to one with the texture mapped over the polygon's bbox.
//
// Flow:
//   1. User clicks "+ Image" → addImageShape() opens an OS file picker.
//   2. Image is read (base64), dimensions probed via an Image element.
//   3. Pending data stashed on state.imageShapePending; placement is
//      armed with the marker id IMAGE_PENDING_ID.
//   4. Next viewport click hits placeShapeAtClick(IMAGE_PENDING_ID) → we
//      branch into _placePendingImageAtClick() which:
//        - resolves the plane (same logic as polygon shape placement)
//        - creates the template AND the first instance
//        - bundles both mutations into ONE undo entry
//        - clears the pending state
//
// Cancel paths: Esc / right-click → cancelShapePlacement() also clears
// the pending image data.

const IMAGE_PENDING_ID = '__image_pending__';

/**
 * Open the image picker, read the file, arm placement.
 *
 * Pending state lives on state.imageShapePending until the user either
 * clicks (→ template + instance created) or cancels (→ wiped).
 */
export async function addImageShape() {
  // Cancel any other picker / draw mode that might be active.
  if (state.get('shapeDrawing'))                  cancelShapeDraw();
  if (state.get('shapePlacementForId'))           cancelShapePlacement();
  if (state.get('shapeEditPickInstanceForId'))    state.setState({ shapeEditPickInstanceForId: null });
  if (state.get('shapeFromFacePicking'))          state.setState({ shapeFromFacePicking: false });

  const nat = window.sbsNative;
  if (!nat?.openImage || !nat?.readFile) {
    setStatus('Image picker unavailable (not running in Electron).', 'warn');
    return;
  }
  const path = await nat.openImage();
  if (!path) return;   // user cancelled

  const ext  = (path.match(/\.(\w+)$/)?.[1] ?? 'png').toLowerCase();
  const mime = ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', bmp: 'image/bmp',
  })[ext] ?? 'image/png';
  // PNG/GIF *may* carry alpha — treat as transparent for safe defaults.
  // (Opaque PNGs still render correctly — alphaTest=0.5 doesn't clip
  // anything when every pixel has alpha=1.)
  const hasAlpha = (ext === 'png' || ext === 'gif');

  // fs:readFile returns an envelope: { ok, data } | { ok:false, error }
  let result;
  try {
    result = await nat.readFile(path, 'base64');
  } catch (err) {
    setStatus(`Could not read image: ${err?.message || err}`, 'danger');
    return;
  }
  if (!result?.ok) {
    setStatus(`Could not read image: ${result?.error || 'unknown error'}`, 'danger');
    return;
  }
  const b64 = result.data;
  if (!b64 || typeof b64 !== 'string') {
    setStatus('Image file appears to be empty.', 'warn');
    return;
  }
  const dataUrl = `data:${mime};base64,${b64}`;

  // Probe natural dimensions via an off-DOM Image element. Only async
  // step after the file read — everything downstream is synchronous.
  let dims;
  try {
    dims = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload  = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error('Could not decode image (corrupt or unsupported format).'));
      img.src = dataUrl;
    });
  } catch (err) {
    setStatus(`Image decode failed: ${err?.message || err}`, 'danger');
    return;
  }
  if (!dims.w || !dims.h) {
    setStatus('Image has zero size.', 'warn');
    return;
  }

  const fname = path.split(/[\\/]/).pop() || 'Image';
  const name  = fname.replace(/\.[^.]+$/, '');

  state.setState({
    imageShapePending: {
      dataUrl,
      width:    dims.w,
      height:   dims.h,
      format:   ext,
      hasAlpha,
      name,
    },
    shapePlacementForId: IMAGE_PENDING_ID,
  });

  setStatus(`Click a model face (or empty space) to place "${name}". Esc cancels.`, 'info', 6000);
}

/**
 * Internal — called by placeShapeAtClick when the pending marker is set.
 * Resolves the click into a world plane, then creates the template AND
 * the first instance, bundled into ONE undo entry.
 */
function _placePendingImageAtClick(clientX, clientY) {
  const T = window.THREE;
  const pending = state.get('imageShapePending');
  if (!T || !pending) {
    state.setState({ shapePlacementForId: null, imageShapePending: null });
    return null;
  }

  // ── Plane resolution — IDENTICAL to placeShapeAtClick. ──────────────
  // Face hit → tangent plane (qx, qy on the face); empty → camera-facing.
  const hit = sceneCore.pick(clientX, clientY);
  let plane;
  if (hit && hit.face) {
    const origin = [hit.point.x, hit.point.y, hit.point.z];
    const n = hit.face.normal.clone()
      .transformDirection(hit.object.matrixWorld)
      .normalize();
    const N = new T.Vector3(n.x, n.y, n.z);
    let up = new T.Vector3(0, 1, 0);
    if (Math.abs(up.dot(N)) > 0.99) up = new T.Vector3(1, 0, 0);
    const X = new T.Vector3().crossVectors(up, N).normalize();
    const Y = new T.Vector3().crossVectors(N, X).normalize();
    const m = new T.Matrix4().makeBasis(X, Y, N);
    const q = new T.Quaternion().setFromRotationMatrix(m);
    const anchorNodeId = hit.object?.userData?.meshNodeId
                      ?? hit.object?.userData?.flatShapeNodeId
                      ?? hit.object?.userData?.nodeId
                      ?? null;
    plane = {
      origin,
      normal:          [N.x, N.y, N.z],
      qx:              [X.x, X.y, X.z],
      qy:              [Y.x, Y.y, Y.z],
      worldQuaternion: [q.x, q.y, q.z, q.w],
      anchorNodeId,
    };
  } else {
    const cam = sceneCore.camera;
    const fwd = new T.Vector3();
    cam.getWorldDirection(fwd);
    const target = cam.position.clone().add(fwd.clone().multiplyScalar(200));
    const N = fwd.clone().negate().normalize();
    let up = new T.Vector3(0, 1, 0);
    if (Math.abs(up.dot(N)) > 0.99) up = new T.Vector3(1, 0, 0);
    const X = new T.Vector3().crossVectors(up, N).normalize();
    const Y = new T.Vector3().crossVectors(N, X).normalize();
    const m = new T.Matrix4().makeBasis(X, Y, N);
    const q = new T.Quaternion().setFromRotationMatrix(m);
    plane = {
      origin:          [target.x, target.y, target.z],
      normal:          [N.x, N.y, N.z],
      qx:              [X.x, X.y, X.z],
      qy:              [Y.x, Y.y, Y.z],
      worldQuaternion: [q.x, q.y, q.z, q.w],
      anchorNodeId:    null,
    };
  }

  // ── Build rectangle polygon in the image's aspect ratio ─────────────
  // Default world-units width = 100 (mm, consistent with the rest of the
  // app). User can scale freely after placement.
  const WIDTH  = 100;
  const aspect = pending.width / pending.height;
  const height = WIDTH / aspect;
  const halfW  = WIDTH  / 2;
  const halfH  = height / 2;
  const rect = {
    outer: [
      [-halfW, -halfH],
      [ halfW, -halfH],
      [ halfW,  halfH],
      [-halfW,  halfH],
    ],
    holes: [],
  };

  // Snapshot for undo BEFORE we mutate anything that goes into steps.
  const prevTemplates = state.get('shapeTemplates') || [];
  const prevSteps     = JSON.parse(JSON.stringify(state.get('steps') || []));

  // ── Create template ─────────────────────────────────────────────────
  const tpl = createShapeTemplate({
    name:     pending.name || 'Image',
    fill:     '#ffffff',     // ignored by image-shape material, set for save/load shape
    polygons: [rect],
    image: {
      dataUrl:  pending.dataUrl,
      width:    pending.width,
      height:   pending.height,
      format:   pending.format,
      hasAlpha: pending.hasAlpha,
    },
  });
  state.setState({
    shapeTemplates:      [...prevTemplates, tpl],
    imageShapePending:   null,
    shapePlacementForId: null,
  });

  // ── Place first instance (no undo push — we bundle below) ───────────
  const instanceId = placeShapeInstance(tpl.id, { plane, undoLabel: null });

  const nextSteps = JSON.parse(JSON.stringify(state.get('steps') || []));

  undoManager.push(`Create image "${tpl.name}"`,
    () => _undoCreateTemplate(tpl.id, instanceId, prevTemplates, prevSteps),
    () => _redoCreateTemplate(tpl,    instanceId, nextSteps),
  );

  return instanceId;
}

/**
 * Begin EDITING an existing template. Resolves the target instance:
 *   - 0 visible instances on this step → status hint, no-op.
 *   - 1 visible instance              → enter editor seeded with that
 *                                       instance's plane + the template's
 *                                       existing polygon points.
 *   - 2+ visible instances            → enter "click an instance" mode
 *                                       (state.shapeEditPickInstanceForId).
 *                                       main.js routes the next viewport
 *                                       click to _enterShapeEditAtInstance.
 */
export function startShapeEdit(templateId) {
  const tpl = (state.get('shapeTemplates') || []).find(t => t.id === templateId);
  if (!tpl) return;
  _resetShapeInteraction();   // clear any leftover placement / pick / image mode

  const root      = state.get('treeData');
  const instances = [];
  if (root) {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (n.type === 'flatShape' && n.templateId === templateId) instances.push(n);
      if (n.children) for (const c of n.children) stack.push(c);
    }
  }
  // Prefer instances visible per the tree (ancestors all visible).
  const nodeById = state.get('nodeById');
  const visibleInstances = instances.filter(n => _isEffectivelyVisible(nodeById, n.id));
  const candidates = visibleInstances.length ? visibleInstances : instances;

  if (candidates.length === 0) {
    setStatus('No instance of this shape exists yet — place one first.', 'warn');
    return;
  }
  if (candidates.length === 1) {
    _enterShapeEditAtInstance(candidates[0].id, templateId);
    return;
  }
  setStatus('Click an instance to edit.', 'info');
  // Multi-instance: arm pick mode. main.js intercepts the next click.
  state.setState({ shapeEditPickInstanceForId: templateId });
}

/** Cancel pending edit-instance pick (Esc / click outside). */
export function cancelShapeEditPick() {
  if (state.get('shapeEditPickInstanceForId')) {
    state.setState({ shapeEditPickInstanceForId: null });
  }
}

/**
 * Called by main.js when the user clicks a flatShape during edit-pick
 * mode. Validates the click landed on an instance of the right template
 * (else cancels), then enters the editor seeded at that instance.
 */
export function pickInstanceForEdit(instanceId) {
  const targetTplId = state.get('shapeEditPickInstanceForId');
  state.setState({ shapeEditPickInstanceForId: null });
  if (!targetTplId) return;
  const node = state.get('nodeById')?.get(instanceId);
  if (!node || node.type !== 'flatShape' || node.templateId !== targetTplId) {
    setStatus('Click an instance of the shape to edit.', 'warn');
    return;
  }
  _enterShapeEditAtInstance(instanceId, targetTplId);
}

/**
 * Edit a SPECIFIC flat-shape instance directly — NO "click an instance" pick.
 * Used by the per-instance right-click menus (tree row + viewport) where we
 * already know exactly which shape the user chose, so the editor opens straight
 * away regardless of how many instances of the template exist. The Shapes-tab
 * "Edit" button still uses startShapeEdit (template-level → pick when ambiguous).
 */
export function editShapeInstance(instanceId) {
  const node = state.get('nodeById')?.get(instanceId);
  if (!node || node.type !== 'flatShape' || !node.templateId) {
    setStatus('Cannot edit — not a shape instance.', 'warn');
    return;
  }
  // We're going direct: clear any other half-armed shape mode so it can't leak.
  _resetShapeInteraction();
  _enterShapeEditAtInstance(instanceId, node.templateId);
}

/**
 * Open the editor seeded at a specific instance — its CURRENT world
 * pose becomes the drawing plane (so what the user sees on screen is
 * what they edit), and the template's existing polygon points are
 * pre-loaded so the user can extend / replace them.
 */
function _enterShapeEditAtInstance(instanceId, templateId) {
  const T = window.THREE;
  if (!T) return;
  const node  = state.get('nodeById')?.get(instanceId);
  const obj3d = steps.object3dById?.get(instanceId);
  const tpl   = (state.get('shapeTemplates') || []).find(t => t.id === templateId);
  if (!node || !obj3d || !tpl) return;

  // q_total = parent_world × localQ × planeLocalQuaternion. This is the
  // FULL world rotation of the polygon's plane-local +X / +Y / normal,
  // i.e. the basis the template's 2D points were stored in when last
  // saved. Using it as the editor's plane means seeded vertices land
  // exactly on the polygon visible on screen.
  obj3d.updateMatrixWorld(true);
  const parentWorldQ = new T.Quaternion();
  if (obj3d.parent) obj3d.parent.getWorldQuaternion(parentWorldQ);
  const localQ = new T.Quaternion(...(node.localQuaternion ?? [0, 0, 0, 1]));
  const planeQ = new T.Quaternion(...(node.planeLocalQuaternion ?? [0, 0, 0, 1]));
  const qTotal = parentWorldQ.clone().multiply(localQ).multiply(planeQ);

  const origin = new T.Vector3();
  obj3d.getWorldPosition(origin);
  const qx = new T.Vector3(1, 0, 0).applyQuaternion(qTotal);
  const qy = new T.Vector3(0, 1, 0).applyQuaternion(qTotal);
  const N  = new T.Vector3(0, 0, 1).applyQuaternion(qTotal);

  const seedPlane = {
    origin:          [origin.x, origin.y, origin.z],
    normal:          [N.x, N.y, N.z],
    qx:              [qx.x, qx.y, qx.z],
    qy:              [qy.x, qy.y, qy.z],
    worldQuaternion: [qTotal.x, qTotal.y, qTotal.z, qTotal.w],
    anchorNodeId:    null,   // not used in edit flow; commit writes template
  };

  // Seed every input polygon the template carries (XOR composition preserved).
  // Falls back to legacy single-polygon templates that haven't been migrated yet.
  const tplPolys = (Array.isArray(tpl.polygons) && tpl.polygons.length)
    ? tpl.polygons
    : (tpl.polygon ? [tpl.polygon] : []);
  shapeEditor.startDrawing(templateId, {
    seedPlane,
    seedPolygons: tplPolys.map(p => ({
      outer: (p.outer || []).map(pt => [pt[0], pt[1]]),
      holes: (p.holes || []).map(h => h.map(pt => [pt[0], pt[1]])),
    })),
    mode: 'edit',
  });
}

// Live vertex-edit listener: every move / delete / add-on-edge / add-
// polygon in the editor's 'edit' phase emits this. We write the polygons
// list to the template, ripple instance meshes, and push ONE undo entry
// per operation. `reason` becomes the undo label.
state.on('shapeEditor:vertexEdit', ({ templateId, polygons, reason }) => {
  if (!templateId) return;
  const list = state.get('shapeTemplates') || [];
  const tpl  = list.find(t => t.id === templateId);
  if (!tpl) return;
  const prevPolygons = JSON.parse(JSON.stringify(
    tpl.polygons || (tpl.polygon ? [tpl.polygon] : []),
  ));
  const nextPolygons = JSON.parse(JSON.stringify(polygons || []));

  const apply = (next) => {
    state.setState({
      shapeTemplates: (state.get('shapeTemplates') || []).map(t =>
        t.id === templateId ? { ...t, polygons: next, polygon: undefined } : t,
      ),
    });
    const root = state.get('treeData');
    if (root) _rebuildInstancesOfTemplate(root, steps.object3dById, templateId);
    state.emit('change:treeData', root);
    state.markDirty();
  };
  apply(nextPolygons);

  const label = reason === 'delete'           ? 'Delete vertex'
              : reason === 'addOnEdge'        ? 'Add vertex'
              : reason === 'addPolygon'       ? 'Add shape'
              : reason === 'deletePolygon'    ? 'Delete shape'
              : reason === 'transformPolygon' ? 'Transform shape'
              :                                 'Move vertex';
  undoManager.push(label,
    () => apply(prevPolygons),
    () => apply(nextPolygons),
  );
});

/** Cancel any in-progress draw. */
export function cancelShapeDraw() {
  shapeEditor.cancel();
}

// Walk parents of `nodeId`; node is "effectively visible" iff it AND
// all ancestors have localVisible !== false.
function _isEffectivelyVisible(nodeById, nodeId) {
  let cur = nodeById?.get(nodeId);
  while (cur) {
    if (cur.localVisible === false) return false;
    // No back-pointer; walk via tree. Cheap O(N) sweep is acceptable.
    cur = _findParentNode(nodeById, cur.id);
  }
  return true;
}
function _findParentNode(nodeById, childId) {
  if (!nodeById) return null;
  for (const [, n] of nodeById) {
    if (n.children?.some(c => c.id === childId)) return n;
  }
  return null;
}

/**
 * Wire the editor's commit event into the action layer. Fires once at
 * module load — actions.js is imported eagerly from main.js so this lands
 * before the user can possibly start drawing.
 */
state.on('shapeEditor:commit', (payload) => onShapeEditorCommit(payload));

/**
 * Handle a successful editor commit. Creates a new template (or updates
 * the editing one — Phase 2) and auto-places one instance at the plane
 * pose.
 *
 * @param {{plane:object, points:number[][], editingTemplateId:string|null}} payload
 */
function onShapeEditorCommit({ plane, polygons, points, editingTemplateId }) {
  // Tolerate legacy `points` payload from older callers — wrap into polygons[].
  const polys = (Array.isArray(polygons) && polygons.length)
    ? polygons.map(p => ({
        outer: p.outer.map(pt => [pt[0], pt[1]]),
        holes: (p.holes || []).map(h => h.map(pt => [pt[0], pt[1]])),
      }))
    : [{ outer: points.map(p => [p[0], p[1]]), holes: [] }];

  // ── Edit path: replace template polygons, ripple to all instances ────
  if (editingTemplateId) {
    const list = state.get('shapeTemplates') || [];
    const tpl  = list.find(t => t.id === editingTemplateId);
    if (!tpl) return;
    const prevPolygons = JSON.parse(JSON.stringify(tpl.polygons || (tpl.polygon ? [tpl.polygon] : [])));
    const nextPolygons = JSON.parse(JSON.stringify(polys));

    const apply = (next) => {
      state.setState({
        shapeTemplates: (state.get('shapeTemplates') || []).map(t =>
          t.id === editingTemplateId ? { ...t, polygons: next, polygon: undefined } : t,
        ),
      });
      const root = state.get('treeData');
      if (root) _rebuildInstancesOfTemplate(root, steps.object3dById, editingTemplateId);
      state.emit('change:treeData', root);
      state.markDirty();
    };
    apply(nextPolygons);

    undoManager.push(`Edit shape "${tpl.name || ''}"`,
      () => apply(prevPolygons),
      () => apply(nextPolygons),
    );
    return;
  }

  // ── Create path: new library entry + auto-placed instance ────────────
  const prevTemplates = state.get('shapeTemplates') || [];
  const tpl = createShapeTemplate({
    name:     `Shape ${prevTemplates.length + 1}`,
    fill:     '#88c0f0',
    polygons: polys,
  });

  state.setState({ shapeTemplates: [...prevTemplates, tpl] });

  // Auto-place one instance at the plane pose.
  const instanceId = placeShapeInstance(tpl.id, { plane, undoLabel: null });

  const prevSteps = JSON.parse(JSON.stringify(state.get('steps') || []));
  const nextSteps = JSON.parse(JSON.stringify(state.get('steps') || []));

  undoManager.push(`Create shape "${tpl.name}"`,
    () => _undoCreateTemplate(tpl.id, instanceId, prevTemplates, prevSteps),
    () => _redoCreateTemplate(tpl, instanceId, nextSteps),
  );
}

/**
 * Place a fresh instance of a template into the scene tree.
 * Returns the new instance node id.
 *
 * Parent resolution (in priority order):
 *   1. `options.parentId` (or `plane.anchorNodeId` for face-pick anchoring)
 *   2. currently selected folder / model
 *   3. scene root
 *
 * The plane pose is converted from WORLD coords to PARENT-LOCAL coords and
 * stored on `baseLocalPosition` / `baseLocalQuaternion` (the home anchor
 * fields). User-deltas (`localOffset` / `localQuaternion`) stay zero, so
 * "Reset transform" returns to the creation pose — not world origin.
 *
 * `options.plane`     — required. Defines world pose + optional anchorNodeId.
 * `options.parentId`  — optional override (else uses plane.anchorNodeId / selection).
 * `options.undoLabel` — when truthy, pushes its own undo entry. null = caller bundles.
 */
export function placeShapeInstance(templateId, options = {}) {
  const T = window.THREE;
  if (!T) return null;
  const { plane, parentId, undoLabel = `Place shape` } = options;
  if (!plane) return null;

  const root = state.get('treeData');
  if (!root) return null;

  // ── Resolve parent ────────────────────────────────────────────────────
  // 1) explicit parentId (or plane.anchorNodeId from face-pick)
  // 2) selected container (folder / model)
  // 3) scene root
  const requestedId = parentId ?? plane.anchorNodeId ?? null;
  let parent = requestedId
    ? (state.get('nodeById')?.get(requestedId) ?? findNode(root, requestedId))
    : null;
  if (!parent) {
    const selId = state.get('selectedId');
    const sel   = selId ? state.get('nodeById')?.get(selId) : null;
    if (sel && (sel.type === 'folder' || sel.type === 'model' || sel.type === 'scene')) {
      parent = sel;
    } else {
      parent = root;
    }
  }

  const tpl = (state.get('shapeTemplates') || []).find(t => t.id === templateId);
  if (!tpl) return null;

  // ── Convert plane pose (world) → parent-local ─────────────────────────
  // Position goes to baseLocalPosition (home anchor); orientation goes to
  // a SEPARATE field, planeLocalQuaternion, which the geometry builder
  // bakes into the polygon's vertex positions. baseLocalQuaternion stays
  // identity so the gizmo's rotation math behaves identically to a folder.
  const parentObj = parent.object3d ?? steps.object3dById?.get(parent.id) ?? null;
  let baseLocalPosition, planeLocalQuaternion;
  if (parentObj && parent.id !== 'scene_root') {
    parentObj.updateMatrixWorld(true);
    const localPt = parentObj.worldToLocal(new T.Vector3(...plane.origin));
    const parentWorldQ = new T.Quaternion();
    parentObj.getWorldQuaternion(parentWorldQ);
    const targetWorldQ = new T.Quaternion(...plane.worldQuaternion);
    const localQ = parentWorldQ.invert().multiply(targetWorldQ);
    baseLocalPosition    = [localPt.x, localPt.y, localPt.z];
    planeLocalQuaternion = [localQ.x, localQ.y, localQ.z, localQ.w];
  } else {
    baseLocalPosition    = [...plane.origin];
    planeLocalQuaternion = [...plane.worldQuaternion];
  }

  // ── Create instance ───────────────────────────────────────────────────
  // Creation position lives on baseLocalPosition (the "home" anchor) so
  // reset translate returns here. Plane orientation is baked into the
  // mesh geometry via planeLocalQuaternion. baseLocalQuaternion is left
  // at identity so the gizmo math matches every other transform node.
  const instance = createFlatShapeNode({
    name:                tpl.name || 'Shape',
    templateId,
    baseLocalPosition,
    planeLocalQuaternion,
  });

  // Build mesh + register
  const mesh = ensureFlatShapeObject3D(instance);
  if (!mesh) return null;
  if (parentObj) parentObj.add(mesh);
  applyNodeTransformToObject3D(instance, mesh);
  steps.object3dById.set(instance.id, mesh);

  // Insert into tree
  parent.children = parent.children || [];
  parent.children.push(instance);
  state.setState({ nodeById: _nodes_buildNodeMap(root) });

  // Propagate to step snapshots so navigating between steps preserves it.
  // Item 3: a freshly-placed shape is visible ONLY on the step it was
  // created on; it exists (hidden) in every other step so the user can
  // reveal it per-step later.
  _propagateNewNodeToSteps(instance, parent.id, { activeStepOnly: true });

  state.emit('change:treeData', root);
  steps.scheduleTransformSync();
  state.markDirty();

  if (undoLabel) {
    undoManager.push(undoLabel,
      () => _removeShapeInstance(instance.id),
      () => {
        placeShapeInstance(templateId, { plane, parentId: requestedId, undoLabel: null });
      },
    );
  }

  return instance.id;
}

/**
 * Arm the "Place" picker for a template. The next viewport click on a
 * face (or empty space) spawns a fresh instance tangent to the hit
 * surface; clicking empty space falls back to a camera-facing plane.
 * Single-shot — clears state.shapePlacementForId after one place.
 *
 * Cancels other picker / draw modes so the user can't be in two
 * conflicting states at once.
 */
/**
 * Reset ALL transient shape-interaction modes — draw, place picker, edit-pick,
 * create-from-face, and any pending image. Entering ANY one shape mode calls
 * this first so a half-armed picker can't hijack the next viewport click. This
 * is the fix for the "weird / inconsistent" behaviour where a leftover mode
 * made the same action sometimes place a shape, sometimes select, sometimes
 * do nothing.
 */
function _resetShapeInteraction() {
  if (state.get('shapeDrawing')) cancelShapeDraw();
  const patch = {};
  if (state.get('shapePlacementForId'))        patch.shapePlacementForId        = null;
  if (state.get('shapeEditPickInstanceForId')) patch.shapeEditPickInstanceForId = null;
  if (state.get('shapeFromFacePicking'))       patch.shapeFromFacePicking       = false;
  if (state.get('imageShapePending'))          patch.imageShapePending          = null;
  if (Object.keys(patch).length) state.setState(patch);
}

export function startShapePlacement(templateId) {
  if (!templateId) return;
  _resetShapeInteraction();
  state.setState({ shapePlacementForId: templateId });
}

export function cancelShapePlacement() {
  if (!state.get('shapePlacementForId')) return;
  // Also wipe any pending image data — same Esc / right-click reset.
  state.setState({ shapePlacementForId: null, imageShapePending: null });
}

// ═══════════════════════════════════════════════════════════════════════════
//  PARAMETRIC PRIMITIVES (V0.2.22.90) — box / sphere / cylinder / …
// ═══════════════════════════════════════════════════════════════════════════

/** Expose the primitive metadata (kind → label/icon/params/quality) to the UI. */
export function getPrimitiveDefs() { return PRIMITIVE_DEFS; }

// Module clipboard for primitive copy / paste / paste-instance.
let _primClipboard = null;

/** Resolve the parent for a new primitive: selected folder/model/scene → root.
 *  Bootstraps a scene root if the project is empty (stand-in with no model). */
function _primitiveParent() {
  let root = state.get('treeData');
  if (!root) {
    root = { id: 'scene_root', name: 'Scene', type: 'scene', children: [], object3d: sceneCore.rootGroup, localVisible: true };
    steps.object3dById.set('scene_root', sceneCore.rootGroup);
    state.setState({ treeData: root, nodeById: _nodes_buildNodeMap(root) });
  }
  const selId = state.get('selectedId');
  const sel   = selId ? state.get('nodeById')?.get(selId) : null;
  if (sel && (sel.type === 'folder' || sel.type === 'model' || sel.type === 'scene')) return sel;
  return root;
}

/** Create + insert a primitive from an explicit spec; selects it; one undo. */
function _spawnPrimitive({ kind, params, quality, primLinkId, name, undoLabel }) {
  const def = PRIMITIVE_DEFS[kind];
  if (!def) return null;
  const parent = _primitiveParent();
  if (!parent) return null;
  const node = createPrimitiveNode({
    name:        name || def.label,
    primKind:    kind,
    primParams:  { ...(params || defaultPrimitiveParams(kind)) },
    primQuality: quality ?? 3,
    primLinkId:  primLinkId || generateId('primLink'),
  });
  if (!ensurePrimitiveObject3D(node)) return null;
  _readdPrimitiveNode(node, parent.id);
  state.markDirty();
  if (undoLabel) {
    undoManager.push(undoLabel,
      () => _removePrimitiveNode(node.id),
      () => _readdPrimitiveNode(node, parent.id),
    );
  }
  state.setState({ selectedId: node.id, multiSelectedIds: new Set([node.id]) });
  return node.id;
}

/** Create a primitive of `kind` with default parameters (its own link group). */
export function createPrimitive(kind) {
  if (!PRIMITIVE_DEFS[kind]) return null;
  return _spawnPrimitive({ kind, params: defaultPrimitiveParams(kind), quality: 3, undoLabel: 'Create primitive' });
}

/** Copy a primitive's parametric definition (+ its link group) to the clipboard. */
export function copyPrimitive(nodeId) {
  const n = state.get('nodeById')?.get(nodeId);
  if (!n || n.type !== 'primitive') return false;
  _primClipboard = {
    kind:       n.primKind,
    params:     { ...(n.primParams || {}) },
    quality:    n.primQuality ?? 3,
    primLinkId: n.primLinkId || null,
    name:       n.name,
  };
  return true;
}

export function hasPrimitiveClipboard() { return !!_primClipboard; }

/** Paste an INDEPENDENT copy — its own parameter group (edits don't link back). */
export function pastePrimitive() {
  if (!_primClipboard) return null;
  return _spawnPrimitive({
    kind:       _primClipboard.kind,
    params:     _primClipboard.params,
    quality:    _primClipboard.quality,
    primLinkId: generateId('primLink'),     // fresh group → independent
    name:       _primClipboard.name,
    undoLabel:  'Paste primitive',
  });
}

/** Paste a LINKED instance — shares the source's parameter group (ripples). */
export function pastePrimitiveInstance() {
  if (!_primClipboard) return null;
  // Match the CURRENT params of the link group (the original may have changed
  // since copy); fall back to the clipboard snapshot.
  const members = _primClipboard.primLinkId ? _primitivesInLink(_primClipboard.primLinkId) : [];
  const src = members[0];
  return _spawnPrimitive({
    kind:       _primClipboard.kind,
    params:     src ? { ...src.primParams } : _primClipboard.params,
    quality:    src ? src.primQuality       : _primClipboard.quality,
    primLinkId: _primClipboard.primLinkId || generateId('primLink'),
    name:       _primClipboard.name,
    undoLabel:  'Paste linked primitive',
  });
}

/** Delete a primitive (undoable). */
export function deletePrimitive(nodeId) {
  const node = state.get('nodeById')?.get(nodeId);
  if (!node || node.type !== 'primitive') return;
  const parentId = _findNodeParentId(nodeId);
  _removePrimitiveNode(nodeId);
  state.markDirty();
  undoManager.push('Delete primitive',
    () => _readdPrimitiveNode(node, parentId),
    () => _removePrimitiveNode(nodeId),
  );
}

/** All live primitive nodes in a parameter-link group. */
function _primitivesInLink(linkId) {
  const nb = state.get('nodeById');
  if (!nb || !linkId) return [];
  const out = [];
  for (const [, n] of nb) if (n.type === 'primitive' && n.primLinkId === linkId) out.push(n);
  return out;
}

/** Id of a node's parent in the live tree (null for a scene-root child). */
function _findNodeParentId(nodeId) {
  const root = state.get('treeData');
  const stack = [{ parent: null, node: root }];
  while (stack.length) {
    const { parent, node: n } = stack.pop();
    if (!n) continue;
    if (n.id === nodeId) return parent ? parent.id : null;
    if (n.children) for (const c of n.children) stack.push({ parent: n, node: c });
  }
  return null;
}

/** (Re)insert a primitive node + its mesh under parentId; propagate to steps. */
function _readdPrimitiveNode(node, parentId) {
  const root = state.get('treeData');
  const parent = state.get('nodeById')?.get(parentId) || root;
  if (!parent) return;
  const mesh = node.object3d || ensurePrimitiveObject3D(node);
  const parentObj = parent.object3d ?? steps.object3dById?.get(parent.id) ?? null;
  if (mesh) {
    if (parentObj && mesh.parent !== parentObj) { if (mesh.parent) mesh.parent.remove(mesh); parentObj.add(mesh); }
    applyNodeTransformToObject3D(node, mesh);
    steps.object3dById.set(node.id, mesh);
  }
  parent.children = parent.children || [];
  if (!parent.children.some(c => c.id === node.id)) parent.children.push(node);
  state.setState({ nodeById: _nodes_buildNodeMap(root) });
  _propagateNewNodeToSteps(node, parentId, { activeStepOnly: true });
  state.emit('change:treeData', root);
  steps.scheduleTransformSync?.();
}

/** Remove a primitive from the tree + every step snapshot; dispose the mesh. */
function _removePrimitiveNode(id) {
  const root = state.get('treeData');
  if (!root) return;
  const obj = state.get('nodeById')?.get(id)?.object3d || steps.object3dById?.get(id);
  if (obj) { if (obj.parent) obj.parent.remove(obj); obj.geometry?.dispose?.(); obj.material?.dispose?.(); }
  materials?.unregisterMesh?.(id);
  steps.object3dById.delete(id);

  const stack = [{ parent: null, node: root }];
  while (stack.length) {
    const { parent, node: n } = stack.pop();
    if (n.id === id && parent) { const i = parent.children.findIndex(c => c.id === id); if (i >= 0) parent.children.splice(i, 1); break; }
    if (n.children) for (const c of n.children) stack.push({ parent: n, node: c });
  }

  const nextSteps = (state.get('steps') || []).map(s => {
    const snap = s.snapshot || {};
    const newTree = _removeFromTreeSpec(snap.tree, id);
    if (newTree === snap.tree && !snap.visibility?.[id] && !snap.transforms?.[id]) return s;
    const vis = { ...(snap.visibility || {}) }; delete vis[id];
    const tr  = { ...(snap.transforms  || {}) }; delete tr[id];
    return { ...s, snapshot: { ...snap, tree: newTree, visibility: vis, transforms: tr } };
  });
  state.setState({ steps: nextSteps, nodeById: _nodes_buildNodeMap(root) });
  state.emit('change:treeData', root);
}

/**
 * Live-update a primitive's parameters (partial merge) + rebuild geometry.
 * Pass undoLabel only on COMMIT (input 'change'); for live 'input' leave it
 * null. Pass `before` (snapshot captured at focus) so the undo spans the whole
 * drag, not just the last tick.
 */
export function setPrimitiveParams(nodeId, partial, { undoLabel = null, before = null } = {}) {
  const node = state.get('nodeById')?.get(nodeId);
  if (!node || node.type !== 'primitive') return;
  const beforeParams = before ? { ...before } : { ...(node.primParams || {}) };
  const after        = { ...(node.primParams || {}), ...partial };
  _setPrimParamsRaw(nodeId, after);
  state.markDirty();
  if (undoLabel) {
    undoManager.push(undoLabel,
      () => _setPrimParamsRaw(nodeId, beforeParams),
      () => _setPrimParamsRaw(nodeId, after),
    );
  }
}
function _setPrimParamsRaw(nodeId, params) {
  const n = state.get('nodeById')?.get(nodeId);
  if (!n) return;
  // Ripple to every member of the parameter-link group (shared parameters).
  const group = n.primLinkId ? _primitivesInLink(n.primLinkId) : [];
  for (const t of (group.length ? group : [n])) { t.primParams = { ...params }; rebuildPrimitive(t); }
  state.emit('change:treeData', state.get('treeData'));
}

/** Live-update a primitive's tessellation quality (1-5) + rebuild geometry. */
export function setPrimitiveQuality(nodeId, q, { undoLabel = null, before = null } = {}) {
  const node = state.get('nodeById')?.get(nodeId);
  if (!node || node.type !== 'primitive') return;
  const beforeQ = before != null ? before : (node.primQuality ?? 3);
  const after   = Math.max(1, Math.min(5, q | 0));
  _setPrimQualityRaw(nodeId, after);
  state.markDirty();
  if (undoLabel && beforeQ !== after) {
    undoManager.push(undoLabel,
      () => _setPrimQualityRaw(nodeId, beforeQ),
      () => _setPrimQualityRaw(nodeId, after),
    );
  }
}
function _setPrimQualityRaw(nodeId, q) {
  const n = state.get('nodeById')?.get(nodeId);
  if (!n) return;
  // Ripple to every member of the parameter-link group (shared quality).
  const group = n.primLinkId ? _primitivesInLink(n.primLinkId) : [];
  for (const t of (group.length ? group : [n])) { t.primQuality = q; rebuildPrimitive(t); }
  state.emit('change:treeData', state.get('treeData'));
}

/**
 * Resolve a viewport click into a place-target: build a plane from the
 * hit (face → tangent; empty space → camera-facing) and stamp the hit
 * object's nodeId onto plane.anchorNodeId. placeShapeInstance reads
 * anchorNodeId as its primary parent — same path the New Shape flow
 * uses, so a placed instance ends up parented EXACTLY where a fresh-
 * drawn one would (under the clicked mesh / folder / shape, not under
 * its container). That parenting is what makes the instance travel
 * with its host through tree-moves and step propagation.
 *
 * Always disarms after one shot.
 */
export function placeShapeAtClick(templateId, clientX, clientY) {
  // Image-shape: template doesn't exist yet — the click MATERIALISES it.
  if (templateId === IMAGE_PENDING_ID) {
    return _placePendingImageAtClick(clientX, clientY);
  }

  const T = window.THREE;
  if (!T) return null;
  const hit = sceneCore.pick(clientX, clientY);
  let plane;
  if (hit && hit.face) {
    const origin = [hit.point.x, hit.point.y, hit.point.z];
    const n = hit.face.normal.clone()
      .transformDirection(hit.object.matrixWorld)
      .normalize();
    const N = new T.Vector3(n.x, n.y, n.z);
    let up = new T.Vector3(0, 1, 0);
    if (Math.abs(up.dot(N)) > 0.99) up = new T.Vector3(1, 0, 0);
    const X = new T.Vector3().crossVectors(up, N).normalize();
    const Y = new T.Vector3().crossVectors(N, X).normalize();
    const m = new T.Matrix4().makeBasis(X, Y, N);
    const q = new T.Quaternion().setFromRotationMatrix(m);
    const anchorNodeId = hit.object?.userData?.meshNodeId
                      ?? hit.object?.userData?.flatShapeNodeId
                      ?? hit.object?.userData?.nodeId
                      ?? null;
    plane = {
      origin,
      normal:          [N.x, N.y, N.z],
      qx:              [X.x, X.y, X.z],
      qy:              [Y.x, Y.y, Y.z],
      worldQuaternion: [q.x, q.y, q.z, q.w],
      anchorNodeId,
    };
  } else {
    // Empty space — camera-facing plane, parent falls back to scene root.
    const cam = sceneCore.camera;
    const fwd = new T.Vector3();
    cam.getWorldDirection(fwd);
    const target = cam.position.clone().add(fwd.clone().multiplyScalar(200));
    const N = fwd.clone().negate().normalize();
    let up = new T.Vector3(0, 1, 0);
    if (Math.abs(up.dot(N)) > 0.99) up = new T.Vector3(1, 0, 0);
    const X = new T.Vector3().crossVectors(up, N).normalize();
    const Y = new T.Vector3().crossVectors(N, X).normalize();
    const m = new T.Matrix4().makeBasis(X, Y, N);
    const q = new T.Quaternion().setFromRotationMatrix(m);
    plane = {
      origin:          [target.x, target.y, target.z],
      normal:          [N.x, N.y, N.z],
      qx:              [X.x, X.y, X.z],
      qy:              [Y.x, Y.y, Y.z],
      worldQuaternion: [q.x, q.y, q.z, q.w],
      anchorNodeId:    null,
    };
  }
  const id = placeShapeInstance(templateId, { plane });
  state.setState({ shapePlacementForId: null });
  return id;
}

// ─────────────────────────────────────────────────────────────────────
//  CREATE SHAPE FROM GEOMETRY FACE (v1)
// ─────────────────────────────────────────────────────────────────────
//
// User clicks a face → we compute the plane of that face → walk the
// CONNECTED COMPONENT (element) of the clicked triangle in the mesh's
// geometry → intersect every triangle in that component with the plane
// → stitch the resulting line segments into one closed polyline →
// project to 2D plane-local coords → create a shape template + place
// one instance at the plane pose. Single undo entry.
//
// v1 scope: handles indexed AND non-indexed geometries (the latter
// gets vertex-position deduplication so connectivity is detectable).
// Returns the LARGEST closed loop only — multi-disjoint output deferred
// to v2.

/** Arm the create-from-face picker. Cancels other modes for safety. */
export function startCreateShapeFromFace() {
  _resetShapeInteraction();
  state.setState({ shapeFromFacePicking: true });
  setStatus('Click a face on a model — its cross-section becomes a new shape.');
}

export function cancelCreateShapeFromFace() {
  if (!state.get('shapeFromFacePicking')) return;
  state.setState({ shapeFromFacePicking: false });
}

// ─────────────────────────────────────────────────────────────────────
//  ADD POLYGON FROM FACE  (in-editor variant of create-shape-from-face)
// ─────────────────────────────────────────────────────────────────────
//
// Same flood-fill / cross-section pipeline, but the resulting loops are
// projected onto the CURRENT shape's plane (orthogonal projection along
// that plane's normal) and appended as a new polygon to the template
// being edited. Only valid while shapeDrawing.phase === 'edit'.

export function startAddPolygonFromFacePick() {
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'edit' || !dr.plane) {
    setStatus('Open a shape in edit mode first.', 'warning');
    return;
  }
  if (state.get('shapePlacementForId'))        state.setState({ shapePlacementForId: null });
  if (state.get('shapeEditPickInstanceForId')) state.setState({ shapeEditPickInstanceForId: null });
  if (state.get('shapeFromFacePicking'))       state.setState({ shapeFromFacePicking: false });
  state.setState({ addPolygonFromFacePicking: true });
  setStatus('Click a face — its outline is projected onto the shape plane and added as a new polygon.');
}

export function cancelAddPolygonFromFacePick() {
  if (!state.get('addPolygonFromFacePicking')) return;
  state.setState({ addPolygonFromFacePicking: false });
}

/**
 * Resolve a viewport click into a connected-component cross-section
 * polygon and append it to the in-edit shape template. The polygon is
 * projected onto the editor's plane along that plane's normal, so the
 * outline lies flat on the shape regardless of the face's orientation.
 * Auto-disarms after one shot.
 */
export function addPolygonFromFaceAtClick(clientX, clientY) {
  const T = window.THREE;
  if (!T) { state.setState({ addPolygonFromFacePicking: false }); return false; }
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'edit' || !dr.plane) {
    state.setState({ addPolygonFromFacePicking: false });
    setStatus('Not in shape edit mode — cancelled.', 'warning');
    return false;
  }
  const hit = sceneCore.pick(clientX, clientY);
  if (!hit || !hit.face || !hit.object?.isMesh) {
    state.setState({ addPolygonFromFacePicking: false });
    setStatus('No face hit — cancelled.', 'warning');
    return false;
  }

  // Project the flood-fill loops onto the EDITOR's plane (not the face's
  // own plane). _computeFaceCrossSection already does plane-local 2D
  // projection of mesh-local 3D vertices, so passing the shape plane here
  // gives orthogonal projection along the shape's normal.
  let loops2D;
  try {
    loops2D = _computeFaceCrossSection(hit, dr.plane);
  } catch (err) {
    console.warn('[addPolygonFromFace] computation failed:', err);
    state.setState({ addPolygonFromFacePicking: false });
    setStatus('Cross-section computation failed.', 'danger');
    return false;
  }
  if (!loops2D || loops2D.length === 0 || loops2D[0].length < 3) {
    state.setState({ addPolygonFromFacePicking: false });
    setStatus('Could not extract a polygon from this face.', 'warning');
    return false;
  }

  const ok = shapeEditor.addPolygonFromFace(loops2D);
  state.setState({ addPolygonFromFacePicking: false });
  if (!ok) {
    setStatus('Failed to add polygon.', 'warning');
    return false;
  }
  const outer = loops2D[0];
  const holes = loops2D.slice(1).filter(l => l.length >= 3);
  const holeStr = holes.length ? ` + ${holes.length} hole${holes.length === 1 ? '' : 's'}` : '';
  setStatus(`Polygon added — ${outer.length} pts${holeStr}.`);
  return true;
}

/**
 * Resolve a viewport click into a connected-component cross-section
 * polygon and land it as a shape. Auto-disarms after one shot.
 */
export function createShapeFromFaceAtClick(clientX, clientY) {
  const T = window.THREE;
  if (!T) { state.setState({ shapeFromFacePicking: false }); return null; }
  const hit = sceneCore.pick(clientX, clientY);
  if (!hit || !hit.face || !hit.object?.isMesh) {
    state.setState({ shapeFromFacePicking: false });
    setStatus('No face hit — cancelled.', 'warning');
    return null;
  }

  // ── Plane: same orientation convention as placeShapeAtClick ────────
  const origin = [hit.point.x, hit.point.y, hit.point.z];
  const n = hit.face.normal.clone()
    .transformDirection(hit.object.matrixWorld)
    .normalize();
  const N = new T.Vector3(n.x, n.y, n.z);
  let up = new T.Vector3(0, 1, 0);
  if (Math.abs(up.dot(N)) > 0.99) up = new T.Vector3(1, 0, 0);
  const X = new T.Vector3().crossVectors(up, N).normalize();
  const Y = new T.Vector3().crossVectors(N, X).normalize();
  const m = new T.Matrix4().makeBasis(X, Y, N);
  const q = new T.Quaternion().setFromRotationMatrix(m);
  const anchorNodeId = hit.object?.userData?.meshNodeId
                    ?? hit.object?.userData?.flatShapeNodeId
                    ?? hit.object?.userData?.nodeId
                    ?? null;
  const plane = {
    origin,
    normal:          [N.x, N.y, N.z],
    qx:              [X.x, X.y, X.z],
    qy:              [Y.x, Y.y, Y.z],
    worldQuaternion: [q.x, q.y, q.z, q.w],
    anchorNodeId,
  };

  // ── Compute face-set polygon(s) ────────────────────────────────────
  // Returns an array of 2D loops. Largest = outer; the rest are holes.
  let loops2D;
  try {
    loops2D = _computeFaceCrossSection(hit, plane);
  } catch (err) {
    console.warn('[createShapeFromFace] computation failed:', err);
    state.setState({ shapeFromFacePicking: false });
    setStatus('Cross-section computation failed.', 'danger');
    return null;
  }
  if (!loops2D || loops2D.length === 0 || loops2D[0].length < 3) {
    state.setState({ shapeFromFacePicking: false });
    setStatus('Could not extract a polygon from this face — try another spot or widen the angle threshold.', 'warning');
    return null;
  }

  const outer = loops2D[0];
  const holes = loops2D.slice(1).filter(l => l.length >= 3);

  // ── Land as template + instance (single undo) ──────────────────────
  const prevTemplates = state.get('shapeTemplates') || [];
  const tpl = createShapeTemplate({
    name:     `Shape ${prevTemplates.length + 1}`,
    fill:     '#88c0f0',
    polygons: [{ outer, holes }],
  });
  state.setState({ shapeTemplates: [...prevTemplates, tpl] });

  const prevSteps = JSON.parse(JSON.stringify(state.get('steps') || []));
  const instanceId = placeShapeInstance(tpl.id, { plane, undoLabel: null });
  const nextSteps  = JSON.parse(JSON.stringify(state.get('steps') || []));

  undoManager.push(`Create shape "${tpl.name}" (from face)`,
    () => _undoCreateTemplate(tpl.id, instanceId, prevTemplates, prevSteps),
    () => _redoCreateTemplate(tpl, instanceId, nextSteps),
  );

  state.setState({ shapeFromFacePicking: false });
  const holeStr = holes.length ? ` + ${holes.length} hole${holes.length === 1 ? '' : 's'}` : '';
  setStatus(`Created "${tpl.name}" — ${outer.length} pts${holeStr}.`);
  return instanceId;
}

/**
 * Top-level orchestration (v2 algorithm — flood-fill by normal angle).
 * Returns an array of 2D polygon loops in plane-local coords. The first
 * loop is the OUTER polygon (largest area); subsequent loops are holes.
 *
 * Steps:
 *   1. Flood-fill triangles whose normal is within shapeFaceAngleThreshold
 *      of the clicked triangle's normal (anchor-compare semantics).
 *   2. Boundary edges = edges referenced by exactly ONE triangle in the
 *      face set.
 *   3. Stitch boundary edges into closed loops.
 *   4. Project each loop to plane-local 2D.
 *   5. Sort by polygon area — largest = outer; rest = holes.
 */
function _computeFaceCrossSection(hit, plane) {
  const T = window.THREE;
  const mesh = hit.object;
  const geom = mesh.geometry;
  if (!geom?.attributes?.position) return null;

  const thresholdDeg = Number(state.get('shapeFaceAngleThreshold') ?? 5);
  const thresholdRad = Math.max(0, thresholdDeg) * Math.PI / 180;
  // cos is monotone-decreasing on [0,π], so "dot ≥ cos(threshold)" ⇔
  // "angle ≤ threshold". Both normals are unit-length, so dot = cos(angle).
  const cosThreshold = Math.cos(thresholdRad);

  // ── Flood-fill the face set by normal-angle deviation ──────────────
  const ff = _floodFillFacesByAngle(geom, hit.faceIndex, cosThreshold);
  if (!ff || ff.faceSet.size === 0) return null;

  // ── Extract boundary edges of the face set ─────────────────────────
  const segments = _extractBoundaryEdges(ff);
  if (segments.length === 0) return null;

  // ── Stitch into closed loops (mesh-local 3D) ───────────────────────
  const loops3D = _stitchSegmentsToLoops(segments);
  if (loops3D.length === 0) return null;

  // ── Project each loop to plane-local 2D ────────────────────────────
  mesh.updateMatrixWorld(true);
  const invMeshWorld = new T.Matrix4().copy(mesh.matrixWorld).invert();
  const planeOriginLocal = new T.Vector3(...plane.origin).applyMatrix4(invMeshWorld);
  const meshWorldQ = new T.Quaternion();
  mesh.getWorldQuaternion(meshWorldQ);
  const invMeshWorldQ = meshWorldQ.clone().invert();
  const Xlocal = new T.Vector3(...plane.qx).applyQuaternion(invMeshWorldQ);
  const Ylocal = new T.Vector3(...plane.qy).applyQuaternion(invMeshWorldQ);
  const project = (p) => {
    const dx = p.x - planeOriginLocal.x;
    const dy = p.y - planeOriginLocal.y;
    const dz = p.z - planeOriginLocal.z;
    return [
      dx * Xlocal.x + dy * Xlocal.y + dz * Xlocal.z,
      dx * Ylocal.x + dy * Ylocal.y + dz * Ylocal.z,
    ];
  };
  const loops2D = loops3D.map(loop => loop.map(project)).filter(l => l.length >= 3);
  if (loops2D.length === 0) return null;

  // Sort by absolute polygon area — largest is the outer ring.
  loops2D.sort((a, b) => _polyArea2D(b) - _polyArea2D(a));
  return loops2D;
}

/**
 * Walks the triangle adjacency graph of `geom` and returns the set of
 * triangle indices whose normal is within `cosThreshold` of `startTri`'s
 * normal (anchor-compare — prevents cumulative drift across many small-
 * angle steps along a curved surface).
 *
 * Handles indexed AND non-indexed geometries — for the latter we
 * deduplicate vertex positions by quantised key so edge-sharing across
 * triangles is actually detectable. The returned object also exposes
 * the canonical-vertex helpers so the boundary-edge pass can reuse them.
 *
 * @returns {{
 *   faceSet:     Set<number>,
 *   getTriCanon: (t:number) => [number,number,number],
 *   canonPos:    Float64Array | number[],
 *   edgeKey:     (a:number, b:number) => string
 * }}
 */
function _floodFillFacesByAngle(geom, startTri, cosThreshold) {
  const posAttr = geom.attributes.position;
  const index   = geom.index;
  const triCount = index ? (index.count / 3) : (posAttr.count / 3);
  if (startTri < 0 || startTri >= triCount) return null;

  // ── Canonical vertex map (positions deduped by value) ───────────────
  const eps = 1e-5;
  const posKey = (i) => {
    const x = Math.round(posAttr.getX(i) / eps) * eps;
    const y = Math.round(posAttr.getY(i) / eps) * eps;
    const z = Math.round(posAttr.getZ(i) / eps) * eps;
    return x + ',' + y + ',' + z;
  };
  const canonByKey = new Map();
  const canon      = new Int32Array(posAttr.count);
  const canonPos   = []; // flat [x,y,z, x,y,z, …]
  let nextCanon = 0;
  for (let i = 0; i < posAttr.count; i++) {
    const k = posKey(i);
    let c = canonByKey.get(k);
    if (c === undefined) {
      c = nextCanon++;
      canonByKey.set(k, c);
      canonPos.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
    }
    canon[i] = c;
  }

  const getTriCanon = (t) => {
    const a = index ? index.array[t*3]     : t*3;
    const b = index ? index.array[t*3 + 1] : t*3 + 1;
    const c = index ? index.array[t*3 + 2] : t*3 + 2;
    return [canon[a], canon[b], canon[c]];
  };

  // ── Edge → triangles adjacency ─────────────────────────────────────
  const edgeKey = (a, b) => a < b ? (a + '-' + b) : (b + '-' + a);
  const edgeMap = new Map();
  for (let t = 0; t < triCount; t++) {
    const [a, b, c] = getTriCanon(t);
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = edgeKey(u, v);
      let list = edgeMap.get(k);
      if (!list) { list = []; edgeMap.set(k, list); }
      list.push(t);
    }
  }

  // ── Per-triangle normal computed from canonical positions ──────────
  const triNormal = (t) => {
    const [ca, cb, cc] = getTriCanon(t);
    const ax = canonPos[ca*3],   ay = canonPos[ca*3+1], az = canonPos[ca*3+2];
    const bx = canonPos[cb*3],   by = canonPos[cb*3+1], bz = canonPos[cb*3+2];
    const cx = canonPos[cc*3],   cy = canonPos[cc*3+1], cz = canonPos[cc*3+2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) return null;
    return { x: nx / len, y: ny / len, z: nz / len };
  };

  const anchorNormal = triNormal(startTri);
  if (!anchorNormal) return null;

  // ── BFS flood fill (anchor-compare) ────────────────────────────────
  const faceSet = new Set([startTri]);
  const queue   = [startTri];
  while (queue.length) {
    const t = queue.shift();
    const [a, b, c] = getTriCanon(t);
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = edgeKey(u, v);
      const list = edgeMap.get(k);
      if (!list) continue;
      for (const nt of list) {
        if (faceSet.has(nt)) continue;
        const nN = triNormal(nt);
        if (!nN) continue;
        const dot = anchorNormal.x * nN.x + anchorNormal.y * nN.y + anchorNormal.z * nN.z;
        if (dot >= cosThreshold) {
          faceSet.add(nt);
          queue.push(nt);
        }
      }
    }
  }

  return { faceSet, getTriCanon, canonPos, edgeKey };
}

/**
 * Collect boundary edges of a face set: edges shared by exactly ONE
 * triangle inside the set. Each returned segment is [Vector3, Vector3]
 * in mesh-local coords, ready for _stitchSegmentsToLoops.
 */
function _extractBoundaryEdges({ faceSet, getTriCanon, canonPos, edgeKey }) {
  const edgeCount = new Map();
  const edgeEnds  = new Map(); // edgeKey → [canonU, canonV]
  for (const t of faceSet) {
    const [a, b, c] = getTriCanon(t);
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = edgeKey(u, v);
      edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
      if (!edgeEnds.has(k)) edgeEnds.set(k, [u, v]);
    }
  }
  const T = window.THREE;
  const segments = [];
  for (const [k, count] of edgeCount) {
    if (count !== 1) continue;
    const [u, v] = edgeEnds.get(k);
    segments.push([
      new T.Vector3(canonPos[u*3], canonPos[u*3+1], canonPos[u*3+2]),
      new T.Vector3(canonPos[v*3], canonPos[v*3+1], canonPos[v*3+2]),
    ]);
  }
  return segments;
}

/** Absolute polygon area in 2D (shoelace formula). */
function _polyArea2D(loop) {
  if (loop.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) * 0.5;
}

/**
 * Stitch unordered line segments into closed loops. Endpoints are
 * matched by spatial hash (small epsilon round). Each segment is used
 * at most once. Returns array of loops; each loop is an array of
 * THREE.Vector3 in connection order (no duplicate closing vertex).
 */
function _stitchSegmentsToLoops(segments) {
  const eps = 1e-4;
  const key = (p) => `${Math.round(p.x / eps)},${Math.round(p.y / eps)},${Math.round(p.z / eps)}`;

  // Endpoint → [{ segIdx, end }]
  const endpoints = new Map();
  segments.forEach((seg, i) => {
    for (let end = 0; end < 2; end++) {
      const k = key(seg[end]);
      let list = endpoints.get(k);
      if (!list) { list = []; endpoints.set(k, list); }
      list.push({ segIdx: i, end });
    }
  });

  const used = new Uint8Array(segments.length);
  const loops = [];
  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const loop = [segments[start][0], segments[start][1]];
    let safety = segments.length + 4;
    while (safety-- > 0) {
      const tip = loop[loop.length - 1];
      const k   = key(tip);
      const candidates = endpoints.get(k) || [];
      let next = null;
      for (const c of candidates) {
        if (used[c.segIdx]) continue;
        next = c;
        break;
      }
      if (!next) break;
      used[next.segIdx] = 1;
      const seg = segments[next.segIdx];
      loop.push(seg[1 - next.end]);
      // Closed loop check — back at start within eps.
      if (key(loop[loop.length - 1]) === key(loop[0])) {
        loop.pop();
        break;
      }
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function _findDataParent(root, childId) {
  const stack = [{ node: root, parent: null }];
  while (stack.length) {
    const { node, parent } = stack.pop();
    if (node.id === childId) return parent;
    for (const c of (node.children || [])) stack.push({ node: c, parent: node });
  }
  return null;
}

/**
 * Delete a single flatShape instance node (template stays). Used by
 * the tree + viewport "Delete shape" menu items. One undo entry.
 */
export function deleteFlatShapeInstance(nodeId) {
  if (!nodeId) return false;
  const root = state.get('treeData');
  if (!root) return false;
  const node = state.get('nodeById')?.get(nodeId) ?? findNode(root, nodeId);
  if (!node || node.type !== 'flatShape') return false;
  const parent = _findDataParent(root, nodeId);
  if (!parent) return false;
  // Snapshot for undo
  const childIdx = parent.children.indexOf(node);
  if (childIdx < 0) return false;
  const snapshot = JSON.parse(JSON.stringify(node));

  undoManager.push('Delete shape',
    () => _removeShapeInstance(nodeId),
    () => {
      // Re-insert into same parent at same index, rebuild mesh, propagate.
      const p = state.get('nodeById')?.get(parent.id) ?? findNode(state.get('treeData'), parent.id);
      if (!p) return;
      const restored = JSON.parse(JSON.stringify(snapshot));
      p.children = p.children || [];
      p.children.splice(Math.min(childIdx, p.children.length), 0, restored);
      const mesh = ensureFlatShapeObject3D(restored);
      const parentObj = p.object3d ?? steps.object3dById?.get(p.id) ?? null;
      if (parentObj && mesh) parentObj.add(mesh);
      if (mesh) {
        applyNodeTransformToObject3D(restored, mesh);
        steps.object3dById.set(restored.id, mesh);
      }
      state.setState({ nodeById: _nodes_buildNodeMap(state.get('treeData')) });
      _propagateNewNodeToSteps(restored, p.id);
      state.emit('change:treeData', state.get('treeData'));
      steps.scheduleTransformSync();
      state.markDirty();
    },
  );
  // Eager apply
  _removeShapeInstance(nodeId);
  return true;
}

/**
 * Delete a top-level assembly (model node) and replace it with phantom
 * bounding-box placeholders — Phase 1A of the "delete assembly" rework.
 *
 * Behaviour:
 *   - Walks the model's subtree.
 *   - Every mesh → object3d detached + disposed-not, `missing=true`,
 *     `object3d` cleared. The next rebuild creates a Bbox placeholder
 *     (the existing missing-asset path in steps.rebuildFromTreeSpec).
 *   - Every folder → `missing=true`; its Three.js Group stays as a
 *     phantom-folder wrapper so live-mesh-displaced-into-folder
 *     dependencies survive.
 *   - The model node itself → `missing=true`, object3d detached.
 *   - The matching `state.assets` entry is removed so save+reload
 *     doesn't try to resurrect the geometry from the source file.
 *
 * Dependencies (cables, notes, flat-shapes anchored to or parented
 * under the model's meshes) keep their anchor IDs and continue to
 * resolve through the phantom Bbox — no relocation in this phase.
 * Phase 1B will add the 4-option dialog with "Break dependencies"
 * (relocate to row at origin) as an alternative.
 *
 * Single undo entry; the closures retain the original object3d refs
 * so Ctrl-Z re-attaches the same geometry without re-loading the file.
 */
export function deleteTopLevelAssembly(modelId) {
  if (!modelId) return false;
  const root = state.get('treeData');
  if (!root) return false;
  const model = state.get('nodeById')?.get(modelId) ?? findNode(root, modelId);
  if (!model || model.type !== 'model') return false;
  if (model.missing) return false;        // already a phantom — nothing to demote

  // Smart-delete sets — drives which natives stay as Bbox / phantom-folder
  // vs are fully removed. Scans live tree + every step snapshot so shapes
  // that move folder-to-folder per step still pin their host folder.
  const keep = _computeSmartDeleteKeepSets(model);

  // Heavy snapshot: full tree (sans object3d) + retained refs. This is
  // required because the smart path PHYSICALLY removes nodes that nothing
  // depends on, not just flips a "missing" flag — undo must rebuild them.
  const before = _captureFullSnapshotForBreak();
  _applySmartDelete(model, keep);
  _refreshSceneForActiveStep();
  state.emit('change:treeData', state.get('treeData'));
  state.markDirty();

  const after = _captureFullSnapshotForBreak();
  undoManager.push('Delete assembly',
    () => { _restoreFullSnapshotForBreak(before); _refreshSceneForActiveStep(); state.markDirty(); },
    () => { _restoreFullSnapshotForBreak(after);  _refreshSceneForActiveStep(); state.markDirty(); },
  );
  return true;
}

/**
 * Scan live tree + every step snapshot to figure out which native nodes
 * inside a model's subtree MUST be preserved (as Bbox or phantom folder)
 * because something outside the model depends on them.
 *
 * Preservation rules:
 *   • A native MESH is preserved (as Bbox) if it has any of:
 *       - cable anchor pointing to it (static, project-global)
 *       - note anchor pointing to it (live tree)
 *       - flatShape parented under it in ANY step
 *   • A native FOLDER is preserved (as transparent phantom group, no Bbox)
 *     if in ANY step it contains a foreign object (anything not in the
 *     model's native id set, except notes which anchor by meshId).
 *   • Ancestor native folders along the path to the model are also
 *     preserved so the tree stays intact.
 *   • The model node itself is always kept as a phantom wrapper.
 *
 * @returns {{
 *   nativeMeshIds: Set<string>,
 *   nativeFolderIds: Set<string>,
 *   meshesToBbox: Set<string>,
 *   foldersToPhantom: Set<string>
 * }}
 */
function _computeSmartDeleteKeepSets(modelNode) {
  // The model's own asset id — taken from the first native mesh we can
  // find inside its subtree. Used to tell native meshes (sourceAssetId
  // matches) from foreign guests (a different model's mesh dragged into
  // one of this model's folders).
  let modelAssetId = null;
  (function findAsset(n) {
    if (modelAssetId) return;
    if (n.type === 'mesh' && n.sourceAssetId) { modelAssetId = n.sourceAssetId; return; }
    if (n.children) for (const c of n.children) findAsset(c);
  })(modelNode);

  const nativeMeshIds   = new Set();
  const nativeFolderIds = new Set();
  const allNativeIds    = new Set([modelNode.id]);
  // Native folder/model definition: descendant of modelNode in the live
  // tree. We treat all folders inside the model's subtree as native
  // even if the user dragged foreign meshes into them — those foreign
  // meshes are guests, the folder itself still belongs to this model.
  //
  // Native mesh definition: descendant of modelNode AND its sourceAssetId
  // matches the model's. A foreign mesh dragged in keeps its original
  // sourceAssetId, so it fails this test and is correctly skipped.
  (function walk(n) {
    if (n.type === 'mesh') {
      // Strict match. Legacy meshes lacking sourceAssetId (very old saves)
      // fall back to "any mesh in subtree" — this matches the old behaviour
      // and is safer than dropping them silently.
      const isNative = modelAssetId
        ? n.sourceAssetId === modelAssetId || !n.sourceAssetId
        : true;
      if (isNative) { nativeMeshIds.add(n.id); allNativeIds.add(n.id); }
    } else if (n.type === 'folder') {
      nativeFolderIds.add(n.id);
      allNativeIds.add(n.id);
    } else if (n.type === 'model') {
      allNativeIds.add(n.id);
    }
    if (n.children) for (const c of n.children) walk(c);
  })(modelNode);

  const meshesToBbox     = new Set();
  const foldersToPhantom = new Set();

  // Cables — static, project-global. Anchored cable nodes pin the mesh.
  for (const cable of state.get('cables') || []) {
    for (const cn of cable.nodes || []) {
      if (cn.anchorType === 'mesh' && nativeMeshIds.has(cn.nodeId)) {
        meshesToBbox.add(cn.nodeId);
      }
    }
  }

  // Notes — anchored by meshId field on the note node (live tree).
  const liveRoot = state.get('treeData');
  if (liveRoot) {
    (function walkNotes(n) {
      if (n.type === 'note' && nativeMeshIds.has(n.anchorMeshId)) {
        meshesToBbox.add(n.anchorMeshId);
      }
      if (n.children) for (const c of n.children) walkNotes(c);
    })(liveRoot);
  }

  // Tree-spec scan: walk the live tree AND every step snapshot's tree to
  // detect (a) flatShape parented to a native node, (b) foreign-object
  // descendants of a native folder. ancestorNativeIds tracks the path of
  // native ancestor ids encountered so far so we can pin the closest one
  // when we spot a foreign / shape child.
  const scanSpec = (spec, ancestorNativeIds) => {
    if (!spec || !Array.isArray(spec.children)) return;
    for (const c of spec.children) {
      const isNative = allNativeIds.has(c.id);
      // Foreign-object detection: a child that is NOT native AND is not
      // a note (notes anchor by meshId, handled above). FlatShapes also
      // count as a dependency on the closest native ancestor — but they
      // do NOT count as a foreign-folder marker on their own; a folder
      // holding only shapes is still a "shape support" case which we
      // handle as the mesh/folder closest to the shape's parent.
      if (ancestorNativeIds.length && !isNative && c.type !== 'note') {
        const closest = ancestorNativeIds[ancestorNativeIds.length - 1];
        if (c.type === 'flatShape') {
          if (nativeMeshIds.has(closest))   meshesToBbox.add(closest);
          if (nativeFolderIds.has(closest)) foldersToPhantom.add(closest);
        } else {
          // Any other foreign object (mesh / folder / model from another
          // import) — closest native ancestor that's a folder must stay
          // to host it. If closest is a mesh (rare; foreign nested under
          // a native mesh) treat it the same as a shape-support: Bbox it.
          if (nativeFolderIds.has(closest)) foldersToPhantom.add(closest);
          if (nativeMeshIds.has(closest))   meshesToBbox.add(closest);
        }
      }
      const nextAncestors = isNative ? [...ancestorNativeIds, c.id] : ancestorNativeIds;
      scanSpec(c, nextAncestors);
    }
  };
  if (liveRoot) scanSpec(liveRoot, []);
  for (const step of state.get('steps') || []) {
    if (step?.snapshot?.tree) scanSpec(step.snapshot.tree, []);
  }

  // Pin ancestor native folders along the path from each kept folder up
  // to the model. Otherwise we'd remove an outer wrapper and orphan a
  // kept inner folder.
  const pinAncestorFolders = (id) => {
    const parent = findParent(liveRoot, id);
    if (!parent) return;
    if (nativeFolderIds.has(parent.id) && !foldersToPhantom.has(parent.id)) {
      foldersToPhantom.add(parent.id);
      pinAncestorFolders(parent.id);
    }
  };
  for (const fid of [...foldersToPhantom]) pinAncestorFolders(fid);
  for (const mid of meshesToBbox)          pinAncestorFolders(mid);

  return { nativeMeshIds, nativeFolderIds, meshesToBbox, foldersToPhantom };
}

/**
 * Apply the smart-delete plan to the live tree + scene.
 *   - Meshes in meshesToBbox: become Bbox phantoms (n.missing=true, geometry detached).
 *   - Meshes NOT in meshesToBbox: fully removed (node spliced, object3d detached, id maps cleared).
 *   - Folders in foldersToPhantom: kept as missing phantom groups (empty wrappers; foreign children stay attached).
 *   - Folders NOT in foldersToPhantom: fully removed.
 *   - Model node: always kept as a missing phantom wrapper.
 *   - Asset entry for the model is stripped.
 */
function _applySmartDelete(modelNode, keep) {
  const liveRoot = state.get('treeData');
  if (!liveRoot) return;
  let firstMeshAssetId = null;

  // Collect NATIVE nodes only — foreign children of native folders must
  // be left untouched (this is the whole point of the smart-delete). We
  // walk the full subtree of the model so deeply-nested natives are
  // found, but only act on ids that belong to this model's native set.
  // Track which ids are fully removed so we can strip them from step
  // snapshots and stop rebuildFromTreeSpec from resurrecting them.
  const meshes  = [];
  const folders = [];
  const removedIds = new Set();
  (function walk(n) {
    if (n.type === 'mesh'   && keep.nativeMeshIds.has(n.id))   meshes.push(n);
    if (n.type === 'folder' && keep.nativeFolderIds.has(n.id)) folders.push(n);
    if (n.children) for (const c of n.children) walk(c);
  })(modelNode);
  for (const m of meshes) if (!firstMeshAssetId && m.sourceAssetId) firstMeshAssetId = m.sourceAssetId;

  // ── Meshes ──────────────────────────────────────────────────────────
  for (const n of meshes) {
    const obj = steps.object3dById?.get(n.id) ?? n.object3d ?? null;
    if (keep.meshesToBbox.has(n.id)) {
      // Bbox phantom — same as the old "replace with ghost" path.
      if (obj) {
        obj.updateMatrix();
        // Recompute bounding box from LIVE (post-source-bake) geometry —
        // node.bbox was captured at import and is stale after a source
        // transform that scales vertices. Without this, the placeholder
        // would render at the pre-bake size.
        if (obj.geometry) {
          obj.geometry.computeBoundingBox();
          const bb = obj.geometry.boundingBox;
          if (bb && isFinite(bb.min.x) && isFinite(bb.max.x)) {
            n.bbox = {
              min: [bb.min.x, bb.min.y, bb.min.z],
              max: [bb.max.x, bb.max.y, bb.max.z],
            };
          }
        }
        n.placeholderTransform = {
          position:   [obj.position.x,   obj.position.y,   obj.position.z],
          quaternion: [obj.quaternion.x, obj.quaternion.y, obj.quaternion.z, obj.quaternion.w],
          scale:      [obj.scale.x,      obj.scale.y,      obj.scale.z],
        };
      }
      if (obj?.parent) obj.parent.remove(obj);
      n.object3d = null;
      n.missing  = true;
      steps.object3dById?.delete(n.id);
    } else {
      // Full purge — detach from tree + scene + id map.
      if (obj?.parent) obj.parent.remove(obj);
      steps.object3dById?.delete(n.id);
      const parent = _findNodeParent(liveRoot, n.id);
      if (parent?.children) parent.children = parent.children.filter(c => c.id !== n.id);
      removedIds.add(n.id);
    }
  }

  // ── Folders ─────────────────────────────────────────────────────────
  // Process deepest-first so children are gone before parents are removed.
  folders.sort((a, b) => _depthFromRoot(liveRoot, b.id) - _depthFromRoot(liveRoot, a.id));
  for (const n of folders) {
    if (keep.foldersToPhantom.has(n.id)) {
      // Kept folder — keep missing=true so cleanupFolderGroups PRESERVES
      // its Three.js Group across step activations (foreign children
      // don't churn parents on every step nav). Strip model-link fields
      // so the saved spec is a clean folder entry, not asset-tied.
      n.missing = true;
      delete n.sourceAssetId;
    } else {
      // Folder is empty of natives by now; foreign children (if any)
      // would have pinned it via foldersToPhantom, so this branch only
      // fires when the folder is truly empty / fully-native.
      const obj = steps.object3dById?.get(n.id) ?? n.object3d ?? null;
      if (obj) {
        // Move any unexpected surviving children up to the folder's
        // parent before removing the Group (defensive — should be
        // empty in practice).
        const parObj = obj.parent;
        while (obj.children.length && parObj) parObj.add(obj.children[0]);
        if (parObj) parObj.remove(obj);
      }
      steps.object3dById?.delete(n.id);
      const parent = _findNodeParent(liveRoot, n.id);
      if (parent?.children) parent.children = parent.children.filter(c => c.id !== n.id);
      removedIds.add(n.id);
    }
  }


  // ── Model wrapper ───────────────────────────────────────────────────
  // Decide whether to keep the model node as a regular folder (when
  // anything inside it matters — kept Bbox phantoms, kept folders, or
  // foreign-object guests) or fully remove it (when there's nothing to
  // preserve).
  //
  // The "keep as folder" path is what makes the structure persist
  // across save/load: a regular folder is round-tripped natively by
  // _insertPhantomCustomFolders; a missing-flagged model node is not.
  const hasNativeKeeps  = keep.foldersToPhantom.size > 0 || keep.meshesToBbox.size > 0;
  const hasForeignGuest = (modelNode.children || []).some(c =>
    !keep.nativeMeshIds.has(c.id) && !keep.nativeFolderIds.has(c.id) && c.id !== modelNode.id
  ) || (function hasGuestInSubtree(n) {
    for (const c of (n.children || [])) {
      const isNative = keep.nativeMeshIds.has(c.id) || keep.nativeFolderIds.has(c.id);
      if (!isNative && c.type !== 'note') return true;
      if (hasGuestInSubtree(c)) return true;
    }
    return false;
  })(modelNode);

  if (hasNativeKeeps || hasForeignGuest) {
    // Convert to folder so _insertPhantomCustomFolders on load can
    // round-trip the wrapper (it skips type==='model'). Keep
    // missing=true so cleanupFolderGroups doesn't rip its Three.js
    // Group on step nav — that Group still holds the loader-applied
    // baseLocal* transform (Y-up→Z-up flip etc.) which keeps every
    // kept descendant in their original world position. Strip the
    // model-specific fields so the saved spec is asset-free.
    modelNode.type    = 'folder';
    modelNode.missing = true;
    delete modelNode.assetId;
    delete modelNode.sourceAssetId;
    delete modelNode.sourceLocalPosition;
    delete modelNode.sourceLocalQuaternion;
    delete modelNode.sourceLocalScale;
  } else {
    // Nothing to keep — fully splice the model node out of tree + scene.
    const obj = steps.object3dById?.get(modelNode.id) ?? modelNode.object3d ?? null;
    if (obj?.parent) obj.parent.remove(obj);
    steps.object3dById?.delete(modelNode.id);
    const parent = _findNodeParent(liveRoot, modelNode.id);
    if (parent?.children) parent.children = parent.children.filter(c => c.id !== modelNode.id);
    removedIds.add(modelNode.id);
  }

  // ── Asset strip ─────────────────────────────────────────────────────
  if (firstMeshAssetId) {
    const assets = state.get('assets') || [];
    const next = assets.filter(a => a.id !== firstMeshAssetId);
    if (next.length !== assets.length) state.setState({ assets: next });
  }

  // ── Step snapshot strip + type-patch ────────────────────────────────
  // Step snapshots cache the serialised tree (id-keyed children specs).
  // Two passes here, run AFTER the model-wrapper conversion above so we
  // can see the final modelNode.type:
  //   1. Strip removed-node ids — else rebuildFromTreeSpec resurrects
  //      them as fresh empty Groups on next step nav.
  //   2. Patch the converted model node's spec entry from type='model'
  //      to type='folder' so rebuildFromTreeSpec treats it consistently
  //      with the live data (and doesn't clear missing on the model
  //      branch's `if (modelObj && node.missing) node.missing = false;`).
  const modelConverted = modelNode.type === 'folder';
  const patchSpec = (spec) => {
    if (!spec || !Array.isArray(spec.children)) return;
    spec.children = spec.children.filter(c => !removedIds.has(c.id));
    for (const c of spec.children) {
      if (modelConverted && c.id === modelNode.id && c.type === 'model') c.type = 'folder';
      patchSpec(c);
    }
  };
  for (const step of state.get('steps') || []) {
    if (step?.snapshot?.tree) patchSpec(step.snapshot.tree);
  }

  // Rebuild nodeById since we spliced nodes out.
  state.setState({ nodeById: _nodes_buildNodeMap(liveRoot) });
}

/** Depth of a node from the root (root depth = 0). Used for deepest-first folder removal. */
function _depthFromRoot(root, id) {
  let d = 0;
  let cur = findParent(root, id);
  while (cur) { d++; cur = findParent(root, cur.id); }
  return d;
}

// ─────────────────────────────────────────────────────────────────────
//  "Break dependencies" — purge model subtree and relocate deps
// ─────────────────────────────────────────────────────────────────────

/**
 * Scan a model's subtree for cables / notes / shapes that depend on
 * any node inside it. Used by the delete-assembly dialog to show
 * dependency counts upfront and to drive the "break dependencies"
 * relocation path.
 */
export function collectAssemblyDependents(modelId) {
  const empty = { cables: [], notes: [], shapes: [], meshIds: new Set(), folderIds: new Set(), subtreeIds: new Set() };
  const root = state.get('treeData');
  if (!root) return empty;
  const model = state.get('nodeById')?.get(modelId) ?? findNode(root, modelId);
  if (!model || model.type !== 'model') return empty;

  // Identify native meshes via sourceAssetId — foreign meshes dragged
  // into this model's folders keep their original assetId and must be
  // excluded so cable/note/shape counts only reflect THIS model's deps.
  let modelAssetId = null;
  const meshIds = new Set();
  const folderIds = new Set();
  const stack = [model];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'mesh') {
      if (!modelAssetId && n.sourceAssetId) modelAssetId = n.sourceAssetId;
    } else if (n.type === 'folder') {
      folderIds.add(n.id);
    }
    if (n.children) for (const c of n.children) stack.push(c);
  }
  // Second pass with the resolved asset id — gather native meshes only.
  const stack2 = [model];
  while (stack2.length) {
    const n = stack2.pop();
    if (n.type === 'mesh') {
      const isNative = modelAssetId
        ? n.sourceAssetId === modelAssetId || !n.sourceAssetId
        : true;
      if (isNative) meshIds.add(n.id);
    }
    if (n.children) for (const c of n.children) stack2.push(c);
  }
  const subtreeIds = new Set([...meshIds, ...folderIds, modelId]);

  // Cables — every cable that has at least one mesh-anchored node
  // pointing into the subtree. We keep the cable record + the list
  // of affected nodes so the executor only touches those.
  const cableDeps = [];
  for (const cable of (state.get('cables') || [])) {
    const affected = (cable.nodes || []).filter(n =>
      n.anchorType === 'mesh' && meshIds.has(n.nodeId)
    );
    if (affected.length) cableDeps.push({ cable, affectedNodes: affected });
  }

  // Notes — anchored to a mesh in the subtree.
  const noteDeps = [];
  const walkN = (n) => {
    if (n.type === 'note' && meshIds.has(n.anchorMeshId)) noteDeps.push(n);
    if (n.children) for (const c of n.children) walkN(c);
  };
  walkN(root);

  // Flat-shapes — parented under a node in the subtree, in the LIVE
  // tree or in ANY step snapshot. Shapes can move folder-to-folder per
  // step, so a shape that's anchored to a native folder only in step 3
  // still counts as a dependency. Dedupe by shape id so the count
  // matches the user's mental model ("how many shapes are tied to this
  // model").
  const shapeDepIds = new Set();
  const shapeDeps   = [];
  const walkS = (n, parent) => {
    if (n.type === 'flatShape' && parent && subtreeIds.has(parent.id)) {
      if (!shapeDepIds.has(n.id)) { shapeDepIds.add(n.id); shapeDeps.push(n); }
    }
    if (n.children) for (const c of n.children) walkS(c, n);
  };
  walkS(root, null);
  // Step snapshots only carry tree specs (id + type + children), not the
  // live node objects. Walk each spec and resolve hits back to live nodes
  // via nodeById so the dialog displays a coherent shape list.
  const nodeById = state.get('nodeById');
  const walkSpec = (spec, parentSpec) => {
    if (!spec) return;
    if (spec.type === 'flatShape' && parentSpec && subtreeIds.has(parentSpec.id)) {
      if (!shapeDepIds.has(spec.id)) {
        const live = nodeById?.get(spec.id);
        if (live) { shapeDepIds.add(spec.id); shapeDeps.push(live); }
      }
    }
    if (spec.children) for (const c of spec.children) walkSpec(c, spec);
  };
  for (const step of state.get('steps') || []) {
    if (step?.snapshot?.tree) walkSpec(step.snapshot.tree, null);
  }

  return { cables: cableDeps, notes: noteDeps, shapes: shapeDeps, meshIds, folderIds, subtreeIds };
}

/**
 * Option A executor: PURGE the model subtree entirely AND relocate
 * each dependency. Per-system policy (v1):
 *
 *   - Cables: each affected mesh-anchored node converts to a free
 *     anchor at its row slot (X = cumulative bbox*1.1 from origin,
 *     1×1×1 default bbox for cable/note items). The cable's other
 *     nodes stay where they are.
 *   - Notes: anchored to a deleted mesh are DELETED. They can't
 *     survive without an anchor in the current schema; the dialog
 *     surfaces the count upfront.
 *   - Shapes: re-parented to scene root with baseLocalPosition set
 *     to the row slot. baseLocalQuaternion reset to identity so the
 *     shape lies flat on world XY.
 *
 * Single undo entry. Snapshot is heavy (whole tree clone + cables +
 * assets + retained object3d refs) — per spec the user prefers
 * save-as for very large deletions, exposed as option D in the dialog.
 */
export function deleteTopLevelAssemblyAndBreak(modelId) {
  const root = state.get('treeData');
  if (!root) return false;
  const model = state.get('nodeById')?.get(modelId) ?? findNode(root, modelId);
  if (!model || model.type !== 'model') return false;

  const deps   = collectAssemblyDependents(modelId);
  const before = _captureFullSnapshotForBreak();

  // ── Row layout ──────────────────────────────────────────────────
  // Each affected cable-node + each affected shape gets a slot along
  // +X starting from origin. Notes are deleted so they take no slot.
  const SLOT = 1.1;
  const slots = [];
  let cursor = 0;
  for (const cd of deps.cables) {
    for (const node of cd.affectedNodes) {
      slots.push({ kind: 'cableNode', cableId: cd.cable.id, nodeId: node.id, x: cursor + 0.5 });
      cursor += SLOT;
    }
  }
  for (const shape of deps.shapes) {
    slots.push({ kind: 'shape', shapeId: shape.id, x: cursor + 0.5 });
    cursor += SLOT;
  }

  // ── Cables: detach affected nodes to free anchors at row spots ──
  const cables = state.get('cables') || [];
  for (const slot of slots) {
    if (slot.kind !== 'cableNode') continue;
    const cable = cables.find(c => c.id === slot.cableId);
    if (!cable) continue;
    const cnode = cable.nodes?.find(n => n.id === slot.nodeId);
    if (!cnode) continue;
    cnode.anchorType = 'free';
    cnode.position   = [slot.x, 0, 0];
    delete cnode.nodeId;
    delete cnode.anchorLocal;
    delete cnode.anchorBboxRelative;
    cnode.cachedWorldPos = [slot.x, 0, 0];
  }

  // ── Notes: splice out of the tree ───────────────────────────────
  for (const note of deps.notes) {
    const np = _findNodeParent(root, note.id);
    if (np?.children) np.children = np.children.filter(c => c.id !== note.id);
  }

  // ── Shapes: reparent to scene root at row spot ──────────────────
  for (const slot of slots) {
    if (slot.kind !== 'shape') continue;
    const shape = findNode(root, slot.shapeId);
    if (!shape) continue;
    const sp = _findNodeParent(root, slot.shapeId);
    if (sp?.children) sp.children = sp.children.filter(c => c.id !== slot.shapeId);
    root.children = root.children || [];
    root.children.push(shape);
    shape.baseLocalPosition    = [slot.x, 0, 0];
    shape.baseLocalQuaternion  = [0, 0, 0, 1];
    const shapeObj = shape.object3d ?? steps.object3dById?.get(slot.shapeId);
    if (shapeObj && sceneCore.rootGroup) {
      if (shapeObj.parent) shapeObj.parent.remove(shapeObj);
      sceneCore.rootGroup.add(shapeObj);
      shapeObj.position.set(slot.x, 0, 0);
      shapeObj.quaternion.identity();
      shapeObj.updateMatrixWorld(true);
    }
  }

  // ── Purge the model subtree from the tree + scene ───────────────
  const modelParent = _findNodeParent(root, modelId);
  if (modelParent?.children) {
    modelParent.children = modelParent.children.filter(c => c.id !== modelId);
  }
  const objStack = [model];
  while (objStack.length) {
    const n = objStack.pop();
    const obj = steps.object3dById?.get(n.id) ?? n.object3d ?? null;
    if (obj?.parent) obj.parent.remove(obj);
    steps.object3dById?.delete(n.id);
    if (n.children) for (const c of n.children) objStack.push(c);
  }

  // ── Strip asset entry ───────────────────────────────────────────
  const firstMesh = _findFirstMeshInSubtree(model);
  if (firstMesh?.sourceAssetId) {
    const assets = state.get('assets') || [];
    const next = assets.filter(a => a.id !== firstMesh.sourceAssetId);
    if (next.length !== assets.length) state.setState({ assets: next });
  }

  // ── Refresh ─────────────────────────────────────────────────────
  state.setState({ cables: [...cables], nodeById: _nodes_buildNodeMap(root) });
  state.emit('change:cables', cables);
  state.emit('change:treeData', root);
  _refreshSceneForActiveStep();
  state.markDirty();

  // ── Undo / redo ─────────────────────────────────────────────────
  const after = _captureFullSnapshotForBreak();
  undoManager.push('Delete assembly (break dependencies)',
    () => { _restoreFullSnapshotForBreak(before); _refreshSceneForActiveStep(); state.markDirty(); },
    () => { _restoreFullSnapshotForBreak(after);  _refreshSceneForActiveStep(); state.markDirty(); },
  );
  return true;
}

/** Find the first mesh node anywhere in a subtree (for asset id lookup). */
function _findFirstMeshInSubtree(rootNode) {
  if (!rootNode) return null;
  const stack = [rootNode];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'mesh') return n;
    if (n.children) for (const c of n.children) stack.push(c);
  }
  return null;
}

/**
 * Snapshot the whole project state we touch in option A: tree (sans
 * object3d), cables, assets, and a map of mesh-id → object3d so we
 * can re-attach geometry on undo without re-loading the source file.
 */
function _captureFullSnapshotForBreak() {
  const root = state.get('treeData');
  const obj3dMap = new Map();
  const obj3dParentMap = new Map();
  const obj3dTransformMap = new Map();
  const walk = (n) => {
    const obj = steps.object3dById?.get(n.id) ?? n.object3d ?? null;
    if (obj) {
      obj3dMap.set(n.id, obj);
      if (obj.parent) obj3dParentMap.set(n.id, obj.parent);
      obj3dTransformMap.set(n.id, {
        position:   [obj.position.x, obj.position.y, obj.position.z],
        quaternion: [obj.quaternion.x, obj.quaternion.y, obj.quaternion.z, obj.quaternion.w],
        scale:      [obj.scale.x, obj.scale.y, obj.scale.z],
      });
    }
    if (n.children) for (const c of n.children) walk(c);
  };
  if (root) walk(root);
  // Step snapshots — capture only their .snapshot (the part we mutate
  // when stripping removed ids from snapshot.tree). Other step fields
  // (id, name, thumbnail, transitions, …) stay live and don't need to
  // round-trip through the undo log.
  const stepSnapshots = (state.get('steps') || []).map(s =>
    s?.snapshot ? { id: s.id, snapshot: JSON.parse(JSON.stringify(s.snapshot)) } : { id: s.id, snapshot: null }
  );
  return {
    treeJSON:  root ? _cloneTreeWithoutObject3d(root) : null,
    cables:    JSON.parse(JSON.stringify(state.get('cables') || [])),
    assets:    JSON.parse(JSON.stringify(state.get('assets') || [])),
    stepSnapshots,
    obj3dMap,
    obj3dParentMap,
    obj3dTransformMap,
  };
}

/**
 * Deep-clone a tree node for delete-assembly / break / similar undo
 * snapshots. Drops object3d (Three.js refs aren't JSON-safe).
 *
 * V0.1.71 — bulletproofed against:
 *   - cycles  (was: JSON.stringify on a userData-cached EdgesGeometry
 *     closed a cycle via .parameters.geometry → broke save + delete-
 *     assembly. V0.1.70 moved the cache to a WeakMap, but…)
 *   - size    (then: any other node field referencing a BufferGeometry's
 *     typed-array attributes serialised to a multi-GB string and tripped
 *     V8's max-string-length limit).
 *
 * Strategy: explicit whitelist for primitive types + arrays of primitives;
 * objects pass through _safePlainClone which detects and DROPS Three.js
 * references (anything with .isObject3D / .isBufferGeometry / .isMaterial
 * / .isTexture). Underscore-prefixed keys are treated as transient and
 * dropped too — projects already use that convention for caches like
 * _anim and _preservedNotesForRebuild.
 */
function _cloneTreeWithoutObject3d(node) {
  if (!node) return null;
  const out = {};
  for (const k in node) {
    if (k === 'object3d') continue;
    if (k.startsWith('_')) continue;
    const v = node[k];
    if (v == null) {
      out[k] = v;
    } else if (k === 'children') {
      out[k] = Array.isArray(v) ? v.map(_cloneTreeWithoutObject3d) : [];
    } else if (Array.isArray(v)) {
      out[k] = v.map(it => _safePlainClone(it));
    } else if (typeof v === 'object') {
      out[k] = _safePlainClone(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Plain deep-clone that detects + drops Three.js refs. Used by
 * _cloneTreeWithoutObject3d for any object-typed node field.
 */
function _safePlainClone(v, depth = 0) {
  if (v == null) return v;
  if (typeof v !== 'object') return v;
  if (depth > 32) return null;          // sanity cap
  // Drop Three.js refs of any kind.
  if (v.isObject3D || v.isBufferGeometry || v.isMaterial ||
      v.isTexture || v.isCamera || v.isLight || v.isScene) return null;
  // Drop typed arrays — these would JSON-serialise as huge object maps.
  if (ArrayBuffer.isView(v)) return Array.from(v);
  if (Array.isArray(v)) return v.map(it => _safePlainClone(it, depth + 1));
  const out = {};
  for (const k in v) {
    if (k.startsWith('_')) continue;
    out[k] = _safePlainClone(v[k], depth + 1);
  }
  return out;
}

/** Restore tree + cables + assets from a snapshot, re-attach object3ds. */
function _restoreFullSnapshotForBreak(snap) {
  if (!snap) return;
  // Tree first — replace treeData with the clone (now without object3d).
  if (snap.treeJSON) {
    state.setState({ treeData: snap.treeJSON });
    // Re-attach object3d refs onto the freshly-restored nodes.
    const newRoot = state.get('treeData');
    const walk = (n) => {
      const obj = snap.obj3dMap.get(n.id);
      if (obj) {
        n.object3d = obj;
        steps.object3dById?.set(n.id, obj);
        // Re-attach to its original parent + restore local transform.
        const par = snap.obj3dParentMap.get(n.id);
        if (par && obj.parent !== par) {
          if (obj.parent) obj.parent.remove(obj);
          par.add(obj);
        }
        const tr = snap.obj3dTransformMap.get(n.id);
        if (tr) {
          obj.position.set(tr.position[0], tr.position[1], tr.position[2]);
          obj.quaternion.set(tr.quaternion[0], tr.quaternion[1], tr.quaternion[2], tr.quaternion[3]);
          obj.scale.set(tr.scale[0], tr.scale[1], tr.scale[2]);
          obj.updateMatrixWorld(true);
        }
      }
      if (n.children) for (const c of n.children) walk(c);
    };
    if (newRoot) walk(newRoot);
    state.setState({ nodeById: _nodes_buildNodeMap(newRoot) });
    state.emit('change:treeData', newRoot);
  }
  state.setState({ cables: snap.cables.map(c => JSON.parse(JSON.stringify(c))) });
  state.emit('change:cables', state.get('cables'));
  state.setState({ assets: snap.assets.map(a => JSON.parse(JSON.stringify(a))) });
  // Restore step snapshots — smart-delete mutates snapshot.tree to strip
  // removed ids; without this restore, undo would put the live tree back
  // but step navigation would still see the stripped specs.
  if (Array.isArray(snap.stepSnapshots)) {
    const live = state.get('steps') || [];
    const byId = new Map(live.map(s => [s.id, s]));
    for (const entry of snap.stepSnapshots) {
      const s = byId.get(entry.id);
      if (s) s.snapshot = entry.snapshot ? JSON.parse(JSON.stringify(entry.snapshot)) : null;
    }
  }
}

/** Re-apply the active step's snapshot so phantoms get their Bbox placeholders built. */
function _refreshSceneForActiveStep() {
  const id = state.get('activeStepId');
  if (id) steps.activateStep(id, false).catch(() => {});
  else    steps.scheduleTransformSync();
}

// ═══════════════════════════════════════════════════════════════════════════
//  PASTE TREE (R-click scene root → Copy tree / Paste tree)
// ═══════════════════════════════════════════════════════════════════════════
//
// v1 scope (B.1, B.2, C.1 per design):
//   addOnly    — add source's missing folders into target; objects stay put
//   addAndMove — add missing folders AND move every shared id to source's parent
//   moveOnly   — trees structurally match; just re-parent shared ids per source
//
// Folder REMOVALS (target has folders source doesn't) are out of v1 scope —
// the caller blocks that case before invoking pasteTreeApply.
//
// Scope rules:
//   - target = exactly one step (active step). Base step is rejected.
//   - per-step mutation only. snapshot.tree replaced; rebuildFromTreeSpec
//     handles the live tree.
//   - one undo entry covers the whole paste.
//   - transforms = cascade only. Live nodes keep their existing baseLocal*;
//     world positions shift to follow their new parent chain.
//   - cables follow mesh ids automatically (anchor-by-id).
//   - shapes' tree position changes follow source-side parent (so a shape
//     parented to a mesh in source ends up on that mesh in target; in-folder
//     in source ends up in that folder in target).

/**
 * Compute the structural diff between two snapshot.tree specs.
 * @returns {{ addedFolders: string[], removedFolders: string[], movedObjects: Array<{id,type}> }}
 */
export function diffTreeSpec(source, target) {
  const sourceMap = new Map();   // id → { type, parentId }
  const targetMap = new Map();
  const walk = (spec, parentId, out) => {
    if (!spec) return;
    out.set(spec.id, { type: spec.type, parentId });
    for (const c of (spec.children || [])) walk(c, spec.id, out);
  };
  walk(source, null, sourceMap);
  walk(target, null, targetMap);

  const addedFolders   = [];
  const removedFolders = [];
  const movedObjects   = [];

  for (const [id, info] of sourceMap) {
    if (info.type === 'folder' && !targetMap.has(id)) addedFolders.push(id);
  }
  for (const [id, info] of targetMap) {
    if (info.type === 'folder' && !sourceMap.has(id)) removedFolders.push(id);
    if (info.type !== 'folder' && info.type !== 'scene' && sourceMap.has(id)) {
      const s = sourceMap.get(id);
      if (s.parentId !== info.parentId) movedObjects.push({ id, type: info.type });
    }
  }
  return { addedFolders, removedFolders, movedObjects };
}

/**
 * Apply a copied source snapshot to a target step's snapshot per the
 * chosen option. Top-down build avoids cycle hazards from in-place moves.
 *
 * Options:
 *   - addOnly                 — add source's missing folders; objects stay put
 *   - addAndMoveCascade       — add folders + move objects to source-side parents;
 *                               local transforms unchanged → world shifts
 *   - addAndMovePreserve      — add folders + move objects; world matrices preserved
 *                               via wrapper compensation folders
 *   - moveCascade             — trees match structurally; move objects (cascade)
 *   - movePreserve            — trees match structurally; move objects (preserve)
 *   - addRemoveMoveCascade    — add missing folders + remove empty source-missing
 *                               folders + move (cascade)
 *   - addRemoveMovePreserve   — same as above + preserve-world wrappers
 *
 * Carries source's transforms/visibility/folderBases for ADDED folders;
 * SHARED ids keep target's existing transforms (cascade) UNLESS preserve-world
 * is enabled. When remove is on, target folders absent from source are
 * pruned IF empty after the move pass (orphan-protected — folders with
 * non-source-known children stay, no orphans).
 *
 * @param {string}  stepId          target step id (must NOT be the base step)
 * @param {object}  sourceSnapshot  { tree, transforms, visibility, folderBases }
 * @param {string}  option          one of the option codes above
 * @returns {boolean} true on success
 */
export function pasteTreeApply(stepId, sourceSnapshot, option) {
  if (!stepId || !sourceSnapshot?.tree) return false;
  const stepsArr = state.get('steps') || [];
  const step = stepsArr.find(s => s.id === stepId);
  if (!step?.snapshot?.tree) return false;
  if (step.isBaseStep) return false;

  const flags     = _pasteOptionFlags(option);
  const move      = flags.move;
  const preserve  = flags.preserve;
  const removeOn  = flags.remove;

  const diff = diffTreeSpec(sourceSnapshot.tree, step.snapshot.tree);
  // Only reject when removals exist AND the user picked a non-remove option.
  if (diff.removedFolders.length > 0 && !removeOn) return false;

  // ── Capture pre-mutation parent world matrices for preserve-world ───
  // We use the wrapper-folder approach: each moving id gets a fresh
  // compensation folder inserted between its source-side parent and itself.
  // The wrapper's local matrix = inv(new_parent.world) × old_parent.world,
  // which makes the moved object's world matrix invariant without touching
  // the object's own transform. (Mesh nodes don't carry transforms — only
  // folder/model/flatShape do — so the math has to live on a folder.)
  let movingIds = null;
  let oldParentWorlds = null;
  if (preserve && move) {
    movingIds = _computeMovingIdsForPaste(sourceSnapshot.tree, step.snapshot.tree);
    oldParentWorlds = _captureMovingParentWorlds(movingIds);
  }

  // Capture full before-state for undo (tree + per-step transforms + visibility
  // + each touched folder's live baseLocal* fields + per-object preserve-world
  // wrapper data).
  const beforeTree        = JSON.parse(JSON.stringify(step.snapshot.tree));
  const beforeTransforms  = JSON.parse(JSON.stringify(step.snapshot.transforms || {}));
  const beforeVisibility  = JSON.parse(JSON.stringify(step.snapshot.visibility || {}));
  const beforeFolderBases = _captureFolderBases(diff.addedFolders);

  // ── Tree spec ───────────────────────────────────────────────────────
  let newTree = _buildPastedTreeSpec(sourceSnapshot.tree, step.snapshot.tree, option);

  // For preserve-world: wrap each moving id with a fresh compensation
  // folder spec INSIDE newTree before we hand the tree off. The wrapper
  // sits between source-side parent and the moved object — its identity
  // local at this point gets overwritten with the actual compensation
  // after applySnapshotInstant has computed new world matrices.
  let compMap = null;
  if (preserve && move && movingIds && movingIds.size > 0) {
    compMap = _wrapWithCompensationFolders(newTree, movingIds);
  }

  step.snapshot.tree = newTree;

  // ── Added-folder state replay ───────────────────────────────────────
  // Per-step transforms + visibility ride along in step.snapshot.*; the
  // project-global baseLocal* fields go directly onto each live folder
  // node so they take effect on the next applyAllTransformsToScene pass.
  step.snapshot.transforms = step.snapshot.transforms || {};
  step.snapshot.visibility = step.snapshot.visibility || {};
  for (const id of diff.addedFolders) {
    if (sourceSnapshot.transforms?.[id]) {
      step.snapshot.transforms[id] = JSON.parse(JSON.stringify(sourceSnapshot.transforms[id]));
    }
    if (sourceSnapshot.visibility && Object.prototype.hasOwnProperty.call(sourceSnapshot.visibility, id)) {
      step.snapshot.visibility[id] = sourceSnapshot.visibility[id];
    }
  }

  // Apply spec → live first so the folder nodes exist in nodeById, then
  // stamp baseLocal* on those live nodes and re-push transforms to Three.js
  // so the world poses reflect the full picture.
  const isActive = state.get('activeStepId') === stepId;
  if (isActive) {
    steps.applySnapshotInstant(step.snapshot);
    _applyFolderBases(diff.addedFolders, sourceSnapshot.folderBases || {});
    // Preserve-world: write compensation transforms onto each newly-created
    // wrapper folder so the moved object's world matrix matches the
    // pre-paste pose. Persists via step.snapshot.transforms.
    if (preserve && compMap && oldParentWorlds) {
      _applyCompensationFolders(compMap, oldParentWorlds, step);
    }
    state.emit('change:treeData', state.get('treeData'));
  }
  state.markDirty();

  // Captures for redo (AFTER preserve-world back-solve so it's part of state).
  const afterTree       = JSON.parse(JSON.stringify(newTree));
  const afterTransforms = JSON.parse(JSON.stringify(step.snapshot.transforms || {}));
  const afterVisibility = JSON.parse(JSON.stringify(step.snapshot.visibility || {}));
  const afterFolderBases = _captureFolderBases(diff.addedFolders);

  undoManager.push('Paste tree',
    () => {
      const s = (state.get('steps') || []).find(x => x.id === stepId);
      if (!s) return;
      s.snapshot.tree        = JSON.parse(JSON.stringify(beforeTree));
      s.snapshot.transforms  = JSON.parse(JSON.stringify(beforeTransforms));
      s.snapshot.visibility  = JSON.parse(JSON.stringify(beforeVisibility));
      if (state.get('activeStepId') === stepId) {
        steps.applySnapshotInstant(s.snapshot);
        _applyFolderBases(diff.addedFolders, beforeFolderBases);
        state.emit('change:treeData', state.get('treeData'));
      }
      state.markDirty();
    },
    () => {
      const s = (state.get('steps') || []).find(x => x.id === stepId);
      if (!s) return;
      s.snapshot.tree        = JSON.parse(JSON.stringify(afterTree));
      s.snapshot.transforms  = JSON.parse(JSON.stringify(afterTransforms));
      s.snapshot.visibility  = JSON.parse(JSON.stringify(afterVisibility));
      if (state.get('activeStepId') === stepId) {
        steps.applySnapshotInstant(s.snapshot);
        _applyFolderBases(diff.addedFolders, afterFolderBases);
        state.emit('change:treeData', state.get('treeData'));
      }
      state.markDirty();
    },
  );

  // Audit the result — paste is the main vector for home-anchor drift,
  // and the safety filter at copy time is best-effort. The verifier
  // logs to console; it doesn't toast unless drift is actually found.
  try { verifyHomePositions(); } catch (err) { console.warn('[home-verifier] post-paste check failed:', err); }

  return true;
}

/**
 * Collect every id that is in BOTH source and target spec but has a different
 * parent — these are the ids whose tree position changes when we paste.
 * Includes folders, meshes, flatShapes, anything except the scene root.
 */
function _computeMovingIdsForPaste(sourceTree, targetTree) {
  const sourceParent = new Map();
  const targetParent = new Map();
  const walk = (spec, parentId, out) => {
    if (!spec) return;
    out.set(spec.id, parentId);
    for (const c of (spec.children || [])) walk(c, spec.id, out);
  };
  walk(sourceTree, null, sourceParent);
  walk(targetTree, null, targetParent);

  const moving = new Set();
  for (const [id, sourceP] of sourceParent) {
    if (!targetParent.has(id)) continue;
    if (sourceP === null)      continue;
    if (targetParent.get(id) !== sourceP) moving.add(id);
  }
  return moving;
}

/** Snapshot each moving id's PARENT matrixWorld pre-mutation. */
function _captureMovingParentWorlds(ids) {
  const THREE = window.THREE;
  const out = new Map();
  if (!THREE) return out;
  for (const id of ids) {
    const obj = steps.object3dById?.get(id);
    if (!obj?.parent) continue;
    obj.parent.updateMatrixWorld(true);
    out.set(id, obj.parent.matrixWorld.clone());
  }
  return out;
}

/**
 * Walk newTree and replace each moving id's spec position with a fresh
 * compensation folder spec. Mutates newTree in place. Returns a Map of
 * movingId → compFolderId so _applyCompensationFolders can find its
 * partner after the rebuild.
 */
function _wrapWithCompensationFolders(newTree, movingIds) {
  const compMap = new Map();
  const walk = (parentSpec) => {
    if (!parentSpec || !Array.isArray(parentSpec.children)) return;
    // Walk in-place. Replace any moving child with a wrapper folder spec
    // that contains the original moving child.
    for (let i = 0; i < parentSpec.children.length; i++) {
      const child = parentSpec.children[i];
      if (movingIds.has(child.id)) {
        const compId = generateId('folder');
        const compSpec = {
          id:           compId,
          name:         '↻ preserved',
          type:         'folder',
          localVisible: true,
          children:     [child],
        };
        parentSpec.children[i] = compSpec;
        compMap.set(child.id, compId);
        // Don't recurse into the wrapper's child — the wrap is the leaf
        // of this branch as far as further moves are concerned.
      } else {
        walk(child);
      }
    }
  };
  walk(newTree);
  return compMap;
}

/**
 * After applySnapshotInstant has rebuilt the live tree (including the
 * fresh compensation-folder Groups, all at identity), compute and apply
 * each wrapper's compensation transform so the wrapped object's world
 * matrix matches its pre-paste pose.
 *
 *   compFolder.local = inv(newParent.world) × oldParent.world
 *
 * Writes to the compensation folder's per-step localOffset/localQuaternion
 * and persists into step.snapshot.transforms[compId] so step navigation
 * away and back to this step preserves the world position.
 *
 * Scale limitation: only position + rotation are persisted via
 * snapshot.transforms; non-uniform scale on the source-side parent (rare
 * in SBS) would shift world scale after step navigation. Position +
 * rotation are by far the common case.
 */
function _applyCompensationFolders(compMap, oldParentWorlds, step) {
  const THREE = window.THREE;
  if (!THREE) return;
  const nodeById = state.get('nodeById');
  if (!nodeById) return;

  const tmp       = new THREE.Matrix4();
  const invParent = new THREE.Matrix4();
  const pos       = new THREE.Vector3();
  const quat      = new THREE.Quaternion();
  const scale     = new THREE.Vector3();

  for (const [movingId, compId] of compMap) {
    const oldParWorld = oldParentWorlds.get(movingId);
    if (!oldParWorld) continue;

    const compObj  = steps.object3dById?.get(compId);
    const compNode = nodeById.get(compId);
    if (!compObj || !compNode) continue;

    const newParent = compObj.parent;
    if (!newParent) continue;
    newParent.updateMatrixWorld(true);

    invParent.copy(newParent.matrixWorld).invert();
    tmp.copy(invParent).multiply(oldParWorld);
    tmp.decompose(pos, quat, scale);

    // Wrapper is fresh — baseLocal* defaults are identity (ensureTransformDefaults
    // sets them when applyNodeTransformToObject3D runs). Stash everything in
    // localOffset/localQuaternion so it round-trips via snapshot.transforms.
    compNode.localOffset     = [pos.x, pos.y, pos.z];
    compNode.localQuaternion = [quat.x, quat.y, quat.z, quat.w];

    applyNodeTransformToObject3D(compNode, compObj);

    step.snapshot.transforms = step.snapshot.transforms || {};
    step.snapshot.transforms[compId] = {
      localOffset:          [pos.x, pos.y, pos.z],
      localQuaternion:      [quat.x, quat.y, quat.z, quat.w],
      orientationSteps:     [0, 0, 0],
      pivotLocalOffset:     [0, 0, 0],
      pivotLocalQuaternion: [0, 0, 0, 1],
      moveEnabled:          true,
      rotateEnabled:        true,
      pivotEnabled:         false,
    };
  }
}

/** Capture current baseLocal* on the live folder nodes named in `ids`. */
function _captureFolderBases(ids) {
  const out = {};
  const nodeById = state.get('nodeById');
  if (!nodeById) return out;
  for (const id of ids) {
    const n = nodeById.get(id);
    if (n?.type !== 'folder') continue;
    out[id] = {
      baseLocalPosition:   [...(n.baseLocalPosition   || [0, 0, 0])],
      baseLocalQuaternion: [...(n.baseLocalQuaternion || [0, 0, 0, 1])],
      baseLocalScale:      [...(n.baseLocalScale      || [1, 1, 1])],
    };
  }
  return out;
}

/**
 * Write baseLocal* fields onto live folder nodes from the captured map,
 * then push the new local transform to Three.js. Called after
 * applySnapshotInstant has rebuilt the fresh folder Group at identity.
 */
function _applyFolderBases(ids, bases) {
  if (!bases) return;
  const nodeById = state.get('nodeById');
  if (!nodeById) return;
  for (const id of ids) {
    const n = nodeById.get(id);
    if (n?.type !== 'folder') continue;
    const b = bases[id];
    if (!b) continue;
    n.baseLocalPosition   = [...b.baseLocalPosition];
    n.baseLocalQuaternion = [...b.baseLocalQuaternion];
    n.baseLocalScale      = [...b.baseLocalScale];
    const obj = steps.object3dById?.get(id) ?? n.object3d;
    if (obj) applyNodeTransformToObject3D(n, obj);
  }
}

/**
 * Build a new snapshot.tree spec by taking target as the base and applying
 * the chosen merge option. Top-down construction — each id's parent is
 * looked up (not mutated), so cycles can't form even if source and target
 * disagree about ancestry on the same id.
 */
/**
 * Capability flags for each paste-tree option string. Single source of
 * truth — every function that branches on the option string reads from here.
 */
const _PASTE_OPTION_FLAGS = {
  addOnly:                 { add: true,  move: false, preserve: false, remove: false },
  addAndMoveCascade:       { add: true,  move: true,  preserve: false, remove: false },
  addAndMovePreserve:      { add: true,  move: true,  preserve: true,  remove: false },
  moveCascade:             { add: false, move: true,  preserve: false, remove: false },
  movePreserve:            { add: false, move: true,  preserve: true,  remove: false },
  addRemoveMoveCascade:    { add: true,  move: true,  preserve: false, remove: true  },
  addRemoveMovePreserve:   { add: true,  move: true,  preserve: true,  remove: true  },
};
function _pasteOptionFlags(option) {
  return _PASTE_OPTION_FLAGS[option] || _PASTE_OPTION_FLAGS.addOnly;
}

function _buildPastedTreeSpec(source, target, option) {
  const flags    = _pasteOptionFlags(option);
  const move     = flags.move;
  const add      = flags.add;
  const removeOn = flags.remove;

  const sourceById   = new Map();
  const sourceParent = new Map();
  (function walk(spec, parentId) {
    if (!spec) return;
    sourceById.set(spec.id, spec);
    sourceParent.set(spec.id, parentId);
    for (const c of (spec.children || [])) walk(c, spec.id);
  })(source, null);

  const targetById   = new Map();
  const targetParent = new Map();
  (function walk(spec, parentId) {
    if (!spec) return;
    targetById.set(spec.id, spec);
    targetParent.set(spec.id, parentId);
    for (const c of (spec.children || [])) walk(c, spec.id);
  })(target, null);

  // ── Build the new spec map ──────────────────────────────────────────
  // Clone target's scene root first (children filled in by attach pass below).
  const newRoot = _cloneSpecEntry(target);
  const newSpecById = new Map([[newRoot.id, newRoot]]);

  for (const [id, t] of targetById) {
    if (id === newRoot.id) continue;
    newSpecById.set(id, _cloneSpecEntry(t));
  }

  if (add) {
    // Insert source-only folders. Their data is minimal (id/name/type/visible)
    // — full transforms live on the live folder node in nodeById and survive
    // the rebuildFromTreeSpec pass triggered by applySnapshotInstant.
    for (const [id, s] of sourceById) {
      if (s.type !== 'folder') continue;
      if (newSpecById.has(id)) continue;
      newSpecById.set(id, {
        id:           s.id,
        name:         s.name || 'Folder',
        type:         'folder',
        localVisible: s.localVisible !== false,
        children:     [],
      });
    }
  }

  // ── Attach pass ─────────────────────────────────────────────────────
  // For each non-root spec, decide its parent:
  //   - move enabled + id in source → use source's parent
  //   - added folder (source-only)  → use source's parent
  //   - otherwise                   → keep target's parent
  // Children arrays already initialised in clone helper.
  for (const [id, spec] of newSpecById) {
    if (id === newRoot.id) continue;

    let parentId;
    if (move && sourceById.has(id)) {
      parentId = sourceParent.get(id);
    } else if (add && sourceById.has(id) && !targetById.has(id)) {
      parentId = sourceParent.get(id);
    } else {
      parentId = targetParent.get(id) ?? newRoot.id;
    }

    const parent = newSpecById.get(parentId) ?? newRoot;
    parent.children.push(spec);
  }

  // ── Empty-folder prune (B.3/B.4 remove path) ────────────────────────
  // Target folders that source doesn't have are candidates for removal.
  // We only drop them when they're empty AFTER the attach pass — that way
  // any orphan child (something target has but source doesn't reference)
  // keeps its parent, no dangling. Bottom-up so a folder whose only kids
  // are also being pruned gets pruned this same call.
  if (removeOn) {
    const pruneEmpty = (spec) => {
      if (!Array.isArray(spec.children)) return;
      for (const c of spec.children) pruneEmpty(c);
      spec.children = spec.children.filter(c => {
        if (c.type !== 'folder')   return true;
        if (sourceById.has(c.id))  return true;
        return (c.children || []).length > 0;
      });
    };
    pruneEmpty(newRoot);
  }

  return newRoot;
}

/** Clone the structural fields of a snapshot.tree spec entry (no children). */
function _cloneSpecEntry(spec) {
  const out = {
    id:           spec.id,
    name:         spec.name || '',
    type:         spec.type,
    localVisible: spec.localVisible !== false,
    children:     [],
  };
  if (spec.bbox)                 out.bbox                 = spec.bbox;
  if (spec.fingerprint)          out.fingerprint          = spec.fingerprint;
  if (spec.placeholderTransform) out.placeholderTransform = spec.placeholderTransform;
  if (spec.missing != null)      out.missing              = spec.missing;
  if (spec.sourceAssetId)        out.sourceAssetId        = spec.sourceAssetId;
  if (spec.meshIndex != null)    out.meshIndex            = spec.meshIndex;
  return out;
}

/**
 * Delete a template and every instance referencing it (cascade).
 * Asks for confirmation when there are live instances.
 */
export function deleteShapeTemplate(templateId, { skipConfirm = false } = {}) {
  const tpl = (state.get('shapeTemplates') || []).find(t => t.id === templateId);
  if (!tpl) return false;

  const root = state.get('treeData');
  const instanceIds = [];
  if (root) {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (n.type === 'flatShape' && n.templateId === templateId) instanceIds.push(n.id);
      if (n.children) for (const c of n.children) stack.push(c);
    }
  }

  if (!skipConfirm && instanceIds.length > 0) {
    const ok = confirm(
      `Delete "${tpl.name || 'shape'}"? ${instanceIds.length} placed instance(s) will be removed too.`,
    );
    if (!ok) return false;
  }

  // Snapshot for undo
  const prevTpl   = JSON.parse(JSON.stringify(tpl));
  const prevSteps = JSON.parse(JSON.stringify(state.get('steps') || []));

  // Remove instances
  for (const id of instanceIds) _removeShapeInstance(id);

  // Remove template
  state.setState({
    shapeTemplates: (state.get('shapeTemplates') || []).filter(t => t.id !== templateId),
  });
  state.markDirty();

  const nextTplList = state.get('shapeTemplates');
  const nextSteps   = JSON.parse(JSON.stringify(state.get('steps') || []));

  undoManager.push(`Delete shape "${tpl.name || ''}"`,
    () => {
      // Restore template + every step snapshot to its pre-delete state.
      // Instances re-mount on the next step activation via rebuildFromTreeSpec.
      state.setState({
        shapeTemplates: [...nextTplList, prevTpl],
        steps:          prevSteps,
      });
      state.markDirty();
      state.emit('change:treeData', state.get('treeData'));
    },
    () => {
      state.setState({ shapeTemplates: nextTplList, steps: nextSteps });
      state.markDirty();
    },
  );
  return true;
}

/** Rename a template. Undoable. */
export function setShapeTemplateName(templateId, name) {
  const list = state.get('shapeTemplates') || [];
  const tpl  = list.find(t => t.id === templateId);
  if (!tpl) return;
  const prev = tpl.name;
  if (prev === name) return;
  state.setState({
    shapeTemplates: list.map(t => t.id === templateId ? { ...t, name } : t),
  });
  state.markDirty();
  undoManager.push('Rename shape',
    () => {
      const cur = state.get('shapeTemplates') || [];
      state.setState({ shapeTemplates: cur.map(t => t.id === templateId ? { ...t, name: prev } : t) });
      state.markDirty();
    },
    () => {
      const cur = state.get('shapeTemplates') || [];
      state.setState({ shapeTemplates: cur.map(t => t.id === templateId ? { ...t, name } : t) });
      state.markDirty();
    },
  );
}

/** Recolour a template. Rebuilds every instance's mesh on undo/redo too. */
export function setShapeTemplateFill(templateId, fill) {
  const list = state.get('shapeTemplates') || [];
  const tpl  = list.find(t => t.id === templateId);
  if (!tpl) return;
  const prev = tpl.fill;
  if (prev === fill) return;

  const apply = (nextFill) => {
    state.setState({
      shapeTemplates: (state.get('shapeTemplates') || []).map(t =>
        t.id === templateId ? { ...t, fill: nextFill } : t,
      ),
    });
    const root = state.get('treeData');
    if (root) _rebuildInstancesOfTemplate(root, steps.object3dById, templateId);
    state.emit('change:treeData', root);
    state.markDirty();
  };
  apply(fill);

  undoManager.push('Recolour shape',
    () => apply(prev),
    () => apply(fill),
  );
}

// ── Private shape helpers ────────────────────────────────────────────────

function _removeShapeInstance(instanceId) {
  const root = state.get('treeData');
  if (!root) return;
  const node = state.get('nodeById')?.get(instanceId);
  if (!node) return;

  // Detach mesh + dispose
  disposeFlatShape(node);
  steps.object3dById.delete(instanceId);

  // Splice from parent
  const stack = [{ parent: null, node: root }];
  while (stack.length) {
    const { parent, node: n } = stack.pop();
    if (n.id === instanceId && parent) {
      const idx = parent.children.findIndex(c => c.id === instanceId);
      if (idx >= 0) parent.children.splice(idx, 1);
      break;
    }
    if (n.children) for (const c of n.children) stack.push({ parent: n, node: c });
  }

  // Remove from every step's snapshot too — keeps snapshots in sync so a
  // future redo / load doesn't accidentally resurrect the node.
  const allSteps = state.get('steps') || [];
  const nextSteps = allSteps.map(s => {
    const snap = s.snapshot || {};
    const newTree = _removeFromTreeSpec(snap.tree, instanceId);
    if (newTree === snap.tree && !snap.visibility?.[instanceId] && !snap.transforms?.[instanceId]) {
      return s;
    }
    const vis = { ...(snap.visibility || {}) };
    delete vis[instanceId];
    const tr = { ...(snap.transforms || {}) };
    delete tr[instanceId];
    return { ...s, snapshot: { ...snap, tree: newTree, visibility: vis, transforms: tr } };
  });
  state.setState({ steps: nextSteps, nodeById: _nodes_buildNodeMap(root) });
  state.emit('change:treeData', root);
}

function _propagateNewNodeToSteps(node, parentId, opts = {}) {
  const allSteps = state.get('steps') || [];
  const stepSel  = state.get('selectedStepIds');
  const restrict = (stepSel instanceof Set && stepSel.size >= 2) ? stepSel : null;
  // activeStepOnly (V0.1.85, item 3): the new node is added to EVERY step's
  // tree spec (so it exists everywhere and can be shown later per-step),
  // but it starts VISIBLE only on the step that was active at creation and
  // HIDDEN on all others. Used for freshly-placed shapes so a new shape
  // doesn't pop into every step of the timeline. Falls back to the legacy
  // "visible everywhere" behaviour when there's no active step.
  const activeId       = state.get('activeStepId');
  const activeStepOnly = !!opts.activeStepOnly && !!activeId;

  const nodeSpec = serializeModelTree(node);
  const transformSnap = captureTransformSnapshot(node);

  const next = allSteps.map(s => {
    // In activeStepOnly mode we DON'T honour the multi-step restrict — the
    // node must exist in every step's tree so it's individually toggleable.
    if (!activeStepOnly && restrict && !restrict.has(s.id)) return s;
    const snap = s.snapshot || {};
    const newTree = _addToTreeSpec(snap.tree, parentId, nodeSpec);
    const wantVis = activeStepOnly ? (s.id === activeId) : true;
    if (newTree === snap.tree && snap.visibility?.[node.id] === wantVis) return s;
    return {
      ...s,
      snapshot: {
        ...snap,
        tree:        newTree ?? snap.tree,
        visibility:  { ...(snap.visibility  || {}), [node.id]: wantVis },
        transforms:  { ...(snap.transforms  || {}), [node.id]: transformSnap },
      },
    };
  });
  state.setState({ steps: next });
}

/** Returns a new spec with `child` appended to `parentId`'s children, or original if parent not found. */
function _addToTreeSpec(spec, parentId, child) {
  if (!spec) return spec;
  if (spec.id === parentId) {
    return { ...spec, children: [...(spec.children || []), child] };
  }
  if (!spec.children?.length) return spec;
  let changed = false;
  const newKids = spec.children.map(c => {
    const r = _addToTreeSpec(c, parentId, child);
    if (r !== c) changed = true;
    return r;
  });
  return changed ? { ...spec, children: newKids } : spec;
}

/** Returns a new spec with the node `id` (and any descendants) stripped out. */
function _removeFromTreeSpec(spec, id) {
  if (!spec) return spec;
  if (spec.id === id) return null;
  if (!spec.children?.length) return spec;
  let changed = false;
  const newKids = [];
  for (const c of spec.children) {
    const r = _removeFromTreeSpec(c, id);
    if (r === c) { newKids.push(c); continue; }
    changed = true;
    if (r) newKids.push(r);
  }
  return changed ? { ...spec, children: newKids } : spec;
}

function _undoCreateTemplate(templateId, instanceId, prevTemplates, prevSteps) {
  // Remove instance from live tree + scene
  _removeShapeInstance(instanceId);
  // Restore previous templates + steps
  state.setState({ shapeTemplates: prevTemplates, steps: prevSteps });
  state.markDirty();
  state.emit('change:treeData', state.get('treeData'));
}

function _redoCreateTemplate(tpl, instanceId, nextSteps) {
  // Reinsert template + steps; the instance's mesh is rebuilt on next
  // step activation via rebuildFromTreeSpec — simplest atomic path.
  state.setState({
    shapeTemplates: [...(state.get('shapeTemplates') || []).filter(t => t.id !== tpl.id), tpl],
    steps:          nextSteps,
  });
  state.markDirty();
}


// ═══════════════════════════════════════════════════════════════════════════
//  INSTANCE STEP-POSE CLIPBOARD  (copy / paste per-step pose across steps)
// ═══════════════════════════════════════════════════════════════════════════
//
// "Pose" = the per-step transform snapshot + visibility flag for one
// instance, captured from a SOURCE step and applied to one or more
// TARGET steps. Mirrors the pivot copy/paste pattern.
//
// Stored fields:
//   - transforms[id]   from snapshot.transforms (localOffset, localQuaternion, etc.)
//   - visibility[id]   from snapshot.visibility
//
// Paste targets:
//   - With selectedStepIds.size ≥ 2 → all selected steps.
//   - Otherwise → just the active step.
//
// Cross-instance paste IS allowed (paste poseA onto instanceB) — the
// transform values are id-agnostic, so this is by design.

let _instancePoseClipboard = null;

/** Whether the clipboard currently holds a copied pose. */
export function hasInstancePoseClipboard() { return _instancePoseClipboard !== null; }

/**
 * Capture the active step's pose for `instanceId`. Returns true on success.
 * Falls back gracefully if the active step doesn't carry a snapshot for it
 * (uses the current live transform).
 */
export function copyInstanceStepPose(instanceId) {
  const node = state.get('nodeById')?.get(instanceId);
  if (!node) return false;

  const stepId = state.get('activeStepId');
  const step   = (state.get('steps') || []).find(s => s.id === stepId);
  const snap   = step?.snapshot;

  const transformSnap = snap?.transforms?.[instanceId]
                     ?? captureTransformSnapshot(node);
  const vis = snap?.visibility?.[instanceId];
  _instancePoseClipboard = {
    transform:  JSON.parse(JSON.stringify(transformSnap)),
    visibility: typeof vis === 'boolean' ? vis : (node.localVisible !== false),
  };
  return true;
}

/**
 * Apply the clipboard pose to `instanceId` in either:
 *   - every step in state.selectedStepIds (when ≥ 2 are selected), or
 *   - just the active step.
 *
 * Pushes ONE undo entry covering all touched steps + a final
 * step:applied so the active step's scene re-mounts immediately.
 */
export function pasteInstanceStepPose(instanceId) {
  if (!_instancePoseClipboard) return false;
  if (_isArchived(instanceId)) return false;
  const { transform, visibility } = _instancePoseClipboard;

  const allSteps = state.get('steps') || [];
  const stepSel  = state.get('selectedStepIds');
  const targetIds = (stepSel instanceof Set && stepSel.size >= 2)
    ? new Set(stepSel)
    : new Set([state.get('activeStepId')].filter(Boolean));
  if (targetIds.size === 0) return false;

  const prevSteps = allSteps.map(s => {
    if (!targetIds.has(s.id)) return s;
    return JSON.parse(JSON.stringify(s));
  });

  const nextSteps = allSteps.map(s => {
    if (!targetIds.has(s.id)) return s;
    const snap = s.snapshot || {};
    return {
      ...s,
      snapshot: {
        ...snap,
        transforms: { ...(snap.transforms || {}), [instanceId]: JSON.parse(JSON.stringify(transform)) },
        visibility: { ...(snap.visibility || {}), [instanceId]: !!visibility },
      },
    };
  });

  const apply = (stepsArr) => {
    state.setState({ steps: stepsArr });
    state.markDirty();
    // Re-apply the active step's snapshot so the live scene reflects the
    // pasted pose immediately (otherwise the user'd have to navigate away
    // and back to see the change).
    const active = stepsArr.find(s => s.id === state.get('activeStepId'));
    if (active && targetIds.has(active.id)) {
      steps.applySnapshotInstant(active.snapshot);
    }
    state.emit('steps:bulkApplied', { stepIds: [...targetIds] });
  };
  apply(nextSteps);

  const label = targetIds.size > 1
    ? `Paste pose on ${targetIds.size} steps`
    : 'Paste pose';
  undoManager.push(label,
    () => apply(prevSteps),
    () => apply(nextSteps),
  );
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════
//  SHAPE TAB — selection, groups, visibility (V0.1.85)
// ═══════════════════════════════════════════════════════════════════════════
//
// Tab-only feature. Templates and groups live in state.shapeTemplates /
// state.shapeTemplateGroups; the scene tree is untouched. Multi-select
// in the tab (Ctrl/Shift-click) drives `selectedShapeTemplateIds` and
// `selectedShapeTemplateGroupIds` Sets that the tab renderer reads.
//
// VIEWPORT ↔ TAB SYNC: when the scene selection contains flatShape nodes,
// projectTreeSelectionToShapeTab() maps them to their templates and pushes
// the result into selectedShapeTemplateIds. Locked-group selection
// promotion runs at viewport pick (main.js) — see selectionPromoteForShapeGroup.
//
// VISIBILITY: per-template eye = toggleVisibility() on every flatShape
// instance of that template. Per-group eye = same, summed across members.
// Mixed-state derived live (no stored bit) from instance localVisible.

function _collectFlatShapeNodeIds(predicate) {
  const out = [];
  const root = state.get('treeData');
  if (!root) return out;
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'flatShape' && !n.archived && predicate(n)) out.push(n.id);
    if (n.children) for (const c of n.children) stack.push(c);
  }
  return out;
}

/** All non-archived flatShape node IDs whose templateId is in `tplIds` (Set or Array). */
function _instanceIdsOfTemplates(tplIds) {
  const set = tplIds instanceof Set ? tplIds : new Set(tplIds);
  return _collectFlatShapeNodeIds(n => set.has(n.templateId));
}

/**
 * Return 'visible' | 'hidden' | 'mixed' | 'none' for a single template id.
 * 'none' = the template has zero instances in the live tree.
 */
export function getShapeTemplateVisibilityState(tplId) {
  let anyVis = false, anyHid = false;
  _collectFlatShapeNodeIds(n => {
    if (n.templateId !== tplId) return false;
    if (n.localVisible === false) anyHid = true; else anyVis = true;
    return false; // we don't need the id list, just the flags
  });
  if (!anyVis && !anyHid) return 'none';
  if (anyVis && anyHid)   return 'mixed';
  return anyVis ? 'visible' : 'hidden';
}

/** Same as above but for a shape group (rolls up its members). */
export function getShapeGroupVisibilityState(groupId) {
  const groups = state.get('shapeTemplateGroups') || [];
  const g = groups.find(x => x.id === groupId);
  if (!g || g.templateIds.length === 0) return 'none';
  let anyVis = false, anyHid = false;
  const set = new Set(g.templateIds);
  _collectFlatShapeNodeIds(n => {
    if (!set.has(n.templateId)) return false;
    if (n.localVisible === false) anyHid = true; else anyVis = true;
    return false;
  });
  if (!anyVis && !anyHid) return 'none';
  if (anyVis && anyHid)   return 'mixed';
  return anyVis ? 'visible' : 'hidden';
}

/** Find which shape-template-group (if any) owns `tplId`. Returns the group object or null. */
export function findShapeGroupForTemplate(tplId) {
  const groups = state.get('shapeTemplateGroups') || [];
  return groups.find(g => g.templateIds.includes(tplId)) || null;
}

// ── Tab selection ──────────────────────────────────────────────────────────

/**
 * Set / extend the shape-tab template selection. `mode`:
 *   'replace' — clear and select just `id`
 *   'add'     — add `id` (no toggle)
 *   'toggle'  — toggle membership (Ctrl-click)
 * Group selection is cleared on every change unless `keepGroupSel` is true.
 */
export function selectShapeTemplate(id, mode = 'replace', keepGroupSel = false) {
  const cur = new Set(state.get('selectedShapeTemplateIds') || []);
  if (mode === 'replace') {
    cur.clear();
    if (id) cur.add(id);
  } else if (mode === 'add') {
    if (id) cur.add(id);
  } else if (mode === 'toggle') {
    if (!id) return;
    if (cur.has(id)) cur.delete(id); else cur.add(id);
  }
  const patch = { selectedShapeTemplateIds: cur };
  if (!keepGroupSel) patch.selectedShapeTemplateGroupIds = new Set();
  state.setState(patch);
}

export function selectShapeTemplateGroup(id, mode = 'replace', keepTemplateSel = false) {
  const cur = new Set(state.get('selectedShapeTemplateGroupIds') || []);
  if (mode === 'replace') {
    cur.clear();
    if (id) cur.add(id);
  } else if (mode === 'add') {
    if (id) cur.add(id);
  } else if (mode === 'toggle') {
    if (!id) return;
    if (cur.has(id)) cur.delete(id); else cur.add(id);
  }
  const patch = { selectedShapeTemplateGroupIds: cur };
  if (!keepTemplateSel) patch.selectedShapeTemplateIds = new Set();
  state.setState(patch);
}

export function clearShapeTabSelection() {
  state.setState({
    selectedShapeTemplateIds:      new Set(),
    selectedShapeTemplateGroupIds: new Set(),
  });
}

/**
 * Reflect the scene selection into the tab: for every selected flatShape
 * node, add its templateId to selectedShapeTemplateIds. Group selection
 * is cleared. Idempotent — safe to wire to every selection change.
 */
export function projectTreeSelectionToShapeTab() {
  const nbm = state.get('nodeById');
  if (!nbm) return;
  const ids = new Set();
  const selId = state.get('selectedId');
  if (selId) ids.add(selId);
  const multi = state.get('multiSelectedIds');
  if (multi instanceof Set) for (const id of multi) ids.add(id);
  const out = new Set();
  for (const id of ids) {
    const n = nbm.get(id);
    if (n?.type === 'flatShape' && n.templateId) out.add(n.templateId);
  }
  state.setState({
    selectedShapeTemplateIds:      out,
    selectedShapeTemplateGroupIds: new Set(),
  });
}

// Auto-sync on every scene selection change.
state.on('change:selectedId',       () => projectTreeSelectionToShapeTab());
state.on('change:multiSelectedIds', () => projectTreeSelectionToShapeTab());

// V0.2.2: the Colors-tab selection IS the scene→color projection — selecting
// models auto-selects the colors they use in the tab (so right-click → Unify
// works on them directly, not just a separate amber highlight).
let _silentColorSel = false;
/**
 * Set the Colors-tab selection as an UNDOABLE action. Rapid changes coalesce
 * into one entry (slider-drag-style). Pass `{ silent: true }` to skip undo
 * — used by the scene→color auto-sync so it doesn't pollute the stack.
 */
export function setColorSelection(ids, opts = {}) {
  const before = new Set(state.get('selectedColorPresetIds') || []);
  const after  = ids instanceof Set ? new Set(ids) : new Set(ids || []);
  if (before.size === after.size && [...before].every(x => after.has(x))) return;
  state.setState({ selectedColorPresetIds: after });
  if (_silentColorSel || opts.silent) return;
  // V0.2.14: strict per-click undo. Dropped `coalesceKey: 'colorSel'` so
  // each tab click / marquee drag / scene-driven auto-sync that actually
  // changes the set lands its own entry (the no-op guard above skips
  // duplicate firings from change:selectedId + change:multiSelectedIds).
  undoManager.push(
    after.size === 0 ? 'Clear color selection' : `Color selection (${after.size})`,
    () => { _silentColorSel = true; state.setState({ selectedColorPresetIds: new Set(before) }); _silentColorSel = false; },
    () => { _silentColorSel = true; state.setState({ selectedColorPresetIds: new Set(after)  }); _silentColorSel = false; },
  );
}
export function projectSceneSelectionToColorsTab() {
  // V0.2.5: ADD scene-derived colors to the tab selection (never replace).
  // Selecting more models grows the set; deselecting does NOT remove colors
  // (the tab tracks "colors you've worked with"). State fills re-evaluate
  // on the next render so the visual reflects the new scene reality. This
  // change is undoable + coalesced so Ctrl+Z restores tab selection after
  // scene-driven changes too (previously it was silent → undo could miss it).
  const ids = new Set();
  const selId = state.get('selectedId');
  if (selId) ids.add(selId);
  const multi = state.get('multiSelectedIds');
  if (multi instanceof Set) for (const id of multi) ids.add(id);
  const next = new Set(state.get('selectedColorPresetIds') || []);
  for (const id of ids) {
    const pid = materials.meshColorAssignments[id] ?? materials.meshDefaultColors[id];
    if (pid) next.add(pid);
  }
  setColorSelection(next);   // undoable, coalesced — no-op guard inside skips identical sets
}
state.on('change:selectedId',       () => projectSceneSelectionToColorsTab());
state.on('change:multiSelectedIds', () => projectSceneSelectionToColorsTab());

// V0.2.1: shape-tab selection drives a viewport highlight on the instances
// of the selected templates / locked-group members — VISIBLE ones get a
// normal hull; HIDDEN ones get a scene-root ghost outline so the user can
// see where the hidden shape sits. Re-runs on step + visibility changes.
function _syncShapeTabHighlight() {
  const sel    = state.get('selectedShapeTemplateIds')      || new Set();
  const grpSel = state.get('selectedShapeTemplateGroupIds') || new Set();
  if (sel.size === 0 && grpSel.size === 0) { materials.clearShapeTabHighlight(); return; }
  const tplIds = new Set(sel);
  const groups = state.get('shapeTemplateGroups') || [];
  for (const gid of grpSel) {
    const g = groups.find(x => x.id === gid);
    if (g) for (const t of g.templateIds) tplIds.add(t);
  }
  if (tplIds.size === 0) { materials.clearShapeTabHighlight(); return; }
  materials.applyShapeTabHighlight(_instanceIdsOfTemplates([...tplIds]));
}
state.on('change:selectedShapeTemplateIds',      _syncShapeTabHighlight);
state.on('change:selectedShapeTemplateGroupIds', _syncShapeTabHighlight);
state.on('step:applied',                          _syncShapeTabHighlight);
state.on('change:treeData',                       _syncShapeTabHighlight);
// Also re-sync when the scene selection changes — for VISIBLE instances we
// skip the hull when the mesh is already in scene-selected (avoids double
// overlay), so a scene-selection change can flip which ones get our hull.
state.on('selection:change',                      _syncShapeTabHighlight);

// ── Group create / ungroup / membership ────────────────────────────────────

/**
 * Bundle `templateIds` into a new shape-template-group. If any of those
 * templates already belong to an existing group, they're removed from
 * that group first (templates can only live in one group). Empty source
 * groups are dropped. Single undo entry.
 */
export function createShapeTemplateGroupFromTemplates(templateIds, name = null) {
  const ids = Array.from(new Set(templateIds || [])).filter(Boolean);
  if (ids.length === 0) return null;
  const prevGroups = JSON.parse(JSON.stringify(state.get('shapeTemplateGroups') || []));
  const newGroup = createShapeTemplateGroup({
    name:        name || `Shape Group ${prevGroups.length + 1}`,
    templateIds: ids,
  });
  const stripped = prevGroups
    .map(g => ({ ...g, templateIds: g.templateIds.filter(t => !ids.includes(t)) }))
    .filter(g => g.templateIds.length > 0);
  const nextGroups = [...stripped, newGroup];

  const apply = (groups) => {
    state.setState({ shapeTemplateGroups: groups });
    state.markDirty();
  };
  apply(nextGroups);
  undoManager.push(`Group ${ids.length} shape${ids.length === 1 ? '' : 's'}`,
    () => apply(prevGroups),
    () => apply(nextGroups),
  );
  // Move tab selection from templates to the new group.
  state.setState({
    selectedShapeTemplateIds:      new Set(),
    selectedShapeTemplateGroupIds: new Set([newGroup.id]),
  });
  return newGroup.id;
}

/** Convenience: group whatever's selected in the tab right now. */
export function groupSelectedShapeTemplates() {
  const sel = state.get('selectedShapeTemplateIds');
  if (!(sel instanceof Set) || sel.size === 0) {
    setStatus('Select shapes in the tab first (Ctrl-click).', 'warning');
    return null;
  }
  return createShapeTemplateGroupFromTemplates([...sel]);
}

export function unGroupShapeTemplateGroup(groupId) {
  const prevGroups = JSON.parse(JSON.stringify(state.get('shapeTemplateGroups') || []));
  if (!prevGroups.some(g => g.id === groupId)) return false;
  const nextGroups = prevGroups.filter(g => g.id !== groupId);
  const apply = (groups) => {
    state.setState({ shapeTemplateGroups: groups });
    state.markDirty();
  };
  apply(nextGroups);
  undoManager.push('Ungroup shapes',
    () => apply(prevGroups),
    () => apply(nextGroups),
  );
  // Clear group selection if it referenced the dropped group.
  const selGroups = new Set(state.get('selectedShapeTemplateGroupIds') || []);
  if (selGroups.has(groupId)) {
    selGroups.delete(groupId);
    state.setState({ selectedShapeTemplateGroupIds: selGroups });
  }
  return true;
}

/** Remove given templates from whatever group they're in. Single undo. */
export function removeTemplatesFromShapeGroup(templateIds) {
  const ids = Array.from(new Set(templateIds || [])).filter(Boolean);
  if (ids.length === 0) return false;
  const prevGroups = JSON.parse(JSON.stringify(state.get('shapeTemplateGroups') || []));
  const nextGroups = prevGroups
    .map(g => ({ ...g, templateIds: g.templateIds.filter(t => !ids.includes(t)) }))
    .filter(g => g.templateIds.length > 0);
  if (JSON.stringify(prevGroups) === JSON.stringify(nextGroups)) return false;
  const apply = (groups) => {
    state.setState({ shapeTemplateGroups: groups });
    state.markDirty();
  };
  apply(nextGroups);
  undoManager.push(`Remove ${ids.length} shape${ids.length === 1 ? '' : 's'} from group`,
    () => apply(prevGroups),
    () => apply(nextGroups),
  );
  return true;
}

/** Append `templateIds` to an existing group (also removes them from any other group). */
export function addTemplatesToShapeGroup(groupId, templateIds) {
  const ids = Array.from(new Set(templateIds || [])).filter(Boolean);
  if (ids.length === 0) return false;
  const prevGroups = JSON.parse(JSON.stringify(state.get('shapeTemplateGroups') || []));
  if (!prevGroups.some(g => g.id === groupId)) return false;
  const nextGroups = prevGroups
    .map(g => {
      if (g.id === groupId) {
        const merged = [...g.templateIds.filter(t => !ids.includes(t)), ...ids];
        return { ...g, templateIds: merged };
      }
      return { ...g, templateIds: g.templateIds.filter(t => !ids.includes(t)) };
    })
    .filter(g => g.templateIds.length > 0);
  const apply = (groups) => {
    state.setState({ shapeTemplateGroups: groups });
    state.markDirty();
  };
  apply(nextGroups);
  undoManager.push(`Add ${ids.length} shape${ids.length === 1 ? '' : 's'} to group`,
    () => apply(prevGroups),
    () => apply(nextGroups),
  );
  return true;
}

export function setShapeTemplateGroupName(groupId, name) {
  const prevGroups = JSON.parse(JSON.stringify(state.get('shapeTemplateGroups') || []));
  const g = prevGroups.find(x => x.id === groupId);
  if (!g || g.name === name) return false;
  const nextGroups = prevGroups.map(x => x.id === groupId ? { ...x, name } : x);
  const apply = (groups) => {
    state.setState({ shapeTemplateGroups: groups });
    state.markDirty();
  };
  apply(nextGroups);
  undoManager.push('Rename shape group',
    () => apply(prevGroups),
    () => apply(nextGroups),
  );
  return true;
}

export function setShapeTemplateGroupLocked(groupId, locked) {
  const prevGroups = JSON.parse(JSON.stringify(state.get('shapeTemplateGroups') || []));
  const g = prevGroups.find(x => x.id === groupId);
  if (!g || !!g.locked === !!locked) return false;
  const nextGroups = prevGroups.map(x => x.id === groupId ? { ...x, locked: !!locked } : x);
  const apply = (groups) => {
    state.setState({ shapeTemplateGroups: groups });
    state.markDirty();
  };
  apply(nextGroups);
  undoManager.push(locked ? 'Lock shape group' : 'Unlock shape group',
    () => apply(prevGroups),
    () => apply(nextGroups),
  );
  return true;
}

/** Not undoable — pure UI state. */
export function setShapeTemplateGroupCollapsed(groupId, collapsed) {
  const groups = (state.get('shapeTemplateGroups') || []).map(g =>
    g.id === groupId ? { ...g, collapsed: !!collapsed } : g,
  );
  state.setState({ shapeTemplateGroups: groups });
}

// ── Visibility — bulk-toggle all instances of a template / group ──────────

/**
 * Flip visibility on every flatShape instance of `tplId`. Direction is
 * driven by the current state: if ANY instance is hidden we SHOW all
 * (and any cascaded ancestors per toggleVisibility's SHOW semantics);
 * if every instance is visible we HIDE all. Single undo entry — routed
 * through toggleVisibility() so step snapshots + multi-step apply
 * automatically.
 */
export function toggleShapeTemplateVisibility(tplId) {
  const nodeIds = _instanceIdsOfTemplates([tplId]);
  if (nodeIds.length === 0) {
    setStatus('No instances of this shape in the scene.', 'warning');
    return false;
  }
  // toggleVisibility flips based on the FIRST id's current state. To get
  // unified behaviour ("show all if any hidden, hide all if all visible")
  // we partition by current state and call once per direction.
  const nbm = state.get('nodeById');
  const hidden  = nodeIds.filter(id => nbm.get(id)?.localVisible === false);
  const visible = nodeIds.filter(id => nbm.get(id)?.localVisible !== false);
  if (hidden.length > 0) {
    // Show all the hidden ones — toggleVisibility flips them visible.
    toggleVisibility(hidden);
  } else {
    // All visible — hide all.
    toggleVisibility(visible);
  }
  return true;
}

export function toggleShapeGroupVisibility(groupId) {
  const groups = state.get('shapeTemplateGroups') || [];
  const g = groups.find(x => x.id === groupId);
  if (!g || g.templateIds.length === 0) return false;
  const nodeIds = _instanceIdsOfTemplates(g.templateIds);
  if (nodeIds.length === 0) {
    setStatus('No instances of this group\'s shapes in the scene.', 'warning');
    return false;
  }
  const nbm = state.get('nodeById');
  const hidden  = nodeIds.filter(id => nbm.get(id)?.localVisible === false);
  const visible = nodeIds.filter(id => nbm.get(id)?.localVisible !== false);
  if (hidden.length > 0) {
    toggleVisibility(hidden);
  } else {
    toggleVisibility(visible);
  }
  return true;
}

// ── Filter toggle ─────────────────────────────────────────────────────────

export function setShapeTabFilterVisibleOnly(on) {
  state.setState({ shapeTabFilterVisibleOnly: !!on });
}

// ── Viewport selection promotion for LOCKED shape groups ──────────────────
//
// Called from main.js viewport pick: given a hit flatShape nodeId, if its
// template belongs to a LOCKED shape group, return a Set containing every
// flatShape instance node id of every member template (so the click
// selects the whole group). Returns null otherwise.

export function selectionPromoteForLockedShapeGroup(meshNodeId) {
  const nbm = state.get('nodeById');
  const node = nbm?.get(meshNodeId);
  if (!node || node.type !== 'flatShape' || !node.templateId) return null;
  const g = findShapeGroupForTemplate(node.templateId);
  if (!g || !g.locked) return null;
  const ids = _instanceIdsOfTemplates(g.templateIds);
  return new Set(ids);
}

// ═══════════════════════════════════════════════════════════════════════════
//  RAY-SELECT — disambiguate overlapping picks (V0.1.89)
// ═══════════════════════════════════════════════════════════════════════════
//
// Rhino-style "what did I click?" resolver. Casts a ray through ALL visible
// geometry under the cursor and maps each hit mesh to its LOGICAL selectable
// entity, applying the same promotion priority as a normal click:
//   RM ancestor → locked tree-group → locked shape-group → the mesh itself.
// Entities are de-duplicated and returned in near→far order. main.js uses
// the list to drive a cursor-anchored cycle menu.
//
// Each entity:
//   { key, targetId, name, meshIds:[…] }
//     key      — dedupe identity (container/group/mesh id)
//     targetId — what state.setSelection's primary id becomes on confirm
//     name     — label shown in the cycle list
//     meshIds  — full click-set (container descendants / group members /
//                the single mesh); used for both preview highlight AND the
//                final selection multi-set.
export function resolveRaySelectEntities(clientX, clientY) {
  const hits = sceneCore.pickAll(clientX, clientY);
  const root = state.get('treeData');
  const nbm  = state.get('nodeById');
  if (!hits.length || !root || !nbm) return [];

  const descendantsOf = (id) => {
    const out = new Set([id]);
    const n = nbm.get(id);
    if (n?.children) (function walk(node) {
      for (const c of (node.children || [])) { out.add(c.id); walk(c); }
    })(n);
    return out;
  };

  const entities = [];
  const seen = new Set();
  for (const hit of hits) {
    const meshNodeId = hit.object?.userData?.meshNodeId
                    ?? hit.object?.userData?.flatShapeNodeId
                    ?? null;
    if (!meshNodeId || !nbm.has(meshNodeId)) continue;

    let key, targetId, name, clickSet;
    const rmId   = hit.object?.userData?.replaceModelId;
    const rmNode = rmId ? nbm.get(rmId) : null;
    if (rmNode) {
      key = rmNode.id; targetId = rmNode.id;
      name = rmNode.name || 'Replace-Model';
      clickSet = descendantsOf(rmNode.id);
    } else {
      const lg = findLockedFolderAncestor(root, meshNodeId);
      if (lg) {
        key = lg.id; targetId = lg.id;
        name = lg.name || 'Folder';
        // V0.2.22.21.3 — locked folder is a UNIT in the selection model.
        // Previously this used descendantsOf(lg.id) which inflated the
        // entity's meshIds with every child; ray-select-confirm then
        // committed all those ids to multiSelectedIds, defeating the
        // V0.2.22.21.1/2 cleanup that removed children from direct-
        // click locked-folder selections. Now matches both other entry
        // points (main.js viewport-click promotion, tree.js single-
        // click): multi carries just the folder id; the silhouette
        // outline pass wraps the descendant mesh mass automatically.
        clickSet = new Set([lg.id]);
      } else {
        const sg = selectionPromoteForLockedShapeGroup(meshNodeId);
        if (sg && sg.size > 0) {
          const grp = findShapeGroupForTemplate(nbm.get(meshNodeId)?.templateId);
          key = 'sg:' + (grp?.id || meshNodeId);
          targetId = meshNodeId;
          name = (grp?.name || 'Shape Group') + ' (group)';
          clickSet = sg;
        } else {
          const node = nbm.get(meshNodeId);
          key = meshNodeId; targetId = meshNodeId;
          name = node?.name || node?.type || 'Object';
          clickSet = new Set([meshNodeId]);
        }
      }
    }
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push({ key, targetId, name, meshIds: [...clickSet] });
  }
  return entities;
}

