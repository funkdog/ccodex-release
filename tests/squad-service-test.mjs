import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { squadFixture } from "./squad-flow-fixture.mjs";
import { readBrief, writeResult } from "../gateway/spine/squad-relay.mjs";
import { loadSquads, saveSquads } from "../gateway/spine/squad-lite.mjs";


test("Squad Lite routes create, manually join, push brief, collect file results, summarize and clean up deleted threads", async t => {
  const f = await squadFixture(t), anchor = await f.createThread(), worker = await f.createThread();
  const before = f.gateway.protocol.store.get(anchor.id);
  const squad = await f.call("diy/squad/create", { anchorThreadId: anchor.id, label: "Relay squad" });
  assert.equal(f.gateway.protocol.store.all().length, 2, "Creation never forks a chat");
  assert.deepEqual(f.gateway.protocol.store.get(anchor.id), before, "Grouping never changes StoredThread");
  await f.call("diy/squad/add", { squadId: squad.id, threadId: worker.id, shortName: "worker-1" });
  const dispatched = await f.call("diy/squad/dispatch", { squadId: squad.id, workerId: worker.id, squadGoal: "Ship", task: "Verify result" });
  await f.gateway.protocol.active.get(worker.id)?.done;
  const brief = await readBrief(f.home, squad.id, worker.id);
  assert.equal(brief.task, "Verify result");
  assert.match(f.prompts[0].prompt, /\[Squad Goal\] Ship/);
  assert(f.prompts[0].prompt.includes(path.join(f.home, ".mycodex/squad-relay", squad.id, `${worker.id}.${brief.dispatchId}.result.json`)));
  const result = { squadId: squad.id, workerId: worker.id, dispatchId: brief.dispatchId, summary: "Verified", status: "completed", completedAt: Date.now() };
  await writeResult(f.home, result);
  const snapshot = await f.call("diy/squad/list");
  assert.equal(snapshot.squads[0].results[0].summary, "Verified");
  assert.equal(dispatched.brief.workerId, worker.id);
  await f.call("diy/squad/summarize", { squadId: squad.id });
  await f.gateway.protocol.active.get(anchor.id)?.done;
  assert(f.prompts[1].prompt.includes("Verified"));
  await f.call("thread/delete", { threadId: worker.id });
  assert.deepEqual((await loadSquads(f.home)).squads[squad.id].members.map(m => m.threadId), [anchor.id]);
  await assert.rejects(fs.stat(path.join(f.home, ".mycodex/squad-relay", squad.id, `${worker.id}.${brief.dispatchId}.result.json`)), { code: "ENOENT" });
  await f.call("thread/delete", { threadId: anchor.id });
  assert.deepEqual((await loadSquads(f.home)).squads, {});
  await assert.rejects(fs.stat(path.join(f.home, ".mycodex/squad-relay", squad.id)), { code: "ENOENT" });
});

test("concurrent mutations preserve both squads; busy workers reject dispatch without replacing briefs", async t => {
  let release, entered;
  const started = new Promise(resolve => entered = resolve), hold = new Promise(resolve => release = resolve);
  const f = await squadFixture(t, async () => { entered(); await hold; });
  t.after(() => release());
  const [a, b, worker] = await Promise.all([f.createThread(), f.createThread(), f.createThread()]);
  const [one, two] = await Promise.all([a, b].map(thread => f.call("diy/squad/create", { anchorThreadId: thread.id, label: thread.id })));
  assert.equal(Object.keys((await loadSquads(f.home)).squads).length, 2);
  await f.call("diy/squad/add", { squadId: one.id, threadId: worker.id, shortName: "worker" });
  await assert.rejects(f.call("diy/squad/add", { squadId: two.id, threadId: worker.id, shortName: "duplicate" }), /already/);
  await f.call("diy/squad/dispatch", { squadId: one.id, workerId: worker.id, squadGoal: "Goal", task: "first" });
  await started;
  await assert.rejects(f.call("diy/squad/dispatch", { squadId: one.id, workerId: worker.id, squadGoal: "Goal", task: "second" }), /active|busy/i);
  assert.equal((await readBrief(f.home, one.id, worker.id)).task, "first");
  release(); await f.gateway.protocol.active.get(worker.id)?.done;
  await writeResult(f.home, { squadId: one.id, workerId: worker.id, summary: "old result", status: "completed", completedAt: 1 });
  assert.equal((await f.call("diy/squad/list")).squads.find(s => s.id === one.id).results.length, 0, "A stale result cannot complete a newer brief");
  await f.call("diy/squad/dissolve", { squadId: one.id });
  assert.equal((await loadSquads(f.home)).squads[one.id].status, "closed");
  assert.match(await fs.readFile(path.join(f.home, ".mycodex/squad-relay", one.id, "ISSUE.md"), "utf8"), /closed/);
  assert.equal(f.gateway.protocol.store.all().length, 3, "Dissolving preserves all member chats");
  assert.equal((await loadSquads(f.home)).squads[two.id].id, two.id);
});

