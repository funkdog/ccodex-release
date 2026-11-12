<#
.SYNOPSIS
    Installs "Codex (Copilot)" - the native Codex desktop app and CLI driven by GitHub Copilot.

.DESCRIPTION
    Creates a second, self-contained Codex profile (CODEX_HOME = ~/.codex-copilot) whose
    model provider is a local bridge to api.githubcopilot.com. The stock `codex` command
    and the stock Codex desktop app keep using ~/.codex and are never modified.

    Installs:
      * %LOCALAPPDATA%\CodexCopilot          - bridge, launchers, assets
      * ~/.codex-copilot                     - the Copilot Codex profile
      * codex-copilot / ccodex               - CLI commands on PATH
      * Start menu entries "Codex (Copilot)" and "Codex (Copilot) CLI"

.PARAMETER Uninstall
    Removes the launchers, shortcuts and PATH entry. The ~/.codex-copilot profile is kept
    unless -Purge is also given.

.PARAMETER NoPrerequisiteInstall
    Do not attempt to install the official Codex/ChatGPT Microsoft Store package when missing.

.PARAMETER UseBundledCodexRuntime
    Use the CLI/runtime embedded in the official desktop package instead of a materialized
    runtime under %LOCALAPPDATA%\OpenAI\Codex\bin. Useful for recovery and smoke testing.

.PARAMETER ChatGptDesktopPath
    Optional ChatGPT/Codex Desktop executable or program directory when automatic discovery
    cannot find the installed app.

.PARAMETER CodexCliPath
    Optional codex.exe or containing program directory when automatic discovery fails.

.PARAMETER CopilotCliPath
    Optional GitHub Copilot CLI executable, package directory, or copilot-sdk/index.js path.

.PARAMETER PreflightOnly
    Run the guided resource scan and visual feature comparison without copying or changing files.
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$Purge,
    [switch]$SkipLogin,
    [switch]$SkipSkill,
    [switch]$NoPath,
    [switch]$NoShortcuts,
    [switch]$NoStart,
    [switch]$NoPrerequisiteInstall,
    [switch]$UseBundledCodexRuntime,
    [switch]$PreflightOnly,
    [string]$ChatGptDesktopPath = $env:CODEX_COPILOT_DESKTOP_RESOURCE,
    [string]$CodexCliPath = $env:CODEX_COPILOT_CODEX_CLI,
    [string]$CopilotCliPath = $env:CODEX_COPILOT_COPILOT_CLI,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexCopilot'),
    [string]$CodexCopilotHome = (Join-Path $env:USERPROFILE '.codex-copilot'),
    [string]$SourceCodexHome = (Join-Path $env:USERPROFILE '.codex'),
    [string]$DefaultModel,
    [string]$DefaultEffort,
    [ValidateSet('auto', 'credential-manager', 'saved', 'environment')]
    [string]$AuthMode = 'auto',
    [int]$BridgePort = 22690
)

$ErrorActionPreference = 'Stop'
$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $PreflightOnly -and -not $Uninstall -and
    ((Get-Process -Id $PID).PriorityClass -notin @('BelowNormal','Idle') -or
     $env:CARGO_BUILD_JOBS -ne '6')) {
    throw 'Use install.cmd (which schedules the resource-limited worker) or invoke install.ps1 through tools\Invoke-HeavyTask.ps1.'
}
$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$DesktopName = 'Codex (Copilot)'
$CliName = 'Codex (Copilot) CLI'
$HistoryName = 'Codex (Copilot) History'
$SkillName = 'codex-copilot-manager'
$SkillTarget = Join-Path $env:USERPROFILE ".copilot\skills\$SkillName"
$CodexStoreProductId = '9PLM9XGG6VKS'
$CodexStoreUrl = "https://apps.microsoft.com/detail/$CodexStoreProductId"
$CodexCliInstallUrl = 'https://developers.openai.com/codex/cli'
$CopilotCliInstallUrl = 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli'
$bridgePortExplicit = $PSBoundParameters.ContainsKey('BridgePort')
if (-not $bridgePortExplicit) {
    $existingPortPointer = Join-Path $CodexCopilotHome 'bridge-port.txt'
    if (Test-Path -LiteralPath $existingPortPointer -PathType Leaf) {
        $portItem = Get-Item -LiteralPath $existingPortPointer -Force
        $rawPort = [IO.File]::ReadAllText($existingPortPointer)
        $portMatch = [regex]::Match($rawPort, '\A([0-9]{1,16})(?:\r?\n)?\z')
        $parsedPort = 0
        if ($portItem.LinkType -or $portItem.Length -gt 32 -or -not $portMatch.Success -or
            -not [int]::TryParse($portMatch.Groups[1].Value, [ref]$parsedPort) -or
            $parsedPort -lt 1024 -or $parsedPort -gt 65535) {
            throw "Invalid bridge port pointer: $existingPortPointer"
        }
        $BridgePort = $parsedPort
    }
}
if ($BridgePort -lt 1024 -or $BridgePort -gt 65535) {
    throw 'BridgePort must be a loopback port between 1024 and 65535.'
}
$installerUi = Join-Path $SourceRoot 'tools\installer-ui.ps1'
if (-not (Test-Path -LiteralPath $installerUi)) { throw "Installer UI module is missing: $installerUi" }
. $installerUi
$PackageTargetFile = Join-Path $SourceRoot 'platform-target.json'
$PackageTarget = if (Test-Path -LiteralPath $PackageTargetFile) {
    Get-Content -LiteralPath $PackageTargetFile -Raw | ConvertFrom-Json
} else {
    $null
}

$transferSettingsPath = Join-Path $SourceRoot 'transfer-settings.json'
if (Test-Path -LiteralPath $transferSettingsPath) {
    $transferSettings = Get-Content -LiteralPath $transferSettingsPath -Raw | ConvertFrom-Json
    if (-not $PSBoundParameters.ContainsKey('DefaultModel') -and $transferSettings.defaultModel) {
        $DefaultModel = [string]$transferSettings.defaultModel
    }
    if (-not $PSBoundParameters.ContainsKey('DefaultEffort') -and $transferSettings.defaultReasoningEffort) {
        $DefaultEffort = [string]$transferSettings.defaultReasoningEffort
    }
    if ($transferSettings.defaultContextTier) {
        $env:CODEX_COPILOT_DEFAULT_CONTEXT_TIER = [string]$transferSettings.defaultContextTier
    }
}

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Ok($message) { Write-Host "    $message" -ForegroundColor DarkGray }

