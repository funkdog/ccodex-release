import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CLI_PROFILE, prepareCliSettings } from "./surface-settings.mjs";
import { createCliSessionLease } from "./cli-session-ownership.mjs";
import { readSetting } from "../tools/config-document.mjs";

export function cliSessionArguments(home, args, bridgeProvider) {
  const separator = args.indexOf("--");
  const options = separator < 0 ? args : args.slice(0, separator);
  const hasProfile = options.some(arg =>
    arg === "-p" || arg === "--profile" || arg.startsWith("--profile="));
  return [
    ...(hasProfile ? [] : ["--profile", CLI_PROFILE]),
    "-c", `model_catalog_json=${JSON.stringify(path.join(home, "models.json"))}`,
    ...(bridgeProvider === "github-copilot" ? [
      "-c", 'model_providers.github-copilot.env_http_headers.x-ccodex-session-client="CCODEX_SESSION_CLIENT_ID"',
      "-c", 'model_providers.github-copilot.env_http_headers.x-ccodex-session-owner="CCODEX_SESSION_OWNER_PID"',
    ] : []),
    ...args,
  ];
}

export function cliSessionEnvironment(inherited, home = inherited?.CODEX_COPILOT_HOME || process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot")) {
  const env = {
    ...inherited,
    CODEX_COPILOT_SURFACE: "cli",
    CODEX_COPILOT_CATALOG_FILE: path.join(home, "models.json"),
    CCODEX_SESSION_CLIENT_ID: randomUUID(),
    CCODEX_SESSION_OWNER_PID: String(process.pid),
  };
  delete env.CODEX_COPILOT_SELECTION_FILE;
  return env;
}

export async function runCliSession({ core, arguments: originalArgs = process.argv.slice(3) } = {}) {
  if (!core || !fs.statSync(core).isFile()) throw new Error("The active enhanced CLI core is unavailable.");
  const home = process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot");
  const root = path.resolve(import.meta.dirname, "..");
  if (!originalArgs.includes("--json") && process.stderr?.isTTY) {
    try {
      const { showReleaseUpdateNotice } = await import("./release-update.mjs");
      showReleaseUpdateNotice({ root, home });
    } catch {}
  }
  prepareCliSettings(home);
  const provider = readSetting(fs.readFileSync(path.join(home, "config.toml"), "utf8"), [], "model_provider");
  const args = cliSessionArguments(home, originalArgs, provider);
  const env = cliSessionEnvironment(process.env);
  const resume = originalArgs.findIndex(arg => arg === "resume");
  const id = resume >= 0 && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(originalArgs[resume + 1] || "")
    ? originalArgs[resume + 1].toLowerCase() : null;
  const releaseLease = createCliSessionLease(home, env.CCODEX_SESSION_CLIENT_ID, id);
  process.once("exit", releaseLease);
  const proxy = path.resolve(import.meta.dirname, "../bin/ccodex-smart-paste.cjs");
  const command = fs.existsSync(path.join(root, "release.json"))
    ? (await import("../release/native-adapter.mjs")).nativeAdapterCommand(root, core, args)
    : { file: core, args };
  const child = spawn(process.execPath, [proxy, command.file, ...command.args], {
    cwd: process.cwd(), env, stdio: "inherit", windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    child.once("error", error => { releaseLease(); reject(error); });
    child.once("exit", code => {
      releaseLease();
      resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCliSession({ core: process.argv[2] }).then(code => { process.exitCode = code; }).catch(error => {
    console.error(`ccodex: ${error.message}`);
    process.exitCode = 1;
  });
}
