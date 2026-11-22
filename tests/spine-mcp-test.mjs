import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { serveMcp, runMcp } from "../gateway/spine/mcp-server.mjs";
import { spineNativeArguments, spineNativeRequest, withSpinePath } from "../gateway/spine/native-config.mjs";
import { readRoutingConnection } from "../gateway/routed-stdio.mjs";
import { startGateway } from "../gateway/server.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { readMessages, writeMessage } from "../gateway/ipc.mjs";
import { squadTools } from "../gateway/spine/squad-commands.mjs";

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
  f.send({ id: 2, method: "tools/list" }); await turn(); assert.deepEqual(f.messages.at(-1).result.tools.map(x => x.name), ["mycodex.read_log", "mycodex.spine_status", "mycodex.radar_list", "mycodex.daily_digest", "mycodex.host_status", "mycodex.host_read", "mycodex.host_result", "mycodex.reactions_list", "mycodex.reaction_get", "mycodex.work_list", "mycodex.work_get", "mycodex.goal_upsert", "mycodex.shared_work_list", "mycodex.work_record", "mycodex.work_context", ...squadTools.map(tool => tool.name), "mycodex.show_squad_card", "mycodex.show_work_card"]);
  f.send({ id: 3, method: "tools/call", params: { name: "mycodex.read_log", arguments: { id: "s/c", startLine: 2, endLine: 2 } } }); await turn();
  assert.equal(f.messages.at(-1).result.isError, false); assert.equal(JSON.parse(f.messages.at(-1).result.content[0].text).content, "exact\n");
  assert.deepEqual(calls, [["diy/logs/read", { id: "s/c", startLine: 2, endLine: 2 }]]);
  for (const [i, name] of ["mycodex.work_upsert", "mycodex.squad_dispatch", "mycodex.squad_handoff", "mycodex.squad_integrate"].entries()) {
    f.send({ id: 20 + i, method: "tools/call", params: { name, arguments: {} } }); await turn(); assert.equal(f.messages.at(-1).error.code, -32602);
  }
  assert.equal(calls.length, 1, "retired P3 tools cannot dispatch even when invoked by name");
  f.send({ id: 4, method: "tools/call", params: { name: "mycodex.exec", arguments: {} } }); await turn(); assert.equal(f.messages.at(-1).error.code, -32602);
});
test("worker MCP exposes and routes only the bounded log reader", async t => {
  const calls = [], f = fixture(t, async (method, args) => { calls.push([method, args]); return { content: "exact" }; }, "worker");
  await f.init();
  assert.deepEqual(f.messages[0].result.capabilities, { tools: {} });
  f.send({ id: 2, method: "tools/list" }); await turn();
  assert.deepEqual(f.messages.at(-1).result.tools.map(tool => tool.name), ["mycodex.read_log"]);
  f.send({ id: 3, method: "resources/list" }); await turn();
  assert.equal(f.messages.at(-1).error.code, -32601);
  const args = { id: "session/chat", startLine: 1, endLine: 1 };
  f.send({ id: 4, method: "tools/call", params: { name: "mycodex.read_log", arguments: args } }); await turn();
  assert.equal(f.messages.at(-1).result.isError, false);
  for (const [i, name] of ["spine_status", "radar_list", "daily_digest", "host_status", "host_read", "host_result", "reactions_list", "reaction_get", "work_list", "work_get", "goal_upsert", "shared_work_list", "work_record", "work_context", "show_work_card", "squad_dispatch"].entries()) {
    f.send({ id: 5 + i, method: "tools/call", params: { name: "mycodex." + name, arguments: {} } }); await turn();
    assert.match(f.messages.at(-1).error.message, /Unknown tool/);
  }
  assert.deepEqual(calls, [["diy/logs/read", args]]);
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
  const denied = ["mycodex.work_record", "mycodex.goal_upsert", "mycodex.read_log", "mycodex.host_read", "diy/work/record"];
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
  for (const [name, args] of [["mycodex.goal_upsert", { title: "Missing identity" }], ["mycodex.goal_upsert", { id: "goal-one", title: "Missing revision" }], ["mycodex.work_record", { expectedRevision: 0 }], ["mycodex.work_record", { id: "../unsafe", expectedRevision: 0 }], ["mycodex.work_record", { id: "work-one", expectedRevision: -1 }], [{}], ["mycodex.host_read", {}]]) {
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

test('Squad V2 exposes exactly six primitives and adds the compatibility marker only at dispatch', async t => {
  assert.deepEqual(squadTools.map(tool => tool.name), ['mycodex.squad_init','mycodex.squad_state','mycodex.squad_dispatch','mycodex.squad_status','mycodex.squad_integrate','mycodex.squad_close']);
  const calls = [], f = fixture(t, async (method, params) => { calls.push({ method, params }); return { squadId: 'one' }; });
  await f.init();
  f.send({ id: 60, method: 'tools/call', params: { name: 'mycodex.squad_status', arguments: { squadId: 'one' } } });
  await turn();
  assert.equal(f.messages.at(-1).result.isError, false);
  assert.deepEqual(JSON.parse(f.messages.at(-1).result.content[0].text), { squadId: 'one' });
  assert.deepEqual(calls, [{ method: 'diy/squad/list', params: { squadId: 'one', v2: true } }]);
  f.send({ id: 61, method: 'tools/call', params: { name: 'mycodex.squad_status', arguments: { squadId: 'one', v2: false } } });
  await turn(); assert.equal(f.messages.at(-1).error.code, -32602); assert.equal(calls.length, 1);
});


test("Squad MCP projects all six primitives without mutating snapshots and reduces dual-slot payloads by over 75%", async t => {
  const delta = { baseSha: "base", headSha: "head", commits: ["a", "b"], changed: Array.from({ length: 30 }, (_, i) => ({ path: `src/module-${i}.mts`, add: i, del: 1 })), outsideTouches: ["outside.mts"] };
  const raw = { squadId: "one", anchorThreadId: "anchor", anchorHostRef: { private: "host" }, integrationBranch: "integration", integrationWorktree: "/tmp/squad/integration", status: "active", studioUrl: "http://127.0.0.1/squads/one",
    state: { schemaVersion: 2, revision: 3, title: "Compact", criteria: [{ id: "OPT-5A", text: "用户能快速找到尚未完成的事项", detail: "Assert pending criteria remain visible and preserve `verifiedAt: 0` semantics.\nDo not omit this second acceptance line." }], activeGate: { id: "G", status: "open" } }, needsYou: [{ kind: "gate", id: "G" }],
    events: Array.from({ length: 50 }, (_, i) => ({ kind: "output", seq: i, text: `event ${i}: long progress detail` })),
    anchorSettings: { model: "observed-anchor", reasoningEffort: "xhigh" },
    slots: ["native", "cli"].map((engine, i) => ({ slotId: `slot-${i}`, handle: `worker-${i}`, continuity: "stateful", workspace: "worktree", engine, model: "model", reasoningEffort: "high", threadId: `thread-${i}`, branch: `branch-${i}`, worktreePath: `/tmp/squad/slot-${i}`, sidebarHidden: true, activity: "quiescent", waitsOn: null, touches: ["src/**"], hostRef: { private: "host" },
      briefMarkdown: Array.from({ length: 100 }, (_, n) => `Brief ${n}: implement and verify module ${n}.\n`).join(""),
      result: { status: "done", summary: "Verified", assumptions: ["- isolated profile"], criteriaMet: ["C1"], autoSynthesized: i === 1, body: Array.from({ length: 100 }, (_, n) => `Verification ${n}: checked behavior ${n}.\n`).join("") },
      lastOutputSnippet: "redundant output".repeat(100), delta,
    })),
  };
  const before = structuredClone(raw);
  const f = fixture(t, async method => method === "diy/squad/summarize" ? { delta, snapshot: raw } : raw);
  await f.init();
  const invoke = async (name, args) => {
    const id = 100 + f.messages.length;
    f.send({ id, method: "tools/call", params: { name: `mycodex.squad_${name}`, arguments: args } });
    await turn();
    const reply = f.messages.find(m => m.id === id);
    assert.equal(reply.result.isError, false, JSON.stringify(reply));
    const result = reply.result;
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    return result;
  };
  for (const [name, args] of [
    ["init", { anchorThreadId: "anchor", intent: "test" }], ["state", { squadId: "one", expectedRevision: 3 }],
    ["dispatch", { squadId: "one", slots: [] }], ["status", { squadId: "one" }], ["close", { squadId: "one" }],
  ]) {
    const result = await invoke(name, args), projected = result.structuredContent;
    const rawBytes = Buffer.byteLength(JSON.stringify(raw)), compactBytes = Buffer.byteLength(result.content[0].text);
    assert.ok(compactBytes < rawBytes * .25, `${name}: ${rawBytes} -> ${compactBytes} bytes`);
    assert.deepEqual(projected.state, raw.state);
    assert.equal(projected.state.criteria[0].detail, raw.state.criteria[0].detail, "MCP keeps complete machine acceptance detail");
    assert.deepEqual(projected.needsYou, raw.needsYou);
    assert.deepEqual(projected.anchorSettings, raw.anchorSettings, "compact MCP keeps observed root metadata");
    for (const field of ["squadId", "anchorThreadId", "integrationBranch", "integrationWorktree", "status", "studioUrl"]) assert.equal(projected[field], raw[field]);
    assert.equal(projected.eventCount, 50);
    assert.equal(Object.hasOwn(projected, "events"), false);
    assert.equal(Object.hasOwn(projected, "anchorHostRef"), false);
    for (const [i, slot] of projected.slots.entries()) {
      for (const field of ["slotId", "handle", "continuity", "workspace", "engine", "model", "reasoningEffort", "threadId", "branch", "worktreePath", "sidebarHidden", "activity", "waitsOn", "touches"]) assert.deepEqual(slot[field], raw.slots[i][field]);
      for (const field of ["briefMarkdown", "hostRef", "lastOutputSnippet"]) assert.equal(Object.hasOwn(slot, field), false);
      assert.deepEqual(slot.result, { status: "done", summary: "Verified", assumptions: ["- isolated profile"], criteriaMet: ["C1"], ...(i ? { autoSynthesized: true } : {}) });
      assert.deepEqual(slot.delta, { baseSha: "base", headSha: "head", commitCount: 2, changedCount: 30, outsideTouches: ["outside.mts"] });
    }
    if (name === "status") t.diagnostic(`dual-slot MCP bytes: ${rawBytes} -> ${compactBytes} (${(100 * (1 - compactBytes / rawBytes)).toFixed(2)}% reduction); token estimate at UTF-8 bytes/4: ${Math.ceil(rawBytes / 4)} -> ${Math.ceil(compactBytes / 4)}`);
  }
  const integrated = (await invoke("integrate", { squadId: "one", slotId: "slot-0", expectedRevision: 3 })).structuredContent;
  assert.deepEqual(integrated.delta, { headSha: "head", commitCount: 2, changedCount: 30, outsideTouches: ["outside.mts"] });
  assert.equal(integrated.snapshot.slots[0].result.body, undefined);
  assert.equal(integrated.snapshot.state.revision, 3);
  assert.deepEqual(raw, before, "projection must not mutate the gateway/Studio snapshot");
  raw.slots[0].activity = "failed";
  delete raw.slots[1].result;
  const troubleshooting = (await invoke("status", { squadId: "one" })).structuredContent;
  for (const slot of troubleshooting.slots) assert.equal(slot.lastOutputSnippet.length, 240);
});


test("Squad dispatch MCP advertises and forwards atomic STATE fields in a single tool call", async t => {
  const calls = [], f = fixture(t, async (method, params) => { calls.push({ method, params }); return { squadId: "one", state: { revision: 2 }, slots: [] }; });
  await f.init();
  f.send({ id: 80, method: "tools/list" }); await turn();
  const tool = f.messages.at(-1).result.tools.find(t => t.name === "mycodex.squad_dispatch");
  const listed = f.messages.at(-1).result.tools;
  assert.deepEqual(tool.inputSchema.required, ["squadId", "slots"]);
  for (const field of ["expectedRevision", "patch", "resolveGate"]) assert.ok(Object.hasOwn(tool.inputSchema.properties, field));
  for (const name of ["init", "state", "dispatch"]) {
    const descriptor = f.messages.at(-1).result.tools.find(t => t.name === `mycodex.squad_${name}`).description;
    assert.match(descriptor, /text/); assert.match(descriptor, /detail/); assert.match(descriptor, /falsifiable/);
  }
  assert.match(tool.description, /What\/Why/);
  assert.match(tool.description, /workers choose How/);
  for (const name of ["init", "dispatch"]) {
    const description = listed.find(t => t.name === "mycodex.squad_" + name).description;
    assert.match(description, /high-reasoning.*terminal.*Git.*test/i);
    assert.match(description, /Pass-by-Reference.*inputs/i);
    assert.doesNotMatch(description, /pseudocode/i);
  }
  const slot = tool.inputSchema.properties.slots.items;
  assert.deepEqual(slot.required, ["slotId", "task"]);
  assert.deepEqual(slot.properties.workspace.enum, ["shared", "worktree", "scratch"]);
  assert.equal(slot.properties.repo.additionalProperties, false);
  assert.deepEqual(slot.properties.repo.required, ["source"]);
  assert.deepEqual(Object.keys(slot.properties.repo.properties), ["source", "baseRef", "branch", "submodules"]);
  for (const name of ["init", "state", "dispatch"]) {
    const field = name === "init" ? "state" : "patch";
    const schema = listed.find(t => t.name === "mycodex.squad_" + name).inputSchema.properties[field];
    assert.equal(schema.additionalProperties, false);
    assert.equal(Object.hasOwn(schema.properties, "tasks"), false);
    for (const key of ["criteria", "openBlockers"]) assert.equal(schema.properties[key].items.additionalProperties, false);
    assert.equal(schema.properties.activeGate.additionalProperties, false);
    assert.equal(schema.properties.activeGate.properties.options.items.additionalProperties, false);
  }
  const args = { squadId: "one", expectedRevision: 1, patch: { criteria: [{ id: "C", text: "Evidence" }] }, resolveGate: { id: "G", status: "approved", resolutionText: "Go" }, slots: [{ slotId: "worker", task: "Goal, evidence, red lines", workspace: "scratch", repo: { source: "/tmp/source", baseRef: "main", branch: "topic", submodules: true }, forbid: ["secrets/**"], readOnly: true, freshSession: true, inputs: ["/tmp/original.md"] }] };
  f.send({ id: 81, method: "tools/call", params: { name: "mycodex.squad_dispatch", arguments: args } }); await turn();
  assert.deepEqual(calls, [{ method: "diy/squad/dispatch", params: { ...args, v2: true } }]);
  assert.equal(f.messages.at(-1).result.structuredContent.state.revision, 2);
  for (const [i, [name, bad, error]] of [
    ["init", { anchorThreadId: randomUUID(), state: { criteria: [{ id: "C", text: "Evidence", status: "done" }] } }, /criteria\[0\]\.status.*verifyCriteria/],
    ["state", { squadId: "one", expectedRevision: 1, patch: { tasks: [] } }, /tasks/],
    ["dispatch", { ...args, patch: { activeGate: { options: [{ unexpected: true }] } } }, /options\[0\]\.unexpected/],
  ].entries()) {
    f.send({ id: 82 + i, method: "tools/call", params: { name: "mycodex.squad_" + name, arguments: bad } }); await turn();
    assert.match(f.messages.at(-1).error.message, error);
  }
  assert.equal(calls.length, 1);
});


test("Squad cards are explicit read-only presentations; background status has no template and review never reaches Gateway", async t => {
  const calls = [], raw = { squadId: "review-one", state: { schemaVersion: 2, revision: 1, criteria: [] }, slots: [], needsYou: [] };
  const before = structuredClone(raw);
  const f = fixture(t, async (method, params) => { calls.push([method, params]); return raw; });
  await f.init();
  assert.match(f.messages.find(m => m.id === 1).result.instructions, /show_squad_card/);
  f.send({ id: 40, method: "tools/list" }); await turn();
  const tools = f.messages.at(-1).result.tools, status = tools.find(tool => tool.name === "mycodex.squad_status"), show = tools.find(tool => tool.name === "mycodex.show_squad_card");
  assert.equal(status._meta["openai/widgetAccessible"], true);
  assert.equal(status._meta.ui.resourceUri, undefined);
  for (const field of ["ui/resourceUri", "openai/outputTemplate"]) assert.equal(status._meta[field], undefined);
  assert.ok(show); assert.equal(show.annotations.readOnlyHint, true);
  assert.equal(show._meta["openai/outputTemplate"], "ui://mycodex/squad-card-v2.html");
  assert.equal(show.inputSchema.properties.highlights.minItems, 1); assert.equal(show.inputSchema.properties.highlights.maxItems, 6);
  assert.doesNotMatch(JSON.stringify(show.inputSchema), /"(?:oneOf|anyOf|allOf)"\s*:/, "tool bridges must receive a flat schema rather than a string-wrapped input");
  assert.deepEqual(show.inputSchema.properties.highlights.items.required, ["title", "body"]);
  assert.deepEqual(Object.keys(show.inputSchema.properties.highlights.items.properties).sort(), ["body", "kind", "title"]);
  const review = { summary: "用单写者边界消除并发状态漂移", highlights: [{ title: "选择物理隔离", body: "使用 `worktree` 保留独立验证，代价是构建占用。", kind: "tradeoff" }] };
  f.send({ id: 41, method: "tools/call", params: { name: "mycodex.show_squad_card", arguments: { squadId: "review-one", ...review } } }); await turn();
  const reply = f.messages.at(-1).result;
  assert.equal(reply.isError, false);
  assert.deepEqual(reply.structuredContent.review, { summary: review.summary, highlights: [{ title: review.highlights[0].title, body: review.highlights[0].body, kind: "tradeoff" }] });
  assert.deepEqual(JSON.parse(reply.content[0].text), reply.structuredContent);
  assert.deepEqual(calls, [["diy/squad/list", { squadId: "review-one", v2: true }]]);
  assert.deepEqual(raw, before, "editorial review is per-card, never persisted into the shared snapshot");
  f.send({ id: 42, method: "tools/call", params: { name: "mycodex.squad_status", arguments: { squadId: "review-one" } } }); await turn();
  assert.equal(f.messages.at(-1).result.structuredContent.review, undefined);
});

test("show_squad_card validates bounded editorial inputs before reads and stays unavailable to workers", async t => {
  const calls = [], f = fixture(t, async (method, params) => { calls.push([method, params]); return { squadId: "other" }; });
  await f.init();
  const valid = { squadId: "review-one", highlights: [{ title: "选型", body: "根据用户结果验证" }] };
  const bad = [{}, { ...valid, squadId: "../other" }, { ...valid, summary: 42 }, { ...valid, highlights: [] }, { ...valid, highlights: Array(7).fill(valid.highlights[0]) },
    ...[{ body: "missing title" }, { title: "missing body" }, { title: "retired alias", insight: "use body instead" }, { title: "x", body: "x", insight: "ambiguous" }, { title: "x", body: "x", kind: "unknown" }, { title: "x", body: "x".repeat(2401) }, { title: "x", body: "x", execute: true }].map(item => ({ ...valid, highlights: [item] }))];
  for (const [i, args] of bad.entries()) {
    f.send({ id: 100+i, method: "tools/call", params: { name: "mycodex.show_squad_card", arguments: args } }); await turn();
    assert.equal(f.messages.at(-1).error?.code, -32602, JSON.stringify(args));
  }
  assert.equal(calls.length, 0);
  f.send({ id: 200, method: "tools/call", params: { name: "mycodex.show_squad_card", arguments: valid } }); await turn();
  assert.equal(f.messages.at(-1).error, undefined);
  assert.equal(f.messages.at(-1).result.isError, true, "a mismatched squad snapshot is not presented");
  for (const surface of ["worker", "shared-read", "shared-work"]) {
    const restricted = fixture(t, async () => assert.fail("no worker-side squad read"), surface); await restricted.init();
    restricted.send({ id: 2, method: "tools/list" }); await turn();
    assert.equal(restricted.messages.at(-1).result.tools.some(tool => tool.name === "mycodex.show_squad_card"), false);
    restricted.send({ id: 3, method: "tools/call", params: { name: "mycodex.show_squad_card", arguments: valid } }); await turn();
    assert.equal(restricted.messages.at(-1).error.code, -32602);
  }
});


test("Squad presentation advertises precise host invocation labels", async t => {
  const f = fixture(t); await f.init();
  f.send({ id: 80, method: "tools/list" }); await turn();
  const show = f.messages.at(-1).result.tools.find(tool => tool.name === "mycodex.show_squad_card");
  assert.equal(show._meta["openai/toolInvocation/invoking"], "正在准备技术品鉴…");
  assert.equal(show._meta["openai/toolInvocation/invoked"], "阶段技术品鉴");
});


test('C6: flat Squad schemas support anchor addressing and explain one standing squad per conversation', async t => {
  const anchorThreadId = randomUUID(), calls = [], f = fixture(t, async (method, params) => {
    calls.push([method, params]); return { squadId: 'existing', anchorThreadId, slots: [], events: [] };
  });
  await f.init();
  assert.match(f.messages[0].result.instructions, /one.*(?:standing|persistent).*squad.*conversation/i);
  f.send({ id: 2, method: 'tools/list' }); await turn();
  const tools = f.messages.at(-1).result.tools;
  for (const name of ['mycodex.squad_status', 'mycodex.show_squad_card']) {
    const schema = tools.find(x => x.name === name).inputSchema;
    assert.ok(schema.properties.anchorThreadId); assert.ok(!schema.required.includes('squadId'));
    assert.doesNotMatch(JSON.stringify(schema), /"(?:oneOf|anyOf|allOf)"/);
  }
  assert.equal(tools.find(x => x.name === 'mycodex.squad_init').inputSchema.properties.forceNew.type, 'boolean');
  let id = 10;
  for (const name of ['mycodex.squad_status', 'mycodex.show_squad_card']) {
    f.send({ id: id++, method: 'tools/call', params: { name, arguments: { anchorThreadId } } }); await turn();
    assert.equal(f.messages.at(-1).result.isError, false);
    assert.equal(f.messages.at(-1).result.structuredContent.squadId, 'existing');
    assert.deepEqual(calls.at(-1), ['diy/squad/list', { anchorThreadId, v2: true }]);
    for (const args of [{}, { anchorThreadId: '' }, { anchorThreadId: 5 }, { squadId: 'existing', anchorThreadId: '' }]) {
      const before = calls.length;
      f.send({ id: id++, method: 'tools/call', params: { name, arguments: args } }); await turn();
      assert.equal(f.messages.at(-1).error.code, -32602); assert.equal(calls.length, before);
    }
  }
});

test('C6: one stdio process survives gateway generations, fails interrupted writes without replay and accepts slow squad requests', { timeout: 30000 }, async t => {
  const net = await import('node:net');
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mcp-reconnect-'));
  const file = path.join(home, 'connection.json'), sockets = new Set(), servers = [], requests = [];
  let child, exited, peer;
  t.after(async () => {
    child?.stdin.end();
    if (exited) { const timer = setTimeout(() => child.kill('SIGKILL'), 1500); await exited; clearTimeout(timer); }
    for (const socket of sockets) socket.destroy();
    for (const server of servers) if (server.listening) await new Promise(resolve => server.close(resolve));
    peer?.close(); fs.rmSync(home, { recursive: true, force: true });
  });
  const start = async generation => {
    const config = { home, endpoint: path.join(home, generation), token: randomUUID(), generation, spine: { mcp: true } };
    const server = net.createServer(socket => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      readMessages(socket, message => {
        if (message.hello) {
          assert.equal(message.token, config.token);
          writeMessage(socket, { hello: 1, generation }); return;
        }
        requests.push({ generation, method: message.method });
        if (message.method === 'diy/squad/create') { socket.destroy(); return; }
        const respond = () => { if (!socket.destroyed) writeMessage(socket, { id: message.id, result: message.method === 'initialize' ? {} : { squadId: 'standing', generation } }); };
        if (message.method === 'diy/squad/list' && message.params.squadId === 'slow') {
          const timer = setTimeout(respond, 15500); socket.once('close', () => clearTimeout(timer));
        } else respond();
      }, () => socket.destroy());
    });
    servers.push(server); await new Promise(resolve => server.listen(config.endpoint, resolve));
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 }); return { config, server };
  };
  const first = await start('first');
  fs.unlinkSync(file); // Discovery still works when the gateway is temporarily unavailable.
  child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../gateway/spine/mcp-server.mjs'), file], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; const received = []; child.stderr.on('data', bytes => { stderr += bytes; });
  peer = new RpcPeer(message => writeMessage(child.stdin, { jsonrpc: '2.0', ...message }));
  readMessages(child.stdout, message => { received.push(message); peer.receive(message); }, error => peer.close(error));
  exited = new Promise(resolve => child.once('exit', code => { peer.close(); resolve(code); }));
  await peer.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'restart-regression', version: '1' }, capabilities: {} }, { timeoutMs: 3000 });
  peer.notify({ method: 'notifications/initialized' });
  const call = (name, args) => peer.request('tools/call', { name: `mycodex.${name}`, arguments: args }, { timeoutMs: 20000 });
  assert.equal((await call('squad_status', { squadId: 'standing' })).isError, true);
  fs.writeFileSync(file, JSON.stringify(first.config), { mode: 0o600 });
  assert.equal((await call('squad_status', { squadId: 'standing' })).structuredContent.generation, 'first');
  const interrupted = await call('squad_init', { anchorThreadId: randomUUID(), intent: 'write once' });
  assert.equal(interrupted.isError, true); assert.match(interrupted.content[0].text, /disconnect|closed|retried/i);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null, 'gateway disconnect must not retire the stdio child');
  await new Promise(resolve => first.server.close(resolve));
  const disabled = { ...first.config, spine: { mcp: false } }; fs.writeFileSync(file, JSON.stringify(disabled), { mode: 0o600 });
  assert.equal((await call('squad_status', { squadId: 'standing' })).isError, true, 'every reconnect validates current MCP capability');
  const second = await start('second');
  const reads = await Promise.all([1, 2, 3].map(() => call('squad_status', { squadId: 'standing' })));
  assert.ok(reads.every(x => x.structuredContent.generation === 'second'));
  assert.equal(requests.filter(x => x.generation === 'second' && x.method === 'initialize').length, 1, 'concurrent callers share connection initialization');
  assert.equal(requests.filter(x => x.method === 'diy/squad/create').length, 1, 'interrupted write is never replayed');
  const slow = await call('squad_status', { squadId: 'slow' });
  assert.equal(slow.isError, false, 'valid worktree operations may take longer than 15 seconds');
  // Cancellation must release only its request; another request and the MCP stay usable.
  writeMessage(child.stdin, { jsonrpc: '2.0', id: 'cancel-me', method: 'tools/call', params: { name: 'mycodex.squad_status', arguments: { squadId: 'slow' } } });
  const deadline = Date.now() + 2000;
  while (requests.filter(x => x.method === 'diy/squad/list').length < 6 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(requests.filter(x => x.method === 'diy/squad/list').length, 6, 'cancel only after the request reaches the gateway');
  peer.notify({ method: 'notifications/cancelled', params: { requestId: 'cancel-me' } });
  assert.equal((await call('squad_status', { squadId: 'standing' })).isError, false);
  assert.equal(received.some(x => x.id === 'cancel-me'), false);
  assert.equal(stderr, ''); child.stdin.end(); assert.equal(await exited, 0);
});


