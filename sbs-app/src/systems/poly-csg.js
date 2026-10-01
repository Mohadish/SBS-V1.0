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
 * exact on coincident faces.
 *
 * V0.3.5.12 — the EDGES SURVIVE: every input triangle carries its polygon's
 * id (MeshGL.faceID) and Manifold keeps those ids on the output, so the
 * result is rebuilt polygon-by-polygon of the inputs — the loop cuts and
 * the face layout the user made stay; only the faces the Boolean actually
 * touched get new boundaries. "Clean edges" (poly-core.cleanEdges) merges
 * coplanar neighbours when the user asks for it.
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
  const { positions, indices, faceOfTri } = polyToIndexed(weldPoly(p));
  const originalID = Manifold.reserveIDs(1);
  const mesh = new Mesh({ numProp: 3, vertProperties: positions, triVerts: indices, faceID: faceOfTri, runIndex: new Uint32Array([0]), runOriginalID: new Uint32Array([originalID]) });
  mesh.merge();                                            // coincident vertices → one (a dragged-together vertex would otherwise be "not manifold")
  const solid = new Manifold(mesh);
  const status = solid.status();
  if (status !== 'NoError') { solid.delete(); throw new Error(`the poly is not a closed solid (${status})`); }
  return solid;
}

/**
 * A op B → a new poly (local space of A; B must already be in that space), or
 * null when the result is empty. op: 'union' | 'subtract' | 'intersect'.
 * keepEdges (default true): polygons rebuilt per input polygon; false merges
 * coplanar neighbours ("clean" result).
 */
export async function booleanPoly(A, B, op = 'union', { keepEdges = true } = {}) {
  const wasm = await warmBooleanLib();
  let a = null, b = null, r = null;
  try {
    a = _solidOf(A, wasm); b = _solidOf(B, wasm);
    r = op === 'subtract' ? a.subtract(b) : op === 'intersect' ? a.intersect(b) : a.add(b);
    const mesh = r.getMesh();
    const vp = mesh.vertProperties, tv = mesh.triVerts, np = mesh.numProp || 3;
    if (!tv || tv.length < 3) return null;
    const nT = tv.length / 3;
    const soup = new Float32Array(tv.length * 3);
    for (let i = 0; i < tv.length; i++) { const k = tv[i] * np; soup[i * 3] = vp[k]; soup[i * 3 + 1] = vp[k + 1]; soup[i * 3 + 2] = vp[k + 2]; }
    let groupOf = null;
    if (keepEdges && mesh.faceID && mesh.runIndex && mesh.runOriginalID) {
      groupOf = new Float64Array(nT);                      // (which input) × 2^24 + (its polygon)
      const ri = mesh.runIndex, ro = mesh.runOriginalID;
      for (let run = 0; run + 1 < ri.length; run++) {
        const from = ri[run] / 3, to = ri[run + 1] / 3, base = (ro[run] || 0) * 16777216;
        for (let t = from; t < to; t++) groupOf[t] = base + mesh.faceID[t];
      }
    }
    const poly = trianglesToPoly(soup, { groupOf });
    return poly.f.length >= 4 ? poly : null;
  } finally {
    a?.delete?.(); b?.delete?.(); r?.delete?.();
  }
}
