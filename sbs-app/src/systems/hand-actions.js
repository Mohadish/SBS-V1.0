/**
 * SBS — hand actions (V0.3.4.128): every mutation of a hand, undoable.
 * ─────────────────────────────────────────────────────────────────────
 * Add / remove a hand (a tree node, type 'hand'), choose its pose and how
 * closed it is, show / hide the ghost prop, align it to the part by mapping
 * the prop's three points (the snap picker's 3-point mapping), release /
 * open per step, and — fine-tune — pin a fingertip to what the user clicks
 * or drags (mesh + local point, the cable-socket recipe) so that finger bends
 * on to it. The rig and the solve live in systems/hands.js.
 *
 * State keys: `handPicking` = { nodeId, finger } while a fingertip waits for
 * its click; `selectedHandControl` = { nodeId, key } for the gizmo (a finger
 * or 'forearm'); `handFineTune` = the hand whose handles are up.
 */

import { state }       from '../core/state.js';
import { sceneCore }   from '../core/scene.js';
import { steps }       from './steps.js';
import { undoManager } from './undo.js';
import { createNode }  from '../core/schema.js';
import { buildNodeMap, findParent } from '../core/nodes.js';
import { applyNodeTransformToObject3D } from '../core/transforms.js';
import { setStatus, setStickyStatus, clearStickyStatus } from '../ui/status.js';
import * as hands      from './hands.js';
import * as placePicker from './hardware-place-picker.js';

const _clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const _node  = (id) => { const n = state.get('nodeById')?.get(id); return n && n.type === 'hand' ? n : null; };

export function snapshotParams(id) { const n = _node(id); return n ? _clone(n.handParams || hands.defaultHandParams()) : null; }
const _xfOf = (n) => ({ localOffset: [...(n.localOffset || [0, 0, 0])], localQuaternion: [...(n.localQuaternion || [0, 0, 0, 1])], orientationSteps: [...(n.orientationSteps || [0, 0, 0])] });

// ── tree attach / detach ─────────────────────────────────────────────────────

function _parentForNew() {
  let root = state.get('treeData');
  if (!root) {
    root = { id: 'scene_root', name: 'Scene', type: 'scene', children: [], object3d: sceneCore.rootGroup, localVisible: true };
    steps.object3dById.set('scene_root', sceneCore.rootGroup);
    state.setState({ treeData: root, nodeById: buildNodeMap(root) });
  }
  const selId = state.get('selectedId');
  const sel = selId ? state.get('nodeById')?.get(selId) : null;
  if (sel && (sel.type === 'folder' || sel.type === 'model' || sel.type === 'scene')) return sel;
  return root;
}

function _attach(node, parentId) {
  const root = state.get('treeData');
  const parent = state.get('nodeById')?.get(parentId) || root;
  if (!parent) return;
  const obj = hands.ensureHandObject3D(node);
  const parentObj = parent.object3d ?? steps.object3dById?.get(parent.id) ?? null;
  if (obj) {
    if (parentObj && obj.parent !== parentObj) { if (obj.parent) obj.parent.remove(obj); parentObj.add(obj); }
    applyNodeTransformToObject3D(node, obj);
    steps.object3dById.set(node.id, obj);
  }
  parent.children = parent.children || [];
  if (!parent.children.some(c => c.id === node.id)) parent.children.push(node);
  state.setState({ nodeById: buildNodeMap(root) });
  state.emit('change:treeData', root);
  hands.markHandDirty(node.id);
  steps.scheduleTransformSync?.();
  steps.flushSync?.();
  sceneCore.requestRender?.(200);
}

