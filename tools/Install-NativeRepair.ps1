[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ReportDirectory,
    [Parameter(Mandatory)][string]$PassedTestResult,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexCopilot'),
    [string]$Profile = (Join-Path $env:USERPROFILE '.codex-copilot'),
    [switch]$HistoryOnly,
    [switch]$ExtensionsOnly
)
$ErrorActionPreference = 'Stop'
if ($HistoryOnly -and $ExtensionsOnly) { throw 'Choose only one surgical installation mode.' }
if ((Get-Process -Id $PID).PriorityClass -ne 'BelowNormal' -or $env:CARGO_BUILD_JOBS -ne '6') {
    throw 'Run deployment through tools\Invoke-HeavyTask.ps1.'
}
$tests = Get-Content -LiteralPath $PassedTestResult -Raw | ConvertFrom-Json
if ($tests.exitCode -ne 0 -or -not $tests.temporaryFilesRemoved -or $tests.remainingOwnedPids.Count -or
    -not $tests.fullGate -or -not $tests.sourceUnchanged) {
    throw 'A clean, passing isolated regression run is required before deployment.'
}
if ($tests.processCleanupVerified -ne $true -or $tests.remainingTrackedPids.Count) {
    throw 'Verified test-process lifetime cleanup is required before deployment.'
}
if ($tests.requiredRuntimeCoverage -ne $true -or $null -eq $tests.testCounts -or
    $tests.testCounts.tests -le 0 -or $tests.testCounts.pass -ne $tests.testCounts.tests -or
    $tests.testCounts.fail -ne 0 -or $tests.testCounts.cancelled -ne 0 -or
    $tests.testCounts.skipped -ne 0 -or $tests.testCounts.todo -ne 0) {
    throw 'Verified native core, CLI core and runtime coverage with no skipped tests is required before deployment.'
}
$source = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$inventory = (& node (Join-Path $PSScriptRoot 'native-repair-inventory.mjs') $source | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Complete repair dependency inventory could not be validated.' }
$files = @($inventory | ConvertFrom-Json)
if ($tests.sourceRoot -ne $source -or $tests.sourceFiles.Count -ne $files.Count) {
    throw 'Regression evidence does not describe this repair source.'
}
foreach ($relative in $files) {
    $file = [IO.Path]::GetFullPath((Join-Path $source $relative))
    if (-not $file.StartsWith($source.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Repair manifest path escaped the source root.'
    }
    $verified = @($tests.sourceFiles | Where-Object { $_.path -eq $relative })
    if ($verified.Count -ne 1 -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $verified[0].sha256) {
        throw "Repair source changed after verification: $relative. Rerun the isolated gate."
    }
    if ($HistoryOnly) {
        $historyFiles = @(
            'bin/codex-copilot.cmd', 'bridge/cli.mjs', 'bridge/desktop-extension-files.mjs',
            'install.ps1', 'README.md', 'RELEASE_NOTES.md', 'tools/sync-history-kit.mjs',
            'tools/history/manager.mjs', 'tools/history/backends.mjs', 'tools/history/server.mjs',
            'tools/history/cli.mjs', 'tools/history/ui.html', 'tools/history/desktop.cmd',
            'tools/history/desktop.sh'
        )
        $files = @($files | Where-Object { $_ -in $historyFiles })
        if ($files.Count -ne $historyFiles.Count) {
            throw 'The passing full gate does not bind every history installation input.'
        }
    }
}
$install = [IO.Path]::GetFullPath($InstallRoot)
$profileHome = [IO.Path]::GetFullPath($Profile)
$report = [IO.Path]::GetFullPath($ReportDirectory)
$staging = Join-Path ([IO.Path]::GetTempPath()) ('ccodex-native-deploy-' + [guid]::NewGuid().ToString('N'))
$backup = Join-Path $report ('backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $staging, $backup -Force | Out-Null
$pointer = Join-Path $install 'bin\core-current.txt'
$beforePointer = Get-Content -LiteralPath $pointer -Raw
$beforeCoreHash = (Get-FileHash -LiteralPath $beforePointer.Trim() -Algorithm SHA256).Hash
$manifest = @()
try {
    if (-not $HistoryOnly -and -not $ExtensionsOnly) {
        $csc = @(
            'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
            'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
        ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if (-not $csc) { throw 'The C# compiler is required; a stale launcher must not be reused.' }
        $launcher = Join-Path $staging 'codex-copilot-desktop.exe'
        $icon = Join-Path $source 'assets\codex-copilot.ico'
        Write-Output "Deployment worker PID: $PID; compiler will inherit BelowNormal."
        $compilerArguments = @(
            '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+',
            ('/out:"' + $launcher + '"'), ('/win32icon:"' + $icon + '"'),
            '/reference:System.dll', '/reference:System.Core.dll',
            '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
            ('"' + (Join-Path $source 'src\CodexCopilotDesktop.cs') + '"')
        )
        $compiler = Start-Process -FilePath $csc -ArgumentList $compilerArguments -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $report 'compiler-output.log') `
            -RedirectStandardError (Join-Path $report 'compiler-errors.log')
        Write-Output "Compiler PID: $($compiler.Id)"
        [ordered]@{ workerPid = $PID; compilerPid = $compiler.Id; compilerExited = $false } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $report 'deployment-processes.json') -Encoding utf8
        $compiler.WaitForExit()
        if ($compiler.ExitCode -ne 0) { throw 'Desktop launcher compilation failed; see compiler-errors.log.' }
        [ordered]@{ workerPid = $PID; compilerPid = $compiler.Id; compilerExited = $true } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $report 'deployment-processes.json') -Encoding utf8
        Copy-Item -LiteralPath $launcher -Destination (Join-Path $source 'bin\codex-copilot-desktop.exe') -Force
        $files += 'bin\codex-copilot-desktop.exe'
        Copy-Item -LiteralPath (Join-Path $profileHome 'config.toml') -Destination (Join-Path $backup 'config.toml')
    }
    Copy-Item -LiteralPath $pointer -Destination (Join-Path $backup 'core-current.txt')
    foreach ($relative in $files) {
        $from = if ($relative -eq 'bin\codex-copilot-desktop.exe') { $launcher } else { Join-Path $source $relative }
        $to = [IO.Path]::GetFullPath((Join-Path $install $relative))
        if (-not $to.StartsWith($install.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Deployment path escaped the explicitly selected installation: $to"
        }
        if (-not (Test-Path -LiteralPath $from -PathType Leaf)) { throw "Missing repair file: $from" }
        if (Test-Path -LiteralPath $to) {
            $saved = Join-Path $backup $relative
            New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force | Out-Null
            Copy-Item -LiteralPath $to -Destination $saved
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force | Out-Null
        $temporary = "$to.native-repair-$PID"
        Copy-Item -LiteralPath $from -Destination $temporary
        Move-Item -LiteralPath $temporary -Destination $to -Force
        $hash = (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash
        if ($hash -ne (Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash) { throw "Deployment checksum failed: $relative" }
        $manifest += [ordered]@{ path = $relative; sha256 = $hash }
    }
    $env:CODEX_HOME = $profileHome
    $env:CODEX_COPILOT_HOME = $profileHome
    if (-not $HistoryOnly -and -not $ExtensionsOnly) {
        & node (Join-Path $install 'tools\gen-config.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Configuration migration failed; the backup was preserved.' }
        & node (Join-Path $install 'tools\native-runtime.mjs') --desktop --json
        if ($LASTEXITCODE -ne 0) { throw 'Native runtime reconciliation failed.' }
    } elseif ($HistoryOnly) {
        $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
        New-Item -ItemType Directory -Path $programs -Force | Out-Null
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut((Join-Path $programs 'Codex (Copilot) History.lnk'))
        $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\cmd.exe'
        $shortcut.Arguments = "/d /c `"`"$install\tools\history\desktop.cmd`"`""
        $shortcut.WorkingDirectory = $install
        $shortcut.IconLocation = "$(Join-Path $install 'assets\codex-copilot.ico'),0"
        $shortcut.Description = 'Local ccodex batch history manager with exact operation previews'
        $shortcut.Save()
    }
    if ((Get-Content -LiteralPath $pointer -Raw) -ne $beforePointer -or
        (Get-FileHash -LiteralPath $beforePointer.Trim() -Algorithm SHA256).Hash -ne $beforeCoreHash) {
        throw 'The pinned CLI core unexpectedly changed.'
    }
    $generation = (& node --input-type=module -e `
        'import {pathToFileURL} from "node:url"; const runtime = await import(pathToFileURL(process.argv[1])); console.log(runtime.bridgeSourceGeneration());' `
        (Join-Path $install 'bridge\runtime-generation.mjs') | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $generation -notmatch '^[a-f0-9]{64}$') {
        throw 'Unable to verify the installed bridge source generation.'
    }
    $health = $null
    $port = (& node (Join-Path $install 'bridge\port-selection.mjs') --print | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $port -notmatch '^\d+$') {
        throw 'The selected installed bridge port could not be verified.'
    }
    try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 5 } catch {}
    $activationRequired = $health.bridge -ne 'codex-copilot' -or $health.runtime.sourceGeneration -ne $generation
    [ordered]@{
        checkedAt = (Get-Date).ToString('o')
        expectedGeneration = $generation; runningGeneration = $health.runtime.sourceGeneration
        runningPid = $health.pid; activeRequests = $health.activeRequests
        activationRequired = $activationRequired; processesStopped = @()
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $report 'bridge-activation.json') -Encoding utf8
    [ordered]@{
        schemaVersion = 1; deployedAt = (Get-Date).ToString('o')
        workerPid = $PID; priority = (Get-Process -Id $PID).PriorityClass.ToString()
        installRoot = $install; backup = $backup; files = $manifest
        cliCoreUnchanged = $true; processesStopped = @()
        historyOnly = [bool]$HistoryOnly
        extensionsOnly = [bool]$ExtensionsOnly
        profileConfigurationChanged = -not ([bool]$HistoryOnly -or [bool]$ExtensionsOnly)
        bridgeActivationRequired = $activationRequired
        passedTestResult = [IO.Path]::GetFullPath($PassedTestResult)
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $report 'deployment-result.json') -Encoding utf8
    Write-Output "Repair files deployed. Bridge activation required: $activationRequired. Backup: $backup. No live process was stopped."
} finally {
    $resolved = [IO.Path]::GetFullPath($staging)
    if ((Split-Path -Parent $resolved) -ne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') -or
        (Split-Path -Leaf $resolved) -notlike 'ccodex-native-deploy-*') {
        throw 'Refusing cleanup outside the owned deployment staging directory.'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
