import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { connectionModels, checkAdapterModel } from "../tools/adapter-connection.mjs";
import { claudeCodeEngine } from "../gateway/engines/claude-code.mjs";

const config = { id: "own", adapter: "claude-code", enabledModels: ["already-enabled"] };
const factory = engine => async configs => {
  assert.equal(configs[0].enabledModels, undefined, "discovery is separate from menu selection");
  return new Map([["own", engine]]);
};
const models = async () => [{ id: "chosen" }, { id: "other" }];
const reply = context => context.onText(context.prompt.match(/MYCODEX_CONNECTION_[a-f0-9]+/)[0]);

test("discovery never sends inference and consent is required before connecting for a check", async () => {
  let calls = 0;
  const create = factory({ models, run() { calls++; } });
  assert.equal((await connectionModels(config, { factory: create })).length, 2);
  await assert.rejects(checkAdapterModel(config, "chosen", { factory() { calls++; } }), /明确同意/);
  assert.equal(calls, 0);
});

test("checks run only the selected model in an empty temporary workspace and clean it afterwards", async () => {
  let workspace, runs = 0;
  const result = await checkAdapterModel(config, "chosen", { approved: true, factory: factory({ models, async run(context) {
    runs++; workspace = context.cwd;
    assert.equal(context.model, "chosen");
    assert.equal(context.verification, true);
    assert.equal(context.getApprovalMode(), "deny");
    assert.equal(await context.ask(), null);
    assert.deepEqual(fs.readdirSync(workspace), []);
    reply(context);
  } }) });
  assert.equal(result.inferenceVerified, true);
  assert.equal(result.modelId, "chosen");
  assert.equal(runs, 1);
  assert.equal(fs.existsSync(workspace), false);
});

test("unavailable models, invalid replies, tool use and provider errors fail without exposing raw diagnostics", async () => {
  await assert.rejects(checkAdapterModel(config, "missing", { approved: true, factory: factory({ models, run() { assert.fail("must not run"); } }) }), /候选目录/);
  for (const run of [context => context.onText("wrong reply"), context => { context.onTool({}); reply(context); }, () => { throw new Error("provider echoed synthetic-secret"); }]) {
    await assert.rejects(checkAdapterModel(config, "chosen", { approved: true, factory: factory({ models, run }) }), error => /未|没有/.test(error.message) && !error.message.includes("synthetic-secret"));
  }
});

test("timed-out discovery cannot send a late inference after it eventually resolves", async () => {
  let release, runs = 0;
  const pending = new Promise(resolve => { release = resolve; });
  await assert.rejects(checkAdapterModel(config, "chosen", { approved: true, timeoutMs: 10,
    factory: factory({ models: () => pending, run() { runs++; } }) }), /超时/);
  release(await models());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs, 0);
});

test("Claude verification disables tools, settings hooks and session persistence", async () => {
  let options;
  const engine = claudeCodeEngine({ env: {}, sdk: { query(input) {
    options = input.options;
    return { close() {}, async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", result: "ok" }; } };
  } } });
  await engine.run({ verification: true, model: "chosen", prompt: "check", signal: new AbortController().signal,
    onSession() {}, onText() {}, getApprovalMode: () => "deny", ask: async () => null });
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.maxTurns, 1);
});
