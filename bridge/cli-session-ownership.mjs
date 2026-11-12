import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readProcessIdentity } from "./desktop-process.mjs";
import { HistoryError } from "../tools/history/manager.mjs";
import { windowsSystemEnvironment } from "./windows-system-environment.mjs";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const run = promisify(execFile);

function leaseDirectory(home, create = false) {
  const folder = path.join(home, "cli-session-leases");
  if (create) fs.mkdirSync(folder, { recursive: true });
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      path.dirname(fs.realpathSync(folder)) !== fs.realpathSync(home)) {
    throw new HistoryError("ownership_unknown", "The CLI ownership directory is not a private regular directory.");
  }
  return folder;
}

function readLease(home, clientId) {
  if (!UUID.test(clientId || "")) return null;
  try {
    const file = path.join(leaseDirectory(home), `${clientId}.json`);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const lease = JSON.parse(fs.readFileSync(file, "utf8"));
    if (lease.schemaVersion !== 1 || lease.clientId !== clientId ||
        !Number.isSafeInteger(lease.ownerPid) || lease.ownerPid <= 0 ||
        typeof lease.lifetime !== "string" ||
        (lease.currentThreadId !== null && !UUID.test(lease.currentThreadId || ""))) return null;
    return lease;
  } catch { return null; }
}

function writeLease(home, lease) {
  const folder = leaseDirectory(home, true);
  const file = path.join(folder, `${lease.clientId}.json`);
  const pending = path.join(folder, `${lease.clientId}.${randomUUID()}.pending`);
  fs.writeFileSync(pending, JSON.stringify(lease) + "\n", { flag: "wx", mode: 0o600 });
  try { fs.renameSync(pending, file); }
  finally { if (fs.existsSync(pending)) fs.unlinkSync(pending); }
}

export function createCliSessionLease(home, clientId, currentThreadId = null) {
  const identity = readProcessIdentity(process.pid);
  if (!UUID.test(clientId || "") || !identity ||
      (currentThreadId !== null && !UUID.test(currentThreadId))) {
    throw new HistoryError("ownership_unknown", "The CLI session lifetime could not be registered.");
  }
  const lease = { schemaVersion: 1, clientId, ownerPid: process.pid,
    lifetime: identity.lifetime, currentThreadId };
  writeLease(home, lease);
  return () => {
    const current = readLease(home, clientId);
    if (current?.ownerPid === lease.ownerPid && current.lifetime === lease.lifetime) {
      fs.unlinkSync(path.join(leaseDirectory(home), `${clientId}.json`));
    }
  };
}

export function registerCliThread(home, { clientId, ownerPid, currentThreadId }) {
  if (!UUID.test(clientId || "") || !UUID.test(currentThreadId || "") ||
      !Number.isSafeInteger(ownerPid)) return false;
  const lease = readLease(home, clientId);
  if (!lease || lease.ownerPid !== ownerPid) return false;
  if (lease.currentThreadId !== currentThreadId.toLowerCase()) {
    writeLease(home, { ...lease, currentThreadId: currentThreadId.toLowerCase() });
  }
  return true;
}

export function invalidateCliThread(home, clientId, ownerPid) {
  const lease = readLease(home, clientId);
  if (lease?.ownerPid === ownerPid) writeLease(home, { ...lease, currentThreadId: null });
}

export function observeCliRequest(home, headers) {
  let currentThreadId = headers.session_id;
  if (!currentThreadId && typeof headers["x-codex-turn-metadata"] === "string") {
    try { currentThreadId = JSON.parse(headers["x-codex-turn-metadata"]).thread_id; } catch { return; }
  }
  registerCliThread(home, { currentThreadId, clientId: headers["x-ccodex-session-client"],
    ownerPid: Number(headers["x-ccodex-session-owner"]) });
}

export function classifyCliOwnership(rows, leases) {
  const processes = new Map(rows.map(row => [row.pid, row]));
  const owners = new Map();
  const active = new Set();
  let unknown = false;
  for (const lease of leases) {
    const owner = processes.get(lease.ownerPid);
    if (!owner || owner.lifetime !== lease.lifetime) continue;
    owners.set(owner.pid, lease);
    if (lease.currentThreadId) active.add(lease.currentThreadId);
    else unknown = true;
  }
  for (const row of rows.filter(row => /^codex-copilot-core(?:\.exe)?$/i.test(row.name))) {
    let current = row;
    const seen = new Set();
    let found = false;
    while (current && !seen.has(current.pid)) {
      seen.add(current.pid);
      if (owners.has(current.pid)) { found = true; break; }
      current = processes.get(current.parentPid);
    }
    if (!found) unknown = true;
  }
  return { active, unknown };
}

export async function cliSessionOwnership(home) {
  if (process.platform !== "win32") return { active: new Set(), unknown: true };
  try {
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = "$ErrorActionPreference='Stop';$rows=@(Get-CimInstance Win32_Process|" +
      "ForEach-Object{@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=$_.Name;" +
      "lifetime=if($_.CreationDate){'windows:'+$_.CreationDate.ToUniversalTime().Ticks.ToString()}else{''}}});" +
      "ConvertTo-Json -InputObject $rows -Compress";
    const { stdout } = await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024,
        env: windowsSystemEnvironment() });
    const rows = JSON.parse(stdout.trim());
    if (!Array.isArray(rows)) throw new Error("Invalid process ownership snapshot.");
    let files = [];
    try { files = fs.readdirSync(leaseDirectory(home)).filter(file => UUID.test(file.slice(0, -5)) && file.endsWith(".json")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return classifyCliOwnership(rows, files.map(file => readLease(home, file.slice(0, -5))).filter(Boolean));
  } catch { return { active: new Set(), unknown: true }; }
}

export function protectCliBackend(backend, home, inspect = cliSessionOwnership) {
  const protect = (row, owners) => row && ({ ...row,
    inUse: owners.active.has(row.id) ? true : row.inUse === false && owners.unknown ? null : row.inUse });
  return {
    ...backend,
    ...(typeof backend.get === "function" ? {
      async get(id) {
        const [row, owners] = await Promise.all([backend.get(id), inspect(home)]);
        return row === undefined ? undefined : protect(row, owners);
      },
    } : {}),
    async list() {
      const [rows, owners] = await Promise.all([backend.list(), inspect(home)]);
      return rows.map(row => protect(row, owners));
    },
    async mutate(operation, id, name) {
      const owners = await inspect(home);
      if (owners.active.has(id) || owners.unknown) {
        throw new HistoryError("session_in_use", "An active or unverified CLI session is protected. Run /sessions in that CLI to identify its current thread.");
      }
      return backend.mutate(operation, id, name);
    },
  };
}
