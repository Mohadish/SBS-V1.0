/**
 * SBS Step Browser — Transform Math
 * =====================================
 * All quaternion/vector/pivot arithmetic for the scene tree.
 *
 * Key model (matches the POC exactly):
 *
 *   A node's final LOCAL transform is:
 *     position  = baseLocalPosition  + (moveEnabled   ? localOffset       : 0)
 *     quaternion= baseLocalQuaternion * (rotateEnabled ? localQuaternion   : identity)
 *     scale     = baseLocalScale   (unchanged by user transforms)
 *
 *   The "pivot" system only affects WHERE the gizmo appears, not the
 *   actual object transform stored in Three.js.
 *
 * Pure functions at the top work on plain arrays [x,y,z] / [x,y,z,w].
 * Functions that accept/return Three.js objects are clearly named with
 * "toThree" / "fromThree" / "apply" to indicate side-effects.
 *
 * Three.js is a global script (window.THREE) — referenced directly.
 */

// ═══════════════════════════════════════════════════════════════════════════
//  ARRAY CONSTANTS & GUARDS
// ═══════════════════════════════════════════════════════════════════════════

export const IDENTITY_QUATERNION = Object.freeze([0, 0, 0, 1]);
export const ZERO_VECTOR         = Object.freeze([0, 0, 0]);
export const UNIT_SCALE          = Object.freeze([1, 1, 1]);

/**
 * True if every component is near zero.
 * @param {number[]} arr
 */
export function isNearZero(arr) {
  if (!Array.isArray(arr)) return true;
  return arr.every(v => Math.abs(Number(v) || 0) < 1e-6);
}

/**
 * True if the quaternion is the identity [0,0,0,1].
 * @param {number[]} arr
 */
export function isIdentityQuaternion(arr) {
  if (!Array.isArray(arr) || arr.length < 4) return true;
  const [x, y, z, w] = arr;
  return (
    Math.abs(x || 0) < 1e-6 &&
    Math.abs(y || 0) < 1e-6 &&
    Math.abs(z || 0) < 1e-6 &&
    Math.abs((w ?? 1) - 1) < 1e-6
  );
}

/**
 * Clamp a transform scalar to a safe range (max ±1000 units).
 */
export function clampScalar(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-1000, Math.min(1000, v));
}

/**
 * Round a transform scalar to 3 decimal places then clamp.
 */
export function sanitizeScalar(v) {
  return clampScalar(Math.round((Number(v) || 0) * 1000) / 1000);
}

/**
 * Round/clamp a position or offset array.
 * @param {number[]} arr
 * @returns {number[]}
 */
export function sanitizeVector(arr) {
  const [x, y, z] = arr ?? [0, 0, 0];
  return [sanitizeScalar(x), sanitizeScalar(y), sanitizeScalar(z)];
}

/**
 * Normalise a quaternion array to [x,y,z,w] with unit length.
 * @param {number[]} arr
 * @returns {number[]}
 */
export function normalizeQuaternion(arr) {
  const [x = 0, y = 0, z = 0, w = 1] = arr ?? [];
  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  if (len < 1e-10) return [0, 0, 0, 1];
  return [x / len, y / len, z / len, w / len];
}

/**
 * Multiply two quaternions (both as [x,y,z,w] arrays).
 * Result = a * b
 */
export function multiplyQuaternions(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/**
 * Invert a unit quaternion array (conjugate for unit quaternions).
 */
export function invertQuaternion([x, y, z, w]) {
  return [-x, -y, -z, w];
}

/**
 * Convert a quaternion array to Euler degrees {x, y, z} (XYZ order).
 * Uses Three.js for precision.
 */
export function quaternionToEulerDeg(arr) {
  const q = new THREE.Quaternion(...normalizeQuaternion(arr));
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return {
    x: THREE.MathUtils.radToDeg(e.x),
    y: THREE.MathUtils.radToDeg(e.y),
    z: THREE.MathUtils.radToDeg(e.z),
  };
}

/**
 * Convert Euler degrees {x, y, z} to a quaternion array.
 */
export function eulerDegToQuaternion({ x = 0, y = 0, z = 0 } = {}) {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(x),
      THREE.MathUtils.degToRad(y),
      THREE.MathUtils.degToRad(z),
      'XYZ',
    ),
  );
  return [q.x, q.y, q.z, q.w];
}

