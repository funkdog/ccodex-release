import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { serveMcp } from "../gateway/spine/mcp-server.mjs";
import { spineNativeArguments, spineNativeRequest, withSpinePath } from "../gateway/spine/native-config.mjs";
import { readRoutingConnection } from "../gateway/routed-stdio.mjs";
import { startGateway } from "../gateway/server.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { readMessages, writeMessage } from "../gateway/ipc.mjs";

const turn = () => new Promise(resolve => setImmediate(resolve));
test("managed MCP disabled-table compatibility preserves disable intent, sibling settings and caller ownership", () => {
  for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
    const request = { id: 1, method, params: { config: { mcp_servers: { mycodex: { enabled: false }, other: { command: "fixture", enabled: true } }, "features.hooks": false } } };
    const before = structuredClone(request), result = spineNativeRequest(request);
    assert.deepEqual(result.params.config.mcp_servers.mycodex, { command: "", enabled: false });
    assert.deepEqual(result.params.config.mcp_servers.other, before.params.config.mcp_servers.other);
    assert.equal(result.params.config["features.hooks"], false); assert.deepEqual(request, before);
  }
  for (const config of [{ "mcp_servers.mycodex.enabled": false }, { "mcp_servers.mycodex": { enabled: true } },
    { mcp_servers: { mycodex: { enabled: false, command: "explicit" } } }]) {
    const request = { method: "thread/start", params: { config } }; assert.equal(spineNativeRequest(request), request);
  }
  const write = { method: "config/batchWrite", params: { config: { "mcp_servers.mycodex": { enabled: false } } } };
  assert.equal(spineNativeRequest(write), write);
});
function fixture(t, dispatch = async () => ({}), surface = "full") {
  const input = new PassThrough(), output = new PassThrough(), messages = []; let partial = "";
  output.on("data", chunk => { partial += chunk; for (;;) { const i = partial.indexOf("\n"); if (i < 0) break; messages.push(JSON.parse(partial.slice(0, i))); partial = partial.slice(i + 1); } });
  const server = serveMcp({ input, output, dispatch, surface }); t.after(() => { server.dispose(); input.destroy(); output.destroy(); });
  const send = value => input.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const init = async () => { send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "fixture", version: "1" }, capabilities: {} } }); await turn(); send({ method: "notifications/initialized" }); await turn(); };
  return { input, output, server, messages, send, init };
}
test("MCP negotiates a standard protocol and exposes bounded read-only tools", async t => {
  const calls = [], f = fixture(t, async (method, params) => { calls.push([method, params]); return { content: "exact\n", complete: true }; });
  f.send({ id: 0, method: "tools/list" }); await turn(); assert.match(f.messages[0].error.message, /Initialize/);
  await f.init(); assert.equal(f.messages.find(x => x.id === 1).result.protocolVersion, "2025-06-18");
  f.send({ id: 2, method: "tools/list" }); await turn(); assert.deepEqual(f.messages.at(-1).result.tools.map(x => x.name), ["mycodex.read_log", "mycodex.spine_status", "mycodex.radar_list", "mycodex.daily_digest", "mycodex.host_status", "mycodex.host_read", "mycodex.host_result", "mycodex.reactions_list", "mycodex.reaction_get", "mycodex.work_list", "mycodex.work_get", "mycodex.work_upsert", "mycodex.squad_dispatch", "mycodex.squad_handoff", "mycodex.squad_integrate", "mycodex.goal_upsert", "mycodex.shared_work_list", "mycodex.work_record", "mycodex.work_context", "mycodex.show_work_card"]);
  f.send({ id: 3, method: "tools/call", params: { name: "mycodex.read_log", arguments: { id: "s/c", startLine: 2, endLine: 2 } } }); await turn();
  assert.equal(f.messages.at(-1).result.isError, false); assert.equal(JSON.parse(f.messages.at(-1).result.content[0].text).content, "exact\n");
  assert.deepEqual(calls, [["diy/logs/read", { id: "s/c", startLine: 2, endLine: 2 }]]);
  f.send({ id: 4, method: "tools/call", params: { name: "mycodex.exec", arguments: {} } }); await turn(); assert.equal(f.messages.at(-1).error.code, -32602);
});
test("tunnel discovery can probe modern discovery then repeat a legacy handshake on its supervised child", async t => {
  const calls = [], f = fixture(t, async (method, params) => { calls.push([method, params]); return {}; }, "shared-work");
  f.send({ id: 0, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } });
  await turn(); assert.equal(f.messages.at(-1).error.code, -32601, "an unsupported discovery method must permit legacy fallback");
  await f.init();
  f.send({ id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "openai-mcp", version: "1" }, capabilities: {} } });
  await turn(); assert.equal(f.messages.at(-1).result.serverInfo.name, "mycodex-work");
  f.send({ id: 3, method: "tools/list" }); await turn(); assert.match(f.messages.at(-1).error.message, /Initialize/);
  f.send({ method: "notifications/initialized" }); await turn();
  f.send({ id: 4, method: "tools/list" }); await turn();
  assert.deepEqual(f.messages.at(-1).result.tools.map(tool => tool.name), ["mycodex.spine_status", "mycodex.goals_list", "mycodex.shared_work_list", "mycodex.work_context", "mycodex.goal_upsert", "mycodex.work_record", "mycodex.show_work_card"]);
  assert.deepEqual(calls, [], "discovery and repeated initialization cannot dispatch record operations");
});
test("MCP reinitialization cannot overlap an active record operation or replay it", async t => {
  let complete;
  const calls = [], f = fixture(t, async (method, params) => { calls.push([method, params]); await new Promise(resolve => { complete = resolve; }); return { revision: 1 }; }, "shared-work");
  await f.init();
  f.send({ id: 2, method: "tools/call", params: { name: "mycodex.work_record", arguments: { id: "work-once", expectedRevision: 0 } } }); await turn();
  f.send({ id: 3, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "next-client", version: "1" }, capabilities: {} } }); await turn();
  assert.equal(f.messages.at(-1).error.code, -32602);
  complete(); await turn(); assert.equal(f.messages.find(message => message.id === 2).result.isError, false);
  f.send({ id: 4, method: "tools/list" }); await turn(); assert.equal(f.messages.at(-1).result.tools.length, 7);
  assert.deepEqual(calls, [["diy/work/record", { id: "work-once", expectedRevision: 0 }]]);
});
test("MCP rejects malformed/batched/oversized frames and unknown methods without stdout diagnostics", async t => {
  const f = fixture(t);
  f.input.write("{bad}\n[]\n"); await turn(); assert.deepEqual(f.messages.map(x => x.error.code), [-32700, -32600]);
  await f.init(); f.send({ id: 2, method: "unknown" }); await turn(); assert.equal(f.messages.at(-1).error.code, -32601);
  f.input.write("x".repeat(40000)); assert.equal(f.server.closed, true); assert.equal(f.messages.at(-1).error.code, -32600);
});

