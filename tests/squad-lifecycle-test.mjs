import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { squadFixture } from "./squad-flow-fixture.mjs";
import { attachSquadNative } from "./squad-native-fixture.mjs";
import { readBrief, writeBrief, writeResult } from "../gateway/spine/squad-relay.mjs";

const exists = file => fs.stat(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
async function until(read, predicate) {
  const deadline = Date.now() + 6000;
  do { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < deadline);
  throw new Error("Squad lifecycle cleanup did not settle.");
}
async function nativeSquad(t, { holdTurns = false } = {}) {
  const f = await squadFixture(t), native = await attachSquadNative(t, f, { holdTurns }), anchor = await native.create();
  const binding = (await f.call("diy/host/status")).bindings.find(b => b.squad);
  const anchorHostRef = { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: anchor.id };
  const squad = await f.call("diy/squad/create", { anchorThreadId: anchor.id, anchorHostRef, label: "Lifecycle" });
  return { f, native, anchor, anchorHostRef, squad };
}

test("normal native reopen reconnects the same account and thread without replaying prior work", async t => {
  const { f, native, anchor, squad } = await nativeSquad(t);
  await native.close();
  const replacement = await attachSquadNative(t, f); replacement.threads.set(anchor.id, anchor);
  const worker = await f.call("diy/squad/create_member", { squadId: squad.id, shortName: "After reopen", kind: "cli", model: "fixture/model", requestId: randomUUID() });
  assert.equal(f.gateway.protocol.store.get(worker.threadId).engineId, "fixture");
  assert.equal(replacement.prompts.length, 0);
  assert.equal((await f.call("diy/squad/list")).threads.some(thread => thread.id === anchor.id && thread.status.type === "offline"), false);
});

test("native reconnect never crosses an account boundary or accepts a different returned thread", async t => {
  const { f, native, anchor, squad } = await nativeSquad(t); await native.close();
  const other = await attachSquadNative(t, f, { accountId: "another-account" }); other.threads.set(anchor.id, anchor);
  await assert.rejects(f.call("diy/squad/create_member", { squadId: squad.id, shortName: "Wrong account", kind: "cli", model: "fixture/model", requestId: randomUUID() }), /unavailable|account|binding/i);
  assert.equal(f.gateway.protocol.store.all().length, 0);
  await other.close();
  const mismatched = await attachSquadNative(t, f); mismatched.threads.set(anchor.id, { ...anchor, id: randomUUID() });
  await assert.rejects(f.call("diy/squad/create_member", { squadId: squad.id, shortName: "Wrong thread", kind: "cli", model: "fixture/model", requestId: randomUUID() }), /unavailable|identity|binding/i);
  assert.equal(f.gateway.protocol.store.all().length, 0);
});

test("an accepted native action stays deduplicated across a normal runtime replacement", async t => {
  const { f, native, anchor, anchorHostRef, squad } = await nativeSquad(t), worker = await native.create();
  await f.call("diy/squad/add", { squadId: squad.id, threadId: worker.id, shortName: "worker", hostRef: { ...anchorHostRef, threadId: worker.id } });
  const params = { squadId: squad.id, workerId: worker.id, squadGoal: "Goal", task: "Once only", requestId: randomUUID() };
  const first = await f.call("diy/squad/dispatch", params);
  await native.close(); const replacement = await attachSquadNative(t, f);
  replacement.threads.set(anchor.id, anchor); replacement.threads.set(worker.id, worker);
  assert.deepEqual(await f.call("diy/squad/dispatch", params), first);
  assert.equal(replacement.prompts.length, 0);
  const current = await f.call("diy/squad/dispatch", { ...params, task: "New explicit action", requestId: randomUUID() });
  assert.equal(replacement.prompts.length, 1);
  assert.notEqual(current.brief.execution.ref.runtimeId, anchorHostRef.runtimeId);
});

test("unknown acceptance never moves receipt recovery onto a replacement native runtime", async t => {
  const { f, native, anchor, anchorHostRef, squad } = await nativeSquad(t), worker = await native.create();
  await f.call("diy/squad/add", { squadId: squad.id, threadId: worker.id, shortName: "worker", hostRef: { ...anchorHostRef, threadId: worker.id } });
  const original = f.gateway.protocol.store.all().length;
  const requestId = randomUUID(), params = { squadId: squad.id, workerId: worker.id, squadGoal: "Goal", task: "Uncertain", requestId };
  await f.call("diy/squad/dispatch", params);
  const file = path.join(f.home, ".mycodex/squad-actions", requestId + ".json");
  const receipt = JSON.parse(await fs.readFile(file, "utf8")); receipt.state = "unknown"; delete receipt.result; await fs.writeFile(file, JSON.stringify(receipt));
  await native.close(); const replacement = await attachSquadNative(t, f);
  replacement.threads.set(anchor.id, anchor); replacement.threads.set(worker.id, worker);
  await assert.rejects(f.call("diy/squad/dispatch", params), /unknown outcome/);
  await assert.rejects(f.call("diy/squad/dispatch", { ...params, requestId: randomUUID() }), /must be reconciled/);
  assert.equal(replacement.prompts.length, 0);
  assert.equal(f.gateway.protocol.store.all().length, original);
});

test("late task A reports and files cannot complete or overwrite task B", async t => {
  const f = await squadFixture(t), anchor = await f.createThread(), worker = await f.createThread();
  const squad = await f.call("diy/squad/create", { anchorThreadId: anchor.id, label: "Generations" });
  await f.call("diy/squad/add", { squadId: squad.id, threadId: worker.id, shortName: "worker" });
  const send = async task => {
    const sent = await f.call("diy/squad/dispatch", { squadId: squad.id, workerId: worker.id, squadGoal: "Goal", task, requestId: randomUUID() });
    await f.gateway.protocol.active.get(worker.id)?.done; return sent.brief;
  };
  const a = await send("A"), b = await send("B");
  assert.notEqual(a.dispatchId, b.dispatchId);
  const result = { squadId: squad.id, workerId: worker.id, summary: "A completed late", status: "completed", completedAt: b.issuedAt + 1 };
  await assert.rejects(f.call("diy/squad/report", { ...result, dispatchId: a.dispatchId }), /dispatch|older|current/i);
  await assert.rejects(f.call("diy/squad/report", result), /dispatch/i);
  await f.call("diy/squad/report", { ...result, dispatchId: b.dispatchId, summary: "B result" });
  await writeResult(f.home, { ...result, dispatchId: a.dispatchId });
  const view = (await f.call("diy/squad/list")).squads[0];
  assert.deepEqual(view.results.map(r => [r.dispatchId, r.summary]), [[b.dispatchId, "B result"]]);
});

test("legacy file results remain readable until a new dispatch explicitly replaces their brief", async t => {
  const f = await squadFixture(t), anchor = await f.createThread(), worker = await f.createThread();
  const squad = await f.call("diy/squad/create", { anchorThreadId: anchor.id, label: "Legacy compatibility" });
  await f.call("diy/squad/add", { squadId: squad.id, threadId: worker.id, shortName: "worker" });
  await writeBrief(f.home, { squadId: squad.id, workerId: worker.id, squadGoal: "Legacy", task: "Old task", issuedAt: 1 });
  await writeResult(f.home, { squadId: squad.id, workerId: worker.id, summary: "Old result", status: "completed", completedAt: 2 });
  assert.equal((await f.call("diy/squad/list")).squads[0].results[0].summary, "Old result");
  await f.call("diy/squad/dispatch", { squadId: squad.id, workerId: worker.id, squadGoal: "New", task: "New task" });
  await f.gateway.protocol.active.get(worker.id)?.done;
  assert.deepEqual((await f.call("diy/squad/list")).squads[0].results, []);
});

for (const action of ["dissolve", "delete-anchor", "remove-worker"]) test(`native ${action} cleans late files after the original turn ends, including gateway restart`, async t => {
  const { f, native, anchor, anchorHostRef, squad } = await nativeSquad(t, { holdTurns: true });
  const worker = await native.create();
  await f.call("diy/squad/add", { squadId: squad.id, threadId: worker.id, shortName: "native-worker", hostRef: { ...anchorHostRef, threadId: worker.id } });
  const sent = await f.call("diy/squad/dispatch", { squadId: squad.id, workerId: worker.id, squadGoal: "Goal", task: "Write after removal", requestId: randomUUID() });
  if (action === "delete-anchor") await native.remove(anchor.id);
  else await f.call(`diy/squad/${action === "dissolve" ? "dissolve" : "remove"}`, { squadId: squad.id, ...(action === "remove-worker" ? { threadId: worker.id } : {}) });
  assert.equal(native.turns.get(sent.accepted.turnId).status, "inProgress");
  if (action === "dissolve") await f.restart();
  await writeResult(f.home, { squadId: squad.id, workerId: worker.id, dispatchId: sent.brief.dispatchId, summary: "Late native result", status: "completed", completedAt: Date.now() });
  const directory = path.join(f.home, ".mycodex/squad-relay", squad.id);
  native.finish(sent.accepted.turnId);
  if (action === "dissolve") {
    assert.equal((await f.call("diy/squad/list")).squads[0].status, "closed");
    assert.equal(await exists(path.join(directory, "ledger.json")), true);
    assert.equal(await exists(path.join(directory, `${worker.id}.${sent.brief.dispatchId}.result.json`)), true);
    return;
  }
  await until(() => fs.readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; }), files => !files.some(file => file.endsWith(".result.json")));
  assert.equal(native.turns.get(sent.accepted.turnId).status, "completed");
  assert.equal((await readBrief(f.home, squad.id, worker.id)), null);
  if (action !== "remove-worker") {
    await until(() => exists(directory), present => !present);
    assert.equal(await exists(directory), false);
  }
});

test("retiring an old native turn cannot erase a rejoined worker's new dispatch files", async t => {
  const { f, native, anchorHostRef, squad } = await nativeSquad(t, { holdTurns: true }), worker = await native.create();
  const join = () => f.call("diy/squad/add", { squadId: squad.id, threadId: worker.id, shortName: "worker", hostRef: { ...anchorHostRef, threadId: worker.id } });
  const send = task => f.call("diy/squad/dispatch", { squadId: squad.id, workerId: worker.id, squadGoal: "Goal", task, requestId: randomUUID() });
  await join(); const a = await send("A");
  await f.call("diy/squad/remove", { squadId: squad.id, threadId: worker.id });
  native.finish(a.accepted.turnId); await join(); const b = await send("B");
  for (const sent of [a, b]) await writeResult(f.home, { squadId: squad.id, workerId: worker.id, dispatchId: sent.brief.dispatchId, summary: sent.brief.task, status: "completed", completedAt: Date.now() });
  const prefix = path.join(f.home, ".mycodex/squad-relay", squad.id, worker.id);
  await until(() => exists(`${prefix}.${a.brief.dispatchId}.result.json`), present => !present);
  assert.equal(await exists(`${prefix}.${b.brief.dispatchId}.result.json`), true);
  assert.equal((await readBrief(f.home, squad.id, worker.id)).dispatchId, b.brief.dispatchId);
  assert.equal(native.turns.get(b.accepted.turnId).status, "inProgress");
  native.finish(b.accepted.turnId);
});

test("deleting a previously removed native worker also retires orphaned cleanup records", async t => {
  const { f, native, anchorHostRef, squad } = await nativeSquad(t, { holdTurns: true }), worker = await native.create();
  await f.call("diy/squad/add", { squadId: squad.id, threadId: worker.id, shortName: "worker", hostRef: { ...anchorHostRef, threadId: worker.id } });
  const sent = await f.call("diy/squad/dispatch", { squadId: squad.id, workerId: worker.id, squadGoal: "Goal", task: "Write before deletion", requestId: randomUUID() });
  await f.call("diy/squad/remove", { squadId: squad.id, threadId: worker.id });
  await writeResult(f.home, { squadId: squad.id, workerId: worker.id, dispatchId: sent.brief.dispatchId, summary: "Late file", status: "completed", completedAt: Date.now() });
  await native.remove(worker.id);
  const directory = path.join(f.home, ".mycodex/squad-relay", squad.id);
  assert.equal(await exists(path.join(directory, "ledger.json")), true, "append-only history survives member removal");
  assert.equal((await fs.readdir(directory)).some(name => name.endsWith(".result.json")), false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.home, ".mycodex/squad-cleanups.json"), "utf8")), []);
});

// Squad V2 uses physical observations rather than worker-authored relay calls.
async function v2Fixture(t, onSend = async () => {}, runtimeOptions = {}) {
  const { SquadV2Kernel } = await import('../gateway/spine/squad-v2-kernel.mjs');
  const os = await import('node:os');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'squad-v2-'));
  const threads = new Map([['anchor', { id: 'anchor', cwd: root, status: { type: 'active' } }]]), sent = [];
  let count = 0;
  const kernel = new SquadV2Kernel(root, {
    read: async id => { const thread = threads.get(id); if (!thread) throw new Error('offline'); return thread; },
    create: async (_slot, cwd) => { const thread = { id: `worker-${++count}`, cwd, status: { type: 'idle' } }; threads.set(thread.id, thread); return thread; },
    send: async (thread, text, requestId) => { sent.push({ id: thread.id, text, requestId }); await onSend({ root, thread, text, requestId }); thread.status = { type: 'active' }; },
    ...runtimeOptions,
  }, () => {});
  t.after(async () => { await kernel.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  const initial = await kernel.init({ anchorThreadId: 'anchor', intent: 'Build secret rationale', state: { contracts: ['public-contract'], criteria: [{ id: 'C1', text: 'Evidence passes' }] } });
  return { kernel, root, threads, sent, initial, squadId: initial.squadId };
}

test('V2 optimistic state serialization and Studio Gate share the same revision', async t => {
  const f = await v2Fixture(t), { squadId } = f;
  const writes = await Promise.allSettled([1, 2].map(i => f.kernel.state({ squadId, expectedRevision: 1, patch: { intent: `intent-${i}` } })));
  assert.equal(writes.filter(x => x.status === 'fulfilled').length, 1);
  assert.match(writes.find(x => x.status === 'rejected').reason.message, /Revision conflict/);
  const state = await f.kernel.state({ squadId, expectedRevision: 2, patch: { activeGate: { id: 'G1', kind: 'blueprint', title: 'Approve', question: 'Run?', status: 'open', openedAt: 0, stateRevision: 0 } } });
  assert.equal(state.needsYou[0].kind, 'gate');
  await assert.rejects(f.kernel.dispatch({ squadId, slots: [{ slotId: 'builder', task: 'go', touches: [] }] }), /Gate/);
  const url = new URL(state.studioUrl); url.pathname += '/gate';
  const response = await fetch(url, { method: 'POST', body: JSON.stringify({ expectedRevision: 3, resolveGate: { id: 'G1', status: 'approved', resolutionText: 'Approved in Studio' } }) });
  assert.equal(response.status, 200); const resolved = await response.json();
  assert.equal(resolved.state.revision, 4); assert.equal(resolved.state.activeGate.status, 'approved');
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify({ expectedRevision: 3, resolveGate: { id: 'G1', status: 'approved', resolutionText: 'late' } }) })).status, 409);
  const markdown = await fs.readFile(path.join(f.root, '.mycodex', 'squads-v2', squadId, 'STATE.md'), 'utf8');
  assert.match(markdown, /rev.4/); assert.match(markdown, /Approved in Studio/);
  const unauthorized = new URL(state.studioUrl); unauthorized.search = '';
  assert.equal((await fetch(unauthorized)).status, 403);
});

