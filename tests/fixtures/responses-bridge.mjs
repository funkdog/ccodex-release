import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { compileFunction } from "node:vm";
import { editSettings, readSetting } from "../../tools/config-document.mjs";
import { initializeCliSettings, surfaceConfigFile } from "../../bridge/surface-settings.mjs";
import { DEFAULT_CONTEXT_SUFFIX, LONG_CONTEXT_SERVICE_TIER, LONG_CONTEXT_SUFFIX, plainName } from "../../bridge/catalog.mjs";
import { sanitizeResponsesBody } from "../../bridge/request-sanitize.mjs";
import { buildChatRequest, createResponsesWriter, readSse, sendJson } from "../../bridge/translate.mjs";
import { forwardResponsesStream, ResponsesStreamError } from "../../bridge/responses-stream.mjs";
import { fetchResponsesUpstream } from "../../bridge/upstream-responses.mjs";
import { encodeResponseEvent, failedResponseEvent, isContextWindowError, normalizeResponsesError, normalizeResponsesErrorEvent } from "../../bridge/responses-errors.mjs";
import { isRetryableCopilotForbidden, isRetryableUpstreamError, isRetryableUpstreamStatus, waitForCopilotForbiddenRetry, waitForRetry } from "../../bridge/upstream-retry.mjs";
import { websocketUpstream } from "./websocket-upstream.mjs";
import { syntheticCopilotMetadata } from "./copilot-sdk-metadata.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const listen = server => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    resolve(server.address().port);
  });
});

function functionsFromSource(file, names, bindings) {
  const source = fs.readFileSync(file, "utf8");
  const functions = names.map(name => {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `Missing production function ${name}.`);
    const beginning = source.lastIndexOf("\n", start) + 1;
    const ending = source.indexOf("\n}", start);
    assert.ok(ending > start, `Missing production boundary for ${name}.`);
    return source.slice(beginning, ending + 2).replace(/^export /, "");
  }).join("\n");
  return compileFunction(`${functions}\nreturn { ${names.join(", ")} };`,
    Object.keys(bindings), { filename: file })(...Object.values(bindings));
}

function memoryIdentityStore(packageRoot) {
  const records = new Map();
  const missing = () => Object.assign(new Error("Memory identity is absent."), { code: "ENOENT" });
  const memory = {
    async mkdir() {},
    async open(file) {
      return {
        async writeFile(text) { records.set(file, text); },
        async sync() {},
        async close() {},
      };
    },
    async rename(from, to) { records.set(to, records.get(from)); records.delete(from); },
    async rm(file) { records.delete(file); },
    async readFile(file) { if (!records.has(file)) throw missing(); return records.get(file); },
  };
  const file = path.join(packageRoot, "bridge/response-identity.mjs");
  const source = fs.readFileSync(file, "utf8")
    .replace(/^import [^\n]+\n/gm, "")
    .replace(/^export /gm, "");
  const identities = compileFunction(`${source}\nreturn { ResponseIdentityStore, ResponseIdentityError };`,
    ["fs", "path", "createHash", "randomUUID"], { filename: file })
    (memory, path, createHash, randomUUID);
  return { ...identities, clear: () => records.clear() };
}

