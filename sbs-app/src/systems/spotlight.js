/**
 * SBS — 🔦 SPOTLIGHT AT THIS STEP (V0.3.4.82, phase 1).
 * ──────────────────────────────────────────────────────
 * "Before I insert the screw I want it up close to the camera." A per-STEP flag
 * on a transform-bearing node (folder / hardware / primitive / shape): while it
 * is on, the node's pose in that step is not a place in the world but a place
 * IN THE PICTURE — where on the screen, how big, which way round — and the
 * world pose is derived from the step's camera. Orbit the camera on that step
 * and the object follows; move it with the gizmo and the picture-place is
 * re-captured; the next step puts it back where it lives.
 *
 * THE DESCRIPTOR (node.spotlight — per step, it rides snapshot.transforms):
 *   { u, v, s, q:[x,y,z,w], q0:[…], cl:[x,y,z], r, custom, home }
 *   u, v  — where the object's CENTRE sits: fractions of the frame WIDTH and
 *           HEIGHT from the middle (u = -1/3 → the middle of the left third)
 *   s     — how big: the fraction of the frame height its bounding sphere spans
 *   q     — its orientation RELATIVE TO THE CAMERA (so orbiting keeps the same
 *           face towards you); q0 = the one it had when the flag went on
 *   cl, r — its bounding-box centre in its own space, and the sphere radius —
 *           measured once when the flag goes on, so the derivation is the same
 *           at every activation, whatever the camera
 *   custom — true once the user moved it: Reset puts it back on the defaults
 *   home  — the step's OWN pose underneath (localOffset / localQuaternion /
 *           orientationSteps + the enabled flags), taken when the flag went on.
 *           The spotlight is a LAYER over it, absolute but not destructive:
 *           switch it off and the object is back where this step had it.
 * Fractions, not metres and not degrees of lens: the same descriptor gives the
 * same picture at any lens (the per-step perspective) and at the export's frame.
 *
 * WHAT IS STORED IN THE STEP is BOTH the descriptor and the baked transform —
 * a step is a self-contained snapshot and must render without this module.
 * The bake is re-derived at activation from the step's own camera, so a
 * camera template that changes later, or an export at another aspect, still
 * puts the object where the descriptor says.
 *
 * Phase 1 (this): flag, defaults, follow-the-camera while authoring, gizmo
 * re-capture, the dolly handle, reset, menus, undo. The transition INTO the
 * step is the ordinary travel. Phase 2: appear-in-place with a fade. Phase 3:
 * cables; raw meshes (which have no per-step transform) via a wrapper folder.
 */

import { state }     from '../core/state.js';
import { sceneCore } from '../core/scene.js';
import { steps }     from './steps.js';
import { undoManager } from './undo.js';
import { getCanonicalSize } from '../core/safe-frame.js';
import { frameHeight, distForFrame } from '../core/perspective.js';
import { isTransformNode, ensureTransformDefaults, setStoredQuaternion, captureTransformSnapshot, applyTransformSnapshot, applyNodeTransformToObject3D } from '../core/transforms.js';
import { setStatus } from '../ui/status.js';

/** The built-in starting place: the middle of the left third of the frame, a third of its height tall. */
export const SPOTLIGHT_DEFAULTS = Object.freeze({ u: -1 / 3, v: 0, s: 1 / 3 });
/** …unless the project set its own (state.spotlightDefaults, saved in the .sbsproj; null = the built-in). */
const _defaults = () => { const d = state.get('spotlightDefaults'); return (d && Number.isFinite(d.u) && Number.isFinite(d.v) && Number.isFinite(d.s)) ? { u: d.u, v: d.v, s: d.s } : { ...SPOTLIGHT_DEFAULTS }; };
const MIN_S = 0.02, MAX_S = 4, MIN_R = 1e-4;

const _T = () => window.THREE;
const _arr = (q) => [q.x, q.y, q.z, q.w];

// ─── the camera as a frame ──────────────────────────────────────────────────

