import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { adaptersPackageFiles } from "../tools/package-adapters.mjs";

test("candidate packaging excludes publisher state, dependencies and experimental untracked files outside its source scope", () => {
  const files = adaptersPackageFiles();
  assert.ok(files.includes("tools/configure-adapters.mjs"));
  assert.ok(files.includes("assets/catalog-templates.json"), "The native compatibility probe consumes catalog data through fs, not an ESM import");
  assert.ok(files.includes("release/adapters-sdk/package-lock.json"));
  assert.ok(files.includes("gateway/server.mjs"));
  assert.ok(files.includes("tools/typescript-build-manifest.json"));
  assert.ok(files.every(file => !/^(?:tests|docs|dist|profiles?|runtime)\//.test(file) && !file.includes("node_modules/")));
  assert.ok(files.every(file => !/model-sources|conversation-handoff|squad-lite/.test(file)));
});

test("candidate packaging refuses credential-shaped content without returning the credential", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adapters-package-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  fs.mkdirSync(path.join(root, "bridge"));
  const token = "gh" + "p_" + "a".repeat(40);
  fs.writeFileSync(path.join(root, "bridge", "example.mjs"), JSON.stringify(token));
  assert.throws(() => adaptersPackageFiles(root), error => /源码审计/.test(error.message) && !error.message.includes(token));
});