// Execute the real request handlers without a disk-backed profile or paid inference.
export async function memoryResponsesBridge(responder, {
  route = "/responses", packageRoot = root, heartbeatMs = 10,
} = {}) {
  const requests = [];
  const audits = [];
  const logs = [];
  const errors = [];
  const jobs = new Set();
  const upstream = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      await responder(req, res, body, requests.length);
    } catch (error) {
      errors.push(error);
      res.destroy(error);
    }
  });
  const upstreamPort = await listen(upstream);
  const identities = memoryIdentityStore(packageRoot);
  const bindings = {
    ...identities, AbortController, Buffer, fetch,
    CODEX_COPILOT_HOME: "memory-profile", COPILOT_API: `http://127.0.0.1:${upstreamPort}`,
    copilotApiFor: async () => `http://127.0.0.1:${upstreamPort}`,
    SSE_HEARTBEAT_MS: heartbeatMs, TRANSIENT_FORBIDDEN_MAX_ATTEMPTS: 10,
    state: { login: "synthetic-account" }, ensureAuth: async () => "synthetic-token",
    copilotHeaders: (_token, headers) => ({ ...headers, "content-type": "application/json" }),
    recoverSameAccountCredential: async () => null, activateRecoveredCredential() {},
    observeQuotaHeaders() {}, log: message => logs.push(message),
    sanitizeResponsesBody, buildChatRequest, createResponsesWriter, readSse, sendJson,
    forwardResponsesStream, ResponsesStreamError, fetchResponsesUpstream,
    encodeResponseEvent, failedResponseEvent, isContextWindowError, normalizeResponsesError,
    normalizeResponsesErrorEvent, isRetryableCopilotForbidden, isRetryableUpstreamError,
    isRetryableUpstreamStatus, waitForCopilotForbiddenRetry, waitForRetry,
  };
  const handlers = functionsFromSource(path.join(packageRoot, "bridge/server.mjs"), [
    "apiError", "proxyResponses", "proxyResponsesRequest", "proxyChat", "proxyChatRequest",
  ], bindings);
  const model = {
    id: "synthetic-model", vendor: "OpenAI", capabilities: {
      supports: { reasoning_effort: ["max"], parallel_tool_calls: true },
      limits: { max_prompt_tokens: 922000, max_output_tokens: 128000 },
    },
  };
  const proxy = http.createServer((req, res) => {
    const job = (async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const audit = { status: "running" };
      audits.push(audit);
      request._audit = { complete(changes) {
        if (audit.status === "running") Object.assign(audit, changes);
      } };
      if (route === "/responses") await handlers.proxyResponses(req, res, request);
      else await handlers.proxyChat(req, res, request, model);
    })().catch(error => {
      errors.push(error);
      handlers.apiError(res, 502, error.message);
    });
    jobs.add(job);
    job.finally(() => jobs.delete(job));
  });
  let proxyPort;
  try { proxyPort = await listen(proxy); } catch (error) {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    throw error;
  }
  return {
    url: `http://127.0.0.1:${proxyPort}`, requests, audits, logs,
    forgetIdentities: identities.clear,
    diagnostics: () => ({ errors: errors.map(error => error.message), activeHandlers: jobs.size,
      filesystemProfiles: 0, cloudInferenceRequests: 0 }),
    async close() {
      proxy.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([
        new Promise(resolve => proxy.close(resolve)),
        new Promise(resolve => upstream.close(resolve)),
        ...jobs,
      ]);
      identities.clear();
      assert.deepEqual(errors, [], "An in-memory production handler failed unexpectedly.");
    },
  };
}

export function memoryModelSelection(shared, cli = "", { packageRoot = root, models } = {}) {
  const home = "memory-selection";
  const catalogFile = path.join(home, "models.json");
  const configs = new Map([
    [surfaceConfigFile(home), shared], [surfaceConfigFile(home, "cli"), cli],
    [catalogFile, JSON.stringify({ models })],
  ]);
  let selection;
  const functions = functionsFromSource(path.join(packageRoot, "bridge/use-model.mjs"), [
    "readConfig", "catalog", "normalizeContextTier", "selectEntry", "use",
  ], {
    fs: { readFileSync: file => configs.get(file) },
    CODEX_COPILOT_HOME: home, CONFIG_FILE: surfaceConfigFile(home), CATALOG_FILE: catalogFile,
    DEFAULT_CONTEXT_SUFFIX, LONG_CONTEXT_SERVICE_TIER, LONG_CONTEXT_SUFFIX, plainName,
    editSettings, readSetting, surfaceConfigFile,
    prepareCliSettings: () => configs.set(surfaceConfigFile(home, "cli"),
      initializeCliSettings(configs.get(surfaceConfigFile(home)), configs.get(surfaceConfigFile(home, "cli")))),
    atomicWrite(file, text, options) {
      assert.equal(configs.get(file), options.expectedContents);
      configs.set(file, text);
    },
    publishSelectionSnapshot: value => { selection = value; },
  });
  return {
    use: functions.use, config: surface => configs.get(surfaceConfigFile(home, surface)),
    selection: () => selection,
  };
}

