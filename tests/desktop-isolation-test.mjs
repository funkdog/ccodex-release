import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  desktopEnvironment, desktopSnapshot, fileSha256, inspectOfficialDesktop, runtimePath,
} from "../bridge/desktop-runtime.mjs";

function asar(files) {
  const header = { files: {} };
  let offset = 0;
  const contents = [];
  for (const [name, text] of Object.entries(files)) {
    const bytes = Buffer.from(text);
    let parent = header;
    const parts = name.split("/");
    for (const key of parts.slice(0, -1)) {
      parent.files[key] ||= { files: {} };
      parent = parent.files[key];
    }
    parent.files[parts.at(-1)] = { size: bytes.length, offset: String(offset) };
    offset += bytes.length;
    contents.push(bytes);
  }
  const text = Buffer.from(JSON.stringify(header));
  const headerSize = 8 + text.length;
  const lead = Buffer.alloc(16);
  lead.writeUInt32LE(4, 0);
  lead.writeUInt32LE(headerSize, 4);
  lead.writeUInt32LE(headerSize - 4, 8);
  lead.writeUInt32LE(text.length, 12);
  return Buffer.concat([lead, text, ...contents]);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-snapshot-test-"));
  const version = "26.928.3736.0-0123456789ab";
  const snapshot = path.join(root, "desktop", "versions", version);
  const resources = path.join(snapshot, "app", "resources");
  fs.mkdirSync(resources, { recursive: true });
  const executable = path.join(snapshot, "app", "ChatGPT.exe");
  const core = path.join(resources, "codex.exe");
  const archive = path.join(resources, "app.asar");
  fs.writeFileSync(executable, "synthetic executable — not used to launch");
  fs.writeFileSync(core, "synthetic core — not used to launch");
  fs.writeFileSync(archive, asar({
    "package.json": JSON.stringify({
      name: "openai-codex-electron", version: "26.928.31416", productName: "Codex",
    }),
    ".vite/build/bootstrap-test.js":
      'const data=process.env.CODEX_ELECTRON_USER_DATA_PATH; app.setPath("userData", data); app.requestSingleInstanceLock();',
  }));
  const manifest = {
    schemaVersion: 1, version, applicationVersion: "26.928.31416",
    platform: "windows", arch: "arm64",
    executable: "app/ChatGPT.exe", resources: "app/resources",
    files: [executable, core, archive].map(file => ({
      path: path.relative(snapshot, file).replace(/\\/g, "/"), sha256: fileSha256(file),
    })),
  };
  fs.writeFileSync(path.join(snapshot, "snapshot.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, "desktop", "current.json"), JSON.stringify({ version }));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^ccodex-snapshot-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, snapshot, version, executable, resources, archive, manifest };
}

test("Desktop uses an immutable private snapshot, not the newest stock app path", t => {
  const f = fixture(t);
  const selected = desktopSnapshot(f.root, { platform: "win32", arch: "arm64" });
  assert.equal(selected.executable, f.executable);
  assert.equal(selected.resources, f.resources);
  assert.equal(selected.contract.explicitDataPath, true);
  assert.throws(() => desktopSnapshot(f.root, { platform: "win32", arch: "x64" }), /platform/);
  fs.writeFileSync(f.executable, "changed after validation");
  assert.throws(() => desktopSnapshot(f.root, { platform: "win32", arch: "arm64" }), /integrity/);
});

test("child-only Desktop environment discards the CLI override and stale native channels", t => {
  const f = fixture(t);
  const stock = path.join(f.root, "stock");
  const home = path.join(f.root, "copilot");
  const inherited = {
    CODEX_HOME: stock, CODEX_CLI_PATH: "old-patched-cli",
    SKY_CUA_NATIVE_PIPE_DIRECTORY: "old-owned-pipe",
    NODE_REPL_TRUSTED_SERVICES: "stale", BROWSER_USE_ACCESS_PIPE_PATH: "stale",
    CODEX_WINDOWS_REGISTERED_CORE: "1", CODEX_COPILOT_SOURCE_HOME: stock,
    PATH: "keep-path", USER_PREFERENCE: "keep",
  };
  const before = { ...inherited };
  const env = desktopEnvironment({ inherited, home, runtime: f });
  assert.deepEqual(inherited, before, "A process child must not alter its caller");
  assert.equal(env.CODEX_HOME, home);
  assert.equal(env.CODEX_ELECTRON_USER_DATA_PATH, path.join(home, "desktop-data"));
  assert.equal(env.CODEX_ELECTRON_RESOURCES_PATH, f.resources);
  assert.equal(env.PATH, inherited.PATH);
  assert.equal(env.USER_PREFERENCE, "keep");
  for (const key of ["CODEX_CLI_PATH", "SKY_CUA_NATIVE_PIPE_DIRECTORY",
    "NODE_REPL_TRUSTED_SERVICES", "BROWSER_USE_ACCESS_PIPE_PATH", "CODEX_WINDOWS_REGISTERED_CORE"]) {
    assert.equal(Object.hasOwn(env, key), false, key);
  }
});

test("Desktop refuses the original profile, its descendants and linked profile aliases", t => {
  const f = fixture(t);
  const stock = path.join(f.root, "stock");
  fs.mkdirSync(stock);
  const inherited = { CODEX_COPILOT_SOURCE_HOME: stock };
  assert.throws(() => desktopEnvironment({ inherited, home: stock, runtime: f }), /original Codex profile/);
  assert.throws(() => desktopEnvironment({ inherited, home: path.join(stock, "child"), runtime: f }), /original Codex profile/);
  const linked = path.join(f.root, "linked");
  fs.symlinkSync(stock, linked, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => desktopEnvironment({ inherited, home: linked, runtime: f }), /original Codex profile/);
});

test("a missing enhanced profile cannot be created through a parent link into stock", t => {
  const f = fixture(t);
  const stock = path.join(f.root, "stock");
  const linked = path.join(f.root, "linked-stock-parent");
  fs.mkdirSync(stock);
  fs.symlinkSync(stock, linked, process.platform === "win32" ? "junction" : "dir");
  const home = path.join(linked, "not-created", "profile");
  assert.throws(() => desktopEnvironment({
    inherited: { CODEX_COPILOT_SOURCE_HOME: stock }, home, runtime: f,
  }), /original Codex profile/);
  assert.equal(fs.existsSync(path.join(stock, "not-created")), false);
});

test("a custom seed cannot make the ordinary native home available to enhanced Desktop", t => {
  const f = fixture(t);
  assert.throws(() => desktopEnvironment({
    inherited: { CODEX_COPILOT_SOURCE_HOME: path.join(f.root, "custom-seed") },
    home: path.join(os.homedir(), ".codex"), runtime: f,
  }), /original Codex profile/);
});

test("Desktop rejects blank profile paths before creating any files", t => {
  const f = fixture(t);
  for (const home of ["", " ", null, undefined]) {
    assert.throws(() => desktopEnvironment({ home, runtime: f }), /profile path/);
  }
});

test("Desktop child environment removes code-injection overrides and Windows case aliases", t => {
  const f = fixture(t);
  const inherited = {
    ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--require untrusted-startup",
    Codex_Cli_Path: "old-enhanced-core", Codex_Home: "old-stock-path",
  };
  const env = desktopEnvironment({ inherited, home: path.join(f.root, "copilot"), runtime: f });
  assert.equal(Object.hasOwn(env, "ELECTRON_RUN_AS_NODE"), false);
  assert.equal(Object.hasOwn(env, "NODE_OPTIONS"), false);
  if (process.platform === "win32") {
    assert.equal(Object.hasOwn(env, "Codex_Cli_Path"), false);
    assert.equal(Object.hasOwn(env, "Codex_Home"), false);
  }
  assert.deepEqual(inherited, {
    ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--require untrusted-startup",
    Codex_Cli_Path: "old-enhanced-core", Codex_Home: "old-stock-path",
  });
});

test("Desktop selection metadata cannot be linked to an external pointer", t => {
  const f = fixture(t);
  const external = path.join(f.root, "external-desktop");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "current.json"), JSON.stringify({ version: f.version }));
  const desktop = path.join(f.root, "desktop");
  fs.renameSync(desktop, path.join(f.root, "old-desktop"));
  fs.symlinkSync(external, desktop, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => desktopSnapshot(f.root, { platform: "win32", arch: "arm64" }), /ENOENT|regular|contained|link|metadata/);
});

