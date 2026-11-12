@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "NODE_OPTIONS="
set "NODE_PATH="
set "ELECTRON_RUN_AS_NODE="
set "CC_RELEASE_ROOT=%~dp0."
set "CC_RELEASE_ID="
if not exist "%~dp0current.txt" goto :already_uninstalled
set /p "CC_RELEASE_ID="<"%~dp0current.txt"
if not defined CC_RELEASE_ID exit /b 1
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0versions\%CC_RELEASE_ID%\release\uninstall-bootstrap.ps1" -InstallRoot "%~dp0." %*
exit /b %errorlevel%

:already_uninstalled
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop';try{$m=Get-Content -LiteralPath (Join-Path $env:CC_RELEASE_ROOT '.ccodex-release-install.json') -Raw -Encoding UTF8|ConvertFrom-Json;if($m.product -ne 'CCodexRelease' -or $m.uninstalled -ne $true){throw 'Unrecognized installation state'};Write-Output 'CCodex Release is already uninstalled. Preserved profile data was not changed.';exit 0}catch{Write-Error $_;exit 1}"
exit /b %errorlevel%
