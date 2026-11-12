@echo off
setlocal EnableExtensions DisableDelayedExpansion
for %%I in ("%~dp0..") do set "CC_DEV_ROOT=%%~fI"
set "CC_DEV_NODE="
for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined CC_DEV_NODE set "CC_DEV_NODE=%%I"
if not defined CC_DEV_NODE (
    echo ccodex-dev: Node.js is missing from the developer machine. 1>&2
    exit /b 1
)
if /i "%~1"=="sync" (
    "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%CC_DEV_ROOT%\developer\install-dev.ps1" -InstallRoot "%CC_DEV_ROOT%"
    exit /b
)
"%CC_DEV_NODE%" "%CC_DEV_ROOT%\developer\launch.mjs" %*
exit /b %errorlevel%
