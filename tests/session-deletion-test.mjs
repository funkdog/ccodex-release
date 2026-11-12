import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import { HistoryManager } from "../tools/history/manager.mjs";
import { codexBackend } from "../tools/history/backends.mjs";
import { SessionManagement } from "../bridge/session-management.mjs";
import { parseSessionsArguments, runSessions } from "../bridge/sessions-cli.mjs";
import {
  buildDesktopSessionsPatch, desktopDeletionAcknowledged, validDesktopSessionTransfer,
} from "../bridge/desktop-sessions.mjs";
import { desktopSessionText } from "../bridge/desktop-session-locale.mjs";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { localShellCommand } = require("../bin/ccodex-local-command.cjs");

function fixture(count = 3) {
  let now = Date.now();
  const rows = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(), title: `Delete fixture ${index}`, cwd: "synthetic",
    archived: false, remote: false, inUse: false, parentId: null,
    createdAt: new Date(now - index * 1000).toISOString(),
    modifiedAt: new Date(now - index * 1000).toISOString(),
    operations: ["delete", "archive"],
  }));
  const calls = [];
  const backend = {
    home: "synthetic",
    list: async () => rows,
    async mutate(operation, id) {
      calls.push({ operation, id });
      const index = rows.findIndex(row => row.id === id);
      const row = rows[index];
      if (row.fail) throw new Error("Synthetic delete failure");
      if (operation === "delete") rows.splice(index, 1);
      else {
        row.archived = operation === "archive";
        row.operations = ["delete", row.archived ? "unarchive" : "archive"];
      }
    },
  };
  const manager = new HistoryManager({ ccodex: backend }, { now: () => now });
  const service = new SessionManagement({
    now: () => now, managerFactory: async () => ({ manager, close() {} }),
  });
  const clientId = randomUUID();
  const api = (operation, args) => service.request(operation, { ...args, clientId });
  const key = row => "ccodex:" + row.id;
  return { rows, calls, manager, service, api, clientId, key, advance: ms => { now += ms; } };
}

async function apply(f, plan) {
  await f.api("apply", {
    planId: plan.id, confirmation: plan.confirmation,
    ...(plan.operation === "delete" ? { deletionAcknowledgement: plan.deletionAcknowledgement } : {}),
  });
  await f.service.jobs.get(plan.id).work;
  return f.api("progress", { planId: plan.id });
}

test("permanent delete preview changes nothing and requires both exact confirmations", async () => {
  const f = fixture();
  const id = f.rows[0].id;
  const plan = await f.api("preview", { operation: "delete", keys: [f.key(f.rows[0])] });
  assert.equal(plan.irreversible, true);
  assert.equal(plan.deletionAcknowledgement, `DELETE 1 ${plan.id.slice(0, 8)}`);
  assert.equal(f.calls.length, 0);
  const args = { planId: plan.id, confirmation: plan.confirmation };
  for (const deletionAcknowledgement of [
    undefined, "", "yes", `DELETE 3 ${plan.id.slice(0, 8)}`,
    `DELETE 1 ${randomUUID().slice(0, 8)}`, plan.deletionAcknowledgement + " ",
  ]) {
    await assert.rejects(f.api("apply", { ...args, deletionAcknowledgement }),
      error => error.code === "deletion_acknowledgement_required");
    assert(f.service.previews.has(plan.id), "A rejected acknowledgement must not consume the preview");
    assert.equal(f.calls.length, 0);
  }
  await assert.rejects(f.api("apply", {
    ...args, confirmation: "wrong", deletionAcknowledgement: plan.deletionAcknowledgement,
  }), error => error.code === "confirmation_required");
  const done = await apply(f, plan);
  assert.equal(done.operation, "delete");
  assert.equal(done.results[0].status, "complete");
  assert.deepEqual(f.calls, [{ operation: "delete", id }]);
  assert(!f.rows.some(row => row.id === id));
});

test("delete previews are client-scoped, expire, and cannot be applied twice", async () => {
  const f = fixture();
  const plan = await f.api("preview", { operation: "delete", keys: [f.key(f.rows[0])] });
  const args = { planId: plan.id, confirmation: plan.confirmation,
    deletionAcknowledgement: plan.deletionAcknowledgement };
  await assert.rejects(f.service.request("apply", { ...args, clientId: randomUUID() }),
    error => error.code === "preview_required");
  assert.equal(f.calls.length, 0);
  await f.api("apply", { ...args, planId: plan.id.slice(0, 8) });
  await f.service.jobs.get(plan.id).work;
  await assert.rejects(f.api("apply", args), error => error.code === "preview_required");
  assert.equal(f.calls.length, 1);
  const expired = await f.api("preview", { operation: "delete", keys: [f.key(f.rows[0])] });
  f.advance(11 * 60_000);
  await assert.rejects(apply(f, expired), error => error.code === "preview_required");
  assert.equal(f.calls.length, 1);
});

