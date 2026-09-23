@echo off
title SBS (installed) - 2nd instance
rem A SECOND window of the INSTALLED SBS, beside the one already running.
rem SBS_PARALLEL=1 makes it run as "SBS Step Browser V0.2.22+": its own
rem userData folder (%APPDATA%\SBS Step Browser V0.2.22+), its own lock,
rem cache and settings. The first time it may ask for the licence key once.
rem Copy this file to the desktop if you like; the path below is the
rem per-user install location.
set SBS_PARALLEL=1
start "" "%LOCALAPPDATA%\Programs\SBS Step Browser\SBS Step Browser.exe"
