/**
 * SBS — Hands (V0.3.4.128, phase 2: poses + a ghost prop).
 * ─────────────────────────────────────────────────────────
 * A hand is a tree node (type 'hand', a transform node like a primitive) whose
 * Three.js object is a procedural RIG: a wrist group, a palm, five fingers of
 * three capsule bones on hinge joints, a forearm bone. A bone system on purpose
 * — the user's plan: export these bones later and skin a real hand over them.
 *
 * Phase 1 (.127) posed the hand from five pinned fingertips + IK; the user, an
 * animator: "very hard to use… we need a different approach". So (.128):
 *   • the hand has a POSE — a grip from a small library (handle, pistol grip,
 *     pinch, flat push, knob, relaxed) — and a `closed` slider blending the
 *     relaxed hand into that grip;
 *   • every grip comes with a GHOST PROP: the thing it holds (a handle, a
 *     grip with its trigger, a pinched part…) drawn translucent in the hand,
 *     with THREE NAMED POINTS on it. The user aligns those three points to
 *     the real part (ui/hand-tab.js → the snap picker's 3-point mapping) and
 *     the hand lands exactly; the ghost then hides. Deterministic, three
 *     clicks;
 *   • the wrist pose is ALWAYS the node's own transform (gizmo, Global Mode,
 *     Paste Transforms, Follow — a hand is one object);
 *   • fine-tune (double-click the hand): the fingertip / forearm handles come
 *     up; dragging a fingertip pins it (mesh + local point, the cable-socket
 *     recipe) and that finger bends to it by CCD over the pose. Optional.
 *
 * Per step the node carries `handParams` in the tree spec (self-contained
 * steps): { scale, pose, closed, ghost, targets{finger: null | {nodeId,
 * anchorLocal, normalLocal, cachedWorldPos} | {pos}}, forearm, released, open }.
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
  return { scale: 190, pose: 'handle', closed: 1, ghost: true, targets: { thumb: null, index: null, middle: null, ring: null, pinky: null }, forearm: null, released: false, open: 0 };
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
  forearm: { len: 1.35, r: 0.075 },
  skin: '#e6b596',
  ghost: '#7dd3fc',
};

// ── the poses: joint angles at closed = 1 (degrees: [knuckle, middle, tip], a = spread),
//    the ghost prop that grip holds, and the three points on it the user maps ──
const REST = { index: [14, 12, 8], middle: [14, 12, 8], ring: [14, 12, 8], pinky: [14, 12, 8], thumb: [10, 12, 8] };
const OPEN = { index: [-6, 0, 0, 6], middle: [-6, 0, 0, 0], ring: [-6, 0, 0, -6], pinky: [-6, 0, 0, -14], thumb: [0, 0, 0, 14] };

export const HAND_POSES = {
  handle: {
    label: 'Handle / bar', icon: '🪛', hint: 'A power grip around a bar or a handle.',
    angles: { index: [70, 90, 55], middle: [72, 95, 58], ring: [74, 95, 60], pinky: [78, 95, 60], thumb: [30, 40, 35] },
    ghost: { kind: 'cylinder', r: 0.09, len: 0.90, axis: 'x', at: [0, 0.42, -0.18] },
    points: [
      { at: [ 0.45, 0.42, -0.18], label: 'one end of the handle' },
      { at: [-0.45, 0.42, -0.18], label: 'the other end of the handle' },
      { at: [ 0.00, 0.51, -0.18], label: 'a point on the handle where the fingers wrap over it' },
    ],
  },
  pistol: {
    label: 'Pistol grip + trigger', icon: '🔫', hint: 'The hand around a grip, the index finger on a trigger.',
    angles: { index: [22, 18, 10], middle: [70, 95, 60], ring: [72, 95, 60], pinky: [76, 95, 62], thumb: [28, 35, 30] },
    ghost: { kind: 'pistol' },
    points: [
      { at: [0.00, 0.63, -0.16], label: 'the top of the grip, under the trigger guard' },
      { at: [0.00, 0.17, -0.16], label: 'the bottom of the grip' },
      { at: [0.22, 0.74, -0.12], label: 'the trigger' },
    ],
  },
  pinch: {
    label: 'Pinch', icon: '🤏', hint: 'A small part between the thumb and the index finger.',
    angles: { index: [42, 55, 32], middle: [58, 72, 42], ring: [62, 80, 46], pinky: [66, 86, 50], thumb: [22, 32, 40] },
    ghost: { kind: 'box', size: [0.12, 0.08, 0.05], at: [0.30, 0.86, -0.20] },
    points: [
      { at: [0.30, 0.86, -0.175], label: 'the face the index finger presses' },
      { at: [0.30, 0.86, -0.225], label: 'the face the thumb presses' },
      { at: [0.36, 0.86, -0.200], label: 'a point on the part\'s side (its direction)' },
    ],
  },
  push: {
    label: 'Flat push', icon: '✋', hint: 'The open palm pressed on a surface or a big button.',
    angles: { index: [-4, 0, 0, 8], middle: [-4, 0, 0, 0], ring: [-4, 0, 0, -8], pinky: [-4, 0, 0, -16], thumb: [0, 6, 0, 20] },
    ghost: { kind: 'box', size: [0.60, 0.70, 0.02], at: [0, 0.45, -0.08] },
    points: [
      { at: [0.00, 0.45, -0.09], label: 'the surface under the middle of the palm' },
      { at: [0.00, 0.80, -0.09], label: 'the surface toward the fingertips' },
      { at: [0.28, 0.45, -0.09], label: 'the surface toward the thumb' },
    ],
  },
  knob: {
    label: 'Knob / dial', icon: '🎛', hint: 'Fingertips around a knob, seen end-on.',
    angles: { index: [34, 52, 34], middle: [36, 55, 36], ring: [38, 58, 38], pinky: [42, 60, 40], thumb: [22, 30, 26] },
    ghost: { kind: 'cylinder', r: 0.24, len: 0.22, axis: 'z', at: [0, 0.74, -0.20] },
    points: [
      { at: [ 0.24,  0.740, -0.09], label: 'a point on the knob\'s rim' },
      { at: [-0.12,  0.948, -0.09], label: 'a second point on the rim' },
      { at: [-0.12,  0.532, -0.09], label: 'a third point on the rim' },
    ],
  },
  relaxed: {
    label: 'Relaxed', icon: '🖐', hint: 'No grip — the hand rests. Place it with the gizmo.',
    angles: REST, ghost: null, points: [],
  },
};
export const HAND_POSE_KEYS = Object.keys(HAND_POSES);

const _v = (a) => new (T().Vector3)(a[0], a[1], a[2]);
const _mirror = (a, left) => left ? [-a[0], a[1], a[2]] : [...a];
const _clamp = (x, a, b) => Math.max(a, Math.min(b, x));

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
  g.translate(0, len / 2, 0);
  return g;
}
/** Quaternion whose local X = flex axis, Y = bone direction, Z = spread axis. */
function _basis(dir, curl) {
  const Th = T();
  const y = _v(dir).normalize();
  const x = new Th.Vector3().crossVectors(y, _v(curl)).normalize();   // flex about +X bends Y toward the curl
  const z = new Th.Vector3().crossVectors(x, y).normalize();
  return new Th.Quaternion().setFromRotationMatrix(new Th.Matrix4().makeBasis(x, y, z));
}

