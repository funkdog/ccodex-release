import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_CONTEXT_SUFFIX,
  LONG_CONTEXT_SUFFIX,
  buildDesktopCatalog,
  resolveModelSelection,
} from "../bridge/catalog.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const baseModel = "ccodex-context-mock";
const standardModel = `${baseModel}${DEFAULT_CONTEXT_SUFFIX}`;
const longModel = `${baseModel}${LONG_CONTEXT_SUFFIX}`;
const defaultWindow = 128_000;
const longWindow = 256_000;

function syntheticCopilotModel() {
  return {
    id: baseModel,
    capabilities: { limits: { max_prompt_tokens: defaultWindow } },
    codex_copilot_context: {
      default_prompt_tokens: defaultWindow,
      long_context_prompt_tokens: longWindow,
    },
  };
}

test("Copilot context alias resolves to one upstream model with two tiers", () => {
  const model = syntheticCopilotModel();
  assert.deepEqual([
    resolveModelSelection([model], baseModel)?.contextTier,
    resolveModelSelection([model], standardModel, "context-long")?.contextTier,
    resolveModelSelection([model], longModel)?.contextTier,
    resolveModelSelection([model], longModel)?.model.id,
  ], ["default", "default", "long_context", baseModel]);
});

function isolatedEnvironment(profile, temp) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:CODEX|CCODEX|OPENAI|GITHUB|COPILOT|GH|AZURE)_/i.test(key)
      || /(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)/i.test(key)) {
      delete env[key];
    }
  }
  Object.assign(env, {
    CODEX_HOME: profile,
    CODEX_COPILOT_HOME: profile,
    TEMP: temp,
    TMP: temp,
  });
  return env;
}

function createCatalog(profile) {
  const templates = JSON.parse(fs.readFileSync(
    path.join(packageRoot, "assets", "catalog-templates.json"), "utf8",
  )).models;
  const template = templates.find(model => model.slug === "gpt-5.4");
  assert.ok(template, "The packaged synthetic catalog template is missing");

  const preset = (slug, window, priority, { maxWindow = window, serviceTiers = [] } = {}) => ({
    ...structuredClone(template),
    slug,
    display_name: slug,
    description: "Synthetic local context-window test; no remote model",
    base_instructions: "This is an isolated local mock-provider test.",
    visibility: "list",
    priority,
    context_window: window,
    max_context_window: maxWindow,
    effective_context_window_percent: 95,
    auto_compact_token_limit: null,
    service_tiers: serviceTiers,
    default_service_tier: null,
    default_reasoning_level: "low",
    supported_reasoning_levels: [
      { effort: "low", description: "Synthetic low effort" },
    ],
    copilot: {
      base_model: baseModel,
      default_prompt_tokens: defaultWindow,
      long_context_prompt_tokens: longWindow,
      default_context_window_tokens: defaultWindow,
      long_context_window_tokens: longWindow,
    },
  });
  const catalogPath = path.join(profile, "models.json");
  fs.writeFileSync(catalogPath, JSON.stringify(buildDesktopCatalog({
    models: [preset(baseModel, defaultWindow, 1, {
      maxWindow: longWindow,
      serviceTiers: [{ id: "context-long", name: "256K", description: "128K" }],
    })],
  })));
  return catalogPath;
}

function writeProfile(profile, catalogPath, port) {
  fs.writeFileSync(path.join(profile, "config.toml"), [
    `model = ${JSON.stringify(standardModel)}`,
    'model_provider = "isolated-context-mock"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    'model_reasoning_effort = "low"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    'cli_auth_credentials_store = "file"',
    'mcp_oauth_credentials_store = "file"',
    'check_for_update_on_startup = false',
    "",
    "[model_providers.isolated-context-mock]",
    'name = "Isolated local context mock"',
    `base_url = "http://127.0.0.1:${port}"`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "",
    "[analytics]",
    "enabled = false",
    "",
    "[features]",
    "plugins = false",
    "remote_plugin = false",
    "apps = false",
    "shell_tool = false",
    "",
  ].join("\n"));
}

function mockProvider(requests) {
  return http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/responses")) {
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({
        model: body.model,
        serviceTier: body.service_tier ?? null,
        threadId: req.headers["thread-id"] ?? null,
      });
      const sequence = requests.length;
      const responseId = `resp_context_alias_${sequence}`;
      const item = {
        id: `msg_context_alias_${sequence}`,
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: `SYNTHETIC_RESULT_${sequence}` }],
      };
      const events = [
        { type: "response.created", response: { id: responseId } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: 0, item_id: item.id,
          content_index: 0, delta: item.content[0].text },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: {
          id: responseId, status: "completed", output: [item],
          usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
        } },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
    } catch (error) {
      res.writeHead(500).end(`Synthetic mock failure: ${error.message}`);
    }
  });
}

