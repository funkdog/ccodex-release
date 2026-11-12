[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$StagingRoot,
    [Parameter(Mandatory)][string]$Dist
)

$ErrorActionPreference = 'Stop'
if ((Get-Process -Id $PID).PriorityClass -notin @('BelowNormal', 'Idle') -or $env:CARGO_BUILD_JOBS -ne '6') {
    throw 'Verify release archives under run-heavy-build.ps1.'
}
$stage = [IO.Path]::GetFullPath($StagingRoot)
$distribution = [IO.Path]::GetFullPath($Dist)
$version = (Get-Content -LiteralPath (Join-Path $stage 'VERSION') -Raw).Trim()
$revision = (Get-Content -LiteralPath (Join-Path $stage 'CODEX-SOURCE-REVISION') -Raw).Trim()
$chain = Get-Content -LiteralPath (Join-Path $stage 'NATIVE_PATCH_CHAIN.json') -Raw | ConvertFrom-Json
$targets = @('windows-arm64', 'windows-x64', 'linux-arm64', 'linux-x64', 'macos-arm64', 'macos-x64')
$results = [Collections.Generic.List[object]]::new()
$extensionGeneration = (& node --input-type=module -e `
    'import {pathToFileURL} from "node:url";const s=await import(pathToFileURL(process.argv[1]));const f=await import(pathToFileURL(process.argv[2]));console.log(s.sourceFingerprint(process.argv[3],f.desktopExtensionFiles(process.argv[3])));' `
    (Join-Path $stage 'bridge\update-state.mjs') (Join-Path $stage 'bridge\desktop-extension-files.mjs') $stage | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $extensionGeneration -notmatch '^[a-f0-9]{64}$') {
    throw 'Release extension source generation cannot be verified.'
}

