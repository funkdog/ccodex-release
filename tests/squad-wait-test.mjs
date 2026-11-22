import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { squadFixture } from "./squad-flow-fixture.mjs";

async function fixture(t, run) {
  const f = await squadFixture(t, run), anchor = await f.createThread(), worker = await f.createThread();
  const squad = await f.call("diy/squad/create", { anchorThreadId: anchor.id, label: "Wait and recovery" });
  await f.call("diy/squad/add", { squadId: squad.id, threadId: worker.id, shortName: "dev" });
  const post = (extra = {}) => f.call("diy/squad/post", { squadId: squad.id, authorThreadId: anchor.id, requestId: randomUUID(), kind: "assign", summary: "verify", next: "@dev", ...extra });
  const view = async () => (await f.call("diy/squad/list", { squadId: squad.id })).squads[0];
  return { f, anchor, worker, squad, post, view };
}
test("a newer running dispatch supersedes an older unreported turn and cannot be adopted as terminal", async t => {
  let release; const hold = new Promise(r => release = r); let runs = 0;
  t.after(() => release());
  const { f, worker, squad, post, view } = await fixture(t, async context => { context.onText(++runs === 1 ? "old result" : "partial commentary"); if (runs === 2) await hold; });
  await post(); await f.gateway.protocol.active.get(worker.id)?.done;
  assert.deepEqual((await view()).missingReports, [worker.id]);
  assert.equal((await f.call("diy/squad/wait", { squadId: squad.id, timeoutMs: 5000 })).reason, "unreported_turn");
  await post(); await f.waitForPrompt(c => c.prompt.includes("#2"));
  assert.deepEqual((await view()).missingReports, []);
  await assert.rejects(f.call("diy/squad/fallback", { squadId: squad.id, workerId: worker.id, requestId: randomUUID() }), /terminal|completed|unreported/i);
  assert.equal((await f.call("diy/squad/ledger", { squadId: squad.id })).entries.length, 2);
});
test("failed turns without assistant text expose their cause and support honest fallback", async t => {
  const { f, worker, squad, post, view } = await fixture(t, async () => { throw new Error("approval cannot be answered in background"); });
  await post(); await f.gateway.protocol.active.get(worker.id)?.done;
  const snapshot = await view(); assert.match(snapshot.turnDiagnostics[worker.id].message, /approval cannot/);
  const result = await f.call("diy/squad/fallback", { squadId: squad.id, workerId: worker.id, requestId: randomUUID() });
  assert.match(result.summary, /系统代记 · 回合失败/); assert.match(result.summary, /approval cannot/); assert.equal(result.verdict, undefined);
  assert.deepEqual((await view()).missingReports, []);
});
test("a recovered delivery failure remains in history without a current warning", async t => {
  const { f, worker, post, view } = await fixture(t);
  const select = f.gateway.protocol.selectModel;
  f.gateway.protocol.selectModel = async () => { throw new Error("catalog unavailable"); };
  await post(); f.gateway.protocol.selectModel = select;
  assert.equal((await view()).unresolvedDeliveries[0].state, "failed");
  await post(); await f.gateway.protocol.active.get(worker.id)?.done;
  await post({ authorThreadId: worker.id, kind: "handoff", next: "@supervisor", summary: "recovered" });
  const snapshot = await view(); assert.deepEqual(snapshot.unresolvedDeliveries, []); assert.equal(snapshot.memberStates[worker.id], "done");
  assert(snapshot.ledger.deliveries.some(d => d.state === "failed"), "historical evidence is immutable");
});
test("ball ownership preserves notes, escalates a null blocked entry and clears explicit null handoffs", async t => {
  const { post, f, squad } = await fixture(t);
  const ball = async () => (await f.call("diy/squad/ledger", { squadId: squad.id })).ballInCourt;
  await post({ kind: "handoff", next: "@supervisor" }); assert.equal(await ball(), "supervisor");
  await post({ kind: "note", next: null }); assert.equal(await ball(), "supervisor");
  await post({ kind: "handoff", next: null }); assert.equal(await ball(), null);
  await post({ kind: "blocked", next: null }); assert.equal(await ball(), "supervisor");
  await post({ kind: "review", next: null, verdict: "approved" }); assert.equal(await ball(), null);
});
test("ledger-only summaries omit empty file and compatibility sections", async t => {
  const { f, squad, post } = await fixture(t);
  await post({ kind: "note", next: null });
  const result = await f.call("diy/squad/summarize", { squadId: squad.id, draftOnly: true });
  assert.doesNotMatch(result.text, /涉及文件：|兼容回报：/);
});
test("wait exposes an immediate idle snapshot", async t => {
  const { f, squad } = await fixture(t);
  const result = await f.call("diy/squad/wait", { squadId: squad.id, timeoutMs: 0 }); assert.equal(result.status, "idle");
});

