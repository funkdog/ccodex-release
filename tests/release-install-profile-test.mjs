import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-profile-selection-"));
const helper = path.join(root, "release", "install-profile.ps1");
const shells = [
  path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  path.join(root, "runtime", "primary", "codex-primary-runtime", "dependencies", "native", "powershell", "pwsh.exe"),
];
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

function select(shell, install, profile, mode = "profile", explicit = false) {
  const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop';try{. $env:TEST_PROFILE_HELPER;" +
    "$selected=if($env:TEST_LOCATION_MODE -eq 'root'){" +
    "Get-CCodexInstallRoot $env:TEST_INSTALL_ROOT ($env:TEST_EXPLICIT -eq 'true') $false" +
    "}else{Get-CCodexInstallProfile $env:TEST_INSTALL_ROOT $env:TEST_SELECTED_PROFILE};" +
    "@{profile=$selected;error=$null}|ConvertTo-Json -Compress}" +
    "catch{@{profile=$null;error=$_.Exception.Message}|ConvertTo-Json -Compress}"], {
    encoding: "utf8", windowsHide: true, timeout: 60000,
    env: { ...process.env, NODE_OPTIONS: "", PSModuleAnalysisCachePath: path.join(temporary, "module-cache"),
      TEST_PROFILE_HELPER: helper, TEST_INSTALL_ROOT: install, TEST_SELECTED_PROFILE: profile || "",
      TEST_LOCATION_MODE: mode, TEST_EXPLICIT: String(explicit) },
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
}

for (const [index, shell] of shells.entries()) {
  test(`PowerShell ${index ? "bundled" : "5.1"} skips an unowned default install without modifying it`, () => {
    const install = path.join(temporary, `install-residue-${index}`);
    fs.mkdirSync(path.join(install, "profile", "cache", "temp"), { recursive: true });
    const sentinel = path.join(install, "unknown-data.txt");
    fs.writeFileSync(sentinel, "do-not-claim");
    const result = select(shell, install, null, "root");
    assert.equal(result.error, null);
    assert.equal(result.profile, install + "-Isolated");
    assert.equal(fs.existsSync(result.profile), false);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "do-not-claim");
    assert.equal(fs.existsSync(path.join(install, ".ccodex-release-install.json")), false);
    assert.match(select(shell, install, null, "root", true).error, /not owned/);
    fs.mkdirSync(result.profile);
    fs.writeFileSync(path.join(result.profile, ".ccodex-release-install.json"),
      JSON.stringify({ product: "CCodexRelease", schemaVersion: 1, uninstalled: true }));
    assert.equal(select(shell, install, null, "root").profile, result.profile);
  });

  test(`PowerShell ${index ? "bundled" : "5.1"} selects a clean default without writing it`, () => {
    const install = path.join(temporary, `clean-${index}`);
    const result = select(shell, install);
    assert.equal(result.error, null);
    assert.equal(result.profile, path.join(install, "profile"));
    assert.equal(fs.existsSync(install), false);
  });

  test(`PowerShell ${index ? "bundled" : "5.1"} preserves failed-install caches and unknown data`, () => {
    const install = path.join(temporary, `residual-${index}`), home = path.join(install, "profile");
    fs.mkdirSync(path.join(home, "cache", "temp"), { recursive: true });
    fs.writeFileSync(path.join(home, "unknown-data.txt"), "preserve");
    const result = select(shell, install);
    assert.equal(result.error, null);
    assert.match(path.basename(result.profile), /^profile-isolated-[a-f0-9]{32}$/);
    assert.equal(path.dirname(result.profile), install);
    assert.equal(fs.existsSync(result.profile), false);
    assert.equal(fs.readFileSync(path.join(home, "unknown-data.txt"), "utf8"), "preserve");
    assert.equal(fs.existsSync(path.join(home, ".ccodex-release-profile.json")), false);
    assert.match(select(shell, install, home).error, /not owned/);
  });

  test(`PowerShell ${index ? "bundled" : "5.1"} reuses receipt-owned data after uninstall`, () => {
    const install = path.join(temporary, `receipt-${index}`), home = path.join(temporary, `external-${index}`);
    fs.mkdirSync(install, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, ".ccodex-release-profile.json"),
      JSON.stringify({ product: "CCodexRelease", schemaVersion: 1 }));
    fs.writeFileSync(path.join(home, "user-owned.txt"), "saved-preferences");
    const receipt = { product: "CCodexRelease", schemaVersion: 1, installRoot: install, profile: home };
    fs.writeFileSync(path.join(install, "release-install.json"), JSON.stringify(receipt));
    assert.equal(select(shell, install).profile, home);
    fs.unlinkSync(path.join(install, "release-install.json"));
    fs.writeFileSync(path.join(install, ".ccodex-release-install.json"),
      JSON.stringify({ ...receipt, uninstalled: true }));
    assert.equal(select(shell, install).profile, home);
    assert.equal(fs.readFileSync(path.join(home, "user-owned.txt"), "utf8"), "saved-preferences");
  });

  test(`PowerShell ${index ? "bundled" : "5.1"} rejects a foreign receipt and linked profile marker`, () => {
    const install = path.join(temporary, `foreign-${index}`), home = path.join(install, "profile");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(install, "release-install.json"),
      JSON.stringify({ product: "OtherProduct", schemaVersion: 1, installRoot: install, profile: home }));
    assert.match(select(shell, install).error, /does not belong/);
    fs.unlinkSync(path.join(install, "release-install.json"));
    const target = path.join(temporary, `linked-target-${index}`);
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(home, ".ccodex-release-profile.json"), "junction");
    try { assert.match(select(shell, install, home).error, /regular file/); }
    finally { fs.unlinkSync(path.join(home, ".ccodex-release-profile.json")); }
  });
}
