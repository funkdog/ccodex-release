import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { startGateway } from "../gateway/server.mjs";
import { readMessages, writeMessage } from "../gateway/ipc.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";

const root = path.resolve(import.meta.dirname, ".."), cli = path.join(root, "gateway/spine/work-cli.mjs");
function execute(file, args, input = "", env = process.env, sandbox = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(sandbox ? "/usr/bin/sandbox-exec" : process.execPath,
      [...(sandbox ? ["-p", "(version 1) (allow default) (deny network-outbound)", process.execPath] : []), file, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
    child.once("error", reject); child.once("close", code => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}
async function fixture(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mc-work-cli-"));
  const config = { home, endpoint: path.join(home, "s"), token: randomUUID(), generation: "work-cli-test", spine: { mcp: true },
    defaultEngine: "fixture", engines: new Map([["fixture", { models: async () => [], run: async () => { throw new Error("No model calls in work routing tests."); } }]]) };
  const gateway = await startGateway(config), connection = path.join(home, "connection.json");
  fs.writeFileSync(connection, JSON.stringify({ ...config, engines: [] }), { mode: 0o600 });
  t.after(async () => { await gateway.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const run = async (command, params = {}) => {
    const result = await execute(cli, [connection, command], JSON.stringify(params));
    assert.equal(result.stderr, "");
    return { ...result, body: JSON.parse(result.stdout) };
  };
  return { home, connection, config, run };
}
const work = { id: "work-discussion", goalId: "goal-discussion", expectedRevision: 0, title: "产品设计讨论", userIntent: "让小鼠头和工作台围绕同一份工作接续",
  nextStep: { kind: "discussion", description: "比较两条进入工作的动线", owner: "你与小鼠头" },
  context: [{ id: "proposal", kind: "result", title: "入口方案", summary: "浏览与切换讨论分开", state: "candidate", reference: "chat:source/turn-1" }] };

async function intercept(t, fixture, transform) {
  const sockets = new Set(), endpoint = path.join(fixture.home, "proxy");
  const server = net.createServer(client => {
    const upstream = net.createConnection(fixture.config.endpoint); sockets.add(client); sockets.add(upstream);
    const close = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on("error", close); upstream.on("error", close); client.on("close", close); upstream.on("close", close);
    client.pipe(upstream);
    readMessages(upstream, message => { const changed = transform(message); if (changed === null) close(); else writeMessage(client, changed); }, close);
  });
  await new Promise(resolve => server.listen(endpoint, resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const connection = path.join(fixture.home, "proxy.json"); fs.writeFileSync(connection, JSON.stringify({ ...fixture.config, endpoint, engines: [] }), { mode: 0o600 });
  return connection;
}

test("a local executor uses authenticated IPC to register and resume the same non-code work", { timeout: 15000 }, async t => {
  const { run } = await fixture(t);
  const status = await run("status"); assert.equal(status.code, 0); assert.equal(status.body.result.ready, true);
  const goal = await run("goal", { id: work.goalId, title: "改善协作", expectedRevision: 0 }); assert.equal(goal.code, 0);
  assert.equal((await run("goals")).body.result.goals[0].id, work.goalId, "empty goals are discoverable before work exists");
  const saved = await run("record", work); assert.equal(saved.code, 0); assert.equal(saved.body.receipt.id, work.id); assert.equal(saved.body.receipt.revision, 1);
  const continued = await run("context", { id: work.id }); assert.equal(continued.body.result.continuation.userIntent, work.userIntent);
  assert.equal(continued.body.result.continuation.candidates[0].id, "proposal"); assert.deepEqual(continued.body.result.continuation.adopted, []);
  assert.equal((await run("list")).body.result.items[0].id, work.id);
  const adopted = await run("record", { id: work.id, expectedRevision: 1, context: [{ ...work.context[0], state: "adopted", reference: "chat:source/user-accepted" }] });
  assert.equal(adopted.body.receipt.revision, 2);
  const stale = await run("record", { id: work.id, expectedRevision: 1, progress: "覆盖新约定" });
  assert.equal(stale.code, 1); assert.equal(stale.body.outcome, "rejected"); assert.match(stale.body.error, /revision conflict/i);
  const resumed = await run("context", { id: work.id }); assert.equal(resumed.body.result.continuation.adopted[0].reference, "chat:source/user-accepted");
  assert.equal(resumed.body.result.workItem.revision, 2);
});

test("the local entry exposes its bounded schema offline and rejects arbitrary methods or ambiguous writes", { timeout: 10000 }, async t => {
  const { connection, config, run } = await fixture(t);
  const schema = await execute(cli, ["/not/a/connection.json", "describe"]);
  assert.equal(schema.code, 0); assert.ok(JSON.parse(schema.stdout).result.commands.record.inputSchema.properties.context);
  for (const [command, params] of [["diy/work/dispatch", {}], ["record", { ...work, id: undefined }], ["goal", { id: "goal-discussion", title: "不带版本" }], ["status", { extra: true }]]) {
    const result = await run(command, params); assert.equal(result.code, 1); assert.equal(result.body.outcome, "not_sent");
  }
  const tooLarge = await execute(cli, [connection, "record"], JSON.stringify({ ...work, progress: "x".repeat(33000) }));
  assert.equal(tooLarge.code, 1); assert.equal(JSON.parse(tooLarge.stdout).outcome, "not_sent");
  assert.equal((await run("goals")).body.result.goals.length, 0);
  assert.equal(tooLarge.stdout.includes(config.token), false);
});

test("an unavailable connection cannot fall back to another profile or reveal private configuration", async t => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mc-work-disconnected-")); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const connection = path.join(home, "connection.json"), secret = "private-test-token-not-for-output";
  fs.writeFileSync(connection, `{"token":"${secret}",`, { mode: 0o600 });
  const result = await execute(cli, [connection, "record"], JSON.stringify(work));
  assert.equal(result.code, 1); const body = JSON.parse(result.stdout); assert.equal(body.outcome, "not_sent");
  assert.equal((result.stdout + result.stderr).includes(secret), false); assert.deepEqual(fs.readdirSync(home), ["connection.json"]);
});

test("gateway transport diagnostics distinguish a missing socket from a rejected handshake without exposing connection data", { timeout: 10000 }, async t => {
  const f = await fixture(t), connection = path.join(f.home, "unavailable.json");
  const run = async config => {
    fs.writeFileSync(connection, JSON.stringify({ ...config, engines: [] }), { mode: 0o600 });
    const result = await execute(cli, [connection, "status"]);
    assert.equal(result.code, 1); assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(config.token), false); assert.equal(result.stdout.includes(config.endpoint), false);
    return JSON.parse(result.stdout);
  };
  const missing = await run({ ...f.config, endpoint: path.join(f.home, "missing-socket") });
  assert.equal(missing.code, "GATEWAY_ENDPOINT_MISSING"); assert.equal(missing.phase, "connect"); assert.equal(missing.systemCode, "ENOENT"); assert.equal(missing.outcome, "not_sent");
  const rejected = await run({ ...f.config, token: randomUUID() });
  assert.equal(rejected.code, "GATEWAY_HANDSHAKE_FAILED"); assert.equal(rejected.phase, "connect"); assert.equal(rejected.outcome, "not_sent");
  const initialization = await intercept(t, f, message => message.result?.userAgent
    ? { id: message.id, error: { code: -32603, message: `Private server diagnostic ${f.config.token}` } } : message);
  const failed = await execute(cli, [initialization, "status"]), body = JSON.parse(failed.stdout);
  assert.equal(failed.code, 1); assert.equal(body.code, "GATEWAY_INITIALIZE_FAILED"); assert.equal(body.phase, "initialize");
  assert.equal(body.outcome, "not_sent"); assert.equal(failed.stdout.includes(f.config.token), false);
});

test("a macOS command sandbox reports socket access denial while the same live gateway remains healthy", {
  skip: process.platform !== "darwin", timeout: 10000,
}, async t => {
  const f = await fixture(t);
  const blocked = await execute(cli, [f.connection, "status"], "", process.env, true);
  assert.equal(blocked.code, 1); assert.equal(blocked.stderr, "");
  const body = JSON.parse(blocked.stdout);
  assert.equal(body.code, "GATEWAY_ACCESS_DENIED"); assert.equal(body.phase, "connect");
  assert.ok(["EPERM", "EACCES"].includes(body.systemCode)); assert.equal(body.outcome, "not_sent");
  assert.equal(blocked.stdout.includes(f.config.token), false); assert.equal(blocked.stdout.includes(f.config.endpoint), false);
  assert.equal((await f.run("status")).body.result.ready, true, "permission failure cannot imply that the service is down");
  assert.equal((await f.run("list")).body.result.total, 0);
});

test("a lost write reply reports an unknown outcome and never repeats a committed write", { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.run("goal", { id: work.goalId, title: "协作", expectedRevision: 0 });
  let committedReplies = 0;
  const connection = await intercept(t, f, message => { if (message.result?.workItem) { committedReplies++; return null; } return message; });
  const lost = await execute(cli, [connection, "record"], JSON.stringify(work));
  assert.equal(lost.code, 1); assert.equal(JSON.parse(lost.stdout).outcome, "unknown"); assert.equal(committedReplies, 1);
  const reconciled = await f.run("context", { id: work.id });
  assert.equal(reconciled.body.result.workItem.revision, 1, "the caller can reconcile the one saved write by its original stable ID");
});

test("an older running gateway is reported without an attempted write or an automatic restart", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const connection = await intercept(t, f, message => {
    if (message.result?.methods) return { ...message, result: { ...message.result, methods: message.result.methods.filter(method => method !== "diy/work/record") } };
    return message;
  });
  const status = await execute(cli, [connection, "status"]); assert.equal(status.code, 0);
  assert.deepEqual(JSON.parse(status.stdout).result.missingMethods, ["diy/work/record"]);
  const write = await execute(cli, [connection, "record"], JSON.stringify(work));
  assert.equal(write.code, 1); assert.equal(JSON.parse(write.stdout).outcome, "not_sent");
  assert.equal((await f.run("list")).body.result.total, 0);
});

test("skill installation is an explicit output, survives paths with shell characters and preserves foreign files", { timeout: 10000 }, async t => {
  const { home, connection } = await fixture(t), destination = path.join(home, "skills ' $()", "mycodex-workbench");
  const quotedConnection = path.join(home, "connection ' $().json"); fs.copyFileSync(connection, quotedConnection); fs.chmodSync(quotedConnection, 0o600);
  const installer = path.join(root, "tools/install-workbench-skill.mjs");
  const installed = await execute(installer, [quotedConnection, destination]); assert.equal(installed.code, 0, installed.stderr);
  const skill = fs.readFileSync(path.join(destination, "SKILL.md"), "utf8"); assert.match(skill, /mycodex-workbench/);
  const command = skill.match(/<!-- local-command -->\n([^\n]+)/)[1];
  if (process.platform !== "win32") {
    const shell = spawn("/bin/sh", ["-c", command + " status"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; shell.stdout.on("data", data => { output += data; });
    assert.equal(await new Promise(resolve => shell.once("close", resolve)), 0); assert.equal(JSON.parse(output).result.ready, true);
  }
  fs.appendFileSync(path.join(destination, "SKILL.md"), "\nUser-owned edit\n");
  const refused = await execute(installer, [connection, destination]); assert.equal(refused.code, 1);
  assert.match(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8"), /User-owned edit/);
  const foreign = path.join(home, "foreign"); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, "SKILL.md"), "unrelated skill");
  assert.equal((await execute(installer, [connection, foreign])).code, 1); assert.equal(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8"), "unrelated skill");
});

test("the actual native local executor discovers the installed workbench skill without a model turn", { timeout: 15000 }, async t => {
  const executable = process.env.MYCODEX_TEST_NATIVE_CLI ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  if (!fs.existsSync(executable)) { t.skip("Native CLI unavailable; local skill discovery remains unverified."); return; }
  const { home, connection } = await fixture(t), profile = path.join(home, "profile"), destination = path.join(profile, "skills/mycodex-workbench");
  assert.equal((await execute(path.join(root, "tools/install-workbench-skill.mjs"), [connection, destination])).code, 0);
  const child = spawn(executable, ["app-server"], { env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: profile }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", data => { stderr += data; });
  const peer = new RpcPeer(message => writeMessage(child.stdin, message)); readMessages(child.stdout, message => peer.receive(message), error => peer.close(error));
  const exited = new Promise(resolve => child.once("exit", code => { peer.close(new Error(`Native executor exited (${code}): ${stderr}`)); resolve(code); }));
  t.after(async () => { child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 2000); await exited; clearTimeout(timer); peer.close(); });
  await peer.request("initialize", { clientInfo: { name: "workbench_skill_discovery", version: "1" }, capabilities: { experimentalApi: true } }, { timeoutMs: 5000 });
  peer.notify({ method: "initialized" });
  const discovered = await peer.request("skills/list", { cwds: [home], forceReload: true }, { timeoutMs: 5000 });
  const skills = discovered.data.flatMap(entry => entry.skills);
  const skill = skills.find(entry => entry.name === "mycodex-workbench"); assert.ok(skill, JSON.stringify(discovered));
  assert.equal(fs.realpathSync(skill.path), fs.realpathSync(path.join(destination, "SKILL.md")));
});