test('V2 clean projection, fresh sessions, stateful reuse, and physical edge notices', async t => {
  const f = await v2Fixture(t), { squadId } = f;
  const builder = { slotId: 'builder', task: 'implementation-secret', touches: ['src/'], continuity: 'stateful' };
  const clean = { slotId: 'verifier', task: 'implementation-secret', touches: [], continuity: 'clean', artifacts: ['diff:abc'] };
  let snapshot = await f.kernel.dispatch({ squadId, slots: [builder, clean] });
  const first = snapshot.slots.find(s => s.slotId === 'verifier');
  assert.match(first.briefMarkdown, /diff:abc/); assert.match(first.briefMarkdown, /Evidence passes/);
  assert.doesNotMatch(first.briefMarkdown, /implementation-secret|Build secret rationale|public-contract|squad_/);
  assert.match(snapshot.slots[0].briefMarkdown, /implementation-secret/);
  const brief = snapshot.slots[0].briefMarkdown;
  assert.match(brief, /## Objective \/ What & Why/);
  assert.match(brief, /## Shared Purpose/);
  assert.match(brief, /## Execution Ownership\nMain defines the outcome, criteria and boundaries; you choose How/);
  assert.match(brief, /## Write Boundary \/ Touches\n- src\//);
  assert.doesNotMatch(brief, /## Partition Task|## Goal/);
  assert.doesNotMatch(first.briefMarkdown, /## Objective|## Shared Purpose|## Shared Contracts|## Execution Ownership/);

  for (const thread of f.threads.values()) thread.status = { type: 'idle' };
  f.threads.get(snapshot.slots[0].threadId).activeSubagents = true;
  await f.kernel.tick();
  let events = (await f.kernel.status({ squadId })).events;
  assert.equal(events.filter(e => e.kind === 'quiescent').length, 1, 'active internal agents prevent a terminal edge');
  assert.equal(f.sent.filter(s => s.id === 'anchor').length, 1);
  f.threads.get('anchor').status = { type: 'idle' };
  f.threads.get(snapshot.slots[0].threadId).activeSubagents = false;
  await f.kernel.tick();
  events = (await f.kernel.status({ squadId })).events;
  assert.equal(events.filter(e => e.kind === 'quiescent').length, 2);
  const builderId = snapshot.slots[0].threadId;
  f.threads.get('anchor').status = { type: 'active' };
  snapshot = await f.kernel.dispatch({ squadId, slots: [builder, clean] });
  assert.equal(snapshot.slots[0].threadId, builderId); assert.notEqual(snapshot.slots[1].threadId, first.threadId);
  for (const s of snapshot.slots) f.threads.get(s.threadId).status = { type: 'idle' };
  await f.kernel.tick();
  const before = f.sent.filter(s => s.id === 'anchor').length;
  await f.kernel.tick(); assert.equal(f.sent.filter(s => s.id === 'anchor').length, before, 'busy main is never interrupted');
  f.threads.get('anchor').status = { type: 'idle' }; await f.kernel.tick();
  assert.equal(f.sent.filter(s => s.id === 'anchor').length, before + 1, 'notices coalesce until idle');
  f.threads.get(builderId).status = { type: 'active' }; await f.kernel.tick();
  f.threads.get(builderId).status = { type: 'idle' }; await f.kernel.tick();
  assert((await f.kernel.status({ squadId })).events.some(e => e.kind === 'human_stepped_in'));
});

test('V2 parses structured/lenient receipts and synthesizes honest physical results when missing', async t => {
  const { parseResult } = await import('../gateway/spine/squad-v2-state.mjs');
  assert.throws(() => parseResult('summary: Missing status line', 1), /status/);
  assert.deepEqual(parseResult('status: done\nsummary: OK', 1).assumptions, []);
  const f = await v2Fixture(t), { squadId } = f;
  const snapshot = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'builder', task: 'go', touches: [] }] });
  const resultPath = path.join(f.root, '.mycodex', 'squads-v2', squadId, 'slots', 'builder', '.mycodex', 'result.md');
  await fs.writeFile(resultPath, 'status: escalate\nsummary: Contract needs review\n## Changes & Verification\nTested\n## Assumptions & Trade-offs\n- Compatibility assumption\n');
  f.threads.get(snapshot.slots[0].threadId).status = { type: 'idle' };
  const status = await f.kernel.status({ squadId });
  assert.equal(status.slots[0].result.status, 'escalate');
  assert.deepEqual(status.slots[0].result.assumptions, ['- Compatibility assumption']);
  assert.equal(status.needsYou[0].kind, 'slot_escalated');
  await fs.rm(resultPath);
  assert.equal((await f.kernel.status({ squadId })).slots[0].result.autoSynthesized, true);
});

test('V2 real worktrees isolate roles, measure boundary violations and integrate accepted clean commits', async t => {
  const f = await v2Fixture(t), { git, workspaceDelta } = await import('../gateway/spine/squad-v2-workspace.mjs');
  await git(f.root, 'init', '-b', 'main');
  await git(f.root, 'config', 'user.email', 'squad-test@example.invalid');
  await git(f.root, 'config', 'user.name', 'Squad Test');
  await fs.writeFile(path.join(f.root, '.gitignore'), '.mycodex/\nnode_modules\n');
  await fs.writeFile(path.join(f.root, 'owned.txt'), 'base\n');
  await fs.mkdir(path.join(f.root, 'node_modules'));
  await git(f.root, 'add', '.gitignore', 'owned.txt'); await git(f.root, 'commit', '-m', 'base');
  const { squadId } = f;
  let status = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'builder', task: 'Change owned', workspace: 'worktree', touches: ['owned.txt'] }] });
  const slot = status.slots[0], role = slot.worktreePath;
  assert.match(status.integrationBranch, /^squad\//); assert.match(slot.branch, /^role\//);
  assert.equal(await fs.realpath(path.join(role, 'node_modules')), await fs.realpath(path.join(f.root, 'node_modules')));
  assert.equal(await git(role, 'status', '--porcelain'), '');
  await fs.writeFile(path.join(role, 'owned.txt'), 'base\nadded\n');
  await fs.writeFile(path.join(role, 'outside.txt'), 'outside\n');
  const delta = await workspaceDelta(role, slot.baseSha, slot.touches);
  assert.deepEqual(delta.outsideTouches, ['outside.txt']); assert.equal(delta.changed.find(c => c.path === 'owned.txt').add, 1);
  await git(role, 'add', 'owned.txt', 'outside.txt'); await git(role, 'commit', '-m', 'unsafe change');
  f.threads.get(slot.threadId).status = { type: 'idle' };
  await f.kernel.state({ squadId, expectedRevision: 1, patch: { tasks: [{ slotId: 'builder', goal: 'Change owned', status: 'done', touches: ['owned.txt'], dependsOn: [] }] } });
  await assert.rejects(f.kernel.integrate({ squadId, slotId: 'builder', expectedRevision: 2 }), /Outside touches/);
  await git(role, 'rm', 'outside.txt'); await git(role, 'commit', '-m', 'restore boundary');
  await fs.writeFile(path.join(status.integrationWorktree, 'owned.txt'), 'dirty\n');
  await assert.rejects(f.kernel.integrate({ squadId, slotId: 'builder', expectedRevision: 2 }), /clean worktrees/);
  await git(status.integrationWorktree, 'restore', 'owned.txt');
  const merged = await f.kernel.integrate({ squadId, slotId: 'builder', expectedRevision: 2 });
  assert.equal(merged.delta.commits.length, 2);
  assert.equal(await fs.readFile(path.join(status.integrationWorktree, 'owned.txt'), 'utf8'), 'base\nadded\n');
  assert.equal(await fs.readFile(path.join(f.root, 'owned.txt'), 'utf8'), 'base\n', 'source checkout remains unchanged');
});

test('V2 waiting flags override active parent status and failed turns never imply acceptance', async t => {
  const f = await v2Fixture(t), { squadId } = f;
  const snapshot = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'builder', task: 'Build', touches: [] }] });
  const thread = f.threads.get(snapshot.slots[0].threadId);
  thread.status = { type: 'active', activeFlags: ['waitingOnApproval'] };
  let status = await f.kernel.status({ squadId });
  assert.equal(status.slots[0].activity, 'waiting'); assert.equal(status.needsYou[0].kind, 'slot_waiting');
  thread.status = { type: 'idle' }; thread.turnStatus = 'failed';
  status = await f.kernel.status({ squadId });
  assert.equal(status.slots[0].activity, 'failed'); assert.equal(status.state.tasks.find(t => t.slotId === 'builder').status, 'blocked');
  assert.equal(status.slots[0].stage, 'failed');
});

test('Studio HTTP serves HTML for browser Accept, file diffs for worktrees, and stateful promotion only', async t => {
  const f = await v2Fixture(t), { git } = await import('../gateway/spine/squad-v2-workspace.mjs'), { squadId } = f;
  await git(f.root, 'init', '-b', 'main');
  await git(f.root, 'config', 'user.email', 'squad-test@example.invalid');
  await git(f.root, 'config', 'user.name', 'Squad Test');
  await fs.writeFile(path.join(f.root, '.gitignore'), '.mycodex/\nnode_modules\n');
  await fs.writeFile(path.join(f.root, 'owned.txt'), 'base\n');
  await git(f.root, 'add', '.gitignore', 'owned.txt'); await git(f.root, 'commit', '-m', 'base');
  const dispatched = await f.kernel.dispatch({ squadId, slots: [
    { slotId: 'coder', continuity: 'stateful', workspace: 'worktree', task: 'Edit owned', touches: ['owned.txt'] },
    { slotId: 'verifier', continuity: 'clean', workspace: 'shared', task: 'Verify', touches: [] },
  ] });
  const coder = dispatched.slots.find(s => s.slotId === 'coder');
  await fs.writeFile(path.join(coder.worktreePath, 'owned.txt'), 'base\nstudio-diff\n');
  const url = new URL(dispatched.studioUrl);
  const htmlRes = await fetch(url, { headers: { Accept: 'text/html,application/xhtml+xml' } });
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await htmlRes.text(), /squad-studio-root/);
  const snapUrl = new URL(url); snapUrl.pathname += '/snapshot';
  assert.equal((await (await fetch(snapUrl)).json()).squadId, squadId);
  const diffUrl = new URL(url); diffUrl.pathname += '/diff'; diffUrl.searchParams.set('slotId', 'coder'); diffUrl.searchParams.set('path', 'owned.txt');
  const diffPayload = await (await fetch(diffUrl)).json();
  assert.match(diffPayload.diff, /\+studio-diff/);
  const promoteUrl = new URL(url); promoteUrl.pathname += '/promote';
  const denied = await fetch(promoteUrl, { method: 'POST', body: JSON.stringify({ slotId: 'verifier' }) });
  assert.equal(denied.status, 409);
  const promoted = await (await fetch(promoteUrl, { method: 'POST', body: JSON.stringify({ slotId: 'coder' }) })).json();
  assert.equal(promoted.slots.find(s => s.slotId === 'coder').sidebarHidden, false);
});


async function v2DiskImage(root) {
  const entries = [];
  const walk = async directory => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), relative = path.relative(root, file);
      entries.push([relative, entry.isDirectory() ? "directory" : (await fs.readFile(file)).toString("base64")]);
      if (entry.isDirectory()) await walk(file);
    }
  };
  await walk(root);
  return entries.sort((a, b) => a[0].localeCompare(b[0]));
}

const v2Gate = () => ({ id: "G-atomic", kind: "blueprint", title: "Approve contract", question: "Dispatch?", status: "open", openedAt: 0, stateRevision: 0 });
const v2Approval = () => ({ id: "G-atomic", status: "approved", resolutionText: "Approved" });

test("V2 atomic dispatch commits one STATE revision and resolves Gate before sending the updated contract", async t => {
  const observed = [];
  const f = await v2Fixture(t, async ({ root }) => {
    const directory = path.join(root, ".mycodex", "squads-v2");
    const [id] = await fs.readdir(directory);
    const stored = JSON.parse(await fs.readFile(path.join(directory, id, "state.json"), "utf8"));
    observed.push([stored.state.revision, stored.state.activeGate.status]);
  }), { squadId } = f;
  await f.kernel.state({ squadId, expectedRevision: 1, patch: { activeGate: v2Gate() } });
  const patch = { intent: "New shared purpose", invariants: ["Only owned source"], contracts: ["Stable API"], criteria: [{ id: "C-new", text: "New evidence passes" }], tasks: [{ slotId: "dependency", goal: "Ready", status: "done", touches: [], dependsOn: [] }] };
  const writes = await Promise.allSettled(["first", "second"].map(slotId => f.kernel.dispatch({ squadId, expectedRevision: 2, patch, resolveGate: v2Approval(), slots: [{ slotId, task: "Outcome, evidence and boundaries", touches: ["owned.mts"], dependsOn: ["dependency"] }] })));
  assert.equal(writes.filter(x => x.status === "fulfilled").length, 1);
  assert.match(writes.find(x => x.status === "rejected").reason.message, /Revision conflict/);
  const result = writes.find(x => x.status === "fulfilled").value;
  assert.equal(result.state.revision, 3);
  assert.equal(result.state.activeGate.status, "approved");
  assert.equal(result.slots.length, 1);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(observed, [[3, "approved"]], "new STATE is durable before crossing the send boundary");
  for (const text of ["New shared purpose", "New evidence passes", "Only owned source", "Stable API", "Outcome, evidence and boundaries", "owned.mts"]) assert.ok(f.sent[0].text.includes(text), text);
  assert.match(f.sent[0].text, /you choose How/);
  const stored = JSON.parse(await fs.readFile(path.join(f.root, ".mycodex", "squads-v2", squadId, "state.json"), "utf8"));
  assert.equal(stored.state.revision, 3);
  const events = result.events;
  assert.deepEqual(events.slice(-2).map(e => e.kind), ["gate_resolved", "dispatched"]);
  f.threads.get(result.slots[0].threadId).status = { type: "idle" };
  const unchanged = await f.kernel.dispatch({ squadId, expectedRevision: 3, slots: [{ slotId: "first", task: "Next", touches: [] }] });
  assert.equal(unchanged.state.revision, 3, "revision-only check must not invent a STATE update");
});

