import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { GatewayProtocol } from "../gateway/protocol.mjs";
import { ThreadStore, readThreadOwnership } from "../gateway/state.mjs";
import { AppServerRouter } from "../gateway/router.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";

const connection = { initialized: true, send() {}, request: async () => ({ answers: { permission: { answers: ["Deny"] } } }) };
test("an existing chat rejects execution switching before changing ownership or runtime state", async t => {
  const f = fixture(t), { thread } = await f.call("thread/start", { cwd: f.home, model: "first/model" });
  await f.send(thread.id, "PRESERVED_HISTORY");
  const before = f.protocol.store.get(thread.id);
  await assert.rejects(f.call("thread/execution/switch", { threadId: thread.id, model: "second/model" }), /创建后|固定|新建/);
  assert.deepEqual(f.protocol.store.get(thread.id), before);
  assert.equal(f.calls.length, 1);
  await f.restart(); await f.send(thread.id, "CONTINUE_ORIGINAL");
  assert.equal(f.calls.at(-1).engine, "first");
  assert.equal(f.calls.at(-1).nativeSessionId, before.nativeSessionId);
});
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "switch-")), directory = path.join(home, "threads"), calls = [], events = [];
  let serial = 0;
  const adapter = name => ({ adapter: name, supportsModelSwitch: true, approvalModes: ["ask", "auto", "deny"],
    models: async () => ["model", "other"].map(id => ({ id, supportedReasoningEfforts: ["low", "high"] })),
    run: async context => { calls.push({ engine: name, prompt: context.prompt, nativeSessionId: context.nativeSessionId, policy: context.getApprovalMode() });
      context.onSession(context.nativeSessionId || `${name}-${++serial}`); context.onText(`${name}-reply`); } });
  const engines = new Map([["first", adapter("first")], ["second", adapter("second")]]);
  let protocol;
  const open = () => protocol = new GatewayProtocol({ home, store: new ThreadStore(directory), engines, defaultEngine: "first", notify: (method, params) => events.push({ method, params }) }); open();
  t.after(async () => { await protocol.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, directory, engines, calls, events, get protocol() { return protocol; },
    call: (method, params = {}) => protocol.handle(method, params, connection),
    send: async (id, text) => { await protocol.handle("turn/start", { threadId: id, input: [{ type: "text", text }] }, connection); await protocol.active.get(id)?.done; },
    restart: async () => { await protocol.close(); open(); } };
}
test("supported model changes retain the same engine, runtime, history and approval mode", async t => {
  const f = fixture(t), { thread } = await f.call("thread/start", { cwd: f.home, model: "first/model", cliApprovalMode: "auto" });
  await f.call("thread/name/set", { threadId: thread.id, name: "Preserved title" });
  await f.send(thread.id, "HISTORY_SENTINEL");
  const original = f.protocol.store.get(thread.id), turnId = original.turns[0].id;
  await f.call("thread/settings/update", { threadId: thread.id, model: "first/other" });
  assert.equal(f.calls.length, 1, "A model setting never submits inference or replays tools");
  assert.equal(f.protocol.store.get(thread.id).nativeSessionId, original.nativeSessionId);
  await f.restart();
  const resumed = (await f.call("thread/resume", { threadId: thread.id })).thread;
  assert.equal(resumed.id, thread.id); assert.equal(resumed.name, "Preserved title"); assert.equal(resumed.cwd, f.home);
  assert.equal(resumed.turns[0].id, turnId); assert.equal(resumed.executionOrigins, undefined);
  await f.send(thread.id, "NEXT_MESSAGE");
  assert.equal(f.calls[1].engine, "first"); assert.equal(f.calls[1].nativeSessionId, original.nativeSessionId); assert.equal(f.calls[1].policy, "auto");
  assert.equal(f.calls[1].prompt, "NEXT_MESSAGE");
  const read = (await f.call("thread/read", { threadId: thread.id })).thread;
  assert.equal(read.model, "first/other"); assert.equal(read.turns.length, 2);
});

test("busy, stale or unavailable switches preserve the committed engine and do not start a replacement", async t => {
  const f = fixture(t), { thread } = await f.call("thread/start", { cwd: f.home, model: "first/model" });
  let release, enter; const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { enter = resolve; });
  f.engines.get("first").run = async () => { enter(); await held; };
  t.after(() => release());
  await f.call("turn/start", { threadId: thread.id, input: [{ type: "text", text: "running" }] }); await entered;
  await assert.rejects(f.call("thread/execution/switch", { threadId: thread.id, model: "second/model" }), /固定/);
  release(); await f.protocol.active.get(thread.id)?.done;
  const snapshot = f.protocol.store.get(thread.id);
  await assert.rejects(f.call("thread/execution/switch", { threadId: thread.id, model: "second/missing" }));
  await assert.rejects(f.call("thread/execution/switch", { threadId: thread.id, model: "second/model", expectedModel: "stale/model" }), /固定/);
  assert.deepEqual(f.protocol.store.get(thread.id), snapshot);
});

