function Write-InstallerBanner {
    param([string]$Version)

    Write-Host ''
    Write-Host '  ╭──────────────────────────────────────────────────────────────╮' -ForegroundColor DarkCyan
    Write-Host '  │                 Codex (Copilot) 安装向导                    │' -ForegroundColor Cyan
    Write-Host ("  │                    release {0,-34}│" -f $Version) -ForegroundColor DarkGray
    Write-Host '  ╰──────────────────────────────────────────────────────────────╯' -ForegroundColor DarkCyan
    Write-Host ''
    Write-Host '  正在检索 ChatGPT Desktop、Codex CLI 和 GitHub Copilot CLI…' -ForegroundColor Cyan
    $content = Get-InstallerShowcaseData
    Write-Host ("  展示内容：{0}；设置 CODEX_COPILOT_SHOWCASE_URL 可在安装时读取受信 HTTPS 更新" -f
        $script:InstallerShowcaseSource) -ForegroundColor DarkGray
    if (-not $env:CODEX_COPILOT_SHOWCASE_URL) {
        Write-Host '  未配置共享端点：不会联网拉取展示内容；请由发布者指定可信的 HTTPS JSON 地址。' -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host '  ┌─ 安装路线 · 每步输出资源或路径，失败请查看当前步骤' -ForegroundColor DarkCyan
    $number = 0
    foreach ($stage in $content.installStages) {
        $number++
        Write-Host ("  │ {0:00} ◆ {1,-10} " -f $number, $stage.title) -ForegroundColor Cyan -NoNewline
        Write-Host $stage.detail -ForegroundColor Gray
    }
    Write-Host '  └─ 功能展示不会代替 doctor 与实际请求验证' -ForegroundColor DarkCyan
}

[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$script:InstallerShowcasePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\installer-showcase.json'
$script:InstallerShowcaseData = $null
$script:InstallerShowcaseSource = $null

function Assert-InstallerShowcaseData {
    param([object]$Data)

    function Assert-Fields([object]$Value, [string[]]$Required, [string[]]$Optional, [string]$Location) {
        if ($null -eq $Value -or $Value -isnot [PSCustomObject]) {
            throw "$Location must be an object."
        }
        $names = @($Value.PSObject.Properties.Name)
        foreach ($name in $Required) {
            if ($names -cnotcontains $name) { throw "$Location is missing $name." }
        }
        foreach ($name in $names) {
            if (($Required + $Optional) -cnotcontains $name) { throw "$Location has an unknown field: $name." }
        }
    }
    function Assert-Text([object]$Value, [int]$Maximum, [string]$Location) {
        if ($Value -isnot [string] -or $Value.Length -lt 1 -or $Value.Length -gt $Maximum -or
            $Value -match '[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]') {
            throw "$Location must be a single safe line of at most $Maximum characters."
        }
    }
    function Assert-List([object]$Value, [int]$Minimum, [int]$Maximum, [string]$Location) {
        if ($Value -isnot [array] -or $Value.Count -lt $Minimum -or $Value.Count -gt $Maximum) {
            throw "$Location must contain $Minimum-$Maximum entries."
        }
    }
    function Assert-Options([object]$Value, [string]$Location) {
        if ($Value.PSObject.Properties.Name -ccontains 'color' -and
            $Value.color -cnotin @('cyan', 'magenta', 'green', 'yellow', 'gray', 'blue', 'white')) {
            throw "$Location has an unsupported color."
        }
        if ($Value.PSObject.Properties.Name -ccontains 'platforms') {
            Assert-List $Value.platforms 1 3 "$Location.platforms"
            foreach ($platform in $Value.platforms) {
                if ($platform -cnotin @('windows', 'macos', 'linux')) {
                    throw "$Location has an unsupported platform."
                }
            }
            if (@($Value.platforms | Select-Object -Unique).Count -ne $Value.platforms.Count) {
                throw "$Location has duplicate platforms."
            }
        }
        if ($Value.PSObject.Properties.Name -ccontains 'requiresDesktop' -and
            $Value.requiresDesktop -isnot [bool]) {
            throw "$Location.requiresDesktop must be boolean."
        }
    }

    Assert-Fields $Data @(
        'schemaVersion', 'title', 'tagline', 'verification', 'dataPolicy',
        'installStages', 'sections', 'quickStart', 'footer'
    ) @() 'showcase'
    if (($Data.schemaVersion -isnot [int] -and $Data.schemaVersion -isnot [long]) -or
        $Data.schemaVersion -ne 1) {
        throw 'Unsupported showcase schemaVersion.'
    }
    foreach ($field in @('title', 'tagline', 'verification', 'dataPolicy', 'footer')) {
        Assert-Text $Data.$field 260 "showcase.$field"
    }
    Assert-List $Data.installStages 6 6 'showcase.installStages'
    foreach ($stage in $Data.installStages) {
        Assert-Fields $stage @('title', 'detail') @() 'showcase.installStages[]'
        Assert-Text $stage.title 60 'showcase.installStages[].title'
        Assert-Text $stage.detail 260 'showcase.installStages[].detail'
    }
    Assert-List $Data.sections 1 8 'showcase.sections'
    foreach ($section in $Data.sections) {
        Assert-Fields $section @('title', 'color', 'items') @('platforms', 'requiresDesktop') 'showcase.sections[]'
        Assert-Text $section.title 80 'showcase.sections[].title'
        Assert-Options $section 'showcase.sections[]'
        Assert-List $section.items 1 16 'showcase.sections[].items'
        foreach ($item in $section.items) {
            Assert-Fields $item @('label', 'text') @('color', 'platforms', 'requiresDesktop') 'showcase.items[]'
            Assert-Text $item.label 48 'showcase.items[].label'
            Assert-Text $item.text 260 'showcase.items[].text'
            Assert-Options $item 'showcase.items[]'
        }
    }
    Assert-List $Data.quickStart 1 10 'showcase.quickStart'
    foreach ($entry in $Data.quickStart) {
        Assert-Fields $entry @('command', 'color', 'detail') @('platforms', 'requiresDesktop') 'showcase.quickStart[]'
        Assert-Text $entry.command 80 'showcase.quickStart[].command'
        Assert-Text $entry.detail 260 'showcase.quickStart[].detail'
        Assert-Options $entry 'showcase.quickStart[]'
    }
}

function ConvertFrom-InstallerShowcaseBytes {
    param([byte[]]$Bytes)

    if ($Bytes.Length -gt 65536) { throw 'Showcase JSON exceeds 64 KiB.' }
    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $data = $utf8.GetString($Bytes) | ConvertFrom-Json
    Assert-InstallerShowcaseData $data
    return $data
}

function Get-InstallerShowcaseData {
    if ($script:InstallerShowcaseData) { return $script:InstallerShowcaseData }
    if (-not (Test-Path -LiteralPath $script:InstallerShowcasePath -PathType Leaf)) {
        throw "Installer showcase snapshot is missing: $script:InstallerShowcasePath"
    }
    $bundled = ConvertFrom-InstallerShowcaseBytes ([IO.File]::ReadAllBytes($script:InstallerShowcasePath))
    $script:InstallerShowcaseData = $bundled
    $script:InstallerShowcaseSource = '包内快照'

    if ($env:CODEX_COPILOT_SHOWCASE_URL) {
        $uri = $null
        $handler = $null
        $client = $null
        $response = $null
        $stream = $null
        $memory = $null
        $deadline = $null
        try {
            if (-not [Uri]::TryCreate($env:CODEX_COPILOT_SHOWCASE_URL, [UriKind]::Absolute, [ref]$uri) -or
                $uri.Scheme -cne 'https' -or -not $uri.Host -or $uri.UserInfo -or $uri.Fragment) {
                throw 'Use an absolute HTTPS URL without credentials or fragment.'
            }
            Add-Type -AssemblyName System.Net.Http
            $handler = New-Object System.Net.Http.HttpClientHandler
            $handler.AllowAutoRedirect = $false
            $handler.UseCookies = $false
            $client = [System.Net.Http.HttpClient]::new($handler)
            $client.Timeout = [TimeSpan]::FromSeconds(5)
            $deadline = [System.Threading.CancellationTokenSource]::new()
            $deadline.CancelAfter(5000)
            $response = $client.GetAsync(
                $uri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $deadline.Token
            ).GetAwaiter().GetResult()
            if ([int]$response.StatusCode -ne 200) { throw "HTTP $([int]$response.StatusCode) (redirects are disabled)." }
            if ($response.Content.Headers.ContentLength -gt 65536) { throw 'Showcase JSON exceeds 64 KiB.' }
            $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $memory = New-Object IO.MemoryStream
            $buffer = New-Object byte[] 4096
            while (($count = $stream.ReadAsync($buffer, 0, $buffer.Length, $deadline.Token).GetAwaiter().GetResult()) -gt 0) {
                if ($memory.Length + $count -gt 65536) { throw 'Showcase JSON exceeds 64 KiB.' }
                $memory.Write($buffer, 0, $count)
            }
            $script:InstallerShowcaseData = ConvertFrom-InstallerShowcaseBytes $memory.ToArray()
            $script:InstallerShowcaseSource = "受信 HTTPS 端点：$($uri.DnsSafeHost)"
        } catch {
            Write-Warning "共享展示不可用（$($_.Exception.GetType().Name)）；已回退包内快照。请检查 CODEX_COPILOT_SHOWCASE_URL、证书与 schema。"
        } finally {
            if ($stream) { $stream.Dispose() }
            if ($memory) { $memory.Dispose() }
            if ($response) { $response.Dispose() }
            if ($client) { $client.Dispose() }
            if ($handler) { $handler.Dispose() }
            if ($deadline) { $deadline.Dispose() }
        }
    }
    return $script:InstallerShowcaseData
}

function Get-InstallerShowcaseColor {
    param([string]$Name)
    switch ($Name) {
        'cyan' { return [ConsoleColor]::Cyan }
        'magenta' { return [ConsoleColor]::Magenta }
        'green' { return [ConsoleColor]::Green }
        'yellow' { return [ConsoleColor]::Yellow }
        'blue' { return [ConsoleColor]::Blue }
        'white' { return [ConsoleColor]::White }
        default { return [ConsoleColor]::DarkGray }
    }
}

function Write-InstallerStage {
    param([ValidateRange(1, 6)][int]$Index, [string]$Detail)

    $stages = (Get-InstallerShowcaseData).installStages
    $stage = $stages[$Index - 1]
    Write-Host ''
    Write-Host ("  ◆ [{0:00}/{1}] {2}" -f $Index, $stages.Count, $stage.title) -ForegroundColor Cyan -NoNewline
    Write-Host ("  {0}" -f $stage.detail) -ForegroundColor Gray
    if ($Detail) {
        Write-Host ("  │ {0}" -f $Detail) -ForegroundColor DarkGray
    }
}

function Test-InstallerShowcaseVisible {
    param([object]$Entry, [string]$Platform = 'windows', [bool]$DesktopAvailable = $true)
    if ($Entry.PSObject.Properties.Name -contains 'platforms' -and $Entry.platforms -notcontains $Platform) {
        return $false
    }
    if ($Entry.PSObject.Properties.Name -contains 'requiresDesktop' -and
        $Entry.requiresDesktop -and -not $DesktopAvailable) {
        return $false
    }
    return $true
}

function Write-InstallerResourceScan {
    param([object[]]$Resources, [string]$Title = '本机资源状态')

    Write-Host ''
    Write-Host ("  ┌─ {0} " -f $Title) -ForegroundColor DarkCyan
    foreach ($resource in $Resources) {
        $state = [string]$resource.State
        $symbol = switch ($state) {
            'FOUND' { '✓'; break }
            'BUNDLED' { '◆'; break }
            'OPTIONAL' { '○'; break }
            'N/A' { '–'; break }
            default { '!' }
        }
        $color = switch ($state) {
            'FOUND' { 'Green'; break }
            'BUNDLED' { 'Green'; break }
            'OPTIONAL' { 'Yellow'; break }
            'N/A' { 'DarkGray'; break }
            default { 'Red' }
        }
        Write-Host ("  │ {0} {1,-22} {2,-9} " -f $symbol, $resource.Name, $state) -ForegroundColor $color -NoNewline
        Write-Host ([string]$resource.Detail) -ForegroundColor DarkGray
    }
    Write-Host '  └──────────────────────────────────────────────────────────────' -ForegroundColor DarkCyan
    if (@($Resources | Where-Object { $_.State -eq 'MISSING' }).Count -gt 0) {
        Write-Host '  ↳ 缺失资源将在下方提供路径、自动安装与官方手动安装三个处理选项。' -ForegroundColor Yellow
    }
}

function Test-InstallerAnimation {
    if ($env:CODEX_COPILOT_NO_ANIMATION -eq '1' -or
        $env:CODEX_COPILOT_NONINTERACTIVE -eq '1') {
        return $false
    }
    try {
        return (Test-InstallerInteractive) -and -not [Console]::IsOutputRedirected
    } catch {
        return $false
    }
}

function Write-InstallerNeonReveal {
    param([switch]$Preview)

    if (-not (Test-InstallerAnimation)) { return }
    $frames = @(
        [PSCustomObject]@{ Gauge = '■□□□□'; Label = 'INPUT + MOUSE'; Color = 'Cyan' },
        [PSCustomObject]@{ Gauge = '■■□□□'; Label = 'MODEL CATALOG'; Color = 'Blue' },
        [PSCustomObject]@{ Gauge = '■■■□□'; Label = 'DESKTOP LINK';  Color = 'Magenta' },
        [PSCustomObject]@{ Gauge = '■■■■□'; Label = 'UPDATE GUARD';  Color = 'Yellow' },
        [PSCustomObject]@{ Gauge = '■■■■■'; Label = $(if ($Preview) { 'PREVIEW ONLY' } else { 'INSTALL FINISHED' }); Color = 'Green' }
    )
    Write-Host ''
    foreach ($frame in $frames) {
        Write-Host "`r  ◇  " -ForegroundColor DarkGray -NoNewline
        Write-Host ("{0}  {1,-18}        " -f $frame.Gauge, $frame.Label) `
            -ForegroundColor $frame.Color -NoNewline
        Start-Sleep -Milliseconds 220
    }
    foreach ($pulse in @('Cyan', 'Magenta', 'White')) {
        Write-Host "`r  ✦  " -ForegroundColor $pulse -NoNewline
        Write-Host ("■■■■■  {0,-18}        " -f $(if ($Preview) { 'PREVIEW ONLY' } else { 'INSTALL FINISHED' })) `
            -ForegroundColor $pulse -NoNewline
        Start-Sleep -Milliseconds 140
    }
    Write-Host ''
}

function Write-InstallerSection {
    param(
        [string]$Index,
        [string]$Title,
        [object[]]$Items,
        [ConsoleColor]$AccentColor
    )

    Write-Host ''
    Write-Host '  ┌─ ' -ForegroundColor DarkGray -NoNewline
    Write-Host ("{0}  {1}" -f $Index, $Title) -ForegroundColor $AccentColor
    foreach ($item in $Items) {
        $labelColor = if ($item.Color) { Get-InstallerShowcaseColor $item.Color } else { $AccentColor }
        Write-Host '  │  ' -ForegroundColor DarkGray -NoNewline
        Write-Host ([string]$item.Label) -ForegroundColor $labelColor -NoNewline
        Write-Host '  ' -NoNewline
        Write-Host ([string]$item.Text) -ForegroundColor Gray
    }
    Write-Host '  └─' -ForegroundColor DarkGray
}

function Write-InstallerEnhancementShowcase {
    param([string]$Version = 'current', [switch]$Preview)

    $content = Get-InstallerShowcaseData
    $state = if ($Preview) { 'PREVIEW ONLY' } else { 'INSTALL FINISHED' }
    Write-InstallerNeonReveal -Preview:$Preview

    Write-Host ''
    Write-Host '  ╭─ ' -ForegroundColor DarkGray -NoNewline
    Write-Host $content.title -ForegroundColor Magenta -NoNewline
    Write-Host ("  v{0}" -f $Version) -ForegroundColor Cyan -NoNewline
    Write-Host ("  {0}" -f $state) -ForegroundColor Green
    Write-Host ("  │  {0}" -f $content.tagline) -ForegroundColor Gray
    Write-Host ("  │  {0}" -f $content.verification) -ForegroundColor Yellow
    Write-Host ("  ╰─ {0}" -f $content.dataPolicy) -ForegroundColor DarkGray

    $index = 0
    foreach ($section in $content.sections) {
        if (-not (Test-InstallerShowcaseVisible $section)) { continue }
        $items = @($section.items | Where-Object { Test-InstallerShowcaseVisible $_ })
        if ($items.Count -eq 0) { continue }
        $index++
        Write-InstallerSection -Index ("{0:00}" -f $index) -Title $section.title `
            -AccentColor (Get-InstallerShowcaseColor $section.color) -Items $items
    }

    Write-Host ''
    Write-Host '  ┌─ QUICK START' -ForegroundColor DarkGray
    foreach ($entry in $content.quickStart) {
        if (-not (Test-InstallerShowcaseVisible $entry)) { continue }
        Write-Host ("  │  {0,-29}" -f $entry.command) `
            -ForegroundColor (Get-InstallerShowcaseColor $entry.color) -NoNewline
        Write-Host $entry.detail -ForegroundColor Gray
    }
    Write-Host ("  ╰─ {0}" -f $content.footer) -ForegroundColor DarkGray
    Write-Host ("  展示来源：{0}" -f $script:InstallerShowcaseSource) -ForegroundColor DarkGray
    Write-Host ''
}

function Test-InstallerInteractive {
    param([switch]$Disabled)

    if ($Disabled -or $env:CODEX_COPILOT_NONINTERACTIVE -eq '1') { return $false }
    try {
        return [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
    } catch {
        return [Environment]::UserInteractive
    }
}

function Read-MissingResourceChoice {
    param([string]$Name, [string]$AutomaticDescription)

    Write-Host ''
    Write-Host "  未找到 $Name。请选择处理方式：" -ForegroundColor Yellow
    Write-Host '    [1] 提供 exe、程序目录或 SDK 路径' -ForegroundColor White
    Write-Host "    [2] 由安装器自动安装（$AutomaticDescription）" -ForegroundColor White
    Write-Host '    [3] 显示官方手动安装方法，安装后重新检测' -ForegroundColor White
    do {
        $choice = (Read-Host '  请输入 1、2 或 3').Trim()
    } while ($choice -notin @('1', '2', '3'))
    return $choice
}

function Resolve-MissingInstallerResource {
    param(
        [string]$Name,
        [string]$PathPrompt,
        [string]$AutomaticDescription,
        [string]$ManualInstruction,
        [scriptblock]$Locate,
        [scriptblock]$ResolvePath,
        [scriptblock]$AutomaticInstall,
        [bool]$Interactive,
        [bool]$AllowSkip = $false
    )

    $resource = & $Locate
    if ($resource) { return $resource }
    if (-not $Interactive) {
        if ($AutomaticInstall) {
            try {
                & $AutomaticInstall
                $resource = & $Locate
                if ($resource) { return $resource }
            } catch {
                Write-Warning "$Name 自动安装失败：$($_.Exception.Message)"
            }
        }
        Write-Host "  手动安装：$ManualInstruction" -ForegroundColor Yellow
        if ($AllowSkip) { return $null }
        throw "$Name 仍不可用。完成手动安装后请重新运行安装器。"
    }

    while (-not $resource) {
        switch (Read-MissingResourceChoice -Name $Name -AutomaticDescription $AutomaticDescription) {
            '1' {
                $candidate = Read-Host "  $PathPrompt"
                $resource = & $ResolvePath $candidate
                if (-not $resource) {
                    Write-Warning '该路径中没有找到可用资源，请重新选择。'
                }
            }
            '2' {
                try {
                    & $AutomaticInstall
                    $resource = & $Locate
                    if (-not $resource) {
                        throw '安装命令已结束，但重新检测仍未找到资源。'
                    }
                } catch {
                    Write-Warning "$Name 自动安装失败：$($_.Exception.Message)"
                    Write-Host "  请手动安装：$ManualInstruction" -ForegroundColor Yellow
                }
            }
            '3' {
                Write-Host "  官方安装方法：$ManualInstruction" -ForegroundColor Yellow
                $answer = if ($AllowSkip) {
                    Read-Host '  安装完成后按 Enter 重新检测；输入 S 可暂时跳过此增强项'
                } else {
                    Read-Host '  安装完成后按 Enter 重新检测'
                }
                if ($AllowSkip -and $answer.Trim().Equals('s', [StringComparison]::OrdinalIgnoreCase)) {
                    return $null
                }
                $resource = & $Locate
            }
        }
    }
    return $resource
}

function ConvertTo-InstallerResourcePath {
    param([string]$Candidate)

    if ([string]::IsNullOrWhiteSpace($Candidate)) { return $null }
    $trimmed = [Environment]::ExpandEnvironmentVariables($Candidate.Trim().Trim('"').Trim("'"))
    try {
        return (Resolve-Path -LiteralPath $trimmed -ErrorAction Stop).Path
    } catch {
        return $null
    }
}

function Resolve-CodexDesktopResource {
    param([string]$Candidate)

    $resolved = ConvertTo-InstallerResourcePath $Candidate
    if (-not $resolved) { return $null }
    $item = Get-Item -LiteralPath $resolved
    $roots = @()
    if (-not $item.PSIsContainer) {
        if ($item.Name -notin @('ChatGPT.exe', 'Codex.exe')) { return $null }
        $directory = $item.Directory.FullName
        $roots += $directory
        if ((Split-Path -Leaf $directory) -eq 'app') { $roots += Split-Path -Parent $directory }
    } else {
        $roots += $item.FullName
        if ((Split-Path -Leaf $item.FullName) -eq 'app') { $roots += Split-Path -Parent $item.FullName }
    }

    foreach ($root in @($roots | Select-Object -Unique)) {
        foreach ($relative in @('app\ChatGPT.exe', 'app\Codex.exe', 'ChatGPT.exe', 'Codex.exe')) {
            $executable = Join-Path $root $relative
            if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { continue }
            $appRoot = if ($relative.StartsWith('app\')) { $root } else { Split-Path -Parent $executable }
            $resources = @(
                (Join-Path $appRoot 'app\resources'),
                (Join-Path $appRoot 'resources')
            ) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
            $assets = @(
                (Join-Path $appRoot 'assets'),
                (Join-Path $appRoot 'app\assets')
            ) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
            return [PSCustomObject]@{
                Root = $appRoot
                Executable = $executable
                Resources = $resources
                Assets = $assets
            }
        }
    }
    return $null
}

function Resolve-CodexCliResource {
    param([string]$Candidate)

    $resolved = ConvertTo-InstallerResourcePath $Candidate
    if (-not $resolved) { return $null }
    $item = Get-Item -LiteralPath $resolved
    $candidates = if ($item.PSIsContainer) {
        @(
            (Join-Path $item.FullName 'codex.exe'),
            (Join-Path $item.FullName 'bin\codex.exe'),
            (Join-Path $item.FullName 'resources\codex.exe'),
            (Join-Path $item.FullName 'app\resources\codex.exe')
        )
    } else {
        @($item.FullName)
    }
    return $candidates |
        Where-Object { (Split-Path -Leaf $_) -eq 'codex.exe' -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
        Select-Object -First 1
}

function Resolve-CopilotSdkResource {
    param([string]$Candidate)

    $resolved = ConvertTo-InstallerResourcePath $Candidate
    if (-not $resolved) { return $null }
    $item = Get-Item -LiteralPath $resolved
    if (-not $item.PSIsContainer -and $item.Name -eq 'index.js' -and $item.Directory.Name -eq 'copilot-sdk') {
        return $item.FullName
    }
    if (-not $item.PSIsContainer -and $item.BaseName -match 'copilot') {
        $standardNpmRoot = Join-Path $env:APPDATA 'npm'
        if (-not $item.Directory.FullName.Equals($standardNpmRoot, [StringComparison]::OrdinalIgnoreCase)) {
            $standardSdk = Resolve-CopilotSdkResource $standardNpmRoot
            if ($standardSdk) { return $standardSdk }
        }
    }
    $root = if ($item.PSIsContainer) { $item.FullName } else { $item.Directory.FullName }
    $direct = @(
        (Join-Path $root 'copilot-sdk\index.js'),
        (Join-Path $root 'node_modules\@github\copilot\node_modules\@github')
    )
    if (Test-Path -LiteralPath $direct[0] -PathType Leaf) { return $direct[0] }
    if (Test-Path -LiteralPath $direct[1] -PathType Container) {
        $sdk = Get-ChildItem -LiteralPath $direct[1] -Directory -Filter 'copilot-*' -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'copilot-sdk\index.js' } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
            Select-Object -First 1
        if ($sdk) { return $sdk }
    }
    return Get-ChildItem -LiteralPath $root -Recurse -Depth 8 -File -Filter 'index.js' -ErrorAction SilentlyContinue |
        Where-Object { $_.Directory.Name -eq 'copilot-sdk' } |
        Select-Object -ExpandProperty FullName -First 1
}

function Find-InstalledCopilotSdk {
    param([string]$ProfileHome, [string]$Candidate)

    $candidates = @($Candidate, $env:CODEX_COPILOT_CLI_SDK)
    $savedPath = Join-Path $ProfileHome 'copilot-cli-sdk-path.txt'
    if (Test-Path -LiteralPath $savedPath -PathType Leaf) {
        $candidates += (Get-Content -LiteralPath $savedPath -Raw).Trim()
    }
    $candidates += Join-Path $env:APPDATA 'npm'
    $npm = Get-Command npm.cmd, npm -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($npm) {
        try { $candidates += ((& $npm.Source root -g 2>$null) -join '').Trim() } catch { }
    }
    foreach ($path in @($candidates | Where-Object { $_ } | Select-Object -Unique)) {
        $sdk = Resolve-CopilotSdkResource $path
        if ($sdk) { return $sdk }
    }
    return $null
}
