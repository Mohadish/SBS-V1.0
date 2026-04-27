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
import { selectionActs }        from './select-act.js';
import { materials }            from '../systems/materials.js';
import steps                    from '../systems/steps.js';
import { createAnimationPreset } from '../core/schema.js';
import * as editSession         from './edit-session.js';   // P7-A: gate Ctrl-Z while in overlay edit
import {
  applyAllVisibility,
  captureTransformSnapshot,
  applyTransformSnapshot,
  applyNodeTransformToObject3D,
}                               from '../core/transforms.js';


// ═══════════════════════════════════════════════════════════════════════════
//  MATERIAL ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Assign a color preset to one or more meshes.
 */
export function assignPreset(meshIds, presetId) {
  const ids  = [...meshIds];
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
 * Remove color preset from one or more meshes.
 */
export function removePreset(meshIds) {
  const ids  = [...meshIds];
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
 */
export function revertToDefault(meshIds) {
  const ids = [...meshIds];
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

export function toggleVisibility(nodeIds) {
  const nodeById   = state.get('nodeById');
  const ids        = [...nodeIds];
  const wasVisible = ids.map(id => nodeById.get(id)?.localVisible ?? true);
  const newVis     = !nodeById.get(ids[0])?.localVisible;

  ids.forEach(id => { const n = nodeById.get(id); if (n) n.localVisible = newVis; });
  _syncVis();

  undoManager.push(
    newVis ? 'Show' : 'Hide',
    () => {
      const nb = state.get('nodeById');
      ids.forEach((id, i) => { const n = nb.get(id); if (n) n.localVisible = wasVisible[i]; });
      _syncVis();
    },
    () => {
      const nb = state.get('nodeById');
      ids.forEach(id => { const n = nb.get(id); if (n) n.localVisible = newVis; });
      _syncVis();
    },
  );
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
  const { nodeId, from } = _pivotBatch;
  _pivotBatch = null;
  state.setState({ pivotEditNodeId: null });

  const node = state.get('nodeById')?.get(nodeId);
  if (!node) return;
  const to = captureTransformSnapshot(node);
  if (JSON.stringify(from) === JSON.stringify(to)) return;

  undoManager.push('Edit pivot',
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      applyTransformSnapshot(n, from);
      const o = steps.object3dById?.get(nodeId);
      if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
    () => {
      const n = state.get('nodeById')?.get(nodeId); if (!n) return;
      applyTransformSnapshot(n, to);
      const o = steps.object3dById?.get(nodeId);
      if (o) applyNodeTransformToObject3D(n, o);
      steps.scheduleTransformSync();
    },
  );
  steps.scheduleTransformSync();
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