test('C6: cancelling during a shared reconnect frees MCP capacity and never dispatches the cancelled calls', async t => {
  const net = await import('node:net');
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mcp-cancel-connect-'));
  const config = { home, endpoint: path.join(home, 's'), token: randomUUID(), generation: 'held-init', spine: { mcp: true } };
  const file = path.join(home, 'connection.json'); fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const sockets = new Set(), dispatched = [];
  let release, onInitializing;
  const initializing = new Promise(resolve => { onInitializing = resolve; });
  const gateway = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    readMessages(socket, message => {
      if (message.hello) { writeMessage(socket, { hello: 1, generation: config.generation }); return; }
      if (message.method === 'initialize') {
        release = () => writeMessage(socket, { id: message.id, result: {} }); onInitializing(); return;
      }
      dispatched.push(message.params.squadId);
      writeMessage(socket, { id: message.id, result: { squadId: message.params.squadId } });
    }, () => socket.destroy());
  });
  await new Promise(resolve => gateway.listen(config.endpoint, resolve));
  const input = new PassThrough(), output = new PassThrough(), received = [];
  const running = runMcp(file, input, output);
  const peer = new RpcPeer(message => writeMessage(input, { jsonrpc: '2.0', ...message }));
  readMessages(output, message => { received.push(message); peer.receive(message); }, error => peer.close(error));
  t.after(async () => { input.end(); await running; peer.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => gateway.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); });
  await peer.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'cancel-connect', version: '1' }, capabilities: {} });
  peer.notify({ method: 'notifications/initialized' });
  for (let id = 10; id < 18; id++) writeMessage(input, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'mycodex.squad_status', arguments: { squadId: 'cancelled-' + id } } });
  await initializing;
  for (let requestId = 10; requestId < 18; requestId++) peer.notify({ method: 'notifications/cancelled', params: { requestId } });
  await turn(); await turn();
  const fresh = peer.request('tools/call', { name: 'mycodex.squad_status', arguments: { squadId: 'fresh' } }).then(result => ({ result }), error => ({ error }));
  await turn(); release();
  const outcome = await fresh;
  assert.equal(outcome.error, undefined, 'cancelled connection waiters must free the eight-request MCP limit immediately');
  assert.equal(outcome.result.structuredContent.squadId, 'fresh');
  assert.deepEqual(dispatched, ['fresh']);
  assert.equal(received.some(x => x.id >= 10 && x.id < 18), false);
});

