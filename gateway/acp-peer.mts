import "../tools/typescript-runtime.mjs";
import type { ChildOptions, AcpParams, AcpResult } from "./contracts.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { RpcPeer } from "./rpc-peer.mjs";
import { readMessages, writeMessage } from "./ipc.mjs";

/** A private stdio child, shared by the two actual ACP adapters. */
export async function startAcpPeer({ executable, args = [], env, cwd, stderr = "ignore" }: ChildOptions): Promise<RpcPeer<AcpParams, AcpResult> & { dispose(): Promise<void> }> {
  if (!path.isAbsolute(executable || "") || !fs.statSync(executable).isFile()) throw new Error("An absolute installed ACP executable is required.");
  const script = /\.[cm]?js$/i.test(executable), grouped = process.platform !== "win32";
  const child = spawn(script ? process.execPath : executable, script ? [executable, ...args] : args,
    { cwd, env, stdio: ["pipe", "pipe", stderr], windowsHide: true, detached: grouped });
  const peer = new RpcPeer<AcpParams, AcpResult>(message => writeMessage(child.stdin, { jsonrpc: "2.0", ...message }));
  const stop = readMessages<AcpParams, AcpResult>(child.stdout, message => peer.receive(message), error => peer.close(error), { maxFrameBytes: 16 * 1024 * 1024 });
  child.stdin.on("error", error => peer.close(error)); child.on("error", error => peer.close(error));
  const exited = new Promise<void>(resolve => child.once("close", () => { stop(); peer.close(new Error("Owned ACP process exited.")); resolve(); }));
  const signal = (value: NodeJS.Signals) => {
    try { if (grouped && child.pid) process.kill(-child.pid, value); else child.kill(value); }
    catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  let disposing: Promise<void> | undefined;
  peer.pid = child.pid;
  peer.dispose = () => disposing ??= (async () => {
    peer.close(); child.stdin.end();
    const term = setTimeout(() => signal("SIGTERM"), 500);
    const kill = setTimeout(() => signal("SIGKILL"), 3000);
    try { await exited; signal("SIGTERM"); } finally { clearTimeout(term); clearTimeout(kill); }
  })();
  try { await new Promise<void>((resolve, reject) => { child.once("spawn", () => resolve()); child.once("error", reject); }); }
  catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); await peer.dispose(); throw error; }
  return peer as RpcPeer<AcpParams, AcpResult> & { dispose(): Promise<void> };
}
