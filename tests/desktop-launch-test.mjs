import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { launchDesktop } from "../bridge/desktop-launch.mjs";
import { readDesktopInstance } from "../bridge/desktop-instance.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-launch-test-"));
  const home = path.join(root, "profile");
  const snapshot = path.join(root, "snapshot");
  fs.mkdirSync(snapshot);
  const runtime = {
    executable: path.join(snapshot, "ChatGPT.exe"), resources: path.join(snapshot, "resources"),
    manifest: { version: "26.928.3736.0-0123456789ab",
      vendorVersion: "26.928.3736.0", applicationVersion: "26.928.31416" },
  };
  fs.mkdirSync(runtime.resources);
  fs.writeFileSync(runtime.executable, "synthetic, not executed");
  const processes = new Map();
  processes.set(process.pid, { pid: process.pid, platform: process.platform,
    lifetime: "fixture-launcher", executable: process.execPath, args: [process.execPath] });
  const starts = [];
  const preflights = [];
  let nextPid = 4321;
  const start = (executable, args, options) => {
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.unref = () => {};
    processes.set(child.pid, { pid: child.pid, platform: process.platform,
      executable, args: [executable, ...args], lifetime: `fixture:${child.pid}` });
    starts.push({ executable, args, options, pid: child.pid });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const options = {
    root, home, start,
    inherited: { CODEX_CLI_PATH: "/old-enhanced-core", CODEX_COPILOT_BRIDGE_PORT: "22531" },
    preflight: (...args) => preflights.push(args), repair: () => {},
    selectRuntime: () => runtime, allocatePort: async () => 22691,
    inspectProcess: pid => processes.get(pid) || null,
    endpointOwner: () => starts.find(item => item.executable === runtime.executable)?.pid,
    readiness: async ({ pid, port, assertIdentity }) => {
      assertIdentity();
      return { pid, port, rendererVerified: true, endpointOwnerVerified: true };
    },
  };
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^ccodex-launch-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, runtime, processes, starts, preflights, options };
}

test("new Desktop startup creates a lifetime-bound receipt and one scoped helper", async t => {
  const f = fixture(t);
  const result = await launchDesktop(f.options);
  assert.equal(result.reused, false);
  assert.equal(result.schemaVersion, 2);
  assert.equal(f.starts.length, 2);
  assert.deepEqual(f.starts[1].args.slice(1, 3),
    ["--instance", path.join(f.home, "desktop-instance.json")]);
  assert.equal(f.starts[0].options.env.CODEX_CLI_PATH, undefined);
  assert.ok(f.starts[0].args.includes("--remote-debugging-address=127.0.0.1"));
  assert.equal(readDesktopInstance(f.home).helperPid, f.starts[1].pid);
  assert.equal(fs.existsSync(path.join(f.home, "desktop-launch.lock")), false);
});

test("Desktop port resolution reaches only the private app and preflight before any process starts", async t => {
  const f = fixture(t);
  fs.mkdirSync(f.home);
  fs.writeFileSync(path.join(f.home, "bridge-port.txt"), "45555\n");
  const inherited = { ...f.options.inherited, CODEX_HOME: "/original-profile" };
  delete inherited.CODEX_COPILOT_BRIDGE_PORT;
  const result = await launchDesktop({ ...f.options, inherited });
  assert.equal(result.bridgePort, 45555);
  assert.deepEqual(f.preflights.map(([script, , env]) => ({
    script, port: env.CODEX_COPILOT_BRIDGE_PORT, profile: env.CODEX_HOME,
  })), [
    { script: "bridge/ensure.mjs", port: "45555", profile: f.home },
    { script: "bridge/desktop-profile.mjs", port: "45555", profile: f.home },
  ]);
  for (const started of f.starts) {
    assert.equal(started.options.env.CODEX_COPILOT_BRIDGE_PORT, "45555");
    assert.equal(started.options.env.CODEX_HOME, f.home);
    assert.equal(started.options.env.CODEX_ELECTRON_USER_DATA_PATH, path.join(f.home, "desktop-data"));
  }
  assert.equal(inherited.CODEX_HOME, "/original-profile");
  assert.equal(inherited.CODEX_CLI_PATH, "/old-enhanced-core");
});

test("existing owned Desktop reuse preserves active settings and does not replay old inputs", async t => {
  const f = fixture(t);
  const first = await launchDesktop({ ...f.options, arguments: ["old-workspace"] });
  const beforePreflights = f.preflights.length;
  const second = await launchDesktop({ ...f.options, arguments: ["new-workspace"] });
  assert.equal(second.reused, true);
  assert.equal(second.pid, first.pid);
  assert.equal(second.helperPid, first.helperPid);
  assert.equal(f.preflights.length, beforePreflights);
  assert.equal(f.starts.length, 3);
  assert.equal(f.starts[2].args.at(-1), "new-workspace");
  assert.equal(f.starts[2].args.includes("old-workspace"), false);
});

