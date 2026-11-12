import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { createEngines, cliEnvironment } from "../gateway/engines/index.mjs";
import { writeClaudeApiProfile, claudeApiEnvironment } from "../gateway/claude-api-profile.mjs";

const sdkPath = process.env.MYCODEX_TEST_CLAUDE_SDK ?? path.join(os.homedir(), ".cache/ccodex-development/gateway-sdk/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs");
test("installed Claude Code uses the configured API key, executes tools, resumes history and cancels in an isolated profile", {
  skip: !fs.existsSync(sdkPath), timeout: 60000,
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-claude-native-")), requests = [], tools = [], authentication = [];
  let cancel;
  const server = http.createServer(async (req, res) => {
    const chunks = [];for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "claude-opus-5-5" }, { id: "claude-sonnet-5-5" }, { id: "fixture-provider-model", display_name: "Provider model" }], has_more: false }));return;
    }
    if (req.url?.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" });res.end('{"input_tokens":20}');return; }
    if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404, { "content-type": "application/json" });res.end('{"error":{"type":"not_found_error","message":"Fixture only"}}');return; }
    authentication.push(req.headers["x-api-key"] === "fixture-claude-api-key" || req.headers.authorization === "Bearer fixture-claude-api-key");
    requests.push(body);
    if (JSON.stringify(body.messages).includes("CANCEL_THIS_TEST")) { cancel(); return; }
    const toolId = JSON.stringify(body.messages).includes("RULE_FORCED_PERMISSION") ? "rule-tool" : "fixture-tool";
    const previousTool = body.messages?.some(m => m.role === "assistant" && m.content?.some?.(c => c.type === "tool_use" && c.id === toolId));
    const content = previousTool ? [{ type: "text", text: "CLAUDE_API_OK" }] : [{ type: "tool_use", id: toolId, name: "Bash", input: { command: "pwd", description: "Report isolated working directory" } }];
    const message = { id: "fixture-message", type: "message", role: "assistant", model: body.model, content, stop_reason: previousTool ? "end_turn" : "tool_use", stop_sequence: null, usage: { input_tokens: 20, output_tokens: 8 } };
    if (!body.stream) { res.writeHead(200, { "content-type": "application/json" });res.end(JSON.stringify(message));return; }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } });
    const block = content[0];
    send("content_block_start", { index: 0, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } });
    send("content_block_delta", { index: 0, delta: block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    send("content_block_stop", { index: 0 });send("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 8 } });send("message_stop", {});res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let sessionId, permissionPrompts = 0;
  try {
    writeClaudeApiProfile(home, { baseUrl: `http://127.0.0.1:${server.address().port}` }, "fixture-claude-api-key");
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "fixture-project-key" } }));
    const engines = await createEngines([{ id: "claude", adapter: "claude-code", sdkPath, cliHome: home }], {
      env: { ...cliEnvironment(), DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    });
    const engine = engines.get("claude");
    const catalog = await engine.models(), selected = catalog.find(m => m.id === "sonnet") ?? catalog[0];assert.ok(selected);
    assert.equal(catalog.some(m => m.id === "fixture-provider-model"), false, "A broad provider catalogue is not the Claude CLI's selectable model list");
    assert.equal(catalog.some(m => m.id === "claude-fable-5-1"), false, "Bundled SDK aliases must not advertise models absent from the provider catalogue");
    const text = [];
    const context = { model: selected.id, cwd: home, prompt: "FIRST_TURN_MEMORY: use the Bash tool to run pwd, then report CLAUDE_API_OK.",
      reasoningEffort: "high", signal: new AbortController().signal, getApprovalMode: () => "auto",
      onSession: value => { if (sessionId) assert.equal(value, sessionId); sessionId = value; }, onText: value => text.push(value), onTool: value => tools.push(value),
      ask: async () => { permissionPrompts++;return { answers: { permission: { answers: ["Deny"] } } }; } };
    await engine.run(context);
    assert.ok(text.join("").includes("CLAUDE_API_OK"));
    assert.ok(tools.some(t => t.phase === "end" && t.success && JSON.stringify(t.output).includes(home)));
    assert.equal(permissionPrompts, 0);
    assert.ok(authentication.every(Boolean), "Project settings cannot replace the explicitly selected personal API key");
    assert.ok(requests.some(r => r.output_config?.effort === "high"), "Selected effort must reach the native API request");
    const previousCount = requests.length;
    const second = catalog.find(m => m.id !== selected.id && m.supportedReasoningEfforts?.includes("low")) ?? selected;
    await engine.run({ ...context, model: second.id, prompt: "Resume this chat. Reply CLAUDE_API_OK.", nativeSessionId: sessionId, reasoningEffort: "low" });
    assert.ok(requests.slice(previousCount).some(r => JSON.stringify(r.messages).includes("FIRST_TURN_MEMORY")), "Cold resume must restore native history without replay by the gateway");
    assert.ok(requests.slice(previousCount).some(r => r.model === second.id), "Model switches must reach the native API while retaining the same session");
    fs.writeFileSync(path.join(home, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "fixture-project-key" }, permissions: { ask: ["Bash(pwd)"] } }));
    const toolsBeforeRule = tools.length;
    await engine.run({ ...context, nativeSessionId: sessionId, prompt: "RULE_FORCED_PERMISSION: run pwd using Bash, then reply CLAUDE_API_OK." });
    assert.equal(permissionPrompts, 1, "The native project ask rule must remain effective in auto mode");
    assert.ok(tools.slice(toolsBeforeRule).some(t => t.phase === "end" && !t.success));
    const controller = new AbortController();cancel = () => controller.abort();
    let cancelError;
    await engine.run({ ...context, nativeSessionId: sessionId, prompt: "CANCEL_THIS_TEST", signal: controller.signal }).catch(error => { cancelError = error; });
    if (!controller.signal.aborted && cancelError) throw cancelError;
    assert.equal(controller.signal.aborted, true);
    assert.equal(fs.readdirSync(home).some(name => name.startsWith(".mycodex-auth-")), false, "Cancellation must remove secret-bearing temporary settings");
  } finally {
    server.closeAllConnections();await new Promise(resolve => server.close(resolve));
    await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
