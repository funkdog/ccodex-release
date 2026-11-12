import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDesktopShortcut } from "../bridge/desktop-shortcut.mjs";
import { resolveDesktopMode } from "../bridge/desktop-mode.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-shortcut-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const application = path.join(root, "ChatGPT.app"), executable = path.join(application, "Contents/MacOS/ChatGPT");
  const configFile = path.join(root, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({ configVersion: 1, defaultInstance: "current", instances: [{
    id: "current", host: "current", mode: "app-server-gateway", desktopApp: application,
    gateway: { defaultEngine: "copilot", engines: [{ id: "copilot", adapter: "github-copilot" }] },
  }] }));
  const selection = resolveDesktopMode({ arguments: ["--config", configFile], inherited: {} });
  const identity = { pid: 123, lifetime: "app-lifetime", platform: "darwin", executable };
  const helperIdentity = { pid: 456, lifetime: "helper-lifetime", platform: "darwin", executable: process.execPath };
  const host = { application, executable, nativeCli: "/synthetic/cli", archiveSha256: "archive", cliSha256: "cli", running: [] };
  const calls = [];
  const receipt = { schemaVersion: 1, state: "started", application, generation: selection.generation,
    archiveSha256: "archive", cliSha256: "cli", identity, helperIdentity };
  const options = { root, configFile, inherited: {}, inspectHost: () => host,
    inspectProcess: pid => pid === 123 ? identity : pid === 456 ? helperIdentity : null,
    read: () => receipt, backendFactory: () => ({ check: async () => { calls.push("check"); } }),
    launch: async ({ selection }) => { calls.push(selection.prepareOnly ? "prepare" : "activate");
      return { pid: 123, activationVerified: false }; } };
  return { root, options, host, identity, receipt, calls, selection };
}

