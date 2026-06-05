/**
 * SBS — Hardware actions (V0.2.22.38).
 *
 * Mutations for the template + instance system. Mirrors the shape-tab
 * action shape so the UI feels consistent:
 *
 *   createHardwareTemplate({kind, params, name?})
 *     → push to state.hardwareTemplates, return new template
 *
 *   placeHardwareInstance(templateId, parentId?)
 *     → create a hardwareInstance node in the scene tree, return node
 *
 *   duplicateHardwareInstance(nodeId)
 *     → create a sibling instance pointing at the same template,
 *       offset slightly so it's visible.
 *
 *   editHardwareTemplate(templateId, patch)
 *     → mutate the template params, rebuild every instance's mesh.
 *
 *   deleteHardwareTemplate(templateId, { deleteInstances })
 *     → remove from state; optionally cascade-delete every instance
 *       (otherwise instances become orphans rendering nothing).
 *
 * Auto-folder: the first instance created in a project auto-creates
 * a "Hardware" folder at scene root and parents the instance there.
 * Subsequent instances drop into the same folder when no explicit
 * parent is passed. Users can move instances out of it freely.
 */

import { state }                       from '../core/state.js';
import { materials }                    from './materials.js';
import {
  createHardwareTemplate,
  createHardwareInstanceNode,
  createNode,
  generateId,
}                                       from '../core/schema.js';
import { steps }                        from './steps.js';
import { sceneCore }                    from '../core/scene.js';
import { buildNodeMap }                 from '../core/nodes.js';
import {
  ensureHardwareInstanceObject3D,
  rebuildHardwareInstancesOfTemplate,
  disposeHardwareInstance,
}                                       from './hardware-templates.js';
import { applyNodeTransformToObject3D } from '../core/transforms.js';
import { undoManager }                  from './undo.js';

const HARDWARE_FOLDER_NAME = 'Hardware';

// V0.2.22.45 — every new hardware instance gets this colour preset
// auto-assigned as its DEFAULT. Two reasons:
//   1. Users were finding the colour-tab assign flow unclear ("Select
//      mesh objects first" when a screw was already selected). With a
//      default already in place, the user only ever needs to RIGHT-
//      CLICK a different preset → Assign — never the empty-state path.
//   2. Gives the user a one-click way to retint every hardware item at
//      once (edit the "Hardware" preset → ripples to every default-
//      assigned screw, just like a regular preset.)
//
// The preset is created lazily on the first instance. If the user later
// renames or deletes it, no harm — instances fall back to their original
// material until a new default is assigned.
const HARDWARE_PRESET_NAME  = 'Hardware';
const HARDWARE_PRESET_COLOR = '#c0c4cc';   // matches the generator's brushed metal

function _ensureHardwarePreset() {
  const presets = state.get('colorPresets') || [];
  const existing = presets.find(p => p.name === HARDWARE_PRESET_NAME);
  if (existing) return existing;
  const preset = {
    id:    generateId('preset'),
    name:  HARDWARE_PRESET_NAME,
    type:  'solid',
    color: HARDWARE_PRESET_COLOR,
  };
  state.setState({ colorPresets: [...presets, preset] });
  // Enable solidOverride so the preset actually shows on the mesh —
  // without it, the underlying MeshStandardMaterial colour wins and
  // the user-applied preset has no visible effect.
  if (state.get('solidOverride') !== true) {
    state.setState({ solidOverride: true });
  }
  return preset;
}

function _assignHardwareDefault(instanceId) {
  const preset = _ensureHardwarePreset();
  if (!preset) return;
  // Assign as the DEFAULT colour (meshDefaultColors map), not a
  // per-step override. Default colours follow the mesh across every
  // step until the user explicitly overrides per-step.
  materials.assignDefaultColor([instanceId], preset.id);
  materials.applyAll?.();
}

// ─── Templates ──────────────────────────────────────────────────────────────

/**
 * Create a hardware template, push to state. Returns the new template
 * (already in the array).
 */
export function createTemplate({ kind = 'screw', params = {}, name = '' } = {}) {
  const tpl = createHardwareTemplate({
    kind,
    params: { ...params },
    name:   name || _autoName({ kind, params }),
  });
  const list = state.get('hardwareTemplates') || [];
  state.setState({ hardwareTemplates: [...list, tpl] });
  state.markDirty?.();
  return tpl;
}

