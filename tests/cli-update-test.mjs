import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { cliCoreSelection, cliUpdateCommand, officialCliRelease, verifyCliCandidate,
  OFFICIAL_CLI_RELEASE, CLI_UPDATE_FACTS } from "../bridge/cli-update.mjs";
import { sourceFingerprint } from "../bridge/update-state.mjs";
import { desktopExtensionFiles } from "../bridge/desktop-extension-files.mjs";
import { requiredCliComponentFiles } from "../bridge/cli-components.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const revision = "1".repeat(40);
const tree = "2".repeat(40);
const put = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" || Buffer.isBuffer(body)
    ? body : `${JSON.stringify(body, null, 2)}\n`);
};

function header(target, label) {
  const bytes = Buffer.alloc(512);
  if (target.startsWith("windows")) {
    bytes.writeUInt16LE(0x5a4d);
    bytes.writeUInt32LE(128, 60);
    bytes.writeUInt32LE(0x00004550, 128);
    bytes.writeUInt16LE(target.endsWith("arm64") ? 0xaa64 : 0x8664, 132);
  } else if (target.startsWith("linux")) {
    bytes.writeUInt32LE(0x464c457f);
    bytes[4] = 2; bytes[5] = 1;
    bytes.writeUInt16LE(target.endsWith("arm64") ? 183 : 62, 18);
  } else {
    bytes.writeUInt32LE(0xfeedfacf);
    bytes.writeUInt32LE(target.endsWith("arm64") ? 0x0100000c : 0x01000007, 4);
  }
  bytes.write(label, 160);
  return bytes;
}

function fixture(t, target = "windows-arm64") {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-cli-update-test-"));
  const root = path.join(temporary, "enhanced");
  const home = path.join(temporary, "private-profile");
  const candidateRoot = path.join(temporary, "candidate");
  const stock = path.join(temporary, "stock");
  fs.mkdirSync(home);
  put(path.join(root, "bridge", "fixture.mjs"), "export const fixture = true;\n");
  put(path.join(root, "tools", "fixture.json"), "{}\n");
  put(path.join(stock, "config.toml"), 'model = "stock"\n');
  put(path.join(root, "desktop", "current.json"), { version: "private-desktop-selection" });
  const generation = sourceFingerprint(root, desktopExtensionFiles(root));
  const platform = target.startsWith("windows") ? "win32" : target.startsWith("macos") ? "darwin" : "linux";
  const arch = target.split("-")[1];
  const relative = platform === "win32" ? `bin/runtimes/${arch}/codex-copilot-core.exe` : "bin/codex-copilot-core";
  const patch = "fixture-enhancements.patch";
  put(path.join(candidateRoot, "patches", patch), "fixture-only; never executed\n");
  const patches = [{ name: patch, sha256: sha("fixture-only; never executed\n") }];
  function manifest(label, version, coreVersion) {
    return { schemaVersion: 1, target, sourceRevision: revision, patchedTree: tree,
      packageVersion: version, coreVersion: `codex-cli ${coreVersion}`, runtimeVerified: true,
      sha256: sha(header(target, label)), patches };
  }
  const installed = manifest("old fixture executable", "1.2.34", "0.145.0");
  const candidate = manifest("new fixture executable", "1.2.35", "0.160.0");
  candidate.components = requiredCliComponentFiles(target, candidate.coreVersion).map(file => {
    const bytes = header(target, `fixture companion ${file}`);
    put(path.join(candidateRoot, path.dirname(relative), file), bytes);
    return { file, sha256: sha(bytes), target, sourceRevision: revision, patchedTree: tree };
  });
  const manifestName = path.join(path.dirname(relative), "codex-copilot-core.manifest.json");
  const compatibilityName = path.join(path.dirname(relative), "cli-update-compatibility.json");
  put(path.join(root, relative), header(target, "old fixture executable"));
  put(path.join(root, manifestName), installed);
  put(path.join(candidateRoot, relative), header(target, "new fixture executable"));
  put(path.join(candidateRoot, manifestName), candidate);
  put(path.join(candidateRoot, "VERSION"), "1.2.35\n");
  put(path.join(candidateRoot, "CODEX-SOURCE-REVISION"), `${revision}\n`);
  put(path.join(candidateRoot, "NATIVE_PATCH_CHAIN.json"), {
    schemaVersion: 1, sourceRevision: revision, patchedTree: tree, patches: [patch],
  });
  // Parser/filesystem fixtures, not evidence that a real native candidate passed.
  const validation = { schemaVersion: 1, kind: "native-runtime", passed: true, target,
    extensionGeneration: generation, sourceRevision: revision, patchedTree: tree,
    coreSha256: candidate.sha256, facts: Object.fromEntries(CLI_UPDATE_FACTS.map(name => [name, true])) };
  const validationFile = path.join(candidateRoot, compatibilityName);
  put(validationFile, validation);
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(temporary)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(temporary), /^ccodex-cli-update-test-/);
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  return { root, home, candidateRoot, stock, platform, arch, target, generation,
    relative, candidate, installed, validation, validationFile,
    invoke: args => cliUpdateCommand({ root, home, platform, arch, args, output: () => {} }) };
}

