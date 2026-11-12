import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import { createResponsesWriter } from "../bridge/translate.mjs";
import { startGateway } from "../gateway/server.mjs";
import { connectGateway, readMessages, writeMessage } from "../gateway/ipc.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { createNativeHostPeer } from "../gateway/native-host-peer.mjs";
import { nativeTraceToken, nativeHostToken } from "../gateway/spine-tokens.mjs";
import { HostThreadBroker } from "../gateway/host-threads.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate = Boolean) {
  for (let i = 0; i < 200; i++) { const result = await read(); if (predicate(result)) return result; await delay(10); }
  throw new Error("Isolated host did not reach expected state.");
}
async function fixture(t, spine = { mcp: true }, options = {}) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mc-p3-host-"));
  const config = { home, endpoint: process.platform === "win32" ? `\\\\.\\pipe\\mc-p3-${randomUUID()}` : path.join(home, "s"), token: randomUUID(), generation: "fixture", spine, engines: [], defaultEngine: "fixture" };
  let gateway = await startGateway({ ...config, ...options, engines: new Map() }); const sockets = [];
  const cleanups = [];
  const file = path.join(home, "connection.json"); fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  t.after(async () => {
    // Native shutdown can write checkpoints. Retire owned children before
    // deleting their profiles so they cannot recreate a removed test root.
    const failures = [];
    for (const cleanup of cleanups.reverse()) try { await cleanup(); } catch (error) { failures.push(error); }
    sockets.forEach(socket => socket.destroy()); await gateway.close();
    fs.rmSync(home, { force: true, recursive: true });
    if (failures.length) throw new AggregateError(failures, "Owned P3 test cleanup failed.");
  });
  const connect = async (token = config.token) => {
    let socket;
    const peer = new RpcPeer(message => writeMessage(socket, message));
    socket = await connectGateway({ ...config, token }, message => peer.receive(message)); sockets.push(socket);
    socket.once("close", () => peer.close());
    await peer.request("initialize", { clientInfo: { name: "p3-test", version: "1" } });
    return peer;
  };
  return { home, file, config, get gateway() { return gateway; }, connect, cleanup: operation => cleanups.push(operation),
    restart: async () => { sockets.forEach(socket => socket.destroy()); await gateway.close(); gateway = await startGateway({ ...config, ...options, engines: new Map() }); } };
}
test("existing native peer reads explicit targets and bounded turn results; it cannot send work", async t => {
  const f = await fixture(t), ui = await f.connect(), target = randomUUID(), turnId = randomUUID(), calls = [];
  let account = { type: "chatgpt", email: "isolated@example.test" }, wrongTarget = false, gatewayOwned = false;
  let native;
  native = new RpcPeer(message => {
    calls.push(structuredClone(message));
    queueMicrotask(() => native.receive({ id: message.id, result: message.method === "account/read" ? { account } : message.method === "thread/turns/list" ? {
      data: [{ id: turnId, status: "completed", items: [{ type: "agentMessage", text: "a".repeat(8191) + "🐾" + "tail" }, { type: "commandExecution", aggregatedOutput: "not-an-assistant-result" }] }], nextCursor: null,
    } : {
      thread: { id: wrongTarget ? randomUUID() : message.params.threadId, name: "Requested target", cwd: f.home, status: { type: "idle" }, archived: false,
        turns: [{ id: turnId, status: "completed", items: [{ type: "agentMessage", text: "a".repeat(8191) + "🐾" + "tail" }, { type: "commandExecution", aggregatedOutput: "not-an-assistant-result" }] }] },
    } }));
  });
  const channel = createNativeHostPeer(f.config, native, () => gatewayOwned ? { engineId: "fixture" } : null); f.cleanup(() => channel.close());
  await channel.start();
  const status = await ui.request("diy/host/status", {}), binding = status.bindings[0];
  assert.equal(status.bindings.length, 1); assert.equal(binding.accountVerified, true);
  assert.deepEqual(binding.capabilities, { readState: true, readResult: false, deliver: false, requestIdempotency: false, receiptLookup: false, safeDuringRun: false, openTarget: false });
  const ref = { threadId: target, runtimeId: binding.runtimeId, accountId: binding.accountId, hostId: binding.hostId };
  const state = await ui.request("diy/host/read", { ref });
  assert.equal(state.ref.threadId, target); assert.equal(state.title, "Requested target"); assert.equal(state.status, "idle");
  const first = await ui.request("diy/host/result", { ref, turnId });
  const second = await ui.request("diy/host/result", { ref, turnId, offset: first.nextOffset });
  assert.equal(first.text + second.text, "a".repeat(8191) + "🐾tail"); assert.equal(second.nextOffset, null);
  assert.equal((await ui.request("diy/host/status", {})).bindings[0].capabilities.readResult, true);
  assert.doesNotMatch(first.text + second.text, /not-an-assistant-result/);
  await assert.rejects(ui.request("diy/host/read", { ref: { ...ref, runtimeId: randomUUID() } }), /unavailable/);
  await assert.rejects(ui.request("diy/host/read", { ref: { ...ref, accountId: "0".repeat(64) } }), /unavailable/);
  await assert.rejects(ui.request("diy/host/read", { ref, model: "override" }), /parameters/);
  await assert.rejects(ui.request("diy/host/send", { ref, input: "not-sent" }), /unavailable/);
  wrongTarget = true;
  await assert.rejects(ui.request("diy/host/read", { ref }), /rejected/);
  wrongTarget = false; gatewayOwned = true;
  const before = calls.length;
  await assert.rejects(ui.request("diy/host/read", { ref }), /rejected/); assert.equal(calls.length, before);
  gatewayOwned = false; account = { type: "chatgpt", email: "different@example.test" };
  await assert.rejects(ui.request("diy/host/read", { ref }), /rejected/);
  assert.ok(calls.every(call => ["account/read", "thread/read", "thread/turns/list"].includes(call.method)));
  assert.ok(calls.filter(call => call.method === "thread/read").every(call => call.params.threadId === target));
  await channel.close();
  await until(() => ui.request("diy/host/status", {}), value => !value.bindings.length);
  await assert.rejects(ui.request("diy/host/read", { ref }), /unavailable/);
});
test("host and trace identities cannot impersonate UI or each other; UI cannot register a native runtime", async t => {
  const f = await fixture(t), ui = await f.connect(), host = await f.connect(nativeHostToken(f.config.token, f.config.generation)), trace = await f.connect(nativeTraceToken(f.config.token, f.config.generation));
  const registration = { runtimeId: randomUUID(), hostId: "local:" + "a".repeat(32), accountId: "b".repeat(64), accountVerified: true };
  await assert.rejects(ui.request("gateway/host/register", registration));
  await assert.rejects(trace.request("gateway/host/register", registration), /cannot perform/);
  await assert.rejects(host.request("thread/start", {}), /cannot perform/);
  await assert.rejects(host.request("diy/host/status", {}), /cannot perform/);
  await assert.rejects(trace.request("diy/host/status", {}), /cannot perform/);
  await assert.rejects(host.request("gateway/host/register", { ...registration, capabilities: { deliver: true } }), /Invalid/);
  assert.equal((await host.request("gateway/host/register", registration)).registered, true);
  await assert.rejects(host.request("gateway/host/register", registration), /Duplicate/);
});
test("a slow host has a bounded read budget and shutdown/disconnect never selects another runtime", async () => {
  const broker = new HostThreadBroker(), runtimeId = randomUUID(), hostId = "local:" + "a".repeat(32), accountId = "b".repeat(64);
  let calls = 0;
  const connection = { role: "native-host", initialized: true, request: (_method, _params, signal) => {
    calls++;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  } };
  broker.register({ runtimeId, hostId, accountId, accountVerified: true }, connection);
  const ref = { runtimeId, hostId, accountId, threadId: randomUUID() }, controller = new AbortController();
  const reads = Array.from({ length: 8 }, () => broker.read(ref, controller.signal));
  await assert.rejects(broker.read(ref), /budget exhausted/); assert.equal(calls, 8);
  controller.abort(); await Promise.all(reads.map(read => assert.rejects(read, /cancelled/)));
  broker.disconnect(connection); await assert.rejects(broker.read(ref), /unavailable/);
});
test("installed native runtime delivers to its bound thread, recovers a lost local receipt and exposes the result through MCP", { timeout: 20000 }, async t => {
  const executable = process.env.MYCODEX_TEST_NATIVE_CLI ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  if (!fs.existsSync(executable)) { t.skip("Set MYCODEX_TEST_NATIVE_CLI for actual native transport evidence."); return; }
  const workItemId = randomUUID(), observationId = createHash("sha256").update("offline-source-revision").digest("hex");
  let authority;
  const f = await fixture(t, { mcp: true }, { dispatchAuthority: p => p.workItemId === workItemId && p.observationId === observationId ? authority : undefined,
    verifyDispatchResources: a => fs.readFileSync(path.join(f.home, "workspace-version.txt"), "utf8") === a.resourceVersion });
  fs.writeFileSync(path.join(f.home, "workspace-version.txt"), "fixture-resource-v1");
  const ui = await f.connect(), profile = path.join(f.home, "profile"); fs.mkdirSync(profile, { mode: 0o700 });
  let requests = 0; const providerInputs = [];
  const provider = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/responses") { res.writeHead(404); res.end(); return; }
    const bytes = []; for await (const chunk of req) bytes.push(chunk);
    const body = JSON.parse(Buffer.concat(bytes)); requests++; providerInputs.push(body.input);
    const writer = createResponsesWriter(res, body, new Map());
    writer.pushChunk({ choices: [{ delta: { content: "P3_OFFLINE_NATIVE_RESULT" } }] }); writer.finish();
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  f.cleanup(() => new Promise(resolve => provider.close(resolve)));
  fs.writeFileSync(path.join(profile, "config.toml"), `model = "p3-offline-fixture"\nmodel_provider = "p3-offline"\ncli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[model_providers.p3-offline]\nname = "P3 offline fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../gateway/routed-stdio.mjs"), "app-server"], { cwd: f.home, env: { PATH: process.env.PATH, HOME: f.home, CODEX_HOME: profile, CCODEX_NATIVE_CLI: executable, CCODEX_GATEWAY_CONNECTION: f.file }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
  const native = new RpcPeer(message => writeMessage(child.stdin, message));
  readMessages(child.stdout, message => native.receive(message), error => native.close(error));
  const turns = new Map(); native.onNotification = message => { if (message.method === "turn/completed") turns.set(message.params.turn.id, message.params.turn); };
  const exited = new Promise(resolve => child.once("exit", code => { native.close(new Error(`Native test exited: ${stderr}`)); resolve(code); }));
  f.cleanup(async () => { child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 3000); await exited; clearTimeout(timer); native.close(); });
  await native.request("initialize", { clientInfo: { name: "p3-native-read", version: "1" }, capabilities: { experimentalApi: true } }, { timeoutMs: 5000 });
  native.notify({ method: "initialized" });
  const first = await native.request("thread/start", { cwd: f.home }, { timeoutMs: 5000 });
  const second = await native.request("thread/start", { cwd: f.home }, { timeoutMs: 5000 });
  const status = await until(() => ui.request("diy/host/status", {}), value => value.bindings.length === 1);
  const binding = status.bindings[0], ref = { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: first.thread.id };
  const read = await ui.request("diy/host/read", { ref });
  assert.equal(read.ref.threadId, first.thread.id, stderr); assert.notEqual(read.ref.threadId, second.thread.id); assert.equal(read.cwd, f.home);
  assert.equal(binding.capabilities.deliver, true); assert.equal(binding.capabilities.receiptLookup, true);
  assert.equal(binding.capabilities.requestIdempotency, false); assert.equal(binding.accountVerified, false);
  const actual = await native.request("thread/read", { threadId: first.thread.id, includeTurns: false }); assert.equal(actual.thread.id, first.thread.id);
  const { turn } = await native.request("turn/start", { threadId: first.thread.id, input: [{ type: "text", text: "Return the offline fixture result without tools." }] }, { timeoutMs: 5000 });
  await until(() => turns.get(turn.id));
  assert.equal(turns.get(turn.id).status, "completed", stderr);
  const result = await ui.request("diy/host/result", { ref, turnId: turn.id });
  assert.equal(result.text, "P3_OFFLINE_NATIVE_RESULT"); assert.equal(result.status, "completed");
  assert.equal((await ui.request("diy/host/status", {})).bindings[0].capabilities.readResult, true);
  assert.equal(requests, 1, "Host reads must not start or replay inference");
  const mcp = await native.request("mcpServerStatus/list", {}, { timeoutMs: 5000 });
  assert.match(JSON.stringify(mcp), /mycodex\.host_read/); assert.match(JSON.stringify(mcp), /mycodex\.host_status/);
  const connectMcp = async () => {
    const mcpChild = spawn(process.execPath, [path.resolve(import.meta.dirname, "../gateway/spine/mcp-server.mjs"), f.file], {
    cwd: f.home, env: { PATH: process.env.PATH, HOME: f.home, CODEX_HOME: profile }, stdio: ["pipe", "pipe", "pipe"],
  });
  mcpChild.stderr.resume();
  const mcpPeer = new RpcPeer(message => writeMessage(mcpChild.stdin, { jsonrpc: "2.0", ...message }));
  readMessages(mcpChild.stdout, message => mcpPeer.receive(message), error => mcpPeer.close(error));
  const mcpExited = new Promise(resolve => mcpChild.once("exit", code => { mcpPeer.close(); resolve(code); }));
  f.cleanup(async () => { mcpChild.stdin.end(); const timer = setTimeout(() => mcpChild.kill("SIGKILL"), 3000); await mcpExited; clearTimeout(timer); });
    await mcpPeer.request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "p3-reader", version: "1" }, capabilities: {} }, { timeoutMs: 5000 });
    mcpPeer.notify({ method: "notifications/initialized" });
    return { mcpChild, mcpPeer, mcpExited };
  };
  let { mcpChild, mcpPeer, mcpExited } = await connectMcp();
  const mcpRead = await mcpPeer.request("tools/call", { name: "mycodex.host_read", arguments: { ref } });
  assert.equal(mcpRead.isError, false); assert.equal(JSON.parse(mcpRead.content[0].text).ref.threadId, first.thread.id);
  const mcpResult = await mcpPeer.request("tools/call", { name: "mycodex.host_result", arguments: { ref, turnId: turn.id } });
  assert.equal(mcpResult.isError, false); assert.equal(JSON.parse(mcpResult.content[0].text).text, "P3_OFFLINE_NATIVE_RESULT");
  assert.equal(requests, 1);
  authority = { briefRevision: 1, policyRevision: 1, responsible: ref, workspace: f.home, resourceVersion: "fixture-resource-v1", instructions: "Use the offline fixture only. Reply with the local synthetic result without tools or external writes.", enabled: true, paused: false, takeover: false, maxInputBytes: 16384, maxAttempts: 2 };
  let dispatch = f.gateway.dispatch;
  const request = { workItemId, observationId, action: "continue", briefRevision: 1, policyRevision: 1, message: "P3_OFFLINE_AUTOMATIC_CONTINUATION. Reply without tools." };
  const queued = await dispatch.enqueue(request);
  assert.equal(queued.state, "queued");
  const save = dispatch.store.save.bind(dispatch.store); let loseAcceptedWrite = true;
  dispatch.store.save = (record, expected) => {
    if (loseAcceptedWrite && record.state === "accepted") { loseAcceptedWrite = false; throw new Error("Synthetic process failure before storing accepted receipt."); }
    return save(record, expected);
  };
  await assert.rejects(dispatch.process(queued.id), /Synthetic process failure/);
  assert.equal(dispatch.get(queued.id).state, "dispatching");
  dispatch.store.save = save;
  // Restart only the owned gateway. The same native child keeps its execution
  // and runtime receipt map; a fresh gateway must query that original receipt.
  await f.restart();
  await mcpExited;
  const reconnectedUi = await f.connect();
  const rebound = await until(() => reconnectedUi.request("diy/host/status", {}), value => value.bindings.length === 1);
  assert.equal(rebound.bindings[0].runtimeId, binding.runtimeId);
  dispatch = f.gateway.dispatch;
  await dispatch.process(queued.id); assert.equal(dispatch.get(queued.id).state, "accepted");
  const acceptedTurnId = dispatch.get(queued.id).receipt.turnId;
  await until(() => turns.get(acceptedTurnId));
  await dispatch.process(queued.id);
  const settled = dispatch.get(queued.id);
  assert.equal(settled.state, "settled"); assert.equal(settled.outcome.status, "completed");
  assert.equal(settled.target.threadId, first.thread.id); assert.equal(settled.attempts, 1);
  const duplicate = await dispatch.enqueue(request); assert.equal(duplicate.id, queued.id); await dispatch.process(queued.id);
  assert.equal(requests, 2, "One manual fixture turn and one continuation; receipt recovery must not replay inference");
  assert.ok(JSON.stringify(providerInputs[1]).includes(authority.instructions));
  assert.equal((await reconnectedUi.request("diy/reactions/get", { id: queued.id })).state, "settled");
  ({ mcpChild, mcpPeer, mcpExited } = await connectMcp());
  const mcpReaction = await mcpPeer.request("tools/call", { name: "mycodex.reaction_get", arguments: { id: queued.id } });
  assert.equal(mcpReaction.isError, false); assert.equal(JSON.parse(mcpReaction.content[0].text).outcome.turnId, acceptedTurnId);
  await assert.rejects(mcpPeer.request("tools/call", { name: "mycodex.host_deliver", arguments: { ref, message: "not authorized" } }), /Unknown tool/);
  await assert.rejects(reconnectedUi.request("diy/reactions/start", { ...request, allowed: true }), /unavailable/);
  mcpChild.stdin.end(); assert.equal(await mcpExited, 0);
  await assert.rejects(reconnectedUi.request("diy/host/result", { ref, turnId: "missing-turn" }), /rejected/);
  assert.equal((await reconnectedUi.request("diy/host/status", {})).bindings[0].capabilities.requestIdempotency, false);
  // The installed protocol accepts this field but does not deduplicate turns.
  // Pin that fact so adapter receipts are never mistaken for native idempotency.
  const nativeTurns = [];
  for (let n = 0; n < 2; n++) {
    const probe = await native.request("turn/start", { threadId: second.thread.id, clientUserMessageId: "p3-same-client-id", input: [{ type: "text", text: "OFFLINE_NATIVE_IDEMPOTENCY_PROBE" }] });
    nativeTurns.push(probe.turn.id); await until(() => turns.get(probe.turn.id));
  }
  assert.notEqual(nativeTurns[0], nativeTurns[1]); assert.equal(requests, 4);
  assert.equal(fs.readdirSync(path.join(f.home, "gateway/threads")).length, 0);
  child.stdin.end(); await exited;
  await until(() => reconnectedUi.request("diy/host/status", {}), value => !value.bindings.length);
});
test("native routing survives invalid Spine configuration and frontend optional import failures", { timeout: 20000 }, async t => {
  const executable = process.env.MYCODEX_TEST_NATIVE_CLI ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  if (!fs.existsSync(executable)) { t.skip("Set MYCODEX_TEST_NATIVE_CLI for actual frontend isolation evidence."); return; }
  for (const failedModule of ["configuration", "trace-peer", "native-config", "native-host-peer", "delayed-host-import"]) {
    const f = await fixture(t);
    const profile = path.join(f.home, "profile"); fs.mkdirSync(profile, { mode: 0o700 });
    const loader = path.join(f.home, "failure-hook.mjs");
    if (failedModule === "delayed-host-import") {
      fs.writeFileSync(loader, "import { register } from 'node:module'; register(new URL('./slow-loader.mjs', import.meta.url));");
      fs.writeFileSync(path.join(f.home, "slow-loader.mjs"), "export async function load(url, context, next) { if (url.endsWith('/native-host-peer.mjs')) await new Promise(resolve => setTimeout(resolve, 4000)); return next(url, context); }");
    } else fs.writeFileSync(loader, `import { registerHooks } from 'node:module'; registerHooks({ resolve(specifier, context, next) {
      if (specifier.endsWith('/${failedModule}.mjs')) throw new Error('injected frontend optional import failure');
      return next(specifier, context);
    }});`);
    if (failedModule === "configuration") fs.writeFileSync(f.file, JSON.stringify({ ...f.config, spine: { mcp: "invalid" } }), { mode: 0o600 });
    const child = spawn(process.execPath, ["--import", loader, path.resolve(import.meta.dirname, "../gateway/routed-stdio.mjs"), "app-server"], {
      cwd: f.home, env: { PATH: process.env.PATH, HOME: f.home, CODEX_HOME: profile, CCODEX_NATIVE_CLI: executable, CCODEX_GATEWAY_CONNECTION: f.file }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = ""; child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
    const peer = new RpcPeer(message => writeMessage(child.stdin, message));
    readMessages(child.stdout, message => peer.receive(message), error => peer.close(error));
    const exited = new Promise(resolve => child.once("exit", code => { peer.close(); resolve(code); }));
    f.cleanup(async () => { child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 3000); await exited; clearTimeout(timer); });
    await peer.request("initialize", { clientInfo: { name: "p3-isolation", version: "1" }, capabilities: { experimentalApi: true } }, { timeoutMs: failedModule === "delayed-host-import" ? 2500 : 5000 });
    peer.notify({ method: "initialized" });
    const started = await peer.request("thread/start", { cwd: f.home }, { timeoutMs: 5000 });
    assert.equal((await peer.request("thread/read", { threadId: started.thread.id, includeTurns: false }, { timeoutMs: 5000 })).thread.id, started.thread.id, stderr);
    if (["trace-peer", "native-config"].includes(failedModule)) {
      const ui = await f.connect();
      const status = await until(() => ui.request("diy/host/status", {}), value => value.bindings.length === 1), binding = status.bindings[0];
      const state = await ui.request("diy/host/read", { ref: { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: started.thread.id } });
      assert.equal(state.ref.threadId, started.thread.id, "A failed independent optional module must not disable the host reader");
    }
    child.stdin.end(); assert.equal(await exited, 0, `${failedModule}: ${stderr}`);
  }
});
