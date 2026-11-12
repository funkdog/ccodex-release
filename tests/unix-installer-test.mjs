import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const installer = fs.readFileSync(path.join(root, "platforms", "unix", "install.sh"), "utf8");
const packageSource = fs.readFileSync(path.join(root, "tools", "package-unix.mjs"), "utf8");
const platform = process.platform;
const isUnix = platform === "linux" || platform === "darwin";
const platformName = platform === "darwin" ? "macos" : "linux";
const architecture = process.arch === "arm64" ? "arm64" : "x64";
const version = "1.2.99";
const functions = installer.slice(
  installer.indexOf("validate_install_root() {"),
  installer.indexOf('\ncase "$(uname -s)" in'),
);
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-unix-installer-test-"));
  const source = path.join(directory, "package");
  const destination = path.join(directory, "install", "codex-copilot");
  const profile = path.join(directory, "profile");
  const home = path.join(directory, "home");
  const fakeBin = path.join(directory, "fake-bin");
  const core = "fixture-core\n";
  const metadata = {
    os: platformName,
    arch: architecture,
    target: `${platformName}-${architecture}`,
    packageVersion: version,
    coreSha256: crypto.createHash("sha256").update(core).digest("hex").toUpperCase(),
  };
  const f = { directory, source, destination, profile, home, fakeBin, metadata };
  try {
    for (const entry of [
      "bin", "runtime/node/bin", "assets", "bridge", "tools",
    ]) fs.mkdirSync(path.join(source, entry), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(source, "VERSION"), `${version}\n`);
    fs.writeFileSync(path.join(source, "platform-target.json"), JSON.stringify(metadata));
    fs.writeFileSync(path.join(source, "install.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(source, "bin", "bridge-port.sh"), "#!/bin/sh\n", { mode: 0o644 });
    fs.writeFileSync(path.join(source, "bridge", "cli.mjs"), "// fixture bridge\n");
    fs.writeFileSync(path.join(source, "tools", "gen-config.mjs"), "// fixture generator\n");
    fs.writeFileSync(path.join(source, "assets", "installer-showcase.json"), "{}\n");
    for (const name of ["codex-copilot", "ccodex", "codex-copilot-desktop"]) {
      fs.writeFileSync(path.join(source, "bin", name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    fs.writeFileSync(path.join(source, "bin", "codex-copilot-core"), core, { mode: 0o755 });
    fs.writeFileSync(path.join(source, "runtime", "node", "bin", "node"),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o755 });
    return run(f);
  } finally {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^ccodex-unix-installer-test-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

function harness(f, body, installRoot = f.destination) {
  const prelude = [
    "set -euo pipefail",
    `SOURCE_NODE=${shellQuote(process.execPath)}`,
    `SOURCE_ROOT=${shellQuote(f.source)}`,
    `INSTALL_ROOT=${shellQuote(installRoot)}`,
    `PROFILE_HOME=${shellQuote(f.profile)}`,
    `PACKAGE_OS=${shellQuote(platformName)}`,
    `PACKAGE_ARCH=${shellQuote(architecture)}`,
    `VERSION=${shellQuote(version)}`,
    "CYAN=''; GREEN=''; YELLOW=''; RESET=''",
    functions,
    body,
  ].join("\n");
  return spawnSync("bash", ["-c", prelude], {
    cwd: f.directory,
    env: { ...process.env, HOME: f.home },
    encoding: "utf8",
    timeout: 15000,
  });
}

function oldInstallation(f) {
  fs.mkdirSync(path.join(f.destination, "bin"), { recursive: true });
  fs.mkdirSync(path.join(f.destination, "bridge"), { recursive: true });
  fs.writeFileSync(path.join(f.destination, "platform-target.json"), JSON.stringify(f.metadata));
  fs.writeFileSync(path.join(f.destination, "VERSION"), `${version}\n`);
  fs.writeFileSync(path.join(f.destination, "bin", "codex-copilot"), "previous launcher");
  fs.writeFileSync(path.join(f.destination, "bridge", "cli.mjs"), "previous bridge");
  fs.writeFileSync(path.join(f.destination, "old.txt"), "previous installation");
}

function stageDirectories(f) {
  const parent = path.dirname(f.destination);
  return fs.readdirSync(parent).filter((entry) => entry.startsWith(".codex-copilot."));
}

function fakeInstaller(f, { entitled = true } = {}) {
  fs.copyFileSync(path.join(root, "platforms", "unix", "install.sh"),
    path.join(f.source, "install.sh"));
  fs.copyFileSync(path.join(root, "platforms", "unix", "bin", "bridge-port.sh"),
    path.join(f.source, "bin", "bridge-port.sh"));
  fs.copyFileSync(path.join(root, "assets", "installer-showcase.json"),
    path.join(f.source, "assets", "installer-showcase.json"));
  fs.writeFileSync(path.join(f.source, "bridge", "cli.mjs"), `
import fs from "node:fs";
const command = process.argv[2];
fs.appendFileSync(process.env.TEST_ORDER_LOG, command + "\\n");
fs.appendFileSync(process.env.TEST_PORT_LOG,
  command + ":" + process.env.CODEX_COPILOT_BRIDGE_PORT + "\\n");
if (command === "status") {
  if (!${entitled}) { process.stdout.write("Not signed in.\\n"); process.exitCode = 1; }
  else process.stdout.write("GitHub account : fixture\\nCopilot models : 2 usable / 2 returned\\n");
} else if (command === "autostart") process.stdout.write("Bridge autostart is OFF.\\n");
else if (command === "catalog") process.stdout.write("Wrote 2 models.\\n");
else if (command === "doctor") process.stdout.write("OK  isolated fixture\\n");
`);
  fs.writeFileSync(path.join(f.source, "tools", "gen-config.mjs"), `
import fs from "node:fs";
import path from "node:path";
fs.appendFileSync(process.env.TEST_ORDER_LOG, "gen-config\\n");
fs.mkdirSync(process.env.CODEX_COPILOT_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.CODEX_COPILOT_HOME, "config.toml"), "fixture = true\\n");
`);
}

function runInstaller(f, extraEnv = {}) {
  const inherited = { ...process.env };
  delete inherited.CODEX_COPILOT_BRIDGE_PORT;
  return spawnSync("bash", [path.join(f.source, "install.sh")], {
    env: {
      ...inherited, HOME: f.home,
      CODEX_COPILOT_HOME: f.profile,
      CODEX_COPILOT_SOURCE_HOME: path.join(f.directory, "stock-profile"),
      CODEX_COPILOT_INSTALL_ROOT: f.destination,
      CODEX_COPILOT_BIN_HOME: path.join(f.directory, "commands"),
      CODEX_COPILOT_NONINTERACTIVE: "1",
      CODEX_COPILOT_NO_ANIMATION: "1",
      CODEX_COPILOT_SHOWCASE_URL: "",
      TEST_ORDER_LOG: path.join(f.directory, "order.txt"),
      TEST_PORT_LOG: path.join(f.directory, "ports.txt"),
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function fakePrerequisites(f) {
  const stockCli = path.join(f.fakeBin, "codex");
  fs.writeFileSync(stockCli, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.156.0"; fi\n',
    { mode: 0o755 });
  let desktop;
  if (platform === "darwin") {
    desktop = path.join(f.home, "Applications", "ChatGPT.app");
    fs.mkdirSync(path.join(desktop, "Contents", "MacOS"), { recursive: true });
  } else {
    desktop = path.join(f.fakeBin, "chatgpt");
    fs.writeFileSync(desktop, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  return {
    PATH: `${f.fakeBin}${path.delimiter}${process.env.PATH}`,
    CODEX_COPILOT_DESKTOP_APP: desktop,
    CODEX_COPILOT_STOCK_CODEX: stockCli,
  };
}

test("Unix preflight enforces the order and never treats patched core as stock CLI", () => {
  const preflight = installer.slice(
    installer.indexOf('install_step 02 "先核对'),
    installer.indexOf("if (( CONFIGURE_ONLY )); then\n  install_step 03"),
  );
  assert.ok(preflight.indexOf("verify_copilot_entitlement") < preflight.indexOf("find_desktop_app"));
  assert.ok(preflight.indexOf("find_desktop_app") < preflight.indexOf("find_stock_codex"));
  assert.ok(
    installer.indexOf("find_stock_codex || true", installer.indexOf('install_step 02 "先核对')) <
      installer.lastIndexOf("  deploy_payload"),
  );
  assert.match(preflight, /CODEX_COPILOT_NONINTERACTIVE/);
  assert.match(preflight, /非交互前置资源检查未通过/);
  assert.doesNotMatch(preflight, /DESKTOP_SKIPPED|COPILOT_SKIPPED/);
  assert.match(installer, /Copilot[^\n]*models[^\n]*usable/);
  assert.match(installer, /deviceLogin\(\(flow\) =>/);
  assert.match(installer, /\}, \{ persist: false \}\)/);
  assert.ok(installer.lastIndexOf("\npersist_preflight_oauth\n") >
    installer.lastIndexOf("  deploy_payload"),
  "OAuth credential must not be persisted until after all prerequisites and deployment");
  assert.doesNotMatch(preflight, /bridge\/cli\.mjs" login --force/);
  assert.match(installer, /https:\/\/persistent\.oaistatic\.com\/codex-app-prod\/linux\/deb\/latest/);
  assert.match(installer, /https:\/\/persistent\.oaistatic\.com\/codex-app-prod\/linux\/rpm\/latest/);
  assert.match(installer, /https:\/\/persistent\.oaistatic\.com\/codex-app-prod\/linux\/install-arch\.sh/);
  assert.match(packageSource, /platforms", "linux", "bin", "codex-copilot-desktop"/);
  assert.match(packageSource, /desktopEnhancement: platform === "macos"/);
  assert.match(fs.readFileSync(path.join(root, "platforms", "linux", "bin", "codex-copilot-desktop"), "utf8"),
    /exec "\$NODE" "\$ROOT\/bridge\/desktop-launch\.mjs" "\$@"/);
});

if (isUnix) {
  test("Unix ccodex showcase reuses the installer guide without setup or profile writes", () =>
    fixture((f) => {
      fakeInstaller(f);
      for (const name of ["ccodex", "codex-copilot"]) {
        fs.copyFileSync(path.join(root, "platforms", "unix", "bin", name),
          path.join(f.source, "bin", name));
      }
      const workspace = path.join(f.directory, "not-created-workspace");
      const result = spawnSync("bash", [path.join(f.source, "bin", "ccodex"), "showcase"], {
        cwd: f.directory,
        env: {
          ...process.env,
          HOME: f.home,
          CCODEX_WORKSPACE: workspace,
          CODEX_COPILOT_HOME: f.profile,
          CODEX_COPILOT_DESKTOP_APP: "",
          CODEX_COPILOT_SHOWCASE_URL: "",
          CODEX_COPILOT_NO_ANIMATION: "1",
        },
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /✦ CODEX COPILOT/);
      assert.match(result.stdout,
        /\/model 按 Model → Default \/ Long Context → 支持的 Reasoning effort/);
      assert.match(result.stdout, /v1\.2\.99/);
      assert.match(result.stdout, /INSTALL FINISHED/);
      assert.match(result.stdout, /展示来源：包内快照/);
      assert.equal(fs.existsSync(workspace), false);
      assert.equal(fs.existsSync(f.profile), false);
      assert.equal(fs.existsSync(path.join(f.directory, "order.txt")), false);
    }));
}

test("validated stage and rollback reject broad/unrecognized roots", {
  skip: !isUnix,
}, () => fixture((f) => {
  const invalid = [
    "/",
    path.join(f.directory, "wrong-name"),
    `${path.dirname(f.destination)}/../codex-copilot`,
    path.join(f.source, "codex-copilot"),
    path.join(f.profile, "codex-copilot"),
  ];
  for (const candidate of invalid) {
    const result = harness(f, "validate_install_root", candidate);
    assert.notEqual(result.status, 0, `unsafe path was accepted: ${candidate}`);
    assert.match(result.stderr, /Unsafe installation root/);
  }
  fs.mkdirSync(f.destination, { recursive: true });
  fs.writeFileSync(path.join(f.destination, "keep.txt"), "unrelated data");
  const unknown = harness(f, "validate_install_root");
  assert.notEqual(unknown.status, 0);
  assert.equal(fs.readFileSync(path.join(f.destination, "keep.txt"), "utf8"), "unrelated data");
  fs.rmSync(f.destination, { recursive: true });
  const protectedDir = path.join(f.directory, "protected");
  fs.mkdirSync(protectedDir);
  fs.writeFileSync(path.join(protectedDir, "keep.txt"), "untouched");
  fs.symlinkSync(protectedDir, f.destination);
  assert.notEqual(harness(f, "validate_install_root").status, 0);
  assert.equal(fs.readFileSync(path.join(protectedDir, "keep.txt"), "utf8"), "untouched");
}));

test("Unix deployment swaps verified payload and cleans only owned temporary dirs", {
  skip: !isUnix,
}, () => fixture((f) => {
  oldInstallation(f);
  fs.writeFileSync(path.join(f.source, "new.txt"), "verified new installation");
  const result = harness(f, "deploy_payload");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.destination, "new.txt"), "utf8"),
    "verified new installation");
  assert.equal(fs.existsSync(path.join(f.destination, "old.txt")), false);
  assert.deepEqual(stageDirectories(f), []);
}));

test("Unix deployment restores previous installation on later failure", {
  skip: !isUnix,
}, () => fixture((f) => {
  oldInstallation(f);
  fs.writeFileSync(path.join(f.source, "new.txt"), "must roll back");
  const result = harness(f, "deploy_payload\nfalse");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /已恢复先前安装/);
  assert.equal(fs.readFileSync(path.join(f.destination, "old.txt"), "utf8"),
    "previous installation");
  assert.equal(fs.existsSync(path.join(f.destination, "new.txt")), false);
  assert.deepEqual(stageDirectories(f), []);
}));

test("staged core hash mismatch leaves old installation untouched", {
  skip: !isUnix,
}, () => fixture((f) => {
  oldInstallation(f);
  const marker = path.join(f.source, "platform-target.json");
  fs.writeFileSync(marker, JSON.stringify({ ...f.metadata, coreSha256: "0".repeat(64) }));
  const result = harness(f, "deploy_payload");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Staged core hash/);
  assert.equal(fs.readFileSync(path.join(f.destination, "old.txt"), "utf8"),
    "previous installation");
  assert.deepEqual(stageDirectories(f), []);
}));

test("staged executable symlinks are rejected without touching their targets", {
  skip: !isUnix,
}, () => fixture((f) => {
  oldInstallation(f);
  const nodeWrapper = path.join(f.source, "runtime", "node", "bin", "node");
  fs.unlinkSync(nodeWrapper);
  fs.symlinkSync(process.execPath, nodeWrapper);
  const result = harness(f, "deploy_payload");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Staged critical file must be a regular file/);
  assert.equal(fs.readFileSync(path.join(f.destination, "old.txt"), "utf8"),
    "previous installation");
  assert.deepEqual(stageDirectories(f), []);
}));

test("noninteractive Unix setup fails before deployment when Copilot OAuth is unverified", {
  skip: !isUnix,
}, () => fixture((f) => {
  fakeInstaller(f, { entitled: false });
  const result = runInstaller(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Copilot 资格/);
  assert.match(result.stderr, /不得静默部署/);
  assert.equal(fs.existsSync(f.destination), false);
  assert.equal(fs.existsSync(f.profile), false);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "order.txt"), "utf8").trim().split("\n"),
    ["status"]);
}));

test("verified OAuth permits no Copilot CLI while Desktop and stock CLI precede bridge/profile", {
  skip: !isUnix,
}, () => fixture((f) => {
  fakeInstaller(f);
  fs.mkdirSync(f.profile);
  fs.writeFileSync(path.join(f.profile, "bridge-port.txt"), "43210\n");
  const prerequisites = fakePrerequisites(f);
  const result = runInstaller(f, prerequisites);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /INSTALL FINISHED/);
  assert.match(result.stdout, /GitHub Copilot CLI.*OPTIONAL/);
  assert.match(result.stdout, /Codex CLI.*FOUND/);
  assert.equal(fs.readFileSync(path.join(f.profile, "codex-cli-path.txt"), "utf8").trim(),
    prerequisites.CODEX_COPILOT_STOCK_CODEX);
  assert.equal(fs.readFileSync(path.join(f.profile, "desktop-app-path.txt"), "utf8").trim(),
    prerequisites.CODEX_COPILOT_DESKTOP_APP);
  assert.equal(fs.readFileSync(path.join(f.profile, "config.toml"), "utf8"), "fixture = true\n");
  const calls = fs.readFileSync(path.join(f.directory, "order.txt"), "utf8").trim().split("\n");
  assert.deepEqual(calls, ["status", "gen-config", "status", "catalog", "autostart", "doctor"]);
  const bridgePorts = fs.readFileSync(path.join(f.directory, "ports.txt"), "utf8").trim().split("\n");
  assert.deepEqual(bridgePorts, [
    "status:43210", "status:43210", "catalog:43210", "autostart:43210", "doctor:43210",
  ]);
  assert.deepEqual(stageDirectories(f), []);
}));

test("noninteractive setup will not overwrite a pre-existing unrelated command", {
  skip: !isUnix,
}, () => fixture((f) => {
  fakeInstaller(f);
  const prerequisites = fakePrerequisites(f);
  const binHome = path.join(f.directory, "commands");
  fs.mkdirSync(binHome);
  fs.writeFileSync(path.join(binHome, "ccodex"), "user-owned command");
  const result = runInstaller(f, prerequisites);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /拒绝覆盖已有的非链接命令/);
  assert.equal(fs.existsSync(f.destination), false);
  assert.equal(fs.existsSync(f.profile), false);
  assert.equal(fs.readFileSync(path.join(binHome, "ccodex"), "utf8"), "user-owned command");
}));
