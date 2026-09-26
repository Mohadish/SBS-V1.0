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
import { createNode, generateId } from '../core/schema.js';
import * as userSettings from '../core/user-settings.js';   // ★ V0.3.4.145 the grip library (a machine setting)
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
  _pivotIntoProp(node);
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

/** The pivot into the prop's centre, aligned to it (user: "makes manipulation much easier"). */
function _pivotIntoProp(n) {
  const f = hands.propFrame(n);
  if (!f) return;
  n.pivotLocalOffset = f.pos;
  n.pivotLocalQuaternion = f.quat;
  n.pivotEnabled = true;
}

function _applyParams(id, params, { flush = true } = {}) {
  const n = _node(id);
  if (!n) return;
  n.handParams = _clone(params);
  hands.markHandDirty(id);
  // a pose / size change rebuilds the rig in place (the group keeps its parent + transform);
  // the pivot follows the new prop
  const before = n.object3d, parent = before?.parent;
  const g = hands.ensureHandObject3D(n);
  if (g && g !== before) {
    if (parent && g.parent !== parent) parent.add(g);
    steps.object3dById.set(id, g);
    applyNodeTransformToObject3D(n, g);
    _pivotIntoProp(n);
  }
  const r = hands.solveHand(n);
  if (flush) { steps.scheduleTransformSync?.(); state.emit('change:treeData', state.get('treeData')); }
  sceneCore.requestRender?.(120);
  return r;
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
    const g = n.object3d; if (g) g.updateMatrixWorld(true);
    const l = g ? g.worldToLocal(hit.point.clone()) : hit.point;
    t = { local: [l.x, l.y, l.z] };   // not on a part (empty space / the hand itself): in the hand's frame
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
  return setHandParams(id, { targets, forearm: null, forearmLocal: null }, 'Unpin every finger');
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
  const g = n.object3d; if (g) g.updateMatrixWorld(true);
  const inHand = (w) => { const l = g ? g.worldToLocal(w.clone()) : w; return [l.x, l.y, l.z]; };
  if (key === 'forearm') {
    p.forearmLocal = inHand(worldPos); delete p.forearm;   // V0.3.4.130 — in the hand's frame: rides the hand and its group
  } else if (hands.HAND_FINGERS.includes(key)) {
    const t = p.targets?.[key];
    if (t?.nodeId) {   // keep it riding the same part: re-express under that part
      const host = state.get('nodeById')?.get(t.nodeId)?.object3d;
      if (host) { const l = host.worldToLocal(worldPos.clone()); t.anchorLocal = [l.x, l.y, l.z]; t.cachedWorldPos = [worldPos.x, worldPos.y, worldPos.z]; }
      else p.targets[key] = { local: inHand(worldPos) };
    } else {
      p.targets[key] = { local: inHand(worldPos) };   // not on a part: in the hand's frame, so it follows the hand
    }
  } else return;
  const r = _applyParams(id, p, { flush: false });
  // V0.3.4.149 — a dragged pin stays within the finger's REACH: past it the tip cannot
  // follow, the spread search sees a flat landscape and the left-right control dies
  // (the user: "the point should remain static at the last effective point"). A move
  // that leaves the finger clearly short of its pin is refused; the pin keeps the
  // last place the finger did reach, and follows again once the mouse comes back.
  if (hands.HAND_FINGERS.includes(key)) {
    const k = `${id}:${key}`;
    const L = Number(p.scale) || 190;
    const gap = r?.gaps?.[key] ?? 0;
    if (gap > 0.025 * L && _lastReachable.has(k)) _applyParams(id, _lastReachable.get(k), { flush: false });
    else _lastReachable.set(k, _clone(p));
  }
}
const _lastReachable = new Map();   // `${handId}:${finger}` → the params of the last reachable pin during a drag

/** The drag is over: one undo entry from the snapshot taken at its start. */
export function commitHandControl(id, key, before) {
  const n = _node(id);
  if (!n) return;
  _lastReachable.delete(`${id}:${key}`);
  const after = _clone(n.handParams || hands.defaultHandParams());
  const prev = before || after;
  const label = key === 'forearm' ? 'Move the forearm' : `Pin the ${hands.FINGER_LABEL[key]?.toLowerCase() || 'finger'} tip`;
  _applyParams(id, after);
  state.markDirty();
  undoManager.push(label, () => _applyParams(id, prev), () => _applyParams(id, after));
}

