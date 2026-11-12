import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { cliCoreSelection, officialCliRelease, OFFICIAL_CLI_RELEASE } from "./cli-update.mjs";
import { assertPrivateDesktopHome, runtimePath } from "./desktop-runtime.mjs";
import { readProcessIdentity, sameProcessLifetime } from "./desktop-process.mjs";
import { publicProcessIdentity } from "./desktop-instance.mjs";

function record(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) {
    throw new Error("CLI update notice metadata must be a bounded regular file.");
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function optional(file) {
  try { return record(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function atomic(file, value) {
  optional(file);
  const pending = `${file}.${randomUUID()}.pending`;
  fs.writeFileSync(pending, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  try { fs.renameSync(pending, file); }
  finally { if (fs.existsSync(pending)) fs.unlinkSync(pending); }
}

function noticeDirectory(home) {
  home = assertPrivateDesktopHome(home);
  runtimePath(home, "cli-updates");
  const directory = path.join(home, "cli-updates");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("CLI update notice state cannot be linked.");
  return directory;
}

function worker({ root, home, id }) {
  const env = { ...process.env, CODEX_COPILOT_HOME: home };
  for (const key of Object.keys(env)) {
    if (/^(?:NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/i.test(key) ||
        /(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)/i.test(key)) delete env[key];
  }
  const child = spawn(process.execPath, [
    path.join(root, "bridge", "cli-update-notice.mjs"), "refresh", home, id,
  ], { cwd: root, env, stdio: "ignore", detached: true, windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

export function showCliUpdateNotice({
  root = path.resolve(import.meta.dirname, ".."),
  home = process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot"),
  now = Date.now, launch = worker, output = text => process.stderr.write(`${text}\n`),
  selection = cliCoreSelection,
  inspect = readProcessIdentity,
} = {}) {
  const current = selection({ root, home }).manifest.coreVersion.slice(10);
  const directory = noticeDirectory(home);
  const cache = optional(path.join(directory, "official-release.json"));
  const checkedAt = Date.parse(cache?.checkedAt);
  const valid = cache?.schemaVersion === 1 && cache.release?.source === OFFICIAL_CLI_RELEASE &&
    /^\d+\.\d+\.\d+$/.test(cache.release?.version || "") &&
    Number.isFinite(checkedAt) && checkedAt <= now() + 5 * 60000;
  if (!valid || now() - checkedAt > 6 * 60 * 60000) {
    const lock = path.join(directory, "notice-refresh.lock");
    const previous = optional(lock);
    if (previous?.schemaVersion === 1 && previous.kind === "cli-metadata-refresh" &&
        previous.identity && Number.isFinite(Date.parse(previous.createdAt)) &&
        now() - Date.parse(previous.createdAt) > 2 * 60000 &&
        !sameProcessLifetime(previous.identity, inspect(previous.identity.pid))) {
      if (optional(lock)?.id === previous.id) fs.unlinkSync(lock);
    }
    if (!fs.existsSync(lock)) {
      const id = randomUUID();
      try {
        const identity = inspect(process.pid);
        if (!identity) throw new Error("CLI notice coordinator lifetime could not be verified.");
        fs.writeFileSync(lock, `${JSON.stringify({ schemaVersion: 1, id,
          kind: "cli-metadata-refresh", identity: publicProcessIdentity(identity),
          createdAt: new Date(now()).toISOString() })}\n`,
        { flag: "wx", mode: 0o600 });
        launch({ root, home, id });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
  }
  if (!valid) return { shown: false, metadataAvailable: false };
  const newer = cache.release.version.split(".").map(Number);
  const installed = current.split(".").map(Number);
  const difference = newer.findIndex((number, index) => number !== installed[index]);
  if (difference < 0 || newer[difference] < installed[difference]) return { shown: false };
  const marker = path.join(directory, "notice-shown.json");
  const shown = optional(marker);
  if (shown?.installed === current && shown?.upstream === cache.release.version) return { shown: false };
  output(`Codex upstream ${cache.release.version} is available (checked ${cache.checkedAt}). ` +
    "Run ccodex update check; only compatible enhanced cores are selected. Stock Codex is unchanged.");
  atomic(marker, { installed: current, upstream: cache.release.version, shownAt: new Date(now()).toISOString() });
  return { shown: true, upstream: cache.release.version };
}

export async function refreshCliUpdateNotice({
  home, id, request = fetch, now = Date.now, inspect = readProcessIdentity,
}) {
  if (!/^[a-f0-9-]{36}$/.test(id || "")) throw new Error("Invalid CLI notice refresh identity.");
  const directory = noticeDirectory(home);
  const lock = path.join(directory, "notice-refresh.lock");
  const owned = optional(lock);
  if (owned?.schemaVersion !== 1 || owned.kind !== "cli-metadata-refresh" || owned.id !== id) {
    throw new Error("CLI notice refresh does not own its private metadata lease.");
  }
  try {
    const identity = inspect(process.pid);
    if (!identity) throw new Error("CLI notice worker lifetime could not be verified.");
    atomic(lock, { ...owned, identity: publicProcessIdentity(identity) });
    const release = await officialCliRelease({ request });
    if (optional(lock)?.id !== id) throw new Error("CLI notice refresh was superseded.");
    atomic(path.join(directory, "official-release.json"),
      { schemaVersion: 1, release, checkedAt: new Date(now()).toISOString() });
    return release;
  } finally {
    if (optional(lock)?.id === id) fs.unlinkSync(lock);
  }
}

const evaluating = process.execArgv.some(value => ["-e", "--eval", "-p", "--print"].includes(value));
if (!evaluating && process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === "refresh" && process.argv.length === 5) {
      await refreshCliUpdateNotice({ home: process.argv[3], id: process.argv[4] });
    } else if (process.argv.length === 2) showCliUpdateNotice();
    else throw new Error("Invalid private CLI update notice arguments.");
  } catch (error) {
    // Metadata failures never prevent an interactive CLI session from starting.
    if (process.argv[2] !== "refresh") console.error(`CLI update notice unavailable: ${error.message}`);
    process.exitCode = 1;
  }
}
