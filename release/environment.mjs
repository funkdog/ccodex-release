import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boundedJson } from "./paths.mjs";

export const releaseRoot = path.resolve(import.meta.dirname, "..");
export const releaseMetadata = (root = releaseRoot) => boundedJson(path.join(root, "release.json"));

const windowsSpellings = new Map([
  ["SYSTEMROOT", "SystemRoot"],
  ["PROGRAMFILES", "ProgramFiles"],
  ["PROGRAMW6432", "ProgramW6432"],
  ["PROGRAMFILES(X86)", "ProgramFiles(x86)"],
  ["PSMODULEPATH", "PSModulePath"],
  ["PSMODULEANALYSISCACHEPATH", "PSModuleAnalysisCachePath"],
]);

function uniqueWindowsEnvironment(source) {
  const env = {};
  const seen = new Set();
  // Match Node's deterministic first-key precedence for Windows duplicates.
  for (const name of Object.keys(source).sort()) {
    const upper = name.toUpperCase();
    if (seen.has(upper) || source[name] === undefined) continue;
    seen.add(upper);
    env[windowsSpellings.get(upper) || upper] = source[name];
  }
  return env;
}

export function releaseEnvironment({
  root = releaseRoot,
  home,
  inherited = process.env,
  desktopHost = false,
} = {}) {
  root = path.resolve(root);
  const source = uniqueWindowsEnvironment(inherited);
  const env = { ...source };
  const realHome = source.CCODEX_REAL_USERPROFILE || source.USERPROFILE || os.homedir();
  const realLocal = source.CCODEX_REAL_LOCALAPPDATA || source.LOCALAPPDATA ||
    path.join(realHome, "AppData", "Local");
  const realRoaming = source.CCODEX_REAL_APPDATA || source.APPDATA ||
    path.join(realHome, "AppData", "Roaming");
  const realTemp = source.CCODEX_REAL_TEMP || source.TEMP || os.tmpdir();
  const realModules = source.CCODEX_REAL_PSMODULEPATH || source.PSModulePath || "";
  const realPrograms = source.CCODEX_REAL_PROGRAMFILES || source.ProgramFiles || "";
  const realPrograms64 = source.CCODEX_REAL_PROGRAMW6432 || source.ProgramW6432 || realPrograms;
  const realProgramsX86 = source.CCODEX_REAL_PROGRAMFILES_X86 || source["ProgramFiles(x86)"] || realPrograms;
  home ||= path.join(realLocal,
    "CCodexRelease", "profile");
  home = path.resolve(home);
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (/^(?:CODEX_|CODEX$|CCODEX_|NODE_REPL_|SKY_CUA_|BROWSER_USE_|COPILOT_)/.test(upper) ||
        ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH", "PYTHONHOME",
          "PYTHONPATH", "PYTHONUSERBASE", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_CONFIG",
          "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "OPENAI_API_KEY",
          "OPENAI_BASE_URL", "GH_TOKEN", "GITHUB_TOKEN"].includes(upper)) {
      delete env[name];
    }
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(upper)) delete env[name];
  }
  const systemRoot = source.SystemRoot || source.WINDIR || process.env.SystemRoot;
  if (!systemRoot) throw new Error("The Windows system directory is unavailable.");
  const primary = path.join(root, "runtime", "primary", "codex-primary-runtime");
  const dependencies = path.join(primary, "dependencies");
  const git = fs.existsSync(path.join(root, "runtime", "git", "cmd", "git.exe"))
    ? path.join(root, "runtime", "git") : path.join(dependencies, "native", "git");
  const privatePaths = [
    path.join(root, "runtime", "node"),
    path.join(root, "bin"),
    path.join(dependencies, "native", "powershell"),
    path.join(systemRoot, "System32"),
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    path.join(git, "cmd"),
    path.join(git, "bin"),
    path.join(dependencies, "python"),
    path.join(dependencies, "native", "poppler", "Library", "bin"),
    path.join(dependencies, "native", "libheif"),
    path.join(dependencies, "native", "jxrlib"),
    path.join(dependencies, "bin", "override"),
    path.join(dependencies, "bin", "fallback"),
  ].filter(directory => fs.existsSync(directory));
  const pathEntries = [...privatePaths, ...(source.PATH || "").split(path.delimiter)];
  const seenPaths = new Set();
  env.PATH = pathEntries.filter(directory => {
    if (!directory) return false;
    const key = directory.replace(/[\\/]+$/, "").toLowerCase();
    if (seenPaths.has(key)) return false;
    seenPaths.add(key);
    return true;
  }).join(path.delimiter);
  env.CODEX_HOME = home;
  env.CODEX_COPILOT_HOME = home;
  env.CODEX_COPILOT_CATALOG_FILE = path.join(home, "models.json");
  env.CODEX_COPILOT_INSTALL_ROOT = root;
  env.CODEX_COPILOT_SOURCE_HOME = path.join(home, "empty-seed");
  const copilotArchDir = fs.existsSync(path.join(root, "runtime", "copilot", "node_modules", "@github", `copilot-win32-${process.arch}`))
    ? `copilot-win32-${process.arch}`
    : fs.existsSync(path.join(root, "runtime", "copilot", "node_modules", "@github", "copilot-win32-x64"))
      ? "copilot-win32-x64"
      : "copilot-win32-arm64";
  env.CODEX_COPILOT_CLI_SDK = path.join(root, "runtime", "copilot", "node_modules",
    "@github", copilotArchDir, "copilot-sdk", "index.js");
  env.CODEX_COPILOT_COPILOT_CLI = path.join(root, "runtime", "copilot", "node_modules",
    "@github", copilotArchDir, "copilot.exe");
  env.COPILOT_CLI_PATH = env.CODEX_COPILOT_COPILOT_CLI;
  env.COPILOT_CLI_DIST_DIR = path.dirname(env.COPILOT_CLI_PATH);
  env.COPILOT_HOME = path.join(home, "copilot");
  env.COPILOT_CACHE_HOME = path.join(home, "copilot-cache");
  env.COPILOT_PKG_CACHE_HOME = env.COPILOT_CACHE_HOME;
  env.COPILOT_AUTO_UPDATE = "false";
  env.COPILOT_DISABLE_KEYTAR = "1";
  env.CODEX_COPILOT_AUTH_MODE = "saved";
  env.CCODEX_REAL_USERPROFILE = realHome;
  env.CCODEX_REAL_LOCALAPPDATA = realLocal;
  env.CCODEX_REAL_APPDATA = realRoaming;
  env.CCODEX_REAL_TEMP = realTemp;
  env.CCODEX_REAL_PSMODULEPATH = realModules;
  env.CCODEX_REAL_PROGRAMFILES = realPrograms;
  env.CCODEX_REAL_PROGRAMW6432 = realPrograms64;
  env.CCODEX_REAL_PROGRAMFILES_X86 = realProgramsX86;
  env.CCODEX_RELEASE_ROOT = root;
  env.CCODEX_WORKSPACE = source.CCODEX_WORKSPACE || path.join(realHome, "Ccodex Workspace");
  env.CCODEX_NO_CD = source.CCODEX_NO_CD || "";
  env.CODEX_PRIMARY_RUNTIME_ROOT = primary;
  env.CODEX_PRIMARY_RUNTIME_NODE = path.join(dependencies, "node", "bin", "node.exe");
  env.CODEX_PRIMARY_RUNTIME_NODE_MODULES = path.join(dependencies, "node", "node_modules");
  const python = path.join(dependencies, "python");
  env.CODEX_PRIMARY_RUNTIME_PYTHON = path.join(python, "python.exe");
  // Extended paths work without changing Windows' machine-wide long-path policy.
  env.PYTHONHOME = path.toNamespacedPath(python);
  env.PYTHONPATH = ["Lib", "DLLs", path.join("Lib", "site-packages")]
    .map(relative => path.toNamespacedPath(path.join(python, relative))).join(path.delimiter);
  env.PYTHONNOUSERSITE = "1";
  env.PYTHONUSERBASE = path.join(home, "cache", "python-user");
  env.GIT_CONFIG_SYSTEM = path.join(root, "release", "gitconfig");
  env.GIT_CONFIG_GLOBAL = path.join(home, "host-profile", ".gitconfig");
  env.CODEX_PREFERRED_GIT_EXECUTABLE = path.join(git, "cmd", "git.exe");
  env.GIT_BASH_PATH = path.join(git, "bin", "bash.exe");
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PSModuleAnalysisCachePath = path.join(home, "cache", "powershell-module-analysis");
  env.PSModulePath = [
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
  ].join(path.delimiter);
  env.XDG_CACHE_HOME = path.join(home, "host-profile", ".cache");
  env.NO_PROXY = ["127.0.0.1", "localhost", source.NO_PROXY || ""]
    .filter(Boolean).join(",");
  const port = path.join(home, "bridge-port.txt");
  if (fs.existsSync(port)) {
    const value = fs.readFileSync(port, "utf8").trim();
    if (!/^\d+$/.test(value) || +value < 1024 || +value > 65535) {
      throw new Error("Invalid release-owned bridge port.");
    }
    env.CODEX_COPILOT_BRIDGE_PORT = value;
  }
  // Both hosts must avoid user-home discovery of stock skills and credentials.
  // Only agent shells restore the real user's working environment via config.
  env.USERPROFILE = path.join(home, "host-profile");
  env.HOME = env.USERPROFILE;
  env.LOCALAPPDATA = path.join(env.USERPROFILE, "AppData", "Local");
  env.APPDATA = path.join(env.USERPROFILE, "AppData", "Roaming");
  env.TEMP = path.join(home, "cache", "temp");
  env.TMP = env.TEMP;
  env.XDG_CACHE_HOME = path.join(env.USERPROFILE, ".cache");
  // Native Git for Windows discovery checks ProgramFiles before PATH.
  // The case-insensitive runtime/Git path is the bundled runtime/git tree.
  env.ProgramFiles = path.join(root, "runtime");
  env.ProgramW6432 = env.ProgramFiles;
  env["ProgramFiles(x86)"] = env.ProgramFiles;
  return env;
}
