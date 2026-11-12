<#
.SYNOPSIS
    Builds a multi-resolution .ico from the Codex package's own app icon assets.

.DESCRIPTION
    The MSIX package ships one PNG per icon size under `Square44x44Logo.targetsize-N_altform-*`.
    Windows uses exactly those files - as-is, on a transparent background - for the Start menu,
    search results and the taskbar, which is why the stock app shows a plain glyph rather than a
    coloured tile. Reproducing that means copying each size verbatim instead of rescaling one
    large asset or compositing it onto the manifest's tile colour, both of which produce an icon
    that does not match the app.

    `unplated` is the light-on-dark glyph Windows picks for dark surfaces (the default for the
    taskbar and Start menu); `lightunplated` is its dark-on-light counterpart.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [string]$PackageName = 'OpenAI.Codex',
    [string]$AssetsPath,
    [ValidateSet('unplated', 'lightunplated')][string]$Variant = 'unplated'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$assets = $AssetsPath
if (-not $assets) {
    $package = Get-AppxPackage $PackageName | Select-Object -First 1
    if (-not $package) { throw "The $PackageName package is not installed and no AssetsPath was supplied." }
    $assets = Join-Path $package.InstallLocation 'assets'
}
if (-not (Test-Path $assets)) { throw "Could not find app assets under $assets" }

# Every size the package ships a dedicated, individually hinted glyph for.
$available = Get-ChildItem $assets -Filter "Square44x44Logo.targetsize-*_altform-$Variant.png" |
    ForEach-Object {
        if ($_.Name -match 'targetsize-(\d+)_') { [PSCustomObject]@{ Size = [int]$Matches[1]; Path = $_.FullName } }
    } | Sort-Object Size
if (-not $available) { throw "The package ships no '$Variant' icon assets." }

function Resolve-Asset {
    param([int]$Size)
    # Prefer the exact glyph; otherwise the smallest one above it so downscaling stays crisp.
    $exact = $available | Where-Object { $_.Size -eq $Size } | Select-Object -First 1
    if ($exact) { return $exact }
    $larger = $available | Where-Object { $_.Size -gt $Size } | Select-Object -First 1
    if ($larger) { return $larger }
    return $available[-1]
}

$sizes = 16, 20, 24, 32, 40, 48, 64, 96, 256
$images = @()

foreach ($size in $sizes) {
    $asset = Resolve-Asset -Size $size
    $source = [System.Drawing.Image]::FromFile($asset.Path)
    try {
        if ($asset.Size -eq $size -and $source.Width -eq $size -and $source.Height -eq $size) {
            # Use the packaged glyph byte for byte.
            $images += [PSCustomObject]@{ Size = $size; Bytes = [System.IO.File]::ReadAllBytes($asset.Path) }
            continue
        }

        $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
            $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.DrawImage($source, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
        } finally {
            $g.Dispose()
        }

        $stream = New-Object System.IO.MemoryStream
        $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $images += [PSCustomObject]@{ Size = $size; Bytes = $stream.ToArray() }
        $stream.Dispose()
        $bmp.Dispose()
    } finally {
        $source.Dispose()
    }
}

# ICO container: 6-byte ICONDIR + 16-byte ICONDIRENTRY per image + PNG payloads.
$out = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($out)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$images.Count)

$offset = 6 + (16 * $images.Count)
foreach ($image in $images) {
    $dim = if ($image.Size -ge 256) { 0 } else { $image.Size }
    $writer.Write([Byte]$dim)
    $writer.Write([Byte]$dim)
    $writer.Write([Byte]0)
    $writer.Write([Byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$image.Bytes.Length)
    $writer.Write([UInt32]$offset)
    $offset += $image.Bytes.Length
}
foreach ($image in $images) { $writer.Write($image.Bytes) }
$writer.Flush()

$directory = Split-Path -Parent $OutputPath
if ($directory -and -not (Test-Path $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
[System.IO.File]::WriteAllBytes($OutputPath, $out.ToArray())
$writer.Dispose()
$out.Dispose()

Write-Output "Wrote $OutputPath ($($images.Count) sizes, $Variant glyph)"