export function rotatingEvents(responseId = "resp_rotating") {
  const items = [
    { type: "reasoning", summary: [{ type: "summary_text", text: "SYNTHETIC_REASONING" }],
      encrypted_content: "SYNTHETIC_ENCRYPTED_CONTENT" },
    { type: "message", role: "assistant", phase: "commentary",
      content: [{ type: "output_text", text: "SYNTHETIC_GENUINE_REPEAT" }] },
    { type: "message", role: "assistant", phase: "commentary",
      content: [{ type: "output_text", text: "SYNTHETIC_GENUINE_REPEAT" }] },
    { type: "message", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "SYNTHETIC_FINAL" }] },
  ];
  const events = [{ type: "response.created", response: { id: responseId } }];
  for (const [output_index, item] of items.entries()) {
    const id = suffix => `${responseId}-opaque-${output_index}-${suffix}`;
    events.push({ type: "response.output_item.added", output_index, item: {
      ...item, id: id("start"), ...(item.type === "message" ? { content: [] } : { summary: [] }),
    } });
    if (item.type === "message") {
      events.push({ type: "response.output_text.delta", output_index,
        item_id: id("delta"), content_index: 0, delta: item.content[0].text });
    } else {
      events.push({ type: "response.reasoning_summary_part.added", output_index,
        item_id: id("part"), summary_index: 0, part: { type: "summary_text", text: "" } });
      events.push({ type: "response.reasoning_summary_text.delta", output_index,
        item_id: id("delta"), summary_index: 0, delta: item.summary[0].text });
    }
    events.push({ type: "response.output_item.done", output_index, item: { ...item, id: id("done") } });
  }
  events.push({ type: "response.completed", response: {
    id: responseId, status: "completed",
    output: items.map((item, index) => ({ ...item, id: `${responseId}-opaque-${index}-completed` })),
    usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
  } });
  return events.map((event, sequence_number) => ({ ...event, sequence_number }));
}

