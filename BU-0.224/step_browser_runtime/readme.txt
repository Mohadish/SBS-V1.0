step_browser_runtime_v0.004

This is the shared offline runtime folder for step_browser_poc builds that load vendor files from:
../step_browser_runtime/vendor/

What changed in v0.004:
- Removed the broken esm.sh re-export stubs for OBJ / STL / GLTF / FBX loader modules.
- Replaced them with fully local loader modules derived from the official three.js r152 sources.
- Added local support modules required by GLTFLoader / FBXLoader:
  - BufferGeometryUtils.bundle.mjs
  - fflate.module.js
  - NURBSCurve.bundle.mjs
  - NURBSUtils.bundle.mjs
  - three.module.proxy.mjs
- Added a local TransformControls.bundle.mjs based on the same three.js source set so the shared runtime no longer mixes local files with remote stubs.

Use:
1. Unzip this folder as step_browser_runtime next to the app version folder.
2. Serve the app over local HTTP / localhost.
3. Open the app HTML from that localhost URL, not via file://.

Expected layout:
Step-by-step-App/
├─ step_browser_runtime/
│  └─ vendor/
└─ step_browser_poc_v0.224/
   └─ step_browser_poc_v0.224.html
