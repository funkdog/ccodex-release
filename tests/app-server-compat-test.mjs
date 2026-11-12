import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import test from "node:test";
import { encodeEvents, responsesBridge, rotatingEvents } from "./fixtures/responses-bridge.mjs";

const nativeCore = process.env.CCODEX_TEST_NATIVE_CORE;
const liveCores = new Map();
const recoveryCores = [
  ["native Desktop", nativeCore],
  ["pinned CLI", process.env.CCODEX_TEST_CLI_CORE],
];

export async function appServer(core, home, t) {
  const env = { ...process.env, CODEX_HOME: home, CODEX_COPILOT_HOME: home };
  for (const key of Object.keys(env)) {
    if (/(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY)(?:$|_)/i.test(key)
      || ["CODEX_WINDOWS_REGISTERED_CORE", "CODEX_CLI_PATH"].includes(key)) delete env[key];
  }
  const child = spawn(core, ["app-server"], { cwd: home, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  liveCores.set(child, home);
  t.diagnostic(`Isolated app-server PID ${child.pid}; home ${home}`);
  const pending = new Map();
  const notifications = [];
  let nextId = 0;
  let buffer = "";
  let errors = "";
  let startupError = null;
  const closed = new Promise(resolve => {
    child.once("error", error => { startupError = error; resolve(); });
    child.once("close", (code, signal) => {
      liveCores.delete(child);
      for (const request of pending.values()) request.reject(new Error(`App-server exited ${code}/${signal}: ${errors.slice(-2000)}`));
      resolve();
    });
  });
  child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-16000); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      } else notifications.push(message);
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (startupError) { reject(startupError); return; }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`App-server timeout ${method}: ${errors.slice(-2000)}`));
    }, 60000);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  return {
    request, notifications, child,
    diagnostics() {
      return { pid: child.pid, exitCode: child.exitCode, stderr: errors,
        notifications: notifications.slice(-30) };
    },
    async close() {
      child.stdin.end();
      let timer;
      try {
        await Promise.race([
          closed,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(
            `Owned test process ${child.pid} did not exit; no live process was killed. ${errors.slice(-6000)}`,
          )), 20000); }),
        ]);
      } finally { clearTimeout(timer); }
      if (startupError) throw startupError;
      assert.equal(child.exitCode, 0, errors);
      t.diagnostic(`App-server PID ${child.pid} exited; pipes closed.`);
    },
  };
}

