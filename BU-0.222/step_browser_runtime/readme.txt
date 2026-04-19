step_browser_runtime_v0.003

This is the shared local runtime folder for step_browser_poc builds that load vendor files from:
../step_browser_runtime/vendor/

Why v0.002 still missed TransformControls / OBJ / STL / GLTF / FBX:
- v0.002 assumed legacy classic-script three.js addon files
- the uploaded v0.218 baseline actually bootstrapped those as ESM imports from esm.sh
- so the runtime fetcher was looking for the wrong kind of files

What changed in v0.003:
- the runtime now fetches local module bundle files for:
  - TransformControls
  - OBJLoader
  - STLLoader
  - GLTFLoader
  - FBXLoader
- these are saved as:
  - TransformControls.bundle.mjs
  - OBJLoader.bundle.mjs
  - STLLoader.bundle.mjs
  - GLTFLoader.bundle.mjs
  - FBXLoader.bundle.mjs
- this matches the loader architecture from the uploaded v0.218 baseline

Use:
1. Unzip step_browser_runtime_v0.003.zip next to the app version folder.
2. Run 01_fetch_runtime_files.bat while online.
3. Run 02_check_runtime.bat.
4. Use step_browser_poc_v0.221 or later.
