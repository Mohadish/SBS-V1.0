// The spotlight maths, with the app's own three.js: place → describe → place is a fixed point,
// the same descriptor gives the same picture at another lens, the dolly keeps the screen place.
const fs = require('fs'), vm = require('vm');
globalThis.window = globalThis; globalThis.self = globalThis;
vm.runInThisContext(fs.readFileSync('E:/SBS-dev-V0.3.1/sbs-app/vendor/three.min.js', 'utf8'), { filename: 'three.min.js' });
const T = globalThis.THREE;
if (!T) { console.log('no THREE'); process.exit(1); }

// — the functions, copied verbatim from src/systems/spotlight.js (kept in step by hand: if this fails after an edit there, re-copy) —
const kOf = (f) => Math.tan(Math.min(Math.max(Number(f), 0), 179.9) * Math.PI / 180 / 2);
const frameHeight = (d, f) => 2 * Math.abs(d) * kOf(f);
const distForFrame = (h, f) => Math.abs(h) / (2 * kOf(f));
const MIN_S = 0.02, MAX_S = 4, MIN_R = 1e-4;
const _arr = (q) => [q.x, q.y, q.z, q.w];
function _frameOf(cs, aspect = 16 / 9) {
  const q = new T.Quaternion(...cs.quaternion).normalize();
  return { eye: new T.Vector3(...cs.position), q, R: new T.Vector3(1, 0, 0).applyQuaternion(q), U: new T.Vector3(0, 1, 0).applyQuaternion(q), F: new T.Vector3(0, 0, -1).applyQuaternion(q), fov: cs.fov, aspect };
}
function _measure(obj) {
  obj.updateWorldMatrix(true, true);
  const scale = new T.Vector3(); obj.matrixWorld.decompose(new T.Vector3(), new T.Quaternion(), scale);
  const sc = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z), 1e-9);
  const inv = new T.Matrix4().copy(obj.matrixWorld).invert();
  const box = new T.Box3(); const p = new T.Vector3();
  obj.traverse((m) => { const g = m.geometry; if (!g || m.visible === false) return; if (!g.boundingBox) g.computeBoundingBox(); const bb = g.boundingBox; if (!bb || bb.isEmpty()) return;
    const M = new T.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    for (let i = 0; i < 8; i++) { p.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(M); box.expandByPoint(p); } });
  if (box.isEmpty()) return { cl: [0, 0, 0], r: MIN_R, sc };
  const cl = box.getCenter(new T.Vector3());
  return { cl: [cl.x, cl.y, cl.z], r: Math.max(MIN_R, box.getSize(new T.Vector3()).length() / 2), sc };
}
function _targetPose(sp, fr, sc) {
  const H = (2 * sp.r * sc) / Math.max(MIN_S, Math.min(MAX_S, sp.s));
  const dist = Math.max(distForFrame(H, fr.fov), 1e-3);
  const centre = fr.eye.clone().addScaledVector(fr.F, dist).addScaledVector(fr.R, sp.u * H * fr.aspect).addScaledVector(fr.U, sp.v * H);
  const quat = fr.q.clone().multiply(new T.Quaternion(...sp.q));
  const origin = centre.clone().sub(new T.Vector3(...sp.cl).multiplyScalar(sc).applyQuaternion(quat));
  return { origin, quat, centre, dist };
}
function _describe(obj, sp, fr) {
  obj.updateWorldMatrix(true, true);
  const wq = new T.Quaternion(), wp = new T.Vector3(), ws = new T.Vector3();
  obj.matrixWorld.decompose(wp, wq, ws);
  const sc = Math.max(Math.abs(ws.x), Math.abs(ws.y), Math.abs(ws.z), 1e-9);
  const centre = wp.clone().add(new T.Vector3(...sp.cl).multiplyScalar(sc).applyQuaternion(wq));
  const d = centre.sub(fr.eye);
  let dist = d.dot(fr.F); if (!(dist > 1e-3)) dist = Math.max(d.length(), 1e-3);
  const H = Math.max(frameHeight(dist, fr.fov), 1e-6);
  return { u: d.dot(fr.R) / (H * fr.aspect), v: d.dot(fr.U) / H, s: Math.max(MIN_S, Math.min(MAX_S, (2 * sp.r * sc) / H)), q: _arr(fr.q.clone().invert().multiply(wq).normalize()) };
}

