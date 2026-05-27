@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM  SBS app launcher — runs the Electron dev shell from this folder.
REM  Double-click to start. Console stays open on error so you can read it.
REM ─────────────────────────────────────────────────────────────────────────────

setlocal
title SBS Step Browser  V0.2.22+
cd /d "%~dp0"

REM SBS_PARALLEL=1 tells electron/main.js to rename the app so it gets a
REM SEPARATE userData dir + single-instance lock key — this build can run
REM alongside the V0.2.21 stable build without colliding.
set SBS_PARALLEL=1

if not exist "node_modules\" (
  echo.
  echo [!] node_modules\ missing. Running 'npm install' first...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [X] npm install failed. Check the messages above.
    pause
    exit /b 1
  )
)

call npm start
if errorlevel 1 (
  echo.
  echo [X] App exited with an error. See messages above.
  pause
)

endlocal
