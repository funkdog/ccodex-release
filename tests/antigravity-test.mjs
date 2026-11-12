import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { startGateway } from "../gateway/server.mjs";
import { antigravityEngine, antigravityPermission, antigravityEnvironment, macHttpsProxy, assertAntigravityAccount } from "../gateway/engines/antigravity.mjs";
function fixture(t, env = {}) {
  const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-antigravity-test-"));
  t.after(() => fs.rmSync(cliHome, { recursive: true, force: true }));
  const engine = antigravityEngine({ cliHome, executable: path.resolve("tests/fixtures/antigravity-acp.mjs"), harnessPath: "/owned/fixture-harness", env,
    accountCheck: () => {}, environment: (value, { cliHome }) => ({ ...value, GEMINI_HOME: cliHome }) });
  return { cliHome, engine, calls: () => fs.readFileSync(path.join(cliHome, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse) };
}
test("Antigravity publishes per-model reasoning options from actual session configuration without authentication or inference", async t => {
  const f = fixture(t), models = await f.engine.models();
  assert.deepEqual(f.engine.approvalModes, ["ask", "auto", "deny"]);
  assert.deepEqual(models.map(m => [m.id, m.supportedReasoningEfforts]), [["gemini-a", ["low", "high"]], ["gemini-b", ["medium", "high"]]]);
  assert.ok(f.calls().every(c => !["authenticate", "session/prompt"].includes(c.method)));
});
test("Antigravity applies model and reasoning, uses replay-free cold resume and supports image-only input", async t => {
  const f = fixture(t), text = []; let sessionId;
  const options = { model: "gemini-a", reasoningEffort: "low", cwd: f.cliHome, signal: new AbortController().signal,
    onSession: value => { if (sessionId) assert.equal(value, sessionId); sessionId = value; }, onText: value => text.push(value) };
  await f.engine.run({ ...options, attachments: [{ data: "fixture", mimeType: "image/png" }] });
  await f.engine.run({ ...options, nativeSessionId: sessionId, prompt: "continue" });
  assert.deepEqual(text, ["IMAGE_OK", "TEXT_OK"]);
  assert.equal(f.calls().filter(c => c.method === "session/new").length, 1);
  assert.equal(f.calls().filter(c => c.method === "session/resume").length, 1);
  assert.ok(f.calls().some(c => c.method === "session/set_config_option" && c.params.configId === "thinking-choice" && c.params.value === "low"));
  assert.ok(f.calls().some(c => c.method === "session/set_mode" && c.params.modeId === "default"));
});
test("Antigravity auto approves individual tools while business answers remain manual and permanent grants are never selected", async t => {
  const f = fixture(t); let permissionAsks = 0, businessAsks = 0;
  const run = async (prompt, mode) => {
    let text = "";
    await f.engine.run({ model: "gemini-a", cwd: f.cliHome, prompt, signal: new AbortController().signal,
      onSession() {}, onText: value => text += value, getApprovalMode: () => mode, ask: async questions => {
        if (questions[0].id === "permission") { permissionAsks++; return { answers: { permission: { answers: ["Allow once"] } } }; }
        businessAsks++; return { answers: { "antigravity-question": { answers: ["Beta"] } } };
      } }); return text;
  };
  assert.equal(await run("permission", "ask"), "once"); assert.equal(permissionAsks, 1);
  assert.equal(await run("permission", "auto"), "once"); assert.equal(permissionAsks, 1);
  assert.equal(await run("permission", "auto"), "once"); assert.equal(permissionAsks, 1);
  assert.equal(await run("permission", "deny"), "Denied"); assert.equal(permissionAsks, 1);
  assert.equal(await run("question", "deny"), "beta"); assert.equal(businessAsks, 1);
  assert.equal(await run("question", "auto"), "beta"); assert.equal(businessAsks, 2);
  assert.ok(f.calls().filter(c => c.method === "session/set_mode").every(c => c.params.modeId === "default"));
});
test("Antigravity automatic approval obeys the latest session policy, cancellation and advertised one-time choices", async () => {
  let mode = "auto", prompts = 0;
  const controller = new AbortController();
  const context = { signal: controller.signal, getApprovalMode: () => mode,
    ask: async () => { prompts++; return { answers: { permission: { answers: ["Allow once"] } } }; } };
  const params = { toolCall: { toolCallId: "write" }, options: [
    { kind: "allow_always", optionId: "permanent", name: "Always" },
    { kind: "allow_once", optionId: "one-time", name: "Once" }] };
  const approved = { outcome: { outcome: "selected", optionId: "one-time" } };
  const denied = { outcome: { outcome: "cancelled" } };
  assert.deepEqual(await antigravityPermission(params, context), approved);
  assert.equal(prompts, 0);
  mode = "deny";
  assert.deepEqual(await antigravityPermission(params, context), denied);
  mode = "ask";
  assert.deepEqual(await antigravityPermission(params, context), approved);
  assert.equal(prompts, 1);
  mode = "auto";
  assert.deepEqual(await antigravityPermission({ ...params, options: params.options.slice(0, 1) }, context), denied);
  assert.deepEqual(await antigravityPermission({ ...params, options: [params.options[1], params.options[1]] }, context), denied);
  assert.deepEqual(await antigravityPermission({ ...params, options: [{ kind: "allow_once", optionId: "", name: "invalid" }] }, context), denied);
  controller.abort();
  assert.deepEqual(await antigravityPermission(params, context), denied);
  assert.equal(prompts, 1);
});
test("Antigravity session auto policy executes without prompts and survives gateway restart", async t => {
  const f = fixture(t);
  const config = { home: f.cliHome, endpoint: path.join(f.cliHome, "s"), token: randomUUID(), generation: "auto-policy-fixture",
    defaultEngine: "antigravity", engines: new Map([["antigravity", f.engine]]) };
  let gateway = await startGateway(config), prompts = 0;
  const connection = { initialized: true, send() {}, request: async () => {
    prompts++; return { answers: { permission: { answers: ["Allow once"] } } };
  } };
  const call = (method, params) => gateway.protocol.handle(method, params, connection);
  try {
    const catalog = await call("model/list", {});
    assert.deepEqual(catalog.data[0].cliApprovalModes, ["ask", "auto", "deny"]);
    const { thread } = await call("thread/start", { cwd: f.cliHome, model: "antigravity/gemini-a", approvalPolicy: "on-request" });
    await call("thread/settings/update", { threadId: thread.id, cliApprovalMode: "auto" });
    const execute = async () => {
      await call("turn/start", { threadId: thread.id, input: [{ type: "text", text: "permission" }] });
      await gateway.protocol.active.get(thread.id)?.done;
      const saved = gateway.protocol.store.get(thread.id);
      assert.equal(saved.turns.at(-1).status, "completed", JSON.stringify(saved.turns.at(-1).error));
      assert.equal(saved.turns.at(-1).items.at(-1).text, "once");
    };
    await execute(); assert.equal(prompts, 0);
    const sessionId = gateway.protocol.store.get(thread.id).nativeSessionId;
    const switched = await call("thread/settings/update", { threadId: thread.id, model: "antigravity/gemini-b" });
    assert.equal(switched.thread.reasoningEffort, "high");
    assert.equal(switched.thread.cliApprovalMode, "auto");
    await gateway.close(); gateway = await startGateway(config);
    const resumed = await call("thread/resume", { threadId: thread.id });
    assert.equal(resumed.thread.cliApprovalMode, "auto");
    assert.equal(resumed.thread.model, "antigravity/gemini-b");
    await execute(); assert.equal(prompts, 0);
    assert.equal(gateway.protocol.store.get(thread.id).nativeSessionId, sessionId);
    assert.equal(f.calls().filter(c => c.method === "session/set_config_option" && c.params.configId === "model-choice").at(-1).params.value, "gemini-b");
    await call("thread/settings/update", { threadId: thread.id, cliApprovalMode: "ask" });
    await execute(); assert.equal(prompts, 1);
  } finally { await gateway.close(); }
});
test("Antigravity cancellation, unavailable model and unknown runtime never retry or submit a replacement", async t => {
  const f = fixture(t), controller = new AbortController(); let timer;
  try { await f.engine.run({ model: "gemini-a", cwd: f.cliHome, prompt: "wait", signal: controller.signal,
    onSession() { timer = setTimeout(() => controller.abort(), 50); }, onText() { assert.fail(); } }); }
  finally { clearTimeout(timer); }
  assert.ok(f.calls().some(c => c.method === "session/cancel"));
  const bad = fixture(t);
  await assert.rejects(bad.engine.run({ model: "missing", cwd: bad.cliHome, signal: new AbortController().signal, onSession() {} }), /no fallback/);
  assert.ok(bad.calls().every(c => c.method !== "session/prompt"));
  await assert.rejects(fixture(t, { FIXTURE_VERSION: "9.0.0" }).engine.models(), /verified 1.4.4/);
});
test("Antigravity uses a private subscription profile, excludes ambient API credentials and preserves explicit proxy choices", () => {
  assert.throws(() => assertAntigravityAccount(path.join(os.tmpdir(), "missing-owned-antigravity-profile")), /尚未登录/);
  const inherited = { HOME: "/original", GEMINI_API_KEY: "fixture", GOOGLE_APPLICATION_CREDENTIALS: "/fixture", AGY_OTHER: "fixture", MYCODEX_GOOGLE_TOKEN: "fixture" };
  const env = antigravityEnvironment(inherited, { cliHome: "/private-google", harnessPath: "/matched/harness" }, {});
  assert.equal(env.HOME, "/original"); assert.equal(env.GEMINI_API_KEY, undefined); assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(env.AGY_OTHER, undefined); assert.equal(env.MYCODEX_GOOGLE_TOKEN, undefined); assert.equal(env.GEMINI_HOME, "/private-google");
  const inspect = () => ({ status: 0, stdout: "<dictionary> {\n HTTPSProxy : 127.0.0.1\n HTTPSPort : 1234\n HTTPSEnable : 1\n}" });
  assert.equal(macHttpsProxy({}, { platform: "darwin", inspect }).https_proxy, "http://127.0.0.1:1234");
  assert.deepEqual(macHttpsProxy({ ALL_PROXY: "socks5://explicit:1234" }, { platform: "darwin", inspect }), {});
});
