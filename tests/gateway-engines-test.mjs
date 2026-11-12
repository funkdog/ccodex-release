import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startGateway } from "../gateway/server.mjs";
import { antigravityEngine } from "../gateway/engines/antigravity.mjs";
import { cliEnvironment } from "../gateway/engines/index.mjs";
import { approveOnce } from "../gateway/engines/permissions.mjs";
import { claudeCodeEngine } from "../gateway/engines/claude-code.mjs";
import { copilotEngine } from "../gateway/engines/github-copilot.mjs";

for (const adapter of ["antigravity", "copilot"]) test(`${adapter} CLI approval survives Desktop never envelopes and legacy-session restart`, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gw-approval-"));
  let gateway, prompts = 0, answer = "Allow once", managed = false;
  t.after(async () => { await gateway?.close(); fs.rmSync(home, { recursive: true, force: true }); });
  // Exercise the real adapters' permission callbacks, without paid inference.
  const sdk = { RuntimeConnection: { forStdio: () => ({}) }, CopilotClient: class {
    async start() {} async stop() {}
    async getAuthStatus() { return { isAuthenticated: true }; }
    async listModels() { return [{ id: "copilot-a" }]; }
    async createSession(config) { return this.session(config.sessionId, config); }
    async resumeSession(id, config) { return this.session(id, config); }
    session(sessionId, config) {
      let emit;
      return { sessionId, on(callback) { emit = callback; return () => {}; }, async disconnect() {},
        async send() {
          const result = await config.onPermissionRequest({ kind: "shell", managedApprovalRequired: managed });
          emit({ type: "assistant.message_delta", data: { deltaContent: result.kind === "approve-once" ? "once" : "Denied" } });
          emit({ type: "session.idle", data: {} });
        } };
    }
  } };
  const engine = adapter === "copilot" ? copilotEngine({ sdk, env: {} }) : antigravityEngine({ cliHome: home,
    executable: path.resolve("tests/fixtures/antigravity-acp.mjs"), harnessPath: "/owned/fixture-harness", env: {},
    accountCheck() {}, environment: () => ({ GEMINI_HOME: home }) });
  const config = { home, endpoint: path.join(home, "s"), token: randomUUID(), generation: "approval-fixture",
    defaultEngine: adapter, engines: new Map([[adapter, engine]]) };
  const connection = { initialized: true, send() {}, request: async method => {
    assert.equal(method, "item/tool/requestUserInput"); prompts++;
    return { answers: { permission: { answers: [answer] } } };
  } };
  const call = (method, params) => gateway.protocol.handle(method, params, connection);
  gateway = await startGateway(config);
  const { thread } = await call("thread/start", { cwd: home, model: `${adapter}/${adapter === "copilot" ? "copilot-a" : "gemini-a"}`,
    approvalPolicy: "never", permissions: ":danger-full-access" });
  const execute = async (expected, expectedPrompts, extra = {}) => {
    await call("turn/start", { threadId: thread.id, input: [{ type: "text", text: "permission" }], ...extra });
    await gateway.protocol.active.get(thread.id).done;
    const saved = gateway.protocol.store.get(thread.id);
    assert.equal(saved.turns.at(-1).status, "completed", JSON.stringify(saved.turns.at(-1).error));
    assert.equal(saved.turns.at(-1).items.at(-1).text, expected);
    assert.equal(prompts, expectedPrompts);
    return saved;
  };
  // Existing sessions have both fields persisted; recovery needs no UI toggle.
  await gateway.close(); gateway = await startGateway(config);
  assert.equal((await call("thread/resume", { threadId: thread.id })).thread.cliApprovalMode, "ask");
  const first = await execute("once", 1);
  const legacySession = gateway.protocol.store.get(thread.id);
  delete legacySession.cliApprovalMode; // Older documents default to ask as well.
  gateway.protocol.store.save(legacySession);
  await gateway.close(); gateway = await startGateway(config);
  await execute("once", 2, { approvalPolicy: "never" });
  answer = "Deny";
  await execute("Denied", 3, { approvalPolicy: "never" });
  await call("thread/settings/update", { threadId: thread.id, cliApprovalMode: "auto" });
  assert.equal((await call("thread/resume", { threadId: thread.id })).approvalPolicy, "never", "CLI settings must not rewrite native host policy");
  await execute("once", 3, { approvalPolicy: "never" });
  if (adapter === "copilot") {
    managed = true;
    await execute("Denied", 4, { approvalPolicy: "never" });
    managed = false;
  }
  const expectedPrompts = adapter === "copilot" ? 4 : 3;
  await call("thread/settings/update", { threadId: thread.id, cliApprovalMode: "deny" });
  await execute("Denied", expectedPrompts, { approvalPolicy: "on-request" });
  await gateway.close(); gateway = await startGateway(config);
  await execute("Denied", expectedPrompts, { approvalPolicy: "never" });
  await call("thread/settings/update", { threadId: thread.id, cliApprovalMode: "ask" });
  answer = "Allow once";
  const last = await execute("once", expectedPrompts + 1, { approvalPolicy: "never" });
  assert.equal(last.nativeSessionId, first.nativeSessionId);
  assert.equal(last.turns.length, adapter === "copilot" ? 8 : 7);
});