test("thread admission failure restores the prior brief; one malformed result does not hide other workers", async t => {
  const f = await squadFixture(t), anchor = await f.createThread(), a = await f.createThread(), b = await f.createThread();
  const squad = await f.call("diy/squad/create", { anchorThreadId: anchor.id, label: "Recovery" });
  for (const thread of [a, b]) await f.call("diy/squad/add", { squadId: squad.id, threadId: thread.id, shortName: thread.id });
  await f.call("diy/squad/dispatch", { squadId: squad.id, workerId: a.id, squadGoal: "Goal", task: "original" });
  await f.gateway.protocol.active.get(a.id)?.done;
  const previous = await readBrief(f.home, squad.id, a.id);
  const original = f.gateway.protocol.selectModel.bind(f.gateway.protocol);
  f.gateway.protocol.selectModel = async () => { throw new Error("catalog unavailable"); };
  await assert.rejects(f.call("diy/squad/dispatch", { squadId: squad.id, workerId: a.id, squadGoal: "Goal", task: "must roll back" }), /catalog unavailable/);
  assert.deepEqual(await readBrief(f.home, squad.id, a.id), previous);
  f.gateway.protocol.selectModel = original;
  await f.call("diy/squad/dispatch", { squadId: squad.id, workerId: b.id, squadGoal: "Goal", task: "other" });
  await f.gateway.protocol.active.get(b.id)?.done;
  await writeResult(f.home, { squadId: squad.id, workerId: b.id, dispatchId: (await readBrief(f.home, squad.id, b.id)).dispatchId, summary: "good worker", status: "failed", error: "verification failed", completedAt: Date.now() });
  await fs.writeFile(path.join(f.home, ".mycodex/squad-relay", squad.id, `${a.id}.${previous.dispatchId}.result.json`), "{partial");
  const view = (await f.call("diy/squad/list")).squads[0];
  assert.equal(view.results[0].workerId, b.id); assert(view.errors[a.id]);
  await f.call("diy/squad/summarize", { squadId: squad.id }); await f.gateway.protocol.active.get(anchor.id)?.done;
  assert(f.prompts.at(-1).prompt.includes("verification failed"));
  await f.call("diy/squad/remove", { squadId: squad.id, threadId: a.id });
  assert.equal((await f.call("diy/squad/list")).squads[0].members.length, 2);
  await assert.rejects(fs.stat(path.join(f.home, ".mycodex/squad-relay", squad.id, a.id + ".brief.json")), { code: "ENOENT" });
});

for (const action of ["dissolve", "delete-anchor", "remove-worker"]) test(`${action} cleans files written by a worker that finishes later without cancelling its chat`, async t => {
  let release, entered;
  const began = new Promise(resolve => entered = resolve), hold = new Promise(resolve => release = resolve);
  t.after(() => release());
  let output;
  const f = await squadFixture(t, async context => {
    entered(); await hold;
    await writeResult(f.home, { ...output, summary: "late worker", status: "completed", completedAt: Date.now() });
    context.onText("completed after group removal");
  });
  const anchor = await f.createThread(), worker = await f.createThread();
  const squad = await f.call("diy/squad/create", { anchorThreadId: anchor.id, label: "Late cleanup" });
  output = { squadId: squad.id, workerId: worker.id };
  await f.call("diy/squad/add", { squadId: squad.id, threadId: worker.id, shortName: "worker" });
  const sent = await f.call("diy/squad/dispatch", { ...output, squadGoal: "Goal", task: "Write after release" }); output.dispatchId = sent.brief.dispatchId; await began;
  if (action === "delete-anchor") await f.call("thread/delete", { threadId: anchor.id });
  else await f.call(`diy/squad/${action === "dissolve" ? "dissolve" : "remove"}`, { squadId: squad.id, ...(action === "remove-worker" ? { threadId: worker.id } : {}) });
  assert.equal(f.gateway.protocol.active.get(worker.id).controller.signal.aborted, false);
  release(); await f.gateway.protocol.active.get(worker.id)?.done;
  await Promise.all([...f.gateway.protocol.pendingMaintenance]);
  if (action === "dissolve") { assert.equal((await loadSquads(f.home)).squads[squad.id].status, "closed"); assert((await fs.stat(path.join(f.home, ".mycodex/squad-relay", squad.id, `${worker.id}.${sent.brief.dispatchId}.result.json`))).isFile()); }
  else await assert.rejects(fs.stat(path.join(f.home, ".mycodex/squad-relay", squad.id, `${worker.id}.${sent.brief.dispatchId}.result.json`)), { code: "ENOENT" });
  assert.equal(f.gateway.protocol.store.get(worker.id).turns.at(-1).status, "completed");
});