/**
 * Quaternion from quarter-turn steps [nx, ny, nz] where each step = 90°.
 */
export function quaternionFromQuarterTurns([nx, ny, nz] = [0, 0, 0]) {
  const qx = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(1, 0, 0), (nx || 0) * Math.PI / 2);
  const qy = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), (ny || 0) * Math.PI / 2);
  const qz = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 0, 1), (nz || 0) * Math.PI / 2);
  const result = qx.multiply(qy).multiply(qz).normalize();
  return [result.x, result.y, result.z, result.w];
}

/**
 * Derive quarter-turn steps from a quaternion (rounds to nearest 90°).
 */
export function quarterTurnsFromQuaternion(arr) {
  const q = new THREE.Quaternion(...normalizeQuaternion(arr));
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return [
    Math.round(e.x / (Math.PI / 2)),
    Math.round(e.y / (Math.PI / 2)),
    Math.round(e.z / (Math.PI / 2)),
  ];
}


// ═══════════════════════════════════════════════════════════════════════════
//  NODE TRANSFORM DEFAULTS
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Ensure a node has all required transform fields with valid defaults.
 * Safe to call multiple times — only fills in missing/invalid fields.
 * @param {TreeNode} node
 */
export function ensureTransformDefaults(node) {
  if (!node) return;

  if (!Array.isArray(node.localOffset))
    node.localOffset = [0, 0, 0];

  if (!Array.isArray(node.localQuaternion) || node.localQuaternion.length < 4)
    node.localQuaternion = Array.isArray(node.orientationSteps)
      ? quaternionFromQuarterTurns(node.orientationSteps)
      : [0, 0, 0, 1];

  if (!Array.isArray(node.orientationSteps))
    node.orientationSteps = [0, 0, 0];

  if (!Array.isArray(node.baseLocalPosition))
    node.baseLocalPosition = [0, 0, 0];

  if (!Array.isArray(node.baseLocalQuaternion) || node.baseLocalQuaternion.length < 4)
    node.baseLocalQuaternion = [0, 0, 0, 1];

  if (!Array.isArray(node.baseLocalScale))
    node.baseLocalScale = [1, 1, 1];

  // Original-base backup. Seeded from current baseLocal* if missing —
  // keeps "Reset to original" working even on legacy projects that
  // pre-date Model-Source-Transform. Never overwritten once set.
  if (!Array.isArray(node.originalBaseLocalPosition))
    node.originalBaseLocalPosition = [...node.baseLocalPosition];
  if (!Array.isArray(node.originalBaseLocalQuaternion) || node.originalBaseLocalQuaternion.length < 4)
    node.originalBaseLocalQuaternion = [...node.baseLocalQuaternion];
  if (!Array.isArray(node.originalBaseLocalScale))
    node.originalBaseLocalScale = [...node.baseLocalScale];

  if (!Array.isArray(node.pivotLocalOffset))
    node.pivotLocalOffset = [0, 0, 0];

  if (!Array.isArray(node.pivotLocalQuaternion) || node.pivotLocalQuaternion.length < 4)
    node.pivotLocalQuaternion = [0, 0, 0, 1];

  if (typeof node.moveEnabled   !== 'boolean') node.moveEnabled   = true;
  if (typeof node.rotateEnabled !== 'boolean') node.rotateEnabled = true;
  if (typeof node.pivotEnabled  !== 'boolean') node.pivotEnabled  = true;
}

/**
 * True if this node type supports user transforms.
 * Only 'model' and 'folder' nodes have transforms (not 'mesh' or 'scene').
 */
