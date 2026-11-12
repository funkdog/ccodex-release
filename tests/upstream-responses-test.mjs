import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fetchResponsesUpstream } from "../bridge/upstream-responses.mjs";
import { forwardResponsesStream, ResponsesStreamError } from "../bridge/responses-stream.mjs";
import { websocketUpstream } from "./fixtures/websocket-upstream.mjs";
import { responsesBridge } from "./fixtures/responses-bridge.mjs";

const input = [{
  type: "message", role: "user",
  content: [{ type: "input_text", text: "SYNTHETIC_RETAINED_TASK" }],
}];
const request = {
  model: "synthetic-model", stream: true, store: false,
  reasoning: { effort: "max", summary: "detailed" },
  input, tools: [{ type: "function", name: "synthetic_tool", parameters: { type: "object" } }],
  include: ["reasoning.encrypted_content"],
  future_native_capability: { preserve: true },
};
const headers = { authorization: "Bearer synthetic-credential", "content-type": "application/json" };
const created = { type: "response.created", response: { id: "resp_synthetic" } };
const completed = {
  type: "response.completed", response: {
    id: "resp_synthetic", status: "completed",
    usage: { input_tokens: 900, output_tokens: 12, total_tokens: 912 },
  },
};
const parse = text => text.split(/\r\n\r\n|\n\n/).flatMap(frame => {
  const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart()).join("\n");
  try { return [JSON.parse(data)]; } catch { return []; }
});

function fixture({ autoOpen = true, handshakeError = false, onSend, onConstruct } = {}) {
  const sockets = [];
  const httpRequests = [];
  class Socket extends EventTarget {
    readyState = 0;
    sent = [];
    closes = 0;
    listeners = new Map();
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      sockets.push(this);
      onConstruct?.(this);
      queueMicrotask(() => {
        if (handshakeError) this.fail(new Error("SYNTHETIC_HANDSHAKE_FAILURE"));
        else if (autoOpen) this.open();
      });
    }
    addEventListener(name, listener, options) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(listener);
      super.addEventListener(name, listener, options);
    }
    removeEventListener(name, listener, options) {
      this.listeners.get(name)?.delete(listener);
      super.removeEventListener(name, listener, options);
    }
    open() {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }
    send(value) {
      assert.equal(this.readyState, 1);
      this.sent.push(JSON.parse(value));
      onSend?.(this);
    }
    message(value, binary = false, pretty = false) {
      const text = JSON.stringify(value, null, pretty ? 2 : undefined);
      const event = new Event("message");
      event.data = binary ? new TextEncoder().encode(text) : text;
      this.dispatchEvent(event);
    }
    fail(error) {
      const event = new Event("error");
      event.error = error;
      this.dispatchEvent(event);
    }
    close(details = {}) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.closes += 1;
      this.dispatchEvent(Object.assign(new Event("close"), details));
    }
  }
  return {
    sockets, httpRequests, WebSocketImpl: Socket,
    async fetchImpl(url, options) {
      httpRequests.push({ url, ...options });
      return new Response(JSON.stringify({ error: { code: "synthetic_http_error" } }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    },
  };
}

function connect(f, overrides = {}) {
  return fetchResponsesUpstream({
    api: "https://synthetic.invalid", headers, payload: JSON.stringify(request),
    preferWebSocket: true, ...f, ...overrides,
  });
}

async function forward(response) {
  const destination = new PassThrough();
  let text = "";
  destination.on("data", bytes => { text += bytes.toString(); });
  try {
    await forwardResponsesStream(response.body, destination, {
      identity: { async normalize(event) { return event; } }, heartbeatMs: 0,
    });
    return parse(text);
  } finally {
    destination.destroy();
  }
}

test("WebSocket changes only the wire envelope and preserves MAX, complete history and native capabilities", async () => {
  const history = [
    ...input,
    { type: "reasoning", id: "opaque-reasoning", encrypted_content: "SYNTHETIC_ENCRYPTED", summary: [] },
    { type: "function_call", id: "opaque-call", call_id: "call_original",
      name: "synthetic_tool", arguments: "{}" },
    { type: "function_call_output", call_id: "call_original", output: "x".repeat(22 * 1024 * 1024) },
  ];
  const body = { ...request, input: history };
  const f = fixture({ onSend(socket) { socket.message(created); socket.message(completed); } });
  const result = await connect(f, { payload: JSON.stringify(body) });
  const expected = { ...body, type: "response.create" };
  delete expected.stream;
  assert.deepEqual(f.sockets[0].sent, [expected]);
  assert.deepEqual(f.sockets[0].options.headers, headers);
  assert.equal(Object.hasOwn(f.sockets[0].sent[0], "max_output_tokens"), false);
  assert.equal(result.transport, "websocket");
  assert.deepEqual(await forward(result.response), [created, completed]);
  assert.equal(f.sockets[0].closes, 1);
  assert.equal(f.httpRequests.length, 0);
});

test("binary, pretty-printed, unknown and repeated provider events retain their exact values", async () => {
  const events = [
    created, null, 42, { type: "future.native.event", detail: "keep\r\nall\nlines" },
    { type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "SYNTHETIC" } },
    { type: "response.output_text.delta", delta: "SYNTHETIC_REPEAT" },
    { type: "response.output_text.delta", delta: "SYNTHETIC_REPEAT" },
    completed,
  ];
  const f = fixture({ onSend(socket) {
    for (const event of events) socket.message(event, true, true);
  } });
  const result = await connect(f);
  assert.deepEqual(await forward(result.response), events);
  assert.equal(f.sockets[0].closes, 1);
  assert.equal([...f.sockets[0].listeners.values()].reduce((count, values) => count + values.size, 0), 0);
});

