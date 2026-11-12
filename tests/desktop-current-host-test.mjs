import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectCurrentHost, currentHostEnvironment, handleCurrentHost } from "../bridge/desktop-current-host.mjs";
import { resolveDesktopMode } from "../bridge/desktop-mode.mjs";
import { launchDesktop } from "../bridge/desktop-launch.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-current-host-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "ChatGPT.app");
  for (const relative of ["Contents/Resources/app.asar", "Contents/MacOS/ChatGPT", "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"]) {
    const file = path.join(app, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "synthetic not executable");
  }
  const config = { configVersion: 1, defaultInstance: "current", instances: [{ id: "current", mode: "app-server-gateway",
    host: "current", desktopApp: app, gateway: { defaultEngine: "claude", engines: [{ id: "claude", adapter: "claude-code" }] } }] };
  const file = path.join(root, "config.json");
  const resolve = () => { fs.writeFileSync(file, JSON.stringify(config)); return resolveDesktopMode({ defaultConfig: file, inherited: {} }); };
  const options = { platform: "darwin", arch: "arm64", inspectArchive: () => ({ version: "26.1023.50603" }),
    hash: file => file.endsWith("app.asar") ? "94a7fac7fdf222261170204df0406249822431cf4db3627d5524b6ba033ce3e6"
      : "d84a54b031085f01e3ad915ea7c72ebea4dcf69e90f0d1e0e4a637e8280991d2",
    processes: () => [{ pid: 123, lifetime: "synthetic-running-host" }] };
  return { root, app, config, resolve, options };
}
test("current-host config cannot point at a replacement profile or provider-only backend", t => {
  const f = fixture(t);
  assert.equal(f.resolve().host, "current");
  delete f.config.instances[0].host;
  assert.throws(f.resolve, /explicit host/);
  f.config.instances[0].host = "current";
  f.config.instances[0].profile = path.join(f.root, "other-profile");
  assert.throws(f.resolve, /cannot override/);
  delete f.config.instances[0].profile;
  f.config.instances[0].mode = "provider-bridge";
  assert.throws(f.resolve, /requires gateway/);
  assert.equal(fs.existsSync(path.join(f.root, "instances")), false);
});
test("current-host inspection returns the active lifetime while updates fail closed", t => {
  const f = fixture(t);
  const result = inspectCurrentHost(f.app, f.options);
  assert.equal(result.launchPerformed, false);
  assert.equal(result.activationReady, false);
  assert.equal(result.running[0].lifetime, "synthetic-running-host");
  assert.throws(() => inspectCurrentHost(f.app, { ...f.options, hash: () => "changed" }), { code: "HOST_CONTRACT_MISMATCH" });
  assert.throws(() => inspectCurrentHost(f.app, { ...f.options, inspectArchive: () => ({ version: "next" }) }), { code: "HOST_CONTRACT_MISMATCH" });
  assert.throws(() => inspectCurrentHost(f.app, { ...f.options, platform: "win32" }), /pinned/);
  assert.deepEqual(fs.readdirSync(f.root), ["ChatGPT.app"]);
});
test("page mismatch disables UI inspection independently of backend host discovery", t => {
  const f = fixture(t);
  const host = inspectCurrentHost(f.app, { ...f.options, requireUiContract: false,
    inspectArchive: () => ({ version: "future-page" }), hash: () => "future-hash" });
  assert.equal(host.uiAvailable, false);
  assert.equal(host.nativeCli, path.join(fs.realpathSync(f.app), "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"));
  assert.equal(host.running[0].pid, 123);
  assert.deepEqual(fs.readdirSync(f.root), ["ChatGPT.app"]);
});
test("the revalidated Desktop update is accepted only with its exact archive and unchanged CLI", t => {
  const f = fixture(t);
  const updated = { ...f.options, inspectArchive: () => ({ version: "26.1023.51421" }),
    hash: file => file.endsWith("app.asar") ? "1c8ef1bef66e5fc416ae66eff8e6529972aa3601e27a1c7b5f61d6a292b957d3"
      : "d84a54b031085f01e3ad915ea7c72ebea4dcf69e90f0d1e0e4a637e8280991d2" };
  const result = inspectCurrentHost(f.app, updated);
  assert.equal(result.applicationVersion, "26.1023.51421");
  assert.equal(result.launchPerformed, false);
  assert.throws(() => inspectCurrentHost(f.app, { ...updated, hash: f.options.hash }), { code: "HOST_CONTRACT_MISMATCH" });
  assert.throws(() => inspectCurrentHost(f.app, { ...updated,
    hash: file => file.endsWith("app.asar") ? updated.hash(file) : "changed-cli" }), { code: "HOST_CONTRACT_MISMATCH" });
  assert.deepEqual(fs.readdirSync(f.root), ["ChatGPT.app"]);
});
test("current-host branch never reaches snapshot creation, bridge login, startup or profile preparation", async t => {
  const f = fixture(t);
  const selection = f.resolve();
  const forbidden = () => assert.fail("Isolated launch side effect reached from current-host inspection");
  const options = { root: f.root, inherited: {}, selection,
    start: forbidden, selectRuntime: forbidden, preflight: forbidden, repair: forbidden, allocatePort: forbidden,
    inspectHost: app => inspectCurrentHost(app, f.options) };
  const result = await launchDesktop({ ...options, inspectOnly: true });
  assert.equal(result.host, "current");
  assert.equal(result.profile, undefined);
  assert.equal(result.userData, undefined);
  assert.equal(result.gatewayStateHome, selection.home);
  await assert.rejects(launchDesktop(options), /activation is not automatic/);
  assert.equal(fs.existsSync(selection.home), false);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ["ChatGPT.app", "config.json"]);
});

