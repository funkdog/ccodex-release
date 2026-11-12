import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyRelease } from "../release/verify.mjs";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-verification-regression-"));
const names = ["USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP",
  "CCODEX_REAL_USERPROFILE", "CCODEX_REAL_LOCALAPPDATA", "CCODEX_REAL_APPDATA", "CCODEX_REAL_TEMP"];
const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
const user = path.join(temporary, "user");
Object.assign(process.env, {
  USERPROFILE: user, HOME: user, LOCALAPPDATA: path.join(user, "AppData", "Local"),
  APPDATA: path.join(user, "AppData", "Roaming"), TEMP: path.join(temporary, "temp"),
  TMP: path.join(temporary, "temp"),
});
for (const name of names.filter(name => name.startsWith("CCODEX_REAL_"))) delete process.env[name];
fs.mkdirSync(process.env.TEMP, { recursive: true });
const home = path.join(process.env.LOCALAPPDATA, "CCodexRelease", "profile");
test.after(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
});

test("payload verification leaves a missing default profile completely absent", async () => {
  assert.equal(fs.existsSync(home), false);
  const result = await verifyRelease({ inventory: false });
  assert.equal(result.passed, true);
  assert(result.tests.some(row => row.name === "actual-document-roundtrips-and-python-rpc"));
  assert.equal(fs.existsSync(home), false);
  assert.equal(fs.readdirSync(process.env.TEMP).some(name => name.startsWith("ccodex-release-verify-")), false);
});

test("payload verification preserves unowned default data and cleans all probe scratch homes", async () => {
  fs.mkdirSync(home, { recursive: true });
  const sentinel = path.join(home, "unknown-data.txt");
  fs.writeFileSync(sentinel, "do-not-adopt-or-delete");
  const before = fs.statSync(sentinel);
  const result = await verifyRelease({ inventory: false });
  assert.equal(result.passed, true);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "do-not-adopt-or-delete");
  assert.equal(fs.statSync(sentinel).mtimeMs, before.mtimeMs);
  assert.deepEqual(fs.readdirSync(home), ["unknown-data.txt"]);
  assert.equal(fs.readdirSync(process.env.TEMP).some(name => name.startsWith("ccodex-release-verify-")), false);
});
