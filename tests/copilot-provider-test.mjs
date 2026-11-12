import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexCopilotCatalog, copilotProviderArguments, copilotProviderConfig } from "../gateway/copilot-provider.mjs";
import { cliInput } from "../gateway/input.mjs";
import { createNativeSessionController } from "../bridge/desktop-native-session.mjs";
import { createCliSelectorServices } from "../bridge/desktop-cli-selector.mjs";

const config = { bridgeHome: "/private/fixture/copilot", bridgePort: 22690 };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=", "base64");
test("native provider overrides are per-thread, point only to loopback and never change native default model", () => {
  const overrides = copilotProviderConfig(config);
  assert.equal(overrides["model_providers.mycodex-copilot"].base_url, "http://127.0.0.1:22690");
  assert.equal(overrides.model_catalog_json, "/private/fixture/copilot/models.json");
  assert.equal(overrides.model_provider, undefined);
  assert.equal(overrides.model, undefined);
  assert.ok(copilotProviderArguments(config).every((arg, index) => index % 2 ? arg.startsWith("model_providers.mycodex-copilot.") : arg === "-c"));
  for (const bad of [{ ...config, bridgeHome: "relative" }, { ...config, bridgePort: 80 }, { ...config, bridgePort: "22690" }])
    assert.throws(() => copilotProviderConfig(bad));
});
test("API bridge catalog exposes real Gemini, vision and efforts independently of CLI catalog", async () => {
  const urls = [];
  const engine = codexCopilotCatalog(config, { fetchImpl: async (url, options) => {
    urls.push(url); assert.equal(options.redirect, "error");
    return { ok: true, json: async () => url.endsWith("/health") ? { bridge: "codex-copilot", status: "ok" }
      : { models: [{ slug: "gemini-from-account", display_name: "Gemini from account", input_modalities: ["text", "image"],
        supported_reasoning_levels: [{ effort: "high" }], default_reasoning_level: "high" }] } };
  } });
  assert.deepEqual(await engine.models(), [{ id: "gemini-from-account", name: "Gemini from account", description: undefined,
    inputModalities: ["text", "image"], supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high" }]);
  assert.deepEqual(urls, ["http://127.0.0.1:22690/health", "http://127.0.0.1:22690/catalog"]);
  await assert.rejects(engine.run(), /native Codex/);
  const offline = codexCopilotCatalog(config, { fetchImpl: async () => ({ ok: true, json: async () => ({ bridge: "codex-copilot", status: "unauthenticated" }) }) });
  await assert.rejects(offline.models(), /尚未登录/);
});
test("CLI image validation snapshots local images and inline blobs, rejecting unsupported inputs before execution", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-image-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "image.png"); fs.writeFileSync(file, png);
  const image = { type: "image", url: `data:image/png;base64,${png.toString("base64")}` };
  const expected = { prompt: "Describe this", attachments: [{ type: "blob", data: png.toString("base64"), mimeType: "image/png" }] };
  assert.deepEqual(cliInput([{ type: "text", text: "Describe this" }, image], { supportsImages: true }), expected);
  assert.deepEqual(cliInput([{ type: "text", text: "Describe this" }, { type: "localImage", path: file }], { supportsImages: true }), expected);
  assert.throws(() => cliInput([image]), /不支持/);
  for (const invalid of [{ type: "image", url: "https://example.com/image.png" },
    { type: "image", url: "data:image/jpeg;base64," + png.toString("base64") }, { type: "localImage", path: home },
    { type: "localImage", path: "relative.png" }, { type: "file", path: file }])
    assert.throws(() => cliInput([invalid], { supportsImages: true }));
});
test("Codex bridge drafts preserve native attachments, collaboration and permission settings", () => {
  const c = createNativeSessionController();
  c.select("mycodex/codex-copilot/gpt-from-account"); c.configure({ reasoningEffort: "xhigh" });
  const intent = c.begin({ clientUserMessageId: "native-draft", mode: "plan", attachments: [{ native: true }],
    input: [{ type: "text", text: "describe" }, { type: "image", url: "data:image/png;base64,fixture" }],
    permissionSelection: { name: "native" } });
  assert.deepEqual(intent.options.permissionSelection, { name: "native" });
  assert.equal(intent.options.collaborationMode.mode, "plan");
  const params = { model: intent.options.collaborationMode.settings.model, sandbox: "workspace-write", approvalPolicy: "on-request" };
  const result = c.outgoing("mcp-request", { hostId: "local", request: { method: "thread/start", params } });
  assert.equal(result.request.params.sandbox, "workspace-write");
  assert.equal(result.request.params.permissions, undefined);
  assert.equal(result.request.params.effort, "xhigh");
  c.observe({ type: "mcp-response", hostId: "local", message: { result: { model: params.model,
    thread: { id: "persisted-native", modelProvider: "mycodex-copilot", nativeCopilot: true } } } });
  const resumed = c.outgoing("mcp-request", { hostId: "local", request: { method: "thread/resume", params: { threadId: "persisted-native", model: "stale-native-default" } } });
  assert.equal(resumed.request.params.model, null);
  const turn = { threadId: "persisted-native", model: "user-selected-native-model", effort: "low", sandbox: "read-only" };
  assert.deepEqual(c.outgoing("mcp-request", { hostId: "local", request: { method: "turn/start", params: turn } }).request.params, turn);
  intent.finish();
});
test("GPT defaults are presented with Codex execution first, while CLI stays explicit and Gemini stays available", async () => {
  const services = createCliSelectorServices(async method => method === "gateway/models/refresh" ? {}
    : { data: [{ model: "copilot/gpt-test" }, { model: "codex-copilot/gemini-real", nativeCopilot: true },
      { model: "codex-copilot/gpt-test", nativeCopilot: true }], nextCursor: null });
  assert.deepEqual((await services.listModels()).map(model => model.id),
    ["codex-copilot/gpt-test", "copilot/gpt-test", "codex-copilot/gemini-real"]);
});
