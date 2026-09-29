/**
 * 🎥 CLIP FIT (V0.3.4.162) — the camera's near/far planes fitted to the VIEW
 * DEPTH of what is actually VISIBLE.
 *
 * Why: N8AO rebuilds positions and normals from the depth buffer, and depth
 * precision is set almost entirely by the near plane (a depth step at distance z
 * is ≈ z² / near × 2⁻²⁴). The old fit (scene.js, V0.3.0.14) used ONE bounding
 * sphere of the whole rootGroup plus the grid: Box3.expandByObject counts HIDDEN
 * parts too, and the 400-unit grid dwarfs most models. Its near was
 * max(far / 50000, (dist − r) · 0.5) — so the moment the dolly-zoom camera came
 * inside that inflated sphere (a lens around 12–37° for a typical framing) near
 * collapsed to far / 50000 and a depth step at the model grew to several pixels:
 * the AO painted bands and blotches, worst right where the camera crossed the
 * sphere, and near changed ~600× within ONE wheel notch — the "snap" (user,
 * 2026-09-29: 15.7° → 17.5°). The lens where it happened moved with the framing
 * and with what was hidden — his "values are never consistent".
 *
 * Here: every visible renderable (Mesh / Line / Points / Sprite, the whole scene,
 * hidden subtrees skipped) as a world-space oriented box, gathered on a throttle
 * (camera-independent); every frame the camera's view-depth range over the boxes
 * that are inside the frustum's four side planes:
 *   • a box wholly in front of the camera → its support-function depth range
 *     (exact for the box, cheap: three dot products);
 *   • a box that reaches past the camera plane (a floor plate at a wide lens, the
 *     grid) → the exact nearest depth of box ∩ frustum, by the vertices of that
 *     small convex polytope (6 box planes + 4 side planes);
 *   • a skinned mesh (the 🖐 hand: bind-pose bounds, bones move) → the box of its
 *     bones' world positions padded, joined to its bind box.
 * scene.js takes near = nearest × nearFactor (never below far / fitRatioCap) and
 * keeps far LOOSE (only near buys precision). Pure maths on THREE objects — no
 * state, no DOM. Test: npm run test:clip (brute-force sampled truth).
 */

/**
 * Every visible renderable under `roots` (hidden subtrees skipped, only what
 * `layers` renders, `exclude` subtrees left out). Camera-independent — cache it
 * and refresh on a throttle; the boxes themselves are re-read every frame.
 * @param {THREE.Object3D[]} roots
 * @param {THREE.Layers} [layers]
 * @param {THREE.Object3D[]} [exclude]
 * @returns {THREE.Object3D[]}
 */
export function listClipObjects(roots, layers = null, exclude = null) {
  const skip = new Set((exclude || []).filter(Boolean));
  const out = [];
  const walk = (o) => {
    if (!o.visible || skip.has(o)) return;
    if ((o.isMesh || o.isLine || o.isPoints || o.isSprite) && o.geometry && (!layers || o.layers.test(layers))) out.push(o);
    for (const ch of o.children) walk(ch);
  };
  for (const root of roots) if (root) walk(root);
  return out;
}

/** The world boxes of every visible renderable under `roots` (listClipObjects + clipBoxesOf). */
export function gatherClipBoxes(roots, layers = null, exclude = null) {
  return clipBoxesOf(listClipObjects(roots, layers, exclude));
}

/**
 * The world-space boxes of `objects`, from their CURRENT matrixWorld — cheap
 * enough for every frame (a moving part or a posed hand is never stale).
 * @param {THREE.Object3D[]} objects
 * @param {{data:Float64Array,count:number}} [reuse]  filled in place (no per-frame garbage)
 * @returns {{ data: Float64Array, count: number }}  stride 12: centre, 3 half-axes
 */