function _detach(id) {
  const root = state.get('treeData');
  if (!root) return;
  const n = state.get('nodeById')?.get(id);
  const obj = n?.object3d || steps.object3dById?.get(id);
  if (obj) { if (obj.parent) obj.parent.remove(obj); obj.traverse?.(o => { o.geometry?.dispose?.(); }); }
  steps.object3dById.delete(id);
  (function splice(p) {
    const kids = p.children || [];
    for (let i = 0; i < kids.length; i++) { if (kids[i].id === id) { kids.splice(i, 1); return true; } if (splice(kids[i])) return true; }
    return false;
  })(root);
  const strip = (spec) => {
    if (!spec) return spec;
    let ch = false; const kids = [];
    for (const c of (spec.children || [])) { if (c.id === id) { ch = true; continue; } const r = strip(c); if (r !== c) ch = true; kids.push(r); }
    return ch ? { ...spec, children: kids } : spec;
  };
  const next = (state.get('steps') || []).map(s => {
    const snap = s.snapshot || {};
    let changed = false;
    const tree = strip(snap.tree); if (tree !== snap.tree) changed = true;
    let vis = snap.visibility, tr = snap.transforms;
    if (vis && id in vis) { vis = { ...vis }; delete vis[id]; changed = true; }
    if (tr  && id in tr)  { tr  = { ...tr  }; delete tr[id];  changed = true; }
    return changed ? { ...s, snapshot: { ...snap, tree, visibility: vis, transforms: tr } } : s;
  });
  const patch = { steps: next, nodeById: buildNodeMap(root) };
  if (state.get('selectedId') === id) { patch.selectedId = null; patch.multiSelectedIds = new Set(); }
  if (state.get('selectedHandControl')?.nodeId === id) patch.selectedHandControl = null;
  if (state.get('handPicking')?.nodeId === id) patch.handPicking = null;
  if (state.get('handFineTune') === id) patch.handFineTune = null;
  state.setState(patch);
  state.emit('change:treeData', root);
  sceneCore.requestRender?.(200);
}

// ── add / remove ─────────────────────────────────────────────────────────────

export function addHand(side = 'right', pose = 'handle') {
  const parent = _parentForNew();
  const left = side === 'left';
  const params = hands.defaultHandParams();
  if (hands.HAND_POSES[pose]) params.pose = pose;
  const node = createNode('hand', { name: left ? 'Left hand' : 'Right hand', handSide: left ? 'left' : 'right', handParams: params });
  node.pivotEnabled = false;
  try {   // start it at the camera's orbit centre so it is on screen
    const T = window.THREE;
    const c = sceneCore.controls?.pivot || sceneCore.controls?.target;
    if (c && T) {
      const parentObj = parent.object3d ?? steps.object3dById?.get(parent.id);
      const local = parentObj ? parentObj.worldToLocal(new T.Vector3(c.x, c.y, c.z)) : new T.Vector3(c.x, c.y, c.z);
      node.localOffset = [local.x, local.y, local.z];
    }
  } catch {}
  _attach(node, parent.id);
  state.markDirty();
  undoManager.push(`Add ${node.name}`, () => _detach(node.id), () => _attach(node, parent.id));
  state.setState({ selectedId: node.id, multiSelectedIds: new Set([node.id]), selectedHandControl: null, handFineTune: null });
  return node.id;
}

export function removeHand(id) {
  const n = _node(id);
  if (!n) return false;
  const parentId = findParent(state.get('treeData'), id)?.id || 'scene_root';
  const keep = n;
  _detach(id);
  state.markDirty();
  undoManager.push(`Delete ${keep.name || 'hand'}`, () => _attach(keep, parentId), () => _detach(id));
  return true;
}

// ── params ───────────────────────────────────────────────────────────────────

function _applyParams(id, params, { flush = true } = {}) {
  const n = _node(id);
  if (!n) return;
  n.handParams = _clone(params);
  hands.markHandDirty(id);
  // a pose / size change rebuilds the rig in place (the group keeps its parent + transform)
  const parent = n.object3d?.parent;
  const g = hands.ensureHandObject3D(n);
  if (g && parent && g.parent !== parent) { parent.add(g); steps.object3dById.set(id, g); }
  hands.solveHand(n);
  if (flush) { steps.scheduleTransformSync?.(); state.emit('change:treeData', state.get('treeData')); }
  sceneCore.requestRender?.(120);
}