test("V2 atomic dispatch rejects stale/invalid STATE and unresolved Gates without files, events, threads or sends", async t => {
  const f = await v2Fixture(t), { squadId } = f;
  await f.kernel.state({ squadId, expectedRevision: 1, patch: { activeGate: v2Gate() } });
  const disk = await v2DiskImage(f.root), threadCount = f.threads.size;
  for (const [update, error] of [
    [{ patch: { title: "missing revision" } }, /Revision conflict/],
    [{ expectedRevision: 1, patch: { title: "stale" }, resolveGate: v2Approval() }, /Revision conflict/],
    [{ expectedRevision: 2, patch: { criteria: [{ id: "bad" }] }, resolveGate: v2Approval() }, /Invalid Squad/],
    [{ expectedRevision: 2, patch: { schemaVersion: 9 }, resolveGate: v2Approval() }, /Invalid state patch/],
    [{ expectedRevision: 2, patch: null }, /Invalid state patch/],
    [{ expectedRevision: 2, patch: [] }, /Invalid state patch/],
    [{ expectedRevision: 2, resolveGate: null }, /Invalid gate resolution/],
    [{ expectedRevision: 2, resolveGate: { ...v2Approval(), id: "wrong" } }, /Invalid gate resolution/],
    [{ expectedRevision: 2, patch: { title: "still gated" } }, /Gate/],
    [{ expectedRevision: 2, resolveGate: { ...v2Approval(), status: "changes_requested" } }, /Gate/],
    [{ expectedRevision: 2, patch: { activeGate: { ...v2Gate(), id: "new" } } }, /Gate/],
  ]) {
    await assert.rejects(f.kernel.dispatch({ squadId, ...update, slots: [{ slotId: "never-created", task: "No effects", workspace: "worktree", touches: [] }] }), error);
    assert.deepEqual(await v2DiskImage(f.root), disk, JSON.stringify(update));
    assert.equal(f.threads.size, threadCount);
    assert.equal(f.sent.length, 0);
  }
  assert.equal((await f.kernel.status({ squadId })).state.revision, 2);
});

test("V2 dispatch preflights the full slot batch before STATE persistence and preserves legacy no-update dispatch", async t => {
  const f = await v2Fixture(t), { squadId } = f;
  const initial = await f.kernel.dispatch({ squadId, slots: [{ slotId: "busy", task: "Original", touches: [] }] });
  assert.equal(initial.state.revision, 1);
  const disk = await v2DiskImage(f.root), threadCount = f.threads.size, sendCount = f.sent.length;
  const good = { slotId: "first", task: "Do not dispatch yet", touches: [] };
  for (const [slots, error] of [
    [[], /1..20 slots/], [[good, null], /Invalid slot/], [[good, { ...good }], /Duplicate slot/],
    [[good, { ...good, slotId: "invalid", touches: ["../escape"] }], /Invalid slot/],
    [[good, { ...good, slotId: "dependency", dependsOn: ["missing"] }], /dependencies/],
    [[good, { ...good, slotId: "busy" }], /Slot is busy/],
  ]) {
    await assert.rejects(f.kernel.dispatch({ squadId, expectedRevision: 1, patch: { title: "Must not persist" }, slots }), error);
    assert.deepEqual(await v2DiskImage(f.root), disk);
    assert.equal(f.threads.size, threadCount);
    assert.equal(f.sent.length, sendCount);
  }
  f.threads.get(initial.slots[0].threadId).status = { type: "idle" };
  const updated = await f.kernel.dispatch({ squadId, expectedRevision: 1, patch: { title: "Atomic patch only" }, slots: [good] });
  assert.equal(updated.state.title, "Atomic patch only");
  assert.equal(updated.state.revision, 2);
  const markdown = await fs.readFile(path.join(f.root, ".mycodex", "squads-v2", squadId, "STATE.md"), "utf8");
  assert.match(markdown, /Atomic patch only/);
});


test("V2 resolveGate-only dispatch uses the same transaction and runtime failures do not roll back or replay accepted work", async t => {
  let fail = false;
  const f = await v2Fixture(t, async () => { if (fail) throw new Error("Unknown runtime acceptance"); }), { squadId } = f;
  await f.kernel.state({ squadId, expectedRevision: 1, patch: { activeGate: v2Gate() } });
  const dispatched = await f.kernel.dispatch({ squadId, expectedRevision: 2, resolveGate: v2Approval(), slots: [{ slotId: "approved", task: "Verify", touches: [] }] });
  assert.equal(dispatched.state.revision, 3);
  assert.equal(dispatched.state.activeGate.status, "approved");
  fail = true;
  await assert.rejects(f.kernel.dispatch({ squadId, expectedRevision: 3, patch: { title: "Committed before send" }, slots: [{ slotId: "uncertain", task: "May have reached runtime", touches: [] }] }), /Unknown runtime acceptance/);
  const stored = JSON.parse(await fs.readFile(path.join(f.root, ".mycodex", "squads-v2", squadId, "state.json"), "utf8"));
  assert.equal(stored.state.revision, 4);
  assert.equal(stored.state.title, "Committed before send");
  assert.equal(stored.activities.uncertain, "failed");
  assert.ok(stored.dispatched.uncertain);
  assert.equal(f.sent.filter(s => s.text.includes("May have reached runtime")).length, 1);
  const status = await f.kernel.status({ squadId });
  assert.equal(status.events.at(-1).kind, "waiting");
  assert.match(status.events.at(-1).summary, /Dispatch outcome requires inspection/);
});


test("V2 criterion detail is optional, validated and projected in full into STATE and both worker briefs", async t => {
  const f = await v2Fixture(t), { squadId } = f;
  const detail = "Verify `tests/criterion-test.mjs` with exact false/true transitions.\nKeep every assertion, including <img src=x onerror=unsafe()> and trailing evidence.  ";
  const criteria = [{ id: "OPT-5A", text: "刷新后仍能继续处理待办事项", detail }, { id: "legacy", text: "兼容旧标题" }, { id: "nullable", text: "暂时不需要补充验收细则", detail: null }];
  const snapshot = await f.kernel.dispatch({ squadId, expectedRevision: 1, patch: { criteria }, slots: [
    { slotId: "builder", continuity: "stateful", task: "implementation-secret", touches: [] },
    { slotId: "verifier", continuity: "clean", task: "implementation-secret", touches: [], artifacts: ["diff:criterion"] },
  ] });
  const markdown = await fs.readFile(path.join(f.root, ".mycodex", "squads-v2", squadId, "STATE.md"), "utf8");
  assert.ok(markdown.includes(detail), "STATE.md retains the exact multiline detail");
  assert.deepEqual(snapshot.state.criteria, criteria);
  for (const slot of snapshot.slots) {
    assert.ok(slot.briefMarkdown.includes(detail), `${slot.continuity} receives every acceptance standard`);
    assert.ok(slot.briefMarkdown.includes(criteria[0].text));
  }
  const clean = snapshot.slots.find(slot => slot.continuity === "clean");
  assert.doesNotMatch(clean.briefMarkdown, /implementation-secret|Build secret rationale|public-contract/);
  const disk = await v2DiskImage(f.root), sends = f.sent.length, threads = f.threads.size;
  for (const invalid of ["", " \t\n", 1, false, [], {}]) {
    const invalidCriteria = [{ id: "bad", text: "Invalid detail", detail: invalid }];
    await assert.rejects(f.kernel.state({ squadId, expectedRevision: 2, patch: { criteria: invalidCriteria } }), /Invalid Squad V2 state/);
    await assert.rejects(f.kernel.dispatch({ squadId, expectedRevision: 2, patch: { criteria: invalidCriteria }, slots: [{ slotId: "never", task: "No effects", touches: [] }] }), /Invalid Squad V2 state/);
    await assert.rejects(f.kernel.init({ anchorThreadId: "anchor", intent: "Invalid init", state: { criteria: invalidCriteria } }), /Invalid Squad V2 state/);
    assert.deepEqual(await v2DiskImage(f.root), disk);
    assert.equal(f.sent.length, sends);
    assert.equal(f.threads.size, threads);
  }
});

async function v2StoredRecord(f) {
  return JSON.parse(await fs.readFile(path.join(f.root, ".mycodex", "squads-v2", f.squadId, "state.json"), "utf8"));
}

async function v2QueueDeferredNotices(f, slots) {
  const snapshot = await f.kernel.dispatch({ squadId: f.squadId, slots });
  const target = snapshot.slots.find(s => s.slotId === "consumed");
  for (const slot of snapshot.slots) f.threads.get(slot.threadId).status = { type: slot.slotId === "waiting" ? "needs_attention" : "idle" };
  await f.kernel.tick();
  // A subsequent human turn leaves a second, distinct deferred edge for this slot.
  f.threads.get(target.threadId).status = { type: "active" };
  await f.kernel.tick();
  f.threads.get(target.threadId).status = { type: "idle" };
  await f.kernel.tick();
  const record = await v2StoredRecord(f);
  assert.deepEqual(record.pendingNotices.map(n => [n.slotId, n.kind]), [["consumed", "quiescent"], ["untouched", "quiescent"], ["waiting", "waiting"], ["consumed", "human_stepped_in"]]);
  assert.equal(f.sent.filter(s => s.id === "anchor").length, 0, "active main defers all notices");
  return { snapshot, record };
}

const v2NoticeSlots = () => [
  { slotId: "consumed", task: "Will be consumed", touches: [] },
  { slotId: "untouched", task: "Keep its pending notice", touches: [] },
  { slotId: "waiting", task: "Waiting on external input", touches: [] },
];

test("V2 redispatch consumes only replaced slots' deferred notices, preserving other slots and immutable audit history", async t => {
  const f = await v2Fixture(t), { squadId } = f;
  const { snapshot, record } = await v2QueueDeferredNotices(f, v2NoticeSlots());
  const disk = await v2DiskImage(f.root);
  await assert.rejects(f.kernel.dispatch({ squadId, slots: [{ slotId: "consumed", task: "New work", touches: [] }, { slotId: "bad", task: "Invalid", touches: ["../escape"] }] }), /Invalid slot dispatch/);
  assert.deepEqual(await v2DiskImage(f.root), disk, "rejected dispatch does not consume pending notices or change files");
  f.threads.get(snapshot.slots.find(s => s.slotId === "waiting").threadId).status = { type: "idle" };
  const eventsPath = path.join(f.root, ".mycodex", "squads-v2", squadId, "events.jsonl");
  const history = await fs.readFile(eventsPath, "utf8");
  await f.kernel.dispatch({ squadId, slots: [
    { slotId: "consumed", task: "New work", touches: [] },
    { slotId: "waiting", task: "Unblocked work", touches: [] },
  ] });
  const after = await v2StoredRecord(f);
  assert.deepEqual(after.pendingNotices, record.pendingNotices.filter(n => n.slotId === "untouched"));
  assert.ok((await fs.readFile(eventsPath, "utf8")).startsWith(history), "old audit lines are never deleted or rewritten");
  f.threads.get("anchor").status = { type: "idle" };
  await f.kernel.tick();
  const notices = f.sent.filter(s => s.id === "anchor");
  assert.equal(notices.length, 1);
  assert.deepEqual(JSON.parse(notices[0].text.slice("[Squad Notice] ".length)).events.map(n => n.slotId), ["untouched"]);
  assert.deepEqual((await v2StoredRecord(f)).pendingNotices, []);
});

test("V2 successful integration consumes only its slot's deferred notices after merge; rejected integrations leave notices untouched", async t => {
  const f = await v2Fixture(t), { squadId } = f;
  const { git } = await import("../gateway/spine/squad-v2-workspace.mjs");
  await git(f.root, "init", "-b", "main");
  await git(f.root, "config", "user.email", "squad-notice@example.invalid");
  await git(f.root, "config", "user.name", "Squad Notice Test");
  await fs.writeFile(path.join(f.root, ".gitignore"), ".mycodex/\n");
  await fs.writeFile(path.join(f.root, "owned.txt"), "base\n");
  await git(f.root, "add", ".gitignore", "owned.txt");
  await git(f.root, "commit", "-m", "notice fixture");
  const slots = v2NoticeSlots();
  slots[0] = { ...slots[0], workspace: "worktree", touches: ["owned.txt"] };
  const { snapshot, record } = await v2QueueDeferredNotices(f, slots);
  const target = snapshot.slots.find(s => s.slotId === "consumed");
  await fs.writeFile(path.join(target.worktreePath, "owned.txt"), "accepted\n");
  await git(target.worktreePath, "add", "owned.txt");
  await git(target.worktreePath, "commit", "-m", "accepted delivery");
  await f.kernel.state({ squadId, expectedRevision: 1, patch: { tasks: [{ slotId: "consumed", goal: "Accepted", status: "done", touches: ["owned.txt"], dependsOn: [] }] } });
  await assert.rejects(f.kernel.integrate({ squadId, slotId: "consumed", expectedRevision: 1 }), /Revision conflict/);
  assert.deepEqual((await v2StoredRecord(f)).pendingNotices, record.pendingNotices);
  await fs.writeFile(path.join(snapshot.integrationWorktree, "owned.txt"), "dirty\n");
  await assert.rejects(f.kernel.integrate({ squadId, slotId: "consumed", expectedRevision: 2 }), /clean worktrees/);
  assert.deepEqual((await v2StoredRecord(f)).pendingNotices, record.pendingNotices);
  await git(snapshot.integrationWorktree, "restore", "owned.txt");
  const eventsPath = path.join(f.root, ".mycodex", "squads-v2", squadId, "events.jsonl");
  const history = await fs.readFile(eventsPath, "utf8");
  await f.kernel.integrate({ squadId, slotId: "consumed", expectedRevision: 2 });
  assert.equal(await fs.readFile(path.join(snapshot.integrationWorktree, "owned.txt"), "utf8"), "accepted\n");
  assert.deepEqual((await v2StoredRecord(f)).pendingNotices, record.pendingNotices.filter(n => n.slotId !== "consumed"));
  assert.ok((await fs.readFile(eventsPath, "utf8")).startsWith(history));
  f.threads.get("anchor").status = { type: "idle" };
  await f.kernel.tick();
  const notices = f.sent.filter(s => s.id === "anchor");
  assert.equal(notices.length, 1);
  assert.deepEqual(JSON.parse(notices[0].text.slice("[Squad Notice] ".length)).events.map(n => n.slotId), ["untouched", "waiting"]);
});

test("V2 close clears all deferred notices without erasing history or waking the idle main", async t => {
  const f = await v2Fixture(t), { squadId } = f;
  const { record } = await v2QueueDeferredNotices(f, v2NoticeSlots());
  await assert.rejects(f.kernel.close({ squadId, promoteSlots: ["missing"] }), /Only stateful/);
  assert.deepEqual((await v2StoredRecord(f)).pendingNotices, record.pendingNotices);
  const eventsPath = path.join(f.root, ".mycodex", "squads-v2", squadId, "events.jsonl");
  const history = await fs.readFile(eventsPath, "utf8");
  await f.kernel.close({ squadId, promoteSlots: ["consumed"] });
  const closed = await v2StoredRecord(f);
  assert.equal(closed.status, "closed");
  assert.deepEqual(closed.pendingNotices, []);
  assert.equal(closed.slots.find(s => s.slotId === "consumed").sidebarHidden, false);
  assert.ok((await fs.readFile(eventsPath, "utf8")).startsWith(history));
  f.threads.get("anchor").status = { type: "idle" };
  await f.kernel.tick();
  assert.equal(f.sent.filter(s => s.id === "anchor").length, 0);
});