test("CLI children retain their auth environment but cannot inherit the Codex gateway recursively", () => {
  const inherited = { HOME: "/private/home", ANTHROPIC_API_KEY: "synthetic", GH_TOKEN: "synthetic",
    CODEX_CLI_PATH: "/gateway/shim", CODEX_HOME: "/codex", CCODEX_GATEWAY_CONNECTION: "/token-file",
    CODEX_COPILOT_BRIDGE_PORT: "1", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "injected" };
  const result = cliEnvironment(inherited);
  assert.deepEqual(result, { HOME: inherited.HOME, ANTHROPIC_API_KEY: "synthetic", GH_TOKEN: "synthetic" });
  assert.equal(inherited.CODEX_HOME, "/codex");
});
test("permission defaults to denial; only the exact single-use answer grants it", async () => {
  for (const response of [null, {}, { answers: { permission: { answers: ["Allow once", "Deny"] } } },
    { answers: { permission: { answers: ["Deny"] } } }]) assert.equal(await approveOnce(async () => response, "tool"), false);
  assert.equal(await approveOnce(async () => { throw new Error("disconnected"); }, "tool"), false);
  assert.equal(await approveOnce(async () => ({ answers: { permission: { answers: ["Allow once"] } } }), "tool"), true);
});
test("Claude model discovery sends no prompt and text/tool streaming resumes the stored native session", async () => {
  const calls = [];
  const permissions = [];
  let closed = 0;
  const sdk = { query: ({ prompt, options }) => {
    calls.push({ prompt, options });
    return {
      supportedModels: async () => [{ value: "live-model", displayName: "From CLI" }],
      close: () => { closed++; },
      async *[Symbol.asyncIterator]() {
        assert.equal(options.resume, "existing-native");
        permissions.push(await options.canUseTool("Bash", { command: "synthetic" }));
        yield { type: "system", subtype: "init", session_id: options.resume };
        yield { type: "assistant", message: { content: [{ type: "tool_use", id: "tool", name: "Bash", input: {} }] } };
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "denied", is_error: true }] } };
        yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "answer" } } };
        yield { type: "result", subtype: "success", is_error: false, result: "answer" };
      },
    };
  } };
  const engine = claudeCodeEngine({ sdk, env: {} });
  assert.equal((await engine.models())[0].id, "live-model");
  assert.equal(typeof calls[0].prompt, "object");
  assert.equal(calls[0].options.persistSession, false);
  const text = [], tools = [], sessions = [];
  await engine.run({ prompt: "test", model: "live-model", cwd: "/tmp", nativeSessionId: "existing-native",
    signal: new AbortController().signal, onSession: id => sessions.push(id), onText: value => text.push(value),
    onTool: value => tools.push(value), ask: async () => { throw new Error("no Desktop"); } });
  assert.deepEqual(text, ["answer"]);
  assert.equal(permissions[0].behavior, "deny");
  assert.deepEqual(tools.map(tool => tool.phase), ["start", "end"]);
  assert.ok(sessions.every(id => id === "existing-native"));
  assert.equal(closed, 2);
});
test("Claude user questions return answers to the native tool, not an approval in place of an answer", async () => {
  let response;
  const sdk = { query: ({ options }) => ({ close() {}, async *[Symbol.asyncIterator]() {
    response = await options.canUseTool("AskUserQuestion", { questions: [{ question: "Which?", header: "Choice", options: [{ label: "A", description: "A" }] }] });
    yield { type: "result", subtype: "success", is_error: false, result: "done" };
  } }) };
  const engine = claudeCodeEngine({ sdk, env: {} });
  await engine.run({ prompt: "test", model: "model", cwd: "/tmp", signal: new AbortController().signal,
    onSession() {}, onText() {}, ask: async () => ({ answers: { q0: { answers: ["A"] } } }) });
  assert.equal(response.behavior, "allow");
  assert.deepEqual(response.updatedInput.answers, { "Which?": "A" });
});
test("Copilot uses the CLI model catalog, preserves native identity, and waits for idle after abort", async () => {
  let sessionConfig, emit, abortSeen, release;
  const aborted = new Promise(resolve => { abortSeen = resolve; });
  let stopped = 0, disconnected = 0;
  const session = { sessionId: "stored", on(callback) { emit = callback; return () => {}; },
    async send() {}, async abort() { abortSeen(); }, async disconnect() { disconnected++; } };
  const sdk = { RuntimeConnection: { forStdio: options => options }, CopilotClient: class {
    async start() {}
    async stop() { stopped++; }
    async getAuthStatus() { return { isAuthenticated: true }; }
    async listModels() { return [{ id: "gemini-from-account", name: "Gemini" }, { id: "disabled", policy: { state: "disabled" } }]; }
    async resumeSession(id, config) { assert.equal(id, "stored"); sessionConfig = config; release(); return session; }
    async createSession() { assert.fail("resume must not create a new session"); }
  } };
  const engine = copilotEngine({ sdk, env: {} });
  assert.deepEqual((await engine.models()).map(model => model.id), ["gemini-from-account"]);
  const controller = new AbortController();
  const resumed = new Promise(resolve => { release = resolve; });
  let finished = false;
  const running = engine.run({ prompt: "test", model: "gemini-from-account", cwd: "/tmp", nativeSessionId: "stored",
    signal: controller.signal, onSession() {}, onText() {}, ask: async () => ({ answers: { permission: { answers: ["Deny"] } } }) }).then(() => { finished = true; });
  await resumed;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await sessionConfig.onPermissionRequest({ kind: "shell" })).kind, "reject");
  controller.abort(); await aborted;
  assert.equal(finished, false);
  emit({ type: "session.idle", data: {} }); await running;
  assert.equal(stopped, 2);
  assert.equal(disconnected, 1);
});
test("Copilot cannot advertise models when authentication failed", async () => {
  let stopped = false;
  const sdk = { RuntimeConnection: { forStdio: () => ({}) }, CopilotClient: class {
    async start() {} async getAuthStatus() { return { isAuthenticated: false }; }
    async listModels() { assert.fail("unauthenticated catalog"); } async stop() { stopped = true; }
  } };
  await assert.rejects(copilotEngine({ sdk, env: {} }).models(), /not authenticated/);
  assert.equal(stopped, true);
});
test("Copilot sends image blobs as SDK attachments without changing text or session identity", async () => {
  let emit, sent;
  const sdk = { RuntimeConnection: { forStdio: () => ({}) }, CopilotClient: class {
    async start() {} async stop() {}
    async createSession() { return { sessionId: "image-session", on(callback) { emit = callback; return () => {}; },
      async send(message) { sent = message; emit({ type: "session.idle", data: {} }); }, async disconnect() {} }; }
  } };
  const attachments = [{ type: "blob", mimeType: "image/png", data: "fixture" }];
  await copilotEngine({ sdk, env: {} }).run({ prompt: "describe", attachments, model: "vision", cwd: "/tmp",
    signal: new AbortController().signal, onSession() {}, onText() {}, ask() { assert.fail("No tool authorization needed"); } });
  assert.deepEqual(sent, { prompt: "describe", attachments });
});

