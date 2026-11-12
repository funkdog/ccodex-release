import type { Readable } from "node:stream";
import type { Socket } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readRoutingConnection } from "../routed-stdio.mjs";
import { connectGateway, writeMessage } from "../ipc.mjs";
import { RpcFailure, RpcPeer } from "../rpc-peer.mjs";
import { boundedJson, DIY_REQUEST_BYTES, DIY_RESPONSE_BYTES } from "./registry.mjs";
import { sharedWorkCommands } from "./mcp-server.mjs";
import { workId } from "./work-context.mjs";

const emptySchema = { type: "object", additionalProperties: false, properties: {} };
const commands: Record<string, { method: string; description: string; inputSchema: unknown }> = {
  ...sharedWorkCommands(),
  goals: { method: "diy/goals/list", description: "Find existing goals, including goals with no work yet.", inputSchema: emptySchema },
  status: { method: "diy/spine/status", description: "Check the running generation before writing work.", inputSchema: emptySchema },
};
const requiredMethods = Object.values(commands).map(command => command.method);
type Outcome = "not_sent" | "rejected" | "unknown";
interface ConnectionDiagnostic { code: string; phase: "connect" | "initialize"; systemCode?: string }
class WorkCliFailure extends Error {
  readonly outcome: Outcome;
  readonly diagnostic?: ConnectionDiagnostic;
  constructor(message: string, outcome: Outcome, diagnostic?: ConnectionDiagnostic) { super(message); this.outcome = outcome; this.diagnostic = diagnostic; }
}

/** Preserve actionable error categories, never an exception's raw connection
 * path, token, endpoint or server-provided error text. */
function connectionFailure(cause: unknown, phase: ConnectionDiagnostic["phase"]) {
  const rawCode = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
  const systemCode = typeof rawCode === "string" && ["EPERM", "EACCES", "ENOENT", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EPIPE"].includes(rawCode) ? rawCode : undefined;
  let code = phase === "initialize" ? "GATEWAY_INITIALIZE_FAILED" : "GATEWAY_CONNECT_FAILED";
  let message = "The bound gateway connection failed; no work operation was sent.";
  if (systemCode === "EPERM" || systemCode === "EACCES") {
    code = "GATEWAY_ACCESS_DENIED";
    message = "Access to the bound gateway was denied. Review this task's local socket permissions; no work operation was sent.";
  } else if (systemCode === "ENOENT") {
    code = "GATEWAY_ENDPOINT_MISSING";
    message = "The bound gateway socket was not found; no work operation was sent.";
  } else if (systemCode === "ECONNREFUSED") {
    code = "GATEWAY_CONNECTION_REFUSED";
    message = "The bound gateway refused the connection; no work operation was sent.";
  } else if (phase === "connect" && cause instanceof Error) {
    if (cause.message === "Gateway handshake timed out.") code = "GATEWAY_HANDSHAKE_TIMEOUT";
    else if (["Gateway closed during handshake.", "Unexpected gateway identity."].includes(cause.message)) code = "GATEWAY_HANDSHAKE_FAILED";
  }
  return new WorkCliFailure(message, "not_sent", { code, phase, ...(systemCode ? { systemCode } : {}) });
}

async function parameters(input: Readable): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const value of input) {
    const chunk = Buffer.from(value); bytes += chunk.length;
    if (bytes > DIY_REQUEST_BYTES) throw new Error("Input exceeds the 32 KiB request limit.");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let value: unknown;
  try { value = text.trim() ? JSON.parse(text) : {}; } catch { throw new Error("Expected one JSON object on stdin."); }
  boundedJson(value, DIY_REQUEST_BYTES);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected one JSON object on stdin.");
  return value as Record<string, unknown>;
}

/** One connection, one operation, no retries, store access, model calls or
 * profile discovery. The explicit binding determines the one gateway writer. */