/** Patch a hand's params; one undo entry (label) unless label is null. `before` = a snapshot from earlier (a drag). */
export function setHandParams(id, patch, label = 'Edit hand', { before = null } = {}) {
  const n = _node(id);
  if (!n) return false;
  const prev = before || _clone(n.handParams || hands.defaultHandParams());
  const next = { ..._clone(n.handParams || hands.defaultHandParams()), ...patch };
  // a live slider move (no label) must not emit change:treeData — the tab would
  // re-render under the pointer and kill the drag; the commit (with a label) does
  _applyParams(id, next, { flush: !!label });
  state.markDirty();
  if (label) undoManager.push(label, () => _applyParams(id, prev), () => _applyParams(id, next));
  return true;
}
export function setHandPose(id, pose) {
  if (!hands.HAND_POSES[pose]) return false;
  return setHandParams(id, { pose, ghost: true }, `Hand pose: ${hands.HAND_POSES[pose].label}`);
}
export function setHandReleased(id, released) {
  return setHandParams(id, { released: !!released }, released ? 'Release the hand' : 'Grip again');
}
export function setGhostVisible(id, on) {
  return setHandParams(id, { ghost: !!on }, on ? 'Show the ghost prop' : 'Hide the ghost prop');
}

// ── align to the part: map the prop's three points ───────────────────────────

/** Start the 3-point mapping: the user clicks, on the real part, the three points the prop names. */
export function startAlignHand(id) {
  const n = _node(id);
  if (!n) return false;
  if (n.handParams?.released) { setStatus('A released hand has no grip to align — turn "Release at this step" off first.', 'warn', 4000); return false; }
  const src = hands.ghostPointsWorld(n);
  if (!src) { setStatus('This pose holds nothing — place it with the gizmo.', 'info', 3500); return false; }
  const labels = hands.ghostPointLabels(n);
  // the ghost must be visible to see what is being mapped
  if (n.handParams?.ghost === false) { n.handParams.ghost = true; hands.markHandDirty(id); hands.solveHand(n); }
  state.setState({ selectedId: id, multiSelectedIds: new Set([id]), selectedHandControl: null, handFineTune: null });
  placePicker.startMapNodeBy3Points(id, src, labels, () => {
    // landed: the ghost has done its job
    const cur = _clone(n.handParams || hands.defaultHandParams());
    if (cur.ghost !== false) { cur.ghost = false; _applyParams(id, cur); }
    setStatus('Hand aligned to the part. Fine-tune with the gizmo; double-click the hand for the finger handles.', 'success', 6000);
  });
  return true;
}

// ── fine-tune: pinned fingertips ─────────────────────────────────────────────

function _nodeIdForObject(obj) {
  const nb = state.get('nodeById');
  let cur = obj;
  while (cur) {
    if (cur.userData?.nodeId && nb?.get(cur.userData.nodeId)?.object3d === cur) return cur.userData.nodeId;
    if (nb) for (const [id, node] of nb) if (node?.object3d === cur) return id;
    cur = cur.parent;
  }
  return null;
}

export function setHandFineTune(id) {
  const n = id ? _node(id) : null;
  state.setState({ handFineTune: n ? id : null, ...(n ? { selectedId: id, multiSelectedIds: new Set([id]) } : {}) });
  if (n) setStatus('Fine-tune: drag a fingertip handle to pin that finger there (it bends to reach it), the yellow one to swing the forearm. Esc leaves.', 'info', 6000);
}

export function startHandPick(id, finger) {
  const n = _node(id);
  if (!n || !hands.HAND_FINGERS.includes(finger)) return;
  state.setState({ handPicking: { nodeId: id, finger }, selectedId: id, multiSelectedIds: new Set([id]), selectedHandControl: null, handFineTune: id });
  setStickyStatus(`🖐 ${hands.FINGER_LABEL[finger]}: click the object where the fingertip touches · Esc stops`, 'info', 'handpick');
}
export function stopHandPick() {
  if (!state.get('handPicking')) return;
  state.setState({ handPicking: null });
  clearStickyStatus('handpick');
}

