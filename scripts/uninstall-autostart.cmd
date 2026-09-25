@echo off
chcp 65001 >nul
setlocal EnableExtensions
rem ==========================================================================
rem  dsh-team-panel - remove the auto-start task for the team hub
rem  Usage (needs Administrator): scripts\uninstall-autostart.cmd
rem
rem  NOTE: ASCII-only on purpose - cmd.exe parses .cmd with the console
rem  codepage (GBK here) and UTF-8 Chinese text corrupts that parsing.
rem ==========================================================================
set "HERE=%~dp0"
set "TASK=dsh-team-panel hub"
set "RUNNER=%HERE%_hub-autostart.cmd"

net session >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Administrator rights required.
  echo         Right-click this file and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

echo Stopping and deleting scheduled task "%TASK%" ...
schtasks /end /tn "%TASK%" >nul 2>nul
schtasks /delete /tn "%TASK%" /f
if errorlevel 1 (
  echo [WARN] Delete failed, or the task did not exist. Check Task Scheduler.
) else (
  echo Deleted.
)

if exist "%RUNNER%" (
  del /q "%RUNNER%" >nul 2>nul
  echo Removed runner %RUNNER%
)

echo.
echo Note: the data file was NOT deleted. It still holds your team, invite code
echo and member ledger:
echo   %HERE%..\data\team-hub-data.json
echo Remove it manually if you want a clean slate.
echo.
pause
exit /b 0