/** Eye, right, up, forward and the lens of a CameraState (a step's) or of the live camera. */
function _frameOf(camState) {
  const T = _T();
  const cs = camState || sceneCore.getCameraState();
  const q = new T.Quaternion(...(cs.quaternion || [0, 0, 0, 1])).normalize();
  return {
    eye: new T.Vector3(...(cs.position || [0, 0, 0])),
    q,
    R: new T.Vector3(1, 0, 0).applyQuaternion(q),
    U: new T.Vector3(0, 1, 0).applyQuaternion(q),
    F: new T.Vector3(0, 0, -1).applyQuaternion(q),
    fov: Number(cs.fov) || 50,
    aspect: getCanonicalSize().aspect || (16 / 9),
  };
}

/**
 * The object's bounding sphere, measured in ITS OWN space (centre + radius), and its world scale.
 * updateWorldMatrix(true, true), never updateMatrixWorld(true): the latter trusts the PARENTS'
 * matrixWorld as it is, and right after a step's transforms are applied those can be stale —
 * while Box3.setFromObject refreshes the parents on its own. Mixing the two put the centre in
 * the wrong frame (caught by the maths test).
 */
function _measure(obj) {
  const T = _T();
  obj.updateWorldMatrix(true, true);   // parents too — see the note above
  const scale = new T.Vector3(); obj.matrixWorld.decompose(new T.Vector3(), new T.Quaternion(), scale);
  const sc = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z), 1e-9);
  // The box in the OBJECT'S OWN frame — not the world-axis box: a turned part's world box
  // is fatter than the part (its diagonal grows with the angle), which would make "a third
  // of the frame" a third of a sphere the part never fills. Each mesh's own bounds, taken
  // through its world matrix and back into the object's frame.
  const inv = new T.Matrix4().copy(obj.matrixWorld).invert();
  const box = new T.Box3();
  const p = new T.Vector3();
  obj.traverse((m) => {
    const g = m.geometry;
    if (!g || m.visible === false) return;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    if (!bb || bb.isEmpty()) return;
    const M = new T.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(M);
      box.expandByPoint(p);
    }
  });
  if (box.isEmpty()) return { cl: [0, 0, 0], r: MIN_R, sc };
  const cl = box.getCenter(new T.Vector3());
  const r = Math.max(MIN_R, box.getSize(new T.Vector3()).length() / 2);   // radius in object units (the object's own scale is inside)
  return { cl: [cl.x, cl.y, cl.z], r, sc };
}

/** Where the object's centre is in the world for this descriptor and this frame. */
function _targetPose(sp, fr, sc) {
  const T = _T();
  const H = (2 * sp.r * sc) / Math.max(MIN_S, Math.min(MAX_S, sp.s));   // frame height at the object's depth
  const dist = Math.max(distForFrame(H, fr.fov), 1e-3);
  const centre = fr.eye.clone().addScaledVector(fr.F, dist).addScaledVector(fr.R, sp.u * H * fr.aspect).addScaledVector(fr.U, sp.v * H);
  const quat = fr.q.clone().multiply(new T.Quaternion(...sp.q));
  // the object's ORIGIN: its centre offset, in its own space, turned by the new orientation
  const origin = centre.clone().sub(new T.Vector3(...sp.cl).multiplyScalar(sc).applyQuaternion(quat));
  return { origin, quat };
}

/** The descriptor that describes the object's CURRENT world pose in this frame (u, v, s, q only). */
function _describe(obj, sp, fr) {
  const T = _T();
  obj.updateWorldMatrix(true, true);   // parents too — see the note in _measure
  const wq = new T.Quaternion(), wp = new T.Vector3(), ws = new T.Vector3();
  obj.matrixWorld.decompose(wp, wq, ws);
  const sc = Math.max(Math.abs(ws.x), Math.abs(ws.y), Math.abs(ws.z), 1e-9);
  const centre = wp.clone().add(new T.Vector3(...sp.cl).multiplyScalar(sc).applyQuaternion(wq));
  const d = centre.sub(fr.eye);
  let dist = d.dot(fr.F);
  if (!(dist > 1e-3)) dist = Math.max(d.length(), 1e-3);        // behind the camera: keep the distance, lose the sign
  const H = Math.max(frameHeight(dist, fr.fov), 1e-6);
  return {
    u: d.dot(fr.R) / (H * fr.aspect),
    v: d.dot(fr.U) / H,
    s: Math.max(MIN_S, Math.min(MAX_S, (2 * sp.r * sc) / H)),
    q: _arr(fr.q.clone().invert().multiply(wq).normalize()),
  };
}

