import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import test from "node:test";
import { acceptanceEnvironment, acceptanceSandbox, assertAcceptanceRoot, seedAcceptanceFixtures, createAcceptanceGateway, waitAcceptanceEndpoint, waitAcceptanceIdentity, cleanupAcceptance } from "../bridge/desktop-acceptance.mjs";
import { readProcessIdentity } from "../bridge/desktop-process.mjs";
import { connectGateway, readMessages, writeMessage } from "../gateway/ipc.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";

const sourceRoot = path.resolve(import.meta.dirname, "..");
const schema = process.env.MYCODEX_TEST_RADAR_SCHEMA ?? path.resolve(sourceRoot, "../ai-agent-frontier-radar/plugin/report.schema.json");
test("acceptance waits for a launcher to exec its expected binary and rejects a different binary", async t => {
  const child = spawn("/bin/sh", ["-c", 'sleep 0.4; exec "$1" -e "setInterval(()=>{},1000)"', "acceptance", process.execPath], { stdio: "ignore" });
  const exited = new Promise(resolve => child.once("exit", resolve)); t.after(async () => { child.kill(); await exited; });
  const identity = await waitAcceptanceIdentity(child, fs.realpathSync(process.execPath), 5000); assert.equal(identity.pid, child.pid);
  await assert.rejects(waitAcceptanceIdentity(child, "/not/the/expected/binary", 100), /not be verified/);
});
test("acceptance waits for a new owned listener without accepting an unrelated lifetime", async t => {
  const server = net.createServer(); t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const timer = setTimeout(() => server.listen(port, "127.0.0.1"), 300); t.after(() => clearTimeout(timer));
  const identity = readProcessIdentity(process.pid);
  await waitAcceptanceEndpoint(identity, port, 5000);
  await assert.rejects(waitAcceptanceEndpoint({ ...identity, lifetime: "different" }, port, 500), /not owned/);
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mc-accept-")); fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, ".mycodex-acceptance.json"), JSON.stringify({ schemaVersion: 1, purpose: "mycodex-offline-acceptance", root, id: randomUUID(), sourceRoot }), { mode: 0o600 });
  for (const dir of ["profile", "user-data", "workspace", "user-home", "tmp", "cache"]) fs.mkdirSync(path.join(root, dir), { mode: 0o700 });
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  seedAcceptanceFixtures(root, schema);
  return root;
}
test("acceptance environment isolates HOME and both profiles, refuses unowned roots and strips inherited accounts", t => {
  const root = fixture(t), env = acceptanceEnvironment(root, { HOME: "/original", CODEX_HOME: "/original/.codex", OPENAI_API_KEY: "fixture", GITHUB_TOKEN: "fixture", CCODEX_GATEWAY_CONNECTION: "/live", NODE_OPTIONS: "--require private", HTTPS_PROXY: "https://example.test", LANG: "zh_CN.UTF-8" });
  assert.equal(env.HOME, path.join(root, "user-home")); assert.equal(env.CODEX_HOME, path.join(root, "profile")); assert.equal(env.CODEX_ELECTRON_USER_DATA_PATH, path.join(root, "user-data"));
  for (const key of ["OPENAI_API_KEY", "GITHUB_TOKEN", "CCODEX_GATEWAY_CONNECTION", "NODE_OPTIONS", "HTTPS_PROXY"]) assert.equal(env[key], undefined);
  assert.equal(env.LANG, "zh_CN.UTF-8");
  assert.throws(() => assertAcceptanceRoot("relative"), /absolute/);
  const marker = path.join(root, ".mycodex-acceptance.json"); fs.renameSync(marker, marker + ".backup"); assert.throws(() => acceptanceEnvironment(root)); fs.renameSync(marker + ".backup", marker);
  const alias = root + "-link"; fs.symlinkSync(root, alias); t.after(() => fs.unlinkSync(alias)); assert.throws(() => acceptanceEnvironment(alias), /owned acceptance/);
  fs.writeFileSync(path.join(root, "receipt.json"), JSON.stringify({ identity: readProcessIdentity(process.pid) }), { mode: 0o600 });
  assert.throws(() => cleanupAcceptance(root), /does not belong/); assert.equal(fs.existsSync(path.join(root, "workspace/acceptance.png")), true);
});

test("acceptance gateway serves its own media and real Spine services and rejects arbitrary work without invoking an engine", async t => {
  const root = fixture(t), gateway = await createAcceptanceGateway(root); t.after(() => gateway.close());
  let socket; const peer = new RpcPeer(message => writeMessage(socket, message)); socket = await connectGateway(gateway.connection, message => peer.receive(message)); t.after(() => { socket.destroy(); peer.close(); });
  await peer.request("initialize", { clientInfo: { name: "acceptance-test", version: "1" } });
  const models = await peer.request("model/list", {}); assert.deepEqual(models.data.map(row => row.model), ["acceptance/fixture"]);
  const listed = await peer.request("thread/list", {}); assert.equal(listed.data.length, 1); const id = listed.data[0].id;
  const turns = await peer.request("thread/turns/list", { threadId: id, itemsView: "summary" });
  const image = turns.data[0].items.find(item => item.type === "imageGeneration"); assert.ok(image.savedPath.startsWith(path.join(root, "profile/gateway/media", id))); assert.equal(fs.statSync(image.savedPath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(image.savedPath).readUInt32BE(16), 480); assert.equal(fs.readFileSync(image.savedPath).readUInt32BE(20), 240);
  const full = await peer.request("thread/turns/list", { threadId: id, itemsView: "full" });
  const tool = full.data[0].items.find(item => item.type === "dynamicToolCall"); assert.equal(tool.status, "completed");
  const radar = await peer.request("diy/radar/list", {}); assert.equal(radar.total, 2);
  const daily = await peer.request("diy/daily/digest", {}); assert.equal(daily.coverage.cli, 1);
  const before = fs.readdirSync(path.join(root, "workspace"));
  await peer.request("turn/start", { threadId: id, input: [{ type: "text", text: "please execute real work" }] }); await gateway.protocol.active.get(id)?.done;
  const denied = await peer.request("thread/turns/list", { threadId: id, sortDirection: "asc" }); assert.equal(denied.data.at(-1).status, "failed"); assert.match(denied.data.at(-1).error.message, /只接受/); assert.deepEqual(fs.readdirSync(path.join(root, "workspace")), before);
  await assert.rejects(createAcceptanceGateway(root), /EADDRINUSE/);
});

test("macOS acceptance sandbox enforces private writes and blocks Internet without touching outside fixtures", t => {
  if (process.platform !== "darwin") return t.skip("macOS acceptance sandbox only");
  const root = fixture(t), outside = path.join(path.dirname(root), "acceptance-outside-" + randomUUID()); fs.writeFileSync(outside, "preserve"); t.after(() => fs.unlinkSync(outside));
  const script = `const fs=require('node:fs'),net=require('node:net');fs.writeFileSync(process.argv[1],'owned');let denied=false;try{fs.writeFileSync(process.argv[2],'overwrite')}catch(e){denied=['EPERM','EACCES'].includes(e.code)}const s=net.createConnection({host:'198.51.100.1',port:443});s.setTimeout(1500,()=>{s.destroy();process.exit(3)});s.on('error',e=>{console.log(JSON.stringify({denied,networkDenied:['EPERM','EACCES'].includes(e.code)}));s.destroy()});`;
  const result = spawnSync("/usr/bin/sandbox-exec", ["-p", acceptanceSandbox(root), process.execPath, "-e", script, path.join(root, "owned.txt"), outside], { env: acceptanceEnvironment(root), encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { denied: true, networkDenied: true }); assert.equal(fs.readFileSync(outside, "utf8"), "preserve");
});

test("sandboxed routed shim uses synthetic native identity plus isolated gateway and restores image history", { timeout: 15000 }, async t => {
  if (process.platform !== "darwin") return t.skip("macOS acceptance sandbox only");
  const root = fixture(t), gateway = await createAcceptanceGateway(root); t.after(() => gateway.close());
  const child = spawn("/usr/bin/sandbox-exec", ["-p", acceptanceSandbox(root), path.join(root, "codex"), "app-server"], { env: acceptanceEnvironment(root), cwd: path.join(root, "workspace"), stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", data => { stderr += data; }); const peer = new RpcPeer(message => writeMessage(child.stdin, message)); readMessages(child.stdout, message => peer.receive(message), error => peer.close(error));
  const exited = new Promise(resolve => child.once("exit", code => { peer.close(new Error(`Sandboxed shim exited ${code}: ${stderr}`)); resolve(code); }));
  t.after(async () => { child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 1000); await exited; clearTimeout(timer); peer.close(); });
  assert.match((await peer.request("initialize", { clientInfo: { name: "acceptance-test", version: "1" } }, { timeoutMs: 3000 })).userAgent, /fixture/);
  const catalog = await peer.request("model/list", {}, { timeoutMs: 6000 }); assert.ok(catalog.data.some(row => row.model === "mycodex/acceptance/fixture"), JSON.stringify(catalog) + stderr);
  const history = await peer.request("thread/turns/list", { threadId: gateway.threadIds[0], itemsView: "summary" }, { timeoutMs: 3000 }); assert.ok(history.data[0].items.some(item => item.type === "imageGeneration"));
  const auth = await peer.request("account/read", {}); assert.equal(auth.account, null); assert.equal(auth.requiresOpenaiAuth, false);
});
