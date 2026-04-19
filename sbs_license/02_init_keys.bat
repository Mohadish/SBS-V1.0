@echo off
title SBS License Tools — Init Keys
echo.
echo ============================================================
echo   SBS License Tools — Generate Key Pair (Run Once!)
echo ============================================================
echo.
echo This generates your private and public signing keys.
echo Run this ONLY ONCE. Keep the keys\ folder private and backed up.
echo.
python "%~dp0keygen.py" --init-keys
echo.
pause
