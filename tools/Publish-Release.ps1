<#
.SYNOPSIS
    Test, build, verify and promote every CodexCopilot platform package.

.DESCRIPTION
    Run via tools\Invoke-HeavyTask.ps1. If the native patch chain
    matches the previous release, reuse its verified cores while rebuilding
    every package with the current bridge, Desktop launcher, installers and UI.
    Native-source changes require a newly tested six-target artifact directory;
    the script fails closed instead of publishing an old core under a new label.
#>
[CmdletBinding()]
param(
    [string]$NativeArtifactsRoot,
    [string]$ReadinessFile = 'release-readiness/current.json',
    [string]$TeamSetupWorkspace,
    [ValidateSet('Compile','Test','Freeze','Package')][string]$TeamSetupPhase = 'Test'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ((Get-Process -Id $PID).PriorityClass -notin @('BelowNormal', 'Idle') -or $env:CARGO_BUILD_JOBS -ne '6') {
    throw 'Run Publish-Release.ps1 through tools\Invoke-HeavyTask.ps1.'
}
if ($TeamSetupWorkspace) {
    $workspace = [IO.Path]::GetFullPath($TeamSetupWorkspace).TrimEnd('\')
    $marker = Join-Path $workspace 'work\.ccodex-team-build.json'
    if (-not (Test-Path -LiteralPath $marker) -or
        (Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).product -ne 'CcodexTeamSetupBuild') {
        throw 'Team setup publication requires an explicit, owned build workspace.'
    }
    & (Join-Path $workspace 'work\publish-startup-worker.ps1') -Phase $TeamSetupPhase
    exit $LASTEXITCODE
}
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$existingVersion = (Get-Content -LiteralPath (Join-Path $root 'VERSION') -Raw).Trim()
$released = @(Get-ChildItem -LiteralPath (Join-Path $root 'dist') -Filter 'RELEASE-MANIFEST-*.json' -File |
    ForEach-Object {
        if ($_.Name -match '^RELEASE-MANIFEST-(\d+\.\d+\.\d+)\.json$') {
            [version]$Matches[1]
        }
    } | Sort-Object -Descending)
if (-not $released.Count) { throw 'No previous verified release manifest was found.' }
$previous = $released[0].ToString(3)
$current = [version]$existingVersion
if ($current -eq $released[0]) {
    $version = "$($current.Major).$($current.Minor).$($current.Build + 1)"
} elseif ($current -gt $released[0]) {
    $version = $existingVersion
} else {
    throw "Source VERSION $existingVersion is older than release $previous."
}
if ((Get-Content -LiteralPath (Join-Path $root 'RELEASE_NOTES.md') -TotalCount 1) -ne
    "# Codex (Copilot) $version") {
    throw "Update RELEASE_NOTES.md for $version before publishing."
}
& node (Join-Path $root 'tools\release-readiness.mjs') $root $version $ReadinessFile
if ($LASTEXITCODE -ne 0) {
    throw 'Current source lacks complete, bound native isolation/UI/update admission evidence. No release staging or promotion was started.'
}
& node (Join-Path $root 'tools\typescript-task.mjs') check
if ($LASTEXITCODE -ne 0) { throw 'Build the canonical TypeScript source before publishing.' }
Write-Output "ReleaseWorkerPid=$PID Priority=BelowNormal Version=$version Previous=$previous"
& node (Join-Path $root 'tools\apply-native-patches.mjs') --check-chain
if ($LASTEXITCODE -ne 0) { throw 'Native patch chain validation failed.' }

$chain = Get-Content -LiteralPath (Join-Path $root 'NATIVE_PATCH_CHAIN.json') -Raw | ConvertFrom-Json
$stage = Join-Path $root ".release-staging\$version"
$candidateDist = Join-Path $stage 'dist'
if (Test-Path -LiteralPath $stage) { throw "Existing release staging needs inspection: $stage" }
foreach ($target in @('windows-arm64','windows-x64','linux-arm64','linux-x64','macos-arm64','macos-x64')) {
    $extension = if ($target.StartsWith('windows')) { 'zip' } else { 'tar.gz' }
    if (Test-Path -LiteralPath (Join-Path $root "dist\codex-copilot-$target-$version.$extension")) {
        throw "Refusing to overwrite an already published $version archive."
    }
}
New-Item -ItemType Directory -Path $candidateDist -Force | Out-Null
$inputs = @(
    'package.json','package-lock.json','tsconfig.json','.github','README.md','WORKIQ.md','RELEASE_NOTES.md','MIGRATION.md',
    'MIGRATION.zh-CN.md','NATIVE_COMPATIBILITY.md','CODEX-SOURCE-REVISION',
    'NATIVE_PATCH_CHAIN.json','install.cmd','install.ps1','assets','bridge','gateway',
    'patches','skills','src','tests','tools','platforms'
)
foreach ($relative in $inputs) {
    $source = Join-Path $root $relative
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing release source: $relative" }
    Copy-Item -LiteralPath $source -Destination $stage -Recurse
}
[IO.File]::WriteAllText((Join-Path $stage 'VERSION'), "$version`n", [Text.UTF8Encoding]::new($false))
$bin = Join-Path $stage 'bin'
New-Item -ItemType Directory -Path $bin -Force | Out-Null
foreach ($item in @('ccodex.cmd','codex-copilot.cmd','ccodex-smart-paste.cjs','node-pty')) {
    Copy-Item -LiteralPath (Join-Path $root "bin\$item") -Destination $bin -Recurse
}

$icon = Join-Path $stage 'assets\codex-copilot.ico'
$compiler = @(
    'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
    'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) { throw 'A C# compiler is required to rebuild the Desktop launcher.' }
& $compiler /nologo /target:winexe /platform:anycpu /optimize+ `
    "/out:$(Join-Path $bin 'codex-copilot-desktop.exe')" "/win32icon:$icon" `
    /reference:System.dll /reference:System.Core.dll `
    /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
    (Join-Path $stage 'src\CodexCopilotDesktop.cs')
if ($LASTEXITCODE -ne 0) { throw 'Desktop launcher compilation failed.' }

$candidate = if ($NativeArtifactsRoot) { [IO.Path]::GetFullPath($NativeArtifactsRoot) } else { $null }
foreach ($arch in @('arm64','x64')) {
    $target = "windows-$arch"
    $source = if ($candidate) { Join-Path $candidate $target } else { Join-Path $root "bin\runtimes\$arch" }
    $destination = Join-Path $bin "runtimes\$arch"
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    $binary = Join-Path $source 'codex-copilot-core.exe'
    $manifestFile = Join-Path $source 'codex-copilot-core.manifest.json'
    $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
    $sha = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
    if ($manifest.target -ne $target -or $manifest.sourceRevision -ne $chain.sourceRevision -or
        $manifest.patchedTree -ne $chain.patchedTree -or $manifest.sha256 -ne $sha -or
        ($manifest.patches.name -join '|') -ne ($chain.patches -join '|')) {
        throw "Native core provenance mismatch: $target"
    }
    foreach ($patch in $manifest.patches) {
        if ($patch.sha256 -ne (Get-FileHash -LiteralPath (Join-Path $stage "patches\$($patch.name)")).Hash) {
            throw "Native patch changed without a matching $target core: $($patch.name)"
        }
    }
    if ($candidate) {
        if ($manifest.packageVersion -ne $version -or $manifest.runtimeVerified -ne $true) {
            throw "Newly built $target core lacks current release/runtime validation."
        }
    } else {
        if ($manifest.packageVersion -ne $previous) { throw "Stale previous core manifest: $target" }
        $manifest.packageVersion = $version
        $manifest | Add-Member -NotePropertyName reusedFromRelease -NotePropertyValue $previous -Force
    }
    Copy-Item -LiteralPath $binary -Destination $destination
    & node (Join-Path $root 'bridge\cli-components.mjs') copy $binary `
        (Join-Path $destination 'codex-copilot-core.exe') $manifestFile
    if ($LASTEXITCODE -ne 0) { throw "Native companion provenance mismatch: $target" }
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $destination 'codex-copilot-core.manifest.json') -Encoding utf8
    if ($candidate) {
        $compatibility = Join-Path $source 'cli-update-compatibility.json'
        if (-not (Test-Path -LiteralPath $compatibility -PathType Leaf)) {
            throw "Newly built $target core lacks actual CLI update compatibility evidence."
        }
        Copy-Item -LiteralPath $compatibility -Destination $destination
    }
    Write-Output "Staged $target native core: $sha"
}

& (Join-Path $stage 'tools\Test-ReleaseCandidate.ps1') -StagingRoot $stage `
    -Core (Join-Path $bin 'runtimes\arm64\codex-copilot-core.exe')
if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { throw 'Isolated release tests failed.' }
$tests = Get-Content -LiteralPath (Join-Path $stage 'test-evidence\release-tests.json') -Raw | ConvertFrom-Json
if (-not $tests.passed -or $tests.coreSha256 -ne
    (Get-FileHash -LiteralPath (Join-Path $bin 'runtimes\arm64\codex-copilot-core.exe')).Hash) {
    throw 'Release test evidence does not match the candidate core.'
}

foreach ($arch in @('arm64','x64')) {
    & (Join-Path $stage 'tools\New-TransferBundle.ps1') -Target "windows-$arch" `
        -OutputPath (Join-Path $candidateDist "codex-copilot-windows-$arch-$version.zip")
    Write-Output "Packaged windows-$arch"
}
$unixStage = (& wsl --exec wslpath -a $stage).Trim()
$unixPrevious = (& wsl --exec wslpath -a (Join-Path $root 'dist')).Trim()
$unixDist = (& wsl --exec wslpath -a $candidateDist).Trim()
$unixCandidate = if ($candidate) { (& wsl --exec wslpath -a $candidate).Trim() } else { '' }
& wsl --exec env 'CARGO_BUILD_JOBS=6' 'MAKEFLAGS=-j6' nice -n 10 bash `
    "$unixStage/tools/repackage-unix.sh" $unixStage $unixPrevious $unixDist $previous $unixCandidate
if ($LASTEXITCODE -ne 0) { throw 'Unix target packaging failed; no release was promoted.' }

$archives = @(Get-ChildItem -LiteralPath $candidateDist -File |
    Where-Object { $_.Name -match '\.(zip|tar\.gz|deb|rpm)$' } | Sort-Object Name)
if ($archives.Count -ne 10) { throw "Expected ten platform archives, found $($archives.Count)." }
$hashLines = foreach ($archive in $archives) {
    $hash = (Get-FileHash -LiteralPath $archive.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $line = "$hash  $($archive.Name)"
    [IO.File]::WriteAllText("$($archive.FullName).sha256", "$line`n", [Text.Encoding]::ASCII)
    $line
}
foreach ($filename in @('SHA256SUMS.txt',"SHA256SUMS-$version.txt")) {
    [IO.File]::WriteAllText((Join-Path $candidateDist $filename), ($hashLines -join "`n") + "`n", [Text.Encoding]::ASCII)
}
& (Join-Path $stage 'tools\Verify-ReleaseArtifacts.ps1') -StagingRoot $stage -Dist $candidateDist
if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { throw 'Release archive verification failed.' }
$verification = Get-Content -LiteralPath (Join-Path $candidateDist "RELEASE-MANIFEST-$version.json") -Raw | ConvertFrom-Json
if (-not $verification.allTenArchivesVerified -or $verification.targets.Count -ne 6) {
    throw 'The release verification report is incomplete.'
}

