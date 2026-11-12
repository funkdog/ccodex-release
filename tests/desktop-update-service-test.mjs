import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDesktopUpdateService } from "../bridge/desktop-update-service.mjs";

const current = "26.928.3736.0-0123456789ab";
const candidate = "26.930.3930.0-abcdef012345";
const identity = pid => ({ pid, platform: process.platform,
  lifetime: `synthetic-test-${pid}`, executable: process.execPath });
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-update-service-test-"));
  const home = path.join(root, "private-home");
  const desktop = path.join(root, "desktop");
  fs.mkdirSync(home);
  fs.mkdirSync(desktop);
  const pointer = path.join(desktop, "current.json");
  fs.writeFileSync(pointer, JSON.stringify({ version: current }));
  const before = fs.readFileSync(pointer, "utf8");
  const options = { root, home, platform: "win32", runningSnapshot: current,
    assertOwned() {}, inspectProcess: identity, snapshot() {},
    worker: async () => {}, ...overrides };
  const service = createDesktopUpdateService(options);
  t.after(async () => {
    await service.idle();
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^ccodex-update-service-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, desktop, pointer, before, options, service,
    file: path.join(desktop, "update-operation.json"),
    lock: path.join(desktop, "update-operation.lock") };
}

function prepared(f, name = "a".repeat(32) + ".json", value = {}) {
  const directory = path.join(f.desktop, "prepared-updates");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name), JSON.stringify({
    status: "prepared-needs-extension-validation",
    originalInstallationModified: false, candidate, vendorVersion: "26.930.3930.0", ...value,
  }));
}

test("private update service requires an owner guard and rejects the stock home", t => {
  const f = fixture(t);
  assert.throws(() => createDesktopUpdateService({ ...f.options, assertOwned: null }), /owner guard/);
  assert.throws(() => createDesktopUpdateService({
    ...f.options, home: path.join(os.homedir(), ".codex"),
  }), /original Codex profile/);
});

test("private update status is read-only and starts no worker", async t => {
  const f = fixture(t, { worker: () => assert.fail("status must not run a worker") });
  const result = await f.service.request({ operation: "status" });
  assert.equal(result.selectedSnapshot, current);
  assert.equal(result.originalInstallationOwned, false);
  assert.equal(result.busy, false);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.readFileSync(f.pointer, "utf8"), f.before);
});

test("update requests accept no URL, validation path, command or extra parameters", async t => {
  const f = fixture(t, { worker: () => assert.fail("invalid requests must not run a worker") });
  for (const request of [null, [], { operation: "unknown" },
    { operation: "status", path: "../../stock" },
    { operation: "prepare", url: "https://unrelated.invalid" },
    { operation: "apply", validation: "C:\\stock\\validation.json" }]) {
    await assert.rejects(f.service.request(request), /Invalid private/);
  }
  assert.equal(fs.existsSync(f.lock), false);
});

test("concurrent clicks return the same background job and do not block the renderer", async t => {
  let finish;
  let calls = 0;
  const wait = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, { worker: async ({ args, onStarted }) => {
    calls++; assert.deepEqual(args, ["check"]); onStarted(process.pid); await wait;
  } });
  try {
    const first = await f.service.request({ operation: "check" });
    const second = await f.service.request({ operation: "prepare" });
    assert.equal(first.operation.id, second.operation.id);
    assert.equal(second.busy, true);
    assert.equal(calls, 1);
    const lock = JSON.parse(fs.readFileSync(f.lock, "utf8"));
    assert.equal(lock.identity.pid, process.pid);
    assert.equal(lock.workerIdentity.pid, process.pid);
  } finally { finish(); }
  await f.service.idle();
  assert.equal(f.service.status().operation.status, "metadata-checked");
  assert.equal(f.service.status().operation.latestVersionVerified, false);
  assert.equal(fs.existsSync(f.lock), false);
  assert.equal(fs.readFileSync(f.pointer, "utf8"), f.before);
});

test("a second private instance cannot start an overlapping shared snapshot update", async t => {
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, { worker: () => wait });
  const other = createDesktopUpdateService({ ...f.options, home: path.join(f.root, "other-home") });
  try {
    await f.service.request({ operation: "check" });
    await assert.rejects(other.request({ operation: "prepare" }), /already running/);
  } finally { finish(); }
  await f.service.idle();
});

