@echo off
cd /d "%~dp0"
:start
npm run build
if errorlevel 1 (
  echo Build failed. Press any key to exit.
  pause > nul
  exit /b 1
)
npm start
if %errorlevel%==75 (
  echo Restarting after update...
  goto start
)
pause