export function isTransformNode(node) {
  return node?.type === 'model' || node?.type === 'folder';
}


// ═══════════════════════════════════════════════════════════════════════════
//  COMPUTED LOCAL TRANSFORM
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Get the stored delta quaternion (independent of base orientation).
 */
export function getStoredQuaternion(node) {
  ensureTransformDefaults(node);
  return normalizeQuaternion(node.localQuaternion);
}

/**
 * Set the stored delta quaternion (updates orientationSteps for display).
 */
export function setStoredQuaternion(node, arr) {
  node.localQuaternion = normalizeQuaternion(arr);
  node.orientationSteps = quarterTurnsFromQuaternion(node.localQuaternion);
}

/**
 * The TOTAL local quaternion = delta * base (if rotateEnabled).
 *
 * Composition order: BASE applied first (in the model's own local
 * frame), DELTA applied on top. So a "model source" rotation acts as
 * a rest-pose orientation — rotating a flat-imported clock 90° around
 * its Z axis genuinely makes "12" point to "9" inside every step's
 * stored per-step rotation. base × delta would have applied the
 * source AFTER the per-step in world space, which reads as a global
 * pivot translation rather than an intrinsic re-orientation.
 *
 * Backward-compatible: pre-Model-Source-Transform projects all have
 * baseLocalQuaternion = identity (set by storeBaseTransformFromObject3D
 * at import for top-level nodes that have no inherent rotation), so
 * delta × identity == identity × delta == delta. Existing animations
 * are untouched.
 *
 * Returns array [x,y,z,w].
 */
export function getTotalLocalQuaternion(node) {
  ensureTransformDefaults(node);
  const base  = node.baseLocalQuaternion;
  const delta = node.rotateEnabled === false ? [0, 0, 0, 1] : node.localQuaternion;
  return normalizeQuaternion(multiplyQuaternions(delta, base));
}

/**
 * The COMPUTED local position = base + offset (if moveEnabled).
 * Returns array [x,y,z].
 */
export function getComputedLocalPosition(node) {
  ensureTransformDefaults(node);
  const base = node.baseLocalPosition;
  if (node.moveEnabled === false) return [...base];
  const [bx, by, bz] = base;
  const [ox, oy, oz] = node.localOffset;
  return [bx + ox, by + oy, bz + oz];
}

/**
 * The effective pivot position in local space (zero if pivotEnabled=false).
 */
export function getAppliedPivotOffset(node) {
  ensureTransformDefaults(node);
  if (node.pivotEnabled === false) return [0, 0, 0];
  return [...node.pivotLocalOffset];
}

/**
 * The effective pivot orientation quaternion (identity if pivotEnabled=false).
 */
export function getAppliedPivotQuaternion(node) {
  ensureTransformDefaults(node);
  if (node.pivotEnabled === false) return [0, 0, 0, 1];
  return normalizeQuaternion(node.pivotLocalQuaternion);
}


// ═══════════════════════════════════════════════════════════════════════════
//  APPLY TO THREE.JS OBJECT3D
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Apply a node's computed transform to its Three.js Object3D.
 * Call after any change to localOffset / localQuaternion / base fields.
 *
 * @param {TreeNode}       node
 * @param {THREE.Object3D} object3d
 * @param {boolean}        [updateWorld]  call updateMatrixWorld after (default true)
 */
export function applyNodeTransformToObject3D(node, object3d, updateWorld = true) {
  if (!node || !object3d || !isTransformNode(node)) return;
  ensureTransformDefaults(node);

  const pos   = getComputedLocalPosition(node);
  const quat  = getTotalLocalQuaternion(node);
  const scale = node.baseLocalScale ?? [1, 1, 1];

  object3d.position.set(...pos);
  object3d.quaternion.set(...quat);
  object3d.scale.set(...scale);

  if (updateWorld) object3d.updateMatrixWorld(true);
}