function Get-InstalledBridgeGeneration([string]$Node, [string]$Root) {
    $script = @'
import { pathToFileURL } from "node:url";
const { bridgeSourceGeneration } = await import(pathToFileURL(process.argv[1]));
process.stdout.write(bridgeSourceGeneration());
'@
    $generation = (& $Node --input-type=module -e $script `
        (Join-Path $Root 'bridge\runtime-generation.mjs') | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $generation -notmatch '^[a-f0-9]{64}$') {
        throw 'Could not verify the installed bridge source generation.'
    }
    return $generation
}

function Find-FreeBridgePort {
    for ($candidate = 22691; $candidate -le 22749; $candidate++) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $candidate)
        try {
            $listener.Start()
            return $candidate
        } catch [Net.Sockets.SocketException] {
            continue
        } finally {
            $listener.Stop()
        }
    }
    throw 'No free CodexCopilot loopback port is available for a side-by-side bridge.'
}

function Set-BridgePortPointer([string]$ProfileHome, [int]$Port) {
    New-Item -ItemType Directory -Path $ProfileHome -Force | Out-Null
    $pointer = Join-Path $ProfileHome 'bridge-port.txt'
    $pending = "$pointer.pending-$PID"
    if (Test-Path -LiteralPath $pending) { throw "Inspect the existing bridge pointer transaction: $pending" }
    [IO.File]::WriteAllText($pending, "$Port`n", [Text.Encoding]::ASCII)
    if (Test-Path -LiteralPath $pointer) {
        if ((Get-Item -LiteralPath $pointer -Force).LinkType) { throw "Bridge pointer is a link: $pointer" }
        [IO.File]::Replace($pending, $pointer, "$pointer.previous-$PID")
    } else {
        [IO.File]::Move($pending, $pointer)
    }
    if ((Get-Content -LiteralPath $pointer -Raw).Trim() -ne "$Port") {
        throw 'Bridge pointer update did not persist.'
    }
}

function Get-CodexCopilotArchitecture {
    switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
        'Arm64' { return 'arm64' }
        'X64' { return 'x64' }
        default {
            throw "Unsupported Windows architecture: $([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture). CodexCopilot supports ARM64 and x64."
        }
    }
}

function New-Shortcut {
    param(
        [string]$Path, [string]$Target, [string]$Arguments,
        [string]$WorkingDirectory, [string]$IconLocation, [string]$Description
    )
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $Target
    if ($Arguments) { $shortcut.Arguments = $Arguments }
    if ($WorkingDirectory) { $shortcut.WorkingDirectory = $WorkingDirectory }
    if ($IconLocation) { $shortcut.IconLocation = $IconLocation }
    if ($Description) { $shortcut.Description = $Description }
    $shortcut.Save()
}

function Get-UserPath {
    [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false).GetValue(
        'Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}

function Set-UserPath($value) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    $key.SetValue('Path', $value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    $key.Close()
    # Let already-running shells pick the change up.
    $sig = @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    if (-not ('CodexCopilotNative' -as [type])) {
        Add-Type -MemberDefinition $sig -Name CodexCopilotNative -Namespace Win32 | Out-Null
    }
    $out = [UIntPtr]::Zero
    [Win32.CodexCopilotNative]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$out) | Out-Null
}

function Stop-ExecutableTree([string[]]$ExecutablePaths) {
    $normalized = @($ExecutablePaths | ForEach-Object {
        if ($_ -and (Test-Path -LiteralPath $_)) { [System.IO.Path]::GetFullPath($_).ToLowerInvariant() }
    })
    if ($normalized.Count -eq 0) { return }

    $processes = @(Get-CimInstance Win32_Process)
    $targets = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($process in $processes) {
        if (-not $process.ExecutablePath) { continue }
        $path = [System.IO.Path]::GetFullPath([string]$process.ExecutablePath).ToLowerInvariant()
        if ($normalized -contains $path) { [void]$targets.Add([int]$process.ProcessId) }
    }
    do {
        $added = $false
        foreach ($process in $processes) {
            if ($targets.Contains([int]$process.ParentProcessId) -and
                -not $targets.Contains([int]$process.ProcessId)) {
                [void]$targets.Add([int]$process.ProcessId)
                $added = $true
            }
        }
    } while ($added)

    foreach ($pidValue in @($targets | Sort-Object -Descending)) {
        Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    }
}

function Restore-StaleCorePatch {
    $metadataPath = Join-Path $InstallRoot 'codex-core-patch.json'
    if (-not (Test-Path -LiteralPath $metadataPath)) { return }

    try {
        $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
        $oldTarget = [string]$metadata.target
        $oldBackup = [string]$metadata.backup
        if (-not $oldTarget -or -not $oldBackup -or
            -not (Test-Path -LiteralPath $oldTarget -PathType Leaf) -or
            -not (Test-Path -LiteralPath $oldBackup -PathType Leaf)) {
            Write-Warning 'A legacy stock-core patch record exists, but its original paths are incomplete. No running process was changed.'
            return
        }
        $running = @(Get-CimInstance Win32_Process | Where-Object {
            $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).Equals(
                [IO.Path]::GetFullPath($oldTarget), [StringComparison]::OrdinalIgnoreCase)
        })
        if ($running.Count) {
            Write-Warning "Official Codex is running from $oldTarget; restoring its old backup is deferred until it exits."
            return
        }
        $currentHash = (Get-FileHash -LiteralPath $oldTarget).Hash
        $backupHash = (Get-FileHash -LiteralPath $oldBackup).Hash
        if ($currentHash -eq [string]$metadata.patchedHash) {
            $pending = "$oldTarget.restore-$PID.pending"
            if (Test-Path -LiteralPath $pending) { throw "An earlier restore is pending: $pending" }
            Copy-Item -LiteralPath $oldBackup -Destination $pending
            if ((Get-FileHash -LiteralPath $pending).Hash -ne $backupHash) { throw 'The backup changed while staging restore.' }
            [IO.File]::Replace($pending, $oldTarget, [NullString]::Value)
            if ((Get-FileHash -LiteralPath $oldTarget).Hash -ne $backupHash) { throw 'Official core restore checksum failed.' }
            Write-Ok "restored previous official Codex core without ending sessions: $oldTarget"
        } elseif ($currentHash -ne $backupHash) {
            Write-Warning "Official Codex changed since the legacy patch record; preserving both files for manual review: $oldTarget"
            return
        }
        # Retain the original backup as a recoverable copy.
        Remove-Item -LiteralPath $metadataPath -Force
    } catch {
        throw "Could not restore the previous Codex core before upgrade: $($_.Exception.Message)"
    }
}

function Repair-LegacyCcCodexWrapper {
    $legacyWrapper = Join-Path $env:USERPROFILE 'bin\ccodex.cmd'
    if (-not (Test-Path -LiteralPath $legacyWrapper)) { return }

    $text = Get-Content -LiteralPath $legacyWrapper -Raw
    if ($text -notmatch 'ccodex-smart-paste') { return }
    $shim = @'
@echo off
call "%LOCALAPPDATA%\CodexCopilot\bin\ccodex.cmd" %*
exit /b %errorlevel%
'@
    Set-Content -LiteralPath $legacyWrapper -Value $shim -Encoding ASCII
    Write-Ok "replaced legacy nested-ConPTY wrapper with the installed ccodex launcher: $legacyWrapper"
}

