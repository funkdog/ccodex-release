import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HistoryError, HistoryManager } from "../tools/history/manager.mjs";
import { codexBackend } from "../tools/history/backends.mjs";
import { desktopSnapshot, desktopStateRoot } from "./desktop-runtime.mjs";
import { protectCliBackend, registerCliThread } from "./cli-session-ownership.mjs";
import { SessionResultStore, SESSION_RESULT_LIFETIME_MS } from "./session-result-store.mjs";

const MAX_SELECTION = 500;
const OPERATIONS = new Set(["archive", "unarchive", "delete"]);
const CLIENT = /^(?:standalone|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;

export function sessionRequestAuthorized(req, { port, token }) {
  const supplied = req.headers["x-codex-copilot-control"];
  const local = value => value === "::1" || /^127\./.test(value || "") ||
    /^::ffff:127\./i.test(value || "");
  return req.method === "POST" && local(req.socket.remoteAddress) &&
    local(req.socket.localAddress) &&
    [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(req.headers.host) &&
    !req.headers.origin && !req.headers.referer &&
    !Object.keys(req.headers).some(key => key.startsWith("sec-fetch-")) &&
    req.headers["content-type"]?.split(";", 1)[0] === "application/json" &&
    typeof supplied === "string" && Buffer.byteLength(supplied) === Buffer.byteLength(token) &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
}

export class SessionManagement {
  constructor({ home, core, managerFactory, now = Date.now, resultsStore } = {}) {
    this.home = home;
    this.now = now;
    this.resultsStore = resultsStore === undefined && home
      ? new SessionResultStore(home, { now }) : resultsStore;
    this.factory = managerFactory || (async () => {
      const root = path.resolve(import.meta.dirname, "..");
      const runtime = core ? null : desktopSnapshot(root, { stateRoot: desktopStateRoot({ root, home }) });
      const selected = core || path.join(runtime.resources, process.platform === "win32" ? "codex.exe" : "codex");
      if (!fs.lstatSync(selected).isFile()) throw new HistoryError("core_unavailable", "The current Desktop history API is unavailable.");
      const backend = protectCliBackend(await codexBackend({
        home, core: selected, nativeWriterLocks: true,
      }), home);
      return { manager: new HistoryManager({ ccodex: backend }), close: () => backend.close() };
    });
    this.previews = new Map();
    this.snapshots = new Map();
    this.jobs = new Map();
    this.initializing = null;
    this.resource = null;
    this.closed = false;
    this.resultsPrunedAt = -Infinity;
  }

  get backgroundJobs() { return [...this.jobs.values()].filter(job => !job.done).length; }

  async manager() {
    if (this.closed) throw new HistoryError("interface_closing", "Session management is shutting down.");
    if (!this.initializing) {
      this.initializing = Promise.resolve().then(() => this.factory()).then(resource => {
        this.resource = resource;
        return resource.manager;
      }).catch(error => { this.initializing = null; throw error; });
    }
    return this.initializing;
  }

  prune() {
    const now = this.now();
    if (this.resultsStore && now - this.resultsPrunedAt > 60 * 60_000) {
      this.resultsStore.prune();
      this.resultsPrunedAt = now;
    }
    for (const collection of [this.previews, this.snapshots, this.jobs]) {
      for (const [id, item] of collection) {
        if (item.expiresAt <= now && item.done !== false) collection.delete(id);
      }
    }
  }

  async request(operation, args = {}) {
    this.prune();
    if (!args || Array.isArray(args) || typeof args !== "object") {
      throw new HistoryError("invalid_arguments", "Use a structured session-management request.");
    }
    const clientId = args.clientId || "standalone";
    if (typeof clientId !== "string" || !CLIENT.test(clientId)) {
      throw new HistoryError("invalid_client", "Invalid session-management client identity.");
    }
    if (this.home && args.currentThreadId) registerCliThread(this.home,
      { clientId, ownerPid: args.ownerPid, currentThreadId: args.currentThreadId });
    if (operation === "progress") {
      const matches = typeof args.planId === "string" && /^[a-f0-9]{8}$/i.test(args.planId)
        ? [...this.jobs.entries()].filter(([id, item]) =>
          item.clientId === clientId && id.startsWith(args.planId.toLowerCase())) : [];
      const planId = matches.length === 1 ? matches[0][0] : args.planId;
      const job = this.jobs.get(planId);
      if (!job || job.clientId !== clientId) {
        const saved = this.resultsStore?.read(args.planId, clientId);
        if (saved) return {
          planId: saved.planId, operation: saved.operation, total: saved.total,
          completed: saved.results.length, results: saved.results, done: true,
          expiresAt: saved.expiresAt, restoredFromJournal: true,
          ...(!saved.done ? { interrupted: true,
            error: "This execution has only a saved checkpoint. Its final status cannot be confirmed; nothing was replayed." }
            : saved.error ? { error: saved.error } : {}),
        };
        throw new HistoryError("execution_unavailable", "This batch result is unavailable for this client.");
      }
      const manager = await this.manager();
      return { ...(job.result || manager.progress(planId)), ...(job.error ? { error: job.error } : {}) };
    }
    const manager = await this.manager();
    if (operation === "reconcile") {
      if (this.backgroundJobs) {
        throw new HistoryError("batch_busy", "A batch is still executing. Check its progress; no operation was replayed.");
      }
      if (!OPERATIONS.has(args.operation) || !Array.isArray(args.keys) ||
          !args.keys.length || args.keys.length > MAX_SELECTION ||
          args.keys.some(key => typeof key !== "string" ||
            !/^ccodex:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(key)) ||
          new Set(args.keys).size !== args.keys.length) {
        throw new HistoryError("invalid_selection", "Reconciliation requires the exact preview's 1-500 session IDs.");
      }
      const current = new Map((await manager.sessions("ccodex")).map(row => [row.key, row]));
      return { operation: args.operation, readOnly: true, reconstructed: true,
        results: args.keys.map(key => {
          const row = current.get(key);
          return { key, status: !row ? "absent" : args.operation === "delete" ? "present"
            : row.archived === (args.operation === "archive") ? "matches" : "present" };
        }) };
    }
    if (operation === "list") {
      const { query = "", cwd = "", archived, cursor = 0, limit = 50 } = args;
      const result = await manager.list({ product: "ccodex", query, cwd, archived, cursor, limit });
      if (this.snapshots.size >= 100 && !this.snapshots.has(clientId)) {
        throw new HistoryError("client_limit", "Too many session list clients; retry after an older list expires.");
      }
      this.snapshots.set(clientId, { keys: result.sessions.map(row => row.key),
        expiresAt: this.now() + 10 * 60_000 });
      return result;
    }
    if (operation === "preview") {
      if (!OPERATIONS.has(args.operation)) {
        throw new HistoryError("invalid_operation", "Use archive, unarchive or delete, then confirm the exact preview.");
      }
      let keys = args.keys;
      if (args.selection !== undefined) {
        if (keys !== undefined) throw new HistoryError("invalid_selection", "Choose IDs or row numbers, not both.");
        const snapshot = this.snapshots.get(clientId);
        if (!snapshot) throw new HistoryError("list_required", "Run /sessions list before selecting row numbers.");
        keys = selectionKeys(args.selection, snapshot.keys);
      }
      if (args.all === true) {
        if (keys !== undefined) throw new HistoryError("invalid_selection", "Choose explicit sessions or all filtered results.");
        keys = [];
        let cursor = 0;
        do {
          const result = await manager.list({ product: "ccodex", query: args.query || "",
            cwd: args.cwd || "", archived: args.archived, cursor, limit: 200 });
          if (result.total > MAX_SELECTION) {
            throw new HistoryError("selection_limit", "More than 500 sessions match. Narrow the filter before selecting all.");
          }
          keys.push(...result.sessions.map(row => row.key));
          cursor = result.nextCursor;
        } while (cursor !== null);
      }
      if (this.previews.size >= 100) {
        throw new HistoryError("preview_limit", "Too many outstanding previews; wait for an older preview to expire.");
      }
      const plan = await manager.plan({ operation: args.operation, keys });
      const confirm = randomUUID().slice(0, 8);
      const deletionAcknowledgement = plan.operation === "delete"
        ? `DELETE ${plan.entries.filter(entry => entry.eligible).length} ${plan.id.slice(0, 8)}` : null;
      this.previews.set(plan.id, { clientId, plan, confirm, deletionAcknowledgement,
        expiresAt: Date.parse(plan.expiresAt) });
      return { id: plan.id, operation: plan.operation, entries: plan.entries,
        expiresAt: plan.expiresAt, confirmation: confirm,
        ...(deletionAcknowledgement ? { irreversible: true, deletionAcknowledgement } : {}) };
    }
    if (operation === "apply") {
      const matches = typeof args.planId === "string" && /^[a-f0-9]{8}$/i.test(args.planId)
        ? [...this.previews.entries()].filter(([id, item]) =>
          item.clientId === clientId && id.startsWith(args.planId.toLowerCase())) : [];
      const planId = matches.length === 1 ? matches[0][0] : args.planId;
      const stored = this.previews.get(planId);
      if (!stored || stored.clientId !== clientId) {
        throw new HistoryError("preview_required", "Create a fresh batch preview for this client.");
      }
      if (typeof args.confirmation !== "string" || args.confirmation !== stored.confirm) {
        throw new HistoryError("confirmation_required", "Supply the exact confirmation shown in the preview.");
      }
      if (stored.plan.operation === "delete" &&
          args.deletionAcknowledgement !== stored.deletionAcknowledgement) {
        throw new HistoryError("deletion_acknowledgement_required",
          "Permanent deletion cannot be restored. Supply the exact DELETE count and preview ID shown in this preview.");
      }
      if (stored.plan.operation !== "delete" && args.deletionAcknowledgement !== undefined) {
        throw new HistoryError("invalid_arguments", "Deletion acknowledgement is only valid for a delete preview.");
      }
      if (this.backgroundJobs) throw new HistoryError("batch_busy", "Another batch is applying; wait for its results.");
      manager.validatePlan(stored.plan, stored.plan.confirmation);
      const acceptedAt = new Date(this.now()).toISOString();
      const job = { clientId, done: false, expiresAt: Infinity,
        acceptedAt, keys: stored.plan.entries.map(entry => entry.key), lastCheckpointAt: -Infinity };
      const save = state => {
        job.result = state;
        if (!this.resultsStore || (!state.done && this.now() - job.lastCheckpointAt < 1000)) return;
        this.resultsStore.write({
          schemaVersion: 1, kind: "ccodex-session-batch-result", clientId, acceptedAt,
          planId, operation: state.operation, keys: job.keys, total: state.total,
          results: state.results.map(row => ({ ...row,
            ...(row.message ? { message: row.message.slice(0, 2000) } : {}) })),
          done: state.done, updatedAt: new Date(this.now()).toISOString(),
          expiresAt: state.done ? new Date(this.now() + SESSION_RESULT_LIFETIME_MS).toISOString() : null,
          ...(job.error ? { error: job.error.slice(0, 2000) } : {}),
        });
        job.lastCheckpointAt = this.now();
      };
      this.resultsStore?.write({
        schemaVersion: 1, kind: "ccodex-session-batch-result", clientId, acceptedAt,
        planId, operation: stored.plan.operation, keys: job.keys, total: job.keys.length,
        results: [], done: false, updatedAt: acceptedAt, expiresAt: null,
      }, { create: true });
      this.previews.delete(planId);
      this.jobs.set(planId, job);
      job.work = manager.apply(stored.plan, stored.plan.confirmation, { onProgress: save }).catch(error => {
        job.error = error.message;
      }).finally(() => {
        job.done = true;
        job.expiresAt = this.now() + SESSION_RESULT_LIFETIME_MS;
        let state;
        try { state = manager.progress(planId); }
        catch { state = { planId, operation: stored.plan.operation, total: job.keys.length,
          completed: 0, results: [], expiresAt: new Date(job.expiresAt).toISOString() }; }
        job.result = { ...state, done: true };
        try { save(job.result); }
        catch (error) { job.error = `Batch result could not be saved: ${error.message}`; }
      });
      return { accepted: true, planId };
    }
    throw new HistoryError("invalid_operation", "Unknown session-management request.");
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.jobs.values()].map(job => job.work));
    if (this.initializing) await this.initializing.catch(() => {});
    await this.resource?.close?.();
  }
}

export function selectionKeys(selection, keys) {
  if (selection === "all") return [...keys];
  if (typeof selection !== "string" || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(selection)) {
    throw new HistoryError("invalid_selection", "Use row numbers such as 1,3-5, or all.");
  }
  const selected = new Set();
  for (const item of selection.split(",")) {
    const [start, end = start] = item.split("-").map(Number);
    if (start < 1 || end < start || end > keys.length) {
      throw new HistoryError("invalid_selection", "Selected row numbers are outside the last displayed list.");
    }
    for (let row = start; row <= end; row++) selected.add(keys[row - 1]);
  }
  return [...selected];
}