test("upgrade observation retains provider and quota headers without rebinding handler methods", async () => {
  let owner;
  const dispatcher = {
    dispatch(_options, handler) {
      handler.onUpgrade(101, [
        Buffer.from("x-github-request-id"), Buffer.from("SYNTHETIC_REQUEST_ID"),
        Buffer.from("x-copilot-service-request-id"), Buffer.from("SYNTHETIC_SERVICE_ID"),
        Buffer.from("x-synthetic-quota"), Buffer.from("123"),
      ]);
      return true;
    },
  };
  const f = fixture({
    onConstruct(socket) {
      owner = {
        onUpgrade() { assert.equal(this, owner); },
      };
      socket.options.dispatcher.dispatch({}, owner);
    },
    onSend(socket) { socket.message(completed); },
  });
  const result = await connect(f, { dispatcher });
  assert.equal(result.response.headers.get("x-github-request-id"), "SYNTHETIC_REQUEST_ID");
  assert.equal(result.response.headers.get("x-copilot-service-request-id"), "SYNTHETIC_SERVICE_ID");
  assert.equal(result.response.headers.get("x-synthetic-quota"), "123");
  await forward(result.response);
});

test("one-hour reasoning keeps the same WebSocket without deadlines, checkpoints or replay", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const result = await connect(f);
  t.mock.timers.tick(3600000);
  const socket = f.sockets[0];
  assert.equal(socket.readyState, 1);
  assert.equal(socket.sent.length, 1);
  socket.message(created);
  socket.message(completed);
  assert.deepEqual(await forward(result.response), [created, completed]);
  assert.equal(f.httpRequests.length, 0);
});

test("only a failed handshake may fall back, retaining the exact HTTP payload and credential", async () => {
  const f = fixture({ handshakeError: true });
  const result = await connect(f);
  assert.equal(result.transport, "http");
  assert.equal(result.response.status, 401);
  assert.equal(result.fallback.code, "WebSocketHandshakeError");
  assert.equal(f.sockets[0].sent.length, 0);
  assert.equal(f.httpRequests.length, 1);
  assert.equal(f.httpRequests[0].body, JSON.stringify(request));
  assert.deepEqual(f.httpRequests[0].headers, headers);
});

test("a handshake timeout sends no inference before native HTTP fallback", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ autoOpen: false });
  const pending = connect(f, { handshakeTimeoutMs: 50 });
  t.mock.timers.tick(51);
  const result = await pending;
  assert.equal(result.transport, "http");
  assert.equal(f.sockets[0].sent.length, 0);
  assert.equal(f.sockets[0].closes, 1);
  assert.equal(f.httpRequests.length, 1);
});

