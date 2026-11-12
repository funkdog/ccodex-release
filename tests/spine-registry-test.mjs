import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { SpineRegistry, boundedJson } from "../gateway/spine/registry.mjs";
import { parseGatewayUiRequest } from "../bridge/desktop-gateway-ui.mjs";
import { startGateway } from "../gateway/server.mjs";
import { connectGateway, writeMessage, readMessages } from "../gateway/ipc.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";

const context = () => ({ authenticated: true, initialized: true, capabilities: new Set(["status:read", "logs:read"]) });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "spine-rpc-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true })); return home;
}
test("Spine dispatch derives permission from trusted context, rejects caller privilege and arbitrary methods", async t => {
  const registry = new SpineRegistry(fixture(t));
  for (const c of [{ ...context(), authenticated: false }, { ...context(), initialized: false }, { ...context(), capabilities: new Set() }]) await assert.rejects(registry.dispatch("diy/spine/status", { authenticated: true }, c));
  await assert.rejects(registry.dispatch("diy/spine/status", { capabilities: ["logs:read"] }, context()), /no parameters/);
  await assert.rejects(registry.dispatch("diy/exec/run", { command: "anything" }, context()), /unavailable/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(registry.dispatch("diy/spine/status", {}, { ...context(), signal: controller.signal }), /cancelled/);
  assert.throws(() => registry.register("diy/spine/status", "status:read", () => ({})), /duplicate/);
});
test("Spine schema and logs recover without modifying standard thread state", async t => {
  const home = fixture(t), registry = new SpineRegistry(home);
  const p = registry.logs.save(Buffer.from("first\nsecond\n"), "session", "call");
  const recovered = new SpineRegistry(home);
  assert.equal((await recovered.dispatch("diy/logs/read", { id: p.id, startLine: 2, endLine: 2 }, context())).content, "second\n");
  assert.equal((await recovered.dispatch("diy/spine/status", {}, context())).schemaVersion, 1);
  assert.deepEqual(fs.readdirSync(path.join(home, "gateway")).sort(), ["spillover", "spine"]);
});
test("UI tunnel permits generic diy namespace while bounding UTF8, depth, keys and method shape", () => {
  assert.equal(parseGatewayUiRequest(JSON.stringify({ id: "1", method: "diy/spine/status", params: {} })).method, "diy/spine/status");
  for (const method of ["thread/delete", "diy/../exec", "diy/x/y/z", "diy/exec"]) assert.throws(() => parseGatewayUiRequest(JSON.stringify({ id: "1", method, params: {} })));
  assert.throws(() => parseGatewayUiRequest(JSON.stringify({ id: "1", method: "diy/x/y", params: { text: "中".repeat(12000) } })), /limit/);
  assert.throws(() => parseGatewayUiRequest('{"id":"1","method":"diy/x/y","params":{"__proto__":{}}}'), /Unsafe/);
  let nested = {}; for (let i = 0; i < 15; i++) nested = { next: nested }; assert.throws(() => boundedJson(nested, 32000), /nesting/);
  assert.throws(() => parseGatewayUiRequest('{"id":"1","method":"diy/x/y","params":[],"token":"pretend"}'));
});
test("real private gateway IPC authenticates and initializes before diy dispatch", async t => {
  const home = fixture(t), config = { home, endpoint: path.join(home, "s"), token: randomUUID(), generation: "fixture", defaultEngine: "test", engines: new Map([["test", { models: async () => [], run: async () => {} }]]) };
  const gateway = await startGateway(config);
  let socket;
  const peer = new RpcPeer(message => writeMessage(socket, message));
  t.after(async () => { socket?.destroy(); peer.close(); await gateway.close(); });
  const bad = net.createConnection(config.endpoint);
  const badClosed = new Promise(resolve => bad.once("close", resolve));
  bad.once("connect", () => writeMessage(bad, { hello: 1, token: "bad", generation: config.generation })); await badClosed;
  socket = await connectGateway(config, message => peer.receive(message));
  await assert.rejects(peer.request("diy/spine/status", {}, { timeoutMs: 1000 }), /Initialize/);
  await peer.request("initialize", { clientInfo: { name: "test", version: "1" } });
  const p = gateway.spine.logs.save(Buffer.from("raw\n"), "session", "call");
  assert.equal((await peer.request("diy/logs/read", { id: p.id, startLine: 1, endLine: 1 })).content, "raw\n");
  await assert.rejects(peer.request("diy/logs/read", { id: "../../auth", startLine: 1, endLine: 1 }), /Invalid/);
  await assert.rejects(peer.request("diy/exec/run", { command: "no" }), /unavailable/);
});
test("long-line reads yield to other Spine requests and escaped bytes stay inside the response budget", async t => {
  const registry = new SpineRegistry(fixture(t)), p = registry.logs.save(Buffer.alloc(1024 * 1024), "session", "controls");
  let finished = false;
  const read = registry.dispatch("diy/logs/read", { id: p.id, startLine: 1, endLine: 1, maxBytes: 131072 }, context()).then(value => { finished = true; return value; });
  await registry.dispatch("diy/spine/status", {}, context()); assert.equal(finished, false);
  const result = await read; assert.equal(result.complete, false); assert.equal(result.nextByteOffset, 32768);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 256 * 1024); assert.equal(result.content, "\0".repeat(32768));
});
