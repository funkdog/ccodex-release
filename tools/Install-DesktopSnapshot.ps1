[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexCopilot'),
    [string]$SourceApp,
    [string]$VendorVersion,
    [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
    [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ((Get-Process -Id $PID).PriorityClass -notin @('BelowNormal', 'Idle') -or
    $env:CARGO_BUILD_JOBS -ne '6') {
    throw 'Run Desktop snapshot installation through tools\Invoke-HeavyTask.ps1.'
}
$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($root -in @([IO.Path]::GetPathRoot($root).TrimEnd('\'),
        [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\'),
        [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\'))) {
    throw 'Refusing a broad Desktop installation root.'
}
if (-not $SourceApp) {
    $package = Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $package) { throw 'The official ChatGPT Desktop package is not installed.' }
    $SourceApp = Join-Path $package.InstallLocation 'app'
    $VendorVersion = $package.Version
}
$source = (Resolve-Path -LiteralPath $SourceApp).ProviderPath.TrimEnd('\')
$officialExe = Join-Path $source 'ChatGPT.exe'
$archive = Join-Path $source 'resources\app.asar'
if (-not (Test-Path -LiteralPath $officialExe -PathType Leaf) -or
    -not (Test-Path -LiteralPath $archive -PathType Leaf) -or
    (Get-Item -LiteralPath $source -Force).LinkType) {
    throw 'The selected official Desktop app directory is incomplete or linked.'
}
$signature = Get-AuthenticodeSignature -LiteralPath $officialExe
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'OpenAI') {
    throw 'The official Desktop executable must have a valid OpenAI signature.'
}
$contractScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'bridge\desktop-runtime.mjs'
$contractText = & $NodePath $contractScript inspect $archive
if ($LASTEXITCODE -ne 0) { throw 'The vendor Desktop isolation contract is unsupported.' }
$contract = ($contractText -join "`n") | ConvertFrom-Json
if (-not $VendorVersion) { $VendorVersion = $contract.version }
if ($VendorVersion -notmatch '^\d+(?:\.\d+){2,3}$') { throw 'Invalid official Desktop version.' }
$archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
$version = "$VendorVersion-$($archiveHash.Substring(0,12))"
$desktop = Join-Path $root 'desktop'
$versions = Join-Path $desktop 'versions'
$destination = Join-Path $versions $version
New-Item -ItemType Directory -Path $versions -Force | Out-Null
foreach ($ancestor in @($root, $desktop, $versions)) {
    if ((Get-Item -LiteralPath $ancestor -Force).LinkType) { throw 'Desktop snapshot root cannot be linked.' }
}
$manifestFile = Join-Path $destination 'snapshot.json'
if (Test-Path -LiteralPath $destination) {
    if (-not (Test-Path -LiteralPath $manifestFile -PathType Leaf)) {
        throw "An incomplete Desktop snapshot requires inspection: $destination"
    }
    & $NodePath --input-type=module -e `
        'import {pathToFileURL} from "node:url"; const m=await import(pathToFileURL(process.argv[1])); const s=m.desktopSnapshot(process.argv[2],{version:process.argv[3]}); console.log(s.manifest.version);' `
        (Join-Path (Split-Path -Parent $PSScriptRoot) 'bridge\desktop-runtime.mjs') $root $version
    if ($LASTEXITCODE -ne 0) { throw 'Existing independent snapshot failed verification.' }
} else {
    $staging = Join-Path $desktop ('staging-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $staging 'app') -Force | Out-Null
    Write-Output "DesktopSnapshotWorkerPid=$PID Priority=$((Get-Process -Id $PID).PriorityClass) VendorVersion=$VendorVersion"
    $files = @()
    try {
        foreach ($item in Get-ChildItem -LiteralPath $source -Recurse -File -Force | Sort-Object FullName) {
            # Store packages deduplicate locale files with hard links. Read and
            # copy their bytes into new regular files; never reproduce the link.
            if ($item.LinkType -and $item.LinkType -ne 'HardLink') {
                throw "The official source contains an unsupported link: $($item.FullName)"
            }
            $relative = $item.FullName.Substring($source.Length + 1)
            $to = [IO.Path]::GetFullPath((Join-Path $staging "app\$relative"))
            if (-not $to.StartsWith($staging + '\app\', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Desktop snapshot copy escaped its staging directory.'
            }
            New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force | Out-Null
            $before = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            Copy-Item -LiteralPath $item.FullName -Destination $to
            $after = (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($before -ne $after) { throw "Official Desktop copy checksum failed: $relative" }
            $files += [ordered]@{
                path = ('app/' + $relative.Replace('\','/'))
                size = $item.Length
                sha256 = $after
            }
        }
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveHash) {
            throw 'The official Desktop changed during snapshot preparation.'
        }
        $manifest = [ordered]@{
            schemaVersion = 1
            version = $version
            vendorVersion = $VendorVersion
            applicationVersion = $contract.version
            platform = 'windows'
            arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
            executable = 'app/ChatGPT.exe'
            resources = 'app/resources'
            sourceApp = $source
            signer = $signature.SignerCertificate.Subject
            preparedAt = (Get-Date).ToString('o')
            copiedWithoutCodeChanges = $true
            isolationContract = $contract
            files = $files
        }
        [IO.File]::WriteAllText((Join-Path $staging 'snapshot.json'),
            ($manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $staging -Destination $destination
    } finally {
        if (Test-Path -LiteralPath $staging) {
            $resolved = (Resolve-Path -LiteralPath $staging).ProviderPath
            if ((Get-Item -LiteralPath $resolved -Force).LinkType -or
                (Split-Path -Parent $resolved) -ne $desktop -or
                (Split-Path -Leaf $resolved) -notmatch '^staging-[a-f0-9]{32}$') {
                throw 'Refusing unexpected Desktop staging cleanup.'
            }
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
if (-not $PrepareOnly) {
    $pointer = Join-Path $desktop 'current.json'
    if (Test-Path -LiteralPath $pointer) {
        if ((Get-Item -LiteralPath $pointer -Force).LinkType) { throw 'The Desktop pointer cannot be linked.' }
        Write-Output 'Existing independent Desktop selection was preserved. A stock update or enhanced reinstall cannot promote a different snapshot; use the validated private update workflow.'
    } else {
        $pending = Join-Path $desktop ('current-' + [guid]::NewGuid().ToString('N') + '.pending')
        [IO.File]::WriteAllText($pending, (@{
            schemaVersion = 1; version = $version; selectedAt = (Get-Date).ToString('o')
        } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        try {
            # Non-overwriting move: a concurrent private selection wins.
            [IO.File]::Move($pending, $pointer)
        } finally {
            if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending }
        }
    }
}
Write-Output "Independent Desktop snapshot ready: $destination. Official app files and running processes were not changed."
