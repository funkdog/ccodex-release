import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { forwardResponsesStream } from "../bridge/responses-stream.mjs";
import { encodeEvents, responsesBridge, rotatingEvents } from "./fixtures/responses-bridge.mjs";

const identity = { async normalize(event) { return event; } };
const request = {
  model: "synthetic-model", stream: true, reasoning: { effort: "max" },
  input: [{ type: "message", role: "user", content: [
    { type: "input_text", text: "SYNTHETIC_PRIVATE_INPUT" },
  ] }],
};
const legacyCheckpointEnv = {
  CODEX_COPILOT_RESPONSES_CHECKPOINT_MS: "20",
  CODEX_COPILOT_RESPONSES_MAX_CHECKPOINTS: "8",
  CODEX_COPILOT_SSE_HEARTBEAT_MS: "10",
};
const parse = (text, keepPings = false) => text.split(/\r\n\r\n|\n\n/).flatMap(frame => {
  const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart()).join("\n");
  try { return [JSON.parse(data)]; } catch { return []; }
}).filter(event => keepPings || event?.type !== "ping");
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-responses-continuity-"));
  t.after(async () => {
    const target = fs.realpathSync(home);
    assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(target), /^ccodex-responses-continuity-/);
    await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  return home;
}

async function auditAt(bridge, status) {
  const file = path.join(bridge.profile, "request-audit-latest.json");
  const deadline = Date.now() + 5000;
  for (;;) {
    if (fs.existsSync(file)) {
      const audit = JSON.parse(fs.readFileSync(file, "utf8"));
      if (audit.status === status) return audit;
    }
    assert.ok(Date.now() < deadline, `Audit did not settle to ${status}.`);
    await delay(20);
  }
}

const post = (bridge, extra = {}, signal = AbortSignal.timeout(35000)) =>
  fetch(`${bridge.url}/responses`, {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ ...request, ...extra }),
  });

async function writeReasoning(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(encodeEvents(events.slice(0, 4)));
  await delay(50);
  res.write(encodeEvents(events.slice(4, 5)));
}

test("a completed reasoning item after four minutes never discards a buffered message or terminal", async t => {
  const destination = new PassThrough();
  t.after(() => destination.destroy());
  let text = "";
  let released = false;
  let time = 0;
  t.mock.method(Date, "now", () => time);
  destination.on("data", data => { text += data.toString(); });
  const events = rotatingEvents("resp_continuous");
  const source = async function* () {
    try {
      yield Buffer.from(encodeEvents(events.slice(0, 4)));
      time = 240001;
      yield Buffer.from(encodeEvents(events.slice(4)));
      await new Promise(() => {});
    } finally { released = true; }
  };
  const result = await forwardResponsesStream(source(), destination, {
    identity, heartbeatMs: 0,
    shouldCheckpoint() { assert.fail("A retired checkpoint callback must never be consulted."); },
  });
  assert.deepEqual(result, { terminalEvent: "response.completed" });
  assert.deepEqual(parse(text), events);
  assert.equal(released, true);
});

test("eight late reasoning-item boundaries stay on one stream without losing the ninth completion", async t => {
  const destination = new PassThrough();
  t.after(() => destination.destroy());
  let text = "";
  let time = 0;
  t.mock.method(Date, "now", () => time);
  destination.on("data", data => { text += data.toString(); });
  const events = [{ type: "response.created", response: { id: "resp_many_items" } }];
  const source = async function* () {
    yield Buffer.from(encodeEvents(events));
    for (let index = 0; index < 9; index += 1) {
      time += 240001;
      const event = {
        type: "response.output_item.done", output_index: index,
        item: { type: "reasoning", summary: [], encrypted_content: `SYNTHETIC_${index}` },
      };
      events.push(event);
      yield Buffer.from(encodeEvents([event]));
    }
    const terminal = {
      type: "response.completed", response: { id: "resp_many_items", status: "completed" },
    };
    events.push(terminal);
    yield Buffer.from(encodeEvents([terminal]));
  };
  const result = await forwardResponsesStream(source(), destination, { identity, heartbeatMs: 0 });
  assert.deepEqual(result, { terminalEvent: "response.completed" });
  assert.deepEqual(parse(text), events);
});

