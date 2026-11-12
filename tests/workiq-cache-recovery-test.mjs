import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { acquireCacheLock, recoverAbandonedLock, CacheAccessError } from "../bridge/workiq/cache.mjs";
import { createIdentity, safeAuthError, safeWorkIqError } from "../bridge/workiq/auth.mjs";
import { ActionQueue } from "../bridge/workiq/actions.mjs";
import { configure, readSettings, writeSettings } from "../bridge/workiq/settings.mjs";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-workiq-lock-test-"));
const worker = path.join(import.meta.dirname, "fixtures", "workiq", "lock-worker.mjs");
const tenant = "00000000-0000-4000-8000-000000000001";
let sequence = 0;
function directory() {
  const value = path.join(temporary, String(++sequence));
  fs.mkdirSync(value);
  return value;
}
function deadPid() {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    windowsHide: true, encoding: "utf8", timeout: 5000,
  });
  assert.equal(child.status, 0);
  const pid = Number(child.stdout);
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
  return pid;
}
function startWorker(mode, file) {
  const child = spawn(process.execPath, [worker, mode, file], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  let resolveFirst;
  const firstLine = new Promise(resolve => { resolveFirst = resolve; });
  child.stdout.on("data", chunk => {
    output += chunk;
    if (output.includes("\n")) resolveFirst(output.split("\n")[0]);
  });
  child.stderr.on("data", chunk => { errors += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, output, errors }));
  });
  return { child, firstLine, closed };
}

test("cache-lock release is idempotent and carries a unique ownership record", async () => {
  const file = path.join(directory(), "cache");
  const unlock = await acquireCacheLock(file);
  const record = JSON.parse(fs.readFileSync(`${file}.lock`, "utf8"));
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.pid, process.pid);
  assert.match(record.ownerId, /^[a-f0-9-]{36}$/);
  unlock();
  unlock();
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("live cache owners are never recovered or told to log in again", async () => {
  const file = path.join(directory(), "cache");
  const unlock = await acquireCacheLock(file);
  try {
    await assert.rejects(acquireCacheLock(file, {
      timeoutMs: 20, recover: () => assert.fail("A live owner's lock must never be reclaimed."),
    }), error => {
      assert.ok(error instanceof CacheAccessError);
      assert.equal(error.code, "cache_lock_busy");
      assert.doesNotMatch(safeAuthError(error).message, /Run ['"]?ccodex workiq login/);
      assert.equal(safeWorkIqError(error).message, error.message);
      return true;
    });
  } finally { unlock(); }
});

test("unverifiable lock records are retained", async () => {
  for (const record of ["", "{", '{"pid":0}', '{"pid":-1}', '{"pid":"not-a-process"}', "X".repeat(4097)]) {
    const file = path.join(directory(), "cache");
    fs.writeFileSync(`${file}.lock`, record);
    await assert.rejects(acquireCacheLock(file, {
      timeoutMs: 1, recover: () => assert.fail("Unverifiable record must remain untouched."),
    }), error => error.code === "cache_lock_busy");
    assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), record);
  }
});

test("a failed recovery remains a local-cache error and preserves the stale record", async () => {
  const file = path.join(directory(), "cache");
  const record = JSON.stringify({ pid: deadPid(), createdAt: Date.now() });
  fs.writeFileSync(`${file}.lock`, record);
  await assert.rejects(acquireCacheLock(file, { recover: () => ({ status: "unavailable" }) }), error => {
    assert.equal(error.code, "stale_cache_lock");
    assert.doesNotMatch(safeAuthError(error).message, /Run ['"]?ccodex workiq login/);
    return true;
  });
  assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), record);
});

test("normal process exit releases its own cache lock", async t => {
  const file = path.join(directory(), "cache");
  const fixture = startWorker("exit", file);
  const result = await fixture.closed;
  assert.equal(result.code, 0, result.errors);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  t.diagnostic(`Isolated normal-exit lock worker PID ${fixture.child.pid} exited.`);
});

test("Windows recovery moves only a verified crashed owner's record, retaining cache bytes", { skip: process.platform !== "win32" }, async t => {
  const root = directory();
  const file = path.join(root, "cache");
  fs.writeFileSync(file, "SYNTHETIC_CACHE_BYTES_NOT_A_CREDENTIAL");
  const fixture = startWorker("hold", file);
  assert.equal(Number(await fixture.firstLine), fixture.child.pid);
  // Intentional crash injection against this isolated worker only.
  fixture.child.kill("SIGKILL");
  await fixture.closed;
  const oldRecord = fs.readFileSync(`${file}.lock`, "utf8");
  const unlock = await acquireCacheLock(file);
  assert.equal(JSON.parse(fs.readFileSync(`${file}.lock`, "utf8")).pid, process.pid);
  const backups = fs.readdirSync(root).filter(name => name.startsWith("cache.lock.abandoned."));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(root, backups[0]), "utf8"), oldRecord);
  assert.equal(fs.readFileSync(file, "utf8"), "SYNTHETIC_CACHE_BYTES_NOT_A_CREDENTIAL");
  unlock();
  t.diagnostic(`Recovered isolated crashed lock worker PID ${fixture.child.pid}; cache data unchanged.`);
});

