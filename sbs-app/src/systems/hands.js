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
import { APP_VERSION }                  from '../core/schema.js';
import * as userSettings                from '../core/user-settings.js';           // 🧤 V0.3.4.139 the skin file is a machine setting
import { skinnedMeshGlb }               from '../io/glb-write.js';                // 🧤 the rig export
import { skinnedMeshFbx }               from '../io/fbx-write.js';                // 🧤 … and as FBX (V0.3.4.140)
import { GLTFLoader }                   from '../../vendor/GLTFLoader.bundle.mjs'; // 🧤 the skin coming back
import { FBXLoader }                    from '../../vendor/FBXLoader.bundle.mjs';  // 🧤 … as FBX from Max

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
    // the thumb's base is a BALL joint in the IK (cone-limited), not a hinge — see _solveFinger
    thumb:  { mcp: [ 0.20,  0.14, -0.03], dir: [ 0.72, 0.58, -0.38], curl: [-0.55, 0.35, -0.75], len: [0.26, 0.17, 0.13], r: 0.050, flexMax: [60, 70, 80], spread: 45, ball: 80 },
  },
  forearm: { len: 1.35, r: 0.075 },
  skin: '#e6b596',
  ghost: '#7dd3fc',
};

// ── the poses: joint angles at closed = 1 (degrees: [knuckle, middle, tip], a = spread),
//    the ghost prop that grip holds, and the three points on it the user maps ──
const REST = { index: [14, 12, 8], middle: [14, 12, 8], ring: [14, 12, 8], pinky: [14, 12, 8], thumb: [10, 12, 8] };
const OPEN = { index: [-6, 0, 0, 6], middle: [-6, 0, 0, 0], ring: [-6, 0, 0, -6], pinky: [-6, 0, 0, -14], thumb: [0, 0, 0, 14] };