function connectAppServer(core, profile, env, t, globalArgs = [], surface = "official Desktop") {
  const child = spawn(core, [...globalArgs, "app-server", "--stdio"], {
    cwd: profile, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  t.diagnostic(`Isolated ${surface} app-server PID ${child.pid}; profile ${profile}`);
  const notifications = [];
  const pending = new Map();
  let nextId = 0;
  let buffer = "";
  let stderr = "";
  const closed = new Promise(resolve => {
    child.once("error", error => resolve({ error }));
    child.once("close", (code, signal) => {
      for (const [id, request] of pending) {
        request.reject(new Error(`App-server exited ${code}/${signal}: ${stderr.slice(-2000)}`));
        pending.delete(id);
      }
      resolve({ code, signal });
    });
  });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16000); });
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
      } else if (message.method) notifications.push(message);
    }
  });

  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out: ${method}; stderr=${stderr.slice(-2000)}`));
    }, 45_000);
    pending.set(id, {
      resolve: result => { clearTimeout(timer); resolve(result); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const waitFor = async (method, predicate, from = 0, timeoutMs = 90_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = notifications.slice(from).find(
        event => event.method === method && predicate(event.params ?? {}),
      );
      if (match) return match.params;
      if (child.exitCode !== null) {
        throw new Error(`App-server exited before ${method}: ${stderr.slice(-2000)}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${method}; stderr=${stderr.slice(-2000)}; `
          + `events=${JSON.stringify(notifications.slice(-12))}`);
      }
      await delay(25);
    }
  };
  return { child, closed, notifications, request, waitFor, diagnostics: () => stderr };
}

async function runTurn(rpc, threadId, number) {
  const from = rpc.notifications.length;
  const started = await rpc.request("turn/start", {
    threadId,
    input: [{ type: "text", text: `Synthetic local turn ${number}. Reply with a short answer.` }],
  });
  const turnId = started.turn.id;
  const completed = await rpc.waitFor("turn/completed",
    params => params.turn?.id === turnId, from);
  assert.equal(completed.turn.status, "completed",
    `Turn ${number} failed: ${JSON.stringify(completed)}`);
  const usage = await rpc.waitFor("thread/tokenUsage/updated",
    params => params.threadId === threadId && params.turnId === turnId
      && Number.isSafeInteger(params.tokenUsage?.modelContextWindow),
    from);
  return { turnId, window: usage.tokenUsage.modelContextWindow };
}

test("patched CLI overrides the Desktop catalog and default Context in an isolated profile", {
  skip: !process.env.CCODEX_TEST_CLI_CORE,
  timeout: 120_000,
}, async t => {
  const core = process.env.CCODEX_TEST_CLI_CORE;
  assert.ok(path.isAbsolute(core) && fs.existsSync(core),
    "The CLI context probe requires its explicitly selected patched CLI core.");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-cli-desktop-catalog-"));
  const profile = path.join(root, "profile");
  const workspace = path.join(root, "workspace");
  const temp = path.join(root, "temp");
  for (const directory of [profile, workspace, temp]) fs.mkdirSync(directory);
  const requests = [];
  const provider = mockProvider(requests);
  let rpc;
  let providerListening = false;
  try {
    await new Promise((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", () => {
        provider.off("error", reject);
        providerListening = true;
        resolve();
      });
    });
    const desktopPath = createCatalog(profile);
    const cliPath = path.join(profile, "models-cli.json");
    const base = JSON.parse(fs.readFileSync(desktopPath, "utf8")).models
      .find(entry => entry.slug === baseModel);
    assert.ok(base);
    fs.writeFileSync(cliPath, JSON.stringify({
      models: [{ ...base, visibility: "list" }],
    }));
    writeProfile(profile, desktopPath, provider.address().port);

    rpc = connectAppServer(core, profile, isolatedEnvironment(profile, temp), t, [
      "-c", `model_catalog_json=${cliPath}`,
      "-c", `model=${baseModel}`,
      "-c", "service_tier=context-long",
    ], "patched CLI");
    await rpc.request("initialize", {
      clientInfo: { name: "ccodex_cli_desktop_catalog_probe", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.child.stdin.write('{"method":"initialized","params":{}}\n');

    const available = await rpc.request("model/list",
      { includeHidden: true, cursor: null, limit: 100 });
    assert.deepEqual(available.data.map(model => model.model), [baseModel],
      "The CLI must not expose Desktop-only Context aliases");
    const started = await rpc.request("thread/start", { cwd: workspace });
    const result = await runTurn(rpc, started.thread.id, 1);
    assert.deepEqual(requests.map(request => [request.model, request.serviceTier]),
      [[baseModel, "context-long"]],
      "The CLI launch override must preserve the real Long tier on the base Copilot model");
    assert.ok(result.window > defaultWindow,
      `The patched CLI did not enlarge its effective Context: ${result.window}`);
    t.diagnostic(JSON.stringify({
      surface: "patched-cli", modelContextWindow: result.window, serviceTier: requests[0].serviceTier,
    }));
  } finally {
    let coreExited = rpc == null;
    try {
      if (rpc) {
        rpc.child.stdin.end();
        let timer;
        const exit = await Promise.race([
          rpc.closed,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(
              new Error("Isolated CLI core did not exit"),
            ), 20_000);
          }),
        ]).finally(() => clearTimeout(timer));
        coreExited = true;
        assert.equal(exit.error, undefined, exit.error?.message);
        assert.equal(exit.code, 0, rpc.diagnostics());
        t.diagnostic(`Isolated patched CLI PID ${rpc.child.pid} exited with code ${exit.code}`);
      }
    } finally {
      if (providerListening) {
        provider.closeAllConnections();
        await new Promise(resolve => provider.close(resolve));
      }
      if (coreExited) {
        assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
        assert.ok(path.basename(root).startsWith("ccodex-cli-desktop-catalog-"));
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      } else {
        t.diagnostic(`Preserved ${root}: the isolated CLI core has not exited`);
      }
    }
  }
});

const desktopCore = process.env.CCODEX_TEST_DESKTOP_CORE || process.env.CCODEX_TEST_NATIVE_CORE;
test("official Desktop core switches independent context presets in one loaded thread", {
  skip: !desktopCore && process.env.CCODEX_RUN_DESKTOP_CONTEXT_ALIAS_PROBE !== "1",
  timeout: 240_000,
}, async t => {
  const core = desktopCore;
  assert.ok(core && path.isAbsolute(core) && fs.existsSync(core),
    "Set CCODEX_TEST_DESKTOP_CORE or CCODEX_TEST_NATIVE_CORE to the bundled official Desktop core.");
  assert.equal(path.basename(core).toLowerCase(), process.platform === "win32" ? "codex.exe" : "codex",
    "The Desktop probe must not substitute the patched CLI executable.");
  const version = spawnSync(core, ["--version"], { encoding: "utf8", windowsHide: true });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^codex-cli \d+\.\d+\.\d+(?:[^\r\n]*)\s*$/);
  t.diagnostic(`Explicit official Desktop core: ${core}; ${version.stdout.trim()}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-desktop-context-alias-"));
  const profile = path.join(root, "profile");
  const workspace = path.join(root, "workspace");
  const temp = path.join(root, "temp");
  for (const directory of [profile, workspace, temp]) fs.mkdirSync(directory);
  const requests = [];
  const provider = mockProvider(requests);
  let rpc;
  let providerListening = false;
  try {
    await new Promise((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", () => {
        provider.off("error", reject);
        providerListening = true;
        resolve();
      });
    });
    const catalogPath = createCatalog(profile);
    writeProfile(profile, catalogPath, provider.address().port);
    const model = syntheticCopilotModel();
    assert.deepEqual([
      resolveModelSelection([model], baseModel)?.contextTier,
      resolveModelSelection([model], standardModel, "context-long")?.contextTier,
      resolveModelSelection([model], longModel)?.contextTier,
      resolveModelSelection([model], longModel)?.model.id,
    ], ["default", "default", "long_context", baseModel]);

    rpc = connectAppServer(core, profile, isolatedEnvironment(profile, temp), t);
    await rpc.request("initialize", {
      clientInfo: { name: "ccodex_desktop_context_alias_probe", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.child.stdin.write('{"method":"initialized","params":{}}\n');

    const available = await rpc.request("model/list",
      { includeHidden: true, cursor: null, limit: 100 });
    const baseEntry = available.data.find(model => model.model === baseModel);
    const defaultEntry = available.data.find(model => model.model === standardModel);
    const longEntry = available.data.find(model => model.model === longModel);
    assert.equal(baseEntry?.hidden, true,
      "Old Desktop conversations must retain a hidden legacy model entry");
    assert.equal(defaultEntry?.hidden, false);
    assert.equal(longEntry?.hidden, false,
      "The official Desktop picker must offer both real context presets");
    const originalCatalog = fs.readFileSync(catalogPath, "utf8");
    const changedCatalog = JSON.parse(originalCatalog);
    const refreshSlug = `${baseModel}--refresh-probe`;
    changedCatalog.models.push({
      ...structuredClone(changedCatalog.models[1]),
      slug: refreshSlug,
      priority: 99,
    });
    fs.writeFileSync(catalogPath, JSON.stringify(changedCatalog));
    const afterFileChange = await rpc.request("model/list",
      { includeHidden: true, cursor: null, limit: 100 });
    t.diagnostic(`Official core hot-reloads model_catalog_json: ${
      afterFileChange.data.some(model => model.model === refreshSlug)
    }`);
    fs.writeFileSync(catalogPath, originalCatalog);

    const started = await rpc.request("thread/start", {
      cwd: workspace, model: standardModel,
      baseInstructions: "This is a local mock-provider test. Give a short final answer.",
      developerInstructions: "Do not use tools.",
    });
    const threadId = started.thread.id;
    assert.ok(threadId);
    const first = await runTurn(rpc, threadId, 1);

    let from = rpc.notifications.length;
    await rpc.request("thread/settings/update", {
      threadId, model: longModel, effort: "low", serviceTier: null,
    });
    const selectedLong = await rpc.waitFor("thread/settings/updated",
      params => params.threadId === threadId && params.threadSettings?.model === longModel,
      from);
    assert.ok([null, "default"].includes(selectedLong.threadSettings.serviceTier),
      "The context alias must not select a Fast or context-long service tier");
    const second = await runTurn(rpc, threadId, 2);

    from = rpc.notifications.length;
    await rpc.request("thread/settings/update", {
      threadId, model: standardModel, effort: "low", serviceTier: null,
    });
    const selectedDefault = await rpc.waitFor("thread/settings/updated",
      params => params.threadId === threadId && params.threadSettings?.model === standardModel,
      from);
    assert.ok([null, "default"].includes(selectedDefault.threadSettings.serviceTier),
      "Restoring the default alias must not select a Fast or context-long service tier");
    const third = await runTurn(rpc, threadId, 3);

    from = rpc.notifications.length;
    await rpc.request("thread/settings/update", {
      threadId, model: baseModel, effort: "low", serviceTier: "context-long",
    });
    await rpc.waitFor("thread/settings/updated",
      params => params.threadId === threadId
        && params.threadSettings?.serviceTier === "context-long",
      from);
    const fourth = await runTurn(rpc, threadId, 4);

    from = rpc.notifications.length;
    await rpc.request("thread/settings/update", {
      threadId, model: standardModel, effort: "low",
    });
    await rpc.waitFor("thread/settings/updated",
      params => params.threadId === threadId &&
        params.threadSettings?.model === standardModel, from);
    const fifth = await runTurn(rpc, threadId, 5);

    assert.deepEqual(requests.map(request => request.model),
      [standardModel, longModel, standardModel, baseModel, standardModel],
      "The actual mock Responses requests must follow the thread's model switches");
    assert.ok(requests.slice(0, 3).every(request => [null, "default"].includes(request.serviceTier)),
      "The alias switches must not use a Fast or context-long service tier");
    assert.equal(requests[3].serviceTier, "context-long");
    assert.ok([null, "default"].includes(requests[4].serviceTier),
      "The official core must clear an unsupported inherited tier on the standard preset");
    assert.ok(second.window > first.window,
      `Long preset did not increase the native token window: ${JSON.stringify([first, second, third])}`);
    assert.equal(third.window, first.window,
      "Switching back to the default preset must restore the original token window");
    assert.equal(fourth.window, first.window,
      "A service tier alone must not be mistaken for a larger official Desktop window");
    assert.equal(fifth.window, first.window,
      "The explicit standard preset must remain standard with an inherited service tier");
    assert.ok(second.window / first.window > 1.8,
      "The window difference must be attributable to the two catalog presets");
    t.diagnostic(JSON.stringify({
      isolatedThreadId: threadId,
      requestModels: requests.map(request => request.model),
      turnIds: [first.turnId, second.turnId, third.turnId, fourth.turnId, fifth.turnId],
      modelContextWindows: [first.window, second.window, third.window, fourth.window, fifth.window],
    }));
  } finally {
    let coreExited = rpc == null;
    try {
      if (rpc) {
        rpc.child.stdin.end();
        let timer;
        const exit = await Promise.race([
          rpc.closed,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(
              new Error("Isolated core did not exit after stdin closed"),
            ), 20_000);
          }),
        ]).finally(() => clearTimeout(timer));
        coreExited = true;
        assert.equal(exit.error, undefined, exit.error?.message);
        assert.equal(exit.code, 0, rpc.diagnostics());
        t.diagnostic(`Isolated official core PID ${rpc.child.pid} exited with code ${exit.code}`);
      }
    } finally {
      if (providerListening) {
        provider.closeAllConnections();
        await new Promise(resolve => provider.close(resolve));
      }
      if (coreExited) {
        const expectedParent = fs.realpathSync(os.tmpdir());
        assert.equal(path.dirname(fs.realpathSync(root)), expectedParent);
        assert.ok(path.basename(root).startsWith("ccodex-desktop-context-alias-"));
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
        t.diagnostic(`Removed isolated profile ${root}`);
      } else {
        t.diagnostic(`Preserved ${root}: the isolated core has not exited`);
      }
    }
  }
});