let fail = 0;
const t = (n, ok, info = '') => { if (!ok) fail++; console.log((ok ? '  ok   ' : ' FAIL  ') + n.padEnd(70) + info); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

// an object: a box 40×10×20 whose origin is at one corner (centre offset ≠ 0), under a scaled, turned parent
const parent = new T.Group(); parent.position.set(100, 5, -30); parent.rotation.set(0.3, 1.1, -0.4); parent.scale.setScalar(2);
const obj = new T.Group(); obj.position.set(7, -3, 2); obj.rotation.set(0.5, 0.2, 0.9);
const mesh = new T.Mesh(new T.BoxGeometry(40, 10, 20)); mesh.position.set(20, 5, 10);      // corner origin
obj.add(mesh); parent.add(obj);
const scene = new T.Scene(); scene.add(parent);
const { cl, r, sc } = _measure(obj);
t('the centre offset is the box middle, in the object\'s own space', near(cl[0], 20) && near(cl[1], 5) && near(cl[2], 10), JSON.stringify(cl.map(v => +v.toFixed(3))));
t('the radius is half the box diagonal, in the object\'s own units (turn + parent scale taken out)', near(r, Math.sqrt(40 * 40 + 10 * 10 + 20 * 20) / 2, 1e-6), r.toFixed(3));

// a camera looking down and to the side
const camQ = new T.Quaternion().setFromEuler(new T.Euler(-0.6, 0.8, 0.1));
const cam = { position: [400, 300, 500], quaternion: _arr(camQ), fov: 50 };
const fr = _frameOf(cam);

// switch on: defaults + the face it shows now
const wq0 = new T.Quaternion(); obj.getWorldQuaternion(wq0);
const q0 = _arr(fr.q.clone().invert().multiply(wq0).normalize());
let sp = { u: -1 / 3, v: 0, s: 1 / 3, q: q0, q0, cl, r };

// place it: apply the world pose onto the object (through its parent), then describe it back
const place = (sp, fr) => {
  const { origin, quat } = _targetPose(sp, fr, sc);
  parent.updateMatrixWorld(true);
  const inv = new T.Matrix4().copy(parent.matrixWorld).invert();
  const local = new T.Matrix4().multiplyMatrices(inv, new T.Matrix4().compose(origin, quat, new T.Vector3(1, 1, 1)));
  const p = new T.Vector3(), q = new T.Quaternion(), s = new T.Vector3(); local.decompose(p, q, s);
  obj.position.copy(p); obj.quaternion.copy(q); obj.updateWorldMatrix(true, true);
};
place(sp, fr);
const d1 = _describe(obj, sp, fr);
t('place → describe gives the descriptor back (u)', near(d1.u, sp.u, 1e-6), d1.u.toFixed(6));
t('… (v)', near(d1.v, sp.v, 1e-6), d1.v.toFixed(6));
t('… (s)', near(d1.s, sp.s, 1e-6), d1.s.toFixed(6));
t('… (orientation, relative to the camera)', Math.abs(new T.Quaternion(...d1.q).dot(new T.Quaternion(...sp.q))) > 1 - 1e-9);

// the picture: the centre projects to the left third, and the sphere spans a third of the height
{
  const { centre, dist } = _targetPose(sp, fr, sc);
  const H = frameHeight(dist, fr.fov);
  const rel = centre.clone().sub(fr.eye);
  t('the centre sits at x = −1/3 of the frame width', near(rel.dot(fr.R) / (H * fr.aspect), -1 / 3, 1e-9));
  t('…and on the horizon line (v = 0)', near(rel.dot(fr.U) / H, 0, 1e-9));
  t('the bounding sphere spans a third of the frame height', near((2 * r * sc) / H, 1 / 3, 1e-9));
  t('the object is IN FRONT of the camera', dist > 0 && rel.dot(fr.F) > 0);
}

// another lens on the same step: the same descriptor → the same picture (fractions), a different distance
{
  const fr2 = _frameOf({ ...cam, fov: 20 });
  const a = _targetPose(sp, fr, sc), b = _targetPose(sp, fr2, sc);
  const frac = (p, f) => { const rel = p.clone().sub(f.eye); const H = frameHeight(rel.dot(f.F), f.fov); return [rel.dot(f.R) / (H * f.aspect), rel.dot(f.U) / H]; };
  const fa = frac(a.centre, fr), fb = frac(b.centre, fr2);
  t('a narrower lens: same place in the picture', near(fa[0], fb[0], 1e-9) && near(fa[1], fb[1], 1e-9));
  t('…farther from the eye (dolly-zoom style)', b.dist > a.dist * 2, `${a.dist.toFixed(1)} → ${b.dist.toFixed(1)}`);
}

// orbit: a new camera, the descriptor unchanged → the same face towards the camera
{
  const camQ2 = new T.Quaternion().setFromEuler(new T.Euler(0.2, -1.4, 0));
  const fr3 = _frameOf({ position: [-200, 120, 80], quaternion: _arr(camQ2), fov: 50 });
  place(sp, fr3);
  const wq = new T.Quaternion(); obj.getWorldQuaternion(wq);
  const rel = fr3.q.clone().invert().multiply(wq);
  t('after an orbit the object shows the SAME face (camera-relative orientation)', Math.abs(rel.dot(new T.Quaternion(...sp.q))) > 1 - 1e-9);
  const d3 = _describe(obj, sp, fr3);
  t('…and describes back to the same fractions', near(d3.u, sp.u, 1e-6) && near(d3.v, sp.v, 1e-6) && near(d3.s, sp.s, 1e-6));
}

// the dolly: s halves → twice as far, same screen place
{
  const a = _targetPose(sp, fr, sc), b = _targetPose({ ...sp, s: sp.s / 2 }, fr, sc);
  const dir = (p) => p.centre.clone().sub(fr.eye).normalize();
  t('the dolly keeps the centre on the same ray from the eye', dir(a).dot(dir(b)) > 1 - 1e-9);
  t('…at twice the distance for half the size', near(b.dist, 2 * a.dist, 1e-6));
}

// the user drags the object with the gizmo: re-capture keeps whatever he did
{
  place(sp, fr);
  obj.position.x += 3; obj.rotateY(0.4); obj.updateWorldMatrix(true, true);
  const d = _describe(obj, sp, fr);
  const sp2 = { ...sp, ...d, custom: true };
  const before = new T.Vector3(); obj.getWorldPosition(before);
  const wqb = new T.Quaternion(); obj.getWorldQuaternion(wqb);
  place(sp2, fr);
  const after = new T.Vector3(); obj.getWorldPosition(after);
  const wqa = new T.Quaternion(); obj.getWorldQuaternion(wqa);
  t('re-capture then re-bake lands exactly where the user left it', before.distanceTo(after) < 1e-6 && Math.abs(wqa.dot(wqb)) > 1 - 1e-9, before.distanceTo(after).toExponential(2));
}

console.log(`\n${fail ? fail + ' FAILED' : 'all passed'}`);
process.exit(fail ? 1 : 0);