test("the shared-work read-only surface rejects writes and unrelated tools before dispatch", async t => {
  const calls = [], f = fixture(t, async (method, params) => { calls.push([method, params]); return {}; }, "shared-read");
  await f.init(); f.send({ id: 2, method: "tools/list" }); await turn();
  const tools = f.messages.at(-1).result.tools;
  assert.deepEqual(tools.map(tool => tool.name), ["mycodex.spine_status", "mycodex.goals_list", "mycodex.shared_work_list", "mycodex.work_context"]);
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
  const denied = ["mycodex.work_record", "mycodex.goal_upsert", "mycodex.work_upsert", "mycodex.squad_dispatch", "mycodex.read_log", "mycodex.host_read", "diy/work/record"];
  for (const [index, name] of denied.entries()) {
    f.send({ id: index + 3, method: "tools/call", params: { name, arguments: {} } }); await turn();
    assert.equal(f.messages.at(-1).error.code, -32602, name);
  }
  f.send({ id: 20, method: "diy/work/record", params: {} }); await turn(); assert.equal(f.messages.at(-1).error.code, -32601);
  assert.equal(calls.length, 0);
  f.send({ id: 21, method: "tools/call", params: { name: "mycodex.goals_list", arguments: {} } }); await turn();
  assert.deepEqual(calls, [["diy/goals/list", {}]]);
  assert.throws(() => serveMcp({ input: new PassThrough(), output: new PassThrough(), dispatch: async () => ({}), surface: "unknown" }), /surface/i);
});

