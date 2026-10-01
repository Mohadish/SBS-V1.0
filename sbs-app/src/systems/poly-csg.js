/**
 * ⬚ POLY BOOLEAN (V0.3.5.11, Phase 1b) — the "smart extrude" join.
 *
 * 3ds Max 2021.1+ unites an extrusion with whatever it runs into on release
 * and cuts a pocket (or a through-hole) when pushed in. Here: the poly before
 * the gesture is solid A, the prism the gesture swept is solid B, and
 * Manifold (vendor/manifold/, Apache-2.0, manifold-3d 3.5.4 — the exact,
 * guaranteed-manifold Boolean kernel OpenSCAD and three.js use) evaluates
 * A ∪ B or A − B. Box modelling is coplanar faces all the way (the extruded
 * block's sides continue the box's sides, a pocket's floor meets the bottom);
 * three-bvh-csg was tried first and fell apart exactly there — Manifold is
 * exact on coincident faces. The result triangles come back as polygons
 * through poly-core.trianglesToPoly (coplanar neighbours merged, as Max
 * "unifies" them).
 *
 * The wasm (540 KB) is loaded on first use and warmed when Edit poly starts,
 * so a project that never models pays nothing.
 */
import { polyToIndexed, trianglesToPoly, weldPoly } from './poly-core.js';

let _wasmPromise = null;
export function warmBooleanLib() {
  if (!_wasmPromise) {
    _wasmPromise = import('../../vendor/manifold/manifold.js?rt=v0.005').then(async (m) => {
      const wasm = await m.default();
      wasm.setup();
      return wasm;
    }).catch((err) => { _wasmPromise = null; throw err; });
  }
  return _wasmPromise;
}

function _solidOf(p, { Manifold, Mesh }) {
  const { positions, indices } = polyToIndexed(weldPoly(p));
  const mesh = new Mesh({ numProp: 3, vertProperties: positions, triVerts: indices });
  mesh.merge();                                            // coincident vertices → one (a dragged-together vertex would otherwise be "not manifold")
  const solid = new Manifold(mesh);
  const status = solid.status();
  if (status !== 'NoError') { solid.delete(); throw new Error(`the poly is not a closed solid (${status})`); }
  return solid;
}

/**
 * A op B → a new poly (local space of A; B must already be in that space), or
 * null when the result is empty. op: 'union' | 'subtract' | 'intersect'.
 */
export async function booleanPoly(A, B, op = 'union') {
  const wasm = await warmBooleanLib();
  let a = null, b = null, r = null;
  try {
    a = _solidOf(A, wasm); b = _solidOf(B, wasm);
    r = op === 'subtract' ? a.subtract(b) : op === 'intersect' ? a.intersect(b) : a.add(b);
    const mesh = r.getMesh();
    const vp = mesh.vertProperties, tv = mesh.triVerts, np = mesh.numProp || 3;
    if (!tv || tv.length < 3) return null;
    const soup = new Float32Array(tv.length * 3);
    for (let i = 0; i < tv.length; i++) { const k = tv[i] * np; soup[i * 3] = vp[k]; soup[i * 3 + 1] = vp[k + 1]; soup[i * 3 + 2] = vp[k + 2]; }
    const poly = trianglesToPoly(soup);
    return poly.f.length >= 4 ? poly : null;
  } finally {
    a?.delete?.(); b?.delete?.(); r?.delete?.();
  }
}
