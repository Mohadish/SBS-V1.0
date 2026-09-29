// clip-fit.js against brute force: the nearest visible depth it reports must be a
// LOWER bound of the sampled truth (a near plane from it never clips) and tight;
// hidden parts must not count. Run: npm run test:clip
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.THREE = require('../vendor/three.min.js');
const { gatherClipBoxes, viewDepthRange, sidePlanes, snapPlane } = await import('../src/core/clip-fit.js');
const T = globalThis.THREE;

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
let fails = 0;
const fail = (...a) => { fails++; console.log('FAIL', ...a); };

function sampledRange(cam, mesh) {
  const planes = sidePlanes(cam);
  const lb = mesh.geometry.boundingBox;
  const camPos = new T.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const fwd = new T.Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
  let mn = Infinity, mx = -Infinity;
  const N = 24, p = new T.Vector3();
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) for (let k = 0; k <= N; k++) {
    p.set(lb.min.x + (lb.max.x - lb.min.x) * i / N, lb.min.y + (lb.max.y - lb.min.y) * j / N, lb.min.z + (lb.max.z - lb.min.z) * k / N)
      .applyMatrix4(mesh.matrixWorld);
    let inside = true;
    for (const [nx, ny, nz, w] of planes) if (nx * p.x + ny * p.y + nz * p.z + w < 0) { inside = false; break; }
    if (!inside) continue;
    const dz = fwd.dot(p.clone().sub(camPos));
    if (dz < mn) mn = dz;
    if (dz > mx) mx = dz;
  }
  return mn === Infinity ? null : { mn, mx };
}

// 1. random boxes (some flat, like the grid) against random cameras
let cases = 0, straddle = 0;
for (let t = 0; t < 400; t++) {
  const cam = new T.PerspectiveCamera(5 + rnd() * 70, 1.2 + rnd(), 0.1, 1e6);
  cam.position.set((rnd() - 0.5) * 400, (rnd() - 0.5) * 400, (rnd() - 0.5) * 400);
  cam.lookAt((rnd() - 0.5) * 50, (rnd() - 0.5) * 50, (rnd() - 0.5) * 50);
  cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  const flat = rnd() < 0.2;
  const geo = new T.BoxGeometry(10 + rnd() * 300, flat ? 0 : 10 + rnd() * 200, 10 + rnd() * 300);
  geo.computeBoundingBox();
  const mesh = new T.Mesh(geo);
  mesh.position.set((rnd() - 0.5) * 300, (rnd() - 0.5) * 300, (rnd() - 0.5) * 300);
  mesh.rotation.set(rnd() * 6, rnd() * 6, rnd() * 6);
  mesh.scale.setScalar(0.5 + rnd());
  const scene = new T.Scene(); scene.add(mesh); scene.updateMatrixWorld(true);
  const r = viewDepthRange(cam, gatherClipBoxes([scene]));
  const s = sampledRange(cam, mesh);
  if (!s) continue;
  cases++;
  if (!r) { fail('missed a visible box', t); continue; }
  if (r.straddling) straddle++;
  if (r.nearest > s.mn + 1e-6 * (1 + Math.abs(s.mn))) fail('nearest too far — would clip', t, r.nearest, s.mn);
  if (r.farthest < s.mx - 1e-6 * (1 + Math.abs(s.mx))) fail('farthest too near — would clip', t, r.farthest, s.mx);
}

// 2. hidden, exploded-away parts do not count (the V0.3.4.162 root cause)
{
  const scene = new T.Scene();
  scene.add(new T.Mesh(new T.BoxGeometry(100, 100, 100)));
  const hid = new T.Mesh(new T.BoxGeometry(100, 100, 100)); hid.position.set(0, 0, 2000); hid.visible = false; scene.add(hid);
  scene.updateMatrixWorld(true);
  const cam = new T.PerspectiveCamera(15, 1.5, 0.1, 1e6); cam.position.set(0, 0, 800); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
  const r = viewDepthRange(cam, gatherClipBoxes([scene]));
  if (Math.abs(r.nearest - 750) > 1e-6 || Math.abs(r.farthest - 850) > 1e-6) fail('hidden part counted', r);
}

// 3. snapPlane never clips and is stable
for (const v of [1e-3, 0.37, 1, 17.5, 1234.5, 9e5]) {
  const lo = snapPlane(v, false), hi = snapPlane(v, true);
  if (!(lo <= v && lo > v / 1.05)) fail('snap down', v, lo);
  if (!(hi >= v && hi < v * 1.05)) fail('snap up', v, hi);
  if (snapPlane(lo * 1.001, false) !== lo) fail('snap unstable', v);
}

console.log(`clip-fit: ${cases} random cases (${straddle} reaching past the camera), ${fails} failures`);
process.exit(fails ? 1 : 0);
