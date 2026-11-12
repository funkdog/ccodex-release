import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AppServerRouter } from "../gateway/router.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { ThreadStore, readThreadOwnership } from "../gateway/state.mjs";
import { GatewayProtocol, pinnedSectionId } from "../gateway/protocol.mjs";

const secret = "synthetic-pagination-secret-not-a-credential";
function peer(handler) {
  const sent = [];
  const result = new RpcPeer(message => {
    sent.push(structuredClone(message));
    if (!message.method || !Object.hasOwn(message, "id")) return;
    Promise.resolve().then(() => handler(message)).then(response => result.receive({ id: message.id, ...response }), error => result.receive({ id: message.id, error: { code: -32000, message: error.message } }));
  });
  result.sent = sent;
  return result;
}
async function fixture(t, { nativeHandler, gatewayHandler, ownsThread = id => id === "external-thread", unavailable = false, cursorSecret = secret,
  connectGateway, connectProvider, discoveryTimeoutMs, modelDiscoveryTimeoutMs, copilotProvider, googleProvider } = {}) {
  const native = peer(nativeHandler || (message => ({ result: { method: message.method, params: message.params, native: true } })));
  const gateway = peer(gatewayHandler || (message => ({ result: { method: message.method, params: message.params, gateway: true } })));
  const output = [];
  let connects = 0;
  const router = new AppServerRouter({ native, ownsThread, cursorSecret, discoveryTimeoutMs, modelDiscoveryTimeoutMs, copilotProvider, googleProvider, connectProvider, send: message => output.push(structuredClone(message)),
    connectGateway: async () => { connects++; if (unavailable) throw new Error("Synthetic gateway offline"); return connectGateway ? connectGateway(gateway) : gateway; } });
  let next = 1;
  const request = async (method, params = {}, extra = {}) => {
    const message = { id: next++, method, params, ...extra };
    await router.receive(message);
    return output.find(value => value.id === message.id && !value.method);
  };
  t.after(() => router.close());
  const init = { id: 0, method: "initialize", params: { clientInfo: { name: "synthetic", version: "1" }, capabilities: { experimentalApi: true } } };
  await router.receive(init);
  return { router, native, gateway, output, request, connects: () => connects };
}

const draftWrite = (model = "mycodex/antigravity/argon", effort = "high", prefix = "") => ({
  edits: [{ keyPath: prefix + "model", value: model, mergeStrategy: "upsert" },
    { keyPath: prefix + "model_reasoning_effort", value: effort, mergeStrategy: "upsert" }],
  filePath: null, expectedVersion: null, reloadUserConfig: true,
});

test("an empty optional CLI catalogue preserves the native model list, default and provider configuration", async t => {
  const stock = { data: [{ id: "own-native", model: "own-native", isDefault: true, displayName: "My existing provider" }], nextCursor: null };
  const nativeConfig = { config: { model_provider: "own-provider", model: "own-native" } };
  const f = await fixture(t, {
    nativeHandler: message => ({ result: message.method === "model/list" ? stock : message.method === "config/read" ? nativeConfig : {} }),
    gatewayHandler: () => ({ result: { data: [], nextCursor: null } }),
  });
  assert.deepEqual((await f.request("model/list")).result, stock);
  assert.deepEqual((await f.request("config/read")).result, nativeConfig);
  assert.equal(f.native.sent.some(message => message.method?.includes("Write")), false);
});
async function draftFixture(t, metadata = true) {
  return fixture(t, {
    nativeHandler: m => ({ result: m.method === "model/list" ? { data: [], nextCursor: null }
      : m.method === "config/read" ? { config: { model: "native-default", model_reasoning_effort: "medium" },
        layers: metadata ? [{ name: { type: "user", file: "/native/config.toml" }, version: "native-version" }] : [] } : {} }),
    gatewayHandler: m => ({ result: m.method === "model/list" ? { data: [{ id: "antigravity/argon", model: "antigravity/argon",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }], nextCursor: null }
      : { thread: { id: "external-thread", model: m.params.model }, model: m.params.model } }),
  });
}
test("host RPC draft settings are acknowledged as a window override without any native configuration write", async t => {
  const f = await draftFixture(t);
  for (const prefix of ["", "profiles.work."]) {
    const response = await f.request("config/batchWrite", draftWrite(undefined, "high", prefix), { jsonrpc: "2.0" });
    assert.equal(response.error, undefined);
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.result.status, "okOverridden");
    assert.equal(response.result.filePath, "/native/config.toml");
    assert.equal(response.result.version, "native-version", "No invented config revision");
    assert.match(response.result.overriddenMetadata.message, /not written/);
    assert.deepEqual(response.result.overriddenMetadata.effectiveValue, { model: "native-default", model_reasoning_effort: "medium" });
  }
  assert.equal(f.native.sent.some(m => m.method?.startsWith("config/") && m.method !== "config/read"), false);
  // This follows the native UI's existing okOverridden branch. No renderer
  // manager or message-bus hooks participate in the host RPC path.
  await f.request("thread/start", { model: "mycodex/antigravity/argon", effort: "high", approvalPolicy: "never" });
  assert.equal(f.gateway.sent.at(-1).params.model, "antigravity/argon");
  assert.equal(f.gateway.sent.at(-1).params.effort, "high");
  assert.equal(f.gateway.sent.at(-1).params.approvalPolicy, "never");
});
test("draft compatibility rejects mixed writes, persistent targets, unknown shapes/models/efforts and missing native metadata", async t => {
  const f = await draftFixture(t);
  const base = draftWrite();
  for (const params of [
    { ...base, edits: [...base.edits, { keyPath: "approval_policy", value: "never", mergeStrategy: "upsert" }] },
    { ...base, filePath: "/other/config.toml" }, { ...base, expectedVersion: "must-match" },
    { ...base, reloadUserConfig: false }, { ...base, unknown: true },
    { ...base, edits: [base.edits[0], base.edits[0]] },
    draftWrite("mycodex/antigravity/missing"), draftWrite(undefined, "ultra"),
    draftWrite(undefined, "high", "profiles.a.b."),
  ]) assert.ok((await f.request("config/batchWrite", params)).error, JSON.stringify(params));
  assert.equal(f.native.sent.some(m => m.method === "config/batchWrite"), false);
  const missing = await draftFixture(t, false);
  assert.ok((await missing.request("config/batchWrite", base)).error);
  assert.equal(missing.native.sent.some(m => m.method === "config/batchWrite"), false);
});

