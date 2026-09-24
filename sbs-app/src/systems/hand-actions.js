/**
 * SBS — hand actions (V0.3.4.127): every mutation of a hand, undoable.
 * ─────────────────────────────────────────────────────────────────────
 * Add / remove a hand (a tree node, type 'hand'), pin a fingertip to what
 * the user clicked (mesh + local point, the cable-socket recipe), unpin,
 * fit the palm, release / open, move a control (fingertip target, palm,
 * forearm point) live from the gizmo and commit it as ONE undo entry.
 * The rig and the solve live in systems/hands.js.
 *
 * State keys: `handPicking` = { nodeId, finger } while the user is asked to
 * click where a fingertip touches; `selectedHandControl` = { nodeId, key }
 * for the gizmo (key = finger | 'palm' | 'forearm').
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

const _clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const _node  = (id) => { const n = state.get('nodeById')?.get(id); return n && n.type === 'hand' ? n : null; };

export function isPinned(node) {
  const p = node?.handParams;
  return !!p && !p.released && hands.HAND_FINGERS.some(f => p.targets?.[f]);
}
export function snapshotParams(id) { const n = _node(id); return n ? _clone(n.handParams || hands.defaultHandParams()) : null; }

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
  // solidify now (see actions._readdPrimitiveNode): the active step must hold the new node at once
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
  state.setState(patch);
  state.emit('change:treeData', root);
  sceneCore.requestRender?.(200);
}

// ── add / remove ─────────────────────────────────────────────────────────────

export function addHand(side = 'right') {
  const parent = _parentForNew();
  const left = side === 'left';
  const node = createNode('hand', { name: left ? 'Left hand' : 'Right hand', handSide: left ? 'left' : 'right', handParams: hands.defaultHandParams() });
  node.pivotEnabled = false;
  // start it in front of the camera's target so it is on screen
  try {
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
  state.setState({ selectedId: node.id, multiSelectedIds: new Set([node.id]), selectedHandControl: null });
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
  _applyParams(id, next);
  state.markDirty();
  if (label) undoManager.push(label, () => _applyParams(id, prev), () => _applyParams(id, next));
  return true;
}

// ── pinning fingertips ───────────────────────────────────────────────────────

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

export function startHandPick(id, finger) {
  const n = _node(id);
  if (!n || !hands.HAND_FINGERS.includes(finger)) return;
  state.setState({ handPicking: { nodeId: id, finger }, selectedId: id, multiSelectedIds: new Set([id]), selectedHandControl: null });
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
  const targets = { ...cur.targets, [finger]: t };
  setHandParams(id, { targets, released: false }, `Pin ${hands.FINGER_LABEL[finger]}`);
  stopHandPick();
  const r = hands.solveHand(n);
  setStatus(`${hands.FINGER_LABEL[finger]} pinned${meshId && meshId !== id ? ` to "${state.get('nodeById')?.get(meshId)?.name || 'the part'}"` : ' (free point)'} — ${r.pinned} finger(s) on. Pick the next finger, or Place hand.${r.unreached.length ? ` Out of reach: ${r.unreached.map(f => hands.FINGER_LABEL[f]).join(', ')}.` : ''}`, 'success', 6000);
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
  return setHandParams(id, { targets, palm: null }, 'Unpin every finger');
}

/** Place hand = fit the palm to the pinned fingertips afresh (drops a palm the user moved). */
export function fitHand(id) {
  const n = _node(id);
  if (!n) return false;
  if (!isPinned(n)) { setStatus('Pin at least one finger first — pick a finger, then click where it touches.', 'warn', 4000); return false; }
  setHandParams(id, { palm: null, forearm: null, released: false }, 'Place hand');
  const r = hands.solveHand(n);
  setStatus(`Hand placed on ${r.pinned} finger(s).${r.unreached.length ? ` Out of reach: ${r.unreached.map(f => hands.FINGER_LABEL[f]).join(', ')} — move the palm (pink) or the forearm (yellow) handle.` : ''}`, 'success', 6000);
  return true;
}

export function setHandReleased(id, released) {
  const n = _node(id);
  if (!n) return false;
  return setHandParams(id, { released: !!released }, released ? 'Release the hand' : 'Grip again');
}

// ── controls: live moves from the gizmo, one undo on commit ──────────────────

export function selectHandControl(id, key) {
  const n = _node(id);
  if (!n || !hands.HAND_CONTROLS.includes(key)) return;
  state.setState({ selectedHandControl: { nodeId: id, key }, selectedId: id, multiSelectedIds: new Set([id]), selectedCablePoint: null, selectedCablePoints: [], selectedCableSocket: null });
}

