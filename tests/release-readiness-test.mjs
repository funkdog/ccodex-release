import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  RELEASE_REQUIREMENTS, RELEASE_TARGETS, releaseSourceFingerprint,
  requireReleaseReadiness,
} from "../tools/release-readiness.mjs";

const generation = "1".repeat(64);
const version = "1.2.35";
const now = Date.parse("2026-10-01T21:00:00Z");
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-release-admission-"));
  const evidenceRoot = path.join(root, "release-readiness", "evidence");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.mkdirSync(path.join(root, "bin"));
  const requirements = [];
  const evidence = new Map();
  for (const [id, facts] of Object.entries(RELEASE_REQUIREMENTS)) {
    const body = {
      schemaVersion: 1, requirement: id, kind: "live-runtime", passed: true,
      sourceGeneration: generation, testedAt: "2026-10-01T20:59:00Z",
      facts: Object.fromEntries(facts.map(fact => [fact, true])),
      targets: RELEASE_TARGETS.map(target => {
        const runtimeArtifact = `${id}-${target}.json`;
        const file = path.join(evidenceRoot, runtimeArtifact);
        // These are parser fixtures, not records of actual native execution.
        fs.writeFileSync(file, JSON.stringify({
          kind: "native-runtime", passed: true, target, sourceGeneration: generation,
        }));
        return { target, runtimeVerified: true, sourceGeneration: generation,
          runtimeArtifact, runtimeSha256: digest(file) };
      }),
    };
    evidence.set(id, body);
    requirements.push({ id, artifact: `${id}.json` });
  }
  const readiness = { schemaVersion: 1, ready: true, version,
    sourceGeneration: generation, requirements };
  const flush = () => {
    for (const record of requirements) {
      const file = path.join(evidenceRoot, record.artifact);
      fs.writeFileSync(file, JSON.stringify(evidence.get(record.id)));
      record.sha256 = digest(file);
    }
    fs.writeFileSync(path.join(root, "release-readiness", "current.json"),
      JSON.stringify(readiness));
  };
  flush();
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^ccodex-release-admission-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, evidenceRoot, readiness, evidence, flush,
    run: () => requireReleaseReadiness({ root, version, now: () => now,
      fingerprint: () => generation }) };
}

test("release admission checks mechanical fixture structure without claiming goal completion", t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.mechanicalAdmissionPassed, true);
  assert.equal(result.completionAuditProven, false);
  assert.deepEqual(result.requirements, Object.keys(RELEASE_REQUIREMENTS));
});

test("release admission rejects missing readiness before any staging is created", t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, "release-readiness", "current.json"));
  assert.throws(f.run, /missing or unsafe/);
  assert.equal(fs.existsSync(path.join(f.root, ".release-staging")), false);
});

for (const [field, value] of [
  ["schemaVersion", 2], ["ready", false], ["version", "1.2.34"],
  ["sourceGeneration", "2".repeat(64)],
]) {
  test(`release admission rejects stale or non-ready ${field}`, t => {
    const f = fixture(t);
    f.readiness[field] = value;
    f.flush();
    assert.throws(f.run, /exact current source\/version/);
  });
}

test("release admission rejects a restored stock-command shadow", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "bin", "codex.cmd"), "unapproved shadow");
  assert.throws(f.run, /shadow the stock/);
});

test("release admission rejects duplicated requirement evidence", t => {
  const f = fixture(t);
  f.readiness.requirements.push({ ...f.readiness.requirements[0] });
  f.flush();
  assert.throws(f.run, /one exact evidence record/);
});

for (const kind of ["fixture", "static", "source-only"]) {
  test(`release admission rejects ${kind} as runtime UI acceptance`, t => {
    const f = fixture(t);
    f.evidence.get("native-model-effort-context").kind = kind;
    f.flush();
    assert.throws(f.run, /Fixture\/static evidence/);
  });
}

test("release admission rejects an unproven native Effort animation", t => {
  const f = fixture(t);
  f.evidence.get("native-model-effort-context").facts.nativeAnimationsPreserved = false;
  f.flush();
  assert.throws(f.run, /remains unproven/);
});