test("the standalone read-only MCP process reads real work records and cannot alter their revision", { timeout: 10000 }, async t => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "spine-work-read-"));
  const config = { home, endpoint: path.join(home, "s"), token: randomUUID(), generation: "readonly-fixture", spine: { mcp: true },
    defaultEngine: "fixture", engines: new Map([["fixture", { models: async () => [], run: async () => { throw new Error("Read-only acceptance must not run a model."); } }]]) };
  const gateway = await startGateway(config);
  gateway.work.upsertGoal({ id: "goal-read", title: "共同工作" });
  gateway.work.upsertGoal({ id: "goal-empty", title: "尚待澄清" });
  gateway.work.upsertSharedWork({ id: "work-read", goalId: "goal-read", expectedRevision: 0, title: "体验走查", userIntent: "让小鼠头读取同一份工作" });
  const file = path.join(home, "connection.json"); fs.writeFileSync(file, JSON.stringify({ ...config, engines: [] }), { mode: 0o600 });
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../gateway/spine/mcp-server.mjs"), file, "--shared-work-read-only"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", bytes => { stderr += bytes; });
  const peer = new RpcPeer(message => writeMessage(child.stdin, { jsonrpc: "2.0", ...message }));
  readMessages(child.stdout, message => peer.receive(message), error => peer.close(error));
  const exited = new Promise(resolve => child.once("exit", code => { peer.close(); resolve(code); }));
  t.after(async () => { child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 2000); await exited; clearTimeout(timer); peer.close(); await gateway.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const initialized = await peer.request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "read-only-acceptance", version: "1" }, capabilities: {} }, { timeoutMs: 3000 });
  assert.equal(initialized.serverInfo.name, "mycodex-work-read");
  peer.notify({ method: "notifications/initialized" });
  const goals = await peer.request("tools/call", { name: "mycodex.goals_list", arguments: {} });
  assert.equal(JSON.parse(goals.content[0].text).goals.length, 2);
  const read = await peer.request("tools/call", { name: "mycodex.work_context", arguments: { id: "work-read" } });
  assert.equal(JSON.parse(read.content[0].text).continuation.userIntent, "让小鼠头读取同一份工作");
  await assert.rejects(peer.request("tools/call", { name: "mycodex.work_record", arguments: { id: "work-read", expectedRevision: 1, title: "不应写入" } }), /Unknown tool/);
  assert.equal(gateway.work.readWorkContext({ id: "work-read" }).workItem.revision, 1);
  assert.equal(stderr, "");
  const invalid = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../gateway/spine/mcp-server.mjs"), file, "--misspelled-read-only"], { encoding: "utf8", timeout: 3000 });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ""); assert.match(invalid.stderr, /Usage:/);
});

