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
. (Join-Path $PSScriptRoot 'windows-locations.ps1')
. (Join-Path $PSScriptRoot 'command-path.ps1')
$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$resolved = (Resolve-Path -LiteralPath $root).ProviderPath.TrimEnd('\')
if (-not $resolved.Equals($root,[StringComparison]::OrdinalIgnoreCase) -or
    -not (Test-Path -LiteralPath (Join-Path $root '.ccodex-release-install.json')) -or
    (Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or
    $root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\') -or
    $root -eq [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\') -or
    $root -eq [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')) {
    throw 'Uninstall requires a verified CCodex Release-owned directory.'
}
if ((Get-Content -LiteralPath (Join-Path $root '.ccodex-release-install.json') -Raw |
    ConvertFrom-Json).product -ne 'CCodexRelease') {
    throw 'The installation marker belongs to another product.'
}
if (@(Get-ChildItem -LiteralPath $root -Recurse -Force -Attributes ReparsePoint).Count) {
    throw 'Redirected directories require inspection before uninstall. Nothing was removed.'
}
$processes = @(Get-CimInstance Win32_Process | Where-Object {
    if ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase)) {
        $live = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        $live -and -not $live.HasExited
    } else { $false }
})
if ($processes.Count) {
    throw ('Close CCodex Release and its bridge before uninstalling. No process was stopped. PIDs: ' +
        (($processes | ForEach-Object ProcessId) -join ', '))
}
$id = (Get-Content -LiteralPath (Join-Path $root 'current.txt') -Raw).Trim()
if ($id -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$') {
    throw 'Invalid release pointer. Nothing was removed.'
}
$slot = Join-Path $root "versions\$id"
$settingsFile = Join-Path $slot 'release-install.json'
if (-not (Test-Path -LiteralPath $settingsFile)) {
    $settingsFile = Join-Path $root 'release-install.json'
}
$settings = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
$profile = [IO.Path]::GetFullPath([string]$settings.profile).TrimEnd('\')
if ($settings.product -ne 'CCodexRelease' -or
    ($settings.releaseId -and $settings.releaseId -ne $id) -or
    -not ([string]$settings.installRoot).Equals($root,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'The installation receipt does not belong to this directory.'
}
if ($PurgeProfile -and (Test-Path -LiteralPath $profile)) {
    $forbidden = @([IO.Path]::GetPathRoot($profile).TrimEnd('\'),
        [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\'),
        [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\'),
        (Join-Path $env:USERPROFILE '.codex'),(Join-Path $env:USERPROFILE '.copilot'),
        (Join-Path $env:USERPROFILE '.codex-copilot'))
    foreach ($boundary in $forbidden) {
        if ($profile.Equals($boundary,[StringComparison]::OrdinalIgnoreCase) -or
            $profile.StartsWith($boundary + '\',[StringComparison]::OrdinalIgnoreCase) -and
                $boundary -match '\\\.(?:codex|copilot)' -or
            $boundary.StartsWith($profile + '\',[StringComparison]::OrdinalIgnoreCase)) {
            throw 'Profile purge would overlap a protected location.'
        }
    }
    $profileMarker = Join-Path $profile '.ccodex-release-profile.json'
    if ($profile -eq $root -or -not (Test-Path -LiteralPath $profileMarker) -or
        (Get-Content -LiteralPath $profileMarker -Raw | ConvertFrom-Json).product -ne 'CCodexRelease' -or
        @(Get-ChildItem -LiteralPath $profile -Recurse -Force -Attributes ReparsePoint).Count) {
        throw 'Profile purge requires a verified, unredirected release-owned profile.'
    }
}

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

$lock = [IO.File]::Open((Join-Path $root '.install.lock'),[IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
function Remove-OwnedComponent([string]$target) {
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while (Test-Path -LiteralPath $target) {
        $actual = (Resolve-Path -LiteralPath $target).ProviderPath
        $item = Get-Item -LiteralPath $target -Force
        if (-not $actual.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase) -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            ($item.PSIsContainer -and
                @(Get-ChildItem -LiteralPath $target -Recurse -Force -Attributes ReparsePoint).Count)) {
            throw 'Refusing to remove a redirected release component.'
        }
        try {
            Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
        } catch {
            if (-not (Test-RetryableDeleteError $_.Exception) -or [DateTime]::UtcNow -ge $deadline) { throw }
            Write-Host 'A release file is temporarily busy; retrying without closing another process.'
            Start-Sleep -Milliseconds 750
        }
    }
}
try {
if (-not $NoShortcuts) {
    $menu = if ($settings.shortcutMenu) { [string]$settings.shortcutMenu }
        else { Join-Path (Get-CCodexShellFolder 'Programs') 'CCodex Release' }
    if ((Split-Path -Leaf $menu) -notin @('CCodex Release','Ccodex') -or -not [IO.Path]::IsPathRooted($menu)) {
        throw 'The shortcut receipt does not identify a release-owned menu directory.'
    }
    if (Test-Path -LiteralPath $menu) {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($name in @('CCodex Release Desktop','CCodex Release CLI','CCodex Release Diagnostics',
            'Ccodex Desktop','Ccodex CLI','Ccodex Diagnostics')) {
            $file = Join-Path $menu ($name + '.lnk')
            if (Test-Path -LiteralPath $file) {
                $link = $shell.CreateShortcut($file)
                if ($link.Arguments.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                    $link.TargetPath.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase)) {
                    Remove-Item -LiteralPath $file -Force
                }
            }
        }
        if (@(Get-ChildItem -LiteralPath $menu -Force).Count -eq 0) { Remove-Item -LiteralPath $menu }
    }
}
if (-not $NoRegistration) {
    if ($settings.commandPathRegistered) { Unregister-CcodexCommand (Join-Path $root 'bin') }
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CCodexRelease'
    if (Test-Path -LiteralPath $key) {
        $registered = (Get-ItemProperty -LiteralPath $key).InstallLocation
        if ($registered -and $registered.Equals($root,[StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $key
        }
    }
}
$startup = Get-CCodexShellFolder 'Startup'
if (-not $NoShortcuts -and (Test-Path -LiteralPath $startup)) {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($file in Get-ChildItem -LiteralPath $startup -File -Filter 'CCodex Release Bridge *.lnk') {
        $link = $shell.CreateShortcut($file.FullName)
        if ($link.Arguments.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Remove-Item -LiteralPath $file.FullName
        }
    }
}
# Keep the small batch entry while cmd is reading it, plus the credential-free
# marker needed for safe reinstall with an external or purged profile.
foreach ($relative in @('versions','bin','current.txt','previous.txt','release-install.json')) {
    $target = Join-Path $root $relative
    if (Test-Path -LiteralPath $target) {
        Remove-OwnedComponent $target
    }
}
if ($PurgeProfile -and (Test-Path -LiteralPath $profile)) {
    if ($profile -eq $root -or
        -not (Test-Path -LiteralPath (Join-Path $profile '.ccodex-release-profile.json')) -or
        (Get-Item -LiteralPath $profile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Profile purge requires the separately verified release-profile marker.'
    }
    $actual = (Resolve-Path -LiteralPath $profile).ProviderPath
    if (-not $actual.Equals($profile,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing a redirected data directory.'
    }
    Remove-Item -LiteralPath $profile -Recurse -Force
}
[IO.File]::WriteAllText((Join-Path $root '.ccodex-release-install.json'),
    (@{product='CCodexRelease';schemaVersion=1;uninstalled=$true;
        installRoot=$root;profile=$profile} | ConvertTo-Json -Compress),
    [Text.UTF8Encoding]::new($false))
Write-Host 'CCodex Release removed. Existing Codex/Copilot were not modified.'
if (-not $PurgeProfile) { Write-Host "Your CCodex Release profile and credentials were preserved: $profile" }
} finally { $lock.Dispose() }