/**
 * Replace a template's params (and optionally name), then rebuild every
 * live instance. Returns the updated template, or null if it doesn't exist.
 */
export function editTemplate(templateId, patch) {
  const list = state.get('hardwareTemplates') || [];
  const idx  = list.findIndex(t => t.id === templateId);
  if (idx < 0) return null;
  const prev = list[idx];
  const next = {
    ...prev,
    ...patch,
    params: { ...prev.params, ...(patch?.params || {}) },
  };
  // Auto-update name when it tracked the params (i.e. user never
  // hand-named it). Heuristic: name matches the auto-name format from
  // the prior params. Saves the user from manually editing names every
  // time they tweak a screw's diameter.
  if (!patch?.name && prev.name === _autoName(prev)) {
    next.name = _autoName(next);
  }
  const updated = [...list];
  updated[idx]  = next;
  state.setState({ hardwareTemplates: updated });

  // Cascade: rebuild every instance using this template.
  const root = state.get('treeData');
  rebuildHardwareInstancesOfTemplate(root, steps.object3dById, templateId);
  state.markDirty?.();
  state.emit('change:treeData', root);
  return next;
}

/**
 * Delete a template and (optionally) every instance using it. If
 * deleteInstances is false, orphan instances stay in the tree but
 * render nothing — the user can re-target them via the right-click
 * menu or delete them manually.
 */
export function deleteTemplate(templateId, { deleteInstances = true } = {}) {
  const list = state.get('hardwareTemplates') || [];
  const next = list.filter(t => t.id !== templateId);
  if (next.length === list.length) return false;

  if (deleteInstances) {
    const root = state.get('treeData');
    _deleteInstancesByTemplateId(root, templateId);
    state.setState({ nodeById: buildNodeMap(root) });
  }
  state.setState({ hardwareTemplates: next });
  state.markDirty?.();
  state.emit('change:treeData', state.get('treeData'));
  return true;
}

// ─── Instances ──────────────────────────────────────────────────────────────

/**
 * Drop a fresh instance of a template into the tree. Returns the new node.
 *
 * @param {string}  templateId
 * @param {string?} parentId   defaults to (or auto-creates) the "Hardware"
 *                             folder at scene root.
 */
export function placeInstance(templateId, parentId = null) {
  const tpls = state.get('hardwareTemplates') || [];
  const tpl  = tpls.find(t => t.id === templateId);
  if (!tpl) {
    console.warn(`[hardware] placeInstance: template ${templateId} not found`);
    return null;
  }

  const root = state.get('treeData') || _ensureSceneRoot();

  // Decide parent: explicit > Hardware folder > scene root (auto-make).
  let parentNode = null;
  if (parentId) {
    const nodeById = state.get('nodeById') || buildNodeMap(root);
    parentNode = nodeById.get(parentId) || null;
  }
  if (!parentNode) parentNode = _ensureHardwareFolder(root);
  if (!parentNode) parentNode = root;

  // Build the instance node + mesh.
  const inst = createHardwareInstanceNode({
    templateId: tpl.id,
    name:       tpl.name || _autoName(tpl),
  });

  // Attach + register in tree first so ensureHardwareInstanceObject3D
  // can look up the template and the materials system can find the
  // node id during registration.
  parentNode.children = [...(parentNode.children || []), inst];
  const nodeById = buildNodeMap(root);
  state.setState({ nodeById, treeData: root });

  const mesh = ensureHardwareInstanceObject3D(inst);
  if (mesh) {
    // Parent the mesh under the parent's Object3D. Folders own a Group,
    // scene root owns sceneCore.rootGroup. Either way, steps.object3dById
    // has the entry.
    const parentObj = steps.object3dById?.get(parentNode.id) ?? sceneCore.rootGroup;
    parentObj.add(mesh);
    steps.object3dById.set(inst.id, mesh);
    applyNodeTransformToObject3D(inst, mesh, true);
  }

  // V0.2.22.45 — auto-assign the "Hardware" default colour preset.
  // The user can right-click any other preset to switch.
  _assignHardwareDefault(inst.id);

  state.markDirty?.();
  state.emit('change:treeData', root);

  // Push undo: insertion is reversed by deletion of this single node.
  _pushPlaceInstanceUndo(inst.id, parentNode.id, inst);
  return inst;
}