test("a delete acknowledgement cannot convert a reversible archive preview into delete", async () => {
  const f = fixture();
  const plan = await f.api("preview", { operation: "archive", keys: [f.key(f.rows[0])] });
  assert.equal(plan.irreversible, undefined);
  assert.equal(plan.deletionAcknowledgement, undefined);
  await assert.rejects(f.api("apply", {
    planId: plan.id, confirmation: plan.confirmation,
    deletionAcknowledgement: `DELETE 1 ${plan.id.slice(0, 8)}`,
  }), error => error.code === "invalid_arguments");
  assert.equal(f.calls.length, 0);
  await apply(f, plan);
  assert.equal(f.calls[0].operation, "archive");
  assert.equal(f.rows[0].archived, true);
});

test("delete protects active, unknown-owner, remote and unsupported sessions", async () => {
  const f = fixture(5);
  const idleId = f.rows[4].id;
  f.rows[0].inUse = true;
  f.rows[1].inUse = null;
  f.rows[2].remote = true;
  f.rows[3].operations = ["archive"];
  const plan = await f.api("preview", { operation: "delete", all: true });
  assert.deepEqual(plan.entries.map(entry => entry.reason),
    ["session_in_use", "ownership_unknown", "remote_not_supported", "operation_not_supported", null]);
  assert.equal(plan.deletionAcknowledgement, `DELETE 1 ${plan.id.slice(0, 8)}`);
  const done = await apply(f, plan);
  assert.deepEqual(done.results.map(entry => entry.status), ["skipped", "skipped", "skipped", "skipped", "complete"]);
  assert.deepEqual(f.calls, [{ operation: "delete", id: idleId }]);
});

test("delete rechecks ownership and revisions after preview and reports partial failure", async () => {
  const f = fixture(4);
  const idleId = f.rows[3].id;
  const plan = await f.api("preview", { operation: "delete", all: true });
  f.rows[0].inUse = true;
  f.rows[1].title = "Changed after preview";
  f.rows[2].fail = true;
  const done = await apply(f, plan);
  assert.deepEqual(done.results.map(entry => entry.status), ["failed", "failed", "failed", "complete"]);
  assert.equal(done.results[0].code, "session_in_use");
  assert.equal(done.results[1].code, "session_changed");
  assert.match(done.results[2].message, /Synthetic delete failure/);
  assert(!f.rows.some(row => row.id === idleId));
  assert.equal(f.rows.length, 3);
});

test("archived histories remain independently eligible for permanent deletion", async () => {
  const f = fixture();
  f.rows[0].archived = true;
  f.rows[0].operations = ["delete", "unarchive"];
  const plan = await f.api("preview", { operation: "delete", all: true, archived: true });
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].eligible, true);
  const id = f.rows[0].id;
  await apply(f, plan);
  assert(!f.rows.some(row => row.id === id));
  const restore = await f.api("preview", { operation: "unarchive", keys: ["ccodex:" + id] });
  assert.equal(restore.entries[0].reason, "not_found");
});

test("delete does not silently cascade into unselected active or archived descendants", async () => {
  const f = fixture();
  f.rows[1].parentId = f.rows[0].id;
  f.rows[2].parentId = f.rows[1].id;
  f.rows[2].archived = true;
  f.rows[2].operations = ["delete", "unarchive"];
  const parentOnly = await f.api("preview", { operation: "delete", keys: [f.key(f.rows[0])] });
  assert.equal(parentOnly.entries[0].reason, "descendants_not_selected");
  const missingArchived = await f.api("preview", {
    operation: "delete", keys: f.rows.slice(0, 2).map(f.key),
  });
  assert(missingArchived.entries.every(entry => !entry.eligible));
  await apply(f, missingArchived);
  assert.equal(f.calls.length, 0);
  assert.equal(f.rows.length, 3);
});