/** The ghost prop of a pose, unit-hand frame scaled by L, mirrored for the left hand. */
function _buildGhost(poseKey, L, left, mat) {
  const Th = T();
  const P = HAND_POSES[poseKey];
  if (!P?.ghost) return null;
  const g = P.ghost;
  const grp = new Th.Group(); grp.name = 'ghost';
  const place = (mesh, at) => { mesh.position.copy(_v(_mirror(at, left)).multiplyScalar(L)); grp.add(mesh); };
  if (g.kind === 'cylinder') {
    const geo = new Th.CylinderGeometry(g.r * L, g.r * L, g.len * L, 24);
    if (g.axis === 'x') geo.rotateZ(Math.PI / 2); else if (g.axis === 'z') geo.rotateX(Math.PI / 2);
    place(new Th.Mesh(geo, mat), g.at);
  } else if (g.kind === 'box') {
    place(new Th.Mesh(new Th.BoxGeometry(g.size[0] * L, g.size[1] * L, g.size[2] * L), mat), g.at);
  } else if (g.kind === 'pistol') {
    place(new Th.Mesh(new Th.BoxGeometry(0.30 * L, 0.46 * L, 0.16 * L), mat), [0, 0.40, -0.16]);
    const guard = new Th.Mesh(new Th.TorusGeometry(0.075 * L, 0.012 * L, 8, 24), mat); guard.rotation.y = Math.PI / 2; place(guard, [0.20, 0.74, -0.12]);
    const trig = new Th.Mesh(new Th.CylinderGeometry(0.02 * L, 0.02 * L, 0.10 * L, 10), mat); place(trig, [0.22, 0.74, -0.12]);
    place(new Th.Mesh(new Th.BoxGeometry(0.18 * L, 0.22 * L, 0.55 * L), mat), [0.04, 0.72, -0.40]);   // the barrel, roughly
  }
  // the three mapping points, numbered
  P.points.forEach((pt, i) => {
    const m = new Th.Mesh(new Th.SphereGeometry(0.028 * L, 12, 12), new Th.MeshBasicMaterial({ color: ['#fbbf24', '#f472b6', '#4ade80'][i], depthTest: false, transparent: true, opacity: 0.95 }));
    m.renderOrder = 998; m.name = `ghost-pt-${i + 1}`;
    place(m, pt.at);
  });
  grp.traverse(o => { o.userData.isHandGhost = true; });
  return grp;
}

