import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { synchronizePrimaryOverrides, restorePinnedPrimaryRuntime } from "../release/primary-overrides.mjs";
import { sha256File } from "../release/integrity.mjs";

const root = path.resolve(import.meta.dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-runtime-overrides-"));
const overrides = JSON.parse(fs.readFileSync(path.join(root, "release", "runtime-overrides.json"), "utf8"));
const skia = overrides.changes.find(change => change.name === "skia-canvas");
const portability = overrides.changes.find(change => change.name === "windows-document-paths");
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test("bundle drift restores the complete private runtime without changing user preferences or credentials", () => {
  const syntheticRoot = path.join(temporary, "drift-source");
  const source = path.join(syntheticRoot, "runtime", "primary", "codex-primary-runtime");
  fs.mkdirSync(source, { recursive: true });
  const expected = { bundleVersion: "fixed", targetArch: process.arch, artifactToolVersion: "fixed-tool" };
  fs.writeFileSync(path.join(source, "runtime.json"), JSON.stringify(expected));
  fs.writeFileSync(path.join(source, "pinned-resource.txt"), "fixed-bytes");
  const home = path.join(temporary, "drift-profile");
  const target = path.join(home, "host-profile", ".cache", "codex-runtimes", "codex-primary-runtime");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "runtime.json"), JSON.stringify({ ...expected, bundleVersion: "foreign" }));
  fs.writeFileSync(path.join(target, "foreign-resource.txt"), "foreign");
  fs.writeFileSync(path.join(home, "config.toml"), "destination-preference");
  fs.writeFileSync(path.join(home, "github-auth.json"), '{"synthetic":"not-a-token"}');
  assert.deepEqual(restorePinnedPrimaryRuntime(syntheticRoot, home, () => null),
    { changed: true, bundleVersion: "fixed" });
  assert.equal(fs.readFileSync(path.join(target, "pinned-resource.txt"), "utf8"), "fixed-bytes");
  assert.equal(fs.existsSync(path.join(target, "foreign-resource.txt")), false);
  assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), "destination-preference");
  assert.equal(fs.readFileSync(path.join(home, "github-auth.json"), "utf8"), '{"synthetic":"not-a-token"}');
  assert.deepEqual(restorePinnedPrimaryRuntime(syntheticRoot, home, () => null),
    { changed: false, bundleVersion: "fixed" });
});

test("bundle drift recovery refuses replacement while the owning Desktop is running", () => {
  const syntheticRoot = path.join(temporary, "live-drift-source");
  const source = path.join(syntheticRoot, "runtime", "primary", "codex-primary-runtime");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "runtime.json"), JSON.stringify({
    bundleVersion: "fixed", targetArch: process.arch, artifactToolVersion: "fixed",
  }));
  const home = path.join(temporary, "live-drift-profile");
  fs.mkdirSync(home);
  const identity = { pid: 31416, platform: "win32", executable: "synthetic.exe", lifetime: "test:5678" };
  fs.writeFileSync(path.join(home, "desktop-instance.json"), JSON.stringify({ identity }));
  assert.throws(() => restorePinnedPrimaryRuntime(syntheticRoot, home, () => identity), /Close this release/);
  assert.equal(fs.existsSync(path.join(home, "host-profile")), false);
});

test("private document cache is repaired from complete pinned resources without touching user data", () => {
  const home = path.join(temporary, "profile");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "user-owned.txt"), "keep");
  const result = synchronizePrimaryOverrides(root, home, () => null);
  assert(result.changed > 0);
  const target = path.join(home, "host-profile", ".cache", "codex-runtimes", "codex-primary-runtime",
    skia.locations[0].slice("runtime/primary/codex-primary-runtime/".length), "lib", "skia.node");
  assert.equal(sha256File(target), skia.nativeSha256);
  assert.equal(synchronizePrimaryOverrides(root, home, () => null).changed, 0);
  assert.equal(fs.readFileSync(path.join(home, "user-owned.txt"), "utf8"), "keep");
  for (const file of portability.files) {
    const installed = path.join(home, "host-profile", ".cache", "codex-runtimes", "codex-primary-runtime",
      file.path.slice("runtime/primary/codex-primary-runtime/".length));
    assert.equal(sha256File(installed), file.sha256);
  }
});

test("fixed document path resources are integrity-checked before replacing private cached files", () => {
  const home = path.join(temporary, "damaged-resource");
  fs.mkdirSync(home);
  const cloned = path.join(temporary, "resource-source");
  fs.mkdirSync(path.join(cloned, "release"), { recursive: true });
  fs.writeFileSync(path.join(cloned, "release", "runtime-overrides.json"), JSON.stringify({
    schemaVersion: 1, changes: [portability],
  }));
  for (const file of portability.files) {
    const target = path.join(cloned, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file.path), target);
  }
  fs.writeFileSync(path.join(cloned, portability.files[0].path), "not-the-pinned-native-adapter");
  assert.throws(() => synchronizePrimaryOverrides(cloned, home, () => null), /damaged/);
  assert.equal(fs.existsSync(path.join(home, "host-profile")), false);
});

test("live private Desktop lifetimes block cache replacement before writes", () => {
  const home = path.join(temporary, "live");
  fs.mkdirSync(home);
  const identity = { pid: 31415, platform: "win32", executable: "test.exe", lifetime: "test:1234" };
  fs.writeFileSync(path.join(home, "desktop-instance.json"), JSON.stringify({ identity }));
  assert.throws(() => synchronizePrimaryOverrides(root, home, () => identity), /Close this release/);
  assert.equal(fs.existsSync(path.join(home, "host-profile")), false);
});

test("private runtime writes refuse a junction into another product", t => {
  const home = path.join(temporary, "redirect"), foreign = path.join(temporary, "foreign");
  fs.mkdirSync(home);
  fs.mkdirSync(foreign);
  const link = path.join(home, "host-profile");
  try { fs.symlinkSync(foreign, link, "junction"); }
  catch { t.skip("Host cannot create junctions"); return; }
  try {
    assert.throws(() => synchronizePrimaryOverrides(root, home, () => null), /junctions/);
    assert.equal(fs.readdirSync(foreign).length, 0);
  } finally { fs.unlinkSync(link); }
});
