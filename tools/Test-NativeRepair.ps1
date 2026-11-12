[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ReportDirectory,
    [string]$NativeCore,
    [string]$CliCore,
    [switch]$AllTests,
    [string]$DependencyProfile,
    [string[]]$TestFiles,
    [ValidateRange(1, 6)][int]$TestConcurrency = 6
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'repair-process-tree.ps1')
if ($AllTests -and $TestFiles) {
    throw '-TestFiles is only for focused runs; it cannot replace the full deployment gate.'
}
if ($AllTests -and (-not $NativeCore -or -not $CliCore -or -not $DependencyProfile)) {
    throw 'Full deployment gate requires -NativeCore, -CliCore and -DependencyProfile; runtime tests must not be skipped.'
}
$source = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('ccodex-repair-suite-' + [guid]::NewGuid().ToString('N'))
$report = [IO.Path]::GetFullPath($ReportDirectory)
New-Item -ItemType Directory -Path $testRoot, $report -Force | Out-Null
$env:CODEX_HOME = Join-Path $testRoot 'profile'
$env:CODEX_COPILOT_HOME = $env:CODEX_HOME
$env:CODEX_COPILOT_SOURCE_HOME = Join-Path $testRoot 'stock'
New-Item -ItemType Directory -Path $env:CODEX_HOME, $env:CODEX_COPILOT_SOURCE_HOME -Force | Out-Null
$env:CODEX_COPILOT_AUTH_MODE = 'saved'
$env:CCODEX_NATIVE_REPAIR_TEST_ROOT = $testRoot
$env:CCODEX_TEST_NATIVE_CORE = $NativeCore
$env:CCODEX_TEST_CLI_CORE = $CliCore
$env:TEST_INSTALL_ROOT = $source
$env:TEST_PROFILE_HOME = Join-Path $testRoot 'account-profile'
New-Item -ItemType Directory -Path $env:TEST_PROFILE_HOME -Force | Out-Null
'model = "synthetic-test"' | Set-Content -LiteralPath (Join-Path $env:TEST_PROFILE_HOME 'config.toml')
$exitCode = 1
$started = Get-Date
$processLog = Join-Path $report 'test-processes.json'
$resultLog = Join-Path $report 'test-result.json'
$processes = @([ordered]@{
    pid = $PID; role = 'heavy-worker'; priority = (Get-Process -Id $PID).PriorityClass.ToString()
    createdAt = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").CreationDate.ToString('o')
})
$sourceFiles = @()
$sourceUnchanged = $false
$testCounts = @{}
$requiredRuntimeCoverage = $false
$platformCoverage = $null
$platformWorker = $null
$platformTracker = $null
$tracker = $null
$worker = $null
$processCleanupVerified = $false
$remainingTrackedPids = @()
$failure = $null
try {
    if ((Get-Process -Id $PID).PriorityClass -ne 'BelowNormal' -or $env:CARGO_BUILD_JOBS -ne '6') {
        throw 'Run this test entry point through tools\Invoke-HeavyTask.ps1.'
    }
    Set-Location -LiteralPath $source
    $inventory = (& node (Join-Path $PSScriptRoot 'native-repair-inventory.mjs') $source | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Complete repair dependency inventory could not be bound.' }
    foreach ($relative in ($inventory | ConvertFrom-Json)) {
        $file = [IO.Path]::GetFullPath((Join-Path $source $relative))
        if (-not $file.StartsWith($source.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Repair manifest path escaped the source root.'
        }
        $sourceFiles += [ordered]@{ path = $relative; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
    }
    if ($NativeCore -and $NativeCore -match '\\WindowsApps\\') {
        $nativeBin = Join-Path $testRoot 'native-bin'
        New-Item -ItemType Directory -Path $nativeBin -Force | Out-Null
        foreach ($name in @('codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe', 'rg.exe')) {
            $component = Join-Path (Split-Path -Parent $NativeCore) $name
            if (Test-Path -LiteralPath $component) {
                Copy-Item -LiteralPath $component -Destination (Join-Path $nativeBin $name)
            }
        }
        $env:CCODEX_TEST_NATIVE_CORE = Join-Path $nativeBin 'codex.exe'
        if ((Get-FileHash -LiteralPath $NativeCore).Hash -ne
            (Get-FileHash -LiteralPath $env:CCODEX_TEST_NATIVE_CORE).Hash) {
            throw 'Native core test copy does not match the installed Desktop package.'
        }
        [ordered]@{
            source = $NativeCore
            sha256 = (Get-FileHash -LiteralPath $NativeCore -Algorithm SHA256).Hash
            version = (& $env:CCODEX_TEST_NATIVE_CORE --version | Out-String).Trim()
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $report 'native-core.json') -Encoding utf8
    }
    if ($NativeCore) {
        [ordered]@{
            source = $NativeCore
            sha256 = (Get-FileHash -LiteralPath $env:CCODEX_TEST_NATIVE_CORE -Algorithm SHA256).Hash
            version = (& $env:CCODEX_TEST_NATIVE_CORE --version | Out-String).Trim()
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $report 'native-core.json') -Encoding utf8
    }
    if ($CliCore) {
        [ordered]@{
            source = $CliCore
            sha256 = (Get-FileHash -LiteralPath $CliCore -Algorithm SHA256).Hash
            version = (& $CliCore --version | Out-String).Trim()
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $report 'cli-core.json') -Encoding utf8
    }
    if ($env:CCODEX_TEST_NATIVE_CORE) { $env:CCODEX_WORKIQ_NATIVE_CORE = $env:CCODEX_TEST_NATIVE_CORE }
    if ($DependencyProfile) {
        $env:WORKIQ_TEST_DEPENDENCY_PROFILE = $DependencyProfile
        $env:WORKIQ_REQUIRE_RUNTIME_TESTS = '1'
    }
    foreach ($item in @(Get-ChildItem Env:)) {
        if ($item.Name -match '(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY)(?:$|_)') {
            [Environment]::SetEnvironmentVariable($item.Name, $null, 'Process')
        }
    }
    $env:NO_COLOR = '1'
    [Environment]::SetEnvironmentVariable('FORCE_COLOR', $null, 'Process')
    $files = @(
        'tests/repair-config-test.mjs',
        'tests/native-runtime-test.mjs',
        'tests/native-mcp-relay-test.mjs',
        'tests/generated-ui-config-test.mjs',
        'tests/update-robustness-test.mjs',
        'tests/desktop-actions-test.mjs',
        'tests/desktop-cdp-test.mjs',
        'tests/app-server-compat-test.mjs'
    ) | Where-Object { Test-Path -LiteralPath $_ }
    if ($AllTests) {
        $files = @(Get-ChildItem -LiteralPath (Join-Path $source 'tests') -Filter '*-test.mjs' |
            Sort-Object Name | ForEach-Object { 'tests/' + $_.Name })
    }
    if ($TestFiles) {
        $files = foreach ($relative in $TestFiles) {
            $candidate = [IO.Path]::GetFullPath((Join-Path $source $relative))
            $testsDirectory = [IO.Path]::GetFullPath((Join-Path $source 'tests')).TrimEnd('\') + '\'
            if (-not $candidate.StartsWith($testsDirectory, [StringComparison]::OrdinalIgnoreCase) -or
                -not (Test-Path -LiteralPath $candidate -PathType Leaf) -or
                $candidate -notlike '*-test.mjs') {
                throw "Focused test path must name a test inside the source tests directory: $relative"
            }
            $relative
        }
    }
    $arguments = @('--test', "--test-concurrency=$TestConcurrency", '--test-reporter=tap') + $files
    $node = (Get-Command node.exe).Source
    $worker = Start-Process -FilePath $node -ArgumentList $arguments -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $report 'test-output.log') `
        -RedirectStandardError (Join-Path $report 'test-errors.log')
    $worker.PriorityClass = 'BelowNormal'
    $rootProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($worker.Id)"
    $tracker = New-RepairProcessTracker -Root $rootProcess
    $processes += [ordered]@{
        pid = $worker.Id; role = 'node-tests'; priority = $worker.PriorityClass.ToString()
        createdAt = $rootProcess.CreationDate.ToString('o')
    }
    $processes | ConvertTo-Json | Set-Content -LiteralPath $processLog -Encoding utf8
    while (-not $worker.WaitForExit(500)) {
        $all = @(Get-CimInstance Win32_Process)
        Update-RepairProcessTracker -Tracker $tracker -Snapshot $all
    }
    $worker.WaitForExit()
    $exitCode = $worker.ExitCode
    if (-not $worker.HasExited) { throw 'Test process did not exit.' }
    Get-Content -LiteralPath (Join-Path $report 'test-output.log') -Tail 24
    if ($exitCode -ne 0) { Get-Content -LiteralPath (Join-Path $report 'test-errors.log') -Tail 30 }
    foreach ($line in (Get-Content -LiteralPath (Join-Path $report 'test-output.log'))) {
        if ($line -match '^# (tests|pass|fail|cancelled|skipped|todo) ([0-9]+)\s*$') {
            $testCounts[$Matches[1]] = [int]$Matches[2]
        }
    }
    if ($AllTests -and $testCounts.Count -eq 6 -and $testCounts.skipped -gt 0 -and
        $testCounts.fail -eq 0 -and $testCounts.cancelled -eq 0 -and $testCounts.todo -eq 0) {
        & node (Join-Path $source 'tools\test-platform-coverage.mjs') `
            (Join-Path $report 'test-output.log') | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Full deployment gate encountered an undeclared platform skip.' }
        $released = @(Get-ChildItem -LiteralPath (Join-Path $source 'dist') -File -Filter 'RELEASE-MANIFEST-*.json' |
            ForEach-Object {
                if ($_.Name -match '^RELEASE-MANIFEST-(\d+\.\d+\.\d+)\.json$') { [version]$Matches[1] }
            } | Sort-Object -Descending)
        if (-not $released.Count) { throw 'Actual Unix coverage needs a verified previous Linux ARM64 Node runtime.' }
        $unixScript = (& wsl --exec wslpath -a (Join-Path $source 'tools\Test-UnixInstallerFromRelease.sh')).Trim()
        $unixSource = (& wsl --exec wslpath -a $source).Trim()
        $unixDist = (& wsl --exec wslpath -a (Join-Path $source 'dist')).Trim()
        $unixReport = Join-Path $report 'unix-platform.tap'
        $unixOutput = (& wsl --exec wslpath -a $unixReport).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $unixScript -or -not $unixSource -or -not $unixDist -or -not $unixOutput) {
            throw 'Actual Unix coverage paths could not be resolved.'
        }
        $arguments = @('--exec','env','CARGO_BUILD_JOBS=6','nice','-n','10','bash') +
            @($unixScript,$unixSource,$unixDist,$released[0].ToString(3),$unixOutput |
                ForEach-Object { '"' + $_.Replace('"','\"') + '"' })
        $platformWorker = Start-Process -FilePath (Get-Command wsl.exe).Source `
            -ArgumentList $arguments -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $report 'unix-output.log') `
            -RedirectStandardError (Join-Path $report 'unix-errors.log')
        $platformWorker.PriorityClass = 'BelowNormal'
        $platformRoot = Get-CimInstance Win32_Process -Filter "ProcessId=$($platformWorker.Id)"
        if (-not $platformRoot) {
            $platformWorker.WaitForExit()
            throw "Actual Unix runner exited before lifetime tracking (exit $($platformWorker.ExitCode)); see unix-errors.log."
        }
        $platformTracker = New-RepairProcessTracker -Root $platformRoot
        while (-not $platformWorker.WaitForExit(500)) {
            Update-RepairProcessTracker -Tracker $platformTracker -Snapshot @(Get-CimInstance Win32_Process)
        }
        $platformWorker.WaitForExit()
        if ($platformWorker.ExitCode -ne 0) { throw 'Actual Unix platform coverage failed; see unix-errors.log.' }
        $coverage = (& node (Join-Path $source 'tools\test-platform-coverage.mjs') `
            (Join-Path $report 'test-output.log') $unixReport | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Actual Unix passes did not cover every declared Windows skip.' }
        $platformCoverage = $coverage | ConvertFrom-Json
        [IO.File]::WriteAllText((Join-Path $report 'platform-coverage.json'),
            "$coverage`n", [Text.UTF8Encoding]::new($false))
        $testCounts = @{}
        foreach ($name in @('tests','pass','fail','cancelled','skipped','todo')) {
            $testCounts[$name] = $platformCoverage.counts.$name
        }
    }
    $requiredRuntimeCoverage = [bool]$AllTests -and $testCounts.Count -eq 6 -and
        $testCounts.tests -gt 0 -and $testCounts.pass -eq $testCounts.tests -and
        $testCounts.fail -eq 0 -and $testCounts.cancelled -eq 0 -and
        $testCounts.skipped -eq 0 -and $testCounts.todo -eq 0
    if ($AllTests -and -not $requiredRuntimeCoverage) {
        throw 'Full deployment gate requires complete test counts with no failures, cancellations, skips or TODOs.'
    }
    foreach ($entry in $sourceFiles) {
        if ((Get-FileHash -LiteralPath (Join-Path $source $entry.path) -Algorithm SHA256).Hash -ne $entry.sha256) {
            throw "Source changed while tests were running: $($entry.path)"
        }
    }
    $sourceUnchanged = $true
} catch {
    $exitCode = 1
    $failure = $_.Exception.Message
    throw
} finally {
    $owned = @()
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    try {
        $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
        $owned = @($all | Where-Object {
            $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($testRoot)
        })
        if ($tracker) {
            $cleanup = Get-RepairProcessCleanup -Tracker $tracker -Snapshot $all
            $remainingTrackedPids = @($cleanup.remainingPids)
            $processCleanupVerified = $cleanup.verified -and $owned.Count -eq 0
            $processes = @($processes[0]) + @($cleanup.processes)
        }
        if ($platformTracker) {
            $platformCleanup = Get-RepairProcessCleanup -Tracker $platformTracker -Snapshot $all
            $remainingTrackedPids += @($platformCleanup.remainingPids)
            $processCleanupVerified = $processCleanupVerified -and $platformCleanup.verified
            foreach ($entry in $platformCleanup.processes) {
                if ($entry.pid -eq $platformWorker.Id) { $entry.role = 'unix-platform-checks' }
            }
            $processes += @($platformCleanup.processes)
        }
        if (-not $resolved.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or
            -not ([IO.Path]::GetFileName($resolved)).StartsWith('ccodex-repair-suite-')) {
            throw 'Refusing cleanup outside the owned temporary test directory.'
        }
        if ($owned.Count -or ($worker -and -not $processCleanupVerified)) {
            throw ('Test processes remain or cleanup could not be verified; preserving temporary files. PIDs: ' +
                ((@($owned | ForEach-Object ProcessId) + $remainingTrackedPids | Sort-Object -Unique) -join ','))
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    } catch {
        $exitCode = 1
        $failure = (@($failure, $_.Exception.Message) | Where-Object { $_ }) -join '; '
        Write-Warning $_.Exception.Message
    }
    $processes | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $processLog -Encoding utf8
    [ordered]@{
        schemaVersion = 2
        startedAt = $started.ToString('o'); finishedAt = (Get-Date).ToString('o')
        exitCode = $exitCode; workerPid = $PID; failure = $failure
        sourceRoot = $source; sourceFiles = $sourceFiles; sourceUnchanged = $sourceUnchanged
        fullGate = [bool]$AllTests
        testConcurrency = $TestConcurrency
        requiredRuntimeCoverage = $requiredRuntimeCoverage; testCounts = $testCounts
        platformCoverage = $platformCoverage
        processCleanupVerified = $processCleanupVerified; remainingTrackedPids = $remainingTrackedPids
        remainingOwnedPids = @($owned | ForEach-Object ProcessId)
        isolatedProfile = $true; realSessionModified = $false
        temporaryFilesRemoved = -not (Test-Path -LiteralPath $resolved)
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultLog -Encoding utf8
}
exit $exitCode
