const DISPATCHER_SYMBOL = Symbol.for("undici.globalDispatcher.1");
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

class WebSocketHandshakeError extends Error {
  constructor(message, cause, status) {
    super(message, { cause });
    this.name = "WebSocketHandshakeError";
    this.httpStatus = status || null;
  }
}

function observeDispatcher(dispatcher, observeHeaders) {
  if (typeof dispatcher?.dispatch !== "function") return undefined;
  return {
    webSocketOptions: dispatcher.webSocketOptions,
    dispatch(options, handler) {
      const methods = new Map();
      const observed = new Proxy(handler, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== "function") return value;
          if (!methods.has(key)) methods.set(key, function (...args) {
            if (key === "onHeaders" || key === "onUpgrade") {
              observeHeaders(args[0], args[1]);
            }
            return Reflect.apply(value, target, args);
          });
          return methods.get(key);
        },
      });
      return dispatcher.dispatch(options, observed);
    },
  };
}

function responseHeaders(raw) {
  const headers = new Headers();
  if (Array.isArray(raw)) {
    for (let index = 0; index + 1 < raw.length; index += 2) {
      const text = value => Buffer.isBuffer(value) ? value.toString("latin1") : String(value);
      headers.append(text(raw[index]), text(raw[index + 1]));
    }
  } else if (raw) {
    for (const [name, value] of new Headers(raw)) headers.append(name, value);
  }
  return headers;
}

async function openResponsesWebSocket(url, payload, {
  headers, signal, WebSocketImpl, dispatcher,
  handshakeTimeoutMs, maxBufferedBytes,
}) {
  signal?.throwIfAborted();
  let headerStatus = null;
  let upstreamHeaders = new Headers();
  // Observe the actual upgrade headers without changing the shared dispatcher.
  const observedDispatcher = observeDispatcher(dispatcher, (status, raw) => {
    headerStatus = status;
    upstreamHeaders = responseHeaders(raw);
  });
  let socket;
  try {
    socket = new WebSocketImpl(url, {
      headers, ...(observedDispatcher ? { dispatcher: observedDispatcher } : {}),
    });
  } catch (error) {
    throw new WebSocketHandshakeError("Could not construct the upstream WebSocket.", error);
  }
  socket.binaryType = "arraybuffer";
  let opened = false;
  let ended = false;
  let disposed = false;
  let failure = null;
  let closeDetails = null;
  let queuedBytes = 0;
  let wake = null;
  let timer;
  const queue = [];
  let resolveOpen;
  let rejectOpen;
  const connected = new Promise((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  const notify = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  const closeSocket = () => {
    if (socket.readyState === 0 || socket.readyState === 1) socket.close();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    socket.removeEventListener("open", onOpen);
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    closeSocket();
    queue.length = 0;
    queuedBytes = 0;
    ended = true;
    notify();
  };
  const fail = error => {
    failure ||= error;
    ended = true;
    if (!opened) rejectOpen(error);
    notify();
    closeSocket();
  };
  const onOpen = () => {
    opened = true;
    clearTimeout(timer);
    resolveOpen();
  };
  const onMessage = event => {
    if (disposed || ended) return;
    try {
      const text = typeof event.data === "string" ? event.data
        : new TextDecoder("utf-8", { fatal: true }).decode(event.data);
      const frame = Buffer.from(`data: ${text.split(/\r\n|\r|\n/).join("\ndata: ")}\n\n`);
      if (frame.length > maxBufferedBytes || queuedBytes + frame.length > maxBufferedBytes) {
        throw Object.assign(new Error("The upstream WebSocket exceeded the Responses streaming buffer limit."),
          { code: "upstream_websocket_buffer_limit" });
      }
      queue.push(frame);
      queuedBytes += frame.length;
      notify();
    } catch (error) {
      fail(error);
    }
  };
  const onError = event => {
    const cause = event.error instanceof Error ? event.error : undefined;
    fail(opened
      ? new Error("The upstream Responses WebSocket failed.", { cause })
      : new WebSocketHandshakeError("The upstream Responses WebSocket handshake failed.", cause, headerStatus));
  };
  const onClose = event => {
    closeDetails = {
      code: Number.isInteger(event.code) ? event.code : null,
      wasClean: typeof event.wasClean === "boolean" ? event.wasClean : null,
      reasonBytes: typeof event.reason === "string" ? Buffer.byteLength(event.reason) : null,
    };
    ended = true;
    if (!opened) rejectOpen(new WebSocketHandshakeError(
      "The upstream WebSocket closed before its handshake completed.", undefined, headerStatus,
    ));
    notify();
  };
  const onAbort = () => {
    fail(signal.reason || new Error("The Responses request was cancelled."));
    dispose();
  };
  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  signal?.addEventListener("abort", onAbort, { once: true });
  timer = setTimeout(() => fail(new WebSocketHandshakeError(
    "The upstream Responses WebSocket handshake timed out.", undefined, headerStatus,
  )), handshakeTimeoutMs);
  timer.unref?.();
  let sendingInference = false;
  try {
    if (signal?.aborted) onAbort();
    await connected;
    signal?.throwIfAborted();
    const request = { ...JSON.parse(payload), type: "response.create" };
    delete request.stream;
    sendingInference = true;
    socket.send(JSON.stringify(request));
  } catch (error) {
    dispose();
    if (sendingInference) {
      const failure = new Error(error?.message || "The upstream WebSocket send failed.", { cause: error });
      failure.responsesInferenceStarted = true;
      failure.upstreamHandshakeHttpStatus = headerStatus;
      failure.providerRequestId = upstreamHeaders.get("x-github-request-id");
      failure.serviceRequestId = upstreamHeaders.get("x-copilot-service-request-id");
      throw failure;
    }
    throw error;
  }
  upstreamHeaders.set("content-type", "text/event-stream");
  const body = {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          signal?.throwIfAborted();
          if (queue.length) {
            const frame = queue.shift();
            queuedBytes -= frame.length;
            yield frame;
          } else if (failure) {
            throw failure;
          } else if (ended) {
            return;
          } else {
            await new Promise(resolve => { wake = resolve; });
          }
        }
      } finally {
        dispose();
      }
    },
  };
  return {
    ok: true, status: 200, headers: upstreamHeaders, body, handshakeStatus: headerStatus,
    get upstreamWebSocketClose() { return closeDetails; },
  };
}

