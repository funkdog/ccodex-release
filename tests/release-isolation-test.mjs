import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { releaseEnvironment } from "../release/environment.mjs";
import { assertReleaseProfile, acquireFileLock, assertRegularPath } from "../release/paths.mjs";
import { ensureReleasePort, profileIdentity } from "../release/bridge-port.mjs";
import { bridgeSourceGeneration } from "../bridge/runtime-generation.mjs";
import { normalizeCliSelection } from "../release/model-selection.mjs";
import { retirePreviousDesktop } from "../release/prepare-profile.mjs";

const install = path.resolve(import.meta.dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-release-regression-"));
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const home = name => {
  const folder = path.join(temporary, name);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
};

test("private runtime wins over global Codex/Copilot and contaminated environment", () => {
  const profile = home("private");
  const inherited = {
    USERPROFILE: home("user"), LOCALAPPDATA: home("local"), PATH: "global-older-node;global-copilot",
    CODEX_HOME: "stock-home", CODEX_CLI_PATH: "stock-core", CODEX_COPILOT_HOME: "older-profile",
    CODEX_COPILOT_BRIDGE_PORT: "12345", CODEX_COPILOT_GITHUB_TOKEN: "SYNTHETIC_UNWANTED_TOKEN",
    COPILOT_CLI_PATH: "other-copilot", NODE_OPTIONS: "--require=unexpected",
    NODE_REPL_NODE_PATH: "old-repl", SKY_CUA_NATIVE_PIPE_DIRECTORY: "old-pipe",
    CCODEX_WORKSPACE: "user-selected-workspace", HTTP_PROXY: "explicit-system-proxy",
    ProgramFiles: "foreign-programs", ProgramW6432: "foreign-programs64",
    "ProgramFiles(x86)": "foreign-programs-x86",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "foreign-helper",
  };
  const snapshot = { ...inherited };
  const env = releaseEnvironment({ root: install, home: profile, inherited });
  assert.deepEqual(inherited, snapshot);
  assert.equal(env.CODEX_HOME, profile);
  assert.equal(env.CODEX_CLI_PATH, undefined);
  assert.equal(env.CODEX_COPILOT_GITHUB_TOKEN, undefined);
  assert.equal(env.CODEX_COPILOT_BRIDGE_PORT, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.SKY_CUA_NATIVE_PIPE_DIRECTORY, undefined);
  assert.equal(env.CODEX_COPILOT_AUTH_MODE, "saved");
  assert.equal(env.COPILOT_AUTO_UPDATE, "false");
  assert(env.COPILOT_CLI_PATH.startsWith(install));
  assert(env.PATH.startsWith(path.join(install, "runtime", "node")));
  assert.equal(env.CCODEX_WORKSPACE, inherited.CCODEX_WORKSPACE);
  assert.equal(env.HTTP_PROXY, inherited.HTTP_PROXY);
  assert.equal(env.ProgramFiles, path.join(install, "runtime"));
  assert.equal(env.ProgramW6432, env.ProgramFiles);
  assert.equal(env["ProgramFiles(x86)"], env.ProgramFiles);
  assert.equal(env.CCODEX_REAL_PROGRAMFILES, inherited.ProgramFiles);
  assert.equal(env.GIT_CONFIG_KEY_0, undefined);
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(env.GIT_CONFIG_GLOBAL, path.join(profile, "host-profile", ".gitconfig"));
  assert.equal(env.PYTHONHOME, path.toNamespacedPath(path.join(install, "runtime",
    "primary", "codex-primary-runtime", "dependencies", "python")));
  assert.equal(env.PYTHONNOUSERSITE, "1");
  assert(env.PYTHONUSERBASE.startsWith(profile + path.sep));
  assert(env.PYTHONPATH.split(path.delimiter).every(directory => directory.startsWith("\\\\?\\")));
});

test("CLI and Desktop hosts use private homes while retaining real shell locations", () => {
  const user = home("desktop-user"), profile = home("desktop-profile");
  const inherited = {
    USERPROFILE: user, LOCALAPPDATA: home("desktop-local"), APPDATA: home("desktop-roaming"),
    TEMP: home("desktop-temp"), PATH: "",
  };
  const desktop = releaseEnvironment({ root: install, home: profile, inherited, desktopHost: true });
  assert.equal(desktop.USERPROFILE, path.join(profile, "host-profile"));
  assert(desktop.LOCALAPPDATA.startsWith(profile + path.sep));
  assert(desktop.APPDATA.startsWith(profile + path.sep));
  assert(desktop.TEMP.startsWith(profile + path.sep));
  const cli = releaseEnvironment({ root: install, home: profile, inherited: desktop });
  assert.equal(cli.USERPROFILE, desktop.USERPROFILE);
  assert.equal(cli.HOME, desktop.USERPROFILE);
  assert.equal(cli.CCODEX_REAL_USERPROFILE, user);
  assert.equal(cli.CCODEX_REAL_LOCALAPPDATA, inherited.LOCALAPPDATA);
  assert.equal(cli.CCODEX_REAL_APPDATA, inherited.APPDATA);
  assert.equal(cli.CCODEX_REAL_TEMP, inherited.TEMP);
});

test("mixed-case Windows variables preserve the real user but cannot bypass private bindings", () => {
  const user = home("mixed-case-user"), profile = home("mixed-case-profile");
  const inherited = {
    userprofile: user, LocalAppData: home("mixed-case-local"), AppData: home("mixed-case-roaming"),
    Temp: home("mixed-case-temp"), Path: "foreign-node;foreign-copilot",
    programfiles: "foreign-programs", "programfiles(x86)": "foreign-x86",
    codex_home: "foreign-profile", node_options: "--require=foreign-preload",
    copilot_cli_path: "foreign-copilot", no_proxy: "example.internal",
  };
  const env = releaseEnvironment({ root: install, home: profile, inherited });
  assert.equal(env.CCODEX_REAL_USERPROFILE, user);
  assert.equal(env.CCODEX_REAL_LOCALAPPDATA, inherited.LocalAppData);
  assert.equal(env.CCODEX_REAL_APPDATA, inherited.AppData);
  assert.equal(env.CCODEX_REAL_TEMP, inherited.Temp);
  assert.equal(env.CCODEX_REAL_PROGRAMFILES, inherited.programfiles);
  assert.equal(env.USERPROFILE, path.join(profile, "host-profile"));
  assert.equal(env.ProgramFiles, path.join(install, "runtime"));
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.CODEX_HOME, profile);
  assert(env.PATH.startsWith(path.join(install, "runtime", "node") + path.delimiter));
  assert(env.PATH.endsWith("foreign-node;foreign-copilot"));
  assert(env.NO_PROXY.includes("example.internal"));
  const names = Object.keys(env).map(name => name.toUpperCase());
  assert.equal(names.length, new Set(names).size);
});

