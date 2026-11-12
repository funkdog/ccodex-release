import "../tools/typescript-runtime.mjs";
import { assertTypeScriptBuild } from "../tools/typescript-state.mjs";
import type { ConnectionConfig, EngineConfig } from "./contracts.mjs";
import type { Readable, Writable } from "node:stream";
import type { Socket } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { AppServerRouter } from "./router.mjs";
import { RpcPeer } from "./rpc-peer.mjs";
import { startNativePeer, nativeEnvironment, validateNativeCommand } from "./native-peer.mjs";
import { connectGateway, readMessages, writeMessage } from "./ipc.mjs";
import { readThreadOwnership } from "./state.mjs";
import { copilotProviderArguments, copilotProviderConfig, copilotProviderId } from "./copilot-provider.mjs";
import { googleProviderArguments, googleProviderConfig, googleProviderId, googleProviderToken } from "./google-provider.mjs";
import { validateSpineOptions } from "./spine-config.mjs";

assertTypeScriptBuild(path.resolve(import.meta.dirname, ".."));

export function readRoutingConnection(file: string | undefined, { isolateSpine = false, onSpineUnavailable = () => {} }: { isolateSpine?: boolean; onSpineUnavailable?: () => void } = {}): ConnectionConfig {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("A private gateway connection file is required.");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("Invalid private gateway connection file.");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  if ((config.workbench !== undefined && typeof config.workbench !== "boolean") ||
      (config.workbench === false && config.spine !== undefined)) throw new Error("Invalid workbench configuration.");
  if (!path.isAbsolute(config.home || "") || typeof config.token !== "string" || config.token.length < 16 ||
      typeof config.endpoint !== "string" || typeof config.generation !== "string") throw new Error("Invalid routing connection metadata.");
  try { validateSpineOptions(config.spine); }
  catch (cause) {
    if (!isolateSpine) throw cause;
    config.spine = undefined;
    onSpineUnavailable();
  }
  return config;
}

/** CODEX_CLI_PATH is also used for exec-server and CLI utilities. Only the
 * app-server protocol belongs to this router; other invocations keep their
 * original stdin, output, environment, exit status and shutdown signals. */
export async function runNativeCommand({ executable, args, env, input, output }: { executable: string; args: string[]; env: NodeJS.ProcessEnv; input: Readable; output: Writable }) {
  const inherited = input === process.stdin && output === process.stdout;
  const child = spawn(executable, args, { env: nativeEnvironment(env),
    stdio: inherited ? "inherit" : ["pipe", "pipe", "inherit"], windowsHide: true });
  const forward = (signal: NodeJS.Signals) => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  const term = () => forward("SIGTERM"), interrupt = () => forward("SIGINT");
  process.on("SIGTERM", term); process.on("SIGINT", interrupt);
  if (!inherited) {
    input.pipe(child.stdin!); child.stdout!.pipe(output, { end: false });
    child.stdin!.on("error", () => {}); // A utility can finish before input EOF.
  }
  try { return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
  }); } finally {
    process.off("SIGTERM", term); process.off("SIGINT", interrupt);
    if (!inherited) { input.unpipe(child.stdin!); input.pause(); child.stdout!.unpipe(output); }
  }
}

/** This is a CLI protocol frontend, not a Desktop launcher. It cannot quit,
 * launch, patch or replace a running ChatGPT instance. */
