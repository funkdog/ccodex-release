import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATIONS = new Set(["delete", "archive", "unarchive", "rename"]);
const HASH = /^[0-9a-f]{64}$/;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class HistoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HistoryError";
    this.code = code;
  }
}

export function sessionKey(product, id) {
  if (!["copilot", "ccodex"].includes(product) || !UUID.test(id || "")) {
    throw new HistoryError("invalid_session", "A supported product and complete session UUID are required.");
  }
  return `${product}:${id.toLowerCase()}`;
}

export function parseSessionKey(key) {
  if (typeof key !== "string") throw new HistoryError("invalid_session", "Session selection must contain explicit IDs.");
  const [source, id, extra] = key.split(":");
  const product = source.toLowerCase();
  if (extra !== undefined || sessionKey(product, id) !== key.toLowerCase()) {
    throw new HistoryError("invalid_session", "Use product:UUID to select a session.");
  }
  return { product, id: id.toLowerCase() };
}

function safeName(value) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()
    || value.length > 100 || /[\x00-\x1f\x7f"]/.test(value)) {
    throw new HistoryError("invalid_name", "Names must be 1-100 characters, without edge whitespace, control characters or double quotes.");
  }
  return value;
}

function normalizedSession(product, row, backend) {
  const key = sessionKey(product, row.id);
  if (typeof row.inUse !== "boolean" && row.inUse !== null) {
    throw new HistoryError("in_use_unavailable", `The native ${product} backend did not determine session ownership.`);
  }
  if (!Array.isArray(row.operations) || row.operations.some(operation => !OPERATIONS.has(operation))) {
    throw new HistoryError("invalid_capabilities", "The native history backend returned invalid operation capabilities.");
  }
  const item = {
    key, product, id: row.id.toLowerCase(),
    title: typeof row.title === "string" ? row.title : "",
    cwd: typeof row.cwd === "string" ? row.cwd : "",
    createdAt: row.createdAt || null, modifiedAt: row.modifiedAt || null,
    archived: row.archived === true, remote: row.remote === true,
    inUse: row.inUse, operations: [...new Set(row.operations)],
    parentId: UUID.test(row.parentId || "") ? row.parentId.toLowerCase() : null,
    profileScope: digest([product, backend.home || null]),
  };
  item.revision = digest(item);
  return item;
}