function Get-CodexDesktopPackage {
    Get-AppxPackage OpenAI.Codex | Select-Object -First 1
}

function Install-CodexDesktopPackage {
    if ($NoPrerequisiteInstall) {
        throw "The official Codex desktop app is required. Install it from $CodexStoreUrl, then re-run."
    }

    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw "The official Codex desktop app is required and winget is unavailable. Install it from $CodexStoreUrl, then re-run."
    }

    Write-Step 'Installing the official Codex desktop prerequisite'
    & $winget.Source install --id $CodexStoreProductId --exact --source msstore `
        --accept-source-agreements --accept-package-agreements --disable-interactivity |
        ForEach-Object { Write-Ok $_ }
    if ($LASTEXITCODE -ne 0) {
        throw "Microsoft Store installation failed. Install Codex manually from $CodexStoreUrl, then re-run."
    }

    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $installedPackage = Get-CodexDesktopPackage
        if ($installedPackage) { return $installedPackage }
        Start-Sleep -Seconds 2
    }
    throw "The Store command completed, but the Codex package was not registered. Open $CodexStoreUrl, finish installation, then re-run."
}

function Get-CodexDesktopResource {
    param([string]$Candidate)

    if ($Candidate) {
        $provided = Resolve-CodexDesktopResource $Candidate
        if ($provided) {
            return [PSCustomObject]@{
                Root = $provided.Root
                Executable = $provided.Executable
                Resources = $provided.Resources
                Assets = $provided.Assets
                Package = $null
                Source = 'user path'
            }
        }
    }
    $installedPackage = Get-CodexDesktopPackage
    if (-not $installedPackage) { return $null }
    $installed = Resolve-CodexDesktopResource $installedPackage.InstallLocation
    if (-not $installed) { return $null }
    return [PSCustomObject]@{
        Root = $installed.Root
        Executable = $installed.Executable
        Resources = $installed.Resources
        Assets = $installed.Assets
        Package = $installedPackage
        Source = $installedPackage.PackageFullName
    }
}

function Get-CodexCliResource {
    param([string]$Candidate, [string]$DesktopResources)

    function New-CodexCliResource([string]$Path, [string]$Source) {
        if (-not $Path) { return $null }
        $codeModeHost = Join-Path (Split-Path -Parent $Path) 'codex-code-mode-host.exe'
        if (-not (Test-Path -LiteralPath $codeModeHost -PathType Leaf)) { return $null }
        return [PSCustomObject]@{
            Path = $Path
            Source = $Source
        }
    }

    if ($Candidate) {
        $provided = Resolve-CodexCliResource $Candidate
        if ($provided) {
            $resource = New-CodexCliResource $provided 'user path'
            if ($resource) { return $resource }
        }
    }
    if ($UseBundledCodexRuntime -and $DesktopResources) {
        $bundled = New-CodexCliResource (Join-Path $DesktopResources 'codex.exe') 'Desktop bundled runtime'
        if ($bundled) { return $bundled }
    }
    if (-not $UseBundledCodexRuntime) {
        $materialized = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin') -Directory -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            ForEach-Object { Join-Path $_.FullName 'codex.exe' } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
            Select-Object -First 1
        if ($materialized) {
            $resource = New-CodexCliResource $materialized 'official runtime'
            if ($resource) { return $resource }
        }
    }
    $pathCodex = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pathCodex) {
        $resource = New-CodexCliResource $pathCodex.Source 'PATH'
        if ($resource) { return $resource }
    }
    $npm = Get-Command npm.cmd, npm -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($npm) {
        try {
            $npmRoot = ((& $npm.Source root -g 2>$null) -join '').Trim()
            $npmCodex = Get-ChildItem -LiteralPath $npmRoot -Recurse -Depth 8 -File -Filter 'codex.exe' -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -match '[\\/]@openai[\\/]' } |
                Select-Object -ExpandProperty FullName -First 1
            if ($npmCodex) {
                $resource = New-CodexCliResource $npmCodex 'npm @openai/codex'
                if ($resource) { return $resource }
            }
        } catch { }
    }
    if ($DesktopResources) {
        $bundled = Join-Path $DesktopResources 'codex.exe'
        $resource = New-CodexCliResource $bundled 'Desktop bundled runtime'
        if ($resource) { return $resource }
    }
    return $null
}

function Install-StandaloneCodexCli {
    $npm = Get-Command npm.cmd, npm -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $npm) { throw "npm is unavailable. Use the official instructions at $CodexCliInstallUrl" }
    Write-Step 'Installing the official Codex CLI'
    & $npm.Source install --global '@openai/codex@latest' |
        ForEach-Object { Write-Ok $_ }
    if ($LASTEXITCODE -ne 0) { throw "npm failed with exit code $LASTEXITCODE" }
}

function Install-GitHubCopilotCli {
    $npm = Get-Command npm.cmd, npm -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $npm) { throw "npm is unavailable. Use the official instructions at $CopilotCliInstallUrl" }
    Write-Step 'Installing GitHub Copilot CLI for exact Context metadata'
    & $npm.Source install --global '@github/copilot@latest' |
        ForEach-Object { Write-Ok $_ }
    if ($LASTEXITCODE -ne 0) { throw "npm failed with exit code $LASTEXITCODE" }
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
if ($Uninstall) {
    Write-Step 'Removing shortcuts'
    if (-not $NoShortcuts) {
        foreach ($name in @($DesktopName, $CliName, $HistoryName)) {
            $lnk = Join-Path $StartMenu "$name.lnk"
            if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Ok "removed $name" }
        }
    }

    Write-Step 'Removing PATH entry'
    $binDir = Join-Path $InstallRoot 'bin'
    if (-not $NoPath) {
        $current = Get-UserPath
        if ($current -and ($current -split ';' | Where-Object { $_ -eq $binDir })) {
            Set-UserPath (($current -split ';' | Where-Object { $_ -and $_ -ne $binDir }) -join ';')
            Write-Ok "removed $binDir"
        }
    }

    if (-not $SkipSkill -and (Test-Path -LiteralPath $SkillTarget)) {
        Remove-Item -LiteralPath $SkillTarget -Recurse -Force
        Write-Ok "removed skill $SkillName"
    }

    Write-Step 'Stopping the bridge'
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:$BridgePort/health" -TimeoutSec 3
        Stop-Process -Id $health.pid -Force -ErrorAction SilentlyContinue
        Write-Ok "stopped pid $($health.pid)"
    } catch { Write-Ok 'bridge was not running' }

    $patchMetadataPath = Join-Path $InstallRoot 'codex-core-patch.json'
    if (Test-Path -LiteralPath $patchMetadataPath) {
        try {
            $patchMetadata = Get-Content -LiteralPath $patchMetadataPath -Raw | ConvertFrom-Json
            $targetCli = [string]$patchMetadata.target
            $backupCli = [string]$patchMetadata.backup
            if ($targetCli -and $backupCli -and (Test-Path -LiteralPath $backupCli)) {
                Stop-ExecutableTree @($targetCli)
                Copy-Item -LiteralPath $backupCli -Destination $targetCli -Force
                Remove-Item -LiteralPath $backupCli -Force
                Write-Ok "restored stock Codex core: $targetCli"
            }
        } catch {
            Write-Warning "Could not restore the stock Codex core: $($_.Exception.Message)"
        }
    }

    if (Test-Path $InstallRoot) { Remove-Item $InstallRoot -Recurse -Force; Write-Ok "removed $InstallRoot" }
    if ($Purge -and (Test-Path $CodexCopilotHome)) {
        Remove-Item $CodexCopilotHome -Recurse -Force
        Write-Ok "removed $CodexCopilotHome"
    }
    Write-Host "`nCodex (Copilot) removed. Stock Codex is untouched." -ForegroundColor Green
    return
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
$sourceVersionPath = Join-Path $SourceRoot 'VERSION'
$installedVersionPath = Join-Path $InstallRoot 'VERSION'
$sourceVersion = if (Test-Path -LiteralPath $sourceVersionPath) {
    (Get-Content -LiteralPath $sourceVersionPath -Raw).Trim()
} else {
    'unknown'
}
$installedVersion = if (Test-Path -LiteralPath $installedVersionPath) {
    (Get-Content -LiteralPath $installedVersionPath -Raw).Trim()
} else {
    $null
}
Write-InstallerBanner -Version $sourceVersion
if ($installedVersion) {
    Write-Step "Preparing in-place upgrade $installedVersion -> $sourceVersion"
    Write-Ok 'uninstall is not required; profile, account and model preferences are preserved'
} else {
    Write-Step "Preparing fresh install $sourceVersion"
}