// ─── writing a world pose onto a node (the sanctioned way, minus the side effects) ──
// Mirrors hardware-actions._setInstancePoseRaw: world → parent-local, minus the base
// pose, quaternion through setStoredQuaternion, enabled flags ON (else the delta is
// ignored at render time). Activation must not dirty the project or re-sync the step,
// so the side effects are the caller's.
function _writeWorldPose(node, obj, worldPos, worldQuat) {
  const T = _T();
  obj.updateWorldMatrix(true, true);   // parents too — see the note in _measure
  const curScale = new T.Vector3();
  obj.matrixWorld.decompose(new T.Vector3(), new T.Quaternion(), curScale);
  const newWorld = new T.Matrix4().compose(worldPos.clone(), worldQuat.clone().normalize(), curScale);
  const parent = obj.parent;
  if (parent) parent.updateWorldMatrix(true, false);
  const invParent = parent ? new T.Matrix4().copy(parent.matrixWorld).invert() : new T.Matrix4();
  const nPos = new T.Vector3(), nQuat = new T.Quaternion(), nScale = new T.Vector3();
  new T.Matrix4().multiplyMatrices(invParent, newWorld).decompose(nPos, nQuat, nScale);
  ensureTransformDefaults(node);
  const blp = node.baseLocalPosition, blq = node.baseLocalQuaternion;
  node.localOffset = [nPos.x - blp[0], nPos.y - blp[1], nPos.z - blp[2]];
  const localQ = new T.Quaternion(blq[0], blq[1], blq[2], blq[3]).invert().multiply(nQuat);
  setStoredQuaternion(node, [localQ.x, localQ.y, localQ.z, localQ.w]);
  node.rotateEnabled = true;
  node.moveEnabled   = true;
  obj.position.copy(nPos);
  obj.quaternion.copy(nQuat);
  obj.updateWorldMatrix(true, true);   // parents too — see the note in _measure
}

// ─── the bake ───────────────────────────────────────────────────────────────

/** Put ONE node where its descriptor says, for this frame. Returns false when it cannot. */
function _bakeOne(node, obj, fr) {
  const sp = node?.spotlight;
  if (!sp || !obj) return false;
  const { sc } = _measure(obj);
  const { origin, quat } = _targetPose(sp, fr, sc);
  _writeWorldPose(node, obj, origin, quat);
  return true;
}

/**
 * Bake every spotlighted node of a snapshot for its camera. Called by the step
 * manager at activation, AFTER the snapshot's transforms are on the objects and
 * BEFORE the world poses are read (the animated path tweens towards them).
 * No side effects beyond the nodes and their objects.
 */
export function bakeSpotlights(snapshot, nodeById, object3dById) {
  const tr = snapshot?.transforms;
  if (!tr || !nodeById) return 0;
  let fr = null, n = 0;
  for (const id of Object.keys(tr)) {
    if (!tr[id]?.spotlight) continue;
    const node = nodeById.get(id), obj = object3dById?.get(id);
    if (!node || !obj) continue;
    fr = fr || _frameOf(snapshot.camera || null);
    if (_bakeOne(node, obj, fr)) n++;
  }
  return n;
}

// ─── authoring ──────────────────────────────────────────────────────────────

const _liveObj = (id) => steps.object3dById?.get(id) || null;
const _liveNode = (id) => state.get('nodeById')?.get(id) || null;

/** The nodes spotlighted on the ACTIVE step (live tree). */
export function spotlightedNodes() {
  const out = [];
  for (const [id, node] of state.get('nodeById') || []) if (node?.spotlight && isTransformNode(node) && _liveObj(id)) out.push(node);
  return out;
}

/**
 * Re-derive the live pose of every spotlighted node from the LIVE camera — after an
 * orbit or a lens change. A PREVIEW: the step's camera is locked at creation and only
 * "Update camera" changes it, so orbiting is not an edit and this writes nothing into
 * the step (the activation bake, from the step's own camera, is what counts). When the
 * step camera IS updated, the step manager calls this and then syncs the transforms.
 */
export function followCamera() {
  const nodes = spotlightedNodes();
  if (!nodes.length) return 0;
  const fr = _frameOf(null);
  let n = 0;
  for (const node of nodes) if (_bakeOne(node, _liveObj(node.id), fr)) n++;
  if (n) sceneCore.requestRender?.(0);
  return n;
}