/** Build the rig for a node; cached on the group by side + scale + pose. */
export function ensureHandObject3D(node) {
  const Th = T();
  if (!Th || !node || node.type !== 'hand') return null;
  const p = node.handParams || (node.handParams = defaultHandParams());
  if (!HAND_POSES[p.pose]) p.pose = 'handle';
  const L = Number(p.scale) || 190;
  const left = node.handSide === 'left';
  const key = `${left ? 'L' : 'R'}:${L}:${p.pose}`;
  const existing = node.object3d;
  if (existing && existing.userData?.handBuildKey === key) return existing;

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
  const ghostMat = new Th.MeshStandardMaterial({ color: ANAT.ghost, transparent: true, opacity: 0.35, roughness: 0.4, depthWrite: false });
  const handleMat = new Th.MeshBasicMaterial({ color: '#22d3ee', depthTest: false, transparent: true, opacity: 0.9 });
  const tag = (o) => { o.userData.nodeId = node.id; o.userData.meshNodeId = node.id; o.userData.handNodeId = node.id; return o; };

  const group = new Th.Group();
  group.name = node.name || (left ? 'Left hand' : 'Right hand');
  tag(group);
  group.userData.handBuildKey = key;
  group.userData.handColor = prevColor || ANAT.skin;
  group.userData.isHand = true;

  const palm = tag(new Th.Mesh(_roundedBox(ANAT.palm.w * L, ANAT.palm.h * L, ANAT.palm.t * L, 0.08 * L), mat));
  palm.position.set(0, ANAT.palm.y * L, 0); palm.name = 'palm';
  group.add(palm);

  const forearm = tag(new Th.Mesh(_capsule(ANAT.forearm.r * L, ANAT.forearm.len * L), mat));
  forearm.name = 'forearm';
  forearm.quaternion.setFromAxisAngle(new Th.Vector3(0, 0, 1), Math.PI);
  group.add(forearm);

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
    const handle = new Th.Mesh(new Th.SphereGeometry(0.03 * L, 12, 12), handleMat.clone());
    handle.userData.handControl = { nodeId: node.id, key: f }; handle.renderOrder = 999; handle.visible = false; handle.name = `${f}-handle`;
    tip.add(handle);
    group.add(j1);
    fingers[f] = { joints, bones, tip, handle, basis, alpha: 0, phi: [0, 0, 0], flexMax: a.flexMax.map(d => d * DEG), spread: a.spread * DEG };
  }
  const foreHandle = new Th.Mesh(new Th.SphereGeometry(0.045 * L, 12, 12), handleMat.clone());
  foreHandle.material.color.set('#fbbf24'); foreHandle.userData.handControl = { nodeId: node.id, key: 'forearm' }; foreHandle.renderOrder = 999; foreHandle.visible = false;
  foreHandle.position.set(0, -ANAT.forearm.len * L, 0);
  group.add(foreHandle);

  const ghost = _buildGhost(p.pose, L, left, ghostMat);
  if (ghost) group.add(ghost);

  for (const c of kept) group.add(c);
  group.userData.rig = { L, left, pose: p.pose, fingers, palm, forearm, foreHandle, ghost, mat };
  node.object3d = group;
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
/** angles: {finger: [k, m, t, spread?]} — blended from REST by `t` (0 = rest, 1 = pose). */
function _setPose(rig, angles, t) {
  for (const f of HAND_FINGERS) {
    const fg = rig.fingers[f];
    const a = angles[f] || REST[f], r = REST[f];
    for (let i = 0; i < 3; i++) fg.phi[i] = (r[i] + ((a[i] ?? r[i]) - r[i]) * t) * DEG;
    fg.alpha = ((a[3] || 0) * t) * DEG * (rig.left ? -1 : 1);
    _setFingerAngles(fg);
  }
}

