import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { FileValidationCache, fileSignature, validatedFileSha256,
  withFileValidation } from "../bridge/file-validation-cache.mjs";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-startup-validation-"));
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

function fixture(name) {
  const root = path.join(temporary, name), home = path.join(root, "profile");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, ".ccodex-release-profile.json"), '{"product":"CCodexRelease"}');
  const file = path.join(root, "core.exe");
  fs.writeFileSync(file, "verified-bytes");
  return { root, home, file, generation: "release:fixed", cache: new FileValidationCache({
    root, home, generation: "release:fixed",
  }) };
}

test("installed validation caches complete file identities, not just filename or size", async () => {
  const f = fixture("reuse");
  const expected = createHash("sha256").update("verified-bytes").digest("hex");
  await withFileValidation(f.cache, () => assert.equal(validatedFileSha256(f.file), expected));
  assert.equal(f.cache.hashes, 1);
  const next = new FileValidationCache(f);
  await withFileValidation(next, () => assert.equal(validatedFileSha256(f.file), expected));
  assert.equal(next.hashes, 0);
  assert.equal(next.hits, 1);
});

test("same-size replacement invalidates persistent startup validation", async () => {
  const f = fixture("changed");
  await withFileValidation(f.cache, () => validatedFileSha256(f.file));
  const old = fileSignature(f.file);
  fs.writeFileSync(f.file, "tampered-bytes");
  assert.notEqual(fileSignature(f.file), old);
  const next = new FileValidationCache(f);
  await withFileValidation(next, () =>
    assert.notEqual(validatedFileSha256(f.file), f.cache.entries[f.file.toLowerCase()]?.sha256));
  assert.equal(next.hashes, 1);
});

test("restoring last-write time does not hide a resource modification", async () => {
  const f = fixture("restored-time");
  await withFileValidation(f.cache, () => validatedFileSha256(f.file));
  const old = fs.statSync(f.file);
  const signature = fileSignature(f.file);
  await new Promise(resolve => setTimeout(resolve, 25));
  fs.writeFileSync(f.file, "tampered-bytes");
  fs.utimesSync(f.file, old.atime, old.mtime);
  assert.notEqual(fileSignature(f.file), signature);
  const next = new FileValidationCache(f);
  await withFileValidation(next, () => validatedFileSha256(f.file));
  assert.equal(next.hashes, 1);
});

test("a different immutable slot cannot reuse the previous validation generation", async () => {
  const f = fixture("generation");
  await withFileValidation(f.cache, () => validatedFileSha256(f.file));
  const next = new FileValidationCache({ ...f, generation: "another-release" });
  await withFileValidation(next, () => validatedFileSha256(f.file));
  assert.equal(next.hashes, 1);
});

test("malformed cache data falls back to full verification without using cached digests", async () => {
  const f = fixture("malformed");
  fs.writeFileSync(path.join(f.home, "startup-validation.json"), '{"invalid":');
  const next = new FileValidationCache(f);
  await withFileValidation(next, () => validatedFileSha256(f.file));
  assert.equal(next.hashes, 1);
  assert.equal(JSON.parse(fs.readFileSync(next.file, "utf8")).schemaVersion, 1);
});

test("deleting cached resources fails rather than borrowing a system binary", async () => {
  const f = fixture("missing");
  await withFileValidation(f.cache, () => validatedFileSha256(f.file));
  fs.unlinkSync(f.file);
  await assert.rejects(withFileValidation(new FileValidationCache(f), () =>
    validatedFileSha256(f.file)), /ENOENT/);
});

test("linked resources never qualify for cached startup validation", async t => {
  const f = fixture("linked");
  const other = path.join(temporary, "outside.exe");
  fs.writeFileSync(other, "other");
  const directory = path.join(f.root, "redirect");
  try { fs.symlinkSync(temporary, directory, process.platform === "win32" ? "junction" : "dir"); }
  catch { t.skip("The host does not allow a junction."); return; }
  try {
    await assert.rejects(withFileValidation(f.cache, () =>
      validatedFileSha256(path.join(directory, "outside.exe"))), /symbolic link|junction/);
  } finally { fs.unlinkSync(directory); }
});
