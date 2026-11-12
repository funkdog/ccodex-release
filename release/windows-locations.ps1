function Get-CCodexShellFolder([string]$Name) {
    $kind = [Environment+SpecialFolder]::$Name
    $value = [Environment]::GetFolderPath($kind, [Environment+SpecialFolderOption]::DoNotVerify)
    if ([string]::IsNullOrWhiteSpace($value)) {
        if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
            throw 'Windows roaming AppData is unavailable; shortcut locations cannot be resolved safely.'
        }
        $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
        $value = switch ($Name) {
            'Programs' { $programs }
            'Startup' { Join-Path $programs 'Startup' }
            default { throw 'Unsupported release shortcut location.' }
        }
    }
    [IO.Path]::GetFullPath($value)
}