async function until(read, predicate, budget = 2000) {
  const deadline = Date.now() + budget;
  do { const result = await read(); if (predicate(result)) return result; await new Promise(r => setTimeout(r, 5)); } while (Date.now() < deadline);
  throw new Error("wait test condition did not settle");
}
test("wait does not own serial: worker post wakes it promptly, and sinceSeq also catches an already posted conclusion", async t => {
  let release, report; const gate = new Promise(r => release = r); t.after(() => release());
  const { f, worker, squad, post } = await fixture(t, async context => { await gate; await report(); context.onText("reported"); });
  let conclusion; report = async () => { conclusion = await post({ authorThreadId: worker.id, kind: "handoff", next: "@supervisor", summary: "approved and returned" }); };
  const task = await post();
  const waiting = f.call("diy/squad/wait", { squadId: squad.id, sinceSeq: task.seq, timeoutMs: 5000 });
  await until(() => f.gateway.spine.activeTasks, n => n === 1);
  const before = performance.now(); release(); const result = await waiting;
  assert.equal(result.status, "settled"); assert(performance.now() - before < 500, "worker post and terminal wake must not wait for the polling interval");
  assert.equal(result.latestSeq, conclusion.seq); assert(result.entries.every(e => e.seq > task.seq));
  const raced = await f.call("diy/squad/wait", { squadId: squad.id, sinceSeq: task.seq, targetHandles: ["@DEV"], timeoutMs: 1000 }); assert.equal(raced.status, "settled");
  assert.equal((await f.call("diy/squad/wait", { squadId: squad.id, timeoutMs: 0 })).status, "idle");
});
test("wait wakes immediately for a new blocked entry and does not wait for running siblings", async t => {
  let release; const hold = new Promise(r => release = r); t.after(() => release());
  const { f, worker, squad, post } = await fixture(t, () => hold);
  const task = await post();
  const waiting = f.call("diy/squad/wait", { squadId: squad.id, sinceSeq: task.seq, timeoutMs: 5000 });
  await until(() => f.gateway.spine.activeTasks, n => n === 1);
  await post({ authorThreadId: worker.id, kind: "blocked", next: null, summary: "need human decision" });
  const result = await waiting; assert.equal(result.status, "needs_human"); assert.equal(result.reason, "blocked_entry"); assert.equal(result.ballInCourt, "supervisor");
});
for (const [status, reason] of [[{ type: "active", activeFlags: ["waitingOnApproval"] }, "waiting_approval"], [{ type: "active", activeFlags: ["waitingOnUserInput"] }, "waiting_input"], [{ type: "needs_attention" }, "turn_failed"], [{ type: "systemError" }, "turn_failed"], [{ type: "error" }, "turn_failed"], [{ type: "failed" }, "turn_failed"]]) test(`wait immediately exposes ${reason} (${status.type})`, async t => {
  const { f, worker, squad } = await fixture(t); f.gateway.protocol.store.save({ ...f.gateway.protocol.store.get(worker.id), status });
  const before = performance.now(); const result = await f.call("diy/squad/wait", { squadId: squad.id, timeoutMs: 5000 });
  assert.equal(result.status, "needs_human"); assert(result.blockers.some(b => b.reason === reason)); assert(performance.now() - before < 500);
});
test("unreported completed turns, actual background approval failures and interrupted empty turns all wake with honest diagnostics", async t => {
  const { f, worker, squad, post } = await fixture(t, context => context.ask([{ id: "approval", header: "Permission", question: "Allow tool?" }]));
  const task = await post(); await f.gateway.protocol.active.get(worker.id)?.done;
  const result = await f.call("diy/squad/wait", { squadId: squad.id, sinceSeq: task.seq, timeoutMs: 5000 });
  assert.equal(result.status, "needs_human"); assert.equal(result.reason, "turn_failed"); assert.match(result.blockers[0].message, /无法回答交互审批/);
  const thread = f.gateway.protocol.store.get(worker.id), turn = thread.turns.at(-1); turn.status = "interrupted"; turn.error = null; f.gateway.protocol.store.save(thread);
  const fallback = await f.call("diy/squad/fallback", { squadId: squad.id, workerId: worker.id, requestId: randomUUID() }); assert.match(fallback.summary, /回合中断/);
  const repaired = await f.call("diy/squad/wait", { squadId: squad.id, sinceSeq: task.seq, timeoutMs: 5000 }); assert.equal(repaired.status, "settled");
});
test("wait reports hop brakes and unresolved delivery outcomes without stale recovered warnings", async t => {
  const { f, worker, squad, post } = await fixture(t), { loadSquads, saveSquads } = await import("../gateway/spine/squad-lite.mjs");
  const store = await loadSquads(f.home); store.squads[squad.id].maxAutoHops = 0; await saveSquads(f.home, store);
  await post({ authorThreadId: worker.id });
  let result = await f.call("diy/squad/wait", { squadId: squad.id, timeoutMs: 5000 }); assert.equal(result.reason, "hop_limit_paused");
  const { readLedger, saveLedger } = await import("../gateway/spine/squad-ledger.mjs"), ledger = readLedger(f.home, squad.id);
  ledger.hopPausedForHuman = false; ledger.deliveries.at(-1).state = "sending"; saveLedger(f.home, store.squads[squad.id], ledger);
  result = await f.call("diy/squad/wait", { squadId: squad.id, timeoutMs: 5000 }); assert.equal(result.reason, "delivery_unresolved");
  ledger.deliveries.at(-1).state = "failed"; ledger.deliveries.at(-1).error = "send failed"; saveLedger(f.home, store.squads[squad.id], ledger);
  result = await f.call("diy/squad/wait", { squadId: squad.id, timeoutMs: 5000 }); assert.equal(result.reason, "delivery_failed");
  const seq = ledger.entries.at(-1).seq;
  await post({ authorThreadId: worker.id, kind: "handoff", next: "@supervisor", summary: "human recovered" });
  result = await f.call("diy/squad/wait", { squadId: squad.id, sinceSeq: seq, timeoutMs: 5000 }); assert.equal(result.status, "settled"); assert.equal(result.blockers, undefined);
});
test("native latest-dispatch diagnostics reject an older missing report while the newer turn runs, and preserve failure reasons", async t => {
  const { f, squad, post } = await fixture(t), { attachSquadNative } = await import("./squad-native-fixture.mjs"), native = await attachSquadNative(t, f, { holdTurns: true });
  const worker = await native.create(), binding = (await f.call("diy/host/status")).bindings.find(b => b.squad);
  await f.call("diy/squad/add", { squadId: squad.id, threadId: worker.id, shortName: "native", hostRef: { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: worker.id } });
  await post({ next: "@native" }); let ledger = await f.call("diy/squad/ledger", { squadId: squad.id }); native.finish(ledger.deliveries.at(-1).turnId);
  await post({ next: "@native" }); ledger = await f.call("diy/squad/ledger", { squadId: squad.id }); const delivery = ledger.deliveries.at(-1);
  assert.equal((await f.call("diy/squad/list", { squadId: squad.id })).squads[0].missingReports.includes(worker.id), false);
  await assert.rejects(f.call("diy/squad/fallback", { squadId: squad.id, workerId: worker.id, requestId: randomUUID() }), /terminal/);
  const waiting = f.call("diy/squad/wait", { squadId: squad.id, sinceSeq: delivery.seq, targetHandles: ["@native"], timeoutMs: 5000 });
  await until(() => f.gateway.spine.activeTasks, n => n > 0);
  native.finish(delivery.turnId); native.turns.get(delivery.turnId).status = "failed"; native.turns.get(delivery.turnId).error = { message: "native permission blocked" };
  const result = await waiting; assert.equal(result.status, "needs_human"); assert(result.blockers.some(b => b.reason === "turn_failed" && b.message.includes("native permission blocked")));
  const entry = await f.call("diy/squad/fallback", { squadId: squad.id, workerId: worker.id, requestId: randomUUID() }); assert.match(entry.summary, /native permission blocked/);
});

