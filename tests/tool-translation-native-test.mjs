import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startNativePeer } from "../gateway/native-peer.mjs";
import { buildCatalog } from "../bridge/catalog.mjs";
import { memoryResponsesBridge } from "./fixtures/responses-bridge.mjs";

const executable = process.env.MYCODEX_TEST_NATIVE_CLI ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
for (const parameterShape of ["simple", "root-union", "open-required"]) test(`installed Codex calls a namespaced UI tool through Chat and consumes its screenshot with parameters=${parameterShape}`, { timeout: 30000, skip: !fs.existsSync(executable) }, async t => {
  const encodedParameters = parameterShape !== "simple";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-ui-tools-"));
  const namespace = "owned_cua_fixture";
  const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";
  const model = { id: "gemini-carbon-fixture", name: "Fixture", vendor: "Google", model_picker_enabled: true,
    supported_endpoints: ["/chat/completions"], capabilities: { type: "chat", supports: { vision: true } } };
  const catalog = path.join(root, "models.json"); fs.writeFileSync(catalog, JSON.stringify(buildCatalog([model])));
  const bridge = await memoryResponsesBridge(async (_req, res, body, count) => {
    const reply = message => {
      res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
      const completion = { choices: [{ [body.stream ? "delta" : "message"]: message }] };
      res.end(body.stream ? `data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n` : JSON.stringify(completion));
    };
    if (count === 1) {
      const tool = body.tools.find(tool => tool.function.description.includes(namespace + ".js")); assert(tool, "The native UI namespace must reach the Chat provider");
      assert.equal(tool.function.parameters.oneOf, undefined);
      assert(tool.function.parameters.required.every(name => Object.hasOwn(tool.function.parameters.properties, name)));
      const argumentsText = encodedParameters ? JSON.stringify({ input: '{"code":"owned_fixture_only"}' }) : '{"code":"owned_fixture_only"}';
      reply({ tool_calls: [{ index: 0, id: "call_synthetic_ui", type: "function", function: { name: tool.function.name, arguments: argumentsText } }] });
    } else {
      assert(body.messages.some(message => message.role === "tool" && message.content.includes("OWNED_SCREENSHOT")));
      assert(body.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url")));
      reply({ content: "NATIVE_UI_TOOL_OK" });
    }
  }, { route: "/chat/completions", model });
  let peer;
  t.after(async () => { await peer?.dispose?.(); await bridge.close(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, "config.toml"), `cli_auth_credentials_store="file"\ncheck_for_update_on_startup=false\nmodel_provider="owned-chat"\n[model_providers.owned-chat]\nname="Owned Chat fixture"\nbase_url=${JSON.stringify(bridge.url.replace(/\/responses$/, ""))}\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n`, { mode: 0o600 });
  peer = await startNativePeer({ executable, args: ["app-server", "-c", `model_catalog_json=${JSON.stringify(catalog)}`],
    env: { HOME: root, CODEX_HOME: root, PATH: process.env.PATH }, cwd: root, stderr: "ignore" });
  const calls = [];
  peer.onRequest = message => {
    calls.push(message); assert.equal(message.method, "item/tool/call"); assert.equal(message.params.namespace, namespace); assert.equal(message.params.tool, "js");
    assert.deepEqual(message.params.arguments, { code: "owned_fixture_only" }, "The native tool receives its original arguments, never the Chat wrapper");
    peer.notify({ id: message.id, result: { success: true, contentItems: [{ type: "inputText", text: "OWNED_SCREENSHOT" }, { type: "inputImage", imageUrl: `data:image/png;base64,${png}` }] } });
  };
  let complete;
  const completed = new Promise(resolve => complete = resolve);
  peer.onNotification = message => { if (message.method === "turn/completed") complete(message.params.turn); };
  await peer.request("initialize", { clientInfo: { name: "owned-ui-tool-test", version: "1" }, capabilities: { experimentalApi: true } }); peer.notify({ method: "initialized" });
  const started = await peer.request("thread/start", { model: model.id, cwd: root, ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
    dynamicTools: [{ type: "namespace", name: namespace, description: "Synthetic UI runtime, no real device", tools: [{ type: "function", name: "js", description: "Inspect the owned fixture only", inputSchema: parameterShape === "root-union"
      ? { type: "object", oneOf: [{ type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false }, { type: "object", properties: { reset: { type: "boolean" } }, required: ["reset"], additionalProperties: false }] }
      : parameterShape === "open-required" ? { type: "object", properties: {}, required: ["code"], additionalProperties: true }
      : { type: "object", properties: { code: { type: "string" } }, required: ["code"] } }] }] });
  await peer.request("turn/start", { threadId: started.thread.id, input: [{ type: "text", text: "Inspect the synthetic UI tool only." }] });
  const turn = await completed; assert.equal(turn.status, "completed", JSON.stringify(turn.error)); assert.equal(calls.length, 1);
  assert(turn.items.some(item => item.type === "agentMessage" && item.text === "NATIVE_UI_TOOL_OK"));
});

test("installed Codex marks a Chat turn failed instead of completed when finish_reason is length", { timeout: 30000, skip: !fs.existsSync(executable) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-chat-length-"));
  const model = { id: "gemini-carbon-fixture", name: "Fixture", vendor: "Google", model_picker_enabled: true,
    supported_endpoints: ["/chat/completions"], capabilities: { type: "chat", supports: {} } };
  const catalog = path.join(root, "models.json"); fs.writeFileSync(catalog, JSON.stringify(buildCatalog([model])));
  const bridge = await memoryResponsesBridge(async (_req, res, body) => {
    res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
    const chunk = { choices: [{ [body.stream ? "delta" : "message"]: { content: "TRUNCATED_MID_SENTENCE" }, finish_reason: "length" }] };
    res.end(body.stream ? `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n` : JSON.stringify(chunk));
  }, { route: "/chat/completions", model });
  let peer;
  t.after(async () => { await peer?.dispose?.(); await bridge.close(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, "config.toml"), `cli_auth_credentials_store="file"\ncheck_for_update_on_startup=false\nmodel_provider="owned-chat"\n[model_providers.owned-chat]\nname="Owned Chat fixture"\nbase_url=${JSON.stringify(bridge.url.replace(/\/responses$/, ""))}\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n`, { mode: 0o600 });
  peer = await startNativePeer({ executable, args: ["app-server", "-c", `model_catalog_json=${JSON.stringify(catalog)}`],
    env: { HOME: root, CODEX_HOME: root, PATH: process.env.PATH }, cwd: root, stderr: "ignore" });
  let complete;
  const completed = new Promise(resolve => complete = resolve);
  peer.onNotification = message => { if (message.method === "turn/completed") complete(message.params.turn); };
  await peer.request("initialize", { clientInfo: { name: "owned-length-test", version: "1" }, capabilities: { experimentalApi: true } });
  peer.notify({ method: "initialized" });
  const started = await peer.request("thread/start", { model: model.id, cwd: root, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
  await peer.request("turn/start", { threadId: started.thread.id, input: [{ type: "text", text: "Generate output" }] });
  const turn = await completed;
  assert.equal(turn.status, "failed");
  assert.match(turn.error?.message ?? "", /max_output_tokens|incomplete/i);
});
