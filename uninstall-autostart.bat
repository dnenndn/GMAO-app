@echo off
rem Removes the boot task created by install-autostart.bat (run as administrator).
net session >nul 2>nul || (echo Please right-click this file and choose "Run as administrator". & pause & exit /b 1)
schtasks /End /TN "GMAO Backend" >nul 2>nul
schtasks /Delete /TN "GMAO Backend" /F
taskkill /F /FI "WINDOWTITLE eq GMAO*" >nul 2>nul
echo Done. If the backend is still running, restart the PC or end node.exe in Task Manager.
pause
