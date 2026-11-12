import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { nativeAdapterCommand } from "../release/native-adapter.mjs";
import { releaseEnvironment } from "../release/environment.mjs";

const root = path.resolve(import.meta.dirname, "..");
const metadata = JSON.parse(fs.readFileSync(path.join(root, "release.json"), "utf8"));

test("native adapter rejects outside executables and keeps all core arguments literal", () => {
  const file = path.join(root, metadata.corePath);
  const args = ["exec", "literal \"quoted\" argument", "space and \u4e2d\u6587"];
  const command = nativeAdapterCommand(root, file, args);
  assert.equal(command.file, path.join(root, "bin", "ccodex-release-native.exe"));
  assert.deepEqual(command.args, [file, ...args]);
  assert.throws(() => nativeAdapterCommand(root, process.execPath), /contained/);
});

test("actual ARM64 adapter resolves its own runtime without a system-wide change", () => {
  const env = releaseEnvironment({ root });
  const result = spawnSync(path.join(root, "bin", "ccodex-release-native.exe"), ["--probe"], {
    env, encoding: "utf8", windowsHide: true, timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    adapterActive: true, programFiles: path.join(root, "runtime"),
  });
});

test("actual enhanced core retains its pinned version through the adapter", () => {
  const command = nativeAdapterCommand(root, path.join(root, metadata.corePath), ["--version"]);
  const result = spawnSync(command.file, command.args, {
    env: releaseEnvironment({ root }), encoding: "utf8", windowsHide: true, timeout: 60000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.equal(result.stdout.trim(), metadata.coreVersion);
});

test("adapter propagation is restricted to the release core, not ordinary agent tools", () => {
  const source = fs.readFileSync(path.join(root, "src", "ReleaseNativeHost.cpp"), "utf8");
  assert.match(source, /privateImage\(application, L"codex\.exe"\)/);
  assert.doesNotMatch(source, /WriteProcessMemory|RegSetValue|SetEnvironmentVariableW\(L"PATH"/);
  const config = fs.readFileSync(path.join(root, "release", "gitconfig"), "utf8");
  assert.match(config, /longpaths = true/);
});
