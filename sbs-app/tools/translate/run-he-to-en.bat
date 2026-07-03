@echo off
REM Drag a .sbsproj onto this file to translate Hebrew -> English.
REM Requires: Node installed, google-key.txt (this folder) holding your Google
REM Cloud API key on one line, and the Cloud Translation API enabled.
setlocal
cd /d "%~dp0"
if "%~1"=="" ( echo Drag a .sbsproj file onto this .bat ^(or pass its path^). & pause & exit /b 1 )
if not exist "google-key.txt" ( echo Missing google-key.txt — put your Google Cloud API key in it. & pause & exit /b 1 )
set /p KEY=<google-key.txt
set "GOOGLE_API_KEY=%KEY%"
set "OUT=%~dpn1-EN.sbsproj"
echo Translating "%~nx1" -^> "%~nxdOUT%" ...
node translate-project.js "%~1" "%OUT%" --src iw --tgt en --voice "os:kokoro|am_echo"
echo.
echo Done. Output: "%OUT%"
pause
