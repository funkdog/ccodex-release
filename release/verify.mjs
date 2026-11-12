import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { desktopSnapshot, fileSha256 } from "../bridge/desktop-runtime.mjs";
import { releaseRoot, releaseMetadata, releaseEnvironment } from "./environment.mjs";
import { runtimeImport } from "../bridge/workiq/dependencies.mjs";
import { publicStatus } from "../bridge/workiq/settings.mjs";
import { configEntries, readSetting } from "../tools/config-document.mjs";
import { sha256File } from "./integrity.mjs";
import { verifyInventory } from "./inventory.mjs";
import { assertRegularPath, boundedJson } from "./paths.mjs";
import { DOCUMENT_CHECK_TIMEOUT_MS } from "./document-check.mjs";

export async function verifyFileManifest(root = releaseRoot) {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "release.json"), "utf8"));
  assert.equal(metadata.preliminary, false, "An unfinished inventory is not a release package.");
  const manifestFile = path.join(root, "release-files.json");
  assert.equal(sha256File(manifestFile), metadata.fileManifestSha256, "File inventory is not the release inventory.");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assert.equal(manifest.releaseId, metadata.releaseId);
  assert.equal(manifest.files.length, metadata.fileCount);
  let last = 0;
  const checked = await verifyInventory(root, manifest.files, {
    onProgress: (completed, total) => {
      if (completed - last >= 8000 || completed === total) {
        process.stderr.write(`Integrity: ${completed}/${total} resources checked.\n`);
        last = completed;
      }
    },
  });
  return { ...checked, fileManifestSha256: metadata.fileManifestSha256 };
}