/**
 * Delete one or more hardware instances. Absolute removal — no archive,
 * no soft-delete, no recovery via re-link. Once gone, gone.
 *
 * Filters non-hardwareInstance ids so callers can safely pass a mixed
 * selection set. Returns the number of instances actually removed.
 *
 * V0.2.22.44 — wired to the tree + viewport right-click "Delete screw"
 * action. Multi-select aware: passing N ids deletes N screws in one
 * undo entry.
 */
export function deleteInstances(ids) {
  if (!ids || !ids.length) return 0;
  const root = state.get('treeData');
  const nodeById = state.get('nodeById') || buildNodeMap(root);

  // Capture full snapshots BEFORE removal so undo can recreate them.
  // Each entry: { snapshot, parentId } — enough for the redo path to
  // re-attach in the right place.
  const targets = [];
  for (const id of ids) {
    const n = nodeById.get(id);
    if (!n || n.type !== 'hardwareInstance') continue;
    const parent = _findParent(root, id);
    if (!parent) continue;
    targets.push({
      parentId: parent.id,
      snapshot: JSON.parse(JSON.stringify({
        ...n,
        object3d: null,
        children: [],
      })),
    });
  }
  if (!targets.length) return 0;

  // Remove them now.
  const _removeOne = (id) => {
    const p = _findParent(root, id);
    if (!p) return;
    p.children = (p.children || []).filter(c => {
      if (c.id === id) {
        disposeHardwareInstance(c);
        return false;
      }
      return true;
    });
  };
  for (const t of targets) _removeOne(t.snapshot.id);

  state.setState({ nodeById: buildNodeMap(root), treeData: root });
  state.markDirty?.();
  state.emit('change:treeData', root);

  // Undo: re-create each snapshot under its original parent.
  const label = targets.length === 1
    ? `Delete hardware "${targets[0].snapshot.name || 'screw'}"`
    : `Delete ${targets.length} hardware instances`;
  undoManager.push(
    label,
    () => {
      const root2 = state.get('treeData');
      for (const t of targets) {
        const parent = (state.get('nodeById') || buildNodeMap(root2)).get(t.parentId);
        if (!parent) continue;
        const fresh = { ...JSON.parse(JSON.stringify(t.snapshot)), children: [], object3d: null };
        parent.children = [...(parent.children || []), fresh];
        const nbm = buildNodeMap(root2);
        state.setState({ nodeById: nbm, treeData: root2 });
        const mesh = ensureHardwareInstanceObject3D(fresh);
        if (mesh) {
          const parentObj = steps.object3dById?.get(parent.id) ?? sceneCore.rootGroup;
          parentObj.add(mesh);
          steps.object3dById.set(fresh.id, mesh);
          applyNodeTransformToObject3D(fresh, mesh, true);
        }
      }
      state.emit('change:treeData', state.get('treeData'));
    },
    () => {
      // Re-run the same removal logic
      const root2 = state.get('treeData');
      for (const t of targets) {
        const p = _findParent(root2, t.snapshot.id);
        if (!p) continue;
        p.children = (p.children || []).filter(c => {
          if (c.id === t.snapshot.id) {
            disposeHardwareInstance(c);
            return false;
          }
          return true;
        });
      }
      state.setState({ nodeById: buildNodeMap(root2), treeData: root2 });
      state.emit('change:treeData', root2);
    },
  );
  return targets.length;
}

/**
 * V0.2.22.47 — set per-instance washer config and rebuild the mesh.
 * Multi-aware: pass an array of nodeIds to apply the same config to
 * each in one undo entry.
 *
 *   washers = { count: 0|1|2, spring: bool }
 *
 * Triggers a mesh rebuild via the same path a template edit uses:
 * the build key includes washer config, so ensureHardwareInstanceObject3D
 * sees the signature change and regenerates.
 */
