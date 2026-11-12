import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createUiHealthPublisher, resolveUiHealth } from "../bridge/desktop-ui-health.mjs";
import { presentDesktopStatus, createStatusNotifier, confirmPendingGateway } from "../bridge/desktop-status.mjs";
import { startGateway } from "../gateway/server.mjs";
import { randomUUID } from "node:crypto";

test("the native shell's exact status CLI arguments produce bounded JSON even when inspection is unavailable", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mycodex-status-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "config.json");
  fs.writeFileSync(file, JSON.stringify({ configVersion: 1, defaultInstance: "fixture", instances: [{ id: "fixture",
    host: "current", mode: "app-server-gateway", desktopApp: path.join(root, "Absent.app"),
    gateway: { defaultEngine: "copilot", engines: [{ id: "copilot", adapter: "github-copilot" }] } }] }));
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../bridge/desktop-status.mjs"), "--config", file, "--once"],
    { encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.schemaVersion, 1); assert.equal(status.level, "warning"); assert.equal(status.notice, "degraded");
  assert.equal(status.appPid, null); assert.equal(fs.existsSync(path.join(root, "Absent.app")), false);
});

test("fresh health, pending initialization, timeouts and recovery are distinct from process liveness", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mycodex-status-")); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { pid: 123, platform: "darwin", executable: "/official/ChatGPT", lifetime: "app" };
  const helper = { pid: 456, platform: "darwin", executable: process.execPath, lifetime: "helper" };
  const receipt = { sourceGeneration: "source", identity: app, helperIdentity: helper };
  const file = path.join(root, "current-host-launch.json"), healthFile = path.join(root, "current-host-ui-status.json");
  fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
  const publish = createUiHealthPublisher(file, receipt, helper), read = () => JSON.parse(fs.readFileSync(healthFile));
  publish("pending"); const pending = read();
  assert.equal(resolveUiHealth(receipt, pending).uiState, "starting");
  assert.equal(resolveUiHealth(receipt, { ...pending, since: new Date(Date.now() - 90000).toISOString() }).uiReason, "initialization-timeout");
  publish("retrying"); assert.equal(resolveUiHealth(receipt, read()).uiState, "unavailable");
  publish("ready"); const ready = read();
  assert.equal(resolveUiHealth(receipt, ready).uiState, "ready");
  assert.equal(fs.statSync(healthFile).mode & 0o077, 0);
  assert.equal(resolveUiHealth(receipt, ready, Date.now() + 90000).uiReason, "stale");
  assert.equal(resolveUiHealth(receipt, { ...ready, updatedAt: "invalid" }).uiReason, "stale");
  assert.notEqual(resolveUiHealth(receipt, { ...ready, helper: { ...helper, lifetime: "old" } }).uiState, "ready");
  fs.writeFileSync(file, JSON.stringify({ ...receipt, identity: { ...app, lifetime: "new" } }));
  publish("unavailable"); assert.deepEqual(read(), ready, "A retired helper cannot overwrite the replacement lifetime's status");
  fs.unlinkSync(healthFile); fs.symlinkSync(file, healthFile);
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.throws(() => publish("ready"), /Invalid UI health/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), receipt);
});