// The ghost prop of each grip is LAID OUT FROM THE POSED FINGERS (V0.3.4.129 —
// hand-placed constants sat through the index finger): the bar's axis from the
// centroid of the curled fingers, the knob from the ring of fingertips, the
// pinched part from the thumb–index gap, the trigger at the index tip. See
// _layoutGhost. `points` only names the three mapping points, in order.
export const HAND_POSES = {
  handle: {
    label: 'Handle / bar', icon: '🪛', hint: 'A power grip around a bar or a handle.',
    angles: { index: [70, 90, 55], middle: [72, 95, 58], ring: [74, 95, 60], pinky: [78, 95, 60], thumb: [30, 40, 35] },
    ghost: 'handle',
    points: ['one end of the handle', 'the other end of the handle', 'the far side of the handle, where the fingers wrap over it'],
  },
  pistol: {
    label: 'Pistol grip + trigger', icon: '🔫', hint: 'The hand around a grip, the index finger on a trigger.',
    angles: { index: [22, 18, 10], middle: [70, 95, 60], ring: [72, 95, 60], pinky: [76, 95, 62], thumb: [28, 35, 30] },
    ghost: 'pistol',
    points: ['the top of the grip, under the trigger guard', 'the bottom of the grip', 'the trigger'],
  },
  pinch: {
    label: 'Pinch', icon: '🤏', hint: 'A small part between the thumb and the index finger.',
    angles: { index: [42, 55, 32], middle: [58, 72, 42], ring: [62, 80, 46], pinky: [66, 86, 50], thumb: [22, 32, 40] },
    ghost: 'pinch',
    points: ['the face the index finger presses', 'the face the thumb presses', 'a point on the part\'s side (its direction)'],
  },
  push: {
    label: 'Flat push', icon: '✋', hint: 'The open palm pressed on a surface or a big button.',
    angles: { index: [-4, 0, 0, 8], middle: [-4, 0, 0, 0], ring: [-4, 0, 0, -8], pinky: [-4, 0, 0, -16], thumb: [0, 6, 0, 20] },
    ghost: 'push',
    points: ['the surface under the middle of the palm', 'the surface toward the fingertips', 'the surface toward the thumb'],
  },
  knob: {
    label: 'Knob / dial', icon: '🎛', hint: 'Fingertips around a knob, seen end-on.',
    angles: { index: [34, 52, 34], middle: [36, 55, 36], ring: [38, 58, 38], pinky: [42, 60, 40], thumb: [22, 30, 26] },
    ghost: 'knob',
    points: ['a point on the knob\'s rim', 'a second point on the rim (a third of the way round)', 'a third point on the rim'],
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

/** Joint positions in the GROUP frame with the rig posed at `angles` (closed = 1). */
function _fkPositions(rig, angles) {
  const Th = T();
  const group = rig.palm.parent;
  _setPose(rig, angles, 1);
  const at = (obj) => {
    const m = new Th.Matrix4(); const chain = []; let o = obj;
    while (o && o !== group) { chain.unshift(o); o = o.parent; }
    for (const c of chain) { c.updateMatrix(); m.multiply(c.matrix); }
    return new Th.Vector3().setFromMatrixPosition(m);
  };
  const out = {};
  for (const f of HAND_FINGERS) { const fg = rig.fingers[f]; out[f] = { j1: at(fg.joints[0]), j2: at(fg.joints[1]), j3: at(fg.joints[2]), tip: at(fg.tip) }; }
  return out;
}
const _mean = (pts) => { const Th = T(); const c = new Th.Vector3(); for (const p of pts) c.add(p); return c.multiplyScalar(1 / Math.max(1, pts.length)); };

/**
 * Where the prop sits, read off the posed fingers (group frame). Returns
 * { meshes:[{geo, pos, quat?}], points:[Vector3 ×3] } or null for no prop.
 */
function _layoutGhost(poseKey, rig) {
  const Th = T();
  const P = HAND_POSES[poseKey];
  if (!P?.ghost) return null;
  const L = rig.L, fk = _fkPositions(rig, P.angles);
  const X = new Th.Vector3(1, 0, 0), Z = new Th.Vector3(0, 0, 1);
  const fingerR = 0.045 * L;
  const loop = (f) => _mean([fk[f].j1, fk[f].j2, fk[f].j3, fk[f].tip]);   // inside the curl
  const loopR = (f, c) => _mean([fk[f].j1, fk[f].j2, fk[f].j3, fk[f].tip].map(p => new Th.Vector3(p.distanceTo(c), 0, 0))).x;
  const meshes = [];
  let points = [];
  // the prop's frame — the hand's PIVOT jumps here on a pose pick (user): its
  // centre, oriented with the prop's main axis as the pivot's +Y
  const Y = new Th.Vector3(0, 1, 0);
  let frame = null;
  const frameOf = (pos, axis) => ({ pos: pos.clone(), quat: new Th.Quaternion().setFromUnitVectors(Y, axis.clone().normalize()) });

  if (P.ghost === 'handle' || P.ghost === 'pistol') {
    const fs = P.ghost === 'handle' ? ['index', 'middle', 'ring', 'pinky'] : ['middle', 'ring', 'pinky'];
    const cs = fs.map(loop);
    const C = _mean(cs);
    const r = Math.max(0.06 * L, Math.min(0.13 * L, _mean(fs.map((f, i) => new Th.Vector3(loopR(f, cs[i]) - fingerR, 0, 0))).x));
    frame = frameOf(C, X);
    if (P.ghost === 'handle') {
      const len = 0.9 * L;
      const geo = new Th.CylinderGeometry(r, r, len, 24); geo.rotateZ(Math.PI / 2);
      meshes.push({ geo, pos: C });
      points = [C.clone().addScaledVector(X, len / 2), C.clone().addScaledVector(X, -len / 2), C.clone().addScaledVector(Z, -r)];
    } else {
      // the grip: a bar under the three curled fingers, taller than wide; the trigger at the index tip
      const len = 0.55 * L;
      const geo = new Th.BoxGeometry(len, 2.2 * r, 1.6 * r);
      meshes.push({ geo, pos: C });
      const trig = fk.index.tip.clone();
      const tg = new Th.CylinderGeometry(0.02 * L, 0.02 * L, 0.12 * L, 10); tg.rotateZ(Math.PI / 2);
      meshes.push({ geo: tg, pos: trig });
      const guard = new Th.TorusGeometry(0.07 * L, 0.011 * L, 8, 24); guard.rotateY(Math.PI / 2);
      meshes.push({ geo: guard, pos: trig.clone().addScaledVector(Z, -0.02 * L) });
      // the top of the grip is the index-side end (the web of the thumb), the bottom the pinky-side end
      const sideX = rig.left ? -1 : 1;
      points = [C.clone().addScaledVector(X, sideX * len / 2), C.clone().addScaledVector(X, -sideX * len / 2), trig.clone()];
    }
  } else if (P.ghost === 'pinch') {
    const tT = fk.thumb.tip, tI = fk.index.tip;
    const a = tI.clone().sub(tT); const d = a.length(); a.normalize();
    const thick = Math.max(0.02 * L, d - 2 * 0.04 * L);
    const C = _mean([tT, tI]);
    const q = new Th.Quaternion().setFromUnitVectors(Z, a);
    meshes.push({ geo: new Th.BoxGeometry(0.14 * L, 0.10 * L, thick), pos: C, quat: q });
    let s = new Th.Vector3().crossVectors(a, new Th.Vector3(0, 1, 0)); if (s.lengthSq() < 1e-6) s = X.clone(); s.normalize();
    points = [C.clone().addScaledVector(a, thick / 2), C.clone().addScaledVector(a, -thick / 2), C.clone().addScaledVector(s, 0.07 * L)];
    frame = frameOf(C, a);
  } else if (P.ghost === 'push') {
    const z = -(ANAT.palm.t * 0.5 + 0.03) * L;
    const C = new Th.Vector3(0, ANAT.palm.y * L + 0.05 * L, z);
    meshes.push({ geo: new Th.BoxGeometry(0.62 * L, 0.72 * L, 0.02 * L), pos: C });
    const sideX = rig.left ? -1 : 1;
    points = [C.clone(), C.clone().add(new Th.Vector3(0, 0.34 * L, 0)), C.clone().add(new Th.Vector3(sideX * 0.28 * L, 0, 0))];
    frame = frameOf(C, new Th.Vector3(0, 0, -1));
  } else if (P.ghost === 'knob') {
    const tips = HAND_FINGERS.map(f => fk[f].tip);
    const c = _mean(tips);
    const R = Math.max(0.10 * L, _mean(tips.map(p => new Th.Vector3(Math.hypot(p.x - c.x, p.y - c.y), 0, 0))).x + 0.02 * L);
    const zFace = _mean(tips).z;
    const h = 0.22 * L;
    const geo = new Th.CylinderGeometry(R, R, h, 32); geo.rotateX(Math.PI / 2);
    const centre = new Th.Vector3(c.x, c.y, zFace - h / 2);
    meshes.push({ geo, pos: centre });
    points = [0, 2 * Math.PI / 3, 4 * Math.PI / 3].map(t => new Th.Vector3(c.x + R * Math.cos(t), c.y + R * Math.sin(t), zFace));
    frame = frameOf(centre, new Th.Vector3(0, 0, -1));
  }
  return { meshes, points, frame };
}

/** The prop's frame in the hand's own space (where the pivot goes), or null. */
export function propFrame(node) {
  const f = node?.object3d?.userData?.rig?.ghostFrame;
  return f ? { pos: [f.pos.x, f.pos.y, f.pos.z], quat: [f.quat.x, f.quat.y, f.quat.z, f.quat.w] } : null;
}

/** The ghost prop group from a layout. */
function _buildGhost(layout, L, mat) {
  const Th = T();
  if (!layout) return null;
  const grp = new Th.Group(); grp.name = 'ghost';
  for (const m of layout.meshes) {
    const mesh = new Th.Mesh(m.geo, mat);
    mesh.position.copy(m.pos);
    if (m.quat) mesh.quaternion.copy(m.quat);
    grp.add(mesh);
  }
  layout.points.forEach((pt, i) => {
    const m = new Th.Mesh(new Th.SphereGeometry(0.028 * L, 12, 12), new Th.MeshBasicMaterial({ color: ['#fbbf24', '#f472b6', '#4ade80'][i], depthTest: false, transparent: true, opacity: 0.95 }));
    m.renderOrder = 998; m.name = `ghost-pt-${i + 1}`;
    m.position.copy(pt);
    grp.add(m);
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
  const key = `${left ? 'L' : 'R'}:${L}:${p.pose}:skin${_skin.template ? _skin.rev : 0}`;
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
    fingers[f] = { joints, bones, tip, handle, basis, alpha: 0, phi: [0, 0, 0], ball: null, ballCone: a.ball ? a.ball * DEG : 0, flexMax: a.flexMax.map(d => d * DEG), spread: a.spread * DEG };
  }
  const foreHandle = new Th.Mesh(new Th.SphereGeometry(0.045 * L, 12, 12), handleMat.clone());
  foreHandle.material.color.set('#fbbf24'); foreHandle.userData.handControl = { nodeId: node.id, key: 'forearm' }; foreHandle.renderOrder = 999; foreHandle.visible = false;
  foreHandle.position.set(0, -ANAT.forearm.len * L, 0);
  group.add(foreHandle);

  for (const c of kept) group.add(c);
  const rig = { L, left, pose: p.pose, fingers, palm, forearm, foreHandle, ghost: null, ghostPoints: [], ghostFrame: null, mat, skin: null };
  group.userData.rig = rig;
  // 🧤 a skinned hand over the rig, when one is loaded: the bones follow the joints
  if (_skin.template) {
    try { rig.skin = _instantiateSkin(_skin.template, rig, group, left, L, mat, tag); }
    catch (e) { console.warn('[hands] the skin could not be put on this hand:', e); rig.skin = null; }
  }
  // the prop is laid out from the POSED fingers (the solve re-poses the rig right after)
  const layout = _layoutGhost(p.pose, rig);
  if (layout) {
    rig.ghost = _buildGhost(layout, L, ghostMat);
    rig.ghostPoints = layout.points.map(v => v.clone());
    rig.ghostFrame = layout.frame;
    group.add(rig.ghost);
  }
  node.object3d = group;
  _sigCache.delete(node.id);
  return group;
}

function _setFingerAngles(fg) {
  const Th = T();
  const rx = (a) => new Th.Quaternion().setFromAxisAngle(new Th.Vector3(1, 0, 0), a);
  const rz = (a) => new Th.Quaternion().setFromAxisAngle(new Th.Vector3(0, 0, 1), a);
  if (fg.ball) fg.joints[0].quaternion.copy(fg.ball);   // the thumb's base, driven as a ball joint by the IK
  else fg.joints[0].quaternion.copy(fg.basis).multiply(rz(fg.alpha)).multiply(rx(fg.phi[0]));
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
    fg.ball = null;
    _setFingerAngles(fg);
  }
}

// ── targets (fine-tune pins) ─────────────────────────────────────────────────

/**
 * World position of a finger's pinned target (null when unpinned / unresolved).
 * Three forms: on a part { nodeId, anchorLocal } (rides the part), in the HAND's
 * frame { local } (rides the hand — V0.3.4.130: a fingertip adjusted off the grip
 * used to be a world point and stayed behind when the hand's group moved), or
 * a legacy world point { pos }.
 */
export function targetWorld(node, finger, params = node?.handParams) {
  const t = params?.targets?.[finger];
  if (!t) return null;
  const Th = T();
  if (Array.isArray(t.local)) {
    const g = node.object3d; if (!g) return null;
    g.updateMatrixWorld(true);
    return g.localToWorld(_v(t.local));
  }
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
      if (ji === 0 && fg.ballCone) {
        // the thumb's base: a BALL joint — the shortest arc taking the tip toward the
        // target, then held inside a cone about the rest direction (opposition is free,
        // the hinge-plus-spread of the other knuckles was what made it feel stuck)
        if (u.lengthSq() > 1e-9 && v.lengthSq() > 1e-9) {
          const qw = new Th.Quaternion().setFromUnitVectors(u.clone().normalize(), v.clone().normalize());
          const pq = j.parent.getWorldQuaternion(new Th.Quaternion());
          const cur = pq.clone().multiply(j.quaternion);
          let local = pq.clone().invert().multiply(qw.multiply(cur));
          const restY = new Th.Vector3(0, 1, 0).applyQuaternion(fg.basis), newY = new Th.Vector3(0, 1, 0).applyQuaternion(local);
          const ang = restY.angleTo(newY);
          if (ang > fg.ballCone) local = fg.basis.clone().slerp(local, fg.ballCone / ang);
          fg.ball = local;
          _setFingerAngles(fg);
        }
        continue;
      }
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
 * Solve one hand from params (its own by default): the fingers take the pose
 * (blended by `closed`, or the open hand when released) and every pinned
 * finger bends on to its target. The wrist is the node's own transform — it is
 * NOT written here: the group's transform belongs to the app's transform
 * machinery (activation, the gizmo, the step's object lerp mid-transition).
 * @returns {{ pinned:number, unreached:string[] }}
 */
export function solveHand(node, params = null) {
  const Th = T();
  const group = node?.object3d;
  const rig = group?.userData?.rig;
  if (!Th || !rig) return { pinned: 0, unreached: [] };
  const p = params || node.handParams || (node.handParams = defaultHandParams());
  group.updateMatrixWorld(true);

  const L = rig.L;
  const pose = HAND_POSES[p.pose] || HAND_POSES.handle;
  if (rig.ghost) rig.ghost.visible = !p.released && p.ghost !== false;

  // the grip: the pose at `closed`, then every pinned finger on to its target.
  // Released (V0.3.4.132, user): the grip AS IT WAS is the starting point and
  // `open` takes it toward the open hand — 0 = still the grip, a little = fingers
  // eased off what was held, 1 = fully open. A pin on a PART is let go with the
  // release (the hand is leaving it); a pin in the hand's frame still shapes it.
  const tips = {};
  const pinned = [];
  for (const f of HAND_FINGERS) {
    const tg = p.targets?.[f];
    if (!tg) continue;
    if (p.released && !Array.isArray(tg.local)) continue;
    const t = targetWorld(node, f, p);
    if (t) { tips[f] = t; pinned.push(f); }
  }
  _setPose(rig, pose.angles, _clamp(Number(p.closed ?? 1), 0, 1));
  group.updateMatrixWorld(true);
  for (const f of pinned) _solveFinger(rig.fingers[f], tips[f]);
  if (p.released) {
    const open = _clamp(Number(p.open) || 0, 0, 1);
    if (open > 0) {
      const A = _captureAngles(rig);
      _setPose(rig, OPEN, 1);
      const B = _captureAngles(rig);
      for (const f of HAND_FINGERS) {
        const fg = rig.fingers[f], a = A[f], b = B[f];
        fg.ball = a.q1.clone().slerp(b.q1, open);
        fg.phi[1] = a.phi1 + (b.phi1 - a.phi1) * open;
        fg.phi[2] = a.phi2 + (b.phi2 - a.phi2) * open;
        _setFingerAngles(fg);
      }
    }
  }

  // the forearm bone aims at the forearm point (in the hand's frame; a legacy world point still reads) or straight back
  _aimForearm(rig, Array.isArray(p.forearmLocal) ? _v(p.forearmLocal)
    : Array.isArray(p.forearm) ? group.worldToLocal(_v(p.forearm))
    : new Th.Vector3(0, -ANAT.forearm.len * L, 0));
  _syncSkin(rig);
  group.updateMatrixWorld(true);
  const unreached = pinned.filter(f => { const t = new Th.Vector3(); rig.fingers[f].tip.getWorldPosition(t); return t.distanceTo(tips[f]) > 0.03 * L; });
  return { pinned: pinned.length, unreached };
}

/** Aim the forearm bone at a point in the hand's frame (length clamped); the yellow handle sits on that point. */
function _aimForearm(rig, localTarget) {
  const Th = T(), L = rig.L;
  const fa = rig.forearm, fh = rig.foreHandle;
  const dir = localTarget.clone().normalize();
  fa.quaternion.setFromUnitVectors(new Th.Vector3(0, 1, 0), dir.lengthSq() ? dir : new Th.Vector3(0, -1, 0));
  const len = _clamp(localTarget.length(), 0.6 * L, 2.2 * L);
  fa.scale.set(1, len / (ANAT.forearm.len * L), 1);
  fh.position.copy(dir.multiplyScalar(len));
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
  if (!rig || !rig.ghost || rig.ghostPoints.length !== 3) return null;
  group.updateMatrixWorld(true);
  return rig.ghostPoints.map(pt => group.localToWorld(pt.clone()));
}
export function ghostPointLabels(node) { return [...(HAND_POSES[node?.handParams?.pose]?.points || [])]; }

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

// ── step transitions: the hand's parameters blend, not jump ─────────────────
// (V0.3.4.131, user: "any animation between steps should be smooth".) The step
// rebuild puts the TARGET params on the node and stashes the previous ones as
// node._handFrom; beginHandTransitions (called where the cable morph begins,
// same duration + easing) turns that into a transition; each frame the fingers
// are solved for BOTH states (pose, closed, released / open, pins + IK) and the
// joint angles are blended. The wrist rides the step's own object lerp.
const _transitions = new Map();   // nodeId → { from, to, t0, dur, ease }

/** The effective knuckle quaternion of a finger state (ball joint or hinge + spread). */
function _j1Quat(fg) {
  const Th = T();
  if (fg.ball) return fg.ball.clone();
  const rx = new Th.Quaternion().setFromAxisAngle(new Th.Vector3(1, 0, 0), fg.phi[0]);
  const rz = new Th.Quaternion().setFromAxisAngle(new Th.Vector3(0, 0, 1), fg.alpha);
  return fg.basis.clone().multiply(rz).multiply(rx);
}
function _captureAngles(rig) {
  const out = {};
  for (const f of HAND_FINGERS) { const fg = rig.fingers[f]; out[f] = { q1: _j1Quat(fg), phi1: fg.phi[1], phi2: fg.phi[2] }; }
  return out;
}
/** Solve for `from` and `to`, then set every joint at the blend `t`. */
function _solveBlend(node, from, to, t) {
  const rig = node.object3d?.userData?.rig;
  if (!rig) return;
  solveHand(node, from); const A = _captureAngles(rig); const foreA = rig.foreHandle.position.clone();
  solveHand(node, to);   const B = _captureAngles(rig); const foreB = rig.foreHandle.position.clone();
  for (const f of HAND_FINGERS) {
    const fg = rig.fingers[f], a = A[f], b = B[f];
    fg.ball = a.q1.clone().slerp(b.q1, t);
    fg.phi[1] = a.phi1 + (b.phi1 - a.phi1) * t;
    fg.phi[2] = a.phi2 + (b.phi2 - a.phi2) * t;
    _setFingerAngles(fg);
  }
  // V0.3.4.138 — the forearm swings too (user: "the elbow gizmo jumps"): its
  // direction slerps, its length lerps, between the two solved forearm points.
  {
    const Th = T(), up = new Th.Vector3(0, 1, 0);
    const qA = new Th.Quaternion().setFromUnitVectors(up, foreA.clone().normalize());
    const qB = new Th.Quaternion().setFromUnitVectors(up, foreB.clone().normalize());
    const len = foreA.length() + (foreB.length() - foreA.length()) * t;
    _aimForearm(rig, up.clone().applyQuaternion(qA.slerp(qB, t)).multiplyScalar(len));
  }
  if (rig.ghost) rig.ghost.visible = !to.released && to.ghost !== false;
  _syncSkin(rig);
  node.object3d.updateMatrixWorld(true);
}

/** Called where a step transition's object channel starts: every hand whose params changed blends over it. */
export function beginHandTransitions(durationMs, easeFn) {
  const now = _now;
  for (const n of _liveHands()) {
    const from = n._handFrom;
    delete n._handFrom;
    if (!from) continue;
    if (JSON.stringify(from) === JSON.stringify(n.handParams)) continue;
    _transitions.set(n.id, { from, to: JSON.parse(JSON.stringify(n.handParams)), t0: now, dur: Math.max(1, durationMs || 1), ease: typeof easeFn === 'function' ? easeFn : (x) => x });
  }
}
/** A step change was cut short: every hand lands on its target at once. */
export function snapHandTransitionsToFinal() {
  for (const [id] of _transitions) _sigCache.delete(id);
  _transitions.clear();
  for (const n of _liveHands()) delete n._handFrom;
}

// ── the frame hook: re-solve a hand when its inputs moved ────────────────────
const _sigCache = new Map();
let _hooked = false;
let _now = (typeof performance !== 'undefined' ? performance.now() : 0);

function _signature(node) {
  const p = node.handParams || {};
  const parts = [node.handSide, p.scale, p.pose, p.closed, p.ghost === false ? 0 : 1, p.released ? 1 : 0, p.open, JSON.stringify(p.forearm), JSON.stringify(p.forearmLocal), JSON.stringify(node.localOffset), JSON.stringify(node.localQuaternion), node.moveEnabled === false ? 0 : 1, node.rotateEnabled === false ? 0 : 1];
  const from = node._handFrom;   // V0.3.4.137 — while a hand HOLDS its previous grip, that grip's pins are what it follows
  for (const f of HAND_FINGERS) {
    const t = p.released ? null : targetWorld(node, f);
    parts.push(t ? `${t.x.toFixed(2)},${t.y.toFixed(2)},${t.z.toFixed(2)}` : '-');
    if (from) { const u = from.released ? null : targetWorld(node, f, from); parts.push(u ? `${u.x.toFixed(2)},${u.y.toFixed(2)},${u.z.toFixed(2)}` : '-'); }
  }
  const g = node.object3d;
  if (g?.parent) { const e = g.parent.matrixWorld.elements; parts.push(e[12].toFixed(1), e[13].toFixed(1), e[14].toFixed(1), e[0].toFixed(3), e[5].toFixed(3), e[6].toFixed(3)); }
  return parts.join('|');
}

/** Force a re-solve on the next frame. */
export function markHandDirty(nodeId) { _sigCache.delete(nodeId); }

export function tickHands(now) {
  const Th = T(); if (!Th) return false;
  if (Number.isFinite(now)) _now = now;
  const fine = state.get('handFineTune');
  const selCtl = state.get('selectedHandControl');
  let changed = false;
  for (const n of _liveHands()) {
    // (a pose / size change rebuilds the rig where the params change lands —
    //  hand-actions._applyParams and the step rebuild — never here: the tick
    //  cannot update steps.object3dById)
    const tr = _transitions.get(n.id);
    if (tr) {
      const raw = Math.min(1, (_now - tr.t0) / tr.dur);
      const t = Math.max(0, Math.min(1, tr.ease(raw)));
      if (raw >= 1) { _transitions.delete(n.id); _sigCache.delete(n.id); }
      else { _solveBlend(n, tr.from, tr.to, t); changed = true; continue; }
    }
    // V0.3.4.137 — a hand whose step params changed HOLDS its previous state
    // until its slot begins (or the instant apply snaps it): the step rebuild
    // put the target params on the node, and solving them at once made the hand
    // jump to the end pose, then snap back when its slot finally animated it.
    const sig = _signature(n) + (n._handFrom ? '|hold' : '');
    if (_sigCache.get(n.id) !== sig) {
      solveHand(n, n._handFrom || null);
      _sigCache.set(n.id, sig);
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
  const step = (now) => { try { if (tickHands(now)) sceneCore.requestRender?.(120); } catch (e) { console.warn('[hands] tick failed:', e?.message); } };
  if (typeof sceneCore.addTickHook === 'function') sceneCore.addTickHook(step);
  else { const raf = (now) => { step(now); requestAnimationFrame(raf); }; requestAnimationFrame(raf); }
  // 🧤 the skin the user loaded last time (a machine setting, not project data)
  userSettings.initUserSettings()
    .then(s => { const p = s?.hands?.skinPath; if (p) return setHandSkinFile(p, { persist: false }); })
    .catch(e => console.warn('[hands] skin at start:', e?.message));
}

// ═════════════════════════════════════════════════════════════════════════════
//  🧤 SKIN (V0.3.4.139) — a real hand mesh over the rig
// ─────────────────────────────────────────────────────────────────────────────
//  The user's plan from day one: export the rig's bones, skin a modelled hand
//  to them in 3ds Max, bring it back. Round trip:
//    buildHandRigGlb()  → a .glb of the RIGHT hand at rest (fingers straight):
//                         the bones (wrist › forearm, wrist › <finger>_1 › _2 › _3
//                         › _tip) and the capsule hand as a skinned proxy mesh;
//    setHandSkinFile()  → reads a .glb back (GLTFLoader), keeps it as the
//                         TEMPLATE; every rig build clones it under the wrist
//                         group, hides the capsules, and maps each of our joints
//                         to the bone of the same name;
//    _syncSkin()        → after every solve / blend the bones take the joints'
//                         rotation. The mapping tolerates a re-oriented bone
//                         (Max bones point along X, ours along Y; a Y-up root
//                         rotation from the exporter): with the rig at REST,
//                         C = jointRestWorld⁻¹ · boneRestWorld per bone, and
//                         a joint's local delta Δ (from its rest) becomes the
//                         bone's local B0 · C⁻¹ · Δ · C. Same hierarchy shape
//                         is all it needs (bones matched by name, punctuation
//                         and case ignored).
//  Left hand = the same file mirrored in X (geometry + bone transforms + bind
//  matrices conjugated), never a negative scale in the scene graph. Size: the
//  template's own scale is READ off its bones (wrist → middle knuckle against
//  the rig's anatomy), so Max's unit conversion on the way out and back does
//  not matter; the clone is scaled to the hand's length.
// ═════════════════════════════════════════════════════════════════════════════
const _skin = { path: '', template: null, rev: 0, error: '' };
const _norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const _boneName = (f, i) => `${f}_${i + 1}`;

/** What the UI shows: { path, loaded, error, missing[] }. */
export function handSkinInfo() {
  return { path: _skin.path, loaded: !!_skin.template, error: _skin.error, missing: _skin.template?.missing || [] };
}

/** Every finger straight, the forearm straight back: the rig's REST (= the exported bind pose). */
function _setRest(rig) {
  for (const f of HAND_FINGERS) { const fg = rig.fingers[f]; fg.phi = [0, 0, 0]; fg.alpha = 0; fg.ball = null; _setFingerAngles(fg); }
  _aimForearm(rig, new (T().Vector3)(0, -ANAT.forearm.len * rig.L, 0));
}

/** The orientation of `obj` in the frame of `stopAt` (an ancestor), from the local quaternions up the chain. */
function _quatIn(obj, stopAt) {
  const q = obj.quaternion.clone();
  for (let o = obj.parent; o && o !== stopAt; o = o.parent) q.premultiply(o.quaternion);
  return q;
}

/**
 * The rig as a .glb: RIGHT hand, `scale` mm, at rest. Bones + the capsule hand
 * as a skinned proxy (every vertex 100 % on its bone). Returns the bytes.
 */
export function buildHandRigGlb(scale = 190) {
  const d = _rigExportData(scale);
  return skinnedMeshGlb({ ...d, name: 'sbs_hand', extras: { sbsHandRig: 1, sbsHandScale: scale, sbsAppVersion: APP_VERSION } });
}
/** The same rig as FBX 7.4 ASCII text (V0.3.4.140 — the user's Max opens no .glb). */
export function buildHandRigFbx(scale = 190) {
  const d = _rigExportData(scale);
  return skinnedMeshFbx({ ...d, name: 'sbs_hand', creator: `SBS Step Browser ${APP_VERSION}` });
}

/** Bones + skinned proxy geometry of the bare rig at rest (shared by the .glb / .fbx writers). */
function _rigExportData(scale = 190) {
  const Th = T();
  const tmp = { id: 'hand-export', type: 'hand', name: 'hand', handSide: 'right', handParams: { ...defaultHandParams(), scale, pose: 'relaxed', ghost: false } };
  const keepTemplate = _skin.template; _skin.template = null;   // the BARE rig goes out, never a skin over it
  let group;
  try { group = ensureHandObject3D(tmp); } finally { _skin.template = keepTemplate; }
  const rig = group.userData.rig;
  _setRest(rig);
  group.updateMatrixWorld(true);   // parentless + untransformed: world = the wrist frame

  const bones = [];   // { name, obj, parent }
  const add = (name, obj, parent) => { bones.push({ name, obj, parent }); return bones.length - 1; };
  const wrist = add('wrist', group, -1);
  const fore  = add('forearm', rig.forearm, wrist);
  const meshBone = new Map([[rig.palm, wrist], [rig.forearm, fore]]);
  for (const f of HAND_FINGERS) {
    const fg = rig.fingers[f];
    let parent = wrist;
    for (let i = 0; i < 3; i++) { parent = add(_boneName(f, i), fg.joints[i], parent); meshBone.set(fg.bones[i], parent); }
    add(`${f}_tip`, fg.tip, parent);
  }

  // geometry into the wrist (bind) space, one bone per vertex
  const P = [], N = [], I = [], J = [], W = [];
  let base = 0;
  const v = new Th.Vector3(), nm = new Th.Matrix3();
  for (const [mesh, bi] of meshBone) {
    const g = mesh.geometry, M = mesh.matrixWorld;
    nm.getNormalMatrix(M);
    const pos = g.attributes.position, nor = g.attributes.normal;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(M); P.push(v.x, v.y, v.z);
      v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); N.push(v.x, v.y, v.z);
      J.push(bi, 0, 0, 0); W.push(1, 0, 0, 0);
    }
    if (g.index) { const a = g.index.array; for (let i = 0; i < a.length; i++) I.push(base + a[i]); }
    else { for (let i = 0; i < pos.count; i++) I.push(base + i); }
    base += pos.count;
  }
  const ibm = new Float32Array(bones.length * 16), bind = new Float32Array(bones.length * 16);
  const inv = new Th.Matrix4();
  bones.forEach((b, i) => { bind.set(b.obj.matrixWorld.elements, i * 16); inv.copy(b.obj.matrixWorld).invert(); ibm.set(inv.elements, i * 16); });

  const c = new Th.Color(ANAT.skin);
  const data = {
    bones: bones.map(b => ({ name: b.name, parent: b.parent, position: b.obj.position.toArray(), quaternion: b.obj.quaternion.toArray() })),
    positions: new Float32Array(P), normals: new Float32Array(N), indices: new Uint32Array(I),
    joints: new Uint16Array(J), weights: new Float32Array(W), inverseBindMatrices: ibm, bindMatrices: bind,
    color: [c.r, c.g, c.b],
  };
  group.traverse(o => { o.geometry?.dispose?.(); });
  return data;
}

/**
 * Load (or clear, with '') the skin file. The template is analysed once; every
 * live hand is rebuilt by hand-actions on 'hands:skinChanged'.
 */
export async function setHandSkinFile(path, { persist = true } = {}) {
  _skin.path = path || ''; _skin.template = null; _skin.error = '';
  if (_skin.path) {
    try {
      const rd = await window.sbsNative?.readFile?.(_skin.path, 'buffer');
      if (!rd?.ok) throw new Error(rd?.error || 'the file could not be read');
      const u8 = rd.data instanceof Uint8Array ? rd.data : new Uint8Array(rd.data);
      const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      const ext = _skin.path.split('.').pop().toLowerCase();
      if (ext === 'fbx') {
        const group = new FBXLoader().parse(ab, '');   // sync; binary or ASCII ≥ 7.0
        _skin.template = _analyseSkin({ scene: group, parser: null });
      } else {
        const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
        _skin.template = _analyseSkin(gltf);
      }
    } catch (e) {
      _skin.error = String(e?.message || e);
      console.warn('[hands] skin:', e);
    }
  }
  _skin.rev++;
  if (persist) { try { await userSettings.patch({ hands: { skinPath: _skin.path } }); } catch (e) { console.warn('[hands] skin setting:', e?.message); } }
  state.emit('hands:skinChanged', handSkinInfo());
  return handSkinInfo();
}

/** The loaded scene → { scene, L0, missing[] }; throws when there is nothing to put on. */
function _analyseSkin(gltf) {
  const Th = T();
  const scene = gltf.scene || gltf.scenes?.[0];
  if (!scene) throw new Error('no scene in the file');
  let skinned = 0; scene.traverse(o => { if (o.isSkinnedMesh) skinned++; });
  if (!skinned) throw new Error('no skinned mesh in the file — skin a mesh to the exported bones');
  const byName = new Map();
  scene.traverse(o => { const k = _norm(o.name); if (k && !byName.has(k)) byName.set(k, o); });
  const expected = ['wrist', 'forearm', ...HAND_FINGERS.flatMap(f => [0, 1, 2].map(i => _boneName(f, i)))];
  const missing = expected.filter(n => !byName.has(_norm(n)));
  // the template's own scale: wrist → middle knuckle, against the rig's anatomy
  let L0 = Number(gltf.parser?.json?.asset?.extras?.sbsHandScale) || 0;
  const w = byName.get('wrist'), m1 = byName.get(_norm(_boneName('middle', 0)));
  if (w && m1) {
    scene.updateMatrixWorld(true);
    const d = w.getWorldPosition(new Th.Vector3()).distanceTo(m1.getWorldPosition(new Th.Vector3()));
    const ref = _v(ANAT.fingers.middle.mcp).length();
    if (d > 1e-6 && ref > 0) L0 = d / ref;
  }
  if (!(L0 > 0)) L0 = 190;
  if (missing.length) console.warn('[hands] skin bones not found (those joints will not move it):', missing.join(', '));
  return { scene, L0, missing };
}

/** A deep clone of a scene with skinned meshes: fresh skeletons over the CLONED bones, cloned geometry. */
function _cloneSkinned(src) {
  const Th = T();
  const clone = src.clone(true);
  const a = [], b = [];
  src.traverse(o => a.push(o)); clone.traverse(o => b.push(o));
  const map = new Map(a.map((o, i) => [o, b[i]]));
  clone.traverse(o => {
    if (o.isMesh && o.geometry) o.geometry = o.geometry.clone();   // never mutate the template's (a left hand flips it)
    if (!o.isSkinnedMesh) return;
    const sk = o.skeleton;
    const bones = sk.bones.map(bn => map.get(bn) || bn);
    o.bind(new Th.Skeleton(bones, sk.boneInverses.map(m => m.clone())), o.bindMatrix.clone());
  });
  return clone;
}

/** Mirror a (skinned) hierarchy in X: every local transform conjugated, geometry flipped, winding reversed, bind matrices conjugated. */
function _mirrorX(root) {
  const Th = T();
  const S = new Th.Matrix4().makeScale(-1, 1, 1);
  root.traverse(o => {
    o.position.x *= -1;
    o.quaternion.set(o.quaternion.x, -o.quaternion.y, -o.quaternion.z, o.quaternion.w);
    if (o.isMesh && o.geometry) {
      const g = o.geometry;
      const pos = g.attributes.position, nor = g.attributes.normal;
      for (let i = 0; i < pos.count; i++) pos.setX(i, -pos.getX(i));
      pos.needsUpdate = true;
      if (nor) { for (let i = 0; i < nor.count; i++) nor.setX(i, -nor.getX(i)); nor.needsUpdate = true; }
      if (!g.index) { const n = pos.count; const ix = new (n > 65535 ? Uint32Array : Uint16Array)(n); for (let i = 0; i < n; i++) ix[i] = i; g.setIndex(new Th.BufferAttribute(ix, 1)); }
      const a = g.index.array;
      for (let i = 0; i + 2 < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
      g.index.needsUpdate = true;
      g.computeBoundingBox(); g.computeBoundingSphere();
    }
    if (o.isSkinnedMesh) {
      for (const m of o.skeleton.boneInverses) m.premultiply(S).multiply(S);
      o.bindMatrix.premultiply(S).multiply(S);
      o.bindMatrixInverse.copy(o.bindMatrix).invert();
    }
  });
}

/** The template under this hand's group: cloned, mirrored for a left hand, scaled, bones mapped to the joints. */
function _instantiateSkin(tpl, rig, group, left, L, mat, tag) {
  const Th = T();
  const root = _cloneSkinned(tpl.scene);
  root.name = 'skin';
  if (left) _mirrorX(root);
  root.traverse(o => {
    if (o.isMesh) { o.material = mat; o.frustumCulled = false; tag(o); o.userData.isHandSkin = true; }
  });
  const byName = new Map();
  root.traverse(o => { const k = _norm(o.name); if (k && !byName.has(k)) byName.set(k, o); });
  // the file's WRIST bone lands on the group's origin, upright: whatever the
  // exporter put above it (a Y-up root, an offset) is taken out here
  root.position.set(0, 0, 0); root.quaternion.identity(); root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);
  const wrist = byName.get('wrist');
  if (wrist) {
    const m = new Th.Matrix4().copy(wrist.matrixWorld).invert();
    m.decompose(root.position, root.quaternion, root.scale);
  }
  const s = L / tpl.L0;
  root.position.multiplyScalar(s); root.scale.multiplyScalar(s);
  group.add(root);

  _setRest(rig);   // the mapping is taken with both at rest
  const map = [];
  const pair = (joint, jointRest, name, extra = {}) => {
    const bone = byName.get(_norm(name)); if (!bone) return;
    const C = _quatIn(joint, group).invert().multiply(_quatIn(bone, group));
    map.push({ joint, bone, jointRest: jointRest.clone(), B0: bone.quaternion.clone(), S0: bone.scale.clone(), C, Ci: C.clone().invert(), ...extra });
  };
  for (const f of HAND_FINGERS) {
    const fg = rig.fingers[f];
    pair(fg.joints[0], fg.basis, _boneName(f, 0));
    pair(fg.joints[1], new Th.Quaternion(), _boneName(f, 1));
    pair(fg.joints[2], new Th.Quaternion(), _boneName(f, 2));
  }
  pair(rig.forearm, rig.forearm.quaternion, 'forearm', { stretch: true });

  // the capsules step aside (handles, tips, ghost stay)
  rig.palm.visible = false; rig.forearm.visible = false;
  for (const f of HAND_FINGERS) for (const b of rig.fingers[f].bones) b.visible = false;
  return { root, map };
}

/** After a solve / blend: every mapped bone takes its joint's rotation (and the forearm its stretch). */
function _syncSkin(rig) {
  const sk = rig?.skin; if (!sk) return;
  const Th = T();
  const d = new Th.Quaternion();
  for (const m of sk.map) {
    d.copy(m.jointRest).invert().multiply(m.joint.quaternion);            // Δ in the joint's rest frame
    m.bone.quaternion.copy(m.B0).multiply(m.Ci).multiply(d).multiply(m.C);  // the same Δ in the bone's frame
    if (m.stretch) m.bone.scale.set(m.S0.x, m.S0.y * m.joint.scale.y, m.S0.z);
  }
}