test("V2 cold notLoaded is quiescent but pending turns, subagents and system waits remain visible", async t => {
  const f = await v2Fixture(t, undefined, { send: async thread => { thread.status = { type: 'active' }; return { turnId: 'tracked-turn' }; } }), { squadId } = f;
  const snap = await f.kernel.dispatch({ squadId, slots: [{ slotId: "cold", task: "Inspect", touches: [] }] });
  const thread = f.threads.get(snap.slots[0].threadId);
  thread.status = { type: "notLoaded" };
  let current = await f.kernel.status({ squadId });
  assert.equal(current.slots[0].activity, "quiescent");
  assert.equal(current.needsYou.length, 0);
  for (const turnStatus of ["inProgress", "active", "running", "unknown"]) {
    thread.turnStatus = turnStatus;
    assert.equal((await f.kernel.status({ squadId })).slots[0].activity, "active", turnStatus);
  }
  thread.turnStatus = "completed";
  thread.activeSubagents = true;
  assert.equal((await f.kernel.status({ squadId })).slots[0].activity, "active");
  thread.activeSubagents = false;
  for (const flag of ["waitingOnApproval", "waitingOnUserInput"]) {
    thread.status = { type: "notLoaded", activeFlags: [flag] };
    current = await f.kernel.status({ squadId });
    assert.equal(current.slots[0].activity, "waiting"); assert.match(current.slots[0].waitsOn, new RegExp(flag));
    thread.status = { type: flag };
    assert.equal((await f.kernel.status({ squadId })).slots[0].activity, "waiting");
  }
  await f.kernel.close({ squadId });
  thread.status = { type: "notLoaded" };
  assert.equal((await f.kernel.status({ squadId })).needsYou.length, 0);
});

test("Studio open-thread authenticates, rechecks clean system waits and never promotes clean slots", async t => {
  const opened = [];
  let connected = true;
  const f = await v2Fixture(t, undefined, {
    create: async (_slot, cwd) => { const thread = { id: randomUUID(), cwd, status: { type: "idle" } }; f.threads.set(thread.id, thread); return thread; },
    open: async thread => { opened.push(thread.id); return { opened: connected }; },
  });
  const snap = await f.kernel.dispatch({ squadId: f.squadId, slots: [
    { slotId: "expert", continuity: "stateful", task: "Build", touches: [] },
    { slotId: "review", continuity: "clean", task: "Verify", touches: [] },
  ] });
  const url = new URL(snap.studioUrl); url.pathname += "/open-thread";
  const post = (slotId, extra = {}) => fetch(url, { method: "POST", body: JSON.stringify({ slotId, ...extra }) });
  const unsigned = new URL(url); unsigned.search = "";
  assert.equal((await fetch(unsigned, { method: "POST", body: '{"slotId":"expert"}' })).status, 403);
  assert.equal((await fetch(url, { method: "POST", headers: { Origin: "https://untrusted.invalid" }, body: '{"slotId":"expert"}' })).status, 403);
  assert.equal((await post("review")).status, 409);
  assert.equal(opened.length, 0);
  const review = snap.slots.find(s => s.slotId === "review"), expert = snap.slots.find(s => s.slotId === "expert");
  const thread = f.threads.get(review.threadId);
  for (const flag of ["waitingOnApproval", "waitingOnUserInput"]) {
    thread.status = { type: "active", activeFlags: [flag] };
    const response = await post("review"); assert.equal(response.status, 200);
    const payload = await response.json(); assert.equal(payload.opened, true);
    assert.equal(payload.snapshot.slots.find(s => s.slotId === "review").sidebarHidden, true);
    await assert.rejects(f.kernel.promote({ squadId: f.squadId, slotId: "review" }), /Only stateful/);
  }
  thread.status = { type: "needs_attention" };
  assert.equal((await post("review")).status, 409, "generic attention never grants clean private-chat access");
  thread.status = { type: "idle" };
  assert.equal((await post("review")).status, 409, "stale waiting UI cannot open an idle clean session");
  assert.equal((await post("expert", { threadId: review.threadId })).status, 409, "cannot substitute another thread");
  connected = false;
  const fallback = await (await post("expert")).json();
  assert.equal(fallback.opened, false); assert.match(fallback.message, /Desktop|侧栏/);
  assert.equal(fallback.snapshot.slots.find(s => s.slotId === "expert").sidebarHidden, true);
  assert.doesNotMatch(fallback.message, /已解除侧栏隐藏/);
  thread.status = { type: "waitingOnApproval" };
  const cleanFallback = await (await post("review")).json();
  assert.equal(cleanFallback.opened, false);
  assert.equal(cleanFallback.snapshot.slots.find(s => s.slotId === "review").sidebarHidden, true);
  assert.ok(opened.includes(expert.threadId));
});


test("Gateway Studio navigation binds to the native host PID and carries fresh hidden-worker waits to the sidebar", async t => {
  const { connectGateway, writeMessage } = await import("../gateway/ipc.mjs");
  const { RpcPeer } = await import("../gateway/rpc-peer.mjs");
  const { squadWorkerToken } = await import("../gateway/spine-tokens.mjs");
  const f = await squadFixture(t), native = await attachSquadNative(t, f, { holdTurns: true });
  const anchor = await native.create();
  const binding = (await f.call("diy/host/status")).bindings[0];
  const anchorHostRef = { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: anchor.id };
  const initial = await f.call("diy/squad/create", { v2: true, anchorThreadId: anchor.id, anchorHostRef });
  const snap = await f.call("diy/squad/dispatch", { v2: true, squadId: initial.squadId, slots: [{ slotId: "review", continuity: "clean", engine: "native", model: "native-model", task: "Verify", touches: [] }] });
  const slot = snap.slots[0];
  native.threads.get(slot.threadId).status = { type: "active", activeFlags: ["waitingOnApproval"] };
  const sidebar = await f.call("diy/squad/list");
  assert.deepEqual(sidebar.threads.find(thread => thread.id === slot.threadId).status.activeFlags, ["waitingOnApproval"]);
  assert.equal(sidebar.squads.find(s => s.id === snap.squadId).members.find(m => m.threadId === slot.threadId).sidebarHidden, true);
  const url = new URL(snap.studioUrl); url.pathname += "/open-thread";
  const post = () => fetch(url, { method: "POST", body: JSON.stringify({ slotId: "review" }) }).then(response => response.json());
  const routed = [];
  const connectDesktop = async (pid, config = f.config) => {
    let socket;
    const peer = new RpcPeer(message => writeMessage(socket, message));
    peer.onRequest = message => { routed.push({ pid, method: message.method, params: message.params }); peer.notify({ id: message.id, result: { opened: true } }); };
    socket = await connectGateway(config, message => peer.receive(message));
    t.after(() => { socket.destroy(); peer.close(); });
    await peer.request("initialize", {});
    return { peer, socket };
  };
  const other = await connectDesktop(binding.frontendPid + 1);
  await other.peer.request("gateway/desktop/register", { frontendPid: binding.frontendPid + 1 });
  assert.equal((await post()).opened, false, "another app PID never receives this squad navigation");
  assert.equal(routed.length, 0);
  const matching = await connectDesktop(binding.frontendPid);
  await matching.peer.request("gateway/desktop/register", { frontendPid: binding.frontendPid });
  const opened = await post(); assert.equal(opened.opened, true);
  assert.deepEqual(routed, [{ pid: binding.frontendPid, method: "mycodex/desktop/open_thread", params: { threadId: slot.threadId, anchorThreadId: anchor.id } }]);
  assert.equal(opened.snapshot.slots[0].sidebarHidden, true);
  const duplicate = await connectDesktop(binding.frontendPid);
  await duplicate.peer.request("gateway/desktop/register", { frontendPid: binding.frontendPid });
  assert.equal((await post()).opened, false, "ambiguous helpers never broadcast navigation");
  assert.equal(routed.length, 1);
  const worker = await connectDesktop(binding.frontendPid, { ...f.config, token: squadWorkerToken(f.config.token, f.config.generation) });
  await assert.rejects(worker.peer.request("gateway/desktop/register", { frontendPid: binding.frontendPid }), /worker channel/);
  await assert.rejects(matching.peer.request("gateway/desktop/register", { frontendPid: 0 }), /Invalid Desktop/);
});


test("V2 live model projection refreshes existing slots without persisting observations or changing redispatch contracts", async t => {
  const f = await v2Fixture(t), { squadId } = f;
  Object.assign(f.threads.get("anchor"), { model: "anchor-model", reasoningEffort: "xhigh" });
  let snap = await f.kernel.dispatch({ squadId, slots: [
    { slotId: "inherited", task: "Build", touches: [] },
    { slotId: "explicit", task: "Verify", touches: [], model: "configured-model", reasoningEffort: "low" },
  ] });
  const file = path.join(f.root, ".mycodex", "squads-v2", squadId, "state.json");
  const storedBefore = await fs.readFile(file, "utf8");
  for (const slot of snap.slots) Object.assign(f.threads.get(slot.threadId), { model: "observed-model", reasoningEffort: "high", status: { type: "idle" } });
  snap = await f.kernel.status({ squadId });
  assert.equal(snap.slots.find(s => s.slotId === "inherited").model, "observed-model");
  assert.equal(snap.slots.find(s => s.slotId === "inherited").reasoningEffort, "high");
  assert.equal(snap.slots.find(s => s.slotId === "explicit").model, "configured-model");
  assert.equal(snap.slots.find(s => s.slotId === "explicit").reasoningEffort, "low");
  assert.deepEqual(snap.anchorSettings, { model: "anchor-model", reasoningEffort: "xhigh" });
  assert.equal(await fs.readFile(file, "utf8"), storedBefore, "status must not persist live settings");
  await assert.rejects(f.kernel.dispatch({ squadId, slots: [{ slotId: "explicit", task: "Again", touches: [], reasoningEffort: "high" }] }), /Stateful slot retains/);
  snap = await f.kernel.dispatch({ squadId, slots: [
    { slotId: "inherited", task: "Again", touches: [] },
    { slotId: "explicit", task: "Again", touches: [] },
  ] });
  assert.equal(snap.slots.find(s => s.slotId === "explicit").reasoningEffort, "low");
  const stored = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(stored.slots.find(s => s.slotId === "inherited").model, "");
  assert.equal(stored.slots.find(s => s.slotId === "inherited").reasoningEffort, undefined);
  assert.equal(stored.slots.find(s => s.slotId === "explicit").reasoningEffort, "low");
  const explicit = snap.slots.find(s => s.slotId === "explicit");
  f.threads.get(explicit.threadId).status = { type: "idle" };
  await assert.rejects(f.kernel.dispatch({ squadId, slots: [{ slotId: "explicit", task: "Override after omitted redispatch", touches: [], reasoningEffort: "high" }] }), /Stateful slot retains/);
  const inherited = snap.slots.find(s => s.slotId === "inherited");
  f.threads.get(inherited.threadId).model = "changed-live-model";
  assert.equal((await f.kernel.status({ squadId })).slots.find(s => s.slotId === "inherited").model, "changed-live-model");
  f.threads.delete("anchor");
  assert.equal((await f.kernel.status({ squadId })).slots.length, 2, "offline anchor does not prevent slot inspection");
});

test("Gateway V2 snapshots observe native rollout settings and CLI store settings without squad migration", async t => {
  const f = await squadFixture(t), native = await attachSquadNative(t, f);
  const cliAnchor = await f.createThread();
  const cliAnchorStored = f.gateway.protocol.store.get(cliAnchor.id); cliAnchorStored.reasoningEffort = "medium";
  f.gateway.protocol.store.save(cliAnchorStored);
  const cliInit = await f.call("diy/squad/create", { v2: true, anchorThreadId: cliAnchor.id });
  const cliSnap = await f.call("diy/squad/dispatch", { v2: true, squadId: cliInit.squadId, slots: [{ slotId: "cli", task: "Build", touches: [], model: "fixture/model" }] });
  // Reproduce an existing persisted slot with no explicit model, independently
  // of the CLI catalog's admission policy for newly created sessions.
  const cliStateFile = path.join(f.home, ".mycodex", "squads-v2", cliInit.squadId, "state.json");
  const cliState = JSON.parse(await fs.readFile(cliStateFile, "utf8")); cliState.slots[0].model = "";
  await fs.writeFile(cliStateFile, JSON.stringify(cliState));
  const cliThread = f.gateway.protocol.store.get(cliSnap.slots[0].threadId);
  cliThread.reasoningEffort = "high"; f.gateway.protocol.store.save(cliThread);
  const cliView = await f.call("diy/squad/list", { v2: true, squadId: cliInit.squadId });
  assert.equal(cliView.slots[0].model, cliThread.model);
  assert.equal(cliView.slots[0].reasoningEffort, "high");
  assert.equal(cliView.anchorSettings.reasoningEffort, "medium");
  const anchor = await native.create(), binding = (await f.call("diy/host/status")).bindings[0];
  const anchorHostRef = { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: anchor.id };
  const init = await f.call("diy/squad/create", { v2: true, anchorThreadId: anchor.id, anchorHostRef });
  const snap = await f.call("diy/squad/dispatch", { v2: true, squadId: init.squadId, slots: [{ slotId: "native", engine: "native", task: "Verify", touches: [] }] });
  const rollout = path.join(f.home, "rollout-model.jsonl");
  await fs.writeFile(rollout, JSON.stringify({ type: "turn_context", payload: { model: "native-effective", collaboration_mode: { settings: { reasoning_effort: "xhigh" } } } }) + "\n");
  native.threads.get(snap.slots[0].threadId).path = rollout;
  const view = await f.call("diy/squad/list", { v2: true, squadId: init.squadId });
  assert.equal(view.slots[0].model, "native-effective");
  assert.equal(view.slots[0].reasoningEffort, "xhigh");
});


test("V2 model and effort fallback is independent and explicit null effort stays unset", async t => {
  const f = await v2Fixture(t);
  const snap = await f.kernel.dispatch({ squadId: f.squadId, slots: [
    { slotId: "model", task: "Inspect", touches: [], model: "configured" },
    { slotId: "effort", task: "Inspect", touches: [], reasoningEffort: "low" },
    { slotId: "null", task: "Inspect", touches: [], reasoningEffort: null },
  ] });
  for (const slot of snap.slots) Object.assign(f.threads.get(slot.threadId), { model: "measured", reasoningEffort: "high" });
  const view = await f.kernel.status({ squadId: f.squadId });
  assert.deepEqual(view.slots.map(s => [s.model, s.reasoningEffort]), [["configured", "high"], ["measured", "low"], ["measured", null]]);
});