for (const [id, fact] of [
  ["native-stock-isolation", "stockUiUnmodified"],
  ["native-stock-isolation", "stockPatchHelpersAbsent"],
  ["native-terminal-input", "parentTerminalModesRestored"],
  ["native-terminal-input", "draftNotSubmitted"],
  ["copilot-account-quota", "actualProviderQuotaVerified"],
  ["copilot-account-quota", "nativeDesktopNameAvatarPlanVerified"],
  ["actual-context-compactions", "failedCompactionExcluded"],
  ["actual-context-compactions", "resumedCompactionCountVerified"],
]) {
  test(`release admission requires ${id}: ${fact}`, t => {
    const f = fixture(t);
    f.evidence.get(id).facts[fact] = false;
    f.flush();
    assert.throws(f.run, /remains unproven/);
  });
}

for (const id of ["native-terminal-input", "copilot-account-quota", "actual-context-compactions"]) {
  test(`old admission lacking ${id} cannot publish the expanded goal`, t => {
    const f = fixture(t);
    const index = f.readiness.requirements.findIndex(record => record.id === id);
    f.readiness.requirements.splice(index, 1);
    f.flush();
    assert.throws(f.run, /one exact evidence record/);
  });
}

for (const id of ["native-terminal-input", "actual-context-compactions"]) {
  test(`${id} requires the remaining native targets`, t => {
    const f = fixture(t);
    f.evidence.get(id).targets[4].runtimeVerified = false;
    f.flush();
    assert.throws(f.run, /complete native target coverage/);
  });
}

test("release admission rejects a target that lacks native runtime verification", t => {
  const f = fixture(t);
  f.evidence.get("compatible-cli-updates").targets[5].runtimeVerified = false;
  f.flush();
  assert.throws(f.run, /complete native target coverage/);
});

test("release admission rejects duplicate targets hiding a missing platform", t => {
  const f = fixture(t);
  const targets = f.evidence.get("private-desktop-instances").targets;
  targets[5] = { ...targets[0] };
  f.flush();
  assert.throws(f.run, /complete native target coverage/);
});

test("release admission rejects fixture results inside a declared native target", t => {
  const f = fixture(t);
  const target = f.evidence.get("independent-desktop-updates").targets[0];
  const file = path.join(f.evidenceRoot, target.runtimeArtifact);
  fs.writeFileSync(file, JSON.stringify({
    kind: "fixture", target: target.target, passed: true, sourceGeneration: generation,
  }));
  target.runtimeSha256 = digest(file);
  f.flush();
  assert.throws(f.run, /only a fixture/);
});

test("release admission rejects changed evidence bytes", t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.evidenceRoot, "native-stock-isolation.json"), " ");
  assert.throws(f.run, /checksum does not match/);
});

test("release admission rejects path traversal before reading an unrelated file", t => {
  const f = fixture(t);
  f.readiness.requirements[0].artifact = "../../README.md";
  fs.writeFileSync(path.join(f.root, "release-readiness", "current.json"),
    JSON.stringify(f.readiness));
  assert.throws(f.run, /contained relative/);
});

test("release admission rejects oversized metadata before hashing it", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.evidenceRoot, "native-stock-isolation.json"),
    Buffer.alloc(2 * 1024 * 1024 + 1, 32));
  assert.throws(f.run, /bounded regular/);
});

test("release admission rejects future-dated acceptance", t => {
  const f = fixture(t);
  f.evidence.get("native-model-effort-context").testedAt = "2026-10-02T21:00:00Z";
  f.flush();
  assert.throws(f.run, /invalid test date/);
});

test("release source generation changes with source bytes and rejects linked inputs", t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, "source"));
  fs.writeFileSync(path.join(f.root, "source", "first.mjs"), "first");
  const before = releaseSourceFingerprint(f.root, ["source"]);
  fs.writeFileSync(path.join(f.root, "source", "first.mjs"), "second");
  assert.notEqual(releaseSourceFingerprint(f.root, ["source"]), before);
  fs.mkdirSync(path.join(f.root, "other-source"));
  fs.symlinkSync(path.join(f.root, "other-source"),
    path.join(f.root, "source", "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => releaseSourceFingerprint(f.root, ["source"]), /symbolic link/);
});

test("publisher performs admission before creating or testing a release stage", () => {
  const publisher = fs.readFileSync(path.resolve(import.meta.dirname,
    "../tools/Publish-Release.ps1"), "utf8");
  assert.ok(publisher.indexOf("release-readiness.mjs") <
    publisher.indexOf("New-Item -ItemType Directory -Path $candidateDist"));
  assert.match(publisher, /No release staging or promotion was started/);
});
