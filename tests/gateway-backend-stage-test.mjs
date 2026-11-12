import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { appServerGatewayBackend, isAdditiveCliConfiguration } from "../bridge/desktop-backends/app-server-gateway.mjs";
import { readProcessIdentity, sameProcessLifetime } from "../bridge/desktop-process.mjs";
import { connectGateway, writeMessage } from "../gateway/ipc.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { nativeEnvironment } from "../gateway/native-peer.mjs";

const root = path.resolve(import.meta.dirname, "..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("live capability retention accepts only additive CLI engines with every existing route unchanged", () => {
  const original = { defaultEngine: "first", engines: [{ id: "first", adapter: "claude-code", sdkPath: "/old/sdk.mjs" }], spine: { mcp: true } };
  const added = { ...original, engines: [...original.engines, { id: "second", adapter: "claude-code", sdkPath: "/new/sdk.mjs" }] };
  assert.equal(isAdditiveCliConfiguration(original, added), true);
  for (const changed of [original, { ...added, defaultEngine: "second" }, { ...added, spine: { mcp: false } },
    { ...added, workbench: false },
    { ...added, engines: [{ ...original.engines[0], sdkPath: "/replaced/sdk.mjs" }, added.engines[1]] },
    { ...added, engines: [added.engines[1]] }, { ...added, engines: [...original.engines, original.engines[0]] },
    { ...added, engines: [...original.engines, { id: "codex-gemini", adapter: "codex-gemini" }] }])
    assert.equal(isAdditiveCliConfiguration(original, changed), false);
});

test("unknown page version preserves configured providers when installed native protocol is compatible", { skip: process.platform !== "darwin" }, async t => {
  const nativeCli = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  if (!fs.existsSync(nativeCli)) return t.skip("Installed native CLI unavailable");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-backend-only-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const provider = { id: "codex-copilot", adapter: "codex-copilot", bridgeHome: home, bridgePort: 12345 };
  const selection = { generation: "isolated-future-page", gateway: { defaultEngine: provider.id, engines: [provider], workbench: false } };
  const backend = appServerGatewayBackend({ root, home, selection, nativeCli });
  const staged = await backend.stage({ runtime: { manifest: { applicationVersion: "future-page-with-compatible-cli" } }, inherited: process.env });
  const config = JSON.parse(fs.readFileSync(staged.connectionFile));
  assert.deepEqual(config.engines, [provider]); assert.equal(config.nativeCli, nativeCli);
  assert.equal(config.workbench, false);
  assert.equal(config.identity, undefined); assert.equal(fs.existsSync(config.endpoint), false);
  fs.rmSync(path.dirname(config.endpoint), { recursive: true, force: true });
});