Write-InstallerStage -Index 1 -Detail '核对 Windows 架构和 release 包目标。'
Write-Step 'Checking platform compatibility'
$runtimeArchitecture = Get-CodexCopilotArchitecture
Write-Ok "runtime architecture: $runtimeArchitecture"
if ($PackageTarget) {
    if ($PackageTarget.os -ne 'windows' -or $PackageTarget.arch -ne $runtimeArchitecture) {
        throw "This package targets $($PackageTarget.os)-$($PackageTarget.arch), but this machine is windows-$runtimeArchitecture. Download the matching CodexCopilot package."
    }
    Write-Ok "package target: $($PackageTarget.target)"
}
$sourceCore = Join-Path $SourceRoot "bin\runtimes\$runtimeArchitecture\codex-copilot-core.exe"
$sourceManifest = Join-Path $SourceRoot "bin\runtimes\$runtimeArchitecture\codex-copilot-core.manifest.json"
$chainFile = Join-Path $SourceRoot 'NATIVE_PATCH_CHAIN.json'
if (-not (Test-Path -LiteralPath $sourceCore -PathType Leaf) -or
    -not (Test-Path -LiteralPath $sourceManifest -PathType Leaf) -or
    -not (Test-Path -LiteralPath $chainFile -PathType Leaf)) {
    throw "Release core, build manifest or patch chain is missing for windows-$runtimeArchitecture."
}
$manifest = Get-Content -LiteralPath $sourceManifest -Raw | ConvertFrom-Json
$patchChain = Get-Content -LiteralPath $chainFile -Raw | ConvertFrom-Json
$sourceRevision = (Get-Content -LiteralPath (Join-Path $SourceRoot 'CODEX-SOURCE-REVISION') -Raw).Trim()
$sourceHash = (Get-FileHash -LiteralPath $sourceCore -Algorithm SHA256).Hash
if ($manifest.packageVersion -ne $sourceVersion -or
    $manifest.target -ne "windows-$runtimeArchitecture" -or
    $manifest.sourceRevision -ne $sourceRevision -or
    $manifest.patchedTree -ne $patchChain.patchedTree -or
    $manifest.sha256 -ne $sourceHash -or
    $patchChain.sourceRevision -ne $sourceRevision -or
    ($manifest.patches.name -join '|') -ne ($patchChain.patches -join '|')) {
    throw 'The bundled native core does not match its release manifest and patch chain.'
}
foreach ($patch in $manifest.patches) {
    if ($patch.sha256 -ne (Get-FileHash -LiteralPath (Join-Path $SourceRoot "patches\$($patch.name)") -Algorithm SHA256).Hash) {
        throw "Release patch changed after core build: $($patch.name)"
    }
}
if ($PackageTarget -and ($PackageTarget.packageVersion -ne $sourceVersion -or
    $PackageTarget.sourceRevision -ne $sourceRevision -or
    $PackageTarget.coreSha256 -ne $sourceHash)) {
    throw 'Package target metadata differs from the bundled core.'
}
Write-Ok "native core and $($patchChain.patches.Count)-patch chain verified: $sourceHash"

Write-InstallerStage -Index 2 -Detail '先核对 GitHub Copilot，再定位 ChatGPT Desktop 与官方 Codex CLI。'
$copilotSdk = Find-InstalledCopilotSdk -ProfileHome $CodexCopilotHome -Candidate $CopilotCliPath
$desktopResource = Get-CodexDesktopResource $ChatGptDesktopPath
$desktopResources = if ($desktopResource) { [string]$desktopResource.Resources } else { $null }
$codexResource = Get-CodexCliResource -Candidate $CodexCliPath -DesktopResources $desktopResources
Write-InstallerResourceScan -Resources @(
    [PSCustomObject]@{
        Name = 'GitHub Copilot CLI'
        State = if ($copilotSdk) { 'FOUND' } else { 'MISSING' }
        Detail = if ($copilotSdk) { $copilotSdk } else { 'optional SDK metadata; a verified GitHub Copilot login can supply the model service' }
    },
    [PSCustomObject]@{
        Name = 'ChatGPT Desktop'
        State = if ($desktopResource) { 'FOUND' } else { 'MISSING' }
        Detail = if ($desktopResource) { "$($desktopResource.Source): $($desktopResource.Executable)" } else { 'required for Windows Desktop integration and official runtime resources' }
    },
    [PSCustomObject]@{
        Name = 'Codex CLI'
        State = if ($codexResource -and $codexResource.Source -like '*bundled*') { 'BUNDLED' } elseif ($codexResource) { 'FOUND' } else { 'MISSING' }
        Detail = if ($codexResource) { "$($codexResource.Source): $($codexResource.Path)" } else { 'required companion/runtime source was not found' }
    }
)
if ($PreflightOnly) {
    Write-Ok 'preflight completed; no prerequisite was installed and no files or settings were changed'
    Write-InstallerEnhancementShowcase -Version $sourceVersion -Preview
    return
}

