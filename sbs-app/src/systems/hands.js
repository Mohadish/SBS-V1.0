/**
 * SBS — Hands (V0.3.4.127, phase 1: the rough one).
 * ────────────────────────────────────────────────
 * A hand is a tree node (type 'hand', a transform node like a primitive) whose
 * Three.js object is a procedural RIG: a wrist group, a palm, five fingers of
 * three capsule bones on hinge joints, a forearm bone. It is a bone system on
 * purpose — the user's plan: export these bones later, get a real hand model
 * back and skin it over them.
 *
 * Per step the node carries `handParams` (in the tree spec, like a primitive's
 * params — so every step snapshot is self-contained):
 *   targets  — per finger: null, or where its tip is pinned: on a mesh
 *              ({ nodeId, anchorLocal, normalLocal, cachedWorldPos } — the cable
 *              socket recipe, so the tip rides the part it touches) or free
 *              ({ pos: [x,y,z] }, world)
 *   palm     — null = fitted from the pinned tips, or { pos, quat } (world),
 *              set when the user moves the palm himself
 *   forearm  — null = straight back from the wrist, or [x,y,z] (world): the
 *              elbow-side control; dragging it turns the wrist toward it
 *   released — true = the hand is a unit: fingers relax, the node's own
 *              transform places it (gizmo, Global Mode, paste — like any object)
 *   open     — 0..1 how far the fingers open when released
 *   scale    — hand length in scene units (mm), wrist to middle fingertip ≈ 190
 *
 * The solve: while pinned, the wrist pose comes from the palm fit (or the
 * user's palm) turned toward the forearm point, written into the node's
 * per-step transform (localOffset / localQuaternion under its parent) so the
 * step, undo, the tree and the gizmo all see one truth; then every pinned
 * finger bends toward its tip by CCD on hinge joints (flexion with limits,
 * a little spread at the knuckle); unpinned fingers rest. A frame loop
 * re-solves a hand only when its inputs moved (pinned parts animate).
 */

import { state }                        from '../core/state.js';
import { sceneCore }                    from '../core/scene.js';
import { resolveNodeWorldPosition }     from './cables.js';
import { applyNodeTransformToObject3D } from '../core/transforms.js';

const T = () => window.THREE;
const DEG = Math.PI / 180;

