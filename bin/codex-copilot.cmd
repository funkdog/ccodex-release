@echo off
rem ---------------------------------------------------------------------------
rem  codex-copilot -- the native Codex CLI, driven by GitHub Copilot.
rem
rem  Identical to `codex` in every way except that it runs against a separate
rem  CODEX_HOME whose model provider is the local GitHub Copilot bridge.
rem  The original `codex` command and its ~/.codex profile are untouched.
rem ---------------------------------------------------------------------------
setlocal EnableExtensions DisableDelayedExpansion
set "NODE_OPTIONS="
set "NODE_PATH="
set "ELECTRON_RUN_AS_NODE="

set "CC_ROOT=%~dp0.."
for %%I in ("%CC_ROOT%") do set "CC_ROOT=%%~fI"

if exist "%CC_ROOT%\release.json" if exist "%CC_ROOT%\runtime\node\node.exe" (
    "%CC_ROOT%\runtime\node\node.exe" "%CC_ROOT%\release\launch.mjs" %*
    exit /b
)

rem The shared guide is available offline before Node, a profile or the bridge.
if /i "%~1"=="showcase" goto :run_showcase

if not defined CODEX_COPILOT_HOME set "CODEX_COPILOT_HOME=%USERPROFILE%\.codex-copilot"
set "CODEX_HOME=%CODEX_COPILOT_HOME%"
set "CODEX_COPILOT_CATALOG_FILE=%CODEX_HOME%\models.json"
set "CODEX_COPILOT_SELECTION_FILE="
if defined NO_PROXY (
    set "NO_PROXY=127.0.0.1,localhost,%NO_PROXY%"
) else (
    set "NO_PROXY=127.0.0.1,localhost"
)
set "no_proxy=%NO_PROXY%"

call :find_node
if not defined CC_NODE (
    echo codex-copilot: could not find Node.js. Install Node.js 20+ and try again. 1>&2
    exit /b 1
)
if /i "%~1"=="history" goto :run_history
set "CC_PORT="
for /f "delims=" %%P in ('""%CC_NODE%" "%CC_ROOT%\bridge\port-selection.mjs" --print"') do if not defined CC_PORT set "CC_PORT=%%P"
if not defined CC_PORT (
    echo codex-copilot: invalid bridge port pointer. Check CODEX_COPILOT_BRIDGE_PORT or %CODEX_HOME%\bridge-port.txt. 1>&2
    exit /b 1
)
set "CODEX_COPILOT_BRIDGE_PORT=%CC_PORT%"

set "CC_SUB=%~1"
if /i "%CC_SUB%"=="login"     goto :run_bridge_cli
if /i "%CC_SUB%"=="logout"    goto :run_bridge_cli
if /i "%CC_SUB%"=="status"    goto :run_bridge_cli
if /i "%CC_SUB%"=="models"    goto :run_bridge_cli
if /i "%CC_SUB%"=="use"       goto :run_bridge_cli
if /i "%CC_SUB%"=="context"   goto :run_bridge_cli
if /i "%CC_SUB%"=="credits"   goto :run_bridge_cli
if /i "%CC_SUB%"=="usage"     goto :run_bridge_cli
if /i "%CC_SUB%"=="sessions"  goto :run_bridge_cli
if /i "%CC_SUB%"=="catalog"   goto :run_bridge_cli
if /i "%CC_SUB%"=="autostart" goto :run_bridge_cli
if /i "%CC_SUB%"=="account"   goto :run_bridge_cli
if /i "%CC_SUB%"=="doctor"    goto :run_bridge_cli
if /i "%CC_SUB%"=="workiq"    goto :run_bridge_cli
if /i "%CC_SUB%"=="history"   goto :run_bridge_cli
if /i "%CC_SUB%"=="verify"    goto :run_bridge_cli
if /i "%CC_SUB%"=="inspect-request" goto :run_bridge_cli
if /i "%CC_SUB%"=="release-update" goto :run_release_update
if /i "%CC_SUB%"=="export"    goto :run_bridge_cli
if /i "%CC_SUB%"=="repair"    goto :run_repair
if /i "%CC_SUB%"=="update"    goto :run_cli_update
if /i "%CC_SUB%"=="desktop"   goto :run_desktop
if /i "%CC_SUB%"=="bridge"    goto :run_bridge_ctl

call :find_codex
if not defined CC_CODEX (
    echo codex-copilot: the enhanced core is missing. Repair the CodexCopilot installation; stock Codex is never used as a fallback. 1>&2
    exit /b 1
)

if /i "%CC_SUB%"=="--version" goto :run_codex_direct
if /i "%CC_SUB%"=="-V"        goto :run_codex_direct
if /i "%CC_SUB%"=="--help"    goto :run_codex_direct
if /i "%CC_SUB%"=="-h"        goto :run_codex_direct

