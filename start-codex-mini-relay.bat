@echo off
setlocal

cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows-relay.ps1"
set "CODEX_MINI_EXIT_CODE=%errorlevel%"

echo.
echo Codex Relay stopped.
pause
exit /b %CODEX_MINI_EXIT_CODE%
