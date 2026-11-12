import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { bridgeSourceGeneration, requireBridgeGeneration } from "../bridge/runtime-generation.mjs";
import { syntheticCopilotMetadata } from "./fixtures/copilot-sdk-metadata.mjs";

const root = path.resolve(import.meta.dirname, "..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function command(args, env) {
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, output };
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server.address().port;
}
async function bridgeStatus(port, predicate) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      const result = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      const value = await result.json();
      if (result.ok && predicate(value)) return value;
    } catch {}
    await delay(50);
  }
  throw new Error("Isolated bridge did not reach the expected state.");
}

function profile(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-bridge-generation-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(home)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test("bridge generation detects nested source and dependency changes without using version path hardcodes", t => {
  const home = profile(t);
  fs.mkdirSync(path.join(home, "nested"));
  fs.writeFileSync(path.join(home, "server.mjs"), "synthetic-one");
  fs.writeFileSync(path.join(home, "nested/package.json"), "{}");
  const first = bridgeSourceGeneration(home);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(bridgeSourceGeneration(home), first);
  fs.writeFileSync(path.join(home, "notes.md"), "not executable");
  assert.equal(bridgeSourceGeneration(home), first);
  fs.writeFileSync(path.join(home, "nested/package.json"), '{"revision":2}');
  assert.notEqual(bridgeSourceGeneration(home), first);
  const second = bridgeSourceGeneration(home);
  fs.writeFileSync(path.join(home, "nested/future-adapter.mjs"), "synthetic-future");
  assert.notEqual(bridgeSourceGeneration(home), second);
});

test("old and mismatched live generations fail explicitly without stopping a process", () => {
  const generation = bridgeSourceGeneration();
  assert.throws(() => requireBridgeGeneration({ pid: 123 }, generation), /No running task was stopped/);
  assert.throws(() => requireBridgeGeneration({ pid: 123, runtime: { sourceGeneration: "different" } }, generation),
    /reopening Desktop alone is not enough/);
  requireBridgeGeneration({ runtime: { sourceGeneration: generation } }, generation);
});

for (const matches of [false, true]) {
  test(`launcher ${matches ? "accepts" : "rejects"} the live source generation without restarting it`, async t => {
    const home = profile(t);
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        bridge: "codex-copilot", status: "ok", pid: process.pid,
        runtime: { sourceGeneration: matches ? bridgeSourceGeneration() : "previous-generation" },
      }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../bridge/ensure.mjs")], {
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CODEX_HOME: home, CODEX_COPILOT_HOME: home,
          CODEX_COPILOT_BRIDGE_HOST: "127.0.0.1", CODEX_COPILOT_BRIDGE_PORT: String(server.address().port) },
      });
      t.diagnostic(`Isolated generation-check PID ${child.pid}`);
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      const status = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(status, matches ? 0 : 1, output);
      assert.equal(requests, 1);
      if (!matches) assert.match(output, /running older or different code/);
      assert.equal(fs.existsSync(path.join(home, "bridge.json")), false, "no replacement server was started");
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
}

