@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "PATH=%~dp0;%PATH%"
echo Ccodex CLI. Use ccodex --version, features, or login --force.
cmd.exe /d /k
exit /b %errorlevel%
