using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Drawing;
using System.Runtime.InteropServices;

internal static class CodexCopilotDesktop
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    [DllImport("kernel32.dll")]
    private static extern bool FreeConsole();

    private static string Root()
    {
        string root = Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName), ".."));
        string pointer = Path.Combine(root, "current.txt");
        if (!File.Exists(pointer)) return root;
        string id = File.ReadAllText(pointer).Trim();
        if (!Regex.IsMatch(id, @"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$"))
            throw new InvalidOperationException("Invalid Ccodex installation pointer.");
        string slot = Path.GetFullPath(Path.Combine(root, "versions", id));
        if (!slot.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Ccodex resource path is not contained.");
        return slot;
    }

    private static string FindNode(string root)
    {
        string bundled = Path.Combine(root, "runtime", "node", "node.exe");
        if (File.Exists(bundled)) return bundled;
        if (File.Exists(Path.Combine(root, "release.json"))) return null;
        foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            if (String.IsNullOrWhiteSpace(directory)) continue;
            string candidate = Path.Combine(directory.Trim(), "node.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private static string Quote(string argument)
    {
        var result = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\') { backslashes++; continue; }
            result.Append('\\', backslashes * (character == '"' ? 2 : 1));
            if (character == '"') result.Append('\\');
            result.Append(character);
            backslashes = 0;
        }
        result.Append('\\', backslashes * 2);
        return result.Append('"').ToString();
    }

    private static string Profile(string root)
    {
        var value = Json.Deserialize<Dictionary<string, object>>(
            File.ReadAllText(Path.Combine(root, "release-install.json")));
        object profile;
        if (!value.TryGetValue("profile", out profile) || !(profile is string) ||
            !Path.IsPathRooted((string)profile))
            throw new InvalidOperationException("Ccodex installation has no private profile.");
        return (string)profile;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        var stdout = Console.Out;
        FreeConsole();
        Application.EnableVisualStyles();
        try
        {
            string root = Root();
            bool release = File.Exists(Path.Combine(root, "release.json"));
            string node = FindNode(root);
            if (node == null) throw new InvalidOperationException("The private Node runtime is missing.");
            string script = Path.Combine(root, release ? "release" : "bridge",
                release ? "desktop-entry.mjs" : "desktop-launch.mjs");
            bool developer = !release && File.Exists(Path.Combine(root, "developer", "launch.mjs"));
            if (developer) script = Path.Combine(root, "developer", "launch.mjs");
            if (!File.Exists(script)) throw new FileNotFoundException("Desktop launcher is missing.", script);
            var arguments = new StringBuilder(Quote(script));
            if (developer) arguments.Append(" desktop");
            foreach (string argument in args) arguments.Append(" ").Append(Quote(argument));
            var info = new ProcessStartInfo(node, arguments.ToString())
            {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = root,
                RedirectStandardInput = release, RedirectStandardOutput = true,
                RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            info.EnvironmentVariables.Remove("NODE_OPTIONS");
            info.EnvironmentVariables.Remove("NODE_PATH");
            info.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            bool signIn = release && !File.Exists(Path.Combine(Profile(root), "github-auth.json"));
            using (var process = new Process { StartInfo = info })
            {
                if (!signIn)
                {
                    process.Start();
                    var output = process.StandardOutput.ReadToEndAsync();
                    var error = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(180000))
                        throw new InvalidOperationException("Startup is still running. No other process was stopped.");
                    if (process.ExitCode != 0)
                    {
                        string message = error.Result + "\n" + output.Result;
                        if (Array.IndexOf(args, "--startup-probe") >= 0)
                        {
                            stdout.Write(message);
                            return process.ExitCode;
                        }
                        throw new InvalidOperationException(message);
                    }
                    if (Array.IndexOf(args, "--startup-probe") >= 0) stdout.Write(output.Result);
                    return 0;
                }
                using (var form = new Form())
                {
                    form.Text = "Ccodex Desktop";
                    form.ClientSize = new Size(500, 270);
                    form.StartPosition = FormStartPosition.CenterScreen;
                    form.FormBorderStyle = FormBorderStyle.FixedDialog;
                    form.MaximizeBox = false;
                    string icon = Path.Combine(root, "assets", "codex-copilot.ico");
                    if (File.Exists(icon)) form.Icon = new Icon(icon);
                    form.Font = new Font("Microsoft YaHei UI", 10);
                    var heading = new Label { Left = 24, Top = 24, Width = 450, Height = 32,
                        Text = "\u767b\u5f55\u4f60\u7684 GitHub Copilot \u8d26\u6237",
                        Font = new Font(form.Font.FontFamily, 14, FontStyle.Bold) };
                    var status = new Label { Left = 24, Top = 68, Width = 450, Height = 42,
                        Text = "\u6b63\u5728\u83b7\u53d6\u6388\u6743\u7801\uff0c\u8bf7\u7a0d\u5019\u3002" };
                    var code = new TextBox { Left = 24, Top = 118, Width = 450, Height = 38,
                        ReadOnly = true, TextAlign = HorizontalAlignment.Center,
                        Font = new Font("Consolas", 20, FontStyle.Bold) };
                    var open = new Button { Left = 24, Top = 183, Width = 220, Height = 38,
                        Text = "\u6253\u5f00 GitHub \u6388\u6743\u9875", Enabled = false };
                    var cancel = new Button { Left = 354, Top = 183, Width = 120, Height = 38,
                        Text = "\u53d6\u6d88" };
                    form.Controls.AddRange(new Control[] { heading, status, code, open, cancel });
                    bool completed = false;
                    int result = 1;
                    string verification = null;
                    var failure = new StringBuilder();
                    var handle = form.Handle;
                    open.Click += delegate {
                        Uri uri;
                        if (Uri.TryCreate(verification, UriKind.Absolute, out uri) &&
                            uri.Scheme == "https" && uri.Host == "github.com")
                            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
                    };
                    cancel.Click += delegate { form.Close(); };
                    form.FormClosing += delegate(object sender, FormClosingEventArgs e) {
                        if (completed) return;
                        e.Cancel = true;
                        cancel.Enabled = false;
                        status.Text = "\u6b63\u5728\u53d6\u6d88\u672c\u6b21\u6388\u6743\u2026";
                        try { process.StandardInput.WriteLine("cancel"); process.StandardInput.Flush(); }
                        catch { }
                    };
                    process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                        if (String.IsNullOrWhiteSpace(e.Data) || !e.Data.StartsWith("{")) return;
                        try
                        {
                            var value = Json.Deserialize<Dictionary<string, object>>(e.Data);
                            object eventValue;
                            if (!value.TryGetValue("guiEvent", out eventValue)) return;
                            string kind = eventValue as string;
                            form.BeginInvoke((Action)delegate {
                                if (kind == "login-code")
                                {
                                    object userCode, url;
                                    if (value.TryGetValue("userCode", out userCode)) code.Text = userCode as string;
                                    if (value.TryGetValue("verificationUri", out url)) verification = url as string;
                                    open.Enabled = verification != null;
                                    status.Text = "\u5728\u6d4f\u89c8\u5668\u4e2d\u8f93\u5165\u4ee5\u4e0b\u6388\u6743\u7801\u3002";
                                }
                                if (kind == "starting")
                                {
                                    status.Text = "\u6388\u6743\u6210\u529f\uff0c\u6b63\u5728\u6253\u5f00 Desktop\u3002";
                                    cancel.Enabled = false;
                                }
                            });
                        }
                        catch { }
                    };
                    process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                        if (e.Data == null) return;
                        lock (failure) { if (failure.Length < 16384) failure.AppendLine(e.Data); }
                    };
                    process.Start();
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();
                    Task.Run(delegate {
                        process.WaitForExit();
                        result = process.ExitCode;
                        form.BeginInvoke((Action)delegate { completed = true; form.Close(); });
                    });
                    Application.Run(form);
                    if (result != 0 && result != 130)
                        throw new InvalidOperationException(failure.ToString() +
                            "\nOpen the Ccodex CLI and run: ccodex doctor");
                    return result;
                }
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message +
                "\n\nNo original Codex/Copilot process, account or project was removed.",
                "Ccodex Desktop", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
