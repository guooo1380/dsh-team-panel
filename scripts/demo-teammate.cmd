@echo off
chcp 65001 >nul
setlocal
rem ==========================================================================
rem  dsh-team-panel - simulate a second device (demo / self-test only)
rem
rem  Double-click this file, type the invite code, press Enter.
rem  It pretends to be a teammate machine, so on a SINGLE computer you can see
rem  the panel switch to "2/2 online" with two members. The usage numbers are
rem  synthetic - this validates the connection and the display, nothing else.
rem
rem  Usage:
rem    demo-teammate.cmd              hub on 127.0.0.1:7801, asks for the code
rem    demo-teammate.cmd 7801 CODE    custom port + invite code, no prompt
rem
rem  Stop with Ctrl+C. The fake member is removed from the team on exit.
rem
rem  NOTE: ASCII-only on purpose - cmd.exe parses .cmd with the console
rem  codepage (GBK here) and UTF-8 Chinese text corrupts that parsing.
rem  All Chinese messages come from Node.
rem ==========================================================================
set "HERE=%~dp0"
set "PORT=%~1"
set "INVITE=%~2"
if "%PORT%"=="" set "PORT=7801"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.exe not found in PATH. Install Node.js first.
  pause
  exit /b 1
)

if "%INVITE%"=="" set /p INVITE=Invite code: 
if "%INVITE%"=="" (
  echo [ERROR] Invite code required.
  pause
  exit /b 1
)

node "%HERE%fake-device.mjs" http://127.0.0.1:%PORT% %INVITE% --interval 3
pause
