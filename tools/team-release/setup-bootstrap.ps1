[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$StageRoot,
    [switch]$ExtractOnly,
    [string]$Destination,
    [string]$InstallRoot,
    [string]$Profile,
    [switch]$NoShortcuts,
    [switch]$NoRegistration,
    [switch]$NoLogin,
    [switch]$Silent,
    [switch]$KeepExtracted
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$ProgressPreference = 'SilentlyContinue'
$exitCode = 1
$stage = [IO.Path]::GetFullPath($StageRoot).TrimEnd('\')
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if ((Split-Path -Parent $stage) -ne $temp -or
    (Split-Path -Leaf $stage) -notmatch '^ccodex-release-setup-[a-f0-9]{32}$' -or
    (Get-Item -LiteralPath $stage -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Unexpected setup staging directory.'
}
try {
    Write-Host ("Private setup stage: " + $stage)
    $archive = Join-Path $stage 'payload.zip'
    $target = Join-Path $stage 'app'
    if ($ExtractOnly) {
        if (-not $Destination) { throw 'Extract-only mode requires a destination.' }
        $target = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
        if ($target -eq [IO.Path]::GetPathRoot($target).TrimEnd('\') -or
            $target -eq [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')) {
            throw 'Refusing a broad extraction directory.'
        }
        if (Test-Path -LiteralPath $target) {
            if ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or
                @(Get-ChildItem -LiteralPath $target -Force).Count) {
                throw 'Extraction requires an empty, regular directory.'
            }
        }
    }
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Write-Host 'Archive hash verified. Checking contained ZIP paths.'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\','/')
            if (-not $name -or $name.StartsWith('/') -or $name.Contains(':') -or
                $name.Split('/') -contains '..' -or $name.Split('/') -contains '.' -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
                throw 'ZIP contains an unsafe path or symbolic link.'
            }
            foreach ($part in $name.Split('/')) {
                if ($part.EndsWith('.') -or $part.EndsWith(' ') -or
                    $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
                    throw 'ZIP contains a Windows path alias or device name.'
                }
            }
        }
    } finally { $zip.Dispose() }
    Write-Host 'Extracting all offline resources. This can take a few minutes.'
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $tar)) { throw 'Windows 11 built-in tar.exe is unavailable.' }
    & $tar -xf $archive -C $target
    if ($LASTEXITCODE -ne 0) { throw 'Release archive extraction failed.' }
    if ($ExtractOnly) {
        Write-Host "Verified release resources extracted: $target"
        $exitCode = 0
    } else {
        if (-not $env:CCODEX_REAL_PSMODULEPATH) {
            $env:CCODEX_REAL_PSMODULEPATH = $env:PSModulePath
        }
        $env:PYTHONDONTWRITEBYTECODE = '1'
        $privateShell = Join-Path $target 'runtime\primary\codex-primary-runtime\dependencies\native\powershell\pwsh.exe'
        $privateShell = '\\?\' + $privateShell
        if (-not (Test-Path -LiteralPath $privateShell -PathType Leaf)) {
            throw 'The release-owned PowerShell runtime is missing.'
        }
        $options = @('-NoLogo','-NoProfile','-File',(Join-Path $target 'release\install.ps1'))
        if ($NoShortcuts) { $options += '-NoShortcuts' }
        if ($NoRegistration) { $options += '-NoRegistration' }
        if ($NoLogin) { $options += '-NoLogin' }
        if ($Silent) { $options += '-Silent' }
        if ($InstallRoot) { $options += @('-InstallRoot',$InstallRoot) }
        if ($Profile) { $options += @('-Profile',$Profile) }
        & $privateShell @options
        if ($LASTEXITCODE -ne 0) { throw "Private installation failed (exit $LASTEXITCODE)." }
        $exitCode = 0
    }
} catch {
    Write-Host ('Setup failed: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Existing Codex and Copilot installations were not removed or replaced.'
    if (-not $Silent) { [void](Read-Host 'Press Enter to close') }
} finally {
    if (-not $KeepExtracted -and (Test-Path -LiteralPath $stage)) {
        # The native parent removes its verified stage after all bundled runtimes
        # exit. Win32 extended paths avoid PowerShell 5.1 MAX_PATH restrictions.
        Write-Host 'Cleaning temporary resources after the installer worker exits.'
    }
}
exit $exitCode
