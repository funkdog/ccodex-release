import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { startGateway } from "../gateway/server.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { readMessages, writeMessage } from "../gateway/ipc.mjs";
import { presentDesktopStatus, createStatusNotifier } from "../bridge/desktop-status.mjs";
import * as gatewayUi from "../bridge/desktop-gateway-ui.mjs";
import { connectGateway } from "../gateway/ipc.mjs";

test("the UI helper binds the launch configuration rather than a retained IPC generation", () => {
  const check = gatewayUi.assertGatewayUiConfiguration;
  assert.equal(typeof check, "function", "The helper needs a shared, testable startup binding check");
  assert.doesNotThrow(() => check({ generation: "original", frontend: "routed-stdio.mjs" }, "original"));
  const retained = { generation: "original", configGeneration: "with-claude", frontend: "routed-stdio.mjs" };
  assert.doesNotThrow(() => check(retained, "with-claude"));
  assert.throws(() => check(retained, "original"), /matching routed gateway/);
  assert.throws(() => check(retained, "other-config"), /matching routed gateway/);
  assert.throws(() => check({ ...retained, frontend: "stdio.mjs" }, "with-claude"), /matching routed gateway/);
  assert.throws(() => check({ ...retained, configGeneration: "" }, ""), /matching routed gateway/);
});

test("a post-upgrade helper accepts the new configuration while IPC authenticates the unchanged transport", async t => {
  const check = gatewayUi.assertGatewayUiConfiguration;
  assert.equal(typeof check, "function");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mc-ui-binding-"));
  const config = { home: root, endpoint: path.join(root, "s"), token: randomUUID(),
    generation: "original-transport", configGeneration: "app-after-cli-addition", frontend: "routed-stdio.mjs" };
  const gateway = await startGateway({ ...config, engines: new Map() });
  let socket;
  t.after(async () => { socket?.destroy(); await gateway.close(); fs.rmSync(root, { recursive: true, force: true }); });
  check(config, "app-after-cli-addition");
  socket = await connectGateway(config);
  assert.equal(socket.destroyed, false);
  await assert.rejects(connectGateway({ ...config, generation: config.configGeneration }));
  assert.equal(config.generation, "original-transport");
});

const executable = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const frontend = path.resolve(import.meta.dirname, "../gateway/routed-stdio.mjs");

