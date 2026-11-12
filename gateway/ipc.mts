import "../tools/typescript-runtime.mjs";
import type { Readable, Writable } from "node:stream";
import type { RpcMessage, RpcId, AppParams, AppPayload, Answers, GatewayParams, GatewayConnection, ConnectionConfig } from "./contracts.mjs";
import net from "node:net";
import { randomUUID } from "node:crypto";

const maxFrame = 8 * 1024 * 1024;
/** Line framing shared by stdio and private IPC. No process-global request IDs. */
export function readMessages<P = AppParams, R = AppPayload>(stream: Readable, receive: (message: RpcMessage<P, R> & { hello?: number; token?: string; generation?: string }) => void, fail: (error: unknown) => void, { maxFrameBytes = maxFrame }: { maxFrameBytes?: number } = {}) {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 16 * 1024 * 1024) throw new Error("Invalid RPC frame budget.");
  let buffer = Buffer.alloc(0);
  const data = (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    for (;;) {
      const end = buffer.indexOf(10);
      if (end < 0) break;
      if (end > maxFrameBytes) { fail(new Error("RPC frame exceeds limit.")); return; }
      const line = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      if (!line.length) continue;
      try { receive(JSON.parse(line.toString("utf8"))); }
      catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); fail(error); return; }
    }
    if (buffer.length > maxFrameBytes) fail(new Error("RPC frame exceeds limit."));
  };
  stream.on("data", data);
  return () => stream.off("data", data);
}

export function writeMessage(stream: Writable, value: unknown, callback?: () => void) {
  const bytes = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(bytes) > maxFrame) throw new Error("RPC frame exceeds limit.");
  if (stream.writableLength > maxFrame * 2) throw new Error("RPC consumer is too slow.");
  stream.write(bytes, callback);
}

export function attachConnection(socket: net.Socket, { token, generation, handle, onClose, afterReply, traceToken, hostToken }: { token: string; generation: string; traceToken?: string; hostToken?: string; handle: (method: string, params: GatewayParams, connection: GatewayConnection) => Promise<unknown>; onClose: (connection: GatewayConnection) => void; afterReply?: (method: string, result: unknown) => void }) {
  let authenticated = false;
  let initialized = false;
  let closed = false;
  let role: "default" | "native-trace" | "native-host" = "default";
  const pending = new Map<RpcId, (error?: unknown, result?: Answers) => void>();
  const incoming = new Set();
  const send = (message: unknown) => { if (!closed) writeMessage(socket, message); };
  const connection: GatewayConnection = {
    get role() { return role; },
    get inFlight() { return incoming.size + pending.size; },
    send, get initialized() { return initialized; },
    request: (method, params, signal) => new Promise<Answers>((resolve, reject) => {
      if (closed || signal?.aborted) { reject(new Error(role === "native-host" ? "Native host connection is unavailable; reconcile previous delivery attempts." : "Desktop approval connection is unavailable.")); return; }
      const id = `gateway:${randomUUID()}`;
      const cleanup = () => { pending.delete(id); signal?.removeEventListener("abort", abort); clearTimeout(timer); };
      const finish = (error?: unknown, result?: Answers) => { cleanup(); error ? reject(error) : resolve(result!); };
      const abort = () => finish(new Error(role === "native-host" ? "Native host request interrupted; query delivery receipt before retrying." : "CLI request cancelled."));
      const timer = setTimeout(() => finish(new Error(role === "native-host" ? "Native host request timed out; query delivery receipt before retrying." : "Desktop approval timed out; no permission granted.")), 10 * 60 * 1000);
      timer.unref();
      pending.set(id, finish);
      signal?.addEventListener("abort", abort, { once: true });
      try { send({ id, method, params }); } catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); finish(error); }
    }),
  };
  const helloTimer = setTimeout(() => socket.destroy(), 5000);
  helloTimer.unref();
  readMessages(socket, message => {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid RPC frame.");
    if (!authenticated) {
      if (message.hello !== 1 || !(message.token === token || traceToken && message.token === traceToken || hostToken && message.token === hostToken) || message.generation !== generation) { socket.destroy(); return; }
      if (message.token === traceToken) role = "native-trace";
      if (message.token === hostToken) role = "native-host";
      authenticated = true;
      clearTimeout(helloTimer);
      send({ hello: 1, generation });
      return;
    }
    if (!Object.hasOwn(message, "method")) {
      pending.get(message.id!)?.(message.error ? new Error(role === "native-host" ? "Native host request was rejected; reconcile any delivery before retrying." : "Desktop request was rejected.") : null, message.result as unknown as Answers);
      return;
    }
    if (!Object.hasOwn(message, "id")) return; // initialized and other notifications
    const id = message.id!;
    if (!(typeof id === "string" || Number.isSafeInteger(id)) || incoming.has(id)) throw new Error("Invalid or duplicate in-flight RPC ID.");
    incoming.add(id);
    Promise.resolve().then(async () => {
      if (message.method === "initialize") {
        if (initialized) throw new Error("Connection is already initialized.");
        initialized = true;
      } else if (!initialized) throw new Error("Initialize this connection first.");
      if (message.params != null && (typeof message.params !== "object" || Array.isArray(message.params))) throw new Error("Invalid RPC params.");
      return handle(message.method!, (message.params || {}) as GatewayParams, connection);
    }).then(result => { if (!closed) writeMessage(socket, { id, result }, () => afterReply?.(message.method!, result)); }, error => send({ id,
      error: { code: Number.isInteger(error.code) ? error.code : -32000, message: error.message } }))
      .catch(() => socket.destroy()).finally(() => incoming.delete(id));
  }, () => socket.destroy());
  socket.on("error", () => {});
  socket.once("close", () => {
    closed = true;
    clearTimeout(helloTimer);
    for (const finish of [...pending.values()]) finish(new Error(role === "native-host" ? "Native host disconnected; query delivery receipt before retrying." : "Desktop disconnected; permission was not granted."));
    onClose(connection);
  });
  return connection;
}

export async function connectGateway({ endpoint, token, generation }: Pick<ConnectionConfig, "endpoint" | "token" | "generation">, receive: (message: RpcMessage) => void = () => {}) {
  const socket = net.createConnection(endpoint);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Gateway handshake timed out.")); }, 5000);
    const failed = (error: unknown) => { clearTimeout(timer); reject(error); };
    socket.once("error", failed);
    socket.once("close", () => failed(new Error("Gateway closed during handshake.")));
    let ready = false;
    readMessages(socket, message => {
      if (!ready) {
        if (message.hello !== 1 || message.generation !== generation) { socket.destroy(); failed(new Error("Unexpected gateway identity.")); return; }
        ready = true;
        clearTimeout(timer);
        socket.off("error", failed);
        socket.on("error", () => {});
        resolve();
      } else receive(message);
    }, error => { socket.destroy(); failed(error); });
    socket.once("connect", () => writeMessage(socket, { hello: 1, token, generation }));
  });
  return socket;
}
