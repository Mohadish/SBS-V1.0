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
  createHardwareNutNode,
  createNode,
  generateId,
}                                       from '../core/schema.js';
import { steps }                        from './steps.js';
import { sceneCore }                    from '../core/scene.js';
import { buildNodeMap }                 from '../core/nodes.js';
import {
  ensureHardwareInstanceObject3D,
  ensureHardwareNutObject3D,
  rebuildHardwareInstancesOfTemplate,
  disposeHardwareInstance,
}                                       from './hardware-templates.js';
import { washerStackThickness }         from './hardware-generator.js';
import { applyNodeTransformToObject3D, setStoredQuaternion } from '../core/transforms.js';
import { undoManager }                  from './undo.js';
import { stripNodesFromAllStepSnapshots } from './actions.js';   // V0.3.2.73 — a delete must clear step snapshots too

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
export function createTemplate({ kind = 'screw', params = {}, name = '', washerNames } = {}) {
  const tpl = createHardwareTemplate({
    kind,
    params: { ...params },
    name:   name || _autoName({ kind, params }),
    ...(Array.isArray(washerNames) ? { washerNames: [...washerNames] } : {}),
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
 * V0.2.22.59 — rename a template (name only, no mesh rebuild). Empty /
 * whitespace name falls back to the auto-name.
 */
export function renameTemplate(templateId, name) {
  const list = state.get('hardwareTemplates') || [];
  const idx  = list.findIndex(t => t.id === templateId);
  if (idx < 0) return;
  const clean = String(name || '').trim();
  const next  = { ...list[idx], name: clean || _autoName(list[idx]) };
  const updated = [...list];
  updated[idx] = next;
  state.setState({ hardwareTemplates: updated });
  state.markDirty?.();
}

/** V0.2.22.59 — reset a template's name to the auto-generated spec name. */
export function restoreTemplateName(templateId) {
  const list = state.get('hardwareTemplates') || [];
  const tpl  = list.find(t => t.id === templateId);
  if (tpl) renameTemplate(templateId, _autoName(tpl));
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
 * @param {object?} opts       { worldPose: { position: Vector3, quaternion:
 *                             Quaternion } } — place at this world pose
 *                             instead of the parent origin (place-on-surface
 *                             / 3-point). Captured into the undo snapshot.
 */
export function placeInstance(templateId, parentId = null, opts = {}) {
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
    // Optional initial world pose (place-on-surface / 3-point placement).
    // Done BEFORE _pushPlaceInstanceUndo so the undo snapshot captures the
    // pose → redo restores it correctly.
    if (opts.worldPose?.position) {
      setInstanceWorldPose(inst, mesh, opts.worldPose.position, opts.worldPose.quaternion);
    }
  }

  // V0.2.22.45 — auto-assign the "Hardware" default colour preset.
  // The user can right-click any other preset to switch.
  _assignHardwareDefault(inst.id);

  // V0.2.22.64 — make the instance survive step snapshots (otherwise a
  // step re-apply rebuilds the tree from a snapshot that predates it and
  // orphans it — the "2nd nut vanishes from the tree" bug).
  steps.injectHardwareInstanceIntoAllSteps?.(inst, parentNode);

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

  // V0.3.2.73 — removing the node from the LIVE tree is only half a delete.
  // Every step snapshot is a standalone scene description, so a leftover id
  // is re-materialised by rebuildFromTreeSpec on the next step activation,
  // visible (the inject baked visibility=true into every step). That is the
  // "deleted screws come back" bug. Scrub the ids from all snapshots too,
  // and keep the previous steps array so undo can put them back.
  const stepsBefore = state.get('steps') || [];
  const scrub = stripNodesFromAllStepSnapshots(targets.map(t => t.snapshot.id), stepsBefore);

  state.setState({
    nodeById: buildNodeMap(root),
    treeData: root,
    ...(scrub.changed ? { steps: scrub.steps } : {}),
  });
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
      // Restore the per-step snapshot entries too (tree spec / visibility /
      // transforms), otherwise undo brings the screw back in the live tree
      // only — and the next step change deletes it again.
      if (scrub.changed) state.setState({ steps: stepsBefore });
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
      // Re-scrub the snapshots, mirroring the forward path — otherwise redo
      // leaves the ids in every step and the screw resurrects again.
      const reScrub = stripNodesFromAllStepSnapshots(targets.map(t => t.snapshot.id), state.get('steps') || []);
      state.setState({
        nodeById: buildNodeMap(root2),
        treeData: root2,
        ...(reScrub.changed ? { steps: reScrub.steps } : {}),
      });
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

  // Washer-stack thickness (mm, scale 1) for a node + washer config.
  const _tw = (n, w) => {
    const tpl = (state.get('hardwareTemplates') || []).find(t => t.id === n.templateId);
    return tpl ? washerStackThickness(tpl.params, w) : 0;
  };

  // Snapshot before-state for undo — washers AND the transform (the auto-
  // reposition shifts the screw along its axis, so undo must restore both).
  const before = [];
  for (const id of nodeIds) {
    const n = nodeById.get(id);
    if (!n || n.type !== 'hardwareInstance') continue;
    before.push({
      id,
      washers: { ...(n.washers || { count: 0, spring: false }) },
      xf: {
        baseLocalPosition: [...(n.baseLocalPosition || [0, 0, 0])],  // the HOME we shift
        localOffset:       [...(n.localOffset       || [0, 0, 0])],
        localQuaternion:   [...(n.localQuaternion   || [0, 0, 0, 1])],
        orientationSteps:  [...(n.orientationSteps  || [0, 0, 0])],
      },
    });
  }
  if (!before.length) return;

  const after = { count: Math.max(0, Math.min(2, Number(washers?.count) || 0)),
                  spring: !!washers?.spring };

  const _apply = (config) => {
    for (const id of nodeIds) {
      const n = (state.get('nodeById') || buildNodeMap(root)).get(id);
      if (!n || n.type !== 'hardwareInstance') continue;
      const oldTw = _tw(n, n.washers);     // before the change
      n.washers = { ...config };
      const newTw = _tw(n, config);        // after the change
      const mesh = ensureHardwareInstanceObject3D(n);
      if (mesh) {
        const parent = mesh.parent ?? steps.object3dById?.get(_findParent(root, id)?.id);
        if (parent && mesh.parent !== parent) parent.add(mesh);
        steps.object3dById.set(id, mesh);
        applyNodeTransformToObject3D(n, mesh, true);
        // Auto-reposition: slide the screw out/in so the washer stack still
        // sits ON the surface (no gap, no embedding) after the count change.
        _compensateWasherShift(n, mesh, newTw - oldTw);
      }
    }
    state.markDirty?.();
    state.emit('change:treeData', state.get('treeData'));
  };

  _apply(after);

  // Undo: each instance gets its washers AND transform restored.
  const label = nodeIds.length > 1
    ? `Set washers on ${nodeIds.length} instances`
    : `Set washers`;
  undoManager.push(
    label,
    () => {
      for (const entry of before) {
        const n = (state.get('nodeById') || buildNodeMap(root)).get(entry.id);
        if (!n) continue;
        n.washers           = { ...entry.washers };
        n.baseLocalPosition = [...entry.xf.baseLocalPosition];   // restore the HOME
        n.localOffset       = [...entry.xf.localOffset];
        n.localQuaternion   = [...entry.xf.localQuaternion];
        n.orientationSteps  = [...entry.xf.orientationSteps];
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
 * V0.2.22.58 — set insertion-animation params on one or more instances.
 * Every key in `patch` is applied verbatim, INCLUDING null (= "use
 * default", resolved up the chain at animation time). Recognised keys:
 *   distance, repositionMs, tagName, tagSize, trajectory,
 *   lineThickness, lineColor
 * Keys not present in `patch` are left unchanged. Undoable, multi-aware.
 */
export function setInsertAnimParams(nodeIds, patch = {}) {
  if (!Array.isArray(nodeIds)) nodeIds = [nodeIds];
  if (!nodeIds.length) return;

  const KEYS = ['distance', 'repositionMs', 'tagName', 'tagSize', 'tagColor',
                'explodeBefore', 'pauseBefore', 'pauseBeforeMs',
                'trajectory', 'lineThickness', 'lineGap', 'lineColor'];
  const set = {};
  for (const k of KEYS) if (k in patch) set[k] = patch[k];   // null allowed
  if (!Object.keys(set).length) return;

  const root = state.get('treeData');
  const nodeById = state.get('nodeById') || buildNodeMap(root);

  const before = [];
  for (const id of nodeIds) {
    const n = nodeById.get(id);
    if (!n || n.type !== 'hardwareInstance') continue;
    before.push({ id, prev: { ...(n.insertAnim || {}) } });
  }
  if (!before.length) return;

  const _apply = (perId = null) => {
    const nb = state.get('nodeById') || buildNodeMap(root);
    for (const id of nodeIds) {
      const n = nb.get(id);
      if (!n || n.type !== 'hardwareInstance') continue;
      n.insertAnim = perId ? { ...perId.get(id) } : { ...(n.insertAnim || {}), ...set };
    }
    state.markDirty?.();
    state.emit('change:treeData', state.get('treeData'));
  };

  _apply();
  const prevMap = new Map(before.map(e => [e.id, e.prev]));
  undoManager.push(
    'Insertion animation params',
    () => _apply(prevMap),
    () => _apply(),
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

  // V0.2.22.64 — survive step snapshots (see placeInstance).
  steps.injectHardwareInstanceIntoAllSteps?.(copy, parent);

  state.markDirty?.();
  state.emit('change:treeData', root);
  _pushPlaceInstanceUndo(copy.id, parent.id, copy, `Duplicate ${src.name || 'hardware'}`);
  return copy;
}

// ─── Nuts (V0.2.22.78) ────────────────────────────────────────────────────────
// A nut is a CHILD of a bolt instance — driven by the bolt (rendered under
// the bolt's mesh) but with its own transform / visibility / colour. Created
// manually from the bolt's right-click; lives from step 0.

/**
 * Create a hex nut on `boltId` (a hardwareInstance). Home pose = the shank
 * tip; geometry derives from the bolt's diameter. Exists on every step.
 */
export function createNutForBolt(boltId) {
  const root = state.get('treeData');
  if (!root) return null;
  const nodeById = state.get('nodeById') || buildNodeMap(root);
  const bolt = nodeById.get(boltId);
  if (!bolt || bolt.type !== 'hardwareInstance') return null;

  const tpl = (state.get('hardwareTemplates') || []).find(t => t.id === bolt.templateId);
  const L = Math.max(1, Number(tpl?.params?.length) || 20);

  const nut = createHardwareNutNode({
    boltTemplateId: bolt.templateId,
    name: 'Nut',
    baseLocalPosition: [0, -L, 0],   // HOME at the shank tip (bolt origin = head)
  });

  bolt.children = [...(bolt.children || []), nut];
  state.setState({ nodeById: buildNodeMap(root), treeData: root });

  const mesh = ensureHardwareNutObject3D(nut);
  if (mesh) {
    const boltObj = steps.object3dById?.get(bolt.id) ?? sceneCore.rootGroup;
    boltObj.add(mesh);                       // render UNDER the bolt → bolt-driven
    steps.object3dById.set(nut.id, mesh);
    applyNodeTransformToObject3D(nut, mesh, true);
  }
  _assignHardwareDefault(nut.id);            // tint like the rest of the hardware

  // Exist from step 0 — append the nut under the bolt in every step snapshot.
  steps.injectHardwareInstanceIntoAllSteps?.(nut, bolt);

  state.markDirty?.();
  state.emit('change:treeData', root);

  const snap = JSON.parse(JSON.stringify({ ...nut, object3d: null, children: [] }));
  undoManager.push('Add nut',
    () => _nutRemove(nut.id),
    () => _nutRecreate(snap, bolt.id));
  return nut;
}

/** Delete a nut (absolute removal). Undoable. */
export function deleteNut(nutId) {
  const root = state.get('treeData');
  const nodeById = state.get('nodeById') || buildNodeMap(root);
  const nut = nodeById.get(nutId);
  if (!nut || nut.type !== 'hardwareNut') return;
  const parent = _findParent(root, nutId);
  if (!parent) return;
  const snap = JSON.parse(JSON.stringify({ ...nut, object3d: null, children: [] }));
  _nutRemove(nutId);
  state.markDirty?.();
  undoManager.push('Delete nut',
    () => _nutRecreate(snap, parent.id),
    () => _nutRemove(nutId));
}

function _nutRemove(nutId) {
  const root = state.get('treeData');
  const parent = _findParent(root, nutId);
  if (parent) {
    parent.children = (parent.children || []).filter(c => {
      if (c.id === nutId) {
        const m = c.object3d;
        if (m?.parent) m.parent.remove(m);
        m?.geometry?.dispose?.();
        steps.object3dById?.delete?.(nutId);
        return false;
      }
      return true;
    });
  }
  state.setState({ nodeById: buildNodeMap(root), treeData: root });
  state.emit('change:treeData', root);
}

function _nutRecreate(snap, boltId) {
  const root = state.get('treeData');
  const bolt = (state.get('nodeById') || buildNodeMap(root)).get(boltId);
  if (!bolt) return;
  const fresh = { ...snap, children: [], object3d: null };
  bolt.children = [...(bolt.children || []), fresh];
  state.setState({ nodeById: buildNodeMap(root), treeData: root });
  const mesh = ensureHardwareNutObject3D(fresh);
  if (mesh) {
    const boltObj = steps.object3dById?.get(bolt.id) ?? sceneCore.rootGroup;
    boltObj.add(mesh);
    steps.object3dById.set(fresh.id, mesh);
    applyNodeTransformToObject3D(fresh, mesh, true);
  }
  _assignHardwareDefault(fresh.id);
  state.emit('change:treeData', root);
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

/** Screw +Y in world (insertion axis, head direction) for `obj`. */
function _screwAxisWorld(obj) {
  const T = window.THREE;
  const q = new T.Quaternion();
  obj.getWorldQuaternion(q);
  return new T.Vector3(0, 1, 0).applyQuaternion(q).normalize();
}

/**
 * The screw's washer-stack thickness in WORLD units (× world scale). 0 when
 * the screw has no washers or its template can't be resolved.
 */
function _washerThicknessWorld(node, obj) {
  const tpl = (state.get('hardwareTemplates') || []).find(t => t.id === node.templateId);
  const tw = tpl ? washerStackThickness(tpl.params, node.washers) : 0;
  if (!tw) return 0;
  const T = window.THREE;
  const sc = new T.Vector3();
  obj.getWorldScale(sc);
  return tw * (sc.x || 1);
}

/**
 * Place a hardware instance on a surface, COMPENSATING for washer thickness.
 * `worldPos` is the picked SURFACE point; the screw is lifted along its axis
 * by the washer-stack height so the washers sit ON the surface (head pushed
 * out), not embedded in it. No washers → no offset (head sits on the
 * surface). Used by place-on-surface / 3-point / re-align.
 */
export function setInstanceWorldPose(node, obj, worldPos, worldQuat) {
  const T = window.THREE;
  if (!T || !node || !obj) return false;
  obj.updateMatrixWorld(true);
  let target = worldPos;
  const twWorld = _washerThicknessWorld(node, obj);
  if (twWorld > 0) {
    const wq = worldQuat ? worldQuat.clone().normalize() : new T.Quaternion();
    const axis = new T.Vector3(0, 1, 0).applyQuaternion(wq).normalize();
    target = worldPos.clone().addScaledVector(axis, twWorld);
  }
  return _setInstancePoseRaw(node, obj, target, worldQuat);
}

/**
 * Write a world-space pose onto a hardware-instance node + its Object3D
 * (the screw ORIGIN lands exactly at worldPos — no washer compensation).
 * Converts the world pose to the parent's local space, stores it as the
 * per-step localOffset / localQuaternion delta (relative to baseLocal*),
 * and flips moveEnabled / rotateEnabled on (else the delta is ignored at
 * render time — see memory feedback_align_enabled_flags). No undo push;
 * callers own that. Mirrors folder-align-picker's decompose+write.
 */
/** Public: write a world pose onto ANY node + its object3d WITHOUT hardware washer
 *  compensation. Follow-Object uses this to preserve a follower's EXACT current world
 *  pose on reparent (setInstanceWorldPose would shift a washered screw by the stack
 *  height — wrong for follow, right for placement). */
export function setNodeWorldPoseRaw(node, obj, worldPos, worldQuat) {
  return _setInstancePoseRaw(node, obj, worldPos, worldQuat);
}

function _setInstancePoseRaw(node, obj, worldPos, worldQuat) {
  const T = window.THREE;
  if (!T || !node || !obj) return false;
  obj.updateMatrixWorld(true);
  // Keep the current world scale (a scaled parent folder scales the nut).
  const curScale = new T.Vector3();
  obj.matrixWorld.decompose(new T.Vector3(), new T.Quaternion(), curScale);

  const wQuat = worldQuat ? worldQuat.clone().normalize() : new T.Quaternion();
  const newWorld = new T.Matrix4().compose(worldPos.clone(), wQuat, curScale);

  const parent = obj.parent;
  if (parent) parent.updateMatrixWorld(true);
  const invParent = parent
    ? new T.Matrix4().copy(parent.matrixWorld).invert()
    : new T.Matrix4();
  const newLocal = new T.Matrix4().multiplyMatrices(invParent, newWorld);

  const nPos = new T.Vector3(), nQuat = new T.Quaternion(), nScale = new T.Vector3();
  newLocal.decompose(nPos, nQuat, nScale);

  const blp = node.baseLocalPosition   || [0, 0, 0];
  const blq = node.baseLocalQuaternion || [0, 0, 0, 1];
  node.localOffset = [nPos.x - blp[0], nPos.y - blp[1], nPos.z - blp[2]];
  const baseQ  = new T.Quaternion(blq[0], blq[1], blq[2], blq[3]).invert();
  const localQ = baseQ.multiply(nQuat);
  setStoredQuaternion(node, [localQ.x, localQ.y, localQ.z, localQ.w]);
  node.rotateEnabled = true;
  node.moveEnabled   = true;

  obj.position.copy(nPos);
  obj.quaternion.copy(nQuat);
  obj.updateMatrixWorld(true);
  steps.scheduleTransformSync?.();
  state.markDirty?.();
  return true;
}

/**
 * Slide the screw along its OWN axis by `deltaThicknessLocal` mm to keep the
 * washer-stack bottom on the surface when washers are added/removed.
 *
 * This is a HOME-POSITION (base) update, NOT a per-step move: a washer
 * count change is structural, so it must affect EVERY step. We shift the
 * node's baseLocalPosition (the global home, shared by all steps — per-step
 * snapshots only store localOffset deltas), so the change cascades "from
 * home" across all steps while each step's own animation delta is preserved.
 */
function _compensateWasherShift(node, obj, deltaThicknessLocal) {
  const T = window.THREE;
  if (!T || !node || !obj || !deltaThicknessLocal) return;
  obj.updateWorldMatrix(true, false);   // refresh obj + ancestor matrices
  const sc = new T.Vector3();
  obj.getWorldScale(sc);
  const axis = _screwAxisWorld(obj);
  // New world ORIGIN, then back to a parent-local point.
  const newWorld = new T.Vector3();
  obj.getWorldPosition(newWorld).addScaledVector(axis, deltaThicknessLocal * (sc.x || 1));
  const parent   = obj.parent;
  const newLocal = parent ? parent.worldToLocal(newWorld.clone()) : newWorld.clone();
  // base = newLocalPos − per-step localOffset (the rendered pos is base +
  // localOffset when moveEnabled), so base + delta lands the screw at the
  // compensated spot on this step AND every other step.
  const lo = (node.moveEnabled === false) ? [0, 0, 0] : (node.localOffset || [0, 0, 0]);
  node.baseLocalPosition = [newLocal.x - lo[0], newLocal.y - lo[1], newLocal.z - lo[2]];
  applyNodeTransformToObject3D(node, obj, true);
}

/**
 * Re-pose an EXISTING hardware instance to a world pose (viewport
 * "Place on surface" / "Align by 3 points" on a placed nut). Snapshots
 * the before/after per-step transform for undo.
 */
export function realignInstance(nodeId, worldPos, worldQuat) {
  const nodeById = state.get('nodeById') || buildNodeMap(state.get('treeData'));
  const node = nodeById?.get(nodeId);
  const obj  = steps.object3dById?.get(nodeId);
  if (!node || node.type !== 'hardwareInstance' || !obj) return false;

  const before = _snapXf(node);
  if (!setInstanceWorldPose(node, obj, worldPos, worldQuat)) return false;
  const after = _snapXf(node);

  state.emit('change:treeData', state.get('treeData'));
  undoManager.push(
    `Align hardware "${node.name || 'screw'}"`,
    () => _applyXf(nodeId, before),
    () => _applyXf(nodeId, after),
  );
  return true;
}

/**
 * Generic undoable re-pose of ANY node to a world pose. Used by primitive
 * place-on-surface (the picker's 'placeNode' intent). Mirrors realignInstance
 * but for an arbitrary node via setNodeWorldPoseRaw (no washer compensation).
 */
export function placeNodeAtWorldPose(nodeId, worldPos, worldQuat) {
  const nodeById = state.get('nodeById') || buildNodeMap(state.get('treeData'));
  const node = nodeById?.get(nodeId);
  const obj  = steps.object3dById?.get(nodeId) || node?.object3d;
  if (!node || !obj) return false;
  const before = _snapXf(node);
  if (!setNodeWorldPoseRaw(node, obj, worldPos, worldQuat)) return false;
  const after = _snapXf(node);
  state.emit('change:treeData', state.get('treeData'));
  undoManager.push(
    `Place "${node.name || 'object'}"`,
    () => _applyXf(nodeId, before),
    () => _applyXf(nodeId, after),
  );
  return true;
}

function _snapXf(n) {
  return {
    localOffset:      [...(n.localOffset      || [0, 0, 0])],
    localQuaternion:  [...(n.localQuaternion  || [0, 0, 0, 1])],
    orientationSteps: [...(n.orientationSteps || [0, 0, 0])],
    rotateEnabled:    n.rotateEnabled !== false,
    moveEnabled:      n.moveEnabled   !== false,
  };
}

function _applyXf(nodeId, xf) {
  const n = state.get('nodeById')?.get(nodeId);
  if (!n) return;
  n.localOffset      = [...xf.localOffset];
  n.localQuaternion  = [...xf.localQuaternion];
  n.orientationSteps = [...xf.orientationSteps];
  n.rotateEnabled    = xf.rotateEnabled;
  n.moveEnabled      = xf.moveEnabled;
  const obj = steps.object3dById?.get(nodeId);
  if (obj) applyNodeTransformToObject3D(n, obj, true);
  steps.scheduleTransformSync?.();
  state.markDirty?.();
  state.emit('change:treeData', state.get('treeData'));
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
