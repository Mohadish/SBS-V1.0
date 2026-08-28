@echo off
title SBS Dev (v0.3.1-dev)
rem ─────────────────────────────────────────────────────────────
rem  Launches the SBS dev build from the PERMANENT worktree.
rem  Location: E:\SBS-dev-V0.3.1  (moved out of .claude\worktrees,
rem  which is harness-managed and deletes hand-made folders).
rem ─────────────────────────────────────────────────────────────
cd /d "E:\SBS-dev-V0.3.1\sbs-app"
call npm start
if errorlevel 1 (
  echo.
  echo SBS exited with an error. Window kept open so you can read it.
  pause
)
