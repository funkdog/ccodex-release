import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { HistoryManager } from "../tools/history/manager.mjs";
import { SessionManagement, selectionKeys, sessionRequestAuthorized } from "../bridge/session-management.mjs";
import { parseSessionsArguments, runSessions } from "../bridge/sessions-cli.mjs";
import { buildDesktopSessionsPatch } from "../bridge/desktop-sessions.mjs";
import { codexBackend } from "../tools/history/backends.mjs";
import { classifyCliOwnership, protectCliBackend } from "../bridge/cli-session-ownership.mjs";
import http from "node:http";
import { localSessionRequest } from "../bridge/session-management-api.mjs";

const require = createRequire(import.meta.url);
const { CliInputRouter } = require("../bin/ccodex-input.cjs");
const { ComposerScreen } = require("../bin/ccodex-composer.cjs");
const { localShellCommand } = require("../bin/ccodex-local-command.cjs");

function fixture(count = 3) {
  let now = Date.now();
  const rows = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(), title: `Session ${index + 1}`, cwd: "fixture",
    archived: false, remote: false, inUse: false,
    createdAt: new Date(now - index * 1000).toISOString(),
    modifiedAt: new Date(now - index * 1000).toISOString(),
    operations: ["archive", "unarchive"],
  }));
  const calls = [];
  const backend = { home: "fixture",
    list: async () => rows,
    async mutate(operation, id) {
      calls.push({ operation, id });
      const row = rows.find(row => row.id === id);
      if (row.fail) throw new Error("Synthetic native failure");
      row.archived = operation === "archive";
      row.operations = [row.archived ? "unarchive" : "archive"];
    },
  };
  const manager = new HistoryManager({ ccodex: backend }, { now: () => now });
  const service = new SessionManagement({ now: () => now,
    managerFactory: async () => ({ manager, close() {} }) });
  const clientId = randomUUID();
  const api = (operation, args) => service.request(operation, { ...args, clientId });
  return { rows, calls, manager, service, api, clientId, advance: ms => { now += ms; } };
}

async function result(fixture, plan) {
  await fixture.api("apply", { planId: plan.id, confirmation: plan.confirmation });
  await fixture.service.jobs.get(plan.id).work;
  return fixture.api("progress", { planId: plan.id });
}

test("batch management authenticates loopback JSON requests and refuses browser/foreign capabilities", () => {
  const token = "fixture-capability";
  const req = { method: "POST", socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:22691", "content-type": "application/json",
      "x-codex-copilot-control": token } };
  assert.equal(sessionRequestAuthorized(req, { port: 22691, token }), true);
  for (const headers of [
    { origin: "app://-" }, { referer: "https://example.invalid" },
    { "sec-fetch-site": "same-origin" }, { "x-codex-copilot-control": "wrong" },
    { host: "example.invalid:22691" }, { "content-type": "text/plain" },
  ]) assert.equal(sessionRequestAuthorized({ ...req, headers: { ...req.headers, ...headers } },
    { port: 22691, token }), false);
  assert.equal(sessionRequestAuthorized({ ...req, socket: { ...req.socket, remoteAddress: "192.0.2.1" } },
    { port: 22691, token }), false);
});