export async function runRoutedStdio({ args = process.argv.slice(2), env = process.env,
  input = process.stdin, output = process.stdout }: { args?: string[]; env?: NodeJS.ProcessEnv; input?: Readable; output?: Writable } = {}) {
  const executable = validateNativeCommand(env.CCODEX_NATIVE_CLI, env);
  if (!args.includes("app-server") || args.some(arg => ["--version", "-V", "--print-startup-config", "--startup-sign-out"].includes(arg))) {
    return runNativeCommand({ executable, args, env, input, output });
  }
  const warn = (message: string) => process.stderr.write(`MyCodex: ${message}\n`);
  const config = readRoutingConnection(env.CCODEX_GATEWAY_CONNECTION, { isolateSpine: true, onSpineUnavailable: () => warn("Invalid optional Spine configuration was disabled; native routing continues.") });
  let trace: ReturnType<typeof import("./spine/trace-peer.mjs").createTracePeer> | undefined;
  let spineArgs: string[] = [];
  if (config.spine) {
    try {
      const { spineNativeArguments } = await import("./spine/native-config.mjs");
      spineArgs = spineNativeArguments(config, env.CCODEX_GATEWAY_CONNECTION!);
    } catch {
      warn("Optional Spine native configuration is unavailable; native routing continues.");
      config.spine = { ...config.spine, mcp: false, shimDirectory: undefined };
    }
    if (config.spine && config.spine.eventTap !== false) {
      try { const { createTracePeer } = await import("./spine/trace-peer.mjs"); trace = createTracePeer(config, warn); }
      catch { warn("Optional native event tap is unavailable; native routing continues."); }
    }
  }
  let done!: () => void;
  const ended = new Promise<void>(resolve => { done = resolve; });
  let failure = false;
  const close = () => { input.pause(); done(); };
  const copilotProvider = config.engines?.find((engine): engine is EngineConfig & { adapter: "codex-copilot" } => engine.adapter === "codex-copilot");
  const providerArgs = copilotProvider ? copilotProviderArguments(copilotProvider) : [];
  const googleProvider = config.engines?.find((engine): engine is EngineConfig & { adapter: "codex-gemini" } => engine.adapter === "codex-gemini");
  if (googleProvider) providerArgs.push(...googleProviderArguments(googleProvider));
  const native = await startNativePeer({ executable, args: [...args, ...providerArgs, ...spineArgs],
    spineShimDirectory: config.spine?.shimDirectory,
    spineMcp: config.spine?.mcp,
    env: { ...env, ...(googleProvider ? { MYCODEX_GOOGLE_TOKEN: googleProviderToken(config.token) } : {}) } });
  const ownsThread = (id: string) => readThreadOwnership(path.join(config.home, "gateway", "threads"), id);
  let host: ReturnType<typeof import("./native-host-peer.mjs").createNativeHostPeer> | undefined;
  const router = new AppServerRouter({ native,
    connectProvider: async id => {
      const provider = id === copilotProviderId && copilotProvider ? copilotProvider :
        id === googleProviderId && googleProvider ? googleProvider : null;
      if (!provider) throw new Error("The selected native provider is not configured.");
      const selectedArgs = id === copilotProviderId ? copilotProviderArguments(copilotProvider!) : googleProviderArguments(googleProvider!);
      const selectedConfig = id === copilotProviderId ? copilotProviderConfig(copilotProvider!) : googleProviderConfig(googleProvider!);
      return startNativePeer({ executable,
        args: [...args, ...selectedArgs, ...spineArgs, "-c", `model_provider=${JSON.stringify(id)}`,
          "-c", `model_catalog_json=${JSON.stringify(selectedConfig.model_catalog_json)}`],
        spineShimDirectory: config.spine?.shimDirectory, spineMcp: config.spine?.mcp,
        env: { ...env, ...(googleProvider ? { MYCODEX_GOOGLE_TOKEN: googleProviderToken(config.token) } : {}) } });
    },
    onNativeEvent: trace ? event => trace.record(event) : undefined,
    copilotProvider,
    googleProvider,
    cursorSecret: config.token + ":" + config.generation,
    ownsThread,
    onNativeInitialized: () => {
      if (!config.spine) return;
      // Optional host imports and capability discovery must not delay the
      // native initialize response or the frontend's first ordinary request.
      void (async () => {
        const { createNativeHostPeer } = await import("./native-host-peer.mjs");
        if (router.closed) return;
        host = createNativeHostPeer(config, native, ownsThread, warn, { runExclusive: (id, operation) => router.withNativeThread(id, operation) });
        await host.start();
      })().catch(() => { if (!router.closed) warn("Optional native host channel is unavailable; native routing continues."); });
    },
    send: message => writeMessage(output, message),
    warn: message => process.stderr.write(`MyCodex: ${message}\n`),
    onNativeClose: () => { failure = true; close(); },
    connectGateway: async () => {
      const current = readRoutingConnection(env.CCODEX_GATEWAY_CONNECTION, { isolateSpine: true });
      if (current.generation !== config.generation || current.token !== config.token || current.home !== config.home) throw new Error("Gateway configuration changed; reconnect during the scheduled client restart.");
      let socket!: Socket;
      const peer = new RpcPeer(message => writeMessage(socket, message));
      socket = await connectGateway(current, message => peer.receive(message));
      socket.on("close", () => peer.close());
      peer.dispose = async () => { socket.destroy(); peer.close(); };
      return peer;
    },
  });
  const stopReading = readMessages(input, message => {
    router.receive(message).catch(() => { failure = true; close(); });
  }, () => { failure = true; close(); });
  input.once("end", close);
  input.once("error", close);
  const signal = () => close();
  process.once("SIGTERM", signal);
  process.once("SIGINT", signal);
  if (native.closed) { failure = true; close(); }
  try { await ended; }
  finally {
    stopReading(); input.off("end", close); input.off("error", close);
    process.off("SIGTERM", signal); process.off("SIGINT", signal);
    const hostClosed = host?.close();
    await router.close();
    await hostClosed;
    await trace?.close();
  }
  return failure ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runRoutedStdio().then(code => { process.exitCode = code; }, error => {
    console.error(`MyCodex routed frontend: ${error.message}`); process.exitCode = 1;
  });
}
