import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { startGateway } from "../gateway/server.mjs";
import { connectGateway, writeMessage } from "../gateway/ipc.mjs";

const timeout = (promise, ms = 5000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Test timed out")), ms); })]).finally(() => clearTimeout(timer));
};
async function fixture(t, run, { model = { id: "fixture" }, models = [model], approvalModes, supportsImages, supportsModelSwitch, onRetire } = {}) {
  // Keep the Darwin Unix socket below its 104-byte path limit.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gw-"));
  const config = { home, endpoint: path.join(home, "s"), token: randomUUID(), generation: "test", runtimeGeneration: "test-runtime", onRetire,
    defaultEngine: "test", engines: new Map([["test", { models: async () => models, approvalModes, supportsImages, supportsModelSwitch, run }]]) };
  let server = await startGateway(config);
  const sockets = [];
  async function connect() {
    const pending = new Map();
    const events = [];
    let next = 1;
    const peer = { events, question: null };
    const socket = await connectGateway(config, message => {
      if (message.method && Object.hasOwn(message, "id")) {
        events.push(message);
        peer.question?.(message, result => writeMessage(socket, { id: message.id, result }));
      } else if (message.method) events.push(message);
      else {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        message.error ? entry?.reject(new Error(message.error.message)) : entry?.resolve(message.result);
      }
    });
    sockets.push(socket);
    peer.request = (method, params = {}, id = next++) => timeout(new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject }); writeMessage(socket, { id, method, params });
    }));
    peer.close = () => socket.destroy();
    await peer.request("initialize", { clientInfo: { name: "test", version: "1" } });
    return peer;
  }
  t.after(async () => { for (const socket of sockets) socket.destroy(); await server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { config, home, connect, server,
    restart: async () => { for (const socket of sockets) socket.destroy(); await server.close(); server = await startGateway(config); return server; } };
}

test("text-only CLI input remains readable by Desktop after persistence and restart", async t => {
  const prompts = [];
  const f = await fixture(t, async ({ prompt, onText }) => { prompts.push(prompt); onText("saved reply"); });
  let a = await f.connect();
  const { thread } = await a.request("thread/start", { cwd: f.home });
  const input = [{ type: "text", text: "continue this chat" }];
  const started = await a.request("turn/start", { threadId: thread.id, input });
  const desktopText = turn => turn.items.filter(item => item.type === "userMessage")
    .flatMap(item => item.content).filter(part => part.type === "text")
    .map(part => ({ text: part.text, placeholders: part.text_elements.flatMap(element => element.placeholder ? [element.placeholder] : []) }));
  const expected = [{ text: input[0].text, placeholders: [] }];
  assert.deepEqual(desktopText(started.turn), expected);
  await Promise.all([...f.server.protocol.active.values()].map(value => value.done));
  assert.deepEqual(desktopText(a.events.find(event => event.method === "turn/started").params.turn), expected);
  assert.deepEqual(f.server.protocol.store.get(thread.id).turns[0].items[0].content,
    [{ ...input[0], text_elements: [] }]);
  await f.restart(); a = await f.connect();
  assert.deepEqual(desktopText((await a.request("thread/resume", { threadId: thread.id })).thread.turns[0]), expected);
  assert.deepEqual(prompts, [input[0].text]);
});

test("legacy CLI history supplies Desktop text elements on every history read without rewriting stored content", async t => {
  const f = await fixture(t, async () => assert.fail("Reading history must not run the CLI"));
  let a = await f.connect();
  const { thread } = await a.request("thread/start", { cwd: f.home });
  const saved = f.server.protocol.store.get(thread.id);
  const elements = [{ byteRange: { start: 0, end: 5 }, placeholder: "voice metadata" }];
  const content = [{ type: "text", text: "older message" },
    { type: "text", text: "voice", text_elements: elements }, { type: "localImage", path: "/fixture/image.png" }];
  saved.turns = [{ id: randomUUID(), status: "completed", error: null,
    items: [{ id: randomUUID(), type: "userMessage", content },
      { id: randomUUID(), type: "agentMessage", text: "keep the whole reply", phase: "final_answer" }] }];
  f.server.protocol.store.save(saved);
  const file = path.join(f.home, "gateway", "threads", `${thread.id}.json`);
  const before = fs.readFileSync(file, "utf8");
  await f.restart(); a = await f.connect();
  const params = { threadId: thread.id };
  const turns = [
    (await a.request("thread/read", params)).thread.turns[0],
    (await a.request("thread/resume", params)).thread.turns[0],
    (await a.request("thread/turns/list", { ...params, itemsView: "full" })).data[0],
    (await a.request("thread/turns/list", { ...params, itemsView: "summary" })).data[0],
    { items: (await a.request("thread/items/list", params)).data.map(entry => entry.item) },
  ];
  for (const turn of turns) {
    const user = turn.items.find(item => item.type === "userMessage");
    // The current Desktop invokes this while mapping legacy message history.
    assert.deepEqual(user.content[0].text_elements.flatMap(element => element.placeholder), []);
    assert.deepEqual(user.content, [{ ...content[0], text_elements: [] }, ...content.slice(1)]);
    assert.equal(turn.items.find(item => item.type === "agentMessage").text, "keep the whole reply");
  }
  assert.equal(fs.readFileSync(file, "utf8"), before, "History projection must not migrate or overwrite the user's document");
});

test("new CLI chats inherit the engine's explicit approval preference across restart without changing existing chats", async t => {
  const seen = [];
  const f = await fixture(t, async ({ getApprovalMode, onText }) => { seen.push(getApprovalMode()); onText("ok"); },
    { approvalModes: ["ask", "auto", "deny"] });
  let a = await f.connect(), server = f.server;
  const create = async extra => (await a.request("thread/start", { cwd: f.home, approvalPolicy: "never", ...extra })).thread;
  const old = await create({ cliApprovalMode: "deny" });
  const chosen = await create({});
  await a.request("thread/settings/update", { threadId: chosen.id, cliApprovalMode: "auto" });
  const inherited = await create({});
  assert.equal(inherited.cliApprovalMode, "auto");
  assert.equal((await a.request("model/list")).data[0].defaultCliApprovalMode, "auto");
  assert.equal((await create({ cliApprovalMode: "ask" })).cliApprovalMode, "ask", "Explicit creation overrides the default");
  assert.equal((await create({})).cliApprovalMode, "auto", "A per-chat creation override cannot rewrite the saved preference");
  await a.request("turn/start", { threadId: inherited.id, cliApprovalMode: "ask", input: [{ type: "text", text: "stale host envelope" }] });
  await Promise.all([...server.protocol.active.values()].map(value => value.done));
  assert.deepEqual(seen, ["auto"], "Ordinary sends must not overwrite committed approval settings");
  server = await f.restart(); a = await f.connect();
  assert.equal((await create({})).cliApprovalMode, "auto");
  assert.equal((await a.request("thread/resume", { threadId: old.id })).thread.cliApprovalMode, "deny");
  await a.request("gateway/approval/default/set", { model: "test/fixture", cliApprovalMode: "ask" });
  assert.equal((await create({})).cliApprovalMode, "ask");
  assert.equal((await a.request("thread/resume", { threadId: inherited.id })).thread.cliApprovalMode, "auto");
});

test("draft approval preferences are validated, engine-scoped and do not create or run a chat", async t => {
  const f = await fixture(t, async () => assert.fail("Preferences must never submit a turn"), { approvalModes: ["ask", "auto", "deny"] });
  f.server.protocol.engines.set("other", { adapter: "other-adapter", models: async () => [{ id: "fixture" }], approvalModes: ["ask"], run: async () => assert.fail() });
  const a = await f.connect();
  await a.request("gateway/approval/default/set", { model: "test/fixture", cliApprovalMode: "auto" });
  for (const extra of [{ model: "other/fixture", cliApprovalMode: "auto" }, { model: "test/missing", cliApprovalMode: "auto" },
    { model: "test/fixture", cliApprovalMode: "invented" }, { model: "test/fixture", cliApprovalMode: "deny", unexpected: true }])
    await assert.rejects(a.request("gateway/approval/default/set", extra));
  const models = (await a.request("model/list")).data;
  assert.equal(models.find(m => m.id === "test/fixture").defaultCliApprovalMode, "auto");
  assert.equal(models.find(m => m.id === "other/fixture").defaultCliApprovalMode, "ask");
  assert.equal(f.server.protocol.store.all().length, 0);
  f.server.protocol.engines.get("test").adapter = "replacement";
  assert.equal((await a.request("model/list")).data.find(m => m.id === "test/fixture").defaultCliApprovalMode, "ask", "A replacement adapter cannot inherit the old adapter's grant");
});

test("an explicitly configured initial mode applies only until the user saves a preference", async t => {
  const f = await fixture(t, async () => {}, { approvalModes: ["ask", "auto", "deny"] });
  f.server.protocol.engines.get("test").initialApprovalMode = "auto";
  const a = await f.connect();
  const create = async () => (await a.request("thread/start", { cwd: f.home })).thread;
  assert.equal((await create()).cliApprovalMode, "auto");
  await a.request("gateway/approval/default/set", { model: "test/fixture", cliApprovalMode: "ask" });
  assert.equal((await create()).cliApprovalMode, "ask", "A saved explicit preference outranks installation defaults");
});

test("approval preference write failures roll back the session choice and never follow a linked file", async t => {
  const f = await fixture(t, async () => {}, { approvalModes: ["ask", "auto", "deny"] });
  const a = await f.connect(), { thread } = await a.request("thread/start", { cwd: f.home });
  await a.request("thread/settings/update", { threadId: thread.id, cliApprovalMode: "auto" });
  const target = path.join(f.home, "do-not-touch.json"), file = path.join(f.home, "gateway", "cli-approval-defaults.json");
  fs.writeFileSync(target, "preserve", { mode: 0o600 }); fs.unlinkSync(file); fs.symlinkSync(target, file);
  await assert.rejects(a.request("thread/settings/update", { threadId: thread.id, cliApprovalMode: "deny" }), /private owned regular/);
  assert.equal((await a.request("thread/resume", { threadId: thread.id })).thread.cliApprovalMode, "auto");
  assert.equal(fs.readFileSync(target, "utf8"), "preserve");
});

test("same-engine model switches preserve compatible effort, policy and CLI history across restart", async t => {
  const seen = [];
  const f = await fixture(t, async ({ model, nativeSessionId, reasoningEffort, getApprovalMode, onSession, onText }) => {
    seen.push([model, nativeSessionId, reasoningEffort, getApprovalMode()]); onSession(nativeSessionId || "same-session"); onText(model);
  }, { supportsModelSwitch: true, approvalModes: ["ask", "auto", "deny"], models: [
    { id: "first", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" },
    { id: "second", supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" },
    { id: "third", supportedReasoningEfforts: ["low", "medium"], defaultReasoningEffort: "medium" }] });
  let a = await f.connect(), server = f.server;
  const { thread } = await a.request("thread/start", { cwd: f.home, model: "test/first", effort: "high", cliApprovalMode: "auto" });
  const execute = async () => {
    await a.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "fixture" }] });
    await Promise.all([...server.protocol.active.values()].map(value => value.done));
  };
  await execute();
  const changed = (await a.request("thread/settings/update", { threadId: thread.id, model: "test/second" })).thread;
  assert.equal(changed.model, "test/second"); assert.equal(changed.reasoningEffort, "high"); assert.equal(changed.cliApprovalMode, "auto");
  assert.equal(seen.length, 1, "Choosing a model must not submit an inference turn");
  await assert.rejects(a.request("turn/start", { threadId: thread.id, model: "test/first", input: [{ type: "text", text: "stale" }] }), /model changed/);
  assert.equal(f.server.protocol.store.get(thread.id).model, "test/second");
  await execute();
  const adjusted = (await a.request("thread/settings/update", { threadId: thread.id, model: "test/third" })).thread;
  assert.equal(adjusted.reasoningEffort, "medium"); assert.equal(adjusted.cliApprovalMode, "auto");
  server = await f.restart(); a = await f.connect();
  const restored = (await a.request("thread/resume", { threadId: thread.id })).thread;
  assert.equal(restored.model, "test/third"); assert.equal(restored.reasoningEffort, "medium"); assert.equal(restored.cliApprovalMode, "auto");
  await execute();
  assert.deepEqual(seen, [["first", null, "high", "auto"], ["second", "same-session", "high", "auto"], ["third", "same-session", "medium", "auto"]]);
  assert.equal((await a.request("thread/read", { threadId: thread.id })).thread.turns.length, 3);
});