// ═══════════════════════════════════════════════════════════════════════════
//  PIVOT — virtual gizmo placement + rotation-around-pivot solver
// ═══════════════════════════════════════════════════════════════════════════
//
// The pivot is purely virtual — `object3d.position` / `quaternion` NEVER
// reflect it. We only use it to:
//   1. position the gizmo (so the user sees a "rotate around here" anchor),
//   2. back-solve `localOffset` when rotating, so the pivot's WORLD point
//      stays fixed during the gesture (a door rotates around its hinge,
//      not its origin).
//
// Cable code, raycasting, exports — all see the un-pivoted pose. Confirmed
// in v0.266; intentional and preserved here.

/**
 * Rotate a vector [x,y,z] by a quaternion [x,y,z,w]. Returns a new array.
 * Uses Three.js for the heavy lifting so we don't reimplement the formula
 * (which we'd inevitably get wrong on edge cases).
 */
export function applyQuaternionToVector(q, v) {
  const Q = new THREE.Quaternion(...normalizeQuaternion(q));
  const V = new THREE.Vector3(...(v ?? [0, 0, 0]));
  V.applyQuaternion(Q);
  return [V.x, V.y, V.z];
}

/**
 * World-space position of a node's pivot point. Returns a fresh
 * THREE.Vector3 — caller can copy into the gizmo group.
 *
 * pivotLocalOffset is in OBJECT-LOCAL space; world pivot is the result
 * of running it through obj3d.localToWorld().
 */
export function getPivotWorldPosition(node, object3d) {
  ensureTransformDefaults(node);
  const T = window.THREE;
  const local = getAppliedPivotOffset(node);   // zeroes out when pivotEnabled=false
  const v = new T.Vector3(local[0], local[1], local[2]);
  if (object3d?.localToWorld) {
    object3d.updateMatrixWorld?.(true);
    object3d.localToWorld(v);
  }
  return v;
}

/**
 * World-space orientation of the pivot frame.
 *
 *   pivot_world_q = parent_world_q × localQuaternion × pivotLocalQuaternion
 *
 * Note that baseLocalQuaternion (the model-source rotation) is
 * intentionally STRIPPED from this calculation. The pivot frame is
 * the user's "local translate / local rotate" frame — if the source
 * transform pulled the pivot with it, applying a source rotation
 * would silently re-orient the gizmo axes and "local translate X"
 * would no longer point where the user expects. Stripping base keeps
 * the pivot anchored to the per-step rotation only.
 *
 * Math: object's world = parent × (delta × base). World × inv(base) =
 * parent × delta. Then × pivotLocalQuaternion. Pre-feature where
 * base = identity, inv(base) = identity → behaviour unchanged.
 */
export function getPivotWorldQuaternion(node, object3d) {
  ensureTransformDefaults(node);
  const T = window.THREE;
  const out = new T.Quaternion();
  if (object3d?.getWorldQuaternion) {
    object3d.updateMatrixWorld?.(true);
    object3d.getWorldQuaternion(out);
    // Strip the source-base contribution so source edits don't
    // re-orient the gizmo / pivot frame.
    const baseInv = invertQuaternion(node.baseLocalQuaternion);
    out.multiply(new T.Quaternion(baseInv[0], baseInv[1], baseInv[2], baseInv[3]));
  }
  const pivotQ = getAppliedPivotQuaternion(node);   // identity when disabled
  out.multiply(new T.Quaternion(pivotQ[0], pivotQ[1], pivotQ[2], pivotQ[3]));
  return out;
}

/**
 * Set a node's stored delta quaternion AND back-solve localOffset so
 * the pivot's WORLD point stays where it was BEFORE the rotation.
 *
 * Math (matches POC v0.266):
 *   pivotInParent_pre = localPos + (pivot ⊗ totalQ_old)
 *   newTotalQ        = baseQ * newDeltaQ
 *   newLocalPos      = pivotInParent_pre - (pivot ⊗ newTotalQ)
 *   localOffset      = newLocalPos - basePos
 *
 * Caller is still responsible for applyNodeTransformToObject3D() after.
 *
 * No-op when pivot is disabled or zero — falls through to plain
 * setStoredQuaternion.
 */