# The source may be edited while a long packaging run is in progress. Never
# publish a verified snapshot as though it contained those newer edits.
foreach ($relative in $inputs) {
    $source = Join-Path $root $relative
    $staged = Join-Path $stage $relative
    if (Test-Path -LiteralPath $source -PathType Container) {
        $currentFiles = @(Get-ChildItem -LiteralPath $source -Recurse -File |
            ForEach-Object { [IO.Path]::GetRelativePath($source, $_.FullName) } | Sort-Object)
        $stagedFiles = @(Get-ChildItem -LiteralPath $staged -Recurse -File |
            ForEach-Object { [IO.Path]::GetRelativePath($staged, $_.FullName) } | Sort-Object)
        if (($currentFiles -join '|') -cne ($stagedFiles -join '|')) {
            throw "Release source changed while packaging: $relative"
        }
        foreach ($file in $currentFiles) {
            if ((Get-FileHash -LiteralPath (Join-Path $source $file)).Hash -ne
                (Get-FileHash -LiteralPath (Join-Path $staged $file)).Hash) {
                throw "Release source changed while packaging: $relative/$file"
            }
        }
    } elseif ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $staged).Hash) {
        throw "Release source changed while packaging: $relative"
    }
}
foreach ($relative in @('ccodex.cmd','codex-copilot.cmd','ccodex-smart-paste.cjs')) {
    if ((Get-FileHash -LiteralPath (Join-Path $root "bin\$relative")).Hash -ne
        (Get-FileHash -LiteralPath (Join-Path $bin $relative)).Hash) {
        throw "Release launcher changed while packaging: $relative"
    }
}

