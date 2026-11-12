import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import { HistoryManager } from "../tools/history/manager.mjs";
import { codexBackend } from "../tools/history/backends.mjs";
import { SessionManagement } from "../bridge/session-management.mjs";
import { SessionResultStore, SESSION_RESULT_LIFETIME_MS } from "../bridge/session-result-store.mjs";
import { createSessionApi } from "../bridge/session-management-api.mjs";
import { protectCliBackend } from "../bridge/cli-session-ownership.mjs";
import {
  buildDesktopSessionsPatch, desktopDeletionAcknowledged,
  desktopSessionRequestError, desktopSessionApplyRejected, buildDesktopSessionMetadataPatch,
} from "../bridge/desktop-sessions.mjs";
import { desktopSessionText } from "../bridge/desktop-session-locale.mjs";

function fixture(t, count = 3) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-session-result-"));
  t.after(async () => {
    assert.equal(path.dirname(fs.realpathSync(home)), fs.realpathSync(os.tmpdir()));
    assert(path.basename(home).startsWith("ccodex-session-result-"));
    await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  let now = Date.now(), scans = 0, reads = 0;
  const rows = Array.from({ length: count }, () => ({
    id: randomUUID(), title: "Synthetic result test", cwd: "fixture",
    archived: false, remote: false, inUse: false,
    createdAt: new Date(now).toISOString(), modifiedAt: new Date(now).toISOString(),
    operations: ["delete", "archive"],
  }));
  const calls = [];
  const backend = {
    home,
    list: async () => { scans++; return rows; },
    get: async id => { reads++; return rows.find(row => row.id === id) || null; },
    async mutate(operation, id) {
      calls.push({ operation, id });
      now += 31 * 60_000;
      if (operation === "delete") rows.splice(rows.findIndex(row => row.id === id), 1);
      else {
        const row = rows.find(row => row.id === id);
        row.archived = operation === "archive";
        row.operations = ["delete", row.archived ? "unarchive" : "archive"];
      }
    },
  };
  const manager = new HistoryManager({ ccodex: backend }, { now: () => now });
  const factory = async () => ({ manager, close() {} });
  const service = new SessionManagement({ home, now: () => now, managerFactory: factory });
  const clientId = randomUUID();
  const request = (operation, args) => service.request(operation, { ...args, clientId });
  return { home, rows, calls, manager, service, request, factory, clientId,
    now: () => now, advance: ms => { now += ms; },
    get scans() { return scans; }, get reads() { return reads; } };
}

async function execute(f) {
  const preview = await f.request("preview", { operation: "delete", all: true });
  await f.request("apply", { planId: preview.id, confirmation: preview.confirmation,
    deletionAcknowledgement: preview.deletionAcknowledgement });
  await f.service.jobs.get(preview.id).work;
  return preview;
}

test("a batch lasting more than 30 minutes keeps progress and starts result expiry only after completion", async t => {
  const f = fixture(t);
  const preview = await execute(f);
  const finishedAt = f.now();
  const done = await f.request("progress", { planId: preview.id });
  assert.equal(done.completed, 3);
  assert.equal(done.done, true);
  assert.equal(f.calls.length, 3);
  assert.equal(f.reads, 3);
  assert.equal(f.scans, 2, "One explicit selection scan and one preview scan, not a whole-history scan for every delete");
  assert.equal(Date.parse(done.expiresAt), finishedAt + SESSION_RESULT_LIFETIME_MS);
  f.advance(2 * 60 * 60_000);
  const later = await f.request("progress", { planId: preview.id.slice(0, 8) });
  assert.equal(later.completed, 3);
  assert.equal(later.results.length, 3);
  assert.equal(later.error, undefined);
});

test("completed batch results survive service recreation and cannot be replayed or read by another client", async t => {
  const f = fixture(t);
  const preview = await execute(f);
  const replacement = new SessionManagement({
    home: f.home, now: f.now,
    managerFactory: async () => { assert.fail("Reading a saved result does not need a native history process"); },
  });
  const saved = await replacement.request("progress", { clientId: f.clientId, planId: preview.id.slice(0, 8) });
  assert.equal(saved.restoredFromJournal, true);
  assert.equal(saved.completed, 3);
  assert(saved.results.every(row => row.status === "complete"));
  assert.equal(saved.interrupted, undefined);
  await assert.rejects(replacement.request("progress", { clientId: randomUUID(), planId: preview.id }),
    error => error.code === "execution_unavailable");
  const journal = new SessionResultStore(f.home, { now: f.now });
  const record = journal.read(preview.id, f.clientId);
  assert.throws(() => journal.write(record, { create: true }), error => error.code === "plan_consumed");
  assert.equal(f.calls.length, 3);
  await replacement.close();
});

test("a saved partial checkpoint is explicitly interrupted, never falsely complete or auto-replayed", async t => {
  const f = fixture(t);
  const id = randomUUID(), keys = f.rows.map(row => "ccodex:" + row.id);
  const time = new Date(f.now()).toISOString();
  const store = new SessionResultStore(f.home, { now: f.now });
  store.write({
    schemaVersion: 1, kind: "ccodex-session-batch-result", clientId: f.clientId,
    planId: id, operation: "delete", keys, total: keys.length,
    results: [{ key: keys[0], status: "complete" }], done: false,
    acceptedAt: time, updatedAt: time, expiresAt: null,
  }, { create: true });
  const recovered = await f.request("progress", { planId: id });
  assert.equal(recovered.interrupted, true);
  assert.equal(recovered.completed, 1);
  assert.match(recovered.error, /final status cannot be confirmed/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.scans, 0);
});

test("result pruning removes only expired completed receipts, not pending checkpoints or unrelated files", async t => {
  const f = fixture(t);
  const preview = await execute(f);
  const store = new SessionResultStore(f.home, { now: f.now });
  const record = store.read(preview.id, f.clientId);
  const pendingId = randomUUID();
  store.write({ ...record, planId: pendingId, results: [], done: false, expiresAt: null }, { create: true });
  fs.writeFileSync(path.join(store.directory, "unrelated.txt"), "Keep me");
  f.advance(SESSION_RESULT_LIFETIME_MS + 1);
  store.prune();
  assert.equal(fs.existsSync(store.file(preview.id)), false);
  assert(store.read(pendingId, f.clientId));
  assert.equal(fs.readFileSync(path.join(store.directory, "unrelated.txt"), "utf8"), "Keep me");
});

test("a rejected receipt write stops before any mutation and preserves the preview", async t => {
  const f = fixture(t);
  f.service.resultsStore = { prune() {}, write() {
    throw Object.assign(new Error("Synthetic receipt write refused"), { code: "result_store_unavailable" });
  } };
  const preview = await f.request("preview", { operation: "delete", all: true });
  await assert.rejects(f.request("apply", { planId: preview.id, confirmation: preview.confirmation,
    deletionAcknowledgement: preview.deletionAcknowledgement }), /receipt write refused/);
  assert(f.service.previews.has(preview.id));
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.backgroundJobs, 0);
});