$interactiveInstall = Test-InstallerInteractive -Disabled:$NoPrerequisiteInstall
$copilotAutoInstall = if ($NoPrerequisiteInstall) { $null } else {{ Install-GitHubCopilotCli }}
$copilotSdk = Resolve-MissingInstallerResource `
    -Name 'GitHub Copilot CLI' `
    -PathPrompt '请输入 copilot 可执行文件、程序目录或 copilot-sdk\index.js' `
    -AutomaticDescription 'npm @github/copilot' `
    -ManualInstruction "$CopilotCliInstallUrl" `
    -Locate { Find-InstalledCopilotSdk -ProfileHome $CodexCopilotHome -Candidate $CopilotCliPath } `
    -ResolvePath { param($path) Resolve-CopilotSdkResource $path } `
    -AutomaticInstall $copilotAutoInstall `
    -Interactive $interactiveInstall `
    -AllowSkip $true
if ($copilotSdk) {
    $env:CODEX_COPILOT_CLI_SDK = $copilotSdk
} else {
    Write-Warning 'GitHub Copilot CLI was skipped. A valid GitHub Copilot login remains required; exact Context metadata may be unavailable.'
}

$desktopAutoInstall = if ($NoPrerequisiteInstall) { $null } else {{
    Install-CodexDesktopPackage | Out-Null
}}
$desktopResource = Resolve-MissingInstallerResource `
    -Name 'ChatGPT/Codex Desktop' `
    -PathPrompt '请输入 ChatGPT.exe、Codex.exe 或程序目录' `
    -AutomaticDescription 'Microsoft Store / winget' `
    -ManualInstruction "$CodexStoreUrl" `
    -Locate { Get-CodexDesktopResource $ChatGptDesktopPath } `
    -ResolvePath { param($path) Get-CodexDesktopResource $path } `
    -AutomaticInstall $desktopAutoInstall `
    -Interactive $interactiveInstall

$package = $desktopResource.Package
$desktopExecutable = [string]$desktopResource.Executable
$bundledResources = [string]$desktopResource.Resources
if (-not (Test-Path -LiteralPath $desktopExecutable -PathType Leaf)) {
    throw "The selected Desktop resource is incomplete: $desktopExecutable"
}

$codexAutoInstall = if ($NoPrerequisiteInstall) { $null } else {{ Install-StandaloneCodexCli }}
$codexResource = Resolve-MissingInstallerResource `
    -Name 'Codex CLI' `
    -PathPrompt '请输入 codex.exe 或包含它的程序目录' `
    -AutomaticDescription 'npm @openai/codex' `
    -ManualInstruction "$CodexCliInstallUrl" `
    -Locate { Get-CodexCliResource -Candidate $CodexCliPath -DesktopResources $bundledResources } `
    -ResolvePath {
        param($path)
        $provided = Resolve-CodexCliResource $path
        if ($provided -and (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $provided) 'codex-code-mode-host.exe') -PathType Leaf)) {
            [PSCustomObject]@{ Path = $provided; Source = 'user path' }
        }
    } `
    -AutomaticInstall $codexAutoInstall `
    -Interactive $interactiveInstall

function Get-NodeMajor([string]$Candidate) {
    try {
        $value = & $Candidate -e "process.stdout.write(process.versions.node.split('.')[0])" 2>$null
        return [int](($value -join '').Trim())
    } catch {
        return 0
    }
}

$nodeCandidates = @()
$pathNode = Get-Command node -ErrorAction SilentlyContinue
if ($pathNode) { $nodeCandidates += $pathNode.Source }
$bundledNode = if ($bundledResources) { Join-Path $bundledResources 'cua_node\bin\node.exe' } else { $null }
if ($bundledNode -and (Test-Path -LiteralPath $bundledNode)) { $nodeCandidates += $bundledNode }
$runtime = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\cua_node'
if (Test-Path $runtime) {
    $nodeCandidates += Get-ChildItem $runtime -Directory |
        Sort-Object LastWriteTime -Descending |
        ForEach-Object { Join-Path $_.FullName 'bin\node.exe' } |
        Where-Object { Test-Path $_ }
}
$node = $nodeCandidates | Where-Object { $_ -and (Get-NodeMajor $_) -ge 22 } | Select-Object -First 1
if (-not $node) {
    throw 'Node.js 22+ was not found in PATH or the official Codex desktop runtime.'
}
$nodeVersion = & $node -e "process.stdout.write(process.versions.node)"
Write-Ok "node: $node (v$nodeVersion)"

$codexCliSource = [string]$codexResource.Path
Write-InstallerResourceScan -Title '资源检索完成' -Resources @(
    [PSCustomObject]@{
        Name = 'GitHub Copilot CLI'
        State = if ($copilotSdk) { 'FOUND' } else { 'OPTIONAL' }
        Detail = if ($copilotSdk) { $copilotSdk } else { 'skipped; verified GitHub login is required for model access' }
    },
    [PSCustomObject]@{ Name = 'ChatGPT Desktop'; State = 'FOUND'; Detail = $desktopExecutable },
    [PSCustomObject]@{
        Name = 'Codex CLI'
        State = if ($codexResource.Source -like '*bundled*') { 'BUNDLED' } else { 'FOUND' }
        Detail = "$($codexResource.Source): $codexCliSource"
    }
)
Restore-StaleCorePatch

# ---------------------------------------------------------------------------
# Copy payload
# ---------------------------------------------------------------------------
Write-InstallerStage -Index 3 -Detail "目标目录：$InstallRoot；不结束已有 Codex、Desktop 或 bridge 会话。"
Write-Step "Installing to $InstallRoot"
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$forbiddenRoots = @(
    [IO.Path]::GetPathRoot($InstallRoot).TrimEnd('\'),
    [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\'),
    [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')
)
if ($InstallRoot -in $forbiddenRoots -or (Test-Path -LiteralPath $InstallRoot -PathType Leaf) -or
    ((Test-Path -LiteralPath $InstallRoot) -and (Get-Item -LiteralPath $InstallRoot -Force).LinkType)) {
    throw "Refusing an unsafe installation root: $InstallRoot"
}
Write-Ok 'running Codex, Desktop and bridge sessions are preserved; launchers select the new core on their next start'
$copySourceRoot = $SourceRoot
$stagedSource = $null
if ([System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\') -eq [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')) {
    $stagedSource = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-copilot-install-" + [guid]::NewGuid().ToString('N'))
    $copySourceRoot = Join-Path $stagedSource 'source'
    New-Item -ItemType Directory -Path $stagedSource -Force | Out-Null
    Copy-Item -LiteralPath $SourceRoot -Destination $copySourceRoot -Recurse -Force
}
function Copy-DirectoryOverlay([string]$Source, [string]$Target) {
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    $sourcePrefix = [IO.Path]::GetFullPath($Source).TrimEnd('\') + '\'
    foreach ($entry in Get-ChildItem -LiteralPath $Source -Recurse -Force) {
        if (-not $entry.PSIsContainer -and $entry.Name -like '*.backup.exe') { continue }
        $entryPath = [IO.Path]::GetFullPath($entry.FullName)
        if (-not $entryPath.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Copy source escaped its root: $entryPath"
        }
        $relative = $entryPath.Substring($sourcePrefix.Length)
        $destination = Join-Path $Target $relative
        if ($entry.PSIsContainer) {
            New-Item -ItemType Directory -Path $destination -Force | Out-Null
            continue
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        if (Test-Path -LiteralPath $destination) {
            try {
                if ($entry.Length -eq (Get-Item -LiteralPath $destination).Length -and
                    (Get-FileHash -LiteralPath $entry.FullName).Hash -eq
                    (Get-FileHash -LiteralPath $destination).Hash) {
                    continue
                }
            } catch {}
        }
        try {
            Copy-Item -LiteralPath $entry.FullName -Destination $destination -Force -ErrorAction Stop
        } catch {
            throw "Could not update $destination without interrupting a running session: $($_.Exception.Message)"
        }
        if ((Get-FileHash -LiteralPath $entry.FullName).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) {
            throw "Installed payload checksum mismatch: $destination"
        }
    }
}
foreach ($dir in @('bridge', 'bin', 'assets', 'tools', 'src', 'skills', 'tests', 'patches')) {
    $target = Join-Path $InstallRoot $dir
    $source = Join-Path $copySourceRoot $dir
    if (Test-Path -LiteralPath $source) { Copy-DirectoryOverlay $source $target }
}
foreach ($file in @('install.cmd', 'install.ps1', 'README.md', 'WORKIQ.md', 'NATIVE_COMPATIBILITY.md', 'RELEASE_NOTES.md', 'MIGRATION.md', 'MIGRATION.zh-CN.md', 'VERSION', 'CODEX-SOURCE-REVISION', 'NATIVE_PATCH_CHAIN.json', 'platform-target.json')) {
    $source = Join-Path $copySourceRoot $file
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $InstallRoot -Force }
}
if (-not $PackageTarget) {
    $nativeMetadataFile = Join-Path $InstallRoot "bin\runtimes\$runtimeArchitecture\codex-copilot-core.manifest.json"
    $nativeMetadata = Get-Content -LiteralPath $nativeMetadataFile -Raw | ConvertFrom-Json
    [ordered]@{
        schemaVersion = 1; target = "windows-$runtimeArchitecture"; os = 'windows'
        arch = $runtimeArchitecture; packageVersion = $sourceVersion
        sourceRevision = $nativeMetadata.sourceRevision; coreSha256 = $nativeMetadata.sha256
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallRoot 'platform-target.json') -Encoding utf8
}
if ($stagedSource -and (Test-Path -LiteralPath $stagedSource)) {
    Remove-Item -LiteralPath $stagedSource -Recurse -Force
}
Write-Ok 'payload copied'
Set-Content -LiteralPath (Join-Path $InstallRoot 'desktop-executable.txt') `
    -Value $desktopExecutable -Encoding UTF8
