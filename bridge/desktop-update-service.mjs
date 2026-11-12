import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  assertPrivateDesktopHome, desktopSnapshot, desktopStateRoot, runtimePath,
} from "./desktop-runtime.mjs";
import { desktopUpdateCommand } from "./desktop-update-cli.mjs";
import { readProcessIdentity, sameProcessLifetime } from "./desktop-process.mjs";
import { publicProcessIdentity } from "./desktop-instance.mjs";

const MAX_RECORD_BYTES = 1024 * 1024;
const CANDIDATE = /^[\d.]+-[a-f0-9]{12}$/;
const OPERATIONS = new Set(["check", "prepare", "validate", "apply"]);

function record(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) {
    throw new Error("Private update records must be bounded regular files.");
  }
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function optionalRecord(file) {
  try { return record(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function atomic(file, value) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new Error("Private update state cannot be linked.");
  }
  const temporary = `${file}.${randomUUID()}.pending`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`,
    { flag: "wx", mode: 0o600 });
  try { fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function privateWorker({ root, home, args, onStarted }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CODEX_HOME: home, CODEX_COPILOT_HOME: home };
    for (const name of Object.keys(env)) {
      if (/^(?:NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/i.test(name) ||
          /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY)(?:$|_)/i.test(name)) delete env[name];
    }
    const child = spawn(process.execPath,
      [path.join(root, "bridge", "desktop-update-cli.mjs"), ...args],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    let ownershipError = null;
    child.stdout.on("data", () => {});
    child.stderr.on("data", chunk => {
      if (stderr.length < 8192) stderr += chunk.toString().slice(0, 8192 - stderr.length);
    });
    child.once("spawn", () => {
      try { onStarted?.(child.pid); }
      catch (error) { ownershipError = error; }
    });
    child.once("error", reject);
    child.once("close", code => {
      if (ownershipError) reject(ownershipError);
      else if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Private update worker exited ${code}.`));
    });
  });
}

