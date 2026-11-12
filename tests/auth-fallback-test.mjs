import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("auto auth pins saved login and allows only same-login recovery", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-fallback-"));
  fs.writeFileSync(
    path.join(home, "github-auth.json"),
    JSON.stringify({ oauth_token: "saved-token", login: "alpha" }),
  );
  const upstream = http.createServer((req, res) => {
    const body =
      req.url === "/user"
        ? JSON.stringify({ login: "alpha" })
        : JSON.stringify({
            data: [{
              id: "gpt-test",
              name: "GPT Test",
              model_picker_enabled: true,
              supported_endpoints: ["/responses"],
              capabilities: { type: "chat" },
            }],
          });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${upstream.address().port}`;
  Object.assign(process.env, {
    CODEX_COPILOT_HOME: home,
    CODEX_COPILOT_AUTH_MODE: "auto",
    CODEX_COPILOT_MODEL_SAMPLES: "1",
    CODEX_COPILOT_API_BASE: endpoint,
    CODEX_COPILOT_GITHUB_API_BASE: endpoint,
    GH_TOKEN: "manager-token",
  });
  try {
    const auth = await import(
      `${pathToFileURL(path.join(import.meta.dirname, "..", "bridge", "auth.mjs")).href}?test=${Date.now()}`
    );
    const pinned = await auth.resolveToken();
    assert.equal(pinned.source, "codex-copilot login");
    const recovered = await auth.resolveToken({
      allowSharedFallback: true,
      expectedLogin: "alpha",
      excludeToken: "saved-token",
    });
    assert.notEqual(recovered.source, "codex-copilot login");
    assert.notEqual(recovered.oauth_token, "saved-token");
    assert.equal(recovered.login, "alpha");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of [
      "CODEX_COPILOT_HOME",
      "CODEX_COPILOT_AUTH_MODE",
      "CODEX_COPILOT_MODEL_SAMPLES",
      "CODEX_COPILOT_API_BASE",
      "CODEX_COPILOT_GITHUB_API_BASE",
      "GH_TOKEN",
    ]) {
      delete process.env[key];
    }
  }
});