test("read-only reconciliation reports exact current states without mutating or guessing a result", async t => {
  const f = fixture(t);
  const absent = "ccodex:" + randomUUID();
  const keys = [absent, ...f.rows.map(row => "ccodex:" + row.id)];
  f.rows[0].archived = true;
  const deleted = await f.request("reconcile", { operation: "delete", keys });
  assert.equal(deleted.readOnly, true);
  assert.deepEqual(deleted.results.map(row => row.status), ["absent", "present", "present", "present"]);
  const archived = await f.request("reconcile", { operation: "archive", keys });
  assert.deepEqual(archived.results.map(row => row.status), ["absent", "matches", "present", "present"]);
  assert.equal(f.calls.length, 0);
  for (const args of [{ operation: "rename", keys }, { operation: "delete", keys: [] },
    { operation: "delete", keys: [keys[0], keys[0]] }, { operation: "delete", keys: ["../history"] }]) {
    await assert.rejects(f.request("reconcile", args), error => error.code === "invalid_selection");
  }
  f.service.jobs.set(randomUUID(), { done: false });
  await assert.rejects(f.request("reconcile", { operation: "delete", keys }),
    error => error.code === "batch_busy");
});

test("result journal refuses linked directories, malformed receipt identities and changed ownership", async t => {
  const f = fixture(t);
  const preview = await execute(f);
  const store = new SessionResultStore(f.home, { now: f.now });
  const record = store.read(preview.id, f.clientId);
  assert.throws(() => store.write({ ...record, clientId: randomUUID() }), /changed ownership/);
  assert.throws(() => store.write({ ...record, keys: ["ccodex:" + randomUUID()] }), /invalid session batch/);
  const linkedHome = path.join(f.home, "linked-profile"), outside = path.join(f.home, "outside");
  fs.mkdirSync(linkedHome);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(linkedHome, "session-batch-results"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => new SessionResultStore(linkedHome).prune(), /private regular directory/);
});