export function encodeEvents(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

export async function responsesBridge(home, t, responder, {
  env: extraEnv = {}, route = "/responses", packageRoot = root, websocketResponder,
} = {}) {
  const requests = [];
  const activeResponses = new Set();
  let stderr = "";
  const upstream = http.createServer(async (req, res) => {
    try {
      if (req.url === "/models") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
          id: "synthetic-model", name: "Synthetic", vendor: "OpenAI",
          model_picker_enabled: true,
          supported_endpoints: websocketResponder ? [route, "ws:/responses"] : [route],
          capabilities: { type: "chat", supports: { reasoning_effort: ["low"] },
            limits: { max_prompt_tokens: 100000, max_output_tokens: 10000 } },
        }] }));
        return;
      }
      if (req.url !== route) { res.writeHead(404).end(); return; }
      activeResponses.add(res);
      res.once("close", () => activeResponses.delete(res));
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      await responder(req, res, body, requests.length);
    } catch (error) {
      stderr += `\nMock upstream: ${error.stack}`;
      res.destroy(error);
    }
  });
  const websocket = websocketResponder ? websocketUpstream(upstream, async (req, peer, body) => {
    requests.push(body);
    await websocketResponder(req, peer, body, requests.length);
  }, error => { stderr += `\nMock WebSocket upstream: ${error.stack}`; }) : null;
  const upstreamPort = await listen(upstream);
  let bridgePort;
  const allocatePort = async () => {
    const portReservation = net.createServer();
    const port = await listen(portReservation);
    await new Promise(resolve => portReservation.close(resolve));
    return port;
  };
  const profile = path.join(home, "bridge-profile");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "github-auth.json"),
    JSON.stringify({ oauth_token: "synthetic-token", login: "synthetic-account" }));
  fs.writeFileSync(path.join(profile, "copilot-cli-models.json"), JSON.stringify({
    fetched_at: new Date().toISOString(),
    models: [{
      id: "synthetic-model", default_prompt_tokens: 100000, long_context_prompt_tokens: null,
    }],
  }));
  const sdk = syntheticCopilotMetadata(packageRoot, profile, [{
    id: "synthetic-model", billing: { tokenPrices: { maxPromptTokens: 100000 } },
  }]);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY)(?:$|_)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    CODEX_HOME: profile, CODEX_COPILOT_HOME: profile, CODEX_COPILOT_AUTH_MODE: "saved",
    CODEX_COPILOT_CLI_SDK: sdk.sdkPath,
    CODEX_COPILOT_MODEL_SAMPLES: "1", CODEX_COPILOT_BRIDGE_HOST: "127.0.0.1",
    COPILOT_HOME: path.join(profile, "copilot"), COPILOT_DISABLE_KEYTAR: "1",
    COPILOT_AUTO_UPDATE: "false",
    COPILOT_PKG_CACHE_HOME: path.join(profile, "copilot-cache"),
    COPILOT_CACHE_HOME: path.join(profile, "copilot-cache"),
    CODEX_COPILOT_API_BASE: `http://127.0.0.1:${upstreamPort}`,
    CODEX_COPILOT_GITHUB_API_BASE: `http://127.0.0.1:${upstreamPort}`,
    ...extraEnv,
  });
  let child;
  let closed;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (closed) await closed;
  };
  const start = async ({ keepPort = false } = {}) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!keepPort || !bridgePort) {
        bridgePort = await allocatePort();
        env.CODEX_COPILOT_BRIDGE_PORT = String(bridgePort);
      }
      stderr = "";
      child = spawn(process.execPath, [...sdk.nodeArguments, path.join(packageRoot, "bridge/server.mjs")], {
        cwd: profile, env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
      });
      t.diagnostic(`Isolated Responses bridge PID ${child.pid}; profile ${profile}`);
      closed = new Promise(resolve => child.once("close", resolve));
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16000); });
      let startupError;
      child.once("error", error => { startupError = error; });
      const deadline = Date.now() + 30000;
      let exitedEarly = false;
      for (;;) {
        if (startupError) throw startupError;
        if (child.exitCode !== null) {
          exitedEarly = true;
          break;
        }
        try {
          const response = await fetch(`http://127.0.0.1:${bridgePort}/health`,
            { signal: AbortSignal.timeout(1500) });
          if (response.ok && (await response.json()).models > 0) {
            await fetch(`http://127.0.0.1:${bridgePort}/catalog/refresh?max_age_ms=60000`,
              { method: "POST", signal: AbortSignal.timeout(5000) });
            return;
          }
        } catch { /* Wait for the owned local listener. */ }
        if (Date.now() >= deadline) throw new Error(`Bridge did not become ready: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await stop();
      if (!exitedEarly || attempt === 2) {
        assert.equal(child.exitCode, null, `Bridge exited early: ${stderr}`);
      }
    }
  };
  const close = async () => {
    await stop();
    websocket?.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  };
  try { await start(); } catch (error) { await close(); throw error; }
  return {
    get url() { return `http://127.0.0.1:${bridgePort}`; },
    profile, requests, close,
    diagnostics: () => ({
      stderr, requests: requests.length, pid: child.pid,
      activeUpstreamHttpStreams: activeResponses.size,
      activeUpstreamWebSockets: websocket?.activeSockets || 0,
    }),
    async restart() { await stop(); await start({ keepPort: true }); },
  };
}