test("Desktop pin discovery merges real gateway pins with native pins instead of silently dropping them", async t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"cc-pin-router-"));
  const store=new ThreadStore(path.join(home,"threads"));
  const protocol=new GatewayProtocol({home,store,engines:new Map([["copilot",{adapter:"fixture",models:async()=>[{id:"model"}],run:async()=>{}}]]),defaultEngine:"copilot",notify(){}});
  t.after(async()=>{await protocol.close();fs.rmSync(home,{recursive:true,force:true});});
  const connection={initialized:true,send(){},request:async()=>({answers:{}})};
  const {thread}=await protocol.handle("thread/start",{cwd:home,model:"copilot/model"},connection);
  const f=await fixture(t,{ownsThread:id=>store.threads.has(id),
    nativeHandler:message=>({result:message.method==="thread/list"?{data:[{id:"native-pin",section:{id:pinnedSectionId,name:"Pinned"}}],nextCursor:null}:{}}),
    gatewayHandler:async message=>({result:await protocol.handle(message.method,message.params,connection)})});
  assert.equal((await f.request("thread/section/move",{threadId:thread.id,sectionId:pinnedSectionId})).error,undefined);
  const response=await f.request("thread/list",{cursor:null,limit:100,modelProviders:[],sectionId:pinnedSectionId,sortKey:"section_position",sourceKinds:["appServer"],useStateDbOnly:true});
  assert.equal(response.error,undefined);
  assert.deepEqual(response.result.data.map(t=>t.id),["native-pin",thread.id]);
  assert.equal(response.result.data[1].model,"mycodex/copilot/model");
});

test("native identity, auth, config, unknown extensions, response metadata and IDs remain transparent", async t => {
  const f = await fixture(t, { nativeHandler: message => message.method === "unsupported/future"
    ? { jsonrpc: "2.0", error: { code: -32042, message: "native error", data: { retry: false } } }
    : { jsonrpc: "2.0", result: { ...message.params, originalNative: true }, extra: "preserved" } });
  assert.equal(f.connects(), 0);
  for (const method of ["account/read", "getAuthStatus", "config/read", "plugin/list", "native/futureExtension"]) {
    const reply = await f.request(method, { keep: ["mycodex/not-a-model", { nested: true }] }, { jsonrpc: "2.0" });
    assert.equal(reply.result.originalNative, true);
    assert.equal(reply.extra, "preserved");
    assert.equal(reply.jsonrpc, "2.0");
    assert.equal(f.native.sent.at(-1).id, reply.id);
  }
  assert.deepEqual((await f.request("unsupported/future")).error, { code: -32042, message: "native error", data: { retry: false } });
  assert.equal(f.connects(), 0);
});