test("retirement requires exact identity and waits for active work to finish", async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let retired;
  const retiredSignal = new Promise(resolve => { retired = resolve; });
  const f = await fixture(t, async ({ onSession }) => { onSession("pending-session"); await blocked; },
    { onRetire: () => retired() });
  t.after(() => release());
  const a = await f.connect();
  await assert.rejects(a.request("gateway/retireIfIdle", { expectedPid: process.pid + 1, expectedRuntimeGeneration: "test-runtime" }), /identity/);
  const { thread } = await a.request("thread/start", { cwd: f.home, model: "test/fixture" });
  await a.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "fixture" }] });
  assert.equal(f.server.protocol.active.size, 1);
  assert.deepEqual(await a.request("gateway/retireIfIdle", { expectedPid: process.pid, expectedRuntimeGeneration: "test-runtime" }),
    { retiring: false, reason: "busy" });
  release();
  await Promise.all([...f.server.protocol.active.values()].map(value => value.done));
  assert.deepEqual(await a.request("gateway/retireIfIdle", { expectedPid: process.pid, expectedRuntimeGeneration: "test-runtime" }),
    { retiring: true });
  await timeout(retiredSignal);
});

test("native host requests with empty workspace hints create, resume and send directly through gateway IPC", async t => {
  const seen = [];
  const f = await fixture(t, async ({ cwd, reasoningEffort, onText }) => { seen.push({ cwd, reasoningEffort }); onText("ok"); },
    { models: [{ id: "fixture", supportedReasoningEfforts: ["high"] }] });
  const a = await f.connect();
  const { thread } = await a.request("thread/start", { cwd: f.home, runtimeWorkspaceRoots: [], effort: "high" });
  assert.equal(thread.cwd, f.home); assert.equal(thread.reasoningEffort, "high");
  assert.equal((await a.request("thread/resume", { threadId: thread.id, runtimeWorkspaceRoots: [] })).thread.id, thread.id);
  await a.request("turn/start", { threadId: thread.id, runtimeWorkspaceRoots: [], input: [{ type: "text", text: "fixture" }] });
  await Promise.all([...f.server.protocol.active.values()].map(turn => turn.done));
  assert.deepEqual(seen, [{ cwd: f.home, reasoningEffort: "high" }]);
  for (const roots of [["/nonexistent-mycodex-root"], ["relative"], [null], "not-an-array"]) {
    await assert.rejects(a.request("thread/start", { cwd: f.home, runtimeWorkspaceRoots: roots }));
    await assert.rejects(a.request("thread/resume", { threadId: thread.id, runtimeWorkspaceRoots: roots }));
  }
  assert.equal(f.server.protocol.store.all().length, 1);
  assert.equal(seen.length, 1);
});