test('C7: flat incremental schemas and compact rounds keep stage/deliverables while omitting historical bodies', async t => {
  const raw = { squadId: 'waves', slots: [{ slotId: 'dev', stage: 'running', deliverables: [{ kind: 'mr', label: 'repo!83', target: 'https://git.example/repo/merge_requests/83' }], rounds: Array.from({ length: 20 }, (_, i) => ({ round: i + 1, goal: 'Goal ' + i, stage: i === 19 ? 'running' : 'accepted', touches: ['src/**'], dispatchedAt: i, acceptedAt: i, briefMarkdown: 'HUGE_PRIVATE_BRIEF'.repeat(1000), result: { status: 'done', summary: 'DELIVERED', assumptions: ['known tradeoff'], body: 'HUGE_PRIVATE_RESULT'.repeat(1000) }, deliverables: [{ kind: 'mr', label: 'repo!83' }], deltaSummary: { baseSha: 'b', headSha: 'h', commitCount: 2, changedCount: 1, files: [{ path: 'owned' }] } })) }] };
  const calls = [], f = fixture(t, async (method, params) => { calls.push([method, params]); return raw; });
  await f.init(); f.send({ id: 2, method: 'tools/list' }); await turn();
  const tools = f.messages.at(-1).result.tools;
  for (const name of ['state', 'dispatch', 'integrate']) {
    const schema = tools.find(t => t.name === 'mycodex.squad_' + name).inputSchema;
    assert.ok(schema.properties.verifyCriteria); if (name !== 'integrate') assert.ok(schema.properties.acceptSlots);
    assert.doesNotMatch(JSON.stringify(schema), /"(?:oneOf|anyOf|allOf)"/);
    if (name === 'dispatch') { assert.ok(schema.properties.slots.items.properties.goal); assert.ok(schema.properties.slots.items.properties.criteriaIds); }
  }
  const args = { squadId: 'waves', expectedRevision: 1, acceptSlots: ['old'], verifyCriteria: ['C1'], slots: [{ slotId: 'dev', goal: 'New goal', criteriaIds: ['C2'], task: 'Task', touches: [] }] };
  f.send({ id: 3, method: 'tools/call', params: { name: 'mycodex.squad_dispatch', arguments: args } }); await turn();
  assert.deepEqual(calls, [['diy/squad/dispatch', { ...args, v2: true }]]);
  const projected = f.messages.at(-1).result.structuredContent.slots[0];
  assert.equal(projected.stage, 'running'); assert.deepEqual(projected.deliverables, raw.slots[0].deliverables);
  assert.equal(projected.rounds.length, 20); assert.equal(projected.rounds[0].result.summary, 'DELIVERED');
  assert.doesNotMatch(JSON.stringify(projected), /HUGE_PRIVATE/); assert.ok(JSON.stringify(projected).length < 18000);
  assert.ok(raw.slots[0].rounds[0].result.body.includes('HUGE_PRIVATE_RESULT'));
});

