@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Piper helper is not installed yet.
  call "%~dp0install_piper_tts_helper.bat"
  if errorlevel 1 exit /b 1
)

set "STEP_BROWSER_PIPER_VOICE_DIR=%cd%\voices"
set "STEP_BROWSER_PIPER_DEFAULT_VOICE=en_US-lessac-high"
set "STEP_BROWSER_TTS_HOST=127.0.0.1"
set "STEP_BROWSER_TTS_PORT=8765"

call ".venv\Scripts\python.exe" "%~dp0piper_tts_helper.py"
pause