// ── targets (fine-tune pins) ─────────────────────────────────────────────────

/** World position of a finger's pinned target (null when unpinned / unresolved). */
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

function _signedAngle(axis, u, v) {
  const Th = T();
  const a = axis.clone().normalize();
  const pu = u.clone().sub(a.clone().multiplyScalar(u.dot(a)));
  const pv = v.clone().sub(a.clone().multiplyScalar(v.dot(a)));
  if (pu.lengthSq() < 1e-10 || pv.lengthSq() < 1e-10) return 0;
  return Math.atan2(new Th.Vector3().crossVectors(pu, pv).dot(a), pu.dot(pv));
}

/** CCD: bend one finger toward a world target (from its current pose). Returns the remaining distance. */
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
      if (ji === 0) {
        const d = _signedAngle(worldAxis(j, Z), u, v);
        fg.alpha = _clamp(fg.alpha + d, -fg.spread, fg.spread);
        _setFingerAngles(fg); fg.joints[0].updateMatrixWorld(true);
        fg.tip.getWorldPosition(tip); u.copy(tip).sub(jp);
      }
      const d = _signedAngle(worldAxis(j, X), u, v);
      fg.phi[ji] = _clamp(fg.phi[ji] + d, -6 * DEG, fg.flexMax[ji]);
      _setFingerAngles(fg);
    }
  }
  fg.joints[0].updateMatrixWorld(true);
  fg.tip.getWorldPosition(tip);
  return tip.distanceTo(targetW);
}

// ── the solve ────────────────────────────────────────────────────────────────

/**
 * Solve one hand from its params: the wrist is the node's own transform; the
 * fingers take the pose (blended by `closed`, or the open hand when released),
 * and every pinned finger bends on to its target. Safe to call often.
 * @returns {{ pinned:number, unreached:string[] }}
 */