test("the real local HTTP transport passes private authorization without relaxing browser restrictions", async t => {
  let authorized = false;
  const token = "fixture-capability";
  const server = http.createServer((req, res) => {
    authorized = sessionRequestAuthorized(req, { port: server.address().port, token });
    req.resume();
    res.writeHead(authorized ? 200 : 403, { "content-type": "application/json" });
    res.end(JSON.stringify({ authorized }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await localSessionRequest(`http://127.0.0.1:${server.address().port}/sessions/list`, {
    method: "POST", headers: { "content-type": "application/json", "x-codex-copilot-control": token },
    body: "{}", signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.ok, true);
  assert.equal((await response.json()).authorized, true);
  assert.equal(authorized, true);
});

test("selection uses exact displayed identities and refuses overflowing/reversed row ranges", () => {
  assert.deepEqual(selectionKeys("1,3-4", ["a", "b", "c", "d"]), ["a", "c", "d"]);
  assert.deepEqual(selectionKeys("all", ["a", "b"]), ["a", "b"]);
  for (const value of ["0", "2-1", "1-999999999999", "1;2", "", "NaN"]) {
    assert.throws(() => selectionKeys(value, ["a", "b"]), /row numbers|outside/);
  }
});

test("archive and restore require a single-use client-scoped exact preview", async () => {
  const f = fixture();
  await f.api("list", {});
  const plan = await f.api("preview", { operation: "archive", selection: "1,3" });
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.api("apply", { planId: plan.id, confirmation: "wrong" }), /exact confirmation/);
  await assert.rejects(f.service.request("apply", {
    clientId: randomUUID(), planId: plan.id, confirmation: plan.confirmation,
  }), /fresh batch preview/);
  await f.api("apply", { planId: plan.id.slice(0, 8), confirmation: plan.confirmation });
  await f.service.jobs.get(plan.id).work;
  const progress = await f.api("progress", { planId: plan.id.slice(0, 8) });
  assert.equal(progress.completed, 2);
  assert(progress.results.every(row => row.status === "complete"));
  assert.deepEqual(f.calls.map(call => call.id), [f.rows[0].id, f.rows[2].id]);
  await assert.rejects(f.api("apply", { planId: plan.id, confirmation: plan.confirmation }), /fresh/);
  const restore = await f.api("preview", { operation: "unarchive",
    keys: [f.rows[0], f.rows[2]].map(row => "ccodex:" + row.id) });
  assert((await result(f, restore)).results.every(row => row.status === "complete"));
  assert(f.rows.every(row => !row.archived));
});

test("currently running and unknown-owner sessions are protected while idle sessions remain usable", async () => {
  const f = fixture();
  f.rows[0].inUse = true;
  f.rows[1].inUse = null;
  const plan = await f.api("preview", { operation: "archive", all: true });
  assert.deepEqual(plan.entries.map(row => row.reason), ["session_in_use", "ownership_unknown", null]);
  const progress = await result(f, plan);
  assert.deepEqual(progress.results.map(row => row.status), ["skipped", "skipped", "complete"]);
  assert.equal(f.calls.length, 1);
});

test("a session becoming active after preview is not changed and partial failures remain per-session", async () => {
  const f = fixture();
  const plan = await f.api("preview", { operation: "archive", all: true });
  f.rows[0].inUse = true;
  f.rows[1].fail = true;
  const progress = await result(f, plan);
  assert.deepEqual(progress.results.map(row => row.status), ["failed", "failed", "complete"]);
  assert.equal(progress.results[0].code, "session_in_use");
  assert.match(progress.results[1].message, /Synthetic native failure/);
  assert(!f.rows[0].archived);
});

test("expired previews and unsupported operations are refused", async () => {
  const f = fixture();
  await assert.rejects(f.api("preview", { operation: "rename", all: true }), /exact preview/);
  const plan = await f.api("preview", { operation: "archive", all: true });
  f.advance(11 * 60_000);
  await assert.rejects(f.api("apply", { planId: plan.id, confirmation: plan.confirmation }), /fresh/);
  assert.equal(f.calls.length, 0);
});

test("select-all covers all filtered pages, not just displayed rows, and refuses silent truncation", async () => {
  const f = fixture(251);
  await f.api("list", { limit: 50 });
  const displayed = await f.api("preview", { operation: "archive", selection: "all" });
  assert.equal(displayed.entries.length, 50);
  const all = await f.api("preview", { operation: "archive", all: true });
  assert.equal(all.entries.length, 251);
  const filtered = await f.api("preview", { operation: "archive", all: true, query: "Session 251" });
  assert.equal(filtered.entries.length, 1);
  await assert.rejects(fixture(501).api("preview", { operation: "archive", all: true }), /Narrow the filter/);
});

test("/sessions routing supports chunk boundaries, quotes, editing and post-Escape composer recovery", () => {
  const command = "/sessions archive --select 1,3-5\r";
  for (let index = 0; index <= command.length; index++) {
    const router = new CliInputRouter();
    const output = router.transform(command.slice(0, index)) + router.transform(command.slice(index));
    assert.equal(output, command.slice(0, -1) + "\x01\x7f!ccodex sessions archive --select 1,3-5\r");
  }
  const router = new CliInputRouter({ readLocalCommand: () => "/sessions" });
  router.transform("\x1b"); router.flush();
  assert.match(router.transform("/sessions\r"), /!ccodex sessions\r$/);
  assert.equal(localShellCommand('/sessions list --query "two words"'),
    '!ccodex sessions list --query "two words"');
  for (const command of ["/sessions & whoami", "/sessions --query $env:HOME",
    '/sessions --query "%PATH%"', "/sessions ; ls", '/sessions --query "unclosed']) {
    assert.equal(localShellCommand(command), "!ccodex sessions invalid-arguments");
  }
  assert.doesNotMatch(new CliInputRouter().transform("\x1b[200~/sessions\r\x1b[201~"), /!ccodex/);
  assert.doesNotMatch(new CliInputRouter().transform("/sessions\n\r"), /!ccodex/);
});

test("complete tracked commands are never truncated to a lagging renderer prefix", () => {
  const router = new CliInputRouter({ readLocalCommand: () => "/sessions archive --sel" });
  assert.equal(router.transform("/sessions archive --select 1,2\r"),
    "/sessions archive --select 1,2\x01\x7f!ccodex sessions archive --select 1,2\r");
});

test("the screen adapter recognizes /sessions only at a single-line native composer", async () => {
  const screen = new ComposerScreen(100, 12);
  try {
    screen.write("\x1b[2J\x1b[10;1H\u203a /sessions list\x1b[10;17H");
    await screen.flush();
    assert.equal(screen.readLocalCommand(), "/sessions list");
    screen.write("\x1b[11;1Hsecond line\x1b[10;17H");
    await screen.flush();
    assert.equal(screen.readLocalCommand(), null);
  } finally { screen.dispose(); }
});

test("CLI arguments refuse accidental destructive commands and invalid option combinations", () => {
  assert.deepEqual(parseSessionsArguments(["archive", "--select", "1,3"]).args, { selection: "1,3" });
  assert.equal(parseSessionsArguments(["restore", "--all", "--archived"]).args.archived, true);
  for (const argv of [["delete"], ["list", "--all"], ["list", "--active", "--archived"],
    ["apply", randomUUID()], ["archive", "--id", "not-a-uuid"], ["archive", "--confirm", "yes"]]) {
    assert.throws(() => parseSessionsArguments(argv));
  }
});

test("CLI uses list -> preview -> confirmed apply and reports every batch result without a model", async () => {
  const f = fixture();
  let text = "";
  const calls = [];
  const api = (operation, args) => {
    calls.push(operation);
    return f.api(operation, args);
  };
  const options = { api, clientId: f.clientId, output: value => { text += value; },
    sleep: () => new Promise(resolve => setImmediate(resolve)) };
  await runSessions(["list"], options);
  await runSessions(["archive", "--select", "1,3"], options);
  assert.match(text, /No sessions changed/);
  assert.equal(f.calls.length, 0);
  const preview = [...f.service.previews.values()][0];
  await runSessions(["apply", preview.plan.id.slice(0, 8), "--confirm", preview.confirm], options);
  assert.match(text, /Complete: 2; skipped: 0; failed: 0/);
  assert(calls.every(operation => ["list", "preview", "apply", "progress"].includes(operation)));
});

test("native backend checks per-thread locks even when another native client is open", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const home = fs.realpathSync(os.tmpdir());
  const id = randomUUID(), active = randomUUID(), requests = [];
  const rpc = { child: { pid: 123 },
    async request(method, params) {
      requests.push({ method, params });
      if (method === "thread/list") return { data: params.parentThreadId || params.ancestorThreadId || params.archived ? []
        : [id, active].map(id => ({ id, name: "fixture", updatedAt: 1, createdAt: 1 })), nextCursor: null };
      return {};
    },
    close() {},
  };
  const backend = await codexBackend({ home, rpc, nativeWriterLocks: true, checkClients: () => true,
    checkWriters: async () => ({ [active]: true }) });
  assert.deepEqual((await backend.list()).map(row => row.inUse), [false, true]);
  await backend.mutate("archive", id);
  await assert.rejects(backend.mutate("archive", active), /running/);
  assert.equal(requests.filter(request => request.method === "thread/archive").length, 1);
});

test("confirmed archive previews order selected descendants before their parents", async () => {
  const f = fixture(3);
  f.rows[1].parentId = f.rows[0].id;
  f.rows[2].parentId = f.rows[1].id;
  const plan = await f.api("preview", { operation: "archive",
    keys: f.rows.map(row => "ccodex:" + row.id) });
  assert.deepEqual(plan.entries.map(row => row.key), [...f.rows].reverse().map(row => "ccodex:" + row.id));
  await result(f, plan);
  assert.deepEqual(f.calls.map(row => row.id), [...f.rows].reverse().map(row => row.id));
});

test("native descendant guards include hidden sources and all descendant levels", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const id = randomUUID(), calls = [];
  const backend = await codexBackend({
    home: fs.realpathSync(os.tmpdir()), nativeWriterLocks: true,
    checkWriters: async () => ({}),
    rpc: { child: { pid: 123 }, close() {}, async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/list" && params.ancestorThreadId) {
        assert(params.sourceKinds.includes("subAgent"));
        return { data: [{ id: randomUUID() }], nextCursor: null };
      }
      return { data: [], nextCursor: null };
    } },
  });
  await assert.rejects(backend.mutate("archive", id), /spawned children/);
  assert.equal(calls.some(row => row.method === "thread/archive"), false);
});

