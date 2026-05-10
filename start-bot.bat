@echo off
cd /d "%~dp0"
npm run build
if errorlevel 1 pause && exit /b 1
npm start
pause