export function clipBoxesOf(objects, reuse = null) {
  const T = globalThis.THREE;
  const need = objects.length * 12;
  let out = reuse?.data;
  if (!out || out.length < need) out = new Float64Array(Math.max(need, 12 * 64));
  let n = 0;
  const m = _s.m, c = _s.c, ax = _s.ax, bb = _s.bb, p = _s.p;
  const pushBox = (center, a0, a1, a2) => {
    _fixAxes(a0, a1, a2);
    const o = n++ * 12;
    out[o] = center.x; out[o + 1] = center.y; out[o + 2] = center.z;
    out[o + 3] = a0.x; out[o + 4] = a0.y; out[o + 5] = a0.z;
    out[o + 6] = a1.x; out[o + 7] = a1.y; out[o + 8] = a1.z;
    out[o + 9] = a2.x; out[o + 10] = a2.y; out[o + 11] = a2.z;
  };
  const pushWorldAabb = (box) => {
    if (box.isEmpty()) return;
    box.getCenter(c);
    const hx = (box.max.x - box.min.x) / 2, hy = (box.max.y - box.min.y) / 2, hz = (box.max.z - box.min.z) / 2;
    pushBox(c, ax[0].set(hx, 0, 0), ax[1].set(0, hy, 0), ax[2].set(0, 0, hz));
  };
  for (const o of objects) {
    if (!o.visible) continue;   // hidden since the list was taken
    const g = o.geometry;
    if (!g) continue;
    if (!g.boundingBox) { try { g.computeBoundingBox(); } catch { continue; } }
    const lb = g.boundingBox;
    if (!lb || lb.isEmpty() || !isFinite(lb.min.x) || !isFinite(lb.max.x)) continue;
    if (o.isSkinnedMesh && o.skeleton?.bones?.length) {
      // Bind-pose bounds lie once the bones move: the bones' own box, padded by a
      // quarter of the bind box, joined to the bind box itself.
      bb.copy(lb).applyMatrix4(o.matrixWorld);
      const pad = bb.getSize(p).length() * 0.25;
      const bones = new T.Box3();
      for (const b of o.skeleton.bones) bones.expandByPoint(p.setFromMatrixPosition(b.matrixWorld));
      bones.expandByScalar(pad);
      bb.union(bones);
      pushWorldAabb(bb);
      continue;
    }
    if (o.isSprite) {   // faces the camera: a sphere's box
      bb.copy(lb).applyMatrix4(o.matrixWorld);
      const r = bb.getSize(p).length() / 2;
      bb.getCenter(c);
      pushBox(c, ax[0].set(r, 0, 0), ax[1].set(0, r, 0), ax[2].set(0, 0, r));
      continue;
    }
    // Oriented box: the local bbox through matrixWorld (rotation + scale kept).
    m.copy(o.matrixWorld);
    lb.getCenter(c).applyMatrix4(m);
    const e = m.elements;
    const hx = (lb.max.x - lb.min.x) / 2, hy = (lb.max.y - lb.min.y) / 2, hz = (lb.max.z - lb.min.z) / 2;
    ax[0].set(e[0] * hx, e[1] * hx, e[2] * hx);
    ax[1].set(e[4] * hy, e[5] * hy, e[6] * hy);
    ax[2].set(e[8] * hz, e[9] * hz, e[10] * hz);
    if (!isFinite(c.x) || !isFinite(ax[0].x) || !isFinite(ax[1].y) || !isFinite(ax[2].z)) continue;
    pushBox(c, ax[0], ax[1], ax[2]);
  }
  const res = reuse || {};
  res.data = out; res.count = n;
  return res;
}

// scratch for clipBoxesOf (made on first use — THREE is a global that loads first)
const _s = {
  get m()  { return this._m  || (this._m  = new globalThis.THREE.Matrix4()); },
  get c()  { return this._c  || (this._c  = new globalThis.THREE.Vector3()); },
  get p()  { return this._p  || (this._p  = new globalThis.THREE.Vector3()); },
  get bb() { return this._bb || (this._bb = new globalThis.THREE.Box3()); },
  get ax() { return this._ax || (this._ax = [new globalThis.THREE.Vector3(), new globalThis.THREE.Vector3(), new globalThis.THREE.Vector3()]); },
};

/**
 * Snap a plane distance onto a fixed 1/16-octave grid (≈4.4 % steps): the same
 * scene + camera always gives the same planes — bit-identical frames for the
 * render cache's holds and stitched segments — and the projection is rebuilt only
 * when a plane crosses a grid line. `up` rounds away (far), else toward zero (near),
 * so snapping never clips.
 */
