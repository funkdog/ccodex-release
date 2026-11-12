import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { dpapi } from "../bridge/workiq/cache.mjs";
import { ActionQueue } from "../bridge/workiq/actions.mjs";
import { configure, readSettings, writeSettings } from "../bridge/workiq/settings.mjs";

const windows = { skip: process.platform !== "win32", timeout: 60_000 };
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-workiq-vault-test-"));
const unicode = "隔离测试🙂不发送也不修改。";
function legacy(operation, input, purpose) {
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const response = spawnSync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    path.join(import.meta.dirname, "fixtures", "workiq", "legacy-vault.ps1"),
    "-Operation", operation, "-Purpose", purpose,
  ], { input, encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(response.status, 0, "The synthetic legacy codec must complete.");
  return response.stdout;
}

for (const purpose of ["token-cache", "action-record"]) {
  test(`Windows ${purpose} byte pipe preserves long Unicode JSON and its ending`, windows, () => {
    for (const repetitions of [45, 600]) {
      const plain = JSON.stringify({ synthetic: unicode.repeat(repetitions), ending: "END" });
      const restored = dpapi("unprotect", dpapi("protect", plain, { purpose }), { purpose });
      assert.equal(restored, plain);
      assert.equal(JSON.parse(restored).ending, "END");
    }
  });
}

test("Windows vault byte pipe preserves control characters and a large result", windows, () => {
  for (const plain of [
    `SYNTHETIC\u0000${unicode}\u001a\r\nEND`,
    JSON.stringify({ synthetic: "SYNTHETIC DATA ONLY/+=".repeat(7000) + unicode.repeat(300), ending: "END" }),
  ]) {
    assert.equal(dpapi("unprotect", dpapi("protect", plain, { purpose: "action-record" }), { purpose: "action-record" }), plain);
  }
});

test("Windows vault retains both directions of the existing ASCII DPAPI format", windows, () => {
  const plain = JSON.stringify({ synthetic: "NOT_REAL_CREDENTIALS/+=".repeat(100), ending: "END" });
  for (const purpose of ["token-cache", "action-record"]) {
    assert.equal(dpapi("unprotect", legacy("protect", plain, purpose), { purpose }), plain);
    assert.equal(legacy("unprotect", dpapi("protect", plain, { purpose }), purpose), plain);
  }
});

test("real DPAPI action review preserves Unicode requests, hashes and saved results", windows, async () => {
  const profile = path.join(temporary, "isolated-action-profile");
  configure({ profile, enable: true, acknowledge: true });
  writeSettings({
    ...readSettings(profile),
    selectedAccountId: "SYNTHETIC_ACCOUNT_NO_AUTHENTICATION",
    selectedTenantId: "00000000-0000-4000-8000-000000000001",
  }, profile);
  const queue = new ActionQueue(profile);
  const params = { name: "ask", arguments: { question: unicode.repeat(100), ending: "END" } };
  const pending = await queue.enqueue(params);
  assert.equal(pending.executed, false);
  assert.deepEqual((await queue.show(pending.id)).arguments, params.arguments);
  assert.equal((await queue.enqueue(params)).id, pending.id);
  assert.equal(/隔离测试|"ending"\s*:|SYNTHETIC_ACCOUNT/.test(fs.readFileSync(queue.file(pending.id), "utf8")),
    false, "Synthetic request fields must not appear outside their encrypted record.");

  // No approval or service is invoked. Persist a synthetic result directly in
  // this isolated fixture to exercise the larger encrypted result roundtrip.
  const record = await queue.read(pending.id);
  record.status = "completed";
  record.result = { isError: false, content: [{ type: "text", text: unicode.repeat(500) + "END" }] };
  await queue.save(record);
  const reviewed = await queue.show(pending.id);
  assert.deepEqual(reviewed.arguments, params.arguments);
  assert.deepEqual(reviewed.result, record.result);
  assert.equal(reviewed.requestHash, pending.requestHash);
});

test.after(async () => {
  const resolved = fs.realpathSync(temporary);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.match(path.basename(resolved), /^ccodex-workiq-vault-test-/);
  await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
