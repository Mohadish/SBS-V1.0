@echo off
title SBS License Tools — Issue Master License
echo.
echo ============================================================
echo   SBS License Tools — Issue a MASTER License
echo ============================================================
echo.
echo A master license has NO machine lock and NO expiry date.
echo Use this for your own team only.
echo.

set /p CLIENT_NAME="Name for this master license (e.g. SBS Internal): "
echo.
echo Issuing master license...
echo.

python "%~dp0keygen.py" --issue --master --client "%CLIENT_NAME%"

echo.
pause