test("native host context can include another project while the CLI cwd and approval policy stay unchanged", async t => {
  const seen = [];
  const f = await fixture(t, async ({ cwd, reasoningEffort, getApprovalMode, onText }) => {
    seen.push({ cwd, reasoningEffort, approval: getApprovalMode() }); onText("ok");
  }, { models: [{ id: "fixture", supportedReasoningEfforts: ["high"] }], approvalModes: ["ask", "deny"] });
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "other-project-")); t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const a = await f.connect(), roots = [f.home, other];
  const { thread } = await a.request("thread/start", { cwd: f.home, runtimeWorkspaceRoots: roots, effort: "high",
    permissions: ":danger-full-access", approvalPolicy: "never", cliApprovalMode: "deny" });
  assert.equal(thread.cwd, f.home); assert.equal(thread.cliApprovalMode, "deny");
  const resumed = await a.request("thread/resume", { threadId: thread.id, runtimeWorkspaceRoots: [...roots].reverse() });
  assert.equal(resumed.cwd, f.home); assert.equal(resumed.approvalPolicy, "never");
  await a.request("turn/start", { threadId: thread.id, runtimeWorkspaceRoots: roots, input: [{ type: "text", text: "fixture" }] });
  await Promise.all([...f.server.protocol.active.values()].map(turn => turn.done));
  assert.deepEqual(seen, [{ cwd: f.home, reasoningEffort: "high", approval: "deny" }]);
  for (const extras of [{ runtimeWorkspaceRoots: [other] }, { runtimeWorkspaceRoots: [f.home, "relative"] },
    { runtimeWorkspaceRoots: roots, cwd: other }, { runtimeWorkspaceRoots: roots, permissions: ":read-only" }])
    await assert.rejects(a.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "rejected" }], ...extras }));
  assert.equal(seen.length, 1, "Additional host roots cannot change execution cwd or grant a different policy");
});

