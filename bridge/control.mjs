import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CODEX_COPILOT_HOME } from "./auth.mjs";
import { selectedBridgePort } from "./port-selection.mjs";
import { windowsSystemEnvironment } from "./windows-system-environment.mjs";
import {
  bridgeMismatchMessage,
  probeLocalBridge,
} from "./local-bridge.mjs";

const HOST = process.env.CODEX_COPILOT_BRIDGE_HOST || "127.0.0.1";
const PORT = selectedBridgePort({ home: CODEX_COPILOT_HOME, env: process.env });
const EXPECTED_BRIDGE = "codex-copilot";
const RUNTIME_FILE = path.join(CODEX_COPILOT_HOME, `bridge-${PORT}.json`);
const LEGACY_RUNTIME_FILE = path.join(CODEX_COPILOT_HOME, "bridge.json");
const CONTROL_FILE = path.join(CODEX_COPILOT_HOME, `bridge-control-${PORT}.json`);
const PROBE_HOST = HOST === "::1" ? "[::1]" : HOST;
const CONTROL_URL = `http://${PROBE_HOST}:${PORT}/_control/stop`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function bridgeHealth(timeoutMs = 2500) {
  const probe = await probeLocalBridge({
    host: PROBE_HOST,
    port: PORT,
    expectedBridge: EXPECTED_BRIDGE,
    timeoutMs,
  });
  return probe.kind === "ok" ? probe.health : null;
}

function processIdentity(pid) {
  if (process.platform === "win32") {
    const script =
      `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
      `$w = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; ` +
      `if (-not $w.CommandLine) { throw 'Process command line unavailable' }; ` +
      `[Console]::WriteLine($p.StartTime.ToUniversalTime().Ticks.ToString() + '|' + ` +
      `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($w.CommandLine)))`;
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 10000, env: windowsSystemEnvironment() },
    ).trim();
    const match = output.match(/^(\d+)\|([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error("Could not verify the legacy bridge process identity.");
    return { started: match[1], command: Buffer.from(match[2], "base64").toString("utf8") };
  }
  if (process.platform === "linux") {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    return { started, command };
  }
  const output = execFileSync(
    "ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="],
    { encoding: "utf8", timeout: 10000, env: { ...process.env, LC_ALL: "C" } },
  ).trim();
  const match = output.match(/^(.{24})\s+(.+)$/s);
  if (!match) throw new Error("Could not verify the legacy bridge process identity.");
  return { started: match[1], command: match[2] };
}

function assertLegacyProcess(identity) {
  if (!identity.started || !/[\\/]bridge[\\/]server\.mjs(?:["'\s]|$)/i.test(identity.command)) {
    throw new Error("Refusing legacy shutdown: PID is not a verified bridge/server.mjs process.");
  }
}

function assertLegacyIdle(health, original) {
  if (
    health?.bridge !== EXPECTED_BRIDGE ||
    health.pid !== original.pid ||
    health.endpoint !== `http://${HOST}:${PORT}` ||
    health.endpoint !== original.endpoint ||
    health.runtime?.sourceGeneration !== original.runtime.sourceGeneration ||
    health.runtime?.controlProtocol !== undefined ||
    health.activeRequests !== 0
  ) {
    throw new Error("Refusing legacy shutdown: bridge became busy or its identity changed.");
  }
}