function Add-Sources([hashtable]$Expected, [string[]]$Items) {
    foreach ($relative in $Items) {
        $file = Join-Path $stage $relative
        if (-not (Test-Path -LiteralPath $file)) { throw "Missing release source: $relative" }
        if (Test-Path -LiteralPath $file -PathType Container) {
            foreach ($child in Get-ChildItem -LiteralPath $file -Recurse -File) {
                $name = [IO.Path]::GetRelativePath($stage, $child.FullName).Replace('\', '/')
                $Expected[$name] = (Get-FileHash -LiteralPath $child.FullName -Algorithm SHA256).Hash
            }
        } else {
            $Expected[$relative.Replace('\', '/')] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        }
    }
}

function Read-Digest([IO.Stream]$Stream, [bool]$Capture) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        if ($Capture) {
            $memory = [IO.MemoryStream]::new()
            try {
                $Stream.CopyTo($memory)
                if ($memory.Length -gt 1048576) { throw 'Oversized release metadata entry.' }
                $bytes = $memory.ToArray()
                return [pscustomobject]@{
                    Hash = [Convert]::ToHexString($hash.ComputeHash($bytes))
                    Text = [Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xfeff)
                }
            } finally { $memory.Dispose() }
        }
        return [pscustomobject]@{
            Hash = [Convert]::ToHexString($hash.ComputeHash($Stream))
            Text = $null
        }
    } finally { $hash.Dispose() }
}

foreach ($target in $targets) {
    $targetIsWindows = $target.StartsWith('windows-')
    $arch = $target.Split('-')[1]
    $name = "codex-copilot-$target-$version"
    $archive = Join-Path $distribution ($name + $(if ($targetIsWindows) { '.zip' } else { '.tar.gz' }))
    $expectedArchiveHash = ((Get-Content -LiteralPath "$archive.sha256" -Raw).Trim() -split '\s+')[0]
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedArchiveHash) {
        throw "Release archive checksum mismatch: $archive"
    }

    $expected = @{}
    Add-Sources $expected @(
        'package.json', 'package-lock.json', 'tsconfig.json', 'VERSION', 'CODEX-SOURCE-REVISION', 'NATIVE_PATCH_CHAIN.json',
        'README.md', 'WORKIQ.md', 'NATIVE_COMPATIBILITY.md', 'RELEASE_NOTES.md',
        'MIGRATION.md', 'MIGRATION.zh-CN.md', 'assets', 'bridge','gateway', 'patches', 'skills'
    )
    if ($targetIsWindows) {
        Add-Sources $expected @('install.cmd', 'install.ps1', 'src', 'tests', 'tools',
            'bin\ccodex.cmd', 'bin\codex-copilot.cmd', 'bin\ccodex-smart-paste.cjs',
            'bin\codex-copilot-desktop.exe')
        $coreName = "bin/runtimes/$arch/codex-copilot-core.exe"
        $manifestName = "bin/runtimes/$arch/codex-copilot-core.manifest.json"
        $compatibilityName = "bin/runtimes/$arch/cli-update-compatibility.json"
    } else {
        Add-Sources $expected @('platforms\unix\install.sh',
            'tools',
            'platforms\unix\bin\ccodex', 'platforms\unix\bin\codex-copilot',
            'platforms\unix\bin\bridge-port.sh')
        $expected['install.sh'] = $expected['platforms/unix/install.sh']
        $expected['bin/ccodex'] = $expected['platforms/unix/bin/ccodex']
        $expected['bin/codex-copilot'] = $expected['platforms/unix/bin/codex-copilot']
        $expected['bin/bridge-port.sh'] = $expected['platforms/unix/bin/bridge-port.sh']
        $expected.Remove('platforms/unix/install.sh')
        $expected.Remove('platforms/unix/bin/ccodex')
        $expected.Remove('platforms/unix/bin/codex-copilot')
        $expected.Remove('platforms/unix/bin/bridge-port.sh')
        if ($target.StartsWith('macos-')) {
            Add-Sources $expected @('platforms\macos\bin\codex-copilot-desktop')
            $expected['bin/codex-copilot-desktop'] = $expected['platforms/macos/bin/codex-copilot-desktop']
            $expected.Remove('platforms/macos/bin/codex-copilot-desktop')
        } else {
            Add-Sources $expected @('platforms\linux\bin\codex-copilot-desktop')
            $expected['bin/codex-copilot-desktop'] = $expected['platforms/linux/bin/codex-copilot-desktop']
            $expected.Remove('platforms/linux/bin/codex-copilot-desktop')
        }
        $coreName = 'bin/codex-copilot-core'
        $manifestName = 'bin/codex-copilot-core.manifest.json'
        $compatibilityName = 'bin/cli-update-compatibility.json'
    }
    $seen = @{}
    $capture = @('VERSION', 'CODEX-SOURCE-REVISION', 'platform-target.json', $manifestName, $compatibilityName)
    $componentPrefix = $coreName -replace '[^/]+$', ''
    $executableSuffix = if ($targetIsWindows) { '.exe' } else { '' }
    $componentNames = @(
        "${componentPrefix}codex-code-mode-host$executableSuffix",
        "${componentPrefix}codex-path/rg$executableSuffix",
        "${componentPrefix}codex-resources/bwrap",
        "${componentPrefix}codex-resources/codex-command-runner.exe",
        "${componentPrefix}codex-resources/codex-windows-sandbox-setup.exe"
    )
    $wanted = @($expected.Keys) + $capture + @($coreName) + $componentNames
    if ($targetIsWindows) {
        $zip = [IO.Compression.ZipFile]::OpenRead($archive)
        try {
            foreach ($entry in $zip.Entries) {
                $relative = $entry.FullName.Replace('\', '/')
                if ($relative -notin $wanted) { continue }
                $stream = $entry.Open()
                try { $seen[$relative] = Read-Digest $stream ($relative -in $capture) }
                finally { $stream.Dispose() }
            }
        } finally { $zip.Dispose() }
    } else {
        $file = [IO.File]::OpenRead($archive)
        $gzip = [IO.Compression.GZipStream]::new($file, [IO.Compression.CompressionMode]::Decompress)
        $reader = [System.Formats.Tar.TarReader]::new($gzip)
        try {
            while ($entry = $reader.GetNextEntry()) {
                if (-not $entry.DataStream) { continue }
                $relative = $entry.Name.TrimStart([char[]]'./')
                if (-not $relative.StartsWith("$name/", [StringComparison]::Ordinal)) { continue }
                $relative = $relative.Substring($name.Length + 1)
                if ($relative -in $wanted) {
                    $seen[$relative] = Read-Digest $entry.DataStream ($relative -in $capture)
                }
            }
        } finally {
            $reader.Dispose()
            $gzip.Dispose()
            $file.Dispose()
        }
    }
    foreach ($relative in $expected.Keys) {
        if (-not $seen.ContainsKey($relative) -or $seen[$relative].Hash -ne $expected[$relative]) {
            throw "Release source drift in $target`: $relative"
        }
    }
    foreach ($relative in $capture + @($coreName)) {
        if (-not $seen.ContainsKey($relative)) { throw "Release payload missing $target`: $relative" }
    }
    $metadata = $seen['platform-target.json'].Text | ConvertFrom-Json
    $manifest = $seen[$manifestName].Text | ConvertFrom-Json
    $compatibility = $seen[$compatibilityName].Text | ConvertFrom-Json
    if ($seen['VERSION'].Text.Trim() -ne $version -or
        $seen['CODEX-SOURCE-REVISION'].Text.Trim() -ne $revision -or
        $metadata.target -ne $target -or $metadata.packageVersion -ne $version -or
        $metadata.sourceRevision -ne $revision -or
        $metadata.coreSha256 -ne $seen[$coreName].Hash -or
        $manifest.packageVersion -ne $version -or $manifest.target -ne $target -or
        $manifest.sourceRevision -ne $revision -or
        $manifest.patchedTree -ne $chain.patchedTree -or
        $manifest.sha256 -ne $seen[$coreName].Hash) {
        throw "Release provenance mismatch: $target"
    }
    if ($manifest.coreVersion -notmatch '^codex-cli (\d+)\.(\d+)\.(\d+)$') {
        throw "Release core version is malformed: $target"
    }
    $requiresComponents = [int]$Matches[1] -gt 0 -or [int]$Matches[2] -ge 160
    if ($requiresComponents) {
        $requiredComponents = @(
            "codex-code-mode-host$executableSuffix",
            "codex-path/rg$executableSuffix"
        )
        if ($targetIsWindows) {
            $requiredComponents += @('codex-resources/codex-command-runner.exe',
                'codex-resources/codex-windows-sandbox-setup.exe')
        } elseif ($target.StartsWith('linux-')) {
            $requiredComponents += 'codex-resources/bwrap'
        }
        $componentFiles = @($manifest.components | ForEach-Object file)
        if (@($manifest.components).Count -gt 32 -or
            @($componentFiles | Sort-Object -Unique).Count -ne $componentFiles.Count) {
            throw "Release companion inventory is invalid: $target"
        }
        foreach ($relative in $requiredComponents) {
            if ($relative -cnotin $componentFiles) {
                throw "Release companion inventory is incomplete: $target/$relative"
            }
        }
        foreach ($component in $manifest.components) {
            $relative = $componentPrefix + $component.file
            if ($relative -cnotin $componentNames -or $component.target -cne $target -or
                $component.sourceRevision -cne $revision -or
                $component.patchedTree -cne $chain.patchedTree -or
                $component.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or
                -not $seen.ContainsKey($relative) -or
                $seen[$relative].Hash -ne $component.sha256) {
                throw "Release native companion is missing, stale or modified: $target/$($component.file)"
            }
        }
    }
    if ($compatibility.schemaVersion -ne 1 -or $compatibility.kind -cne 'native-runtime' -or
        $compatibility.passed -ne $true -or $compatibility.target -cne $target -or
        $compatibility.extensionGeneration -cne $extensionGeneration -or
        $compatibility.coreSha256 -ne $seen[$coreName].Hash -or
        $compatibility.sourceRevision -cne $revision -or
        $compatibility.patchedTree -cne $chain.patchedTree -or
        $compatibility.coreVersion -cne $manifest.coreVersion) {
        throw "Release CLI compatibility evidence is missing or stale: $target"
    }
    foreach ($fact in @('contextSelectionVerified','nativeInputVerified','nativeStatusVerified',
        'transcriptAndAttachmentsVerified','upstreamFeaturesVerified','creditsVerified')) {
        if ($compatibility.facts.$fact -ne $true) {
            throw "Release CLI compatibility remains unproven: $target/$fact"
        }
    }
    if (($manifest.patches.name -join '|') -ne ($chain.patches -join '|')) {
        throw "Native patch chain mismatch: $target"
    }
    foreach ($patch in $manifest.patches) {
        if ($patch.sha256 -ne (Get-FileHash -LiteralPath (Join-Path $stage "patches\$($patch.name)")).Hash) {
            throw "Native patch hash mismatch: $target / $($patch.name)"
        }
    }
    $results.Add([ordered]@{
        target = $target
        archive = [IO.Path]::GetFileName($archive)
        sha256 = $expectedArchiveHash
        coreSha256 = $seen[$coreName].Hash
        sourceFilesVerified = $expected.Count
        runtimeVerified = [bool]$manifest.runtimeVerified
        cliUpdateCompatibilityVerified = $true
        nativeCompanionBytesVerified = $requiresComponents
    })
    Write-Output "PASS $target`: $($expected.Count) source files, core, manifest and archive hash"
}

foreach ($target in @('linux-arm64', 'linux-x64')) {
    $arch = if ($target.EndsWith('arm64')) { 'arm64' } else { 'amd64' }
    $rpmArch = if ($target.EndsWith('arm64')) { 'aarch64' } else { 'x86_64' }
    $base = "codex-copilot-$target-$version"
    $deb = (& wsl --exec wslpath -a (Join-Path $distribution "$base.deb")).Trim()
    $rpm = (& wsl --exec wslpath -a (Join-Path $distribution "$base.rpm")).Trim()
    $debFields = @(& wsl --exec dpkg-deb -f $deb Version Architecture)
    $rpmFields = @(& wsl --exec rpm -qp --qf '%{VERSION}\n%{ARCH}\n' $rpm)
    if ($LASTEXITCODE -ne 0 -or $debFields.Count -ne 2 -or
        $debFields[0] -ne "Version: $version" -or
        $debFields[1] -ne "Architecture: $arch" -or
        $rpmFields.Count -ne 2 -or $rpmFields[0] -ne $version -or
        $rpmFields[1] -ne $rpmArch) {
        throw "Linux package version/architecture mismatch: $target"
    }
    foreach ($extension in @('deb', 'rpm')) {
        $file = Join-Path $distribution "$base.$extension"
        $expectedHash = ((Get-Content -LiteralPath "$file.sha256" -Raw).Trim() -split '\s+')[0]
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $expectedHash) {
            throw "Linux package hash mismatch: $file"
        }
    }
}

$report = [ordered]@{
    schemaVersion = 1
    version = $version
    sourceRevision = $revision
    patchedTree = $chain.patchedTree
    targets = $results.ToArray()
    allTenArchivesVerified = $results.Count -eq 6
    verifiedAt = (Get-Date).ToString('o')
}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $distribution "RELEASE-MANIFEST-$version.json") -Encoding utf8
Write-Output "Verified all six platform targets and ten release archives for $version."
