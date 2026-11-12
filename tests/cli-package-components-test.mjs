import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageCliPackageComponents } from "../tools/stage-cli-package-components.mjs";
import { requiredCliComponentFiles, verifyCliComponents } from "../bridge/cli-components.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-upstream-components-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(directory), /^ccodex-upstream-components-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const packageDirectory = path.join(directory, "upstream");
  const core = path.join(directory, "selected", "codex-copilot-core.exe");
  const bytes = Buffer.alloc(256);
  bytes.writeUInt16LE(0x5a4d);
  bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x00004550, 128);
  bytes.writeUInt16LE(0xaa64, 132);
  bytes.write("parser fixture; no executable or runtime acceptance", 160);
  const put = (file, contents) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  const metadata = { layoutVersion: 1, variant: "codex", version: "0.160.0",
    target: "aarch64-pc-windows-msvc", entrypoint: "bin/codex.exe",
    resourcesDir: "codex-resources", pathDir: "codex-path" };
  put(path.join(packageDirectory, "codex-package.json"), JSON.stringify(metadata));
  put(core, bytes);
  put(path.join(packageDirectory, metadata.entrypoint), bytes);
  for (const file of requiredCliComponentFiles("windows-arm64", "codex-cli 0.160.0")) {
    put(path.join(packageDirectory,
      file.startsWith("codex-code-mode-host") ? "bin" : "", file), bytes);
  }
  return { directory, packageDirectory, core, target: "windows-arm64",
    coreVersion: "codex-cli 0.160.0", sourceRevision: "a".repeat(40), patchedTree: "b".repeat(40),
    metadata, put };
}

test("upstream companions preserve the native path/resources layout in a private core slot", t => {
  const f = fixture(t);
  const components = stageCliPackageComponents(f);
  assert.deepEqual(stageCliPackageComponents(f), components);
  const manifest = { ...f, components };
  assert.equal(verifyCliComponents({ core: f.core, manifest }).length, 4);
  assert.ok(fs.existsSync(path.join(path.dirname(f.core), "codex-path", "rg.exe")));
  assert.ok(fs.existsSync(path.join(path.dirname(f.core), "codex-resources",
    "codex-command-runner.exe")));
  assert.ok(!fs.existsSync(path.join(path.dirname(f.core), "rg.exe")));
});

for (const change of ["different core", "different version", "different target", "unknown layout", "missing helper"]) {
  test(`upstream companion staging refuses ${change} before copying`, t => {
    const f = fixture(t);
    if (change === "different core") fs.appendFileSync(f.core, "different");
    else if (change === "missing helper") {
      fs.unlinkSync(path.join(f.packageDirectory, "codex-resources", "codex-command-runner.exe"));
    } else {
      if (change === "different version") f.metadata.version = "0.159.2";
      if (change === "different target") f.metadata.target = "x86_64-pc-windows-msvc";
      if (change === "unknown layout") f.metadata.layoutVersion = 2;
      f.put(path.join(f.packageDirectory, "codex-package.json"), JSON.stringify(f.metadata));
    }
    assert.throws(() => stageCliPackageComponents(f));
    assert.deepEqual(fs.readdirSync(path.dirname(f.core)), ["codex-copilot-core.exe"]);
  });
}
