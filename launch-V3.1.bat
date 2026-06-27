@echo off
title SBS - V0.3.0.x  (new render / ambient occlusion)
cd /d "%~dp0sbs-app"

echo ===========================================================
echo   SBS - NEW RENDER build  (V0.3.0.x  -  N8AO test line)
echo ===========================================================
echo   Folder: %CD%
echo.

rem node_modules is NOT created by git-worktree. Link it from the V0.2.22+
rem worktree (instant); fall back to a full npm install if that fails.
if not exist "node_modules\" (
  echo node_modules not found - linking from the V0.2.22+ worktree...
  mklink /J node_modules "%~dp0..\V0.2.22+\sbs-app\node_modules" >nul 2>&1
  if errorlevel 1 (
    echo   link failed - running a full npm install ^(slow, one time^)...
    call npm install
  )
)

echo Launching the Electron app... close the app window to quit.
echo.
call npm start

echo.
echo App closed.
pause