test("V2 runtime offline preserves terminal observations and reports without creating Needs You or repeated notices", async t => {
  const f = await v2Fixture(t), { squadId } = f;
  const snap = await f.kernel.dispatch({ squadId, slots: [{ slotId:"done", task:"Build", touches:[] }, { slotId:"clean", continuity:"clean", task:"Verify", touches:[] }] });
  for (const slot of snap.slots) f.threads.get(slot.threadId).status = { type:"idle" };
  await fs.writeFile(path.join(f.root,'.mycodex','squads-v2',squadId,'slots','done','.mycodex','result.md'), 'status: done\nsummary: Verified delivery\n## Assumptions & Trade-offs\n- Exact evidence\n');
  await f.kernel.tick();
  f.threads.get('anchor').status = { type:'idle' }; await f.kernel.tick();
  const before = await f.kernel.status({ squadId }), notices = f.sent.filter(send=>send.id==='anchor').length;
  const threads = snap.slots.map(slot=>f.threads.get(slot.threadId));
  for (const slot of snap.slots) f.threads.delete(slot.threadId);
  const offline = await f.kernel.status({ squadId });
  assert.deepEqual(offline.slots.map(slot=>slot.activity), ['offline','offline']);
  assert.equal(offline.needsYou.length, 0);
  assert.equal(offline.slots[0].result.summary, 'Verified delivery');
  assert.equal(offline.slots[1].result, undefined, "an unavailable runtime is not a synthesized blocked report");
  for (let i=0;i<3;i++) await f.kernel.tick();
  for (const thread of threads) f.threads.set(thread.id, thread);
  await f.kernel.tick();
  const recovered = await f.kernel.status({ squadId });
  assert.equal(recovered.events.length, before.events.length);
  assert.equal(f.sent.filter(send=>send.id==='anchor').length, notices);
  assert.equal(recovered.slots[0].activity, 'quiescent');
});

test("Gateway shutdown stops accepting reconnects before awaiting engine teardown", { timeout:5000 }, async t => {
  const os = await import('node:os'), net = await import('node:net'), { startGateway } = await import('../gateway/server.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'squad-close-'));
  let release, entered; const gate=new Promise(resolve=>{release=resolve}), closing=new Promise(resolve=>{entered=resolve});
  const gateway=await startGateway({home:root,endpoint:path.join(root,'s'),token:randomUUID(),generation:'close-test',engines:new Map([['test',{models:async()=>[],close:async()=>{entered();await gate;}}]]),defaultEngine:'test'});
  const stopped=gateway.close();
  t.after(async()=>{release();await stopped;await fs.rm(root,{recursive:true,force:true});});
  await closing;
  const accepted=await new Promise(resolve=>{const socket=net.connect(path.join(root,'s'));socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>{socket.destroy();resolve(false)});});
  release(); await stopped;
  assert.equal(accepted,false,'a reconnect during teardown must not reach the old gateway');
});

test("Studio shutdown closes unfinished HTTP connections instead of hanging", { timeout:5000 }, async t => {
  const os=await import('node:os'),net=await import('node:net'),{SquadV2Kernel}=await import('../gateway/spine/squad-v2-kernel.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-close-'));
  const kernel=new SquadV2Kernel(root,{read:async id=>({id,cwd:root,status:{type:'idle'}}),create:async()=>{throw new Error('unused')},send:async()=>{}},()=>{});
  const snapshot=await kernel.init({anchorThreadId:'anchor'}),url=new URL(snapshot.studioUrl);
  const socket=net.connect(Number(url.port),'127.0.0.1');
  let stopped;
  t.after(async()=>{socket.destroy();await (stopped??kernel.shutdown());await fs.rm(root,{recursive:true,force:true});});
  await new Promise(resolve=>socket.once('connect',resolve));
  socket.write(`POST ${url.pathname}/gate${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nContent-Length: 1000\r\nConnection: keep-alive\r\n\r\n{`);
  await new Promise(resolve=>setTimeout(resolve,30));
  stopped=kernel.shutdown();
  const completed=await Promise.race([stopped.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),300))]);
  socket.destroy();await stopped;
  assert.equal(completed,true,'an unfinished HTTP body must not pin Studio shutdown');
});


test("stale Squad refs reconnect through Desktop amid helper bindings, heal persisted refs and navigate without promotion", async t => {
  const { connectGateway, writeMessage }=await import('../gateway/ipc.mjs'),{RpcPeer}=await import('../gateway/rpc-peer.mjs'),{nativeHostToken}=await import('../gateway/spine-tokens.mjs');
  const f=await squadFixture(t),native=await attachSquadNative(t,f),anchor=await native.create();
  const old=(await f.call('diy/host/status')).bindings[0],ref={hostId:old.hostId,accountId:old.accountId,runtimeId:old.runtimeId,threadId:anchor.id};
  const init=await f.call('diy/squad/create',{v2:true,anchorThreadId:anchor.id,anchorHostRef:ref});
  const snap=await f.call('diy/squad/dispatch',{v2:true,squadId:init.squadId,slots:[{slotId:'dev',engine:'native',task:'Inspect',touches:[]}]});
  await native.close();
  await until(()=>f.call('diy/host/status'),state=>!state.bindings.some(binding=>binding.runtimeId===old.runtimeId));
  let unavailable=true;const reads=[],routes=[];
  const connect=async(token)=>{let socket;const peer=new RpcPeer(message=>writeMessage(socket,message));socket=await connectGateway({...f.config,token},message=>peer.receive(message));t.after(()=>{socket.destroy();peer.close()});await peer.request('initialize',{});return peer;};
  const bind=async(pid,accountId=old.accountId)=>{
    const peer=await connect(nativeHostToken(f.config.token,f.config.generation)),runtimeId=randomUUID();
    peer.onRequest=message=>{
      const current=message.params.ref,command=message.params.command;
      if(command.operation==='read'){
        reads.push([runtimeId,current.threadId]);
        if(unavailable){peer.notify({id:message.id,error:{code:-32000,message:'temporarily offline'}});return;}
        peer.notify({id:message.id,result:{thread:{...native.threads.get(current.threadId),hostRef:current,archived:false}}});
      }else if(command.operation==='turn')peer.notify({id:message.id,result:{status:'completed'}});
      else peer.notify({id:message.id,error:{code:-32601,message:'read only fixture'}});
    };
    await peer.request('gateway/host/register',{runtimeId,hostId:old.hostId,accountId,accountVerified:true,canSquad:true,frontendPid:pid});return runtimeId;
  };
  await bind(9002);await bind(9003);const desktop=await bind(9001);await bind(9001,'c'.repeat(64));
  const ui=await connect(f.config.token);ui.onRequest=message=>{routes.push(message.params);ui.notify({id:message.id,result:{opened:true}})};
  await ui.request('gateway/desktop/register',{frontendPid:9001});
  const url=new URL(snap.studioUrl);url.pathname+='/open-thread';
  const opened=await(await fetch(url,{method:'POST',body:JSON.stringify({slotId:'dev'})})).json();
  assert.equal(opened.opened,true,'Desktop PID can resolve the stale ref even while physical reads are temporarily unavailable');
  assert.deepEqual(routes,[{threadId:snap.slots[0].threadId,anchorThreadId:anchor.id}]);
  assert.equal(opened.snapshot.slots[0].sidebarHidden,true);
  unavailable=false;
  const current=await f.call('diy/squad/list',{v2:true,squadId:init.squadId});
  assert.equal(current.slots[0].activity,'quiescent');assert.equal(current.needsYou.length,0);
  assert.equal(current.slots[0].hostRef.runtimeId,desktop);
  const stored=JSON.parse(await fs.readFile(path.join(f.home,'.mycodex','squads-v2',init.squadId,'state.json'),'utf8'));
  assert.equal(stored.anchorHostRef.runtimeId,desktop);assert.equal(stored.slots[0].hostRef.runtimeId,desktop);
  assert.equal(stored.state.revision,1,'transport healing is not a business contract revision');
  assert.ok(reads.every(([runtime])=>runtime===desktop),'auxiliary bindings and other accounts receive no target reads');
});