test("prepare can run beside an active app; explicit activation refuses it before any write or start", async t => {
  const f = fixture(t), selection = f.resolve();
  const root = path.resolve(import.meta.dirname, "..");
  let stages = 0;
  const backend = { stage: async () => { stages++; return { shim: "/test/shim" }; } };
  const options = { root, inherited: { HOME: os.homedir() }, selection,
    backend, inspectHost: app => inspectCurrentHost(app, f.options), start: () => assert.fail("Desktop was started") };
  await assert.rejects(launchDesktop({ ...options, selection: { ...selection, activate: true } }), /still running/);
  assert.equal(fs.existsSync(selection.home), false);
  const prepared = await launchDesktop({ ...options, selection: { ...selection, prepareOnly: true } });
  assert.equal(prepared.phase, "prepared"); assert.equal(prepared.launchPerformed, false); assert.equal(stages, 1);
  assert.equal(fs.existsSync(path.join(selection.home, "desktop-data")), false);
  assert.equal(fs.existsSync(path.join(selection.home, "config.toml")), false);
  assert.deepEqual(fs.readdirSync(selection.home), ["current-host-prepared.json"]);
});

test("activation launches only the original app with preserved profile env and a separately owned helper", async t => {
  const f = fixture(t), selection = f.resolve();
  const root = path.resolve(import.meta.dirname, "..");
  const starts = [], identities = new Map();
  let next = 4000;
  const inspectProcess = pid => identities.get(pid) || (pid === process.pid ? {
    pid, platform: "darwin", lifetime: "launcher", executable: process.execPath } : null);
  const backend = { stage: async () => ({ shim: "/test/shim" }), prepare: async () => {},
    environment: () => ({ CODEX_CLI_PATH: "/test/shim", CCODEX_GATEWAY_CONNECTION: "/test/connection", CODEX_APP_SERVER_FORCE_CLI: "1" }) };
  const { EventEmitter } = await import("node:events");
  const options = { root, selection, inherited: { HOME: f.root, CODEX_HOME: path.join(f.root, "native-home") }, backend,
    inspectHost: app => inspectCurrentHost(app, { ...f.options, processes: () => [] }), inspectProcess,
    allocatePort: async () => 22221, readiness: async ({ assertIdentity }) => assertIdentity(),
    start: (executable, args, settings) => {
      const child = new EventEmitter(); child.pid = ++next; child.unref = () => {};
      identities.set(child.pid, { pid: child.pid, platform: "darwin", lifetime: `test:${child.pid}`, executable });
      starts.push({ executable, args, settings }); queueMicrotask(() => child.emit("spawn")); return child;
    } };
  await launchDesktop({ ...options, selection: { ...selection, prepareOnly: true } });
  const result = await launchDesktop({ ...options, selection: { ...selection, activate: true } });
  assert.equal(result.phase, "started"); assert.equal(starts.length, 2);
  assert.equal(starts[0].executable, path.join(fs.realpathSync(f.app), "Contents/MacOS/ChatGPT"));
  assert.equal(starts[0].settings.env.CODEX_HOME, options.inherited.CODEX_HOME);
  assert.equal(starts[0].settings.env.CODEX_ELECTRON_USER_DATA_PATH, undefined);
  assert.equal(starts[0].args.some(arg => /user-data|profile|--new-instance/.test(arg)), false);
  assert.equal(starts[1].args[0], path.join(root, "bridge/desktop-gateway-ui.mjs"));
  assert.equal(fs.statSync(result.helperLog).mode & 0o777, 0o600);
  assert.equal(typeof starts[1].settings.stdio[2], "number");
  assert.equal(fs.existsSync(options.inherited.CODEX_HOME), false);
  assert.equal(fs.existsSync(path.join(selection.home, "desktop-data")), false);
});