export function setNodeLocalRotationPreservePivot(node, newDeltaQ) {
  ensureTransformDefaults(node);
  const pivot = getAppliedPivotOffset(node);
  if (isNearZero(pivot)) {
    // No effective pivot — plain rotation, position untouched.
    setStoredQuaternion(node, newDeltaQ);
    return;
  }

  // Capture pre-rotation pivot position in parent-local space.
  const localPos      = getComputedLocalPosition(node);
  const oldTotalQ     = getTotalLocalQuaternion(node);
  const pivotPreRot   = applyQuaternionToVector(oldTotalQ, pivot);
  const pivotInParent = [
    localPos[0] + pivotPreRot[0],
    localPos[1] + pivotPreRot[1],
    localPos[2] + pivotPreRot[2],
  ];

  // Apply the new orientation, then back-solve localOffset. Same
  // delta × base order as getTotalLocalQuaternion — see the long
  // comment there for why.
  const newDelta    = normalizeQuaternion(newDeltaQ);
  const newTotalQ   = normalizeQuaternion(multiplyQuaternions(newDelta, node.baseLocalQuaternion));
  const pivotPostRot = applyQuaternionToVector(newTotalQ, pivot);
  const newLocalPos = [
    pivotInParent[0] - pivotPostRot[0],
    pivotInParent[1] - pivotPostRot[1],
    pivotInParent[2] - pivotPostRot[2],
  ];
  const baseLocal = node.baseLocalPosition;
  node.localOffset = [
    newLocalPos[0] - baseLocal[0],
    newLocalPos[1] - baseLocal[1],
    newLocalPos[2] - baseLocal[2],
  ];
  setStoredQuaternion(node, newDelta);
  node.moveEnabled   = true;
  node.rotateEnabled = true;
}


/**
 * Apply transforms to all transform-capable nodes in the tree.
 * Pass a Map<nodeId, Object3D> that maps data nodes to their Three.js objects.
 *
 * @param {TreeNode}                 root
 * @param {Map<string, THREE.Object3D>} object3dById
 */
export function applyAllTransforms(root, object3dById) {
  if (!root) return;
  if (isTransformNode(root)) {
    const obj = object3dById.get(root.id);
    if (obj) applyNodeTransformToObject3D(root, obj);
  }
  root.children.forEach(child => applyAllTransforms(child, object3dById));
}

/**
 * Apply visibility of all nodes recursively.
 * A node is visible only if it AND all ancestors have localVisible=true.
 *
 * @param {TreeNode}                 root
 * @param {Map<string, THREE.Object3D>} object3dById
 * @param {boolean}                  [inheritedVisible]
 */
export function applyAllVisibility(root, object3dById, inheritedVisible = true) {
  if (!root) return;
  const effective = inheritedVisible && root.localVisible;
  const obj = object3dById.get(root.id);
  if (obj) obj.visible = effective;
  root.children.forEach(c => applyAllVisibility(c, object3dById, effective));
}

/**
 * Store a Three.js mesh's current local transform as the BASE transform
 * on the data node. Called once after a model is imported.
 *
 * @param {TreeNode}    node
 * @param {THREE.Object3D} object3d
 */