export async function runWorkCommand(connectionFile: string, command: string, input: Readable = process.stdin) {
  let sent = false, writing = false, socket: Socket | undefined, peer: RpcPeer | undefined;
  try {
    if (command === "describe") return { ok: true, operation: command, result: { commands, writesRequire: ["id", "expectedRevision"], input: "One JSON object on stdin; empty input means {}.", maxInputBytes: DIY_REQUEST_BYTES } };
    if (!Object.hasOwn(commands, command)) throw new Error("Unknown work command. Use describe for supported commands.");
    const spec = commands[command], params = await parameters(input);
    writing = command === "goal" || command === "record";
    if (writing) {
      workId(params.id, "id");
      if (!Number.isSafeInteger(params.expectedRevision) || Number(params.expectedRevision) < 0) throw new Error("Writes require expectedRevision: 0 to create, the current revision to update.");
    }
    if (["status", "goals"].includes(command) && Object.keys(params).length) throw new Error("This command takes no parameters.");
    let config;
    try { config = readRoutingConnection(connectionFile); if (!config.spine?.mcp) throw new Error(); }
    catch { throw new Error("Private gateway connection is unavailable, invalid, or not enabled for work access."); }
    try {
      peer = new RpcPeer(message => writeMessage(socket!, message));
      socket = await connectGateway(config, message => peer!.receive(message));
      socket.once("close", () => peer!.close());
    } catch (cause) { throw connectionFailure(cause, "connect"); }
    try { await peer.request("initialize", { clientInfo: { name: "mycodex_work_executor", version: "0.1.0" } }, { timeoutMs: 5000 }); }
    catch (cause) { throw connectionFailure(cause, "initialize"); }
    const health = await peer.request("diy/spine/status", {}, { timeoutMs: 5000 });
    const methods = Array.isArray(health.methods) ? health.methods : [];
    const missingMethods = requiredMethods.filter(method => !methods.includes(method));
    if (command === "status") return { ok: true, operation: command, result: { ready: !missingMethods.length, startedAt: health.startedAt, missingMethods } };
    if (!methods.includes(spec.method)) throw new Error("The running gateway has not loaded this work capability. Use status to inspect missing methods; existing sessions were preserved.");
    sent = true;
    const result = await peer.request(spec.method, params, { timeoutMs: 15000 });
    boundedJson(result, DIY_RESPONSE_BYTES);
    const recordValue = command === "goal" ? result.goal : command === "record" ? result.workItem : null;
    if (writing && (!recordValue || typeof recordValue !== "object" || Array.isArray(recordValue))) throw new Error("Gateway returned no write receipt; query the original ID before retrying.");
    const record = recordValue as Record<string, unknown> | null;
    return { ok: true, operation: command, result, ...(record ? { receipt: { id: record.id, revision: record.revision, ...(command === "record" ? { goalId: record.goalId } : {}) } } : {}) };
  } catch (cause) {
    if (cause instanceof WorkCliFailure) throw cause;
    const outcome: Outcome = sent && writing ? cause instanceof RpcFailure ? "rejected" : "unknown" : "not_sent";
    throw new WorkCliFailure(cause instanceof Error ? cause.message.slice(0, 2048) : "Work command failed.", outcome);
  } finally { socket?.destroy(); peer?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const finish = (value: unknown, code: number) => { process.stdout.write(JSON.stringify(value) + "\n", () => process.exit(code)); };
  if (process.argv.length !== 4) finish({ ok: false, outcome: "not_sent", error: "Usage: work-cli.mjs <private connection file> <describe|status|goals|list|context|goal|record>" }, 1);
  else runWorkCommand(process.argv[2], process.argv[3]).then(result => finish(result, 0), cause => finish({ ok: false, operation: process.argv[3], outcome: cause instanceof WorkCliFailure ? cause.outcome : "not_sent", ...(cause instanceof WorkCliFailure ? cause.diagnostic : {}), error: cause.message }, 1));
}
