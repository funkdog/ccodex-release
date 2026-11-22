import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { squadFixture } from "./squad-flow-fixture.mjs";
import { createNativeHostPeer } from "../gateway/native-host-peer.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { squadAction } from "../gateway/spine/squad-actions.mjs";
import { attachSquadNative } from "./squad-native-fixture.mjs";

test("native and different CLI sessions can create workers, exchange briefs and return results without WorkItems", async t => {
  const f = await squadFixture(t), nativeThreads = new Map(), nativePrompts = [];
  const request = async (method, p) => {
    if (method === "thread/start") { const thread = { id: randomUUID(), cwd: p.cwd, model: p.model ?? "native-model", status: { type: "idle" } }; nativeThreads.set(thread.id, thread); return { thread }; }
    if (method === "thread/list") return { data: [...nativeThreads.values()], nextCursor: null };
    if (method === "thread/loaded/list") return { data: [...nativeThreads.keys()] };
    if (method === "model/list") return { data: [{ id: "native-model", displayName: "Native Codex" }] };
    if (method === "thread/read" || method === "thread/resume") return { thread: nativeThreads.get(p.threadId) };
    if (method === "turn/start") { nativePrompts.push(p); return { turn: { id: randomUUID() } }; }
    throw new Error(method);
  };
  let native;
  native = new RpcPeer(message => queueMicrotask(() => native.receive({ id: message.id, result: { account: { type: "chatgpt", id: "squad-test" } } })));
  const channel = createNativeHostPeer(f.config, native, id => f.gateway.protocol.store.threads.has(id), () => {}, { runExclusive: async (_id, run) => run(), squadRequest: request });
  t.after(() => channel.close()); await channel.start();
  const binding = (await f.call("diy/host/status")).bindings[0], hostRef = { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: "00000000-0000-0000-0000-000000000000" };
  const anchor = (await request("thread/start", { cwd: f.home })).thread;
  const squad = await f.call("diy/squad/create", { anchorThreadId: anchor.id, anchorHostRef: { ...hostRef, threadId: anchor.id }, label: "Native supervisor" });
  const cli = await f.call("diy/squad/create_member", { squadId: squad.id, shortName: "CLI worker", kind: "cli", model: "fixture/model", requestId: randomUUID() });
  const cliDispatch = await f.call("diy/squad/dispatch", { squadId: squad.id, workerId: cli.threadId, squadGoal: "Cross runtime", task: "CLI task" });
  await f.gateway.protocol.active.get(cli.threadId)?.done;
  await f.call("diy/squad/report", { squadId: squad.id, workerId: cli.threadId, dispatchId: cliDispatch.brief.dispatchId, summary: "CLI result", status: "completed", completedAt: Date.now() });
  await f.call("diy/squad/summarize", { squadId: squad.id, requestId: randomUUID() });
  assert(nativePrompts.some(p => p.threadId === anchor.id && p.input[0].text.includes("CLI result")));
  const second = await f.call("diy/squad/create_member", { squadId: squad.id, shortName: "Native worker", kind: "native", hostRef, model: "native-model", requestId: randomUUID() });
  const id = randomUUID(), params = { squadId: squad.id, workerId: second.threadId, squadGoal: "Goal", task: "Native task", requestId: id };
  await f.call("diy/squad/dispatch", params); await f.call("diy/squad/dispatch", params);
  assert.equal(nativePrompts.filter(p => p.threadId === second.threadId).length, 1);
  assert.equal(f.gateway.protocol.store.all().length, 1, "Native chats never become synthetic StoredThreads");
});

test("an uncertain native action blocks new request IDs and recovers its original receipt without another send", async t => {
  const f = await squadFixture(t), requestId = randomUUID(), payload = { operation: "dispatch", id: "sq-12345678", workerId: randomUUID(), task: "One action" };
  let sends = 0;
  const send = async () => { sends++; throw new Error("response lost after acceptance"); };
  await assert.rejects(squadAction(f.home, requestId, payload, send), /response lost/);
  await assert.rejects(squadAction(f.home, randomUUID(), payload, send), /must be reconciled/);
  assert.equal(sends, 1);
  const receipt = { turnId: randomUUID() };
  assert.deepEqual(await squadAction(f.home, requestId, payload, send, async () => receipt), receipt);
  assert.deepEqual(await squadAction(f.home, requestId, payload, send), receipt);
  assert.equal(sends, 1);
  await assert.rejects(squadAction(f.home, requestId, { ...payload, task: "changed action" }, send), /another Squad action/);
});

