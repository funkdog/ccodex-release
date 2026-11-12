import "../tools/typescript-runtime.mjs";
import type { ChildOptions, AcpParams, AcpResult } from "./contracts.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { RpcPeer } from "./rpc-peer.mjs";
import { readMessages, writeMessage } from "./ipc.mjs";

export function nativeEnvironment(inherited: NodeJS.ProcessEnv) {
  const env = { ...inherited };
  for (const name of Object.keys(env)) if (/^CCODEX_(?:GATEWAY_|NATIVE_|ROUTER_)/.test(name) ||
    ["CODEX_CLI_PATH", "CODEX_APP_SERVER_FORCE_CLI", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"].includes(name)) delete env[name];
  return env; // In particular CODEX_HOME, HOME and native account state stay intact.
}

export function validateNativeCommand(executable: string | undefined, inherited = process.env) {
  if (typeof executable !== "string" || !path.isAbsolute(executable) || !fs.statSync(executable).isFile()) throw new Error("An absolute original Codex CLI executable is required.");
  const actual = fs.realpathSync(executable);
  if (inherited.CODEX_CLI_PATH && fs.existsSync(inherited.CODEX_CLI_PATH) && actual === fs.realpathSync(inherited.CODEX_CLI_PATH)) throw new Error("Native CLI cannot point back to the gateway shim.");
  if (inherited.CCODEX_ROUTER_DEPTH) throw new Error("Recursive native gateway invocation refused.");
  return executable;
}

export async function startNativePeer({ executable, args = [], env = process.env, cwd = process.cwd(), stderr = "inherit", spineShimDirectory, spineMcp = false }: ChildOptions & { spineShimDirectory?: string; spineMcp?: boolean }) {
  validateNativeCommand(executable, env);
  let nativeEnv = nativeEnvironment(env), transform: typeof import("./spine/native-config.mjs").spineNativeRequest | undefined;
  if (spineShimDirectory || spineMcp) {
    try {
      const helpers = await import("./spine/native-config.mjs");
      nativeEnv = helpers.withSpinePath(nativeEnv, spineShimDirectory);
      if (spineMcp) transform = helpers.spineNativeRequest;
    } catch { process.stderr.write("MyCodex: Optional Spine native helpers unavailable; native routing continues.\n"); }
  }
  const child = spawn(executable, args, { cwd, env: { ...nativeEnv, CCODEX_ROUTER_DEPTH: "1" },
    stdio: ["pipe", "pipe", stderr], windowsHide: true });
  const peer = new RpcPeer(message => writeMessage(child.stdin, transform ? transform(message) : message));
  const disposeRead = readMessages(child.stdout, message => peer.receive(message), error => peer.close(error));
  child.stdin.on("error", error => peer.close(error));
  child.on("error", error => peer.close(error));
  const exited = new Promise<void>(resolve => child.once("exit", (code, signal) => {
    disposeRead(); peer.close(new Error(`Owned native app-server exited (${code ?? signal}).`)); resolve();
  }));
  await new Promise<void>((resolve, reject) => { child.once("spawn", () => resolve()); child.once("error", reject); });
  let disposed = false;
  peer.pid = child.pid;
  peer.dispose = async () => {
    if (disposed) return;
    disposed = true;
    peer.close();
    child.stdin.end();
    const terminate = setTimeout(() => child.kill("SIGTERM"), 1000);
    const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(terminate); clearTimeout(kill); }
  };
  return peer;
}