test("Copilot forwards reasoning on create/resume and applies live per-session approval modes", async () => {
  let mode = "ask", asks = 0, emit;
  const configs = [], decisions = [];
  const sdk = { RuntimeConnection: { forStdio: () => ({}) }, CopilotClient: class {
    async start() {} async stop() {}
    async createSession(config) { configs.push(config); return this.session(config); }
    async resumeSession(id, config) { assert.equal(id, "same-cli"); configs.push(config); return this.session(config); }
    session(config) { return { sessionId: "same-cli", on(callback) { emit = callback; return () => {}; }, async disconnect() {},
      async send() {
        for (const [policy, request, invocation] of [["auto", { kind: "write" }], ["read-only", { kind: "read" }],
          ["read-only", { kind: "write" }], ["deny", { kind: "read" }], ["ask", { kind: "shell" }],
          ["auto", { kind: "write", managedApprovalRequired: true }], ["auto", { kind: "read" }, { managedSettingsEnabled: true }]]) {
          mode = policy; decisions.push((await config.onPermissionRequest(request, invocation)).kind);
        }
        emit({ type: "session.idle", data: {} });
      } }; }
  } };
  const engine = copilotEngine({ sdk, env: {} });
  const options = { prompt: "test", model: "model", cwd: "/tmp", signal: new AbortController().signal,
    getApprovalMode: () => mode, onSession() {}, onText() {}, ask: async () => { asks++; return { answers: { permission: { answers: ["Deny"] } } }; } };
  await engine.run({ ...options, reasoningEffort: "high" });
  await engine.run({ ...options, model: "second-model", nativeSessionId: "same-cli", reasoningEffort: "low" });
  assert.deepEqual(configs.map(value => value.model), ["model", "second-model"]);
  assert.deepEqual(configs.map(value => value.reasoningEffort), ["high", "low"]);
  assert.deepEqual(decisions.slice(0, 7), ["approve-once", "approve-once", "reject", "reject", "reject", "reject", "reject"]);
  assert.equal(asks, 8);
});
