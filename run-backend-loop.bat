@echo off
rem Runs the GMAO backend forever: if it crashes, it restarts 5 seconds later.
rem Started at Windows boot by the "GMAO Backend" scheduled task (install-autostart.bat).
setlocal
cd /d "%~dp0backend" || exit /b 1
if not exist logs mkdir logs
set "NODE=node"
if exist "%~dp0node-path.txt" set /p NODE=<"%~dp0node-path.txt"
:loop
echo [%date% %time%] starting backend>>logs\backend.log
"%NODE%" src\server.js >>logs\backend.log 2>&1
echo [%date% %time%] backend stopped (code %errorlevel%), restarting in 5 s>>logs\backend.log
timeout /t 5 /nobreak >nul
goto loop
