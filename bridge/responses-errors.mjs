import { randomUUID } from "node:crypto";

const CONTEXT_CODES = new Set(["context_length_exceeded", "context_window_exceeded"]);
const CONTEXT_MESSAGE = /(?:input exceeds the context window|maximum context length (?:is|of)|context (?:window|length) (?:has been )?exceeded)/i;

export function isContextWindowError(error) {
  return Boolean(error && typeof error === "object" && (
    CONTEXT_CODES.has(error.code) ||
    (typeof error.message === "string" && CONTEXT_MESSAGE.test(error.message))
  ));
}

export function normalizeResponsesError(error) {
  if (!isContextWindowError(error) || error.code === "context_length_exceeded") return error;
  return { ...error, code: "context_length_exceeded" };
}

export function failedResponseEvent(error, { responseId, sequenceNumber } = {}) {
  return {
    type: "response.failed",
    ...(Number.isSafeInteger(sequenceNumber) ? { sequence_number: sequenceNumber } : {}),
    response: {
      id: responseId || `resp_ccodex_${randomUUID().replaceAll("-", "")}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "failed",
      error: normalizeResponsesError(error),
      usage: null,
    },
  };
}

export function normalizeResponsesErrorEvent(event) {
  if (event?.type === "response.failed") {
    const error = normalizeResponsesError(event.response?.error);
    return error === event.response?.error ? event : {
      ...event, response: { ...event.response, error },
    };
  }
  if (event?.type === "error") {
    const error = event.error && typeof event.error === "object" && !Array.isArray(event.error)
      ? event.error : {
        code: event.code || "upstream_error",
        message: event.message || "The upstream Responses stream reported an error.",
      };
    return failedResponseEvent(error, { sequenceNumber: event.sequence_number });
  }
  return event;
}

export function encodeResponseEvent(event) {
  // Separate the failure from an upstream frame that ended without a newline.
  return `\n\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
