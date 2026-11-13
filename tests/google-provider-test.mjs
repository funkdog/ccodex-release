import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { buildGoogleRequest, googleSignatureStore, codexGoogleEngine, googleProviderArguments, googleProviderToken } from "../gateway/google-provider.mjs";
import { startNativePeer } from "../gateway/native-peer.mjs";
import { AppServerRouter } from "../gateway/router.mjs";
import { createNativeSessionController } from "../bridge/desktop-native-session.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";
test("Google maps native images, developer instructions, custom tools and signed function history without an agent", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-google-map-")); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const signatures = googleSignatureStore(home);
  const request = { model: "gemini-account-model", instructions: "Native instructions", input: [
    { role: "user", content: [{ type: "input_text", text: "Describe" }, { type: "input_image", image_url: `data:image/png;base64,${png}` }] }],
    tools: [{ type: "custom", name: "apply_patch", description: "Native file editor" }] };
  const mapped = buildGoogleRequest(request, signatures);
  assert.equal(mapped.request.contents[0].parts[1].inlineData.data, png);
  assert.equal(mapped.request.config.systemInstruction, "Native instructions");
  assert.equal(mapped.toolKinds.get("apply_patch"), "custom");
  signatures.put("call_native", { model: request.model, name: "apply_patch", thoughtSignature: "opaque-google-signature" });
  request.input.push({ type: "custom_tool_call", call_id: "call_native", name: "apply_patch", input: "patch" },
    { type: "custom_tool_call_output", call_id: "call_native", output: "Native tool completed" });
  const restored = buildGoogleRequest(request, googleSignatureStore(home));
  assert.equal(restored.request.contents[1].parts[0].thoughtSignature, "opaque-google-signature");
  assert.equal(restored.request.contents[2].parts[0].functionResponse.name, "apply_patch");
  assert.throws(() => buildGoogleRequest({ ...request, model: "another-account-model" }, signatures), /signature/);
  assert.throws(() => buildGoogleRequest({ ...request, previous_response_id: "opaque" }, signatures), /materialized/);
  assert.throws(() => buildGoogleRequest({ ...request, reasoning: { effort: "xhigh" } }, signatures), /thinking/);

  const namespaced = buildGoogleRequest({
    model: "gemini-account-model",
    input: "Run UI tool",
    tools: [{ type: "namespace", name: "mcp__cua_repl", tools: [{ type: "function", name: "js", parameters: { type: "object", properties: { code: { type: "string" } } } }] }],
    tool_choice: { type: "function", namespace: "mcp__cua_repl", name: "js" },
  }, signatures);
  const declaredName = namespaced.request.config.tools[0].functionDeclarations[0].name;
  assert.deepEqual(namespaced.request.config.toolConfig.functionCallingConfig.allowedFunctionNames, [declaredName]);
});

test("Google drafts retain Codex permissions and resumed native threads retain native controls", () => {
  const controller = createNativeSessionController(); controller.select("mycodex/codex-gemini/gemini-account-model");
  const intent = controller.begin({ clientUserMessageId: "google-draft", mode: "plan", permissionSelection: { native: true },
    attachments: [{}], input: [{ type: "image", url: "data:image/png;base64,fixture" }] });
  assert.deepEqual(intent.options.permissionSelection, { native: true }); assert.equal(intent.options.collaborationMode.mode, "plan");
  controller.remember({ id: "google-thread", model: "mycodex/codex-gemini/gemini-account-model", modelProvider: "mycodex-google" });
  const params = { threadId: "google-thread", model: "native-selected-model", sandbox: "workspace-write", effort: "low" };
  assert.deepEqual(controller.outgoing("mcp-request", { hostId: "local", request: { method: "turn/start", params } }).request.params, params);
  assert.equal(controller.thread("google-thread").nativeRuntime, true); intent.finish();
});

