/**
 * Repackage one Unix target from a verified previous release, or from a newly
 * built candidate core. The Node runtime is extracted from the previous
 * matching target; the native core is never silently replaced or rebuilt.
 * Run only inside the global heavy-build wrapper (via repackage-unix.sh).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  values.set(process.argv[index], process.argv[index + 1]);
}
const root = path.resolve(import.meta.dirname, "..");
const target = values.get("--target");
const previousVersion = values.get("--previous-version");
const previousDist = values.get("--previous-dist");
const outputDir = values.get("--output-dir");
const candidateRoot = values.get("--candidate-root");
const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
const revision = fs.readFileSync(path.join(root, "CODEX-SOURCE-REVISION"), "utf8").trim();
const chain = JSON.parse(fs.readFileSync(path.join(root, "NATIVE_PATCH_CHAIN.json"), "utf8"));
assert.ok(["linux-arm64", "linux-x64", "macos-arm64", "macos-x64"].includes(target));
assert.match(previousVersion || "", /^\d+\.\d+\.\d+$/);
assert.match(version, /^\d+\.\d+\.\d+$/);
assert.notEqual(version, previousVersion, "the release version must advance");
assert.equal(process.platform, "linux", "run Unix repackaging inside WSL/Linux");
assert.equal(process.env.CARGO_BUILD_JOBS, "6", "use the global six-job heavy-build wrapper");
assert.equal(chain.sourceRevision, revision);

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex").toUpperCase();
}

function verifyCoreArchitecture(file, platformTarget) {
  const header = Buffer.alloc(32);
  const descriptor = fs.openSync(file, "r");
  try {
    if (fs.readSync(descriptor, header, 0, header.length, 0) < 20) {
      throw new Error(`Native core header is incomplete: ${platformTarget}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  const [platform, architecture] = platformTarget.split("-");
  if (platform === "linux") {
    assert.equal(header.readUInt32LE(0), 0x464c457f, "expected an ELF core");
    assert.equal(header.readUInt16LE(18), architecture === "arm64" ? 183 : 62,
      `ELF architecture mismatch: ${platformTarget}`);
  } else {
    assert.equal(header.readUInt32LE(0), 0xfeedfacf, "expected a 64-bit Mach-O core");
    assert.equal(header.readUInt32LE(4), architecture === "arm64" ? 0x0100000c : 0x01000007,
      `Mach-O architecture mismatch: ${platformTarget}`);
  }
}

const archiveName = `codex-copilot-${target}-${previousVersion}.tar.gz`;
const archive = path.join(previousDist, archiveName);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-unix-repackage-"));

try {
  const expectedArchiveHash = fs.readFileSync(`${archive}.sha256`, "ascii").trim().split(/\s+/)[0];
  assert.equal(await sha256(archive), expectedArchiveHash.toUpperCase(), `previous archive changed: ${target}`);
  execFileSync("tar", ["-xzf", archive, "-C", scratch], { stdio: "inherit" });
  const payload = path.join(scratch, archiveName.slice(0, -".tar.gz".length));
  assert.equal(fs.readFileSync(path.join(payload, "VERSION"), "utf8").trim(), previousVersion);
  const metadata = JSON.parse(fs.readFileSync(path.join(payload, "platform-target.json"), "utf8"));
  assert.equal(metadata.target, target);
  if (!candidateRoot) assert.equal(metadata.sourceRevision, revision);
  const runtime = path.join(payload, "runtime", "node");
  assert.ok(fs.statSync(path.join(runtime, "bin", "node")).isFile());

  const previousCore = path.join(payload, "bin", "codex-copilot-core");
  const previousManifest = path.join(payload, "bin", "codex-copilot-core.manifest.json");
  const core = candidateRoot
    ? path.join(candidateRoot, target, "codex-copilot-core")
    : previousCore;
  const manifestPath = candidateRoot
    ? path.join(candidateRoot, target, "codex-copilot-core.manifest.json")
    : path.join(scratch, "candidate-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(candidateRoot ? manifestPath : previousManifest, "utf8"));
  if (!candidateRoot) {
    assert.equal(manifest.packageVersion, previousVersion);
    assert.equal(await sha256(previousCore), metadata.coreSha256.toUpperCase());
    manifest.packageVersion = version;
    manifest.reusedFromRelease = previousVersion;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  assert.equal(manifest.packageVersion, version);
  assert.equal(manifest.target, target);
  assert.equal(manifest.sourceRevision, revision);
  assert.equal(manifest.patchedTree, chain.patchedTree);
  assert.equal(manifest.sha256.toUpperCase(), await sha256(core));
  verifyCoreArchitecture(core, target);
  assert.deepEqual(manifest.patches.map(({ name }) => name), chain.patches);
  for (const patch of manifest.patches) {
    assert.equal(
      patch.sha256.toUpperCase(),
      await sha256(path.join(root, "patches", patch.name)),
      `native patch changed without a rebuilt ${target} core: ${patch.name}`,
    );
  }
  assert.ok(
    Array.isArray(manifest.nativeValidation)
      || manifest.runtimeVerified === true
      || (!candidateRoot && manifest.builtAt && manifest.binaryFormat),
    "candidate core lacks native validation or verified prior build evidence",
  );
  const compatibility = path.join(path.dirname(core), "cli-update-compatibility.json");
  assert.ok(fs.existsSync(compatibility), "candidate lacks actual native CLI update compatibility");
  execFileSync(process.execPath, [
    path.join(root, "tools", "package-unix.mjs"),
    "--target", target,
    "--core", core,
    "--manifest", manifestPath,
    "--node-dir", runtime,
    "--output-dir", outputDir,
  ], { cwd: root, stdio: "inherit", env: process.env });
  const name = `codex-copilot-${target}-${version}`;
  for (const extension of target.startsWith("linux") ? [".tar.gz", ".deb", ".rpm"] : [".tar.gz"]) {
    assert.ok(fs.statSync(path.join(outputDir, name + extension)).size > 0);
  }
  process.stdout.write(`Verified and repackaged ${target} for ${version}.\n`);
} finally {
  const resolved = fs.realpathSync(scratch);
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir())
    || !path.basename(resolved).startsWith("ccodex-unix-repackage-")) {
    throw new Error("Refusing to clean an unexpected Unix release directory.");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
