@echo off
REM ════════════════════════════════════════════════════════════════════════════
REM  build.bat  —  one-shot build of sbs-occt-convert.exe (native CAD converter)
REM
REM  PREREQUISITE (install once, by hand):
REM    Visual Studio 2022  with the  "Desktop development with C++"  workload.
REM    Community edition is free:  https://visualstudio.microsoft.com/
REM
REM  HOW TO RUN (avoids PATH headaches):
REM    Start menu -> open  "x64 Native Tools Command Prompt for VS 2022"
REM    then:   cd /d "<this folder>"   and run:   build.bat
REM
REM  What it does (re-running is safe — finished steps are skipped):
REM    1. fetch vcpkg
REM    2. build OpenCascade via vcpkg   <-- LONG the first time (~1-2 hours)
REM    3. compile sbs-occt-convert.exe
REM    4. copy the exe + every needed DLL into  bin\win-x64\
REM
REM  If step 3 (compile) errors: copy the FULL error text and send it to Claude —
REM  OpenCascade headers shift between versions, so a fix or two is expected.
REM ════════════════════════════════════════════════════════════════════════════
setlocal enabledelayedexpansion
cd /d "%~dp0"
title SBS native CAD converter - build

set "VCPKG_DIR=%~dp0vcpkg"
set "TRIPLET=x64-windows"
set "OUTDIR=%~dp0bin\win-x64"

REM ── sanity checks ───────────────────────────────────────────────────────────
where cmake >nul 2>&1
if errorlevel 1 (
  echo [X] CMake not found on PATH.
  echo     Easiest fix: run me from the "x64 Native Tools Command Prompt for VS 2022"
  echo     ^(Start menu^), which puts cmake + the C++ compiler on PATH automatically.
  echo     Or install CMake from https://cmake.org and tick "Add to PATH".
  pause & exit /b 1
)
where git >nul 2>&1
if errorlevel 1 (
  echo [X] git not found. Install Git for Windows ^(https://git-scm.com^) and retry.
  pause & exit /b 1
)

REM ── 1. vcpkg ────────────────────────────────────────────────────────────────
if not exist "%VCPKG_DIR%\vcpkg.exe" (
  echo [1/4] Fetching vcpkg . . .
  if not exist "%VCPKG_DIR%\.git" (
    git clone https://github.com/microsoft/vcpkg "%VCPKG_DIR%"
    if errorlevel 1 ( echo [X] git clone of vcpkg failed. & pause & exit /b 1 )
  )
  call "%VCPKG_DIR%\bootstrap-vcpkg.bat" -disableMetrics
  if errorlevel 1 ( echo [X] vcpkg bootstrap failed. & pause & exit /b 1 )
) else (
  echo [1/4] vcpkg already present.
)

REM ── 2. OpenCascade WITH the glTF (rapidjson) feature ────────────────────────
REM  RWGltf_CafWriter (our glTF output) only gets compiled when OCC is built
REM  with RapidJSON. We always run the install so a previously feature-less OCC
REM  gets rebuilt WITH glTF. First build (or this feature change) takes 1-2 HOURS.
echo [2/4] Ensuring OpenCascade is built WITH glTF support (rapidjson feature).
echo       If OCC was already built without it, this REBUILDS it — 1-2 HOURS. Leave it running.
"%VCPKG_DIR%\vcpkg.exe" install "opencascade[rapidjson]:%TRIPLET%" --recurse
if errorlevel 1 (
  echo [X] OpenCascade install failed.
  echo     If it says "unknown feature 'rapidjson'", run:  vcpkg\vcpkg.exe search opencascade
  echo     and send Claude the feature list. Otherwise send the log above.
  pause & exit /b 1
)

REM ── 3. configure + build our tool ───────────────────────────────────────────
echo [3/4] Configuring + compiling sbs-occt-convert . . .
cmake -B build -S . -A x64 -DCMAKE_TOOLCHAIN_FILE="%VCPKG_DIR%\scripts\buildsystems\vcpkg.cmake"
if errorlevel 1 ( echo [X] cmake configure failed. Send the output above to Claude. & pause & exit /b 1 )
cmake --build build --config Release
if errorlevel 1 ( echo [X] Compile failed. Copy the FULL error text above and send it to Claude. & pause & exit /b 1 )

REM ── 4. deploy exe + DLLs ────────────────────────────────────────────────────
echo [4/4] Copying exe + DLLs into bin\win-x64\ . . .
if not exist "%OUTDIR%" mkdir "%OUTDIR%"
copy /Y "build\Release\sbs-occt-convert.exe" "%OUTDIR%\" >nul
if errorlevel 1 ( echo [X] built exe not found at build\Release\. & pause & exit /b 1 )
copy /Y "%VCPKG_DIR%\installed\%TRIPLET%\bin\*.dll" "%OUTDIR%\" >nul

echo.
echo ════════════════════════════════════════════════════════════════════════════
echo  [OK] Built and deployed:
echo       %OUTDIR%\sbs-occt-convert.exe  (+ OpenCascade DLLs)
echo.
echo  NEXT:
echo   - Dev:   restart SBS-launcher.bat, then open a big STEP (>120 MB).
echo   - Ship:  run  npm run build  to bake the exe into the installer.
echo ════════════════════════════════════════════════════════════════════════════
pause
