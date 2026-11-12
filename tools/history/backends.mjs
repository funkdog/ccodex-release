import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { HistoryError } from "./manager.mjs";
import { windowsSystemEnvironment } from "../../bridge/windows-system-environment.mjs";

function checkedHome(home, stock) {
  const resolved = fs.realpathSync(home);
  const stockTarget = stock && fs.existsSync(stock) ? fs.realpathSync(stock) : stock;
  if (stockTarget && path.resolve(resolved).toLowerCase() === path.resolve(stockTarget).toLowerCase()) {
    throw new HistoryError("stock_profile_refused", "The stock Codex profile is not a ccodex history-management target.");
  }
  return resolved;
}

function runtimeEnvironment(home, product) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY)(?:$|_)/i.test(key)) delete env[key];
  }
  if (product === "copilot") env.COPILOT_HOME = home;
  else Object.assign(env, { CODEX_HOME: home, CODEX_COPILOT_HOME: home });
  return env;
}

export class CodexRpc {
  constructor(core, home, { spawnProcess = spawn, timeoutMs = 20000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 0;
    this.buffer = "";
    this.child = spawnProcess(core, ["app-server"], {
      cwd: home, env: runtimeEnvironment(home, "ccodex"), windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.closed = new Promise(resolve => this.child.once("close", (code, signal) => {
      this.exitCode = code;
      for (const request of this.pending.values()) {
        request.reject(new HistoryError("native_exit", `The native history server exited (${code}/${signal}).`));
      }
      this.pending.clear();
      resolve();
    }));
    this.child.once("error", error => {
      this.startError = error;
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
    this.child.stdin.on("error", error => {
      this.startError = error;
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
    this.child.stderr.resume();
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => {
      this.buffer += chunk;
      if (this.buffer.length > 16 * 1024 * 1024) {
        for (const request of this.pending.values()) {
          request.reject(new HistoryError("native_output_limit", "Native history metadata exceeded its bounded frame size."));
        }
        this.pending.clear();
        this.child.stdin.end();
        return;
      }
      for (;;) {
        const end = this.buffer.indexOf("\n");
        if (end < 0) return;
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); }
        catch {
          for (const request of this.pending.values()) {
            request.reject(new HistoryError("native_protocol", "The native history server returned invalid JSON."));
          }
          this.pending.clear();
          continue;
        }
        const request = this.pending.get(message.id);
        if (!request) continue;
        this.pending.delete(message.id);
        if (message.error) {
          const error = new HistoryError("native_operation_failed", message.error.message || "The native history operation failed.");
          request.reject(error);
        } else request.resolve(message.result);
      }
    });
  }

  request(method, params = {}) {
    if (this.startError) return Promise.reject(this.startError);
    if (this.exitCode !== undefined) return Promise.reject(new HistoryError("native_exit", "The native history server is not running."));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HistoryError("native_timeout", `Native history request timed out: ${method}.`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "local-history-manager", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write('{"method":"initialized","params":{}}\n');
  }

  async close() {
    if (this.exitCode !== undefined) return;
    this.child.stdin.end();
    let timer;
    try {
      await Promise.race([this.closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new HistoryError("native_shutdown_timeout",
          "The owned native history server did not exit. No other process was stopped.")), this.timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
    if (this.exitCode !== 0) throw new HistoryError("native_exit", "The owned native history server did not exit successfully.");
  }
}

function nativeClientsRunning(ownPid) {
  if (process.platform === "win32") {
    const root = path.resolve(import.meta.dirname, "../..");
    const release = fs.existsSync(path.join(root, "release.json"));
    const scope = release ? ` -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${root.replaceAll("'", "''")}\\',[StringComparison]::OrdinalIgnoreCase)` : "";
    const command = "$rows=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('codex.exe','codex-copilot-core.exe')" +
      scope + " } | Select-Object ProcessId); ConvertTo-Json -InputObject $rows -Compress";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024,
      env: windowsSystemEnvironment(),
    });
    if (result.error || result.status !== 0) {
      throw new HistoryError("ownership_unknown", "Running native Codex clients could not be checked safely.");
    }
    let rows;
    try { rows = JSON.parse(result.stdout || "[]"); }
    catch { throw new HistoryError("ownership_unknown", "Native client ownership metadata is invalid."); }
    if (!Array.isArray(rows)) throw new HistoryError("ownership_unknown", "Native client ownership metadata is incomplete.");
    return rows.some(row => row.ProcessId !== ownPid);
  }
  const result = spawnSync("ps", ["-A", "-o", "pid=,comm="], {
    encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new HistoryError("ownership_unknown", "Running native Codex clients could not be checked safely.");
  }
  return result.stdout.split("\n").some(line => {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    return match && Number(match[1]) !== ownPid
      && /^(?:codex|codex-copilot-core)$/.test(path.basename(match[2]));
  });
}

const isoSeconds = value => typeof value === "number" && Number.isFinite(value)
  ? new Date(value * 1000).toISOString() : null;
const HISTORY_SOURCES = ["cli", "vscode", "exec", "appServer", "subAgent", "unknown"];

const runFile = promisify(execFile);

/** Probe the native byte-range writer locks without changing their contents. */
export async function threadWriterOwnership(home, ids) {
  if (process.platform !== "win32") return null;
  const directory = path.join(home, "thread-writer-locks");
  try {
    const stat = fs.lstatSync(directory);
    const coordination = fs.lstatSync(path.join(directory, ".coordination.lock"));
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        !coordination.isFile() || coordination.isSymbolicLink()) return null;
  } catch { return null; }
  if (ids?.some(id => !/^[a-f0-9-]{36}$/i.test(id))) {
    throw new HistoryError("invalid_session", "Writer-lock probes require explicit session IDs.");
  }
  const input = Buffer.from(JSON.stringify({ directory, ids: ids || null })).toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}')) | ConvertFrom-Json
$states = @{}
$files = if ($null -ne $inputData.ids) {
  @($inputData.ids | ForEach-Object { Join-Path $inputData.directory ($_ + '.lock') })
} else {
  @(Get-ChildItem -LiteralPath $inputData.directory -File -Filter '*.lock' |
    Where-Object { $_.Name -match '^[a-f0-9-]{36}\\.lock$' } | ForEach-Object { $_.FullName })
}
foreach ($file in $files) {
  $id = [IO.Path]::GetFileNameWithoutExtension($file).ToLowerInvariant()
  $stream = $null
  try {
    $item = Get-Item -LiteralPath $file -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $states[$id] = $null; continue }
    $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    $stream.Lock(0, 1)
    $stream.Unlock(0, 1)
    $states[$id] = $false
  } catch {
    $cause = $_.Exception
    while ($cause.InnerException) { $cause = $cause.InnerException }
    $code = $cause.HResult -band 65535
    if ($code -in @(32, 33)) { $states[$id] = $true }
    elseif ($code -eq 2 -or $_.FullyQualifiedErrorId -like 'PathNotFound*') { $states[$id] = $false }
    else { $states[$id] = $null }
  } finally { if ($stream) { $stream.Dispose() } }
}
ConvertTo-Json -InputObject $states -Compress
`;
  try {
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const { stdout } = await runFile(powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024,
        env: windowsSystemEnvironment() });
    const states = JSON.parse(stdout.trim());
    if (!states || Array.isArray(states) || typeof states !== "object" ||
        Object.values(states).some(value => value !== null && typeof value !== "boolean")) return null;
    return states;
  } catch { return null; }
}

export async function codexBackend({
  core, home, rpc, checkClients = nativeClientsRunning, checkWriters = threadWriterOwnership,
  nativeWriterLocks = false, databaseOnly = false,
}) {
  home = checkedHome(home, path.join(os.homedir(), ".codex"));
  const client = rpc || new CodexRpc(core, home);
  if (!rpc) {
    try { await client.initialize(); }
    catch (error) {
      try { await client.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Native history initialization and cleanup failed."); }
      throw error;
    }
  }
  async function ownership(ids) {
    if (!nativeWriterLocks) {
      const unknown = await checkClients(client.child?.pid);
      return () => unknown ? null : false;
    }
    const locks = await checkWriters(home, ids);
    if (locks !== null) return id => Object.hasOwn(locks, id) ? locks[id] : false;
    // The verified current Desktop core creates this directory before obtaining
    // any writer lease and enforces writer ownership atomically on mutation.
    if (nativeWriterLocks && !fs.existsSync(path.join(home, "thread-writer-locks"))) return () => false;
    const unknown = await checkClients(client.child?.pid);
    return () => unknown ? null : false;
  }
  const session = (row, archived, inUse) => ({
    id: row.id, title: row.name || row.preview || "", cwd: row.cwd || "",
    createdAt: isoSeconds(row.createdAt), modifiedAt: isoSeconds(row.updatedAt),
    archived, remote: false,
    parentId: row.source?.subAgent?.thread_spawn?.parent_thread_id || row.parentThreadId || null,
    inUse: inUse(row.id.toLowerCase()),
    operations: ["delete", archived ? "unarchive" : "archive", "rename"],
  });
  async function list() {
    const inUse = await ownership();
    const rows = [];
    for (const archived of [false, true]) {
      let cursor = null;
      const seen = new Set();
      do {
        const result = await client.request("thread/list", {
          archived, cursor, limit: 200, sortKey: "updated_at", sortDirection: "desc",
          modelProviders: [], sourceKinds: HISTORY_SOURCES, useStateDbOnly: databaseOnly,
        });
        if (!Array.isArray(result?.data)) throw new HistoryError("native_protocol", "Native thread listing is incomplete.");
        rows.push(...result.data.map(row => session(row, archived, inUse)));
        cursor = result.nextCursor || null;
        if (cursor && seen.has(cursor)) throw new HistoryError("native_pagination", "The native history cursor repeated.");
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
    return rows;
  }
  return {
    product: "ccodex", home, list,
    async get(id) {
      if (!nativeWriterLocks) return undefined;
      const inUse = await ownership([id]);
      // thread/read derives updatedAt from the rollout; previews use persisted
      // list metadata. Keep that same revision source without rescanning logs.
      for (const archived of [false, true]) {
        let cursor = null;
        const seen = new Set();
        do {
          const result = await client.request("thread/list", {
            archived, cursor, limit: 200, sortKey: "updated_at", sortDirection: "desc",
            modelProviders: [], sourceKinds: HISTORY_SOURCES, useStateDbOnly: true,
          });
          if (!Array.isArray(result?.data)) throw new HistoryError("native_protocol", "Native session metadata is incomplete.");
          const row = result.data.find(row => row.id === id);
          if (row) return session(row, archived, inUse);
          cursor = result.nextCursor || null;
          if (cursor && seen.has(cursor)) throw new HistoryError("native_pagination", "The native history cursor repeated.");
          if (cursor) seen.add(cursor);
        } while (cursor);
      }
      return null;
    },
    async mutate(operation, id, name) {
      const inUse = (await ownership([id]))(id);
      if (inUse !== false) {
        throw new HistoryError(inUse ? "session_in_use" : "ownership_unknown",
          "This session is running or its native writer ownership cannot be verified.");
      }
      const methods = { delete: "thread/delete", archive: "thread/archive",
        unarchive: "thread/unarchive", rename: "thread/name/set" };
      if (!methods[operation]) throw new HistoryError("operation_not_supported", "Unsupported native history operation.");
      if (operation === "delete" || operation === "archive") {
        // These native operations cascade through spawned children outside this ID's confirmation.
        for (const archived of operation === "delete" ? [false, true] : [false]) {
          const children = await client.request("thread/list", {
            ...(nativeWriterLocks ? { ancestorThreadId: id } : { parentThreadId: id }),
            archived, limit: 1, modelProviders: [], sourceKinds: HISTORY_SOURCES,
            useStateDbOnly: true,
          });
          if (!Array.isArray(children?.data)) {
            throw new HistoryError("native_protocol", "Native child-thread ownership could not be checked.");
          }
          if (children.data.length) {
            throw new HistoryError("native_descendants_protected",
              `Native ${operation} would affect spawned children. ${operation === "delete" ? "Delete" : "Archive"} their explicit IDs first, then create a fresh parent preview; unselected history is never changed.`);
          }
        }
      }
      await client.request(methods[operation], { threadId: id, ...(operation === "rename" ? { name } : {}) });
    },
    close: () => client.close(),
  };
}

export function discoverCopilotSdk() {
  const root = path.resolve(import.meta.dirname, "../..");
  if (fs.existsSync(path.join(root, "release.json"))) {
    const bundled = path.join(root, "runtime", "copilot", "node_modules", "@github",
      "copilot-win32-arm64", "copilot-sdk", "index.js");
    if (!fs.existsSync(bundled) || !fs.lstatSync(bundled).isFile()) {
      throw new HistoryError("sdk_unavailable", "The release-owned Copilot SDK is missing. Global SDKs are not used as a fallback.");
    }
    return bundled;
  }
  const candidates = [];
  if (process.env.COPILOT_HISTORY_SDK) candidates.push(process.env.COPILOT_HISTORY_SDK);
  if (process.platform === "win32" && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "@github", "copilot",
      "node_modules", "@github", `copilot-win32-${process.arch}`, "copilot-sdk", "index.js"));
  }
  const caches = [
    process.env.COPILOT_PKG_CACHE_HOME && path.join(process.env.COPILOT_PKG_CACHE_HOME, "pkg"),
    process.env.COPILOT_CACHE_HOME && path.join(process.env.COPILOT_CACHE_HOME, "pkg"),
    process.platform === "win32" && process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "copilot", "pkg"),
    process.platform === "darwin" && path.join(os.homedir(), "Library", "Caches", "copilot", "pkg"),
    path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "copilot", "pkg"),
    process.env.COPILOT_HOME && path.join(process.env.COPILOT_HOME, "pkg"),
    path.join(os.homedir(), ".copilot", "pkg"),
  ].filter(Boolean);
  for (const cache of new Set(caches)) {
    const packages = path.join(cache, `${process.platform}-${process.arch}`);
    if (!fs.existsSync(packages)) continue;
    for (const version of fs.readdirSync(packages).sort((a, b) => b.localeCompare(a, "en", { numeric: true }))) {
      candidates.push(path.join(packages, version, "copilot-sdk", "index.js"));
    }
  }
  if (process.platform !== "win32") {
    for (const prefix of [process.env.npm_config_prefix, "/opt/homebrew", "/usr/local", "/usr",
      path.join(os.homedir(), ".local")].filter(Boolean)) {
      candidates.push(path.join(prefix, "lib", "node_modules", "@github", "copilot",
        "node_modules", "@github", `copilot-${process.platform}-${process.arch}`, "copilot-sdk", "index.js"));
    }
  }
  const file = candidates.find(candidate => fs.existsSync(candidate) && fs.lstatSync(candidate).isFile());
  if (!file) throw new HistoryError("sdk_unavailable", "The official bundled Copilot SDK is unavailable. Set COPILOT_HISTORY_SDK to its existing index.js; no credential or session copy is needed.");
  return fs.realpathSync(file);
}

export async function copilotBackend({ home, sdkPath, client } = {}) {
  home = checkedHome(home || process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"));
  if (!client) {
    const selectedSdk = sdkPath || discoverCopilotSdk();
    const sdk = await import(pathToFileURL(selectedSdk).href);
    assert.equal(typeof sdk.CopilotClient, "function", "Official Copilot SDK client is required.");
    if (typeof sdk.CopilotRequestHandler !== "function") {
      throw new HistoryError("native_capability_missing", "The official SDK must expose a model-request guard for local-only history management.");
    }
    class MetadataOnlyRequests extends sdk.CopilotRequestHandler {
      async sendRequest() {
        throw new HistoryError("inference_refused", "History management does not send model requests.");
      }
      async openWebSocket() {
        throw new HistoryError("inference_refused", "History management does not open model connections.");
      }
    }
    client = new sdk.CopilotClient({
      connection: sdk.RuntimeConnection.forStdio(fs.existsSync(path.resolve(import.meta.dirname, "../..", "release.json"))
        ? { path: path.resolve(path.dirname(selectedSdk), "..", "copilot.exe"), args: ["--no-auto-update"] }
        : {}),
      baseDirectory: home, mode: "empty", logLevel: "error",
      env: runtimeEnvironment(home, "copilot"),
      useLoggedInUser: false,
      requestHandler: new MetadataOnlyRequests(),
    });
    await client.start();
  }
  if (typeof client.rpc?.sessions?.list !== "function" || typeof client.rpc.sessions.checkInUse !== "function"
    || typeof client.rpc.sessions.bulkDelete !== "function") {
    const errors = await client.stop();
    if (errors?.length) throw new HistoryError("native_shutdown_failed", "The unsupported Copilot metadata runtime could not be closed cleanly.");
    throw new HistoryError("native_capability_missing", "Official Copilot session listing, ownership and deletion APIs are required.");
  }
  return {
    product: "copilot", home,
    async list() {
      const result = await client.rpc.sessions.list({ source: "local" });
      if (!Array.isArray(result?.sessions)) throw new HistoryError("native_protocol", "Official Copilot did not return session metadata.");
      const ids = result.sessions.filter(row => !row.isRemote).map(row => row.sessionId);
      const checked = await client.rpc.sessions.checkInUse({ sessionIds: ids });
      if (!Array.isArray(checked?.inUse)) throw new HistoryError("ownership_unknown", "Official Copilot did not return live lock ownership.");
      const active = new Set(checked.inUse);
      return result.sessions.map(row => ({
        id: row.sessionId, title: row.name || row.summary || "",
        cwd: row.context?.cwd || row.context?.workingDirectory || "",
        createdAt: row.startTime ? new Date(row.startTime).toISOString() : null,
        modifiedAt: row.modifiedTime ? new Date(row.modifiedTime).toISOString() : null,
        archived: false, remote: row.isRemote === true, inUse: active.has(row.sessionId),
        operations: ["delete"],
      }));
    },
    async mutate(operation, id) {
      if (operation !== "delete") {
        throw new HistoryError("operation_not_supported", "This official Copilot API version supports batch deletion, not native archive/rename without reopening sessions.");
      }
      const checked = await client.rpc.sessions.checkInUse({ sessionIds: [id] });
      if (!Array.isArray(checked?.inUse)) throw new HistoryError("ownership_unknown", "Official ownership checking is unavailable.");
      if (checked.inUse.includes(id)) throw new HistoryError("session_in_use", "Official Copilot reports that this session is running.");
      const result = await client.rpc.sessions.bulkDelete({ sessionIds: [id] });
      const sizes = result?.freedBytes ?? result;
      if (!sizes || typeof sizes[id] !== "number") {
        throw new HistoryError("native_delete_failed", "Official Copilot did not confirm this session's deletion.");
      }
    },
    async close() {
      const errors = await client.stop();
      if (errors?.length) throw new HistoryError("native_shutdown_failed", "The owned Copilot metadata runtime reported a shutdown error.");
    },
  };
}
