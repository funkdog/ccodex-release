[CmdletBinding()]
param([string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexCopilot'))
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$receiptFile = Join-Path $source '.ccodex-dev-install.json'
if (Test-Path -LiteralPath $receiptFile) {
    $source = [IO.Path]::GetFullPath([string](Get-Content -LiteralPath $receiptFile -Raw |
        ConvertFrom-Json).sourceRoot).TrimEnd('\')
}
& node (Join-Path $source 'tools\typescript-task.mjs') check
if ($LASTEXITCODE -ne 0) { throw 'Build the canonical TypeScript source before syncing the developer installation.' }
$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\') -or
    -not (Test-Path -LiteralPath (Join-Path $root 'bin\core-current.txt')) -or
    (Test-Path -LiteralPath (Join-Path $root 'release.json')) -or
    (Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Developer maintenance requires the existing private CodexCopilot installation.'
}
$profile = Join-Path $env:USERPROFILE '.codex-copilot'
$oldReceipt = Join-Path $root '.ccodex-dev-install.json'
if (Test-Path -LiteralPath $oldReceipt) {
    $old = Get-Content -LiteralPath $oldReceipt -Raw | ConvertFrom-Json
    if ($old.product -ne 'CcodexDeveloper') { throw 'Unknown developer ownership marker.' }
    $profile = [string]$old.profile
}
$owner = @{schemaVersion=1;product='CcodexDeveloper';installRoot=$root;
    sourceRoot=$source;profile=$profile}
[IO.File]::WriteAllText($oldReceipt,($owner | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
foreach ($relative in @('package.json','package-lock.json','tsconfig.json','bridge','gateway','tools','src','developer','release','VERSION')) {
    Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $root -Recurse -Force
}
$obsoleteCheckpoint = Join-Path $root 'bridge\responses-checkpoint.mjs'
if (Test-Path -LiteralPath $obsoleteCheckpoint -PathType Leaf) {
    Remove-Item -LiteralPath $obsoleteCheckpoint -Force
}
$compiler = @((Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')) |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) { throw 'The developer machine C# compiler is missing.' }
& $compiler /nologo /target:winexe /platform:anycpu /optimize+ `
    "/out:$(Join-Path $root 'bin\codex-copilot-desktop.exe')" `
    "/win32icon:$(Join-Path $root 'assets\codex-copilot.ico')" `
    /reference:System.dll /reference:System.Core.dll /reference:System.Web.Extensions.dll `
    /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
    (Join-Path $source 'src\CodexCopilotDesktop.cs')
if ($LASTEXITCODE -ne 0) { throw 'Developer Desktop launcher compilation failed.' }
Copy-Item -LiteralPath (Join-Path $source 'bin\ccodex-process-probe.exe') -Destination (Join-Path $root 'bin') -Force
Copy-Item -LiteralPath (Join-Path $source 'bin\ccodex-process-probe.manifest.json') -Destination (Join-Path $root 'bin') -Force
$commands = Join-Path $root 'commands'
New-Item -ItemType Directory -Path $commands -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'developer\ccodex-dev.cmd') -Destination $commands -Force
foreach ($name in @('ccodex.cmd','codex-copilot.cmd')) {
    $file = Join-Path $root ('bin\' + $name)
    if (Test-Path -LiteralPath $file) {
        $text = Get-Content -LiteralPath $file -Raw
        if (-not $text.Contains('codex-copilot')) { throw 'An old CLI entry contains unknown user changes.' }
        $destination = Join-Path $root ('bin\' + $name.Replace('.cmd','.internal.cmd'))
        if (Test-Path -LiteralPath $destination) {
            if ((Get-FileHash -LiteralPath $destination).Hash -ne (Get-FileHash -LiteralPath $file).Hash) {
                throw 'Developer internal command backup differs.'
            }
            Remove-Item -LiteralPath $file -Force
        } else {
            if (-not ([IO.Path]::GetFullPath($destination).StartsWith($root + '\',
                [StringComparison]::OrdinalIgnoreCase))) { throw 'Internal entry is outside the developer root.' }
            Move-Item -LiteralPath $file -Destination $destination
        }
    }
}
$userPath = [Environment]::GetEnvironmentVariable('PATH','User')
$bin = Join-Path $root 'bin'
$parts = @($userPath -split ';' | Where-Object {
    $_ -and -not $_.TrimEnd('\').Equals($bin,[StringComparison]::OrdinalIgnoreCase) -and
    -not $_.TrimEnd('\').Equals($commands,[StringComparison]::OrdinalIgnoreCase)
})
[Environment]::SetEnvironmentVariable('PATH',($commands + ';' + ($parts -join ';')),'User')
$shell = New-Object -ComObject WScript.Shell
$programs = [Environment]::GetFolderPath('Programs')
foreach ($name in @('Codex (Copilot)','Codex (Copilot) CLI','Codex (Copilot) History')) {
    $file = Join-Path $programs ($name + '.lnk')
    if (Test-Path -LiteralPath $file) {
        $link = $shell.CreateShortcut($file)
        if ($link.TargetPath.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase) -or
            $link.Arguments.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Remove-Item -LiteralPath $file -Force
        }
    }
}
foreach ($name in @('Ccodex Dev Desktop','Ccodex Dev CLI')) {
    $link = $shell.CreateShortcut((Join-Path $programs ($name + '.lnk')))
    $link.TargetPath = Join-Path $root 'bin\codex-copilot-desktop.exe'
    $link.Arguments = ''
    if ($name -eq 'Ccodex Dev CLI') {
        $link.TargetPath = Join-Path $env:SystemRoot 'System32\cmd.exe'
        $link.Arguments = '/d /k ""' + (Join-Path $commands 'ccodex-dev.cmd') + '""'
    }
    $link.WorkingDirectory = Join-Path $env:USERPROFILE 'Ccodex Workspace'
    $link.IconLocation = (Join-Path $root 'assets\codex-copilot.ico') + ',0'
    $link.Save()
}
& (Join-Path $root 'tools\desktop-shortcut.ps1') -Apply
& (Join-Path $root 'bin\ccodex-process-probe.exe') notify
Write-Output 'Developer entry: ccodex-dev. Existing Desktop, credentials and chats were not stopped or removed.'
Write-Output ('Maintain source: ' + $source + '. Apply source updates with ccodex-dev sync.')
