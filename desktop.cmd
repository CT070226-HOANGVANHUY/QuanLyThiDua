@echo off
cd /d "%~dp0"
if exist "node_modules\electron\dist\electron.exe" (
  "node_modules\electron\dist\electron.exe" .
  exit /b %ERRORLEVEL%
)
echo Chua cai Electron. Mo Command Prompt (khong phai PowerShell) roi chay:
echo   npm.cmd install
pause
