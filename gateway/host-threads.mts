import type { GatewayConnection } from "./contracts.mjs";
import type { HostBinding, HostThreadRef, HostDeliveryPort, HostThreadState, HostThreadResult, HostDeliveryRequest, HostDeliveryReceipt } from "./spine/host-thread-contracts.mjs";

// Result reads differ between installed native versions. They remain false
// until a real result read has succeeded on this exact live binding.
export const readOnlyHostCapabilities = Object.freeze({ readState: true, readResult: false, deliver: false, requestIdempotency: false, receiptLookup: false, safeDuringRun: false, openTarget: false });
import { parseHostRef } from "./spine/host-thread-contracts.mjs";
export { parseHostRef } from "./spine/host-thread-contracts.mjs";
/** Route only to already connected native frontends. Delivery uses their
 * guarded turn port; it cannot start a runtime, create a chat or insert a draft. */
export class HostThreadBroker implements HostDeliveryPort {
  private bindings = new Map<string, { binding: HostBinding; connection: GatewayConnection; active: number }>();
  register(params: Record<string, unknown>, connection: GatewayConnection) {
    if (connection.role !== "native-host" || !connection.initialized) throw new Error("Native host registration requires its own authenticated channel.");
    if (Object.keys(params).some(key => !["hostId", "accountId", "runtimeId", "accountVerified", "canDeliver"].includes(key)) || typeof params.accountVerified !== "boolean" || params.canDeliver !== undefined && typeof params.canDeliver !== "boolean") throw new Error("Invalid host registration.");
    const ref = parseHostRef({ hostId: params.hostId, accountId: params.accountId, runtimeId: params.runtimeId, threadId: "00000000-0000-0000-0000-000000000000" });
    if (this.bindings.has(ref.runtimeId) || [...this.bindings.values()].some(entry => entry.connection === connection) || this.bindings.size >= 16) throw new Error("Duplicate or excess native host binding.");
    const binding: HostBinding = { hostId: ref.hostId, accountId: ref.accountId, runtimeId: ref.runtimeId, accountVerified: params.accountVerified, capabilities: { ...readOnlyHostCapabilities } };
    if (params.canDeliver === true) { binding.capabilities.deliver = true; binding.capabilities.receiptLookup = true; }
    this.bindings.set(ref.runtimeId, { binding, connection, active: 0 });
    return { registered: true };
  }
  disconnect(connection: GatewayConnection) {
    for (const [key, entry] of this.bindings) if (entry.connection === connection) this.bindings.delete(key);
  }
  ownsConnection(connection: GatewayConnection, value: unknown) {
    try { const ref = parseHostRef(value), entry = this.bindings.get(ref.runtimeId); return Boolean(entry && entry.connection === connection && entry.binding.hostId === ref.hostId && entry.binding.accountId === ref.accountId); }
    catch { return false; }
  }
  status() { return { bindings: [...this.bindings.values()].map(entry => structuredClone(entry.binding)) }; }
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
    if (entry.active >= 8) throw new Error("Native host read budget exhausted.");
    const timeout = AbortSignal.timeout(8000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    entry.active++;
    try { return await entry.connection.request(method, { ref, ...extra }, combined) as unknown as T; }
    finally { entry.active--; }
  }
  async read(ref: HostThreadRef, signal?: AbortSignal) {
    const value = await this.request<HostThreadState>(ref, "mycodex/host/read", {}, signal);
    this.checkResponse(ref, value);
    if (typeof value.title !== "string" || typeof value.cwd !== "string" || typeof value.status !== "string" || !(value.archived === null || typeof value.archived === "boolean")) throw new Error("Invalid native host state.");
    return value;
  }
  async result(ref: HostThreadRef, turnId: string, offset = 0, signal?: AbortSignal) {
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
