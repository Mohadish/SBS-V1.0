@echo off
setlocal
for /f "tokens=2 delims=," %%A in ('tasklist /v /fo csv ^| findstr /i "step_browser_local_server"') do (
  taskkill /f /pid %%~A >nul 2>nul
)
echo Attempted to stop local server windows named step_browser_local_server.
endlocal
