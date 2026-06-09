# sbs-occt-convert — native 64-bit STEP/IGES → glTF converter

The in-app CAD reader (`occt-import-js`) is OpenCascade compiled to **32-bit
WebAssembly**, capped at ~2 GB of memory — so big assemblies (≈150 MB+ STEP)
fail. This tool is the **same kernel built native + 64-bit**: it uses real RAM
(no cap), meshes in parallel, and writes a standard `.glb` (with the assembly
tree, part names and colors) that SBS loads through its 64-bit glTF loader.

The app calls it automatically for large CAD files; if the exe is absent the app
falls back to the in-app WASM reader exactly as before (so this is a pure add-on).

---

## What you need (build box, one-time)
- **Windows + Visual Studio 2022** (Desktop C++ workload) — or Build Tools.
- **CMake ≥ 3.16**.
- **OpenCASCADE 7.6–7.8** (64-bit). Easiest via **vcpkg**.

## Build with vcpkg (recommended)
```powershell
# 1. vcpkg + OpenCascade (first time; the OCCT build takes a while)
git clone https://github.com/microsoft/vcpkg
.\vcpkg\bootstrap-vcpkg.bat
.\vcpkg\vcpkg install opencascade:x64-windows

# 2. configure + build this tool
cd sbs-app\native
cmake -B build -S . -A x64 ^
  -DCMAKE_TOOLCHAIN_FILE=<path-to>\vcpkg\scripts\buildsystems\vcpkg.cmake
cmake --build build --config Release
# → build\Release\sbs-occt-convert.exe
```

## Build against a manual OCCT install
```powershell
cmake -B build -S . -A x64 -DOpenCASCADE_DIR="C:\OpenCASCADE-7.8.0\cmake"
cmake --build build --config Release
```

## Smoke test
```powershell
.\build\Release\sbs-occt-convert.exe  big-assembly.step  out.glb
# args: <input.step|.iges> <output.glb> [linRatio=0.005] [angDeg=30]
# exit 0 = ok; stderr prints part count + deflection + result path.
```
Open `out.glb` in any glTF viewer (or SBS) to confirm geometry + structure.

---

## Ship it with the app
Drop the **exe + all the OCCT/vcpkg runtime DLLs** it links into:

```
sbs-app/native/bin/win-x64/
    sbs-occt-convert.exe
    TKernel.dll  TKMath.dll  TKDESTEP.dll  TKRWMesh.dll  … (every dependency)
```
> Find the DLL set with `dumpbin /DEPENDENTS sbs-occt-convert.exe`, or just copy
> everything from `vcpkg\installed\x64-windows\bin`. Size ~100–150 MB.

`package.json` already bundles this folder via electron-builder `extraResources`
(see the `"from": "native/bin"` entry). At runtime the app looks for
`resources/native/bin/win-x64/sbs-occt-convert.exe`; in dev it looks in
`native/bin/win-x64/`.

## Notes / gotchas
- **Assembly references:** a STEP is self-contained, so no external part files
  are needed (unlike `.sldasm`).
- **Toolkit names** differ across OCCT versions — `CMakeLists.txt` links
  whichever `TK*` targets exist, so 7.6 and 7.8 both work.
- **License:** OpenCASCADE is **LGPL-2.1** — redistributable with the app as long
  as the OCCT DLLs stay dynamically linked (they do here).
- Linux/macOS: same source builds; put binaries in `native/bin/linux-x64` /
  `native/bin/darwin-*` and extend the runtime lookup if you target those.
