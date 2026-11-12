import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  isContextWindowError, normalizeResponsesError, normalizeResponsesErrorEvent,
} from "../bridge/responses-errors.mjs";
import { forwardResponsesStream, ResponsesStreamError } from "../bridge/responses-stream.mjs";
import { readSse } from "../bridge/translate.mjs";
import { encodeEvents, responsesBridge, rotatingEvents } from "./fixtures/responses-bridge.mjs";

const contextError = {
  code: "invalid_request_body", type: "invalid_request_error", param: null,
  message: "Your input exceeds the context window of this model. Please adjust your input and try\nagain.",
};
const identity = { async normalize(event) { return event; } };
const chunks = async function* (...values) { yield* values.map(value => Buffer.from(value)); };
const parse = text => text.split(/\r\n\r\n|\n\n|\r\r/).flatMap(frame => {
  const data = frame.split(/\r\n|\r|\n/).filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart()).join("\n");
  try { return [JSON.parse(data)]; } catch { return []; }
});
function profile(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-responses-recovery-"));
  t.after(async () => {
    const resolved = fs.realpathSync(home);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^ccodex-responses-recovery-/);
    await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  return home;
}
const post = (bridge, extra = {}) => fetch(`${bridge.url}/responses`, {
  method: "POST", headers: { "content-type": "application/json" },
  signal: AbortSignal.timeout(15000),
  body: JSON.stringify({ model: "synthetic-model", input: "SYNTHETIC_PRIVATE_INPUT", stream: true, ...extra }),
});
async function auditAt(bridge, status) {
  const file = path.join(bridge.profile, "request-audit-latest.json");
  const deadline = Date.now() + 5000;
  for (;;) {
    if (fs.existsSync(file)) {
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      if (record.status === status) return record;
    }
    if (Date.now() >= deadline) throw new Error(`Audit did not settle to ${status}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("context normalization recognizes the actual generic error without treating every HTTP 400 as context overflow", () => {
  assert.equal(isContextWindowError(contextError), true);
  assert.deepEqual(normalizeResponsesError(contextError), { ...contextError, code: "context_length_exceeded" });
  for (const error of [
    { code: "invalid_request_body", message: "Invalid tool description: empty string." },
    { code: "invalid_request_body", message: "The requested context window is supported." },
    { code: "forbidden", message: "Access to this endpoint is forbidden." },
    null,
  ]) {
    assert.equal(isContextWindowError(error), false);
    assert.equal(normalizeResponsesError(error), error);
  }
  assert.equal(contextError.code, "invalid_request_body", "provider error must not be mutated");
});

test("failed SSE context normalization preserves partial outputs and unknown fields", () => {
  const original = { type: "response.failed", sequence_number: 4, future: 7, response: {
    id: "resp_partial", error: contextError, usage: null,
    output: [{ type: "reasoning", encrypted_content: "SYNTHETIC_OPAQUE_CONTENT" }],
  } };
  const result = normalizeResponsesErrorEvent(original);
  assert.deepEqual(result, { ...original, response: {
    ...original.response, error: { ...contextError, code: "context_length_exceeded" },
  } });
  const future = { type: "future.provider.event", payload: { code: "context_length_exceeded" } };
  assert.equal(normalizeResponsesErrorEvent(future), future);
});

test("top-level non-context stream errors retain provider details in the native failure protocol", () => {
  for (const error of [
    { code: "rate_limit_exceeded", message: "Synthetic overload", retry_after_ms: 20 },
    { code: "quota_exceeded", message: "Synthetic quota exhausted" },
  ]) {
    const result = normalizeResponsesErrorEvent({ type: "error", error, sequence_number: 2 });
    assert.equal(result.type, "response.failed");
    assert.equal(result.sequence_number, 2);
    assert.deepEqual(result.response.error, error);
    assert.equal(result.response.usage, null);
  }
});

test("forwarding detects premature EOF and never creates a completed response", async t => {
  const destination = new PassThrough();
  t.after(() => destination.destroy());
  const published = [];
  destination.on("data", data => published.push(data.toString("utf8")));
  await assert.rejects(forwardResponsesStream(chunks(encodeEvents([
    { type: "response.created", response: { id: "resp_eof" } },
  ])), destination, { identity, heartbeatMs: 0 }), ResponsesStreamError);
  assert.deepEqual(parse(published.join("")).map(event => event.type), ["response.created"]);
});

test("a final completed frame is dispatched even when the provider omitted its blank line", async t => {
  for (const ending of ["", "\n", "\r", "\r\n"]) {
    const destination = new PassThrough();
    t.after(() => destination.destroy());
    let published = "";
    destination.on("data", data => { published += data.toString("utf8"); });
    await forwardResponsesStream(chunks(
      `data: {"type":"response.completed","response":{"id":"resp_final"}}${ending}`,
    ), destination, { identity, heartbeatMs: 0 });
    assert.match(published, /\n\n$/);
    assert.equal(parse(published)[0].type, "response.completed");
  }
});

test("quiet forwarding emits keepalive events, stops at completion and releases the source", async t => {
  const destination = new PassThrough();
  t.after(() => destination.destroy());
  const published = [];
  destination.on("data", data => published.push(data.toString("utf8")));
  let released = false;
  const source = async function* () {
    try {
      await new Promise(resolve => setTimeout(resolve, 90));
      yield Buffer.from(encodeEvents([{ type: "response.completed", response: { id: "resp_quiet" } }]));
      await new Promise(() => {});
    } finally { released = true; }
  };
  const result = await forwardResponsesStream(source(), destination, { identity, heartbeatMs: 10 });
  assert.deepEqual(result, { terminalEvent: "response.completed" });
  assert.equal(released, true);
  assert.ok(parse(published.join("")).some(event => event.type === "ping"));
  const length = published.length;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(published.length, length, "heartbeat must not outlive completion");
});

test("keepalive respects downstream backpressure while the upstream is quiet", async t => {
  const destination = new PassThrough({ highWaterMark: 1 });
  t.after(() => destination.destroy());
  destination.write("occupied");
  let writes = 0;
  const write = destination.write.bind(destination);
  destination.write = (...args) => { writes += 1; return write(...args); };
  const controller = new AbortController();
  const source = async function* () {
    await new Promise(resolve => setTimeout(resolve, 70));
    controller.abort();
  };
  await assert.rejects(forwardResponsesStream(source(), destination, {
    identity, heartbeatMs: 10, signal: controller.signal,
  }), { name: "AbortError" });
  assert.equal(writes, 0, "backpressure must suppress timer writes");
});

for (const stream of [true, false]) {
  test(`HTTP context overflow activates the right protocol for stream=${stream} without retrying or truncating history`, async t => {
    const originalInput = [{ type: "message", role: "user", content: [
      { type: "input_text", text: "SYNTHETIC_PRIVATE_INPUT" },
    ] }];
    const bridge = await responsesBridge(profile(t), t, async (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: contextError }));
    });
    try {
      const response = await post(bridge, { stream, input: originalInput });
      assert.equal(response.status, stream ? 200 : 400);
      const text = await response.text();
      const error = stream ? parse(text).at(-1).response.error : JSON.parse(text).error;
      assert.equal(error.code, "context_length_exceeded");
      assert.equal(error.message, contextError.message);
      assert.equal(bridge.requests.length, 1);
      assert.deepEqual(bridge.requests[0].input, originalInput);
      const audit = await auditAt(bridge, "error");
      assert.equal(audit.httpStatus, 400);
      assert.equal(audit.error.upstreamCode, "invalid_request_body");
      assert.equal(audit.error.code, "context_length_exceeded");
      assert.equal(JSON.stringify(audit).includes("SYNTHETIC_PRIVATE_INPUT"), false);
    } finally { await bridge.close(); }
  });
}

test("unrelated invalid request retains HTTP 400 and is not retried", async t => {
  const error = { code: "invalid_request_body", message: "Invalid tool description: empty string." };
  const bridge = await responsesBridge(profile(t), t, async (_req, res) => {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error }));
  });
  try {
    const response = await post(bridge);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, error.code);
    assert.equal(bridge.requests.length, 1);
  } finally { await bridge.close(); }
});

test("bridge retries EOF only before provider events have been published", async t => {
  const events = rotatingEvents("resp_retry");
  const bridge = await responsesBridge(profile(t), t, async (_req, res, _body, number) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(number === 1 ? ": upstream keepalive\n\n" : encodeEvents(events));
  });
  try {
    const received = parse(await (await post(bridge)).text()).filter(event => event.type !== "ping");
    assert.deepEqual(received.map(event => event.type), events.map(event => event.type));
    assert.equal(bridge.requests.length, 2);
    assert.equal((await auditAt(bridge, "complete")).attempts, 2);
  } finally { await bridge.close(); }
});

test("a mid-stream socket close becomes an explicit failure without replaying partial output", async t => {
  const events = rotatingEvents("resp_socket").slice(0, 5);
  const bridge = await responsesBridge(profile(t), t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(encodeEvents(events));
    res.write('data: {"type":"response.output_text.delta","delta":"unfinished');
    setTimeout(() => res.destroy(), 40);
  });
  try {
    const received = parse(await (await post(bridge)).text());
    assert.deepEqual(received.map(event => event.type), [
      ...events.map(event => event.type), "response.failed",
    ]);
    assert.equal(received.at(-1).response.error.code, "upstream_stream_error");
    assert.equal(received.at(-1).response.id, "resp_socket");
    assert.equal(received.at(-1).response.usage, null);
    assert.equal(bridge.requests.length, 1);
    const audit = await auditAt(bridge, "error");
    assert.equal(audit.error.kind, "stream");
    assert.equal(audit.eventsForwarded, events.length);
    assert.equal(audit.lastEventType, events.at(-1).type);
  } finally { await bridge.close(); }
});

test("a completed upstream response does not wait for its socket to close", async t => {
  const events = rotatingEvents("resp_open_socket");
  const bridge = await responsesBridge(profile(t), t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(encodeEvents(events));
  });
  try {
    const received = parse(await (await post(bridge)).text());
    assert.deepEqual(received.map(event => event.type), events.map(event => event.type));
    assert.equal((await auditAt(bridge, "complete")).usage.total_tokens, 10);
    assert.equal(bridge.requests.length, 1);
  } finally { await bridge.close(); }
});

test("top-level SSE context errors use a consistent failure event name and code", async t => {
  const bridge = await responsesBridge(profile(t), t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" }).end(encodeEvents([
      { type: "error", sequence_number: 1, error: contextError },
    ]));
  });
  try {
    const text = await (await post(bridge)).text();
    assert.match(text, /event: response\.failed/);
    assert.equal(parse(text)[0].response.error.code, "context_length_exceeded");
    assert.equal((await auditAt(bridge, "error")).error.code, "context_length_exceeded");
  } finally { await bridge.close(); }
});

test("Chat Completions framing distinguishes terminal data from premature EOF", async () => {
  for (const ending of ["", "\n", "\r", "\r\n", "\n\n", "\r\r", "\r\n\r\n"]) {
    let completions = 0;
    const received = [];
    await readSse(chunks(
      'data: {"choices":[{"delta":{"content":"SYNTHETIC_TEXT"}}]}\r\n\r\n',
      `data: [DONE]${ending}`,
    ), (_name, event) => received.push(event), () => { completions += 1; });
    assert.equal(completions, 1);
    assert.equal(received.length, 1);
  }
  let completed = false;
  await readSse(chunks('data: {"choices":[]}\n\n'), () => {},
    () => { completed = true; });
  assert.equal(completed, false, "EOF alone is not provider completion");
  await assert.rejects(readSse(chunks('data: {"choices":[]}\n\n'), () => {
    throw new Error("Synthetic callback failure");
  }), /Synthetic callback failure/);
});

test("Chat Completions framing releases an open provider stream at its terminal marker or error", async () => {
  for (const terminal of ['data: [DONE]\n\n', 'data: {"error":{"code":"synthetic"}}\n\n']) {
    let released = false;
    const source = async function* () {
      try { yield Buffer.from(terminal); await new Promise(() => {}); }
      finally { released = true; }
    };
    await readSse(source(), () => false, () => {});
    assert.equal(released, true);
  }
});

for (const stream of [true, false]) {
  test(`Chat Completions context overflow uses native recovery for stream=${stream} without changing input`, async t => {
    const bridge = await responsesBridge(profile(t), t, async (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { ...contextError, future_provider_detail: "preserved" } }));
    }, { route: "/chat/completions" });
    try {
      const response = await post(bridge, { stream });
      assert.equal(response.status, stream ? 200 : 400);
      const text = await response.text();
      const error = stream ? parse(text).at(-1).response.error : JSON.parse(text).error;
      assert.deepEqual(error, {
        ...contextError, code: "context_length_exceeded", future_provider_detail: "preserved",
      });
      assert.equal(bridge.requests.length, 1);
      assert.deepEqual(bridge.requests[0].messages, [
        { role: "user", content: "SYNTHETIC_PRIVATE_INPUT" },
      ]);
      const audit = await auditAt(bridge, "error");
      assert.equal(audit.httpStatus, 400);
      assert.equal(audit.error.upstreamCode, "invalid_request_body");
      assert.equal(audit.error.code, "context_length_exceeded");
      assert.equal(JSON.stringify(audit).includes("SYNTHETIC_PRIVATE_INPUT"), false);
    } finally { await bridge.close(); }
  });
}

test("Chat Completions unrelated invalid requests retain HTTP status and provider error fields", async t => {
  const error = { code: "invalid_request_body", message: "Invalid tool description.",
    param: "tools.0.description", future: 3 };
  const bridge = await responsesBridge(profile(t), t, async (_req, res) => {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error }));
  }, { route: "/chat/completions" });
  try {
    const response = await post(bridge);
    assert.equal(response.status, 400);
    assert.deepEqual((await response.json()).error, error);
    assert.equal(bridge.requests.length, 1);
  } finally { await bridge.close(); }
});

test("Chat Completions SSE context failure preserves partial output and never reports completion", async t => {
  const bridge = await responsesBridge(profile(t), t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" }).end(
      'data: {"choices":[{"delta":{"content":"SYNTHETIC_PARTIAL"}}]}\n\n'
      + `data: ${JSON.stringify({ error: contextError })}\n\n`
      + 'data: {"choices":[{"delta":{"content":"MUST_NOT_BE_PUBLISHED"}}]}\n\n'
      + "data: [DONE]\n\n",
    );
  }, { route: "/chat/completions" });
  try {
    const text = await (await post(bridge)).text();
    const events = parse(text);
    assert.ok(events.some(event =>
      event.type === "response.output_text.delta" && event.delta === "SYNTHETIC_PARTIAL"));
    assert.equal(text.includes("MUST_NOT_BE_PUBLISHED"), false);
    assert.equal(events.at(-1).type, "response.failed");
    assert.equal(events.at(-1).response.error.code, "context_length_exceeded");
    assert.equal(events.at(-1).response.usage, null);
    assert.equal(events.some(event => event.type === "response.completed"), false);
    assert.equal((await auditAt(bridge, "error")).error.upstreamCode, "invalid_request_body");
    assert.equal(bridge.requests.length, 1);
  } finally { await bridge.close(); }
});

test("Chat Completions premature EOF is a failure, not fabricated completion or zero-token success", async t => {
  const bridge = await responsesBridge(profile(t), t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
      .end('data: {"choices":[{"delta":{"content":"SYNTHETIC_PARTIAL"}}]}\n\n');
  }, { route: "/chat/completions" });
  try {
    const events = parse(await (await post(bridge)).text());
    assert.equal(events.at(-1).type, "response.failed");
    assert.equal(events.at(-1).response.error.code, "upstream_stream_incomplete");
    assert.equal(events.at(-1).response.usage, null);
    assert.equal(events.some(event => event.type === "response.completed"), false);
    const audit = await auditAt(bridge, "incomplete");
    assert.equal(audit.usage, null);
    assert.equal(bridge.requests.length, 1);
  } finally { await bridge.close(); }
});

test("Chat Completions real completion retains actual usage and handles an unterminated final marker", async t => {
  const bridge = await responsesBridge(profile(t), t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" }).end(
      'data: {"choices":[{"delta":{"content":"SYNTHETIC_COMPLETE"}}]}\n\n'
      + 'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\n\n'
      + "data: [DONE]",
    );
  }, { route: "/chat/completions" });
  try {
    const events = parse(await (await post(bridge)).text());
    assert.equal(events.at(-1).type, "response.completed");
    assert.equal(events.at(-1).response.usage.total_tokens, 15);
    assert.equal((await auditAt(bridge, "complete")).usage.total_tokens, 15);
    assert.equal(bridge.requests.length, 1);
  } finally { await bridge.close(); }
});
