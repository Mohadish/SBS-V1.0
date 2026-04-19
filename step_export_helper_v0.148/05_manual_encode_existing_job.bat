@echo off
setlocal
cd /d "%~dp0"
set /p JOB_PATH=Paste full path of an existing helper job folder: 
if "%JOB_PATH%"=="" exit /b 0
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 step_export_helper.py --encode-job "%JOB_PATH%"
  pause
  exit /b %errorlevel%
)
where python >nul 2>nul
if %errorlevel%==0 (
  python step_export_helper.py --encode-job "%JOB_PATH%"
  pause
  exit /b %errorlevel%
)
echo Python 3 was not found in PATH.
pause
exit /b 1