test("a cold shortcut prepares then activates the existing app through the shared launcher", async t => {
  const f = fixture(t);
  const result = await runDesktopShortcut(f.options);
  assert.deepEqual(f.calls, ["prepare", "activate"]);
  assert.equal(result.action, "started"); assert.equal(result.application, f.host.application);
  assert.equal(result.activationVerified, false);
});
test("check-only never starts services or prepares files", async t => {
  const f = fixture(t);
  assert.equal((await runDesktopShortcut({ ...f.options, checkOnly: true })).action, "ready-to-start");
  assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.selection.home), false);
});
test("adapters-only failures preserve the app and cannot create automatic repair chats", async t => {
  const f = fixture(t);
  const config = JSON.parse(fs.readFileSync(f.options.configFile));
  config.instances[0].gateway.workbench = false;
  fs.writeFileSync(f.options.configFile, JSON.stringify(config));
  const result = await runDesktopShortcut({ ...f.options,
    inspectHost: () => { throw new Error("unsupported host"); },
    fallbackLaunch: async () => ({ pid: 456, launchPerformed: true }),
    queueRepair: async () => assert.fail("Adapters release must not dispatch a repair chat") });
  assert.equal(result.backendState, "unavailable");
  assert.equal(result.repairSession.action, "disabled");
});
test("unsupported page still prepares configured backend instead of an empty offline fallback", async t => {
  const f = fixture(t); f.host.uiAvailable = false;
  const result = await runDesktopShortcut({ ...f.options,
    queueRepair: async options => { assert.equal(options.category, "page-contract"); return { action: "queued" }; },
    fallbackLaunch: () => assert.fail("Page mismatch must not remove the configured backend"),
    launch: async ({ selection }) => {
      assert.deepEqual(selection.gateway.engines, f.selection.gateway.engines);
      f.calls.push(selection.prepareOnly ? "prepare" : "activate"); return { pid: 123, backendState: "ready", uiState: "unsupported" };
    } });
  assert.equal(result.action, "started"); assert.deepEqual(f.calls, ["prepare", "activate"]);
  assert.equal(result.backendState, "ready"); assert.equal(result.uiState, "unsupported");
  assert.equal(result.repairSession.action, "queued");
});
test("an ordinary running app is preserved, including when a stale receipt has its PID", async t => {
  const f = fixture(t); f.host.running = [{ pid: 123, lifetime: "another-lifetime" }];
  const result = await runDesktopShortcut(f.options);
  assert.equal(result.action, "activate-existing"); assert.equal(result.backendState, "unavailable");
  assert.equal(result.launchPerformed, false);
  assert.deepEqual(f.calls, []);
});
test("a matching app remains usable when only its UI helper is unavailable", async t => {
  const f = fixture(t); f.host.running = [f.identity];
  const result = await runDesktopShortcut(f.options);
  assert.equal(result.action, "activate-existing"); assert.equal(result.pid, 123);
  assert.deepEqual(f.calls, ["check"]);
  const withoutUi = await runDesktopShortcut({ ...f.options, inspectProcess: pid => pid === 123 ? f.identity : null });
  assert.equal(withoutUi.action, "activate-existing");
  assert.equal(withoutUi.backendState, "ready"); assert.equal(withoutUi.uiState, "unavailable");
  const offline = await runDesktopShortcut({ ...f.options, queueRepair: async () => ({ action: "queued" }),
    backendFactory: () => ({ check: async () => { throw new Error("offline"); } }) });
  assert.equal(offline.action, "activate-existing"); assert.equal(offline.backendState, "unavailable");
  assert.equal(offline.repairSession.action, "queued");
  const stale = await runDesktopShortcut({ ...f.options, backendFactory: () => ({ check: async () => {
    throw Object.assign(new Error("changed"), { code: "GATEWAY_RUNTIME_RETIRING" });
  } }) });
  assert.equal(stale.action, "activate-existing"); assert.equal(stale.backendReason, "update-pending");
  assert.equal(f.calls.includes("activate"), false);
});
test("a backend-only running app remains usable without a page helper", async t => {
  const f = fixture(t); f.host.running = [f.identity]; f.host.uiAvailable = false;
  f.receipt.uiState = "unsupported"; f.receipt.helperIdentity = null;
  const result = await runDesktopShortcut(f.options);
  assert.equal(result.action, "activate-existing");
  assert.equal(result.pid, 123);
  assert.deepEqual(f.calls, ["check"]);
});
test("a live helper is not proof of a healthy page: only fresh matching health reports are accepted", async t => {
  const f = fixture(t); f.host.running = [f.identity];
  f.receipt.sourceGeneration = "source";
  let health = { schemaVersion: 1, sourceGeneration: "source", app: f.identity,
    helper: { pid: 456, lifetime: "helper-lifetime", platform: "darwin", executable: process.execPath },
    state: "ready", updatedAt: new Date().toISOString() };
  const read = file => file.endsWith("current-host-ui-status.json") ? health : f.receipt;
  assert.equal((await runDesktopShortcut({ ...f.options, read })).uiState, "ready");
  health = { ...health, state: "retrying" };
  const retrying = await runDesktopShortcut({ ...f.options, read });
  assert.equal(retrying.backendState, "ready"); assert.equal(retrying.uiState, "unavailable");
  health = { ...health, state: "ready", updatedAt: new Date(Date.now() - 120000).toISOString() };
  assert.equal((await runDesktopShortcut({ ...f.options, read })).uiState, "unavailable");
  health = { ...health, updatedAt: new Date().toISOString(), sourceGeneration: "previous" };
  assert.notEqual((await runDesktopShortcut({ ...f.options, read })).uiState, "ready");
  health = { ...health, sourceGeneration: "source", app: { ...f.identity, lifetime: "previous" } };
  assert.notEqual((await runDesktopShortcut({ ...f.options, read })).uiState, "ready");
  assert.equal(f.calls.includes("prepare"), false);
});
test("changed config or incompatible host cannot silently switch a running instance", async t => {
  const f = fixture(t); f.host.running = [f.identity]; f.receipt.generation = "different";
  assert.equal((await runDesktopShortcut(f.options)).action, "activate-existing");
  const unverified = await runDesktopShortcut({ ...f.options, inspectHost: () => { throw new Error("unverified host"); } });
  assert.equal(unverified.action, "needs-attention"); assert.match(unverified.message, /unverified host/);
  assert.deepEqual(f.calls, []);
});
test("an authenticated additive CLI configuration retains the running app's original transport binding", async t => {
  const f = fixture(t); f.host.running = [f.identity];
  f.receipt.connectionFile = path.join(f.selection.home, "gateway", "connection.json");
  const config = JSON.parse(fs.readFileSync(f.options.configFile));
  config.instances[0].gateway.engines.push({ id: "claude", adapter: "claude-code" });
  fs.writeFileSync(f.options.configFile, JSON.stringify(config));
  const next = resolveDesktopMode({ arguments: ["--config", f.options.configFile], inherited: {} });
  const binding = { generation: f.receipt.generation, configGeneration: next.generation,
    connectionFile: f.receipt.connectionFile };
  const backendFactory = () => ({ check: async () => binding });
  const result = await runDesktopShortcut({ ...f.options, checkOnly: true, backendFactory });
  assert.equal(result.backendState, "ready");
  assert.equal(result.launchPerformed, false);
  assert.equal(f.receipt.generation, f.selection.generation, "Inspection cannot rewrite launch history");
  for (const bad of [{ ...binding, generation: "another-transport" },
    { ...binding, configGeneration: "another-config" }, { ...binding, connectionFile: "/another/connection.json" }]) {
    const refused = await runDesktopShortcut({ ...f.options, checkOnly: true,
      backendFactory: () => ({ check: async () => bad }) });
    assert.equal(refused.backendReason, "launch-mismatch");
  }
  const pending = await runDesktopShortcut({ ...f.options, checkOnly: true,
    backendFactory: () => ({ check: async () => { throw Object.assign(new Error("New code pending"),
      { code: "GATEWAY_RUNTIME_RETIRING", binding }); } }) });
  assert.equal(pending.backendState, "ready"); assert.equal(pending.backendReason, "update-pending");
  assert.deepEqual(f.calls, [], "No launch, repair or reconfiguration is needed to inspect a retained binding");
});
test("an adapter prepared after a backend-only launch reports pending loading without starting a helper", async t => {
  const f = fixture(t); f.host.running = [f.identity]; f.host.uiAvailable = true; f.receipt.uiState = "unsupported";
  const result = await runDesktopShortcut({ ...f.options, checkOnly: true });
  assert.equal(result.backendState, "ready"); assert.equal(result.uiReason, "reload-required");
  assert.equal(result.launchPerformed, false); assert.deepEqual(f.calls, ["check"]);
});
test("an app opened during preparation is never quit or retried by the shortcut", async t => {
  const f = fixture(t);
  await assert.rejects(runDesktopShortcut({ ...f.options, launch: async ({ selection }) => {
    f.calls.push(selection.prepareOnly ? "prepare" : "activate");
    if (selection.activate) throw new Error("ChatGPT is still running");
  } }), /still running/);
  assert.deepEqual(f.calls, ["prepare", "activate"]);
});
test("a cold shortcut waits for obsolete gateway code to retire without restarting an active app", async t => {
  const f = fixture(t); let attempts = 0;
  const options = { ...f.options, delay: async () => { f.calls.push("wait"); }, launch: async ({ selection }) => {
    f.calls.push(selection.prepareOnly ? "prepare" : "activate");
    if (selection.prepareOnly && attempts++ === 0) throw Object.assign(new Error("old runtime"), { code: "GATEWAY_RUNTIME_RETIRING" });
    return { pid: 123, activationVerified: false };
  } };
  assert.equal((await runDesktopShortcut(options)).action, "started");
  assert.deepEqual(f.calls, ["prepare", "wait", "prepare", "activate"]);
  attempts = 0; f.calls.length = 0;
  await assert.rejects(runDesktopShortcut({ ...options, delay: async () => { f.host.running = [f.identity]; } }), /等待期间启动/);
  assert.deepEqual(f.calls, ["prepare"]);
});

