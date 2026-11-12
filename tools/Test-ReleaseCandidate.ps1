[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$StagingRoot,
    [Parameter(Mandatory)][string]$Core,
    [ValidateRange(1, 6)][int]$TestConcurrency = 1
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ((Get-Process -Id $PID).PriorityClass -notin @('BelowNormal', 'Idle') -or $env:CARGO_BUILD_JOBS -ne '6') {
    throw 'Run release tests under run-heavy-build.ps1.'
}
$stage = [IO.Path]::GetFullPath($StagingRoot).TrimEnd('\')
$corePath = [IO.Path]::GetFullPath($Core)
if (-not $corePath.StartsWith($stage + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The tested core must come from the staged release.'
}
$evidence = Join-Path $stage 'test-evidence'
$temporary = Join-Path $stage 'test-tmp'
$profile = Join-Path $stage 'test-profile'
$account = Join-Path $stage 'test-account'
$stock = Join-Path $temporary 'empty-stock'
$dependencies = Join-Path $stage 'test-dependencies'
$runtime = Join-Path $dependencies 'workiq\runtime'
$hostTemp = [IO.Path]::GetTempPath()
New-Item -ItemType Directory -Path $evidence,$temporary,$profile,$account,$stock,$runtime -Force | Out-Null
Write-Output "ReleaseTestWorkerPid=$PID Core=$corePath TestConcurrency=$TestConcurrency"

try {
$extensionGeneration = (& node --input-type=module -e `
    'import {pathToFileURL} from "node:url";const p=await import(pathToFileURL(process.argv[1]));const f=await import(pathToFileURL(process.argv[2]));console.log(p.sourceFingerprint(process.argv[3],f.desktopExtensionFiles(process.argv[3])));' `
    (Join-Path $stage 'bridge\update-state.mjs') (Join-Path $stage 'bridge\desktop-extension-files.mjs') $stage | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $extensionGeneration -notmatch '^[a-f0-9]{64}$') {
    throw 'Candidate extension generation cannot be bound before testing.'
}
$env:TEMP = $temporary
$env:TMP = $temporary
$env:CODEX_HOME = $profile
$env:CODEX_COPILOT_SOURCE_HOME = $stock
$env:CODEX_COPILOT_HOME = $account
$env:CODEX_COPILOT_CATALOG_FILE = Join-Path $profile 'models.json'
$env:CODEX_COPILOT_SELECTION_FILE = Join-Path $profile 'selection-generation.json'
$env:CODEX_COPILOT_BRIDGE_PORT = '22999'
$env:TEST_PROFILE_HOME = $account
$env:TEST_INSTALL_ROOT = $stage
$env:WORKIQ_TEST_DEPENDENCY_PROFILE = $dependencies
$env:WORKIQ_REQUIRE_RUNTIME_TESTS = '1'
$env:CCODEX_TEST_NATIVE_CORE = $corePath
$env:CCODEX_TEST_CLI_CORE = $corePath
$env:CCODEX_WORKIQ_NATIVE_CORE = $corePath
$env:CCODEX_PACKAGE_ROOT = $stage
$env:CCODEX_LIVE_CORE = $corePath
$env:CCODEX_NODE_PTY = Join-Path $stage 'bin\node-pty'

$sourceRuntime = Join-Path $env:USERPROFILE '.codex-copilot\workiq\runtime'
$sourceManifest = Join-Path $stage 'bridge\workiq\package.json'
if ((Test-Path -LiteralPath (Join-Path $sourceRuntime 'package.json')) -and
    (Get-FileHash -LiteralPath (Join-Path $sourceRuntime 'package.json')).Hash -eq
    (Get-FileHash -LiteralPath $sourceManifest).Hash) {
    foreach ($item in @('package.json', 'package-lock.json', 'node_modules')) {
        Copy-Item -LiteralPath (Join-Path $sourceRuntime $item) -Destination (Join-Path $runtime $item) -Recurse
    }
} else {
    Copy-Item -LiteralPath $sourceManifest,(Join-Path $stage 'bridge\workiq\package-lock.json') -Destination $runtime
    & npm.cmd ci --prefix $runtime --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Pinned Work IQ test dependencies could not be installed.' }
}

& node (Join-Path $stage 'tools\gen-config.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Isolated test profile generation failed.' }
$env:CODEX_COPILOT_HOME = $profile
$tests = @(Get-ChildItem -LiteralPath (Join-Path $stage 'tests') -Filter '*-test.mjs' |
    Sort-Object Name | ForEach-Object FullName)
if ($tests.Count -lt 27) { throw "The package test discovery found only $($tests.Count) files." }
$suiteOutput = @(& node --test "--test-concurrency=$TestConcurrency" --test-reporter=tap @tests 2>&1 |
    Tee-Object -FilePath (Join-Path $evidence 'node-suite.tap'))
$suiteExit = $LASTEXITCODE
$summary = $suiteOutput -join "`n"
$counts = @{}
foreach ($name in @('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo')) {
    $match = [regex]::Match($summary, "(?m)^# $name (\d+)\r?$")
    if ($match.Success) { $counts[$name] = [int]$match.Groups[1].Value }
}
if ($suiteExit -ne 0 -or $counts.Count -ne 6 -or $counts.tests -lt 239 -or
    ($counts.pass + $counts.skipped) -ne $counts.tests -or $counts.fail -ne 0 -or
    $counts.cancelled -ne 0 -or $counts.todo -ne 0) {
    throw "Complete isolated package suite failed or was incomplete: $($counts | ConvertTo-Json -Compress)"
}
$windowsCoverage = (& node (Join-Path $stage 'tools\test-platform-coverage.mjs') `
    (Join-Path $evidence 'node-suite.tap') | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    throw 'Windows skipped an unexpected test or missed a required Unix-only check.'
}
$skippedNames = @(($windowsCoverage | ConvertFrom-Json).skippedNames)

$packageRoot = Split-Path -Parent (Split-Path -Parent $stage)
$previousVersion = (Get-Content -LiteralPath (Join-Path $packageRoot 'VERSION') -Raw).Trim()
$unixStage = (& wsl --exec wslpath -a $stage).Trim()
$unixDist = (& wsl --exec wslpath -a (Join-Path $packageRoot 'dist')).Trim()
$unixReportFile = Join-Path $evidence 'unix-installer.tap'
$unixReport = (& wsl --exec wslpath -a $unixReportFile).Trim()
& wsl --exec env 'CARGO_BUILD_JOBS=6' nice -n 10 bash `
    "$unixStage/tools/Test-UnixInstallerFromRelease.sh" `
    $unixStage $unixDist $previousVersion $unixReport
if ($LASTEXITCODE -ne 0) { throw 'Unix installer checks failed; Windows skips remain uncovered.' }
$unixSummary = Get-Content -LiteralPath $unixReportFile -Raw
$unixCounts = @{}
foreach ($name in @('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo')) {
    $match = [regex]::Match($unixSummary, "(?m)^# $name (\d+)\r?$")
    if ($match.Success) { $unixCounts[$name] = [int]$match.Groups[1].Value }
}
if ($unixCounts.Count -ne 6 -or $unixCounts.tests -lt 14 -or
    $unixCounts.pass -ne $unixCounts.tests -or $unixCounts.fail -ne 0 -or
    $unixCounts.cancelled -ne 0 -or $unixCounts.skipped -ne 0 -or
    $unixCounts.todo -ne 0) {
    throw 'The WSL installer suite did not cover all Unix-only checks.'
}
$coverage = (& node (Join-Path $stage 'tools\test-platform-coverage.mjs') `
    (Join-Path $evidence 'node-suite.tap') $unixReportFile | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Actual Unix passes do not cover every Windows platform skip.' }
[IO.File]::WriteAllText((Join-Path $evidence 'platform-coverage.json'),
    "$coverage`n", [Text.UTF8Encoding]::new($false))

$xterm = Join-Path $hostTemp 'copilot-xterm-node\node_modules\@xterm\headless'
if (-not (Test-Path -LiteralPath $xterm -PathType Container)) {
    $xterm = Join-Path $dependencies 'xterm\node_modules\@xterm\headless'
    & npm.cmd install --prefix (Join-Path $dependencies 'xterm') --ignore-scripts --no-audit --no-fund '@xterm/headless@6.0.0'
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $xterm)) {
        throw 'The pinned headless terminal test dependency is missing.'
    }
}
$env:CCODEX_XTERM_HEADLESS = $xterm
$compiler = @(
    'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
    'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) { throw 'Parent-console recovery must be tested; the C# compiler is missing.' }
$probe = Join-Path $dependencies 'windows-console-recovery.exe'
& $compiler /nologo /target:exe /platform:anycpu /optimize+ "/out:$probe" `
    (Join-Path $stage 'tests\fixtures\windows-console-recovery.cs')
if ($LASTEXITCODE -ne 0) { throw 'Parent-console recovery probe compilation failed.' }
$env:CCODEX_CONSOLE_RECOVERY_PROBE = $probe
$env:CCODEX_RECOVERY_REPORT = Join-Path $evidence 'terminal-recovery.json'
& node (Join-Path $stage 'tests\live-terminal-recovery-smoke.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Candidate does not restore the actual parent terminal.' }
$recovery = Get-Content -LiteralPath $env:CCODEX_RECOVERY_REPORT -Raw | ConvertFrom-Json
$env:CCODEX_TUI_REPORT = Join-Path $evidence 'keyboard.json'
& node (Join-Path $stage 'tests\live-keyboard-smoke.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Direct native Shift+Enter regression failed.' }
$keyboard = Get-Content -LiteralPath $env:CCODEX_TUI_REPORT -Raw | ConvertFrom-Json
$env:CCODEX_CONTEXT_REPORT = Join-Path $evidence 'context-status.json'
& node (Join-Path $stage 'tests\live-context-status-smoke.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Native account/quota/compaction status regression failed.' }
$contextStatus = Get-Content -LiteralPath $env:CCODEX_CONTEXT_REPORT -Raw | ConvertFrom-Json
$candidateHash = (Get-FileHash -LiteralPath $corePath -Algorithm SHA256).Hash
foreach ($check in @($recovery,$keyboard,$contextStatus)) {
    if (-not $check.passed -or $check.coreSha256 -ne $candidateHash -or
        -not $check.isolatedProfile -or $check.externalRequests -ne $false -or
        @($check.checks).Count -lt 2 -or @($check.checks | Where-Object { -not $_.passed }).Count) {
        throw 'Live input/status evidence is incomplete or belongs to another candidate.'
    }
}
if (-not $recovery.testProcessesExited -or -not $keyboard.testProcessExited -or
    -not $contextStatus.testProcessesExited) {
    throw 'Live input/status checks left an owned test process running.'
}
$native = @()
foreach ($mode in @('never', 'always')) {
    $reportFile = Join-Path $evidence "model-context-$mode.json"
    $env:CCODEX_TUI_REPORT = $reportFile
    $env:CCODEX_TUI_ALTERNATE_SCREEN = $mode
    & node (Join-Path $stage 'tests\live-model-context-smoke.cjs')
    if ($LASTEXITCODE -ne 0) { throw "Isolated native /model flow failed in $mode mode." }
    $report = Get-Content -LiteralPath $reportFile -Raw | ConvertFrom-Json
    if (-not $report.isolatedProfile -or -not $report.exited -or -not $report.cleaned -or
        @($report.checks).Count -lt 5 -or @($report.checks | Where-Object { -not $_.passed }).Count) {
        throw "Native /model test evidence is incomplete in $mode mode."
    }
    $native += [ordered]@{ mode = $mode; checks = @($report.checks).Count; coreSha256 = $report.sha256 }
    if ($report.passed -ne $true -or $report.forcedCleanup -ne $false) {
        throw 'Native Context validation must not rely on forced cleanup.'
    }
}

$uiRuntime = @{}
foreach ($probe in @(
    @{ name = 'nativeLayout'; script = 'live-tui-layout-smoke.cjs'; minimum = 10 },
    @{ name = 'nativeStream'; script = 'live-transcript-stream-smoke.cjs'; minimum = 7 }
)) {
    $env:CCODEX_TUI_REPORT = Join-Path $evidence "$($probe.name).json"
    & node (Join-Path $stage "tests\$($probe.script)")
    if ($LASTEXITCODE -ne 0) { throw "Actual native UI regression failed: $($probe.name)" }
    $runtimeResult = Get-Content -LiteralPath $env:CCODEX_TUI_REPORT -Raw | ConvertFrom-Json
    if ($runtimeResult.passed -ne $true -or $runtimeResult.forcedCleanup -ne $false -or
        $runtimeResult.sha256 -ne $candidateHash -or -not $runtimeResult.isolatedProfile -or
        -not $runtimeResult.exited -or -not $runtimeResult.cleaned -or
        @($runtimeResult.checks).Count -lt $probe.minimum -or
        @($runtimeResult.checks | Where-Object { -not $_.passed }).Count) {
        throw "Native transcript/attachment evidence is incomplete: $($probe.name)"
    }
    $uiRuntime[$probe.name] = [ordered]@{
        checks = @($runtimeResult.checks).Count; coreSha256 = $candidateHash; passed = $true
    }
}
$afterGeneration = (& node --input-type=module -e `
    'import {pathToFileURL} from "node:url";const p=await import(pathToFileURL(process.argv[1]));const f=await import(pathToFileURL(process.argv[2]));console.log(p.sourceFingerprint(process.argv[3],f.desktopExtensionFiles(process.argv[3])));' `
    (Join-Path $stage 'bridge\update-state.mjs') (Join-Path $stage 'bridge\desktop-extension-files.mjs') $stage | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $afterGeneration -cne $extensionGeneration) {
    throw 'Candidate extension source changed during native validation.'
}
$coreManifest = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $corePath) 'codex-copilot-core.manifest.json') -Raw | ConvertFrom-Json
$actualCoreVersion = (& $corePath --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $coreManifest.coreVersion -cne $actualCoreVersion) {
    throw 'Native runtime version differs from its candidate manifest.'
}
$result = [ordered]@{
    schemaVersion = 1
    kind = 'native-runtime-validation'
    target = $coreManifest.target
    coreVersion = $actualCoreVersion
    extensionGeneration = $extensionGeneration
    testedAt = (Get-Date).ToString('o')
    workerPid = $PID
    priority = (Get-Process -Id $PID).PriorityClass.ToString()
    testConcurrency = $TestConcurrency
    source = $stage
    coreSha256 = (Get-FileHash -LiteralPath $corePath -Algorithm SHA256).Hash
    isolatedProfile = $true
    sourceUnchanged = $true
    testProcessesExited = [bool]($recovery.testProcessesExited -and $keyboard.testProcessExited -and $contextStatus.testProcessesExited)
    forcedCleanup = [bool]($keyboard.forcedCleanup -or @($recovery.processes | Where-Object forcedCleanup).Count -or @($contextStatus.processes | Where-Object forcedCleanup).Count)
    packageTests = $counts
    unixTests = $unixCounts
    windowsPlatformSkipsCoveredByUnix = $skippedNames.Count
    native = $native
    nativeLayout = $uiRuntime.nativeLayout
    nativeStream = $uiRuntime.nativeStream
    nativeInputStatus = [ordered]@{
        recoveryChecks = @($recovery.checks).Count
        keyboardChecks = @($keyboard.checks).Count
        contextStatusChecks = @($contextStatus.checks).Count
        creditsVerified = $contextStatus.creditsVerified
        creditChecks = $contextStatus.creditChecks
        coreSha256 = $candidateHash
    }
    passed = $true
}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'release-tests.json') -Encoding utf8
& node (Join-Path $stage 'tools\write-cli-update-compatibility.mjs') $stage $corePath (Join-Path $evidence 'release-tests.json')
if ($LASTEXITCODE -ne 0) { throw 'Actual native CLI update compatibility receipt could not be generated.' }
Write-Output "PASS release tests: $($counts.tests) package checks and two native /model flows."

} finally {
foreach ($directory in @($temporary,$profile,$account,$dependencies)) {
    if (-not (Test-Path -LiteralPath $directory)) { continue }
    $resolved = [IO.Path]::GetFullPath($directory)
    if (-not $resolved.StartsWith($stage + '\test-', [StringComparison]::OrdinalIgnoreCase) -or
        (Get-Item -LiteralPath $resolved -Force).LinkType) {
        throw "Refusing unexpected test cleanup target: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
}