export function setInstanceWashers(nodeIds, washers) {
  if (!Array.isArray(nodeIds)) nodeIds = [nodeIds];
  if (!nodeIds.length) return;

  const root = state.get('treeData');
  const nodeById = state.get('nodeById') || buildNodeMap(root);

  // Snapshot before-state for undo
  const before = [];
  for (const id of nodeIds) {
    const n = nodeById.get(id);
    if (!n || n.type !== 'hardwareInstance') continue;
    before.push({
      id,
      washers: { ...(n.washers || { count: 0, spring: false }) },
    });
  }
  if (!before.length) return;

  const after = { count: Math.max(0, Math.min(2, Number(washers?.count) || 0)),
                  spring: !!washers?.spring };

  const _apply = (config) => {
    for (const id of nodeIds) {
      const n = (state.get('nodeById') || buildNodeMap(root)).get(id);
      if (!n || n.type !== 'hardwareInstance') continue;
      n.washers = { ...config };
      // Force a rebuild: clear the cached object3d (the sig has changed
      // but ensureHardwareInstanceObject3D's cache check would still
      // catch it — clearing is belt-and-suspenders).
      const mesh = ensureHardwareInstanceObject3D(n);
      if (mesh) {
        const parent = mesh.parent ?? steps.object3dById?.get(_findParent(root, id)?.id);
        if (parent && mesh.parent !== parent) parent.add(mesh);
        steps.object3dById.set(id, mesh);
        applyNodeTransformToObject3D(n, mesh, true);
      }
    }
    state.markDirty?.();
    state.emit('change:treeData', state.get('treeData'));
  };

  _apply(after);

  // Undo: each instance gets its own per-id before-state restored.
  const label = nodeIds.length > 1
    ? `Set washers on ${nodeIds.length} instances`
    : `Set washers`;
  undoManager.push(
    label,
    () => {
      for (const entry of before) {
        const n = (state.get('nodeById') || buildNodeMap(root)).get(entry.id);
        if (!n) continue;
        n.washers = { ...entry.washers };
        const mesh = ensureHardwareInstanceObject3D(n);
        if (mesh) {
          const parent = mesh.parent ?? steps.object3dById?.get(_findParent(root, entry.id)?.id);
          if (parent && mesh.parent !== parent) parent.add(mesh);
          steps.object3dById.set(entry.id, mesh);
          applyNodeTransformToObject3D(n, mesh, true);
        }
      }
      state.markDirty?.();
      state.emit('change:treeData', state.get('treeData'));
    },
    () => _apply(after),
  );
}

/**
 * V0.2.22.52 — flag/unflag hardware instances as insertion-animation
 * actors for the ACTIVE step. When flagged, that step plays the
 * explode→assemble effect (see systems/hardware-insert-anim.js).
 *
 * Multi-aware: pass an array to flag several at once. `enable=false`
 * clears the flag. Bound to whatever step is active at call time.
 */
export function setInsertActor(nodeIds, enable = true) {
  if (!Array.isArray(nodeIds)) nodeIds = [nodeIds];
  if (!nodeIds.length) return;
  const root = state.get('treeData');
  const nodeById = state.get('nodeById') || buildNodeMap(root);
  const stepId = state.get('activeStepId') || null;

  const before = [];
  for (const id of nodeIds) {
    const n = nodeById.get(id);
    if (!n || n.type !== 'hardwareInstance') continue;
    before.push({ id, prev: { ...(n.insertAnim || { enabled: false, stepId: null, distance: null, dottedLine: false }) } });
  }
  if (!before.length) return;

  const _apply = (mapFn) => {
    const nb = state.get('nodeById') || buildNodeMap(root);
    for (const id of nodeIds) {
      const n = nb.get(id);
      if (!n || n.type !== 'hardwareInstance') continue;
      n.insertAnim = mapFn(n);
    }
    state.markDirty?.();
    state.emit('change:treeData', state.get('treeData'));
  };

  _apply((n) => enable
    ? { ...(n.insertAnim || {}), enabled: true, stepId }
    : { ...(n.insertAnim || {}), enabled: false });

  undoManager.push(
    enable
      ? (nodeIds.length > 1 ? `Animate ${nodeIds.length} insertions` : 'Animate insertion')
      : 'Stop insertion animation',
    () => {
      const nb = state.get('nodeById') || buildNodeMap(root);
      for (const e of before) {
        const n = nb.get(e.id);
        if (n) n.insertAnim = { ...e.prev };
      }
      state.markDirty?.();
      state.emit('change:treeData', state.get('treeData'));
    },
    () => _apply((n) => enable
      ? { ...(n.insertAnim || {}), enabled: true, stepId }
      : { ...(n.insertAnim || {}), enabled: false }),
  );
}

