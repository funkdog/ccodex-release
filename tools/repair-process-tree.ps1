function ConvertTo-RepairProcessRecord {
    param([Parameter(Mandatory)]$Process)
    if (-not $Process.ProcessId -or $null -eq $Process.CreationDate) {
        throw 'A process lifetime requires a PID and creation time.'
    }
    $created = [datetimeoffset]$Process.CreationDate
    $processId = [uint32]$Process.ProcessId
    [pscustomobject]@{
        Key = "$processId/$($created.UtcTicks)"
        ProcessId = $processId
        ParentProcessId = [uint32]$Process.ParentProcessId
        Name = [string]$Process.Name
        CreatedAt = $created.ToString('o')
        CreatedUtcTicks = $created.UtcTicks
        ParentKey = $null
        EndedByUtcTicks = $null
    }
}

function New-RepairProcessTracker {
    param([Parameter(Mandatory)]$Root)
    $record = ConvertTo-RepairProcessRecord $Root
    @{
        RootKey = $record.Key
        Processes = @{ $record.Key = $record }
        LastObservedUtcTicks = $record.CreatedUtcTicks
    }
}

function Update-RepairProcessTracker {
    param(
        [Parameter(Mandatory)][hashtable]$Tracker,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Snapshot,
        [datetimeoffset]$ObservedAt = [datetimeoffset]::Now
    )
    if ($ObservedAt.UtcTicks -lt $Tracker.LastObservedUtcTicks) {
        throw 'Process snapshots must be observed in chronological order.'
    }
    $current = @{}
    foreach ($process in $Snapshot) {
        if ($process.ProcessId -and $null -ne $process.CreationDate) {
            $record = ConvertTo-RepairProcessRecord $process
            $current[$record.ProcessId] = $record
        }
    }
    $byPid = @{}
    foreach ($record in $Tracker.Processes.Values) {
        $byPid[$record.ProcessId] = @($byPid[$record.ProcessId]) + @($record)
        $replacement = $current[$record.ProcessId]
        if (-not $replacement -or $replacement.Key -ne $record.Key) {
            $endedBy = $ObservedAt.UtcTicks
            if ($replacement -and $replacement.CreatedUtcTicks -gt $record.CreatedUtcTicks) {
                $endedBy = [Math]::Min($endedBy, $replacement.CreatedUtcTicks)
            }
            if ($null -eq $record.EndedByUtcTicks -or $endedBy -lt $record.EndedByUtcTicks) {
                $record.EndedByUtcTicks = $endedBy
            }
        }
    }
    do {
        $added = $false
        foreach ($record in $current.Values) {
            if ($Tracker.Processes.ContainsKey($record.Key)) { continue }
            foreach ($parent in @($byPid[$record.ParentProcessId])) {
                if ($null -eq $parent -or $record.ProcessId -eq $parent.ProcessId) { continue }
                # ParentProcessId outlives its parent and can point at a reused PID.
                if ($record.CreatedUtcTicks -lt $parent.CreatedUtcTicks -or
                    ($null -ne $parent.EndedByUtcTicks -and
                     $record.CreatedUtcTicks -ge $parent.EndedByUtcTicks)) { continue }
                $record.ParentKey = $parent.Key
                $Tracker.Processes[$record.Key] = $record
                $byPid[$record.ProcessId] = @($byPid[$record.ProcessId]) + @($record)
                $added = $true
                break
            }
        }
    } while ($added)
    $Tracker.LastObservedUtcTicks = $ObservedAt.UtcTicks
}

function Get-RepairProcessCleanup {
    param(
        [Parameter(Mandatory)][hashtable]$Tracker,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Snapshot,
        [datetimeoffset]$ObservedAt = [datetimeoffset]::Now
    )
    Update-RepairProcessTracker -Tracker $Tracker -Snapshot $Snapshot -ObservedAt $ObservedAt
    $live = @{}
    foreach ($process in $Snapshot) {
        if ($process.ProcessId -and $null -ne $process.CreationDate) {
            $record = ConvertTo-RepairProcessRecord $process
            $live[$record.Key] = $true
        }
    }
    $evidence = @(
        foreach ($record in ($Tracker.Processes.Values | Sort-Object CreatedUtcTicks, ProcessId)) {
            [ordered]@{
                pid = $record.ProcessId
                parentPid = $record.ParentProcessId
                role = if ($record.Key -eq $Tracker.RootKey) { 'node-tests' } else { $record.Name }
                createdAt = $record.CreatedAt
                processIdentity = $record.Key
                parentIdentity = $record.ParentKey
                exited = -not $live.ContainsKey($record.Key)
            }
        }
    )
    $remaining = @($evidence | Where-Object { -not $_.exited } | ForEach-Object { $_.pid })
    [pscustomobject]@{
        verified = $remaining.Count -eq 0
        remainingPids = $remaining
        processes = $evidence
    }
}