test("model changes during execution affect the next turn and cannot be overwritten by old execution snapshots", async t => {
  let release, entered; const hold = new Promise(resolve => { release = resolve; }); const began = new Promise(resolve => { entered = resolve; });
  const seen = [];
  const f = await fixture(t, async ({ model, reasoningEffort, getApprovalMode, onSession, onText }) => {
    seen.push([model, reasoningEffort]); entered(); await hold; onSession("same-session"); onText(getApprovalMode());
  }, { supportsModelSwitch: true, approvalModes: ["ask", "auto", "deny"], models: [
    { id: "a", supportedReasoningEfforts: ["high"] }, { id: "b", supportedReasoningEfforts: ["medium"] }] });
  t.after(() => release());
  const a = await f.connect(), { thread } = await a.request("thread/start", { cwd: f.home, model: "test/a", cliApprovalMode: "auto" });
  await a.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "first" }] }); await began;
  try { await a.request("thread/settings/update", { threadId: thread.id, model: "test/b" }); }
  finally { release(); }
  await Promise.all([...f.server.protocol.active.values()].map(value => value.done));
  const saved = (await a.request("thread/read", { threadId: thread.id })).thread;
  assert.equal(saved.model, "test/b"); assert.equal(saved.reasoningEffort, "medium"); assert.equal(saved.cliApprovalMode, "auto");
  assert.deepEqual(seen, [["a", "high"]]);
  await a.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "next" }] });
  await Promise.all([...f.server.protocol.active.values()].map(value => value.done));
  assert.deepEqual(seen, [["a", "high"], ["b", "medium"]]);
});

