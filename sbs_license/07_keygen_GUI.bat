@echo off
REM ─────────────────────────────────────────────────────────────────────────
REM   SBS License Issuer — GUI launcher
REM
REM   Double-click to open the friendly form for issuing licenses.
REM   Pre-fills Days=30, generates password + key on click, formats a
REM   ready-to-paste customer message.
REM
REM   First-time setup (run once):
REM     01_setup.bat       — installs `cryptography`
REM     02_init_keys.bat   — generates the Ed25519 keypair
REM ─────────────────────────────────────────────────────────────────────────

cd /d "%~dp0"
python keygen_gui.py
if errorlevel 1 (
  echo.
  echo The GUI exited with an error.  Common causes:
  echo   - Python is not installed or not on PATH.
  echo   - The `cryptography` package is not installed -- run 01_setup.bat.
  echo   - Private key is missing -- run 02_init_keys.bat once.
  echo.
  pause
)
