import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { startGateway } from "../gateway/server.mjs";
import { connectGateway, writeMessage } from "../gateway/ipc.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { SpineRegistry } from "../gateway/spine/registry.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mc-p3-isolation-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, endpoint: process.platform === "win32" ? `\\\\.\\pipe\\mc-p3-${randomUUID()}` : path.join(home, "s"), token: randomUUID(), generation: "fixture", defaultEngine: "fixture",
    engines: new Map([["fixture", { models: async () => [{ id: "fixture", model: "fixture" }], run: async () => {} }]]) };
}
async function connect(t, config) {
  let socket;
  const peer = new RpcPeer(message => writeMessage(socket, message));
  socket = await connectGateway(config, message => peer.receive(message));
  socket.once("close", () => peer.close());
  peer.dispose = async () => { socket.destroy(); peer.close(); };
  t.after(() => peer.dispose());
  await peer.request("initialize", { clientInfo: { name: "p3-isolation", version: "1" } });
  return peer;
}
test("invalid optional Spine configuration leaves native/CLI protocol and unaffected modules available", async t => {
  const config = fixture(t);
  const gateway = await startGateway({ ...config, spine: { radar: { schemaFile: "relative", reportFile: "relative" } } });
  t.after(() => gateway.close());
  const peer = await connect(t, config);
  const created = await peer.request("thread/start", { model: "fixture/fixture", cwd: config.home });
  assert.equal((await peer.request("thread/read", { threadId: created.thread.id })).thread.id, created.thread.id);
  const status = await peer.request("diy/spine/status", {});
  assert.equal(status.modules.radar.state, "unavailable");
  assert.equal(status.modules.trace.state, "ready");
  assert.ok(!status.methods.includes("diy/radar/list"));
});
test("an incompatible Spine schema is preserved and does not prevent CLI routing or idle retirement", async t => {
  const config = fixture(t), directory = path.join(config.home, "gateway/spine");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "schema.json"), bytes = '{"schemaVersion":999}';
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  let idle = false;
  const gateway = await startGateway({ ...config, idleTimeoutMs: 20, onIdle: () => { idle = true; } });
  t.after(() => gateway.close());
  const peer = await connect(t, config);
  assert.ok((await peer.request("model/list", {})).data.length);
  await assert.rejects(peer.request("diy/spine/status", {}), /Spine.*unavailable/);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  await peer.dispose();
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(idle, true);
});
test("failed module loading publishes no partial handlers and preserves other modules", async t => {
  const registry = new SpineRegistry(fixture(t).home);
  await registry.installModule("broken", async scope => {
    scope.register("diy/broken/read", "host:read", () => ({ leaked: true }));
    throw new Error("injected initialization failure");
  });
  const context = { authenticated: true, initialized: true, capabilities: new Set(["status:read", "host:read"]) };
  const status = await registry.dispatch("diy/spine/status", {}, context);
  assert.equal(status.modules.broken.state, "unavailable");
  assert.ok(!status.methods.includes("diy/broken/read"));
  await assert.rejects(registry.dispatch("diy/broken/read", {}, context), /unavailable/);
});
test("concurrent module initialization cannot replace another module's method", async t => {
  const registry = new SpineRegistry(fixture(t).home);
  let release;
  const first = registry.installModule("first", async scope => {
    scope.register("diy/shared/read", "host:read", () => "first");
    await new Promise(resolve => { release = resolve; });
  });
  await assert.rejects(registry.installModule("first", () => {}), /Invalid/);
  await registry.installModule("second", scope => scope.register("diy/shared/read", "host:read", () => "second"));
  release(); await first;
  const context = { authenticated: true, initialized: true, capabilities: new Set(["host:read", "status:read"]) };
  assert.equal(await registry.dispatch("diy/shared/read", {}, context), "second");
  assert.equal((await registry.dispatch("diy/spine/status", {}, context)).modules.first.state, "unavailable");
});
test("a failed optional storage directory preserves its bytes and isolates only dependent modules", async t => {
  const config = fixture(t), trace = path.join(config.home, "gateway/spine/trace");
  fs.mkdirSync(path.dirname(trace), { recursive: true, mode: 0o700 }); fs.writeFileSync(trace, "retained-invalid-record", { mode: 0o600 });
  const gateway = await startGateway(config); t.after(() => gateway.close());
  const peer = await connect(t, config), status = await peer.request("diy/spine/status", {});
  assert.equal(status.modules.trace.state, "unavailable"); assert.equal(status.modules.daily.state, "unavailable");
  assert.equal(status.modules.radar.state, "ready"); assert.equal(status.modules.host.state, "ready");
  assert.equal(fs.readFileSync(trace, "utf8"), "retained-invalid-record");
  assert.ok((await peer.request("model/list", {})).data.length);
});
test("real optional import failures do not prevent gateway engine startup or routing", async t => {
  for (const failedModule of ["kernel", "registry", "radar", "host-threads", "work-service", "work-store", "work-dispatch", "reaction-store"]) {
    const config = fixture(t);
    const code = `
      import { registerHooks } from 'node:module';
      import { startGateway } from ${JSON.stringify(new URL("../gateway/server.mjs", import.meta.url).href)};
      registerHooks({ resolve(specifier, context, next) {
        if (specifier.endsWith('/${failedModule}.mjs') || specifier === './${failedModule}.mjs') throw new Error('injected module load failure');
        return next(specifier, context);
      }});
      const gateway = await startGateway({ home: ${JSON.stringify(config.home)}, endpoint: ${JSON.stringify(config.endpoint)}, token: 'isolated-test-token', generation: 'fixture', engines: new Map([['fixture', { models: async () => [{ id: 'model', model: 'model' }], run: async () => {} }]]), defaultEngine: 'fixture' });
      try {
        const connection = { initialized: false, send() {}, request() { throw new Error('not needed'); } };
        await gateway.protocol.handle('initialize', { clientInfo: { name: 'fixture', version: '1' } }, connection);
        const result = await gateway.protocol.handle('thread/start', { model: 'fixture/model', cwd: ${JSON.stringify(config.home)} }, connection);
        if (!result.thread.id) throw new Error('CLI routing failed');
        console.log('routing-preserved');
      } finally { await gateway.close(); }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, HOME: config.home, CODEX_HOME: config.home } });
    assert.equal(result.status, 0, `${failedModule}: ${result.stderr}`);
    assert.match(result.stdout, /routing-preserved/);
  }
});
test("background activity retains idle lifetime, releases idempotently and does not hang shutdown", async t => {
  const config = fixture(t); let idle = 0;
  const gateway = await startGateway({ ...config, idleTimeoutMs: 20, onIdle: () => { idle++; } });
  t.after(() => gateway.close());
  const release = gateway.spine.retainActivity();
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(idle, 0); assert.equal(gateway.spine.backgroundActivities, 1); assert.equal(gateway.spine.activeTasks, 0);
  release(); release();
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.ok(idle > 0); assert.equal(gateway.spine.backgroundActivities, 0);
  gateway.spine.retainActivity();
  await gateway.close();
  assert.throws(() => gateway.spine.retainActivity(), /closing/);
});
