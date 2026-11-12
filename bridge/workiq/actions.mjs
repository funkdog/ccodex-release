import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { acquireCacheLock, dpapi } from "./cache.mjs";
import { atomicWrite, identityBindingFingerprint, paths, publicStatus, readSettings } from "./settings.mjs";
import { safeWorkIqError } from "./auth.mjs";

const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 50;
const MAX_AGE_MS = 30 * 60_000;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sha = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const WRITE_TOOLS = new Set(["create_entity", "update_entity", "delete_entity", "do_action"]);

export function isReadOnlyTool(tool) {
  return !WRITE_TOOLS.has(tool?.name) && tool?.annotations?.readOnlyHint === true;
}

export class ActionQueue {
  constructor(profile, {
    protect = value => dpapi("protect", value, { purpose: "action-record" }),
    unprotect = value => dpapi("unprotect", value, { purpose: "action-record" }),
    now = () => Date.now(),
  } = {}) {
    this.profile = profile;
    this.directory = path.join(paths(profile).state, "actions");
    this.protect = protect;
    this.unprotect = unprotect;
    this.now = now;
  }

  file(id) {
    if (!uuidPattern.test(id || "")) throw new Error("Invalid Work IQ action ID.");
    return path.join(this.directory, `${id}.json`);
  }

  summary(record) {
    return {
      id: record.id,
      tool: record.params.name,
      status: record.status,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      requestHash: record.requestHash,
    };
  }

  async save(record) {
    const json = JSON.stringify(record);
    if (Buffer.byteLength(json) > MAX_RECORD_BYTES) throw new Error("Work IQ action record exceeded its encrypted storage limit.");
    const sealedRecord = await this.protect(json);
    atomicWrite(this.file(record.id), `${JSON.stringify({ ...this.summary(record), sealedRecord }, null, 2)}\n`);
  }

