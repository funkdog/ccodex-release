import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readSse } from "../bridge/translate.mjs";
import { memoryResponsesBridge, responsesBridge } from "./fixtures/responses-bridge.mjs";

const patch = "*** Begin Patch\n*** Add File: fixture.html\n+" + "<p>长补丁 🐾</p>".repeat(4000) + "\n*** End Patch";
const request = { model: "gemini-carbon-fixture", stream: true, input: "Create the owned fixture.",
  tools: [{ type: "custom", name: "apply_patch" }] };
const chunk = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const tool = (argumentsText, first = false) => chunk({ tool_calls: [{ index: 0,
  ...(first ? { id: "call_owned_patch" } : {}),
  function: { ...(first ? { name: "apply_patch" } : {}), arguments: argumentsText } }] });
const post = (bridge, body = request, signal) => fetch(bridge.url, {
  method: "POST", body: JSON.stringify(body), signal,
});
const collect = async response => {
  const events = [];
  await readSse(response.body, (_name, event) => events.push(event));
  return events;
};

for (const stream of [true, false]) test(`reasoning-only provider completion is a recoverable failure with stream=${stream}`, async t => {
  const bridge = await memoryResponsesBridge(async (_req, res) => {
    const completion = { choices: [{ [stream ? "delta" : "message"]: { reasoning_text: "Considering the patch." } }],
      usage: { prompt_tokens: 230278, completion_tokens: 8641, reasoning_tokens: 8618, total_tokens: 238919 } };
    res.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
    res.end(stream ? `data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n` : JSON.stringify(completion));
  }, { route: "/chat/completions" });
  t.after(() => bridge.close());
  const response = await post(bridge, { ...request, stream });
  if (stream) {
    const events = await collect(response);
    assert.equal(events.at(-1).type, "response.failed");
    assert.equal(events.at(-1).response.error.code, "upstream_empty_response");
    assert.equal(events.some(event => event.type === "response.completed"), false);
  } else {
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "upstream_empty_response");
  }
  assert.equal(bridge.audits[0].status, "error");
});

test("long buffered patch sends keepalives during generation and completes with the exact patch once", { timeout: 10000 }, async t => {
  let ended = false;
  const bridge = await memoryResponsesBridge(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const encoded = JSON.stringify({ input: patch });
    res.write(tool(encoded.slice(0, 20), true));
    // Each fragment takes longer than the client's idle deadline.
    for (let offset = 20; offset < encoded.length; offset += 16000) {
      await delay(180);
      res.write(tool(encoded.slice(offset, offset + 16000)));
    }
    ended = true;
    res.end("data: [DONE]\n\n");
  }, { route: "/chat/completions", heartbeatMs: 15 });
  t.after(() => bridge.close());
  const controller = new AbortController();
  const response = await post(bridge, request, controller.signal);
  const events = [];
  let timer;
  const resetDeadline = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error("Downstream SSE idle timeout")), 120);
  };
  // Enforce a deadline for each downstream frame, as the native client does.
  resetDeadline();
  try {
    await readSse(response.body, (_name, event) => {
      resetDeadline();
      events.push(event);
      if (!ended) assert.notEqual(event.type, "response.completed");
    });
  } finally { clearTimeout(timer); }
  assert.ok(events.filter(event => event.type === "ping").length > 5);
  assert.equal(events.filter(event => event.type === "response.output_item.done").length, 1);
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).response.output[0].input, patch);
  assert.equal(bridge.requests.length, 1);
  assert.equal(bridge.audits[0].status, "complete");
  assert.ok(bridge.audits[0].downstreamHeartbeats > 5);
  assert.equal(bridge.audits[0].toolArgumentBytes, Buffer.byteLength(JSON.stringify({ input: patch })));
});

test("a stalled Chat upstream fails despite downstream heartbeats and closes the upstream socket", { timeout: 5000 }, async t => {
  let closed = false;
  const bridge = await memoryResponsesBridge(async (_req, res) => {
    res.once("close", () => { closed = true; });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(tool('{"input":"*** Begin Patch', true));
  }, { route: "/chat/completions", heartbeatMs: 10, chatIdleTimeoutMs: 100 });
  t.after(() => bridge.close());
  const events = await collect(await post(bridge));
  assert.ok(events.some(event => event.type === "ping"));
  assert.equal(events.at(-1).type, "response.failed");
  assert.equal(events.at(-1).response.error.code, "upstream_stream_idle_timeout");
  assert.equal(events.some(event => event.type === "response.output_item.done"), false);
  assert.equal(bridge.audits[0].status, "error");
  await delay(20);
  assert.equal(closed, true);
  assert.equal(bridge.requests.length, 1, "The native client owns retries after a stream was published.");
});

