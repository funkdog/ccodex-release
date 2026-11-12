@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "NODE_OPTIONS="
set "NODE_PATH="
set "ELECTRON_RUN_AS_NODE="
for %%I in ("%~dp0..") do set "CC_RELEASE_ROOT=%%~fI"
set "CC_RELEASE_ID="
if exist "%CC_RELEASE_ROOT%\current.txt" set /p "CC_RELEASE_ID="<"%CC_RELEASE_ROOT%\current.txt"
if not defined CC_RELEASE_ID (
    echo CCodex Release is not installed. Run the ARM64 setup package. 1>&2
    exit /b 1
)
set "CC_RELEASE_SLOT=%CC_RELEASE_ROOT%\versions\%CC_RELEASE_ID%"
if not exist "%CC_RELEASE_SLOT%\runtime\node\node.exe" (
    echo CCodex Release runtime is missing. Repair with the same setup package. 1>&2
    exit /b 1
)
"%CC_RELEASE_SLOT%\runtime\node\node.exe" "%CC_RELEASE_SLOT%\release\launch.mjs" @@COMMAND@@ %*
exit /b
