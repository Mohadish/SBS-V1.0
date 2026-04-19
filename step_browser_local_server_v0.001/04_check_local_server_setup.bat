@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Python was not found on PATH.
) else (
  echo [ OK ] Python is available.
)
if exist "%~dp0step_browser_local_server_config.json" (
  echo [ OK ] Config file exists.
) else (
  echo [FAIL] Config file is missing.
)
echo.
echo Place this folder next to:
echo   step_browser_runtime
echo   step_browser_poc_v0.222
endlocal
