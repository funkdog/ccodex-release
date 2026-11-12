import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { releaseRoot } from "./environment.mjs";
import { boundedJson } from "./paths.mjs";

function currentInstall() {
  return boundedJson(path.join(releaseRoot, "release-install.json"));
}

function location() {
  const home = process.env.CCODEX_REAL_USERPROFILE || process.env.USERPROFILE || os.homedir();
  const roaming = process.env.CCODEX_REAL_APPDATA || process.env.APPDATA ||
    path.join(home, "AppData", "Roaming");
  const id = createHash("sha256").update(currentInstall().installRoot.toLowerCase()).digest("hex").slice(0, 12);
  return path.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
    `CCodex Release Bridge ${id}.lnk`);
}

export function isEnabled() { return fs.existsSync(location()); }

export function enable() {
  const install = currentInstall();
  const file = location();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const quote = value => value.replace(/'/g, "''");
  const script = `
$ErrorActionPreference='Stop'
$shell=New-Object -ComObject WScript.Shell
$shortcut=$shell.CreateShortcut('${quote(file)}')
$shortcut.TargetPath='${quote(path.join(process.env.SystemRoot, "System32", "cmd.exe"))}'
$shortcut.Arguments='/d /c ""${quote(path.join(install.installRoot, "bin", "ccodex.cmd"))}" bridge"'
$shortcut.WorkingDirectory='${quote(install.installRoot)}'
$shortcut.WindowStyle=7
$shortcut.Description='Starts only the independent CCodex Release bridge.'
$shortcut.Save()
`;
  const result = spawnSync(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, encoding: "utf8", timeout: 30000 });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr.trim());
  return file;
}

export function disable() {
  const file = location();
  if (!fs.existsSync(file)) return false;
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Autostart shortcut cannot be a redirected file.");
  fs.unlinkSync(file);
  return true;
}
