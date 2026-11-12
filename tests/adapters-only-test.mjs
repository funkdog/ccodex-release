import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startGateway } from "../gateway/server.mjs";
import { resolveDesktopMode } from "../bridge/desktop-mode.mjs";
import { createEngines } from "../gateway/engines/index.mjs";
import { buildNativeSessionsPatch } from "../bridge/desktop-native-composer.mjs";

test("the minimal picker retains native speed and does not expose source/key management or cross-engine handoff RPCs", () => {
  const patch = buildNativeSessionsPatch("isolated-test", "test-response");
  assert.doesNotThrow(() => new Function(patch));
  assert.ok(patch.includes("selectHostSpeed"));
  assert.equal(patch.includes("openModelSources:()=>request"), false);
  assert.equal(patch.includes("switchExecution:params=>request"), false);
});

test("an adapters desktop can use only the user's native Codex configuration without an external engine", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mycodex-native-only-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "config.json");
  fs.writeFileSync(file, JSON.stringify({ configVersion: 1, defaultInstance: "adapters", instances: [{
    id: "adapters", host: "current", mode: "app-server-gateway", desktopApp: path.join(home, "ChatGPT.app"),
    gateway: { workbench: false, defaultEngine: null, engines: [] },
  }] }));
  assert.equal(resolveDesktopMode({ arguments: ["--config", file], inherited: {} }).gateway.engines.length, 0);
  const gateway = await startGateway({ home, endpoint: path.join(home, "s"), token: "isolated-native-token", generation: "test",
    workbench: false, defaultEngine: null, engines: new Map() });
  t.after(() => gateway.close());
  const result = await gateway.protocol.handle("model/list", {}, { initialized: true, send() {} });
  assert.deepEqual(result.data, []);
});

test("a connected CLI exposes only explicitly enabled models and an unselected CLI does no discovery", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mycodex-model-selection-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sdkPath = path.join(home, "sdk.mjs");
  fs.writeFileSync(sdkPath, 'export let discoveries=0; export function query(){ discoveries++;return {close(){},supportedModels:async()=>[{value:"chosen"},{value:"not-enabled"},{value:"unverified"}]};}');
  const config = { id: "claude", adapter: "claude-code", sdkPath };
  const unselected = await createEngines([config], { requireSelection: true });
  assert.deepEqual(await unselected.get("claude").models(), []);
  const missing = await createEngines([{ ...config, sdkPath: path.join(home, "not-installed.mjs") }], { requireSelection: true });
  assert.deepEqual(await missing.get("claude").models(), [], "native startup does not load an unenabled CLI dependency");
  const selected = await createEngines([{ ...config, enabledModels: ["chosen"] }], { requireSelection: true });
  assert.deepEqual((await selected.get("claude").models()).map(model => model.id), ["chosen"]);
  await assert.rejects(selected.get("claude").run({ model: "not-enabled" }), /enabled|启用/);
});

test("adapters-only gateway has no workbench services or persisted workbench data", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mycodex-adapters-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const gateway = await startGateway({ home, endpoint: path.join(home, "gateway.sock"),
    token: "isolated-test-token", generation: "test", workbench: false,
    engines: new Map([["fixture", { displayName: "Fixture", models: async () => [{ id: "fixture-model", name: "Fixture" }], run: async () => {} }]]), defaultEngine: "fixture" });
  t.after(() => gateway.close());
  assert.equal(gateway.spine, undefined);
  assert.equal(gateway.work, undefined);
  assert.equal(gateway.dispatch, undefined);
  assert.equal(fs.existsSync(path.join(home, "spine")), false);
  assert.ok(await gateway.protocol.handle("model/list", {}, { initialized: true, id: "fixture", send() {} }));
});

test("adapters-only configuration rejects an enabled workbench and invalid flags", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mycodex-config-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "config.json");
  const gateway = { defaultEngine: "claude", engines: [{ id: "claude", adapter: "claude-code" }], workbench: false };
  const config = { configVersion: 1, defaultInstance: "adapters", instances: [{ id: "adapters", host: "current", mode: "app-server-gateway", desktopApp: path.join(home, "ChatGPT.app"), gateway }] };
  const resolve = () => { fs.writeFileSync(file, JSON.stringify(config)); return resolveDesktopMode({ arguments: ["--config", file], inherited: {} }); };
  assert.equal(resolve().gateway.workbench, false);
  gateway.spine = { mcp: true };
  assert.throws(resolve, /workbench/i);
  delete gateway.spine;
  gateway.workbench = "false";
  assert.throws(resolve, /workbench/i);
});
