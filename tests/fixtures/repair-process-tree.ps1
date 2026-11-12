$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\tools\repair-process-tree.ps1')
$scenario = [Console]::In.ReadToEnd() | ConvertFrom-Json
$tracker = New-RepairProcessTracker -Root $scenario.root
foreach ($snapshot in $scenario.snapshots) {
    Update-RepairProcessTracker -Tracker $tracker -Snapshot @($snapshot.processes) -ObservedAt $snapshot.at
}
Get-RepairProcessCleanup -Tracker $tracker -Snapshot @($scenario.final.processes) -ObservedAt $scenario.final.at |
    ConvertTo-Json -Depth 8 -Compress
