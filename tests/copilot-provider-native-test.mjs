import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { buildCatalog } from "../bridge/catalog.mjs";
import { createResponsesWriter } from "../bridge/translate.mjs";
import { startNativePeer } from "../gateway/native-peer.mjs";
import { AppServerRouter } from "../gateway/router.mjs";
import { copilotProviderArguments } from "../gateway/copilot-provider.mjs";

const executable = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
test("pinned native Codex executes vision and reasoning through the provider and resumes its own history", {
  skip: process.platform !== "darwin" || !fs.existsSync(executable), timeout: 60000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-provider-native-"));
  const profile = path.join(root, "profile"), bridgeHome = path.join(root, "bridge"), workspace = path.join(root, "workspace");
  for (const dir of [profile, bridgeHome, workspace]) fs.mkdirSync(dir);
  const original = 'model = "gpt-native-default"\ncli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[analytics]\nenabled = false\n';
  fs.writeFileSync(path.join(profile, "config.toml"), original);
  const fixtureModel = { id: "gpt-provider-fixture", name: "Fixture", vendor: "OpenAI",
    model_picker_enabled: true, supported_endpoints: ["/responses"], capabilities: { type: "chat",
      supports: { vision: true, reasoning_effort: ["low", "xhigh"] }, limits: { max_prompt_tokens: 32000, max_output_tokens: 1024 } } };
  const catalog = buildCatalog([fixtureModel, { ...fixtureModel, id: "gpt-provider-second", name: "Second fixture" }]);
  fs.writeFileSync(path.join(bridgeHome, "models.json"), JSON.stringify(catalog));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && ["/health", "/catalog"].includes(req.url)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/health" ? { bridge: "codex-copilot", status: "ok" } : catalog)); return;
    }
    if (req.method !== "POST" || req.url !== "/responses") { res.writeHead(404); res.end(); return; }
    const bytes = []; for await (const chunk of req) bytes.push(chunk);
    const body = JSON.parse(Buffer.concat(bytes)); requests.push(body);
    const writer = createResponsesWriter(res, body, new Map());
    writer.pushChunk({ choices: [{ delta: { content: "NATIVE_PROVIDER_OK" } }] }); writer.finish();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { bridgeHome, bridgePort: server.address().port };
  const env = { HOME: root, CODEX_HOME: profile, PATH: process.env.PATH };
  const log = fs.openSync(path.join(root, "stderr.log"), "w");
  let router;
  t.after(async () => { await router?.close(); await new Promise(resolve => server.close(resolve)); fs.closeSync(log); fs.rmSync(root, { recursive: true, force: true }); });
  let sequence = 0, peer;
  const replies = new Map(), turns = new Map(), settings = [];
  async function connect() {
    peer = await startNativePeer({ executable, args: ["app-server", ...copilotProviderArguments(config)], env, cwd: workspace, stderr: log });
    router = new AppServerRouter({ native: peer, copilotProvider: config, cursorSecret: "fixture-not-secret",
      connectProvider: id => { assert.equal(id, "mycodex-copilot"); return startNativePeer({ executable,
        args: ["app-server", ...copilotProviderArguments(config), "-c", "model_provider=mycodex-copilot",
          "-c", `model_catalog_json=${JSON.stringify(path.join(bridgeHome, "models.json"))}`],
        env, cwd: workspace, stderr: log }); },
      ownsThread: () => false, connectGateway() { assert.fail("Native bridge must not execute a Copilot CLI agent"); },
      send: message => { if (!message.method) replies.set(message.id, message); else if (message.method === "turn/completed") turns.set(message.params.turn.id, message.params.turn);
        else if (message.method === "thread/settings/updated") settings.push(message.params.threadSettings); } });
    await request("initialize", { clientInfo: { name: "native_provider_test", version: "1" }, capabilities: { experimentalApi: true } });
    await router.receive({ method: "initialized" });
  }
  async function request(method, params) {
    const id = ++sequence;
    await router.receive({ id, method, params });
    const response = replies.get(id); replies.delete(id);
    if (response?.error) throw new Error(`${method}: ${response.error.message}`);
    return response.result;
  }
  async function complete(turnId) {
    const deadline = Date.now() + 20000;
    while (!turns.has(turnId) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const turn = turns.get(turnId);
    assert.equal(turn?.status, "completed", JSON.stringify(turn?.error) ?? fs.readFileSync(path.join(root, "stderr.log"), "utf8").slice(-5000));
  }
  await connect();
  // The installed renderer now delegates this operation to a host RPC manager.
  // Exercise its exact native request without installing any renderer hooks.
  const draft = await request("config/batchWrite", { edits: [
    { keyPath: "model", value: "mycodex/codex-copilot/gpt-provider-fixture", mergeStrategy: "upsert" },
    { keyPath: "model_reasoning_effort", value: "xhigh", mergeStrategy: "upsert" },
  ], filePath: null, expectedVersion: null, reloadUserConfig: true });
  assert.equal(draft.status, "okOverridden");
  assert.equal(fs.realpathSync(draft.filePath), fs.realpathSync(path.join(profile, "config.toml")));
  assert.ok(typeof draft.version === "string" && draft.version.length > 0);
  assert.equal(fs.readFileSync(path.join(profile, "config.toml"), "utf8"), original);
  assert.equal(requests.length, 0, "Draft acknowledgement is metadata-only");
  assert.equal((await request("config/read", { includeLayers: false })).config.model, "gpt-native-default");
  const started = await request("thread/start", { cwd: workspace, model: "mycodex/codex-copilot/gpt-provider-fixture",
    approvalPolicy: "never", sandbox: "read-only" });
  assert.equal(started.thread.modelProvider, "mycodex-copilot");
  assert.equal(router.providerThreads.get(started.thread.id)?.model, "gpt-provider-fixture");
  const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";
  const { turn } = await request("turn/start", { threadId: started.thread.id, model: null, effort: "xhigh",
    input: [{ type: "text", text: "Describe this fixture. Do not use tools." }, { type: "image", url: `data:image/png;base64,${png}` }] });
  await complete(turn.id);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "gpt-provider-fixture");
  assert.equal(requests[0].reasoning?.effort, "xhigh");
  assert.ok(requests[0].input.some(item => item.content?.some(part => part.type === "input_image")),
    JSON.stringify(requests[0].input.map(item => ({ type: item.type, content: item.content?.map(part => ({ type: part.type, text: part.text?.slice(0, 100) })) }))));
  const threadId = started.thread.id;
  await request("thread/settings/update", { threadId, model: "mycodex/codex-copilot/gpt-provider-fixture", effort: "low" });
  const second = await request("turn/start", { threadId, input: [{ type: "text", text: "Reply again, without tools." }] });
  await complete(second.turn.id);
  assert.equal(requests[1].reasoning?.effort, "low");
  await router.close(); await connect();
  assert.equal(router.providerThreads.has(threadId), false, "Cold resume must discover provider ownership from the saved thread");
  const resumed = await request("thread/resume", { threadId, model: null });
  assert.equal(resumed.modelProvider, "mycodex-copilot");
  assert.equal(resumed.model, "mycodex/codex-copilot/gpt-provider-fixture");
  assert.ok(resumed.thread.turns.some(value => value.id === turn.id));
  const beforeSettings = settings.length;
  await request("thread/settings/update", { threadId, model: "mycodex/codex-copilot/gpt-provider-second", effort: "low" });
  const settingsDeadline = Date.now() + 3000;
  while (settings.length === beforeSettings && Date.now() < settingsDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(settings.length > beforeSettings, "Native settings changes must be acknowledged by a notification");
  const latest = settings.at(-1);
  assert.equal(latest.model, "mycodex/codex-copilot/gpt-provider-second");
  assert.equal(latest.collaborationMode.settings.model, latest.model);
  const beforeEffort = settings.length;
  await request("thread/settings/update", { threadId, model: latest.model, effort: "xhigh", multiAgentMode: "explicitRequestOnly" });
  const effortDeadline = Date.now() + 3000;
  while (settings.length === beforeEffort && Date.now() < effortDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(settings.length > beforeEffort, "Effort-only changes need the actual native settings acknowledgement");
  const effortSnapshot = settings.at(-1);
  assert.equal(effortSnapshot.model, latest.model);
  assert.equal(effortSnapshot.effort, "xhigh");
  assert.equal(effortSnapshot.collaborationMode.settings.reasoning_effort, "xhigh");
  // Desktop can retain the raw top-level model alongside its qualified mode.
  // Round-trip the actual settings snapshot through the next native turn.
  const third = await request("turn/start", { threadId, model: "gpt-provider-second", collaborationMode: effortSnapshot.collaborationMode,
    input: [{ type: "text", text: "Reply on the explicitly selected second model. Do not use tools." }] });
  await complete(third.turn.id);
  assert.equal(requests[2].model, "gpt-provider-second");
  assert.equal(requests[2].reasoning.effort, "xhigh");
  await router.close(); await connect();
  await request("thread/list", { limit: 100 });
  const restoredSelection = await request("thread/resume", { threadId, model: null });
  assert.equal(restoredSelection.model, "mycodex/codex-copilot/gpt-provider-second");
  assert.equal(restoredSelection.reasoningEffort, "xhigh");
  if (restoredSelection.collaborationMode) assert.equal(restoredSelection.collaborationMode.settings.model, restoredSelection.model);
  // A sidebar fork can follow a cold list without opening/resuming its source.
  await router.close(); await connect();
  await request("thread/list", { limit: 100 });
  const fork = await request("thread/fork", { threadId, lastTurnId: turn.id, excludeTurns: false });
  assert.notEqual(fork.thread.id, threadId);
  assert.equal(fork.thread.forkedFromId, threadId);
  assert.equal(fork.thread.parentThreadId, null, "An ordinary fork is not a spawned subagent");
  assert.equal(fork.modelProvider, "mycodex-copilot");
  assert.equal(fork.model, "mycodex/codex-copilot/gpt-provider-second");
  assert.equal(fork.reasoningEffort, restoredSelection.reasoningEffort, "A provider fork must retain source effort");
  assert.deepEqual(fork.approvalPolicy, restoredSelection.approvalPolicy);
  assert.deepEqual(fork.sandbox, restoredSelection.sandbox);
  const childTurn = await request("turn/start", { threadId: fork.thread.id,
    input: [{ type: "text", text: "BRANCH_ONLY_TEXT. Reply without tools." }] });
  await complete(childTurn.turn.id);
  const childRequest = JSON.stringify(requests.at(-1).input);
  assert.ok(childRequest.includes("Describe this fixture"));
  assert.equal(childRequest.includes("Reply again, without tools"), false, "Native fork must cut at the selected turn");
  await request("thread/name/set", { threadId: fork.thread.id, name: "Fixture independent fork" });
  const pins = "01984de2-8f74-7c91-a3b2-5c5e937cf318";
  await request("thread/section/move", { threadId: fork.thread.id, sectionId: pins });
  let pinned; const pinDeadline = Date.now() + 3000;
  do { pinned = await request("thread/list", { sectionId: pins, modelProviders: [], sortKey: "section_position", useStateDbOnly: true });
    if (pinned.data.some(thread => thread.id === fork.thread.id)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < pinDeadline);
  assert.ok(pinned.data.some(thread => thread.id === fork.thread.id), JSON.stringify({ pinned, read: await request("thread/read", {threadId: fork.thread.id, includeTurns: false}), all: await request("thread/list", {modelProviders:null}) }));
  await request("thread/section/move", { threadId: fork.thread.id, sectionId: null });
  await request("thread/archive", { threadId });
  // This pinned core shares immutable fork history and refuses deleting its
  // source while referenced. Preserve that boundary; never cascade to forks.
  await assert.rejects(request("thread/delete", { threadId }), /forked history still references/);
  await router.close(); await connect();
  const coldFork = await request("thread/resume", { threadId: fork.thread.id, model: null });
  assert.equal(coldFork.modelProvider, "mycodex-copilot");
  assert.equal(coldFork.thread.name, "Fixture independent fork");
  const continued = await request("turn/start", { threadId: fork.thread.id,
    input: [{ type: "text", text: "Continue independent fork, without tools." }] });
  await complete(continued.turn.id);
  assert.ok(JSON.stringify(requests.at(-1).input).includes("BRANCH_ONLY_TEXT"));
  await request("thread/archive", { threadId: fork.thread.id });
  await request("thread/delete", { threadId: fork.thread.id });
  await request("thread/delete", { threadId });
  assert.equal(fs.readFileSync(path.join(profile, "config.toml"), "utf8"), original);
});