// ── 🧤 skin: the rig out as .glb, a skinned hand back in ─────────────────────

function _b64(ab) {
  const u8 = new Uint8Array(ab); let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Save the rig (right hand, 190 mm, at rest) as .fbx (or .glb) to skin a real hand to. */
export async function exportHandRig() {
  const path = await window.sbsNative?.saveFile?.({ title: 'Export the hand rig', defaultPath: 'sbs-hand-rig.fbx', filters: [{ name: 'FBX (ASCII 7.4)', extensions: ['fbx'] }, { name: 'glTF binary', extensions: ['glb'] }] });
  if (!path) return false;
  try {
    const fbx = !/\.glb$/i.test(path);
    let r, size;
    if (fbx) { const text = hands.buildHandRigFbx(190); size = text.length; r = await window.sbsNative.writeFile(path, text, 'utf-8'); }
    else     { const glb = hands.buildHandRigGlb(190); size = glb.byteLength; r = await window.sbsNative.writeFile(path, _b64(glb), 'base64'); }
    if (!r?.ok) throw new Error(r?.error || 'write failed');
    setStatus(`Hand rig exported (${Math.round(size / 1024)} KB). Skin a hand to its bones, keep their names, bring the file back with "Load skin".`, 'success', 8000);
    return true;
  } catch (e) {
    setStatus(`Rig export failed: ${e?.message || e}`, 'error', 6000);
    return false;
  }
}

/** Pick a skinned .fbx / .glb — becomes every hand's look on this machine. */
export async function pickHandSkin() {
  const path = await window.sbsNative?.openFile?.({ title: 'Load a skinned hand (.fbx / .glb)', filters: [{ name: 'Skinned hand', extensions: ['fbx', 'glb'] }, { name: 'FBX', extensions: ['fbx'] }, { name: 'glTF binary', extensions: ['glb'] }] });
  if (!path) return false;
  const info = await hands.setHandSkinFile(path);
  if (info.loaded) setStatus(info.missing.length ? `Skin loaded — bones not found: ${info.missing.join(', ')} (those joints will not move it).` : 'Skin loaded on every hand.', info.missing.length ? 'warn' : 'success', 7000);
  else setStatus(`Skin not loaded: ${info.error}`, 'error', 7000);
  return info.loaded;
}
/** 🧤 V0.3.4.152 — the skin's texture: an image next to the skin file, or '' for the file's own. */
export async function setSkinTexture(name) {
  const info = await hands.setHandSkinTexture(name);
  if (name && info.texture !== name) setStatus(`Texture "${name}" could not be loaded.`, 'error', 5000);
  else setStatus(name ? `Skin texture: ${name}.` : 'Skin texture: the file\'s own.', 'info', 3000);
  return info;
}
export async function clearHandSkin() {
  await hands.setHandSkinFile('');
  setStatus('Back to the procedural hand.', 'info', 3000);
}

// ── 🔧 adjust the grip (V0.3.4.145): the prop holds still, the hand re-seats ──
// A pose's prop does not always land right on the real part. In adjust mode the
// ghost keeps its WORLD pose while the wrist (the node's gizmo) and the
// fingertips move; Done commits the ghost's new place in the hand's frame
// (handParams.ghostOffset, one undo) — Align (3 points) then seats the hand
// that way, and ★ Save grip keeps it.
export function setHandAdjust(id) {
  const n = _node(id);
  if (!n) return false;
  if (n.handParams?.released) { setStatus('A released hand holds nothing to adjust against — turn "Release at this step" off first.', 'warn', 4000); return false; }
  const cur = state.get('handAdjust');
  if (cur && cur !== id) endHandAdjust();
  if (n.handParams?.ghost === false) { n.handParams.ghost = true; hands.markHandDirty(id); hands.solveHand(n); }
  if (!hands.beginGhostLock(n)) { setStatus('This pose holds nothing — there is no prop to hold still. Place the hand with the gizmo.', 'info', 4000); return false; }
  state.setState({ handAdjust: id, handFineTune: id, selectedId: id, multiSelectedIds: new Set([id]), selectedHandControl: null });
  setStickyStatus('🔧 Adjust the grip: move / rotate the hand with the gizmo, drag the fingertips — the prop stays where it is. Esc or ✓ Done sets it.', 'info', 'handadjust');
  return true;
}
export function endHandAdjust() {
  const id = state.get('handAdjust');
  if (!id) return;
  const n = _node(id);
  clearStickyStatus('handadjust');
  state.setState({ handAdjust: null });
  if (!n) return;
  const offset = hands.currentGhostOffset(n);
  hands.endGhostLock(n);
  const prev = _clone(n.handParams || hands.defaultHandParams());
  if (offset && JSON.stringify(offset) !== JSON.stringify(prev.ghostOffset || null)) {
    setHandParams(id, { ghostOffset: offset }, 'Adjust the grip');
    _pivotIntoProp(n);
    steps.scheduleTransformSync?.();
    setStatus('Grip set. Align (3 points) seats the hand this way from now on; ★ Save grip keeps it for other hands.', 'success', 6000);
  }
}
/** The prop back where the pose lays it (a way back from an adjustment). */
export function resetGhostOffset(id) {
  const n = _node(id);
  if (!n) return false;
  if (state.get('handAdjust') === id) endHandAdjust();
  const ok = setHandParams(id, { ghostOffset: null }, 'Reset the grip offset');
  if (ok) { _pivotIntoProp(n); steps.scheduleTransformSync?.(); }
  return ok;
}

// ── ★ saved grips (V0.3.4.145): a machine library; a hand carries its own copy ──
export function listGrips() { return (userSettings.get().hands?.grips || []).filter(g => g && g.angles); }
/**
 * The hand's grip as it stands → the library, and on to this hand as its own pose.
 * The prop is the one the hand is using, seated as it is now (V0.3.4.146 — the
 * user: "I set it relative to a grip, you can see which one"); the adjust offset
 * is baked into the saved layout.
 */
export async function saveGrip(id, name) {
  const n = _node(id);
  if (!n) return null;
  const cap = hands.captureGrip(n);
  if (!cap) return null;
  const p = n.handParams || hands.defaultHandParams();
  const kind = hands.poseOf(p).ghost || null;
  const grip = {
    id: generateId(), name: String(name || 'Grip').trim() || 'Grip',
    ghost: kind, angles: cap.angles, layout: cap.layout, mirror: cap.mirror,
  };
  try { await userSettings.patch({ hands: { grips: [...listGrips(), grip] } }); } catch (e) { console.warn('[hands] grip library:', e?.message); }
  applyGrip(id, grip);
  return grip;
}
export function applyGrip(id, grip) {
  const n = _node(id);
  if (!n || !grip?.angles) return false;
  if (state.get('handAdjust') === id) endHandAdjust();
  const targets = {}; for (const f of hands.HAND_FINGERS) targets[f] = null;
  const ok = setHandParams(id, {
    pose: 'custom',
    grip: { id: grip.id, name: grip.name, ghost: grip.ghost || null, angles: _clone(grip.angles), layout: grip.layout ? _clone(grip.layout) : null, mirror: !!grip.mirror },
    ghostOffset: null, targets, ghost: true, closed: 1,   // the seating lives in the layout
  }, `Grip: ${grip.name}`);
  if (ok) { _pivotIntoProp(n); steps.scheduleTransformSync?.(); }
  return ok;
}
/** A library grip re-captured from this hand (fingers + prop seating as they are now); the hand takes the new copy. */
export async function updateGrip(id, gripId) {
  const n = _node(id);
  if (!n) return null;
  const cap = hands.captureGrip(n);
  if (!cap) return null;
  const grips = listGrips();
  const i = grips.findIndex(g => g.id === gripId);
  if (i < 0) return null;
  const p = n.handParams || hands.defaultHandParams();
  const grip = { ...grips[i], ghost: hands.poseOf(p).ghost || grips[i].ghost || null, angles: cap.angles, layout: cap.layout, mirror: cap.mirror };
  grips[i] = grip;
  try { await userSettings.replace({ hands: { ...(userSettings.get().hands || {}), grips } }); } catch (e) { console.warn('[hands] grip library:', e?.message); }
  applyGrip(id, grip);
  return grip;
}
export async function renameGrip(gripId, name) {
  const nm = String(name || '').trim();
  if (!nm) return false;
  const grips = listGrips().map(g => g.id === gripId ? { ...g, name: nm } : g);
  try { await userSettings.replace({ hands: { ...(userSettings.get().hands || {}), grips } }); } catch (e) { console.warn('[hands] grip library:', e?.message); }
  state.emit('hands:gripsChanged');
  return true;
}

// ── 📋 copy / paste a grip (V0.3.4.150): everything from the wrist up; the wrist itself stays ──
// Pose, closed, pins, prop + seating, release / open, the forearm point — all in
// the hand's frame. A pin on a part becomes a pin in the hand's frame at copy
// time (the finger's shape travels, not the part). Size is the hand's own.
let _gripClip = null;
export function hasGripClip() { return !!_gripClip; }
export function copyGrip(id) {
  const n = _node(id);
  if (!n) return false;
  const Th = window.THREE;
  const p = _clone(n.handParams || hands.defaultHandParams());
  const g = n.object3d; if (g) g.updateMatrixWorld(true);
  const inHand = (w) => { const l = g ? g.worldToLocal(w.clone()) : w; return [l.x, l.y, l.z]; };
  const targets = {};
  for (const f of hands.HAND_FINGERS) {
    const t = p.targets?.[f];
    if (!t) { targets[f] = null; continue; }
    if (Array.isArray(t.local)) { targets[f] = { local: [...t.local] }; continue; }
    const w = hands.targetWorld(n, f);
    targets[f] = w ? { local: inHand(w) } : null;
  }
  let forearmLocal = Array.isArray(p.forearmLocal) ? [...p.forearmLocal] : null;
  if (!forearmLocal && Array.isArray(p.forearm) && Th) forearmLocal = inHand(new Th.Vector3(p.forearm[0], p.forearm[1], p.forearm[2]));
  _gripClip = {
    pose: p.pose, grip: p.grip ? _clone(p.grip) : null, closed: p.closed ?? 1, targets,
    ghost: p.ghost !== false, ghostOffset: p.ghostOffset ? _clone(p.ghostOffset) : null,
    released: !!p.released, open: Number(p.open) || 0, forearmLocal,
  };
  setStatus('Grip copied. Right-click a hand, at any step ▸ Paste grip — the hand itself stays where it is.', 'info', 4500);
  return true;
}
export function pasteGrip(id) {
  const n = _node(id);
  if (!n || !_gripClip) return false;
  if (state.get('handAdjust') === id) endHandAdjust();
  const c = _clone(_gripClip);
  const ok = setHandParams(id, {
    pose: c.pose, grip: c.grip, closed: c.closed, targets: c.targets, ghost: c.ghost, ghostOffset: c.ghostOffset,
    released: c.released, open: c.open, forearmLocal: c.forearmLocal, forearm: null,
  }, 'Paste grip');
  if (ok) { _pivotIntoProp(n); steps.scheduleTransformSync?.(); }
  return ok;
}

export async function deleteGrip(gripId) {
  const grips = listGrips().filter(g => g.id !== gripId);
  try { await userSettings.replace({ hands: { ...(userSettings.get().hands || {}), grips } }); } catch (e) { console.warn('[hands] grip library:', e?.message); }
  state.emit('hands:gripsChanged');
}

/** Wire the housekeeping: a control selection / fine-tune / adjust dies with its hand's selection. */
export function initHandActions() {
  state.on('change:selectedId', (id) => {
    const c = state.get('selectedHandControl');
    if (c && c.nodeId !== id) state.setState({ selectedHandControl: null });
    const pk = state.get('handPicking');
    if (pk && pk.nodeId !== id && id) stopHandPick();
    const adj = state.get('handAdjust');
    if (adj && adj !== id) endHandAdjust();
    const ft = state.get('handFineTune');
    if (ft && ft !== id) state.setState({ handFineTune: null });
  });
  state.on('change:activeStepId', () => { if (state.get('handAdjust')) endHandAdjust(); });
  // 🧤 a skin loaded / cleared: every hand is rebuilt in place (the rig build puts it on)
  state.on('hands:skinChanged', () => {
    const nb = state.get('nodeById'); if (!nb) return;
    for (const [, n] of nb) if (n?.type === 'hand') _applyParams(n.id, n.handParams || hands.defaultHandParams(), { flush: false });
    state.emit('change:treeData', state.get('treeData'));
    sceneCore.requestRender?.(200);
  });
}
