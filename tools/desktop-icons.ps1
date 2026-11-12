param(
    [Parameter(Mandatory = $true)][string]$Instance,
    [Parameter(Mandatory = $true)][string]$HelperToken,
    [Parameter(Mandatory = $true)][int]$HelperPid,
    [switch]$InspectOnly,
    [switch]$ApplyPropertiesOnly,
    [string]$PreviewDirectory
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$install = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$profile = [IO.Path]::GetFullPath((Split-Path -Parent $Instance))
$iconFile = Join-Path $install 'assets\codex-copilot.ico'
$receipt = Get-Content -LiteralPath $Instance -Raw -Encoding UTF8 | ConvertFrom-Json
$instanceToken = $receipt.instanceToken
$release = Test-Path -LiteralPath (Join-Path $install 'release.json')
$appId = 'CodexCopilot.Desktop'
if ($release) {
    $installationRoot = [IO.Path]::GetFullPath([string](Get-Content -LiteralPath `
        (Join-Path $install 'release-install.json') -Raw | ConvertFrom-Json).installRoot)
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        $identity = [BitConverter]::ToString($hash.ComputeHash(
            [Text.Encoding]::UTF8.GetBytes($installationRoot.ToLowerInvariant()))).Replace('-','').Substring(0,12)
        $appId = 'CCodexRelease.Desktop.' + $identity
    } finally { $hash.Dispose() }
}

function Assert-Owners {
    $current = Get-Content -LiteralPath $Instance -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($current.schemaVersion -ne 2 -or $current.instanceToken -cne $instanceToken -or
        $current.helperToken -cne $HelperToken -or $current.helperPid -ne $HelperPid -or
        -not $current.installRoot.Equals($install, [StringComparison]::OrdinalIgnoreCase) -or
        -not $current.profile.Equals($profile, [StringComparison]::OrdinalIgnoreCase) -or
        -not $current.userData.Equals((Join-Path $profile 'desktop-data'), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Private Desktop icon ownership changed.'
    }
    foreach ($identity in @($receipt.identity, $receipt.helperIdentity)) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($identity.pid)"
        if ($null -eq $process -or -not $process.ExecutablePath -or
            -not $process.ExecutablePath.Equals($identity.executable, [StringComparison]::OrdinalIgnoreCase) -or
            ('windows:' + $process.CreationDate.ToUniversalTime().Ticks) -cne $identity.lifetime) {
            throw 'Private Desktop or helper lifetime ended.'
        }
    }
    $pattern = "^\s*TCP\s+127\.0\.0\.1:$($receipt.debugPort)\s+\S+\s+LISTENING\s+(\d+)\s*$"
    $owners = @(& "$env:SystemRoot\System32\netstat.exe" -ano -p tcp |
        ForEach-Object { if ($_ -match $pattern) { [int]$Matches[1] } } |
        Sort-Object -Unique)
    if ($owners.Count -ne 1 -or $owners[0] -ne $receipt.pid) {
        throw 'Private Desktop endpoint ownership changed.'
    }
}

# Load Windows' existing interop assembly; no C# compilation or binary output.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName PresentationFramework
$assembly = [System.Windows.Forms.Form].Assembly
$flags = [Reflection.BindingFlags]'Public,NonPublic,Static'
$unsafe = $assembly.GetType('System.Windows.Forms.UnsafeNativeMethods', $true)
$safe = $assembly.GetType('System.Windows.Forms.SafeNativeMethods', $true)
$send = $unsafe.GetMethod('SendMessageTimeout', $flags)
$windowPid = $safe.GetMethod('GetWindowThreadProcessId', $flags)
$visible = $safe.GetMethod('IsWindowVisible', $flags)
$enumerate = $safe.GetMethod('EnumWindows', $flags)
if ($null -eq $send -or $null -eq $windowPid -or $null -eq $visible -or $null -eq $enumerate) {
    throw 'Windows icon interop is unavailable.'
}
$shellModule = $unsafe.GetMethod('LoadLibrary', $flags).Invoke($null, [object[]]@(
    [string](Join-Path $env:SystemRoot 'System32\shell32.dll')))
$shellReference = [Runtime.InteropServices.HandleRef]::new($null, $shellModule)
$storeAddress = $unsafe.GetMethod('GetProcAddress', $flags).Invoke($null, [object[]]@(
    $shellReference, [string]'SHGetPropertyStoreForWindow'))
if ($storeAddress -eq [IntPtr]::Zero) { throw 'Windows window-property interop is unavailable.' }
$storeSignature = [Linq.Expressions.Expression]::GetDelegateType([type[]]@(
    [IntPtr], [Guid].MakeByRefType(), [IntPtr].MakeByRefType(), [int]))
$getWindowStore = [Runtime.InteropServices.Marshal]::GetDelegateForFunctionPointer(
    $storeAddress, $storeSignature)
$propertyStore = [Windows.Application].Assembly.GetType('Standard.IPropertyStore', $true)
$getProperty = $propertyStore.GetMethod('GetValue')
$setProperty = $propertyStore.GetMethod('SetValue')
$variantType = $getProperty.GetParameters()[1].ParameterType
$keyType = $getProperty.GetParameters()[0].ParameterType.GetElementType()
$taskbarValues = [ordered]@{
    AppUserModel_RelaunchIconResource = [string]($iconFile + ',0')
    AppUserModel_RelaunchCommand = [string]('"' + $(if ($release) {
        Join-Path $installationRoot 'bin\Ccodex Desktop.exe'
    } else { Join-Path $install 'bin\codex-copilot-desktop.exe' }) + '"')
    AppUserModel_RelaunchDisplayNameResource = $(if ($release) { 'Ccodex Desktop' } else { 'Ccodex Dev Desktop' })
    AppUserModel_ID = $appId
}

function Get-WindowProperties([IntPtr]$Window, [switch]$Apply) {
    if (-not (Test-WindowOwner $Window)) { throw 'Window property ownership changed.' }
    $arguments = [object[]]@($Window,
        [Guid]'886d8eeb-8cf2-4446-8d02-cdba1dbdcf99', [IntPtr]::Zero)
    $result = $getWindowStore.DynamicInvoke($arguments)
    if ($result -ne 0) { [Runtime.InteropServices.Marshal]::ThrowExceptionForHR($result) }
    $pointer = [IntPtr]$arguments[2]
    if ($pointer -eq [IntPtr]::Zero) { throw 'The window property store is unavailable.' }
    $storeObject = [Runtime.InteropServices.Marshal]::GetObjectForIUnknown($pointer)
    [void][Runtime.InteropServices.Marshal]::Release($pointer)
    $values = [ordered]@{}
    try {
        foreach ($name in $taskbarValues.Keys) {
            $key = $keyType.GetField($name).GetValue($null)
            $variant = [Activator]::CreateInstance($variantType, $true)
            try {
                $null = $getProperty.Invoke($storeObject, [object[]]@($key, $variant))
                $before = $variant.GetValue()
                if ($Apply -and $before -cne $taskbarValues[$name]) {
                    if ($name -eq 'AppUserModel_ID' -and $before -and
                        $before -cnotin @('com.openai.codex', 'CodexCopilot.Desktop')) {
                        throw 'The private window has an unrelated application identity.'
                    }
                    if (-not (Test-WindowOwner $Window)) { throw 'Window ownership changed before property update.' }
                    $variant.SetValue([string]$taskbarValues[$name])
                    $null = $setProperty.Invoke($storeObject, [object[]]@($key, $variant))
                    $variant.Clear()
                    $null = $getProperty.Invoke($storeObject, [object[]]@($key, $variant))
                }
                $values[$name] = $variant.GetValue()
                if ($Apply -and $values[$name] -cne $taskbarValues[$name]) {
                    throw 'The window taskbar property did not retain its canonical value.'
                }
            } finally { $variant.Dispose() }
        }
        return [pscustomobject]$values
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($storeObject) }
}

function Test-WindowOwner([IntPtr]$Window) {
    $reference = [Runtime.InteropServices.HandleRef]::new($null, $Window)
    $arguments = [object[]]@($reference, [int]0)
    $null = $windowPid.Invoke($null, $arguments)
    return $arguments[1] -eq $receipt.pid
}

function Send-IconMessage([IntPtr]$Window, [int]$Message, [int]$Size, [IntPtr]$Icon) {
    if (-not (Test-WindowOwner $Window)) { throw 'Window ownership changed.' }
    $reference = [Runtime.InteropServices.HandleRef]::new($null, $Window)
    $arguments = [object[]]@($reference, $Message, [IntPtr]$Size, $Icon, [int]2, [int]1000, [IntPtr]::Zero)
    if ($send.Invoke($null, $arguments) -eq [IntPtr]::Zero) {
        throw 'Private Desktop window did not answer the icon message.'
    }
    return [IntPtr]$arguments[6]
}

function Get-OwnedWindows {
    $windows = [Collections.Generic.List[IntPtr]]::new()
    $callback = {
        param([IntPtr]$window, [IntPtr]$state)
        $reference = [Runtime.InteropServices.HandleRef]::new($null, $window)
        if ((Test-WindowOwner $window) -and $visible.Invoke($null, [object[]]@($reference))) {
            $windows.Add($window)
        }
        return $true
    }
    $delegate = [Management.Automation.LanguagePrimitives]::ConvertTo(
        $callback, $enumerate.GetParameters()[0].ParameterType)
    if (-not $enumerate.Invoke($null, [object[]]@($delegate, [IntPtr]::Zero))) {
        throw 'Private Desktop windows could not be enumerated.'
    }
    return $windows.ToArray()
}

$small = $null
$large = $null
$assigned = [Collections.Generic.HashSet[IntPtr]]::new()
try {
    Assert-Owners
    if ($ApplyPropertiesOnly) {
        $windows = @(
            foreach ($window in @(Get-OwnedWindows)) {
                [pscustomobject]@{ hwnd = $window.ToInt64(); properties = Get-WindowProperties $window -Apply }
            }
        )
        [pscustomobject]@{ desktopPid = $receipt.pid; windows = $windows; iconFile = $iconFile } |
            ConvertTo-Json -Depth 5 -Compress
        return
    }
    if ($InspectOnly) {
        $windows = @(
            foreach ($window in @(Get-OwnedWindows)) {
                [pscustomobject]@{
                    hwnd = $window.ToInt64()
                    small = (Send-IconMessage $window 0x7f 0 ([IntPtr]::Zero)).ToInt64()
                    large = (Send-IconMessage $window 0x7f 1 ([IntPtr]::Zero)).ToInt64()
                    properties = Get-WindowProperties $window
                }
            }
        )
        if ($PreviewDirectory -and $windows.Count) {
            $destination = (Resolve-Path -LiteralPath $PreviewDirectory).ProviderPath
            foreach ($kind in @('small', 'large')) {
                $handle = [IntPtr]$windows[0].$kind
                if ($handle -eq [IntPtr]::Zero) { continue }
                $image = [Drawing.Icon]::FromHandle($handle).ToBitmap()
                try {
                    $image.Save((Join-Path $destination "desktop-window-icon-$kind.png"),
                        [Drawing.Imaging.ImageFormat]::Png)
                } finally { $image.Dispose() }
            }
        }
        [pscustomobject]@{ desktopPid = $receipt.pid; windows = $windows; iconFile = $iconFile } |
            ConvertTo-Json -Depth 4 -Compress
        return
    }

    $small = [Drawing.Icon]::new($iconFile, 32, 32)
    $large = [Drawing.Icon]::new($iconFile, 256, 256)
    $stream = [IO.File]::OpenRead($iconFile)
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        $iconHash = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '')
    } finally {
        $stream.Dispose()
        $hash.Dispose()
    }
    $inputReader = [IO.StreamReader]::new([Console]::OpenStandardInput())
    $stopRequest = $inputReader.ReadLineAsync()
    $lastSummary = ''
    while (-not $stopRequest.IsCompleted) {
        Assert-Owners
        $verified = @(
            foreach ($window in @(Get-OwnedWindows)) {
                $changed = $false
                foreach ($entry in @(
                    @{ size = 0; icon = $small.Handle },
                    @{ size = 1; icon = $large.Handle }
                )) {
                    $current = Send-IconMessage $window 0x7f $entry.size ([IntPtr]::Zero)
                    if ($current -ne $entry.icon) {
                        $null = Send-IconMessage $window 0x80 $entry.size $entry.icon
                        $null = $assigned.Add($window)
                        $changed = $true
                    }
                    if ((Send-IconMessage $window 0x7f $entry.size ([IntPtr]::Zero)) -ne $entry.icon) {
                        throw 'Private Desktop did not retain the canonical window icon.'
                    }
                }
                $properties = Get-WindowProperties $window -Apply
                [pscustomobject]@{ hwnd = $window.ToInt64(); canonical = $true; properties = $properties }
            }
        )
        $summary = ($verified | ConvertTo-Json -Compress)
        if ($summary -cne $lastSummary) {
            $lastSummary = $summary
            $status = [ordered]@{
                checkedAt = [DateTime]::UtcNow.ToString('o')
                desktopPid = $receipt.pid
                helperPid = $HelperPid
                workerPid = $PID
                desktopLifetime = $receipt.identity.lifetime
                iconFile = $iconFile
                iconSha256 = $iconHash
                windows = $verified
                originalBinaryModified = $false
                binaryBuilds = 0
            }
            $status | ConvertTo-Json -Depth 6 |
                Set-Content -LiteralPath (Join-Path $profile 'desktop-icon-status.json') -Encoding UTF8
            [Console]::Out.WriteLine(($status | ConvertTo-Json -Depth 6 -Compress))
        }
        Start-Sleep -Milliseconds 2000
    }
} finally {
    # Do not leave a window pointing at an icon handle owned by an exiting worker.
    $sameDesktop = $false
    if ($assigned.Count) {
        try {
            $desktop = Get-CimInstance Win32_Process -Filter "ProcessId = $($receipt.pid)"
            $sameDesktop = $null -ne $desktop -and $desktop.ExecutablePath -and
                $desktop.ExecutablePath.Equals($receipt.identity.executable, [StringComparison]::OrdinalIgnoreCase) -and
                ('windows:' + $desktop.CreationDate.ToUniversalTime().Ticks) -ceq $receipt.identity.lifetime
        } catch { }
    }
    foreach ($window in $(if ($sameDesktop) { $assigned } else { @() })) {
        try {
            if (-not (Test-WindowOwner $window)) { continue }
            foreach ($entry in @(
                @{ size = 0; icon = $small.Handle },
                @{ size = 1; icon = $large.Handle }
            )) {
                if ((Send-IconMessage $window 0x7f $entry.size ([IntPtr]::Zero)) -eq $entry.icon) {
                    $null = Send-IconMessage $window 0x80 $entry.size ([IntPtr]::Zero)
                }
            }
        } catch { }
    }
    if ($small) { $small.Dispose() }
    if ($large) { $large.Dispose() }
}
