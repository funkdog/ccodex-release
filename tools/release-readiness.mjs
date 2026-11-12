import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const RELEASE_SOURCE_INPUTS = Object.freeze([
  "package.json", "package-lock.json", "tsconfig.json", ".github", "README.md", "WORKIQ.md", "RELEASE_NOTES.md", "MIGRATION.md",
  "MIGRATION.zh-CN.md", "NATIVE_COMPATIBILITY.md", "CODEX-SOURCE-REVISION",
  "NATIVE_PATCH_CHAIN.json", "install.cmd", "install.ps1", "assets", "bridge", "gateway",
  "patches", "skills", "src", "tests", "tools", "platforms",
  "bin/ccodex.cmd", "bin/codex-copilot.cmd", "bin/ccodex-smart-paste.cjs",
  "bin/node-pty",
]);

export const RELEASE_REQUIREMENTS = Object.freeze({
  "native-stock-isolation": [
    "stockConfigUnchanged", "stockExecutableUnchanged", "stockCliUnchanged",
    "globalOverridesAbsent", "nativeBackendRestored", "stockUiUnmodified",
    "stockPatchHelpersAbsent",
  ],
  "private-desktop-instances": [
    "endpointOwnerVerified", "processLifetimeVerified", "privateProfileVerified",
    "stockProcessesPreserved", "snapshotSelectionIndependent",
  ],
  "native-model-effort-context": [
    "nativeModelPickerPreserved", "nativeEffortSliderPreserved",
    "nativeAnimationsPreserved", "independentSelectionVerified",
    "contextBoundToActualCandidate",
    "contextInsideNativePanelVerified", "modelNamesOnlyVerified", "englishEffortParametersVerified",
  ],
  "independent-desktop-updates": [
    "officialUpdateApplied", "extensionsRetained", "upstreamFeaturesVerified",
    "stockUpdateStateUnchanged", "privateSnapshotPromoted",
  ],
  "compatible-cli-updates": [
    "officialUpdateApplied", "extensionsRetained", "upstreamFeaturesVerified",
    "stockCliUnchanged", "patchedCoreProvenanceVerified",
  ],
  "native-terminal-input": [
    "shiftEnterNewlineVerified", "csiEscapeTextAbsent", "draftNotSubmitted",
    "directNativeInputVerified", "parentTerminalModesRestored",
  ],
  "copilot-account-quota": [
    "sameAuthenticatedAccountVerified", "nativeDesktopNameAvatarPlanVerified",
    "actualProviderQuotaVerified", "cliQuotaVerified", "accountSwitchVerified",
    "perBucketFreshnessVerified", "unavailableQuotaNotFabricated",
    "actualProviderCreditsVerified", "nativeCliCreditsVerified", "nativeDesktopCreditsVerified",
  ],
  "actual-context-compactions": [
    "successfulCompactionIncrementVerified", "failedCompactionExcluded",
    "resumedCompactionCountVerified", "duplicateEventsNotCounted",
    "actualNativeStatusVerified",
  ],
});

export const NATIVE_TARGET_REQUIREMENTS = Object.freeze([
  "private-desktop-instances", "independent-desktop-updates", "compatible-cli-updates",
  "native-terminal-input", "actual-context-compactions",
]);

export const RELEASE_TARGETS = Object.freeze([
  "windows-arm64", "windows-x64", "linux-arm64", "linux-x64",
  "macos-arm64", "macos-x64",
]);

function contained(root, relative) {
  if (typeof relative !== "string" || !relative ||
      path.isAbsolute(relative) || /^(?:[A-Za-z]:|[/\\])/.test(relative) ||
      relative.split(/[\\/]/).some(part => !part || part === "." || part === "..")) {
    throw new Error("Release evidence must use a contained relative path.");
  }
  const file = path.resolve(root, relative);
  const tail = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  if (tail === ".." || tail.startsWith(`..${path.sep}`) || path.isAbsolute(tail)) {
    throw new Error("Release evidence escaped through a link.");
  }
  if (fs.lstatSync(file).isSymbolicLink()) {
    throw new Error("Release evidence cannot be a symbolic link.");
  }
  return file;
}

function sha256(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) {
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}

function boundedJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) {
    throw new Error("Release readiness metadata must be a bounded regular file.");
  }
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

export function releaseSourceFingerprint(root, inputs = RELEASE_SOURCE_INPUTS) {
  const files = [];
  function visit(relative) {
    const file = contained(root, relative);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      files.push([relative.replaceAll("\\", "/"), file]);
    } else {
      throw new Error(`Unsupported release source entry: ${relative}`);
    }
  }
  for (const input of [...inputs].sort()) visit(input);
  const hash = createHash("sha256");
  for (const [relative, file] of files.sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(relative).update("\0").update(sha256(file)).update("\0");
  }
  return hash.digest("hex");
}

