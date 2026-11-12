[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [switch]$PurgeProfile,
    [switch]$NoRegistration,
    [switch]$NoShortcuts
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$owner = Join-Path $root '.ccodex-release-install.json'
if (-not (Test-Path -LiteralPath $owner) -or
    (Get-Content -LiteralPath $owner -Raw -Encoding UTF8 | ConvertFrom-Json).product -ne 'CCodexRelease' -or
    (Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Uninstall requires a regular, owned CCodex Release installation.'
}
$id = (Get-Content -LiteralPath (Join-Path $root 'current.txt') -Raw -Encoding UTF8).Trim()
if ($id -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$') { throw 'Invalid release selection.' }
$slot = Join-Path $root "versions\$id"
$runtime = Join-Path $slot 'runtime\primary\codex-primary-runtime\dependencies\native\powershell'
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$stage = Join-Path $tempBase ('ccodex-uninstall-' + [guid]::NewGuid().ToString('N'))
$cleaner = Join-Path $tempBase ('ccodex-uninstall-cleaner-' + [guid]::NewGuid().ToString('N') + '.exe')
$code = 1

function Test-RetryableDeleteError([Exception]$Error) {
    $current = $Error
    while ($current) {
        if ($current -is [IO.IOException] -or $current -is [UnauthorizedAccessException]) {
            return $true
        }
        $current = $current.InnerException
    }
    return $false
}
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    Copy-Item -LiteralPath (Join-Path $slot 'bin\ccodex-release-cleanup.exe') -Destination $cleaner
    $shell = Join-Path $stage 'ps'
    & (Join-Path $env:SystemRoot 'System32\robocopy.exe') $runtime $shell /E /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'Could not stage the private uninstaller runtime.' }
    $script = Join-Path $stage 'uninstall.ps1'
    Copy-Item -LiteralPath (Join-Path $slot 'release\uninstall.ps1') -Destination $script
    Copy-Item -LiteralPath (Join-Path $slot 'release\windows-locations.ps1') -Destination $stage
    Copy-Item -LiteralPath (Join-Path $slot 'release\command-path.ps1') -Destination $stage
    $arguments = @('-NoLogo','-NoProfile','-File',$script,'-InstallRoot',$root)
    if ($PurgeProfile) { $arguments += '-PurgeProfile' }
    if ($NoRegistration) { $arguments += '-NoRegistration' }
    if ($NoShortcuts) { $arguments += '-NoShortcuts' }
    # System PowerShell owns the dispatcher; no executable under the install
    # directory is running while the private worker removes that directory.
    & (Join-Path $shell 'pwsh.exe') @arguments
    $code = $LASTEXITCODE
} finally {
    $actual = (Resolve-Path -LiteralPath $stage).ProviderPath.TrimEnd('\')
    if ($actual -ne $stage -or (Split-Path -Parent $actual) -ne $tempBase -or
        (Split-Path -Leaf $actual) -notmatch '^ccodex-uninstall-[a-f0-9]{32}$' -or
        ((Get-Item -LiteralPath $stage -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Unexpected uninstall staging directory; it was not removed.'
    }
    & $cleaner $stage
    if ($LASTEXITCODE -ne 0) {
        $code = 1
        Write-Warning "Temporary uninstall resources could not be fully cleaned: $stage"
    }
    if ((Split-Path -Parent $cleaner) -ne $tempBase -or
        (Split-Path -Leaf $cleaner) -notmatch '^ccodex-uninstall-cleaner-[a-f0-9]{32}\.exe$') {
        throw 'Refusing unexpected cleanup-helper removal.'
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while ([IO.File]::Exists($cleaner)) {
        $item = Get-Item -LiteralPath $cleaner -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Refusing redirected cleanup-helper removal.'
        }
        try { [IO.File]::Delete($cleaner) }
        catch {
            if (-not (Test-RetryableDeleteError $_.Exception) -or [DateTime]::UtcNow -ge $deadline) { throw }
            Write-Host 'The release cleanup helper is temporarily busy; retrying without changing permissions.'
            Start-Sleep -Milliseconds 750
        }
    }
}
exit $code
