import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { isMaterializedResponseItem, ResponseIdentitySession, ResponseIdentityStore } from "../bridge/response-identity.mjs";
import { forwardResponsesStream, normalizeResponsesStream } from "../bridge/responses-stream.mjs";
import { encodeEvents, responsesBridge, rotatingEvents } from "./fixtures/responses-bridge.mjs";

function profile(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-response-identity-"));
  t.after(async () => {
    const resolved = fs.realpathSync(home);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^ccodex-response-identity-/);
    await fs.promises.rm(resolved, {
      recursive: true, force: true, maxRetries: 30, retryDelay: 100,
    });
  });
  return home;
}

const storeAt = (home, account = "synthetic", provider = "https://synthetic.invalid") =>
  new ResponseIdentityStore({ home, provider, account });
const memoryIdentity = () => new ResponseIdentitySession({ async save() {} });
const chunks = async function* (...values) { yield* values.map(value => Buffer.from(value)); };
const collect = async iterable => { let text = ""; for await (const chunk of iterable) text += chunk; return text; };
const parse = text => text.split(/\r\n\r\n|\n\n|\r\r/).flatMap(frame => {
  const data = frame.split(/\r\n|\r|\n/).filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart()).join("\n");
  try { return [JSON.parse(data)]; } catch { return []; }
});
const waitFor = async (label, check) => {
  const deadline = Date.now() + 10000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

for (const initialId of ["", "resp_original"]) {
  test(`one continuous response keeps a coherent ${initialId ? "provider" : "empty"} response ID without a rollover mapper`, async () => {
    const session = memoryIdentity();
    const first = await session.normalize({
      type: "response.created", sequence_number: 0, response: { id: initialId },
    });
    if (initialId) assert.equal(first.response.id, initialId);
    else assert.match(first.response.id, /^resp_ccodex_[0-9a-f]+$/);
    const original = {
      type: "response.completed", sequence_number: 7, response: {
        id: "rotating_provider_id", status: "completed",
        output: [{ type: "message", id: "opaque_message", role: "assistant", content: [] }],
        usage: { total_tokens: 10 }, future: { retained: true },
      },
    };
    const snapshot = structuredClone(original);
    const completed = await session.normalize(original);
    assert.equal(completed.response.id, first.response.id);
    assert.equal(completed.sequence_number, original.sequence_number);
    assert.deepEqual(completed.response.usage, original.response.usage);
    assert.deepEqual(completed.response.future, original.response.future);
    assert.deepEqual(original, snapshot);
    const next = await memoryIdentity().normalize({
      type: "response.created", response: { id: "resp_next" },
    });
    assert.equal(next.response.id, "resp_next", "Response identity is scoped to one upstream response.");
  });
}

test("response identity is stable across every rotating event without deduplicating genuine repeats", async t => {
  const home = profile(t);
  const store = storeAt(home);
  const identity = store.createSession();
  const original = rotatingEvents();
  const snapshot = structuredClone(original);
  const normalized = [];
  for (const event of original) normalized.push(await identity.normalize(event));
  assert.deepEqual(original, snapshot, "provider payloads must not be mutated");
  const starts = normalized.filter(event => event.type === "response.output_item.added");
  const ends = normalized.filter(event => event.type === "response.output_item.done");
  assert.equal(new Set(starts.map(event => event.item.id)).size, 4);
  for (const event of normalized.filter(event => Number.isInteger(event.output_index))) {
    assert.equal(event.item?.id || event.item_id, starts[event.output_index].item.id);
  }
  assert.deepEqual(ends.map(event => event.item.id), starts.map(event => event.item.id));
  const completed = normalized.at(-1).response.output;
  assert.deepEqual(completed.map(item => item.id), starts.map(event => event.item.id));
  const restored = await storeAt(home).restoreRequest({ input: completed });
  assert.deepEqual(restored.input, original.at(-1).response.output);
  assert.equal(completed[1].content[0].text, completed[2].content[0].text);
  assert.notEqual(completed[1].id, completed[2].id);
});

test("function, custom, search and future tool payloads preserve all non-identity fields", async t => {
  const store = storeAt(profile(t));
  const session = store.createSession();
  const types = ["function_call", "custom_tool_call", "tool_search_call", "web_search_call", "future_tool_call"];
  const originals = types.map((type, index) => ({
    type, id: `opaque-final-${index}`, call_id: `call_${index}`,
    name: "synthetic_read", arguments: "{\"value\":1}", input: "synthetic",
    encrypted_content: "ENCRYPTED_CONTENT_MUST_NOT_CHANGE",
    internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn", future_field: [1, 2] },
    future: { nested_id: "NOT_AN_ITEM_ID", status: "preserved" },
  }));
  const normalized = [];
  for (const [output_index, item] of originals.entries()) {
    const added = await session.normalize({ type: "response.output_item.added", output_index,
      item: { ...item, id: `opaque-start-${output_index}`, arguments: "" } });
    const delta = await session.normalize({ type: "response.function_call_arguments.delta",
      output_index, item_id: `opaque-delta-${output_index}`, delta: item.arguments });
    const done = await session.normalize({ type: "response.output_item.done", output_index, item });
    assert.equal(added.item.id, delta.item_id);
    assert.equal(done.item.id, added.item.id);
    assert.deepEqual({ ...done.item, id: item.id }, item);
    normalized.push(done.item);
  }
  assert.deepEqual((await store.restoreRequest({ input: normalized })).input, originals);
});

test("durable identities restore the authoritative provider ID after restart, including item references", async t => {
  const home = profile(t);
  const store = storeAt(home);
  const session = store.createSession();
  const [added, done] = await (async () => [
    await session.normalize({ type: "response.output_item.added", output_index: 0,
      item: { type: "message", id: "UPSTREAM_START", role: "assistant", content: [] } }),
    await session.normalize({ type: "response.output_item.done", output_index: 0,
      item: { type: "message", id: "UPSTREAM_DONE", role: "assistant", content: [] } }),
  ])();
  assert.equal(added.item.id, done.item.id);
  const restarted = storeAt(home);
  assert.deepEqual(await restarted.restoreRequest({ input: [{ type: "item_reference", id: done.item.id }] }),
    { input: [{ type: "item_reference", id: "UPSTREAM_DONE" }] });
  await session.normalize({ type: "response.completed",
    response: { output: [{ ...done.item, id: "UPSTREAM_COMPLETED" }], usage: { total_tokens: 1 } } });
  assert.equal((await restarted.restoreRequest({ input: [done.item] })).input[0].id, "UPSTREAM_COMPLETED");
  const second = store.createSession();
  const next = await second.normalize({ type: "response.output_item.added", output_index: 0, item: {
    type: "message", id: "UPSTREAM_START", role: "assistant", content: [],
  } });
  assert.notEqual(next.item.id, added.item.id, "output_index is scoped to one response, not the account");
});

test("missing and null provider IDs round-trip without inventing upstream identifiers", async t => {
  const store = storeAt(profile(t));
  const session = store.createSession();
  const originals = [{ type: "message", content: [] }, { type: "reasoning", id: null, summary: [] }];
  const normalized = [];
  for (const [output_index, item] of originals.entries()) {
    normalized.push((await session.normalize({ type: "response.output_item.done", output_index, item })).item);
  }
  assert.deepEqual((await store.restoreRequest({ input: normalized })).input, originals);
  await assert.rejects(store.restoreRequest({ input: [{ type: "item_reference", id: normalized[0].id }] }),
    /provider did not supply an ID/);
});

test("unknown frames and non-identity metadata survive without narrowing the provider schema", async () => {
  const raw = ': keepalive\r\n\r\nevent: future.provider.event\r\nid: 12\r\nretry: 1000\r\ndata: {"type":"future.provider.event","item":{"id":"unknown"},"value":[1,2]}\r\n\r\n'
    + 'data: not-json\n\n' + 'data: [DONE]\n\n';
  assert.equal(await collect(normalizeResponsesStream(chunks(raw), { identity: memoryIdentity() })), raw);
  const event = { type: "response.future_diagnostic", details: { id: "not-an-item", data: [1, 2] } };
  assert.equal(await memoryIdentity().normalize(event), event);
  const future = { type: "response.future_diagnostic", item: { id: "opaque-diagnostic" }, item_id: "diagnostic" };
  assert.equal(await memoryIdentity().normalize(future), future);
});

test("unindexed references require an observed unambiguous identity, not matching text", async () => {
  const session = memoryIdentity();
  const first = await session.normalize({ type: "response.output_item.added", output_index: 0,
    item: { type: "message", id: "known", content: [] } });
  assert.equal((await session.normalize({ type: "response.output_text.delta",
    item_id: "known", delta: "x" })).item_id, first.item.id);
  await assert.rejects(session.normalize({ type: "response.output_text.delta", item_id: "rotated", delta: "x" }),
    /missing or ambiguous output_index/);
  await assert.rejects(session.normalize({ type: "response.output_item.done", output_index: 0,
    item: { type: "reasoning", id: "known", summary: [] } }), /changed the item type/);
});

test("missing, corrupt, unsupported or cross-account identity records fail before upstream use", async t => {
  const home = profile(t);
  const store = storeAt(home);
  const normalized = await store.createSession().normalize({ type: "response.output_item.done", output_index: 0,
    item: { type: "message", id: "PRIVATE_PROVIDER_ID", content: [] } });
  const request = { input: [normalized.item] };
  await assert.rejects(storeAt(home, "other-account").restoreRequest(request), /unavailable in this account\/profile/);
  await assert.rejects(storeAt(home, "synthetic", "https://other.invalid").restoreRequest(request), /unavailable/);
  await assert.rejects(store.restoreRequest({ input: [{ id: "ccodex_item_v2_unsupported" }] }), /Unsupported/);
  await assert.rejects(store.restoreRequest({ input: [{ id: "ccodex_item_v1_../../outside" }] }), /invalid/);
  await assert.rejects(store.save("../../outside", {}), /Invalid bridge response identity key/);
  const files = fs.readdirSync(store.directory);
  assert.equal(files.length, 1);
  const file = path.join(store.directory, files[0]);
  fs.writeFileSync(file, JSON.stringify({ version: 99, items: {} }));
  await assert.rejects(store.restoreRequest(request), /Stored response item identity is invalid/);
  fs.rmSync(file);
  await assert.rejects(store.restoreRequest(request), /unavailable/);
});

test("ordinary request items are unchanged and no identity store is created on read", async t => {
  const store = storeAt(profile(t));
  const request = { input: [{ id: "provider-id", content: "text" }, { type: "function_call_output",
    call_id: "call-unchanged", output: "synthetic" }, "future-input"] };
  assert.equal(await store.restoreRequest(request), request);
  assert.equal(await store.restoreRequest({ input: "text" }).then(value => value.input), "text");
  assert.equal(fs.existsSync(store.directory), false);
});

test("complete caller-owned history can recover after an account change without importing foreign provider IDs", async t => {
  const home = profile(t);
  const old = storeAt(home, "old-account");
  const identity = old.createSession();
  const originals = [
    { type: "message", id: "OLD_PRIVATE_MESSAGE_ID", role: "assistant",
      content: [{ type: "output_text", text: "SYNTHETIC_RETAINED_MESSAGE" }],
      phase: "commentary", future: { retained: true } },
    { type: "reasoning", id: "OLD_PRIVATE_REASONING_ID", summary: [],
      encrypted_content: "SYNTHETIC_RETAINED_ENCRYPTED_CONTENT" },
    { type: "function_call", id: "OLD_PRIVATE_CALL_ID", call_id: "synthetic-call",
      name: "synthetic", arguments: '{"retained":true}' },
    { type: "custom_tool_call", id: "OLD_PRIVATE_CUSTOM_ID", call_id: "synthetic-custom",
      name: "synthetic", input: "SYNTHETIC_RETAINED_CUSTOM_INPUT" },
    { type: "tool_search_call", id: "OLD_PRIVATE_SEARCH_ID", arguments: { query: "synthetic" } },
    { type: "web_search_call", id: "OLD_PRIVATE_WEB_ID", action: { type: "search", query: "synthetic" } },
  ];
  const materialized = [];
  for (const [output_index, item] of originals.entries()) {
    materialized.push((await identity.normalize({
      type: "response.output_item.done", output_index, item,
    })).item);
  }
  const current = storeAt(home, "current-account");
  const request = { input: [...materialized,
    { type: "function_call_output", call_id: "synthetic-call", output: "SYNTHETIC_TOOL_RESULT" }],
    model: "synthetic-model" };
  await assert.rejects(current.restoreRequest(request), /unavailable/);
  const recoveries = [];
  const restored = await current.restoreRequest(request, {
    allowMaterializedRecovery: true, onRecovery: value => recoveries.push(value),
  });
  assert.deepEqual(restored.input, [...originals.map(({ id, ...item }) => item), request.input.at(-1)]);
  assert.equal(restored.model, request.model);
  assert.equal(fs.existsSync(current.directory), false, "Read-only recovery must not move foreign identity records.");
  assert.deepEqual(recoveries, [{ kind: "materialized_history", items: 6,
    responseGroups: 1, importedForeignIdentities: false }]);
  assert.ok(materialized.every(item => item.id.startsWith("ccodex_item_v1_")), "Stored history is unchanged.");
  assert.ok(!(JSON.stringify(restored).includes("OLD_PRIVATE")));
});

test("complete history survives a missing same-account cache while references and partial items remain rejected", async t => {
  const store = storeAt(profile(t));
  const item = (await store.createSession().normalize({
    type: "response.output_item.done", output_index: 0,
    item: { type: "message", id: "PROVIDER_ID", role: "assistant",
      content: [{ type: "output_text", text: "SYNTHETIC_FULL_ITEM" }] },
  })).item;
  fs.rmSync(store.directory, { recursive: true });
  assert.deepEqual((await store.restoreRequest({ input: [item] }, {
    allowMaterializedRecovery: true,
  })).input, [{ type: "message", role: "assistant",
    content: [{ type: "output_text", text: "SYNTHETIC_FULL_ITEM" }] }]);
  for (const incomplete of [
    { type: "item_reference", id: item.id },
    { type: "message", id: item.id },
    { type: "reasoning", id: item.id },
    { type: "future_item", id: item.id },
  ]) {
    assert.equal(isMaterializedResponseItem(incomplete), false);
    await assert.rejects(store.restoreRequest({ input: [incomplete] }, {
      allowMaterializedRecovery: true,
    }), /unavailable/);
  }
});

test("materialized recovery never hides a corrupt identity store", async t => {
  const store = storeAt(profile(t));
  const normalized = (await store.createSession().normalize({
    type: "response.output_item.done", output_index: 0,
    item: { type: "message", id: "PROVIDER_ID", role: "assistant", content: [] },
  })).item;
  const file = path.join(store.directory, fs.readdirSync(store.directory)[0]);
  fs.writeFileSync(file, "{invalid");
  await assert.rejects(store.restoreRequest({ input: [normalized] }, {
    allowMaterializedRecovery: true,
  }), /Stored response item identity is invalid/);
});

test("SSE framing handles every byte split, UTF-8, CRLF, multiline data and metadata", async () => {
  const event = { type: "response.output_item.added", output_index: 0,
    item: { type: "message", id: "opaque", role: "assistant",
      content: [{ type: "output_text", text: "\u6d4b\u8bd5 \ud83c\udf10" }] } };
  const raw = 'id: event-1\r\nevent: response.output_item.added\r\n: comment\r\n'
    + 'data: ' + JSON.stringify(event, null, 2).split("\n").join("\r\ndata: ") + "\r\n\r\n";
  const bytes = Buffer.from(raw);
  for (let split = 0; split <= bytes.length; split += 1) {
    const output = await collect(normalizeResponsesStream(chunks(bytes.subarray(0, split), bytes.subarray(split)),
      { identity: memoryIdentity() }));
    assert.ok(output.startsWith("id: event-1\r\nevent: response.output_item.added\r\n: comment\r\n"));
    const [value] = parse(output);
    assert.deepEqual({ ...value, item: { ...value.item, id: "opaque" } }, event);
  }
  const cr = raw.replaceAll("\r\n", "\r");
  const output = await collect(normalizeResponsesStream(chunks(...Array.from(Buffer.from(cr), byte => Buffer.from([byte]))),
    { identity: memoryIdentity() }));
  assert.deepEqual(parse(output)[0].item.content, event.item.content);
});

test("streaming publishes initial content without waiting for final provider identifiers", async () => {
  let finish;
  const release = new Promise(resolve => { finish = resolve; });
  const events = rotatingEvents().filter(event => event.output_index === 1);
  const source = async function* () {
    yield Buffer.from(encodeEvents(events.slice(0, 2)));
    await release;
    yield Buffer.from(encodeEvents(events.slice(2)));
  };
  const stream = normalizeResponsesStream(source(), { identity: memoryIdentity() });
  try {
    const started = parse((await stream.next()).value)[0];
    const delta = parse((await stream.next()).value)[0];
    assert.equal(started.type, "response.output_item.added");
    assert.equal(delta.item_id, started.item.id);
    assert.equal(delta.delta, "SYNTHETIC_GENUINE_REPEAT");
    finish();
    assert.equal(parse((await stream.next()).value)[0].item.id, started.item.id);
    assert.equal((await stream.next()).done, true);
  } finally { finish(); await stream.return(); }
});

test("backpressure and cancellation release the source without replaying output", async () => {
  let read = 0;
  let closed = false;
  const source = async function* () {
    try {
      read += 1;
      yield Buffer.from(": heartbeat\n\n");
      read += 1;
      yield Buffer.from(": second\n\n");
    } finally { closed = true; }
  };
  const destination = new PassThrough({ highWaterMark: 1 });
  const controller = new AbortController();
  const work = forwardResponsesStream(source(), destination, { identity: memoryIdentity(), signal: controller.signal });
  const checked = assert.rejects(work, /abort/i);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(read, 1);
  controller.abort();
  await checked;
  assert.equal(closed, true);
  assert.equal(destination.listenerCount("drain"), 0);
  destination.destroy();
});

test("frame limits and broken input streams are explicit failures, not fabricated completions", async () => {
  await assert.rejects(collect(normalizeResponsesStream(chunks(`data: ${"x".repeat(65)}`),
    { identity: memoryIdentity(), maxFrameLength: 64 })), /frame exceeds/);
  const source = async function* () {
    yield Buffer.from(": partial\n\n");
    throw new Error("synthetic transport failure");
  };
  const seen = [];
  await assert.rejects(collect(normalizeResponsesStream(source(),
    { identity: memoryIdentity(), onEvent: event => seen.push(event) })), /synthetic transport failure/);
  assert.deepEqual(seen, []);
});

test("identity persistence failure stops output before a non-reversible identity reaches the client", async () => {
  const identity = new ResponseIdentitySession({ async save() { throw new Error("synthetic disk failure"); } });
  const event = rotatingEvents().find(item => item.type === "response.output_item.added");
  let published = "";
  await assert.rejects(async () => {
    for await (const frame of normalizeResponsesStream(chunks(encodeEvents([event])), { identity })) published += frame;
  }, /synthetic disk failure/);
  assert.equal(published, "");
});

test("failed and incomplete responses keep their terminal status, error and partial items", async t => {
  const store = storeAt(profile(t));
  for (const type of ["response.failed", "response.incomplete"]) {
    const session = store.createSession();
    const start = await session.normalize({ type: "response.output_item.added", output_index: 0,
      item: { type: "message", id: "start", content: [] } });
    const original = { type, response: {
      status: type.slice("response.".length), error: { code: "synthetic_error", message: "synthetic" },
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", id: "terminal", content: [{ type: "output_text", text: "partial" }] }],
    } };
    const terminal = await session.normalize(original);
    assert.equal(terminal.type, type);
    assert.deepEqual(terminal.response.error, original.response.error);
    assert.deepEqual(terminal.response.incomplete_details, original.response.incomplete_details);
    assert.equal(terminal.response.output[0].id, start.item.id);
    assert.deepEqual((await store.restoreRequest({ input: terminal.response.output })).input, original.response.output);
  }
});

test("bridge restores original IDs and metadata across restart and non-streaming follow-up", async t => {
  const bridge = await responsesBridge(profile(t), t, async (_req, res, body, number) => {
    if (number === 1) {
      res.writeHead(200, { "content-type": "text/event-stream" }).end(encodeEvents(rotatingEvents()));
    } else {
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ id: "raw-nonstream-id", output: body.input }));
    }
  });
  try {
    const first = await fetch(`${bridge.url}/responses`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "synthetic-model", input: "synthetic", stream: true }) });
    assert.equal(first.status, 200);
    const normalized = parse(await first.text());
    const output = normalized.at(-1).response.output;
    await bridge.restart();
    const second = await fetch(`${bridge.url}/responses`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "synthetic-model", input: output, stream: false }) });
    assert.equal(second.status, 200);
    assert.deepEqual(bridge.requests[1].input, rotatingEvents().at(-1).response.output);
    assert.deepEqual(await second.json(), { id: "raw-nonstream-id", output: bridge.requests[1].input });
    const files = fs.readdirSync(path.join(bridge.profile, "response-identities/v1"), { recursive: true });
    assert.ok(files.some(file => String(file).endsWith(".json")));
  } finally { await bridge.close(); }
});

