import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isOwnedCdpListener, probeEnvironment, summarizeTrace } from "../tools/probe-desktop-app-server.mjs";

const fixture = fileURLToPath(new URL("./fixtures/desktop-app-server-probe.mjs", import.meta.url));
test("UI probe refuses a listener owned by another process", () => {
  assert.equal(isOwnedCdpListener("p123\n", 123), true);
  assert.equal(isOwnedCdpListener("p123\np123\n", 123), true);
  assert.equal(isOwnedCdpListener("p123\nf78\np124\nf78\n", 123, [123, 124]), true);
  assert.equal(isOwnedCdpListener("p123\nf78\np456\nf78\n", 123, [123, 124]), false);
  assert.equal(isOwnedCdpListener("p123\np456\n", 123), false);
  assert.equal(isOwnedCdpListener("p456\n", 123), false);
  assert.equal(isOwnedCdpListener("", 123), false);
});
function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-probe-test-"));
  fs.mkdirSync(path.join(root, "profile"));
  fs.mkdirSync(path.join(root, "workspace"));
  fs.writeFileSync(path.join(root, ".ccodex-probe"), "test");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(root, requests = [], args = ["app-server"], envPatch = {}) {
  return spawnSync(process.execPath, [fixture, ...args], {
    env: { ...probeEnvironment(root), ...envPatch },
    input: requests.map(request => JSON.stringify(request)).join("\n") + "\n",
    encoding: "utf8", timeout: 5000,
  });
}
function messages(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("probe keeps HOME but strips credentials and preexisting backend overrides", () => {
  const root = path.resolve(os.tmpdir(), "isolated-probe");
  const env = probeEnvironment(root, { HOME: "/home/example", PATH: "/bin", OPENAI_API_KEY: "private",
    GITHUB_TOKEN: "private", CODEX_HOME: "/existing", CODEX_CLI_PATH: "/existing-cli",
    CODEX_APP_SERVER_USE_LOCAL_DAEMON: "1", NODE_OPTIONS: "--require private-hook" });
  assert.equal(env.HOME, "/home/example");
  assert.equal(env.CODEX_HOME, path.join(root, "profile"));
  assert.equal(env.CODEX_APP_SERVER_FORCE_CLI, "1");
  for (const key of ["OPENAI_API_KEY", "GITHUB_TOKEN", "NODE_OPTIONS", "CODEX_APP_SERVER_USE_LOCAL_DAEMON"]) {
    assert.equal(env[key], undefined);
  }
  assert.throws(() => probeEnvironment("relative"), /absolute/);
});

test("fixture refuses a default profile and refuses an unmarked directory", t => {
  const root = profile(t);
  assert.equal(run(root, [], ["app-server"], { CODEX_HOME: path.join(root, "other") }).status, 2);
  fs.unlinkSync(path.join(root, ".ccodex-probe"));
  assert.equal(run(root).status, 2);
  assert.equal(fs.existsSync(path.join(root, "rpc-shapes.jsonl")), false);
});

test("startup handles leading config overrides without logging their contents", t => {
  const root = profile(t);
  const result = run(root, [], ["-c", 'private="DO_NOT_LOG_THIS"', "app-server", "--analytics-default-enabled",
    "--print-startup-config", "--startup-client-info", '{"private":"DO_NOT_LOG_THIS"}']);
  assert.equal(JSON.parse(result.stdout).configRequirements.requirements, null);
  assert.equal(result.status, 0);
  assert.ok(!fs.readFileSync(path.join(root, "rpc-shapes.jsonl"), "utf8").includes("DO_NOT_LOG_THIS"));
  assert.equal(run(root, [], ["app-server", "--startup-sign-out", "--print-startup-config"]).status, 2);
});

test("handshake exposes fixture models and explicitly unauthenticated local execution", t => {
  const root = profile(t);
  const replies = messages(run(root, ["initialize", "getAuthStatus", "account/read", "model/list"]
    .map((method, id) => ({ id, method, params: {} }))));
  assert.equal(replies[0].result.codexHome, path.join(root, "profile"));
  assert.deepEqual(replies[1].result, { authMethod: null, authToken: null, requiresOpenaiAuth: false });
  assert.deepEqual(replies[2].result, { account: null, requiresOpenaiAuth: false });
  assert.match(replies[3].result.data[0].displayName, /fixture/);
});

test("history hydration and deterministic native turn produce ordered lifecycle events", t => {
  const root = profile(t);
  const threadId = "019a0000-0000-7000-8000-000000000001";
  const requests = ["thread/read", "thread/resume", "thread/turns/list", "thread/items/list"]
    .map((method, id) => ({ id, method, params: { threadId } }));
  requests.push({ id: 4, method: "turn/start", params: { threadId,
    input: [{ type: "text", text: "CCODEX_R0_SYNTHETIC_PING" }] } });
  const replies = messages(run(root, requests));
  for (const reply of replies.filter(m => Object.hasOwn(m, "id"))) assert.equal(reply.error, undefined);
  assert.deepEqual(replies.filter(m => m.method).map(m => m.method), [
    "turn/started", "item/started", "item/agentMessage/delta", "item/completed", "turn/completed", "thread/status/changed",
  ]);
  const completion = replies.find(reply => reply.method === "turn/completed");
  assert.equal(completion.params.turn.status, "completed");
  assert.match(completion.params.turn.items[0].text, /CCODEX_R0_SYNTHETIC_OK/);
  assert.equal(replies.at(-1).params.status.type, "idle");
  const trace = fs.readFileSync(path.join(root, "rpc-shapes.jsonl"), "utf8");
  assert.ok(!trace.includes("CCODEX_R0_SYNTHETIC_PING"));
  assert.equal(summarizeTrace(trace.trim().split("\n").map(JSON.parse)).syntheticCompletions, 1);
});

test("unknown methods, threads and real prompts fail without successful turn events", t => {
  const root = profile(t);
  const replies = messages(run(root, [
    { id: 1, method: "unknown", params: { secret: "PRIVATE_PROMPT" } },
    { id: 2, method: "thread/resume", params: { threadId: "other" } },
    { id: 3, method: "turn/start", params: { threadId: "019a0000-0000-7000-8000-000000000001",
      input: [{ type: "text", text: "PRIVATE_PROMPT" }] } },
  ]));
  assert.deepEqual(replies.map(m => m.error.code), [-32601, -32602, -32602]);
  assert.ok(!fs.readFileSync(path.join(root, "rpc-shapes.jsonl"), "utf8").includes("PRIVATE_PROMPT"));
});

test("Desktop admission extension accepts its request envelope but never replays a turn", t => {
  const root = profile(t);
  const params = { threadId: "019a0000-0000-7000-8000-000000000001", clientUserMessageId: "synthetic-client-id",
    input: [{ type: "text", text: "# My request:\nCCODEX_R0_SYNTHETIC_PING\n" }] };
  const replies = messages(run(root, [1, 2].map(id => ({ id, method: "turn/addUserMessage", params }))));
  assert.equal(replies.find(m => m.id === 1).result.admissionOutcome, "started");
  assert.match(replies.find(m => m.id === 2).error.message, /only one/);
  assert.equal(replies.filter(m => m.method === "turn/completed").length, 1);
});

test("connection summary counts distinct initialized processes, not repeated requests", () => {
  const trace = [1, 1, 2, 3].map(pid => ({ pid, kind: "rpc", method: "initialize", paramKeys: ["capabilities", "clientInfo"] }));
  const summary = summarizeTrace(trace);
  assert.equal(summary.initializedProcesses, 3);
  assert.equal(summary.methods[0].count, 4);
  assert.equal(summary.syntheticCompletions, 0);
});
