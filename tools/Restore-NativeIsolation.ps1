[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexCopilot'),
    [string]$CopilotHome = (Join-Path $env:USERPROFILE '.codex-copilot'),
    [string]$StockHome = (Join-Path $env:USERPROFILE '.codex'),
    [string]$StockCliPath,
    [string]$ReportDirectory,
    [switch]$Apply,
    [switch]$RestoreStockCommand,
    [switch]$StopLegacyDesktopHelper
)

$ErrorActionPreference = 'Stop'
$install = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$profile = [IO.Path]::GetFullPath($CopilotHome).TrimEnd('\')
$stock = [IO.Path]::GetFullPath($StockHome).TrimEnd('\')
if ($profile.Equals($stock, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The stock and Copilot profiles must be different directories.'
}

function Test-SameIsolationPath([string]$First, [string]$Second) {
    if ([string]::IsNullOrWhiteSpace($First)) { return $false }
    try {
        return [IO.Path]::GetFullPath($First).TrimEnd('\').Equals(
            [IO.Path]::GetFullPath($Second).TrimEnd('\'),
            [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function Test-OwnedIsolationVariable([string]$Name, [string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    switch ($Name) {
        'CODEX_HOME' { return Test-SameIsolationPath $Value $profile }
        'CODEX_CLI_PATH' {
            try {
                $path = [IO.Path]::GetFullPath($Value)
                return $path.StartsWith(
                    (Join-Path $install 'bin') + '\',
                    [StringComparison]::OrdinalIgnoreCase) -and
                    [IO.Path]::GetFileName($path) -like 'codex-copilot-core*.exe'
            } catch { return $false }
        }
        'CODEX_COPILOT_CATALOG_FILE' {
            return (Test-SameIsolationPath $Value (Join-Path $profile 'models.json')) -or
                (Test-SameIsolationPath $Value (Join-Path $profile 'models-desktop.json'))
        }
        'CODEX_COPILOT_SELECTION_FILE' {
            return Test-SameIsolationPath $Value (Join-Path $profile 'selection-generation.json')
        }
        default { return $false }
    }
}

function Remove-OwnedIsolationEnvironmentValues(
    [object]$EnvironmentKey, [object[]]$Records, [string]$BackupPath
) {
    $allowedNames = @('CODEX_HOME', 'CODEX_CLI_PATH', 'CODEX_COPILOT_CATALOG_FILE', 'CODEX_COPILOT_SELECTION_FILE')
    foreach ($record in $Records | Where-Object owned) {
        if ($record.name -notin $allowedNames -or [string]::IsNullOrWhiteSpace($record.value)) {
            throw "Refusing an unverified isolation environment value: $($record.name)."
        }
        $current = $EnvironmentKey.GetValue(
            $record.name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($current -cne $record.value) {
            throw "User environment changed during isolation repair: $($record.name). Backup: $BackupPath"
        }
        # PowerShell can bind $null to a String parameter as "". On modern
        # .NET that stores an empty environment variable instead of deleting
        # it. Delete the exact previously verified registry value directly.
        $EnvironmentKey.DeleteValue($record.name, $false)
        if ($EnvironmentKey.GetValueNames() -contains $record.name) {
            throw "User environment was recreated during isolation repair: $($record.name). Backup: $BackupPath"
        }
        Write-Host ("  已移除全局残留：{0}；原值已备份。" -f $record.name) -ForegroundColor Cyan
        Write-Output $record.name
    }
}

function Find-LegacyStockDesktopHelper(
    [object[]]$Processes, [object[]]$Listeners,
    [string[]]$StockDesktopPaths, [string]$HelperScript
) {
    foreach ($helper in $Processes) {
        if ($helper.Name -ne 'node.exe' -or -not $helper.ExecutablePath) { continue }
        $exe = [regex]::Escape([string]$helper.ExecutablePath)
        $script = [regex]::Escape($HelperScript)
        $pattern = '^(?:"' + $exe + '"|' + $exe + ')\s+(?:"' + $script + '"|' + $script + ')\s+(?<port>\d{4,5})\s*$'
        $match = [regex]::Match([string]$helper.CommandLine, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if (-not $match.Success) { continue }
        $port = [int]$match.Groups['port'].Value
        if ($port -lt 1024 -or $port -gt 65535) { continue }
        $owners = @($Listeners | Where-Object {
            $_.LocalPort -eq $port -and $_.LocalAddress -in @('127.0.0.1', '::1')
        } | Select-Object -ExpandProperty OwningProcess -Unique)
        if ($owners.Count -ne 1) { continue }
        $desktop = @($Processes | Where-Object {
            $_.ProcessId -eq $owners[0] -and $_.Name -eq 'ChatGPT.exe'
        })
        if ($desktop.Count -ne 1 -or -not $desktop[0].CreationDate -or -not $helper.CreationDate) { continue }
        $desktop = $desktop[0]
        if (-not @($StockDesktopPaths | Where-Object {
            Test-SameIsolationPath $_ $desktop.ExecutablePath
        }).Count -or
            $desktop.CommandLine -match '(?i)--user-data-dir(?:=|\s)' -or
            $desktop.CommandLine -notmatch ('(?i)(?:^|\s)--remote-debugging-port=' + $port + '(?:\s|$)')) {
            continue
        }
        [pscustomobject]@{
            helperPid = [int]$helper.ProcessId
            helperCreatedAt = $helper.CreationDate
            helperExecutable = $helper.ExecutablePath
            helperCommandLine = $helper.CommandLine
            desktopPid = [int]$desktop.ProcessId
            desktopCreatedAt = $desktop.CreationDate
            desktopExecutable = $desktop.ExecutablePath
            desktopCommandLine = $desktop.CommandLine
            debugPort = $port
        }
    }
}

if ($StopLegacyDesktopHelper -and (-not $Apply -or [string]::IsNullOrWhiteSpace($ReportDirectory))) {
    throw 'Stopping a verified legacy helper requires Apply and an explicit ReportDirectory.'
}

$names = @('CODEX_HOME', 'CODEX_CLI_PATH', 'CODEX_COPILOT_CATALOG_FILE', 'CODEX_COPILOT_SELECTION_FILE')
$stockConfig = Join-Path $stock 'config.toml'
$stockHash = if (Test-Path -LiteralPath $stockConfig -PathType Leaf) {
    (Get-FileHash -LiteralPath $stockConfig -Algorithm SHA256).Hash
} else { $null }
$records = foreach ($name in $names) {
    $value = [Environment]::GetEnvironmentVariable($name, 'User')
    [ordered]@{ name = $name; value = $value; owned = Test-OwnedIsolationVariable $name $value }
}
$running = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('ChatGPT.exe', 'Codex.exe', 'codex-copilot-core.exe')
} | ForEach-Object {
    [ordered]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; image = $_.ExecutablePath }
})
$report = [ordered]@{
    schemaVersion = 1
    checkedAt = (Get-Date).ToString('o')
    applied = [bool]$Apply
    stockHome = $stock
    copilotHome = $profile
    registryBefore = @($records)
    removed = @()
    stockConfigSha256Before = $stockHash
    processesStopped = @()
    runningProcesses = $running
    existingProcessesRequireFreshLaunch = $false
    stoppedLegacyDesktopHelpers = @()
    nativeDesktopProcessesStopped = @()
    nativeDesktopUiAcceptance = $false
}
if ($StopLegacyDesktopHelper) {
    $stockDesktopPaths = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop |
        Where-Object { $_.PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0' -and $_.Status -eq 0 } |
        ForEach-Object { Join-Path $_.InstallLocation 'app\ChatGPT.exe' })
    if (-not $stockDesktopPaths.Count) { throw 'The actual official Desktop package could not be identified.' }
    $helperScript = Join-Path $install 'bridge\desktop-patch.mjs'
    if (-not (Test-Path -LiteralPath $helperScript -PathType Leaf) -or
        (Get-Item -LiteralPath $helperScript -Force).LinkType) {
        throw 'The legacy helper source must be a regular file in the enhanced installation.'
    }
    $helperHash = (Get-FileHash -LiteralPath $helperScript).Hash
    $findings = @(Find-LegacyStockDesktopHelper @(Get-CimInstance Win32_Process) `
        @(Get-NetTCPConnection -State Listen -ErrorAction Stop) $stockDesktopPaths $helperScript)
    New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
    $saved = Join-Path $ReportDirectory ('legacy-stock-helper-before-' + [guid]::NewGuid().ToString('N') + '.json')
    $findings | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $saved -Encoding utf8
    $report.legacyDesktopHelperBackup = $saved
    foreach ($finding in $findings) {
        $fresh = @(Find-LegacyStockDesktopHelper @(Get-CimInstance Win32_Process) `
            @(Get-NetTCPConnection -State Listen -ErrorAction Stop) $stockDesktopPaths $helperScript |
            Where-Object helperPid -eq $finding.helperPid)
        if ($fresh.Count -ne 1 -or
            ($fresh[0] | ConvertTo-Json -Compress) -cne ($finding | ConvertTo-Json -Compress) -or
            (Get-FileHash -LiteralPath $helperScript).Hash -cne $helperHash) {
            throw 'The legacy helper or native Desktop lifetime changed; no process was stopped.'
        }
        $ownedHelper = Get-Process -Id $finding.helperPid -ErrorAction Stop
        [void]$ownedHelper.Handle
        $created = ([datetime]$finding.helperCreatedAt).ToUniversalTime()
        if ([Math]::Abs(($ownedHelper.StartTime.ToUniversalTime() - $created).TotalMilliseconds) -gt 1) {
            $ownedHelper.Dispose()
            throw 'The helper PID was reused; the replacement process was not stopped.'
        }
        # Stop only the old enhancement process, never the native Desktop or CLI.
        try { Stop-Process -InputObject $ownedHelper -ErrorAction Stop }
        finally { $ownedHelper.Dispose() }
        $report.processesStopped += $finding.helperPid
        $report.stoppedLegacyDesktopHelpers += $finding
        $report.existingProcessesRequireFreshLaunch = $true
    }
}
if ($RestoreStockCommand) {
    if (-not $Apply -or [string]::IsNullOrWhiteSpace($ReportDirectory) -or
        [string]::IsNullOrWhiteSpace($StockCliPath)) {
        throw 'Restoring the stock command requires Apply, ReportDirectory and the verified official StockCliPath.'
    }
    $official = [IO.Path]::GetFullPath($StockCliPath)
    if ([IO.Path]::GetFileName($official) -ne 'codex.exe' -or
        $official.StartsWith($install + '\', [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $official -PathType Leaf) -or
        (Get-Item -LiteralPath $official -Force).LinkType) {
        throw 'StockCliPath must be an existing official codex.exe outside the enhanced installation.'
    }
    $report.stockCliPath = $official
    $report.stockCliSha256Before = (Get-FileHash -LiteralPath $official -Algorithm SHA256).Hash
}
$backup = $null
if ($Apply -and @($records | Where-Object owned).Count) {
    if ([string]::IsNullOrWhiteSpace($ReportDirectory)) {
        throw 'An explicit ReportDirectory is required to preserve the reversible registry backup.'
    }
    $reportRoot = [IO.Path]::GetFullPath($ReportDirectory).TrimEnd('\')
    if ($reportRoot -eq [IO.Path]::GetPathRoot($reportRoot).TrimEnd('\') -or
        (Test-Path -LiteralPath $reportRoot -PathType Leaf) -or
        ((Test-Path -LiteralPath $reportRoot) -and (Get-Item -LiteralPath $reportRoot -Force).LinkType)) {
        throw 'Unsafe isolation report directory.'
    }
    New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
    $backup = Join-Path $reportRoot ('user-environment-before-' + [guid]::NewGuid().ToString('N') + '.json')
    [IO.File]::WriteAllText($backup, ($report | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    $report.backup = $backup
    $isolationEnvironmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
        $report.removed += @(Remove-OwnedIsolationEnvironmentValues $isolationEnvironmentKey $records $backup)
    } finally { $isolationEnvironmentKey.Close() }
    $report.existingProcessesRequireFreshLaunch = $true
}
if ($RestoreStockCommand) {
    New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
    $shadow = Join-Path $install 'bin\codex.cmd'
    if (Test-Path -LiteralPath $shadow) {
        if ((Get-Item -LiteralPath $shadow -Force).LinkType) {
            throw 'Refusing a linked stock-command shadow.'
        }
        $text = Get-Content -LiteralPath $shadow -Raw
        if ($text -notmatch 'Forward the stock codex command to the official CLI' -or
            $text -notmatch 'codex-cli-path\.txt' -or
            $text -notmatch '"%STOCK_CODEX%" %\*') {
            throw 'The codex.cmd shadow is not the known CodexCopilot shim; it was not removed.'
        }
        $saved = Join-Path $ReportDirectory ('codex-copilot-owned-stock-shadow-' + [guid]::NewGuid().ToString('N') + '.cmd.backup')
        $shadowHash = (Get-FileHash -LiteralPath $shadow -Algorithm SHA256).Hash
        Copy-Item -LiteralPath $shadow -Destination $saved
        if ((Get-FileHash -LiteralPath $saved -Algorithm SHA256).Hash -ne $shadowHash) {
            throw 'Stock-command shadow backup checksum failed.'
        }
        # Only the known enhanced shim is removed. No official CLI file is changed.
        Remove-Item -LiteralPath $shadow
        $report.removedStockShadow = $shadow
        $report.stockShadowBackup = $saved
    }
    $cliDirectory = Split-Path -Parent $official
    $environmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
        $previousPath = [string]$environmentKey.GetValue(
            'Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $pathEntries = @($previousPath -split ';' | Where-Object { $_ })
        if (-not @($pathEntries | Where-Object { Test-SameIsolationPath $_ $cliDirectory }).Count) {
            $savedPath = Join-Path $ReportDirectory ('user-path-before-' + [guid]::NewGuid().ToString('N') + '.json')
            [IO.File]::WriteAllText($savedPath, (@{ path = $previousPath } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
            $environmentKey.SetValue('Path', "$cliDirectory;$previousPath", [Microsoft.Win32.RegistryValueKind]::ExpandString)
            $report.userPathBackup = $savedPath
            $report.officialCliDirectoryAddedToPath = $cliDirectory
        }
    } finally { $environmentKey.Close() }
    $report.stockCliSha256After = (Get-FileHash -LiteralPath $official -Algorithm SHA256).Hash
    if ($report.stockCliSha256Before -ne $report.stockCliSha256After) {
        throw 'The official CLI changed concurrently; this repair did not write it.'
    }
    $report.existingProcessesRequireFreshLaunch = $true
    Write-Host "  codex 恢复为官方可执行文件：$official；增强版不再提供 codex 同名命令。" -ForegroundColor Cyan
}
if ($Apply -and $report.existingProcessesRequireFreshLaunch) {
    if (-not ('CodexCopilotIsolation.Native' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace CodexCopilotIsolation {
    public static class Native {
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SendMessageTimeout(
            IntPtr window, uint message, UIntPtr parameter, string text,
            uint flags, uint timeout, out UIntPtr result);
    }
}
'@
    }
    $result = [UIntPtr]::Zero
    [void][CodexCopilotIsolation.Native]::SendMessageTimeout(
        [IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$result)
}
$report.registryAfter = @($names | ForEach-Object {
    [ordered]@{ name = $_; value = [Environment]::GetEnvironmentVariable($_, 'User') }
})
$afterHash = if (Test-Path -LiteralPath $stockConfig -PathType Leaf) {
    (Get-FileHash -LiteralPath $stockConfig -Algorithm SHA256).Hash
} else { $null }
$report.stockConfigSha256After = $afterHash
$report.stockConfigUnchanged = $stockHash -ceq $afterHash
if (-not $report.stockConfigUnchanged) {
    throw 'The stock profile changed concurrently; no stock file was written by this repair.'
}
if ($ReportDirectory) {
    New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
    $receipt = Join-Path $ReportDirectory 'native-isolation-repair.json'
    [IO.File]::WriteAllText($receipt, ($report | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    Write-Host "  隔离检查记录：$receipt" -ForegroundColor Green
}
if ($report.existingProcessesRequireFreshLaunch) {
    Write-Host '  已运行的原生终端／Desktop 保留现有环境及会话。保存任务后正常退出并重新打开；本脚本没有结束原生进程。' -ForegroundColor Yellow
}
$report | ConvertTo-Json -Depth 6
