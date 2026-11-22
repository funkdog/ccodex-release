import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readThreadOwnership } from "../gateway/state.mjs";
import { startGateway } from "../gateway/server.mjs";
import { connectGateway, writeMessage } from "../gateway/ipc.mjs";
import { createNativeHostPeer } from "../gateway/native-host-peer.mjs";
import { AppServerRouter } from "../gateway/router.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { startNativePeer } from "../gateway/native-peer.mjs";
import { codexNativeExecution } from "../gateway/engines/codex-native.mjs";
import { copilotProviderArguments } from "../gateway/copilot-provider.mjs";
import { buildCatalog } from "../bridge/catalog.mjs";
import { createResponsesWriter } from "../bridge/translate.mjs";

const executable = process.env.CCODEX_TEST_NATIVE_CORE ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
test("Desktop and real native sessions keep their engines fixed while same-engine models remain switchable", { timeout: 60000, skip: !fs.existsSync(executable) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switch-native-")), workspace = path.join(root, "workspace"), profile = path.join(root, "original"), bridgeHome = path.join(root, "bridge");
  for (const dir of [workspace, profile, bridgeHome]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(profile, "config.toml"), 'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[features]\nplugins = false\napps = false\n', { mode: 0o600 });
  const model = "gpt-handoff-fixture", requests = [], cliPrompts = [], output = [];
  const catalog = buildCatalog([model, "gpt-second-fixture"].map(id => ({ id, name: "Fixture source", vendor: "OpenAI", model_picker_enabled: true, supported_endpoints: ["/responses"],
    capabilities: { type: "chat", supports: {}, limits: { max_prompt_tokens: 128000, max_output_tokens: 2048 } } })));
  fs.writeFileSync(path.join(bridgeHome, "models.json"), JSON.stringify(catalog));
  const server = http.createServer(async (req, res) => {
    const bytes = []; for await (const chunk of req) bytes.push(chunk);
    const body = JSON.parse(Buffer.concat(bytes)); requests.push(body);
    const writer = createResponsesWriter(res, body, new Map()); writer.pushChunk({ choices: [{ delta: { content: requests.length === 1 ? "ORIGINAL_NATIVE_REPLY" : "NEW_NATIVE_REPLY" } }] }); writer.finish();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = { bridgeHome, bridgePort: server.address().port };
  const args = [...copilotProviderArguments(provider), "-c", 'model_provider="mycodex-copilot"', "-c", `model_catalog_json=${JSON.stringify(path.join(bridgeHome, "models.json"))}`];
  const env = { HOME: root, PATH: process.env.PATH };
  const config = { home: path.join(root, "enhancement"), endpoint: path.join(root, "g"), token: randomUUID(), generation: "switch-fixture", spine: { mcp: false, eventTap: false } };
  let router, host;
  const gateway = await startGateway({ ...config, defaultEngine: "cli",
    engines: new Map([["cli", { adapter: "fixture-cli", supportsModelSwitch: true, models: async () => [{ id: "model" }], run: async context => { cliPrompts.push(context.prompt); context.onSession("independent-cli-session"); context.onText("INTERMEDIATE_CLI_REPLY"); } }],
      ["codex-copilot", { adapter: "codex-copilot", nativeProvider: true, models: async () => [{ id: model }],
        ...codexNativeExecution({ executable, home: path.join(root, "new-native"), args, env }) }]]) });
  const protocol = gateway.protocol, directory = path.join(config.home, "gateway", "threads"), sockets = [];
  const ownsThread = id => readThreadOwnership(directory, id);
  const connect = async () => { let socket; const peer = new RpcPeer(message => writeMessage(socket, message));
    socket = await connectGateway(config, message => peer.receive(message)); sockets.push(socket); socket.on("close", () => peer.close());
    peer.dispose = async () => { socket.destroy(); peer.close(); }; return peer; };
  const native = await startNativePeer({ executable, args: ["app-server", ...args], cwd: workspace, env: { ...env, CODEX_HOME: profile }, stderr: "ignore" });
  router = new AppServerRouter({ native, copilotProvider: provider, cursorSecret: "synthetic-native-switch-secret", ownsThread,
    connectGateway: connect, connectProvider: () => startNativePeer({ executable, args: ["app-server", ...args], cwd: workspace, env: { ...env, CODEX_HOME: profile }, stderr: "ignore" }),
    onNativeInitialized: () => { host = createNativeHostPeer(config, native, ownsThread, () => {}, { runExclusive: (id, operation) => router.withNativeThread(id, operation), switchExecution: (id, model) => router.switchExecution(id, model) }); void host.start(); },
    send: message => output.push(message) });
  t.after(async () => { await host?.close(); await router.close(); sockets.forEach(socket => socket.destroy()); await gateway.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  let next = 0;
  const request = async (method, params = {}) => { const id = ++next; await router.receive({ id, method, params }); const reply = output.find(message => message.id === id && !message.method); if (reply.error) throw new Error(reply.error.message); return reply.result; };
  const complete = async turnId => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const result = output.find(message => message.method === "turn/completed" && message.params.turn.id === turnId); if (result) { assert.equal(result.params.turn.status, "completed", JSON.stringify(result)); return; } await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error("Native handoff fixture timed out.");
  };
  await request("initialize", { clientInfo: { name: "switch_native_test", version: "1" }, capabilities: { experimentalApi: true } });
  // Match Desktop: do not send an optional initialized notification.
  const helper = await connect(); await helper.request("initialize", { clientInfo: { name: "ui_helper_fixture", version: "1" } });
  const readyDeadline = Date.now() + 5000; let hostStatus;
  do { hostStatus = await helper.request("diy/host/status", {}); if (hostStatus.bindings.length) break; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < readyDeadline);
  assert.equal(hostStatus.bindings.length, 1);
  const started = await request("thread/start", { model: `mycodex/codex-copilot/${model}`, cwd: workspace, approvalPolicy: "never", sandbox: "workspace-write" });
  const threadId = started.thread.id;
  const originalTurn = await request("turn/start", { threadId, input: [{ type: "text", text: "ORIGINAL_USER_SENTINEL" }] }); await complete(originalTurn.turn.id);
  await assert.rejects(helper.request("gateway/conversation/switch", { threadId, model: "cli/model", frontendPid: process.ppid }), /固定/);
  await assert.rejects(router.switchExecution(threadId, "mycodex/cli/model"), /固定/);
  assert.equal(protocol.store.threads.has(threadId), false);
  await request("thread/settings/update", { threadId, model: "mycodex/codex-copilot/gpt-second-fixture" });
  const settingsDeadline = Date.now() + 3000;
  while (!output.some(m => m.method === "thread/settings/updated" && m.params.threadSettings?.model === "mycodex/codex-copilot/gpt-second-fixture") && Date.now() < settingsDeadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert(output.some(m => m.method === "thread/settings/updated" && m.params.threadSettings?.model === "mycodex/codex-copilot/gpt-second-fixture"));
  const back = await request("turn/start", { threadId, model: "mycodex/codex-copilot/gpt-second-fixture", input: [{ type: "text", text: "CONTINUE_SAME_RUNTIME" }] }); await complete(back.turn.id);
  assert.equal(requests.at(-1).model, "gpt-second-fixture");
  const finalRequest = JSON.stringify(requests.at(-1).input);
  assert.match(finalRequest, /ORIGINAL_NATIVE_REPLY/); assert.match(finalRequest, /CONTINUE_SAME_RUNTIME/);
  const cli = await request("thread/start", { model: "mycodex/cli/model", cwd: workspace });
  assert.notEqual(cli.thread.id, threadId);
  const cliTurn = await request("turn/start", { threadId: cli.thread.id, input: [{ type: "text", text: "INDEPENDENT_CLI" }] }); await complete(cliTurn.turn.id);
  assert.equal(cliPrompts[0], "INDEPENDENT_CLI");
  await assert.rejects(helper.request("gateway/conversation/switch", { threadId: cli.thread.id, model: `codex-copilot/${model}`, frontendPid: process.ppid }), /固定/);
  const read = await request("thread/read", { threadId, includeTurns: true }); assert.equal(read.thread.turns.length, 2); assert.equal(read.thread.id, threadId);
});
