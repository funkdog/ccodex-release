import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { binaryTarget } from "./write-core-manifest.mjs";
import { CLI_UPDATE_FACTS } from "../bridge/cli-update.mjs";
import { desktopExtensionFiles } from "../bridge/desktop-extension-files.mjs";
import { fileSha256 } from "../bridge/desktop-runtime.mjs";
import { sourceFingerprint } from "../bridge/update-state.mjs";

const HASH = /^[a-f0-9]{64}$/i;
const COMMIT = /^[a-f0-9]{40}$/i;

function regularJson(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024,
    "Compatibility evidence must be a bounded regular JSON file.");
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function completeTests(counts, minimum, skipped = 0) {
  return counts && Number.isSafeInteger(counts.tests) && counts.tests >= minimum &&
    counts.pass + skipped === counts.tests && counts.fail === 0 &&
    counts.cancelled === 0 && counts.skipped === skipped && counts.todo === 0;
}

export function cliCompatibilityEvidence({ manifest, report, extensionGeneration, target }) {
  assert(HASH.test(extensionGeneration), "Invalid extension generation.");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.target, target);
  assert.equal(manifest.runtimeVerified, true, "A native target runner must start this core.");
  assert(HASH.test(manifest.sha256) && COMMIT.test(manifest.sourceRevision) &&
    COMMIT.test(manifest.patchedTree), "Incomplete native build provenance.");
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, "native-runtime-validation",
    "A fixture or a --version-only check cannot validate CLI enhancements.");
  assert.equal(report.target, target);
  assert.equal(report.extensionGeneration, extensionGeneration, "Runtime tests belong to older extensions.");
  assert.equal(report.coreSha256?.toLowerCase(), manifest.sha256.toLowerCase(),
    "Runtime tests belong to a different core.");
  assert.equal(report.coreVersion, manifest.coreVersion);
  assert.equal(report.passed, true);
  assert.equal(report.isolatedProfile, true);
  assert.equal(report.sourceUnchanged, true);
  assert.equal(report.testProcessesExited, true);
  assert.equal(report.forcedCleanup, false);
  assert(Number.isFinite(Date.parse(report.testedAt)), "Runtime test date is missing.");
  const skipped = target.startsWith("windows") ? 9 : 0;
  assert(completeTests(report.packageTests, 239, skipped), "Full package test coverage is incomplete.");
  if (skipped) {
    assert.equal(report.windowsPlatformSkipsCoveredByUnix, skipped);
    assert(completeTests(report.unixTests, 14), "Windows skips lack actual Unix coverage.");
  }
  assert.deepEqual(report.native.map(item => item.mode).sort(), ["always", "never"]);
  for (const item of report.native) {
    assert(item.checks >= 5 && item.coreSha256?.toLowerCase() === manifest.sha256.toLowerCase(),
      "Both real native Context picker modes must pass on the same core.");
  }
  assert.equal(report.nativeInputStatus?.coreSha256?.toLowerCase(), manifest.sha256.toLowerCase());
  assert(report.nativeInputStatus.recoveryChecks >= 2 &&
    report.nativeInputStatus.keyboardChecks >= 2 && report.nativeInputStatus.contextStatusChecks >= 5,
  "Actual keyboard, parent console and successful-compaction status coverage is incomplete.");
  assert(report.nativeInputStatus.creditsVerified === true &&
    report.nativeInputStatus.creditChecks >= 3,
  "Actual native credit units, dynamic usage and account-switch clearing are incomplete.");
  for (const [name, minimum] of [["nativeLayout", 10], ["nativeStream", 7]]) {
    const runtime = report[name];
    assert(runtime?.checks >= minimum && runtime.passed === true &&
      runtime.coreSha256?.toLowerCase() === manifest.sha256.toLowerCase(),
    "Native transcript, attachments and upstream UI behavior must be exercised.");
  }
  return {
    schemaVersion: 1, kind: "native-runtime", passed: true, target,
    extensionGeneration, coreSha256: manifest.sha256,
    sourceRevision: manifest.sourceRevision, patchedTree: manifest.patchedTree,
    coreVersion: manifest.coreVersion, testedAt: report.testedAt,
    facts: Object.fromEntries(CLI_UPDATE_FACTS.map(name => [name, true])),
  };
}

