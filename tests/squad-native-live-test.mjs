import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { createResponsesWriter } from "../bridge/translate.mjs";
import { readMessages, writeMessage } from "../gateway/ipc.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { squadFixture } from "./squad-flow-fixture.mjs";
import { writeResult } from "../gateway/spine/squad-relay.mjs";

const root = path.resolve(import.meta.dirname, "..");
async function until(read, predicate = Boolean) {
  const end = Date.now() + 15000;
  do { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < end);
  throw new Error("Isolated native Squad operation did not settle.");
}
function client(t, file, args, env, cwd) {
  const child = spawn(process.execPath, [file, ...args], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", data => { stderr = (stderr + data).slice(-4096); });
  const peer = new RpcPeer(message => writeMessage(child.stdin, message));
  readMessages(child.stdout, message => peer.receive(message), cause => peer.close(cause));
  const exited = new Promise(resolve => child.once("exit", code => { peer.close(new Error(`Owned Squad native client exited (${code}): ${stderr}`)); resolve(code); }));
  t.after(async () => { child.stdin.end(); const kill = setTimeout(() => child.kill("SIGKILL"), 3000); await exited; clearTimeout(kill); });
  return { peer, child, exited };
}

test("installed Codex core and two CLI engines create each other through Squad MCP/command, push native turns and clean native deletions", { timeout: 45000 }, async t => {
  const executable = process.env.MYCODEX_TEST_NATIVE_CLI ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  try { await fs.access(executable); } catch { t.skip("Set MYCODEX_TEST_NATIVE_CLI to verify the installed native core."); return; }
  // Keep subprocess cleanup before profile cleanup, including test failures.
  const cleanups = [], f = await squadFixture({ after(fn) { cleanups.push(fn); } });
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  const register = { after(fn) { cleanups.push(fn); } };
  const secondPrompts = [];
  f.gateway.protocol.engines.set("second-cli", { adapter: "second-fixture", models: async () => [{ id: "model", name: "Second CLI" }], run: async context => { secondPrompts.push(context.prompt); context.onText("SECOND_CLI_RESULT"); } });
  f.gateway.protocol.catalogPromise = null;
  const inputs = []; let holdReply;
  const provider = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/responses") { res.writeHead(404); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); inputs.push(body.input);
    if (JSON.stringify(body.input).includes("SQUAD_DELAYED_CLEANUP")) await holdReply;
    const writer = createResponsesWriter(res, body, new Map()); writer.pushChunk({ choices: [{ delta: { content: "NATIVE_SQUAD_RESULT" } }] }); writer.finish();
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve)); register.after(() => new Promise(resolve => provider.close(resolve)));
  const profile = path.join(f.home, "native-profile"); await fs.mkdir(profile, { mode: 0o700 });
  await fs.writeFile(path.join(profile, "config.toml"), `model="squad-local"\nmodel_provider="squad-local"\ncli_auth_credentials_store="file"\ncheck_for_update_on_startup=false\n[features]\napps=false\nplugins=false\nremote_plugin=false\n[model_providers.squad-local]\nname="Squad local test"\nbase_url="http://127.0.0.1:${provider.address().port}"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n`);
  const file = path.join(f.home, "connection.json"); await fs.writeFile(file, JSON.stringify({ ...f.config, engines: [], spine: { mcp: true } }), { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: f.home, CODEX_HOME: profile, CCODEX_NATIVE_CLI: executable, CCODEX_GATEWAY_CONNECTION: file };
  let native = client(register, path.join(root, "gateway/routed-stdio.mjs"), ["app-server"], env, f.home);
  const turns = new Map(); native.peer.onNotification = message => { if (message.method === "turn/completed") turns.set(message.params.turn.id, message.params.turn); };
  await native.peer.request("initialize", { clientInfo: { name: "squad-native-live", version: "1" }, capabilities: { experimentalApi: true } }, { timeoutMs: 10000 });
  native.peer.notify({ method: "initialized" });
  const binding = (await until(() => f.call("diy/host/status"), page => page.bindings.some(b => b.squad))).bindings.find(b => b.squad);
  const hostRef = { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: "00000000-0000-0000-0000-000000000000" };
  const catalog = await f.call("diy/squad/catalog"); assert(catalog.models.some(m => m.kind === "native")); assert(catalog.models.some(m => m.model === "second-cli/model"));
  const mcp = client(register, path.join(root, "gateway/spine/mcp-server.mjs"), [file], env, f.home);
  mcp.peer.send = message => writeMessage(mcp.child.stdin, { jsonrpc: "2.0", ...message });
  await mcp.peer.request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "squad-test", version: "1" }, capabilities: {} });
  mcp.peer.notify({ method: "notifications/initialized" });
  const tool = async (name, args) => { const result = await mcp.peer.request("tools/call", { name: "mycodex.squad_" + name, arguments: args }); assert.equal(result.isError, false, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
  const command = async (operation, args) => {
    const child = spawn(process.execPath, [path.join(root, "gateway/spine/squad-cli.mjs"), path.join(f.home, ".mycodex/squad-client.json"), operation], { env, cwd: f.home, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", bytes => stdout += bytes); child.stderr.on("data", bytes => stderr += bytes); child.stdin.end(JSON.stringify(args));
    const code = await new Promise(resolve => child.once("exit", resolve)); assert.equal(code, 0, stdout + stderr); return JSON.parse(stdout).result;
  };
  // 1) V2 six-primitive MCP end-to-end across installed native Codex core and two CLI engines.
  const v2Anchor = (await native.peer.request("thread/start", { cwd: f.home })).thread;
  const v2Init = await tool("init", {
    anchorThreadId: v2Anchor.id,
    anchorHostRef: { ...hostRef, threadId: v2Anchor.id },
    title: "Native V2 Squad",
    intent: "Cross-engine V2 MCP live verification",
    state: { criteria: [{ id: "C1", text: "Native and CLI slots settle cleanly" }] },
  });
  assert.match(v2Init.studioUrl, /^http:\/\/127\.0\.0\.1:\d+\/squads\//);
  const v2Updated = await tool("state", {
    squadId: v2Init.squadId,
    expectedRevision: 1,
    patch: { contracts: ["Workers never receive squad_* MCP tools"] },
  });
  assert.equal(v2Updated.state.revision, 2);
  const v2Dispatched = await tool("dispatch", {
    squadId: v2Init.squadId,
    slots: [
      { slotId: "native-clean", continuity: "clean", engine: "native", model: "squad-local", task: "unprojected-task", artifacts: ["V2_NATIVE_SLOT_ARTIFACT"], touches: [] },
      { slotId: "cli-one", continuity: "stateful", engine: "cli", model: "fixture/model", task: "V2_CLI_ONE_TASK", touches: [] },
      { slotId: "cli-two", continuity: "stateful", engine: "cli", model: "second-cli/model", task: "V2_CLI_TWO_TASK", touches: [] },
    ],
  });
  assert.equal(v2Dispatched.slots.length, 3);
  for (const s of v2Dispatched.slots.filter(s => s.engine === "cli")) {
    await f.gateway.protocol.active.get(s.threadId)?.done;
  }
  await until(() => tool("status", { squadId: v2Init.squadId }), snap => snap.slots.every(s => s.activity === "quiescent"));
  assert(inputs.some(value => JSON.stringify(value).includes("V2_NATIVE_SLOT_ARTIFACT")));
  assert.equal(secondPrompts.length, 1);
  secondPrompts.length = 0;
  const v2Closed = await tool("close", { squadId: v2Init.squadId, promoteSlots: ["cli-one"] });
  assert.equal(v2Closed.status, "closed");
  assert.equal(v2Closed.slots.find(s => s.slotId === "cli-one").sidebarHidden, false);

  // 2) Legacy CLI command compatibility, native runtime reopen recovery and deletion cleanup.
  const cliSupervisor = await f.createThread(), squad = await command("create", { anchorThreadId: cliSupervisor.id, label: "CLI to native" });
  const requestId = randomUUID(), params = { squadId: squad.id, shortName: "Native worker", kind: "native", hostRef, requestId };
  const nativeWorker = await command("create_member", params);
  assert.deepEqual(await command("create_member", params), nativeWorker, "Retried creation never forks or creates another chat");
  assert.equal((await native.peer.request("thread/read", { threadId: nativeWorker.threadId, includeTurns: false })).thread.id, nativeWorker.threadId);
  const sent = await command("brief", { squadId: squad.id, workerId: nativeWorker.threadId, squadGoal: "Actual native transport", task: "Return the local test response without tools.", requestId: randomUUID() });
  await until(() => turns.get(sent.accepted.turnId)); assert.equal(turns.get(sent.accepted.turnId).status, "completed");
  assert(inputs.some(value => JSON.stringify(value).includes("Actual native transport")));
  await command("report", { squadId: squad.id, workerId: nativeWorker.threadId, dispatchId: sent.brief.dispatchId, summary: "NATIVE_SQUAD_RESULT", status: "completed" });
  await command("summarize", { squadId: squad.id, requestId: randomUUID() }); await f.gateway.protocol.active.get(cliSupervisor.id)?.done;
  assert(f.prompts.some(context => context.prompt.includes("NATIVE_SQUAD_RESULT")));
  // Native supervisor creates workers in two independent CLI engines.
  const nativeAnchor = (await native.peer.request("thread/start", { cwd: f.home })).thread;
  const otherSquad = await command("create", { anchorThreadId: nativeAnchor.id, anchorHostRef: { ...hostRef, threadId: nativeAnchor.id }, label: "Native to CLIs" });
  for (const model of ["fixture/model", "second-cli/model"]) {
    const worker = await command("create_member", { squadId: otherSquad.id, shortName: model, kind: "cli", model, requestId: randomUUID() });
    const sent = await command("brief", { squadId: otherSquad.id, workerId: worker.threadId, squadGoal: "Mixed engines", task: "CLI delegation", requestId: randomUUID() });
    await f.gateway.protocol.active.get(worker.threadId)?.done;
    await command("report", { squadId: otherSquad.id, workerId: worker.threadId, dispatchId: sent.brief.dispatchId, summary: model + " completed", status: "completed" });
  }
  assert.equal(secondPrompts.length, 1);
  const summary = await command("summarize", { squadId: otherSquad.id, requestId: randomUUID() }); await until(() => turns.get(summary.turnId));
  assert(inputs.some(value => JSON.stringify(value).includes("second-cli/model completed")));
  const nativeToNative = await command("create_member", { squadId: otherSquad.id, shortName: "Another native", kind: "native", hostRef, requestId: randomUUID() });
  const nativeSent = await command("brief", { squadId: otherSquad.id, workerId: nativeToNative.threadId, squadGoal: "Native peers", task: "Return local response", requestId: randomUUID() });
  await until(() => turns.get(nativeSent.accepted.turnId));
  const posted = await command("post", { squadId: otherSquad.id, authorThreadId: nativeAnchor.id, requestId: randomUUID(), kind: "assign", summary: "Return local response, report verification gaps", next: "@Another native" });
  const ledger = await command("ledger", { squadId: otherSquad.id });
  const delivery = ledger.deliveries.find(d => d.seq === posted.seq); assert(delivery.turnId);
  await until(() => turns.get(delivery.turnId));
  const fallback = await command("fallback", { squadId: otherSquad.id, workerId: nativeToNative.threadId, requestId: randomUUID() });
  assert.equal(fallback.kind, "system_fallback"); assert.match(fallback.summary, /NATIVE_SQUAD_RESULT/); assert.equal(fallback.verdict, undefined);
  await native.peer.request("thread/delete", { threadId: nativeToNative.threadId });
  await until(() => f.call("diy/squad/list"), page => !page.squads.find(s => s.id === otherSquad.id).members.some(m => m.threadId === nativeToNative.threadId));
  await native.peer.request("thread/delete", { threadId: nativeAnchor.id });
  await until(() => f.call("diy/squad/list"), page => !page.squads.some(s => s.id === otherSquad.id));
  assert.equal(f.gateway.protocol.store.threads.has(nativeWorker.threadId), false);
  const status = await native.peer.request("mcpServerStatus/list", {}, { timeoutMs: 10000 });
  assert.match(JSON.stringify(status), /mycodex\.squad_init/);
  assert.match(JSON.stringify(status), /mycodex\.squad_dispatch/);
  // Reopen the real native process on the same isolated profile. Its runtime
  // binding changes, while the saved thread identity and permissions remain.
  native.child.stdin.end(); await native.exited;
  native = client(register, path.join(root, "gateway/routed-stdio.mjs"), ["app-server"], env, f.home);
  native.peer.onNotification = message => { if (message.method === "turn/completed") turns.set(message.params.turn.id, message.params.turn); };
  await native.peer.request("initialize", { clientInfo: { name: "squad-native-reopen", version: "1" }, capabilities: { experimentalApi: true } }, { timeoutMs: 10000 });
  native.peer.notify({ method: "initialized" });
  const replacementBinding = (await until(() => f.call("diy/host/status"), page => page.bindings.some(b => b.squad && b.runtimeId !== binding.runtimeId))).bindings.find(b => b.squad && b.runtimeId !== binding.runtimeId);
  const resumed = await command("brief", { squadId: squad.id, workerId: nativeWorker.threadId, squadGoal: "Same native identity", task: "Continue after normal reopen", requestId: randomUUID() });
  assert.equal(resumed.brief.execution.ref.runtimeId, replacementBinding.runtimeId);
  await until(() => turns.get(resumed.accepted.turnId)); assert.equal(turns.get(resumed.accepted.turnId).status, "completed");
  let releaseReply; holdReply = new Promise(resolve => releaseReply = resolve); register.after(() => releaseReply());
  const currentRef = { ...hostRef, runtimeId: replacementBinding.runtimeId };
  const lateWorker = await command("create_member", { squadId: squad.id, shortName: "Late native writer", kind: "native", hostRef: currentRef, requestId: randomUUID() });
  const delayed = await command("brief", { squadId: squad.id, workerId: lateWorker.threadId, squadGoal: "SQUAD_DELAYED_CLEANUP", task: "Wait for the local test response", requestId: randomUUID() });
  await until(() => inputs.some(value => JSON.stringify(value).includes("SQUAD_DELAYED_CLEANUP")));
  await command("remove", { squadId: squad.id, threadId: lateWorker.threadId });
  await f.restart();
  await writeResult(f.home, { squadId: squad.id, workerId: lateWorker.threadId, dispatchId: delayed.brief.dispatchId, summary: "Late native file", status: "completed", completedAt: Date.now() });
  const lateFile = path.join(f.home, ".mycodex/squad-relay", squad.id, `${lateWorker.threadId}.${delayed.brief.dispatchId}.result.json`);
  await fs.access(lateFile); // The still-running turn has not been declared complete.
  releaseReply(); await until(() => turns.get(delayed.accepted.turnId));
  await until(() => fs.stat(lateFile).then(() => false, error => { if (error.code === "ENOENT") return true; throw error; }));
  assert.equal(turns.get(delayed.accepted.turnId).status, "completed");
});
