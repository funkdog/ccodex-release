const RESPONSE_EVENTS = new Set([
  "codex-copilot-account-response",
  "codex-copilot-session-response",
  "codex-copilot-desktop-update-response",
]);

export async function connectCdp(
  url,
  {
    WebSocketImpl = globalThis.WebSocket,
    timeoutMs = 10000,
    signal,
    onEvent = () => {},
  } = {},
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("CDP timeout must be a positive finite number");
  }
  signal?.throwIfAborted();
  const socket = new WebSocketImpl(url);
  const pending = new Map();
  const lifetime = new AbortController();
  let nextId = 1;
  let closeReason = null;
  let connectTimer;
  let resolveReady;
  let rejectReady;
  let resolveClosed;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  function close(reason = new Error("CDP connection closed")) {
    if (closeReason) return;
    closeReason = reason instanceof Error ? reason : new Error(String(reason));
    clearTimeout(connectTimer);
    signal?.removeEventListener("abort", onAbort);
    for (const [type, listener] of Object.entries(listeners)) {
      socket.removeEventListener(type, listener);
    }
    rejectReady(closeReason);
    for (const command of pending.values()) {
      clearTimeout(command.timer);
      command.reject(closeReason);
    }
    pending.clear();
    lifetime.abort(closeReason);
    try {
      if (socket.readyState < 2) socket.close();
    } catch {
      /* The transport may already be gone. */
    }
    resolveClosed(closeReason);
  }

  function send(method, params = {}, responseOnly = false) {
    if (closeReason) return Promise.reject(closeReason);
    if (socket.readyState !== 1) {
      close(new Error("CDP connection is not open"));
      return Promise.reject(closeReason);
    }
    return new Promise((resolve, reject) => {
      const id = nextId++;
      // Ordinary commands retain fail-closed semantics. A response event has
      // already completed its upstream operation and must never be replayed;
      // delayed renderer acknowledgement must not retire other live bindings.
      const timer = setTimeout(() => {
        const error = new Error(`CDP ${method} timeout`);
        if (responseOnly) {
          pending.delete(id);
          reject(error);
        } else close(error);
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        close(error);
      }
    });
  }

  const session = {
    url,
    send(method, params) {
      return send(method, params);
    },
    close,
    closed,
    signal: lifetime.signal,
    evaluate(expression) {
      return evaluateInSession(session, expression);
    },
    async dispatchResponse(event, detail) {
      if (!RESPONSE_EVENTS.has(event) || !detail || typeof detail !== "object" ||
          typeof detail.id !== "string" || !detail.id || detail.id.length > 128) {
        throw new Error("Invalid private Desktop response event");
      }
      const payload = JSON.stringify(detail);
      if (payload.length > 8 * 1024 * 1024 || pending.size >= 64) {
        throw new Error("Desktop response delivery exceeds its bounded capacity");
      }
      const result = await send("Runtime.evaluate", {
        expression: `globalThis.dispatchEvent(new CustomEvent(${JSON.stringify(event)}, ` +
          `{detail:${payload}}))`,
        returnByValue: true,
      }, true);
      return evaluationValue(result);
    },
    get active() {
      return closeReason === null && socket.readyState === 1;
    },
  };
  function onAbort() {
    close(signal.reason || new Error("CDP connection aborted"));
  }
  const listeners = {
    open() {
      clearTimeout(connectTimer);
      resolveReady(session);
    },
    message(event) {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;
      const command = pending.get(message.id);
      if (command) {
        pending.delete(message.id);
        clearTimeout(command.timer);
        if (message.error) {
          command.reject(new Error(message.error.message || "CDP command failed"));
        } else {
          command.resolve(message.result);
        }
      } else if (typeof message.method === "string") {
        try {
          onEvent(message, session);
        } catch (error) {
          close(error);
        }
      }
    },
    error() {
      close(new Error("CDP socket error"));
    },
    close() {
      close(new Error("CDP connection closed before the next response"));
    },
  };
  for (const [type, listener] of Object.entries(listeners)) {
    socket.addEventListener(type, listener);
  }
  connectTimer = setTimeout(() => {
    close(new Error("CDP connection timeout"));
  }, timeoutMs);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return ready;
}

async function evaluateInSession(session, expression) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  return evaluationValue(result);
}

function evaluationValue(result) {
  const detail = result?.exceptionDetails;
  if (detail) {
    throw new Error(detail.exception?.description || detail.text || "evaluation failed");
  }
  return result?.result?.value;
}

export async function evaluate(url, expression, options) {
  const session = await connectCdp(url, options);
  try {
    return await session.evaluate(expression);
  } finally {
    session.close();
  }
}

export async function reloadPage(url, options) {
  const session = await connectCdp(url, options);
  try {
    await session.send("Page.reload", { ignoreCache: true });
    return "reloading";
  } finally {
    session.close();
  }
}

export class CdpTargetSessions {
  sessions = new Map();

  get(id) {
    const session = this.sessions.get(id);
    if (session && !session.active) {
      this.delete(id);
      return undefined;
    }
    return session;
  }

  has(id) {
    return Boolean(this.get(id));
  }

  set(id, session) {
    if (!session.active) throw new Error("Cannot retain a closed CDP session");
    if (this.sessions.get(id) === session) return;
    this.delete(id);
    this.sessions.set(id, session);
    session.closed.then(() => {
      // A delayed close from the previous renderer must not remove its replacement.
      if (this.sessions.get(id) === session) this.sessions.delete(id);
    });
  }

  delete(id) {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    session?.close();
  }

  retain(targets) {
    const current = new Map(targets.map((target) => [target.id, target.webSocketDebuggerUrl]));
    for (const [id, session] of this.sessions) {
      if (!session.active || current.get(id) !== session.url) this.delete(id);
    }
  }

  close() {
    for (const id of this.sessions.keys()) this.delete(id);
  }
}
