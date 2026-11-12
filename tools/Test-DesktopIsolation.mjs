import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { desktopEnvironment, desktopSnapshot, fileSha256 } from "../bridge/desktop-runtime.mjs";
import { connectCdp } from "../bridge/desktop-cdp.mjs";

if (process.env.CARGO_BUILD_JOBS !== "6") throw new Error("Run through run-heavy-build.ps1.");
const [root, reportFile, candidate] = process.argv.slice(2);
if (!root || !reportFile) throw new Error("Usage: Test-DesktopIsolation.mjs <snapshot-install-root> <report.json>");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-desktop-isolation-"));
const profile = path.join(temporary, "copilot");
const stock = path.join(os.homedir(), ".codex");
const stockConfig = path.join(stock, "config.toml");
const stockHash = fs.existsSync(stockConfig) ? fileSha256(stockConfig) : null;
const report = {
  schemaVersion: 1, startedAt: new Date().toISOString(),
  isolatedProfile: profile, noUserInputSent: true, providerIsLoopbackStub: true, processesStopped: [],
  stockConfigSha256Before: stockHash, passed: false,
};
let child;
let connection;
let exited;
let childClosed = false;
const server = net.createServer(socket => {
  socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
});
try {
  const runtime = desktopSnapshot(root, candidate ? { version: candidate } : {});
  report.snapshot = runtime.manifest.version;
  report.officialApplicationBytesVerified = true;
  const discovery = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "(Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation"],
  { encoding: "utf8", windowsHide: true, timeout: 15000 });
  if (discovery.status !== 0 || !discovery.stdout.trim()) {
    throw new Error("Original Desktop package cannot be located for unchanged-file verification.");
  }
  report.originalExecutable = path.join(discovery.stdout.trim(), "app", "ChatGPT.exe");
  report.originalExecutableSha256Before = fileSha256(report.originalExecutable);
  fs.mkdirSync(profile);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const providerPort = server.address().port;
  fs.writeFileSync(path.join(profile, "config.toml"), `model_provider = "isolated-test"
model = "gpt-isolated-test"
approval_policy = "on-request"
sandbox_mode = "read-only"
[model_providers.isolated-test]
name = "Isolated Desktop verification"
base_url = "http://127.0.0.1:${providerPort}"
wire_api = "responses"
requires_openai_auth = false
[plugins."chrome@openai-bundled"]
enabled = false
[plugins."computer-use@openai-bundled"]
enabled = false
`, "utf8");
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const env = desktopEnvironment({ inherited: process.env, home: profile, runtime });
  // Never inherit real account credentials into an automated profile.
  for (const name of Object.keys(env)) {
    if (/(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY)(?:$|_)/i.test(name)) delete env[name];
  }
  child = spawn(runtime.executable, [
    `--user-data-dir=${env.CODEX_ELECTRON_USER_DATA_PATH}`,
    `--remote-debugging-port=${port}`,
  ], { env, cwd: path.dirname(runtime.executable), stdio: "ignore", windowsHide: false });
  report.pid = child.pid;
  report.userData = env.CODEX_ELECTRON_USER_DATA_PATH;
  report.executable = runtime.executable;
  report.coreOverrideAbsent = !Object.hasOwn(env, "CODEX_CLI_PATH");
  exited = new Promise(resolve => {
    child.once("error", error => { report.launchError = error.message; childClosed = true; resolve(); });
    child.once("close", code => { report.exitCode = code; childClosed = true; resolve(); });
  });
  const deadline = Date.now() + 45000;
  let endpoint;
  while (Date.now() < deadline && !childClosed) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        endpoint = (await response.json()).webSocketDebuggerUrl;
        if (endpoint) break;
      }
    } catch { /* Startup does not have a debugger listener immediately. */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  if (!endpoint || childClosed) throw new Error("The independent official Desktop did not start its private debugger endpoint.");
  const owner = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess`],
  { encoding: "utf8", windowsHide: true, timeout: 10000 });
  if (owner.status !== 0 || Number(owner.stdout.trim()) !== child.pid) {
    throw new Error("The private Desktop endpoint is not owned by the test process; no shutdown request was sent.");
  }
  connection = await connectCdp(endpoint, { timeoutMs: 10000 });
  report.browserVersion = await connection.send("Browser.getVersion");
  report.privateEndpointOwnedByTestProcess = true;
  report.vendorUserDataCreated = fs.existsSync(env.CODEX_ELECTRON_USER_DATA_PATH);
  report.stockConfigSha256After = fs.existsSync(stockConfig) ? fileSha256(stockConfig) : null;
  report.originalExecutableSha256After = fileSha256(report.originalExecutable);
  report.stockConfigUnchanged = report.stockConfigSha256Before === report.stockConfigSha256After;
  report.originalExecutableUnchanged =
    report.originalExecutableSha256Before === report.originalExecutableSha256After;
  report.passed = report.coreOverrideAbsent && report.stockConfigUnchanged &&
    report.originalExecutableUnchanged && report.vendorUserDataCreated;
} catch (error) {
  report.error = error.message;
} finally {
  if (connection && report.privateEndpointOwnedByTestProcess) {
    try { await connection.send("Browser.close"); }
    catch { /* Browser.close may close the transport before acknowledging. */ }
    connection.close();
    report.gracefulShutdownRequestedPids = [report.pid];
  }
  if (child) {
    let timer;
    await Promise.race([
      exited,
      new Promise(resolve => { timer = setTimeout(resolve, 30000); }),
    ]);
    clearTimeout(timer);
    report.testProcessExited = childClosed;
    if (!childClosed && report.privateEndpointOwnedByTestProcess) {
      // This vendor closes to the tray. Cleanup is part of the same heavy
      // worker and may terminate only its independently verified empty fixture.
      fs.mkdirSync(path.dirname(path.resolve(reportFile)), { recursive: true });
      fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      const cleanup = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File",
        path.join(root, "tools", "Clean-DesktopIsolation.ps1"), "-ReportFile", path.resolve(reportFile)],
      { windowsHide: true, encoding: "utf8", timeout: 30000 });
      if (cleanup.status === 0) {
        const result = JSON.parse(fs.readFileSync(reportFile, "utf8"));
        report.ownedEmptyTestPidsTerminated = result.ownedEmptyTestPidsTerminated;
        report.originalProcessesStopped = result.originalProcessesStopped;
        report.cleanupVerifiedAt = result.cleanupVerifiedAt;
        report.testProcessExited = result.testProcessExited;
        report.temporaryProfileRemoved = result.temporaryProfileRemoved;
        child.unref();
        childClosed = true;
      } else {
        report.cleanupError = cleanup.stderr?.trim() || cleanup.error?.message || "Owned test cleanup failed.";
        // Deliver the child close event that may have arrived while cleanup
        // ran synchronously, so file cleanup is not mislabeled as a live app.
        await new Promise(resolve => setImmediate(resolve));
        report.testProcessExited = childClosed;
      }
    }
  }
  await new Promise(resolve => server.close(resolve));
  if ((!child || childClosed) && !report.temporaryProfileRemoved) {
    const actual = fs.realpathSync(temporary);
    if (path.dirname(actual) !== fs.realpathSync(os.tmpdir()) ||
        !path.basename(actual).startsWith("ccodex-desktop-isolation-")) {
      throw new Error("Refusing cleanup outside the owned isolation test.");
    }
    fs.rmSync(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
    report.temporaryProfileRemoved = true;
  } else if (!childClosed) {
    report.passed = false;
    report.cleanupDeferred = "The isolated test lifetime or file cleanup is unconfirmed; its profile was preserved. Original user processes were not targeted.";
  }
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(path.resolve(reportFile)), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed && report.testProcessExited ? 0 : 1;
}
