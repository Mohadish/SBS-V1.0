@echo off
title SBS License Tools - Issue License
echo.
echo ============================================================
echo   SBS License Tools - Issue a New License (v2)
echo ============================================================
echo.

set /p EMAIL="Client email address: "
echo.
set /p MACHINE_ID="Client machine ID (32 hex chars): "
echo.
set /p DAYS="License duration in days (press Enter for 30): "
if "%DAYS%"=="" set DAYS=30

echo.
echo Issuing license...
echo.

python "%~dp0keygen.py" --issue --email "%EMAIL%" --machine-id "%MACHINE_ID%" --days %DAYS%

echo.
echo Copy BOTH the password AND the key above. Send both to the client.
echo (The audit log was saved in issued_licenses/.)
echo.
pause
