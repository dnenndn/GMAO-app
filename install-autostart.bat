@echo off
rem Makes the GMAO backend start by itself when this PC boots (no login, no window)
rem and restart if it crashes. Right-click > "Run as administrator".
setlocal
title Install GMAO backend autostart
net session >nul 2>nul || (echo Please right-click this file and choose "Run as administrator". & goto :end)

where node >nul 2>nul || (echo ERROR: Node.js is not installed or not in PATH. & goto :end)
if not exist "%~dp0backend\.env" (echo ERROR: backend\.env is missing. & goto :end)
if not exist "%~dp0backend\node_modules\compression" (echo Installing packages... & pushd "%~dp0backend" & call npm install & popd)

rem Full path of node.exe, so the boot task finds it even without the user's PATH.
for /f "delims=" %%i in ('where node') do (>"%~dp0node-path.txt" echo %%i & goto :got)
:got

schtasks /Create /TN "GMAO Backend" /TR "\"%~dp0run-backend-loop.bat\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
if errorlevel 1 (echo ERROR: could not create the scheduled task. & goto :end)
schtasks /Run /TN "GMAO Backend"
echo.
echo Done. The backend now starts with Windows. Logs: backend\logs\backend.log
echo (If start-backend.bat is open in a window, close it first: only one copy can use port 4000.)
:end
echo.
pause