test("raw upstream fragments refresh the deadline even before a complete SSE frame exists", { timeout: 5000 }, async t => {
  const bridge = await memoryResponsesBridge(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const wire = tool(JSON.stringify({ input: patch }), true);
    for (let offset = 0; offset < wire.length; offset += 20000) {
      res.write(wire.slice(offset, offset + 20000));
      await delay(50);
    }
    res.end("data: [DONE]\n\n");
  }, { route: "/chat/completions", heartbeatMs: 10, chatIdleTimeoutMs: 120 });
  t.after(() => bridge.close());
  const events = await collect(await post(bridge));
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).response.output[0].input, patch);
  assert.ok(bridge.audits[0].upstreamChunks > 2);
  assert.ok(bridge.audits[0].upstreamBytes > patch.length);
  assert.ok(bridge.audits[0].downstreamEvents > 5);
});

for (const ending of ["eof", "reset"]) test(`Chat ${ending} retains partial text and allows Gemini retry without executing the interrupted patch`, { timeout: 5000 }, async t => {
  const bridge = await memoryResponsesBridge(async (_req, res, body, count) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (count === 1) {
      res.write(chunk({ content: "Creating the owned patch." }));
      res.write(tool('{"input":"*** Begin Patch', true));
      await delay(30);
      if (ending === "reset") res.destroy();
      else res.end();
      return;
    }
    assert.equal(body.messages.at(-1).role, "user");
    assert.equal(body.messages.some(message => message.role === "tool"), false);
    res.end(tool(JSON.stringify({ input: patch }), true) + "data: [DONE]\n\n");
  }, { route: "/chat/completions" });
  t.after(() => bridge.close());
  const failed = await collect(await post(bridge));
  const terminal = failed.at(-1);
  assert.equal(terminal.type, "response.failed");
  assert.equal(failed.some(event => event.item?.type === "custom_tool_call" && event.type === "response.output_item.done"), false);
  const partialText = terminal.response.output.find(item => item.type === "message");
  assert.equal(partialText.phase, "commentary");
  const next = { ...request, input: [{ role: "user", content: request.input }, partialText] };
  const before = structuredClone(next);
  const recovered = await collect(await post(bridge, next));
  assert.equal(recovered.at(-1).type, "response.completed");
  assert.equal(recovered.at(-1).response.output[0].input, patch);
  assert.deepEqual(next, before);
  assert.equal(bridge.requests.length, 2);
});

test("isolated production Chat server enforces the configured upstream deadline and records real progress separately from keepalives", { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-chat-idle-"));
  let bridge;
  t.after(async () => {
    await bridge?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  bridge = await responsesBridge(root, t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chunk({ reasoning_text: "PRIVATE_THOUGHT", reasoning_opaque: "PRIVATE_OPAQUE", content: "PRIVATE_TEXT",
      tool_calls: [{ index: 0, id: "call_owned_patch", function: { name: "apply_patch", arguments: '{"input":"*** Begin Patch' } }] }));
  }, { route: "/chat/completions", env: {
    CODEX_COPILOT_SSE_HEARTBEAT_MS: "15", CODEX_COPILOT_CHAT_STREAM_IDLE_TIMEOUT_MS: "120",
  } });
  const response = await fetch(bridge.url + "/responses", { method: "POST",
    body: JSON.stringify({ ...request, model: "synthetic-model" }) });
  const events = await collect(response);
  assert.equal(events.at(-1).type, "response.failed");
  assert.equal(events.at(-1).response.error.code, "upstream_stream_idle_timeout");
  let audit;
  const deadline = Date.now() + 2000;
  do {
    const records = fs.readFileSync(path.join(bridge.profile, "request-audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    audit = records.at(-1);
    if (audit.status === "error") break;
    await delay(10);
  } while (Date.now() < deadline);
  assert.equal(audit.status, "error");
  assert.equal(audit.upstreamEvents, 1);
  assert.ok(audit.upstreamBytes > 0);
  assert.ok(audit.downstreamHeartbeats > 0);
  assert.ok(audit.lastDownstreamAt > audit.lastUpstreamAt);
  assert.equal(bridge.requests.length, 1);
  const trace = fs.readFileSync(path.join(bridge.profile, "request-stream.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(trace.some(row => row.event === "request.serialized" && /^[a-f0-9]{64}$/.test(row.payloadSha256)));
  assert.ok(trace.some(row => row.event === "upstream.chunk" && row.bytes > 0));
  assert.ok(trace.some(row => row.event === "upstream.frame" && row.argumentBytes > 0));
  assert.ok(trace.some(row => row.event === "upstream.frame" && row.reasoningTextBytes > 0 && row.opaqueBytes > 0 && row.textBytes > 0));
  assert.ok(trace.some(row => row.event === "downstream.event" && row.type === "response.reasoning_summary_text.delta" && row.deltaBytes > 0));
  assert.ok(trace.some(row => row.event === "downstream.heartbeat"));
  assert.ok(trace.some(row => row.event === "downstream.event" && row.type === "response.failed"));
  assert.doesNotMatch(JSON.stringify(trace), /\*\*\* Begin Patch|Create the owned fixture|synthetic-token|PRIVATE_THOUGHT|PRIVATE_OPAQUE|PRIVATE_TEXT/);
});
