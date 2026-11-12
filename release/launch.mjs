import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { releaseEnvironment, releaseRoot } from "./environment.mjs";
import { pathToFileURL } from "node:url";
import { boundedJson, assertReleaseProfile, assertRegularPath } from "./paths.mjs";
import { ensureReleasePort } from "./bridge-port.mjs";
import { resolveDesktopMode } from "../bridge/desktop-mode.mjs";
import { prepareDesktopHotkeys } from "./desktop-hotkeys.mjs";
import { nativeAdapterCommand } from "./native-adapter.mjs";
import { FileValidationCache, withFileValidation } from "../bridge/file-validation-cache.mjs";

function execute(file, args, env, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd: releaseRoot, env, stdio: "inherit", windowsHide: true, ...options,
    });
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
}

function executeNative(file, args, env) {
  const command = nativeAdapterCommand(releaseRoot, file, args);
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      cwd: process.cwd(), env, stdio: "inherit", windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
}

async function runPreparedRelease(args = [], { inherited = process.env, selection } = {}) {
  const settingsFile = path.join(releaseRoot, "release-install.json");
  const install = fs.existsSync(settingsFile)
    ? boundedJson(settingsFile) : {};
  const desktop = args[0] === "desktop" && args[1] !== "update";
  let env = releaseEnvironment({
    home: selection?.home || install.profile, inherited, desktopHost: desktop,
  });
  if (args[0] === "features" || args[0] === "showcase") {
    return execute(path.join(releaseRoot, "release", "showcase.mjs"), [], env);
  }
  assertReleaseProfile(env.CODEX_HOME, releaseRoot, env);
  const readyFile = path.join(env.CODEX_HOME, "release-settings.json");
  const ready = fs.existsSync(readyFile) ? boundedJson(readyFile) : null;
  if (!ready || ready.installRoot !== releaseRoot) {
    const prepared = spawnSync(process.execPath, [
      path.join(releaseRoot, "release", "prepare-profile.mjs"),
      releaseRoot, env.CODEX_HOME,
    ], { env, cwd: releaseRoot, windowsHide: true, stdio: "inherit", timeout: 180000 });
    if (prepared.error || prepared.status !== 0) {
      throw prepared.error || new Error("The independent release profile is not ready.");
    }
    env = releaseEnvironment({ home: selection?.home || install.profile, inherited, desktopHost: desktop });
  }
  const direct = ["--version", "-V", "--help", "-h", "showcase", "features",
    "release-doctor", "release-update", "history", "sessions", "workiq"];
  if (!direct.includes(args[0]) && !(args[0] === "bridge" && args[1] === "stop")) {
    env.CODEX_COPILOT_BRIDGE_PORT = String(await ensureReleasePort(env.CODEX_HOME, releaseRoot));
    process.env.CODEX_COPILOT_BRIDGE_PORT = env.CODEX_COPILOT_BRIDGE_PORT;
  }
  if (args[0] === "release-doctor") {
    return execute(path.join(releaseRoot, "release", "verify.mjs"), ["--installed"], env);
  }
  if (desktop) {
    prepareDesktopHotkeys(releaseRoot, env.CODEX_HOME);
    const authFile = path.join(env.CODEX_HOME, "github-auth.json");
    if (!fs.existsSync(authFile)) {
      // Only an explicitly requested launch may initiate the user's sign-in.
      const login = await execute(path.join(releaseRoot, "bridge", "cli.mjs"),
        ["login", "--force"], env);
      if (login !== 0) return login;
    }
    const { launchDesktop } = await import("../bridge/desktop-launch.mjs");
    const result = await launchDesktop({
      root: releaseRoot, home: env.CODEX_HOME, inherited: env,
      arguments: args.slice(1), selection,
    });
    console.log(JSON.stringify({
      profile: result.profile, executable: result.executable,
      snapshot: result.snapshotVersion, reused: result.reused,
    }));
    return 0;
  }
  const bridgeCommands = new Set([
    "login", "logout", "status", "models", "use", "context", "credits", "usage",
    "sessions", "catalog", "autostart", "account", "doctor", "workiq", "verify",
    "inspect-request",
  ]);
  if (bridgeCommands.has(args[0])) {
    env.CODEX_COPILOT_SURFACE = "cli";
    return execute(path.join(releaseRoot, "bridge", "cli.mjs"), args, env);
  }
  if (args[0] === "history") {
    env.HISTORY_DEFAULT_PRODUCT = "ccodex";
    return execute(path.join(releaseRoot, "tools", "history", "cli.mjs"), args.slice(1), env);
  }
  if (args[0] === "bridge") {
    if (["stop", "status"].includes(args[1])) {
      return execute(path.join(releaseRoot, "bridge", "control.mjs"), [args[1]], env);
    }
    return execute(path.join(releaseRoot, "bridge", "ensure.mjs"), ["--verbose"], env);
  }
  if (args[0] === "update") {
    return execute(path.join(releaseRoot, "bridge", "cli-update.mjs"), args, env);
  }
  if (args[0] === "release-update") {
    return execute(path.join(releaseRoot, "bridge", "release-update.mjs"), args.slice(1), env);
  }
  if (args[0] === "desktop" && args[1] === "update") {
    return execute(path.join(releaseRoot, "bridge", "desktop-update-cli.mjs"), args.slice(2), env);
  }
  if (args[0] === "repair") {
    const result = await execute(path.join(releaseRoot, "release", "prepare-profile.mjs"),
      [releaseRoot, env.CODEX_HOME], env);
    if (result) return result;
    if (!fs.existsSync(path.join(env.CODEX_HOME, "github-auth.json"))) return 0;
    return execute(path.join(releaseRoot, "bridge", "cli.mjs"), ["catalog"], env);
  }
  if (args[0] === "export") {
    return execute(path.join(releaseRoot, "release", "export.mjs"), args.slice(1), env);
  }
  const metadata = boundedJson(path.join(releaseRoot, "release.json"));
  let core = path.join(releaseRoot, metadata.corePath);
  const selectedFile = path.join(releaseRoot, "bin", "core-current.txt");
  if (fs.existsSync(selectedFile)) {
    const { cliCoreSelection } = await import("../bridge/cli-update.mjs");
    core = cliCoreSelection({ root: releaseRoot, home: env.CODEX_HOME }).core;
  }
  assertRegularPath(core, { allowMissing: false });
  if (["--version", "-V", "--help", "-h"].includes(args[0])) {
    return executeNative(core, args, env);
  }
  if (!fs.existsSync(path.join(env.CODEX_HOME, "github-auth.json"))) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error("Ccodex requires its own sign-in. Run ccodex login --force.");
      return 1;
    }
    const login = await execute(path.join(releaseRoot, "bridge", "cli.mjs"), ["login", "--force"], env);
    if (login !== 0) return login;
  }
  const { repairNativeProfile } = await import("../tools/native-runtime.mjs");
  const repaired = repairNativeProfile({ home: env.CODEX_HOME, surface: "cli" });
  for (const warning of repaired.warnings) console.error(`ccodex native: ${warning}`);
  const { ensureBridge } = await import("../bridge/ensure.mjs");
  await ensureBridge();
  const { normalizeCliSelection } = await import("./model-selection.mjs");
  normalizeCliSelection(env.CODEX_HOME);
  const { runCliSession } = await import("../bridge/cli-session.mjs");
  return runCliSession({ core, arguments: args });
}

