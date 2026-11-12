/** Spine owns its state. No dependency on StoredThread, Desktop or engines. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ReadLogParams { id: string; startLine: number; endLine: number; byteOffset?: number; maxBytes?: number }
export interface LogPointer { id: string; startLine: number; endLine: number; bytes: number; sha256: string }
export interface LogRead extends LogPointer {
  encoding: "utf8" | "base64"; content: string; complete: boolean;
  byteOffset: number; nextByteOffset: number | null;
}
export type Capability = "status:read" | "logs:read" | "radar:read" | "radar:write" | "daily:read" | "vault:write" | "trace:write" | "host:read" | "work:read" | "work:write";
export interface SpineContext { authenticated: boolean; initialized: boolean; capabilities: ReadonlySet<Capability>; signal?: AbortSignal }
export interface ModuleHealth { state: "ready" | "unavailable"; reason?: string }
export interface SpineStatus { schemaVersion: 1; startedAt: string; methods: string[]; capabilities: Capability[]; activeTasks: number; backgroundActivities: number; modules: Record<string, ModuleHealth> }
export interface CommandSpec { executable: string; args: string[]; cwd?: string; timeoutMs?: number; env?: Record<string, string> }
export interface RadarOptions { schemaFile: string; reportFile?: string; archiveDatabase?: string; loadCommand?: CommandSpec; refreshCommand?: CommandSpec; archive?: { executable: string; script: string; dataHome?: string } }
export interface KnowledgeOptions { vaultRoot?: string }
export interface DailyOptions { repositories?: string[]; timezone?: string; distillCommand?: CommandSpec }
export interface SpineRuntimeOptions { mcp?: boolean; shimDirectory?: string; eventTap?: boolean; radar?: RadarOptions; daily?: DailyOptions; knowledge?: KnowledgeOptions; ui?: { rightOffset?: number } }
export interface NativeTraceEvent { method: string; threadId: string; at: number; title?: string; intent?: string; cwd?: string; model?: string; provider?: string; turnId?: string; status?: string }
export interface TraceThread { threadId: string; engine: string; title: string; intent: string; cwd: string; model: string; updatedAt: number; lastTurnAt?: number; lastTurnId?: string; status: string; archived: boolean; deleted: boolean }
