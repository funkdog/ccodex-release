import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { copyCliComponents, requiredCliComponentFiles, verifyCliComponents } from "../bridge/cli-components.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const targets = ["windows-arm64", "windows-x64", "linux-arm64", "linux-x64", "macos-arm64", "macos-x64"];
function binary(target, label) {
  const bytes = Buffer.alloc(512);
  if (target.startsWith("windows")) {
    bytes.writeUInt16LE(0x5a4d);
    bytes.writeUInt32LE(128, 60);
    bytes.writeUInt32LE(0x00004550, 128);
    bytes.writeUInt16LE(target.endsWith("arm64") ? 0xaa64 : 0x8664, 132);
  } else if (target.startsWith("linux")) {
    bytes.writeUInt32LE(0x464c457f);
    bytes[4] = 2; bytes[5] = 1;
    bytes.writeUInt16LE(target.endsWith("arm64") ? 183 : 62, 18);
  } else {
    bytes.writeUInt32LE(0xfeedfacf);
    bytes.writeUInt32LE(target.endsWith("arm64") ? 0x0100000c : 0x01000007, 4);
  }
  bytes.write(label, 160);
  return bytes;
}

function fixture(t, target = "windows-arm64") {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-components-test-"));
  const source = path.join(temporary, "source");
  const destination = path.join(temporary, "destination");
  fs.mkdirSync(source); fs.mkdirSync(destination);
  const name = target.startsWith("windows") ? "codex-copilot-core.exe" : "codex-copilot-core";
  const core = path.join(source, name);
  const destinationCore = path.join(destination, name);
  fs.writeFileSync(core, binary(target, "parser fixture, not a release core"));
  fs.copyFileSync(core, destinationCore);
  const manifest = { coreVersion: "codex-cli 0.160.0", target,
    sourceRevision: "a".repeat(40), patchedTree: "b".repeat(40), components: [] };
  for (const file of requiredCliComponentFiles(target, manifest.coreVersion)) {
    const bytes = binary(target, file);
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), bytes);
    manifest.components.push({ file, target, sha256: sha(bytes),
      sourceRevision: manifest.sourceRevision, patchedTree: manifest.patchedTree });
  }
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(temporary)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(temporary), /^ccodex-components-test-/);
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  return { temporary, source, destination, core, sourceCore: core, destinationCore, manifest, target };
}

for (const target of targets) {
  test(`${target}: immutable preparation retains all current upstream companion bytes`, t => {
    const f = fixture(t, target);
    assert.deepEqual(copyCliComponents(f), f.manifest.components);
    assert.deepEqual(copyCliComponents(f), f.manifest.components);
    for (const row of f.manifest.components) {
      assert.deepEqual(fs.readFileSync(path.join(f.destination, row.file)),
        fs.readFileSync(path.join(f.source, row.file)));
    }
  });
}

for (const [name, change] of [
  ["missing inventory", f => { delete f.manifest.components; }],
  ["missing runtime", f => { f.manifest.components.pop(); }],
  ["missing file", f => { fs.unlinkSync(path.join(f.source, f.manifest.components[0].file)); }],
  ["different patch tree", f => { f.manifest.components[0].patchedTree = "c".repeat(40); }],
  ["different source", f => { f.manifest.components[0].sourceRevision = "c".repeat(40); }],
  ["wrong architecture", f => {
    const row = f.manifest.components[0];
    const bytes = binary("windows-x64", row.file);
    fs.writeFileSync(path.join(f.source, row.file), bytes);
    row.sha256 = sha(bytes);
  }],
  ["modified bytes", f => { fs.appendFileSync(path.join(f.source, f.manifest.components[0].file), "drift"); }],
  ["duplicate role", f => { f.manifest.components.push({ ...f.manifest.components[0] }); }],
  ["path traversal", f => { f.manifest.components[0].file = "../stock.exe"; }],
]) {
  test(`native companion validation refuses ${name} before selecting or executing a core`, t => {
    const f = fixture(t);
    change(f);
    assert.throws(() => verifyCliComponents(f));
    assert.deepEqual(fs.readdirSync(f.destination), ["codex-copilot-core.exe"]);
  });
}

test("immutable native companion preparation refuses an occupied different file", t => {
  const f = fixture(t);
  const file = path.join(f.destination, f.manifest.components[0].file);
  fs.writeFileSync(file, "user-owned different content");
  assert.throws(() => copyCliComponents(f), /immutable/);
  assert.equal(fs.readFileSync(file, "utf8"), "user-owned different content");
});

test("resource subdirectories preserve native resolution and refuse a file in place of a directory", t => {
  const f = fixture(t);
  assert.ok(f.manifest.components.some(row => row.file === "codex-path/rg.exe"));
  assert.ok(f.manifest.components.some(row =>
    row.file === "codex-resources/codex-command-runner.exe"));
  fs.writeFileSync(path.join(f.destination, "codex-resources"), "existing user file");
  assert.throws(() => copyCliComponents(f));
  assert.equal(fs.readFileSync(path.join(f.destination, "codex-resources"), "utf8"),
    "existing user file");
});

test("old private cores retain their legacy manifest compatibility without relabeling capabilities", t => {
  const f = fixture(t);
  delete f.manifest.components;
  f.manifest.coreVersion = "codex-cli 0.145.0";
  assert.deepEqual(verifyCliComponents(f), []);
});
