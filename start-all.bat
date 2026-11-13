@echo off
rem Starts the backend in its own window. The public address (https://gmao.ibb.sarl)
rem is served by the Cloudflare Tunnel Windows service, which starts with the PC.
setlocal
start "GMAO backend" "%~dp0start-backend.bat"
