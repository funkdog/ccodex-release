@echo off
setlocal EnableExtensions
if exist "%~dp0..\..\.ccodex-dev-install.json" (
    call "%~dp0..\..\commands\ccodex-dev.cmd" history ui --open %*
    exit /b
)
if exist "%~dp0..\..\bin\codex-copilot.cmd" goto :ccodex
set "HISTORY_DEFAULT_PRODUCT=copilot"
node "%~dp0cli.mjs" ui --open %*
exit /b %errorlevel%
:ccodex
call "%~dp0..\..\bin\codex-copilot.cmd" history ui --open %*
exit /b %errorlevel%