async function mcpClient(t, f) {
  const fs = await import("node:fs/promises"), path = await import("node:path"), { PassThrough } = await import("node:stream"), { runMcp } = await import("../gateway/spine/mcp-server.mjs");
  const file = path.join(f.home, "wait-mcp.json"); await fs.writeFile(file, JSON.stringify({ ...f.config, spine: { mcp: true } }), { mode: 0o600 });
  const { spineNativeArguments } = await import("../gateway/spine/native-config.mjs");
  const outerBudget = Number(spineNativeArguments({ ...f.config, spine: { mcp: true } }, file).join(" ").match(/tool_timeout_sec=(\d+)/)[1]) * 1000;
  assert(outerBudget > 130000, "native MCP must not truncate the gateway wait budget");
  const input = new PassThrough(), output = new PassThrough(), messages = []; let buffer = "", id = 0;
  output.on("data", chunk => { buffer += chunk; for (;;) { const end = buffer.indexOf("\n"); if (end < 0) break; messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
  const server = runMcp(file, input, output); t.after(async () => { input.end(); await server; output.destroy(); });
  const send = frame => input.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
  const call = async (method, params, budget = 2500) => { const requestId = ++id; send({ id: requestId, method, params }); return until(() => messages.find(m => m.id === requestId), Boolean, budget); };
  await call("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "squad-wait-test", version: "1" }, capabilities: {} }); send({ method: "notifications/initialized" });
  return { send, call, messages };
}
test("Legacy CLI waits exceed 15 seconds while V2 MCP rejects the retired wait primitive", { timeout: 24000 }, async t => {
  let release; const hold = new Promise(r => release = r); t.after(() => release());
  const { f, squad, post } = await fixture(t, () => hold); const task = await post(), mcp = await mcpClient(t, f);
  const { spawn } = await import("node:child_process"), path = await import("node:path");
  const params = { squadId: squad.id, sinceSeq: task.seq, timeoutMs: 16000 };
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../gateway/spine/squad-cli.mjs"), path.join(f.home, ".mycodex/squad-client.json"), "wait"], { cwd: f.home, env: { PATH: process.env.PATH, HOME: f.home, CODEX_HOME: path.join(f.home, "profile") }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
  const exited = new Promise(resolve => child.once("exit", resolve)); t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  const started = performance.now(); child.stdin.end(JSON.stringify(params));
  const [response, code] = await Promise.all([mcp.call("tools/call", { name: "mycodex.squad_wait", arguments: params }, 21000), exited]);
  assert.equal(response.error.code, -32602);
  assert.equal(code, 0, stderr + stdout); assert.equal(JSON.parse(stdout).result.status, "timeout"); assert(performance.now() - started >= 15800);
  await until(() => f.gateway.spine.activeTasks, n => n === 0);
});
test("V2 MCP rejects retired wait/list tools and keeps unrelated reads usable", async t => {
  const { f, squad } = await fixture(t), mcp = await mcpClient(t, f);
  for (const name of ['mycodex.squad_wait', 'mycodex.squad_list']) {
    const response = await mcp.call('tools/call', { name, arguments: { squadId: squad.id } });
    assert.equal(response.error.code, -32602);
  }
  const response = await mcp.call('tools/call', { name: 'mycodex.spine_status', arguments: {} });
  assert.equal(response.result.isError, false);
});
test("disconnect aborts an outstanding read and releases activeTasks so an otherwise idle gateway can retire", async t => {
  const { connectGateway, writeMessage } = await import("../gateway/ipc.mjs"), { RpcPeer } = await import("../gateway/rpc-peer.mjs");
  const f = await squadFixture(t, undefined, { onRetire() {}, runtimeGeneration: "squad-wait-retirement" });
  const anchor = await f.createThread(), worker = await f.createThread(), squad = await f.call("diy/squad/create", { anchorThreadId: anchor.id, label: "disconnect" });
  await f.call("diy/squad/add", { squadId: squad.id, threadId: worker.id, shortName: "dev" });
  f.gateway.protocol.store.save({ ...f.gateway.protocol.store.get(worker.id), status: { type: "active" } });
  let socket; const peer = new RpcPeer(message => writeMessage(socket, message)); socket = await connectGateway(f.config, message => peer.receive(message)); socket.once("close", () => peer.close());
  await peer.request("initialize", {});
  const waiting = peer.request("diy/squad/wait", { squadId: squad.id, timeoutMs: 120000 }); const rejected = assert.rejects(waiting, /disconnected/);
  await until(() => f.gateway.spine.activeTasks, n => n === 1); socket.destroy(); await rejected;
  await until(() => f.gateway.spine.activeTasks, n => n === 0);
  f.gateway.protocol.store.save({ ...f.gateway.protocol.store.get(worker.id), status: { type: "idle" } });
  const result = await f.call("gateway/retireIfIdle", { expectedPid: process.pid, expectedRuntimeGeneration: "squad-wait-retirement" }); assert.equal(result.retiring, true);
});
test("CLI abort and killed CLI sockets cancel their own waits immediately", async t => {
  const { runSquadCommand } = await import("../gateway/spine/squad-cli.mjs"), { Readable } = await import("node:stream"), path = await import("node:path");
  let release; const hold = new Promise(r => release = r); t.after(() => release());
  const { f, squad, post } = await fixture(t, () => hold); await post();
  const controller = new AbortController(), file = path.join(f.home, ".mycodex/squad-client.json");
  const waiting = runSquadCommand(file, "wait", Readable.from([JSON.stringify({ squadId: squad.id, timeoutMs: 120000 })]), controller.signal); const rejected = assert.rejects(waiting, /cancelled/);
  await until(() => f.gateway.spine.activeTasks, n => n === 1); controller.abort(); await rejected; await until(() => f.gateway.spine.activeTasks, n => n === 0);
  const { spawn } = await import("node:child_process"), child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../gateway/spine/squad-cli.mjs"), file, "wait"], { cwd: f.home, stdio: ["pipe", "ignore", "ignore"] });
  const exited = new Promise(resolve => child.once("exit", resolve)); child.stdin.end(JSON.stringify({ squadId: squad.id, timeoutMs: 120000 }));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  await until(() => f.gateway.spine.activeTasks, n => n === 1); child.kill("SIGTERM"); await exited; await until(() => f.gateway.spine.activeTasks, n => n === 0);
});
test("wait validates ranges and targets and uses the bounded end-to-end deadline budget", async t => {
  const { squadWaitTimeout } = await import("../gateway/spine/squad-wait-client.mjs"), { f, squad } = await fixture(t);
  assert.equal(squadWaitTimeout({}), 40000); assert.equal(squadWaitTimeout({ timeoutMs: 16000 }), 26000); assert.equal(squadWaitTimeout({ timeoutMs: 120000 }), 130000);
  for (const bad of [{ timeoutMs: -1 }, { timeoutMs: 120001 }, { sinceSeq: -1 }, { sinceSeq: 0.5 }, { targetHandles: Array(21).fill("dev") }, { targetHandles: ["unknown"] }, { unknown: true }]) await assert.rejects(f.call("diy/squad/wait", { squadId: squad.id, ...bad }), /Invalid|Unknown/);
});

test("a newer queued dispatch also supersedes older unreported sent turns", async t => {
  let release, runs = 0; const hold = new Promise(r => release = r); t.after(() => release());
  const { f, worker, squad, post, view } = await fixture(t, async context => { if (++runs > 1) await hold; context.onText("done"); });
  await post(); await f.gateway.protocol.active.get(worker.id)?.done;
  await f.call("turn/start", { threadId: worker.id, input: [{ type: "text", text: "manual busy turn" }] });
  await post(); const snapshot = await view(); assert.equal(snapshot.ledger.deliveries.at(-1).state, "queued"); assert.deepEqual(snapshot.missingReports, []);
  await assert.rejects(f.call("diy/squad/fallback", { squadId: squad.id, workerId: worker.id, requestId: randomUUID() }), /completed/);
});
test("a suspended native probe never owns serial, and cancellation releases the read even if the native response is delayed", async t => {
  const { attachSquadNative } = await import("./squad-native-fixture.mjs"), { requestSquadWait } = await import("../gateway/spine/squad-wait-client.mjs");
  let release, entered, slow = false; const hold = new Promise(r => release = r), started = new Promise(r => entered = r); t.after(() => release());
  const { f, squad, post } = await fixture(t), native = await attachSquadNative(t, f, { holdTurns: true, beforeRequest: async method => { if (slow && method === "thread/turns/list") { entered(); await hold; } } });
  const worker = await native.create(), binding = (await f.call("diy/host/status")).bindings.find(b => b.squad);
  await f.call("diy/squad/add", { squadId: squad.id, threadId: worker.id, shortName: "slow-native", hostRef: { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: worker.id } });
  await post({ next: "@slow-native" }); slow = true;
  const controller = new AbortController(), waiting = requestSquadWait(f.config, { squadId: squad.id, timeoutMs: 120000, targetHandles: ["@slow-native"] }, controller.signal), rejected = assert.rejects(waiting, /cancelled/);
  await started; const before = performance.now();
  await post({ authorThreadId: worker.id, kind: "note", next: null, summary: "probe does not block writes" }); assert(performance.now() - before < 500);
  controller.abort(); await rejected; await until(() => f.gateway.spine.activeTasks, n => n === 0); release();
});