test('C6: cold slots and anchors wake only without active turns, waits or subagents', async t => {
  const f = await v2Fixture(t), { squadId } = f;
  let snap = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', task: 'wave one', touches: [] }] });
  const worker = f.threads.get(snap.slots[0].threadId), anchor = f.threads.get('anchor');
  worker.status = { type: 'notLoaded' };
  for (const guard of [{ activeSubagents: true }, { turnStatus: 'inProgress' }, { status: { type: 'notLoaded', activeFlags: ['waitingOnApproval'] } }]) {
    Object.assign(worker, guard);
    // A tracked active turn must prevent redispatch even with a cold status.
    if (guard.turnStatus) {
      const file = path.join(f.root, '.mycodex', 'squads-v2', squadId, 'state.json');
      const record = JSON.parse(await fs.readFile(file, 'utf8')); record.turnIds = { dev: 'tracked' }; await fs.writeFile(file, JSON.stringify(record));
    }
    await assert.rejects(f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', task: 'unsafe', touches: [] }] }), /busy/);
    worker.activeSubagents = false; worker.turnStatus = 'completed'; worker.status = { type: 'notLoaded' };
  }
  snap = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', task: 'wave two', touches: [] }] });
  assert.equal(snap.slots[0].threadId, worker.id);
  assert.equal(f.threads.size, 2);
  worker.status = { type: 'notLoaded' }; anchor.status = { type: 'notLoaded' };
  for (const guard of [{ activeSubagents: true }, { turnStatus: 'inProgress' }, { status: { type: 'notLoaded', activeFlags: ['waitingOnUserInput'] } }]) {
    Object.assign(anchor, guard); await f.kernel.tick();
    assert.equal(f.sent.filter(x => x.id === 'anchor').length, 0);
    anchor.activeSubagents = false; anchor.turnStatus = 'completed'; anchor.status = { type: 'notLoaded' };
  }
  await f.kernel.tick(); await f.kernel.tick();
  assert.equal(f.sent.filter(x => x.id === 'anchor').length, 1);
  assert.match(f.sent.at(-1).text, /^\[Squad Notice\]/);
});

test('C6: init converges per anchor, evolves in place, and rejects invalid or gated changes atomically', async t => {
  const f = await v2Fixture(t), { squadId } = f;
  const sent = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', task: 'standing role', touches: [] }] });
  const concurrent = await Promise.all([1, 2, 3].map(() => f.kernel.init({ anchorThreadId: 'anchor', intent: 'Build secret rationale' })));
  assert.ok(concurrent.every(s => s.squadId === squadId && s.studioUrl === sent.studioUrl && s.state.revision === 1));
  const evolved = await f.kernel.init({ anchorThreadId: 'anchor', title: 'Next stage', intent: 'Continue', state: { contracts: ['next contract'] } });
  assert.equal(evolved.squadId, squadId); assert.equal(evolved.state.revision, 2);
  assert.deepEqual(evolved.slots.map(s => s.threadId), sent.slots.map(s => s.threadId));
  assert.equal(evolved.events[0].kind, 'initialized'); assert.equal(evolved.events.at(-1).kind, 'state_updated');
  await f.kernel.state({ squadId, expectedRevision: 2, patch: { activeGate: v2Gate() } });
  let disk = await v2DiskImage(f.root);
  for (const change of [{ title: 'Skip gate' }, { state: { activeGate: null } }, { state: { criteria: [{ id: 'bad' }] } }, { state: [] }, { forceNew: 'true' }]) {
    await assert.rejects(f.kernel.init({ anchorThreadId: 'anchor', ...change }));
    assert.deepEqual(await v2DiskImage(f.root), disk);
  }
  assert.equal((await f.kernel.init({ anchorThreadId: 'anchor' })).squadId, squadId, 'no-op reuse keeps an open Gate');
  await f.kernel.state({ squadId, expectedRevision: 3, resolveGate: v2Approval() });
  const { git } = await import('../gateway/spine/squad-v2-workspace.mjs');
  await git(f.root, 'init', '-b', 'main'); await git(f.root, 'config', 'user.email', 'fixture@example.invalid'); await git(f.root, 'config', 'user.name', 'Fixture');
  await fs.writeFile(path.join(f.root, '.gitignore'), '.mycodex/\n'); await git(f.root, 'add', '.gitignore'); await git(f.root, 'commit', '-m', 'base');
  const isolated = await f.kernel.init({ anchorThreadId: 'anchor', workspace: 'worktree' });
  assert.equal(isolated.squadId, squadId); assert.equal(isolated.state.revision, 5);
  assert.ok(isolated.integrationWorktree); assert.equal(isolated.slots[0].threadId, sent.slots[0].threadId);
  const forced = await f.kernel.init({ anchorThreadId: 'anchor', forceNew: true, title: 'Explicit reset' });
  assert.notEqual(forced.squadId, squadId);
  assert.equal((await f.kernel.status({ anchorThreadId: 'anchor' })).squadId, forced.squadId);
  assert.equal((await f.kernel.status({ squadId, anchorThreadId: 'anchor' })).squadId, squadId);
  await assert.rejects(f.kernel.status({ squadId, anchorThreadId: 'someone-else' }), /anchor|match/i);
  await f.kernel.close({ squadId: forced.squadId });
  assert.equal((await f.kernel.status({ anchorThreadId: 'anchor' })).squadId, squadId, 'active precedes newer closed squads');
  await f.kernel.close({ squadId });
  assert.equal((await f.kernel.status({ anchorThreadId: 'anchor' })).squadId, squadId, 'latest closed state remains addressable');
  await assert.rejects(f.kernel.status({}), /squadId|anchorThreadId/);
  await assert.rejects(f.kernel.status({ anchorThreadId: 'missing' }), /No.*Squad/i);
});

test('C6: Studio restores private port/token after restart and preserves token on occupied-port fallback', async t => {
  const f = await v2Fixture(t), { SquadV2Kernel } = await import('../gateway/spine/squad-v2-kernel.mjs'), http = await import('node:http');
  const file = path.join(f.root, '.mycodex', 'squads-v2', 'studio.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.schemaVersion, 1); assert.equal(saved.port, Number(new URL(f.initial.studioUrl).port));
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const runtime = { read: async id => f.threads.get(id), create: async () => assert.fail('no new worker'), send: async () => {} };
  await f.kernel.shutdown();
  const restored = new SquadV2Kernel(f.root, runtime, () => {}); t.after(() => restored.shutdown());
  // Startup must restore the listener without a fresh tool request from the anchor.
  let recovered = false;
  for (let i = 0; i < 30 && !recovered; i++) {
    try { recovered = (await fetch(f.initial.studioUrl)).status === 200; } catch {}
    if (!recovered) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(recovered, true, 'old Studio URL recovers on kernel startup alone');
  const snap = await restored.status({ anchorThreadId: 'anchor' });
  assert.equal(snap.studioUrl, f.initial.studioUrl);
  assert.equal((await fetch(f.initial.studioUrl)).status, 200);
  await restored.tick(); assert.equal((await restored.listAll()).length, 1, 'studio.json is not a squad');
  await restored.shutdown();
  const occupied = http.createServer(); await new Promise(resolve => occupied.listen(saved.port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const fallback = new SquadV2Kernel(f.root, runtime, () => {}); t.after(() => fallback.shutdown());
  const moved = await fallback.status({ squadId: f.squadId });
  assert.notEqual(new URL(moved.studioUrl).port, String(saved.port));
  assert.equal(new URL(moved.studioUrl).searchParams.get('token'), saved.token);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { ...saved, port: Number(new URL(moved.studioUrl).port) });
});

async function c6WorktreeFixture(t) {
  const f = await v2Fixture(t), { git } = await import('../gateway/spine/squad-v2-workspace.mjs');
  await git(f.root, 'init', '-b', 'main'); await git(f.root, 'config', 'user.email', 'fixture@example.invalid'); await git(f.root, 'config', 'user.name', 'Fixture');
  await fs.writeFile(path.join(f.root, '.gitignore'), '.mycodex/\n'); await fs.writeFile(path.join(f.root, 'one.txt'), 'base\n');
  await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'base');
  const snap = await f.kernel.dispatch({ squadId: f.squadId, slots: [{ slotId: 'dev', task: 'first', touches: ['one.txt'], workspace: 'worktree' }] });
  const role = snap.slots[0].worktreePath, base = snap.slots[0].baseSha;
  await fs.writeFile(path.join(role, 'one.txt'), 'first wave\n'); await git(role, 'add', '.'); await git(role, 'commit', '-m', 'first wave');
  f.threads.get(snap.slots[0].threadId).status = { type: 'idle' };
  return { ...f, git, role, base, integration: snap.integrationWorktree };
}

test('C6: accepted first-wave diff survives integrate; next dispatch advances both worktrees and narrows baseline', async t => {
  const f = await c6WorktreeFixture(t), { squadId, git } = f;
  await f.kernel.state({ squadId, expectedRevision: 1, patch: { tasks: [{ slotId: 'dev', goal: 'first', touches: ['one.txt'], dependsOn: [], status: 'done' }] } });
  const integrated = await f.kernel.integrate({ squadId, slotId: 'dev', expectedRevision: 2 });
  assert.equal(integrated.snapshot.slots[0].baseSha, f.base);
  assert.deepEqual(integrated.snapshot.slots[0].delta.changed.map(x => x.path), ['one.txt']);
  await git(f.root, 'merge', '--ff-only', integrated.snapshot.integrationBranch);
  await fs.writeFile(path.join(f.root, 'main.txt'), 'next baseline\n'); await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'main advanced');
  const head = await git(f.root, 'rev-parse', 'HEAD');
  const next = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', task: 'second', touches: ['two.txt'] }] });
  assert.equal(await git(f.integration, 'rev-parse', 'HEAD'), head); assert.equal(await git(f.role, 'rev-parse', 'HEAD'), head);
  assert.equal(next.slots[0].baseSha, head); assert.deepEqual(next.slots[0].delta.changed, []);
  await fs.writeFile(path.join(f.role, 'two.txt'), 'second wave\n'); await git(f.role, 'add', '.'); await git(f.role, 'commit', '-m', 'second wave');
  f.threads.get(next.slots[0].threadId).status = { type: 'idle' };
  await f.kernel.state({ squadId, expectedRevision: 2, patch: { tasks: [{ slotId: 'dev', goal: 'second', touches: ['two.txt'], dependsOn: [], status: 'done' }] } });
  const second = await f.kernel.integrate({ squadId, slotId: 'dev', expectedRevision: 3 });
  assert.deepEqual(second.delta.changed.map(x => x.path), ['two.txt']); assert.deepEqual(second.delta.outsideTouches, []);
});

test('C6: unmerged rework and dirty slot/integration worktrees retain their baseline and files', async t => {
  const f = await c6WorktreeFixture(t), { squadId, git } = f;
  const unmerged = await git(f.role, 'rev-parse', 'HEAD');
  let snap = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', task: 'rework', touches: ['one.txt'] }] });
  assert.equal(snap.slots[0].baseSha, f.base); assert.equal(await git(f.role, 'rev-parse', 'HEAD'), unmerged);
  f.threads.get(snap.slots[0].threadId).status = { type: 'idle' };
  await git(f.integration, 'merge', '--no-ff', '--no-edit', unmerged);
  await fs.writeFile(path.join(f.role, 'dirty.txt'), 'owned local data\n');
  snap = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', task: 'dirty rework', touches: ['one.txt'] }] });
  assert.equal(snap.slots[0].baseSha, f.base); assert.equal(await fs.readFile(path.join(f.role, 'dirty.txt'), 'utf8'), 'owned local data\n');
  await fs.rm(path.join(f.role, 'dirty.txt')); f.threads.get(snap.slots[0].threadId).status = { type: 'idle' };
  await git(f.root, 'merge', '--ff-only', snap.integrationBranch);
  await fs.writeFile(path.join(f.root, 'main.txt'), 'main\n'); await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'ahead');
  await fs.writeFile(path.join(f.integration, 'dirty.txt'), 'integration local data\n');
  const integrationHead = await git(f.integration, 'rev-parse', 'HEAD');
  snap = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', task: 'next', touches: ['two.txt'] }] });
  assert.equal(await git(f.integration, 'rev-parse', 'HEAD'), integrationHead);
  assert.equal(await fs.readFile(path.join(f.integration, 'dirty.txt'), 'utf8'), 'integration local data\n');
  assert.equal(snap.slots[0].baseSha, integrationHead);
});

test('C6: real Gateway restart keeps the same MCP connection surface, anchor-addressed Squad and Studio URL', async t => {
  const { PassThrough } = await import('node:stream'), { runMcp } = await import('../gateway/spine/mcp-server.mjs');
  const { RpcPeer } = await import('../gateway/rpc-peer.mjs'), { readMessages, writeMessage } = await import('../gateway/ipc.mjs');
  const cleanups = [], f = await squadFixture({ after: fn => cleanups.push(fn) });
  t.after(async () => { for (const fn of cleanups.reverse()) await fn(); });
  const file = path.join(f.home, 'connection.json');
  await fs.writeFile(file, JSON.stringify({ ...f.config, spine: { mcp: true } }), { mode: 0o600 });
  const input = new PassThrough(), output = new PassThrough(), running = runMcp(file, input, output);
  const peer = new RpcPeer(message => writeMessage(input, { jsonrpc: '2.0', ...message }));
  readMessages(output, message => peer.receive(message), error => peer.close(error));
  cleanups.push(async () => { input.end(); await running; peer.close(); output.destroy(); });
  await peer.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'real-restart', version: '1' }, capabilities: {} });
  peer.notify({ method: 'notifications/initialized' });
  const call = async (name, args) => {
    const response = await peer.request('tools/call', { name: 'mycodex.' + name, arguments: args });
    assert.equal(response.isError, false, response.content[0].text); return response.structuredContent;
  };
  const anchor = await f.createThread(), first = await call('squad_init', { anchorThreadId: anchor.id, intent: 'Standing Squad' });
  const dispatched = await call('squad_dispatch', { squadId: first.squadId, slots: [{ slotId: 'dev', task: 'first wave', touches: [], model: 'fixture/model' }] });
  await f.gateway.protocol.active.get(dispatched.slots[0].threadId)?.done;
  await f.restart();
  await until(async () => { try { return (await fetch(first.studioUrl)).status; } catch { return 0; } }, status => status === 200);
  const evolved = await call('squad_init', { anchorThreadId: anchor.id, title: 'Second stage' });
  assert.equal(evolved.squadId, first.squadId); assert.equal(evolved.studioUrl, first.studioUrl);
  assert.equal(evolved.slots[0].threadId, dispatched.slots[0].threadId);
  const card = await call('show_squad_card', { anchorThreadId: anchor.id, summary: 'Same standing Squad after restart' });
  assert.equal(card.squadId, first.squadId); assert.equal(card.review.summary, 'Same standing Squad after restart');
  assert.equal((await call('squad_status', { anchorThreadId: anchor.id })).state.title, 'Second stage');
});

test('C7: optional deliverables parse explicit cross-repository outputs and safe Markdown fallbacks without losing legacy receipts', async () => {
  const { parseResult } = await import('../gateway/spine/squad-v2-state.mjs');
  const body = `status: done\nsummary: Cross-repository delivery\n\n## Deliverables\n- [mr] core-service!83 | https://git.example/core-service/merge_requests/83 | reviewed\n- [issue] harness#1 | https://git.example/harness/issues/1\n- [commit] repo@feature abc1234 | abc1234 | local verification\n- [branch] feature/c7 | repo:feature/c7\n- [report] final | /tmp/c7-final-report.md\n- [artifact] screenshot | /tmp/c7.png\n\n## Changes & Verification\n[core-service!83](https://git.example/core-service/merge_requests/83)\n[Pull request](https://github.example/org/repo/pull/2)\n[Report](/tmp/c7-final-report.md)\n[Data](</tmp/report with spaces.json>)\n[unsafe](javascript:alert(1))\n[unrelated](https://example.test/docs)\n\n## Assumptions & Trade-offs\n- verified locally\n`;
  const parsed = parseResult(body, 100);
  assert.deepEqual(parsed.deliverables.map(d => d.kind), ['mr', 'issue', 'commit', 'branch', 'report', 'artifact', 'mr', 'artifact']);
  assert.equal(parsed.deliverables.filter(d => d.target === 'https://git.example/core-service/merge_requests/83').length, 1);
  assert.ok(parsed.deliverables.some(d => d.target === '/tmp/report with spaces.json'));
  assert.equal(parsed.deliverables.some(d => d.target?.startsWith('javascript:')), false);
  const legacy = parseResult('status: blocked\nsummary: old report\n## Assumptions & Trade-offs\n- old contract\n', 1);
  assert.equal(legacy.status, 'blocked'); assert.deepEqual(legacy.deliverables, []);
});

async function c7Report(f, slot, status = 'done', summary = 'ROUND_ONE_RESULT') {
  const file = path.join(slot.worktreePath ?? path.join(f.root, '.mycodex', 'squads-v2', f.squadId, 'slots', slot.slotId), '.mycodex', 'result.md');
  await new Promise(resolve => setTimeout(resolve, 5));
  await fs.writeFile(file, `status: ${status}\nsummary: ${summary}\n\n## Deliverables\n- [mr] core-service!83 | https://git.example/core-service/merge_requests/83\n\n## Assumptions & Trade-offs\n- ROUND_ONE_ASSUMPTION\n`);
  f.threads.get(slot.threadId).status = { type: 'idle' };
}

test('C7: shared standing slots archive waves, keep prior receipts while active, and bound monotonically numbered history', async t => {
  const f = await v2Fixture(t), { squadId } = f;
  let snap = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', goal: 'Cross repo MR', criteriaIds: ['C1'], task: 'first private objective', touches: [] }] });
  assert.equal(snap.slots[0].stage, 'running'); assert.equal(snap.state.tasks[0].status, 'running');
  assert.match(snap.slots[0].briefMarkdown, /## Deliverables/);
  await c7Report(f, snap.slots[0], 'blocked');
  snap = await f.kernel.status({ squadId });
  assert.equal(snap.slots[0].stage, 'blocked'); assert.equal(snap.slots[0].rounds[0].goal, 'Cross repo MR');
  snap = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', goal: 'Second wave', task: 'new objective', touches: [] }] });
  const [first, second] = snap.slots[0].rounds;
  assert.equal(first.round, 1); assert.equal(first.stage, 'accepted'); assert.ok(first.acceptedAt); assert.ok(first.completedAt);
  assert.equal(first.result.summary, 'ROUND_ONE_RESULT'); assert.deepEqual(first.result.assumptions, ['- ROUND_ONE_ASSUMPTION']);
  assert.equal(first.deliverables[0].kind, 'mr'); assert.match(first.briefMarkdown, /first private objective/);
  assert.equal(second.round, 2); assert.equal(second.goal, 'Second wave'); assert.equal(second.stage, 'running');
  assert.equal(snap.slots[0].result, undefined); assert.deepEqual(snap.slots[0].deliverables, []); assert.equal(snap.needsYou.length, 0);
  assert.equal(snap.state.tasks[0].goal, 'Second wave'); assert.equal(snap.state.tasks[0].status, 'running');
  assert.equal(snap.state.criteria[0].verifiedAt, undefined, 'archiving a blocked wave does not falsely verify its criterion');
  for (let n = 3; n <= 23; n++) {
    f.threads.get(snap.slots[0].threadId).status = { type: 'idle' };
    snap = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', task: 'wave ' + n, touches: [] }] });
  }
  assert.equal(snap.slots[0].rounds.length, 20); assert.equal(snap.slots[0].rounds[0].round, 4); assert.equal(snap.slots[0].rounds.at(-1).round, 23);
  const stored = await v2StoredRecord(f); assert.equal(stored.slots[0].rounds.at(-1).round, 23);
});

test('C7: legacy accepted blocked/escalated reports synthesize R1 and disappear from Needs You without migrating disk on reads', async t => {
  const f = await v2Fixture(t), { squadId } = f;
  const snap = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', task: 'Legacy task', touches: [] }] });
  await c7Report(f, snap.slots[0], 'escalate');
  const file = path.join(f.root, '.mycodex', 'squads-v2', squadId, 'state.json'), record = await v2StoredRecord(f);
  delete record.slots[0].rounds;
  record.state.tasks = [{ slotId: 'dev', goal: 'Legacy accepted task', touches: [], dependsOn: [], status: 'done' }];
  await fs.writeFile(file, JSON.stringify(record)); const disk = await v2DiskImage(f.root);
  const live = await f.kernel.status({ squadId });
  assert.equal(live.slots[0].stage, 'accepted'); assert.equal(live.slots[0].rounds[0].round, 1);
  assert.equal(live.slots[0].rounds[0].result.status, 'escalate'); assert.equal(live.slots[0].deliverables[0].kind, 'mr');
  assert.equal(live.needsYou.length, 0); assert.equal(live.state.tasks[0].status, 'done');
  assert.deepEqual(await v2DiskImage(f.root), disk);
  await f.kernel.tick(); assert.equal(f.sent.filter(x => x.id === 'anchor').length, 0);
});

test('C7: physical/result stage projects tasks and incremental acceptance verifies bound criteria atomically', async t => {
  const f = await v2Fixture(t), { squadId } = f;
  await f.kernel.state({ squadId, expectedRevision: 1, patch: { criteria: [{ id: 'C1', text: 'First' }, { id: 'C2', text: 'Second' }] } });
  let snap = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', task: 'deliver', goal: 'Outcome', criteriaIds: ['C1'], touches: [] }] });
  await c7Report(f, snap.slots[0]);
  snap = await f.kernel.status({ squadId }); assert.equal(snap.slots[0].stage, 'delivered'); assert.equal(snap.state.tasks[0].status, 'review');
  f.threads.get(snap.slots[0].threadId).status = { type: 'failed' };
  snap = await f.kernel.status({ squadId }); assert.equal(snap.slots[0].stage, 'failed'); assert.equal(snap.state.tasks[0].status, 'blocked');
  const disk = await v2DiskImage(f.root);
  for (const update of [{ acceptSlots: ['unknown'] }, { verifyCriteria: ['unknown'] }, { acceptSlots: 'dev' }, { acceptSlots: ['dev'], verifyCriteria: ['missing'] }]) {
    await assert.rejects(f.kernel.state({ squadId, expectedRevision: 2, ...update })); assert.deepEqual(await v2DiskImage(f.root), disk);
  }
  snap = await f.kernel.state({ squadId, expectedRevision: 2, acceptSlots: ['dev'], verifyCriteria: ['C2'] });
  assert.equal(snap.state.revision, 3); assert.equal(snap.slots[0].stage, 'accepted'); assert.equal(snap.state.tasks[0].status, 'done');
  assert.ok(snap.state.criteria.every(c => c.verifiedAt != null)); assert.equal(snap.needsYou.length, 0);
  const thread = f.threads.get(snap.slots[0].threadId);
  thread.status = { type: 'active' }; assert.equal((await f.kernel.status({ squadId })).slots[0].stage, 'running');
  thread.status = { type: 'waitingOnUserInput' }; assert.equal((await f.kernel.status({ squadId })).slots[0].stage, 'waiting');
  thread.status = { type: 'idle' };
  snap = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', task: 'fresh acceptance boundary', criteriaIds: ['C2'], touches: [] }] });
  thread.status = { type: 'idle' };
  const fresh = await f.kernel.status({ squadId }); assert.equal(fresh.slots[0].stage, 'planned'); assert.equal(fresh.state.tasks[0].status, 'todo');
  assert.equal(fresh.slots[0].rounds.at(-1).acceptedAt, undefined, 'previous done task cannot accept a later dispatch');
});

test('C7: dispatch can incrementally close one slot and launch another; invalid plans leave acceptance and criteria untouched', async t => {
  const f = await v2Fixture(t), { squadId } = f;
  let snap = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'old', task: 'first', criteriaIds: ['C1'], touches: [] }] });
  await c7Report(f, snap.slots[0], 'blocked');
  const disk = await v2DiskImage(f.root);
  for (const slots of [[{ slotId: 'next', task: 'next', criteriaIds: ['unknown'], touches: [] }], [{ slotId: 'bad', task: 'next', touches: ['/absolute'] }]]) {
    await assert.rejects(f.kernel.dispatch({ squadId, expectedRevision: 1, acceptSlots: ['old'], slots }));
    assert.deepEqual(await v2DiskImage(f.root), disk);
  }
  snap = await f.kernel.dispatch({ squadId, expectedRevision: 1, acceptSlots: ['old'], verifyCriteria: ['C1'], slots: [{ slotId: 'next', task: 'next', touches: [] }] });
  assert.equal(snap.state.revision, 2); assert.equal(snap.slots.find(s => s.slotId === 'old').stage, 'accepted');
  assert.equal(snap.slots.find(s => s.slotId === 'next').stage, 'running'); assert.equal(snap.needsYou.length, 0);
  assert.ok(snap.state.criteria[0].verifiedAt);
});

