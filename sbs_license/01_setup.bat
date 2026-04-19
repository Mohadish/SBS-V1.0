@echo off
title SBS License Tools — Setup
echo.
echo ============================================================
echo   SBS License Tools — One-Time Setup
echo ============================================================
echo.
echo This will install the 'cryptography' Python package needed
echo by the license system.
echo.

REM Check Python is available
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not installed or not in PATH.
    echo Download Python from https://www.python.org/downloads/
    echo Make sure to check "Add Python to PATH" during install.
    echo.
    pause
    exit /b 1
)

echo Installing cryptography package...
python -m pip install cryptography --quiet
if errorlevel 1 (
    echo.
    echo ERROR: Failed to install cryptography.
    echo Try running this script as Administrator.
    echo.
    pause
    exit /b 1
)

echo.
echo Setup complete!
echo.
echo NEXT STEPS (for Nadav only):
echo   Run 02_init_keys.bat to generate your private/public key pair.
echo.
pause