test("native per-ID reads are fresh and preserve archived state and writer ownership", async () => {
  const id = randomUUID(), parent = randomUUID(), calls = [];
  let active = false;
  const backend = await codexBackend({
    home: fs.realpathSync(os.tmpdir()), nativeWriterLocks: true,
    checkWriters: async (_home, ids) => {
      assert.deepEqual(ids, [id]);
      return { [id]: active };
    },
    rpc: { close() {}, async request(method, params) {
      calls.push({ method, params });
      assert.equal(method, "thread/list");
      assert.equal(params.useStateDbOnly, true);
      return { data: params.archived ? [{ id, name: "Synthetic",
        createdAt: 100, updatedAt: 200, cwd: "project",
        source: { subAgent: { thread_spawn: { parent_thread_id: parent } } } }] : [], nextCursor: null };
    } },
  });
  const idle = await backend.get(id);
  assert.equal(idle.inUse, false);
  assert.equal(idle.archived, true);
  assert.equal(idle.parentId, parent);
  assert.deepEqual(idle.operations, ["delete", "unarchive", "rename"]);
  active = true;
  assert.equal((await backend.get(id)).inUse, true);
  assert.equal(calls.length, 4);
});

test("native per-ID readers reject mismatched IDs and errors instead of scanning or assuming safety", async () => {
  const id = randomUUID();
  const create = reply => codexBackend({
    home: fs.realpathSync(os.tmpdir()), nativeWriterLocks: true,
    checkWriters: async () => ({}), rpc: { close() {}, request: reply },
  });
  const mismatched = await create(async () => ({ data: [{ id: randomUUID() }], nextCursor: null }));
  assert.equal(await mismatched.get(id), null);
  const missing = await create(async () => ({ data: [], nextCursor: null }));
  assert.equal(await missing.get(id), null);
  const timeout = await create(async () => {
    throw Object.assign(new Error("native metadata timed out"), { code: "native_timeout" });
  });
  await assert.rejects(timeout.get(id), error => error.code === "native_timeout");
});

test("per-ID CLI ownership protection remains fail-closed without a full list scan", async () => {
  const id = randomUUID();
  let unknown = false, active = false;
  const backend = protectCliBackend({
    get: async () => ({ id, inUse: false }), list: () => assert.fail("Do not rescan the list"),
    mutate() {},
  }, "fixture", async () => ({ active: new Set(active ? [id] : []), unknown }));
  assert.equal((await backend.get(id)).inUse, false);
  unknown = true;
  assert.equal((await backend.get(id)).inUse, null);
  active = true;
  assert.equal((await backend.get(id)).inUse, true);
});

const source = buildDesktopSessionsPatch();

test("Desktop transport preserves typed error codes so rejected applies are not stranded as pending", () => {
  const rejected = desktopSessionRequestError({ code: "preview_required", error: "Expired preview" });
  assert.equal(rejected.code, "preview_required");
  assert.equal(desktopSessionApplyRejected(rejected), true);
  assert.equal(desktopSessionApplyRejected(new Error("Uncertain response")), false);
  assert.equal(desktopSessionApplyRejected({ code: "native_timeout" }), false);
});

