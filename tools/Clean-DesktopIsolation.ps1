[CmdletBinding()]
param([Parameter(Mandatory)][string]$ReportFile)
$ErrorActionPreference = 'Stop'
# This is bounded lifecycle cleanup, not another build or test run. It may be
# called while the test's heavy worker is waiting for this exact empty fixture
# to exit; acquiring the same global build lock here would deadlock shutdown.
$report = Get-Content -LiteralPath $ReportFile -Raw | ConvertFrom-Json
$profile = [IO.Path]::GetFullPath([string]$report.isolatedProfile)
$temporary = Split-Path -Parent $profile
$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if ((Split-Path -Parent $temporary) -ne $tempParent -or
    (Split-Path -Leaf $temporary) -notmatch '^ccodex-desktop-isolation-[A-Za-z0-9]+$' -or
    (Split-Path -Leaf $profile) -ne 'copilot' -or
    -not $report.noUserInputSent -or -not $report.providerIsLoopbackStub) {
    throw 'This is not an owned empty Desktop test profile.'
}
$image = [IO.Path]::GetFullPath([string]$report.executable)
if ($image -notmatch '[\\/]Codex-copilot-portable[\\/]desktop[\\/]versions[\\/][\d.]+-[a-f0-9]{12}[\\/]app[\\/]ChatGPT\.exe$' -or
    $image -match '[\\/]WindowsApps[\\/]') {
    throw 'The test executable is not an independent snapshot.'
}
# PowerShell 7.5+ may deserialize ISO JSON dates as DateTime. Converting that
# value back through a culture-specific string loses Z and changes its zone.
$start = if ($report.startedAt -is [DateTimeOffset]) {
    $report.startedAt.UtcDateTime
} elseif ($report.startedAt -is [DateTime]) {
    $report.startedAt.ToUniversalTime()
} else {
    [DateTimeOffset]::Parse([string]$report.startedAt, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime
}
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$report.pid)"
$stopped = @()
if ($process) {
    if (-not $process.ExecutablePath -or
        -not [IO.Path]::GetFullPath($process.ExecutablePath).Equals($image, [StringComparison]::OrdinalIgnoreCase) -or
        $process.CreationDate.ToUniversalTime() -lt $start -or
        $process.CreationDate.ToUniversalTime() -gt $start.AddSeconds(15) -or
        $process.CommandLine.IndexOf("$profile\desktop-data", [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'The test PID was reused or its ownership is uncertain. No process was stopped.'
    }
    # Browser.close hides this vendor app to the tray; there is no test draft or
    # user input. Terminate only the exact, independently verified test lifetime.
    $snapshot = @(Get-CimInstance Win32_Process)
    $owned = [Collections.Generic.HashSet[int]]::new()
    [void]$owned.Add([int]$process.ProcessId)
    do {
        $count = $owned.Count
        foreach ($child in $snapshot) {
            if ($owned.Contains([int]$child.ParentProcessId)) {
                if ($child.CreationDate.ToUniversalTime() -lt $start) {
                    throw 'Descendant PID ownership could not be verified.'
                }
                [void]$owned.Add([int]$child.ProcessId)
            }
        }
    } while ($owned.Count -ne $count)
    foreach ($child in $snapshot | Where-Object { $owned.Contains([int]$_.ProcessId) } |
        Sort-Object ProcessId -Descending) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ProcessId)"
        if ($current -and $current.CreationDate -eq $child.CreationDate) {
            try {
                Stop-Process -Id $child.ProcessId -Force -ErrorAction Stop
                $stopped += [int]$child.ProcessId
            } catch {
                $after = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ProcessId)"
                if ($after -and $after.CreationDate -eq $child.CreationDate) { throw }
                # A descendant can exit naturally after another test helper ends.
                # Missing/reused PIDs are never retried as termination targets.
            }
        }
    }
    foreach ($id in $stopped) {
        $remaining = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
        if ($remaining -and $remaining.CreationDate.ToUniversalTime() -ge $start -and
            $remaining.CreationDate.ToUniversalTime() -le $start.AddSeconds(60)) {
            throw 'An owned test process has not exited; its profile is retained.'
        }
    }
}
if (Test-Path -LiteralPath $temporary) {
    if ((Get-Item -LiteralPath $temporary -Force).LinkType -or
        (Resolve-Path -LiteralPath $temporary).ProviderPath -cne $temporary) {
        throw 'Refusing linked test profile cleanup.'
    }
    for ($retry = 0; ; $retry++) {
        try {
            Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction Stop
            break
        } catch {
            if (-not (Test-Path -LiteralPath $temporary)) { break }
            $live = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$report.pid)"
            if ($live -or $retry -ge 9 -or
                $_.Exception.Message -notmatch 'being used by another process|process cannot access|正被另一|正在使用') {
                throw
            }
            # Process exit and NTFS/SQLite handle release can finish separately.
            # Retry only the same validated owned directory, never another PID.
            Start-Sleep -Milliseconds 250
        }
    }
}
$report | Add-Member -NotePropertyName cleanupVerifiedAt -NotePropertyValue (Get-Date).ToString('o') -Force
$report | Add-Member -NotePropertyName ownedEmptyTestPidsTerminated -NotePropertyValue $stopped -Force
$report | Add-Member -NotePropertyName temporaryProfileRemoved -NotePropertyValue $true -Force
$report | Add-Member -NotePropertyName testProcessExited -NotePropertyValue $true -Force
$report | Add-Member -NotePropertyName originalProcessesStopped -NotePropertyValue @() -Force
if ($report.PSObject.Properties['cleanupDeferred']) {
    $report | Add-Member -NotePropertyName initialCleanupDeferred -NotePropertyValue $report.cleanupDeferred -Force
    $report.PSObject.Properties.Remove('cleanupDeferred')
}
[IO.File]::WriteAllText([IO.Path]::GetFullPath($ReportFile), ($report | ConvertTo-Json -Depth 8),
    [Text.UTF8Encoding]::new($false))
Write-Output "Cleaned only empty isolated Desktop test lifetimes: $($stopped -join ', '). Original Desktop and CLI processes were not stopped."
