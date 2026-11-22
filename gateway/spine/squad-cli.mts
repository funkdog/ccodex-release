import type { Readable } from "node:stream";
import type { Socket } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requestSquadWait } from "./squad-wait-client.mjs";
import { squadCommands } from "./squad-commands.mjs";
import { readRoutingConnection } from "../routed-stdio.mjs";
import { RpcPeer } from "../rpc-peer.mjs";
import { connectGateway, writeMessage } from "../ipc.mjs";
import { boundedJson, DIY_REQUEST_BYTES, DIY_RESPONSE_BYTES } from "./registry.mjs";

/** All CLI engines can use the same explicitly bound local command. No shell
 * execution, native fallback, inferred profile, or operation replay lives here. */
export async function runSquadCommand(file: string, command: string, input: Readable = process.stdin, signal?: AbortSignal) {
  if (command === "describe") return { commands: squadCommands, input: "One JSON object on stdin.", mutations: "Explicit actions only. Reconcile the same requestId after uncertainty." };
  if (!Object.hasOwn(squadCommands, command)) throw new Error("Unknown Squad command; use describe.");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of input) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > DIY_REQUEST_BYTES) throw new Error("Squad input exceeds 32 KiB."); chunks.push(bytes); }
  const params = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  boundedJson(params, DIY_REQUEST_BYTES);
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Expected a JSON object.");
  for (const required of squadCommands[command].inputSchema.required) if (params[required] === undefined) throw new Error(`Missing Squad ${required}.`);
  let config;
  try { config = readRoutingConnection(file); } catch { throw new Error("The bound private Squad connection is unavailable or invalid."); }
  if (command === "wait") return requestSquadWait(config, params, signal);
  let socket: Socket | undefined; const peer = new RpcPeer(message => writeMessage(socket!, message));
  try {
    socket = await connectGateway(config, message => peer.receive(message)); socket.once("close", () => peer.close());
    await peer.request("initialize", { clientInfo: { name: "squad_cli", version: "1" } }, { timeoutMs: 5000 });
    const result = await peer.request(squadCommands[command].method, params, { timeoutMs: 30000 });
    boundedJson(result, DIY_RESPONSE_BYTES); return result;
  } finally { socket?.destroy(); peer.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runSquadCommand(process.argv[2], process.argv[3]).then(result => process.stdout.write(JSON.stringify({ ok: true, result }) + "\n"),
    cause => { process.stderr.write("Squad command failed; no automatic retry. Reconcile the original requestId before another mutation.\n");
      process.stdout.write(JSON.stringify({ ok: false, error: cause instanceof Error ? cause.message : "Squad command failed." }) + "\n"); process.exitCode = 1; });
}
