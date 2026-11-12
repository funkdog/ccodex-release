import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { AppServerRouter } from "../gateway/router.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { readMessages, writeMessage } from "../gateway/ipc.mjs";
import { startGateway } from "../gateway/server.mjs";
test("native event hooks never delay responses and never sample token deltas or gateway-owned conversations", async () => {
  const id = randomUUID(), responses = [], samples = [], warnings = [];
  let native;
  native = new RpcPeer(message => queueMicrotask(() => native.receive({ id: message.id, result: message.method === "initialize" ? { userAgent: "fixture" } : { thread: { id, name: "Native", cwd: "/fixture", modelProvider: "openai" }, model: "real-native-model" } })));
  const router = new AppServerRouter({ native, connectGateway: async () => { throw new Error("not needed"); }, ownsThread: () => null, cursorSecret: randomUUID(), send: message => responses.push(message), warn: message => warnings.push(message), onNativeEvent: event => { samples.push(event); if (event.method === "thread/start") return new Promise(() => {}); throw new Error("observer failure"); } });
  await router.receive({ id: 1, method: "initialize", params: { clientInfo: { name: "fixture", version: "1" } } });
  await router.receive({ id: 2, method: "thread/start", params: { cwd: "/fixture" } }); assert.equal(responses.at(-1).result.thread.id, id);
  for (let i = 0; i < 100 && !samples.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(samples[0].model, "real-native-model");
  native.receive({ method: "item/agentMessage/delta", params: { threadId: id, delta: "token-data-not-sampled" } });
  native.receive({ method: "turn/completed", params: { threadId: id, turn: { id: randomUUID(), status: "completed" }, token: "credential-not-sampled" } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(samples.length, 2); assert.doesNotMatch(JSON.stringify(samples), /token-data|credential-not/); assert.ok(warnings.length);
  const before = samples.length; router.ownsThread = () => ({ engineId: "copilot" }); native.receive({ method: "thread/started", params: { thread: { id } } }); await new Promise(resolve => setImmediate(resolve)); assert.equal(samples.length, before); await router.close();
});
test("installed Codex lifecycle is copied through authenticated IPC to Spine without a model turn or live UI", { timeout: 15000 }, async t => {
  const executable = process.env.MYCODEX_TEST_NATIVE_CLI ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  if (!fs.existsSync(executable)) { t.skip("Set MYCODEX_TEST_NATIVE_CLI to exercise the installed native transport."); return; }
  const home = fs.mkdtempSync("/private/tmp/mc-native-p2-"), profile = path.join(home, "native-profile"); fs.mkdirSync(profile, { mode: 0o700 });
  const config = { home, endpoint: path.join(home, "s"), token: randomUUID(), generation: "fixture", spine: { mcp: true, eventTap: true }, defaultEngine: "fixture", engines: new Map() };
  const gateway = await startGateway(config), file = path.join(home, "connection.json"); fs.writeFileSync(file, JSON.stringify({ ...config, engines: [] }), { mode: 0o600 });
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../gateway/routed-stdio.mjs"), "app-server"], { cwd: home, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: profile, CCODEX_NATIVE_CLI: executable, CCODEX_GATEWAY_CONNECTION: file }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; }); const peer = new RpcPeer(message => writeMessage(child.stdin, message)); readMessages(child.stdout, message => peer.receive(message), error => peer.close(error));
  const exited = new Promise(resolve => child.once("exit", code => { peer.close(new Error(`Isolated native exited (${code}): ${stderr}`)); resolve(code); }));
  t.after(async () => { child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 2000); await exited; clearTimeout(timer); peer.close(); await gateway.close(); fs.rmSync(home, { force: true, recursive: true }); });
  await peer.request("initialize", { clientInfo: { name: "mycodex_native_fixture", version: "1" }, capabilities: { experimentalApi: true } }, { timeoutMs: 5000 }); peer.notify({ method: "initialized" });
  const started = await peer.request("thread/start", { cwd: home }, { timeoutMs: 5000 });
  const trace = path.join(home, "gateway/spine/trace", started.thread.id + ".json"); let record;
  for (let i = 0; i < 100; i++) { if (fs.existsSync(trace)) { record = JSON.parse(fs.readFileSync(trace, "utf8")); if (record.model && record.cwd === home) break; } await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(record?.threadId, started.thread.id, stderr); assert.equal(record?.cwd, home); assert.equal(record?.model, started.model); assert.equal(fs.readdirSync(path.join(home, "gateway/threads")).length, 0);
});
