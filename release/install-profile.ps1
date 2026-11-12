function Test-CCodexInstallLocation([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    $directory = Get-Item -LiteralPath $Path -Force
    if (-not $directory.PSIsContainer -or
        ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The installation directory must be a regular directory, not a file or link.'
    }
    $children = @(Get-ChildItem -LiteralPath $Path -Force)
    if ($children.Count -eq 0) { return $true }
    $marker = Join-Path $Path '.ccodex-release-install.json'
    if (Test-Path -LiteralPath $marker) {
        $item = Get-Item -LiteralPath $marker -Force
        if ($item.PSIsContainer -or $item.Length -gt 64KB -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'The installation ownership marker must be a bounded regular file.'
        }
        $owner = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
        return $owner.product -eq 'CCodexRelease' -and $owner.schemaVersion -eq 1
    }
    $remaining = @($children | Where-Object { $_.Name -notin @('profile', '.install.lock') })
    $profileDirectory = Join-Path $Path 'profile'
    return $remaining.Count -eq 0 -and
        (Test-Path -LiteralPath (Join-Path $profileDirectory '.ccodex-release-profile.json')) -and
        (Test-CCodexProfileLocation $profileDirectory)
}

function Test-CCodexNativePaths([string]$InstallRoot, [object]$Metadata) {
    if (-not $Metadata) { return $true }
    foreach ($id in @([string]$Metadata.releaseId, ('staging-' + ('a' * 32)))) {
        $slot = Join-Path $InstallRoot ('versions\' + $id)
        foreach ($relative in @([string]$Metadata.corePath,
            'runtime\primary\codex-primary-runtime\dependencies\python\python312.dll',
            'runtime\primary\codex-primary-runtime\dependencies\native\powershell\pwsh.exe',
            ('desktop\versions\' + $Metadata.desktopSnapshot + '\app\resources\codex.exe'),
            ('runtime\copilot\node_modules\@github\copilot-win32-' +
                $Metadata.target.Substring('windows-'.Length) + '\copilot.exe'))) {
            if ((Join-Path $slot $relative).Length -ge 240) { return $false }
        }
    }
    return $true
}

function Get-CCodexInstallRoot([string]$InstallRoot, [bool]$Explicit, [bool]$UseRegistration,
    [object]$Metadata) {
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    if (-not $Explicit -and $UseRegistration) {
        $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CCodexRelease'
        if (Test-Path -LiteralPath $key) {
            $previous = [string](Get-ItemProperty -LiteralPath $key).InstallLocation
            if (-not [IO.Path]::IsPathRooted($previous) -or
                -not (Test-Path -LiteralPath (Join-Path $previous '.ccodex-release-install.json')) -or
                -not (Test-CCodexInstallLocation $previous)) {
                throw 'The registered CCodex Release directory needs inspection; it was not replaced.'
            }
            $previous = [IO.Path]::GetFullPath($previous).TrimEnd('\')
            if (-not (Test-CCodexNativePaths $previous $Metadata)) {
                throw 'The registered installation path is too long for the pinned native runtimes; existing data was preserved.'
            }
            return $previous
        }
    }
    if ((Test-CCodexNativePaths $InstallRoot $Metadata) -and
        (Test-CCodexInstallLocation $InstallRoot)) { return $InstallRoot }
    if ($Explicit) {
        if (-not (Test-CCodexNativePaths $InstallRoot $Metadata)) {
            throw 'The selected installation path is too long for the pinned native runtimes. Choose a shorter empty directory; no resources were copied.'
        }
        throw 'The selected installation directory is not owned by CCodex Release; existing files were preserved.'
    }
    # Deterministic alternatives preserve preferences across uninstall/reinstall.
    # An occupied, unowned alternative is skipped, never adopted or emptied.
    for ($index = 1; $index -le 100; $index++) {
        $suffix = if ($index -eq 1) { '-Isolated' } else { '-Isolated-' + $index }
        $candidate = $InstallRoot + $suffix
        if ((Test-CCodexNativePaths $candidate $Metadata) -and
            (Test-CCodexInstallLocation $candidate)) { return $candidate }
    }
    if ($Metadata) {
        $local = [Environment]::GetFolderPath('LocalApplicationData')
        $cached = [Microsoft.Win32.Registry]::GetValue(
            'HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders',
            'Local AppData', $null)
        if ($cached -and [IO.Path]::IsPathRooted([string]$cached) -and
            ([string]::IsNullOrWhiteSpace($local) -or ([string]$cached).Length -lt $local.Length)) {
            $local = [string]$cached
        }
        if (-not [string]::IsNullOrWhiteSpace($local)) {
            $base = Join-Path $local ('CCodexRelease-' + $Metadata.target.Substring('windows-'.Length))
            for ($index = 1; $index -le 100; $index++) {
                $candidate = $base + $(if ($index -eq 1) { '' } else { '-' + $index })
                if ((Test-CCodexNativePaths $candidate $Metadata) -and
                    (Test-CCodexInstallLocation $candidate)) { return $candidate }
            }
        }
    }
    throw 'No independent installation location is available; choose an empty directory explicitly.'
}

function Remove-CCodexInstallStage([string]$Stage, [string]$Versions) {
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while (Test-Path -LiteralPath $Stage) {
        $actual = (Resolve-Path -LiteralPath $Stage).ProviderPath
        if (-not $actual.StartsWith($Versions + '\', [StringComparison]::OrdinalIgnoreCase) -or
            (Split-Path -Leaf $actual) -notmatch '^staging-[a-f0-9]{32}$' -or
            ((Get-Item -LiteralPath $actual -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            @(Get-ChildItem -LiteralPath $actual -Recurse -Force -Attributes ReparsePoint).Count) {
            throw 'Refusing redirected installation-stage cleanup.'
        }
        try { Remove-Item -LiteralPath $actual -Recurse -Force -ErrorAction Stop }
        catch {
            $errorValue = $_.Exception
            $retryable = $false
            while ($errorValue) {
                if ($errorValue -is [IO.IOException] -or $errorValue -is [UnauthorizedAccessException]) {
                    $retryable = $true
                }
                $errorValue = $errorValue.InnerException
            }
            if (-not $retryable -or [DateTime]::UtcNow -ge $deadline) { throw }
            Start-Sleep -Milliseconds 750
        }
    }
}

function Test-CCodexProfileLocation([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    $directory = Get-Item -LiteralPath $Path -Force
    if (-not $directory.PSIsContainer -or
        ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The profile directory must be a regular directory, not a file or link.'
    }
    if (@(Get-ChildItem -LiteralPath $Path -Force).Count -eq 0) { return $true }
    $marker = Join-Path $Path '.ccodex-release-profile.json'
    if (-not (Test-Path -LiteralPath $marker)) { return $false }
    $item = Get-Item -LiteralPath $marker -Force
    if ($item.PSIsContainer -or $item.Length -gt 4096 -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The profile ownership marker must be a small regular file.'
    }
    $owner = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
    return $owner.product -eq 'CCodexRelease' -and $owner.schemaVersion -eq 1
}

function Get-CCodexInstallProfile([string]$InstallRoot, [string]$Profile) {
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    if ($Profile) {
        $selected = [IO.Path]::GetFullPath($Profile).TrimEnd('\')
        if (-not (Test-CCodexProfileLocation $selected)) {
            throw 'The selected data directory is not owned by CCodex Release; existing files were preserved.'
        }
        return $selected
    }
    foreach ($name in @('release-install.json', '.ccodex-release-install.json')) {
        $receiptFile = Join-Path $InstallRoot $name
        if (-not (Test-Path -LiteralPath $receiptFile)) { continue }
        $item = Get-Item -LiteralPath $receiptFile -Force
        if ($item.PSIsContainer -or $item.Length -gt 64KB -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'The previous installation receipt must be a bounded regular file.'
        }
        $receipt = Get-Content -LiteralPath $receiptFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($name -eq '.ccodex-release-install.json' -and -not $receipt.profile) { continue }
        if ($receipt.product -ne 'CCodexRelease' -or $receipt.schemaVersion -ne 1 -or
            -not ([string]$receipt.installRoot).Equals($InstallRoot, [StringComparison]::OrdinalIgnoreCase) -or
            -not [IO.Path]::IsPathRooted([string]$receipt.profile)) {
            throw 'The previous installation receipt does not belong to this directory.'
        }
        return Get-CCodexInstallProfile $InstallRoot ([string]$receipt.profile)
    }
    $selected = Join-Path $InstallRoot 'profile'
    if (Test-CCodexProfileLocation $selected) { return $selected }
    # Preserve all unowned data, including caches from earlier failed probes.
    do {
        $selected = Join-Path $InstallRoot ('profile-isolated-' + [guid]::NewGuid().ToString('N'))
    } while (Test-Path -LiteralPath $selected)
    return $selected
}
