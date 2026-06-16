/**
 * Stub for the optional `postprocessing` library.
 *
 * N8AO's bundle statically imports `Pass` from BOTH `three/examples/jsm/
 * postprocessing/Pass.js` AND the third-party `postprocessing` package, to
 * support either ecosystem. This app uses the three.js EffectComposer + the
 * three `Pass` (via N8AOPass), so the `postprocessing` import only needs to
 * RESOLVE — N8AOPostPass (the variant built on this Pass) is never used.
 */
export class Pass {
  constructor() {}
  setSize() {}
  render() {}
  dispose() {}
}
export class EffectComposer {}
export default { Pass, EffectComposer };
