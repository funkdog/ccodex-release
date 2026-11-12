import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertPrivateDesktopHome, desktopEnvironment, desktopSnapshot, desktopStateRoot } from "./desktop-runtime.mjs";
import { resolveDesktopMode, bindDesktopMode } from "./desktop-mode.mjs";
import { inspectBackendHost } from "./desktop-current-host.mjs";
import { awaitDesktopRenderer } from "./desktop-readiness.mjs";
import { desktopEndpointOwner, desktopProcessMatches, readProcessIdentity, sameProcessLifetime } from "./desktop-process.mjs";
import {
  acquireDesktopStartLock, bindDesktopInstance, helperProcessMatches,
  publicProcessIdentity, readDesktopInstance, writeDesktopInstance,
} from "./desktop-instance.mjs";
import { randomUUID } from "node:crypto";

async function run(script, args, env, root) {
  if (process.env.CODEX_HOME === env.CODEX_HOME &&
      process.env.CODEX_COPILOT_HOME === env.CODEX_COPILOT_HOME) {
    if (script === "bridge/ensure.mjs") {
      const { ensureBridge } = await import(pathToFileURL(path.join(root, script)).href);
      await ensureBridge();
      return;
    }
    if (script === "bridge/desktop-profile.mjs") {
      const { applyDesktopProfile } = await import(pathToFileURL(path.join(root, script)).href);
      await applyDesktopProfile({ home: env.CODEX_HOME,
        port: Number(env.CODEX_COPILOT_BRIDGE_PORT) });
      return;
    }
  }
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], {
    env, cwd: root, encoding: "utf8", windowsHide: true, timeout: 60000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `${script} exited ${result.status}`);
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function repairProfile(root, env, resources) {
  const { repairNativeProfile } = await import(
    pathToFileURL(path.join(root, "tools", "native-runtime.mjs")).href);
  const result = repairNativeProfile({ home: env.CODEX_HOME, resources, surface: "desktop" });
  for (const warning of result.warnings) console.error(warning);
}

async function startOwned(start, executable, args, options) {
  const child = start(executable, args, options);
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return child;
}