test("one shared-work connection exposes record reads and writes while requiring stable versioned identities", async t => {
  const calls = [], f = fixture(t, async (method, params) => { calls.push([method, params]); return {}; }, "shared-work");
  await f.init(); f.send({ id: 2, method: "tools/list" }); await turn();
  const tools = f.messages.at(-1).result.tools;
  assert.deepEqual(tools.map(tool => tool.name), ["mycodex.spine_status", "mycodex.goals_list", "mycodex.shared_work_list", "mycodex.work_context", "mycodex.goal_upsert", "mycodex.work_record", "mycodex.show_work_card"]);
  for (const name of ["mycodex.goal_upsert", "mycodex.work_record"]) {
    const tool = tools.find(tool => tool.name === name); assert.equal(tool.annotations.readOnlyHint, false);
    assert.ok(tool.inputSchema.required.includes("id")); assert.ok(tool.inputSchema.required.includes("expectedRevision"));
  }
  let id = 3;
  for (const [name, args] of [["mycodex.goal_upsert", { title: "Missing identity" }], ["mycodex.goal_upsert", { id: "goal-one", title: "Missing revision" }], ["mycodex.work_record", { expectedRevision: 0 }], ["mycodex.work_record", { id: "../unsafe", expectedRevision: 0 }], ["mycodex.work_record", { id: "work-one", expectedRevision: -1 }], ["mycodex.squad_dispatch", {}], ["mycodex.host_read", {}]]) {
    f.send({ id: id++, method: "tools/call", params: { name, arguments: args } }); await turn();
    assert.equal(f.messages.at(-1).error.code, -32602, name);
  }
  assert.equal(calls.length, 0, "invalid writes cannot reach a writer or create work implicitly");
  f.send({ id: id++, method: "tools/call", params: { name: "mycodex.work_record", arguments: { id: "work-one", expectedRevision: 0 } } }); await turn();
  assert.deepEqual(calls, [["diy/work/record", { id: "work-one", expectedRevision: 0 }]]);
});

