import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { binaryTarget, componentInventory, manifestFields } from "../tools/write-core-manifest.mjs";
import { requiredCliComponentFiles } from "../bridge/cli-components.mjs";

test("core manifest writer recognizes each architecture from executable headers", () => {
  for (const [target, machine] of [["windows-arm64", 0xaa64], ["windows-x64", 0x8664]]) {
    const header = Buffer.alloc(256);
    header.writeUInt16LE(0x5a4d, 0);
    header.writeUInt32LE(0x80, 0x3c);
    header.writeUInt32LE(0x00004550, 0x80);
    header.writeUInt16LE(machine, 0x84);
    assert.equal(binaryTarget(header), target);
  }
  for (const [target, machine] of [["linux-arm64", 183], ["linux-x64", 62]]) {
    const header = Buffer.alloc(64);
    header.writeUInt32LE(0x464c457f, 0);
    header.writeUInt16LE(machine, 18);
    assert.equal(binaryTarget(header), target);
  }
  for (const [target, machine] of [
    ["macos-arm64", 0x0100000c], ["macos-x64", 0x01000007],
  ]) {
    const header = Buffer.alloc(64);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(machine, 4);
    assert.equal(binaryTarget(header), target);
  }
  assert.equal(binaryTarget(Buffer.alloc(64)), null);
});

test("manifest records actual provenance and does not invent runtime verification", () => {
  const input = {
    target: "windows-arm64",
    version: "1.2.27",
    revision: "a".repeat(40),
    tree: "b".repeat(40),
    coreVersion: "codex-cli 0.145.0",
    coreHash: "C".repeat(64),
    runtimeVerified: false,
    patches: [{ name: "codex-context-picker.patch", sha256: "D".repeat(64) }],
  };
  const manifest = manifestFields(input);
  assert.deepEqual({ ...manifest, builtAt: null }, {
    schemaVersion: 1,
    packageVersion: "1.2.27",
    sourceRevision: input.revision,
    patchedTree: input.tree,
    target: input.target,
    coreVersion: input.coreVersion,
    sha256: input.coreHash,
    runtimeVerified: false,
    patches: input.patches,
    builtAt: null,
  });
  assert.match(manifest.builtAt, /^\d{4}-\d\d-\d\dT/);
  assert.throws(() => manifestFields({ ...input, target: "windows-other" }), /windows-other/);
});

test("current native manifests require real complete companion files and retain their source binding", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-manifest-components-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(directory), /^ccodex-manifest-components-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const context = { target: "windows-arm64", coreVersion: "codex-cli 0.160.0",
    revision: "a".repeat(40), tree: "b".repeat(40) };
  const core = path.join(directory, "codex-copilot-core.exe");
  const fields = { ...context, version: "1.2.35", coreHash: "C".repeat(64),
    runtimeVerified: false, patches: [{ name: "fixture.patch", sha256: "D".repeat(64) }] };
  assert.throws(() => manifestFields(fields), /companion inventory/);
  await assert.rejects(componentInventory(core, context));
  const expected = [];
  for (const file of requiredCliComponentFiles(context.target, context.coreVersion)) {
    const bytes = Buffer.alloc(256);
    bytes.writeUInt16LE(0x5a4d);
    bytes.writeUInt32LE(128, 60);
    bytes.writeUInt32LE(0x00004550, 128);
    bytes.writeUInt16LE(0xaa64, 132);
    bytes.write("parser fixture; never a runtime acceptance", 160);
    const filename = path.join(directory, file);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
    expected.push({ file, target: context.target,
      sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
      sourceRevision: context.revision, patchedTree: context.tree });
  }
  const components = await componentInventory(core, context);
  assert.deepEqual(components, expected);
  assert.equal(manifestFields({ ...fields, components }).runtimeVerified, false);
  const changed = path.join(directory, requiredCliComponentFiles(context.target, context.coreVersion)[0]);
  const bytes = fs.readFileSync(changed);
  bytes.writeUInt16LE(0x8664, 132);
  fs.writeFileSync(changed, bytes);
  await assert.rejects(componentInventory(core, context), /architecture/);
});