export function snapPlane(v, up = false) {
  if (!(v > 0) || !isFinite(v)) return v;
  const l = Math.log2(v) * 16;
  return Math.pow(2, (up ? Math.ceil(l) : Math.floor(l)) / 16);
}

/**
 * The four side planes of a camera's frustum in world space, as [nx,ny,nz,d]
 * with n·p + d ≥ 0 inside. Independent of near/far (so safe to take from the
 * camera whose near/far we are about to set).
 */
export function sidePlanes(camera) {
  const T = globalThis.THREE;
  camera.updateMatrixWorld();
  const pm = new T.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const f = new T.Frustum().setFromProjectionMatrix(pm);
  // three's order: 0 right, 1 left, 2 bottom, 3 top, 4 far, 5 near
  return [0, 1, 2, 3].map(i => { const pl = f.planes[i]; return [pl.normal.x, pl.normal.y, pl.normal.z, pl.constant]; });
}

/**
 * The view-depth range of the boxes a camera can see.
 * @returns {{ nearest:number, farthest:number, visible:number, straddling:number } | null}
 */
export function viewDepthRange(camera, boxes) {
  const cam = camera.matrixWorld.elements;
  const px = cam[12], py = cam[13], pz = cam[14];
  let fx = -cam[8], fy = -cam[9], fz = -cam[10];            // camera −Z in world
  const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  const planes = sidePlanes(camera);
  const d = boxes.data;
  let nearest = Infinity, farthest = -Infinity, visible = 0, straddling = 0;
  for (let i = 0; i < boxes.count; i++) {
    const o = i * 12;
    const cx = d[o], cy = d[o + 1], cz = d[o + 2];
    // outside any side plane? (box–plane test with the box's support radius)
    let out = false;
    for (let k = 0; k < 4 && !out; k++) {
      const [nx, ny, nz, w] = planes[k];
      const s = Math.abs(nx * d[o + 3] + ny * d[o + 4] + nz * d[o + 5])
              + Math.abs(nx * d[o + 6] + ny * d[o + 7] + nz * d[o + 8])
              + Math.abs(nx * d[o + 9] + ny * d[o + 10] + nz * d[o + 11]);
      if (nx * cx + ny * cy + nz * cz + w + s < 0) out = true;
    }
    if (out) continue;
    const zc = fx * (cx - px) + fy * (cy - py) + fz * (cz - pz);
    const s = Math.abs(fx * d[o + 3] + fy * d[o + 4] + fz * d[o + 5])
            + Math.abs(fx * d[o + 6] + fy * d[o + 7] + fz * d[o + 8])
            + Math.abs(fx * d[o + 9] + fy * d[o + 10] + fz * d[o + 11]);
    const zmax = zc + s;
    if (zmax <= 0) continue;                                   // wholly behind the camera
    let zmin = zc - s;
    if (zmin <= 0) {                                           // reaches past the camera plane
      zmin = _nearestInFrustum(d, o, planes, px, py, pz, fx, fy, fz);
      if (zmin == null) continue;                              // box ∩ frustum is empty
      straddling++;
    }
    visible++;
    if (zmin < nearest) nearest = zmin;
    if (zmax > farthest) farthest = zmax;
  }
  return visible ? { nearest, farthest, visible, straddling } : null;
}

/**
 * The near/far to use.
 * @param {{nearest:number, farthest:number}|null} range  from viewDepthRange
 * @param {{nearFactor?:number, farFactor?:number, ratioCap?:number}} [cfg]
 * @returns {{near:number, far:number}|null}
 */
export function clipPlanesFor(range, cfg = {}) {
  if (!range || !(range.farthest > 0)) return null;
  const nearFactor = cfg.nearFactor ?? 0.5, farFactor = cfg.farFactor ?? 1.5, ratioCap = cfg.ratioCap ?? 50000;
  const far = range.farthest * farFactor;
  const near = Math.max(far / ratioCap, Math.max(0, range.nearest) * nearFactor);
  return (near > 0 && far > near) ? { near, far } : null;
}

/**
 * The nearest view depth of (oriented box ∩ the four side half-spaces): the
 * minimum of a linear function over a convex polytope sits on one of its
 * vertices, and each vertex is where three of the ten planes meet. null = empty.
 */
