import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileSha256, runtimePath } from "../bridge/desktop-runtime.mjs";
import { copyCliComponents, nativeBinaryTarget, requiredCliComponentFiles } from "../bridge/cli-components.mjs";

const TARGET_TRIPLES = {
  "windows-arm64": "aarch64-pc-windows-msvc",
  "windows-x64": "x86_64-pc-windows-msvc",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "macos-arm64": "aarch64-apple-darwin",
  "macos-x64": "x86_64-apple-darwin",
};

/** Retain upstream resource lookup paths without modifying the upstream executable or package. */
export function stageCliPackageComponents({
  packageDirectory, core, target, coreVersion, sourceRevision, patchedTree,
}) {
  const required = requiredCliComponentFiles(target, coreVersion);
  if (!required.length) return [];
  assert.match(sourceRevision, /^[a-f0-9]{40}$/);
  assert.match(patchedTree, /^[a-f0-9]{40}$/);
  const metadataFile = runtimePath(packageDirectory, "codex-package.json");
  const stat = fs.lstatSync(metadataFile);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024,
    "Official CLI package metadata must be a bounded regular file.");
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  assert.equal(metadata.layoutVersion, 1, "Unknown native package layout.");
  assert.equal(metadata.variant, "codex");
  assert.equal(metadata.version, coreVersion.replace(/^codex-cli /, ""));
  assert.equal(metadata.target, TARGET_TRIPLES[target]);
  assert.equal(metadata.resourcesDir, "codex-resources");
  assert.equal(metadata.pathDir, "codex-path");
  const suffix = target.startsWith("windows") ? ".exe" : "";
  assert.equal(metadata.entrypoint, `bin/codex${suffix}`);
  const entrypoint = runtimePath(packageDirectory, metadata.entrypoint);
  assert.equal(nativeBinaryTarget(entrypoint), target);
  assert.equal(nativeBinaryTarget(core), target);
  assert.equal(fileSha256(entrypoint), fileSha256(core),
    "The companion package must belong to the exact selected core bytes.");

  // Validate all upstream inputs and occupied destination slots before copying anything.
  const components = required.map(file => {
    const relative = file.startsWith("codex-code-mode-host") ? `bin/${file}` : file;
    const source = runtimePath(packageDirectory, relative);
    assert.equal(nativeBinaryTarget(source), target, `Wrong companion architecture: ${file}`);
    const sha256 = fileSha256(source);
    const destination = runtimePath(path.dirname(core), file);
    if (fs.existsSync(destination)) {
      const stat = fs.lstatSync(destination);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && fileSha256(destination) === sha256,
        `Immutable companion slot differs: ${file}`);
    }
    return { file, source, sha256, target, sourceRevision, patchedTree };
  });
  for (const component of components) {
    const destination = runtimePath(path.dirname(core), component.file);
    if (!fs.existsSync(destination)) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(component.source, destination, fs.constants.COPYFILE_EXCL);
      if (!target.startsWith("windows")) fs.chmodSync(destination, 0o700);
    }
  }
  const inventory = components.map(({ source: _source, ...row }) => row);
  copyCliComponents({
    sourceCore: core, destinationCore: core,
    manifest: { target, coreVersion, sourceRevision, patchedTree, components: inventory },
  });
  return inventory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [packageDirectory, core, target, coreVersion] = process.argv.slice(2);
    assert.equal(process.argv.length, 6,
      "Usage: stage-cli-package-components.mjs <upstream-package> <core> <target> <core-version>");
    const root = path.resolve(import.meta.dirname, "..");
    const chain = JSON.parse(fs.readFileSync(path.join(root, "NATIVE_PATCH_CHAIN.json"), "utf8"));
    const components = stageCliPackageComponents({
      packageDirectory, core, target, coreVersion,
      sourceRevision: chain.sourceRevision, patchedTree: chain.patchedTree,
    });
    console.log(JSON.stringify({ components, runtimeAcceptanceClaimed: false }));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
