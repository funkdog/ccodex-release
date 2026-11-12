import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const chain = JSON.parse(fs.readFileSync(path.join(root, "NATIVE_PATCH_CHAIN.json"), "utf8"));
const sourceRevision = fs.readFileSync(path.join(root, "CODEX-SOURCE-REVISION"), "utf8").trim();
assert.equal(chain.schemaVersion, 1);
assert.equal(chain.sourceRevision, sourceRevision, "patch chain must use the pinned upstream revision");
assert.match(chain.patchedTree, /^[0-9a-f]{40}$/);
assert.ok(Array.isArray(chain.patches) && chain.patches.length > 0);
assert.equal(new Set(chain.patches).size, chain.patches.length);
for (const name of chain.patches) {
  assert.equal(path.basename(name), name, "patch names must not escape the patch directory");
  assert.match(name, /^[a-z0-9-]+\.patch$/);
  assert.ok(fs.statSync(path.join(root, "patches", name)).isFile(), `missing patch: ${name}`);
}

if (process.argv[2] === "--check-chain") {
  process.stdout.write(`Validated ${chain.patches.length} ordered patches for ${sourceRevision}.\n`);
} else {
  const source = process.argv[2] && path.resolve(process.argv[2]);
  if (!source || !fs.existsSync(path.join(source, ".git"))) {
    throw new Error("Provide a clean, checked-out Codex source directory.");
  }
  const revision = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(revision, sourceRevision, "Codex source revision differs from the release pin");
  const dirty = execFileSync("git", ["-C", source, "status", "--porcelain"], { encoding: "utf8" }).trim();
  assert.equal(dirty, "", "patches require a clean source checkout");
  for (const name of chain.patches) {
    const file = path.join(root, "patches", name);
    execFileSync("git", ["-C", source, "apply", "--check", file], { stdio: "inherit" });
    execFileSync("git", ["-C", source, "apply", file], { stdio: "inherit" });
    process.stdout.write(`Applied ${name}\n`);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-patch-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, "index") };
    execFileSync("git", ["-C", source, "read-tree", "HEAD"], { env, stdio: "inherit" });
    execFileSync("git", ["-C", source, "add", "-A"], { env, stdio: "inherit" });
    const actualTree = execFileSync("git", ["-C", source, "write-tree"], { env, encoding: "utf8" }).trim();
    assert.equal(actualTree, chain.patchedTree, "applied source tree differs from the declared release tree");
    process.stdout.write(`Applied ${chain.patches.length} patches; verified tree ${actualTree}.\n`);
  } finally {
    if (path.dirname(fs.realpathSync(temporary)) !== fs.realpathSync(os.tmpdir())
      || !path.basename(temporary).startsWith("ccodex-patch-index-")) {
      throw new Error("Refusing unexpected patch-index cleanup target.");
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