for (const applicationVersion of ["26.1023.50603", "26.1023.51421"]) {
test(`Mac backend ${applicationVersion} stages without a process, delegates native probes and starts one reusable private gateway`, {
  // Three cold gateway lifetimes plus authenticated reconnects and macOS
  // process probes exceed 20 seconds on a loaded host; each RPC stays bounded.
  skip: process.platform !== "darwin", timeout: 60000,
}, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-backend-stage-"));
  const sdkPath = path.join(home, "synthetic-sdk.mjs");
  const discoveryFile = path.join(home, "discovery-count");
  fs.writeFileSync(sdkPath, `import fs from 'node:fs'; export function query() {
    return { supportedModels: async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
      const file = ${JSON.stringify(discoveryFile)};
      fs.appendFileSync(file, 'discovered\\n');
      return [{value:"synthetic",displayName:"Synthetic only"}];
    }, close() {} };
  }`);
  const selection = { generation: "backend-stage-test", gateway: { defaultEngine: "claude",
    engines: [{ id: "claude", adapter: "claude-code", sdkPath }] } };
  const options = { runtime: { manifest: { applicationVersion } }, inherited: process.env };
  const backend = appServerGatewayBackend({ root, home, selection, nativeCli: process.execPath });
  assert.equal(backend.environment().CODEX_APP_SERVER_FORCE_CLI, undefined, "Routed local CLI must preserve native cloud and remote WebSocket transports");
  let socket, config;
  const file = path.join(home, "gateway", "connection.json");
  t.after(async () => {
    socket?.destroy();
    if (fs.existsSync(file)) config = JSON.parse(fs.readFileSync(file, "utf8"));
    const identity = config?.identity;
    if (identity && sameProcessLifetime(identity, readProcessIdentity(identity.pid))) {
      process.kill(identity.pid, "SIGTERM");
      let exited = false;
      for (let n = 0; n < 50; n++) {
        // BSD ps/lsof can straddle process exit. Retry observation only; never
        // signal an unverifiable process or treat an unreadable one as gone.
        await delay(50);
        try { if (!sameProcessLifetime(identity, readProcessIdentity(identity.pid))) { exited = true; break; } } catch {}
      }
      assert.equal(exited, true, "Owned gateway must exit");
    }
    if (config) fs.rmSync(path.dirname(config.endpoint), { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  await assert.rejects(backend.stage({ ...options, runtime: { manifest: { applicationVersion: "unverified" } } }), /protocol/);
  assert.equal(fs.existsSync(path.dirname(file)), false);
  const staged = await backend.stage(options);
  config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.identity, undefined);
  assert.equal(fs.existsSync(config.endpoint), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(staged.shim).mode & 0o777, 0o700);
  assert.equal(staged.frontend, "routed-stdio.mjs");
  const output = execFileSync(staged.shim, [path.join(root, "tests/fixtures/native-app-server.mjs"), "--version"], {
    encoding: "utf8", timeout: 5000, env: { ...nativeEnvironment(process.env), TEST_CCODEX_NATIVE_PROCESS: "test-only", CODEX_HOME: path.join(home, "native") },
  });
  assert.equal(output.trim(), "native-fixture 1.0");
  assert.equal(fs.existsSync(path.join(home, "native")), false);
  await backend.prepare(options);
  assert.equal(fs.readFileSync(discoveryFile, "utf8"), "discovered\n", "Prepare must finish catalog discovery before Desktop starts");
  config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(config.identity?.pid);
  let peer = new RpcPeer(message => writeMessage(socket, message));
  socket = await connectGateway(config, message => peer.receive(message));
  socket.once("close", () => peer.close());
  await peer.request("initialize", { clientInfo: { name: "stage-test", version: "1" } }, { timeoutMs: 5000 });
  const models = await peer.request("model/list", {}, { timeoutMs: 5000 });
  assert.equal(models.data[0].model, "claude/synthetic");
  await backend.prepare(options);
  assert.equal(fs.readFileSync(discoveryFile, "utf8"), "discovered\n", "Reusing a warm gateway must not invalidate the catalog");
  const reused = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(reused.identity, config.identity);
  assert.equal(reused.token, config.token);
  assert.match(reused.runtimeGeneration, /^[a-f0-9]{64}$/);
  // Older receipts recorded ps birth time in the system timezone, while the
  // shared identity probe now consistently uses UTC. A healthy authenticated
  // listener must be reconciled without replacing it or dropping its engines.
  const localEnv = { ...process.env, LC_ALL: "C" }; delete localEnv.TZ;
  const localBirth = "macos:" + execFileSync("/bin/ps", ["-p", String(reused.identity.pid), "-o", "lstart="],
    { encoding: "utf8", env: localEnv }).trim().replace(/\s+/g, " ");
  if (localBirth !== reused.identity.lifetime) {
    const legacy = { ...reused, identity: { ...reused.identity, lifetime: localBirth } };
    fs.writeFileSync(file, JSON.stringify(legacy), { mode: 0o600 });
    try {
      await backend.stage(options);
      const reconciled = JSON.parse(fs.readFileSync(file));
      assert.deepEqual(reconciled, reused, "Only a proven legacy identity is normalized; PID, capability and engines remain unchanged");
      const unauthenticated = { ...legacy, token: "wrong-private-capability-for-regression" };
      fs.writeFileSync(file, JSON.stringify(unauthenticated), { mode: 0o600 });
      await assert.rejects(backend.stage(options));
      assert.deepEqual(JSON.parse(fs.readFileSync(file)), unauthenticated, "Birth time alone cannot authorize receipt migration");
    } finally { fs.writeFileSync(file, JSON.stringify(reused), { mode: 0o600 }); }
  }
  fs.writeFileSync(file, JSON.stringify({ ...reused, runtimeGeneration: "obsolete-source" }), { mode: 0o600 });
  await assert.rejects(backend.stage(options), { code: "GATEWAY_RUNTIME_RETIRING" });
  await assert.rejects(backend.check(), { code: "GATEWAY_RUNTIME_RETIRING" });
  fs.writeFileSync(file, JSON.stringify({ ...reused, runtimeGeneration: "obsolete-source", token: "wrong-private-capability-for-regression" }), { mode: 0o600 });
  await assert.rejects(backend.check(), error => error.code !== "GATEWAY_RUNTIME_RETIRING",
    "A pending update cannot claim a retained binding until gateway authentication succeeds");
  fs.writeFileSync(file, JSON.stringify({ ...reused, runtimeGeneration: "obsolete-source" }), { mode: 0o600 });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).runtimeGeneration, "obsolete-source");
  fs.writeFileSync(file, JSON.stringify(reused), { mode: 0o600 });
  const changed = appServerGatewayBackend({ root, home, nativeCli: process.execPath,
    selection: { ...selection, generation: "changed" } });
  await assert.rejects(changed.stage(options), { code: "GATEWAY_RUNTIME_RETIRING" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), reused, "Waiting for a changed configuration must not overwrite live connection settings");
  for (const [identity, expected] of [
    [{...reused.identity, executable:"/simulated/before-runtime-update/node"}, {code:"GATEWAY_RUNTIME_RETIRING"}],
    [{...reused.identity, lifetime:"different-process-birth"}, error=>/socket ownership is uncertain/.test(error.message)&&!error.code],
  ]) {
    const recorded={...reused,identity};
    fs.writeFileSync(file,JSON.stringify(recorded),{mode:0o600});
    try {
      await assert.rejects(backend.stage(options),expected);
      assert.deepEqual(JSON.parse(fs.readFileSync(file,"utf8")),recorded,"A live process with mismatched executable identity must never be reused or reassigned");
      assert.equal(fs.lstatSync(reused.endpoint).isSocket(),true,"Waiting or refusing ownership must preserve the live socket");
    } finally {fs.writeFileSync(file,JSON.stringify(reused),{mode:0o600});}
  }
  const differentNative = appServerGatewayBackend({ root, home, nativeCli: "/different/native",
    selection: { ...selection, generation: "changed" } });
  await assert.rejects(differentNative.stage(options), error => /active gateway has different settings/.test(error.message) && !error.code);
  peer.close(); socket.destroy();
  const prior = reused;
  assert.equal(sameProcessLifetime(prior.identity, readProcessIdentity(prior.identity.pid)), true);
  process.kill(prior.identity.pid, "SIGTERM");
  for (let n = 0; n < 50 && sameProcessLifetime(prior.identity, readProcessIdentity(prior.identity.pid)); n++) await delay(50);
  assert.equal(readProcessIdentity(prior.identity.pid), null);
  await backend.prepare({ ...options, preserveConnectionToken: true });
  const upgraded = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.notEqual(upgraded.identity.pid, prior.identity.pid);
  assert.equal(upgraded.token, prior.token, "An existing native frontend retains its private connection capability");
  peer = new RpcPeer(message => writeMessage(socket, message));
  socket = await connectGateway(prior, message => peer.receive(message));
  await peer.request("initialize", { clientInfo: { name: "reconnected-native-frontend", version: "1" } }, { timeoutMs: 5000 });
  assert.equal((await peer.request("model/list", {}, { timeoutMs: 5000 })).data[0].model, "claude/synthetic");
  peer.close();
  assert.equal(await backend.retireIdle(), true, "An idle gateway with an open client connection can retire after a source/runtime update");
  for (let n = 0; n < 50 && readProcessIdentity(upgraded.identity.pid); n++) await delay(50);
  assert.equal(readProcessIdentity(upgraded.identity.pid), null);
  const selectionAdded = { ...selection, generation: "added-cli-engine", gateway: { ...selection.gateway,
    engines: [...selection.gateway.engines, { id: "second", adapter: "claude-code", sdkPath }] } };
  const addedBackend = appServerGatewayBackend({ root, home, selection: selectionAdded, nativeCli: process.execPath });
  const beforeAddition = JSON.parse(fs.readFileSync(file, "utf8"));
  await assert.rejects(addedBackend.stage({ ...options, preserveConnectionToken: true }), /mismatching/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), beforeAddition, "An unapproved topology change cannot alter the connection record");
  await addedBackend.prepare({ ...options, preserveConnectionToken: true, allowCliEngineAdditions: true });
  const addedConfig = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(addedConfig.generation, prior.generation, "Existing native frontends retain the transport generation");
  assert.equal(addedConfig.configGeneration, selectionAdded.generation);
  assert.equal(addedConfig.token, prior.token);
  await addedBackend.check();
  peer = new RpcPeer(message => writeMessage(socket, message));
  socket = await connectGateway(prior, message => peer.receive(message));
  await peer.request("initialize", { clientInfo: { name: "old-frontend-after-engine-addition", version: "1" } }, { timeoutMs: 5000 });
  assert.deepEqual((await peer.request("model/list", {}, { timeoutMs: 5000 })).data.map(m => m.id).sort(), ["claude/synthetic", "second/synthetic"]);
  peer.close();socket.destroy();
  const unsafe = appServerGatewayBackend({ root, home, nativeCli: process.execPath, selection: { ...selectionAdded, generation: "changed-existing-route",
    gateway: { ...selectionAdded.gateway, defaultEngine: "second" } } });
  await assert.rejects(unsafe.retireIdle({ allowCliEngineAdditions: true }), /ownership|configuration/);
  assert.equal(sameProcessLifetime(addedConfig.identity, readProcessIdentity(addedConfig.identity.pid)), true);
});
}
