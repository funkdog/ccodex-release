[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CCodexRelease'),
    [string]$Profile,
    [switch]$NoShortcuts,
    [switch]$NoRegistration,
    [switch]$NoLogin,
    [switch]$Silent
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'windows-locations.ps1')
. (Join-Path $PSScriptRoot 'install-profile.ps1')
. (Join-Path $PSScriptRoot 'command-path.ps1')
$env:NODE_OPTIONS = ''
$env:NODE_PATH = ''
$env:ELECTRON_RUN_AS_NODE = ''
$source = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$metadata = Get-Content -LiteralPath (Join-Path $source 'release.json') -Raw | ConvertFrom-Json
$InstallRoot = Get-CCodexInstallRoot $InstallRoot ($PSBoundParameters.ContainsKey('InstallRoot')) (-not $NoRegistration) $metadata
$Profile = Get-CCodexInstallProfile $InstallRoot $Profile
Write-Host ("Independent installation directory: " + $InstallRoot)
Write-Host ("Independent profile directory: " + $Profile)
$menu = $null
if (-not $NoShortcuts) {
    $menu = Join-Path (Get-CCodexShellFolder 'Programs') 'Ccodex'
    if (Test-Path -LiteralPath $menu) {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($file in Get-ChildItem -LiteralPath $menu -File -Filter '*.lnk') {
            $link = $shell.CreateShortcut($file.FullName)
            if ($link.Arguments.IndexOf($InstallRoot,[StringComparison]::OrdinalIgnoreCase) -lt 0 -and
                -not $link.TargetPath.StartsWith($InstallRoot + '\',[StringComparison]::OrdinalIgnoreCase)) {
                throw 'A shortcut from another installation exists; it was not replaced.'
            }
        }
    }
}
if (-not $NoRegistration) {
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CCodexRelease'
    if (Test-Path -LiteralPath $key) {
        $previousLocation = (Get-ItemProperty -LiteralPath $key).InstallLocation
        if (-not $previousLocation -or
            -not $previousLocation.Equals($InstallRoot,[StringComparison]::OrdinalIgnoreCase)) {
            throw 'Another release registration exists; it was not replaced.'
        }
    }
}
if ($metadata.releaseId -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$' -or
    $metadata.target -ne 'windows-arm64') {
    throw 'Invalid release identifier or package target.'
}
if ($InstallRoot -match '[%!\r\n]' -or $Profile -match '[%!\r\n]') {
    throw 'This Windows command launcher requires paths without percent, exclamation or newline characters.'
}
function Assert-SafeRoot([string]$Path) {
    $broad = @([IO.Path]::GetPathRoot($Path).TrimEnd('\'),
        [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\'),
        [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\'),
        [IO.Path]::GetFullPath($env:APPDATA).TrimEnd('\'))
    if ($broad -contains $Path) { throw 'Refusing a broad installation/data directory.' }
    foreach ($stock in @((Join-Path $env:USERPROFILE '.codex'),
        (Join-Path $env:USERPROFILE '.copilot'),
        (Join-Path $env:USERPROFILE '.codex-copilot'),
        (Join-Path $env:LOCALAPPDATA 'CodexCopilot'),
        (Join-Path $env:LOCALAPPDATA 'OpenAI'),
        (Join-Path $env:APPDATA 'npm'))) {
        $stock = [IO.Path]::GetFullPath($stock).TrimEnd('\')
        if ($Path.Equals($stock,[StringComparison]::OrdinalIgnoreCase) -or
            $Path.StartsWith($stock + '\',[StringComparison]::OrdinalIgnoreCase) -or
            $stock.StartsWith($Path + '\',[StringComparison]::OrdinalIgnoreCase)) {
            throw "The release cannot be installed over an existing product: $stock"
        }
    }
    $ancestor = $Path
    while ($ancestor -and -not (Test-Path -LiteralPath $ancestor)) {
        $ancestor = Split-Path -Parent $ancestor
    }
    while ($ancestor) {
        if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Installation paths cannot traverse a junction or symbolic link.'
        }
        $ancestor = Split-Path -Parent $ancestor
    }
}
if ($Profile.StartsWith($source + '\',[StringComparison]::OrdinalIgnoreCase) -or
    $source.StartsWith($Profile + '\',[StringComparison]::OrdinalIgnoreCase) -or
    $Profile.Equals($source,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'The mutable profile cannot overlap the resource source.'
}
Assert-SafeRoot $InstallRoot
Assert-SafeRoot $Profile
if ($Profile.Equals($InstallRoot,[StringComparison]::OrdinalIgnoreCase) -or
    $Profile.StartsWith((Join-Path $InstallRoot 'versions') + '\',[StringComparison]::OrdinalIgnoreCase) -or
    $Profile.Equals((Join-Path $InstallRoot 'versions'),[StringComparison]::OrdinalIgnoreCase) -or
    $Profile.Equals((Join-Path $InstallRoot 'bin'),[StringComparison]::OrdinalIgnoreCase) -or
    $Profile.StartsWith((Join-Path $InstallRoot 'bin') + '\',[StringComparison]::OrdinalIgnoreCase) -or
    $InstallRoot.StartsWith($Profile + '\',[StringComparison]::OrdinalIgnoreCase) -or
    $InstallRoot.StartsWith($source + '\',[StringComparison]::OrdinalIgnoreCase) -or
    $source.StartsWith($InstallRoot + '\',[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installation, source and mutable profile directories cannot overlap.'
}
$architecture = $env:PROCESSOR_ARCHITEW6432
if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
if ($architecture -ne 'ARM64') {
    throw "This release requires Windows ARM64; detected $architecture. It is not an x64 or macOS package."
}
if ([Environment]::OSVersion.Version.Build -lt 22000) {
    throw 'This release requires Windows 11 ARM64.'
}
if (Test-Path -LiteralPath $InstallRoot) {
    $owner = Join-Path $InstallRoot '.ccodex-release-install.json'
    if (-not (Test-Path -LiteralPath $owner) -and
        @(Get-ChildItem -LiteralPath $InstallRoot -Force).Count -gt 0) {
        $remaining = @(Get-ChildItem -LiteralPath $InstallRoot -Force |
            Where-Object { $_.Name -notin @('profile','.install.lock') })
        $savedProfile = Join-Path $InstallRoot 'profile\.ccodex-release-profile.json'
        if ($remaining.Count -or -not (Test-Path -LiteralPath $savedProfile) -or
            (Get-Content -LiteralPath $savedProfile -Raw | ConvertFrom-Json).product -ne 'CCodexRelease') {
            throw 'Installation directory is not owned by CCodex Release. Existing files were not changed.'
        }
    }
    if ((Test-Path -LiteralPath $owner) -and
        (Get-Content -LiteralPath $owner -Raw | ConvertFrom-Json).product -ne 'CCodexRelease') {
        throw 'The installation marker belongs to another product.'
    }
}
$volume = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($InstallRoot))
$required = [long]$metadata.totalBytes + [long]$metadata.profileSeedBytes + 1GB
if ($volume.AvailableFreeSpace -lt $required) {
    throw "Insufficient disk space. At least $([math]::Ceiling($required/1GB)) GiB free is required."
}
if ($metadata.preliminary -or $metadata.fileCount -lt 1) {
    throw 'This is an unfinished build, not an installable release.'
}
if ($Profile -ne (Join-Path $InstallRoot 'profile')) {
    $profileVolume = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($Profile))
    if ($profileVolume.AvailableFreeSpace -lt ([long]$metadata.profileSeedBytes + 1GB)) {
        throw 'Insufficient disk space on the selected profile volume.'
    }
}
$node = Join-Path $source 'runtime\node\node.exe'
Write-Host '[1/5] Checking the bundled resources and pinned versions.'
& $node (Join-Path $source 'release\verify.mjs') --payload --quick
if ($LASTEXITCODE -ne 0) { throw 'Release integrity verification failed.' }
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
$marker = Join-Path $InstallRoot '.ccodex-release-install.json'
if (-not (Test-Path -LiteralPath $marker)) {
    [IO.File]::WriteAllText($marker, '{"product":"CCodexRelease","schemaVersion":1}',
        [Text.UTF8Encoding]::new($false))
}
$versions = Join-Path $InstallRoot 'versions'
New-Item -ItemType Directory -Path $versions -Force | Out-Null
$slot = Join-Path $versions $metadata.releaseId
$stage = Join-Path $versions ('staging-' + [guid]::NewGuid().ToString('N'))
$lock = $null
try {
    $lockPath = Join-Path $InstallRoot '.install.lock'
    try { $lock = [IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
    catch { throw 'Another installation or uninstall is active. Retry when it finishes.' }
    [IO.File]::WriteAllText($marker,
        (@{product='CCodexRelease';schemaVersion=1;installRoot=$InstallRoot;profile=$Profile} |
            ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Write-Host '[2/5] Installing private ccodex, Desktop, Copilot and offline dependencies.'
    if (Test-Path -LiteralPath $slot) {
        $existing = Get-Content -LiteralPath (Join-Path $slot 'release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($existing.fileManifestSha256 -ne $metadata.fileManifestSha256) {
            throw 'This immutable release ID already has different resources. Install a uniquely versioned release instead.'
        }
        & (Join-Path $slot 'runtime\node\node.exe') (Join-Path $slot 'release\verify.mjs') --payload
        if ($LASTEXITCODE -ne 0) { throw 'The existing immutable release slot is different or damaged.' }
    } else {
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        & robocopy.exe $source $stage /E /XJ /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw 'Release copy failed. The previous release is still selected.' }
        & (Join-Path $stage 'runtime\node\node.exe') (Join-Path $stage 'release\verify.mjs') --payload
        if ($LASTEXITCODE -ne 0) { throw 'Copied resources failed integrity checks.' }
        $resolved = (Resolve-Path -LiteralPath $stage).ProviderPath
        if (-not $resolved.StartsWith($versions + '\',[StringComparison]::OrdinalIgnoreCase) -or
            (Split-Path -Leaf $resolved) -notmatch '^staging-[a-f0-9]{32}$') {
            throw 'Refusing to move an unexpected installation stage.'
        }
        Move-Item -LiteralPath $stage -Destination $slot
    }
    Write-Host '[3/5] Creating an independent credential-free profile and a free loopback port.'
    & (Join-Path $slot 'runtime\node\node.exe') (Join-Path $slot 'release\prepare-profile.mjs') $slot $Profile
    if ($LASTEXITCODE -ne 0) { throw 'Release profile preparation failed. No original profile was imported.' }
    $settings = @{schemaVersion=1;product='CCodexRelease';releaseId=$metadata.releaseId;
        profile=$Profile;installRoot=$InstallRoot;installedAt=[DateTime]::UtcNow.ToString('o')}
    $existingReceipt = Join-Path $InstallRoot 'release-install.json'
    if (Test-Path -LiteralPath $existingReceipt) {
        $previous = Get-Content -LiteralPath $existingReceipt -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($previous.shortcutMenu) { $settings.shortcutMenu = [string]$previous.shortcutMenu }
        if ($previous.workspace) { $settings.workspace = [string]$previous.workspace }
        if ($previous.commandPathRegistered) { $settings.commandPathRegistered = $true }
    }
    if ($menu) { $settings.shortcutMenu = $menu }
    if (-not $settings.workspace) {
        $documents = [Environment]::GetFolderPath('MyDocuments')
        if (-not $documents) { $documents = Join-Path $env:USERPROFILE 'Documents' }
        $settings.workspace = Join-Path $documents 'Ccodex Workspace'
    }
    $corePointer = Join-Path $slot 'bin\core-current.txt'
    if (-not (Test-Path -LiteralPath $corePointer)) {
        [IO.File]::WriteAllText($corePointer,(Join-Path $slot $metadata.corePath) + "`r`n",
            [Text.UTF8Encoding]::new($false))
    }
    [IO.File]::WriteAllText((Join-Path $slot 'release-install.json'),
        ($settings | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    & (Join-Path $slot 'runtime\node\node.exe') (Join-Path $slot 'release\verify.mjs') --installed --quick
    if ($LASTEXITCODE -ne 0) { throw 'Installed pre-activation checks failed; the old version selection was preserved.' }
    Write-Host 'Preparing verified fast-start resources once during installation.'
    & (Join-Path $slot 'runtime\node\node.exe') (Join-Path $slot 'release\startup-preparation.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Installed startup preparation failed; no command was promoted.' }
    $bin = Join-Path $InstallRoot 'bin'
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    $entryTemplate = Get-Content -LiteralPath (Join-Path $slot 'release\entry.cmd') -Raw
    [IO.File]::WriteAllText((Join-Path $bin 'ccodex.cmd'),
        $entryTemplate.Replace('@@COMMAND@@',''),[Text.Encoding]::ASCII)
    foreach ($name in @('ccodex-release.cmd','ccodex-desktop.cmd','ccodex-release-doctor.cmd')) {
        $oldEntry = Join-Path $bin $name
        if (Test-Path -LiteralPath $oldEntry) {
            $text = Get-Content -LiteralPath $oldEntry -Raw
            if ($text.Contains('CC_RELEASE_ROOT') -and $text.Contains('CC_RELEASE_SLOT')) {
                Remove-Item -LiteralPath $oldEntry -Force
            } else { throw 'An obsolete command entry contains unrecognized user changes.' }
        }
    }
    Copy-Item -LiteralPath (Join-Path $slot 'bin\codex-copilot-desktop.exe') `
        -Destination (Join-Path $bin 'Ccodex Desktop.exe') -Force
    Copy-Item -LiteralPath (Join-Path $slot 'release\cli-shell.cmd') -Destination $bin -Force
    Copy-Item -LiteralPath (Join-Path $slot 'release\uninstall.cmd') -Destination $InstallRoot -Force
    [IO.File]::WriteAllText((Join-Path $InstallRoot 'release-install.json'),
        ($settings | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    $pointer = Join-Path $InstallRoot 'current.txt'
    $pending = Join-Path $InstallRoot ('current-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($pending,$metadata.releaseId + "`r`n",[Text.Encoding]::ASCII)
    if (Test-Path -LiteralPath $pointer) {
        [IO.File]::Replace($pending,$pointer,(Join-Path $InstallRoot 'previous.txt'))
    } else { [IO.File]::Move($pending,$pointer) }
    Write-Host '[4/5] Registering distinct shortcuts without changing system codex/copilot.'
    if (-not $NoShortcuts) {
        $shell = New-Object -ComObject WScript.Shell
        New-Item -ItemType Directory -Path $menu -Force | Out-Null
        $definitions = @(
            @{Name='Ccodex Desktop';Entry='desktop'},
            @{Name='Ccodex CLI';Entry='cli'},
            @{Name='Ccodex Diagnostics';Entry='doctor'}
        )
        foreach ($item in $definitions) {
            $shortcutFile = Join-Path $menu ($item.Name + '.lnk')
            $shortcut = $shell.CreateShortcut($shortcutFile)
            if ((Test-Path -LiteralPath $shortcutFile) -and
                $shortcut.Arguments.IndexOf($InstallRoot,[StringComparison]::OrdinalIgnoreCase) -lt 0 -and
                -not $shortcut.TargetPath.StartsWith($InstallRoot + '\',[StringComparison]::OrdinalIgnoreCase)) {
                throw 'A shortcut from another release installation exists. It was not replaced.'
            }
            $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\cmd.exe'
            $shortcut.Arguments = '/d /k ""' + (Join-Path $bin 'ccodex.cmd') + '" release-doctor"'
            if ($item.Entry -eq 'desktop') {
                $shortcut.TargetPath = Join-Path $bin 'Ccodex Desktop.exe'
                $shortcut.Arguments = ''
            }
            if ($item.Entry -eq 'cli') {
                $shortcut.Arguments = '/d /c ""' + (Join-Path $bin 'cli-shell.cmd') + '""'
            }
            [IO.Directory]::CreateDirectory([string]$settings.workspace) | Out-Null
            $shortcut.WorkingDirectory = [string]$settings.workspace
            $shortcut.IconLocation = (Join-Path $slot 'assets\codex-copilot.ico') + ',0'
            $shortcut.Description = 'Isolated ARM64 ccodex and Desktop; stock Codex and Copilot are preserved.'
            $shortcut.Save()
        }
        $legacyMenu = Join-Path (Get-CCodexShellFolder 'Programs') 'CCodex Release'
        foreach ($name in @('CCodex Release Desktop','CCodex Release CLI','CCodex Release Diagnostics')) {
            $legacy = Join-Path $legacyMenu ($name + '.lnk')
            if (Test-Path -LiteralPath $legacy) {
                $link = $shell.CreateShortcut($legacy)
                if ($link.TargetPath.StartsWith($InstallRoot + '\',[StringComparison]::OrdinalIgnoreCase) -or
                    $link.Arguments.IndexOf($InstallRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    Remove-Item -LiteralPath $legacy -Force
                }
            }
        }
        if ((Test-Path -LiteralPath $legacyMenu) -and
            @(Get-ChildItem -LiteralPath $legacyMenu -Force).Count -eq 0) {
            Remove-Item -LiteralPath $legacyMenu
        }
    }
    if (-not $NoRegistration) {
        $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CCodexRelease'
        if (Test-Path -LiteralPath $key) {
            $previousLocation = (Get-ItemProperty -LiteralPath $key).InstallLocation
            if ($previousLocation -and
                -not $previousLocation.Equals($InstallRoot,[StringComparison]::OrdinalIgnoreCase)) {
                throw 'Another release registration exists. It was not replaced.'
            }
        }
        New-Item -Path $key -Force | Out-Null
        foreach ($entry in @{
            DisplayName='Ccodex Desktop (Windows ARM64)';DisplayVersion=$metadata.packageVersion;
            Publisher='CCodex internal team release';InstallLocation=$InstallRoot;
            UninstallString=('"' + (Join-Path $env:SystemRoot 'System32\cmd.exe') +
                '" /d /c ""' + (Join-Path $InstallRoot 'uninstall.cmd') + '""');
            NoModify=1;NoRepair=1
        }.GetEnumerator()) {
            New-ItemProperty -LiteralPath $key -Name $entry.Key -Value $entry.Value -Force | Out-Null
        }
        if (Register-CcodexCommand $bin) { $settings.commandPathRegistered = $true }
        foreach ($receipt in @((Join-Path $InstallRoot 'release-install.json'),(Join-Path $slot 'release-install.json'))) {
            [IO.File]::WriteAllText($receipt,($settings | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
        }
        & (Join-Path $slot 'bin\ccodex-process-probe.exe') notify
    }
    Write-Host '[5/5] Running offline feature and conflict checks.'
    & (Join-Path $slot 'runtime\node\node.exe') (Join-Path $slot 'release\verify.mjs') --installed --quick
    if ($LASTEXITCODE -ne 0) { throw 'The installed release requires inspection; see the diagnostics output.' }
    Write-Host ''
    Write-Host 'Ccodex is installed. Original Codex/Copilot binaries and profiles were not changed.'
    Write-Host ("CLI: " + (Join-Path $bin 'ccodex.cmd'))
    Write-Host 'Open Ccodex Desktop to sign in graphically with your own GitHub Copilot account.'
    Write-Host 'Work IQ requires your own Microsoft login and explicit data-sharing consent.'
    $env:CODEX_COPILOT_HOME = $Profile
    & (Join-Path $slot 'runtime\node\node.exe') (Join-Path $slot 'release\showcase.mjs')
    if (-not $NoLogin -and -not $Silent) {
        $answer = Read-Host 'Start GitHub Copilot sign-in now? [y/N]'
        if ($answer -match '^(?i:y|yes)$') {
            & (Join-Path $slot 'runtime\node\node.exe') (Join-Path $slot 'release\launch.mjs') login --force
            if ($LASTEXITCODE -ne 0) {
                Write-Warning 'Files remain installed. Retry sign-in through Ccodex Desktop.'
            }
        }
    }
} finally {
    try {
        if (Test-Path -LiteralPath $stage) {
            try { Remove-CCodexInstallStage $stage $versions }
            catch { Write-Warning ("Installation stage preserved for inspection: " + $stage + ". " + $_.Exception.Message) }
        }
    } finally { if ($lock) { $lock.Dispose() } }
}