test("native Google and native Copilot cannot exchange thread providers or change the global provider", async t => {
  const f = await fixture(t, { copilotProvider: { bridgeHome: "/private/copilot", bridgePort: 22690 },
    googleProvider: { cliHome: "/private/google", bridgePort: 22691 }, ownsThread: () => false,
    nativeHandler: message => ({ result: message.method === "initialize" ? {} : {
      model: message.params.model, modelProvider: message.params.modelProvider,
      thread: { id: message.params.modelProvider, modelProvider: message.params.modelProvider, turns: [] },
    } }) });
  const google = await f.request("thread/start", { model: "mycodex/codex-gemini/gemini-test", sandbox: "workspace-write" });
  assert.equal(google.result.modelProvider, "mycodex-google");
  assert.equal(google.result.thread.nativeProvider, "mycodex-google");
  assert.equal(f.native.sent.at(-1).params.config.model_catalog_json, "/private/google/codex-models.json");
  const before = f.native.sent.length;
  assert.match((await f.request("turn/start", { threadId: "mycodex-google", model: "mycodex/codex-copilot/gpt-test" })).error.message, /cannot switch/);
  assert.match((await f.request("config/batchWrite", { edits: [{ keyPath: "model_provider", value: "mycodex-google" }] })).error.message, /cannot be written/);
  assert.equal(f.native.sent.length, before); assert.equal(f.connects(), 0);
});
test("Codex + Copilot creates and resumes native threads without gateway inference or native profile writes", async t => {
  const provider = { bridgeHome: "/private/copilot", bridgePort: 22690 };
  const f = await fixture(t, { copilotProvider: provider, ownsThread: id => id === "existing-cli",
    nativeHandler: message => ({ result: message.method === "initialize" ? {} : {
      model: "gpt-test", modelProvider: "mycodex-copilot",
      thread: { id: "native-bridge", modelProvider: "mycodex-copilot", turns: [] },
    } }) });
  const started = await f.request("thread/start", { model: "mycodex/codex-copilot/gpt-test",
    sandbox: "workspace-write", cwd: "/tmp" });
  assert.equal(started.result.thread.model, "mycodex/codex-copilot/gpt-test");
  assert.equal(f.native.sent.at(-1).params.modelProvider, "mycodex-copilot");
  assert.equal(f.native.sent.at(-1).params.sandbox, "workspace-write");
  assert.equal(f.native.sent.at(-1).params.config.model_catalog_json, "/private/copilot/models.json");
  const resume = { threadId: "native-bridge", model: null };
  await f.request("thread/resume", resume);
  assert.equal(f.native.sent.at(-1).params.model, "gpt-test", "Native resume must restore the thread's own model");
  assert.equal(f.native.sent.at(-1).params.modelProvider, "mycodex-copilot");
  assert.equal(f.native.sent.at(-1).params.config.model_catalog_json, "/private/copilot/models.json");
  const image = { type: "image", url: "data:image/png;base64,fixture" };
  await f.request("turn/start", { threadId: "native-bridge", model: "mycodex/codex-copilot/gpt-test", input: [image],
    collaborationMode: { mode: "default", settings: { model: "mycodex/codex-copilot/gpt-test", reasoning_effort: "xhigh" } } });
  assert.deepEqual(f.native.sent.at(-1).params.input, [image]);
  assert.equal(f.native.sent.at(-1).params.collaborationMode.settings.model, "gpt-test");
  assert.equal(f.connects(), 0);
  const before = f.native.sent.length;
  for (const threadId of ["existing-cli", "ordinary-native"])
    assert.ok((await f.request("thread/resume", { threadId, model: "mycodex/codex-copilot/gpt-test" })).error);
  assert.equal(f.native.sent.length, before);
});
test("provider turn notifications use the same native provider process as the thread", async t => {
  const provider = peer(message => ({ result: message.method === "thread/start"
    ? { model: "gpt-test", modelProvider: "mycodex-copilot", thread: { id: "provider-notification", modelProvider: "mycodex-copilot" } } : {} }));
  const f = await fixture(t, { ownsThread: () => false,
    copilotProvider: { bridgeHome: "/private/copilot", bridgePort: 22690 },
    connectProvider: async id => { assert.equal(id, "mycodex-copilot"); return provider; } });
  await f.request("thread/start", { model: "mycodex/codex-copilot/gpt-test" });
  await f.router.receive({ method: "turn/interrupt", params: { threadId: "provider-notification", turnId: "test-turn" } });
  assert.equal(provider.sent.at(-1).method, "turn/interrupt");
  assert.equal(f.native.sent.some(message => message.method === "turn/interrupt"), false);
});
test("explicit third-party creation and stored ownership route only to the gateway", async t => {
  const owned = new Set();
  const f = await fixture(t, { ownsThread: id => owned.has(id), gatewayHandler: message => {
    if (message.method === "thread/start") {
      owned.add("new-external");
      return { result: { model: message.params.model, modelProvider: "claude", thread: {
        id: "new-external", model: message.params.model, modelProvider: "claude", preview: "mycodex/ordinary text" } } };
    }
    if (message.method === "thread/future") return { error: { code: -32601, message: "unsupported by selected CLI" } };
    return { result: { received: message.params } };
  } });
  const started = await f.request("thread/start", { model: "mycodex/claude/sonnet", cwd: "/tmp" });
  assert.equal(started.result.thread.model, "mycodex/claude/sonnet");
  assert.equal(started.result.thread.modelProvider, "mycodex:claude");
  assert.equal(started.result.thread.preview, "mycodex/ordinary text");
  assert.equal(f.gateway.sent.find(message => message.method === "thread/start").params.model, "claude/sonnet");
  const response = await f.request("turn/start", { threadId: "new-external", input: [{ type: "text", text: "native text" }] });
  assert.equal(response.result.received.threadId, "new-external");
  assert.equal((await f.request("thread/future", { threadId: "new-external" })).error.code, -32601);
  assert.deepEqual(f.native.sent.map(message => message.method), ["initialize"]);
});