test("bridge rejects missing local identity before any provider request", async t => {
  const bridge = await responsesBridge(profile(t), t, async (_req, res) => res.writeHead(500).end());
  try {
    const response = await fetch(`${bridge.url}/responses`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "synthetic-model", input: [{
        type: "item_reference", id: "ccodex_item_v1_00000000-0000-0000-0000-000000000000_0",
      }] }) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_response_item_id");
    assert.equal(bridge.requests.length, 0);
  } finally { await bridge.close(); }
});

test("client cancellation aborts the provider stream and never retries an already-started response", async t => {
  let upstreamClosed = false;
  const bridge = await responsesBridge(profile(t), t, async (_req, res) => {
    res.once("close", () => { upstreamClosed = true; });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(encodeEvents(rotatingEvents().slice(0, 2)));
  });
  try {
    const controller = new AbortController();
    const response = await fetch(`${bridge.url}/responses`, { method: "POST",
      signal: controller.signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "synthetic-model", input: "synthetic", stream: true }) });
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    controller.abort();
    await reader.cancel().catch(() => {});
    await waitFor("provider request aborted", () => upstreamClosed);
    assert.equal(bridge.requests.length, 1);
    const audit = path.join(bridge.profile, "request-audit-latest.json");
    await waitFor("cancelled request audit", () => fs.existsSync(audit)
      && JSON.parse(fs.readFileSync(audit, "utf8")).status === "cancelled");
  } finally { await bridge.close(); }
});

