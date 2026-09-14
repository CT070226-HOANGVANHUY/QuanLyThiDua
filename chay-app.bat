@echo off
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "dist\QuanLyThiDua-win32-x64\QuanLyThiDua.exe" (
  start "" "dist\QuanLyThiDua-win32-x64\QuanLyThiDua.exe"
  goto :eof
)
call npx --yes electron .
if errorlevel 1 pause
