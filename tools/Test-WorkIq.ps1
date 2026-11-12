[CmdletBinding()]
param(
    [string]$DependencyProfile,
    [string]$NativeCore,
    [switch]$Full
)
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
if ((Get-Process -Id $PID).PriorityClass -ne 'BelowNormal' -or $env:CARGO_BUILD_JOBS -ne '6') {
    throw 'Run this verification through tools\Invoke-HeavyTask.ps1.'
}
if (-not $DependencyProfile) {
    $DependencyProfile = Join-Path $env:USERPROFILE '.codex-copilot'
}
if (-not (Test-Path -LiteralPath (Join-Path $DependencyProfile 'workiq\runtime\node_modules\@modelcontextprotocol\sdk\package.json'))) {
    throw 'Install the pinned Work IQ runtime first; dependency presence is required, not silently skipped.'
}
if (-not $NativeCore) {
    $pointer = Join-Path $env:LOCALAPPDATA 'CodexCopilot\bin\core-current.txt'
    if (Test-Path -LiteralPath $pointer) { $NativeCore = (Get-Content -LiteralPath $pointer -Raw).Trim() }
}
if (-not $NativeCore -or -not (Test-Path -LiteralPath $NativeCore -PathType Leaf)) {
    throw 'A native ccodex core is required for CLI and Desktop app-server verification.'
}

$testContainer = Join-Path ([IO.Path]::GetTempPath()) ('ccodex-workiq-gate-' + [guid]::NewGuid().ToString('N'))
New-Item -Path $testContainer -ItemType Directory | Out-Null
$realConfig = Join-Path $env:USERPROFILE '.codex-copilot\config.toml'
$beforeHash = if (Test-Path -LiteralPath $realConfig) { (Get-FileHash -LiteralPath $realConfig).Hash } else { $null }
Write-Output "Heavy task PID: $PID"
Write-Output "Priority: $((Get-Process -Id $PID).PriorityClass)"
Write-Output "Concurrency: $env:CARGO_BUILD_JOBS"
$testExit = 1
try {
    # Environment is scoped to this heavy-task child. No real session/profile or
    # ambient model-provider credential is supplied to the tests.
    foreach ($item in @(Get-ChildItem Env:)) {
        if ($item.Name -match '(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY)(?:$|_)') {
            [Environment]::SetEnvironmentVariable($item.Name, $null, 'Process')
        }
    }
    $env:CODEX_COPILOT_HOME = Join-Path $testContainer 'profile'
    $env:CODEX_HOME = $env:CODEX_COPILOT_HOME
    $env:CODEX_COPILOT_AUTH_MODE = 'saved'
    $env:WORKIQ_TEST_DEPENDENCY_PROFILE = $DependencyProfile
    $env:WORKIQ_REQUIRE_RUNTIME_TESTS = '1'
    $env:CCODEX_WORKIQ_NATIVE_CORE = $NativeCore
    $env:TEST_INSTALL_ROOT = $sourceRoot
    $env:TEST_PROFILE_HOME = Join-Path $testContainer 'account-profile'
    New-Item -Path $env:TEST_PROFILE_HOME -ItemType Directory | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'tests\fixtures\workiq\account-config.toml') `
        -Destination (Join-Path $env:TEST_PROFILE_HOME 'config.toml')
    $env:NO_COLOR = '1'
    [Environment]::SetEnvironmentVariable('FORCE_COLOR', $null, 'Process')
    if ($Full) {
        $testFiles = @(Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'tests') -Filter '*-test.mjs' | ForEach-Object { $_.FullName })
    } else {
        $testFiles = @(Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'tests') -Filter 'workiq*-test.mjs' | ForEach-Object { $_.FullName })
    }
    node --test --test-concurrency=6 @testFiles
    $testExit = $LASTEXITCODE
} finally {
    $afterHash = if (Test-Path -LiteralPath $realConfig) { (Get-FileHash -LiteralPath $realConfig).Hash } else { $null }
    Write-Output "Real profile config unchanged: $($beforeHash -eq $afterHash)"
    $resolved = [IO.Path]::GetFullPath($testContainer)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if ((Split-Path -Parent $resolved) -ne $tempRoot -or (Split-Path -Leaf $resolved) -notlike 'ccodex-workiq-gate-*') {
        throw 'Refusing cleanup outside the isolated verification directory.'
    }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
    if ($beforeHash -ne $afterHash) { throw 'Real profile config changed while verification was running.' }
}
exit $testExit
