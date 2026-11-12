import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { syntheticCopilotMetadata } from "./fixtures/copilot-sdk-metadata.mjs";
import { encodeEvents, memoryResponsesBridge, rotatingEvents } from "./fixtures/responses-bridge.mjs";

const root = path.resolve(import.meta.dirname, "..");

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });

const freePort = async () => {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
};

async function startIsolatedBridge(home, upstreamPort) {
  fs.writeFileSync(path.join(home, "copilot-cli-models.json"), JSON.stringify({
    fetched_at: new Date().toISOString(),
    models: [{ id: "gpt-test", default_prompt_tokens: 272000, long_context_prompt_tokens: null }],
  }));
  const sdk = syntheticCopilotMetadata(root, home, [{
    id: "gpt-test", billing: { tokenPrices: { maxPromptTokens: 272000 } },
  }]);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const bridgePort = await freePort();
    const bridge = spawn(process.execPath, [...sdk.nodeArguments, path.join(root, "bridge", "server.mjs")], {
      cwd: root,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        CODEX_COPILOT_HOME: home,
        CODEX_COPILOT_AUTH_MODE: "saved",
        CODEX_COPILOT_CLI_SDK: sdk.sdkPath,
        CODEX_COPILOT_MODEL_SAMPLES: "1",
        CODEX_COPILOT_API_BASE: `http://127.0.0.1:${upstreamPort}`,
        CODEX_COPILOT_GITHUB_API_BASE: `http://127.0.0.1:${upstreamPort}`,
        CODEX_COPILOT_BRIDGE_PORT: String(bridgePort),
      },
    });
    const closed = new Promise((resolve) => bridge.once("close", resolve));
    const stop = async () => {
      if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill();
      await closed;
    };
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && bridge.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${bridgePort}/health`, {
          signal: AbortSignal.timeout(1500),
        });
        if (response.ok) return { bridgePort, stop };
      } catch {
        /* bridge is starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await stop();
  }
  throw new Error("Isolated test bridge did not become ready.");
}

test("upstream 408 retries without compacting historical tool output", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-copilot-408-"));
  fs.writeFileSync(
    path.join(home, "github-auth.json"),
    JSON.stringify({ oauth_token: "test-token", login: "test-user" }),
  );
  const requestSizes = [];
  const requestBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/models") {
      const body = JSON.stringify({
        data: [{
          id: "gpt-test",
          name: "GPT Test",
          vendor: "OpenAI",
          model_picker_enabled: true,
          is_chat_default: true,
          supported_endpoints: ["/responses"],
          capabilities: {
            type: "chat",
            supports: { reasoning_effort: ["low", "high"] },
            limits: {
              max_prompt_tokens: 272000,
              max_context_window_tokens: 400000,
              max_output_tokens: 128000,
            },
          },
        }],
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (url.pathname === "/responses") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requestSizes.push(Buffer.concat(chunks).length);
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (requestSizes.length === 1) {
        const body = JSON.stringify({
          error: {
            code: "408",
            message: "Timed out reading request body. Try again, or use a smaller request size.",
          },
        });
        res.writeHead(408, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }
      const body = JSON.stringify({ id: "response-test", output: [], usage: {} });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const { bridgePort, stop } = await startIsolatedBridge(home, upstreamPort);

  try {
    const response = await fetch(`http://127.0.0.1:${bridgePort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        stream: false,
        input: [
          {
            type: "function_call_output",
            call_id: "old",
            output: "x".repeat(300_000),
          },
          { type: "message", role: "assistant", content: [] },
          { type: "message", role: "user", content: [] },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(requestSizes.length, 2);
    assert.equal(requestSizes[1], requestSizes[0]);
    assert.deepEqual(requestBodies[1], requestBodies[0]);
  } finally {
    await stop();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

const nativeUsage = {
  input_tokens: 90000, input_tokens_details: { cached_tokens: 80000 },
  output_tokens: 25, output_tokens_details: { reasoning_tokens: 11 }, total_tokens: 90025,
};
const historicalRequest = () => ({
  model: "synthetic-model", stream: false, reasoning: { effort: "max" },
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "SYNTHETIC_ORIGINAL_TASK" }] },
    { type: "function_call", id: "opaque_call", call_id: "call_old",
      name: "synthetic_tool", arguments: "{}" },
    { type: "function_call_output", call_id: "call_old",
      output: `${"x".repeat(300000)}SYNTHETIC_REQUIRED_MIDDLE_DETAIL${"y".repeat(300000)}` },
    { type: "message", role: "assistant", phase: "commentary",
      content: [{ type: "output_text", text: "SYNTHETIC_RETAINED_COMMENTARY" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "SYNTHETIC_CONTINUE" }] },
  ],
});
const parseEvents = text => text.split(/\r\n\r\n|\n\n/).flatMap(frame => {
  const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart()).join("\n");
  try { return [JSON.parse(data)]; } catch { return []; }
}).filter(event => event?.type !== "ping");
const postMemory = (bridge, request, signal = AbortSignal.timeout(15000)) =>
  fetch(`${bridge.url}/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(request), signal,
  });
const succeed = (res, route, { streaming = false, usage = true } = {}) => {
  if (route === "/responses") {
    const events = rotatingEvents("resp_native_contract");
    events.at(-1).response.usage = usage ? nativeUsage : null;
    res.writeHead(200, { "content-type": streaming ? "text/event-stream" : "application/json" })
      .end(streaming ? encodeEvents(events) : JSON.stringify(events.at(-1).response));
  } else {
    const chunk = {
      id: "synthetic_chat", choices: [{ index: 0, message: {
        role: "assistant", content: "SYNTHETIC_FINAL",
      }, finish_reason: "stop" }],
      ...(usage ? { usage: { prompt_tokens: 90000, completion_tokens: 25, total_tokens: 90025,
        prompt_tokens_details: { cached_tokens: 80000 },
        completion_tokens_details: { reasoning_tokens: 11 } } } : {}),
    };
    res.writeHead(200, { "content-type": streaming ? "text/event-stream" : "application/json" })
      .end(streaming ? `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n` : JSON.stringify(chunk));
  }
};
const until = async (check, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    assert.ok(Date.now() < deadline, "An in-memory production request did not settle.");
    await delay(10);
  }
};

for (const route of ["/responses", "/chat/completions"]) {
  test(`memory: ${route} 408 retries retain history, tool identity, max effort and genuine usage`, async () => {
    const bridge = await memoryResponsesBridge(async (_req, res, _body, number) => {
      if (number === 1) {
        res.writeHead(408, { "content-type": "application/json", "retry-after": "0" })
          .end(JSON.stringify({ error: { code: "request_timeout", message: "Synthetic timeout." } }));
      } else succeed(res, route);
    }, { route });
    try {
      const request = historicalRequest();
      const snapshot = structuredClone(request);
      const response = await postMemory(bridge, request);
      assert.equal(response.status, 200);
      const completed = await response.json();
      assert.equal(bridge.requests.length, 2);
      assert.deepEqual(bridge.requests[1], bridge.requests[0]);
      assert.deepEqual(request, snapshot);
      assert.ok(JSON.stringify(bridge.requests[1]).includes("SYNTHETIC_REQUIRED_MIDDLE_DETAIL"));
      assert.equal(bridge.requests[1].model, request.model);
      if (route === "/responses") assert.deepEqual(bridge.requests[1].input, request.input);
      else assert.equal(bridge.requests[1].reasoning_effort, "max");
      assert.deepEqual(completed.usage, nativeUsage);
      assert.equal(bridge.audits[0].attempts, 2);
      assert.equal(bridge.audits[0].status, "complete");
    } finally { await bridge.close(); }
  });

  test(`memory: ${route} context errors activate native recovery once, not timeout retry or input rewriting`, async () => {
    const bridge = await memoryResponsesBridge(async (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: {
        code: "invalid_request_body", message: "Your input exceeds the context window of this model.",
        future_provider_detail: "retained",
      } }));
    }, { route });
    try {
      const request = { ...historicalRequest(), stream: true };
      const response = await postMemory(bridge, request);
      assert.equal(response.status, 200);
      const events = parseEvents(await response.text());
      assert.equal(events.at(-1).type, "response.failed");
      assert.equal(events.at(-1).response.error.code, "context_length_exceeded");
      assert.equal(events.at(-1).response.error.future_provider_detail, "retained");
      assert.equal(bridge.requests.length, 1);
      assert.ok(JSON.stringify(bridge.requests[0]).includes("SYNTHETIC_REQUIRED_MIDDLE_DETAIL"));
      assert.equal(bridge.audits[0].error.code, "context_length_exceeded");
    } finally { await bridge.close(); }
  });

  test(`memory: ${route} a real completion without provider usage never fabricates zero token counts`, async () => {
    const bridge = await memoryResponsesBridge(async (_req, res) => succeed(res, route, {
      streaming: true, usage: false,
    }), { route });
    try {
      const response = await postMemory(bridge, { ...historicalRequest(), stream: true });
      const completed = parseEvents(await response.text()).at(-1);
      assert.equal(completed.type, "response.completed");
      assert.equal(completed.response.usage, null);
      assert.equal(bridge.audits[0].usage, null);
      assert.equal(bridge.requests.length, 1);
    } finally { await bridge.close(); }
  });

  for (const status of [408, 403]) {
    test(`memory: ${route} native cancellation interrupts a ${status} backoff without another upstream request`, async () => {
      const bridge = await memoryResponsesBridge(async (_req, res) => {
        res.writeHead(status, { "content-type": "application/json", "retry-after": "5" })
          .end(JSON.stringify({ error: {
            code: status === 408 ? "request_timeout" : "forbidden",
            message: status === 408 ? "Synthetic timeout."
              : "Access to this endpoint is forbidden. Please review our Terms of Service.",
          } }));
      }, { route });
      try {
        const controller = new AbortController();
        const response = postMemory(bridge, historicalRequest(), controller.signal).catch(error => error);
        await until(() => bridge.logs.some(message => message.includes(" retry ")));
        controller.abort();
        await response;
        await until(() => bridge.audits[0]?.status === "cancelled", 1000);
        await until(() => bridge.diagnostics().activeHandlers === 0, 1000);
        assert.equal(bridge.requests.length, 1);
      } finally { await bridge.close(); }
    });
  }

  test(`memory: ${route} cancelling after partial output closes the same upstream instead of replaying a tool or message`, async () => {
    let upstreamClosed = false;
    const bridge = await memoryResponsesBridge(async (_req, res) => {
      res.once("close", () => { upstreamClosed = true; });
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (route === "/responses") res.write(encodeEvents(rotatingEvents().slice(0, 5)));
      else res.write('data: {"id":"synthetic_chat","choices":[{"index":0,"delta":{"role":"assistant","content":"SYNTHETIC_PARTIAL"}}]}\n\n');
    }, { route });
    try {
      const controller = new AbortController();
      const response = await postMemory(bridge, { ...historicalRequest(), stream: true }, controller.signal);
      const reader = response.body.getReader();
      assert.equal((await reader.read()).done, false);
      controller.abort();
      await reader.cancel().catch(() => {});
      await until(() => bridge.audits[0]?.status === "cancelled");
      await until(() => upstreamClosed);
      assert.equal(bridge.requests.length, 1);
    } finally { await bridge.close(); }
  });
}

test("memory: Responses native compaction output and tool calls survive a late reasoning boundary on one stream", async () => {
  const events = rotatingEvents("resp_compaction_and_tool");
  const compaction = { type: "compaction", id: "opaque_compaction", encrypted_content: "SYNTHETIC_COMPACTED_STATE" };
  const tool = { type: "function_call", id: "opaque_tool", call_id: "call_native",
    name: "synthetic_tool", arguments: "{}", status: "completed" };
  const suffix = [
    { type: "response.output_item.added", output_index: 1, item: compaction },
    { type: "response.output_item.done", output_index: 1, item: compaction },
    { type: "response.output_item.added", output_index: 2, item: tool },
    { type: "response.output_item.done", output_index: 2, item: tool },
    { type: "response.completed", response: {
      id: "resp_compaction_and_tool", status: "completed",
      output: [events[4].item, compaction, tool], usage: nativeUsage,
    } },
  ];
  const bridge = await memoryResponsesBridge(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(encodeEvents(events.slice(0, 4)));
    await delay(80);
    res.end(encodeEvents([events[4], ...suffix]));
  });
  try {
    const response = await postMemory(bridge, { ...historicalRequest(), stream: true });
    const received = parseEvents(await response.text());
    assert.deepEqual(received.map(event => event.type),
      [...events.slice(0, 5), ...suffix].map(event => event.type));
    assert.equal(received.at(-1).response.output[1].encrypted_content, compaction.encrypted_content);
    assert.equal(received.at(-1).response.output[2].call_id, tool.call_id);
    assert.deepEqual(received.at(-1).response.usage, nativeUsage);
    assert.equal(bridge.requests.length, 1);
  } finally { await bridge.close(); }
});

for (const param of [
  "reasoning.effort", "tools.0.parameters", "parallel_tool_calls", "max_output_tokens",
  "context_management", "include", "input",
]) {
  test(`memory: unsupported ${param} fails once without silently disabling a native capability`, async () => {
    const providerError = {
      code: "unsupported_parameter", type: "invalid_request_error", param,
      message: `Unknown parameter: ${param}`, future_provider_detail: "preserved",
    };
    const bridge = await memoryResponsesBridge(async (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: providerError }));
    });
    try {
      const request = {
        ...historicalRequest(), parallel_tool_calls: false, max_output_tokens: 128000,
        tools: [{ type: "function", name: "synthetic", description: "Synthetic", parameters: {} }],
        context_management: [{ type: "compaction", compact_threshold: 80000 }],
        include: ["reasoning.encrypted_content"],
      };
      const response = await postMemory(bridge, request);
      assert.equal(response.status, 400);
      assert.deepEqual((await response.json()).error, providerError);
      assert.equal(bridge.requests.length, 1);
      assert.deepEqual(bridge.requests[0], request);
      assert.equal(bridge.audits[0].status, "error");
      assert.equal(bridge.audits[0].attempts, 1);
      assert.equal(bridge.audits[0].error.code, providerError.code);
    } finally { await bridge.close(); }
  });
}

test("transient Copilot Terms of Service 403 retries inside the bridge", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-copilot-403-"));
  fs.writeFileSync(
    path.join(home, "github-auth.json"),
    JSON.stringify({ oauth_token: "test-token", login: "test-user" }),
  );
  let responseAttempts = 0;
  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/models") {
      const body = JSON.stringify({
        data: [{
          id: "gpt-test",
          name: "GPT Test",
          vendor: "OpenAI",
          model_picker_enabled: true,
          is_chat_default: true,
          supported_endpoints: ["/responses"],
          capabilities: {
            type: "chat",
            supports: { reasoning_effort: ["low", "high"] },
            limits: {
              max_prompt_tokens: 272000,
              max_context_window_tokens: 400000,
              max_output_tokens: 128000,
            },
          },
        }],
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (url.pathname === "/responses") {
      for await (const _chunk of req) {
        /* consume the request before replying */
      }
      responseAttempts += 1;
      if (responseAttempts < 9) {
        const body = JSON.stringify({
          error: {
            code: "forbidden",
            message:
              "Access to this endpoint is forbidden. Please review our Terms of Service.",
          },
        });
        res.writeHead(403, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "retry-after": "0",
        });
        res.end(body);
        return;
      }
      const body = JSON.stringify({ id: "response-test", output: [], usage: {} });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const { bridgePort, stop } = await startIsolatedBridge(home, upstreamPort);

  try {
    const response = await fetch(`http://127.0.0.1:${bridgePort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        stream: false,
        input: [{ type: "message", role: "user", content: [] }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(responseAttempts, 9);
  } finally {
    await stop();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