test("switching from a CLI-controlled effort uses the target default instead of claiming explicit no-reasoning", async t => {
  const f = await fixture(t, async () => assert.fail(), { supportsModelSwitch: true, models: [{ id: "auto" },
    { id: "manual", supportedReasoningEfforts: ["none", "high"], defaultReasoningEffort: "high" }] });
  const a = await f.connect(), { thread } = await a.request("thread/start", { cwd: f.home, model: "test/auto" });
  assert.equal(thread.reasoningEffort, "none");
  const saved = (await a.request("thread/settings/update", { threadId: thread.id, model: "test/manual" })).thread;
  assert.equal(saved.reasoningEffort, "high");
});

test("unavailable/cross-engine/unsupported model settings fail atomically without changing policy", async t => {
  const f = await fixture(t, async () => assert.fail("Settings must not execute a CLI"), { supportsModelSwitch: true,
    approvalModes: ["ask", "auto"], models: [{ id: "a", supportedReasoningEfforts: ["high"] }, { id: "b", supportedReasoningEfforts: ["low"] }] });
  f.config.engines.set("other", { supportsModelSwitch: true, models: async () => [{ id: "a" }], run: async () => assert.fail() });
  const a = await f.connect(), { thread } = await a.request("thread/start", { cwd: f.home, model: "test/a", cliApprovalMode: "auto" });
  const before = f.server.protocol.store.get(thread.id);
  for (const settings of [{ model: "other/a" }, { model: "test/missing" }, { model: "test/b", reasoningEffort: "high" },
    { model: "test/b", cliApprovalMode: "deny" }, { model: null }]) {
    await assert.rejects(a.request("thread/settings/update", { threadId: thread.id, ...settings }));
    assert.deepEqual(f.server.protocol.store.get(thread.id), before);
  }
  f.config.engines.get("test").supportsModelSwitch = false;
  await assert.rejects(a.request("thread/settings/update", { threadId: thread.id, model: "test/b" }));
  assert.deepEqual(f.server.protocol.store.get(thread.id), before);
});

test("two connections with identical request IDs share admission, native IDs, events and durable history", async t => {
  let calls = 0;
  let finish;
  const hold = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, async ({ onSession, onText }) => { calls++; onSession("native-test"); await hold; onText("Synthetic answer"); });
  const a = await f.connect(); const b = await f.connect();
  const [one, two] = await Promise.all([a.request("thread/start", { cwd: f.home }, 20), b.request("thread/start", { cwd: f.home }, 20)]);
  assert.notEqual(one.thread.id, two.thread.id);
  const threadId = one.thread.id;
  const input = [{ type: "text", text: "synthetic" }];
  const results = await Promise.allSettled([a.request("turn/addUserMessage", { threadId, input }, 21), b.request("turn/start", { threadId, input }, 21)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(calls, 1);
  finish();
  await timeout(Promise.all([...f.server.protocol.active.values()].map(value => value.done)));
  const read = await b.request("thread/read", { threadId });
  assert.equal(read.thread.turns[0].status, "completed");
  assert.equal(read.thread.turns[0].items.at(-1).text, "Synthetic answer");
  assert.equal(read.thread.nativeSessionId, undefined);
  assert.equal(a.events.filter(event => event.method === "turn/completed").length, 1);
  assert.equal(b.events.filter(event => event.method === "turn/completed").length, 1);
  await f.restart();
  const c = await f.connect();
  assert.equal((await c.request("thread/read", { threadId })).thread.turns[0].status, "completed");
  assert.equal(calls, 1);
});

test("approval belongs to its originating connection and disconnect denies without cross-wiring", async t => {
  const outcomes = [];
  const f = await fixture(t, async ({ ask, onText }) => {
    try { const answer = await ask([{ id: "ok", header: "Test", question: "Allow?" }]); outcomes.push(answer); onText("answered"); }
    catch { outcomes.push("disconnected"); throw new Error("No permission"); }
  });
  const a = await f.connect(); const b = await f.connect();
  let question;
  const received = new Promise(resolve => { question = resolve; });
  a.question = message => question(message);
  const { thread } = await a.request("thread/start", { cwd: f.home });
  await a.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "test" }] });
  await timeout(received);
  assert.equal(b.events.some(event => Object.hasOwn(event, "id")), false);
  a.close();
  await timeout(Promise.all([...f.server.protocol.active.values()].map(value => value.done)));
  assert.deepEqual(outcomes, ["disconnected"]);
  assert.equal((await b.request("thread/read", { threadId: thread.id })).thread.turns[0].status, "failed");
});

