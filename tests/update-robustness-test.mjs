import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("Windows CLI keeps the patched core pinned and renders without nested ConPTY", () => {
  const alias = read("bin", "ccodex.cmd");
  const launcher = read("bin", "codex-copilot.cmd");

  assert.match(alias, /set "CCODEX_USE_PROXY="/);
  assert.doesNotMatch(alias, /CCODEX_USE_PROXY=1/);
  assert.match(alias, /\?1000;1002;1003;1004;1006;1015;1016l/);
  assert.match(alias, /call :reset_terminal_input[\s\S]*call "%~dp0codex-copilot\.cmd"/);
  assert.match(alias, /:reset_terminal_input[\s\S]*"credits" goto :eof[\s\S]*"history" goto :eof/);
  assert.match(alias, /IsOutputRedirected[\s\S]*if errorlevel 1 goto :eof[\s\S]*CC_ESC/);
  assert.match(launcher, /if exist "%CC_ROOT%\\bin\\core-current\.txt"/);
  assert.match(launcher, /bridge\\port-selection\.mjs" --print/);
  assert.match(launcher, /CODEX_COPILOT_BRIDGE_PORT=%CC_PORT%/);
  assert.match(launcher, /"update"\s+goto :run_cli_update/);
  assert.match(launcher, /bridge\\cli-update\.mjs/);
  assert.doesNotMatch(launcher, /run_pinned_update|uses a pinned, patched Codex core/);
});

test("Unix CLI selects only independently validated enhanced updates", () => {
  const launcher = read("platforms", "unix", "bin", "codex-copilot");
  assert.match(launcher, /update\)[\s\S]*bridge\/cli-update\.mjs/);
  assert.match(launcher, /cli-updates\/core-current\.txt/);
  assert.match(launcher, /cliCoreSelection/);
  assert.doesNotMatch(launcher, /uses a pinned, patched Codex core/);
});

test("generated profiles suppress stock update prompts", () => {
  const generator = read("tools", "gen-config.mjs");
  assert.match(generator, /"check_for_update_on_startup"/);
  assert.match(generator, /check_for_update_on_startup = false/);
});

test("Desktop owns its native core instead of inheriting the pinned CLI override", () => {
  const launcher = read("src", "CodexCopilotDesktop.cs");
  assert.doesNotMatch(launcher, /ActiveCorePath|core-current\.txt|codex-copilot-core\.next/);
  assert.doesNotMatch(launcher, /Registry\.|SetEnvironmentVariable|ActivateApplication|AppsFolder/);
  assert.match(launcher, /desktop-launch\.mjs/);
  const runtime = read("bridge", "desktop-runtime.mjs");
  assert.match(runtime, /CODEX_ELECTRON_USER_DATA_PATH/);
  assert.match(runtime, /CODEX_CLI_PATH/);
  assert.match(runtime, /independent Desktop integrity|Independent Desktop integrity/);
});

test("Desktop keeps stock and enhanced instances independent instead of refusing both", () => {
  const launcher = read("src", "CodexCopilotDesktop.cs");
  assert.doesNotMatch(launcher, /RejectRunningDesktop|GetProcessesByName/);
  const launch = read("bridge", "desktop-launch.mjs");
  assert.match(launch, /selectRuntime = desktopSnapshot/);
  assert.match(launch, /stateRoot = desktopStateRoot\(\{ root, home \}\)/);
  assert.match(launch, /selectRuntime\(root, \{ stateRoot \}\)/);
  assert.match(launch, /desktopEnvironment/);
  assert.match(launch, /--user-data-dir=/);
  assert.match(launch, /--remote-debugging-port=/);
  assert.match(launch, /originalFilesModified: false/);
});

