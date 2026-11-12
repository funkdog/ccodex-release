[CmdletBinding()]
param(
    [string]$Package,
    [string]$ReleaseDirectory
)

$ErrorActionPreference = 'Stop'
if (-not $ReleaseDirectory) {
    $ReleaseDirectory = if ($Package -and [IO.Path]::IsPathRooted($Package)) {
        [IO.Path]::GetDirectoryName($Package)
    } else { (Get-Location).Path }
}
$root = [IO.Path]::GetFullPath($ReleaseDirectory).TrimEnd('\')
$encoding = [Text.UTF8Encoding]::new($false)
$checks = [Collections.Generic.List[object]]::new()

function Get-LocalFile([string]$Name) {
    if (-not $Name -or $Name -ne [IO.Path]::GetFileName($Name) -or
        $Name -match '[\r\n]' -or $Name -in @('.', '..')) {
        throw 'The checksum contains an unsafe filename.'
    }
    $file = [IO.Path]::GetFullPath((Join-Path $root $Name))
    if ([IO.Path]::GetDirectoryName($file) -ine $root) {
        throw 'The file is outside the release directory.'
    }
    $item = Get-Item -LiteralPath $file -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Release verification requires regular files, not links.'
    }
    return $item.FullName
}

function Get-SHA256([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $hash.Dispose()
        $stream.Dispose()
    }
}

try {
    if ($Package) {
        $selected = [IO.Path]::GetFullPath(
            $(if ([IO.Path]::IsPathRooted($Package)) { $Package }
              else { Join-Path $root $Package }))
        if ([IO.Path]::GetDirectoryName($selected) -ine $root -or
            [IO.Path]::GetExtension($selected) -ine '.exe') {
            throw 'Select a Setup EXE in the same directory as this script.'
        }
        $sidecar = [IO.Path]::GetFileName($selected) + '.sha256'
        $hasSidecar = Test-Path -LiteralPath (Join-Path $root $sidecar)
        $manifest = Get-LocalFile $(if ($hasSidecar) { $sidecar } else { 'SHA256SUMS.txt' })
    } else {
        $manifest = Get-LocalFile 'SHA256SUMS.txt'
    }
    $lines = [IO.File]::ReadAllLines($manifest, $encoding)
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($line in $lines) {
        if (-not $line.Trim()) { continue }
        if ($line -notmatch '^([a-fA-F0-9]{64})  (.+)$') {
            throw 'The checksum manifest contains a malformed record.'
        }
        $expected = $Matches[1].ToLowerInvariant()
        $name = $Matches[2]
        if (-not $seen.Add($name)) { throw 'The checksum manifest contains a duplicate filename.' }
        if ($Package -and $name -ine [IO.Path]::GetFileName($selected)) {
            if ($hasSidecar) { throw 'The sidecar checksum belongs to a different package.' }
            continue
        }
        $file = Get-LocalFile $name
        Write-Host ("[CHECK] " + $name) -ForegroundColor Cyan
        $actual = Get-SHA256 $file
        if ($actual -cne $expected) { throw ("SHA-256 mismatch: " + $name) }
        $checks.Add([pscustomobject]@{ File = $name; SHA256 = $actual; Passed = $true })
        Write-Host ("[PASS]  " + $name) -ForegroundColor Green
    }
    if ($checks.Count -lt 1) { throw 'The checksum manifest is empty.' }
    if ($Package -and $checks.Count -ne 1) {
        throw 'A package sidecar must describe exactly one file.'
    }
    Write-Host ''
    Write-Host ("Verified " + $checks.Count + ' file(s). No files or settings were changed.') -ForegroundColor Green
    Write-Host 'SHA-256 verifies integrity, not publisher identity or redistribution permission.'
    $checks
} catch {
    Write-Error $_
    exit 1
}