test("settings, sends and native adoption cannot bypass the engine binding", async t => {
  const f = fixture(t), { thread } = await f.call("thread/start", { cwd: f.home, model: "first/model" });
  await f.send(thread.id, "IMPORTANT_HISTORY");
  const before = f.protocol.store.get(thread.id);
  await assert.rejects(f.call("thread/settings/update", { threadId: thread.id, model: "second/model" }), /cannot change CLI engines/);
  await assert.rejects(f.call("turn/start", { threadId: thread.id, model: "second/model", input: [{ type: "text", text: "do not send" }] }), /cannot change CLI engines/);
  const id = randomUUID();
  await assert.rejects(f.call("gateway/thread/adopt", { threadId: id, model: "second/model", nativeThread: { id, cwd: f.home, turns: [] } }), /固定/);
  assert.deepEqual(f.protocol.store.get(thread.id), before); assert.equal(f.protocol.store.threads.has(id), false); assert.equal(f.calls.length, 1);
  f.engines.get("first").supportsModelSwitch = false;
  await assert.rejects(f.call("thread/settings/update", { threadId: thread.id, model: "first/other" }), /does not support switching/);
  assert.deepEqual(f.protocol.store.get(thread.id), before);
});

test("deleting a switched CLI chat cleans every owned runtime archive and preserves a durable pending cleanup on failure", async t => {
  const f = fixture(t), cleaned = [];
  let fail = true;
  f.engines.get("first").deleteSession = async ({ nativeSessionId }) => cleaned.push(nativeSessionId);
  f.engines.get("second").deleteSession = async ({ nativeSessionId }) => { if (fail) throw new Error("fixture archive offline"); cleaned.push(nativeSessionId); };
  const { thread } = await f.call("thread/start", { cwd: f.home, model: "first/model" });
  await f.send(thread.id, "private old history");
  const legacy = f.protocol.store.get(thread.id);
  legacy.executionOrigins = [{ engineId: "first", engineAdapter: "first", nativeSessionId: legacy.nativeSessionId, model: legacy.model }];
  Object.assign(legacy, { engineId: "second", engineAdapter: "second", model: "second/model", modelProvider: "second", nativeSessionId: "second-2", executionHandoff: true });
  f.protocol.store.save(legacy); await f.restart(); await f.send(thread.id, "private new history");
  await assert.rejects(f.call("thread/delete", { threadId: thread.id }), /清理/);
  assert.deepEqual(cleaned, ["first-1"]);
  assert.equal(fs.readFileSync(path.join(f.directory, thread.id + ".json"), "utf8").includes("private old history"), false);
  await f.restart(); fail = false; await f.call("thread/delete", { threadId: thread.id });
  assert.deepEqual(cleaned, ["first-1", "second-2"]); assert.equal(f.protocol.store.deleted.get(thread.id).cleanup, "complete");
  assert.equal(readThreadOwnership(f.directory, thread.id).executionHandoff, true);
});

test("legacy gateway-native records can change models within their source but cannot change API sources", async t => {
  const f = fixture(t), engine = f.engines.get("first");
  engine.models = async () => ["api-aaaaaaaaaaaa--one", "api-aaaaaaaaaaaa--two", "api-bbbbbbbbbbbb--three"].map(id => ({ id }));
  const { thread } = await f.call("thread/start", { cwd: f.home, model: "first/api-aaaaaaaaaaaa--one" });
  engine.nativeProvider = true;
  const legacy = f.protocol.store.get(thread.id); legacy.executionHandoff = true; f.protocol.store.save(legacy);
  await f.call("thread/settings/update", { threadId: thread.id, model: "first/api-aaaaaaaaaaaa--two" });
  const before = f.protocol.store.get(thread.id);
  await assert.rejects(f.call("thread/settings/update", { threadId: thread.id, model: "first/api-bbbbbbbbbbbb--three" }), /来源已固定/);
  assert.deepEqual(f.protocol.store.get(thread.id), before);
});

test("a native execution-switch request never reads history or adopts its public identity", async t => {
  const f = fixture(t), id = randomUUID(), toolId = randomUUID();
  const source = { id, model: "native-model", modelProvider: "native", cwd: f.home, name: "Original native chat", updatedAt: 1,
    status: { type: "idle" }, turns: [{ id: randomUUID(), status: "completed", items: [
      { id: randomUUID(), type: "userMessage", content: [{ type: "text", text: "native user" }] },
      { id: toolId, type: "commandExecution", command: "echo historic", aggregatedOutput: "historic result", status: "completed" },
      { id: randomUUID(), type: "agentMessage", text: "native reply" }] }] };
  const nativeCalls = [], output = []; let router;
  const native = new RpcPeer(message => { nativeCalls.push(message.method); queueMicrotask(() => native.receive({ id: message.id, result: message.method === "initialize" ? {}
    : message.method === "thread/turns/list" ? { data: source.turns, nextCursor: null }
    : message.method === "thread/list" ? { data: [source], nextCursor: null } : { thread: { ...source, turns: [] } } })); });
  const gateway = new RpcPeer(message => { if (!message.method) return; void f.call(message.method, message.params).then(result => gateway.receive({ id: message.id, result }), error => gateway.receive({ id: message.id, error: { code: -32602, message: error.message } })); });
  router = new AppServerRouter({ native, connectGateway: async () => gateway, cursorSecret: "synthetic-switch-instance-secret", ownsThread: target => readThreadOwnership(f.directory, target), send: message => output.push(message) });
  t.after(() => router.close());
  await router.receive({ id: 1, method: "initialize", params: {} });
  await assert.rejects(router.switchExecution(id, "mycodex/second/model"), /固定/);
  assert.equal(readThreadOwnership(f.directory, id), null);
  assert.deepEqual(nativeCalls, ["initialize"]);
  await router.receive({ id: 2, method: "thread/list", params: { limit: 100 } });
  assert.deepEqual(output.find(message => message.id === 2).result.data.map(row => row.id), [id]);
  assert.equal(f.calls.length, 0);
});
