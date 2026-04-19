@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0docs\fetch_runtime_files.ps1"
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo Runtime fetch finished with errors. See runtime_fetch_log.txt and runtime_fetch_errors.txt
) else (
  echo.
  echo Runtime fetch completed successfully.
)
endlocal & exit /b %ERR%
