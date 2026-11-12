import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adaptersConfiguration, saveAdaptersConfiguration, diagnoseAdapters, executablePath, verifyAdapterModel } from "../tools/configure-adapters.mjs";
import { resolveDesktopMode } from "../bridge/desktop-mode.mjs";

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adapters-setup-")));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cli = path.join(home, "own cli"); fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const sdk = path.join(home, "sdk.mjs"); fs.writeFileSync(sdk, "export const query = () => {};\n");
  const application = path.join(home, "ChatGPT.app");
  const config = adaptersConfiguration({ application, connections: [{ id: "claude", adapter: "claude-code", executable: cli, sdkPath: sdk }] });
  return { home, cli, sdk, application, config, file: path.join(home, "private", "config.json") };
}

test("onboarding uses the user's own CLI paths and ask policy without recording keys or enabling other features", t => {
  const f = fixture(t);
  const text = JSON.stringify(f.config);
  assert.equal(f.config.instances[0].gateway.workbench, false);
  assert.equal(f.config.instances[0].gateway.spine, undefined);
  assert.equal(f.config.instances[0].gateway.engines[0].initialApprovalMode, "ask");
  assert.equal(f.config.instances[0].gateway.engines[0].cliHome, undefined);
  assert.deepEqual(f.config.instances[0].gateway.engines[0].enabledModels, []);
  assert.doesNotMatch(text, /apiKey|token|squad|radar|knowledge|copilot/);
  saveAdaptersConfiguration(f.file, f.config);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f.file)).mode & 0o777, 0o700);
  assert.equal(resolveDesktopMode({ arguments: ["--config", f.file], inherited: {} }).gateway.workbench, false);
});

test("onboarding preserves existing files, backs up only explicitly replaced owned configuration and rejects links", t => {
  const f = fixture(t);
  saveAdaptersConfiguration(f.file, f.config);
  assert.throws(() => saveAdaptersConfiguration(f.file, f.config), /已有配置/);
  const original = fs.readFileSync(f.file, "utf8");
  f.config.instances[0].gateway.engines[0].enabledModels = ["selected"];
  saveAdaptersConfiguration(f.file, f.config, { replace: true });
  const backups = fs.readdirSync(path.dirname(f.file)).filter(name => name.endsWith(".backup"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(f.file), backups[0]), "utf8"), original);
  fs.symlinkSync(f.file, path.join(path.dirname(f.file), "linked.json"));
  assert.throws(() => saveAdaptersConfiguration(path.join(path.dirname(f.file), "linked.json"), f.config, { replace: true }), /私有普通文件/);
  fs.symlinkSync(path.dirname(f.file), path.join(f.home, "linked"));
  assert.throws(() => saveAdaptersConfiguration(path.join(f.home, "linked", "other.json"), f.config), /符号链接/);
});

test("invalid configuration is rejected before replacing a valid one", t => {
  const f = fixture(t); saveAdaptersConfiguration(f.file, f.config);
  const original = fs.readFileSync(f.file, "utf8");
  f.config.instances[0].gateway.workbench = true;
  assert.throws(() => saveAdaptersConfiguration(f.file, f.config, { replace: true }), /精简配置/);
  assert.equal(fs.readFileSync(f.file, "utf8"), original);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ["config.json"]);
});

test("CLI resolution accepts spaces and rejects shell strings and missing files", t => {
  const f = fixture(t);
  assert.equal(executablePath("own cli", { PATH: f.home }), f.cli);
  assert.equal(executablePath(f.cli), f.cli);
  assert.throws(() => executablePath("claude --model fake", { PATH: f.home }), /找不到/);
  assert.throws(() => executablePath("claude\nanything"), /命令参数/);
  const native = adaptersConfiguration({ application: f.application });
  assert.deepEqual(native.instances[0].gateway, { workbench: false, defaultEngine: null, engines: [] });
  saveAdaptersConfiguration(f.file, native);
  assert.equal(resolveDesktopMode({ arguments: ["--config", f.file], inherited: {} }).gateway.engines.length, 0);
});

test("diagnostics separates candidate metadata and selected models from authentication or inference verification", async t => {
  const f = fixture(t); saveAdaptersConfiguration(f.file, f.config);
  const inspectHost = () => ({ applicationVersion: "fixture", uiAvailable: true });
  let inferences = 0;
  const factory = async () => new Map([["claude", { models: async () => [{ id: "unverified", name: "Unverified" }], run() { inferences++; } }]]);
  const result = await diagnoseAdapters(f.file, { inspectHost, catalog: true, factory });
  assert.equal(result.ready, true);
  assert.deepEqual(result.checks[0].enabledModels, []);
  assert.deepEqual(result.checks[0].candidates.map(m => m.id), ["unverified"]);
  assert.equal(result.checks[0].authenticationVerified, false);
  assert.equal(result.checks[0].inferenceVerified, false);
  assert.equal(result.liveDesktopVerified, false);
  assert.equal(inferences, 0);
  fs.rmSync(f.cli);
  const missing = await diagnoseAdapters(f.file, { inspectHost });
  assert.equal(missing.checks[0].ready, false);
  assert.equal(missing.ready, true, "an unenabled connection must not block native Codex");
  await assert.rejects(diagnoseAdapters(f.file, { inspectHost: () => ({ applicationVersion: "unknown", uiAvailable: false }) }), /兼容性/);
});

function verifier(run) {
  return async () => new Map([["claude", { models: async () => [{ id: "chosen" }, { id: "other" }], run }]]);
}
const echo = async context => context.onText(context.prompt.match(/MYCODEX_CONNECTION_[a-f0-9]+/)[0]);

test("only successful consented inference adds the selected model and a private receipt", async t => {
  const f = fixture(t); saveAdaptersConfiguration(f.file, f.config);
  const original = fs.readFileSync(f.file, "utf8");
  await assert.rejects(verifyAdapterModel(f.file, "claude", "chosen", { factory: verifier(echo) }), /明确同意/);
  await assert.rejects(verifyAdapterModel(f.file, "claude", "chosen", { approved: true, factory: verifier(async () => { throw new Error("401 synthetic-secret"); }) }), e => /认证/.test(e.message) && !e.message.includes("synthetic-secret"));
  assert.equal(fs.readFileSync(f.file, "utf8"), original);
  assert.equal(fs.readdirSync(path.dirname(f.file)).length, 1);
  await verifyAdapterModel(f.file, "claude", "chosen", { approved: true, factory: verifier(echo) });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).instances[0].gateway.engines[0].enabledModels, ["chosen"]);
  const receipt = fs.readdirSync(path.dirname(f.file)).find(name => name.startsWith(".model-check-"));
  assert.equal(fs.statSync(path.join(path.dirname(f.file), receipt)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(f.file), receipt))).modelId, "chosen");
});

test("a connection changed during inference cannot enable a model using the stale check", async t => {
  const f = fixture(t); saveAdaptersConfiguration(f.file, f.config);
  await assert.rejects(verifyAdapterModel(f.file, "claude", "chosen", { approved: true, factory: verifier(async context => {
    fs.appendFileSync(f.file, " "); await echo(context);
  }) }), /配置已变化/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).instances[0].gateway.engines[0].enabledModels, []);
  assert.equal(fs.readdirSync(path.dirname(f.file)).length, 1);
});