test("keepalives continue after reasoning ends and stop only at the actual terminal", async t => {
  const destination = new PassThrough();
  t.after(() => destination.destroy());
  let text = "";
  destination.on("data", data => { text += data.toString(); });
  const events = rotatingEvents("resp_quiet_after_reasoning");
  const source = async function* () {
    yield Buffer.from(encodeEvents(events.slice(0, 5)));
    await delay(90);
    yield Buffer.from(encodeEvents(events.slice(5)));
  };
  await forwardResponsesStream(source(), destination, { identity, heartbeatMs: 10 });
  const received = parse(text, true);
  const done = received.findIndex(event => event?.type === "response.output_item.done");
  const message = received.findIndex(event => event?.item?.type === "message");
  assert.ok(received.slice(done + 1, message).some(event => event?.type === "ping"));
  assert.deepEqual(parse(text), events);
  const previous = text;
  await delay(40);
  assert.equal(text, previous, "Heartbeat timers must not outlive the real terminal.");
});

test("null, primitive, unknown and progress events remain intact instead of being filtered for rollover", async t => {
  const destination = new PassThrough();
  t.after(() => destination.destroy());
  let text = "";
  destination.on("data", data => { text += data.toString(); });
  const events = [
    null, 42, { future: "synthetic" },
    { type: "response.in_progress", response: { id: "resp_metadata" } },
    { type: "response.completed", response: { id: "resp_metadata", status: "completed" } },
  ];
  const source = async function* () {
    yield Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  };
  await forwardResponsesStream(source(), destination, { identity, heartbeatMs: 0 });
  assert.deepEqual(parse(text), events);
});

test("legacy checkpoint settings cannot turn one live response into nine upstream calls", async t => {
  const events = rotatingEvents("resp_legacy_settings");
  const bridge = await responsesBridge(fixture(t), t, async (_req, res) => {
    await writeReasoning(res, events);
    await delay(30);
    res.end(encodeEvents(events.slice(5)));
  }, { env: legacyCheckpointEnv });
  try {
    const received = parse(await (await post(bridge)).text());
    assert.equal(bridge.requests.length, 1);
    assert.deepEqual(received.map(event => event.type), events.map(event => event.type));
    assert.equal(received.filter(event => event.type === "response.created").length, 1);
    assert.equal(received.filter(event => event.type === "response.completed").length, 1);
    const audit = await auditAt(bridge, "complete");
    assert.equal(audit.attempts, 1);
    assert.equal(audit.reasoningCheckpoints, 0);
    assert.equal(Object.hasOwn(audit, "usageScope"), false);
    assert.equal(audit.usage.total_tokens, 10);
    assert.ok(audit.elapsedMs >= 80);
    assert.equal(audit.elapsedMs, Date.parse(audit.completedAt) - Date.parse(audit.startedAt));
    assert.equal(JSON.stringify(audit).includes("SYNTHETIC_PRIVATE_INPUT"), false);
    const health = await (await fetch(`${bridge.url}/health`)).json();
    assert.equal(health.runtime.responsesStreamContinuity, 1);
    assert.equal(health.runtime.responsesReasoningCheckpoints, 0);
    assert.equal(health.runtime.responsesCheckpointMs, 0);
    assert.equal(health.runtime.responsesMaxCheckpoints, 0);
  } finally { await bridge.close(); }
});

test("a 22 MiB input retains its model, max effort and full history without reasoning replay", async t => {
  const input = [{
    type: "message", role: "user",
    content: [{ type: "input_text", text: `SYNTHETIC_PRIVATE_INPUT\n${"x".repeat(22 * 1024 * 1024)}` }],
  }];
  const events = rotatingEvents("resp_large_context");
  const bridge = await responsesBridge(fixture(t), t, async (_req, res) => {
    await writeReasoning(res, events);
    res.end(encodeEvents(events.slice(5)));
  }, { env: legacyCheckpointEnv });
  try {
    const received = parse(await (await post(bridge, { input })).text());
    assert.equal(bridge.requests.length, 1);
    assert.equal(digest(bridge.requests[0].input), digest(input));
    assert.equal(bridge.requests[0].model, request.model);
    assert.deepEqual(bridge.requests[0].reasoning, request.reasoning);
    assert.equal(Object.hasOwn(bridge.requests[0], "max_output_tokens"), false);
    assert.equal(received.at(-1).type, "response.completed");
    assert.equal((await auditAt(bridge, "complete")).attempts, 1);
  } finally { await bridge.close(); }
});

