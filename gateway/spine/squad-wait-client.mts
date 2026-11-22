import type { Socket } from "node:net";
import { RpcPeer } from "../rpc-peer.mjs";
import { connectGateway, writeMessage } from "../ipc.mjs";
import type { ConnectionConfig } from "../contracts.mjs";
export function squadWaitTimeout(params: unknown) {
  const timeout = Number((params as { timeoutMs?: unknown } | null)?.timeoutMs ?? 30000);
  return Math.min(130000, Math.max(15000, (Number.isFinite(timeout) ? timeout : 30000) + 10000));
}
/** Each suspended read owns a connection. Cancelling it closes only this
 * socket, allowing the gateway to abort its context without cancelling writes
 * or other MCP calls sharing the main connection. No RPC mutation is replayed. */
export async function requestSquadWait(config: Pick<ConnectionConfig, "endpoint" | "token" | "generation">, params: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let socket: Socket | undefined;
  const peer = new RpcPeer(message => writeMessage(socket!, message));
  const abort = () => { socket?.destroy(); peer.close(new Error("Squad wait cancelled.")); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    socket = await connectGateway(config, message => peer.receive(message)); socket.once("close", () => peer.close());
    signal?.throwIfAborted();
    await peer.request("initialize", { clientInfo: { name: "squad_wait", version: "1" } }, { timeoutMs: 5000 });
    return await peer.request("diy/squad/wait", params, { timeoutMs: squadWaitTimeout(params) });
  } finally { signal?.removeEventListener("abort", abort); socket?.destroy(); peer.close(); }
}
