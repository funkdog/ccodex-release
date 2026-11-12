/**
 * Makes sure the GitHub Copilot bridge is listening before Codex starts.
 * Spawns it fully detached (no console window, no inherited handles) and waits
 * for /health to answer.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  bridgeMismatchMessage,
  probeLocalBridge,
} from "./local-bridge.mjs";
import { selectedBridgePort } from "./port-selection.mjs";
import { bridgeSourceGeneration, requireBridgeGeneration } from "./runtime-generation.mjs";
import { windowsSystemEnvironment } from "./windows-system-environment.mjs";
import { desktopEndpointOwner } from "./desktop-process.mjs";

const HOST = process.env.CODEX_COPILOT_BRIDGE_HOST || "127.0.0.1";
const EXPECTED_BRIDGE = "codex-copilot";
const SERVER = path.join(import.meta.dirname, "server.mjs");
const EXPECTED_GENERATION = bridgeSourceGeneration();
const HOME =
  process.env.CODEX_COPILOT_HOME ||
  process.env.CODEX_HOME ||
  path.join(process.env.USERPROFILE || ".", ".codex-copilot");
const PORT = selectedBridgePort({ home: HOME });
process.env.CODEX_COPILOT_BRIDGE_PORT = String(PORT);

let lastProbe = null;

async function health(timeoutMs = 2000) {
  lastProbe = await probeLocalBridge({
    host: HOST,
    port: PORT,
    expectedBridge: EXPECTED_BRIDGE,
    timeoutMs,
  });
  return lastProbe.kind === "ok" ? lastProbe.health : null;
}

/**
 * On Windows, child_process.spawn always requests handle inheritance, so a plain
 * detached spawn keeps whatever pipe the launching shell handed us open for as long
 * as the bridge lives - which makes `codex-copilot ... | something` hang forever.
 * Going through ShellExecute (Start-Process) creates the process with
 * bInheritHandles = FALSE while still passing our environment block down.
 */
function launchViaShellExecute() {
  if (process.platform !== "win32") return false;
  const quote = (value) => value.replace(/'/g, "''");
  const script =
    `Start-Process -FilePath '${quote(process.execPath)}' ` +
    `-ArgumentList '"${quote(SERVER)}"' -WindowStyle Hidden`;
  try {
    // -EncodedCommand avoids every layer of Windows/PowerShell quote mangling, and the
    // shim is run synchronously: it returns as soon as ShellExecute has created the
    // bridge, so nothing long-lived is left holding an inherited handle.
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { stdio: "ignore", windowsHide: true, timeout: 30000, env: windowsSystemEnvironment() }
    );
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function launchDirect() {
  const child = spawn(process.execPath, [SERVER], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const status = await health();
    if (status) return status;
  }
  return null;
}

function assertReusableBridge(existing) {
  const runtime = existing.runtime;
  if (!process.env.CODEX_COPILOT_HOME || HOST !== "127.0.0.1" || existing.status !== "ok" ||
      existing.endpoint !== `http://${HOST}:${PORT}` || runtime?.controlProtocol !== 1 ||
      runtime.responsesItemIdentity !== 1 || runtime.responsesStreamContinuity !== 1 ||
      runtime.responsesReasoningCheckpoints !== 0 || runtime.responsesTimeoutCompaction !== 0 ||
      runtime.responsesAbortableRetries !== 1 || runtime.responsesCapabilityDowngrade !== 0)
    throw new Error("Running Copilot bridge does not advertise the required provider contract; it was preserved.");
  const file = path.join(HOME, `bridge-${PORT}.json`), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 ||
      process.platform !== "win32" && stat.uid !== process.getuid())
    throw new Error("Running Copilot bridge ownership record is invalid.");
  const controlFile = path.join(HOME, `bridge-control-${PORT}.json`), controlStat = fs.lstatSync(controlFile);
  if (!controlStat.isFile() || controlStat.isSymbolicLink() || controlStat.size > 16384 ||
      process.platform !== "win32" && (controlStat.uid !== process.getuid() || controlStat.mode & 0o077))
    throw new Error("Running Copilot bridge private ownership record is invalid.");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const control = JSON.parse(fs.readFileSync(controlFile, "utf8"));
  if (record.pid !== existing.pid || record.port !== PORT ||
      record.runtime?.instanceId !== runtime.instanceId || record.runtime?.sourceGeneration !== runtime.sourceGeneration ||
      control.pid !== existing.pid || control.instanceId !== runtime.instanceId || !/^[A-Za-z0-9_-]{43}$/.test(control.token) ||
      typeof runtime.instanceId !== "string" || !runtime.instanceId ||
      desktopEndpointOwner(PORT, { pid: existing.pid }) !== existing.pid)
    throw new Error("Running Copilot bridge belongs to another instance; it was preserved.");
}

export async function ensureBridge({ verbose = false, refreshIdle = false, preserveRunning = false } = {}) {
  const existing = await health();
  if (existing) {
    if (existing.runtime?.sourceGeneration === EXPECTED_GENERATION) {
      if (verbose) process.stdout.write(`bridge already running (pid ${existing.pid})\n`);
      return;
    }
    // Desktop readiness and applying proxy repairs have different lifetimes.
    // Reuse only the selected owned, compatible instance; never claim that its
    // code was upgraded or interrupt ongoing requests/background jobs.
    if (preserveRunning) {
      assertReusableBridge(existing);
      process.stdout.write("Existing compatible Copilot API bridge preserved; update pending.\n");
      return;
    }
    if (!refreshIdle) requireBridgeGeneration(existing, EXPECTED_GENERATION);
    // Opt in only for an explicit provider profile. The authenticated control
    // endpoint atomically rejects retirement if requests or background jobs
    // are active; legacy processes never get an automatic signal fallback.
    if (!process.env.CODEX_COPILOT_HOME || existing.runtime?.controlProtocol !== 1) {
      throw new Error("Copilot API bridge 无法自动升级：缺少明确的实例目录或安全控制协议。现有进程保持运行。");
    }
    const { stopBridge } = await import("./control.mjs");
    try { await stopBridge({ quiet: true, expectedInstance: existing }); }
    catch (error) { throw new Error(`Copilot API bridge 安全升级未完成：${error.message}`); }
  }
  if (lastProbe?.kind === "mismatch") {
    throw new Error(bridgeMismatchMessage(lastProbe, PORT, EXPECTED_BRIDGE));
  }

  let status = null;
  if (launchViaShellExecute()) status = await waitForHealth(20000);
  if (!status) {
    launchDirect();
    status = await waitForHealth(25000);
  }

  if (status) {
    requireBridgeGeneration(status, EXPECTED_GENERATION);
    if (verbose) process.stdout.write(`bridge started (pid ${status.pid})\n`);
    return;
  }
  if (lastProbe?.kind === "mismatch") {
    throw new Error(bridgeMismatchMessage(lastProbe, PORT, EXPECTED_BRIDGE));
  }
  process.stderr.write(
    `codex-copilot: the GitHub Copilot bridge did not start. See ${path.join(HOME, "bridge.log")} for details.\n`
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  ensureBridge({ verbose: process.argv.includes("--verbose"), refreshIdle: process.argv.includes("--refresh-idle"),
    preserveRunning: process.argv.includes("--preserve-running") }).catch((error) => {
    process.stderr.write(`ccodex: ${error.message}\n`);
    process.exitCode = 1;
  });
}
