import type { GatewayConnection } from "./contracts.mjs";
import type { HostBinding, HostThreadRef, HostDeliveryPort, HostThreadState, HostThreadResult, HostDeliveryRequest, HostDeliveryReceipt } from "./spine/host-thread-contracts.mjs";

// Result reads differ between installed native versions. They remain false
// until a real result read has succeeded on this exact live binding.
export const readOnlyHostCapabilities = Object.freeze({ readState: true, readResult: false, deliver: false, requestIdempotency: false, receiptLookup: false, safeDuringRun: false, openTarget: false });
import { parseHostRef } from "./spine/host-thread-contracts.mjs";
import type { SquadNativeRequest, SquadNativeThread, SquadNativeTurn } from "./squad-native-peer.mjs";
export { parseHostRef } from "./spine/host-thread-contracts.mjs";
interface PendingRequest { start(): void; cancel(reason: unknown): void }
interface BoundHost {
  binding: HostBinding;
  connection: GatewayConnection;
  active: number;
  queue: PendingRequest[];
  disconnected: AbortController;
}
const HOST_CONCURRENCY = 4, HOST_QUEUE_LIMIT = 64;
/** Route only to already connected native frontends. Delivery uses their
 * guarded turn port; it cannot start a runtime, create a chat or insert a draft. */