test('C7: integrate accepts a quiescent bounded worktree and verifies criteria in one step; later waves retain the original delta', async t => {
  const f = await c6WorktreeFixture(t), { squadId } = f;
  await f.kernel.state({ squadId, expectedRevision: 1, patch: { criteria: [{ id: 'C1', text: 'First' }, { id: 'C2', text: 'Extra' }] } });
  // Bind C1 as if this had been dispatched by a C7 client, without pre-accepting tasks.
  const file = path.join(f.root, '.mycodex', 'squads-v2', squadId, 'state.json'), record = await v2StoredRecord(f);
  assert.ok(record.slots[0].rounds); record.slots[0].rounds.at(-1).criteriaIds = ['C1']; await fs.writeFile(file, JSON.stringify(record));
  const before = await v2DiskImage(f.root);
  await assert.rejects(f.kernel.integrate({ squadId, slotId: 'dev', expectedRevision: 2, verifyCriteria: ['missing'] }));
  assert.deepEqual(await v2DiskImage(f.root), before);
  const integrated = await f.kernel.integrate({ squadId, slotId: 'dev', expectedRevision: 2, verifyCriteria: ['C2'] });
  assert.equal(integrated.snapshot.slots[0].stage, 'accepted'); assert.equal(integrated.snapshot.state.tasks[0].status, 'done');
  assert.ok(integrated.snapshot.state.criteria.every(c => c.verifiedAt));
  assert.deepEqual(integrated.snapshot.slots[0].delta.changed.map(f => f.path), ['one.txt']);
  const next = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', task: 'second', touches: ['two.txt'] }] });
  const historical = next.slots[0].rounds[0];
  assert.equal(historical.deltaSummary.changedCount, 1); assert.equal(historical.deltaSummary.commitCount, 1);
  assert.equal(historical.deltaSummary.files[0].path, 'one.txt'); assert.equal(historical.deltaSummary.baseSha, f.base);
  assert.ok(historical.deliverables.some(d => d.kind === 'commit')); assert.deepEqual(next.slots[0].delta.changed, []);
});

test('C7: a failed fresh-session creation cannot erase the previous wave receipt or brief', async t => {
  let fail = false;
  const f = await v2Fixture(t, undefined, { create: async (_slot, cwd) => {
    if (fail) throw new Error('fresh runtime unavailable');
    const thread = { id: 'clean-one', cwd, status: { type: 'idle' } }; f.threads.set(thread.id, thread); return thread;
  } });
  const { squadId } = f;
  const first = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'qa', task: 'Original private QA brief', continuity: 'clean', touches: [] }] });
  await c7Report(f, first.slots[0], 'blocked', 'ORIGINAL_QA_RECEIPT'); fail = true;
  await assert.rejects(f.kernel.dispatch({ squadId, slots: [{ slotId: 'qa', task: 'next QA', touches: [] }] }), /fresh runtime unavailable/);
  const record = await v2StoredRecord(f), original = record.slots[0].rounds[0];
  assert.equal(original.result.summary, 'ORIGINAL_QA_RECEIPT'); assert.match(original.briefMarkdown, /Acceptance Criteria/);
  assert.equal(original.stage, 'accepted'); assert.equal(record.slots[0].rounds.length, 1, 'failed new wave never replaces the old thread/round');
});

test('C7: init STATE evolution uses the same acceptance source; accepted offline history cannot deliver a stale warning', async t => {
  const f = await v2Fixture(t), { squadId } = f;
  const first = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', task: 'Outcome', criteriaIds: ['C1'], touches: [] }] });
  await c7Report(f, first.slots[0], 'escalate');
  let snap = await f.kernel.init({ anchorThreadId: 'anchor', state: { tasks: [{ slotId: 'dev', goal: 'Outcome', touches: [], dependsOn: [], status: 'done' }] } });
  assert.equal(snap.slots[0].stage, 'accepted'); assert.ok(snap.state.criteria[0].verifiedAt); assert.equal(snap.needsYou.length, 0);
  const file = path.join(f.root, '.mycodex', 'squads-v2', squadId, 'state.json'), record = await v2StoredRecord(f);
  record.pendingNotices = [{ seq: 99, at: Date.now(), kind: 'waiting', slotId: 'dev', summary: 'STALE_ESCALATION' }];
  await fs.writeFile(file, JSON.stringify(record));
  f.threads.delete(first.slots[0].threadId); f.threads.get('anchor').status = { type: 'idle' };
  await f.kernel.tick(); snap = await f.kernel.status({ squadId });
  assert.equal(snap.slots[0].stage, 'accepted'); assert.equal(f.sent.some(x => x.id === 'anchor'), false);
  assert.deepEqual((await v2StoredRecord(f)).pendingNotices, []);
});

test('C7: the derived stage is the sole precedence for execution, acceptance and warning kind', async t => {
  const { deriveStage } = await import('../gateway/spine/squad-v2-state.mjs');
  const result = status => ({ status, summary: status, assumptions: [], body: '', reportedAt: 1 });
  for (const [activity, status, accepted, expected] of [
    ['active','blocked',true,'running'], ['waiting','done',true,'waiting'], ['failed','done',true,'accepted'], ['offline','escalate',true,'accepted'],
    ['failed','escalate',false,'failed'], ['offline','done',false,'offline'], ['quiescent','done',false,'delivered'], ['quiescent','blocked',false,'blocked'], ['quiescent','escalate',false,'escalated'],
  ]) assert.equal(deriveStage(activity, result(status), accepted), expected);
  assert.equal(deriveStage('quiescent', { ...result('done'), autoSynthesized: true }), 'planned');
  const f = await v2Fixture(t), { squadId } = f;
  const first = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', task: 'Outcome', touches: [] }] });
  await c7Report(f, first.slots[0], 'escalate'); f.threads.get(first.slots[0].threadId).status = { type: 'failed' };
  const snap = await f.kernel.status({ squadId }); assert.equal(snap.slots[0].stage, 'failed'); assert.equal(snap.needsYou[0].kind, 'slot_failed');
});

test("Phase 3 retirement clears pending notices, caches hidden stationary slots, and preserves promotion across redispatch", async t => {
  let reads = [], threads;
  const f = await v2Fixture(t, undefined, { read: async id => {
    reads.push(id);
    return threads?.get(id) ?? { id, cwd: "/tmp", status: { type: "active" } };
  } });
  threads = f.threads;
  const { kernel, squadId } = f;
  const input = { slotId: "worker", task: "Do work", touches: [] };
  const other = { slotId: "archive", task: "Older work", touches: [] };
  const dispatched = await kernel.dispatch({ squadId, slots: [input, other] });
  const worker = dispatched.slots.find(s => s.slotId === input.slotId);
  const archived = dispatched.slots.find(s => s.slotId === other.slotId);
  await c7Report(f, archived, "blocked");
  await kernel.tick();
  const stateFile = path.join(f.root, ".mycodex", "squads-v2", squadId, "state.json");
  assert.ok(JSON.parse(await fs.readFile(stateFile, "utf8")).pendingNotices.some(n => n.slotId === archived.slotId));
  const delivery = { kind: "issue", label: "Issue #12", target: "https://github.com/example/repo/issues/12" };
  const retired = await kernel.state({ squadId, expectedRevision: 1, retireSlots: [archived.slotId], slotDeliverables: { [archived.slotId]: [delivery] } });
  const retiredSlot = retired.slots.find(s => s.slotId === archived.slotId);
  assert.equal(retiredSlot.stage, "superseded");
  assert.equal(retiredSlot.retired, true);
  assert.equal(retiredSlot.deliverables.find(d => d.label === delivery.label)?.href, delivery.target);
  assert.equal(retired.needsYou.some(n => n.slotId === archived.slotId), false);
  assert.equal(JSON.parse(await fs.readFile(stateFile, "utf8")).pendingNotices.some(n => n.slotId === archived.slotId), false);
  f.threads.get(worker.threadId).status = { type: "idle" };
  await kernel.state({ squadId, expectedRevision: 2, acceptSlots: [worker.slotId] });
  reads = [];
  await kernel.listAll();
  await kernel.listAll();
  assert.ok(!reads.includes(archived.threadId));
  assert.ok(!reads.includes(worker.threadId));
  await kernel.promote({ squadId, slotId: worker.slotId });
  const next = await kernel.dispatch({ squadId, expectedRevision: 3, slots: [input], slotDeliverables: { [archived.slotId]: [delivery] } });
  assert.equal(next.slots.find(s => s.slotId === worker.slotId).sidebarHidden, false);
  assert.equal(next.slots.find(s => s.slotId === archived.slotId).deliverables.filter(d => d.label === delivery.label).length, 1);
});

test("Phase 3 close archives clean worktrees, preserves dirty trees, and lists history without Git or host reads", async t => {
  let reads = 0, threads, root;
  const f = await v2Fixture(t, undefined, { read: async id => {
    reads++;
    return threads?.get(id) ?? { id, cwd: root, status: { type: "idle" } };
  } });
  threads = f.threads;
  root = f.root;
  const { git, workspaceDelta } = await import("../gateway/spine/squad-v2-workspace.mjs");
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "squad-test@example.invalid");
  await git(root, "config", "user.name", "Squad Test");
  await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  await fs.writeFile(path.join(root, "tracked.txt"), "base\n");
  await fs.writeFile(path.join(root, "removed.txt"), "base\n");
  await fs.mkdir(path.join(root, "node_modules"));
  await git(root, "add", ".gitignore", "tracked.txt", "removed.txt");
  await git(root, "commit", "-m", "initial");
  const initial = await f.kernel.init({ anchorThreadId: "anchor", forceNew: true, workspace: "worktree" });
  const { squadId } = initial;
  const slots = ["clean", "dirty", "ignored"].map(slotId => ({ slotId, task: "inspect", workspace: "worktree", touches: [] }));
  const running = await f.kernel.dispatch({ squadId, slots });
  const [clean, dirty, ignored] = slots.map(({ slotId }) => running.slots.find(s => s.slotId === slotId));
  await fs.writeFile(path.join(clean.worktreePath, "tracked.txt"), "unmerged delivery\n");
  await fs.writeFile(path.join(clean.worktreePath, "added.txt"), "new line\n");
  await git(clean.worktreePath, "rm", "removed.txt");
  await git(clean.worktreePath, "add", "tracked.txt", "added.txt");
  await git(clean.worktreePath, "commit", "-m", "Keep the unmerged role tip");
  const tip = await git(clean.worktreePath, "rev-parse", "HEAD");
  const priorTrace = process.env.GIT_TRACE;
  const measuredDelta = async (trace, run) => {
    process.env.GIT_TRACE = trace;
    try { return await run(); }
    finally {
      if (priorTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = priorTrace;
    }
  };
  const warmTrace = path.join(root, "warm-git.trace");
  const delta = await measuredDelta(warmTrace, () => workspaceDelta(clean.worktreePath, clean.baseSha, []));
  assert.deepEqual(delta.changed, [
    { path: "added.txt", status: "A", add: 1, del: 0 },
    { path: "removed.txt", status: "D", add: 0, del: 1 },
    { path: "tracked.txt", status: "M", add: 1, del: 1 },
  ]);
  const gitCalls = await fs.readFile(warmTrace, "utf8");
  assert.equal((gitCalls.match(/built-in: git diff /g) ?? []).length, 1);
  assert.doesNotMatch(gitCalls, /built-in: git cat-file/);
  await fs.rm(warmTrace);
  await c7Report(f, clean, "done", "preserved clean receipt");
  for (const slot of [dirty, ignored]) f.threads.get(slot.threadId).status = { type: "idle" };
  await fs.writeFile(path.join(dirty.worktreePath, "tracked.txt"), "uncommitted\n");
  await fs.writeFile(path.join(ignored.worktreePath, "ignored.txt"), "ignored user data\n");
  const closed = await f.kernel.close({ squadId });
  assert.equal(closed.status, "closed");
  assert.equal(closed.slots.find(s => s.slotId === "clean").result.summary, "preserved clean receipt");
  assert.equal(await exists(clean.worktreePath), false);
  assert.equal(await exists(initial.integrationWorktree), false);
  for (const branch of [clean.branch, initial.integrationBranch]) await assert.rejects(git(root, "show-ref", "--verify", "refs/heads/" + branch));
  assert.equal(await git(root, "rev-parse", "refs/mycodex/archive/" + clean.branch), tip);
  const previewUrl = new URL(closed.studioUrl);
  previewUrl.pathname += "/artifact";
  previewUrl.searchParams.set("slotId", clean.slotId);
  previewUrl.searchParams.set("ref", "commit:" + tip);
  assert.match((await (await fetch(previewUrl)).json()).content, /\+unmerged delivery/);
  assert.equal(await fs.readFile(path.join(dirty.worktreePath, "tracked.txt"), "utf8"), "uncommitted\n");
  assert.equal(await fs.readFile(path.join(ignored.worktreePath, "ignored.txt"), "utf8"), "ignored user data\n");
  const traceFile = path.join(root, "cold-git.trace");
  // Leave only the closed record under test in the list.
  await f.kernel.close({ squadId: f.initial.squadId });
  reads = 0;
  const snapshots = await measuredDelta(traceFile, () => f.kernel.listAll());
  assert.equal(snapshots.find(s => s.squadId === squadId).slots.find(s => s.slotId === "clean").activity, "closed");
  assert.equal(reads, 0);
  assert.equal(await exists(traceFile), false);
});

