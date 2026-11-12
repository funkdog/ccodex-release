import { setTimeout as delay } from "node:timers/promises";

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const FORBIDDEN_RETRY_SPACING_MS = 750;
let nextForbiddenRetryAt = 0;

export function isRetryableUpstreamStatus(status) {
  return RETRYABLE_STATUSES.has(Number(status));
}

export function isRetryableCopilotForbidden(status, detail = "") {
  const message = typeof detail === "string" ? detail : JSON.stringify(detail);
  return (
    Number(status) === 403 &&
    /access to this endpoint is forbidden/i.test(message) &&
    /terms of service/i.test(message)
  );
}

export function isRetryableUpstreamError(error) {
  const code = error?.cause?.code || error?.code;
  return (
    RETRYABLE_ERROR_CODES.has(code) ||
    error?.name === "TypeError" ||
    /fetch failed|socket|timed? ?out|connection reset/i.test(error?.message || "")
  );
}

export function retryDelayMs(response, attempt) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(250, Math.min(5000, seconds * 1000));
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.max(250, Math.min(5000, date - Date.now()));
    }
  }
  return Math.min(4000, 500 * (2 ** attempt));
}

export async function waitForRetry(response, attempt, signal) {
  await delay(retryDelayMs(response, attempt), undefined, { signal });
}

export async function waitForCopilotForbiddenRetry(response, attempt, signal) {
  signal?.throwIfAborted();
  const now = Date.now();
  const scheduledAt = Math.max(
    now + retryDelayMs(response, attempt),
    nextForbiddenRetryAt,
  );
  nextForbiddenRetryAt = scheduledAt + FORBIDDEN_RETRY_SPACING_MS;
  await delay(Math.max(0, scheduledAt - now), undefined, { signal });
}
