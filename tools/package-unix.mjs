import { assertTypeScriptBuild } from "./typescript-state.mjs";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyCliCandidate } from "../bridge/cli-update.mjs";
import { desktopExtensionFiles } from "../bridge/desktop-extension-files.mjs";
import { sourceFingerprint } from "../bridge/update-state.mjs";
import { copyCliComponents } from "../bridge/cli-components.mjs";

const root = path.resolve(import.meta.dirname, "..");
assertTypeScriptBuild(root);
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const target = args.get("--target");
const core = args.get("--core");
const codexPkgDir = args.get("--codex-package-dir");
const manifestPath = args.get("--manifest");
const nodeDir = args.get("--node-dir");
const copilotDir = args.get("--copilot-dir");
const workiqDir = args.get("--workiq-dir");
const profileSeedDir = args.get("--profile-seed-dir");
const primaryPluginsDir = args.get("--primary-plugins-dir");
const outputDir = path.resolve(args.get("--output-dir") || path.join(root, "dist"));
const supported = new Set([
  "macos-arm64",
  "macos-x64",
  "linux-arm64",
  "linux-x64",
]);
if (!supported.has(target)) throw new Error(`Unsupported target '${target}'.`);
if (!core || !fs.existsSync(core)) throw new Error(`Core is missing: ${core}`);
if (!nodeDir || !fs.existsSync(path.join(nodeDir, "bin", "node"))) {
  throw new Error(`Node runtime is missing: ${nodeDir}`);
}

const [platform, arch] = target.split("-");
const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
const sourceRevision = fs.readFileSync(path.join(root, "CODEX-SOURCE-REVISION"), "utf8").trim();
const coreSha256 = crypto.createHash("sha256").update(fs.readFileSync(core)).digest("hex").toUpperCase();
const coreManifest = manifestPath ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
if (coreManifest && (
  coreManifest.packageVersion !== version
  || coreManifest.sourceRevision !== sourceRevision
  || coreManifest.target !== target
  || coreManifest.sha256.toUpperCase() !== coreSha256
)) {
  throw new Error(`Core build manifest is stale or mismatched for ${target}.`);
}
for (const patch of coreManifest?.patches || []) {
  if (path.basename(patch.name) !== patch.name) throw new Error("Invalid patch manifest path.");
  const actual = crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(root, "patches", patch.name))).digest("hex");
  if (actual !== patch.sha256.toLowerCase()) throw new Error(`Patch changed after the core build: ${patch.name}`);
}
const packageName = `codex-copilot-${target}-${version}`;
const guidedSetupNotice =
  "Run 'codex-copilot setup' as your normal user: verify Copilot OAuth/SDK, then official ChatGPT Desktop and separate stock Codex CLI, before configuring the ccodex bridge/profile. Missing prerequisites stop setup; first launch runs it automatically.";
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `${packageName}-`));
const payload = path.join(temporary, packageName);
const shared = [
  "package.json", "package-lock.json", "tsconfig.json",
  "README.md",
  "WORKIQ.md",
  "NATIVE_COMPATIBILITY.md",
  "RELEASE_NOTES.md",
  "MIGRATION.md",
  "MIGRATION.zh-CN.md",
  "VERSION",
  "CODEX-SOURCE-REVISION",
  "NATIVE_PATCH_CHAIN.json",
  "assets",
  "bridge", "gateway",
  "patches",
  "release",
  "skills",
];
const textExtensions = new Set([
  ".swift",
  ".json",
  ".md",
  ".mjs",
  ".mts",
  ".map",
  ".sh",
  ".toml",
  ".txt",
]);
const tokenPattern =
  /gh(?:o|u|p)_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/;

function copy(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function assertCredentialFree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      assertCredentialFree(file);
    } else if (
      entry.isFile() &&
      textExtensions.has(path.extname(entry.name).toLowerCase()) &&
      tokenPattern.test(fs.readFileSync(file, "utf8"))
    ) {
      throw new Error(`Potential credential found in package: ${file}`);
    }
  }
}

function createSystemRoot(destination, prefix) {
  const installRoot = path.join(destination, prefix.replace(/^\/+/, ""));
  copy(payload, installRoot);
  const commandDir = path.join(destination, "usr", "local", "bin");
  fs.mkdirSync(commandDir, { recursive: true });
  for (const command of ["codex-copilot", "ccodex"]) {
    fs.symlinkSync(
      path.relative(commandDir, path.join(installRoot, "bin", command)),
      path.join(commandDir, command),
    );
  }
  fs.symlinkSync(
    path.relative(commandDir, path.join(installRoot, "bin", "codex-copilot-desktop")),
    path.join(commandDir, "codex-copilot-desktop"),
  );
}