test("degraded backend and page state are surfaced separately without claiming model availability", () => {
  const page = presentDesktopStatus({ action: "activate-existing", backendState: "ready", uiState: "unsupported", uiReason: "contract", pid: 123 });
  assert.equal(page.level, "warning"); assert.equal(page.features[0].state, "ready");
  assert.equal(page.features[1].state, "unavailable"); assert.match(page.summary, /后端路由保留/);
  assert.match(page.features[0].detail, /额度、登录/);
  const pageRepair = presentDesktopStatus({ action: "activate-existing", backendState: "ready",
    uiState: "unsupported", uiReason: "contract", repairSession: { action: "created", mode: "read-only-diagnosis" } });
  assert.match(pageRepair.steps, /页面版本适配会话已创建/);
  const backend = presentDesktopStatus({ action: "needs-attention" });
  assert.equal(backend.features[0].state, "unavailable"); assert.match(backend.summary, /没有自动重启/);
  const healthy = presentDesktopStatus({ action: "activate-existing", backendState: "ready", uiState: "ready" });
  assert.equal(healthy.level, "ok");
  const stopped = presentDesktopStatus({ action: "ready-to-start" });
  assert.equal(stopped.level, "info");
  assert.equal(stopped.launchAvailable, true, "The stopped panel must offer a launch action");
  assert.equal(presentDesktopStatus({ action: "needs-quit" }).launchAvailable, undefined);
  const repairing = presentDesktopStatus({ action: "activate-existing", backendState: "unavailable",
    repairSession: { action: "launching", mode: "read-only-diagnosis" } });
  assert.match(repairing.steps, /正在创建修复会话/);
  const created = presentDesktopStatus({ action: "activate-existing", backendState: "unavailable",
    repairSession: { action: "created", mode: "read-only-diagnosis" } });
  assert.match(created.steps, /只读修复诊断/);
  const failed = presentDesktopStatus({ action: "activate-existing", backendState: "unavailable",
    repairSession: { action: "failed", mode: "read-only-diagnosis" } });
  assert.match(failed.steps, /创建失败/);
});

test("one visible notice per incident, one recovery notice through initialization, then fresh relapse", () => {
  let now = 0;
  const notice = createStatusNotifier({ now: () => now });
  const make = uiState => presentDesktopStatus({ action: "activate-existing", backendState: "ready", uiState });
  const ready = make("ready"), bad = make("unavailable"), pending = make("starting");
  assert.equal(notice(ready), null, "Healthy startup is quiet");
  assert.equal(notice(bad), "degraded"); assert.equal(notice(bad), null);
  assert.equal(notice(pending), null);
  assert.equal(notice(ready), null, "Transient healthy polls are not recovery");
  now += 30000;
  assert.equal(notice(ready), "recovered"); assert.equal(notice(ready), null);
  assert.equal(notice(bad), "degraded");
  assert.equal(notice({ ...bad, incident: "new-failure" }), null, "Changing the error detail is still the same unresolved page issue");
});

test("unknown or waiting page health never requests a fault popup or claims healthy", () => {
  for (const uiReason of ["unreported", "stale", "invalid-report", "pending", "retrying", "initialization-timeout"]) {
    const status = presentDesktopStatus({ action: "activate-existing", backendState: "ready",
      uiState: uiReason === "pending" ? "starting" : "unavailable", uiReason });
    assert.equal(status.level, "info", uiReason);
    assert.equal(status.features[0].state, "ready"); assert.equal(status.features[1].state, "checking");
    assert.equal(createStatusNotifier()(status), null, uiReason);
    assert.doesNotMatch(status.title, /需.*关注/);
    assert.match(status.steps, /无需现在重启/);
  }
});
test("a verified adapter awaiting normal reopen is informational and never claims the page is already ready", () => {
  const status = presentDesktopStatus({ action: "activate-existing", backendState: "ready", uiState: "unsupported", uiReason: "reload-required" });
  assert.equal(status.level, "info"); assert.equal(status.features[0].state, "ready");
  assert.equal(status.features[1].state, "checking"); assert.equal(status.features[1].stateLabel, "待加载");
  assert.match(status.title, /待加载/); assert.match(status.steps, /任务结束后正常退出/);
  assert.doesNotMatch(status.features[1].detail, /尚未适配/); assert.equal(createStatusNotifier()(status), null);
});

test("one unresolved feature warning survives cause changes and short healthy flaps", () => {
  let now = 0;
  const notice = createStatusNotifier({ now: () => now });
  const status = uiReason => presentDesktopStatus({ action: "activate-existing", backendState: "ready", uiState: "unavailable", uiReason });
  assert.equal(notice(status("helper-exited")), "degraded");
  assert.equal(notice(status("unavailable")), null);
  const ready = presentDesktopStatus({ action: "activate-existing", backendState: "ready", uiState: "ready" });
  assert.equal(notice(ready), null); now = 20000;
  assert.equal(notice(status("helper-exited")), null, "A brief recovery does not re-arm the same popup");
  assert.equal(notice(ready), null); now = 50000;
  assert.equal(notice(ready), "recovered");
  assert.equal(notice(status("helper-exited")), "degraded", "A genuinely recovered feature may report a new incident");
});

