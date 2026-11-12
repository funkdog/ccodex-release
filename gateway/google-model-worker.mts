import "../tools/typescript-runtime.mjs";
import { assertTypeScriptBuild } from "../tools/typescript-state.mjs";
import type { GoogleSdk, GoogleRequest, GoogleChunk } from "./sdk-contracts.mjs";
import type { Model } from "./contracts.mjs";
import type { GoogleWorkerParams } from "./google-contracts.mjs";
// Google CLI Core's content generator only. No GeminiClient prompt loop,
// session/new, tool registry initialization or Gemini agent tools are used.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readMessages, writeMessage } from "./ipc.mjs";
import { assertGeminiAccount } from "./engines/gemini-cli.mjs";

assertTypeScriptBuild(path.resolve(import.meta.dirname, ".."));

export async function createGoogleModelClient(sdkPath: string, { login = false, cliHome = process.env.GEMINI_CLI_HOME } = {}) {
  if (!path.isAbsolute(sdkPath || "") || typeof cliHome !== "string" || !path.isAbsolute(cliHome)) throw new Error("Absolute Google Core SDK and private account home required.");
  if (!login) assertGeminiAccount(cliHome);
  const sdk = await import(pathToFileURL(sdkPath).href) as GoogleSdk;
  if (login) sdk.coreEvents.on("user-feedback", event => console.error(event.message));
  const config = new sdk.Config({ sessionId: randomUUID(), targetDir: cliHome, cwd: cliHome,
    model: sdk.DEFAULT_GEMINI_MODEL, debugMode: false, interactive: false, noBrowser: !login,
    coreTools: [], mcpServers: {}, telemetry: { enabled: false }, usageStatisticsEnabled: false });
  try { await config.refreshAuth(sdk.AuthType.LOGIN_WITH_GOOGLE); }
  catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); await config.dispose(); throw error; }
  const context = { useGemini3_1: config.getGemini31LaunchedSync?.() ?? false,
    useLatestFlash: config.hasLatestFlashGAAccess?.() ?? false,
    useLatestFlashLite: config.hasLatestFlashLiteGAAccess?.() ?? false,
    hasAccessToPreview: config.getHasAccessToPreviewModel(), hasAccessToProModel: !(await config.getProModelNoAccess()) };
  const models = config.getModelConfigService().getAvailableModelOptions(context)
    .filter(row => /^gemini-/.test(row.modelId)).map((row): Model => ({ id: row.modelId, name: row.name,
      description: row.description, inputModalities: ["text", "image"] }));
  if (!models.length) { await config.dispose(); throw new Error("Google CLI Core returned no Gemini model options for this account."); }
  return { models, async stream(request: GoogleRequest, signal: AbortSignal, onChunk: (chunk: GoogleChunk) => void) {
    if (!models.some(row => row.id === request.model)) throw new Error("Google model is not in this account's advertised CLI catalog; no fallback.");
    const stream = await config.getContentGenerator().generateContentStream(
      { ...request, config: { ...request.config, abortSignal: signal } }, randomUUID(), "user");
    for await (const chunk of stream) { if (signal.aborted) break; onChunk(chunk); }
  }, dispose: () => config.dispose() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // SDK diagnostics must never corrupt the private JSON-lines transport.
  console.log = (...args) => console.error(...args);
  let client: Awaited<ReturnType<typeof createGoogleModelClient>> | undefined;
  if (process.argv[3] === "login") {
    try {
      client = await createGoogleModelClient(process.argv[2], { login: true });
      const directory = path.join(process.env.GEMINI_CLI_HOME!,  ".gemini");
      const file = path.join(directory, "settings.json");
      const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      settings.security = { ...settings.security, auth: { ...settings.security?.auth, selectedType: "oauth-personal" } };
      fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 }); fs.chmodSync(file, 0o600);
      writeMessage(process.stdout, { authenticated: true, modelIds: client.models.map(row => row.id) });
    } catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); console.error(error.message); process.exitCode = 1; }
    finally { await client?.dispose(); await new Promise(resolve => process.stdout.write("", resolve)); process.exit(process.exitCode ?? 0); }
  } else {
    const active = new Map();
    let initializing: Promise<Awaited<ReturnType<typeof createGoogleModelClient>>> | undefined;
    const getClient = () => initializing ??= createGoogleModelClient(process.argv[2]).then(value => client = value);
    readMessages<GoogleWorkerParams>(process.stdin, message => {
      if (message.method === "cancel") { active.get(message.params?.requestId)?.abort(); return; }
      const controller = new AbortController(); active.set(message.id, controller);
      Promise.resolve().then(async () => {
        const api = await getClient();
        if (message.method === "model/list") return { data: api.models };
        if (message.method !== "generate") throw new Error("Unknown Google model operation.");
        await api.stream(message.params!,  controller.signal, chunk => writeMessage(process.stdout,
          { method: "chunk", params: { requestId: message.id, chunk } }));
        return { completed: !controller.signal.aborted };
      }).then(result => writeMessage(process.stdout, { id: message.id, result }),
        error => writeMessage(process.stdout, { id: message.id, error: { code: -32000, message: error.message } }))
        .finally(() => active.delete(message.id));
    }, () => process.stdin.destroy());
    const close = async () => { for (const controller of active.values()) controller.abort(); await client?.dispose(); process.exit(0); };
    process.stdin.once("end", close); process.once("SIGTERM", close); process.once("SIGINT", close);
  }
}