export class HistoryManager {
  constructor(backends, { now = Date.now, planLifetimeMs = 10 * 60 * 1000,
    resultLifetimeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    this.backends = backends;
    this.now = now;
    this.planLifetimeMs = planLifetimeMs;
    this.resultLifetimeMs = resultLifetimeMs;
    this.running = new Set();
    this.executions = new Map();
  }

  async sessions(product = "all") {
    if (!["all", "copilot", "ccodex"].includes(product)) {
      throw new HistoryError("invalid_product", "Product must be copilot, ccodex or all.");
    }
    const products = product === "all" ? Object.keys(this.backends) : [product];
    const result = [];
    for (const source of products) {
      const backend = this.backends[source];
      if (!backend) throw new HistoryError("backend_unavailable", `${source} history is not available on this installation.`);
      const rows = await backend.list();
      if (!Array.isArray(rows)) throw new HistoryError("invalid_backend", "The native backend did not return a session list.");
      result.push(...rows.map(row => normalizedSession(source, row, backend)));
    }
    const unique = new Set();
    for (const row of result) {
      if (unique.has(row.key)) throw new HistoryError("duplicate_session", "The native backend returned a duplicate session identity.");
      unique.add(row.key);
    }
    return result.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt))
      || a.key.localeCompare(b.key));
  }

  async list({ product = "all", query = "", cwd = "", archived, before, after, cursor = 0, limit = 50 } = {}) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new HistoryError("invalid_page", "Use a nonnegative cursor and a page size from 1 to 200.");
    }
    if (typeof query !== "string" || typeof cwd !== "string"
      || (archived !== undefined && typeof archived !== "boolean")
      || (before !== undefined && (typeof before !== "string" || !Number.isFinite(Date.parse(before))))
      || (after !== undefined && (typeof after !== "string" || !Number.isFinite(Date.parse(after))))
      || (before && after && Date.parse(after) >= Date.parse(before))) {
      throw new HistoryError("invalid_filter", "History filters must use text, booleans and valid dates.");
    }
    const rows = (await this.sessions(product)).filter(row =>
      (!query || `${row.title} ${row.id} ${row.cwd}`.toLowerCase().includes(query.toLowerCase()))
      && (!cwd || row.cwd.toLowerCase() === cwd.toLowerCase())
      && (archived === undefined || row.archived === archived)
      && (!before || (row.modifiedAt && Date.parse(row.modifiedAt) < Date.parse(before)))
      && (!after || (row.modifiedAt && Date.parse(row.modifiedAt) >= Date.parse(after))));
    return {
      schemaVersion: 1, total: rows.length,
      sessions: rows.slice(cursor, cursor + limit),
      nextCursor: cursor + limit < rows.length ? cursor + limit : null,
    };
  }

  async plan({ operation, keys, nameTemplate } = {}) {
    if (!OPERATIONS.has(operation)) throw new HistoryError("invalid_operation", "Unsupported history operation.");
    if (!Array.isArray(keys) || !keys.length || keys.length > 500) {
      throw new HistoryError("invalid_selection", "Select 1-500 distinct explicit session IDs.");
    }
    keys.forEach(parseSessionKey);
    keys = keys.map(key => key.toLowerCase());
    if (new Set(keys).size !== keys.length) {
      throw new HistoryError("invalid_selection", "Select 1-500 distinct explicit session IDs.");
    }
    if (operation === "rename") safeName(nameTemplate);
    const products = new Set(keys.map(key => parseSessionKey(key).product));
    const available = new Map();
    for (const product of products) {
      for (const row of await this.sessions(product)) available.set(row.key, row);
    }
    if (operation === "archive" || operation === "delete") {
      const depth = key => {
        const seen = new Set();
        let row = available.get(key);
        while (row?.parentId) {
          if (seen.has(row.key)) throw new HistoryError("invalid_ancestry", "Session ancestry contains a cycle.");
          seen.add(row.key);
          row = available.get(sessionKey(row.product, row.parentId));
        }
        return seen.size;
      };
      keys.sort((left, right) => depth(right) - depth(left));
    }
    const entries = keys.map((key, index) => {
      const row = available.get(key);
      if (!row) return { key, eligible: false, reason: "not_found" };
      let reason = null;
      if (row.remote) reason = "remote_not_supported";
      else if (row.inUse !== false) reason = row.inUse ? "session_in_use" : "ownership_unknown";
      else if (!row.operations.includes(operation)) reason = "operation_not_supported";
      const name = operation === "rename" ? safeName(nameTemplate
        .replaceAll("{title}", row.title).replaceAll("{id}", row.id)
        .replaceAll("{index}", String(index + 1))) : undefined;
      return { key, title: row.title, revision: row.revision, eligible: !reason, reason,
        ...(name === undefined ? {} : { name }) };
    });
    if (operation === "delete") {
      const selected = new Map(entries.map(entry => [entry.key, entry]));
      const children = new Map();
      for (const row of available.values()) {
        if (!row.parentId) continue;
        const parent = sessionKey(row.product, row.parentId);
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(row.key);
      }
      // A native delete cascades. Require every descendant explicitly, including
      // archived children; the backend checks again immediately before mutation.
      for (const entry of entries) {
        if (!entry.eligible) continue;
        const pending = [...(children.get(entry.key) || [])], seen = new Set([entry.key]);
        while (pending.length) {
          const key = pending.pop();
          if (seen.has(key)) throw new HistoryError("invalid_ancestry", "Session ancestry contains a cycle.");
          seen.add(key);
          const child = selected.get(key);
          if (!child || !child.eligible) {
            entry.eligible = false;
            entry.reason = child ? "descendants_protected" : "descendants_not_selected";
            break;
          }
          pending.push(...(children.get(key) || []));
        }
      }
    }
    const timestamp = this.now();
    const createdAt = new Date(timestamp).toISOString();
    const plan = {
      schemaVersion: 1, kind: "history-operation-plan", id: randomUUID(),
      operation, createdAt, expiresAt: new Date(timestamp + this.planLifetimeMs).toISOString(),
      entries,
    };
    plan.confirmation = digest(plan);
    return plan;
  }

  validatePlan(plan, confirmation) {
    if (!plan || plan.schemaVersion !== 1 || plan.kind !== "history-operation-plan"
      || !UUID.test(plan.id || "") || !OPERATIONS.has(plan.operation)
      || !Array.isArray(plan.entries) || !plan.entries.length || plan.entries.length > 500) {
      throw new HistoryError("invalid_plan", "The selected history plan is invalid.");
    }
    const { confirmation: expected, ...payload } = plan;
    if (!HASH.test(expected || "") || !HASH.test(confirmation || "")
      || !timingSafeEqual(Buffer.from(expected), Buffer.from(confirmation))
      || digest(payload) !== expected) {
      throw new HistoryError("confirmation_required", "The exact preview confirmation hash is required; changed plans must be previewed again.");
    }
    const createdAt = Date.parse(plan.createdAt);
    const expiresAt = Date.parse(plan.expiresAt);
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)
      || expiresAt - createdAt !== this.planLifetimeMs || createdAt > this.now()) {
      throw new HistoryError("invalid_plan", "The history preview has an invalid creation or expiry time.");
    }
    if (this.now() >= expiresAt) {
      throw new HistoryError("plan_expired", "This history preview expired. Create a new preview.");
    }
    if (new Set(plan.entries.map(entry => entry.key)).size !== plan.entries.length) {
      throw new HistoryError("invalid_selection", "A history plan must not repeat session IDs.");
    }
    for (const entry of plan.entries) {
      parseSessionKey(entry.key);
      if (entry.key !== entry.key.toLowerCase() || typeof entry.eligible !== "boolean"
        || (entry.eligible && (!HASH.test(entry.revision || "") || entry.reason !== null))
        || (!entry.eligible && typeof entry.reason !== "string")) {
        throw new HistoryError("invalid_plan", "The history preview contains an invalid session entry.");
      }
      if (plan.operation === "rename" && entry.eligible) safeName(entry.name);
    }
  }

  progress(planId) {
    const state = this.executions.get(planId);
    if (!state) throw new HistoryError("execution_unavailable", "This history operation has not started or its progress has expired.");
    return { ...state, completed: state.results.length, results: [...state.results] };
  }

  async apply(plan, confirmation, { onProgress } = {}) {
    this.validatePlan(plan, confirmation);
    if (this.running.has(plan.id)) throw new HistoryError("plan_busy", "This history plan is already executing.");
    for (const [id, state] of this.executions) {
      if (state.done && Date.parse(state.expiresAt) <= this.now()) this.executions.delete(id);
    }
    if (this.executions.has(plan.id)) throw new HistoryError("plan_consumed", "This history preview has already been applied. Create a fresh preview.");
    this.running.add(plan.id);
    const results = [];
    const state = { planId: plan.id, operation: plan.operation, total: plan.entries.length,
      done: false, expiresAt: null, results };
    this.executions.set(plan.id, state);
    try {
      await onProgress?.(this.progress(plan.id));
      for (const entry of plan.entries) {
        if (!entry.eligible) {
          results.push({ key: entry.key, status: "skipped", reason: entry.reason });
          await onProgress?.(this.progress(plan.id));
          continue;
        }
        const { product, id } = parseSessionKey(entry.key);
        try {
          const backend = this.backends[product];
          const raw = typeof backend.get === "function" ? await backend.get(id) : undefined;
          const current = raw === undefined
            ? (await this.sessions(product)).find(row => row.id === id)
            : raw === null ? null : normalizedSession(product, raw, backend);
          if (!current) throw new HistoryError("not_found", "The session no longer exists.");
          if (current.id !== id) throw new HistoryError("invalid_session", "The native history reader returned a different session identity.");
          if (current.inUse !== false) throw new HistoryError("session_in_use", "The session is running or its ownership cannot be determined.");
          if (current.revision !== entry.revision) throw new HistoryError("session_changed", "The session changed after preview; create a new preview.");
          if (current.remote || !current.operations.includes(plan.operation)) {
            throw new HistoryError("operation_not_supported", "The native backend no longer supports this operation.");
          }
          await this.backends[product].mutate(plan.operation, id, entry.name);
          results.push({ key: entry.key, status: "complete" });
        } catch (error) {
          results.push({ key: entry.key, status: "failed",
            code: error.code || "native_operation_failed", message: error.message });
        }
        await onProgress?.(this.progress(plan.id));
      }
    } finally {
      state.done = true;
      state.expiresAt = new Date(this.now() + this.resultLifetimeMs).toISOString();
      this.running.delete(plan.id);
      await onProgress?.(this.progress(plan.id));
    }
    return { schemaVersion: 1, planId: plan.id, operation: plan.operation,
      complete: results.every(result => result.status !== "failed"), results };
  }
}
