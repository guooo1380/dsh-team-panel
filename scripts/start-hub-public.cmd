@echo off
chcp 65001 >nul
setlocal
rem ==========================================================================
rem  dsh-team-panel team hub - public mode (LAN / Tailscale / VPS)
rem  Listens on 0.0.0.0 so other machines can connect.
rem
rem  After start, the banner prints the exact address your teammates should use.
rem  Two things to check:
rem    1) run allow-firewall.cmd as Administrator (inbound port)
rem    2) for the public internet put HTTPS in front (Caddy), or use a tunnel
rem
rem  NOTE: ASCII-only on purpose - cmd.exe parses .cmd with the console
rem  codepage (GBK here) and UTF-8 Chinese text corrupts that parsing.
rem  All Chinese messages come from Node.
rem ==========================================================================
set "HERE=%~dp0"
set "PORT=%~1"
if "%PORT%"=="" set "PORT=7801"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.exe not found in PATH. Install Node.js first.
  pause
  exit /b 1
)

echo Starting dsh-team-panel hub on 0.0.0.0:%PORT% ...
node "%HERE%..\lib\team-hub.mjs" --public --port %PORT% --data "%HERE%..\data\team-hub-data.json"
pause
