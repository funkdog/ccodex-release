import fs from "node:fs";
import path from "node:path";
import type { NativeTraceEvent, TraceThread } from "./contracts.mjs";
import { privateDirectory } from "./storage.mjs";
import { readJson, writeJson, redact } from "./io.mjs";

export { nativeTraceToken } from "../spine-tokens.mjs";
const methods = ["thread/start", "thread/started", "thread/resume", "thread/fork", "thread/name/set", "thread/name/updated", "thread/archive", "thread/unarchive", "thread/delete", "thread/deleted", "turn/start", "turn/started", "turn/completed"];
const id = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
/** A bounded lifecycle projection, never the original message or token deltas. */
export function nativeTraceSummary(method: string, params: unknown, result?: unknown, at = Date.now()): NativeTraceEvent | null {
  if (!methods.includes(method) || !params || typeof params !== "object") return null;
  const p = params as Record<string, unknown>, r = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const t = (r.thread ?? p.thread ?? {}) as Record<string, unknown>, turn = (r.turn ?? p.turn ?? {}) as Record<string, unknown>;
  const threadId = t.id ?? p.threadId;
  if (typeof threadId !== "string" || !id.test(threadId)) return null;
  const text = (value: unknown, length: number) => typeof value === "string" ? redact(value).slice(0, length) : undefined;
  const first = Array.isArray(p.input) ? p.input.find((value: unknown) => value && typeof value === "object" && (value as Record<string, unknown>).type === "text") as Record<string, unknown> | undefined : undefined;
  return { method, threadId, at, title: text(t.name ?? p.name ?? t.preview, 300), intent: text(first?.text, 1000), cwd: text(r.cwd ?? t.cwd ?? p.cwd, 4096), model: text(r.model ?? t.model ?? p.model, 256), provider: text(t.modelProvider ?? r.modelProvider, 128), turnId: text(turn.id, 128), status: text(turn.status, 64) };
}
export class TraceStore {
  directory: string;
  constructor(home: string) { this.directory = privateDirectory(path.join(home, "gateway/spine/trace")); }
  record(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid trace event.");
    const p = value as Record<string, unknown>;
    if (Object.keys(p).some(key => !["method", "threadId", "at", "title", "intent", "cwd", "model", "provider", "turnId", "status"].includes(key)) || typeof p.threadId !== "string" || !id.test(p.threadId) || typeof p.method !== "string" || !methods.includes(p.method) || !Number.isSafeInteger(p.at) || (p.at as number) < 0) throw new Error("Invalid trace identity/lifecycle.");
    for (const key of ["title", "intent", "cwd", "model", "provider", "turnId", "status"]) if (p[key] !== undefined && (typeof p[key] !== "string" || (p[key] as string).length > (key === "cwd" ? 4096 : key === "intent" ? 1000 : 300))) throw new Error("Trace field exceeds limit.");
    const event = p as unknown as NativeTraceEvent, file = path.join(this.directory, `${event.threadId}.json`);
    const previous = fs.existsSync(file) ? readJson(file, 16384) as TraceThread : undefined;
    if (previous && previous.updatedAt > event.at) return { recorded: false, reason: "older-event" };
    const next: TraceThread = previous ?? { threadId: event.threadId, engine: "codex", title: "", intent: "", cwd: "", model: "", updatedAt: event.at, status: "unknown", archived: false, deleted: false };
    for (const key of ["title", "cwd", "model"] as const) if (event[key]) next[key] = redact(event[key]!);
    if (event.intent && !next.intent) next.intent = redact(event.intent);
    if (event.provider) next.engine = event.provider;
    if (event.method.startsWith("turn/")) { next.lastTurnAt = event.at; next.lastTurnId = event.turnId ?? next.lastTurnId; next.status = event.status ?? (event.method === "turn/completed" ? "completed" : "inProgress"); }
    if (event.method === "thread/archive") next.archived = true;
    if (event.method === "thread/unarchive") next.archived = false;
    if (["thread/delete", "thread/deleted"].includes(event.method)) next.deleted = true;
    next.updatedAt = event.at; writeJson(file, next); return { recorded: true };
  }
  list(): TraceThread[] { return fs.readdirSync(this.directory).filter(name => /^[a-f0-9-]+\.json$/.test(name)).map(name => readJson(path.join(this.directory, name), 16384) as TraceThread); }
}
