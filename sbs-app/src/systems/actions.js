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
import sceneCore                from '../core/scene.js';
import { createAnimationPreset, createCameraView } from '../core/schema.js';
import * as editSession         from './edit-session.js';   // P7-A: gate Ctrl-Z while in overlay edit
import * as cables              from './cables.js';          // C3: cable mutators (data layer)
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
}                               from '../core/nodes.js';


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

  // Enter pivot edit mode so the user can fine-tune via the gizmo.
  // Per the user's spec: "once placed pivot stays red — user can edit."
  enterPivotEdit(nodeId);
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
