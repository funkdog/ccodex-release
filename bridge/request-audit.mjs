import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CODEX_COPILOT_HOME } from "./auth.mjs";
import { atomicWrite } from "./catalog-store.mjs";

const AUDIT_FILE = path.join(CODEX_COPILOT_HOME, "request-audit.jsonl");
const LATEST_FILE = path.join(CODEX_COPILOT_HOME, "request-audit-latest.json");
const THREAD_STATUS_DIR = path.join(CODEX_COPILOT_HOME, "request-status");
const MAX_BYTES = Number(process.env.CODEX_COPILOT_REQUEST_AUDIT_MAX_BYTES || 2 * 1024 * 1024);
const REDACTED_KEYS = /(authorization|token|secret|prompt|input|instructions|messages|tools|content|body)/i;

function compactFile() {
  try {
    const stat = fs.statSync(AUDIT_FILE);
    if (stat.size <= MAX_BYTES) return;
    const records = fs.readFileSync(AUDIT_FILE, "utf8").trim().split(/\r?\n/).slice(-250);
    atomicWrite(AUDIT_FILE, `${records.join("\n")}\n`);
  } catch {
    // Diagnostics must never interfere with inference.
  }
}

function isSensitiveAuditKey(key) {
  if (
    [
      "input_tokens",
      "input_tokens_details",
      "prompt_tokens",
      "prompt_tokens_details",
      "output_tokens",
      "output_tokens_details",
      "completion_tokens",
      "completion_tokens_details",
      "total_tokens",
      "cached_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "reasoning_tokens",
    ].includes(key)
  ) {
    return false;
  }
  return REDACTED_KEYS.test(key);
}

function safeValue(value, depth = 0) {
  if (depth > 4) return "[omitted]";
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => safeValue(item, depth + 1));
  if (typeof value !== "object") return String(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveAuditKey(key) ? "[redacted]" : safeValue(item, depth + 1);
  }
  return result;
}

function append(record) {
  try {
    fs.mkdirSync(CODEX_COPILOT_HOME, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`, "utf8");
    atomicWrite(LATEST_FILE, `${JSON.stringify(record, null, 2)}\n`);
    const target = threadStatusPath(record.threadId);
    if (target) {
      let previous;
      try { previous = JSON.parse(fs.readFileSync(target, "utf8")); } catch {}
      // An older in-flight request must not overwrite the newer request's status.
      if (record.status === "started" || previous?.id === record.id) {
        atomicWrite(target, `${JSON.stringify(record, null, 2)}\n`);
      }
    }
    compactFile();
  } catch {
    // Audit output is optional and fail-open for requests.
  }
}

function threadStatusPath(threadId) {
  return typeof threadId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(threadId)
    ? path.join(THREAD_STATUS_DIR, `${threadId}.json`)
    : null;
}

export function startRequestAudit({
  surface = "codex",
  account = null,
  accountGeneration = null,
  threadId = null,
  requestedModel,
  upstreamModel,
  contextTier,
  effectiveContextWindow = null,
  endpoint,
  request,
}) {
  const id = randomUUID();
  const reasoning = request?.reasoning;
  const requestedEffort = reasoning && typeof reasoning === "object" ? reasoning.effort || null : null;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const base = {
    schemaVersion: 1,
    id,
    startedAt,
    completedAt: null,
    elapsedMs: null,
    surface,
    account: account || null,
    accountGeneration,
    threadId: threadStatusPath(threadId) ? threadId : null,
    requestedModel: requestedModel || null,
    upstreamModel: upstreamModel || null,
    contextTier: contextTier || "default",
    effectiveContextWindow,
    endpoint,
    requestedEffort,
    serializedEffortPath: requestedEffort ? "reasoning.effort" : null,
    serializedEffort: requestedEffort,
    status: "started",
    providerRequestId: null,
    serviceRequestId: null,
    usage: null,
    error: null,
  };
  append(base);
  let completed = false;
  return {
    id,
    complete(changes = {}) {
      if (completed) return;
      completed = true;
      const completedAtMs = Date.now();
      append({
        ...base,
        ...safeValue(changes),
        completedAt: new Date(completedAtMs).toISOString(),
        elapsedMs: Math.max(0, completedAtMs - startedAtMs),
        status: changes.status || "complete",
      });
    },
  };
}

export function readLatestRequestAudit() {
  try {
    const value = JSON.parse(fs.readFileSync(LATEST_FILE, "utf8"));
    return value?.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

export { AUDIT_FILE, LATEST_FILE, THREAD_STATUS_DIR };
