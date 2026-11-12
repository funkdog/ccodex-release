import { assertTypeScriptBuild } from "../tools/typescript-state.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileSha256, inspectOfficialDesktop, runtimePath, assertPrivateDesktopHome } from "./desktop-runtime.mjs";
import { readProcessIdentity, sameProcessLifetime } from "./desktop-process.mjs";
import { acquireDesktopStartLock, publicProcessIdentity } from "./desktop-instance.mjs";
import { desktopExtensionFiles } from "./desktop-extension-files.mjs";
import { currentHostContracts } from "./desktop-current-host-contract.mjs";
import { inspectSignedApplication, assertNativeProtocol } from "./desktop-host-capabilities.mjs";

export function inspectBackendHost(appPath) {
  inspectSignedApplication(appPath);
  const host = inspectCurrentHost(appPath, { requireUiContract: false });
  try { return { ...host, ...assertNativeProtocol(host.nativeCli) }; }
  catch (cause) { throw Object.assign(cause, { code: "HOST_PROTOCOL_MISMATCH" }); }
}

export function runningHost(executable) {
  const result = spawnSync("/bin/ps", ["-ww", "-axo", "pid=,comm="], {
    encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error("Cannot inspect the current Desktop process; no action was taken.");
  const identities = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match || match[2] !== executable) continue;
    const identity = readProcessIdentity(Number(match[1]));
    if (identity && identity.executable === executable) identities.push({ pid: identity.pid, lifetime: identity.lifetime });
  }
  return identities;
}

export function currentHostEnvironment(inherited, routing) {
  if (inherited.CODEX_ELECTRON_USER_DATA_PATH) throw new Error("Current-host launch refuses an inherited Desktop profile override.");
  if (inherited.CODEX_HOME && inherited.CODEX_HOME === inherited.CODEX_COPILOT_HOME) throw new Error("Current-host launch refuses an inherited ccodex profile.");
  const env = { ...inherited };
  for (const name of Object.keys(env)) if (/^(?:CODEX_COPILOT_|CCODEX_)/.test(name) ||
    ["CODEX_CLI_PATH", "CODEX_APP_SERVER_FORCE_CLI", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "HISTORY_DEFAULT_PRODUCT"].includes(name)) delete env[name];
  return { ...env, ...routing };
}

