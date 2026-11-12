import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HistoryError } from "../tools/history/manager.mjs";

export const SESSION_RESULT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const CLIENT = /^(?:standalone|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
const KEY = /^ccodex:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_BYTES = 2 * 1024 * 1024;

function valid(record) {
  return record?.schemaVersion === 1 && record.kind === "ccodex-session-batch-result" &&
    UUID.test(record.planId || "") && CLIENT.test(record.clientId || "") &&
    ["delete", "archive", "unarchive"].includes(record.operation) &&
    Number.isSafeInteger(record.total) && record.total > 0 && record.total <= 500 &&
    Array.isArray(record.keys) && record.keys.length === record.total &&
    record.keys.every(key => KEY.test(key)) && new Set(record.keys).size === record.total &&
    Array.isArray(record.results) && record.results.length <= record.total &&
    record.results.every(row => record.keys.includes(row.key) &&
      ["complete", "failed", "skipped"].includes(row.status) &&
      ["code", "reason", "message"].every(key => row[key] === undefined ||
        (typeof row[key] === "string" && row[key].length <= 2000))) &&
    new Set(record.results.map(row => row.key)).size === record.results.length &&
    typeof record.done === "boolean" && Number.isFinite(Date.parse(record.acceptedAt)) &&
    Number.isFinite(Date.parse(record.updatedAt)) &&
    (record.expiresAt === null || Number.isFinite(Date.parse(record.expiresAt))) &&
    (!record.done || record.expiresAt !== null) &&
    (record.error === undefined || (typeof record.error === "string" && record.error.length <= 2000));
}

/** A bounded result/checkpoint journal, not a history backup or a replay queue. */
export class SessionResultStore {
  constructor(home, { now = Date.now } = {}) {
    this.home = path.resolve(home);
    this.now = now;
    this.directory = path.join(this.home, "session-batch-results");
  }

  folder(create = false) {
    if (!fs.existsSync(this.directory)) {
      if (!create) return null;
      fs.mkdirSync(this.directory, { mode: 0o700 });
    }
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        path.dirname(fs.realpathSync(this.directory)) !== fs.realpathSync(this.home)) {
      throw new HistoryError("result_store_unavailable", "The batch result directory is not a private regular directory.");
    }
    return this.directory;
  }

  file(id) {
    if (!UUID.test(id || "")) throw new HistoryError("invalid_plan", "Batch results require a complete preview UUID.");
    return path.join(this.directory, id + ".json");
  }

  readFile(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) {
      throw new HistoryError("result_store_unavailable", "The saved batch result is not a bounded regular file.");
    }
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!valid(record) || path.basename(file) !== record.planId + ".json") {
      throw new HistoryError("result_store_unavailable", "The saved batch result is invalid; no batch was replayed.");
    }
    return record;
  }

  write(record, { create = false } = {}) {
    if (!valid(record)) throw new HistoryError("invalid_result", "Cannot save invalid session batch results.");
    this.folder(true);
    const file = this.file(record.planId);
    if (fs.existsSync(file)) {
      if (create) throw new HistoryError("plan_consumed", "This preview already has an execution receipt; it cannot be applied again.");
      const previous = this.readFile(file);
      if (previous.clientId !== record.clientId || previous.acceptedAt !== record.acceptedAt ||
          previous.operation !== record.operation ||
          JSON.stringify(previous.keys) !== JSON.stringify(record.keys)) {
        throw new HistoryError("result_store_unavailable", "The execution receipt changed ownership; it was not replaced.");
      }
    }
    const bytes = JSON.stringify(record) + "\n";
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new HistoryError("result_limit", "The saved result exceeds its bounded size.");
    const pending = path.join(this.directory, `${record.planId}.${randomUUID()}.pending`);
    let descriptor;
    try {
      descriptor = fs.openSync(pending, "wx", 0o600);
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      // Never delete the old receipt to work around a failed atomic replacement.
      fs.renameSync(pending, file);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(pending)) fs.unlinkSync(pending);
    }
  }

  read(id, clientId) {
    if (!this.folder()) return null;
    const prefix = /^[a-f0-9]{8}$/i.test(id || "") ? id.toLowerCase() : null;
    if (!prefix && !UUID.test(id || "")) return null;
    const names = prefix
      ? fs.readdirSync(this.directory).filter(name => name.startsWith(prefix) &&
        UUID.test(name.slice(0, -5)) && name.endsWith(".json"))
      : [id + ".json"];
    if (names.length > 1000) throw new HistoryError("result_limit", "Narrow the saved result lookup to the full preview UUID.");
    const matches = [];
    for (const name of names) {
      const file = path.join(this.directory, name);
      if (!fs.existsSync(file)) continue;
      const record = this.readFile(file);
      if (record.clientId === clientId &&
          (!record.done || Date.parse(record.expiresAt) > this.now())) matches.push(record);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  prune() {
    if (!this.folder()) return;
    for (const name of fs.readdirSync(this.directory)) {
      if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) continue;
      const file = path.join(this.directory, name);
      const record = this.readFile(file);
      if (record.done && Date.parse(record.expiresAt) <= this.now()) fs.unlinkSync(file);
    }
  }
}
