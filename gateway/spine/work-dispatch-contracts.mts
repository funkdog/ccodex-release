import type { HostThreadRef, HostDeliveryReceipt } from "./host-thread-contracts.mjs";

export type ReactionAction = "continue" | "implement" | "scout" | "integrate";
export interface ReactionRequest {
  workItemId: string; observationId: string; action: ReactionAction;
  briefRevision: number; policyRevision: number; message: string;
  subtaskId?: string;
}
/** Resolved by the owning work service, never accepted from event text or MCP
 * parameters. One complete policy must authorize the entire action. */
export interface DispatchAuthority {
  briefRevision: number; policyRevision: number; responsible: HostThreadRef;
  workspace: string; resourceVersion: string;
  instructions: string;
  enabled: boolean; paused: boolean; takeover: boolean;
  maxInputBytes: number; maxAttempts: number;
}
export type ResolveDispatchAuthority = (request: ReactionRequest, signal?: AbortSignal) => DispatchAuthority | undefined | Promise<DispatchAuthority | undefined>;
export type VerifyDispatchResources = (authority: DispatchAuthority, signal?: AbortSignal) => boolean | Promise<boolean>;
export type ReactionState = "queued" | "dispatching" | "accepted" | "settled" | "needs_attention" | "cancelled";
export interface ReactionRecord extends ReactionRequest {
  schemaVersion: 1; id: string; revision: number; state: ReactionState;
  createdAt: string; updatedAt: string; requestId: string;
  target: HostThreadRef | null; workspace: string | null; resourceVersion: string | null;
  briefText: string | null;
  attempts: number; receipt: HostDeliveryReceipt | null;
  outcome: { turnId: string; status: "completed" | "failed" | "interrupted"; observedAt: string } | null;
  reason: string | null;
}