test("cancellation before connection or during handshake never starts HTTP fallback", async () => {
  const cancelled = new AbortController();
  cancelled.abort(new Error("SYNTHETIC_CANCELLED_BEFORE_START"));
  const first = fixture();
  await assert.rejects(connect(first, { signal: cancelled.signal }), /SYNTHETIC_CANCELLED_BEFORE_START/);
  assert.equal(first.sockets.length, 0);
  assert.equal(first.httpRequests.length, 0);
  const controller = new AbortController();
  const second = fixture({ autoOpen: false });
  const pending = connect(second, { signal: controller.signal });
  controller.abort(new Error("SYNTHETIC_CANCELLED_DURING_HANDSHAKE"));
  await assert.rejects(pending, /SYNTHETIC_CANCELLED_DURING_HANDSHAKE/);
  assert.equal(second.httpRequests.length, 0);
  assert.equal(second.sockets[0].sent.length, 0);
  assert.equal(second.sockets[0].closes, 1);
});

test("cancellation of a quiet active response closes its socket and releases the blocked reader", async () => {
  const controller = new AbortController();
  const f = fixture();
  const result = await connect(f, { signal: controller.signal });
  const reader = result.response.body[Symbol.asyncIterator]();
  const next = reader.next();
  controller.abort(new Error("SYNTHETIC_CANCELLED_ACTIVE_RESPONSE"));
  await assert.rejects(next, /SYNTHETIC_CANCELLED_ACTIVE_RESPONSE/);
  assert.equal(f.sockets[0].closes, 1);
  assert.equal(f.httpRequests.length, 0);
});

test("a post-send transport error never replays inference through HTTP", async () => {
  const f = fixture();
  const result = await connect(f);
  f.sockets[0].fail(new Error("SYNTHETIC_PEER_FAILURE"));
  await assert.rejects(forward(result.response), /upstream Responses WebSocket failed/);
  assert.equal(f.sockets[0].sent.length, 1);
  assert.equal(f.httpRequests.length, 0);
});

test("an ambiguous synchronous WebSocket send failure is marked so the bridge cannot replay it", async () => {
  const f = fixture({ onSend() {
    throw Object.assign(new Error("SYNTHETIC_AMBIGUOUS_SEND"), { code: "UND_ERR_SOCKET" });
  } });
  await assert.rejects(connect(f), error => error.responsesInferenceStarted === true
    && error.message === "SYNTHETIC_AMBIGUOUS_SEND" && error.cause.code === "UND_ERR_SOCKET");
  assert.equal(f.sockets[0].sent.length, 1);
  assert.equal(f.sockets[0].closes, 1);
  assert.equal(f.httpRequests.length, 0);
});

test("EOF after reasoning is an incomplete stream, never fabricated completion or usage", async () => {
  const f = fixture({ onSend(socket) {
    socket.message(created);
    socket.message({ type: "response.output_item.done", item: { type: "reasoning", summary: [] } });
    socket.close({ code: 1008, wasClean: true, reason: "SYNTHETIC_PRIVATE_PROVIDER_DETAIL" });
  } });
  const result = await connect(f);
  assert.deepEqual(result.response.upstreamWebSocketClose, {
    code: 1008, wasClean: true, reasonBytes: Buffer.byteLength("SYNTHETIC_PRIVATE_PROVIDER_DETAIL"),
  });
  assert.equal(Object.hasOwn(result.response.upstreamWebSocketClose, "reason"), false);
  await assert.rejects(forward(result.response), ResponsesStreamError);
  assert.equal(f.httpRequests.length, 0);
  assert.equal(Object.hasOwn(result.response, "usage"), false);
});

test("provider parameter and context errors stay real events without HTTP fallback", async () => {
  const event = {
    type: "error", status: 400,
    error: { code: "context_length_exceeded", message: "SYNTHETIC_CONTEXT_LIMIT", param: "input" },
  };
  const f = fixture({ onSend(socket) { socket.message(event); } });
  const result = await connect(f);
  assert.deepEqual(await forward(result.response), [event]);
  assert.equal(f.httpRequests.length, 0);
});

test("buffer overflow fails explicitly without trimming output or silently retrying", async () => {
  const f = fixture({ onSend(socket) {
    socket.message({ type: "future.native.event", text: "x".repeat(1000) });
  } });
  const result = await connect(f, { maxBufferedBytes: 128 });
  await assert.rejects(forward(result.response), /streaming buffer limit/);
  assert.equal(f.httpRequests.length, 0);
  assert.equal(f.sockets[0].closes, 1);
});