test("an explicitly selected but protected descendant also protects every ancestor", async () => {
  const f = fixture();
  f.rows[1].parentId = f.rows[0].id;
  f.rows[2].parentId = f.rows[1].id;
  f.rows[2].inUse = true;
  const plan = await f.api("preview", { operation: "delete", keys: f.rows.map(f.key) });
  assert.deepEqual(plan.entries.map(entry => entry.reason),
    ["session_in_use", "descendants_protected", "descendants_protected"]);
  await apply(f, plan);
  assert.equal(f.calls.length, 0);
});

test("fully selected eligible families delete child-first using explicit IDs only", async () => {
  const f = fixture();
  f.rows[1].parentId = f.rows[0].id;
  f.rows[2].parentId = f.rows[1].id;
  f.rows[2].archived = true;
  f.rows[2].operations = ["delete", "unarchive"];
  const expected = f.rows.map(row => row.id).reverse();
  const plan = await f.api("preview", { operation: "delete", keys: f.rows.map(f.key) });
  assert.deepEqual(plan.entries.map(entry => entry.key.slice(7)), expected);
  assert.equal(plan.deletionAcknowledgement, `DELETE 3 ${plan.id.slice(0, 8)}`);
  const done = await apply(f, plan);
  assert(done.results.every(entry => entry.status === "complete"));
  assert.deepEqual(f.calls.map(call => call.id), expected);
  assert.equal(f.rows.length, 0);
});

test("delete refuses cyclic ancestry rather than guessing a deletion order", async () => {
  const f = fixture(2);
  f.rows[0].parentId = f.rows[1].id;
  f.rows[1].parentId = f.rows[0].id;
  await assert.rejects(f.api("preview", { operation: "delete", keys: f.rows.map(f.key) }),
    error => error.code === "invalid_ancestry");
  assert.equal(f.calls.length, 0);
});

for (const archived of [false, true]) {
  test(`native delete rechecks ${archived ? "archived" : "active-history"} descendants immediately before mutation`, async () => {
    const calls = [];
    const backend = await codexBackend({
      home: fs.realpathSync(os.tmpdir()), nativeWriterLocks: true,
      checkWriters: async () => ({}),
      rpc: { close() {}, async request(method, params) {
        calls.push({ method, params });
        if (method === "thread/list") {
          assert(params.ancestorThreadId);
          assert(params.sourceKinds.includes("subAgent"));
          assert.equal(params.useStateDbOnly, true);
          return { data: params.archived === archived ? [{ id: randomUUID() }] : [], nextCursor: null };
        }
        return {};
      } },
    });
    await assert.rejects(backend.mutate("delete", randomUUID()),
      error => error.code === "native_descendants_protected");
    assert(!calls.some(call => call.method === "thread/delete"));
    if (archived) assert.deepEqual(calls.map(call => call.params.archived), [false, true]);
  });
}

test("CLI delete requires explicit selection and accepts only a structured exact acknowledgement", () => {
  const id = randomUUID();
  assert.deepEqual(parseSessionsArguments(["delete", "--id", id]).args, { keys: ["ccodex:" + id] });
  assert.deepEqual(parseSessionsArguments(["apply", "0123abcd", "--confirm", "confirm",
    "--delete-ack", "DELETE 2 0123abcd"]).args,
    { planId: "0123abcd", confirmation: "confirm", deletionAcknowledgement: "DELETE 2 0123abcd" });
  for (const argv of [
    ["delete"], ["delete", "--yes"], ["delete", "--confirm", "yes"],
    ["delete", "--all", "--delete-ack", "DELETE 1 0123abcd"],
    ["apply", "0123abcd", "--confirm", "x", "--delete-ack", "yes"],
    ["apply", "0123abcd", "--confirm", "x", "--delete-ack", "DELETE 1 other"],
    ["results", "0123abcd", "--delete-ack", "DELETE 1 0123abcd"],
  ]) assert.throws(() => parseSessionsArguments(argv));
});

test("CLI previews delete without mutation and prints an exact two-confirmation command", async () => {
  const f = fixture();
  let text = "";
  const options = { api: f.api, clientId: f.clientId, output: value => { text += value; },
    sleep: () => new Promise(resolve => setImmediate(resolve)) };
  await runSessions(["list"], options);
  await runSessions(["delete", "--select", "1,3"], options);
  assert.match(text, /PERMANENT DELETE/);
  assert.match(text, /Restore cannot undo this/);
  assert.equal(f.calls.length, 0);
  const stored = [...f.service.previews.values()][0];
  const command = `/sessions apply ${stored.plan.id.slice(0, 8)} --confirm ${stored.confirm}` +
    ` --delete-ack "${stored.deletionAcknowledgement}"`;
  assert(text.includes(command));
  assert.equal(localShellCommand(command), "!ccodex sessions" + command.slice("/sessions".length));
  await assert.rejects(runSessions(["apply", stored.plan.id, "--confirm", stored.confirm], options),
    error => error.code === "deletion_acknowledgement_required");
  assert.equal(f.calls.length, 0);
  await runSessions(["apply", stored.plan.id, "--confirm", stored.confirm,
    "--delete-ack", stored.deletionAcknowledgement], options);
  assert.match(text, /Complete: 2; skipped: 0; failed: 0/);
  assert.equal(f.rows.length, 1);
});

