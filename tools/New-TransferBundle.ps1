<#
.SYNOPSIS
    Creates a credential-free CodexCopilot transfer bundle.

.DESCRIPTION
    Packages the installer and runtime source plus the currently selected model
    preference. It never copies the CodexCopilot profile, OAuth tokens, Windows
    credentials, sessions, logs, databases, MCP secrets, or machine-specific pipes.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [ValidateSet('windows-arm64', 'windows-x64')]
    [string]$Target,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$SourceRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
& node (Join-Path $SourceRoot 'tools\typescript-task.mjs') check
if ($LASTEXITCODE -ne 0) { throw 'Build the canonical TypeScript source before packaging.' }
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$currentArch = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
    'Arm64' { 'arm64' }
    'X64' { 'x64' }
    default { throw "Unsupported Windows architecture: $([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)" }
}
if (-not $Target) { $Target = "windows-$currentArch" }
$targetArch = $Target.Substring('windows-'.Length)

if ([System.IO.Path]::GetExtension($OutputPath) -ne '.zip') {
    throw 'OutputPath must end in .zip.'
}
if (Test-Path -LiteralPath $OutputPath) {
    if (-not $Force) { throw "Output already exists: $OutputPath. Use -Force to replace it." }
    Remove-Item -LiteralPath $OutputPath -Force
}

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-copilot-transfer-" + [guid]::NewGuid().ToString('N'))
$payload = Join-Path $stagingRoot 'codex-copilot-portable'