for (const [terminalType, status] of [
  [null, "incomplete"], ["response.incomplete", "incomplete"], ["response.failed", "error"],
]) {
  test(`bridge does not report ${terminalType || "premature EOF"} as successful completion`, async t => {
    const events = rotatingEvents().slice(0, 2);
    if (terminalType) events.push({ type: terminalType, response: {
      id: "resp_rotating", status: terminalType.slice("response.".length), output: [],
      error: { code: "synthetic_error", message: "synthetic" },
      incomplete_details: { reason: "max_output_tokens" },
    } });
    const bridge = await responsesBridge(profile(t), t, async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" }).end(encodeEvents(events));
    });
    try {
      const response = await fetch(`${bridge.url}/responses`, { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "synthetic-model", input: "synthetic", stream: true }) });
      const received = parse(await response.text());
      assert.equal(received.some(event => event.type === "response.completed"), false);
      assert.deepEqual(received.map(event => event.type), [
        ...events.map(event => event.type), ...(!terminalType ? ["response.failed"] : []),
      ]);
      if (!terminalType) {
        assert.equal(received.at(-1).response.error.code, "upstream_stream_incomplete");
        assert.equal(received.at(-1).response.usage, null);
      }
      assert.equal(bridge.requests.length, 1);
      const audit = path.join(bridge.profile, "request-audit-latest.json");
      await waitFor("non-success audit", () => fs.existsSync(audit)
        && JSON.parse(fs.readFileSync(audit, "utf8")).status === status);
    } finally { await bridge.close(); }
  });
}