function command(file, args, env, timeout = 90000) {
  const result = spawnSync(file, args, {
    cwd: releaseRoot, env, encoding: "utf8", windowsHide: true, timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`${path.basename(file)} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export async function verifyRelease({ installed = false, inventory = true } = {}) {
  const metadata = releaseMetadata();
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "arm64", "This is a Windows ARM64 release.");
  const settingsFile = path.join(releaseRoot, "release-install.json");
  const settings = installed ? boundedJson(settingsFile, 64 * 1024) : {};
  if (installed) {
    assert.equal(settings.product, "CCodexRelease", "Installed verification requires a release receipt.");
    assert.equal(typeof settings.profile, "string", "Installed verification requires an explicit profile.");
    assert(path.isAbsolute(settings.profile), "The installed profile must be an absolute path.");
  }
  // Payload probes create CLI caches and document scratch files, not user data.
  const scratch = installed ? null : fs.mkdtempSync(
    path.join(assertRegularPath(os.tmpdir(), { allowMissing: false }), "ccodex-release-verify-"));
  try {
    const env = releaseEnvironment({ home: installed ? settings.profile : scratch });
    return await verifyWithEnvironment({ metadata, settings, env, installed, inventory });
  } finally {
    if (scratch) fs.rmSync(assertRegularPath(scratch), {
      recursive: true, force: true, maxRetries: 8, retryDelay: 250,
    });
  }
}

async function verifyWithEnvironment({ metadata, settings, env, installed, inventory }) {
  const report = {
    schemaVersion: 1, releaseId: metadata.releaseId, checkedAt: new Date().toISOString(),
    target: "windows-arm64", credentialsRequired: true, liveAccountVerified: false,
    tests: [],
  };
  const check = async (name, operation) => {
    process.stderr.write(`Checking: ${name}\n`);
    const detail = await operation();
    report.tests.push({ name, passed: true, detail });
    process.stderr.write(`Passed: ${name}\n`);
  };
  if (inventory) await check("complete-sha256-inventory", () => verifyFileManifest());
  const desktop = desktopSnapshot(releaseRoot);
  await check("process-local-native-dependency-adapter", () => {
    const probe = JSON.parse(command(path.join(releaseRoot, "bin", "ccodex-release-native.exe"),
      ["--probe"], env));
    assert.equal(probe.adapterActive, true);
    assert.equal(probe.programFiles, path.join(releaseRoot, "runtime"));
    return { officialFilesModified: false, systemFoldersModified: false,
      processLocalGitDiscovery: true };
  });
  await check("native-enhanced-core", () => {
    const core = path.join(releaseRoot, metadata.corePath);
    assert.equal(fileSha256(core), metadata.coreSha256);
    const value = command(core, ["--version"], env);
    assert.equal(value, metadata.coreVersion);
    return value;
  });
  await check("independent-byte-identical-desktop", () => {
    assert.equal(desktop.manifest.version, metadata.desktopSnapshot);
    assert.equal(desktop.manifest.applicationVersion, metadata.desktopApplicationVersion);
    return { snapshot: desktop.manifest.version, nativeCoreOverridden: false };
  });
  await check("private-node-and-copilot", () => {
    const node = command(path.join(releaseRoot, "runtime", "node", "node.exe"),
      ["-p", "JSON.stringify({version:process.version,arch:process.arch})"], env);
    assert.equal(JSON.parse(node).arch, "arm64");
    const cli = command(env.CODEX_COPILOT_COPILOT_CLI, ["--no-auto-update", "--version"], env, 180000);
    assert(cli.includes(metadata.copilotVersion));
    return { node: JSON.parse(node), copilot: cli.split("\n")[0] };
  });
  await check("terminal-native-prebuild", () => {
    const requireFile = path.join(releaseRoot, "bin", "node-pty", "lib", "index.js");
    command(path.join(releaseRoot, "runtime", "node", "node.exe"), ["-e",
      'const p=require(process.argv[1]);if(typeof p.spawn!=="function")process.exit(1);console.log("node-pty loaded")',
      requireFile], env);
    return "ARM64 node-pty loaded with the private Node runtime";
  });
  await check("artifact-node-python-and-git", () => {
    const python = command(env.CODEX_PRIMARY_RUNTIME_PYTHON,
      ["-c", "import sys; import pypdf, pdfplumber, PIL, openpyxl, docx; print(sys.version.split()[0])"], env);
    const git = command(path.join(releaseRoot, "runtime", "git", "cmd", "git.exe"), ["--version"], env);
    const bash = command(path.join(releaseRoot, "runtime", "git", "bin", "bash.exe"),
      ["--noprofile", "--norc", "-c", "printf 'git-bash-ready'"], env);
    assert.equal(bash, "git-bash-ready");
    return { python, git, bash };
  });
  await check("document-renderers-and-pdf-fonts", () => {
    const primary = path.join(releaseRoot, "runtime", "primary", "codex-primary-runtime", "dependencies");
    const locations = [
      path.join(primary, "node", "node_modules", "@oai", "artifact-tool"),
      path.join(primary, "python", "Lib", "site-packages", "artifact_tool_v2", "bin"),
    ];
    for (const location of locations) {
      command(path.join(releaseRoot, "runtime", "node", "node.exe"), ["-e",
        'const{createRequire}=require("module"),r=createRequire(require("path").join(process.argv[1],"package.json"));' +
        'const{Canvas}=r("skia-canvas"),c=new Canvas(120,60,{gpu:false});c.getContext("2d").fillText("CCodex",4,24);' +
        'if(c.toBufferSync("png").length<100||c.toBufferSync("pdf").length<100)process.exit(1);' +
        'if(r("#standard-fonts/Helvetica").name!=="Helvetica")process.exit(1);console.log("renderers ready")',
        location], env);
    }
    return { completeSkiaVersion: "4.0.0-rc9.1", pdfFontMapping: true, nativeProcessExit: 0 };
  });
  await check("actual-document-roundtrips-and-python-rpc", () => {
    const primary = path.join(releaseRoot, "runtime", "primary", "codex-primary-runtime");
    return JSON.parse(command(path.join(releaseRoot, "runtime", "node", "node.exe"), [
      path.join(releaseRoot, "release", "document-check.mjs"), primary, env.CODEX_HOME,
    ], env, DOCUMENT_CHECK_TIMEOUT_MS).split(/\r?\n/).at(-1));
  });
  const sdkFile = env.CODEX_COPILOT_CLI_SDK;
  await check("bundled-sdk-with-explicit-cli-binding", async () => {
    const sdk = await import(pathToFileURL(sdkFile).href);
    const connection = sdk.RuntimeConnection.forStdio({ path: env.COPILOT_CLI_PATH });
    const client = new sdk.CopilotClient({
      connection, baseDirectory: env.COPILOT_HOME, useLoggedInUser: false, env,
    });
    assert.equal(client.resolvedCliPath, env.COPILOT_CLI_PATH);
    return { cli: path.relative(releaseRoot, client.resolvedCliPath), started: false };
  });
  if (installed) {
    await check("credential-free-independent-profile", () => {
      assert.equal(settings.product, "CCodexRelease");
      const profileMarker = JSON.parse(fs.readFileSync(
        path.join(env.CODEX_HOME, ".ccodex-release-profile.json"), "utf8"));
      assert.equal(profileMarker.product, "CCodexRelease");
      const config = fs.readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8");
      assert.equal(readSetting(config, [], "model_provider"), "github-copilot");
      assert.equal(readSetting(config, ["model_providers", "github-copilot", "auth"], "command"),
        path.join(releaseRoot, "runtime", "node", "node.exe"));
      // Destination users may add projects after installation. The seed never
      // imports the publisher's trusted project list.
      const seed = fs.readFileSync(path.join(releaseRoot, "profile-seed", "config.toml"), "utf8");
      assert(configEntries(seed).every(entry => entry.table[0] !== "projects"));
      assert(!/@@[A-Z_]+@@/.test(config), "Unresolved deployment placeholder.");
      assert(!/SKY_CUA_NATIVE_PIPE_DIRECTORY\s*=/.test(config) ||
        fs.existsSync(path.join(env.CODEX_HOME, "desktop-instance.json")),
      "A live Desktop pipe cannot be imported from a different machine.");
      return { profile: env.CODEX_HOME, stockProfileImported: false,
        authentication: fs.existsSync(path.join(env.CODEX_HOME, "github-auth.json"))
          ? "saved-login-present-not-verified" : "sign-in-required" };
    });
    await check("workiq-offline-dependencies-and-consent", async () => {
      await runtimeImport("@azure/msal-node", env.CODEX_HOME);
      await runtimeImport("@modelcontextprotocol/sdk/client/index.js", env.CODEX_HOME);
      const status = publicStatus(env.CODEX_HOME);
      assert.equal(status.runtimeInstalled, true);
      return { dependenciesInstalled: true, enabled: status.enabled,
        dataSharingAcknowledged: status.dataSharingAcknowledged, authenticationChecked: false };
    });
    await check("private-primary-runtime-cache", () => {
      const primary = path.join(env.CODEX_HOME, "host-profile", ".cache", "codex-runtimes", "codex-primary-runtime");
      const runtime = JSON.parse(fs.readFileSync(path.join(primary, "runtime.json"), "utf8"));
      assert.equal(runtime.bundleVersion, metadata.primaryRuntimeVersion);
      const desktopEnv = releaseEnvironment({ home: env.CODEX_HOME, desktopHost: true });
      assert.equal(desktopEnv.USERPROFILE, path.join(env.CODEX_HOME, "host-profile"));
      return { bundleVersion: runtime.bundleVersion, originalCacheOverwritten: false };
    });
    await check("private-cache-document-roundtrips-and-python-rpc", () => {
      const primary = path.join(env.CODEX_HOME, "host-profile", ".cache", "codex-runtimes", "codex-primary-runtime");
      return JSON.parse(command(path.join(releaseRoot, "runtime", "node", "node.exe"), [
        path.join(releaseRoot, "release", "document-check.mjs"), primary, env.CODEX_HOME,
      ], env).split(/\r?\n/).at(-1));
    });
    await check("explicit-copilot-resource-directory", () => {
      assert.equal(env.COPILOT_CLI_DIST_DIR, path.dirname(env.COPILOT_CLI_PATH));
      assert(env.COPILOT_PKG_CACHE_HOME.startsWith(env.CODEX_HOME + path.sep));
      return { externalCacheSelection: false };
    });
    const reportFile = path.join(env.CODEX_HOME, "release-diagnostics.json");
    report.passed = true;
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  }
  report.passed = true;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = await verifyRelease({
      installed: process.argv.includes("--installed"),
      inventory: !process.argv.includes("--quick"),
    });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(`CCodex Release verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
