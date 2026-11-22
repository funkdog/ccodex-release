import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { squadFixture } from "./squad-flow-fixture.mjs";
import { attachSquadNative } from "./squad-native-fixture.mjs";
import { readLedger } from "../gateway/spine/squad-ledger.mjs";
import { runSquadCommand } from "../gateway/spine/squad-cli.mjs";
import { Readable } from "node:stream";

async function setup(t, run) {
  const f = await squadFixture(t, run), anchor = await f.createThread(), a = await f.createThread(), b = await f.createThread();
  const squad = await f.call("diy/squad/create", { anchorThreadId: anchor.id, label: "账本协作" });
  for (const [thread, shortName] of [[a, "开发"], [b, "评审"]]) await f.call("diy/squad/add", { squadId: squad.id, threadId: thread.id, shortName });
  const post = (author, next, extra = {}) => f.call("diy/squad/post", { squadId: squad.id, authorThreadId: author.id, requestId: randomUUID(), kind: "handoff", summary: "明确结论、归属文件与下一步请求", next, ...extra });
  const ledger = () => f.call("diy/squad/ledger", { squadId: squad.id });
  const settle = async id => { await f.gateway.protocol.active.get(id)?.done; };
  return { f, anchor, a, b, squad, post, ledger, settle };
}
test("post atomically appends ordered evidence, wakes once, rejects conflicting retries and survives gateway restart", async t => {
  const { f, anchor, a, squad, post, ledger, settle } = await setup(t);
  const requestId = randomUUID(), extra = { requestId, kind: "assign", files: ["gateway/spine/squad-service.mts"], verification: "isolated gateway; GUI unverified" };
  const first = await post(anchor, "@开发", extra); await settle(a.id);
  assert.equal(first.seq, 1); assert.equal(first.authorHandle, "supervisor"); assert(first.createdAt <= Date.now());
  assert.deepEqual(await post(anchor, "@开发", extra), first); assert.equal(f.prompts.length, 1);
  await assert.rejects(post(anchor, "@评审", extra), /conflicts/);
  const snapshot = await ledger(); assert.match(snapshot.markdown, /#1.*assign/); assert.match(snapshot.markdown, /来源会话/);
  assert.match(f.prompts[0].prompt, /mycodex.squad_post/); assert.match(f.prompts[0].prompt, /ISSUE.md/);
  assert.equal((await fs.stat(snapshot.issuePath)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(snapshot.issuePath, "utf8"), snapshot.markdown);
  await f.restart(); assert.equal((await ledger()).entries.length, 1); assert.equal(f.prompts.length, 1);
  await assert.rejects(post({ id: randomUUID() }, null), /Author/);
  await assert.rejects(post(anchor, "@unknown"), /Unknown/);
  await assert.rejects(post(anchor, "@开发", { kind: "note" }), /note/);
  await assert.rejects(post(anchor, null, { kind: "system_fallback", verdict: "approved" }), /kind/);
});
test("worker relay enforces three automatic hops, pauses durably and resumes only on human release", async t => {
  const { f, anchor, a, b, post, ledger, settle } = await setup(t);
  await post(anchor, "@开发"); await settle(a.id);
  for (const [author, next, target] of [[a, "@评审", b], [b, "@开发", a], [a, "@评审", b]]) { await post(author, next); await settle(target.id); }
  assert.equal(f.prompts.length, 4);
  await post(b, "@开发"); let state = await ledger(); assert.equal(state.autoHopsUsed, 3); assert.equal(state.hopPausedForHuman, true); assert.equal(f.prompts.length, 4);
  await f.restart(); assert.equal((await ledger()).hopPausedForHuman, true);
  await f.call("diy/squad/resume_hops", { squadId: state.squadId }); await settle(a.id);
  state = await ledger(); assert.equal(state.autoHopsUsed, 0); assert.equal(state.hopPausedForHuman, false); assert.equal(f.prompts.length, 5);
  await post(a, "@supervisor"); assert.equal(f.prompts.length, 5); assert.equal((await ledger()).ballInCourt, "supervisor");
});
test("busy worker queues without interruption and gateway drains it after the current turn", async t => {
  let release, began; const hold = new Promise(r => release = r), started = new Promise(r => began = r); let runs = 0;
  t.after(() => release());
  const { f, anchor, a, post, ledger, settle } = await setup(t, async context => { if (++runs === 1) { began(); await hold; } context.onText("done"); });
  await post(anchor, "@开发"); await started;
  await post(anchor, "@开发", { summary: "second queued task" }); assert.equal((await ledger()).deliveries[1].state, "queued");
  assert.equal(f.gateway.protocol.active.get(a.id).controller.signal.aborted, false);
  release(); await settle(a.id);
  await f.waitForPrompt(context => context.prompt.includes("second queued task")); await settle(a.id);
  assert.equal(f.prompts.length, 2); assert.equal((await ledger()).deliveries[1].state, "sent");
});
test("fallback copies the dispatched turn, never implies approval, and closing preserves discoverability and ledger", async t => {
  const { f, anchor, a, squad, post, ledger, settle } = await setup(t, async context => context.onText("实际末条回复：还缺真实 GUI 验证"));
  await post(anchor, "@开发"); await settle(a.id);
  assert.deepEqual((await f.call("diy/squad/list")).squads[0].missingReports, [a.id]);
  const requestId = randomUUID(), params = { squadId: squad.id, workerId: a.id, requestId };
  const entry = await f.call("diy/squad/fallback", params); assert.equal(entry.kind, "system_fallback"); assert.equal(entry.verdict, undefined); assert.match(entry.summary, /实际末条回复/);
  assert.deepEqual(await f.call("diy/squad/fallback", params), entry);
  const summary = await f.call("diy/squad/summarize", { squadId: squad.id, draftOnly: true }); assert.match(summary.text, /还缺真实 GUI/); assert.equal(summary.anchorThreadId, anchor.id);
  await f.call("diy/squad/promote_member", { squadId: squad.id, threadId: a.id });
  assert.equal((await f.call("diy/squad/list")).squads[0].members.find(m => m.threadId === a.id).sidebarHidden, false);
  await f.call("diy/squad/dissolve", { squadId: squad.id }); assert.equal((await f.call("diy/squad/list")).squads[0].status, "closed");
  assert.equal((await ledger()).entries.length, 2);
  for (const thread of f.gateway.protocol.store.all()) assert.equal(thread.archived, false);
  const listed = await f.call("thread/list", {}); assert(listed.data.some(t => t.id === a.id));
  const next = await f.call("diy/squad/create", { anchorThreadId: anchor.id, label: "下一阶段" }); assert.notEqual(next.id, squad.id);
});
test("roles validate unique handles and CLI post/ledger use the authenticated gateway writer", async t => {
  const { f, anchor, squad } = await setup(t);
  const role = { id: "review", handle: "评审", kind: "cli", model: "fixture/model", defaultPromptPrefix: "只读审查", reasoningEffort: "none" };
  await f.call("diy/squad/roles", { roles: [role] }); assert.equal((await f.call("diy/squad/roles", {})).roles[0].handle, "评审");
  await assert.rejects(f.call("diy/squad/roles", { roles: [role, { ...role, id: "other" }] }), /Duplicate/);
  const params = { squadId: squad.id, authorThreadId: anchor.id, requestId: randomUUID(), kind: "note", summary: "CLI evidence", next: null };
  const client = path.join(f.home, ".mycodex/squad-client.json");
  const entry = await runSquadCommand(client, "post", Readable.from([JSON.stringify(params)])); assert.equal(entry.seq, 1);
  const ledger = await runSquadCommand(client, "ledger", Readable.from([JSON.stringify({ squadId: squad.id })])); assert.match(ledger.markdown, /CLI evidence/);
});
test("native fallback reads only the exact dispatched terminal turn", async t => {
  const { f, anchor, squad, post, ledger } = await setup(t), native = await attachSquadNative(t, f);
  const worker = await native.create(), binding = (await f.call("diy/host/status")).bindings.find(b => b.squad);
  await f.call("diy/squad/add", { squadId: squad.id, threadId: worker.id, shortName: "原生", hostRef: { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: worker.id } });
  await post(anchor, "@原生"); const turnId = (await ledger()).deliveries.at(-1).turnId;
  native.turns.get(turnId).items.push({ type: "agentMessage", text: "对应原生回合的结论" });
  const result = await f.call("diy/squad/fallback", { squadId: squad.id, workerId: worker.id, requestId: randomUUID() }); assert.match(result.summary, /对应原生回合/);
});
test("linked ledger storage is rejected without overwriting the target", async t => {
  const { f, anchor, squad, post } = await setup(t);
  await post(anchor, null, { kind: "note" });
  const file = path.join(f.home, ".mycodex/squad-relay", squad.id, "ledger.json"), target = path.join(f.home, "external.json");
  await fs.writeFile(target, "keep"); await fs.unlink(file); await fs.symlink(target, file);
  assert.throws(() => readLedger(f.home, squad.id)); assert.equal(await fs.readFile(target, "utf8"), "keep");
});

test("ledger pagination stays within transport budget and reconstructs every immutable entry", async t => {
  const { f, anchor, squad, post } = await setup(t);
  const files = Array.from({ length: 25 }, (_, i) => `${i}/` + "file".repeat(125));
  for (let i = 0; i < 9; i++) await post(anchor, null, { kind: "note", summary: `entry ${i} ` + "结论".repeat(1500), verification: "验证范围".repeat(800), files });
  let offset = 0; const entries = [];
  do {
    const page = await f.call("diy/squad/ledger", { squadId: squad.id, offset });
    assert(Buffer.byteLength(JSON.stringify(page)) < 256 * 1024); entries.push(...page.entries); offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(entries.map(e => e.seq), Array.from({ length: 9 }, (_, i) => i + 1));
  const markdown = await fs.readFile(path.join(f.home, ".mycodex/squad-relay", squad.id, "ISSUE.md"), "utf8"); assert.match(markdown, /### #9/);
  const view = await f.call("diy/squad/list", { squadId: squad.id }); assert.equal(view.squads[0].ledger.totalEntries, 9); assert(Buffer.byteLength(JSON.stringify(view)) < 256 * 1024);
});

test("closed squads reject fresh legacy dispatches and native fallback resolves the same thread after reopen", async t => {
  const { f, anchor, a, squad, post, ledger } = await setup(t), native = await attachSquadNative(t, f, { accountId: "reopen-ledger" });
  const worker = await native.create(), binding = (await f.call("diy/host/status")).bindings.find(b => b.squad);
  await f.call("diy/squad/add", { squadId: squad.id, threadId: worker.id, shortName: "native", hostRef: { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: worker.id } });
  await post(anchor, "@native"); const turnId = (await ledger()).deliveries.at(-1).turnId;
  await native.close();
  const replacement = await attachSquadNative(t, f, { accountId: "reopen-ledger" }); replacement.threads.set(worker.id, worker); replacement.turns.set(turnId, { id: turnId, threadId: worker.id, status: "completed", items: [{ type: "agentMessage", text: "原回合重连结论" }] });
  const entry = await f.call("diy/squad/fallback", { squadId: squad.id, workerId: worker.id, requestId: randomUUID() }); assert.match(entry.summary, /原回合重连结论/);
  await f.call("diy/squad/dissolve", { squadId: squad.id });
  await assert.rejects(f.call("diy/squad/dispatch", { squadId: squad.id, workerId: a.id, squadGoal: "Closed", task: "Must not execute" }), /closed/);
});