export function storeBaseTransformFromObject3D(node, object3d) {
  if (!node || !object3d) return;
  const p = object3d.position;
  const q = object3d.quaternion;
  const s = object3d.scale;

  node.baseLocalPosition  = [sanitizeScalar(p.x), sanitizeScalar(p.y), sanitizeScalar(p.z)];
  node.baseLocalQuaternion = normalizeQuaternion([q.x, q.y, q.z, q.w]);
  node.baseLocalScale     = [s.x, s.y, s.z];

  // Original-base backup — captured ONCE at import. Subsequent
  // user edits via Model Source Transform overwrite baseLocal*
  // but never touch originalBaseLocal*, so "Reset to original"
  // returns to the import-time pose.
  node.originalBaseLocalPosition   = [...node.baseLocalPosition];
  node.originalBaseLocalQuaternion = [...node.baseLocalQuaternion];
  node.originalBaseLocalScale      = [...node.baseLocalScale];

  // Reset user deltas
  node.localOffset     = [0, 0, 0];
  node.localQuaternion = [0, 0, 0, 1];
  node.orientationSteps = [0, 0, 0];
}


// ═══════════════════════════════════════════════════════════════════════════
//  TRANSFORM SNAPSHOTS
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Capture a node's complete transform state into a plain object.
 * This is what gets stored in Step.snapshot.transforms[nodeId].
 *
 * @param {TreeNode} node
 * @returns {object}
 */
export function captureTransformSnapshot(node) {
  ensureTransformDefaults(node);
  return {
    localOffset:         [...node.localOffset],
    localQuaternion:     [...node.localQuaternion],
    orientationSteps:    [...node.orientationSteps],
    pivotLocalOffset:    [...node.pivotLocalOffset],
    pivotLocalQuaternion:[...node.pivotLocalQuaternion],
    moveEnabled:         node.moveEnabled !== false,
    rotateEnabled:       node.rotateEnabled !== false,
    pivotEnabled:        node.pivotEnabled !== false,
  };
}

/**
 * Apply a transform snapshot back to a node (mutation).
 * @param {TreeNode} node
 * @param {object}   snap
 */
export function applyTransformSnapshot(node, snap) {
  if (!node || !snap) return;
  node.localOffset          = [...(snap.localOffset         ?? [0, 0, 0])];
  node.localQuaternion      = [...(snap.localQuaternion     ?? [0, 0, 0, 1])];
  node.orientationSteps     = [...(snap.orientationSteps    ?? [0, 0, 0])];
  node.pivotLocalOffset     = [...(snap.pivotLocalOffset    ?? [0, 0, 0])];
  node.pivotLocalQuaternion = [...(snap.pivotLocalQuaternion?? [0, 0, 0, 1])];
  node.moveEnabled          = snap.moveEnabled   !== false;
  node.rotateEnabled        = snap.rotateEnabled !== false;
  node.pivotEnabled         = snap.pivotEnabled  !== false;
}

/**
 * Capture transforms of ALL nodes that support transforms.
 * Returns { [nodeId]: TransformSnapshot }
 *
 * @param {TreeNode} root
 * @returns {Object}
 */
export function captureAllTransforms(root) {
  const transforms = {};
  const visit = (node) => {
    if (isTransformNode(node)) {
      transforms[node.id] = captureTransformSnapshot(node);
    }
    node.children.forEach(visit);
  };
  if (root) visit(root);
  return transforms;
}

/**
 * Apply a transforms snapshot to all matching nodes in a Map.
 * Nodes not present in the snapshot are left unchanged.
 *
 * @param {Map<string, TreeNode>} nodeById
 * @param {object}                transforms  { [nodeId]: TransformSnapshot }
 */
export function applyAllTransformSnapshots(nodeById, transforms) {
  for (const [id, snap] of Object.entries(transforms)) {
    const node = nodeById.get(id);
    if (node && isTransformNode(node)) {
      applyTransformSnapshot(node, snap);
    }
  }
}

/**
 * Diff two transform snapshots — return a list of nodeIds that changed.
 * Used to decide which nodes to animate vs skip during step transitions.
 *
 * @param {object} fromTransforms
 * @param {object} toTransforms
 * @returns {string[]}  changed node IDs
 */