function recoveryUi() {
  const id = randomUUID(), key = "ccodex:" + randomUUID();
  const nodes = new Map();
  const find = name => {
    if (!nodes.has(name)) nodes.set(name, {});
    return nodes.get(name);
  };
  const calls = [], statuses = [];
  const context = vm.createContext({
    pendingPlan: id, preview: { id, operation: "delete", entries: [{ key }] },
    applying: false, disposed: false, cursor: 100,
    selection: new Map([[key, { key }]]), find,
    async request(operation, args) {
      calls.push({ operation, args });
      if (operation === "progress") throw desktopSessionRequestError({
        code: "execution_unavailable", error: "This batch result is unavailable for this client.",
      });
      assert.equal(operation, "reconcile");
      return { readOnly: true, operation: "delete", results: [{ key, status: "absent" }] };
    },
    leavePreview() { context.preview = null; },
    controls() {}, async load() {},
    status: message => statuses.push(message),
    refreshNativeHistory() {}, setTimeout,
  });
  const check = source.match(/async function checkResults\(\) \{[\s\S]*?\n  \}/)?.[0];
  const reconcile = source.match(/async function reconcilePending\(\) \{[\s\S]*?\n  \}/)?.[0];
  assert(check && reconcile);
  vm.runInContext(reconcile + "\n" + check, context);
  return { context, calls, nodes, statuses, key };
}

test("an unavailable Desktop result reconciles exact IDs, releases the pending state and never replays", async () => {
  const ui = recoveryUi();
  await vm.runInContext("checkResults()", ui.context);
  assert.deepEqual(ui.calls.map(row => row.operation), ["progress", "reconcile"]);
  assert.equal(ui.calls[1].args.keys[0], ui.key);
  assert.equal(ui.context.pendingPlan, null);
  assert.equal(ui.context.preview, null);
  assert.equal(ui.context.selection.size, 0);
  assert.equal(ui.context.cursor, 0);
  assert.equal(ui.context.applying, false);
  assert.match(ui.statuses.at(-1), /1 absent.*Nothing was replayed/);
});

test("failed reconciliation retains uncertain state and does not call apply or falsely claim completion", async () => {
  const ui = recoveryUi();
  ui.context.request = async operation => {
    ui.calls.push({ operation });
    throw Object.assign(new Error(operation === "progress" ? "Unavailable result" : "Synthetic read timeout"),
      { code: operation === "progress" ? "execution_unavailable" : "native_timeout" });
  };
  await vm.runInContext("checkResults()", ui.context);
  assert.deepEqual(ui.calls.map(row => row.operation), ["progress", "reconcile"]);
  assert(ui.context.pendingPlan);
  assert(ui.context.preview);
  assert.equal(ui.context.selection.size, 1);
  assert.match(ui.statuses.at(-1), /read timeout.*\nNothing was replayed/);
});

test("cancel is hidden and blocked after apply dispatch rather than claiming no changes", () => {
  const action = name => ({});
  const context = vm.createContext({
    action, applying: false, pendingPlan: randomUUID(),
    leavePreview() { assert.fail("A sent batch cannot be cancelled as an unconfirmed preview"); },
    status() { assert.fail("Do not say no sessions changed after dispatch"); },
  });
  const handlers = new Map();
  context.action = name => {
    if (!handlers.has(name)) handlers.set(name, {});
    return handlers.get(name);
  };
  const cancel = source.match(/action\("cancel"\)\.onclick = \(\) => \{[\s\S]*?\n  \};/)?.[0];
  assert(cancel);
  vm.runInContext(cancel, context);
  handlers.get("cancel").onclick();
  assert.match(source, /action\("cancel"\)\.disabled = applying \|\| !!pendingPlan/);
  assert.match(source, /action\("apply"\)\.hidden = !!pendingPlan/);
});