test("installer replaces old shadow launchers with a stable forwarding shim", () => {
  const installer = read("install.ps1");
  assert.match(installer, /CodexCopilot\\bin\\ccodex\.cmd/);
  assert.doesNotMatch(installer, /updated legacy ccodex terminal proxy/);
  assert.doesNotMatch(installer, /Path\]::GetRelativePath/);
  assert.match(installer, /Copy source escaped its root/);
  assert.match(installer, /\*\.backup\.exe/);
  assert.ok(
    installer.indexOf("if ($PreflightOnly) {") < installer.indexOf("$interactiveInstall ="),
    "preflight must return before any automatic prerequisite installation",
  );
  assert.ok(
    installer.indexOf("$copilotSdk = Resolve-MissingInstallerResource") <
      installer.indexOf("$desktopResource = Resolve-MissingInstallerResource"),
    "Copilot eligibility is resolved before Desktop and CLI prerequisites",
  );
  const normalInstall = installer.slice(installer.indexOf("# Copy payload"));
  assert.doesNotMatch(normalInstall, /Stop-ExecutableTree|Stop-Process -Id .* -Force/);
  assert.doesNotMatch(normalInstall, /Copy-Item -LiteralPath \$patchedCli -Destination \$codexCli/);
  assert.match(normalInstall, /official Codex CLI and Desktop binaries remain untouched/);
  assert.match(installer, /codex-cli-path\.txt/);
  assert.match(installer, /'NATIVE_PATCH_CHAIN\.json'/);
  assert.match(installer, /Package target metadata differs from the bundled core/);
  assert.match(installer, /Release patch changed after core build/);
  assert.match(installer, /running bridge generation differs from the installed release/i);
  assert.match(installer, /active requests; no running inference was stopped/);
  assert.match(installer, /files are installed, but the new bridge has not been activated/);
  assert.equal(fs.existsSync(path.join(root, "bin", "codex.cmd")), false);
  assert.match(installer, /Restore-NativeIsolation\.ps1/);
  assert.match(installer, /Install-DesktopSnapshot\.ps1/);

  const packager = read("tools", "New-TransferBundle.ps1");
  assert.match(packager, /\*\.backup\.exe/);
  assert.match(packager, /Target core build manifest is stale or mismatched/);
  assert.match(packager, /coreSha256/);

  const unixPackager = read("tools", "package-unix.mjs");
  assert.match(unixPackager, /coreSha256/);
  assert.match(unixPackager, /sourceRevision/);
});

test("repair deployment requires matching source hashes and distributes compatibility guidance", () => {
  const files = JSON.parse(read("tools", "native-repair-files.json"));
  assert.equal(new Set(files).size, files.length);
  for (const file of files) {
    assert.ok(!path.isAbsolute(file) && !file.split(/[\\/]/).includes(".."));
    assert.ok(fs.existsSync(path.join(root, file)), file);
  }
  assert.ok(files.includes("NATIVE_COMPATIBILITY.md"));
  for (const file of ["bridge/desktop-cdp.mjs", "bridge/desktop-patch.mjs", "tests/desktop-cdp-test.mjs"]) {
    assert.ok(files.includes(file), `Desktop recovery must be part of the verified deployment: ${file}`);
  }
  const deploy = read("tools", "Install-NativeRepair.ps1");
  assert.match(deploy, /sourceUnchanged/);
  assert.match(deploy, /sourceFiles/);
  assert.match(deploy, /Repair source changed after verification/);
  for (const file of ["install.ps1", "tools/New-TransferBundle.ps1", "tools/package-unix.mjs", "tools/export-bundle.mjs"]) {
    assert.match(read(file), /NATIVE_COMPATIBILITY\.md/);
  }
});

test("Desktop helper releases target sessions on endpoint loss or normal exit", () => {
  const patch = read("bridge", "desktop-patch.mjs");
  assert.match(patch, /new CdpTargetSessions\(\)/);
  assert.match(patch, /contextSessions\.retain\(targets\)/);
  assert.match(patch, /finally\s*\{\s*contextSessions\.close\(\)/);
  assert.doesNotMatch(patch, /new WebSocket\(/);
});