const executable = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
test("pinned Codex uses the private Google provider, executes its own tool and restores signed history after cold restart", {
  skip: process.platform !== "darwin" || !fs.existsSync(executable), timeout: 60000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-google-native-"));
  const profile = path.join(root, "profile"), workspace = path.join(root, "workspace"), cliHome = path.join(root, "google");
  for (const dir of [profile, workspace, cliHome]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(profile, "config.toml"), 'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[analytics]\nenabled = false\n');
  const portServer = http.createServer(); await new Promise(resolve => portServer.listen(0, "127.0.0.1", resolve));
  const bridgePort = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const config = { cliHome, bridgePort }, token = "owned-native-google-test-capability";
  const requests = []; let engine, router, sequence = 0;
  const replies = new Map(), turns = new Map();
  const operation = async (_config, method, request, { onChunk } = {}) => {
    if (method === "model/list") return { data: [{ id: "gemini-google-fixture", name: "Google fixture", inputModalities: ["text", "image"] }] };
    requests.push(request);
    const historyCall = request.contents.flatMap(row => row.parts).find(part => part.functionCall);
    if (!historyCall) {
      assert.ok(request.config.tools[0].functionDeclarations.some(tool => tool.name === "exec_command"),
        JSON.stringify(request.config.tools[0].functionDeclarations.map(tool => tool.name)));
      onChunk({ candidates: [{ content: { parts: [{ functionCall: { name: "exec_command", args: { cmd: "printf 'GOOGLE_NATIVE_TOOL_OK\\n' > proof.txt", workdir: workspace } },
        thoughtSignature: "native-fixture-signature" }] }, finishReason: "STOP" }] });
    } else {
      assert.equal(historyCall.thoughtSignature, "native-fixture-signature");
      assert.ok(request.contents.flatMap(row => row.parts).some(part => part.functionResponse?.name === "exec_command"));
      onChunk({ candidates: [{ content: { parts: [{ text: "GOOGLE_NATIVE_OK" }] }, finishReason: "STOP" }] });
    }
    return { completed: true };
  };
  async function connect() {
    engine = codexGoogleEngine(config, { operation }); await engine.models(); await engine.start({ token });
    const native = await startNativePeer({ executable, args: ["app-server", ...googleProviderArguments(config)], cwd: workspace,
      stderr: "ignore", env: { HOME: root, CODEX_HOME: profile, PATH: process.env.PATH, MYCODEX_GOOGLE_TOKEN: googleProviderToken(token) } });
    router = new AppServerRouter({ native, googleProvider: config, cursorSecret: "fixture-no-gateway", ownsThread: () => false,
      connectProvider: id => { assert.equal(id, "mycodex-google"); return startNativePeer({ executable,
        args: ["app-server", ...googleProviderArguments(config), "-c", "model_provider=mycodex-google",
          "-c", `model_catalog_json=${JSON.stringify(path.join(cliHome, "codex-models.json"))}`], cwd: workspace,
        stderr: "ignore", env: { HOME: root, CODEX_HOME: profile, PATH: process.env.PATH,
          MYCODEX_GOOGLE_TOKEN: googleProviderToken(token) } }); },
      connectGateway() { assert.fail("Native Google provider cannot execute a CLI Agent"); }, send: message => {
        if (!message.method) replies.set(message.id, message);
        else if (message.method === "turn/completed") turns.set(message.params.turn.id, message.params.turn);
        else if (Object.hasOwn(message, "id")) void router.receive({ id: message.id, error: { code: -32000, message: "No interactive permission in test." } });
      } });
    await request("initialize", { clientInfo: { name: "google_native_test", version: "1" }, capabilities: { experimentalApi: true } });
    await router.receive({ method: "initialized" });
  }
  async function request(method, params) {
    const id = ++sequence; await router.receive({ id, method, params });
    const response = replies.get(id); replies.delete(id);
    if (!response || response.error) throw new Error(`${method}: ${response?.error?.message || "no response"}`); return response.result;
  }
  async function complete(id) {
    const deadline = Date.now() + 20000; while (!turns.has(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(turns.get(id)?.status, "completed", JSON.stringify(turns.get(id)?.error));
  }
  t.after(async () => { await router?.close(); await engine?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await connect();
  const unauthorized = await fetch(`http://127.0.0.1:${bridgePort}/responses`, { method: "POST", body: "{}" }); assert.equal(unauthorized.status, 403);
  const created = await request("thread/start", { model: "mycodex/codex-gemini/gemini-google-fixture", cwd: workspace, approvalPolicy: "never", sandbox: "danger-full-access" });
  assert.equal(created.modelProvider, "mycodex-google");
  const { turn } = await request("turn/start", { threadId: created.thread.id,
    input: [{ type: "text", text: "Create the fixture file." }, { type: "image", url: `data:image/png;base64,${png}` }] });
  await complete(turn.id); assert.equal(fs.readFileSync(path.join(workspace, "proof.txt"), "utf8").trim(), "GOOGLE_NATIVE_TOOL_OK");
  assert.ok(requests[0].contents.flatMap(row => row.parts).some(part => part.inlineData?.data === png));
  await router.close(); await engine.close(); await connect();
  const resumed = await request("thread/resume", { threadId: created.thread.id }); assert.equal(resumed.modelProvider, "mycodex-google");
  const second = await request("turn/start", { threadId: created.thread.id, input: [{ type: "text", text: "Continue." }] }); await complete(second.turn.id);
  assert.equal(requests.length, 3); assert.ok(resumed.thread.turns.some(value => value.id === turn.id));
});