function preview(count = 1) {
  const id = randomUUID();
  return { id, operation: "delete", irreversible: true, confirmation: "synthetic",
    deletionAcknowledgement: `DELETE ${count} ${id.slice(0, 8)}`,
    entries: Array.from({ length: count }, () => ({ key: "ccodex:" + randomUUID(), eligible: true })) };
}

test("Desktop acknowledgement is exact, plan-bound, count-bound and rejects a zero-target delete", () => {
  const plan = preview();
  assert.equal(desktopDeletionAcknowledged(plan, plan.deletionAcknowledgement), true);
  for (const value of ["", "yes", plan.deletionAcknowledgement + " ", "DELETE 2 " + plan.id.slice(0, 8)]) {
    assert.equal(desktopDeletionAcknowledged(plan, value), false);
  }
  assert.equal(desktopDeletionAcknowledged({ ...plan, irreversible: false }, plan.deletionAcknowledgement), false);
  assert.equal(desktopDeletionAcknowledged({ ...plan, id: randomUUID() }, plan.deletionAcknowledgement), false);
  assert.equal(desktopDeletionAcknowledged(preview(0), ""), false);
  assert.equal(desktopDeletionAcknowledged({ operation: "archive" }, ""), true);
});

const source = buildDesktopSessionsPatch();

function controlsFixture(plan, value = "") {
  const actions = new Map(), fields = new Map();
  const action = name => {
    if (!actions.has(name)) actions.set(name, { disabled: false });
    return actions.get(name);
  };
  const field = name => {
    if (!fields.has(name)) fields.set(name, { value: "" });
    return fields.get(name);
  };
  field("delete-ack").value = value;
  const nodes = { count: {}, rows: { querySelectorAll: () => [] } };
  nodes["delete-confirm"] = {};
  nodes.progress = {};
  const context = vm.createContext({
    loading: false, applying: false, selecting: false, pendingPlan: null,
    preview: plan, total: 1, cursor: 0, nextCursor: null,
    selection: new Map([["synthetic", { operations: ["delete", "archive"] }]]),
    action, field, find: name => nodes[name], desktopDeletionAcknowledged,
  });
  const controls = source.match(/function controls\(\) \{[\s\S]*?\n  \}/)?.[0];
  assert(controls);
  return { context, action, field, run: () => vm.runInContext(controls + "; controls()", context) };
}

test("Desktop confirm is disabled until the exact phrase matches, and stays disabled while busy", () => {
  const plan = preview();
  const ui = controlsFixture(plan);
  ui.run();
  assert.equal(ui.action("apply").disabled, true);
  ui.field("delete-ack").value = plan.deletionAcknowledgement;
  ui.run();
  assert.equal(ui.action("apply").disabled, false);
  ui.context.loading = true;
  ui.run();
  assert.equal(ui.action("apply").disabled, true);
  assert.equal(ui.field("delete-ack").disabled, true);
});

test("programmatic Desktop clicks cannot bypass the typed confirmation or replay a sent delete", async () => {
  const plan = preview();
  const ui = controlsFixture(plan);
  const calls = [], statuses = [];
  Object.assign(ui.context, {
    controls() {}, status: text => statuses.push(text),
    request: async (operation, args) => {
      calls.push({ operation, args });
      return { accepted: true, planId: args.planId };
    },
    checkResults: async () => {},
    desktopSessionApplyRejected: () => false,
  });
  const handler = source.match(/action\("apply"\)\.onclick = async \(\) => \{[\s\S]*?\n  \};/)?.[0];
  assert(handler);
  vm.runInContext(handler, ui.context);
  await ui.action("apply").onclick();
  assert.equal(calls.length, 0);
  assert.match(statuses[0], /exact DELETE phrase/);
  ui.field("delete-ack").value = plan.deletionAcknowledgement;
  await ui.action("apply").onclick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, "apply");
  assert.equal(calls[0].args.deletionAcknowledgement, plan.deletionAcknowledgement);
  assert.equal(ui.context.pendingPlan, plan.id);
  await ui.action("apply").onclick();
  assert.equal(calls.length, 1);
});