test("startup reconciles deletion tombstones after interrupted sidecar cleanup without inferring deletion from a missing recent page", async t => {
  const f = await squadFixture(t), anchor = await f.createThread(), worker = await f.createThread();
  const squad = await f.call("diy/squad/create", { anchorThreadId: anchor.id, label: "Restart cleanup" });
  await f.call("diy/squad/add", { squadId: squad.id, threadId: worker.id, shortName: "worker" });
  const stale = await loadSquads(f.home);
  await f.call("thread/delete", { threadId: worker.id });
  await saveSquads(f.home, stale); // Simulate a crash after the chat tombstone, before sidecar cleanup.
  await writeResult(f.home, { squadId: squad.id, workerId: worker.id, summary: "stale", status: "completed", completedAt: Date.now() });
  await f.restart();
  assert.deepEqual((await loadSquads(f.home)).squads[squad.id].members.map(m => m.threadId), [anchor.id]);
  await assert.rejects(fs.stat(path.join(f.home, ".mycodex/squad-relay", squad.id, worker.id + ".result.json")), { code: "ENOENT" });
  await f.call("thread/delete", { threadId: anchor.id });
  await saveSquads(f.home, stale);
  await writeResult(f.home, { squadId: squad.id, workerId: worker.id, summary: "stale", status: "completed", completedAt: Date.now() });
  await f.restart();
  assert.deepEqual((await loadSquads(f.home)).squads, {});
  await assert.rejects(fs.stat(path.join(f.home, ".mycodex/squad-relay", squad.id)), { code: "ENOENT" });
});

test("corrupt optional squad state never blocks chat deletion, notification or later cleanup retry", async t => {
  const f = await squadFixture(t), anchor = await f.createThread();
  await f.call("diy/squad/create", { anchorThreadId: anchor.id, label: "Optional cleanup failure" });
  const valid = await loadSquads(f.home), file = path.join(f.home, ".mycodex/squads.json");
  await fs.writeFile(file, "{broken");
  await f.call("thread/delete", { threadId: anchor.id });
  assert.throws(() => f.gateway.protocol.store.get(anchor.id), /deleted/);
  assert.equal(f.events.filter(e => e.method === "thread/deleted" && e.params.threadId === anchor.id).length, 1);
  assert.equal(await fs.readFile(file, "utf8"), "{broken", "Corrupt state is preserved for recovery");
  await saveSquads(f.home, valid);
  await f.call("thread/delete", { threadId: anchor.id });
  assert.deepEqual((await loadSquads(f.home)).squads, {});
  assert.equal(f.events.filter(e => e.method === "thread/deleted" && e.params.threadId === anchor.id).length, 1);
});

test('V2 registered Gateway aliases initialize, dispatch without relay tools, and preserve state across restart', async t => {
  const f = await squadFixture(t), anchor = await f.createThread();
  let snapshot = await f.call('diy/squad/create', { v2: true, anchorThreadId: anchor.id, title: 'V2', intent: 'Ship', state: { criteria: [{ id: 'C1', text: 'Green' }] } });
  const squadId = snapshot.squadId;
  snapshot = await f.call('diy/squad/dispatch', { v2: true, squadId, slots: [{ slotId: 'builder', model: 'fixture/model', task: 'Build', touches: [] }] });
  const workerId = snapshot.slots[0].threadId;
  await f.gateway.protocol.active.get(workerId)?.done;
  assert.match(f.prompts[0].prompt, /Role Brief: builder/);
  assert.doesNotMatch(f.prompts[0].prompt, /mycodex\.squad_|ISSUE\.md/);
  snapshot = await f.call('diy/squad/list', { v2: true, squadId });
  assert.equal(snapshot.slots[0].activity, 'quiescent');
  assert.equal(snapshot.slots[0].result.autoSynthesized, true);
  await f.restart();
  snapshot = await f.call('diy/squad/list', { v2: true, squadId });
  assert.equal(snapshot.slots[0].threadId, workerId);
  assert.equal(snapshot.state.intent, 'Ship');
  const closed = await f.call('diy/squad/dissolve', { v2: true, squadId, promoteSlots: ['builder'] });
  assert.equal(closed.status, 'closed'); assert.equal(closed.slots[0].sidebarHidden, false);
  assert(f.gateway.protocol.store.get(workerId), 'close preserves the real chat');
});

test('V2 native dispatch retains exact turn failures and last output in physical snapshots', async t => {
  const { attachSquadNative } = await import('./squad-native-fixture.mjs');
  const f = await squadFixture(t), native = await attachSquadNative(t, f, { holdTurns: true });
  const anchor = await native.create(), binding = (await f.call('diy/host/status')).bindings.find(b => b.squad);
  const anchorHostRef = { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: anchor.id };
  const initial = await f.call('diy/squad/create', { v2: true, anchorThreadId: anchor.id, anchorHostRef, intent: 'Native V2' });
  const squadId = initial.squadId;
  const dispatched = await f.call('diy/squad/dispatch', { v2: true, squadId, slots: [{ slotId: 'native-builder', engine: 'native', model: 'native-model', task: 'Build', touches: [] }] });
  assert.equal(dispatched.slots[0].activity, 'active');
  const threadId = dispatched.slots[0].threadId, turn = [...native.turns.values()].find(t => t.threadId === threadId);
  turn.status = 'failed'; turn.error = { message: 'Native failure retained' }; native.threads.get(threadId).status = { type: 'idle' };
  const status = await f.call('diy/squad/list', { v2: true, squadId });
  assert.equal(status.slots[0].activity, 'failed');
  assert.equal(status.slots[0].lastOutputSnippet, 'Native failure retained');
  assert.equal(status.needsYou[0].kind, 'slot_failed');
});