export class HostThreadBroker implements HostDeliveryPort {
  private bindings = new Map<string, BoundHost>();
  private readonly desktopPids: () => ReadonlySet<number>;
  constructor(desktopPids: () => ReadonlySet<number> = () => new Set()) { this.desktopPids = desktopPids; }
  register(params: Record<string, unknown>, connection: GatewayConnection) {
    if (connection.role !== "native-host" || !connection.initialized) throw new Error("Native host registration requires its own authenticated channel.");
    if (Object.keys(params).some(key => !["hostId", "accountId", "runtimeId", "accountVerified", "canDeliver", "canSquad", "canSwitch", "frontendPid"].includes(key)) || typeof params.accountVerified !== "boolean" || params.canDeliver !== undefined && typeof params.canDeliver !== "boolean" || params.canSquad !== undefined && typeof params.canSquad !== "boolean" || params.canSwitch !== undefined && typeof params.canSwitch !== "boolean" || params.frontendPid !== undefined && (!Number.isSafeInteger(params.frontendPid) || Number(params.frontendPid) < 1)) throw new Error("Invalid host registration.");
    const ref = parseHostRef({ hostId: params.hostId, accountId: params.accountId, runtimeId: params.runtimeId, threadId: "00000000-0000-0000-0000-000000000000" });
    if (this.bindings.has(ref.runtimeId) || [...this.bindings.values()].some(entry => entry.connection === connection) || this.bindings.size >= 16) throw new Error("Duplicate or excess native host binding.");
    const binding: HostBinding = { hostId: ref.hostId, accountId: ref.accountId, runtimeId: ref.runtimeId, accountVerified: params.accountVerified, capabilities: { ...readOnlyHostCapabilities } };
    if (params.canDeliver === true) { binding.capabilities.deliver = true; binding.capabilities.receiptLookup = true; }
    if (params.canSquad === true) binding.squad = true;
    if (params.canSwitch === true) binding.executionSwitch = true;
    if (params.frontendPid !== undefined) binding.frontendPid = Number(params.frontendPid);
    this.bindings.set(ref.runtimeId, { binding, connection, active: 0, queue: [], disconnected: new AbortController() });
    return { registered: true };
  }
  disconnect(connection: GatewayConnection) {
    for (const [key, entry] of this.bindings) {
      if (entry.connection !== connection) continue;
      this.bindings.delete(key);
      const reason = new Error("The bound native host disconnected.");
      entry.disconnected.abort(reason);
      for (const pending of entry.queue.splice(0)) pending.cancel(reason);
    }
  }
  ownsConnection(connection: GatewayConnection, value: unknown) {
    try { const ref = parseHostRef(value), entry = this.bindings.get(ref.runtimeId); return Boolean(entry && entry.connection === connection && entry.binding.hostId === ref.hostId && entry.binding.accountId === ref.accountId); }
    catch { return false; }
  }
  status() { return { bindings: [...this.bindings.values()].map(entry => structuredClone(entry.binding)) }; }
  async switchExecution(threadId: string, model: string, frontendPid: number) {
    const candidates = [...this.bindings.values()].map(entry => entry.binding).filter(binding => binding.executionSwitch && binding.frontendPid === frontendPid);
    if (!candidates.length) throw new Error("跨引擎连接尚未就绪，请在任务结束后重新打开 MyCodex。");
    if (candidates.length !== 1) throw new Error("当前窗口的原生连接不唯一，未切换到其他窗口。");
    const binding = candidates[0];
    return this.request({ hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId }, "mycodex/host/switch_execution", { model });
  }
  squad(ref: HostThreadRef, command: SquadNativeRequest, signal?: AbortSignal): Promise<unknown> {
    if (["read", "turn", "list", "models"].includes(command.operation)) ref = this.readRef(ref, true);
    if (!this.bindings.get(ref.runtimeId)?.binding.squad) return Promise.reject(new Error("The bound native Squad runtime is unavailable; reconnect or explicitly rebind it."));
    return this.request(ref, "mycodex/host/squad", { command }, signal);
  }
  /** Squad identity is host/account/thread. runtimeId is a transport hint;
   * resolve only through a fresh read of that exact identity. Receipts stay
   * pinned to the original runtime and never use this reconnect path. */
  async resolveSquad(ref: HostThreadRef, signal?: AbortSignal): Promise<SquadNativeThread> {
    return (await this.observeSquad(ref, { operation: "read" }, signal)).thread;
  }
  async resolveSquadTurn(ref: HostThreadRef, turnId: string, includeText: boolean, signal?: AbortSignal): Promise<SquadNativeTurn & { thread: SquadNativeThread }> {
    const result = await this.observeSquad(ref, { operation: "turn", turnId, includeText }, signal);
    if (typeof result.status !== "string") throw new Error("Invalid native turn status.");
    return { ...result, status: result.status };
  }
  private async observeSquad(ref: HostThreadRef, command: Extract<SquadNativeRequest, { operation: "read" | "turn" }>, signal?: AbortSignal) {
    parseHostRef(ref);
    const original = this.bindings.get(ref.runtimeId)?.binding;
    try {
      const current = this.readRef(ref, true);
      const observed = await this.squad(current, command, signal) as Omit<SquadNativeTurn, "status"> & { status?: string };
      // Peers from before combined observations only return turn metadata.
      const thread = observed.thread ?? (command.operation === "turn" ? await this.resolveSquad(current, signal) : undefined);
      if (!thread) throw new Error("Missing native thread observation.");
      const returned = parseHostRef(thread.hostRef);
      if (thread.id !== ref.threadId || Object.entries(current).some(([key, value]) => returned[key as keyof HostThreadRef] !== value)) throw new Error("Native thread identity mismatch.");
      return { ...observed, thread };
    } catch (cause) { if (original || signal?.aborted) throw cause; }
    throw new Error("The same native account and thread are unavailable; no other chat or account was selected.");
  }
  squadBinding(ref: HostThreadRef): HostBinding {
    const current = this.readRef(ref, true), binding = this.bindings.get(current.runtimeId)?.binding;
    if (!binding?.squad || binding.hostId !== ref.hostId || binding.accountId !== ref.accountId) throw new Error("No matching native Squad host is connected.");
    return structuredClone(binding);
  }
  async deliver(request: HostDeliveryRequest) {
    const binding = this.bindings.get(request.ref.runtimeId)?.binding;
    if (!binding?.capabilities.deliver) throw new Error("Bound native delivery is unavailable.");
    if (!/^[a-f0-9]{64}$/.test(request.requestId) || typeof request.message !== "string" || !request.message.length || Buffer.byteLength(request.message) > 16384 || typeof request.workspace !== "string" || request.workspace.length > 4096) throw new Error("Invalid native delivery.");
    const value = await this.request<HostDeliveryReceipt>(request.ref, "mycodex/host/deliver", { requestId: request.requestId, message: request.message, workspace: request.workspace });
    return this.checkReceipt(request.ref, request.requestId, value);
  }
  async receipt(ref: HostThreadRef, requestId: string) {
    if (!/^[a-f0-9]{64}$/.test(requestId)) throw new Error("Invalid delivery request identity.");
    const value = await this.request<HostDeliveryReceipt>(ref, "mycodex/host/receipt", { requestId });
    return this.checkReceipt(ref, requestId, value);
  }
  private checkReceipt(ref: HostThreadRef, requestId: string, value: HostDeliveryReceipt) {
    this.checkResponse(ref, value);
    if (value.requestId !== requestId || !["pending", "accepted", "not_sent", "unknown", "not_found"].includes(value.state) ||
      value.state === "accepted" && (typeof value.turnId !== "string" || !value.turnId.length || value.turnId.length > 128) ||
      value.turnId !== undefined && typeof value.turnId !== "string" || value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 128)) throw new Error("Invalid native delivery receipt.");
    return value;
  }
  private async request<T>(ref: HostThreadRef, method: string, extra: object, signal?: AbortSignal): Promise<T> {
    parseHostRef(ref);
    const entry = this.bindings.get(ref.runtimeId);
    if (!entry || entry.binding.hostId !== ref.hostId || entry.binding.accountId !== ref.accountId) throw new Error("The bound native host is unavailable; no other chat or runtime was selected.");
    signal?.throwIfAborted();
    if (entry.active < HOST_CONCURRENCY) entry.active++;
    else {
      if (entry.queue.length >= HOST_QUEUE_LIMIT) throw new Error("Native host request queue is full.");
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const index = entry.queue.indexOf(pending);
          if (index !== -1) entry.queue.splice(index, 1);
          pending.cancel(signal!.reason);
        };
        const removeListener = () => signal?.removeEventListener("abort", onAbort);
        const pending: PendingRequest = {
          start: () => { removeListener(); resolve(); },
          cancel: reason => { removeListener(); reject(reason); },
        };
        entry.queue.push(pending);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    try {
      const timeout = AbortSignal.timeout(method === "mycodex/host/switch_execution" ? 60000 : 8000);
      const combined = AbortSignal.any([entry.disconnected.signal, timeout, ...(signal ? [signal] : [])]);
      combined.throwIfAborted();
      return await entry.connection.request(method, { ref, ...extra }, combined) as unknown as T;
    } finally {
      const next = entry.queue.shift();
      if (next) next.start(); else entry.active--;
    }
  }
  private readRef(ref: HostThreadRef, squad = false): HostThreadRef {
    parseHostRef(ref);
    if (this.bindings.has(ref.runtimeId)) return ref;
    const matches = [...this.bindings.values()].filter(({ binding }) => binding.hostId === ref.hostId && binding.accountId === ref.accountId && (!squad || binding.squad));
    const desktopPids = this.desktopPids();
    const preferred = matches.filter(({ binding }) => binding.frontendPid !== undefined && desktopPids.has(binding.frontendPid));
    const candidates = preferred.length ? preferred : matches;
    if (candidates.length !== 1) throw new Error("Native host reconnect is unavailable or ambiguous.");
    return { ...ref, runtimeId: candidates[0].binding.runtimeId };
  }
  async read(ref: HostThreadRef, signal?: AbortSignal) {
    ref = this.readRef(ref);
    const value = await this.request<HostThreadState>(ref, "mycodex/host/read", {}, signal);
    this.checkResponse(ref, value);
    if (typeof value.title !== "string" || typeof value.cwd !== "string" || typeof value.status !== "string" || !(value.archived === null || typeof value.archived === "boolean")) throw new Error("Invalid native host state.");
    return value;
  }
  async result(ref: HostThreadRef, turnId: string, offset = 0, signal?: AbortSignal) {
    ref = this.readRef(ref);
    if (typeof turnId !== "string" || !turnId.length || turnId.length > 128 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid host result range.");
    const value = await this.request<HostThreadResult>(ref, "mycodex/host/result", { turnId, offset }, signal);
    this.checkResponse(ref, value);
    if (value.turnId !== turnId || value.offset !== offset || typeof value.status !== "string" || typeof value.text !== "string" || value.text.length > 8192 || !(value.nextOffset === null || Number.isSafeInteger(value.nextOffset) && value.nextOffset > offset)) throw new Error("Invalid native host result.");
    const binding = this.bindings.get(ref.runtimeId);
    if (binding) binding.binding.capabilities.readResult = true;
    return value;
  }
  private checkResponse(ref: HostThreadRef, value: { ref: HostThreadRef; observedAt: string }) {
    if (!value || !value.ref) throw new Error("Invalid native host observation.");
    const returned = parseHostRef(value.ref);
    if ((["hostId", "accountId", "runtimeId", "threadId"] as const).some(key => returned[key] !== ref[key]) || typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))) throw new Error("Native host returned a different target or invalid observation.");
  }
}
