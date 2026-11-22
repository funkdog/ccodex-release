import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { codexNativeExecution } from "../gateway/engines/codex-native.mjs";
import { copilotProviderArguments } from "../gateway/copilot-provider.mjs";
import { buildCatalog } from "../bridge/catalog.mjs";
import { createResponsesWriter } from "../bridge/translate.mjs";

const executable = process.env.CCODEX_TEST_NATIVE_CORE ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
test("gateway-owned Codex executes a real native tool and cold-resumes only its private session", { timeout: 60000, skip: !fs.existsSync(executable) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-conversation-"));
  const home = path.join(root, "native"), workspace = path.join(root, "workspace"), bridgeHome = path.join(root, "bridge");
  fs.mkdirSync(workspace); fs.mkdirSync(bridgeHome);
  const model = "gpt-native-handoff-fixture", requests = [], tools = [], texts = [], sessions = [];
  const catalog = buildCatalog([{ id: model, name: "Fixture", vendor: "OpenAI", model_picker_enabled: true, supported_endpoints: ["/responses"],
    capabilities: { type: "chat", supports: {}, limits: { max_prompt_tokens: 128000, max_output_tokens: 2048 } } }]);
  fs.writeFileSync(path.join(bridgeHome, "models.json"), JSON.stringify(catalog));
  const server = http.createServer(async (req, res) => {
    try {
      const bytes = []; for await (const chunk of req) bytes.push(chunk);
      const body = JSON.parse(Buffer.concat(bytes)); requests.push(body);
      const writer = createResponsesWriter(res, body, new Map());
      if (!body.input.some(item => item.type === "function_call_output" && item.call_id === "call_handoff_tool")) {
        writer.pushChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_handoff_tool", type: "function",
          function: { name: "exec_command", arguments: JSON.stringify({ cmd: "printf '%s\\n' NATIVE_HANDOFF_TOOL_OK > proof.txt", workdir: workspace }) } }] } }] });
      } else writer.pushChunk({ choices: [{ delta: { content: "NATIVE_HANDOFF_OK" } }] });
      writer.finish();
    } catch (error) { res.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const args = [...copilotProviderArguments({ bridgeHome, bridgePort: server.address().port }), "-c", 'model_provider="mycodex-copilot"',
    "-c", `model_catalog_json=${JSON.stringify(path.join(bridgeHome, "models.json"))}`];
  const context = { prompt: "Continue with the synthetic native tool.", model, cwd: workspace, signal: new AbortController().signal,
    getApprovalMode: () => "auto", onSession: id => sessions.push(id), onText: text => texts.push(text), onTool: event => tools.push(event),
    ask: async () => ({ answers: { permission: { answers: ["Deny"] } } }) };
  await codexNativeExecution({ executable, home, args, env: { HOME: root, PATH: process.env.PATH } }).run(context);
  assert.equal(fs.readFileSync(path.join(workspace, "proof.txt"), "utf8"), "NATIVE_HANDOFF_TOOL_OK\n");
  assert.equal(texts.join(""), "NATIVE_HANDOFF_OK");
  assert.ok(tools.some(event => event.phase === "start" && event.name === "commandExecution"));
  const sessionId = sessions[0]; assert.ok(sessionId);
  const firstCount = requests.length;
  await codexNativeExecution({ executable, home, args, env: { HOME: root, PATH: process.env.PATH } }).run({ ...context, nativeSessionId: sessionId, prompt: "CONTINUE_PRIVATE_SESSION" });
  assert.equal(sessions.at(-1), sessionId);
  assert.ok(requests.length > firstCount);
  assert.ok(requests.at(-1).input.some(item => item.type === "function_call_output" && item.call_id === "call_handoff_tool"));
  assert.ok(requests.at(-1).input.some(item => JSON.stringify(item).includes("CONTINUE_PRIVATE_SESSION")));
});
