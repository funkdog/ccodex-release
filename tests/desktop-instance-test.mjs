import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { desktopStateRoot } from "../bridge/desktop-runtime.mjs";
import {
  acquireDesktopStartLock, bindDesktopInstance, helperProcessMatches,
  readDesktopInstance, writeDesktopInstance,
} from "../bridge/desktop-instance.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-instance-test-"));
  const home = path.join(root, "profile");
  const executable = path.join(root, "snapshot", "ChatGPT.exe");
  const resources = path.join(root, "snapshot", "resources");
  fs.mkdirSync(path.join(home, "desktop-data"), { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(executable, "synthetic executable, never started");
  const launchArgs = [`--user-data-dir=${path.join(home, "desktop-data")}`,
    "--remote-debugging-port=22691", "--remote-debugging-address=127.0.0.1"];
  const identity = { pid: 1234, platform: process.platform,
    lifetime: "fixture-primary-lifetime", executable, args: [executable, ...launchArgs] };
  const runtime = { executable, resources, manifest: { version: "26.928.3736.0-0123456789ab" } };
  const receipt = {
    schemaVersion: 2, installRoot: root, profile: home,
    runtimeStateRoot: desktopStateRoot({ root, home }),
    userData: path.join(home, "desktop-data"), executable, resources,
    instanceToken: randomUUID(), snapshotVersion: runtime.manifest.version,
    pid: identity.pid, identity, debugPort: 22691, bridgePort: 22531, launchArgs,
  };
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^ccodex-instance-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, identity, runtime, receipt,
    bind: overrides => bindDesktopInstance({
      root, home, receipt, snapshot: () => runtime,
      inspectProcess: () => identity, owner: () => identity.pid,
      readiness: async () => ({ rendererVerified: true }), ...overrides,
    }) };
}

test("private instance metadata is an atomic round trip, not a stock activation receipt", t => {
  const f = fixture(t);
  assert.equal(readDesktopInstance(f.home), null);
  writeDesktopInstance(f.home, f.receipt);
  assert.deepEqual(readDesktopInstance(f.home), f.receipt);
  assert.equal(fs.readdirSync(f.home).some(name => name.endsWith(".pending")), false);
});

test("instance binding confirms a private snapshot/process and rechecks lifetime/endpoint", async t => {
  const f = fixture(t);
  const bound = f.bind();
  bound.assertOwned();
  assert.equal((await bound.awaitReady()).rendererVerified, true);
});

test("legacy or unrelated receipts cannot authorize an existing window", t => {
  const f = fixture(t);
  assert.throws(() => f.bind({ receipt: { ...f.receipt, schemaVersion: 1 } }), /legacy/);
  assert.throws(() => f.bind({ receipt: { ...f.receipt, installRoot: path.join(f.root, "other") } }), /unrelated/);
  assert.throws(() => f.bind({ receipt: { ...f.receipt, userData: f.root } }), /unrelated/);
});

test("instance binding refuses PID reuse, wrong profile arguments and a stock executable", t => {
  const f = fixture(t);
  assert.throws(() => f.bind({ inspectProcess: () => ({ ...f.identity, lifetime: "reused-pid" }) }), /reused/);
  assert.throws(() => f.bind({ inspectProcess: () => ({ ...f.identity, args: [f.identity.executable] }) }), /different executable\/profile/);
  assert.throws(() => f.bind({ inspectProcess: () => ({ ...f.identity, executable: path.join(f.root, "stock.exe") }) }), /reused/);
});

test("a dead verified private lifetime is stale, but unreadable live identity is not", t => {
  const f = fixture(t);
  assert.equal(f.bind({ inspectProcess: () => null }), null);
  assert.throws(() => f.bind({ inspectProcess: () => { throw new Error("permission denied"); } }), /permission denied/);
});

test("an existing binding rejects later PID or port reassignment before any extension action", t => {
  const f = fixture(t);
  let current = f.identity;
  let owner = current.pid;
  const bound = f.bind({ inspectProcess: () => current, owner: () => owner });
  current = { ...current, lifetime: "reused" };
  assert.throws(bound.assertOwned, /lifetime ended or changed/);
  current = f.identity;
  owner = 9999;
  assert.throws(bound.assertOwned, /endpoint changed owner/);
});

test("helper identity includes the exact receipt and token, not merely node.exe", t => {
  const f = fixture(t);
  const script = path.join(f.root, "bridge", "desktop-patch.mjs");
  const receiptFile = path.join(f.home, "desktop-instance.json");
  const helperToken = randomUUID();
  const helper = { executable: process.execPath, platform: process.platform,
    args: [process.execPath, script, "--instance", receiptFile, "--token", helperToken] };
  assert.equal(helperProcessMatches(helper, { script, receiptFile, helperToken }), true);
  assert.equal(helperProcessMatches(helper, { script, receiptFile, helperToken: randomUUID() }), false);
  assert.equal(helperProcessMatches({ ...helper, args: [...helper.args, "--unrelated"] },
    { script, receiptFile, helperToken }), false);
});

test("profile launch lock refuses an active owner without deleting or stopping it", t => {
  const f = fixture(t);
  const mine = { pid: process.pid, platform: process.platform,
    lifetime: "fixture-launcher", executable: process.execPath };
  const inspectProcess = () => mine;
  const release = acquireDesktopStartLock(f.home, { inspectProcess });
  const file = path.join(f.home, "desktop-launch.lock");
  const bytes = fs.readFileSync(file, "utf8");
  assert.throws(() => acquireDesktopStartLock(f.home, { inspectProcess }), /already starting/);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  release();
  assert.equal(fs.existsSync(file), false);
});

test("profile launch lock only reclaims a recognized exited lifetime", t => {
  const f = fixture(t);
  const file = path.join(f.home, "desktop-launch.lock");
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1, namespace: "codex-copilot/desktop-start", token: randomUUID(),
    identity: { pid: 2345, platform: process.platform, lifetime: "exited", executable: process.execPath },
  }));
  const mine = { pid: process.pid, platform: process.platform,
    lifetime: "fixture-current", executable: process.execPath };
  const release = acquireDesktopStartLock(f.home, {
    inspectProcess: pid => pid === process.pid ? mine : null,
  });
  release();
  fs.writeFileSync(file, '{"schemaVersion":1,"namespace":"other"}');
  const bytes = fs.readFileSync(file, "utf8");
  assert.throws(() => acquireDesktopStartLock(f.home, { inspectProcess: () => mine }), /unrecognized/);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
});

test("profile launch lock release never removes a concurrently replaced value", t => {
  const f = fixture(t);
  const mine = { pid: process.pid, platform: process.platform,
    lifetime: "fixture-launcher", executable: process.execPath };
  const release = acquireDesktopStartLock(f.home, { inspectProcess: () => mine });
  const file = path.join(f.home, "desktop-launch.lock");
  fs.writeFileSync(file, '{"changed":true}');
  assert.throws(release, /changed ownership/);
  assert.equal(fs.readFileSync(file, "utf8"), '{"changed":true}');
});
