import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = path.resolve(import.meta.dirname, "..");
const windows = { skip: process.platform !== "win32" };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-deployment-gate-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function run(script, args) {
  const result = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-File",
    path.join(source, "tools", script), ...args], {
    encoding: "utf8", windowsHide: true,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  return result.stdout + result.stderr;
}

test("full deployment test entry point rejects omitted runtime inputs before starting tests", windows, t => {
  const root = fixture(t);
  const report = path.join(root, "report");
  const output = run("Test-NativeRepair.ps1", ["-AllTests", "-ReportDirectory", report]);
  assert.match(output, /Full deployment gate requires -NativeCore, -CliCore and -DependencyProfile/);
  assert.equal(fs.existsSync(report), false);
});

const completeCounts = { tests: 10, pass: 10, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
for (const [name, coverage] of [
  ["missing runtime attestation", { testCounts: completeCounts }],
  ["missing test counts", { requiredRuntimeCoverage: true }],
  ["skipped tests", { requiredRuntimeCoverage: true, testCounts: { ...completeCounts, skipped: 1 } }],
  ["cancelled tests", { requiredRuntimeCoverage: true, testCounts: { ...completeCounts, cancelled: 1 } }],
  ["empty test run", { requiredRuntimeCoverage: true, testCounts: { ...completeCounts, tests: 0, pass: 0 } }],
  ["incomplete passing count", { requiredRuntimeCoverage: true, testCounts: { ...completeCounts, pass: 9 } }],
]) {
  test(`deployment rejects ${name} before touching an installation`, windows, t => {
    const root = fixture(t);
    const evidence = path.join(root, "test-result.json");
    fs.writeFileSync(evidence, JSON.stringify({
      exitCode: 0, temporaryFilesRemoved: true, remainingOwnedPids: [],
      processCleanupVerified: true, remainingTrackedPids: [],
      fullGate: true, sourceUnchanged: true, ...coverage,
    }));
    const report = path.join(root, "report");
    const install = path.join(root, "install");
    const output = run("Install-NativeRepair.ps1", [
      "-PassedTestResult", evidence, "-ReportDirectory", report,
      "-InstallRoot", install, "-Profile", path.join(root, "profile"),
    ]);
    assert.match(output, /Verified native core, CLI core and runtime coverage/);
    assert.equal(fs.existsSync(report), false);
    assert.equal(fs.existsSync(install), false);
  });
}

for (const [name, cleanup] of [
  ["missing process-lifetime attestation", {}],
  ["failed process cleanup", { processCleanupVerified: false, remainingTrackedPids: [] }],
  ["surviving tracked lifetime", { processCleanupVerified: true, remainingTrackedPids: [1234] }],
]) {
  test(`deployment rejects ${name} before touching an installation`, windows, t => {
    const root = fixture(t);
    const evidence = path.join(root, "test-result.json");
    fs.writeFileSync(evidence, JSON.stringify({
      exitCode: 0, temporaryFilesRemoved: true, remainingOwnedPids: [],
      fullGate: true, sourceUnchanged: true,
      requiredRuntimeCoverage: true, testCounts: completeCounts, ...cleanup,
    }));
    const report = path.join(root, "report");
    const install = path.join(root, "install");
    const output = run("Install-NativeRepair.ps1", [
      "-PassedTestResult", evidence, "-ReportDirectory", report,
      "-InstallRoot", install, "-Profile", path.join(root, "profile"),
    ]);
    assert.match(output, /Verified test-process lifetime cleanup/);
    assert.equal(fs.existsSync(report), false);
    assert.equal(fs.existsSync(install), false);
  });
}