test("the unified MCP process creates, updates and resumes the same work with revision and execution boundaries", { timeout: 10000 }, async t => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "spine-work-unified-"));
  const config = { home, endpoint: path.join(home, "s"), token: randomUUID(), generation: "unified-fixture", spine: { mcp: true },
    defaultEngine: "fixture", engines: new Map([["fixture", { models: async () => [], run: async () => { throw new Error("Record operations must never run a model."); } }]]) };
  const gateway = await startGateway(config), file = path.join(home, "connection.json");
  fs.writeFileSync(file, JSON.stringify({ ...config, engines: [] }), { mode: 0o600 });
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../gateway/spine/mcp-server.mjs"), file, "--shared-work"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", bytes => { stderr += bytes; });
  const peer = new RpcPeer(message => writeMessage(child.stdin, { jsonrpc: "2.0", ...message }));
  readMessages(child.stdout, message => peer.receive(message), error => peer.close(error));
  const exited = new Promise(resolve => child.once("exit", code => { peer.close(); resolve(code); }));
  t.after(async () => { child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 2000); await exited; clearTimeout(timer); peer.close(); await gateway.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const initialized = await peer.request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "unified-work-acceptance", version: "1" }, capabilities: {} }, { timeoutMs: 3000 });
  assert.equal(initialized.serverInfo.name, "mycodex-work"); peer.notify({ method: "notifications/initialized" });
  const call = (name, args) => peer.request("tools/call", { name: `mycodex.${name}`, arguments: args });
  const goal = await call("goal_upsert", { id: "goal-one", expectedRevision: 0, title: "协作体验" });
  assert.equal(JSON.parse(goal.content[0].text).goal.revision, 1);
  const entry = { id: "entry-flow", kind: "result", title: "入口方案", summary: "共享当前依据与下一步", state: "candidate", reference: "chat:fixture/proposal" };
  const created = await call("work_record", { id: "work-one", goalId: "goal-one", expectedRevision: 0, title: "入口动线", userIntent: "让小鼠头实际推进工作台", context: [entry] });
  assert.equal(created.isError, false); assert.equal(JSON.parse(created.content[0].text).workItem.revision, 1);
  const before = JSON.parse((await call("work_context", { id: "work-one" })).content[0].text);
  assert.equal(before.continuation.candidates.length, 1); assert.equal(before.continuation.adopted.length, 0);
  const updated = await call("work_record", { id: "work-one", expectedRevision: 1, progress: "用户已采用入口方案", context: [{ ...entry, state: "adopted", reference: "chat:fixture/user-adopted" }] });
  assert.equal(JSON.parse(updated.content[0].text).workItem.revision, 2);
  const stale = await call("work_record", { id: "work-one", expectedRevision: 1, progress: "过时覆盖" });
  assert.equal(stale.isError, true); assert.match(stale.content[0].text, /revision conflict/i);
  const duplicate = await call("goal_upsert", { id: "goal-one", expectedRevision: 0, title: "重复创建" });
  assert.equal(duplicate.isError, true); assert.match(duplicate.content[0].text, /revision conflict/i);
  const binding = await call("work_record", { id: "work-one", expectedRevision: 2, workspace: home }); assert.equal(binding.isError, true);
  await assert.rejects(call("squad_dispatch", { workItemId: "work-one" }), /Unknown tool/);
  const resumed = JSON.parse((await call("work_context", { id: "work-one" })).content[0].text);
  assert.equal(resumed.workItem.revision, 2); assert.equal(resumed.continuation.adopted[0].reference, "chat:fixture/user-adopted");
  assert.equal(resumed.continuation.progress, "用户已采用入口方案"); assert.equal(Object.hasOwn(resumed.workItem, "workspace"), false);
  assert.equal(stderr, "");
});
test("MCP cancellation, duplicate IDs and disposal suppress late replies and never replay calls", async t => {
  let release, calls = 0;
  const f = fixture(t, async (_method, _params, signal) => { calls++; await new Promise(resolve => { release = resolve; }); assert.equal(signal.aborted, true); return {}; });
  await f.init(); f.send({ id: 2, method: "tools/call", params: { name: "mycodex.spine_status" } }); await turn();
  f.send({ method: "notifications/cancelled", params: { requestId: 2 } }); release(); await turn(); assert.equal(f.messages.some(x => x.id === 2), false); assert.equal(calls, 1);
  f.send({ id: 3, method: "tools/call", params: { name: "mycodex.spine_status" } }); await turn(); f.send({ id: 3, method: "ping" }); await turn();
  assert.equal(f.messages.filter(x => x.id === 3).length, 1); assert.equal(f.messages.at(-1).error.code, -32600); release(); await turn(); assert.equal(f.messages.filter(x => x.id === 3).length, 1);
  f.send({ id: 4, method: "tools/call", params: { name: "mycodex.spine_status" } }); await turn(); f.server.dispose(); release(); await turn(); assert.equal(f.messages.some(x => x.id === 4), false);
});
test("MCP native injection is opt-in and argv-local; connection validation rejects unsafe option shapes", t => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "spine-config-")); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "connection.json"), config = { home, token: randomUUID(), endpoint: path.join(home, "s"), generation: "fixture" };
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 }); const before = fs.readFileSync(file);
  assert.deepEqual(spineNativeArguments(config, file), []);
  const args = spineNativeArguments({ ...config, spine: { mcp: true } }, file);
  assert.equal(args[0], "-c"); assert.match(args[1], /^mcp_servers.mycodex=/); assert.match(args[1], /mcp-server.mjs/); assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.existsSync(path.join(home, "config.toml")), false);
  fs.writeFileSync(file, JSON.stringify({ ...config, spine: { mcp: "yes" } })); assert.throws(() => readRoutingConnection(file), /Invalid Spine/);
  assert.throws(() => withSpinePath({}, "relative"), /absolute/);
});
test("actual MCP subprocess reads via authenticated private gateway, with protocol-only stdout", { timeout: 10000 }, async t => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "spine-mcp-"));
  const config = { home, endpoint: path.join(home, "s"), token: randomUUID(), generation: "fixture", spine: { mcp: true }, defaultEngine: "test", engines: new Map([["test", { models: async () => [], run: async () => {} }]]) };
  const gateway = await startGateway(config), p = gateway.spine.logs.save(Buffer.from("first\nsecond\n"), "s", "c");
  const file = path.join(home, "connection.json"); fs.writeFileSync(file, JSON.stringify({ ...config, engines: undefined }), { mode: 0o600 });
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../gateway/spine/mcp-server.mjs"), file], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", buffer = ""; const responses = new Map(), waiters = new Map();
  child.stderr.on("data", data => { stderr += data; }); child.stdout.on("data", data => { buffer += data; for (;;) { const i = buffer.indexOf("\n"); if (i < 0) break; const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); responses.set(m.id, m); waiters.get(m.id)?.(m); } });
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(async () => { child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 2000); await exited; clearTimeout(timer); await gateway.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const send = m => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const response = id => responses.has(id) ? Promise.resolve(responses.get(id)) : new Promise(resolve => waiters.set(id, resolve));
  send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "fixture", version: "1" }, capabilities: {} } }); assert.equal((await response(1)).result.serverInfo.name, "mycodex");
  send({ method: "notifications/initialized" }); send({ id: 2, method: "tools/call", params: { name: "mycodex.read_log", arguments: { id: p.id, startLine: 2, endLine: 2 } } });
  const result = await response(2); assert.equal(result.result.isError, false); assert.equal(JSON.parse(result.result.content[0].text).content, "second\n"); assert.equal(stderr, "");
  // Fatal framing errors must retire the owned MCP process even if the caller
  // leaves stdin open. Otherwise a closed server keeps the gateway connected.
  child.stdin.write("x".repeat(40000));
  let timeout; const code = await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(() => resolve("timeout"), 1000); })]); clearTimeout(timeout);
  assert.equal(code, 0, "MCP process must exit after a fatal frame without waiting for stdin EOF");
});