/** Is the view on screen the step's camera? (Authoring against an unsaved view is allowed everywhere in the app — but it is worth a word.) */
function _viewIsStepCamera() {
  const T = _T();
  const step = (state.get('steps') || []).find(s => s.id === state.get('activeStepId'));
  const sc = step?.snapshot?.camera;
  if (!sc) return true;
  const live = sceneCore.getCameraState();
  const dp = new T.Vector3(...(live.position || [0, 0, 0])).distanceTo(new T.Vector3(...(sc.position || [0, 0, 0])));
  const dq = Math.abs(new T.Quaternion(...(live.quaternion || [0, 0, 0, 1])).dot(new T.Quaternion(...(sc.quaternion || [0, 0, 0, 1]))));
  return dp < 1e-3 && dq > 0.99999 && Math.abs((Number(live.fov) || 0) - (Number(sc.fov) || 0)) < 1e-3;
}
const CAM_HINT = ' The view on screen is not this step’s saved camera — 📷 Update camera, or the step will show it from its own camera.';

/** After the user moved / turned a spotlighted node with the gizmo: the picture-place is whatever it is now. */
export function recaptureFromPose(node) {
  const obj = _liveObj(node?.id);
  if (!node?.spotlight || !obj) return false;
  const d = _describe(obj, node.spotlight, _frameOf(null));
  node.spotlight = { ...node.spotlight, ...d, custom: true };
  if (!_viewIsStepCamera()) setStatus('🔦 Placed in the picture.' + CAM_HINT, 'warn', 7000);
  return true;
}

/** The dolly handle: the same picture-place, a different size — s' = s0 / factor (drag up = farther = smaller). Live, no undo. */
export function applyDollyLive(node, s0, factor) {
  const obj = _liveObj(node?.id);
  if (!node?.spotlight || !obj) return false;
  node.spotlight = { ...node.spotlight, s: Math.max(MIN_S, Math.min(MAX_S, s0 / Math.max(1e-6, factor))), custom: true };
  return _bakeOne(node, obj, _frameOf(null));
}

// ─── the undoable edits ─────────────────────────────────────────────────────

function _restore(nodeId, snap) {
  const n = _liveNode(nodeId), o = _liveObj(nodeId);
  if (!n) return;
  applyTransformSnapshot(n, snap);
  if (o) applyNodeTransformToObject3D(n, o);
  steps.scheduleTransformSync?.();
  state.markDirty?.();
}
function _commit(label, nodeId, before) {
  const after = captureTransformSnapshot(_liveNode(nodeId));
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  undoManager.push(label, () => _restore(nodeId, before), () => _restore(nodeId, after));
  steps.scheduleTransformSync?.();
  state.markDirty?.();
  return true;
}

/** Why a node cannot be spotlighted, in plain words — or null. */
export function spotlightRefusal(node) {
  if (!node) return 'Nothing selected.';
  if (!isTransformNode(node)) return node.type === 'mesh'
    ? 'A raw part has no transform of its own — put it in a folder (or "Make transformable") and spotlight that.'
    : 'Only folders, parts with a transform, hardware, primitives and shapes can be spotlighted.';
  if (node.archived) return 'An archived object is read-only.';
  // A FOLLOWING object is fine: on this step its pose is the picture's, on every other step
  // it rides its target as before. follow.js keeps each step's own descriptor when it re-bakes.
  if (!_liveObj(node.id)) return 'This object is not in the scene right now.';
  return null;
}