test("official CLI check uses only the published stable official API without credentials", async () => {
  const result = await officialCliRelease({ request: async (url, options) => {
    assert.equal(url, OFFICIAL_CLI_RELEASE);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, undefined);
    return new Response(JSON.stringify({ tag_name: "rust-v0.160.0", prerelease: false,
      draft: false, published_at: "2026-10-01T20:19:13Z" }));
  } });
  assert.equal(result.version, "0.160.0");
});

for (const invalid of [
  { draft: true }, { prerelease: true }, { tag_name: "rust-v0.161.0-alpha" },
  { published_at: "not-a-date" },
]) {
  test(`official CLI check rejects ${JSON.stringify(invalid)}`, async () => {
    await assert.rejects(officialCliRelease({ request: async () => new Response(JSON.stringify({
      tag_name: "rust-v0.160.0", prerelease: false, draft: false,
      published_at: "2026-10-01T20:19:13Z", ...invalid,
    })) }), /published stable release/);
  });
}

test("official CLI check rejects HTTP and streamed size failures", async () => {
  await assert.rejects(officialCliRelease({ request: async () => new Response("", { status: 429 }) }), /HTTP 429/);
  await assert.rejects(officialCliRelease({ request: async () => new Response("x".repeat(1024 * 1024 + 1)) }), /exceeds its bound/);
});

for (const target of ["windows-arm64", "windows-x64", "linux-arm64", "linux-x64", "macos-arm64", "macos-x64"]) {
  test(`${target}: prepare is inert, apply atomically selects only the enhanced core`, async t => {
    const f = fixture(t, target);
    const before = cliCoreSelection(f);
    const stockBytes = fs.readFileSync(path.join(f.stock, "config.toml"));
    const desktopBytes = fs.readFileSync(path.join(f.root, "desktop", "current.json"));
    const prepared = await f.invoke(["prepare", f.candidateRoot]);
    assert.equal(fs.existsSync(before.pointer), false);
    assert.equal(cliCoreSelection(f).core, before.core);
    const applied = await f.invoke(["apply", prepared.id]);
    assert.equal(applied.status, "promoted");
    assert.equal(cliCoreSelection(f).core, prepared.core);
    assert.equal(applied.existingProcessesPreserved, true);
    assert.deepEqual(fs.readFileSync(path.join(f.stock, "config.toml")), stockBytes);
    assert.deepEqual(fs.readFileSync(path.join(f.root, "desktop", "current.json")), desktopBytes);
    assert.deepEqual(fs.readFileSync(before.core), header(target, "old fixture executable"));
    for (const component of f.candidate.components) {
      assert.equal(sha(fs.readFileSync(path.join(path.dirname(prepared.core), component.file))), component.sha256);
    }
  });
}

for (const fact of CLI_UPDATE_FACTS) {
  test(`CLI update refuses missing ${fact} before core promotion`, async t => {
    const f = fixture(t);
    f.validation.facts[fact] = false;
    put(f.validationFile, f.validation);
    await assert.rejects(f.invoke(["prepare", f.candidateRoot]), /every native enhancement/);
    assert.equal(fs.existsSync(cliCoreSelection(f).pointer), false);
  });
}