test("installed native CLI discovers the dynamically mounted MCP in an isolated profile without a model turn", { timeout: 20000 }, async t => {
  const executable = process.env.MYCODEX_TEST_NATIVE_CLI ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  if (!fs.existsSync(executable)) { t.skip("Installed native CLI is unavailable; set MYCODEX_TEST_NATIVE_CLI for this integration check."); return; }
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "spine-native-")), profile = path.join(home, "native-profile"); fs.mkdirSync(profile, { mode: 0o700 });
  const config = { home, endpoint: path.join(home, "s"), token: randomUUID(), generation: "fixture", spine: { mcp: true }, defaultEngine: "test", engines: new Map([["test", { models: async () => [], run: async () => {} }]]) };
  const gateway = await startGateway(config), file = path.join(home, "connection.json"); fs.writeFileSync(file, JSON.stringify({ ...config, engines: undefined }), { mode: 0o600 });
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../gateway/routed-stdio.mjs"), "app-server"], { env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: profile, CCODEX_NATIVE_CLI: executable, CCODEX_GATEWAY_CONNECTION: file }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", data => { stderr += data; });
  const peer = new RpcPeer(message => writeMessage(child.stdin, message)); readMessages(child.stdout, m => peer.receive(m), error => peer.close(error));
  const exited = new Promise(resolve => child.once("exit", code => { peer.close(new Error(`Isolated native exited (${code}): ${stderr}`)); resolve(code); }));
  t.after(async () => { child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 2000); await exited; clearTimeout(timer); peer.close(); await gateway.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await peer.request("initialize", { clientInfo: { name: "mycodex_fixture", version: "1" }, capabilities: { experimentalApi: true } }, { timeoutMs: 5000 }); peer.notify({ method: "initialized" });
  let status;
  const deadline = Date.now() + 12000;
  do {
    status = await peer.request("mcpServerStatus/list", {}, { timeoutMs: 5000 });
    if (JSON.stringify(status).includes("mycodex.read_log")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.match(JSON.stringify(status), /mycodex\.read_log/, stderr); assert.match(JSON.stringify(status), /mycodex\.spine_status/);
  // Desktop disables configured MCPs in title/description/preflight threads by
  // replacing each server table with { enabled: false }. An argv-mounted
  // server still needs a valid disabled transport in the installed CLI.
  for (const disabled of [{ mcp_servers: { mycodex: { enabled: false } } }, { "mcp_servers.mycodex": { enabled: false } }]) {
    const snapshot = structuredClone(disabled);
    const result = await peer.request("thread/start", { model: "fixture-no-inference", cwd: home, ephemeral: true, config: disabled }, { timeoutMs: 5000 });
    assert.equal(result.thread.ephemeral, true);
    assert.deepEqual(disabled, snapshot);
  }
  assert.equal(fs.existsSync(path.join(profile, "config.toml")), false);
  assert.equal(fs.existsSync(path.join(home, "gateway/threads")) && fs.readdirSync(path.join(home, "gateway/threads")).length, 0);
});