/** Switch the spotlight ON for this node on the ACTIVE step (one undo entry). */
export function setSpotlight(nodeId, on) {
  const node = _liveNode(nodeId), obj = _liveObj(nodeId);
  if (!node) return false;
  if (on) {
    const why = spotlightRefusal(node);
    if (why) { setStatus(why, 'warn', 5000); return false; }
    if (node.spotlight) return true;
  } else if (!node.spotlight) return true;
  const before = captureTransformSnapshot(node);
  if (on) {
    const fr = _frameOf(null);
    const { cl, r } = _measure(obj);
    const T = _T();
    const wq = new T.Quaternion(); obj.getWorldQuaternion(wq);
    const q0 = _arr(fr.q.clone().invert().multiply(wq).normalize());       // the face it shows now, kept
    // the pose underneath, kept: the layer is absolute, the step's own place is not lost
    const home = { localOffset: [...node.localOffset], localQuaternion: [...node.localQuaternion], orientationSteps: [...node.orientationSteps], moveEnabled: node.moveEnabled !== false, rotateEnabled: node.rotateEnabled !== false };
    node.spotlight = { ..._defaults(), q: q0, q0, cl, r, custom: false, home };
    _bakeOne(node, obj, fr);
  } else {
    // off = the layer is lifted: the object is back where this step had it before the spotlight
    const h = node.spotlight.home;
    node.spotlight = null;
    if (h) {
      node.localOffset      = [...h.localOffset];
      node.localQuaternion  = [...h.localQuaternion];
      node.orientationSteps = [...(h.orientationSteps || [0, 0, 0])];
      node.moveEnabled      = h.moveEnabled !== false;
      node.rotateEnabled    = h.rotateEnabled !== false;
      if (obj) applyNodeTransformToObject3D(node, obj);
    }
  }
  const changed = _commit(on ? 'Spotlight at this step' : 'Stop the spotlight', nodeId, before);
  setStatus(on
    ? '🔦 Spotlighted on this step: it sits in the picture, not in the world. Orbit and it follows; move it and its place is kept; the white block on the gizmo brings it nearer or farther. Right-click ▸ reset puts it back on the default.' + (_viewIsStepCamera() ? '' : CAM_HINT)
    : 'Spotlight off — back where this step had it.', 'info', on ? 10000 : 4000);
  return changed;
}

/** Back on the global defaults (place, size, and the orientation it had when the flag went on). */
export function resetSpotlight(nodeId) {
  const node = _liveNode(nodeId), obj = _liveObj(nodeId);
  if (!node?.spotlight || !obj) return false;
  const before = captureTransformSnapshot(node);
  const { cl, r } = _measure(obj);
  node.spotlight = { ...node.spotlight, ..._defaults(), q: [...node.spotlight.q0], cl, r, custom: false };
  _bakeOne(node, obj, _frameOf(null));
  return _commit('Reset the spotlight', nodeId, before);
}

/** This object's place becomes the project's default for every spotlight switched on from now (one undo entry). */
export function setSpotlightDefaultFrom(nodeId) {
  const node = _liveNode(nodeId);
  if (!node?.spotlight) return false;
  const before = state.get('spotlightDefaults') ?? null;
  const after = { u: node.spotlight.u, v: node.spotlight.v, s: node.spotlight.s };
  const write = (d) => { state.setState({ spotlightDefaults: d }); state.markDirty?.(); };
  write(after);
  undoManager.push('Default spotlight place', () => write(before), () => write(after));
  setStatus('🔦 This place is the default now — every spotlight switched on in this project starts here. Objects already spotlighted are not moved; Reset puts one on the new default.', 'success', 7000);
  return true;
}

/** Re-read the place from wherever the object is now (after a numeric-panel edit or any move the gizmo did not see). One undo entry. */
export function recaptureSpotlight(nodeId) {
  const node = _liveNode(nodeId);
  if (!node?.spotlight) return false;
  const before = captureTransformSnapshot(node);
  if (!recaptureFromPose(node)) return false;
  return _commit('Spotlight place', nodeId, before);
}

/** The dolly drag's one undo entry (the gizmo took `before` at pointerdown). */
export function commitDollyDrag(nodeId, before) {
  return _commit('Spotlight distance', nodeId, before);
}

// ─── wiring ─────────────────────────────────────────────────────────────────

let _inited = false, _pending = 0;
export function initSpotlight() {
  if (_inited) return;
  _inited = true;
  // The camera moved under the user's hand: the spotlighted objects follow. Coalesced to a
  // frame — an orbit fires this many times per second. NOT during a step transition (the
  // transition does not emit it) and not while a gizmo drag is in progress on the object
  // (the drag does not move the camera).
  const kick = () => { if (_pending) return; _pending = requestAnimationFrame(() => { _pending = 0; try { followCamera(); } catch (e) { console.warn('[spotlight] follow failed:', e?.message || e); } }); };
  sceneCore.on('controls:change', kick);
  sceneCore.on('camera:perspective', kick);
  if (typeof window !== 'undefined') window.sbsSpotlight = { nodes: spotlightedNodes, follow: followCamera, set: setSpotlight, reset: resetSpotlight, setDefault: setSpotlightDefaultFrom, recapture: recaptureSpotlight };
}