  async read(id) {
    let wrapper;
    try { wrapper = JSON.parse(fs.readFileSync(this.file(id), "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") throw new Error("Work IQ action was not found.");
      throw error;
    }
    if (typeof wrapper.sealedRecord !== "string") throw new Error("Work IQ action has no protected record.");
    const record = JSON.parse(await this.unprotect(wrapper.sealedRecord));
    if (record.id !== id || record.requestHash !== sha(record.params) ||
        JSON.stringify(this.summary(record)) !== JSON.stringify({
          id: wrapper.id, tool: wrapper.tool, status: wrapper.status,
          createdAt: wrapper.createdAt, expiresAt: wrapper.expiresAt, requestHash: wrapper.requestHash,
        })) {
      throw new Error("Work IQ action metadata failed its encrypted-record integrity check.");
    }
    return record;
  }

  list() {
    if (!fs.existsSync(this.directory)) return [];
    const result = [];
    for (const file of fs.readdirSync(this.directory)) {
      if (!file.endsWith(".json") || !uuidPattern.test(file.slice(0, -5))) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.directory, file), "utf8"));
        result.push({
          id: record.id, tool: record.tool, status: record.status,
          createdAt: record.createdAt, expiresAt: record.expiresAt, requestHash: record.requestHash,
        });
      } catch { /* Corrupt records are never treated as approved. */ }
    }
    return result.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 200);
  }

  async enqueue(params) {
    if (!publicStatus(this.profile).enabled) throw new Error("Work IQ is disabled.");
    const settings = readSettings(this.profile);
    const binding = identityBindingFingerprint(settings);
    if (!binding) throw new Error("An explicit Microsoft account and actual tenant binding are required before preparing actions.");
    const cleanParams = { name: params.name, arguments: params.arguments || {} };
    if (typeof cleanParams.name !== "string" || !cleanParams.name) throw new Error("A real cloud tool name is required.");
    if (Buffer.byteLength(JSON.stringify(cleanParams)) > MAX_RECORD_BYTES / 2) throw new Error("Work IQ action arguments exceed the review size limit.");
    const hash = sha(cleanParams);
    const unlock = await acquireCacheLock(path.join(this.directory, "queue"));
    try {
      const pending = this.list().filter(action => action.status === "pending");
      for (const item of pending.filter(action => action.requestHash === hash)) {
        const existing = await this.read(item.id);
        if (existing.identityBindingSha256 === binding && Date.parse(existing.expiresAt) > this.now()) {
          return this.receipt(existing);
        }
      }
      if (pending.length >= MAX_PENDING) throw new Error("Review or reject existing Work IQ actions before queuing more.");
      const record = {
        id: randomUUID(),
        status: "pending",
        createdAt: new Date(this.now()).toISOString(),
        expiresAt: new Date(this.now() + MAX_AGE_MS).toISOString(),
        accountId: settings.selectedAccountId,
        tenant: settings.tenant,
        tenantId: settings.selectedTenantId,
        identityBindingSha256: binding,
        requestHash: hash,
        params: cleanParams,
      };
      await this.save(record);
      return this.receipt(record);
    } finally {
      unlock();
    }
  }

  receipt(record) {
    return {
      ...this.summary(record),
      status: "approval_required",
      executed: false,
      instruction: "The user must review this exact action in Desktop's Work IQ panel or run 'ccodex workiq actions approve <id>' in their own interactive terminal. The agent must not approve its own action through shell tools.",
    };
  }

  async show(id) {
    const record = await this.read(id);
    const settings = readSettings(this.profile);
    if (!record.identityBindingSha256 || record.identityBindingSha256 !== identityBindingFingerprint(settings)) {
      throw new Error("This action belongs to another Microsoft account or tenant selection, or requires a fresh tenant-bound review.");
    }
    return {
      ...this.summary(record),
      arguments: record.params.arguments,
      ...(record.result ? { result: record.result } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  async reject(id) {
    const unlock = await acquireCacheLock(this.file(id));
    try {
      const record = await this.read(id);
      if (record.status !== "pending") throw new Error("Only a pending Work IQ action can be rejected.");
      record.status = "rejected";
      await this.save(record);
      return this.summary(record);
    } finally { unlock(); }
  }

  async approve(id, expectedHash, execute) {
    if (!publicStatus(this.profile).enabled) throw new Error("Work IQ is disabled.");
    const unlock = await acquireCacheLock(this.file(id));
    try {
      const record = await this.read(id);
      const settings = readSettings(this.profile);
      if (record.status !== "pending") throw new Error("This action is no longer pending; it will not be replayed.");
      if (expectedHash !== record.requestHash) throw new Error("Action review hash did not match; no operation was executed.");
      if (!record.identityBindingSha256 || record.identityBindingSha256 !== identityBindingFingerprint(settings)) {
        throw new Error("The selected Microsoft account changed or its tenant binding differs from this prepared action.");
      }
      if (Date.parse(record.expiresAt) <= this.now()) throw new Error("Action review expired. Prepare and review a fresh request.");
      record.status = "executing";
      await this.save(record);
      if (!publicStatus(this.profile).enabled ||
          record.identityBindingSha256 !== identityBindingFingerprint(readSettings(this.profile))) {
        record.status = "cancelled";
        await this.save(record);
        throw new Error("The Microsoft account, tenant, or enabled state changed during review; no operation was executed.");
      }
      try {
        const result = await execute(record.params);
        record.status = result?.isError ? "failed" : "completed";
        record.result = result;
        await this.save(record);
        return this.show(id);
      } catch (error) {
        // A timeout, disconnect or post-call storage error is NOT proof of no
        // side effect. Persist an uncertain terminal state, never replay it.
        record.status = "unknown";
        record.result = undefined;
        record.error = safeWorkIqError(error);
        await this.save(record);
        return this.show(id);
      }
    } finally {
      unlock();
    }
  }
}
