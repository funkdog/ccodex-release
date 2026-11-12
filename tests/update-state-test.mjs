import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promoteDesktopUpdate, sourceFingerprint, DESKTOP_DOWNLOADS } from "../bridge/update-state.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-update-state-"));
  fs.mkdirSync(path.join(root, "desktop"));
  fs.mkdirSync(path.join(root, "bridge"));
  fs.writeFileSync(path.join(root, "bridge", "context.mjs"), "export const revision = 4;\n");
  const pointer = path.join(root, "desktop", "current.json");
  fs.writeFileSync(pointer, '{"schemaVersion":1,"version":"26.928.3736.0-0123456789ab"}\n');
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^ccodex-update-state-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, pointer, before: fs.readFileSync(pointer, "utf8"),
    candidate: "26.930.1000.0-abcdef012345",
    extensionFiles: ["bridge/context.mjs"],
    preparedReceipt: { signedVendorPackage: true },
    validate: async ({ candidate, extensionGeneration }) => ({
      passed: true, candidate, extensionGeneration,
      nativeUiPreserved: true, contextExtensionVerified: true,
    }),
  };
}

test("Desktop update promotes only its own pointer after matching extension/native-UI checks", async t => {
  const f = fixture(t);
  const result = await promoteDesktopUpdate(f);
  assert.equal(result.status, "promoted");
  assert.equal(result.originalInstallationModified, false);
  const selected = JSON.parse(fs.readFileSync(f.pointer, "utf8"));
  assert.equal(selected.version, f.candidate);
  assert.equal(selected.extensionGeneration, sourceFingerprint(f.root, f.extensionFiles));
});

for (const invalid of [
  { passed: false },
  { nativeUiPreserved: false },
  { contextExtensionVerified: false },
  { candidate: "unrelated-candidate" },
  { extensionGeneration: "unrelated-source" },
]) {
  test(`Desktop update preserves old selection on ${JSON.stringify(invalid)}`, async t => {
    const f = fixture(t);
    const valid = f.validate;
    f.validate = async input => ({ ...await valid(input), ...invalid });
    await assert.rejects(promoteDesktopUpdate(f), /lacks matching/);
    assert.equal(fs.readFileSync(f.pointer, "utf8"), f.before);
    const receipts = fs.readdirSync(path.join(f.root, "desktop", "update-history"));
    assert.equal(receipts.length, 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(f.root, "desktop", "update-history", receipts[0])));
    assert.equal(receipt.status, "rejected");
  });
}

test("Desktop update never overwrites a concurrent user selection", async t => {
  const f = fixture(t);
  const valid = f.validate;
  const newer = '{"version":"26.929.1000.0-111111111111"}\n';
  f.validate = async input => {
    fs.writeFileSync(f.pointer, newer);
    return valid(input);
  };
  await assert.rejects(promoteDesktopUpdate(f), /concurrently/);
  assert.equal(fs.readFileSync(f.pointer, "utf8"), newer);
});

test("Desktop update cannot claim validation for changed extension code", async t => {
  const f = fixture(t);
  const valid = f.validate;
  f.validate = async input => {
    fs.writeFileSync(path.join(f.root, "bridge", "context.mjs"), "changed after validation");
    return valid(input);
  };
  await assert.rejects(promoteDesktopUpdate(f), /changed during/);
  assert.equal(fs.readFileSync(f.pointer, "utf8"), f.before);
});

test("Desktop update endpoint map uses only the official package origin", () => {
  for (const value of Object.values(DESKTOP_DOWNLOADS)) {
    const url = new URL(value);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "persistent.oaistatic.com");
  }
});

test("extension fingerprint refuses a directory junction outside its installation", t => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-update-outside-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(outside)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(outside), /^ccodex-update-outside-/);
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(outside, "foreign.mjs"), "not part of this extension");
  fs.symlinkSync(outside, path.join(f.root, "linked"),
    process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => sourceFingerprint(f.root, ["linked/foreign.mjs"]), /through a link/);
});

test("Desktop update propagates validation failure and retains the exact previous pointer", async t => {
  const f = fixture(t);
  f.validate = async () => { throw new Error("native renderer contract is incompatible"); };
  let receipt;
  await assert.rejects(promoteDesktopUpdate(f), error => {
    receipt = error.updateReceipt;
    return error.message === "native renderer contract is incompatible";
  });
  assert.equal(fs.readFileSync(f.pointer, "utf8"), f.before);
  assert.equal(JSON.parse(fs.readFileSync(receipt)).status, "rejected");
});

test("Desktop update rechecks the initiating private instance after asynchronous validation", async t => {
  const f = fixture(t);
  let owned = true;
  const validate = f.validate;
  f.assertOwned = () => { if (!owned) throw new Error("private instance lifetime ended"); };
  f.validate = async input => { owned = false; return validate(input); };
  await assert.rejects(promoteDesktopUpdate(f), /lifetime ended/);
  assert.equal(fs.readFileSync(f.pointer, "utf8"), f.before);
});