function createProfile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-appserver-compat-"));
  t.after(async () => {
    assert.ok(![...liveCores.values()].includes(root), `Preserving ${root}: an isolated core is still running.`);
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  fs.writeFileSync(path.join(root, "config.toml"), [
    'model = "synthetic-model"',
    'model_provider = "synthetic"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'cli_auth_credentials_store = "file"',
    'mcp_oauth_credentials_store = "file"',
    'check_for_update_on_startup = false',
    '[model_providers.synthetic]',
    'name = "Isolated synthetic provider"',
    'base_url = "http://127.0.0.1:1"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '[features]',
    'plugins = false',
    'remote_plugin = false',
    'apps = false',
    'item_ids = true',
    '[desktop]',
    'conversationDetailMode = "STEPS_EXECUTION"',
    "",
  ].join("\n"));
  return root;
}

async function observeSseWire(bridgeUrl) {
  const frames = [];
  const active = new Set();
  let lastFrameAt;
  let maxFrameGapMs = 0;
  const server = http.createServer((req, res) => {
    let buffer = "";
    const decoder = new TextDecoder();
    const upstreamRequest = http.request(new URL(req.url, bridgeUrl), {
      method: req.method, headers: req.headers,
    }, upstream => {
      res.writeHead(upstream.statusCode, upstream.headers);
      lastFrameAt = performance.now();
      upstream.on("data", chunk => {
        buffer += decoder.decode(chunk, { stream: true });
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const now = performance.now();
          maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrameAt);
          lastFrameAt = now;
          const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).trimStart()).join("\n");
          try { frames.push({ type: JSON.parse(data).type, at: now }); } catch {}
        }
      });
      upstream.on("error", error => res.destroy(error));
      upstream.pipe(res);
    });
    active.add(upstreamRequest);
    upstreamRequest.on("close", () => active.delete(upstreamRequest));
    upstreamRequest.on("error", error => res.destroy(error));
    req.on("aborted", () => upstreamRequest.destroy());
    res.on("close", () => upstreamRequest.destroy());
    req.pipe(upstreamRequest);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    diagnostics: () => ({
      frames: frames.length, pings: frames.filter(frame => frame.type === "ping").length,
      maxFrameGapMs, lastEvent: frames.at(-1)?.type || null,
    }),
    async close() {
      for (const request of active) request.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function legacyFixture(home) {
  const id = randomUUID();
  const turnId = randomUUID();
  const now = new Date().toISOString();
  const rows = [];
  const record = (type, payload) => rows.push({ timestamp: now, type, payload });
  record("session_meta", {
    id, session_id: id, timestamp: now, cwd: home, originator: "ccodex-test",
    cli_version: "0.145.0", source: "cli", model_provider: "synthetic",
    base_instructions: { text: "Synthetic test only." }, history_mode: "legacy",
  });
  record("event_msg", { type: "task_started", turn_id: turnId, model_context_window: 100000 });
  record("event_msg", { type: "user_message", message: "Read-only compatibility test.", images: [], local_images: [], text_elements: [] });
  record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Read-only compatibility test." }] });
  const commentary = "Synthetic repeated text must not be deduplicated across distinct messages.";
  function message(phase, messageId, text) {
    record("event_msg", { type: "agent_message", message: text, phase });
    record("response_item", { type: "message", id: messageId, role: "assistant", phase, content: [{ type: "output_text", text }] });
  }
  message("commentary", "msg_first", commentary);
  record("event_msg", {
    type: "mcp_tool_call_end", call_id: "call_synthetic",
    invocation: { server: "synthetic", tool: "read", arguments: { value: 1 } },
    duration: { secs: 0, nanos: 1000 },
    result: { Ok: { content: [{ type: "text", text: "SYNTHETIC_TOOL_OUTPUT" }], isError: false } },
  });
  message("commentary", "msg_second", commentary);
  message("final_answer", "msg_final", "Synthetic final answer.");
  record("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: "Synthetic final answer." });
  const dir = path.join(home, "sessions", ...now.slice(0, 10).split("-"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${now.slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`);
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return { id, file, commentary };
}

function paginatedFixture(home) {
  const id = randomUUID();
  const turnId = randomUUID();
  const now = new Date().toISOString();
  const rows = [];
  const record = (type, payload) => rows.push({ timestamp: now, ordinal: rows.length, type, payload });
  record("session_meta", {
    id, session_id: id, timestamp: now, cwd: home, originator: "codex-tui",
    cli_version: "0.145.0", source: "cli", model_provider: "synthetic",
    base_instructions: { text: "Synthetic test only." }, history_mode: "paginated",
    context_window: { window_id: randomUUID() },
  });
  record("event_msg", { type: "task_started", turn_id: turnId, model_context_window: 100000 });
  const commentary = "Synthetic reproduction of the reported duplicate commentary.";
  function message(index, phase, text) {
    // The failed task used a short event ID and an unrelated opaque wire ID.
    record("event_msg", {
      type: "item_completed", thread_id: id, turn_id: turnId,
      item: { type: "AgentMessage", id: `msg_${index}`, content: [{ type: "Text", text }], phase },
      completed_at_ms: Date.now(),
    });
    record("response_item", {
      type: "message", id: `opaque_wire_message_${index}`, role: "assistant",
      content: [{ type: "output_text", text }], phase,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    });
  }
  message(1, "commentary", commentary);
  message(2, "commentary", commentary);
  message(3, "final_answer", "Synthetic final answer.");
  record("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: "Synthetic final answer." });
  const dir = path.join(home, "sessions", ...now.slice(0, 10).split("-"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${now.slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`);
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return { id, commentary };
}

test("reported paginated history keeps one item per message despite different event and wire IDs", {
  skip: !nativeCore,
}, async t => {
  const home = createProfile(t);
  const fixture = paginatedFixture(home);
  const rpc = await appServer(nativeCore, home, t);
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "ccodex-reported-duplicate-test", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.child.stdin.write('{"method":"initialized","params":{}}\n');
    const read = await rpc.request("thread/read", { threadId: fixture.id, includeTurns: false });
    assert.equal(read.thread.historyMode, "paginated");
    // Opening a synthetic rollout materializes the native paginated projection.
    // No turn is started, and the original user session is never loaded.
    await rpc.request("thread/resume", { threadId: fixture.id, excludeTurns: true });
    const page = await rpc.request("thread/items/list", { threadId: fixture.id, limit: 100, sortDirection: "asc" });
    assert.equal(page.nextCursor, null);
    const messages = page.data.map(entry => entry.item).filter(item => item.type === "agentMessage");
    assert.deepEqual(messages.map(item => item.text), [fixture.commentary, fixture.commentary, "Synthetic final answer."]);
    assert.equal(new Set(messages.map(item => item.id)).size, 3);
    const reread = await rpc.request("thread/items/list", { threadId: fixture.id, limit: 100, sortDirection: "asc" });
    assert.deepEqual(reread.data, page.data);
    const turns = await rpc.request("thread/turns/list", { threadId: fixture.id, itemsView: "full", limit: 10 });
    assert.deepEqual(turns.data.flatMap(turn => turn.items).filter(item => item.type === "agentMessage"), messages);
  } finally { await rpc.close(); }
});

test("native Desktop core reads legacy paired events once while preserving genuine repeats and tool output", {
  skip: !nativeCore,
}, async t => {
  const home = createProfile(t);
  const fixture = legacyFixture(home);
  const rpc = await appServer(nativeCore, home, t);
  try {
    const initialized = await rpc.request("initialize", {
      clientInfo: { name: "ccodex-compatibility-test", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    t.diagnostic(`Native initialization: ${JSON.stringify(initialized)}`);
    rpc.child.stdin.write('{"method":"initialized","params":{}}\n');
    const config = await rpc.request("config/read", { includeLayers: false, cwd: home });
    assert.ok(JSON.stringify(config).includes("STEPS_EXECUTION"));
    const read = await rpc.request("thread/read", { threadId: fixture.id, includeTurns: true });
    const items = read.thread.turns.flatMap(turn => turn.items || []);
    const messages = items.filter(item => item.type === "agentMessage");
    assert.deepEqual(messages.map(item => item.text), [fixture.commentary, fixture.commentary, "Synthetic final answer."]);
    assert.equal(new Set(messages.map(item => item.id)).size, 3);
    const tool = items.find(item => item.type === "mcpToolCall");
    assert.ok(tool, JSON.stringify(items));
    assert.ok(JSON.stringify(tool).includes("SYNTHETIC_TOOL_OUTPUT"));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reread = await rpc.request("thread/read", { threadId: fixture.id, includeTurns: true });
      assert.deepEqual(reread.thread.turns, read.thread.turns);
    }
  } finally { await rpc.close(); }
});

test("live canonical messages survive history hydration and resume without a second identity", {
  skip: !nativeCore,
}, async t => {
  const home = createProfile(t);
  const messages = [
    { type: "message", id: "msg_commentary_fixture", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "SYNTHETIC_PROGRESS" }] },
    { type: "message", id: "msg_final_fixture", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "SYNTHETIC_DONE" }] },
  ];
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain synthetic request; never persist prompts. */ }
    if (!req.url.startsWith("/responses")) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    emit({ type: "response.created", response: { id: "resp_synthetic" } });
    for (const [output_index, item] of messages.entries()) {
      emit({ type: "response.output_item.added", output_index, item: { ...item, content: [] } });
      emit({ type: "response.output_text.delta", item_id: item.id, output_index, content_index: 0, delta: item.content[0].text });
      emit({ type: "response.output_item.done", output_index, item });
    }
    emit({ type: "response.completed", response: { id: "resp_synthetic", status: "completed", output: messages,
      usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } });
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("http://127.0.0.1:1", `http://127.0.0.1:${server.address().port}`));
  const rpc = await appServer(nativeCore, home, t);
  try {
    await rpc.request("initialize", { clientInfo: { name: "ccodex-stream-test", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    rpc.child.stdin.write('{"method":"initialized","params":{}}\n');
    const started = await rpc.request("thread/start", {
      cwd: home, historyMode: "paginated", model: "synthetic-model",
      baseInstructions: "Synthetic test. No tools.", developerInstructions: "",
      config: { "features.shell_tool": false, "features.web_search": false },
    });
    const id = started.thread.id;
    await rpc.request("turn/start", { threadId: id, input: [{ type: "text", text: "Synthetic input." }] });
    const deadline = Date.now() + 120000;
    while (!rpc.notifications.some(item => item.method === "turn/completed")) {
      if (Date.now() >= deadline) throw new Error(`No turn completion: ${JSON.stringify(rpc.notifications).slice(-3000)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const complete = rpc.notifications.find(item => item.method === "turn/completed");
    assert.equal(complete.params.turn.status, "completed", JSON.stringify(complete));
    const live = rpc.notifications.filter(item => item.method === "item/completed" && item.params.item.type === "agentMessage")
      .map(item => item.params.item);
    assert.deepEqual(live.map(item => item.text), ["SYNTHETIC_PROGRESS", "SYNTHETIC_DONE"]);
    const page = await rpc.request("thread/turns/list", { threadId: id, limit: 10, itemsView: "full" });
    const persisted = page.data.flatMap(turn => turn.items).filter(item => item.type === "agentMessage");
    assert.deepEqual(persisted.map(item => ({ id: item.id, text: item.text })), live.map(item => ({ id: item.id, text: item.text })));
    const resumed = await rpc.request("thread/resume", { threadId: id, initialTurnsPage: { limit: 10, itemsView: "full" } });
    const hydrated = (resumed.initialTurnsPage?.data || resumed.thread.turns).flatMap(turn => turn.items)
      .filter(item => item.type === "agentMessage");
    assert.deepEqual(hydrated.map(item => ({ id: item.id, text: item.text })), live.map(item => ({ id: item.id, text: item.text })));
  } finally {
    await rpc.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("independent CLI and Desktop cores share live paginated history without a second message identity", {
  skip: !nativeCore,
}, async t => {
  const home = createProfile(t);
  const messages = [
    { type: "message", id: "cross_core_commentary", role: "assistant", phase: "commentary",
      content: [{ type: "output_text", text: "SYNTHETIC_CROSS_CORE_PROGRESS" }] },
    { type: "message", id: "cross_core_final", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "SYNTHETIC_CROSS_CORE_DONE" }] },
  ];
  let finishResponse;
  const release = new Promise(resolve => { finishResponse = resolve; });
  const transport = [];
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* Only synthetic input reaches this local server. */ }
    transport.push({ request: req.url, at: Date.now() });
    if (!req.url.startsWith("/responses")) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = event => {
      transport.push({ event: event.type, at: Date.now() });
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    emit({ type: "response.created", response: { id: "resp_cross_core" } });
    for (const [output_index, item] of messages.entries()) {
      if (output_index === 1) await release;
      if (res.destroyed) return;
      emit({ type: "response.output_item.added", output_index, item: { ...item, content: [] } });
      emit({ type: "response.output_text.delta", item_id: item.id, output_index, content_index: 0, delta: item.content[0].text });
      emit({ type: "response.output_item.done", output_index, item });
    }
    emit({ type: "response.completed", response: { id: "resp_cross_core", status: "completed", output: messages,
      usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } });
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("http://127.0.0.1:1", `http://127.0.0.1:${server.address().port}`));
  const clients = [];
  const connect = async core => {
    const rpc = await appServer(core, home, t);
    clients.push(rpc);
    const identity = await rpc.request("initialize", {
      clientInfo: { name: "ccodex-cross-core-test", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.child.stdin.write('{"method":"initialized","params":{}}\n');
    t.diagnostic(`Cross-core client: ${identity.userAgent}`);
    return rpc;
  };
  const waitFor = async (label, check, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${label}: ${JSON.stringify({
          transport, clients: clients.map(client => client.diagnostics()),
        })}`);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const identity = items => items.filter(item => item.type === "agentMessage")
    .map(item => ({ id: item.id, text: item.text, phase: item.phase }));
  try {
    const producer = await connect(process.env.CCODEX_TEST_CLI_CORE || nativeCore);
    const started = await producer.request("thread/start", {
      cwd: home, historyMode: "paginated", model: "synthetic-model",
      baseInstructions: "Synthetic test. No tools.", developerInstructions: "",
      config: { "features.shell_tool": false, "features.web_search": false },
    });
    const threadId = started.thread.id;
    const turn = await producer.request("turn/start", { threadId, input: [{ type: "text", text: "Synthetic input." }] });
    const liveMessages = () => producer.notifications
      .filter(event => event.method === "item/completed" && event.params.item.type === "agentMessage")
      .map(event => event.params.item);
    // Managed session-start hooks can run before the first model request.
    await waitFor("producer commentary", () => liveMessages().length === 1, 120000);
    const consumer = await connect(nativeCore);
    const read = await consumer.request("thread/read", { threadId, includeTurns: false });
    assert.equal(read.thread.historyMode, "paginated");
    const pageItems = async rpc => {
      const items = [];
      const seenCursors = new Set();
      let cursor = null;
      do {
        assert.ok(!seenCursors.has(cursor), "item pagination must advance");
        seenCursors.add(cursor);
        const page = await rpc.request("thread/items/list", {
          threadId, turnId: turn.turn.id, cursor, limit: 1, sortDirection: "asc",
        });
        items.push(...page.data.map(entry => entry.item));
        cursor = page.nextCursor;
      } while (cursor != null);
      return items;
    };
    const inProgress = await waitFor("independent reader's persisted commentary", async () => {
      const items = identity(await pageItems(consumer));
      return items.length ? items : null;
    });
    assert.deepEqual(inProgress, identity(liveMessages()));
    finishResponse();
    const completed = await waitFor("producer turn completion", () =>
      producer.notifications.find(event => event.method === "turn/completed"));
    assert.equal(completed.params.turn.status, "completed");
    assert.deepEqual(identity(liveMessages()).map(item => item.text), messages.map(item => item.content[0].text));
    const finalItems = await waitFor("independent reader's final message", async () => {
      const items = identity(await pageItems(consumer));
      return items.length === 2 ? items : null;
    });
    assert.deepEqual(finalItems, identity(liveMessages()));
    const turns = await consumer.request("thread/turns/list", { threadId, limit: 10, itemsView: "full" });
    assert.deepEqual(identity(turns.data.flatMap(entry => entry.items)), finalItems);
    const reconnected = await connect(nativeCore);
    assert.deepEqual(identity(await pageItems(reconnected)), finalItems);
  } finally {
    finishResponse();
    const results = await Promise.allSettled(clients.map(client => client.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
});

for (const [label, core] of recoveryCores) {
test(`${label}: rotating provider IDs retain one live identity through deltas, completion and hydration`, {
  skip: !core,
}, async t => {
  const home = createProfile(t);
  const bridge = await responsesBridge(home, t, async (_req, res, _body, number) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(encodeEvents(rotatingEvents(`resp_rotating_${number}`)));
  });
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("http://127.0.0.1:1", bridge.url));
  const rpc = await appServer(core, home, t);
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "ccodex-rotating-id-regression", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.child.stdin.write('{"method":"initialized","params":{}}\n');
    const started = await rpc.request("thread/start", {
      cwd: home, historyMode: "paginated", model: "synthetic-model",
      baseInstructions: "Synthetic test. No tools.", developerInstructions: "",
      config: { "features.shell_tool": false, "features.web_search": false },
    });
    const threadId = started.thread.id;
    await rpc.request("turn/start", { threadId, input: [{ type: "text", text: "Synthetic identity input." }] });
    const deadline = Date.now() + 120000;
    while (!rpc.notifications.some(event => event.method === "turn/completed")) {
      if (Date.now() >= deadline) throw new Error(JSON.stringify({
        bridge: bridge.diagnostics(), core: rpc.diagnostics(),
      }));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const completedTurn = rpc.notifications.find(event => event.method === "turn/completed");
    assert.equal(completedTurn.params.turn.status, "completed", JSON.stringify(completedTurn));
    for (const type of ["agentMessage", "reasoning"]) {
      const items = method => rpc.notifications.filter(event =>
        event.method === method && event.params.item.type === type).map(event => event.params.item);
      const starts = items("item/started");
      const ends = items("item/completed");
      assert.equal(starts.length, type === "agentMessage" ? 3 : 1);
      assert.deepEqual(ends.map(item => item.id), starts.map(item => item.id),
        `${type}: completed items must replace the existing live item, not create another identity`);
      const ids = new Set(starts.map(item => item.id));
      for (const event of rpc.notifications.filter(event => event.method.startsWith(
        type === "agentMessage" ? "item/agentMessage/" : "item/reasoning/"))) {
        assert.ok(ids.has(event.params.itemId), `Delta has an orphan identity: ${JSON.stringify(event)}`);
      }
    }
    const live = rpc.notifications.filter(event =>
      event.method === "item/completed" && event.params.item.type === "agentMessage").map(event => event.params.item);
    assert.deepEqual(live.map(item => item.text), [
      "SYNTHETIC_GENUINE_REPEAT", "SYNTHETIC_GENUINE_REPEAT", "SYNTHETIC_FINAL",
    ]);
    const page = await rpc.request("thread/turns/list", { threadId, limit: 10, itemsView: "full" });
    const persisted = page.data.flatMap(turn => turn.items).filter(item => item.type === "agentMessage");
    assert.deepEqual(persisted.map(item => ({ id: item.id, text: item.text })),
      live.map(item => ({ id: item.id, text: item.text })));
    assert.ok(!rpc.diagnostics().stderr.includes("item completed without a recorded start timestamp"));
    await bridge.restart();
    const next = await rpc.request("turn/start", {
      threadId, input: [{ type: "text", text: "Synthetic follow-up after bridge restart." }],
    });
    const followupDeadline = Date.now() + 120000;
    while (!rpc.notifications.some(event => event.method === "turn/completed"
      && event.params.turn.id === next.turn.id)) {
      if (Date.now() >= followupDeadline) throw new Error(JSON.stringify({
        bridge: bridge.diagnostics(), core: rpc.diagnostics(),
      }));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const followup = rpc.notifications.find(event => event.method === "turn/completed"
      && event.params.turn.id === next.turn.id);
    assert.equal(followup.params.turn.status, "completed");
    assert.equal(bridge.requests.length, 2);
    const history = bridge.requests[1].input.filter(item => item.role === "assistant");
    assert.equal(history.length, 3);
    assert.deepEqual(history.map(item => item.id), [
      "resp_rotating_1-opaque-1-completed",
      "resp_rotating_1-opaque-2-completed",
      "resp_rotating_1-opaque-3-completed",
    ], "native history must restore final provider IDs, not send bridge display IDs upstream");
  } finally {
    await rpc.close();
    await bridge.close();
}
});
}

function recoveryEventValues(responseId, text, usage = { input_tokens: 5, output_tokens: 5, total_tokens: 10 }) {
  const item = { id: `${responseId}_message`, type: "message", role: "assistant",
    phase: "final_answer", content: [{ type: "output_text", text }] };
  return [
    { type: "response.created", response: { id: responseId } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: responseId, status: "completed", output: [item],
      usage } },
  ];
}

function recoveryEvents(responseId, text, usage) {
  return encodeEvents(recoveryEventValues(responseId, text, usage));
}

function recoveryStream(route, responseId, text, usage) {
  if (route === "/responses") return recoveryEvents(responseId, text, usage);
  return [
    { id: responseId, choices: [{ index: 0, delta: { content: text } }] },
    { id: responseId, choices: [], usage: {
      prompt_tokens: usage?.input_tokens ?? 5,
      completion_tokens: usage?.output_tokens ?? 5,
      total_tokens: usage?.total_tokens ?? 10,
    } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
}

async function recoveryTurn(rpc, threadId, text) {
  const started = await rpc.request("turn/start", {
    threadId, input: [{ type: "text", text }],
  });
  const deadline = Date.now() + 30000;
  for (;;) {
    const completed = rpc.notifications.find(event =>
      event.method === "turn/completed" && event.params.turn.id === started.turn.id);
    if (completed) return completed.params.turn;
    if (Date.now() >= deadline) throw new Error(JSON.stringify(rpc.diagnostics()));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function initializeRecoveryThread(rpc, home) {
  await rpc.request("initialize", {
    clientInfo: { name: "ccodex-response-recovery", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  rpc.child.stdin.write('{"method":"initialized","params":{}}\n');
  const started = await rpc.request("thread/start", {
    cwd: home, historyMode: "paginated", model: "synthetic-model",
    baseInstructions: "Synthetic protocol test only. No tools.", developerInstructions: "",
    config: { "features.shell_tool": false, "features.web_search": false },
  });
  return started.thread.id;
}

for (const [label, core] of recoveryCores) {
test(`${label}: late completed reasoning retains the next messages and terminal on one upstream request`, {
  skip: !core,
}, async t => {
  const home = createProfile(t);
  const events = rotatingEvents("resp_native_continuous");
  const bridge = await responsesBridge(home, t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(encodeEvents(events.slice(0, 4)));
    await new Promise(resolve => setTimeout(resolve, 70));
    res.end(encodeEvents(events.slice(4)));
  }, { env: {
    CODEX_COPILOT_RESPONSES_CHECKPOINT_MS: "20",
    CODEX_COPILOT_RESPONSES_MAX_CHECKPOINTS: "8",
  } });
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, [
    'model_reasoning_effort = "max"',
    fs.readFileSync(config, "utf8").replace("http://127.0.0.1:1", bridge.url),
  ].join("\n"));
  const rpc = await appServer(core, home, t);
  try {
    const threadId = await initializeRecoveryThread(rpc, home);
    const completed = await recoveryTurn(rpc, threadId, "SYNTHETIC_CONTINUOUS_TASK");
    assert.equal(completed.status, "completed", JSON.stringify(completed));
    assert.equal(bridge.requests.length, 1);
    assert.equal(bridge.requests[0].reasoning.effort, "max");
    const messages = rpc.notifications.filter(event =>
      event.method === "item/completed" && event.params.item.type === "agentMessage");
    assert.deepEqual(messages.map(event => event.params.item.text), [
      "SYNTHETIC_GENUINE_REPEAT", "SYNTHETIC_GENUINE_REPEAT", "SYNTHETIC_FINAL",
    ]);
    const audit = JSON.parse(fs.readFileSync(path.join(bridge.profile, "request-audit-latest.json"), "utf8"));
    assert.equal(audit.status, "complete");
    assert.equal(audit.attempts, 1);
    assert.equal(audit.reasoningCheckpoints, 0);
    t.diagnostic("The actual native core received the late reasoning item, every genuine message and the terminal from one upstream request.");
  } finally {
    await rpc.close();
    await bridge.close();
  }
});

test(`${label}: missing display-identity cache does not block native automatic compaction of complete history`, {
  skip: !core,
}, async t => {
  const home = createProfile(t);
  const marker = "SYNTHETIC_CACHELESS_COMPACTION";
  const bridge = await responsesBridge(home, t, async (_req, res, body, number) => {
    assert.ok((body.input || []).every(item =>
      typeof item.id !== "string" || !item.id.startsWith("ccodex_item_")));
    const compact = JSON.stringify(body.input).includes(marker);
    if (number === 2) {
      assert.equal(compact, true);
      assert.ok(JSON.stringify(body.input).includes("SYNTHETIC_RETAINED_HISTORY"));
    }
    res.writeHead(200, { "content-type": "text/event-stream" }).end(recoveryEvents(
      `resp_cacheless_${number}`,
      compact ? "SYNTHETIC_CACHELESS_SUMMARY" : "SYNTHETIC_RETAINED_HISTORY",
      number === 1 ? { input_tokens: 95000, output_tokens: 5, total_tokens: 95005 } : undefined,
    ));
  });
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, [
    `compact_prompt = "${marker}"`,
    "model_context_window = 100000",
    fs.readFileSync(config, "utf8").replace("http://127.0.0.1:1", bridge.url),
  ].join("\n"));
  const rpc = await appServer(core, home, t);
  try {
    const threadId = await initializeRecoveryThread(rpc, home);
    assert.equal((await recoveryTurn(rpc, threadId, "SYNTHETIC_FIRST_TASK")).status, "completed");
    const identityRoot = path.join(bridge.profile, "response-identities");
    assert.ok(fs.existsSync(identityRoot));
    assert.equal(fs.realpathSync(path.dirname(identityRoot)), fs.realpathSync(bridge.profile));
    fs.rmSync(identityRoot, { recursive: true });
    assert.equal((await recoveryTurn(rpc, threadId, "SYNTHETIC_CONTINUE_SAME_THREAD")).status, "completed");
    assert.equal(bridge.requests.length, 3, "sampling, recovered native compaction, sampling");
    assert.ok(JSON.stringify(bridge.requests[2].input).includes("SYNTHETIC_CACHELESS_SUMMARY"));
    assert.ok(JSON.stringify(bridge.requests[2].input).includes("SYNTHETIC_CONTINUE_SAME_THREAD"));
    assert.ok(rpc.notifications.some(event =>
      event.method === "item/completed" && event.params.item.type === "contextCompaction"));
    t.diagnostic("The same native thread recovered complete history after losing only its isolated identity cache and compacted normally.");
  } finally {
    await rpc.close();
    await bridge.close();
  }
});
for (const route of ["/responses", "/chat/completions"]) {
test(`${label} ${route}: context overflow recovers even when its first compaction also exceeds the window`, {
  skip: !core,
}, async t => {
  const home = createProfile(t);
  const compactMarker = "SYNTHETIC_COMPACTION_REQUEST_MARKER";
  let compacted = false;
  let compactionAttempts = 0;
  const rejectContext = res => res.writeHead(400, { "content-type": "application/json" })
    .end(JSON.stringify({ error: {
      code: "invalid_request_body",
      message: "Your input exceeds the context window of this model. Please adjust your input and try\nagain.",
    } }));
  const bridge = await responsesBridge(home, t, async (_req, res, body) => {
    const input = route === "/responses" ? body.input : body.messages;
    if (JSON.stringify(input).includes(compactMarker)) {
      compactionAttempts += 1;
      if (compactionAttempts === 1) { rejectContext(res); return; }
      compacted = true;
      res.writeHead(200, { "content-type": "text/event-stream" })
        .end(recoveryStream(route, "resp_summary", "SYNTHETIC_CONTEXT_SUMMARY"));
    } else if (!compacted) {
      rejectContext(res);
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" })
        .end(recoveryStream(route, "resp_recovered", "SYNTHETIC_CONTEXT_RECOVERED"));
    }
  }, { route });
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, [
    `compact_prompt = "${compactMarker}"`,
    "model_context_window = 100000",
    fs.readFileSync(config, "utf8").replace("http://127.0.0.1:1", bridge.url),
  ].join("\n"));
  const rpc = await appServer(core, home, t);
  try {
    const threadId = await initializeRecoveryThread(rpc, home);
    const failed = await recoveryTurn(rpc, threadId, "SYNTHETIC_ORIGINAL_TASK");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.codexErrorInfo, "contextWindowExceeded");
    assert.equal(bridge.requests.length, 1, "context errors must not enter transport retry loops");
    const recovered = await recoveryTurn(rpc, threadId, "SYNTHETIC_CONTINUE_SAME_TASK");
    assert.equal(recovered.status, "completed", JSON.stringify(recovered));
    assert.equal(compacted, true);
    assert.equal(compactionAttempts, 2);
    assert.equal(bridge.requests.length, 4, "failed sampling, failed compaction, trimmed compaction, recovered sampling");
    const inputs = bridge.requests.map(body => route === "/responses" ? body.input : body.messages);
    assert.ok(JSON.stringify(inputs[1]).includes(compactMarker));
    assert.ok(JSON.stringify(inputs[2]).length < JSON.stringify(inputs[1]).length,
      "native compaction must shrink its input after a recognized context error");
    assert.ok(JSON.stringify(inputs[3]).includes("SYNTHETIC_CONTEXT_SUMMARY"));
    assert.ok(JSON.stringify(inputs[3]).includes("SYNTHETIC_CONTINUE_SAME_TASK"));
    assert.ok(rpc.notifications.some(event =>
      event.method === "item/completed" && event.params.item.type === "contextCompaction"));
    t.diagnostic("The installed native core classified contextWindowExceeded, shrank its rejected compaction, and completed the next turn in the same thread.");
  } finally {
    await rpc.close();
    await bridge.close();
  }
});

test(`${label} ${route}: native automatic compaction runs before the next sampling request at its token threshold`, {
  skip: !core,
}, async t => {
  const home = createProfile(t);
  const compactMarker = "SYNTHETIC_AUTOMATIC_COMPACTION";
  let compacted = false;
  const bridge = await responsesBridge(home, t, async (_req, res, body, number) => {
    const input = route === "/responses" ? body.input : body.messages;
    const compact = JSON.stringify(input).includes(compactMarker);
    if (compact) compacted = true;
    if (number > 1 && !compact) assert.equal(compacted, true);
    res.writeHead(200, { "content-type": "text/event-stream" }).end(recoveryStream(
      route, `resp_automatic_${number}`,
      compact ? "SYNTHETIC_AUTOMATIC_SUMMARY" : "SYNTHETIC_AUTOMATIC_ANSWER",
      number === 1 ? { input_tokens: 95000, output_tokens: 5, total_tokens: 95005 } : undefined,
    ));
  }, { route });
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, [
    `compact_prompt = "${compactMarker}"`,
    "model_context_window = 100000",
    fs.readFileSync(config, "utf8").replace("http://127.0.0.1:1", bridge.url),
  ].join("\n"));
  const rpc = await appServer(core, home, t);
  try {
    const threadId = await initializeRecoveryThread(rpc, home);
    assert.equal((await recoveryTurn(rpc, threadId, "SYNTHETIC_FIRST_TASK")).status, "completed");
    assert.equal(bridge.requests.length, 1);
    assert.equal((await recoveryTurn(rpc, threadId, "SYNTHETIC_SECOND_TASK")).status, "completed");
    assert.equal(bridge.requests.length, 3, "sampling, native automatic compaction, sampling");
    const lastInput = route === "/responses" ? bridge.requests[2].input : bridge.requests[2].messages;
    assert.ok(JSON.stringify(lastInput).includes("SYNTHETIC_AUTOMATIC_SUMMARY"));
    assert.ok(JSON.stringify(lastInput).includes("SYNTHETIC_SECOND_TASK"));
    assert.ok(rpc.notifications.some(event =>
      event.method === "item/completed" && event.params.item.type === "contextCompaction"));
  } finally {
    await rpc.close();
    await bridge.close();
  }
});
}
}

test("native core reconnects after an explicit premature-stream failure", {
  skip: !nativeCore,
}, async t => {
  const home = createProfile(t);
  const bridge = await responsesBridge(home, t, async (_req, res, _body, number) => {
    res.writeHead(200, { "content-type": "text/event-stream" }).end(number === 1
      ? encodeEvents([{ type: "response.created", response: { id: "resp_native_eof" } }])
      : recoveryEvents("resp_native_retry", "SYNTHETIC_RECONNECTION_RECOVERED"));
  });
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("http://127.0.0.1:1", bridge.url)
    .replace("requires_openai_auth = false", "requires_openai_auth = false\nstream_max_retries = 1"));
  const rpc = await appServer(nativeCore, home, t);
  try {
    const threadId = await initializeRecoveryThread(rpc, home);
    const completed = await recoveryTurn(rpc, threadId, "SYNTHETIC_RECONNECT_TASK");
    assert.equal(completed.status, "completed", JSON.stringify(completed));
    assert.equal(bridge.requests.length, 2);
    const audits = fs.readFileSync(path.join(bridge.profile, "request-audit.jsonl"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line));
    assert.ok(audits.some(record => record.status === "incomplete" && record.attempts === 1
      && record.error.code === "upstream_stream_incomplete" && record.eventsForwarded === 1));
    t.diagnostic("The bridge did not replay the published event; the native core reconnected and completed.");
  } finally {
    await rpc.close();
    await bridge.close();
  }
});

for (const [label, core] of recoveryCores) {
test(`${label}: native SSE idle timeout is not triggered by a quiet upstream while bridge keepalives arrive`, {
  skip: !core,
}, async t => {
  const home = createProfile(t);
  const bridge = await responsesBridge(home, t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    await new Promise(resolve => setTimeout(resolve, 4000));
    res.end(recoveryEvents("resp_native_quiet", "SYNTHETIC_QUIET_STREAM_COMPLETED"));
  }, { env: { CODEX_COPILOT_SSE_HEARTBEAT_MS: "50" } });
  const wire = await observeSseWire(bridge.url);
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("http://127.0.0.1:1", wire.url)
    .replace("requires_openai_auth = false",
      "requires_openai_auth = false\nstream_idle_timeout_ms = 1000\nstream_max_retries = 0"));
  const rpc = await appServer(core, home, t);
  try {
    const threadId = await initializeRecoveryThread(rpc, home);
    const completed = await recoveryTurn(rpc, threadId, "SYNTHETIC_QUIET_TASK");
    assert.equal(completed.status, "completed", JSON.stringify({
      turn: completed, wire: wire.diagnostics(), bridge: bridge.diagnostics(), core: rpc.diagnostics(),
      bridgeLog: fs.readFileSync(path.join(bridge.profile, "bridge.log"), "utf8").slice(-6000),
    }));
    assert.equal(bridge.requests.length, 1, "keepalives must avoid a timeout, not conceal retries");
    assert.ok(wire.diagnostics().pings > 1, JSON.stringify(wire.diagnostics()));
    assert.ok(wire.diagnostics().maxFrameGapMs < 1000, JSON.stringify(wire.diagnostics()));
    t.diagnostic(JSON.stringify(wire.diagnostics()));
    t.diagnostic("4000 ms upstream silence survived a 1000 ms native idle timeout with one request and real completion.");
  } finally {
    await rpc.close();
    await wire.close();
    await bridge.close();
  }
});

test(`${label}: the same quiet stream times out without bridge keepalives`, {
  skip: !core,
}, async t => {
  const home = createProfile(t);
  const bridge = await responsesBridge(home, t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    res.write(encodeEvents([{ type: "response.created", response: { id: "resp_native_no_keepalive" } }]));
    await new Promise(resolve => setTimeout(resolve, 4000));
    if (!res.destroyed) res.end(recoveryEvents("resp_native_no_keepalive", "SYNTHETIC_LATE_COMPLETION"));
  }, { env: { CODEX_COPILOT_SSE_HEARTBEAT_MS: "60000" } });
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("http://127.0.0.1:1", bridge.url)
    .replace("requires_openai_auth = false",
      "requires_openai_auth = false\nstream_idle_timeout_ms = 1000\nstream_max_retries = 0"));
  const rpc = await appServer(core, home, t);
  try {
    const threadId = await initializeRecoveryThread(rpc, home);
    const failed = await recoveryTurn(rpc, threadId, "SYNTHETIC_QUIET_NEGATIVE_CONTROL");
    assert.equal(failed.status, "failed", JSON.stringify(failed));
    assert.match(failed.error.message, /idle timeout waiting for SSE/);
    assert.equal(bridge.requests.length, 1);
    t.diagnostic("The negative control failed at the native idle timeout; the positive test does not merely bypass it.");
  } finally {
    await rpc.close();
    await bridge.close();
  }
});
}

async function nativeWait(rpc, check, description, diagnostics = () => undefined) {
  const deadline = Date.now() + 30000;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`${description}: ${JSON.stringify({
      core: rpc.diagnostics(), extra: diagnostics(),
    })}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function websocketRecoveryBridge(home, t, responder, options) {
  return responsesBridge(home, t, () => {
    assert.fail("A successful WebSocket inference must not be replayed through HTTP.");
  }, { ...options, websocketResponder: responder });
}

for (const [label, core] of recoveryCores) {
test(`${label}: WebSocket MAX reasoning preserves genuine repeats, identities and complete follow-up history`, {
  skip: !core,
}, async t => {
  const home = createProfile(t);
  const bridge = await websocketRecoveryBridge(home, t, async (_req, peer, body, number) => {
    assert.equal(body.type, "response.create");
    assert.equal(Object.hasOwn(body, "stream"), false);
    assert.equal(body.reasoning.effort, "max");
    assert.equal(body.store, false);
    const events = rotatingEvents(`resp_ws_identity_${number}`);
    for (const event of events.slice(0, 4)) peer.send(event);
    await new Promise(resolve => setTimeout(resolve, 70));
    for (const event of events.slice(4)) peer.send(event);
  }, { env: {
    CODEX_COPILOT_RESPONSES_CHECKPOINT_MS: "20",
    CODEX_COPILOT_RESPONSES_MAX_CHECKPOINTS: "8",
  } });
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, [
    'model_reasoning_effort = "max"',
    fs.readFileSync(config, "utf8").replace("http://127.0.0.1:1", bridge.url),
  ].join("\n"));
  const rpc = await appServer(core, home, t);
  try {
    const threadId = await initializeRecoveryThread(rpc, home);
    assert.equal((await recoveryTurn(rpc, threadId, "SYNTHETIC_WS_IDENTITY_TASK")).status, "completed");
    assert.equal(bridge.requests.length, 1);
    for (const type of ["agentMessage", "reasoning"]) {
      const items = method => rpc.notifications.filter(event =>
        event.method === method && event.params.item.type === type).map(event => event.params.item);
      const starts = items("item/started");
      const ends = items("item/completed");
      assert.equal(starts.length, type === "agentMessage" ? 3 : 1);
      assert.deepEqual(ends.map(item => item.id), starts.map(item => item.id));
      const ids = new Set(starts.map(item => item.id));
      for (const event of rpc.notifications.filter(event => event.method.startsWith(
        type === "agentMessage" ? "item/agentMessage/" : "item/reasoning/"))) {
        assert.ok(ids.has(event.params.itemId), JSON.stringify(event));
      }
    }
    const live = rpc.notifications.filter(event =>
      event.method === "item/completed" && event.params.item.type === "agentMessage").map(event => event.params.item);
    assert.deepEqual(live.map(item => item.text), [
      "SYNTHETIC_GENUINE_REPEAT", "SYNTHETIC_GENUINE_REPEAT", "SYNTHETIC_FINAL",
    ]);
    const page = await rpc.request("thread/turns/list", { threadId, limit: 10, itemsView: "full" });
    assert.deepEqual(page.data.flatMap(turn => turn.items).filter(item => item.type === "agentMessage")
      .map(item => ({ id: item.id, text: item.text })), live.map(item => ({ id: item.id, text: item.text })));
    await bridge.restart();
    assert.equal((await recoveryTurn(rpc, threadId, "SYNTHETIC_WS_COMPLETE_FOLLOWUP")).status, "completed");
    assert.equal(bridge.requests.length, 2);
    assert.deepEqual(bridge.requests[1].input.filter(item => item.role === "assistant").map(item => item.id), [
      "resp_ws_identity_1-opaque-1-completed",
      "resp_ws_identity_1-opaque-2-completed",
      "resp_ws_identity_1-opaque-3-completed",
    ]);
    assert.ok(bridge.requests[1].input.some(item =>
      item.type === "reasoning" && item.encrypted_content === "SYNTHETIC_ENCRYPTED_CONTENT"));
    const audit = JSON.parse(fs.readFileSync(path.join(bridge.profile, "request-audit-latest.json"), "utf8"));
    assert.equal(audit.status, "complete");
    assert.equal(audit.upstreamTransport, "websocket");
    assert.equal(audit.upstreamHandshakeHttpStatus, 101);
    assert.equal(audit.providerRequestId, "SYNTHETIC_WS_REQUEST");
    assert.equal(audit.serviceRequestId, "SYNTHETIC_WS_SERVICE");
    assert.equal(audit.attempts, 1);
    assert.equal(audit.reasoningCheckpoints, 0);
  } finally {
    await rpc.close();
    await bridge.close();
  }
});

for (const keepalive of [true, false]) {
test(`${label}: quiet WebSocket ${keepalive ? "survives" : "fails at"} the unchanged native SSE idle timeout`, {
  skip: !core,
}, async t => {
  const home = createProfile(t);
  const bridge = await websocketRecoveryBridge(home, t, async (_req, peer) => {
    peer.send({ type: "response.created", response: { id: "resp_ws_quiet" } });
    await new Promise(resolve => setTimeout(resolve, 4000));
    if (!peer.closed) {
      for (const event of recoveryEventValues("resp_ws_quiet", "SYNTHETIC_WS_QUIET_COMPLETED").slice(1)) {
        peer.send(event);
      }
    }
  }, { env: { CODEX_COPILOT_SSE_HEARTBEAT_MS: keepalive ? "50" : "60000" } });
  const wire = await observeSseWire(bridge.url);
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("http://127.0.0.1:1", wire.url)
    .replace("requires_openai_auth = false",
      "requires_openai_auth = false\nstream_idle_timeout_ms = 1000\nstream_max_retries = 0"));
  const rpc = await appServer(core, home, t);
  try {
    const threadId = await initializeRecoveryThread(rpc, home);
    const completed = await recoveryTurn(rpc, threadId, "SYNTHETIC_WS_QUIET_TASK");
    assert.equal(bridge.requests.length, 1, "No hidden fallback or bridge replay.");
    if (keepalive) {
      assert.equal(completed.status, "completed", JSON.stringify({
        turn: completed, wire: wire.diagnostics(), bridge: bridge.diagnostics(),
      }));
      assert.ok(wire.diagnostics().pings > 1);
      assert.ok(wire.diagnostics().maxFrameGapMs < 1000, JSON.stringify(wire.diagnostics()));
    } else {
      assert.equal(completed.status, "failed", JSON.stringify(completed));
      assert.match(completed.error.message, /idle timeout waiting for SSE/);
      assert.equal(wire.diagnostics().pings, 0);
    }
    t.diagnostic(JSON.stringify(wire.diagnostics()));
  } finally {
    await rpc.close();
    await wire.close();
    await bridge.close();
  }
});
}

test(`${label}: genuine WebSocket EOF stays incomplete and only the native core reconnects`, {
  skip: !core,
}, async t => {
  const home = createProfile(t);
  const bridge = await websocketRecoveryBridge(home, t, async (_req, peer, _body, number) => {
    if (number === 1) {
      peer.send({ type: "response.created", response: { id: "resp_ws_eof" } });
      peer.close();
    } else {
      for (const event of recoveryEventValues("resp_ws_retry", "SYNTHETIC_WS_RECONNECTED")) peer.send(event);
    }
  });
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("http://127.0.0.1:1", bridge.url)
    .replace("requires_openai_auth = false", "requires_openai_auth = false\nstream_max_retries = 1"));
  const rpc = await appServer(core, home, t);
  try {
    const threadId = await initializeRecoveryThread(rpc, home);
    assert.equal((await recoveryTurn(rpc, threadId, "SYNTHETIC_WS_RECONNECT_TASK")).status, "completed");
    assert.equal(bridge.requests.length, 2);
    const audits = fs.readFileSync(path.join(bridge.profile, "request-audit.jsonl"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line));
    const failure = audits.find(audit => audit.status === "incomplete");
    assert.equal(failure.error.code, "upstream_stream_incomplete");
    assert.equal(failure.eventsForwarded, 1);
    assert.equal(failure.attempts, 1);
    assert.equal(failure.upstreamTransport, "websocket");
    assert.equal(failure.usage, null);
    assert.ok(audits.some(audit => audit.status === "complete" && audit.attempts === 1
      && audit.upstreamTransport === "websocket"));
  } finally {
    await rpc.close();
    await bridge.close();
  }
});

for (const recovery of ["automatic", "context-overflow"]) {
test(`${label}: WebSocket preserves native ${recovery} compaction, including rejected-compaction recovery`, {
  skip: !core,
}, async t => {
  const home = createProfile(t);
  const marker = "SYNTHETIC_WS_COMPACTION_REQUEST";
  let compacted = false;
  let compactionAttempts = 0;
  const bridge = await websocketRecoveryBridge(home, t, async (_req, peer, body, number) => {
    const compact = JSON.stringify(body.input).includes(marker);
    if (compact) compactionAttempts += 1;
    if (recovery === "context-overflow" && !compacted && (!compact || compactionAttempts === 1)) {
      peer.send({ type: "error", status: 400, error: {
        code: "invalid_request_body",
        message: "Your input exceeds the context window of this model. Please adjust your input and try\nagain.",
      } });
      return;
    }
    if (compact) compacted = true;
    const usage = recovery === "automatic" && number === 1
      ? { input_tokens: 95000, output_tokens: 5, total_tokens: 95005 } : undefined;
    for (const event of recoveryEventValues(`resp_ws_compact_${number}`,
      compact ? "SYNTHETIC_WS_CONTEXT_SUMMARY" : "SYNTHETIC_WS_CONTEXT_ANSWER", usage)) peer.send(event);
  });
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, [
    `compact_prompt = "${marker}"`,
    "model_context_window = 100000",
    fs.readFileSync(config, "utf8").replace("http://127.0.0.1:1", bridge.url),
  ].join("\n"));
  const rpc = await appServer(core, home, t);
  try {
    const threadId = await initializeRecoveryThread(rpc, home);
    const first = await recoveryTurn(rpc, threadId, "SYNTHETIC_WS_ORIGINAL_TASK");
    if (recovery === "automatic") {
      assert.equal(first.status, "completed");
    } else {
      assert.equal(first.status, "failed");
      assert.equal(first.error.codexErrorInfo, "contextWindowExceeded");
    }
    assert.equal(bridge.requests.length, 1);
    assert.equal((await recoveryTurn(rpc, threadId, "SYNTHETIC_WS_CONTINUE_TASK")).status, "completed");
    assert.equal(compactionAttempts, recovery === "automatic" ? 1 : 2);
    assert.equal(bridge.requests.length, recovery === "automatic" ? 3 : 4);
    if (recovery === "context-overflow") {
      assert.ok(JSON.stringify(bridge.requests[2].input).length < JSON.stringify(bridge.requests[1].input).length,
        "Only the actual native core may shrink a rejected compaction request.");
    }
    assert.ok(JSON.stringify(bridge.requests.at(-1).input).includes("SYNTHETIC_WS_CONTEXT_SUMMARY"));
    assert.ok(JSON.stringify(bridge.requests.at(-1).input).includes("SYNTHETIC_WS_CONTINUE_TASK"));
    assert.ok(rpc.notifications.some(event =>
      event.method === "item/completed" && event.params.item.type === "contextCompaction"));
  } finally {
    await rpc.close();
    await bridge.close();
  }
});
}

test(`${label}: native interruption has the same cancellation semantics on HTTP and WebSocket`, {
  skip: !core,
}, async t => {
  const observations = [];
  for (const transport of ["http", "websocket"]) {
    const home = createProfile(t);
    const initialEvents = [
      { type: "response.created", response: { id: "resp_interrupted" } },
      { type: "response.output_item.added", output_index: 0, item: {
        id: "interrupted_reasoning", type: "reasoning", summary: [],
      } },
    ];
    const lateEvent = { type: "response.reasoning_summary_text.delta", output_index: 0,
      item_id: "interrupted_reasoning", summary_index: 0, delta: "SYNTHETIC_LATE_REASONING" };
    let sendLateProviderEvent;
    const bridge = transport === "websocket"
      ? await websocketRecoveryBridge(home, t, async (_req, peer) => {
        for (const event of initialEvents) peer.send(event);
        sendLateProviderEvent = () => { if (!peer.closed) peer.send(lateEvent); };
      })
      : await responsesBridge(home, t, async (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(encodeEvents(initialEvents));
        sendLateProviderEvent = () => { if (!res.destroyed) res.write(encodeEvents([lateEvent])); };
      });
    const active = () => transport === "websocket" ? bridge.diagnostics().activeUpstreamWebSockets
      : bridge.diagnostics().activeUpstreamHttpStreams;
    const config = path.join(home, "config.toml");
    fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("http://127.0.0.1:1", bridge.url));
    const rpc = await appServer(core, home, t);
    try {
      const threadId = await initializeRecoveryThread(rpc, home);
      const started = await rpc.request("turn/start", {
        threadId, input: [{ type: "text", text: "SYNTHETIC_INTERRUPT_TASK" }],
      });
      await nativeWait(rpc, () => rpc.notifications.some(notification =>
        notification.method === "item/started" && notification.params.item.type === "reasoning"),
      "The native core did not enter its active response reader", () => bridge.diagnostics());
      await rpc.request("turn/interrupt", { threadId, turnId: started.turn.id });
      const event = await nativeWait(rpc, () => rpc.notifications.find(notification =>
        notification.method === "turn/completed" && notification.params.turn.id === started.turn.id),
      "Interrupted turn did not terminate");
      assert.equal(event.params.turn.status, "interrupted");
      await new Promise(resolve => setTimeout(resolve, 250));
      observations.push({ transport, nativeReaderStillOpen: active() !== 0 });
      // Older native clients observe a dropped event receiver only on their
      // next provider event. Do not replace that behavior with a bridge deadline.
      sendLateProviderEvent();
      await nativeWait(rpc, () => active() === 0,
        "Downstream cancellation did not release its upstream", () => ({
          bridge: bridge.diagnostics(),
          audit: JSON.parse(fs.readFileSync(path.join(bridge.profile, "request-audit-latest.json"), "utf8")),
        }));
      assert.equal(bridge.requests.length, 1);
      // Socket closure can precede the proxy's terminal audit on another event loop.
      const audit = await nativeWait(rpc, () => {
        const record = JSON.parse(fs.readFileSync(path.join(bridge.profile, "request-audit-latest.json"), "utf8"));
        return record.status === "started" ? null : record;
      }, "Downstream cancellation did not settle its terminal audit", () => bridge.diagnostics());
      assert.equal(audit.status, "cancelled");
      assert.equal(audit.usage, null);
      assert.ok(!rpc.notifications.some(notification => notification.method === "item/completed"
        && notification.params.item.type === "agentMessage"));
    } finally {
      await rpc.close();
      await bridge.close();
    }
  }
  assert.equal(observations[1].nativeReaderStillOpen, observations[0].nativeReaderStillOpen,
    "The new transport must retain the selected core's original cancellation behavior.");
  t.diagnostic(JSON.stringify(observations));
});
}