test("older native history backends do not infer safety from a newer Desktop's writer directory", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const id = randomUUID();
  const rpc = { child: { pid: 123 }, request: async (_, params) => ({
    data: params.archived ? [] : [{ id, name: "fixture", updatedAt: 1, createdAt: 1 }],
    nextCursor: null,
  }), close() {} };
  const backend = await codexBackend({ home: fs.realpathSync(os.tmpdir()), rpc,
    checkClients: () => true, checkWriters: async () => ({}) });
  assert.equal((await backend.list())[0].inUse, null);
  await assert.rejects(backend.mutate("archive", id), /cannot be verified/);
});

test("CLI protection binds real process lifetimes and descendants, rejecting unknown or reused owners", () => {
  const id = randomUUID();
  const lease = { ownerPid: 100, lifetime: "windows:born", currentThreadId: id };
  const rows = [
    { pid: 100, parentPid: 1, name: "node.exe", lifetime: "windows:born" },
    { pid: 101, parentPid: 100, name: "node.exe", lifetime: "windows:proxy" },
    { pid: 102, parentPid: 101, name: "codex-copilot-core.exe", lifetime: "windows:core" },
  ];
  const owner = classifyCliOwnership(rows, [lease]);
  assert(owner.active.has(id));
  assert.equal(owner.unknown, false);
  assert.equal(classifyCliOwnership(rows, []).unknown, true);
  assert.equal(classifyCliOwnership(rows, [{ ...lease, lifetime: "windows:old" }]).unknown, true);
  assert.equal(classifyCliOwnership(rows, [{ ...lease, currentThreadId: null }]).unknown, true);
});

test("CLI guards preserve the current thread and block every mutation when ownership is unresolved", async () => {
  const active = randomUUID(), idle = randomUUID(), calls = [];
  let unknown = false;
  const backend = protectCliBackend({
    list: async () => [active, idle].map(id => ({ id, inUse: false })),
    mutate: async (_, id) => { calls.push(id); },
  }, "fixture", async () => ({ active: new Set([active]), unknown }));
  assert.deepEqual((await backend.list()).map(row => row.inUse), [true, false]);
  await assert.rejects(backend.mutate("archive", active), /protected/);
  await backend.mutate("archive", idle);
  unknown = true;
  assert.deepEqual((await backend.list()).map(row => row.inUse), [true, null]);
  await assert.rejects(backend.mutate("archive", idle), /protected/);
  assert.deepEqual(calls, [idle]);
});

test("the Desktop patch is valid standalone JavaScript and does not replace native model/account controls", () => {
  const source = buildDesktopSessionsPatch();
  new vm.Script(source);
  assert.match(source, /Bulk session management/);
  assert.match(source, /Select all filtered/);
  assert.match(source, /Confirm exact selection/);
  assert.doesNotMatch(source, /location\.reload|__codexCopilotModelControls|Open profile menu/);
});
