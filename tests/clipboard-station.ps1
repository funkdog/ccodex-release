[CmdletBinding()]
param(
    [ValidateSet('Run', 'Probe', 'Image', 'Files', 'Text')]
    [string]$Action = 'Probe',
    [string]$Node,
    [string]$Script,
    [string]$Fixture
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class ClipboardTestStation {
    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern IntPtr CreateWindowStation(string name, uint flags, uint access, IntPtr security);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool SetProcessWindowStation(IntPtr station);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool CloseWindowStation(IntPtr station);
    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern IntPtr CreateDesktop(string name, string device, IntPtr devmode, uint flags, uint access, IntPtr security);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool SetThreadDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder info, uint length, out uint needed);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr duplicate, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern bool CreateProcess(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct StartupInfo {
        public uint cb;
        public string reserved, desktop, title;
        public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
        public ushort showWindow, reservedBytes;
        public IntPtr reservedPointer, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo {
        public IntPtr process, thread;
        public uint processId, threadId;
    }

    public static string Name() {
        uint needed;
        GetUserObjectInformation(GetProcessWindowStation(), 2, null, 0, out needed);
        var text = new StringBuilder((int)needed);
        if (!GetUserObjectInformation(GetProcessWindowStation(), 2, text, needed, out needed))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return text.ToString();
    }

    public static IntPtr NewStation(string name) {
        var station = CreateWindowStation(name, 0, 0xF037F, IntPtr.Zero);
        if (station == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            throw new Win32Exception(error, "CreateWindowStation failed (" + error + ")");
        }
        return station;
    }

    static IntPtr InheritableStandardHandle(int number) {
        var value = GetStdHandle(number);
        if (value == IntPtr.Zero || value == new IntPtr(-1)) return IntPtr.Zero;
        IntPtr duplicate;
        if (!DuplicateHandle(GetCurrentProcess(), value, GetCurrentProcess(), out duplicate, 0, true, 2))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return duplicate;
    }

    public static int Run(string node, string script, string desktop) {
        var startup = new StartupInfo();
        startup.cb = (uint)Marshal.SizeOf(startup);
        startup.desktop = desktop;
        startup.flags = 0x101; // hidden window plus explicit inherited standard handles
        startup.stdin = InheritableStandardHandle(-10);
        startup.stdout = InheritableStandardHandle(-11);
        startup.stderr = InheritableStandardHandle(-12);
        ProcessInfo child;
        try {
            var command = new StringBuilder("\"" + node + "\" \"" + script + "\"");
            if (!CreateProcess(node, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000400 | 0x4000, IntPtr.Zero,
                System.IO.Path.GetDirectoryName(script), ref startup, out child))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally {
            if (startup.stdin != IntPtr.Zero) CloseHandle(startup.stdin);
            if (startup.stdout != IntPtr.Zero) CloseHandle(startup.stdout);
            if (startup.stderr != IntPtr.Zero) CloseHandle(startup.stderr);
        }
        Console.WriteLine("ClipboardTestNodePid=" + child.processId);
        try {
            WaitForSingleObject(child.process, 0xffffffff);
            uint exitCode;
            if (!GetExitCodeProcess(child.process, out exitCode))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return (int)exitCode;
        } finally {
            CloseHandle(child.thread);
            CloseHandle(child.process);
        }
    }
}
'@

if ($Action -eq 'Run') {
    if ($env:CCODEX_CLIPBOARD_TEST_ALLOW_SETUP -ne '1' -or
        (Get-Process -Id $PID).PriorityClass -ne 'BelowNormal') {
        throw 'Run clipboard integration tests through the isolated heavy-test worker.'
    }
    $originalStation = [ClipboardTestStation]::GetProcessWindowStation()
    $originalDesktop = [ClipboardTestStation]::GetThreadDesktop([ClipboardTestStation]::GetCurrentThreadId())
    $name = 'ccodex-clipboard-test-' + [guid]::NewGuid().ToString('N')
    $station = [ClipboardTestStation]::NewStation($name)
    $desktop = [IntPtr]::Zero
    try {
        if (-not [ClipboardTestStation]::SetProcessWindowStation($station)) { throw 'Could not select the isolated station.' }
        $desktop = [ClipboardTestStation]::CreateDesktop('Test', $null, [IntPtr]::Zero, 0, 0xF01FF, [IntPtr]::Zero)
        if ($desktop -eq [IntPtr]::Zero -or -not [ClipboardTestStation]::SetThreadDesktop($desktop)) {
            throw 'Could not create the isolated test desktop.'
        }
        $env:CCODEX_CLIPBOARD_TEST_STATION = $name
        $code = [ClipboardTestStation]::Run($Node, $Script, "$name\Test")
    } finally {
        [void][ClipboardTestStation]::SetThreadDesktop($originalDesktop)
        [void][ClipboardTestStation]::SetProcessWindowStation($originalStation)
        if ($desktop -ne [IntPtr]::Zero) { [void][ClipboardTestStation]::CloseDesktop($desktop) }
        [void][ClipboardTestStation]::CloseWindowStation($station)
    }
    exit $code
}

# This check must precede every clipboard API call, including test fixture setup.
$actualStation = [ClipboardTestStation]::Name()
if (-not $env:CCODEX_CLIPBOARD_TEST_STATION -or
    $actualStation -cne $env:CCODEX_CLIPBOARD_TEST_STATION -or
    -not $actualStation.StartsWith('ccodex-clipboard-test-')) {
    throw 'Refusing to access the real desktop clipboard.'
}
if ($Action -eq 'Probe') {
    Write-Output "CCODEX_CLIPBOARD_STATION_OK=$actualStation"
    exit 0
}

$payload = Get-Content -LiteralPath $Fixture -Raw | ConvertFrom-Json
$allowedRoot = [IO.Path]::GetFullPath($env:CCODEX_CLIPBOARD_FIXTURE_ROOT).TrimEnd('\') + '\'
foreach ($file in @($payload.imagePath) + @($payload.files)) {
    if ($file -and -not [IO.Path]::GetFullPath($file).StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Clipboard fixture escaped its isolated directory.'
    }
}
Add-Type -AssemblyName System.Windows.Forms
switch ($Action) {
    'Image' {
        $image = [Drawing.Image]::FromFile($payload.imagePath)
        try { [Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }
    }
    'Files' {
        $files = [Collections.Specialized.StringCollection]::new()
        foreach ($file in $payload.files) { [void]$files.Add($file) }
        [Windows.Forms.Clipboard]::SetFileDropList($files)
    }
    'Text' { [Windows.Forms.Clipboard]::SetText([string]$payload.text) }
}
Write-Output "ISOLATED_CLIPBOARD_SET=$Action"
