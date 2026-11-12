import assert from "node:assert/strict";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import test from "node:test";
import { runRelay, RESET_MESSAGE } from "../bridge/native-mcp-relay.mjs";

function harness(t) {
  const input = new PassThrough();
  const output = new PassThrough();
  let generation = "first";
  const relay = runRelay({ input, output, resolveLaunch: () => ({
    command: process.execPath,
    args: [path.join(import.meta.dirname, "fixtures", "native-mcp-host.mjs")],
    env: { ...process.env, TEST_NATIVE_GENERATION: generation }, fingerprint: generation,
  }) });
  const pending = new Map();
  const eventWaiters = new Map();
  const lines = createInterface({ input: output });
  lines.on("line", line => {
    const message = JSON.parse(line);
    if (message.method) {
      eventWaiters.get(message.method)?.(message);
      eventWaiters.delete(message.method);
      return;
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => reject(new Error(`No relay response for ${method}`)), 10000);
    pending.set(current, message => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
  });
  t.after(async () => {
    input.end();
    await relay.finished;
    lines.close();
  });
  return {
    request,
    send: message => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`),
    change: () => { generation = "after-desktop-update"; },
    event: method => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No host event for ${method}`)), 10000);
      eventWaiters.set(method, value => { clearTimeout(timer); resolve(value); });
    }),
    initialize: async () => {
      await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "synthetic-client", version: "1" } });
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    },
  };
}

test("Desktop restart refreshes the official MCP host without replaying the requested action", async t => {
    const h = harness(t);
    await h.initialize();
    const first = await h.request("tools/call", { name: "read" });
    assert.deepEqual(JSON.parse(first.content[0].text), { calls: 1, generation: "first" });
    h.change();
    const cleanup = await h.request("tools/call", { name: "turn_ended" });
    assert.deepEqual(JSON.parse(cleanup.content[0].text), { cleanup: true, generation: "first" });
    const stale = await h.request("tools/call", { name: "read" });
    assert.equal(stale.isError, true);
    assert.equal(stale.content[0].text, RESET_MESSAGE);
    const recovered = await h.request("tools/call", { name: "read" });
    assert.deepEqual(JSON.parse(recovered.content[0].text), { calls: 1, generation: "after-desktop-update" });
    const stable = await h.request("tools/call", { name: "read" });
    assert.deepEqual(JSON.parse(stable.content[0].text), { calls: 2, generation: "after-desktop-update" });
});

test("discovery-triggered host replacement still invalidates the next stateful call", async t => {
  const h = harness(t);
  await h.initialize();
  await h.request("tools/call", { name: "read" });
  h.change();
  const tools = await h.request("tools/list");
  assert.equal(tools.tools[0].name, "read");
  const stale = await h.request("tools/call", { name: "read" });
  assert.equal(stale.content[0].text, RESET_MESSAGE);
  const first = await h.request("tools/call", { name: "read" });
  assert.deepEqual(JSON.parse(first.content[0].text), { calls: 1, generation: "after-desktop-update" });
});

test("cancellation reaches an outstanding call on its original host after configuration changes", async t => {
  const h = harness(t);
  await h.initialize();
  const event = h.event("notifications/testHolding");
  const held = h.request("tools/call", { name: "hold" });
  const cancelled = assert.rejects(held, /Cancelled on the original host/);
  const message = await event;
  h.change();
  h.send({ method: "notifications/cancelled", params: { requestId: message.params.requestId } });
  await cancelled;
  const stale = await h.request("tools/call", { name: "read" });
  assert.equal(stale.content[0].text, RESET_MESSAGE);
});

test("server elicitation IDs cannot erase in-flight client calls or cause authorization replay", async t => {
  const h = harness(t);
  await h.initialize();
  const event = h.event("elicitation/create");
  const authorization = h.request("tools/call", { name: "authorize" });
  const message = await event;
  h.change();
  await assert.rejects(h.request("tools/list"), /another call is running/);
  h.send({ id: message.id, result: { action: "decline" } });
  assert.deepEqual(await authorization, { action: "decline", generation: "first" });
  const stale = await h.request("tools/call", { name: "read" });
  assert.equal(stale.content[0].text, RESET_MESSAGE);
});