test("interrupt waits for the engine to settle and emits one terminal event", async t => {
  let abortObserved;
  let finish;
  const observed = new Promise(resolve => { abortObserved = resolve; });
  const settled = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, async ({ signal }) => { signal.addEventListener("abort", abortObserved, { once: true }); await settled; });
  const a = await f.connect();
  const { thread } = await a.request("thread/start", { cwd: f.home });
  const { turn } = await a.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "test" }] });
  await a.request("turn/interrupt", { threadId: thread.id, turnId: turn.id });
  await timeout(observed);
  assert.equal((await a.request("thread/read", { threadId: thread.id })).thread.turns[0].status, "inProgress");
  finish();
  await timeout(Promise.all([...f.server.protocol.active.values()].map(value => value.done)));
  assert.equal((await a.request("thread/read", { threadId: thread.id })).thread.turns[0].status, "interrupted");
  assert.equal(a.events.filter(event => event.method === "turn/completed").length, 1);
});

test("unknown methods, engine switches, policies and nontext input have no CLI side effects", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; }); const a = await f.connect();
  const { thread } = await a.request("thread/start", { cwd: f.home });
  await assert.rejects(a.request("process/spawn", { command: "unsafe" }), /Unsupported/);
  for (const extra of [{ model: "other/model" }, { approvalPolicy: "auto-approve" }, { sandbox: "read-only" },
    { collaborationMode: { mode: "plan", settings: { model: "test/fixture" } } },
    { permissions: { access: "read-only" } }, { multiAgentMode: "proactive" }, { multiAgentMode: { custom: "unknown" } },
    { effort: "ultra" },
    { input: [{ type: "image", url: "x" }] }]) {
    await assert.rejects(a.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "test" }], ...extra }));
  }
  assert.equal(calls, 0);
  assert.equal((await a.request("thread/read", { threadId: thread.id })).thread.turns.length, 0);
});
test("vision turns deliver image blobs and preserve native image history across gateway restart", async t => {
  const inputs = [];
  const f = await fixture(t, async ({ prompt, attachments, onSession, onText }) => {
    inputs.push({ prompt, attachments }); onSession("vision-session"); onText("red");
  }, { model: { id: "fixture", capabilities: { supports: { vision: true } } }, supportsImages: true });
  let a = await f.connect();
  assert.deepEqual((await a.request("model/list")).data[0].inputModalities, ["text", "image"]);
  const { thread } = await a.request("thread/start", { cwd: f.home });
  const image = { type: "image", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=" };
  await a.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "What color?" }, image] });
  await Promise.all([...f.server.protocol.active.values()].map(turn => turn.done));
  assert.equal(inputs[0].prompt, "What color?");
  assert.equal(inputs[0].attachments[0].mimeType, "image/png");
  await f.restart(); a = await f.connect();
  const read = await a.request("thread/read", { threadId: thread.id });
  assert.deepEqual(read.thread.turns[0].items[0].content[1], image);
  assert.equal(read.thread.turns[0].status, "completed");
  await assert.rejects(a.request("turn/start", { threadId: thread.id, input: [{ type: "image", url: "https://example.com/image.png" }] }), /不抓取远程/);
  assert.equal(inputs.length, 1);
});