test("cancelling a Desktop delete clears only its acknowledgement and preview", () => {
  const nodes = new Map(), fields = new Map(), actions = new Map();
  const get = (collection, name) => {
    if (!collection.has(name)) collection.set(name, {});
    return collection.get(name);
  };
  const selected = new Map([["keep", { title: "Retain selection" }]]);
  const context = vm.createContext({
    preview: preview(), selection: selected,
    find: name => get(nodes, name), field: name => get(fields, name),
    action: name => get(actions, name), controls() {},
  });
  const leave = source.match(/function leavePreview\(\) \{[\s\S]*?\n  \}/)?.[0];
  assert(leave);
  vm.runInContext(leave + "; leavePreview()", context);
  assert.equal(context.preview, null);
  assert.equal(fields.get("delete-ack").value, "");
  assert.equal(nodes.get("delete-token").textContent, "");
  assert.equal(nodes.get("delete-confirm").hidden, true);
  assert.equal(actions.get("apply").className, "ccs-primary");
  assert.equal(selected.size, 1);
});

function transferFixture() {
  const id = randomUUID();
  const row = { id, key: "ccodex:" + id, title: "Keep exact identity", cwd: "fixture",
    inUse: false, remote: false, operations: ["delete", "archive"] };
  const state = { open: true, total: 3, displayed: 1, selected: 1,
    loading: false, applying: false, pendingPlan: null, preview: null };
  const value = { version: 1, clientId: randomUUID(), rows: [row], selection: [row],
    cursor: 0, nextCursor: null, total: 3, open: true, query: "Keep", cwd: "",
    archived: "", status: "Keep selection", statusError: false, scrollTop: 12 };
  return { value, state };
}

test("idle Desktop transfer preserves exact selection and rejects inferred counts or malformed identities", () => {
  const { value, state } = transferFixture();
  assert.equal(validDesktopSessionTransfer(value, state), true);
  for (const invalid of [
    { ...value, selection: [] }, { ...value, selection: [value.selection[0], value.selection[0]] },
    { ...value, clientId: "standalone" }, { ...value, rows: [] }, { ...value, cursor: -1 },
    { ...value, archived: true }, { ...value, scrollTop: -1 }, { ...value, open: false },
    { ...value, selection: [{ ...value.selection[0], key: "ccodex:" + randomUUID() }] },
    { ...value, selection: [{ ...value.selection[0], inUse: "unknown" }] },
  ]) assert.equal(validDesktopSessionTransfer(invalid, state), false);
  for (const busy of [
    { loading: true }, { applying: true }, { pendingPlan: "sent" }, { preview: "unsent" },
  ]) assert.equal(validDesktopSessionTransfer(value, { ...state, ...busy }), false);
});

test("an exported old controller still cannot be disposed during a pending delete", () => {
  const { value, state } = transferFixture();
  const context = vm.createContext({
    __codexCopilotSessionsV1: {
      revision: 4, inspect: () => ({ ...state, preview: "delete-preview" }),
      exportState: () => value,
      dispose() { assert.fail("Preserve a live preview"); },
    },
  });
  assert.equal(vm.runInContext(source, context), "reload-required");
});

test("delete text explains irreversibility, keeps confirmation tokens literal, and translates skip reasons", () => {
  assert.equal(desktopSessionText("Delete selected permanently"), "\u6c38\u4e45\u5220\u9664\u6240\u9009");
  assert.match(desktopSessionText("Permanent deletion removes conversation history. Restore cannot undo this."),
    /\u4e0d\u80fd.*\u6062\u590d/);
  assert.match(desktopSessionText("Review permanent delete: 2 eligible / 3 selected"), /2.*3/);
  assert.match(desktopSessionText("Skip: descendants_not_selected"), /\u672a\u9009\u9f50/);
  assert.match(desktopSessionText("Skip: descendants_protected"), /\u4f7f\u7528\u4e2d/);
  assert.equal(desktopSessionText("DELETE 2 0123abcd"), "DELETE 2 0123abcd");
  assert.match(source, /data-action="delete" class="ccs-danger"/);
  assert.match(source, /data-field="delete-ack" autocomplete="off"/);
  assert.doesNotMatch(source, /location\.reload|Page\.reload/);
});
