import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";
import { buildCatalog } from "../bridge/catalog.mjs";
import { createResponsesWriter } from "../bridge/translate.mjs";
import { copilotProviderArguments, copilotProviderConfig, copilotProviderId } from "../gateway/copilot-provider.mjs";

const executable = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
test("installed Codex exec creates a persistent repair-style thread through an isolated local provider",
  { skip: process.platform !== "darwin" || !fs.existsSync(executable), timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mycodex-repair-exec-"));
  const profile = path.join(root, "profile"), workspace = path.join(root, "workspace"), bridgeHome = path.join(root, "bridge");
  for (const directory of [profile, workspace, bridgeHome]) fs.mkdirSync(directory, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(profile, "config.toml"), 'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[analytics]\nenabled = false\n', { mode: 0o600 });
  const model = "mycodex-repair-fixture";
  const catalog = buildCatalog([{ id: model, name: "Repair fixture", vendor: "OpenAI", model_picker_enabled: true,
    supported_endpoints: ["/responses"], capabilities: { type: "chat", supports: { reasoning_effort: ["low"] },
      limits: { max_prompt_tokens: 4096, max_output_tokens: 128 } } }]);
  fs.writeFileSync(path.join(bridgeHome, "models.json"), JSON.stringify(catalog), { mode: 0o600 });
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/responses") { response.writeHead(404); response.end(); return; }
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const writer = createResponsesWriter(response, body, new Map());
      writer.pushChunk({ choices: [{ delta: { content: "REPAIR_FIXTURE_OK" } }] }); writer.finish();
    } catch { response.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { bridgeHome, bridgePort: server.address().port };
  const args = ["exec", "--json", "--skip-git-repo-check", "-C", workspace,
    ...copilotProviderArguments(config), "-c", `model_provider=${copilotProviderId}`,
    "-c", `model_catalog_json=${JSON.stringify(copilotProviderConfig(config).model_catalog_json)}`,
    "-m", model, "--sandbox", "read-only", "fixture"];
  const child = spawn(executable, args, { cwd: workspace,
    env: { HOME: root, CODEX_HOME: profile, PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  clearTimeout(timer);
  assert.equal(code, 0, stderr.slice(0, 1000));
  const events = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const started = events.find(event => event.type === "thread.started");
  assert.match(started?.thread_id ?? "", /^[a-zA-Z0-9_-]{8,128}$/);
  assert.ok(events.some(event => event.type === "turn.completed"));
  assert.ok(fs.readdirSync(profile).some(name => name === "sessions" || name === "session_index.jsonl"));
});
