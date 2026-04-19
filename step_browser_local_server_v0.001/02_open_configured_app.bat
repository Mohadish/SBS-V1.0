@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found on PATH.
  pause
  exit /b 1
)
python - <<'PY'
import json
from pathlib import Path
cfg = json.loads(Path('step_browser_local_server_config.json').read_text(encoding='utf-8'))
print(f"http://{cfg['host']}:{cfg['port']}{cfg['default_app_relative_url']}")
PY > _open_url.txt
set /p TARGET_URL=< _open_url.txt
if exist _open_url.txt del /q _open_url.txt
start "" "%TARGET_URL%"
endlocal
