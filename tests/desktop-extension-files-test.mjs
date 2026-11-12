import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desktopExtensionFiles } from "../bridge/desktop-extension-files.mjs";
import { sourceFingerprint } from "../bridge/update-state.mjs";

test("Desktop update generation includes lifecycle/repair code and ignores external dependency cache", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-extension-inventory-"));
  fs.mkdirSync(path.join(root, "bridge"), { recursive: true });
  fs.mkdirSync(path.join(root, "tools", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "bridge", "desktop-process.mjs"), "original lifetime inspector");
  fs.writeFileSync(path.join(root, "bridge", "desktop-launcher-macos.swift"), "native shortcut shell");
  fs.writeFileSync(path.join(root, "tools", "native-runtime.mjs"), "repair");
  fs.writeFileSync(path.join(root, "tools", "node_modules", "cache.mjs"), "external cache");
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^ccodex-extension-inventory-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const files = desktopExtensionFiles(root);
  assert.deepEqual(files, ["bridge/desktop-launcher-macos.swift", "bridge/desktop-process.mjs", "tools/native-runtime.mjs"]);
  const before = sourceFingerprint(root, files);
  fs.writeFileSync(path.join(root, "bridge", "desktop-process.mjs"), "changed lifetime inspector");
  assert.notEqual(sourceFingerprint(root, files), before);
  const afterProcessChange = sourceFingerprint(root, files);
  fs.writeFileSync(path.join(root, "bridge", "desktop-launcher-macos.swift"), "changed native shortcut shell");
  assert.notEqual(sourceFingerprint(root, files), afterProcessChange);
  fs.writeFileSync(path.join(root, "tools", "node_modules", "cache.mjs"), "changed external cache");
  assert.deepEqual(desktopExtensionFiles(root), files);
});

test("Desktop installer cannot replace an existing snapshot selection during ordinary reinstall", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname,
    "../tools/Install-DesktopSnapshot.ps1"), "utf8");
  const pointerBlock = source.slice(source.indexOf("if (-not $PrepareOnly)"));
  assert.match(pointerBlock, /Existing independent Desktop selection was preserved/);
  assert.doesNotMatch(pointerBlock, /File\]::Replace/);
  assert.match(pointerBlock, /File\]::Move\(\$pending, \$pointer\)/);
});

test("candidate validator never marks fixture-only native UI as preserved", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname,
    "../tools/Validate-DesktopUpdate.ps1"), "utf8");
  assert.match(source, /desktop-extension-files\.mjs/);
  assert.match(source, /nativeUiPreserved = \$false/);
  assert.match(source, /contextExtensionVerified = \$false/);
});
