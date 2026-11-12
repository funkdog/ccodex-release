import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { assertTypeScriptBuild, typescriptInputs, typescriptManifest } from "../tools/typescript-state.mjs";
import { desktopExtensionFiles } from "../bridge/desktop-extension-files.mjs";
import { sourceFingerprint } from "../bridge/update-state.mjs";
import { buildNativeSessionsPatch } from "../bridge/desktop-native-composer.mjs";
import { buildCliSelectorPatch } from "../bridge/desktop-cli-selector.mjs";
const source = path.resolve(import.meta.dirname, "..");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mycodex-ts-fixture-"));
  const { inputs, outputs } = typescriptInputs(source);
  for (const relative of [...inputs, ...outputs, typescriptManifest]) {
    const destination = path.join(root, relative); fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(source, relative), destination);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test("compiled runtime validates offline without a TypeScript compiler or node_modules", t => {
  const root = fixture(t);
  assert.equal(fs.existsSync(path.join(root, "node_modules")), false);
  assert.equal(assertTypeScriptBuild(root).applicable, true);
  const result = spawnSync(process.execPath, [path.join(root, "gateway/stdio.mjs"), "--version"], { encoding: "utf8", env: { ...process.env, HOME: root, CODEX_HOME: root } });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /^ccodex-gateway /);
});
test("TS edits, output edits, missing maps, config changes and added source all invalidate a build", t => {
  const root = fixture(t);
  for (const file of ["gateway/router.mts", "gateway/router.mjs", "tsconfig.json", "package-lock.json"]) {
    const target = path.join(root, file), previous = fs.readFileSync(target);
    fs.appendFileSync(target, "\n "); assert.throws(() => assertTypeScriptBuild(root), /stale/);
    fs.writeFileSync(target, previous); assert.equal(assertTypeScriptBuild(root).applicable, true);
  }
  const map = path.join(root, "gateway/router.mjs.map"), content = fs.readFileSync(map);
  fs.unlinkSync(map); assert.throws(() => assertTypeScriptBuild(root), /stale/); fs.writeFileSync(map, content);
  fs.writeFileSync(path.join(root, "gateway/new-component.mts"), "export const value = 1;\n");
  assert.throws(() => assertTypeScriptBuild(root), /stale/);
});
test("stale runtime exits before starting a gateway or touching a private connection", t => {
  const root = fixture(t); fs.appendFileSync(path.join(root, "gateway/server.mts"), "\n ");
  const config = path.join(root, "never-read.json");
  const result = spawnSync(process.execPath, [path.join(root, "gateway/server.mjs"), config], { encoding: "utf8", env: { ...process.env, HOME: root, CODEX_HOME: root } });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /TypeScript build is missing or stale/);
  assert.doesNotMatch(result.stderr, /never-read.json/);
  // Even a direct unit-test-style import must reject stale generated modules.
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import(process.argv[1])', path.join(root, "gateway/router.mjs")], { encoding: "utf8", env: { ...process.env, HOME: root, CODEX_HOME: root } });
  assert.notEqual(imported.status, 0); assert.match(imported.stderr, /TypeScript build is missing or stale/);
});
test("TS source and config affect Desktop generation; emitted maps refer to adjacent source", t => {
  const root = fixture(t), files = desktopExtensionFiles(root);
  assert.ok(files.includes("gateway/router.mts")); assert.ok(files.includes("tsconfig.json"));
  const before = sourceFingerprint(root, files); fs.appendFileSync(path.join(root, "gateway/router.mts"), "\n ");
  assert.notEqual(sourceFingerprint(root, files), before);
  const map = JSON.parse(fs.readFileSync(path.join(root, "gateway/router.mjs.map"), "utf8"));
  assert.deepEqual(map.sources, ["router.mts"]); assert.ok(map.sourcesContent[0].includes("class AppServerRouter"));
});
test("compiled UI installers are valid standalone JavaScript with no compiler helpers", () => {
  for (const patch of [buildNativeSessionsPatch("fixtureBinding", "fixtureReply"), buildCliSelectorPatch("fixtureBinding", "fixtureReply")]) {
    assert.doesNotThrow(() => new Function(patch));
    assert.doesNotMatch(patch, /__awaiter|__importStar|require\(|\.mts["']/);
  }
});
test("failed strict compilation preserves runtime output, and a new DIY component builds and retires cleanly", t => {
  const root = fixture(t);
  // Share the installed development compiler read-only through a temp link;
  // runtime/offline validation above deliberately has no such dependency.
  const dependencies = path.join(source, "node_modules");
  if (!fs.existsSync(path.join(dependencies, "typescript/lib/tsc.js"))) { t.skip("Development compiler is unavailable in this runtime-only package."); return; }
  fs.symlinkSync(dependencies, path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const run = () => spawnSync(process.execPath, [path.join(root, "tools/typescript-build.mjs"), "build"], {
    encoding: "utf8", env: { ...process.env, HOME: root, CODEX_HOME: root }, timeout: 30000,
  });
  const before = fs.readFileSync(path.join(root, "gateway/router.mjs"));
  const manifestBefore = fs.readFileSync(path.join(root, typescriptManifest));
  const bad = path.join(root, "gateway/invalid.mts");
  fs.writeFileSync(bad, "export const value: string = 42;\n");
  const failed = run(); assert.notEqual(failed.status, 0); assert.match(failed.stdout + failed.stderr, /TS2322/);
  assert.deepEqual(fs.readFileSync(path.join(root, "gateway/router.mjs")), before);
  assert.deepEqual(fs.readFileSync(path.join(root, typescriptManifest)), manifestBefore);
  fs.unlinkSync(bad);
  const directory = path.join(root, "bridge/diy"); fs.mkdirSync(directory, { recursive: true });
  const component = path.join(directory, "example.mts");
  fs.writeFileSync(component, 'import type { MountedComponent } from "../desktop-diy-contracts.mjs";\nexport function mount(document: Document): MountedComponent { const host = document.createElement("span"); return { host, dispose() { host.remove(); } }; }\n');
  const built = run(); assert.equal(built.status, 0, built.stdout + built.stderr);
  assert.equal(assertTypeScriptBuild(root).applicable, true);
  assert.match(fs.readFileSync(path.join(directory, "example.mjs"), "utf8"), /export function mount/);
  fs.unlinkSync(component);
  const retired = run(); assert.equal(retired.status, 0, retired.stdout + retired.stderr);
  assert.equal(fs.existsSync(path.join(directory, "example.mjs")), false);
  assert.equal(fs.existsSync(path.join(directory, "example.mjs.map")), false);
  assert.equal(assertTypeScriptBuild(root).applicable, true);
});


test("watch rebuilds new DIY sources and recovers after a strict type error", async t => {
  const root = fixture(t);
  if (!fs.existsSync(path.join(source, "node_modules/typescript/lib/tsc.js"))) { t.skip("Development compiler is unavailable in this runtime-only package."); return; }
  fs.symlinkSync(path.join(source, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  for (const name of ["Invoke-HeavyTask.sh", "Invoke-HeavyTask.ps1"]) fs.copyFileSync(path.join(source, "tools", name), path.join(root, "tools", name));
  const child = spawn(process.execPath, [path.join(root, "tools/typescript-task.mjs"), "watch"], { env: { ...process.env, HOME: root, CODEX_HOME: root }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", data => output += data); child.stderr.on("data", data => output += data);
  const exited = new Promise(resolve => child.once("exit", resolve));
  const waitFor = async predicate => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Watch did not settle: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  const fresh = () => { try { return assertTypeScriptBuild(root).applicable; } catch { return false; } };
  try {
    await waitFor(() => output.includes('"applicable":true'));
    const directory = path.join(root, "bridge/diy"); fs.mkdirSync(directory, { recursive: true });
    const component = path.join(directory, "watch-example.mts"), generated = path.join(directory, "watch-example.mjs");
    fs.writeFileSync(component, 'export const status: string = "ready";\n');
    await waitFor(() => fs.existsSync(generated) && fresh());
    const good = fs.readFileSync(generated);
    fs.writeFileSync(component, 'export const status: string = 42;\n');
    await waitFor(() => output.includes("TS2322"));
    assert.deepEqual(fs.readFileSync(generated), good); assert.equal(fresh(), false);
    fs.writeFileSync(component, 'export const status: string = "recovered";\n');
    await waitFor(() => fresh() && fs.readFileSync(generated, "utf8").includes('"recovered"'));
  } finally { child.kill("SIGTERM"); await exited; }
});