function packageDeb() {
  const debRoot = path.join(temporary, "deb-root");
  createSystemRoot(debRoot, "/opt/codex-copilot");
  const controlDir = path.join(debRoot, "DEBIAN");
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(
    path.join(controlDir, "control"),
    `Package: codex-copilot
Version: ${version}
Architecture: ${arch === "x64" ? "amd64" : "arm64"}
Maintainer: CodexCopilot
Depends: libc6 (>= 2.39), libgcc-s1, libstdc++6
Description: GitHub Copilot powered Codex CLI bridge
`,
  );
  const postinst = path.join(controlDir, "postinst");
  fs.writeFileSync(postinst, `#!/bin/sh\nset -e\necho "${guidedSetupNotice}"\n`);
  fs.chmodSync(postinst, 0o755);
  execFileSync(
    "dpkg-deb",
    [
      "--build",
      "--root-owner-group",
      "--threads-max=6",
      debRoot,
      path.join(outputDir, `${packageName}.deb`),
    ],
    { stdio: "inherit" },
  );
}

function packageRpm() {
  const top = path.join(temporary, "rpmbuild");
  for (const dir of ["BUILD", "BUILDROOT", "RPMS", "SOURCES", "SPECS", "SRPMS"]) {
    fs.mkdirSync(path.join(top, dir), { recursive: true });
  }
  const sourceName = `${packageName}.tar.gz`;
  execFileSync(
    "tar",
    [
      "-czf",
      path.join(top, "SOURCES", sourceName),
      "-C",
      temporary,
      packageName,
    ],
    { stdio: "inherit" },
  );
  const rpmArch = arch === "x64" ? "x86_64" : "aarch64";
  const spec = `%global __os_install_post %{nil}
Name: codex-copilot
Version: ${version}
Release: 1
Summary: GitHub Copilot powered Codex CLI bridge
License: MIT
Requires: glibc >= 2.39
Source0: ${sourceName}

%description
GitHub Copilot powered Codex CLI bridge.

%prep
%setup -q -n ${packageName}

%install
mkdir -p %{buildroot}/opt/codex-copilot %{buildroot}/usr/local/bin
cp -a . %{buildroot}/opt/codex-copilot/
ln -s ../../../opt/codex-copilot/bin/codex-copilot %{buildroot}/usr/local/bin/codex-copilot
ln -s ../../../opt/codex-copilot/bin/ccodex %{buildroot}/usr/local/bin/ccodex
ln -s ../../../opt/codex-copilot/bin/codex-copilot-desktop %{buildroot}/usr/local/bin/codex-copilot-desktop

%post
echo "${guidedSetupNotice}"

%files
/opt/codex-copilot
/usr/local/bin/codex-copilot
/usr/local/bin/ccodex
/usr/local/bin/codex-copilot-desktop
`;
  const specFile = path.join(top, "SPECS", "codex-copilot.spec");
  fs.writeFileSync(specFile, spec);
  execFileSync(
    "rpmbuild",
    [
      "-bb", "--target", rpmArch, "--define", `_topdir ${top}`,
      "--define", "_smp_build_ncpus 6", "--define", "_smp_mflags -j6", specFile,
    ],
    { stdio: "inherit" },
  );
  const rpm = fs
    .readdirSync(path.join(top, "RPMS", rpmArch))
    .find((file) => file.endsWith(".rpm"));
  fs.copyFileSync(
    path.join(top, "RPMS", rpmArch, rpm),
    path.join(outputDir, `${packageName}.rpm`),
  );
}

