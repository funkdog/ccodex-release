import assert from "node:assert/strict";
import test from "node:test";
import { createCliSelectorServices, openCurrentHostThread, buildCliSelectorPatch } from "../bridge/desktop-cli-selector.mjs";

test("selector only lists actual CLI models and creates explicit blank CLI threads, never native config or turns", async () => {
  const calls = [];
  const services = createCliSelectorServices(async (method, params) => {
    calls.push({ method, params });
    return method === "model/list" ? { data: [{ model: "copilot/from-account", displayName: "Copilot model" }], nextCursor: null }
      : { thread: { id: "new-id" }, model: params.model, cwd: params.cwd };
  });
  assert.deepEqual(await services.listModels(), [{ id: "copilot/from-account", engine: "copilot", label: "Copilot model" }]);
  assert.equal((await services.createThread({ model: "copilot/from-account", cwd: "/tmp/project" })).id, "new-id");
  assert.deepEqual(calls.map(call => call.method), ["model/list", "thread/start"]);
  assert.equal(calls[1].params.model, "copilot/from-account");
  await assert.rejects(services.createThread({ model: "native", cwd: "relative" }));
  assert.equal(calls.length, 2);
});
test("opening selectors shares the warm catalog; only explicit refresh rediscovers engines", async () => {
  const calls = [];
  const services = createCliSelectorServices(async method => {
    calls.push(method);
    return method === "model/list"
      ? { data: [{ model: "copilot/current" }], nextCursor: null, warnings: ["other: unavailable"] }
      : { warnings: ["other: unavailable"] };
  });
  for (let n = 0; n < 2; n++) {
    const models = await services.listModels();
    assert.equal(models[0].catalogWarning, "other: unavailable");
  }
  assert.deepEqual(calls, ["model/list", "model/list"]);
  assert.equal((await services.refreshModels())[0].id, "copilot/current");
  assert.deepEqual(calls, ["model/list", "model/list", "gateway/models/refresh", "model/list"]);
});
test("model switching uses a dedicated settings request without overwriting effort or approval", async () => {
  const calls = [], threadId = "11111111-1111-1111-1111-111111111111";
  const services = createCliSelectorServices(async (method, params) => {
    calls.push({ method, params });
    return method === "model/list" ? { data: [{ model: "copilot/second", canSwitchModel: true }], nextCursor: null }
      : { thread: { id: threadId, model: "copilot/second", reasoningEffort: "high", cliApprovalMode: "auto" } };
  });
  assert.equal((await services.listModels())[0].canSwitchModel, true);
  const saved = await services.updateSettings({ threadId, model: "mycodex/copilot/second" });
  assert.equal(saved.cliApprovalMode, "auto"); assert.equal(saved.reasoningEffort, "high");
  assert.deepEqual(calls[1], { method: "thread/settings/update", params: { threadId, model: "copilot/second" } });
});

test("draft approval choices save through the gateway and model discovery returns inherited defaults", async () => {
  const calls = [];
  const services = createCliSelectorServices(async (method, params) => {
    calls.push({ method, params });
    return method === "model/list" ? { data: [{ model: "copilot/sol", defaultCliApprovalMode: "auto" }], nextCursor: null }
      : { cliApprovalMode: params.cliApprovalMode };
  });
  assert.equal((await services.listModels())[0].defaultCliApprovalMode, "auto");
  assert.deepEqual(await services.setApprovalDefault({ model: "mycodex/copilot/sol", cliApprovalMode: "ask" }), { cliApprovalMode: "ask" });
  assert.deepEqual(calls[1], { method: "gateway/approval/default/set", params: { model: "copilot/sol", cliApprovalMode: "ask" } });
});
test("creation is never automatically retried after an uncertain failure", async () => {
  let calls = 0, release;
  const services = createCliSelectorServices(async () => { calls++; await new Promise(resolve => { release = resolve; }); throw new Error("connection lost"); });
  const first = services.createThread({ model: "copilot/model", cwd: "/tmp" });
  await assert.rejects(services.createThread({ model: "copilot/model", cwd: "/tmp" }), /already/);
  release(); await assert.rejects(first, /connection lost/); assert.equal(calls, 1);
});
test("recent CLI threads expose durable identities, titles and workspaces without model calls", async () => {
  const calls = [];
  const services = createCliSelectorServices(async (method, params) => {
    calls.push({ method, params });
    return { data: [{ id: "existing", name: null, preview: "", model: "copilot/example", cwd: "/tmp/work", updatedAt: 123 }], nextCursor: "next" };
  });
  assert.deepEqual(await services.listThreads(), { data: [{ id: "existing", title: "CLI · copilot/example", model: "copilot/example", cwd: "/tmp/work", updatedAt: 123 }], nextCursor: "next" });
  await services.listThreads({ cursor: "next" });
  assert.deepEqual(calls.map(call => call.method), ["thread/list", "thread/list"]);
  assert.equal(calls[1].params.cursor, "next");
});
test("navigation is version-pinned, uses the observed route message, and checks acknowledgement", async () => {
  const id = "00000000-0000-0000-0000-000000000001", messages = [];
  const window = { electronBridge: { getSentryInitOptions: () => ({ appVersion: "26.1023.50603" }) },
    MessageEvent, location: { pathname: "/" }, setTimeout: callback => callback(),
    dispatchEvent: event => { messages.push(event.data); window.location.pathname = event.data.path; } };
  await openCurrentHostThread(id, window);
  assert.deepEqual(messages, [{ type: "navigate-to-route", path: `/local/${id}` }]);
  await assert.rejects(openCurrentHostThread("../escape", window), /identity/);
  window.electronBridge.getSentryInitOptions = () => ({ appVersion: "next" });
  await assert.rejects(openCurrentHostThread(id, window), /version/); assert.equal(messages.length, 1);
  window.electronBridge.getSentryInitOptions = () => ({ appVersion: "26.1023.51421" });
  await openCurrentHostThread(id, window); assert.equal(messages.length, 2);
});
test("generated selector script is valid JavaScript and contains no backend connection credentials", () => {
  const script = buildCliSelectorPatch("testBinding", "testResponse");
  assert.doesNotThrow(() => new Function(script));
  assert.equal(/CCODEX_GATEWAY_CONNECTION|config\/write|authToken/.test(script), false);
});
