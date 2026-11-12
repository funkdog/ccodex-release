import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-request-status-"));
process.env.CODEX_COPILOT_HOME = home;
const { startRequestAudit, THREAD_STATUS_DIR } = await import("../bridge/request-audit.mjs");
const read = (thread) => JSON.parse(fs.readFileSync(path.join(THREAD_STATUS_DIR, `${thread}.json`), "utf8"));
const begin = (threadId, requestedModel = "gpt-test") => startRequestAudit({
  threadId,
  account: "fixture-user",
  accountGeneration: "fixture-generation",
  requestedModel,
  upstreamModel: requestedModel,
  request: { reasoning: { effort: "high" }, input: [{ text: "private fixture prompt" }] },
});

test("request status is isolated by thread and carries account provenance", () => {
  const first = begin("thread-one");
  const second = begin("thread-two", "other-model");
  first.complete({ usage: { input_tokens: 100, output_tokens: 20 } });
  assert.equal(read("thread-one").status, "complete");
  assert.equal(read("thread-two").status, "started");
  assert.equal(read("thread-one").accountGeneration, "fixture-generation");
  assert.equal(read("thread-two").requestedModel, "other-model");
  assert.doesNotMatch(JSON.stringify(read("thread-one")), /private fixture prompt/);
  second.complete();
});

test("late completion cannot replace a newer request in the same thread", () => {
  const older = begin("thread-overlap", "older-model");
  const newer = begin("thread-overlap", "newer-model");
  older.complete();
  assert.equal(read("thread-overlap").id, newer.id);
  assert.equal(read("thread-overlap").status, "started");
  newer.complete();
  assert.equal(read("thread-overlap").status, "complete");
});

test("elapsed time measures the whole logical request and matches its timestamps", async () => {
  const audit = begin("thread-elapsed");
  assert.equal(read("thread-elapsed").elapsedMs, null);
  await new Promise(resolve => setTimeout(resolve, 30));
  audit.complete({ elapsedMs: -1, attempts: 3 });
  const result = read("thread-elapsed");
  assert.ok(result.elapsedMs >= 30);
  assert.equal(result.elapsedMs, Date.parse(result.completedAt) - Date.parse(result.startedAt));
  assert.equal(result.attempts, 3);
});

test("untrusted thread identifiers cannot create paths outside the status directory", () => {
  const before = fs.readdirSync(THREAD_STATUS_DIR);
  for (const thread of ["../escape", "..", "/absolute", "x\\escape", "x/y", "x".repeat(129)]) {
    begin(thread).complete();
  }
  assert.deepEqual(fs.readdirSync(THREAD_STATUS_DIR), before);
  assert.equal(fs.existsSync(path.join(home, "escape.json")), false);
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
