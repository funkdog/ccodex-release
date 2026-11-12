import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { releaseEnvironment, releaseRoot, releaseMetadata } from "./environment.mjs";
import { configEntries, editSettings, stringArray } from "../tools/config-document.mjs";
import { atomicWrite, renderManagedConfig, readSettings, publicStatus } from "../bridge/workiq/settings.mjs";
import { ensureChildIsolationSettings, ensureManagedUiSettings } from "../tools/gen-config.mjs";
import { assertReleaseProfile, assertRegularPath, boundedJson, acquireFileLock } from "./paths.mjs";
import { readProcessIdentity, sameProcessLifetime } from "../bridge/desktop-process.mjs";
import { synchronizePrimaryOverrides, restorePinnedPrimaryRuntime } from "./primary-overrides.mjs";
import { prepareDesktopHotkeys } from "./desktop-hotkeys.mjs";
import { seedDesktopPreferences } from "./desktop-ui-settings.mjs";

export function retirePreviousDesktop(home, root, inspect = readProcessIdentity) {
  const file = path.join(home, "desktop-instance.json");
  if (!fs.existsSync(file)) return false;
  assertRegularPath(file, { allowMissing: false });
  const receipt = boundedJson(file, 256 * 1024);
  if (receipt.schemaVersion !== 2 || typeof receipt.profile !== "string" ||
      path.resolve(receipt.profile).toLowerCase() !== path.resolve(home).toLowerCase() ||
      typeof receipt.installRoot !== "string") {
    throw new Error("Unrecognized Desktop receipt; it was preserved for inspection.");
  }
  const sameRoot = path.resolve(receipt.installRoot).toLowerCase() === path.resolve(root).toLowerCase();
  let liveDesktop = false;
  let liveHelper = false;
  for (const identity of [receipt.identity, receipt.helperIdentity].filter(Boolean)) {
    if (!Number.isSafeInteger(identity.pid) || identity.pid < 1 || !identity.lifetime) {
      throw new Error("Unrecognized previous Desktop lifetime; no state was changed.");
    }
    if (sameProcessLifetime(identity, inspect(identity.pid, { expectedLifetime: identity.lifetime }))) {
      if (identity === receipt.identity) liveDesktop = true;
      else liveHelper = true;
    }
  }
  if (sameRoot && liveDesktop) return false;
  if (liveDesktop || liveHelper) {
    throw new Error("Close the previous release Desktop before upgrading or reinstalling. No process was stopped.");
  }
  fs.renameSync(file, path.join(home, `desktop-instance-retired-${crypto.randomUUID()}.json`));
  return true;
}

