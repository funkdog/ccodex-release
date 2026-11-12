import { assertTypeScriptBuild } from "../../tools/typescript-state.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { isDeepStrictEqual } from "node:util";
import { connectGateway, writeMessage } from "../../gateway/ipc.mjs";
import { RpcPeer } from "../../gateway/rpc-peer.mjs";
import { readProcessIdentity, sameProcessLifetime } from "../desktop-process.mjs";
import { publicProcessIdentity } from "../desktop-instance.mjs";
import { prospectivePath } from "../desktop-runtime.mjs";
import { cliEnvironment, createEngines } from "../../gateway/engines/index.mjs";
import { desktopExtensionFiles } from "../desktop-extension-files.mjs";
import { currentHostContracts } from "../desktop-current-host-contract.mjs";
import { assertNativeProtocol } from "../desktop-host-capabilities.mjs";

const shellQuote = value => `'${value.replace(/'/g, "'\\''")}'`;
const runFile = promisify(execFile);
const read = file => {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error("Invalid gateway metadata file.");
  return JSON.parse(fs.readFileSync(file, "utf8"));
};
const write = (file, value) => {
  read(file);
  const pending = `${file}.${randomUUID()}.pending`;
  fs.writeFileSync(pending, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  try { fs.renameSync(pending, file); } finally { fs.rmSync(pending, { force: true }); }
};

/** Old stdio clients know the original native provider set. Only additional
 * ordinary CLI engines can share their capability; no existing route changes. */
export function isAdditiveCliConfiguration(previous, next) {
  if (!Array.isArray(previous?.engines) || !Array.isArray(next?.engines) || !previous.engines.length ||
      next.engines.length <= previous.engines.length || next.engines.length > 32 ||
      previous.defaultEngine !== next.defaultEngine || previous.workbench !== next.workbench || !isDeepStrictEqual(previous.spine ?? null, next.spine ?? null)) return false;
  const ids = next.engines.map(engine => engine?.id);
  if (ids.some(id => typeof id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) || new Set(ids).size !== ids.length) return false;
  if (!previous.engines.every(engine => isDeepStrictEqual(engine, next.engines.find(item => item.id === engine.id)))) return false;
  const prior = new Set(previous.engines.map(engine => engine.id));
  return next.engines.filter(engine => !prior.has(engine.id)).every(engine =>
    ["claude-code", "github-copilot", "antigravity-acp", "gemini-cli"].includes(engine.adapter));
}

export function appServerGatewayBackend({ root, home, selection, nativeCli }) {
  // Only this Desktop/platform contract has been observed. Other platforms
  // need their own executable shim and live verification before activation.
  if (process.platform !== "darwin") throw new Error("Gateway Desktop mode is currently validated only on macOS.");
  assertTypeScriptBuild(root);
  const directory = path.join(home, "gateway");
  const file = path.join(directory, "connection.json");
  const shim = path.join(directory, "app-server");
  const hash = createHash("sha256").update(prospectivePath(home)).digest("hex").slice(0, 20);
  const socketDirectory = path.join(os.tmpdir(), `ccodex-gw-${process.getuid()}-${hash}`);
  const endpoint = path.join(socketDirectory, "s");
  const frontend = nativeCli ? "routed-stdio.mjs" : "stdio.mjs";
  const runtimeHash = createHash("sha256").update(process.execPath);
  for (const source of desktopExtensionFiles(root).filter(file => file.startsWith("gateway/")))
    runtimeHash.update(source).update("\0").update(fs.readFileSync(path.join(root, source))).update("\0");
  const runtimeGeneration = runtimeHash.digest("hex");
  function sameRoute(current) {
    return current.home === home && current.endpoint === endpoint &&
      (current.frontend || "stdio.mjs") === frontend && (current.nativeCli || null) === (nativeCli || null);
  }
  function matches(current) { return sameRoute(current) && (current.configGeneration ?? current.generation) === selection.generation; }
  function mayRetain(current, allowCliEngineAdditions) {
    return matches(current) || (allowCliEngineAdditions && sameRoute(current) && isAdditiveCliConfiguration(current, selection.gateway));
  }
  async function check() {
    const current = read(file);
    if (!current || !matches(current) || !current.identity ||
        !sameProcessLifetime(current.identity, readProcessIdentity(current.identity?.pid))) {
      throw new Error("The selected private gateway is not running, or its configuration changed.");
    }
    const socket = await connectGateway(current);
    socket.end();
    const binding = { generation: current.generation, configGeneration: current.configGeneration ?? current.generation, connectionFile: file };
    if (current.runtimeGeneration !== runtimeGeneration) throw Object.assign(new Error("Gateway code changed; the running instance was preserved."), { code: "GATEWAY_RUNTIME_RETIRING", binding });
    return binding;
  }
  async function reconcileLegacyBirth(previous, observed) {
    // Old local-time receipts must not turn a healthy gateway into an empty
    // protected launch. Keep strict global PID/lifetime comparison: migrate
    // only after independently proving birth, executable, listener and token.
    const identity = previous?.identity;
    if (!identity || !observed || identity.platform !== "darwin" ||
        identity.pid !== observed.pid || identity.executable !== observed.executable ||
        identity.lifetime === observed.lifetime || previous.home !== home || !matches(previous)) return previous;
    const env = { ...process.env, LC_ALL: "C" }; delete env.TZ;
    let socket;
    try {
      const birth = await runFile("/bin/ps", ["-p", String(identity.pid), "-o", "lstart="],
        { env, timeout: 5000, maxBuffer: 16384 });
      if (identity.lifetime !== `macos:${birth.stdout.trim().replace(/\s+/g, " ")}`) return previous;
      const listener = await runFile("/usr/sbin/lsof", ["-nP", "-a", "-p", String(identity.pid), "-U", "-Fpn"],
        { timeout: 5000, maxBuffer: 65536 });
      const lines = listener.stdout.split(/\r?\n/);
      if (!lines.includes(`p${identity.pid}`) || !lines.includes(`n${endpoint}`) ||
          lines.filter(line => line.startsWith("p")).some(line => line !== `p${identity.pid}`)) return previous;
      socket = await connectGateway(previous);
      const after = readProcessIdentity(identity.pid);
      if (!sameProcessLifetime(observed, after) || JSON.stringify(read(file)) !== JSON.stringify(previous))
        throw new Error("Gateway identity changed during receipt reconciliation.");
      const reconciled = { ...previous, identity: publicProcessIdentity(after) };
      write(file, reconciled);
      return reconciled;
    } finally { socket?.destroy(); }
  }
  async function warmCatalog(config) {
    let socket;
    const peer = new RpcPeer(message => writeMessage(socket, message));
    try {
      socket = await connectGateway(config, message => peer.receive(message));
      socket.on("close", () => peer.close());
      await peer.request("initialize", { clientInfo: { name: "mycodex_startup", version: "0.1" } }, { timeoutMs: 5000 });
      peer.notify({ method: "initialized" });
      // Metadata only. No refresh/inference: reusing a running gateway preserves
      // its shared catalog. Finish discovery before the native picker can cache
      // a partial cold response on the first window.
      const result = await peer.request("model/list", { limit: 1000 }, { timeoutMs: 45000 });
      if (!Array.isArray(result.data) || (!result.data.length && selection.gateway.workbench !== false)) throw new Error("No engine models are available.");
      if (result.warnings?.length) console.error(`MyCodex model catalog: ${result.warnings.join("; ")}`);
    } catch (error) {
      throw new Error(`MyCodex 模型目录尚未就绪：${error.message}。尚未启动或重启 ChatGPT；可稍后重试 MyCodex。`);
    } finally { socket?.destroy(); peer.close(); }
  }
  async function retireIdle({ allowCliEngineAdditions = false } = {}) {
    const previous = read(file);
    const identity = previous?.identity;
    const observed = identity && readProcessIdentity(identity.pid);
    if (!previous || !mayRetain(previous, allowCliEngineAdditions) || previous.home !== home || previous.endpoint !== endpoint ||
        (previous.frontend || "stdio.mjs") !== frontend ||
        (previous.nativeCli || null) !== (nativeCli || null) ||
        !observed || identity.pid !== observed.pid || identity.platform !== observed.platform ||
        identity.lifetime !== observed.lifetime)
      throw new Error("Gateway retirement ownership or configuration is uncertain; no process was stopped.");
    let socket;
    const peer = new RpcPeer(message => writeMessage(socket, message));
    try {
      socket = await connectGateway(previous, message => peer.receive(message));
      socket.on("close", () => peer.close());
      await peer.request("initialize", { clientInfo: { name: "mycodex-upgrade", version: "0.1" } }, { timeoutMs: 5000 });
      const result = await peer.request("gateway/retireIfIdle", {
        expectedPid: identity.pid, expectedRuntimeGeneration: previous.runtimeGeneration,
      }, { timeoutMs: 5000 });
      return result.retiring === true;
    } catch (error) {
      // A pre-retirement gateway can only age out by its existing idle timer.
      if (error.rpc?.code === -32601) return false;
      throw error;
    } finally { socket?.destroy(); peer.close(); }
  }
  async function stage({ runtime, inherited, preserveConnectionToken = false, allowCliEngineAdditions = false }) {
    if (!currentHostContracts.some(item => item.version === runtime.manifest.applicationVersion)) {
      if (!nativeCli) throw new Error("Original native CLI is required for an updated host.");
      assertNativeProtocol(nativeCli);
    }
    // Resolve actual local SDKs without starting a CLI, requesting login or inference.
    await createEngines(selection.gateway.engines, { env: cliEnvironment(inherited), requireSelection: selection.gateway.workbench === false });
    for (const dir of [directory, socketDirectory]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("Gateway IPC requires an owned private directory.");
    }
    let previous = read(file);
    const observed = previous?.identity ? readProcessIdentity(previous.identity.pid) : null;
    if (previous) previous = await reconcileLegacyBirth(previous, observed);
    if (previous?.identity && sameProcessLifetime(previous.identity, observed)) {
      if (!matches(previous)) {
        const error = new Error("An active gateway has different settings; its configuration was not changed.");
        if (previous.home === home && previous.endpoint === endpoint &&
            (previous.frontend || "stdio.mjs") === frontend && (previous.nativeCli || null) === (nativeCli || null))
          error.code = "GATEWAY_RUNTIME_RETIRING";
        throw error;
      }
      if (previous.runtimeGeneration !== runtimeGeneration) throw Object.assign(new Error(
        "旧版网关仍在运行。当前会话没有被中断；退出 ChatGPT 后，MyCodex 会等待旧服务自动退出，再加载修复。"), { code: "GATEWAY_RUNTIME_RETIRING" });
      return { config: previous, running: true };
    }
    // A runtime updater can move a still-running Node executable. Matching
    // PID/birth permits only bounded waiting, never reuse, signals or unlink.
    if (previous?.home === home && matches(previous) && observed &&
        previous.identity?.pid === observed.pid && previous.identity.platform === observed.platform &&
        typeof previous.identity.lifetime === "string" && previous.identity.lifetime &&
        previous.identity.lifetime === observed.lifetime &&
        typeof previous.identity.executable === "string" && previous.identity.executable &&
        previous.identity.executable !== observed.executable) {
      throw Object.assign(new Error("运行时路径已变化，旧网关仍在运行。MyCodex 会等待它自动退出，再创建新实例；当前 socket 未被移除或复用。"),
        { code: "GATEWAY_RUNTIME_RETIRING" });
    }
    // Validate before unlinking a stopped listener or rewriting its shim.
    if (preserveConnectionToken && (!previous || !mayRetain(previous, allowCliEngineAdditions) ||
        typeof previous.token !== "string" || previous.token.length < 16)) throw new Error("Cannot retain a mismatching private gateway connection.");
    if (fs.existsSync(endpoint)) {
      if (!previous || previous.endpoint !== endpoint || !previous.identity || readProcessIdentity(previous.identity.pid) !== null) {
        throw new Error("Gateway socket ownership is uncertain; it was not removed.");
      }
      if (!fs.lstatSync(endpoint).isSocket()) throw new Error("Gateway endpoint is not an owned socket.");
      fs.unlinkSync(endpoint);
    }
    if (fs.existsSync(shim) && (!fs.lstatSync(shim).isFile() || fs.lstatSync(shim).isSymbolicLink())) throw new Error("Gateway shim must be a regular file.");
    const pendingShim = `${shim}.${randomUUID()}.pending`;
    const variables = `CCODEX_GATEWAY_CONNECTION=${shellQuote(file)} ` + (nativeCli ? `CCODEX_NATIVE_CLI=${shellQuote(nativeCli)} ` : "");
    fs.writeFileSync(pendingShim, `#!/bin/sh\n${variables}exec ${shellQuote(process.execPath)} ${shellQuote(path.join(root, "gateway", frontend))} "$@"\n`, { flag: "wx", mode: 0o700 });
    fs.renameSync(pendingShim, shim);
    // An explicitly coordinated idle-gateway upgrade can retain the existing
    // private connection capability, letting the live native stdio reconnect.
    const config = { home, endpoint, token: preserveConnectionToken ? previous.token : randomUUID(),
      generation: preserveConnectionToken ? previous.generation : selection.generation, configGeneration: selection.generation, runtimeGeneration, frontend,
      ...(nativeCli ? { nativeCli } : {}), engines: selection.gateway.engines, defaultEngine: selection.gateway.defaultEngine,
      ...(selection.gateway.spine ? { spine: selection.gateway.spine } : {}),
      ...(selection.gateway.workbench !== undefined ? { workbench: selection.gateway.workbench } : {}) };
    write(file, config);
    return { config, running: false };
  }
  return {
    mode: "app-server-gateway", bridgePort: null, enhancedUi: false,
    // FORCE_CLI disables *all* Desktop WebSocket hosts, including ChatGPT
    // cloud history. A routed local CLI must leave that native selection alone.
    environment: () => ({ CODEX_CLI_PATH: shim, ...(!nativeCli ? { CODEX_APP_SERVER_FORCE_CLI: "1" } : {}), CCODEX_GATEWAY_CONNECTION: file,
      ...(nativeCli ? { CCODEX_NATIVE_CLI: nativeCli } : {}) }),
    check,
    retireIdle,
    async stage(options) { await stage(options); return { connectionFile: file, shim, frontend }; },
    async prepare(options) {
      const { config, running } = await stage(options);
      const provider = selection.gateway.engines.find(engine => engine.adapter === "codex-copilot");
      if (provider) {
        try {
          const ensured = await runFile(process.execPath, [path.join(root, "bridge", "ensure.mjs"), "--preserve-running"], {
            cwd: root, timeout: 60000,
            env: { ...cliEnvironment(options.inherited), CODEX_COPILOT_HOME: provider.bridgeHome,
              CODEX_COPILOT_BRIDGE_PORT: String(provider.bridgePort) },
          });
          if (ensured.stdout.includes("update pending")) console.error("MyCodex: API bridge update pending; existing compatible provider remains available.");
        } catch (error) {
          throw new Error(error.stderr?.trim().replace(/^ccodex:\s*/, "") ||
            "Copilot API bridge 启动未完成，请查看该实例的 bridge.log。当前客户端和任务未被重启。");
        }
      }
      if (running) { await check(); await warmCatalog(config); return; }
      const log = fs.openSync(path.join(directory, "stderr.log"), "a", 0o600);
      const child = spawn(process.execPath, [path.join(root, "gateway", "server.mjs"), file], {
        cwd: root, env: cliEnvironment(options.inherited), detached: true, stdio: ["ignore", "ignore", log, "ipc"],
      });
      fs.closeSync(log);
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Gateway startup timed out.")), 30000);
          child.once("error", error => { clearTimeout(timer); reject(error); });
          child.once("exit", code => { clearTimeout(timer); reject(new Error(`Gateway exited during startup (${code}); inspect ${path.join(directory, "stderr.log")}.`)); });
          child.once("message", value => { clearTimeout(timer); value?.ready ? resolve() : reject(new Error("Invalid gateway startup response.")); });
        });
        const identity = publicProcessIdentity(readProcessIdentity(child.pid));
        write(file, { ...config, identity });
        await check();
        child.disconnect();
        child.unref();
      } catch (error) { child.kill("SIGTERM"); child.disconnect?.(); throw error; }
      // A catalog failure must not stop a ready gateway or any existing task.
      await warmCatalog(config);
    },
  };
}
