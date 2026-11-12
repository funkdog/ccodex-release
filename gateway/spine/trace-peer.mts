import type { Socket } from "node:net";
import type { ConnectionConfig } from "../contracts.mjs";
import type { NativeTraceEvent } from "./contracts.mjs";
import { RpcPeer } from "../rpc-peer.mjs";
import { connectGateway, writeMessage } from "../ipc.mjs";
import { nativeTraceToken } from "./trace.mjs";

/** Best effort, bounded/coalescing tap. No writes outside the gateway, no
 * backpressure on native protocol, no automatic replay of model/tool work. */
export function createTracePeer(config: ConnectionConfig, warn: (message: string) => void = () => {}) {
  const queue = new Map<string, NativeTraceEvent>(); let running: Promise<void> | null = null, stopped = false, socket: Socket | undefined, peer: RpcPeer | undefined;
  const flush = async () => {
    try {
      if (!peer || peer.closed) {
        peer = new RpcPeer(message => writeMessage(socket!, message));
        socket = await connectGateway({ ...config, token: nativeTraceToken(config.token, config.generation) }, message => peer!.receive(message));
        socket.once("close", () => peer?.close()); await peer.request("initialize", { clientInfo: { name: "mycodex_native_trace", version: "1" } }, { timeoutMs: 5000 });
      }
      while (queue.size && !stopped) {
        const [key, value] = queue.entries().next().value!; queue.delete(key);
        await peer.request("diy/trace/record", value, { timeoutMs: 5000 });
      }
    } catch { warn("Native trace is unavailable; native conversation continues unchanged."); queue.clear(); socket?.destroy(); peer?.close(); }
  };
  const kick = () => { if (!running && !stopped) { running = flush().finally(() => { running = null; if (queue.size && !stopped) kick(); }); } };
  return { record(event: NativeTraceEvent) { if (stopped) return; const key = `${event.threadId}:${event.method}:${event.turnId ?? ""}`; if (queue.size >= 256 && !queue.has(key)) { warn("Native trace buffer is full; lifecycle sample omitted."); return; } queue.set(key, event); kick(); },
    async close() { stopped = true; queue.clear(); socket?.destroy(); peer?.close(); await running; socket?.destroy(); peer?.close(); } };
}