export function solveHand(node) {
  const Th = T();
  const group = node?.object3d;
  const rig = group?.userData?.rig;
  if (!Th || !rig) return { pinned: 0, unreached: [] };
  const p = node.handParams || (node.handParams = defaultHandParams());
  group.parent?.updateMatrixWorld?.(true);
  applyNodeTransformToObject3D(node, group);
  group.updateMatrixWorld(true);

  const L = rig.L;
  const pose = HAND_POSES[p.pose] || HAND_POSES.handle;
  if (p.released) _setPose(rig, OPEN, _clamp(Number(p.open) || 0, 0, 1));
  else            _setPose(rig, pose.angles, _clamp(Number(p.closed ?? 1), 0, 1));
  if (rig.ghost) rig.ghost.visible = !p.released && p.ghost !== false;

  const tips = {};
  const pinned = [];
  if (!p.released) for (const f of HAND_FINGERS) { const t = targetWorld(node, f); if (t) { tips[f] = t; pinned.push(f); } }
  group.updateMatrixWorld(true);
  for (const f of pinned) _solveFinger(rig.fingers[f], tips[f]);

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

// ── controls, ghost points ───────────────────────────────────────────────────

/** World position of a control: a fingertip (its target when pinned), the palm (wrist), the forearm point. */
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

/** The pose's three mapping points in WORLD space (null for a pose without a prop). */
export function ghostPointsWorld(node) {
  const group = node?.object3d; const rig = group?.userData?.rig;
  const P = HAND_POSES[node?.handParams?.pose];
  if (!rig || !P?.ghost) return null;
  group.updateMatrixWorld(true);
  return P.points.map(pt => group.localToWorld(_v(_mirror(pt.at, rig.left)).multiplyScalar(rig.L)));
}
export function ghostPointLabels(node) { return (HAND_POSES[node?.handParams?.pose]?.points || []).map(p => p.label); }

/** Handle meshes of every live hand (for picking). */
export function handleMeshes() {
  const out = [];
  for (const n of _liveHands()) {
    const rig = n.object3d?.userData?.rig; if (!rig) continue;
    for (const f of HAND_FINGERS) out.push(rig.fingers[f].handle);
    out.push(rig.foreHandle);
  }
  return out;
}
function _liveHands() {
  const nb = state.get('nodeById'); const out = [];
  if (!nb) return out;
  for (const [, n] of nb) if (n?.type === 'hand' && n.object3d) out.push(n);
  return out;
}

// ── the frame hook: re-solve a hand when its inputs moved ────────────────────
const _sigCache = new Map();
let _hooked = false;

function _signature(node) {
  const p = node.handParams || {};
  const parts = [node.handSide, p.scale, p.pose, p.closed, p.ghost === false ? 0 : 1, p.released ? 1 : 0, p.open, JSON.stringify(p.forearm), JSON.stringify(node.localOffset), JSON.stringify(node.localQuaternion), node.moveEnabled === false ? 0 : 1, node.rotateEnabled === false ? 0 : 1];
  for (const f of HAND_FINGERS) { const t = p.released ? null : targetWorld(node, f); parts.push(t ? `${t.x.toFixed(2)},${t.y.toFixed(2)},${t.z.toFixed(2)}` : '-'); }
  const g = node.object3d;
  if (g?.parent) { const e = g.parent.matrixWorld.elements; parts.push(e[12].toFixed(1), e[13].toFixed(1), e[14].toFixed(1), e[0].toFixed(3), e[5].toFixed(3), e[6].toFixed(3)); }
  return parts.join('|');
}

/** Force a re-solve on the next frame. */
export function markHandDirty(nodeId) { _sigCache.delete(nodeId); }

export function tickHands() {
  const Th = T(); if (!Th) return false;
  const fine = state.get('handFineTune');
  const selCtl = state.get('selectedHandControl');
  let changed = false;
  for (const n of _liveHands()) {
    // (a pose / size change rebuilds the rig where the params change lands —
    //  hand-actions._applyParams and the step rebuild — never here: the tick
    //  cannot update steps.object3dById)
    const sig = _signature(n);
    if (_sigCache.get(n.id) !== sig) {
      solveHand(n);
      _sigCache.set(n.id, _signature(n));
      changed = true;
    }
    const show = fine === n.id || selCtl?.nodeId === n.id;
    const rig2 = n.object3d.userData.rig;
    if (rig2.foreHandle.visible !== show) {
      for (const f of HAND_FINGERS) rig2.fingers[f].handle.visible = show;
      rig2.foreHandle.visible = show;
      changed = true;
    }
    if (show) {
      for (const f of HAND_FINGERS) {
        const h = rig2.fingers[f].handle, t = targetWorld(n, f);
        if (t && !n.handParams?.released) h.position.copy(h.parent.worldToLocal(t.clone()));
        else h.position.set(0, 0, 0);
        h.material.color.set(t && !n.handParams?.released ? '#22d3ee' : '#94a3b8');
      }
    }
  }
  return changed;
}

export function initHands() {
  if (_hooked) return;
  _hooked = true;
  const step = () => { try { if (tickHands()) sceneCore.requestRender?.(120); } catch (e) { console.warn('[hands] tick failed:', e?.message); } };
  if (typeof sceneCore.addTickHook === 'function') sceneCore.addTickHook(step);
  else { const raf = () => { step(); requestAnimationFrame(raf); }; requestAnimationFrame(raf); }
}
