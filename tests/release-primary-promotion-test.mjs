import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renamePrivateResource, restorePinnedPrimaryRuntime } from "../release/primary-overrides.mjs";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-private-promotion-"));
test.after(() => fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function fixture(name) {
  const directory = path.join(temporary, name);
  fs.mkdirSync(directory);
  const from = path.join(directory, "pending"), to = path.join(directory, "active");
  fs.mkdirSync(from);
  fs.writeFileSync(path.join(from, "resource.txt"), "pinned");
  return { from, to };
}

function clock() {
  let elapsed = 0;
  const waits = [];
  return { now: () => elapsed, sleep: value => { waits.push(value); elapsed += value; }, waits };
}

test("Windows private resource promotion retries transient locks without changing permissions", () => {
  const { from, to } = fixture("temporary-lock");
  const timing = clock();
  const errors = ["EPERM", "EACCES", "EBUSY"];
  let attempts = 0;
  renamePrivateResource(from, to, {
    ...timing, platform: "win32", timeoutMs: 1000,
    rename(source, destination) {
      const code = errors[attempts++];
      if (code) throw Object.assign(new Error("synthetic scanner lock"), { code });
      fs.renameSync(source, destination);
    },
  });
  assert.equal(attempts, 4);
  assert.deepEqual(timing.waits, [100, 100, 100]);
  assert.equal(fs.readFileSync(path.join(to, "resource.txt"), "utf8"), "pinned");
  assert.equal(fs.existsSync(from), false);
});

test("persistent private-resource permission failure is bounded and preserves the source", () => {
  const { from, to } = fixture("persistent-lock");
  const timing = clock();
  const failure = Object.assign(new Error("synthetic persistent lock"), { code: "EPERM" });
  let attempts = 0;
  assert.throws(() => renamePrivateResource(from, to, {
    ...timing, platform: "win32", timeoutMs: 250,
    rename() { attempts++; throw failure; },
  }), error => error === failure);
  assert.equal(attempts, 4);
  assert.deepEqual(timing.waits, [100, 100, 50]);
  assert.equal(fs.readFileSync(path.join(from, "resource.txt"), "utf8"), "pinned");
  assert.equal(fs.existsSync(to), false);
});

test("unexpected resource errors do not retry or mutate a destination", () => {
  const { from, to } = fixture("unexpected-error");
  const timing = clock();
  const failure = Object.assign(new Error("synthetic conflicting destination"), { code: "EEXIST" });
  assert.throws(() => renamePrivateResource(from, to, {
    ...timing, platform: "win32", rename() { throw failure; },
  }), error => error === failure);
  assert.deepEqual(timing.waits, []);
  assert.equal(fs.existsSync(from), true);
  assert.equal(fs.existsSync(to), false);
});

test("non-Windows resource promotion retains immediate error handling", () => {
  const { from, to } = fixture("non-windows");
  const timing = clock();
  assert.throws(() => renamePrivateResource(from, to, {
    ...timing, platform: "linux",
    rename() { throw Object.assign(new Error("synthetic denied access"), { code: "EACCES" }); },
  }), /denied access/);
  assert.deepEqual(timing.waits, []);
});

test("resource promotion revalidates junction boundaries before every retry", () => {
  const { from, to } = fixture("junction");
  const foreign = path.join(temporary, "foreign");
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, "preserved.txt"), "foreign");
  let attempts = 0;
  assert.throws(() => renamePrivateResource(from, to, {
    platform: "win32", now: () => 0, timeoutMs: 100,
    rename() { attempts++; throw Object.assign(new Error("synthetic lock"), { code: "EBUSY" }); },
    sleep() { fs.symlinkSync(foreign, to, "junction"); },
  }), /symbolic links or junctions/);
  assert.equal(attempts, 1);
  assert.equal(fs.readFileSync(path.join(foreign, "preserved.txt"), "utf8"), "foreign");
  fs.unlinkSync(to);
});

test("failed runtime activation restores the old private runtime and preserves user data", () => {
  const root = path.join(temporary, "rollback-source"), home = path.join(temporary, "rollback-profile");
  const source = path.join(root, "runtime", "primary", "codex-primary-runtime");
  const target = path.join(home, "host-profile", ".cache", "codex-runtimes", "codex-primary-runtime");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(source, "runtime.json"), JSON.stringify({
    bundleVersion: "fixed", targetArch: process.arch, artifactToolVersion: "tool",
  }));
  const old = JSON.stringify({ bundleVersion: "old", targetArch: process.arch, artifactToolVersion: "tool" });
  fs.writeFileSync(path.join(target, "runtime.json"), old);
  fs.writeFileSync(path.join(target, "old-resource.txt"), "preserved");
  fs.writeFileSync(path.join(home, "config.toml"), "user-preference");
  fs.writeFileSync(path.join(home, "github-auth.json"), '{"synthetic":"not-a-token"}');
  const timing = clock();
  assert.throws(() => restorePinnedPrimaryRuntime(root, home, () => null, {
    ...timing, platform: "win32", timeoutMs: 250,
    rename(from, to) {
      if (from.includes(".release-"))
        throw Object.assign(new Error("synthetic persistent activation failure"), { code: "EPERM" });
      fs.renameSync(from, to);
    },
  }), /persistent activation failure/);
  assert.equal(fs.readFileSync(path.join(target, "runtime.json"), "utf8"), old);
  assert.equal(fs.readFileSync(path.join(target, "old-resource.txt"), "utf8"), "preserved");
  assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), "user-preference");
  assert.equal(fs.readFileSync(path.join(home, "github-auth.json"), "utf8"), '{"synthetic":"not-a-token"}');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["codex-primary-runtime"]);
});