for (const [name, mutate] of [
  ["fixture runtime claim", body => { body.kind = "fixture"; }],
  ["foreign extension generation", body => { body.extensionGeneration = "3".repeat(64); }],
  ["foreign patch tree", body => { body.patchedTree = "3".repeat(40); }],
  ["foreign native hash", body => { body.coreSha256 = "3".repeat(64); }],
  ["wrong target", body => { body.target = "windows-x64"; }],
]) {
  test(`CLI update rejects ${name}`, async t => {
    const f = fixture(t);
    mutate(f.validation);
    put(f.validationFile, f.validation);
    await assert.rejects(f.invoke(["prepare", f.candidateRoot]), /every native enhancement/);
  });
}

test("CLI update rejects changed patch bytes and a mismatched executable architecture", t => {
  const f = fixture(t);
  put(path.join(f.candidateRoot, "patches", "fixture-enhancements.patch"), "changed");
  assert.throws(() => verifyCliCandidate(f), /patch provenance changed/);
  put(path.join(f.root, f.relative), header("windows-x64", "old fixture executable"));
  assert.throws(() => cliCoreSelection(f), /architecture differs/);
});

test("CLI update refuses a stale prepared extension snapshot without changing selection", async t => {
  const f = fixture(t);
  const prepared = await f.invoke(["prepare", f.candidateRoot]);
  put(path.join(f.root, "bridge", "fixture.mjs"), "changed extensions\n");
  await assert.rejects(f.invoke(["apply", prepared.id]), /every native enhancement|stale/);
  assert.equal(fs.existsSync(cliCoreSelection(f).pointer), false);
});

test("CLI update refuses concurrent selection changes", async t => {
  const f = fixture(t);
  const prepared = await f.invoke(["prepare", f.candidateRoot]);
  const pointer = cliCoreSelection(f).pointer;
  put(pointer, `${prepared.core}\n`);
  await assert.rejects(f.invoke(["apply", prepared.id]), /stale/);
  assert.equal(fs.readFileSync(pointer, "utf8"), `${prepared.core}\n`);
});

test("CLI update rechecks complete prepared manifest and runtime evidence", async t => {
  const f = fixture(t);
  const prepared = await f.invoke(["prepare", f.candidateRoot]);
  const file = path.join(f.home, "cli-updates", "prepared", `${prepared.id}.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.validation.patchedTree = "4".repeat(40);
  put(file, record);
  await assert.rejects(f.invoke(["apply", prepared.id]), /every native enhancement/);
});

test("CLI pointer cannot select a stock or foreign executable", t => {
  const f = fixture(t);
  put(path.join(f.root, "bin", "core-current.txt"), `${path.join(f.stock, "codex.exe")}\n`);
  assert.throws(() => cliCoreSelection(f), /escaped|contained|foreign installation/);
});

test("legacy private pointer can use only the exact matching bundled manifest", t => {
  const f = fixture(t);
  const core = path.join(f.root, "bin", "cores", "legacy", "codex-copilot-core.exe");
  put(core, header(f.target, "old fixture executable"));
  put(path.join(f.root, "bin", "core-current.txt"), `${core}\n`);
  assert.equal(cliCoreSelection(f).core, core);
  put(core, header(f.target, "changed fixture executable"));
  assert.throws(() => cliCoreSelection(f), /private build manifest/);
});

test("Unix selection import never executes the updater command as a side effect", t => {
  const f = fixture(t, "linux-arm64");
  const moduleFile = path.resolve(import.meta.dirname, "../bridge/cli-update.mjs");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    'import {pathToFileURL} from "node:url";const m=await import(pathToFileURL(process.argv[1]));console.log(m.cliCoreSelection({root:process.argv[2],home:process.argv[3],platform:"linux",arch:"arm64"}).core);',
    moduleFile, f.root, f.home], { encoding: "utf8", windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(f.root, f.relative));
  assert.equal(result.stderr, "");
  assert.equal(fs.existsSync(path.join(f.home, "cli-updates")), false);
});

test("CLI update never writes into the stock profile", async t => {
  const f = fixture(t);
  await assert.rejects(cliUpdateCommand({ ...f, home: path.join(os.homedir(), ".codex"),
    args: ["status"], output: () => {} }), /original Codex profile/);
});
