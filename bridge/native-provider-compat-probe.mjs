import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { buildCatalog } from "./catalog.mjs";
import { createResponsesWriter } from "./translate.mjs";
import { startNativePeer } from "../gateway/native-peer.mjs";
import { copilotProviderArguments, copilotProviderConfig, copilotProviderId } from "../gateway/copilot-provider.mjs";

/** Exercise the installed CLI's provider semantics without account state or remote inference. */
export async function probeNativeProviderCompatibility(executable) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mycodex-provider-compat-"));
  fs.chmodSync(root, 0o700);
  const profile = path.join(root, "profile"), workspace = path.join(root, "workspace"), bridgeHome = path.join(root, "bridge");
  for (const directory of [profile, workspace, bridgeHome]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(profile, "config.toml"), 'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[analytics]\nenabled = false\n', { mode: 0o600 });
  const model = "mycodex-compat-fixture";
  const catalog = buildCatalog([{ id: model, name: "MyCodex compatibility fixture", vendor: "OpenAI",
    model_picker_enabled: true, supported_endpoints: ["/responses"], capabilities: { type: "chat",
      supports: { reasoning_effort: ["low"] }, limits: { max_prompt_tokens: 4096, max_output_tokens: 128 } } }]);
  fs.writeFileSync(path.join(bridgeHome, "models.json"), JSON.stringify(catalog), { mode: 0o600 });
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/responses") { response.writeHead(404); response.end(); return; }
    try {
      const bytes = []; for await (const chunk of request) bytes.push(chunk);
      const body = JSON.parse(Buffer.concat(bytes).toString("utf8"));
      const writer = createResponsesWriter(response, body, new Map());
      writer.pushChunk({ choices: [{ delta: { content: "MYCODEX_COMPAT_OK" } }] }); writer.finish();
    } catch { response.destroy(); }
  });
  let peer;
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const config = { bridgeHome, bridgePort: server.address().port };
    const args = ["app-server", ...copilotProviderArguments(config), "-c", `model_provider=${copilotProviderId}`,
      "-c", `model_catalog_json=${JSON.stringify(copilotProviderConfig(config).model_catalog_json)}`];
    const env = { HOME: root, CODEX_HOME: profile, PATH: process.env.PATH };
    const open = async () => {
      peer = await startNativePeer({ executable, args, env, cwd: workspace, stderr: "ignore" });
      await peer.request("initialize", { clientInfo: { name: "mycodex_provider_compat", version: "1" },
        capabilities: { experimentalApi: true } }, { timeoutMs: 5000 });
      peer.notify({ method: "initialized" });
    };
    const runFixtureTurn = async threadId => {
      let complete;
      const completed = new Promise(resolve => { complete = resolve; });
      peer.onNotification = message => { if (message.method === "turn/completed") complete(message.params?.turn); };
      await peer.request("turn/start", { threadId, model, input: [{ type: "text", text: "Return the fixture response." }] }, { timeoutMs: 5000 });
      let timer;
      const turn = await Promise.race([completed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Native provider turn timed out.")), 5000);
      })]).finally(() => clearTimeout(timer));
      if (turn?.status !== "completed" || !JSON.stringify(turn.items ?? []).includes("MYCODEX_COMPAT_OK"))
        throw new Error("Native provider turn behavior changed.");
    };
    await open();
    const created = await peer.request("thread/start", { cwd: workspace, model, modelProvider: copilotProviderId,
      config: copilotProviderConfig(config), approvalPolicy: "never", sandbox: "read-only" }, { timeoutMs: 5000 });
    if (created?.thread?.modelProvider !== copilotProviderId || typeof created.thread.id !== "string") throw new Error("Native provider thread creation changed.");
    await runFixtureTurn(created.thread.id);
    await peer.dispose(); peer = undefined;
    await open();
    const resumed = await peer.request("thread/resume", { threadId: created.thread.id, model, modelProvider: copilotProviderId,
      config: { ...copilotProviderConfig(config), model_reasoning_effort: "low" } }, { timeoutMs: 5000 });
    if (resumed?.thread?.id !== created.thread.id || resumed.modelProvider !== copilotProviderId || resumed.model !== model)
      throw new Error("Native provider resume behavior changed.");
    await runFixtureTurn(created.thread.id);
    return { providerBehaviorVerified: true };
  } finally {
    await peer?.dispose();
    await new Promise(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Expected one native CLI executable path.");
  probeNativeProviderCompatibility(process.argv[2]).then(result => console.log(JSON.stringify(result)), error => {
    console.error(`Native provider compatibility failed: ${error.message}`); process.exitCode = 1;
  });
}