export function diffTransforms(fromTransforms, toTransforms) {
  const changed = [];
  const allIds = new Set([
    ...Object.keys(fromTransforms ?? {}),
    ...Object.keys(toTransforms ?? {}),
  ]);

  for (const id of allIds) {
    const from = fromTransforms?.[id];
    const to   = toTransforms?.[id];
    if (!from || !to) { changed.push(id); continue; }

    // Quick check: if any localOffset or quaternion component differs
    const posChanged = (from.localOffset ?? []).some(
      (v, i) => Math.abs(v - (to.localOffset?.[i] ?? 0)) > 1e-5,
    );
    const rotChanged = (from.localQuaternion ?? []).some(
      (v, i) => Math.abs(v - (to.localQuaternion?.[i] ?? (i === 3 ? 1 : 0))) > 1e-5,
    );
    if (posChanged || rotChanged) changed.push(id);
  }
  return changed;
}

/**
 * Linearly interpolate (lerp) between two position arrays.
 * @param {number[]} from  [x,y,z]
 * @param {number[]} to    [x,y,z]
 * @param {number}   t     0–1
 * @returns {number[]}
 */
export function lerpVec3(from, to, t) {
  return [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ];
}

/**
 * Spherically interpolate (slerp) between two quaternion arrays.
 * @param {number[]} from  [x,y,z,w]
 * @param {number[]} to    [x,y,z,w]
 * @param {number}   t     0–1
 * @returns {number[]}
 */
export function slerpQuaternion(from, to, t) {
  const q = new THREE.Quaternion(...normalizeQuaternion(from))
    .slerp(new THREE.Quaternion(...normalizeQuaternion(to)), t);
  return [q.x, q.y, q.z, q.w];
}

/**
 * Interpolate a TransformSnapshot toward another by alpha.
 * Returns a new snapshot — does not mutate inputs.
 *
 * @param {object} from   TransformSnapshot
 * @param {object} to     TransformSnapshot
 * @param {number} alpha  0–1
 * @returns {object}
 */
export function interpolateTransformSnapshot(from, to, alpha) {
  // Bake enabled flags into effective deltas BEFORE lerping.
  // A red (muted) axis contributes zero delta — its data is preserved but not applied.
  // This way we always interpolate between effective world contributions,
  // not between raw stored values that may silently be ignored.
  // moveEnabled/rotateEnabled/pivotEnabled are restored to the target state
  // by applySnapshotInstant at the end of the animation.
  const fromOffset  = from.moveEnabled   !== false ? (from.localOffset            ?? [0,0,0])   : [0,0,0];
  const toOffset    = to.moveEnabled     !== false ? (to.localOffset              ?? [0,0,0])   : [0,0,0];
  const fromQuat    = from.rotateEnabled !== false ? (from.localQuaternion        ?? [0,0,0,1]) : [0,0,0,1];
  const toQuat      = to.rotateEnabled   !== false ? (to.localQuaternion          ?? [0,0,0,1]) : [0,0,0,1];
  const fromPivOff  = from.pivotEnabled  !== false ? (from.pivotLocalOffset       ?? [0,0,0])   : [0,0,0];
  const toPivOff    = to.pivotEnabled    !== false ? (to.pivotLocalOffset         ?? [0,0,0])   : [0,0,0];
  const fromPivQ    = from.pivotEnabled  !== false ? (from.pivotLocalQuaternion   ?? [0,0,0,1]) : [0,0,0,1];
  const toPivQ      = to.pivotEnabled    !== false ? (to.pivotLocalQuaternion     ?? [0,0,0,1]) : [0,0,0,1];

  return {
    localOffset:          lerpVec3(fromOffset, toOffset, alpha),
    localQuaternion:      slerpQuaternion(fromQuat, toQuat, alpha),
    orientationSteps:     to.orientationSteps ?? [0,0,0],  // discrete
    pivotLocalOffset:     lerpVec3(fromPivOff, toPivOff, alpha),
    pivotLocalQuaternion: slerpQuaternion(fromPivQ, toPivQ, alpha),
    // Always enabled during interpolation — effective values already baked in.
    moveEnabled:   true,
    rotateEnabled: true,
    pivotEnabled:  true,
  };
}
