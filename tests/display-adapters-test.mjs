import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { displayFixture } from "./fixtures/display.mjs";
import { claudeCodeEngine } from "../gateway/engines/claude-code.mjs";
import { createAcpDisplay } from "../gateway/engines/acp-display.mjs";
import { createGoogleChunkTranslator } from "../gateway/google-translation.mjs";
import { createResponsesWriter } from "../bridge/translate.mjs";
import { copilotEngine } from "../gateway/engines/github-copilot.mjs";

for (const decision of ["accept", "decline", "cancel"]) test(`Claude correlates native approval with tool lifecycle (${decision})`, async () => {
  const requests = [], fallback = [], f = displayFixture(async (method, params) => { requests.push({ method, params }); return { decision }; });
  let permission;
  const engine = claudeCodeEngine({ env: {}, sdk: { query: ({ options }) => ({ close() {}, async *[Symbol.asyncIterator]() {
    yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } };
    yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "verify first" } } };
    yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
    permission = await options.canUseTool("Bash", { command: "pwd" }, { toolUseID: "cmd", matchedAskRule: {} });
    yield { type: "assistant", message: { content: [{ type: "tool_use", id: "cmd", name: "Bash", input: { command: "pwd" } }] } };
    yield { type: "stream_event", parent_tool_use_id: "cmd", event: { type: "content_block_delta", delta: { type: "text_delta", text: "child progress" } } };
    yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "cmd", is_error: decision !== "accept", content: "result" }] } };
    yield { type: "result", subtype: "success", result: "done" };
  } }) } });
  await engine.run({ model: "fixture", cwd: os.tmpdir(), prompt: "fixture", signal: f.controller.signal,
    onSession() {}, onText() {}, onTool: event => fallback.push(event), display: f.sink, getApprovalMode: () => "auto",
    ask: async () => assert.fail("Known command must use native approval") });
  assert.equal(requests[0].method, "item/commandExecution/requestApproval");
  assert.equal(permission.behavior, decision === "accept" ? "allow" : "deny");
  assert.equal(f.events.filter(event => event.method === "item/started" && event.params.item.type === "commandExecution").length, 1);
  const command = f.events.filter(event => event.method === "item/completed" && event.params.item.type === "commandExecution").at(-1).params.item;
  assert.equal(command.status, decision === "accept" ? "completed" : "declined");
  assert.equal(command.exitCode, null); assert.equal(fallback.length, 0);
  assert.equal(f.turn.items[0].summary[0], "verify first");
  assert(f.turn.items.some(item => item.type === "reasoningRecord" && item.summary[0].includes("child progress")));
  assert(f.events.every(event => !event.params.item?.agentThreadId));
});

test("Copilot native shell approval preserves managed ask, reasoning and real exit status", async () => {
  const f = displayFixture(), fallback = [];
  let permission;
  const engine = copilotEngine({ sdk: { RuntimeConnection: { forStdio: () => ({}) }, CopilotClient: class {
    async start() {} async stop() {}
    async createSession(config) {
      let emit;
      return { sessionId: config.sessionId, on(callback) { emit = callback; return () => {}; }, async disconnect() {}, async send() {
        emit({ type: "assistant.reasoning_delta", data: { reasoningId: "r", deltaContent: "check" } });
        emit({ type: "assistant.reasoning", data: { reasoningId: "r", content: "check" } });
        permission = await config.onPermissionRequest({ kind: "shell", toolCallId: "cmd", fullCommandText: "pwd", managedApprovalRequired: true });
        emit({ type: "tool.execution_start", data: { toolCallId: "cmd", toolName: "shell", arguments: { command: "pwd" }, shellToolInfo: {} } });
        emit({ type: "tool.execution_complete", data: { toolCallId: "cmd", success: true, result: { content: "result" }, shellExecution: { exitCode: 7 } } });
        emit({ type: "session.idle", data: {} });
      } };
    }
  } } });
  await engine.run({ model: "fixture", cwd: os.tmpdir(), prompt: "fixture", signal: f.controller.signal, display: f.sink,
    getApprovalMode: () => "auto", onSession() {}, onText() {}, onTool: e => fallback.push(e), ask: async () => assert.fail("Known shell must use native approval") });
  assert.equal(permission.kind, "approve-once"); assert.equal(fallback.length, 0);
  assert.equal(f.turn.items[0].summary[0], "check"); assert.equal(f.turn.items[1].exitCode, 7);
  assert.equal(f.events.filter(event => event.method === "item/started" && event.params.item.type === "commandExecution").length, 1);
});

test("ACP approval uses explicit facts, cancels unsafe replies and keeps business questions separate", async () => {
  const f = displayFixture(async () => ({ decision: { acceptWithExecpolicyAmendment: {} } }));
  const timeline = createAcpDisplay(f.sink, "/tmp", () => assert.fail("Known execute tool should be projected"));
  assert.equal(await timeline.approve({ toolCallId: "cmd", kind: "execute", title: "Run", rawInput: { command: "pwd" } }), false);
  assert.equal(f.turn.items[0].status, "declined");
  assert.equal(await timeline.approve({ toolCallId: "unknown", title: "unknown" }), null);
});

for (const finishReason of ["STOP", "MAX_TOKENS", "SAFETY"]) test(`Google dialect uses shared reasoning and terminal translation (${finishReason})`, () => {
  let response;
  const writer = createResponsesWriter({ writeHead() {}, end(body) { response = JSON.parse(body); } }, { model: "fixture" }, new Map(), { streaming: false });
  const translation = createGoogleChunkTranslator(writer, new Map(), { put() {}, get() {} }, "fixture");
  translation.push({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "answer" }] }, finishReason }] });
  translation.finish();
  assert.deepEqual(response.output.map(item => item.type), ["reasoning", "message"]);
  assert.equal(response.output[0].summary[0].text, "thinking");
  assert.equal(response.status, finishReason === "STOP" ? "completed" : "incomplete");
  assert.equal(response.output[1].phase, finishReason === "STOP" ? "final_answer" : "commentary");
});