/** The viewport click while picking: pin the finger to the hit (mesh + local point), or a free point. */
export function setHandFingerFromHit(id, finger, hit) {
  const n = _node(id);
  if (!n || !hit?.point) return false;
  const meshId = _nodeIdForObject(hit.object);
  let t;
  if (meshId && meshId !== id && !hit.object.userData?.handNodeId) {
    const local = hit.object.worldToLocal(hit.point.clone());
    const nl = hit.face?.normal ? hit.face.normal.clone().normalize() : null;
    t = { nodeId: meshId, anchorLocal: [local.x, local.y, local.z], normalLocal: nl ? [nl.x, nl.y, nl.z] : null, cachedWorldPos: [hit.point.x, hit.point.y, hit.point.z] };
  } else {
    t = { pos: [hit.point.x, hit.point.y, hit.point.z] };
  }
  const cur = _clone(n.handParams || hands.defaultHandParams());
  setHandParams(id, { targets: { ...cur.targets, [finger]: t } }, `Pin ${hands.FINGER_LABEL[finger]}`);
  stopHandPick();
  const r = hands.solveHand(n);
  setStatus(`${hands.FINGER_LABEL[finger]} pinned${r.unreached.includes(finger) ? ' — out of reach from here; move the hand closer' : ''}.`, r.unreached.includes(finger) ? 'warn' : 'success', 5000);
  return true;
}

export function clearHandFinger(id, finger) {
  const n = _node(id);
  if (!n) return false;
  const cur = _clone(n.handParams || hands.defaultHandParams());
  if (!cur.targets?.[finger]) return false;
  return setHandParams(id, { targets: { ...cur.targets, [finger]: null } }, `Unpin ${hands.FINGER_LABEL[finger]}`);
}
export function clearAllFingers(id) {
  const n = _node(id);
  if (!n) return false;
  const targets = {}; for (const f of hands.HAND_FINGERS) targets[f] = null;
  return setHandParams(id, { targets, forearm: null }, 'Unpin every finger');
}

// ── controls: live moves from the gizmo, one undo on commit ──────────────────

export function selectHandControl(id, key) {
  const n = _node(id);
  if (!n || !hands.HAND_CONTROLS.includes(key) || key === 'palm') return;
  state.setState({ selectedHandControl: { nodeId: id, key }, selectedId: id, multiSelectedIds: new Set([id]), handFineTune: id, selectedCablePoint: null, selectedCablePoints: [], selectedCableSocket: null });
}

/** Move a control to a world position (live, no undo): a fingertip target (pins it) or the forearm point. */
export function moveHandControlLive(id, key, worldPos) {
  const n = _node(id);
  if (!n) return;
  const p = _clone(n.handParams || hands.defaultHandParams());
  if (key === 'forearm') {
    p.forearm = [worldPos.x, worldPos.y, worldPos.z];
  } else if (hands.HAND_FINGERS.includes(key)) {
    const t = p.targets?.[key];
    if (t?.nodeId) {   // keep it riding the same part: re-express under that part
      const host = state.get('nodeById')?.get(t.nodeId)?.object3d;
      if (host) { const l = host.worldToLocal(worldPos.clone()); t.anchorLocal = [l.x, l.y, l.z]; t.cachedWorldPos = [worldPos.x, worldPos.y, worldPos.z]; }
      else p.targets[key] = { pos: [worldPos.x, worldPos.y, worldPos.z] };
    } else {
      p.targets[key] = { pos: [worldPos.x, worldPos.y, worldPos.z] };
    }
  } else return;
  _applyParams(id, p, { flush: false });
}

/** The drag is over: one undo entry from the snapshot taken at its start. */
export function commitHandControl(id, key, before) {
  const n = _node(id);
  if (!n) return;
  const after = _clone(n.handParams || hands.defaultHandParams());
  const prev = before || after;
  const label = key === 'forearm' ? 'Move the forearm' : `Pin the ${hands.FINGER_LABEL[key]?.toLowerCase() || 'finger'} tip`;
  _applyParams(id, after);
  state.markDirty();
  undoManager.push(label, () => _applyParams(id, prev), () => _applyParams(id, after));
}

/** Wire the housekeeping: a control selection / fine-tune dies with its hand's selection. */
export function initHandActions() {
  state.on('change:selectedId', (id) => {
    const c = state.get('selectedHandControl');
    if (c && c.nodeId !== id) state.setState({ selectedHandControl: null });
    const pk = state.get('handPicking');
    if (pk && pk.nodeId !== id && id) stopHandPick();
    const ft = state.get('handFineTune');
    if (ft && ft !== id) state.setState({ handFineTune: null });
  });
}
