param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$install = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$name = if (Test-Path -LiteralPath (Join-Path $install '.ccodex-dev-install.json')) { 'Ccodex Dev Desktop' } else { 'Codex (Copilot)' }
$linkFile = [string](Join-Path ([Environment]::GetFolderPath('Programs')) ($name + '.lnk'))
$launcher = Join-Path $install 'bin\codex-copilot-desktop.exe'
$iconFile = Join-Path $install 'assets\codex-copilot.ico'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkFile)
if (-not (Test-Path -LiteralPath $linkFile) -or
    -not $shortcut.TargetPath.Equals($launcher, [StringComparison]::OrdinalIgnoreCase) -or
    -not $shortcut.IconLocation.Equals($iconFile + ',0', [StringComparison]::OrdinalIgnoreCase) -or
    $shortcut.Arguments) {
    throw 'The canonical Desktop shortcut was changed; no unrelated shortcut was modified.'
}
Add-Type -AssemblyName PresentationFramework
$assembly = [Windows.Application].Assembly
$persist = $assembly.GetType('MS.Internal.Interop.IPersistFile', $true)
$store = $assembly.GetType('Standard.IPropertyStore', $true)
$get = $store.GetMethod('GetValue')
$variantType = $get.GetParameters()[1].ParameterType
$keyType = $get.GetParameters()[0].ParameterType.GetElementType()
$key = $keyType.GetField('AppUserModel_ID').GetValue($null)
$link = [Activator]::CreateInstance([Type]::GetTypeFromCLSID(
    [Guid]'00021401-0000-0000-C000-000000000046'))
try {
    $null = $persist.GetMethod('Load').Invoke($link, [object[]]@([string]$linkFile, [int]2))
    $variant = [Activator]::CreateInstance($variantType, $true)
    try {
        $null = $get.Invoke($link, [object[]]@($key, $variant))
        $before = $variant.GetValue()
    } finally { $variant.Dispose() }
    if ($before -and $before -cnotin @('com.openai.codex', 'CodexCopilot.Desktop')) {
        throw 'The shortcut has a different application identity; it was not replaced.'
    }
    if ($Apply -and $before -cne 'CodexCopilot.Desktop') {
        $variant = [Activator]::CreateInstance($variantType, $true)
        try {
            $variant.SetValue('CodexCopilot.Desktop')
            $null = $store.GetMethod('SetValue').Invoke($link, [object[]]@($key, $variant))
            $null = $store.GetMethod('Commit').Invoke($link, @())
            $null = $persist.GetMethod('Save').Invoke($link, [object[]]@([string]$linkFile, $true))
        } finally { $variant.Dispose() }
    }
    $variant = [Activator]::CreateInstance($variantType, $true)
    try {
        $null = $get.Invoke($link, [object[]]@($key, $variant))
        $after = $variant.GetValue()
    } finally { $variant.Dispose() }
    [pscustomobject]@{
        path = $linkFile
        before = $before
        after = $after
        applied = [bool]$Apply
        target = $shortcut.TargetPath
        icon = $shortcut.IconLocation
    } | ConvertTo-Json -Depth 3
} finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
