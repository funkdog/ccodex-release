import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const startupInherited = { ...process.env };

const installed = process.env.CCODEX_DEV_INSTALL_ROOT ||
  path.join(process.env.LOCALAPPDATA, "CodexCopilot");
const owner = JSON.parse(fs.readFileSync(path.join(installed, ".ccodex-dev-install.json"), "utf8"));
if (owner.product !== "CcodexDeveloper") throw new Error("This is not a developer installation.");
const source = path.resolve(owner.sourceRoot);
const home = path.resolve(owner.profile);
const env = { ...process.env, CODEX_HOME: home, CODEX_COPILOT_HOME: home,
  CODEX_COPILOT_CATALOG_FILE: path.join(home, "models.json"),
  CODEX_COPILOT_INSTALL_ROOT: installed, CODEX_COPILOT_SURFACE: "cli",
  HISTORY_DEFAULT_PRODUCT: "ccodex" };
delete env.CODEX_COPILOT_SELECTION_FILE;
process.env = env;
const moduleAt = name => import(pathToFileURL(path.join(installed, name)).href);
const { FileValidationCache, withFileValidation } = await moduleAt("bridge/file-validation-cache.mjs");
const { bridgeSourceGeneration } = await moduleAt("bridge/runtime-generation.mjs");
const generation = bridgeSourceGeneration(path.join(installed, "bridge"));
const cache = new FileValidationCache({ root: installed, home, generation });

async function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(installed, script), ...args],
      { cwd: process.cwd(), env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
}

async function currentPort() {
  const { ensureDeveloperBridgePort } = await moduleAt("developer/bridge-port.mjs");
  return ensureDeveloperBridgePort({
    root: installed, home, generation,
    ensure: async port => {
      env.CODEX_COPILOT_BRIDGE_PORT = port;
      process.env.CODEX_COPILOT_BRIDGE_PORT = port;
      const { ensureBridge } = await moduleAt("bridge/ensure.mjs");
      await ensureBridge();
    },
  });
}

try {
  process.exitCode = await withFileValidation(cache, async () => {
    const args = process.argv.slice(2);
    if (args[0] === "source") { console.log(source); return 0; }
    if (["features","showcase"].includes(args[0])) {
      return new Promise((resolve, reject) => {
        const child = spawn(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
          "-NoLogo","-NoProfile","-File",path.join(installed,"tools","showcase.ps1"),
        ], { env, stdio: "inherit", windowsHide: true });
        child.once("error", reject);
        child.once("exit", code => resolve(code ?? 1));
      });
    }
    if (args[0] === "desktop" && args[1] !== "update") {
      const { resolveDesktopMode } = await moduleAt("bridge/desktop-mode.mjs");
      const selection = resolveDesktopMode({ arguments: args.slice(1), inherited: startupInherited, legacyHome: home });
      const { launchDesktop } = await moduleAt("bridge/desktop-launch.mjs");
      console.log(JSON.stringify(await launchDesktop({ root: installed, inherited: selection.mode === "app-server-gateway" ? startupInherited : env, selection }), null, 2));
      return 0;
    }
    const { cliCoreSelection } = await moduleAt("bridge/cli-update.mjs");
    const core = cliCoreSelection({ root: installed, home }).core;
    if (["--version","-V","--help","-h"].includes(args[0])) {
      return new Promise((resolve, reject) => {
        const child = spawn(core, args, { env, stdio: "inherit", windowsHide: true });
        child.once("error", reject);
        child.once("exit", code => resolve(code ?? 1));
      });
    }
    if (!["workiq", "history"].includes(args[0]) &&
        !(args[0] === "bridge" && ["status", "stop"].includes(args[1])) &&
        !(args[0] === "autostart" && args.length === 1)) {
      env.CODEX_COPILOT_BRIDGE_PORT = await currentPort();
      process.env.CODEX_COPILOT_BRIDGE_PORT = env.CODEX_COPILOT_BRIDGE_PORT;
    }
    if (args[0] === "history") return run("tools/history/cli.mjs", args.slice(1));
    const commands = new Set(["login","logout","status","models","use","context","credits",
      "usage","sessions","catalog","autostart","account","doctor","workiq","verify","inspect-request"]);
    if (commands.has(args[0])) return run("bridge/cli.mjs", args);
    if (args[0] === "bridge") return run(["status","stop"].includes(args[1])
      ? "bridge/control.mjs" : "bridge/ensure.mjs", args.slice(1));
    if (args[0] === "update") return run("bridge/cli-update.mjs", args);
    if (args[0] === "release-update") return run("bridge/release-update.mjs", args.slice(1));
    if (args[0] === "repair") return run("tools/native-runtime.mjs", ["--desktop"]);
    if (!args.includes("-C") && !args.includes("--cd") &&
        !args.some(arg => arg.startsWith("--cd=")) && !process.env.CCODEX_NO_CD) {
      const workspace = process.env.CCODEX_DEV_WORKSPACE || path.join(os.homedir(), "Ccodex Workspace");
      fs.mkdirSync(workspace, { recursive: true });
      process.chdir(workspace);
    }
    const { repairNativeProfile } = await moduleAt("tools/native-runtime.mjs");
    repairNativeProfile({ home, surface: "cli" });
    const { ensureBridge } = await moduleAt("bridge/ensure.mjs");
    await ensureBridge();
    const { runCliSession } = await moduleAt("bridge/cli-session.mjs");
    return runCliSession({ core, arguments: args });
  });
} catch (error) {
  console.error(`ccodex-dev: ${error.message}`);
  process.exitCode = 1;
}
