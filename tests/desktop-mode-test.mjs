import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDesktopMode, bindDesktopMode } from "../bridge/desktop-mode.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-mode-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "config.json");
  const config = { configVersion: 1, defaultInstance: "agents", instances: [
    { id: "legacy", mode: "provider-bridge" },
    { id: "agents", mode: "app-server-gateway", host: "isolated", gateway: { defaultEngine: "claude-main",
      engines: [{ id: "claude-main", adapter: "claude-code" }] } },
  ] };
  return { root, file, config, write: () => fs.writeFileSync(file, JSON.stringify(config)),
    resolve: (options = {}) => resolveDesktopMode({ defaultConfig: file, inherited: {}, legacyHome: path.join(root, "old"), ...options }) };
}
test("missing optional configuration preserves legacy home and consumes inspect flag", t => {
  const f = fixture(t);
  const selected = f.resolve({ arguments: ["--inspect-only", "workspace"] });
  assert.equal(selected.mode, "provider-bridge");
  assert.equal(selected.home, path.join(f.root, "old"));
  assert.deepEqual(selected.arguments, ["workspace"]);
  assert.equal(selected.inspectOnly, true);
  assert.equal(fs.existsSync(selected.home), false);
  assert.throws(() => f.resolve({ arguments: ["--instance", "agents"] }), /not found/);
});

test("Claude API mode accepts an explicit private profile and rejects original Claude state or embedded keys", t => {
  const f = fixture(t), engine = f.config.instances[1].gateway.engines[0];
  engine.cliHome = path.join(f.root, "claude-api"); f.write();
  assert.equal(f.resolve().gateway.engines[0].cliHome, engine.cliHome);
  engine.apiKey = "fixture-key";f.write();assert.throws(() => f.resolve(), /fields/);delete engine.apiKey;
  engine.cliHome = path.join(os.homedir(), ".claude");f.write();assert.throws(() => f.resolve(), /original Claude profile/);
});
test("named modes have isolated profiles, deterministic selected generations and no fallback", t => {
  const f = fixture(t); f.write();
  const gateway = f.resolve({ arguments: ["--instance=agents"] });
  assert.equal(gateway.home, path.join(f.root, "instances", "agents"));
  const before = gateway.generation;
  f.config.instances[0].desktopApp = "/different/legacy.app"; f.write();
  assert.equal(f.resolve().generation, before);
  assert.equal(f.resolve({ arguments: ["--instance", "legacy"] }).mode, "provider-bridge");
  assert.throws(() => f.resolve({ arguments: ["--instance", "missing"] }), /Unknown/);
  assert.throws(() => f.resolve({ arguments: ["--instance", "agents", "--instance=legacy"] }), /Duplicate/);
  f.config.instances[1].gateway.defaultEngine = "missing"; f.write();
  assert.throws(() => f.resolve(), /defaultEngine/);
});
test("bad fields, duplicate IDs and overlapping or linked profiles fail before profile writes", t => {
  const f = fixture(t);
  f.config.instances[1].gateway.engines[0].adapter = "shell"; f.write();
  assert.throws(() => f.resolve(), /adapter/);
  f.config.instances[1].gateway.engines[0].adapter = "claude-code";
  f.config.instances[1].id = undefined; f.write();
  assert.throws(() => f.resolve(), /instance ID/);
  f.config.instances[1].id = "agents";
  f.config.instances[0].profile = path.join(f.root, "shared");
  f.config.instances[1].profile = path.join(f.root, "shared", "nested"); f.write();
  assert.throws(() => f.resolve(), /disjoint/);
  assert.equal(fs.existsSync(path.join(f.root, "shared")), false);
});
test("a profile cannot silently switch mode or import provider configuration", t => {
  const f = fixture(t); f.write();
  const selected = f.resolve();
  fs.mkdirSync(selected.home, { recursive: true });
  fs.writeFileSync(path.join(selected.home, "config.toml"), "old provider");
  assert.throws(() => bindDesktopMode(selected), /fresh profile/);
  fs.unlinkSync(path.join(selected.home, "config.toml"));
  bindDesktopMode(selected);
  bindDesktopMode(selected);
  assert.throws(() => bindDesktopMode({ ...selected, mode: "provider-bridge" }), /another instance or mode/);
});
test("current-host provider is explicit, loopback-only and separate from CLI engine settings", t => {
  const f = fixture(t);
  f.config.instances[1].host = "current";
  f.config.instances[1].desktopApp = "/Applications/ChatGPT.app";
  f.config.instances[1].gateway.engines.push({ id: "codex-copilot", adapter: "codex-copilot",
    bridgeHome: path.join(f.root, "provider"), bridgePort: 22690 });
  f.write();
  const original = f.resolve().generation;
  assert.equal(f.resolve().gateway.engines[1].adapter, "codex-copilot");
  f.config.instances[1].gateway.engines[1].bridgePort = 22691; f.write();
  assert.notEqual(f.resolve().generation, original);
  f.config.instances[1].gateway.engines[1].bridgePort = "22691"; f.write();
  assert.throws(() => f.resolve(), /bridge port/);
  f.config.instances[1].gateway.engines[1].bridgePort = 22691;
  f.config.instances[1].gateway.engines[1].bridgeHome = path.join(os.homedir(), ".codex", "provider"); f.write();
  assert.throws(() => f.resolve(), /original Codex profile/);
  f.config.instances[1].gateway.engines[1].bridgeHome = path.join(f.root, "provider");
  f.config.instances[1].gateway.engines[1].id = "custom"; f.write();
  assert.throws(() => f.resolve(), /reserved engine ID/);
});

test("Google CLI and native provider share only an explicit private account home and preserve existing engines", t => {
  const f = fixture(t), selected = f.config.instances[1];
  selected.host = "current"; selected.desktopApp = "/Applications/ChatGPT.app";
  const cliHome = path.join(f.root, "google-account");
  const cli = { id: "gemini", adapter: "gemini-cli", cliHome, executable: "/private/gemini.js" };
  const native = { id: "codex-gemini", adapter: "codex-gemini", cliHome, sdkPath: "/private/core/index.js", bridgePort: 22691 };
  selected.gateway.engines.push(cli, native); f.write();
  assert.equal(f.resolve().gateway.defaultEngine, "claude-main");
  assert.equal(f.resolve().gateway.engines.length, 3);
  assert.equal(fs.existsSync(cliHome), false);
  cli.id = "codex-gemini"; f.write(); assert.throws(() => f.resolve(), /Google|duplicate/); cli.id = "gemini";
  native.executable = "/private/gemini.js"; f.write(); assert.throws(() => f.resolve(), /Google/); delete native.executable;
  native.cliHome = path.join(os.homedir(), ".codex", "google"); f.write(); assert.throws(() => f.resolve(), /original Codex profile/);
});

test("Antigravity subscription configuration is independent of native Google and requires a matching explicit harness", t => {
  const f = fixture(t), selected = f.config.instances[1];
  const agent = { id: "antigravity", adapter: "antigravity-acp", cliHome: path.join(f.root, "google-account"),
    executable: "/private/runtime/agy_acp_server.par", harnessPath: "/private/runtime/localharness_external" };
  selected.gateway.engines.push(agent); f.write();
  assert.equal(f.resolve().gateway.engines.at(-1).adapter, "antigravity-acp");
  assert.equal(fs.existsSync(agent.cliHome), false);
  agent.sdkPath = "/private/sdk"; f.write(); assert.throws(() => f.resolve(), /Antigravity/); delete agent.sdkPath;
  delete agent.harnessPath; f.write(); assert.throws(() => f.resolve(), /harnessPath/);
});
