/**
 * Registers or removes a per-user login entry for the detached bridge.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as releaseAutostart from "../release/autostart.mjs";
const privateRelease = fs.existsSync(path.resolve(import.meta.dirname, "..", "release.json"));

const ENSURE = path.join(import.meta.dirname, "ensure.mjs");
const WINDOWS_SHORTCUT = path.join(
  os.homedir(),
  "AppData",
  "Roaming",
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs",
  "Startup",
  "Codex (Copilot) Bridge.lnk",
);
const MAC_PLIST = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  "com.github.codex-copilot.bridge.plist",
);
const LINUX_UNIT = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "systemd",
  "user",
  "codex-copilot-bridge.service",
);
const LINUX_DESKTOP = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "autostart",
  "codex-copilot-bridge.desktop",
);

function runPowerShell(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `powershell exited ${result.status}`);
  }
}

function xmlEscape(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function desktopExec(value) {
  return `"${value.replace(/(["\\`$])/g, "\\$1")}"`;
}

function runSystemctl(args) {
  return spawnSync("systemctl", ["--user", ...args], {
    stdio: "ignore",
    timeout: 30000,
  });
}

export function isEnabled() {
  if (privateRelease) return releaseAutostart.isEnabled();
  if (process.platform === "win32") return fs.existsSync(WINDOWS_SHORTCUT);
  if (process.platform === "darwin") return fs.existsSync(MAC_PLIST);
  return fs.existsSync(LINUX_UNIT) || fs.existsSync(LINUX_DESKTOP);
}

export function enable() {
  if (privateRelease) return releaseAutostart.enable();
  if (process.platform === "win32") {
    fs.mkdirSync(path.dirname(WINDOWS_SHORTCUT), { recursive: true });
    const quote = (value) => value.replace(/'/g, "''");
    runPowerShell(`
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut('${quote(WINDOWS_SHORTCUT)}')
$s.TargetPath = '${quote(process.execPath)}'
$s.Arguments = '"${quote(ENSURE)}"'
$s.WorkingDirectory = '${quote(path.dirname(ENSURE))}'
$s.WindowStyle = 7
$s.Description = 'Starts the GitHub Copilot bridge used by Codex (Copilot)'
$s.Save()
`);
    return WINDOWS_SHORTCUT;
  }

  if (process.platform === "darwin") {
    fs.mkdirSync(path.dirname(MAC_PLIST), { recursive: true });
    fs.writeFileSync(
      MAC_PLIST,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.github.codex-copilot.bridge</string>
  <key>ProgramArguments</key><array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(ENSURE)}</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`,
      { mode: 0o600 },
    );
    const domain = `gui/${process.getuid()}`;
    spawnSync("launchctl", ["bootout", domain, MAC_PLIST], {
      stdio: "ignore",
    });
    spawnSync("launchctl", ["bootstrap", domain, MAC_PLIST], {
      stdio: "ignore",
    });
    return MAC_PLIST;
  }

  fs.mkdirSync(path.dirname(LINUX_UNIT), { recursive: true });
  fs.writeFileSync(
    LINUX_UNIT,
    `[Unit]
Description=CodexCopilot bridge

[Service]
Type=oneshot
ExecStart=${process.execPath} ${ENSURE}

[Install]
WantedBy=default.target
`,
    "utf8",
  );
  const reloaded = runSystemctl(["daemon-reload"]);
  const enabled =
    !reloaded.error &&
    reloaded.status === 0 &&
    runSystemctl(["enable", "--now", path.basename(LINUX_UNIT)]).status === 0;
  if (enabled) return LINUX_UNIT;

  fs.mkdirSync(path.dirname(LINUX_DESKTOP), { recursive: true });
  fs.writeFileSync(
    LINUX_DESKTOP,
    `[Desktop Entry]
Type=Application
Name=CodexCopilot Bridge
Exec=${desktopExec(process.execPath)} ${desktopExec(ENSURE)}
NoDisplay=true
X-GNOME-Autostart-enabled=true
`,
    "utf8",
  );
  return LINUX_DESKTOP;
}

export function disable() {
  if (privateRelease) return releaseAutostart.disable();
  let removed = false;
  if (process.platform === "win32") {
    if (fs.existsSync(WINDOWS_SHORTCUT)) {
      fs.rmSync(WINDOWS_SHORTCUT);
      removed = true;
    }
    return removed;
  }
  if (process.platform === "darwin") {
    if (fs.existsSync(MAC_PLIST)) {
      const domain = `gui/${process.getuid()}`;
      spawnSync("launchctl", ["bootout", domain, MAC_PLIST], {
        stdio: "ignore",
      });
      fs.rmSync(MAC_PLIST);
      removed = true;
    }
    return removed;
  }
  if (fs.existsSync(LINUX_UNIT)) {
    runSystemctl(["disable", "--now", path.basename(LINUX_UNIT)]);
    fs.rmSync(LINUX_UNIT);
    runSystemctl(["daemon-reload"]);
    removed = true;
  }
  if (fs.existsSync(LINUX_DESKTOP)) {
    fs.rmSync(LINUX_DESKTOP);
    removed = true;
  }
  return removed;
}

export const SHORTCUT =
  process.platform === "win32"
    ? WINDOWS_SHORTCUT
    : process.platform === "darwin"
      ? MAC_PLIST
      : LINUX_UNIT;
