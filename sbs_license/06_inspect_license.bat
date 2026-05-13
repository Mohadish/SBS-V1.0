@echo off
title SBS License Tools - Verify License Tuple
echo.
echo ============================================================
echo   SBS License Tools - Verify a (email, password, key, mid) tuple
echo   Same logic the SBS app runs at boot.
echo ============================================================
echo.
set /p EMAIL="Client email: "
set /p PASSWORD="Password (8 chars, hyphenated): "
set /p KEY_VAL="Key (long base64 string): "
set /p MACHINE_ID="Client machine ID: "
echo.
python "%~dp0keygen.py" --verify --email "%EMAIL%" --password "%PASSWORD%" --key "%KEY_VAL%" --machine-id "%MACHINE_ID%"
echo.
pause