/**
 * V0.2.22.52.2 — set the insertion explode spacing X (mm) on one or more
 * instances. Washers explode to L + j·X, screw to L + (W+1)·X. Undoable,
 * multi-aware.
 */
export function setInsertDistance(nodeIds, xMm) {
  if (!Array.isArray(nodeIds)) nodeIds = [nodeIds];
  const x = Math.max(0, Number(xMm) || 0);
  if (!nodeIds.length || !(x > 0)) return;
  const root = state.get('treeData');
  const nodeById = state.get('nodeById') || buildNodeMap(root);

  const before = [];
  for (const id of nodeIds) {
    const n = nodeById.get(id);
    if (!n || n.type !== 'hardwareInstance') continue;
    before.push({ id, prev: Number(n.insertAnim?.distance) });
  }
  if (!before.length) return;

  const _set = (val, perId = null) => {
    const nb = state.get('nodeById') || buildNodeMap(root);
    for (const id of nodeIds) {
      const n = nb.get(id);
      if (!n || n.type !== 'hardwareInstance') continue;
      const v = perId ? perId.get(id) : val;
      n.insertAnim = { ...(n.insertAnim || {}), distance: v };
    }
    state.markDirty?.();
    state.emit('change:treeData', state.get('treeData'));
  };

  _set(x);
  const prevMap = new Map(before.map(e => [e.id, e.prev]));
  undoManager.push(
    `Insertion spacing ${x}mm`,
    () => _set(null, prevMap),
    () => _set(x),
  );
}

/**
 * Duplicate an existing hardware instance — produces a sibling pointing
 * at the same template, offset by 1.5× the screw's nominal diameter so
 * the copy doesn't z-fight with the original.
 */
export function duplicateInstance(nodeId) {
  const root = state.get('treeData');
  const nodeById = state.get('nodeById') || buildNodeMap(root);
  const src = nodeById.get(nodeId);
  if (!src || src.type !== 'hardwareInstance') return null;

  // Find parent — walk the tree for the node containing src.
  const parent = _findParent(root, nodeId);
  if (!parent) return null;

  const tpls = state.get('hardwareTemplates') || [];
  const tpl  = tpls.find(t => t.id === src.templateId);
  const offset = tpl ? (tpl.params?.diameter || 4) * 1.5 : 6;

  const copy = createHardwareInstanceNode({
    templateId: src.templateId,
    name:       src.name || tpl?.name || '',
    localOffset: [
      (src.localOffset?.[0] || 0) + offset,
      (src.localOffset?.[1] || 0),
      (src.localOffset?.[2] || 0),
    ],
  });

  parent.children = [...(parent.children || []), copy];
  const nbm = buildNodeMap(root);
  state.setState({ nodeById: nbm, treeData: root });

  const mesh = ensureHardwareInstanceObject3D(copy);
  if (mesh) {
    const parentObj = steps.object3dById?.get(parent.id) ?? sceneCore.rootGroup;
    parentObj.add(mesh);
    steps.object3dById.set(copy.id, mesh);
    applyNodeTransformToObject3D(copy, mesh, true);
  }

  // Mirror the source's default colour onto the duplicate so it tints
  // the same way out of the gate. Falls back to the "Hardware" preset
  // if the source had none.
  const srcDefault = materials.meshDefaultColors?.[nodeId];
  if (srcDefault) {
    materials.assignDefaultColor([copy.id], srcDefault);
    materials.applyAll?.();
  } else {
    _assignHardwareDefault(copy.id);
  }

  state.markDirty?.();
  state.emit('change:treeData', root);
  _pushPlaceInstanceUndo(copy.id, parent.id, copy, `Duplicate ${src.name || 'hardware'}`);
  return copy;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function _autoName(tpl) {
  if (tpl.kind === 'screw') {
    const p = tpl.params || {};
    return `M${p.diameter}×${p.length} ${p.headType}, ${p.driveStyle}`;
  }
  return tpl.kind || 'hardware';
}

function _ensureSceneRoot() {
  let root = state.get('treeData');
  if (root && root.type === 'scene') return root;
  const T = window.THREE;
  root = createNode('scene', { id: 'scene_root', name: 'Scene' });
  root.object3d = sceneCore.rootGroup;
  root.children = [];
  steps.object3dById.set('scene_root', sceneCore.rootGroup);
  state.setState({ treeData: root, nodeById: buildNodeMap(root) });
  return root;
}

function _ensureHardwareFolder(root) {
  // Reuse any existing folder named "Hardware" at scene root.
  const existing = (root.children || []).find(c =>
    c.type === 'folder' && c.name === HARDWARE_FOLDER_NAME);
  if (existing) return existing;

  // Create one. Folder Group lives in sceneCore.rootGroup so child meshes
  // get added in the right Three.js hierarchy.
  const T = window.THREE;
  const group = new T.Group();
  group.name = HARDWARE_FOLDER_NAME;
  sceneCore.rootGroup.add(group);

  const folder = createNode('folder', {
    id:   generateId('folder'),
    name: HARDWARE_FOLDER_NAME,
  });
  folder.object3d = group;
  steps.object3dById.set(folder.id, group);
  root.children = [...(root.children || []), folder];
  return folder;
}

function _findParent(root, nodeId) {
  if (!root) return null;
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    for (const c of (n.children || [])) {
      if (c.id === nodeId) return n;
      stack.push(c);
    }
  }
  return null;
}