// Mandatory Mac upgrade gate: the installed native CLI and the actual routed
// frontend must work with no renderer helper, private exports or CDP at all.
test("an unsupported or failed page cannot remove catalog selection, send or cold continuation", {
  skip: process.platform !== "darwin", timeout: 30000,
}, async t => {
  assert.ok(fs.existsSync(executable), "Mac upgrade acceptance requires the installed native CLI; missing evidence is not a pass");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mycodex-upgrade-gate-"));
  fs.chmodSync(root, 0o700);
  const profile = path.join(root, "profile"), workspace = path.join(root, "workspace");
  for (const directory of [profile, workspace]) fs.mkdirSync(directory, { mode: 0o700 });
  const original = 'model = "native-default-fixture"\ncli_auth_credentials_store = "file"\n[analytics]\nenabled = false\n';
  fs.writeFileSync(path.join(profile, "config.toml"), original, { mode: 0o600 });
  const sessions = new Map(); let calls = 0;
  const engine = { approvalModes: ["deny"],
    models: async () => [{ id: "continuity", name: "Synthetic upgrade gate", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" }],
    run: async ({ prompt, nativeSessionId, onSession, onText }) => {
      calls++;
      if (!nativeSessionId) {
        assert.equal(prompt, "Remember UPGRADE_CONTEXT. Reply FIRST_OK.");
        sessions.set("synthetic-cli-session", "UPGRADE_CONTEXT"); onSession("synthetic-cli-session"); onText("FIRST_OK");
      } else {
        assert.equal(nativeSessionId, "synthetic-cli-session"); assert.equal(prompt, "Repeat the previous nonce.");
        onText(sessions.get(nativeSessionId));
      }
    } };
  const token = randomUUID();
  const gateway = await startGateway({ home: path.join(root, "enhancement"), endpoint: path.join(root, "s"),
    token, generation: "isolated-upgrade-gate", engines: new Map([["copilot", engine]]), defaultEngine: "copilot" });
  const file = path.join(root, "connection.json");
  fs.writeFileSync(file, JSON.stringify({ home: path.join(root, "enhancement"), endpoint: path.join(root, "s"),
    token, generation: "isolated-upgrade-gate" }), { mode: 0o600 });
  let child, peer, exit;
  const completed = new Map();
  async function close() {
    if (!child) return;
    child.stdin.end();
    const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
    try { await exit; } finally { clearTimeout(kill); peer.close(); child = undefined; }
  }
  t.after(async () => { await close(); await gateway.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function connect() {
    child = spawn(process.execPath, [frontend, "app-server"], {
      cwd: workspace, env: { HOME: root, CODEX_HOME: profile, PATH: process.env.PATH,
        CCODEX_NATIVE_CLI: executable, CCODEX_GATEWAY_CONNECTION: file }, stdio: ["pipe", "pipe", "pipe"] });
    let error = ""; child.stderr.on("data", data => { error += data; });
    peer = new RpcPeer(message => writeMessage(child.stdin, message));
    readMessages(child.stdout, message => peer.receive(message), failure => peer.close(failure));
    peer.onNotification = message => { if (message.method === "turn/completed") completed.set(message.params.turn.id, message.params.turn); };
    exit = new Promise(resolve => child.once("exit", code => { peer.close(new Error(`Isolated frontend exited ${code}: ${error}`)); resolve(code); }));
    await peer.request("initialize", { clientInfo: { name: "upgrade_continuity_gate", version: "1" }, capabilities: { experimentalApi: true } }, { timeoutMs: 10000 });
    peer.notify({ method: "initialized" });
  }
  async function turn(threadId, text) {
    const { turn } = await peer.request("turn/start", { threadId, input: [{ type: "text", text }] });
    const deadline = Date.now() + 5000;
    while (!completed.has(turn.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(completed.get(turn.id)?.status, "completed");
    return completed.get(turn.id);
  }
  await connect();
  const model = "mycodex/copilot/continuity";
  let now = 0;
  const notice = createStatusNotifier({ now: () => now });
  for (const uiState of ["unsupported", "unavailable"]) {
    const status = presentDesktopStatus({ action: "activate-existing", backendState: "ready", uiState });
    assert.equal(status.features[0].state, "ready"); assert.equal(status.level, "warning");
    assert.equal(notice(status), uiState === "unsupported" ? "degraded" : null);
    const catalog = await peer.request("model/list", { limit: 1000 });
    assert.ok(catalog.data.some(row => row.model === model), "The native picker still receives the external model");
    const selected = await peer.request("config/batchWrite", { edits: [
      { keyPath: "model", value: model, mergeStrategy: "upsert" },
      { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" },
    ], filePath: null, expectedVersion: null, reloadUserConfig: true });
    assert.equal(selected.status, "okOverridden");
    assert.equal(fs.readFileSync(path.join(profile, "config.toml"), "utf8"), original);
  }
  const { thread } = await peer.request("thread/start", { model, cwd: workspace, effort: "high", cliApprovalMode: "deny" });
  assert.ok((await turn(thread.id, "Remember UPGRADE_CONTEXT. Reply FIRST_OK.")).items.some(item => item.type === "agentMessage" && item.text === "FIRST_OK"));
  await close(); await connect();
  const resumed = await peer.request("thread/resume", { threadId: thread.id });
  assert.equal(resumed.thread.model, model); assert.equal(resumed.thread.reasoningEffort, "high");
  assert.equal(resumed.thread.cliApprovalMode, "deny"); assert.equal(resumed.thread.turns.length, 1);
  assert.ok((await turn(thread.id, "Repeat the previous nonce.")).items.some(item => item.type === "agentMessage" && item.text === "UPGRADE_CONTEXT"));
  assert.equal(calls, 2); assert.deepEqual(fs.readdirSync(workspace), []);
  assert.equal(fs.readFileSync(path.join(profile, "config.toml"), "utf8"), original);
  const healthy = presentDesktopStatus({ action: "activate-existing", backendState: "ready", uiState: "ready" });
  assert.equal(notice(healthy), null); now += 30000;
  assert.equal(notice(healthy), "recovered");
});
