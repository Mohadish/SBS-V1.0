@echo off
title SBS License Tools — Issue License
echo.
echo ============================================================
echo   SBS License Tools — Issue a New License
echo ============================================================
echo.

set /p CLIENT_NAME="Client / company name: "
echo.
set /p MACHINE_ID="Client machine ID (from their get_machine_id tool): "
echo.
set /p DAYS="License duration in days (press Enter for 365): "
if "%DAYS%"=="" set DAYS=365

echo.
echo Issuing license...
echo.

python "%~dp0keygen.py" --issue --client "%CLIENT_NAME%" --machine-id "%MACHINE_ID%" --days %DAYS%

echo.
pause