test("opt-in bridge refresh preserves a busy old process, then upgrades it without changing profile or history", { timeout: 40000 }, async t => {
  const directory = profile(t), home = path.join(directory, "profile"), oldRoot = path.join(directory, "old");
  fs.mkdirSync(home); fs.mkdirSync(oldRoot);
  fs.cpSync(path.join(root, "bridge"), path.join(oldRoot, "bridge"), { recursive: true });
  fs.cpSync(path.join(root, "tools"), path.join(oldRoot, "tools"), { recursive: true });
  fs.writeFileSync(path.join(oldRoot, "bridge", "old-build.json"), '{}');
  const sdk = syntheticCopilotMetadata(oldRoot, home, [{ id: "gpt-test", billing: { tokenPrices: { maxPromptTokens: 32000 } } }]);
  fs.writeFileSync(path.join(home, "copilot-cli-models.json"), JSON.stringify({ fetched_at: new Date().toISOString(), models: [{ id: "gpt-test", default_prompt_tokens: 32000 }] }));
  fs.writeFileSync(path.join(home, "config.toml"), '# existing profile sentinel\nmodel = "gpt-test"\nmodel_reasoning_effort = "low"\n');
  fs.mkdirSync(path.join(home, "sessions")); fs.writeFileSync(path.join(home, "sessions/history.jsonl"), 'existing history\n');
  let release; const held = new Promise(resolve => { release = resolve; });
  let reached; const inference = new Promise(resolve => { reached = resolve; });
  const upstream = http.createServer(async (req, res) => {
    if (req.url === "/models") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "gpt-test", name: "Fixture", vendor: "OpenAI",
        model_picker_enabled: true, is_chat_default: true, supported_endpoints: ["/responses"], capabilities: { type: "chat",
          supports: { reasoning_effort: ["low"] }, limits: { max_prompt_tokens: 32000, max_context_window_tokens: 40000, max_output_tokens: 1024 } } }] }));
    } else if (req.url === "/user") res.writeHead(200, { "content-type": "application/json" }).end('{"login":"fixture"}');
    else if (req.url === "/responses") {
      for await (const _chunk of req) {}
      reached(); await held;
      res.writeHead(200, { "content-type": "application/json" }).end('{"id":"fixture-response","output":[],"usage":{}}');
    } else res.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  const reserve = http.createServer(); const port = await listen(reserve); await new Promise(resolve => reserve.close(resolve));
  const env = { ...process.env, CODEX_HOME: home, CODEX_COPILOT_HOME: home, CODEX_COPILOT_BRIDGE_HOST: "127.0.0.1", CODEX_COPILOT_BRIDGE_PORT: String(port),
    CODEX_COPILOT_AUTH_MODE: "environment", CODEX_COPILOT_GITHUB_TOKEN: "isolated-placeholder-not-a-github-credential", GH_TOKEN: "", GITHUB_TOKEN: "",
    CODEX_COPILOT_CLI_SDK: sdk.sdkPath, NODE_OPTIONS: sdk.nodeArguments.join(" "), CODEX_COPILOT_MODEL_SAMPLES: "1",
    CODEX_COPILOT_API_BASE: `http://127.0.0.1:${upstreamPort}`, CODEX_COPILOT_GITHUB_API_BASE: `http://127.0.0.1:${upstreamPort}` };
  const old = spawn(process.execPath, [path.join(oldRoot, "bridge/server.mjs")], { env, stdio: "ignore" });
  const ensure = flags => command([path.join(root, "bridge/ensure.mjs"), ...flags], env);
  let pending;
  try {
    const before = await bridgeStatus(port, value => value.pid === old.pid);
    assert.notEqual(before.runtime.sourceGeneration, bridgeSourceGeneration());
    // Normal catalog initialization may select a model in this private bridge
    // profile. Retirement must preserve the established profile verbatim.
    const establishedProfile = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    pending = fetch(`http://127.0.0.1:${port}/responses`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: false, input: "isolated busy sentinel" }), signal: AbortSignal.timeout(20000) });
    let timeout;
    try { await Promise.race([inference, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Fixture inference was not reached")), 10000); })]); }
    finally { clearTimeout(timeout); }
    const busy = await ensure(["--refresh-idle"]);
    assert.equal(busy.code, 1); assert.match(busy.output, /busy|active requests/i);
    assert.equal((await bridgeStatus(port, value => value.pid === old.pid)).activeRequests, 1);
    const preserved = await ensure(["--preserve-running"]);
    assert.equal(preserved.code, 0, preserved.output);
    assert.match(preserved.output, /update pending/);
    assert.equal((await bridgeStatus(port, value => value.pid === old.pid)).activeRequests, 1,
      "Desktop readiness must preserve the compatible in-flight API bridge instead of requiring its upgrade");
    const recordFile = path.join(home, `bridge-${port}.json`), recordText = fs.readFileSync(recordFile, "utf8");
    const record = JSON.parse(recordText);
    fs.writeFileSync(recordFile, JSON.stringify({ ...record, runtime: { ...record.runtime, instanceId: "another-instance" } }), { mode: 0o600 });
    try { assert.equal((await ensure(["--preserve-running"])).code, 1, "A different instance record cannot authorize reuse"); }
    finally { fs.writeFileSync(recordFile, recordText, { mode: 0o600 }); }
    release(); assert.equal((await pending).status, 200);
    const ordinary = await ensure([]); assert.equal(ordinary.code, 1); assert.match(ordinary.output, /running older or different code/);
    const upgraded = await ensure(["--refresh-idle"]); assert.equal(upgraded.code, 0, upgraded.output);
    const after = await bridgeStatus(port, value => value.runtime.sourceGeneration === bridgeSourceGeneration());
    assert.notEqual(after.pid, old.pid); assert.notEqual(after.runtime.instanceId, before.runtime.instanceId);
    assert.equal(old.exitCode, 0);
    assert.equal((await ensure(["--refresh-idle"])).code, 0);
    assert.equal((await bridgeStatus(port, value => value.pid === after.pid)).runtime.instanceId, after.runtime.instanceId);
    assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), establishedProfile);
    assert.equal(fs.readFileSync(path.join(home, "sessions/history.jsonl"), "utf8"), 'existing history\n');
  } finally {
    release(); await pending?.catch(() => {});
    await command([path.join(root, "bridge/control.mjs"), "stop"], env);
    if (old.exitCode === null && old.signalCode === null) old.kill();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test("expected bridge instance changing before retirement never receives a stop request", async t => {
  const home = profile(t); let stops = 0;
  const server = http.createServer((req, res) => {
    if (req.url !== "/health") { stops++; res.writeHead(500).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ bridge: "codex-copilot", pid: process.pid,
      runtime: { controlProtocol: 1, instanceId: "replacement-instance", sourceGeneration: "other-generation" } }));
  });
  const port = await listen(server);
  try {
    const result = await command(["--input-type=module", "-e", `import {stopBridge} from './bridge/control.mjs';
      await stopBridge({quiet:true,expectedInstance:{pid:${process.pid},runtime:{instanceId:'previous-instance',sourceGeneration:'old-generation'}}});`],
      { ...process.env, CODEX_COPILOT_HOME: home, CODEX_COPILOT_BRIDGE_PORT: String(port), CODEX_COPILOT_BRIDGE_HOST: "127.0.0.1" });
    assert.equal(result.code, 1); assert.match(result.output, /instance changed/i); assert.equal(stops, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

for (const controlProtocol of [undefined, 2]) {
  test(`opt-in refresh never signals a bridge with ${controlProtocol === undefined ? "legacy" : "unknown"} control protocol`, async t => {
    const home = profile(t); let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ bridge: "codex-copilot", pid: process.pid,
        runtime: { controlProtocol, instanceId: "unsupported", sourceGeneration: "old-generation" } }));
    });
    const port = await listen(server);
    try {
      const result = await command([path.join(root, "bridge/ensure.mjs"), "--refresh-idle"],
        { ...process.env, CODEX_COPILOT_HOME: home, CODEX_COPILOT_BRIDGE_PORT: String(port), CODEX_COPILOT_BRIDGE_HOST: "127.0.0.1" });
      assert.equal(result.code, 1); assert.match(result.output, /安全控制协议/); assert.equal(requests, 1);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
}
