@echo off
setlocal
cd /d "%~dp0"
if not exist jobs mkdir jobs
start "" "%cd%\jobs"