test("Windows recovery refuses a live owner and a changed record", { skip: process.platform !== "win32" }, () => {
  const file = path.join(directory(), "cache.lock");
  const live = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
  fs.writeFileSync(file, live);
  assert.equal(recoverAbandonedLock(file, live).status, "live");
  const changed = JSON.stringify({ pid: deadPid(), createdAt: Date.now() });
  fs.writeFileSync(file, changed);
  let recovery;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    recovery = recoverAbandonedLock(file, live);
    assert.equal(fs.readFileSync(file, "utf8"), changed);
    assert.equal(
      fs.readdirSync(path.dirname(file)).some(name => name.startsWith("cache.lock.abandoned.")),
      false,
    );
    if (recovery.status !== "unavailable") break;
  }
  assert.equal(recovery.status, "changed");
  assert.equal(fs.readFileSync(file, "utf8"), changed);
});

test("Windows concurrent stale-lock recovery does not overlap critical sections", { skip: process.platform !== "win32" }, async t => {
  for (let iteration = 0; iteration < 5; iteration++) {
  const file = path.join(directory(), "cache");
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: deadPid(), createdAt: Date.now() }));
  const a = startWorker("contend", file);
  const b = startWorker("contend", file);
  const results = await Promise.all([a.closed, b.closed]);
  for (const result of results) assert.equal(result.code, 0, result.errors);
  const events = fs.readFileSync(`${file}.events`, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.map(value => value.event), ["enter", "leave", "enter", "leave"]);
  assert.equal(events[0].pid, events[1].pid);
  assert.equal(events[2].pid, events[3].pid);
  assert.notEqual(events[0].pid, events[2].pid);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  t.diagnostic(`Concurrent recovery workers ${a.child.pid} and ${b.child.pid} exited without overlap.`);
  }
});

test("a late unlock cannot remove a replacement owner's record", async () => {
  const file = path.join(directory(), "cache");
  const unlock = await acquireCacheLock(file);
  const replacement = JSON.stringify({ pid: process.pid, ownerId: "replacement-owner" });
  fs.writeFileSync(`${file}.lock`, replacement);
  assert.throws(unlock, error => error.code === "cache_lock_ownership_changed");
  assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), replacement);
  assert.doesNotThrow(unlock);
});

test("identity status preserves cache failures without initiating authentication", async () => {
  const profile = directory();
  configure({ profile });
  writeSettings({ ...readSettings(profile), selectedAccountId: "synthetic", selectedTenantId: tenant }, profile);
  const identity = await createIdentity(profile, {
    cachePlugin: {},
    applicationFactory: () => ({
      getTokenCache: () => ({ getAllAccounts: async () => { throw new CacheAccessError("stale_cache_lock"); } }),
      acquireTokenByDeviceCode: () => assert.fail("No sign-in for local cache errors."),
      acquireTokenSilent: () => assert.fail("Account enumeration failed first."),
    }),
  });
  const status = await identity.status();
  assert.equal(status.authentication, "cache_unavailable");
  assert.equal(status.code, "stale_cache_lock");
  assert.doesNotMatch(status.message, /Run ['"]?ccodex workiq login/);
});

test("recovery of an action lock never replays an already-executing write", { skip: process.platform !== "win32" }, async () => {
  const profile = directory();
  configure({ profile, enable: true, acknowledge: true });
  writeSettings({ ...readSettings(profile), selectedAccountId: "synthetic", selectedTenantId: tenant }, profile);
  const queue = new ActionQueue(profile, {
    protect: value => Buffer.from(value).toString("base64"),
    unprotect: value => Buffer.from(value, "base64").toString(),
  });
  const pending = await queue.enqueue({ name: "do_action", arguments: { actionUrl: "/synthetic-test-only" } });
  const record = await queue.read(pending.id);
  record.status = "executing";
  await queue.save(record);
  fs.writeFileSync(`${queue.file(pending.id)}.lock`, JSON.stringify({ pid: deadPid(), createdAt: Date.now() }));
  await assert.rejects(queue.approve(pending.id, pending.requestHash, () => assert.fail("An uncertain write must not be replayed.")), /no longer pending/);
  assert.equal((await queue.read(pending.id)).status, "executing");
});

test.after(async () => {
  const resolved = fs.realpathSync(temporary);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.match(path.basename(resolved), /^ccodex-workiq-lock-test-/);
  await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
});
