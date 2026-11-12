@echo off
rem ---------------------------------------------------------------------------
rem  ccodex -- short alias for codex-copilot that starts in a fixed workspace.
rem
rem  Codex has no config key for a default working directory, so the launch
rem  directory is pinned here. Escape hatches:
rem    set CCODEX_WORKSPACE=<dir>  use a different workspace
rem    set CCODEX_NO_CD=1          keep the current directory
rem    ccodex -C <dir> ...         Codex's own working-directory flag
rem ---------------------------------------------------------------------------
setlocal EnableExtensions

if not defined CCODEX_WORKSPACE set "CCODEX_WORKSPACE=%USERPROFILE%\Ccodex Workspace"

set "CC_CD=1"
if defined CCODEX_NO_CD set "CC_CD="
if /i "%~1"=="-C" set "CC_CD="
if /i "%~1"=="--cd" set "CC_CD="
if /i "%~2"=="-C" set "CC_CD="
if /i "%~2"=="--cd" set "CC_CD="
if /i "%~1"=="showcase" set "CC_CD="

if defined CC_CD (
    if not exist "%CCODEX_WORKSPACE%" mkdir "%CCODEX_WORKSPACE%" 2>nul
    if exist "%CCODEX_WORKSPACE%" cd /d "%CCODEX_WORKSPACE%"
)

set "CC_SUB=%~1"
call :set_animation_colors
if /i "%CC_SUB%"=="showcase" goto :run_showcase
rem Empty bracketed-paste image events are handled by the patched native core.
rem Keep the interactive process attached directly to the terminal: nesting it in
rem another ConPTY can randomly drop otherwise valid synchronized redraw rows.
set "CCODEX_USE_PROXY="

call :reset_terminal_input
call "%~dp0codex-copilot.cmd" %*
set "CC_EXIT=%errorlevel%"
call :reset_terminal_input
exit /b %CC_EXIT%

:run_showcase
call "%~dp0codex-copilot.cmd" %*
exit /b %errorlevel%

:set_animation_colors
if /i "%CC_SUB%"=="credits"     goto :eof
if /i "%CC_SUB%"=="history"     goto :eof
if /i "%CC_SUB%"=="exec"        goto :eof
if /i "%CC_SUB%"=="e"           goto :eof
if /i "%CC_SUB%"=="review"      goto :eof
if /i "%CC_SUB%"=="mcp"         goto :eof
if /i "%CC_SUB%"=="plugin"      goto :eof
if /i "%CC_SUB%"=="mcp-server"  goto :eof
if /i "%CC_SUB%"=="app-server"  goto :eof
if /i "%CC_SUB%"=="remote-control" goto :eof
if /i "%CC_SUB%"=="app"         goto :eof
if /i "%CC_SUB%"=="completion"  goto :eof
if /i "%CC_SUB%"=="update"      goto :eof
if /i "%CC_SUB%"=="doctor"      goto :eof
if /i "%CC_SUB%"=="workiq"      goto :eof
if /i "%CC_SUB%"=="sandbox"     goto :eof
if /i "%CC_SUB%"=="debug"       goto :eof
if /i "%CC_SUB%"=="apply"       goto :eof
if /i "%CC_SUB%"=="archive"     goto :eof
if /i "%CC_SUB%"=="delete"      goto :eof
if /i "%CC_SUB%"=="unarchive"   goto :eof
if /i "%CC_SUB%"=="exec-server" goto :eof
set "NO_COLOR="
set "FORCE_COLOR=3"
set "COLORTERM=truecolor"
goto :eof

:reset_terminal_input
if /i "%CC_SUB%"=="credits" goto :eof
if /i "%CC_SUB%"=="history" goto :eof
if /i "%CC_SUB%"=="--version" goto :eof
if /i "%CC_SUB%"=="-V" goto :eof
if /i "%CC_SUB%"=="--help" goto :eof
if /i "%CC_SUB%"=="-h" goto :eof
powershell.exe -NoLogo -NoProfile -NonInteractive -Command "if ([Console]::IsOutputRedirected) { exit 1 }"
if errorlevel 1 goto :eof
for /F "delims=" %%E in ('echo prompt $E^| cmd') do set "CC_ESC=%%E"
<nul set /p "=%CC_ESC%[?1000;1002;1003;1004;1006;1015;1016l"
set "CC_ESC="
goto :eof
