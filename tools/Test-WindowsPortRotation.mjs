/**
 * Isolated Windows installer smoke: one fake busy old bridge, one temporary
 * profile/install, and a new real local bridge with no GitHub credentials.
 * Never connects to or stops the user's bridge on 22690.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.platform !== "win32" || process.env.CARGO_BUILD_JOBS !== "6") {
  throw new Error("Run Windows port rotation through run-heavy-build.ps1.");
}
const source = path.resolve(import.meta.dirname, "..");
const reportFile = process.argv[2] && path.resolve(process.argv[2]);
if (!reportFile) throw new Error("Provide an absolute isolated smoke report path.");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-port-rotation-"));
const profile = path.join(root, "profile");
const install = path.join(root, "CodexCopilot");
const stock = path.join(root, "stock");
for (const directory of [profile, stock]) fs.mkdirSync(directory);
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  isolatedRoot: root,
  oldBridgePreserved: false,
  newBridgeActivated: false,
  processesExited: false,
  cleaned: false,
};
let old;
let newPort;
let newPid;
let installer;
let oldExited = false;
let newExited = false;

async function processExit(child, deadlineMs = 15000) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(
      new Error(`Isolated process PID ${child.pid} did not exit in ${deadlineMs} ms`),
    ), deadlineMs);
    child.once("close", code => { clearTimeout(timer); resolve(code); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
  });
}

async function waitForPidExit(pid, deadlineMs = 15000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Isolated bridge PID ${pid} did not exit in ${deadlineMs} ms`);
}

async function run(program, args, env = process.env, deadlineMs = 120000) {
  const child = spawn(program, args, {
    cwd: source, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-60000); });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-60000); });
  const code = await processExit(child, deadlineMs);
  return { child, code, stdout, stderr };
}

try {
  old = spawn(process.execPath, [path.join(source, "tests", "fixtures", "busy-bridge.mjs")], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  report.oldBridgePid = old.pid;
  const oldPort = await Promise.race([
    new Promise((resolve, reject) => {
      let stdout = "";
      old.stdout.on("data", chunk => {
        stdout += chunk;
        const match = stdout.match(/^(\d+)\r?\n/);
        if (match) resolve(Number(match[1]));
      });
      old.once("error", reject);
      old.once("close", code => reject(new Error(`Fake busy bridge exited ${code}`)));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Fake bridge did not start")), 10000)),
  ]);
  report.oldPort = oldPort;
  fs.writeFileSync(path.join(profile, "bridge-port.txt"), `${oldPort}\n`);
  fs.writeFileSync(path.join(stock, "config.toml"), 'approval_policy = "never"\n');

  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^(?:CODEX|CCODEX|OPENAI|GITHUB|COPILOT|GH|AZURE)_/i.test(key)
      || /(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)/i.test(key)) {
      delete environment[key];
    }
  }
  Object.assign(environment, {
    CODEX_COPILOT_HOME: profile,
    CODEX_COPILOT_AUTH_MODE: "environment",
    CODEX_COPILOT_GITHUB_TOKEN: "isolated-invalid-token",
    CODEX_COPILOT_API_BASE: "http://127.0.0.1:1",
    CODEX_COPILOT_GITHUB_API_BASE: "http://127.0.0.1:1",
    CODEX_COPILOT_NONINTERACTIVE: "1",
    CODEX_COPILOT_NO_ANIMATION: "1",
    CODEX_COPILOT_SHOWCASE_URL: "",
    TEMP: root, TMP: root,
  });
  const installed = await run("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-File", path.join(source, "install.ps1"),
    "-InstallRoot", install, "-CodexCopilotHome", profile,
    "-SourceCodexHome", stock, "-NoPrerequisiteInstall", "-NoPath",
    "-NoShortcuts", "-SkipSkill", "-SkipLogin", "-AuthMode", "environment",
  ], environment);
  installer = installed.child;
  report.installerPid = installer.pid;
  report.installerExitCode = installed.code;
  if (installed.code !== 0) {
    throw new Error(`Isolated install failed: ${installed.stderr.slice(-3000)}\n${installed.stdout.slice(-3000)}`);
  }
  newPort = Number(fs.readFileSync(path.join(profile, "bridge-port.txt"), "utf8").trim());
  assert.ok(Number.isInteger(newPort) && newPort !== oldPort && newPort >= 22691 && newPort <= 22749);
  report.newPort = newPort;
  const oldHealth = await (await fetch(`http://127.0.0.1:${oldPort}/health`)).json();
  assert.equal(oldHealth.pid, old.pid);
  assert.equal(oldHealth.activeRequests, 1);
  report.oldBridgePreserved = true;
  const newHealth = await (await fetch(`http://127.0.0.1:${newPort}/health`)).json();
  assert.equal(newHealth.bridge, "codex-copilot");
  newPid = newHealth.pid;
  report.newBridgePid = newPid;
  report.newBridgeActivated = true;
  const config = fs.readFileSync(path.join(profile, "config.toml"), "utf8");
  assert.match(config, new RegExp(`base_url = "http://127\\.0\\.0\\.1:${newPort}"`));
  assert.equal(fs.existsSync(path.join(profile, `bridge-${newPort}.json`)), true);
  assert.equal(fs.existsSync(path.join(profile, `bridge-control-${newPort}.json`)), true);
  assert.equal(fs.existsSync(path.join(profile, "bridge.json")), false);
  process.stdout.write(`PASS side-by-side: busy fake PID ${old.pid} stays on ${oldPort}; new PID ${newPid} uses ${newPort}.\n`);
} catch (error) {
  report.error = error.stack || String(error);
  process.stderr.write(`${report.error}\n`);
  process.exitCode = 1;
} finally {
  try {
    const candidatePorts = newPort
      ? [newPort]
      : fs.readdirSync(profile).flatMap(name => {
        const match = name.match(/^bridge-control-(\d+)\.json$/);
        return match ? [Number(match[1])] : [];
      });
    if (candidatePorts.length) {
      const controlEnv = {
        ...process.env,
        CODEX_COPILOT_HOME: profile,
      };
      for (const port of candidatePorts) {
        controlEnv.CODEX_COPILOT_BRIDGE_PORT = String(port);
        let stoppedOk = false;
        for (let attempt = 0; attempt < 25; attempt += 1) {
          const stopped = await run(process.execPath,
            [path.join(source, "bridge", "control.mjs"), "stop"], controlEnv, 15000);
          if (stopped.code === 0 || /bridge is not running/.test(stopped.stdout)) {
            stoppedOk = true;
            break;
          }
          if (!/busy/.test(stopped.stderr)) throw new Error(stopped.stderr);
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!stoppedOk) throw new Error(`New isolated bridge on ${port} is still running.`);
      }
    }
    if (newPid) await waitForPidExit(newPid);
    newExited = true;
    if (old && old.exitCode === null && old.signalCode === null) {
      if (!old.connected) throw new Error("Fake bridge IPC channel closed before shutdown.");
      old.send({ action: "shutdown" });
    }
    if (old) {
      try {
        await processExit(old);
      } catch (error) {
        // Never leave our isolated fixture behind if its graceful shutdown
        // regresses. Preserve the failed report and temporary root for diagnosis.
        if (old.exitCode === null && old.signalCode === null) {
          old.kill();
          await processExit(old, 5000);
        }
        throw error;
      }
      oldExited = true;
    }
    report.processesExited = newExited && oldExited &&
      (!installer || installer.exitCode !== null);
    if (report.processesExited) {
      const resolved = fs.realpathSync(root);
      assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
      assert.match(path.basename(resolved), /^ccodex-port-rotation-/);
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      report.cleaned = !fs.existsSync(resolved);
    }
  } catch (cleanupError) {
    report.cleanupError = cleanupError.stack || String(cleanupError);
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  if (!report.oldBridgePreserved || !report.newBridgeActivated ||
    !report.processesExited || !report.cleaned) process.exitCode = 1;
}
