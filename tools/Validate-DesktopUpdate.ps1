[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InstallRoot,
    [Parameter(Mandatory)][ValidatePattern('^[\d.]+-[a-f0-9]{12}$')][string]$Candidate,
    [Parameter(Mandatory)][string]$ReportDirectory,
    [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
)
$ErrorActionPreference = 'Stop'
if ((Get-Process -Id $PID).PriorityClass -notin @('BelowNormal','Idle') -or
    $env:CARGO_BUILD_JOBS -ne '6') {
    throw 'Run Desktop candidate validation through tools\Invoke-HeavyTask.ps1.'
}
$root = [IO.Path]::GetFullPath($InstallRoot)
$reportRoot = [IO.Path]::GetFullPath($ReportDirectory)
New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
if ((Get-Item -LiteralPath $reportRoot -Force).LinkType) {
    throw 'Candidate validation report directory cannot be linked.'
}
$filesText = & $NodePath (Join-Path $root 'bridge\desktop-extension-files.mjs') $root
if ($LASTEXITCODE -ne 0) { throw 'Desktop extension source inventory failed.' }
$files = @((($filesText -join "`n") | ConvertFrom-Json))
$generation = (& $NodePath --input-type=module -e `
    'import {pathToFileURL} from "node:url";const m=await import(pathToFileURL(process.argv[1]));console.log(m.sourceFingerprint(process.argv[2],JSON.parse(process.argv[3])));' `
    (Join-Path $root 'bridge\update-state.mjs') $root ($files | ConvertTo-Json -Compress) | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $generation -notmatch '^[a-f0-9]{64}$') {
    throw 'Extension source fingerprint validation failed.'
}
& $NodePath --test --test-concurrency=1 --test-reporter=tap `
    (Join-Path $root 'tests\desktop-native-context-test.mjs') `
    (Join-Path $root 'tests\desktop-isolation-test.mjs') `
    (Join-Path $root 'tests\desktop-cdp-test.mjs') `
    > (Join-Path $reportRoot 'extension-regressions.tap')
$testsCode = $LASTEXITCODE
$tap = Get-Content -LiteralPath (Join-Path $reportRoot 'extension-regressions.tap') -Raw
$counts = @{}
foreach ($name in @('tests','pass','fail','cancelled','skipped','todo')) {
    $match = [regex]::Match($tap, "(?m)^# $name (\d+)\r?$")
    if ($match.Success) { $counts[$name] = [int]$match.Groups[1].Value }
}
if ($testsCode -ne 0 -or $counts.Count -ne 6 -or
    $counts.tests -lt 100 -or $counts.pass -ne $counts.tests -or
    $counts.fail -ne 0 -or $counts.cancelled -ne 0 -or
    $counts.skipped -ne 0 -or $counts.todo -ne 0) {
    throw 'Candidate extension regression gate failed or lacked complete evidence.'
}
$lifecycleFile = Join-Path $reportRoot 'candidate-lifecycle.json'
& $NodePath (Join-Path $root 'tools\Test-DesktopIsolation.mjs') $root $lifecycleFile $Candidate
if ($LASTEXITCODE -ne 0) { throw 'Candidate native process/data isolation gate failed.' }
$lifecycle = Get-Content -LiteralPath $lifecycleFile -Raw | ConvertFrom-Json
if (-not $lifecycle.passed -or -not $lifecycle.testProcessExited -or
    -not $lifecycle.temporaryProfileRemoved -or
    $lifecycle.snapshot -ne $Candidate -or
    -not $lifecycle.stockConfigUnchanged -or
    -not $lifecycle.originalExecutableUnchanged) {
    throw 'Candidate lifecycle evidence does not prove private, unchanged-source execution.'
}
$validation = [ordered]@{
    schemaVersion = 1; candidate = $Candidate; extensionGeneration = $generation
    passed = $false; testedAt = (Get-Date).ToString('o')
    regressionTests = $counts; lifecycle = $lifecycle
    nativeUiPreserved = $false
    contextExtensionVerified = $false
    remainingGate = 'Native Context adapter must bind and verify on the actual candidate renderer; isolated fixture tests alone do not establish renderer compatibility.'
}
[IO.File]::WriteAllText((Join-Path $reportRoot 'candidate-validation.json'),
    ($validation | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
Write-Output 'Native isolation and extension fixture checks passed. Live renderer compatibility is still required; no Desktop pointer was promoted.'
