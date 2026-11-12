import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { configEntries, editSettings, readSetting } from "./config-document.mjs";
import { atomicWrite } from "../bridge/workiq/settings.mjs";

const MCP = ["mcp_servers", "node_repl"];
const ENV = [...MCP, "env"];
const json = file => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function ownedPipeExists(file) {
  if (process.platform !== "win32" || !file.startsWith("\\\\.\\pipe\\")) return fs.existsSync(file);
  try {
    return fs.readdirSync("\\\\.\\pipe\\").some(name => name.toLowerCase() === file.slice(9).toLowerCase());
  } catch { return false; }
}

export function contained(root, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative) || /^[A-Za-z]:|^[/\\]/.test(relative)) {
    throw new Error("Runtime manifest must contain relative paths.");
  }
  const target = path.resolve(root, relative);
  const tail = path.relative(path.resolve(root), target);
  if (!tail || tail === ".." || tail.startsWith(`..${path.sep}`) || path.isAbsolute(tail)) {
    throw new Error("Runtime manifest path escaped its root.");
  }
  // A missing leaf can still have an existing parent junction outside the root.
  let ancestor = target;
  for (;;) {
    try { fs.lstatSync(ancestor); break; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  const actual = path.relative(fs.realpathSync(root), fs.realpathSync(ancestor));
  if (actual === ".." || actual.startsWith(`..${path.sep}`) || path.isAbsolute(actual)) {
    throw new Error("Runtime symlink escaped its root.");
  }
  return target;
}

export function readRuntime(root, { platform = process.platform, arch = process.arch } = {}) {
  const manifest = json(path.join(root, "manifest.json"));
  const expectedPlatform = platform === "win32" ? "windows" : platform;
  if (manifest.platform !== expectedPlatform || manifest.arch !== arch) {
    throw new Error("Runtime platform or architecture does not match.");
  }
  const node = contained(root, manifest.node_path);
  const modules = contained(root, manifest.node_modules);
  const repl = contained(root, manifest.node_repl_path);
  if (!isFile(node) || !isFile(repl) || !fs.statSync(modules).isDirectory()) {
    throw new Error("Runtime manifest references missing components.");
  }
  return { root: path.resolve(root), node, modules, repl, manifest };
}

export function discoverRuntime({ runtimes, preferred, platform, arch }) {
  const valid = [];
  if (!fs.existsSync(runtimes)) return null;
  for (const entry of fs.readdirSync(runtimes, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try { valid.push(readRuntime(path.join(runtimes, entry.name), { platform, arch })); } catch { /* incomplete download */ }
  }
  const selected = valid.find(item => preferred && same(item.repl, preferred));
  if (selected) return selected;
  // Hash-named folders have no ordering semantics. Use manifest version metadata.
  valid.sort((a, b) => String(b.manifest.runtime_archive_version || b.manifest.node_version)
    .localeCompare(String(a.manifest.runtime_archive_version || a.manifest.node_version), "en", { numeric: true }));
  return valid[0] || null;
}

export function desktopResources() {
  if (process.platform !== "win32") return null;
  const root = path.resolve(import.meta.dirname, "..");
  if (isFile(path.join(root, "release.json"))) {
    const metadata = json(path.join(root, "release.json"));
    return path.join(root, "desktop", "versions", metadata.desktopSnapshot, "app", "resources");
  }
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "(Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation",
  ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  const location = result.status === 0 && result.stdout.trim();
  return location ? path.join(location, "app", "resources") : null;
}

function envValues(text) {
  return Object.fromEntries(configEntries(text)
    .filter(item => item.key?.length === 1 && JSON.stringify(item.table) === JSON.stringify(ENV))
    .map(item => [item.key[0], readSetting(text, ENV, item.key[0])])
    .filter(([, value]) => typeof value === "string"));
}

function copyMissingTree(source, target) {
  const directories = [];
  const files = [];
  if (fs.lstatSync(source).isSymbolicLink() || fs.lstatSync(target).isSymbolicLink()) {
    throw new Error("Plugin recovery does not follow symlinks.");
  }
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = path.relative(source, path.join(directory, entry.name));
      const from = contained(source, relative);
      const to = contained(target, relative);
      let existing;
      try { existing = fs.lstatSync(to); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (entry.isSymbolicLink() || existing?.isSymbolicLink()) {
        throw new Error("Plugin recovery does not follow symlinks.");
      }
      if (entry.isDirectory()) {
        if (existing && !existing.isDirectory()) throw new Error("Plugin recovery found a conflicting file.");
        if (!existing) directories.push(to);
        inspect(from);
      } else if (entry.isFile()) {
        if (existing && !existing.isFile()) throw new Error("Plugin recovery found a conflicting directory.");
        if (!existing) files.push({ from, to });
      } else {
        throw new Error("Plugin recovery found an unsupported file type.");
      }
    }
  }
  // Validate the whole tree before writing any files into an incomplete cache.
  inspect(source);
  for (const directory of directories) fs.mkdirSync(directory, { recursive: true });
  for (const { from, to } of files) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
}

export function reconcileNativeConfig(text, {
  home, runtimes, resources = null, platform = process.platform, arch = process.arch,
  repairFiles = false, pipeExists = ownedPipeExists, surface = "preserve",
  relay = path.resolve(import.meta.dirname, "../bridge/native-mcp-relay.mjs"),
} = {}) {
  const warnings = [];
  const actions = [];
  let config = text;
  if (surface === "desktop" && resources) {
    const nativeCore = path.join(resources, platform === "win32" ? "codex.exe" : "codex");
    const inheritedCore = readSetting(config, ENV, "CODEX_CLI_PATH");
    if (typeof inheritedCore === "string" &&
        /[\\/]CodexCopilot[\\/]bin[\\/].*codex-copilot-core(?:\.next)?\.exe$/i.test(inheritedCore)) {
      if (!isFile(nativeCore)) throw new Error("The independent Desktop snapshot has no official native core.");
      config = editSettings(config, ENV, { CODEX_CLI_PATH: JSON.stringify(nativeCore) });
      actions.push("Removed the legacy patched-CLI override from the Desktop MCP environment.");
    }
  }
  const wrappedNative = readSetting(config, ENV, "CCODEX_NODE_REPL_NATIVE_PATH");
  const preferred = wrappedNative || readSetting(config, MCP, "command");
  const relative = preferred && path.relative(runtimes, preferred);
  const managedCommand = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  let runtime = null;
  if (managedCommand) {
    if (isFile(path.join(runtimes, "manifest.json"))) {
      runtime = readRuntime(runtimes, { platform, arch });
    } else {
      runtime = discoverRuntime({ runtimes, preferred, platform, arch });
    }
  }
  if (managedCommand && !runtime) warnings.push("No complete native runtime is available. Open Desktop to install its runtime.");
  if (runtime) {
    const env = envValues(config);
    const oldModules = env.NODE_REPL_NODE_MODULE_DIRS;
    const trusted = (env.NODE_REPL_TRUSTED_CODE_PATHS || "").split(path.delimiter)
      .filter(value => value && value !== oldModules);
    env.NODE_REPL_NODE_PATH = runtime.node;
    env.NODE_REPL_NODE_MODULE_DIRS = runtime.modules;
    env.NODE_REPL_TRUSTED_CODE_PATHS = [...new Set([...trusted, home, runtime.modules])].join(path.delimiter);
    env.CODEX_HOME = home;
    const wrap = surface === "cli" || (surface === "preserve" && wrappedNative);
    config = editSettings(config, MCP, {
      command: JSON.stringify(wrap ? process.execPath : runtime.repl),
      ...(wrap || wrappedNative ? { args: JSON.stringify(wrap ? [relay] : []) } : {}),
    });
    if (wrap) env.CCODEX_NODE_REPL_NATIVE_PATH = runtime.repl;
    else delete env.CCODEX_NODE_REPL_NATIVE_PATH;
    config = editSettings(config, ENV, Object.fromEntries(Object.entries(env).map(([key, value]) => [key, JSON.stringify(value)])));
    if (!wrap && wrappedNative) config = editSettings(config, ENV, { CCODEX_NODE_REPL_NATIVE_PATH: null });
    if (!same(preferred, runtime.repl)) actions.push("Resolved a complete native runtime from its manifest.");
  }

  const staged = path.join(home, ".tmp", "bundled-marketplaces", "openai-bundled");
  const marketplace = ["marketplaces", "openai-bundled"];
  const source = readSetting(config, marketplace, "source");
  const stageExists = isFile(path.join(staged, ".agents", "plugins", "marketplace.json"));
  const desktopWillMaterialize = surface === "desktop" && resources
    && isFile(path.join(resources, "plugins", "openai-bundled", ".agents", "plugins", "marketplace.json"));
  if (source && readSetting(config, marketplace, "source_type") === "local" && (stageExists || desktopWillMaterialize)) {
    const normalized = source.replace(/^\\\\\?\\/, "").replace(/\\/g, "/");
    const managed = /\/(?:resources\/plugins|\.tmp\/bundled-marketplaces)\/openai-bundled\/?$/i.test(normalized);
    const release = isFile(path.resolve(import.meta.dirname, "..", "release.json"));
    const canonical = release && platform === "win32" ? path.toNamespacedPath(staged) : staged;
    if (managed && (!same(source.replace(/^\\\\\?\\/, ""), staged) ||
        (release && source !== canonical))) {
      config = editSettings(config, marketplace, { source: JSON.stringify(canonical) });
      actions.push("Aligned bundled marketplace with the Desktop-owned profile directory.");
    }
  }

  const services = readSetting(config, ENV, "NODE_REPL_TRUSTED_SERVICES");
  if (services) {
    let mapping;
    try { mapping = JSON.parse(services); } catch { warnings.push("Native trusted-service map is invalid; it was not replaced."); }
    const browser = mapping?.browser;
    if (typeof browser === "string" && path.isAbsolute(browser)) {
      const cache = path.join(home, "plugins", "cache", "openai-bundled", "browser");
      const relative = path.relative(cache, browser);
      const parts = relative.split(path.sep);
      const knownCache = parts.length === 3 && parts[1] === "scripts" && parts[2] === "browser-service.mjs"
        && !relative.startsWith("..") && !path.isAbsolute(relative);
      const client = path.join(path.dirname(browser), "browser-client.mjs");
      if (knownCache && (!isFile(browser) || !isFile(client))) {
        const sources = [path.join(staged, "plugins", "browser")];
        if (resources) sources.push(path.join(resources, "plugins", "openai-bundled", "plugins", "browser"));
        let recovered = false;
        for (const candidate of sources) {
          try {
            const manifest = json(path.join(candidate, ".codex-plugin", "plugin.json"));
            if (manifest.name !== "browser" || manifest.version !== parts[0]) continue;
            if (!isFile(path.join(candidate, "scripts", "browser-service.mjs"))
              || !isFile(path.join(candidate, "scripts", "browser-client.mjs"))) continue;
            if (repairFiles) {
              const destination = contained(home, path.relative(home, path.join(cache, parts[0])));
              fs.mkdirSync(destination, { recursive: true });
              copyMissingTree(candidate, destination);
              recovered = isFile(browser) && isFile(client);
              if (!recovered) throw new Error("Browser entry points are still incomplete after recovery.");
              actions.push(`Recovered missing browser files from matching local bundle ${manifest.version}.`);
            }
            break;
          } catch (error) {
            warnings.push(`Browser recovery failed: ${error.message}`);
          }
        }
        if (!recovered) warnings.push("Browser cache is incomplete. Open Desktop to reconcile the matching plugin version.");
      } else if (!isFile(browser)) {
        warnings.push("Configured browser service is missing; no unrelated plugin version was substituted.");
      }
    }
  }

  const pipe = readSetting(config, ENV, "SKY_CUA_NATIVE_PIPE_DIRECTORY");
  if (pipe && !pipeExists(pipe)) {
    warnings.push("The Desktop native connection is no longer live. Reopen Desktop and reload MCP before Computer Use.");
  }
  // Native pipe identity, security allowlists and disabled flags are never invented.
  return { config, runtime, actions, warnings };
}

export function repairNativeProfile({
  home = process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot"),
  runtimes = isFile(path.resolve(import.meta.dirname, "..", "release.json"))
    ? path.join(desktopResources(), "cua_node")
    : path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "runtimes", "cua_node"),
  resources = null, repairFiles = true, ...options
} = {}) {
  const file = path.join(home, "config.toml");
  if (!fs.existsSync(file)) return { actions: [], warnings: [], changed: false };
  const original = fs.readFileSync(file, "utf8");
  const result = reconcileNativeConfig(original, { home, runtimes, resources, repairFiles, ...options });
  if (result.config !== original) {
    // Do not overwrite settings concurrently published by Desktop or another CLI.
    if (fs.readFileSync(file, "utf8") !== original) throw new Error("Configuration changed during preflight; retry startup.");
    atomicWrite(file, result.config);
  }
  const report = {
    schemaVersion: 1, checkedAt: new Date().toISOString(), changed: result.config !== original,
    runtime: result.runtime?.manifest.runtime_archive_version || null,
    actions: result.actions, warnings: result.warnings,
    configSha256: createHash("sha256").update(result.config).digest("hex"),
  };
  atomicWrite(path.join(home, "native-runtime-status.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const desktop = process.argv.includes("--desktop");
    const result = repairNativeProfile({
      resources: desktop ? desktopResources() : null,
      surface: desktop ? "desktop" : process.argv.includes("--cli") ? "cli" : "preserve",
    });
    if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else for (const warning of result.warnings) process.stderr.write(`ccodex native: ${warning}\n`);
  } catch (error) {
    process.stderr.write(`ccodex native preflight: ${error.message}\n`);
    process.exitCode = 1;
  }
}