"%CC_NODE%" "%CC_ROOT%\tools\native-runtime.mjs" --cli
if errorlevel 1 exit /b 1

"%CC_NODE%" "%CC_ROOT%\bridge\ensure.mjs"
if errorlevel 1 exit /b 1

"%CC_NODE%" "%CC_ROOT%\bridge\cli-session.mjs" "%CC_CODEX%" %*
exit /b %errorlevel%

:run_codex_direct
"%CC_CODEX%" %*
exit /b %errorlevel%

:run_showcase
where pwsh.exe >nul 2>&1
if errorlevel 1 goto :run_showcase_powershell
pwsh.exe -NoLogo -NoProfile -File "%CC_ROOT%\tools\showcase.ps1"
exit /b %errorlevel%

:run_showcase_powershell
powershell.exe -NoLogo -NoProfile -File "%CC_ROOT%\tools\showcase.ps1"
exit /b %errorlevel%

:run_bridge_cli
set "CODEX_COPILOT_SURFACE=cli"
"%CC_NODE%" "%CC_ROOT%\bridge\cli.mjs" %*
exit /b %errorlevel%

:run_history
set "HISTORY_DEFAULT_PRODUCT=ccodex"
set "CODEX_COPILOT_INSTALL_ROOT=%CC_ROOT%"
"%CC_NODE%" "%CC_ROOT%\tools\history\cli.mjs" %*
exit /b %errorlevel%

:run_repair
"%CC_NODE%" "%CC_ROOT%\tools\gen-config.mjs"
if errorlevel 1 exit /b 1
"%CC_NODE%" "%CC_ROOT%\tools\native-runtime.mjs" --desktop
if errorlevel 1 exit /b 1
"%CC_NODE%" "%CC_ROOT%\bridge\cli.mjs" catalog
exit /b %errorlevel%

:run_cli_update
"%CC_NODE%" "%CC_ROOT%\bridge\cli-update.mjs" %*
exit /b %errorlevel%

:run_release_update
shift
"%CC_NODE%" "%CC_ROOT%\bridge\release-update.mjs" %1 %2 %3 %4 %5
exit /b %errorlevel%

:run_desktop
if /i "%~2"=="update" goto :run_desktop_update
shift
start "" "%CC_ROOT%\bin\codex-copilot-desktop.exe" %1 %2 %3 %4 %5
exit /b 0

:run_desktop_update
shift
shift
"%CC_NODE%" "%CC_ROOT%\bridge\desktop-update-cli.mjs" %1 %2 %3 %4 %5
exit /b %errorlevel%

:run_bridge_ctl
if /i "%~2"=="stop" (
    "%CC_NODE%" "%CC_ROOT%\bridge\control.mjs" stop
    exit /b %errorlevel%
)
if /i "%~2"=="status" (
    "%CC_NODE%" "%CC_ROOT%\bridge\control.mjs" status
    exit /b %errorlevel%
)
"%CC_NODE%" "%CC_ROOT%\bridge\ensure.mjs" --verbose
if errorlevel 1 exit /b 1
"%CC_NODE%" -e "fetch('http://127.0.0.1:'+(process.env.CODEX_COPILOT_BRIDGE_PORT||22690)+'/health').then(r=>r.text()).then(t=>console.log(t))"
exit /b %errorlevel%

rem ---------------------------------------------------------------------------
:find_node
set "CC_NODE="
if exist "%CC_ROOT%\runtime\node\node.exe" (
    set "CC_NODE=%CC_ROOT%\runtime\node\node.exe"
    goto :eof
)
for /f "delims=" %%I in ('where node 2^>nul') do if not defined CC_NODE set "CC_NODE=%%I"
if defined CC_NODE goto :eof
for /f "delims=" %%D in ('dir /b /o-d "%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node" 2^>nul') do (
    if not defined CC_NODE if exist "%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\%%D\bin\node.exe" (
        set "CC_NODE=%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\%%D\bin\node.exe"
    )
)
goto :eof

:find_codex
set "CC_CODEX="
if exist "%CC_ROOT%\bin\core-current.txt" (
    set /p "CC_CODEX="<"%CC_ROOT%\bin\core-current.txt"
)
if defined CC_CODEX if exist "%CC_CODEX%" goto :eof
set "CC_CODEX="
if exist "%CC_ROOT%\bin\codex-copilot-core.next.exe" (
    set "CC_CODEX=%CC_ROOT%\bin\codex-copilot-core.next.exe"
    goto :eof
)
if exist "%CC_ROOT%\bin\codex-copilot-core.exe" (
    set "CC_CODEX=%CC_ROOT%\bin\codex-copilot-core.exe"
    goto :eof
)
goto :eof
