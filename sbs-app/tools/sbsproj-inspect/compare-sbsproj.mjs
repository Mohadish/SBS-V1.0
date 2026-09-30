// compare-sbsproj.mjs — read-only diff of two .sbsproj saves (gzip or plain JSON).
// Usage: node compare-sbsproj.mjs "<good.sbsproj>" "<broken.sbsproj>"
import fs from 'node:fs';
import zlib from 'node:zlib';

function load(p) {
  const bytes = fs.readFileSync(p);
  const text = (bytes[0] === 0x1f && bytes[1] === 0x8b) ? zlib.gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
  return JSON.parse(text);
}
function meshes(spec, out = [], path = []) {
  if (!spec) return out;
  if (spec.type === 'mesh') out.push({ id: spec.id, name: spec.name, fp: spec.fingerprint || null, mi: spec.meshIndex ?? null, path: path.join('/') });
  for (const c of spec.children || []) meshes(c, out, [...path, spec.name || spec.type]);
  return out;
}
function models(spec, out = []) {
  if (!spec) return out;
  if (spec.type === 'model' || spec.type === 'replaceModel') out.push(spec);
  for (const c of spec.children || []) models(c, out);
  return out;
}

const [A, B] = process.argv.slice(2);
if (!A || !B) { console.error('need two paths'); process.exit(1); }
const a = load(A), b = load(B);
console.log(`A (good?)  : ${A}\n   saved by : ${a._sbs?.app_version}  on ${a._sbs?.saved}`);
console.log(`B (broken?): ${B}\n   saved by : ${b._sbs?.app_version}  on ${b._sbs?.saved}\n`);

console.log('=== ASSET RECORDS (what file each model loads from) ===');
const aAssets = new Map((a.assets?.items || []).map(x => [x.id, x]));
for (const bb of (b.assets?.items || [])) {
  const aa = aAssets.get(bb.id);
  const f = k => `${aa?.[k] ?? '—'}  →  ${bb[k] ?? '—'}`;
  const changed = aa && ['name', 'originalPath', 'relativePath', 'fileSize', 'lastModified'].filter(k => String(aa[k] ?? '') !== String(bb[k] ?? ''));
  console.log(`\n• ${bb.name}  (${bb.id})${!aa ? '   [NOT IN A]' : changed.length ? `   CHANGED: ${changed.join(', ')}` : '   same'}`);
  if (!aa || changed?.length) for (const k of ['name', 'originalPath', 'relativePath', 'fileSize', 'lastModified']) console.log(`    ${k.padEnd(13)} ${f(k)}`);
}

console.log('\n=== SAVED TREE: per model, do the mesh fingerprints agree? ===');
const aModels = new Map(models(a.tree?.root).map(m => [m.assetId || m.id, m]));
for (const mb of models(b.tree?.root)) {
  const ma = aModels.get(mb.assetId || mb.id);
  const bm = meshes(mb), am = ma ? meshes(ma) : [];
  const aById = new Map(am.map(m => [m.id, m]));
  let sameFp = 0, diffFp = 0, missing = 0; const diffs = [];
  for (const m of bm) {
    const o = aById.get(m.id);
    if (!o) { missing++; continue; }
    if (o.fp === m.fp) sameFp++; else { diffFp++; if (diffs.length < 12) diffs.push(`      ${m.id}: "${o.name}" [${o.fp}] → "${m.name}" [${m.fp}]`); }
  }
  console.log(`\n• ${mb.name}  meshes A=${am.length} B=${bm.length}  same-id-same-geometry=${sameFp}  same-id-DIFFERENT-geometry=${diffFp}  ids-new-in-B=${missing}`);
  if (diffs.length) { console.log('    same id, different geometry (identity moved onto another part):'); diffs.forEach(l => console.log(l)); }
  const noMi = bm.filter(m => m.mi == null).length;
  if (noMi) console.log(`    note: ${noMi} B meshes carry no meshIndex (non-OCCT source — .glb/.obj/.fbx?)`);
}