test("HTTP-only, non-streaming, background and prior-response continuation keep the HTTP contract", async () => {
  for (const options of [
    { preferWebSocket: false },
    { WebSocketImpl: undefined },
    { payload: JSON.stringify({ ...request, stream: false }) },
    { payload: JSON.stringify({ ...request, background: true }) },
    { payload: JSON.stringify({ ...request, background: false }) },
    { payload: JSON.stringify({ ...request, type: "future_http_type" }) },
    { payload: JSON.stringify({ ...request, previous_response_id: "resp_existing" }) },
  ]) {
    const f = fixture();
    if (Object.hasOwn(options, "WebSocketImpl")) options.WebSocketImpl = null;
    const result = await connect(f, options);
    assert.equal(result.transport, "http");
    assert.equal(result.fallback, null);
    assert.equal(f.sockets.length, 0);
    assert.equal(f.httpRequests.length, 1);
    assert.equal(f.httpRequests[0].body, options.payload || JSON.stringify(request));
  }
});

test("the actual Node WebSocket carries authentication and exposes real upgrade headers", async () => {
  const peers = new Set();
  const requests = [];
  let observedAuthorization;
  const server = http.createServer((_req, res) => res.end("SYNTHETIC_SEED"));
  const encode = event => {
    const data = Buffer.from(JSON.stringify(event));
    assert.ok(data.length < 126);
    return Buffer.concat([Buffer.from([0x81, data.length]), data]);
  };
  server.on("upgrade", (req, socket) => {
    peers.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => peers.delete(socket));
    observedAuthorization = req.headers.authorization;
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`, "X-GitHub-Request-Id: SYNTHETIC_REAL_UPGRADE_ID", "", "",
    ].join("\r\n"));
    let buffer = Buffer.alloc(0);
    socket.on("data", data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 6) {
        const opcode = buffer[0] & 15;
        let size = buffer[1] & 127;
        let offset = 2;
        if (size === 126) {
          if (buffer.length < 8) return;
          size = buffer.readUInt16BE(2);
          offset = 4;
        }
        assert.notEqual(size, 127, "The small real transport fixture must not receive an unbounded payload.");
        const masked = (buffer[1] & 128) !== 0;
        assert.equal(masked, true);
        if (buffer.length < offset + 4 + size) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + size));
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
        buffer = buffer.subarray(offset + 4 + size);
        if (opcode === 8) {
          socket.end(Buffer.concat([Buffer.from([0x88, payload.length]), payload]));
          return;
        }
        requests.push(JSON.parse(payload.toString("utf8")));
        socket.write(encode(created));
        socket.write(encode({ type: "response.completed", response: { id: "resp_synthetic", status: "completed" } }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const api = `http://127.0.0.1:${server.address().port}`;
  try {
    await (await fetch(api)).text();
    const result = await fetchResponsesUpstream({
      api, headers, payload: JSON.stringify(request), preferWebSocket: true,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(result.transport, "websocket");
    assert.equal(observedAuthorization, headers.authorization);
    assert.equal(result.response.headers.get("x-github-request-id"), "SYNTHETIC_REAL_UPGRADE_ID");
    assert.equal((await forward(result.response)).at(-1).type, "response.completed");
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].reasoning, request.reasoning);
  } finally {
    for (const peer of peers) peer.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("cancelling an actual quiet Node WebSocket releases its reader and its TCP connection", async () => {
  const errors = [];
  const server = http.createServer((_req, res) => res.end("SYNTHETIC_SEED"));
  const upstream = websocketUpstream(server, (_req, peer) => peer.send(created), error => errors.push(error));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const api = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  try {
    await (await fetch(api)).text();
    const result = await fetchResponsesUpstream({
      api, headers, payload: JSON.stringify(request), preferWebSocket: true, signal: controller.signal,
    });
    const reader = result.response.body[Symbol.asyncIterator]();
    assert.equal((await reader.next()).done, false);
    assert.equal(upstream.activeSockets, 1);
    const pending = reader.next();
    controller.abort(new Error("SYNTHETIC_REAL_CONNECTION_CANCELLED"));
    await assert.rejects(pending, /SYNTHETIC_REAL_CONNECTION_CANCELLED/);
    const deadline = Date.now() + 2000;
    while (upstream.activeSockets) {
      assert.ok(Date.now() < deadline, "Cancellation left its real upstream TCP connection open.");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(errors, []);
  } finally {
    controller.abort();
    upstream.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("an actual warmed Node WebSocket preserves a 22 MiB history through a quiet post-upgrade interval", async () => {
  const body = {
    ...request,
    input: [...input,
      { type: "function_call", id: "synthetic-large-call", call_id: "synthetic-large-call",
        name: "synthetic_tool", arguments: "{}" },
      { type: "function_call_output", call_id: "synthetic-large-call", output: "x".repeat(22 * 1024 * 1024) },
    ],
  };
  const payload = JSON.stringify(body);
  const expectedHash = createHash("sha256").update(JSON.stringify(body.input)).digest("hex");
  const errors = [];
  let requests = 0;
  let providerTimer;
  const server = http.createServer((_req, res) => res.end("SYNTHETIC_HTTP_WARMUP"));
  server.keepAliveTimeout = 15000;
  const upstream = websocketUpstream(server, (req, peer, received) => {
    requests += 1;
    assert.equal(req.headers.authorization, headers.authorization);
    assert.equal(received.reasoning.effort, "max");
    assert.equal(createHash("sha256").update(JSON.stringify(received.input)).digest("hex"), expectedHash);
    providerTimer = setTimeout(() => {
      if (!peer.closed) {
        peer.send(created);
        peer.send(completed);
      }
    }, 18000);
  }, error => errors.push(error));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const api = `http://127.0.0.1:${server.address().port}`;
  try {
    await (await fetch(api)).text();
    const startedAt = Date.now();
    const result = await fetchResponsesUpstream({
      api, headers, payload, preferWebSocket: true, signal: AbortSignal.timeout(35000),
    });
    assert.equal(result.transport, "websocket");
    assert.equal(result.response.handshakeStatus, 101);
    assert.deepEqual(await forward(result.response), [created, completed]);
    assert.ok(Date.now() - startedAt >= 18000, "The quiet interval was not actually exercised.");
    assert.equal(requests, 1);
    assert.deepEqual(errors, []);
  } finally {
    clearTimeout(providerTimer);
    upstream.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("the production bridge never replays a sent WebSocket inference after EOF before its first event", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-ws-no-replay-"));
  const bridge = await responsesBridge(home, t, () => {
    assert.fail("A sent WebSocket inference must not fall back to HTTP.");
  }, { websocketResponder(_req, peer) { peer.close(); } });
  try {
    const response = await fetch(`${bridge.url}/responses`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
      signal: AbortSignal.timeout(10000),
    });
    const events = parse(await response.text());
    assert.equal(events.at(-1).type, "response.failed");
    assert.equal(events.at(-1).response.error.code, "upstream_stream_incomplete");
    assert.equal(bridge.requests.length, 1, "No new socket or HTTP replay after response.create.");
    const deadline = Date.now() + 5000;
    let audit;
    for (;;) {
      audit = JSON.parse(fs.readFileSync(path.join(bridge.profile, "request-audit-latest.json"), "utf8"));
      if (audit.status !== "started") break;
      assert.ok(Date.now() < deadline, "The production audit did not settle after the incomplete stream.");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(audit.status, "incomplete");
    assert.equal(audit.upstreamTransport, "websocket");
    assert.equal(audit.attempts, 1);
    assert.equal(audit.eventsForwarded, 0);
    assert.equal(audit.usage, null);
    assert.deepEqual(audit.upstreamWebSocketClose, { code: 1005, wasClean: true, reasonBytes: 0 });
    assert.equal(bridge.requests.length, 1, "Settling the audit must not replay the sent inference.");
  } finally {
    await bridge.close();
    assert.equal(path.dirname(fs.realpathSync(home)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test("the production bridge preserves the HTTP contract for a prior-response continuation before sanitization", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-ws-http-contract-"));
  const body = {
    ...request, previous_response_id: "resp_synthetic_previous",
    input: [...input, {
      type: "reasoning", summary: [], encrypted_content: "SYNTHETIC_RETAINED_REASONING",
    }],
  };
  let httpRequests = 0;
  const bridge = await responsesBridge(home, t, (_req, res, received) => {
    httpRequests += 1;
    const expected = { ...body };
    delete expected.previous_response_id;
    assert.deepEqual(received, expected, "Retain the existing sanitized HTTP payload and full history.");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([created, completed].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  }, { websocketResponder(_req, peer) { peer.close(); } });
  try {
    const response = await fetch(`${bridge.url}/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    assert.equal(parse(await response.text()).at(-1).type, "response.completed");
    assert.equal(httpRequests, 1, "A prior-response continuation must not move to a new WebSocket.");
    assert.equal(bridge.requests.length, 1);
    assert.equal(Object.hasOwn(bridge.requests[0], "type"), false);
  } finally {
    await bridge.close();
    const resolved = fs.realpathSync(home);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("ccodex-ws-http-contract-"));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