export async function fetchResponsesUpstream({
  api, headers, payload, signal, preferWebSocket = false,
  fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket,
  dispatcher = globalThis[DISPATCHER_SYMBOL],
  handshakeTimeoutMs = 30000, maxBufferedBytes = MAX_BUFFERED_BYTES,
}) {
  signal?.throwIfAborted();
  let fallback = null;
  const body = preferWebSocket ? JSON.parse(payload) : null;
  // Each full-history request owns a socket; continuation IDs may depend on
  // state from an earlier transport, so retain their existing HTTP contract.
  const websocketEligible = preferWebSocket && typeof WebSocketImpl === "function" &&
    body.stream !== false && !Object.hasOwn(body, "background") && !Object.hasOwn(body, "type") &&
    body.previous_response_id == null;
  if (websocketEligible) {
    const url = new URL(`${api}/responses`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    try {
      const response = await openResponsesWebSocket(url.href, payload, {
        headers, signal, WebSocketImpl, dispatcher, handshakeTimeoutMs, maxBufferedBytes,
      });
      return { response, transport: "websocket", fallback: null };
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof WebSocketHandshakeError)) throw error;
      // HTTP fallback is safe only before any response.create was sent.
      fallback = { code: error.name, httpStatus: error.httpStatus };
    }
  }
  const response = await fetchImpl(`${api}/responses`, {
    method: "POST", headers, body: payload, duplex: "half", signal,
  });
  return { response, transport: "http", fallback };
}
