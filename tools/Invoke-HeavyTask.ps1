[CmdletBinding()]
param([Parameter(Mandatory,Position=0)][string]$Command)
$ErrorActionPreference = 'Stop'
if ($env:CCODEX_RELEASE_HEAVY_TASK -eq '1') {
    & ([scriptblock]::Create($Command))
    exit $LASTEXITCODE
}
$mutex = [Threading.Mutex]::new($false, 'Local\CCodexReleaseHeavyTask')
$locked = $false
try {
    try { $locked = $mutex.WaitOne() } catch [Threading.AbandonedMutexException] { $locked = $true }
    (Get-Process -Id $PID).PriorityClass = 'BelowNormal'
    foreach ($name in @('CARGO_BUILD_JOBS','CMAKE_BUILD_PARALLEL_LEVEL','MAX_JOBS','npm_config_jobs','RUST_TEST_THREADS')) {
        [Environment]::SetEnvironmentVariable($name,'6','Process')
    }
    $env:MAKEFLAGS='-j6'
    $env:CCODEX_RELEASE_HEAVY_TASK='1'
    Write-Output "Heavy task worker PID: $PID; BelowNormal; maximum six jobs."
    & ([scriptblock]::Create($Command))
    $code = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 0 }
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
exit $code