function _nearestInFrustum(d, o, sides, px, py, pz, fx, fy, fz) {
  const cx = d[o], cy = d[o + 1], cz = d[o + 2];
  const P = [];   // [nx,ny,nz,k]: n·p ≥ k   (axes are never zero — _fixAxes)
  for (let a = 0; a < 3; a++) {
    const ux = d[o + 3 + a * 3], uy = d[o + 4 + a * 3], uz = d[o + 5 + a * 3];
    const L = Math.hypot(ux, uy, uz);
    const nx = ux / L, ny = uy / L, nz = uz / L, cn = nx * cx + ny * cy + nz * cz;
    P.push([nx, ny, nz, cn - L], [-nx, -ny, -nz, -(cn + L)]);
  }
  for (const [nx, ny, nz, w] of sides) P.push([nx, ny, nz, -w]);
  const scale = Math.abs(cx - px) + Math.abs(cy - py) + Math.abs(cz - pz)
              + lensSum(d, o) + 1;
  const tol = 1e-7 * scale;
  let best = Infinity;
  const n = P.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
    const A = P[i], B = P[j], C = P[k];
    // p = (kA (B×C) + kB (C×A) + kC (A×B)) / (A·(B×C))
    const bcx = B[1] * C[2] - B[2] * C[1], bcy = B[2] * C[0] - B[0] * C[2], bcz = B[0] * C[1] - B[1] * C[0];
    const det = A[0] * bcx + A[1] * bcy + A[2] * bcz;
    if (Math.abs(det) < 1e-12) continue;
    const cax = C[1] * A[2] - C[2] * A[1], cay = C[2] * A[0] - C[0] * A[2], caz = C[0] * A[1] - C[1] * A[0];
    const abx = A[1] * B[2] - A[2] * B[1], aby = A[2] * B[0] - A[0] * B[2], abz = A[0] * B[1] - A[1] * B[0];
    const x = (A[3] * bcx + B[3] * cax + C[3] * abx) / det;
    const y = (A[3] * bcy + B[3] * cay + C[3] * aby) / det;
    const z = (A[3] * bcz + B[3] * caz + C[3] * abz) / det;
    let ok = true;
    for (let q = 0; q < n && ok; q++) { const Q = P[q]; if (Q[0] * x + Q[1] * y + Q[2] * z < Q[3] - tol) ok = false; }
    if (!ok) continue;
    const depth = fx * (x - px) + fy * (y - py) + fz * (z - pz);
    if (depth < best) best = depth;
  }
  return best === Infinity ? null : Math.max(0, best);
}

/**
 * A box with a zero axis (the flat grid, a straight line, a point) gets a real
 * basis: each missing axis becomes a hair-thin one perpendicular to the others,
 * so every box has six proper planes.
 */
function _fixAxes(a0, a1, a2) {
  const ax = [a0, a1, a2];
  const big = Math.max(a0.length(), a1.length(), a2.length());
  const thin = Math.max(big, 1) * 1e-6;
  const ok = ax.map(v => v.length() > big * 1e-9 && v.length() > 0);
  const n = ok.filter(Boolean).length;
  if (n === 3) return;
  const T = globalThis.THREE;
  if (n === 0) { a0.set(thin, 0, 0); a1.set(0, thin, 0); a2.set(0, 0, thin); return; }
  if (n === 1) {
    const u = ax[ok.indexOf(true)];
    const helper = Math.abs(u.x) < 0.9 * u.length() ? new T.Vector3(1, 0, 0) : new T.Vector3(0, 1, 0);
    const v = new T.Vector3().crossVectors(u, helper).normalize();
    const w = new T.Vector3().crossVectors(u, v).normalize();
    const bad = ax.filter((_, i) => !ok[i]);
    bad[0].copy(v).multiplyScalar(thin); bad[1].copy(w).multiplyScalar(thin);
    return;
  }
  const [u, v] = ax.filter((_, i) => ok[i]);
  ax[ok.indexOf(false)].crossVectors(u, v).normalize().multiplyScalar(thin);
}

function lensSum(d, o) {
  let s = 0;
  for (let a = 0; a < 3; a++) s += Math.hypot(d[o + 3 + a * 3], d[o + 4 + a * 3], d[o + 5 + a * 3]);
  return s;
}
