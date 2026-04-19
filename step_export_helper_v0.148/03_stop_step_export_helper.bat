@echo off
setlocal
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8766 ^| findstr LISTENING') do (
  echo Stopping PID %%p on port 8766...
  taskkill /PID %%p /F
)
echo Done.
pause