function terminateLegacyProcess(pid, identity) {
  if (process.platform === "win32") {
    const script =
      `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
      `if ($p.StartTime.ToUniversalTime().Ticks.ToString() -ne '${identity.started}') ` +
      `{ throw 'Legacy bridge PID changed before stop' }; ` +
      `Stop-Process -InputObject $p -Force -ErrorAction Stop`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: "ignore", windowsHide: true, timeout: 15000,
      env: windowsSystemEnvironment(),
    });
    return;
  }
  const latest = processIdentity(pid);
  assertLegacyProcess(latest);
  if (latest.started !== identity.started || latest.command !== identity.command) {
    throw new Error("Refusing legacy shutdown: process identity changed before stop.");
  }
  process.kill(pid, "SIGTERM");
}

function readRuntimeRecord(file, { legacy = false } = {}) {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("not a regular file");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (legacy && error.code === "ENOENT") return null;
    throw new Error(
      legacy
        ? "Refusing legacy shutdown: bridge.json is unreadable or invalid."
        : "Refusing shutdown: per-port bridge runtime record is unavailable.",
    );
  }
}

function assertPortRuntime(health) {
  const record = readRuntimeRecord(RUNTIME_FILE);
  if (
    record.pid !== health.pid ||
    record.port !== PORT ||
    record.runtime?.controlProtocol !== 1 ||
    record.runtime.instanceId !== health.runtime.instanceId ||
    record.runtime.sourceGeneration !== health.runtime.sourceGeneration
  ) {
    throw new Error("Refusing shutdown: per-port runtime record belongs to another bridge instance.");
  }
}

function legacyRuntimeIdentity(health) {
  // Old versions own bridge.json. This controller never writes or removes it.
  const record = readRuntimeRecord(LEGACY_RUNTIME_FILE, { legacy: true });
  if (!record) return null;
  if (
    record.pid !== health.pid ||
    record.port !== PORT ||
    record.host !== HOST ||
    typeof record.started_at !== "string" ||
    !record.started_at ||
    (health.runtime?.sourceGeneration &&
      record.runtime?.sourceGeneration !== health.runtime.sourceGeneration)
  ) {
    throw new Error("Refusing legacy shutdown: bridge.json belongs to another port or process.");
  }
  return {
    pid: record.pid,
    port: record.port,
    host: record.host,
    startedAt: record.started_at,
    generation: record.runtime?.sourceGeneration ?? null,
  };
}

function readControlToken(health) {
  let record;
  try {
    if (!fs.lstatSync(CONTROL_FILE).isFile()) throw new Error("not a regular file");
    record = JSON.parse(fs.readFileSync(CONTROL_FILE, "utf8"));
  } catch {
    throw new Error("Refusing shutdown: the bridge control credential is unavailable.");
  }
  if (
    record.pid !== health.pid ||
    typeof health.runtime.instanceId !== "string" ||
    !health.runtime.instanceId ||
    record.instanceId !== health.runtime.instanceId ||
    typeof record.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(record.token)
  ) {
    throw new Error("Refusing shutdown: bridge control credential belongs to another instance.");
  }
  return record.token;
}

async function stopWithControl(health) {
  assertPortRuntime(health);
  const token = readControlToken(health);
  let response;
  try {
    response = await new Promise((resolve, reject) => {
      const request = http.request(CONTROL_URL, {
        method: "POST",
        headers: { "x-codex-copilot-control": token, connection: "close" },
        timeout: 5000,
      }, (reply) => {
        let body = "";
        reply.on("data", (chunk) => {
          body += chunk;
          if (body.length > 4096) request.destroy(new Error("Control response too large."));
        });
        reply.on("end", () => {
          let result = {};
          try { result = JSON.parse(body); } catch { /* malformed response fails closed */ }
          resolve({ status: reply.statusCode, result });
        });
        reply.on("error", reject);
      });
      request.on("timeout", () => request.destroy(new Error("Control request timed out.")));
      request.on("error", reject);
      request.end();
    });
  } catch {
    throw new Error(`Bridge PID ${health.pid} could not confirm a safe shutdown; no force-stop attempted.`);
  }
  const { result } = response;
  if (response.status === 409) {
    throw new Error(
      `Bridge PID ${health.pid} is busy ` +
      `(${result.activeRequests ?? "unknown"} active requests, ` +
      `${result.backgroundJobs ?? "unknown"} background jobs); not stopped.`,
    );
  }
  if (response.status !== 202 || result.pid !== health.pid ||
      result.instanceId !== health.runtime.instanceId) {
    throw new Error(`Bridge PID ${health.pid} rejected safe shutdown (HTTP ${response.status}); no force-stop attempted.`);
  }
}

async function stopLegacy(health) {
  const legacyRecord = legacyRuntimeIdentity(health);
  if (
    (!health.runtime?.sourceGeneration || typeof health.runtime.sourceGeneration !== "string") &&
    !legacyRecord?.generation
  ) {
    throw new Error("Refusing legacy shutdown: source generation is missing.");
  }
  assertLegacyIdle(health, health);
  let identity;
  try {
    identity = processIdentity(health.pid);
    assertLegacyProcess(identity);
  } catch {
    throw new Error("Refusing legacy shutdown: PID/process identity could not be verified.");
  }
  let response;
  try {
    response = await fetch(CONTROL_URL, {
      method: "POST", signal: AbortSignal.timeout(2500), redirect: "error",
    });
  } catch {
    throw new Error("Refusing legacy shutdown: control endpoint absence could not be verified.");
  }
  if (response.status !== 404) {
    throw new Error(`Refusing legacy shutdown: control endpoint returned HTTP ${response.status}, not 404.`);
  }

  // Older servers cannot atomically close admission. Require repeated idle/identity
  // evidence, and never force-stop on a missing, busy, or changing observation.
  for (let sample = 0; sample < 4; sample += 1) {
    await sleep(250);
    const probe = await probeLocalBridge({
      host: PROBE_HOST, port: PORT, expectedBridge: EXPECTED_BRIDGE, timeoutMs: 2500,
    });
    if (probe.kind !== "ok") {
      throw new Error("Refusing legacy shutdown: bridge health became unavailable.");
    }
    assertLegacyIdle(probe.health, health);
    if (JSON.stringify(legacyRuntimeIdentity(probe.health)) !== JSON.stringify(legacyRecord)) {
      throw new Error("Refusing legacy shutdown: bridge.json changed during idle checks.");
    }
    let current;
    try {
      current = processIdentity(health.pid);
      assertLegacyProcess(current);
    } catch {
      throw new Error("Refusing legacy shutdown: process identity could not be reverified.");
    }
    if (current.started !== identity.started || current.command !== identity.command) {
      throw new Error("Refusing legacy shutdown: process identity changed.");
    }
  }
  terminateLegacyProcess(health.pid, identity);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitForExit(pid) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await sleep(200);
  }
  throw new Error(`Bridge PID ${pid} did not exit within 15 seconds; no force-stop attempted.`);
}

export async function stopBridge({ quiet = false, expectedInstance = null } = {}) {
  if (!["127.0.0.1", "localhost", "::1"].includes(HOST)) {
    throw new Error("Refusing bridge shutdown over a non-loopback address.");
  }
  const probe = await probeLocalBridge({
    host: PROBE_HOST,
    port: PORT,
    expectedBridge: EXPECTED_BRIDGE,
  });
  if (probe.kind === "mismatch") {
    throw new Error(
      `Refusing to stop another application. ${bridgeMismatchMessage(probe, PORT, EXPECTED_BRIDGE)}`,
    );
  }
  const health = probe.kind === "ok" ? probe.health : null;
  if (expectedInstance && (!health || health.pid !== expectedInstance.pid ||
      health.runtime?.instanceId !== expectedInstance.runtime?.instanceId ||
      health.runtime?.sourceGeneration !== expectedInstance.runtime?.sourceGeneration)) {
    throw new Error("Refusing shutdown: bridge instance changed before retirement; no process was stopped.");
  }
  if (!health) {
    if (!quiet) process.stdout.write("bridge is not running\n");
    return false;
  }
  if (!Number.isInteger(health.pid) || health.pid <= 0) {
    throw new Error("Refusing bridge shutdown: health returned an invalid PID.");
  }
  if (health.runtime?.controlProtocol === 1) {
    await stopWithControl(health);
  } else if (health.runtime?.controlProtocol === undefined) {
    await stopLegacy(health);
  } else {
    throw new Error("Refusing bridge shutdown: unsupported control protocol.");
  }
  await waitForExit(health.pid);
  if (!quiet) process.stdout.write(`stopped pid ${health.pid}\n`);
  return true;
}

async function main() {
  const command = (process.argv[2] || "status").toLowerCase();
  if (command === "stop") {
    await stopBridge();
    return;
  }
  if (command === "status") {
    const probe = await probeLocalBridge({
      host: PROBE_HOST,
      port: PORT,
      expectedBridge: EXPECTED_BRIDGE,
    });
    if (probe.kind === "mismatch") {
      process.stderr.write(`${bridgeMismatchMessage(probe, PORT, EXPECTED_BRIDGE)}\n`);
      process.exitCode = 1;
      return;
    }
    const health = probe.kind === "ok" ? probe.health : null;
    if (!health) {
      process.stdout.write("bridge is not running\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown bridge control command '${command}'.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
