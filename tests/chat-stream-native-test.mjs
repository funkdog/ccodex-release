import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { startNativePeer } from "../gateway/native-peer.mjs";
import { buildCatalog } from "../bridge/catalog.mjs";
import { memoryResponsesBridge } from "./fixtures/responses-bridge.mjs";

const executable = process.env.MYCODEX_TEST_NATIVE_CLI ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const chunk = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

for (const fault of ["none", "eof", "reset", "stall", "idle-retry", "reasoning-only", "no-heartbeat", "cancel"]) {
  test(`installed Codex long patch through Chat with ${fault}`, { timeout: 20000, skip: !fs.existsSync(executable) }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-chat-patch-"));
    const file = path.join(root, "owned-prototype.html");
    const html = "<p>长补丁 🐾</p>".repeat(6000) + "\n";
    const patch = `*** Begin Patch\n*** Add File: ${file}\n+${html.trimEnd()}\n*** End Patch`;
    const model = { id: "gemini-carbon-fixture", name: "Fixture", vendor: "Google", model_picker_enabled: true,
      supported_endpoints: ["/chat/completions"], capabilities: { type: "chat", supports: {} } };
    const catalog = path.join(root, "models.json");
    fs.writeFileSync(catalog, JSON.stringify(buildCatalog([model])));
    let upstreamClosed = false;
    let cancelReady;
    const readyToCancel = new Promise(resolve => { cancelReady = resolve; });
    const bridge = await memoryResponsesBridge(async (_req, res, body, count) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const sendTool = (text, first = false) => res.write(chunk({ tool_calls: [{ index: 0,
        ...(first ? { id: "call_owned_patch" } : {}),
        function: { ...(first ? { name: "apply_patch" } : {}), arguments: text } }] }));
      if (body.messages.some(message => message.role === "tool" && message.name === "apply_patch")) {
        assert.equal(fs.readFileSync(file, "utf8"), html);
        res.end(chunk({ content: "OWNED_PATCH_VERIFIED" }) + "data: [DONE]\n\n");
        return;
      }
      assert.ok(body.tools.some(tool => tool.function.name === "apply_patch"));
      if (count === 1 && fault === "reasoning-only") {
        res.end(chunk({ reasoning_text: "Considering the owned patch." }) +
          'data: {"choices":[],"usage":{"completion_tokens":8641,"reasoning_tokens":8618,"prompt_tokens":230278,"total_tokens":238919}}\n\ndata: [DONE]\n\n');
        return;
      }
      if (count === 1 && ["eof", "reset", "stall", "idle-retry", "cancel"].includes(fault)) {
        res.once("close", () => { upstreamClosed = true; });
        res.write(chunk({ content: "Creating the owned patch." }));
        // These two controls fail while the assistant message is still open,
        // matching the original session. Starting a tool would first finalize it.
        if (!["stall", "idle-retry"].includes(fault)) sendTool('{"input":"*** Begin Patch', true);
        cancelReady();
        if (["stall", "idle-retry", "cancel"].includes(fault)) return;
        await delay(80);
        if (fault === "eof") res.end();
        else res.destroy();
        return;
      }
      if (count > 1) {
        assert.equal(body.messages.at(-1).role, "user", "Gemini retries must not end with assistant prefill.");
        if (["stall", "idle-retry"].includes(fault)) {
          const retained = JSON.stringify(body.messages).includes("Creating the owned patch.");
          assert.equal(retained, fault === "stall", "An explicit failure preserves partial text that native idle cancellation loses.");
          if (fault === "idle-retry") {
            const digest = messages => createHash("sha256").update(JSON.stringify(messages)).digest("hex");
            assert.equal(digest(body.messages), digest(bridge.requests[0].messages), "Native idle retry replays identical messages.");
          }
        }
        assert.equal(fs.existsSync(file), false, "The interrupted patch must not have executed.");
      }
      const encoded = JSON.stringify({ input: patch });
      sendTool(encoded.slice(0, 20), true);
      // Exercise both slow parameter generation and a quiet interval longer than native SSE idle.
      for (let offset = 20; offset < encoded.length; offset += 16000) {
        await delay(80);
        if (res.destroyed) return;
        assert.equal(fs.existsSync(file), false, "The patch cannot execute before provider completion.");
        sendTool(encoded.slice(offset, offset + 16000));
      }
      await delay(["stall", "idle-retry"].includes(fault) ? 100 : 1400);
      if (!res.destroyed) res.end("data: [DONE]\n\n");
    }, { route: "/chat/completions", model, heartbeatMs: ["no-heartbeat", "idle-retry"].includes(fault) ? 60000 : 25,
      chatIdleTimeoutMs: fault === "stall" ? 250 : 3000 });
    let peer;
    t.after(async () => {
      await peer?.dispose?.();
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    });
    fs.writeFileSync(path.join(root, "config.toml"), [
      'cli_auth_credentials_store = "file"', 'check_for_update_on_startup = false',
      'model_provider = "owned-chat"', '[model_providers.owned-chat]', 'name = "Owned Chat fixture"',
      `base_url = ${JSON.stringify(bridge.url)}`, 'wire_api = "responses"', 'requires_openai_auth = false',
      'supports_websockets = false', 'stream_idle_timeout_ms = 1000',
      `stream_max_retries = ${fault === "no-heartbeat" ? 0 : 1}`, "",
    ].join("\n"));
    peer = await startNativePeer({ executable, args: ["app-server", "-c", `model_catalog_json=${JSON.stringify(catalog)}`],
      env: { HOME: root, CODEX_HOME: root, PATH: process.env.PATH }, cwd: root, stderr: "ignore" });
    const notifications = [];
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    peer.onNotification = message => {
      notifications.push(message);
      if (message.method === "turn/completed") finish(message.params.turn);
    };
    await peer.request("initialize", { clientInfo: { name: "owned-chat-patch-test", version: "1" }, capabilities: { experimentalApi: true } });
    peer.notify({ method: "initialized" });
    const started = await peer.request("thread/start", { model: model.id, cwd: root, ephemeral: true,
      approvalPolicy: "never", sandbox: "danger-full-access" });
    const turn = await peer.request("turn/start", { threadId: started.thread.id,
      input: [{ type: "text", text: "Create the owned test file with apply_patch." }] });
    if (fault === "cancel") {
      await readyToCancel;
      await peer.request("turn/interrupt", { threadId: started.thread.id, turnId: turn.turn.id });
    }
    const completed = await finished;
    if (["cancel", "no-heartbeat"].includes(fault)) {
      assert.equal(completed.status, fault === "cancel" ? "interrupted" : "failed", JSON.stringify(completed));
      assert.equal(fs.existsSync(file), false);
      assert.equal(bridge.requests.length, 1);
      if (fault === "no-heartbeat") assert.match(completed.error.message, /idle timeout waiting for SSE/);
      for (let i = 0; i < 40 && (bridge.audits[0]?.status === "running" || (fault === "cancel" && !upstreamClosed)); i++) await delay(25);
      assert.equal(bridge.audits[0].status, "cancelled");
    } else {
      assert.equal(completed.status, "completed", JSON.stringify({ turn: completed, logs: bridge.logs,
        diagnostics: bridge.diagnostics(), requests: bridge.requests.length }));
      assert.equal(fs.readFileSync(file, "utf8"), html);
      assert.equal(bridge.requests.length, fault === "none" ? 2 : 3);
      const edits = notifications.filter(message => message.method === "item/completed" && message.params.item.type === "fileChange");
      assert.equal(edits.length, 1, "Only the complete patch may execute, exactly once.");
      if (fault === "stall") assert.equal(bridge.audits[0].error.code, "upstream_stream_idle_timeout");
      if (fault === "reasoning-only") assert.equal(bridge.audits[0].error.code, "upstream_empty_response");
    }
    if (["eof", "reset", "stall", "idle-retry", "cancel"].includes(fault)) assert.equal(upstreamClosed, true);
    assert.deepEqual(bridge.diagnostics().errors, []);
    t.diagnostic(`Native PID ${peer.pid}; ${bridge.requests.length} upstream requests; ${notifications.filter(event => event.method === "error").length} native retry/error notifications.`);
  });
}