function _deleteInstancesByTemplateId(root, templateId) {
  if (!root) return;
  (function walk(node) {
    if (!node) return;
    node.children = (node.children || []).filter(c => {
      if (c.type === 'hardwareInstance' && c.templateId === templateId) {
        disposeHardwareInstance(c);
        return false;
      }
      walk(c);
      return true;
    });
  })(root);
}

function _pushPlaceInstanceUndo(nodeId, parentId, snapshotNode, label = 'Add hardware') {
  // Capture the snapshot now so an undo replay re-creates the exact node.
  const snap = JSON.parse(JSON.stringify({
    ...snapshotNode,
    object3d: null,   // not serialisable; re-built on apply
    children: [],
  }));
  undoManager.push(
    label,
    () => {
      // UNDO: remove the node from its parent + scene.
      const root = state.get('treeData');
      const parent = _findParent(root, nodeId) || (state.get('nodeById')?.get(parentId));
      if (parent) {
        parent.children = (parent.children || []).filter(c => {
          if (c.id === nodeId) {
            disposeHardwareInstance(c);
            return false;
          }
          return true;
        });
      }
      state.setState({ nodeById: buildNodeMap(root), treeData: root });
      state.emit('change:treeData', root);
    },
    () => {
      // REDO: re-create from the snapshot.
      const root = state.get('treeData');
      const parent = (state.get('nodeById') || buildNodeMap(root)).get(parentId);
      if (!parent) return;
      const fresh = { ...snap, children: [], object3d: null };
      parent.children = [...(parent.children || []), fresh];
      const nbm = buildNodeMap(root);
      state.setState({ nodeById: nbm, treeData: root });
      const mesh = ensureHardwareInstanceObject3D(fresh);
      if (mesh) {
        const parentObj = steps.object3dById?.get(parent.id) ?? sceneCore.rootGroup;
        parentObj.add(mesh);
        steps.object3dById.set(fresh.id, mesh);
        applyNodeTransformToObject3D(fresh, mesh, true);
      }
      state.emit('change:treeData', root);
    },
  );
}

// ─── Legacy V0.2.22.37 compat ──────────────────────────────────────────────
// Old hardware assets (one-asset-per-screw, no template) still load from
// any test projects shipped during the V0.2.22.37 window. The load path
// calls regenerateHardwareAsset for any assetEntry with type='hardware'
// and a hardware field — kept here so those projects still open.

export { regenerateHardwareAsset } from './hardware-actions-legacy.js';
