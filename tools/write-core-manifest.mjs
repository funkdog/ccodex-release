/**
 * Write a build manifest from the actual compiled core and the one declared
 * native patch chain. Cross-compiled cores remain runtimeVerified=false until
 * a matching OS/architecture runner starts them.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeBinaryTarget, requiredCliComponentFiles } from "../bridge/cli-components.mjs";
import { runtimePath } from "../bridge/desktop-runtime.mjs";

const root = path.resolve(import.meta.dirname, "..");

export function binaryTarget(header) {
  if (header.length < 64) return null;
  if (header.readUInt16LE(0) === 0x5a4d) {
    const offset = header.readUInt32LE(0x3c);
    if (offset + 6 > header.length || header.readUInt32LE(offset) !== 0x00004550) return null;
    return { 0xaa64: "windows-arm64", 0x8664: "windows-x64" }[header.readUInt16LE(offset + 4)] || null;
  }
  if (header.readUInt32LE(0) === 0x464c457f) {
    return { 183: "linux-arm64", 62: "linux-x64" }[header.readUInt16LE(18)] || null;
  }
  if (header.readUInt32LE(0) === 0xfeedfacf) {
    return { 0x0100000c: "macos-arm64", 0x01000007: "macos-x64" }[header.readUInt32LE(4)] || null;
  }
  return null;
}

export function manifestFields({
  target, version, revision, tree, coreVersion, coreHash, runtimeVerified, patches, components,
}) {
  assert.match(target, /^(windows|linux|macos)-(arm64|x64)$/);
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(revision, /^[0-9a-f]{40}$/);
  assert.match(tree, /^[0-9a-f]{40}$/);
  assert.match(coreVersion, /^codex-cli \d+\.\d+\.\d+/);
  assert.match(coreHash, /^[A-F0-9]{64}$/);
  assert.equal(typeof runtimeVerified, "boolean");
  assert.ok(Array.isArray(patches) && patches.length > 0);
  const required = requiredCliComponentFiles(target, coreVersion);
  if (required.length) {
    assert.ok(Array.isArray(components), "Current native cores require a companion inventory.");
    assert.ok(required.every(file => components.some(row => row.file === file)),
      "The native companion inventory is incomplete.");
  }
  return {
    schemaVersion: 1,
    packageVersion: version,
    sourceRevision: revision,
    patchedTree: tree,
    target,
    coreVersion,
    sha256: coreHash,
    runtimeVerified,
    patches,
    ...(components !== undefined ? { components } : {}),
    builtAt: new Date().toISOString(),
  };
}

/** Inventory real companion files in the layout resolved by the native CLI. */
export async function componentInventory(core, { target, coreVersion, revision, tree }) {
  const required = requiredCliComponentFiles(target, coreVersion);
  if (!required.length) return undefined;
  return Promise.all(required.map(async file => {
    const component = runtimePath(path.dirname(core), file);
    assert.equal(nativeBinaryTarget(component), target,
      `Companion architecture differs from the target: ${file}`);
    return { file, target, sha256: await digest(component),
      sourceRevision: revision, patchedTree: tree };
  }));
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex").toUpperCase();
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index], process.argv[index + 1]);
  }
  const target = args.get("--target");
  const core = args.get("--core");
  const output = args.get("--output");
  if (!target || !core || !output) {
    throw new Error("Usage: write-core-manifest.mjs --target OS-ARCH --core FILE --output FILE");
  }
  const chain = JSON.parse(fs.readFileSync(path.join(root, "NATIVE_PATCH_CHAIN.json"), "utf8"));
  const version = args.get("--package-version")
    || fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
  const revision = fs.readFileSync(path.join(root, "CODEX-SOURCE-REVISION"), "utf8").trim();
  assert.equal(chain.sourceRevision, revision);
  const descriptor = fs.openSync(core, "r");
  const header = Buffer.alloc(4096);
  try {
    fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  assert.equal(binaryTarget(header), target, "compiled core architecture differs from the target");
  const manifestRoot = args.get("--source-cargo")
    || path.join(root, "codex-source", "codex-rs", "Cargo.toml");
  const declared = fs.readFileSync(manifestRoot, "utf8").match(/^version = "([^"]+)"/m)?.[1];
  assert.ok(declared, "Codex source does not declare a version");
  const coreVersion = `codex-cli ${declared}`;
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "other";
  const runtimeVerified = `${platform}-${arch}` === target;
  if (runtimeVerified) {
    assert.equal(execFileSync(core, ["--version"], { encoding: "utf8", timeout: 30000 }).trim(),
      coreVersion, "the built core did not start on its target runner");
  }
  const patches = await Promise.all(chain.patches.map(async (name) => ({
    name,
    sha256: await digest(path.join(root, "patches", name)),
  })));
  const manifest = manifestFields({
    target, version, revision, tree: chain.patchedTree, coreVersion,
    coreHash: await digest(core), runtimeVerified, patches,
    components: await componentInventory(core, {
      target, coreVersion, revision, tree: chain.patchedTree,
    }),
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Verified ${target} core and wrote ${output}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