export const HAND_FINGERS  = ['thumb', 'index', 'middle', 'ring', 'pinky'];
export const HAND_CONTROLS = [...HAND_FINGERS, 'palm', 'forearm'];
export const FINGER_LABEL  = { thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Pinky', palm: 'Palm', forearm: 'Forearm' };

export function defaultHandParams() {
  return { scale: 190, targets: { thumb: null, index: null, middle: null, ring: null, pinky: null }, palm: null, forearm: null, released: false, open: 0 };
}

// ── anatomy of a unit hand (length 1), RIGHT hand, palm frame: +Y toward the
//    fingers, +X toward the thumb, +Z the back of the hand ─────────────────────
const ANAT = {
  palm:    { w: 0.44, h: 0.50, t: 0.13, y: 0.30 },
  fingers: {
    index:  { mcp: [ 0.165, 0.55,  0.00], dir: [ 0.06, 1, 0], curl: [0, 0, -1], len: [0.22, 0.13, 0.10], r: 0.042, flexMax: [95, 105, 80], spread: 20 },
    middle: { mcp: [ 0.055, 0.57,  0.00], dir: [ 0.00, 1, 0], curl: [0, 0, -1], len: [0.24, 0.15, 0.11], r: 0.044, flexMax: [95, 105, 80], spread: 15 },
    ring:   { mcp: [-0.055, 0.56,  0.00], dir: [-0.05, 1, 0], curl: [0, 0, -1], len: [0.22, 0.14, 0.10], r: 0.041, flexMax: [95, 105, 80], spread: 15 },
    pinky:  { mcp: [-0.165, 0.53,  0.00], dir: [-0.12, 1, 0], curl: [0, 0, -1], len: [0.17, 0.10, 0.08], r: 0.036, flexMax: [95, 105, 80], spread: 25 },
    thumb:  { mcp: [ 0.20,  0.14, -0.03], dir: [ 0.72, 0.58, -0.38], curl: [-0.55, 0.35, -0.75], len: [0.26, 0.17, 0.13], r: 0.050, flexMax: [45, 60, 80], spread: 30 },
  },
  rest:  { finger: [14, 12, 8],  thumb: [10, 12, 8] },   // idle / released, degrees
  grip:  { finger: [45, 45, 30], thumb: [30, 30, 20] },  // the pose the palm is fitted with
  open:  { finger: [-6, 0, 0],   thumb: [0, 0, 0] },     // fully open
  forearm: { len: 1.35, r: 0.075 },
  skin: '#e6b596',
};

const _v = (a) => new (T().Vector3)(a[0], a[1], a[2]);
const _mirror = (a, left) => left ? [-a[0], a[1], a[2]] : [...a];

// ── the rig ──────────────────────────────────────────────────────────────────

function _roundedBox(w, h, t, r) {
  const Th = T();
  const s = new Th.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  const g = new Th.ExtrudeGeometry(s, { depth: t * 0.6, bevelEnabled: true, bevelThickness: t * 0.2, bevelSize: t * 0.2, bevelSegments: 3, curveSegments: 6 });
  g.translate(0, 0, -t * 0.5);
  g.computeVertexNormals();
  return g;
}

function _capsule(r, len) {
  const Th = T();
  const g = new Th.CapsuleGeometry(r, Math.max(0.001, len - 2 * r), 3, 12);
  g.translate(0, len / 2, 0);   // from the joint (y=0) out along +Y
  return g;
}

/** Quaternion whose local X = flex axis, Y = bone direction, Z = spread axis. */
function _basis(dir, curl) {
  const Th = T();
  const y = _v(dir).normalize();
  const x = new Th.Vector3().crossVectors(y, _v(curl)).normalize();   // flex about +X bends Y toward the curl
  const z = new Th.Vector3().crossVectors(x, y).normalize();
  const m = new Th.Matrix4().makeBasis(x, y, z);
  return new Th.Quaternion().setFromRotationMatrix(m);
}

/** Build the rig for a node; cached on the node's group by side + scale. */
export function ensureHandObject3D(node) {
  const Th = T();
  if (!Th || !node || node.type !== 'hand') return null;
  const p = node.handParams || (node.handParams = defaultHandParams());
  const L = Number(p.scale) || 190;
  const left = node.handSide === 'left';
  const key = `${left ? 'L' : 'R'}:${L}`;
  const existing = node.object3d;
  if (existing && existing.userData?.handBuildKey === key) return existing;

  // keep contained objects (a hand can hold things, like a primitive can) and the colour
  let kept = [], prevColor = null;
  if (existing) {
    kept = existing.children.filter(c => (c.userData?.nodeId && c.userData.nodeId !== node.id) || c.userData?.isCustomFolder);
    for (const c of kept) existing.remove(c);
    prevColor = existing.userData?.handColor || null;
    if (existing.parent) existing.parent.remove(existing);
    existing.traverse(o => { o.geometry?.dispose?.(); if (o.material && o !== existing) o.material.dispose?.(); });
    node.object3d = null;
  }

  const mat = new Th.MeshStandardMaterial({ color: prevColor || ANAT.skin, roughness: 0.6, metalness: 0.02 });
  const handleMat = new Th.MeshBasicMaterial({ color: '#22d3ee', depthTest: false, transparent: true, opacity: 0.9 });
  const tag = (o) => { o.userData.nodeId = node.id; o.userData.meshNodeId = node.id; o.userData.handNodeId = node.id; return o; };

  const group = new Th.Group();
  group.name = node.name || (left ? 'Left hand' : 'Right hand');
  tag(group);
  group.userData.handBuildKey = key;
  group.userData.handColor = prevColor || ANAT.skin;
  group.userData.isHand = true;

  // palm
  const palm = tag(new Th.Mesh(_roundedBox(ANAT.palm.w * L, ANAT.palm.h * L, ANAT.palm.t * L, 0.08 * L), mat));
  palm.position.set(0, ANAT.palm.y * L, 0);
  palm.name = 'palm';
  group.add(palm);

  // forearm — a bone from the wrist back toward the elbow; re-aimed by the solve
  const forearm = tag(new Th.Mesh(_capsule(ANAT.forearm.r * L, ANAT.forearm.len * L), mat));
  forearm.name = 'forearm';
  forearm.quaternion.setFromAxisAngle(new Th.Vector3(0, 0, 1), Math.PI);   // along -Y
  group.add(forearm);

  // fingers: J1 (knuckle) → bone → J2 → bone → J3 → bone → tip
  const fingers = {};
  for (const f of HAND_FINGERS) {
    const a = ANAT.fingers[f];
    const j1 = new Th.Object3D(); j1.name = `${f}-1`;
    j1.position.copy(_v(_mirror(a.mcp, left)).multiplyScalar(L));
    const basis = _basis(_mirror(a.dir, left), _mirror(a.curl, left));
    const bones = [], joints = [j1];
    let cur = j1;
    for (let i = 0; i < 3; i++) {
      const len = a.len[i] * L, r = a.r * L * (1 - 0.12 * i);
      const bone = tag(new Th.Mesh(_capsule(r, len), mat)); bone.name = `${f}-bone${i + 1}`;
      cur.add(bone); bones.push(bone);
      if (i < 2) { const jn = new Th.Object3D(); jn.name = `${f}-${i + 2}`; jn.position.set(0, len, 0); cur.add(jn); joints.push(jn); cur = jn; }
    }
    const tip = new Th.Object3D(); tip.name = `${f}-tip`; tip.position.set(0, a.len[2] * L, 0); cur.add(tip);
    // the tip handle (shown while the hand is selected)
    const handle = new Th.Mesh(new Th.SphereGeometry(0.03 * L, 12, 12), handleMat);
    handle.userData.handControl = { nodeId: node.id, key: f }; handle.renderOrder = 999; handle.visible = false; handle.name = `${f}-handle`;
    tip.add(handle);
    group.add(j1);
    fingers[f] = { joints, bones, tip, handle, basis, alpha: 0, phi: [0, 0, 0], flexMax: a.flexMax.map(d => d * DEG), spread: a.spread * DEG, len: a.len.map(x => x * L) };
  }
  // palm + forearm handles
  const palmHandle = new Th.Mesh(new Th.SphereGeometry(0.045 * L, 12, 12), handleMat.clone());
  palmHandle.material.color.set('#f472b6'); palmHandle.userData.handControl = { nodeId: node.id, key: 'palm' }; palmHandle.renderOrder = 999; palmHandle.visible = false;
  group.add(palmHandle);
  const foreHandle = new Th.Mesh(new Th.SphereGeometry(0.045 * L, 12, 12), handleMat.clone());
  foreHandle.material.color.set('#fbbf24'); foreHandle.userData.handControl = { nodeId: node.id, key: 'forearm' }; foreHandle.renderOrder = 999; foreHandle.visible = false;
  foreHandle.position.set(0, -ANAT.forearm.len * L, 0);
  group.add(foreHandle);

  for (const c of kept) group.add(c);
  group.userData.rig = { L, left, fingers, palm, forearm, palmHandle, foreHandle, mat };
  node.object3d = group;
  _setRestPose(group.userData.rig, ANAT.rest);
  _sigCache.delete(node.id);
  return group;
}

function _setFingerAngles(fg) {
  const Th = T();
  const rx = (a) => new Th.Quaternion().setFromAxisAngle(new Th.Vector3(1, 0, 0), a);
  const rz = (a) => new Th.Quaternion().setFromAxisAngle(new Th.Vector3(0, 0, 1), a);
  fg.joints[0].quaternion.copy(fg.basis).multiply(rz(fg.alpha)).multiply(rx(fg.phi[0]));
  fg.joints[1].quaternion.copy(rx(fg.phi[1]));
  fg.joints[2].quaternion.copy(rx(fg.phi[2]));
}
function _setRestPose(rig, pose, blend = 1) {
  for (const f of HAND_FINGERS) {
    const fg = rig.fingers[f];
    const src = f === 'thumb' ? pose.thumb : pose.finger;
    fg.alpha = 0;
    for (let i = 0; i < 3; i++) fg.phi[i] = src[i] * DEG * blend;
    _setFingerAngles(fg);
  }
}

// ── targets ──────────────────────────────────────────────────────────────────

/** World position of a finger's target (null when unpinned / unresolved). */
export function targetWorld(node, finger) {
  const t = node?.handParams?.targets?.[finger];
  if (!t) return null;
  const Th = T();
  if (Array.isArray(t.pos)) return _v(t.pos);
  if (t.nodeId && Array.isArray(t.anchorLocal)) {
    const r = resolveNodeWorldPosition({ anchorType: 'mesh', nodeId: t.nodeId, anchorLocal: t.anchorLocal, cachedWorldPos: t.cachedWorldPos }, { makeVec3: (x, y, z) => new Th.Vector3(x, y, z) });
    if (r.pos) { t.cachedWorldPos = r.pos.slice(); return _v(r.pos); }
  }
  return Array.isArray(t.cachedWorldPos) ? _v(t.cachedWorldPos) : null;
}
/** World normal at a pinned tip (null when unknown). */
function _targetNormal(t) {
  if (!t?.nodeId || !Array.isArray(t.normalLocal)) return null;
  const obj = state.get('nodeById')?.get(t.nodeId)?.object3d;
  if (!obj) return null;
  const q = new (T().Quaternion)(); obj.getWorldQuaternion(q);
  return _v(t.normalLocal).applyQuaternion(q).normalize();
}

// ── the solve ────────────────────────────────────────────────────────────────

function _signedAngle(axis, u, v) {
  const Th = T();
  const a = axis.clone().normalize();
  const pu = u.clone().sub(a.clone().multiplyScalar(u.dot(a)));
  const pv = v.clone().sub(a.clone().multiplyScalar(v.dot(a)));
  if (pu.lengthSq() < 1e-10 || pv.lengthSq() < 1e-10) return 0;
  return Math.atan2(new Th.Vector3().crossVectors(pu, pv).dot(a), pu.dot(pv));
}
const _clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** CCD: bend one finger toward a world target. Returns the remaining distance. */
function _solveFinger(fg, targetW) {
  const Th = T();
  const tip = new Th.Vector3(), jp = new Th.Vector3(), ax = new Th.Vector3();
  const worldAxis = (j, local) => ax.copy(local).applyQuaternion(j.getWorldQuaternion(new Th.Quaternion())).normalize();
  const X = new Th.Vector3(1, 0, 0), Z = new Th.Vector3(0, 0, 1);
  for (let it = 0; it < 14; it++) {
    for (let ji = 2; ji >= 0; ji--) {
      const j = fg.joints[ji];
      fg.joints[0].updateMatrixWorld(true);
      fg.tip.getWorldPosition(tip); j.getWorldPosition(jp);
      if (tip.distanceTo(targetW) < 0.3) return 0;
      const u = tip.clone().sub(jp), v = targetW.clone().sub(jp);
      if (ji === 0) {   // knuckle: a little spread first
        const d = _signedAngle(worldAxis(j, Z), u, v);
        fg.alpha = _clamp(fg.alpha + d, -fg.spread, fg.spread);
        _setFingerAngles(fg); fg.joints[0].updateMatrixWorld(true);
        fg.tip.getWorldPosition(tip); u.copy(tip).sub(jp);
      }
      const d = _signedAngle(worldAxis(j, X), u, v);
      fg.phi[ji] = _clamp(fg.phi[ji] + d, 0, fg.flexMax[ji]);
      _setFingerAngles(fg);
    }
  }
  fg.joints[0].updateMatrixWorld(true);
  fg.tip.getWorldPosition(tip);
  return tip.distanceTo(targetW);
}

/** Reference tip positions (palm frame) for a pose — used to fit the palm. */
function _referenceTips(rig, pose, fingers) {
  const Th = T();
  const saved = {};
  for (const f of fingers) { const fg = rig.fingers[f]; saved[f] = { alpha: fg.alpha, phi: [...fg.phi] }; }
  _setRestPose(rig, pose);
  const out = {};
  const g = new Th.Group(); // measure in the group's own frame: bake the joints' local matrices
  for (const f of fingers) {
    const fg = rig.fingers[f];
    fg.joints[0].updateMatrixWorld(true);
    // local (group-frame) position: chain of local matrices
    const m = new Th.Matrix4();
    let o = fg.tip;
    const chain = [];
    while (o && o !== rig.palm.parent) { chain.unshift(o); o = o.parent; }
    for (const c of chain) { c.updateMatrix(); m.multiply(c.matrix); }
    out[f] = new Th.Vector3().setFromMatrixPosition(m);
  }
  for (const f of fingers) { const fg = rig.fingers[f]; fg.alpha = saved[f].alpha; fg.phi = saved[f].phi; _setFingerAngles(fg); }
  void g;
  return out;
}

/** The wrist pose (world) fitted from the pinned tips; null when nothing is pinned. */
function _fitPalm(node, rig, tips, prevQuat) {
  const Th = T();
  const engaged = HAND_FINGERS.filter(f => tips[f]);
  if (!engaged.length) return null;
  const refs = _referenceTips(rig, ANAT.grip, engaged);
  // orientation
  const ns = engaged.map(f => _targetNormal(node.handParams.targets[f])).filter(Boolean);
  let z = ns.length ? ns.reduce((a, n) => a.add(n), new Th.Vector3()).multiplyScalar(1 / ns.length) : new Th.Vector3();
  if (z.length() < 0.3) z = new Th.Vector3(0, 0, 1).applyQuaternion(prevQuat);
  z.normalize();
  let x;
  const order = ['thumb', 'index', 'middle', 'ring', 'pinky'].filter(f => tips[f]);
  if (order.length >= 2) x = tips[order[0]].clone().sub(tips[order[order.length - 1]]);
  else x = new Th.Vector3(1, 0, 0).applyQuaternion(prevQuat);
  if (rig.left) x.negate();
  x.sub(z.clone().multiplyScalar(x.dot(z)));
  if (x.length() < 1e-6) x = new Th.Vector3(1, 0, 0).applyQuaternion(prevQuat).sub(z.clone().multiplyScalar(z.dot(new Th.Vector3(1, 0, 0).applyQuaternion(prevQuat))));
  x.normalize();
  const y = new Th.Vector3().crossVectors(z, x).normalize();
  x.crossVectors(y, z).normalize();
  const quat = new Th.Quaternion().setFromRotationMatrix(new Th.Matrix4().makeBasis(x, y, z));
  // position: the reference tips' mean lands on the targets' mean
  const tMean = engaged.reduce((a, f) => a.add(tips[f]), new Th.Vector3()).multiplyScalar(1 / engaged.length);
  const rMean = engaged.reduce((a, f) => a.add(refs[f]), new Th.Vector3()).multiplyScalar(1 / engaged.length).applyQuaternion(quat);
  return { pos: tMean.sub(rMean), quat };
}

/** Write a world pose into the node's per-step transform and onto its group. */
function _setWristWorld(node, group, pos, quat) {
  const Th = T();
  const parent = group.parent;
  const world = new Th.Matrix4().compose(pos, quat, new Th.Vector3(1, 1, 1));
  const local = parent ? new Th.Matrix4().copy(parent.matrixWorld).invert().multiply(world) : world;
  const p = new Th.Vector3(), q = new Th.Quaternion(), s = new Th.Vector3();
  local.decompose(p, q, s);
  const bp = node.baseLocalPosition || [0, 0, 0], bq = node.baseLocalQuaternion || [0, 0, 0, 1];
  const dq = new Th.Quaternion(bq[0], bq[1], bq[2], bq[3]).invert().multiply(q);
  node.localOffset = [p.x - bp[0], p.y - bp[1], p.z - bp[2]];
  node.localQuaternion = [dq.x, dq.y, dq.z, dq.w];
  node.moveEnabled = true; node.rotateEnabled = true;
  applyNodeTransformToObject3D(node, group);
}

/**
 * Solve one hand: wrist pose + fingers, from its params. Safe to call often.
 * @returns {{ pinned:number, unreached:string[] }}
 */
export function solveHand(node) {
  const Th = T();
  const group = node?.object3d;
  const rig = group?.userData?.rig;
  if (!Th || !rig) return { pinned: 0, unreached: [] };
  const p = node.handParams || (node.handParams = defaultHandParams());
  group.parent?.updateMatrixWorld?.(true);

  const tips = {};
  for (const f of HAND_FINGERS) tips[f] = p.released ? null : targetWorld(node, f);
  const pinned = HAND_FINGERS.filter(f => tips[f]);
  const L = rig.L;

  if (!pinned.length || p.released) {
    // a unit: the node's own transform places it; fingers relax / open
    applyNodeTransformToObject3D(node, group);
    const open = _clamp(Number(p.open) || 0, 0, 1);
    const pose = { finger: ANAT.rest.finger.map((r, i) => r * (1 - open) + ANAT.open.finger[i] * open), thumb: ANAT.rest.thumb.map((r, i) => r * (1 - open) + ANAT.open.thumb[i] * open) };
    _setRestPose(rig, pose);
  } else {
    const prevQ = new Th.Quaternion(); group.getWorldQuaternion(prevQ);
    let wrist = null;
    if (p.palm?.pos && p.palm?.quat) wrist = { pos: _v(p.palm.pos), quat: new Th.Quaternion(...p.palm.quat) };
    else wrist = _fitPalm(node, rig, tips, prevQ);
    if (wrist) {
      // the forearm point turns the wrist so its back (-Y) aims at it
      if (Array.isArray(p.forearm)) {
        const back = new Th.Vector3(0, -1, 0).applyQuaternion(wrist.quat);
        const want = _v(p.forearm).sub(wrist.pos);
        if (want.length() > 1e-3) {
          const turn = new Th.Quaternion().setFromUnitVectors(back, want.normalize());
          wrist.quat = turn.multiply(wrist.quat);
        }
      }
      _setWristWorld(node, group, wrist.pos, wrist.quat);
    }
    group.updateMatrixWorld(true);
    // fingers: pinned ones reach, the others rest
    _setRestPose(rig, ANAT.rest);
    for (const f of pinned) {
      const fg = rig.fingers[f];
      fg.phi = (f === 'thumb' ? ANAT.grip.thumb : ANAT.grip.finger).map(d => d * DEG); fg.alpha = 0; _setFingerAngles(fg);
      _solveFinger(fg, tips[f]);
    }
  }
  // the forearm bone aims at the forearm point (or straight back)
  {
    const fa = rig.forearm, fh = rig.foreHandle;
    const localTarget = Array.isArray(p.forearm) ? group.worldToLocal(_v(p.forearm)) : new Th.Vector3(0, -ANAT.forearm.len * L, 0);
    const dir = localTarget.clone().normalize();
    fa.quaternion.setFromUnitVectors(new Th.Vector3(0, 1, 0), dir.lengthSq() ? dir : new Th.Vector3(0, -1, 0));
    const len = _clamp(localTarget.length(), 0.6 * L, 2.2 * L);
    fa.scale.set(1, len / (ANAT.forearm.len * L), 1);
    fh.position.copy(dir.multiplyScalar(len));
  }
  group.updateMatrixWorld(true);
  const unreached = pinned.filter(f => { const t = new Th.Vector3(); rig.fingers[f].tip.getWorldPosition(t); return t.distanceTo(tips[f]) > 0.03 * L; });
  return { pinned: pinned.length, unreached };
}

// ── controls (gizmo / handles) ───────────────────────────────────────────────

/** World position of a control: a finger's tip target (or its tip), the palm (wrist), the forearm point. */
export function controlWorld(node, key) {
  const Th = T();
  const group = node?.object3d; const rig = group?.userData?.rig;
  if (!rig) return null;
  if (key === 'palm') return group.getWorldPosition(new Th.Vector3());
  if (key === 'forearm') return rig.foreHandle.getWorldPosition(new Th.Vector3());
  const t = targetWorld(node, key);
  if (t) return t;
  return rig.fingers[key]?.tip.getWorldPosition(new Th.Vector3()) || null;
}

/** Handle meshes of every live hand (for picking). */
export function handleMeshes() {
  const out = [];
  for (const n of _liveHands()) {
    const rig = n.object3d?.userData?.rig; if (!rig) continue;
    for (const f of HAND_FINGERS) out.push(rig.fingers[f].handle);
    out.push(rig.palmHandle, rig.foreHandle);
  }
  return out;
}

function _liveHands() {
  const nb = state.get('nodeById'); const out = [];
  if (!nb) return out;
  for (const [, n] of nb) if (n?.type === 'hand' && n.object3d) out.push(n);
  return out;
}

// ── the frame loop: re-solve a hand when its inputs moved ────────────────────
const _sigCache = new Map();   // nodeId → last input signature
let _loop = false;

function _signature(node) {
  const p = node.handParams || {};
  const parts = [node.handSide, p.scale, p.released ? 1 : 0, p.open, JSON.stringify(p.palm), JSON.stringify(p.forearm)];
  for (const f of HAND_FINGERS) { const t = p.released ? null : targetWorld(node, f); parts.push(t ? `${t.x.toFixed(2)},${t.y.toFixed(2)},${t.z.toFixed(2)}` : '-'); }
  if (p.released || !HAND_FINGERS.some(f => p.targets?.[f])) {
    const g = node.object3d; if (g?.parent) { g.parent.updateMatrixWorld(true); const e = g.parent.matrixWorld.elements; parts.push(e[12].toFixed(1), e[13].toFixed(1), e[14].toFixed(1)); }
    parts.push(JSON.stringify(node.localOffset), JSON.stringify(node.localQuaternion));
  } else if (node.object3d?.parent) {
    const e = node.object3d.parent.matrixWorld.elements; parts.push(e[12].toFixed(1), e[13].toFixed(1), e[14].toFixed(1), e[0].toFixed(3), e[5].toFixed(3));
  }
  return parts.join('|');
}

/** Force a re-solve on the next frame. */
export function markHandDirty(nodeId) { _sigCache.delete(nodeId); }

export function tickHands() {
  const Th = T(); if (!Th) return false;
  const selId = state.get('selectedId');
  const selCtl = state.get('selectedHandControl');
  let changed = false;
  for (const n of _liveHands()) {
    const rig = n.object3d.userData.rig;
    const sig = _signature(n);
    if (_sigCache.get(n.id) !== sig) {
      solveHand(n);
      _sigCache.set(n.id, _signature(n));
      changed = true;
    }
    const show = selId === n.id || selCtl?.nodeId === n.id || state.get('handPicking')?.nodeId === n.id;
    if (rig.palmHandle.visible !== show) {
      for (const f of HAND_FINGERS) rig.fingers[f].handle.visible = show;
      rig.palmHandle.visible = show; rig.foreHandle.visible = show;
      changed = true;
    }
    if (show) {
      // finger handles sit on the TARGET when pinned (the tip may fall short), else on the tip
      for (const f of HAND_FINGERS) {
        const h = rig.fingers[f].handle, t = targetWorld(n, f);
        if (t && !n.handParams?.released) { const lp = h.parent.worldToLocal(t.clone()); h.position.copy(lp); }
        else h.position.set(0, 0, 0);
        const pinned = !!t && !n.handParams?.released;
        h.material.color.set(pinned ? '#22d3ee' : '#94a3b8');
      }
    }
  }
  return changed;
}

export function initHands() {
  if (_loop) return;
  _loop = true;
  const step = () => {
    try { if (tickHands()) sceneCore.requestRender?.(120); } catch (e) { console.warn('[hands] tick failed:', e?.message); }
  };
  if (typeof sceneCore.addTickHook === 'function') sceneCore.addTickHook(step);
  else { const raf = () => { step(); requestAnimationFrame(raf); }; requestAnimationFrame(raf); }
}
