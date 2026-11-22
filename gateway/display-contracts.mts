/** Stable display facts. These are not app-server wire items. */
export type DisplayStatus = "inProgress" | "completed" | "failed" | "declined";
export type ActionHint = { type: "read"; path: string; name: string }
  | { type: "search"; query: string | null; path: string | null }
  | { type: "listFiles"; path: string | null } | { type: "unknown" };
export interface FileChange { path: string; kind: "add" | "update" | "delete"; movePath?: string | null; diff: string }
export interface PlanStep { step: string; status: "pending" | "inProgress" | "completed" }
export type WebAction = { type: "search"; query?: string | null; queries?: string[] | null }
  | { type: "openPage"; url?: string | null } | { type: "findInPage"; url?: string | null; pattern?: string | null } | { type: "other" };
export interface DisplaySource { tool: string; arguments: unknown }
export type StoredDisplayRecord = (
  | { id: string; type: "reasoningRecord"; summary: string[]; status: DisplayStatus }
  | { id: string; type: "commandRecord"; command: string; cwd: string; actionHint?: ActionHint;
      output: string | null; exitCode: number | null; durationMs: number | null; status: DisplayStatus }
  | { id: string; type: "fileChangeRecord"; changes: FileChange[]; status: DisplayStatus }
  | { id: string; type: "mcpCallRecord"; server: string; tool: string; arguments: unknown;
      result: { content: unknown[]; structuredContent?: unknown } | null; error: { message: string } | null;
      durationMs: number | null; status: "inProgress" | "completed" | "failed" }
  | { id: string; type: "webSearchRecord"; query: string; action: WebAction | null }
  | { id: string; type: "imageViewRecord"; path: string }
  | { id: string; type: "planRecord"; explanation: string | null; steps: PlanStep[] }) & { source?: DisplaySource };
export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export interface DisplaySink {
  thinkingDelta(id: string, delta: string): void;
  thinkingDone(id: string): void;
  commandStart(input: { id: string; command: string; cwd: string; actionHint?: ActionHint; source?: DisplaySource }): void;
  commandOutputDelta(id: string, delta: string): void;
  commandEnd(input: { id: string; status: Exclude<DisplayStatus, "inProgress">; output?: string | null; exitCode?: number | null; durationMs?: number | null }): void;
  fileChangeStart(input: { id: string; changes: FileChange[]; source?: DisplaySource }): void;
  fileChangeEnd(input: { id: string; status: Exclude<DisplayStatus, "inProgress">; changes?: FileChange[] }): void;
  planUpdate(input: { explanation?: string | null; steps: PlanStep[] }): void;
  mcpStart(input: { id: string; server: string; tool: string; arguments: unknown }): void;
  mcpEnd(input: { id: string; status: "completed" | "failed"; result?: unknown; errorMessage?: string | null; durationMs?: number | null }): void;
  webSearch(input: { id: string; query: string; action?: WebAction }): void;
  imageView(input: { id: string; path: string }): void;
  requestCommandApproval(input: { itemId: string; command: string; cwd: string; reason?: string | null }): Promise<ApprovalDecision>;
  requestFileApproval(input: { itemId: string; reason?: string | null }): Promise<ApprovalDecision>;
}
