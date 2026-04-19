@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found on PATH.
  echo Install Python and make sure the ^"python^" command works in Command Prompt.
  pause
  exit /b 1
)
start "step_browser_local_server" cmd /k python "%~dp0local_server.py"
endlocal
