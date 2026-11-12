import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeRepairInventory } from "../tools/native-repair-inventory.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-repair-inventory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const folder of ["bridge", "bridge/workiq", "tools", "src"]) {
    fs.mkdirSync(path.join(root, folder), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "src", "launcher.cs"), "synthetic source");
  fs.writeFileSync(path.join(root, "tools", "native-repair-files.json"),
    JSON.stringify(["src/launcher.cs", "bridge/server.mjs"]));
  fs.writeFileSync(path.join(root, "bridge", "server.mjs"), "synthetic server");
  return root;
}

test("complete repair inventory includes newly imported modules, nested dependencies and tools", t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "bridge", "copilot-account.mjs"), "synthetic dependency");
  fs.writeFileSync(path.join(root, "bridge", "workiq", "package.json"), "{}");
  fs.writeFileSync(path.join(root, "tools", "future-helper.mjs"), "synthetic helper");
  const files = nativeRepairInventory(root);
  assert.deepEqual(files, [
    "bridge/copilot-account.mjs", "bridge/server.mjs", "bridge/workiq/package.json",
    "src/launcher.cs", "tools/future-helper.mjs", "tools/native-repair-files.json",
  ]);
  assert.equal(files.filter(file => file === "bridge/server.mjs").length, 1);
});

test("repair inventory rejects missing, escaped and non-file declared inputs", t => {
  const root = fixture(t);
  const manifest = path.join(root, "tools", "native-repair-files.json");
  for (const input of ["../outside.mjs", "C:\\outside.mjs", "bridge", "bridge/missing.mjs"]) {
    fs.writeFileSync(manifest, JSON.stringify([input]));
    assert.throws(() => nativeRepairInventory(root));
  }
});

test("real repair source binds the exact dependency that the old partial deployment omitted", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const files = nativeRepairInventory(root);
  assert(files.includes("bridge/copilot-account.mjs"));
  assert(files.includes("bridge/auth.mjs"));
  assert(files.includes("bridge/responses-errors.mjs"));
  assert(files.includes("tools/native-repair-inventory.mjs"));
  assert(files.includes("tools/history/ui.html"));
  assert(files.includes("tools/history/desktop.cmd"));
  assert(files.includes("bin/ccodex.cmd"));
  assert(files.includes("tests/windows-cli-launcher-test.mjs"));
});