Set-Content -LiteralPath (Join-Path $InstallRoot 'codex-cli-path.txt') `
    -Value $codexCliSource -Encoding ASCII
Write-Ok "official Codex CLI remains outside CodexCopilot: $codexCliSource"
if (-not $NoPath -and
    $InstallRoot.Equals((Join-Path $env:LOCALAPPDATA 'CodexCopilot'), [StringComparison]::OrdinalIgnoreCase)) {
    $isolationRepair = @{
        Apply = $true
        RestoreStockCommand = $true
        InstallRoot = $InstallRoot
        CopilotHome = $CodexCopilotHome
        StockHome = $SourceCodexHome
        StockCliPath = $codexCliSource
        ReportDirectory = Join-Path $InstallRoot 'backups\native-isolation'
    }
    if ($package -and $package.PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0') {
        $isolationRepair.StopLegacyDesktopHelper = $true
    }
    & (Join-Path $InstallRoot 'tools\Restore-NativeIsolation.ps1') @isolationRepair
}

# Select the native core matching the package target. Published ZIPs carry only
# the ARM64 or x64 payload selected for that archive.
$runtimeCore = Join-Path $InstallRoot "bin\runtimes\$runtimeArchitecture\codex-copilot-core.exe"
if (-not (Test-Path -LiteralPath $runtimeCore)) {
    throw "The package has no Context-enabled Codex core for $runtimeArchitecture`: $runtimeCore"
}
$coreDirectory = Join-Path $InstallRoot "bin\cores\$sourceVersion\$runtimeArchitecture"
$patchedCli = Join-Path $coreDirectory 'codex-copilot-core.exe'
New-Item -ItemType Directory -Path $coreDirectory -Force | Out-Null
Copy-Item -LiteralPath $runtimeCore -Destination $patchedCli -Force
Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $runtimeCore) 'codex-copilot-core.manifest.json') `
    -Destination $coreDirectory -Force
& $node (Join-Path $InstallRoot 'bridge\cli-components.mjs') copy $runtimeCore $patchedCli `
    (Join-Path (Split-Path -Parent $runtimeCore) 'codex-copilot-core.manifest.json')
if ($LASTEXITCODE -ne 0) { throw 'The enhanced core requires its own verified native companion set.' }
Set-Content -LiteralPath (Join-Path $InstallRoot 'bin\core-current.txt') -Value $patchedCli -Encoding ascii

# ---------------------------------------------------------------------------
# Codex companion executables
# ---------------------------------------------------------------------------
Write-Step 'Installing Codex companion executables'
$officialCodexBin = Split-Path -Parent $codexCliSource
$enhancedManifest = Get-Content -LiteralPath (Join-Path $coreDirectory 'codex-copilot-core.manifest.json') -Raw | ConvertFrom-Json
$requiredCompanion = 'codex-code-mode-host.exe'
$companionExecutables = @(
    $requiredCompanion,
    'codex-command-runner.exe',
    'codex-windows-sandbox-setup.exe'
)
foreach ($companion in $companionExecutables) {
    if ($enhancedManifest.components) {
        $relative = if ($companion -eq $requiredCompanion) {
            $companion
        } else {
            "codex-resources/$companion"
        }
        $source = Join-Path $coreDirectory $relative
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "The source-bound enhanced runtime is missing $companion."
        }
        $destination = Join-Path $InstallRoot "bin\$relative"
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Force
        Write-Ok $companion
        continue
    }
    $source = Join-Path $officialCodexBin $companion
    if (-not (Test-Path -LiteralPath $source)) {
        if ($companion -eq $requiredCompanion) {
            throw "The Codex Code Mode host is missing from the official installation: $source"
        }
        Write-Warning "Optional Codex companion executable is unavailable: $source"
        continue
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $InstallRoot "bin\$companion") -Force
    Write-Ok $companion
}

# ---------------------------------------------------------------------------
# Shared Codex core patch
# ---------------------------------------------------------------------------
Write-Step 'Installing the Context-enabled Codex core'
if (-not (Test-Path -LiteralPath $patchedCli)) {
    throw "Patched Codex core is missing: $patchedCli"
}
Write-Ok "$patchedCli (isolated core; official Codex CLI and Desktop binaries remain untouched)"

