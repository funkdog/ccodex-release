import "../tools/typescript-runtime.mjs";
import type { RpcError, RpcId, RpcMessage, AppParams, AppPayload } from "./contracts.mjs";
import { randomUUID } from "node:crypto";

export class RpcFailure extends Error {
  rpc: RpcError;
  constructor(error: RpcError) { super(error.message); this.rpc = error; }
}

/** One peer per physical connection. Preserve ordinary caller IDs and all
 * response fields; reserve generated IDs only for the router's own queries. */
export class RpcPeer<P = AppParams, R = AppPayload> {
  send: (message: RpcMessage<P, unknown>) => void;
  pending: Map<RpcId, { resolve: (message: RpcMessage<P, R>) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> | null }>;
  closed: boolean; pid?: number; dispose?: () => Promise<void>;
  onNotification: (message: RpcMessage<P, R>) => unknown;
  onRequest: (message: RpcMessage<P, R>) => unknown;
  onClose: (error: Error) => void;
  constructor(send: (message: RpcMessage<P, unknown>) => void) {
    this.send = send;
    this.pending = new Map();
    this.closed = false;
    this.onNotification = () => {};
    this.onRequest = () => {};
    this.onClose = () => {};
  }
  receive(message: RpcMessage<P, R>) {
    if (this.closed) return;
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid RPC message.");
    if (typeof message.method === "string") {
      if (Object.hasOwn(message, "id")) this.onRequest(message);
      else this.onNotification(message);
    } else if (Object.hasOwn(message, "id")) {
      const pending = this.pending.get(message.id!);
      if (!pending) return;
      this.pending.delete(message.id!);
      clearTimeout(pending.timer ?? undefined);
      pending.resolve(message);
    }
  }
  call(message: RpcMessage<P, R>, { timeoutMs = 0 } = {}): Promise<RpcMessage<P, R>> {
    return new Promise<RpcMessage<P, R>>((resolve, reject) => {
      if (this.closed) { reject(new Error("RPC backend is disconnected.")); return; }
      if (!(typeof message.id === "string" || typeof message.id === "number" && Number.isSafeInteger(message.id)) || this.pending.has(message.id!)) {
        reject(new Error("Invalid or duplicate RPC ID.")); return;
      }
      const entry: { resolve: typeof resolve; reject: typeof reject; timer: ReturnType<typeof setTimeout> | null } = { resolve, reject, timer: null };
      if (timeoutMs) entry.timer = setTimeout(() => {
        this.pending.delete(message.id!);
        reject(new Error("RPC discovery timed out; no task was retried."));
      }, timeoutMs);
      this.pending.set(message.id!, entry);
      try { this.send(message); }
      catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); clearTimeout(entry.timer ?? undefined); this.pending.delete(message.id!); reject(error); }
    });
  }
  async request<T = R>(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<T> {
    const response = await this.call({ id: `mycodex-query:${randomUUID()}`, method, params: params as P }, options);
    if (response.error) throw new RpcFailure(response.error);
    return response.result as T;
  }
  notify<T = R>(message: RpcMessage<P, T>) {
    if (this.closed) throw new Error("RPC backend is disconnected.");
    this.send(message);
  }
  close(error: unknown = new Error("RPC backend disconnected; pending work was not retried.")) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer ?? undefined); entry.reject(error); }
    this.pending.clear();
    this.onClose(error instanceof Error ? error : new Error(String(error)));
  }
}