test("Desktop rejection before acceptance clears pending but uncertain transport errors preserve it", async () => {
  const handler = source.match(/action\("apply"\)\.onclick = async \(\) => \{[\s\S]*?\n  \};/)?.[0];
  assert(handler);
  for (const code of ["preview_required", "native_timeout"]) {
    const id = randomUUID(), preview = { id, operation: "archive", entries: [{ eligible: true }], confirmation: "exact" };
    const actions = new Map(), statuses = [];
    const context = vm.createContext({
      preview, loading: false, applying: false, pendingPlan: null,
      action: name => {
        if (!actions.has(name)) actions.set(name, {});
        return actions.get(name);
      },
      field: () => ({ value: "" }), controls() {},
      desktopDeletionAcknowledged, desktopSessionApplyRejected,
      request: async () => { throw Object.assign(new Error("Synthetic failure"), { code }); },
      leavePreview() { context.preview = null; },
      status: text => statuses.push(text),
      checkResults() { assert.fail("A rejected or uncertain dispatch is not a confirmed result"); },
    });
    vm.runInContext(handler, context);
    await actions.get("apply").onclick();
    assert.equal(context.pendingPlan, code === "preview_required" ? null : id);
    assert.equal(context.preview, code === "preview_required" ? null : preview);
    assert.equal(context.applying, false);
    assert.match(statuses[0], code === "preview_required" ? /not accepted/ : /do not apply.*again/);
  }
});

test("the private HTTP API permits read-only reconcile and preserves exact transport arguments", async t => {
  const f = fixture(t), port = 22690, instanceId = randomUUID(), token = "a".repeat(43);
  fs.writeFileSync(path.join(f.home, `bridge-control-${port}.json`), JSON.stringify({ pid: 123, instanceId, token }));
  fs.writeFileSync(path.join(f.home, `bridge-${port}.json`), JSON.stringify({ pid: 123, port, runtime: { instanceId } }));
  const args = { operation: "delete", clientId: f.clientId, keys: ["ccodex:" + f.rows[0].id] };
  const api = createSessionApi({ home: f.home, port, request: async (url, options) => {
    assert.equal(url, "http://127.0.0.1:22690/sessions/reconcile");
    assert.equal(options.headers["x-codex-copilot-control"], token);
    assert.deepEqual(JSON.parse(options.body), args);
    return { ok: true, json: async () => ({ readOnly: true }) };
  } });
  assert.equal((await api("reconcile", args)).readOnly, true);
});

test("recovered state is clearly localized without labelling inferred absence as an execution receipt", () => {
  const message = desktopSessionText("Current history verified: 281 absent; 0 in target state; 0 remaining. The old execution result is unavailable. Nothing was replayed.");
  assert.match(message, /281.*\u5df2\u4e0d\u5b58\u5728/);
  assert.match(message, /\u539f\u6267\u884c\u8bb0\u5f55.*\u4e0d\u53ef\u7528/);
  assert.match(message, /\u6ca1\u6709\u91cd\u590d\u6267\u884c/);
});

