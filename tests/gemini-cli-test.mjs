import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { geminiCliEngine, geminiEnvironment, assertGeminiAccount } from "../gateway/engines/gemini-cli.mjs";

function fixture(t) {
  const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gemini-acp-"));
  t.after(() => fs.rmSync(cliHome, { recursive: true, force: true }));
  const engine = geminiCliEngine({ cliHome, executable: path.resolve("tests/fixtures/gemini-acp.mjs"), env: {}, accountCheck: () => {} });
  return { cliHome, engine };
}
test("Gemini's own catalog, image stream and cold resume preserve identity without replaying history as new output", async t => {
  const { cliHome, engine } = fixture(t);
  assert.deepEqual((await engine.models()).map(m => [m.id, m.inputModalities]), [["gemini-fixture", ["text", "image"]]]);
  let sessionId; const text = [];
  const options = { model: "gemini-fixture", cwd: cliHome, signal: new AbortController().signal,
    onSession: value => { if (sessionId) assert.equal(value, sessionId); sessionId = value; }, onText: value => text.push(value) };
  await engine.run({ ...options, prompt: "text", attachments: [{ type: "blob", data: "fixture", mimeType: "image/png" }] });
  await engine.run({ ...options, prompt: "second", nativeSessionId: sessionId });
  assert.deepEqual(text, ["IMAGE_OK", "TEXT_OK"]);
});
test("Gemini forwards one-shot permission approval, honors deny and acknowledges cancellation", async t => {
  const { cliHome, engine } = fixture(t); let asks = 0;
  const run = async mode => {
    let text = "";
    await engine.run({ model: "gemini-fixture", cwd: cliHome, prompt: "permission", signal: new AbortController().signal,
      onSession() {}, onText: value => text += value, getApprovalMode: () => mode,
      ask: async () => { asks++; return { answers: { permission: { answers: ["Allow once"] } } }; } });
    return text;
  };
  assert.equal(await run("ask"), "Approved"); assert.equal(asks, 1);
  assert.equal(await run("deny"), "Denied"); assert.equal(asks, 1);
  const controller = new AbortController(); let timer;
  try { await engine.run({ model: "gemini-fixture", cwd: cliHome, prompt: "wait", signal: controller.signal,
    onSession() { timer = setTimeout(() => controller.abort(), 50); }, onText() { assert.fail("Cancelled turn emitted text"); } }); }
  finally { clearTimeout(timer); }
});
test("Google subscription engine rejects missing OAuth and does not inherit API-key or native routing credentials", () => {
  assert.throws(() => assertGeminiAccount(path.join(os.tmpdir(), "nonexistent-gemini-account-profile")), /尚未登录/);
  const env = geminiEnvironment({ HOME: "/home", PATH: "/bin", GEMINI_API_KEY: "fixture-key", GOOGLE_API_KEY: "fixture-key",
    GOOGLE_APPLICATION_CREDENTIALS: "/fixture", CCODEX_GATEWAY_CONNECTION: "/fixture", NODE_OPTIONS: "fixture" }, "/private-google");
  assert.equal(env.GEMINI_API_KEY, undefined); assert.equal(env.GOOGLE_API_KEY, undefined);
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined); assert.equal(env.CCODEX_GATEWAY_CONNECTION, undefined);
  assert.equal(env.GEMINI_CLI_HOME, "/private-google"); assert.equal(env.HOME, "/home");
});