export function writeCliUpdateCompatibility({
  root, core, reportFile, platform = process.platform, arch = process.arch,
}) {
  root = fs.realpathSync(root);
  core = path.resolve(core);
  const directory = path.dirname(core);
  assert.equal(fs.realpathSync(directory), directory, "Candidate core directory cannot be linked.");
  const target = `${platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform}-${arch}`;
  assert.match(target, /^(windows|linux|macos)-(arm64|x64)$/);
  const generation = sourceFingerprint(root, desktopExtensionFiles(root));
  const manifest = regularJson(path.join(directory, "codex-copilot-core.manifest.json"));
  const report = regularJson(reportFile);
  const chain = regularJson(path.join(root, "NATIVE_PATCH_CHAIN.json"));
  assert.equal(chain.sourceRevision, manifest.sourceRevision);
  assert.equal(chain.patchedTree, manifest.patchedTree);
  assert.equal(fs.readFileSync(path.join(root, "CODEX-SOURCE-REVISION"), "utf8").trim(), manifest.sourceRevision);
  assert.deepEqual(manifest.patches?.map(item => item.name), chain.patches);
  for (const patch of manifest.patches) {
    assert.match(patch.name, /^[a-z0-9-]+\.patch$/);
    assert.equal(fileSha256(path.join(root, "patches", patch.name)), patch.sha256.toLowerCase());
  }
  const stat = fs.lstatSync(core);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, "Candidate core is not a regular executable.");
  assert.equal(fileSha256(core), manifest.sha256.toLowerCase());
  const descriptor = fs.openSync(core, "r");
  const header = Buffer.alloc(Math.min(stat.size, 64 * 1024));
  try { fs.readSync(descriptor, header, 0, header.length, 0); }
  finally { fs.closeSync(descriptor); }
  assert.equal(binaryTarget(header), target, "Compatibility evidence requires the actual native OS/architecture.");
  const evidence = cliCompatibilityEvidence({ manifest, report, extensionGeneration: generation, target });
  assert.equal(execFileSync(core, ["--version"], {
    encoding: "utf8", timeout: 30000, windowsHide: true,
    env: { ...process.env, CODEX_HOME: path.join(directory, "empty-version-profile") },
  }).trim(), manifest.coreVersion);
  assert.equal(sourceFingerprint(root, desktopExtensionFiles(root)), generation,
    "Extensions changed during compatibility verification.");
  assert.equal(fileSha256(core), manifest.sha256.toLowerCase(), "Candidate changed during verification.");
  const output = path.join(directory, "cli-update-compatibility.json");
  if (fs.existsSync(output)) {
    const previous = regularJson(output);
    for (const field of ["schemaVersion", "kind", "passed", "target", "extensionGeneration",
      "coreSha256", "sourceRevision", "patchedTree", "coreVersion"]) {
      assert.equal(previous[field], evidence[field],
        "Existing compatibility evidence belongs to another candidate; do not overwrite it.");
    }
    assert(CLI_UPDATE_FACTS.every(fact => previous.facts?.[fact] === true),
      "Existing compatibility evidence is incomplete; use a fresh candidate directory.");
    return { ...evidence, output, existingEvidencePreserved: true };
  }
  fs.writeFileSync(output, `${JSON.stringify({
    ...evidence, runtimeReportSha256: fileSha256(reportFile),
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { ...evidence, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [root, core, reportFile, ...extra] = process.argv.slice(2);
    assert(root && core && reportFile && !extra.length,
      "Usage: write-cli-update-compatibility.mjs <source-root> <candidate-core> <native-runtime-report>");
    console.log(JSON.stringify(writeCliUpdateCompatibility({ root, core, reportFile }), null, 2));
  } catch (error) {
    console.error(`CLI update compatibility refused: ${error.message}`);
    process.exitCode = 1;
  }
}
