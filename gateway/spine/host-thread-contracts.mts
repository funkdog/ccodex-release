/** Stable native identity plus an explicit live transport binding. A runtime
 * replacement requires rebinding; never fall back to the currently open chat. */
export interface HostThreadRef {
  hostId: string; accountId: string; runtimeId: string; threadId: string;
}
export function parseHostRef(value: unknown): HostThreadRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("An explicit host thread reference is required.");
  const p = value as Record<string, unknown>, uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if (Object.keys(p).some(key => !["hostId", "accountId", "runtimeId", "threadId"].includes(key)) ||
    typeof p.hostId !== "string" || !/^local:[a-f0-9]{32}$/.test(p.hostId) || typeof p.accountId !== "string" || !/^[a-f0-9]{64}$/.test(p.accountId) ||
    typeof p.runtimeId !== "string" || !uuid.test(p.runtimeId) || typeof p.threadId !== "string" || !uuid.test(p.threadId)) throw new Error("Invalid host thread reference.");
  return p as unknown as HostThreadRef;
}
export interface HostThreadCapabilities {
  readState: boolean; readResult: boolean; deliver: boolean;
  requestIdempotency: boolean; receiptLookup: boolean; safeDuringRun: boolean; openTarget: boolean;
}
export interface HostBinding {
  hostId: string; accountId: string; accountVerified: boolean; runtimeId: string;
  capabilities: HostThreadCapabilities;
}
export interface HostDeliveryRequest {
  ref: HostThreadRef; requestId: string; message: string; workspace: string;
}
export interface HostDeliveryReceipt {
  ref: HostThreadRef; requestId: string; observedAt: string;
  state: "pending" | "accepted" | "not_sent" | "unknown" | "not_found";
  turnId?: string; reason?: string;
}
export interface HostThreadState {
  ref: HostThreadRef; observedAt: string; title: string; cwd: string;
  status: string; archived: boolean | null;
}
export interface HostThreadResult {
  ref: HostThreadRef; observedAt: string; turnId: string; status: string;
  text: string; offset: number; nextOffset: number | null;
}
/** Read capabilities and delivery authority are separate contracts. A host
 * capability never grants work scope, permissions or an external write. */
export interface HostThreadPort {
  status(): { bindings: HostBinding[] };
  read(ref: HostThreadRef, signal?: AbortSignal): Promise<HostThreadState>;
  result(ref: HostThreadRef, turnId: string, offset?: number, signal?: AbortSignal): Promise<HostThreadResult>;
}
/** Runtime-scoped receipt lookup does not imply native/durable idempotency. */
export interface HostDeliveryPort extends HostThreadPort {
  deliver(request: HostDeliveryRequest): Promise<HostDeliveryReceipt>;
  receipt(ref: HostThreadRef, requestId: string): Promise<HostDeliveryReceipt>;
}
