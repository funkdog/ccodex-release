import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { validatedFileSha256 } from "./file-validation-cache.mjs";

const MAX_HEADER = 32 * 1024 * 1024;
const MAX_SOURCE = 16 * 1024 * 1024;
const json = file => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) {
    throw new Error("Desktop snapshot metadata must be a bounded regular file.");
  }
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
};

function readExactly(fd, size, offset) {
  const output = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const count = fs.readSync(fd, output, read, size - read, offset + read);
    if (!count) throw new Error("Official application archive is truncated.");
    read += count;
  }
  return output;
}

/** Read vendor metadata without unpacking, evaluating or modifying application code. */
export function inspectOfficialDesktop(archive) {
  const fd = fs.openSync(archive, "r");
  try {
    const prefix = readExactly(fd, 16, 0);
    const headerSize = prefix.readUInt32LE(4);
    const stringSize = prefix.readUInt32LE(12);
    if (stringSize <= 0 || stringSize > MAX_HEADER || headerSize < stringSize ||
        headerSize > MAX_HEADER) {
      throw new Error("Unsupported official application archive header.");
    }
    const header = JSON.parse(readExactly(fd, stringSize, 16).toString("utf8"));
    function read(name) {
      let entry = header;
      for (const part of name.split("/")) entry = entry?.files?.[part];
      const offset = Number(entry?.offset);
      if (!entry || entry.unpacked || entry.link || !Number.isSafeInteger(entry.size) ||
          entry.size <= 0 || entry.size > MAX_SOURCE || !Number.isSafeInteger(offset) ||
          offset < 0) {
        throw new Error(`Unsupported official archive entry: ${name}`);
      }
      return readExactly(fd, entry.size, 8 + headerSize + offset).toString("utf8");
    }
    const metadata = JSON.parse(read("package.json"));
    if (metadata.name !== "openai-codex-electron" ||
        !/^\d+(?:\.\d+){2,3}$/.test(metadata.version || "")) {
      throw new Error("Snapshot is not a recognized official Codex/ChatGPT Desktop.");
    }
    const build = header.files?.[".vite"]?.files?.build?.files;
    if (!build) throw new Error("Unknown official Desktop bootstrap layout.");
    const bootstraps = Object.keys(build).filter(name =>
      /^(?:early-bootstrap|bootstrap[-.]|main[-.]).*\.js$/.test(name));
    const sources = bootstraps.map(name => read(`.vite/build/${name}`));
    // This verifies the vendor's own isolation contract. It is not a substitute
    // for the live process/data-directory checks recorded by the launcher.
    const explicitDataPath = sources.some(source =>
      source.includes("CODEX_ELECTRON_USER_DATA_PATH") &&
      /\.setPath\((?:`|"|')userData(?:`|"|')/.test(source));
    const independentLock = sources.some(source => source.includes("requestSingleInstanceLock"));
    if (!explicitDataPath || !independentLock) {
      throw new Error("Official Desktop lacks the validated independent user-data/instance contract.");
    }
    const updates = Object.fromEntries(Object.entries(metadata).filter(([key, value]) =>
      /^codex/i.test(key) && /update|packageIdentity|buildFlavor/i.test(key) &&
      typeof value === "string"));
    return {
      schemaVersion: 1,
      name: metadata.name,
      productName: metadata.productName,
      version: metadata.version,
      explicitDataPath,
      independentLock,
      updates,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function runtimePath(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) ||
      /^(?:[A-Za-z]:|[/\\])/.test(relative) ||
      relative.split(/[\\/]/).some(part => part === ".." || part === "." || !part)) {
    throw new Error("Desktop runtime path must be a contained relative path.");
  }
  const resolvedRoot = fs.realpathSync(root);
  const target = path.resolve(root, relative);
  const tail = path.relative(path.resolve(root), target);
  if (!tail || tail.startsWith(`..${path.sep}`) || path.isAbsolute(tail)) {
    throw new Error("Desktop runtime path escaped its root.");
  }
  let ancestor = target;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actual = path.relative(resolvedRoot, fs.realpathSync(ancestor));
  if (actual === ".." || actual.startsWith(`..${path.sep}`) || path.isAbsolute(actual)) {
    throw new Error("Desktop runtime path escaped through a link.");
  }
  return target;
}

export function fileSha256(file) {
  return validatedFileSha256(file);
}

export function desktopStateRoot({ root, home, platform = process.platform }) {
  if (platform === "win32") return path.resolve(root);
  if (!["linux", "darwin"].includes(platform)) throw new Error("Unsupported Desktop state platform.");
  return assertPrivateDesktopHome(home);
}

export function desktopSnapshot(installRoot, {
  version, platform = process.platform, arch = process.arch, stateRoot = installRoot,
} = {}) {
  const desktopRoot = path.join(stateRoot, "desktop");
  runtimePath(stateRoot, "desktop");
  if (fs.lstatSync(desktopRoot).isSymbolicLink()) {
    throw new Error("Desktop snapshot state root cannot be linked.");
  }
  const selected = version ? { version } : json(runtimePath(desktopRoot, "current.json"));
  if (typeof selected.version !== "string" || !/^[\d.]+-[a-f0-9]{12}$/.test(selected.version)) {
    throw new Error("Invalid independent Desktop runtime pointer.");
  }
  const snapshot = runtimePath(desktopRoot, `versions/${selected.version}`);
  const manifest = json(runtimePath(snapshot, "snapshot.json"));
  const expectedPlatform = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform;
  if (manifest.schemaVersion !== 1 || manifest.platform !== expectedPlatform ||
      manifest.arch !== arch || manifest.version !== selected.version ||
      !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error("Independent Desktop snapshot metadata does not match this platform.");
  }
  const executable = runtimePath(snapshot, manifest.executable);
  const resources = runtimePath(snapshot, manifest.resources);
  const archive = path.join(resources, "app.asar");
  const coreRelative = platform === "darwin" && fs.existsSync(path.join(resources, "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"))
    ? "codex-cli/CodexCLI.app/Contents/MacOS/codex" : platform === "win32" ? "codex.exe" : "codex";
  for (const file of [executable, archive, path.join(resources, coreRelative)]) {
    const relative = path.relative(snapshot, file).replace(/\\/g, "/");
    const entry = manifest.files.find(item => item.path === relative);
    if (!entry || !/^[a-f0-9]{64}$/i.test(entry.sha256) ||
        fileSha256(file) !== entry.sha256.toLowerCase()) {
      throw new Error(`Independent Desktop integrity check failed: ${relative}`);
    }
  }
  const contract = inspectOfficialDesktop(archive);
  if (contract.version !== manifest.applicationVersion || !contract.explicitDataPath) {
    throw new Error("Independent Desktop contract changed after validation.");
  }
  return { snapshot, manifest, executable, resources, contract };
}

/** Resolve the existing ancestor too, before a not-yet-created profile is used. */
export function prospectivePath(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Desktop profile path is required.");
  let ancestor = path.resolve(value);
  const missing = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("Desktop profile has no existing filesystem ancestor.");
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.resolve(fs.realpathSync(ancestor), ...missing);
}

export function assertPrivateDesktopHome(home, { inherited = process.env } = {}) {
  if (typeof home !== "string" || !home.trim()) throw new Error("Desktop profile path is required.");
  const profile = path.resolve(home);
  const normalized = value => process.platform === "win32" ? value.toLowerCase() : value;
  const candidate = normalized(prospectivePath(profile));
  // A custom seed path must not redefine the ordinary .codex isolation boundary.
  const stockHomes = [path.join(os.homedir(), ".codex"), inherited.CODEX_COPILOT_SOURCE_HOME].filter(Boolean);
  for (const stock of stockHomes) {
    for (const source of [path.resolve(stock), prospectivePath(stock)].map(normalized)) {
      if (candidate === source || candidate.startsWith(source + path.sep)) {
        throw new Error("The enhanced Desktop cannot use or live under the original Codex profile.");
      }
    }
  }
  return profile;
}

/** Build only a child environment. Never change registry, shell profiles or stock files. */
export function desktopEnvironment({ inherited = process.env, home, runtime }) {
  const profile = assertPrivateDesktopHome(home, { inherited });
  const env = { ...inherited };
  const ownedNames = new Set([
    "CODEX_HOME", "CODEX_COPILOT_HOME", "CODEX_CLI_PATH",
    "CODEX_ELECTRON_USER_DATA_PATH", "CODEX_ELECTRON_RESOURCES_PATH",
    "CODEX_WINDOWS_REGISTERED_CORE", "CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY",
    "CODEX_COPILOT_CATALOG_FILE", "CODEX_COPILOT_SELECTION_FILE",
    "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "CODEX_APP_SERVER_FORCE_CLI", "CCODEX_GATEWAY_CONNECTION",
  ]);
  for (const name of Object.keys(env)) {
    const key = process.platform === "win32" ? name.toUpperCase() : name;
    if (/^(?:NODE_REPL_|SKY_CUA_|BROWSER_USE_)/.test(key) || ownedNames.has(key)) {
      delete env[name];
    }
  }
  env.CODEX_HOME = profile;
  env.CODEX_COPILOT_HOME = env.CODEX_HOME;
  env.CODEX_ELECTRON_USER_DATA_PATH = path.join(env.CODEX_HOME, "desktop-data");
  env.CODEX_ELECTRON_RESOURCES_PATH = runtime.resources;
  env.CODEX_COPILOT_CATALOG_FILE = path.join(env.CODEX_HOME, "models-desktop.json");
  return env;
}

const evaluatingScript = process.execArgv.some(value =>
  ["-e", "--eval", "-p", "--print"].includes(value));
if (!evaluatingScript && process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === "inspect" && process.argv[3]) {
      process.stdout.write(`${JSON.stringify(inspectOfficialDesktop(process.argv[3]), null, 2)}\n`);
    } else {
      throw new Error("Usage: desktop-runtime.mjs inspect <official-app.asar>");
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