# ---------------------------------------------------------------------------
# Icon + launcher
# ---------------------------------------------------------------------------
Write-Step 'Building the app icon from the Codex package assets'
$iconPath = Join-Path $InstallRoot 'assets\codex-copilot.ico'
if ($desktopResource.Assets) {
    & (Join-Path $InstallRoot 'tools\build-icon.ps1') `
        -OutputPath $iconPath -AssetsPath $desktopResource.Assets |
        ForEach-Object { Write-Ok $_ }
} elseif (Test-Path -LiteralPath $iconPath) {
    Write-Ok 'using the packaged multi-resolution icon (Desktop asset directory was not exposed)'
} else {
    throw 'No Desktop icon assets or packaged fallback icon are available.'
}

Write-Step 'Installing the independent desktop launcher'
$csc = @(
    'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
    'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
$launcherExe = Join-Path $InstallRoot 'bin\codex-copilot-desktop.exe'
if (Test-Path -LiteralPath $launcherExe) {
    Write-Ok 'using the release-verified prebuilt launcher unchanged'
} elseif ($csc) {
    & $csc /nologo /target:winexe /platform:anycpu /optimize+ `
        /out:$launcherExe /win32icon:$iconPath `
        /reference:System.dll /reference:System.Core.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
        (Join-Path $InstallRoot 'src\CodexCopilotDesktop.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Failed to compile the desktop launcher.' }
    Write-Ok "built $launcherExe"
} else {
    throw 'No C# compiler was found and no prebuilt launcher is available.'
}

# ---------------------------------------------------------------------------
Write-Step 'Preparing an independent, signed official Desktop snapshot'
$snapshotArguments = @{
    InstallRoot = $InstallRoot
    SourceApp = (Split-Path -Parent $desktopExecutable)
    NodePath = $node
}
if ($package) { $snapshotArguments.VendorVersion = [string]$package.Version }
& (Join-Path $InstallRoot 'tools\Install-DesktopSnapshot.ps1') @snapshotArguments
if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { throw 'Independent Desktop snapshot preparation failed.' }

# Codex profile
# ---------------------------------------------------------------------------
$expectedGeneration = Get-InstalledBridgeGeneration $node $InstallRoot
$previousBridgePort = $BridgePort
$previousBridge = $null
try {
    $previousBridge = Invoke-RestMethod "http://127.0.0.1:$BridgePort/health" -TimeoutSec 5
} catch { }
if ($previousBridge -and $previousBridge.bridge -ne 'codex-copilot') {
    throw "Port $BridgePort is occupied by another application."
}
if (-not $NoStart -and -not $bridgePortExplicit -and $previousBridge -and
    $previousBridge.runtime.sourceGeneration -ne $expectedGeneration -and
    $previousBridge.activeRequests -gt 0) {
    $BridgePort = Find-FreeBridgePort
    $env:CODEX_COPILOT_HOME = $CodexCopilotHome
    $env:CODEX_COPILOT_BRIDGE_PORT = "$BridgePort"
    Write-Step "Keeping busy bridge PID $($previousBridge.pid) on $previousBridgePort; starting this release on $BridgePort"
    & $node (Join-Path $InstallRoot 'bridge\ensure.mjs') --verbose | ForEach-Object { Write-Ok $_ }
    if ($LASTEXITCODE -ne 0) { throw 'The side-by-side bridge did not start; the old service remains untouched.' }
    $parallelHealth = Invoke-RestMethod "http://127.0.0.1:$BridgePort/health" -TimeoutSec 10
    if ($parallelHealth.bridge -ne 'codex-copilot' -or
        $parallelHealth.runtime.sourceGeneration -ne $expectedGeneration) {
        throw 'The side-by-side bridge does not match this release.'
    }
    Set-BridgePortPointer $CodexCopilotHome $BridgePort
    Write-Ok "new sessions use $BridgePort; existing long connections remain on $previousBridgePort"
}
Write-InstallerStage -Index 4 -Detail "独立配置目录：$CodexCopilotHome；保持原生 ~/.codex 不变。"
Write-Step "Creating the Codex profile in $CodexCopilotHome"
New-Item -ItemType Directory -Path $CodexCopilotHome -Force | Out-Null
if ($copilotSdk) {
    Set-Content -LiteralPath (Join-Path $CodexCopilotHome 'copilot-cli-sdk-path.txt') `
        -Value $copilotSdk -Encoding UTF8
}
$env:CODEX_COPILOT_HOME = $CodexCopilotHome
$env:CODEX_COPILOT_SOURCE_HOME = $SourceCodexHome
$env:CODEX_COPILOT_BRIDGE_PORT = "$BridgePort"
$env:CODEX_COPILOT_DEFAULT_MODEL = $DefaultModel
$env:CODEX_COPILOT_AUTH_MODE = $AuthMode
& $node (Join-Path $InstallRoot 'tools\gen-config.mjs') | ForEach-Object { Write-Ok $_ }

Write-InstallerStage -Index 5 -Detail '验证当前 GitHub 账户并读取可用的模型目录。'
Write-Step 'Resolving GitHub Copilot credentials and building the model catalog'
& $node (Join-Path $InstallRoot 'bridge\cli.mjs') catalog | ForEach-Object { Write-Ok $_ }
$catalogReady = $LASTEXITCODE -eq 0
if (-not $catalogReady -and -not $SkipLogin -and $AuthMode -in @('auto', 'saved')) {
    Write-Step 'Starting GitHub device login'
    & $node (Join-Path $InstallRoot 'bridge\cli.mjs') login --force
    $catalogReady = $LASTEXITCODE -eq 0
}
if (-not $catalogReady) {
    Write-Warning 'No usable Copilot credential was found. Run `codex-copilot login --force` before first use.'
}
if ($catalogReady -and ($DefaultEffort -or $env:CODEX_COPILOT_DEFAULT_CONTEXT_TIER)) {
    $configText = Get-Content -LiteralPath (Join-Path $CodexCopilotHome 'config.toml') -Raw
    $selectedMatch = [regex]::Match($configText, '(?m)^model\s*=\s*"([^"]+)"')
    if ($selectedMatch.Success) {
        $contextTier = if ($env:CODEX_COPILOT_DEFAULT_CONTEXT_TIER) {
            [string]$env:CODEX_COPILOT_DEFAULT_CONTEXT_TIER
        } else {
            'default'
        }
        $selectionArgs = @('use', $selectedMatch.Groups[1].Value)
        if ($DefaultEffort) {
            $selectionArgs += $DefaultEffort
            if ($contextTier) { $selectionArgs += $contextTier }
        } elseif ($contextTier) {
            $selectionArgs += $contextTier
        }
        & $node (Join-Path $InstallRoot 'bridge\cli.mjs') @selectionArgs | ForEach-Object { Write-Ok $_ }
        if ($LASTEXITCODE -ne 0) {
            Write-Warning 'The migrated model parameters are unavailable for the selected model.'
        }
    }
}