/** Private, asynchronous update jobs shared by all renderers of one enhanced instance. */
export function createDesktopUpdateService({
  root, home, platform = process.platform, runningSnapshot,
  assertOwned, inspectProcess = readProcessIdentity, worker = privateWorker,
  apply = desktopUpdateCommand, snapshot = desktopSnapshot,
} = {}) {
  if (typeof assertOwned !== "function") throw new Error("Desktop updates require an instance owner guard.");
  root = path.resolve(root);
  home = assertPrivateDesktopHome(home);
  const stateRoot = desktopStateRoot({ root, home, platform });
  const desktop = path.join(stateRoot, "desktop");
  fs.mkdirSync(desktop, { recursive: true, mode: 0o700 });
  runtimePath(stateRoot, "desktop");
  if (fs.lstatSync(desktop).isSymbolicLink()) throw new Error("Private update root cannot be linked.");
  const stateFile = path.join(desktop, "update-operation.json");
  const lockFile = path.join(desktop, "update-operation.lock");
  let pending = null;
  let lockBytes = null;

  function selected() {
    const current = optionalRecord(runtimePath(stateRoot, "desktop/current.json"));
    if (current && !CANDIDATE.test(current.version || "")) {
      throw new Error("Invalid private Desktop selection.");
    }
    return current?.version || null;
  }

  function status() {
    assertOwned();
    const current = selected();
    const state = optionalRecord(stateFile);
    return {
      schemaVersion: 1, surface: "copilot-desktop", selectedSnapshot: current,
      originalInstallationOwned: false,
      operation: state,
      busy: Boolean(pending || optionalRecord(lockFile)),
      restartRequired: state?.status === "promoted" && current === state.candidate &&
        state.candidate !== (runningSnapshot || state.runningSnapshot),
    };
  }

  function acquire() {
    const old = optionalRecord(lockFile);
    if (old) {
      if (old.schemaVersion !== 1 || !old.identity ||
          !Number.isSafeInteger(old.identity.pid) || old.identity.pid <= 0 ||
          typeof old.identity.lifetime !== "string" || !old.identity.lifetime ||
          typeof old.identity.executable !== "string" || !path.isAbsolute(old.identity.executable) ||
          !["win32", "linux", "darwin"].includes(old.identity.platform)) {
        throw new Error("An unrecognized private Desktop update lock is preserved.");
      }
      const actual = inspectProcess(old.identity.pid);
      if (sameProcessLifetime(old.identity, actual) ||
          (old.workerIdentity && sameProcessLifetime(old.workerIdentity,
            inspectProcess(old.workerIdentity.pid)))) {
        throw new Error("A private Desktop update is already running.");
      }
      fs.unlinkSync(lockFile);
    }
    const identity = inspectProcess(process.pid);
    if (!identity) throw new Error("The update coordinator lifetime cannot be verified.");
    lockBytes = `${JSON.stringify({ schemaVersion: 1, id: randomUUID(),
      identity: publicProcessIdentity(identity) })}\n`;
    fs.writeFileSync(lockFile, lockBytes, { flag: "wx", mode: 0o600 });
  }

  function bindWorker(pid) {
    assertOwned();
    const identity = inspectProcess(pid);
    if (!identity) throw new Error("The private update worker lifetime cannot be verified.");
    if (fs.readFileSync(lockFile, "utf8") !== lockBytes) {
      throw new Error("The private update lock changed concurrently.");
    }
    const lock = JSON.parse(lockBytes);
    const next = { ...lock, workerIdentity: publicProcessIdentity(identity) };
    atomic(lockFile, next);
    lockBytes = `${JSON.stringify(next, null, 2)}\n`;
  }

  function release() {
    if (lockBytes !== null && fs.existsSync(lockFile) &&
        !fs.lstatSync(lockFile).isSymbolicLink() &&
        fs.readFileSync(lockFile, "utf8") === lockBytes) fs.unlinkSync(lockFile);
    lockBytes = null;
  }

  function receipts() {
    const directory = runtimePath(stateRoot, "desktop/prepared-updates");
    if (!fs.existsSync(directory)) return new Set();
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) {
      throw new Error("Private prepared-update receipts cannot be linked.");
    }
    return new Set(fs.readdirSync(directory).filter(name => /^[a-f0-9]{32}(?:\.json)$/.test(name) ||
      /^[a-f0-9-]{36}\.json$/.test(name)));
  }

  async function execute(operation, previous, state) {
    if (operation === "apply") {
      if (previous?.status !== "validated" || !CANDIDATE.test(previous?.candidate || "")) {
        throw new Error("Prepare and validate an update first.");
      }
      const validation = runtimePath(stateRoot,
        `desktop/validation/${previous.candidate}/candidate-validation.json`);
      assertOwned();
      const result = await apply({ root, home, platform,
        args: ["apply", validation], assertOwned, output: () => {} });
      return { ...state, status: "promoted", candidate: previous.candidate,
        receipt: result?.receipt || null };
    }
    const before = operation === "prepare" ? receipts() : null;
    const args = [operation];
    if (operation === "validate") {
      if (!CANDIDATE.test(previous?.candidate || "")) throw new Error("Prepare an official update first.");
      snapshot(root, { version: previous.candidate, stateRoot, platform });
      args.push(previous.candidate);
    }
    assertOwned();
    await worker({ root, home, args, onStarted: bindWorker });
    assertOwned();
    if (operation === "check") return { ...state, status: "metadata-checked",
      latestVersionVerified: false, message: "Prepare the signed official package to verify its version." };
    if (operation === "prepare") {
      const added = [...receipts()].filter(name => !before.has(name));
      if (added.length !== 1) throw new Error("The update worker did not produce one exact private receipt.");
      const prepared = record(runtimePath(stateRoot, `desktop/prepared-updates/${added[0]}`));
      if (prepared.status !== "prepared-needs-extension-validation" ||
          prepared.originalInstallationModified !== false ||
          !CANDIDATE.test(prepared.candidate || "")) {
        throw new Error("The official package was not prepared and verified.");
      }
      snapshot(root, { version: prepared.candidate, stateRoot, platform });
      return { ...state, status: "prepared", candidate: prepared.candidate,
        vendorVersion: prepared.vendorVersion, preparedReceipt: added[0] };
    }
    const validation = record(runtimePath(stateRoot,
      `desktop/validation/${previous.candidate}/candidate-validation.json`));
    return { ...state, candidate: previous.candidate,
      status: validation.passed === true ? "validated" : "needs-validation",
      message: validation.remainingGate || null };
  }

  async function request(input) {
    assertOwned();
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(key => key !== "operation")) {
      throw new Error("Invalid private Desktop update operation.");
    }
    if (input?.operation === "status") return status();
    if (!OPERATIONS.has(input.operation)) throw new Error("Invalid private Desktop update operation.");
    if (fs.existsSync(path.join(root, "release.json")) && input.operation !== "check") {
      throw new Error("Pinned team release: install a verified CCodex Release setup package instead of changing this Desktop snapshot.");
    }
    if (pending) return status();
    const previous = optionalRecord(stateFile);
    acquire();
    const state = {
      schemaVersion: 1, id: randomUUID(), operation: input.operation, status: "running",
      startedAt: new Date().toISOString(), runningSnapshot: runningSnapshot || selected(),
      candidate: previous?.candidate || null, originalInstallationModified: false,
    };
    try { atomic(stateFile, state); }
    catch (error) { release(); throw error; }
    pending = Promise.resolve().then(() => execute(input.operation, previous, state))
      .then(result => {
        assertOwned();
        if (fs.readFileSync(lockFile, "utf8") !== lockBytes) {
          throw new Error("The private update lock changed concurrently.");
        }
        atomic(stateFile, { ...result, completedAt: new Date().toISOString() });
      })
      .catch(error => {
        if (fs.existsSync(lockFile) && !fs.lstatSync(lockFile).isSymbolicLink() &&
            fs.readFileSync(lockFile, "utf8") === lockBytes) {
          atomic(stateFile, { ...state, status: "rejected",
            completedAt: new Date().toISOString(), message: error.message.slice(0, 8192) });
        }
      })
      .finally(() => { release(); pending = null; });
    return status();
  }

  return { request, status, idle: async () => { await pending; } };
}