test("unknown locks are preserved instead of being reclaimed as stale", async t => {
  const f = fixture(t);
  const bytes = JSON.stringify({ schemaVersion: 99, owner: "unrecognized" });
  fs.writeFileSync(f.lock, bytes);
  await assert.rejects(f.service.request({ operation: "check" }), /unrecognized/);
  assert.equal(fs.readFileSync(f.lock, "utf8"), bytes);
});

test("an orphaned live worker keeps its lock after the helper lifetime ended", async t => {
  const f = fixture(t, { inspectProcess: pid => pid === 4242 ? null : identity(pid) });
  const bytes = JSON.stringify({ schemaVersion: 1,
    identity: identity(4242), workerIdentity: identity(4343) });
  fs.writeFileSync(f.lock, bytes);
  await assert.rejects(f.service.request({ operation: "prepare" }), /already running/);
  assert.equal(fs.readFileSync(f.lock, "utf8"), bytes);
});

test("recognized dead helper and worker locks can be reclaimed", async t => {
  const f = fixture(t, { inspectProcess: pid =>
    [4242, 4343].includes(pid) ? null : identity(pid) });
  fs.writeFileSync(f.lock, JSON.stringify({ schemaVersion: 1,
    identity: identity(4242), workerIdentity: identity(4343) }));
  await f.service.request({ operation: "check" });
  await f.service.idle();
  assert.equal(f.service.status().operation.status, "metadata-checked");
  assert.equal(fs.existsSync(f.lock), false);
});

test("prepare discovers only one newly produced private verified package receipt", async t => {
  let f;
  f = fixture(t, { worker: async ({ args }) => {
    assert.deepEqual(args, ["prepare"]); prepared(f);
  } });
  prepared(f, "b".repeat(32) + ".json", { candidate: current });
  await f.service.request({ operation: "prepare" });
  await f.service.idle();
  const result = f.service.status();
  assert.equal(result.operation.status, "prepared");
  assert.equal(result.operation.candidate, candidate);
  assert.equal(result.selectedSnapshot, current);
  assert.equal(fs.readFileSync(f.pointer, "utf8"), f.before);
});

test("ambiguous prepared receipts cannot select or validate a candidate", async t => {
  let f;
  f = fixture(t, { worker: async () => {
    prepared(f); prepared(f, "b".repeat(32) + ".json");
  } });
  await f.service.request({ operation: "prepare" });
  await f.service.idle();
  assert.equal(f.service.status().operation.status, "rejected");
  assert.match(f.service.status().operation.message, /one exact private receipt/);
  assert.equal(fs.readFileSync(f.pointer, "utf8"), f.before);
});

test("failed candidate validation remains explicit and never falls back to native update", async t => {
  let f;
  let applyCalls = 0;
  f = fixture(t, {
    worker: async ({ args }) => {
      if (args[0] === "prepare") return prepared(f);
      assert.deepEqual(args, ["validate", candidate]);
      const directory = path.join(f.desktop, "validation", candidate);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "candidate-validation.json"), JSON.stringify({
        passed: false, remainingGate: "Actual native renderer acceptance is required.",
      }));
    },
    apply: async () => { applyCalls++; assert.fail("unvalidated candidate must not be applied"); },
  });
  await f.service.request({ operation: "prepare" }); await f.service.idle();
  await f.service.request({ operation: "validate" }); await f.service.idle();
  assert.equal(f.service.status().operation.status, "needs-validation");
  await f.service.request({ operation: "apply" }); await f.service.idle();
  assert.equal(f.service.status().operation.status, "rejected");
  assert.equal(applyCalls, 0);
  assert.equal(fs.readFileSync(f.pointer, "utf8"), f.before);
});

test("closing or superseding the private instance rejects a background result", async t => {
  let owned = true;
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, {
    assertOwned() { if (!owned) throw new Error("Private instance superseded."); },
    worker: () => wait,
  });
  await f.service.request({ operation: "check" });
  await flush();
  owned = false;
  finish();
  await f.service.idle();
  const result = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.equal(result.status, "rejected");
  assert.match(result.message, /superseded/);
  assert.equal(fs.readFileSync(f.pointer, "utf8"), f.before);
  assert.equal(fs.existsSync(f.lock), false);
});

test("worker errors are journaled without changing the selected snapshot", async t => {
  const f = fixture(t, { worker: async () => { throw new Error("Official package signature failed."); } });
  await f.service.request({ operation: "prepare" });
  await f.service.idle();
  assert.equal(f.service.status().operation.status, "rejected");
  assert.match(f.service.status().operation.message, /signature failed/);
  assert.equal(fs.readFileSync(f.pointer, "utf8"), f.before);
});