# ---------------------------------------------------------------------------
# PATH
# ---------------------------------------------------------------------------
Write-Step 'Registering the CLI on PATH'
$binDir = Join-Path $InstallRoot 'bin'
if (-not $NoPath) {
    $current = Get-UserPath
    if (-not $current) { $current = '' }
    if (-not ($current -split ';' | Where-Object { $_ -eq $binDir })) {
        Set-UserPath (($current.TrimEnd(';') + ';' + $binDir).TrimStart(';'))
        Write-Ok "added $binDir to PATH"
    } else {
        Write-Ok 'already on PATH'
    }
    $env:PATH = "$env:PATH;$binDir"
}
if ([IO.Path]::GetFullPath($InstallRoot).TrimEnd('\').Equals(
    [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CodexCopilot')).TrimEnd('\'),
    [StringComparison]::OrdinalIgnoreCase)) {
    Repair-LegacyCcCodexWrapper
}

if (-not $SkipSkill) {
    Write-Step "Installing Copilot CLI skill $SkillName"
    $skillSource = Join-Path $InstallRoot "skills\$SkillName"
    if (-not (Test-Path -LiteralPath $skillSource)) { throw "Bundled skill is missing: $skillSource" }
    if (Test-Path -LiteralPath $SkillTarget) { Remove-Item -LiteralPath $SkillTarget -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path -Parent $SkillTarget) -Force | Out-Null
    Copy-Item -LiteralPath $skillSource -Destination $SkillTarget -Recurse -Force
    Write-Ok $SkillTarget
}

# ---------------------------------------------------------------------------
# Start menu
# ---------------------------------------------------------------------------
Write-Step 'Creating Start menu entries'
if (-not $NoShortcuts) {
    New-Shortcut -Path (Join-Path $StartMenu "$DesktopName.lnk") `
        -Target $launcherExe -WorkingDirectory $InstallRoot -IconLocation "$iconPath,0" `
        -Description 'Codex desktop app powered by GitHub Copilot'
    Write-Ok "$DesktopName"
    New-Shortcut -Path (Join-Path $StartMenu "$HistoryName.lnk") `
        -Target "$env:SystemRoot\System32\cmd.exe" `
        -Arguments "/c `"$InstallRoot\tools\history\desktop.cmd`"" `
        -WorkingDirectory $InstallRoot -IconLocation "$iconPath,0" `
        -Description 'Local ccodex batch history manager with exact operation previews'
    Write-Ok "$HistoryName"

    New-Shortcut -Path (Join-Path $StartMenu "$CliName.lnk") `
        -Target "$env:SystemRoot\System32\cmd.exe" `
        -Arguments "/k `"$binDir\codex-copilot.cmd`"" `
        -WorkingDirectory $env:USERPROFILE -IconLocation "$iconPath,0" `
        -Description 'Codex CLI powered by GitHub Copilot'
    Write-Ok "$CliName"
}

# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------
Write-Step 'Checking the installed bridge generation'
$expectedGeneration = Get-InstalledBridgeGeneration $node $InstallRoot
$bridgeReady = $false
$bridgePending = $false
if (-not $NoStart -and $catalogReady) {
    $existing = $null
    try {
        $existing = Invoke-RestMethod "http://127.0.0.1:$BridgePort/health" -TimeoutSec 5
    } catch { }
    if ($existing -and $existing.bridge -ne 'codex-copilot') {
        throw "Port $BridgePort is occupied by another application; refusing bridge replacement."
    }
    if ($existing -and $existing.runtime.sourceGeneration -ne $expectedGeneration) {
        if ($existing.activeRequests -gt 0) {
            $bridgePending = $true
            Write-Warning "Bridge PID $($existing.pid) has $($existing.activeRequests) active requests; no running inference was stopped. Re-run codex-copilot bridge after it becomes idle."
        } else {
            & $node (Join-Path $InstallRoot 'bridge\control.mjs') stop | ForEach-Object { Write-Ok $_ }
            if ($LASTEXITCODE -ne 0) {
                $bridgePending = $true
                Write-Warning 'The existing bridge could not be safely retired; installed files are ready, but the service is pending.'
            }
        }
    }
    if (-not $bridgePending) {
        # A plain call keeps the detached service independent of the installer.
        & $node (Join-Path $InstallRoot 'bridge\ensure.mjs') --verbose | ForEach-Object { Write-Ok $_ }
        if ($LASTEXITCODE -ne 0) { throw 'The matching installed bridge did not start.' }
        $health = Invoke-RestMethod "http://127.0.0.1:$BridgePort/health" -TimeoutSec 10
        if ($health.bridge -ne 'codex-copilot' -or
            $health.runtime.sourceGeneration -ne $expectedGeneration) {
            throw 'The running bridge generation differs from the installed release.'
        }
        $bridgeReady = $true
        Write-Ok "bridge: $($health.status), pid $($health.pid), account $($health.auth.login), $($health.models) Copilot models"
        if ($bridgePortExplicit) { Set-BridgePortPointer $CodexCopilotHome $BridgePort }
    }
}

if (-not $catalogReady) {
    Write-Host ''
    Write-Host 'Codex (Copilot) files are installed, but GitHub Copilot model access is NOT verified.' -ForegroundColor Yellow
    Write-Host 'Run codex-copilot login --force, then codex-copilot doctor and retry the real request.' -ForegroundColor Yellow
    Write-InstallerEnhancementShowcase -Version $sourceVersion -Preview
    if (-not $SkipLogin) {
        throw 'Installation is not ready: no verified GitHub Copilot model catalog.'
    }
    return
}
if ($bridgePending -or $NoStart) {
    Write-Host ''
    Write-Host 'Codex (Copilot) files are installed, but the new bridge has not been activated.' -ForegroundColor Yellow
    Write-Host 'Wait for active requests to finish, then run codex-copilot bridge and doctor.' -ForegroundColor Yellow
    Write-InstallerEnhancementShowcase -Version $sourceVersion -Preview
    return
}
if (-not $bridgeReady) { throw 'Installation cannot claim success without a matching live bridge.' }

Write-InstallerStage -Index 6 -Detail '检查桥接健康、/model 生效值及目标浏览器或桌面交互。'
Write-Host ""
Write-Host "Codex (Copilot) is installed." -ForegroundColor Green
Write-Host ""
Write-Host "  Desktop : press Win and search for `"$DesktopName`""
Write-Host "  CLI     : open a new terminal and run  codex-copilot   (short alias: ccodex)"
Write-Host "  Models  : codex-copilot models"
Write-Host "  Account : codex-copilot status   /   codex-copilot login"
Write-Host ""
Write-Host "  Stock Codex still uses ~/.codex; its original core is preserved for uninstall." -ForegroundColor DarkGray
Write-Host ""
Write-InstallerEnhancementShowcase -Version $sourceVersion