test("Phase 4 scratch dispatch defaults touches and can replace its session", async t => {
  const f = await v2Fixture(t);
  const launch = slot => f.kernel.dispatch({ squadId: f.squadId, slots: [{ slotId: "scratch", task: "Inspect", ...slot }] });
  const first = (await launch({ workspace: "scratch", continuity: "clean" })).slots[0];
  assert.equal(first.readOnly, true);
  assert.deepEqual(first.touches, []);
  assert.equal(path.basename(path.dirname(first.worktreePath)), "scratch");
  f.threads.get(first.threadId).status = { type: "idle" };
  const next = (await launch({ continuity: "stateful", freshSession: true, readOnly: false, model: "different" })).slots[0];
  assert.notEqual(next.threadId, first.threadId);
  assert.equal(next.worktreePath, first.worktreePath);
  assert.equal(next.readOnly, false);
  assert.equal(next.rounds.at(-1).stateRevisionSent, f.initial.state.revision);
});

async function phase4Repository(home, name) {
  const { git } = await import("../gateway/spine/squad-v2-workspace.mjs");
  const source = path.join(home, name);
  await git(home, "init", "-b", "main", source);
  await git(source, "config", "user.name", "Repository fixture");
  await git(source, "config", "user.email", "repository@example.invalid");
  await fs.writeFile(path.join(source, "base.txt"), "repo base\n");
  await git(source, "add", "base.txt");
  await git(source, "commit", "-m", "Repository base");
  return { git, source, base: await git(source, "rev-parse", "HEAD") };
}

test("Phase 4 linked slots merge into one external integration and keep the source checkout intact", async t => {
  const f = await v2Fixture(t);
  const { git, source, base } = await phase4Repository(f.root, "external");
  await git(source, "branch", "review", base);
  await fs.writeFile(path.join(source, "source-only.txt"), "preserve this checkout");
  const before = await git(source, "status", "--porcelain");
  const exclude = path.join(source, ".git", "info", "exclude");
  const originalExclude = await fs.readFile(exclude, "utf8");
  const snap = await f.kernel.dispatch({ squadId: f.squadId, slots: [
    { slotId: "one", task: "Build one", repo: { source, baseRef: "review", branch: "custom-review-builder" } },
    { slotId: "two", task: "Build two", repo: { source: "external" } },
    { slotId: "scratch-clean", task: "Investigate", workspace: "scratch" },
    { slotId: "scratch-dirty", task: "Investigate", workspace: "scratch" },
  ] });
  const [one, two, scratchClean, scratchDirty] = snap.slots;
  const tree = snap.integrations[one.repoKey];
  assert.equal(one.workspace, "worktree");
  assert.equal(one.branch, "custom-review-builder");
  assert.equal(one.baseSha, base);
  assert.equal(two.repoKey, one.repoKey);
  assert.equal(Object.keys(snap.integrations).length, 1);
  assert.equal(snap.integrationWorktree, undefined);
  for (const [slot, name] of [[one, "one"], [two, "two"]]) {
    await fs.writeFile(path.join(slot.worktreePath, name + ".txt"), name + " delivery\n");
    await git(slot.worktreePath, "add", name + ".txt");
    await git(slot.worktreePath, "commit", "-m", name + " delivery");
    f.threads.get(slot.threadId).status = { type: "idle" };
  }
  const tip = await git(two.worktreePath, "rev-parse", "HEAD");
  const endpoint = (route, slot, values) => {
    const url = new URL(snap.studioUrl);
    url.pathname += "/" + route;
    url.searchParams.set("slotId", slot.slotId);
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
    return fetch(url);
  };
  assert.match((await (await endpoint("diff", one, { path: "one.txt" })).json()).diff, /\+one delivery/);
  assert.match((await (await endpoint("artifact", two, { ref: "commit:" + tip })).json()).content, /\+two delivery/);
  assert.equal((await endpoint("artifact", scratchClean, { ref: "commit:" + tip })).status, 409);
  assert.equal((await endpoint("diff", scratchClean, { path: "one.txt" })).status, 409);
  let revision = snap.state.revision;
  for (const slot of [one, two]) {
    const merged = await f.kernel.integrate({ squadId: f.squadId, expectedRevision: revision, slotId: slot.slotId });
    assert.equal(merged.delta.dirtyCount, 0);
    revision = merged.snapshot.state.revision;
  }
  assert.equal(await fs.readFile(path.join(tree.worktreePath, "one.txt"), "utf8"), "one delivery\n");
  assert.equal(await fs.readFile(path.join(tree.worktreePath, "two.txt"), "utf8"), "two delivery\n");
  const integrationTip = await git(tree.worktreePath, "rev-parse", "HEAD");
  assert.equal(await git(source, "rev-parse", "HEAD"), base);
  assert.equal(await git(source, "status", "--porcelain"), before);
  assert.equal(await fs.readFile(exclude, "utf8"), originalExclude);
  for (const slot of [scratchClean, scratchDirty]) f.threads.get(slot.threadId).status = { type: "idle" };
  await fs.writeFile(path.join(scratchDirty.worktreePath, "user-data.txt"), "keep scratch");
  await f.kernel.close({ squadId: f.squadId });
  for (const dir of [one.worktreePath, two.worktreePath, tree.worktreePath, scratchClean.worktreePath]) assert.equal(await exists(dir), false, dir);
  assert.equal(await fs.readFile(path.join(scratchDirty.worktreePath, "user-data.txt"), "utf8"), "keep scratch");
  assert.equal(await git(source, "rev-parse", "refs/mycodex/archive/" + tree.branch), integrationTip);
  assert.equal((await endpoint("artifact", two, { ref: "commit:" + tip })).status, 200);
});

test("Phase 4 file transport shares one bare cache and fetches a newer base without moving remote refs", async t => {
  const { pathToFileURL } = await import("node:url");
  const f = await v2Fixture(t);
  const { git, source } = await phase4Repository(f.root, "upstream");
  const bare = path.join(f.root, "upstream.git");
  await git(f.root, "clone", "--bare", source, bare);
  const repo = { source: pathToFileURL(bare).href, baseRef: "refs/heads/main" };
  const launch = slotId => f.kernel.dispatch({ squadId: f.squadId, slots: [{ slotId, task: "Fetch fixture", repo }] });
  const one = (await launch("one")).slots[0];
  await fs.writeFile(path.join(source, "advanced.txt"), "remote moved\n");
  await git(source, "add", "advanced.txt");
  await git(source, "commit", "-m", "Advance upstream");
  await git(source, "push", bare, "main");
  const advanced = await git(source, "rev-parse", "HEAD");
  const snap = await launch("two"), two = snap.slots[1];
  assert.equal(two.repoKey, one.repoKey);
  assert.equal(two.baseSha, advanced);
  assert.equal(await fs.readFile(path.join(two.worktreePath, "advanced.txt"), "utf8"), "remote moved\n");
  const cache = path.join(f.root, ".mycodex", ".repo-cache");
  const [entry, ...others] = await fs.readdir(cache);
  assert.match(entry, /^[a-f0-9]{64}\.git$/);
  assert.deepEqual(others, []);
  assert.equal(await git(path.join(cache, entry), "rev-parse", "--is-bare-repository"), "true");
  assert.equal(await git(bare, "for-each-ref", "--format=%(refname)"), "refs/heads/main");
  f.threads.get(one.threadId).status = { type: "idle" };
  f.threads.get(two.threadId).status = { type: "idle" };
  await f.kernel.close({ squadId: f.squadId });
  assert.equal(await exists(path.join(cache, entry)), true);
  assert.equal(await exists(two.worktreePath), false);
});

test("Phase 4 delivery checker and notice reflect staged, unstaged and forbidden changes", async t => {
  const { promisify } = await import("node:util"), { execFile } = await import("node:child_process");
  const f = await v2Fixture(t);
  const { git, source } = await phase4Repository(f.root, "ledger-repo");
  await fs.mkdir(path.join(source, "private"));
  await fs.writeFile(path.join(source, "private", "settings.txt"), "protected base\n");
  await git(source, "add", "private/settings.txt");
  await git(source, "commit", "-m", "Add protected fixture");
  const snap = await f.kernel.dispatch({ squadId: f.squadId, slots: [
    { slotId: "reviewer", task: "Complete feature", repo: { source }, forbid: ["private/**/*.txt"],
      inputs: ["ticket-42"], artifacts: ["ticket-42", "artifact-reference"], criteriaIds: ["C1"] },
  ] });
  const slot = snap.slots[0], cwd = slot.worktreePath;
  const checkPath = path.join(cwd, ".mycodex", "check-delivery.mjs");
  const check = () => promisify(execFile)(process.execPath, [checkPath], { cwd: f.root });
  assert.deepEqual(slot.rounds[0].inputs, ["ticket-42", "artifact-reference"]);
  assert.equal(slot.rounds[0].stateRevisionSent, snap.state.revision);
  await assert.rejects(check(), error => error.code === 1 && /result\.md: missing/.test(error.stderr));
  await c7Report(f, slot);
  assert.match((await check()).stdout, /Delivery ready/);
  await fs.writeFile(path.join(cwd, "private", "settings.txt"), "staged\n");
  await git(cwd, "add", "private/settings.txt");
  await fs.writeFile(path.join(cwd, "private", "settings.txt"), "protected base\n");
  await fs.writeFile(path.join(cwd, "new-untracked.txt"), "one path\n");
  const live = await f.kernel.status({ squadId: f.squadId });
  assert.equal(live.slots[0].delta.dirtyCount, 2);
  assert.deepEqual(live.slots[0].delta.forbidViolations, ["private/settings.txt"]);
  assert.deepEqual(live.slots[0].delta.outsideTouches, []);
  assert.ok(live.needsYou.some(item => item.slotId === slot.slotId && item.detail.includes("private/settings.txt")));
  await assert.rejects(check(), error => error.code === 1 && /2 uncommitted/.test(error.stderr) && /Forbidden paths/.test(error.stderr));
  await assert.rejects(f.kernel.integrate({ squadId: f.squadId, expectedRevision: snap.state.revision, slotId: slot.slotId }), /Forbidden paths/);
  f.threads.get("anchor").status = { type: "idle" };
  await f.kernel.tick();
  const notice = f.sent.find(message => message.text.startsWith("[Squad Notice] "));
  const event = JSON.parse(notice.text.slice("[Squad Notice] ".length)).events.find(event => event.slotId === slot.slotId);
  const bill = JSON.parse(event.summary);
  assert.equal(bill.repoSource, await fs.realpath(source));
  assert.equal(bill.branch, slot.branch);
  assert.equal(bill.headSha, await git(cwd, "rev-parse", "HEAD"));
  assert.equal(bill.commitCount, 0);
  assert.equal(bill.changedCount, live.slots[0].delta.changed.length);
  assert.equal(bill.dirtyCount, 2);
  assert.deepEqual(bill.forbidViolations, ["private/settings.txt"]);
  assert.ok(bill.deliverables.some(item => item.kind === "mr"));
  // A forbidden commit remains forbidden even if a later commit restores it.
  await git(cwd, "commit", "-m", "Temporarily edited the forbidden path");
  await git(cwd, "add", "private/settings.txt");
  await git(cwd, "commit", "-m", "Restore the original bytes");
  await fs.rm(path.join(cwd, "new-untracked.txt"));
  const restored = (await f.kernel.status({ squadId: f.squadId })).slots[0].delta;
  assert.equal(restored.dirtyCount, 0);
  assert.deepEqual(restored.forbidViolations, ["private/settings.txt"]);
  await assert.rejects(check(), error => error.code === 1 && /Forbidden paths/.test(error.stderr));
});

test("Phase 4 bare sources initialize submodules and preserve nested dirty work on close", async t => {
  const f = await v2Fixture(t);
  const { git, source } = await phase4Repository(f.root, "parent");
  const { source: child } = await phase4Repository(f.root, "child");
  await git(source, "-c", "protocol.file.allow=always", "submodule", "add", child, "vendor/module");
  await git(source, "commit", "-am", "Track submodule");
  const bare = path.join(f.root, "parent.git");
  await git(f.root, "clone", "--bare", source, bare);
  const inheritedParameters = process.env.GIT_CONFIG_PARAMETERS;
  process.env.GIT_CONFIG_PARAMETERS = "'protocol.file.allow'='always'";
  let snap;
  try {
    snap = await f.kernel.dispatch({ squadId: f.squadId, slots: ["initialized", "dirty", "uninitialized"].map(slotId => ({
      slotId, task: "Inspect submodule", repo: { source: bare, submodules: slotId !== "uninitialized" },
    })) });
  } finally {
    if (inheritedParameters === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
    else process.env.GIT_CONFIG_PARAMETERS = inheritedParameters;
  }
  const [clean, dirty, empty] = snap.slots;
  assert.equal(await fs.readFile(path.join(clean.worktreePath, "vendor/module/base.txt"), "utf8"), "repo base\n");
  assert.equal(await exists(path.join(empty.worktreePath, "vendor/module/base.txt")), false);
  await fs.writeFile(path.join(dirty.worktreePath, "vendor/module/local.txt"), "keep this submodule data");
  for (const slot of snap.slots) f.threads.get(slot.threadId).status = { type: "idle" };
  await f.kernel.close({ squadId: f.squadId });
  assert.equal(await exists(clean.worktreePath), false);
  assert.equal(await exists(empty.worktreePath), false);
  assert.equal(await fs.readFile(path.join(dirty.worktreePath, "vendor/module/local.txt"), "utf8"), "keep this submodule data");
  const roles = path.dirname(clean.worktreePath);
  const [archive] = (await fs.readdir(roles)).filter(name => name.startsWith(".submodules-"));
  assert.ok(archive);
  assert.equal(await fs.readFile(path.join(roles, archive, "checkouts/vendor/module/base.txt"), "utf8"), "repo base\n");
});
