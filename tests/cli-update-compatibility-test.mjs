import assert from "node:assert/strict";
import test from "node:test";
import { cliCompatibilityEvidence } from "../tools/write-cli-update-compatibility.mjs";

function fixture(target = "windows-arm64") {
  const extensionGeneration = "a".repeat(64);
  const manifest = { schemaVersion: 1, target, runtimeVerified: true, sha256: "b".repeat(64),
    sourceRevision: "c".repeat(40), patchedTree: "d".repeat(40), coreVersion: "codex-cli 0.160.0" };
  const counts = { tests: 400, pass: 400, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  const report = { schemaVersion: 1, kind: "native-runtime-validation", target,
    extensionGeneration, coreSha256: manifest.sha256, coreVersion: manifest.coreVersion,
    passed: true, isolatedProfile: true, sourceUnchanged: true,
    testProcessesExited: true, forcedCleanup: false, testedAt: "2026-10-03T20:00:00Z",
    packageTests: { ...counts, ...(target.startsWith("windows") ? { pass: 391, skipped: 9 } : {}) },
    unixTests: counts, windowsPlatformSkipsCoveredByUnix: 9,
    native: ["never", "always"].map(mode => ({ mode, checks: 6, coreSha256: manifest.sha256 })),
    nativeInputStatus: { coreSha256: manifest.sha256,
      recoveryChecks: 2, keyboardChecks: 2, contextStatusChecks: 8,
      creditsVerified: true, creditChecks: 3 },
    nativeLayout: { coreSha256: manifest.sha256, checks: 12, passed: true },
    nativeStream: { coreSha256: manifest.sha256, checks: 8, passed: true },
  };
  // Parser fixtures never write runtime evidence or launch a native application.
  return { manifest, report, extensionGeneration, target };
}

for (const target of ["windows-arm64", "windows-x64", "linux-arm64", "linux-x64", "macos-arm64", "macos-x64"]) {
  test(`${target}: compatibility binds every required enhancement to the same runtime`, () => {
    const input = fixture(target);
    const receipt = cliCompatibilityEvidence(input);
    assert.equal(receipt.coreSha256, input.manifest.sha256);
    assert.equal(receipt.extensionGeneration, input.extensionGeneration);
    assert.equal(Object.keys(receipt.facts).length, 6);
    assert(Object.values(receipt.facts).every(value => value === true));
  });
}

for (const [name, change] of [
  ["fixture instead of runtime", input => { input.report.kind = "unit-fixture"; }],
  ["cross-compiled only", input => { input.manifest.runtimeVerified = false; }],
  ["wrong architecture", input => { input.report.target = "macos-x64"; }],
  ["older extensions", input => { input.report.extensionGeneration = "e".repeat(64); }],
  ["older core", input => { input.report.coreSha256 = "e".repeat(64); }],
  ["wrong version", input => { input.report.coreVersion = "codex-cli 0.145.0"; }],
  ["failed suite", input => { input.report.passed = false; }],
  ["live leftover process", input => { input.report.testProcessesExited = false; }],
  ["forced parent cleanup", input => { input.report.forcedCleanup = true; }],
  ["changed source", input => { input.report.sourceUnchanged = false; }],
  ["missing date", input => { input.report.testedAt = "invalid"; }],
  ["package failure", input => { input.report.packageTests.fail = 1; }],
  ["cancelled package test", input => { input.report.packageTests.cancelled = 1; }],
  ["uncovered Windows skips", input => { input.report.windowsPlatformSkipsCoveredByUnix = 0; }],
  ["Unix test skipped", input => { input.report.unixTests.skipped = 1; }],
  ["missing fullscreen", input => { input.report.native.pop(); }],
  ["Context tested against another binary", input => { input.report.native[0].coreSha256 = "f".repeat(64); }],
  ["missing Shift+Enter", input => { input.report.nativeInputStatus.keyboardChecks = 1; }],
  ["missing compaction resume", input => { input.report.nativeInputStatus.contextStatusChecks = 4; }],
  ["missing actual credits", input => { input.report.nativeInputStatus.creditsVerified = false; }],
  ["missing credits account isolation", input => { input.report.nativeInputStatus.creditChecks = 2; }],
  ["missing native attachments", input => { input.report.nativeLayout.checks = 0; }],
  ["failed native streaming", input => { input.report.nativeStream.passed = false; }],
]) {
  test(`compatibility refuses ${name}`, () => {
    const input = fixture();
    change(input);
    assert.throws(() => cliCompatibilityEvidence(input));
  });
}