test("a PID-reused receipt cannot launch, focus or patch a different window", async t => {
  const f = fixture(t);
  const first = await launchDesktop(f.options);
  f.processes.set(first.pid, { ...f.processes.get(first.pid), lifetime: "another-lifetime" });
  const starts = f.starts.length;
  await assert.rejects(launchDesktop(f.options), /PID was reused/);
  assert.equal(f.starts.length, starts);
});

test("Desktop controlled launch flags cannot be overridden by caller arguments", async t => {
  const f = fixture(t);
  for (const argument of ["--user-data-dir=/stock", "--remote-debugging-port=9222",
    "--remote-debugging-address=0.0.0.0", "--remote-debugging-pipe", "--remote-allow-origins=*"]) {
    await assert.rejects(launchDesktop({ ...f.options, arguments: [argument] }), /owned by the isolated launcher/);
  }
  assert.equal(f.starts.length, 0);
  assert.equal(fs.existsSync(f.home), false);
});

test("inspect-only Desktop lookup never creates a profile or starts a process", async t => {
  const f = fixture(t);
  const result = await launchDesktop({ ...f.options, inspectOnly: true });
  assert.equal(result.executable, f.runtime.executable);
  assert.equal(f.starts.length, 0);
  assert.equal(fs.existsSync(f.home), false);
});

test("a pending vendor snapshot does not displace a still-running private lifetime", async t => {
  const f = fixture(t);
  const first = await launchDesktop(f.options);
  const newer = { ...f.runtime, executable: path.join(f.root, "new-snapshot", "ChatGPT.exe"),
    resources: path.join(f.root, "new-snapshot", "resources"),
    manifest: { ...f.runtime.manifest, version: "26.930.1.0-abcdef012345" } };
  fs.mkdirSync(newer.resources, { recursive: true });
  fs.writeFileSync(newer.executable, "synthetic newer executable, never started");
  const before = f.preflights.length;
  const result = await launchDesktop({
    ...f.options, selectRuntime: (_root, options) =>
      options?.version === f.runtime.manifest.version ? f.runtime : newer,
  });
  assert.equal(result.pid, first.pid);
  assert.equal(result.snapshotVersion, first.snapshotVersion);
  assert.equal(result.pendingSnapshotVersion, newer.manifest.version);
  assert.equal(f.preflights.length, before);
  assert.equal(f.starts.at(-1).executable, f.runtime.executable);
});

test("failed renderer readiness retains a starting owned receipt but never starts an extension helper", async t => {
  const f = fixture(t);
  await assert.rejects(launchDesktop({
    ...f.options, readiness: async () => { throw new Error("renderer not verified"); },
  }), /renderer not verified/);
  assert.equal(f.starts.length, 1);
  assert.equal(readDesktopInstance(f.home).status, "starting");
  assert.equal(fs.existsSync(path.join(f.home, "desktop-launch.lock")), false);
});

test("all Unix Desktop entrypoints call the isolated launcher and never a stock app fallback", () => {
  const root = path.resolve(import.meta.dirname, "..");
  for (const platform of ["linux", "macos"]) {
    const entry = fs.readFileSync(path.join(root, "platforms", platform, "bin", "codex-copilot-desktop"), "utf8");
    assert.match(entry, /desktop-launch\.mjs/);
    assert.doesNotMatch(entry, /command -v chatgpt|\/Applications\/(?:ChatGPT|Codex)\.app|pgrep|CODEX_CLI_PATH=.*codex-copilot-core/);
  }
});

test("gateway startup and reuse call no provider preflight, repair or CDP business helper", async t => {
  const f = fixture(t);
  let prepares = 0;
  let checks = 0;
  const selection = { mode: "app-server-gateway", host: "isolated", id: "agents", generation: "a".repeat(64),
    home: f.home, arguments: [] };
  const options = { ...f.options, selection,
    preflight: () => assert.fail("provider preflight"), repair: () => assert.fail("provider repair"),
    backend: { mode: "app-server-gateway", bridgePort: null, enhancedUi: false,
      prepare: async () => { prepares++; }, check: async () => { checks++; },
      environment: () => ({ CODEX_CLI_PATH: "/private/gateway", CODEX_APP_SERVER_FORCE_CLI: "1" }) } };
  const first = await launchDesktop(options);
  assert.equal(first.schemaVersion, 3);
  assert.equal(first.bridgePort, null);
  assert.equal(first.helperPid, null);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].options.env.CODEX_COPILOT_BRIDGE_PORT, undefined);
  assert.equal(f.starts[0].options.env.CODEX_COPILOT_CATALOG_FILE, undefined);
  assert.equal(f.starts[0].options.env.CODEX_CLI_PATH, "/private/gateway");
  const second = await launchDesktop(options);
  assert.equal(second.pid, first.pid);
  assert.equal(second.reused, true);
  assert.equal(prepares, 1);
  assert.equal(checks, 2);
  await assert.rejects(launchDesktop({ ...options, selection: { ...selection, generation: "b".repeat(64) } }), /configuration changed/);
  assert.equal(f.starts.length, 2);
});