test("verified absent metadata is removed from the local sidebar without replay or loaded-thread cleanup", () => {
  const removed = randomUUID(), loaded = randomUUID(), untouched = randomUUID();
  const summaries = new Map([removed, loaded, untouched].map(id => [id, { conversationId: id }]));
  const calls = [];
  const manager = {
    getHostId: () => "local",
    getThreadSummary: id => summaries.get(id),
    getConversation: id => id === loaded ? { id } : null,
    threadStore: { removeThreadSummary(id) { calls.push(id); summaries.delete(id); } },
    handleThreadDeletion() { assert.fail("Metadata refresh must not execute lifecycle deletion callbacks"); },
    sendRequest() { assert.fail("No native delete is sent during metadata refresh"); },
  };
  const root = { memoizedProps: { manager } };
  const context = vm.createContext({ __codexRoot: { _internalRoot: { current: root } } });
  const patch = buildDesktopSessionMetadataPatch("delete", [
    { key: "ccodex:" + removed, status: "absent" },
    { key: "ccodex:" + loaded, status: "absent" },
  ]);
  const result = vm.runInContext(patch, context);
  assert.equal(result.pruned, 1);
  assert.deepEqual(calls, [removed]);
  assert(summaries.has(loaded) && summaries.has(untouched));
  assert.doesNotMatch(patch, /thread\/delete|handleThreadDeletion\(|evictConversation\(/);
});

test("sidebar metadata refresh refuses uncertain results, remote managers and invalid or duplicate IDs", () => {
  const id = randomUUID();
  const remote = { getHostId: () => "remote", getThreadSummary: () => ({}), getConversation: () => null,
    threadStore: { removeThreadSummary() { assert.fail("Never modify a remote sidebar"); } } };
  const context = vm.createContext({
    __codexRoot: { _internalRoot: { current: { memoizedProps: { manager: remote } } } },
  });
  for (const results of [
    [{ key: "ccodex:" + id, status: "failed" }],
    [{ key: "../history", status: "absent" }],
    [{ key: "ccodex:" + id, status: "absent" }, { key: "ccodex:" + id, status: "absent" }],
    [{ key: "ccodex:" + id, status: "absent" }],
  ]) assert.equal(vm.runInContext(buildDesktopSessionMetadataPatch("delete", results), context).pruned, 0);
  assert.equal(vm.runInContext(buildDesktopSessionMetadataPatch("unarchive",
    [{ key: "ccodex:" + id, status: "complete" }]), context).pruned, 0);
});

function sidebarFixture() {
  const id = randomUUID(), active = randomUUID(), remote = randomUUID();
  const rows = [[id, "local", "false"], [active, "local", "true"], [remote, "remote", "false"]]
    .map(([id, host, active]) => {
      const attributes = new Map([
        ["data-app-action-sidebar-thread-id", "local:" + id],
        ["data-app-action-sidebar-thread-host-id", host],
        ["data-app-action-sidebar-thread-active", active],
      ]);
      return { attributes, getAttribute: name => attributes.get(name) || null,
        hasAttribute: name => attributes.has(name),
        setAttribute: (name, value) => attributes.set(name, value),
        removeAttribute: name => attributes.delete(name) };
    });
  const styles = [], observers = [];
  const context = vm.createContext({
    document: {
      body: {}, head: { append: style => styles.push(style) },
      createElement: () => ({}), querySelectorAll: () => rows,
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
    },
  });
  return { id, active, remote, rows, styles, observers, context };
}

test("deleted sidebar rows hide by verified identity, never hide active or remote rows, and survive redraw", () => {
  const ui = sidebarFixture();
  const patch = buildDesktopSessionMetadataPatch("delete",
    [ui.id, ui.active, ui.remote].map(id => ({ key: "ccodex:" + id, status: "absent" })));
  assert.equal(vm.runInContext(patch, ui.context).hidden, 1);
  assert.equal(ui.rows[0].getAttribute("data-ccodex-history-removed"), "true");
  assert.equal(ui.rows[1].getAttribute("data-ccodex-history-removed"), null);
  assert.equal(ui.rows[2].getAttribute("data-ccodex-history-removed"), null);
  ui.rows[0].removeAttribute("data-ccodex-history-removed");
  ui.observers[0].callback();
  assert.equal(ui.rows[0].getAttribute("data-ccodex-history-removed"), "true");
  vm.runInContext(patch, ui.context);
  assert.equal(ui.styles.length, 1);
  assert.equal(ui.observers.length, 1);
});

test("restored history removes only its own sidebar display tombstone", () => {
  const ui = sidebarFixture();
  vm.runInContext(buildDesktopSessionMetadataPatch("archive",
    [{ key: "ccodex:" + ui.id, status: "complete" }]), ui.context);
  assert.equal(ui.rows[0].getAttribute("data-ccodex-history-removed"), "true");
  vm.runInContext(buildDesktopSessionMetadataPatch("unarchive",
    [{ key: "ccodex:" + ui.id, status: "complete" }]), ui.context);
  assert.equal(ui.rows[0].getAttribute("data-ccodex-history-removed"), null);
  assert.equal(ui.context.__codexCopilotSessionMetadataV1.removed.size, 0);
});