test("duplicate Windows environment keys use deterministic precedence without repeated private PATH entries", () => {
  const profile = home("duplicate-environment");
  const env = releaseEnvironment({ root: install, home: profile, inherited: {
    PATH: "first-path", Path: "ignored-path", path: "also-ignored",
    NO_PROXY: "first.internal", no_proxy: "ignored.internal",
    USERPROFILE: home("duplicate-user"), userprofile: "ignored-user",
  } });
  assert(env.PATH.endsWith("first-path"));
  assert(!env.PATH.includes("ignored-path"));
  assert(env.NO_PROXY.includes("first.internal"));
  assert(!env.NO_PROXY.includes("ignored.internal"));
  const nested = releaseEnvironment({ root: install, home: profile, inherited: env });
  assert.equal(nested.PATH, env.PATH);
  assert.equal(nested.CCODEX_REAL_USERPROFILE, env.CCODEX_REAL_USERPROFILE);
});

test("native child receives exactly one private PATH and the bundled Git discovery root", () => {
  const profile = home("native-environment");
  const env = releaseEnvironment({ root: install, home: profile, inherited: {
    ...process.env, Path: "foreign-node", programfiles: "foreign-programs",
  } });
  const result = spawnSync(path.join(install, "runtime", "node", "node.exe"), ["-e",
    'console.log(JSON.stringify({path:process.env.PATH,programs:process.env.ProgramFiles,' +
    'names:Object.keys(process.env).map(n=>n.toUpperCase())}))'], {
    env, encoding: "utf8", windowsHide: true, timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  const child = JSON.parse(result.stdout);
  assert.equal(child.path, env.PATH);
  assert.equal(child.programs, path.join(install, "runtime"));
  assert.equal(child.names.length, new Set(child.names).size);
});

test("Chinese and space-containing paths are carried without reconstruction", () => {
  const profile = home("\u540c\u4e8b \u914d\u7f6e");
  const user = home("\u7528\u6237 home");
  const env = releaseEnvironment({ root: install, home: profile, inherited: {
    USERPROFILE: user, LOCALAPPDATA: home("unicode-local"),
  } });
  assert.equal(env.CODEX_HOME, profile);
  assert.equal(env.CCODEX_REAL_USERPROFILE, user);
  assert.equal(env.CCODEX_WORKSPACE, path.join(user, "Ccodex Workspace"));
});

test("relative resource roots are resolved before generating any runtime bindings", () => {
  const profile = home("relative-resources");
  const env = releaseEnvironment({ root: path.relative(process.cwd(), install), home: profile });
  assert.equal(env.CCODEX_RELEASE_ROOT, install);
  assert.equal(path.isAbsolute(env.COPILOT_CLI_PATH), true);
  assert.equal(path.isAbsolute(env.CODEX_PRIMARY_RUNTIME_ROOT), true);
});

test("profiles cannot overlap stock profiles, the user home or installation slots", () => {
  const user = home("boundary-user");
  const inherited = { USERPROFILE: user, LOCALAPPDATA: home("boundary-local") };
  for (const name of [".codex", ".copilot", ".codex-copilot"]) {
    assert.throws(() => assertReleaseProfile(path.join(user, name), install, inherited), /overlap/);
    assert.throws(() => assertReleaseProfile(path.join(user, name, "nested"), install, inherited), /overlap/);
  }
  assert.throws(() => assertReleaseProfile(user, install, inherited), /overlap/);
  assert.throws(() => assertReleaseProfile(path.join(install, "profile"), install, inherited), /overlap/);
  assert.equal(assertReleaseProfile(home("independent"), install, inherited), home("independent"));
});

test("malformed and active locks are preserved instead of guessing ownership", () => {
  const file = path.join(home("locks"), "operation.lock");
  const unlock = acquireFileLock(file);
  assert.throws(() => acquireFileLock(file), /active/);
  unlock();
  fs.writeFileSync(file, '{"pid":"invalid"}');
  assert.throws(() => acquireFileLock(file), /malformed/);
  assert.equal(fs.readFileSync(file, "utf8"), '{"pid":"invalid"}');
  fs.unlinkSync(file);
});

test("malformed bridge pointers fail closed without rewriting", async () => {
  const profile = home("invalid-port"), file = path.join(profile, "bridge-port.txt");
  fs.writeFileSync(file, "../other");
  await assert.rejects(ensureReleasePort(profile, install), /Invalid/);
  assert.equal(fs.readFileSync(file, "utf8"), "../other");
});

test("foreign process on the port is preserved while the release changes ports", async () => {
  const profile = home("port-conflict");
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ bridge: "another-app" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const original = server.address().port;
  fs.writeFileSync(path.join(profile, "bridge-port.txt"), `${original}\n`);
  fs.writeFileSync(path.join(profile, "config.toml"), '[model_providers.github-copilot]\nbase_url = "old"\n');
  try {
    const selected = await ensureReleasePort(profile, install);
    assert.notEqual(selected, original);
    assert(server.listening);
    assert(fs.readFileSync(path.join(profile, "config.toml"), "utf8").includes(`127.0.0.1:${selected}`));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("same bridge type with a different profile is not reused", async () => {
  const profile = home("wrong-profile"), port = 12346;
  fs.writeFileSync(path.join(profile, "bridge-port.txt"), `${port}\n`);
  const selected = await ensureReleasePort(profile, install, { probe: async () => ({
    ok: true, json: async () => ({
      bridge: "codex-copilot", runtime: {
        releaseProfileIdentity: profileIdentity(home("foreign-profile")),
        sourceGeneration: bridgeSourceGeneration(path.join(install, "bridge")),
      },
    }),
  }) });
  assert.notEqual(selected, port);
});

test("only matching profile and source generation can reuse a bridge", async () => {
  const profile = home("matching-profile"), port = 12347;
  fs.writeFileSync(path.join(profile, "bridge-port.txt"), `${port}\n`);
  const selected = await ensureReleasePort(profile, install, { probe: async () => ({
    ok: true, json: async () => ({
      bridge: "codex-copilot", runtime: {
        releaseProfileIdentity: profileIdentity(profile),
        sourceGeneration: bridgeSourceGeneration(path.join(install, "bridge")),
      },
    }),
  }) });
  assert.equal(selected, port);
});

test("older bridge generation gets a new port with no shutdown request", async () => {
  const profile = home("older-generation"), port = 12348;
  fs.writeFileSync(path.join(profile, "bridge-port.txt"), `${port}\n`);
  let requestCount = 0;
  const selected = await ensureReleasePort(profile, install, { probe: async url => {
    requestCount++;
    assert(url.endsWith("/health"));
    return { ok: true, json: async () => ({
      bridge: "codex-copilot", runtime: {
        releaseProfileIdentity: profileIdentity(profile), sourceGeneration: "old",
      },
    }) };
  } });
  assert.notEqual(selected, port);
  assert.equal(requestCount, 1);
});

test("junctions are refused before any release-owned write", t => {
  const target = home("junction-target"), link = path.join(temporary, "junction-profile");
  try { fs.symlinkSync(target, link, "junction"); }
  catch { t.skip("Host cannot create junctions"); return; }
  try {
    assert.throws(() => assertRegularPath(path.join(link, "child")), /junctions/);
    assert.equal(fs.readdirSync(target).length, 0);
  } finally { fs.unlinkSync(link); }
});

test("a colleague's authorized models replace only an unavailable CLI selection", () => {
  const profile = home("different-entitlement");
  const file = path.join(profile, "ccodex.config.toml");
  fs.writeFileSync(path.join(profile, "config.toml"), 'model="available--default-context"\n');
  fs.writeFileSync(file, 'model="publisher-only"\nmodel_reasoning_effort="max"\nservice_tier="context-long"\n[tui]\nraw_output_mode=true\n');
  fs.writeFileSync(path.join(profile, "models.json"), JSON.stringify({ models: [{
    slug: "available", default_reasoning_level: "low",
    supported_reasoning_levels: [{ effort: "low" }], copilot: {},
  }] }));
  assert.deepEqual(normalizeCliSelection(profile), {
    model: "available", effort: "low", changed: true,
  });
  assert(fs.readFileSync(file, "utf8").includes("raw_output_mode=true"));
  assert.equal(normalizeCliSelection(profile).changed, false);
});

test("reinstall retires only an expired release Desktop receipt and preserves live lifetimes", () => {
  const profile = home("reinstall-receipt");
  const file = path.join(profile, "desktop-instance.json");
  const identity = {
    pid: 31415, platform: "win32", executable: path.join(temporary, "previous", "ChatGPT.exe"),
    lifetime: "windows:123456",
  };
  const receipt = {
    schemaVersion: 2, profile, installRoot: path.join(temporary, "previous"),
    identity, helperIdentity: null,
  };
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.throws(() => retirePreviousDesktop(profile, install, () => identity), /Close the previous/);
  assert.equal(fs.existsSync(file), true);
  assert.equal(retirePreviousDesktop(profile, install, () => null), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(profile).filter(name => name.startsWith("desktop-instance-retired-")).length, 1);
});

test("same-slot reinstall retires expired Desktop identity and keeps its live private instance", () => {
  const profile = home("same-slot-receipt");
  const file = path.join(profile, "desktop-instance.json");
  const identity = { pid: 31416, platform: "win32", executable: path.join(install, "Desktop.exe"), lifetime: "windows:2345" };
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, profile, installRoot: install, identity }));
  assert.equal(retirePreviousDesktop(profile, install, () => identity), false);
  assert.equal(fs.existsSync(file), true);
  assert.equal(retirePreviousDesktop(profile, install, () => ({ ...identity, lifetime: "windows:6789" })), true);
  assert.equal(fs.existsSync(file), false);
});
