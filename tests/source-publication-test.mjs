import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditSourceFiles } from "../tools/check-source-publication.mjs";

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-source-audit-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("ccodex-source-audit-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

test("publishes source, patches, lockfiles and documentation", t => {
  const files = { "bridge/example.mjs": "export const x = 1;\n",
    "patches/example.patch": "diff --git a/example b/example\n",
    "bridge/workiq/package-lock.json": "{}\n", "README.md": "# Source\n" };
  const result = auditSourceFiles(fixture(t, files), Object.keys(files));
  assert.equal(result.passed, true);
  assert.equal(result.files, 4);
});

test("rejects payloads, compiled artifacts and credentials", t => {
  const files = { "runtime/node/config.json": "{}",
    "bin/runtimes/arm64/manifest.json": "{}", "bin/core.exe": "binary",
    "profile/auth.json": "{}", "hosts.yml": "secret" };
  const result = auditSourceFiles(fixture(t, files), Object.keys(files));
  assert.equal(result.passed, false);
  assert.equal(result.findings.length, 5);
});

test("reports credential-shaped content without revealing it", t => {
  const token = "gh" + "p_" + "A".repeat(40);
  const result = auditSourceFiles(fixture(t, { "README.md": token }), ["README.md"]);
  assert.equal(result.passed, false);
  assert.ok(!JSON.stringify(result).includes(token));
});

test("rejects machine-specific Windows user paths", t => {
  const absolute = "C:" + "\\" + "Users" + "\\" + "ExamplePublisher" + "\\work";
  const result = auditSourceFiles(fixture(t, { "README.md": absolute }), ["README.md"]);
  assert.equal(result.passed, false);
  assert.equal(result.findings[0].issue, "machine-specific user path");
});

test("rejects path escape before reading it", t => {
  const result = auditSourceFiles(fixture(t, { "README.md": "safe" }), ["../outside"]);
  assert.equal(result.passed, false);
  assert.equal(result.findings[0].issue, "unsafe source path");
});


test("publishes canonical TypeScript and refuses its generated runtime files", t => {
  const files = { "gateway/example.mts": "export const value: number = 1;\n",
    "gateway/example.mjs": "export const value = 1;\n", "gateway/example.mjs.map": "{}",
    "tools/typescript-build-manifest.json": "{}", "node_modules/typescript/package.json": "{}" };
  const root = fixture(t, files);
  assert.equal(auditSourceFiles(root, ["gateway/example.mts"]).passed, true);
  const result = auditSourceFiles(root, Object.keys(files));
  assert.equal(result.passed, false); assert.equal(result.findings.length, 4);
});