test("current Desktop full-access envelope sends text, exposes hydration reads and never auto-grants CLI permissions", async t => {
  let permission;
  const f = await fixture(t, async ({ ask, onText }) => {
    permission = await ask([{ id: "permission", header: "CLI", question: "Write?" }]); onText("text works");
  });
  const a = await f.connect();
  const { thread } = await a.request("thread/start", { cwd: f.home });
  const listed = (await a.request("thread/list", { sourceKinds: ["cli", "vscode", "appServer"], sortKey: "recency_at", sectionId: null })).data[0];
  assert.equal(listed.id, thread.id); assert.ok(listed.name); assert.equal(listed.historyMode, "legacy");
  for (const method of ["thread/attachment/list", "thread/queue/list"]) {
    assert.deepEqual(await a.request(method, { threadId: thread.id }), { data: [], nextCursor: null });
    await assert.rejects(a.request(method, { threadId: "missing" }));
  }
  assert.deepEqual(await a.request("thread/goal/get", { threadId: thread.id }), { goal: null });
  const envelope = { threadId: thread.id, input: [{ type: "text", text: "hello", text_elements: [] }],
    permissions: ":danger-full-access", runtimeWorkspaceRoots: [f.home], approvalPolicy: "never", approvalsReviewer: "user",
    collaborationMode: { mode: "default", settings: { model: "test/fixture", reasoning_effort: "none", developer_instructions: null } } };
  for (const extra of [{ permissions: ":read-only" }, { permissions: "custom-profile" },
    { sandboxPolicy: { type: "dangerFullAccess" } }, { runtimeWorkspaceRoots: ["/nonexistent-mycodex-root"] },
    { runtimeWorkspaceRoots: [f.home, "relative"] }]) await assert.rejects(a.request("turn/start", { ...envelope, ...extra }));
  assert.equal(permission, undefined);
  a.question = (_message, reply) => reply({ answers: { permission: { answers: ["Deny"] } } });
  await a.request("turn/start", { ...envelope, runtimeWorkspaceRoots: [path.dirname(f.home)] });
  await timeout(Promise.all([...f.server.protocol.active.values()].map(value => value.done)));
  assert.deepEqual(permission, { answers: { permission: { answers: ["Deny"] } } });
  assert.equal(a.events.filter(event => event.method === "item/tool/requestUserInput").length, 1);
  const read = await a.request("thread/read", { threadId: thread.id });
  assert.equal(read.thread.turns[0].status, "completed");
  assert.equal(read.thread.turns[0].items.at(-1).text, "text works");
  assert.equal((await a.request("thread/resume", { threadId: thread.id })).approvalPolicy, "never");
});

test("Desktop ordinary-send envelope and deprecated default work without enabling unsupported policies", async t => {
  const prompts = [];
  const f = await fixture(t, async ({ prompt, onText }) => { prompts.push(prompt); onText("done"); });
  const a = await f.connect();
  const { thread } = await a.request("thread/start", { cwd: f.home, model: "test/fixture" });
  const result = await a.request("turn/addUserMessage", { threadId: thread.id,
    input: [{ type: "text", text: "ordinary send" }], multiAgentMode: "explicitRequestOnly",
    collaborationMode: { mode: "default", settings: { model: "test/fixture", reasoning_effort: "none", developer_instructions: null } } });
  assert.equal(result.admissionOutcome, "started");
  await timeout(Promise.all([...f.server.protocol.active.values()].map(value => value.done)));
  const read = await a.request("thread/read", { threadId: thread.id });
  assert.equal(read.thread.turns[0].status, "completed");
  assert.deepEqual(prompts, ["ordinary send"]);
  const items = await a.request("thread/items/list", { threadId: thread.id, limit: 1000 });
  assert.equal(items.data.at(-1).item.text, "done");
  assert.equal(items.data.at(-1).turnId, result.turn.id);
});

test("second server cannot acquire an active instance or touch its state", async t => {
  const f = await fixture(t, async () => {});
  await assert.rejects(startGateway(f.config), { code: "EADDRINUSE" });
  const a = await f.connect();
  assert.equal((await a.request("model/list")).data[0].model, "test/fixture");
});

test("uncertain persisted execution is recovered as unknown, never automatically resubmitted", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; });
  const a = await f.connect(); const { thread } = await a.request("thread/start", { cwd: f.home });
  const file = path.join(f.home, "gateway", "threads", `${thread.id}.json`);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  stored.turns.push({ id: randomUUID(), status: "inProgress", items: [] });
  fs.writeFileSync(file, JSON.stringify(stored));
  await f.restart();
  const b = await f.connect(); const restored = (await b.request("thread/read", { threadId: thread.id })).thread;
  assert.equal(restored.turns[0].status, "failed");
  assert.match(restored.turns[0].error.message, /outcome is unknown/);
  assert.equal(calls, 0);
});

