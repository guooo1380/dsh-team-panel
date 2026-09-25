@echo off
chcp 65001 >nul
setlocal
rem ==========================================================================
rem  dsh-team-panel team hub - local mode
rem  Listens on 127.0.0.1 only. Use this together with a tunnel
rem  (cloudflared / ngrok / frp), or when you only test on this machine.
rem
rem  For LAN / Tailscale / VPS use start-hub-public.cmd instead.
rem
rem  NOTE: This file is intentionally ASCII-only. cmd.exe parses .cmd files
rem  using the console codepage (GBK on this machine); UTF-8 Chinese text in a
rem  .cmd file corrupts that parsing. All Chinese messages come from Node.
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

echo Starting dsh-team-panel hub on 127.0.0.1:%PORT% ...
node "%HERE%..\lib\team-hub.mjs" --port %PORT% --data "%HERE%..\data\team-hub-data.json"
pause
