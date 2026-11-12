import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { startGateway } from "../gateway/server.mjs";
import { readMessages, writeMessage } from "../gateway/ipc.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";

const frontend = path.resolve(import.meta.dirname, "../gateway/routed-stdio.mjs");
const nativeFixture = path.resolve(import.meta.dirname, "fixtures/native-app-server.mjs");
test("routed stdio preserves native profile and runs an external turn through the real shared IPC", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rt-"));
  const nativeHome = path.join(home, "native-profile");
  fs.mkdirSync(nativeHome);
  const config = { home: path.join(home, "enhancement"), endpoint: path.join(home, "s"), token: randomUUID(), generation: "test",
    defaultEngine: "claude", engines: new Map([["claude", { models: async () => [{ id: "fixture" }],
      run: async ({ onSession, onText }) => { onSession("synthetic-native-cli"); onText("synthetic response"); } }]]) };
  const server = await startGateway(config);
  const file = path.join(home, "connection.json");
  fs.writeFileSync(file, JSON.stringify({ ...config, engines: undefined }), { mode: 0o600 });
  const env = { HOME: home, PATH: process.env.PATH, CODEX_HOME: nativeHome,
    CODEX_CLI_PATH: frontend, TEST_CCODEX_NATIVE_PROCESS: "test-only", CCODEX_NATIVE_CLI: process.execPath,
    CCODEX_GATEWAY_CONNECTION: file };
  const child = spawn(process.execPath, [frontend, nativeFixture, "app-server"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", bytes => { stderr += bytes; });
  const peer = new RpcPeer(message => writeMessage(child.stdin, message));
  readMessages(child.stdout, message => peer.receive(message), error => peer.close(error));
  let completed;
  const done = new Promise(resolve => { completed = resolve; });
  peer.onNotification = message => { if (message.method === "turn/completed") completed(message); };
  const exited = new Promise(resolve => child.once("exit", code => { peer.close(); resolve(code); }));
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 6000);
    try { await exited; } finally { clearTimeout(timer); await server.close(); fs.rmSync(home, { recursive: true, force: true }); }
  });
  const init = await peer.request("initialize", { clientInfo: { name: "test", version: "1" } }, { timeoutMs: 5000 });
  assert.equal(init.userAgent, "native-fixture");
  assert.equal(init.codexHome, nativeHome);
  assert.deepEqual(await peer.request("fixture/environment", {}), { codeHome: nativeHome, home, cliOverride: null, connection: null });
  const models = await peer.request("model/list", {});
  assert.deepEqual(models.data.map(model => model.model), ["native-model", "mycodex/claude/fixture"]);
  const { thread } = await peer.request("thread/start", { model: "mycodex/claude/fixture", cwd: home });
  await peer.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "synthetic" }] });
  const timer = setTimeout(() => completed(null), 5000);
  const result = await done; clearTimeout(timer);
  assert.equal(result?.params.turn.status, "completed", stderr);
  const read = await peer.request("thread/read", { threadId: thread.id });
  assert.equal(read.thread.model, "mycodex/claude/fixture");
  assert.equal(read.thread.turns[0].items.at(-1).text, "synthetic response");
  assert.deepEqual(fs.readdirSync(nativeHome), []);
});
test("version and startup preflight are supplied by the original CLI without requiring a gateway", () => {
  for (const arg of ["--version", "--print-startup-config"]) {
    const result = spawnSync(process.execPath, [frontend, nativeFixture, arg], {
      env: { CCODEX_NATIVE_CLI: process.execPath, TEST_CCODEX_NATIVE_PROCESS: "test-only", PATH: process.env.PATH }, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /native-fixture/);
  }
});
test("an executable pointing back to the frontend is rejected before recursion", () => {
  const result = spawnSync(process.execPath, [frontend, "app-server"], {
    env: { CCODEX_NATIVE_CLI: process.execPath, CODEX_CLI_PATH: process.execPath }, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /point back/);
});

test("Local Work exec-server bypass preserves arguments, stdin, output, exit and native environment without a gateway", () => {
  const args = [nativeFixture, "-c", 'forced_login_method="chatgpt"', "exec-server", "--remote", "ws://fixture", "--environment-id", "local"];
  const result = spawnSync(process.execPath, [frontend, ...args], {
    env: { CCODEX_NATIVE_CLI: process.execPath, TEST_CCODEX_NATIVE_PROCESS: "test-only", PATH: process.env.PATH,
      HOME: "/fixture-home", CODEX_HOME: "/fixture-profile", CODEX_CLI_PATH: frontend,
      CCODEX_GATEWAY_CONNECTION: "/does-not-exist", CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE: "1" },
    input: "executor input\n", encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 7, result.stderr);
  assert.equal(result.stderr, "native executor stderr\n");
  assert.deepEqual(JSON.parse(result.stdout), { input: "executor input\n", args: args.slice(1),
    home: "/fixture-home", codeHome: "/fixture-profile", executorFlag: "1", recursive: null, gateway: null });
});

test("native app-server exit closes the frontend without retrying or leaving an idle wrapper", { timeout: 10000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rt-crash-"));
  const file = path.join(home, "connection.json");
  fs.writeFileSync(file, JSON.stringify({ home, endpoint: path.join(home, "unused"), token: randomUUID(), generation: "test" }), { mode: 0o600 });
  const child = spawn(process.execPath, [frontend, nativeFixture, "app-server"], {
    env: { HOME: home, PATH: process.env.PATH, TEST_CCODEX_NATIVE_PROCESS: "test-only",
      CCODEX_NATIVE_CLI: process.execPath, CCODEX_GATEWAY_CONNECTION: file }, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const peer = new RpcPeer(message => writeMessage(child.stdin, message));
  readMessages(child.stdout, message => peer.receive(message), error => peer.close(error));
  const exited = new Promise(resolve => child.once("exit", code => { peer.close(); resolve(code); }));
  t.after(async () => { child.stdin.end(); child.kill("SIGKILL"); await exited; fs.rmSync(home, { recursive: true, force: true }); });
  await peer.request("initialize", { clientInfo: { name: "test", version: "1" } }, { timeoutMs: 5000 });
  await assert.rejects(peer.request("fixture/crash", {}, { timeoutMs: 5000 }), /disconnected/);
  assert.equal(await exited, 1);
  assert.deepEqual(fs.readdirSync(home), ["connection.json"]);
});
