function Register-CcodexCommand([string]$Bin) {
    $current = [Environment]::GetEnvironmentVariable('Path','User')
    $parts = @($current -split ';' | Where-Object { $_ })
    $already = @($parts | Where-Object {
        $_.TrimEnd('\').Equals($Bin.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0
    if ($already) { return $false }
    $other = Get-Command ccodex -CommandType Application,ExternalScript -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($other -and -not $other.Source.StartsWith($Bin + '\',[StringComparison]::OrdinalIgnoreCase)) {
        Write-Warning 'Another ccodex command exists. It was not replaced. The Ccodex CLI shortcut selects this installation explicitly.'
        return $false
    }
    [Environment]::SetEnvironmentVariable('Path',($Bin + ';' + $current),'User')
    return $true
}

function Unregister-CcodexCommand([string]$Bin) {
    $current = [Environment]::GetEnvironmentVariable('Path','User')
    $remaining = @($current -split ';' | Where-Object {
        -not $_.TrimEnd('\').Equals($Bin.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)
    })
    if (($remaining -join ';') -cne $current) {
        [Environment]::SetEnvironmentVariable('Path',($remaining -join ';'),'User')
    }
}