/** Mechanical admission checks; these do not replace the full completion audit. */
export function requireReleaseReadiness({
  root, version, readinessFile = "release-readiness/current.json",
  fingerprint = releaseSourceFingerprint,
  now = Date.now,
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version || "")) throw new Error("Invalid candidate release version.");
  let readiness;
  try { readiness = boundedJson(contained(root, readinessFile)); }
  catch (error) {
    throw new Error(`Release admission evidence is missing or unsafe; no staging or promotion is allowed: ${error.message}`);
  }
  const generation = fingerprint(root);
  if (readiness.schemaVersion !== 1 || readiness.version !== version ||
      readiness.sourceGeneration !== generation || readiness.ready !== true) {
    throw new Error("Release admission does not match the exact current source/version.");
  }
  if (fs.existsSync(path.join(root, "bin", "codex.cmd"))) {
    throw new Error("The enhanced package must not shadow the stock codex command.");
  }
  if (!Array.isArray(readiness.requirements)) throw new Error("Release requirement evidence is missing.");
  const evidenceRoot = contained(root, "release-readiness/evidence");
  const checked = [];
  for (const [id, facts] of Object.entries(RELEASE_REQUIREMENTS)) {
    const records = readiness.requirements.filter(record => record?.id === id);
    if (records.length !== 1) throw new Error(`Release requires one exact evidence record: ${id}`);
    const record = records[0];
    const file = contained(evidenceRoot, record.artifact);
    const evidence = boundedJson(file);
    if (!/^[a-f0-9]{64}$/i.test(record.sha256 || "") || sha256(file) !== record.sha256.toLowerCase()) {
      throw new Error(`Release evidence checksum does not match: ${id}`);
    }
    if (evidence.schemaVersion !== 1 || evidence.requirement !== id ||
        evidence.sourceGeneration !== generation || evidence.passed !== true ||
        !["live-runtime", "manual-runtime-acceptance"].includes(evidence.kind)) {
      throw new Error(`Fixture/static evidence cannot admit this release requirement: ${id}`);
    }
    const testedAt = Date.parse(evidence.testedAt);
    if (!Number.isFinite(testedAt) || testedAt > now() + 5 * 60 * 1000) {
      throw new Error(`Release evidence has an invalid test date: ${id}`);
    }
    if (facts.some(fact => evidence.facts?.[fact] !== true)) {
      throw new Error(`Release requirement remains unproven: ${id}`);
    }
    if (NATIVE_TARGET_REQUIREMENTS.includes(id)) {
      if (!Array.isArray(evidence.targets) ||
          evidence.targets.length !== RELEASE_TARGETS.length ||
          new Set(evidence.targets.map(item => item.target)).size !== RELEASE_TARGETS.length ||
          RELEASE_TARGETS.some(target => !evidence.targets.some(item =>
            item.target === target && item.runtimeVerified === true &&
            item.sourceGeneration === generation &&
            typeof item.runtimeArtifact === "string" &&
            /^[a-f0-9]{64}$/i.test(item.runtimeSha256 || "")))) {
        throw new Error(`Release lacks complete native target coverage: ${id}`);
      }
      for (const target of evidence.targets) {
        const runtime = contained(evidenceRoot, target.runtimeArtifact);
        const runtimeEvidence = boundedJson(runtime);
        if (sha256(runtime) !== target.runtimeSha256.toLowerCase()) {
          throw new Error(`Native runtime evidence checksum does not match: ${target.target}`);
        }
        if (runtimeEvidence.kind !== "native-runtime" || runtimeEvidence.passed !== true ||
            runtimeEvidence.target !== target.target ||
            runtimeEvidence.sourceGeneration !== generation) {
          throw new Error(`Native runtime evidence is incomplete or only a fixture: ${target.target}`);
        }
      }
    }
    checked.push(id);
  }
  return {
    schemaVersion: 1, version, sourceGeneration: generation,
    requirements: checked, mechanicalAdmissionPassed: true,
    completionAuditProven: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [root, version, file] = process.argv.slice(2);
    if (!root || !version || process.argv.length > 5) {
      throw new Error("Usage: release-readiness.mjs <source-root> <version> [contained-readiness-file]");
    }
    console.log(JSON.stringify(requireReleaseReadiness({
      root: path.resolve(root), version, ...(file ? { readinessFile: file } : {}),
    }), null, 2));
  } catch (error) {
    console.error(`Release admission refused: ${error.message}`);
    process.exitCode = 1;
  }
}