test("native provider model settings and collaboration snapshots round-trip without leaking or duplicating aliases", async t => {
  const f = await fixture(t, { copilotProvider: { bridgeHome: "/private/copilot", bridgePort: 22690 }, ownsThread: () => false,
    nativeHandler: message => ({ result: message.method === "initialize" ? {} : message.method === "thread/start"
      ? { model: "gpt-original", modelProvider: "mycodex-copilot", thread: { id: "provider-thread", modelProvider: "mycodex-copilot" } } : {} }) });
  await f.request("thread/start", { model: "mycodex/codex-copilot/gpt-original" });
  const snapshot = { model: "gpt-selected", modelProvider: "mycodex-copilot", effort: "high", sandboxPolicy: { type: "readOnly" },
    collaborationMode: { mode: "default", settings: { model: "gpt-selected", reasoning_effort: "high", developer_instructions: "keep exactly" } } };
  f.native.receive({ method: "thread/settings/updated", params: { threadId: "provider-thread", threadSettings: snapshot } });
  const visible = f.output.at(-1).params.threadSettings;
  assert.equal(visible.model, "mycodex/codex-copilot/gpt-selected");
  assert.equal(visible.collaborationMode.settings.model, visible.model);
  assert.deepEqual(snapshot.sandboxPolicy, visible.sandboxPolicy);
  assert.equal(snapshot.model, "gpt-selected", "Mapping must not mutate native data");
  await f.request("turn/start", { threadId: "provider-thread", model: "gpt-selected", collaborationMode: visible.collaborationMode });
  assert.equal(f.native.sent.at(-1).params.model, "gpt-selected");
  assert.equal(f.native.sent.at(-1).params.collaborationMode.settings.model, "gpt-selected");
  assert.equal(f.native.sent.at(-1).params.collaborationMode.settings.developer_instructions, "keep exactly");
  assert.equal(f.router.providerThreads.get("provider-thread").model, "gpt-selected");
  const again = f.router.nativeResult({ threadId: "provider-thread", threadSettings: visible });
  assert.equal(again.threadSettings.model, visible.model);
  assert.equal(again.threadSettings.collaborationMode.settings.model, visible.model);
  const effort = await f.request("thread/settings/update", { threadId: "provider-thread", model: visible.model,
    effort: "xhigh", multiAgentMode: "explicitRequestOnly" });
  assert.equal(effort.error, undefined);
  assert.equal(f.native.sent.at(-1).params.model, "gpt-selected");
  assert.equal(f.native.sent.at(-1).params.effort, "xhigh");
  assert.equal(f.native.sent.at(-1).params.multiAgentMode, "explicitRequestOnly");
  const nativeCalls = f.native.sent.length;
  const mixed = await f.request("thread/settings/update", { threadId: "provider-thread", model: "mycodex/copilot/gpt-selected",
    effort: "xhigh", collaborationMode: visible.collaborationMode });
  assert.equal(mixed.error.code, -32602);
  assert.equal(f.native.sent.length, nativeCalls, "A reasoning update must not weaken engine isolation");
  const ordinary = { threadId: "ordinary", threadSettings: { model: "gpt-native", modelProvider: "openai",
    collaborationMode: { mode: "default", settings: { model: "gpt-native" } } } };
  assert.deepEqual(f.router.nativeResult(ordinary), ordinary);
  assert.equal(f.connects(), 0);
});
test("cross-engine resumes and mixed-thread operations are rejected before either backend", async t => {
  const f = await fixture(t);
  for (const params of [
    { threadId: "native-thread", model: "mycodex/claude/sonnet" },
    { threadId: "external-thread", model: "gpt-native" },
    { threadId: "external-thread", parentThreadId: "native-thread" },
  ]) assert.equal((await f.request("thread/resume", params)).error.code, -32602);
  assert.equal(f.native.sent.length, 1);
  assert.equal(f.gateway.sent.length, 0);
});
test("native config cannot be polluted by a foreign model or a partially applied mixed batch", async t => {
  const f = await fixture(t);
  const rejected = await f.request("config/batchWrite", { edits: [
    { keyPath: "analytics.enabled", value: false }, { keyPath: "model", value: "mycodex/copilot/gemini" },
  ] });
  assert.equal(rejected.error.code, -32602);
  assert.equal(f.native.sent.length, 1);
  await f.request("config/value/write", { keyPath: "model", value: "native-model" });
  assert.equal(f.native.sent.at(-1).params.value, "native-model");
});
test("reverse requests with equal native/gateway IDs cannot cross-wire answers", async t => {
  const f = await fixture(t);
  await f.request("thread/read", { threadId: "external-thread" });
  for (const backend of [f.native, f.gateway]) backend.receive({ id: 7, method: "item/tool/requestUserInput", params: { question: "unchanged" } });
  const questions = f.output.filter(message => message.method === "item/tool/requestUserInput");
  assert.equal(questions.length, 2);
  assert.notEqual(questions[0].id, questions[1].id);
  await f.router.receive({ id: questions[1].id, result: { answer: "gateway-only" } });
  await f.router.receive({ id: questions[0].id, error: { code: -1, message: "native-denial" } });
  assert.deepEqual(f.gateway.sent.at(-1), { id: 7, result: { answer: "gateway-only" } });
  assert.deepEqual(f.native.sent.at(-1), { id: 7, error: { code: -1, message: "native-denial" } });
  const before = f.gateway.sent.length;
  await f.router.receive({ id: questions[1].id, result: { answer: "duplicate" } });
  assert.equal(f.gateway.sent.length, before);
});
test("disconnect rejects pending reviews and late responses cannot approve another connection", async t => {
  const f = await fixture(t);
  await f.request("thread/read", { threadId: "external-thread" });
  f.native.receive({ id: 1, method: "approval", params: {} });
  f.gateway.receive({ id: 1, method: "approval", params: {} });
  const old = f.output.filter(message => message.method === "approval");
  await f.router.close();
  assert.ok(f.native.sent.at(-1).error);
  assert.ok(f.gateway.sent.at(-1).error);
  const fresh = await fixture(t);
  await fresh.router.receive({ id: old[0].id, result: { allowed: true } });
  assert.equal(fresh.native.sent.length, 1);
});
test("gateway failure leaves native lists and tasks intact, but never retries a CLI task natively", async t => {
  const expected = { data: [{ id: "native", model: "native", isDefault: true }], nextCursor: "native-cursor", custom: "keep" };
  const f = await fixture(t, { unavailable: true, nativeHandler: () => ({ result: expected }) });
  assert.deepEqual((await f.request("model/list")).result, expected);
  const before = f.native.sent.length;
  assert.match((await f.request("thread/start", { model: "mycodex/copilot/gemini" })).error.message, /offline/);
  assert.match((await f.request("turn/start", { threadId: "external-thread", input: [] })).error.message, /offline/);
  assert.equal(f.native.sent.length, before);
  await f.request("turn/start", { threadId: "native-thread", input: [] });
  assert.equal(f.native.sent.length, before + 1);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
test("slow optional discovery returns native results within its budget and never injects a late reply", { timeout: 2000 }, async t => {
  const held = deferred();
  const expected = { data: [{ id: "n", model: "n", isDefault: true }], nextCursor: null };
  const f = await fixture(t, { discoveryTimeoutMs: 20, modelDiscoveryTimeoutMs: 20, nativeHandler: () => ({ result: expected }),
    gatewayHandler: async message => message.method === "initialize" ? { result: {} } : held.promise });
  t.after(() => held.resolve({ result: { data: [], nextCursor: null } }));
  assert.deepEqual((await f.request("model/list")).result, expected);
  const count = f.output.length;
  held.resolve({ result: { data: [{ id: "claude/m", model: "claude/m" }], nextCursor: null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.output.length, count);
  assert.equal(f.gateway.pending.size, 0);
});
test("cold models outlive the short history budget without losing entire engine groups", { timeout: 2000 }, async t => {
  const held = deferred();
  const f = await fixture(t, { discoveryTimeoutMs: 10, modelDiscoveryTimeoutMs: 1000,
    nativeHandler: () => ({ result: { data: [{ id: "native", model: "native", isDefault: true }], nextCursor: null } }),
    gatewayHandler: async message => message.method === "initialize" ? { result: {} } : held.promise });
  t.after(() => held.resolve({ result: { data: [], nextCursor: null } }));
  const pending = f.request("model/list", { limit: 100 });
  await new Promise(resolve => setTimeout(resolve, 40));
  // History must remain responsive even while engines are still discovering.
  assert.equal((await f.request("thread/list", { limit: 100 })).result.data[0].id, "native");
  held.resolve({ result: { data: ["copilot/cli", "codex-copilot/api", "antigravity/gemini"]
    .map(model => ({ id: model, model })), nextCursor: null } });
  const result = (await pending).result;
  assert.deepEqual(result.data.map(m => m.model), ["native", "mycodex/copilot/cli", "mycodex/codex-copilot/api", "mycodex/antigravity/gemini"]);
  assert.equal(result.nextCursor, null);
});
test("closing while gateway connection is pending disposes the late connection without initializing it", async t => {
  const held = deferred(), entered = deferred();
  const f = await fixture(t, { connectGateway: async gateway => { entered.resolve(); await held.promise; return gateway; } });
  let disposed = false;
  f.gateway.dispose = async () => { disposed = true; };
  const pending = f.request("thread/read", { threadId: "external-thread" });
  await entered.promise;
  await f.router.close();
  const count = f.output.length;
  held.resolve();
  await pending;
  assert.equal(disposed, true);
  assert.equal(f.gateway.closed, true);
  assert.equal(f.gateway.sent.length, 0);
  assert.equal(f.output.length, count);
});
test("closing during gateway initialization rejects its pending handshake and suppresses later events", async t => {
  const held = deferred(), entered = deferred();
  const f = await fixture(t, { gatewayHandler: async () => { entered.resolve(); return held.promise; } });
  const pending = f.request("thread/read", { threadId: "external-thread" });
  await entered.promise;
  await f.router.close();
  const count = f.output.length;
  await pending;
  held.resolve({ result: {} });
  await new Promise(resolve => setImmediate(resolve));
  f.gateway.receive({ method: "thread/started", params: { thread: { id: "external-thread" } } });
  assert.equal(f.gateway.closed, true);
  assert.equal(f.gateway.pending.size, 0);
  assert.equal(f.output.length, count);
  assert.equal(f.gateway.sent.some(message => message.method === "initialized"), false);
});

function paginated(rows, prefix) {
  return message => {
    if (message.method === "initialize") return { result: { userAgent: prefix } };
    const start = message.params.cursor ? Number(message.params.cursor.slice(prefix.length)) : 0;
    const count = Math.min(message.params.limit ?? 2, 2);
    return { result: { data: rows.slice(start, start + count), nextCursor: start + count < rows.length ? prefix + (start + count) : null } };
  };
}
test("merged history is ordered, lossless and continues across frontends without duplicating page tails", async t => {
  const nativeRows = [{ id: "n9", createdAt: 9 }, { id: "n7", createdAt: 7 }, { id: "n5", createdAt: 5 }, { id: "n1", createdAt: 1 }];
  const gatewayRows = [{ id: "g8", createdAt: 8, model: "claude/m" }, { id: "g7", createdAt: 7 }, { id: "g4", createdAt: 4 }];
  const options = { nativeHandler: paginated(nativeRows, "n"), gatewayHandler: paginated(gatewayRows, "g"), ownsThread: id => id.startsWith("g") };
  const a = await fixture(t, options);
  let page = (await a.request("thread/list", { limit: 2, sortKey: "created_at" })).result;
  assert.deepEqual(page.data.map(row => row.id), ["n9", "g8"]);
  assert.equal(page.data[1].model, "mycodex/claude/m");
  const all = [...page.data];
  const b = await fixture(t, options);
  while (page.nextCursor) {
    const response = await b.request("thread/list", { limit: 2, sortKey: "created_at", cursor: page.nextCursor });
    assert.equal(response.error, undefined);
    page = response.result; all.push(...page.data);
  }
  assert.deepEqual(all.map(row => row.id), ["n9", "g8", "n7", "g7", "n5", "g4", "n1"]);
});
test("merged cursors reject tampering, changed filters and another instance secret", async t => {
  const options = { nativeHandler: paginated([{ id: "n3", createdAt: 3 }, { id: "n1", createdAt: 1 }], "n"),
    gatewayHandler: paginated([{ id: "g2", createdAt: 2 }], "g"), ownsThread: id => id.startsWith("g") };
  const f = await fixture(t, options);
  const first = (await f.request("thread/list", { limit: 1 })).result;
  assert.match((await f.request("thread/list", { limit: 1, archived: true, cursor: first.nextCursor })).error.message, /filters/);
  const corrupt = first.nextCursor.slice(0, -1) + (first.nextCursor.endsWith("a") ? "b" : "a");
  assert.match((await f.request("thread/list", { limit: 1, cursor: corrupt })).error.message, /signature/);
  const other = await fixture(t, { ...options, cursorSecret: "other-instance-test-secret" });
  assert.match((await other.request("thread/list", { limit: 1, cursor: first.nextCursor })).error.message, /signature/);
});
test("Desktop recency ordering merges CLI history using updatedAt when native recency is null", async t => {
  const f = await fixture(t, { nativeHandler: paginated([
    { id: "n9", createdAt: 1, recencyAt: 9, updatedAt: 4 },
    { id: "n5", createdAt: 3, recencyAt: null, updatedAt: 5 },
  ], "n"), gatewayHandler: paginated([
    { id: "g8", createdAt: 8, recencyAt: 8, updatedAt: 8 },
    { id: "g2", createdAt: 9, recencyAt: 2, updatedAt: 2 },
  ], "g"), ownsThread: id => id.startsWith("g") });
  let cursor = null; const ids = [];
  do {
    const reply = await f.request("thread/list", { sortKey: "recency_at", limit: 2, cursor });
    assert.equal(reply.error, undefined);
    ids.push(...reply.result.data.map(thread => thread.id)); cursor = reply.result.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, ["n9", "g8", "n5", "g2"]);
});
test("native opaque cursors remain native and models keep the native default", async t => {
  const f = await fixture(t, { nativeHandler: paginated([{ id: "n", model: "n", isDefault: true }], "n"),
    gatewayHandler: paginated([{ id: "copilot/gemini", model: "copilot/gemini", isDefault: true }], "g") });
  const models = (await f.request("model/list", { limit: 10 })).result.data;
  assert.deepEqual(models.map(model => [model.model, model.isDefault]), [["n", true], ["mycodex/copilot/gemini", false]]);
  const before = f.gateway.sent.length;
  await f.request("model/list", { cursor: "n1" });
  assert.equal(f.gateway.sent.length, before);
  assert.equal(f.native.sent.at(-1).params.cursor, "n1");
});
test("read-only ownership survives gateway downtime and refuses malformed or linked records", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-owner-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const id = randomUUID(); const file = path.join(directory, id + ".json");
  assert.equal(readThreadOwnership(directory, id), null);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, id, engineId: "removed-engine", engineAdapter: "claude-code" }));
  assert.equal(readThreadOwnership(directory, id).engineId, "removed-engine");
  assert.equal(readThreadOwnership(directory, "../../anything"), null);
  fs.writeFileSync(file, "{}");
  assert.throws(() => readThreadOwnership(directory, id), /Corrupt/);
  fs.unlinkSync(file); fs.symlinkSync("/no-such-file", file);
  assert.throws(() => readThreadOwnership(directory, id), /Invalid/);
});

