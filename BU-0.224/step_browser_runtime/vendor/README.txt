Local vendor runtime files used by step_browser_poc_v0.224.

Core scripts:
- three.min.js
- occt-import-js.js / .wasm / worker
- EBML.min.js
- quill.js / quill.core.css

Local addon modules:
- OBJLoader.bundle.mjs
- STLLoader.bundle.mjs
- GLTFLoader.bundle.mjs
- FBXLoader.bundle.mjs
- TransformControls.bundle.mjs
- BufferGeometryUtils.bundle.mjs
- NURBSCurve.bundle.mjs
- NURBSUtils.bundle.mjs
- fflate.module.js
- three.module.proxy.mjs

The addon modules are localized from the official three.js r152 example sources and rewritten to import from the local proxy/runtime files only.
