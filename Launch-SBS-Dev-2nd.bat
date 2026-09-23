@echo off
title SBS Dev (2nd instance)
rem ─────────────────────────────────────────────────────────────
rem  A SECOND SBS beside the one already running (compare two
rem  projects, two steps, two lenses). SBS_PARALLEL=1 gives it its
rem  own userData folder (…\sbs-step-browser-2): its own lock,
rem  cache and settings, with the licence copied over the first time.
rem  Same code, same checkout — just a second window.
rem ─────────────────────────────────────────────────────────────
cd /d "E:\SBS-dev-V0.3.1\sbs-app"
set SBS_PARALLEL=1
call npm start
if errorlevel 1 (
  echo.
  echo SBS exited with an error. Window kept open so you can read it.
  pause
)