export async function launchDesktop({
  root = path.resolve(import.meta.dirname, ".."),
  home = process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot"),
  arguments: args = [],
  inherited = process.env,
  inspectOnly = false,
  inspectHost = inspectBackendHost,
  start = spawn,
  preflight = run,
  selectRuntime = desktopSnapshot,
  inspectProcess = readProcessIdentity,
  endpointOwner = desktopEndpointOwner,
  readiness = awaitDesktopRenderer,
  repair = repairProfile,
  allocatePort = freePort,
  selection,
  backend: injectedBackend,
} = {}) {
  root = path.resolve(root);
  selection ||= resolveDesktopMode({ arguments: args, inherited, legacyHome: home });
  args = selection.arguments;
  inspectOnly ||= selection.inspectOnly;
  if (selection.mode === "app-server-gateway" && !["current", "isolated"].includes(selection.host)) throw new Error("Gateway mode requires an explicit Desktop host.");
  // Current-host preparation/activation never enters the isolated snapshot
  // and profile preparation below.
  if (selection.host === "current") {
    if (selection.mode !== "app-server-gateway") throw new Error("Current host requires gateway mode.");
    const { handleCurrentHost } = await import("./desktop-current-host.mjs");
    return handleCurrentHost({ root, selection, inherited, inspectOnly, inspectHost,
      start: (executable, args, options) => startOwned(start, executable, args, options),
      inspectProcess, readiness, allocatePort, backend: injectedBackend });
  }
  home = assertPrivateDesktopHome(selection.home, { inherited });
  const backend = injectedBackend || (selection.mode === "app-server-gateway"
    ? (await import("./desktop-backends/app-server-gateway.mjs")).appServerGatewayBackend({ root, home, selection })
    : (await import("./desktop-backends/provider-bridge.mjs")).providerBridgeBackend({ root, home, inherited, preflight, repair }));
  if (backend.mode !== selection.mode) throw new Error("Desktop backend does not match the selected mode.");
  const stateRoot = desktopStateRoot({ root, home });
  if (process.platform !== "win32" && selectRuntime === desktopSnapshot &&
      !fs.existsSync(path.join(stateRoot, "desktop", "current.json")) &&
      !inspectOnly && (selection.desktopApp || fs.existsSync(path.join(home, "desktop-app-path.txt")))) {
    const { seedInstalledUnixDesktop } = await import(
      pathToFileURL(path.join(root, "tools", "desktop-unix-update.mjs")).href
    );
    seedInstalledUnixDesktop({ root, home, appPath: selection.desktopApp });
  }
  const runtime = selectRuntime(root, { stateRoot });
  const releaseAdapter = selection.mode === "provider-bridge" && fs.existsSync(path.join(root, "release.json")) && start === spawn
    ? (await import("../release/native-adapter.mjs")).startReleaseDesktop : null;
  const startDesktop = (executable, args, options) => releaseAdapter
    ? releaseAdapter(root, executable, args, options) : startOwned(start, executable, args, options);
  const environment = runtime => {
    const env = desktopEnvironment({ inherited, home, runtime });
    if (selection.mode === "app-server-gateway") {
      for (const name of Object.keys(env)) if (/^CODEX_COPILOT_/.test(name)) delete env[name];
    }
    return Object.assign(env, backend.environment());
  };
  const env = environment(runtime);
  const port = backend.bridgePort;
  // Preserve the caller's complete private runtime binding after clearing
  // Desktop-owned variables from inherited shells.
  if (!inspectOnly && selection.mode === "provider-bridge" && fs.existsSync(path.join(root, "release.json"))) {
    env.CCODEX_REAL_USERPROFILE = inherited.CCODEX_REAL_USERPROFILE || inherited.USERPROFILE;
    const { restorePinnedPrimaryRuntime, synchronizePrimaryOverrides } = await import("../release/primary-overrides.mjs");
    restorePinnedPrimaryRuntime(root, home);
    synchronizePrimaryOverrides(root, home);
  }
  const info = {
    schemaVersion: 1,
    mode: selection.mode, instanceId: selection.id, configGeneration: selection.generation,
    vendorVersion: runtime.manifest.vendorVersion,
    applicationVersion: runtime.manifest.applicationVersion,
    snapshotVersion: runtime.manifest.version,
    runtimeStateRoot: stateRoot,
    executable: runtime.executable,
    resources: runtime.resources,
    profile: env.CODEX_HOME,
    userData: env.CODEX_ELECTRON_USER_DATA_PATH,
    bridgePort: port,
    originalFilesModified: false,
    globalEnvironmentModified: false,
    nativeCoreOverride: false,
    nativeDependencyAdapter: Boolean(releaseAdapter),
  };
  if (inspectOnly) return info;
  if (!["win32", "linux", "darwin"].includes(process.platform)) {
    throw new Error("Independent Desktop is unsupported on this platform.");
  }
  if (args.some(arg => typeof arg !== "string" ||
      /^--(?:user-data-dir|remote-debugging-(?:port|address|pipe)|remote-allow-origins|app|inspect|inspect-brk)(?:=|$)/i.test(arg))) {
    throw new Error("Desktop instance, data and debugging paths are owned by the isolated launcher.");
  }
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  fs.mkdirSync(env.CODEX_ELECTRON_USER_DATA_PATH, { recursive: true });
  const release = acquireDesktopStartLock(home, { inspectProcess });
  const receiptFile = path.join(home, "desktop-instance.json");
  const helperScript = path.join(root, "bridge", "desktop-patch.mjs");
  const bind = receipt => bindDesktopInstance({
    root, home, receipt, selection, inspectProcess, owner: endpointOwner, readiness,
    snapshot: (source, options) => options.version === runtime.manifest.version
      ? runtime : selectRuntime(source, { ...options, stateRoot }),
  });
  async function ensureHelper(bound, childEnv) {
    const receipt = bound.receipt;
    const oldHelper = receipt.helperIdentity && inspectProcess(receipt.helperIdentity.pid,
      { expectedLifetime: receipt.helperIdentity.lifetime });
    if (sameProcessLifetime(receipt.helperIdentity, oldHelper) &&
        helperProcessMatches(oldHelper, { script: helperScript, receiptFile, helperToken: receipt.helperToken })) {
      return receipt;
    }
    bound.assertOwned();
    const next = { ...receipt, helperToken: randomUUID(), helperIdentity: null,
      helperPid: null, status: "ready-without-helper" };
    writeDesktopInstance(home, next);
    const helper = await startOwned(start, process.execPath, [
      helperScript, "--instance", receiptFile, "--token", next.helperToken,
    ], { env: childEnv, cwd: root, detached: true, stdio: "ignore", windowsHide: true });
    const helperIdentity = inspectProcess(helper.pid);
    if (!helperProcessMatches(helperIdentity, { script: helperScript, receiptFile, helperToken: next.helperToken })) {
      throw new Error("The new Desktop helper could not be bound to this private instance.");
    }
    bound.assertOwned();
    const result = { ...next, helperPid: helper.pid,
      helperIdentity: publicProcessIdentity(helperIdentity), status: "ready" };
    writeDesktopInstance(home, result);
    return result;
  }
  try {
    bindDesktopMode(selection);
    const existing = bind(readDesktopInstance(home));
    if (existing) {
      await existing.awaitReady();
      if (releaseAdapter) {
        const { awaitDesktopBackend } = await import("../release/desktop-startup.mjs");
        await awaitDesktopBackend({ home, receipt: existing.receipt,
          assertIdentity: existing.assertIdentity });
      }
      await backend.check();
      const existingEnv = environment(existing.runtime);
      if (selection.mode === "provider-bridge") existingEnv.CODEX_COPILOT_BRIDGE_PORT = String(existing.receipt.bridgePort);
      const receipt = backend.enhancedUi ? await ensureHelper(existing, existingEnv) : existing.receipt;
      existing.assertOwned();
      // The vendor's own private single-instance handler receives only this new
      // invocation. Do not replay a previous workspace or focus a stock app.
      const activation = await startDesktop(existing.runtime.executable, [
        `--user-data-dir=${receipt.userData}`,
        `--remote-debugging-port=${receipt.debugPort}`,
        "--remote-debugging-address=127.0.0.1", ...args,
      ], { env: existingEnv, cwd: path.dirname(existing.runtime.executable),
        detached: true, stdio: "ignore", windowsHide: false });
      existing.assertOwned();
      return { ...receipt, reused: true, activationPid: activation.pid,
        selectedSnapshot: runtime.manifest.version,
        pendingSnapshotVersion: runtime.manifest.version === receipt.snapshotVersion
          ? null : runtime.manifest.version };
    }
    await backend.prepare({ env, runtime, inherited });
    if (releaseAdapter) {
      const { prepareDesktopState } = await import("../release/desktop-preparation.mjs");
      info.nativeStateReady = await prepareDesktopState({ root, home, runtime, env });
    }
    const debugPort = await allocatePort();
    const launchArgs = [
      `--user-data-dir=${env.CODEX_ELECTRON_USER_DATA_PATH}`,
      `--remote-debugging-port=${debugPort}`,
      "--remote-debugging-address=127.0.0.1", ...args,
    ];
    const child = await startDesktop(runtime.executable, launchArgs, {
      env, cwd: path.dirname(runtime.executable), detached: true,
      stdio: "ignore", windowsHide: false,
    });
    const identity = inspectProcess(child.pid);
    if (!desktopProcessMatches(identity, {
      executable: runtime.executable, userData: env.CODEX_ELECTRON_USER_DATA_PATH,
      port: debugPort, launchArgs,
    })) {
      throw new Error("The new Desktop executable/profile identity could not be verified; no helper was started.");
    }
    let receipt = {
      ...info, schemaVersion: selection.mode === "provider-bridge" ? 2 : 3, installRoot: root, instanceToken: randomUUID(),
      pid: child.pid, identity: publicProcessIdentity(identity), debugPort,
      launchArgs, launchedAt: new Date().toISOString(), status: "starting",
      helperToken: null, helperPid: null, helperIdentity: null,
    };
    writeDesktopInstance(home, receipt);
    const bound = bind(receipt);
    const ready = await bound.awaitReady();
    const nativeReady = releaseAdapter
      ? await (await import("../release/desktop-startup.mjs")).awaitDesktopBackend({
        home, receipt, assertIdentity: bound.assertIdentity,
      }) : {};
    await backend.check();
    receipt = { ...receipt, ...ready, ...nativeReady, status: backend.enhancedUi ? "ready-without-helper" : "ready" };
    writeDesktopInstance(home, receipt);
    bound.receipt = receipt;
    const result = backend.enhancedUi ? await ensureHelper(bound, env) : receipt;
    return { ...result, reused: false };
  } finally { release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const inspectOnly = args[0] === "--inspect-only";
    if (inspectOnly) args.shift();
    const result = await launchDesktop({ inspectOnly, arguments: args });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Codex (Copilot) Desktop: ${error.message}\n`);
    process.stderr.write("The stock ChatGPT Desktop, its profile and running tasks were not changed.\n");
    process.exitCode = 1;
  }
}