test("native deletion during a gateway reconnect is replayed as cleanup without recreating or dispatching a chat", async t => {
  const f = await squadFixture(t), native = await attachSquadNative(t, f), anchor = await native.create();
  const binding = (await f.call("diy/host/status")).bindings[0];
  const squad = await f.call("diy/squad/create", { anchorThreadId: anchor.id, label: "Reconnect cleanup", anchorHostRef: { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: anchor.id } });
  await f.restart(); await native.remove(anchor.id);
  const end = Date.now() + 5000;
  while ((await f.call("diy/squad/list")).squads.some(s => s.id === squad.id)) {
    if (Date.now() > end) throw new Error("Native cleanup did not recover its connection");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(native.prompts.length, 0); assert.equal(native.threads.size, 0);
});

test("native worker creation inherits anchor permission boundary, squadTools declare local MCP annotations, and legacy dispatch injects role prefix", async t => {
  const fs = await import("node:fs/promises"), path = await import("node:path");
  const { squadTools } = await import("../gateway/spine/squad-commands.mjs");
  for (const tool of squadTools) {
    assert.equal(tool.annotations?.destructiveHint, false, tool.name);
    assert.equal(tool.annotations?.openWorldHint, false, tool.name);
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", tool.name);
  }
  const starts = [];
  const f = await squadFixture(t), native = await attachSquadNative(t, f, { beforeRequest: (method, p) => { if (method === "thread/start") starts.push(p); } });
  const anchor = await native.create();
  const rollout = path.join(f.home, "anchor-rollout.jsonl");
  await fs.writeFile(rollout, JSON.stringify({ type: "turn_context", payload: { approval_policy: "never", sandbox_policy: { type: "danger-full-access" } } }) + "\n", { mode: 0o600 });
  anchor.path = rollout;
  const binding = (await f.call("diy/host/status")).bindings[0], hostRef = { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: "00000000-0000-0000-0000-000000000000" };
  await f.call("diy/squad/roles", { roles: [{ id: "dev-jimao", handle: "码农鸡毛", kind: "native", model: "native-model", defaultPromptPrefix: "【角色真实验证前缀】" }] });
  const squad = await f.call("diy/squad/create", { anchorThreadId: anchor.id, anchorHostRef: { ...hostRef, threadId: anchor.id }, label: "Inherit permissions" });
  starts.length = 0;
  const worker = await f.call("diy/squad/create_member", { squadId: squad.id, shortName: "码农鸡毛", kind: "native", hostRef, model: "native-model", requestId: randomUUID() });
  assert.equal(starts[0].approvalPolicy, "never");
  assert.equal(starts[0].sandbox, "danger-full-access");
  await f.call("diy/squad/dispatch", { squadId: squad.id, workerId: worker.threadId, squadGoal: "Goal", task: "Check prefix", requestId: randomUUID() });
  assert.match(native.prompts.at(-1).input[0].text, /^【角色真实验证前缀】/);
  // Custom workspace-write roots and network restrictions must survive inheritance.
  await fs.writeFile(rollout, JSON.stringify({ type: "turn_context", payload: { approval_policy: "on-request", sandbox_policy: { type: "workspace-write", writable_roots: ["/only/one"], network_access: false } } }) + "\n", { mode: 0o600 });
  starts.length = 0;
  await f.call("diy/squad/create_member", { squadId: squad.id, shortName: "受限成员", kind: "native", hostRef, model: "native-model", requestId: randomUUID() });
  assert.equal(starts[0].approvalPolicy, "on-request");
  assert.equal(starts[0].sandbox, "workspace-write");
  assert.deepEqual(starts[0].config["sandbox_workspace_write.writable_roots"], ["/only/one"]);
  assert.equal(starts[0].config["sandbox_workspace_write.network_access"], false);
});


test("native permission inheritance scans beyond 256 KiB and skips corrupt newer records", async t => {
  const fs = await import("node:fs/promises"), path = await import("node:path"), os = await import("node:os");
  const { createSquadNativeHandler } = await import("../gateway/squad-native-peer.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "squad-permissions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rollout = path.join(root, "rollout.jsonl"), starts = [];
  const anchorId = randomUUID(), ref = { threadId: randomUUID() };
  const handler = createSquadNativeHandler({ ownsThread: () => false, runExclusive: (_id, run) => run(), request: async (method, p) => {
    if (method === "thread/read") return { thread: { path: rollout } };
    assert.equal(method, "thread/start"); starts.push(p);
    return { thread: { id: randomUUID(), cwd: root, status: { type: "idle" } } };
  } });
  const context = (approval, sandbox) => JSON.stringify({ type: "turn_context", payload: { approval_policy: approval, sandbox_policy: sandbox } });
  const largeOutput = JSON.stringify({ type: "event_msg", payload: { text: "长输出".repeat(50000) } });
  const full = { type: "danger-full-access" };
  const restricted = { type: "workspace-write", writable_roots: [path.join(root, "中文")], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: false };
  const restrictedContext = context("on-request", restricted);
  const splitAt = Buffer.from(restrictedContext).indexOf(Buffer.from("中文")) + 1;
  const utf8SuffixLength = 64 * 1024 - (Buffer.byteLength(restrictedContext) - splitAt);
  const cases = [
    [context("never", full) + "\n" + largeOutput + "\n", "never", full],
    // A context crossing a reverse-read block boundary, including UTF-8 roots.
    [restrictedContext + "\n" + " ".repeat(utf8SuffixLength - 1), "on-request", restricted],
    // Prefer the latest valid context, tolerate unrelated bad rows and a partial final write.
    [context("never", full) + "\n" + largeOutput + "\n" + context("on-request", restricted) + "\n" + largeOutput + '\n{"type":"turn_context",bad}\nnull\n{"type":"turn_context","payload":{}}\n{"type":"turn_context",', "on-request", restricted],
    [context("never", full), "never", full],
  ];
  for (const [history, approval, sandbox] of cases) {
    await fs.writeFile(rollout, history, { mode: 0o600 });
    const receipt = await handler(ref, { operation: "create", requestId: randomUUID(), anchorThreadId: anchorId, cwd: root });
    assert.equal(receipt.state, "accepted");
    const start = starts.at(-1);
    assert.equal(start.approvalPolicy, approval);
    assert.equal(start.sandbox, sandbox.type);
    if (sandbox === restricted) {
      for (const key of ["writable_roots", "network_access", "exclude_tmpdir_env_var", "exclude_slash_tmp"]) assert.deepEqual(start.config[`sandbox_workspace_write.${key}`], restricted[key]);
    }
  }
});


test("native read reports effective model and effort from current context with thread metadata fallback", async t => {
  const fs = await import("node:fs/promises"), path = await import("node:path"), os = await import("node:os");
  const { createSquadNativeHandler } = await import("../gateway/squad-native-peer.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "squad-model-observation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rollout = path.join(root, "rollout.jsonl"), id = randomUUID();
  const native = { id, cwd: root, status: { type: "active" }, model: "thread-default", reasoningEffort: "high" };
  const handler = createSquadNativeHandler({ ownsThread: () => false, runExclusive: (_id, run) => run(), request: async method => { assert.equal(method, "thread/read"); return { thread: native }; } });
  const read = async () => (await handler({ threadId: id }, { operation: "read" })).thread;
  assert.equal((await read()).reasoningEffort, "high");
  native.path = rollout;
  const cases = [
    [{ model: "effective-model", effort: "xhigh" }, "effective-model", "xhigh"],
    [{ model: "alias-model", reasoning_effort: "low" }, "alias-model", "low"],
    [{ model: "collaboration-model", effort: "low", collaboration_mode: { settings: { reasoning_effort: "max" } } }, "collaboration-model", "max"],
    [{ effort: "medium" }, "thread-default", "medium"],
    [{ model: "no-reasoning", effort: null }, "no-reasoning", null],
  ];
  for (const [payload, model, effort] of cases) {
    const rows = [{ type: "turn_context", payload: { model: "old-model", effort: "minimal" } }, { type: "turn_context", payload }].map(row => JSON.stringify(row)).join("\n");
    await fs.writeFile(rollout, rows + "\n" + JSON.stringify({ type: "event_msg", payload: "x".repeat(300000) }) + '\n{"type":"turn_context",broken}\n{"type":"turn_context",');
    const observed = await read();
    assert.equal(observed.model, model);
    assert.equal(observed.reasoningEffort, effort);
  }
  await fs.rm(rollout);
  assert.equal((await read()).model, "thread-default");
  assert.equal((await read()).reasoningEffort, "high", "unavailable rollout does not erase thread metadata");
});

test("Phase 3 queues overlapping native reads per binding and cancels queued work", async () => {
  const { HostThreadBroker } = await import("../gateway/host-threads.mjs");
  const broker = new HostThreadBroker();
  const ref = { hostId: "local:" + "a".repeat(32), accountId: "b".repeat(64), runtimeId: randomUUID(), threadId: randomUUID() };
  let peak = 0, active = 0;
  const started = [];
  const connection = { role: "native-host", initialized: true, request: async (_method, { ref }) => {
    started.push(ref.threadId);
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return { ref, observedAt: new Date().toISOString(), title: "Worker", cwd: "/", status: "idle", archived: false };
  } };
  broker.register({ hostId: ref.hostId, accountId: ref.accountId, runtimeId: ref.runtimeId, accountVerified: true }, connection);
  const reads = Array.from({ length: 30 }, () => broker.read({ ...ref, threadId: randomUUID() }));
  const controller = new AbortController();
  const cancelled = assert.rejects(broker.read(ref, controller.signal), { name: "AbortError" });
  controller.abort();
  await Promise.all([...reads, cancelled]);
  assert.equal(peak, 4);
  assert.equal(started.length, 30);
  assert.ok(!started.includes(ref.threadId));
});

test("Phase 3 native turn observations share one thread read and preserve wait and model details", async () => {
  const { createSquadNativeHandler } = await import("../gateway/squad-native-peer.mjs");
  const ref = { hostId: "local:" + "a".repeat(32), accountId: "b".repeat(64), runtimeId: randomUUID(), threadId: randomUUID() };
  let reads = 0;
  const observe = createSquadNativeHandler({ ownsThread: () => false, runExclusive: (_id, fn) => fn(), request: async method => {
    if (method === "thread/read") {
      reads++;
      return { thread: { id: ref.threadId, cwd: "/", model: "native-model", status: { type: "active", activeFlags: ["waitingOnApproval"] } } };
    }
    assert.equal(method, "thread/turns/list");
    return { data: [{ id: "tracked", status: "inProgress", items: [{ type: "agentMessage", text: "working" }] }] };
  } });
  const result = await observe(ref, { operation: "turn", turnId: "tracked", includeText: true });
  assert.equal(reads, 1);
  assert.equal(result.status, "waitingOnApproval");
  assert.equal(result.thread.model, "native-model");
  assert.equal(result.text, "working");
});

test("Phase 3 bounds the native queue and releases all requests when the binding disconnects", async () => {
  const { HostThreadBroker } = await import("../gateway/host-threads.mjs");
  const broker = new HostThreadBroker(), runtimeId = randomUUID(), hostId = "local:" + "a".repeat(32), accountId = "b".repeat(64);
  let calls = 0;
  const connection = { role: "native-host", initialized: true, request: (_method, _params, signal) => {
    calls++;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } };
  broker.register({ runtimeId, hostId, accountId, accountVerified: true }, connection);
  const ref = { runtimeId, hostId, accountId, threadId: randomUUID() };
  const requests = Array.from({ length: 68 }, () => assert.rejects(broker.read(ref), /disconnected/));
  await assert.rejects(broker.read(ref), /queue is full/);
  assert.equal(calls, 4);
  broker.disconnect(connection);
  await Promise.all(requests);
  await assert.rejects(broker.read(ref), /unavailable/);
});