test('native provider forks retain source provider/model/config with qualified models and cold unqualified requests',async t=>{
  const config={bridgeHome:'/fixture/copilot',bridgePort:22690};const forks=[];
  const f=await fixture(t,{copilotProvider:config,nativeHandler:m=>{
    if(m.method==='thread/read')return {result:{thread:{id:'source',model:'gpt-test',modelProvider:'mycodex-copilot'}}};
    if(m.method==='thread/fork'){forks.push(m.params);return {result:{model:m.params.model,modelProvider:m.params.modelProvider,thread:{id:`branch-${forks.length}`,model:m.params.model,modelProvider:m.params.modelProvider,forkedFromId:'source'}}};}
    return {result:{}};
  }});
  for(const extra of [{model:'mycodex/codex-copilot/gpt-test'},{}]){
    const response=await f.request('thread/fork',{threadId:'source',lastTurnId:'turn',...extra});assert.equal(response.error,undefined,response.error?.message);
    assert.equal(response.result.model,'mycodex/codex-copilot/gpt-test');assert.equal(response.result.thread.modelProvider,'mycodex-copilot');
    assert.equal(forks.at(-1).model,'gpt-test');assert.equal(forks.at(-1).modelProvider,'mycodex-copilot');assert.equal(forks.at(-1).config.model_catalog_json,'/fixture/copilot/models.json');
  }
  assert.equal(f.connects(),0,'Provider forks never enter a CLI gateway');
});
test('title search merges native and CLI search envelopes, qualified ownership and cursors',async t=>{
  const f=await fixture(t,{nativeHandler:m=>({result:m.method==='thread/search'?{data:[{thread:{id:'native',model:'gpt',modelProvider:'openai',updatedAt:2},snippet:'Alpha native'}],nextCursor:null}:{}}),
    gatewayHandler:m=>({result:m.method==='thread/search'?{data:[{thread:{id:'external-thread',model:'cli/model',modelProvider:'cli',updatedAt:3},snippet:'Alpha CLI'}],nextCursor:null}:{}})});
  const response=await f.request('thread/search',{searchTerm:'Alpha',sortKey:'updated_at',limit:1});
  assert.equal(response.result.data[0].thread.id,'external-thread');assert.equal(response.result.data[0].thread.model,'mycodex/cli/model');
  assert.ok(response.result.nextCursor);const next=await f.request('thread/search',{searchTerm:'Alpha',sortKey:'updated_at',limit:1,cursor:response.result.nextCursor});
  assert.equal(next.result.data[0].thread.id,'native');assert.equal(next.result.nextCursor,null);
});