# Promotion is the last step. Published archive names are immutable.
foreach ($file in Get-ChildItem -LiteralPath $candidateDist -File |
    Where-Object Name -ne 'SHA256SUMS.txt') {
    $destination = Join-Path $root "dist\$($file.Name)"
    if (Test-Path -LiteralPath $destination) {
        throw "Refusing to replace a published release file: $destination"
    }
    Copy-Item -LiteralPath $file.FullName -Destination $destination
    if ((Get-FileHash -LiteralPath $destination).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) {
        throw "Promotion copy hash mismatch: $destination"
    }
}
foreach ($arch in @('arm64','x64')) {
    foreach ($filename in @('codex-copilot-core.exe','codex-copilot-core.manifest.json','cli-update-compatibility.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $bin "runtimes\$arch\$filename"))) {
            throw "Verified release is missing CLI update compatibility: $arch/$filename"
        }
        Copy-Item -LiteralPath (Join-Path $bin "runtimes\$arch\$filename") `
            -Destination (Join-Path $root "bin\runtimes\$arch\$filename") -Force
    }
    $runtime = Join-Path $bin "runtimes\$arch"
    $runtimeManifest = Get-Content -LiteralPath (Join-Path $runtime 'codex-copilot-core.manifest.json') -Raw | ConvertFrom-Json
    foreach ($component in $runtimeManifest.components) {
        $sourceComponent = Join-Path $runtime $component.file
        $destinationComponent = Join-Path $root "bin\runtimes\$arch\$($component.file)"
        New-Item -ItemType Directory -Path (Split-Path -Parent $destinationComponent) -Force | Out-Null
        Copy-Item -LiteralPath $sourceComponent -Destination $destinationComponent -Force
        if ((Get-FileHash -LiteralPath $destinationComponent).Hash -ne $component.sha256) {
            throw "Promoted companion hash mismatch: windows-$arch/$($component.file)"
        }
    }
}
Copy-Item -LiteralPath (Join-Path $bin 'codex-copilot-desktop.exe') `
    -Destination (Join-Path $root 'bin\codex-copilot-desktop.exe') -Force
[IO.File]::WriteAllText((Join-Path $root 'VERSION'), "$version`n", [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $root 'RELEASE_NOTES.md') -Destination (Join-Path $root 'dist\RELEASE_NOTES.md') -Force
Copy-Item -LiteralPath (Join-Path $stage 'test-evidence\release-tests.json') `
    -Destination (Join-Path $root "dist\RELEASE-TESTS-$version.json")
Copy-Item -LiteralPath (Join-Path $candidateDist 'SHA256SUMS.txt') `
    -Destination (Join-Path $root 'dist\SHA256SUMS.txt') -Force
Write-Output "Published ${version}: six targets, ten archives, full isolated tests and source-byte verification."

$resolved = (Resolve-Path -LiteralPath $stage).ProviderPath
if ((Get-Item -LiteralPath $stage -Force).LinkType -or
    $resolved -cne [IO.Path]::GetFullPath($stage) -or
    -not $resolved.StartsWith((Join-Path $root '.release-staging') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing unexpected release cleanup target: $stage"
}
Remove-Item -LiteralPath $resolved -Recurse -Force
Write-Output "Removed temporary release source: $resolved"