test("a tool call following late reasoning is forwarded once with its genuine call identity", async t => {
  const events = rotatingEvents("resp_tool_after_reasoning");
  const tool = {
    type: "function_call", id: "opaque_tool", call_id: "call_synthetic",
    name: "synthetic", arguments: "{}", status: "completed",
  };
  const bridge = await responsesBridge(fixture(t), t, async (_req, res) => {
    await writeReasoning(res, events);
    res.end(encodeEvents([
      { type: "response.output_item.added", output_index: 1, sequence_number: 5, item: tool },
      { type: "response.output_item.done", output_index: 1, sequence_number: 6, item: tool },
      { type: "response.completed", sequence_number: 7, response: {
        id: "resp_tool_after_reasoning", status: "completed", output: [events[4].item, tool],
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
      } },
    ]));
  }, { env: legacyCheckpointEnv });
  try {
    const received = parse(await (await post(bridge)).text());
    assert.equal(bridge.requests.length, 1);
    const calls = received.filter(event =>
      event.type === "response.output_item.done" && event.item?.type === "function_call");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].item.call_id, tool.call_id);
    assert.equal(received.at(-1).response.output[1].id, calls[0].item.id);
    assert.equal((await auditAt(bridge, "complete")).attempts, 1);
  } finally { await bridge.close(); }
});

test("reasoning followed by EOF fails once rather than restarting or inventing completion and usage", async t => {
  const events = rotatingEvents("resp_reasoning_eof");
  const bridge = await responsesBridge(fixture(t), t, async (_req, res) => {
    await writeReasoning(res, events);
    res.end();
  }, { env: legacyCheckpointEnv });
  try {
    const received = parse(await (await post(bridge)).text());
    assert.equal(bridge.requests.length, 1);
    assert.equal(received.at(-1).type, "response.failed");
    assert.equal(received.at(-1).response.id, "resp_reasoning_eof");
    assert.equal(received.at(-1).response.error.code, "upstream_stream_incomplete");
    assert.equal(received.at(-1).response.usage, null);
    assert.equal(received.some(event => event.type === "response.completed"), false);
    const audit = await auditAt(bridge, "incomplete");
    assert.equal(audit.attempts, 1);
    assert.equal(audit.reasoningCheckpoints, 0);
    assert.equal(audit.usage, null);
    assert.equal((await fetch(`${bridge.url}/health`)).status, 200);
  } finally { await bridge.close(); }
});

test("a real provider failure after reasoning retains the native failure protocol without replay", async t => {
  const events = rotatingEvents("resp_provider_failure");
  const error = { code: "rate_limit_exceeded", message: "Synthetic overload." };
  const bridge = await responsesBridge(fixture(t), t, async (_req, res) => {
    await writeReasoning(res, events);
    res.end(encodeEvents([{ type: "response.failed", sequence_number: 5, response: {
      id: "resp_provider_failure", status: "failed", error, usage: null,
    } }]));
  }, { env: legacyCheckpointEnv });
  try {
    const received = parse(await (await post(bridge)).text());
    assert.equal(bridge.requests.length, 1);
    assert.equal(received.at(-1).type, "response.failed");
    assert.deepEqual(received.at(-1).response.error, error);
    assert.equal(received.at(-1).sequence_number, 5);
    const audit = await auditAt(bridge, "error");
    assert.equal(audit.attempts, 1);
    assert.equal(audit.reasoningCheckpoints, 0);
  } finally { await bridge.close(); }
});

test("cancelling after reasoning closes the same upstream and never starts a continuation", async t => {
  let upstreamClosed = false;
  const events = rotatingEvents("resp_cancel_after_reasoning");
  const bridge = await responsesBridge(fixture(t), t, async (_req, res) => {
    res.once("close", () => { upstreamClosed = true; });
    await writeReasoning(res, events);
  }, { env: legacyCheckpointEnv });
  try {
    const controller = new AbortController();
    const response = await post(bridge, {}, AbortSignal.any([
      controller.signal, AbortSignal.timeout(15000),
    ]));
    const reader = response.body.getReader();
    let text = "";
    while (!text.includes("response.output_item.done")) {
      const result = await reader.read();
      assert.equal(result.done, false);
      text += new TextDecoder().decode(result.value);
    }
    controller.abort();
    await reader.cancel().catch(() => {});
    const audit = await auditAt(bridge, "cancelled");
    await delay(80);
    assert.equal(audit.attempts, 1);
    assert.equal(audit.reasoningCheckpoints, 0);
    assert.equal(bridge.requests.length, 1);
    assert.equal(upstreamClosed, true);
  } finally { await bridge.close(); }
});
