[CmdletBinding()]
param([Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ((Get-Process -Id $PID).PriorityClass -notin @('BelowNormal', 'Idle') -or $env:CARGO_BUILD_JOBS -ne '6') {
    throw 'Run release cleanup through run-heavy-build.ps1.'
}
$package = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$parent = Join-Path $package '.release-staging'
$target = [IO.Path]::GetFullPath((Join-Path $parent $Version))
if ($target -cne (Join-Path $parent $Version) -or
    -not $target.StartsWith([IO.Path]::GetFullPath($parent).TrimEnd('\') + '\',
        [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing cleanup outside the release staging directory: $target"
}
if (-not (Test-Path -LiteralPath $target)) {
    Write-Output "No staging directory exists for $Version."
    return
}
$item = Get-Item -LiteralPath $target -Force
$resolved = (Resolve-Path -LiteralPath $target).ProviderPath
if ($item.LinkType -or $resolved -cne $target -or
    @(Get-ChildItem -LiteralPath $target -Recurse -Force -Attributes ReparsePoint).Count) {
    throw "Refusing cleanup through a link or junction: $target"
}
$active = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and $_.CommandLine -like "*$target*" -and
    $_.Name -match '^(cargo|rustc|node|pwsh|powershell|tar|wsl|rpmbuild)\.exe$'
})
if ($active.Count) {
    $active | Select-Object ProcessId,Name
    throw 'A process still uses release staging; wait for it to exit.'
}
$count = @(Get-ChildItem -LiteralPath $target -Recurse -File).Count
Remove-Item -LiteralPath $target -Recurse -Force
if (Test-Path -LiteralPath $target) { throw 'Release staging cleanup did not finish.' }
Write-Output "Removed $count generated files from failed staging $target. Sources and the previous dist remain unchanged."