test("new source is informational while the running gateway is authenticated; failed connectivity is not hidden", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mycodex-pending-update-"));
  const token = randomUUID(), config = { home: root, endpoint: path.join(root, "s"), token, generation: "owned-update-fixture" };
  const gateway = await startGateway({ ...config, engines: new Map() });
  t.after(async () => { await gateway.close(); fs.rmSync(root, { force: true, recursive: true }); });
  const file = path.join(root, "connection.json"); fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const result = { action: "needs-attention", backendReason: "update-pending" };
  const confirmed = await confirmPendingGateway(result, file);
  assert.equal(confirmed.backendState, "ready");
  const status = presentDesktopStatus(confirmed);
  assert.equal(status.level, "info"); assert.equal(status.features[0].state, "ready");
  assert.equal(createStatusNotifier()(status), null); assert.match(status.title, /更新待加载/);
  assert.match(status.steps, /无需现在重启/);
  await gateway.close();
  await assert.rejects(confirmPendingGateway(result, file));
  assert.notEqual(presentDesktopStatus(result).features[0].state, "ready", "Source drift without a connection check cannot claim readiness");
});

test("native attention survives monitor/launcher replacement and only re-arms after stable per-feature recovery", t => {
  if (process.platform !== "darwin") return t.skip("Native macOS attention policy");
  assert.equal(process.env.CODEX_COPILOT_HEAVY_LOCK_HELD, "1", "Compile native acceptance through the heavy-task wrapper");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mycodex-attention-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../bridge/desktop-launcher-macos.swift"), "utf8");
  const declarations = source.slice(source.indexOf("struct StatusFeature:"), source.indexOf("// END STATUS ATTENTION"));
  const harness = `import Foundation\n${declarations}\n
var persisted = Set<String>()
func policy() -> StatusAttention { StatusAttention(read: { persisted }, write: { persisted = $0 }) }
func status(_ level: String, _ page: String, _ backend: String = "ready") -> StatusSnapshot {
    StatusSnapshot(schemaVersion: 1, level: level, title: "fixture", summary: "fixture", features: [
        StatusFeature(id: "backend", label: "backend", state: backend, detail: "fixture"),
        StatusFeature(id: "page", label: "page", state: page, detail: "fixture")
    ], steps: "fixture", incident: UUID().uuidString, appPid: nil, observedAt: "fixture", notice: nil)
}
let first = policy()
precondition(!first.update(status("info", "checking"), now: 0).popup)
precondition(first.update(status("warning", "unavailable"), now: 1).popup)
precondition(persisted == ["page"])
precondition(!first.update(status("warning", "unavailable"), now: 2).popup)
let replacement = policy()
precondition(!replacement.update(status("warning", "unavailable"), now: 3).popup)
precondition(!replacement.update(status("ok", "ready"), now: 4).recovered)
precondition(!replacement.update(status("warning", "unavailable"), now: 20).popup)
precondition(!replacement.update(status("ok", "ready"), now: 21).recovered)
precondition(replacement.update(status("ok", "ready"), now: 51).recovered)
precondition(persisted.isEmpty)
precondition(replacement.update(status("warning", "unavailable"), now: 52).popup)
precondition(replacement.update(status("warning", "checking", "unavailable"), now: 53).popup)
precondition(!replacement.update(status("info", "checking"), now: 54).recovered)
precondition(replacement.update(status("info", "checking"), now: 84).recovered)
precondition(persisted == ["page"], "Backend recovery must not clear an unresolved page acknowledgement")
print("native attention passed")
`;
  const file = path.join(root, "attention.swift"), executable = path.join(root, "attention");
  fs.writeFileSync(file, harness);
  const compile = spawnSync("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", file, "-o", executable], { encoding: "utf8", timeout: 30000 });
  assert.equal(compile.status, 0, compile.stderr);
  const run = spawnSync(executable, [], { encoding: "utf8", timeout: 5000 });
  assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /native attention passed/);
});
