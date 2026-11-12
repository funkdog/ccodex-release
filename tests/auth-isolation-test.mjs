import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const model = {
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
};

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const freePort = async () => {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
};

test("running bridge hot-reloads its isolated saved account", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-copilot-auth-"));
  const authFile = path.join(home, "github-auth.json");
  fs.writeFileSync(authFile, JSON.stringify({ oauth_token: "token-a", login: "alpha" }));
  const upstream = http.createServer((_req, res) => {
    const body = JSON.stringify({ data: [model] });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  });
  const upstreamPort = await listen(upstream);
  const bridgePort = await freePort();
  const bridge = spawn(process.execPath, [path.join(root, "bridge", "server.mjs")], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_COPILOT_HOME: home,
      CODEX_COPILOT_AUTH_MODE: "auto",
      CODEX_COPILOT_MODEL_SAMPLES: "1",
      CODEX_COPILOT_API_BASE: `http://127.0.0.1:${upstreamPort}`,
      CODEX_COPILOT_GITHUB_API_BASE: `http://127.0.0.1:${upstreamPort}`,
      CODEX_COPILOT_BRIDGE_PORT: String(bridgePort),
    },
  });

  try {
    let health;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${bridgePort}/health`);
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch {
        /* bridge is starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(health.auth.login, "alpha");
    assert.equal(health.auth.source, "codex-copilot login");

    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(
      authFile,
      JSON.stringify({ oauth_token: "token-beta-longer", login: "beta" }),
    );
    const response = await fetch(`http://127.0.0.1:${bridgePort}/health`);
    health = await response.json();
    assert.equal(health.auth.login, "beta");
    assert.equal(health.auth.source, "codex-copilot login");
  } finally {
    bridge.kill();
    await new Promise((resolve) => bridge.once("exit", resolve));
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
