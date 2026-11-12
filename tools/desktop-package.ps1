function Expand-IndependentDesktopPackage {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Package,
        [Parameter(Mandatory)][string]$Destination,
        [long]$MaximumBytes = 8589934592,
        [int]$MaximumFiles = 20000
    )
    $ErrorActionPreference = 'Stop'
    $archivePath = (Resolve-Path -LiteralPath $Package).ProviderPath
    $root = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
    if (Test-Path -LiteralPath $root) {
        throw 'Desktop package extraction requires a new owned directory.'
    }
    $parent = Split-Path -Parent $root
    if (-not (Test-Path -LiteralPath $parent -PathType Container) -or
        (Get-Item -LiteralPath $parent -Force).LinkType) {
        throw 'Desktop package staging parent is missing or linked.'
    }
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $entries = @()
        $total = 0L
        foreach ($entry in $archive.Entries) {
            if ($entries.Count -ge $MaximumFiles) { throw 'Desktop package contains too many entries.' }
            $name = $entry.FullName
            if ($name -match '^[\\/]|^[A-Za-z]:|:' -or
                $name.Split(@('/','\')).Where({ $_ -eq '..' }).Count -or
                $name.IndexOf([char]0) -ge 0) {
                throw "Unsafe Desktop package entry: $name"
            }
            $target = [IO.Path]::GetFullPath((Join-Path $root $name.Replace('/', '\')))
            if (-not $target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Desktop package entry escaped its destination.'
            }
            $mode = ($entry.ExternalAttributes -shr 16) -band 0xf000
            if ($mode -eq 0xa000) { throw 'Desktop package symbolic links are unsupported.' }
            if (-not $paths.Add($target.TrimEnd('\'))) { throw 'Desktop package has duplicate paths.' }
            if ($entry.Length -lt 0 -or $entry.Length -gt $MaximumBytes -or
                $total -gt ($MaximumBytes - $entry.Length)) {
                throw 'Desktop package exceeds the extraction size limit.'
            }
            $total += $entry.Length
            $entries += [pscustomobject]@{
                Entry = $entry; Target = $target
                Directory = $name.EndsWith('/') -or $name.EndsWith('\')
            }
        }
        # Validate every entry before writing anything. A bad archive must not
        # leave a partly extracted official executable behind.
        New-Item -ItemType Directory -Path $root | Out-Null
        foreach ($item in $entries) {
            if ($item.Directory) {
                New-Item -ItemType Directory -Path $item.Target -Force | Out-Null
                continue
            }
            New-Item -ItemType Directory -Path (Split-Path -Parent $item.Target) -Force | Out-Null
            $entryStream = $item.Entry.Open()
            $targetStream = [IO.File]::Open($item.Target, [IO.FileMode]::CreateNew)
            try {
                $buffer = [byte[]]::new(1048576)
                $written = 0L
                while (($count = $entryStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $written += $count
                    if ($written -gt $item.Entry.Length) { throw 'Desktop package entry length changed while extracting.' }
                    $targetStream.Write($buffer, 0, $count)
                }
                if ($written -ne $item.Entry.Length) { throw 'Truncated Desktop package entry.' }
            } finally { $targetStream.Dispose(); $entryStream.Dispose() }
        }
        [pscustomobject]@{ Root = $root; Files = $entries.Count; Bytes = $total }
    } finally { $archive.Dispose() }
}

function Test-IndependentDesktopPackageSignature {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Package)
    $signature = Get-AuthenticodeSignature -LiteralPath $Package
    if ($signature.Status -eq 'Valid') {
        return [pscustomobject]@{
            Valid = $true
            Signer = $signature.SignerCertificate.Subject
            Method = 'Authenticode'
        }
    }
    $kits = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' `
        -ErrorAction SilentlyContinue).KitsRoot10
    $signtool = if ($kits) { Get-ChildItem (Join-Path $kits 'bin') `
        -Filter signtool.exe -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Directory.Name -eq [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant() } |
        Sort-Object FullName -Descending | Select-Object -First 1 }
    if (-not $signtool) { throw 'The package signature could not be verified; no update was extracted or selected.' }
    & $signtool.FullName verify /pa $Package | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Official Desktop package signature validation failed.' }
    [pscustomobject]@{ Valid = $true; Signer = $null; Method = 'Windows SDK SignTool' }
}