try {
  fs.mkdirSync(payload, { recursive: true });
  for (const item of shared) copy(path.join(root, item), path.join(payload, item));
  // Generator, bridge, isolation and updater modules share the same tool
  // dependency closure. Do not ship two entry points without their imports.
  copy(path.join(root, "tools"), path.join(payload, "tools"));

  copy(
    path.join(root, "platforms", "unix", "install.sh"),
    path.join(payload, "install.sh"),
  );
  fs.mkdirSync(path.join(payload, "bin"), { recursive: true });
  for (const launcher of ["codex-copilot", "ccodex", "bridge-port.sh"]) {
    copy(
      path.join(root, "platforms", "unix", "bin", launcher),
      path.join(payload, "bin", launcher),
    );
  }
  for (const helper of [
    "ccodex-smart-paste.cjs",
    "ccodex-input.cjs",
    "ccodex-composer.cjs",
    "ccodex-local-command.cjs",
    "xterm-headless",
    "node-pty",
  ]) {
    if (fs.existsSync(path.join(root, "bin", helper))) {
      copy(path.join(root, "bin", helper), path.join(payload, "bin", helper));
    }
  }
  for (const helperPlat of ["darwin-arm64", "darwin-x64"]) {
    const spawnHelper = path.join(payload, "bin", "node-pty", "prebuilds", helperPlat, "spawn-helper");
    if (fs.existsSync(spawnHelper)) fs.chmodSync(spawnHelper, 0o755);
  }
  if (platform === "macos") {
    copy(
      path.join(root, "platforms", "macos", "bin", "codex-copilot-desktop"),
      path.join(payload, "bin", "codex-copilot-desktop"),
    );
  } else {
    copy(
      path.join(root, "platforms", "linux", "bin", "codex-copilot-desktop"),
      path.join(payload, "bin", "codex-copilot-desktop"),
    );
  }
  copy(core, path.join(payload, "bin", "codex-copilot-core"));
  if (codexPkgDir && fs.existsSync(codexPkgDir)) {
    const codeModeHost = path.join(codexPkgDir, "bin", "codex-code-mode-host");
    if (fs.existsSync(codeModeHost)) {
      copy(codeModeHost, path.join(payload, "bin", "codex-code-mode-host"));
      fs.chmodSync(path.join(payload, "bin", "codex-code-mode-host"), 0o755);
    }
    for (const sub of ["codex-path", "codex-resources"]) {
      const srcSub = path.join(codexPkgDir, sub);
      if (fs.existsSync(srcSub)) {
        copy(srcSub, path.join(payload, "bin", sub));
      }
    }
  }
  if (coreManifest) {
    copyCliComponents({
      sourceCore: core, destinationCore: path.join(payload, "bin", "codex-copilot-core"),
      manifest: coreManifest, target,
    });
    writeJson(path.join(payload, "bin", "codex-copilot-core.manifest.json"), coreManifest);
    const compatibility = path.join(path.dirname(core), "cli-update-compatibility.json");
    if (!fs.existsSync(compatibility)) throw new Error("Unix core lacks actual CLI update compatibility evidence.");
    copy(compatibility, path.join(payload, "bin", "cli-update-compatibility.json"));
    verifyCliCandidate({
      root: payload, candidateRoot: payload, target,
      generation: sourceFingerprint(payload, desktopExtensionFiles(payload)),
    });
  }
  copy(nodeDir, path.join(payload, "runtime", "node"));
  if (copilotDir && fs.existsSync(copilotDir)) {
    copy(copilotDir, path.join(payload, "runtime", "copilot"));
  }
  if (workiqDir && fs.existsSync(workiqDir)) {
    copy(workiqDir, path.join(payload, "runtime", "workiq"));
  }
  if (profileSeedDir && fs.existsSync(profileSeedDir)) {
    copy(profileSeedDir, path.join(payload, "profile-seed"));
  }
  if (primaryPluginsDir && fs.existsSync(primaryPluginsDir)) {
    copy(primaryPluginsDir, path.join(payload, "runtime", "primary", "codex-primary-runtime"));
  }
  writeJson(path.join(payload, "platform-target.json"), {
    schemaVersion: 1,
    target,
    os: platform,
    arch,
    desktop: true,
    desktopEnhancement: platform === "macos",
    packageVersion: version,
    sourceRevision,
    coreSha256,
    ...(coreManifest ? { patchedTree: coreManifest.patchedTree } : {}),
    ...(platform === "macos" ? { minimumOsVersion: "13.0" } : {}),
    ...(platform === "linux" ? { minimumGlibc: "2.39" } : {}),
  });

  for (const executable of [
    "install.sh",
    "bin/codex-copilot",
    "bin/ccodex",
    "bin/codex-copilot-desktop",
    "bin/codex-copilot-core",
    "runtime/node/bin/node",
  ]) {
    fs.chmodSync(path.join(payload, executable), 0o755);
  }
  assertCredentialFree(payload);

  fs.mkdirSync(outputDir, { recursive: true });
  execFileSync(
    "tar",
    [
      "-czf",
      path.join(outputDir, `${packageName}.tar.gz`),
      "-C",
      temporary,
      packageName,
    ],
    { stdio: "inherit" },
  );
  if (platform === "linux") {
    if (process.platform === "linux") {
      packageDeb();
      packageRpm();
    }
  } else if (process.platform === "darwin") {
    const pkgRoot = path.join(temporary, "pkg-root");
    createSystemRoot(pkgRoot, "/usr/local/lib/codex-copilot");
    const pkgScripts = path.join(temporary, "pkg-scripts");
    fs.mkdirSync(pkgScripts, { recursive: true });
    const postinstall = path.join(pkgScripts, "postinstall");
    fs.writeFileSync(postinstall, `#!/bin/sh\nset -e\necho "${guidedSetupNotice}"\n`);
    fs.chmodSync(postinstall, 0o755);
    execFileSync(
      "pkgbuild",
      [
        "--root",
        pkgRoot,
        "--identifier",
        "com.github.codex-copilot",
        "--version",
        version,
        "--install-location",
        "/",
        "--scripts",
        pkgScripts,
        path.join(outputDir, `${packageName}.pkg`),
      ],
      { stdio: "inherit" },
    );
  }
  process.stdout.write(`Packaged ${target} in ${outputDir}\n`);
} finally {
  if (path.dirname(fs.realpathSync(temporary)) !== fs.realpathSync(os.tmpdir())) {
    throw new Error("Refusing to clean a package directory outside the temporary workspace.");
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
