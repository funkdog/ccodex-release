import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveDesktopMode } from "../bridge/desktop-mode.mjs";
import { inspectBackendHost } from "../bridge/desktop-current-host.mjs";
import { assertTypeScriptBuild } from "./typescript-state.mjs";

const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const managedBy = "ccodex-current-host-launcher";

export function installMacLauncher({ root = path.resolve(import.meta.dirname, ".."), configFile,
  bundleIdentifier = "local.mycodex.launcher",
  destination = path.join(os.homedir(), "Applications", "MyCodex.app") }) {
  if (process.platform !== "darwin") throw new Error("The MyCodex app launcher is macOS-only.");
  if (process.env.CODEX_COPILOT_HEAVY_LOCK_HELD !== "1") throw new Error("Build through the repository heavy-task scheduler.");
  if (!["local.mycodex.launcher", "local.mycodex.adapters.launcher"].includes(bundleIdentifier)) throw new Error("Unknown MyCodex launcher identity.");
  root = fs.realpathSync(root); configFile = fs.realpathSync(configFile); destination = path.resolve(destination);
  assertTypeScriptBuild(root);
  const selection = resolveDesktopMode({ arguments: ["--config", configFile] });
  if (selection.host !== "current") throw new Error("This launcher requires the current-host configuration.");
  const host = inspectBackendHost(selection.desktopApp);
  if (!destination.endsWith(".app") || destination === host.application ||
      destination.startsWith(host.application + path.sep) || host.application.startsWith(destination + path.sep) ||
      destination === root || destination.startsWith(root + path.sep)) throw new Error("The launcher must be separate from the official app and source checkout.");
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.lstatSync(parent).isSymbolicLink()) throw new Error("Launcher parent must not be a symbolic link.");
  const existing = fs.existsSync(destination);
  if (existing) {
    if (!fs.lstatSync(destination).isDirectory() || fs.lstatSync(destination).isSymbolicLink()) throw new Error("Existing launcher target is not an owned app directory.");
    const marker = path.join(destination, "Contents/Resources/launcher.json");
    const stat = fs.lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || JSON.parse(fs.readFileSync(marker, "utf8")).managedBy !== managedBy) {
      throw new Error("Refusing to replace an unrelated application.");
    }
  }
  const pending = path.join(parent, `.mycodex-build-${randomUUID()}.app`);
  const backup = path.join(parent, `.mycodex-previous-${randomUUID()}.app`);
  const contents = path.join(pending, "Contents"), resources = path.join(contents, "Resources");
  const executable = path.join(contents, "MacOS", "MyCodex");
  const iconset = path.join(pending, "MyCodex.iconset");
  try {
    fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.mkdirSync(resources); fs.mkdirSync(iconset);
    const binding = { schemaVersion: 1, managedBy, node: process.execPath, root, configFile, application: host.application };
    fs.writeFileSync(path.join(resources, "launcher.json"), JSON.stringify(binding, null, 2) + "\n", { mode: 0o600 });
    const plist = { CFBundleExecutable: "MyCodex", CFBundleIdentifier: bundleIdentifier,
      CFBundleName: "MyCodex", CFBundleDisplayName: "MyCodex", CFBundlePackageType: "APPL",
      CFBundleShortVersionString: "0.1.0", CFBundleVersion: "1", CFBundleIconFile: "MyCodex.icns", LSMinimumSystemVersion: "13.0" };
    fs.writeFileSync(path.join(contents, "Info.plist"), '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>' +
      Object.entries(plist).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("") +
      '<key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/></dict></plist>\n');
    execFileSync("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-O", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`,
      path.join(root, "bridge", "desktop-launcher-macos.swift"), "-o", executable], { stdio: "inherit", timeout: 120000 });
    execFileSync(executable, ["--make-icon", iconset], { stdio: "inherit", timeout: 15000 });
    execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", path.join(resources, "MyCodex.icns")], { stdio: "inherit", timeout: 15000 });
    fs.rmSync(iconset, { recursive: true });
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", pending], { stdio: "inherit", timeout: 15000 });
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", pending], { stdio: "inherit", timeout: 15000 });
    if (existing) fs.renameSync(destination, backup);
    try { fs.renameSync(pending, destination); }
    catch (error) { if (existing) fs.renameSync(backup, destination); throw error; }
    if (existing) fs.rmSync(backup, { recursive: true });
    return { application: destination, officialApplication: host.application, launched: false,
      loginItemInstalled: false, globalEnvironmentChanged: false, adHocSigned: true };
  } finally { fs.rmSync(pending, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [configFile, destination] = process.argv.slice(2);
    if (!configFile || process.argv.length > 4) throw new Error("Usage: install-macos-launcher.mjs <config file> [destination.app]");
    console.log(JSON.stringify(installMacLauncher({ configFile, destination }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
