import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ReactionRequest, ReactionRecord } from "./work-dispatch-contracts.mjs";
import { parseHostRef } from "./host-thread-contracts.mjs";
import { privateDirectory } from "./storage.mjs";
import { readJson, writeJson } from "./io.mjs";

const hex = /^[a-f0-9]{64}$/, uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, subtaskPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const actions = ["continue", "implement", "scout", "integrate"];
const states = ["queued", "dispatching", "accepted", "settled", "needs_attention", "cancelled"];
export function parseReactionRequest(value: unknown): ReactionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid reaction request.");
  const p = value as ReactionRequest;
  if (Object.keys(p).some(key => !["workItemId", "observationId", "action", "briefRevision", "policyRevision", "message", "subtaskId"].includes(key)) ||
    typeof p.workItemId !== "string" || !uuid.test(p.workItemId) || typeof p.observationId !== "string" || !hex.test(p.observationId) || !actions.includes(p.action) ||
    p.subtaskId !== undefined && (typeof p.subtaskId !== "string" || !subtaskPattern.test(p.subtaskId)) ||
    !Number.isSafeInteger(p.briefRevision) || p.briefRevision < 1 || !Number.isSafeInteger(p.policyRevision) || p.policyRevision < 1 ||
    typeof p.message !== "string" || !p.message.trim() || Buffer.byteLength(JSON.stringify(p.message)) > 16384) throw new Error("Invalid reaction request.");
  return structuredClone(p);
}
export const reactionKey = (p: ReactionRequest) => createHash("sha256").update(JSON.stringify(p.subtaskId ? [p.workItemId, p.observationId, p.action, p.subtaskId] : [p.workItemId, p.observationId, p.action])).digest("hex");
export function reactionRequest(p: ReactionRecord): ReactionRequest {
  return { workItemId: p.workItemId, observationId: p.observationId, action: p.action, briefRevision: p.briefRevision, policyRevision: p.policyRevision, message: p.message, ...(p.subtaskId ? { subtaskId: p.subtaskId } : {}) };
}
function parseRecord(value: unknown, id: string): ReactionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reaction record is unavailable.");
  const p = value as ReactionRecord;
  parseReactionRequest(reactionRequest(p));
  if (p.schemaVersion !== 1 || p.id !== id || reactionKey(p) !== id || p.requestId !== id || !Number.isSafeInteger(p.revision) || p.revision < 1 ||
    !states.includes(p.state) || !Number.isSafeInteger(p.attempts) || p.attempts < 0 || p.attempts > 100 ||
    ![p.createdAt, p.updatedAt].every(value => typeof value === "string" && Number.isFinite(Date.parse(value))) ||
    !(p.reason === null || typeof p.reason === "string" && p.reason.length <= 128) ||
    !(p.workspace === null || typeof p.workspace === "string" && path.isAbsolute(p.workspace) && p.workspace.length <= 4096) ||
    !(p.resourceVersion === null || typeof p.resourceVersion === "string" && p.resourceVersion.length > 0 && p.resourceVersion.length <= 256)) throw new Error("Incompatible or invalid reaction record.");
  if (!(p.briefText === null || typeof p.briefText === "string" && p.briefText.trim() && Buffer.byteLength(JSON.stringify(p.briefText)) <= 8192)) throw new Error("Invalid adopted work context.");
  if (p.target !== null) parseHostRef(p.target);
  if (p.receipt !== null) {
    const r = p.receipt;
    parseHostRef(r.ref);
    if (r.requestId !== id || !["pending", "accepted", "not_sent", "unknown", "not_found"].includes(r.state) || !Number.isFinite(Date.parse(r.observedAt)) ||
      r.state === "accepted" && (typeof r.turnId !== "string" || !r.turnId.length || r.turnId.length > 128)) throw new Error("Invalid stored receipt.");
    if (!p.target || (["hostId", "accountId", "runtimeId", "threadId"] as const).some(key => r.ref[key] !== p.target![key])) throw new Error("Receipt belongs to another target.");
  }
  if (p.outcome !== null && (typeof p.outcome.turnId !== "string" || !p.outcome.turnId.length || !["completed", "failed", "interrupted"].includes(p.outcome.status) || !Number.isFinite(Date.parse(p.outcome.observedAt)))) throw new Error("Invalid stored execution outcome.");
  if (["dispatching", "accepted", "settled"].includes(p.state) && (!p.target || !p.workspace || !p.resourceVersion || !p.briefText)) throw new Error("Reaction lost its bound authority.");
  if (["accepted", "settled"].includes(p.state) && (p.receipt?.state !== "accepted" || !p.receipt.turnId)) throw new Error("Reaction lost its accepted execution.");
  if (p.state === "settled" && (!p.outcome || p.outcome.turnId !== p.receipt?.turnId)) throw new Error("Reaction lost its execution outcome.");
  return p;
}
/** One object per file. No cursor update, external effect or cross-file
 * transaction is implied by an atomic record replacement. */
export class ReactionStore {
  readonly directory: string;
  constructor(home: string) {
    this.directory = privateDirectory(path.join(home, "gateway/spine/reactions"));
    const schema = path.join(this.directory, "schema.json");
    let exists = true;
    try { fs.lstatSync(schema); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw cause; }
    if (!exists) writeJson(schema, { schemaVersion: 1 });
    if ((readJson(schema, 1024, { privateFile: true }) as { schemaVersion: number }).schemaVersion !== 1) throw new Error("Incompatible reaction schema; data was preserved.");
  }
  private file(id: string) {
    if (!hex.test(id)) throw new Error("Invalid reaction identity.");
    return path.join(this.directory, id.slice(0, 2), id + ".json");
  }
  get(id: string): ReactionRecord | undefined {
    const file = this.file(id);
    try { return parseRecord(readJson(file, 64 * 1024, { privateFile: true }), id); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw cause; }
  }
  save(record: ReactionRecord, expectedRevision: number) {
    parseRecord(record, record.id);
    const current = this.get(record.id);
    if ((current?.revision ?? 0) !== expectedRevision || record.revision !== expectedRevision + 1) throw new Error("Reaction revision conflict.");
    writeJson(this.file(record.id), record);
    return structuredClone(record);
  }
  *ids(): Generator<string> {
    for (const prefix of fs.readdirSync(this.directory).filter(value => /^[a-f0-9]{2}$/.test(value)).sort()) {
      const directory = privateDirectory(path.join(this.directory, prefix), false);
      for (const name of fs.readdirSync(directory).sort()) if (/^[a-f0-9]{64}\.json$/.test(name) && name.startsWith(prefix)) yield name.slice(0, -5);
    }
  }
}
