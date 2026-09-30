// io/normal-repair.js: healthy normals are left alone; unusable ones are rebuilt in
// place — smooth across a cylinder, sharp at a box edge — with the vertex count and
// index untouched (the stable-id fingerprint depends on them). Run: npm run test:normals
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.THREE = require('../vendor/three.min.js');
const T = globalThis.THREE;
const { measureNormals, repairNormalsIfBad } = await import('../src/io/normal-repair.js');
let fails = 0;
const fail = (...a) => { fails++; console.log('FAIL', ...a); };
const wreck = (g) => { const n = g.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0); return g; };

// 1. healthy geometry: measured low, not touched
for (const [name, g] of [['box', new T.BoxGeometry(2, 3, 0.1)], ['cylinder', new T.CylinderGeometry(1, 1, 3, 48)], ['sphere', new T.SphereGeometry(1, 24, 16)]]) {
  const before = g.attributes.normal.array.slice();
  const r = repairNormalsIfBad(g);
  if (r.repaired) fail(name, 'healthy geometry was rebuilt');
  if (!(r.measure.meanDeg < 8)) fail(name, 'healthy mean too high', r.measure.meanDeg);
  if (before.some((v, i) => v !== g.attributes.normal.array[i])) fail(name, 'normals changed');
}

// 2. wrecked indexed cylinder: rebuilt, smooth, same count + index
{
  const g = wreck(new T.CylinderGeometry(1, 1, 3, 48));
  const count = g.attributes.position.count, idxLen = g.index.count, idxCopy = g.index.array.slice();
  const r = repairNormalsIfBad(g);
  const m = measureNormals(g);
  if (!r.repaired) fail('cylinder not repaired');
  if (!(r.measure.meanDeg > 60)) fail('cylinder measure before', r.measure.meanDeg);
  if (!(m.meanDeg < 3 && m.tiltedFrac === 0)) fail('cylinder not smooth after', m);
  if (g.attributes.position.count !== count || g.index.count !== idxLen) fail('cylinder count changed');
  if (idxCopy.some((v, i) => v !== g.index.array[i])) fail('cylinder index changed');
  // smooth around the barrel: neighbouring side normals differ by the segment angle, not 90°
  const n = g.attributes.normal, a = new T.Vector3(), b = new T.Vector3();
  a.fromBufferAttribute(n, 0); b.fromBufferAttribute(n, 1);
  const deg = Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * 180 / Math.PI;
  if (!(deg < 10)) fail('cylinder side not smooth', deg);
}

// 3. wrecked non-indexed box (the OBJ shape): rebuilt, flat faces exact, edges sharp
{
  const g = wreck(new T.BoxGeometry(2, 3, 0.5).toNonIndexed());
  const count = g.attributes.position.count;
  const r = repairNormalsIfBad(g);
  const m = measureNormals(g);
  if (!r.repaired) fail('box not repaired');
  if (!(m.meanDeg < 0.01)) fail('box faces not exact', m.meanDeg);
  if (g.attributes.position.count !== count) fail('box count changed');
  if (g.index) fail('box gained an index');
}

// 4. no normals at all → created
{
  const g = new T.BoxGeometry(1, 1, 1); g.deleteAttribute('normal');
  const r = repairNormalsIfBad(g);
  if (!r.repaired || !g.attributes.normal) fail('missing normals not created');
  const m = measureNormals(g); if (!(m.meanDeg < 0.01)) fail('created normals wrong', m.meanDeg);
}

console.log(`normal-repair: ${fails} failures`);
process.exit(fails ? 1 : 0);