test("reasoning capabilities, live approval updates and next-turn settings survive execution saves and restart", async t => {
  const seen = []; let started, finish;
  const began = new Promise(resolve => { started = resolve; }), hold = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, async ({ reasoningEffort, getApprovalMode, onSession, onText }) => {
    seen.push([reasoningEffort, getApprovalMode()]);
    if (seen.length === 1) { started(); await hold; seen.push([reasoningEffort, getApprovalMode()]); }
    onSession("same-cli"); onText("done");
  }, { model: { id: "fixture", supportedReasoningEfforts: ["low", "medium", "high"] }, approvalModes: ["ask", "read-only", "auto", "deny"] });
  const a = await f.connect();
  const catalog = await a.request("model/list");
  assert.deepEqual(catalog.data[0].supportedReasoningEfforts.map(v => v.reasoningEffort), ["low", "medium", "high"]);
  const { thread } = await a.request("thread/start", { cwd: f.home, effort: "high" });
  assert.equal(thread.reasoningEffort, "high");
  await a.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "first" }] }); await began;
  await a.request("thread/settings/update", { threadId: thread.id, reasoningEffort: "low", cliApprovalMode: "auto" });
  finish(); await Promise.all([...f.server.protocol.active.values()].map(value => value.done));
  assert.deepEqual(seen, [["high", "ask"], ["high", "auto"]]);
  const saved = (await a.request("thread/read", { threadId: thread.id })).thread;
  assert.equal(saved.reasoningEffort, "low"); assert.equal(saved.cliApprovalMode, "auto");
  await assert.rejects(a.request("thread/settings/update", { threadId: thread.id, reasoningEffort: "max" }), /推理强度/);
  await assert.rejects(a.request("thread/settings/update", { threadId: thread.id, cliApprovalMode: "invented" }), /审批策略/);
  const restarted = await f.restart(); const b = await f.connect();
  const restored = (await b.request("thread/read", { threadId: thread.id })).thread;
  assert.equal(restored.reasoningEffort, "low"); assert.equal(restored.cliApprovalMode, "auto");
  await b.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "next" }] });
  await Promise.all([...restarted.protocol.active.values()].map(value => value.done)); assert.deepEqual(seen[2], ["low", "auto"]);
});

test("native history is turn-scoped, direction-aware and accepts exclusive item anchors", async t => {
  const f = await fixture(t, async ({ onText, onTool }) => {
    onTool({ phase: "start", id: "tool", name: "fixture", input: {} });
    onTool({ phase: "end", id: "tool", success: true, output: "fixture result" }); onText("answer");
  });
  const a = await f.connect(), { thread } = await a.request("thread/start", { cwd: f.home });
  const ids = [];
  for (const text of ["first", "second"]) {
    const { turn } = await a.request("turn/start", { threadId: thread.id, input: [{ type: "text", text }] }); ids.push(turn.id);
    await Promise.all([...f.server.protocol.active.values()].map(value => value.done));
  }
  const newest = await a.request("thread/turns/list", { threadId: thread.id, limit: 1, itemsView: "notLoaded" });
  assert.equal(newest.data[0].id, ids[1]); assert.deepEqual(newest.data[0].items, []);
  const oldest = await a.request("thread/turns/list", { threadId: thread.id, limit: 1, cursor: newest.nextCursor, itemsView: "full" });
  assert.equal(oldest.data[0].id, ids[0]); assert.equal(oldest.data[0].items.length, 3);
  const params = { threadId: thread.id, turnId: ids[0] };
  const items = await a.request("thread/items/list", params);
  assert.ok(items.data.every(entry => entry.turnId === ids[0])); assert.equal(items.data.length, 3);
  const anchor = { type: "item", itemId: items.data[1].item.id };
  assert.deepEqual((await a.request("thread/items/list", { ...params, cursor: anchor })).data.map(v => v.item.type), ["agentMessage"]);
  assert.deepEqual((await a.request("thread/items/list", { ...params, cursor: anchor, sortDirection: "desc" })).data.map(v => v.item.type), ["userMessage"]);
  const tail = await a.request("thread/items/list", { ...params, sortDirection: "desc", limit: 1 });
  assert.equal(tail.data[0].item.type, "agentMessage");
  assert.equal((await a.request("thread/items/list", { ...params, sortDirection: "desc", limit: 1, cursor: tail.nextCursor })).data[0].item.type, "dynamicToolCall");
  await assert.rejects(a.request("thread/items/list", { threadId: thread.id, cursor: anchor }), /anchor/);
  await assert.rejects(a.request("thread/items/list", { ...params, turnId: "missing" }), /Unknown CLI turn/);
});
