[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexCopilot'),
    [string]$PackageFile,
    [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ((Get-Process -Id $PID).PriorityClass -notin @('BelowNormal','Idle') -or
    $env:CARGO_BUILD_JOBS -ne '6') {
    throw 'Run Desktop update preparation through tools\Invoke-HeavyTask.ps1.'
}
$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($arch -notin @('arm64','x64')) { throw 'Unsupported Desktop architecture.' }
$url = "https://persistent.oaistatic.com/codex-app-prod/ChatGPT-$arch.msix"
$desktop = Join-Path $root 'desktop'
$pointer = Join-Path $desktop 'current.json'
$before = if (Test-Path -LiteralPath $pointer) { [IO.File]::ReadAllText($pointer) } else { $null }
New-Item -ItemType Directory -Path $desktop -Force | Out-Null
if ((Get-Item -LiteralPath $root -Force).LinkType -or
    (Get-Item -LiteralPath $desktop -Force).LinkType) {
    throw 'Update installation root cannot be linked.'
}
if ($CheckOnly) {
    $head = Invoke-WebRequest -Uri $url -Method Head -MaximumRedirection 0 -TimeoutSec 20
    [ordered]@{
        schemaVersion = 1; checkedAt = (Get-Date).ToString('o')
        source = $url; status = 'package-metadata'
        etag = [string]$head.Headers.ETag
        lastModified = [string]$head.Headers.'Last-Modified'
        contentLength = [string]$head.Headers.'Content-Length'
        selectedSnapshot = if ($before) { ($before | ConvertFrom-Json).version } else { $null }
        latestVersionVerified = $false
        reason = 'HTTP metadata alone does not prove package version; prepare the signed package to inspect it.'
    } | ConvertTo-Json
    return
}
. (Join-Path $PSScriptRoot 'desktop-package.ps1')
$attempt = [guid]::NewGuid().ToString('N')
$staging = Join-Path $desktop "update-staging-$attempt"
New-Item -ItemType Directory -Path $staging | Out-Null
$receiptDirectory = Join-Path $desktop 'prepared-updates'
New-Item -ItemType Directory -Path $receiptDirectory -Force | Out-Null
if ((Get-Item -LiteralPath $receiptDirectory -Force).LinkType) {
    throw 'Prepared-update receipt directory cannot be linked.'
}
$receiptPath = Join-Path $receiptDirectory "$attempt.json"
$receipt = [ordered]@{
    schemaVersion = 1; attempt = $attempt
    startedAt = (Get-Date).ToString('o'); workerPid = $PID
    status = 'preparing'; target = "windows-$arch"
    source = $url; originalInstallationModified = $false
    pointerPromoted = $false
}
try {
    $package = Join-Path $staging 'ChatGPT.msix'
    if ($PackageFile) {
        $provided = (Resolve-Path -LiteralPath $PackageFile).ProviderPath
        if ((Get-Item -LiteralPath $provided -Force).LinkType) {
            throw 'The supplied Desktop package cannot be linked.'
        }
        Copy-Item -LiteralPath $provided -Destination $package
        $receipt.source = 'explicit-local-package'
    } else {
        Write-Output "Desktop update worker PID: $PID; downloading official package into its private candidate directory."
        Invoke-WebRequest -Uri $url -OutFile $package -MaximumRedirection 0 -TimeoutSec 600
    }
    $receipt.packageSha256 = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash
    $signature = Test-IndependentDesktopPackageSignature -Package $package
    $receipt.packageSignature = $signature
    $extracted = Join-Path $staging 'package'
    $extraction = Expand-IndependentDesktopPackage -Package $package -Destination $extracted
    $receipt.extractedFiles = $extraction.Files
    [xml]$manifest = Get-Content -LiteralPath (Join-Path $extracted 'AppxManifest.xml') -Raw
    $identity = $manifest.Package.Identity
    $selectedVersion = (Get-Content -LiteralPath $pointer -Raw | ConvertFrom-Json).version
    if ($selectedVersion -notmatch '^[\d.]+-[a-f0-9]{12}$') { throw 'Invalid private Desktop selection.' }
    $selectedRoot = Join-Path $desktop "versions\$selectedVersion"
    $selectedManifest = Get-Content -LiteralPath (Join-Path $selectedRoot 'snapshot.json') -Raw | ConvertFrom-Json
    $registeredSignature = Get-AuthenticodeSignature -LiteralPath `
        (Join-Path $selectedRoot 'app\ChatGPT.exe')
    if ($registeredSignature.Status -ne 'Valid' -or
        $registeredSignature.SignerCertificate.Subject -notmatch 'OpenAI') {
        throw 'The private Desktop publisher anchor lacks a valid OpenAI executable signature.'
    }
    $receipt.packageIdentity = [ordered]@{
        name = [string]$identity.Name; publisher = [string]$identity.Publisher
        architecture = [string]$identity.ProcessorArchitecture; version = [string]$identity.Version
    }
    $trustedPublisher = $registeredSignature.SignerCertificate.Subject
    $receipt.trustedPublisher = $trustedPublisher
    $expectedName = [Security.Cryptography.X509Certificates.X500DistinguishedName]::new($trustedPublisher).Name
    $packageSignerName = [Security.Cryptography.X509Certificates.X500DistinguishedName]::new([string]$signature.Signer).Name
    $providedName = [Security.Cryptography.X509Certificates.X500DistinguishedName]::new([string]$identity.Publisher).Name
    if ($identity.Name -ne 'OpenAI.Codex' -or
        ($providedName -cne $expectedName -and $providedName -cne $packageSignerName) -or
        [string]$manifest.Package.Properties.PublisherDisplayName -ne 'OpenAI' -or
        [string]$identity.ProcessorArchitecture -ne $arch -or
        [string]$identity.Version -notmatch '^\d+\.\d+\.\d+\.\d+$') {
        throw 'The signed package identity, publisher, architecture or version is not the expected official Desktop.'
    }
    $sourceApp = Join-Path $extracted 'app'
    $appSignature = Get-AuthenticodeSignature -LiteralPath (Join-Path $sourceApp 'ChatGPT.exe')
    if ($appSignature.Status -ne 'Valid' -or $appSignature.SignerCertificate.Subject -notmatch 'OpenAI') {
        throw 'The extracted Desktop executable does not have a valid OpenAI signature.'
    }
    & (Join-Path $PSScriptRoot 'Install-DesktopSnapshot.ps1') -InstallRoot $root `
        -SourceApp $sourceApp -VendorVersion ([string]$identity.Version) -NodePath $NodePath -PrepareOnly
    if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { throw 'Independent snapshot preparation failed.' }
    $hash = (Get-FileHash -LiteralPath (Join-Path $sourceApp 'resources\app.asar')).Hash.ToLowerInvariant()
    $receipt.vendorVersion = [string]$identity.Version
    $receipt.candidate = "$($identity.Version)-$($hash.Substring(0,12))"
    $receipt.status = 'prepared-needs-extension-validation'
    $receipt.completedAt = (Get-Date).ToString('o')
    $after = if (Test-Path -LiteralPath $pointer) { [IO.File]::ReadAllText($pointer) } else { $null }
    if ($after -cne $before) { throw 'Desktop selection changed while preparing; no promotion was requested by this worker.' }
} catch {
    $receipt.status = 'rejected'
    $receipt.error = $_.Exception.Message
    $receipt.completedAt = (Get-Date).ToString('o')
    throw
} finally {
    [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 6),
        [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $staging) {
        $resolved = (Resolve-Path -LiteralPath $staging).ProviderPath
        if ((Get-Item -LiteralPath $resolved -Force).LinkType -or
            (Split-Path -Parent $resolved) -ne $desktop -or
            (Split-Path -Leaf $resolved) -notmatch '^update-staging-[a-f0-9]{32}$') {
            throw 'Refusing cleanup outside the owned update staging directory.'
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
Write-Output "Prepared signed Desktop candidate without modifying stock installation or selecting it. Receipt: $receiptPath"