test('unfiltered provider history uses the installed all-provider query while explicit filters stay intact',async t=>{
  const f=await fixture(t,{copilotProvider:{bridgeHome:'/fixture/copilot',bridgePort:22690},nativeHandler:()=>({result:{data:[],nextCursor:null}}),gatewayHandler:()=>({result:{data:[],nextCursor:null}})});
  await f.request('thread/list',{modelProviders:null});assert.deepEqual(f.native.sent.at(-1).params.modelProviders,[]);
  await f.request('thread/list',{modelProviders:['openai']});assert.deepEqual(f.native.sent.at(-1).params.modelProviders,['openai']);
});
test('a deleted CLI summary in an old signed cursor cannot reappear after deletion',async t=>{
  let deleted=false;
  const f=await fixture(t,{ownsThread:id=>id==='external-thread'?{engineId:'cli',deleted}:null,
    nativeHandler:()=>({result:{data:[{id:'native',updatedAt:9}],nextCursor:null}}),
    gatewayHandler:()=>({result:{data:[{id:'external-thread',model:'cli/model',updatedAt:1}],nextCursor:null}})});
  const first=await f.request('thread/list',{sortKey:'updated_at',limit:1});assert.equal(first.result.data[0].id,'native');
  deleted=true;const rest=await f.request('thread/list',{sortKey:'updated_at',limit:1,cursor:first.result.nextCursor});
  assert.deepEqual(rest.result.data,[]);assert.equal(rest.result.nextCursor,null);
});

test('provider forks retain named permissions and workspace roots rather than approximating sandbox policies',async t=>{
  const f=await fixture(t,{copilotProvider:{bridgeHome:'/fixture/copilot',bridgePort:22690},nativeHandler:m=>({result:{model:m.params.model,modelProvider:m.params.modelProvider,thread:{id:'branch',modelProvider:m.params.modelProvider}}})});
  f.router.nativeResult({thread:{id:'source',modelProvider:'mycodex-copilot',model:'gpt-test'},model:'gpt-test',reasoningEffort:'high',approvalPolicy:'never',approvalsReviewer:'user',
    sandbox:{type:'workspaceWrite',writableRoots:['/allowed'],networkAccess:false},activePermissionProfile:{id:'restricted-project'},runtimeWorkspaceRoots:['/allowed']});
  const result=await f.request('thread/fork',{threadId:'source'});assert.equal(result.error,undefined,result.error?.message);
  const params=f.native.sent.at(-1).params;assert.equal(params.permissions,'restricted-project');assert.equal(params.sandbox,undefined);
  assert.deepEqual(params.runtimeWorkspaceRoots,['/allowed']);assert.equal(params.approvalPolicy,'never');assert.equal(params.config.model_reasoning_effort,'high');
});