function writePrivate(file, value) {
  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw new Error("Invalid current-host state file.");
  const pending = `${file}.${randomUUID()}.pending`;
  fs.writeFileSync(pending, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try { fs.renameSync(pending, file); } finally { fs.rmSync(pending, { force: true }); }
}
const sourceGeneration = root => {
  const hash = createHash("sha256");
  for (const file of desktopExtensionFiles(root)) hash.update(file).update("\0").update(fs.readFileSync(path.join(root, file))).update("\0");
  return hash.digest("hex");
};

/** Prepare is safe while the current app is running. Activation is explicit and
 * refuses all running hosts; this function never quits or restarts an app. */
export async function handleCurrentHost({ root, selection, inherited, inspectOnly, inspectHost = inspectBackendHost,
  start, inspectProcess = readProcessIdentity, readiness, allocatePort, backend }) {
  if ([inspectOnly, selection.prepareOnly, selection.activate].filter(Boolean).length > 1) throw new Error("Inspect, prepare and activate are separate operations.");
  if (!inspectOnly && !selection.prepareOnly && !selection.activate) throw new Error("Current-host activation is not automatic. Use --prepare-only, then --activate after the coordinated quit.");
  const inspected = inspectHost(selection.desktopApp);
  const info = { ...inspected, mode: selection.mode, instanceId: selection.id,
    configGeneration: selection.generation, gatewayStateHome: selection.home };
  if (inspectOnly) return info;
  assertTypeScriptBuild(root);
  if (selection.arguments?.length) throw new Error("Current-host launch does not accept extra application/profile/debugging arguments.");
  currentHostEnvironment(inherited, {}); // Validate before creating state.
  if (selection.activate && inspected.running.length) throw new Error("ChatGPT is still running. No process was stopped, reconfigured or restarted; activate after the coordinated quit.");
  const home = assertPrivateDesktopHome(selection.home, { inherited });
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("Current-host enhancement state requires an owned private directory.");
  const release = acquireDesktopStartLock(home, { inspectProcess });
  try {
    backend ||= (await import("./desktop-backends/app-server-gateway.mjs")).appServerGatewayBackend({ root, home, selection, nativeCli: inspected.nativeCli });
    const preparedFile = path.join(home, "current-host-prepared.json");
    const expected = { generation: selection.generation, sourceGeneration: sourceGeneration(root),
      application: inspected.application, archiveSha256: inspected.archiveSha256, cliSha256: inspected.cliSha256, node: process.execPath };
    const options = { runtime: { manifest: { applicationVersion: inspected.applicationVersion } }, inherited };
    if (selection.prepareOnly) {
      const staged = await backend.stage(options);
      writePrivate(preparedFile, { schemaVersion: 1, ...expected, staged, preparedAt: new Date().toISOString() });
      return { ...info, inspectionOnly: false, phase: "prepared", preparedFile, ...staged, launchPerformed: false,
        nextStep: "After the coordinated quit, use the same configuration with --activate. Preparation did not start a gateway or Desktop." };
    }
    if (!fs.existsSync(preparedFile)) throw new Error("Run --prepare-only before activation.");
    const preparedStat = fs.lstatSync(preparedFile);
    if (!preparedStat.isFile() || preparedStat.isSymbolicLink() || preparedStat.size > 256 * 1024) throw new Error("Run --prepare-only before activation.");
    const prepared = JSON.parse(fs.readFileSync(preparedFile, "utf8"));
    if (prepared.schemaVersion !== 1 || Object.entries(expected).some(([key, value]) => prepared[key] !== value)) throw new Error("Source, runtime or configuration changed; prepare again before activation.");
    const routing = backend.environment();
    const env = currentHostEnvironment(inherited, routing);
    await backend.prepare(options);
    if (inspectHost(selection.desktopApp).running.length) throw new Error("ChatGPT started while preparing; no additional app was launched.");
    const uiAvailable = inspected.uiAvailable !== false;
    const port = uiAvailable ? await allocatePort() : null;
    const child = await start(inspected.executable, uiAvailable ? ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`] : [],
      { cwd: inherited.HOME || process.env.HOME, env, detached: true, stdio: "ignore" });
    const identity = publicProcessIdentity(inspectProcess(child.pid));
    if (!identity || identity.executable !== inspected.executable) throw new Error("The launched current-host process could not be verified; no UI helper was attached.");
    const receiptFile = path.join(home, "current-host-launch.json");
    const receipt = { schemaVersion: 1, ...expected, identity, port, connectionFile: routing.CCODEX_GATEWAY_CONNECTION, state: "starting",
      backendState: "ready", uiState: uiAvailable ? "starting" : "unsupported" };
    writePrivate(receiptFile, receipt);
    if (!uiAvailable) {
      writePrivate(receiptFile, { ...receipt, state: "started", helperIdentity: null });
      return { ...info, inspectionOnly: false, phase: "started", launchPerformed: true, pid: child.pid,
        backendState: "ready", uiState: "unsupported", activationVerified: false,
        nextStep: "Provider and CLI gateway are ready; page enhancement is disabled pending its separate adapter validation." };
    }
    const assertIdentity = () => {
      if (!sameProcessLifetime(identity, inspectProcess(child.pid))) throw new Error("The current-host process changed; no UI helper was attached.");
    };
    try {
      await readiness({ pid: child.pid, port, assertIdentity });
      assertIdentity();
      const helperLog = path.join(home, "current-host-ui.stderr.log");
      const log = fs.openSync(helperLog, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
      let helper;
      try {
        const logStat = fs.fstatSync(log);
        if (!logStat.isFile() || logStat.uid !== process.getuid() || (logStat.mode & 0o077)) throw new Error("UI helper log must be an owned private file.");
        helper = await start(process.execPath, [path.join(root, "bridge", "desktop-gateway-ui.mjs"), receiptFile],
          { cwd: root, env: currentHostEnvironment(inherited, {}), detached: true, stdio: ["ignore", "ignore", log] });
      } finally { fs.closeSync(log); }
      writePrivate(receiptFile, { ...receipt, state: "started", uiState: "starting", helperLog, helperIdentity: publicProcessIdentity(inspectProcess(helper.pid)) });
      return { ...info, inspectionOnly: false, phase: "started", launchPerformed: true, pid: child.pid, port,
        backendState: "ready", uiState: "starting", activationVerified: false, helperLog,
        nextStep: "Verify the native UI and both real CLI flows in this current-host session." };
    } catch (error) {
      assertIdentity();
      writePrivate(receiptFile, { ...receipt, state: "started", uiState: "unavailable", helperIdentity: null,
        uiError: String(error.message).slice(0, 1000) });
      return { ...info, inspectionOnly: false, phase: "started", launchPerformed: true, pid: child.pid,
        backendState: "ready", uiState: "unavailable", activationVerified: false,
        nextStep: "Provider and CLI gateway remain available; inspect the separate UI helper error." };
    }
  } finally { release(); }
}

/** Read-only host inspection. No profile discovery/writes, gateway startup,
 * app copying, process signals, CDP attachment or Desktop launch. */
export function inspectCurrentHost(appPath, { platform = process.platform, arch = process.arch, requireUiContract = true,
  inspectArchive = inspectOfficialDesktop, hash = fileSha256, processes = runningHost } = {}) {
  if (platform !== "darwin" || arch !== "arm64") throw new Error("Current-host inspection is pinned to the verified macOS ARM64 installation.");
  if (typeof appPath !== "string" || !path.isAbsolute(appPath) || !appPath.endsWith(".app")) throw new Error("Current host requires an explicit absolute installed .app path.");
  const app = fs.realpathSync(appPath);
  const archive = runtimePath(app, "Contents/Resources/app.asar");
  const nativeCli = runtimePath(app, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
  const executable = runtimePath(app, "Contents/MacOS/ChatGPT");
  for (const file of [archive, nativeCli, executable]) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Current-host files must be regular files inside the selected installation.");
  }
  const contract = inspectArchive(archive);
  const archiveSha256 = hash(archive), cliSha256 = hash(nativeCli);
  const uiAvailable = currentHostContracts.some(verified => contract.version === verified.version &&
      archiveSha256 === verified.archive && cliSha256 === verified.cli);
  if (requireUiContract && !uiAvailable) {
    throw Object.assign(new Error(`当前 ChatGPT ${contract.version} 的安装文件与 MyCodex 已验证版本不一致。需要适配并验证此版本后才能启用增强；当前客户端和会话未被修改。`),
      { code: "HOST_CONTRACT_MISMATCH" });
  }
  return {
    schemaVersion: 1, host: "current", inspectionOnly: true, activationReady: false,
    application: app, executable, nativeCli, applicationVersion: contract.version, uiAvailable,
    archiveSha256, cliSha256, running: processes(executable),
    profilePolicy: "preserve-existing-no-profile-override", launchPerformed: false,
    originalFilesModified: false, globalEnvironmentModified: false,
    nextStep: "Use --prepare-only now. Activate explicitly after the coordinated quit; live current-host UI acceptance is still pending.",
  };
}
