import "../tools/typescript-runtime.mjs";
import type { StoredThread, ThreadTombstone } from "./contracts.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const maxBytes = 8 * 1024 * 1024;
const validId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Frontends may inspect ownership, but must never instantiate ThreadStore:
 * recovery and writes belong exclusively to the socket-owning gateway. */
export function readThreadOwnership(directory: string, id: unknown) {
  if (typeof id !== "string" || !validId.test(id)) return null;
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid gateway ownership directory.");
  const file = path.join(directory, `${id}.json`);
  try { stat = fs.lstatSync(file); }
  catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("Invalid gateway ownership record.");
  const thread = JSON.parse(fs.readFileSync(file, "utf8")) as StoredThread | ThreadTombstone;
  if (thread.schemaVersion !== 1 || thread.id !== id || typeof thread.engineId !== "string" || !thread.engineId) throw new Error("Corrupt gateway ownership record; native fallback is prohibited.");
  return { engineId: thread.engineId, adapter: thread.engineAdapter, ...("deleted" in thread ? { deleted: true } : {}) };
}

/** One atomic document per thread, written only by the socket-owning gateway.
 * There is no cross-thread transaction or per-token journal to maintain. */
export class ThreadStore {
  directory: string; threads: Map<string, StoredThread>;
  deleted = new Map<string, ThreadTombstone>();
  constructor(directory: string) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Thread storage cannot be linked.");
    this.threads = new Map();
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith(".json"))) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("Invalid gateway thread file.");
      const thread = JSON.parse(fs.readFileSync(file, "utf8")) as StoredThread | ThreadTombstone;
      if ("deleted" in thread) {
        if (thread.deleted !== true || thread.schemaVersion !== 1 || !validId.test(thread.id) || name !== `${thread.id}.json` ||
            typeof thread.engineId !== "string" || !["pending", "complete", "unsupported"].includes(thread.cleanup)) throw new Error("Invalid deleted thread ownership record.");
        this.deleted.set(thread.id, thread); continue;
      }
      if (!validId.test(thread.id) || name !== `${thread.id}.json` || thread.schemaVersion !== 1 ||
          typeof thread.engineId !== "string" || !Array.isArray(thread.turns)) throw new Error("Unsupported gateway thread state.");
      this.threads.set(thread.id, thread);
      // The external CLI may already have acted. Never re-submit an uncertain turn.
      if (thread.turns.some(turn => turn.status === "inProgress")) {
        for (const turn of thread.turns) if (turn.status === "inProgress") {
          turn.status = "failed";
          turn.error = { message: "Gateway stopped during this turn. The CLI outcome is unknown; inspect the workspace before continuing.", codexErrorInfo: null, additionalDetails: null };
        }
        thread.status = { type: "idle" };
        this.save(thread);
      }
    }
  }
  get(id: string) {
    if (this.deleted.has(id)) throw new Error("This gateway thread was permanently deleted.");
    const thread = this.threads.get(id);
    if (!thread) throw new Error("Unknown gateway thread.");
    return structuredClone(thread);
  }
  all() { return [...this.threads.values()].map(thread => structuredClone(thread)); }
  save(thread: StoredThread) {
    if (this.deleted.has(thread.id)) throw new Error("A deleted gateway thread cannot be restored by an old execution snapshot.");
    this.persist(thread);
    this.threads.set(thread.id, structuredClone(thread));
  }
  saveExecution(thread: StoredThread) {
    // Execution owns only these fields. All UI intent/metadata belongs to the
    // latest committed document, including future metadata fields.
    const current = this.get(thread.id);
    this.save({ ...current, nativeSessionId: thread.nativeSessionId, turns: thread.turns,
      status: thread.status, updatedAt: thread.updatedAt, preview: thread.preview });
  }
  tombstone(thread: StoredThread, cleanup: ThreadTombstone["cleanup"]) {
    const value: ThreadTombstone = { schemaVersion: 1, id: thread.id, engineId: thread.engineId, engineAdapter: thread.engineAdapter,
      deleted: true, deletedAt: Math.floor(Date.now() / 1000), cleanup,
      ...(cleanup === "pending" && thread.nativeSessionId ? { nativeSessionId: thread.nativeSessionId, cwd: thread.cwd } : {}) };
    this.saveTombstone(value); return value;
  }
  saveTombstone(value: ThreadTombstone) {
    this.persist(value); this.threads.delete(value.id); this.deleted.set(value.id, structuredClone(value));
  }
  private persist(thread: StoredThread | ThreadTombstone) {
    if (!validId.test(thread.id)) throw new Error("Invalid gateway thread ID.");
    const bytes = JSON.stringify(thread);
    if (Buffer.byteLength(bytes) > maxBytes) throw new Error("Gateway thread storage limit reached.");
    const file = path.join(this.directory, `${thread.id}.json`);
    const pending = `${file}.${randomUUID()}.pending`;
    const fd = fs.openSync(pending, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.renameSync(pending, file); }
    finally { fs.rmSync(pending, { force: true }); }
    const directoryFd = fs.openSync(this.directory, "r");
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  }
}
