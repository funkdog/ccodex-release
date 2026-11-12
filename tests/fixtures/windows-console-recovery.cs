using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

internal static class WindowsConsoleRecovery
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleMode(IntPtr handle, uint mode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ReadConsoleW(IntPtr handle, StringBuilder buffer,
        uint length, out uint read, IntPtr control);

    private static uint Mode(IntPtr handle)
    {
        uint mode;
        if (!GetConsoleMode(handle, out mode))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return mode;
    }

    private static void Set(IntPtr handle, uint mode)
    {
        if (!SetConsoleMode(handle, mode))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    private static int Main(string[] args)
    {
        if (args.Length != 3 && !(args.Length == 5 && args[3] == "resume"
            && args[4] == "--last")) return 2;
        if (args[1].IndexOf('"') >= 0) return 2;
        IntPtr input = GetStdHandle(-10);
        IntPtr output = GetStdHandle(-11);
        uint originalInput = Mode(input);
        uint originalOutput = Mode(output);
        try
        {
            uint before = args[2] == "vt" ? originalInput | 0x0200u
                : originalInput & ~0x0200u;
            Set(input, before);
            Set(output, originalOutput | 5u);
            ProcessStartInfo info = new ProcessStartInfo(args[0],
                (args.Length == 5 ? "resume --last " : "") + "-C \"" + args[1] + "\"");
            info.UseShellExecute = false;
            using (Process child = Process.Start(info))
            {
                Console.WriteLine("RECOVERY_CORE_PID=" + child.Id);
                child.WaitForExit();
                uint after = Mode(input);
                Console.WriteLine("RECOVERY before=" + before + " after=" + after
                    + " exit=" + child.ExitCode + " core=" + child.Id);
                if (before != after || child.ExitCode != 0) return 3;
            }
            // No mode repair occurs before this read: the exited core must have
            // restored the actual parent's cooked input, not just printed an escape.
            Console.WriteLine("RECOVERY_READ_READY");
            StringBuilder line = new StringBuilder(256);
            uint read;
            if (!ReadConsoleW(input, line, 255, out read, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            string actual = line.ToString().TrimEnd('\r', '\n');
            Console.WriteLine("RECOVERY_LINE=" + actual);
            if (actual != "PARENT-AFTER-QUIT") return 4;
            Console.WriteLine("RECOVERY_PASSED");
            return 0;
        }
        finally
        {
            Set(input, originalInput);
            Set(output, originalOutput);
        }
    }
}