for (const uiAvailable of [false, true]) test(`backend continuity when UI is ${uiAvailable ? "failing" : "unsupported"}`, async t => {
  const f = fixture(t), selection = f.resolve(), starts = [];
  const host = { ...inspectCurrentHost(f.app, f.options), running: [], uiAvailable };
  const identity = { pid: 7000, platform: "darwin", lifetime: "isolated", executable: host.executable };
  const options = { root: path.resolve(import.meta.dirname, ".."), selection, inherited: { HOME: f.root },
    inspectHost: () => host, inspectProcess: () => identity,
    backend: { stage: async () => ({}), prepare: async () => {}, environment: () => ({ CODEX_CLI_PATH: "/configured-gateway" }) },
    start: async (executable, args, settings) => { starts.push({ executable, args, settings }); return { pid: 7000 }; },
    readiness: async () => { throw new Error("synthetic UI endpoint failure"); }, allocatePort: async () => 2222 };
  await handleCurrentHost({ ...options, selection: { ...selection, prepareOnly: true } });
  const result = await handleCurrentHost({ ...options, selection: { ...selection, activate: true } });
  assert.equal(result.backendState, "ready"); assert.equal(result.uiState, uiAvailable ? "unavailable" : "unsupported");
  assert.equal(starts.length, 1); assert.equal(starts[0].settings.env.CODEX_CLI_PATH, "/configured-gateway");
  const receipt = JSON.parse(fs.readFileSync(path.join(selection.home, "current-host-launch.json")));
  assert.equal(receipt.backendState, "ready"); assert.equal(receipt.uiState, result.uiState);
  assert.equal(receipt.helperIdentity, null);
});

test("current-host operations and inherited profile overrides cannot accidentally enter the old launcher", t => {
  const f = fixture(t); f.resolve();
  const file = path.join(f.root, "config.json");
  const resolve = args => resolveDesktopMode({ defaultConfig: file, inherited: {}, arguments: args });
  assert.equal(resolve(["--prepare-only"]).prepareOnly, true);
  assert.equal(resolve(["--activate"]).activate, true);
  assert.throws(() => resolve(["--prepare-only", "--activate"]), /separate/);
  assert.throws(() => currentHostEnvironment({ CODEX_ELECTRON_USER_DATA_PATH: "/private" }, {}), /profile override/);
  assert.throws(() => currentHostEnvironment({ CODEX_HOME: "/private", CODEX_COPILOT_HOME: "/private" }, {}), /ccodex profile/);
  const env = currentHostEnvironment({ HOME: "/user", CODEX_HOME: "/native", CODEX_COPILOT_BRIDGE_PORT: "1", NODE_OPTIONS: "unsafe" }, { CODEX_CLI_PATH: "/shim" });
  assert.deepEqual(env, { HOME: "/user", CODEX_HOME: "/native", CODEX_CLI_PATH: "/shim" });
});