test("a cold shortcut requests idle gateway retirement before retrying preparation", async t => {
  const f = fixture(t); let attempts = 0;
  const result = await runDesktopShortcut({ ...f.options,
    backendFactory: () => ({ retireIdle: async () => { f.calls.push("retire-idle"); return true; } }),
    delay: async () => { f.calls.push("wait"); },
    launch: async ({ selection }) => {
      f.calls.push(selection.prepareOnly ? "prepare" : "activate");
      if (selection.prepareOnly && attempts++ === 0) throw Object.assign(new Error("old runtime"), { code: "GATEWAY_RUNTIME_RETIRING" });
      return { pid: 123, activationVerified: false };
    } });
  assert.equal(result.action, "started");
  assert.deepEqual(f.calls, ["prepare", "retire-idle", "wait", "prepare", "activate"]);
});

test("an incompatible native protocol launches the signed stock app without the broken gateway", async t => {
  const f=fixture(t);
  const fallbackLaunch=async options=>{assert.equal(options.application,f.host.application);assert.equal(options.home,f.selection.home);
    f.calls.push("protected-fallback");return {pid:123,action:"started",launchPerformed:true,enhancementAvailable:false};};
  const result=await runDesktopShortcut({...f.options,fallbackLaunch,queueRepair:async()=>({action:"queued"}),inspectHost:()=>{throw Object.assign(new Error("native protocol changed"),{code:"HOST_PROTOCOL_MISMATCH"});}});
  assert.equal(result.action,"started");assert.equal(result.launchPerformed,true);
  assert.equal(result.repairSession.action,"queued");
  assert.match(result.message,/native protocol changed/);
  assert.deepEqual(f.calls,["protected-fallback"]);
});

test("an unavailable configured backend opens the stock app and preserves the failure for repair", async t => {
  const f=fixture(t);
  const result=await runDesktopShortcut({...f.options,
    launch:async()=>{f.calls.push("prepare");throw new Error("configured SDK moved during update");},
    queueRepair:async()=>({action:"queued"}),
    fallbackLaunch:async options=>{assert.equal(options.application,f.host.application);f.calls.push("protected-fallback");
      return {pid:123,action:"started",launchPerformed:true,enhancementAvailable:false};}});
  assert.equal(result.action,"started");assert.equal(result.launchPerformed,true);
  assert.match(result.message,/configured SDK moved/);assert.deepEqual(f.calls,["prepare","protected-fallback"]);
});

test("repair task creation failure cannot block stock ChatGPT fallback", async t => {
  const f = fixture(t);
  const result = await runDesktopShortcut({ ...f.options,
    inspectHost: () => { throw Object.assign(new Error("provider protocol changed"), { code: "HOST_PROTOCOL_MISMATCH" }); },
    fallbackLaunch: async () => ({ application: f.host.application, action: "started", pid: 123, launchPerformed: true }),
    queueRepair: async () => { throw new Error("repair CLI unavailable"); } });
  assert.equal(result.action, "started"); assert.equal(result.pid, 123);
  assert.equal(result.repairSession.action, "unavailable");
});