try {
    New-Item -ItemType Directory -Path $payload -Force | Out-Null
    foreach ($item in @('package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'WORKIQ.md', 'NATIVE_COMPATIBILITY.md', 'RELEASE_NOTES.md', 'MIGRATION.md', 'MIGRATION.zh-CN.md', 'VERSION', 'CODEX-SOURCE-REVISION', 'NATIVE_PATCH_CHAIN.json', 'install.cmd', 'install.ps1', 'assets', 'bridge','gateway', 'patches', 'skills', 'src', 'tests', 'tools')) {
        $source = Join-Path $SourceRoot $item
        if (-not (Test-Path -LiteralPath $source)) { throw "Package source is missing: $source" }
        Copy-Item -LiteralPath $source -Destination $payload -Recurse -Force
    }

    $sourceBin = Join-Path $SourceRoot 'bin'
    $payloadBin = Join-Path $payload 'bin'
    New-Item -ItemType Directory -Path $payloadBin -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $sourceBin -Force) {
        if ($item.Name -in @('runtimes', 'node-pty', 'codex-copilot-core.exe', 'codex.cmd') -or $item.Name -like '*.backup.exe') { continue }
        Copy-Item -LiteralPath $item.FullName -Destination $payloadBin -Recurse -Force
    }

    $sourceCore = Join-Path $sourceBin "runtimes\$targetArch\codex-copilot-core.exe"
    $sourceCoreManifest = Join-Path $sourceBin "runtimes\$targetArch\codex-copilot-core.manifest.json"
    $payloadCore = Join-Path $payloadBin "runtimes\$targetArch\codex-copilot-core.exe"
    if (-not (Test-Path -LiteralPath $sourceCore)) { throw "Target core is missing: $sourceCore" }
    if (-not (Test-Path -LiteralPath $sourceCoreManifest)) { throw "Target core build manifest is missing: $sourceCoreManifest" }
    $coreManifest = Get-Content -LiteralPath $sourceCoreManifest -Raw | ConvertFrom-Json
    $packageVersion = (Get-Content -LiteralPath (Join-Path $SourceRoot 'VERSION') -Raw).Trim()
    $sourceRevision = (Get-Content -LiteralPath (Join-Path $SourceRoot 'CODEX-SOURCE-REVISION') -Raw).Trim()
    $sourceCoreHash = (Get-FileHash -LiteralPath $sourceCore -Algorithm SHA256).Hash
    if ([string]$coreManifest.packageVersion -ne $packageVersion -or
        [string]$coreManifest.sourceRevision -ne $sourceRevision -or
        [string]$coreManifest.target -ne $Target -or
        [string]$coreManifest.sha256 -ne $sourceCoreHash) {
        throw "Target core build manifest is stale or mismatched for $Target. Rebuild the core before packaging."
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $payloadCore) -Force | Out-Null
    Copy-Item -LiteralPath $sourceCore -Destination $payloadCore -Force
    Copy-Item -LiteralPath $sourceCoreManifest -Destination (Split-Path -Parent $payloadCore) -Force
    & node (Join-Path $SourceRoot 'bridge\cli-components.mjs') copy `
        $sourceCore $payloadCore $sourceCoreManifest
    if ($LASTEXITCODE -ne 0) { throw 'Target native companion inventory is incomplete or mismatched.' }
    $compatibility = Join-Path (Split-Path -Parent $sourceCore) 'cli-update-compatibility.json'
    if (-not (Test-Path -LiteralPath $compatibility -PathType Leaf)) {
        throw 'Target core lacks an actual CLI update compatibility receipt.'
    }
    Copy-Item -LiteralPath $compatibility -Destination (Split-Path -Parent $payloadCore)
    & node --input-type=module -e `
        'import {pathToFileURL} from "node:url";const m=await import(pathToFileURL(process.argv[1]));const s=await import(pathToFileURL(process.argv[2]));const f=await import(pathToFileURL(process.argv[3]));const root=process.argv[4];m.verifyCliCandidate({root,candidateRoot:root,target:process.argv[5],generation:s.sourceFingerprint(root,f.desktopExtensionFiles(root))});' `
        (Join-Path $payload 'bridge\cli-update.mjs') (Join-Path $payload 'bridge\update-state.mjs') `
        (Join-Path $payload 'bridge\desktop-extension-files.mjs') $payload $Target
    if ($LASTEXITCODE -ne 0) { throw 'Transfer package CLI compatibility is stale or mismatched.' }

    $sourceNodePty = Join-Path $sourceBin 'node-pty'
    $payloadNodePty = Join-Path $payloadBin 'node-pty'
    New-Item -ItemType Directory -Path $payloadNodePty -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $sourceNodePty -Force) {
        if ($item.Name -eq 'prebuilds') { continue }
        Copy-Item -LiteralPath $item.FullName -Destination $payloadNodePty -Recurse -Force
    }
    $sourcePrebuild = Join-Path $sourceNodePty "prebuilds\win32-$targetArch"
    $payloadPrebuild = Join-Path $payloadNodePty "prebuilds\win32-$targetArch"
    if (-not (Test-Path -LiteralPath $sourcePrebuild)) {
        throw "Target node-pty prebuild is missing: $sourcePrebuild"
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $payloadPrebuild) -Force | Out-Null
    Copy-Item -LiteralPath $sourcePrebuild -Destination $payloadPrebuild -Recurse -Force

    [ordered]@{
        schemaVersion = 1
        target = $Target
        os = 'windows'
        arch = $targetArch
        packageVersion = $packageVersion
        sourceRevision = $sourceRevision
        coreSha256 = $sourceCoreHash
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $payload 'platform-target.json') -Encoding UTF8

    $profileHome = if ($env:CODEX_COPILOT_HOME) {
        $env:CODEX_COPILOT_HOME
    } else {
        Join-Path $env:USERPROFILE '.codex-copilot'
    }
    $configPath = Join-Path $profileHome 'config.toml'
    $model = $null
    $effort = $null
    $contextTier = $null
    $selectionPath = Join-Path $profileHome 'selection-generation.json'
    if (Test-Path -LiteralPath $selectionPath) {
        $selection = Get-Content -LiteralPath $selectionPath -Raw | ConvertFrom-Json
        $model = $selection.model
        $effort = $selection.effort
        $contextTier = $selection.contextTier
    } elseif (Test-Path -LiteralPath $configPath) {
        $config = Get-Content -LiteralPath $configPath -Raw
        $modelMatch = [regex]::Match($config, '(?m)^model\s*=\s*"([^"]+)"')
        $effortMatch = [regex]::Match($config, '(?m)^model_reasoning_effort\s*=\s*"([^"]+)"')
        if ($modelMatch.Success) { $model = $modelMatch.Groups[1].Value }
        if ($effortMatch.Success) { $effort = $effortMatch.Groups[1].Value }
        $contextTier = if ($config -match '(?m)^service_tier\s*=\s*"context-long"') { 'long_context' } else { 'default' }
    }

    $settings = [ordered]@{
        schemaVersion = 1
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        defaultModel = $model
        defaultReasoningEffort = $effort
        defaultContextTier = $contextTier
        containsCredentials = $false
        target = $Target
        migrationPolicy = 'Install fresh and authenticate separately on the destination machine.'
    }
    $settings | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $payload 'transfer-settings.json') -Encoding UTF8

    $secretPatterns = @(
        'gho_[A-Za-z0-9_]{20,}',
        'ghu_[A-Za-z0-9_]{20,}',
        'ghp_[A-Za-z0-9_]{20,}',
        'github_pat_[A-Za-z0-9_]{20,}'
    )
    $textExtensions = @('.cmd', '.cs', '.json', '.md', '.mjs', '.ps1', '.toml', '.txt')
    foreach ($file in Get-ChildItem -LiteralPath $payload -Recurse -File) {
        if ($textExtensions -notcontains $file.Extension.ToLowerInvariant()) { continue }
        $text = Get-Content -LiteralPath $file.FullName -Raw
        foreach ($pattern in $secretPatterns) {
            if ($text -match $pattern) { throw "Potential credential found in transfer bundle: $($file.FullName)" }
        }
    }

    $parent = Split-Path -Parent $OutputPath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Compress-Archive -Path (Join-Path $payload '*') -DestinationPath $OutputPath -CompressionLevel Optimal
    Write-Output "Created credential-free $Target transfer bundle: $OutputPath"
    Write-Output 'Destination: extract the zip, run install.ps1, then authenticate with codex-copilot login --force.'
} finally {
    if (Test-Path -LiteralPath $stagingRoot) {
        $resolvedStage = (Resolve-Path -LiteralPath $stagingRoot).ProviderPath
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if ((Get-Item -LiteralPath $stagingRoot -Force).LinkType -or
            $resolvedStage -cne [IO.Path]::GetFullPath($stagingRoot) -or
            -not $resolvedStage.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
            -not (Split-Path -Leaf $resolvedStage).StartsWith('codex-copilot-transfer-')) {
            throw 'Refusing to clean a transfer directory outside its temporary workspace.'
        }
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}
