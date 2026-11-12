import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const windows = { skip: process.platform !== "win32" };
const at = seconds => new Date(Date.UTC(2026, 8, 22, 8) + seconds * 1000).toISOString();
const processRecord = (ProcessId, ParentProcessId, seconds, Name = "node.exe") => ({
  ProcessId, ParentProcessId, CreationDate: at(seconds), Name,
});
const root = processRecord(100, 1, 10);
const snapshot = (seconds, ...processes) => ({ at: at(seconds), processes });

function audit(snapshots, final, selectedRoot = root) {
  const result = spawnSync("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-File", path.join(import.meta.dirname, "fixtures", "repair-process-tree.ps1"),
  ], {
    input: JSON.stringify({ root: selectedRoot, snapshots, final }),
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

test("process cleanup excludes an older production tree whose parent PID was reused by a test", windows, () => {
  const testChild = processRecord(11860, 100, 11);
  const production = processRecord(26488, 11860, -86400);
  const consoleHost = processRecord(26504, 26488, -86399, "conhost.exe");
  const result = audit(
    [snapshot(15, root, testChild, production, consoleHost)],
    snapshot(20, production, consoleHost),
  );
  assert.equal(result.verified, true);
  assert.deepEqual(result.processes.map(p => p.pid), [100, 11860]);
  assert.deepEqual(result.remainingPids, []);
});

test("process cleanup detects a real surviving descendant after its parent exits", windows, () => {
  const parent = processRecord(200, 100, 11);
  const child = processRecord(300, 200, 12);
  const result = audit([snapshot(15, child, parent, root)], snapshot(20, child));
  assert.equal(result.verified, false);
  assert.deepEqual(result.remainingPids, [300]);
  assert.equal(result.processes.find(p => p.pid === 300).parentIdentity,
    result.processes.find(p => p.pid === 200).processIdentity);
});

test("process cleanup follows an orphan first seen after a tracked parent exits", windows, () => {
  const parent = processRecord(200, 100, 11);
  const orphan = processRecord(300, 200, 16);
  const result = audit(
    [snapshot(15, root, parent), snapshot(20, root)],
    snapshot(25, orphan),
  );
  assert.equal(result.verified, false);
  assert.deepEqual(result.remainingPids, [300]);
});

test("process cleanup does not attribute later children of an unrelated reused parent PID", windows, () => {
  const parent = processRecord(200, 100, 11);
  const unrelated = processRecord(200, 900, 21);
  const unrelatedChild = processRecord(300, 200, 22);
  const result = audit(
    [snapshot(15, root, parent), snapshot(20, root)],
    snapshot(25, unrelatedChild, unrelated),
  );
  assert.equal(result.verified, true);
  assert.deepEqual(result.processes.map(p => p.pid), [100, 200]);
});

test("a replacement observed without an empty snapshot bounds the previous parent lifetime", windows, () => {
  const parent = processRecord(200, 100, 11);
  const unrelated = processRecord(200, 900, 16);
  const unrelatedChild = processRecord(300, 200, 17);
  const result = audit([snapshot(15, root, parent)], snapshot(20, unrelatedChild, unrelated));
  assert.equal(result.verified, true);
  assert.deepEqual(result.processes.map(p => p.pid), [100, 200]);
});

test("two genuine test children reusing one PID remain separate process lifetimes", windows, () => {
  const first = processRecord(200, 100, 11);
  const second = processRecord(200, 100, 21);
  const child = processRecord(300, 200, 22);
  const result = audit(
    [snapshot(15, root, first), snapshot(25, child, second, root)],
    snapshot(30, second, child),
  );
  assert.equal(result.verified, false);
  const lifetimes = result.processes.filter(p => p.pid === 200);
  assert.equal(lifetimes.length, 2);
  assert.notEqual(lifetimes[0].processIdentity, lifetimes[1].processIdentity);
  assert.equal(lifetimes[0].exited, true);
  assert.equal(lifetimes[1].exited, false);
  assert.equal(result.processes.find(p => p.pid === 300).parentIdentity, lifetimes[1].processIdentity);
  assert.deepEqual(result.remainingPids, [200, 300]);
});

test("process lifetime comparison normalizes timezones without reducing timestamp precision", windows, () => {
  const localRoot = { ...root, CreationDate: "2026-09-22T16:00:10.000001+08:00" };
  const sameRoot = { ...root, CreationDate: "2026-09-22T08:00:10.000001Z" };
  const result = audit([], snapshot(20, sameRoot), localRoot);
  assert.equal(result.verified, false);
  assert.deepEqual(result.remainingPids, [100]);
  const replacement = { ...root, CreationDate: "2026-09-22T08:00:10.000002Z" };
  const reused = audit([], snapshot(20, replacement), localRoot);
  assert.equal(reused.verified, true);
});

test("a reused runner PID does not make its unrelated replacement a surviving test", windows, () => {
  const replacement = processRecord(100, 900, 21);
  const unrelatedChild = processRecord(200, 100, 22);
  const result = audit([snapshot(15, root)], snapshot(25, replacement, unrelatedChild));
  assert.equal(result.verified, true);
  assert.deepEqual(result.processes.map(p => p.pid), [100]);
});

test("an older orphan remains tracked when its exited parent's PID is subsequently reused", windows, () => {
  const parent = processRecord(200, 100, 11);
  const orphan = processRecord(300, 200, 16);
  const replacement = processRecord(200, 900, 21);
  const unrelatedChild = processRecord(400, 200, 22);
  const result = audit(
    [snapshot(15, root, parent)],
    snapshot(25, orphan, replacement, unrelatedChild),
  );
  assert.equal(result.verified, false);
  assert.deepEqual(result.remainingPids, [300]);
  assert.deepEqual(result.processes.map(p => p.pid), [100, 200, 300]);
});