test('C7: real MCP projects large round histories before the Gateway response limit while Studio retains full receipts', async t => {
  const { squadFixture } = await import('./squad-flow-fixture.mjs');
  const cleanups = [], f = await squadFixture({ after: fn => cleanups.push(fn) });
  t.after(async () => { for (const fn of cleanups.reverse()) await fn(); });
  const anchor = await f.createThread();
  const first = await f.call('diy/squad/create', { v2: true, anchorThreadId: anchor.id, intent: 'Large history' });
  const dispatched = await f.call('diy/squad/dispatch', { v2: true, squadId: first.squadId, slots: [{ slotId: 'dev', task: 'First', touches: [], model: 'fixture/model' }] });
  await f.gateway.protocol.active.get(dispatched.slots[0].threadId)?.done;
  const stateFile = path.join(f.home, '.mycodex', 'squads-v2', first.squadId, 'state.json'), stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  stored.slots[0].rounds = Array.from({ length: 20 }, (_, i) => ({ round: i + 1, goal: 'Wave ' + (i + 1), touches: [], stage: 'accepted', dispatchedAt: i, acceptedAt: i + 1, deliverables: [{ kind: 'mr', label: 'repo!83', target: 'https://git.example/repo/merge_requests/83' }], result: { status: 'done', summary: 'Real archived receipt', assumptions: ['real archive'], body: 'PRESERVED_PRIVATE_BODY'.repeat(2000), reportedAt: i + 1 } }));
  fs.writeFileSync(stateFile, JSON.stringify(stored));
  await assert.rejects(f.call('diy/squad/list', { v2: true, squadId: first.squadId }), /payload exceeds limit/);
  const full = await (await fetch(first.studioUrl)).json();
  assert.ok(full.slots[0].rounds[0].result.body.length > 40000);
  const file = path.join(f.home, 'connection.json'); fs.writeFileSync(file, JSON.stringify({ ...f.config, spine: { mcp: true } }), { mode: 0o600 });
  const input = new PassThrough(), output = new PassThrough(), running = runMcp(file, input, output);
  const peer = new RpcPeer(message => writeMessage(input, { jsonrpc: '2.0', ...message }));
  readMessages(output, message => peer.receive(message), error => peer.close(error));
  cleanups.push(async () => { input.end(); await running; peer.close(); output.destroy(); });
  await peer.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'large-history', version: '1' }, capabilities: {} }); peer.notify({ method: 'notifications/initialized' });
  const result = await peer.request('tools/call', { name: 'mycodex.squad_status', arguments: { squadId: first.squadId } });
  assert.equal(result.isError, false, result.content[0].text); assert.equal(result.structuredContent.slots[0].rounds.length, 20);
  assert.doesNotMatch(result.content[0].text, /PRESERVED_PRIVATE_BODY/); assert.ok(result.content[0].text.length < 18000);
});