/** Move a control to a world position (live, no undo): a fingertip target, the palm, the forearm point. */
export function moveHandControlLive(id, key, worldPos) {
  const n = _node(id);
  if (!n) return;
  const T = window.THREE;
  const p = _clone(n.handParams || hands.defaultHandParams());
  if (key === 'palm') {
    const q = new T.Quaternion(); n.object3d?.getWorldQuaternion(q);
    const cur = p.palm?.quat ? p.palm.quat : [q.x, q.y, q.z, q.w];
    p.palm = { pos: [worldPos.x, worldPos.y, worldPos.z], quat: cur };
    if (!isPinned(n)) {   // a released hand: the node's own transform is the truth
      const group = n.object3d;
      if (group?.parent) { const lp = group.parent.worldToLocal(worldPos.clone()); const bp = n.baseLocalPosition || [0, 0, 0]; n.localOffset = [lp.x - bp[0], lp.y - bp[1], lp.z - bp[2]]; }
      p.palm = null;
    }
  } else if (key === 'forearm') {
    p.forearm = [worldPos.x, worldPos.y, worldPos.z];
  } else {
    const t = p.targets?.[key];
    if (t?.nodeId) {   // keep it riding the same part: re-express under that part
      const host = state.get('nodeById')?.get(t.nodeId)?.object3d;
      if (host) { const l = host.worldToLocal(worldPos.clone()); t.anchorLocal = [l.x, l.y, l.z]; t.cachedWorldPos = [worldPos.x, worldPos.y, worldPos.z]; }
      else p.targets[key] = { pos: [worldPos.x, worldPos.y, worldPos.z] };
    } else {
      p.targets[key] = { pos: [worldPos.x, worldPos.y, worldPos.z] };
    }
    p.released = false;
  }
  _applyParams(id, p, { flush: false });
}

/** The palm's world quaternion now — the gizmo's rotate is cumulative from the drag start, so the target keeps this. */
export function palmWorldQuat(id) {
  const T = window.THREE; const q = new T.Quaternion();
  _node(id)?.object3d?.getWorldQuaternion(q);
  return q;
}

/** Rotate the palm in place about a world axis: `angle` is the TOTAL angle since the drag began, applied on `startQuat`. */
export function rotatePalmLive(id, axisWorld, angle, startQuat) {
  const n = _node(id);
  if (!n) return;
  const T = window.THREE;
  const p = _clone(n.handParams || hands.defaultHandParams());
  const q = startQuat ? startQuat.clone() : palmWorldQuat(id);
  const pos = new T.Vector3(); n.object3d?.getWorldPosition(pos);
  const r = new T.Quaternion().setFromAxisAngle(axisWorld.clone().normalize(), angle);
  const nq = r.multiply(q);
  if (isPinned(n)) {
    p.palm = { pos: [pos.x, pos.y, pos.z], quat: [nq.x, nq.y, nq.z, nq.w] };
    _applyParams(id, p, { flush: false });
  } else {
    const group = n.object3d;
    if (group?.parent) {
      const pq = new T.Quaternion(); group.parent.getWorldQuaternion(pq);
      const lq = pq.invert().multiply(nq);
      const bq = n.baseLocalQuaternion || [0, 0, 0, 1];
      const dq = new T.Quaternion(bq[0], bq[1], bq[2], bq[3]).invert().multiply(lq);
      n.localQuaternion = [dq.x, dq.y, dq.z, dq.w];
      hands.markHandDirty(id); hands.solveHand(n); sceneCore.requestRender?.(120);
    }
  }
}

/** The drag is over: one undo entry from the snapshot taken at its start. */
export function commitHandControl(id, key, before) {
  const n = _node(id);
  if (!n) return;
  const after = _clone(n.handParams || hands.defaultHandParams());
  const label = key === 'palm' ? 'Move the palm' : key === 'forearm' ? 'Move the forearm' : `Move the ${hands.FINGER_LABEL[key].toLowerCase()} tip`;
  if (isPinned(n) || key !== 'palm') {
    const prev = before || after;
    _applyParams(id, after);
    state.markDirty();
    undoManager.push(label, () => _applyParams(id, prev), () => _applyParams(id, after));
  } else {
    // a released hand moved as a unit: the node transform changed — sync it like any transform edit
    steps.scheduleTransformSync?.();
    state.emit('change:treeData', state.get('treeData'));
    state.markDirty();
  }
}

/** Wire the housekeeping: a control selection dies with its hand's selection. */
export function initHandActions() {
  state.on('change:selectedId', (id) => {
    const c = state.get('selectedHandControl');
    if (c && c.nodeId !== id) state.setState({ selectedHandControl: null });
    const pk = state.get('handPicking');
    if (pk && pk.nodeId !== id && id) stopHandPick();
  });
}
