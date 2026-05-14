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
import { createAnimationPreset, createCameraView, createNoteNode, createNoteTemplate, createShapeTemplate, createFlatShapeNode, generateId } from '../core/schema.js';
import * as editSession         from './edit-session.js';   // P7-A: gate Ctrl-Z while in overlay edit
import * as cables              from './cables.js';          // C3: cable mutators (data layer)
import {
  ensureFlatShapeObject3D,
  disposeFlatShape,
  rebuildInstancesOfTemplate as _rebuildInstancesOfTemplate,
} from './flat-shapes.js';   // M1 P1: 2D shapes (template-backed instances)
import * as shapeEditor        from './shape-editor.js';
import {
  applyAllVisibility,
  captureTransformSnapshot,
  applyTransformSnapshot,
  applyNodeTransformToObject3D,
  applyNodeSourceTransformToObject3D,
}                               from '../core/transforms.js';
import {
  moveNode    as _nodes_moveNode,
  buildNodeMap as _nodes_buildNodeMap,
  captureParentMap,
  findNode,
  findParent,
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
  const ids = [...meshIds];
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
  const ids = [...meshIds];
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
  const ids = [...meshIds];
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
  const ids = [...meshIds];
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
 * Isolate the given node ids — hide every node NOT in the keep set
 * (selected ids + all their descendants + all their ancestors). The
 * outgoing visibility is snapshotted so unisolate() can restore. One
 * undo entry per call. Re-running isolate replaces the snapshot
 * (subsequent undo restores to whatever was visible BEFORE this call).
 */
let _isolateSnapshot = null;   // Map<nodeId, boolean>

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

export function isolateSelection() {
  const nodeById = state.get('nodeById');
  if (!nodeById) return;
  const ids = state.get('multiSelectedIds');
  if (!ids?.size) return;
  const keep = _collectKeepSet(ids);

  // Snapshot CURRENT visibility for unisolate.
  const snapshot = new Map();
  for (const [id, n] of nodeById) snapshot.set(id, n.localVisible !== false);
  _isolateSnapshot = snapshot;

  // Apply isolation: anything not in keep → hidden.
  const flipped = [];   // ids whose visibility actually changed
  for (const [id, n] of nodeById) {
    const want = keep.has(id);
    if (want !== (n.localVisible !== false)) {
      n.localVisible = want;
      flipped.push(id);
    }
  }
  if (!flipped.length) return;
  _syncVis();

  undoManager.push(
    'Isolate',
    () => {
      const nb = state.get('nodeById');
      for (const [id, was] of snapshot) { const n = nb.get(id); if (n) n.localVisible = was; }
      _syncVis();
    },
    () => {
      const nb = state.get('nodeById');
      for (const id of flipped) { const n = nb.get(id); if (n) n.localVisible = keep.has(id); }
      _syncVis();
    },
  );
}

export function unisolate() {
  if (!_isolateSnapshot) return;
  const nodeById = state.get('nodeById');
  if (!nodeById) return;
  const before = new Map();
  for (const [id, n] of nodeById) before.set(id, n.localVisible !== false);
  for (const [id, was] of _isolateSnapshot) { const n = nodeById.get(id); if (n) n.localVisible = was; }
  _syncVis();
  const restored = _isolateSnapshot;
  _isolateSnapshot = null;
  undoManager.push(
    'Un-isolate',
    () => {
      const nb = state.get('nodeById');
      for (const [id, b] of before) { const n = nb.get(id); if (n) n.localVisible = b; }
      _syncVis();
    },
    () => {
      const nb = state.get('nodeById');
      for (const [id, w] of restored) { const n = nb.get(id); if (n) n.localVisible = w; }
      _syncVis();
    },
  );
}

export function hasIsolateSnapshot() { return !!_isolateSnapshot; }

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
 * Move every id under the destination folder. One undo entry restores
 * each node's original parent. Skips moves that would put a node into
 * itself or its own descendant. Triggers a tree rebuild + nodeById
 * refresh so the rest of the app sees the new hierarchy.
 */
export function moveNodesToFolder(ids, destFolderId) {
  const root = state.get('treeData');
  if (!root || !ids?.length || !destFolderId) return;
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
  const nodeById = state.get('nodeById');
  const treeData = state.get('treeData');
  const ids      = [...nodeIds].filter(id => nodeById?.has(id));
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
 * Reset a node's transform to identity (undoable).
 */
export function resetTransform(nodeId) {
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

/** Helper: walk up the THREE object's parents looking for a tagged tree id. */
function _findTreeNodeIdForObject(obj) {
  // The tree's object3dById map is the inverse of what we need; the
  // simplest path is to read state.nodeById and walk obj.parent looking
  // for a name match against a tree node's stored object3d.
  const o3dMap = steps.object3dById;
  if (!o3dMap) return null;
  // Build a quick reverse map: object3d → nodeId.
  let cur = obj;
  while (cur) {
    for (const [nodeId, mapped] of o3dMap.entries()) {
      if (mapped === cur) return nodeId;
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
    if (editSession.isActive()) {
      if (!e.shiftKey && e.key === 'z') {
        e.preventDefault();
        editSession.undoLocal();   // false-return = local stack empty; we still swallow
        return;
      }
      if (e.key === 'y' || (e.shiftKey && e.key === 'Z')) {
        e.preventDefault();
        editSession.redoLocal();
        return;
      }
    }

    if (_isInputFocused()) return;
    if (!e.shiftKey && e.key === 'z') { e.preventDefault(); undoManager.undo(); }
    if (e.key === 'y')                { e.preventDefault(); undoManager.redo(); }
    if (e.shiftKey && e.key === 'Z')  { e.preventDefault(); undoManager.redo(); }
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
  const size = Math.max(5, Math.min(150, Number(px) || 16));
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
              : reason === 'addPolygon'       ? 'Add polygon'
              : reason === 'deletePolygon'    ? 'Delete polygon'
              : reason === 'transformPolygon' ? 'Transform polygon'
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
  _propagateNewNodeToSteps(instance, parent.id);

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
export function startShapePlacement(templateId) {
  if (!templateId) return;
  if (state.get('shapeDrawing'))                  cancelShapeDraw();
  if (state.get('shapeEditPickInstanceForId'))    state.setState({ shapeEditPickInstanceForId: null });
  state.setState({ shapePlacementForId: templateId });
}

export function cancelShapePlacement() {
  if (!state.get('shapePlacementForId')) return;
  // Also wipe any pending image data — same Esc / right-click reset.
  state.setState({ shapePlacementForId: null, imageShapePending: null });
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
  if (state.get('shapeDrawing'))               cancelShapeDraw();
  if (state.get('shapePlacementForId'))        state.setState({ shapePlacementForId: null });
  if (state.get('shapeEditPickInstanceForId')) state.setState({ shapeEditPickInstanceForId: null });
  state.setState({ shapeFromFacePicking: true });
  setStatus('Click a face on a model — its cross-section becomes a new shape.');
}

export function cancelCreateShapeFromFace() {
  if (!state.get('shapeFromFacePicking')) return;
  state.setState({ shapeFromFacePicking: false });
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

/** Deep-clone a tree node, dropping object3d (not JSON-serializable). */
function _cloneTreeWithoutObject3d(node) {
  if (!node) return null;
  const out = {};
  for (const k in node) {
    if (k === 'object3d') continue;
    if (k === '_anim') continue;     // transient animation cache, never serialised
    const v = node[k];
    if (v == null) out[k] = v;
    else if (Array.isArray(v))            out[k] = JSON.parse(JSON.stringify(v));
    else if (k === 'children')            out[k] = v.map(_cloneTreeWithoutObject3d);
    else if (typeof v === 'object')        out[k] = JSON.parse(JSON.stringify(v));
    else                                   out[k] = v;
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

function _propagateNewNodeToSteps(node, parentId) {
  const allSteps = state.get('steps') || [];
  const stepSel  = state.get('selectedStepIds');
  const restrict = (stepSel instanceof Set && stepSel.size >= 2) ? stepSel : null;

  const nodeSpec = serializeModelTree(node);
  const transformSnap = captureTransformSnapshot(node);

  const next = allSteps.map(s => {
    if (restrict && !restrict.has(s.id)) return s;
    const snap = s.snapshot || {};
    const newTree = _addToTreeSpec(snap.tree, parentId, nodeSpec);
    if (newTree === snap.tree && snap.visibility?.[node.id] !== undefined) return s;
    return {
      ...s,
      snapshot: {
        ...snap,
        tree:        newTree ?? snap.tree,
        visibility:  { ...(snap.visibility  || {}), [node.id]: true },
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

