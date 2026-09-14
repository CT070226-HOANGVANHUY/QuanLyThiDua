@echo off
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"
node --experimental-strip-types src/server.ts
if errorlevel 1 pause
