import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { probeLocalBridge } from "../bridge/local-bridge.mjs";
import * as requestSize from "../bridge/request-size.mjs";
import { sanitizeResponsesBody } from "../bridge/request-sanitize.mjs";
import {
  isRetryableCopilotForbidden,
  isRetryableUpstreamError,
  isRetryableUpstreamStatus,
  retryDelayMs,
  waitForCopilotForbiddenRetry,
  waitForRetry,
} from "../bridge/upstream-retry.mjs";
import {
  observeNetworkState,
  resetNetworkStateForTests,
} from "../bridge/network-state.mjs";
import { setMcpEnabled } from "../tools/gen-config.mjs";

async function withHealth(bridge, run) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", bridge, pid: process.pid }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("local bridge probes reject the other product", async () => {
  await withHealth("claude-copilot", async (port) => {
    const probe = await probeLocalBridge({
      host: "127.0.0.1",
      port,
      expectedBridge: "codex-copilot",
    });
    assert.equal(probe.kind, "mismatch");
    assert.equal(probe.actualBridge, "claude-copilot");
  });
});

test("upstream 408 and transport timeouts are retryable", () => {
  assert.equal(isRetryableUpstreamStatus(408), true);
  assert.equal(isRetryableUpstreamStatus(400), false);
  assert.equal(
    isRetryableCopilotForbidden(
      403,
      "Access to this endpoint is forbidden. Please review our Terms of Service.",
    ),
    true,
  );
  assert.equal(isRetryableCopilotForbidden(403, "Permission denied."), false);
  assert.equal(
    isRetryableUpstreamError({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }),
    true,
  );
  assert.equal(retryDelayMs({ headers: { get: () => "2" } }, 0), 2000);
});

test("payload sizing never replaces native compaction or truncates historical tool outputs", () => {
  const oldOutput = "a".repeat(200_000);
  const recentOutput = "b".repeat(200_000);
  const request = {
    input: [
      { type: "function_call_output", call_id: "old", output: oldOutput },
      { type: "message", role: "assistant", content: [] },
      { type: "message", role: "user", content: [] },
      { type: "function_call_output", call_id: "recent", output: recentOutput },
    ],
  };
  const snapshot = structuredClone(request);
  const result = sanitizeResponsesBody(request);
  assert.deepEqual(result.input, request.input);
  assert.deepEqual(request, snapshot);
  assert.equal(requestSize.jsonBytes(result), requestSize.jsonBytes(request));
  assert.equal(Object.hasOwn(requestSize, "compactResponsesHistory"), false);
});

test("legacy parameter-stripping arguments cannot disable native effort, tools or compact state", () => {
  const request = {
    model: "synthetic-model", reasoning: { effort: "max" }, parallel_tool_calls: false,
    max_output_tokens: 128000, context_management: [{ type: "compaction", compact_threshold: 80000 }],
    tools: [{ type: "function", name: "synthetic", description: "Synthetic tool", parameters: {} }],
    input: [{ type: "compaction", id: "synthetic_compaction", encrypted_content: "SYNTHETIC_STATE" }],
  };
  assert.deepEqual(sanitizeResponsesBody(request, Object.keys(request)), request);
});

test("native Copilot's explicit non-storage request is preserved without modifying caller state", () => {
  const request = {
    model: "synthetic-model", store: false, stream: true, reasoning: { effort: "max", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    input: [{ type: "reasoning", summary: [], encrypted_content: "SYNTHETIC_STATE" }],
  };
  const before = structuredClone(request);
  assert.deepEqual(sanitizeResponsesBody(request), request);
  assert.deepEqual(request, before);
});

for (const [name, wait] of [
  ["transport", waitForRetry],
  ["transient forbidden", waitForCopilotForbiddenRetry],
]) {
  test(`${name} retry backoff respects native cancellation immediately`, async () => {
    const controller = new AbortController();
    const response = { headers: { get: () => "5" } };
    const waiting = wait(response, 0, controller.signal);
    controller.abort();
    await assert.rejects(waiting, { name: "AbortError" });
    await assert.rejects(wait(response, 0, controller.signal));
  });
}

test("network changes replace the built-in fetch dispatcher", async () => {
  const symbol = Symbol.for("undici.globalDispatcher.1");
  const original = globalThis[symbol];
  let closed = 0;
  class FakeAgent {
    close() {
      closed += 1;
      return Promise.resolve();
    }
  }
  try {
    globalThis[symbol] = new FakeAgent();
    resetNetworkStateForTests();
    assert.equal(observeNetworkState("network-a").changed, false);
    const changed = observeNetworkState("network-b");
    assert.equal(changed.changed, true);
    assert.equal(changed.connectionsReset, true);
    assert.ok(globalThis[symbol] instanceof FakeAgent);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, 1);
  } finally {
    globalThis[symbol] = original;
    resetNetworkStateForTests();
  }
});

test("blocked remote MCP can be disabled without changing other sections", () => {
  const input = [
    "[mcp_servers.openaiDeveloperDocs]",
    'url = "https://developers.openai.com/mcp"',
    "",
    "[mcp_servers.local]",
    'command = "local.exe"',
  ].join("\n");
  const output = setMcpEnabled(input, "openaiDeveloperDocs", false, "blocked");
  assert.match(output, /openaiDeveloperDocs\]\nurl = .+\n\s*enabled = false\n# blocked/);
  assert.match(output, /\[mcp_servers\.local\]\ncommand = "local\.exe"/);
});