export async function runRelease(args = [], { inherited = process.env } = {}) {
  const installFile = path.join(releaseRoot, "release-install.json");
  const install = fs.existsSync(installFile) ? boundedJson(installFile) : {};
  const desktop = args[0] === "desktop" && args[1] !== "update";
  const selection = desktop ? resolveDesktopMode({ arguments: args.slice(1), inherited,
    legacyHome: install.profile || inherited.CODEX_COPILOT_HOME }) : null;
  if (selection && (selection.mode === "app-server-gateway" || selection.inspectOnly)) {
    const { launchDesktop } = await import("../bridge/desktop-launch.mjs");
    console.log(JSON.stringify(await launchDesktop({ root: releaseRoot, inherited, selection }), null, 2));
    return 0;
  }
  const env = releaseEnvironment({ home: selection?.home || install.profile, inherited, desktopHost: desktop });
  const metadata = boundedJson(path.join(releaseRoot, "release.json"));
  const cache = new FileValidationCache({ root: releaseRoot, home: env.CODEX_HOME,
    generation: `${metadata.releaseId}:${metadata.fileManifestSha256}` });
  const original = process.env;
  process.env = { ...env };
  try {
    return await withFileValidation(cache, () => runPreparedRelease(args, { inherited: env, selection }));
  } finally { process.env = original; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await runRelease(process.argv.slice(2));
  } catch (error) {
    console.error(`CCodex Release: ${error.message}`);
    process.exitCode = 1;
  }
}
