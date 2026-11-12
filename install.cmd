@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo Installing Codex (Copilot)...
echo.
where pwsh.exe >nul 2>&1
if errorlevel 1 goto :legacy_powershell
pwsh.exe -NoProfile -File "%~dp0tools\Invoke-HeavyTask.ps1" "& '%~dp0install.ps1' %*"
goto :installed
:legacy_powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\Invoke-HeavyTask.ps1" "& '%~dp0install.ps1' %*"
:installed
set "INSTALL_EXIT=%ERRORLEVEL%"

echo.
if not "%INSTALL_EXIT%"=="0" (
    echo Installation failed with exit code %INSTALL_EXIT%.
) else (
    echo Installation completed. Open a new terminal before running ccodex.
)
echo.
if not defined CODEX_COPILOT_NO_PAUSE pause
exit /b %INSTALL_EXIT%
