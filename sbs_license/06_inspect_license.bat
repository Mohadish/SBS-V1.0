@echo off
title SBS License Tools — Inspect License
echo.
echo ============================================================
echo   SBS License Tools — Inspect a License File
echo ============================================================
echo.
set /p LIC_FILE="Path to the .lic file (drag and drop it here): "
echo.
python "%~dp0keygen.py" --inspect "%LIC_FILE%"
echo.
pause
