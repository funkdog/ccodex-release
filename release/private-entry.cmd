@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "NODE_OPTIONS="
set "NODE_PATH="
set "ELECTRON_RUN_AS_NODE="
"%~dp0..\runtime\node\node.exe" "%~dp0..\release\launch.mjs" %*
exit /b %errorlevel%
