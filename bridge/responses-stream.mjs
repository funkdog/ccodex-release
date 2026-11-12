import { once } from "node:events";

const TERMINAL_EVENTS = new Set(["response.completed", "response.failed", "response.incomplete", "error"]);
const HEARTBEAT = 'event: ping\ndata: {"type":"ping"}\n\n';

export class ResponsesStreamError extends Error {
  constructor(message) {
    super(message);
    this.name = "ResponsesStreamError";
    this.code = "upstream_stream_incomplete";
  }
}

export async function* readSseFrames(source, maxFrameLength = 64 * 1024 * 1024) {
  const decoder = new TextDecoder();
  let buffer = "";
  let scan = 0;
  let lineStart = 0;
  const extract = function* (final) {
    let consumed = 0;
    while (scan < buffer.length) {
      const character = buffer[scan];
      if (character !== "\r" && character !== "\n") { scan += 1; continue; }
      if (character === "\r" && scan + 1 === buffer.length && !final) break;
      const end = scan + (character === "\r" && buffer[scan + 1] === "\n" ? 2 : 1);
      if (scan === lineStart) {
        if (end - consumed > maxFrameLength) throw new Error("Responses SSE frame exceeds the streaming limit.");
        yield buffer.slice(consumed, end);
        consumed = end;
      }
      lineStart = end;
      scan = end;
    }
    buffer = buffer.slice(consumed);
    scan -= consumed;
    lineStart -= consumed;
    if (buffer.length > maxFrameLength) throw new Error("Responses SSE frame exceeds the streaming limit.");
  };
  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* extract(false);
  }
  buffer += decoder.decode();
  yield* extract(true);
  if (buffer) yield buffer;
}

export async function* normalizeResponsesStream(source, {
  identity, signal, onEvent = () => {}, normalizeEvent = event => event,
  maxFrameLength = 64 * 1024 * 1024,
}) {
  for await (const frame of readSseFrames(source, maxFrameLength)) {
    signal?.throwIfAborted();
    const lines = frame.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g).filter(Boolean);
    const isData = line => /^data(?::|\r|\n|$)/.test(line);
    const data = lines.filter(isData).map(line => line.replace(/[\r\n]+$/, "")
      .replace(/^data(?:: ?)?/, "")).join("\n");
    let event;
    try { event = JSON.parse(data); } catch { yield frame; continue; }
    const normalized = await identity.normalize(normalizeEvent(event));
    signal?.throwIfAborted();
    onEvent(normalized);
    if (normalized === event) { yield frame; continue; }
    let written = false;
    yield lines.map(line => {
      if (normalized?.type !== event?.type && /^event:/.test(line)) {
        const ending = /(?:\r\n|\r|\n)$/.exec(line)?.[0] || "";
        return `event: ${normalized.type}${ending}`;
      }
      if (!isData(line)) return line;
      if (written) return "";
      written = true;
      const ending = /(?:\r\n|\r|\n)$/.exec(line)?.[0] || "";
      return `data: ${JSON.stringify(normalized)}${ending}`;
    }).join("");
  }
}

export function startResponsesHeartbeat(destination, {
  heartbeatMs = 30000, signal, canWrite = () => true,
} = {}) {
  const timer = Number.isSafeInteger(heartbeatMs) && heartbeatMs > 0 ? setInterval(() => {
    if (canWrite() && !signal?.aborted &&
        !destination.destroyed && !destination.writableEnded && !destination.writableNeedDrain) {
      destination.write(HEARTBEAT);
    }
  }, heartbeatMs) : null;
  timer?.unref?.();
  return () => { if (timer) clearInterval(timer); };
}

export async function forwardResponsesStream(source, destination, options) {
  let terminalEvent = null;
  let atFrameBoundary = true;
  const stopHeartbeat = startResponsesHeartbeat(destination, {
    heartbeatMs: options.heartbeatMs, signal: options.signal,
    canWrite: () => atFrameBoundary && !terminalEvent,
  });
  try {
    for await (const frame of normalizeResponsesStream(source, {
      ...options,
      onEvent(event) {
        if (TERMINAL_EVENTS.has(event?.type)) terminalEvent = event.type;
        options.onEvent?.(event);
      },
    })) {
      options.signal?.throwIfAborted();
      if (destination.destroyed) throw new Error("Responses client disconnected.");
      atFrameBoundary = /(?:\r\n\r\n|\r\r\n|\r\n\r|\r\n\n|\n\r\n|\r\r|\n\r|\n\n)$/.test(frame);
      if (!destination.write(frame)) await once(destination, "drain", { signal: options.signal });
      if (terminalEvent) {
        if (!atFrameBoundary) destination.write("\n\n");
        return { terminalEvent };
      }
    }
    options.signal?.throwIfAborted();
    throw new ResponsesStreamError("The upstream Responses stream ended without a terminal event.");
  } finally {
    stopHeartbeat();
  }
}
