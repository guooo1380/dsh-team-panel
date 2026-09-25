@echo off
chcp 65001 >nul
setlocal EnableExtensions
rem ==========================================================================
rem  dsh-team-panel - allow inbound port in Windows Firewall (needs Administrator)
rem
rem  Usage:
rem    scripts\allow-firewall.cmd            allow port 7801
rem    scripts\allow-firewall.cmd 7900       allow a custom port
rem    scripts\allow-firewall.cmd remove     remove the rules added by this script
rem
rem  Only needed when the hub runs on THIS machine and teammates connect from
rem  other machines. Local-only use, a Cloudflare tunnel, or a VPS behind a
rem  reverse proxy do not need this.
rem
rem  NOTE: ASCII-only on purpose - cmd.exe parses .cmd with the console
rem  codepage (GBK here) and UTF-8 Chinese text corrupts that parsing.
rem ==========================================================================
set "PORT=%~1"
set "RULE=dsh-team-panel hub"
if /i "%PORT%"=="remove" goto :remove
if "%PORT%"=="" set "PORT=7801"

net session >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Administrator rights required.
  echo         Right-click this file and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

echo Allowing inbound TCP port %PORT% ^(rule name: %RULE%-%PORT%^) ...
netsh advfirewall firewall delete rule name="%RULE%-%PORT%" >nul 2>nul
netsh advfirewall firewall add rule name="%RULE%-%PORT%" dir=in action=allow protocol=TCP localport=%PORT% profile=any
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to add the firewall rule.
  pause
  exit /b 1
)

echo.
echo Done. Local IPv4 addresses of this machine:
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4"') do echo     %%i
echo.
echo Teammates can now connect using http://^<one of the addresses above^>:%PORT%
echo Undo with:  scripts\allow-firewall.cmd remove
echo.
pause
exit /b 0

:remove
net session >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Administrator rights required.
  pause
  exit /b 1
)
echo Removing rules named %RULE%-* ...
netsh advfirewall firewall delete rule name="%RULE%-7801" >nul 2>nul
netsh advfirewall firewall delete rule name="%RULE%-7900" >nul 2>nul
echo Done. For other ports remove the rule manually in Windows Defender Firewall.
pause
exit /b 0