function safeProfile(home, root) {
  return assertReleaseProfile(home, root);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function copyMissing(source, destination) {
  if (!fs.existsSync(source)) return;
  assertRegularPath(destination);
  fs.cpSync(source, destination, {
    recursive: true, force: false, errorOnExist: false,
    filter: (from, to) => {
      if (fs.lstatSync(from).isSymbolicLink()) throw new Error("Seed resources cannot contain links.");
      if (!fs.existsSync(to)) return true;
      const stat = fs.lstatSync(to);
      if (stat.isSymbolicLink()) throw new Error("Profile seed cannot overwrite links.");
      return stat.isDirectory();
    },
  });
}

function setNativeConfig(config, { root, home, env, metadata }) {
  const resources = path.join(root, "desktop", "versions", metadata.desktopSnapshot, "app", "resources");
  const nodeRoot = path.join(resources, "cua_node", "bin");
  const browser = path.join(home, "plugins", "cache", "openai-bundled", "browser",
    metadata.desktopApplicationVersion, "scripts", "browser-service.mjs");
  config = editSettings(config, ["mcp_servers", "node_repl"], {
    command: JSON.stringify(path.join(nodeRoot, "node_repl.exe")),
    args: "[]",
    env_vars: '["CODEX_WINDOWS_REGISTERED_CORE"]',
    startup_timeout_sec: "120",
  });
  config = editSettings(config, ["mcp_servers", "node_repl", "env"], {
    CODEX_HOME: JSON.stringify(home),
    NODE_REPL_NODE_PATH: JSON.stringify(path.join(nodeRoot, "node.exe")),
    NODE_REPL_NODE_MODULE_DIRS: JSON.stringify(path.join(nodeRoot, "node_modules")),
    NODE_REPL_TRUSTED_CODE_PATHS: JSON.stringify([home, path.join(nodeRoot, "node_modules")].join(";")),
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: '"1000"',
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify(JSON.stringify({
      browser: browser.replace(/\\/g, "/"), sky: "@oai/sky/service",
    })),
    NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER:
      '"Control the in-app browser in conjunction with the Browser Plugin."',
    NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME:
      '"Control the Chrome browser in conjunction with the Chrome Plugin."',
    BROWSER_USE_AVAILABLE_BACKENDS: '"chrome,iab,mcpapps"',
    BROWSER_USE_TINYSKY_ENABLED: '"1"',
    BROWSER_USE_CODEX_APP_BUILD_FLAVOR: '"prod"',
    BROWSER_USE_CODEX_APP_VERSION: JSON.stringify(metadata.desktopApplicationVersion),
    CODEX_CLI_PATH: JSON.stringify(path.join(resources, "codex.exe")),
    NODE_REPL_UNTRUSTED_ENV_ALLOWLIST: '"CODEX_WINDOWS_REGISTERED_CORE"',
    ProgramFiles: JSON.stringify(env.CCODEX_REAL_PROGRAMFILES),
    ProgramW6432: JSON.stringify(env.CCODEX_REAL_PROGRAMW6432),
    "ProgramFiles(x86)": JSON.stringify(env.CCODEX_REAL_PROGRAMFILES_X86),
  });
  config = editSettings(config, ["marketplaces", "openai-bundled"], {
    source_type: '"local"',
    source: JSON.stringify(path.join(resources, "plugins", "openai-bundled")),
  });
  const primary = path.join(home, "host-profile", ".cache", "codex-runtimes",
    "codex-primary-runtime");
  const python = path.join(primary, "dependencies", "python");
  config = editSettings(config, ["marketplaces", "openai-primary-runtime"], {
    source_type: '"local"',
    source: JSON.stringify(path.toNamespacedPath(path.join(primary, "plugins", "openai-primary-runtime"))),
  });
  config = editSettings(config, ["shell_environment_policy", "set"], {
    USERPROFILE: JSON.stringify(env.CCODEX_REAL_USERPROFILE),
    HOME: JSON.stringify(env.CCODEX_REAL_USERPROFILE),
    LOCALAPPDATA: JSON.stringify(env.CCODEX_REAL_LOCALAPPDATA),
    APPDATA: JSON.stringify(env.CCODEX_REAL_APPDATA),
    TEMP: JSON.stringify(env.CCODEX_REAL_TEMP),
    TMP: JSON.stringify(env.CCODEX_REAL_TEMP),
    PSModulePath: JSON.stringify(env.CCODEX_REAL_PSMODULEPATH),
    ProgramFiles: JSON.stringify(env.CCODEX_REAL_PROGRAMFILES),
    ProgramW6432: JSON.stringify(env.CCODEX_REAL_PROGRAMW6432),
    "ProgramFiles(x86)": JSON.stringify(env.CCODEX_REAL_PROGRAMFILES_X86),
    CODEX_PRIMARY_RUNTIME_ROOT: JSON.stringify(primary),
    CODEX_PRIMARY_RUNTIME_NODE: JSON.stringify(path.join(primary, "dependencies", "node", "bin", "node.exe")),
    CODEX_PRIMARY_RUNTIME_NODE_MODULES: JSON.stringify(path.join(primary, "dependencies", "node", "node_modules")),
    CODEX_PRIMARY_RUNTIME_PYTHON: JSON.stringify(path.join(python, "python.exe")),
    PYTHONHOME: JSON.stringify(path.toNamespacedPath(python)),
    PYTHONPATH: JSON.stringify(["Lib", "DLLs", path.join("Lib", "site-packages")]
      .map(relative => path.toNamespacedPath(path.join(python, relative))).join(path.delimiter)),
    PYTHONNOUSERSITE: '"1"',
    PYTHONUSERBASE: JSON.stringify(path.join(home, "cache", "python-user")),
  });
  return config;
}

export async function prepareProfile({
  root = releaseRoot,
  home = releaseEnvironment({ root }).CODEX_HOME,
} = {}) {
  root = assertRegularPath(path.resolve(root), { allowMissing: false });
  home = safeProfile(home, root);
  const metadata = releaseMetadata(root);
  const marker = path.join(home, ".ccodex-release-profile.json");
  if (fs.existsSync(home) && !fs.existsSync(marker) && fs.readdirSync(home).length) {
    throw new Error("The selected data directory is not owned by CCodex Release; nothing was imported.");
  }
  fs.mkdirSync(home, { recursive: true });
  if (!fs.existsSync(marker)) {
    atomicWrite(marker, JSON.stringify({ product: "CCodexRelease", schemaVersion: 1 }));
  }
  if (boundedJson(marker, 4096).product !== "CCodexRelease") {
    throw new Error("The release-profile ownership marker belongs to another product.");
  }
  const unlock = acquireFileLock(path.join(home, ".release-prepare.lock"));
  try {
  const env = releaseEnvironment({ root, home });
  const retiredDesktop = retirePreviousDesktop(home, root);
  prepareDesktopHotkeys(root, home);
  const pointer = path.join(home, "bridge-port.txt");
  if (!fs.existsSync(pointer)) atomicWrite(pointer, `${await freePort()}\n`);
  env.CODEX_COPILOT_BRIDGE_PORT = fs.readFileSync(pointer, "utf8").trim();
  const file = path.join(home, "config.toml");
  assertRegularPath(file);
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  let config = fs.existsSync(file) ? fs.readFileSync(file, "utf8")
    : fs.readFileSync(path.join(root, "profile-seed", "config.toml"), "utf8");
  config = editSettings(config, [], {
    model_provider: '"github-copilot"',
    model_catalog_json: JSON.stringify(path.join(home, "models-desktop.json")),
    check_for_update_on_startup: "false",
    cli_auth_credentials_store: '"file"',
    mcp_oauth_credentials_store: '"file"',
  });
  config = editSettings(config, ["model_providers", "github-copilot"], {
    name: '"GitHub Copilot"',
    base_url: JSON.stringify(`http://127.0.0.1:${env.CODEX_COPILOT_BRIDGE_PORT}`),
    wire_api: '"responses"',
    requires_openai_auth: "false",
    http_headers: '{ "X-Codex-Copilot-Surface" = "codex" }',
    request_max_retries: "4",
    stream_max_retries: "5",
    stream_idle_timeout_ms: "300000",
  });
  config = editSettings(config, ["model_providers", "github-copilot", "auth"], {
    command: JSON.stringify(path.join(root, "runtime", "node", "node.exe")),
    args: JSON.stringify([path.join(root, "bridge", "provider-auth.mjs")]),
    timeout_ms: "10000",
    refresh_interval_ms: "300000",
    cwd: JSON.stringify(root),
  });
  config = setNativeConfig(config, { root, home, env, metadata });
  if (retiredDesktop) {
    config = editSettings(config, ["mcp_servers", "node_repl", "env"], {
      SKY_CUA_NATIVE_PIPE_DIRECTORY: null,
    });
  }
  // Repairs regenerate resource bindings, not destination-owned UI preferences.
  if (original === null) config = ensureManagedUiSettings(config);
  seedDesktopPreferences(home);
  config = ensureChildIsolationSettings(config);
  // Stock commands launched by agent shells must not inherit the enhanced
  // profile's credential locations or transport identity.
  const exclusionEntry = configEntries(config).find(entry =>
    JSON.stringify(entry.table) === '["shell_environment_policy"]' &&
    entry.key?.[0] === "exclude");
  if (exclusionEntry) {
    config = editSettings(config, ["shell_environment_policy"], { exclude: JSON.stringify([
      ...new Set([...stringArray(exclusionEntry.value), "CCODEX_*", "COPILOT_*", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL"]),
    ]) });
  }
  // Authorization and enterprise-sharing consent are destination-user choices.
  const workiq = readSettings(home);
  config = renderManagedConfig(config, {
    ...workiq,
    enabled: workiq.enabled && (original === null || publicStatus(home).configEnabled),
  }, {
    profile: home, node: path.join(root, "runtime", "node", "node.exe"),
    entry: path.join(root, "bridge", "workiq", "main.mjs"),
  });
  if ((fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null) !== original) {
    throw new Error("Configuration changed during preparation; the newer settings were not overwritten.");
  }
  if (config !== original) atomicWrite(file, config, { expectedContents: original });
  const cli = path.join(home, "ccodex.config.toml");
  if (!fs.existsSync(cli)) {
    atomicWrite(cli, fs.readFileSync(path.join(root, "profile-seed", "ccodex.config.toml"), "utf8"));
  }
  copyMissing(path.join(root, "profile-seed", "skills"), path.join(home, "skills"));
  copyMissing(path.join(root, "profile-seed", "agent-skills"), path.join(home, "skills"));
  copyMissing(path.join(root, "profile-seed", "plugins"), path.join(home, "plugins"));
  copyMissing(path.join(root, "runtime", "workiq"), path.join(home, "workiq", "runtime"));
  restorePinnedPrimaryRuntime(root, home);
  synchronizePrimaryOverrides(root, home);
  const desktopEnv = releaseEnvironment({ root, home, desktopHost: true });
  for (const directory of [desktopEnv.LOCALAPPDATA, desktopEnv.APPDATA, desktopEnv.TEMP]) {
    assertRegularPath(directory);
    fs.mkdirSync(directory, { recursive: true });
  }
  atomicWrite(path.join(home, "copilot-cli-sdk-path.txt"), `${env.CODEX_COPILOT_CLI_SDK}\n`);
  atomicWrite(path.join(home, "release-settings.json"), `${JSON.stringify({
    schemaVersion: 1, releaseId: metadata.releaseId, installRoot: root,
    home, preparedAt: new Date().toISOString(), loginRequired: true,
    originalProfilesImported: false,
  }, null, 2)}\n`);
  return { profile: home, port: +env.CODEX_COPILOT_BRIDGE_PORT, releaseId: metadata.releaseId };
  } finally { unlock(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await prepareProfile({
      root: process.argv[2] || releaseRoot, home: process.argv[3],
    })));
  } catch (error) {
    console.error(`CCodex Release profile: ${error.message}`);
    process.exitCode = 1;
  }
}