test("Desktop runtime paths cannot follow traversal or a junction into a stock app", t => {
  const f = fixture(t);
  assert.throws(() => runtimePath(f.snapshot, "../stock.exe"), /contained/);
  assert.throws(() => runtimePath(f.snapshot, "C:\\stock.exe"), /contained/);
  const external = path.join(f.root, "external");
  fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(f.snapshot, "linked"),
    process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => runtimePath(f.snapshot, "linked/missing.exe"), /link/);
});

test("Desktop refuses truncated or unsupported vendor archives before activation", t => {
  const f = fixture(t);
  fs.writeFileSync(f.archive, asar({
    "package.json": JSON.stringify({ name: "openai-codex-electron", version: "26.928.31416" }),
    ".vite/build/bootstrap-unknown.js": 'app.requestSingleInstanceLock();',
  }));
  assert.throws(() => inspectOfficialDesktop(f.archive), /independent/);
  fs.writeFileSync(f.archive, Buffer.alloc(8));
  assert.throws(() => inspectOfficialDesktop(f.archive), /truncated/);
});

test("Windows Desktop GUI launcher never activates MSIX or changes the registry", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "../src/CodexCopilotDesktop.cs"), "utf8");
  assert.doesNotMatch(source, /Registry\.|SetEnvironmentVariable|AppsFolder|ActivateApplication|Stop-Process/);
  assert.match(source, /desktop-launch\.mjs/);
  assert.match(source, /CommandLineToArgvW-compatible/);
  assert.match(source, /The original ChatGPT Desktop and Codex CLI were not modified or stopped/);
});

test("programmatic snapshot validation through node -e does not invoke the module CLI", t => {
  const f = fixture(t);
  const module = path.resolve(import.meta.dirname, "../bridge/desktop-runtime.mjs");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    'import {pathToFileURL} from "node:url";const m=await import(pathToFileURL(process.argv[1]));console.log(m.desktopSnapshot(process.argv[2],{platform:"win32",arch:"arm64"}).manifest.version);',
    module, f.root], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), f.version);
});
