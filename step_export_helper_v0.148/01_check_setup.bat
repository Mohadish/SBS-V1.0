@echo off
setlocal
cd /d "%~dp0"
echo STEP export helper setup check...
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 step_export_helper.py --check
  exit /b %errorlevel%
)
where python >nul 2>nul
if %errorlevel%==0 (
  python step_export_helper.py --check
  exit /b %errorlevel%
)
echo Python 3 was not found in PATH.
pause
exit /b 1
