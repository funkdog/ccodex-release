import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { configure, END_MARKER, paths } from "../bridge/workiq/settings.mjs";
import { acquireCacheLock } from "../bridge/workiq/cache.mjs";
import { LoginRequiredError } from "../bridge/workiq/auth.mjs";
import { createWorkIqServer, STATUS_TOOL, ACTION_STATUS_TOOL, CALL_TOOL, TRANSCRIPT_GUIDANCE } from "../bridge/workiq/server.mjs";
import { runtimeImport } from "../bridge/workiq/dependencies.mjs";

const dependencyProfile = process.env.WORKIQ_TEST_DEPENDENCY_PROFILE;
const runtimeOptions = { skip: !dependencyProfile, timeout: 15_000 };
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-workiq-startup-test-"));
const root = path.resolve(import.meta.dirname, "..");
const localNames = [STATUS_TOOL, ACTION_STATUS_TOOL, CALL_TOOL];
const cloudTool = {
  name: "synthetic_read",
  description: "SYNTHETIC TEST ONLY",
  inputSchema: { type: "object", properties: { exactId: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
let profileNumber = 0;
function profile() {
  const directory = path.join(testRoot, `profile-${++profileNumber}`);
  fs.mkdirSync(directory);
  return directory;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function within(promise, milliseconds = 2000, label = "Isolated startup operation") {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its bound.`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixture(t, { connect, listTools, identity = {}, tools } = {}) {
  const home = profile();
  configure({ profile: home, enable: true, acknowledge: true });
  const [{ Server }, { Client }, { InMemoryTransport }, types] = await Promise.all([
    runtimeImport("@modelcontextprotocol/sdk/server/index.js", dependencyProfile),
    runtimeImport("@modelcontextprotocol/sdk/client/index.js", dependencyProfile),
    runtimeImport("@modelcontextprotocol/sdk/inMemory.js", dependencyProfile),
    runtimeImport("@modelcontextprotocol/sdk/types.js", dependencyProfile),
  ]);
  const remote = {
    client: null, connectCalls: 0, listCalls: 0, closeCalls: 0, calls: [],
    instructions: "SYNTHETIC UPSTREAM GUIDANCE: preserve exact evidence.",
    ...(tools ? { tools } : {}),
    async connect() {
      this.connectCalls++;
      await connect?.();
      this.client = {};
    },
    async listTools() {
      this.listCalls++;
      return listTools ? await listTools() : [cloudTool];
    },
    async callTool(params) {
      this.calls.push(params);
      return { content: [{ type: "text", text: "SYNTHETIC DISPATCH RESULT" }] };
    },
    async close() { this.closeCalls++; this.client = null; },
  };
  const instance = await createWorkIqServer({
    profile: home, identity, upstream: remote, sdk: { Server, types }, catalogWaitMs: 20,
  });
  const client = new Client({ name: "isolated-startup-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await instance.close();
  });
  await instance.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { home, instance, client, remote, types };
}

test("MCP initialization does not attempt authentication or upstream discovery", runtimeOptions, async t => {
  const pair = await within(fixture(t, { connect: () => { throw new Error("Upstream is offline."); } }));
  assert.equal(pair.remote.connectCalls, 0);
  assert.equal(pair.remote.listCalls, 0);
  assert.equal(pair.instance.status().authentication, "not_checked");
  assert.deepEqual(pair.instance.status().currentTools, []);
});

test("transcript guidance is visible at initialization and explicit VTT paths pass through unchanged", runtimeOptions, async t => {
  const blobTool = {
    name: "fetch_blob",
    description: "SYNTHETIC READ ONLY",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    annotations: { readOnlyHint: true, destructiveHint: false },
  };
  const { client, remote } = await fixture(t, { tools: [blobTool] });
  assert.ok(client.getInstructions().includes(TRANSCRIPT_GUIDANCE));
  const catalog = await client.listTools();
  assert.ok(catalog.tools.find(tool => tool.name === STATUS_TOOL).description.includes(TRANSCRIPT_GUIDANCE));
  const resource = "/users/SYNTHETIC/onlineMeetings/MEETING+ID==/transcripts/TRANSCRIPT+ID==/content?$format=text%2Fvtt";
  await client.callTool({
    name: CALL_TOOL, arguments: { name: blobTool.name, arguments: { path: resource } },
  });
  assert.equal(remote.calls.length, 1);
  assert.equal(remote.calls[0].name, blobTool.name);
  assert.deepEqual(remote.calls[0].arguments, { path: resource });
  assert.match(TRANSCRIPT_GUIDANCE, /permission denial ends the workflow/);
});

test("slow authentication leaves local tools responsive and shares one pending discovery", runtimeOptions, async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const { client, instance, remote, types } = await fixture(t, { connect: () => gate.promise });
  const changed = deferred();
  let notifications = 0;
  client.setNotificationHandler(types.ToolListChangedNotificationSchema, () => {
    notifications++;
    changed.resolve();
  });
  const [catalog, response] = await within(Promise.all([
    client.listTools(),
    client.callTool({ name: STATUS_TOOL, arguments: {} }),
  ]));
  assert.deepEqual(catalog.tools.map(tool => tool.name), localNames);
  const state = JSON.parse(response.content[0].text);
  assert.equal(state.connecting, true);
  assert.equal(state.connected, false);
  assert.equal(remote.connectCalls, 1);
  assert.equal(remote.listCalls, 0);

  gate.resolve();
  await within(changed.promise);
  const ready = await client.listTools();
  assert.deepEqual(ready.tools.map(tool => tool.name), [...localNames, cloudTool.name]);
  assert.deepEqual(ready.tools[3], cloudTool);
  assert.match(ready.tools[0].description, /SYNTHETIC UPSTREAM GUIDANCE/);
  assert.equal(instance.status().upstreamInstructions, remote.instructions);
  await Promise.all([client.listTools(), client.listTools(), client.listTools()]);
  assert.equal(remote.connectCalls, 1, "A list-changed notification must not start another discovery loop.");
  assert.equal(remote.listCalls, 1);
  assert.equal(notifications, 1);
  const schemas = JSON.parse((await client.callTool({
    name: STATUS_TOOL, arguments: { include_tool_schemas: true },
  })).content[0].text);
  assert.deepEqual(schemas.toolSchemas, [cloudTool]);
  const result = await client.callTool({
    name: CALL_TOOL, arguments: { name: cloudTool.name, arguments: { exactId: "A/B+==" } },
  });
  assert.equal(result.content[0].text, "SYNTHETIC DISPATCH RESULT");
  assert.equal(remote.calls[0].name, cloudTool.name);
  assert.deepEqual(remote.calls[0].arguments, { exactId: "A/B+==" });
});

test("a stalled remote tools/list cannot block local tools/list or status", runtimeOptions, async t => {
  const gate = deferred();
  t.after(() => gate.resolve([cloudTool]));
  const { client, remote, types } = await fixture(t, { listTools: () => gate.promise });
  const changed = deferred();
  client.setNotificationHandler(types.ToolListChangedNotificationSchema, () => changed.resolve());
  const catalog = await within(client.listTools());
  const response = await within(client.callTool({ name: STATUS_TOOL, arguments: {} }));
  assert.deepEqual(catalog.tools.map(tool => tool.name), localNames);
  assert.equal(JSON.parse(response.content[0].text).connecting, true);
  assert.equal(remote.listCalls, 1);
  gate.resolve([cloudTool]);
  await within(changed.promise);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), [...localNames, cloudTool.name]);
});

test("failed discovery retains local diagnostics and does not repeatedly reconnect on catalog reads", runtimeOptions, async t => {
  const { client, remote } = await fixture(t, {
    connect: () => { throw new LoginRequiredError("stale_cache_lock"); },
  });
  for (let index = 0; index < 3; index++) {
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), localNames);
  }
  assert.equal(remote.connectCalls, 1);
  const response = await client.callTool({ name: STATUS_TOOL, arguments: {} });
  const state = JSON.parse(response.content[0].text);
  assert.equal(state.lastError.code, "stale_cache_lock");
  assert.match(state.lastError.message, /do not delete the encrypted cache/);
  assert.equal(state.connected, false);
  assert.equal(state.authentication, "not_checked");
  assert.deepEqual(state.currentTools, []);
  assert.equal(remote.connectCalls, 2, "An explicit status request may retry once.");
});

test("the initial upstream catalog is not redundantly fetched a second time", runtimeOptions, async t => {
  const { client, remote } = await fixture(t, {
    tools: [cloudTool],
    listTools: () => { throw new Error("connect() already supplied this catalog."); },
  });
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), [...localNames, cloudTool.name]);
  assert.equal(remote.connectCalls, 1);
  assert.equal(remote.listCalls, 0);
});

test("the compatibility dispatcher rejects local recursion, unknown tools and malformed arguments", runtimeOptions, async t => {
  const { client, remote } = await fixture(t);
  await client.listTools();
  for (const input of [
    { name: CALL_TOOL, arguments: {} },
    { name: STATUS_TOOL, arguments: {} },
    { name: "not_discovered", arguments: {} },
    { name: cloudTool.name, arguments: [] },
    { name: cloudTool.name },
  ]) {
    const result = await client.callTool({ name: CALL_TOOL, arguments: input });
    assert.equal(result.isError, true);
  }
  assert.deepEqual(remote.calls, []);
});

test("account changes immediately invalidate a cached catalog even during an in-flight refresh", runtimeOptions, async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  let accountChanged = false;
  let stall = false;
  const { client, instance, remote } = await fixture(t, {
    identity: {
      assertCurrentSelection() {
        if (accountChanged) throw new LoginRequiredError("account_changed_refresh_mcp");
      },
    },
    connect: () => stall ? gate.promise : undefined,
  });
  await client.listTools();
  stall = true;
  await within(client.callTool({ name: STATUS_TOOL, arguments: {} }));
  accountChanged = true;
  assert.deepEqual((await within(client.listTools())).tools.map(tool => tool.name), localNames);
  gate.resolve();
  await delay(25);
  assert.deepEqual(instance.status().currentTools, []);
  assert.equal(instance.status().lastError.code, "account_changed_refresh_mcp");
  assert.equal(remote.client, null);
});

test("disabling during a pending connection discards its late result", runtimeOptions, async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const { home, client, instance, remote } = await fixture(t, { connect: () => gate.promise });
  await client.listTools();
  configure({ profile: home, enable: false });
  gate.resolve();
  await delay(25);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), localNames);
  assert.deepEqual(instance.status().currentTools, []);
  assert.equal(instance.status().lastError.code, "integration_disabled");
  assert.equal(remote.listCalls, 0);
  assert.equal(remote.client, null);
});

test("closing during pending discovery prevents late tools or connections from being resurrected", runtimeOptions, async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const { client, instance, remote } = await fixture(t, { connect: () => gate.promise });
  await client.listTools();
  await within(instance.close());
  gate.resolve();
  await delay(25);
  assert.equal(remote.client, null);
  assert.equal(remote.listCalls, 0);
  assert.deepEqual(instance.status().currentTools, []);
  assert.equal(instance.status().connecting, false);
  await instance.close();
});

test("unavailable stale-lock recovery is reported without deleting the encrypted cache or lock", () => {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    windowsHide: true, encoding: "utf8", timeout: 5000,
  });
  assert.equal(child.status, 0, child.stderr);
  const deadPid = Number(child.stdout);
  assert.ok(Number.isInteger(deadPid) && deadPid > 0);
  const file = paths(profile()).cache;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "SYNTHETIC ENCRYPTED CACHE");
  const lock = JSON.stringify({ pid: deadPid, createdAt: Date.now() });
  fs.writeFileSync(`${file}.lock`, lock);
  return assert.rejects(acquireCacheLock(file, { recover: () => ({ status: "unavailable" }) }), { code: "stale_cache_lock" }).then(() => {
    assert.equal(fs.readFileSync(file, "utf8"), "SYNTHETIC ENCRYPTED CACHE");
    assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), lock);
  });
});

test("native host initializes before a slow upstream and retains a stable compatibility dispatcher", {
  skip: !dependencyProfile || !process.env.CCODEX_WORKIQ_NATIVE_CORE, timeout: 180_000,
}, async t => {
  const home = profile();
  fs.writeFileSync(paths(home).config, [
    'model = "synthetic-model"',
    'model_provider = "synthetic-provider"',
    'check_for_update_on_startup = false',
    'cli_auth_credentials_store = "file"',
    'mcp_oauth_credentials_store = "file"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '[model_providers.synthetic-provider]',
    'name = "Synthetic test provider"',
    'base_url = "http://127.0.0.1:1"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '[features]',
    'apps = false',
    'plugins = false',
    'remote_plugin = false',
    "",
  ].join("\n"));
  configure({
    profile: home, enable: true, acknowledge: true,
    entry: path.join(root, "tests", "fixtures", "workiq", "startup-mcp-server.mjs"),
  });
  const config = fs.readFileSync(paths(home).config, "utf8")
    .replace("startup_timeout_sec = 45", "startup_timeout_sec = 15")
    .replace(END_MARKER, [
      `WORKIQ_TEST_DEPENDENCY_PROFILE = ${JSON.stringify(dependencyProfile)}`,
      'WORKIQ_REQUIRE_RUNTIME_TESTS = "1"',
      END_MARKER,
    ].join("\n"));
  fs.writeFileSync(paths(home).config, config);
  const env = { ...process.env, CODEX_HOME: home, CODEX_COPILOT_HOME: home, CODEX_COPILOT_AUTH_MODE: "saved" };
  for (const key of Object.keys(env)) {
    if (/(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY)(?:$|_)/i.test(key)) delete env[key];
  }
  const child = spawn(process.env.CCODEX_WORKIQ_NATIVE_CORE, ["app-server"], {
    env, cwd: home, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  t.diagnostic(`Isolated slow-start native host PID: ${child.pid}`);
  const pending = new Map();
  let buffer = "";
  let errors = "";
  let nextId = 0;
  let threadId = null;
  const closed = new Promise(resolve => child.once("close", resolve));
  child.on("error", error => {
    for (const waiter of pending.values()) waiter.reject(error);
  });
  child.once("exit", code => {
    for (const waiter of pending.values()) waiter.reject(new Error(`Isolated host exited (${code}): ${errors.slice(-1500)}`));
    pending.clear();
  });
  child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-8000); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`${JSON.stringify(message.error)}\n${errors.slice(-2000)}`));
        else waiter.resolve(message.result);
      }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Isolated host request timed out: ${method}. ${errors.slice(-1500)}`));
    }, 30_000);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    await request("initialize", {
      clientInfo: { name: "workiq-slow-start-test", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
    const first = (await request("mcpServerStatus/list", {})).data.find(item => item.name === "workiq");
    assert.ok(first, "The local adapter must initialize despite the delayed upstream.");
    assert.deepEqual(Object.keys(first.tools).sort(), [...localNames].sort());
    assert.ok(first.tools[CALL_TOOL], "Older hosts need a stable dispatcher because they do not refresh late tool-list notifications.");
    assert.match(first.tools[CALL_TOOL].description, /user-only approval queue/);
    assert.deepEqual(first.tools[CALL_TOOL].inputSchema.required, ["name", "arguments"]);
    const started = await request("thread/start", { cwd: home });
    threadId = started.thread.id;
    let state;
    const deadline = Date.now() + 30_000;
    do {
      const response = await request("mcpServer/tool/call", {
        threadId, server: "workiq", tool: STATUS_TOOL, arguments: { include_tool_schemas: true },
      });
      state = JSON.parse(response.content[0].text);
      if (state.toolSchemas.some(tool => tool.name === "synthetic_delayed_read")) break;
      await delay(100);
    } while (Date.now() < deadline);
    assert.ok(state.toolSchemas.some(tool => tool.name === "synthetic_delayed_read"));
    const result = await request("mcpServer/tool/call", {
      threadId, server: "workiq", tool: CALL_TOOL,
      arguments: { name: "synthetic_delayed_read", arguments: {} },
    });
    assert.notEqual(result.isError, true);
    assert.equal(result.content[0].text, "SYNTHETIC DELAYED RESULT");
    t.diagnostic("A twenty-second simulated upstream delay did not exhaust the fifteen-second startup budget; the native host invoked the late tool through the stable dispatcher.");
  } finally {
    try {
      if (threadId) {
        const result = await request("thread/unsubscribe", { threadId });
        assert.equal(result.status, "unsubscribed");
      }
    } finally {
      child.stdin.end();
      const shutdownStarted = Date.now();
      await within(closed, 60_000, "Isolated native host shutdown");
      assert.equal(child.exitCode, 0, errors);
      t.diagnostic(`Isolated slow-start native host PID ${child.pid} exited in ${Date.now() - shutdownStarted} ms.`);
    }
  }
});

test.after(async () => {
  const resolved = fs.realpathSync(testRoot);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.match(path.basename(resolved), /^ccodex-workiq-startup-test-/);
  await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
});
